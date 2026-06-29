import { randomUUID } from 'node:crypto'
import { setProjectSource } from './db.js'
import {
  cloneSource,
  pullSource,
  type GitLogLine,
  type ParsedRepo,
  type SourceCredential,
} from './sourceRepo.js'

// In-memory background jobs for cloning / syncing a project's source repo. Like
// crawlJobs/testcaseJobs: the job runs server-side so it survives a browser reload
// or navigation; the client polls by id. A server restart drops the job (but the
// clone on disk and the persisted projects.source* fields remain).

export type SourceJobKind = 'clone' | 'sync'
export type SourceLogLevel = GitLogLine['level']

export interface SourceLogLine {
  time: string // ISO
  level: SourceLogLevel
  text: string
}

const MAX_LOG_LINES = 800

interface SourceJob {
  id: string
  kind: SourceJobKind
  projectId: string
  rootPath: string
  sourcePath: string // known up-front for sync; filled after clone
  parsed: ParsedRepo
  cred: SourceCredential | undefined // captured at start; never exposed
  branch: string
  logs: SourceLogLine[]
  status: 'running' | 'done' | 'error'
  error?: string
  result?: { sourcePath: string; branch: string; lastCommit: string }
  createdAt: string
  updatedAt: string
}

/** What the client sees — never the cred, rootPath, or parsed url object. */
export interface PublicSourceJob {
  id: string
  kind: SourceJobKind
  projectId: string
  status: 'running' | 'done' | 'error'
  error?: string
  branch: string
  logs: SourceLogLine[]
  result?: { sourcePath: string; branch: string; lastCommit: string }
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, SourceJob>()
const MAX_JOBS = 50

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: SourceJob): PublicSourceJob {
  return {
    id: j.id,
    kind: j.kind,
    projectId: j.projectId,
    status: j.status,
    error: j.error,
    branch: j.branch,
    logs: j.logs.map((l) => ({ ...l })),
    result: j.result,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }
}

function pushLog(job: SourceJob, level: SourceLogLevel, text: string): void {
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

async function runJob(job: SourceJob): Promise<void> {
  const onLog = (l: GitLogLine) => pushLog(job, l.level, l.text)
  try {
    const result =
      job.kind === 'clone'
        ? await cloneSource({
            rootPath: job.rootPath,
            parsed: job.parsed,
            branch: job.branch || undefined,
            cred: job.cred,
            onLog,
          })
        : await pullSource({
            sourcePath: job.sourcePath,
            parsed: job.parsed,
            branch: job.branch || undefined,
            cred: job.cred,
            onLog,
          })

    job.result = result
    job.status = 'done'
    // Persist the connection so /source reflects it after the job is gone.
    setProjectSource(job.projectId, {
      sourceRepoUrl: job.parsed.cleanUrl,
      sourceProvider: job.parsed.provider,
      sourceBranch: result.branch,
      sourcePath: result.sourcePath,
      sourceLastSync: nowIso(),
      sourceLastCommit: result.lastCommit,
    })
  } catch (err) {
    job.status = 'error'
    job.error = (err as Error).message || `${job.kind} failed`
    pushLog(job, 'error', `✗ ${job.error}`)
  }
  job.updatedAt = nowIso()
}

export function startSourceJob(opts: {
  kind: SourceJobKind
  projectId: string
  rootPath: string
  sourcePath?: string
  parsed: ParsedRepo
  cred: SourceCredential | undefined
  branch?: string
}): PublicSourceJob {
  const job: SourceJob = {
    id: randomUUID(),
    kind: opts.kind,
    projectId: opts.projectId,
    rootPath: opts.rootPath,
    sourcePath: opts.sourcePath ?? '',
    parsed: opts.parsed,
    cred: opts.cred,
    branch: opts.branch ?? '',
    logs: [],
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  jobs.set(job.id, job)
  prune()

  runJob(job).catch((err) => {
    job.status = 'error'
    job.error = (err as Error).message || 'unexpected error'
    pushLog(job, 'error', `Job aborted — ${job.error}`)
  })

  return toPublic(job)
}

export function getSourceJob(id: string): PublicSourceJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

export function listSourceJobs(projectId: string): PublicSourceJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}
