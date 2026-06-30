import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronsUpDown,
  Clock,
  Eye,
  FileText,
  FileUp,
  FolderGit2,
  FolderTree,
  HelpCircle,
  History,
  ListChecks,
  Loader2,
  MessageCircleQuestion,
  ScanSearch,
  Search,
  Sparkles,
  Terminal,
  Ticket,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
  icon: typeof CheckCircle2
  // tile/badge classes
  text: string
  chip: string
  ring: string
}

const CATEGORY: Record<FindingCategory, CategoryMeta> = {
  match: {
    label: 'Matches',
    icon: CheckCircle2,
    text: 'text-emerald-700',
    chip: 'bg-emerald-100 text-emerald-700 ring-emerald-600/20',
    ring: 'border-emerald-300/60 bg-emerald-50/40',
  },
  mismatch: {
    label: "Doesn't match",
    icon: XCircle,
    text: 'text-red-700',
    chip: 'bg-red-100 text-red-700 ring-red-600/20',
    ring: 'border-red-300/60 bg-red-50/40',
  },
  concern: {
    label: 'Concern',
    icon: AlertTriangle,
    text: 'text-amber-700',
    chip: 'bg-amber-100 text-amber-700 ring-amber-600/20',
    ring: 'border-amber-300/60 bg-amber-50/40',
  },
  unsure: {
    label: 'Not sure',
    icon: HelpCircle,
    text: 'text-slate-600',
    chip: 'bg-slate-100 text-slate-600 ring-slate-500/20',
    ring: 'border-slate-300/60 bg-slate-50/60',
  },
  discuss: {
    label: 'Needs discussion',
    icon: MessageCircleQuestion,
    text: 'text-violet-700',
    chip: 'bg-violet-100 text-violet-700 ring-violet-600/20',
    ring: 'border-violet-300/60 bg-violet-50/40',
  },
}
const CATEGORY_ORDER: FindingCategory[] = ['mismatch', 'concern', 'discuss', 'unsure', 'match']

function FindingCard({ finding }: { finding: DesignFinding }) {
  const meta = CATEGORY[finding.category]
  const Icon = meta.icon
  return (
    <div className={cn('flex gap-3 rounded-2xl border px-3 py-2.5', meta.ring)}>
      <Icon className={cn('mt-0.5 size-4 shrink-0', meta.text)} />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium leading-snug">{finding.title}</p>
        {finding.detail && (
          <p className="text-[13px] leading-snug text-muted-foreground">{finding.detail}</p>
        )}
      </div>
    </div>
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

function Results({ result }: { result: VerifyJobResult }) {
  const counts = result.findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.category] = (acc[f.category] ?? 0) + 1
    return acc
  }, {})
  const present = CATEGORY_ORDER.filter((c) => (counts[c] ?? 0) > 0)

  return (
    <div className="space-y-5">
      {/* Overall verdict + per-category tally */}
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-3 py-4">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium leading-snug">
                {result.summary || 'Verification complete.'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {result.findings.length} finding{result.findings.length === 1 ? '' : 's'} · model{' '}
                {result.model}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_ORDER.map((c) => {
              const meta = CATEGORY[c]
              const Icon = meta.icon
              const n = counts[c] ?? 0
              return (
                <span
                  key={c}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1',
                    n > 0 ? meta.chip : 'bg-muted/60 text-muted-foreground/70 ring-transparent',
                  )}
                >
                  <Icon className="size-3.5" />
                  {n} {meta.label}
                </span>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Findings grouped by category, most actionable first */}
      {present.map((c) => {
        const meta = CATEGORY[c]
        const Icon = meta.icon
        const items = result.findings.filter((f) => f.category === c)
        return (
          <section key={c} className="space-y-2">
            <div className="flex items-center gap-2">
              <Icon className={cn('size-4', meta.text)} />
              <h3 className="text-sm font-semibold tracking-tight">{meta.label}</h3>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </div>
            <div className="space-y-2">
              {items.map((f, i) => (
                <FindingCard key={`${c}-${i}`} finding={f} />
              ))}
            </div>
          </section>
        )
      })}
    </div>
  )
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

/** Saved Design Check history — one row per recorded run (DB + on-disk report). */
function HistoryCard({
  records,
  projectId,
  onSelect,
}: {
  records: DesignCheckRecord[]
  projectId: string
  onSelect: (record: DesignCheckRecord) => void
}) {
  if (records.length === 0) return null
  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
        <History className="h-4 w-4 text-muted-foreground" />
        Saved design checks
        <span className="text-xs font-normal text-muted-foreground">{records.length}</span>
        <div className="ml-auto">
          <OpenFolderButton open={() => openDesignCheckFolder(projectId)} label="design checks" />
        </div>
      </div>
      <ul className="divide-y">
        {records.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onSelect(r)}
              className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/40"
              title="View report"
            >
              <div className="flex w-full items-center gap-2">
                <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                  {r.folder}
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  <Clock className="size-3" />
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                <Eye className="size-3.5 shrink-0 text-muted-foreground" />
              </div>
              {r.summary && (
                <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">
                  {r.summary}
                </p>
              )}
              <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
                <HistoryCountChips counts={r.counts} />
                {r.filePath && (
                  <span className="inline-flex min-w-0 items-center gap-1 font-mono text-[10px] text-muted-foreground/70">
                    <FileText className="size-3 shrink-0" />
                    <span className="truncate">{r.filePath}</span>
                  </span>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Read-only dialog that previews a saved Design Check report (reuses Results). */
function ReportPreviewDialog({
  record,
  onOpenChange,
}: {
  record: DesignCheckRecord | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={!!record} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[60rem]">
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
            <Results
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

/** Color-code a ClickUp priority into our status palette (mirrors the TestCases page). */
function priorityClass(priority: string): string {
  const p = priority.toLowerCase()
  if (p === 'urgent') return 'border-red-200 bg-red-50 text-red-700'
  if (p === 'high') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (p === 'normal') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-border bg-muted text-muted-foreground' // low / unknown
}

/** Group crawled tickets by ClickUp status, "No status" last (mirrors TestCases). */
function groupCrawledByStatus(
  tickets: CrawledTicket[],
): { status: string; tickets: CrawledTicket[] }[] {
  const map = new Map<string, CrawledTicket[]>()
  for (const t of tickets) {
    const key = t.status?.trim() || ''
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  return [...map.entries()]
    .map(([status, items]) => ({ status, tickets: items }))
    .sort((a, b) => {
      if (!a.status) return 1
      if (!b.status) return -1
      return a.status.localeCompare(b.status)
    })
}

/**
 * Searchable single-select crawled-ticket picker. A Select-like trigger that opens
 * a panel with a search box + status-grouped rows, styled to match the ticket list
 * on the TestCases page. Closes on outside-click / Escape / selection.
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
  const filtered = tickets.filter((t) =>
    `${t.name} ${t.displayId ?? ''} ${t.title ?? ''}`.toLowerCase().includes(q),
  )
  const groups = groupCrawledByStatus(filtered)

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
          'flex h-9 w-full items-center gap-2 rounded-xl border border-border/60 bg-transparent px-3 py-1 text-sm shadow-none transition-colors',
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
                className="h-11 rounded-full pl-9 text-sm shadow-none"
              />
            </div>
          </div>
          <div className="max-h-72 overflow-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                {tickets.length === 0 ? 'No crawled tickets.' : `No tickets match “${query}”.`}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.status || '∅'}>
                  {/* Sticky status header — same treatment as the TestCases list. */}
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/80 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
                      {group.status || 'No status'}
                    </span>
                    <span className="text-[11px] font-medium text-muted-foreground/70">
                      {group.tickets.length}
                    </span>
                    <span className="h-px flex-1 bg-border/60" aria-hidden />
                  </div>
                  <ul>
                    {group.tickets.map((t) => {
                      const isSel = t.name === value
                      return (
                        <li key={t.name}>
                          <button
                            type="button"
                            onClick={() => {
                              onChange(t.name)
                              setOpen(false)
                              setQuery('')
                            }}
                            className={cn(
                              'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                              isSel ? 'bg-primary/5' : 'hover:bg-muted',
                            )}
                          >
                            <span
                              className={cn(
                                'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
                                isSel
                                  ? 'border-primary bg-primary text-primary-foreground'
                                  : 'border-muted-foreground/40',
                              )}
                              aria-hidden
                            >
                              {isSel && <Check className="size-3" />}
                            </span>
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

  // Optional one-off checklist uploaded for this run; overrides the project one.
  const [template, setTemplate] = useState<{ name: string; content: string; size: number } | null>(
    null,
  )
  const [previewTemplate, setPreviewTemplate] = useState<{ name: string; content: string } | null>(
    null,
  )
  // Saved Design Check report opened from the history list (read-only preview).
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

  const tickets = crawled ?? []
  const canRun = !!activeProjectId && !!folder && !!figmaUrl.trim() && !start.isPending && !isRunning

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Design Check</h1>
          <p className="text-sm text-muted-foreground">
            Verify a ticket against its Figma design with AI.
          </p>
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
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ScanSearch className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Design Check</h1>
            <p className="text-sm text-muted-foreground">
              Pick a crawled ticket and its Figma design — an AI model checks the design against the
              ticket and lists what matches, what doesn't, and what needs discussion.
            </p>
          </div>
        </div>

        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
            <span className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Checklist for
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
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
                <span
                  className={cn(
                    'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    hasChecklist ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {hasChecklist ? 'exists' : 'new'}
                </span>
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

      {/* No overflow-hidden here: the Crawled-ticket search popover is absolutely
          positioned inside this card and must be able to extend past its edges. */}
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-4 p-4">
          {/* Ticket + Figma link */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Crawled ticket</label>
              <CrawledTicketPicker
                tickets={tickets}
                value={folder}
                onChange={setFolder}
                loading={crawledLoading}
              />
              {!crawledLoading && tickets.length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Crawl a ticket on the{' '}
                  <Link to="/tickets" className="text-primary underline-offset-2 hover:underline">
                    Tickets
                  </Link>{' '}
                  page first.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Figma design link</label>
              <Input
                value={figmaUrl}
                onChange={(e) => setFigmaUrl(e.target.value)}
                placeholder="https://www.figma.com/design/…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Instructions <span className="font-normal">(optional)</span>
            </label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="What to focus on, e.g. “Check responsive layout, button states, and copy against the spec. Ignore color tokens.”"
              className="min-h-24 resize-y text-[13px]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Checklist — same standalone card style as the TestCase page's Template card. */}
      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          Checklist
          <span className="text-xs font-normal text-muted-foreground">optional</span>
        </div>
        <CardContent className="space-y-3 p-4">
          <input
            ref={fileInput}
            type="file"
            accept={TEMPLATE_ACCEPT}
            onChange={onPickTemplate}
            className="hidden"
          />
            {template ? (
              <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/60 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{template.name}</span>
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
              <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="min-w-0 flex-1 text-sm">
                  Using <span className="font-medium">project checklist</span>
                  <span className="block text-[11px] text-muted-foreground">
                    From{' '}
                    <Link to="/templates" className="underline-offset-2 hover:underline">
                      Settings → File templates
                    </Link>
                    , applied to every run. Preview it, or upload to override for this run.
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
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInput.current?.click()}
                className="w-full justify-center rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                <FileUp className="h-4 w-4" />
                Upload checklist
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Markdown, CSV, or Excel (.md, .csv, .xlsx). The model verifies each item and reports a
              finding for it.{' '}
              {!template && !savedChecklist && (
                <>
                  Set a reusable one in{' '}
                  <Link to="/templates" className="underline-offset-2 hover:underline">
                    Settings → File templates
                  </Link>
                  .
                </>
              )}
            </p>
        </CardContent>
      </Card>

      {/* Model + run */}
      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">AI model</label>
              <Select value={model} onValueChange={chooseModel} disabled={start.isPending || isRunning}>
                <SelectTrigger className="w-56 gap-2 rounded-full">
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
            </div>
            <Button
              onClick={() => start.mutate()}
              disabled={!canRun}
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
          <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
            <Sparkles className="mt-0.5 size-3 shrink-0 text-primary/70" />
            <span>
              {modelInfo.description} The model opens the Figma link with the project's tools
              (Figma / Playwright MCP) if available; otherwise it flags items as “not sure”.
            </span>
          </p>
        </CardContent>
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
                <p className="text-sm font-medium">
                  {isRunning ? 'Verifying the design…' : 'Verification failed'}
                </p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {isRunning
                    ? 'The model is reading the ticket and inspecting the Figma design. This can take a minute or two — you can leave this page.'
                    : (job.error ?? 'Could not verify the design.')}
                </p>
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

      {job?.status === 'done' && job.result && <Results result={job.result} />}

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
        onOpenChange={(open) => !open && setPreviewRecord(null)}
      />
    </div>
  )
}
