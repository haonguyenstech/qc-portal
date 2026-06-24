import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
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

function LogPanel({ events }: { events: LogEvent[] }) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [events.length])

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2 rounded-full bg-red-500/80" />
          <span className="size-2 rounded-full bg-amber-500/80" />
          <span className="size-2 rounded-full bg-emerald-500/80" />
        </span>
        <span className="ml-1 font-mono text-[10px] tracking-wide text-zinc-500">live output</span>
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
  const { events, phase } = useRunStream(run.id)
  const [showLogs, setShowLogs] = useState(true)
  const isPaused = run.status === 'paused'
  const liveIdx = phase ? PHASES.findIndex((p) => p.key === phase) : -1

  // Phase is *guessed* from log text, so it can jump around (and even point at a
  // later phase by mistake). Keep progress monotonic — only ever move forward —
  // so the bar never snaps backwards.
  const [maxIdx, setMaxIdx] = useState(-1)
  useEffect(() => {
    setMaxIdx((m) => (liveIdx > m ? liveIdx : m))
  }, [liveIdx])

  const idx = Math.max(maxIdx, liveIdx)
  // Reserve 100% for a finished run — these are all still in progress, so cap
  // the in-flight bar below 100 even when the last phase is detected.
  const pct = idx >= 0 ? Math.min(Math.round(((idx + 1) / PHASES.length) * 100), 92) : 6
  const phaseLabel = isPaused
    ? `Paused${idx >= 0 ? ` at ${PHASES[idx].label}` : ''}`
    : idx >= 0
      ? PHASES[idx].label
      : run.status === 'queued'
        ? 'Queued'
        : 'Starting'

  return (
    <Card className="overflow-hidden border-border/60 shadow-sm transition-shadow hover:shadow-md">
      <CardContent className="space-y-4 p-5">
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
          <span className="truncate font-mono text-xs text-muted-foreground">{hostOf(run.appUrl)}</span>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            started {relativeTime(run.createdAt)}
          </span>
        </div>

        {/* live phase progress */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              {isPaused ? (
                <Pause className="size-3.5 text-amber-500" />
              ) : (
                <Loader2 className="size-3.5 animate-spin text-sky-500" />
              )}
              {phaseLabel}
            </span>
            <span className="tabular-nums text-muted-foreground">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-500',
                isPaused
                  ? 'bg-amber-400'
                  : 'bg-gradient-to-r from-sky-500 to-primary',
              )}
              style={{ width: `${pct}%` }}
            />
          </div>
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
          {showLogs && <LogPanel events={events} />}
        </div>

        <div className="flex items-center justify-end gap-2">
          {isPaused ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCancel(run.id)}
                disabled={busy}
                className="text-muted-foreground hover:text-destructive"
              >
                <Square className="size-3.5" />
                Discard
              </Button>
              <Button size="sm" onClick={() => onResume(run.id)} disabled={busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                Resume
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => onPause(run.id)} disabled={busy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Pause className="size-3.5" />}
              Stop
            </Button>
          )}
          <Button asChild size="sm" variant={isPaused ? 'outline' : 'default'}>
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
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
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
            {active.length - liveCount > 0 && (
              <Badge variant="secondary" className="gap-1 font-normal text-amber-700">
                <Pause className="size-3" />
                {active.length - liveCount} paused
              </Badge>
            )}
          </h1>
          <p className="text-sm text-muted-foreground">
            QC runs currently in progress. Live progress updates automatically.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/">
            <RadioTower className="size-4" />
            Start a run
          </Link>
        </Button>
      </header>

      {!activeProject ? (
        <Card className="border-amber-200 bg-amber-50/50">
          <CardContent className="flex items-center gap-2 p-5 text-sm font-medium text-amber-700">
            <TriangleAlert className="size-4" />
            Select a project in the sidebar to see its running tests.
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="space-y-4">
          {[0, 1].map((i) => (
            <Card key={i} className="border-border/60">
              <CardContent className="space-y-4 p-5">
                <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                <div className="h-1.5 w-full animate-pulse rounded-full bg-muted" />
                <div className="h-8 w-full animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : active.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <RadioTower className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">No tests running</p>
              <p className="text-sm text-muted-foreground">
                Start a QC run and it will appear here while it works.
              </p>
            </div>
            <Button asChild size="sm" className="mt-1">
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
