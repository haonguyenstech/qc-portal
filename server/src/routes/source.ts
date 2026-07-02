import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { deleteSourceRow, getSourceRow, listSources, type SourceRow } from '../db.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import {
  deleteSourceCredential,
  getSourceCredential,
  parseRepoUrl,
  repoStatus,
  setSourceCredential,
  sourceCredentialInfo,
  tagSlug,
  type SourceCredential,
} from '../sourceRepo.js'
import { getSourceJob, hasRunningSourceJob, listSourceJobs, startSourceJob } from '../sourceJobs.js'
import { deleteSourceMap } from '../sourceMap.js'

// Multi-repo: a project can connect several repos, each with a tag ("Backend
// repo", "Frontend repo", …). Each source is a row in the `sources` table; its
// token lives in the on-disk credential store keyed by the source id.

export const sourceRouter = Router()

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const MAX_TAG_CHARS = 40

async function publicSource(row: SourceRow) {
  const live = row.sourcePath && isDir(row.sourcePath) ? await repoStatus(row.sourcePath) : null
  const credential = (() => {
    const cred = getSourceCredential(row.id)
    if (!row.repoUrl || !cred) return null
    try {
      return sourceCredentialInfo(parseRepoUrl(row.repoUrl), cred)
    } catch {
      return null
    }
  })()
  return {
    id: row.id,
    tag: row.tag,
    repoUrl: row.repoUrl,
    provider: row.provider,
    branch: row.branch,
    sourcePath: row.sourcePath,
    lastSync: row.lastSync,
    lastCommit: row.lastCommit,
    hasToken: Boolean(credential),
    credential,
    live,
  }
}

/** GET /api/source — all of the project's connected repos + live on-disk status. */
sourceRouter.get('/', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const rows = listSources(project.id)
  const sources = []
  for (const row of rows) sources.push(await publicSource(row))
  res.json({
    connected: sources.length > 0,
    rootPath: project.rootPath,
    sources,
  })
})

/** GET /api/source/credential?sourceId= — the stored token, for clipboard copy. */
sourceRouter.get('/credential', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const sourceId = typeof req.query.sourceId === 'string' ? req.query.sourceId : ''
  const row = getSourceRow(sourceId)
  if (!row || row.projectId !== project.id) return res.status(404).json({ error: 'source not found' })
  const cred = getSourceCredential(row.id)
  if (!cred?.token) return res.status(404).json({ error: 'no source access token is stored' })
  res.json({ token: cred.token, username: cred.username ?? '' })
})

/**
 * POST /api/source/connect — clone (or adopt) a repo under a tag. Runs as a
 * background job; the client polls GET /api/source/jobs/:id.
 * Body: { projectId?, url, tag?, branch?, token?, username?, sourceId? }
 * With sourceId this re-points an EXISTING source ("Change repository").
 */
sourceRouter.post('/connect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!isDir(project.rootPath)) {
    return res.status(400).json({ error: `project folder not found: ${project.rootPath}` })
  }
  if (hasRunningSourceJob(project.id)) {
    return res.status(409).json({ error: 'another clone/sync is already running for this project' })
  }

  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : ''
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const requestedTag =
    typeof req.body?.tag === 'string' ? req.body.tag.trim().slice(0, MAX_TAG_CHARS) : ''
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : ''

  let parsed
  try {
    parsed = parseRepoUrl(url)
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }

  // Changing an existing source keeps its identity (id, createdAt, default tag).
  const existing = sourceId ? getSourceRow(sourceId) : undefined
  if (sourceId && (!existing || existing.projectId !== project.id)) {
    return res.status(404).json({ error: 'source not found' })
  }

  // Tag: explicit > the existing row's > derived from the repo name.
  const repoName = path.basename(new URL(parsed.cleanUrl).pathname).replace(/\.git$/i, '')
  const tag = requestedTag || existing?.tag || repoName || 'Source'

  // A tag maps to a folder — refuse a tag another source already uses.
  const clash = listSources(project.id).find(
    (s) => s.id !== (existing?.id ?? '') && tagSlug(s.tag) === tagSlug(tag),
  )
  if (clash) {
    return res.status(409).json({ error: `the tag "${clash.tag}" is already used by another repository` })
  }

  // A renamed tag moves the map doc name — drop the old one (it regenerates).
  if (existing && tagSlug(existing.tag) !== tagSlug(tag)) {
    deleteSourceMap(project.rootPath, existing.tag)
  }

  const id = existing?.id ?? randomUUID()
  // Re-clone of an existing source reuses its folder; a new source gets a
  // per-tag folder under <root>/source/.
  const targetDir =
    existing?.sourcePath && existing.sourcePath !== project.rootPath
      ? existing.sourcePath
      : path.join(project.rootPath, 'source', tagSlug(tag))

  // Persist the token on disk for later syncs. Editing an existing source with an
  // empty token field KEEPS the saved credential (so a reconnect doesn't force the
  // user to re-paste it); a brand-new connect with no token means a public repo.
  let cred: SourceCredential | undefined
  if (token) {
    cred = { token, username: username || undefined }
    setSourceCredential(id, cred)
  } else if (existing) {
    cred = getSourceCredential(id)
  } else {
    deleteSourceCredential(id)
  }

  const job = startSourceJob({
    kind: 'clone',
    projectId: project.id,
    sourceId: id,
    tag,
    sourceCreatedAt: existing?.createdAt ?? new Date().toISOString(),
    rootPath: project.rootPath,
    targetDir,
    parsed,
    cred,
    branch: branch || undefined,
  })
  res.json({ jobId: job.id, job })
})

/** POST /api/source/sync — git pull one connected repo (background job). */
sourceRouter.post('/sync', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : ''
  const row = getSourceRow(sourceId)
  if (!row || row.projectId !== project.id) {
    return res.status(404).json({ error: 'source not found' })
  }
  if (!row.repoUrl || !row.sourcePath) {
    return res.status(400).json({ error: 'no source repo is connected' })
  }
  if (!isDir(row.sourcePath)) {
    return res.status(400).json({ error: `source folder is missing: ${row.sourcePath}` })
  }
  if (hasRunningSourceJob(project.id)) {
    return res.status(409).json({ error: 'another clone/sync is already running for this project' })
  }

  let parsed
  try {
    parsed = parseRepoUrl(row.repoUrl)
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }

  const job = startSourceJob({
    kind: 'sync',
    projectId: project.id,
    sourceId: row.id,
    tag: row.tag,
    sourceCreatedAt: row.createdAt,
    rootPath: project.rootPath,
    sourcePath: row.sourcePath,
    prevCommit: row.lastCommit,
    parsed,
    cred: getSourceCredential(row.id),
    branch: row.branch || undefined,
  })
  res.json({ jobId: job.id, job })
})

/** Poll one source job by id (scoped to the resolved project). */
sourceRouter.get('/jobs/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const job = getSourceJob(req.params.id)
  if (!job || job.projectId !== project.id) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** List this project's source jobs (newest first). */
sourceRouter.get('/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listSourceJobs(project.id) })
})

/** POST /api/source/disconnect — forget ONE source (leaves files on disk). */
sourceRouter.post('/disconnect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : ''
  const row = getSourceRow(sourceId)
  if (!row || row.projectId !== project.id) {
    return res.status(404).json({ error: 'source not found' })
  }
  deleteSourceRow(row.id)
  deleteSourceCredential(row.id)
  deleteSourceMap(project.rootPath, row.tag) // derived data — regenerates on reconnect
  res.json({ ok: true })
})

/**
 * POST /api/source/open — reveal a source folder in the OS file explorer.
 * Body: { sourceId? } — a specific repo's folder; without it the shared
 * <root>/source dir (when present) or the project root.
 */
sourceRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const sourceId = typeof req.body?.sourceId === 'string' ? req.body.sourceId.trim() : ''
  const row = sourceId ? getSourceRow(sourceId) : undefined
  if (sourceId && (!row || row.projectId !== project.id)) {
    return res.status(404).json({ error: 'source not found' })
  }
  const sharedDir = path.join(project.rootPath, 'source')
  const dir =
    row?.sourcePath && isDir(row.sourcePath)
      ? row.sourcePath
      : isDir(sharedDir)
        ? sharedDir
        : project.rootPath
  if (!isDir(dir)) return res.status(404).json({ error: `folder not found: ${dir}` })
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  res.json({ ok: true, path: dir })
})
