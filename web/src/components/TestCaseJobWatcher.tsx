import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getTestCaseJob } from '@/lib/api'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active test-case generation job — regardless of which page is open
// — and fires the toast + bell notification when one finishes. This lives at the
// app root (always mounted) so completion is reported even if the user navigated
// away from /testcases, came back (remounting that page), or reloaded mid-job.
//
// Active jobs are discovered from the per-project keys TestCasePage writes:
//   qc.testcaseJob.<projectId> = <jobId>
// On completion (or if the job is gone) we clear that key so it isn't re-watched.

const ACTIVE_JOB_PREFIX = 'qc.testcaseJob.'
const POLL_MS = 2000

// Module-level so it survives this component's remounts (incl. StrictMode's
// double-mount in dev) — a job is only ever announced once per session.
const handled = new Set<string>()

interface WatchedJob {
  projectId: string
  jobId: string
}

function listWatchedJobs(): WatchedJob[] {
  const out: WatchedJob[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(ACTIVE_JOB_PREFIX)) continue
      const jobId = localStorage.getItem(key)
      if (jobId) out.push({ projectId: key.slice(ACTIVE_JOB_PREFIX.length), jobId })
    }
  } catch {
    /* storage unavailable */
  }
  return out
}

function clearWatched(projectId: string): void {
  try {
    localStorage.removeItem(ACTIVE_JOB_PREFIX + projectId)
  } catch {
    /* ignore */
  }
}

export default function TestCaseJobWatcher() {
  const { notify } = useNotifications()
  const queryClient = useQueryClient()

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function projectName(projectId: string): string {
      const projects = queryClient.getQueryData<Project[]>(['projects'])
      return projects?.find((p) => p.id === projectId)?.name ?? 'your project'
    }

    async function checkJob(w: WatchedJob): Promise<void> {
      if (handled.has(w.jobId)) return
      let job
      try {
        job = (await getTestCaseJob(w.jobId)).job
      } catch {
        // 404 / network — job pruned or server restarted. Stop watching it.
        handled.add(w.jobId)
        clearWatched(w.projectId)
        return
      }
      if (cancelled || handled.has(job.id)) return
      // Paused jobs are resumable — keep watching; we announce when they truly finish.
      if (job.status === 'paused') return
      // Otherwise only act on terminal states (done or cancelled).
      if (job.status !== 'done' && job.status !== 'cancelled') return

      handled.add(job.id)
      clearWatched(w.projectId)

      // Refresh the views that depend on the freshly written test cases (some may
      // have completed before a cancel).
      queryClient.invalidateQueries({ queryKey: ['crawled', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['testcase-job', job.id] })
      for (const it of job.items) {
        if (it.status === 'done') {
          queryClient.invalidateQueries({
            queryKey: ['testcase-versions', w.projectId, it.folder],
          })
        }
      }

      // A cancel is user-initiated and already acknowledged in the UI — refresh the
      // views above but don't fire a duplicate toast/bell notification.
      if (job.status === 'cancelled') return

      const ok = job.items.filter((i) => i.status === 'done').length
      const failed = job.items.length - ok
      const where = projectName(w.projectId)
      if (failed === 0) {
        const title = `Generated test cases for ${ok} ticket${ok === 1 ? '' : 's'}`
        toast.success(title)
        notify({ kind: 'success', title, description: `${where} · ready to view.`, to: '/testcases' })
      } else {
        const title = `Generated ${ok}/${job.items.length} tickets`
        const description = `${where} · ${failed} failed — see the results.`
        toast.warning(title, { description })
        notify({ kind: ok > 0 ? 'warning' : 'error', title, description, to: '/testcases' })
      }
    }

    async function tick(): Promise<void> {
      const watched = listWatchedJobs()
      // Sequential is fine — there's rarely more than one active job per project.
      for (const w of watched) {
        if (cancelled) return
        await checkJob(w)
      }
      if (!cancelled) timer = setTimeout(tick, POLL_MS)
    }

    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [notify, queryClient])

  return null
}
