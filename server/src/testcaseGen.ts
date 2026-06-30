import fs from 'node:fs'
import path from 'node:path'
import { ticketsDirFor } from './config.js'
import {
  CRAWL_SUMMARY_MODELS,
  parseClaudeJsonResult,
  runClaude,
  runClaudeStream,
  type StreamLog,
} from './claudeExec.js'
import { groundTestcases } from './groundingCheck.js'
import { readProjectContext } from './projectContext.js'

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

/** The comparable column names of a CSV header line, ignoring trailing empty padding cells. */
function headerCols(line: string): string[] {
  const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, '').toLowerCase())
  while (cells.length && cells[cells.length - 1] === '') cells.pop()
  return cells
}

/**
 * Clean raw CSV output from the model into a file that starts with the real header row.
 * Despite the "output ONLY the CSV" rule, the model sometimes prefixes a sentence
 * ("I now have all the details. Let me write the complete test case CSV.") and a blank
 * line before the header — which corrupts the file when imported into a spreadsheet.
 * Anchor on the template's own header line and drop everything before it; fall back to
 * the first line that looks like CSV when the template header can't be located.
 */
export function extractCsv(raw: string, template: { content?: string } | null): string {
  const s = stripCodeFence(raw)
  const lines = s.split(/\r?\n/)
  const wanted = headerCols(
    (template?.content ?? '').split(/\r?\n/).find((l) => l.trim().length > 0) ?? '',
  )
  let start = -1
  if (wanted.length >= 2) {
    // Match the header by its column names (ignoring trailing empty padding cells), so
    // a row that reproduces the columns counts even if the trailing commas differ.
    start = lines.findIndex((l) => {
      const cols = headerCols(l)
      return cols.length >= 2 && cols.length === wanted.length && cols.every((c, i) => c === wanted[i])
    })
  }
  if (start === -1) {
    // No template header to anchor on — take the first line that looks like CSV data.
    start = lines.findIndex((l) => (l.match(/,/g)?.length ?? 0) >= 2)
  }
  return (start > 0 ? lines.slice(start).join('\n') : s).trim()
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

/** Trim & validate an app URL — only http(s) is allowed. '' (or invalid) → null. */
export function normalizeAppUrl(raw: string | undefined | null): string | null {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (!s) return null
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function testCasesPrompt(
  ticketContent: string,
  projectName: string,
  template: { name: string; content: string } | null,
  instructions: string,
  format: TestcaseFormat,
  appUrl: string | null,
  knowledgeBlock: string,
  sourceRel: string,
): string {
  // The run executes inside the project repo, so the model should READ the feature's
  // real implementation before drafting — this is what makes cases match the app
  // (true field names, validation, states, branches) instead of guesses from the ticket.
  const where =
    sourceRel && sourceRel !== '.'
      ? `under \`./${sourceRel}\` in the current working directory`
      : `in the current working directory`
  const sourceBlock = `You are running INSIDE this project's source repository. The application's SOURCE CODE is ${where}. BEFORE writing the cases, do a QUICK, FOCUSED investigation of the real implementation so every case matches the actual app, not a guess from the ticket:
- Use Grep / Glob / Read to locate the code behind what the ticket describes — search for the screens, components, routes/endpoints, fields, and messages it mentions.
- From the real code, take the true field/label names, validation rules, error/empty/loading states, conditional branches, and role/permission checks, and use them in the steps and expected results.
- Reconcile the ticket against the code: cover what is actually implemented, and where the code and ticket differ, write a case (or an inline note) for the gap.
- READ ONLY — never modify any file. If you cannot find the related source, fall back to the ticket and note that the implementation could not be located.
- Also honor any guidance in the project's CLAUDE.md.

IMPORTANT — time-box the reading HARD, then write. You are on a wall-clock budget. Spend only the first few minutes reading: open at MOST a handful of the most relevant files (roughly 5-8 reads), do NOT crawl the whole codebase, do NOT read every file in the module, do NOT spawn sub-agents, and never write findings or an architecture summary. The moment you understand the feature well enough to write cases, STOP reading and start writing — you do NOT need to read everything to write good cases, and time spent over-reading is time stolen from coverage. Then write cases for EVERY area the ticket spans (see Coverage below), not just the first few. Your FINAL message must be the test cases themselves (and nothing else).`

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

  const knowledge = knowledgeBlock ? `\n${knowledgeBlock}\n` : ''

  // When the QC engineer supplies a live app URL, ground the cases in the REAL UI:
  // open it with the browser/Playwright tools and reconcile it against the ticket.
  const appBlock = appUrl
    ? `\nA LIVE APP URL for the feature under test has been provided: ${appUrl}
Use your browser/Playwright tool to OPEN this URL and explore the actual running app before writing the cases:
- Reconcile the ticket's requirements against what the app actually does — note the real labels, fields, buttons, validation messages, and flows you observe, and use them in the steps and expected results (e.g. exact button text, real field names) instead of guessing.
- Cover the real UI states you can see (empty, loading, error, success) and any discrepancies between the ticket and the live app — write a case (or note) for each gap.
- Do NOT perform destructive or irreversible actions on the app (no deleting data, submitting payments, etc.). Read and navigate only; describe such actions as test steps instead of doing them.
- If the URL cannot be opened, fall back to writing cases from the ticket alone and note that the live app could not be reached.\n`
    : ''

  return `You are a senior QC engineer writing manual acceptance test cases for the project "${projectName}".

Below is a ClickUp ticket (its details and comments). Read it and produce a thorough, executable set of test cases a QC engineer can run to verify this ticket is correctly implemented.

${sourceBlock}

${formatBlock}
${appBlock}${instructionBlock}${knowledge}
Coverage — be EXHAUSTIVE, not representative:
- Silently (do NOT write this out) take stock of every distinct area this ticket spans: each feature/module it touches, each trigger or event it describes, each screen/view, and each user role/permission. A ticket that touches N modules or N triggers needs cases for ALL of them.
- Then write cases covering EVERY one of those areas — do not stop after the first few modules and do not sample. If you are wrapping up with whole areas of the ticket still uncovered, keep writing until they are all covered.
- For each area, include: happy paths, edge cases, validation/negative cases, and any error states the ticket implies.
- Where the ticket is ambiguous, still write a case and note the assumption inline.
- Do not narrate your plan or list files/areas in prose — go straight from reading to writing the cases.

Rules:
- Ground every case in what you actually saw — the ticket plus the real SOURCE CODE you read (real names, validation, states, branches). Use the ticket for scope and intent; use the code for the concrete details. Do not invent unrelated features or acceptance criteria that neither the ticket nor the code supports.
- When PROJECT KNOWLEDGE & MEMORY is provided, use it for this project's real screen/field/button names, roles, terminology, and business rules instead of guessing — but it is background context, NOT scope: only add a case for something it mentions if THIS ticket requires it.
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
  /** Optional live app URL — when set, Claude opens it (browser tools) to ground the cases. */
  appUrl?: string | null
  /** Where the project's source code lives (project.sourcePath). Defaults to rootPath. */
  sourcePath?: string | null
  /** Run the post-write grounding check (anti-hallucination). Defaults on. */
  groundingCheck?: boolean
  /** Model alias for the grounding check (haiku/sonnet/opus). */
  groundingCheckModel?: string
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
  const appUrl = normalizeAppUrl(opts.appUrl)
  // A CSV template yields a real .csv (importable into a spreadsheet); otherwise Markdown.
  const format = detectTemplateFormat(template)
  // Pull the project's standing Knowledge + Memory into the prompt (reliable even
  // before the model reads any files). The run now executes inside the project (cwd
  // = rootPath) so the model can also READ the feature's source and the CLAUDE.md.
  const ctx = readProjectContext(opts.rootPath)
  // Where the source lives relative to the cwd, so the prompt can point the model at
  // it. '.' = the project root itself; otherwise a subdir like 'source'.
  const sourceRel = (() => {
    const sp = (opts.sourcePath ?? '').trim()
    if (!sp) return '.'
    const rel = path.relative(opts.rootPath, sp)
    return !rel || rel.startsWith('..') ? '.' : rel
  })()
  onLog({
    level: 'info',
    text: `Reading ticket (${ticketContent.length.toLocaleString()} chars)… output: ${format.toUpperCase()} · reading source code${
      ctx.hasContent
        ? ` · using project context (${ctx.noteCount} memory, ${ctx.docCount} knowledge)`
        : ''
    }${appUrl ? ` · checking live app ${appUrl}` : ''}`,
  })
  // The model now reads the feature's source from disk before drafting. With a live
  // app URL it ALSO needs the project's MCP browser tools, so allow all tools (and
  // load .mcp.json). Otherwise restrict to read-only file tools and skip MCP entirely
  // (faster startup, and the draft must never modify the repo). --allowedTools is
  // variadic, so it MUST be followed by another flag (--strict-mcp-config) before the
  // trailing prompt positional, or the prompt would be swallowed as a tool name.
  const baseArgs = [
    '-p',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
  ]
  const toolArgs = appUrl
    ? ['--permission-mode', 'bypassPermissions']
    : ['--allowedTools', 'Read', 'Grep', 'Glob', '--strict-mcp-config']
  // Reading source (and, with a live app, driving a browser) costs more than a plain
  // draft — give it more headroom before the cost cap cuts in.
  const budget = appUrl ? '3.50' : format === 'csv' ? '3.00' : '2.00'
  const result = await runClaudeStream(
    [
      ...baseArgs,
      ...toolArgs,
      '--max-budget-usd',
      budget,
      testCasesPrompt(
        ticketContent,
        opts.projectName,
        template,
        instructions,
        format,
        appUrl,
        ctx.block,
        sourceRel,
      ),
    ],
    // Reading the source, writing a full CSV, or exploring a live app all take far
    // longer to stream than a plain Markdown table. With reading time-boxed in the
    // prompt, a full exhaustive write fits comfortably; give it up to 14 min before the
    // wall-clock cap rather than truncating a nearly-complete set.
    840000,
    onLog,
    // Always run inside the project so the model can read its source + CLAUDE.md.
    { signal: opts.signal, usageSource: 'testcase', model, cwd: opts.rootPath },
  )
  if (result.aborted) throw statusError('Generation stopped.', 499)
  if (result.timedOut) throw statusError('Timed out while generating test cases.', 504)

  let testcases = result.text
  if (result.isError || !testcases) {
    throw statusError('Claude did not return any test cases.', 502)
  }
  // Defensively strip a stray ```csv / ``` fence AND any prose preamble the model may
  // emit before the header despite the rule, so the file starts with the real header row.
  if (format === 'csv') testcases = extractCsv(testcases, template)

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

  // Grounding check — an independent cheap pass re-audits the cases against the
  // ticket and silently rewrites the saved version to drop any invented content.
  // Best-effort: a failure (or a suspicious rewrite) keeps the original as-is.
  if (opts.groundingCheck !== false && !opts.signal?.aborted) {
    onLog({ level: 'info', text: 'Grounding check — auditing the cases against the ticket…' })
    try {
      const g = await groundTestcases({
        rootPath: opts.rootPath,
        projectName: opts.projectName,
        ticketContent,
        output: testcases,
        format,
        model: opts.groundingCheckModel,
        // Same context the cases were written against, so a case grounded in
        // project knowledge (not the ticket) isn't flagged as invented.
        knowledge: ctx.block,
        // The author read the real source while drafting, so don't strip a case just
        // because a detail isn't restated in the ticket — only fix contradictions.
        sourceAware: true,
      })
      if (g.changed && g.corrected) {
        testcases = g.corrected
        fs.writeFileSync(path.join(dir, rel), testcases + '\n', 'utf8')
        onLog({
          level: 'success',
          text: `Grounding check revised ${rel} to remove ungrounded content.`,
        })
      } else if (g.skipped) {
        onLog({ level: 'info', text: `Grounding check skipped (${g.skipped}).` })
      } else {
        onLog({ level: 'success', text: 'Grounding check: all cases grounded in the ticket.' })
      }
    } catch {
      /* best-effort — grounding failures never sink a successful generation */
    }
  }

  return {
    testcases,
    savedTo: path.join(path.relative(opts.rootPath, dir), rel),
    version: nextVersion,
    usedTemplate: !!template,
    format,
  }
}

// --- Single-cell AI edit -----------------------------------------------------
// The /testcases preview renders a CSV version as a table; a QC engineer can click
// one cell, add an instruction, and have Claude rewrite just that cell in place
// (overwriting the same version). Only CSV versions are cell-editable — Markdown
// versions render as prose, not an addressable grid.

const MAX_CELL_COMMENT_CHARS = 2_000
const MAX_CELL_VALUE_CHARS = 8_000

/** Parse RFC-4180-ish CSV into rows of cells (mirrors the web parser exactly). */
function parseCsvRows(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  rows.push(row)
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
  return rows
}

/** Quote a CSV field only when it contains a comma, quote, or newline. */
function csvField(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Serialize rows back to CSV text (no trailing newline; the caller adds one). */
function serializeCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvField).join(',')).join('\n')
}

function editCellPrompt(
  projectName: string,
  column: string,
  currentValue: string,
  rowContext: string,
  comment: string,
): string {
  return `You are a senior QC engineer refining ONE cell of a manual test case for the project "${projectName}".

A test case is one row of a table. Here is the full row for context (column: value):
--- ROW START ---
${rowContext}
--- ROW END ---

You must rewrite ONLY the value of the "${column}" column.

Current value of "${column}":
--- CURRENT VALUE START ---
${currentValue || '(empty)'}
--- CURRENT VALUE END ---

The QC engineer's instruction for this cell:
--- INSTRUCTION START ---
${comment}
--- INSTRUCTION END ---

Rules:
- Output ONLY the new value for the "${column}" cell — no column name, no preamble, no explanation, no surrounding quotes or code fence.
- Keep it consistent with the rest of the row and the conventions of the existing value (numbering like 1., 2., a., b.; <angle-bracket> placeholders; phrasing style).
- Be specific and executable — never placeholders like "TBD".
- Preserve real line breaks where the value naturally spans multiple lines (e.g. numbered steps).`
}

export interface EditCellResult {
  testcases: string // the full updated CSV (so the UI can re-render the table)
  version: number
  format: TestcaseFormat // always 'csv'
  row: number // absolute row index that changed (0 = header)
  col: number
  column: string // the column header that was edited
  oldValue: string
  newValue: string
}

/**
 * Rewrite a single cell of a stored CSV test-case version with Claude, overwriting
 * the same version file in place. `row` is the absolute row index in the parsed CSV
 * (0 = header, so the first data row is 1) and `col` is the column index. Throws an
 * Error (with `.status`) on any failure so the route can map it.
 */
export async function editTestcaseCell(opts: {
  rootPath: string
  projectName: string
  folder: string
  version: number
  row: number
  col: number
  comment: string
  model?: string
  /** When set, write this exact value WITHOUT calling AI (used for Undo). */
  value?: string
}): Promise<EditCellResult> {
  const folder = opts.folder.trim()
  if (!folder) throw statusError('folder is required', 400)
  // A direct value (Undo) skips AI; otherwise a comment drives the AI rewrite.
  const directValue = typeof opts.value === 'string' ? opts.value : null
  const comment =
    typeof opts.comment === 'string' ? opts.comment.trim().slice(0, MAX_CELL_COMMENT_CHARS) : ''
  if (directValue === null && !comment) throw statusError('comment is required', 400)
  if (!Number.isInteger(opts.version)) throw statusError('invalid version', 400)

  const dir = ticketDir(opts.rootPath, folder)
  const meta = listTestcaseVersions(dir).find((v) => v.version === opts.version)
  if (!meta) throw statusError('test-case version not found', 404)
  if (meta.format !== 'csv') {
    throw statusError('Cell editing is only available for CSV test cases.', 422)
  }

  const filePath = path.join(dir, meta.file)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    throw statusError(`Could not read version: ${(err as Error).message}`, 500)
  }

  const rows = parseCsvRows(raw)
  if (rows.length === 0) throw statusError('This version is empty.', 422)
  const header = rows[0]
  if (!Number.isInteger(opts.row) || opts.row < 1 || opts.row >= rows.length) {
    throw statusError('invalid row', 400)
  }
  if (!Number.isInteger(opts.col) || opts.col < 0 || opts.col >= header.length) {
    throw statusError('invalid column', 400)
  }

  const column = (header[opts.col] ?? '').trim() || `Column ${opts.col + 1}`
  const targetRow = rows[opts.row]
  while (targetRow.length < header.length) targetRow.push('') // pad short rows
  const oldValue = (targetRow[opts.col] ?? '').slice(0, MAX_CELL_VALUE_CHARS)

  // Give the model the whole row (labeled) so the rewritten cell stays coherent.
  const rowContext = header
    .map(
      (h, i) =>
        `${(h ?? '').trim() || `Column ${i + 1}`}: ${(targetRow[i] ?? '').trim() || '(empty)'}`,
    )
    .join('\n')

  let newValue: string
  if (directValue !== null) {
    // Undo / direct write — restore the given value verbatim, no AI call.
    newValue = directValue
  } else {
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
        '0.20',
        editCellPrompt(opts.projectName, column, oldValue, rowContext, comment),
      ],
      120_000,
      { usageSource: 'testcase-cell', model },
    )
    if (result.timedOut) throw statusError('Timed out while editing the cell.', 504)
    const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
    if (result.code !== 0 || isError || !text) {
      throw statusError('Claude did not return an updated cell.', 502)
    }
    newValue = stripCodeFence(text).trim()
  }

  targetRow[opts.col] = newValue
  const updated = serializeCsv(rows)
  try {
    fs.writeFileSync(filePath, updated + '\n', 'utf8')
  } catch (err) {
    throw statusError(`Updated, but could not save: ${(err as Error).message}`, 500)
  }

  return {
    testcases: updated,
    version: opts.version,
    format: 'csv',
    row: opts.row,
    col: opts.col,
    column,
    oldValue,
    newValue,
  }
}
