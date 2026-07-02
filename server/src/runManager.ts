import fs from 'node:fs'
import path from 'node:path'
import { testResultDirFor } from './config.js'
import { runQc } from './claude.js'
import type { RunHandle } from './claude.js'
import { groundReport } from './groundingCheck.js'
import { runKnowledgeUpdate } from './learn.js'
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
import type { CreateRunBody, LogEvent, Project, RunSummary } from './types.js'

const active = new Map<string, RunHandle>()

function now(): string {
  return new Date().toISOString()
}

/**
 * Parse a QC report.md into pass/fail counts.
 * Partial / Blocked count toward failCount. Robust to a missing/empty file.
 *
 * Preferred source: the report's own "Result Summary" table — rows shaped
 * `| ✅ Pass | 47 |` (label + a purely numeric count cell). Counting rows across
 * the whole document over-counts badly (per-case tables, prose tables), so the
 * row-count heuristic is only the fallback when no summary table exists.
 */
export function parseReport(md: string): {
  passCount: number
  failCount: number
  totalAcs: number
} {
  if (!md) return { passCount: 0, failCount: 0, totalAcs: 0 }

  // 1) Summary-table extraction.
  const summary: Record<'pass' | 'fail' | 'partial' | 'blocked', number | null> = {
    pass: null,
    fail: null,
    partial: null,
    blocked: null,
  }
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('|')) continue
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cells.length < 2) continue
    // The count cell must be JUST a number (optionally bold) — otherwise rows like
    // `| Pass | TC-01 … |` in per-case tables would be misread as counts.
    if (!/^\*{0,2}\s*\d+\s*\*{0,2}$/.test(cells[1])) continue
    const label = cells[0].toLowerCase().replace(/[^a-z]/g, '')
    const value = Number.parseInt(cells[1].replace(/[^\d]/g, ''), 10)
    if (!Number.isFinite(value)) continue
    // First occurrence wins — the summary table sits at the top of the report.
    if ((label === 'pass' || label === 'passed') && summary.pass === null) summary.pass = value
    else if ((label === 'fail' || label === 'failed') && summary.fail === null)
      summary.fail = value
    else if (label.startsWith('partial') && summary.partial === null) summary.partial = value
    else if (label.startsWith('blocked') && summary.blocked === null) summary.blocked = value
  }
  if (summary.pass !== null || summary.fail !== null) {
    const passCount = summary.pass ?? 0
    const failCount = (summary.fail ?? 0) + (summary.partial ?? 0) + (summary.blocked ?? 0)
    return { passCount, failCount, totalAcs: passCount + failCount }
  }

  // 2) Fallback: count pass/fail-looking table rows document-wide.
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
  project: Project,
  body: {
    ticketId: string
    appUrl: string
    skill?: string
    instructions?: string
    model?: string
    relatedTickets?: string[]
    workflowSteps?: string[]
    testTarget?: 'web' | 'web-mobile' | 'app-mobile'
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
      testTarget: body.testTarget,
      resumeSessionId,
    },
    {
      onSession: (sessionId) => setRunSession(id, sessionId),
      onEvent: (event) => record(id, event),
      onDone: async ({ success }) => {
        // Pause/cancel both kill the child; if either status is already set,
        // keep the user's action from being overwritten by the process exit.
        const currentStatus = getRun(id)?.status
        if (currentStatus === 'paused' || currentStatus === 'canceled') {
          active.delete(id)
          return
        }
        const slug = resolveSlug(testingDir, body.ticketId)
        let reportMd = slug ? readIfExists(path.join(testingDir, slug, 'report.md')) : null

        // Grounding check — before counting Pass/Fail, an independent cheap pass
        // audits the report and downgrades any verdict not backed by documented
        // evidence, rewriting report.md in place (the pre-audit copy is kept as
        // report.pre-grounding.md). Best-effort: a failure leaves the report as-is,
        // so the counts below always reflect the grounded report.
        if (project.groundingCheck && success && reportMd && slug) {
          record(id, {
            ts: now(),
            kind: 'system',
            text: 'Grounding check — auditing the report for unsupported results…',
          })
          try {
            const g = await groundReport({
              rootPath: project.rootPath,
              projectName: project.name,
              report: reportMd,
              model: project.groundingCheckModel,
            })
            if (g.changed && g.corrected) {
              const reportPath = path.join(testingDir, slug, 'report.md')
              try {
                fs.writeFileSync(path.join(testingDir, slug, 'report.pre-grounding.md'), reportMd)
              } catch {
                /* backup is best-effort */
              }
              fs.writeFileSync(reportPath, g.corrected)
              reportMd = g.corrected
              record(id, {
                ts: now(),
                kind: 'system',
                text: 'Grounding check corrected the report — downgraded unsupported verdicts.',
              })
            } else {
              record(id, {
                ts: now(),
                kind: 'system',
                text: 'Grounding check: all results supported by evidence.',
              })
            }
          } catch {
            /* best-effort — grounding never sinks a finished run */
          }
        }

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

        // AI auto-capture: reflect on the finished run and persist durable facts into
        // testing/memory (+ knowledge). Best-effort, fire-and-forget — never blocks or
        // fails the run; results are surfaced as a follow-up event on the run's stream.
        if (project.autoLearn && success && reportMd && status !== 'error') {
          const context = [
            `QC run for ticket ${body.ticketId} on ${body.appUrl}.`,
            `Outcome: ${status} — ${passCount} pass, ${failCount} fail of ${totalAcs} ACs.`,
            '',
            'Report (report.md):',
            reportMd,
          ].join('\n')
          void runKnowledgeUpdate({
            rootPath: project.rootPath,
            projectName: project.name,
            source: `ai · QC run ${body.ticketId} · ${finishedAt.slice(0, 10)}`,
            context,
            model: project.autoLearnModel,
          })
            .then((learned) => {
              const total = learned.memory.length + learned.knowledge.length
              if (total === 0) return
              const names = [...learned.memory, ...learned.knowledge].join(', ')
              const ev: LogEvent = {
                ts: now(),
                kind: 'system',
                text: `AI updated project knowledge: ${total} note${total === 1 ? '' : 's'} (${names})`,
              }
              appendEvent(id, ev)
              hub.broadcast(id, { runId: id, event: ev })
            })
            .catch(() => {
              /* best-effort — auto-learn failures are silent */
            })
        }

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
