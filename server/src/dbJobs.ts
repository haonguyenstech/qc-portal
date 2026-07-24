import { randomUUID } from 'node:crypto'
import { saveDatabase } from './db.js'
import { inspectDatabase, type DbConfig, type DbCredential } from './dbConnect.js'
import { dbMapDocName, writeDbMap } from './dbMap.js'

// In-memory background jobs for connecting / syncing a project's database. Like
// sourceJobs: the job runs server-side so it survives a browser reload or
// navigation; the client polls by id. A server restart drops the job (but the
// persisted `databases` row and the db-map knowledge doc remain).

export type DbJobKind = 'connect' | 'sync'
export type DbLogLevel = 'info' | 'success' | 'error'

export interface DbLogLine {
  time: string // ISO
  level: DbLogLevel
  text: string
}

const MAX_LOG_LINES = 400

interface DbJob {
  id: string
  kind: DbJobKind
  projectId: string
  databaseId: string
  tag: string
  createdAtOrig: string // preserved on re-connect so card order stays stable
  rootPath: string
  config: DbConfig
  cred: DbCredential | undefined // captured at start; never exposed
  logs: DbLogLine[]
  status: 'running' | 'done' | 'error'
  error?: string
  result?: { serverVersion: string; tableCount: number; mapDoc: string | null }
  createdAt: string
  updatedAt: string
}

/** What the client sees — never the cred, rootPath, or full config secrets. */
export interface PublicDbJob {
  id: string
  kind: DbJobKind
  projectId: string
  databaseId: string
  tag: string
  status: 'running' | 'done' | 'error'
  error?: string
  logs: DbLogLine[]
  result?: { serverVersion: string; tableCount: number; mapDoc: string | null }
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, DbJob>()
const MAX_JOBS = 50

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: DbJob): PublicDbJob {
  return {
    id: j.id,
    kind: j.kind,
    projectId: j.projectId,
    databaseId: j.databaseId,
    tag: j.tag,
    status: j.status,
    error: j.error,
    logs: j.logs.map((l) => ({ ...l })),
    result: j.result,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  }
}

function pushLog(job: DbJob, level: DbLogLevel, text: string): void {
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

async function runJob(job: DbJob): Promise<void> {
  const target = `${job.config.host}:${job.config.port}/${job.config.database}`
  try {
    pushLog(job, 'info', `${job.kind === 'connect' ? 'Connecting to' : 'Syncing'} ${job.config.kind} — ${target}`)
    const schema = await inspectDatabase(job.config, job.cred)
    pushLog(
      job,
      'success',
      `Connected — ${schema.serverVersion}. Found ${schema.tables.length} table${schema.tables.length === 1 ? '' : 's'}.`,
    )

    // Persist the connection FIRST so a failed map write can't lose it.
    saveDatabase({
      id: job.databaseId,
      projectId: job.projectId,
      tag: job.tag,
      kind: job.config.kind,
      host: job.config.host,
      port: job.config.port,
      dbName: job.config.database,
      username: job.config.username,
      ssl: job.config.ssl,
      lastSync: nowIso(),
      serverVersion: schema.serverVersion,
      tableCount: schema.tables.length,
      createdAt: job.createdAtOrig,
    })

    pushLog(
      job,
      'info',
      `Writing schema map → testing/knowledge/${dbMapDocName(job.tag)}.md (so future test-case & QC runs know the real tables/columns)…`,
    )
    const map = writeDbMap({
      rootPath: job.rootPath,
      tag: job.tag,
      config: job.config,
      schema,
    })
    if (map) {
      pushLog(job, 'success', `Schema map saved — see Instructions → Knowledge ("${map.name}").`)
    } else {
      pushLog(job, 'info', 'Schema map could not be written (empty schema?) — skipped.')
    }

    job.result = { serverVersion: schema.serverVersion, tableCount: schema.tables.length, mapDoc: map?.name ?? null }
    job.status = 'done'
  } catch (err) {
    job.status = 'error'
    job.error = (err as Error).message || `${job.kind} failed`
    pushLog(job, 'error', `✗ ${job.error}`)
  }
  job.updatedAt = nowIso()
}

export function startDbJob(opts: {
  kind: DbJobKind
  projectId: string
  databaseId: string
  tag: string
  createdAtOrig: string
  rootPath: string
  config: DbConfig
  cred: DbCredential | undefined
}): PublicDbJob {
  const job: DbJob = {
    id: randomUUID(),
    kind: opts.kind,
    projectId: opts.projectId,
    databaseId: opts.databaseId,
    tag: opts.tag,
    createdAtOrig: opts.createdAtOrig,
    rootPath: opts.rootPath,
    config: opts.config,
    cred: opts.cred,
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

export function getDbJob(id: string): PublicDbJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

export function listDbJobs(projectId: string): PublicDbJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}

/** True while any connect/sync is running for this project (one job at a time). */
export function hasRunningDbJob(projectId: string): boolean {
  return [...jobs.values()].some((j) => j.projectId === projectId && j.status === 'running')
}
