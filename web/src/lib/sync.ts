import type { SyncJob, SyncShare } from './types'
import type { SyncStageState } from '@/components/SyncStage'

/**
 * The shared vocabulary of AI Sync's three surfaces — the share dialog, the pull
 * dialog, and the blocking overlay that covers BOTH machines while a sync runs.
 *
 * It lives here rather than in any one of them because the two ends must agree: the
 * host and the guest are looking at the same transfer from opposite sides, and if
 * "42%" is computed one way on one screen and another way on the other, the pair of
 * people watching them conclude the sync is broken. One `percent`, one set of stage
 * states, one byte formatter.
 */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/**
 * Progress as a percentage of BYTES, not of files.
 *
 * Files would be the easy choice and it is the wrong one here: a run-evidence folder
 * is a few hundred tiny .md files next to one 300 MB screen recording, so a file
 * count races to 97% and then sits still for two minutes — which reads as a hang. A
 * byte count moves at the speed the wire is actually moving.
 */
export function percentOf(done: number, total: number): number {
  if (total <= 0) return done > 0 ? 100 : 0
  return Math.max(0, Math.min(100, (done / total) * 100))
}

/** The guest's job, as the shared stage draws it. */
export function stageStateForJob(job: SyncJob | null): SyncStageState {
  if (!job) return 'idle'
  switch (job.status) {
    case 'pairing':
      return 'waiting'
    case 'ready':
      return 'connected'
    case 'running':
      // `compare` hashes local files and sends nothing, so the wire must NOT show
      // packets during it — a moving line while nothing moves is a lie the user
      // later reads as "it stalled at 0%".
      return job.progress.phase === 'transfer' ? 'transferring' : 'connected'
    case 'done':
      return 'done'
    case 'error':
    case 'cancelled':
      return 'error'
    default:
      return 'idle'
  }
}

/** The host's share, as the same stage draws it. */
export function stageStateForShare(share: SyncShare | null): SyncStageState {
  if (!share) return 'idle'
  switch (share.state) {
    case 'waiting':
      return 'waiting'
    case 'paired':
      return 'connected'
    case 'syncing':
      return share.progress?.phase === 'transfer' ? 'transferring' : 'connected'
    case 'done':
      return 'done'
    case 'error':
    case 'revoked':
      return 'error'
    default:
      return 'idle'
  }
}

export function jobPercent(job: SyncJob | null): number {
  if (!job) return 0
  if (job.status === 'done') return 100
  return percentOf(job.progress.bytesDone, job.progress.bytesTotal)
}

export function sharePercent(share: SyncShare | null): number {
  if (!share) return 0
  if (share.state === 'done') return 100
  return percentOf(share.progress?.bytesDone ?? 0, share.progress?.bytesTotal ?? 0)
}

/**
 * Is this share holding the host's screen?
 *
 * Only once bytes are actually being read — `syncing`, never `paired`. Measured on
 * screen: blocking at PAIR time locks the host the instant the code is typed, while
 * the guest is still choosing what to pull and where it lands. The host then sits
 * behind a modal for however long that takes, for a transfer that may never start.
 * Pairing is shown on the share dialog's stage instead, which is information without
 * being a lock.
 */
export function shareIsBlocking(share: SyncShare | null | undefined): boolean {
  return share?.state === 'syncing'
}

/** Same rule for the guest: `pairing` is one HTTP call the dialog already spins for. */
export function jobIsBlocking(job: SyncJob | null | undefined): boolean {
  return job?.status === 'running'
}

/** "in 12 min" / "in 48s" / "expired" — the pairing window, in words. */
export function untilLabel(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return 'expired'
  const mins = Math.floor(ms / 60000)
  if (mins >= 1) return `${mins} min ${Math.floor((ms % 60000) / 1000)}s`
  return `${Math.ceil(ms / 1000)}s`
}
