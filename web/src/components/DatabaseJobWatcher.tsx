import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getDatabaseJob } from '@/lib/api'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active database connect/sync job — regardless of which page is
// open — and fires the toast + bell notification when one finishes. Always mounted
// at the app root so completion is reported even if the user left /database or
// reloaded mid-connect. Mirrors SourceJobWatcher.
//
// Active jobs are discovered from the per-project keys DatabasePage writes:
//   qc.databaseJob.<projectId> = <jobId>

const ACTIVE_JOB_PREFIX = 'qc.databaseJob.'
const POLL_MS = 2000

// Module-level so it survives remounts (incl. StrictMode's dev double-mount).
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

export default function DatabaseJobWatcher() {
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
        job = (await getDatabaseJob(w.jobId, w.projectId)).job
      } catch {
        handled.add(w.jobId)
        clearWatched(w.projectId)
        return
      }
      if (cancelled || job.status === 'running' || handled.has(job.id)) return

      handled.add(job.id)
      clearWatched(w.projectId)

      // The connection (or schema) changed — refresh the database view + knowledge docs.
      queryClient.invalidateQueries({ queryKey: ['databases', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['knowledge', w.projectId] })

      const where = job.tag ? `${job.tag} · ${projectName(w.projectId)}` : projectName(w.projectId)
      const verb = job.kind === 'connect' ? 'Connected' : 'Synced'
      if (job.status === 'done') {
        const title = `${verb} database`
        const tables = job.result ? `${job.result.tableCount} tables mapped` : ''
        toast.success(title, { description: `${where}${tables ? ` · ${tables}` : ''}` })
        notify({ kind: 'success', title, description: `${where}${tables ? ` · ${tables}` : ''}`, to: '/database' })
      } else {
        const title = `Database ${job.kind} failed`
        const description = `${where} · ${job.error ?? 'see the log'}`
        toast.error(title, { description })
        notify({ kind: 'error', title, description, to: '/database' })
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
