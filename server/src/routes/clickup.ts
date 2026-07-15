import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  attachTaskFile,
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
import { testResultDirFor, ticketsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { crawlOneTicket, safeSegment } from '../crawl.js'
import { getCrawlJob, listCrawlJobs, startCrawlJob } from '../crawlJobs.js'

export const clickupRouter = Router()

const MAX_CRAWL_JOB_TICKETS = 50
const parseTicketKind = (v: unknown) => (v === 'feature' || v === 'bug' ? v : null)

type IssuePayload = { title: string; description?: string; screenshots?: unknown }

const IMAGE_CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Resolve a screenshot path (relative to a run's output folder) to an absolute
 * file on disk, path-guarded so it can't escape <root>/testing/test-result/<slug>.
 * Returns null when the slug/path escapes or the file is missing.
 */
function resolveRunScreenshot(rootPath: string, slug: string, rel: string): string | null {
  const runsDir = testResultDirFor(rootPath)
  const base = path.resolve(runsDir, slug)
  if (base !== runsDir && !base.startsWith(runsDir + path.sep)) return null
  const abs = path.resolve(base, rel)
  if (!abs.startsWith(base + path.sep)) return null
  try {
    if (!fs.statSync(abs).isFile()) return null
  } catch {
    return null
  }
  return abs
}

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

  // Optional — only needed to attach screenshots (resolved from the run's output folder).
  const project = resolveProject(req)
  const slug = typeof req.body?.slug === 'string' ? req.body.slug.trim() : ''

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
      screenshots: Array.isArray(issue.screenshots)
        ? issue.screenshots
            .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            .slice(0, 10)
        : [],
    }))
    .filter((issue: { title: string }) => issue.title.length > 0)
    .slice(0, 20)

  if (!parentTask) return res.status(400).json({ error: 'parentTask is required' })
  if (!issues.length) return res.status(400).json({ error: 'issues is required' })

  try {
    const created = []
    for (const issue of issues) {
      const task = await createIssueSubtask({
        parentTask,
        name: issue.title,
        description: issue.description,
      })
      // Best-effort: attach the QC screenshots so the image shows on the ClickUp
      // card instead of a dead local path. Never fail the subtask over an upload.
      if (project && slug && issue.screenshots.length) {
        for (const rel of issue.screenshots) {
          const abs = resolveRunScreenshot(project.rootPath, slug, rel)
          if (!abs) continue
          try {
            const bytes = fs.readFileSync(abs)
            const ext = path.extname(abs).toLowerCase()
            await attachTaskFile(
              task.id,
              path.basename(abs),
              bytes,
              IMAGE_CONTENT_TYPE[ext] ?? 'application/octet-stream',
            )
          } catch {
            /* best-effort — keep the subtask even if an attachment fails */
          }
        }
      }
      created.push(task)
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
  const ticketKind = parseTicketKind(req.body?.ticketKind)

  try {
    const result = await crawlOneTicket({ taskId, rootPath: project.rootPath, model, ticketKind })
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
    .filter((t: unknown): t is { id: string; displayId?: string; name?: string; relDir?: string } =>
      Boolean(t && typeof t === 'object' && typeof (t as { id?: unknown }).id === 'string'),
    )
    .map((t: { id: string; displayId?: string; name?: string; relDir?: string }) => ({
      id: t.id.trim(),
      displayId: typeof t.displayId === 'string' && t.displayId.trim() ? t.displayId.trim() : t.id,
      name: typeof t.name === 'string' ? t.name : '',
      // Optional nested folder path; crawlOneTicket re-sanitizes each segment.
      relDir: typeof t.relDir === 'string' && t.relDir.trim() ? t.relDir.trim() : undefined,
    }))
    .filter((t: { id: string }) => t.id.length > 0)
    .slice(0, MAX_CRAWL_JOB_TICKETS)
  if (!tickets.length) return res.status(400).json({ error: 'tickets is required' })

  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  const ticketKind = parseTicketKind(req.body?.ticketKind)

  // Capture the project's ClickUp token now — the job runs after this request
  // returns, when the per-request token context no longer exists.
  const token = resolveProjectClickupToken(project.rootPath)

  const job = startCrawlJob({
    projectId: project.id,
    projectName: project.name || 'this project',
    rootPath: project.rootPath,
    token,
    model,
    ticketKind,
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

// Reserved subfolders inside a ticket folder that hold the ticket's own content —
// never a nested subtask, so the recursive scan must not descend into them.
const RESERVED_TICKET_SUBDIRS = new Set(['testcases', 'attachments'])

/** A directory is a crawled ticket folder when it carries the ticket payload. */
function isTicketFolder(absDir: string): boolean {
  return fs.existsSync(path.join(absDir, 'ticket.json')) || fs.existsSync(path.join(absDir, 'ticket.md'))
}

function describeTicketFolder(baseDir: string, relPosix: string, parent: string | null) {
  const absDir = path.join(baseDir, ...relPosix.split('/'))
  let crawledAt: string | null = null
  try {
    crawledAt = fs.statSync(absDir).mtime.toISOString()
  } catch {
    /* ignore */
  }
  // Count test-case versions: testcases/v<N>.{md,csv} files, plus a legacy
  // pre-versioning testcases.md if present.
  let testcaseVersions = 0
  try {
    testcaseVersions = fs
      .readdirSync(path.join(absDir, 'testcases'))
      .filter((f) => /^v\d+\.(md|csv)$/.test(f)).length
  } catch {
    /* no testcases dir */
  }
  if (fs.existsSync(path.join(absDir, 'testcases.md'))) testcaseVersions++
  // Surface the real ticket title / displayId / status / priority from the
  // stored ticket.json so the list can show more than the sanitized folder name.
  let title: string | null = null
  let displayId: string | null = null
  let status: string | null = null
  let priority: string | null = null
  let url: string | null = null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(absDir, 'ticket.json'), 'utf8'))
    if (typeof j.name === 'string') title = j.name
    if (typeof j.displayId === 'string') displayId = j.displayId
    if (typeof j.status === 'string' && j.status.trim()) status = j.status
    if (typeof j.priority === 'string' && j.priority.trim()) priority = j.priority
    if (typeof j.url === 'string' && j.url.trim()) url = j.url
  } catch {
    /* no/invalid ticket.json — fall back to the folder name */
  }
  return {
    name: relPosix, // possibly-nested relative path (posix separators), the join/disk key
    parent, // relPosix of the enclosing ticket folder, or null for top-level
    crawledAt,
    hasTestcases: testcaseVersions > 0,
    testcaseVersions,
    title,
    displayId,
    status,
    priority,
    url,
  }
}

clickupRouter.get('/crawled', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const baseDir = ticketsDirFor(project.rootPath)
  // Walk the tree: a ticket folder may nest subtask folders inside it (a subtask
  // crawled under its parent). Each such folder is reported with its relative path
  // as `name` and its enclosing ticket folder as `parent`. Reserved content dirs
  // (testcases/, attachments/) are never treated as tickets nor descended into.
  const out: ReturnType<typeof describeTicketFolder>[] = []
  const walk = (relPosix: string, parent: string | null): void => {
    const absDir = relPosix ? path.join(baseDir, ...relPosix.split('/')) : baseDir
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of entries) {
      if (!d.isDirectory() || RESERVED_TICKET_SUBDIRS.has(d.name)) continue
      const childRel = relPosix ? `${relPosix}/${d.name}` : d.name
      const childAbs = path.join(baseDir, ...childRel.split('/'))
      if (isTicketFolder(childAbs)) {
        out.push(describeTicketFolder(baseDir, childRel, parent))
        walk(childRel, childRel) // descend; nested tickets get this one as parent
      } else {
        // Not a ticket folder itself, but a subtask could still live deeper.
        walk(childRel, parent)
      }
    }
  }
  try {
    walk('', null)
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
  // `name` may be a nested path (PARENT/CHILD). Sanitize each segment so it can't
  // escape baseDir, then rejoin — safeSegment() alone would collapse the separator.
  const segments = req.params.name
    .split(/[/\\]+/)
    .map((s) => safeSegment(s))
    .filter(Boolean)
  const dir = path.resolve(baseDir, ...segments)
  if (!segments.length || !dir.startsWith(baseDir + path.sep)) {
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
