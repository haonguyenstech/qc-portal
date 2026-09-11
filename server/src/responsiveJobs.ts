import { randomUUID } from 'node:crypto'
import {
  captureResponsive,
  removeResponsiveRunDir,
  responsiveRunDir,
  type DeviceSpec,
  type ResponsiveCaptureResult,
} from './responsiveCapture.js'

/**
 * In-memory background jobs for the device-capture half of `/responsive`.
 *
 * Same shape as `perfJobs.ts` and for the same reason: a sweep across six devices
 * is six page loads plus six screenshots, which is tens of seconds — long enough
 * that holding the HTTP request open would make a browser reload or a nav to
 * another page throw the work away. The client gets an id and polls it.
 *
 * Its own registry rather than a third `kind` in `perfJobs`: that module's public
 * job carries a k6 config and a page-audit result, and adding a third payload to
 * every poll response means every Performance poll ships fields it will never
 * read. The two features share the browser (`pageAudit.loadChromium`), not the
 * bookkeeping.
 *
 * Jobs live for the life of the server process. The screenshots they point at live
 * beside the DB and are deleted with the job — so a pruned job never leaves a
 * folder of PNGs nothing can reach.
 */

export type ResponsiveJobStatus = 'running' | 'done' | 'error' | 'cancelled'
export type ResponsiveLogLevel = 'info' | 'success' | 'error'

export interface ResponsiveLogLine {
  time: string
  level: ResponsiveLogLevel
  text: string
}

/** The inputs, echoed back so a reconnected page can label the report. */
export interface ResponsiveJobConfig {
  url: string
  devices: DeviceSpec[]
  fullPage: boolean
  useProfile: boolean
  waitMs: number
}

export interface PublicResponsiveJob {
  id: string
  projectId: string
  /** The URL — what the list rows are read by. */
  label: string
  status: ResponsiveJobStatus
  /** "3 of 6 — Galaxy S22 Ultra", so a long sweep is not a silent spinner. */
  progress: string
  logs: ResponsiveLogLine[]
  config: ResponsiveJobConfig
  result: ResponsiveCaptureResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

interface ResponsiveJob extends PublicResponsiveJob {
  abort: AbortController | null
}

const jobs = new Map<string, ResponsiveJob>()
const MAX_JOBS = 30
const MAX_LOG_LINES = 400

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: ResponsiveJob): PublicResponsiveJob {
  const { abort: _abort, ...rest } = j
  return { ...rest, logs: rest.logs.map((l) => ({ ...l })) }
}

function pushLog(job: ResponsiveJob, level: ResponsiveLogLevel, text: string): void {
  job.logs.push({ time: nowIso(), level, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
}

/**
 * Keep the newest `MAX_JOBS` finished jobs, and delete the screenshots of the ones
 * that fall off — an evicted job's folder is unreachable the moment its row is
 * gone, and a 12-device sweep is ~20MB of PNG.
 */
function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(j.id)
    removeResponsiveRunDir(j.id)
  }
}

/**
 * Start a capture sweep in the background.
 *
 * Like `startPageJob`, the launch failure (no Chrome, a locked profile) is thrown
 * to the caller instead of becoming a job: a row whose only content is "it never
 * started" is worse than a 400 the form shows inline. The promise resolves as soon
 * as the first device logs, which is after the browser is up.
 */
export async function startResponsiveJob(
  projectId: string,
  config: ResponsiveJobConfig,
): Promise<PublicResponsiveJob> {
  const job: ResponsiveJob = {
    id: randomUUID(),
    projectId,
    label: config.url,
    status: 'running',
    progress: '',
    logs: [],
    config,
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    abort: null,
  }
  const abort = new AbortController()
  job.abort = abort

  let started = false
  let resolveStart: () => void = () => {}
  let rejectStart: (err: Error) => void = () => {}
  const launch = new Promise<void>((resolve, reject) => {
    resolveStart = resolve
    rejectStart = reject
  })

  let done = 0
  const run = captureResponsive({
    ...config,
    outDir: responsiveRunDir(job.id),
    signal: abort.signal,
    onLog: (level, text) => {
      if (!started) {
        started = true
        jobs.set(job.id, job)
        prune()
        resolveStart()
      }
      // Every device logs one "Capturing …" line before it works, so the progress
      // readout is derived from that rather than from a second callback.
      if (level === 'info' && text.startsWith('Capturing ')) {
        job.progress = `${done + 1} of ${config.devices.length} — ${text.slice('Capturing '.length).split(' — ')[0]}`
      } else {
        done++
      }
      pushLog(job, level, text)
    },
  })

  run
    .then((result) => {
      job.abort = null
      job.progress = ''
      if (job.status === 'cancelled') {
        pushLog(job, 'info', 'Cancelled.')
        return
      }
      job.result = result
      job.status = 'done'
      const high = result.captures.reduce(
        (n, c) => n + c.findings.filter((f) => f.severity === 'high').length,
        0,
      )
      if (result.redirected) {
        // The same rule `perfJobs` follows for a redirected audit: the closing line
        // is the one that gets quoted, so it must not report a clean sweep of a
        // login screen as a clean sweep of the page that was asked for.
        pushLog(
          job,
          'error',
          `Finished, but every device ended on ${result.finalUrl} — the findings below describe that page, not the one you asked for.`,
        )
      } else {
        pushLog(
          job,
          high ? 'error' : 'success',
          high
            ? `Done — ${high} serious finding${high === 1 ? '' : 's'} across ${result.captures.length} device${result.captures.length === 1 ? '' : 's'}.`
            : `Done — no serious layout problems on ${result.captures.length} device${result.captures.length === 1 ? '' : 's'}.`,
        )
      }
    })
    .catch((err) => {
      job.abort = null
      job.progress = ''
      const message = err instanceof Error ? err.message : 'capture failed'
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

export function getResponsiveJob(id: string): PublicResponsiveJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

export function listResponsiveJobs(projectId: string): PublicResponsiveJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}

/** Stop a running sweep. Terminal and idempotent. */
export function cancelResponsiveJob(id: string): PublicResponsiveJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'running') {
    j.status = 'cancelled'
    j.progress = ''
    j.updatedAt = nowIso()
    j.abort?.abort()
    pushLog(j, 'info', 'Stopping after the current device…')
  }
  return toPublic(j)
}

/** Forget a sweep — the row, its log, and its screenshots. */
export function deleteResponsiveJob(id: string): boolean {
  const j = jobs.get(id)
  if (!j) return false
  if (j.status === 'running') {
    j.status = 'cancelled'
    j.abort?.abort()
  }
  jobs.delete(id)
  removeResponsiveRunDir(id)
  return true
}

/** Abort every in-flight sweep — called on server shutdown. */
export function shutdownResponsiveJobs(): number {
  let n = 0
  for (const j of jobs.values()) {
    if (j.status !== 'running') continue
    j.status = 'cancelled'
    j.abort?.abort()
    n++
  }
  return n
}
