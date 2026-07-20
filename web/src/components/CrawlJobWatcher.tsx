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
//   qc.crawlJob.<projectId> = JSON array of started job ids (legacy: a bare id string)
// Crawls can run back-to-back from the queue, so each project key holds a LIST — we
// announce each id and remove just that one when it finishes (a bare string from an
// older build is tolerated on read).

const ACTIVE_JOB_PREFIX = 'qc.crawlJob.'
const POLL_MS = 2000

// Module-level so it survives this component's remounts (incl. StrictMode's
// double-mount in dev) — a job is only ever announced once per session.
const handled = new Set<string>()

interface WatchedJob {
  projectId: string
  jobId: string
}

function readJobIds(projectId: string): string[] {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(ACTIVE_JOB_PREFIX + projectId)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
    return typeof v === 'string' && v ? [v] : []
  } catch {
    return [raw] // legacy single-id string
  }
}

function listWatchedJobs(): WatchedJob[] {
  const out: WatchedJob[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(ACTIVE_JOB_PREFIX)) continue
      const projectId = key.slice(ACTIVE_JOB_PREFIX.length)
      for (const jobId of readJobIds(projectId)) out.push({ projectId, jobId })
    }
  } catch {
    /* storage unavailable */
  }
  return out
}

// Remove just the finished job id, leaving any sibling (queued back-to-back) ids so
// they're still announced. Removes the whole key once the list empties.
function removeWatched(projectId: string, jobId: string): void {
  try {
    const ids = readJobIds(projectId).filter((id) => id !== jobId)
    if (ids.length) localStorage.setItem(ACTIVE_JOB_PREFIX + projectId, JSON.stringify(ids))
    else localStorage.removeItem(ACTIVE_JOB_PREFIX + projectId)
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
        removeWatched(w.projectId, w.jobId)
        return
      }
      if (cancelled || job.status !== 'done' || handled.has(job.id)) return

      handled.add(job.id)
      removeWatched(w.projectId, job.id)

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
