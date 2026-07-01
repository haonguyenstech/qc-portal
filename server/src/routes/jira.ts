import { Router } from 'express'
import {
  jiraConfigured,
  getWorkspaces,
  searchTasks,
  getSubtasks,
  resolveProjectJiraCreds,
  withJiraCreds,
} from '../jira.js'
import { resolveProject } from '../projectScope.js'
import { crawlOneTicket } from '../crawl.js'
import { getCrawlJob, listCrawlJobs, startCrawlJob } from '../crawlJobs.js'

// Jira twin of routes/clickup.ts. Only the tracker-specific read + crawl-start
// endpoints live here; the on-disk, tracker-agnostic bits — listing already
// crawled folders (GET /api/clickup/crawled), opening/deleting them, and polling
// crawl jobs — are shared and served by the ClickUp router (jobs live in one
// registry keyed by id, so its /crawl/jobs/:id resolves Jira jobs too).

export const jiraRouter = Router()

const MAX_CRAWL_JOB_TICKETS = 50

// Resolve this project's Jira creds (.mcp.json) for the whole request, so the
// in-app Connect creds take effect without a server restart.
jiraRouter.use((req, _res, next) => {
  const project = resolveProject(req)
  const creds = project ? resolveProjectJiraCreds(project.rootPath) : undefined
  void withJiraCreds(creds, async () => {
    next()
  })
})

function fail(res: import('express').Response, err: unknown) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({ error: (err as Error).message })
}

jiraRouter.get('/status', (_req, res) => {
  res.json({ configured: jiraConfigured() })
})

jiraRouter.get('/workspaces', async (_req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira is not configured' })
  try {
    res.json(await getWorkspaces())
  } catch (err) {
    fail(res, err)
  }
})

// Search issues within a Jira project. `team` is the Jira project key (named
// `team` to match the ClickUp endpoint the shared UI already calls).
jiraRouter.get('/tasks', async (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira is not configured' })
  const project = typeof req.query.team === 'string' ? req.query.team : ''
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  if (!project) return res.status(400).json({ error: 'team (project key) is required' })
  try {
    res.json(await searchTasks(project, q))
  } catch (err) {
    fail(res, err)
  }
})

jiraRouter.get('/subtasks', async (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira is not configured' })
  const parent = typeof req.query.parent === 'string' ? req.query.parent : ''
  if (!parent) return res.status(400).json({ error: 'parent is required' })
  try {
    res.json(await getSubtasks(parent))
  } catch (err) {
    fail(res, err)
  }
})

// Crawl ONE issue synchronously (kept for single-ticket callers).
jiraRouter.post('/crawl', async (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira is not configured' })
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
  if (!taskId) return res.status(400).json({ error: 'taskId is required' })
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''

  try {
    const result = await crawlOneTicket({ taskId, rootPath: project.rootPath, model, source: 'jira' })
    res.json(result)
  } catch (err) {
    fail(res, err)
  }
})

/**
 * Start a BACKGROUND job that crawls several Jira issues. Same registry + polling
 * as ClickUp; only the source + captured creds differ. Body:
 *   { projectId, model?, tickets: [{ id, displayId, name }] }
 */
jiraRouter.post('/crawl/jobs', (req, res) => {
  if (!jiraConfigured()) return res.status(400).json({ error: 'Jira is not configured' })
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const raw = Array.isArray(req.body?.tickets) ? req.body.tickets : []
  const tickets = raw
    .filter((t: unknown): t is { id: string; displayId?: string; name?: string } =>
      Boolean(t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string'),
    )
    .map((t: { id: string; displayId?: string; name?: string }) => ({
      id: t.id.trim(),
      displayId: typeof t.displayId === 'string' && t.displayId.trim() ? t.displayId.trim() : t.id,
      name: typeof t.name === 'string' ? t.name : '',
    }))
    .filter((t: { id: string }) => t.id.length > 0)
    .slice(0, MAX_CRAWL_JOB_TICKETS)
  if (!tickets.length) return res.status(400).json({ error: 'tickets is required' })

  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''

  // Capture the project's Jira creds now — the job runs after this request
  // returns, when the per-request creds context no longer exists.
  const jiraCreds = resolveProjectJiraCreds(project.rootPath)

  const job = startCrawlJob({
    projectId: project.id,
    projectName: project.name || 'this project',
    rootPath: project.rootPath,
    source: 'jira',
    jiraCreds,
    model,
    tickets,
  })
  res.json({ jobId: job.id, job })
})

/** Poll one crawl job by id (shared registry — also resolves ClickUp jobs). */
jiraRouter.get('/crawl/jobs/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const job = getCrawlJob(req.params.id)
  if (!job || job.projectId !== project.id) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** List this project's crawl jobs (newest first). */
jiraRouter.get('/crawl/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listCrawlJobs(project.id) })
})
