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
  /** The average across runs; what the headline tiles show. */
  average: PageLoadMetrics
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
  }
}

/**
 * Records LCP before any page script runs. It has to be an init script: a
 * PerformanceObserver registered after `load` sees nothing, because LCP entries
 * are only buffered for an observer that asked for them.
 */
const LCP_INIT_SCRIPT = `
(() => {
  try {
    window.__qcLcp = 0
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__qcLcp = Math.max(window.__qcLcp || 0, entry.startTime || 0)
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true })
  } catch (e) {
    /* an old browser without LCP still reports every other metric */
  }
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
    return {
      ttfbMs: nav?.responseStart ?? 0,
      // These are 0 while the event hasn't fired yet; the caller waits for `load`.
      domContentLoadedMs: nav?.domContentLoadedEventEnd ?? 0,
      loadMs: nav?.loadEventEnd ?? 0,
      fcpMs: fcp?.startTime ?? 0,
      lcpMs: (window as unknown as { __qcLcp?: number }).__qcLcp ?? 0,
      transferBytes: transfer,
      requestCount: resources.length + (nav ? 1 : 0),
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

  try {
    await context.addInitScript(LCP_INIT_SCRIPT)

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
          if (existing) {
            existing.count++
            existing.totalMs += durationMs
            existing.maxMs = Math.max(existing.maxMs, durationMs)
            existing.totalWaitMs += waitMs
            existing.totalBytes += bytes
            if (status !== null) existing.status = status
            return
          }
          const isApi = resourceType === 'xhr' || resourceType === 'fetch'
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
    const perRun: PageLoadMetrics[] = []
    let finalUrl = ''

    for (let i = 0; i < runs; i++) {
      if (opts.signal?.aborted) throw new Error('cancelled')
      opts.onLog('info', `Load ${i + 1}/${runs} — navigating to ${opts.url}`)
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
        `Load ${i + 1} — page load ${Math.round(metrics.loadMs)}ms · TTFB ${Math.round(metrics.ttfbMs)}ms · LCP ${Math.round(metrics.lcpMs)}ms`,
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
    const result: PageAuditResult = {
      url: opts.url,
      runs,
      finalUrl,
      redirected,
      perRun,
      average: averageMetrics(perRun),
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
