import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  Ban,
  ClipboardList,
  Clock,
  ExternalLink,
  Eye,
  FileText,
  FileUp,
  FolderGit2,
  FolderTree,
  Globe,
  Info,
  ListChecks,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  Ticket,
  Trash2,
  Undo2,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ManageRulesDialog } from '@/components/ManageRulesDialog'
import {
  cancelTestCaseJob,
  deleteTestCaseVersion,
  deleteTestcaseRows,
  editTestcaseRow,
  insertTestcaseRow,
  getTestCaseJob,
  getTestCaseVersion,
  listCrawledTickets,
  listTemplates,
  listTestCaseVersions,
  openTicketsFolder,
  pauseTestCaseJob,
  resumeTestCaseJob,
  startTestCaseJob,
  type CrawledTicket,
  type TestCaseJob,
  type TestCaseLogLine,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { GuideTour, type TourStep } from '@/components/GuideTour'
import { buildInstructions, useTestRules } from '@/lib/testRules'
import { useProjects } from '@/lib/project-context'
import {
  addActiveJobId,
  loadActiveJobIds,
  removeActiveJobId,
} from '@/lib/activeTestcaseJobs'

// Template formats we accept: Markdown, CSV, and Excel. Excel is binary — we parse
// its first sheet to CSV in the browser (see onPickTemplate) before feeding Claude.
const TEMPLATE_ACCEPT = '.md,.csv,.xlsx,.xls'
const MAX_TEMPLATE_BYTES = 200 * 1024 // keep uploads sane; server caps chars too

// Cap how many tickets can be generated at once. Each ticket is a separate Claude
// run, so a small batch keeps each result focused — the model isn't sharing one
// limited context window across many tickets.
const MAX_TICKETS = 5

// Which Claude model drafts the test cases — mirrors the crawl picker on /tickets.
// Trade speed/cost against depth. Persisted per the user's last choice.
const MODEL_KEY = 'qc.testcaseModel'
const TESTCASE_MODELS: { value: string; label: string; description: string }[] = [
  {
    value: 'haiku',
    label: 'Haiku · fast',
    description: 'Fastest & cheapest. Best for simple, well-specified tickets.',
  },
  {
    value: 'sonnet',
    label: 'Sonnet · balanced',
    description: 'Thorough coverage with good edge cases. Recommended default.',
  },
  {
    value: 'opus',
    label: 'Opus · deep',
    description: 'Deepest analysis for long, complex or ambiguous tickets. Slower, pricier.',
  },
]

// How many generation jobs a project can run at the same time. Each job is a
// separate Claude run, so this lets a QC engineer fire off another ticket without
// waiting for the first to finish.
const MAX_PARALLEL_JOBS = 3
// The active background job ids are remembered per project (a JSON array) so a
// browser reload — or navigating away and back — reconnects to every still-running
// server-side job. The global TestCaseJobWatcher drops each id as it finishes.

/** A toggleable rule chip; hover shows the full instruction it adds. */
function RuleChip({
  label,
  hint,
  selected,
  onToggle,
}: {
  label: string
  hint: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-all duration-200 active:scale-[0.97]',
            selected
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
          )}
        >
          {selected ? <Check className="size-3" /> : <Plus className="size-3" />}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-none whitespace-nowrap">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

/** Compact relative time, e.g. "just now", "3h ago", "2d ago". */
function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** Full, human date + time a version was generated, e.g. "Jul 1, 2026, 3:42 PM". */
function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Shared markdown styling — mirrors the Overview page so output renders consistently.
const MD_CLASS = cn(
  'text-sm leading-relaxed',
  '[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_p]:my-2.5 [&_p]:text-muted-foreground',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1 [&_li]:text-muted-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-xs [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-zinc-100',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
  '[&_hr]:my-5 [&_hr]:border-border',
  // Table styling lives on MD_TABLE_WRAP below (per-table scroll container) so a
  // markdown test-case table pins its header row + first column like the CSV view.
)

// Each markdown table is wrapped in its own scroll box: header row pinned on vertical
// scroll, first ("No") column pinned on horizontal scroll — matching the CSV preview.
const MD_TABLE_WRAP = cn(
  'my-3 max-h-[70vh] overflow-auto rounded-2xl border border-border/60',
  '[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:whitespace-nowrap [&_th]:border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold',
  '[&_th:first-child]:left-0 [&_th:first-child]:z-30',
  '[&_td]:border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-xs',
  '[&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-muted [&_tbody_td:first-child]:font-medium [&_tbody_td:first-child]:text-foreground',
)

/** react-markdown renderers: wrap every table so it scrolls with a sticky header + first column. */
const MD_COMPONENTS: Components = {
  table({ node: _node, className: _className, ...props }) {
    return (
      <div className={MD_TABLE_WRAP}>
        <table {...props} className="w-max min-w-full border-collapse text-left text-xs" />
      </div>
    )
  },
}

/** Parse RFC-4180-ish CSV into rows of cells (handles quotes, "" escapes, multi-line cells). */
function parseCsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  rows.push(row)
  // Drop trailing rows that are entirely empty (CSVs often end with blank lines).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
  return rows
}

/** A cell the user clicked to edit: absolute CSV row (0 = header), column index. */
interface CellRef {
  row: number
  col: number
  value: string
  column: string
}

/**
 * Renders CSV test cases as a scrollable table, trimming fully-empty trailing columns.
 * When `onCellClick` is supplied, body cells become interactive (hover + selectable)
 * so a QC engineer can edit one cell manually.
 */
function CsvTable({
  csv,
  onCellClick,
  onDeleteRow,
  selectedCell,
}: {
  csv: string
  onCellClick?: (cell: CellRef) => void
  /** When set, each data row shows a hover-revealed delete button (absRow = parsed-CSV index, 1-based). */
  onDeleteRow?: (absRow: number) => void
  selectedCell?: { row: number; col: number } | null
}) {
  const rows = parseCsv(csv)
  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Empty CSV.</p>
  }
  // Find the last column index that holds any content, so the trailing ",,,," padding
  // some exports carry doesn't render as a row of empty columns.
  let cols = 1
  for (const r of rows) {
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i].trim() !== '') {
        cols = Math.max(cols, i + 1)
        break
      }
    }
  }
  const [head, ...body] = rows
  const idx = Array.from({ length: cols }, (_, i) => i)
  const interactive = !!onCellClick
  return (
    // w-max lets the table grow past the container so overflow-auto gives a real
    // horizontal scrollbar; min-w-full keeps it filling narrow tables. max-h caps the
    // body so the sticky header row has room to pin against on vertical scroll.
    <div className="max-h-[70vh] overflow-auto rounded-2xl border border-border/60">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {idx.map((i) => (
              <th
                key={i}
                className={cn(
                  'sticky top-0 min-w-[12rem] whitespace-nowrap border bg-muted px-3 py-2 text-left font-semibold',
                  // first column stays pinned on horizontal scroll; corner sits above both.
                  i === 0 ? 'left-0 z-30' : 'z-20',
                )}
              >
                {head[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => {
            const absRow = ri + 1 // header is row 0 in the parsed CSV
            return (
              <tr key={ri} className="even:bg-muted/20">
                {idx.map((ci) => {
                  const isSel =
                    !!selectedCell && selectedCell.row === absRow && selectedCell.col === ci
                  return (
                    <td
                      key={ci}
                      onClick={
                        interactive
                          ? () =>
                              onCellClick?.({
                                row: absRow,
                                col: ci,
                                value: r[ci] ?? '',
                                column: (head[ci] ?? '').trim() || `Column ${ci + 1}`,
                              })
                          : undefined
                      }
                      title={interactive ? 'Click to edit this test case' : undefined}
                      className={cn(
                        'min-w-[12rem] max-w-[34rem] whitespace-pre-wrap break-words border px-3 py-2 align-top text-muted-foreground',
                        // Pinned first column: solid bg so other columns can't bleed
                        // through it while scrolling horizontally.
                        ci === 0 && 'group sticky left-0 z-10 bg-muted font-medium text-foreground',
                        // Room for the hover delete button in the pinned first cell.
                        ci === 0 && onDeleteRow && 'pr-9',
                        interactive && 'cursor-pointer transition-colors hover:bg-primary/5',
                        // Selection styling wins over the pinned-column bg.
                        isSel && 'bg-primary/10 text-foreground ring-2 ring-inset ring-primary',
                      )}
                    >
                      {r[ci] ?? ''}
                      {ci === 0 && onDeleteRow && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onDeleteRow(absRow)
                          }}
                          title="Delete this test case"
                          className="absolute right-1 top-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-destructive/10 hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Heuristic: does this template look like CSV? (by extension, or a comma-y header). */
function looksLikeCsv(name: string, content: string): boolean {
  const n = name.toLowerCase()
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return true
  const first = content.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
  if (first.startsWith('#') || first.startsWith('|')) return false
  return (first.match(/,/g)?.length ?? 0) >= 2
}

/** Read-only dialog that previews a template file — CSV as a table, else raw text. */
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
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]">
        <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{template?.name}</span>
          </DialogTitle>
          <DialogDescription>
            Template Claude will match when writing the cases.
            {isCsv ? ' Shown as a table.' : ''}
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

// Remember the last live app URL per project so the Generate dialog can prefill the
// "set for all" field — QC engineers usually test many tickets against one staging URL.
/** Looks like a usable http(s) URL? (light client check; the server re-validates). */
function isLikelyUrl(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  try {
    const u = new URL(t)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The "Generate" confirmation dialog. Previews the selected tickets and lets the QC
 * engineer paste an optional live app URL per ticket — when set, Claude opens that
 * URL to ground the cases in the real running app; blank means ticket-only.
 */
function GenerateDialog({
  open,
  onOpenChange,
  tickets,
  appUrls,
  onChangeUrl,
  onApplyAll,
  onConfirm,
  pending,
  modelLabel,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tickets: CrawledTicket[]
  appUrls: Record<string, string>
  onChangeUrl: (folder: string, url: string) => void
  onApplyAll: (url: string) => void
  onConfirm: () => void
  pending: boolean
  modelLabel: string
}) {
  // Always starts blank — a live app URL is opt-in per generation. Reset each time
  // the dialog opens so a value typed earlier in the session doesn't linger.
  const [allUrl, setAllUrl] = useState('')
  useEffect(() => {
    if (open) setAllUrl('')
  }, [open])
  const count = tickets.length
  const withUrl = tickets.filter((t) => (appUrls[t.name] ?? '').trim()).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 space-y-1.5 border-b border-border/60 bg-muted/30 px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" />
            Generate test cases
          </DialogTitle>
          <DialogDescription>
            {count} ticket{count === 1 ? '' : 's'} selected. Optionally paste a live{' '}
            <span className="font-medium text-foreground">app URL</span> for each — Claude opens it
            and grounds the cases in the real running app. Leave blank to generate from the ticket
            alone.
          </DialogDescription>
        </DialogHeader>

        {count > 1 && (
          <div className="shrink-0 space-y-1.5 border-b border-border/60 px-5 py-3">
            <label className="text-xs font-medium text-muted-foreground">Set one URL for all</label>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={allUrl}
                  onChange={(e) => setAllUrl(e.target.value)}
                  placeholder="https://staging.example.com/feature"
                  className="h-11 rounded-full pl-9 shadow-none"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onApplyAll(allUrl.trim())}
                disabled={!allUrl.trim()}
                className="shrink-0 rounded-full"
              >
                Apply to all
              </Button>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-2 overflow-auto px-5 py-3">
          {tickets.map((t) => {
            const url = appUrls[t.name] ?? ''
            const invalid = url.trim().length > 0 && !isLikelyUrl(url)
            return (
              <div
                key={t.name}
                className="space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 font-mono text-xs font-medium">
                    {t.displayId ?? t.name}
                  </span>
                  {t.title && (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {t.title}
                    </span>
                  )}
                  {(url.trim() ? isLikelyUrl(url) : false) && (
                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                      <Globe className="size-2.5" />
                      checks app
                    </span>
                  )}
                </div>
                <div className="relative">
                  <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={url}
                    onChange={(e) => onChangeUrl(t.name, e.target.value)}
                    placeholder="App URL (optional) — https://…"
                    className={cn('h-9 pl-9', invalid && 'border-amber-400 focus-visible:ring-amber-400')}
                  />
                </div>
                {invalid && (
                  <p className="text-[11px] text-amber-600">
                    Doesn't look like an http(s) URL — it'll be ignored unless corrected.
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <DialogFooter className="shrink-0 items-center gap-2 border-t border-border/60 bg-muted/20 px-5 py-3 sm:justify-between">
          <span className="mr-auto text-xs text-muted-foreground">
            {withUrl > 0 ? `${withUrl}/${count} will check the live app` : 'Ticket-only generation'}{' '}
            · model <span className="font-medium text-foreground">{modelLabel}</span>
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
              className="rounded-full"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              Generate ({count})
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Filter the crawled list by test-case presence. The user wants to quickly see
// which tickets still need cases drafted vs. which already have them.
type TcFilter = 'all' | 'with' | 'without'
const TC_FILTERS: { value: TcFilter; label: string }[] = [
  { value: 'all', label: 'All tickets' },
  { value: 'with', label: 'With test cases' },
  { value: 'without', label: 'Without test cases' },
]

/** Group crawled tickets by their ClickUp status, preserving order within a group.
 *  Groups are sorted by status name with the "No status" bucket last, so the list
 *  reads top-down by workflow stage. */
function groupByStatus(tickets: CrawledTicket[]): { status: string; tickets: CrawledTicket[] }[] {
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
      if (!a.status) return 1 // "No status" sinks to the bottom
      if (!b.status) return -1
      return a.status.localeCompare(b.status)
    })
}

/** Color-code a ClickUp priority into our status palette (urgent→red … low→muted). */
function priorityClass(priority: string): string {
  const p = priority.toLowerCase()
  if (p === 'urgent') return 'border-red-200 bg-red-50 text-red-700'
  if (p === 'high') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (p === 'normal') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-border bg-muted text-muted-foreground' // low / unknown
}

/** A single-select crawled-ticket row, with a "test cases ready" badge + preview.
 *  `depth` indents nested subtasks; a chevron toggles a parent's children. */
function TicketRow({
  ticket,
  selected,
  onSelect,
  onView,
  depth = 0,
  hasChildren = false,
  isOpen = false,
  onToggleExpand,
}: {
  ticket: CrawledTicket
  selected: boolean
  onSelect: () => void
  onView: () => void
  depth?: number
  hasChildren?: boolean
  isOpen?: boolean
  onToggleExpand?: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 pr-2 transition-colors',
        selected ? 'bg-primary/5' : 'hover:bg-muted',
      )}
    >
      {/* Indent guide for nested subtasks + a chevron on parents. */}
      {depth > 0 && <span aria-hidden style={{ width: depth * 16 }} className="shrink-0" />}
      {hasChildren ? (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={isOpen ? 'Collapse subtasks' : 'Expand subtasks'}
          className="flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
      ) : (
        <span className="w-5 shrink-0" aria-hidden />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground"
      >
        <span
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40',
          )}
          aria-hidden
        >
          {selected && <Check className="size-3" />}
        </span>
        <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-medium">
            {ticket.displayId ?? ticket.name}
          </span>
          {ticket.title && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{ticket.title}</span>
          )}
          {ticket.priority && (
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize',
                priorityClass(ticket.priority),
              )}
            >
              {ticket.priority}
            </span>
          )}
        </span>
      </button>
      {ticket.url && (
        <a
          href={ticket.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open in ClickUp"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {ticket.hasTestcases ? (
        <button
          type="button"
          onClick={onView}
          title="Preview generated test cases"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
        >
          <CheckCircle2 className="size-3" />
          {ticket.testcaseVersions > 1
            ? `${ticket.testcaseVersions} versions`
            : 'Test cases'}
          <Eye className="size-3" />
        </button>
      ) : ticket.crawledAt ? (
        <span className="shrink-0 px-1 text-[11px] text-muted-foreground">
          {timeAgo(ticket.crawledAt)}
        </span>
      ) : null}
    </div>
  )
}

/** Read-only dialog that previews a ticket's test-case versions, one at a time. */
function TestCasePreviewDialog({
  folder,
  projectId,
  onOpenChange,
}: {
  folder: string | null
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const { data: list } = useQuery({
    queryKey: ['testcase-versions', projectId, folder],
    queryFn: () => listTestCaseVersions(folder as string, projectId),
    enabled: !!folder,
  })
  const versions = list?.versions ?? []
  const latest = versions[0]?.version ?? null

  // The CSV cell the user clicked to edit manually. Reset whenever the
  // version/folder changes (below).
  // Clicking any cell opens a dialog to edit the WHOLE test case (that row); the
  // dialog auto-scrolls to the clicked column. `editingRow` is the absolute CSV row
  // (0 = header); `focusCol` is the column index to scroll to / focus.
  const [editingRow, setEditingRow] = useState<number | null>(null)
  const [rowHeader, setRowHeader] = useState<string[]>([])
  const [rowDraft, setRowDraft] = useState<string[]>([])
  const [focusCol, setFocusCol] = useState<number | null>(null)
  // The data row (absolute parsed-CSV index, 1-based) queued for deletion — drives the
  // confirm dialog. Reset alongside the row editor on any version/folder change.
  const [pendingDeleteRow, setPendingDeleteRow] = useState<number | null>(null)
  // The most recently deleted row, kept so an inline "Undo" banner can restore it.
  // (A toast action isn't reliably clickable behind the modal preview dialog.)
  const [lastDeleted, setLastDeleted] = useState<{
    version: number
    row: number
    values: string[]
    label: string
  } | null>(null)
  function resetRow() {
    setEditingRow(null)
    setRowHeader([])
    setRowDraft([])
    setFocusCol(null)
    setPendingDeleteRow(null)
    setLastDeleted(null)
  }

  // Default the selected version to the latest; re-default when the folder or the
  // latest version changes (e.g. a new version was just generated).
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null)
  const [seenKey, setSeenKey] = useState<string | null>(null)
  const key = `${folder}|${latest}`
  if (seenKey !== key) {
    setSeenKey(key)
    setSelectedVersion(latest)
    resetRow()
  }

  const { data, isFetching } = useQuery({
    queryKey: ['testcase-version', projectId, folder, selectedVersion],
    queryFn: () => getTestCaseVersion(folder as string, selectedVersion as number, projectId),
    enabled: !!folder && selectedVersion != null,
  })

  // Metadata (incl. savedAt) for the currently-selected version — drives the
  // "Generated <date time>" label in the header.
  const selectedMeta = versions.find((v) => v.version === selectedVersion) ?? null

  // In the row editor, hide execution/result columns: everything from the first
  // "Actual result" column onward (Actual result, Status, …) is filled during test
  // execution, not while authoring the case. -1 = no such column (show all).
  const resultColStart = rowHeader.findIndex((h) => /actual\s*result/i.test(h.trim()))

  // Delete the selected version. Two-step confirm (inline) to avoid a nested modal.
  const queryClient = useQueryClient()

  // Save EVERY field of one test case (the clicked row) verbatim — overwrites the
  // same version on disk, then refetches it.
  const editRow = useMutation({
    mutationFn: () =>
      editTestcaseRow({
        projectId,
        folder: folder as string,
        version: selectedVersion as number,
        row: editingRow as number,
        values: rowDraft,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['testcase-version', projectId, folder, selectedVersion],
      })
      queryClient.invalidateQueries({ queryKey: ['testcase-versions', projectId, folder] })
      resetRow()
      toast.success('Test case updated')
    },
    onError: (err) =>
      toast.error('Could not update test case', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // Restore a previously-deleted row by inserting its captured values back at the
  // same index — the "Undo" action on the delete toast.
  const restoreRow = useMutation({
    mutationFn: (vars: { version: number; row: number; values: string[] }) =>
      insertTestcaseRow({
        projectId,
        folder: folder as string,
        version: vars.version,
        row: vars.row,
        values: vars.values,
      }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({
        queryKey: ['testcase-version', projectId, folder, vars.version],
      })
      queryClient.invalidateQueries({ queryKey: ['testcase-versions', projectId, folder] })
      queryClient.invalidateQueries({ queryKey: ['crawled', projectId] })
      setLastDeleted(null)
      toast.success('Test case restored')
    },
    onError: (err) =>
      toast.error('Could not restore test case', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // Delete one test-case row (absolute parsed-CSV index, 1-based). `pendingDeleteRow`
  // (declared above with the row-editor state) holds the row while the confirm dialog
  // is open so an accidental click can't drop a case. The row's values + index + version
  // are captured in the mutation variables so the success toast can offer an Undo.
  const delRow = useMutation({
    mutationFn: (vars: { version: number; row: number; values: string[] }) =>
      deleteTestcaseRows({
        projectId,
        folder: folder as string,
        version: vars.version,
        rows: [vars.row],
      }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({
        queryKey: ['testcase-version', projectId, folder, vars.version],
      })
      queryClient.invalidateQueries({ queryKey: ['testcase-versions', projectId, folder] })
      queryClient.invalidateQueries({ queryKey: ['crawled', projectId] })
      setPendingDeleteRow(null)
      const label = [vars.values[0], vars.values[1]].filter((v) => v && v.trim()).join(' · ')
      // Surface an inline Undo banner (reliably clickable inside the modal dialog).
      setLastDeleted({ ...vars, label })
      toast.success(label ? `Deleted “${label}”` : 'Test case deleted')
    },
    onError: (err) =>
      toast.error('Could not delete test case', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // When the row dialog opens, scroll the clicked column's field into view + focus it.
  useEffect(() => {
    if (editingRow == null || focusCol == null) return
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`tc-row-field-${focusCol}`) as HTMLTextAreaElement | null
      if (!el) return
      el.scrollIntoView({ block: 'center' })
      el.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [editingRow, focusCol])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const del = useMutation({
    mutationFn: () => deleteTestCaseVersion(folder as string, selectedVersion as number, projectId),
    onSuccess: () => {
      setConfirmDelete(false)
      const deleted = selectedVersion
      const remaining = versions.filter((v) => v.version !== deleted)
      // Refresh the version list (this dialog) and the crawled-tickets badge count.
      queryClient.invalidateQueries({ queryKey: ['testcase-versions', projectId, folder] })
      queryClient.invalidateQueries({ queryKey: ['crawled', projectId] })
      toast.success(`Deleted v${deleted}`)
      if (remaining.length === 0) {
        onOpenChange(false) // nothing left to show
      } else {
        // Point at the newest remaining version (the list is latest-first).
        setSelectedVersion(remaining[0].version)
        setSeenKey(`${folder}|${remaining[0].version}`)
      }
    },
    onError: (err) =>
      toast.error('Could not delete', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <>
      <Dialog
        open={!!folder}
        onOpenChange={(open) => {
          if (!open) resetRow()
          onOpenChange(open)
        }}
      >
        <DialogContent
          className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]"
          // The row-editor and delete-confirm dialogs live in their own portals, so
          // interacting with them (and the focus restore when they close) registers as
          // an "outside" interaction here and would dismiss this preview too. Never
          // close the preview from an outside interaction — it still closes via its X
          // button or Escape. (A state guard can't catch the focus-out fired AFTER the
          // nested dialog's state has already been cleared.)
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <ClipboardList className="h-4 w-4 text-muted-foreground" />
              <span className="truncate font-mono text-sm">{folder}</span>
            </DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              {versions.length > 0 ? (
                <>
                  <span>
                    {versions.length} version{versions.length === 1 ? '' : 's'}
                  </span>
                  <Select
                    value={selectedVersion != null ? String(selectedVersion) : undefined}
                    onValueChange={(v) => {
                      setSelectedVersion(Number(v))
                      setConfirmDelete(false)
                      resetRow()
                    }}
                  >
                    <SelectTrigger size="sm" className="h-7 w-44 rounded-full">
                      <SelectValue placeholder="Pick a version" />
                    </SelectTrigger>
                    <SelectContent>
                      {versions.map((v, i) => (
                        <SelectItem key={v.version} value={String(v.version)}>
                          {v.label}
                          {v.format === 'csv' ? ' · CSV' : ''}
                          {i === 0 ? ' · latest' : ''}
                          {v.savedAt ? ` · ${formatDateTime(v.savedAt)}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* Full date + time the selected version was generated. */}
                  {selectedMeta?.savedAt && (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground"
                      title={`Generated ${formatDateTime(selectedMeta.savedAt)}`}
                    >
                      <Clock className="size-3.5" />
                      Generated {formatDateTime(selectedMeta.savedAt)}
                    </span>
                  )}
                </>
              ) : (
                <span>No versions yet</span>
              )}

              {/* Right-aligned actions: open the ticket's testcases folder + delete. */}
              <span className="ml-auto inline-flex items-center gap-2">
                {folder && (
                  <OpenFolderButton
                    open={() => openTicketsFolder(projectId, folder)}
                    label="test cases"
                  />
                )}
                {/* Delete the selected version — inline two-step confirm. */}
                {versions.length > 0 &&
                  selectedVersion != null &&
                  (confirmDelete ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">
                        Delete v{selectedVersion}?
                      </span>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => del.mutate()}
                        disabled={del.isPending}
                      >
                        {del.isPending ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="h-3.5 w-3.5" />
                        )}
                        Confirm
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmDelete(false)}
                        disabled={del.isPending}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setConfirmDelete(true)}
                      title={`Delete v${selectedVersion}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  ))}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
            {lastDeleted && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Trash2 className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Deleted{lastDeleted.label ? ` “${lastDeleted.label}”` : ' a test case'}.
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 rounded-full border-amber-300 bg-white/70 text-amber-800 hover:bg-white"
                  onClick={() => lastDeleted && restoreRow.mutate(lastDeleted)}
                  disabled={restoreRow.isPending}
                >
                  {restoreRow.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Undo2 className="size-3.5" />
                  )}
                  Undo
                </Button>
                <button
                  type="button"
                  onClick={() => setLastDeleted(null)}
                  title="Dismiss"
                  className="shrink-0 rounded-md p-1 text-amber-700/70 transition-colors hover:bg-amber-100 hover:text-amber-900"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {isFetching && !data ? (
              <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading…
              </p>
            ) : data?.testcases ? (
              data.format === 'csv' ? (
                <div className="space-y-2.5">
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    Click any cell to edit the whole test case, or click the trash icon on a row to
                    delete it.
                  </p>
                  <CsvTable
                    csv={data.testcases}
                    onCellClick={(cell) => {
                      // Any cell → edit every field of this test-case row, scrolled to
                      // the clicked column.
                      const rows = parseCsv(data.testcases ?? '')
                      const header = rows[0] ?? []
                      const vals = rows[cell.row] ?? []
                      setRowHeader(header)
                      setRowDraft(header.map((_, i) => vals[i] ?? ''))
                      setEditingRow(cell.row)
                      setFocusCol(cell.col)
                    }}
                    onDeleteRow={(absRow) => setPendingDeleteRow(absRow)}
                  />
                </div>
              ) : looksLikeCsv('x.md', data.testcases) ? (
                // Safety net: the version is stored as Markdown but its content is really
                // CSV (an older file, or a model that emitted the other format). Render it
                // as a read-only table instead of a collapsed run-on markdown paragraph.
                // Non-interactive — cell editing needs a real .csv version on disk.
                <CsvTable csv={data.testcases} />
              ) : (
                <div className={MD_CLASS}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                    {data.testcases}
                  </ReactMarkdown>
                </div>
              )
            ) : (
              <p className="py-12 text-center text-sm text-muted-foreground">
                No test cases found for this ticket.
              </p>
            )}
          </div>

        </DialogContent>
      </Dialog>

      {/* Row (whole test-case) editor — a SEPARATE Dialog so it centers on the
          viewport and stacks above the preview, instead of being clipped inside the
          preview's transformed content box. */}
      <Dialog
        open={editingRow != null && data?.format === 'csv'}
        onOpenChange={(open) => {
          if (!open && !editRow.isPending) resetRow()
        }}
      >
        <DialogContent
          className="flex max-h-[88vh] w-[95vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 px-6 py-4">
            <DialogTitle className="text-lg">Edit test case</DialogTitle>
            <DialogDescription className="truncate">
              {(rowHeader[0]?.trim() || 'Row')}: {rowDraft[0]?.trim() || `Row ${editingRow}`}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            {rowHeader.map((h, i) => {
              // Hide execution/result columns (from "Actual result" to the end) —
              // those are filled during test execution, not while authoring.
              if (resultColStart !== -1 && i >= resultColStart) return null
              return (
                <div key={i} className="space-y-1.5">
                  <label
                    htmlFor={`tc-row-field-${i}`}
                    className={cn(
                      'block text-xs font-semibold',
                      focusCol === i ? 'text-primary' : 'text-foreground',
                    )}
                  >
                    {h.trim() || `Column ${i + 1}`}
                  </label>
                  <Textarea
                    id={`tc-row-field-${i}`}
                    value={rowDraft[i] ?? ''}
                    onChange={(e) =>
                      setRowDraft((prev) => {
                        const next = [...prev]
                        next[i] = e.target.value
                        return next
                      })
                    }
                    rows={i === 0 ? 1 : 3}
                    className={cn(
                      'resize-y font-mono text-sm',
                      focusCol === i && 'ring-2 ring-primary/40',
                    )}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault()
                        editRow.mutate()
                      }
                    }}
                  />
                </div>
              )
            })}
          </div>

          <DialogFooter className="border-t border-border/60 px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={resetRow}
              disabled={editRow.isPending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={() => editRow.mutate()} disabled={editRow.isPending}>
              {editRow.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete-one-test-case confirm — a small modal so a stray trash click can't
          silently drop a row. Deletes the row in place and refetches the version. */}
      <Dialog
        open={pendingDeleteRow != null && data?.format === 'csv'}
        onOpenChange={(open) => {
          if (!open && !delRow.isPending) setPendingDeleteRow(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Trash2 className="size-4 text-destructive" />
              Delete this test case?
            </DialogTitle>
            <DialogDescription>
              {(() => {
                if (pendingDeleteRow == null || !data?.testcases) return null
                const rows = parseCsv(data.testcases)
                const vals = rows[pendingDeleteRow] ?? []
                const label = [vals[0], vals[1]].filter((v) => v && v.trim()).join(' · ')
                return label
                  ? `“${label}” will be removed from v${selectedVersion}. This can't be undone.`
                  : `This row will be removed from v${selectedVersion}. This can't be undone.`
              })()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDeleteRow(null)}
              disabled={delRow.isPending}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (pendingDeleteRow == null || !data?.testcases || selectedVersion == null) return
                // Capture the row's values now so Undo can re-insert it verbatim.
                const values = parseCsv(data.testcases)[pendingDeleteRow] ?? []
                delRow.mutate({ version: selectedVersion, row: pendingDeleteRow, values })
              }}
              disabled={delRow.isPending}
            >
              {delRow.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Collapsible terminal-style live log for a generation job. */
function JobLogPanel({ logs, running }: { logs: TestCaseLogLine[]; running: boolean }) {
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

/**
 * One running/finished generation job — its progress, pause/resume/cancel controls,
 * per-ticket results, and live logs. Several of these can be on screen at once (the
 * page runs up to MAX_PARALLEL_JOBS jobs concurrently). Each card owns its own
 * control mutations, writing the returned job straight into the poll cache so the
 * UI reacts immediately.
 */
function JobCard({
  job,
  onPreview,
}: {
  job: TestCaseJob
  onPreview: (folder: string) => void
}) {
  const queryClient = useQueryClient()
  const jobId = job.id
  const isRunning = job.status === 'running'
  const isPaused = job.status === 'paused'
  const isActive = isRunning || isPaused
  const doneCount = job.items.filter((i) => i.status === 'done').length
  const pendingCount = job.items.filter((i) => i.status === 'pending').length

  const applyJob = (j: { job: TestCaseJob }) =>
    queryClient.setQueryData(['testcase-job', jobId], j)
  const pause = useMutation({
    mutationFn: () => pauseTestCaseJob(jobId),
    onSuccess: applyJob,
    onError: (err) =>
      toast.error('Could not pause', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const resume = useMutation({
    mutationFn: () => resumeTestCaseJob(jobId),
    onSuccess: (j) => {
      applyJob(j)
      queryClient.invalidateQueries({ queryKey: ['testcase-job', jobId] })
    },
    onError: (err) =>
      toast.error('Could not resume', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const cancel = useMutation({
    mutationFn: () => cancelTestCaseJob(jobId),
    onSuccess: (j) => {
      applyJob(j)
      toast.info('Generation cancelled')
    },
    onError: (err) =>
      toast.error('Could not cancel', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const controlPending = pause.isPending || resume.isPending || cancel.isPending

  const title = job.items.length === 1 ? job.items[0].folder : `${job.items.length} tickets`
  const summary = isRunning
    ? `Generating ${doneCount}/${job.total}…`
    : isPaused
      ? `Paused · ${doneCount}/${job.total} done · ${pendingCount} left`
      : job.status === 'cancelled'
        ? `Cancelled · ${doneCount} generated`
        : `${doneCount}/${job.items.length} succeeded`

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
        {isRunning ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
        ) : isPaused ? (
          <Pause className="h-4 w-4 shrink-0 text-amber-600" />
        ) : job.status === 'cancelled' ? (
          <Ban className="h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
        )}
        <span className="min-w-0 max-w-[16rem] truncate font-mono text-xs">{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{summary}</span>
        <div className="ml-auto flex items-center gap-2">
          {isRunning && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => pause.mutate()}
              disabled={controlPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Pause className="h-3.5 w-3.5" />
              Pause
            </Button>
          )}
          {isPaused && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => resume.mutate()}
              disabled={controlPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Play className="h-3.5 w-3.5" />
              Resume
            </Button>
          )}
          {isActive && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => cancel.mutate()}
              disabled={controlPending}
              className="rounded-full text-destructive transition-all duration-200 hover:text-destructive active:scale-[0.98]"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
        </div>
      </div>

      <ul className="divide-y">
        {job.items.map((it) => (
          <li key={it.folder} className="flex items-center gap-2.5 px-4 py-2 text-sm">
            {it.status === 'done' ? (
              <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
            ) : it.status === 'error' ? (
              <Info className="size-4 shrink-0 text-destructive" />
            ) : it.status === 'running' ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
            ) : it.status === 'cancelled' ? (
              <Ban className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
              {it.folder}
            </span>
            {it.status === 'done' ? (
              <button
                type="button"
                onClick={() => onPreview(it.folder)}
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
              >
                v{it.version}
                <Eye className="size-3" />
              </button>
            ) : it.status === 'error' ? (
              <span className="shrink-0 truncate text-xs text-destructive" title={it.error}>
                {it.error}
              </span>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                {it.status === 'running'
                  ? 'Generating…'
                  : it.status === 'cancelled'
                    ? 'Cancelled'
                    : 'Queued'}
              </span>
            )}
          </li>
        ))}
      </ul>

      {job.logs.length > 0 && (
        <div className="border-t border-border/60 p-3">
          <JobLogPanel logs={job.logs} running={isRunning} />
        </div>
      )}
    </Card>
  )
}

export default function TestCasePage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  // Preselect a ticket when arriving from "Generate test cases" (/testcases?ticket=<folder>).
  const [selectedFolders, setSelectedFolders] = useState<Set<string>>(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('ticket')
      return t ? new Set([t]) : new Set()
    } catch {
      return new Set()
    }
  })
  const [query, setQuery] = useState('')
  const [tcFilter, setTcFilter] = useState<TcFilter>('all')
  // Collapsed parent folders in the crawled-ticket tree (default: all expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleCollapse = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const [previewFolder, setPreviewFolder] = useState<string | null>(null)
  const [previewTemplate, setPreviewTemplate] = useState<{ name: string; content: string } | null>(
    null,
  )
  const [template, setTemplate] = useState<{ name: string; content: string; size: number } | null>(
    null,
  )
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [instructions, setInstructions] = useState('')
  const [managingRules, setManagingRules] = useState(false)
  // Optional live app URL per ticket (folder → url) + the Generate confirm dialog.
  const [appUrls, setAppUrls] = useState<Record<string, string>>({})
  const [genOpen, setGenOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)
  // The last tour step reveals a useful default selection. Remember that it was
  // created by the tour so closing the tour never clears the user's own picks.
  const tourAutoSelectedRef = useRef(false)
  // Which Claude model drafts the test cases. Persisted across sessions.
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
      /* storage unavailable */
    }
  }
  const modelInfo = TESTCASE_MODELS.find((m) => m.value === model) ?? TESTCASE_MODELS[1]
  // The background generation jobs we're tracking (server-side, survive reload). A
  // project can run several at once, so this is a list — initialized from the stored
  // ids so a reload reconnects to every still-running job.
  const [jobIds, setJobIds] = useState<string[]>(() => loadActiveJobIds(activeProjectId))
  const { rules, addRule, updateRule, removeRule, resetRules } = useTestRules()
  // Reset everything when the active project changes (and reconnect to that
  // project's stored job, if any).
  const [seenProject, setSeenProject] = useState(activeProjectId)
  if (seenProject !== activeProjectId) {
    setSeenProject(activeProjectId)
    setSelectedFolders(new Set())
    setQuery('')
    setTcFilter('all')
    setTemplate(null)
    setPreviewFolder(null)
    setPicked(new Set())
    setInstructions('')
    setAppUrls({})
    setGenOpen(false)
    setJobIds(loadActiveJobIds(activeProjectId))
  }

  function toggleSelectTicket(name: string) {
    const has = selectedFolders.has(name)
    if (!has && selectedFolders.size >= MAX_TICKETS) {
      toast.warning(`You can select up to ${MAX_TICKETS} tickets`, {
        description: 'Fewer tickets give better, more focused test cases.',
      })
      return
    }
    setSelectedFolders((prev) => {
      const next = new Set(prev)
      if (has) next.delete(name)
      else next.add(name)
      return next
    })
  }

  function toggleRule(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const { data: crawled, isLoading: crawledLoading } = useQuery({
    queryKey: ['crawled', activeProjectId],
    queryFn: () => listCrawledTickets(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const hasCrawled = (crawled?.length ?? 0) > 0

  const tourSteps: TourStep[] = [
    {
      selector: '[data-tour="header"]',
      title: 'Generate test cases from crawled tickets',
      body: 'Choose up to five tickets that were crawled from your tracker. Claude drafts a focused set of manual test cases for each ticket and saves them with the ticket.',
      placement: 'bottom',
    },
    {
      selector: '[data-tour="destination"]',
      title: 'Where test cases are saved',
      body: 'Generated files live in this project under testing/tickets/. Use Open folder to view the saved test cases on your machine.',
      placement: 'bottom',
    },
    {
      selector: '[data-tour="tickets"]',
      title: 'Choose tickets',
      body: 'Search and filter crawled tickets, then select up to five. Tickets stay selected while you filter, and nested subtasks can be expanded from their parent.',
      placement: 'bottom',
    },
    {
      selector: '[data-tour="template"]',
      title: 'Use your preferred format',
      body: 'Optionally upload a Markdown, CSV, or Excel template. Claude follows its structure; a project template from Settings is used automatically when available.',
      placement: 'top',
    },
    {
      selector: '[data-tour="rules"]',
      title: 'Focus the coverage',
      body: 'Pick reusable rule chips and add free-form instructions to steer the cases toward the workflows, risks, and environments that matter.',
      placement: 'top',
    },
    {
      selector: '[data-tour="model"]',
      title: 'Choose a model',
      body: 'Use Haiku for speed, Sonnet for balanced coverage, or Opus for deeper analysis of complex or ambiguous tickets.',
      placement: 'top',
    },
    {
      selector: '[data-tour="generate"]',
      title: 'Generate in the background',
      body: 'Confirm the selected tickets, optionally provide a live app URL, and start generation. Jobs continue on the server if you leave this page, with up to three running at once.',
      placement: 'top',
      action: () => {
        const first = (crawled ?? [])[0]
        if (first && selectedFolders.size === 0) {
          setSelectedFolders(new Set([first.name]))
          tourAutoSelectedRef.current = true
        }
      },
    },
  ]

  function endTour() {
    setTourOpen(false)
    if (tourAutoSelectedRef.current) {
      setSelectedFolders(new Set())
      tourAutoSelectedRef.current = false
    }
  }

  // The project's saved test-case template (Settings page). Used as the default
  // when the user hasn't uploaded a one-off template for this run.
  const { data: projectTemplates } = useQuery({
    queryKey: ['templates', activeProjectId],
    queryFn: () => listTemplates(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const savedTemplate = (projectTemplates ?? []).find((t) => t.key === 'testcase') ?? null
  // Upload wins; otherwise fall back to the saved project template.
  const effectiveTemplate = template
    ? { name: template.name, content: template.content }
    : savedTemplate
      ? { name: 'testcase.md (project)', content: savedTemplate.content }
      : null

  // Start a server-side background job for the selected tickets. Only valid http(s)
  // app URLs for currently-selected folders are sent (blank/invalid → ticket-only).
  const start = useMutation({
    mutationFn: () => {
      const cleanUrls: Record<string, string> = {}
      for (const folder of selectedFolders) {
        const u = (appUrls[folder] ?? '').trim()
        if (u && isLikelyUrl(u)) cleanUrls[folder] = u
      }
      return startTestCaseJob({
        projectId: activeProjectId as string,
        folders: [...selectedFolders],
        appUrls: cleanUrls,
        template: effectiveTemplate,
        instructions: buildInstructions(rules, picked, instructions),
        projectName: activeProject?.name,
        model,
      })
    },
    onSuccess: ({ jobId: id, job: started }) => {
      setJobIds((prev) => (prev.includes(id) ? prev : [...prev, id]))
      // Seed the poll cache so the new card renders immediately, before the first poll.
      queryClient.setQueryData(['testcase-job', id], { job: started })
      setGenOpen(false)
      // Clear the selection so the engineer can pick the next ticket and fire another
      // generation right away (the previous one keeps running).
      setSelectedFolders(new Set())
      setAppUrls({})
      // Persist so a reload reconnects, and so the global TestCaseJobWatcher will
      // announce completion even if we navigate away from this page.
      addActiveJobId(activeProjectId as string, id)
    },
    onError: (err) =>
      toast.error('Could not start generation', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // Poll every tracked job until it finishes. Each query stops polling once its job
  // leaves `running`. Completion (toast + bell notification + cache invalidation +
  // dropping the stored id) is handled globally by <TestCaseJobWatcher/>, so it
  // fires even when this page isn't mounted; here we only render live progress.
  const jobQueries = useQueries({
    queries: jobIds.map((id) => ({
      queryKey: ['testcase-job', id],
      queryFn: () => getTestCaseJob(id),
      retry: false,
      refetchInterval: (query: { state: { data?: { job?: TestCaseJob } } }) => {
        const j = query.state.data?.job
        return j && j.status === 'running' ? 1500 : false
      },
    })),
  })

  // Drop ids whose job is gone (pruned / server restarted) so we stop polling them.
  useEffect(() => {
    const dead = jobIds.filter((_id, i) => jobQueries[i]?.isError)
    if (!dead.length) return
    setJobIds((prev) => prev.filter((id) => !dead.includes(id)))
    if (activeProjectId) for (const id of dead) removeActiveJobId(activeProjectId, id)
  }, [jobQueries, jobIds, activeProjectId])

  // Newest job first. Pair each job with its id so the card keys stay stable.
  const jobs = jobIds
    .map((_id, i) => jobQueries[i]?.data?.job)
    .filter((j): j is TestCaseJob => !!j)
    .reverse()
  const runningCount = jobs.filter((j) => j.status === 'running').length
  // Cap concurrent *running* jobs — pausing one frees a slot to start another.
  const atCap = runningCount >= MAX_PARALLEL_JOBS

  // Refresh the crawled-tickets badge + a ticket's version list the moment each item
  // finishes — from our own poll data, not waiting for the whole job to finalize or
  // for the global TestCaseJobWatcher's slower poll. A job stays `running` while the
  // best-effort auto-learn step runs (an AI call that can take many seconds) AFTER
  // every item is already written to disk, and the watcher only acts on terminal job
  // states — so without this the new version wouldn't appear until a manual reload.
  const seenDone = useRef<Set<string>>(new Set())
  // Signature of every completed item across tracked jobs — recomputed each render but
  // gated by the ref set, so invalidation fires once per newly-finished item.
  const doneSignature = jobs
    .flatMap((j) =>
      j.items
        .filter((i) => i.status === 'done' && i.version != null)
        .map((i) => `${j.id}:${i.folder}:${i.version}`),
    )
    .join('|')
  useEffect(() => {
    if (!activeProjectId) return
    let changed = false
    for (const j of jobs) {
      for (const it of j.items) {
        if (it.status !== 'done' || it.version == null) continue
        const key = `${j.id}:${it.folder}:${it.version}`
        if (seenDone.current.has(key)) continue
        seenDone.current.add(key)
        changed = true
        queryClient.invalidateQueries({
          queryKey: ['testcase-versions', activeProjectId, it.folder],
        })
      }
    }
    if (changed) queryClient.invalidateQueries({ queryKey: ['crawled', activeProjectId] })
    // `jobs` is rebuilt each render; `doneSignature` is the stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneSignature, activeProjectId, queryClient])

  function onPickTemplate(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > MAX_TEMPLATE_BYTES) {
      toast.error('Template too large', { description: 'Use a file under 200 KB.' })
      e.target.value = ''
      return
    }
    const reader = new FileReader()
    const isExcel = /\.(xlsx|xls)$/i.test(file.name)
    if (isExcel) {
      // Excel is a binary (zip) format — readAsText would yield garbage. Parse the
      // first sheet to CSV with SheetJS (lazy-loaded) so Claude gets clean text.
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
          // Present it as .csv so the preview + format detection treat it as CSV.
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
    // Text formats (.md, .csv).
    reader.onload = () => {
      setTemplate({ name: file.name, content: String(reader.result ?? ''), size: file.size })
    }
    reader.onerror = () =>
      toast.error('Could not read the template file', {
        description: 'Make sure it is a Markdown or CSV file.',
      })
    reader.readAsText(file)
    e.target.value = '' // allow re-picking the same file later
  }

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ClipboardList className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Test cases</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <ClipboardList className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to generate test cases.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const q = query.trim().toLowerCase()
  const allCrawled = crawled ?? []
  const byName = new Map(allCrawled.map((c) => [c.name, c] as const))
  const matches = (c: CrawledTicket) =>
    // Already-selected tickets stay visible no matter what's typed or filtered, so
    // you never lose sight of your picks while searching for the next one.
    selectedFolders.has(c.name) ||
    (`${c.name} ${c.displayId ?? ''} ${c.title ?? ''}`.toLowerCase().includes(q) &&
      (tcFilter === 'with' ? c.hasTestcases : tcFilter === 'without' ? !c.hasTestcases : true))
  // Visible = tickets matching the filter, plus every ancestor of a match, so a
  // nested subtask that matches keeps its parent chain in view (a coherent tree).
  const visible = new Set<string>()
  for (const c of allCrawled) {
    if (!matches(c)) continue
    visible.add(c.name)
    let p = c.parent ?? null
    while (p && byName.has(p) && !visible.has(p)) {
      visible.add(p)
      p = byName.get(p)?.parent ?? null
    }
  }
  const visibleTickets = allCrawled.filter((c) => visible.has(c.name))
  // parent `name` → its visible children (a crawled folder nested inside it).
  const childrenByParent = new Map<string, CrawledTicket[]>()
  for (const c of visibleTickets) {
    if (c.parent && byName.has(c.parent)) {
      const arr = childrenByParent.get(c.parent)
      if (arr) arr.push(c)
      else childrenByParent.set(c.parent, [c])
    }
  }
  // Roots (grouped by status) = visible tickets with no crawled parent. Their
  // subtask descendants render nested beneath them regardless of their own status.
  const roots = visibleTickets.filter((c) => !c.parent || !byName.has(c.parent))
  // Tallies for the filter labels so the user sees the split at a glance.
  const withCount = allCrawled.filter((c) => c.hasTestcases).length
  const withoutCount = allCrawled.length - withCount
  const statusGroups = groupByStatus(roots)

  // Flatten a root and its (expanded) descendants into pre-order rows for rendering.
  const flattenTree = (group: CrawledTicket[]): { ticket: CrawledTicket; depth: number; hasChildren: boolean }[] => {
    const out: { ticket: CrawledTicket; depth: number; hasChildren: boolean }[] = []
    const visit = (node: CrawledTicket, depth: number) => {
      const kids = childrenByParent.get(node.name) ?? []
      out.push({ ticket: node, depth, hasChildren: kids.length > 0 })
      if (kids.length && !collapsed.has(node.name)) for (const k of kids) visit(k, depth + 1)
    }
    for (const r of group) visit(r, 0)
    return out
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3" data-tour="header">
            <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <ClipboardList className="size-5" />
            </span>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight">Test cases</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Pick up to {MAX_TICKETS} crawled tickets and let Claude draft manual test cases for
                each — optionally following a template you upload. Saved per ticket under{' '}
                <code className="font-mono">testcases/</code>.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTourOpen(true)}
            className="fixed bottom-5 right-5 z-40 gap-1.5 rounded-full bg-card shadow-lg transition-all duration-200 active:scale-[0.98]"
            title="Take a quick guided tour of this page"
          >
            <Compass className="size-3.5" />
            Guide tour
          </Button>
        </div>

        {activeProject && (
          <div data-tour="destination" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
            <span className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Generating into
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                title={`${activeProject.rootPath}/testing/tickets`}
              >
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/testing/tickets</span>
                <span
                  className={cn(
                    'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    hasCrawled ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {hasCrawled ? 'exists' : 'new'}
                </span>
              </span>
              <OpenFolderButton
                open={() => openTicketsFolder(activeProjectId)}
                label="test cases"
              />
            </div>
          </div>
        )}
      </header>

      <div className="space-y-4">
        <Card data-tour="tickets" className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
            <Ticket className="h-4 w-4 text-muted-foreground" />
            Crawled tickets
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {selectedFolders.size}/{MAX_TICKETS} selected
            </span>
          </div>
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter crawled tickets…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-11 rounded-full pl-9 shadow-none"
                />
              </div>
              <Select value={tcFilter} onValueChange={(v) => setTcFilter(v as TcFilter)}>
                <SelectTrigger size="sm" className="h-9 w-auto min-w-[10.5rem] gap-2 rounded-full" aria-label="Filter by test cases">
                  <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TC_FILTERS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>
                      {f.label}
                      {f.value === 'with' ? ` (${withCount})` : ''}
                      {f.value === 'without' ? ` (${withoutCount})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedFolders.size > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {[...selectedFolders].map((name) => {
                  const t = (crawled ?? []).find((c) => c.name === name)
                  const label = t?.displayId ?? name
                  return (
                    <Tooltip key={name}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-[11px] font-medium text-primary">
                          <Ticket className="size-2.5 shrink-0" />
                          <span className="truncate font-mono">{label}</span>
                          <button
                            type="button"
                            onClick={() => toggleSelectTicket(name)}
                            aria-label={`Remove ${label}`}
                            className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-primary/70 transition-colors hover:bg-primary/20 hover:text-primary"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-sm">
                        <span className="font-mono font-medium">{label}</span>
                        {t?.title ? ` — ${t.title}` : ''}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
                <button
                  type="button"
                  onClick={() => setSelectedFolders(new Set())}
                  className="ml-1 text-[11px] font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
                >
                  Clear all
                </button>
              </div>
            )}
            <div className="flex items-start gap-2 rounded-xl bg-muted/60 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                Select up to {MAX_TICKETS} tickets. Fewer tickets give better, more focused results
                — each ticket is a separate Claude run with its own limited context. Click the{' '}
                <span className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-emerald-700">
                  <CheckCircle2 className="size-2.5" />
                  Test cases
                </span>{' '}
                badge to preview existing versions.
              </p>
            </div>
            <div className="max-h-[28rem] overflow-auto rounded-2xl border border-border/60 bg-background/50">
              {crawledLoading ? (
                <p className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading…
                </p>
              ) : !crawled || crawled.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 px-4 py-8 text-center">
                  <p className="text-sm text-muted-foreground">No crawled tickets yet.</p>
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
                    <Info className="h-3.5 w-3.5 shrink-0" />
                    Crawl a ticket on the Tickets page first.
                  </p>
                </div>
              ) : visibleTickets.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                  {tcFilter === 'with'
                    ? 'No tickets with test cases yet.'
                    : tcFilter === 'without'
                      ? 'Every ticket already has test cases.'
                      : `No tickets match “${query}”.`}
                </p>
              ) : (
                <div>
                  {statusGroups.map((group) => (
                    <div key={group.status || '∅'}>
                      {/* Status header — sticks to the top of the scroll area so the
                          group a row belongs to stays visible while scrolling. */}
                      <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/80 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
                        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          <span
                            className="size-1.5 rounded-full bg-muted-foreground/60"
                            aria-hidden
                          />
                          {group.status || 'No status'}
                        </span>
                        <span className="text-[11px] font-medium text-muted-foreground/70">
                          {group.tickets.length}
                        </span>
                        <span className="h-px flex-1 bg-border/60" aria-hidden />
                      </div>
                      <ul className="divide-y">
                        {flattenTree(group.tickets).map(({ ticket: c, depth, hasChildren }) => (
                          <li key={c.name}>
                            <TicketRow
                              ticket={c}
                              depth={depth}
                              hasChildren={hasChildren}
                              isOpen={!collapsed.has(c.name)}
                              onToggleExpand={() => toggleCollapse(c.name)}
                              selected={selectedFolders.has(c.name)}
                              onSelect={() => toggleSelectTicket(c.name)}
                              onView={() => setPreviewFolder(c.name)}
                            />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Template upload */}
        <Card data-tour="template" className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
            <FileText className="h-4 w-4 text-muted-foreground" />
            Template
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
                  aria-label="Preview template"
                  title="Preview template"
                >
                  <Eye className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setTemplate(null)}
                  className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label="Remove template"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : savedTemplate ? (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50/60 px-3 py-2">
                <FileText className="h-4 w-4 shrink-0 text-emerald-600" />
                <span className="min-w-0 flex-1 text-sm">
                  Using <span className="font-medium">project template</span>
                  <span className="block text-[11px] text-muted-foreground">
                    From Settings → File templates. Preview it, or upload to override for this run.
                  </span>
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPreviewTemplate({
                      name: 'testcase.md (project)',
                      content: savedTemplate.content,
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
                Upload template
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              Markdown, CSV, or Excel (.md, .csv, .xlsx). Excel is converted to CSV automatically.
              Claude will match its structure when writing the cases.{' '}
              {!template && !savedTemplate && (
                <>Set a reusable one in Settings → File templates.</>
              )}
            </p>
          </CardContent>
        </Card>

        {/* Instructions & quick rules */}
        <Card data-tour="rules" className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-sm font-medium">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            Instructions &amp; rules
            <span className="text-xs font-normal text-muted-foreground">optional</span>
            <div className="ml-auto flex items-center gap-3">
              {picked.size > 0 && (
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear {picked.size}
                </button>
              )}
              <button
                type="button"
                onClick={() => setManagingRules(true)}
                className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground transition-colors hover:text-primary"
              >
                <Settings2 className="size-3.5" />
                Manage
              </button>
            </div>
          </div>
          <CardContent className="space-y-3 p-4">
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                Tap the areas you want the test cases to focus on:
              </p>
              {rules.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-3 py-3 text-center text-xs text-muted-foreground">
                  No rules yet —{' '}
                  <button
                    type="button"
                    onClick={() => setManagingRules(true)}
                    className="font-medium text-primary hover:underline"
                  >
                    add some
                  </button>
                  .
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {rules.map((r) => (
                    <RuleChip
                      key={r.id}
                      label={r.label}
                      hint={r.hint}
                      selected={picked.has(r.id)}
                      onToggle={() => toggleRule(r.id)}
                    />
                  ))}
                </div>
              )}
            </div>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Extra instructions for Claude — e.g. focus on the checkout flow, assume the staging env, write cases in Vietnamese…"
              className="min-h-[88px] resize-y text-sm"
            />
          </CardContent>
        </Card>

        {/* Pick which Claude model drafts the cases — same options as the crawl picker. */}
        <div data-tour="model" className="flex flex-wrap items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-2.5 shadow-none">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="h-4 w-4 text-primary" />
            Model
          </div>
          <Select value={model} onValueChange={chooseModel} disabled={start.isPending}>
            <SelectTrigger size="sm" className="h-9 w-auto min-w-[10rem] gap-2 rounded-full" aria-label="Test-case generation model">
              <SelectValue aria-label={modelInfo.label}>
                <span className="text-xs font-medium">{modelInfo.label}</span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent className="max-w-[20rem]">
              {TESTCASE_MODELS.map((m) => (
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
          <p className="min-w-0 flex-1 text-[11px] leading-snug text-muted-foreground">
            {modelInfo.description}
          </p>
        </div>

        <div data-tour="generate" className="flex gap-2">
          <Button
            onClick={() => setGenOpen(true)}
            disabled={selectedFolders.size === 0 || start.isPending || atCap}
            className="flex-1 justify-center rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {start.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                Generate test cases
                {selectedFolders.size > 0 ? ` (${selectedFolders.size})` : ''}
              </>
            )}
          </Button>
        </div>

        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {atCap
            ? `You can run up to ${MAX_PARALLEL_JOBS} generations at once — pause, cancel, or wait for one below to finish before starting another.`
            : runningCount > 0
              ? `${runningCount} generation${runningCount === 1 ? '' : 's'} running on the server. Pick more tickets and Generate to run another in parallel (up to ${MAX_PARALLEL_JOBS}). You can leave this page — they keep going.`
              : `Each generation runs on the server, so you can start one, pick more tickets, and Generate again to run up to ${MAX_PARALLEL_JOBS} in parallel.`}
        </p>

        {/* One card per tracked job (newest first) — progress, controls, results, logs. */}
        {jobs.length > 0 && (
          <div className="space-y-3">
            {jobs.map((j) => (
              <JobCard key={j.id} job={j} onPreview={setPreviewFolder} />
            ))}
          </div>
        )}
      </div>

      <GenerateDialog
        open={genOpen}
        onOpenChange={(open) => !start.isPending && setGenOpen(open)}
        tickets={(crawled ?? []).filter((c) => selectedFolders.has(c.name))}
        appUrls={appUrls}
        onChangeUrl={(folder, url) => setAppUrls((prev) => ({ ...prev, [folder]: url }))}
        onApplyAll={(url) =>
          setAppUrls((prev) => {
            const next = { ...prev }
            for (const folder of selectedFolders) next[folder] = url
            return next
          })
        }
        onConfirm={() => start.mutate()}
        pending={start.isPending}
        modelLabel={modelInfo.label}
      />

      <TestCasePreviewDialog
        folder={previewFolder}
        projectId={activeProjectId}
        onOpenChange={(open) => !open && setPreviewFolder(null)}
      />

      <TemplatePreviewDialog
        template={previewTemplate}
        onOpenChange={(open) => !open && setPreviewTemplate(null)}
      />

      <ManageRulesDialog
        open={managingRules}
        onOpenChange={setManagingRules}
        rules={rules}
        addRule={addRule}
        updateRule={updateRule}
        removeRule={removeRule}
        resetRules={resetRules}
      />

      <GuideTour steps={tourSteps} open={tourOpen} onClose={endTour} />
    </div>
  )
}
