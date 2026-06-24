import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getCrawlJob } from '@/lib/api'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active ticket-crawl job — regardless of which page is open — and
// fires the toast + bell notification when one finishes. Always mounted at the app
// root so completion is reported even if the user left /tickets or reloaded mid-crawl.
// Mirrors TestCaseJobWatcher.
//
// Active jobs are discovered from the per-project keys TicketsPage writes:
//   qc.crawlJob.<projectId> = <jobId>
// On completion (or if the job is gone) we clear that key so it isn't re-watched.

const ACTIVE_JOB_PREFIX = 'qc.crawlJob.'
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

export default function CrawlJobWatcher() {
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
        job = (await getCrawlJob(w.jobId, w.projectId)).job
      } catch {
        // 404 / network — job pruned or server restarted. Stop watching it.
        handled.add(w.jobId)
        clearWatched(w.projectId)
        return
      }
      if (cancelled || job.status !== 'done' || handled.has(job.id)) return

      handled.add(job.id)
      clearWatched(w.projectId)

      // Refresh the crawled-ticket lists on both pages that show them.
      queryClient.invalidateQueries({ queryKey: ['crawled-tickets', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['crawled', w.projectId] })

      const ok = job.items.filter((i) => i.status === 'done').length
      const failed = job.items.length - ok
      const where = projectName(w.projectId)
      if (failed === 0) {
        const title = `Crawled ${ok} ticket${ok === 1 ? '' : 's'}`
        toast.success(title)
        notify({ kind: 'success', title, description: `${where} · saved to testing/tickets.`, to: '/tickets' })
      } else {
        const title = `Crawled ${ok}/${job.items.length} tickets`
        const description = `${where} · ${failed} failed — see the log.`
        toast.warning(title, { description })
        notify({ kind: ok > 0 ? 'warning' : 'error', title, description, to: '/tickets' })
      }
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
