import type { Browser, BrowserContext, Page } from 'playwright-core'
import { agentProfileDir } from './browserProfile.js'

/**
 * PAGE LOAD AUDIT — the browser half of the Performance page.
 *
 * k6 answers "how does the API hold up under load". It cannot answer the two
 * questions a QC engineer actually starts with:
 *
 *   • how long does this page take to load, really?
 *   • is one API being called over and over on a single page load?
 *
 * Both need a real browser, so this drives Chrome through playwright-core the same
 * way `scanJobs.ts` does (same lazy import, same persistent profile, so an
 * authenticated page is reachable). The difference is what we keep: scanJobs
 * records WHICH endpoints a page calls, this one records HOW LONG each took and
 * HOW MANY TIMES it was called per load.
 *
 * The load is repeated `runs` times because a single navigation is noise: a cold
 * first load and a warm second load differ by more than most regressions do. Every
 * number the UI shows as a headline is the average across runs, with the per-run
 * values kept so an outlier is visible rather than hidden inside the mean.
 *
 * After `load` fires we deliberately keep listening for `settleMs`. Duplicate API
 * calls are overwhelmingly a post-mount effect — a component fetching in an effect
 * that re-runs, two siblings fetching the same resource — so a capture that stops
 * at the load event misses exactly the bug this feature exists to find.
 */

let chromiumMod: typeof import('playwright-core').chromium | null = null
/** Shared with `authSession.ts`, so the sign-in window and the audit agree on Chrome. */
export async function loadChromium(): Promise<typeof import('playwright-core').chromium> {
  if (chromiumMod) return chromiumMod
  const mod = await import('playwright-core')
  chromiumMod = mod.chromium
  return chromiumMod
}

/** Whether a page audit can run on this machine (playwright-core loads). */
export async function pageAuditAvailable(): Promise<{ ok: boolean; error?: string }> {
  try {
    await loadChromium()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'playwright-core not available' }
  }
}

// ------------------------------------------------------------------ types

/** Browser timings for one navigation, all in milliseconds from navigation start. */
export interface PageLoadMetrics {
  /** Time to first byte of the document. */
  ttfbMs: number
  /** DOMContentLoaded — the DOM is parsed and blocking scripts have run. */
  domContentLoadedMs: number
  /** The `load` event — subresources finished. The headline "page load time". */
  loadMs: number
  /** First Contentful Paint — when the user first sees something. */
  fcpMs: number
  /** Largest Contentful Paint — when the main content is visible. */
  lcpMs: number
  /** Total bytes transferred over the network for this navigation. */
  transferBytes: number
  /** How many requests the page made in this run (all resource types). */
  requestCount: number
  /**
   * Cumulative Layout Shift — unitless, the third Core Web Vital. Without it a
   * report that quotes the CWV bands for LCP and FCP is quoting two thirds of a
   * standard: a page can hit every timing band and still throw its content around
   * under the reader's cursor, which is the complaint users actually file.
   */
  cls: number
  /**
   * Total Blocking Time — the sum, over every task longer than 50ms, of the part
   * past 50ms. This is the lab measure of "the page is painted but does nothing
   * when I click", which no navigation timing can express.
   */
  tbtMs: number
  /** The single longest task, ms. One 3s task and sixty 60ms ones share a TBT. */
  longestTaskMs: number
}

/**
 * A JavaScript error the page reported while it loaded.
 *
 * A page that throws on mount is a bug whether or not it still renders, and it is
 * invisible to every timing in this file — the load event fires just the same. It
 * is also the cheapest finding here to act on, because the message names the file.
 *
 * `pageerror` is an uncaught exception; `console` is something the app chose to
 * log at error level. They are kept apart because the second is often deliberate.
 */
export interface PageIssue {
  kind: 'pageerror' | 'console'
  text: string
  /** Times this exact message was seen across all runs. */
  count: number
}

/**
 * Bytes and request count for one resource type on the FIRST (cold) load.
 *
 * "4.9 MB transferred" is not a finding; "4.1 MB of it is JavaScript" is. Taken
 * from the cold run on purpose — on a warm load the browser serves almost all of
 * it from cache, so a per-load average of the bytes describes neither visit.
 */
export interface ResourceGroup {
  type: string
  count: number
  bytes: number
}

/**
 * One request on the cold load, positioned in time.
 *
 * Everything else in this file says how LONG a request took. Only this says WHEN,
 * and "when" is the whole of page-load analysis: three 200ms calls fired together
 * cost 200ms, and the same three chained cost 600ms. The two are indistinguishable
 * in a table of averages and obvious the moment they are drawn against an axis.
 *
 * Offsets are milliseconds from the moment the navigation was issued.
 */
export interface TimelineEntry {
  method: string
  url: string
  resourceType: string
  api: boolean
  startMs: number
  endMs: number
  bytes: number
  status: number | null
}

/** One request URL, aggregated across every run of the audit. */
export interface AuditRequest {
  method: string
  url: string
  resourceType: string
  status: number | null
  /** Times this exact method+URL was seen across all runs. */
  count: number
  /** count / runs — 2.0 means "called twice on every single page load". */
  perLoad: number
  avgMs: number
  maxMs: number
  /** Average time from request sent to first response byte. */
  avgWaitMs: number
  /** Average response body size in bytes. */
  avgBytes: number
  /** XHR/fetch — i.e. an API call rather than a script/image/stylesheet. */
  api: boolean
}

/**
 * An endpoint (method + path, query stripped) called more than once per page load.
 * Grouping by path as well as by exact URL matters: `?page=1` and `?page=2` are
 * one endpoint hit twice, and an app that fires both on mount has the same problem
 * as one that fires the identical URL twice.
 */
export interface DuplicateEndpoint {
  method: string
  /** origin + pathname — the endpoint, without its query string. */
  endpoint: string
  count: number
  perLoad: number
  /** The distinct full URLs that landed on this endpoint (capped for display). */
  urls: string[]
  avgMs: number
  /** Total milliseconds spent on these calls, averaged per load. */
  totalMsPerLoad: number
}

export interface PageAuditResult {
  url: string
  runs: number
  /**
   * Where the browser actually ENDED UP on the last load. A page behind a login
   * bounces a session-less browser to /login, and every number after that
   * describes the login screen instead of the page that was asked for — which
   * reads as "this page is fast and calls no APIs" unless we say otherwise.
   */
  finalUrl: string
  /** True when `finalUrl` is a different path than the requested URL. */
  redirected: boolean
  /** Per-navigation metrics, in run order — an outlier stays visible. */
  perRun: PageLoadMetrics[]
  /**
   * The mean across runs. Kept because older reports quote it, but it is NOT what
   * the page grades on — see `cold` / `warm`. A first visit and a cached one differ
   * by more than any regression this tool can find, so their mean describes neither.
   */
  average: PageLoadMetrics
  /** The FIRST load: an empty cache, which is what a new visitor gets. */
  cold: PageLoadMetrics
  /**
   * The MEDIAN of every load after the first — a returning visitor, and the one an
   * internal app's users get all day. Median, not mean, so a single GC pause in one
   * of three loads does not become the headline.
   *
   * Equal to `cold` when only one load was requested; `warmRuns` says which it is.
   */
  warm: PageLoadMetrics
  /** How many loads went into `warm`. 0 means there is no warm measurement. */
  warmRuns: number
  /** Uncaught exceptions and console errors seen while loading. */
  issues: PageIssue[]
  /** Cold-load bytes and request count, grouped by resource type. */
  resources: ResourceGroup[]
  /** Every request of the cold load, with its start and end offset. */
  timeline: TimelineEntry[]
  requests: AuditRequest[]
  duplicates: DuplicateEndpoint[]
  totals: {
    requestCount: number
    apiCount: number
    /** Distinct API endpoints (method + path). */
    apiEndpointCount: number
    transferBytes: number
    /** Slowest API call seen, in ms. */
    slowestApiMs: number
  }
}

// ------------------------------------------------------------------ internals

const MAX_RUNS = 10
/**
 * Separate caps for API calls and everything else, and the split is not cosmetic.
 * A Vite dev server serves each ES module as its own URL, so one page load can be
 * 250+ distinct requests — a single shared cap fills with script files and then
 * silently drops the XHR/fetch calls this whole feature exists to count, which
 * would under-report exactly the duplicate calls it is meant to find. Static
 * assets are capped tightly (nobody reads row 300 of that table); API calls get
 * headroom no real page reaches.
 */
const MAX_TRACKED_API = 2000
const MAX_TRACKED_OTHER = 400
const MAX_DUPLICATE_URLS = 6
/** Enough to draw a waterfall of the cold load; past that the rows are 1px each. */
const MAX_TIMELINE = 200
/** Distinct error messages kept. A page in a render loop can log thousands. */
const MAX_ISSUES = 25

interface Agg {
  method: string
  url: string
  resourceType: string
  status: number | null
  count: number
  totalMs: number
  maxMs: number
  totalWaitMs: number
  totalBytes: number
  api: boolean
}

function emptyMetrics(): PageLoadMetrics {
  return {
    ttfbMs: 0,
    domContentLoadedMs: 0,
    loadMs: 0,
    fcpMs: 0,
    lcpMs: 0,
    transferBytes: 0,
    requestCount: 0,
    cls: 0,
    tbtMs: 0,
    longestTaskMs: 0,
  }
}

function averageMetrics(runs: PageLoadMetrics[]): PageLoadMetrics {
  if (!runs.length) return emptyMetrics()
  const sum = emptyMetrics()
  for (const r of runs) {
    sum.ttfbMs += r.ttfbMs
    sum.domContentLoadedMs += r.domContentLoadedMs
    sum.loadMs += r.loadMs
    sum.fcpMs += r.fcpMs
    sum.lcpMs += r.lcpMs
    sum.transferBytes += r.transferBytes
    sum.requestCount += r.requestCount
    sum.cls += r.cls
    sum.tbtMs += r.tbtMs
    sum.longestTaskMs += r.longestTaskMs
  }
  const n = runs.length
  return {
    ttfbMs: sum.ttfbMs / n,
    domContentLoadedMs: sum.domContentLoadedMs / n,
    loadMs: sum.loadMs / n,
    fcpMs: sum.fcpMs / n,
    lcpMs: sum.lcpMs / n,
    transferBytes: sum.transferBytes / n,
    requestCount: sum.requestCount / n,
    cls: sum.cls / n,
    tbtMs: sum.tbtMs / n,
    longestTaskMs: sum.longestTaskMs / n,
  }
}

/** The middle value, or the mean of the middle two. */
function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * The median load, metric by metric.
 *
 * Deliberately NOT "the median run" — one run does not have to be the middle one
 * for every metric, and picking a single representative run would let one slow
 * TTFB drag a fast LCP into the headline with it. Each metric is answered by its
 * own middle value, which is what "typical" means for that metric.
 */
function medianMetrics(runs: PageLoadMetrics[]): PageLoadMetrics {
  if (!runs.length) return emptyMetrics()
  const pick = (read: (m: PageLoadMetrics) => number) => median(runs.map(read))
  return {
    ttfbMs: pick((m) => m.ttfbMs),
    domContentLoadedMs: pick((m) => m.domContentLoadedMs),
    loadMs: pick((m) => m.loadMs),
    fcpMs: pick((m) => m.fcpMs),
    lcpMs: pick((m) => m.lcpMs),
    transferBytes: pick((m) => m.transferBytes),
    requestCount: pick((m) => m.requestCount),
    cls: pick((m) => m.cls),
    tbtMs: pick((m) => m.tbtMs),
    longestTaskMs: pick((m) => m.longestTaskMs),
  }
}

/**
 * Registers the three observers that only work if they are registered FIRST.
 *
 * It has to be an init script for all three: a PerformanceObserver added after
 * `load` sees nothing, because entries are only buffered for an observer that
 * asked for them up front — and for layout shifts and long tasks there is no
 * buffer at all, so anything that happened before the observer existed is simply
 * gone. Reading them after the fact is not an option that produces a wrong number;
 * it produces zero, which is worse, because zero reads as "clean".
 *
 * Every observer is wrapped on its own: `longtask` is not supported everywhere,
 * and one unsupported type must not take the other two down with it.
 */
const INIT_SCRIPT = `
(() => {
  window.__qcLcp = 0
  window.__qcCls = 0
  window.__qcTasks = []
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__qcLcp = Math.max(window.__qcLcp || 0, entry.startTime || 0)
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (e) { /* an old browser without LCP still reports every other metric */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // A shift the user caused by clicking something is not a defect, and the
        // spec flags exactly those. Counting them would report every expanding
        // accordion in the app as a layout problem.
        if (!entry.hadRecentInput) window.__qcCls += entry.value || 0
      }
    }).observe({ type: 'layout-shift', buffered: true })
  } catch (e) { /* no layout-shift support */ }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (window.__qcTasks.length < 500) {
          window.__qcTasks.push([entry.startTime || 0, entry.duration || 0])
        }
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch (e) { /* no longtask support */ }
})()
`

/** Read the navigation/paint timings the browser itself recorded for this load. */
async function collectMetrics(page: Page): Promise<PageLoadMetrics> {
  const raw = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const paints = performance.getEntriesByType('paint') as PerformanceEntry[]
    const fcp = paints.find((p) => p.name === 'first-contentful-paint')
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const transfer =
      (nav?.transferSize ?? 0) + resources.reduce((sum, r) => sum + (r.transferSize || 0), 0)
    const w = window as unknown as { __qcLcp?: number; __qcCls?: number; __qcTasks?: [number, number][] }
    const loadMs = nav?.loadEventEnd ?? 0
    const tasks = w.__qcTasks ?? []
    // Blocking time is summed over tasks that started BEFORE the load event, so it
    // is comparable with what Lighthouse reports rather than being inflated by the
    // settle window this audit deliberately keeps recording through.
    const beforeLoad = loadMs > 0 ? tasks.filter((t) => t[0] < loadMs) : tasks
    return {
      ttfbMs: nav?.responseStart ?? 0,
      // These are 0 while the event hasn't fired yet; the caller waits for `load`.
      domContentLoadedMs: nav?.domContentLoadedEventEnd ?? 0,
      loadMs,
      fcpMs: fcp?.startTime ?? 0,
      lcpMs: w.__qcLcp ?? 0,
      transferBytes: transfer,
      requestCount: resources.length + (nav ? 1 : 0),
      cls: w.__qcCls ?? 0,
      tbtMs: beforeLoad.reduce((sum, t) => sum + Math.max(0, t[1] - 50), 0),
      longestTaskMs: tasks.reduce((max, t) => Math.max(max, t[1]), 0),
    }
  })
  return {
    ttfbMs: Math.max(0, raw.ttfbMs),
    domContentLoadedMs: Math.max(0, raw.domContentLoadedMs),
    loadMs: Math.max(0, raw.loadMs),
    fcpMs: Math.max(0, raw.fcpMs),
    lcpMs: Math.max(0, raw.lcpMs),
    transferBytes: Math.max(0, raw.transferBytes),
    requestCount: Math.max(0, raw.requestCount),
    cls: Math.max(0, raw.cls),
    tbtMs: Math.max(0, raw.tbtMs),
    longestTaskMs: Math.max(0, raw.longestTaskMs),
  }
}

/** The endpoint a URL belongs to: origin + pathname, query and hash dropped. */
function endpointOf(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url.split('?')[0].split('#')[0]
  }
}

/**
 * Did the browser end up somewhere other than where it was sent? Compared by
 * PATH only: an app that appends `?returnUrl=…` or a trailing slash has not
 * redirected anywhere meaningful, while `/orders` → `/login` has.
 */
function isRedirect(requested: string, final: string): boolean {
  if (!final) return false
  try {
    const a = new URL(requested)
    const b = new URL(final)
    const norm = (u: URL) => `${u.origin}${u.pathname.replace(/\/+$/, '')}`
    return norm(a) !== norm(b)
  } catch {
    return false
  }
}

export function friendlyLaunchError(raw: string): string {
  if (/ProcessSingleton|SingletonLock|already (in use|running)|being used/i.test(raw)) {
    return 'That Chrome profile is already open. Close the other Chrome/QC browser window using it and try again.'
  }
  if (/Executable doesn't exist|channel .*chrome|No such file/i.test(raw)) {
    return 'Google Chrome was not found. Install Chrome (the audit reuses your system Chrome).'
  }
  return raw
}

// ------------------------------------------------------------------ the audit

export interface PageAuditOptions {
  url: string
  /** How many times to load the page. 1–10; the report averages across them. */
  runs: number
  /** Extra ms to keep recording after `load`, catching post-mount API calls. */
  settleMs: number
  /** Show the browser window (useful when a login step is needed). */
  headed: boolean
  /** Reuse the logged-in QC profile. Off = a clean, cache-cold browser. */
  useProfile: boolean
  onLog: (level: 'info' | 'success' | 'error', text: string) => void
  signal?: AbortSignal
}

/**
 * Load `url` `runs` times in a real browser and report load timings plus a
 * per-request table with duplicate-call detection. Throws only if the browser
 * cannot be launched — a navigation failure on one run is logged and skipped so
 * the remaining runs still produce a report.
 */
export async function auditPageLoad(opts: PageAuditOptions): Promise<PageAuditResult> {
  const chromium = await loadChromium()
  const runs = Math.max(1, Math.min(MAX_RUNS, Math.round(opts.runs) || 1))
  const settleMs = Math.max(0, Math.min(30_000, Math.round(opts.settleMs)))

  let context: BrowserContext
  // Only set on the clean-browser path: a launched Browser owns the context, and
  // closing the context alone would leave the Chrome process running.
  let ownedBrowser: Browser | null = null
  try {
    if (opts.useProfile) {
      context = await chromium.launchPersistentContext(agentProfileDir(), {
        headless: !opts.headed,
        channel: 'chrome',
        viewport: opts.headed ? null : { width: 1440, height: 900 },
        args: opts.headed ? ['--start-maximized'] : [],
      })
    } else {
      ownedBrowser = await chromium.launch({ headless: !opts.headed, channel: 'chrome' })
      context = await ownedBrowser.newContext({ viewport: { width: 1440, height: 900 } })
    }
  } catch (err) {
    if (ownedBrowser) await ownedBrowser.close().catch(() => {})
    throw new Error(friendlyLaunchError(err instanceof Error ? err.message : String(err)))
  }

  const byKey = new Map<string, Agg>()
  let recording = false
  let apiTracked = 0
  let otherTracked = 0
  let droppedApi = 0
  let droppedOther = 0
  /** Which load is in flight — the cold one is index 0 and is the only one drawn. */
  let runIndex = 0
  /** Wall clock at the moment `goto` was issued; the zero of the timeline. */
  let navStart = 0
  const timeline: TimelineEntry[] = []
  const coldByType = new Map<string, { count: number; bytes: number }>()
  const issueMap = new Map<string, PageIssue>()

  /** Record one error message, deduped — a render loop logs the same line 400 times. */
  function noteIssue(kind: PageIssue['kind'], text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300)
    if (!clean) return
    const key = `${kind}:${clean}`
    const existing = issueMap.get(key)
    if (existing) {
      existing.count++
      return
    }
    if (issueMap.size >= MAX_ISSUES) return
    issueMap.set(key, { kind, text: clean, count: 1 })
  }

  try {
    await context.addInitScript(INIT_SCRIPT)

    // requestfinished carries the completed timing envelope; `response` alone
    // fires before the body is read, so its numbers would understate slow APIs.
    context.on('requestfinished', (req) => {
      if (!recording) return
      void (async () => {
        try {
          const timing = req.timing()
          // responseEnd is -1 for a request the browser served without the
          // network (memory cache); those have no duration worth reporting.
          const durationMs = timing.responseEnd >= 0 ? timing.responseEnd : 0
          const waitMs = timing.responseStart >= 0 ? timing.responseStart : 0
          const resourceType = req.resourceType()
          const isApi = resourceType === 'xhr' || resourceType === 'fetch'
          const method = req.method().toUpperCase()
          const url = req.url().split('#')[0]
          const key = `${method} ${url}`
          const existing = byKey.get(key)
          let bytes = 0
          let status: number | null = null
          try {
            const sizes = await req.sizes()
            bytes = Math.max(0, sizes.responseBodySize)
          } catch {
            /* sizes are best-effort */
          }
          try {
            const res = await req.response()
            status = res ? res.status() : null
          } catch {
            /* a redirected/cancelled request may have no response */
          }
          // The cold load is the one with a story: every byte is fetched and every
          // dependency shows in the order it was discovered. Later loads repeat it
          // from cache, so drawing them would be drawing the cache.
          if (runIndex === 0) {
            const group = coldByType.get(resourceType) ?? { count: 0, bytes: 0 }
            group.count += 1
            group.bytes += bytes
            coldByType.set(resourceType, group)
            if (timeline.length < MAX_TIMELINE) {
              // `timing.startTime` is wall-clock ms, so the offset is relative to
              // the goto that started this navigation — not to some browser epoch.
              const startMs = navStart > 0 ? Math.max(0, timing.startTime - navStart) : 0
              timeline.push({
                method,
                url,
                resourceType,
                api: isApi,
                startMs,
                endMs: startMs + Math.max(0, durationMs),
                bytes,
                status,
              })
            }
          }
          if (existing) {
            existing.count++
            existing.totalMs += durationMs
            existing.maxMs = Math.max(existing.maxMs, durationMs)
            existing.totalWaitMs += waitMs
            existing.totalBytes += bytes
            if (status !== null) existing.status = status
            return
          }
          if (isApi ? apiTracked >= MAX_TRACKED_API : otherTracked >= MAX_TRACKED_OTHER) {
            if (isApi) droppedApi++
            else droppedOther++
            return
          }
          if (isApi) apiTracked++
          else otherTracked++
          byKey.set(key, {
            method,
            url,
            resourceType,
            status,
            count: 1,
            totalMs: durationMs,
            maxMs: durationMs,
            totalWaitMs: waitMs,
            totalBytes: bytes,
            api: isApi,
          })
        } catch {
          /* one bad request must never abort the audit */
        }
      })()
    })

    const page = context.pages()[0] ?? (await context.newPage())

    // Uncaught exceptions and error-level console lines. Neither shows up in any
    // timing: a page that throws on mount still fires `load` on schedule.
    page.on('pageerror', (err) => {
      if (recording) noteIssue('pageerror', err.message)
    })
    page.on('console', (msg) => {
      if (recording && msg.type() === 'error') noteIssue('console', msg.text())
    })

    const perRun: PageLoadMetrics[] = []
    let finalUrl = ''

    for (let i = 0; i < runs; i++) {
      if (opts.signal?.aborted) throw new Error('cancelled')
      opts.onLog('info', `Load ${i + 1}/${runs} — navigating to ${opts.url}`)
      runIndex = i
      navStart = Date.now()
      recording = true
      try {
        await page.goto(opts.url, { waitUntil: 'load', timeout: 60_000 })
      } catch (err) {
        const msg = err instanceof Error ? err.message.split('\n')[0] : 'navigation failed'
        opts.onLog('error', `Load ${i + 1} — ${msg}`)
        // A timeout still leaves a partly-loaded page worth measuring; a hard
        // failure (DNS, refused) leaves nothing, and metrics come back as zeros.
      }
      if (settleMs > 0) {
        opts.onLog('info', `Load ${i + 1} — watching ${Math.round(settleMs / 100) / 10}s for late API calls…`)
        await page.waitForTimeout(settleMs)
      }
      recording = false

      let metrics = emptyMetrics()
      try {
        metrics = await collectMetrics(page)
      } catch {
        opts.onLog('error', `Load ${i + 1} — could not read browser timings`)
      }
      perRun.push(metrics)
      finalUrl = page.url()
      opts.onLog(
        'success',
        `Load ${i + 1} — page load ${Math.round(metrics.loadMs)}ms · TTFB ${Math.round(metrics.ttfbMs)}ms · LCP ${Math.round(metrics.lcpMs)}ms${
          i === 0 ? ' (cold — empty cache)' : ''
        }`,
      )
    }

    // Say precisely what was dropped: "the table is capped" reads as "some rows are
    // missing" when the truth is usually "we stopped listing static assets", which
    // changes nothing about the API findings.
    if (droppedOther) {
      opts.onLog(
        'info',
        `Listing the first ${MAX_TRACKED_OTHER} static assets only (${droppedOther} more were loaded). API calls are unaffected.`,
      )
    }
    if (droppedApi) {
      opts.onLog(
        'error',
        `More than ${MAX_TRACKED_API} distinct API calls — ${droppedApi} were not counted, so the duplicate check may under-report.`,
      )
    }

    // ---- aggregate
    const aggs = [...byKey.values()]
    const requests: AuditRequest[] = aggs
      .map((a) => ({
        method: a.method,
        url: a.url,
        resourceType: a.resourceType,
        status: a.status,
        count: a.count,
        perLoad: a.count / runs,
        avgMs: a.count ? a.totalMs / a.count : 0,
        maxMs: a.maxMs,
        avgWaitMs: a.count ? a.totalWaitMs / a.count : 0,
        avgBytes: a.count ? a.totalBytes / a.count : 0,
        api: a.api,
      }))
      // APIs first, then the noisiest, then the slowest — the order an engineer
      // reads the table in when hunting a duplicate call.
      .sort((x, y) => {
        if (x.api !== y.api) return x.api ? -1 : 1
        if (y.count !== x.count) return y.count - x.count
        return y.avgMs - x.avgMs
      })

    const dupMap = new Map<string, DuplicateEndpoint & { totalMs: number }>()
    for (const a of aggs) {
      if (!a.api) continue // a page legitimately loads many images; APIs are the question
      const endpoint = endpointOf(a.url)
      const key = `${a.method} ${endpoint}`
      const existing = dupMap.get(key)
      if (existing) {
        existing.count += a.count
        existing.totalMs += a.totalMs
        if (existing.urls.length < MAX_DUPLICATE_URLS) existing.urls.push(a.url)
      } else {
        dupMap.set(key, {
          method: a.method,
          endpoint,
          count: a.count,
          perLoad: 0,
          urls: [a.url],
          avgMs: 0,
          totalMsPerLoad: 0,
          totalMs: a.totalMs,
        })
      }
    }
    const duplicates: DuplicateEndpoint[] = [...dupMap.values()]
      .map((d) => ({
        method: d.method,
        endpoint: d.endpoint,
        count: d.count,
        perLoad: d.count / runs,
        urls: d.urls,
        avgMs: d.count ? d.totalMs / d.count : 0,
        totalMsPerLoad: d.totalMs / runs,
      }))
      // "More than once per page load" is the flag. A single call per load is
      // normal; 2+ means the app asked the same question twice.
      .filter((d) => d.perLoad >= 2)
      .sort((a, b) => b.perLoad - a.perLoad || b.totalMsPerLoad - a.totalMsPerLoad)

    const apiRequests = requests.filter((r) => r.api)
    const redirected = isRedirect(opts.url, finalUrl)
    const cold = perRun[0] ?? emptyMetrics()
    const laterRuns = perRun.slice(1)
    const warm = laterRuns.length ? medianMetrics(laterRuns) : cold
    const resources = [...coldByType.entries()]
      .map(([type, g]) => ({ type, count: g.count, bytes: g.bytes }))
      .sort((a, b) => b.bytes - a.bytes || b.count - a.count)
    const result: PageAuditResult = {
      url: opts.url,
      runs,
      finalUrl,
      redirected,
      perRun,
      average: averageMetrics(perRun),
      cold,
      warm,
      warmRuns: laterRuns.length,
      issues: [...issueMap.values()].sort((a, b) => b.count - a.count),
      resources,
      timeline: timeline.sort((a, b) => a.startMs - b.startMs),
      requests,
      duplicates,
      totals: {
        // From the browser's own resource timeline, not the (asset-capped) table,
        // so a page with 900 module files still reports 900.
        requestCount: perRun.reduce((s, r) => s + r.requestCount, 0),
        apiCount: apiRequests.reduce((s, r) => s + r.count, 0),
        apiEndpointCount: dupMap.size,
        transferBytes: averageMetrics(perRun).transferBytes,
        slowestApiMs: apiRequests.reduce((m, r) => Math.max(m, r.maxMs), 0),
      },
    }

    // The gap between a first visit and a returning one is a finding in its own
    // right, and stating it here stops the two being read as one number later.
    if (laterRuns.length && cold.loadMs > 0) {
      opts.onLog(
        'info',
        `First visit ${Math.round(cold.loadMs)}ms · returning visit ${Math.round(warm.loadMs)}ms (median of ${laterRuns.length}).`,
      )
    }

    const pageErrors = [...issueMap.values()].filter((i) => i.kind === 'pageerror')
    if (pageErrors.length) {
      opts.onLog(
        'error',
        `${pageErrors.length} uncaught JavaScript error${pageErrors.length === 1 ? '' : 's'} while loading — the first is: ${pageErrors[0].text.slice(0, 120)}`,
      )
    }

    // Say this BEFORE the duplicate verdict: on a login screen "no endpoint was
    // called twice" is true and completely beside the point.
    if (redirected) {
      opts.onLog(
        'error',
        `The browser ended up on ${finalUrl} — not the URL you asked for. ${
          opts.useProfile
            ? 'The saved session has probably expired; log in again in the QC browser profile.'
            : 'Tick "Use the logged-in profile" — a clean browser has no session, so a page behind a login redirects.'
        } Everything below describes that page, not yours.`,
      )
    } else if (result.totals.apiEndpointCount <= 1) {
      opts.onLog(
        'info',
        `Only ${result.totals.apiEndpointCount} API endpoint was called across ${runs} load${runs === 1 ? '' : 's'} — if this page should be calling more, check that it is logged in.`,
      )
    }

    if (duplicates.length) {
      opts.onLog(
        'error',
        `${duplicates.length} API endpoint${duplicates.length === 1 ? ' is' : 's are'} called more than once per page load.`,
      )
    } else if (!redirected) {
      // After a redirect the all-clear describes the login screen — saying it in
      // the success voice is how a wrong answer gets believed.
      opts.onLog('success', 'No API endpoint was called more than once per page load.')
    }

    return result
  } finally {
    recording = false
    await context.close().catch(() => {})
    if (ownedBrowser) await ownedBrowser.close().catch(() => {})
  }
}
