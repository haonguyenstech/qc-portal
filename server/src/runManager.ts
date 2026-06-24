import fs from 'node:fs'
import path from 'node:path'
import { testResultDirFor } from './config.js'
import { runQc } from './claude.js'
import type { RunHandle } from './claude.js'
import {
  appendEvent,
  getProject,
  getRun,
  getRunSession,
  insertRun,
  newRunId,
  setRunSession,
  updateRun,
} from './db.js'
import * as hub from './hub.js'
import type { CreateRunBody, LogEvent, RunSummary } from './types.js'

const active = new Map<string, RunHandle>()

function now(): string {
  return new Date().toISOString()
}

/**
 * Parse a QC report.md and count Pass / Fail table rows.
 * Partial / Blocked count toward failCount. Robust to a missing/empty file.
 */
export function parseReport(md: string): {
  passCount: number
  failCount: number
  totalAcs: number
} {
  if (!md) return { passCount: 0, failCount: 0, totalAcs: 0 }

  let passCount = 0
  let failCount = 0

  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) continue
    if (/^\|[\s:|-]+\|?\s*$/.test(line)) continue
    if (
      /\b(status|acceptance|criteria|criterion|result)\b/i.test(line) &&
      !/\b(pass|fail|partial|blocked)\b/i.test(line)
    ) {
      continue
    }

    if (/\b(fail|partial|blocked)\b/i.test(line)) {
      failCount++
    } else if (/\bpass\b/i.test(line)) {
      passCount++
    }
  }

  return { passCount, failCount, totalAcs: passCount + failCount }
}

/**
 * Resolve the testing/<slug> output folder for a ticket. The qc-testing skill names
 * the folder itself (e.g. "<ticket>-notification-part1"), which can differ from one
 * we pre-created, and several folders may share the ticket prefix. So pick the one
 * that actually contains report.md (most-recently-modified wins); otherwise the most
 * recently modified matching folder. A `preferred` slug (already stored on the run)
 * only wins when it itself contains a report — so a stale/empty slug self-heals.
 */
export function resolveSlug(
  testingDir: string,
  ticketId: string,
  preferred?: string | null,
): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(testingDir, { withFileTypes: true })
  } catch {
    return preferred ?? null
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith(ticketId))
    .map((e) => e.name)
  if (dirs.length === 0) return preferred ?? null

  const hasReport = (name: string) => {
    try {
      return fs.statSync(path.join(testingDir, name, 'report.md')).isFile()
    } catch {
      return false
    }
  }
  const mtime = (name: string) => {
    try {
      return fs.statSync(path.join(testingDir, name)).mtimeMs
    } catch {
      return 0
    }
  }

  if (preferred && dirs.includes(preferred) && hasReport(preferred)) return preferred
  const withReport = dirs.filter(hasReport).sort((a, b) => mtime(b) - mtime(a))
  if (withReport.length) return withReport[0]
  if (preferred && dirs.includes(preferred)) return preferred
  return dirs.slice().sort((a, b) => mtime(b) - mtime(a))[0]
}

function readIfExists(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function record(id: string, event: LogEvent) {
  appendEvent(id, event)
  hub.broadcast(id, { runId: id, event })
}

/**
 * Spawn the claude child for a run (fresh or resumed) and wire its lifecycle
 * back to the db + WebSocket hub. Shared by startRun and resumeRun.
 */
function spawnRun(
  id: string,
  project: { id: string; rootPath: string },
  body: {
    ticketId: string
    appUrl: string
    skill?: string
    instructions?: string
    model?: string
    relatedTickets?: string[]
    workflowSteps?: string[]
  },
  resumeSessionId?: string,
): void {
  const testingDir = testResultDirFor(project.rootPath)

  const handle = runQc(
    {
      ticketId: body.ticketId,
      appUrl: body.appUrl,
      cwd: project.rootPath,
      skill: body.skill,
      instructions: body.instructions,
      model: body.model,
      relatedTickets: body.relatedTickets,
      workflowSteps: body.workflowSteps,
      resumeSessionId,
    },
    {
      onSession: (sessionId) => setRunSession(id, sessionId),
      onEvent: (event) => record(id, event),
      onDone: ({ success }) => {
        // Pause/cancel both kill the child; if either status is already set,
        // keep the user's action from being overwritten by the process exit.
        const currentStatus = getRun(id)?.status
        if (currentStatus === 'paused' || currentStatus === 'canceled') {
          active.delete(id)
          return
        }
        const slug = resolveSlug(testingDir, body.ticketId)
        const reportMd = slug ? readIfExists(path.join(testingDir, slug, 'report.md')) : null
        const { passCount, failCount, totalAcs } = parseReport(reportMd ?? '')

        let status: RunSummary['status']
        if (!success) {
          status = 'error'
        } else if (failCount === 0 && totalAcs > 0) {
          status = 'passed'
        } else {
          status = 'failed'
        }

        const finishedAt = now()
        updateRun(id, { slug, status, passCount, failCount, totalAcs, finishedAt })

        const final: LogEvent = {
          ts: finishedAt,
          kind: 'done',
          text: `Run ${status}: ${passCount} pass, ${failCount} fail of ${totalAcs} ACs`,
        }
        appendEvent(id, final)
        hub.broadcast(id, { runId: id, event: final })

        active.delete(id)
      },
      onError: (message) => {
        const currentStatus = getRun(id)?.status
        if (currentStatus === 'paused' || currentStatus === 'canceled') {
          active.delete(id)
          return
        }
        record(id, { ts: now(), kind: 'error', text: message })
        updateRun(id, { status: 'error', finishedAt: now() })
        active.delete(id)
      },
    },
  )

  active.set(id, handle)
}

export function startRun(body: CreateRunBody): RunSummary {
  const project = getProject(body.projectId)
  if (!project) {
    throw Object.assign(new Error('project not found'), { status: 400 })
  }

  const id = newRunId()
  const summary: RunSummary = {
    id,
    projectId: project.id,
    projectName: project.name,
    ticketId: body.ticketId,
    appUrl: body.appUrl,
    slug: null,
    status: 'running',
    passCount: 0,
    failCount: 0,
    totalAcs: 0,
    createdAt: now(),
    finishedAt: null,
  }
  insertRun(summary)

  spawnRun(id, project, body)
  return summary
}

/**
 * Stop a running run but keep it resumable: kill the child and mark it 'paused'.
 * The Claude session id is preserved so resumeRun can pick it back up.
 */
export function pauseRun(id: string): boolean {
  const run = getRun(id)
  if (!run || run.status !== 'running') return false

  const handle = active.get(id)
  if (handle) {
    handle.cancel()
    active.delete(id)
  }
  updateRun(id, { status: 'paused' })
  record(id, { ts: now(), kind: 'system', text: 'Run paused — resume to continue.' })
  return true
}

/** Resume a paused run by continuing its kept Claude session. */
export function resumeRun(id: string): boolean {
  const run = getRun(id)
  if (!run || run.status !== 'paused') {
    throw Object.assign(new Error('run is not paused'), { status: 409 })
  }
  if (active.has(id)) return true // already running again

  const project = run.projectId ? getProject(run.projectId) : undefined
  if (!project) {
    throw Object.assign(new Error('project not found'), { status: 400 })
  }
  const sessionId = getRunSession(id)
  if (!sessionId) {
    throw Object.assign(
      new Error('no saved session for this run — it cannot be resumed'),
      { status: 409 },
    )
  }

  updateRun(id, { status: 'running', finishedAt: null })
  record(id, { ts: now(), kind: 'system', text: 'Resuming run…' })

  spawnRun(
    id,
    project,
    { ticketId: run.ticketId, appUrl: run.appUrl },
    sessionId,
  )
  return true
}

/**
 * Kill every in-flight run's process tree before the server exits, so a restart
 * (tsx watch) or Ctrl-C never leaves orphaned claude/Playwright processes
 * running. Runs with a saved Claude session are marked 'paused' (resumable);
 * the rest are left for reconcileInterruptedRuns to flag on next boot.
 */
export function shutdownActiveRuns(): number {
  const ids = [...active.keys()]
  for (const [, handle] of active) {
    try {
      handle.cancel()
    } catch {
      /* already gone */
    }
  }
  active.clear()

  for (const id of ids) {
    const run = getRun(id)
    if (run && run.status === 'running' && getRunSession(id)) {
      updateRun(id, { status: 'paused' })
      appendEvent(id, {
        ts: now(),
        kind: 'system',
        text: 'Run paused — the server is shutting down. Resume to continue.',
      })
    }
  }
  return ids.length
}

export function cancelRun(id: string): boolean {
  const handle = active.get(id)
  const run = getRun(id)
  if (handle) {
    handle.cancel()
    active.delete(id)
  }
  // A canceled run is terminal — covers both live ('running') and 'paused' runs.
  if (run && (run.status === 'running' || run.status === 'paused')) {
    const finishedAt = now()
    updateRun(id, { status: 'canceled', finishedAt })
    const event: LogEvent = { ts: finishedAt, kind: 'system', text: 'Run canceled' }
    appendEvent(id, event)
    hub.broadcast(id, { runId: id, event })
  }
  return !!handle
}
