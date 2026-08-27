import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileDown,
  FileJson,
  FileText,
  Gauge,
  Globe,
  KeyRound,
  Loader2,
  LogIn,
  LogOut,
  Plus,
  Rocket,
  Terminal,
  TerminalSquare,
  Timer,
  Trash2,
  TriangleAlert,
  TrendingUp,
  XCircle,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import NfrReportPanel from '@/components/NfrReportPanel'
import { CurlImportDialog } from '@/components/CurlImportDialog'
import { SavedRequestPicker } from '@/components/SavedRequestPicker'
import {
  endpointFromDraft,
  endpointFromSavedRequest,
  hasVars,
  clearLoadHandoff,
  isBlankEndpoint,
  peekLoadEndpoint,
  varsIn,
} from '@/lib/loadEndpoint'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  cancelPerfJob,
  clearAuthSession,
  closeAuthSession,
  deletePerfJob,
  exportReportFile,
  getAuthSession,
  getPerfAvailable,
  getPerfJob,
  listPerfJobs,
  openAuthSession,
  previewK6Script,
  startLoadTest,
  startPageAudit,
  type AuditRequest,
  type LoadEndpointInput,
  type LoadTestInput,
  type PageAuditResult,
  type PerfJob,
  type PerfJobKind,
  type LoadTestResult,
} from '@/lib/api'
import {
  assessLoadTest,
  assessPageAudit,
  bytes,
  downloadBlob,
  downloadText,
  gradeLabel,
  hostOf,
  coldMetrics,
  loadExtras,
  MEASUREMENT_NOTES,
  ms,
  PAGE_MEASUREMENT_NOTES,
  pct,
  reportFileName,
  reportJson,
  reportMarkdown,
  shortUrl,
  warmMetrics,
  type Assessment,
  type Grade,
} from '@/lib/perfReport'
import { reportHtml } from '@/lib/perfReportHtml'
import {
  loadConcurrencyChart,
  loadEndpointChart,
  loadErrorsOverTimeChart,
  loadLatencyChart,
  loadOverTimeChart,
  loadPercentileChart,
  loadPhaseChart,
  loadThroughputChart,
  loadVolumeChart,
  pageApiChart,
  pageMilestoneChart,
  pageResourceChart,
  pageRunsChart,
  pageWaterfallChart,
} from '@/lib/perfCharts'
import { useProjects } from '@/lib/project-context'
import type { Project } from '@/lib/types'

/**
 * PERFORMANCE — "is this slow, and why?"
 *
 * Two tools, because the question splits cleanly in two and the answers come from
 * different places:
 *
 *   • **Page load** drives a real browser (`server/src/pageAudit.ts`). It answers
 *     how long the page takes to load, how long each API took to return its data,
 *     and — the one a functional test never catches — whether the app calls the
 *     same endpoint several times on a single load.
 *   • **API load test** drives k6 (`server/src/k6.ts`). It answers how those same
 *     response times behave when N users hit the endpoint at once.
 *
 * Both run as server-side background jobs polled by id, so a 10-minute soak
 * survives a browser reload; the active job id is remembered per project and per
 * tab, and the page reconnects to it on mount.
 */

const HEADED_KEY = 'qc.perf.headed'
const ACTIVE_JOB_PREFIX = 'qc.perfJob.' // + <kind>.<projectId>
const LOAD_FORM_PREFIX = 'qc.perfLoadForm.' // + <projectId>
const PAGE_FORM_PREFIX = 'qc.perfPageForm.' // + <projectId>
const SIGNED_IN_PREFIX = 'qc.perfSignedIn.' // + <origin> — when we last signed in there

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStore(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable — the feature still works, it just won't reconnect */
  }
}
function removeStore(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* nothing to forget, then */
  }
}
function clearStore(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/**
 * A saved form, merged over its defaults. Merging matters across portal updates:
 * a stored object from an older version is missing whatever fields were added
 * since, and spreading it bare would put `undefined` into a controlled input.
 */
function restoreForm<T>(key: string, fallback: T): T {
  const saved = readStore(key)
  if (!saved) return fallback
  try {
    const parsed = JSON.parse(saved) as Partial<T>
    return { ...fallback, ...parsed }
  } catch {
    return fallback
  }
}

function activeJobKey(kind: PerfJobKind, projectId: string): string {
  return `${ACTIVE_JOB_PREFIX}${kind}.${projectId}`
}

// Formatting, verdict bands and export all live in `lib/perfReport.ts` so the
// screen and the exported file can never disagree about what a number means.

// ------------------------------------------------------------------ small parts

const GRADE_TONE: Record<Grade, { chip: string; text: string; icon: typeof Gauge }> = {
  good: {
    chip: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30',
    text: 'text-emerald-700 dark:text-emerald-400',
    icon: CheckCircle2,
  },
  warn: {
    chip: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/30',
    text: 'text-amber-700 dark:text-amber-400',
    icon: AlertTriangle,
  },
  bad: {
    chip: 'bg-destructive/10 text-destructive border-destructive/30',
    text: 'text-destructive',
    icon: XCircle,
  },
  unknown: {
    chip: 'bg-muted/60 text-muted-foreground border-border/60',
    text: 'text-muted-foreground',
    icon: Ban,
  },
}

const SEVERITY_TONE: Record<'high' | 'medium' | 'low', string> = {
  high: 'bg-destructive/10 text-destructive',
  medium: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  low: 'bg-muted/60 text-muted-foreground',
}

/**
 * THE VERDICT. The tables say what happened; this says whether it is good, and
 * what to chase. Bands come from `lib/perfReport.ts` — the same ones the exported
 * file quotes, so a report cannot grade differently on screen than in a ticket.
 */
function AssessmentCard({ assessment, job }: { assessment: Assessment; job: PerfJob }) {
  const tone = GRADE_TONE[assessment.grade]
  const Icon = tone.icon
  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-2xl border',
              tone.chip,
            )}
          >
            <Icon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">Assessment</p>
              <span
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium',
                  tone.chip,
                )}
              >
                {gradeLabel(assessment.grade)}
              </span>
            </div>
            <p className={cn('mt-0.5 text-sm', tone.text)}>{assessment.headline}</p>
          </div>
          <ExportBar job={job} />
        </div>

        {assessment.checks.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {assessment.checks.map((c) => {
              const t = GRADE_TONE[c.grade]
              return (
                <div
                  key={c.label}
                  className="rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5 transition-all duration-200 hover:border-border"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-muted-foreground">{c.label}</span>
                    <span className={cn('shrink-0 font-mono text-sm font-semibold tabular-nums', t.text)}>
                      {c.value}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{c.note}</p>
                </div>
              )
            })}
          </div>
        )}

        {assessment.findings.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              What to look at ({assessment.findings.length})
            </p>
            {assessment.findings.map((f, i) => (
              <div key={i} className="rounded-2xl border border-border/60 bg-card px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                      SEVERITY_TONE[f.severity],
                    )}
                  >
                    {f.severity}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium">{f.title}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{f.detail}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * A chart drawn by `lib/perfCharts.ts`. The chart is an SVG STRING rather than
 * JSX so the identical drawing code serves the page, the PDF and the Word file —
 * three renderers that would otherwise drift. `viz-root` carries the colour roles
 * (and their dark-mode values) the SVG draws against.
 */
function Chart({ svg }: { svg: string }) {
  if (!svg) return null
  return <div className="viz-root overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
}

/**
 * Export. A performance finding is only useful once it is in a ticket, so every
 * format carries the verdict, the numbers AND the tables — not a screenshot of
 * them. Markdown and JSON are built in the browser; PDF and Word are the same
 * report HTML converted server-side, because printing needs a real Chrome.
 */
function ExportBar({ job }: { job: PerfJob }) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<'pdf' | 'docx' | null>(null)

  async function exportFile(format: 'pdf' | 'docx'): Promise<void> {
    setBusy(format)
    try {
      const blob = await exportReportFile(format, reportHtml(job), reportFileName(job))
      downloadBlob(`${reportFileName(job)}.${format}`, blob)
      toast.success(format === 'pdf' ? 'PDF downloaded' : 'Word document downloaded')
    } catch (err) {
      toast.error(`Could not build the ${format === 'pdf' ? 'PDF' : 'Word file'}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={busy !== null}
        className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
        onClick={() => void exportFile('pdf')}
      >
        {busy === 'pdf' ? <Loader2 className="size-3.5 animate-spin" /> : <FileDown className="size-3.5" />}
        PDF
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={busy !== null}
        className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
        onClick={() => void exportFile('docx')}
      >
        {busy === 'docx' ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
        Word
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
        onClick={() => {
          void navigator.clipboard.writeText(reportMarkdown(job)).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
              toast.success('Report copied as Markdown')
            },
            () => toast.error('Could not copy the report'),
          )
        }}
      >
        {copied ? <CheckCircle2 className="size-3.5" /> : <Copy className="size-3.5" />}
        Copy
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
        onClick={() => {
          downloadText(`${reportFileName(job)}.md`, reportMarkdown(job), 'text/markdown')
          toast.success('Markdown report downloaded')
        }}
      >
        <Download className="size-3.5" />
        .md
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
        onClick={() => {
          downloadText(`${reportFileName(job)}.json`, reportJson(job), 'application/json')
          toast.success('JSON report downloaded')
        }}
      >
        <FileJson className="size-3.5" />
        .json
      </Button>
    </div>
  )
}

/** One headline number. The whole page is read by scanning these first. */
function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  icon: Icon,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
  icon?: typeof Gauge
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-border/60 bg-muted/60 px-4 py-3 transition-all duration-200',
        tone === 'good' && 'border-emerald-500/30 bg-emerald-500/5',
        tone === 'warn' && 'border-amber-500/30 bg-amber-500/5',
        tone === 'bad' && 'border-destructive/30 bg-destructive/5',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </div>
      <div
        className={cn(
          'mt-1 font-mono text-xl font-semibold tabular-nums tracking-tight',
          tone === 'good' && 'text-emerald-600',
          tone === 'warn' && 'text-amber-600',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  )
}

const METHOD_TONE: Record<string, string> = {
  GET: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  POST: 'bg-blue-500/10 text-blue-700 dark:text-blue-400',
  PUT: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  PATCH: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  DELETE: 'bg-destructive/10 text-destructive',
}

function MethodPill({ method }: { method: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-xl px-2 py-0.5 font-mono text-[11px] font-semibold',
        METHOD_TONE[method] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {method}
    </span>
  )
}

/** The live log every job writes. Auto-scrolls only while the job is running. */
function JobLog({ job }: { job: PerfJob }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const running = job.status === 'running'
  useEffect(() => {
    if (!running) return
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [job.logs.length, job.progress, running])

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40">
      <div className="flex items-center gap-2 border-b border-border/60 px-4 py-2 text-xs font-medium text-muted-foreground">
        <Terminal className="size-3.5" />
        Log
        {job.progress && (
          <span className="ml-auto truncate font-mono text-[11px] text-foreground">
            {job.progress}
          </span>
        )}
      </div>
      <div ref={boxRef} className="max-h-64 overflow-y-auto px-4 py-2.5">
        {job.logs.length === 0 ? (
          <p className="py-2 text-xs text-muted-foreground">Waiting for output…</p>
        ) : (
          job.logs.map((line, i) => (
            <div
              key={i}
              className={cn(
                'whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed',
                line.level === 'error' && 'text-destructive',
                line.level === 'success' && 'text-emerald-600',
                line.level === 'info' && 'text-muted-foreground',
              )}
            >
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: PerfJob['status'] }) {
  const map = {
    running: { icon: Loader2, text: 'Running', cls: 'bg-muted/60 text-muted-foreground', spin: true },
    done: { icon: CheckCircle2, text: 'Done', cls: 'bg-emerald-500/10 text-emerald-700', spin: false },
    error: { icon: XCircle, text: 'Failed', cls: 'bg-destructive/10 text-destructive', spin: false },
    cancelled: { icon: Ban, text: 'Stopped', cls: 'bg-muted/60 text-muted-foreground', spin: false },
  } as const
  const s = map[status]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium', s.cls)}
    >
      <s.icon className={cn('size-3', s.spin && 'animate-spin')} />
      {s.text}
    </span>
  )
}

/**
 * When a run happened — DATE then time, on every row, including today's.
 *
 * The job registry is IN MEMORY (`perfJobs.ts`) and the portal's server routinely
 * stays up for days, so this list mixes runs from several dates. A bare clock
 * time made a run from last Tuesday read as one from twenty minutes ago, and
 * these rows are how an engineer picks which report to compare against. Hiding
 * the date on today's rows just moves the ambiguity: you cannot tell a dateless
 * row from an old one without knowing the rule. So the date is always there;
 * the year only when it isn't this one, and the full stamp stays on hover.
 */
function runStamp(iso: string): string {
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return ''
  const date = then.toLocaleDateString([], {
    day: '2-digit',
    month: 'short',
    ...(then.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
  })
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return `${date} ${time}`
}

/**
 * Past runs of one kind — click one to bring its report back, or drop it.
 *
 * The row is a DIV wrapping two buttons rather than one big button: a delete
 * control nested inside a clickable button is invalid HTML and the browser is
 * free to swallow one of the two clicks. The delete only appears on hover/focus,
 * because the common gesture here is "open that report", not "throw it away".
 */
function RecentRuns({
  jobs,
  activeId,
  onPick,
  onDelete,
  deletingId,
}: {
  jobs: PerfJob[]
  activeId: string | null
  onPick: (id: string) => void
  onDelete: (job: PerfJob) => void
  deletingId: string | null
}) {
  if (!jobs.length) return null
  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-1.5 p-4">
        <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">Recent runs</p>
        {jobs.slice(0, 8).map((j) => (
          <div
            key={j.id}
            className={cn(
              'group flex w-full items-center gap-2 rounded-2xl border pr-2 transition-all duration-200',
              j.id === activeId
                ? 'border-border bg-muted/60'
                : 'border-transparent hover:border-border/60 hover:bg-muted/40',
              deletingId === j.id && 'opacity-50',
            )}
          >
            <button
              type="button"
              onClick={() => onPick(j.id)}
              className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left transition-all duration-200 active:scale-[0.98]"
            >
              <span className="min-w-0 flex-1 truncate text-sm">{j.label}</span>
              <span
                title={new Date(j.createdAt).toLocaleString()}
                className="shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground"
              >
                {runStamp(j.createdAt)}
              </span>
              <StatusPill status={j.status} />
            </button>
            <button
              type="button"
              onClick={() => onDelete(j)}
              disabled={deletingId === j.id}
              title={j.status === 'running' ? 'Stop this run and delete it' : 'Delete this run'}
              aria-label={`Delete run ${j.label}`}
              className="shrink-0 rounded-full p-1.5 text-muted-foreground opacity-0 transition-all duration-200 hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            >
              {deletingId === j.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ page audit

interface PageForm {
  url: string
  runs: number
  settleMs: number
  useProfile: boolean
}

const DEFAULT_PAGE_FORM: PageForm = { url: '', runs: 3, settleMs: 3000, useProfile: true }

/** Verdict tone for a page-load time, using the usual web-performance bands. */
function loadTone(loadMs: number): 'good' | 'warn' | 'bad' {
  if (loadMs <= 0) return 'warn'
  if (loadMs < 2500) return 'good'
  if (loadMs < 5000) return 'warn'
  return 'bad'
}

function DuplicateCallsCard({ result }: { result: PageAuditResult }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!result.duplicates.length) {
    // On a redirected run the all-clear is true of the login screen and says
    // nothing about the page that was asked for — state it in the muted voice
    // of a fact, not the green voice of a verdict.
    if (result.redirected) {
      return (
        <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/40 px-4 py-3">
          <Ban className="size-4 shrink-0 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No duplicate-call check — the browser never reached the page you asked for.
          </p>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
        <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
        <p className="text-sm text-emerald-700 dark:text-emerald-400">
          No API was called more than once per page load.
        </p>
      </div>
    )
  }
  const wasted = result.duplicates.reduce(
    (sum, d) => sum + (d.avgMs * (d.perLoad - 1)),
    0,
  )
  return (
    <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
            {result.duplicates.length} API endpoint{result.duplicates.length === 1 ? '' : 's'} called
            more than once per page load
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Roughly {ms(wasted)} of the load is spent on repeat calls. Each row shows how many times
            the endpoint was hit on a single load — expand it for the exact URLs.
          </p>
        </div>
      </div>
      <div className="space-y-1.5">
        {result.duplicates.map((d) => {
          const key = `${d.method} ${d.endpoint}`
          const expanded = open === key
          return (
            <div key={key} className="rounded-xl border border-border/60 bg-card">
              <button
                type="button"
                onClick={() => setOpen(expanded ? null : key)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
              >
                {expanded ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <MethodPill method={d.method} />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {shortUrl(d.endpoint)}
                </span>
                <span className="shrink-0 rounded-xl bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                  {d.perLoad % 1 === 0 ? d.perLoad : d.perLoad.toFixed(1)}× per load
                </span>
                <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
                  {ms(d.avgMs)} each
                </span>
              </button>
              {expanded && (
                <div className="space-y-1 border-t border-border/60 px-3 py-2">
                  {d.urls.map((u) => (
                    <p key={u} className="break-all font-mono text-[11px] text-muted-foreground">
                      {u}
                    </p>
                  ))}
                  <p className="pt-1 text-[11px] text-muted-foreground">
                    {d.count} call{d.count === 1 ? '' : 's'} across {result.runs} load
                    {result.runs === 1 ? '' : 's'} · {ms(d.totalMsPerLoad)} total per load
                  </p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function RequestTable({ result }: { result: PageAuditResult }) {
  const [apiOnly, setApiOnly] = useState(true)
  const rows = useMemo(
    () => (apiOnly ? result.requests.filter((r) => r.api) : result.requests),
    [result.requests, apiOnly],
  )
  const cell = 'px-3 py-2 align-middle'
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          Requests <span className="text-muted-foreground">({rows.length})</span>
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            size="sm"
            checked={apiOnly}
            onCheckedChange={setApiOnly}
            aria-label="Show API calls only"
          />
          API calls only
        </label>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-border/60">
        <table className="w-full min-w-[720px] border-collapse text-left text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className={cn(cell, 'font-medium')}>Request</th>
              <th className={cn(cell, 'w-24 text-right font-medium')}>Per load</th>
              <th className={cn(cell, 'w-24 text-right font-medium')}>Avg</th>
              <th className={cn(cell, 'w-24 text-right font-medium')}>Slowest</th>
              <th className={cn(cell, 'w-24 text-right font-medium')}>TTFB</th>
              <th className={cn(cell, 'w-24 text-right font-medium')}>Size</th>
              <th className={cn(cell, 'w-16 text-right font-medium')}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className={cn(cell, 'text-center text-muted-foreground')}>
                  No requests recorded.
                </td>
              </tr>
            ) : (
              rows.map((r: AuditRequest) => (
                <tr key={`${r.method} ${r.url}`} className="border-t border-border/60">
                  <td className={cell}>
                    <div className="flex min-w-0 items-center gap-2">
                      <MethodPill method={r.method} />
                      <span className="min-w-0 truncate font-mono" title={r.url}>
                        {shortUrl(r.url)}
                      </span>
                    </div>
                  </td>
                  <td
                    className={cn(
                      cell,
                      'text-right font-mono tabular-nums',
                      r.api && r.perLoad >= 2 && 'font-semibold text-amber-600',
                    )}
                  >
                    {r.perLoad % 1 === 0 ? r.perLoad : r.perLoad.toFixed(1)}×
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums')}>{ms(r.avgMs)}</td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums')}>{ms(r.maxMs)}</td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {ms(r.avgWaitMs)}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {bytes(r.avgBytes)}
                  </td>
                  <td
                    className={cn(
                      cell,
                      'text-right font-mono tabular-nums',
                      r.status && r.status >= 400 && 'text-destructive',
                    )}
                  >
                    {r.status ?? '—'}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** The origin of a URL, or '' — what a saved session is keyed by. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/**
 * SIGN IN FIRST — the step that makes a page behind a login measurable.
 *
 * The audit runs in the portal's own Chrome profile, and this app family keeps its
 * token in localStorage, which is scoped **per origin AND per profile**. So being
 * signed in on your own Chrome does nothing, and being signed in to one origin
 * does nothing for another. The only fix is to sign in once per origin *inside
 * that profile*, which used to require a terminal command. This does it from here:
 * open a real window on the profile, sign in by hand, close it — closing is what
 * flushes the session to disk and releases the profile lock the audit needs.
 */
function SignInPanel({ pageUrl, onBusyChange }: { pageUrl: string; onBusyChange: (busy: boolean) => void }) {
  const queryClient = useQueryClient()
  const suggested = originOf(pageUrl)
  const [url, setUrl] = useState('')

  const { data } = useQuery({
    queryKey: ['perf-auth-session'],
    queryFn: getAuthSession,
    // Poll only while a window is open, so the UI can show where it navigated to.
    refetchInterval: (query) => (query.state.data?.session.active ? 2000 : false),
  })
  const session = data?.session
  const active = session?.active === true

  useEffect(() => {
    onBusyChange(active)
  }, [active, onBusyChange])

  // What the buttons act on: whatever is typed, else the origin of the audit URL.
  const target = (url.trim() || suggested).trim()
  const targetOrigin = originOf(target) || suggested
  const signedInAt = targetOrigin ? readStore(SIGNED_IN_PREFIX + targetOrigin) : null

  const open = useMutation({
    // `reset` first drops the saved session. Without it "sign in again" is a lie
    // on an expired token: the app sees the stale token, skips its own login
    // screen, and the next audit is bounced to /login exactly as before.
    mutationFn: async (reset: boolean) => {
      if (reset) await clearAuthSession(target)
      return await openAuthSession(target)
    },
    onSuccess: ({ session: s }, reset) => {
      queryClient.setQueryData(['perf-auth-session'], { session: s })
      if (reset && targetOrigin) removeStore(SIGNED_IN_PREFIX + targetOrigin)
    },
    onError: (err: Error) =>
      toast.error('Could not open the sign-in window', { description: err.message }),
  })

  /** Forget the login without opening a window — "not this user any more". */
  const signOut = useMutation({
    mutationFn: () => clearAuthSession(target),
    onSuccess: ({ origin, storageCleared }) => {
      removeStore(SIGNED_IN_PREFIX + origin)
      toast.success('Signed out of the audit browser', {
        description: storageCleared
          ? `${origin} is signed out. The next audit will hit its login screen until you sign in again.`
          : `Cookies for ${origin} were dropped, but its page could not be opened to clear local storage — sign in again to be sure.`,
      })
    },
    onError: (err: Error) => toast.error('Could not clear the session', { description: err.message }),
  })

  const close = useMutation({
    mutationFn: closeAuthSession,
    onSuccess: ({ origin, session: s }) => {
      queryClient.setQueryData(['perf-auth-session'], { session: s })
      if (origin) {
        writeStore(SIGNED_IN_PREFIX + origin, new Date().toISOString())
        toast.success('Session saved', { description: `The audit browser is now signed in to ${origin}.` })
      }
    },
    onError: (err: Error) => toast.error('Could not close the window', { description: err.message }),
  })


  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-3 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Page behind a login?</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Sign in once <span className="font-medium text-foreground">in the audit's own browser</span>{' '}
              — your everyday Chrome is a different profile, and each site is stored separately.
            </p>
          </div>
          {signedInAt && !active && (
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-[11px] font-medium text-emerald-700 sm:inline-flex dark:text-emerald-400">
              <CheckCircle2 className="size-3" />
              signed in {new Date(signedInAt).toLocaleDateString()}
            </span>
          )}
        </div>

        {active ? (
          <div className="space-y-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
              A browser window is open — sign in there, then come back.
            </p>
            <p className="break-all font-mono text-[11px] text-muted-foreground">
              now on {session?.currentUrl ?? session?.url}
            </p>
            <p className="text-xs text-muted-foreground">
              Measuring is paused until it closes: Chrome cannot open one profile twice, and closing
              the window is what saves the session.
            </p>
            <Button
              onClick={() => close.mutate()}
              disabled={close.isPending}
              className="h-9 rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {close.isPending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
              I'm signed in — close &amp; save
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={suggested || 'https://dev.example.com/login'}
                className="h-9 min-w-[240px] flex-1 rounded-xl font-mono text-xs"
              />
              <Button
                variant="outline"
                onClick={() => open.mutate(Boolean(signedInAt))}
                disabled={open.isPending || signOut.isPending || !target}
                className="h-9 rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {open.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogIn className="size-4" />
                )}
                {signedInAt ? 'Sign in again' : 'Open sign-in window'}
              </Button>
              {signedInAt && (
                <Button
                  variant="ghost"
                  onClick={() => signOut.mutate()}
                  disabled={open.isPending || signOut.isPending}
                  className="h-9 rounded-full text-muted-foreground transition-all duration-200 active:scale-[0.98]"
                >
                  {signOut.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LogOut className="size-4" />
                  )}
                  Sign out
                </Button>
              )}
            </div>
            {signedInAt && (
              <p className="text-xs text-muted-foreground">
                Already signed in here, so{' '}
                <span className="font-medium text-foreground">Sign in again</span> clears{' '}
                <span className="font-mono">{targetOrigin}</span> first — otherwise the app skips its
                own login screen and nothing is refreshed. Use{' '}
                <span className="font-medium text-foreground">Sign out</span> to audit as a
                different user, or when a run keeps landing on the login page.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The report is only about the page you asked for if the browser stayed there.
 * A session-less browser is bounced to /login, and the tiles then say the page is
 * fast and calls nothing — a confident, completely wrong answer. Say so first,
 * above every number, and name the fix.
 */
function AuthWarning({
  result,
  useProfile,
}: {
  result: PageAuditResult
  useProfile: boolean
}) {
  const thin = !result.redirected && result.totals.apiEndpointCount <= 1
  if (!result.redirected && !thin) return null
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {result.redirected
            ? 'The page redirected — these numbers describe somewhere else'
            : 'Almost no API calls were recorded'}
        </p>
        {result.redirected && (
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            ended on {result.finalUrl}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {useProfile
            ? 'The saved browser session has probably expired. Log in again in the profile the audit uses (~/.pw-agent-profile), then re-run.'
            : 'Tick “Use the logged-in profile” below the URL — a clean browser has no session, so a page behind a login lands on the login screen instead.'}
        </p>
      </div>
    </div>
  )
}

/**
 * The JavaScript errors the page reported while loading.
 *
 * Deliberately its own card rather than a row in the request table: an uncaught
 * exception is not a timing, and a page that throws on mount is broken whatever
 * its load time says. `pageerror` (nobody caught it) is separated from
 * error-level console output (the app chose to log it), because the second is
 * routinely deliberate and the first never is.
 */
function PageIssuesCard({ result }: { result: PageAuditResult }) {
  const issues = result.issues ?? []
  if (!issues.length) return null
  const thrown = issues.filter((i) => i.kind === 'pageerror')
  const logged = issues.filter((i) => i.kind === 'console')
  return (
    <Card
      className={cn(
        'rounded-3xl shadow-none',
        thrown.length ? 'border-destructive/30 bg-destructive/5' : 'border-border/60',
      )}
    >
      <CardContent className="space-y-2.5 p-5">
        <div className="flex items-center gap-2">
          <TriangleAlert className={cn('size-4', thrown.length ? 'text-destructive' : 'text-amber-500')} />
          <p className="text-sm font-semibold tracking-tight">
            {thrown.length
              ? `${thrown.length} uncaught JavaScript error${thrown.length === 1 ? '' : 's'} while loading`
              : `${logged.length} console error${logged.length === 1 ? '' : 's'} while loading`}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          The load event fires either way, so no timing on this page shows these — but whatever
          that code was meant to do did not happen.
        </p>
        <ul className="space-y-1.5">
          {issues.slice(0, 8).map((issue) => (
            <li
              key={`${issue.kind}:${issue.text}`}
              className="flex items-start gap-2 rounded-xl border border-border/60 bg-card px-3 py-2"
            >
              <span
                className={cn(
                  'mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                  issue.kind === 'pageerror'
                    ? 'bg-destructive/10 text-destructive'
                    : 'bg-muted text-muted-foreground',
                )}
              >
                {issue.kind === 'pageerror' ? 'thrown' : 'console'}
              </span>
              <span className="min-w-0 flex-1 break-words font-mono text-[11px] leading-relaxed">
                {issue.text}
              </span>
              {issue.count > 1 ? (
                <span className="shrink-0 text-[11px] text-muted-foreground">×{issue.count}</span>
              ) : null}
            </li>
          ))}
        </ul>
        {issues.length > 8 ? (
          <p className="text-[11px] text-muted-foreground">
            {issues.length - 8} more distinct message{issues.length - 8 === 1 ? '' : 's'} not listed.
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

function PageAuditReport({ job, result }: { job: PerfJob; result: PageAuditResult }) {
  // Cold and warm are kept apart everywhere on this report. Their MEAN is what
  // `result.average` holds, and it describes neither visit: a 1291ms first load
  // and a 70ms cached one average to 529ms, a number no load ever produced.
  const warm = warmMetrics(result)
  const cold = coldMetrics(result)
  const warmRuns = result.warmRuns ?? 0
  const assessment = useMemo(() => assessPageAudit(result), [result])
  return (
    <div className="space-y-5">
      <AuthWarning result={result} useProfile={job.pageConfig?.useProfile !== false} />
      <AssessmentCard assessment={assessment} job={job} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label={warmRuns ? 'Returning visit' : 'Page load'}
          value={ms(warm.loadMs)}
          hint={warmRuns ? `median of ${warmRuns} warm load${warmRuns === 1 ? '' : 's'}` : 'one cold load'}
          tone={loadTone(warm.loadMs)}
          icon={Timer}
        />
        <StatTile
          label="First visit"
          value={ms(cold.loadMs)}
          hint={`empty cache · ${bytes(cold.transferBytes)} downloaded`}
          tone={loadTone(cold.loadMs)}
          icon={Download}
        />
        <StatTile label="Main content" value={ms(warm.lcpMs)} hint="LCP · good ≤ 2.5s" />
        <StatTile
          label="Layout shift"
          value={warm.cls != null ? warm.cls.toFixed(3) : '—'}
          hint="CLS · good ≤ 0.1"
          tone={warm.cls == null ? undefined : warm.cls <= 0.1 ? 'good' : warm.cls <= 0.25 ? 'warn' : 'bad'}
        />
        <StatTile
          label="Blocking time"
          value={warm.tbtMs == null ? '—' : warm.tbtMs > 0 ? ms(warm.tbtMs) : '0ms'}
          hint={warm.longestTaskMs ? `longest task ${ms(warm.longestTaskMs)}` : 'long tasks before load'}
          tone={warm.tbtMs == null ? undefined : warm.tbtMs <= 200 ? 'good' : warm.tbtMs <= 600 ? 'warn' : 'bad'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-2xl border border-border/60 bg-card px-4 py-3 text-xs text-muted-foreground">
        <span>
          Per load:{' '}
          <span className="font-mono text-foreground">
            {result.perRun.map((r, i) => `${ms(r.loadMs)}${i === 0 ? ' (cold)' : ''}`).join(' · ')}
          </span>
        </span>
        <span>
          TTFB: <span className="font-mono text-foreground">{ms(warm.ttfbMs)}</span>
        </span>
        <span>
          First paint: <span className="font-mono text-foreground">{ms(warm.fcpMs)}</span>
        </span>
        <span>
          Requests/load: <span className="font-mono text-foreground">{warm.requestCount.toFixed(0)}</span>
        </span>
        <span>
          API calls/load:{' '}
          <span className="font-mono text-foreground">
            {(result.totals.apiCount / result.runs).toFixed(1)}
          </span>
        </span>
        <span>
          Slowest API:{' '}
          <span className="font-mono text-foreground">{ms(result.totals.slowestApiMs)}</span>
        </span>
      </div>

      <PageIssuesCard result={result} />
      <DuplicateCallsCard result={result} />

      {/* One chart per row, full width. Side by side they scale to ~60%, and an
          11px label becomes 7px — unreadable, which is worse than scrolling. */}
      <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4">
        <Chart svg={pageMilestoneChart(result)} />
        <Chart svg={pageWaterfallChart(result)} />
        <Chart svg={pageRunsChart(result)} />
        <Chart svg={pageResourceChart(result)} />
        <Chart svg={pageApiChart(result)} />
      </div>

      <RequestTable result={result} />

      <details className="rounded-2xl border border-border/60 bg-card px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium">How to read these numbers</summary>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          {PAGE_MEASUREMENT_NOTES.map((note) => (
            <li key={note} className="leading-relaxed">
              {note.replace(/\*\*/g, '')}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

// ------------------------------------------------------------------ load test

interface EndpointForm extends LoadEndpointInput {
  /** Raw `Key: Value` lines — parsed into `headers` on submit. */
  headerText: string
}

interface LoadForm {
  name: string
  vus: number
  duration: string
  rampUp: string
  sleepSeconds: number
  thresholdP95Ms: number
  thresholdErrorRate: number
  insecureSkipTLSVerify: boolean
  endpoints: EndpointForm[]
}

function blankEndpoint(): EndpointForm {
  return { name: '', method: 'GET', url: '', headers: {}, body: '', headerText: '' }
}

const DEFAULT_LOAD_FORM: LoadForm = {
  name: 'Load test',
  vus: 10,
  duration: '30s',
  rampUp: '',
  sleepSeconds: 1,
  thresholdP95Ms: 2000,
  thresholdErrorRate: 0.01,
  insecureSkipTLSVerify: true,
  endpoints: [blankEndpoint()],
}

/**
 * The load form to open with, and where a handoff landed in it.
 *
 * Called from BOTH `useState` initializers, so it must stay pure — hence
 * `peekLoadEndpoint` rather than a read that consumes. React double-invokes
 * initializers on mount in dev and keeps the second result; a consuming read
 * would hand the endpoint to the pass that gets thrown away. The value is
 * cleared once, from an effect, after the form exists.
 */
function initialLoadForm(projectId: string | null): {
  form: LoadForm
  importedFrom: number | null
} {
  const restored = restoreForm(LOAD_FORM_PREFIX + projectId, DEFAULT_LOAD_FORM)
  const handoff = peekLoadEndpoint()
  if (!handoff) return { form: restored, importedFrom: null }
  // Same rule as an in-page import: an untouched blank row is replaced, not kept
  // above the thing that just arrived.
  const kept = restored.endpoints.filter((e) => !isBlankEndpoint(e))
  return {
    form: { ...restored, endpoints: [...kept, handoff] },
    importedFrom: kept.length,
  }
}

/** `Key: Value` lines → a headers object. Blank and malformed lines are dropped. */
function parseHeaderText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function toLoadInput(form: LoadForm): LoadTestInput {
  return {
    name: form.name,
    vus: form.vus,
    duration: form.duration,
    rampUp: form.rampUp,
    sleepSeconds: form.sleepSeconds,
    thresholdP95Ms: form.thresholdP95Ms,
    thresholdErrorRate: form.thresholdErrorRate,
    insecureSkipTLSVerify: form.insecureSkipTLSVerify,
    endpoints: form.endpoints.map((e) => ({
      name: e.name,
      method: e.method,
      url: e.url,
      headers: parseHeaderText(e.headerText),
      body: e.body,
    })),
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function EndpointEditor({
  endpoint,
  index,
  canRemove,
  defaultExpanded,
  onChange,
  onRemove,
}: {
  endpoint: EndpointForm
  index: number
  canRemove: boolean
  /** Open on mount — true for the first card, and for anything just imported. */
  defaultExpanded: boolean
  onChange: (next: EndpointForm) => void
  onRemove: () => void
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const hasBody = !['GET', 'HEAD'].includes(endpoint.method)
  const headerCount = Object.keys(parseHeaderText(endpoint.headerText)).length
  // Imported endpoints can still hold {{variables}}. Saying so on the row matters
  // more than the import toast did: the form is restored from localStorage, so this
  // is read long after the import, and a raw `{{token}}` in a URL otherwise looks
  // like a mistake rather than something the server fills in at run start.
  const vars = varsIn(endpoint)

  return (
    <div className="rounded-2xl border border-border/60 bg-card">
      <div className="flex items-center gap-2 p-2.5">
        <Select
          value={endpoint.method}
          onValueChange={(method) => onChange({ ...endpoint, method })}
        >
          <SelectTrigger className="h-9 w-[110px] shrink-0 rounded-xl font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {METHODS.map((m) => (
              <SelectItem key={m} value={m} className="font-mono text-xs">
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={endpoint.url}
          onChange={(e) => onChange({ ...endpoint, url: e.target.value })}
          placeholder="https://staging.example.com/api/orders"
          className="h-9 flex-1 rounded-xl font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          className="h-9 shrink-0 rounded-full text-xs"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {headerCount > 0 ? `${headerCount} header${headerCount === 1 ? '' : 's'}` : 'Options'}
        </Button>
        {canRemove && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRemove}
            aria-label={`Remove endpoint ${index + 1}`}
            className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
      {vars.length > 0 && (
        <p className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
          Uses{' '}
          <span className="font-mono text-foreground">
            {vars.map((v) => `{{${v}}}`).join(', ')}
          </span>{' '}
          — resolved when the run starts, from the active API Testing environment. Secrets
          are never sent to this page.
        </p>
      )}
      {expanded && (
        <div className="space-y-3 border-t border-border/60 p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Label (optional)</Label>
            <Input
              value={endpoint.name}
              onChange={(e) => onChange({ ...endpoint, name: e.target.value })}
              placeholder="Order list"
              className="h-9 rounded-xl text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              How this endpoint is named in the report. Defaults to its method and path.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Headers — one per line, `Key: Value`</Label>
            <Textarea
              value={endpoint.headerText}
              onChange={(e) => onChange({ ...endpoint, headerText: e.target.value })}
              placeholder={'Authorization: Bearer …\nContent-Type: application/json'}
              rows={3}
              className="rounded-xl font-mono text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              Sent to k6 through the environment — they are never written into the generated
              script or stored on disk.
            </p>
          </div>
          {hasBody && (
            <div className="space-y-1.5">
              <Label className="text-xs">Request body</Label>
              <Textarea
                value={endpoint.body}
                onChange={(e) => onChange({ ...endpoint, body: e.target.value })}
                placeholder='{"page":1}'
                rows={3}
                className="rounded-xl font-mono text-xs"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function LoadTestReport({ job, result }: { job: PerfJob; result: LoadTestResult }) {
  const cell = 'px-3 py-2 align-middle'
  const assessment = useMemo(
    () => assessLoadTest(result, job.loadConfig?.thresholdP95Ms ?? 0),
    [result, job.loadConfig?.thresholdP95Ms],
  )
  const extra = useMemo(() => loadExtras(result), [result])
  const seconds = result.durationMs > 0 ? result.durationMs / 1000 : 0
  return (
    <div className="space-y-5">
      <AssessmentCard assessment={assessment} job={job} />
      <div
        className={cn(
          'flex items-start gap-3 rounded-2xl border px-4 py-3',
          result.thresholdsPassed
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : 'border-destructive/30 bg-destructive/5',
        )}
      >
        {result.thresholdsPassed ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        )}
        <div className="min-w-0">
          <p
            className={cn(
              'text-sm font-medium',
              result.thresholdsPassed ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive',
            )}
          >
            {result.thresholdsPassed ? 'All thresholds passed' : 'A threshold was crossed'}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {result.requests.toLocaleString()} requests over {ms(result.durationMs)} ·{' '}
            {result.checksPassed.toLocaleString()} checks passed
            {result.checksFailed > 0 && `, ${result.checksFailed.toLocaleString()} failed`}
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label="p95 response"
          value={ms(result.overall.p95)}
          hint="95% of calls were faster"
          tone={result.thresholdsPassed ? 'good' : 'bad'}
          icon={Timer}
        />
        <StatTile label="Median" value={ms(result.overall.med)} hint={`avg ${ms(result.overall.avg)}`} />
        <StatTile label="Slowest" value={ms(result.overall.max)} hint={`p99 ${ms(result.overall.p99)}`} />
        <StatTile
          label="Throughput"
          value={`${result.requestsPerSecond.toFixed(1)}/s`}
          // The headline is the run average; the peak comes from the busiest
          // sampled slice. Both are named, so neither can be read as the other.
          hint={extra.peakRps > 0 ? `average · peak ${extra.peakRps.toFixed(1)}/s` : 'requests per second'}
          icon={Zap}
        />
        <StatTile
          label="Errors"
          value={pct(result.failRate)}
          hint={`${result.failedRequests.toLocaleString()} of ${result.requests.toLocaleString()} requests`}
          tone={result.failRate > 0 ? 'bad' : 'good'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Stability over the run"
          value={extra.drift ? `${extra.drift.ratio.toFixed(1)}×` : '—'}
          hint={
            extra.drift
              ? `p95 ${ms(extra.drift.earlyP95)} → ${ms(extra.drift.lateP95)} while the load was held`
              : 'too short to compare start with end'
          }
          tone={extra.drift ? (extra.drift.ratio >= 2 ? 'bad' : extra.drift.ratio >= 1.3 ? 'warn' : 'good') : 'neutral'}
          icon={TrendingUp}
        />
        <StatTile
          label="Server think-time"
          value={ms(result.phases?.waiting.avg ?? result.waiting.avg)}
          hint={extra.serverShare > 0 ? `${pct(extra.serverShare)} of the average response` : 'time to first byte'}
        />
        <StatTile
          label="Iterations"
          value={result.iterations.toLocaleString()}
          hint={
            result.droppedIterations > 0
              ? `${result.droppedIterations.toLocaleString()} dropped — the generator ran short`
              : `${ms(result.iterationDuration.avg)} each · up to ${result.vusMax || '?'} VUs`
          }
          tone={result.droppedIterations > 0 ? 'bad' : 'neutral'}
        />
        <StatTile
          label="Data received"
          value={bytes(result.dataReceived)}
          hint={extra.bytesPerSecond > 0 ? `${bytes(extra.bytesPerSecond)}/s · ${bytes(result.dataSent)} sent` : `${bytes(result.dataSent)} sent`}
        />
      </div>

      <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4">
        <Chart svg={loadPercentileChart(result, job.loadConfig?.thresholdP95Ms ?? 0)} />
        <Chart svg={loadLatencyChart(result, job.loadConfig?.thresholdP95Ms ?? 0)} />
        <Chart svg={loadPhaseChart(result)} />
        <Chart svg={loadEndpointChart(result)} />
        <Chart svg={loadVolumeChart(result)} />
      </div>

      {(result.buckets?.length ?? 0) >= 2 && (
        <div className="space-y-4 rounded-2xl border border-border/60 bg-card p-4">
          <Chart svg={loadOverTimeChart(result, job.loadConfig?.thresholdP95Ms ?? 0)} />
          <Chart svg={loadThroughputChart(result)} />
          <Chart svg={loadConcurrencyChart(result)} />
          <Chart svg={loadErrorsOverTimeChart(result)} />
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium">Per endpoint</p>
        <div className="overflow-x-auto rounded-2xl border border-border/60">
          <table className="w-full min-w-[980px] border-collapse text-left text-xs">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className={cn(cell, 'font-medium')}>Endpoint</th>
                <th className={cn(cell, 'w-20 text-right font-medium')}>Calls</th>
                <th className={cn(cell, 'w-20 text-right font-medium')}>Req/s</th>
                <th className={cn(cell, 'w-16 text-right font-medium')}>OK</th>
                <th className={cn(cell, 'w-20 text-right font-medium')}>Failed</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>Avg</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>p90</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>p95</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>p99</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>Slowest</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>TTFB</th>
                <th className={cn(cell, 'w-24 text-right font-medium')}>Size</th>
              </tr>
            </thead>
            <tbody>
              {result.endpoints.map((e) => (
                <tr key={`${e.method} ${e.url}`} className="border-t border-border/60">
                  <td className={cell}>
                    <div className="flex min-w-0 items-center gap-2">
                      <MethodPill method={e.method} />
                      <span className="min-w-0 truncate" title={e.url}>
                        {e.name}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {hostOf(e.url)}
                      {shortUrl(e.url)}
                    </div>
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums')}>
                    {e.calls.toLocaleString()}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {seconds > 0 ? (e.calls / seconds).toFixed(1) : '—'}
                  </td>
                  <td
                    className={cn(
                      cell,
                      'text-right font-mono tabular-nums',
                      e.okRate < 1 && 'font-semibold text-destructive',
                    )}
                  >
                    {pct(e.okRate)}
                  </td>
                  <td
                    className={cn(
                      cell,
                      'text-right font-mono tabular-nums',
                      e.okRate < 1 ? 'font-semibold text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    {Math.round(e.calls * (1 - e.okRate)).toLocaleString()}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums')}>{ms(e.duration.avg)}</td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {ms(e.duration.p90)}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums font-semibold')}>
                    {ms(e.duration.p95)}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {ms(e.duration.p99)}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums')}>{ms(e.duration.max)}</td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {ms(e.waiting.avg)}
                  </td>
                  <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                    {bytes(e.avgBytes)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted-foreground">
          TTFB is how long the server took before the first byte arrived — the time spent producing
          the data, as opposed to transferring it.
        </p>
      </div>

      {result.phases && (
        <div className="space-y-2">
          <p className="text-sm font-medium">Where the time goes</p>
          <div className="overflow-x-auto rounded-2xl border border-border/60">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th className={cn(cell, 'font-medium')}>Phase</th>
                  <th className={cn(cell, 'w-24 text-right font-medium')}>Average</th>
                  <th className={cn(cell, 'w-20 text-right font-medium')}>Share</th>
                  <th className={cn(cell, 'font-medium')}>What it means</th>
                </tr>
              </thead>
              <tbody>
                {phaseRows(result).map((row) => (
                  <tr key={row.label} className="border-t border-border/60">
                    <td className={cell}>{row.label}</td>
                    <td className={cn(cell, 'text-right font-mono tabular-nums')}>{ms(row.value)}</td>
                    <td className={cn(cell, 'text-right font-mono tabular-nums text-muted-foreground')}>
                      {pct(row.share)}
                    </td>
                    <td className={cn(cell, 'text-muted-foreground')}>{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* The limits of the measurement travel WITH the numbers. Every one of these
          has been read the wrong way off a real report, and a footnote in a wiki
          beside the report is a footnote nobody opens. */}
      <details className="rounded-2xl border border-border/60 bg-muted/40 px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium">How to read these numbers</summary>
        <ul className="mt-2 space-y-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {MEASUREMENT_NOTES.map((note) => (
            <li key={note}>{note.replace(/\*\*/g, '')}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** The request lifecycle, as rows — the accessible view of `loadPhaseChart`. */
function phaseRows(
  result: LoadTestResult,
): { label: string; value: number; share: number; meaning: string }[] {
  const p = result.phases
  if (!p) return []
  const total = result.overall.avg || 1
  const setup = p.connecting.avg + p.tlsHandshaking.avg
  return [
    { label: 'Waiting on the server', value: p.waiting.avg, meaning: 'the server producing the response' },
    { label: 'Receiving the response', value: p.receiving.avg, meaning: 'payload size and the network' },
    { label: 'Sending the request', value: p.sending.avg, meaning: 'request body upload' },
    { label: 'Connect + TLS', value: setup, meaning: 'connections not being reused' },
    { label: 'Blocked (client)', value: p.blocked.avg, meaning: 'the load generator queueing against itself' },
  ].map((r) => ({ ...r, share: r.value / total }))
}

// ------------------------------------------------------------------ the page

export default function PerformancePage() {
  const { activeProjectId, activeProject } = useProjects()

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Gauge className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Performance</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <Gauge className="size-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to run performance tests.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Keyed by project so switching projects REMOUNTS the workbench. Every piece of
  // per-project state (the two forms, which job each tab is showing) then comes
  // from a lazy initializer that reads localStorage once, instead of an effect
  // that has to notice the project changed and overwrite state after the fact.
  return (
    <PerformanceWorkbench
      key={activeProjectId}
      activeProjectId={activeProjectId}
      activeProject={activeProject ?? null}
    />
  )
}

function PerformanceWorkbench({
  activeProjectId,
  activeProject,
}: {
  activeProjectId: string
  activeProject: Project | null
}) {
  const queryClient = useQueryClient()

  // The tab lives in the URL (`?tab=page` / `?tab=load`) the way `/settings` does,
  // so a reload lands where you were, and a link can point at one of the two tools
  // instead of at "Performance, now go find the right tab". `replace` keeps the
  // back button meaning "the page before this one", not "the other tab".
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: PerfJobKind = searchParams.get('tab') === 'load' ? 'load' : 'page'

  function setTab(value: string): void {
    if (value !== 'page' && value !== 'load') return
    const next = new URLSearchParams(searchParams)
    next.set('tab', value)
    setSearchParams(next, { replace: true })
  }

  const { data: availability } = useQuery({
    queryKey: ['perf-available'],
    queryFn: getPerfAvailable,
    staleTime: 30_000,
  })

  const { data: jobList } = useQuery({
    queryKey: ['perf-jobs', activeProjectId],
    queryFn: () => listPerfJobs(activeProjectId as string),
    enabled: !!activeProjectId,
    refetchInterval: 5000,
  })
  const jobs = jobList?.jobs ?? []

  // ---- active job per tab, remembered so a reload reconnects to a running one
  const [activeIds, setActiveIds] = useState<Record<PerfJobKind, string | null>>(() => ({
    page: readStore(activeJobKey('page', activeProjectId)),
    load: readStore(activeJobKey('load', activeProjectId)),
  }))

  function selectJob(kind: PerfJobKind, id: string | null): void {
    setActiveIds((prev) => ({ ...prev, [kind]: id }))
    if (id) writeStore(activeJobKey(kind, activeProjectId), id)
    else clearStore(activeJobKey(kind, activeProjectId))
  }

  const storedId = activeIds[tab]
  const newestOfKind = jobs.find((j) => j.kind === tab)?.id ?? null
  const { data: staleData, error: staleError } = useQuery({
    queryKey: ['perf-job', storedId],
    queryFn: () => getPerfJob(storedId as string),
    enabled: !!storedId,
    refetchInterval: (query) => (query.state.data?.job.status === 'running' ? 1200 : false),
    retry: false,
  })

  // Two ways the remembered job stops being the one to show: the server pruned it
  // (or restarted), or there was never one — in both cases fall back to this tab's
  // most recent run, so a reload lands on the last report rather than a bare form.
  const missing = !!staleError
  const activeId = (!missing && storedId) || newestOfKind
  const { data: fallbackData } = useQuery({
    queryKey: ['perf-job', activeId],
    queryFn: () => getPerfJob(activeId as string),
    enabled: !!activeId && activeId !== storedId,
    refetchInterval: (query) => (query.state.data?.job.status === 'running' ? 1200 : false),
    retry: false,
  })
  const job = (activeId === storedId ? staleData?.job : fallbackData?.job) ?? null

  // Drop the dead pointer from storage so the next mount doesn't re-request it.
  // Storage is an external system, so this is the one thing an effect should do.
  useEffect(() => {
    if (missing && storedId) clearStore(activeJobKey(tab, activeProjectId))
  }, [missing, storedId, tab, activeProjectId])

  /**
   * Delete a run. The pointer is cleared BEFORE the list refetches: leaving it
   * set means the very next poll asks for a job the server no longer has, and
   * the report area flashes an error on its way to falling back to the newest
   * run. A still-running job is stopped by the server as part of the delete.
   */
  const removeJob = useMutation({
    mutationFn: (job: PerfJob) => deletePerfJob(job.id),
    onMutate: (job) => {
      for (const kind of ['page', 'load'] as PerfJobKind[]) {
        if (activeIds[kind] === job.id) selectJob(kind, null)
      }
      queryClient.removeQueries({ queryKey: ['perf-job', job.id] })
    },
    onSuccess: (_res, job) => {
      queryClient.invalidateQueries({ queryKey: ['perf-jobs', activeProjectId] })
      toast.success(job.status === 'running' ? 'Run stopped and deleted' : 'Run deleted', {
        description: job.label,
      })
    },
    onError: (err: Error) =>
      toast.error('Could not delete the run', { description: err.message }),
  })

  // Refresh the run list as soon as a job settles.
  const settledRef = useRef<string | null>(null)
  useEffect(() => {
    if (!job || job.status === 'running') return
    if (settledRef.current === job.id) return
    settledRef.current = job.id
    queryClient.invalidateQueries({ queryKey: ['perf-jobs', activeProjectId] })
  }, [job, queryClient, activeProjectId])

  // ---- forms (persisted per project so a page reload doesn't lose the setup)
  const [pageForm, setPageForm] = useState<PageForm>(() =>
    restoreForm(PAGE_FORM_PREFIX + activeProjectId, DEFAULT_PAGE_FORM),
  )
  // Arriving from API Testing's "Load test" button: the endpoint is merged into
  // the restored form as it is BUILT, not pushed in afterwards from an effect —
  // setting state from an effect body just to seed a form is the cascading-render
  // pattern React's own lint rule exists to stop.
  const [loadForm, setLoadForm] = useState<LoadForm>(
    () => initialLoadForm(activeProjectId).form,
  )
  /** Index of the first endpoint added by the last import — those cards open. */
  const [importedFrom, setImportedFrom] = useState<number | null>(
    () => initialLoadForm(activeProjectId).importedFrom,
  )

  /**
   * Finish the handoff, now that the form holding it exists: drop the parked
   * copy, persist the merged form, and say what came across. Every line here is
   * a write to something OUTSIDE React — session storage, local storage, a toast
   * — which is what an effect is for; no state is set. The peek guard makes it a
   * no-op on the second pass of a dev double-mount, and on every later render.
   */
  useEffect(() => {
    const handoff = peekLoadEndpoint()
    if (!handoff) return
    clearLoadHandoff()
    writeStore(LOAD_FORM_PREFIX + activeProjectId, JSON.stringify(loadForm))
    const headerCount = Object.keys(parseHeaderText(handoff.headerText)).length
    const vars = varsIn(handoff)
    toast.success(`Added “${handoff.name}” from API Testing`, {
      description: [
        headerCount
          ? `${headerCount} header${headerCount === 1 ? '' : 's'} and the body came across.`
          : 'No headers on that request.',
        vars.length
          ? `${vars.map((n) => `{{${n}}}`).join(', ')} will be resolved when the run starts.`
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, on arrival
  }, [])
  const [curlOpen, setCurlOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [headed, setHeaded] = useState(() => readStore(HEADED_KEY) === '1')
  // A sign-in window holds the Chrome profile, so an audit cannot start while it
  // is open. The server refuses too; this just stops the button from lying.
  const [signInOpen, setSignInOpen] = useState(false)

  function updatePageForm(next: PageForm): void {
    setPageForm(next)
    writeStore(PAGE_FORM_PREFIX + activeProjectId, JSON.stringify(next))
  }
  /**
   * Append imported endpoints, replacing a single untouched blank one rather than
   * leaving it above the import — the form starts with a blank endpoint, so without
   * this every import produces an empty first row the engineer has to delete.
   */
  function addEndpoints(imported: EndpointForm[]): void {
    if (!imported.length) return
    const existing = loadForm.endpoints.filter((e) => !isBlankEndpoint(e))
    updateLoadForm({ ...loadForm, endpoints: [...existing, ...imported] })
    // Open what just arrived. Cards past the first are collapsed by default, so an
    // import that appended below an existing endpoint looked like it had brought
    // nothing across — the headers and body were there, just folded away.
    setImportedFrom(existing.length)

    // Say what came WITH the URL. Headers are the part an engineer doubts — an
    // endpoint that needs a bearer token is worthless without them, and a count
    // is the cheapest proof that they made the trip.
    const headerCount = imported.reduce(
      (n, e) => n + Object.keys(parseHeaderText(e.headerText)).length,
      0,
    )
    const names = [...new Set(imported.filter(hasVars).flatMap(varsIn))]
    const lines = [
      headerCount
        ? `${headerCount} header${headerCount === 1 ? '' : 's'} and the body came across.`
        : '',
      names.length
        ? `${names.map((n) => `{{${n}}}`).join(', ')} will be resolved when the run starts, from the active API Testing environment.`
        : '',
    ].filter(Boolean)
    toast.success(`Added ${imported.length} endpoint${imported.length === 1 ? '' : 's'}`, {
      description: lines.length ? lines.join(' ') : undefined,
    })
  }

  function updateLoadForm(next: LoadForm): void {
    setLoadForm(next)
    // The saved copy carries headers/bodies, which can hold a token. It stays in
    // this browser's localStorage and never goes to the server or to disk.
    writeStore(LOAD_FORM_PREFIX + activeProjectId, JSON.stringify(next))
  }

  // ---- mutations
  const startAudit = useMutation({
    mutationFn: () =>
      startPageAudit(activeProjectId as string, {
        url: pageForm.url.trim(),
        runs: pageForm.runs,
        settleMs: pageForm.settleMs,
        headed,
        useProfile: pageForm.useProfile,
      }),
    onSuccess: ({ job: started }) => {
      selectJob('page', started.id)
      queryClient.invalidateQueries({ queryKey: ['perf-jobs', activeProjectId] })
    },
    onError: (err: Error) => toast.error('Could not start the audit', { description: err.message }),
  })

  const startLoad = useMutation({
    mutationFn: () => startLoadTest(activeProjectId as string, toLoadInput(loadForm)),
    onSuccess: ({ job: started }) => {
      selectJob('load', started.id)
      queryClient.invalidateQueries({ queryKey: ['perf-jobs', activeProjectId] })
    },
    onError: (err: Error) => toast.error('Could not start the load test', { description: err.message }),
  })

  const stopJob = useMutation({
    mutationFn: (id: string) => cancelPerfJob(id),
    onSuccess: ({ job: stopped }) => {
      queryClient.setQueryData(['perf-job', stopped.id], { job: stopped })
      queryClient.invalidateQueries({ queryKey: ['perf-jobs', activeProjectId] })
    },
    onError: (err: Error) => toast.error('Could not stop the run', { description: err.message }),
  })

  // ---- generated-script dialog
  const [scriptOpen, setScriptOpen] = useState(false)
  const [script, setScript] = useState('')
  const showScript = useMutation({
    mutationFn: () => previewK6Script(toLoadInput(loadForm)),
    onSuccess: ({ script: text }) => {
      setScript(text)
      setScriptOpen(true)
    },
    onError: (err: Error) => toast.error('Could not build the script', { description: err.message }),
  })

  const k6 = availability?.k6
  const browserOk = availability?.browser.ok !== false
  const running = job?.status === 'running'
  const pageJobs = jobs.filter((j) => j.kind === 'page')
  const loadJobs = jobs.filter((j) => j.kind === 'load')

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Gauge className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Performance</h1>
            <p className="text-sm text-muted-foreground">
              Measure how long a page takes to load, whether an API is being called more times than
              it should be, and how fast the data comes back under load — powered by a real browser
              and by k6.
            </p>
          </div>
        </div>
        {/* The shell's theme toggle and bell float over the top-right corner of every
            page, so the k6 status lives down here where it can't be clipped. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-2.5 text-xs text-muted-foreground">
          <Globe className="size-3.5 shrink-0" />
          <span className="min-w-0">
            Runs against whatever URL you enter — nothing is written into{' '}
            <span className="font-medium text-foreground">{activeProject?.name ?? 'your project'}</span>
            ; reports live on this page and in the run history below.
          </span>
          {k6 && (
            <span
              className={cn(
                'ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 font-medium',
                k6.ok
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
              )}
              title={k6.version ?? k6.error}
            >
              {k6.ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
              {k6.ok ? (k6.version?.split(' ').slice(0, 2).join(' ') ?? 'k6') : 'k6 not installed'}
            </span>
          )}
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <TabsList className="rounded-full">
          <TabsTrigger value="page" className="gap-1.5">
            <Timer className="size-3.5" />
            Page load
          </TabsTrigger>
          <TabsTrigger value="load" className="gap-1.5">
            <Rocket className="size-3.5" />
            API load test
          </TabsTrigger>
        </TabsList>

        {/* ------------------------------------------------ page load */}
        <TabsContent value="page" className="space-y-5">
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-4 p-5">
              <div className="space-y-1.5">
                <Label htmlFor="perf-url">Page URL</Label>
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="perf-url"
                    value={pageForm.url}
                    onChange={(e) => updatePageForm({ ...pageForm, url: e.target.value })}
                    placeholder="https://staging.example.com/orders"
                    className="h-10 min-w-[260px] flex-1 rounded-xl font-mono text-sm"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && pageForm.url.trim() && !running && !signInOpen)
                        startAudit.mutate()
                    }}
                  />
                  <Button
                    onClick={() => startAudit.mutate()}
                    disabled={
                      !pageForm.url.trim() ||
                      startAudit.isPending ||
                      running ||
                      !browserOk ||
                      (signInOpen && pageForm.useProfile)
                    }
                    className="h-10 rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    {startAudit.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Timer className="size-4" />
                    )}
                    Measure
                  </Button>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Loads</Label>
                  <Select
                    value={String(pageForm.runs)}
                    onValueChange={(v) => updatePageForm({ ...pageForm, runs: Number(v) })}
                  >
                    <SelectTrigger className="h-9 rounded-xl text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1, 2, 3, 5, 10].map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">
                          {n} load{n === 1 ? '' : 's'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Results are averaged.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Watch after load</Label>
                  <Select
                    value={String(pageForm.settleMs)}
                    onValueChange={(v) => updatePageForm({ ...pageForm, settleMs: Number(v) })}
                  >
                    <SelectTrigger className="h-9 rounded-xl text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 1000, 3000, 5000, 10000].map((n) => (
                        <SelectItem key={n} value={String(n)} className="text-xs">
                          {n === 0 ? 'Stop at load' : `${n / 1000}s`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-[11px] text-muted-foreground">Catches late API calls.</p>
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5">
                  <Checkbox
                    size="sm"
                    className="mt-0.5"
                    checked={pageForm.useProfile}
                    onCheckedChange={(v) => updatePageForm({ ...pageForm, useProfile: v })}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Use the logged-in profile</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Reuses the QC browser's session so a page behind a login is reachable.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5">
                  <Checkbox
                    size="sm"
                    className="mt-0.5"
                    checked={headed}
                    onCheckedChange={(v) => {
                      setHeaded(v)
                      writeStore(HEADED_KEY, v ? '1' : '0')
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Show the browser</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Watch the loads happen instead of running them hidden.
                    </span>
                  </span>
                </label>
              </div>

              {!browserOk && (
                <div className="flex items-start gap-2.5 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <span>
                    A browser audit can't run here — {availability?.browser.error ?? 'Chrome was not found'}.
                  </span>
                </div>
              )}
            </CardContent>
          </Card>

          <SignInPanel pageUrl={pageForm.url} onBusyChange={setSignInOpen} />

          {tab === 'page' && job && (
            <Card className="rounded-3xl border-border/60 shadow-none">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill status={job.status} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {job.label}
                  </span>
                  {running && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => stopJob.mutate(job.id)}
                      disabled={stopJob.isPending}
                      className="rounded-full"
                    >
                      <Ban className="size-3.5" />
                      Stop
                    </Button>
                  )}
                </div>
                {job.error && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                    <XCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="break-words">{job.error}</span>
                  </div>
                )}
                {job.pageResult && <PageAuditReport job={job} result={job.pageResult} />}
                <JobLog job={job} />
              </CardContent>
            </Card>
          )}

          <RecentRuns
            jobs={pageJobs}
            activeId={tab === 'page' ? activeId : activeIds.page}
            onPick={(id) => selectJob('page', id)}
            onDelete={(j) => removeJob.mutate(j)}
            deletingId={removeJob.isPending ? (removeJob.variables?.id ?? null) : null}
          />
        </TabsContent>

        {/* ------------------------------------------------ k6 load test */}
        <TabsContent value="load" className="space-y-5">
          {k6 && !k6.ok && (
            <Card className="rounded-3xl border-amber-500/30 bg-amber-500/5 shadow-none">
              <CardContent className="space-y-2.5 p-5">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium text-amber-700 dark:text-amber-400">
                      k6 is not installed on this machine
                    </p>
                    <p className="text-xs text-muted-foreground">
                      The portal runs load tests with{' '}
                      <a
                        href="https://grafana.com/docs/k6/latest/set-up/install-k6/"
                        target="_blank"
                        rel="noreferrer"
                        className="underline underline-offset-2"
                      >
                        Grafana k6
                      </a>
                      . Install it, then reload this page.
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-xs">{k6.installHint}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 shrink-0 rounded-full text-xs"
                    onClick={() => {
                      void navigator.clipboard.writeText(k6.installHint)
                      toast.success('Install command copied')
                    }}
                  >
                    <Copy className="size-3.5" />
                    Copy
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-5 p-5">
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Test name</Label>
                  <Input
                    value={loadForm.name}
                    onChange={(e) => updateLoadForm({ ...loadForm, name: e.target.value })}
                    className="h-9 rounded-xl text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Virtual users</Label>
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    value={loadForm.vus}
                    onChange={(e) =>
                      updateLoadForm({ ...loadForm, vus: Math.max(1, Number(e.target.value) || 1) })
                    }
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">Concurrent users, 1–200.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Duration</Label>
                  <Input
                    value={loadForm.duration}
                    onChange={(e) => updateLoadForm({ ...loadForm, duration: e.target.value })}
                    placeholder="30s"
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">e.g. 30s, 2m. Max 30m.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Ramp-up (optional)</Label>
                  <Input
                    value={loadForm.rampUp}
                    onChange={(e) => updateLoadForm({ ...loadForm, rampUp: e.target.value })}
                    placeholder="10s"
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">Grow to full load gradually.</p>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="space-y-1.5">
                  <Label className="text-xs">Think time (s)</Label>
                  <Input
                    type="number"
                    min={0}
                    step={0.5}
                    value={loadForm.sleepSeconds}
                    onChange={(e) =>
                      updateLoadForm({
                        ...loadForm,
                        sleepSeconds: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">Pause between calls.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fail if p95 over (ms)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={loadForm.thresholdP95Ms}
                    onChange={(e) =>
                      updateLoadForm({
                        ...loadForm,
                        thresholdP95Ms: Math.max(0, Number(e.target.value) || 0),
                      })
                    }
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">0 = no threshold.</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Fail if errors over (%)</Label>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    value={Math.round(loadForm.thresholdErrorRate * 1000) / 10}
                    onChange={(e) =>
                      updateLoadForm({
                        ...loadForm,
                        thresholdErrorRate: Math.min(1, Math.max(0, Number(e.target.value) || 0) / 100),
                      })
                    }
                    className="h-9 rounded-xl font-mono text-xs"
                  />
                </div>
                <label className="flex cursor-pointer items-start gap-2.5 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5">
                  <Checkbox
                    size="sm"
                    className="mt-0.5"
                    checked={loadForm.insecureSkipTLSVerify}
                    onCheckedChange={(v) =>
                      updateLoadForm({ ...loadForm, insecureSkipTLSVerify: v })
                    }
                  />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium">Allow self-signed certs</span>
                    <span className="block text-[11px] text-muted-foreground">
                      Most staging environments need this.
                    </span>
                  </span>
                </label>
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <Label className="text-xs">Endpoints</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                      onClick={() => setPickerOpen(true)}
                    >
                      <Zap className="size-3.5" />
                      From API Testing
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                      onClick={() => setCurlOpen(true)}
                    >
                      <TerminalSquare className="size-3.5" />
                      Paste cURL
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 rounded-full text-xs"
                      onClick={() =>
                        updateLoadForm({
                          ...loadForm,
                          endpoints: [...loadForm.endpoints, blankEndpoint()],
                        })
                      }
                    >
                      <Plus className="size-3.5" />
                      Add endpoint
                    </Button>
                  </div>
                </div>
                {loadForm.endpoints.map((e, i) => (
                  <EndpointEditor
                    key={i}
                    endpoint={e}
                    index={i}
                    canRemove={loadForm.endpoints.length > 1}
                    defaultExpanded={i === 0 || (importedFrom !== null && i >= importedFrom)}
                    onChange={(next) =>
                      updateLoadForm({
                        ...loadForm,
                        endpoints: loadForm.endpoints.map((old, j) => (j === i ? next : old)),
                      })
                    }
                    onRemove={() =>
                      updateLoadForm({
                        ...loadForm,
                        endpoints: loadForm.endpoints.filter((_, j) => j !== i),
                      })
                    }
                  />
                ))}
                <p className="text-[11px] text-muted-foreground">
                  Each virtual user calls every endpoint in order, over and over, for the whole
                  duration.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => startLoad.mutate()}
                  disabled={
                    startLoad.isPending ||
                    running ||
                    !k6?.ok ||
                    !loadForm.endpoints.some((e) => e.url.trim())
                  }
                  className="h-10 rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {startLoad.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Rocket className="size-4" />
                  )}
                  Run load test
                </Button>
                <Button
                  variant="outline"
                  onClick={() => showScript.mutate()}
                  disabled={showScript.isPending || !loadForm.endpoints.some((e) => e.url.trim())}
                  className="h-10 rounded-full"
                >
                  {showScript.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Download className="size-4" />
                  )}
                  View k6 script
                </Button>
              </div>
            </CardContent>
          </Card>

          {tab === 'load' && job && (
            <Card className="rounded-3xl border-border/60 shadow-none">
              <CardContent className="space-y-4 p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <StatusPill status={job.status} />
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {job.label}
                    {job.loadConfig && (
                      <span className="ml-2 font-mono">
                        {job.loadConfig.vus} VU · {job.loadConfig.duration}
                      </span>
                    )}
                  </span>
                  {running && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => stopJob.mutate(job.id)}
                      disabled={stopJob.isPending}
                      className="rounded-full"
                    >
                      <Ban className="size-3.5" />
                      Stop
                    </Button>
                  )}
                </div>
                {job.error && (
                  <div className="flex items-start gap-2.5 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                    <XCircle className="mt-0.5 size-4 shrink-0" />
                    <span className="break-words">{job.error}</span>
                  </div>
                )}
                {job.loadResult && <LoadTestReport job={job} result={job.loadResult} />}
                <JobLog job={job} />
              </CardContent>
            </Card>
          )}

          {/* Keyed by project: switching project is a different report entirely, and a
              remount reloads that project's saved requirements without an effect. */}
          <NfrReportPanel
                key={activeProjectId}
                projectId={activeProjectId}
                projectName={activeProject?.name}
                jobs={loadJobs}
              />

          <RecentRuns
            jobs={loadJobs}
            activeId={tab === 'load' ? activeId : activeIds.load}
            onPick={(id) => selectJob('load', id)}
            onDelete={(j) => removeJob.mutate(j)}
            deletingId={removeJob.isPending ? (removeJob.variables?.id ?? null) : null}
          />
        </TabsContent>
      </Tabs>

      <CurlImportDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        title="Add an endpoint from cURL"
        confirmLabel="Add endpoint"
        onImport={(draft) => addEndpoints([endpointFromDraft(draft)])}
      />

      <SavedRequestPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        projectId={activeProjectId}
        confirmLabel="Add endpoint"
        onPick={(requests) => addEndpoints(requests.map(endpointFromSavedRequest))}
      />

      <Dialog open={scriptOpen} onOpenChange={setScriptOpen}>
        {/* `sm:` is not optional: DialogContent's own `sm:max-w-lg` outranks a bare
            `max-w-*` at every width that matters, so this dialog was painting at
            32rem and wrapping the script. A bare override would also swallow the
            base `max-w-[calc(100%-2rem)]` that keeps it on screen on a phone. */}
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Generated k6 script</DialogTitle>
            <DialogDescription>
              This is exactly what the portal runs. Headers and request bodies are absent by
              design — they are passed to k6 through the environment, so nothing secret is written
              to disk.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[65vh] overflow-auto rounded-2xl border border-border/60 bg-muted/40 p-4 font-mono text-[11px] leading-relaxed">
            {script}
          </pre>
          <div className="flex justify-end">
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => {
                void navigator.clipboard.writeText(script)
                toast.success('Script copied')
              }}
            >
              <Copy className="size-4" />
              Copy script
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
