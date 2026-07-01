import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  DownloadCloud,
  ExternalLink,
  FileText,
  FolderDown,
  FolderGit2,
  ListChecks,
  Loader2,
  Paperclip,
  ScrollText,
  Search,
  Settings2,
  Sparkles,
  Ticket,
  Trash2,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfigureListDialog } from '@/components/ConfigureListDialog'
import {
  clickupListTasks,
  clickupStatus,
  clickupTasks,
  clickupSubtasks,
  clickupWorkspaces,
  jiraStatus,
  jiraTasks,
  jiraSubtasks,
  jiraWorkspaces,
  startJiraCrawlJob,
  getCrawlJob,
  openTicketsFolder,
  startCrawlJob,
  deleteCrawledTicket,
  listCrawledTickets,
  type ClickupTask,
  type CrawlResult,
  type CrawlLogLine,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import {
  clearListBinding,
  loadListBinding,
  saveListBinding,
  type ListBinding,
} from '@/lib/clickupList'
import { useProjects } from '@/lib/project-context'

const CRAWL_MODEL_KEY = 'qc.crawlModel'

// Which tracker the ticket picker reads from. Both normalize to the same shape,
// so only the data source differs — the tree, status grouping, and crawler are
// identical. The pick is remembered per project; the workspace pick is remembered
// per source (a ClickUp team id and a Jira project key must not collide).
type TicketSourceId = 'clickup' | 'jira'

const SOURCE_PREFIX = 'qc.ticketSource.'
function loadTicketSource(projectId: string | null): TicketSourceId {
  if (!projectId) return 'clickup'
  try {
    return localStorage.getItem(SOURCE_PREFIX + projectId) === 'jira' ? 'jira' : 'clickup'
  } catch {
    return 'clickup'
  }
}
function saveTicketSource(projectId: string | null, source: TicketSourceId): void {
  if (!projectId) return
  try {
    localStorage.setItem(SOURCE_PREFIX + projectId, source)
  } catch {
    /* ignore */
  }
}

const TEAM_PREFIX = 'qc.ticketTeam.' // + source ('clickup' | 'jira')
function loadTeam(source: TicketSourceId): string {
  try {
    // Migrate the legacy ClickUp-only key so existing binds survive the rename.
    return (
      localStorage.getItem(TEAM_PREFIX + source) ??
      (source === 'clickup' ? localStorage.getItem('qc.clickupTeam') : null) ??
      ''
    )
  } catch {
    return ''
  }
}
function saveTeam(source: TicketSourceId, id: string): void {
  try {
    localStorage.setItem(TEAM_PREFIX + source, id)
  } catch {
    /* ignore */
  }
}

// The active background crawl-job id, remembered per project so a browser reload
// (or navigating away and back) reconnects to the still-running server-side job.
// The global CrawlJobWatcher clears this key once a job finishes.
const ACTIVE_CRAWL_JOB_PREFIX = 'qc.crawlJob.'
function loadActiveCrawlJobId(projectId: string | null): string | null {
  if (!projectId) return null
  try {
    return localStorage.getItem(ACTIVE_CRAWL_JOB_PREFIX + projectId)
  } catch {
    return null
  }
}
function saveActiveCrawlJobId(projectId: string, jobId: string): void {
  try {
    localStorage.setItem(ACTIVE_CRAWL_JOB_PREFIX + projectId, jobId)
  } catch {
    /* storage unavailable */
  }
}
function clearActiveCrawlJobId(projectId: string | null): void {
  if (!projectId) return
  try {
    localStorage.removeItem(ACTIVE_CRAWL_JOB_PREFIX + projectId)
  } catch {
    /* ignore */
  }
}

// How to process each crawled ticket. "none" = plain download. The model options
// additionally have Claude write a short QC brief (summary.md) from the ticket —
// the descriptions help the user trade speed/cost against depth of analysis.
const CRAWL_MODELS: { value: string; label: string; description: string }[] = [
  {
    value: 'none',
    label: 'Download only',
    description: 'Just save the ticket, comments & attachments — no AI. Fastest, free.',
  },
  {
    value: 'haiku',
    label: 'Haiku · quick brief',
    description: 'Fast, low-cost summary. Best for simple, well-written tickets.',
  },
  {
    value: 'sonnet',
    label: 'Sonnet · balanced brief',
    description: 'Solid QC brief with good coverage of what to test. Recommended default.',
  },
  {
    value: 'opus',
    label: 'Opus · deep brief',
    description: 'Deepest analysis — best for long, complex or ambiguous tickets. Slower, pricier.',
  },
]

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/** ClickUp gives each status an arbitrary hex; turn it into a translucent rgba so
 *  we can tint a pill's background to match without hard-coding palette classes. */
function statusTint(hex: string | undefined, alpha: number): string {
  const fallback = `rgba(100, 116, 139, ${alpha})` // slate-500
  if (!hex) return fallback
  const h = hex.replace('#', '')
  if (h.length !== 6) return fallback
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return fallback
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** A small colored status chip mirroring the task's ClickUp status color. */
function StatusPill({ status, color }: { status: string; color?: string }) {
  if (!status) return null
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{ color: color || 'var(--muted-foreground)', backgroundColor: statusTint(color, 0.13) }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: color || 'var(--muted-foreground)' }}
        aria-hidden
      />
      {status}
    </span>
  )
}

/** Mirrors the server's safeSegment() so a ticket id maps to its on-disk folder. */
function safeSegment(s: string): string {
  return (
    s
      .replace(/[/\\]+/g, '-')
      .replace(/[^\w.\- ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120) || 'ticket'
  )
}

/** A ticket plus its nested subtasks, for the tree view. */
interface TicketNode {
  task: ClickupTask
  children: TicketNode[]
}

/**
 * Nest the flat task list into parent → subtask trees using each task's `parent`
 * id. A subtask whose parent isn't in the current list (e.g. filtered out by a
 * search) falls back to a top-level row. Top-level rows are grouped by ClickUp
 * status (stable — original order is kept within a status); subtask order is
 * left untouched so a parent's tree still reads top-down.
 */
function buildTree(tasks: ClickupTask[]): TicketNode[] {
  const nodeById = new Map<string, TicketNode>()
  for (const t of tasks) nodeById.set(t.id, { task: t, children: [] })
  const roots: TicketNode[] = []
  for (const t of tasks) {
    const node = nodeById.get(t.id)!
    const parent = t.parent ? nodeById.get(t.parent) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  return roots
    .map((node, index) => ({ node, index }))
    .sort((a, b) => {
      const byStatus = (a.node.task.status || '').localeCompare(b.node.task.status || '')
      return byStatus !== 0 ? byStatus : a.index - b.index
    })
    .map(({ node }) => node)
}

/** A run of consecutive top-level tickets sharing the same ClickUp status. */
interface StatusGroup {
  status: string
  color: string
  nodes: TicketNode[]
}

/** Fold the (already status-sorted) roots into consecutive same-status groups,
 *  so the list can show a header per status. Color follows the first member. */
function groupByStatus(roots: TicketNode[]): StatusGroup[] {
  const groups: StatusGroup[] = []
  for (const node of roots) {
    const status = node.task.status || ''
    const last = groups[groups.length - 1]
    if (last && last.status === status) last.nodes.push(node)
    else groups.push({ status, color: node.task.statusColor, nodes: [node] })
  }
  return groups
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

/** One collapsible row inside the crawl results panel — collapsed by default to
 *  keep the footprint small; expands to reveal the exact files written. */
function CrawlResultRow({ result }: { result: CrawlResult }) {
  const [open, setOpen] = useState(false)
  const failed = result.attachmentErrors.length
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="shrink-0 font-mono text-[11px] font-medium text-muted-foreground">
          {result.displayId}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm">{result.name}</span>
        {result.summary?.ok && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
            title={`AI summary written by ${result.summary.model}`}
          >
            <Sparkles className="size-3" />
            summary
          </span>
        )}
        <span className="hidden shrink-0 items-center gap-2.5 text-[11px] text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1">
            <FileText className="size-3" />
            {result.files.length}
          </span>
          <span className="inline-flex items-center gap-1">
            <Paperclip className="size-3" />
            {result.attachmentCount}/{result.attachmentTotal}
          </span>
        </span>
        {failed > 0 && (
          <AlertCircle
            className="size-3.5 shrink-0 text-amber-500"
            aria-label={`${failed} attachment(s) failed`}
          />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t bg-muted/20 px-3 py-2 pl-9">
          <div
            className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
            title={result.absDir}
          >
            <FolderDown className="size-3 shrink-0 text-primary/70" />
            <span className="truncate">{result.dir}</span>
          </div>
          <ul className="space-y-0.5 text-[11px]">
            {result.files.map((f) => (
              <li key={f.path} className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-muted-foreground">{f.path}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatBytes(f.bytes)}
                </span>
              </li>
            ))}
          </ul>
          {failed > 0 && (
            <ul className="space-y-0.5 rounded-xl border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700">
              {result.attachmentErrors.map((e, i) => (
                <li key={i} className="truncate">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}

/** Compact summary shown after a successful crawl — one tidy panel listing every
 *  crawled ticket as a collapsible row, instead of a tall card per ticket. */
function CrawlResultsPanel({ results }: { results: CrawlResult[] }) {
  const totalFiles = results.reduce((n, r) => n + r.files.length, 0)
  const totalAtt = results.reduce((n, r) => n + r.attachmentCount, 0)
  return (
    <Card className="rounded-3xl border-emerald-200/70 bg-emerald-50/30 shadow-none">
      <CardContent className="space-y-2.5 py-4">
        <div className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 ring-1 ring-emerald-600/20">
            <CheckCircle2 className="size-4" />
          </span>
          <p className="text-sm font-semibold tracking-tight">
            Crawled {results.length} ticket{results.length === 1 ? '' : 's'}
          </p>
          <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
            {totalFiles} files · {totalAtt} attachment{totalAtt === 1 ? '' : 's'}
          </span>
        </div>
        <ul className="divide-y rounded-2xl border border-border/60 bg-card">
          {results.map((r) => (
            <CrawlResultRow key={r.displayId} result={r} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** One line in the live crawl log. */
interface LogLine {
  id: number
  kind: 'info' | 'pending' | 'ok' | 'error'
  text: string
  time: string
}

/** Live, color-coded crawl log. Collapsible and auto-scrolls to the newest line
 *  while a crawl is running so the user can watch progress in real time. */
function CrawlLogPanel({
  logs,
  open,
  busy,
  onToggle,
  onClear,
}: {
  logs: LogLine[]
  open: boolean
  busy: boolean
  onToggle: () => void
  onClear: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [logs, open])

  const lineColor: Record<LogLine['kind'], string> = {
    info: 'text-muted-foreground',
    pending: 'text-foreground',
    ok: 'text-emerald-600',
    error: 'text-destructive',
  }

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">Crawl log</span>
          {busy ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary">
              <Loader2 className="size-3 animate-spin" />
              running
            </span>
          ) : (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {logs.length} line{logs.length === 1 ? '' : 's'}
            </span>
          )}
        </button>
        {!busy && logs.length > 0 && (
          <button
            type="button"
            onClick={onClear}
            title="Clear log"
            className="inline-flex items-center gap-1 rounded-full px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="size-3.5" />
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="max-h-64 overflow-y-auto bg-card px-3 py-2 font-mono text-[11px] leading-relaxed">
          {logs.map((l) => (
            <div key={l.id} className="flex gap-2">
              <span className="shrink-0 tabular-nums text-muted-foreground/60">{l.time}</span>
              <span className={cn('min-w-0 break-words', lineColor[l.kind])}>{l.text}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </Card>
  )
}

export default function TicketsPage() {
  const { activeProjectId, activeProject } = useProjects()
  const queryClient = useQueryClient()
  // Status is per-project (the tracker creds live in each project's .mcp.json),
  // so scope both checks to the active project — not the server's default one.
  const { data: cuStatus } = useQuery({
    queryKey: ['clickup-status', activeProjectId],
    queryFn: () => clickupStatus(activeProjectId ?? undefined),
  })
  const { data: jStatus } = useQuery({
    queryKey: ['jira-status', activeProjectId],
    queryFn: () => jiraStatus(activeProjectId ?? undefined),
  })
  const clickupOk = !!cuStatus?.configured
  const jiraOk = !!jStatus?.configured
  const bothConfigured = clickupOk && jiraOk

  // Remembered pick; only honored when both trackers are connected. Otherwise we
  // snap to whichever one is configured so the page always shows a usable source.
  const [sourcePref, setSourcePref] = useState<TicketSourceId>(() =>
    loadTicketSource(activeProjectId),
  )
  const source: TicketSourceId = bothConfigured ? sourcePref : jiraOk ? 'jira' : 'clickup'
  const configured = source === 'jira' ? jiraOk : clickupOk

  function chooseSource(next: TicketSourceId) {
    setSourcePref(next)
    saveTicketSource(activeProjectId, next)
  }

  const [binding, setBinding] = useState<ListBinding | null>(() =>
    activeProjectId ? loadListBinding(activeProjectId) : null,
  )
  // List binding is a ClickUp-only concept; Jira scopes by project (the workspace).
  const cuBinding = source === 'clickup' ? binding : null
  const [configuring, setConfiguring] = useState(false)
  const [query, setQuery] = useState('')
  // Multi-select: keep the full task objects keyed by id (a filtered/searched list
  // can drop rows, so we can't rely on re-finding them in `tasks`).
  const [selected, setSelected] = useState<Map<string, ClickupTask>>(new Map())
  const debounced = useDebounced(query, 300)

  // The crawl now runs as a server-side background job (survives reload / nav).
  // We track its id (reconnecting from the per-project stored id) and poll it; the
  // live log, progress and results are all derived from the job below.
  const [jobId, setJobId] = useState<string | null>(() => loadActiveCrawlJobId(activeProjectId))
  const [showLogs, setShowLogs] = useState(true)
  // Crawl results just deleted from disk — hidden from the post-crawl summary panel.
  const [hiddenResults, setHiddenResults] = useState<Set<string>>(new Set())

  // Which model (if any) processes each crawled ticket into a summary.md. Persisted.
  const [crawlModel, setCrawlModel] = useState<string>(() => {
    try {
      return localStorage.getItem(CRAWL_MODEL_KEY) ?? 'sonnet'
    } catch {
      return 'sonnet'
    }
  })
  function chooseCrawlModel(m: string) {
    setCrawlModel(m)
    try {
      localStorage.setItem(CRAWL_MODEL_KEY, m)
    } catch {
      /* ignore */
    }
  }
  const crawlModelInfo = CRAWL_MODELS.find((m) => m.value === crawlModel) ?? CRAWL_MODELS[0]

  // Reset per-project state when the active project changes (render-phase pattern
  // from the React docs — avoids an effect that would just mirror a prop).
  const [seenProject, setSeenProject] = useState(activeProjectId)
  if (seenProject !== activeProjectId) {
    setSeenProject(activeProjectId)
    setBinding(activeProjectId ? loadListBinding(activeProjectId) : null)
    setSourcePref(loadTicketSource(activeProjectId))
    setSelected(new Map())
    setJobId(loadActiveCrawlJobId(activeProjectId))
    setHiddenResults(new Set())
  }

  // Tickets already on disk → badge them (with last-crawl time) so the user can
  // skip re-crawling, and offer to delete the downloaded copy.
  const { data: crawled } = useQuery({
    queryKey: ['crawled-tickets', activeProjectId],
    queryFn: () => listCrawledTickets(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const crawledMap = new Map((crawled ?? []).map((c) => [c.name, c]))
  const crawledAt = (t: ClickupTask) => crawledMap.get(safeSegment(t.displayId))?.crawledAt ?? null
  const isCrawled = (t: ClickupTask) => crawledMap.has(safeSegment(t.displayId))
  // How many generated test-case versions live in a ticket's folder (0 if none).
  const testcaseCount = (t: ClickupTask) =>
    crawledMap.get(safeSegment(t.displayId))?.testcaseVersions ?? 0

  const [pendingDelete, setPendingDelete] = useState<ClickupTask | null>(null)
  const del = useMutation({
    mutationFn: (t: ClickupTask) =>
      deleteCrawledTicket(safeSegment(t.displayId), activeProjectId as string),
    onSuccess: (_data, t) => {
      queryClient.invalidateQueries({ queryKey: ['crawled-tickets', activeProjectId] })
      setHiddenResults((prev) => new Set(prev).add(t.displayId)) // drop from the summary panel
      setPendingDelete(null)
      toast.success(`Deleted ${t.displayId}`, { description: 'Removed from testing/tickets' })
    },
    onError: (err) => {
      toast.error('Delete failed', {
        description: err instanceof Error ? err.message : 'Could not delete the folder',
      })
    },
  })

  const { data: workspaces } = useQuery({
    queryKey: ['ticket-workspaces', source, activeProjectId],
    queryFn: () =>
      source === 'jira'
        ? jiraWorkspaces(activeProjectId ?? undefined)
        : clickupWorkspaces(activeProjectId ?? undefined),
    enabled: configured && !cuBinding,
    staleTime: 5 * 60_000,
  })

  // Workspace pick is remembered per source (ClickUp team id vs Jira project key).
  const [team, setTeam] = useState<string>(() => loadTeam(source))
  const [seenSource, setSeenSource] = useState(source)
  if (seenSource !== source) {
    setSeenSource(source)
    setTeam(loadTeam(source))
    setSelected(new Map())
  }

  // Effective workspace: the user's pick if still valid, else the first one.
  const activeTeam =
    team && workspaces?.some((w) => w.id === team) ? team : (workspaces?.[0]?.id ?? team)

  function chooseTeam(id: string) {
    setTeam(id)
    saveTeam(source, id)
  }

  const { data: tasks, isFetching } = useQuery({
    queryKey: cuBinding
      ? ['clickup-list-tasks', activeProjectId, cuBinding.listId, debounced.trim()]
      : ['ticket-tasks', source, activeProjectId, activeTeam, debounced.trim()],
    queryFn: () =>
      cuBinding
        ? clickupListTasks(cuBinding.listId, debounced.trim(), activeProjectId ?? undefined)
        : source === 'jira'
          ? jiraTasks(activeTeam, debounced.trim(), activeProjectId ?? undefined)
          : clickupTasks(activeTeam, debounced.trim(), activeProjectId ?? undefined),
    enabled: configured && !!activeProjectId && (cuBinding ? true : !!activeTeam),
    staleTime: 15_000,
  })

  // Start a server-side background crawl job for the selected tickets. The route
  // returns immediately; completion (toast + bell notification + cache refresh) is
  // owned by the global <CrawlJobWatcher/>, so it fires even if we leave this page.
  const crawl = useMutation({
    mutationFn: (tasks: ClickupTask[]) =>
      (source === 'jira' ? startJiraCrawlJob : startCrawlJob)({
        projectId: activeProjectId as string,
        model: crawlModel,
        tickets: tasks.map((t) => ({ id: t.id, displayId: t.displayId, name: t.name })),
      }),
    onSuccess: ({ jobId: id }) => {
      setJobId(id)
      saveActiveCrawlJobId(activeProjectId as string, id)
      setHiddenResults(new Set())
      setShowLogs(true)
    },
    onError: (err) => {
      toast.error('Could not start crawl', {
        description: err instanceof Error ? err.message : 'Could not download the tickets',
      })
    },
  })

  // Poll the tracked crawl job until it finishes. Stops polling once done.
  const jobQuery = useQuery({
    queryKey: ['crawl-job', jobId],
    queryFn: () => getCrawlJob(jobId as string, activeProjectId as string),
    enabled: !!jobId && !!activeProjectId,
    retry: false,
    refetchInterval: (q) => (q.state.data?.job?.status === 'running' ? 1500 : false),
  })
  const job = jobQuery.data?.job ?? null
  const isRunning = job?.status === 'running'
  // True while starting the POST or while the job runs — drives the busy UI.
  const busy = crawl.isPending || isRunning
  const progress = job ? { done: job.doneCount, total: job.total } : null

  // Live log + post-crawl results, derived from the job (so they survive reloads).
  const logs: LogLine[] = (job?.logs ?? []).map((l: CrawlLogLine, i) => ({
    id: i,
    kind: l.level === 'success' ? 'ok' : l.level === 'error' ? 'error' : 'info',
    text: l.text,
    time: new Date(l.time).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }),
  }))
  const results: CrawlResult[] = (job?.items ?? [])
    .filter((it) => it.status === 'done' && it.result && !hiddenResults.has(it.displayId))
    .map((it) => it.result as CrawlResult)

  function clearCrawlJob() {
    setJobId(null)
    clearActiveCrawlJobId(activeProjectId)
    setHiddenResults(new Set())
  }

  function toggleSelect(t: ClickupTask) {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(t.id)) next.delete(t.id)
      else next.set(t.id, t)
      return next
    })
  }
  function selectAll() {
    setSelected((prev) => {
      const next = new Map(prev)
      for (const t of tasks ?? []) next.set(t.id, t)
      return next
    })
  }

  // The list fetches only parent tickets; a parent's subtasks are loaded on demand
  // when its row is expanded. We keep the loaded subtasks here and fold them back
  // into the tree, so the cap on the list query is spent only on parent tickets.
  const [subtasks, setSubtasks] = useState<Map<string, ClickupTask>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadedParents, setLoadedParents] = useState<Set<string>>(new Set())
  const [loadingParents, setLoadingParents] = useState<Set<string>>(new Set())

  // Reset the lazy-loaded subtask caches when the parent list changes (project,
  // workspace, list binding, or search) — old subtasks no longer apply.
  const listKey = `${source}|${activeProjectId}|${cuBinding?.listId ?? activeTeam}|${debounced.trim()}`
  const [seenListKey, setSeenListKey] = useState(listKey)
  if (seenListKey !== listKey) {
    setSeenListKey(listKey)
    setSubtasks(new Map())
    setExpanded(new Set())
    setLoadedParents(new Set())
    setLoadingParents(new Set())
  }

  // Tree from parents + any subtasks loaded so far, grouped by ClickUp status.
  const tree = buildTree([...(tasks ?? []), ...subtasks.values()])
  const statusGroups = groupByStatus(tree)

  async function loadSubtasks(parentId: string) {
    if (loadedParents.has(parentId) || loadingParents.has(parentId)) return
    setLoadingParents((prev) => new Set(prev).add(parentId))
    try {
      const subs = await (source === 'jira'
        ? jiraSubtasks(parentId, activeProjectId ?? undefined)
        : clickupSubtasks(parentId, activeProjectId ?? undefined))
      setSubtasks((prev) => {
        const next = new Map(prev)
        for (const s of subs) next.set(s.id, s)
        return next
      })
      // One include_subtasks call returns the whole subtree, so mark every node in
      // it (plus the parent) as loaded — leaves then won't show a stray chevron.
      setLoadedParents((prev) => {
        const next = new Set(prev)
        next.add(parentId)
        for (const s of subs) next.add(s.id)
        return next
      })
    } catch (err) {
      toast.error('Could not load subtasks', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setLoadingParents((prev) => {
        const next = new Set(prev)
        next.delete(parentId)
        return next
      })
    }
  }

  function toggleExpand(t: ClickupTask) {
    const willExpand = !expanded.has(t.id)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(t.id)) next.delete(t.id)
      else next.add(t.id)
      return next
    })
    if (willExpand && !loadedParents.has(t.id)) void loadSubtasks(t.id)
  }

  // Render a ticket row and, recursively, its subtasks (indented with a guide line).
  function renderNode(node: TicketNode): ReactElement {
    const t = node.task
    const isSel = selected.has(t.id)
    const crawled = isCrawled(t)
    const when = crawledAt(t)
    const tcCount = testcaseCount(t)
    const hasChildren = node.children.length > 0
    const isLoading = loadingParents.has(t.id)
    const isLoaded = loadedParents.has(t.id)
    const isOpen = expanded.has(t.id)
    // Show a chevron when there are subtasks, or when this node hasn't been probed
    // yet (so it might have some). Once probed and empty, the chevron disappears.
    const expandable = hasChildren || !isLoaded
    return (
      <div key={t.id} className="space-y-1">
        <div className="group relative flex items-stretch gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={() => toggleExpand(t)}
              aria-label={isOpen ? 'Collapse subtasks' : 'Expand subtasks'}
              className="flex w-5 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground"
            >
              {isLoading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : isOpen ? (
                <ChevronDown className="size-4" />
              ) : (
                <ChevronRight className="size-4" />
              )}
            </button>
          ) : (
            <span className="w-5 shrink-0" aria-hidden />
          )}
          <button
            type="button"
            onClick={() => toggleSelect(t)}
            aria-pressed={isSel}
            className={cn(
              'relative flex flex-1 items-center gap-3 overflow-hidden rounded-2xl border px-3 py-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
              // Reserve room on the right for the hover action buttons: the ClickUp
              // link is always present; the delete button shows only when crawled.
              t.url ? (crawled ? 'pr-16' : 'pr-9') : crawled ? 'pr-9' : '',
              isSel
                ? 'border-primary/40 bg-primary/5 shadow-sm'
                : crawled
                  ? 'border-emerald-500/35 bg-emerald-500/[0.07] hover:border-emerald-500/55 hover:bg-emerald-500/[0.12]'
                  : 'border-transparent hover:border-border hover:bg-accent',
            )}
          >
            {/* Accent rail marks a crawled (downloaded) ticket at a glance. */}
            {crawled && !isSel && (
              <span className="absolute inset-y-0 left-0 w-1 bg-emerald-500" aria-hidden />
            )}
            <span
              className={cn(
                'flex size-[18px] shrink-0 items-center justify-center rounded-md border transition-colors',
                isSel
                  ? 'border-primary bg-primary text-primary-foreground'
                  : crawled
                    ? 'border-emerald-500/50 group-hover:border-emerald-500/80'
                    : 'border-muted-foreground/40 group-hover:border-muted-foreground/70',
              )}
              aria-hidden
            >
              {isSel && <Check className="size-3" />}
            </span>
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block break-words text-sm font-medium leading-snug">{t.name}</span>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="rounded-xl border border-border/60 bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                  {t.displayId}
                </span>
                <StatusPill status={t.status} color={t.statusColor} />
                {!binding && t.listName && (
                  <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
                    <ListChecks className="size-3 shrink-0" />
                    <span className="max-w-[10rem] truncate">{t.listName}</span>
                  </span>
                )}
                {hasChildren && (
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {node.children.length} subtask{node.children.length === 1 ? '' : 's'}
                  </span>
                )}
                {crawled && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm"
                    title={when ? `Last crawled ${new Date(when).toLocaleString()}` : 'Crawled'}
                  >
                    <CheckCircle2 className="size-3" />
                    Crawled{when ? ` · ${timeAgo(when)}` : ''}
                  </span>
                )}
                {tcCount > 0 && (
                  <span
                    className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700 ring-1 ring-violet-600/20"
                    title={`${tcCount} generated test-case version${tcCount === 1 ? '' : 's'} in this folder`}
                  >
                    <ListChecks className="size-3" />
                    {tcCount} test case{tcCount === 1 ? '' : 's'}
                  </span>
                )}
              </span>
            </span>
          </button>
          {/* Open the ticket in its tracker — always available; sits left of delete
              when the ticket is also crawled. */}
          {t.url && (
            <a
              href={t.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title="Open ticket"
              aria-label={`Open ${t.displayId}`}
              className={cn(
                'absolute top-2 flex size-7 items-center justify-center rounded-xl text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 active:scale-95',
                crawled ? 'right-9' : 'right-2',
              )}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          {crawled && (
            <button
              type="button"
              onClick={() => setPendingDelete(t)}
              title="Delete downloaded files"
              aria-label={`Delete crawled files for ${t.displayId}`}
              className="absolute right-2 top-2 flex size-7 items-center justify-center rounded-xl text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 active:scale-95"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
        {isOpen && (hasChildren || isLoading || isLoaded) && (
          <div className="ml-6 space-y-1 border-l border-border/60 pl-1.5">
            {node.children.map((c) => renderNode(c))}
            {isLoading && (
              <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Loading subtasks…
              </div>
            )}
            {!isLoading && isLoaded && !hasChildren && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No subtasks.</div>
            )}
          </div>
        )}
      </div>
    )
  }

  function saveBinding(b: ListBinding) {
    if (!activeProjectId) return
    saveListBinding(activeProjectId, b)
    setBinding(b)
  }
  function clearBinding() {
    if (!activeProjectId) return
    clearListBinding(activeProjectId)
    setBinding(null)
  }

  // ---- Empty states ----

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Ticket className="h-5 w-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Tickets</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Ticket className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to crawl tickets into it.
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
          <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Ticket className="h-5 w-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Tickets</h1>
            <p className="text-sm text-muted-foreground">
              Pick a ticket and crawl it — its description, comments, and attachments are
              downloaded into the project so the QC skill can read them locally.
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
                  Downloading into
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
                <FolderDown className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/testing/tickets</span>
              </span>
              <OpenFolderButton
                open={() => openTicketsFolder(activeProjectId)}
                label="tickets"
              />
            </div>
          </div>
        )}
      </header>

      {!configured ? (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <ListChecks className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              No ticket tracker is connected. Connect ClickUp or Jira on the{' '}
              <a href="/mcp" className="font-medium text-primary hover:underline">
                MCP page
              </a>{' '}
              to browse and crawl tickets.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Browser */}
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-3 py-5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Ticket className="size-4 text-muted-foreground" />
                  Browse tickets
                  {tasks && tasks.length > 0 && (
                    <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                      {tasks.length}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1">
                  {/* Source toggle — only when both trackers are connected. */}
                  {bothConfigured && (
                    <div className="mr-1 inline-flex items-center rounded-full border border-border/60 bg-muted/40 p-0.5 text-xs">
                      {(['clickup', 'jira'] as const).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => chooseSource(s)}
                          className={cn(
                            'rounded-full px-2.5 py-1 font-medium transition-colors',
                            source === s
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {s === 'clickup' ? 'ClickUp' : 'Jira'}
                        </button>
                      ))}
                    </div>
                  )}
                  {!cuBinding && workspaces && workspaces.length > 1 && (
                    <Select value={activeTeam} onValueChange={chooseTeam}>
                      <SelectTrigger
                        size="sm"
                        className="h-7 max-w-40 border-none bg-transparent text-xs text-muted-foreground shadow-none hover:text-foreground"
                      >
                        <SelectValue placeholder={source === 'jira' ? 'Project' : 'Workspace'} />
                      </SelectTrigger>
                      <SelectContent>
                        {workspaces.map((w) => (
                          <SelectItem key={w.id} value={w.id} className="text-xs">
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {/* List binding is ClickUp-only; Jira scopes by project. */}
                  {source === 'clickup' && (
                    <button
                      type="button"
                      onClick={() => setConfiguring(true)}
                      title={binding ? 'Change the bound list' : 'Bind this project to a ClickUp list'}
                      className="inline-flex max-w-52 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                    >
                      {binding ? (
                        <>
                          <ListChecks className="size-3.5 shrink-0" />
                          <span className="truncate">{binding.listName}</span>
                        </>
                      ) : (
                        <>
                          <Settings2 className="size-3.5" />
                          Use a list
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="group relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <Input
                  placeholder={
                    cuBinding
                      ? `Search “${cuBinding.listName}”…`
                      : source === 'jira'
                        ? 'Search Jira issues…'
                        : 'Search ClickUp tasks…'
                  }
                  value={query}
                  autoComplete="off"
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-11 rounded-full pl-9 shadow-none"
                />
                {isFetching && (
                  <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                )}
              </div>

              {tasks && tasks.length > 0 && (
                <div className="flex items-center justify-between px-1 text-xs">
                  <span className="text-muted-foreground">
                    {selected.size > 0
                      ? `${selected.size} selected`
                      : `${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={selectAll}
                      className="inline-flex items-center gap-1 font-medium text-muted-foreground transition-colors hover:text-primary"
                    >
                      <CheckCheck className="size-3.5" />
                      Select all
                    </button>
                    {selected.size > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelected(new Map())}
                        className="font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div className="space-y-1">
                {!tasks && isFetching && (
                  <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    {cuBinding ? 'Loading list…' : 'Searching…'}
                  </div>
                )}
                {tasks && tasks.length === 0 && (
                  <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                    <Search className="size-3.5" />
                    No matching tasks.
                  </div>
                )}
                {statusGroups.map((group) => (
                  <div key={group.status || '∅'} className="space-y-1">
                    {/* Status header — sticks to the top of the scroll area so the
                        group a row belongs to stays visible while scrolling. */}
                    <div
                      className="sticky top-0 z-10 -mx-1 flex items-center gap-2 bg-card/95 px-2 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-card/80"
                    >
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                        style={{
                          color: group.color || 'var(--muted-foreground)',
                          backgroundColor: statusTint(group.color, 0.13),
                        }}
                      >
                        <span
                          className="size-1.5 rounded-full"
                          style={{ backgroundColor: group.color || 'var(--muted-foreground)' }}
                          aria-hidden
                        />
                        {group.status || 'No status'}
                      </span>
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {group.nodes.length}
                      </span>
                      <span className="h-px flex-1 bg-border/60" aria-hidden />
                    </div>
                    {group.nodes.map((node) => renderNode(node))}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {isRunning && (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" />
              Crawling on the server — you can leave this page or reload; it keeps running and you’ll
              get a notification when it’s done.
            </p>
          )}

          {logs.length > 0 && (
            <CrawlLogPanel
              logs={logs}
              open={showLogs}
              busy={busy}
              onToggle={() => setShowLogs((v) => !v)}
              onClear={clearCrawlJob}
            />
          )}

          {results.length > 0 && <CrawlResultsPanel results={results} />}
        </div>
      )}

      {/* Sticky action bar — appears once tickets are picked, so the crawl button
          is always reachable without a second column eating the page width. */}
      {configured && selected.size > 0 && (
        <div className="sticky bottom-4 z-20">
          <div className="space-y-2 rounded-3xl border border-border/60 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
                <DownloadCloud className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-tight">
                  {selected.size} ticket{selected.size === 1 ? '' : 's'} selected
                </p>
                {busy && progress && progress.total > 0 ? (
                  <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                      style={{ width: `${(progress.done / progress.total) * 100}%` }}
                    />
                  </div>
                ) : (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {[...selected.values()].map((t) => t.displayId).join(', ')}
                  </p>
                )}
              </div>

              {/* Pick how each ticket is processed: plain download or an AI brief. */}
              <Select value={crawlModel} onValueChange={chooseCrawlModel} disabled={busy}>
                <SelectTrigger
                  size="sm"
                  className="h-9 w-auto min-w-[8.5rem] shrink-0 gap-2 rounded-full"
                  aria-label="Crawl processing model"
                >
                  <Sparkles className="size-3.5 shrink-0 text-primary" />
                  {/* Show only the short label in the trigger — the full
                      description lives in the dropdown and the helper line. */}
                  <SelectValue
                    aria-label={crawlModelInfo.label}
                    placeholder="Choose model"
                  >
                    <span className="text-xs font-medium">{crawlModelInfo.label}</span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="max-w-[20rem]">
                  {CRAWL_MODELS.map((m) => (
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
                variant="ghost"
                size="sm"
                onClick={() => setSelected(new Map())}
                disabled={busy}
                className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                Clear
              </Button>
              <Button
                onClick={() => crawl.mutate([...selected.values()])}
                disabled={busy}
                className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {busy ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Crawling {progress ? `${progress.done}/${progress.total}` : ''}…
                  </>
                ) : (
                  <>
                    <DownloadCloud className="size-4" />
                    Crawl {selected.size}
                  </>
                )}
              </Button>
            </div>

            {/* Plain-language note about what the chosen model does to the crawl. */}
            <p className="flex items-start gap-1.5 pl-1 text-[11px] leading-snug text-muted-foreground">
              <Sparkles className="mt-0.5 size-3 shrink-0 text-primary/70" />
              <span>
                <span className="font-medium text-foreground">{crawlModelInfo.label}:</span>{' '}
                {crawlModelInfo.description}
                {crawlModel !== 'none' && ' Saved as summary.md in each ticket folder.'}
              </span>
            </p>
          </div>
        </div>
      )}

      <ConfigureListDialog
        open={configuring}
        onOpenChange={setConfiguring}
        current={binding}
        onSave={saveBinding}
        onClear={clearBinding}
        projectId={activeProjectId ?? undefined}
      />

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(o) => {
          if (!o && !del.isPending) setPendingDelete(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              Delete crawled files
            </DialogTitle>
            <DialogDescription>
              This removes the downloaded folder{' '}
              <span className="font-mono text-foreground">
                testing/tickets/{pendingDelete ? safeSegment(pendingDelete.displayId) : ''}
              </span>{' '}
              (description, comments &amp; attachments) from the project. You can re-crawl the
              ticket any time.
            </DialogDescription>
          </DialogHeader>

          {/* Test cases live inside the ticket folder — deleting it loses them
              too, and they aren't recreated by a re-crawl. Warn first. */}
          {pendingDelete && testcaseCount(pendingDelete) > 0 && (
            <div className="flex items-start gap-2.5 rounded-2xl border border-amber-300/60 bg-amber-50 px-3 py-2.5 text-amber-800">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div className="space-y-0.5 text-sm">
                <p className="font-medium">
                  This ticket has {testcaseCount(pendingDelete)} generated test-case
                  {testcaseCount(pendingDelete) === 1 ? '' : 's'}.
                </p>
                <p className="text-[13px] leading-snug text-amber-700">
                  Deleting the folder also removes its{' '}
                  <span className="font-mono">testcases/</span> — a re-crawl won't bring them back.
                </p>
              </div>
            </div>
          )}
          <DialogFooter className="sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={del.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && del.mutate(pendingDelete)}
              disabled={del.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {del.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Deleting…
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Delete
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
