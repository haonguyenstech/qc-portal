import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  FileUp,
  FolderTree,
  HelpCircle,
  History,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  PencilLine,
  ScanSearch,
  Search,
  Send,
  Sparkles,
  Terminal,
  Ticket,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { buildCrawledTree } from '@/lib/crawled-tickets'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { CheckboxIndicator } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  cancelVerifyDesignJob,
  getVerifyDesignJob,
  listCrawledTickets,
  listDesignChecks,
  listTemplates,
  openDesignCheckFolder,
  openTemplatesFolder,
  startVerifyDesignJob,
  type CrawledTicket,
  type DesignCheckRecord,
  type DesignFinding,
  type FindingCategory,
  type VerifyJobResult,
  type VerifyLogLine,
} from '@/lib/api'
import { ClickupFilingBar } from '@/components/ClickupFilingBar'
import type { FilingItem } from '@/lib/clickup-filing'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { McpRequiredNotice } from '@/components/McpRequiredNotice'
import { useProjects } from '@/lib/project-context'

const MODEL_KEY = 'qc.verifyModel'

// The active background job id is remembered per project so a browser reload (or
// navigating away and back) reconnects to the still-running server-side verify job.
// The key is cleared by the global VerifyJobWatcher once a job finishes — this page
// only writes it (on start) and reads it (to reconnect).
const ACTIVE_JOB_PREFIX = 'qc.verifyJob.'
function loadActiveJobId(projectId: string | null): string | null {
  if (!projectId) return null
  try {
    return localStorage.getItem(ACTIVE_JOB_PREFIX + projectId)
  } catch {
    return null
  }
}
function saveActiveJobId(projectId: string, jobId: string): void {
  try {
    localStorage.setItem(ACTIVE_JOB_PREFIX + projectId, jobId)
  } catch {
    /* storage unavailable */
  }
}

// Checklist upload — mirrors the TestCase page's template upload. Markdown/CSV/Excel;
// Excel is parsed to CSV in the browser before it's sent.
const TEMPLATE_ACCEPT = '.md,.csv,.xlsx,.xls'
const MAX_TEMPLATE_BYTES = 200 * 1024 // keep uploads sane; server caps chars too

/** Heuristic: does this file look like CSV? (by extension, or a comma-y header). */
function looksLikeCsv(name: string, content: string): boolean {
  const n = name.toLowerCase()
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return true
  const first = content.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
  if (first.startsWith('#') || first.startsWith('|')) return false
  return (first.match(/,/g)?.length ?? 0) >= 2
}

/** Render a CSV string as a simple bordered table for previews. */
function CsvTable({ csv }: { csv: string }) {
  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(','))
  if (rows.length === 0) return null
  const [head, ...body] = rows
  return (
    <div className="overflow-x-auto rounded-2xl border border-border/60">
      <table className="w-full border-collapse text-left text-xs">
        <thead className="bg-muted/50">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="border-b px-2.5 py-1.5 font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="even:bg-muted/20">
              {row.map((cell, c) => (
                <td key={c} className="border-b px-2.5 py-1.5 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Read-only dialog that previews a checklist file — CSV as a table, else raw text. */
function TemplatePreviewDialog({
  template,
  onOpenChange,
}: {
  template: { name: string; content: string } | null
  onOpenChange: (open: boolean) => void
}) {
  const isCsv = template ? looksLikeCsv(template.name, template.content) : false
  return (
    <Dialog open={!!template} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[72rem]">
        <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{template?.name}</span>
          </DialogTitle>
          <DialogDescription>
            Checklist the model verifies each item of.{isCsv ? ' Shown as a table.' : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {!template ? null : isCsv ? (
            <CsvTable csv={template.content} />
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-relaxed">
              {template.content}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const MODELS: { value: string; label: string; description: string }[] = [
  { value: 'haiku', label: 'Haiku · fast', description: 'Quick pass. Best for small, simple screens.' },
  {
    value: 'sonnet',
    label: 'Sonnet · balanced',
    description: 'Solid visual + requirement reasoning. Recommended.',
  },
  {
    value: 'opus',
    label: 'Opus · deep',
    description: 'Most thorough — complex flows, many states, subtle gaps.',
  },
]

interface CategoryMeta {
  label: string
  /** One line naming what the bucket MEANS — the group header's subtitle. */
  blurb: string
  icon: typeof CheckCircle2
  /**
   * The bucket's colour, in the three places it is allowed to appear. A finding row
   * is a NEUTRAL card: colour arrives as a 3px rail down its left edge and a small
   * icon, never as the row's fill. The previous version tinted every card
   * (`bg-amber-50/40` + `border-amber-300/60`), and 26 findings then read as a wall
   * of highlighter — and in dark mode the tint disappeared entirely, leaving 26
   * hard yellow outlines with nothing inside them. `bg-<c>-500/10` works on both
   * grounds because it is a tint OF the surface, not a fixed light colour.
   */
  text: string
  chip: string
  rail: string
  /**
   * Whether a finding in this bucket can become a ClickUp bug. "match" cannot —
   * filing the things that are FINE is how a bug list stops being read.
   */
  filable: boolean
  /**
   * The severity word a finding in this bucket is filed with unless the engineer
   * changes it. It maps onto the ClickUp priority through the same
   * `severityPriority()` the run's Issues tab uses, so a mismatch lands High and a
   * question lands Low without anyone setting a field by hand.
   */
  severity: string
}

const CATEGORY: Record<FindingCategory, CategoryMeta> = {
  match: {
    label: 'Matches',
    blurb: 'Built as designed — nothing to do.',
    icon: CheckCircle2,
    text: 'text-emerald-600 dark:text-emerald-400',
    chip: 'bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-400',
    rail: 'bg-emerald-500',
    filable: false,
    severity: 'low',
  },
  mismatch: {
    label: "Doesn't match",
    blurb: 'The design and the ticket disagree. File these.',
    icon: XCircle,
    text: 'text-red-600 dark:text-red-400',
    chip: 'bg-red-500/10 text-red-600 ring-red-500/20 dark:text-red-400',
    rail: 'bg-red-500',
    filable: true,
    severity: 'high',
  },
  concern: {
    label: 'Concern',
    blurb: 'Not a clear breach, but worth raising before build.',
    icon: AlertTriangle,
    text: 'text-amber-600 dark:text-amber-400',
    chip: 'bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400',
    rail: 'bg-amber-500',
    filable: true,
    severity: 'medium',
  },
  unsure: {
    label: 'Not sure',
    blurb: 'The model could not see enough to judge.',
    icon: HelpCircle,
    text: 'text-muted-foreground',
    chip: 'bg-muted text-muted-foreground ring-border/60',
    rail: 'bg-muted-foreground/50',
    filable: true,
    severity: 'low',
  },
  discuss: {
    label: 'Needs discussion',
    blurb: 'A question for the designer or the BA.',
    icon: MessageCircleQuestion,
    text: 'text-violet-600 dark:text-violet-400',
    chip: 'bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:text-violet-400',
    rail: 'bg-violet-500',
    filable: true,
    severity: 'low',
  },
}
const CATEGORY_ORDER: FindingCategory[] = ['mismatch', 'concern', 'discuss', 'unsure', 'match']

/**
 * Categories selected for filing by default: the two that describe something WRONG.
 * "Needs discussion" and "Not sure" are filable but stay unticked — they're questions,
 * and a batch that quietly files every question is one the engineer stops trusting.
 */
const DEFAULT_FILED: FindingCategory[] = ['mismatch', 'concern']

/**
 * The one-line answer to "how did this check go?", from the counts alone.
 *
 * A pile of five numbers is not a verdict — the engineer opening a saved report has
 * to add them up before they know whether to worry. The ladder is severity-ordered:
 * one mismatch outranks any number of matches, because the mismatch is the reason
 * the check was run.
 */
function verdictOf(counts: Record<string, number>): {
  label: string
  line: string
  text: string
  chip: string
  icon: typeof CheckCircle2
} {
  const bad = counts.mismatch ?? 0
  const warn = counts.concern ?? 0
  const ask = (counts.discuss ?? 0) + (counts.unsure ?? 0)
  const ok = counts.match ?? 0
  if (bad > 0)
    return {
      label: 'Gaps found',
      line: `${bad} thing${bad === 1 ? '' : 's'} the design and the ticket disagree on`,
      text: 'text-red-600 dark:text-red-400',
      chip: 'bg-red-500/10 text-red-600 dark:text-red-400',
      icon: XCircle,
    }
  if (warn > 0)
    return {
      label: 'Needs attention',
      line: `no outright mismatch, ${warn} concern${warn === 1 ? '' : 's'} to weigh`,
      text: 'text-amber-600 dark:text-amber-400',
      chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
      icon: AlertTriangle,
    }
  if (ask > 0)
    return {
      label: 'Questions to resolve',
      line: `nothing wrong, ${ask} open question${ask === 1 ? '' : 's'}`,
      text: 'text-violet-600 dark:text-violet-400',
      chip: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
      icon: MessageCircleQuestion,
    }
  return {
    label: 'Matches the design',
    line: ok > 0 ? `all ${ok} checked point${ok === 1 ? '' : 's'} line up` : 'nothing to flag',
    text: 'text-emerald-600 dark:text-emerald-400',
    chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    icon: CheckCircle2,
  }
}

/** The severity words offered per finding, and the ClickUp priority each produces. */
const SEVERITY_CHOICES: { value: string; label: string; priority: string }[] = [
  { value: 'urgent', label: 'Urgent', priority: 'Urgent' },
  { value: 'high', label: 'High', priority: 'High' },
  { value: 'medium', label: 'Normal', priority: 'Normal' },
  { value: 'low', label: 'Low', priority: 'Low' },
]

/** Color-code a ClickUp priority into our status palette (mirrors the TestCases page). */
function priorityClass(priority: string): string {
  const p = priority.toLowerCase()
  if (p === 'urgent') return 'border-red-200 bg-red-50 text-red-700'
  if (p === 'high') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (p === 'normal') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-border bg-muted text-muted-foreground' // low / unknown
}

/** A stable id for one finding within a result (index-based — findings have no id). */
function findingId(index: number): string {
  return `f-${index}`
}

/**
 * The ClickUp card body for one finding. The server renders this as markdown
 * (`markdown_content`), and `normalizeIssueMarkdown` puts each bold label on its own
 * block — so the developer opening the bug sees the verdict, the specifics, and the
 * design it was judged against, not a run-on paragraph.
 */
function findingBody(
  finding: DesignFinding,
  ctx: { folder: string; figmaUrl: string; model: string; savedPath: string | null },
): string {
  const lines = [
    `**Verdict:** ${CATEGORY[finding.category].label}`,
    `**Finding:** ${finding.title}`,
  ]
  if (finding.detail) lines.push(`**Detail:** ${finding.detail}`)
  lines.push(`**Ticket:** ${ctx.folder}`)
  if (ctx.figmaUrl) lines.push(`**Figma design:** ${ctx.figmaUrl}`)
  lines.push('')
  lines.push(
    `_Filed from the QC Portal · Design Check (${ctx.model})${ctx.savedPath ? ` · report ${ctx.savedPath}` : ''}._`,
  )
  return lines.join('\n')
}

/**
 * One finding row.
 *
 * A NEUTRAL card with a coloured rail, not a coloured card — see `CategoryMeta.text`.
 * Two more things earn their keep at 26 findings:
 *  - the detail CLAMPS to two lines. Unclamped, this one report was a 3,500px scroll
 *    and the buckets below "Doesn't match" were never reached.
 *  - the severity picker appears only on a TICKED row. A dropdown on every row is 16
 *    dropdowns on screen, all of them inert until something is selected; showing it
 *    only when the finding is actually going to ClickUp says what it is for.
 */
function FindingRow({
  finding,
  selectable,
  checked,
  onToggle,
  severity,
  onSeverity,
}: {
  finding: DesignFinding
  selectable: boolean
  checked: boolean
  onToggle: () => void
  severity: string
  onSeverity: (value: string) => void
}) {
  const meta = CATEGORY[finding.category]
  const Icon = meta.icon
  const [expanded, setExpanded] = useState(false)
  // Whether the clamp is actually HIDING anything. A character-count guess offers
  // "Show more" on a detail that already fits in its two lines at this width, and a
  // toggle that reveals nothing is worse than no toggle — so it is measured, and
  // re-measured on resize, because the answer changes with the column width.
  const detailRef = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const el = detailRef.current
    if (!el || expanded) return
    const measure = () => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [expanded, finding.detail])
  const severityLabel =
    SEVERITY_CHOICES.find((s) => s.value === severity)?.label ?? severity

  return (
    <div
      className={cn(
        'group relative flex gap-3 overflow-hidden rounded-2xl border py-2.5 pl-4 pr-3 transition-colors',
        checked
          ? 'border-primary/30 bg-primary/[0.04]'
          : 'border-border/60 bg-card hover:border-border hover:bg-muted/40',
      )}
    >
      {/* The bucket's colour, as a rail — enough to scan by, quiet enough to read past. */}
      <span
        aria-hidden
        className={cn('absolute inset-y-2 left-0 w-[3px] rounded-r-full', meta.rail)}
      />
      {selectable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={checked}
          aria-label={checked ? 'Do not file this finding' : 'File this finding'}
          className="mt-0.5 shrink-0 self-start"
        >
          <CheckboxIndicator checked={checked} />
        </button>
      ) : (
        <Icon className={cn('mt-0.5 size-4 shrink-0', meta.text)} />
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium leading-snug">{finding.title}</p>
        {finding.detail && (
          <>
            <p
              ref={detailRef}
              className={cn(
                'text-[13px] leading-snug text-muted-foreground',
                !expanded && 'line-clamp-2',
              )}
            >
              {finding.detail}
            </p>
            {(overflowing || expanded) && (
              <button
                type="button"
                onClick={() => setExpanded((e) => !e)}
                className="text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
          </>
        )}
      </div>
      {selectable &&
        (checked ? (
          <Select value={severity} onValueChange={onSeverity}>
            <SelectTrigger
              className="h-7 w-[6.5rem] shrink-0 gap-1 self-start rounded-full border-border/60 bg-background/80 px-2.5 text-[11px] shadow-none"
              title="Severity — sets the ClickUp priority of the filed bug"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_CHOICES.map((s) => (
                <SelectItem key={s.value} value={s.value} className="text-xs">
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span
            className="shrink-0 self-start rounded-full px-2 py-1 text-[11px] text-muted-foreground/60 opacity-0 transition-opacity group-hover:opacity-100"
            title="Tick this finding to file it — the severity is then editable"
          >
            {severityLabel}
          </span>
        ))}
    </div>
  )
}

/**
 * The findings of ONE design check: the verdict, count chips that double as filters,
 * a search box, the findings themselves, and the ClickUp filing bar.
 *
 * Used for both a just-finished run and a saved record opened from history, so a check
 * from last week can still be filed — the findings are the same shape either way.
 * Selection state is per-mount; give it a `key` so a new result starts fresh.
 */
function FindingsPanel({
  result,
  folder,
  figmaUrl,
  projectId,
  parentTicketUrl,
}: {
  result: VerifyJobResult
  folder: string
  figmaUrl: string
  projectId: string
  /** The crawled ticket's own ClickUp URL, prefilled as the parent to file under. */
  parentTicketUrl: string
}) {
  const findings = result.findings
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.category] = (acc[f.category] ?? 0) + 1
    return acc
  }, {})

  const [filter, setFilter] = useState<Set<FindingCategory>>(new Set())
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        findings
          .map((f, i) => (DEFAULT_FILED.includes(f.category) ? findingId(i) : null))
          .filter((v): v is string => !!v),
      ),
  )
  const [severities, setSeverities] = useState<Record<string, string>>({})
  // "Matches" starts folded: it is routinely the biggest bucket and the only one with
  // nothing to do in it, so open it costs every other bucket a screen of scrolling.
  const [folded, setFolded] = useState<Set<FindingCategory>>(() => new Set(['match'] as const))
  const toggleFold = (c: FindingCategory) =>
    setFolded((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const filable = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => CATEGORY[finding.category].filable)

  const q = query.trim().toLowerCase()
  const visible = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => filter.size === 0 || filter.has(finding.category))
    .filter(
      ({ finding }) =>
        !q || `${finding.title} ${finding.detail}`.toLowerCase().includes(q),
    )

  function severityOf(index: number): string {
    return severities[findingId(index)] ?? CATEGORY[findings[index].category].severity
  }

  // What the filing bar will create. Only filable, selected findings — worded here
  // so the bar itself stays source-agnostic.
  const filingItems: FilingItem[] = filable
    .filter(({ index }) => selected.has(findingId(index)))
    .map(({ finding, index }) => ({
      id: findingId(index),
      title: `Design: ${finding.title}`.slice(0, 140),
      description: findingBody(finding, {
        folder,
        figmaUrl,
        model: result.model,
        savedPath: result.savedPath,
      }),
      severity: severityOf(index),
      screenshots: [],
    }))

  function toggleFilter(c: FindingCategory) {
    setFilter((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }

  const allFilableSelected = filable.length > 0 && filingItems.length === filable.length
  const verdict = verdictOf(counts)

  return (
    <div className="space-y-4">
      {/* The verdict, then the shape of the result, then the filters. */}
      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start gap-3">
            <span
              className={cn(
                'flex size-10 shrink-0 items-center justify-center rounded-2xl',
                verdict.chip,
              )}
            >
              <verdict.icon className="size-5" />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className={cn('text-base font-semibold tracking-tight', verdict.text)}>
                  {verdict.label}
                </h3>
                <span className="text-xs text-muted-foreground">{verdict.line}</span>
              </div>
              <p className="text-[13px] leading-snug text-muted-foreground">
                {result.summary || 'Verification complete.'}
              </p>
            </div>
            <CopyButton
              text={findings
                .map((f) => `- [${CATEGORY[f.category].label}] ${f.title}${f.detail ? ` — ${f.detail}` : ''}`)
                .join('\n')}
            />
          </div>

          {/* The SHAPE of the result in one line. Five count chips say how many of
              each; only a proportional bar says whether this check is mostly fine
              with two gaps, or mostly gaps. Each segment is also a filter. */}
          {findings.length > 0 && (
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" role="presentation">
              {CATEGORY_ORDER.map((c) => {
                const n = counts[c] ?? 0
                if (n === 0) return null
                const on = filter.size === 0 || filter.has(c)
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleFilter(c)}
                    title={`${n} ${CATEGORY[c].label} — click to filter`}
                    style={{ width: `${(n / findings.length) * 100}%` }}
                    className={cn(
                      'h-full transition-opacity',
                      CATEGORY[c].rail,
                      on ? 'opacity-100' : 'opacity-25',
                    )}
                  />
                )
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {CATEGORY_ORDER.map((c) => {
              const meta = CATEGORY[c]
              const Icon = meta.icon
              const n = counts[c] ?? 0
              const on = filter.has(c)
              return (
                <button
                  key={c}
                  type="button"
                  disabled={n === 0}
                  onClick={() => toggleFilter(c)}
                  title={n === 0 ? `No ${meta.label.toLowerCase()} findings` : `Show only ${meta.label}`}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition-all duration-200',
                    n > 0
                      ? cn(meta.chip, 'active:scale-[0.98]')
                      : 'bg-muted/60 text-muted-foreground/70 ring-transparent',
                    on && 'ring-2 ring-offset-1 ring-offset-background',
                  )}
                >
                  <Icon className="size-3.5" />
                  {n} {meta.label}
                  {on && <X className="size-3" />}
                </button>
              )
            })}
            {filter.size > 0 && (
              <button
                type="button"
                onClick={() => setFilter(new Set())}
                className="rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Clear filter
              </button>
            )}
          </div>

          {/* Provenance, demoted: which model judged it, against what, and where the
              report landed. It is what you check once, not what you read first. */}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
            <span>
              {findings.length} finding{findings.length === 1 ? '' : 's'}
            </span>
            <span aria-hidden>·</span>
            <span>model {result.model}</span>
            {figmaUrl && (
              <>
                <span aria-hidden>·</span>
                <a
                  href={figmaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                >
                  <ExternalLink className="size-3" />
                  Figma design
                </a>
              </>
            )}
            {result.savedPath && (
              <>
                <span aria-hidden>·</span>
                <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                  <FileText className="size-3 shrink-0" />
                  <span className="truncate">{result.savedPath}</span>
                </span>
              </>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Findings + filing */}
      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <div className="flex flex-col gap-3 border-b border-border/60 bg-muted/40 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <Send className="size-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold tracking-tight">
                Review findings &amp; file to ClickUp
              </h3>
              <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted-foreground">
                Tick the findings worth logging, then create them as subtasks under a parent
                ClickUp ticket. Each one inherits the parent&apos;s assignee and tags and takes its
                priority from the severity beside it — the same filing a QC run&apos;s issues use.
                Matches can&apos;t be filed.
              </p>
            </div>
          </div>
          <span className="w-fit shrink-0 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
            {filingItems.length}
            <span className="text-muted-foreground/60"> / {filable.length}</span> to file
          </span>
        </div>

        <CardContent className="space-y-3 p-5">
          {/* Toolbar: select-all + search */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              disabled={filable.length === 0}
              onClick={() =>
                setSelected(
                  allFilableSelected
                    ? new Set()
                    : new Set(filable.map(({ index }) => findingId(index))),
                )
              }
              className="inline-flex w-fit items-center gap-2 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <CheckboxIndicator size="lg" checked={allFilableSelected} />
              {allFilableSelected ? 'Clear all' : `Select all ${filable.length} filable`}
            </button>
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search findings…"
                className="h-9 pl-9 text-sm shadow-none"
              />
            </div>
          </div>

          {/* The findings themselves, grouped by verdict, most actionable first.
              Each group FOLDS: "Matches" is the biggest bucket on a healthy check and
              the least likely to be read, and folding it is how the gaps stay on one
              screen. Group headers carry a select-all for their own bucket, because
              "file every mismatch" is the most common batch there is. */}
          {visible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border/60 px-3 py-8 text-center text-xs text-muted-foreground">
              No findings match {q ? `“${query}”` : 'this filter'}.
            </p>
          ) : (
            CATEGORY_ORDER.map((c) => {
              const items = visible.filter(({ finding }) => finding.category === c)
              if (items.length === 0) return null
              const meta = CATEGORY[c]
              const Icon = meta.icon
              const open = !folded.has(c)
              const groupIds = items.map(({ index }) => findingId(index))
              const groupAllOn =
                meta.filable && groupIds.length > 0 && groupIds.every((id) => selected.has(id))
              return (
                <section key={c} className="space-y-2 pt-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => toggleFold(c)}
                      aria-expanded={open}
                      className="group/h flex min-w-0 items-center gap-2 rounded-full py-0.5 pr-2 text-left"
                    >
                      <ChevronDown
                        className={cn(
                          'size-3.5 shrink-0 text-muted-foreground transition-transform',
                          !open && '-rotate-90',
                        )}
                      />
                      <Icon className={cn('size-4 shrink-0', meta.text)} />
                      <h4 className="text-sm font-semibold tracking-tight">{meta.label}</h4>
                      <span
                        className={cn(
                          'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ring-1',
                          meta.chip,
                        )}
                      >
                        {items.length}
                      </span>
                      <span className="hidden truncate text-[11px] text-muted-foreground lg:inline">
                        {meta.blurb}
                      </span>
                    </button>
                    <span className="h-px flex-1 bg-border/60" aria-hidden />
                    {meta.filable && (
                      <button
                        type="button"
                        onClick={() =>
                          setSelected((prev) => {
                            const next = new Set(prev)
                            for (const id of groupIds) {
                              if (groupAllOn) next.delete(id)
                              else next.add(id)
                            }
                            return next
                          })
                        }
                        className="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {groupAllOn ? 'None' : 'All'}
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="space-y-2">
                      {items.map(({ finding, index }) => (
                        <FindingRow
                          key={findingId(index)}
                          finding={finding}
                          selectable={meta.filable}
                          checked={selected.has(findingId(index))}
                          onToggle={() =>
                            setSelected((prev) => {
                              const next = new Set(prev)
                              const id = findingId(index)
                              if (next.has(id)) next.delete(id)
                              else next.add(id)
                              return next
                            })
                          }
                          severity={severityOf(index)}
                          onSeverity={(value) =>
                            setSeverities((prev) => ({ ...prev, [findingId(index)]: value }))
                          }
                        />
                      ))}
                    </div>
                  )}
                </section>
              )
            })
          )}

          {/* Parent ticket + inherit preview + create — shared with the run Issues tab. */}
          <ClickupFilingBar
            projectId={projectId}
            items={filingItems}
            defaultParent={parentTicketUrl}
            noun="finding"
            showEvidence={false}
            inputId="design-check-parent"
          />
        </CardContent>
      </Card>
    </div>
  )
}

/** Copy-to-clipboard icon button with a brief "copied" state. */
function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1500)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => setDone(true))
          .catch(() => toast.error('Could not copy'))
      }}
      title="Copy the findings as a list"
      aria-label="Copy the findings as a list"
      className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {done ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </button>
  )
}

/** Collapsible terminal-style live log for a Design Check job. */
function JobLogPanel({ logs, running }: { logs: VerifyLogLine[]; running: boolean }) {
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)

  // Keep pinned to the newest line as logs stream in (only while expanded).
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [logs, open])

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-left"
      >
        <Terminal className="size-3.5 text-zinc-400" />
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Logs</span>
        {running && (
          <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-400">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {logs.length} {logs.length === 1 ? 'line' : 'lines'}
        </span>
        <ChevronDown
          className={cn('size-3.5 text-zinc-500 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div ref={bodyRef} className="max-h-72 overflow-y-auto p-3">
          <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <div className="flex items-center gap-2 text-zinc-500">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-zinc-500" />
                Waiting for output…
              </div>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    l.level === 'error'
                      ? 'text-red-400'
                      : l.level === 'success'
                        ? 'text-emerald-400'
                        : 'text-zinc-300',
                  )}
                >
                  <span className="mr-2 select-none text-zinc-600">
                    {new Date(l.time).toLocaleTimeString()}
                  </span>
                  {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Live elapsed time since `since`, ticking once a second while `on`. */
function useElapsed(since: string | null, on: boolean): string | null {
  // The clock is read in the interval, never during render — a render that calls
  // Date.now() produces a different result every time React happens to re-run it.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  if (!since) return null
  const ms = now - new Date(since).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

/** Compact per-category count chips for a saved record. */
function HistoryCountChips({ counts }: { counts: DesignCheckRecord['counts'] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {CATEGORY_ORDER.map((c) =>
        counts[c] > 0 ? (
          <span
            key={c}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1',
              CATEGORY[c].chip,
            )}
          >
            {counts[c]} {CATEGORY[c].label}
          </span>
        ) : null,
      )}
    </span>
  )
}

/**
 * Saved Design Check history — one row per recorded run (DB + on-disk report).
 *
 * The rows carry the same verdict vocabulary as a fresh result (`verdictOf`), so
 * "did this ticket pass?" is answerable from the list without opening anything. Chips
 * alone did not answer it: five numbers per row, five rows, is arithmetic.
 */
function HistoryCard({
  records,
  projectId,
  onSelect,
}: {
  records: DesignCheckRecord[]
  projectId: string
  onSelect: (record: DesignCheckRecord) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const shown = q
    ? records.filter((r) => `${r.folder} ${r.summary}`.toLowerCase().includes(q))
    : records

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
        <History className="h-4 w-4 text-muted-foreground" />
        Saved design checks
        <span className="text-xs font-normal text-muted-foreground">{records.length}</span>
        <div className="ml-auto flex items-center gap-2">
          {records.length > 4 && (
            <div className="relative w-44">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="h-8 pl-9 text-xs shadow-none"
              />
            </div>
          )}
          <OpenFolderButton open={() => openDesignCheckFolder(projectId)} label="design checks" />
        </div>
      </div>
      {records.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
            <ScanSearch className="size-5" />
          </span>
          <p className="text-sm font-medium">No design checks yet</p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
            Every check is saved here with its findings — reopen one later and its gaps can
            still be filed to ClickUp.
          </p>
        </div>
      ) : (
        <ul className="divide-y">
          {shown.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground">
              No saved check matches “{query}”.
            </li>
          )}
          {shown.map((r) => {
            const v = verdictOf(r.counts)
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => onSelect(r)}
                  className="flex w-full gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
                  title="Open the report — findings can still be filed to ClickUp"
                >
                  <span
                    className={cn(
                      'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl',
                      v.chip,
                    )}
                  >
                    <v.icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex w-full items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                        {r.folder}
                      </span>
                      <span className={cn('shrink-0 text-[11px] font-semibold', v.text)}>
                        {v.label}
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                        <Clock className="size-3" />
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                      <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                    </span>
                    {r.summary && (
                      <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                        {r.summary}
                      </span>
                    )}
                    <span className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                      <HistoryCountChips counts={r.counts} />
                      {r.filePath && (
                        <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
                          <FileText className="size-3 shrink-0" />
                          <span className="truncate">{r.filePath}</span>
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

/**
 * A saved Design Check report, reopened. It renders the SAME FindingsPanel as a fresh
 * run, so a check from last week can still be filed to ClickUp — the reason to keep
 * history at all is that the follow-up usually happens later than the check.
 */
function ReportPreviewDialog({
  record,
  projectId,
  parentTicketUrl,
  onOpenChange,
}: {
  record: DesignCheckRecord | null
  projectId: string
  parentTicketUrl: string
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={!!record} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[64rem]">
        <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ScanSearch className="h-4 w-4 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{record?.folder}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {record && (
              <>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3" />
                  {new Date(record.createdAt).toLocaleString()}
                </span>
                {record.figmaUrl && (
                  <a
                    href={record.figmaUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-w-0 items-center gap-1 text-primary underline-offset-2 hover:underline"
                  >
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">Figma design</span>
                  </a>
                )}
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {record && (
            <FindingsPanel
              key={record.id}
              projectId={projectId}
              folder={record.folder}
              figmaUrl={record.figmaUrl}
              parentTicketUrl={parentTicketUrl}
              result={{
                summary: record.summary,
                findings: record.findings,
                model: record.model,
                savedPath: record.filePath,
                savedAt: record.createdAt,
                recordId: record.id,
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Searchable single-select crawled-ticket picker. A Select-like trigger that opens
 * a panel with a search box + status-grouped rows (subtasks nested beneath their
 * parent), styled to match the ticket list on the TestCases page. Closes on
 * outside-click / Escape / selection.
 */
function CrawledTicketPicker({
  tickets,
  value,
  onChange,
  loading,
  disabled,
}: {
  tickets: CrawledTicket[]
  value: string
  onChange: (name: string) => void
  loading?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selected = tickets.find((t) => t.name === value) ?? null
  const q = query.trim().toLowerCase()
  const tree = buildCrawledTree(tickets, {
    collapsed,
    match: q
      ? (t) => `${t.name} ${t.displayId ?? ''} ${t.title ?? ''}`.toLowerCase().includes(q)
      : undefined,
  })

  const triggerDisabled = disabled || loading || tickets.length === 0
  const triggerLabel = loading
    ? 'Loading…'
    : selected
      ? selected.title || selected.displayId || selected.name
      : tickets.length === 0
        ? 'No crawled tickets'
        : 'Select a ticket'

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={triggerDisabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={cn(
          'flex h-10 w-full items-center gap-2 rounded-xl border border-border/60 bg-transparent px-3 py-1 text-sm shadow-none transition-colors',
          'focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn('min-w-0 flex-1 truncate text-left', !selected && 'text-muted-foreground')}
        >
          {triggerLabel}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-sm">
          <div className="border-b p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                placeholder="Search crawled tickets…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-11 pl-9 text-sm shadow-none"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-auto">
            {tree.count === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {tickets.length === 0 ? 'No crawled tickets.' : `No tickets match “${query}”.`}
              </p>
            ) : (
              tree.groups.map((group) => (
                <div key={group.status || '∅'}>
                  {/* Sticky status header — same treatment as the TestCases list. */}
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/80 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
                      {group.status || 'No status'}
                    </span>
                    <span className="text-[11px] font-medium text-muted-foreground/70">
                      {group.roots.length}
                    </span>
                    <span className="h-px flex-1 bg-border/60" aria-hidden />
                  </div>
                  <ul>
                    {tree.rows(group.roots).map(({ ticket: t, depth, hasChildren }) => {
                      const isSel = t.name === value
                      const isCollapsed = collapsed.has(t.name)
                      return (
                        <li key={t.name} className="flex items-center gap-1 pr-1">
                          {/* Indent guide + chevron for subtasks (mirrors TestCases). */}
                          {depth > 0 && (
                            <span aria-hidden style={{ width: depth * 16 }} className="shrink-0" />
                          )}
                          {hasChildren ? (
                            <button
                              type="button"
                              onClick={() => toggleCollapse(t.name)}
                              aria-label={isCollapsed ? 'Expand subtasks' : 'Collapse subtasks'}
                              className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {isCollapsed ? (
                                <ChevronRight className="size-4" />
                              ) : (
                                <ChevronDown className="size-4" />
                              )}
                            </button>
                          ) : (
                            <span className="w-5 shrink-0" aria-hidden />
                          )}
                          <button
                            type="button"
                            onClick={() => {
                              onChange(t.name)
                              setOpen(false)
                              setQuery('')
                            }}
                            className={cn(
                              'flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                              isSel ? 'bg-primary/5' : 'hover:bg-muted',
                            )}
                          >
                            <CheckboxIndicator checked={isSel} />
                            <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
                            <span className="flex min-w-0 flex-1 items-center gap-2">
                              <span className="shrink-0 font-mono text-xs font-medium">
                                {t.displayId ?? t.name}
                              </span>
                              {t.title && (
                                <span className="min-w-0 truncate text-xs text-muted-foreground">
                                  {t.title}
                                </span>
                              )}
                              {t.priority && (
                                <span
                                  className={cn(
                                    'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize',
                                    priorityClass(t.priority),
                                  )}
                                >
                                  {t.priority}
                                </span>
                              )}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** One numbered step header inside the setup card. */
function StepLabel({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[10px] font-semibold text-background">
        {n}
      </span>
      <span className="text-xs font-semibold tracking-tight">{title}</span>
      {hint && <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>}
    </div>
  )
}

export default function VerifyDesignPage() {
  const { activeProjectId, activeProject } = useProjects()
  const queryClient = useQueryClient()

  const { data: crawled, isLoading: crawledLoading } = useQuery({
    queryKey: ['crawled', activeProjectId],
    queryFn: () => listCrawledTickets(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  // Saved Design Check history — every run is recorded server-side (DB row + a
  // markdown report under <root>/design-check/).
  const { data: history } = useQuery({
    queryKey: ['design-checks', activeProjectId],
    queryFn: () => listDesignChecks(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  // The project's standard Design Check checklist (managed on /templates) is
  // auto-applied to every run by the server; surface whether one is configured.
  const { data: templates } = useQuery({
    queryKey: ['templates', activeProjectId],
    queryFn: () => listTemplates(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const savedChecklist = (templates ?? []).find((t) => t.key === 'design-check') ?? null
  const hasChecklist = !!savedChecklist

  const [folder, setFolder] = useState('')
  const [figmaUrl, setFigmaUrl] = useState('')
  const [instructions, setInstructions] = useState('')
  const [showInstructions, setShowInstructions] = useState(false)

  // Optional one-off checklist uploaded for this run; overrides the project one.
  const [template, setTemplate] = useState<{ name: string; content: string; size: number } | null>(
    null,
  )
  const [previewTemplate, setPreviewTemplate] = useState<{ name: string; content: string } | null>(
    null,
  )
  // Saved Design Check report opened from the history list.
  const [previewRecord, setPreviewRecord] = useState<DesignCheckRecord | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  function onPickTemplate(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_TEMPLATE_BYTES) {
      toast.error('Checklist too large', { description: 'Use a file under 200 KB.' })
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    const isExcel = /\.(xlsx|xls)$/i.test(file.name)
    if (isExcel) {
      // Excel is binary — parse the first sheet to CSV (lazy SheetJS) for clean text.
      reader.onload = async () => {
        try {
          const XLSX = await import('xlsx')
          const wb = XLSX.read(new Uint8Array(reader.result as ArrayBuffer), { type: 'array' })
          const sheet = wb.Sheets[wb.SheetNames[0]]
          const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : ''
          if (!csv.trim()) {
            toast.error('Could not read the Excel file', {
              description: 'The first sheet looks empty.',
            })
            return
          }
          const name = file.name.replace(/\.(xlsx|xls)$/i, '.csv')
          setTemplate({ name, content: csv, size: csv.length })
        } catch {
          toast.error('Could not read the Excel file', {
            description: 'Make sure it is a valid .xlsx or .xls.',
          })
        }
      }
      reader.onerror = () => toast.error('Could not read the Excel file')
      reader.readAsArrayBuffer(file)
      e.target.value = ''
      return
    }
    reader.onload = () => {
      setTemplate({ name: file.name, content: String(reader.result ?? ''), size: file.size })
    }
    reader.onerror = () =>
      toast.error('Could not read the checklist file', {
        description: 'Make sure it is a Markdown or CSV file.',
      })
    reader.readAsText(file)
    e.target.value = '' // allow re-picking the same file later
  }

  // Upload wins; otherwise fall back to the saved project checklist.
  const effectiveChecklist = template
    ? { name: template.name, content: template.content }
    : savedChecklist
      ? { name: 'design-check.md (project)', content: savedChecklist.content }
      : null
  const [model, setModel] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_KEY) ?? 'sonnet'
    } catch {
      return 'sonnet'
    }
  })
  function chooseModel(m: string) {
    setModel(m)
    try {
      localStorage.setItem(MODEL_KEY, m)
    } catch {
      /* ignore */
    }
  }
  const modelInfo = MODELS.find((m) => m.value === model) ?? MODELS[1]

  // The id of the background verify job we're tracking (server-side, survives
  // reload). Initialized from the per-project stored id so a reload reconnects.
  const [jobId, setJobId] = useState<string | null>(() => loadActiveJobId(activeProjectId))

  // Reset selection when the active project changes (and reconnect to that
  // project's stored job, if any).
  const [seen, setSeen] = useState(activeProjectId)
  if (seen !== activeProjectId) {
    setSeen(activeProjectId)
    setFolder('')
    setTemplate(null)
    setJobId(loadActiveJobId(activeProjectId))
  }

  // Start a server-side background job. It keeps running across browser reloads;
  // we poll it below, and the global VerifyJobWatcher announces completion even
  // when this page is unmounted.
  const start = useMutation({
    mutationFn: () =>
      startVerifyDesignJob({
        projectId: activeProjectId as string,
        folder,
        figmaUrl: figmaUrl.trim(),
        instructions: instructions.trim() || undefined,
        model,
        projectName: activeProject?.name,
        checklist: effectiveChecklist,
      }),
    onSuccess: ({ jobId: id }) => {
      setJobId(id)
      saveActiveJobId(activeProjectId as string, id)
    },
    onError: (err) =>
      toast.error('Could not start verification', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // Poll the tracked job until it finishes. Stops polling once terminal.
  const jobQuery = useQuery({
    queryKey: ['verify-job', jobId],
    queryFn: () => getVerifyDesignJob(jobId as string),
    enabled: !!jobId,
    retry: false,
    refetchInterval: (query) => (query.state.data?.job?.status === 'running' ? 1500 : false),
  })
  const job = jobQuery.data?.job ?? null
  const isRunning = job?.status === 'running'
  const elapsed = useElapsed(job?.createdAt ?? null, !!isRunning)
  // Completion (toast + bell notification + history refresh + clearing the stored
  // job id) is handled globally by <VerifyJobWatcher/>, so it fires even when this
  // page isn't mounted. This page just renders live progress + the findings.

  const cancel = useMutation({
    mutationFn: () => cancelVerifyDesignJob(jobId as string),
    onSuccess: (j) => {
      if (jobId) queryClient.setQueryData(['verify-job', jobId], j)
      toast.info('Verification cancelled')
    },
    onError: (err) =>
      toast.error('Could not cancel', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const tickets = useMemo(() => crawled ?? [], [crawled])
  const selectedTicket = tickets.find((t) => t.name === folder) ?? null
  // The parent to file findings under: the crawled ticket the check ran on. The
  // engineer can still paste a different one — the field is theirs once touched.
  const ticketUrlFor = (name: string) => tickets.find((t) => t.name === name)?.url ?? ''

  const figmaLooksWrong = figmaUrl.trim().length > 0 && !/figma\.com/i.test(figmaUrl)
  const canRun = !!activeProjectId && !!folder && !!figmaUrl.trim() && !start.isPending && !isRunning

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ScanSearch className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Design Check</h1>
            <p className="text-sm text-muted-foreground">
              Verify a ticket against its Figma design with AI.
            </p>
          </div>
        </header>
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted">
              <ScanSearch className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No project selected</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              Choose a project in the sidebar to start.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ScanSearch className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Design Check</h1>
            <p className="text-sm text-muted-foreground">
              Pick a crawled ticket and its Figma design — an AI model checks the design against the
              ticket, lists what matches and what doesn&apos;t, and files the gaps to ClickUp.
            </p>
          </div>
        </div>

        {/* What the NEXT check will judge against. The bar used to be headed
            "Checklist for <project>" over a templates path, which named neither the
            thing nor its state; it now leads with whether a project checklist exists,
            because that is the only question it can answer before a ticket is picked. */}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                  hasChecklist
                    ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    : 'border-border/60 bg-muted/60 text-muted-foreground',
                )}
              >
                <ListChecks className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Project checklist
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {hasChecklist ? 'Applied to every check' : 'None saved yet'}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                title={`${activeProject.rootPath}/testing/templates/design-check.md`}
              >
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/testing/templates</span>
              </span>
              <OpenFolderButton
                open={() => openTemplatesFolder(activeProjectId)}
                label="Design Check"
              />
            </div>
          </div>
        )}
      </header>

      <McpRequiredNotice required={['figma', 'playwright']} feature="run a Design Check" />

      {/* Setup — one card, three numbered steps, and a run bar that says what's missing.
          No overflow-hidden on the body: the ticket search popover is absolutely
          positioned inside it and must be able to extend past the card's edges. */}
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-5 p-5">
          {/* 1 — what to check */}
          <div className="space-y-3">
            <StepLabel n={1} title="What to check" />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Crawled ticket</label>
                <CrawledTicketPicker
                  tickets={tickets}
                  value={folder}
                  onChange={setFolder}
                  loading={crawledLoading}
                  disabled={isRunning}
                />
                {selectedTicket ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span className="font-mono font-medium text-foreground/80">
                      {selectedTicket.displayId ?? selectedTicket.name}
                    </span>
                    {selectedTicket.status && (
                      <span className="rounded-full border border-border/60 bg-muted/50 px-1.5 py-0.5 capitalize">
                        {selectedTicket.status}
                      </span>
                    )}
                    {selectedTicket.url && (
                      <a
                        href={selectedTicket.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
                      >
                        <ExternalLink className="size-3" />
                        Open in ClickUp
                      </a>
                    )}
                  </p>
                ) : (
                  !crawledLoading &&
                  tickets.length === 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      Crawl a ticket on the{' '}
                      <Link to="/tickets" className="text-primary underline-offset-2 hover:underline">
                        Tickets
                      </Link>{' '}
                      page first.
                    </p>
                  )
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Figma design link
                </label>
                <Input
                  value={figmaUrl}
                  onChange={(e) => setFigmaUrl(e.target.value)}
                  placeholder="https://www.figma.com/design/…"
                  autoComplete="off"
                  spellCheck={false}
                  className="h-10"
                />
                {figmaLooksWrong && (
                  <p className="flex items-center gap-1.5 text-[11px] text-amber-700">
                    <AlertTriangle className="size-3 shrink-0" />
                    That doesn&apos;t look like a figma.com link — the model may not be able to open
                    it.
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* 2 — criteria: the checklist, plus optional focus instructions */}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <StepLabel n={2} title="Criteria" hint="checklist + anything to focus on" />
            <input
              ref={fileInput}
              type="file"
              accept={TEMPLATE_ACCEPT}
              onChange={onPickTemplate}
              className="hidden"
            />
            {template ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/60 px-3 py-2">
                <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {template.name}
                  <span className="block text-[11px] text-muted-foreground">
                    One-off checklist — overrides the project one for this run.
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {(template.size / 1024).toFixed(1)} KB
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPreviewTemplate({ name: template.name, content: template.content })
                  }
                  className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Preview checklist"
                  title="Preview checklist"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setTemplate(null)}
                  className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Remove checklist"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : savedChecklist ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                <ListChecks className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="min-w-0 flex-1 text-sm">
                  Using the <span className="font-medium">project checklist</span>
                  <span className="block text-[11px] text-muted-foreground">
                    From{' '}
                    <Link to="/templates" className="underline-offset-2 hover:underline">
                      Settings → File templates
                    </Link>
                    , applied to every run. The model reports a finding for every item.
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPreviewTemplate({
                      name: 'design-check.md (project)',
                      content: savedChecklist.content,
                    })
                  }
                  className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  <Eye className="h-3.5 w-3.5" />
                  Preview
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  Override
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-border/60 px-3 py-2">
                <ListChecks className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 text-sm">
                  No checklist
                  <span className="block text-[11px] text-muted-foreground">
                    The check runs on the ticket alone. Upload one for this run, or save a reusable
                    one in{' '}
                    <Link to="/templates" className="underline-offset-2 hover:underline">
                      Settings → File templates
                    </Link>
                    .
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  <FileUp className="h-3.5 w-3.5" />
                  Upload checklist
                </Button>
              </div>
            )}

            {showInstructions || instructions ? (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">
                    Instructions <span className="font-normal">(optional)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => {
                      setInstructions('')
                      setShowInstructions(false)
                    }}
                    className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    Clear
                  </button>
                </div>
                <Textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="What to focus on, e.g. “Check responsive layout, button states, and copy against the spec. Ignore color tokens.”"
                  className="min-h-20 resize-y text-[13px]"
                />
              </div>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowInstructions(true)}
                className="h-8 rounded-full text-xs text-muted-foreground"
              >
                <PencilLine className="h-3.5 w-3.5" />
                Add instructions
              </Button>
            )}
          </div>

        </CardContent>

        {/* 3 — the run bar.
            A tinted footer welded to the card, not a third numbered step: the button
            used to float in the card's whitespace with its "what's missing" note in
            11px grey beneath it, and a control that starts a two-minute AI job should
            not be the quietest thing on the page. Readiness is stated as pills — what
            is satisfied, what is still needed, and that the checklist is optional —
            so the disabled button is never unexplained. `rounded-b-3xl` because the
            card deliberately has no overflow-hidden (the ticket popover escapes it). */}
        <div className="flex flex-col gap-3 rounded-b-3xl border-t border-border/60 bg-muted/60 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              {[
                { ok: !!folder, label: 'Ticket', optional: false },
                { ok: !!figmaUrl.trim(), label: 'Figma link', optional: false },
                { ok: !!effectiveChecklist, label: 'Checklist', optional: true },
              ].map((step) => (
                <span
                  key={step.label}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
                    step.ok
                      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                      : step.optional
                        ? 'text-muted-foreground/70'
                        : 'bg-background text-muted-foreground ring-1 ring-border/60',
                  )}
                >
                  {step.ok ? (
                    <Check className="size-3" />
                  ) : (
                    <span
                      aria-hidden
                      className="size-2 rounded-full ring-1 ring-current ring-offset-0"
                    />
                  )}
                  {step.label}
                  {!step.ok && step.optional && ' · optional'}
                </span>
              ))}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground">
              {isRunning
                ? 'Running — you can leave this page, it keeps going.'
                : !folder && !figmaUrl.trim()
                  ? 'Pick a crawled ticket and paste the Figma link to run.'
                  : !folder
                    ? 'Pick a crawled ticket to run.'
                    : !figmaUrl.trim()
                      ? 'Paste the Figma design link to run.'
                      : 'The model opens the Figma link with the project’s tools (Figma / Playwright MCP); without them it flags items as “not sure”.'}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={model} onValueChange={chooseModel} disabled={start.isPending || isRunning}>
              <SelectTrigger
                className="h-10 w-[13rem] gap-2 rounded-full border-border/60 bg-background shadow-none"
                title={modelInfo.description}
              >
                <Sparkles className="size-3.5 shrink-0 text-primary" />
                <SelectValue>
                  <span className="text-sm font-medium">{modelInfo.label}</span>
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-w-[20rem]">
                {MODELS.map((m) => (
                  <SelectItem key={m.value} value={m.value} className="items-start py-2">
                    <span className="flex flex-col gap-0.5">
                      <span className="text-xs font-medium">{m.label}</span>
                      <span className="text-[11px] leading-snug text-muted-foreground">
                        {m.description}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={() => start.mutate()}
              disabled={!canRun}
              size="lg"
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {start.isPending || isRunning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Verifying…
                </>
              ) : (
                <>
                  <ScanSearch className="size-4" />
                  Verify design
                </>
              )}
            </Button>
          </div>
        </div>
      </Card>

      {/* Live progress — the verify runs server-side, so this survives reload and
          navigating away (the global watcher announces completion either way). */}
      {job && (isRunning || job.status === 'error') && (
        <Card className="space-y-3 rounded-3xl border-border/60 p-4 shadow-none">
          <CardContent className="space-y-3 p-0">
            <div className="flex items-center gap-3">
              {isRunning ? (
                <Loader2 className="size-5 shrink-0 animate-spin text-primary" />
              ) : (
                <XCircle className="size-5 shrink-0 text-red-600" />
              )}
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {isRunning ? 'Verifying the design…' : 'Verification failed'}
                  {isRunning && elapsed && (
                    <span className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 font-mono text-[10px] font-normal tabular-nums text-muted-foreground">
                      {elapsed}
                    </span>
                  )}
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {isRunning
                    ? (job.logs[job.logs.length - 1]?.text ??
                      'The model is reading the ticket and inspecting the Figma design.')
                    : (job.error ?? 'Could not verify the design.')}
                </p>
                {isRunning && (
                  <p className="text-[11px] text-muted-foreground/80">
                    This can take a minute or two — you can leave this page, it keeps running.
                  </p>
                )}
              </div>
              {isRunning && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => cancel.mutate()}
                  disabled={cancel.isPending}
                  className="shrink-0 rounded-full text-destructive hover:text-destructive"
                >
                  {cancel.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Ban className="size-3.5" />
                  )}
                  Cancel
                </Button>
              )}
            </div>
            <JobLogPanel logs={job.logs} running={isRunning} />
          </CardContent>
        </Card>
      )}

      {job?.status === 'done' && job.result && (
        <FindingsPanel
          key={job.id}
          result={job.result}
          folder={job.folder}
          figmaUrl={job.figmaUrl}
          projectId={activeProjectId}
          parentTicketUrl={ticketUrlFor(job.folder)}
        />
      )}

      <HistoryCard
        records={history ?? []}
        projectId={activeProjectId}
        onSelect={setPreviewRecord}
      />

      <TemplatePreviewDialog
        template={previewTemplate}
        onOpenChange={(open) => !open && setPreviewTemplate(null)}
      />

      <ReportPreviewDialog
        record={previewRecord}
        projectId={activeProjectId}
        parentTicketUrl={previewRecord ? ticketUrlFor(previewRecord.folder) : ''}
        onOpenChange={(open) => !open && setPreviewRecord(null)}
      />
    </div>
  )
}
