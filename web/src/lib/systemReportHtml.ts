/**
 * THE PRINTABLE QC STATUS REPORT — one standalone HTML document per project.
 *
 * The single source the PDF and the .docx are both made from (the server turns
 * this exact string into either), and it reads its numbers and its verdict from
 * `systemReport.ts` — the same module the screen renders from. That is the whole
 * point: a PDF mailed to a client cannot disagree with the page it came from.
 *
 * Self-contained and light-mode on purpose: it will be printed, attached to a
 * ticket, or opened in Word, none of which inherit the app's theme.
 *
 * The markup stays boring — headings, paragraphs, tables, inline SVG with
 * explicit width/height. `html-to-docx` understands that vocabulary; it does not
 * understand flexbox, grid, or CSS variables used for layout, so the layout uses
 * none of them. (And the server REPAIRS the .docx afterwards — see
 * `reportExport.ts` — because html-to-docx emits fractional column widths that
 * Word refuses outright.)
 */

import {
  dateTime,
  defectTitle,
  funnelSteps,
  gradeLabel,
  GRADE_HEX,
  num,
  pct,
  reportMarkdown,
  severityRows,
  SEVERITY_HEX,
  SEVERITY_LABEL,
  shortDate,
  STAGE_LABEL,
  ticketGrade,
  verdictOf,
} from './systemReport'
import type { SystemReport } from './types'

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * A horizontal bar row as a TABLE, not a div with a width — Word lays tables out
 * faithfully and ignores a percentage-width block. The bar is one cell with a
 * background; the label and the count are their own cells so they stay readable
 * when the document is re-flowed to a narrower page.
 */
function barRow(label: string, count: number, max: number, color: string, hint = ''): string {
  const width = max > 0 ? Math.max(2, Math.round((count / max) * 100)) : 0
  return `
    <tr>
      <td class="bar-label">${esc(label)}${hint ? `<span class="hint"> — ${esc(hint)}</span>` : ''}</td>
      <td class="bar-track">
        <table class="bar-inner"><tr><td style="width:${width}%;background:${color}">&nbsp;</td><td>&nbsp;</td></tr></table>
      </td>
      <td class="bar-count">${num(count)}</td>
    </tr>`
}

function section(title: string, body: string): string {
  if (!body.trim()) return ''
  return `<h2>${esc(title)}</h2>\n${body}`
}

export function systemReportHtml(report: SystemReport): string {
  const v = verdictOf(report)
  const t = report.totals
  const steps = funnelSteps(report)
  const maxStep = Math.max(1, ...steps.map((s) => s.count))
  const sev = severityRows(report.defectsBySeverity)
  const maxSev = Math.max(1, ...sev.map((s) => s.count))
  const maxStatus = Math.max(1, ...report.statusBuckets.map((s) => s.count))

  const rangeNote =
    report.range.from || report.range.to
      ? `<p class="note">Runs and defects are windowed${
          report.range.from ? ` from ${esc(shortDate(report.range.from))}` : ''
        }${report.range.to ? ` to ${esc(shortDate(report.range.to))}` : ''}. The ticket backlog is
        <strong>not</strong> date-filtered — a window that hid the backlog would turn "12 tickets
        still have no test cases" into "everything is fine this week".</p>`
      : ''

  const kpis = `
  <table class="kpi">
    <tr>
      <td><span class="kpi-n">${num(t.tickets)}</span><span class="kpi-l">Tickets</span></td>
      <td><span class="kpi-n">${num(t.testcases)}</span><span class="kpi-l">Test cases</span></td>
      <td><span class="kpi-n">${num(t.runs)}</span><span class="kpi-l">QC runs</span></td>
      <td><span class="kpi-n">${pct(t.passRate, 1)}</span><span class="kpi-l">Pass rate</span></td>
      <td><span class="kpi-n" style="color:${t.defects ? SEVERITY_HEX.high : GRADE_HEX.good}">${num(t.defects)}</span><span class="kpi-l">Open defects</span></td>
    </tr>
  </table>`

  const funnel = `
  <table class="bars">${steps.map((s) => barRow(s.label, s.count, maxStep, '#3279f9', s.hint)).join('')}</table>
  <p class="note">Each step is a subset of the one above it, so the bars are directly comparable.
  "Clean" means the ticket's latest run finished with no failure and no defect.</p>`

  const execTable = `
  <table class="grid">
    <tr><th>Outcome</th><th class="r">Cases</th><th class="r">Share</th></tr>
    ${[
      ['Passed', t.exec.pass],
      ['Failed', t.exec.fail],
      ['Blocked', t.exec.blocked],
      ['Not tested', t.exec.untested],
      ['Cancelled', t.exec.cancelled],
    ]
      .filter(([, n]) => (n as number) > 0)
      .map(
        ([label, n]) =>
          `<tr><td>${esc(String(label))}</td><td class="r">${num(n as number)}</td><td class="r">${
            t.exec.total ? pct((n as number) / t.exec.total, 1) : '—'
          }</td></tr>`,
      )
      .join('')}
    <tr class="total"><td>Total</td><td class="r">${num(t.exec.total)}</td><td class="r">100%</td></tr>
  </table>
  <p class="note">Counted from each ticket's <strong>latest run that produced a report</strong>,
  never summed across re-runs — a ticket re-tested 22 times against 331 cases would otherwise
  report 842 cases executed out of 331 that exist. Pass rate is
  ${num(t.exec.pass)} / ${num(t.exec.pass + t.exec.fail)} judged cases; blocked and not-tested
  cases are excluded from that ratio, because a case nobody could reach is not a case that passed.</p>`

  const severity = sev.length
    ? `<table class="bars">${sev
        .map((s) => barRow(SEVERITY_LABEL[s.key], s.count, maxSev, SEVERITY_HEX[s.key]))
        .join('')}</table>
      ${
        (report.defectsBySeverity.unknown ?? 0) > 0
          ? `<p class="note">"Unclassified" means the run's issues.md recorded no severity word —
             it is not a low-severity bucket.</p>`
          : ''
      }`
    : `<p class="empty">No defects are open. ${
        t.defectsAllTime > 0
          ? `${num(t.defectsAllTime)} were recorded historically and cleared by a later run.`
          : ''
      }</p>`

  const defectTable = report.defects.length
    ? `<table class="grid">
        <tr><th>Severity</th><th>Defect</th><th>Ticket</th><th>Affected cases</th></tr>
        ${report.defects
          .slice(0, 60)
          .map(
            (d) => `<tr>
              <td style="color:${SEVERITY_HEX[d.severity]}"><strong>${esc(SEVERITY_LABEL[d.severity])}</strong></td>
              <td>${esc(defectTitle(d.title))}</td>
              <td>${esc(d.ticketKey ?? 'E2E flow')}</td>
              <td class="dim">${esc(d.affects || '—')}</td>
            </tr>`,
          )
          .join('')}
      </table>
      ${report.defects.length > 60 ? `<p class="note">Showing the 60 worst of ${report.defects.length}.</p>` : ''}`
    : ''

  const recurring = report.recurring.length
    ? `<table class="grid">
        <tr><th class="r">Runs</th><th>Severity</th><th>Defect</th><th>First seen</th><th>Last seen</th></tr>
        ${report.recurring
          .slice(0, 25)
          .map(
            (r) => `<tr>
              <td class="r"><strong>${r.occurrences}</strong></td>
              <td style="color:${SEVERITY_HEX[r.severity]}">${esc(SEVERITY_LABEL[r.severity])}</td>
              <td>${esc(defectTitle(r.title))}</td>
              <td>${esc(shortDate(r.firstSeen))}</td>
              <td>${esc(shortDate(r.lastSeen))}</td>
            </tr>`,
          )
          .join('')}
      </table>
      <p class="note">Matched on the defect's wording with its ISSUE-n prefix removed, across every
      run in the window — so a defect re-found after a claimed fix shows up here even though the
      open-defect board only carries the latest run.</p>`
    : ''

  const statuses = report.statusBuckets.length
    ? `<table class="bars">${report.statusBuckets
        .map((s) => barRow(s.status, s.count, maxStatus, '#52514e'))
        .join('')}</table>
      <p class="note">The tracker status as of each ticket's last crawl${
        t.staleTickets
          ? ` — <strong>${num(t.staleTickets)}</strong> ticket${t.staleTickets === 1 ? ' has' : 's have'}
             changed in the tracker since, so their evidence below predates the current wording`
          : ''
      }.</p>`
    : ''

  const ticketRows = report.tickets
    .map((row) => {
      const g = ticketGrade(row)
      return `<tr>
        <td>
          <strong>${esc(row.displayId)}</strong>${row.parent ? ' <span class="dim">(subtask)</span>' : ''}
          ${row.stale ? ' <span class="stale">changed since crawl</span>' : ''}
          <br /><span class="dim">${esc(row.title)}</span>
        </td>
        <td>${esc(row.status || '—')}</td>
        <td style="color:${GRADE_HEX[g]}">${esc(STAGE_LABEL[row.stage])}</td>
        <td class="r">${row.testcaseCount || '—'}</td>
        <td class="r">${row.exec.pass || '—'}</td>
        <td class="r">${row.exec.fail || '—'}</td>
        <td class="r">${row.exec.blocked || '—'}</td>
        <td class="r">${row.defectCount || '—'}</td>
        <td>${esc(shortDate(row.lastRunAt))}</td>
      </tr>`
    })
    .join('')

  const tickets = report.tickets.length
    ? `<table class="grid tickets">
        <tr>
          <th>Ticket</th><th>Tracker status</th><th>Stage</th>
          <th class="r">Cases</th><th class="r">Pass</th><th class="r">Fail</th>
          <th class="r">Blocked</th><th class="r">Defects</th><th>Last run</th>
        </tr>
        ${ticketRows}
      </table>
      <p class="note">Ordered worst first: failures, then open defects, then tickets that have
      never been planned or run.</p>`
    : `<p class="empty">No tickets have been crawled into this project yet.</p>`

  const design =
    report.designChecks.length > 0
      ? `<table class="grid">
          <tr><th>Screen folder</th><th class="r">Matches</th><th class="r">Mismatches</th><th class="r">Concerns</th><th>Checked</th></tr>
          ${report.designChecks
            .slice(0, 20)
            .map(
              (d) => `<tr>
                <td>${esc(d.folder)}</td>
                <td class="r">${d.counts.match}</td>
                <td class="r" style="color:${d.counts.mismatch ? SEVERITY_HEX.high : 'inherit'}">${d.counts.mismatch}</td>
                <td class="r">${d.counts.concern}</td>
                <td>${esc(shortDate(d.createdAt))}</td>
              </tr>`,
            )
            .join('')}
        </table>`
      : ''

  const warnings = report.warnings.length
    ? `<div class="warn"><strong>Note:</strong> ${report.warnings.map(esc).join(' ')}</div>`
    : ''

  return `<h1>QC status report</h1>
<p class="sub">${esc(report.projectName)} · generated ${esc(dateTime(report.generatedAt))}</p>
${rangeNote}
${warnings}

<div class="verdict" style="border-color:${GRADE_HEX[v.grade]}">
  <p class="verdict-grade" style="color:${GRADE_HEX[v.grade]}">${esc(gradeLabel(v.grade))}</p>
  <p class="verdict-line">${esc(v.headline)}</p>
  ${v.action ? `<p class="verdict-next"><strong>Next:</strong> ${esc(v.action)}</p>` : ''}
</div>

${kpis}

${section('Coverage chain', funnel)}
${section('Execution outcome', execTable)}
${section('Open defects by severity', severity)}
${section('Open defects', defectTable)}
${section('Defects seen in more than one run', recurring)}
${section('Tickets by tracker status', statuses)}
${section('Tickets', tickets)}
${section('Design checks', design)}

<h2>How to read this</h2>
<ul>
  <li><strong>Everything here is on-disk evidence.</strong> The report never re-queries ClickUp,
      Jira or Azure — it describes what the AI actually tested against. A ticket whose tracker
      status has moved since its last crawl is flagged, not silently refreshed.</li>
  <li><strong>A ticket's result is its latest reporting run.</strong> Re-runs replace, they do not
      accumulate.</li>
  <li><strong>Blocked ≠ failed.</strong> Blocked and not-tested cases are reported separately and
      excluded from the pass rate; they are a coverage gap, not a defect.</li>
</ul>

<style>
  body { font-family: "Segoe UI", Arial, sans-serif; color: #1c1b19; font-size: 11pt; line-height: 1.5; }
  h1 { font-size: 20pt; margin: 0 0 2pt; }
  h2 { font-size: 13pt; margin: 22pt 0 6pt; border-bottom: 1px solid #d9d7d2; padding-bottom: 3pt; }
  p { margin: 0 0 8pt; }
  .sub { color: #52514e; margin-bottom: 10pt; }
  .note { color: #52514e; font-size: 9pt; margin-top: 4pt; }
  .empty { color: #52514e; font-style: italic; }
  .dim { color: #6b7280; }
  .stale { color: #b8860b; font-size: 8pt; }
  .warn { border-left: 3px solid #b8860b; padding: 6pt 10pt; background: #fdf7e6; margin-bottom: 10pt; }
  .verdict { border-left: 4px solid #52514e; padding: 8pt 12pt; background: #f6f5f3; margin: 12pt 0; }
  .verdict-grade { font-size: 13pt; font-weight: bold; margin: 0 0 3pt; }
  .verdict-line { margin: 0; }
  .verdict-next { margin: 5pt 0 0; color: #52514e; }
  table { border-collapse: collapse; width: 100%; }
  .kpi { margin: 12pt 0; }
  .kpi td { text-align: center; padding: 8pt 4pt; border: 1px solid #e5e3de; }
  .kpi-n { display: block; font-size: 16pt; font-weight: bold; }
  .kpi-l { display: block; font-size: 8pt; color: #52514e; text-transform: uppercase; letter-spacing: 0.5pt; }
  .grid { margin: 6pt 0; font-size: 9.5pt; }
  .grid th { text-align: left; background: #f0efec; border: 1px solid #e5e3de; padding: 4pt 6pt; }
  .grid td { border: 1px solid #e5e3de; padding: 4pt 6pt; vertical-align: top; }
  .grid .r, .grid th.r { text-align: right; }
  .grid .total td { font-weight: bold; background: #f6f5f3; }
  .bars { margin: 6pt 0; font-size: 10pt; }
  .bars td { padding: 3pt 4pt; vertical-align: middle; }
  .bar-label { width: 34%; }
  .bar-track { width: 56%; }
  .bar-count { width: 10%; text-align: right; font-weight: bold; }
  .bar-inner td { padding: 0; height: 10pt; }
  .hint { color: #6b7280; font-size: 8pt; }
  ul { margin: 0 0 8pt 16pt; padding: 0; }
  li { margin-bottom: 4pt; }
</style>`
}

/** Re-exported so a page can offer all three formats from one import. */
export { reportMarkdown }
