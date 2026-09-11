import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { CheckCircle2, Loader2, Sparkles, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import SyncStage from '@/components/SyncStage'
import {
  cancelSyncJob,
  closeSyncShare,
  dismissSyncJob,
  fetchActiveSyncJob,
  fetchSyncJob,
  fetchSyncShares,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import {
  formatBytes,
  jobIsBlocking,
  jobPercent,
  shareIsBlocking,
  sharePercent,
  stageStateForJob,
  stageStateForShare,
} from '@/lib/sync'
import type { SyncJob, SyncShare } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The part of AI Sync that holds BOTH machines still while a sync runs.
 *
 * Mounted once in `App`, above the shell, for the same reason the other job watchers
 * are: a sync survives navigating away, and the person who started it may well be on
 * another page when it finishes. But this one also BLOCKS, which the others never do,
 * and that is a deliberate choice rather than a heavy-handed one:
 *
 *   A sync rewrites files under a project root while the portal is a tool for reading
 *   and writing files under a project root. Editing a test case, launching a QC run
 *   or crawling tickets during the two minutes a transfer is overwriting that same
 *   folder produces a result nobody can reason about afterwards — the losing write
 *   just quietly isn't there. So both ends are held: the machine pulling, and the
 *   machine being pulled from.
 *
 * The escape hatch is never removed. A transfer can always be cancelled from the
 * guest and the share can always be closed from the host, so a stalled peer or a dead
 * tunnel costs one click, not a restart. What there is no button for is "carry on
 * working anyway" — that is the whole point.
 */

function Veil({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="AI Sync in progress"
      className="qc-sync-veil fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-3xl border border-border/60 bg-card p-6 shadow-lg">
        {children}
      </div>
    </div>
  )
}

function Heading({
  state,
  title,
  subtitle,
}: {
  state: 'busy' | 'done' | 'error'
  title: string
  subtitle: string
}) {
  return (
    <div className="mb-5 flex items-start gap-3">
      <span
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-2xl',
          state === 'done'
            ? 'bg-emerald-500 text-white'
            : state === 'error'
              ? 'bg-destructive text-white'
              : 'bg-foreground text-background',
        )}
      >
        {state === 'done' ? (
          <CheckCircle2 className="size-5" />
        ) : state === 'error' ? (
          <TriangleAlert className="size-5" />
        ) : (
          <Loader2 className="size-5 animate-spin" />
        )}
      </span>
      <div className="min-w-0 space-y-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  )
}

/** The AI's account of what arrived. Rendered as-is: it is already plain bullets. */
function SummaryPanel({ text }: { text: string }) {
  if (!text.trim()) return null
  return (
    <div className="mt-4 space-y-1.5 rounded-2xl border border-border/60 bg-muted/60 p-3">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Sparkles className="size-3" /> What changed
      </p>
      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  )
}

export default function AiSyncWatcher() {
  const queryClient = useQueryClient()
  const { refetch: refetchProjects } = useProjects()

  // Once a sync is seen, the watcher keeps following THAT id past the point where it
  // stops being "active", so the outcome is shown rather than the overlay vanishing
  // at the exact moment there is finally something to read.
  const [stickyJobId, setStickyJobId] = useState<string | null>(null)
  const [stickyShareProject, setStickyShareProject] = useState<string | null>(null)
  // A ref, not state: it only guards the one-shot toast, and making it state would
  // add a render to every completed sync for nothing.
  const announced = useRef<string | null>(null)

  const active = useQuery({
    queryKey: ['sync-active'],
    queryFn: fetchActiveSyncJob,
    // Cheap, and it is the only way this machine learns it started a sync from another
    // tab or before a reload.
    refetchInterval: stickyJobId ? 1200 : 5000,
  })

  const tracked = useQuery({
    queryKey: ['sync-job', stickyJobId],
    queryFn: () => fetchSyncJob(stickyJobId as string),
    enabled: !!stickyJobId,
    refetchInterval: 1200,
    retry: false,
  })

  const shares = useQuery({
    queryKey: ['sync-shares'],
    queryFn: fetchSyncShares,
    refetchInterval: stickyShareProject ? 1200 : 5000,
  })

  const liveJob = active.data?.job ?? null
  const job: SyncJob | null = (stickyJobId && tracked.data?.job) || liveJob

  // The tracked job is gone (dismissed elsewhere, or the server restarted and jobs live
  // in memory only). Let go, or this polls a 404 every 1.2s for the life of the tab.
  if (stickyJobId && tracked.isError) setStickyJobId(null)

  // Latch on to whatever is running, DURING RENDER rather than in an effect: this is
  // "adjust state when the polled data changes", and an effect would show one frame of
  // the wrong overlay before correcting itself.
  if (liveJob && liveJob.id !== stickyJobId) setStickyJobId(liveJob.id)

  const blockingShare: SyncShare | null =
    (shares.data?.shares ?? []).find((s) => shareIsBlocking(s)) ??
    (shares.data?.shares ?? []).find((s) => s.projectId === stickyShareProject) ??
    null

  const liveShare = (shares.data?.shares ?? []).find((s) => shareIsBlocking(s))
  if (liveShare && liveShare.projectId !== stickyShareProject) {
    setStickyShareProject(liveShare.projectId)
  }

  // A finished sync changed files on disk; the rest of the app is holding stale data.
  useEffect(() => {
    if (!job || job.status !== 'done' || announced.current === job.id) return
    announced.current = job.id
    void queryClient.invalidateQueries()
    void refetchProjects()
    toast.success('AI Sync complete', {
      description: `${job.projectName} updated from ${job.host?.name ?? 'the other machine'}.`,
    })
  }, [job, queryClient, refetchProjects])

  // ---------------------------------------------------------------- guest overlay
  if (job && stickyJobId === job.id && job.status !== 'cancelled') {
    const busy = jobIsBlocking(job)
    const finished = job.status === 'done' || job.status === 'error'
    if (!busy && !finished) return null // 'ready' — the pull dialog owns that step

    const lastLog = job.logs[job.logs.length - 1]?.text ?? ''
    return (
      <Veil>
        <Heading
          state={job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : 'busy'}
          title={
            job.status === 'done'
              ? 'Sync complete'
              : job.status === 'error'
                ? 'Sync stopped'
                : 'AI Sync in progress'
          }
          subtitle={
            finished
              ? (job.error ??
                `“${job.projectName}” is up to date with ${job.host?.name ?? 'the other machine'}.`)
              : 'Both machines are held until this finishes, so nothing writes into the project folder mid-transfer.'
          }
        />

        <SyncStage
          from={job.host}
          to={job.self}
          state={stageStateForJob(job)}
          percent={jobPercent(job)}
          caption={job.progress.message}
          detail={
            job.progress.bytesTotal > 0
              ? `${formatBytes(job.progress.bytesDone)} of ${formatBytes(job.progress.bytesTotal)} · ${job.progress.filesDone}/${job.progress.filesTotal} files`
              : lastLog
          }
        />

        {job.plan && (
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            {[
              { label: 'New', value: job.plan.newCount },
              { label: 'Updated', value: job.plan.changedCount },
              { label: 'Already same', value: job.plan.sameCount },
            ].map((tile) => (
              <div key={tile.label} className="rounded-2xl border border-border/60 bg-muted/60 p-2.5">
                <div className="text-lg font-semibold tabular-nums">{tile.value}</div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {tile.label}
                </div>
              </div>
            ))}
          </div>
        )}

        {finished && <SummaryPanel text={job.summary} />}

        {job.failures.length > 0 && (
          <ul className="mt-3 max-h-24 space-y-0.5 overflow-y-auto rounded-2xl border border-destructive/25 bg-destructive/10 p-2.5 font-mono text-[11px] text-destructive">
            {job.failures.slice(0, 20).map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 flex justify-end gap-2">
          {finished ? (
            <Button
              onClick={() => {
                void dismissSyncJob(job.id).catch(() => {})
                setStickyJobId(null)
              }}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Done
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => {
                void cancelSyncJob(job.id)
                  .then(() => toast.info('Sync cancelled'))
                  .catch(() => {})
              }}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <X className="size-4" />
              Cancel sync
            </Button>
          )}
        </div>
      </Veil>
    )
  }

  // ---------------------------------------------------------------- host overlay
  if (blockingShare && (shareIsBlocking(blockingShare) || blockingShare.finishedAt)) {
    const share = blockingShare
    const finished = share.state === 'done' || share.state === 'error'
    return (
      <Veil>
        <Heading
          state={share.state === 'done' ? 'done' : share.state === 'error' ? 'error' : 'busy'}
          title={
            finished ? 'Sync finished' : `${share.peer?.name ?? 'Another machine'} is syncing from you`
          }
          subtitle={
            finished
              ? (share.error ??
                `${share.peer?.name ?? 'The other machine'} finished pulling “${share.projectName}”.`)
              : `“${share.projectName}” is being read right now, so this portal is held until it finishes.`
          }
        />

        <SyncStage
          from={share.host}
          to={share.peer}
          state={stageStateForShare(share)}
          percent={sharePercent(share)}
          caption={share.progress?.message || 'Preparing…'}
          detail={
            share.progress && share.progress.bytesTotal > 0
              ? `${formatBytes(share.progress.bytesDone)} of ${formatBytes(share.progress.bytesTotal)} sent`
              : `${share.filesServed} file(s), ${formatBytes(share.bytesServed)} served`
          }
        />

        {finished && <SummaryPanel text={share.summary} />}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant={finished ? 'default' : 'outline'}
            onClick={() => {
              void closeSyncShare(share.projectId)
                .then(() => {
                  setStickyShareProject(null)
                  void shares.refetch()
                })
                .catch(() => {})
            }}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {finished ? 'Done' : (
              <>
                <X className="size-4" />
                Stop sharing
              </>
            )}
          </Button>
        </div>
      </Veil>
    )
  }

  return null
}
