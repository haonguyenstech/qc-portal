/**
 * `/api/schedules` — the Scheduled page and the composer's `/scheduled` command.
 *
 * A schedule is stored ONLY through here, and every write goes through `reschedule` so the
 * stored `nextRunAt` is always the one the cron actually implies. `description` and
 * `nextRunAt` are computed server-side and sent down with every row: the browser has no
 * cron parser, which is the only way the sentence on the card and the timer that fires can
 * never disagree (see cron.ts).
 */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import {
  deleteSchedule,
  getSchedule,
  insertSchedule,
  listScheduleRuns,
  listSchedules,
  scheduleRunsSince,
  updateScheduleRow,
  type ScheduleMode,
  type ScheduleRow,
} from '../db.js'
import { resolveProject } from '../projectScope.js'
import { describeCron, isValidCron, nextRun, nextRunIso } from '../cron.js'
import { parseWhen, stripWhen, titleFrom } from '../scheduleLang.js'
import { cancelSchedule, enqueue, isScheduleRunning, reschedule } from '../scheduler.js'
import { parseClaudeJsonResult, runClaude } from '../claudeExec.js'

export const schedulesRouter = Router()

const MAX_PROMPT = 8_000
const MAX_TITLE = 120
/** A portal-wide ceiling. Beyond this the tick loop stops being a background detail. */
const MAX_SCHEDULES_PER_PROJECT = 100

const MODES: ScheduleMode[] = ['read', 'write', 'full']
const EFFORTS = ['low', 'medium', 'high']
const MODELS = ['default', 'haiku', 'sonnet', 'opus']

/** The row as the browser sees it — plus the two derived fields it must not compute itself. */
function toPublic(row: ScheduleRow) {
  return {
    ...row,
    description: describeCron(row.cron),
    running: isScheduleRunning(row.id),
  }
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback
}

schedulesRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ schedules: listSchedules(project.id).map(toPublic) })
})

schedulesRouter.post('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim() : ''
  const cron = typeof b.cron === 'string' ? b.cron.trim() : ''
  if (!prompt) return res.status(400).json({ error: 'A scheduled task needs something to do.' })
  if (prompt.length > MAX_PROMPT) {
    return res.status(413).json({ error: `The task is longer than ${MAX_PROMPT} characters.` })
  }
  if (!isValidCron(cron)) {
    return res.status(400).json({ error: `"${cron}" is not a schedule this portal can run.` })
  }
  if (listSchedules(project.id).length >= MAX_SCHEDULES_PER_PROJECT) {
    return res
      .status(409)
      .json({ error: `This project already has ${MAX_SCHEDULES_PER_PROJECT} scheduled tasks.` })
  }
  const ts = new Date().toISOString()
  const row: ScheduleRow = {
    id: randomUUID(),
    projectId: project.id,
    title: (typeof b.title === 'string' && b.title.trim().slice(0, MAX_TITLE)) || titleFrom(prompt),
    prompt,
    cron,
    mode: pick(b.mode, MODES, 'read'),
    model: pick(b.model, MODELS, 'default'),
    effort: pick(b.effort, EFFORTS, 'medium'),
    enabled: b.enabled !== false,
    createdAt: ts,
    updatedAt: ts,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    runCount: 0,
  }
  insertSchedule(row)
  const armed = reschedule(row) ?? row
  res.status(201).json({ schedule: toPublic(armed) })
})

schedulesRouter.patch('/:id', (req, res) => {
  const existing = getSchedule(req.params.id)
  if (!existing) return res.status(404).json({ error: 'scheduled task not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const patch: Partial<ScheduleRow> = {}
  if (typeof b.title === 'string' && b.title.trim()) patch.title = b.title.trim().slice(0, MAX_TITLE)
  if (typeof b.prompt === 'string') {
    const prompt = b.prompt.trim()
    if (!prompt) return res.status(400).json({ error: 'A scheduled task needs something to do.' })
    if (prompt.length > MAX_PROMPT) {
      return res.status(413).json({ error: `The task is longer than ${MAX_PROMPT} characters.` })
    }
    patch.prompt = prompt
  }
  if (typeof b.cron === 'string') {
    const cron = b.cron.trim()
    if (!isValidCron(cron)) {
      return res.status(400).json({ error: `"${cron}" is not a schedule this portal can run.` })
    }
    patch.cron = cron
  }
  if (b.mode !== undefined) patch.mode = pick(b.mode, MODES, existing.mode)
  if (b.model !== undefined) patch.model = pick(b.model, MODELS, existing.model)
  if (b.effort !== undefined) patch.effort = pick(b.effort, EFFORTS, existing.effort)
  if (b.enabled !== undefined) patch.enabled = b.enabled === true

  const updated = updateScheduleRow(existing.id, patch)
  if (!updated) return res.status(404).json({ error: 'scheduled task not found' })
  // Re-arm from NOW on every edit: changing the cron (or switching a task back on) has to
  // move the next firing, and an un-armed row would simply never come due again.
  const armed = reschedule(updated) ?? updated
  res.json({ schedule: toPublic(armed) })
})

schedulesRouter.delete('/:id', (req, res) => {
  cancelSchedule(req.params.id)
  if (!deleteSchedule(req.params.id)) {
    return res.status(404).json({ error: 'scheduled task not found' })
  }
  res.json({ ok: true })
})

/** Run it now, without disturbing its schedule — the next firing is left exactly as it was. */
schedulesRouter.post('/:id/run', (req, res) => {
  const row = getSchedule(req.params.id)
  if (!row) return res.status(404).json({ error: 'scheduled task not found' })
  const runId = enqueue(row.id, 'manual')
  if (!runId) return res.status(409).json({ error: 'That task is already running.' })
  res.status(202).json({ runId, schedule: toPublic(getSchedule(row.id) ?? row) })
})

schedulesRouter.post('/:id/cancel', (req, res) => {
  const row = getSchedule(req.params.id)
  if (!row) return res.status(404).json({ error: 'scheduled task not found' })
  const stopped = cancelSchedule(row.id)
  res.json({ ok: true, stopped, schedule: toPublic(getSchedule(row.id) ?? row) })
})

/**
 * Finished runs since `since`, for the always-mounted watcher. It is what lets a task that
 * fired while the engineer was on /tickets still announce itself — the same job the other
 * watchers do by polling their own registries.
 */
schedulesRouter.get('/runs/recent', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const since = typeof req.query.since === 'string' ? req.query.since : new Date().toISOString()
  res.json({ runs: scheduleRunsSince(project.id, since), now: new Date().toISOString() })
})

schedulesRouter.get('/:id/runs', (req, res) => {
  const row = getSchedule(req.params.id)
  if (!row) return res.status(404).json({ error: 'scheduled task not found' })
  res.json({ runs: listScheduleRuns(row.id) })
})

/**
 * What a cron expression MEANS, for the dialog's live preview.
 *
 * The browser deliberately has no cron parser (see cron.ts), so the frequency controls
 * compose an expression and ask here what it says and when it would fire. An invalid one
 * answers `valid: false` with the parser's own sentence rather than a 400 — the engineer is
 * mid-typing in a custom-cron field, and a red toast per keystroke is not feedback.
 */
schedulesRouter.post('/preview', (req, res) => {
  const cron = typeof req.body?.cron === 'string' ? req.body.cron.trim() : ''
  if (!isValidCron(cron)) {
    let reason = 'Not a schedule this portal can run.'
    try {
      nextRun(cron)
    } catch (err) {
      reason = err instanceof Error ? err.message : reason
    }
    return res.json({ valid: false, error: reason })
  }
  // Three firings, not one: "every day at 9" and "every Monday at 9" look identical from a
  // single next-run line, and the list is what makes the difference obvious before saving.
  const upcoming: string[] = []
  let cursor = new Date()
  for (let i = 0; i < 3; i++) {
    const hit = nextRun(cron, cursor)
    if (!hit) break
    upcoming.push(hit.toISOString())
    cursor = hit
  }
  res.json({ valid: true, description: describeCron(cron), upcoming })
})

// ------------------------------------------------------------------ /parse
//
// One sentence → a schedule DRAFT. Never a stored schedule: the answer is rendered in a
// confirmation dialog and the engineer presses Create. An automation that appears without
// anybody approving it is the one failure mode worth designing against here.

/** Pull the first {...} object out of a model reply (tolerant of fences and prose). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  if (!s.startsWith('{')) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
  }
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const PARSE_TIMEOUT = 60_000

schedulesRouter.post('/parse', async (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) return res.status(400).json({ error: 'Type what you want scheduled first.' })
  if (text.length > MAX_PROMPT) {
    return res.status(413).json({ error: `That is longer than ${MAX_PROMPT} characters.` })
  }

  const draft = (cron: string, prompt: string, title: string, source: 'local' | 'ai') => ({
    source,
    draft: {
      title: title.slice(0, MAX_TITLE),
      prompt,
      cron,
      description: describeCron(cron),
      nextRunAt: nextRunIso(cron),
    },
  })

  // Layer 1 — the deterministic reader. Free, instant, and right for the phrasings that
  // make up nearly every scheduled QC task.
  const local = parseWhen(text)
  if (local) {
    const prompt = stripWhen(text, local.spans)
    return res.json(draft(local.cron, prompt, titleFrom(prompt), 'local'))
  }

  // Layer 2 — ask a cheap model, ONLY because layer 1 found no timing at all.
  const now = new Date()
  const prompt = [
    'Turn this request into a repeating schedule for a QC engineer.',
    `Right now it is ${now.toString()}.`,
    '',
    'The request, verbatim:',
    JSON.stringify(text),
    '',
    'Reply with ONLY this JSON, no prose and no code fences:',
    '{"cron":"<5-field cron, local time>","title":"<short title, max 60 chars>","prompt":"<the task itself, with the timing words removed>"}',
    '',
    'Rules:',
    '- 5 fields only: minute hour day-of-month month day-of-week. No seconds, no @daily.',
    '- If the request names no timing at all, answer {"cron":""} and nothing else matters.',
    '- Keep the task in the language it was written in.',
    '- Never schedule more often than every 5 minutes.',
  ].join('\n')

  const r = await runClaude(
    ['-p', '--output-format', 'json', '--model', 'haiku', '--strict-mcp-config'],
    PARSE_TIMEOUT,
    { usageSource: 'schedule-parse', model: 'haiku', input: prompt },
  )
  const parsed = extractJsonObject(parseClaudeJsonResult(r.stdout).text)
  const cron = typeof parsed?.cron === 'string' ? parsed.cron.trim() : ''
  if (!cron || !isValidCron(cron)) {
    // A refusal, not a guess: the composer keeps the typed text and asks for a time.
    return res.status(422).json({
      error:
        r.timedOut
          ? 'Working out the schedule took too long — say when it should run (e.g. “every day at 9am”).'
          : 'I could not tell WHEN this should run. Add a time, like “every day at 9am” or “mỗi thứ 2 lúc 8h”.',
    })
  }
  const task = typeof parsed?.prompt === 'string' && parsed.prompt.trim() ? parsed.prompt.trim() : text
  const title = typeof parsed?.title === 'string' && parsed.title.trim() ? parsed.title.trim() : titleFrom(task)
  res.json(draft(cron, task.slice(0, MAX_PROMPT), title, 'ai'))
})
