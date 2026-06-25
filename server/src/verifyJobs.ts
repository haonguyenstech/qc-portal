import { randomUUID } from 'node:crypto'
import { insertDesignCheck } from './db.js'
import { verifyDesign, type DesignFinding } from './verifyDesign.js'

// In-memory background jobs for Design Check (verify-design). A job runs server-side,
// so it keeps going even if the browser reloads or navigates away — the client just
// polls by id to show progress + the live log. Jobs live for the life of the server
// process (a server restart drops them); that's enough to survive browser reloads.
//
// A verify run is a SINGLE Claude run (one ticket against one Figma design), so —
// unlike test-case generation — there's no batch and no pause/resume. The job is
// either running, done, errored, or cancelled.

/** Where a verify job sits. `done`/`error`/`cancelled` are terminal. */
export type VerifyJobStatus = 'running' | 'done' | 'error' | 'cancelled'

export type VerifyLogLevel = 'info' | 'success' | 'error'

export interface VerifyLogLine {
  time: string // ISO
  level: VerifyLogLevel
  text: string
}

/** The findings payload, surfaced to the client once the job finishes. */
export interface VerifyJobResult {
  summary: string
  findings: DesignFinding[]
  model: string
  savedPath: string | null
  savedAt: string | null
  recordId: string | null
}

const MAX_LOG_LINES = 800 // keep the per-job log bounded

interface VerifyJob {
  id: string
  projectId: string
  projectName: string
  rootPath: string
  folder: string
  figmaUrl: string
  instructions: string
  model: string
  checklistOverride?: string
  status: VerifyJobStatus
  logs: VerifyLogLine[]
  result: VerifyJobResult | null
  error: string | null
  createdAt: string
  updatedAt: string
  // --- control (server-only) ---
  /** Aborts the in-flight Claude run so a cancel takes effect promptly. */
  abort: AbortController | null
}

/** What we expose to the client — never the rootPath / instructions / checklist / control. */
export interface PublicVerifyJob {
  id: string
  projectId: string
  folder: string
  figmaUrl: string
  model: string
  status: VerifyJobStatus
  logs: VerifyLogLine[]
  result: VerifyJobResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, VerifyJob>()
const MAX_JOBS = 50 // keep the registry bounded; prune oldest finished jobs

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: VerifyJob): PublicVerifyJob {
  return {
    id: j.id,
    projectId: j.projectId,
    folder: j.folder,
    figmaUrl: j.figmaUrl,
    model: j.model,
    status: j.status,
    logs: j.logs.map((l) => ({ ...l })),
    result: j.result ? { ...j.result, findings: j.result.findings.map((f) => ({ ...f })) } : null,
    error: j.error,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }
}

function pushLog(job: VerifyJob, level: VerifyLogLevel, text: string): void {
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

/** Run the single verify, streaming progress into the job's log. Never throws. */
async function runJob(job: VerifyJob): Promise<void> {
  const ac = new AbortController()
  job.abort = ac
  pushLog(job, 'info', `▶ ${job.folder} — verifying against Figma · model ${job.model}`)
  try {
    const r = await verifyDesign({
      rootPath: job.rootPath,
      projectName: job.projectName,
      folder: job.folder,
      figmaUrl: job.figmaUrl,
      instructions: job.instructions,
      model: job.model,
      checklistOverride: job.checklistOverride,
      signal: ac.signal,
      onLog: (l) => pushLog(job, l.level, l.text),
    })

    // Record the run in the DB (the markdown report was already written to disk by
    // verifyDesign). Persistence must never sink the result.
    let recordId: string | null = null
    try {
      recordId = insertDesignCheck({
        projectId: job.projectId,
        folder: job.folder,
        figmaUrl: job.figmaUrl,
        model: r.model,
        summary: r.summary,
        findings: r.findings,
        filePath: r.savedPath,
      }).id
    } catch {
      /* recording is best-effort */
    }

    job.result = {
      summary: r.summary,
      findings: r.findings,
      model: r.model,
      savedPath: r.savedPath,
      savedAt: r.savedAt,
      recordId,
    }
    job.status = 'done'
    pushLog(
      job,
      'success',
      `✓ ${job.folder} — ${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}${
        r.savedPath ? ` · saved ${r.savedPath}` : ''
      }`,
    )
  } catch (err) {
    if (ac.signal.aborted) {
      job.status = 'cancelled'
      pushLog(job, 'info', `■ ${job.folder} — cancelled`)
    } else {
      job.status = 'error'
      job.error = (err as Error).message || 'Verification failed'
      pushLog(job, 'error', `✗ ${job.folder} — ${job.error}`)
    }
  } finally {
    job.abort = null
    job.updatedAt = nowIso()
  }
}

/** Guard runJob so an unexpected throw can't crash the process or wedge the job. */
function runJobSafely(job: VerifyJob): void {
  runJob(job).catch((err) => {
    job.abort = null
    job.status = 'error'
    job.error = (err as Error).message || 'Verification failed'
    pushLog(job, 'error', `Job aborted — ${(err as Error).message || 'unexpected error'}`)
  })
}

export function startVerifyJob(opts: {
  projectId: string
  projectName: string
  rootPath: string
  folder: string
  figmaUrl: string
  instructions: string
  model: string
  checklistOverride?: string
}): PublicVerifyJob {
  const job: VerifyJob = {
    id: randomUUID(),
    projectId: opts.projectId,
    projectName: opts.projectName,
    rootPath: opts.rootPath,
    folder: opts.folder,
    figmaUrl: opts.figmaUrl,
    instructions: opts.instructions,
    model: opts.model,
    checklistOverride: opts.checklistOverride,
    status: 'running',
    logs: [],
    result: null,
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    abort: null,
  }
  jobs.set(job.id, job)
  prune()

  // Fire and forget — the route returns immediately.
  runJobSafely(job)

  return toPublic(job)
}

export function getVerifyJob(id: string): PublicVerifyJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

/** Cancel a running job (terminal) — kill the in-flight Claude run. No-op when done. */
export function cancelVerifyJob(id: string): PublicVerifyJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'running') j.abort?.abort()
  return toPublic(j)
}

export function listVerifyJobs(projectId: string): PublicVerifyJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}
