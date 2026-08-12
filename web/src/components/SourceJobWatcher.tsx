import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { getSourceJob } from '@/lib/api'
import { ACTIVE_JOB_PREFIX, loadActiveJobIds, removeActiveJobId } from '@/lib/activeSourceJobs'
import type { Project } from '@/lib/types'
import { useNotifications } from '@/lib/notifications'

// Watches every active source clone/sync job — regardless of which page is open —
// and fires the toast + bell notification when one finishes. Always mounted at the
// app root so completion is reported even if the user left /source or reloaded
// mid-clone. Mirrors CrawlJobWatcher.
//
// Active jobs are discovered from the per-project keys SourceCodePage writes:
//   qc.sourceJob.<projectId> = ["<jobId>", …]
// A project's repos sync concurrently, so each key holds a LIST and a finished job
// is dropped on its own — clearing the whole key would stop watching the siblings
// still running.

const POLL_MS = 2000

// Module-level so it survives remounts (incl. StrictMode's dev double-mount) — a
// job is only ever announced once per session.
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
      const projectId = key.slice(ACTIVE_JOB_PREFIX.length)
      for (const jobId of loadActiveJobIds(projectId)) out.push({ projectId, jobId })
    }
  } catch {
    /* storage unavailable */
  }
  return out
}

export default function SourceJobWatcher() {
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
        job = (await getSourceJob(w.jobId, w.projectId)).job
      } catch {
        handled.add(w.jobId)
        removeActiveJobId(w.projectId, w.jobId)
        return
      }
      if (cancelled || job.status === 'running' || handled.has(job.id)) return

      handled.add(job.id)
      removeActiveJobId(w.projectId, job.id)

      // The connection (or its status) changed — refresh the source view + project list.
      queryClient.invalidateQueries({ queryKey: ['source', w.projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })

      const where = job.tag
        ? `${job.tag} · ${projectName(w.projectId)}`
        : projectName(w.projectId)
      const verb = job.kind === 'clone' ? 'Connected' : 'Synced'
      if (job.status === 'done') {
        const title = `${verb} source code`
        toast.success(title, { description: where })
        notify({ kind: 'success', title, description: `${where} · ${job.result?.lastCommit ?? ''}`.trim(), to: '/source' })
      } else {
        const title = `Source ${job.kind} failed`
        const description = `${where} · ${job.error ?? 'see the log'}`
        toast.error(title, { description })
        notify({ kind: 'error', title, description, to: '/source' })
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
