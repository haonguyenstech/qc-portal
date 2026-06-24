import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen,
  ClipboardList,
  FolderGit2,
  History,
  PlayCircle,
  Plug,
  RadioTower,
  ScanSearch,
  Settings,
  ShieldCheck,
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
import { listRuns } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import NotificationBell from '@/components/NotificationBell'
import TestCaseJobWatcher from '@/components/TestCaseJobWatcher'
import CrawlJobWatcher from '@/components/CrawlJobWatcher'
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
import OverviewPage from '@/pages/OverviewPage'
import VerifyDesignPage from '@/pages/VerifyDesignPage'
import NotificationsPage from '@/pages/NotificationsPage'

const navGroups = [
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
      { to: '/skills', label: 'Skills', icon: Wrench, end: false },
      { to: '/mcp', label: 'MCP', icon: Plug, end: false },
      { to: '/templates', label: 'Settings', icon: Settings, end: false },
    ],
  },
]

function ProjectSwitcher() {
  const { projects, activeProjectId, setActiveProjectId, isLoading } = useProjects()

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

function App() {
  const { activeProjectId } = useProjects()
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
      <NotificationBell />
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl lg:flex">
        <div className="flex items-center gap-2.5 px-6 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-black/5">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="leading-tight">
            <div className="text-base font-semibold tracking-tight">QC Portal</div>
            <div className="text-xs text-muted-foreground">Acceptance testing</div>
          </div>
        </div>
        <ProjectSwitcher />
        <nav className="flex flex-col gap-5 px-3 py-3">
          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col gap-0.5">
              <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/55">
                {group.label}
              </div>
              {group.items.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 active:scale-[0.98]',
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
                      {label}
                      {to === '/running' && liveCount > 0 && (
                        <span
                          className={cn(
                            'ml-auto inline-flex min-w-5 items-center justify-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                            isActive
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-sky-500 text-white',
                          )}
                          title={`${liveCount} test${liveCount === 1 ? '' : 's'} running`}
                        >
                          <span className="relative flex size-1.5">
                            <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
                            <span className="relative inline-flex size-1.5 rounded-full bg-current" />
                          </span>
                          {liveCount}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="mt-auto flex items-center gap-2 border-t border-sidebar-border/60 px-6 py-4 text-xs text-muted-foreground/70">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden />
          QC Portal
          <span className="ml-auto rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tracking-tight">
            v0.1
          </span>
        </div>
      </aside>

      <main className="lg:pl-60">
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
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
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
