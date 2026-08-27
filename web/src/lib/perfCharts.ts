import type { LoadTestResult, PageAuditResult } from './api'
import {
  formatTarget,
  isRateMetric,
  METRIC_LABEL,
  type NfrRequirementResult,
} from './nfrReport'
import { atSeconds, bytes, ms, warmMetrics } from './perfReport'

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
  // The load a RETURNING visitor gets. Drawing the mean of a cold and a warm load
  // draws a milestone sequence that no single load ever produced.
  const a = warmMetrics(result)
  const warmRuns = result.warmRuns ?? 0
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
    subtitle: warmRuns
      ? `a returning visit — median of ${warmRuns} warm load${warmRuns === 1 ? '' : 's'}`
      : 'a first visit — one cold load',
    labelWidth: 150,
  })
}

/** Per-run load times — a single slow run must stay visible, not average away. */
export function pageRunsChart(result: PageAuditResult, showTitle = true): string {
  if (result.perRun.length < 2) return ''
  const rows: BarRow[] = result.perRun.map((r, i) => ({
    label: i === 0 ? 'Load 1 (cold)' : `Load ${i + 1}`,
    value: r.loadMs,
    display: ms(r.loadMs),
    // Named in WORDS, not by hue: the cold load is a different measurement from
    // the ones beside it, not a slow outlier of the same one.
    flag: i === 0 ? 'empty cache' : undefined,
  }))
  return barChart(rows, {
    title: showTitle ? 'Load time per run' : '',
    subtitle: 'the first load fills the cache; the rest are what a returning visitor gets',
    labelWidth: 110,
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

/**
 * THE WATERFALL — the cold load, drawn against a time axis.
 *
 * Every other chart on this page says how LONG something took. This is the only
 * one that says WHEN, and that is the whole of page-load analysis: three 200ms
 * calls fired together cost 200ms, and the same three chained cost 600ms. In a
 * table of averages those two pages are identical; drawn against an axis, one has
 * three bars starting at the same x and the other has a staircase.
 *
 * The milestones are drawn ON the same axis, because "the LCP is at 2.9s" is only
 * a finding once you can see which request is still in flight at 2.9s.
 *
 * The cold load is used deliberately — a warm load reads everything from cache and
 * its waterfall is a picture of the cache, not of the page.
 */
export function pageWaterfallChart(result: PageAuditResult, showTitle = true): string {
  const timeline = result.timeline ?? []
  if (timeline.length < 2) return ''
  const cold = result.cold ?? result.average

  // APIs first — they are the question this page exists to answer — then the
  // slowest assets to fill the remaining rows. Everything is then re-sorted by
  // start time, because a waterfall read out of time order is not a waterfall.
  const MAX_API = 14
  const MAX_ASSETS = 8
  const api = timeline.filter((t) => t.api)
  // Assets are capped tightly and separately. A dev server serves 180 modules that
  // all take 74ms; filling the chart with the longest of them buries the six calls
  // the reader came for under thirteen rows of identical bars.
  const rest = timeline.filter((t) => !t.api).sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))
  const shownApi = api.slice(0, MAX_API)
  const shownRest = rest.slice(0, MAX_ASSETS)
  const rows = [...shownApi, ...shownRest].sort((a, b) => a.startMs - b.startMs)
  if (!rows.length) return ''

  const marks = [
    { at: cold.fcpMs, label: 'FCP' },
    { at: cold.lcpMs, label: 'LCP' },
    { at: cold.loadMs, label: 'load' },
  ].filter((m) => m.at > 0)

  const width = 720
  const labelW = 220
  const rightPad = 64
  const plotW = width - labelW - rightPad
  const rowH = 20
  const barH = 10
  const span = Math.max(...rows.map((r) => r.endMs), ...marks.map((m) => m.at), 1)
  const hasTitle = !!showTitle
  // Two rows of headroom for the milestone labels: FCP and LCP routinely land
  // within a few milliseconds of each other, so one row of them always collides.
  const top = (hasTitle ? 46 : 26) + 26
  /**
   * A time label sized to the span being drawn.
   *
   * `atSeconds` is the load-test formatter and rounds to whole seconds, which on a
   * page that loads in 1.6s prints an axis reading "0s · 0s · 1s · 1s · 2s". A page
   * waterfall is a sub-second instrument and needs a sub-second axis.
   */
  const at = (msValue: number) => {
    if (span < 2000) return `${Math.round(msValue)}ms`
    if (span < 20_000) return `${(msValue / 1000).toFixed(1)}s`
    return atSeconds(msValue / 1000)
  }
  const axisY = top + rows.length * rowH + 6
  const height = axisY + 30
  const x = (t: number) => labelW + Math.min(plotW, Math.max(0, (t / span) * plotW))

  const parts: string[] = [
    `<svg class="viz" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Request waterfall" xmlns="http://www.w3.org/2000/svg">`,
  ]
  if (hasTitle) parts.push(`<text x="0" y="14" class="viz-title">When each request happened</text>`)
  parts.push(
    `<text x="0" y="${hasTitle ? 32 : 12}" class="viz-sub">${esc(
      `first visit · ${shownApi.length} API call${shownApi.length === 1 ? '' : 's'}${
        api.length > MAX_API ? ` of ${api.length}` : ''
      } and the ${shownRest.length} slowest of ${rest.length} assets`,
    )}</text>`,
  )

  // Ticks land on round numbers, not on span/4: an axis reading "0ms · 403ms ·
  // 807ms · 1210ms" is precise and unreadable, and nobody ever wanted to know
  // where 403ms was. Four or five gridlines, recessive, behind the bars.
  const rawStep = span / 4
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((v) => v >= rawStep) ?? magnitude * 10
  for (let t = 0; t <= span + 0.5; t += step) {
    const gx = x(t)
    parts.push(
      `<line x1="${gx}" y1="${top - 8}" x2="${gx}" y2="${axisY}" class="viz-grid"/>`,
      `<text x="${gx}" y="${axisY + 14}" text-anchor="${t === 0 ? 'start' : 'middle'}" class="viz-sub">${esc(at(t))}</text>`,
    )
  }

  rows.forEach((r, i) => {
    const y = top + i * rowH
    const x1 = x(r.startMs)
    const w = Math.max(2, x(r.endMs) - x1)
    const path = (() => {
      try {
        return new URL(r.url).pathname
      } catch {
        return r.url
      }
    })()
    const label = `${r.api ? `${r.method} ` : ''}${path}`
    const failed = r.status !== null && r.status >= 400
    // API calls wear the series hue, assets a muted one — but the label already
    // carries the method, and a failure is written as a word, so the picture is
    // still complete in print with no colour at all.
    const fill = failed ? 'var(--viz-bad)' : r.api ? 'var(--viz-series-1)' : 'var(--viz-series-4)'
    parts.push(
      `<text x="0" y="${y + barH + 1}" class="viz-label">${esc(label.length > 32 ? `…${label.slice(-31)}` : label)}</text>`,
      `<g><title>${esc(`${r.method} ${r.url} — starts ${at(r.startMs)}, takes ${ms(r.endMs - r.startMs)}${r.status ? `, ${r.status}` : ''}`)}</title>`,
      `<path d="${barPath(x1, y, w, barH, 3)}" fill="${fill}"/>`,
      '</g>',
      `<text x="${Math.min(width - 2, x1 + w + 6)}" y="${y + barH + 1}" class="viz-value">${esc(ms(r.endMs - r.startMs))}${failed ? ` <tspan class="viz-flag">${r.status}</tspan>` : ''}</text>`,
    )
  })

  // Milestones last, so they sit over the bars rather than under them. Their
  // labels are staggered onto a second row when they would collide: FCP and LCP
  // are often milliseconds apart, which puts two labels at the same x.
  let lastLabelX = -Infinity
  let row = 0
  for (const m of [...marks].sort((a, b) => a.at - b.at)) {
    const mx = x(m.at)
    row = mx - lastLabelX < 70 ? (row + 1) % 2 : 0
    lastLabelX = mx
    // Keep the label inside the frame — a milestone at t=0 sits on the left edge.
    const anchor = mx < labelW + 30 ? 'start' : mx > width - 40 ? 'end' : 'middle'
    parts.push(
      `<line x1="${mx}" y1="${top - 14}" x2="${mx}" y2="${axisY}" class="viz-ref"/>`,
      `<text x="${mx}" y="${top - 18 - row * 12}" text-anchor="${anchor}" class="viz-sub">${esc(`${m.label} ${at(m.at)}`)}</text>`,
    )
  }

  parts.push('</svg>')
  return (
    parts.join('') +
    legend([
      { color: 'var(--viz-series-1)', label: 'API call (XHR/fetch)' },
      { color: 'var(--viz-series-4)', label: 'script, style, image, font' },
      { color: 'var(--viz-muted)', label: 'FCP / LCP / load event (dashed)' },
    ])
  )
}

/**
 * What the first visit actually downloads, by resource type.
 *
 * "4.9 MB transferred" is not a finding anybody can act on; "4.1 MB of it is
 * JavaScript over 179 requests" names the fix. Cold load only — a returning visit
 * reads nearly all of it from cache, so an average over loads would be a number no
 * visit produced.
 */
export function pageResourceChart(result: PageAuditResult, showTitle = true): string {
  const groups = (result.resources ?? []).filter((g) => g.bytes > 0)
  if (groups.length < 2) return ''
  const HUES = [
    'var(--viz-series-1)',
    'var(--viz-series-2)',
    'var(--viz-series-3)',
    'var(--viz-series-4)',
    'var(--viz-series-5)',
  ]
  // Past five named types the tail is folded into one "other" segment rather than
  // given a generated hue — the categorical palette has five validated slots.
  const top = groups.slice(0, 5)
  const tail = groups.slice(5)
  const segments: StackSegment[] = top.map((g, i) => ({
    label: `${g.type} · ${g.count} request${g.count === 1 ? '' : 's'}`,
    value: g.bytes,
    display: bytes(g.bytes),
    color: HUES[i],
  }))
  if (tail.length) {
    const other = tail.reduce((sum, g) => sum + g.bytes, 0)
    segments.push({
      // Named by its actual type when the tail is one type: a browser resource
      // type is itself called "other", and folding it into a segment ALSO called
      // "other" puts two different "other" rows in one legend.
      label:
        tail.length === 1
          ? `${tail[0].type} · ${tail[0].count} request${tail[0].count === 1 ? '' : 's'}`
          : `${tail.length} other types`,
      value: other,
      display: bytes(other),
      color: 'var(--viz-muted)',
    })
  }
  const total = groups.reduce((sum, g) => sum + g.bytes, 0)
  return stackedRowChart(segments, {
    title: showTitle ? 'What the first visit downloads' : '',
    // Named as response bodies, not "transferred": these are decoded sizes from
    // the network layer, while the tile's "downloaded" figure is the browser's own
    // over-the-wire transferSize, which is compressed. Two different true numbers
    // under one word is how a report gets argued with.
    subtitle: `${bytes(total)} of response bodies on a cold cache, by resource type`,
  })
}

// -------------------------------------------------------------- load test

/**
 * THE RESPONSE-TIME DISTRIBUTION — the shape percentiles cannot carry.
 *
 * A p50 of 20ms with a p99 of 4s is printed identically by two systems that need
 * opposite fixes: one with a smooth tail (everything is a bit variable) and one
 * with two populations (almost everything is 20ms, and one endpoint always takes
 * 4s). The percentile ladder chart above shows the same five numbers for both.
 * This shows the gap between the two humps, and the gap is the finding.
 *
 * Counts are drawn, with the share as the flag — the count is what makes "0.4% of
 * requests" concrete when 0.4% is 900 users a day.
 */
export function loadLatencyChart(
  result: LoadTestResult,
  thresholdP95Ms = 0,
  showTitle = true,
): string {
  const rungs = result.latency ?? []
  const total = rungs.reduce((sum, r) => sum + r.count, 0)
  // One rung holding everything is a bar chart with one bar: true, and useless.
  if (total <= 0 || rungs.filter((r) => r.count > 0).length < 2) return ''
  const label = (r: { fromMs: number; toMs: number | null }) =>
    r.toMs === null ? `over ${ms(r.fromMs)}` : r.fromMs === 0 ? `under ${ms(r.toMs)}` : `${ms(r.fromMs)} – ${ms(r.toMs)}`
  const rows: BarRow[] = rungs.map((r) => {
    const share = r.count / total
    // A rung wholly above the engineer's own p95 target is over target by
    // definition; it is flagged in words as well as tone.
    const over = thresholdP95Ms > 0 && r.fromMs >= thresholdP95Ms
    return {
      label: label(r),
      value: r.count,
      display: r.count.toLocaleString(),
      tone: over ? 'bad' : 'series',
      // Two decimals only below 1%: "0.54%" is the finding, "94.85%" is noise.
      flag: `${(share * 100).toFixed(share * 100 < 1 ? 2 : 1)}%${over ? ' over target' : ''}`,
    }
  })
  // Only promise the marking when a rung actually earns it — a note about bars
  // that are not on the chart reads as a chart that failed to draw them.
  const anyOver = rows.some((r) => r.tone === 'bad')
  return barChart(rows, {
    title: showTitle ? 'How the response times were distributed' : '',
    subtitle: `${total.toLocaleString()} requests${
      anyOver ? ` · rungs at or above the ${ms(thresholdP95Ms)} target are marked over target` : ''
    }`,
    labelWidth: 130,
  })
}

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
