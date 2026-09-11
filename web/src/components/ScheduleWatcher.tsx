import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { recentScheduleRuns } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { useNotifications } from '@/lib/notifications'

/**
 * Announces a scheduled task that finished while the engineer was somewhere else.
 *
 * Every other watcher on this page polls a job the BROWSER started; this one polls work the
 * SERVER started on its own, which is the whole point of the feature — the answer has to
 * find the engineer, because nobody was watching for it. Mounted in App above the shell so
 * it keeps running on every page.
 *
 * The cursor is the timestamp of the last finish it announced, kept per project in
 * localStorage and SEEDED FROM THE SERVER'S CLOCK on first sight (the `now` each response
 * carries). Seeding from the browser's clock instead would replay every run of the last few
 * minutes on a machine whose clock is a little behind — a burst of stale toasts on open.
 */

const KEY_PREFIX = 'qc.scheduleSeen.'
const POLL_MS = 20_000

function readCursor(projectId: string): string | null {
  try {
    return localStorage.getItem(KEY_PREFIX + projectId)
  } catch {
    return null
  }
}

function writeCursor(projectId: string, iso: string): void {
  try {
    localStorage.setItem(KEY_PREFIX + projectId, iso)
  } catch {
    /* storage unavailable — the worst case is a repeated toast after a reload */
  }
}

/** Announced this session already — survives a remount (StrictMode mounts twice in dev). */
const announced = new Set<string>()

export default function ScheduleWatcher() {
  const { activeProjectId } = useProjects()
  const { notify } = useNotifications()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function tick(): Promise<void> {
      const projectId = activeProjectId!
      try {
        const since = readCursor(projectId) ?? new Date().toISOString()
        const { runs, now } = await recentScheduleRuns(projectId, since)
        if (cancelled) return
        // Move the cursor to the SERVER's clock even when nothing came back: that is what
        // keeps the window from growing without bound while the portal sits idle.
        writeCursor(projectId, runs.length ? (runs[runs.length - 1].finishedAt ?? now) : now)
        for (const run of runs) {
          if (announced.has(run.id)) continue
          announced.add(run.id)
          const failed = run.status === 'error'
          const title = failed ? `Scheduled task failed — ${run.title}` : `Scheduled task done — ${run.title}`
          const description = failed
            ? (run.error ?? 'it did not finish')
            : run.answer.split('\n').find((l) => l.trim())?.slice(0, 140) || 'It answered.'
          if (failed) toast.error(title, { description })
          else toast.success(title, { description })
          notify({ kind: failed ? 'error' : 'success', title, description, to: '/scheduled' })
        }
        if (runs.length) {
          queryClient.invalidateQueries({ queryKey: ['schedules', projectId] })
        }
      } catch {
        /* the server is restarting or the project went away — try again next tick */
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [activeProjectId, notify, queryClient])

  return null
}
