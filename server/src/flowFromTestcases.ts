import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import { readProjectContext } from './projectContext.js'

/**
 * Turn an UPLOADED test-case document into a draft E2E flow for `/qc-run?mode=advanced`.
 *
 * The Run form's advanced mode runs a path through the product with no ticket
 * (docs/architecture/runs.md), and a QC engineer usually already HAS that path
 * written down — a regression sheet, an E2E checklist, a spec someone exported from
 * Word. Retyping it as canvas cards is the whole cost of using the flow mode, so
 * this reads the document and produces the cards.
 *
 * Two deliberate limits:
 *
 * - **It drafts the CANVAS, it does not replace the document.** The steps are a
 *   summary — 20 cards can't hold 120 cases — so the run also carries the file
 *   itself (`runTestcaseDocs.ts`) and the model executes every case from there.
 *   If this ever became the only thing the run saw, uploading a 200-case sheet
 *   would silently test 20 of them.
 * - **The model returns JSON, and we validate it.** Anything unparseable is an
 *   error the engineer sees, never a half-built canvas: a flow that silently lost
 *   its sign-in step reads as "the AI is bad at this", not as "the reply was
 *   truncated".
 */

export const FLOW_STEP_KINDS = ['navigate', 'auth', 'form', 'verify', 'data', 'custom'] as const
export type FlowStepKind = (typeof FLOW_STEP_KINDS)[number]

export interface FlowStepDraft {
  step: FlowStepKind
  title: string
  url?: string
  expected?: string
}

export interface FlowDraft {
  /** Names the run — the canvas's flow name, and the slug its report is filed under. */
  flowName: string
  steps: FlowStepDraft[]
  /** One line the engineer reads before accepting the draft. */
  summary: string
  /** How many distinct test cases the model counted in the document. */
  caseCount: number
}

const MODEL = 'sonnet' // reading someone's test cases and re-planning them is not a haiku job
const BUDGET_USD = '0.60'
const TIMEOUT_MS = 240_000

/** The canvas holds 20 cards (MAX_WORKFLOW_STEPS in web/src/lib/run-workflow.ts). */
export const MAX_FLOW_STEPS = 20

/**
 * Hard input cap. Truncating a test-case document would silently drop the cases at
 * its end — and the resulting flow would look complete — so oversize input is an
 * error the engineer can act on instead.
 */
export const MAX_FLOW_DOC_CHARS = 120_000

function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

/** The first balanced-looking JSON object in the text, or the text itself. */
function jsonSlice(s: string): string {
  const text = stripFence(s)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return text
  return text.slice(start, end + 1)
}

function buildPrompt(opts: {
  fileName: string
  document: string
  projectName: string
  contextBlock: string
  appUrl: string
  target: 'web' | 'web-mobile' | 'app-mobile'
}): string {
  const where =
    opts.target === 'app-mobile'
      ? 'a NATIVE MOBILE APP on a device — there are no URLs, so never emit a "url" field'
      : opts.target === 'web-mobile'
        ? 'the web app opened on a MOBILE device'
        : 'the web app in a desktop browser'
  return `You are a senior QC engineer planning an END-TO-END test run for the project "${opts.projectName}".

The QC engineer uploaded the test-case document below ("${opts.fileName}"). Your job is to read it and plan the ORDERED end-to-end flow that executes those cases against ${where}${
    opts.appUrl ? `, starting at ${opts.appUrl}` : ''
  }.

${opts.contextBlock ? `${opts.contextBlock}\n\n` : ''}=== TEST CASE DOCUMENT: ${opts.fileName} ===

${opts.document}

=== END OF DOCUMENT ===

Plan the flow:
- Walk the document in the order a tester would actually work through it: set-up and sign-in first, then the feature paths, then the checks that depend on them.
- MERGE cases that belong to the same screen or action into ONE step. You have at most ${MAX_FLOW_STEPS} steps, and a document with more cases than that must still produce a flow that covers every AREA — never stop half way through the document to stay under the limit.
- Each step is an instruction to a test agent driving the real app: say what to DO, in the product's own words (screen, button, field names exactly as the document writes them). Never write "test case 4.2" — write the action.
- "expected" is the observable result that proves the step worked, taken from the document's expected results. Leave it out when the document does not state one; do NOT invent one.
${
  opts.target === 'app-mobile'
    ? '- Never emit a "url" field — this run drives an installed app, not an address.'
    : `- "url" is the address the step OPENS, and only when the document names a real one (or it is the entry point${
        opts.appUrl ? `, i.e. ${opts.appUrl}` : ''
      }). Omit it for steps that stay on the same screen. Never invent a URL, and never guess a path.`
}
- "step" is the kind of step: "navigate" (open a screen), "auth" (sign in / switch user), "form" (enter data and submit), "verify" (check what is on screen), "data" (check a record, list, or API result), "custom" (anything else).
- "flowName" is a short human title for the whole run, taken from what the document actually covers (e.g. "Checkout to invoice", "Claims regression"). No dates, no file extension.
- "caseCount" is how many distinct test cases the document contains — count them, do not estimate.
- "summary" is ONE sentence telling the engineer what this flow covers and anything the document left unclear (missing credentials, an environment it never names). Be honest: if the document is not test cases at all, say so there and return the closest flow you can.

Base every step ONLY on the document and the project context above. Do not add a step for a feature the document never mentions.

Reply with ONLY this JSON object — no preamble, no explanation, no code fence:
{"flowName":"…","caseCount":0,"summary":"…","steps":[{"step":"auth","title":"…","url":"…","expected":"…"}]}`
}

const isKind = (v: unknown): v is FlowStepKind =>
  typeof v === 'string' && (FLOW_STEP_KINDS as readonly string[]).includes(v)

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** Keep only what a canvas card can hold, and drop a URL that isn't one. */
function normalizeSteps(raw: unknown, urls: boolean): FlowStepDraft[] {
  if (!Array.isArray(raw)) return []
  const out: FlowStepDraft[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const title = str(r.title, 400)
    if (!title) continue
    let url = urls ? str(r.url, 300) : ''
    if (url) {
      try {
        const u = new URL(url)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') url = ''
      } catch {
        url = '' // a path fragment or a placeholder — a bad URL fails the run's own gate
      }
    }
    out.push({
      step: isKind(r.step) ? r.step : 'custom',
      title,
      ...(url ? { url } : {}),
      ...(str(r.expected, 400) ? { expected: str(r.expected, 400) } : {}),
    })
    if (out.length >= MAX_FLOW_STEPS) break
  }
  return out
}

export async function flowFromTestcases(opts: {
  rootPath: string
  projectName: string
  fileName: string
  markdown: string
  appUrl?: string
  target?: 'web' | 'web-mobile' | 'app-mobile'
  signal?: AbortSignal
}): Promise<{ ok: true; draft: FlowDraft } | { ok: false; status: number; error: string }> {
  const document = opts.markdown.trim()
  if (!document) {
    return { ok: false, status: 400, error: 'The uploaded document has no text to read.' }
  }
  if (document.length > MAX_FLOW_DOC_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `That document is too large to plan a flow from (${Math.round(
        document.length / 1000,
      )} KB, limit ${MAX_FLOW_DOC_CHARS / 1000} KB). Split it and import the part this run should cover.`,
    }
  }
  const target = opts.target ?? 'web'
  const context = readProjectContext(opts.rootPath, { maxChars: 8_000 })

  const result = await runClaude(
    [
      '-p',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      BUDGET_USD,
      // The document travels IN the prompt, so this pass needs no tools at all —
      // and must not pay MCP start-up (a Playwright/ClickUp server booting for a
      // text-planning call is ~10s of nothing). Both flags are variadic: each MUST
      // be followed by another flag.
      '--disallowedTools',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      '--strict-mcp-config',
    ],
    TIMEOUT_MS,
    {
      cwd: opts.rootPath,
      usageSource: 'flow-from-testcases',
      model: MODEL,
      signal: opts.signal,
      // Over stdin, never as an argv positional: a test-case sheet is routinely
      // past the OS command-line cap, and on Windows `claude.cmd` truncates a
      // multi-line argument at its first newline.
      input: buildPrompt({
        fileName: opts.fileName,
        document,
        projectName: opts.projectName,
        contextBlock: context.block,
        appUrl: (opts.appUrl ?? '').trim(),
        target,
      }),
    },
  )
  if (opts.signal?.aborted) return { ok: false, status: 499, error: 'stopped' }
  if (result.timedOut) {
    return { ok: false, status: 504, error: 'Timed out while reading the test cases.' }
  }
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (result.code !== 0 || isError || !text.trim()) {
    return {
      ok: false,
      status: 502,
      error: 'The AI returned nothing. Check Settings → Models that Claude is signed in, then retry.',
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(jsonSlice(text)) as Record<string, unknown>
  } catch {
    return {
      ok: false,
      status: 502,
      error: 'The AI did not return a usable flow. Retry, or build the steps on the canvas by hand.',
    }
  }
  const steps = normalizeSteps(parsed.steps, target !== 'app-mobile')
  if (!steps.length) {
    return {
      ok: false,
      status: 422,
      error:
        'No steps could be read from that document — it may not contain test cases. You can still attach it to the run and build the flow by hand.',
    }
  }
  const count = Number(parsed.caseCount)
  return {
    ok: true,
    draft: {
      flowName: str(parsed.flowName, 80) || 'E2E flow',
      steps,
      summary: str(parsed.summary, 400),
      caseCount: Number.isFinite(count) && count > 0 ? Math.round(count) : 0,
    },
  }
}
