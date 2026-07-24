import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { deleteDatabaseRow, getDatabaseRow, listDatabases, type DatabaseRow } from '../db.js'
import { resolveProject } from '../projectScope.js'
import { tagSlug } from '../sourceRepo.js'
import {
  DB_KINDS,
  dbCredentialInfo,
  defaultPort,
  deleteDbCredential,
  getDbCredential,
  inspectDatabase,
  isDbKind,
  setDbCredential,
  type DbConfig,
  type DbCredential,
} from '../dbConnect.js'
import { getDbJob, hasRunningDbJob, listDbJobs, startDbJob } from '../dbJobs.js'
import { deleteDbMap } from '../dbMap.js'
import { questionToSql, runReadQuery } from '../dbQuery.js'
import { CRAWL_SUMMARY_MODELS } from '../claudeExec.js'

// A project can connect several databases, each with a tag ("Backend DB", …).
// Each is a row in the `databases` table; its password lives in the on-disk
// credential store keyed by the database id. Mirrors routes/source.ts.

export const databaseRouter = Router()

const MAX_TAG_CHARS = 40

function toConfig(row: DatabaseRow): DbConfig {
  return {
    kind: row.kind as DbConfig['kind'],
    host: row.host,
    port: row.port,
    database: row.dbName,
    username: row.username,
    ssl: row.ssl,
  }
}

function publicDatabase(row: DatabaseRow) {
  const cred = getDbCredential(row.id)
  const credential = cred ? dbCredentialInfo(toConfig(row), cred) : null
  return {
    id: row.id,
    tag: row.tag,
    kind: row.kind,
    host: row.host,
    port: row.port,
    database: row.dbName,
    username: row.username,
    ssl: row.ssl,
    lastSync: row.lastSync,
    serverVersion: row.serverVersion,
    tableCount: row.tableCount,
    hasPassword: Boolean(credential),
    credential,
  }
}

/** GET /api/database — the project's connected databases + the supported kinds. */
databaseRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({
    connected: listDatabases(project.id).length > 0,
    rootPath: project.rootPath,
    kinds: DB_KINDS,
    databases: listDatabases(project.id).map(publicDatabase),
  })
})

/** GET /api/database/credential?databaseId= — the stored password, for edit prefill. */
databaseRouter.get('/credential', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const databaseId = typeof req.query.databaseId === 'string' ? req.query.databaseId : ''
  const row = getDatabaseRow(databaseId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'database not found' })
  const cred = getDbCredential(row.id)
  if (!cred?.password) return res.status(404).json({ error: 'no password is stored' })
  res.json({ password: cred.password })
})

/**
 * POST /api/database/connect — connect + introspect a database under a tag. Runs as
 * a background job; the client polls GET /api/database/jobs/:id.
 * Body: { kind, host?, port?, database, username?, password?, ssl?, tag?, databaseId? }
 * With databaseId this re-points an EXISTING database ("Edit & reconnect").
 */
databaseRouter.post('/connect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (hasRunningDbJob(project.id)) {
    return res.status(409).json({ error: 'another connect/sync is already running for this project' })
  }

  const body = req.body ?? {}
  const kind = body.kind
  if (!isDbKind(kind)) return res.status(400).json({ error: 'unknown database type' })

  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const database = typeof body.database === 'string' ? body.database.trim() : ''
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const ssl = Boolean(body.ssl)
  const port = Number.isFinite(Number(body.port)) && Number(body.port) > 0 ? Number(body.port) : defaultPort(kind)
  const requestedTag = typeof body.tag === 'string' ? body.tag.trim().slice(0, MAX_TAG_CHARS) : ''
  const databaseId = typeof body.databaseId === 'string' ? body.databaseId.trim() : ''

  if (!database) return res.status(400).json({ error: 'a database name is required' })
  if (!host) return res.status(400).json({ error: 'a host is required' })

  const existing = databaseId ? getDatabaseRow(databaseId) : undefined
  if (databaseId && (!existing || existing.projectId !== project.id)) {
    return res.status(404).json({ error: 'database not found' })
  }

  // Tag: explicit > the existing row's > derived from the database name.
  const tag = requestedTag || existing?.tag || database || 'Database'

  // A tag maps to a knowledge-doc name — refuse a tag another database already uses.
  const clash = listDatabases(project.id).find(
    (d) => d.id !== (existing?.id ?? '') && tagSlug(d.tag) === tagSlug(tag),
  )
  if (clash) {
    return res.status(409).json({ error: `the tag "${clash.tag}" is already used by another database` })
  }

  // A renamed tag moves the map doc name — drop the old one (it regenerates).
  if (existing && tagSlug(existing.tag) !== tagSlug(tag)) {
    deleteDbMap(project.rootPath, existing.tag)
  }

  const id = existing?.id ?? randomUUID()

  // Persist the password on disk. Editing an existing database with an empty
  // password field KEEPS the saved one; a new connect with no password means none.
  let cred: DbCredential | undefined
  if (password) {
    cred = { password }
    setDbCredential(id, cred)
  } else if (existing) {
    cred = getDbCredential(id)
  } else {
    deleteDbCredential(id)
  }

  const config: DbConfig = { kind, host, port, database, username, ssl }
  const job = startDbJob({
    kind: 'connect',
    projectId: project.id,
    databaseId: id,
    tag,
    createdAtOrig: existing?.createdAt ?? new Date().toISOString(),
    rootPath: project.rootPath,
    config,
    cred,
  })
  res.json({ jobId: job.id, job })
})

/**
 * POST /api/database/test — a quick, synchronous connection check. Connects and
 * reads the schema but persists NOTHING (no row, no credential, no map). Always
 * responds 200 with { ok, serverVersion?, tableCount?, error? } so the client can
 * show the result inline. Body is the same as /connect.
 */
databaseRouter.post('/test', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const body = req.body ?? {}
  const kind = body.kind
  if (!isDbKind(kind)) return res.json({ ok: false, error: 'unknown database type' })

  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const database = typeof body.database === 'string' ? body.database.trim() : ''
  const username = typeof body.username === 'string' ? body.username.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  const ssl = Boolean(body.ssl)
  const port = Number.isFinite(Number(body.port)) && Number(body.port) > 0 ? Number(body.port) : defaultPort(kind)
  const databaseId = typeof body.databaseId === 'string' ? body.databaseId.trim() : ''

  if (!database) return res.json({ ok: false, error: 'a database name is required' })
  if (!host) return res.json({ ok: false, error: 'a host is required' })

  // Password: an explicitly typed one wins; otherwise (editing an existing DB with
  // the field left blank) fall back to the stored credential so Test works too.
  let cred: DbCredential | undefined
  if (password) {
    cred = { password }
  } else if (databaseId) {
    const existing = getDatabaseRow(databaseId)
    if (existing && existing.projectId === project.id) cred = getDbCredential(existing.id)
  }

  const config: DbConfig = { kind, host, port, database, username, ssl }
  try {
    const schema = await inspectDatabase(config, cred)
    res.json({ ok: true, serverVersion: schema.serverVersion, tableCount: schema.tables.length })
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message || 'connection failed' })
  }
})

/**
 * POST /api/database/query — run one READ-ONLY SQL query against a connected DB.
 * Body: { databaseId, sql }. Always 200 with { ok, result? , error? }.
 */
databaseRouter.post('/query', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const databaseId = typeof req.body?.databaseId === 'string' ? req.body.databaseId.trim() : ''
  const sql = typeof req.body?.sql === 'string' ? req.body.sql : ''
  const row = getDatabaseRow(databaseId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'database not found' })
  try {
    const result = await runReadQuery(toConfig(row), getDbCredential(row.id), sql)
    res.json({ ok: true, result })
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message || 'query failed' })
  }
})

/**
 * POST /api/database/ask — natural-language question → AI writes a read-only SELECT,
 * runs it, and returns the SQL + results. Body: { databaseId, question, model? }.
 * Always 200 with { ok, sql?, result?, error? } (sql is echoed even when it fails to run).
 */
databaseRouter.post('/ask', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const databaseId = typeof req.body?.databaseId === 'string' ? req.body.databaseId.trim() : ''
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
  const model = CRAWL_SUMMARY_MODELS.has(req.body?.model) ? (req.body.model as string) : 'sonnet'
  const row = getDatabaseRow(databaseId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'database not found' })
  if (!question) return res.json({ ok: false, error: 'Ask a question about your data.' })

  const config = toConfig(row)
  const cred = getDbCredential(row.id)
  try {
    const { sql } = await questionToSql({ config, cred, question, model, cwd: project.rootPath })
    try {
      const result = await runReadQuery(config, cred, sql)
      res.json({ ok: true, sql, result })
    } catch (qerr) {
      res.json({ ok: false, sql, error: (qerr as Error).message || 'the generated query failed to run' })
    }
  } catch (err) {
    res.json({ ok: false, error: (err as Error).message || 'could not answer that question' })
  }
})

/** POST /api/database/sync — re-introspect one connected database (background job). */
databaseRouter.post('/sync', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const databaseId = typeof req.body?.databaseId === 'string' ? req.body.databaseId.trim() : ''
  const row = getDatabaseRow(databaseId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'database not found' })
  if (hasRunningDbJob(project.id)) {
    return res.status(409).json({ error: 'another connect/sync is already running for this project' })
  }

  const job = startDbJob({
    kind: 'sync',
    projectId: project.id,
    databaseId: row.id,
    tag: row.tag,
    createdAtOrig: row.createdAt,
    rootPath: project.rootPath,
    config: toConfig(row),
    cred: getDbCredential(row.id),
  })
  res.json({ jobId: job.id, job })
})

/** Poll one database job by id (scoped to the resolved project). */
databaseRouter.get('/jobs/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const job = getDbJob(req.params.id)
  if (!job || job.projectId !== project.id) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** List this project's database jobs (newest first). */
databaseRouter.get('/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listDbJobs(project.id) })
})

/** POST /api/database/disconnect — forget ONE database (the server itself is untouched). */
databaseRouter.post('/disconnect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const databaseId = typeof req.body?.databaseId === 'string' ? req.body.databaseId.trim() : ''
  const row = getDatabaseRow(databaseId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'database not found' })
  deleteDatabaseRow(row.id)
  deleteDbCredential(row.id)
  deleteDbMap(project.rootPath, row.tag) // derived data — regenerates on reconnect
  res.json({ ok: true })
})
