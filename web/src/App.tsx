import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  ArrowUpCircle,
  CheckCircle2,
  BookText,
  Check,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderGit2,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Upload,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { RouteGuideTour } from '@/components/RouteGuideTour'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { checkForUpdate, getUpdateLog, getVersion, triggerUpdate } from '@/lib/api'
import { listRuns } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import type { Project } from '@/lib/types'
import {
  useFoldedNavGroups,
  useHiddenNav,
  visibleNavGroups,
  type NavGroupDef,
  type NavItemDef,
} from '@/lib/nav'
import NotificationBell from '@/components/NotificationBell'
import ThemeToggle from '@/components/ThemeToggle'
import { AutoAgentStatusIndicator } from '@/components/AutoAgentStatus'
import TestCaseJobWatcher from '@/components/TestCaseJobWatcher'
import CrawlJobWatcher from '@/components/CrawlJobWatcher'
import VerifyJobWatcher from '@/components/VerifyJobWatcher'
import SourceJobWatcher from '@/components/SourceJobWatcher'
import DatabaseJobWatcher from '@/components/DatabaseJobWatcher'
import PerfJobWatcher from '@/components/PerfJobWatcher'
import RunPage from '@/pages/RunPage'
import RunningPage from '@/pages/RunningPage'
import HistoryPage from '@/pages/HistoryPage'
import ReportsPage from '@/pages/ReportsPage'
import RunDetailPage from '@/pages/RunDetailPage'
import SkillsPage from '@/pages/SkillsPage'
import TicketsPage from '@/pages/TicketsPage'
import TestCasePage from '@/pages/TestCasePage'
import ApiTestingPage from '@/pages/ApiTestingPage'
import PerformancePage from '@/pages/PerformancePage'
import ResponsivePage from '@/pages/ResponsivePage'
import PrototypePage from '@/pages/PrototypePage'
import ChatPage from '@/pages/ChatPage'
import AiLabsPage from '@/pages/AiLabsPage'
import AiLabDetailPage from '@/pages/AiLabDetailPage'
import McpPage from '@/pages/McpPage'
import ProjectsPage from '@/pages/ProjectsPage'
import ProjectSettingsPage from '@/pages/ProjectSettingsPage'
import InstructionsPage from '@/pages/InstructionsPage'
import OverviewPage from '@/pages/OverviewPage'
import SourceCodePage from '@/pages/SourceCodePage'
import DatabasePage from '@/pages/DatabasePage'
import DiagramsPage from '@/pages/DiagramsPage'
import VerifyDesignPage from '@/pages/VerifyDesignPage'
import MailBoxPage from '@/pages/MailBoxPage'
import TerminalPage from '@/pages/TerminalPage'
import NotificationsPage from '@/pages/NotificationsPage'
import NotesPage from '@/pages/NotesPage'
import ReleaseNotesPage from '@/pages/ReleaseNotesPage'
import RemoteAccessPage from '@/pages/RemoteAccessPage'
import DocumentPage from '@/pages/DocumentPage'

/**
 * The seal the mark is built from — a 10-lobe scalloped disc, the shape of a
 * certification stamp. Baked as literal coordinates rather than computed at render:
 * it never changes, and `web/public/favicon.svg` has to carry the identical numbers.
 * Regenerate both together (cx/cy 16, R 12.7, lobe depth 2.6, 10 lobes).
 */
const SEAL_PATH =
  'M16.00 3.30L19.12 6.39L23.46 5.73L24.17 10.06L28.08 12.08L26.10 16.00L28.08 19.92' +
  'L24.17 21.94L23.46 26.27L19.12 25.61L16.00 28.70L12.88 25.61L8.54 26.27L7.83 21.94' +
  'L3.92 19.92L5.90 16.00L3.92 12.08L7.83 10.06L8.54 5.73L12.88 6.39Z'

/** The check, cut OUT of the seal rather than drawn on top of it. */
const SEAL_CHECK = 'M10.4 16.4l3.9 3.9 7.5-8.6'

/**
 * The app mark: a quality seal with the check cut out of it — the sign-off this
 * portal exists to produce.
 *
 * It is a SOLID with negative space, not an outline. Earlier versions were
 * lucide-weight line drawings (a lens, a clipboard), and a line icon reads as one
 * item borrowed from an icon set rather than as a logo — the app's own design
 * language says as much ("icon badges are high-contrast solids, not gradient
 * chips"). A solid also survives downscaling: at 16px there are no hairlines to
 * dissolve, just a silhouette and one hole.
 *
 * The check is knocked out through a `<mask>`, so the mark is a single colour and
 * the cut shows whatever is behind it — the brand chip's gradient in the sidebar,
 * the browser chrome in a tab. The mask id comes from `useId` because two of these
 * can legitimately mount at once and duplicate ids would cross-wire the masks.
 *
 * Geometry is shared with `web/public/favicon.svg`. Change one, change the other.
 */
function AppLogo({ className }: { className?: string }) {
  const maskId = `qc-logo-${useId()}`
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <mask id={maskId}>
        <rect width="32" height="32" fill="#fff" />
        <path
          d={SEAL_CHECK}
          stroke="#000"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </mask>
      {/* The seal is stroked as well as filled, with a round linejoin — that is what
          rounds the scallops. A bare polygon gives hard points and reads as a star. */}
      <path
        d={SEAL_PATH}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="3.4"
        strokeLinejoin="round"
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}

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

/**
 * Does this row own the current URL? Nested paths count (`/run/42` lights up Run),
 * except for an `end` row. Shared by `NavItem` and `NavGroup` — a folded group has
 * to know whether the active page is inside it.
 */
function routeMatches(pathname: string, item: NavItemDef) {
  return item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`)
}

/** A single sidebar link. Collapsed → icon-only square with a right-side tooltip. */
function NavItem({
  item,
  collapsed,
  liveCount,
  caption,
}: {
  item: NavItemDef
  collapsed: boolean
  liveCount: number
  /** Group name, shown under the label when the flat filtered list is rendered. */
  caption?: string
}) {
  const { to, label, icon: Icon, end } = item
  const showRunning = to === '/running' && liveCount > 0
  const { pathname } = useLocation()
  // Compute active state ourselves rather than via NavLink's className/children
  // render-props: when collapsed the link is wrapped in <TooltipTrigger asChild>,
  // whose Radix Slot stringifies a function className. A plain string is Slot-safe.
  const isActive = routeMatches(pathname, item)

  // Scroll the active row into view when the nav is taller than the pane — landing
  // on a route from a page link or a reload shouldn't leave its row off screen.
  // Keyed on `isActive` so it fires on activation only, not on every re-render
  // (the nav re-renders on each keystroke in the filter).
  const linkRef = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (isActive) linkRef.current?.scrollIntoView({ block: 'nearest' })
  }, [isActive])

  const link = (
    <NavLink
      to={to}
      end={end}
      ref={linkRef}
      className={cn(
        'group relative flex items-center text-sm font-medium transition-all duration-200 active:scale-[0.98]',
        // Expanded rows are deliberately SHORT (h-8): with 23 pages a 40px row put
        // half the rail below the fold on a 13" laptop. The collapsed rail keeps its
        // 40px squares — they are the touch target there, not a label.
        collapsed ? 'h-10 w-10 justify-center rounded-xl' : 'h-8 gap-2.5 rounded-lg px-2.5 text-[13px]',
        isActive
          ? collapsed
            ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/25'
            : 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground',
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
      {!collapsed &&
        (caption ? (
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate">{label}</span>
            <span className="block truncate text-[10px] font-normal text-muted-foreground/70">
              {caption}
            </span>
          </span>
        ) : (
          label
        ))}
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

/**
 * One group in the expanded rail: a foldable header plus its rows.
 *
 * Folding is the answer to "23 pages don't fit", so the header has to stay CHEAP —
 * 24px, no border, the same uppercase caption it always was, just clickable with a
 * chevron. Two details that matter:
 *  - a FOLDED group still renders the row that owns the current URL (dimmed context
 *    is better than the page you are on vanishing from the rail), and its header
 *    stays coloured so the fold reads as "the rest is hidden", not "you left";
 *  - the item count only shows while folded — expanded, the rows are the count.
 */
function NavGroup({
  group,
  folded,
  onToggle,
  liveCount,
}: {
  group: NavGroupDef
  folded: boolean
  onToggle: () => void
  liveCount: number
}) {
  const { pathname } = useLocation()
  const activeItem = group.items.find((i) => routeMatches(pathname, i))

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!folded}
        title={folded ? `Expand ${group.label}` : `Collapse ${group.label}`}
        className={cn(
          'flex h-6 w-full items-center gap-1 rounded-lg pl-1.5 pr-2 text-[10px] font-semibold uppercase tracking-wider transition-colors',
          'hover:bg-muted/60 hover:text-muted-foreground',
          folded && activeItem ? 'text-primary/70' : 'text-muted-foreground/55',
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 transition-transform duration-200',
            !folded && 'rotate-90',
          )}
        />
        <span className="truncate">{group.label}</span>
        {folded && (
          <span className="ml-auto text-[10px] font-medium tabular-nums text-muted-foreground/45">
            {group.items.length}
          </span>
        )}
      </button>
      {(folded ? (activeItem ? [activeItem] : []) : group.items).map((item) => (
        <NavItem key={item.to} item={item} collapsed={false} liveCount={liveCount} />
      ))}
    </div>
  )
}

/** True on a Mac, so shortcut hints read ⌘ rather than Ctrl. */
const IS_MAC =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl'

/** Small keycap used in tooltips and the filter's placeholder hint. */
function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-border/60 bg-muted px-1 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  )
}

/**
 * Fade masks for a scrollable pane. The sidebar's nav is taller than the viewport
 * on a laptop screen (18 links across 5 groups), and with a hard edge there is
 * nothing on screen saying more links exist below — so the fade only appears on
 * the side that actually has content past the edge.
 */
function useScrollFade<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [fade, setFade] = useState({ top: false, bottom: false })
  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const top = el.scrollTop > 4
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 4
    setFade((f) => (f.top === top && f.bottom === bottom ? f : { top, bottom }))
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [update])
  return { ref, fade, update }
}

/**
 * Type-to-filter over the nav. 18 links across 5 groups is more than a glance
 * resolves, and every one of them is a fixed destination — so the fastest path
 * to a page is naming it. Focused with {MOD}K from anywhere in the shell.
 */
function NavFilter({
  value,
  onChange,
  inputRef,
  onSubmit,
  allFolded,
  onToggleAll,
}: {
  value: string
  onChange: (v: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  onSubmit: () => void
  /** Every group is folded — the button then offers "expand", not "collapse". */
  allFolded: boolean
  onToggleAll: () => void
}) {
  return (
    <div className="mx-3 mb-2 flex shrink-0 items-center gap-1.5">
      <div className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            if (value) onChange('')
            else inputRef.current?.blur()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit()
          }
        }}
        placeholder="Search pages…"
        aria-label="Search pages"
        className="h-9 w-full rounded-full border border-sidebar-border/70 bg-muted/50 pl-8 pr-12 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:border-border focus:border-border focus:bg-muted"
      />
      {value ? (
        <button
          type="button"
          onClick={() => {
            onChange('')
            inputRef.current?.focus()
          }}
          aria-label="Clear search"
          className="absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          <Kbd>{MOD_KEY}K</Kbd>
        </span>
      )}
      </div>
      {/* Fold/unfold every group. It rides on the search row on purpose: a row of
          its own would cost the vertical space the folding is meant to win back. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onToggleAll}
            aria-label={allFolded ? 'Expand all groups' : 'Collapse all groups'}
            className="flex size-9 shrink-0 items-center justify-center rounded-full border border-sidebar-border/70 bg-muted/50 text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
          >
            {allFolded ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="font-medium">
          {allFolded ? 'Expand all groups' : 'Collapse all groups'}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function ProjectSwitcher({
  collapsed,
  onExpand,
  onMenuOpenChange,
}: {
  collapsed: boolean
  onExpand: () => void
  /** So the rail's hover-peek can refuse to close under an open picker. */
  onMenuOpenChange?: (open: boolean) => void
}) {
  const { projects, activeProjectId, setActiveProjectId, isLoading } = useProjects()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const activeProject = projects.find((p) => p.id === activeProjectId)

  /* Every open/close goes through here — picking, adding and managing all close
     the picker too, and the rail's hover-peek has to hear about ALL of them or it
     stays pinned open by a menu that is no longer there. */
  const setMenuOpen = (v: boolean) => {
    setOpen(v)
    onMenuOpenChange?.(v)
  }
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

  const pinned = projects.filter((p) => p.pinned)
  const rest = projects.filter((p) => !p.pinned)

  return (
    <div className="mx-3 mb-2 shrink-0 border-b border-sidebar-border/60 pb-3">
      <div className="mb-1.5 flex items-center gap-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        <FolderGit2 className="h-3 w-3" />
        Workspace
      </div>
      <ProjectPicker
        open={open}
        onOpenChange={setMenuOpen}
        pinned={pinned}
        rest={rest}
        activeProject={activeProject}
        isLoading={isLoading}
        onPick={(id) => {
          setActiveProjectId(id)
          setMenuOpen(false)
        }}
        onAdd={() => {
          setMenuOpen(false)
          navigate('/settings?tab=projects&add=1')
        }}
        onManage={() => {
          setMenuOpen(false)
          navigate('/settings?tab=projects')
        }}
      />
    </div>
  )
}

/**
 * A path short enough for a 320px panel: the last two segments, ellipsised in
 * FRONT. `truncate` cuts the tail, which is exactly backwards for a path — every
 * repo here starts `/Users/<me>/…`, and the part that says WHICH repo is the end.
 * The full path stays in the `title`.
 */
function shortPath(full?: string) {
  if (!full) return ''
  const parts = full.split(/[\\/]+/).filter(Boolean)
  if (parts.length <= 2) return full
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * The project picker: the trigger in the rail plus the panel it opens.
 *
 * It is a **Popover, not a `Select`**, and that is the whole point — this list is
 * 10+ repos on a real machine, and a `Select` cannot hold a text input (Radix
 * routes every keystroke to its own typeahead, so a filter box inside one eats
 * itself). With a popover the panel gets: a filter matching NAME **and PATH**
 * (two repos called `web` are told apart only by where they live), the folder path
 * under every name, pinned projects first, and the state that decides whether a QC
 * run will even work — `missing` when the folder is gone, `setup` when the skill /
 * `.mcp.json` / `CLAUDE.md` trio is incomplete. Picking a dead project and finding
 * out from a failed run is the failure this replaces.
 *
 * Keyboard is hand-rolled for the same reason: ↑/↓ move a cursor over the FILTERED
 * list, Enter picks it, Escape closes (Radix). The cursor is an index into that
 * flattened list, so it must be re-clamped whenever the filter changes or it points
 * past the end.
 */
function ProjectPicker({
  open,
  onOpenChange,
  pinned,
  rest,
  activeProject,
  isLoading,
  onPick,
  onAdd,
  onManage,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  pinned: Project[]
  rest: Project[]
  activeProject?: Project
  isLoading: boolean
  onPick: (id: string) => void
  onAdd: () => void
  onManage: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const total = pinned.length + rest.length

  const q = query.trim().toLowerCase()
  const match = (p: Project) =>
    !q || p.name.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q)
  const sections = [
    { label: 'Pinned', items: pinned.filter(match) },
    { label: pinned.length > 0 ? 'All projects' : '', items: rest.filter(match) },
  ].filter((s) => s.items.length > 0)
  // Flat order = what ↑/↓ walk, so it has to be built from the SAME sections that
  // are rendered, not from `projects` (whose order the pinned split changes).
  const flat = sections.flatMap((s) => s.items)

  // The cursor is CLAMPED on read, not corrected in an effect: the list shrinks as
  // you type, and a stored index would spend a render pointing past the end (and
  // trip the no-setState-in-effect rule getting fixed up).
  const at = flat.length === 0 ? 0 : Math.min(cursor, flat.length - 1)

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [at, open])

  /** A fresh open starts clean, on the project you are already in. */
  function handleOpenChange(v: boolean) {
    if (v) {
      setQuery('')
      const i = [...pinned, ...rest].findIndex((p) => p.id === activeProject?.id)
      setCursor(i < 0 ? 0 : i)
    }
    onOpenChange(v)
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (flat.length === 0) return
      setCursor((at + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const p = flat[at]
      if (p) onPick(p.id)
    }
  }

  const initial = (name?: string) => (name ?? '?').trim().charAt(0).toUpperCase() || '?'
  let i = -1

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={isLoading}
          aria-label="Switch project"
          className="flex w-full items-center gap-2 rounded-xl border border-sidebar-border/70 bg-muted/50 py-2 pl-2 pr-2 text-left transition-all duration-200 hover:border-border hover:bg-muted data-[state=open]:border-border data-[state=open]:bg-muted"
        >
          <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground text-xs font-semibold text-background">
            {initial(activeProject?.name)}
            {activeProject?.exists === false && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-sidebar bg-destructive" />
            )}
          </span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium text-foreground">
              {activeProject?.name ?? (isLoading ? 'Loading…' : 'Select project')}
            </span>
            {/* The PATH, not "10 projects" — the count is on the panel's own header,
                and which folder a run will spawn in is the thing worth showing. */}
            <span
              className="block truncate font-mono text-[10px] text-muted-foreground/70"
              title={activeProject?.rootPath}
            >
              {activeProject ? shortPath(activeProject.rootPath) : isLoading ? 'Loading projects…' : 'None selected'}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground/70" />
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border-border/60 p-0 shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground/70" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              // Re-aim at the FIRST match: leaving the cursor mid-list means Enter
              // picks whatever sits under it, not what you searched for.
              setCursor(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Filter by name or path…"
            aria-label="Filter projects"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
            {q ? `${flat.length}/${total}` : total}
          </span>
        </div>

        <div ref={listRef} className="max-h-[19rem] overflow-y-auto p-1.5">
          {total === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No projects yet. Add the first repo folder to start.
            </p>
          ) : flat.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              No project matches “{query.trim()}”.
            </p>
          ) : (
            sections.map((section) => (
              <div key={section.label || 'all'} className="mb-1 last:mb-0">
                {section.label && (
                  <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                    {section.label}
                  </div>
                )}
                {section.items.map((p) => {
                  i += 1
                  const idx = i
                  const isActive = p.id === activeProject?.id
                  const missing = p.exists === false
                  const needsSetup =
                    !missing && !(p.hasSkills && p.hasMcp && p.hasClaudeMd)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-index={idx}
                      onClick={() => onPick(p.id)}
                      onMouseMove={() => setCursor(idx)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors',
                        idx === at ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span
                        className={cn(
                          'flex size-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold',
                          isActive
                            ? 'bg-foreground text-background'
                            : 'bg-muted text-foreground',
                        )}
                      >
                        {initial(p.name)}
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-foreground">
                            {p.name}
                          </span>
                          {missing && (
                            <span className="shrink-0 rounded-md bg-destructive/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-destructive">
                              missing
                            </span>
                          )}
                          {needsSetup && (
                            <span className="shrink-0 rounded-md bg-amber-500/10 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                              setup
                            </span>
                          )}
                        </span>
                        <span
                          className="block truncate font-mono text-[10px] text-muted-foreground/70"
                          title={p.rootPath}
                        >
                          {shortPath(p.rootPath)}
                        </span>
                      </span>
                      {isActive && <Check className="size-3.5 shrink-0 text-primary" />}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-1 border-t border-border/60 p-1.5">
          <button
            type="button"
            onClick={onAdd}
            className="flex flex-1 items-center gap-2 rounded-xl px-2 py-1.5 text-[13px] font-medium text-primary outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg border border-dashed border-primary/40">
              <Plus className="size-3.5" />
            </span>
            Add project
          </button>
          <button
            type="button"
            onClick={onManage}
            className="flex shrink-0 items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
          >
            <Settings className="size-3.5" />
            Manage
          </button>
        </div>
      </PopoverContent>
    </Popover>
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
  // The budget covers the launcher's own worst case (git 3min + npm install 15min +
  // build 15min) plus the restart, so the browser stops waiting only once the
  // launcher itself has certainly given up — and the launcher, on giving up, puts
  // the old server back, which is what this loop then sees.
  const upDeadline = Date.now() + 35 * 60_000
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

  // Whether an update is in flight, as OUR state rather than a derivation of the
  // mutation. `update.isSuccess && update.data.ok` never becomes false again — the
  // mutation succeeded the moment the server accepted the request — so the button
  // stayed disabled and spinning for the life of the page even after the update had
  // failed and said so. There was then no way to retry except a reload, which is
  // precisely the "stuck updating forever" this whole path keeps producing.
  const [updating, setUpdating] = useState(false)

  /** The last lines the launcher wrote, for a failure message worth reading. */
  async function updateFailureDetail(fallback: string): Promise<string> {
    try {
      const log = await getUpdateLog()
      if (log.status?.ok === false && log.status.error) return log.status.error
      const lastError = [...log.lines].reverse().find((l) => /fail|error|not finish/i.test(l))
      return lastError ?? fallback
    } catch {
      return fallback
    }
  }

  const update = useMutation({
    mutationFn: triggerUpdate,
    onMutate: () => setUpdating(true),
    onSuccess: async (r) => {
      if (!r.ok) {
        toast.error('Update failed to start', { description: r.error })
        setUpdating(false)
        return
      }
      // A silent spinner is indistinguishable from a hang, and this step legitimately
      // takes minutes. Count up, and say that the portal returns either way.
      const started = Date.now()
      const describe = () => {
        const secs = Math.round((Date.now() - started) / 1000)
        const elapsed = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`
        return `Pulling, rebuilding and restarting — ${elapsed} elapsed. The portal comes back either way.`
      }
      const show = () =>
        toast.loading('Updating QC Portal…', {
          id: 'qc-update',
          description: describe(),
          duration: Infinity,
        })
      show()
      const ticker = window.setInterval(show, 5000)

      try {
        // Gate the reload on the server coming back as a RESTARTED process (new
        // version, or a witnessed down→up), so we never reload mid-restart.
        const back = await waitForRestart(r.current ?? version)
        if (!back) {
          toast.error('Update timed out', {
            id: 'qc-update',
            description: await updateFailureDetail(
              'The server did not come back. Open a terminal in the install folder and run `qc-portal --restart`.',
            ),
            duration: Infinity,
          })
          return
        }
        // The server is back — but "back" is not "updated". The version endpoint
        // reads package.json from disk, which `git reset` has already moved by the
        // time a later step can fail, so a failed build still looks like a bump.
        // The launcher's own verdict is the only thing that knows.
        const log = await getUpdateLog().catch(() => null)
        if (log?.status?.ok === false) {
          toast.error('Update did not complete — still on the previous version', {
            id: 'qc-update',
            description: log.status.error ?? 'The launcher reported a failure.',
            duration: Infinity,
          })
          return
        }
        toast.success('Update complete — reloading…', { id: 'qc-update', duration: 2000 })
        await sleep(600)
        window.location.reload()
      } finally {
        window.clearInterval(ticker)
        setUpdating(false)
      }
    },
    onError: (e) => {
      setUpdating(false)
      toast.error('Update failed to start', { description: String(e) })
    },
  })

  const checkData = updateCheck.data
  const updateAvailable = !!checkData?.updateAvailable && !checkData.error
  const latest = checkData?.latest
  const checking = manualChecking || updateCheck.isFetching
  const checkedAgo = timeAgoShort(checkData?.checkedAt)
  const { pathname } = useLocation()

  if (collapsed) {
    // Plain string className (not a render-prop) so the Radix Slot from
    // <TooltipTrigger asChild> doesn't stringify a className function.
    const releasesActive = pathname === '/releases'
    return (
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1.5 border-t border-sidebar-border/60 px-2 py-4">
        {/* Auto Agent credential status — above Release notes, as in the expanded footer. */}
        <AutoAgentStatusIndicator collapsed />
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
    /*
     * ONE card, in three tiers: what you are running, whether it is healthy, and
     * where to read about it.
     *
     * The two shapes this replaced both failed for the same reason — they were a
     * PILE. First three bordered cards (~150px, louder than the nav above them),
     * then three loose rows, which fixed the height but left the version's mono
     * text, a tiny green word and an icon button floating with nothing holding
     * them together. Grouping is what makes it read as designed: a hairline box
     * on a tinted surface, a version header, two status lines that state the same
     * KIND of thing in the same way, and the two links split evenly at the bottom
     * where a footer's links belong.
     */
    <div className="mt-auto shrink-0 border-t border-sidebar-border/60 px-2.5 py-2.5">
      <div
        className={cn(
          'overflow-hidden rounded-2xl border transition-colors',
          updateAvailable
            ? 'border-amber-500/40 bg-amber-500/5'
            : 'border-sidebar-border/60 bg-muted/40',
        )}
      >
        {/* Tier 1 — the version, and the only control that changes it. */}
        <div className="flex h-8 items-center gap-2 px-2">
          <AppLogo className="size-3.5 shrink-0 text-muted-foreground/70" />
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground">
            v{version}
          </span>
          <button
            type="button"
            onClick={() => runCheck()}
            disabled={checking || updating}
            title={checkedAgo ? `Last checked ${checkedAgo} — click to re-check` : 'Check for updates'}
            aria-label="Check for updates"
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95 disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} />
          </button>
        </div>

        {/* Tier 2 — health. Both lines are the same statement in the same shape:
            an icon, one sentence, the colour carrying the verdict. */}
        <div className="flex flex-col gap-px px-1 pb-1">
          <AutoAgentStatusIndicator collapsed={false} />
          <div className="flex h-6 items-center gap-1.5 px-1.5">
            {checking ? (
              <>
                <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground">
                  Checking for updates…
                </span>
              </>
            ) : updateAvailable ? (
              <>
                <ArrowUpCircle className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-amber-600 dark:text-amber-400">
                  v{latest} available
                </span>
              </>
            ) : checkData ? (
              <>
                <CheckCircle2 className="size-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                <span className="text-[11px] font-medium text-muted-foreground">Up to date</span>
              </>
            ) : (
              <>
                <RefreshCw className="size-3 shrink-0 text-muted-foreground/60" />
                <span className="text-[11px] font-medium text-muted-foreground/60">
                  Not checked yet
                </span>
              </>
            )}
          </div>
        </div>

        {/* The one action in this card, and it exists only when there is something
            to do. Labelled, because an icon-only version of it reinstalls the app. */}
        {updateAvailable && (
          <div className="px-1 pb-1">
            <button
              type="button"
              onClick={() => update.mutate()}
              disabled={updating}
              className="flex h-7 w-full items-center justify-center gap-1.5 rounded-xl bg-amber-500/20 text-[12px] font-medium text-amber-700 transition-all duration-200 hover:bg-amber-500/30 active:scale-[0.98] disabled:opacity-60 dark:text-amber-300"
            >
              {updating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Updating…
                </>
              ) : (
                <>
                  <ArrowUpCircle className="h-3.5 w-3.5" />
                  Update now
                </>
              )}
            </button>
          </div>
        )}

        {/* Tier 3 — the two reading pages, split evenly on their own hairline. */}
        <div className="grid grid-cols-2 border-t border-sidebar-border/60 divide-x divide-sidebar-border/60">
          <NavLink
            to="/document"
            className={({ isActive }) =>
              cn(
                'flex h-8 items-center justify-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                isActive && 'bg-muted text-foreground',
              )
            }
          >
            <BookText className="size-3.5 shrink-0" />
            Docs
          </NavLink>
          <NavLink
            to="/releases"
            className={({ isActive }) =>
              cn(
                'flex h-8 items-center justify-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                isActive && 'bg-muted text-foreground',
              )
            }
          >
            <ScrollText className="size-3.5 shrink-0" />
            Releases
          </NavLink>
        </div>
      </div>
    </div>
  )
}

/**
 * Collapse/expand toggle. While PEEKING the rail is already open, so the button
 * offers to keep it that way — "Keep expanded", not "Expand sidebar", which would
 * read as a no-op on a rail that is visibly open.
 */
function SidebarToggle({
  collapsed,
  peeking,
  onToggle,
}: {
  collapsed: boolean
  peeking: boolean
  onToggle: () => void
}) {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose
  const label = peeking ? 'Keep expanded' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  const button = (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95"
    >
      <Icon className="size-4" />
    </button>
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-1.5 font-medium">
        {label}
        <Kbd>{MOD_KEY}B</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

/** Collapsed-sidebar stand-in for the filter: expands the rail and focuses it. */
function CollapsedSearchButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label="Search pages"
          className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-sidebar-border/70 bg-muted/50 text-muted-foreground transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:text-foreground active:scale-95"
        >
          <Search className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" className="flex items-center gap-1.5 font-medium">
        Search pages
        <Kbd>{MOD_KEY}K</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

// Routes that work without a project — the user must still reach Settings to
// create one, and the docs / release notes are project-agnostic reference.
// `/remote` belongs here too: publishing the portal is a property of the MACHINE,
// not of any project, and it is exactly what someone setting the portal up on a
// fresh install wants before registering anything.
const PROJECT_AGNOSTIC_PREFIXES = ['/settings', '/projects', '/releases', '/document', '/remote']
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

/**
 * The portal shell — sidebar, bell, page padding, and every page that lives inside it.
 * Split out from `App` so a route can opt OUT of the chrome entirely (see below).
 */
function AppShell() {
  const { activeProjectId, projects, isLoading: projectsLoading } = useProjects()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  /*
   * HOVER PEEK. A collapsed rail trades every label for width, and the usual fix
   * — click to expand, click to collapse again — makes you pay for a label with
   * two clicks and a reflow of the page you were reading. So: hovering the
   * collapsed rail opens it as an OVERLAY. `<aside>` is `fixed` and `<main>`'s
   * padding follows `collapsed` alone, so the peek floats over the content and
   * nothing on the page moves. The toggle then means "keep it open" (pin), and
   * ⌘/Ctrl+B still does both.
   *
   * Both edges are delayed: ~120ms in, so a pointer crossing the rail on its way
   * somewhere else doesn't flash it open, and ~180ms out, so clipping a corner
   * of the panel on the way to a row doesn't snap it shut.
   */
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<number | null>(null)
  // A REF, not state: it is read inside the close path, which is called from the
  // very handler that changes it. As state it read stale — Escape closing the
  // picker left the rail peeked open for ever, because the handler's `menuOpen`
  // was still `true` at the moment it asked.
  const menuOpenRef = useRef(false)
  const showExpanded = !collapsed || peek

  const clearPeekTimer = () => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    peekTimer.current = null
  }
  const openPeek = () => {
    if (!collapsed) return
    clearPeekTimer()
    peekTimer.current = window.setTimeout(() => setPeek(true), 120)
  }
  const closePeek = () => {
    clearPeekTimer()
    // A portalled menu (the project picker) lives OUTSIDE the aside, so moving
    // into it fires mouseleave. Closing the rail from under an open menu would
    // yank its trigger away mid-click.
    if (menuOpenRef.current) return
    peekTimer.current = window.setTimeout(() => setPeek(false), 180)
  }
  /**
   * The picker opened or closed. A close ALWAYS schedules the retreat — asking
   * "is the pointer still over the rail?" needs coordinates we don't have, and a
   * `hovering` flag went stale exactly when it mattered (leaving the rail for the
   * portalled panel, then closing it from out there, left the rail stuck open).
   * Scheduling instead is self-healing: if the pointer really is over the rail,
   * the browser re-dispatches `mouseenter` the moment the panel unmounts and the
   * rail is the topmost element again, and that cancels the pending close.
   */
  const onMenuOpenChange = (v: boolean) => {
    menuOpenRef.current = v
    if (!v) closePeek()
  }
  useEffect(() => clearPeekTimer, [])

  const [query, setQuery] = useState('')
  // Rows the engineer switched off in Settings -> Sidebar. Every route stays
  // mounted; this only decides what the rail draws (and what the filter finds).
  const { hidden } = useHiddenNav()
  const groups = useMemo(() => visibleNavGroups(hidden), [hidden])
  // Which groups are folded shut. Only meaningful in the expanded rail — the
  // icon-only rail has no headers to fold.
  const { folded, toggleGroup, foldAll, unfoldAll } = useFoldedNavGroups()
  const allFolded = groups.length > 0 && groups.every((g) => folded.includes(g.label))
  const filterRef = useRef<HTMLInputElement>(null)
  const { ref: navRef, fade, update: updateFade } = useScrollFade<HTMLElement>()
  const { data: runs } = useQuery({
    queryKey: ['runs', activeProjectId],
    queryFn: () => listRuns(activeProjectId!),
    enabled: !!activeProjectId,
    refetchInterval: 5000, // keep the live count fresh from any page
  })
  const liveCount = (runs ?? []).filter(
    (r) => r.status === 'running' || r.status === 'queued',
  ).length

  // Flat match list for the filter. Matching on the group name too means "testing"
  // finds the whole Testing group, which is how people actually remember a page.
  const q = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!q) return []
    return groups.flatMap((g) =>
      g.items
        .filter((i) => i.label.toLowerCase().includes(q) || g.label.toLowerCase().includes(q))
        .map((i) => ({ item: i, group: g.label })),
    )
  }, [q, groups])

  /** Focus the filter, expanding the rail first when it's collapsed. */
  const focusFilter = useCallback(() => {
    setCollapsed(false)
    // The input only exists in the expanded rail, so wait a frame after expanding.
    requestAnimationFrame(() => filterRef.current?.focus())
  }, [setCollapsed])

  // Shell-wide shortcuts: {MOD}K jumps to the page filter, {MOD}B collapses the rail.
  // Skipped while typing in a field so they can't hijack a page's own input.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      if (key !== 'k' && key !== 'b') return
      const el = e.target as HTMLElement | null
      const typing =
        !!el &&
        (el.tagName === 'INPUT' ||
          el.tagName === 'TEXTAREA' ||
          el.tagName === 'SELECT' ||
          el.isContentEditable)
      if (typing && el !== filterRef.current) return
      e.preventDefault()
      if (key === 'k') focusFilter()
      else setCollapsed((c) => !c)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusFilter, setCollapsed])

  // The nav's content height changes with the filter, so re-measure the fades.
  useEffect(() => {
    updateFade()
  }, [q, showExpanded, folded, updateFade])

  return (
    <div className="min-h-svh text-foreground">
      <NotificationBell />
      <ThemeToggle />
      <aside
        onMouseEnter={openPeek}
        onMouseLeave={closePeek}
        className={cn(
          'fixed inset-y-0 left-0 z-20 hidden flex-col border-r border-sidebar-border bg-sidebar/80 backdrop-blur-xl transition-[width,box-shadow] duration-200 ease-out lg:flex',
          showExpanded ? 'w-60' : 'w-[72px]',
          // Peeking floats over the page, so it needs an edge the docked rail
          // doesn't: a real shadow and an opaque ground (the content scrolling
          // underneath would otherwise show through the blur).
          peek && 'bg-sidebar shadow-2xl',
        )}
      >
        {/* Brand + collapse toggle */}
        {!showExpanded ? (
          <div className="flex shrink-0 flex-col items-center gap-2 px-3 py-5">
            <NavLink to="/overview" aria-label="QC Portal home — project overview" className="group">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/75 text-primary-foreground shadow-sm ring-1 ring-inset ring-white/15 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:shadow-md group-active:scale-95">
                <AppLogo className="h-6 w-6" />
              </span>
            </NavLink>
            <SidebarToggle collapsed peeking={false} onToggle={() => setCollapsed(false)} />
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-2.5 py-5 pl-4 pr-2">
            <NavLink
              to="/overview"
              end
              aria-label="QC Portal home — project overview"
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
              <SidebarToggle
                collapsed={collapsed}
                peeking={peek}
                onToggle={() => {
                  setPeek(false)
                  setCollapsed((c) => !c)
                }}
              />
            </div>
          </div>
        )}

        <ProjectSwitcher
          collapsed={!showExpanded}
          onExpand={() => setCollapsed(false)}
          onMenuOpenChange={onMenuOpenChange}
        />

        {!showExpanded ? (
          <div className="mb-1 flex shrink-0 justify-center px-2">
            <CollapsedSearchButton onClick={focusFilter} />
          </div>
        ) : (
          <NavFilter
            value={query}
            onChange={setQuery}
            inputRef={filterRef}
            allFolded={allFolded}
            onToggleAll={() => (allFolded ? unfoldAll() : foldAll(groups.map((g) => g.label)))}
            onSubmit={() => {
              const first = matches[0]
              if (!first) return
              navigate(first.item.to)
              setQuery('')
              filterRef.current?.blur()
            }}
          />
        )}

        {/* The fades are siblings of the scroll pane, not children — inside it they
            would scroll away with the content instead of pinning to the edges. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <nav
            ref={navRef}
            className={cn(
              'flex min-h-0 flex-1 flex-col overflow-y-auto py-3',
              showExpanded ? 'gap-1.5 px-2.5' : 'items-center gap-3 px-2',
            )}
          >
            {q ? (
              matches.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No page matches “{query.trim()}”.
                </p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {matches.map(({ item, group }) => (
                    <NavItem
                      key={item.to}
                      item={item}
                      collapsed={false}
                      liveCount={liveCount}
                      caption={group}
                    />
                  ))}
                </div>
              )
            ) : (
              groups.map((group, gi) =>
                !showExpanded ? (
                  // Icon-only rail: no header to click, so groups are separated by a
                  // hairline instead of being foldable.
                  <div key={group.label} className="flex flex-col items-center gap-1.5">
                    {gi > 0 && <span className="mb-1.5 h-px w-6 rounded-full bg-sidebar-border/70" />}
                    {group.items.map((item) => (
                      <NavItem key={item.to} item={item} collapsed liveCount={liveCount} />
                    ))}
                  </div>
                ) : (
                  <NavGroup
                    key={group.label}
                    group={group}
                    folded={folded.includes(group.label)}
                    onToggle={() => toggleGroup(group.label)}
                    liveCount={liveCount}
                  />
                ),
              )
            )}
          </nav>
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-sidebar to-transparent transition-opacity duration-200',
              fade.top ? 'opacity-100' : 'opacity-0',
            )}
          />
          <span
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-sidebar to-transparent transition-opacity duration-200',
              fade.bottom ? 'opacity-100' : 'opacity-0',
            )}
          />
        </div>

        <VersionFooter collapsed={!showExpanded} />
      </aside>

      <main
        className={cn(
          'transition-[padding] duration-200 ease-out',
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-60',
        )}
      >
        <div
          className={cn(
            'mx-auto',
            // The Prototype workspace (chat + live preview), Chat (history rail +
            // transcript), API Testing (collection rail + request builder + result
            // panel) and Responsive (a ROW of device frames at their true viewport
            // widths — one tablet is already 1024px, so a 1152px cap fits barely
            // one and a half of them) need the full width; every other page stays
            // comfortably capped.
            pathname === '/prototype' ||
            pathname === '/chat' ||
            pathname === '/notes' ||
            pathname === '/api-testing' ||
            pathname === '/responsive'
              ? 'max-w-none'
              : 'max-w-6xl',
            // Chat is full-bleed: its shell has no outer border, so page padding would
            // just leave a gap around the rail and the transcript.
            pathname === '/chat' ? '' : 'px-4 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-8',
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
            <Route path="/database" element={<DatabasePage />} />
            <Route path="/diagrams" element={<DiagramsPage />} />
            <Route path="/running" element={<RunningPage />} />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/run/:id" element={<RunDetailPage />} />
            <Route path="/tickets" element={<TicketsPage />} />
            <Route path="/testcases" element={<TestCasePage />} />
            <Route path="/verify" element={<VerifyDesignPage />} />
            <Route path="/api-testing" element={<ApiTestingPage />} />
            <Route path="/performance" element={<PerformancePage />} />
            <Route path="/responsive" element={<ResponsivePage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/prototype" element={<PrototypePage />} />
             <Route path="/terminal" element={<TerminalPage />} />
             <Route path="/notes" element={<NotesPage />} />
            <Route path="/mailbox" element={<MailBoxPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/releases" element={<ReleaseNotesPage />} />
            <Route path="/document" element={<Navigate to="/document/overview" replace />} />
            <Route path="/document/:slug" element={<DocumentPage />} />
            <Route path="/instructions" element={<InstructionsPage />} />
            <Route path="/templates" element={<ProjectSettingsPage />} />
            <Route path="/settings" element={<ProjectsPage />} />
            <Route path="/remote" element={<RemoteAccessPage />} />
            <Route path="/projects" element={<Navigate to="/settings" replace />} />
          </Routes>
          )}
          <RouteGuideTour />
        </div>
      </main>
    </div>
  )
}

/**
 * Top level. Two shapes of page live here:
 *
 * - **`/ai-labs` renders bare** — no sidebar, no bell, no page padding. It is its own
 *   surface with its own (always dark) theme, and the portal's chrome around it would
 *   read as a QC Portal page rather than the thing it is.
 * - **everything else** goes through `AppShell`.
 *
 * The background-job watchers are mounted HERE, above both, because they must keep
 * polling and announcing on any route — a crawl finishing while you're reading AI Labs
 * still has to notify. They render nothing, so they cost the bare page nothing.
 */
function App() {
  return (
    <>
      <TestCaseJobWatcher />
      <CrawlJobWatcher />
      <VerifyJobWatcher />
      <SourceJobWatcher />
      <DatabaseJobWatcher />
      <PerfJobWatcher />
      <Routes>
        <Route path="/ai-labs" element={<AiLabsPage />} />
        <Route path="/ai-labs/:id" element={<AiLabDetailPage />} />
        <Route path="*" element={<AppShell />} />
      </Routes>
    </>
  )
}

export default App
