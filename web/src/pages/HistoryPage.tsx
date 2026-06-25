import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  History as HistoryIcon,
  Inbox,
  Layers,
  Link2,
  Search,
  Sparkles,
  XCircle,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { listRuns } from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import { useProjects } from '@/lib/project-context'
import { cn } from '@/lib/utils'
import type { RunStatus, RunSummary } from '@/lib/types'

type Filter = 'all' | 'passed' | 'failed' | 'active'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function relativeTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const diff = Date.now() - d.getTime()
  const sec = Math.round(diff / 1000)
  if (sec < 45) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d ago`
  const wk = Math.round(day / 7)
  if (wk < 5) return `${wk}w ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Wall-clock run duration, e.g. "2m 13s". Null while still running / unknown. */
function formatDuration(start: string, end: string | null): string | null {
  if (!end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm ? `${h}h ${rm}m` : `${h}h`
}

function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url
  }
}

function averageDuration(runs: RunSummary[]): string | null {
  const values = runs
    .map((r) => {
      if (!r.finishedAt) return null
      const ms = new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()
      return Number.isFinite(ms) && ms >= 0 ? ms : null
    })
    .filter((ms): ms is number => ms !== null)

  if (values.length === 0) return null
  const avg = values.reduce((sum, ms) => sum + ms, 0) / values.length
  const s = Math.round(avg / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

const ACTIVE_STATUSES: RunStatus[] = ['running', 'queued', 'paused']
const FAILED_STATUSES: RunStatus[] = ['failed', 'error']

function matchesFilter(run: RunSummary, filter: Filter): boolean {
  switch (filter) {
    case 'passed':
      return run.status === 'passed'
    case 'failed':
      return FAILED_STATUSES.includes(run.status)
    case 'active':
      return ACTIVE_STATUSES.includes(run.status)
    default:
      return true
  }
}

/** A small read-only metric pill for the overview band (avg duration, latest, total). */
function MetricChip({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Clock3
  label: string
  value: string | number
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 text-xs">
      <Icon className="size-3.5 text-muted-foreground" />
      <span className="font-semibold tabular-nums text-foreground">{value}</span>
      <span className="text-muted-foreground">{label}</span>
    </span>
  )
}

interface FilterMeta {
  value: Filter
  label: string
  count: number
  /** Tailwind bg- for the legend dot + distribution segment. */
  dot: string
  /** ring + tint applied when this filter is active. */
  ring: string
}

/** A clickable stat that doubles as a status filter AND the distribution legend. */
function FilterChip({ meta, active, onClick }: { meta: FilterMeta; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-2.5 rounded-2xl border border-border/60 bg-muted/50 px-3.5 py-2.5 text-left shadow-none transition-all duration-200',
        'hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.98]',
        active ? `border-transparent ring-2 ${meta.ring}` : 'ring-0',
      )}
    >
      <span className={cn('size-2.5 shrink-0 rounded-full', meta.dot)} aria-hidden />
      <span className="min-w-0">
        <span className="block text-lg font-semibold leading-none tabular-nums tracking-tight">
          {meta.count}
        </span>
        <span className="mt-1 block text-[11px] font-medium text-muted-foreground">{meta.label}</span>
      </span>
    </button>
  )
}

/** Pass/fail breakdown with a thin bar of AC coverage when totals are known. */
function ResultCell({ run }: { run: RunSummary }) {
  const { passCount, failCount, totalAcs } = run
  const known = totalAcs > 0
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-emerald-700">
        <CheckCircle2 className="size-3.5" />
        {passCount}
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-red-600">
        <XCircle className="size-3.5" />
        {failCount}
      </span>
      {known ? (
        <span
          className="flex h-1.5 w-16 overflow-hidden rounded-full bg-muted"
          title={`${passCount} passed · ${failCount} failed · ${totalAcs} ACs`}
        >
          <span
            className="h-full bg-emerald-500"
            style={{ width: `${(passCount / totalAcs) * 100}%` }}
          />
          <span
            className="h-full bg-red-500"
            style={{ width: `${(failCount / totalAcs) * 100}%` }}
          />
        </span>
      ) : (
        <span className="w-16 text-right text-[11px] text-muted-foreground/60">—</span>
      )}
    </div>
  )
}

function HistoryRow({ run }: { run: RunSummary }) {
  const to = `/run/${run.id}`
  const duration = formatDuration(run.createdAt, run.finishedAt)
  const hasResults = run.totalAcs > 0
  return (
    <TableRow className="group border-b transition-colors hover:bg-muted/35">
      <TableCell className="py-4 pl-4">
        <Link to={to} className="block min-w-0">
          <span className="block font-mono text-[13px] font-medium text-foreground transition-colors group-hover:text-primary">
            {run.ticketId.length > 28 ? `${run.ticketId.slice(0, 28)}…` : run.ticketId}
          </span>
          <span className="mt-1 block truncate text-[11px] text-muted-foreground">
            {run.projectName ?? '—'}
          </span>
        </Link>
      </TableCell>
      <TableCell className="py-4">
        <Link to={to} className="block">
          <StatusBadge status={run.status} />
        </Link>
      </TableCell>
      <TableCell className="py-4 text-right">
        <Link to={to} className="block">
          <ResultCell run={run} />
          {hasResults && (
            <span className="mt-1 block text-right text-[11px] text-muted-foreground">
              {run.totalAcs} ACs
            </span>
          )}
        </Link>
      </TableCell>
      <TableCell className="hidden max-w-[16rem] py-4 md:table-cell">
        <Link
          to={to}
          className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground"
          title={run.appUrl}
        >
          <Link2 className="size-3 shrink-0 opacity-60" />
          <span className="truncate">{hostOf(run.appUrl)}</span>
        </Link>
      </TableCell>
      <TableCell className="hidden py-4 lg:table-cell">
        <Link to={to} className="block font-mono text-xs text-muted-foreground">
          {duration ?? '—'}
        </Link>
      </TableCell>
      <TableCell className="py-4">
        <Link
          to={to}
          className="block whitespace-nowrap font-mono text-xs text-muted-foreground"
          title={formatDate(run.createdAt)}
        >
          {relativeTime(run.createdAt)}
        </Link>
      </TableCell>
      <TableCell className="w-12 py-4 pr-4">
        <Link
          to={to}
          aria-label={`Open report for ${run.ticketId}`}
          className="ml-auto flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-all group-hover:bg-background group-hover:text-foreground active:scale-[0.95]"
        >
          <ArrowUpRight className="size-4" />
        </Link>
      </TableCell>
    </TableRow>
  )
}

function LoadingSkeleton() {
  return (
    <div className="divide-y">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-1 py-3.5">
          <div className="h-8 w-32 animate-pulse rounded bg-muted" />
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-muted" />
          <div className="hidden h-4 w-40 animate-pulse rounded bg-muted md:block" />
          <div className="h-4 w-12 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}

export default function HistoryPage() {
  const { activeProjectId } = useProjects()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['runs', activeProjectId],
    queryFn: () => listRuns(activeProjectId ?? undefined),
  })

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const runs = data ?? []
  const hasRuns = runs.length > 0

  const passed = runs.filter((r) => r.status === 'passed').length
  const failed = runs.filter((r) => FAILED_STATUSES.includes(r.status)).length
  const active = runs.filter((r) => ACTIVE_STATUSES.includes(r.status)).length
  const decided = passed + failed
  const passRate = decided > 0 ? Math.round((passed / decided) * 100) : null
  const latestRun = runs[0]
  const avgDuration = averageDuration(runs)

  // Distribution segments (out of total runs) for the overview bar.
  const total = runs.length || 1
  const segments = [
    { key: 'passed', pct: (passed / total) * 100, cls: 'bg-emerald-500' },
    { key: 'failed', pct: (failed / total) * 100, cls: 'bg-red-500' },
    { key: 'active', pct: (active / total) * 100, cls: 'bg-sky-500' },
  ]

  const filters: FilterMeta[] = [
    {
      value: 'all',
      label: 'Total runs',
      count: runs.length,
      dot: 'bg-foreground',
      ring: 'ring-primary/40 bg-primary/5',
    },
    {
      value: 'passed',
      label: 'Passed',
      count: passed,
      dot: 'bg-emerald-500',
      ring: 'ring-emerald-500/40 bg-emerald-50/50',
    },
    {
      value: 'failed',
      label: 'Failed',
      count: failed,
      dot: 'bg-red-500',
      ring: 'ring-red-500/40 bg-red-50/50',
    },
    {
      value: 'active',
      label: 'Active',
      count: active,
      dot: 'bg-sky-500',
      ring: 'ring-sky-500/40 bg-sky-50/50',
    },
  ]

  const q = query.trim().toLowerCase()
  const visible = runs.filter(
    (r) =>
      matchesFilter(r, filter) &&
      (!q ||
        r.ticketId.toLowerCase().includes(q) ||
        r.appUrl.toLowerCase().includes(q) ||
        (r.projectName ?? '').toLowerCase().includes(q)),
  )

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <HistoryIcon className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight">Run History</h1>
              {active > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">
                  <span className="relative flex size-1.5">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
                    <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                  </span>
                  {active} live
                </span>
              )}
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Browse previous QC executions, compare pass/fail outcomes, and open the full evidence
              report for any ticket.
            </p>
          </div>
        </div>

        <Button asChild size="sm" className="w-fit rounded-full transition-all duration-200 active:scale-[0.98]">
          <Link to="/">
            <Sparkles className="size-4" />
            New run
          </Link>
        </Button>
      </header>

      {!isLoading && !isError && hasRuns && (
        <>
          {/* Results overview — pass rate + distribution + filters, all in one band. */}
          <section className="space-y-4 rounded-3xl border border-border/60 bg-card p-5 shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="flex items-baseline gap-2.5">
                <span className="text-4xl font-semibold tabular-nums tracking-tight">
                  {passRate === null ? '—' : `${passRate}%`}
                </span>
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  decision
                  <br className="hidden sm:block" /> pass rate
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <MetricChip icon={Layers} label="runs" value={runs.length} />
                <MetricChip icon={Clock3} label="avg" value={avgDuration ?? '—'} />
                <MetricChip
                  icon={CalendarClock}
                  label="latest"
                  value={latestRun ? relativeTime(latestRun.createdAt) : '—'}
                />
              </div>
            </div>

            {/* Distribution bar — passed / failed / active out of all runs. */}
            <div
              className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
              title={`${passed} passed · ${failed} failed · ${active} active · ${runs.length} total`}
            >
              {segments.map((s) =>
                s.pct > 0 ? (
                  <span
                    key={s.key}
                    className={cn('h-full transition-[width] duration-500', s.cls)}
                    style={{ width: `${s.pct}%` }}
                  />
                ) : null,
              )}
            </div>

            {/* Filters double as the distribution legend. */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              {filters.map((meta) => (
                <FilterChip
                  key={meta.value}
                  meta={meta}
                  active={filter === meta.value}
                  onClick={() => setFilter((f) => (f === meta.value ? 'all' : meta.value))}
                />
              ))}
            </div>
          </section>

          {/* Toolbar — search + result count. */}
          <div className="rounded-3xl border border-border/60 bg-card p-3 shadow-none">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="group relative w-full sm:max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <Input
                  placeholder="Search ticket, project or URL..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-10 rounded-full bg-background pl-9"
                />
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                {(filter !== 'all' || query) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilter('all')
                      setQuery('')
                    }}
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    Clear
                  </Button>
                )}
                <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums text-muted-foreground">
                  {visible.length === runs.length
                    ? `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`
                    : `${visible.length} of ${runs.length}`}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
        <CardContent className="p-0">
          {isLoading && (
            <div className="p-4">
              <LoadingSkeleton />
            </div>
          )}

          {isError && (
            <div className="m-4 flex flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 py-12 text-center">
              <AlertCircle className="size-6 text-destructive" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-destructive">Could not load runs</p>
                <p className="text-sm text-muted-foreground">
                  {error instanceof Error
                    ? error.message
                    : 'Something went wrong while fetching the history.'}
                </p>
              </div>
            </div>
          )}

          {!isLoading && !isError && !hasRuns && (
            <div className="flex flex-col items-center justify-center gap-4 py-20 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
                <Inbox className="size-6" />
              </div>
              <div className="space-y-1.5">
                <p className="text-base font-medium tracking-tight">No runs yet</p>
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                  Once you run a QC check, it will show up here with its status and results.
                </p>
              </div>
              <Button asChild className="rounded-full transition-all duration-200 active:scale-[0.98]">
                <Link to="/">Start your first run</Link>
              </Button>
            </div>
          )}

          {!isLoading && !isError && hasRuns && visible.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
                <Search className="size-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">No matching runs</p>
                <p className="text-sm text-muted-foreground">
                  Try a different search or clear the filter.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter('all')
                  setQuery('')
                }}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                Clear filters
              </Button>
            </div>
          )}

          {!isLoading && !isError && hasRuns && visible.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-11 pl-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Ticket
                    </TableHead>
                    <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Status
                    </TableHead>
                    <TableHead className="h-11 text-right text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Pass / Fail
                    </TableHead>
                    <TableHead className="hidden h-11 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground md:table-cell">
                      App URL
                    </TableHead>
                    <TableHead className="hidden h-11 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground lg:table-cell">
                      Duration
                    </TableHead>
                    <TableHead className="h-11 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      When
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((run) => (
                    <HistoryRow key={run.id} run={run} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
