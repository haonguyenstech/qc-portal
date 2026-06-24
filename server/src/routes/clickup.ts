import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  clickupConfigured,
  createIssueSubtask,
  getDocs,
  getLists,
  getListTasks,
  getSpaces,
  getSubtasks,
  getWorkspaces,
  resolveProjectClickupToken,
  searchTasks,
  withClickupToken,
} from '../clickup.js'
import { ticketsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { crawlOneTicket, safeSegment } from '../crawl.js'
import { getCrawlJob, listCrawlJobs, startCrawlJob } from '../crawlJobs.js'

export const clickupRouter = Router()

const MAX_CRAWL_JOB_TICKETS = 50

type IssuePayload = { title: string; description?: string }

// Resolve the ClickUp token from the request's project (.mcp.json) for the whole
// request, so the in-app Connect token is used without a server restart. Falls
// back to the env var when the project has no token of its own.
clickupRouter.use((req, _res, next) => {
  const project = resolveProject(req)
  const tok = project ? resolveProjectClickupToken(project.rootPath) : undefined
  void withClickupToken(tok, async () => {
    next()
  })
})

function fail(res: import('express').Response, err: unknown) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({ error: (err as Error).message })
}

clickupRouter.get('/status', (_req, res) => {
  res.json({ configured: clickupConfigured() })
})

clickupRouter.get('/workspaces', async (_req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  try {
    res.json(await getWorkspaces())
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

clickupRouter.get('/tasks', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const team = typeof req.query.team === 'string' ? req.query.team : ''
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  if (!team) return res.status(400).json({ error: 'team is required' })
  try {
    res.json(await searchTasks(team, q))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.get('/spaces', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const team = typeof req.query.team === 'string' ? req.query.team : ''
  if (!team) return res.status(400).json({ error: 'team is required' })
  try {
    res.json(await getSpaces(team))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.get('/lists', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const space = typeof req.query.space === 'string' ? req.query.space : ''
  if (!space) return res.status(400).json({ error: 'space is required' })
  try {
    res.json(await getLists(space))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.get('/docs', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const team = typeof req.query.team === 'string' ? req.query.team : ''
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  if (!team) return res.status(400).json({ error: 'team is required' })
  try {
    res.json(await getDocs(team, q))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.get('/list-tasks', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const list = typeof req.query.list === 'string' ? req.query.list : ''
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  if (!list) return res.status(400).json({ error: 'list is required' })
  try {
    res.json(await getListTasks(list, q))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.get('/subtasks', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const parent = typeof req.query.parent === 'string' ? req.query.parent : ''
  if (!parent) return res.status(400).json({ error: 'parent is required' })
  try {
    res.json(await getSubtasks(parent))
  } catch (err) {
    fail(res, err)
  }
})

clickupRouter.post('/issues/subtasks', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })

  const parentTask = typeof req.body?.parentTask === 'string' ? req.body.parentTask.trim() : ''
  const rawIssues = Array.isArray(req.body?.issues) ? req.body.issues : []
  const issues = rawIssues
    .filter(
      (issue: unknown): issue is IssuePayload =>
        !!issue && typeof issue === 'object' && typeof (issue as { title?: unknown }).title === 'string',
    )
    .map((issue: IssuePayload) => ({
      title: issue.title.trim().slice(0, 255),
      description:
        typeof issue.description === 'string' && issue.description.trim()
          ? issue.description.trim().slice(0, 6000)
          : issue.title.trim(),
    }))
    .filter((issue: IssuePayload) => issue.title.length > 0)
    .slice(0, 20)

  if (!parentTask) return res.status(400).json({ error: 'parentTask is required' })
  if (!issues.length) return res.status(400).json({ error: 'issues is required' })

  try {
    const created = []
    for (const issue of issues) {
      created.push(
        await createIssueSubtask({
          parentTask,
          name: issue.title,
          description: issue.description,
        }),
      )
    }
    res.status(201).json({ created })
  } catch (err) {
    fail(res, err)
  }
})

// ---- Crawl: download a ticket's detail + comments + attachments to disk ----

// Crawl ONE ticket synchronously (kept for single-ticket callers). The heavy
// lifting lives in crawl.ts so the background job runner shares it exactly.
clickupRouter.post('/crawl', async (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId.trim() : ''
  if (!taskId) return res.status(400).json({ error: 'taskId is required' })
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''

  try {
    const result = await crawlOneTicket({ taskId, rootPath: project.rootPath, model })
    res.json(result)
  } catch (err) {
    fail(res, err)
  }
})

/**
 * Start a BACKGROUND job that crawls several tickets. The job runs server-side and
 * keeps going across browser reloads; the client polls GET /crawl/jobs/:id. Body:
 *   { projectId, model?, tickets: [{ id, displayId, name }] }
 */
clickupRouter.post('/crawl/jobs', (req, res) => {
  if (!clickupConfigured()) return res.status(400).json({ error: 'ClickUp is not configured' })
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

  // Capture the project's ClickUp token now — the job runs after this request
  // returns, when the per-request token context no longer exists.
  const token = resolveProjectClickupToken(project.rootPath)

  const job = startCrawlJob({
    projectId: project.id,
    projectName: project.name || 'this project',
    rootPath: project.rootPath,
    token,
    model,
    tickets,
  })
  res.json({ jobId: job.id, job })
})

/** Poll one crawl job by id. */
clickupRouter.get('/crawl/jobs/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const job = getCrawlJob(req.params.id)
  if (!job || job.projectId !== project.id) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** List this project's crawl jobs (newest first). */
clickupRouter.get('/crawl/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listCrawlJobs(project.id) })
})

// List the ticket folders already crawled into <root>/testing/test-result/, each with
// its last-crawl time (folder mtime) — lets the UI badge downloaded tickets and
// show when they were last fetched so the user can skip re-crawling them.
/**
 * Reveal a tickets folder in the OS file explorer on the machine running the
 * server. With no `folder`, opens testing/test-result (created if missing). With a
 * `folder`, opens that ticket's testcases/ subfolder when present, else the
 * ticket folder itself — path-guarded so it can't escape testing/test-result.
 */
clickupRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const baseDir = ticketsDirFor(project.rootPath)

  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
  let dir = baseDir
  if (folder) {
    const ticketDir = path.resolve(baseDir, folder)
    if (ticketDir !== baseDir && !ticketDir.startsWith(baseDir + path.sep)) {
      return res.status(400).json({ error: 'invalid ticket folder' })
    }
    if (!fs.existsSync(ticketDir)) {
      return res.status(404).json({ error: 'ticket has not been crawled yet' })
    }
    const testcasesDir = path.join(ticketDir, 'testcases')
    dir = fs.existsSync(testcasesDir) ? testcasesDir : ticketDir
  } else {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'failed to create tickets folder' })
    }
  }

  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

clickupRouter.get('/crawled', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const baseDir = ticketsDirFor(project.rootPath)
  try {
    const out = fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        let crawledAt: string | null = null
        try {
          crawledAt = fs.statSync(path.join(baseDir, d.name)).mtime.toISOString()
        } catch {
          /* ignore */
        }
        // Count test-case versions: testcases/v<N>.{md,csv} files, plus a legacy
        // pre-versioning testcases.md if present.
        let testcaseVersions = 0
        try {
          testcaseVersions = fs
            .readdirSync(path.join(baseDir, d.name, 'testcases'))
            .filter((f) => /^v\d+\.(md|csv)$/.test(f)).length
        } catch {
          /* no testcases dir */
        }
        if (fs.existsSync(path.join(baseDir, d.name, 'testcases.md'))) testcaseVersions++
        // Surface the real ticket title / displayId / status / priority from the
        // stored ticket.json so the list can show more than the sanitized folder name.
        let title: string | null = null
        let displayId: string | null = null
        let status: string | null = null
        let priority: string | null = null
        let url: string | null = null
        try {
          const j = JSON.parse(fs.readFileSync(path.join(baseDir, d.name, 'ticket.json'), 'utf8'))
          if (typeof j.name === 'string') title = j.name
          if (typeof j.displayId === 'string') displayId = j.displayId
          if (typeof j.status === 'string' && j.status.trim()) status = j.status
          if (typeof j.priority === 'string' && j.priority.trim()) priority = j.priority
          if (typeof j.url === 'string' && j.url.trim()) url = j.url
        } catch {
          /* no/invalid ticket.json — fall back to the folder name */
        }
        return {
          name: d.name,
          crawledAt,
          hasTestcases: testcaseVersions > 0,
          testcaseVersions,
          title,
          displayId,
          status,
          priority,
          url,
        }
      })
    res.json(out)
  } catch {
    res.json([]) // directory doesn't exist yet — nothing crawled
  }
})

// Delete one crawled ticket folder from <root>/testing/test-result/. Path-guarded so
// the name can never escape that directory.
clickupRouter.delete('/crawled/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const baseDir = ticketsDirFor(project.rootPath)
  const dir = path.resolve(baseDir, safeSegment(req.params.name))
  if (!dir.startsWith(baseDir + path.sep)) {
    return res.status(400).json({ error: 'invalid ticket path' })
  }
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return res.status(404).json({ error: 'not found' })
    }
    fs.rmSync(dir, { recursive: true, force: true })
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})
