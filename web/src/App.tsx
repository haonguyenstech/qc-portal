import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  ArrowUpCircle,
  BookOpen,
  BookText,
  CheckCircle2,
  ClipboardList,
  Code2,
  FileCog,
  FileText,
  FolderGit2,
  History,
  Loader2,
  Layout,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Plug,
  Plus,
  RadioTower,
  RefreshCw,
  ScanSearch,
  ScrollText,
  Settings,
  TerminalSquare,
  Ticket,
  Upload,
  Wrench,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RouteGuideTour } from '@/components/RouteGuideTour'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { checkForUpdate, getVersion, triggerUpdate } from '@/lib/api'
import { listRuns } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import NotificationBell from '@/components/NotificationBell'
import TestCaseJobWatcher from '@/components/TestCaseJobWatcher'
import CrawlJobWatcher from '@/components/CrawlJobWatcher'
import VerifyJobWatcher from '@/components/VerifyJobWatcher'
import SourceJobWatcher from '@/components/SourceJobWatcher'
import RunPage from '@/pages/RunPage'
import RunningPage from '@/pages/RunningPage'
import HistoryPage from '@/pages/HistoryPage'
import RunDetailPage from '@/pages/RunDetailPage'
import SkillsPage from '@/pages/SkillsPage'
import TicketsPage from '@/pages/TicketsPage'
import TestCasePage from '@/pages/TestCasePage'
import ApiTestingPage from '@/pages/ApiTestingPage'
import PrototypePage from '@/pages/PrototypePage'
import McpPage from '@/pages/McpPage'
import ProjectsPage from '@/pages/ProjectsPage'
import ProjectSettingsPage from '@/pages/ProjectSettingsPage'
import InstructionsPage from '@/pages/InstructionsPage'
import OverviewPage from '@/pages/OverviewPage'
import SourceCodePage from '@/pages/SourceCodePage'
import DiagramsPage from '@/pages/DiagramsPage'
import VerifyDesignPage from '@/pages/VerifyDesignPage'
import TerminalPage from '@/pages/TerminalPage'
import NotificationsPage from '@/pages/NotificationsPage'
import ReleaseNotesPage from '@/pages/ReleaseNotesPage'
import DocumentPage from '@/pages/DocumentPage'

/** Custom app mark: a "Q" ring + tail (quality control) framing a bold checkmark.
 *  Strokes use currentColor so it inherits the badge's text color. */
function AppLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Q ring + tail, dimmed so the check reads first */}
      <circle cx="14.5" cy="14.5" r="8.4" stroke="currentColor" strokeWidth="2.3" strokeOpacity="0.5" />
      <path
        d="M19 19l5.6 5.6"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeOpacity="0.5"
      />
      {/* bold check on top */}
      <path
        d="M10.8 14.8l3 3 6-6.7"
        stroke="currentColor"
        strokeWidth="2.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

interface NavItemDef {
  to: string
  label: string
  icon: typeof BookOpen
  end: boolean
}

const navGroups: { label: string; items: NavItemDef[] }[] = [
  {
    label: 'Project',
    items: [
      { to: '/overview', label: 'Overview', icon: BookOpen, end: false },
      { to: '/source', label: 'Source Code', icon: Code2, end: false },
      // Diagrams hidden temporarily — restore this entry to bring it back.
      // { to: '/diagrams', label: 'Diagrams', icon: Workflow, end: false },
    ],
  },
  {
    label: 'Testing',
    items: [
      { to: '/tickets', label: 'Tickets', icon: Ticket, end: false },
      { to: '/testcases', label: 'TestCase', icon: ClipboardList, end: false },
      { to: '/qc-run', label: 'Run', icon: PlayCircle, end: false },
      { to: '/running', label: 'Running', icon: RadioTower, end: false },
      { to: '/history', label: 'History', icon: History, end: false },
      { to: '/verify', label: 'Design Check', icon: ScanSearch, end: false },
      { to: '/api-testing', label: 'API Testing', icon: Zap, end: false },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/instructions', label: 'Instructions', icon: FileText, end: false },
      { to: '/skills', label: 'Skills', icon: Wrench, end: false },
      { to: '/mcp', label: 'MCP', icon: Plug, end: false },
      { to: '/templates', label: 'Templates', icon: FileCog, end: false },
    ],
  },
  {
    label: 'Tools',
    items: [
      { to: '/prototype', label: 'Prototype', icon: Layout, end: false },
      { to: '/terminal', label: 'Terminal', icon: TerminalSquare, end: false },
    ],
  },
  {
    label: 'System',
    items: [{ to: '/settings', label: 'Settings', icon: Settings, end: false }],
  },
]

const SIDEBAR_KEY = 'qc.sidebar.collapsed'

/** Sidebar collapsed/expanded state, persisted across reloads. */
function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0')
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [collapsed])
  return [collapsed, setCollapsed] as const
}

/** The pulsing "running" count chip shown next to the Running nav label (expanded). */
function RunningBadge({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={cn(
        'ml-auto inline-flex min-w-5 items-center justify-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
        active ? 'bg-primary text-primary-foreground' : 'bg-sky-500 text-white',
      )}
      title={`${count} test${count === 1 ? '' : 's'} running`}
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {count}
    </span>
  )
}

/** A single sidebar link. Collapsed → icon-only square with a right-side tooltip. */
function NavItem({
  item,
  collapsed,
  liveCount,
}: {
  item: NavItemDef
  collapsed: boolean
  liveCount: number
}) {
  const { to, label, icon: Icon, end } = item
  const showRunning = to === '/running' && liveCount > 0
  const { pathname } = useLocation()
  // Compute active state ourselves rather than via NavLink's className/children
  // render-props: when collapsed the link is wrapped in <TooltipTrigger asChild>,
  // whose Radix Slot stringifies a function className. A plain string is Slot-safe.
  const isActive = end ? pathname === to : pathname === to || pathname.startsWith(`${to}/`)

  const link = (
    <NavLink
      to={to}
      end={end}
      className={cn(
        'group relative flex items-center text-sm font-medium transition-all duration-200 active:scale-[0.98]',
        collapsed ? 'h-10 w-10 justify-center rounded-xl' : 'gap-3 rounded-lg px-3 py-2',
        isActive
          ? collapsed
            ? 'bg-primary/12 text-primary ring-1 ring-inset ring-primary/25'
            : 'bg-gradient-to-r from-primary/15 to-primary/5 text-primary shadow-sm'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {!collapsed && (
        <span
          className={cn(
            'absolute left-0 top-1/2 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-all duration-300',
            isActive ? 'h-5 opacity-100' : 'h-0 opacity-0',
          )}
        />
      )}
      <Icon
        className={cn(
          'h-4 w-4 shrink-0 transition-transform duration-200 group-hover:scale-110',
          isActive && 'scale-110',
        )}
      />
      {!collapsed && label}
      {!collapsed && showRunning && <RunningBadge count={liveCount} active={isActive} />}
      {collapsed && showRunning && (
        <span className="absolute right-1 top-1 flex size-2">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-500 opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-sky-500" />
        </span>
      )}
    </NavLink>
  )

  if (!collapsed) return link

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-2 font-medium">
        {label}
        {showRunning && (
          <span className="rounded-full bg-sky-500 px-1.5 text-[10px] font-semibold tabular-nums text-white">
            {liveCount}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

function ProjectSwitcher({ collapsed, onExpand }: { collapsed: boolean; onExpand: () => void }) {
  const { projects, activeProjectId, setActiveProjectId, isLoading } = useProjects()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const initial = (activeProject?.name ?? '?').trim().charAt(0).toUpperCase() || '?'

  // Collapsed: a compact square showing the project initial. Clicking expands the
  // sidebar so the full picker (and the settings gear) are reachable again.
  if (collapsed) {
    return (
      <div className="mb-2 flex shrink-0 justify-center border-b border-sidebar-border/60 px-2 pb-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpand}
              aria-label="Switch project"
              className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-sidebar-border/70 bg-muted/50 text-sm font-semibold text-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted active:scale-95"
            >
              {activeProject?.exists === false && (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-sidebar bg-destructive" />
              )}
              {initial}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {activeProject?.name ?? 'Select project'}
          </TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="mx-3 mb-2 shrink-0 border-b border-sidebar-border/60 pb-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        <FolderGit2 className="h-3 w-3" />
        Workspace
      </div>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={activeProjectId ?? undefined}
        onValueChange={setActiveProjectId}
        disabled={isLoading}
      >
        <SelectTrigger className="h-auto! w-full gap-2 rounded-xl border-sidebar-border/70 bg-muted/50 py-2 pl-2 shadow-none transition-all duration-200 hover:border-border hover:bg-muted data-[state=open]:border-border data-[state=open]:bg-muted">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
              {initial}
              {activeProject?.exists === false && (
                <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-sidebar bg-destructive" />
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm font-medium text-foreground">
                {activeProject?.name ?? (isLoading ? 'Loading…' : 'Select project')}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {isLoading
                  ? 'Loading projects…'
                  : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
              </span>
            </span>
          </span>
        </SelectTrigger>
        <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
          {projects.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground">No projects yet</div>
          ) : (
            projects.map((p) => (
              <SelectItem key={p.id} value={p.id} className="rounded-lg py-1.5 pl-2">
                <span className="flex items-center gap-2">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-muted text-[11px] font-semibold text-foreground">
                    {(p.name ?? '?').trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.exists === false && (
                    <span
                      className="size-2 shrink-0 rounded-full bg-destructive"
                      aria-label="Folder not found"
                    />
                  )}
                </span>
              </SelectItem>
            ))
          )}
          <SelectSeparator />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/settings?tab=projects&add=1')
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-primary outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-dashed border-primary/40 text-primary">
              <Plus className="size-3.5" />
            </span>
            Add new project
          </button>
        </SelectContent>
      </Select>
    </div>
  )
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Probe the server's reported version with a HARD timeout. Returns the version
 * string when reachable, `null` when reachable but the version is unknown, and
 * `undefined` when unreachable / timed out.
 *
 * The timeout is what makes this safe on Windows: a fetch to a just-killed or
 * rebinding port can hang "pending" for ~20s (the OS drops the SYN with no RST)
 * instead of failing fast, which would stall the poll loop below and leave the
 * page spinning. An AbortController caps every probe so each one fails fast and
 * the loop keeps its cadence. `cache: no-store` stops a cached 200 from faking
 * reachability while the server is actually down.
 */
async function probeServerVersion(timeoutMs = 4000): Promise<string | null | undefined> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch('/api/version', { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) return undefined
    const data = (await res.json().catch(() => null)) as { current?: string | null } | null
    return typeof data?.current === 'string' ? data.current : null
  } catch {
    return undefined // unreachable, or aborted by the timeout
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wait out a self-update: the launcher stops the server, rebuilds it (git reset +
 * npm install + build — slow, hence the generous "up" budget), then starts a fresh
 * one on the same port.
 *
 * We only report "back" once the server answers as a genuinely RESTARTED process —
 * either reporting the new version, or (a no-op rebuild) any reachable server after
 * we've witnessed it go down first — and we require two consecutive good probes.
 * That is what prevents the Windows "stuck loading" bug: reloading onto the OLD
 * server that's about to be killed, or onto a half-up one mid-restart.
 */
async function waitForRestart(prevVersion: string | null): Promise<boolean> {
  const changed = (v: string) => !!prevVersion && v !== prevVersion

  // Phase 1 — watch it go down. If it instead comes straight back on a new version
  // (the restart landed between two probes), we're already done.
  const downDeadline = Date.now() + 90_000
  let sawDown = false
  while (Date.now() < downDeadline) {
    const v = await probeServerVersion()
    if (v === undefined) {
      sawDown = true
      break
    }
    if (typeof v === 'string' && changed(v)) return true
    await sleep(1500)
  }

  // Phase 2 — wait for it to answer again as a restarted server, twice in a row.
  const upDeadline = Date.now() + 5 * 60_000
  let good = 0
  while (Date.now() < upDeadline) {
    await sleep(2000)
    const v = await probeServerVersion()
    if (typeof v !== 'string') {
      good = 0
      continue
    }
    // Accept a changed version, or — if the version never changes (no-op rebuild) —
    // any reachable server, but only once we've confirmed it actually went down
    // first, so we never reload onto the still-up old process.
    if (changed(v) || sawDown) {
      if (++good >= 2) return true
    } else {
      good = 0
    }
  }
  return false
}

/** Compact "how long ago" label for the last update check (e.g. "3m ago"). */
function timeAgoShort(iso?: string | null): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function VersionFooter({ collapsed }: { collapsed: boolean }) {
  const { data: versionData } = useQuery({ queryKey: ['app-version'], queryFn: getVersion })
  const version = versionData?.current ?? __APP_VERSION__

  // Auto-check for a newer release: on mount (every page load/reload), every 30 minutes,
  // and when the window regains focus — throttled by staleTime so tab-switching doesn't
  // hammer the upstream git fetch. Silent (drives the badge only); the button below
  // re-checks on demand with a toast.
  const updateCheck = useQuery({
    queryKey: ['update-check'],
    queryFn: checkForUpdate,
    refetchInterval: 30 * 60_000,
    refetchOnWindowFocus: true,
    staleTime: 15 * 60_000,
  })
  const [manualChecking, setManualChecking] = useState(false)

  async function runCheck() {
    setManualChecking(true)
    try {
      const { data: r } = await updateCheck.refetch()
      if (!r) return
      if (r.error) {
        toast.error('Update check failed', { description: r.error })
      } else if (r.updateAvailable) {
        toast.info(`Update available: v${r.current} → v${r.latest}`, {
          description: 'Click “Update now” to upgrade and reload.',
          duration: 8000,
        })
      } else {
        toast.success(`You're on the latest version (v${r.current}).`)
      }
    } finally {
      setManualChecking(false)
    }
  }

  const update = useMutation({
    mutationFn: triggerUpdate,
    onSuccess: async (r) => {
      if (!r.ok) {
        toast.error('Update failed to start', { description: r.error })
        return
      }
      toast.loading('Updating QC Portal…', {
        id: 'qc-update',
        description: 'Pulling, rebuilding, and restarting the server.',
        duration: Infinity,
      })
      // Gate the reload on the server coming back as a RESTARTED process (new
      // version, or a witnessed down→up), so we never reload mid-restart.
      const back = await waitForRestart(r.current ?? version)
      if (back) {
        toast.success('Update complete — reloading…', { id: 'qc-update', duration: 2000 })
        await sleep(600)
        window.location.reload()
      } else {
        toast.error('Update timed out', {
          id: 'qc-update',
          description: 'The server did not come back. Check data/update.log in the install folder.',
          duration: Infinity,
        })
      }
    },
    onError: (e) => toast.error('Update failed to start', { description: String(e) }),
  })

  const checkData = updateCheck.data
  const updateAvailable = !!checkData?.updateAvailable && !checkData.error
  const latest = checkData?.latest
  const checking = manualChecking || updateCheck.isFetching
  const checkedAgo = timeAgoShort(checkData?.checkedAt)
  const updating = update.isPending || (update.isSuccess && update.data?.ok)
  const { pathname } = useLocation()

  if (collapsed) {
    // Plain string className (not a render-prop) so the Radix Slot from
    // <TooltipTrigger asChild> doesn't stringify a className function.
    const releasesActive = pathname === '/releases'
    return (
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1.5 border-t border-sidebar-border/60 px-2 py-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/releases"
              aria-label="Release notes"
              className={cn(
                'flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95',
                releasesActive && 'bg-muted text-foreground',
              )}
            >
              <ScrollText className="size-4" />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            Release notes · v{version}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/document"
              aria-label="Documentation"
              className={cn(
                'flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95',
                pathname.startsWith('/document') && 'bg-muted text-foreground',
              )}
            >
              <BookText className="size-4" />
            </NavLink>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            Documentation
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => runCheck()}
              disabled={checking}
              aria-label="Check for updates"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
            >
              {updateAvailable ? (
                <ArrowUpCircle className="h-4 w-4 text-amber-500" />
              ) : (
                <RefreshCw className={cn('h-4 w-4', checking && 'animate-spin')} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {updateAvailable ? `Update available: v${latest}` : 'Check for updates'}
          </TooltipContent>
        </Tooltip>
        {updateAvailable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => update.mutate()}
                disabled={updating}
                aria-label="Update now"
                className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600 transition-all duration-200 hover:bg-amber-500/25 active:scale-95 disabled:opacity-50 dark:text-amber-400"
              >
                {updating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUpCircle className="h-4 w-4" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="font-medium">
              {updating ? 'Updating…' : `Update now → v${latest}`}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    )
  }

  return (
    <div className="mt-auto flex shrink-0 flex-col gap-1.5 border-t border-sidebar-border/60 px-3 py-3.5 text-xs text-muted-foreground">
      {/* Version + live update status */}
      <div
        className={cn(
          'rounded-2xl border p-1.5 transition-colors',
          updateAvailable
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-sidebar-border/60 bg-muted/40',
        )}
      >
        <div className="flex items-center gap-1">
          <NavLink
            to="/releases"
            className={({ isActive }) =>
              cn(
                'flex min-w-0 flex-1 items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-muted hover:text-foreground',
                isActive && 'bg-muted text-foreground',
              )
            }
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-sidebar-border/60 bg-background text-muted-foreground">
              <ScrollText className="size-3.5" />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-medium text-foreground">Release notes</span>
              <span className="block font-mono text-[10px] text-muted-foreground">v{version}</span>
            </span>
          </NavLink>
          <button
            type="button"
            onClick={() => runCheck()}
            disabled={checking || updating}
            title={
              checkedAgo ? `Last checked ${checkedAgo} — click to re-check` : 'Check for updates'
            }
            aria-label="Check for updates"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          </button>
        </div>

        {/* Status line — auto-updates from the background check. */}
        <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1 text-[10px]">
          {checking ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Checking for updates…
            </span>
          ) : updateAvailable ? (
            <span className="flex items-center gap-1 font-medium text-amber-600 dark:text-amber-400">
              <ArrowUpCircle className="size-3" /> Update available → v{latest}
            </span>
          ) : checkData ? (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3" /> Up to date
            </span>
          ) : (
            <span className="text-muted-foreground">Checking…</span>
          )}
          {!checking && checkedAgo && (
            <span className="ml-auto text-muted-foreground/60">{checkedAgo}</span>
          )}
        </div>

        {updateAvailable && (
          <button
            type="button"
            onClick={() => update.mutate()}
            disabled={updating}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-600 transition-all duration-200 hover:bg-amber-500/25 active:scale-[0.98] disabled:opacity-60 dark:text-amber-400"
          >
            {updating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Updating…
              </>
            ) : (
              <>
                <ArrowUpCircle className="h-3.5 w-3.5" />
                Update now → v{latest}
              </>
            )}
          </button>
        )}
      </div>

      <NavLink
        to="/document"
        className={({ isActive }) =>
          cn(
            'flex min-w-0 items-center gap-2 rounded-xl px-2.5 py-1.5 font-medium transition-colors hover:bg-muted hover:text-foreground',
            isActive && 'bg-muted text-foreground',
          )
        }
      >
        <BookText className="size-3.5 shrink-0" />
        Documentation
      </NavLink>
    </div>
  )
}

/** Collapse/expand toggle. Tooltip only appears when collapsed (label is hidden then). */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95"
    >
      <Icon className="size-4" />
    </button>
  )
  if (!collapsed) return button
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" className="font-medium">
        Expand sidebar
      </TooltipContent>
    </Tooltip>
  )
}

// Routes that work without a project — the user must still reach Settings to
// create one, and the docs / release notes are project-agnostic reference.
const PROJECT_AGNOSTIC_PREFIXES = ['/settings', '/projects', '/releases', '/document']
function isProjectAgnostic(pathname: string): boolean {
  return PROJECT_AGNOSTIC_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  )
}

/**
 * Shown in place of the routed pages when no projects exist yet — every feature
 * needs a project, so we steer the user to create (or import) one first.
 */
function NoProjectsScreen() {
  const navigate = useNavigate()
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center justify-center gap-6 py-16 text-center sm:py-24">
      <span className="flex size-16 items-center justify-center rounded-3xl bg-foreground text-background">
        <FolderGit2 className="size-8" />
      </span>
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Create a project to get started</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          QC Portal runs against a <span className="font-medium text-foreground">project</span> — a
          repo folder with its own skills, MCP servers, and testing output. Register your first one,
          or import a project <span className="font-mono">.zip</span>, to unlock the rest of the app.
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          onClick={() => navigate('/settings?tab=projects&add=1')}
          className="group h-11 rounded-full px-6 text-sm font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          <Plus className="size-4" />
          Create project
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate('/settings?tab=projects')}
          className="h-11 rounded-full px-5 text-sm font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          <Upload className="size-4" />
          Import a .zip
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        You can manage projects any time from{' '}
        <span className="font-medium text-foreground">Settings</span> in the sidebar.
      </p>
    </div>
  )
}

function App() {
  const { activeProjectId, projects, isLoading: projectsLoading } = useProjects()
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  const { data: runs } = useQuery({
    queryKey: ['runs', activeProjectId],
    queryFn: () => listRuns(activeProjectId!),
    enabled: !!activeProjectId,
    refetchInterval: 5000, // keep the live count fresh from any page
  })
  const liveCount = (runs ?? []).filter(
    (r) => r.status === 'running' || r.status === 'queued',
  ).length

  return (
    <div className="min-h-svh text-foreground">
      <TestCaseJobWatcher />
      <CrawlJobWatcher />
      <VerifyJobWatcher />
      <SourceJobWatcher />
      <NotificationBell />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-[width] duration-200 ease-out lg:flex',
          collapsed ? 'w-[72px]' : 'w-60',
        )}
      >
        {/* Brand + collapse toggle */}
        {collapsed ? (
          <div className="flex shrink-0 flex-col items-center gap-2 px-3 py-5">
            <NavLink to="/qc-run" end aria-label="QC Portal home" className="group">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/75 text-primary-foreground shadow-sm ring-1 ring-inset ring-white/15 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md group-active:scale-95">
                <AppLogo className="h-6 w-6" />
              </span>
            </NavLink>
            <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2.5 py-5 pl-4 pr-2">
            <NavLink
              to="/qc-run"
              end
              aria-label="QC Portal home"
              className="group flex min-w-0 flex-1 items-center gap-2.5"
            >
              <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/75 text-primary-foreground shadow-sm ring-1 ring-inset ring-white/15 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md">
                <AppLogo className="h-6 w-6" />
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[15px] font-semibold tracking-tight text-foreground">
                  QC Portal
                </span>
                <span className="block truncate text-[10px] font-semibold uppercase tracking-[0.05em] text-muted-foreground/80">
                  Acceptance testing
                </span>
              </span>
            </NavLink>
            <div className="-mr-1 ml-auto">
              <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
            </div>
          </div>
        )}

        <ProjectSwitcher collapsed={collapsed} onExpand={() => setCollapsed(false)} />

        <nav
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-y-auto py-3',
            collapsed ? 'items-center gap-3 px-2' : 'gap-5 px-3',
          )}
        >
          {navGroups.map((group, gi) => (
            <div
              key={group.label}
              className={cn('flex flex-col', collapsed ? 'items-center gap-1.5' : 'gap-0.5')}
            >
              {collapsed
                ? gi > 0 && <span className="mb-1.5 h-px w-6 rounded-full bg-sidebar-border/70" />
                : (
                  <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/55">
                    {group.label}
                  </div>
                )}
              {group.items.map((item) => (
                <NavItem key={item.to} item={item} collapsed={collapsed} liveCount={liveCount} />
              ))}
            </div>
          ))}
        </nav>

        <VersionFooter collapsed={collapsed} />
      </aside>

      <main
        className={cn(
          'transition-[padding] duration-200 ease-out',
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-60',
        )}
      >
        <div
          className={cn(
            'mx-auto px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8',
            // The Prototype workspace (chat + live preview) needs the full width;
            // every other page stays comfortably capped.
            pathname === '/prototype' ? 'max-w-none' : 'max-w-6xl',
          )}
        >
          {!projectsLoading && projects.length === 0 && !isProjectAgnostic(pathname) ? (
            <NoProjectsScreen />
          ) : (
          <Routes>
            <Route path="/" element={<Navigate to="/qc-run" replace />} />
            <Route path="/qc-run" element={<RunPage />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/source" element={<SourceCodePage />} />
            <Route path="/diagrams" element={<DiagramsPage />} />
            <Route path="/running" element={<RunningPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/run/:id" element={<RunDetailPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/testcases" element={<TestCasePage />} />
            <Route path="/verify" element={<VerifyDesignPage />} />
            <Route path="/api-testing" element={<ApiTestingPage />} />
            <Route path="/prototype" element={<PrototypePage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/releases" element={<ReleaseNotesPage />} />
            <Route path="/document" element={<Navigate to="/document/overview" replace />} />
            <Route path="/document/:slug" element={<DocumentPage />} />
            <Route path="/instructions" element={<InstructionsPage />} />
            <Route path="/templates" element={<ProjectSettingsPage />} />
            <Route path="/settings" element={<ProjectsPage />} />
            <Route path="/projects" element={<Navigate to="/settings" replace />} />
          </Routes>
          )}
          <RouteGuideTour />
        </div>
      </main>
    </div>
  )
}

export default App
