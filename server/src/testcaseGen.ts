import fs from 'node:fs'
import path from 'node:path'
import { ticketsDirFor } from './config.js'
import { CRAWL_SUMMARY_MODELS, runClaudeStream, type StreamLog } from './claudeExec.js'

const DEFAULT_MODEL = 'sonnet'

/** Coerce an incoming model alias to a known one, defaulting to sonnet. */
function normalizeModel(raw: string | undefined): string {
  const m = typeof raw === 'string' ? raw.trim() : ''
  return CRAWL_SUMMARY_MODELS.has(m) ? m : DEFAULT_MODEL
}

const MAX_TICKET_CHARS = 40_000 // ticket.md + comments.md fed into the test-case prompt
const MAX_TEMPLATE_CHARS = 30_000 // uploaded test-case template
const MAX_INSTRUCTIONS_CHARS = 4_000 // extra QC instructions + selected rules

/** An Error carrying an HTTP status the route can surface. */
function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

/** Strip a leading ```csv / ``` fence and trailing ``` if the model wraps the output. */
function stripCodeFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:csv)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```$/i, '')
    .trim()
}

export type TestcaseFormat = 'markdown' | 'csv'

export interface TestcaseVersionMeta {
  version: number
  file: string // path relative to the ticket dir
  savedAt: string | null
  label: string
  format: TestcaseFormat // how to render this version (derived from its extension)
}

/** A generated version can be Markdown (.md) or CSV (.csv) depending on the template. */
function formatForExt(file: string): TestcaseFormat {
  return file.toLowerCase().endsWith('.csv') ? 'csv' : 'markdown'
}

/**
 * List the test-case versions stored for a crawled ticket. Each generation is a
 * file under <ticketDir>/testcases/v<N>.<md|csv> — the extension follows the
 * template's format. A pre-versioning testcases.md (if any) is surfaced as version
 * 0 so old data isn't lost. Sorted ascending by version.
 */
export function listTestcaseVersions(dir: string): TestcaseVersionMeta[] {
  const out: TestcaseVersionMeta[] = []
  const legacy = path.join(dir, 'testcases.md')
  if (fs.existsSync(legacy)) {
    let savedAt: string | null = null
    try {
      savedAt = fs.statSync(legacy).mtime.toISOString()
    } catch {
      /* ignore */
    }
    out.push({ version: 0, file: 'testcases.md', savedAt, label: 'v0 (legacy)', format: 'markdown' })
  }
  const vdir = path.join(dir, 'testcases')
  try {
    for (const name of fs.readdirSync(vdir)) {
      const m = /^v(\d+)\.(md|csv)$/.exec(name)
      if (!m) continue
      let savedAt: string | null = null
      try {
        savedAt = fs.statSync(path.join(vdir, name)).mtime.toISOString()
      } catch {
        /* ignore */
      }
      out.push({
        version: Number(m[1]),
        file: `testcases/${name}`,
        savedAt,
        label: `v${m[1]}`,
        format: formatForExt(name),
      })
    }
  } catch {
    /* no testcases dir yet */
  }
  out.sort((a, b) => a.version - b.version)
  return out
}

/** Resolve & path-guard a ticket folder under <root>/testing/test-result/. Throws on escape. */
function ticketDir(rootPath: string, folder: string): string {
  const baseDir = ticketsDirFor(rootPath)
  const dir = path.resolve(baseDir, folder)
  if (dir !== baseDir && !dir.startsWith(baseDir + path.sep)) {
    throw statusError('invalid ticket path', 400)
  }
  return dir
}

/**
 * Delete one stored test-case version for a crawled ticket. Only files that
 * listTestcaseVersions reports are removable (v<N>.{md,csv} or legacy testcases.md),
 * so an arbitrary path can't be targeted. Throws (with `.status`) if not found.
 */
export function deleteTestcaseVersion(rootPath: string, folder: string, version: number): void {
  const dir = ticketDir(rootPath, folder)
  const meta = listTestcaseVersions(dir).find((v) => v.version === version)
  if (!meta) throw statusError('test-case version not found', 404)
  try {
    fs.rmSync(path.join(dir, meta.file))
  } catch (err) {
    throw statusError(`Could not delete: ${(err as Error).message}`, 500)
  }
}

/**
 * Decide what output format a template implies. A CSV template (by extension, or
 * by a comma-separated header on its first content line) means we should emit CSV
 * that mirrors it; anything else stays Markdown. No template → Markdown.
 */
export function detectTemplateFormat(
  template: { name?: string; content?: string } | null | undefined,
): TestcaseFormat {
  if (!template) return 'markdown'
  const name = (template.name ?? '').toLowerCase()
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv'
  const firstLine = (template.content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? ''
  const t = firstLine.trim()
  if (t.startsWith('#') || t.startsWith('|')) return 'markdown' // markdown heading / table row
  // A CSV header has several comma-separated column names.
  if ((firstLine.match(/,/g)?.length ?? 0) >= 2) return 'csv'
  return 'markdown'
}

function testCasesPrompt(
  ticketContent: string,
  projectName: string,
  template: { name: string; content: string } | null,
  instructions: string,
  format: TestcaseFormat,
): string {
  // The output-shape instructions and the "output only X" rule both depend on the
  // target format so CSV templates produce a real, importable CSV (not Markdown).
  const formatBlock =
    format === 'csv'
      ? `A TEST CASE TEMPLATE in CSV format has been provided below. Produce your output as VALID CSV that matches it EXACTLY:
- First output the SAME header row as the template's first line — identical column names, in the same order. Do not add or remove columns.
- Each test case is one CSV row with a value (or an intentionally blank value) for every column, in the template's column order.
- Reproduce the template's conventions precisely: its ID format (sequential, e.g. No-01, No-02, …), its phrasing (Summary lines start with "Verify …"), and which columns it leaves BLANK. Columns filled in only during execution — Actual result, Status, Reference, Note (and any others the template leaves empty) — must be left empty.
- CSV quoting: wrap any field containing a comma, double-quote, or line break in double quotes, and escape embedded double-quotes by doubling them ("").
- Multi-line fields (Pre-condition, Steps, Expected result) use REAL newlines inside the quoted field, with numbered items (1., 2., …) and lettered sub-items (a., b., …), mirroring the style of the template's sample rows.
- Use angle-bracket placeholders for variable test data exactly like the template (e.g. <Patient Name data>, <Clinician account data>).
- The template's rows are only a FORMAT SAMPLE — drive the number and content of the test cases from THIS ticket's scope, not from how many rows the template happens to contain.`
      : template
        ? `A TEST CASE TEMPLATE has been provided below. Follow its structure, columns, fields, and numbering EXACTLY — match its format and fill it in with concrete cases derived from the ticket. Do not invent extra columns or drop columns it defines.`
        : `Present the cases as one or more GitHub-flavored Markdown tables with these columns: ID, Title, Preconditions, Steps, Test Data, Expected Result, Priority. Group related cases under "##" headings when it helps readability.`

  const outputRule =
    format === 'csv'
      ? `Output ONLY the CSV — the header row followed by the data rows. No preamble, no explanation, no surrounding code fence.`
      : `Output ONLY the Markdown test cases — no preamble, no surrounding code fence.`

  const instructionBlock = instructions
    ? `\nAdditional instructions from the QC engineer — follow these closely:\n${instructions}\n`
    : ''

  return `You are a senior QC engineer writing manual acceptance test cases for the project "${projectName}".

Below is a ClickUp ticket (its details and comments). Read it and produce a thorough, executable set of test cases a QC engineer can run to verify this ticket is correctly implemented.

${formatBlock}
${instructionBlock}
Coverage:
- Happy paths, edge cases, validation/negative cases, and any error states the ticket implies.
- Where the ticket is ambiguous, still write a case and note the assumption inline.

Rules:
- Base everything on the ticket; do not invent unrelated features.
- Be specific and executable — real steps and expected results, never placeholders like "TBD".
- ${outputRule}

--- TICKET START ---
${ticketContent}
--- TICKET END ---${
    template
      ? `

--- TEST CASE TEMPLATE ("${template.name}") START ---
${template.content}
--- TEST CASE TEMPLATE END ---`
      : ''
  }`
}

/** Normalize a raw template payload — trim, cap, default name. Empty → null. */
function normalizeTemplate(
  raw: { name?: string; content?: string } | null | undefined,
): { name: string; content: string } | null {
  if (!raw || typeof raw !== 'object') return null
  const content = typeof raw.content === 'string' ? raw.content : ''
  if (!content.trim()) return null
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'template'
  return {
    name,
    content:
      content.length > MAX_TEMPLATE_CHARS
        ? `${content.slice(0, MAX_TEMPLATE_CHARS)}\n…(template truncated)`
        : content,
  }
}

export interface GenerateResult {
  testcases: string
  savedTo: string // path relative to the project root
  version: number
  usedTemplate: boolean
  format: TestcaseFormat // 'csv' when a CSV template drove the output, else 'markdown'
}

/**
 * Generate one new test-case version for an already-crawled ticket. Reads the
 * ticket's on-disk files, runs Claude, and writes testcases/v<N>.<md|csv> beside
 * it (CSV when a CSV template drove the output, else Markdown).
 * Throws an Error (with a `.status`) on any failure so callers can map it.
 */
export async function generateTestcaseVersion(opts: {
  rootPath: string
  projectName: string
  folder: string
  template?: { name?: string; content?: string } | null
  instructions?: string
  model?: string
  /** Called with each streamed log line so callers can surface progress live. */
  onLog?: (log: StreamLog) => void
  /** Fires to cancel an in-flight generation (pause/cancel of a job). */
  signal?: AbortSignal
}): Promise<GenerateResult> {
  const onLog = opts.onLog ?? (() => {})
  const folder = opts.folder.trim()
  if (!folder) throw statusError('folder is required', 400)

  const dir = ticketDir(opts.rootPath, folder)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw statusError('ticket has not been crawled yet', 404)
  }

  const template = normalizeTemplate(opts.template)
  const instructions =
    typeof opts.instructions === 'string'
      ? opts.instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS)
      : ''

  const parts: string[] = []
  for (const file of ['ticket.md', 'comments.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (text) parts.push(text)
    } catch {
      /* missing file — skip */
    }
  }
  let ticketContent = parts.join('\n\n---\n\n').trim()
  if (!ticketContent) throw statusError('No ticket content found in this folder.', 422)
  if (ticketContent.length > MAX_TICKET_CHARS) {
    ticketContent = `${ticketContent.slice(0, MAX_TICKET_CHARS)}\n\n…(ticket truncated)`
  }

  const model = normalizeModel(opts.model)
  // A CSV template yields a real .csv (importable into a spreadsheet); otherwise Markdown.
  const format = detectTemplateFormat(template)
  onLog({
    level: 'info',
    text: `Reading ticket (${ticketContent.length.toLocaleString()} chars)… output: ${format.toUpperCase()}`,
  })
  const result = await runClaudeStream(
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--max-budget-usd',
      // CSV output mirrors a detailed template, so it needs more headroom than a
      // plain Markdown table before the cost cap cuts it off.
      format === 'csv' ? '2.00' : '0.50',
      testCasesPrompt(ticketContent, opts.projectName, template, instructions, format),
    ],
    // A full CSV (many multi-line cases) takes far longer to stream than a Markdown
    // table — give it up to 8 min before timing out.
    480000,
    onLog,
    { signal: opts.signal, usageSource: 'testcase', model },
  )
  if (result.aborted) throw statusError('Generation stopped.', 499)
  if (result.timedOut) throw statusError('Timed out while generating test cases.', 504)

  let testcases = result.text
  if (result.isError || !testcases) {
    throw statusError('Claude did not return any test cases.', 502)
  }
  // Defensively strip a stray ```csv / ``` fence the model may add despite the rule.
  if (format === 'csv') testcases = stripCodeFence(testcases)

  // Save as the next version under <dir>/testcases/v<N>.<md|csv>.
  const ext = format === 'csv' ? 'csv' : 'md'
  const existing = listTestcaseVersions(dir)
  const nextVersion = existing.length ? Math.max(...existing.map((v) => v.version)) + 1 : 1
  const rel = path.join('testcases', `v${nextVersion}.${ext}`)
  try {
    fs.mkdirSync(path.join(dir, 'testcases'), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), testcases + '\n', 'utf8')
  } catch (err) {
    throw statusError(`Generated, but could not save: ${(err as Error).message}`, 500)
  }
  onLog({ level: 'success', text: `Saved ${rel} (${testcases.length.toLocaleString()} chars)` })

  return {
    testcases,
    savedTo: path.join(path.relative(opts.rootPath, dir), rel),
    version: nextVersion,
    usedTemplate: !!template,
    format,
  }
}
