import {
  DATA_LIMITATIONS,
  formatMeasured,
  defaultCriterion,
  defaultScope,
  formatTarget,
  METRIC_LABEL,
  STATUS_LABEL,
  type NfrCase,
  type NfrRecommendation,
  type NfrReport,
  type NfrRequirementResult,
  type NfrStatus,
} from './nfrReport'
import { nfrRequirementChart } from './perfCharts'
import { bytes, ms, pct, shortUrl } from './perfReport'

/**
 * THE NFR REPORT DOCUMENT — the deliverable, as one standalone HTML file.
 *
 * Same contract as `perfReportHtml.ts`: this exact string becomes the PDF (headless
 * Chrome) and the .docx (`html-to-docx`), so the three can never disagree, and the
 * markup stays boring — headings, paragraphs, tables, inline SVG — because that is
 * the vocabulary `html-to-docx` understands. No flexbox, no grid, no CSS variables
 * driving layout.
 *
 * The section numbering, the executive-summary matrix and the PASS / FAILED /
 * PENDING / SUGGESTION labels are copied from the delivered report this format is
 * modelled on. They are not decoration: a client who has signed off on that shape
 * can read this one without being taught it.
 */

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Status colours: the same emerald/amber/red vocabulary the app uses on screen. */
const STATUS_HEX: Record<NfrStatus, string> = {
  pass: '#0ca30c',
  failed: '#d03b3b',
  mixed: '#b8860b',
  risk: '#b8860b',
  pending: '#52514e',
}

const PRIORITY_LABEL: Record<NfrRecommendation['priority'], string> = {
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Note',
}

function table(headers: string[], rows: string[][], numericFrom = 1): string {
  return `
  <table>
    <thead><tr>${headers
      .map((h, i) => `<th${i >= numericFrom && numericFrom > 0 ? ' class="num"' : ''}>${esc(h)}</th>`)
      .join('')}</tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr>${r
            .map(
              (c, i) =>
                `<td${i >= numericFrom && numericFrom > 0 ? ' class="num"' : ''}>${c}</td>`,
            )
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  </table>`
}

/** `Name: https://…` lines → a definition list. Anything else is kept verbatim. */
function environmentList(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  return `<ul>${lines
    .map((line) => {
      const idx = line.indexOf(':')
      if (idx <= 0) return `<li>${esc(line)}</li>`
      return `<li><strong>${esc(line.slice(0, idx).trim())}:</strong> ${esc(line.slice(idx + 1).trim())}</li>`
    })
    .join('')}</ul>`
}

function paragraphs(raw: string): string {
  return raw
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** A PASS / FAILED / PENDING line, the way the source report writes them. */
function verdictLine(kind: string, color: string, text: string): string {
  return `<p class="verdict-line"><span class="verdict-tag" style="color:${color}">${esc(kind)}:</span> ${esc(text)}</p>`
}

function caseMetrics(c: NfrCase, requirementMetric: string): string {
  const rows: [string, string][] = [
    ['Virtual users', c.vus ? String(c.vus) : '—'],
    ['Requests', c.requests.toLocaleString()],
    ['Throughput (average)', `${c.avgRps.toFixed(2)} requests/second`],
    ['Success rate', pct(c.successRate)],
    ['Failed requests', `${c.failedRequests.toLocaleString()} (${pct(1 - c.successRate)})`],
    ['P50 response time', ms(c.p50)],
    ['P95 response time', ms(c.p95)],
    ['Slowest response', ms(c.max)],
    ['Server think time (TTFB avg)', ms(c.ttfb)],
    ['Judged on', requirementMetric],
  ]
  return `<ul class="metrics">${rows
    .map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(v)}</li>`)
    .join('')}</ul>`
}

function caseBlock(result: NfrRequirementResult, c: NfrCase): string {
  const parts: string[] = []
  parts.push(
    `<h4>${esc(c.name)} — ${esc(c.method)} ${esc(shortUrl(c.url))}</h4>`,
    `<p class="muted">Run: ${esc(c.runLabel)}</p>`,
    caseMetrics(c, METRIC_LABEL[result.requirement.metric]),
  )

  // Stability and performance are stated separately and in that order — "up but
  // slow" is a distinct outcome from "down", and the report must not merge them.
  parts.push(
    c.stability === 'pass'
      ? verdictLine(
          'PASS — Stability',
          STATUS_HEX.pass,
          `All ${c.requests.toLocaleString()} requests returned successfully. No HTTP failures or timeouts were recorded.`,
        )
      : verdictLine(
          'FAILED — Stability',
          STATUS_HEX.failed,
          `${c.failedRequests.toLocaleString()} of ${c.requests.toLocaleString()} requests failed (${pct(1 - c.successRate)} of calls).`,
        ),
  )

  const target = formatTarget(result.requirement.metric, result.requirement.target)
  parts.push(
    c.performance === 'pass'
      ? verdictLine(
          'PASS — Performance',
          STATUS_HEX.pass,
          `The ${METRIC_LABEL[result.requirement.metric].toLowerCase()} of ${c.measuredText} met the ${target} target for ${result.requirement.id}.`,
        )
      : verdictLine(
          'FAILED — Performance',
          STATUS_HEX.failed,
          `The ${METRIC_LABEL[result.requirement.metric].toLowerCase()} of ${c.measuredText} did not meet the ${target} target for ${result.requirement.id}.`,
        ),
  )

  if (c.p50 > 0 && c.max / c.p50 >= 10) {
    parts.push(
      verdictLine(
        'FINDING',
        STATUS_HEX.mixed,
        `The gap between the median (${ms(c.p50)}) and the slowest call (${ms(c.max)}) indicates that a subset of requests experienced severe tail latency rather than a uniform slowdown.`,
      ),
    )
  }
  return parts.join('')
}

function requirementSection(result: NfrRequirementResult, index: number): string {
  const { requirement, status, cases } = result
  const parts: string[] = []
  parts.push(
    `<h3>3.${index + 1} ${esc(requirement.id)} — ${esc(requirement.scope.trim() || defaultScope(requirement))}</h3>`,
  )
  {
    parts.push(`<p>${esc(requirement.criterion.trim() || defaultCriterion(requirement))}</p>`)
  }

  if (status === 'pending') {
    parts.push(
      verdictLine('PENDING', STATUS_HEX.pending, result.keyResult),
      `<p>No performance result is available yet. This requirement must not be marked as Pass or Failed until testing is completed.</p>`,
    )
    return parts.join('')
  }

  parts.push(
    `<p class="muted">${cases.length} test case${cases.length === 1 ? '' : 's'} · judged on ${esc(METRIC_LABEL[requirement.metric])} · target ${esc(formatTarget(requirement.metric, requirement.target))}</p>`,
  )

  const chart = nfrRequirementChart(result, false)
  if (chart) {
    parts.push(`<div class="viz-root">${chart}</div>`)
  }

  // Two runs of the same endpoint are two rows with the SAME name, so the run has to
  // be a column or the table cannot be read. Only added when it is ambiguous.
  const perRun = new Set(cases.map((c) => c.runId)).size > 1
  parts.push(
    table(
      perRun
        ? ['Test case', 'Run', 'Requests', 'Success', 'P50', 'P95', 'Slowest', 'Verdict']
        : ['Test case', 'Requests', 'Success', 'P50', 'P95', 'Slowest', 'Verdict'],
      cases.map((c) =>
        [
          esc(c.name),
          ...(perRun ? [esc(c.runLabel)] : []),
          c.requests.toLocaleString(),
          pct(c.successRate),
          ms(c.p50),
          ms(c.p95),
          ms(c.max),
          `<span style="color:${c.performance === 'pass' ? STATUS_HEX.pass : STATUS_HEX.failed}">${c.performance === 'pass' ? 'PASS' : 'FAILED'}</span>`,
        ],
      ),
      perRun ? 2 : 1,
    ),
  )

  for (const c of cases) parts.push(caseBlock(result, c))
  return parts.join('')
}

function recommendationList(items: NfrRecommendation[]): string {
  if (!items.length) return '<p class="muted">Nothing to raise.</p>'
  return `<ul>${items
    .map(
      (r) =>
        `<li><strong>${esc(PRIORITY_LABEL[r.priority])} — ${esc(r.title)}:</strong> ${esc(r.detail)}</li>`,
    )
    .join('')}</ul>`
}

const STYLE = `
  :root { --viz-series-1:#2a78d6; --viz-series-2:#eb6834; --viz-good:#0ca30c; --viz-warn:#fab219; --viz-bad:#d03b3b; --viz-ink:#1a1a19; --viz-muted:#6b6a66; --viz-surface:#ffffff; --viz-track:#eceae5; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1a1a19; font-size: 11px; line-height: 1.55; margin: 0; }
  h1 { font-size: 26px; line-height: 1.2; margin: 4px 0 6px; color: #163a5f; }
  h2 { font-size: 16px; margin: 26px 0 8px; color: #163a5f; page-break-after: avoid; }
  h3 { font-size: 13px; margin: 20px 0 6px; color: #1d6a7a; page-break-after: avoid; }
  h4 { font-size: 12px; margin: 14px 0 4px; color: #163a5f; page-break-after: avoid; }
  p { margin: 6px 0; }
  ul { margin: 6px 0 6px 18px; padding: 0; }
  li { margin: 2px 0; }
  .kicker { font-size: 12px; font-weight: bold; color: #163a5f; letter-spacing: .02em; margin: 0; }
  .cover-meta { color: #52514e; font-size: 11.5px; margin: 2px 0 18px; }
  .muted { color: #6b6a66; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 14px; font-size: 10.5px; }
  th { text-align: left; background: #1d3b5c; color: #fff; font-weight: bold; padding: 6px 8px; }
  th.num { text-align: right; }
  td { padding: 5px 8px; border-bottom: 1px solid #e8e6e1; vertical-align: top; }
  tr { page-break-inside: avoid; }
  .status-cell { font-weight: bold; }
  .summary-note { background: #fdf6e3; border-left: 3px solid #b8860b; padding: 8px 12px; margin: 12px 0; }
  .verdict-line { margin: 5px 0 5px 10px; page-break-inside: avoid; }
  .verdict-tag { font-weight: bold; }
  .metrics { margin-left: 18px; }
  .limitation { color: #6b6a66; font-size: 10px; margin-top: 4px; }
  svg { display: block; max-width: 100%; page-break-inside: avoid; }
  .viz-root { margin: 10px 0 14px; }
  .viz-title { font: bold 12px "Helvetica Neue", Arial, sans-serif; fill: #1a1a19; }
  .viz-sub { font: 10px "Helvetica Neue", Arial, sans-serif; fill: #6b6a66; }
  .viz-label { font: 11px "Helvetica Neue", Arial, sans-serif; fill: #1a1a19; }
  .viz-value { font: 11px "Helvetica Neue", Arial, sans-serif; fill: #1a1a19; }
  .viz-flag { font: 10px "Helvetica Neue", Arial, sans-serif; fill: #6b6a66; }
  .viz-ref { stroke: #52514e; stroke-width: 1; stroke-dasharray: 3 3; }
  .viz-legend { font-size: 10px; color: #6b6a66; margin-top: 4px; }
  .viz-legend span { margin-right: 14px; }
  .viz-legend i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; }
  .footer { color: #6b6a66; font-size: 9.5px; margin-top: 26px; border-top: 1px solid #e8e6e1; padding-top: 6px; }
`

/** The whole document. `runs` supplies the configuration section's real numbers. */
export function nfrReportHtml(report: NfrReport): string {
  const { meta, runs, requirements } = report
  const body: string[] = []
  const firstRun = runs[0]
  const testDate =
    meta.testDate.trim() ||
    (firstRun ? new Date(firstRun.createdAt).toLocaleDateString() : new Date().toLocaleDateString())

  // ---------------------------------------------------------------- cover
  if (meta.phase.trim()) body.push(`<p class="kicker">${esc(meta.phase.trim())}</p>`)
  body.push(
    `<h1>${esc(meta.system.trim() || 'Performance')} — NFR Performance Results</h1>`,
  )
  body.push(
    `<p class="cover-meta">${esc(
      [
        meta.environment.trim(),
        runs.length
          ? `${Math.max(...runs.map((r) => r.loadConfig?.vus ?? 0))} concurrent virtual users`
          : '',
        'k6',
        meta.region.trim(),
        testDate,
      ]
        .filter(Boolean)
        .join(' · '),
    )}${meta.tester.trim() ? `<br>Tested by ${esc(meta.tester.trim())}` : ''}</p>`,
  )

  // ------------------------------------------------------ executive summary
  body.push('<h2>Executive Summary</h2>')
  if (meta.objective.trim()) body.push(paragraphs(meta.objective.trim()))
  body.push(
    table(
      ['Requirement', 'Scope', 'Key result', 'Status'],
      requirements.map((r) => [
        `<strong>${esc(r.requirement.id)}</strong>`,
        esc(r.requirement.scope.trim() || defaultScope(r.requirement)),
        esc(r.keyResult),
        `<span class="status-cell" style="color:${STATUS_HEX[r.status]}">${esc(STATUS_LABEL[r.status])}</span>`,
      ]),
      0,
    ),
  )
  body.push(
    `<div class="summary-note"><strong>Overall assessment:</strong> ${esc(report.finalAssessment)}</div>`,
  )

  // ------------------------------------------- 1. overview and environment
  body.push('<h2>1. Project Overview and Test Environment</h2>')
  if (meta.system.trim()) body.push(`<p>Project: ${esc(meta.system.trim())}</p>`)
  const envs = environmentList(meta.environments)
  if (envs) body.push('<h3>1.1 Environments</h3>', envs)

  body.push('<h3>1.2 Test Configuration</h3>')
  body.push(
    `<ul>
      <li><strong>Test tool:</strong> k6</li>
      ${meta.region.trim() ? `<li><strong>Load origin:</strong> ${esc(meta.region.trim())}</li>` : ''}
      ${meta.environment.trim() ? `<li><strong>Environment:</strong> ${esc(meta.environment.trim())}</li>` : ''}
      <li><strong>Test date:</strong> ${esc(testDate)}</li>
      <li><strong>Runs in this report:</strong> ${runs.length}</li>
    </ul>`,
  )
  if (runs.length) {
    body.push(
      table(
        ['Run', 'Virtual users', 'Duration', 'Ramp-up', 'Endpoints', 'Requests', 'Errors', 'Data received'],
        runs.map((job) => [
          esc(job.label),
          String(job.loadConfig?.vus ?? '—'),
          esc(job.loadConfig?.duration ?? '—'),
          esc(job.loadConfig?.rampUp || 'none'),
          String(job.loadConfig?.endpoints.length ?? 0),
          (job.loadResult?.requests ?? 0).toLocaleString(),
          pct(job.loadResult?.failRate ?? 0),
          bytes(job.loadResult?.dataReceived ?? 0),
        ]),
      ),
    )
  }
  if (meta.objective.trim()) {
    body.push('<h3>1.3 Test Objective and Scope</h3>', paragraphs(meta.objective.trim()))
  }

  // ------------------------------------------ 2. requirements and criteria
  body.push('<h2>2. Requirements and Acceptance Criteria</h2>')
  body.push(
    `<ul>${requirements
      .map(
        (r) =>
          `<li><strong>${esc(r.requirement.id)}:</strong> ${esc(
            r.requirement.criterion.trim() || defaultCriterion(r.requirement),
          )}</li>`,
      )
      .join('')}</ul>`,
  )
  body.push('<h3>2.1 Metric Definitions</h3>')
  body.push(
    `<ul>
      <li><strong>Virtual users (VUs):</strong> Number of concurrent users simulated.</li>
      <li><strong>Requests:</strong> Total requests generated against that endpoint during the run.</li>
      <li><strong>Throughput:</strong> Requests per second, averaged over the run.</li>
      <li><strong>Success rate:</strong> Percentage of requests that returned a successful response.</li>
      <li><strong>Failed requests:</strong> Requests that returned an error or failed the test logic.</li>
      <li><strong>P50 / P95 response time:</strong> The response time within which 50% / 95% of requests completed.</li>
      <li><strong>Server think time (TTFB):</strong> Time waiting for the first byte — the server's own processing.</li>
    </ul>`,
  )

  // ------------------------------------------------- 3. detailed results
  body.push('<h2>3. Detailed Test Results</h2>')
  if (!requirements.length) {
    body.push('<p class="muted">No requirements were defined for this report.</p>')
  }
  requirements.forEach((r, i) => body.push(requirementSection(r, i)))

  // --------------------------------------- 4. findings and recommendations
  body.push('<h2>4. Findings and Recommendations</h2>')
  // Numbered as they are emitted: an optional Notes section that is absent must not
  // leave a hole in the numbering (4.3 followed by 4.5 reads as a missing page).
  let sub = 0
  const heading = (title: string) => `<h3>4.${++sub} ${esc(title)}</h3>`
  body.push(heading('Key Findings'), recommendationList(report.findings))
  body.push(heading('Recommendations'), recommendationList(report.recommendations))
  body.push(heading('Final Assessment'), `<p>${esc(report.finalAssessment)}</p>`)
  if (meta.notes.trim()) body.push(heading('Notes'), paragraphs(meta.notes.trim()))

  body.push(
    heading('Data Limitations'),
    `<ul>${DATA_LIMITATIONS.map((l) => `<li class="limitation">${esc(l)}</li>`).join('')}</ul>`,
  )

  body.push(
    `<p class="footer">Generated by QC Portal · Performance · ${esc(new Date().toLocaleString())}</p>`,
  )

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(meta.system.trim() || 'Performance')} — NFR Performance Report</title>
<style>${STYLE}</style></head>
<body>${body.join('\n')}</body></html>`
}

// ------------------------------------------------------------------ markdown

function mdTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n')
}

/** The same report as Markdown, for a ticket or a wiki page. */
export function nfrReportMarkdown(report: NfrReport): string {
  const { meta, runs, requirements } = report
  const lines: string[] = []
  lines.push(`# ${meta.system.trim() || 'Performance'} — NFR Performance Results`, '')
  if (meta.phase.trim()) lines.push(`_${meta.phase.trim()}_`, '')
  lines.push(
    [meta.environment.trim(), 'k6', meta.region.trim(), meta.testDate.trim()]
      .filter(Boolean)
      .join(' · '),
    '',
  )

  lines.push('## Executive summary', '')
  lines.push(
    mdTable(
      ['Requirement', 'Scope', 'Key result', 'Status'],
      requirements.map((r) => [
        r.requirement.id,
        r.requirement.scope.trim() || defaultScope(r.requirement),
        r.keyResult,
        STATUS_LABEL[r.status],
      ]),
    ),
    '',
  )
  lines.push(`**Overall assessment:** ${report.finalAssessment}`, '')

  lines.push('## Detailed results', '')
  requirements.forEach((r, i) => {
    lines.push(
      `### 3.${i + 1} ${r.requirement.id} — ${r.requirement.scope.trim() || defaultScope(r.requirement)}`,
      '',
    )
    lines.push(r.requirement.criterion.trim() || defaultCriterion(r.requirement), '')
    if (r.status === 'pending') {
      lines.push(
        `**PENDING:** ${r.keyResult}`,
        '',
        'No performance result is available yet. This requirement must not be marked as Pass or Failed until testing is completed.',
        '',
      )
      return
    }
    lines.push(
      `Judged on ${METRIC_LABEL[r.requirement.metric]}, target ${formatTarget(r.requirement.metric, r.requirement.target)}.`,
      '',
    )
    lines.push(
      mdTable(
        ['Test case', 'Run', 'Requests', 'Success', 'P50', 'P95', 'Slowest', 'Measured', 'Verdict'],
        r.cases.map((c) => [
          c.name,
          c.runLabel,
          c.requests.toLocaleString(),
          pct(c.successRate),
          ms(c.p50),
          ms(c.p95),
          ms(c.max),
          formatMeasured(r.requirement.metric, c.measured),
          c.performance === 'pass' ? 'PASS' : 'FAILED',
        ]),
      ),
      '',
    )
    for (const c of r.cases) {
      lines.push(
        c.stability === 'pass'
          ? `- **PASS — Stability:** all ${c.requests.toLocaleString()} requests returned successfully.`
          : `- **FAILED — Stability:** ${c.failedRequests.toLocaleString()} of ${c.requests.toLocaleString()} requests failed.`,
      )
      lines.push(
        c.performance === 'pass'
          ? `- **PASS — Performance (${c.name}):** ${c.measuredText} met ${formatTarget(r.requirement.metric, r.requirement.target)}.`
          : `- **FAILED — Performance (${c.name}):** ${c.measuredText} did not meet ${formatTarget(r.requirement.metric, r.requirement.target)}.`,
      )
    }
    lines.push('')
  })

  lines.push('## Findings and recommendations', '')
  for (const f of report.findings) lines.push(`- **${PRIORITY_LABEL[f.priority]} — ${f.title}:** ${f.detail}`)
  lines.push('')
  for (const f of report.recommendations) {
    lines.push(`- **${PRIORITY_LABEL[f.priority]} — ${f.title}:** ${f.detail}`)
  }
  lines.push('', `**Final assessment:** ${report.finalAssessment}`, '')

  lines.push('## Data limitations', '')
  for (const l of DATA_LIMITATIONS) lines.push(`- ${l}`)
  lines.push('')

  if (runs.length) {
    lines.push('## Runs in this report', '')
    lines.push(
      mdTable(
        ['Run', 'VUs', 'Duration', 'Requests', 'Errors'],
        runs.map((job) => [
          job.label,
          String(job.loadConfig?.vus ?? '—'),
          job.loadConfig?.duration ?? '—',
          (job.loadResult?.requests ?? 0).toLocaleString(),
          pct(job.loadResult?.failRate ?? 0),
        ]),
      ),
      '',
    )
  }

  return lines.join('\n')
}
