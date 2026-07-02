import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testResultDirFor } from '../config.js'
import {
  deleteRun,
  getEvents,
  getProject,
  getRun,
  getRunSession,
  listRuns,
  updateRun,
} from '../db.js'
import { cancelRun, parseReport, pauseRun, resumeRun, resolveSlug, startRun } from '../runManager.js'
import { revealFolderNative } from '../folderPicker.js'
import { CRAWL_SUMMARY_MODELS } from '../claudeExec.js'
import type { RunDetail, RunSummary } from '../types.js'

export const qcRouter = Router()

// Reachability probe for the run form's App URL — the browser can't check a
// cross-origin staging URL itself (CORS), so the server fetches it and reports
// the outcome. Follows redirects; any HTTP response counts as reachable (a 401
// login wall still proves the host is up).
qcRouter.post('/check-url', async (req, res) => {
  const raw = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  let url: URL
  try {
    url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    res.status(400).json({ ok: false, error: 'Enter a full http:// or https:// URL.' })
    return
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const resp = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'qc-portal-url-check' },
    })
    // Drain nothing — we only care that the server answered.
    resp.body?.cancel().catch(() => {})
    res.json({ ok: true, status: resp.status, finalUrl: resp.url })
  } catch (err) {
    const raw2 =
      err instanceof Error
        ? ((err.cause as Error | undefined)?.message ?? err.message)
        : 'Request failed'
    const error = controller.signal.aborted
      ? 'Timed out after 10s — the URL did not respond.'
      : raw2.includes('ENOTFOUND')
        ? 'Host not found — check the domain for typos.'
        : raw2.includes('ECONNREFUSED')
          ? 'Connection refused — nothing is listening at that address.'
          : raw2.includes('CERT') || raw2.includes('certificate')
            ? `TLS certificate problem (${raw2}).`
            : raw2
    res.json({ ok: false, error })
  } finally {
    clearTimeout(timer)
  }
})

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function listScreenshots(testingDir: string, slug: string): string[] {
  const dir = path.join(testingDir, slug, 'screenshots')
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `screenshots/${e.name}`)
  } catch {
    return []
  }
}

function outputSlugForRun(
  testingDir: string | null,
  run: Pick<RunSummary, 'ticketId' | 'slug'>,
): string | null {
  if (!testingDir) return run.slug
  // A missing slug means this run never produced its own output folder. Do not
  // fall back by ticket id here, because multiple runs for the same ticket can
  // exist and a canceled run would show another run's report.
  if (!run.slug) return null
  return resolveSlug(testingDir, run.ticketId, run.slug)
}

type RunFileKind = 'markdown' | 'image' | 'text' | 'other'

interface RunFileInfo {
  path: string // relative to the run's testing/<slug>/ folder
  size: number
  kind: RunFileKind
}

function fileKind(name: string): RunFileKind {
  const n = name.toLowerCase()
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'markdown'
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(n)) return 'image'
  if (/\.(txt|json|csv|log|ya?ml|html?|xml)$/.test(n)) return 'text'
  return 'other'
}

/** Recursively list every file under a run's output folder (bounded for safety). */
function walkRunFiles(baseDir: string, rel = '', acc: RunFileInfo[] = [], depth = 0): RunFileInfo[] {
  if (depth > 5 || acc.length > 500) return acc
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(baseDir, rel), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      walkRunFiles(baseDir, r, acc, depth + 1)
    } else if (e.isFile()) {
      let size = 0
      try {
        size = fs.statSync(path.join(baseDir, r)).size
      } catch {
        /* ignore */
      }
      acc.push({ path: r, size, kind: fileKind(e.name) })
    }
  }
  return acc
}

qcRouter.post('/run', (req, res) => {
  const {
    projectId,
    ticketId,
    appUrl,
    skill,
    instructions,
    model,
    relatedTickets,
    workflowSteps,
    testTarget,
  } = req.body ?? {}
  if (typeof projectId !== 'string' || !projectId.trim()) {
    return res.status(400).json({ error: 'projectId is required' })
  }
  // web/web-mobile open a URL → appUrl required; app-mobile drives a native app
  // on the device → appUrl is an OPTIONAL package/bundle id.
  const target: 'web' | 'web-mobile' | 'app-mobile' =
    testTarget === 'web-mobile' ? 'web-mobile' : testTarget === 'app-mobile' ? 'app-mobile' : 'web'
  const appUrlClean = typeof appUrl === 'string' ? appUrl.trim() : ''
  if (typeof ticketId !== 'string' || !ticketId.trim()) {
    return res.status(400).json({ error: 'ticketId is required' })
  }
  if (target !== 'app-mobile' && !appUrlClean) {
    return res.status(400).json({ error: 'appUrl is required' })
  }
  if (skill != null && typeof skill !== 'string') {
    return res.status(400).json({ error: 'skill must be a string' })
  }
  if (instructions != null && typeof instructions !== 'string') {
    return res.status(400).json({ error: 'instructions must be a string' })
  }
  // Only a known alias pins the model; anything else (incl. 'auto'/undefined)
  // falls through to Claude's configured default — current behavior.
  const pinnedModel =
    typeof model === 'string' && CRAWL_SUMMARY_MODELS.has(model.trim())
      ? model.trim()
      : undefined
  // Advanced mode: extra tickets + an ordered workflow folded into one run.
  // Sanitize to bounded arrays of non-empty strings so a bad body can't blow up
  // the prompt — caps mirror the UI (≤5 related tickets, ≤30 workflow steps).
  const sanitizeList = (v: unknown, maxItems: number, maxLen: number): string[] =>
    Array.isArray(v)
      ? v
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim().slice(0, maxLen))
          .slice(0, maxItems)
      : []
  const relatedClean = sanitizeList(relatedTickets, 5, 200)
  const stepsClean = sanitizeList(workflowSteps, 30, 500)
  // app-mobile may have no id — store a readable label so history/messages aren't blank.
  const appUrlValue = appUrlClean || (target === 'app-mobile' ? 'Mobile app' : '')
  try {
    const summary = startRun({
      projectId: projectId.trim(),
      ticketId: ticketId.trim(),
      appUrl: appUrlValue,
      skill: typeof skill === 'string' ? skill.trim() : undefined,
      instructions: typeof instructions === 'string' ? instructions.slice(0, 4000) : undefined,
      model: pinnedModel,
      relatedTickets: relatedClean.length ? relatedClean : undefined,
      workflowSteps: stepsClean.length ? stepsClean : undefined,
      testTarget: target,
    })
    return res.status(201).json({ runId: summary.id, ...summary })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    return res.status(status).json({ error: (err as Error).message })
  }
})

qcRouter.get('/runs', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined
  res.json(listRuns(projectId))
})

qcRouter.get('/runs/:id', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })

  const project = run.projectId ? getProject(run.projectId) : undefined
  const testingDir = project ? testResultDirFor(project.rootPath) : null
  const slug = outputSlugForRun(testingDir, run)

  const reportMd =
    testingDir && slug ? readIfExists(path.join(testingDir, slug, 'report.md')) : null
  const issuesMd =
    testingDir && slug ? readIfExists(path.join(testingDir, slug, 'issues.md')) : null
  const screenshots = testingDir && slug ? listScreenshots(testingDir, slug) : []

  // Self-heal stored counts: runs recorded before the summary-table parser landed
  // (or whose report changed on disk) carry stale pass/fail numbers. Recompute from
  // the report and persist when they differ, so History matches the report.
  if (reportMd && run.finishedAt) {
    const parsed = parseReport(reportMd)
    if (
      parsed.totalAcs > 0 &&
      (parsed.passCount !== run.passCount ||
        parsed.failCount !== run.failCount ||
        parsed.totalAcs !== run.totalAcs)
    ) {
      updateRun(run.id, parsed)
      Object.assign(run, parsed)
    }
  }

  const detail: RunDetail = {
    ...run,
    slug, // return the resolved slug so the client builds correct file URLs
    reportMd,
    issuesMd,
    screenshots,
    logTail: getEvents(run.id),
    // Whether the run's Claude session is still resumable for a follow-up chat.
    hasSession: getRunSession(run.id) != null,
  }
  return res.json(detail)
})

/** List every file in a run's testing/<slug>/ output folder (for in-app preview). */
qcRouter.get('/runs/:id/files', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })
  const project = run.projectId ? getProject(run.projectId) : undefined
  const testingDir = project ? testResultDirFor(project.rootPath) : null
  const slug = outputSlugForRun(testingDir, run)
  if (!testingDir || !slug) return res.json({ slug: null, files: [] })
  const files = walkRunFiles(path.join(testingDir, slug)).sort((a, b) =>
    a.path.localeCompare(b.path),
  )
  return res.json({ slug, files })
})

/** Reveal a run's output folder in the OS file explorer. */
qcRouter.post('/runs/:id/open', async (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })
  const project = run.projectId ? getProject(run.projectId) : undefined
  const testingDir = project ? testResultDirFor(project.rootPath) : null
  const slug = outputSlugForRun(testingDir, run)
  if (!testingDir || !slug) return res.status(404).json({ error: 'no output folder for this run' })
  const dir = path.join(testingDir, slug)
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/** Delete a finished run: its DB record + event log, and its on-disk output folder. */
qcRouter.delete('/runs/:id', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })

  // An active run is still using its session/output — make the user cancel first.
  if (run.status === 'running' || run.status === 'queued' || run.status === 'paused') {
    return res.status(409).json({ error: 'cancel the run before deleting it' })
  }

  // Remove the on-disk test-result folder (report, issues, screenshots, evidence).
  const project = run.projectId ? getProject(run.projectId) : undefined
  const testingDir = project ? testResultDirFor(project.rootPath) : null
  const slug = outputSlugForRun(testingDir, run)
  if (testingDir && slug) {
    try {
      fs.rmSync(path.join(testingDir, slug), { recursive: true, force: true })
    } catch {
      // Best-effort — a missing/locked folder shouldn't block removing the record.
    }
  }

  deleteRun(run.id)
  return res.json({ ok: true })
})

qcRouter.post('/runs/:id/cancel', (req, res) => {
  cancelRun(req.params.id)
  res.json({ ok: true })
})

qcRouter.post('/runs/:id/pause', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })
  const ok = pauseRun(req.params.id)
  if (!ok) return res.status(409).json({ error: 'run is not running' })
  res.json({ ok: true })
})

qcRouter.post('/runs/:id/resume', (req, res) => {
  const run = getRun(req.params.id)
  if (!run) return res.status(404).json({ error: 'run not found' })
  try {
    resumeRun(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})
