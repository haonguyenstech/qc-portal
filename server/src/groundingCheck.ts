import { GROUNDING_CHECK_MODEL } from './config.js'
import { CRAWL_SUMMARY_MODELS, parseClaudeJsonResult, runClaude } from './claudeExec.js'

// Grounding check — an INDEPENDENT, cheap second pass that audits an AI-written
// artifact against its source to catch hallucination, then auto-revises it in place.
// Two artifacts are checked:
//   - generated test cases  → grounded against the ticket (groundTestcases)
//   - a finished QC report   → verdicts grounded against the report's own evidence
//     (groundReport): any Pass/Fail not backed by a documented observation is
//     downgraded so a hallucinated "Pass" can't survive into the counts.
//
// It is best-effort and NEVER throws — a timeout, parse failure, or suspicious
// result resolves with { changed:false } and the original artifact is kept. The
// reviewer model is independent of (and cheaper than) the writer, which is what
// catches a writer's self-consistent hallucination. Toggle with QC_GROUNDING_CHECK.

const MAX_SOURCE_CHARS = 40_000 // ticket / evidence fed in as the ground truth
const MAX_OUTPUT_CHARS = 60_000 // the artifact being audited (test cases / report)
// The audit has to READ the whole artifact and, when it corrects something, WRITE the
// whole thing back — so both the time and the money it needs scale with the prompt, not
// with a constant. The original flat 120 s / $0.15 were sized for a small artifact and
// silently failed on every real ticket: measured on a 23 KB ticket + 43 KB of cases +
// 26 KB of Knowledge/Memory, a run needs ~150 s and reports `error_max_budget_usd` at
// $0.18 before it can emit a single corrected row. Both surfaced as "no AI response",
// so the anti-hallucination pass never ran for exactly the artifacts that need it most.
const TIMEOUT_BASE_MS = 120_000
const TIMEOUT_PER_KB_MS = 1_500 // ≈ 90 s more for a 60 KB prompt
const TIMEOUT_MAX_MS = 420_000
// Sizing note: a measured full audit of a 93 KB prompt that rewrites all 44 KB of cases
// costs ~$0.16, and the recorded history of this check ranges $0.14–$0.33 — but the spend
// is spiky (a $0.52 cap still aborted one real run mid-rewrite). These are CAPS, not
// spend: they only have to sit far enough above the typical cost that a normal audit can
// always finish, because an audit that aborts is worth nothing at all.
const BUDGET_BASE_USD = 0.15 // still a cheap audit for a small artifact
const BUDGET_PER_KB_USD = 0.008
const BUDGET_MAX_USD = 1.2 // hard ceiling — a runaway audit can never balloon past this

/** Wall-clock allowance for one audit, scaled to the prompt it has to read + rewrite. */
function timeoutForPrompt(prompt: string): number {
  return Math.min(TIMEOUT_MAX_MS, TIMEOUT_BASE_MS + Math.ceil(prompt.length / 1024) * TIMEOUT_PER_KB_MS)
}

/** Spend cap for one audit, scaled the same way. Returned as the CLI's string arg. */
function budgetForPrompt(prompt: string): string {
  const usd = Math.min(
    BUDGET_MAX_USD,
    BUDGET_BASE_USD + Math.ceil(prompt.length / 1024) * BUDGET_PER_KB_USD,
  )
  return usd.toFixed(2)
}
const SENTINEL = 'GROUNDED_OK' // the model emits this verbatim when nothing needs fixing
// Reject a rewrite that lost more than half the original — a sign the model
// truncated or collapsed the document rather than making targeted corrections.
const MIN_KEEP_RATIO = 0.5

export interface GroundingResult {
  /** True when the artifact was rewritten; `corrected` then holds the new content. */
  changed: boolean
  /** The corrected artifact when `changed`, else null. */
  corrected: string | null
  /** Why nothing was applied (for logs), if the check ran but made no change. */
  skipped?: string
}

/** Coerce the configured/passed model to a known alias, defaulting to haiku. */
function normalizeModel(raw?: string): string {
  const m = (raw ?? '').trim()
  if (CRAWL_SUMMARY_MODELS.has(m)) return m
  if (CRAWL_SUMMARY_MODELS.has(GROUNDING_CHECK_MODEL)) return GROUNDING_CHECK_MODEL
  return 'haiku'
}

/** Strip a leading ```lang / ``` fence and trailing ``` if the model wraps output. */
function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

function firstLine(s: string): string {
  const i = s.indexOf('\n')
  return (i === -1 ? s : s.slice(0, i)).trim()
}

/**
 * Drop any prose the model emitted before the CSV's header row, matched against the
 * header of the document being audited. Returns the text unchanged when the header is
 * already first (the normal case) or can't be found (so the caller's guard still rejects).
 */
function dropPreambleBeforeHeader(text: string, header: string): string {
  const want = header.trim().toLowerCase()
  if (!want) return text
  const lines = text.split(/\r?\n/)
  if ((lines[0] ?? '').trim().toLowerCase() === want) return text
  const at = lines.findIndex((l) => l.trim().toLowerCase() === want)
  return at > 0 ? lines.slice(at).join('\n').trim() : text
}

/** The model emits GROUNDED_OK (alone) when the artifact is already grounded. */
function isSentinel(s: string): boolean {
  const t = s.trim()
  return t.length <= 40 && /grounded_ok/i.test(t)
}

/** Why an audit produced nothing — reported in the run log so a silent skip is diagnosable. */
type GroundingFailure = 'timed out' | 'budget exceeded' | 'no AI response'

/**
 * Run one buffered grounding pass. Returns the model's raw text, or null with the reason
 * it failed — a timeout, the spend cap, and a genuine empty answer each call for a
 * different fix, and lumping all three under "no AI response" is what hid the fact that
 * this check was never running at all.
 */
async function runGrounding(opts: {
  rootPath: string
  prompt: string
  model?: string
  usageSource: string
}): Promise<{ text: string | null; failure: GroundingFailure | null }> {
  const model = normalizeModel(opts.model)
  const result = await runClaude(
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      budgetForPrompt(opts.prompt),
    ],
    timeoutForPrompt(opts.prompt),
    // Prompt embeds the full ticket + generated cases/report — pass it over stdin so a
    // long document can't overflow the OS command-line limit (Windows ENAMETOOLONG).
    { cwd: opts.rootPath, usageSource: opts.usageSource, model, input: opts.prompt },
  )
  if (result.timedOut) return { text: null, failure: 'timed out' }
  const raw = result.stdout || result.stderr
  const { text, isError } = parseClaudeJsonResult(raw)
  if (result.code !== 0 || isError || !text) {
    // The CLI reports the spend cap as a result subtype, not on stderr.
    const failure: GroundingFailure = /error_max_budget_usd/.test(raw)
      ? 'budget exceeded'
      : 'no AI response'
    return { text: null, failure }
  }
  return { text, failure: null }
}

function testcasesPrompt(
  projectName: string,
  ticketContent: string,
  testcases: string,
  format: 'markdown' | 'csv',
  knowledge: string,
  sourceAware: boolean,
): string {
  const formatNote =
    format === 'csv'
      ? `The test cases are CSV. Keep EXACTLY the same header row (same columns, same order) and CSV quoting conventions.`
      : `The test cases are GitHub-flavored Markdown. Keep the same structure, columns, and headings.`

  const knowledgeBlock = knowledge ? `\n${knowledge}\n` : ''

  // The author may have READ THE PROJECT'S SOURCE CODE while drafting (you cannot).
  // In that case a concrete detail (a field, message, branch) can be legitimate even
  // if the ticket never restates it — so be conservative: only fix clear
  // contradictions or obvious fabrications, never strip a plausible detail.
  if (sourceAware) {
    return `You are an INDEPENDENT QC reviewer auditing a set of manual test cases for the project "${projectName}" to catch HALLUCINATION before they are saved. Another AI wrote the TEST CASES below from the TICKET below — and it also READ THE PROJECT'S SOURCE CODE while drafting (you do NOT have that source). So a specific field, label, message, state, or rule can be REAL even if the ticket does not restate it.

Be conservative. Only change a case when it is clearly wrong — i.e. it:
- directly CONTRADICTS the ticket${knowledge ? ' or the PROJECT KNOWLEDGE & MEMORY below' : ''}, or
- is obviously fabricated or unrelated to this ticket's feature.

Do NOT remove or rewrite a case merely because a concrete detail is not mentioned in the ticket — it likely came from the source code or project knowledge. Keep all reasonable happy-path, edge, negative, and validation coverage. When in doubt, KEEP the case unchanged.

${formatNote}

Output rules — follow EXACTLY:
- If nothing clearly contradicts the source of truth, output exactly this and nothing else: ${SENTINEL}
- Otherwise output ONLY the FULL corrected set of test cases in the SAME format — no preamble, no commentary, no surrounding code fence.

--- TICKET START ---
${ticketContent}
--- TICKET END ---${knowledgeBlock}

--- TEST CASES START ---
${testcases}
--- TEST CASES END ---`
  }

  // When project knowledge is supplied, a case is grounded if the ticket OR that
  // knowledge supports it — so the audit doesn't strip legitimate cases that rely
  // on the project's documented terms, screens, or business rules.
  const groundedIn = knowledge ? 'the ticket OR the PROJECT KNOWLEDGE & MEMORY below' : 'the ticket'

  return `You are an INDEPENDENT QC reviewer auditing a set of manual test cases for the project "${projectName}" to catch HALLUCINATION before they are saved. Another AI wrote the TEST CASES below from the TICKET below.

Your ONLY job is to make every test case faithfully grounded in ${groundedIn}, so a QC engineer never ends up testing an invented feature. Check each case and fix it when it:
- references a field, button, screen, message, status, or feature that NEITHER the ticket nor the project knowledge mentions or implies,
- asserts an expected result that contradicts the ticket or the project knowledge, or
- invents acceptance criteria that neither the ticket nor the project knowledge states.

Keep every case that IS grounded — including reasonable edge, negative, and validation cases derived from the ticket's actual scope (and the project's documented rules). Do NOT strip legitimate coverage and do NOT add brand-new features. Where the source is genuinely ambiguous, keep the case but state the assumption explicitly instead of asserting an invented fact.

${formatNote}

Output rules — follow EXACTLY:
- If every test case is already grounded, output exactly this and nothing else: ${SENTINEL}
- Otherwise output ONLY the FULL corrected set of test cases in the SAME format — no preamble, no commentary, no surrounding code fence.

--- TICKET START ---
${ticketContent}
--- TICKET END ---${knowledgeBlock}

--- TEST CASES START ---
${testcases}
--- TEST CASES END ---`
}

function reportPrompt(projectName: string, report: string): string {
  return `You are an INDEPENDENT QC auditor reviewing a finished QC test REPORT for the project "${projectName}" to catch HALLUCINATED results before they are trusted. Another AI ran the tests and wrote the REPORT below.

Verify that EVERY Pass/Fail verdict in the report is actually supported by concrete evidence the report itself documents (steps taken and the observed result). The specific risk you are guarding against is a verdict asserted without the work behind it — e.g. an acceptance criterion marked "Pass" when the report shows no evidence it was actually exercised.

Rules — apply them conservatively:
- If a verdict IS supported by a documented observation/step, leave it and its row completely unchanged.
- If a "Pass" is NOT supported by any documented evidence in the report, downgrade it to "Fail" (or "Partial" if it was only partly exercised) and append " (unverified — no supporting evidence in report)" to that row's notes / actual-result cell. NEVER invent new evidence to justify a verdict.
- Do not change the report's structure, wording, headings, or any well-supported content. Preserve the acceptance-criteria table's exact columns and markdown.

Output rules — follow EXACTLY:
- If every verdict is properly grounded, output exactly this and nothing else: ${SENTINEL}
- Otherwise output ONLY the FULL corrected report markdown — no preamble, no commentary, no surrounding code fence.

--- REPORT START ---
${report}
--- REPORT END ---`
}

/**
 * Audit generated test cases against the ticket they were drawn from and return a
 * grounded rewrite when the model found invented/contradicting content. Never throws.
 */
export async function groundTestcases(opts: {
  rootPath: string
  projectName: string
  ticketContent: string
  output: string
  format: 'markdown' | 'csv'
  model?: string
  /** Project Knowledge + Memory block — cases it supports count as grounded too. */
  knowledge?: string
  /** The author read the project's source code while drafting — audit conservatively. */
  sourceAware?: boolean
}): Promise<GroundingResult> {
  const source = (opts.ticketContent ?? '').trim().slice(0, MAX_SOURCE_CHARS)
  const knowledge = (opts.knowledge ?? '').trim().slice(0, MAX_SOURCE_CHARS)
  const output = (opts.output ?? '').trim()
  if (!source) return { changed: false, corrected: null, skipped: 'no ticket content' }
  if (!output) return { changed: false, corrected: null, skipped: 'no test cases' }
  // Don't try to rewrite an artifact we can't pass in whole — a partial rewrite is worse.
  if (output.length > MAX_OUTPUT_CHARS) {
    return { changed: false, corrected: null, skipped: 'too large to check' }
  }

  let ran: { text: string | null; failure: GroundingFailure | null }
  try {
    ran = await runGrounding({
      rootPath: opts.rootPath,
      model: opts.model,
      usageSource: 'grounding-testcases',
      prompt: testcasesPrompt(
        opts.projectName,
        source,
        output,
        opts.format,
        knowledge,
        !!opts.sourceAware,
      ),
    })
  } catch {
    return { changed: false, corrected: null, skipped: 'check failed' }
  }
  const raw = ran.text
  if (raw == null) {
    return { changed: false, corrected: null, skipped: ran.failure ?? 'no AI response' }
  }
  if (isSentinel(raw)) return { changed: false, corrected: null }

  let corrected = stripFence(raw)
  // Despite "output ONLY the CSV", the auditor sometimes opens with a sentence ("Here is
  // the corrected CSV:"). That line then reads as the header row, so the header guard
  // below rejects an otherwise-good correction and the audit silently does nothing.
  // Re-anchor on the original's header instead — a no-op when there is no preamble.
  if (opts.format === 'csv') corrected = dropPreambleBeforeHeader(corrected, firstLine(output))
  if (!corrected) return { changed: false, corrected: null, skipped: 'empty result' }
  if (corrected.length < output.length * MIN_KEEP_RATIO) {
    return { changed: false, corrected: null, skipped: 'result looked truncated' }
  }
  // A CSV rewrite must keep the same header row — otherwise the columns drifted.
  if (
    opts.format === 'csv' &&
    firstLine(corrected).toLowerCase() !== firstLine(output).toLowerCase()
  ) {
    return { changed: false, corrected: null, skipped: 'CSV header changed' }
  }
  if (corrected === output) return { changed: false, corrected: null }
  return { changed: true, corrected }
}

/**
 * Audit a finished QC report so any Pass/Fail verdict not backed by documented
 * evidence is downgraded, and return the rewritten report when it changed. The
 * caller re-counts Pass/Fail from the returned markdown. Never throws.
 */
export async function groundReport(opts: {
  rootPath: string
  projectName: string
  report: string
  model?: string
}): Promise<GroundingResult> {
  const report = (opts.report ?? '').trim()
  if (!report) return { changed: false, corrected: null, skipped: 'no report' }
  if (report.length > MAX_OUTPUT_CHARS) {
    return { changed: false, corrected: null, skipped: 'too large to check' }
  }

  let ran: { text: string | null; failure: GroundingFailure | null }
  try {
    ran = await runGrounding({
      rootPath: opts.rootPath,
      model: opts.model,
      usageSource: 'grounding-report',
      prompt: reportPrompt(opts.projectName, report),
    })
  } catch {
    return { changed: false, corrected: null, skipped: 'check failed' }
  }
  const raw = ran.text
  if (raw == null) {
    return { changed: false, corrected: null, skipped: ran.failure ?? 'no AI response' }
  }
  if (isSentinel(raw)) return { changed: false, corrected: null }

  const corrected = stripFence(raw)
  if (!corrected) return { changed: false, corrected: null, skipped: 'empty result' }
  // Downgrading verdicts only adds notes, so a grounded rewrite never shrinks much —
  // a big shrink means the model dropped content; keep the original instead.
  if (corrected.length < report.length * MIN_KEEP_RATIO) {
    return { changed: false, corrected: null, skipped: 'result looked truncated' }
  }
  if (corrected === report) return { changed: false, corrected: null }
  return { changed: true, corrected }
}
