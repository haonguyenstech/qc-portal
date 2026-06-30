import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { clearProjectSource, getProject } from '../db.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import {
  deleteSourceCredential,
  getSourceCredential,
  parseRepoUrl,
  repoStatus,
  setSourceCredential,
  sourceCredentialInfo,
  type SourceCredential,
} from '../sourceRepo.js'
import { getSourceJob, listSourceJobs, startSourceJob } from '../sourceJobs.js'

export const sourceRouter = Router()

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** GET /api/source — the project's connected source repo + live on-disk status. */
sourceRouter.get('/', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const live = project.sourcePath && isDir(project.sourcePath) ? await repoStatus(project.sourcePath) : null
  const credential = (() => {
    const cred = getSourceCredential(project.id)
    if (!project.sourceRepoUrl || !cred) return null
    try {
      return sourceCredentialInfo(parseRepoUrl(project.sourceRepoUrl), cred)
    } catch {
      return null
    }
  })()

  res.json({
    connected: Boolean(project.sourceRepoUrl),
    repoUrl: project.sourceRepoUrl,
    provider: project.sourceProvider,
    branch: project.sourceBranch,
    sourcePath: project.sourcePath,
    rootPath: project.rootPath,
    lastSync: project.sourceLastSync,
    lastCommit: project.sourceLastCommit,
    hasToken: Boolean(credential),
    credential,
    live,
  })
})

/** GET /api/source/credential — return the stored source token for clipboard copy. */
sourceRouter.get('/credential', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const cred = getSourceCredential(project.id)
  if (!cred?.token) return res.status(404).json({ error: 'no source access token is stored' })
  res.json({ token: cred.token })
})

/**
 * POST /api/source/connect — clone (or adopt) a GitHub/Bitbucket repo into the
 * project. Runs as a background job; the client polls GET /api/source/jobs/:id.
 * Body: { projectId?, url, branch?, token?, username? }
 */
sourceRouter.post('/connect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!isDir(project.rootPath)) {
    return res.status(400).json({ error: `project folder not found: ${project.rootPath}` })
  }

  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  const branch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : ''
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''

  let parsed
  try {
    parsed = parseRepoUrl(url)
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }

  // Persist the token on disk for later syncs (or clear it for a public repo).
  let cred: SourceCredential | undefined
  if (token) {
    cred = { token, username: username || undefined }
    setSourceCredential(project.id, cred)
  } else {
    deleteSourceCredential(project.id)
  }

  const job = startSourceJob({
    kind: 'clone',
    projectId: project.id,
    rootPath: project.rootPath,
    parsed,
    cred,
    branch: branch || undefined,
  })
  res.json({ jobId: job.id, job })
})

/** POST /api/source/sync — git pull the connected repo (background job). */
sourceRouter.post('/sync', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!project.sourceRepoUrl || !project.sourcePath) {
    return res.status(400).json({ error: 'no source repo is connected' })
  }
  if (!isDir(project.sourcePath)) {
    return res.status(400).json({ error: `source folder is missing: ${project.sourcePath}` })
  }

  let parsed
  try {
    parsed = parseRepoUrl(project.sourceRepoUrl)
  } catch (err) {
    return res.status(400).json({ error: (err as Error).message })
  }

  const job = startSourceJob({
    kind: 'sync',
    projectId: project.id,
    rootPath: project.rootPath,
    sourcePath: project.sourcePath,
    parsed,
    cred: getSourceCredential(project.id),
    branch: project.sourceBranch || undefined,
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

/** POST /api/source/disconnect — forget the connection (leaves files on disk). */
sourceRouter.post('/disconnect', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  clearProjectSource(project.id)
  deleteSourceCredential(project.id)
  res.json({ ok: true })
})

/**
 * POST /api/source/open — reveal the source folder in the OS file explorer.
 * Opens the cloned source folder when connected, else the project root.
 */
sourceRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  // Re-read so we open the freshest sourcePath.
  const fresh = getProject(project.id) ?? project
  const dir = fresh.sourcePath && isDir(fresh.sourcePath) ? fresh.sourcePath : fresh.rootPath
  if (!isDir(dir)) return res.status(404).json({ error: `folder not found: ${dir}` })
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  res.json({ ok: true, path: dir })
})
