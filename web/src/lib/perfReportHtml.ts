import type { PerfJob } from './api'
import {
  loadConcurrencyChart,
  loadEndpointChart,
  loadErrorsOverTimeChart,
  loadOverTimeChart,
  loadPercentileChart,
  loadPhaseChart,
  loadThroughputChart,
  loadVolumeChart,
  pageApiChart,
  pageMilestoneChart,
  pageRunsChart,
} from './perfCharts'
import {
  assessJob,
  atSeconds,
  bytes,
  gradeLabel,
  hostOf,
  loadExtras,
  ms,
  MEASUREMENT_NOTES,
  pct,
  shortUrl,
  type Assessment,
  type Grade,
} from './perfReport'

/**
 * THE PRINTABLE REPORT — one standalone HTML document per run.
 *
 * This is the single source the PDF and the DOCX are both made from: the server
 * turns this exact string into a PDF (headless Chrome) or a .docx
 * (`html-to-docx`), so the three exports cannot drift apart, and the verdict is
 * the same `assessJob` the screen uses.
 *
 * Deliberately self-contained and light-mode: it is a document that will be
 * printed, attached to a ticket, or opened in Word — none of which inherit the
 * app's theme or its stylesheet. The chart colour roles are declared inline here
 * for exactly that reason.
 *
 * The markup is kept boring on purpose — headings, paragraphs, tables, inline SVG.
 * `html-to-docx` understands that vocabulary; it does not understand flexbox,
 * grid, or CSS variables applied to layout, so the layout uses none of them.
 */

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const GRADE_HEX: Record<Grade, string> = {
  good: '#0ca30c',
  warn: '#b8860b',
  bad: '#d03b3b',
  unknown: '#52514e',
}

function verdictBlock(assessment: Assessment | null): string {
  if (!assessment) return ''
  const color = GRADE_HEX[assessment.grade]
  return `
  <div class="verdict" style="border-color:${color}">
    <p class="verdict-grade" style="color:${color}">${esc(gradeLabel(assessment.grade))}</p>
    <p class="verdict-line">${esc(assessment.headline)}</p>
  </div>`
}

function checksTable(assessment: Assessment | null): string {
  if (!assessment?.checks.length) return ''
  return `
  <table>
    <thead><tr><th>Metric</th><th>Value</th><th>Verdict</th><th>Band</th></tr></thead>
    <tbody>
      ${assessment.checks
        .map(
          (c) => `<tr>
        <td>${esc(c.label)}</td>
        <td class="num">${esc(c.value)}</td>
        <td style="color:${GRADE_HEX[c.grade]}">${esc(c.grade === 'unknown' ? 'For reference' : gradeLabel(c.grade))}</td>
        <td class="muted">${esc(c.note)}</td>
      </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
}

function findingsBlock(assessment: Assessment | null): string {
  if (!assessment) return ''
  if (!assessment.findings.length) return '<p class="muted">Nothing to flag.</p>'
  return assessment.findings
    .map(
      (f) => `<div class="finding">
      <p class="finding-title"><span class="sev sev-${f.severity}">${f.severity}</span> ${esc(f.title)}</p>
      <p class="finding-detail">${esc(f.detail)}</p>
    </div>`,
    )
    .join('')
}

/**
 * `**lead**` → `<strong>`, everything else escaped.
 *
 * The measurement notes are written once, in one string, and rendered to Markdown,
 * HTML, PDF and Word. Duplicating them per format is how two copies of the same
 * sentence end up disagreeing, so the single copy carries the one piece of markup
 * it needs and this unwraps it.
 */
function bold(text: string): string {
  return esc(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

/**
 * Every column after the first is right-aligned as a number, unless it is named in
 * `textColumns`. A prose column ("what it means") right-aligned reads as a column of
 * ragged numbers, which is how a sentence ends up looking like data.
 */
function table(
  headers: string[],
  rows: string[][],
  numeric = true,
  textColumns: number[] = [],
): string {
  const isNum = (i: number) => numeric && i > 0 && !textColumns.includes(i)
  return `
  <table>
    <thead><tr>${headers.map((h, i) => `<th${isNum(i) ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows
      .map((r) => `<tr>${r.map((c, i) => `<td${isNum(i) ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`)
      .join('')}</tbody>
  </table>`
}

const STYLE = `
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1a1a19; font-size: 11px; line-height: 1.5; margin: 0; }
  h1 { font-size: 19px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e4e0; page-break-after: avoid; }
  h3 { font-size: 12px; margin: 14px 0 4px; page-break-after: avoid; }
  svg, .finding, tr { page-break-inside: avoid; }
  p { margin: 0 0 6px; }
  .meta { color: #52514e; font-size: 10.5px; margin-bottom: 14px; }
  .muted { color: #52514e; }
  .num { text-align: right; font-family: "SFMono-Regular", Consolas, monospace; }
  table { width: 100%; border-collapse: collapse; margin: 6px 0 10px; font-size: 10.5px; }
  th { text-align: left; background: #f4f3f0; color: #52514e; font-weight: 600; padding: 5px 7px; border-bottom: 1px solid #e5e4e0; }
  td { padding: 5px 7px; border-bottom: 1px solid #eeede9; vertical-align: top; }
  th.num, td.num { text-align: right; }
  .verdict { border-left: 3px solid #52514e; padding: 8px 12px; background: #faf9f7; margin-bottom: 14px; }
  .verdict-grade { font-size: 13px; font-weight: 700; margin: 0 0 2px; }
  .verdict-line { margin: 0; }
  .finding { border: 1px solid #eeede9; padding: 7px 10px; margin-bottom: 6px; }
  .finding-title { font-weight: 600; margin: 0 0 2px; }
  .finding-detail { color: #52514e; margin: 0; }
  .sev { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; margin-right: 4px; }
  .sev-high { background: #fbe6e6; color: #a12b2b; }
  .sev-medium { background: #fdf0d9; color: #8a6100; }
  .sev-low { background: #f0efec; color: #52514e; }
  .warnbox { border: 1px solid #f0c36d; background: #fdf6e6; padding: 8px 12px; margin-bottom: 14px; }
  ul.notes { margin: 6px 0 10px; padding-left: 18px; }
  ul.notes li { margin-bottom: 4px; color: #52514e; }
  .footer { margin-top: 22px; padding-top: 8px; border-top: 1px solid #e5e4e0; color: #52514e; font-size: 10px; }
  /* Chart roles - the same names perfCharts.ts draws against in the app. */
  .viz-root { --viz-series-1: #2a78d6; --viz-series-2: #eb6834; --viz-series-3: #a24bd8; --viz-series-4: #00a08a; --viz-series-5: #a37500; --viz-good: #0ca30c; --viz-warn: #fab219; --viz-bad: #d03b3b; }
  .viz-root svg.viz { display: block; overflow: visible; margin: 4px 0 2px; }
  .viz-title { fill: #1a1a19; font-size: 12px; font-weight: 600; }
  .viz-sub, .viz-label { fill: #52514e; font-size: 11px; }
  .viz-value { fill: #1a1a19; font-size: 11px; font-family: "SFMono-Regular", Consolas, monospace; }
  .viz-flag { fill: #52514e; font-family: "Helvetica Neue", Arial, sans-serif; }
  .viz-ref { stroke: #52514e; stroke-width: 1; stroke-dasharray: 3 3; }
  .viz-grid { stroke: #e5e4e0; stroke-width: 1; }
  .viz-axis { fill: #52514e; font-size: 10px; font-family: "SFMono-Regular", Consolas, monospace; }
  .viz-line { fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .viz-legend { color: #52514e; font-size: 10.5px; margin-bottom: 10px; }
  .viz-legend span { margin-right: 14px; }
  .viz-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; }
`

/** The whole report as one standalone HTML document. */
export function reportHtml(job: PerfJob): string {
  const assessment = assessJob(job)
  const when = new Date(job.createdAt).toLocaleString()
  const body: string[] = []

  if (job.kind === 'page' && job.pageResult) {
    const r = job.pageResult
    const cfg = job.pageConfig
    body.push(`<h1>Page load report</h1>`)
    body.push(`<p class="meta">${esc(r.url)}<br>${esc(when)} · ${r.runs} load${r.runs === 1 ? '' : 's'} · ${cfg?.settleMs ?? 0}ms settle window · ${cfg?.useProfile === false ? 'clean browser' : 'logged-in profile'}</p>`)
    if (r.redirected) {
      body.push(
        `<div class="warnbox"><strong>The browser was redirected to ${esc(r.finalUrl)}.</strong> Everything below describes that page, not the URL requested.</div>`,
      )
    }
    body.push(verdictBlock(assessment))
    body.push('<h2>Verdict by metric</h2>', checksTable(assessment))
    body.push('<h2>What the user waits for</h2>', `<div class="viz-root">${pageMilestoneChart(r, false)}</div>`)
    const runs = pageRunsChart(r, false)
    if (runs) body.push('<h3>Load time per run</h3>', `<div class="viz-root">${runs}</div>`)
    body.push(
      '<h2>Page in numbers</h2>',
      table(
        ['Metric', 'Value'],
        [
          ['Page load (average)', ms(r.average.loadMs)],
          ['Per load', r.perRun.map((x) => ms(x.loadMs)).join(' · ')],
          ['TTFB', ms(r.average.ttfbMs)],
          ['DOM ready', ms(r.average.domContentLoadedMs)],
          ['First paint (FCP)', ms(r.average.fcpMs)],
          ['Main content (LCP)', ms(r.average.lcpMs)],
          ['Requests per load', r.average.requestCount.toFixed(1)],
          ['API calls per load', (r.totals.apiCount / r.runs).toFixed(1)],
          ['Transferred per load', bytes(r.average.transferBytes)],
          ['Slowest API call', ms(r.totals.slowestApiMs)],
        ],
      ),
    )
    const apiChart = pageApiChart(r, false)
    if (apiChart) body.push('<h2>Slowest API calls</h2>', `<div class="viz-root">${apiChart}</div>`)
    if (r.duplicates.length) {
      body.push(
        '<h2>Duplicate API calls</h2>',
        `<p class="muted">An endpoint called more than once per load is doing the same work twice.</p>`,
        table(
          ['Endpoint', 'Per load', 'Avg', 'Total per load'],
          r.duplicates.map((d) => [
            `${esc(d.method)} ${esc(shortUrl(d.endpoint))}`,
            `${d.perLoad.toFixed(1)}×`,
            ms(d.avgMs),
            ms(d.totalMsPerLoad),
          ]),
        ),
      )
    }
    body.push('<h2>What to look at</h2>', findingsBlock(assessment))
    const api = r.requests.filter((x) => x.api).slice(0, 40)
    if (api.length) {
      body.push(
        `<h2>API calls${r.requests.filter((x) => x.api).length > 40 ? ' (top 40)' : ''}</h2>`,
        table(
          ['Request', 'Per load', 'Avg', 'Slowest', 'TTFB', 'Size', 'Status'],
          api.map((x) => [
            `${esc(x.method)} ${esc(shortUrl(x.url))}`,
            `${x.perLoad.toFixed(1)}×`,
            ms(x.avgMs),
            ms(x.maxMs),
            ms(x.avgWaitMs),
            bytes(x.avgBytes),
            String(x.status ?? '—'),
          ]),
        ),
      )
    }
  }

  if (job.kind === 'load' && job.loadResult) {
    const r = job.loadResult
    const cfg = job.loadConfig
    body.push(`<h1>API load test — ${esc(job.label)}</h1>`)
    body.push(
      `<p class="meta">${esc(when)} · ${cfg?.vus ?? '?'} virtual users${cfg?.rampUp ? ` (ramp ${esc(cfg.rampUp)})` : ''} for ${esc(cfg?.duration ?? '?')} · ${cfg?.endpoints.length ?? 0} endpoint${cfg?.endpoints.length === 1 ? '' : 's'}${cfg?.thresholdP95Ms ? ` · target p95 ≤ ${ms(cfg.thresholdP95Ms)}` : ''}</p>`,
    )
    body.push(verdictBlock(assessment))
    body.push('<h2>Verdict by metric</h2>', checksTable(assessment))
    body.push(
      '<h2>Response times</h2>',
      `<div class="viz-root">${loadPercentileChart(r, cfg?.thresholdP95Ms ?? 0, false)}</div>`,
    )
    const extra = loadExtras(r)
    const seconds = r.durationMs > 0 ? r.durationMs / 1000 : 0
    body.push(
      '<h2>Run in numbers</h2>',
      table(
        ['Metric', 'Value'],
        [
          ['Requests', `${r.requests.toLocaleString()} over ${ms(r.durationMs)}`],
          ['Failed requests', `${r.failedRequests.toLocaleString()} (${pct(r.failRate)})`],
          ['Throughput (average)', `${r.requestsPerSecond.toFixed(1)}/s`],
          ...(extra.peakRps > 0
            ? [['Throughput (peak)', `${extra.peakRps.toFixed(1)}/s at ${atSeconds(extra.peakAtSeconds)}`]]
            : []),
          ['Min / median / average', `${ms(r.overall.min)} / ${ms(r.overall.med)} / ${ms(r.overall.avg)}`],
          ['p90 / p95 / p99', `${ms(r.overall.p90)} / ${ms(r.overall.p95)} / ${ms(r.overall.p99)}`],
          ['Slowest', ms(r.overall.max)],
          ['TTFB (average)', ms(r.waiting.avg)],
          [
            'Iterations',
            `${r.iterations.toLocaleString()} · ${ms(r.iterationDuration.avg)} each${r.droppedIterations ? ` · <strong>${r.droppedIterations.toLocaleString()} dropped</strong>` : ''}`,
          ],
          ['Peak virtual users', r.vusMax ? String(r.vusMax) : '—'],
          ['Checks', `${r.checksPassed.toLocaleString()} passed${r.checksFailed ? `, ${r.checksFailed.toLocaleString()} failed` : ''}`],
          [
            'Data received / sent',
            `${bytes(r.dataReceived)} / ${bytes(r.dataSent)}${extra.bytesPerSecond > 0 ? ` (${bytes(extra.bytesPerSecond)}/s)` : ''}`,
          ],
        ],
      ),
    )

    const timeChart = loadOverTimeChart(r, cfg?.thresholdP95Ms ?? 0, false)
    if (timeChart) {
      body.push(
        '<h2>Across the run</h2>',
        `<p class="muted">A blended p95 cannot tell &ldquo;slow&rdquo; from &ldquo;getting slower&rdquo;.</p>`,
        `<div class="viz-root">${timeChart}</div>`,
      )
      const tp = loadThroughputChart(r, false)
      if (tp) body.push('<h3>Throughput</h3>', `<div class="viz-root">${tp}</div>`)
      const vus = loadConcurrencyChart(r, false)
      if (vus) body.push('<h3>Load applied</h3>', `<div class="viz-root">${vus}</div>`)
      const errs = loadErrorsOverTimeChart(r, false)
      if (errs) body.push('<h3>Errors</h3>', `<div class="viz-root">${errs}</div>`)
      body.push(
        table(
          ['At', 'Requests/s', 'Avg', 'p95', 'Slowest', 'Errors', 'VUs'],
          r.buckets.map((b) => [
            atSeconds(b.atSeconds),
            `${b.rps.toFixed(1)}/s`,
            ms(b.avgMs),
            ms(b.p95Ms),
            ms(b.maxMs),
            pct(b.failRate),
            b.vus.toFixed(0),
          ]),
        ),
      )
    }

    const phaseChart = loadPhaseChart(r, false)
    if (phaseChart && r.phases) {
      const setup = r.phases.connecting.avg + r.phases.tlsHandshaking.avg
      const total = r.overall.avg || 1
      body.push(
        '<h2>Where the time goes</h2>',
        `<p class="muted">An average request took ${esc(ms(r.overall.avg))}. Which phase dominates decides what to chase.</p>`,
        `<div class="viz-root">${phaseChart}</div>`,
        table(
          ['Phase', 'Average', 'Share', 'What it means'],
          [
            ['Waiting on the server', ms(r.phases.waiting.avg), pct(r.phases.waiting.avg / total), 'the server producing the response'],
            ['Receiving the response', ms(r.phases.receiving.avg), pct(r.phases.receiving.avg / total), 'payload size and the network'],
            ['Sending the request', ms(r.phases.sending.avg), pct(r.phases.sending.avg / total), 'request body upload'],
            ['Connect + TLS', ms(setup), pct(setup / total), 'connections not being reused'],
            ['Blocked (client)', ms(r.phases.blocked.avg), pct(r.phases.blocked.avg / total), 'the load generator queueing against itself'],
          ],
          true,
          [3],
        ),
      )
    }

    const epChart = loadEndpointChart(r, false)
    if (epChart) body.push('<h2>Per endpoint</h2>', `<div class="viz-root">${epChart}</div>`)
    const volChart = loadVolumeChart(r, false)
    if (volChart) body.push(epChart ? '<h3>Calls per endpoint</h3>' : '<h2>Per endpoint</h2>', `<div class="viz-root">${volChart}</div>`)
    body.push(
      epChart || volChart ? '' : '<h2>Per endpoint</h2>',
      table(
        ['Endpoint', 'Calls', 'Req/s', 'OK', 'Failed', 'Avg', 'p90', 'p95', 'p99', 'Slowest', 'TTFB', 'Size'],
        r.endpoints.map((e) => [
          `${esc(e.method)} ${esc(e.name)}<br><span class="muted">${esc(hostOf(e.url))}${esc(shortUrl(e.url))}</span>`,
          e.calls.toLocaleString(),
          seconds > 0 ? (e.calls / seconds).toFixed(1) : '—',
          pct(e.okRate),
          Math.round(e.calls * (1 - e.okRate)).toLocaleString(),
          ms(e.duration.avg),
          ms(e.duration.p90),
          ms(e.duration.p95),
          ms(e.duration.p99),
          ms(e.duration.max),
          ms(e.waiting.avg),
          bytes(e.avgBytes),
        ]),
      ),
    )
    body.push('<h2>What to look at</h2>', findingsBlock(assessment))
    body.push(
      '<h2>How to read these numbers</h2>',
      `<ul class="notes">${MEASUREMENT_NOTES.map((n) => `<li>${bold(n)}</li>`).join('')}</ul>`,
    )
  }

  body.push(
    `<p class="footer">Generated by QC Portal · Performance · ${esc(new Date().toLocaleString())}</p>`,
  )

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(job.kind === 'page' ? `Page load — ${job.label}` : `Load test — ${job.label}`)}</title>
<style>${STYLE}</style></head>
<body>${body.join('\n')}</body></html>`
}
