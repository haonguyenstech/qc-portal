import { parseClaudeJsonResult, runClaude } from './claudeExec.js'

// AI review & format — a COPY-EDITOR pass over Markdown the engineer uploaded, used by
// the Overview page's per-document "AI review" (POST /api/overview-docs/:name/review).
// It lives in its own module rather than inside that route so any future surface that
// tidies an engineer-authored document reuses the SAME rules and the same guards
// instead of growing a second, subtly different reviewer.
//
// The defining constraint: the model's output is SAVED OVER the engineer's text.
// That makes every failure mode a data-loss risk, so this module refuses rather
// than degrades — an oversize input is rejected instead of truncated, and a
// suspiciously short result is rejected instead of written.

const MODEL = 'sonnet' // prose editing on someone's own words — not a haiku job
const BUDGET_USD = '0.50'
const TIMEOUT_MS = 180_000

/**
 * Hard input cap. Unlike a normal prompt, truncating here would silently DELETE
 * everything past the cut when the result is saved, so oversize input is an error.
 */
export const MAX_REVIEW_CHARS = 60_000

/**
 * Reject a rewrite that kept less than this share of the original. A tidy-up
 * legitimately shortens (de-duplicating merged documents is the point), but losing
 * three quarters of the text means the model collapsed or truncated the document.
 */
const MIN_KEEP_RATIO = 0.25

/** Strip a leading ```lang / trailing ``` fence if the model wraps its output. */
function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

function reviewPrompt(content: string, projectName: string, what: string): string {
  return `You are editing ${what} for the software project "${projectName}" — material QC (acceptance testing) engineers read before testing it.

The text below was written by the engineer, or converted automatically from an uploaded document (Word / PDF / spreadsheet), so it may be rough: repeated content, inconsistent heading levels, broken tables, page numbers and running headers left over from a PDF.

Your job is to REVIEW AND FORMAT it. You are an editor, not an author.

Do:
- Fix Markdown structure: one "# " title, consistent "## " / "### " levels, working GitHub-flavored tables and lists, sensible paragraph breaks.
- Merge duplicated passages into one, keeping every distinct detail.
- Remove pure conversion noise: page numbers, repeated running headers/footers, "Click here" navigation leftovers, empty sections, stray escape characters.
- Group related content under clear headings, and prefer short paragraphs and bullets.
- Keep the author's wording, terminology and tone. Fix only clear typos.

Do NOT:
- Add any fact, feature, requirement, environment, credential or caveat that is not already in the text — not even an obvious-sounding one.
- Summarize away detail, or delete a section because it looks unimportant. Tables, links, IDs, URLs, versions and numbers must survive verbatim.
- Answer questions, add commentary, or leave notes about what you changed.

Output ONLY the finished Markdown document — no preamble, no explanation, no surrounding code fence. If the text is already clean, output it unchanged.

--- DOCUMENT START ---
${content}
--- DOCUMENT END ---`
}

export type ReviewOutcome =
  { ok: true; text: string; changed: boolean } | { ok: false; status: number; error: string }

/**
 * Run one review pass. Never throws; every failure is a { ok:false, status, error }
 * the caller can hand straight to res.status(...).json(...) — and in every one of
 * those cases the caller must save NOTHING, because falling back to the unreviewed
 * text is indistinguishable to the user from the review having been skipped.
 *
 * `label` names the thing being edited in the prompt (e.g. 'the project overview',
 * 'the overview document "brief"').
 */
export async function reviewMarkdown(opts: {
  content: string
  projectName?: string
  label?: string
  /** Project root, so the usage record and any project config resolve there. */
  cwd?: string
}): Promise<ReviewOutcome> {
  const original = (opts.content ?? '').trim()
  const projectName = (opts.projectName ?? '').trim() || 'this project'
  const label = (opts.label ?? '').trim() || 'a project document'
  if (!original) return { ok: false, status: 400, error: 'nothing to review' }
  if (original.length > MAX_REVIEW_CHARS) {
    return {
      ok: false,
      status: 413,
      error: `This document is too long to review in one pass (${Math.round(
        original.length / 1000,
      )} KB, limit ${MAX_REVIEW_CHARS / 1000} KB). Split it into smaller documents and review those.`,
    }
  }

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
    ],
    TIMEOUT_MS,
    // Over stdin: a document merged from several files easily exceeds the OS
    // command-line limit (Windows argv caps at ~32 KB → ENAMETOOLONG).
    {
      cwd: opts.cwd,
      input: reviewPrompt(original, projectName, label),
      usageSource: 'doc-review',
      model: MODEL,
    },
  )
  if (result.timedOut) {
    return {
      ok: false,
      status: 504,
      error: 'Timed out while reviewing the document.',
    }
  }
  const raw = result.stdout || result.stderr
  const { text, isError } = parseClaudeJsonResult(raw)
  const reviewed = stripFence(text)
  if (result.code !== 0 || isError || !reviewed) {
    return {
      ok: false,
      status: 502,
      error:
        (result.stderr || '').trim().slice(0, 300) ||
        raw.trim().slice(0, 300) ||
        'Claude did not return a reviewed document.',
    }
  }
  if (reviewed.length < original.length * MIN_KEEP_RATIO) {
    return {
      ok: false,
      status: 502,
      error: 'The review came back suspiciously short, so your text was kept unchanged.',
    }
  }
  return { ok: true, text: reviewed, changed: reviewed !== original }
}
