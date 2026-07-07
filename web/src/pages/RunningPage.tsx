import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  ChevronDown,
  Clock,
  Loader2,
  Pause,
  Play,
  RadioTower,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { cancelRun, listCrawledTickets, listRuns, pauseRun, resumeRun } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { useRunStream } from '@/lib/useRunStream'
import { StatusBadge } from '@/lib/status'
import { formatDuration, relativeTime } from '@/lib/format'
import type { LogEvent, Phase, RunSummary } from '@/lib/types'

const PHASES: { key: Phase; label: string }[] = [
  { key: 'intake', label: 'Intake' },
  { key: 'plan', label: 'Plan' },
  { key: 'setup', label: 'Setup' },
  { key: 'collect', label: 'Collect' },
  { key: 'analyze', label: 'Analyze' },
  { key: 'aggregate', label: 'Aggregate' },
  { key: 'report', label: 'Report' },
]

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function logLineClass(kind: LogEvent['kind']): string {
  switch (kind) {
    case 'error':
      return 'text-red-400'
    case 'tool':
      return 'text-sky-400'
    case 'tool_result':
      return 'text-emerald-400'
    case 'phase':
      return 'text-violet-400 font-semibold'
    case 'system':
      return 'text-amber-400'
    case 'done':
      return 'text-emerald-300 font-semibold'
    default:
      return 'text-zinc-200'
  }
}

/**
 * Compact segmented progress bar. One thin segment per phase: filled for phases
 * already reached, the active one shimmering, the rest empty. `activeIdx` is the
 * furthest phase reached (monotonic) so it never snaps backward when the phase
 * guess from the log text wobbles. Reads far cleaner than 7 cramped numbered dots.
 */
function PhaseProgress({
  activeIdx,
  paused,
  starting,
}: {
  activeIdx: number
  paused: boolean
  /** No phase reached yet — light up segment 1 as "preparing" so the bar shows motion. */
  starting?: boolean
}) {
  return (
    <div className="flex items-center gap-1" aria-hidden>
      {PHASES.map((p, i) => {
        const done = i < activeIdx
        const active = i === activeIdx
        const preparing = starting && i === 0
        return (
          <span
            key={p.key}
            className={cn(
              'h-1.5 flex-1 overflow-hidden rounded-full transition-colors duration-300',
              done
                ? 'bg-foreground'
                : active
                  ? paused
                    ? 'bg-amber-500'
                    : 'bg-sky-500'
                  : preparing
                    ? 'bg-sky-500/25'
                    : 'bg-border',
            )}
          >
            {((active && !paused) || preparing) && (
              <span className="block h-full w-full animate-pulse bg-sky-400/60" />
            )}
          </span>
        )
      })}
    </div>
  )
}

/**
 * Live count-up of how long a run has been going, ticking every second while
 * `active`. When not active (paused) the interval stops so the value freezes.
 */
function ElapsedTime({ since, active }: { since: string; active: boolean }) {
  const start = useMemo(() => new Date(since).getTime(), [since])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  if (Number.isNaN(start)) return null
  return (
    <span className="flex items-center gap-1 tabular-nums">
      <Clock className="size-3" />
      {formatDuration(now - start)}
    </span>
  )
}

function LogPanel({ events, connected }: { events: LogEvent[]; connected: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // Auto-scroll ONLY the log's own viewport — never scrollIntoView, which also
  // scrolls the page/window and made the whole page jump on every new event.
  // And only when the user is already pinned to the bottom, so scrolling up to
  // read doesn't fight the incoming stream.
  useEffect(() => {
    const viewport = scrollRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]',
    )
    if (!viewport) return
    const nearBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 48
    if (nearBottom) viewport.scrollTop = viewport.scrollHeight
  }, [events.length])

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2 rounded-full bg-red-500/80" />
          <span className="size-2 rounded-full bg-amber-500/80" />
          <span className="size-2 rounded-full bg-emerald-500/80" />
        </span>
        <span className="ml-1 font-mono text-[10px] tracking-wide text-zinc-500">live output</span>
        <span
          className={cn(
            'flex items-center gap-1 font-mono text-[10px]',
            connected ? 'text-emerald-400' : 'text-zinc-500',
          )}
        >
          <span
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'animate-pulse bg-emerald-400' : 'bg-zinc-600',
            )}
          />
          {connected ? 'connected' : 'connecting…'}
        </span>
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {events.length} {events.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      <ScrollArea className="h-48 p-3" ref={scrollRef}>
        <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
          {events.length === 0 && (
            <div className="flex items-center gap-2 text-zinc-500">
              <span className="inline-block size-1.5 animate-pulse rounded-full bg-zinc-500" />
              Waiting for output…
            </div>
          )}
          {events.map((e, i) => (
            <div key={i} className={logLineClass(e.kind)}>
              <span className="mr-2 select-none text-zinc-600">
                {new Date(e.ts).toLocaleTimeString()}
              </span>
              {e.tool && <span className="mr-1 text-zinc-400">[{e.tool}]</span>}
              <span className="whitespace-pre-wrap break-words">{e.text}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function RunningRow({
  run,
  title,
  onPause,
  onResume,
  onCancel,
  busy,
}: {
  run: RunSummary
  title: string | null
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  busy: boolean
}) {
  const { events, phase, connected } = useRunStream(run.id)
  // Collapsed by default so a card stays small — expand to watch the stream.
  const [showLogs, setShowLogs] = useState(false)
  const isPaused = run.status === 'paused'

  // Phase is *guessed* from log text and can wobble (even point at a later phase
  // then an earlier one). Derive the FURTHEST phase reached across all events — a
  // pure, naturally-monotonic value — so the timeline only ever moves forward.
  const reachedIdx = useMemo(() => {
    let m = -1
    for (const e of events) {
      if (!e.phase) continue
      const i = PHASES.findIndex((p) => p.key === e.phase)
      if (i > m) m = i
    }
    return m
  }, [events])

  // Fall back to the latest detected phase for the very first events (before the
  // memo has anything), then clamp to the monotonic max.
  const liveIdx = phase ? PHASES.findIndex((p) => p.key === phase) : -1
  const idx = Math.max(reachedIdx, liveIdx)
  const step = idx >= 0 ? idx + 1 : 0
  const phaseLabel = isPaused
    ? `Paused${idx >= 0 ? ` at ${PHASES[idx].label}` : ''}`
    : idx >= 0
      ? PHASES[idx].label
      : run.status === 'queued'
        ? 'Queued'
        : 'Starting'

  return (
    <Card className="overflow-hidden rounded-2xl border-border/60 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm">
      <CardContent className="space-y-2 p-3.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {isPaused ? (
            <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
          ) : (
            <span className="relative flex size-2 shrink-0" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/70" />
              <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
            </span>
          )}
          <Link
            to={`/run/${run.id}`}
            className="flex min-w-0 items-baseline gap-1.5 hover:underline"
          >
            <span className="font-mono text-sm font-semibold">{run.ticketId}</span>
            {title && (
              <span className="truncate text-sm font-medium text-foreground">{title}</span>
            )}
          </Link>
          <StatusBadge status={run.status} compact />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {hostOf(run.appUrl)}
          </span>
          <span className="ml-auto flex items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
            <ElapsedTime since={run.createdAt} active={!isPaused && run.status !== 'queued'} />
          </span>
          <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-tight text-foreground">
            {isPaused ? (
              <Pause className="size-3 text-amber-500" />
            ) : (
              <Loader2 className="size-3 animate-spin text-sky-500" />
            )}
            {phaseLabel}
            {step > 0 && (
              <span className="tabular-nums font-normal text-muted-foreground">
                · {step}/{PHASES.length}
              </span>
            )}
          </span>
        </div>

        {/* thin phase bar directly under the header — no framing box */}
        <PhaseProgress
          activeIdx={idx}
          paused={isPaused}
          starting={idx < 0 && !isPaused && run.status !== 'queued'}
        />

        {/* logs toggle + actions on one row to keep the card small */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowLogs((s) => !s)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', showLogs ? '' : '-rotate-90')}
            />
            {showLogs ? 'Hide' : 'Show'} logs
            {events.length > 0 && (
              <span className="tabular-nums text-muted-foreground/70">({events.length})</span>
            )}
          </button>
          <div className="ml-auto flex items-center gap-2">
            {isPaused ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onCancel(run.id)}
                  disabled={busy}
                  className="h-8 rounded-full text-muted-foreground hover:text-destructive"
                >
                  <Square className="size-3.5" />
                  Discard
                </Button>
                <Button
                  size="sm"
                  onClick={() => onResume(run.id)}
                  disabled={busy}
                  className="h-8 rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Play className="size-3.5" />
                  )}
                  Resume
                </Button>
              </>
            ) : run.status === 'queued' ? (
              // Queued runs haven't spawned anything yet — they can only be
              // canceled (removed from the queue), not paused.
              <Button
                variant="outline"
                size="sm"
                onClick={() => onCancel(run.id)}
                disabled={busy}
                className="h-8 rounded-full text-muted-foreground transition-all duration-200 hover:text-destructive active:scale-[0.98]"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Square className="size-3.5" />
                )}
                Cancel
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onPause(run.id)}
                disabled={busy}
                className="h-8 rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Pause className="size-3.5" />
                )}
                Stop
              </Button>
            )}
            <Button
              asChild
              size="sm"
              variant={isPaused ? 'outline' : 'default'}
              className="h-8 rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Link to={`/run/${run.id}`}>
                Open
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </div>
        </div>

        {showLogs && <LogPanel events={events} connected={connected} />}
      </CardContent>
    </Card>
  )
}

/**
 * Compact row for a run waiting in the queue. Queued runs haven't spawned
 * anything yet — no phases, no logs — so a slim row with its position and a
 * Cancel button is all that's useful.
 */
function QueuedRow({
  run,
  title,
  position,
  onCancel,
  busy,
}: {
  run: RunSummary
  title: string | null
  position: number
  onCancel: (id: string) => void
  busy: boolean
}) {
  return (
    <li className="flex items-center gap-2.5 px-3.5 py-2 transition-colors hover:bg-muted/50">
      <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold tabular-nums text-muted-foreground">
        {position}
      </span>
      <Link
        to={`/run/${run.id}`}
        className="flex min-w-0 items-baseline gap-1.5 hover:underline"
      >
        <span className="shrink-0 font-mono text-sm font-semibold">{run.ticketId}</span>
        {title && (
          <span className="truncate text-sm font-medium text-foreground">{title}</span>
        )}
      </Link>
      <StatusBadge status={run.status} compact />
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
        {hostOf(run.appUrl)}
      </span>
      <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
        queued {relativeTime(run.createdAt)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onCancel(run.id)}
        disabled={busy}
        className="h-7 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Square className="size-3.5" />}
        Cancel
      </Button>
    </li>
  )
}

export default function RunningPage() {
  const { activeProject } = useProjects()
  const queryClient = useQueryClient()

  const { data: runs, isLoading } = useQuery({
    queryKey: ['runs', activeProject?.id],
    queryFn: () => listRuns(activeProject!.id),
    enabled: !!activeProject,
    refetchInterval: 4000, // these are live — keep the list fresh
  })

  // Runs only carry the ticket id; join against crawled tickets for a title.
  const { data: crawledTickets } = useQuery({
    queryKey: ['crawled', activeProject?.id],
    queryFn: () => listCrawledTickets(activeProject!.id),
    enabled: !!activeProject,
  })
  const titleFor = (ticketId: string): string | null => {
    const t = (crawledTickets ?? []).find(
      (x) => (x.displayId ?? x.name) === ticketId,
    )
    return t?.title ?? null
  }

  const [busyId, setBusyId] = useState<string | null>(null)

  // In-progress runs include paused ones so they stay visible (with a Resume).
  const active = (runs ?? []).filter(
    (r) => r.status === 'running' || r.status === 'queued' || r.status === 'paused',
  )
  // Live (running/paused) cards render on top; queued runs wait in a compact
  // list below, in start order (oldest first — the order they'll execute).
  const live = active.filter((r) => r.status !== 'queued')
  const queued = active
    .filter((r) => r.status === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const liveCount = live.filter((r) => r.status !== 'paused').length
  const pausedCount = live.length - liveCount

  async function onPause(id: string) {
    setBusyId(id)
    try {
      await pauseRun(id)
      toast.success('Run stopped', { description: 'Resume any time to continue where it left off.' })
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    } catch (err) {
      toast.error('Failed to stop', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function onResume(id: string) {
    setBusyId(id)
    try {
      await resumeRun(id)
      toast.success('Run resumed')
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    } catch (err) {
      toast.error('Failed to resume', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusyId(null)
    }
  }

  async function onCancel(id: string) {
    setBusyId(id)
    try {
      await cancelRun(id)
      toast.success('Run canceled')
      queryClient.invalidateQueries({ queryKey: ['runs'] })
    } catch (err) {
      toast.error('Failed to cancel', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
            <RadioTower className="size-4" />
          </span>
          <div className="space-y-0.5">
            <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              Running tests
              {liveCount > 0 && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/70" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-sky-500" />
                  </span>
                  {liveCount} live
                </Badge>
              )}
              {pausedCount > 0 && (
                <Badge variant="secondary" className="gap-1 font-normal text-amber-700">
                  <Pause className="size-3" />
                  {pausedCount} paused
                </Badge>
              )}
              {queued.length > 0 && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <Clock className="size-3" />
                  {queued.length} queued
                </Badge>
              )}
            </h1>
            <p className="text-sm text-muted-foreground">
              QC runs currently in progress. Live progress updates automatically.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link to="/qc-run">
            <RadioTower className="size-4" />
            New Run
          </Link>
        </Button>
      </header>

      {!activeProject ? (
        <Card className="rounded-3xl border-amber-200 bg-amber-50/50 shadow-none">
          <CardContent className="flex items-center gap-2 p-5 text-sm font-medium text-amber-700">
            <TriangleAlert className="size-4" />
            Select a project in the sidebar to see its running tests.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="rounded-3xl border-border/60 shadow-none">
              <CardContent className="space-y-5 p-5">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="h-16 w-full animate-pulse rounded-2xl bg-muted" />
                <div className="h-8 w-full animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : active.length === 0 ? (
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-foreground text-background">
              <RadioTower className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">No tests running</p>
              <p className="text-sm text-muted-foreground">
                Start a QC run and it will appear here while it works.
              </p>
            </div>
            <Button asChild size="sm" className="mt-1 rounded-full">
              <Link to="/qc-run">
                New Run
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* live runs — full cards with phase timeline + logs */}
          {live.length > 0 && (
            <div className="space-y-2.5">
              {live.map((run) => (
                <RunningRow
                  key={run.id}
                  run={run}
                  title={titleFor(run.ticketId)}
                  onPause={onPause}
                  onResume={onResume}
                  onCancel={onCancel}
                  busy={busyId === run.id}
                />
              ))}
            </div>
          )}

          {/* up next — the waiting queue, in execution order */}
          {queued.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center gap-2 px-1">
                <Clock className="size-4 text-muted-foreground" />
                <h2 className="text-sm font-semibold tracking-tight">Up next</h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {queued.length}
                </span>
                <span className="text-xs text-muted-foreground">
                  · runs one at a time, in this order
                  {live.length > 0 ? ' — starts when the current run finishes' : ''}
                </span>
              </div>
              <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
                <CardContent className="p-0">
                  <ul className="divide-y divide-border/60">
                    {queued.map((run, i) => (
                      <QueuedRow
                        key={run.id}
                        run={run}
                        title={titleFor(run.ticketId)}
                        position={i + 1}
                        onCancel={onCancel}
                        busy={busyId === run.id}
                      />
                    ))}
                  </ul>
                </CardContent>
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  )
}
