/**
 * The thing that actually fires a scheduled task.
 *
 * One timer for the whole portal, started at boot in index.ts. Every tick it asks the DB
 * for tasks whose `nextRunAt` has passed, re-arms each one FIRST, then runs it. Re-arming
 * before running is what makes a task that takes 20 minutes not fire again the moment it
 * finishes, and what makes a crash mid-run lose one occurrence instead of looping.
 *
 * Three rules that are load-bearing:
 *
 * - **Runs are SERIAL, portal-wide.** Each one spawns a headless `claude`; three tasks
 *   sharing 09:00 on a laptop would be three CLIs fighting for the same CPU, and the
 *   engineer's own chat turn would be the thing that gets slow. The queue is the whole
 *   concurrency model — a task waits its turn, and `queuedAt` says so on screen.
 * - **A task never runs twice at once.** Both the tick and the "Run now" button go
 *   through `enqueue`, which refuses a schedule already queued or in flight, so a slow
 *   daily task cannot stack up into ten copies of itself.
 * - **A missed window fires ONCE, late.** `dueSchedules` selects `nextRunAt <= now`, so a
 *   task due while the laptop was asleep runs on wake — but the row is re-armed from
 *   `now`, never from the missed slot, so a 15-minute task does not replay 40 catch-up
 *   runs. See the comment on `dueSchedules` in db.ts.
 *
 * The prompt is run with `cwd = project.rootPath`, exactly like a chat turn, so CLAUDE.md,
 * Knowledge, Memory and the project's MCP servers are all in scope — a scheduled task is a
 * chat turn nobody had to be present for.
 */
import { randomUUID } from 'node:crypto'
import {
  dueSchedules,
  finishScheduleRun,
  getProject,
  getSchedule,
  insertScheduleRun,
  listSchedules,
  updateScheduleRow,
  type ScheduleRow,
  type ScheduleTrigger,
} from './db.js'
import { parseClaudeUsage, parseClaudeJsonResult, runClaude } from './claudeExec.js'
import { nextRunIso } from './cron.js'
import { toolArgs, timeoutFor, type ChatTools } from './routes/chat.js'

/** How often the loop looks for due work. A minute-granular cron needs nothing finer. */
const TICK_MS = 30_000

/** Cap on the stored answer. A scheduled brief is read on a card, not a 200 KB dump. */
const MAX_ANSWER = 60_000

let timer: ReturnType<typeof setInterval> | null = null

/** Schedules queued or in flight, by schedule id — the "never twice at once" guard. */
const inFlight = new Map<string, { runId: string; controller: AbortController; startedAt: string }>()
const queue: { scheduleId: string; runId: string; trigger: ScheduleTrigger }[] = []
let draining = false

/** What the UI needs to draw a live row: which tasks are working right now. */
export function activeScheduleIds(): string[] {
  return [...inFlight.keys()]
}

export function isScheduleRunning(id: string): boolean {
  return inFlight.has(id)
}

/**
 * Recompute `nextRunAt` from the row's cron and store it.
 *
 * Every write path funnels through here — create, edit, enable, and each fire — because a
 * `nextRunAt` that was not derived from the current cron is a task that runs at a time the
 * page does not show. A disabled task is parked with `nextRunAt = null` so the due query
 * never has to reason about it; enabling re-arms from now.
 */
export function reschedule(row: ScheduleRow, from: Date = new Date()): ScheduleRow | undefined {
  const next = row.enabled ? nextRunIso(row.cron, from) : null
  return updateScheduleRow(row.id, { nextRunAt: next })
}

/** Arm every task the DB already holds — after a restart their `nextRunAt` may be stale. */
function armAll(): void {
  for (const row of listSchedules()) {
    if (!row.enabled) {
      if (row.nextRunAt) updateScheduleRow(row.id, { nextRunAt: null })
      continue
    }
    // A missed slot is kept as-is so it fires once on wake; only a row with no slot at
    // all (or one the cron can no longer produce) is re-armed here.
    if (!row.nextRunAt) reschedule(row)
  }
}

export function startScheduler(): void {
  if (timer) return
  armAll()
  timer = setInterval(tick, TICK_MS)
  // `unref` so the timer alone never holds the process open during a shutdown.
  timer.unref?.()
  // Fire one tick immediately: a laptop that was closed over a task's window should not
  // wait another 30 seconds after boot to notice.
  tick()
}

export function stopScheduler(): number {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // Kill anything in flight — the child would otherwise outlive the server it reports to.
  let killed = 0
  for (const entry of inFlight.values()) {
    entry.controller.abort()
    killed++
  }
  queue.length = 0
  return killed
}

function tick(): void {
  const now = new Date()
  let due: ScheduleRow[]
  try {
    due = dueSchedules(now.toISOString())
  } catch {
    return // a DB hiccup must not kill the loop
  }
  for (const row of due) {
    // Re-arm FIRST, from now — see the module header.
    reschedule(row, now)
    enqueue(row.id, 'schedule')
  }
}

/**
 * Queue one task. Returns the id of the `schedule_runs` row that will record it, or null
 * when the task is already queued/running (the caller shows "already running", never a
 * second copy).
 */
export function enqueue(scheduleId: string, trigger: ScheduleTrigger): string | null {
  if (inFlight.has(scheduleId) || queue.some((q) => q.scheduleId === scheduleId)) return null
  const row = getSchedule(scheduleId)
  if (!row) return null
  const project = getProject(row.projectId)
  const runId = randomUUID()
  // The run row is written as `running` up front — a task that is working has to be
  // visible on the page for the whole time it works, not only once it finishes.
  insertScheduleRun({
    id: runId,
    scheduleId: row.id,
    projectId: row.projectId,
    title: row.title,
    trigger,
    status: 'running',
    answer: '',
    error: null,
    costUsd: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  })
  updateScheduleRow(row.id, { lastStatus: 'running', lastRunAt: new Date().toISOString() })
  if (!project) {
    // The project was removed but the task outlived it: fail the run HERE rather than
    // queueing work that has no folder to run in.
    finishScheduleRun(runId, {
      status: 'error',
      error: 'This task’s project is no longer registered in the portal.',
    })
    updateScheduleRow(row.id, { lastStatus: 'error', enabled: false, nextRunAt: null })
    return runId
  }
  queue.push({ scheduleId: row.id, runId, trigger })
  void drain()
  return runId
}

/** Cancel a task that is running right now. Returns false when it wasn't. */
export function cancelSchedule(scheduleId: string): boolean {
  const entry = inFlight.get(scheduleId)
  if (entry) {
    entry.controller.abort()
    return true
  }
  const i = queue.findIndex((q) => q.scheduleId === scheduleId)
  if (i >= 0) {
    const [q] = queue.splice(i, 1)
    finishScheduleRun(q.runId, { status: 'error', error: 'Cancelled before it started.' })
    updateScheduleRow(scheduleId, { lastStatus: 'error' })
    return true
  }
  return false
}

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      await execute(job.scheduleId, job.runId)
    }
  } finally {
    draining = false
  }
}

/**
 * The preamble every scheduled prompt is wrapped in.
 *
 * A scheduled task answers into a card that nobody is sitting in front of, so the two
 * things a chat turn gets for free — a person to ask a clarifying question of, and a
 * screen already showing the project — have to be said out loud instead. The engineer's
 * own words are fenced off as a quoted block for the same reason chat's recap is
 * JSON-framed: the text is whatever they typed, and it must not be able to read as
 * instructions ABOUT the framing.
 */
function buildPrompt(row: ScheduleRow, when: Date): string {
  return [
    'You are running as a SCHEDULED TASK inside the QC Portal, with no one watching.',
    `It is ${when.toLocaleString()}. Your working directory is this project's repository, so read`,
    'the project (CLAUDE.md, testing/, the code) before answering rather than guessing.',
    '',
    'Rules for this run:',
    '- Nobody can answer a clarifying question. If something is ambiguous, state the',
    '  assumption you made and carry on.',
    '- Answer in Markdown, and lead with the ANSWER (or "nothing changed"), not a preamble.',
    '- Keep it to what fits on a card unless the task explicitly asks for a long report.',
    '- Never take a destructive or irreversible action on a shared environment.',
    '',
    'The task, exactly as the QC engineer wrote it:',
    JSON.stringify(row.prompt),
  ].join('\n')
}

async function execute(scheduleId: string, runId: string): Promise<void> {
  const row = getSchedule(scheduleId)
  if (!row) return
  const project = getProject(row.projectId)
  if (!project) {
    finishScheduleRun(runId, { status: 'error', error: 'Project not found.' })
    updateScheduleRow(scheduleId, { lastStatus: 'error' })
    return
  }
  const controller = new AbortController()
  const startedAt = new Date()
  inFlight.set(scheduleId, { runId, controller, startedAt: startedAt.toISOString() })
  try {
    const mode = row.mode as ChatTools
    const args = [
      '-p',
      '--output-format',
      'json',
      ...toolArgs(mode, null),
      ...(row.model === 'default' ? [] : ['--model', row.model]),
      ...(row.effort && row.effort !== 'default' ? ['--effort', row.effort] : []),
    ]
    const r = await runClaude(args, timeoutFor(mode, null), {
      cwd: project.rootPath,
      input: buildPrompt(row, startedAt),
      usageSource: 'schedule',
      model: row.model === 'default' ? null : row.model,
      signal: controller.signal,
    })
    const aborted = controller.signal.aborted
    const parsed = parseClaudeJsonResult(r.stdout)
    const usage = parseClaudeUsage(r.stdout)
    const answer = parsed.text.slice(0, MAX_ANSWER)
    let error: string | null = null
    if (aborted) error = 'Cancelled.'
    else if (r.timedOut) error = 'The task ran past its time limit and was stopped.'
    else if (parsed.isError) error = answer || 'Claude reported an error.'
    else if (!answer) {
      // stderr is the only thing that says WHY a silent CLI produced nothing (not signed
      // in, a bad model name); without it the card would just read "no answer".
      error = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500) ||
        'The task produced no answer.'
    }
    const status = error ? 'error' : 'ok'
    finishScheduleRun(runId, {
      status,
      answer: error ? '' : answer,
      error,
      costUsd: usage?.costUsd ?? 0,
    })
    updateScheduleRow(scheduleId, {
      lastStatus: status,
      lastRunAt: startedAt.toISOString(),
      runCount: row.runCount + 1,
    })
  } catch (err) {
    finishScheduleRun(runId, {
      status: 'error',
      error: err instanceof Error ? err.message : 'The task failed to start.',
    })
    updateScheduleRow(scheduleId, { lastStatus: 'error' })
  } finally {
    inFlight.delete(scheduleId)
  }
}
