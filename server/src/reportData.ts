/**
 * The Report page's data source: one server-side pass that joins everything the
 * portal already knows about a project into a single QC status picture.
 *
 * WHY THIS IS ONE SERVER CALL, NOT SIX CLIENT ONES
 * The chain a QC engineer actually reports on is
 *   ticket -> test cases -> run -> defects,
 * and every link lives somewhere else: tickets are folders under
 * `testing/tickets/`, test cases are files inside those folders, runs are rows in
 * SQLite, and defects are markdown inside `testing/test-result/<slug>/issues.md`.
 * Joining that in the browser would mean N+1 requests per ticket (a `report.md`
 * and an `issues.md` per run) and a page that renders half a truth while the rest
 * arrives. So the join happens here, once, and the page renders a finished object.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * - It never calls ClickUp/Jira/Azure. The report describes what is ON DISK, which
 *   is what the AI actually tested against. A ticket whose tracker status moved
 *   after the last crawl is reported as `stale`, not silently refreshed — a report
 *   that quietly mixes today's tracker state with last week's test evidence is how
 *   a closed ticket gets signed off against a superseded acceptance criterion.
 * - It never writes. Nothing here mutates a project.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ticketsDirFor, testResultDirFor } from './config.js'
import { listDesignChecks, listRuns } from './db.js'
import { parseReport, resolveRunOutDir } from './runManager.js'
import type {
  ReportDefect,
  ReportRunRow,
  ReportTicketRow,
  RunSummary,
  SystemReport,
  TicketStage,
} from './types.js'

/** Subfolders inside a ticket folder that are its own content, never a subtask. */
const RESERVED_TICKET_SUBDIRS = new Set(['testcases', 'attachments'])

// ---------------------------------------------------------------- small helpers

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((v) => {
      if (typeof v === 'string') return v.trim()
      if (v && typeof v === 'object') {
        const o = v as Record<string, unknown>
        return str(o.username) || str(o.name) || str(o.email)
      }
      return ''
    })
    .filter(Boolean)
}

function countOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0
}

function isoOrNull(value: unknown): string | null {
  const raw = typeof value === 'number' ? value : Number(str(value))
  if (Number.isFinite(raw) && raw > 0) return new Date(raw).toISOString()
  const s = str(value)
  if (!s) return null
  const t = Date.parse(s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/**
 * Rows in a test-case file. CSV: data lines minus the header. Markdown: table body
 * rows minus the header and its `---` separator. Both are approximations that only
 * ever inform a coverage RATIO, never a pass/fail — so a miscount can mislead about
 * breadth, not about a result.
 */
function countTestcases(file: string): number {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return 0
  }
  const lines = text.split('\n').map((l) => l.trim())
  if (file.toLowerCase().endsWith('.csv')) {
    const data = lines.filter(Boolean)
    return Math.max(0, data.length - 1)
  }
  const rows = lines.filter((l) => l.startsWith('|') && !/^\|?\s*:?-{3,}/.test(l))
  return Math.max(0, rows.length - 1)
}

// ------------------------------------------------------------ defect extraction

/**
 * Severity words the qc-testing skill writes into an issue body. Ordered worst
 * first — `severityRank` uses the index, so the report can sort "what hurts most"
 * without a second table.
 */
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unknown'] as const
export type Severity = (typeof SEVERITY_ORDER)[number]

const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: 'critical',
  critical: 'critical',
  urgent: 'critical',
  high: 'high',
  major: 'high',
  medium: 'medium',
  moderate: 'medium',
  normal: 'medium',
  low: 'low',
  minor: 'low',
  trivial: 'low',
}

const SEVERITY_RE =
  /(?:business\s*impact|severity|priority|impact)\s*[-:—]*\s*\*{0,2}\s*(critical|blocker|urgent|high|major|medium|moderate|normal|low|minor|trivial)/i

/**
 * The heading forms the skill writes: `## ISSUE-2 — … (Medium severity)` and
 * `## ISSUE-1 (High) — …`. Both are common in the same project, and matching only
 * the first left half the defects on the chart as "unknown" — measured on a real
 * project: 26 of 51.
 */
const SEVERITY_IN_TITLE_RE =
  /\(\s*(critical|blocker|urgent|high|major|medium|moderate|normal|low|minor|trivial)(?:\s+severity)?\s*\)/i

function severityOf(title: string, body: string): Severity {
  const m = title.match(SEVERITY_IN_TITLE_RE) ?? body.match(SEVERITY_RE)
  if (!m) return 'unknown'
  return SEVERITY_ALIASES[m[1].toLowerCase()] ?? 'unknown'
}

export function severityRank(s: Severity): number {
  const i = SEVERITY_ORDER.indexOf(s)
  return i < 0 ? SEVERITY_ORDER.length : i
}

function cleanHeading(raw: string): string {
  return raw
    .replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Pull one defect per `## ISSUE-n …` / `## DEFECT-n …` heading out of an
 * `issues.md`.
 *
 * This is a COUNTING pass, not the ClickUp filing parser in `RunDetailPage`. That
 * one has to reproduce a body faithfully enough to become a task description
 * (dropping `AC:` lines, extracting screenshots, falling back to a table or to the
 * whole file when the skill wrote no headings). Here a file with no recognisable
 * issue heading contributes ZERO defects on purpose: inventing one "issue" per
 * unparsed file would put a phantom defect on the chart for every run whose
 * `issues.md` just says "no issues found".
 */
function extractDefects(md: string, run: RunSummary, ticketKey: string | null): ReportDefect[] {
  const out: ReportDefect[] = []
  const lines = md.split('\n')
  let title: string | null = null
  let body: string[] = []

  const flush = () => {
    if (title === null) return
    const text = body.join('\n')
    out.push({
      id: `${run.id}:${out.length + 1}`,
      title: title.slice(0, 180),
      severity: severityOf(title, text),
      runId: run.id,
      runSlug: run.slug,
      ticketKey,
      at: run.finishedAt ?? run.createdAt,
      // The "Affected cases:" line, when the skill wrote one — it is what ties a
      // defect back to specific test cases rather than to a whole ticket.
      affects: (text.match(/^\s*\*{0,2}Affected cases?:?\*{0,2}\s*(.+)$/im)?.[1] ?? '')
        .replace(/[*_`]/g, '')
        .trim()
        .slice(0, 240),
    })
    title = null
    body = []
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/)
    if (h2) {
      const heading = cleanHeading(h2[1])
      if (/^(issue|defect|bug)[-\s#]*\d+/i.test(heading)) {
        flush()
        title = heading
        continue
      }
      flush() // a non-issue h2 closes the current section
      continue
    }
    if (title !== null) body.push(line)
  }
  flush()
  return out
}

/**
 * Reading and parsing every run's `report.md` + `issues.md` on each request is the
 * one genuinely expensive part of this module (a project accumulates hundreds of
 * run folders). Keyed by run id + the folder's mtime, so an edited report is picked
 * up but an untouched one is parsed once for the life of the process.
 */
interface RunArtifacts {
  counts: ReturnType<typeof parseReport> | null
  defects: ReportDefect[]
  hasReport: boolean
  hasIssues: boolean
}
const artifactCache = new Map<string, RunArtifacts>()

function readRunArtifacts(
  testingDir: string,
  run: RunSummary,
  ticketKey: string | null,
): RunArtifacts & { outDir: string | null } {
  const outDir = resolveRunOutDir(testingDir, run)
  const empty: RunArtifacts = { counts: null, defects: [], hasReport: false, hasIssues: false }
  if (!outDir) return { ...empty, outDir: null }

  const absDir = path.join(testingDir, outDir)
  let stamp = 0
  try {
    stamp = fs.statSync(absDir).mtimeMs
  } catch {
    return { ...empty, outDir }
  }
  const key = `${run.id}:${stamp}`
  const cached = artifactCache.get(key)
  if (cached) return { ...cached, outDir }

  const reportFile = path.join(absDir, 'report.md')
  const issuesFile = path.join(absDir, 'issues.md')
  let counts: RunArtifacts['counts'] = null
  let hasReport = false
  try {
    counts = parseReport(fs.readFileSync(reportFile, 'utf8'))
    hasReport = true
  } catch {
    /* the run never produced a report */
  }
  let defects: ReportDefect[] = []
  let hasIssues = false
  try {
    defects = extractDefects(fs.readFileSync(issuesFile, 'utf8'), run, ticketKey)
    hasIssues = true
  } catch {
    /* no issues file */
  }
  const built: RunArtifacts = { counts, defects, hasReport, hasIssues }
  artifactCache.set(key, built)
  // Bound the cache — a long-lived portal walking many projects must not grow
  // without limit. Oldest insertion wins the eviction.
  if (artifactCache.size > 500) {
    const oldest = artifactCache.keys().next().value
    if (oldest) artifactCache.delete(oldest)
  }
  return { ...built, outDir }
}

// ----------------------------------------------------------------- ticket scan

interface TicketScan {
  row: ReportTicketRow
  /** Every string a run's `ticketId` might legitimately carry for this ticket. */
  keys: string[]
}

function scanTicketFolder(baseDir: string, relPosix: string, parent: string | null): TicketScan {
  const absDir = path.join(baseDir, ...relPosix.split('/'))
  const basename = relPosix.split('/').pop() ?? relPosix
  const j = readJson(path.join(absDir, 'ticket.json')) ?? {}

  let crawledAt: string | null = null
  try {
    crawledAt = fs.statSync(absDir).mtime.toISOString()
  } catch {
    /* ignore */
  }

  // Test cases: the versioned files plus the legacy pre-versioning single file.
  // The NEWEST version is the one whose row count is reported — an older, shorter
  // v1 is not the suite anyone is executing.
  let versions: string[] = []
  try {
    versions = fs
      .readdirSync(path.join(absDir, 'testcases'))
      .filter((f) => /^v\d+\.(md|csv)$/.test(f))
      .sort((a, b) => {
        const n = (s: string) => Number(s.match(/^v(\d+)/)?.[1] ?? 0)
        return n(a) - n(b)
      })
  } catch {
    /* no testcases dir */
  }
  const legacy = fs.existsSync(path.join(absDir, 'testcases.md'))
  const latestRel = versions.length
    ? path.posix.join('testcases', versions[versions.length - 1])
    : legacy
      ? 'testcases.md'
      : null
  const testcaseCount = latestRel
    ? countTestcases(path.join(absDir, ...latestRel.split('/')))
    : 0

  const displayId = str(j.displayId) || str(j.customId) || basename
  const dateUpdated = isoOrNull(j.dateUpdated)

  const row: ReportTicketRow = {
    folder: relPosix,
    parent,
    displayId,
    title: str(j.name) || basename,
    url: str(j.url) || null,
    status: str(j.status),
    priority: str(j.priority),
    assignees: strList(j.assignees),
    tags: strList(j.tags),
    listName: str(j.listName),
    dueDate: isoOrNull(j.dueDate),
    dateUpdated,
    crawledAt,
    // A tracker edit newer than our snapshot: the evidence below was gathered
    // against a description that has since moved. Reported, never auto-refreshed.
    stale: Boolean(dateUpdated && crawledAt && Date.parse(dateUpdated) > Date.parse(crawledAt)),
    commentCount: countOf(j.comments),
    attachmentCount: countOf(j.attachments),
    hasSummary: fs.existsSync(path.join(absDir, 'summary.md')),
    hasActivity: fs.existsSync(path.join(absDir, 'activity.md')),
    testcaseVersions: versions.length + (legacy ? 1 : 0),
    latestTestcaseFile: latestRel,
    testcaseCount,
    runIds: [],
    runCount: 0,
    lastRunAt: null,
    lastRunStatus: null,
    latestReportRunId: null,
    latestReportAt: null,
    exec: { pass: 0, fail: 0, blocked: 0, untested: 0, cancelled: 0, total: 0 },
    defectCount: 0,
    defectsBySeverity: {},
    stage: 'crawled',
    passRate: null,
    coverage: null,
  }

  // A run's `ticketId` is whatever was typed on /qc-run: usually the displayId,
  // sometimes the folder name (they differ once a displayId has characters the
  // folder name had to sanitise away). Match on either, case-insensitively.
  const keys = [displayId, basename, str(j.id)].filter(Boolean).map((k) => k.toLowerCase())
  return { row, keys: [...new Set(keys)] }
}

function walkTickets(baseDir: string): TicketScan[] {
  const out: TicketScan[] = []
  const isTicket = (dir: string) =>
    fs.existsSync(path.join(dir, 'ticket.json')) || fs.existsSync(path.join(dir, 'ticket.md'))

  const walk = (relPosix: string, parent: string | null): void => {
    const absDir = relPosix ? path.join(baseDir, ...relPosix.split('/')) : baseDir
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) {
      if (!d.isDirectory() || RESERVED_TICKET_SUBDIRS.has(d.name)) continue
      const childRel = relPosix ? `${relPosix}/${d.name}` : d.name
      const childAbs = path.join(baseDir, ...childRel.split('/'))
      if (isTicket(childAbs)) {
        out.push(scanTicketFolder(baseDir, childRel, parent))
        walk(childRel, childRel)
      } else {
        walk(childRel, parent) // a subtask can still live deeper
      }
    }
  }
  walk('', null)
  return out
}

// -------------------------------------------------------------------- the build

export interface BuildReportOptions {
  /** ISO date (inclusive). Filters RUNS and DEFECTS only — never tickets, or a
   *  window would erase the backlog it exists to measure. */
  from?: string | null
  to?: string | null
}

export function buildSystemReport(
  project: { id: string; name: string; rootPath: string },
  opts: BuildReportOptions = {},
): SystemReport {
  const generatedAt = new Date().toISOString()
  const warnings: string[] = []
  const ticketsDir = ticketsDirFor(project.rootPath)
  const testingDir = testResultDirFor(project.rootPath)

  if (!fs.existsSync(project.rootPath)) {
    warnings.push(`Project folder is missing on disk: ${project.rootPath}`)
  } else if (!fs.existsSync(ticketsDir)) {
    warnings.push('No tickets have been crawled yet — nothing under testing/tickets/.')
  }

  const scans = fs.existsSync(ticketsDir) ? walkTickets(ticketsDir) : []
  const byKey = new Map<string, TicketScan>()
  for (const scan of scans) for (const k of scan.keys) if (!byKey.has(k)) byKey.set(k, scan)

  // ---- runs, oldest first so `lastRun*` ends up holding the newest ----
  const fromMs = opts.from ? Date.parse(opts.from) : NaN
  const toMs = opts.to ? Date.parse(opts.to) : NaN
  const inRange = (iso: string) => {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return true
    if (Number.isFinite(fromMs) && t < fromMs) return false
    if (Number.isFinite(toMs) && t > toMs) return false
    return true
  }

  const allRuns = listRuns(project.id)
    .filter((r) => inRange(r.createdAt))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const runRows: ReportRunRow[] = []
  /** Every defect ever recorded, across every run — the input to `recurring`. */
  const history: ReportDefect[] = []
  /**
   * The defects that are OPEN NOW: the latest reporting run's issues, per ticket
   * (and per flow run). Keyed so a later run of the same ticket REPLACES the
   * earlier list rather than adding to it — a defect fixed two runs ago must not
   * still be on the board.
   */
  const currentDefects = new Map<string, ReportDefect[]>()

  for (const run of allRuns) {
    const key = run.ticketId?.toLowerCase() ?? ''
    const scan = run.kind === 'flow' ? undefined : byKey.get(key)
    const ticketKey = scan?.row.folder ?? null
    const art = readRunArtifacts(testingDir, run, ticketKey)

    // The DB columns are the live counters the stream wrote; `report.md` is the
    // final word once it exists. Prefer the report, fall back to the row — a
    // paused or crashed run has counters and no report. A report that parsed to
    // ALL ZEROS is treated as no report at all: `parseReport` answers zeros for a
    // file whose summary table it could not read, and letting that overwrite real
    // counters would erase a finished run's result from the chart.
    const c = art.counts
    const parsed =
      c &&
      c.passCount + c.failCount + c.blockedCount + c.untestedCount + c.cancelledCount + c.totalAcs >
        0
        ? c
        : null
    const exec = {
      pass: parsed?.passCount ?? run.passCount,
      fail: parsed?.failCount ?? run.failCount,
      blocked: parsed?.blockedCount ?? run.blockedCount,
      untested: parsed?.untestedCount ?? run.untestedCount,
      cancelled: parsed?.cancelledCount ?? run.cancelledCount,
      total: parsed?.totalAcs ?? run.totalAcs,
    }
    if (!exec.total) {
      exec.total = exec.pass + exec.fail + exec.blocked + exec.untested + exec.cancelled
    }

    const runDefects = art.defects
    history.push(...runDefects)

    const durationMs =
      run.finishedAt && run.createdAt
        ? Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt))
        : null

    runRows.push({
      id: run.id,
      ticketId: run.ticketId,
      ticketFolder: ticketKey,
      ticketTitle: scan?.row.title ?? null,
      kind: run.kind ?? 'ticket',
      testTarget: run.testTarget,
      appUrl: run.appUrl,
      status: run.status,
      slug: art.outDir ?? run.slug,
      hasReport: art.hasReport,
      exec,
      defectCount: runDefects.length,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      durationMs,
    })

    if (scan) {
      const row = scan.row
      row.runIds.push(run.id)
      row.runCount++
      row.lastRunAt = run.finishedAt ?? run.createdAt
      row.lastRunStatus = run.status

      // A ticket's RESULT is its latest run that produced a report — never the sum
      // of its runs. This ticket has been re-run 22 times against the same 331
      // cases; adding those up gives "842 cases executed" out of 331 that exist,
      // and a coverage bar over 100%. The loop is oldest-first, so the last
      // reporting run to pass through here wins.
      if (art.hasReport) {
        row.exec = { ...exec }
        row.latestReportRunId = run.id
        row.latestReportAt = run.finishedAt ?? run.createdAt
        row.defectCount = runDefects.length
        row.defectsBySeverity = {}
        for (const d of runDefects) {
          row.defectsBySeverity[d.severity] = (row.defectsBySeverity[d.severity] ?? 0) + 1
        }
        currentDefects.set(row.folder, runDefects)
      }
    } else if (run.kind === 'flow' && art.hasReport) {
      // A flow run has no ticket to hang its result on, so it carries its own.
      currentDefects.set(`flow:${run.id}`, runDefects)
    }
  }

  // ---- per-ticket derived fields ----
  for (const { row } of scans) {
    const judged = row.exec.pass + row.exec.fail
    row.passRate = judged > 0 ? row.exec.pass / judged : null
    // Coverage compares what the latest run actually judged against the size of
    // the newest test-case file. Capped at 1: the run may have executed cases the
    // file has since dropped, and a 130% bar reads as a bug, not as drift.
    row.coverage =
      row.testcaseCount > 0 ? Math.min(1, (row.exec.pass + row.exec.fail) / row.testcaseCount) : null
    row.stage = ticketStage(row)
  }

  const tickets = scans
    .map((s) => s.row)
    .sort((a, b) => {
      // Worst first: the report opens on what needs attention, not on an alphabet.
      const rank = (t: ReportTicketRow) =>
        t.exec.fail > 0 ? 0 : t.defectCount > 0 ? 1 : t.stage === 'crawled' ? 2 : t.stage === 'planned' ? 3 : 4
      const d = rank(a) - rank(b)
      if (d !== 0) return d
      return (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '')
    })

  // The open board: one entry per defect in the latest reporting run of each
  // ticket / flow. This is what "12 open defects" means on the page.
  const defects = [...currentDefects.values()].flat()

  // ---- recurring defects: the same title seen in more than one run ----
  // Computed over HISTORY, not over the open board — "this keeps coming back"
  // is a statement about runs over time, and the open board has one run each.
  const groups = new Map<string, ReportDefect[]>()
  for (const d of history) {
    // Normalise away the ISSUE-n prefix and punctuation, so "ISSUE-2 — Wrong date
    // format" from two runs collapses into one recurring defect.
    const norm = d.title
      .toLowerCase()
      .replace(/^(issue|defect|bug)[-\s#]*\d+\s*[-–—:]*\s*/i, '')
      .replace(/\(.*?\)/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!norm) continue
    const list = groups.get(norm)
    if (list) list.push(d)
    else groups.set(norm, [d])
  }
  const recurring = [...groups.values()]
    .filter((list) => new Set(list.map((d) => d.runId)).size > 1)
    .map((list) => ({
      title: list[0].title,
      severity: list.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity))[0]
        .severity,
      occurrences: list.length,
      runIds: [...new Set(list.map((d) => d.runId))],
      tickets: [...new Set(list.map((d) => d.ticketKey).filter((t): t is string => !!t))],
      firstSeen: list.map((d) => d.at).sort()[0],
      lastSeen: list.map((d) => d.at).sort().slice(-1)[0],
    }))
    .sort((a, b) => b.occurrences - a.occurrences || severityRank(a.severity) - severityRank(b.severity))

  // ---- totals ----
  const bySeverity: Record<string, number> = {}
  for (const d of defects) bySeverity[d.severity] = (bySeverity[d.severity] ?? 0) + 1

  const statusBuckets = new Map<string, number>()
  for (const t of tickets) {
    const label = t.status || 'no status'
    statusBuckets.set(label, (statusBuckets.get(label) ?? 0) + 1)
  }

  const exec = tickets.reduce(
    (acc, t) => ({
      pass: acc.pass + t.exec.pass,
      fail: acc.fail + t.exec.fail,
      blocked: acc.blocked + t.exec.blocked,
      untested: acc.untested + t.exec.untested,
      cancelled: acc.cancelled + t.exec.cancelled,
      total: acc.total + t.exec.total,
    }),
    { pass: 0, fail: 0, blocked: 0, untested: 0, cancelled: 0, total: 0 },
  )

  const designChecks = listDesignChecks(project.id, 200).filter((d) => inRange(d.createdAt))

  return {
    projectId: project.id,
    projectName: project.name,
    rootPath: project.rootPath,
    generatedAt,
    range: { from: opts.from ?? null, to: opts.to ?? null },
    warnings,
    funnel: {
      tickets: tickets.length,
      planned: tickets.filter((t) => t.testcaseVersions > 0).length,
      executed: tickets.filter((t) => t.runCount > 0).length,
      // Reuses `ticketStage`, deliberately: an inline "ran, no failure, no
      // defect" test counts a ticket whose runs all died before writing a
      // report as CLEAN. On the reference project that put "Clean 5" in the
      // coverage chain while the ticket filter directly below it said
      // "Passed clean 0" — two numbers contradicting each other on one screen.
      // A run that produced no report is not a sign-off.
      clean: tickets.filter((t) => t.stage === 'clean').length,
    },
    totals: {
      tickets: tickets.length,
      subtasks: tickets.filter((t) => t.parent).length,
      staleTickets: tickets.filter((t) => t.stale).length,
      testcases: tickets.reduce((n, t) => n + t.testcaseCount, 0),
      runs: runRows.length,
      flowRuns: runRows.filter((r) => r.kind === 'flow').length,
      runsFailed: runRows.filter((r) => r.status === 'failed' || r.status === 'error').length,
      defects: defects.length,
      defectsAllTime: history.length,
      recurringDefects: recurring.length,
      exec,
      passRate: exec.pass + exec.fail > 0 ? exec.pass / (exec.pass + exec.fail) : null,
      designChecks: designChecks.length,
      designMismatches: designChecks.reduce((n, d) => n + d.counts.mismatch, 0),
    },
    statusBuckets: [...statusBuckets.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    defectsBySeverity: bySeverity,
    tickets,
    runs: runRows.slice().reverse(), // newest first for display
    defects: defects
      .slice()
      .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.at.localeCompare(a.at)),
    recurring,
    designChecks: designChecks.map((d) => ({
      id: d.id,
      folder: d.folder,
      figmaUrl: d.figmaUrl,
      counts: d.counts,
      createdAt: d.createdAt,
    })),
  }
}

/**
 * Where a ticket has stopped in the chain. Deliberately conservative at the top
 * end: `clean` means executed with no failure AND no defect — a run that produced
 * no report is not a sign-off, it is an unfinished run.
 */
function ticketStage(t: ReportTicketRow): TicketStage {
  if (t.runCount === 0) return t.testcaseVersions > 0 ? 'planned' : 'crawled'
  if (t.exec.fail > 0 || t.defectCount > 0) return 'defects'
  if (t.exec.blocked > 0 || t.exec.untested > 0) return 'partial'
  return t.exec.total > 0 ? 'clean' : 'partial'
}
