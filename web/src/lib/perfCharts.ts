import type { LoadTestResult, PageAuditResult } from './api'
import {
  formatTarget,
  isRateMetric,
  METRIC_LABEL,
  type NfrRequirementResult,
} from './nfrReport'
import { atSeconds, ms } from './perfReport'

/**
 * PERFORMANCE CHARTS — plain SVG strings, no charting library.
 *
 * They are STRINGS rather than React components on purpose: the exact same chart
 * has to render in three places — the page, the exported HTML→PDF, and the DOCX —
 * and the only way those can never disagree is if one function draws all three.
 * The page injects the string; the export embeds it in a standalone document.
 *
 * Colour comes from CSS custom properties (`--viz-*`, defined once in `index.css`
 * for the app and inline in the exported document), so the app's dark theme swaps
 * palettes without the chart code knowing, and the export always prints light.
 * The two series hues are the validated categorical slots 1 and 2 (blue #2a78d6 /
 * orange #eb6834 light, #3987e5 / #d95926 dark) — checked with the palette
 * validator: worst adjacent CVD ΔE 24.7 light, 26.8 dark, both well clear of the
 * ≥8 gate, and every bar carries a text value beside it so nothing rests on hue.
 *
 * Marks follow the house spec: bars ≤24px with a 4px rounded data-end, hairline
 * recessive gridlines, no border strokes, a 2px surface gap between the segments
 * of a stacked bar. Every bar carries a `<title>` so hovering gives the exact
 * number in the app and in the PDF viewer alike, and the tables below every chart
 * are the accessible view of the same data.
 */

// -------------------------------------------------------------- primitives

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** A bar with a rounded data-end and a square baseline end (house mark spec). */
function barPath(x: number, y: number, w: number, h: number, r = 4): string {
  const radius = Math.max(0, Math.min(r, w))
  if (w <= radius) return `M${x} ${y}h${w}v${h}h${-w}z`
  return [
    `M${x} ${y}`,
    `h${w - radius}`,
    `a${radius} ${radius} 0 0 1 ${radius} ${radius}`,
    `v${h - radius * 2}`,
    `a${radius} ${radius} 0 0 1 ${-radius} ${radius}`,
    `h${-(w - radius)}`,
    'z',
  ].join('')
}

export interface BarRow {
  label: string
  value: number
  /** Formatted value drawn at the end of the bar. */
  display: string
  /** Which `--viz-*` colour role the bar wears. */
  tone?: 'series' | 'good' | 'warn' | 'bad'
  /** A word carried beside the value, so meaning never rests on colour alone. */
  flag?: string
  /** Optional first segment (e.g. server think-time inside a total duration). */
  segment?: { value: number; label: string }
}

const TONE_VAR: Record<NonNullable<BarRow['tone']>, string> = {
  series: 'var(--viz-series-1)',
  good: 'var(--viz-good)',
  warn: 'var(--viz-warn)',
  bad: 'var(--viz-bad)',
}

/**
 * Horizontal bars — the form for "compare magnitude across a handful of named
 * things" when the names are long, which every URL is.
 */
export function barChart(
  rows: BarRow[],
  opts: { title: string; subtitle?: string; labelWidth?: number; reference?: { value: number; label: string } } = {
    title: '',
  },
): string {
  if (!rows.length) return ''
  const labelW = opts.labelWidth ?? 190
  // The value gutter is sized to the longest label that will actually be drawn.
  // Fixed at 76px it fits "1.24s" and clips "15,239 (33%) 15,239 failed" straight
  // off the edge of the chart — and the bar that overflows is always the longest
  // one, i.e. the row the reader came for.
  const valueW = Math.max(
    76,
    Math.min(
      260,
      Math.ceil(Math.max(...rows.map((r) => `${r.display}${r.flag ? ` ${r.flag}` : ''}`.length)) * 6.2),
    ),
  )
  const rowH = 26
  const barH = 14
  const width = 720
  // With no title the subtitle takes the top line: the exported document puts the
  // chart under an <h2> that already names it, and printing it twice reads as a bug.
  const hasTitle = !!opts.title
  const top = hasTitle ? (opts.subtitle ? 46 : 30) : opts.subtitle ? 26 : 10
  const plotW = width - labelW - valueW - 16
  // The reference label sits UNDER the plot: on the top line it lands beside the
  // subtitle and the two collide, which is the one label rule that always bites.
  const height = top + rows.length * rowH + (opts.reference ? 26 : 12)
  const max = Math.max(...rows.map((r) => Math.max(r.value, opts.reference?.value ?? 0)), 1)
  const scale = (v: number) => Math.max(v > 0 ? 2 : 0, (v / max) * plotW)

  const parts: string[] = []
  parts.push(
    `<svg class="viz" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(opts.title)}" xmlns="http://www.w3.org/2000/svg">`,
  )
  if (hasTitle) parts.push(`<text x="0" y="14" class="viz-title">${esc(opts.title)}</text>`)
  if (opts.subtitle) {
    parts.push(`<text x="0" y="${hasTitle ? 32 : 12}" class="viz-sub">${esc(opts.subtitle)}</text>`)
  }

  rows.forEach((r, i) => {
    const y = top + i * rowH
    const w = scale(r.value)
    const fill = TONE_VAR[r.tone ?? 'series']
    parts.push(
      `<text x="0" y="${y + barH - 2}" class="viz-label">${esc(r.label.length > 34 ? `${r.label.slice(0, 33)}…` : r.label)}</text>`,
    )
    parts.push(`<g><title>${esc(`${r.label} — ${r.display}`)}</title>`)
    if (r.segment && r.segment.value > 0 && r.value > 0) {
      // Two segments with a 2px surface gap: the split IS the finding (server
      // think-time versus everything else), so it gets the second series hue.
      const segW = Math.max(2, Math.min(w, (r.segment.value / r.value) * w))
      const restW = Math.max(0, w - segW - 2)
      parts.push(`<path d="${barPath(labelW, y, segW, barH, 0)}" fill="var(--viz-series-2)"/>`)
      if (restW > 0) parts.push(`<path d="${barPath(labelW + segW + 2, y, restW, barH)}" fill="${fill}"/>`)
    } else {
      parts.push(`<path d="${barPath(labelW, y, w, barH)}" fill="${fill}"/>`)
    }
    parts.push('</g>')
    parts.push(
      `<text x="${labelW + w + 8}" y="${y + barH - 2}" class="viz-value">${esc(r.display)}${r.flag ? ` <tspan class="viz-flag">${esc(r.flag)}</tspan>` : ''}</text>`,
    )
  })

  if (opts.reference && opts.reference.value > 0) {
    const x = labelW + scale(opts.reference.value)
    const bottom = top + rows.length * rowH - 4
    parts.push(
      `<line x1="${x}" y1="${top - 6}" x2="${x}" y2="${bottom}" class="viz-ref"/>`,
      `<text x="${x + 4}" y="${bottom + 14}" class="viz-sub">${esc(opts.reference.label)}</text>`,
    )
  }
  parts.push('</svg>')
  return parts.join('')
}

/** The two-hue legend, only drawn where a second series is actually on screen. */
function legend(items: { color: string; label: string }[]): string {
  return `<div class="viz-legend">${items
    .map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)}</span>`)
    .join('')}</div>`
}

// -------------------------------------------------------------- page audit

/** Milestones of one page load, in the order the user experiences them. */
export function pageMilestoneChart(result: PageAuditResult, showTitle = true): string {
  const a = result.average
  const rows: BarRow[] = ([
    { label: 'TTFB', value: a.ttfbMs, display: ms(a.ttfbMs), tone: a.ttfbMs > 1800 ? 'bad' : a.ttfbMs > 800 ? 'warn' : 'series' },
    { label: 'First paint (FCP)', value: a.fcpMs, display: ms(a.fcpMs), tone: a.fcpMs > 3000 ? 'bad' : a.fcpMs > 1800 ? 'warn' : 'series' },
    { label: 'DOM ready', value: a.domContentLoadedMs, display: ms(a.domContentLoadedMs) },
    { label: 'Load event', value: a.loadMs, display: ms(a.loadMs), tone: a.loadMs > 5000 ? 'bad' : a.loadMs > 2500 ? 'warn' : 'series' },
    { label: 'Main content (LCP)', value: a.lcpMs, display: ms(a.lcpMs), tone: a.lcpMs > 4000 ? 'bad' : a.lcpMs > 2500 ? 'warn' : 'series' },
  ] as BarRow[]).filter((r) => r.value > 0)
  // Name the band in words on any bar that is not green: colour never carries it.
  for (const r of rows) {
    if (r.tone === 'warn') r.flag = 'slow'
    if (r.tone === 'bad') r.flag = 'poor'
  }
  return barChart(rows, {
    title: showTitle ? 'What the user waits for' : '',
    subtitle: `average of ${result.runs} load${result.runs === 1 ? '' : 's'}`,
    labelWidth: 150,
  })
}

/** Per-run load times — a single slow run must stay visible, not average away. */
export function pageRunsChart(result: PageAuditResult, showTitle = true): string {
  if (result.perRun.length < 2) return ''
  const rows: BarRow[] = result.perRun.map((r, i) => ({
    label: `Load ${i + 1}`,
    value: r.loadMs,
    display: ms(r.loadMs),
  }))
  return barChart(rows, {
    title: showTitle ? 'Load time per run' : '',
    subtitle: 'the first load is cold — a warm load is the one users usually get',
    labelWidth: 80,
  })
}

/** The slowest API calls, split into server think-time and everything else. */
export function pageApiChart(result: PageAuditResult, showTitle = true): string {
  const api = result.requests
    .filter((r) => r.api && r.avgMs > 0)
    .sort((x, y) => y.avgMs - x.avgMs)
    .slice(0, 8)
  if (!api.length) return ''
  const rows: BarRow[] = api.map((r) => {
    const path = (() => {
      try {
        return new URL(r.url).pathname
      } catch {
        return r.url
      }
    })()
    return {
      label: `${r.method} ${path}`,
      value: r.avgMs,
      display: ms(r.avgMs),
      tone: r.avgMs >= 3000 ? 'bad' : r.avgMs >= 1000 ? 'warn' : 'series',
      flag: r.perLoad >= 2 ? `${r.perLoad.toFixed(1)}× per load` : undefined,
      segment: { value: r.avgWaitMs, label: 'server think-time' },
    }
  })
  return (
    barChart(rows, {
      title: showTitle ? 'Slowest API calls' : '',
      subtitle: 'average per call',
      labelWidth: 240,
    }) +
    legend([
      { color: 'var(--viz-series-2)', label: 'waiting on the server (TTFB)' },
      { color: 'var(--viz-series-1)', label: 'receiving the response' },
    ])
  )
}

// -------------------------------------------------------------- load test

/** The percentile ladder, against the engineer's own p95 target. */
export function loadPercentileChart(
  result: LoadTestResult,
  thresholdP95Ms = 0,
  showTitle = true,
): string {
  const o = result.overall
  const rows: BarRow[] = ([
    { label: 'Median', value: o.med, display: ms(o.med) },
    { label: 'p90', value: o.p90, display: ms(o.p90) },
    {
      label: 'p95',
      value: o.p95,
      display: ms(o.p95),
      tone: thresholdP95Ms > 0 && o.p95 > thresholdP95Ms ? 'bad' : 'series',
      flag: thresholdP95Ms > 0 && o.p95 > thresholdP95Ms ? 'over target' : undefined,
    },
    { label: 'p99', value: o.p99, display: ms(o.p99) },
    { label: 'Slowest', value: o.max, display: ms(o.max) },
  ] as BarRow[]).filter((r) => r.value > 0)
  return barChart(rows, {
    title: showTitle ? 'Response time distribution' : '',
    subtitle: 'how slow the slow calls got',
    labelWidth: 90,
    reference: thresholdP95Ms > 0 ? { value: thresholdP95Ms, label: `target ${ms(thresholdP95Ms)}` } : undefined,
  })
}

/** p95 per endpoint, split into server think-time and everything else. */
export function loadEndpointChart(result: LoadTestResult, showTitle = true): string {
  const rows: BarRow[] = [...result.endpoints]
    .sort((a, b) => b.duration.p95 - a.duration.p95)
    .slice(0, 12)
    .map((e) => ({
      label: e.name,
      value: e.duration.p95,
      display: ms(e.duration.p95),
      tone: e.okRate < 1 ? 'bad' : 'series',
      flag: e.okRate < 1 ? 'errors' : undefined,
      segment: { value: e.waiting.avg, label: 'server think-time' },
    }))
  if (rows.length < 2) return ''
  return (
    barChart(rows, {
      title: showTitle ? 'p95 per endpoint' : '',
      subtitle: 'the slowest endpoint is the bottleneck',
      labelWidth: 200,
    }) +
    legend([
      { color: 'var(--viz-series-2)', label: 'waiting on the server (TTFB avg)' },
      { color: 'var(--viz-series-1)', label: 'rest of the p95' },
    ])
  )
}

// -------------------------------------------------------------- NFR report

/**
 * One requirement's test cases against its target.
 *
 * The target is drawn as the reference line, so "how far outside" is the thing the
 * eye reads first — which is the question the client asks about a failed NFR. Bars
 * are toned by the case's own verdict and carry the words "met"/"over target", so
 * the pass/fail never rests on the colour: this chart is read in print and in
 * Word, where a reader may have no colour at all.
 */
export function nfrRequirementChart(
  result: NfrRequirementResult,
  showTitle = true,
): string {
  const { requirement, cases } = result
  if (!cases.length) return ''
  const rate = isRateMetric(requirement.metric)
  // Rates live on 0–1, which a bar chart scaled to a 3000ms target cannot draw, so
  // they are plotted as percentages — the same numbers the tables show.
  const toPlot = (value: number) => (rate ? value * 100 : value)

  const rows: BarRow[] = cases.map((c) => ({
    label: cases.length > 1 && c.runLabel ? `${c.name} · ${c.runLabel}` : c.name,
    value: toPlot(c.measured),
    display: c.measuredText,
    tone: c.performance === 'pass' ? 'good' : 'bad',
    flag: c.performance === 'pass' ? 'met' : 'over target',
  }))

  return barChart(rows, {
    title: showTitle ? `${requirement.id} — ${METRIC_LABEL[requirement.metric]}` : '',
    // NOT the target — the reference line below the plot already names it, and
    // printing it twice on one chart reads as a bug.
    subtitle: `${METRIC_LABEL[requirement.metric].toLowerCase()} per test case`,
    labelWidth: 230,
    reference: {
      value: toPlot(requirement.target),
      label: `target ${formatTarget(requirement.metric, requirement.target)}`,
    },
  })
}

// -------------------------------------------------------------- line chart

export interface LinePoint {
  x: number
  y: number
  /** Formatted y, shown on hover and on the direct labels. */
  display: string
}

export interface LineSeries {
  name: string
  /** A `--viz-*` colour role, e.g. `var(--viz-series-1)`. */
  color: string
  points: LinePoint[]
}

/**
 * Lines over a numeric x axis — the form for change-over-time, and the only chart
 * here that can answer "did it get WORSE as the load arrived?".
 *
 * Strictly ONE y axis: two measures of different scale (response time and
 * requests/second, say) get two charts stacked as small multiples, never a second
 * axis — a dual-axis chart lets the author decide which line looks higher.
 *
 * Markers are drawn only when the series is sparse enough for them to be hit
 * targets rather than noise; the peak of every series is always marked and
 * directly labelled, because the peak is the number that ends up in the ticket.
 */
export function lineChart(
  series: LineSeries[],
  opts: {
    title: string
    subtitle?: string
    yFormat: (value: number) => string
    xFormat: (value: number) => string
    /** Fill under the line — only legible with a single series. */
    area?: boolean
    reference?: { value: number; label: string }
  },
): string {
  const live = series.filter((s) => s.points.length > 0)
  if (!live.length) return ''
  // One point is not a trend; drawing a lone dot across a time axis invites the
  // reader to see a flat line that was never measured.
  if (live.every((s) => s.points.length < 2)) return ''

  const width = 720
  const gutter = 54
  const rightPad = 74
  const plotH = 148
  const hasTitle = !!opts.title
  const top = hasTitle ? (opts.subtitle ? 46 : 30) : opts.subtitle ? 26 : 10
  const plotW = width - gutter - rightPad
  const height = top + plotH + 26

  const xs = live.flatMap((s) => s.points.map((p) => p.x))
  const ys = live.flatMap((s) => s.points.map((p) => p.y))
  const xMin = Math.min(...xs)
  const xMax = Math.max(...xs)
  const yMax = Math.max(...ys, opts.reference?.value ?? 0, 1) * 1.08
  const px = (x: number) => gutter + (xMax === xMin ? plotW : ((x - xMin) / (xMax - xMin)) * plotW)
  const py = (y: number) => top + plotH - (y / yMax) * plotH

  const parts: string[] = [
    `<svg class="viz" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(opts.title || opts.subtitle || 'chart')}" xmlns="http://www.w3.org/2000/svg">`,
  ]
  if (hasTitle) parts.push(`<text x="0" y="14" class="viz-title">${esc(opts.title)}</text>`)
  if (opts.subtitle) {
    parts.push(`<text x="0" y="${hasTitle ? 32 : 12}" class="viz-sub">${esc(opts.subtitle)}</text>`)
  }

  // Recessive gridlines, labelled on the left. Three is enough to read a level off
  // without the grid competing with the data.
  for (const frac of [0, 0.5, 1]) {
    const y = top + plotH - frac * plotH
    parts.push(`<line x1="${gutter}" y1="${y}" x2="${gutter + plotW}" y2="${y}" class="viz-grid"/>`)
    // The baseline is labelled "0", not run through the value formatter: `ms()`
    // renders zero as an em dash, which is right for "not measured" in a table and
    // wrong for the origin of an axis.
    parts.push(
      `<text x="${gutter - 6}" y="${y + 3}" class="viz-axis" text-anchor="end">${esc(frac === 0 ? '0' : opts.yFormat(yMax * frac))}</text>`,
    )
  }

  if (opts.reference && opts.reference.value > 0 && opts.reference.value <= yMax) {
    const y = py(opts.reference.value)
    parts.push(
      `<line x1="${gutter}" y1="${y}" x2="${gutter + plotW}" y2="${y}" class="viz-ref"/>`,
      `<text x="${gutter + plotW + 4}" y="${y + 3}" class="viz-sub">${esc(opts.reference.label)}</text>`,
    )
  }

  // x labels at both ends and the middle — a time axis needs orientation, not ticks.
  const xTicks = xMax === xMin ? [xMin] : [xMin, (xMin + xMax) / 2, xMax]
  xTicks.forEach((x, i) => {
    parts.push(
      `<text x="${px(x)}" y="${top + plotH + 16}" class="viz-axis" text-anchor="${i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}">${esc(opts.xFormat(x))}</text>`,
    )
  })

  const endLabels: { y: number; text: string }[] = []
  for (const s of live) {
    const pts = [...s.points].sort((a, b) => a.x - b.x)
    const d = pts.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' ')
    if (opts.area && live.length === 1) {
      parts.push(
        `<polygon points="${px(pts[0].x).toFixed(1)},${top + plotH} ${d} ${px(pts[pts.length - 1].x).toFixed(1)},${top + plotH}" fill="${s.color}" opacity="0.12"/>`,
      )
    }
    parts.push(`<polyline points="${d}" class="viz-line" stroke="${s.color}"/>`)

    const marked = pts.length <= 20 ? pts : []
    for (const p of marked) {
      parts.push(
        `<circle cx="${px(p.x).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="4" fill="${s.color}"><title>${esc(`${s.name} · ${opts.xFormat(p.x)} — ${p.display}`)}</title></circle>`,
      )
    }
    // The peak is always marked and labelled: on a dense series it is the one point
    // the reader is looking for, and it must not depend on hovering to find.
    const peak = pts.reduce((a, b) => (b.y > a.y ? b : a))
    if (!marked.length) {
      parts.push(
        `<circle cx="${px(peak.x).toFixed(1)}" cy="${py(peak.y).toFixed(1)}" r="4" fill="${s.color}"><title>${esc(`${s.name} peak · ${opts.xFormat(peak.x)} — ${peak.display}`)}</title></circle>`,
      )
    }
    const last = pts[pts.length - 1]
    endLabels.push({ y: py(last.y), text: last.display })
  }

  // Two series that finish at nearly the same value would print their end labels on
  // top of each other — which is exactly what happens when a run is healthy and the
  // average and the p95 converge. Push them apart instead of overprinting.
  endLabels.sort((a, b) => a.y - b.y)
  const minGap = 13
  for (let i = 1; i < endLabels.length; i += 1) {
    const gap = endLabels[i].y - endLabels[i - 1].y
    if (gap < minGap) endLabels[i].y = endLabels[i - 1].y + minGap
  }
  for (const label of endLabels) {
    parts.push(
      `<text x="${gutter + plotW + 6}" y="${label.y + 3}" class="viz-value">${esc(label.text)}</text>`,
    )
  }

  parts.push('</svg>')
  const box = parts.join('')
  return live.length > 1
    ? box + legend(live.map((s) => ({ color: s.color, label: s.name })))
    : box
}

// ------------------------------------------------------- stacked single row

export interface StackSegment {
  label: string
  value: number
  display: string
  color: string
}

/**
 * One horizontal bar cut into named parts — "what is this total made of?".
 *
 * Every segment carries its value in the legend, so a reader with no colour (print,
 * Word on a mono printer, a CVD reader) still gets the whole finding from the text.
 * Segments below ~1.5% of the total are folded away rather than drawn as a sliver
 * that cannot be seen or hovered.
 */
export function stackedRowChart(
  segments: StackSegment[],
  opts: { title: string; subtitle?: string },
): string {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0)
  if (total <= 0) return ''
  const shown = segments.filter((s) => s.value / total >= 0.015)
  if (!shown.length) return ''

  const width = 720
  const barH = 26
  const hasTitle = !!opts.title
  const top = hasTitle ? (opts.subtitle ? 46 : 30) : opts.subtitle ? 26 : 10
  const height = top + barH + 8
  const shownTotal = shown.reduce((sum, s) => sum + s.value, 0)

  const parts: string[] = [
    `<svg class="viz" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${esc(opts.title || 'breakdown')}" xmlns="http://www.w3.org/2000/svg">`,
  ]
  if (hasTitle) parts.push(`<text x="0" y="14" class="viz-title">${esc(opts.title)}</text>`)
  if (opts.subtitle) {
    parts.push(`<text x="0" y="${hasTitle ? 32 : 12}" class="viz-sub">${esc(opts.subtitle)}</text>`)
  }

  let x = 0
  shown.forEach((s, i) => {
    const gap = i === shown.length - 1 ? 0 : 2
    const w = Math.max(2, (s.value / shownTotal) * width - gap)
    const share = s.value / total
    parts.push(
      `<g><title>${esc(`${s.label} — ${s.display} (${(share * 100).toFixed(1)}%)`)}</title>`,
      `<path d="${barPath(x, top, w, barH, i === shown.length - 1 ? 4 : 0)}" fill="${s.color}"/>`,
    )
    // A percentage inside the segment only when it fits without truncation.
    if (w >= 44) {
      parts.push(
        `<text x="${x + w / 2}" y="${top + barH / 2 + 4}" text-anchor="middle" style="fill:#ffffff;font-size:11px;font-weight:600">${(share * 100).toFixed(0)}%</text>`,
      )
    }
    parts.push('</g>')
    x += w + gap
  })
  parts.push('</svg>')

  return (
    parts.join('') +
    legend(segments.map((s) => ({ color: s.color, label: `${s.label} · ${s.display}` })))
  )
}

// ------------------------------------------------- load test — over time

/**
 * Response time across the run — the chart the summary tables cannot replace.
 *
 * A pass/fail on a blended p95 hides the shape: an endpoint that answers in 200ms
 * for the first minute and 4s for the last one can average out to a healthy
 * number. Median and p95 are drawn together because the GAP between them is the
 * finding — a p95 that climbs while the median stays flat is a queue forming, not
 * a uniformly slower system.
 */
export function loadOverTimeChart(
  result: LoadTestResult,
  thresholdP95Ms = 0,
  showTitle = true,
): string {
  const buckets = result.buckets ?? []
  if (buckets.length < 2) return ''
  return lineChart(
    [
      {
        name: 'p95',
        color: 'var(--viz-series-2)',
        points: buckets.map((b) => ({ x: b.atSeconds, y: b.p95Ms, display: ms(b.p95Ms) })),
      },
      {
        name: 'average',
        color: 'var(--viz-series-1)',
        points: buckets.map((b) => ({ x: b.atSeconds, y: b.avgMs, display: ms(b.avgMs) })),
      },
    ],
    {
      title: showTitle ? 'Response time across the run' : '',
      subtitle: `sampled every ${atSeconds(result.bucketSeconds || 1)} · a p95 that climbs away from the average is a queue forming`,
      yFormat: (v) => ms(v),
      xFormat: atSeconds,
      reference:
        thresholdP95Ms > 0 ? { value: thresholdP95Ms, label: `target ${ms(thresholdP95Ms)}` } : undefined,
    },
  )
}

/**
 * Throughput across the run. Separate chart from the response times on purpose —
 * requests/second and milliseconds do not share a scale, and a second y axis would
 * let the drawing decide which line looks higher.
 */
export function loadThroughputChart(result: LoadTestResult, showTitle = true): string {
  const buckets = result.buckets ?? []
  if (buckets.length < 2) return ''
  return lineChart(
    [
      {
        name: 'requests/s',
        color: 'var(--viz-series-4)',
        points: buckets.map((b) => ({ x: b.atSeconds, y: b.rps, display: `${b.rps.toFixed(1)}/s` })),
      },
    ],
    {
      title: showTitle ? 'Throughput across the run' : '',
      subtitle: 'requests completed per second · flattening while load rises is saturation',
      yFormat: (v) => `${v.toFixed(v >= 100 ? 0 : 1)}/s`,
      xFormat: atSeconds,
      area: true,
    },
  )
}

/**
 * Virtual users actually running. Only drawn for a ramped test: at a flat VU count
 * it is a horizontal line that says nothing the header did not already say.
 *
 * It matters beside the throughput chart because it is the control variable —
 * throughput rising during a ramp is the load arriving, not the system improving.
 */
export function loadConcurrencyChart(result: LoadTestResult, showTitle = true): string {
  const buckets = result.buckets ?? []
  if (buckets.length < 2) return ''
  const vus = buckets.map((b) => b.vus)
  const spread = Math.max(...vus) - Math.min(...vus)
  if (spread < 1) return ''
  return lineChart(
    [
      {
        name: 'virtual users',
        color: 'var(--viz-series-3)',
        points: buckets.map((b) => ({
          x: b.atSeconds,
          y: b.vus,
          display: `${b.vus.toFixed(0)} ${b.vus.toFixed(0) === '1' ? 'VU' : 'VUs'}`,
        })),
      },
    ],
    {
      title: showTitle ? 'Load applied' : '',
      subtitle: 'virtual users running — the control variable for the two charts above',
      yFormat: (v) => v.toFixed(0),
      xFormat: atSeconds,
      area: true,
    },
  )
}

/** Errors across the run — drawn only when there were any. */
export function loadErrorsOverTimeChart(result: LoadTestResult, showTitle = true): string {
  const buckets = result.buckets ?? []
  if (buckets.length < 2 || !buckets.some((b) => b.failRate > 0)) return ''
  return lineChart(
    [
      {
        name: 'error rate',
        color: 'var(--viz-bad)',
        points: buckets.map((b) => ({
          x: b.atSeconds,
          y: b.failRate * 100,
          display: `${(b.failRate * 100).toFixed(1)}%`,
        })),
      },
    ],
    {
      title: showTitle ? 'Errors across the run' : '',
      subtitle: 'when the failures started says what caused them',
      yFormat: (v) => `${v.toFixed(v >= 10 ? 0 : 1)}%`,
      xFormat: atSeconds,
      area: true,
    },
  )
}

/**
 * Where an average request's time went.
 *
 * The single most useful thing to know after "it is slow", because each phase
 * points at a different fix: waiting is the server's own work, receiving is
 * payload size, connecting/TLS is connection reuse, and blocked is the load
 * generator queueing against itself — that last one means the NUMBERS are
 * suspect, not the system.
 */
export function loadPhaseChart(result: LoadTestResult, showTitle = true): string {
  const p = result.phases
  if (!p) return ''
  const setup = p.connecting.avg + p.tlsHandshaking.avg
  const segments: StackSegment[] = [
    { label: 'Waiting on the server', value: p.waiting.avg, display: ms(p.waiting.avg), color: 'var(--viz-series-1)' },
    { label: 'Receiving the response', value: p.receiving.avg, display: ms(p.receiving.avg), color: 'var(--viz-series-2)' },
    { label: 'Sending the request', value: p.sending.avg, display: ms(p.sending.avg), color: 'var(--viz-series-4)' },
    { label: 'Connect + TLS', value: setup, display: ms(setup), color: 'var(--viz-series-3)' },
    { label: 'Blocked (client queueing)', value: p.blocked.avg, display: ms(p.blocked.avg), color: 'var(--viz-series-5)' },
  ].filter((s) => s.value > 0)
  if (segments.length < 2) return ''
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  return stackedRowChart(segments, {
    title: showTitle ? 'Where the time goes' : '',
    subtitle: `${ms(total)} average request, by phase`,
  })
}

/**
 * How the traffic was split, and which endpoint carried the failures.
 *
 * A blended error rate of 2% reads very differently once one endpoint turns out to
 * own all of it, and the call MIX is what makes a load test resemble real traffic
 * or not — an endpoint the test hammered 10× more than production does is a number
 * to discount.
 */
export function loadVolumeChart(result: LoadTestResult, showTitle = true): string {
  const endpoints = result.endpoints ?? []
  if (endpoints.length < 2) return ''
  const total = endpoints.reduce((sum, e) => sum + e.calls, 0)
  if (total <= 0) return ''
  const rows: BarRow[] = [...endpoints]
    .sort((a, b) => b.calls - a.calls)
    .map((e) => {
      const failed = Math.round(e.calls * (1 - e.okRate))
      return {
        label: e.name,
        value: e.calls,
        display: `${e.calls.toLocaleString()} (${((e.calls / total) * 100).toFixed(0)}%)`,
        tone: failed > 0 ? 'bad' : 'series',
        flag: failed > 0 ? `${failed.toLocaleString()} failed` : undefined,
      } as BarRow
    })
  return barChart(rows, {
    title: showTitle ? 'Calls per endpoint' : '',
    subtitle: `${total.toLocaleString()} requests in total — the mix the test actually applied`,
    labelWidth: 200,
  })
}
