/**
 * `/reports` — the project's QC status in one page.
 *
 * The portal already answers "what happened on this ticket" (Tickets), "what did
 * this run find" (History), "how fast is it" (Performance). What it could not
 * answer was the question a QC engineer is actually asked at a standup: **where
 * does this project stand?** That needs the chain joined —
 * ticket -> test cases -> run -> defects — which is what
 * `server/src/reportData.ts` builds and this page renders.
 *
 * Two rules shape everything below, and both come from the data model:
 *
 * 1. **A ticket's result is its LATEST reporting run, never a sum.** Measured on
 *    a real project: one ticket had 22 runs against 331 test cases, and summing
 *    them claimed 842 cases executed — a coverage bar at 254%. The server picks
 *    the latest run that produced a `report.md`; the page never re-aggregates.
 * 2. **Blocked is not failed.** The pass rate is pass/(pass+fail); blocked and
 *    not-tested cases are shown beside it, never folded into it. A case nobody
 *    could reach is a coverage gap, and reporting it as a pass is how a gap
 *    disappears from a status report.
 *
 * Everything is derived from what is ON DISK. The page never re-queries ClickUp
 * — see the module comment in `reportData.ts` for why that is deliberate.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BarChart3,
  Bug,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ClipboardList,
  CornerDownRight,
  ExternalLink,
  FileDown,
  FileText,
  FolderOpen,
  Loader2,
  PlayCircle,
  RefreshCw,
  Repeat,
  ShieldAlert,
  Ticket as TicketIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DatePicker } from '@/components/DatePicker'
import { parseDay } from '@/lib/dates'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { exportSystemReport, getSystemReport, openReportFolder } from '@/lib/api'
import { downloadBlob, downloadText } from '@/lib/perfReport'
import { useProjects } from '@/lib/project-context'
import {
  dateTime,
  defectTitle,
  duration,
  funnelSteps,
  gradeLabel,
  num,
  pct,
  reportFileName,
  reportMarkdown,
  severityRows,
  SEVERITY_LABEL,
  shortDate,
  STAGE_LABEL,
  ticketGrade,
  verdictOf,
  type Grade,
  type Severity,
} from '@/lib/systemReport'
import { systemReportHtml } from '@/lib/systemReportHtml'
import type { ReportTicketRow, SystemReport, TicketStage } from '@/lib/types'

// Status colours follow the portal's fixed palette: emerald = ok, amber =
// warning, red = failed. Declared once here so a grade cannot be painted two
// different colours in two places on the same page.
const GRADE_CLASS: Record<Grade, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
  unknown: 'text-muted-foreground',
}
const GRADE_RAIL: Record<Grade, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500',
  unknown: 'bg-muted-foreground/30',
}
/**
 * The grade's colour as a tint OF the surface, for the verdict chip.
 * `bg-<c>-500/10` rather than `bg-<c>-50`, because a fixed light tint vanishes
 * on a dark ground and leaves a hard coloured outline around nothing.
 */
const GRADE_CHIP: Record<Grade, string> = {
  good: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  bad: 'bg-red-500/10 text-red-600 dark:text-red-400',
  unknown: 'bg-muted text-muted-foreground',
}
const GRADE_ICON: Record<Grade, typeof CheckCircle2> = {
  good: CheckCircle2,
  warn: AlertTriangle,
  bad: ShieldAlert,
  unknown: CircleHelp,
}
const SEVERITY_CLASS: Record<Severity, string> = {
  critical: 'bg-red-600',
  high: 'bg-red-500',
  medium: 'bg-amber-500',
  low: 'bg-sky-500',
  unknown: 'bg-muted-foreground/40',
}
const SEVERITY_PILL: Record<Severity, string> = {
  critical: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  high: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  low: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
  unknown: 'border-border/60 bg-muted text-muted-foreground',
}

// ------------------------------------------------------------- small elements

function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'good' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'bad'
          ? 'text-red-600 dark:text-red-400'
          : 'text-foreground'
  // A cell in the strip welded under the verdict, not a floating card of its
  // own. The six numbers ARE the verdict at a lower zoom level; drawn as six
  // separate bordered tiles they read as six unrelated facts, and the sentence
  // above them as a seventh.
  return (
    <div className="min-w-0 bg-card px-4 py-3">
      <p className={cn('text-2xl font-semibold tabular-nums tracking-tight', toneClass)}>{value}</p>
      <p className="mt-0.5 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground/80">{hint}</p>}
    </div>
  )
}

/**
 * One bar carrying every slice of a whole, plus a legend.
 *
 * Four separate bars answer "how many blocked?"; only a single stacked bar
 * answers "what SHAPE is this run?" — and on the reference project the shape is
 * the story: 64 of 123 executed cases were blocked, more than passed. Drawn as
 * four bars against a shared max that fact reads as "a longish amber bar"; drawn
 * as one bar it is half the width of the page.
 */
function StackedBar({
  parts,
  empty,
}: {
  parts: { key: string; label: string; count: number; colorClass: string; textClass?: string }[]
  empty?: string
}) {
  const total = parts.reduce((n, p) => n + p.count, 0)
  const shown = parts.filter((p) => p.count > 0)
  if (total === 0) {
    return <p className="text-xs text-muted-foreground">{empty ?? 'Nothing recorded.'}</p>
  }
  return (
    <div className="space-y-3">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {shown.map((p) => (
          <div
            key={p.key}
            className={cn('h-full transition-all duration-500', p.colorClass)}
            style={{ width: `${(p.count / total) * 100}%` }}
            title={`${p.label}: ${num(p.count)} (${pct(p.count / total)})`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {shown.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-xs">
            <span className={cn('size-2 shrink-0 rounded-full', p.colorClass)} />
            <span className="text-muted-foreground">{p.label}</span>
            <span className={cn('font-semibold tabular-nums', p.textClass)}>{num(p.count)}</span>
            <span className="tabular-nums text-muted-foreground/60">
              {pct(p.count / total)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

function Bar({
  label,
  count,
  max,
  colorClass,
  hint,
  drop,
  labelWidth = 'w-40',
}: {
  label: string
  count: number
  max: number
  colorClass: string
  hint?: string
  /** How many were LOST since the step above — the funnel's actual message. */
  drop?: number
  labelWidth?: string
}) {
  const width = max > 0 ? Math.max(count > 0 ? 2 : 0, (count / max) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      {/* The hint goes on its own line, never appended to the label: on one line
          it is the first thing the 40-unit column truncates away, which leaves
          "Crawled  Ticket pulled int…" — worse than no hint at all. */}
      <div className={cn('shrink-0 text-xs leading-tight', labelWidth)}>
        <span className="block truncate font-medium">{label}</span>
        {/* The hint wraps rather than truncating. "Ticket pulled into
            testing/tick…" is a hint that stops before it says anything, and
            adding the drop column narrowed this label further. */}
        {hint && <span className="block text-[10px] leading-tight text-muted-foreground/70">{hint}</span>}
      </div>
      <div className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-all duration-500', colorClass)}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-10 shrink-0 text-right text-xs font-semibold tabular-nums">
        {num(count)}
      </span>
      {/* The step-to-step LOSS, because a funnel's point is where it narrows and
          two bars of different length do not say "24 tickets fell out here". */}
      {drop !== undefined && (
        <span
          className={cn(
            'w-14 shrink-0 text-right text-[11px] tabular-nums',
            drop > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground/40',
          )}
          title={drop > 0 ? `${drop} did not reach this step` : 'Nothing lost at this step'}
        >
          {drop > 0 ? `−${num(drop)}` : '—'}
        </span>
      )}
    </div>
  )
}

function SectionCard({
  icon: Icon,
  title,
  blurb,
  right,
  children,
}: {
  icon: typeof BarChart3
  title: string
  blurb?: string
  right?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <Card className="rounded-3xl border-border/60 p-5 shadow-none">
      <div className="mb-4 flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
          {blurb && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{blurb}</p>}
        </div>
        {right}
      </div>
      {children}
    </Card>
  )
}

// --------------------------------------------------------------- ticket table

function TicketRow({
  row,
  projectId,
  expanded,
  onToggle,
  defects,
}: {
  row: ReportTicketRow
  projectId: string
  expanded: boolean
  onToggle: () => void
  defects: SystemReport['defects']
}) {
  const grade = ticketGrade(row)
  const open = useMutation({
    mutationFn: () => openReportFolder(projectId, 'ticket', row.folder),
    onSuccess: (res) => toast.success('Opened ticket folder', { description: res.path }),
    onError: (err) =>
      toast.error('Could not open the folder', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  return (
    <>
      <tr
        className="cursor-pointer border-t border-border/60 align-top transition-colors hover:bg-muted/50"
        onClick={onToggle}
      >
        <td className="py-2.5 pl-3 pr-2">
          <div className="flex items-start gap-2">
            <span className={cn('mt-1 h-8 w-0.5 shrink-0 rounded-full', GRADE_RAIL[grade])} />
            <ChevronDown
              className={cn(
                'mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-200',
                expanded && 'rotate-180',
              )}
            />
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <span className="font-mono">{row.displayId}</span>
                {row.parent && (
                  <span className="rounded-full border border-border/60 px-1.5 text-[10px] font-normal text-muted-foreground">
                    subtask
                  </span>
                )}
                {row.stale && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400">
                        stale
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs leading-relaxed">
                      The tracker was edited after this ticket was last crawled, so the evidence
                      below was gathered against an older description. Re-crawl it on /tickets.
                    </TooltipContent>
                  </Tooltip>
                )}
              </p>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{row.title}</p>
            </div>
          </div>
        </td>
        <td className="px-2 py-2.5 text-xs text-muted-foreground">{row.status || '—'}</td>
        <td className={cn('px-2 py-2.5 text-xs font-medium', GRADE_CLASS[grade])}>
          {STAGE_LABEL[row.stage]}
        </td>
        <td className="px-2 py-2.5 text-right text-xs tabular-nums">{row.testcaseCount || '—'}</td>
        {/* Four numeric columns, or ONE sentence.
            23 of the 34 tickets on the reference project have never been run,
            and each was drawing four em-dashes — a green one under Pass, a red
            one under Fail, an amber one under Blocked. Colour on a dash is
            colour that means nothing, and 92 of them turned the table into
            texture. A ticket with no result says so once, in words. */}
        {row.exec.total === 0 ? (
          <td colSpan={4} className="px-2 py-2.5 text-center text-[11px] text-muted-foreground/70">
            {row.runCount === 0 ? 'never run' : 'ran, but produced no report'}
          </td>
        ) : (
          <>
            <td className="px-2 py-2.5 text-right text-xs tabular-nums">
              <Num value={row.exec.pass} tone="text-emerald-600 dark:text-emerald-400" />
            </td>
            <td className="px-2 py-2.5 text-right text-xs tabular-nums">
              <Num value={row.exec.fail} tone="text-red-600 dark:text-red-400" />
            </td>
            <td className="px-2 py-2.5 text-right text-xs tabular-nums">
              <Num value={row.exec.blocked} tone="text-amber-600 dark:text-amber-400" />
            </td>
            <td className="px-2 py-2.5 text-right text-xs font-semibold tabular-nums">
              <Num value={row.defectCount} tone="text-red-600 dark:text-red-400" />
            </td>
          </>
        )}
        <td className="py-2.5 pl-2 pr-3 text-right text-xs text-muted-foreground">
          {shortDate(row.lastRunAt)}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-border/40 bg-muted/30">
          <td colSpan={9} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-1.5 text-xs">
                <p className="font-semibold">Ticket</p>
                <Detail label="List">{row.listName || '—'}</Detail>
                <Detail label="Priority">{row.priority || '—'}</Detail>
                <Detail label="Assignees">{row.assignees.join(', ') || '—'}</Detail>
                <Detail label="Due">{shortDate(row.dueDate)}</Detail>
                <Detail label="Crawled">{dateTime(row.crawledAt)}</Detail>
                <Detail label="Comments">{num(row.commentCount)}</Detail>
              </div>
              <div className="space-y-1.5 text-xs">
                <p className="font-semibold">Test cases &amp; runs</p>
                <Detail label="Versions">{num(row.testcaseVersions)}</Detail>
                <Detail label="Latest file">{row.latestTestcaseFile ?? 'none'}</Detail>
                <Detail label="Cases in latest">{num(row.testcaseCount)}</Detail>
                <Detail label="Runs">{num(row.runCount)}</Detail>
                <Detail label="Pass rate">{pct(row.passRate, 1)}</Detail>
                <Detail label="Coverage">
                  {row.coverage == null ? '—' : pct(row.coverage, 0)}
                  {row.coverage != null && (
                    <span className="ml-1 text-muted-foreground/70">
                      of the {num(row.testcaseCount)} written cases were judged
                    </span>
                  )}
                </Detail>
              </div>
              <div className="space-y-2 text-xs">
                <p className="font-semibold">
                  Open defects {defects.length > 0 && `(${defects.length})`}
                </p>
                {defects.length === 0 ? (
                  <p className="text-muted-foreground">
                    {row.runCount === 0
                      ? 'Never run.'
                      : 'None in the latest reporting run.'}
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {defects.map((d) => (
                      <li key={d.id} className="flex items-start gap-1.5">
                        <span
                          className={cn(
                            'mt-0.5 shrink-0 rounded-full border px-1.5 text-[10px] font-medium',
                            SEVERITY_PILL[d.severity],
                          )}
                        >
                          {SEVERITY_LABEL[d.severity]}
                        </span>
                        <span className="min-w-0 leading-snug">{defectTitle(d.title)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 rounded-full text-[11px] transition-all duration-200 active:scale-[0.98]"
                    disabled={open.isPending}
                    onClick={(e) => {
                      e.stopPropagation()
                      open.mutate()
                    }}
                  >
                    {open.isPending ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <FolderOpen className="size-3" />
                    )}
                    Open folder
                  </Button>
                  {row.latestReportRunId && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-full text-[11px] transition-all duration-200 active:scale-[0.98]"
                    >
                      <Link
                        to={`/history/${row.latestReportRunId}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FileText className="size-3" />
                        Latest report
                      </Link>
                    </Button>
                  )}
                  {row.url && (
                    <Button
                      asChild
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-full text-[11px] transition-all duration-200 active:scale-[0.98]"
                    >
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <ExternalLink className="size-3" />
                        Tracker
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * A count in a table cell — coloured only when it is actually a count.
 * A zero is a dash, and a dash is never green: the colour is the meaning of the
 * NUMBER, and painting the absence of one is how a table full of nothing ends
 * up looking like a table full of results.
 */
function Num({ value, tone }: { value: number; tone: string }) {
  if (!value) return <span className="text-muted-foreground/40">—</span>
  return <span className={tone}>{num(value)}</span>
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="flex gap-1.5">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </p>
  )
}

// ------------------------------------------------------------------- the page

const STAGE_FILTERS: { key: TicketStage | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'defects', label: 'Defects open' },
  { key: 'partial', label: 'Partly executed' },
  { key: 'planned', label: 'Test cases ready' },
  { key: 'crawled', label: 'Crawled only' },
  { key: 'clean', label: 'Passed clean' },
]

export default function ReportsPage() {
  const { activeProjectId, activeProject } = useProjects()
  const queryClient = useQueryClient()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [stage, setStage] = useState<TicketStage | 'all'>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null)

  const {
    data: report,
    isLoading,
    isFetching,
    isError,
    error,
  } = useQuery({
    queryKey: ['system-report', activeProjectId, from, to],
    queryFn: () => getSystemReport(activeProjectId as string, { from, to }),
    enabled: !!activeProjectId,
    staleTime: 60_000,
  })

  // Defects, indexed by the ticket folder they belong to, so a row expansion is
  // a map lookup rather than a scan of the whole defect list per render.
  const defectsByTicket = useMemo(() => {
    const map = new Map<string, SystemReport['defects']>()
    for (const d of report?.defects ?? []) {
      if (!d.ticketKey) continue
      const list = map.get(d.ticketKey)
      if (list) list.push(d)
      else map.set(d.ticketKey, [d])
    }
    return map
  }, [report])

  const tickets = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (report?.tickets ?? []).filter((t) => {
      if (stage !== 'all' && t.stage !== stage) return false
      if (!q) return true
      return (
        t.displayId.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.status.toLowerCase().includes(q)
      )
    })
  }, [report, stage, search])

  async function exportFile(format: 'pdf' | 'docx') {
    if (!report) return
    setExporting(format)
    const name = reportFileName(report)
    try {
      const blob = await exportSystemReport(
        format,
        systemReportHtml(report),
        name,
        `QC status — ${report.projectName} — generated ${shortDate(report.generatedAt)}`,
      )
      downloadBlob(`${name}.${format}`, blob)
      // App mode has no browser toolbar and therefore no download popup, so the
      // toast has to name the file or the button reads as doing nothing.
      toast.success(format === 'pdf' ? 'PDF saved' : 'Word document saved', {
        description: `${name}.${format} — in your Downloads folder`,
      })
    } catch (err) {
      toast.error(`Could not build the ${format === 'pdf' ? 'PDF' : 'Word file'}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setExporting(null)
    }
  }

  function exportMarkdown() {
    if (!report) return
    const name = `${reportFileName(report)}.md`
    downloadText(name, reportMarkdown(report), 'text/markdown')
    toast.success('Markdown saved', { description: `${name} — in your Downloads folder` })
  }

  if (!activeProjectId) {
    return (
      <div className="p-6">
        <p className="text-sm text-muted-foreground">
          Pick a project in the sidebar to see its QC status.
        </p>
      </div>
    )
  }

  const verdict = report ? verdictOf(report) : null
  const steps = report ? funnelSteps(report) : []
  const maxStep = Math.max(1, ...steps.map((s) => s.count))
  const sev = report ? severityRows(report.defectsBySeverity) : []
  const maxSev = Math.max(1, ...sev.map((s) => s.count))
  const maxStatus = Math.max(1, ...(report?.statusBuckets ?? []).map((s) => s.count))
  // Judged = pass + fail. The pass rate's denominator, printed wherever the
  // rate is, because it is a third of the executed cases on a real project.
  const judged = report ? report.totals.exec.pass + report.totals.exec.fail : 0

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      {/* header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-start gap-3">
        <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <BarChart3 className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">QC status report</h1>
          <p className="text-sm text-muted-foreground">
            {activeProject?.name ?? 'This project'} — every ticket, its test cases, its runs and
            what they found, joined into one picture.
            {report && <> Generated {dateTime(report.generatedAt)}.</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
            disabled={isFetching}
            onClick={() =>
              void queryClient.invalidateQueries({ queryKey: ['system-report', activeProjectId] })
            }
          >
            {isFetching ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
            disabled={!report}
            onClick={exportMarkdown}
          >
            <FileText className="size-3.5" />
            Markdown
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
            disabled={!report || exporting !== null}
            onClick={() => void exportFile('pdf')}
          >
            {exporting === 'pdf' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileDown className="size-3.5" />
            )}
            PDF
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
            disabled={!report || exporting !== null}
            onClick={() => void exportFile('docx')}
          >
            {exporting === 'docx' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <FileDown className="size-3.5" />
            )}
            Word
          </Button>
        </div>
      </div>

      {/* date window ------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2">
        <span className="text-xs font-medium">Runs &amp; defects from</span>
        {/* Each end constrains the other, so an inverted window — which would
            silently report zero runs — cannot be picked in the first place. */}
        <DatePicker
          value={from}
          onChange={setFrom}
          placeholder="Any start"
          aria-label="Window start date"
          disabled={parseDay(to) ? { after: parseDay(to) as Date } : undefined}
        />
        <span className="text-xs font-medium">to</span>
        <DatePicker
          value={to}
          onChange={setTo}
          placeholder="Any end"
          aria-label="Window end date"
          disabled={parseDay(from) ? { before: parseDay(from) as Date } : undefined}
        />
        {(from || to) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full text-xs"
            onClick={() => {
              setFrom('')
              setTo('')
            }}
          >
            Clear
          </Button>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground">
          The ticket backlog is never date-filtered — hiding it would turn "12 tickets have no test
          cases" into "everything is fine this week".
        </span>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Joining tickets, test cases, runs and defects…
        </div>
      )}

      {isError && (
        <Card className="rounded-3xl border-red-500/40 bg-red-500/5 p-5 shadow-none">
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            Could not build the report
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {error instanceof Error ? error.message : 'Unknown error'}
          </p>
        </Card>
      )}

      {report && verdict && (
        <>
          {report.warnings.map((w) => (
            <div
              key={w}
              className="flex items-start gap-2 rounded-2xl border border-amber-500/40 bg-amber-500/5 px-3.5 py-2.5 text-xs text-amber-700 dark:text-amber-400"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}

          {/* verdict + the numbers behind it ----------------------------- */}
          {/* One object, not two. The sentence and the six counts are the same
              statement at two zoom levels; as a tinted card floating above a row
              of six bordered tiles they read as seven unrelated facts, and the
              full-bleed grade tint (`bg-red-500/5` across a 150px box) is the
              loudest thing on a page whose job is to be read. Colour is a rail
              and a chip here; the card itself stays neutral. */}
          <Card className="overflow-hidden rounded-3xl border-border/60 p-0 shadow-none">
            <div className="relative flex items-start gap-3.5 p-5 pl-6">
              <span
                aria-hidden
                className={cn(
                  'absolute inset-y-5 left-0 w-[3px] rounded-r-full',
                  GRADE_RAIL[verdict.grade],
                )}
              />
              <span
                className={cn(
                  'flex size-10 shrink-0 items-center justify-center rounded-2xl',
                  GRADE_CHIP[verdict.grade],
                )}
              >
                {(() => {
                  const Icon = GRADE_ICON[verdict.grade]
                  return <Icon className="size-5" />
                })()}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex flex-wrap items-baseline gap-x-2.5">
                  <span
                    className={cn(
                      'text-base font-semibold tracking-tight',
                      GRADE_CLASS[verdict.grade],
                    )}
                  >
                    {gradeLabel(verdict.grade)}
                  </span>
                  <span className="text-sm text-muted-foreground">{verdict.headline}</span>
                </p>
                {verdict.action && (
                  <p className="flex items-start gap-1.5 text-xs">
                    <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="text-muted-foreground">Next — </span>
                      {verdict.action}
                    </span>
                  </p>
                )}
              </div>
            </div>
            {/* `gap-px` over a border-coloured ground draws the dividers, so the
                hairlines stay right at every wrap point — 6 across, 3, or 2 —
                without a nth-child rule per breakpoint. */}
            <div className="grid grid-cols-2 gap-px border-t border-border/60 bg-border/60 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Tickets"
                value={num(report.totals.tickets)}
                hint={report.totals.subtasks ? `${report.totals.subtasks} subtasks` : undefined}
              />
              <StatTile
                label="Test cases"
                value={num(report.totals.testcases)}
                hint={`across ${num(report.funnel.planned)} tickets`}
              />
              <StatTile
                label="QC runs"
                value={num(report.totals.runs)}
                hint={report.totals.flowRuns ? `${report.totals.flowRuns} E2E flows` : undefined}
              />
              <StatTile
                label="Pass rate"
                value={pct(report.totals.passRate, 1)}
                // The denominator, always — "84.3%" beside "941 test cases"
                // invites the reading that 941 cases were judged, when 51 were.
                hint={
                  judged > 0
                    ? `${num(report.totals.exec.pass)} of ${num(judged)} judged${
                        report.totals.exec.blocked
                          ? ` · ${num(report.totals.exec.blocked)} blocked`
                          : ''
                      }`
                    : 'nothing judged yet'
                }
                tone={
                  report.totals.passRate == null
                    ? 'neutral'
                    : report.totals.passRate >= 0.95
                      ? 'good'
                      : report.totals.passRate >= 0.8
                        ? 'warn'
                        : 'bad'
                }
              />
              <StatTile
                label="Open defects"
                value={num(report.totals.defects)}
                hint={
                  report.totals.defectsAllTime > report.totals.defects
                    ? `${num(report.totals.defectsAllTime)} all time`
                    : undefined
                }
                tone={report.totals.defects > 0 ? 'bad' : 'good'}
              />
              <StatTile
                label="Recurring"
                value={num(report.totals.recurringDefects)}
                hint="found in >1 run"
                tone={report.totals.recurringDefects > 0 ? 'warn' : 'neutral'}
              />
            </div>
          </Card>

          {/* funnel + execution ------------------------------------------ */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SectionCard
              icon={ClipboardList}
              title="Coverage chain"
              blurb="Each step is a subset of the one above it. The right-hand column is what fell out."
            >
              <div className="space-y-2.5">
                {steps.map((s, i) => (
                  <Bar
                    key={s.label}
                    label={s.label}
                    count={s.count}
                    max={maxStep}
                    colorClass="bg-primary"
                    hint={s.hint}
                    drop={i === 0 ? undefined : steps[i - 1].count - s.count}
                  />
                ))}
              </div>
            </SectionCard>

            <SectionCard
              icon={CheckCircle2}
              title="Execution outcome"
              blurb="From each ticket's latest reporting run — never summed across re-runs."
            >
              <StackedBar
                empty="No ticket has produced a report yet, so nothing has been executed."
                parts={[
                  {
                    key: 'pass',
                    label: 'Passed',
                    count: report.totals.exec.pass,
                    colorClass: 'bg-emerald-500',
                    textClass: 'text-emerald-600 dark:text-emerald-400',
                  },
                  {
                    key: 'fail',
                    label: 'Failed',
                    count: report.totals.exec.fail,
                    colorClass: 'bg-red-500',
                    textClass: 'text-red-600 dark:text-red-400',
                  },
                  {
                    key: 'blocked',
                    label: 'Blocked',
                    count: report.totals.exec.blocked,
                    colorClass: 'bg-amber-500',
                    textClass: 'text-amber-600 dark:text-amber-400',
                  },
                  {
                    key: 'untested',
                    label: 'Not tested',
                    count: report.totals.exec.untested,
                    colorClass: 'bg-muted-foreground/40',
                  },
                ]}
              />
              <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                Pass rate is {num(report.totals.exec.pass)} / {num(judged)} judged cases. Blocked and
                not-tested cases are excluded from that ratio — a case nobody could reach is a
                coverage gap, not a pass.
              </p>
            </SectionCard>
          </div>

          {/* defects + tracker status ------------------------------------ */}
          {/* Paired because both are short. Severity (4 rows) used to sit beside
              the recurring list (8 two-line items), which left ~200px of empty
              card under it, and the recurring titles wrapped to two lines in a
              half-width column. Recurring is now full width, one line each. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <SectionCard
              icon={Bug}
              title="Open defects by severity"
              blurb="The latest reporting run of each ticket — a defect fixed two runs ago is gone."
            >
              {sev.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No defects are open.
                  {report.totals.defectsAllTime > 0 &&
                    ` ${num(report.totals.defectsAllTime)} were recorded historically and cleared by a later run.`}
                </p>
              ) : (
                <>
                  <div className="space-y-2.5">
                    {sev.map((s) => (
                      <Bar
                        key={s.key}
                        label={SEVERITY_LABEL[s.key]}
                        count={s.count}
                        max={maxSev}
                        colorClass={SEVERITY_CLASS[s.key]}
                        labelWidth="w-24"
                      />
                    ))}
                  </div>
                  {(report.defectsBySeverity.unknown ?? 0) > 0 && (
                    <p className="mt-3 text-[11px] leading-snug text-muted-foreground">
                      "Unclassified" means that run's issues.md recorded no severity word. It is not
                      a low-severity bucket.
                    </p>
                  )}
                </>
              )}
            </SectionCard>

            {report.statusBuckets.length > 0 && (
              <SectionCard
                icon={TicketIcon}
                title="Tickets by tracker status"
                blurb={
                  report.totals.staleTickets
                    ? `As of each ticket's last crawl — ${report.totals.staleTickets} have changed in the tracker since.`
                    : "As of each ticket's last crawl. The report never re-queries the tracker."
                }
              >
                {/* Two columns. Nine statuses spread over 34 tickets was nine
                    near-identical grey bars down 350px of card — the tallest
                    section on the page for the least information on it. */}
                <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                  {report.statusBuckets.map((s) => (
                    <Bar
                      key={s.status}
                      label={s.status}
                      count={s.count}
                      max={maxStatus}
                      colorClass="bg-foreground/60"
                      labelWidth="w-28"
                    />
                  ))}
                </div>
              </SectionCard>
            )}
          </div>

          {/* recurring ---------------------------------------------------- */}
          <SectionCard
            icon={Repeat}
            title="Seen in more than one run"
            blurb="Matched on wording across every run in the window — a defect re-found after a claimed fix shows here."
            right={
              report.recurring.length > 0 ? (
                <span className="shrink-0 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                  {report.recurring.length}
                </span>
              ) : undefined
            }
          >
            {report.recurring.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing has been reported twice. Every defect was found once.
              </p>
            ) : (
              <ul className="divide-y divide-border/60">
                {report.recurring.slice(0, 8).map((r) => (
                  <li key={r.title} className="flex items-center gap-3 py-2 text-xs first:pt-0">
                    <span className="w-8 shrink-0 rounded-full bg-amber-500/10 py-0.5 text-center text-[11px] font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                      {r.occurrences}×
                    </span>
                    <span
                      className={cn(
                        'w-20 shrink-0 rounded-full border px-1.5 py-0.5 text-center text-[10px] font-medium',
                        SEVERITY_PILL[r.severity],
                      )}
                    >
                      {SEVERITY_LABEL[r.severity]}
                    </span>
                    <span className="min-w-0 flex-1 truncate leading-snug" title={r.title}>
                      {defectTitle(r.title)}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {shortDate(r.firstSeen)} → {shortDate(r.lastSeen)}
                    </span>
                  </li>
                ))}
                {report.recurring.length > 8 && (
                  <li className="pt-2 text-[11px] text-muted-foreground">
                    +{report.recurring.length - 8} more in the exported report.
                  </li>
                )}
              </ul>
            )}
          </SectionCard>

          {/* ticket table ------------------------------------------------- */}
          <SectionCard
            icon={TicketIcon}
            title="Tickets"
            blurb="Worst first: failures, then open defects, then what was never planned or run. Click a row for its evidence."
            right={
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter tickets…"
                className="h-8 w-44 shrink-0 rounded-full text-xs"
              />
            }
          >
            <div className="mb-3 flex flex-wrap gap-1.5">
              {STAGE_FILTERS.map((f) => {
                const count =
                  f.key === 'all'
                    ? report.tickets.length
                    : report.tickets.filter((t) => t.stage === f.key).length
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setStage(f.key)}
                    className={cn(
                      'rounded-xl border px-2.5 py-1 text-[11px] font-medium transition-all duration-200 active:scale-[0.98]',
                      stage === f.key
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                    )}
                  >
                    {f.label}
                    <span className="ml-1.5 tabular-nums opacity-70">{count}</span>
                  </button>
                )
              })}
            </div>
            {tickets.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                {report.tickets.length === 0
                  ? 'No tickets have been crawled into this project yet — start on the Tickets page.'
                  : 'No ticket matches this filter.'}
              </p>
            ) : (
              // 34 tickets is ~2,000px of table, and the column headings are
              // gone after the eighth row — "which number is Blocked?" then
              // costs a scroll to the top and back. Its own pane, header
              // pinned. The rule under the header is an inset shadow, not a
              // border: `border-collapse` leaves a sticky cell's own border
              // behind when it scrolls.
              <div className="max-h-[70vh] overflow-auto">
                <table className="w-full min-w-[860px] border-collapse text-left">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:bg-card [&>th]:pt-3 [&>th]:shadow-[inset_0_-1px_0_var(--border)]">
                      <th className="pb-2 pl-3 pr-2 font-medium">Ticket</th>
                      <th className="px-2 pb-2 font-medium">Tracker status</th>
                      <th className="px-2 pb-2 font-medium">Stage</th>
                      <th className="px-2 pb-2 text-right font-medium">Cases</th>
                      <th className="px-2 pb-2 text-right font-medium">Pass</th>
                      <th className="px-2 pb-2 text-right font-medium">Fail</th>
                      <th className="px-2 pb-2 text-right font-medium">Blocked</th>
                      <th className="px-2 pb-2 text-right font-medium">Defects</th>
                      <th className="pb-2 pl-2 pr-3 text-right font-medium">Last run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickets.map((row) => (
                      <TicketRow
                        key={row.folder}
                        row={row}
                        projectId={activeProjectId}
                        expanded={expanded === row.folder}
                        onToggle={() =>
                          setExpanded((cur) => (cur === row.folder ? null : row.folder))
                        }
                        defects={defectsByTicket.get(row.folder) ?? []}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          {/* runs --------------------------------------------------------- */}
          {report.runs.length > 0 && (
            <SectionCard
              icon={PlayCircle}
              title="Recent runs"
              blurb="Every run in the window, newest first — including the ones that never produced a report."
            >
              <div className="max-h-[60vh] overflow-auto">
                <table className="w-full min-w-[760px] border-collapse text-left">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="text-[10px] uppercase tracking-wide text-muted-foreground [&>th]:bg-card [&>th]:pt-3 [&>th]:shadow-[inset_0_-1px_0_var(--border)]">
                      <th className="pb-2 pr-2 font-medium">Run</th>
                      <th className="px-2 pb-2 font-medium">Status</th>
                      <th className="px-2 pb-2 text-right font-medium">Pass</th>
                      <th className="px-2 pb-2 text-right font-medium">Fail</th>
                      <th className="px-2 pb-2 text-right font-medium">Defects</th>
                      <th className="px-2 pb-2 text-right font-medium">Took</th>
                      <th className="pl-2 pb-2 text-right font-medium">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.runs.slice(0, 25).map((r) => (
                      <tr key={r.id} className="border-t border-border/60 hover:bg-muted/50">
                        <td className="py-2 pr-2 text-xs">
                          <Link
                            to={`/history/${r.id}`}
                            className="font-medium hover:text-primary hover:underline"
                          >
                            <span className="font-mono">{r.ticketId}</span>
                          </Link>
                          {r.kind === 'flow' && (
                            <span className="ml-1.5 rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">
                              E2E flow
                            </span>
                          )}
                          {/* The "no report" badge that used to sit here is now
                              the merged cell three columns along — one row said
                              it twice. */}
                        </td>
                        <td
                          className={cn(
                            'px-2 py-2 text-xs',
                            r.status === 'passed'
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : r.status === 'failed' || r.status === 'error'
                                ? 'text-red-600 dark:text-red-400'
                                : 'text-muted-foreground',
                          )}
                        >
                          {r.status}
                        </td>
                        {/* Same rule as the ticket table: 17 of the 25 newest
                            runs on the reference project produced no report, so
                            three columns of dashes each. Say it once. */}
                        {!r.hasReport ? (
                          <td
                            colSpan={3}
                            className="px-2 py-2 text-center text-[11px] text-muted-foreground/60"
                          >
                            no result recorded
                          </td>
                        ) : (
                          <>
                            <td className="px-2 py-2 text-right text-xs tabular-nums">
                              <Num
                                value={r.exec.pass}
                                tone="text-emerald-600 dark:text-emerald-400"
                              />
                            </td>
                            <td className="px-2 py-2 text-right text-xs tabular-nums">
                              <Num value={r.exec.fail} tone="text-red-600 dark:text-red-400" />
                            </td>
                            <td className="px-2 py-2 text-right text-xs tabular-nums">
                              <Num value={r.defectCount} tone="text-red-600 dark:text-red-400" />
                            </td>
                          </>
                        )}
                        <td className="px-2 py-2 text-right text-xs tabular-nums text-muted-foreground">
                          {duration(r.durationMs)}
                        </td>
                        <td className="pl-2 py-2 text-right text-xs text-muted-foreground">
                          {shortDate(r.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {report.runs.length > 25 && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Showing the 25 newest of {report.runs.length}.{' '}
                  <Link to="/history" className="hover:text-foreground hover:underline">
                    See all on History
                  </Link>
                  .
                </p>
              )}
            </SectionCard>
          )}
        </>
      )}
    </div>
  )
}
