import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getPerfJob } from '@/lib/api'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active Performance job — page-load audits and k6 load tests —
// regardless of which page is open, and fires the toast + bell notification when
// one finishes. Mounted at the app root so a 10-minute load test still reports
// itself after the engineer navigated to /tickets to do something useful.
//
// Active jobs are discovered from the per-kind, per-project keys PerformancePage
// writes:
//   qc.perfJob.<kind>.<projectId> = <jobId>
// The key is cleared here on completion so a finished job isn't re-watched — the
// page only writes it (on start) and reads it (to reconnect after a reload).

const ACTIVE_JOB_PREFIX = 'qc.perfJob.'
const POLL_MS = 2500

// Module-level so it survives remounts (incl. StrictMode's double-mount in dev):
// a job is announced exactly once per session.
const handled = new Set<string>()

interface WatchedJob {
  storageKey: string
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
      if (!jobId) continue
      // qc.perfJob.<kind>.<projectId> — the project id is everything after the kind.
      const rest = key.slice(ACTIVE_JOB_PREFIX.length)
      const dot = rest.indexOf('.')
      if (dot <= 0) continue
      out.push({ storageKey: key, projectId: rest.slice(dot + 1), jobId })
    }
  } catch {
    /* storage unavailable */
  }
  return out
}

function clearWatched(storageKey: string): void {
  try {
    localStorage.removeItem(storageKey)
  } catch {
    /* ignore */
  }
}

export default function PerfJobWatcher() {
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
        job = (await getPerfJob(w.jobId)).job
      } catch {
        // 404 / network — pruned or the server restarted. Stop watching it.
        handled.add(w.jobId)
        clearWatched(w.storageKey)
        return
      }
      if (cancelled || handled.has(job.id)) return
      if (job.status === 'running') return

      handled.add(job.id)
      // The pointer is cleared, but the report stays reachable from the page's
      // "Recent runs" list, so nothing is lost by forgetting the active job.
      clearWatched(w.storageKey)
      queryClient.invalidateQueries({ queryKey: ['perf-jobs', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['perf-job', job.id] })

      // A stop is user-initiated and already acknowledged on screen.
      if (job.status === 'cancelled') return

      const where = projectName(w.projectId)
      // Deep-link to the tab that actually holds this report — the page reads
      // `?tab=` on mount, so the notification lands on the right tool.
      const to = job.kind === 'load' ? '/performance?tab=load' : '/performance?tab=page'
      if (job.status === 'error') {
        const title =
          job.kind === 'load' ? `Load test failed — ${job.label}` : `Page audit failed — ${job.label}`
        const description = `${where} · ${job.error ?? 'the run did not finish'}`
        toast.error(title, { description })
        notify({ kind: 'error', title, description, to })
        return
      }

      if (job.kind === 'load' && job.loadResult) {
        const r = job.loadResult
        const title = r.thresholdsPassed
          ? `Load test passed — ${job.label}`
          : `Load test crossed a threshold — ${job.label}`
        const description = `${where} · p95 ${Math.round(r.overall.p95)}ms · ${(r.failRate * 100).toFixed(1)}% errors`
        if (r.thresholdsPassed) toast.success(title, { description })
        else toast.error(title, { description })
        notify({
          kind: r.thresholdsPassed ? 'success' : 'error',
          title,
          description,
          to,
        })
        return
      }

      if (job.kind === 'page' && job.pageResult) {
        const r = job.pageResult
        const dupes = r.duplicates.length
        // A redirect outranks every other headline: the load time being announced
        // is the login screen's, not the page the engineer asked about.
        if (r.redirected) {
          const title = 'Page audit redirected — the numbers are for another page'
          const description = `${where} · ended on ${r.finalUrl}`
          toast.warning(title, { description })
          notify({ kind: 'warning', title, description, to })
          return
        }
        const title = `Page audit done — ${Math.round(r.average.loadMs)}ms load`
        const description = dupes
          ? `${where} · ${dupes} API endpoint${dupes === 1 ? '' : 's'} called more than once per load`
          : `${where} · no duplicate API calls`
        if (dupes) toast.warning(title, { description })
        else toast.success(title, { description })
        notify({ kind: dupes ? 'warning' : 'success', title, description, to })
      }
    }

    async function tick(): Promise<void> {
      for (const w of listWatchedJobs()) {
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
