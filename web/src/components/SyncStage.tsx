import { Check, Laptop, Monitor, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MachineIdentity } from '@/lib/types'

/**
 * The picture both halves of AI Sync are drawn around: two machines and the link
 * between them.
 *
 * It exists because a sync is a long wait with almost nothing to report — a manifest
 * comparison, then minutes of file transfer, then a summary. A bare progress bar
 * answers "how far" but not the two questions a QC engineer actually has while they
 * wait: WHICH machine am I talking to, and is anything still moving? So the identity
 * is the primary element (hostname and IP on both ends, not "peer"), and the link
 * carries liveness on its own — packets ride it whenever bytes are moving and stop
 * dead when they are not, which makes a stalled transfer visible without reading a
 * number.
 *
 * The middle column is a FIXED width because the packet animation rides a CSS
 * `offset-path` measured in pixels (`.qc-sync-packet` in index.css); the two machine
 * tiles flex around it. Keep the two in step if either changes.
 */

export type SyncStageState = 'idle' | 'waiting' | 'connected' | 'transferring' | 'done' | 'error'

export interface SyncStageProps {
  /** Where the files come FROM (the host). Null renders an unknown placeholder. */
  from: MachineIdentity | null
  /** Where they go TO. */
  to: MachineIdentity | null
  state: SyncStageState
  /** 0-100. Drives the link's fill and the pill above it. */
  percent?: number
  /** One line under the stage — the live status. */
  caption?: string
  /** A second, quieter line: the current file, the error, the byte count. */
  detail?: string
  /** Label under the left tile when there is no peer yet ("Waiting for a machine…"). */
  fromFallback?: string
  toFallback?: string
}

const LINK_W = 150

const ACCENT: Record<SyncStageState, string> = {
  idle: 'text-muted-foreground',
  waiting: 'text-amber-600',
  connected: 'text-sky-600',
  transferring: 'text-sky-600',
  done: 'text-emerald-600',
  error: 'text-destructive',
}

const STROKE: Record<SyncStageState, string> = {
  idle: 'stroke-border',
  waiting: 'stroke-amber-400',
  connected: 'stroke-sky-400',
  transferring: 'stroke-sky-500',
  done: 'stroke-emerald-500',
  error: 'stroke-destructive',
}

function MachineTile({
  machine,
  fallback,
  role,
  active,
  tone,
  halo,
}: {
  machine: MachineIdentity | null
  fallback: string
  role: string
  active: boolean
  tone: 'neutral' | 'sky' | 'emerald' | 'destructive'
  halo?: boolean
}) {
  const Icon = role === 'From' ? Monitor : Laptop // host on the left, the machine pulling on the right
  return (
    <div className="min-w-0 flex-1">
      <div
        className={cn(
          'relative flex min-w-0 flex-col items-center gap-2 rounded-2xl border px-3 py-4 text-center transition-all duration-300',
          active ? 'border-border bg-muted/60' : 'border-border/60 bg-transparent',
        )}
      >
        {/* "still listening" halo — only while nobody has paired yet */}
        {halo && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-4 size-11 -translate-x-1/2 rounded-2xl bg-amber-400/25 qc-sync-halo"
          />
        )}
        <span
          className={cn(
            'relative flex size-11 shrink-0 items-center justify-center rounded-2xl border transition-colors duration-300',
            tone === 'sky' && 'border-transparent bg-sky-500 text-white',
            tone === 'emerald' && 'border-transparent bg-emerald-500 text-white',
            tone === 'destructive' && 'border-transparent bg-destructive text-white',
            tone === 'neutral' &&
              (active
                ? 'border-transparent bg-foreground text-background'
                : 'border-border/60 bg-muted/60 text-muted-foreground'),
            active && 'qc-sync-pop',
          )}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 w-full space-y-0.5">
          <div className="truncate text-[13px] font-semibold" title={machine?.name ?? fallback}>
            {machine?.name ?? fallback}
          </div>
          {/* The IP is what separates two laptops that are both called "MacBook-Pro". */}
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {machine?.ip || (machine ? machine.platform : '—')}
          </div>
        </div>
      </div>
      <div className="mt-1.5 text-center text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {role}
      </div>
    </div>
  )
}

export default function SyncStage({
  from,
  to,
  state,
  percent = 0,
  caption,
  detail,
  fromFallback = 'Waiting…',
  toFallback = 'This machine',
}: SyncStageProps) {
  const moving = state === 'transferring'
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const tone =
    state === 'done' ? 'emerald' : state === 'error' ? 'destructive' : state === 'idle' ? 'neutral' : 'sky'

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2">
        <MachineTile
          machine={from}
          fallback={fromFallback}
          role="From"
          active={Boolean(from)}
          tone={from ? (tone === 'neutral' ? 'neutral' : tone) : 'neutral'}
          halo={state === 'waiting' && !from}
        />

        {/* ---- the link. Fixed width: the packet path is in px (see index.css). */}
        <div className="relative shrink-0 pt-1" style={{ width: LINK_W }}>
          {/* percent pill, floating above the wire */}
          <div className="flex h-5 items-center justify-center">
            <span
              className={cn(
                'rounded-full border border-border/60 bg-card px-2 py-0.5 text-[10px] font-semibold tabular-nums transition-colors',
                ACCENT[state],
              )}
            >
              {state === 'done'
                ? 'Complete'
                : state === 'error'
                  ? 'Stopped'
                  : state === 'waiting'
                    ? 'Listening'
                    : state === 'idle'
                      ? 'Idle'
                      : state === 'connected' && clamped === 0
                        ? 'Linked'
                        : `${clamped}%`}
            </span>
          </div>

          <svg
            width={LINK_W}
            height={56}
            viewBox={`0 0 ${LINK_W} 56`}
            fill="none"
            aria-hidden
            className="block"
          >
            {/* the track */}
            <path
              d={`M 0 28 C 60 28, 90 28, ${LINK_W} 28`}
              className="stroke-border/70"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray="3 6"
            />
            {/* the filled portion — how far the transfer has got, drawn as a real length */}
            <path
              d={`M 0 28 C 60 28, 90 28, ${LINK_W} 28`}
              className={cn(STROKE[state], 'transition-[stroke-dashoffset] duration-500 ease-out')}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={LINK_W}
              strokeDashoffset={
                state === 'done' ? 0 : state === 'idle' || state === 'waiting' ? LINK_W : LINK_W * (1 - clamped / 100)
              }
            />
            {/* the marching overlay — only while bytes are actually moving */}
            {moving && (
              <path
                d={`M 0 28 C 60 28, 90 28, ${LINK_W} 28`}
                className={cn(STROKE[state], 'qc-sync-dash opacity-70')}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeDasharray="6 18"
              />
            )}
          </svg>

          {/* packets. Three, staggered, so the wire reads as throughput not as one dot. */}
          {moving && (
            <div className="pointer-events-none absolute inset-x-0 top-5 h-14">
              {[0, 0.6, 1.2].map((delay) => (
                <span
                  key={delay}
                  className="qc-sync-packet absolute left-0 top-0 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-500 shadow-[0_0_8px_2px] shadow-sky-500/40"
                  style={{ animationDelay: `${delay}s` }}
                />
              ))}
            </div>
          )}

          {/* terminal states get a mark ON the wire, so the outcome is where the eye is */}
          {(state === 'done' || state === 'error') && (
            <span
              className={cn(
                'qc-sync-pop absolute left-1/2 top-[calc(1.25rem+28px)] flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-white',
                state === 'done' ? 'bg-emerald-500' : 'bg-destructive',
              )}
            >
              {state === 'done' ? <Check className="size-3.5" /> : <TriangleAlert className="size-3.5" />}
            </span>
          )}
        </div>

        <MachineTile
          machine={to}
          fallback={toFallback}
          role="To"
          active={Boolean(to) && state !== 'idle'}
          tone={state === 'done' ? 'emerald' : state === 'error' ? 'destructive' : 'neutral'}
          halo={state === 'waiting' && !to}
        />
      </div>

      {(caption || detail) && (
        <div className="space-y-0.5 text-center">
          {caption && <p className={cn('text-[13px] font-medium', ACCENT[state])}>{caption}</p>}
          {detail && (
            <p className="truncate font-mono text-[11px] text-muted-foreground" title={detail}>
              {detail}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
