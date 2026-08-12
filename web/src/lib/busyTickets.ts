import type { CrawledTicket, TestCaseJob } from './api'
import type { RunSummary } from './types'

/**
 * Why a ticket counts as busy — a QC run of its own, or a test-case generation that
 * hasn't reached it yet. The Run form reports the reason, because "it's already
 * running" and "we're still writing its test cases" call for different next moves.
 */
export type BusyReason = 'run' | 'testcases'

/** A run that has not finished: it is either in flight or waiting to be. */
const LIVE_RUN_STATUS = new Set<RunSummary['status']>(['running', 'queued', 'paused'])

/**
 * A test-case job that still has work ahead of it. `paused` counts: the engineer
 * stopped it intending to resume, so its tickets are not free yet.
 */
const LIVE_JOB_STATUS = new Set<TestCaseJob['status']>(['running', 'paused'])

/** An item the job hasn't finished with. A `done`/`error`/`cancelled` ticket is free. */
const LIVE_ITEM_STATUS = new Set<TestCaseJob['items'][number]['status']>(['pending', 'running'])

/**
 * Every ticket in this project the portal is already working on, mapped to the reason.
 *
 * The Run form restores the last inputs when it mounts, which re-selects the previous
 * lead ticket — so opening it while ticket A is busy pre-checked A, and an engineer who
 * came to run something ELSE either has to notice and uncheck it or queues A twice.
 * Two sources feed it, and BOTH are needed: a QC run (`runs`) and a test-case
 * generation job (`jobs`), which is the one that was missing — a generation is exactly
 * when the engineer lines up the next ticket to run.
 *
 * A job identifies its tickets by on-disk FOLDER (nested `PARENT/CHILD` for a subtask),
 * while the Run form selects by display id, so `crawled` translates between them.
 * A folder with no crawled match falls back to itself — that is what the picker would
 * be keying on anyway when a ticket.json has no display id.
 */
export function busyTicketIds(opts: {
  projectId?: string
  runs?: RunSummary[]
  jobs?: TestCaseJob[]
  crawled?: CrawledTicket[]
}): Map<string, BusyReason> {
  const busy = new Map<string, BusyReason>()
  const { projectId } = opts
  if (!projectId) return busy

  // Test-case jobs first, so a ticket that is ALSO running reads as 'run' below — the
  // stronger statement, and the one whose queue the engineer would be adding to.
  const idForFolder = new Map<string, string>()
  for (const t of opts.crawled ?? []) {
    if (t.displayId) idForFolder.set(t.name, t.displayId)
  }
  for (const job of opts.jobs ?? []) {
    if (job.projectId !== projectId || !LIVE_JOB_STATUS.has(job.status)) continue
    for (const item of job.items ?? []) {
      if (!LIVE_ITEM_STATUS.has(item.status)) continue
      const id = idForFolder.get(item.folder) ?? item.folder
      if (id) busy.set(id, 'testcases')
    }
  }

  for (const run of opts.runs ?? []) {
    if (run.projectId !== projectId || !LIVE_RUN_STATUS.has(run.status)) continue
    if (run.ticketId) busy.set(run.ticketId, 'run')
  }

  return busy
}
