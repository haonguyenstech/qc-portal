import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Clock3,
  ExternalLink,
  History as HistoryIcon,
  Inbox,
  Layers,
  Link2,
  Search,
  Sparkles,
  Ticket as TicketIcon,
  XCircle,
} from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listCrawledTickets, listRuns } from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import { useProjects } from '@/lib/project-context'
import { cn } from '@/lib/utils'
import type { RunStatus, RunSummary } from '@/lib/types'

type Filter = 'all' | 'passed' | 'failed' | 'active'

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

/** Compact absolute date + time, e.g. "Jul 1, 2026 · 2:32 PM". */
function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date} · ${time}`
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
    <div className="flex items-center gap-2">
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
        <span className="w-16 text-[11px] text-muted-foreground/60">—</span>
      )}
    </div>
  )
}

/** A single run inside an expanded ticket group — a compact, clickable row. */
function RunItem({ run }: { run: RunSummary }) {
  const to = `/run/${run.id}`
  const duration = formatDuration(run.createdAt, run.finishedAt)
  return (
    <Link
      to={to}
      className="group/run flex items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 transition-all hover:border-border/60 hover:bg-muted/40"
    >
      <StatusBadge status={run.status} compact />
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          className="flex min-w-0 items-center gap-1.5 whitespace-nowrap font-mono text-xs text-foreground"
          title={formatDate(run.createdAt)}
        >
          <CalendarClock className="size-3.5 shrink-0 text-muted-foreground/70" />
          {formatDateTime(run.createdAt)}
        </span>
        <span className="hidden whitespace-nowrap font-mono text-[11px] text-muted-foreground/70 md:inline">
          {relativeTime(run.createdAt)}
        </span>
        <span className="hidden items-center gap-1 font-mono text-[11px] text-muted-foreground/70 sm:inline-flex">
          <Clock3 className="size-3 shrink-0 opacity-60" />
          {duration ?? '—'}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground/70 lg:flex" title={run.appUrl}>
          <Link2 className="size-3 shrink-0 opacity-60" />
          <span className="truncate">{hostOf(run.appUrl)}</span>
        </span>
      </div>
      <ResultCell run={run} />
      <span className="ml-1 hidden w-[5.5rem] justify-end sm:flex">
        <StatusBadge status={run.status} />
      </span>
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground/50 transition-all group-hover/run:text-foreground" />
    </Link>
  )
}

interface TicketGroup {
  ticketId: string
  /** Ticket title from the crawled ticket.json, when the ticket has been crawled. */
  title: string | null
  /** ClickUp ticket URL from the crawled ticket.json, when available. */
  clickupUrl: string | null
  projectName: string | null
  runs: RunSummary[]
  latest: RunSummary
  passed: number
  failed: number
  active: number
}

/** A collapsible card grouping every run of one ticket. */
function TicketGroupCard({
  group,
  open,
  onToggle,
}: {
  group: TicketGroup
  open: boolean
  onToggle: () => void
}) {
  const { ticketId, title, clickupUrl, projectName, runs, latest, passed, failed, active } = group
  const total = runs.length || 1
  const segments = [
    { key: 'passed', pct: (passed / total) * 100, cls: 'bg-emerald-500' },
    { key: 'failed', pct: (failed / total) * 100, cls: 'bg-red-500' },
    { key: 'active', pct: (active / total) * 100, cls: 'bg-sky-500' },
  ]
  return (
    <div className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none transition-colors hover:border-border">
      {/* A div (not a button) so the ClickUp <a> can nest inside the full-row toggle. */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <TicketIcon className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="shrink-0 font-mono text-sm font-medium text-foreground" title={ticketId}>
              {ticketId}
            </span>
            {title && (
              <span className="min-w-0 truncate text-sm text-foreground/80" title={title}>
                {title}
              </span>
            )}
            {clickupUrl && (
              <a
                href={clickupUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title="Open in ClickUp"
                aria-label="Open ticket in ClickUp"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
              >
                <ExternalLink className="size-3.5" />
              </a>
            )}
            <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
              {runs.length} {runs.length === 1 ? 'run' : 'runs'}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate">{projectName ?? '—'}</span>
            <span aria-hidden>·</span>
            <span className="whitespace-nowrap" title={formatDate(latest.createdAt)}>
              last {relativeTime(latest.createdAt)}
            </span>
          </div>
        </div>

        {/* Aggregate pass/fail across the ticket's runs. */}
        <span className="hidden items-center gap-2 sm:flex">
          <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-emerald-700">
            <CheckCircle2 className="size-3.5" />
            {passed}
          </span>
          <span className="inline-flex items-center gap-1 text-xs font-medium tabular-nums text-red-600">
            <XCircle className="size-3.5" />
            {failed}
          </span>
          <span
            className="ml-1 flex h-1.5 w-20 overflow-hidden rounded-full bg-muted"
            title={`${passed} passed · ${failed} failed · ${active} active`}
          >
            {segments.map((s) =>
              s.pct > 0 ? (
                <span key={s.key} className={cn('h-full', s.cls)} style={{ width: `${s.pct}%` }} />
              ) : null,
            )}
          </span>
        </span>

        {/* Latest status — the headline outcome of the ticket. */}
        <StatusBadge status={latest.status} />

        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </div>

      {open && (
        <div className="space-y-1 border-t border-border/60 bg-muted/20 p-2">
          {runs.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  )
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-3xl border border-border/60 bg-card px-4 py-4"
        >
          <div className="size-9 animate-pulse rounded-2xl bg-muted" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-3 w-28 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
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

  // Crawled tickets carry the real title + ClickUp URL (from each ticket.json), keyed
  // by displayId — which is what a run stores as its ticketId. Join them so history
  // rows can show the ticket name and deep-link out to ClickUp.
  const { data: crawled } = useQuery({
    queryKey: ['crawled-tickets', activeProjectId],
    queryFn: () => listCrawledTickets(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  const ticketMeta = useMemo(() => {
    const map = new Map<string, { title: string | null; url: string | null }>()
    for (const t of crawled ?? []) {
      const info = { title: t.title, url: t.url }
      if (t.displayId) map.set(t.displayId.toLowerCase(), info)
      if (t.name) map.set(t.name.toLowerCase(), info)
    }
    return map
  }, [crawled])

  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

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

  // Group the visible runs by ticket. Each group keeps runs newest-first; groups
  // are ordered by their most-recent run so freshly-active tickets float to the top.
  const groups = useMemo<TicketGroup[]>(() => {
    const byTicket = new Map<string, RunSummary[]>()
    for (const run of visible) {
      const list = byTicket.get(run.ticketId)
      if (list) list.push(run)
      else byTicket.set(run.ticketId, [run])
    }
    const result: TicketGroup[] = []
    for (const [ticketId, list] of byTicket) {
      const sorted = [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      const meta = ticketMeta.get(ticketId.toLowerCase())
      result.push({
        ticketId,
        title: meta?.title ?? null,
        clickupUrl: meta?.url ?? null,
        projectName: sorted[0]?.projectName ?? null,
        runs: sorted,
        latest: sorted[0],
        passed: sorted.filter((r) => r.status === 'passed').length,
        failed: sorted.filter((r) => FAILED_STATUSES.includes(r.status)).length,
        active: sorted.filter((r) => ACTIVE_STATUSES.includes(r.status)).length,
      })
    }
    return result.sort(
      (a, b) => new Date(b.latest.createdAt).getTime() - new Date(a.latest.createdAt).getTime(),
    )
  }, [visible, ticketMeta])

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.ticketId))

  function toggleGroup(ticketId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(ticketId)) next.delete(ticketId)
      else next.add(ticketId)
      return next
    })
  }

  function toggleAll() {
    setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.ticketId)))
  }

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
              QC executions grouped by ticket — expand a ticket to compare its runs over time and
              open the full evidence report for any one.
            </p>
          </div>
        </div>

        <Button asChild size="sm" className="w-fit rounded-full transition-all duration-200 active:scale-[0.98]">
          <Link to="/qc-run">
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
                <MetricChip icon={TicketIcon} label="tickets" value={new Set(runs.map((r) => r.ticketId)).size} />
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

          {/* Toolbar — search + expand/collapse + result count. */}
          <div className="rounded-3xl border border-border/60 bg-card p-3 shadow-none">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="group relative w-full sm:max-w-md">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <Input
                  placeholder="Search ticket, project or URL..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-11 rounded-full pl-9 shadow-none"
                />
              </div>
              <div className="flex items-center justify-between gap-2 sm:justify-end">
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
                {groups.length > 1 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleAll}
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    {allCollapsed ? (
                      <>
                        <ChevronsUpDown className="size-4" />
                        Expand all
                      </>
                    ) : (
                      <>
                        <ChevronsDownUp className="size-4" />
                        Collapse all
                      </>
                    )}
                  </Button>
                )}
                <span className="shrink-0 rounded-full bg-muted px-2.5 py-1 text-xs font-medium tabular-nums text-muted-foreground">
                  {groups.length} {groups.length === 1 ? 'ticket' : 'tickets'}
                  {visible.length !== runs.length && ` · ${visible.length} runs`}
                </span>
              </div>
            </div>
          </div>
        </>
      )}

      {isLoading && <LoadingSkeleton />}

      {isError && (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 py-12 text-center">
            <AlertCircle className="size-6 text-destructive" />
            <div className="space-y-1">
              <p className="text-sm font-medium text-destructive">Could not load runs</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error
                  ? error.message
                  : 'Something went wrong while fetching the history.'}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && !hasRuns && (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Inbox className="size-6" />
            </div>
            <div className="space-y-1.5">
              <p className="text-base font-medium tracking-tight">No runs yet</p>
              <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                Once you run a QC check, it will show up here grouped by ticket with its status and
                results.
              </p>
            </div>
            <Button asChild className="rounded-full transition-all duration-200 active:scale-[0.98]">
              <Link to="/qc-run">Start your first run</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && hasRuns && groups.length === 0 && (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Search className="size-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No matching tickets</p>
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
          </CardContent>
        </Card>
      )}

      {!isLoading && !isError && hasRuns && groups.length > 0 && (
        <div className="space-y-3">
          {groups.map((group) => (
            <TicketGroupCard
              key={group.ticketId}
              group={group}
              open={!collapsed.has(group.ticketId)}
              onToggle={() => toggleGroup(group.ticketId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
