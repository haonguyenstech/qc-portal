import { randomUUID } from 'node:crypto'
import { auditPageLoad, type PageAuditResult } from './pageAudit.js'
import {
  removeK6RunDir,
  runK6,
  type K6RunHandle,
  type K6TestConfig,
  type LoadTestResult,
} from './k6.js'

/**
 * In-memory background jobs for the Performance page — one registry, two kinds:
 *
 *   • `load` — a k6 run (`k6.ts`)
 *   • `page` — a browser page-load audit (`pageAudit.ts`)
 *
 * Both are slow (a load test runs for minutes by definition), so both run
 * server-side and are POLLED by id rather than streamed: the engineer can start a
 * 5-minute soak, go read a ticket, and come back to the finished report. Same
 * pattern as `testcaseJobs.ts` / `verifyJobs.ts` — jobs live for the life of the
 * server process, which is enough to survive a browser reload.
 *
 * The public shape deliberately omits the k6 config's headers and bodies. Those
 * carry bearer tokens, and a poll response is the easiest place in the whole
 * portal for a credential to leak into a browser devtools log.
 */

export type PerfJobKind = 'load' | 'page'
export type PerfJobStatus = 'running' | 'done' | 'error' | 'cancelled'
export type PerfLogLevel = 'info' | 'success' | 'error'

export interface PerfLogLine {
  time: string
  level: PerfLogLevel
  text: string
}

/** The parts of a load-test config that are safe to echo back to the client. */
export interface PublicLoadConfig {
  name: string
  vus: number
  duration: string
  rampUp: string
  thresholdP95Ms: number
  thresholdErrorRate: number
  endpoints: { name: string; method: string; url: string }[]
}

/** The page-audit inputs, echoed back so a reconnected page can label the report. */
export interface PublicPageConfig {
  url: string
  runs: number
  settleMs: number
  headed: boolean
  useProfile: boolean
}

export interface PublicPerfJob {
  id: string
  projectId: string
  kind: PerfJobKind
  /** Human label for lists — the test name, or the audited URL. */
  label: string
  status: PerfJobStatus
  /** k6's live progress redraw, or the current load number. */
  progress: string
  logs: PerfLogLine[]
  loadConfig: PublicLoadConfig | null
  pageConfig: PublicPageConfig | null
  loadResult: LoadTestResult | null
  pageResult: PageAuditResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

interface PerfJob extends PublicPerfJob {
  // --- control (server-only, never serialized) ---
  k6: K6RunHandle | null
  abort: AbortController | null
}

const jobs = new Map<string, PerfJob>()
const MAX_JOBS = 40
const MAX_LOG_LINES = 600

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: PerfJob): PublicPerfJob {
  const { k6: _k6, abort: _abort, ...rest } = j
  return { ...rest, logs: rest.logs.map((l) => ({ ...l })) }
}

function pushLog(job: PerfJob, level: PerfLogLevel, text: string): void {
  job.logs.push({ time: nowIso(), level, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
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

function newJob(projectId: string, kind: PerfJobKind, label: string): PerfJob {
  return {
    id: randomUUID(),
    projectId,
    kind,
    label,
    status: 'running',
    progress: '',
    logs: [],
    loadConfig: null,
    pageConfig: null,
    loadResult: null,
    pageResult: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    k6: null,
    abort: null,
  }
}

// ------------------------------------------------------------------ load test

/** Strip the credential-bearing fields before the config is ever sent back out. */
function publicLoadConfig(cfg: K6TestConfig): PublicLoadConfig {
  return {
    name: cfg.name,
    vus: cfg.vus,
    duration: cfg.duration,
    rampUp: cfg.rampUp,
    thresholdP95Ms: cfg.thresholdP95Ms,
    thresholdErrorRate: cfg.thresholdErrorRate,
    endpoints: cfg.endpoints.map((e) => ({ name: e.name, method: e.method, url: e.url })),
  }
}

/** Start a k6 load test in the background. Returns immediately. */
export function startLoadJob(projectId: string, cfg: K6TestConfig): PublicPerfJob {
  const job = newJob(projectId, 'load', cfg.name)
  job.loadConfig = publicLoadConfig(cfg)
  jobs.set(job.id, job)
  prune()

  pushLog(
    job,
    'info',
    `Starting k6 — ${cfg.vus} VU${cfg.vus === 1 ? '' : 's'}${cfg.rampUp ? ` (ramp ${cfg.rampUp})` : ''} for ${cfg.duration} across ${cfg.endpoints.length} endpoint${cfg.endpoints.length === 1 ? '' : 's'}.`,
  )

  const handle = runK6({
    id: job.id,
    cfg,
    onLine: (level, text) => pushLog(job, level, text),
    onProgress: (text) => {
      job.progress = text
      job.updatedAt = nowIso()
    },
  })
  job.k6 = handle

  handle.done
    .then(({ result, error, exitCode }) => {
      job.k6 = null
      job.progress = ''
      if (job.status === 'cancelled') {
        pushLog(job, 'info', 'Cancelled.')
        return
      }
      if (error || !result) {
        job.status = 'error'
        job.error = error ?? `k6 exited with code ${exitCode}`
        pushLog(job, 'error', job.error)
        return
      }
      job.loadResult = result
      job.status = 'done'
      const p95 = Math.round(result.overall.p95)
      const fail = (result.failRate * 100).toFixed(2)
      pushLog(
        job,
        result.thresholdsPassed ? 'success' : 'error',
        `Done — ${result.requests} requests · p95 ${p95}ms · ${fail}% failed${result.thresholdsPassed ? '' : ' · thresholds crossed'}`,
      )
    })
    .catch((err) => {
      job.k6 = null
      job.status = 'error'
      job.error = err instanceof Error ? err.message : 'load test failed'
      pushLog(job, 'error', job.error)
    })

  return toPublic(job)
}

// ------------------------------------------------------------------ page audit

export interface PageJobOptions {
  url: string
  runs: number
  settleMs: number
  headed: boolean
  useProfile: boolean
}

/**
 * Start a browser page-load audit in the background.
 *
 * Unlike the k6 path this can fail before there is anything to poll (Chrome
 * missing, profile locked), so the launch error is thrown to the caller: the route
 * turns it into a 400 the form shows inline, rather than a job that exists only to
 * report that it never started.
 */
export async function startPageJob(
  projectId: string,
  opts: PageJobOptions,
): Promise<PublicPerfJob> {
  const job = newJob(projectId, 'page', opts.url)
  job.pageConfig = { ...opts }
  const abort = new AbortController()
  job.abort = abort

  // Resolved by the first log line the audit emits, which only happens once the
  // browser is up — so a launch failure still rejects instead of hanging.
  let started = false
  let resolveStart: () => void = () => {}
  let rejectStart: (err: Error) => void = () => {}
  const launch = new Promise<void>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })

  const run = auditPageLoad({
    ...opts,
    signal: abort.signal,
    onLog: (level, text) => {
      if (!started) {
        started = true
        jobs.set(job.id, job)
        prune()
        resolveStart()
      }
      pushLog(job, level, text)
    },
  })

  run
    .then((result) => {
      job.abort = null
      if (job.status === 'cancelled') return
      job.pageResult = result
      job.status = 'done'
      pushLog(
        job,
        'success',
        `Done — average page load ${Math.round(result.average.loadMs)}ms over ${result.runs} load${result.runs === 1 ? '' : 's'}.`,
      )
    })
    .catch((err) => {
      job.abort = null
      const message = err instanceof Error ? err.message : 'page audit failed'
      if (!started) {
        rejectStart(new Error(message))
        return
      }
      if (job.status === 'cancelled') {
        pushLog(job, 'info', 'Cancelled.')
        return
      }
      job.status = 'error'
      job.error = message
      pushLog(job, 'error', message)
    })

  await launch
  return toPublic(job)
}

// ------------------------------------------------------------------ registry

export function getPerfJob(id: string): PublicPerfJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

export function listPerfJobs(projectId: string): PublicPerfJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}

/** Stop a running job. Terminal and idempotent. */
export function cancelPerfJob(id: string): PublicPerfJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'running') {
    j.status = 'cancelled'
    j.progress = ''
    j.updatedAt = nowIso()
    j.k6?.kill()
    j.abort?.abort()
    pushLog(j, 'info', 'Stopping…')
  }
  return toPublic(j)
}

/**
 * Forget a run entirely — the row, its log, its report, and (for a load test) the
 * generated script beside the DB.
 *
 * A RUNNING job is cancelled on the way out rather than refused: the button is
 * meant to say "I'm done with this", and a delete that left a k6 child or an
 * audit Chrome alive would leave a process reporting into an object nothing can
 * read — and, for an audit, a stray Chrome holding the profile lock every later
 * run needs. Idempotent: an id that is already gone reports `false`, so a
 * double-click is not a 404 in the engineer's face.
 */
export function deletePerfJob(id: string): boolean {
  const j = jobs.get(id)
  if (!j) return false
  if (j.status === 'running') {
    j.status = 'cancelled'
    j.k6?.kill()
    j.abort?.abort()
  }
  jobs.delete(id)
  if (j.kind === 'load') removeK6RunDir(id)
  return true
}

/** Kill every in-flight perf job — called on server shutdown. */
export function shutdownPerfJobs(): number {
  let n = 0
  for (const j of jobs.values()) {
    if (j.status !== 'running') continue
    j.status = 'cancelled'
    j.k6?.kill()
    j.abort?.abort()
    n++
  }
  return n
}
