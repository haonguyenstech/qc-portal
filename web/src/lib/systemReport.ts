/**
 * The Report page's shared vocabulary: how a number becomes a word.
 *
 * Everything here is pure and derives from the `SystemReport` the server built —
 * no fetching, no formatting decisions that the screen and the exported document
 * could answer differently. `systemReportHtml.ts` and `ReportsPage.tsx` both read
 * from this file so a PDF handed to a client can never disagree with the screen
 * it was exported from.
 */

import type { ReportTicketRow, SystemReport, TicketStage } from './types'

export type Grade = 'good' | 'warn' | 'bad' | 'unknown'

export interface Verdict {
  grade: Grade
  headline: string
  /** The one thing to do next, or null when there is nothing outstanding. */
  action: string | null
}

export const STAGE_LABEL: Record<TicketStage, string> = {
  crawled: 'Crawled only',
  planned: 'Test cases ready',
  partial: 'Partly executed',
  defects: 'Defects open',
  clean: 'Passed clean',
}

/** The order the funnel is walked in — also the legend order on the page. */
export const STAGE_ORDER: TicketStage[] = ['crawled', 'planned', 'partial', 'defects', 'clean']

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'unknown'] as const
export type Severity = (typeof SEVERITY_ORDER)[number]

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  unknown: 'Unclassified',
}

/** Print/Word colours. The screen uses tokens; a document has no theme to inherit. */
export const SEVERITY_HEX: Record<Severity, string> = {
  critical: '#b91c1c',
  high: '#d03b3b',
  medium: '#b8860b',
  low: '#3279f9',
  unknown: '#6b7280',
}

export const GRADE_HEX: Record<Grade, string> = {
  good: '#0ca30c',
  warn: '#b8860b',
  bad: '#d03b3b',
  unknown: '#52514e',
}

export function gradeLabel(g: Grade): string {
  return g === 'good' ? 'On track' : g === 'warn' ? 'Needs attention' : g === 'bad' ? 'At risk' : 'Not enough data'
}

// ------------------------------------------------------------------ formatting

export function pct(value: number | null | undefined, digits = 0): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

export function num(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString()
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '—'
  return new Date(t).toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// -------------------------------------------------------------------- verdicts

/**
 * The one-line judgement at the top of the report.
 *
 * The thresholds are deliberately blunt and stated in the prose the page prints
 * beside them, because a QC status is read by people who did not run the tests:
 * an unexplained "Amber" invites an argument about the colour instead of about
 * the defect. Order matters — the WORST true statement wins, so a project with a
 * 95% pass rate and a critical defect still reads "At risk".
 */
export function verdictOf(report: SystemReport): Verdict {
  const t = report.totals
  const openCritical =
    (report.defectsBySeverity.critical ?? 0) + (report.defectsBySeverity.high ?? 0)

  if (t.tickets === 0) {
    return {
      grade: 'unknown',
      headline: 'No tickets have been crawled into this project yet.',
      action: 'Crawl a ticket on the Tickets page to start the chain.',
    }
  }
  if (openCritical > 0) {
    return {
      grade: 'bad',
      headline: `${openCritical} high or critical defect${openCritical === 1 ? '' : 's'} ${openCritical === 1 ? 'is' : 'are'} open across ${affectedTicketCount(report)} ticket${affectedTicketCount(report) === 1 ? '' : 's'}.`,
      action: 'Clear the high-severity defects before signing anything off.',
    }
  }
  if (t.passRate != null && t.passRate < 0.8) {
    return {
      grade: 'bad',
      headline: `Only ${pct(t.passRate)} of judged test cases passed in the latest run of each ticket.`,
      action: 'Re-run the failing tickets once the fixes land.',
    }
  }
  if (t.defects > 0) {
    return {
      grade: 'warn',
      headline: `${t.defects} open defect${t.defects === 1 ? '' : 's'}, none of them high severity.`,
      action: 'Triage the open defects and decide what ships.',
    }
  }
  const unplanned = report.funnel.tickets - report.funnel.planned
  if (unplanned > 0) {
    return {
      grade: 'warn',
      headline: `No defects outstanding, but ${unplanned} of ${report.funnel.tickets} tickets have no test cases yet.`,
      action: 'Generate test cases for the untouched tickets.',
    }
  }
  const unexecuted = report.funnel.planned - report.funnel.executed
  if (unexecuted > 0) {
    return {
      grade: 'warn',
      headline: `Every ticket is planned, but ${unexecuted} ${unexecuted === 1 ? 'has' : 'have'} never been run.`,
      action: 'Execute the remaining tickets.',
    }
  }
  return {
    grade: 'good',
    headline: `All ${report.funnel.tickets} tickets executed with no open defects.`,
    action: null,
  }
}

function affectedTicketCount(report: SystemReport): number {
  return new Set(report.defects.map((d) => d.ticketKey ?? d.runId)).size
}

/** Per-ticket grade, used for the row rail and the exported table. */
export function ticketGrade(t: ReportTicketRow): Grade {
  if (t.defectCount > 0 || t.exec.fail > 0) return 'bad'
  if (t.runCount === 0) return 'unknown'
  if (t.exec.blocked > 0 || t.exec.untested > 0) return 'warn'
  return 'good'
}

/**
 * The chain, as counts. Each step is a SUBSET of the one before it, so the bars
 * are directly comparable — `executed` counts tickets that have a run, not runs.
 */
export function funnelSteps(report: SystemReport): { label: string; count: number; hint: string }[] {
  const f = report.funnel
  return [
    { label: 'Crawled', count: f.tickets, hint: 'Ticket pulled into testing/tickets/' },
    { label: 'Test cases', count: f.planned, hint: 'Has at least one test-case version' },
    { label: 'Executed', count: f.executed, hint: 'Has at least one QC run' },
    { label: 'Clean', count: f.clean, hint: 'Reported, with no failure and no defect' },
  ]
}

/**
 * A defect title with its own bookkeeping stripped off the front.
 *
 * `issues.md` headings read `## ISSUE-3 (Medium) — Priority default label shows
 * "Normal"`, and the parser keeps that verbatim. Printed next to a severity
 * pill and in a list whose every row is a defect, the `ISSUE-3 (Medium) —` is
 * three pieces of information the reader already has, eating the first third of
 * the line before the sentence starts. The number is not an identity either —
 * the same defect is ISSUE-1 in one run and ISSUE-3 in the next, which is
 * exactly why the recurrence matcher throws it away too.
 *
 * Only that shape is stripped, and only when something is left over: a title
 * that IS the heading survives whole rather than becoming an empty cell.
 */
export function defectTitle(raw: string): string {
  const trimmed = raw.replace(/^\s*ISSUE-\d+\s*(\([^)]*\))?\s*[—–:-]?\s*/i, '').trim()
  return trimmed || raw.trim()
}

/** Only the defect severities that actually occur, worst first. */
export function severityRows(counts: Record<string, number>): { key: Severity; count: number }[] {
  return SEVERITY_ORDER.map((key) => ({ key, count: counts[key] ?? 0 })).filter((r) => r.count > 0)
}

export function reportFileName(report: SystemReport): string {
  const slug = report.projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  const day = report.generatedAt.slice(0, 10)
  return `qc-report-${slug || 'project'}-${day}`
}

// ------------------------------------------------------------------- markdown
// The Markdown export is not a lesser PDF — it is what gets pasted into a ticket
// comment or a Slack thread, so it leads with the verdict and the numbers and
// leaves the long tables to the document exports.

export function reportMarkdown(report: SystemReport): string {
  const v = verdictOf(report)
  const t = report.totals
  const lines: string[] = []

  lines.push(`# QC status — ${report.projectName}`)
  lines.push('')
  lines.push(`_Generated ${dateTime(report.generatedAt)}_`)
  if (report.range.from || report.range.to) {
    lines.push(
      `_Runs and defects windowed ${report.range.from ? `from ${shortDate(report.range.from)}` : ''}${
        report.range.to ? ` to ${shortDate(report.range.to)}` : ''
      }. The ticket backlog is not date-filtered._`,
    )
  }
  lines.push('')
  lines.push(`**${gradeLabel(v.grade)}** — ${v.headline}`)
  if (v.action) lines.push(`> Next: ${v.action}`)
  lines.push('')

  lines.push('## Numbers')
  lines.push('')
  lines.push('| Metric | Value |')
  lines.push('|---|---|')
  lines.push(`| Tickets crawled | ${num(t.tickets)}${t.subtasks ? ` (${t.subtasks} subtasks)` : ''} |`)
  lines.push(`| Test cases written | ${num(t.testcases)} |`)
  lines.push(`| QC runs | ${num(t.runs)}${t.flowRuns ? ` (${t.flowRuns} E2E flows)` : ''} |`)
  lines.push(`| Cases passed / failed | ${num(t.exec.pass)} / ${num(t.exec.fail)} |`)
  lines.push(`| Blocked / not tested | ${num(t.exec.blocked)} / ${num(t.exec.untested)} |`)
  lines.push(`| Pass rate (of judged) | ${pct(t.passRate, 1)} |`)
  lines.push(`| Open defects | ${num(t.defects)} |`)
  lines.push(`| Recurring defects | ${num(t.recurringDefects)} |`)
  if (t.designChecks) {
    lines.push(`| Design checks | ${num(t.designChecks)} (${num(t.designMismatches)} mismatches) |`)
  }
  if (t.staleTickets) lines.push(`| Tickets changed since crawl | ${num(t.staleTickets)} |`)
  lines.push('')

  lines.push('## Coverage chain')
  lines.push('')
  lines.push('| Step | Tickets | Meaning |')
  lines.push('|---|---:|---|')
  for (const s of funnelSteps(report)) lines.push(`| ${s.label} | ${s.count} | ${s.hint} |`)
  lines.push('')

  if (report.defects.length) {
    lines.push('## Open defects')
    lines.push('')
    lines.push('| Severity | Defect | Ticket |')
    lines.push('|---|---|---|')
    for (const d of report.defects.slice(0, 50)) {
      lines.push(
        `| ${SEVERITY_LABEL[d.severity]} | ${mdCell(defectTitle(d.title))} | ${mdCell(d.ticketKey ?? 'E2E flow')} |`,
      )
    }
    lines.push('')
  }

  if (report.recurring.length) {
    lines.push('## Defects seen in more than one run')
    lines.push('')
    lines.push('| Runs | Severity | Defect | First seen | Last seen |')
    lines.push('|---:|---|---|---|---|')
    for (const r of report.recurring.slice(0, 25)) {
      lines.push(
        `| ${r.occurrences} | ${SEVERITY_LABEL[r.severity]} | ${mdCell(defectTitle(r.title))} | ${shortDate(r.firstSeen)} | ${shortDate(r.lastSeen)} |`,
      )
    }
    lines.push('')
  }

  lines.push('## Tickets')
  lines.push('')
  lines.push('| Ticket | Status | Stage | Cases | Pass | Fail | Blocked | Defects | Last run |')
  lines.push('|---|---|---|---:|---:|---:|---:|---:|---|')
  for (const row of report.tickets) {
    lines.push(
      `| ${mdCell(`${row.displayId} — ${row.title}`)} | ${mdCell(row.status || '—')} | ${
        STAGE_LABEL[row.stage]
      } | ${row.testcaseCount || '—'} | ${row.exec.pass} | ${row.exec.fail} | ${row.exec.blocked} | ${
        row.defectCount
      } | ${shortDate(row.lastRunAt)} |`,
    )
  }
  lines.push('')

  lines.push('---')
  lines.push('')
  lines.push(
    'A ticket row reports its **latest run that produced a report**, never a sum across re-runs. ' +
      'Pass rate counts only cases judged pass or fail — blocked and not-tested cases are excluded ' +
      'from the ratio and shown separately, because a case nobody could reach is not a case that passed.',
  )
  return lines.join('\n')
}

/** A table cell that cannot break the table: pipes and newlines out. */
function mdCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}
