import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runKnowledgeUpdate } from './learn.js'
import { generateTestcaseVersion } from './testcaseGen.js'

// In-memory background jobs for test-case generation. A job runs server-side, so
// it keeps going even if the browser reloads or navigates away — the client just
// polls by id to show progress. Jobs live for the life of the server process
// (a server restart drops them); that's enough to survive browser reloads.

export type TestcaseItemStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** Where a whole job sits. `paused` is resumable; `cancelled`/`done` are terminal. */
export type TestcaseJobStatus = 'running' | 'paused' | 'done' | 'cancelled'

export interface TestcaseJobItem {
  folder: string
  status: TestcaseItemStatus
  version?: number
  savedTo?: string
  error?: string
  /** Optional live app URL for this ticket — server-only, not exposed publicly. */
  appUrl?: string
}

export type TestcaseLogLevel = 'info' | 'success' | 'error'

export interface TestcaseLogLine {
  time: string // ISO
  level: TestcaseLogLevel
  /** The folder this line relates to, if any (lets the UI group/label lines). */
  folder?: string
  text: string
}

const MAX_LOG_LINES = 800 // keep the per-job log bounded
const MAX_PARALLEL = 3 // how many tickets a single job generates at once

interface TestcaseJob {
  id: string
  projectId: string
  projectName: string
  rootPath: string
  sources: { tag: string; path: string }[]
  template: { name?: string; content?: string } | null
  instructions: string
  model: string
  // Per-project AI post-step settings, captured when the job starts.
  groundingCheck: boolean
  groundingCheckModel: string
  autoLearn: boolean
  autoLearnModel: string
  items: TestcaseJobItem[]
  logs: TestcaseLogLine[]
  total: number
  doneCount: number
  status: TestcaseJobStatus
  createdAt: string
  updatedAt: string
  // --- control (server-only) ---
  /** Aborts every item currently generating, so pause/cancel takes effect promptly. */
  aborts: Set<AbortController>
  pauseRequested: boolean
  cancelRequested: boolean
}

/** What we expose to the client — never the rootPath / template / instructions / control. */
export interface PublicTestcaseJob {
  id: string
  projectId: string
  status: TestcaseJobStatus
  total: number
  doneCount: number
  createdAt: string
  updatedAt: string
  items: TestcaseJobItem[]
  logs: TestcaseLogLine[]
}

const jobs = new Map<string, TestcaseJob>()
const MAX_JOBS = 50 // keep the registry bounded; prune oldest finished jobs

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: TestcaseJob): PublicTestcaseJob {
  return {
    id: j.id,
    projectId: j.projectId,
    status: j.status,
    total: j.total,
    doneCount: j.doneCount,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    // Strip the server-only appUrl; expose only the public item fields.
    items: j.items.map(({ folder, status, version, savedTo, error }) => ({
      folder,
      status,
      version,
      savedTo,
      error,
    })),
    logs: j.logs.map((l) => ({ ...l })),
  }
}

function pushLog(job: TestcaseJob, level: TestcaseLogLevel, text: string, folder?: string): void {
  job.logs.push({ time: nowIso(), level, folder, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  // Only terminal jobs are prunable — a paused job is still resumable.
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'cancelled')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(j.id)
  }
}

/** doneCount = items that won't be processed again (done/error/cancelled). */
function recountDone(job: TestcaseJob): void {
  job.doneCount = job.items.filter(
    (i) => i.status === 'done' || i.status === 'error' || i.status === 'cancelled',
  ).length
}

/** Settle a job once its run loop stops, honoring a pending cancel/pause request. */
function finalize(job: TestcaseJob): void {
  if (job.cancelRequested) {
    for (const it of job.items) {
      if (it.status === 'pending' || it.status === 'running') it.status = 'cancelled'
    }
    recountDone(job)
    job.cancelRequested = false
    job.pauseRequested = false
    job.status = 'cancelled'
    const ok = job.items.filter((i) => i.status === 'done').length
    pushLog(job, 'info', `Cancelled — ${ok}/${job.total} generated`)
  } else if (job.pauseRequested) {
    job.pauseRequested = false
    job.status = 'paused'
    const remaining = job.items.filter((i) => i.status === 'pending').length
    pushLog(job, 'info', `Paused — ${remaining} ticket${remaining === 1 ? '' : 's'} remaining`)
  } else {
    job.status = 'done'
    const ok = job.items.filter((i) => i.status === 'done').length
    pushLog(job, ok === job.total ? 'success' : 'info', `Done — ${ok}/${job.total} succeeded`)
  }
  job.updatedAt = nowIso()
}

/** Generate one ticket. Never throws — outcome is recorded on the item. */
async function processItem(job: TestcaseJob, item: TestcaseJobItem, i: number): Promise<void> {
  item.status = 'running'
  item.error = undefined
  const ac = new AbortController()
  job.aborts.add(ac)
  pushLog(job, 'info', `▶ [${i + 1}/${job.total}] ${item.folder} — generating…`, item.folder)
  try {
    const r = await generateTestcaseVersion({
      rootPath: job.rootPath,
      projectName: job.projectName,
      folder: item.folder,
      template: job.template,
      instructions: job.instructions,
      model: job.model,
      appUrl: item.appUrl,
      sources: job.sources,
      groundingCheck: job.groundingCheck,
      groundingCheckModel: job.groundingCheckModel,
      signal: ac.signal,
      onLog: (l) => pushLog(job, l.level, l.text, item.folder),
    })
    item.status = 'done'
    item.version = r.version
    item.savedTo = r.savedTo
    pushLog(job, 'success', `✓ ${item.folder} — saved v${r.version}`, item.folder)
  } catch (err) {
    if (ac.signal.aborted) {
      // Interrupted by pause/cancel — keep it pending so a resume regenerates it.
      item.status = 'pending'
      pushLog(job, 'info', `■ ${item.folder} — stopped`, item.folder)
    } else {
      item.status = 'error'
      item.error = (err as Error).message || 'Generation failed'
      pushLog(job, 'error', `✗ ${item.folder} — ${item.error}`, item.folder)
    }
  } finally {
    job.aborts.delete(ac)
  }
  recountDone(job)
  job.updatedAt = nowIso()
}

/**
 * Process pending items with up to MAX_PARALLEL running at once. Resumable:
 * already-done items are skipped, and the pool stops claiming new work the moment
 * a pause/cancel is requested (in-flight items are aborted by pause/cancel). Never
 * throws — failures are recorded per item.
 */
async function runJob(job: TestcaseJob): Promise<void> {
  job.status = 'running'
  job.pauseRequested = false
  const pending = job.items.filter((i) => i.status === 'pending').length
  pushLog(
    job,
    'info',
    `Processing ${pending} ticket${pending === 1 ? '' : 's'} · model ${job.model} · up to ${MAX_PARALLEL} at once`,
  )

  // Shared cursor across workers: each worker claims the next pending item until
  // the list is exhausted or a pause/cancel is requested.
  let cursor = 0
  async function worker(): Promise<void> {
    for (;;) {
      if (job.cancelRequested || job.pauseRequested) return
      let item: TestcaseJobItem | null = null
      let idx = -1
      while (cursor < job.items.length) {
        const i = cursor++
        if (job.items[i].status === 'pending') {
          item = job.items[i]
          idx = i
          break
        }
      }
      if (!item) return // no more pending work
      await processItem(job, item, idx)
    }
  }

  const workers = Math.min(MAX_PARALLEL, Math.max(1, pending))
  await Promise.all(Array.from({ length: workers }, () => worker()))

  // On natural completion (not pause/cancel), reflect on the generated cases and
  // auto-capture durable facts. Best-effort; never blocks finalize on failure.
  if (!job.cancelRequested && !job.pauseRequested && job.autoLearn) {
    await learnFromTestcases(job)
  }
  finalize(job)
}

/** AI auto-capture from the test cases this job generated (see learn.ts). */
async function learnFromTestcases(job: TestcaseJob): Promise<void> {
  const done = job.items.filter((i) => i.status === 'done' && i.savedTo)
  if (!done.length) return
  const parts: string[] = []
  for (const it of done) {
    try {
      const content = fs.readFileSync(path.join(job.rootPath, it.savedTo!), 'utf8').slice(0, 6_000)
      parts.push(`### Test cases for ${it.folder} (v${it.version})\n${content}`)
    } catch {
      /* skip unreadable item */
    }
  }
  if (!parts.length) return
  pushLog(job, 'info', 'AI reflecting on the generated test cases to update project knowledge…')
  try {
    const learned = await runKnowledgeUpdate({
      rootPath: job.rootPath,
      projectName: job.projectName,
      source: `ai · test cases · ${nowIso().slice(0, 10)}`,
      context: `Manual test cases were generated for ${done.length} ticket(s).\n\n${parts.join('\n\n')}`,
      model: job.autoLearnModel,
    })
    const names = [...learned.memory, ...learned.knowledge]
    if (names.length) {
      pushLog(job, 'success', `AI updated project knowledge: ${names.length} note${names.length === 1 ? '' : 's'} (${names.join(', ')})`)
    } else {
      pushLog(job, 'info', `AI found nothing new to remember${learned.skipped ? ` (${learned.skipped})` : ''}`)
    }
  } catch {
    /* best-effort — auto-learn failures are silent */
  }
}

/** Guard runJob so an unexpected throw can't crash the process or wedge the job. */
function runJobSafely(job: TestcaseJob): void {
  runJob(job).catch((err) => {
    for (const it of job.items) {
      if (it.status === 'pending' || it.status === 'running') {
        it.status = 'error'
        it.error = (err as Error).message || 'Generation failed'
      }
    }
    recountDone(job)
    job.aborts.clear()
    job.status = 'done'
    pushLog(job, 'error', `Job aborted — ${(err as Error).message || 'unexpected error'}`)
  })
}

export function startTestcaseJob(opts: {
  projectId: string
  projectName: string
  rootPath: string
  sources: { tag: string; path: string }[]
  folders: string[]
  /** Optional per-folder live app URL (folder → url) to ground that ticket's cases. */
  appUrls?: Record<string, string>
  template: { name?: string; content?: string } | null
  instructions: string
  model: string
  groundingCheck: boolean
  groundingCheckModel: string
  autoLearn: boolean
  autoLearnModel: string
}): PublicTestcaseJob {
  const job: TestcaseJob = {
    id: randomUUID(),
    projectId: opts.projectId,
    projectName: opts.projectName,
    rootPath: opts.rootPath,
    sources: opts.sources,
    template: opts.template,
    instructions: opts.instructions,
    model: opts.model,
    groundingCheck: opts.groundingCheck,
    groundingCheckModel: opts.groundingCheckModel,
    autoLearn: opts.autoLearn,
    autoLearnModel: opts.autoLearnModel,
    items: opts.folders.map((folder) => ({
      folder,
      status: 'pending' as const,
      appUrl: opts.appUrls?.[folder],
    })),
    logs: [],
    total: opts.folders.length,
    doneCount: 0,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    aborts: new Set(),
    pauseRequested: false,
    cancelRequested: false,
  }
  jobs.set(job.id, job)
  prune()

  // Fire and forget — the route returns immediately.
  runJobSafely(job)

  return toPublic(job)
}

export function getTestcaseJob(id: string): PublicTestcaseJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

/**
 * Request a pause: the in-flight ticket is interrupted (kept pending) and the loop
 * stops, leaving the job `paused` and resumable. No-op unless currently running.
 */
export function pauseTestcaseJob(id: string): PublicTestcaseJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'running') {
    j.pauseRequested = true
    for (const ac of j.aborts) ac.abort() // interrupt in-flight items so the pause lands promptly
  }
  return toPublic(j)
}

/** Resume a paused job — re-enter the loop and process the remaining pending items. */
export function resumeTestcaseJob(id: string): PublicTestcaseJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'paused') {
    j.cancelRequested = false
    j.pauseRequested = false
    runJobSafely(j)
  }
  return toPublic(j)
}

/**
 * Cancel a job (terminal). If it's running, the current ticket is killed and the
 * loop finalizes as cancelled; if it's already paused, finalize right here.
 */
export function cancelTestcaseJob(id: string): PublicTestcaseJob | undefined {
  const j = jobs.get(id)
  if (!j) return undefined
  if (j.status === 'running') {
    j.cancelRequested = true
    for (const ac of j.aborts) ac.abort()
  } else if (j.status === 'paused') {
    j.cancelRequested = true
    finalize(j) // loop isn't running — settle it now
  }
  return toPublic(j)
}

export function listTestcaseJobs(projectId: string): PublicTestcaseJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}
