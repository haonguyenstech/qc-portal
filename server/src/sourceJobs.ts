import { randomUUID } from 'node:crypto'
import { saveSource } from './db.js'
import { generateSourceMap, hasSourceMap, sourceMapDocName } from './sourceMap.js'
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
  sourceId: string // the sources-table row this job creates/updates
  tag: string // "Backend repo", "Frontend repo", …
  sourceCreatedAt: string // preserved on re-clone so card order stays stable
  rootPath: string
  targetDir: string // where a clone should land (per-tag folder)
  sourcePath: string // known up-front for sync; filled after clone
  prevCommit: string // HEAD before a sync — lets an unchanged sync skip the map refresh
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
  sourceId: string
  tag: string
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
    sourceId: j.sourceId,
    tag: j.tag,
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
            targetDir: job.targetDir,
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
    // Persist the connection FIRST so a failed map step can't lose it.
    saveSource({
      id: job.sourceId,
      projectId: job.projectId,
      tag: job.tag,
      repoUrl: job.parsed.cleanUrl,
      provider: job.parsed.provider,
      branch: result.branch,
      sourcePath: result.sourcePath,
      lastSync: nowIso(),
      lastCommit: result.lastCommit,
      createdAt: job.sourceCreatedAt,
    })

    // Refresh the repo's SOURCE MAP (a compact AI index saved into testing/knowledge/
    // so future test-case generations & QC runs jump straight to the right files
    // instead of re-exploring the repo). Skipped when a sync brought nothing new.
    const unchanged =
      job.kind === 'sync' &&
      job.prevCommit !== '' &&
      job.prevCommit === result.lastCommit &&
      hasSourceMap(job.rootPath, job.tag)
    if (unchanged) {
      pushLog(job, 'info', 'Source unchanged — keeping the existing source map.')
    } else {
      pushLog(
        job,
        'info',
        `Indexing the repo → testing/knowledge/${sourceMapDocName(job.tag)}.md (${job.tag}, one cheap AI pass so future runs don't re-read the code)…`,
      )
      const map = await generateSourceMap({
        rootPath: job.rootPath,
        sourcePath: result.sourcePath,
        tag: job.tag,
        repoUrl: job.parsed.cleanUrl,
        onLog: (l) => pushLog(job, l.level, l.text),
      })
      if (map) {
        pushLog(job, 'success', `Source map saved — see Instructions → Knowledge ("${map.name}").`)
      } else {
        pushLog(job, 'info', 'Source map skipped — generations will explore the repo directly.')
      }
    }

    job.status = 'done'
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
  sourceId: string
  tag: string
  sourceCreatedAt: string
  rootPath: string
  targetDir?: string
  sourcePath?: string
  prevCommit?: string
  parsed: ParsedRepo
  cred: SourceCredential | undefined
  branch?: string
}): PublicSourceJob {
  const job: SourceJob = {
    id: randomUUID(),
    kind: opts.kind,
    projectId: opts.projectId,
    sourceId: opts.sourceId,
    tag: opts.tag,
    sourceCreatedAt: opts.sourceCreatedAt,
    rootPath: opts.rootPath,
    targetDir: opts.targetDir ?? '',
    sourcePath: opts.sourcePath ?? '',
    prevCommit: opts.prevCommit ?? '',
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

/** True while any clone/sync is running for this project (one job at a time). */
export function hasRunningSourceJob(projectId: string): boolean {
  return [...jobs.values()].some((j) => j.projectId === projectId && j.status === 'running')
}
