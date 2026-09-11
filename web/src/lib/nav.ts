/**
 * The sidebar's page list, and which of those pages the engineer has hidden.
 *
 * `navGroups` used to live in `App.tsx`, but Settings needs the very same list to
 * draw its show/hide switches — and importing it back out of `App.tsx` would be a
 * cycle (App imports the page, the page imports App). One module both sides read
 * is the only version of this that stays honest: add a page in one place and it
 * appears in the rail AND in Settings.
 *
 * Hiding is a per-MACHINE view preference, not project data — same class of thing
 * as the theme and the collapsed rail — so it lives in localStorage and never
 * reaches the server. It only removes the ROW: every route stays mounted, so a
 * hidden page is still reachable by URL, by a link from another page, and by the
 * rail's own ⌘K filter results are drawn from the visible set only.
 */
import {
  AlarmClock,
  BarChart3,
  BookOpen,
  ClipboardList,
  Code2,
  Database,
  FileCog,
  FileText,
  Gauge,
  Globe,
  History,
  Inbox,
  Layout,
  MessagesSquare,
  NotebookPen,
  PlayCircle,
  Plug,
  RadioTower,
  ScanSearch,
  Settings,
  Smartphone,
  TerminalSquare,
  Ticket,
  Wrench,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

export interface NavItemDef {
  to: string
  label: string
  icon: typeof BookOpen
  end: boolean
}

export interface NavGroupDef {
  label: string
  items: NavItemDef[]
}

export const navGroups: NavGroupDef[] = [
  {
    label: 'Project',
    items: [
      { to: '/overview', label: 'Overview', icon: BookOpen, end: false },
      { to: '/source', label: 'Source Code', icon: Code2, end: false },
      { to: '/database', label: 'Database', icon: Database, end: false },
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
      { to: '/performance', label: 'Performance', icon: Gauge, end: false },
      // Under Testing rather than Tools: it takes a URL and answers a pass/fail
      // question about it, which is the same shape as Design Check next door.
      { to: '/responsive', label: 'Responsive', icon: Smartphone, end: false },
    ],
  },
  {
    // Its own group, not a row under Testing: this is the only page that reads
    // ACROSS tickets, test cases, runs and defects at once, and burying it among
    // the pages it summarises is how nobody finds it.
    label: 'Report',
    items: [{ to: '/reports', label: 'QC Report', icon: BarChart3, end: false }],
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
      { to: '/chat', label: 'Chat', icon: MessagesSquare, end: false },
      // Next to Chat on purpose: a scheduled task IS a chat turn nobody had to be present
      // for, and the composer's `/scheduled` command is how most of them get created.
      { to: '/scheduled', label: 'Scheduled', icon: AlarmClock, end: false },
      { to: '/prototype', label: 'Prototype', icon: Layout, end: false },
      { to: '/terminal', label: 'Terminal', icon: TerminalSquare, end: false },
      { to: '/notes', label: 'Note', icon: NotebookPen, end: false },
      { to: '/mailbox', label: 'MailBox', icon: Inbox, end: false },
      // A reading page, not a project tool — it's here because Tools is where an engineer
      // looks when asking "what else can I use?".
      // Temporarily hidden from the sidebar; the /ai-labs routes still work by URL.
      // { to: '/ai-labs', label: 'QC AI Labs', icon: FlaskConical, end: false },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/settings', label: 'Settings', icon: Settings, end: false },
      { to: '/remote', label: 'Remote access', icon: Globe, end: false },
    ],
  },
]

/** Pages that can never be hidden — Settings is where hiding is undone. */
export const NAV_ALWAYS_VISIBLE = ['/settings']

export const NAV_HIDDEN_KEY = 'qc.sidebar.hidden'

/** Fired on this tab after a write; `storage` only fires in the OTHER tabs. */
const NAV_HIDDEN_EVENT = 'qc:nav-hidden'

export function readHiddenNav(): string[] {
  try {
    const raw = localStorage.getItem(NAV_HIDDEN_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Drop anything that is no longer a real page (a renamed or removed route),
    // so a stale entry can't keep hiding a row that doesn't exist any more.
    const known = new Set(navGroups.flatMap((g) => g.items.map((i) => i.to)))
    return parsed.filter(
      (t): t is string => typeof t === 'string' && known.has(t) && !NAV_ALWAYS_VISIBLE.includes(t),
    )
  } catch {
    return []
  }
}

export function writeHiddenNav(hidden: string[]) {
  try {
    localStorage.setItem(NAV_HIDDEN_KEY, JSON.stringify(hidden))
  } catch {
    /* storage unavailable — non-fatal, the choice just won't survive a reload */
  }
  window.dispatchEvent(new Event(NAV_HIDDEN_EVENT))
}

/**
 * The hidden set, live. Both the sidebar and the Settings card mount this hook,
 * and they are on screen at the same time — without the event the rail would
 * only pick up a toggle on the next reload.
 */
export function useHiddenNav() {
  const [hidden, setHidden] = useState<string[]>(readHiddenNav)

  useEffect(() => {
    const sync = () => setHidden(readHiddenNav())
    window.addEventListener(NAV_HIDDEN_EVENT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(NAV_HIDDEN_EVENT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])

  const toggle = useCallback((to: string) => {
    if (NAV_ALWAYS_VISIBLE.includes(to)) return
    const next = readHiddenNav()
    writeHiddenNav(next.includes(to) ? next.filter((t) => t !== to) : [...next, to])
  }, [])

  const showAll = useCallback(() => writeHiddenNav([]), [])

  return { hidden, toggle, showAll }
}

/** `navGroups` minus the hidden rows, with any group that empties out dropped. */
export function visibleNavGroups(hidden: string[]): NavGroupDef[] {
  if (hidden.length === 0) return navGroups
  const off = new Set(hidden)
  return navGroups
    .map((g) => ({ ...g, items: g.items.filter((i) => !off.has(i.to)) }))
    .filter((g) => g.items.length > 0)
}

/* ---------------------------------------------------------------------------
 * Collapsed GROUPS (the expanded rail's accordion)
 *
 * Six groups and ~23 rows is more than one screenful on a laptop, so each group
 * header folds. This is separate from `qc.sidebar.collapsed` (the whole rail
 * going icon-only) and from the hidden set above: hiding says "I never use this
 * page", folding says "not right now". Only the rail reads it, so a plain hook
 * is enough — no cross-component event.
 * -------------------------------------------------------------------------*/

export const NAV_FOLDED_GROUPS_KEY = 'qc.sidebar.foldedGroups'

function readFoldedGroups(): string[] {
  try {
    const raw = localStorage.getItem(NAV_FOLDED_GROUPS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const known = new Set(navGroups.map((g) => g.label))
    return parsed.filter((l): l is string => typeof l === 'string' && known.has(l))
  } catch {
    return []
  }
}

export function useFoldedNavGroups() {
  const [folded, setFolded] = useState<string[]>(readFoldedGroups)

  useEffect(() => {
    try {
      localStorage.setItem(NAV_FOLDED_GROUPS_KEY, JSON.stringify(folded))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [folded])

  const toggleGroup = useCallback((label: string) => {
    setFolded((f) => (f.includes(label) ? f.filter((l) => l !== label) : [...f, label]))
  }, [])

  /** Fold everything, or unfold everything — the one control for "too much rail". */
  const foldAll = useCallback((labels: string[]) => setFolded(labels), [])
  const unfoldAll = useCallback(() => setFolded([]), [])

  return { folded, toggleGroup, foldAll, unfoldAll }
}
