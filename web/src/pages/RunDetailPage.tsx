import { cloneElement, isValidElement, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// The qc-testing skill writes report/issues with a single newline between labeled
// fields (AC / Steps / Expected / Actual / Business impact). Plain Markdown collapses
// those into one run-on paragraph, so remark-breaks turns each soft newline into a
// real line break — keeping each field on its own line. (Tables/lists are unaffected.)
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
import {
  AlertCircle,
  ArrowUpRight,
  ArrowLeft,
  Ban,
  CalendarClock,
  File as FileIcon,
  FileCode2,
  FileText,
  Files,
  Folder,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Send,
  Terminal,
  Timer,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import ContinueSessionPanel from '@/components/ContinueSessionPanel'
import {
  createClickupIssueSubtasks,
  deleteRun,
  getRun,
  listRunFiles,
  openRunFolder,
  runFileUrl,
  screenshotUrl,
  type ClickupTask,
  type RunFile,
} from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import type { LogEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

const prose =
  'max-w-none text-sm leading-relaxed text-foreground/90 ' +
  '[&_h1]:mb-3 [&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight first:[&_h1]:mt-0 ' +
  '[&_h2]:mb-2 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight ' +
  '[&_h2]:border-b [&_h2]:pb-1.5 first:[&_h2]:mt-0 ' +
  '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold ' +
  '[&_p]:my-3 [&_p]:leading-relaxed [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 ' +
  '[&_li]:my-1 [&_li]:marker:text-muted-foreground [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_strong]:font-semibold [&_strong]:text-foreground ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs ' +
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-zinc-100 ' +
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-zinc-100 ' +
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic ' +
  '[&_hr]:my-6 [&_hr]:border-border ' +
  // Table display + width are handled by the `table` component (a wrapper div with
  // overflow-x-auto + a real display:table that sizes columns to content), so here we
  // only style borders/spacing — NOT `block`/`w-full`, which would break auto column sizing.
  '[&_table]:my-5 [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:text-sm ' +
  '[&_thead_tr]:bg-muted/70 [&_th]:border-y [&_th]:border-r [&_th]:border-border [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground [&_th]:whitespace-nowrap first:[&_th]:rounded-l-lg first:[&_th]:border-l last:[&_th]:rounded-r-lg ' +
  // Columns size to their content. A max-width cap lets short columns (No, Priority,
  // Status) stay narrow while long free-text (Steps, Result) wraps instead of ballooning
  // the whole table. align-top + break-words keep multi-line cells readable.
  '[&_td]:max-w-[28rem] [&_td]:whitespace-normal [&_td]:break-words [&_td]:border-b [&_td]:border-r [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top first:[&_td]:border-l [&_tbody_tr:hover]:bg-muted/30 ' +
  '[&_td:first-child]:font-medium'

function MarkdownView({ md, empty, icon }: { md: string | null; empty: string; icon: React.ReactNode }) {
  if (!md) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    )
  }
  return (
    <div className={prose}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={mdTableComponents}>
        {md}
      </Markdown>
    </div>
  )
}

/**
 * Report tables list evidence as bare filenames (e.g. `ac2-bell-popover.png`,
 * `nc-main.md`). This renders the report markdown but turns any such filename that
 * maps to a real run output file into a clickable chip that opens the file in a
 * dialog viewer — so the engineer can inspect a screenshot/note without leaving
 * the Report tab or hunting through the Files/Screenshots tabs.
 */

// Filename-shaped tokens we attempt to resolve against the run's output files.
const EVIDENCE_TOKEN = /[\w.\-/]+\.(?:png|jpe?g|gif|webp|svg|md|txt|json|csv|log)/gi

function evidenceLinkClass(kind: RunFile['kind']): string {
  return cn(
    'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5',
    'align-middle font-mono text-[11px] leading-none transition-colors',
    'border-primary/30 bg-primary/5 text-primary hover:border-primary/50 hover:bg-primary/10',
    kind === 'image' && 'border-violet-500/30 bg-violet-500/5 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400',
  )
}

function EvidenceLink({ file, onOpen }: { file: RunFile; onOpen: (f: RunFile) => void }) {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <button type="button" onClick={() => onOpen(file)} className={evidenceLinkClass(file.kind)}>
      <span className="shrink-0">{fileKindIcon(file.kind)}</span>
      <span className="truncate">{name}</span>
    </button>
  )
}

/** Walk markdown-rendered children, swapping recognized evidence filenames for chips. */
function linkifyEvidence(
  node: React.ReactNode,
  byName: Map<string, RunFile>,
  onOpen: (f: RunFile) => void,
  keyPrefix = 'ev',
): React.ReactNode {
  if (typeof node === 'string') {
    if (!node.includes('.')) return node
    const parts: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    EVIDENCE_TOKEN.lastIndex = 0
    let i = 0
    while ((match = EVIDENCE_TOKEN.exec(node)) !== null) {
      const token = match[0]
      const file = byName.get((token.split('/').pop() ?? token).toLowerCase())
      if (!file) continue
      if (match.index > last) parts.push(node.slice(last, match.index))
      parts.push(<EvidenceLink key={`${keyPrefix}-${i++}`} file={file} onOpen={onOpen} />)
      last = match.index + token.length
    }
    if (parts.length === 0) return node
    if (last < node.length) parts.push(node.slice(last))
    return parts
  }
  if (Array.isArray(node)) {
    return node.map((child, idx) => linkifyEvidence(child, byName, onOpen, `${keyPrefix}-${idx}`))
  }
  if (isValidElement(node)) {
    const el = node as React.ReactElement<{ children?: React.ReactNode }>
    if (el.props?.children != null) {
      return cloneElement(el, {
        children: linkifyEvidence(el.props.children, byName, onOpen, keyPrefix),
      })
    }
  }
  return node
}

// Wrap every markdown table in a horizontal-scroll container and render a real
// display:table that AUTO-SIZES its columns to content (w-max), with a full-width
// floor (min-w-full) so a small table still fills the row and a wide one scrolls
// instead of cramming its columns. The per-cell max-width in `prose` keeps a long
// free-text column from ballooning. Shared by every Markdown renderer on this page.
const mdTableComponents: Components = {
  table: ({ children, className, ...props }) => (
    <div className="my-5 w-full overflow-x-auto">
      <table {...props} className={cn(className, '!my-0 w-max min-w-full')}>
        {children}
      </table>
    </div>
  ),
}

function EvidenceReport({
  md,
  empty,
  icon,
  projectId,
  slug,
  files,
}: {
  md: string | null
  empty: string
  icon: React.ReactNode
  projectId: string
  slug: string | null
  files: RunFile[]
}) {
  const [active, setActive] = useState<RunFile | null>(null)
  // basename → file, so a bare `nc-main.md` in a cell resolves to evidence/nc-main.md.
  const byName = useMemo(() => {
    const map = new Map<string, RunFile>()
    for (const f of files) {
      const name = f.path.split('/').pop()?.toLowerCase()
      if (name && !map.has(name)) map.set(name, f)
    }
    return map
  }, [files])

  if (!md) {
    return <MarkdownView md={md} empty={empty} icon={icon} />
  }

  return (
    <>
      <div className={prose}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          components={{
            ...mdTableComponents,
            td: ({ children, ...props }) => (
              <td {...props}>{linkifyEvidence(children, byName, setActive)}</td>
            ),
          }}
        >
          {md}
        </Markdown>
      </div>

      <Dialog open={!!active} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              {active && fileKindIcon(active.kind)}
              {active?.path.split('/').pop()}
            </DialogTitle>
          </DialogHeader>
          {active && slug && (
            <FilePreview projectId={projectId} slug={slug} file={active} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
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

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function formatDuration(start: string, end: string | null): string | null {
  if (!end) return null
  const a = new Date(start).getTime()
  const b = new Date(end).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  const secs = Math.round((b - a) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

type OutcomeKey = 'passed' | 'failed' | 'partial' | 'blocked'

type OutcomeDatum = {
  key: OutcomeKey
  label: string
  value: number
  color: string
  tone: string
}

const outcomeConfig: Record<OutcomeKey, Omit<OutcomeDatum, 'key' | 'value'>> = {
  passed: {
    label: 'Passed',
    color: '#10b981',
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  },
  failed: {
    label: 'Failed',
    color: '#ef4444',
    tone: 'bg-red-50 text-red-700 ring-red-200',
  },
  partial: {
    label: 'Partial',
    color: '#f59e0b',
    tone: 'bg-amber-50 text-amber-700 ring-amber-200',
  },
  blocked: {
    label: 'Blocked',
    color: '#64748b',
    tone: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
}

function emptyOutcomeCounts(): Record<OutcomeKey, number> {
  return { passed: 0, failed: 0, partial: 0, blocked: 0 }
}

function parseReportOutcomes(md: string | null, fallback: { passCount: number; failCount: number }) {
  const counts = emptyOutcomeCounts()

  if (md) {
    for (const line of md.split('\n')) {
      if (!line.includes('|')) continue
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
      if (cells.length < 2) continue

      // The count cell must be JUST a number (optionally bold) — otherwise rows
      // like `| Pass | TC-01 … |` in per-case tables would be misread as counts.
      if (!/^\*{0,2}\s*\d+\s*\*{0,2}$/.test(cells[1])) continue
      const label = cells[0].toLowerCase().replace(/[^a-z]/g, '')
      const value = Number.parseInt(cells[1].replace(/[^\d]/g, ''), 10)
      if (!Number.isFinite(value)) continue

      // Summary tables label rows "✅ Pass" or "Passed" depending on the report.
      if (label === 'pass' || label.includes('passed')) counts.passed = value
      else if (label === 'fail' || label.includes('failed')) counts.failed = value
      else if (label.includes('partial')) counts.partial = value
      else if (label.includes('blocked')) counts.blocked = value
    }
  }

  if (Object.values(counts).every((n) => n === 0)) {
    counts.passed = fallback.passCount
    counts.failed = fallback.failCount
  }

  const data = (Object.keys(counts) as OutcomeKey[]).map((key) => ({
    key,
    value: counts[key],
    ...outcomeConfig[key],
  }))
  const total = data.reduce((sum, item) => sum + item.value, 0)
  const passRate = total > 0 ? Math.round((counts.passed / total) * 100) : null
  const attention = counts.failed + counts.partial + counts.blocked

  return { counts, data, total, passRate, attention }
}

type ParsedIssue = {
  id: string
  title: string
  description: string
}

function stripMd(value: string): string {
  return value
    .replace(/[`*_#[\]]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseIssues(md: string | null): ParsedIssue[] {
  if (!md?.trim()) return []
  const lines = md.split('\n')
  const sections: { title: string; body: string[] }[] = []
  let current: { title: string; body: string[] } | null = null

  for (const line of lines) {
    const heading = line.match(/^(#{2,4})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const title = stripMd(heading[2])
      const isIssueHeading =
        level === 2 &&
        (/^issue[-\s#]*\d+/i.test(title) || /^defect[-\s#]*\d+/i.test(title))
      if (isIssueHeading) {
        if (current) sections.push(current)
        current = { title, body: [] }
        continue
      }
      if (level === 2 && current) {
        sections.push(current)
        current = null
      }
    }
    if (current) current.body.push(line)
  }
  if (current) sections.push(current)

  const fromSections = sections
    .map((section, index) => ({
      id: `issue-${index}`,
      title: section.title.slice(0, 140),
      description: [section.title, '', section.body.join('\n').trim()].filter(Boolean).join('\n'),
    }))
    .filter((issue) => issue.title.length > 0)

  if (fromSections.length > 0) return fromSections.slice(0, 20)

  const tableRows = lines
    .filter((line) => /^\|.+\|$/.test(line.trim()) && !/^\|?\s*:?-{3,}/.test(line.trim()))
    .map((line) =>
      line
        .split('|')
        .map((cell) => stripMd(cell))
        .filter(Boolean),
    )
  if (tableRows.length > 1) {
    const headers = tableRows[0].map((h) => h.toLowerCase())
    const titleIndex = Math.max(
      headers.findIndex((h) => h.includes('issue')),
      headers.findIndex((h) => h.includes('title')),
      headers.findIndex((h) => h.includes('defect')),
    )
    return tableRows
      .slice(1)
      .map((cells, index) => {
        const title = cells[titleIndex >= 0 ? titleIndex : 0] || `QC issue ${index + 1}`
        return {
          id: `issue-table-${index}`,
          title: title.slice(0, 140),
          description: cells.join(' | '),
        }
      })
      .slice(0, 20)
  }

  const firstContent = lines.find((line) => stripMd(line).length > 0)
  return [
    {
      id: 'issue-full',
      title: stripMd(firstContent ?? 'QC issue').slice(0, 140),
      description: md.trim().slice(0, 6000),
    },
  ]
}

/** A compact key/value pair for the run's meta strip (started, finished, output…). */
function MetaInline({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {label}
        </div>
        <div className="truncate text-xs font-medium">{children}</div>
      </div>
    </div>
  )
}

/** Circular pass-rate gauge — the single headline metric for a run with results. */
function PassRateDonut({ rate, color }: { rate: number | null; color: string }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const dash = ((rate ?? 0) / 100) * circumference

  return (
    <div className="relative flex size-40 shrink-0 items-center justify-center">
      <svg viewBox="0 0 128 128" className="size-40 -rotate-90">
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="12"
          stroke="currentColor"
          className="text-muted"
        />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="12"
          strokeLinecap="round"
          stroke={color}
          strokeDasharray={`${dash} ${circumference}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-semibold tabular-nums tracking-tight">
          {rate === null ? '—' : `${rate}%`}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          pass rate
        </span>
      </div>
    </div>
  )
}

/** Outcome cards + a single segmented bar — the full pass/fail/partial/blocked split. */
function OutcomeBreakdown({ data, total }: { data: OutcomeDatum[]; total: number }) {
  return (
    <div className="flex w-full flex-col justify-center gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {data.map((item) => {
          const pct = total > 0 ? Math.round((item.value / total) * 100) : 0
          return (
            <div key={item.key} className={cn('rounded-2xl px-3 py-2.5 ring-1', item.tone)}>
              <div className="text-2xl font-semibold tabular-nums leading-none">{item.value}</div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide">
                <span>{item.label}</span>
                <span className="tabular-nums opacity-70">{pct}%</span>
              </div>
            </div>
          )
        })}
      </div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        title={data.map((d) => `${d.label} ${d.value}`).join(' · ')}
      >
        {data.map((item) =>
          item.value > 0 && total > 0 ? (
            <span
              key={item.key}
              className="h-full transition-[width] duration-500"
              style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.color }}
            />
          ) : null,
        )}
      </div>
    </div>
  )
}

function IssueClickupPanel({
  issuesMd,
  projectId,
  ticketId,
}: {
  issuesMd: string | null
  projectId: string
  ticketId: string
}) {
  const issues = parseIssues(issuesMd)
  const [parentTask, setParentTask] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(issues.map((issue) => issue.id)))
  const [created, setCreated] = useState<ClickupTask[]>([])

  const selectedIssues = issues.filter((issue) => selected.has(issue.id))
  const mutation = useMutation({
    mutationFn: () =>
      createClickupIssueSubtasks({
        parentTask,
        projectId,
        issues: selectedIssues.map((issue) => ({
          title: issue.title,
          description: [
            issue.description,
            '',
            `Source: QC run ${ticketId}`,
          ].join('\n'),
        })),
      }),
    onSuccess: (result) => {
      setCreated((prev) => [...result.created, ...prev])
      toast.success(`Created ${result.created.length} ClickUp subtask${result.created.length === 1 ? '' : 's'}`)
    },
    onError: (err) => {
      toast.error('Could not create ClickUp subtasks', {
        description: err instanceof Error ? err.message : 'ClickUp request failed.',
      })
    },
  })

  if (issues.length === 0) return null

  const allSelected = selected.size === issues.length

  return (
    <div className="mb-6 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
      <div className="border-b border-border/60 bg-muted/60 px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Send className="size-4" />
              Review issues and create ClickUp subtasks
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Paste the parent ClickUp ticket URL, pick issues, then create them inside that ticket's
              subtask list.
            </p>
          </div>
          <span className="w-fit rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
            {selectedIssues.length} selected
          </span>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <Input
            value={parentTask}
            onChange={(event) => setParentTask(event.target.value)}
            placeholder="Paste ClickUp ticket URL, e.g. https://app.clickup.com/t/86eut664j"
            className="h-10 rounded-full"
          />
          <Button
            onClick={() => mutation.mutate()}
            disabled={!parentTask.trim() || selectedIssues.length === 0 || mutation.isPending}
            className="min-w-40 rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Create subtasks
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(issues.map((issue) => issue.id)))
            }
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {allSelected ? 'Clear selection' : 'Select all'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Review the parsed issue cards before creating ClickUp subtasks.
          </span>
        </div>

        <div className="grid gap-3">
          {issues.map((issue, index) => {
            const checked = selected.has(issue.id)
            return (
              <label
                key={issue.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-2xl border border-border/60 p-3 transition-colors',
                  checked ? 'border-primary/30 bg-primary/5' : 'bg-muted/60 hover:bg-muted/40',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (event.target.checked) next.add(issue.id)
                      else next.delete(issue.id)
                      return next
                    })
                  }}
                  className="mt-1 size-4 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      #{index + 1}
                    </span>
                    <p className="font-medium leading-5">{issue.title}</p>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                    {issue.description}
                  </p>
                </div>
              </label>
            )
          })}
        </div>

        {created.length > 0 && (
          <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Created subtasks
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {created.map((task) => (
                <a
                  key={task.id}
                  href={task.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:text-primary"
                >
                  {task.displayId}
                  <ArrowUpRight className="size-3" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Numeric count badge shown on a tab trigger (e.g. Log 51). */
function TabBadge({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none transition-colors',
        n === 0
          ? 'bg-muted/60 text-muted-foreground/50'
          : active
            ? 'bg-primary/15 text-primary'
            : 'bg-muted-foreground/10 text-muted-foreground',
      )}
    >
      {n}
    </span>
  )
}

/** Presence dot for content tabs that aren't countable (report / issues markdown). */
function PresenceDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full transition-colors',
        on ? 'bg-emerald-500' : 'bg-muted-foreground/30',
      )}
    />
  )
}

/** A single content tab: icon + label + a count badge or presence dot. */
function TabItem({
  value,
  icon,
  label,
  count,
  present,
  active,
}: {
  value: TabValue
  icon: React.ReactNode
  label: string
  count?: number
  present?: boolean
  active: boolean
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'group min-h-9 flex-none gap-2 rounded-xl px-3.5 font-medium text-muted-foreground',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        'hover:text-foreground',
      )}
    >
      <span className="text-muted-foreground/70 transition-colors group-data-[state=active]:text-foreground">
        {icon}
      </span>
      {label}
      {count !== undefined ? (
        <TabBadge n={count} active={active} />
      ) : (
        <PresenceDot on={!!present} />
      )}
    </TabsTrigger>
  )
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileKindIcon(kind: RunFile['kind']) {
  if (kind === 'image') return <ImageIcon className="size-3.5" />
  if (kind === 'markdown') return <FileText className="size-3.5" />
  if (kind === 'text') return <FileCode2 className="size-3.5" />
  return <FileIcon className="size-3.5" />
}

/** Preview a single output file: markdown rendered, images inline, text as a block. */
function FilePreview({ projectId, slug, file }: { projectId: string; slug: string; file: RunFile }) {
  const url = runFileUrl(projectId, slug, file.path)
  const isText = file.kind === 'markdown' || file.kind === 'text'
  const { data, isLoading, isError } = useQuery({
    queryKey: ['run-file', projectId, slug, file.path],
    queryFn: () =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      }),
    enabled: isText,
  })

  if (file.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={file.path}
          className="max-h-[70vh] w-full rounded-2xl border border-border/60 bg-muted/30 object-contain shadow-none"
        />
      </a>
    )
  }
  if (file.kind === 'other') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <FileIcon className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No preview for this file type.</p>
        <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
          <a href={url} target="_blank" rel="noreferrer">
            Open file
          </a>
        </Button>
      </div>
    )
  }
  if (isLoading) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
  }
  if (isError) {
    return <p className="py-12 text-center text-sm text-destructive">Could not load this file.</p>
  }
  if (file.kind === 'markdown') {
    return (
      <div className={prose}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={mdTableComponents}>
          {data ?? ''}
        </Markdown>
      </div>
    )
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-relaxed shadow-none">
      {data}
    </pre>
  )
}

/** A file browser for the run's output folder (evidence + any extra files). */
function FilesTab({
  projectId,
  slug,
  files,
}: {
  projectId: string
  slug: string | null
  files: RunFile[]
}) {
  const [sel, setSel] = useState<string | null>(null)
  const active = files.find((f) => f.path === sel) ?? files[0] ?? null

  if (!slug || files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
          <Files className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">No extra evidence files for this run.</p>
      </div>
    )
  }

  return (
    <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card shadow-none lg:grid-cols-[18rem_1fr]">
      <ul className="max-h-[34rem] space-y-1 overflow-auto border-b border-border/60 bg-muted/25 p-2 lg:border-b-0 lg:border-r">
        {files.map((f) => {
          const isActive = active?.path === f.path
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setSel(f.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-background text-foreground ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span className="shrink-0">{fileKindIcon(f.kind)}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                  {humanSize(f.size)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="min-w-0 p-4">
        {active && <FilePreview projectId={projectId} slug={slug} file={active} />}
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-24 rounded-full bg-muted" />
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-48 rounded-xl bg-muted" />
          <div className="h-6 w-20 rounded-full bg-muted" />
        </div>
        <div className="h-4 w-64 rounded bg-muted" />
      </div>
      <div className="h-56 rounded-3xl bg-muted" />
      <div className="h-72 rounded-3xl bg-muted" />
    </div>
  )
}

const TAB_VALUES = ['report', 'issues', 'screenshots', 'files', 'log'] as const
type TabValue = (typeof TAB_VALUES)[number]

export default function RunDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { data: run, isLoading, isError, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => getRun(id),
    enabled: !!id,
  })
  // Output files (evidence etc.) for the Files tab + Open-folder button.
  const { data: filesData } = useQuery({
    queryKey: ['run-files', id],
    queryFn: () => listRunFiles(id),
    enabled: !!id,
  })

  // Delete the run (record + on-disk output) and return to history.
  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(id),
    onSuccess: () => {
      toast.success('Test result deleted')
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      setConfirmDelete(false)
      navigate('/history')
    },
    onError: (err) => {
      toast.error('Could not delete this run', {
        description: err instanceof Error ? err.message : 'Delete failed.',
      })
    },
  })

  if (isLoading) {
    return <DetailSkeleton />
  }

  if (isError || !run) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2 rounded-full transition-all duration-200 active:scale-[0.98]">
          <Link to="/history">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to history
          </Link>
        </Button>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Could not load this run</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : 'Run not found'}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
              <Link to="/history">Back to history</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const duration = formatDuration(run.createdAt, run.finishedAt)
  const isFail = run.status === 'failed' || run.status === 'error'
  const isCanceled = run.status === 'canceled'
  // A still-running run is using its session/output — deletion is blocked until it ends.
  const isRunActive =
    run.status === 'running' || run.status === 'queued' || run.status === 'paused'
  const outcomes = parseReportOutcomes(run.reportMd, run)
  const hasResults = outcomes.total > 0
  const passRate = outcomes.passRate

  // Land on the first tab that actually has content. A canceled/errored run often
  // has only a log, so defaulting to an empty "Report" tab hides the useful part.
  const defaultTab: TabValue = run.reportMd
    ? 'report'
    : run.issuesMd
      ? 'issues'
      : run.screenshots.length > 0
        ? 'screenshots'
        : 'log'

  // The active tab lives in the URL (?tab=…) so each tab is linkable/back-able.
  const tabParam = searchParams.get('tab')
  const activeTab: TabValue =
    tabParam && (TAB_VALUES as readonly string[]).includes(tabParam)
      ? (tabParam as TabValue)
      : defaultTab
  const onTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', value)
        return next
      },
      { replace: true },
    )
  }

  // Headline outcome accent: green = passed, red = fail/error, neutral otherwise.
  const accentColor = isFail ? '#ef4444' : run.status === 'passed' ? '#10b981' : '#64748b'
  const headline =
    run.status === 'passed'
      ? 'Ready for sign-off'
      : isFail
        ? 'Needs attention'
        : 'Review required'

  // Files for the Files tab — exclude report/issues/screenshots (own tabs already).
  const filesSlug = filesData?.slug ?? run.slug
  const evidenceFiles = (filesData?.files ?? []).filter(
    (f) => f.path !== 'report.md' && f.path !== 'issues.md' && !f.path.startsWith('screenshots/'),
  )

  return (
    <div className="space-y-6">
      {/* Hero — identity, actions, and the single consolidated result summary. */}
      <section className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
        <div className="space-y-5 px-6 pb-6 pt-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-3">
              <Button asChild variant="ghost" size="sm" className="-ml-3 h-8 rounded-full transition-all duration-200 active:scale-[0.98]">
                <Link to="/history">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  History
                </Link>
              </Button>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-mono text-3xl font-semibold tracking-tight sm:text-4xl">
                  {run.ticketId}
                </h1>
                <StatusBadge status={run.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                Acceptance test report
                {run.projectName && (
                  <>
                    {' · '}
                    <span className="font-medium text-foreground">{run.projectName}</span>
                  </>
                )}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
                <a href={run.appUrl} target="_blank" rel="noreferrer">
                  Open app
                  <ArrowUpRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              {filesSlug && <OpenFolderButton open={() => openRunFolder(run.id)} label="run output" />}
              {!isRunActive && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-full text-destructive transition-all duration-200 hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive active:scale-[0.98]"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              )}
            </div>
          </div>

          {/* Result summary — donut + breakdown when results exist, else an explainer. */}
          {hasResults ? (
            <div className="flex flex-col items-center gap-6 rounded-2xl border border-border/60 bg-muted/40 p-5 md:flex-row md:items-stretch md:gap-8">
              <div className="flex flex-col items-center justify-center gap-2 md:border-r md:border-border/60 md:pr-8">
                <PassRateDonut rate={passRate} color={accentColor} />
                <div className="text-center">
                  <div className="text-sm font-semibold tracking-tight">{headline}</div>
                  <div className="text-xs text-muted-foreground">
                    {outcomes.total} acceptance criteria
                  </div>
                </div>
              </div>
              <OutcomeBreakdown data={outcomes.data} total={outcomes.total} />
            </div>
          ) : (
            // No pass/fail recorded — explain why instead of showing a row of zeros.
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-4 py-10 text-center">
              <span
                className={cn(
                  'flex size-11 items-center justify-center rounded-full',
                  isFail
                    ? 'bg-red-100 text-red-600'
                    : isCanceled
                      ? 'bg-amber-100 text-amber-600'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {isFail ? (
                  <AlertCircle className="size-5" />
                ) : isCanceled ? (
                  <Ban className="size-5" />
                ) : (
                  <ListChecks className="size-5" />
                )}
              </span>
              <p className="text-sm font-medium">
                {isCanceled
                  ? 'Run was canceled'
                  : isFail
                    ? 'Run did not complete'
                    : 'No acceptance criteria evaluated'}
              </p>
              <p className="max-w-md text-xs text-muted-foreground">
                {isCanceled
                  ? 'It was stopped before any acceptance criteria were checked. See the log for what ran.'
                  : isFail
                    ? 'The run ended early, so no pass/fail results were recorded. Check the log for details.'
                    : 'This run recorded no acceptance criteria.'}
              </p>
            </div>
          )}
        </div>

        {/* Meta strip — context that supports the result, kept low-key in the footer. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/60 bg-muted/30 px-6 py-4 sm:grid-cols-3 xl:grid-cols-5">
          <MetaInline icon={<CalendarClock className="h-4 w-4" />} label="Started">
            <span className="font-mono" title={formatDate(run.createdAt)}>
              {formatDate(run.createdAt)}
            </span>
          </MetaInline>
          <MetaInline icon={<CalendarClock className="h-4 w-4" />} label="Finished">
            <span className="font-mono" title={formatDate(run.finishedAt)}>
              {formatDate(run.finishedAt)}
            </span>
          </MetaInline>
          <MetaInline icon={<Timer className="h-4 w-4" />} label="Duration">
            <span className="font-mono">{duration ?? '—'}</span>
          </MetaInline>
          <MetaInline icon={<Globe className="h-4 w-4" />} label="App URL">
            <a
              href={run.appUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-primary underline-offset-2 hover:underline"
              title={run.appUrl}
            >
              {run.appUrl}
            </a>
          </MetaInline>
          {filesSlug && (
            <MetaInline icon={<Folder className="h-4 w-4" />} label="Output">
              <span className="font-mono" title={`testing/${filesSlug}`}>
                testing/{filesSlug}
              </span>
            </MetaInline>
          )}
        </div>
      </section>

      {run.hasSession && (
        <ContinueSessionPanel runId={run.id} runStatus={run.status} hasSession={run.hasSession} />
      )}

      {/* Content tabs */}
      <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
        <CardContent className="px-0">
          <Tabs value={activeTab} onValueChange={onTabChange}>
            <div className="sticky top-0 z-10 border-b border-border/60 bg-card/95 px-5 py-3 backdrop-blur">
              <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-2xl bg-muted/70 p-1.5">
                <TabItem
                  value="report"
                  icon={<FileText className="size-4" />}
                  label="Report"
                  present={!!run.reportMd}
                  active={activeTab === 'report'}
                />
                <TabItem
                  value="issues"
                  icon={<AlertCircle className="size-4" />}
                  label="Issues"
                  present={!!run.issuesMd}
                  active={activeTab === 'issues'}
                />
                <TabItem
                  value="screenshots"
                  icon={<ImageIcon className="size-4" />}
                  label="Screenshots"
                  count={run.screenshots.length}
                  active={activeTab === 'screenshots'}
                />
                <TabItem
                  value="files"
                  icon={<Files className="size-4" />}
                  label="Files"
                  count={evidenceFiles.length}
                  active={activeTab === 'files'}
                />
                <TabItem
                  value="log"
                  icon={<Terminal className="size-4" />}
                  label="Log"
                  count={run.logTail.length}
                  active={activeTab === 'log'}
                />
              </TabsList>
            </div>

            <TabsContent value="report" className="m-0 p-6">
              <EvidenceReport
                md={run.reportMd}
                empty="No report was generated for this run."
                icon={<FileText className="h-5 w-5" />}
                projectId={run.projectId}
                slug={filesSlug}
                files={filesData?.files ?? []}
              />
            </TabsContent>

            <TabsContent value="issues" className="m-0 p-6">
              <IssueClickupPanel
                issuesMd={run.issuesMd}
                projectId={run.projectId}
                ticketId={run.ticketId}
              />
              <MarkdownView
                md={run.issuesMd}
                empty="No issues were logged for this run."
                icon={<AlertCircle className="h-5 w-5" />}
              />
            </TabsContent>

            <TabsContent value="screenshots" className="m-0 p-6">
              {run.screenshots.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                  <p className="text-sm text-muted-foreground">No screenshots were captured.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {run.screenshots.map((path) => {
                    const src = screenshotUrl(run.projectId, run.slug ?? '', path)
                    const name = path.split('/').pop() ?? path
                    return (
                      <a
                        key={path}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className="group overflow-hidden rounded-2xl border border-border/60 bg-card shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.98]"
                      >
                        <div className="overflow-hidden">
                          <img
                            src={src}
                            alt={`Screenshot ${name}`}
                            loading="lazy"
                            className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                          />
                        </div>
                        <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate font-mono" title={name}>
                            {name}
                          </span>
                        </div>
                      </a>
                    )
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="files" className="m-0 p-6">
              <FilesTab projectId={run.projectId} slug={filesSlug} files={evidenceFiles} />
            </TabsContent>

            <TabsContent value="log" className="m-0 p-6">
              <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-none">
                <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
                  <span className="flex gap-1.5" aria-hidden>
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
                  </span>
                  <span className="ml-1 font-mono text-[11px] tracking-wide text-zinc-500">
                    qc-testing · event log
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-zinc-600">
                    {run.logTail.length} {run.logTail.length === 1 ? 'event' : 'events'}
                  </span>
                </div>
                <ScrollArea className="h-96 p-4">
                  <div className="space-y-1 font-mono text-xs leading-relaxed">
                    {run.logTail.length === 0 && (
                      <div className="flex items-center gap-2 text-zinc-500">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600" />
                        No log entries.
                      </div>
                    )}
                    {run.logTail.map((e, i) => (
                      <div key={i} className={cn(logLineClass(e.kind))}>
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
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Delete confirmation — removes the run record AND its on-disk output folder. */}
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => !deleteMutation.isPending && setConfirmDelete(open)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              Delete test result?
            </DialogTitle>
            <DialogDescription className="pt-1">
              This permanently deletes run{' '}
              <span className="font-mono font-medium text-foreground">{run.ticketId}</span> — its
              report, issues, screenshots, and evidence on disk
              {filesSlug && (
                <>
                  {' '}
                  (<span className="font-mono">testing/{filesSlug}</span>)
                </>
              )}
              , plus its history entry and log. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 size-4" />
              )}
              Delete result
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
