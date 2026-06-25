import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUpCircle,
  BookOpen,
  ClipboardList,
  FileText,
  FolderGit2,
  History,
  PanelLeftClose,
  PanelLeftOpen,
  PlayCircle,
  Plug,
  RadioTower,
  RefreshCw,
  ScanSearch,
  ScrollText,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Ticket,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { checkForUpdate, getVersion } from '@/lib/api'
import { listRuns } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import NotificationBell from '@/components/NotificationBell'
import TestCaseJobWatcher from '@/components/TestCaseJobWatcher'
import CrawlJobWatcher from '@/components/CrawlJobWatcher'
import VerifyJobWatcher from '@/components/VerifyJobWatcher'
import RunPage from '@/pages/RunPage'
import RunningPage from '@/pages/RunningPage'
import HistoryPage from '@/pages/HistoryPage'
import RunDetailPage from '@/pages/RunDetailPage'
import SkillsPage from '@/pages/SkillsPage'
import TicketsPage from '@/pages/TicketsPage'
import TestCasePage from '@/pages/TestCasePage'
import McpPage from '@/pages/McpPage'
import ProjectsPage from '@/pages/ProjectsPage'
import ProjectSettingsPage from '@/pages/ProjectSettingsPage'
import InstructionsPage from '@/pages/InstructionsPage'
import OverviewPage from '@/pages/OverviewPage'
import VerifyDesignPage from '@/pages/VerifyDesignPage'
import TerminalPage from '@/pages/TerminalPage'
import NotificationsPage from '@/pages/NotificationsPage'
import ReleaseNotesPage from '@/pages/ReleaseNotesPage'

interface NavItemDef {
  to: string
  label: string
  icon: typeof BookOpen
  end: boolean
}

const navGroups: { label: string; items: NavItemDef[] }[] = [
  {
    label: 'Project',
    items: [{ to: '/overview', label: 'Overview', icon: BookOpen, end: false }],
  },
  {
    label: 'Testing',
    items: [
      { to: '/tickets', label: 'Tickets', icon: Ticket, end: false },
      { to: '/testcases', label: 'TestCase', icon: ClipboardList, end: false },
      { to: '/verify', label: 'Design Check', icon: ScanSearch, end: false },
      { to: '/', label: 'Run', icon: PlayCircle, end: true },
      { to: '/running', label: 'Running', icon: RadioTower, end: false },
      { to: '/history', label: 'History', icon: History, end: false },
    ],
  },
  {
    label: 'Configure',
    items: [
      { to: '/instructions', label: 'Instructions', icon: FileText, end: false },
      { to: '/skills', label: 'Skills', icon: Wrench, end: false },
      { to: '/mcp', label: 'MCP', icon: Plug, end: false },
      { to: '/templates', label: 'Settings', icon: Settings, end: false },
    ],
  },
  {
    label: 'Tools',
    items: [{ to: '/terminal', label: 'Terminal', icon: TerminalSquare, end: false }],
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

  const link = (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center rounded-lg text-sm font-medium transition-all duration-200 active:scale-[0.98]',
          collapsed ? 'h-10 w-10 justify-center' : 'gap-3 px-3 py-2',
          isActive
            ? 'bg-gradient-to-r from-primary/15 to-primary/5 text-primary shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'absolute left-0 top-1/2 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-all duration-300',
              isActive ? 'h-5 opacity-100' : 'h-0 opacity-0',
            )}
          />
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
        </>
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
  const activeProject = projects.find((p) => p.id === activeProjectId)
  const initial = (activeProject?.name ?? '?').trim().charAt(0).toUpperCase() || '?'

  // Collapsed: a compact square showing the project initial. Clicking expands the
  // sidebar so the full picker (and the settings gear) are reachable again.
  if (collapsed) {
    return (
      <div className="mb-2 flex justify-center border-b border-sidebar-border/60 px-2 pb-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onExpand}
              aria-label="Switch project"
              className="relative flex h-10 w-10 items-center justify-center rounded-lg border border-sidebar-border/70 bg-muted/50 text-sm font-semibold text-foreground transition-all duration-200 hover:bg-muted active:scale-95"
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
    <div className="mx-3 mb-2 border-b border-sidebar-border/60 px-0 pb-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        <FolderGit2 className="h-3 w-3" />
        Workspace
      </div>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Select
            value={activeProjectId ?? undefined}
            onValueChange={setActiveProjectId}
            disabled={isLoading || projects.length === 0}
          >
            <SelectTrigger className="w-full" size="sm">
              <SelectValue placeholder={isLoading ? 'Loading…' : 'Select project'} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <span className="flex items-center gap-2">
                    {p.exists === false && (
                      <span
                        className="h-2 w-2 shrink-0 rounded-full bg-destructive"
                        aria-label="Folder not found"
                      />
                    )}
                    <span className="truncate">{p.name}</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NavLink
          to="/settings"
          title="Open settings"
          aria-label="Open settings"
          className={({ isActive }) =>
            cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95',
              isActive
                ? 'border-primary/30 bg-primary/10 text-primary'
                : 'text-muted-foreground',
            )
          }
        >
          <Settings className="h-4 w-4" />
        </NavLink>
      </div>
    </div>
  )
}

function VersionFooter({ collapsed }: { collapsed: boolean }) {
  const { data: versionData } = useQuery({ queryKey: ['app-version'], queryFn: getVersion })
  const version = versionData?.current ?? __APP_VERSION__

  const check = useMutation({
    mutationFn: checkForUpdate,
    onSuccess: (r) => {
      if (r.error) {
        toast.error('Update check failed', { description: r.error })
      } else if (r.updateAvailable) {
        toast.info(`Update available: v${r.current} → v${r.latest}`, {
          description: 'Run `qc-portal --update` in the install folder to upgrade.',
          duration: 8000,
        })
      } else {
        toast.success(`You're on the latest version (v${r.current}).`)
      }
    },
    onError: (e) => toast.error('Update check failed', { description: String(e) }),
  })

  const updateAvailable = check.data?.updateAvailable && !check.data.error

  if (collapsed) {
    return (
      <div className="mt-auto flex flex-col items-center gap-1.5 border-t border-sidebar-border/60 px-2 py-4">
        <Tooltip>
          <TooltipTrigger asChild>
            <NavLink
              to="/releases"
              aria-label="Release notes"
              className={({ isActive }) =>
                cn(
                  'flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                  isActive && 'bg-muted text-foreground',
                )
              }
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
            <button
              type="button"
              onClick={() => check.mutate()}
              disabled={check.isPending}
              aria-label="Check for updates"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
            >
              {updateAvailable ? (
                <ArrowUpCircle className="h-4 w-4 text-amber-500" />
              ) : (
                <RefreshCw className={cn('h-4 w-4', check.isPending && 'animate-spin')} />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-medium">
            {updateAvailable ? `Update available: v${check.data?.latest}` : 'Check for updates'}
          </TooltipContent>
        </Tooltip>
      </div>
    )
  }

  return (
    <div className="mt-auto flex items-center gap-1.5 border-t border-sidebar-border/60 px-4 py-4 text-xs text-muted-foreground/70">
      <NavLink
        to="/releases"
        className={({ isActive }) =>
          cn(
            'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium transition-colors hover:bg-muted hover:text-foreground',
            isActive && 'bg-muted text-foreground',
          )
        }
      >
        <ScrollText className="size-3.5 shrink-0" />
        Release notes
      </NavLink>
      <span
        className={cn(
          'ml-auto shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[10px] tracking-tight',
          updateAvailable ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-muted',
        )}
        title={updateAvailable ? `Update available: v${check.data?.latest}` : `Version ${version}`}
      >
        v{version}
      </span>
      <button
        type="button"
        onClick={() => check.mutate()}
        disabled={check.isPending}
        title={updateAvailable ? 'Update available — click to re-check' : 'Check for updates'}
        aria-label="Check for updates"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
      >
        {updateAvailable ? (
          <ArrowUpCircle className="h-3.5 w-3.5 text-amber-500" />
        ) : (
          <RefreshCw className={cn('h-3.5 w-3.5', check.isPending && 'animate-spin')} />
        )}
      </button>
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

function App() {
  const { activeProjectId } = useProjects()
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
      <NotificationBell />
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-[width] duration-200 ease-out lg:flex',
          collapsed ? 'w-[72px]' : 'w-60',
        )}
      >
        {/* Brand + collapse toggle */}
        {collapsed ? (
          <div className="flex flex-col items-center gap-2 px-3 py-5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-black/5">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-6 py-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-black/5">
              <ShieldCheck className="h-5 w-5" />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-base font-semibold tracking-tight">QC Portal</div>
              <div className="truncate text-xs text-muted-foreground">Acceptance testing</div>
            </div>
            <div className="ml-auto">
              <SidebarToggle collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
            </div>
          </div>
        )}

        <ProjectSwitcher collapsed={collapsed} onExpand={() => setCollapsed(false)} />

        <nav className={cn('flex flex-col gap-5 py-3', collapsed ? 'items-center px-2' : 'px-3')}>
          {navGroups.map((group, gi) => (
            <div
              key={group.label}
              className={cn('flex flex-col gap-0.5', collapsed && 'items-center')}
            >
              {collapsed
                ? gi > 0 && <span className="mb-1 h-px w-6 rounded-full bg-sidebar-border/70" />
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
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8">
          <Routes>
            <Route path="/" element={<RunPage />} />
            <Route path="/overview" element={<OverviewPage />} />
            <Route path="/running" element={<RunningPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/run/:id" element={<RunDetailPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/testcases" element={<TestCasePage />} />
            <Route path="/verify" element={<VerifyDesignPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/releases" element={<ReleaseNotesPage />} />
            <Route path="/instructions" element={<InstructionsPage />} />
            <Route path="/templates" element={<ProjectSettingsPage />} />
            <Route path="/settings" element={<ProjectsPage />} />
            <Route path="/projects" element={<Navigate to="/settings" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}

export default App
