import type { LoadTestResult, PageAuditResult, PageLoadMetrics, PerfJob } from './api'

/**
 * PERFORMANCE VERDICTS + EXPORT.
 *
 * The report tables answer "what happened". They do not answer the question the
 * engineer has to put in a ticket: **is this good or bad, and what do I chase?**
 * That judgement is here rather than in the page so the SAME bands drive the
 * on-screen verdict and the exported file — a report whose exported copy grades
 * differently from the screen is worse than no export at all.
 *
 * The page bands are the public Core Web Vitals ones (LCP 2.5s/4s, FCP 1.8s/3s,
 * TTFB 0.8s/1.8s), not invented numbers, so a verdict here matches what Lighthouse
 * or PageSpeed would say and can be quoted in a ticket without argument. The load
 * bands come from the engineer's OWN thresholds when the test set them — k6 already
 * decided pass/fail, and second-guessing it on screen would be a different answer
 * from the one k6 printed.
 */

export type Grade = 'good' | 'warn' | 'bad' | 'unknown'

export interface MetricCheck {
  label: string
  value: string
  grade: Grade
  /** The band, in words — why this value earned this grade. */
  note: string
}

export interface Finding {
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
}

export interface Assessment {
  grade: Grade
  headline: string
  checks: MetricCheck[]
  findings: Finding[]
}

// ------------------------------------------------------------------ formatting

/** Milliseconds, at the precision a human reads them: 84ms, 1.24s, 2m 05s. */
export function ms(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1) return `${value.toFixed(2)}ms`
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(value / 1000).toFixed(2)}s`
  const mins = Math.floor(value / 60_000)
  const secs = Math.round((value % 60_000) / 1000)
  return `${mins}m ${String(secs).padStart(2, '0')}s`
}

/** A point on a run's time axis: `0s`, `45s`, `2m 30s`. */
export function atSeconds(value: number): string {
  const s = Math.round(value)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m ${String(rest).padStart(2, '0')}s` : `${m}m`
}

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  // A load test moves gigabytes. "4074.83 MB" is a number the reader has to divide
  // before it means anything.
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MB`
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function pct(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—'
  return `${(fraction * 100).toFixed(fraction > 0 && fraction < 0.01 ? 2 : 1)}%`
}

/** A URL trimmed to its path + query — the part that identifies the call. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}` || '/'
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * What the numbers in a load report do and do not mean.
 *
 * Every one of these has been mistaken for something else in a real report, and
 * each is a limit of the MEASUREMENT rather than of the system — so they ship with
 * the report instead of living in a wiki nobody opens beside it.
 */
export const MEASUREMENT_NOTES = [
  '**Average throughput is not peak throughput.** The headline requests/second is the whole run divided by its length, ramp-up included. The peak figure comes from the busiest sampled slice and is reported separately — neither is relabelled as the other.',
  '**Percentiles are per request, not per user journey.** A p95 of 400ms does not mean 95% of users waited 400ms: a journey that makes six calls waits for six draws from that distribution.',
  '**A load test measures timing, not correctness.** A response is counted OK on a 2xx/3xx status. An endpoint that answers 200 with an empty list under load passes here and is still broken.',
  '**The numbers include this machine.** The load generator, its network and the system under test are all in the measurement. Dropped iterations, or time spent "blocked", mean the generator ran short of room and the response times understate the system.',
  '**Response times are what the client saw**, so any proxy, gateway or VPN between this machine and the service is inside every figure.',
] as const

// ------------------------------------------------------------------ grading

function band(value: number, good: number, warn: number): Grade {
  if (!Number.isFinite(value) || value <= 0) return 'unknown'
  if (value <= good) return 'good'
  if (value <= warn) return 'warn'
  return 'bad'
}

const RANK: Record<Grade, number> = { good: 0, unknown: 1, warn: 2, bad: 3 }

/**
 * The overall grade IGNORES `unknown` checks. Some are purely informational
 * (throughput has no universal "good"), and others are simply unmeasurable on this
 * page (an LCP of 0 on a page with no contentful paint). Counting either one would
 * label a perfectly healthy run "Inconclusive" — which is what happened the first
 * time this shipped, because every load test carries an informational throughput.
 */
function worst(grades: Grade[]): Grade {
  const graded = grades.filter((g) => g !== 'unknown')
  if (!graded.length) return 'unknown'
  return graded.reduce<Grade>((acc, g) => (RANK[g] > RANK[acc] ? g : acc), 'good')
}

export function gradeLabel(grade: Grade): string {
  if (grade === 'good') return 'Healthy'
  if (grade === 'warn') return 'Needs attention'
  if (grade === 'bad') return 'Poor'
  return 'Inconclusive'
}

/**
 * What a page-load report does and does not measure. Same contract as
 * `MEASUREMENT_NOTES`: each line is a way one of these numbers has been read wrong.
 */
export const PAGE_MEASUREMENT_NOTES = [
  '**A first visit and a returning visit are different measurements.** The first load fetches everything; every load after it is served largely from cache. They are reported separately and never averaged together — their mean describes neither visit.',
  '**The returning-visit figure is a median, not a mean**, so one stalled load out of three does not become the headline. The per-load times are listed so an outlier stays visible.',
  '**Bytes are the cold load.** A returning visit transfers a fraction of them, so a per-load average of the bytes would be a number no visit ever produced.',
  '**Blocking time counts long tasks before the load event**, which is what Lighthouse compares against. Work the page does after that is real, but it is not in this figure.',
  '**"Transferred" and "response bodies" are different totals.** The first is what came over the wire, compressed; the second is the decoded size of each response. Both are true, and the second is always the larger.',
  '**This is one browser on one machine.** No throttling is applied: a real user on a phone over 4G will be slower than every number here, and the gap grows with the JavaScript.',
] as const

/** The load a returning visitor gets, falling back to the mean for older reports. */
export function warmMetrics(result: PageAuditResult): PageLoadMetrics {
  return result.warm ?? result.average
}

/** The first, cache-cold load, falling back to the mean for older reports. */
export function coldMetrics(result: PageAuditResult): PageLoadMetrics {
  return result.cold ?? result.average
}

/** Milliseconds per load spent on repeat calls — the cost of the duplicates. */
export function wastedMs(result: PageAuditResult): number {
  return result.duplicates.reduce((sum, d) => sum + d.avgMs * (d.perLoad - 1), 0)
}

export function assessPageAudit(result: PageAuditResult): Assessment {
  // A redirected run measured a different page. Grading it would be grading the
  // login screen, so refuse rather than publish a number that means nothing.
  if (result.redirected) {
    return {
      grade: 'unknown',
      headline: 'Not measured — the browser was redirected away from this URL',
      checks: [],
      findings: [
        {
          severity: 'high',
          title: 'The audit never reached the page',
          detail: `It ended on ${result.finalUrl}. Sign in through "Page behind a login?" and run it again — nothing below describes the page you asked for.`,
        },
      ],
    }
  }

  // Grade the load a RETURNING visitor gets. The cold load is reported beside it
  // and gets its own finding, but grading on a mean of the two produced a headline
  // that matched no load that happened: 1291ms cold and 70ms warm average to 529ms.
  const a = warmMetrics(result)
  const cold = coldMetrics(result)
  const warmRuns = result.warmRuns ?? 0
  const visit = warmRuns > 0 ? 'returning visit' : 'first visit'
  const dupWaste = wastedMs(result)
  const checks: MetricCheck[] = [
    {
      label: 'Page load',
      value: ms(a.loadMs),
      grade: band(a.loadMs, 2500, 5000),
      note: `${visit} · good ≤ 2.5s, poor > 5s`,
    },
    {
      label: 'LCP (main content)',
      value: ms(a.lcpMs),
      grade: band(a.lcpMs, 2500, 4000),
      note: 'Core Web Vitals · good ≤ 2.5s, poor > 4s',
    },
    {
      label: 'FCP (first paint)',
      value: ms(a.fcpMs),
      grade: band(a.fcpMs, 1800, 3000),
      note: 'good ≤ 1.8s, poor > 3s',
    },
    {
      label: 'CLS (layout shift)',
      // A page that never shifts scores a true 0, and `band` treats 0 as
      // unmeasurable — which would drop the one perfect result from the grade.
      value: a.cls != null ? a.cls.toFixed(3) : '—',
      grade: a.cls == null ? 'unknown' : a.cls <= 0.1 ? 'good' : a.cls <= 0.25 ? 'warn' : 'bad',
      note: 'Core Web Vitals · good ≤ 0.1, poor > 0.25',
    },
    {
      label: 'Blocking time',
      // 0ms of blocking is the best possible answer, and `ms(0)` renders '—' —
      // which reads as "not measured" on the one page that scored perfectly.
      value: a.tbtMs == null ? '—' : a.tbtMs > 0 ? ms(a.tbtMs) : '0ms',
      grade: a.tbtMs == null ? 'unknown' : a.tbtMs <= 200 ? 'good' : a.tbtMs <= 600 ? 'warn' : 'bad',
      note: 'long tasks before load · good ≤ 200ms, poor > 600ms',
    },
    {
      label: 'TTFB',
      value: ms(a.ttfbMs),
      grade: band(a.ttfbMs, 800, 1800),
      note: 'server response · good ≤ 0.8s, poor > 1.8s',
    },
    {
      label: 'Slowest API',
      value: ms(result.totals.slowestApiMs),
      grade: band(result.totals.slowestApiMs, 1000, 3000),
      note: 'single worst call · good ≤ 1s, poor > 3s',
    },
    {
      label: 'Duplicate API calls',
      value: result.duplicates.length ? `${result.duplicates.length} endpoint${result.duplicates.length === 1 ? '' : 's'}` : 'none',
      grade: result.duplicates.length === 0 ? 'good' : dupWaste >= 500 ? 'bad' : 'warn',
      note: result.duplicates.length
        ? `≈ ${ms(dupWaste)} per load spent on repeat calls`
        : 'no endpoint called twice per load',
    },
    {
      label: 'JavaScript errors',
      value: (result.issues ?? []).some((i) => i.kind === 'pageerror')
        ? `${(result.issues ?? []).filter((i) => i.kind === 'pageerror').length} uncaught`
        : 'none',
      grade: (result.issues ?? []).some((i) => i.kind === 'pageerror') ? 'bad' : 'good',
      note: 'uncaught exceptions during load',
    },
  ]

  const findings: Finding[] = []

  // An uncaught exception outranks every timing here: the page is not merely slow.
  for (const issue of (result.issues ?? []).filter((i) => i.kind === 'pageerror').slice(0, 5)) {
    findings.push({
      severity: 'high',
      title: `Uncaught error on load: ${issue.text.slice(0, 110)}`,
      detail: `Seen ${issue.count}× across ${result.runs} load${result.runs === 1 ? '' : 's'}. The load event fires anyway, so no timing on this page shows it — but whatever that code was meant to do did not happen.`,
    })
  }

  for (const d of result.duplicates.slice(0, 5)) {
    findings.push({
      severity: d.perLoad >= 3 || d.avgMs * (d.perLoad - 1) >= 300 ? 'high' : 'medium',
      title: `${d.method} ${shortUrl(d.endpoint)} is called ${d.perLoad % 1 === 0 ? d.perLoad : d.perLoad.toFixed(1)}× per page load`,
      detail: `${ms(d.avgMs)} each, ${ms(d.totalMsPerLoad)} per load in total. Usually an effect that re-runs, or two components fetching the same resource — the extra calls are pure waste.`,
    })
  }

  // The first-visit cost, stated as a finding rather than buried in a second tile.
  if (warmRuns > 0 && cold.loadMs > 0 && a.loadMs > 0 && cold.loadMs >= a.loadMs * 2 && cold.loadMs - a.loadMs >= 500) {
    findings.push({
      severity: cold.loadMs >= 5000 ? 'high' : 'medium',
      title: `A first visit costs ${ms(cold.loadMs)} — ${(cold.loadMs / a.loadMs).toFixed(1)}× a returning one`,
      detail: `${bytes(cold.transferBytes)} is fetched on that first load and served from cache afterwards. Everyone who has not opened this app today pays the first number, so it is the one to quote to a client.`,
    })
  }

  if (a.cls > 0.1) {
    findings.push({
      severity: a.cls > 0.25 ? 'high' : 'medium',
      title: `Layout shifts by ${a.cls.toFixed(3)} while loading`,
      detail:
        'Content moves after it is painted — the classic cause is an image, ad slot or banner with no reserved height. It is the fault users describe as "I clicked the wrong thing".',
    })
  }

  if (a.tbtMs > 200) {
    findings.push({
      severity: a.tbtMs > 600 ? 'high' : 'medium',
      title: `${ms(a.tbtMs)} of blocking time${a.longestTaskMs ? `, longest task ${ms(a.longestTaskMs)}` : ''}`,
      detail:
        'The main thread is busy for long stretches, so the page looks ready before it answers a click. Usually one big script parsing or one synchronous pass over a large response.',
    })
  }

  const failed = result.requests.filter((r) => r.status !== null && r.status >= 400)
  for (const r of failed.slice(0, 5)) {
    findings.push({
      severity: r.api ? 'high' : 'low',
      title: `${r.status} on ${r.method} ${shortUrl(r.url)}`,
      detail: `Failed on every load (${r.perLoad.toFixed(1)}× per load). A failing request on page load is a bug even when the page still renders.`,
    })
  }

  const slowApis = result.requests
    .filter((r) => r.api && r.avgMs >= 1000)
    .sort((x, y) => y.avgMs - x.avgMs)
  for (const r of slowApis.slice(0, 5)) {
    findings.push({
      severity: r.avgMs >= 3000 ? 'high' : 'medium',
      title: `${r.method} ${shortUrl(r.url)} takes ${ms(r.avgMs)}`,
      detail: `TTFB ${ms(r.avgWaitMs)} of that is the server thinking, so the fix is server-side unless the response is unusually large (${bytes(r.avgBytes)}).`,
    })
  }

  const perLoadRequests = a.requestCount
  if (perLoadRequests > 150) {
    findings.push({
      severity: 'low',
      title: `${Math.round(perLoadRequests)} requests per load`,
      detail:
        'Heavy, but a Vite dev server serves every module as its own request — measure a production build before treating this as a finding.',
    })
  }
  // Bytes are quoted from the COLD load — the only visit that actually fetched
  // them — and named by their heaviest type, because "3.2 MB" is not something
  // anyone can act on and "2.4 MB of it is JavaScript" is.
  if (cold.transferBytes > 3 * 1024 * 1024) {
    const heaviest = (result.resources ?? [])[0]
    findings.push({
      severity: cold.transferBytes > 8 * 1024 * 1024 ? 'medium' : 'low',
      title: `${bytes(cold.transferBytes)} downloaded on a first visit`,
      detail: heaviest
        ? `The largest share is ${heaviest.type} — ${bytes(heaviest.bytes)} over ${heaviest.count} request${heaviest.count === 1 ? '' : 's'}. On a dev server every module is served unbundled, so measure a production build before treating this as a finding.`
        : 'Large payload. Check images and any API returning a full table when the page shows a page of it.',
    })
  }

  const grade = worst(checks.map((c) => c.grade))
  const headline =
    grade === 'good'
      ? warmRuns > 0
        ? `First visit ${ms(cold.loadMs)}, returning visit ${ms(a.loadMs)} — nothing outside its band`
        : `Loads in ${ms(a.loadMs)} on a cold cache with no duplicate API calls`
      : grade === 'bad'
        ? `${gradeLabel(grade)} — ${findings[0]?.title ?? 'several metrics are outside their band'}`
        : `Usable, but ${findings.length || 'some metrics'} thing${findings.length === 1 ? '' : 's'} worth fixing`

  return { grade, headline, checks, findings }
}

/**
 * The numbers a load-test report needs that k6 does not print directly.
 *
 * All of them are DERIVED from the run, never guessed, and each exists because the
 * summary alone leaves a real question unanswered:
 *
 *  • `peakRps` — the summary's throughput is the AVERAGE over the whole run,
 *    ramp-up included, which understates what the system actually sustained. The
 *    per-slice buckets give a real peak, so it can be reported under its own name
 *    instead of an average being relabelled.
 *  • `drift` — compares the first quarter of the run with the last. This is the
 *    difference between "slow" and "degrading", and only the second one gets worse
 *    if the test runs longer.
 *  • `serverShare` — how much of a response was the server thinking. Below about
 *    half, the fix is usually not in the application code at all.
 */
export interface LoadExtras {
  peakRps: number
  peakAtSeconds: number
  /** Fraction of the average response time spent waiting on the server. */
  serverShare: number
  bytesPerSecond: number
  /** Null when the run is too short to split into an early and a late half. */
  drift: { earlyP95: number; lateP95: number; ratio: number } | null
}

export function loadExtras(result: LoadTestResult): LoadExtras {
  const buckets = result.buckets ?? []
  const peak = buckets.reduce<{ rps: number; atSeconds: number }>(
    (best, b) => (b.rps > best.rps ? { rps: b.rps, atSeconds: b.atSeconds } : best),
    { rps: 0, atSeconds: 0 },
  )
  const seconds = result.durationMs > 0 ? result.durationMs / 1000 : 0
  const avg = result.overall?.avg ?? 0
  const waiting = result.phases?.waiting.avg ?? result.waiting?.avg ?? 0

  // Drift is measured on the STEADY part of the run only — the slices at (near)
  // full concurrency. A ramped test starts and ends at low load, so comparing its
  // first quarter with its last compares the ramp-up with the ramp-down and reports
  // a system that never changed as "1.5× slower by the end". Selecting on the
  // measured VU count rather than the configured ramp works for both shapes: a flat
  // test keeps every slice.
  let drift: LoadExtras['drift'] = null
  const peakVus = Math.max(0, ...buckets.map((b) => b.vus))
  const steady = peakVus > 0 ? buckets.filter((b) => b.vus >= peakVus * 0.9) : buckets
  // Four or more slices before the comparison: with fewer, "the first quarter" and
  // "the last quarter" can be the same two requests.
  if (steady.length >= 4) {
    const cut = Math.max(1, Math.floor(steady.length / 4))
    // The MEDIAN slice, not the mean of them. One second of stall — a GC pause, a
    // cold cache — lands in one slice with a p95 fifteen times its neighbours, and
    // a mean lets that single slice report a steady system as "3.7× slower by the
    // end". The spike is a real finding, and it is reported as a spike elsewhere;
    // it is not drift.
    const median = (list: typeof steady) => {
      const sorted = list.map((b) => b.p95Ms).sort((a, b) => a - b)
      const mid = Math.floor(sorted.length / 2)
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
    }
    const earlyP95 = median(steady.slice(0, cut))
    const lateP95 = median(steady.slice(-cut))
    if (earlyP95 > 0) drift = { earlyP95, lateP95, ratio: lateP95 / earlyP95 }
  }

  return {
    peakRps: peak.rps,
    peakAtSeconds: peak.atSeconds,
    serverShare: avg > 0 ? waiting / avg : 0,
    bytesPerSecond: seconds > 0 ? result.dataReceived / seconds : 0,
    drift,
  }
}

export function assessLoadTest(result: LoadTestResult, thresholdP95Ms = 0): Assessment {
  /**
   * How slow the worst call has to be before a spread is worth reporting at all.
   * The engineer's own target when there is one — nothing that finished inside it
   * is a finding — and a quarter second otherwise.
   */
  const spreadFloor = Math.max(250, thresholdP95Ms)
  const p95 = result.overall.p95
  const extra = loadExtras(result)
  const checks: MetricCheck[] = [
    {
      label: 'p95 response',
      value: ms(p95),
      // The engineer's own threshold wins: k6 already passed or failed on it, and
      // showing a different verdict beside k6's would just be confusing.
      grade: thresholdP95Ms > 0 ? (p95 <= thresholdP95Ms ? 'good' : 'bad') : band(p95, 1000, 3000),
      note: thresholdP95Ms > 0 ? `your threshold: ≤ ${ms(thresholdP95Ms)}` : 'no threshold set · good ≤ 1s, poor > 3s',
    },
    {
      label: 'Error rate',
      value: pct(result.failRate),
      grade: result.failRate === 0 ? 'good' : result.failRate <= 0.01 ? 'warn' : 'bad',
      note: 'good = 0%, poor > 1%',
    },
    {
      label: 'Median',
      value: ms(result.overall.med),
      grade: band(result.overall.med, 500, 1500),
      note: 'the typical call · good ≤ 0.5s',
    },
    {
      label: 'Spread (max ÷ median)',
      value: result.overall.med > 0 ? `${(result.overall.max / result.overall.med).toFixed(1)}×` : '—',
      // A RATIO is scale-blind, and on a fast service that makes it wrong. A local
      // API answering in 4ms with one 92ms outlier scores 24× and used to grade the
      // whole run "Poor" while every other check was green and k6's own thresholds
      // passed. Nobody has a stability problem whose worst call is 92ms. So the
      // ratio only counts once the worst call is slow in ABSOLUTE terms — past the
      // engineer's own target when they set one, and past a quarter second otherwise.
      grade:
        result.overall.med <= 0
          ? 'unknown'
          : result.overall.max <= spreadFloor
            ? 'good'
            : band(result.overall.max / result.overall.med, 5, 15),
      note:
        result.overall.max <= spreadFloor
          ? `every call finished inside ${ms(spreadFloor)}, so the ratio is noise around a small number`
          : 'stability under load · good ≤ 5×, poor > 15×',
    },
    {
      label: 'Stability over the run',
      value: extra.drift ? `${extra.drift.ratio.toFixed(1)}×` : '—',
      // A run that ENDS slower than it started keeps getting worse; a uniformly
      // slow one does not. They need different tickets, so they get different
      // verdicts even when the blended p95 is identical.
      grade: extra.drift ? band(extra.drift.ratio, 1.3, 2) : 'unknown',
      note: extra.drift
        ? `p95 ${ms(extra.drift.earlyP95)} → ${ms(extra.drift.lateP95)} across the run at full load · good ≤ 1.3×`
        : 'the run was too short to compare its start with its end',
    },
    {
      label: 'Throughput',
      value: `${result.requestsPerSecond.toFixed(1)}/s`,
      grade: 'unknown',
      note: extra.peakRps > 0
        ? `average · peaked at ${extra.peakRps.toFixed(1)}/s · ${result.requests.toLocaleString()} requests over ${ms(result.durationMs)}`
        : `${result.requests.toLocaleString()} requests over ${ms(result.durationMs)}`,
    },
    {
      label: 'Server think-time share',
      value: extra.serverShare > 0 ? pct(extra.serverShare) : '—',
      // Informational: a high share is not itself a fault, it says WHERE the time
      // goes. Grading it would fail a healthy fast endpoint for being server-bound.
      grade: 'unknown',
      note: extra.serverShare > 0
        ? `${ms(result.phases?.waiting.avg ?? result.waiting.avg)} of the ${ms(result.overall.avg)} average was the server thinking`
        : 'no timing breakdown in this run',
    },
    {
      label: 'Load generator',
      value: result.droppedIterations > 0 ? `${result.droppedIterations.toLocaleString()} dropped` : 'kept up',
      // Dropped iterations mean THIS MACHINE ran out of room, so the response times
      // measured describe the generator as much as the system. That is a bad
      // result about the test, and it must not be read as a result about the API.
      grade: result.droppedIterations > 0 ? 'bad' : 'good',
      note: result.droppedIterations > 0
        ? 'iterations k6 could not start — the numbers below understate the system'
        : `${result.iterations.toLocaleString()} iterations completed at up to ${result.vusMax || '?'} VUs`,
    },
    {
      label: 'Checks',
      value: `${result.checksPassed.toLocaleString()} passed`,
      grade: result.checksFailed > 0 ? 'bad' : 'good',
      note: result.checksFailed > 0 ? `${result.checksFailed.toLocaleString()} failed` : 'every response was 2xx/3xx',
    },
  ]

  const findings: Finding[] = []
  if (!result.thresholdsPassed) {
    findings.push({
      severity: 'high',
      title: 'A threshold was crossed',
      detail: `k6 exited ${result.exitCode} (99 = threshold crossed). The run itself completed, so every number below is valid — the endpoint simply did not hold the target you set.`,
    })
  }

  if (result.droppedIterations > 0) {
    findings.push({
      severity: 'high',
      title: `The load generator dropped ${result.droppedIterations.toLocaleString()} iterations`,
      detail:
        'k6 could not start that many iterations on time, so this machine — not the system under test — was the limit for part of the run. Lower the VUs, or run the test from a machine with more headroom, before quoting these response times.',
    })
  }

  if (extra.drift && extra.drift.ratio >= 1.3) {
    findings.push({
      severity: extra.drift.ratio >= 2 ? 'high' : 'medium',
      title: `It got ${extra.drift.ratio.toFixed(1)}× slower while the load was held`,
      detail: `Measured at full concurrency, p95 was ${ms(extra.drift.earlyP95)} early in the hold and ${ms(extra.drift.lateP95)} at the end of it. Something accumulates while the load runs — a growing queue, a connection pool that never returns, a cache filling, or memory pressure. A longer test would show a worse number, so the blended p95 above is a floor, not the answer.`,
    })
  }

  const blocked = result.phases?.blocked.avg ?? 0
  if (blocked > 0 && result.overall.avg > 0 && blocked / result.overall.avg >= 0.2) {
    findings.push({
      severity: 'medium',
      title: `${pct(blocked / result.overall.avg)} of each request was spent blocked on the client`,
      detail: `${ms(blocked)} per request waiting for a free connection before the request was even sent. That is the load generator queueing against itself, so the response times include time the server never saw.`,
    })
  }

  const setup = (result.phases?.connecting.avg ?? 0) + (result.phases?.tlsHandshaking.avg ?? 0)
  if (setup > 0 && result.overall.avg > 0 && setup / result.overall.avg >= 0.25) {
    findings.push({
      severity: 'medium',
      title: `Connection setup is ${pct(setup / result.overall.avg)} of every request`,
      detail: `${ms(setup)} per request on TCP connect and the TLS handshake. Connections are not being reused — check keep-alive on the server and any proxy in front of it. This is infrastructure, not application code.`,
    })
  }

  for (const e of result.endpoints.filter((e) => e.okRate < 1)) {
    findings.push({
      severity: 'high',
      title: `${e.name} returned errors on ${pct(1 - e.okRate)} of calls`,
      detail: `${e.calls.toLocaleString()} calls, ${pct(e.okRate)} OK. Errors under load that do not happen with one user usually mean a connection pool, a rate limit, or a lock.`,
    })
  }

  const slow = [...result.endpoints].sort((a, b) => b.duration.p95 - a.duration.p95)
  if (slow.length > 1 && slow[0].duration.p95 > p95 * 1.5) {
    const e = slow[0]
    findings.push({
      severity: 'medium',
      title: `${e.name} is the bottleneck at p95 ${ms(e.duration.p95)}`,
      detail: `Well above the blended p95 of ${ms(p95)}. Server think-time (TTFB) is ${ms(e.waiting.avg)} of its ${ms(e.duration.avg)} average, so the time is being spent producing the data, not sending it.`,
    })
  }

  for (const e of result.endpoints) {
    // Same absolute floor as the spread check: "spikes to 5ms" is not a spike.
    if (e.duration.med > 0 && e.duration.max > spreadFloor && e.duration.max / e.duration.med >= 10) {
      findings.push({
        severity: 'medium',
        title: `${e.name} spikes to ${ms(e.duration.max)}`,
        detail: `Median is ${ms(e.duration.med)}, so the worst call is ${(e.duration.max / e.duration.med).toFixed(0)}× the typical one — a stall (GC pause, cold cache, lock contention) rather than a uniformly slow endpoint.`,
      })
    }
  }

  const grade = worst(checks.map((c) => c.grade))
  // k6's thresholds and this page's checks can disagree — the thresholds are the
  // two numbers the engineer typed, the checks are eight. When they do, the
  // headline has to carry both, or it reads "Held up" beside a red Poor badge.
  const worstCheck = checks.find((c) => c.grade === grade && grade !== 'good')
  const headline = result.thresholdsPassed
    ? `Held up: p95 ${ms(p95)} at ${pct(result.failRate)} errors${
        worstCheck ? ` — but ${worstCheck.label.toLowerCase()} is ${worstCheck.value}` : ''
      }`
    : `Did not hold: p95 ${ms(p95)}${thresholdP95Ms > 0 ? ` against a ${ms(thresholdP95Ms)} target` : ''}`

  return { grade, headline, checks, findings }
}

/** The assessment for whichever kind of job this is, or null if it has no result. */
export function assessJob(job: PerfJob): Assessment | null {
  if (job.kind === 'page' && job.pageResult) return assessPageAudit(job.pageResult)
  if (job.kind === 'load' && job.loadResult) {
    return assessLoadTest(job.loadResult, job.loadConfig?.thresholdP95Ms ?? 0)
  }
  return null
}

// ------------------------------------------------------------------ export

const SEVERITY_MARK: Record<Finding['severity'], string> = {
  high: '🔴',
  medium: '🟠',
  low: '🟡',
}

function gradeMark(grade: Grade): string {
  if (grade === 'good') return '✅'
  if (grade === 'warn') return '⚠️'
  if (grade === 'bad') return '❌'
  return '•'
}

function findingsBlock(findings: Finding[]): string {
  if (!findings.length) return '_Nothing to flag._\n'
  return findings
    .map((f) => `- ${SEVERITY_MARK[f.severity]} **${f.title}**  \n  ${f.detail}`)
    .join('\n')
}

function checksTable(checks: MetricCheck[]): string {
  if (!checks.length) return ''
  return [
    '| Metric | Value | Verdict | Band |',
    '|---|---|---|---|',
    ...checks.map(
      (c) =>
        `| ${c.label} | ${c.value} | ${gradeMark(c.grade)} ${c.grade === 'unknown' ? 'For reference' : gradeLabel(c.grade)} | ${c.note} |`,
    ),
  ].join('\n')
}

/** One report as Markdown — what gets pasted into a ticket. */
export function reportMarkdown(job: PerfJob): string {
  const assessment = assessJob(job)
  const when = new Date(job.createdAt).toLocaleString()
  const lines: string[] = []

  if (job.kind === 'page' && job.pageResult) {
    const r = job.pageResult
    const cfg = job.pageConfig
    lines.push(`# Page load report — ${r.url}`, '')
    lines.push(`**Run:** ${when} · ${r.runs} load${r.runs === 1 ? '' : 's'} · ${cfg?.settleMs ?? 0}ms settle · ${cfg?.useProfile === false ? 'clean browser' : 'logged-in profile'}`, '')
    if (r.redirected) lines.push(`> ⚠️ The browser ended on ${r.finalUrl}, not the requested URL. These numbers describe that page.`, '')
    lines.push(`## Verdict — ${gradeMark(assessment?.grade ?? 'unknown')} ${gradeLabel(assessment?.grade ?? 'unknown')}`, '', assessment?.headline ?? '', '')
    lines.push(checksTable(assessment?.checks ?? []), '')
    const warm = warmMetrics(r)
    const cold = coldMetrics(r)
    const warmRuns = r.warmRuns ?? 0
    const warmCell = (value: string) => (warmRuns ? value : '—')
    // `ms(0)` is an em dash, which reads as "not measured" rather than "perfect".
    const blocking = (value: number | undefined) => (value == null ? '—' : value > 0 ? ms(value) : '0ms')
    lines.push('## Timings', '')
    lines.push(
      'A first visit fetches everything; a returning visit is served largely from cache. They are different measurements and are never averaged together.',
      '',
      `| Metric | First visit (cold) | ${warmRuns ? `Returning visit (median of ${warmRuns})` : 'Returning visit'} |`,
      '|---|---|---|',
      `| Page load | ${ms(cold.loadMs)} | ${warmRuns ? ms(warm.loadMs) : 'not measured'} |`,
      `| TTFB | ${ms(cold.ttfbMs)} | ${warmCell(ms(warm.ttfbMs))} |`,
      `| DOM ready | ${ms(cold.domContentLoadedMs)} | ${warmCell(ms(warm.domContentLoadedMs))} |`,
      `| First paint (FCP) | ${ms(cold.fcpMs)} | ${warmCell(ms(warm.fcpMs))} |`,
      `| Main content (LCP) | ${ms(cold.lcpMs)} | ${warmCell(ms(warm.lcpMs))} |`,
      `| Layout shift (CLS) | ${(cold.cls ?? 0).toFixed(3)} | ${warmCell((warm.cls ?? 0).toFixed(3))} |`,
      `| Blocking time | ${blocking(cold.tbtMs)} | ${warmCell(blocking(warm.tbtMs))} |`,
      `| Requests | ${cold.requestCount.toFixed(0)} | ${warmCell(warm.requestCount.toFixed(0))} |`,
      `| Transferred | ${bytes(cold.transferBytes)} | ${warmCell(bytes(warm.transferBytes))} |`,
      '',
      `Per load: ${r.perRun.map((x, i) => `${ms(x.loadMs)}${i === 0 ? ' (cold)' : ''}`).join(' · ')}`,
      `API calls per load: ${(r.totals.apiCount / r.runs).toFixed(1)} · slowest API call ${ms(r.totals.slowestApiMs)}`,
      '',
    )
    if ((r.resources ?? []).length) {
      lines.push('## What the first visit downloads', '', '| Resource type | Requests | Bytes (cold load) |', '|---|---|---|')
      for (const g of r.resources) lines.push(`| ${g.type} | ${g.count} | ${bytes(g.bytes)} |`)
      lines.push('')
    }
    if ((r.issues ?? []).length) {
      lines.push('## JavaScript errors while loading', '')
      lines.push('The load event fires whether or not the page threw, so none of the timings above show these.', '')
      lines.push('| Kind | Message | Seen |', '|---|---|---|')
      for (const i of r.issues) {
        lines.push(`| ${i.kind === 'pageerror' ? 'uncaught' : 'console'} | ${i.text.replace(/\|/g, '\\|')} | ${i.count}× |`)
      }
      lines.push('')
    }
    lines.push('## What to look at', '', findingsBlock(assessment?.findings ?? []), '')
    lines.push('## How to read these numbers', '')
    for (const note of PAGE_MEASUREMENT_NOTES) lines.push(`- ${note}`)
    lines.push('')
    if (r.duplicates.length) {
      lines.push('## Duplicate API calls', '')
      lines.push('| Endpoint | Per load | Avg | Total per load |', '|---|---|---|---|')
      for (const d of r.duplicates) {
        lines.push(`| ${d.method} ${shortUrl(d.endpoint)} | ${d.perLoad.toFixed(1)}× | ${ms(d.avgMs)} | ${ms(d.totalMsPerLoad)} |`)
      }
      lines.push('')
    }
    const api = r.requests.filter((x) => x.api).slice(0, 40)
    if (api.length) {
      lines.push(`## API calls${r.requests.filter((x) => x.api).length > 40 ? ' (top 40)' : ''}`, '')
      lines.push('| Request | Per load | Avg | Slowest | TTFB | Size | Status |', '|---|---|---|---|---|---|---|')
      for (const x of api) {
        lines.push(
          `| ${x.method} ${shortUrl(x.url)} | ${x.perLoad.toFixed(1)}× | ${ms(x.avgMs)} | ${ms(x.maxMs)} | ${ms(x.avgWaitMs)} | ${bytes(x.avgBytes)} | ${x.status ?? '—'} |`,
        )
      }
      lines.push('')
    }
  }

  if (job.kind === 'load' && job.loadResult) {
    const r = job.loadResult
    const cfg = job.loadConfig
    lines.push(`# API load test — ${job.label}`, '')
    lines.push(
      `**Run:** ${when} · ${cfg?.vus ?? '?'} VUs${cfg?.rampUp ? ` (ramp ${cfg.rampUp})` : ''} for ${cfg?.duration ?? '?'} · ${cfg?.endpoints.length ?? 0} endpoint${cfg?.endpoints.length === 1 ? '' : 's'}`,
      '',
    )
    if (cfg?.thresholdP95Ms) lines.push(`**Thresholds:** p95 ≤ ${ms(cfg.thresholdP95Ms)}${cfg.thresholdErrorRate >= 0 ? ` · errors ≤ ${pct(cfg.thresholdErrorRate)}` : ''}`, '')
    lines.push(`## Verdict — ${gradeMark(assessment?.grade ?? 'unknown')} ${gradeLabel(assessment?.grade ?? 'unknown')}`, '', assessment?.headline ?? '', '')
    lines.push(checksTable(assessment?.checks ?? []), '')
    const extra = loadExtras(r)
    const seconds = r.durationMs > 0 ? r.durationMs / 1000 : 0
    lines.push('## Overall', '')
    lines.push(
      '| Metric | Value |',
      '|---|---|',
      `| Requests | ${r.requests.toLocaleString()} over ${ms(r.durationMs)} |`,
      `| Failed requests | ${r.failedRequests.toLocaleString()} (${pct(r.failRate)}) |`,
      `| Throughput (average) | ${r.requestsPerSecond.toFixed(1)}/s |`,
      ...(extra.peakRps > 0
        ? [`| Throughput (peak) | ${extra.peakRps.toFixed(1)}/s at ${atSeconds(extra.peakAtSeconds)} |`]
        : []),
      `| Min / median / avg | ${ms(r.overall.min)} / ${ms(r.overall.med)} / ${ms(r.overall.avg)} |`,
      `| p90 / p95 / p99 | ${ms(r.overall.p90)} / ${ms(r.overall.p95)} / ${ms(r.overall.p99)} |`,
      `| Slowest | ${ms(r.overall.max)} |`,
      `| TTFB (avg) | ${ms(r.waiting.avg)} |`,
      `| Iterations | ${r.iterations.toLocaleString()} · ${ms(r.iterationDuration.avg)} each${r.droppedIterations ? ` · ${r.droppedIterations.toLocaleString()} dropped` : ''} |`,
      `| Peak virtual users | ${r.vusMax || '—'} |`,
      `| Data received / sent | ${bytes(r.dataReceived)} / ${bytes(r.dataSent)}${extra.bytesPerSecond > 0 ? ` (${bytes(extra.bytesPerSecond)}/s)` : ''} |`,
      '',
    )

    if (r.phases) {
      const setup = r.phases.connecting.avg + r.phases.tlsHandshaking.avg
      const total = r.overall.avg || 1
      const share = (v: number) => `${pct(v / total)}`
      lines.push(
        '## Where the time goes',
        '',
        `An average request took ${ms(r.overall.avg)}. Which phase dominates decides what to chase.`,
        '',
        '| Phase | Average | Share | What it means |',
        '|---|---|---|---|',
        `| Waiting on the server | ${ms(r.phases.waiting.avg)} | ${share(r.phases.waiting.avg)} | the server producing the response |`,
        `| Receiving the response | ${ms(r.phases.receiving.avg)} | ${share(r.phases.receiving.avg)} | payload size and the network |`,
        `| Sending the request | ${ms(r.phases.sending.avg)} | ${share(r.phases.sending.avg)} | request body upload |`,
        `| Connect + TLS | ${ms(setup)} | ${share(setup)} | connections not being reused |`,
        `| Blocked (client) | ${ms(r.phases.blocked.avg)} | ${share(r.phases.blocked.avg)} | the load generator queueing against itself |`,
        '',
      )
    }

    if ((r.buckets?.length ?? 0) >= 2) {
      lines.push(
        '## Across the run',
        '',
        `Sampled every ${atSeconds(r.bucketSeconds)}. A p95 that climbs while the average stays flat is a queue forming.`,
        '',
        '| At | Requests/s | Avg | p95 | Slowest | Errors | VUs |',
        '|---|---|---|---|---|---|---|',
      )
      for (const b of r.buckets) {
        lines.push(
          `| ${atSeconds(b.atSeconds)} | ${b.rps.toFixed(1)}/s | ${ms(b.avgMs)} | ${ms(b.p95Ms)} | ${ms(b.maxMs)} | ${pct(b.failRate)} | ${b.vus.toFixed(0)} |`,
        )
      }
      lines.push('')
    }

    const latency = r.latency ?? []
    const latencyTotal = latency.reduce((sum, b) => sum + b.count, 0)
    if (latencyTotal > 0 && latency.filter((b) => b.count > 0).length > 1) {
      lines.push('## How the response times were distributed', '')
      lines.push(
        'Percentiles give five numbers; this gives the shape. A gap between two groups is two populations, not one variable system.',
        '',
      )
      lines.push('| Response time | Requests | Share |', '|---|---|---|')
      for (const b of latency) {
        const range =
          b.toMs === null ? `over ${ms(b.fromMs)}` : b.fromMs === 0 ? `under ${ms(b.toMs)}` : `${ms(b.fromMs)} – ${ms(b.toMs)}`
        lines.push(`| ${range} | ${b.count.toLocaleString()} | ${pct(b.count / latencyTotal)} |`)
      }
      lines.push('')
    }
    lines.push('## Per endpoint', '')
    lines.push(
      '| Endpoint | Calls | Req/s | OK | Failed | Min | Avg | p90 | p95 | p99 | Slowest | TTFB | Size |',
      '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    )
    for (const e of r.endpoints) {
      const failed = Math.round(e.calls * (1 - e.okRate))
      lines.push(
        `| ${e.method} ${e.name}<br>\`${hostOf(e.url)}${shortUrl(e.url)}\` | ${e.calls.toLocaleString()} | ${seconds > 0 ? (e.calls / seconds).toFixed(1) : '—'} | ${pct(e.okRate)} | ${failed.toLocaleString()} | ${ms(e.duration.min)} | ${ms(e.duration.avg)} | ${ms(e.duration.p90)} | ${ms(e.duration.p95)} | ${ms(e.duration.p99)} | ${ms(e.duration.max)} | ${ms(e.waiting.avg)} | ${bytes(e.avgBytes)} |`,
      )
    }
    lines.push('', '## What to look at', '', findingsBlock(assessment?.findings ?? []), '')
    lines.push(
      '## How to read these numbers',
      '',
      ...MEASUREMENT_NOTES.map((n) => `- ${n}`),
      '',
    )
  }

  lines.push('---', `_Generated by QC Portal · Performance · ${new Date().toLocaleString()}_`)
  return lines.join('\n')
}

/** The machine-readable copy: the job as polled, plus the verdict. */
export function reportJson(job: PerfJob): string {
  return JSON.stringify({ job, assessment: assessJob(job), exportedAt: new Date().toISOString() }, null, 2)
}

/** `page-load-orders-2026-08-26-09-41-12` — safe on Windows and mac alike. */
export function reportFileName(job: PerfJob): string {
  const stamp = new Date(job.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const kind = job.kind === 'page' ? 'page-load' : 'api-load-test'
  const slug =
    (job.kind === 'page' ? shortUrl(job.label) : job.label)
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'report'
  return `${kind}-${slug}-${stamp}`
}

/** Hand the browser a file. Same pattern as the Database page's CSV export. */
export function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function downloadText(name: string, text: string, mime: string): void {
  downloadBlob(name, new Blob([text], { type: mime }))
}
