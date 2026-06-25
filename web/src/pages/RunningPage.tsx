import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  ChevronDown,
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
import { cancelRun, listRuns, pauseRun, resumeRun } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { useRunStream } from '@/lib/useRunStream'
import { StatusBadge } from '@/lib/status'
import { relativeTime } from '@/lib/format'
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
 * Horizontal 7-phase timeline. `activeIdx` is the furthest phase reached (monotonic),
 * so completed phases stay filled and the marker never snaps backward even when the
 * phase guess from the log text wobbles.
 */
function PhaseStepper({ activeIdx, paused }: { activeIdx: number; paused: boolean }) {
  return (
    <ol className="flex items-start">
      {PHASES.map((p, i) => {
        const done = i < activeIdx
        const active = i === activeIdx
        const last = i === PHASES.length - 1
        // A connector segment is "filled" once the phase it leads INTO is reached.
        const leftFilled = i <= activeIdx
        const rightFilled = i < activeIdx
        return (
          <li
            key={p.key}
            className={cn('flex min-w-0 flex-col items-center gap-1.5', last ? 'flex-none' : 'flex-1')}
          >
            <div className="relative flex h-6 w-full items-center justify-center">
              {i > 0 && (
                <span
                  className={cn(
                    'absolute left-0 right-1/2 top-1/2 h-0.5 -translate-y-1/2 transition-colors',
                    leftFilled ? 'bg-foreground' : 'bg-border',
                  )}
                  aria-hidden
                />
              )}
              {!last && (
                <span
                  className={cn(
                    'absolute left-1/2 right-0 top-1/2 h-0.5 -translate-y-1/2 transition-colors',
                    rightFilled ? 'bg-foreground' : 'bg-border',
                  )}
                  aria-hidden
                />
              )}
              <span
                className={cn(
                  'relative z-10 flex size-6 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums transition-colors',
                  done
                    ? 'bg-foreground text-background'
                    : active
                      ? paused
                        ? 'bg-amber-500 text-white ring-4 ring-amber-500/15'
                        : 'bg-sky-500 text-white ring-4 ring-sky-500/15'
                      : 'border border-border bg-background text-muted-foreground',
                )}
              >
                {done ? (
                  <Check className="size-3" />
                ) : active && !paused ? (
                  <span className="size-2 animate-pulse rounded-full bg-white" aria-hidden />
                ) : (
                  i + 1
                )}
              </span>
            </div>
            <span
              className={cn(
                'max-w-full truncate text-center text-[10px] font-medium leading-none',
                done || active ? 'text-foreground' : 'text-muted-foreground/60',
              )}
            >
              {p.label}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

function LogPanel({ events, connected }: { events: LogEvent[]; connected: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
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
      <ScrollArea className="h-64 p-3">
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
          <div ref={bottomRef} />
        </div>
      </ScrollArea>
    </div>
  )
}

function RunningRow({
  run,
  onPause,
  onResume,
  onCancel,
  busy,
}: {
  run: RunSummary
  onPause: (id: string) => void
  onResume: (id: string) => void
  onCancel: (id: string) => void
  busy: boolean
}) {
  const { events, phase, connected } = useRunStream(run.id)
  const [showLogs, setShowLogs] = useState(true)
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
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm">
      <CardContent className="space-y-5 p-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {isPaused ? (
            <span className="size-2.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
          ) : (
            <span className="relative flex size-2.5 shrink-0" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/70" />
              <span className="relative inline-flex size-2.5 rounded-full bg-sky-500" />
            </span>
          )}
          <Link to={`/run/${run.id}`} className="font-mono text-sm font-semibold hover:underline">
            {run.ticketId}
          </Link>
          <StatusBadge status={run.status} />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {hostOf(run.appUrl)}
          </span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            started {relativeTime(run.createdAt)}
          </span>
        </div>

        {/* live phase timeline */}
        <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/40 px-4 py-3.5">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              {isPaused ? (
                <Pause className="size-3.5 text-amber-500" />
              ) : (
                <Loader2 className="size-3.5 animate-spin text-sky-500" />
              )}
              {phaseLabel}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {step > 0 ? `Step ${step} of ${PHASES.length}` : `${PHASES.length} phases`}
            </span>
          </div>
          <PhaseStepper activeIdx={idx} paused={isPaused} />
        </div>

        {/* live logs */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowLogs((s) => !s)}
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-3.5 transition-transform', showLogs ? '' : '-rotate-90')}
            />
            {showLogs ? 'Hide' : 'Show'} live logs
            {events.length > 0 && (
              <span className="tabular-nums text-muted-foreground/70">({events.length})</span>
            )}
          </button>
          {showLogs && <LogPanel events={events} connected={connected} />}
        </div>

        <div className="flex items-center justify-end gap-2">
          {isPaused ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCancel(run.id)}
                disabled={busy}
                className="rounded-full text-muted-foreground hover:text-destructive"
              >
                <Square className="size-3.5" />
                Discard
              </Button>
              <Button
                size="sm"
                onClick={() => onResume(run.id)}
                disabled={busy}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Resume
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPause(run.id)}
              disabled={busy}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
              Stop
            </Button>
          )}
          <Button
            asChild
            size="sm"
            variant={isPaused ? 'outline' : 'default'}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            <Link to={`/run/${run.id}`}>
              Open
              <ArrowRight className="size-3.5" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
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

  const [busyId, setBusyId] = useState<string | null>(null)

  // In-progress runs include paused ones so they stay visible (with a Resume).
  const active = (runs ?? []).filter(
    (r) => r.status === 'running' || r.status === 'queued' || r.status === 'paused',
  )
  const liveCount = active.filter((r) => r.status !== 'paused').length
  const pausedCount = active.length - liveCount

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
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <RadioTower className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="flex items-center gap-2 text-3xl font-semibold tracking-tight">
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
            </h1>
            <p className="text-sm text-muted-foreground">
              QC runs currently in progress. Live progress updates automatically.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link to="/">
            <RadioTower className="size-4" />
            Start a run
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
              <Link to="/">
                Start a run
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {active.map((run) => (
            <RunningRow
              key={run.id}
              run={run}
              onPause={onPause}
              onResume={onResume}
              onCancel={onCancel}
              busy={busyId === run.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}
