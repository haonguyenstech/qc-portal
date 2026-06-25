import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getVerifyDesignJob } from '@/lib/api'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active Design Check (verify-design) job — regardless of which page
// is open — and fires the toast + bell notification when one finishes. This lives
// at the app root (always mounted) so completion is reported even if the user
// navigated away from /verify, came back (remounting that page), or reloaded mid-job.
//
// Active jobs are discovered from the per-project keys VerifyDesignPage writes:
//   qc.verifyJob.<projectId> = <jobId>
// On completion (or if the job is gone) we clear that key so it isn't re-watched.

const ACTIVE_JOB_PREFIX = 'qc.verifyJob.'
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

export default function VerifyJobWatcher() {
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
        job = (await getVerifyDesignJob(w.jobId)).job
      } catch {
        // 404 / network — job pruned or server restarted. Stop watching it.
        handled.add(w.jobId)
        clearWatched(w.projectId)
        return
      }
      if (cancelled || handled.has(job.id)) return
      if (job.status === 'running') return // still going — keep watching

      handled.add(job.id)
      clearWatched(w.projectId)

      // The freshly recorded check shows in the page's saved-history list.
      queryClient.invalidateQueries({ queryKey: ['design-checks', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['verify-job', job.id] })

      // A cancel is user-initiated and already acknowledged in the UI — refresh the
      // history but don't fire a duplicate toast/bell notification.
      if (job.status === 'cancelled') return

      const where = projectName(w.projectId)
      if (job.status === 'error') {
        const title = `Design Check failed — ${job.folder}`
        const description = `${where} · ${job.error ?? 'verification failed'}`
        toast.error(title, { description })
        notify({ kind: 'error', title, description, to: '/verify' })
        return
      }

      const n = job.result?.findings.length ?? 0
      const title = `Design Check done — ${job.folder}`
      const description = `${where} · ${n} finding${n === 1 ? '' : 's'}`
      toast.success(title, { description })
      notify({ kind: 'success', title, description, to: '/verify' })
    }

    async function tick(): Promise<void> {
      const watched = listWatchedJobs()
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
