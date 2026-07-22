import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { BrowserContext } from 'playwright-core'

// In-memory background jobs for "Scan a page for its APIs". A job opens a real,
// headed Chrome (using the QC's existing logged-in profile) and records the XHR/
// fetch traffic the page makes, so the engineer can watch it load / log in and
// then import the detected endpoints into API Testing. The browser stays open
// until the engineer clicks "Stop & preview" (or closes the window), so an
// authenticated admin page can be reached before capture ends.
//
// Mirrors the crawlJobs.ts / testcaseJobs.ts pattern: server-side, polled by id,
// survives a browser reload; a server restart drops it. Playwright is imported
// lazily + defensively so a missing/broken install degrades to a clear error
// instead of crashing the portal (same posture as terminal.ts + node-pty).

export interface DetectedRequest {
  id: string
  method: string
  url: string
  resourceType: string // 'xhr' | 'fetch'
  status?: number
  contentType?: string
  requestContentType?: string
  hasBody: boolean
  bodyPreview?: string // truncated request body (for write methods)
  count: number // how many times this method+url was seen
  at: string
}

export type ScanLogLevel = 'info' | 'success' | 'error'
export interface ScanLogLine {
  time: string
  level: ScanLogLevel
  text: string
}

interface ScanJob {
  id: string
  projectId: string
  url: string
  headless: boolean
  status: 'running' | 'done' | 'error'
  error?: string
  requests: DetectedRequest[]
  byKey: Map<string, DetectedRequest>
  logs: ScanLogLine[]
  createdAt: string
  updatedAt: string
  // internals — never exposed to the client
  context: BrowserContext | null
  safetyTimer: ReturnType<typeof setTimeout> | null
  idleTimer: ReturnType<typeof setInterval> | null
  startedAtMs: number
  lastActivityMs: number
  finalized: boolean
}

export interface PublicScanJob {
  id: string
  projectId: string
  url: string
  headless: boolean
  status: 'running' | 'done' | 'error'
  error?: string
  requests: DetectedRequest[]
  logs: ScanLogLine[]
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, ScanJob>()
const MAX_JOBS = 20
const MAX_LOG_LINES = 400
const MAX_REQUESTS = 500
const MAX_BODY_PREVIEW = 8192
const SAFETY_TIMEOUT_MS = 10 * 60_000 // auto-stop a forgotten headed browser after 10 min
// Headless has no human to click Stop, so it auto-finishes once the page goes quiet.
const HEADLESS_QUIET_MS = 3000 // stop after this long with no new API calls…
const HEADLESS_MIN_MS = 2500 // …but capture at least this long first
const HEADLESS_MAX_MS = 45_000 // …and never run longer than this

function nowIso(): string {
  return new Date().toISOString()
}

function pushLog(job: ScanJob, level: ScanLogLevel, text: string): void {
  job.logs.push({ time: nowIso(), level, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
}

function toPublic(j: ScanJob): PublicScanJob {
  return {
    id: j.id,
    projectId: j.projectId,
    url: j.url,
    headless: j.headless,
    status: j.status,
    error: j.error,
    requests: j.requests.map((r) => ({ ...r })),
    logs: j.logs.map((l) => ({ ...l })),
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(j.id)
  }
}

/** Where the persistent Chrome profile lives — defaults to the Playwright-MCP
 *  profile so the scan inherits the engineer's existing login session. */
function scanProfileDir(): string {
  return process.env.QC_SCAN_PROFILE_DIR || path.join(os.homedir(), '.pw-agent-profile')
}

// Lazy playwright-core handle (cached once resolved).
let chromiumMod: typeof import('playwright-core').chromium | null = null
async function loadChromium(): Promise<typeof import('playwright-core').chromium> {
  if (chromiumMod) return chromiumMod
  const mod = await import('playwright-core')
  chromiumMod = mod.chromium
  return chromiumMod
}

/** Whether page scanning is usable on this machine (playwright-core loads). */
export async function scanAvailable(): Promise<{ ok: boolean; error?: string }> {
  try {
    await loadChromium()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'playwright-core not available' }
  }
}

/** Record (or bump) one detected API request onto the job. */
function record(job: ScanJob, entry: Omit<DetectedRequest, 'id' | 'count' | 'at'>): void {
  const urlNoHash = entry.url.split('#')[0]
  const key = `${entry.method} ${urlNoHash}`
  job.lastActivityMs = Date.now()
  const existing = job.byKey.get(key)
  if (existing) {
    existing.count++
    // Keep the latest status/content-type we saw for this endpoint.
    if (entry.status !== undefined) existing.status = entry.status
    if (entry.contentType) existing.contentType = entry.contentType
    existing.at = nowIso()
    job.updatedAt = nowIso()
    return
  }
  if (job.requests.length >= MAX_REQUESTS) return
  const rec: DetectedRequest = { id: randomUUID(), count: 1, at: nowIso(), ...entry, url: urlNoHash }
  job.byKey.set(key, rec)
  job.requests.push(rec)
  pushLog(job, 'info', `${rec.method} ${rec.url}`)
}

function finalize(job: ScanJob, level: ScanLogLevel, text: string): void {
  if (job.finalized) return
  job.finalized = true
  if (job.safetyTimer) {
    clearTimeout(job.safetyTimer)
    job.safetyTimer = null
  }
  if (job.idleTimer) {
    clearInterval(job.idleTimer)
    job.idleTimer = null
  }
  if (job.status === 'running') job.status = 'done'
  pushLog(job, level, text)
  const ctx = job.context
  job.context = null
  if (ctx) void ctx.close().catch(() => {})
}

/**
 * Launch a headed Chrome (persistent, logged-in profile), navigate to `url`, and
 * begin recording XHR/fetch traffic. Resolves once the browser is open and
 * navigating; capture continues until stopScanJob() / the window is closed.
 * Throws on a launch failure (bad Chrome / profile locked) so the route can
 * surface it immediately.
 */
export async function startScanJob(opts: {
  projectId: string
  url: string
  headless?: boolean
}): Promise<PublicScanJob> {
  const chromium = await loadChromium()
  const headless = opts.headless !== false // default to no visible window

  const job: ScanJob = {
    id: randomUUID(),
    projectId: opts.projectId,
    url: opts.url,
    headless,
    status: 'running',
    requests: [],
    byKey: new Map(),
    logs: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    context: null,
    safetyTimer: null,
    idleTimer: null,
    startedAtMs: Date.now(),
    lastActivityMs: Date.now(),
    finalized: false,
  }

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(scanProfileDir(), {
      headless,
      channel: 'chrome',
      viewport: headless ? { width: 1440, height: 900 } : null,
      args: headless ? [] : ['--start-maximized'],
    })
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const friendly = /ProcessSingleton|SingletonLock|already (in use|running)|being used/i.test(raw)
      ? 'That Chrome profile is already open. Close the other Chrome/QC browser window using it and try again.'
      : /Executable doesn't exist|channel .*chrome|No such file/i.test(raw)
        ? 'Google Chrome was not found. Install Chrome (the scan reuses your system Chrome).'
        : raw
    throw new Error(friendly)
  }

  job.context = context
  jobs.set(job.id, job)
  prune()
  pushLog(job, 'info', headless ? `Loading ${opts.url} (no window)…` : `Opened Chrome — loading ${opts.url}`)

  const isApi = (type: string) => type === 'xhr' || type === 'fetch'

  context.on('request', (req) => {
    try {
      if (!isApi(req.resourceType())) return
      const method = req.method().toUpperCase()
      const write = method !== 'GET' && method !== 'HEAD'
      const post = write ? req.postData() : null
      const reqHeaders = req.headers()
      record(job, {
        method,
        url: req.url(),
        resourceType: req.resourceType(),
        requestContentType: reqHeaders['content-type'],
        hasBody: !!post,
        bodyPreview: post ? post.slice(0, MAX_BODY_PREVIEW) : undefined,
      })
    } catch {
      /* a single bad request must never break capture */
    }
  })

  context.on('response', (res) => {
    try {
      const req = res.request()
      if (!isApi(req.resourceType())) return
      record(job, {
        method: req.method().toUpperCase(),
        url: req.url(),
        resourceType: req.resourceType(),
        status: res.status(),
        contentType: res.headers()['content-type'],
        hasBody: false,
      })
    } catch {
      /* ignore */
    }
  })

  // The engineer closing the window ends the scan.
  context.on('close', () => finalize(job, 'success', 'Browser closed — capture ended.'))

  if (headless) {
    // No human to click Stop: auto-finish once the page stops calling APIs.
    job.idleTimer = setInterval(() => {
      if (job.finalized) return
      const sinceStart = Date.now() - job.startedAtMs
      const sinceActivity = Date.now() - job.lastActivityMs
      if (sinceStart >= HEADLESS_MAX_MS || (sinceStart >= HEADLESS_MIN_MS && sinceActivity >= HEADLESS_QUIET_MS)) {
        finalize(job, 'success', `Done — ${job.requests.length} API request(s) detected.`)
      }
    }, 750)
  } else {
    // Safety net: never leave a headed browser open forever.
    job.safetyTimer = setTimeout(
      () => finalize(job, 'info', 'Auto-stopped after 10 minutes.'),
      SAFETY_TIMEOUT_MS,
    )
  }

  // Navigate on the first (already-open) page. Don't fail the job if the nav is
  // slow or blocked — capture keeps running and the engineer can navigate manually.
  const page = context.pages()[0] ?? (await context.newPage())
  page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((err) => {
    pushLog(job, 'error', `Navigation issue: ${err instanceof Error ? err.message : 'failed'}`)
  })

  return toPublic(job)
}

/** Stop capture, close the browser, and mark the job done. Idempotent. */
export function stopScanJob(id: string): PublicScanJob | undefined {
  const job = jobs.get(id)
  if (!job) return undefined
  finalize(job, 'success', `Stopped — ${job.requests.length} API request(s) detected.`)
  return toPublic(job)
}

export function getScanJob(id: string): PublicScanJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}
