import fs from 'node:fs'
import path from 'node:path'
import { findCrawledTicketDir } from './crawl.js'
import { testResultDirFor, GROUNDING_CHECK_MODEL } from './config.js'
import { CRAWL_SUMMARY_MODELS, parseClaudeJsonResult, runClaude } from './claudeExec.js'
import {
  listTestcaseVersions,
  parseCsvRows,
  serializeCsv,
  type TestcaseFormat,
} from './testcaseGen.js'

// After a QC run finishes and writes report.md, clone the ticket's latest
// test-case file and fill the EXECUTION columns — Actual result, Status,
// Reference, Note — from the run's report, producing an "executed" copy in the
// run's output folder (testing/test-result/<slug>/testcases-executed.<ext>).
//
// The generated test-case file leaves those columns blank on purpose (see
// testcaseGen's format rules); this turns it into a filled QC execution record.
//
// SAFETY BY DESIGN: the AI is asked ONLY for a per-case verdict as JSON keyed by
// the test-case ID. We splice those values into the execution columns ourselves
// and re-serialize the table, so the AI can never corrupt Steps / Expected /
// Priority or shift any column. Best-effort and NEVER throws.

// Per-CALL budget. The cases are chunked so each call maps at most CHUNK_SIZE
// cases and stays well within this; a big sheet (100+ cases) would otherwise
// blow the budget mid-output and return an error with no text.
const BUDGET_USD = '0.50'
const TIMEOUT_MS = 120_000
const MAX_REPORT_CHARS = 60_000
// How many test cases to map per Claude call. Keeps each call's output small
// enough to finish inside the budget and be valid JSON.
const CHUNK_SIZE = 30

export interface FillResult {
  filled: boolean
  /** Relative path (from the run's slug folder) of the written file, when filled. */
  file?: string
  /** Human-readable reason it was skipped, for logging. */
  reason?: string
  /** How many test-case rows got a verdict / how many rows total. */
  covered?: number
  total?: number
}

/** Coerce the configured/passed model to a known alias, defaulting to haiku. */
function normalizeModel(raw?: string): string {
  const m = (raw ?? '').trim()
  if (CRAWL_SUMMARY_MODELS.has(m)) return m
  if (CRAWL_SUMMARY_MODELS.has(GROUNDING_CHECK_MODEL)) return GROUNDING_CHECK_MODEL
  return 'haiku'
}

const norm = (s: string) => s.trim().replace(/^"|"$/g, '').toLowerCase().replace(/[^a-z]/g, '')

// Which execution column a header cell maps to. Priority is intentionally NOT
// here — it's a planning value set at generation, not a run result.
type ExecKey = 'status' | 'actual' | 'reference' | 'note'
function execKeyFor(header: string): ExecKey | null {
  const h = norm(header)
  if (h === 'status' || h === 'result' || h === 'passfail') return 'status'
  if (h === 'actualresult' || h === 'actual' || h === 'actualoutput') return 'actual'
  if (h === 'reference' || h === 'ref' || h === 'bug' || h === 'bugid' || h === 'issue') return 'reference'
  if (h === 'note' || h === 'notes' || h === 'comment' || h === 'comments' || h === 'remark' || h === 'remarks')
    return 'note'
  return null
}

// The column that identifies each case, for matching against the report.
function idColumnIndex(header: string[]): number {
  const wants = ['testcaseid', 'tcid', 'caseid', 'id', 'no', 'sno', 'stt']
  for (const w of wants) {
    const i = header.findIndex((h) => norm(h) === w)
    if (i >= 0) return i
  }
  return 0
}
function titleColumnIndex(header: string[]): number {
  return header.findIndex((h) => {
    const n = norm(h)
    return n === 'title' || n === 'summary' || n === 'testcase' || n === 'name' || n === 'scenario'
  })
}
function expectedColumnIndex(header: string[]): number {
  return header.findIndex((h) => {
    const n = norm(h)
    return n === 'expectedresult' || n === 'expected' || n === 'expectedoutput'
  })
}

interface Table {
  format: TestcaseFormat
  header: string[]
  rows: string[][]
  /** Original separator line for markdown tables, preserved verbatim. */
  mdSeparator?: string
}

// ---- Markdown pipe-table parse / serialize -------------------------------

const splitMdRow = (line: string): string[] => {
  // Split on unescaped pipes, drop the leading/trailing empty edge cells.
  const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split(/(?<!\\)\|/)
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
}
const isMdSeparator = (line: string) => /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-')

function parseMarkdownTable(md: string): Table | null {
  const lines = md.split(/\r?\n/)
  const headerIdx = lines.findIndex(
    (l, i) => l.trim().startsWith('|') && lines[i + 1] != null && isMdSeparator(lines[i + 1]),
  )
  if (headerIdx === -1) return null
  const header = splitMdRow(lines[headerIdx])
  const mdSeparator = lines[headerIdx + 1]
  const rows: string[][] = []
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const l = lines[i]
    if (!l.trim().startsWith('|')) break
    if (isMdSeparator(l)) continue
    rows.push(splitMdRow(l))
  }
  if (!rows.length) return null
  return { format: 'markdown', header, rows, mdSeparator }
}

function serializeTable(t: Table): string {
  if (t.format === 'csv') return serializeCsv([t.header, ...t.rows])
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
  const line = (cells: string[]) => `| ${cells.map(esc).join(' | ')} |`
  const sep = t.mdSeparator ?? `|${t.header.map(() => '---').join('|')}|`
  return [line(t.header), sep, ...t.rows.map(line)].join('\n')
}

function parseTable(content: string, format: TestcaseFormat): Table | null {
  if (format === 'csv') {
    const rows = parseCsvRows(content)
    if (rows.length < 2) return null
    return { format, header: rows[0], rows: rows.slice(1) }
  }
  return parseMarkdownTable(content)
}

// ---- AI verdicts ----------------------------------------------------------

interface Verdict {
  id: string
  status?: string
  actual?: string
  reference?: string
  note?: string
}

function extractJsonArray(raw: string): unknown[] | null {
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Canonical Status vocabulary (matches the project's ClickUp workflow):
//   Untested  — default; the case wasn't executed / the report doesn't cover it
//   Passed    — expected result met
//   Failed    — a defect/mismatch was reported (needs an Actual result; a bug
//               link belongs in Note)
//   Blocked   — couldn't be tested because another case is failing
//   Cancelled — BA/QC confirmed the case is skipped (a human decision, not
//               something the report implies — kept here for completeness)
function canonStatus(s: string | undefined): string {
  const n = (s ?? '').trim().toLowerCase()
  if (n.startsWith('pass')) return 'Passed'
  if (n.startsWith('fail')) return 'Failed'
  if (n.startsWith('block')) return 'Blocked'
  if (n.startsWith('cancel')) return 'Cancelled'
  if (n.startsWith('untested') || n.startsWith('not')) return 'Untested'
  // Partial coverage isn't a status in this workflow — treat as Failed so it's
  // reviewed, never silently passed.
  if (n.startsWith('partial')) return 'Failed'
  return 'Untested'
}

/** One Claude call mapping a CHUNK of cases to verdicts; merges into `map`. */
async function requestVerdictChunk(opts: {
  rootPath: string
  projectName: string
  report: string
  cases: { id: string; title: string; expected: string }[]
  model: string
  map: Map<string, Verdict>
}): Promise<boolean> {
  const casesBlock = opts.cases
    .map((c) =>
      [`- id: ${c.id}`, c.title && `  title: ${c.title}`, c.expected && `  expected: ${c.expected}`]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')
  const prompt = `You are a QC engineer recording the results of a completed test run for project "${opts.projectName}".

Below is the QC RUN REPORT, then a list of TEST CASES that were meant to be verified. For EACH test case, decide from the report alone what actually happened.

Output ONLY a JSON array (no prose, no code fence). Each element:
{"id": "<exact test case id>", "status": "Passed" | "Failed" | "Blocked" | "Untested", "actual": "<the observed result, concise — what actually happened>", "reference": "<a bug/issue id or link the report ties to this case, else empty string>", "note": "<a short extra note, else empty string>"}

Rules:
- Match each case to the report by its id and title. Use the EXACT id from the list.
- "status": "Passed" only when the report shows the expected result was met; "Failed" when a defect/mismatch is reported; "Blocked" when it couldn't be tested because another case is failing; "Untested" when the report doesn't cover this case. (Do NOT use "Cancelled" — that is a manual BA/QC decision, not something a run report implies.)
- "actual": for Passed, state what was observed (e.g. "Expected message shown."); for Failed, state the actual defect from the report — this field is REQUIRED for a Failed case. Keep it to one or two sentences.
- "reference": if the report ties a bug/issue id or link to a failing case, put it here.
- Do NOT invent defects, screens, or messages that are not in the report. If the report is silent on a case, use "Untested" and actual "Not covered by this run.".
- Return one element for EVERY test case id listed (there are ${opts.cases.length}).

=== QC RUN REPORT ===
${opts.report.slice(0, MAX_REPORT_CHARS)}

=== TEST CASES ===
${casesBlock}`

  const result = await runClaude(
    ['-p', '--model', opts.model, '--output-format', 'json', '--no-session-persistence', '--max-budget-usd', BUDGET_USD],
    TIMEOUT_MS,
    { cwd: opts.rootPath, usageSource: 'fill-testcases', model: opts.model, input: prompt },
  )
  if (result.timedOut) return false
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (result.code !== 0 || isError || !text) return false
  const arr = extractJsonArray(text)
  if (!arr) return false
  let added = false
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    if (!id) continue
    opts.map.set(id.toLowerCase(), {
      id,
      status: typeof o.status === 'string' ? o.status : undefined,
      actual: typeof o.actual === 'string' ? o.actual : undefined,
      reference: typeof o.reference === 'string' ? o.reference : undefined,
      note: typeof o.note === 'string' ? o.note : undefined,
    })
    added = true
  }
  return added
}

async function requestVerdicts(opts: {
  rootPath: string
  projectName: string
  report: string
  cases: { id: string; title: string; expected: string }[]
  model?: string
}): Promise<Map<string, Verdict> | null> {
  const model = normalizeModel(opts.model)
  const map = new Map<string, Verdict>()
  // Chunk the cases so a large sheet doesn't overflow the per-call budget with a
  // huge JSON output. Chunks run sequentially (one shared browser/CLI at a time).
  for (let i = 0; i < opts.cases.length; i += CHUNK_SIZE) {
    await requestVerdictChunk({
      rootPath: opts.rootPath,
      projectName: opts.projectName,
      report: opts.report,
      cases: opts.cases.slice(i, i + CHUNK_SIZE),
      model,
      map,
    })
  }
  return map.size ? map : null
}

// ---- Entry point ----------------------------------------------------------

export async function fillExecutedTestcases(opts: {
  rootPath: string
  projectName: string
  ticketId: string
  report: string
  /** The run's output folder name under testing/test-result/. */
  slug: string
  model?: string
}): Promise<FillResult> {
  try {
    // Resolve the crawled ticket folder — may be nested under a parent subtask.
    const dir = findCrawledTicketDir(opts.rootPath, opts.ticketId)
    if (!dir) return { filled: false, reason: 'no test-case file for this ticket' }
    const versions = listTestcaseVersions(dir)
    if (!versions.length) return { filled: false, reason: 'no test-case file for this ticket' }

    const latest = versions[versions.length - 1]
    const src = path.join(dir, latest.file)
    let content: string
    try {
      content = fs.readFileSync(src, 'utf8')
    } catch {
      return { filled: false, reason: 'could not read the test-case file' }
    }

    const table = parseTable(content, latest.format)
    if (!table) return { filled: false, reason: 'test-case file is not a readable table' }

    // Which columns are execution columns we can fill?
    const execCols: { index: number; key: ExecKey }[] = []
    table.header.forEach((h, i) => {
      const key = execKeyFor(h)
      if (key) execCols.push({ index: i, key })
    })
    // If the sheet has NO execution columns (a bare template of only ID / Title /
    // Steps / Expected), append the standard ones rather than skipping — so ANY
    // ticket that has generated test cases still produces a filled execution
    // record and the run's "Test execution results" table shows up.
    if (!execCols.length) {
      const appended: { header: string; key: ExecKey }[] = [
        { header: 'Status', key: 'status' },
        { header: 'Actual result', key: 'actual' },
        { header: 'Reference', key: 'reference' },
        { header: 'Note', key: 'note' },
      ]
      for (const { header, key } of appended) {
        table.header.push(header)
        execCols.push({ index: table.header.length - 1, key })
      }
      // The markdown separator was captured at the OLD column count; drop it so
      // serializeTable regenerates one matching the widened header.
      table.mdSeparator = undefined
    }

    const idIdx = idColumnIndex(table.header)
    const titleIdx = titleColumnIndex(table.header)
    const expIdx = expectedColumnIndex(table.header)
    const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')

    const cases = table.rows.map((row, i) => ({
      id: cell(row, idIdx) || `row-${i + 1}`,
      title: cell(row, titleIdx),
      expected: cell(row, expIdx),
    }))

    // If the model returns no usable verdicts, still write the executed sheet
    // with every planned case left Untested — so a ticket that HAS test cases
    // always yields the run's "Test execution results" table (blank rows beat a
    // missing table). covered stays 0 and is surfaced in the run log.
    const verdicts =
      (await requestVerdicts({
        rootPath: opts.rootPath,
        projectName: opts.projectName,
        report: opts.report,
        cases,
        model: opts.model,
      })) ?? new Map<string, Verdict>()

    // Merge verdicts into the execution columns — deterministic, no AI text
    // touches any other column.
    let covered = 0
    table.rows = table.rows.map((row, i) => {
      const out = row.slice()
      // Pad short rows so an exec column index is always writable.
      while (out.length < table.header.length) out.push('')
      const v = verdicts.get(cases[i].id.toLowerCase())
      if (!v) return out
      covered++
      for (const { index, key } of execCols) {
        if (key === 'status') out[index] = canonStatus(v.status)
        else if (key === 'actual') out[index] = (v.actual ?? '').trim()
        else if (key === 'reference') out[index] = (v.reference ?? '').trim()
        else if (key === 'note') out[index] = (v.note ?? '').trim()
      }
      return out
    })

    // Drop trailing columns that are empty across the header AND every row — some
    // test-case CSVs carry a run of trailing commas that would otherwise render
    // as blank columns after the last real one (e.g. after Note).
    {
      const width = Math.max(table.header.length, ...table.rows.map((r) => r.length))
      const cellAt = (r: string[], i: number) => (r[i] ?? '').trim()
      let last = width - 1
      while (
        last >= 0 &&
        cellAt(table.header, last) === '' &&
        table.rows.every((r) => cellAt(r, last) === '')
      )
        last--
      if (last < width - 1) {
        table.header = table.header.slice(0, last + 1)
        table.rows = table.rows.map((r) => r.slice(0, last + 1))
      }
    }

    const serialized = serializeTable(table)
    const ext = latest.format === 'csv' ? 'csv' : 'md'
    const outDir = path.join(testResultDirFor(opts.rootPath), opts.slug)
    const outRel = `testcases-executed.${ext}`
    try {
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(path.join(outDir, outRel), serialized + '\n', 'utf8')
    } catch {
      return { filled: false, reason: 'could not write the executed test-case file' }
    }

    return { filled: true, file: outRel, covered, total: table.rows.length }
  } catch {
    // Best-effort — never sink a finished run.
    return { filled: false, reason: 'unexpected error' }
  }
}
