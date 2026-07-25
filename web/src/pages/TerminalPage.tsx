import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  Command,
  CornerDownLeft,
  FolderGit2,
  Loader2,
  Play,
  Plug,
  Plus,
  TerminalSquare,
  Unplug,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { listTerminalSessions, terminalAvailable } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import {
  useXtermSession,
  WS_CLOSE_TAKEN_OVER,
  type TerminalStatus,
} from '@/lib/useXtermSession'

// Curated Claude Code slash commands — the ones QC engineers reach for most —
// surfaced in a picker so they don't have to remember them. Clicking one types it
// into the live Claude session (no Enter, so it can be reviewed before submitting).
interface SlashCommand {
  cmd: string
  desc: string
}
const SLASH_GROUPS: { label: string; items: SlashCommand[] }[] = [
  {
    label: 'Session & context',
    items: [
      { cmd: '/clear', desc: 'Clear the conversation and free up the context window' },
      { cmd: '/compact', desc: 'Summarize the conversation so far to reclaim context' },
      { cmd: '/context', desc: 'Show how much of the context window is currently used' },
      { cmd: '/rewind', desc: 'Roll back to an earlier checkpoint of the conversation' },
      { cmd: '/resume', desc: 'Pick a previous session to continue' },
    ],
  },
  {
    label: 'Get work done',
    items: [
      { cmd: '/review', desc: 'Review a pull request or the current code changes' },
      { cmd: '/init', desc: 'Scan the repo and generate a CLAUDE.md for it' },
      { cmd: '/memory', desc: 'Open the memory / CLAUDE.md files to edit' },
      { cmd: '/agents', desc: 'Create and manage specialized subagents' },
    ],
  },
  {
    label: 'Setup & configuration',
    items: [
      { cmd: '/model', desc: 'Switch the active model (Opus, Sonnet, Haiku…)' },
      { cmd: '/mcp', desc: 'Manage MCP server connections' },
      { cmd: '/config', desc: 'Open Claude Code settings' },
      { cmd: '/permissions', desc: 'View and edit tool permission rules' },
      { cmd: '/hooks', desc: 'Configure hooks that run around tool calls' },
    ],
  },
  {
    label: 'Info & help',
    items: [
      { cmd: '/help', desc: 'List every available slash command' },
      { cmd: '/usage', desc: 'Show plan usage and rate-limit status' },
      { cmd: '/cost', desc: 'Show token usage and cost for this session' },
      { cmd: '/status', desc: 'Show account, model, and connection status' },
      { cmd: '/doctor', desc: 'Diagnose the Claude Code installation' },
      { cmd: '/bug', desc: 'Report a bug to Anthropic' },
    ],
  },
]

function SlashCommandsDialog({
  open,
  onOpenChange,
  connected,
  onPick,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  connected: boolean
  onPick: (cmd: string, run: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader className="border-b border-border/60 px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2 tracking-tight">
            <Command className="size-4" />
            Claude Code slash commands
          </DialogTitle>
          <DialogDescription>
            {connected
              ? 'Click a command to type it into the session (review, then Enter), or hit Run to type it and send it right away.'
              : 'Connect a shell first, then a command will be typed into the Claude session.'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-5 overflow-y-auto px-6 py-5">
          {SLASH_GROUPS.map((group) => (
            <div key={group.label} className="space-y-1.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <div
                    key={item.cmd}
                    className={cn(
                      'group flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card px-3 py-2.5 transition-all duration-200',
                      connected
                        ? 'hover:border-border hover:shadow-sm'
                        : 'opacity-50',
                    )}
                  >
                    {/* Click the row body: type the command in for review (no Enter). */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={!connected}
                          onClick={() => onPick(item.cmd, false)}
                          className={cn(
                            'flex min-w-0 flex-1 items-center gap-3 text-left',
                            connected ? 'active:scale-[0.99]' : 'cursor-not-allowed',
                          )}
                        >
                          <code className="shrink-0 rounded-xl border border-border/60 bg-muted/60 px-2 py-1 font-mono text-xs font-semibold text-foreground">
                            {item.cmd}
                          </code>
                          <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                            {item.desc}
                          </span>
                          {connected && (
                            <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {connected
                          ? 'Insert — type it in, then press Enter yourself'
                          : 'Connect a shell first'}
                      </TooltipContent>
                    </Tooltip>
                    {/* Run icon: type the command AND send Enter immediately. */}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          disabled={!connected}
                          onClick={() => onPick(item.cmd, true)}
                          aria-label={`Run ${item.cmd} now`}
                          className={cn(
                            'flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/60 text-muted-foreground transition-all duration-200',
                            connected
                              ? 'hover:bg-foreground hover:text-background active:scale-[0.95]'
                              : 'cursor-not-allowed',
                          )}
                        >
                          <Play className="size-3.5" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>
                        {connected
                          ? `Run now — type ${item.cmd} and send Enter`
                          : 'Connect a shell first'}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}


// ---- Multiple terminals ----------------------------------------------------
// Each tab is its own persistent shell on the server (`?tab=<id>`), so a QC can
// run Claude in one and git/tests in another. Tabs are remembered per project in
// localStorage, and any shell the server still has for this project is folded back
// in on arrival — so a reload lands on the same set of terminals.

interface TermTab {
  id: string
  label: string
}

const MAX_TABS = 6
/** Unattended connect attempts per pane before we stop and wait for the user. */
const AUTO_CONNECT_ATTEMPTS = 3
const tabsKey = (projectId: string) => `qc.terminalTabs.${projectId}`

function loadTabs(projectId: string): TermTab[] {
  try {
    const raw = localStorage.getItem(tabsKey(projectId))
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    if (Array.isArray(parsed)) {
      const tabs = parsed
        .filter(
          (t): t is TermTab =>
            !!t && typeof (t as TermTab).id === 'string' && typeof (t as TermTab).label === 'string',
        )
        .slice(0, MAX_TABS)
      if (tabs.length) return tabs
    }
  } catch {
    /* unreadable storage — fall through to a single tab */
  }
  return [{ id: 'main', label: 'Terminal 1' }]
}

/** Imperative handle the tab bar / header use to drive one pane. */
interface PaneApi {
  connect: (opts?: { reattach?: boolean }) => void
  kill: () => void
  sendText: (text: string) => void
  focus: () => void
}

/**
 * One terminal. Panes for inactive tabs stay MOUNTED (just hidden) so their shell
 * keeps streaming and switching tabs is instant — `invisible` rather than `hidden`
 * keeps a real size, which xterm's fit addon needs.
 */
function TerminalPane({
  tab,
  projectId,
  projectName,
  active,
  live,
  heldElsewhere,
  autoConnect,
  unavailable,
  onStatus,
  onApi,
}: {
  tab: TermTab
  projectId: string
  projectName: string
  active: boolean
  live: boolean // the server still has a shell for this tab → re-attach, don't respawn
  heldElsewhere: boolean // …but another browser window is viewing it right now
  autoConnect: boolean
  unavailable: boolean
  onStatus: (id: string, status: TerminalStatus) => void
  onApi: (id: string, api: PaneApi | null) => void
}) {
  // Another window is viewing this shell (the server kicked us with a takeover close
  // code). We must NOT re-attach on our own: both windows would keep stealing it back
  // and flap between connecting/connected forever. The user takes over explicitly.
  const [takenOver, setTakenOver] = useState(false)
  const { hostRef, status, connect, disconnect, sendText, focus } = useXtermSession(
    () => ({ projectId, tab: tab.id }),
    {
      // Auto-launch Claude (skipping the per-action permission prompts) once the
      // shell is connected, so opening a terminal drops the user straight into a
      // Claude session. Skipped on re-attach — that session already has one running.
      initialCommand: 'claude --dangerously-skip-permissions',
      onClosed: (code) => {
        if (code === WS_CLOSE_TAKEN_OVER) setTakenOver(true)
      },
    },
  )

  useEffect(() => {
    onStatus(tab.id, status)
  }, [status, tab.id, onStatus])

  // Ending a session is always deliberate (Disconnect / closing the tab) — remember
  // it so the auto-connect below never resurrects what the user just closed, until
  // they ask for it again.
  const userEnded = useRef(false)
  const kill = useCallback(() => {
    userEnded.current = true
    disconnect()
  }, [disconnect])
  const attempts = useRef(0)
  const open = useCallback(
    (opts?: { reattach?: boolean }) => {
      userEnded.current = false
      setTakenOver(false)
      attempts.current = 0 // asked for by hand → the auto-retry budget is refilled
      connect(opts)
    },
    [connect],
  )

  useEffect(() => {
    onApi(tab.id, { connect: open, kill, sendText, focus })
    return () => onApi(tab.id, null)
  }, [tab.id, open, kill, sendText, focus, onApi])

  // Open the shell without being asked when this tab was just created by the user or
  // when the server still has its session (then it's a re-attach). Driven by `status`,
  // so a re-mount that drops the socket (React StrictMode in dev) simply connects
  // again — and never while already connecting/connected. Guards that keep this from
  // becoming a loop: nothing after the user ended it, nothing once another window has
  // taken the session over, and a hard cap on unattended attempts (a socket that keeps
  // dying must not be retried forever — the Connect button is right there).
  useEffect(() => {
    if (!autoConnect || unavailable || status !== 'idle') return
    if (userEnded.current || takenOver || attempts.current >= AUTO_CONNECT_ATTEMPTS) return
    attempts.current += 1
    userEnded.current = false
    connect({ reattach: live })
  }, [autoConnect, live, unavailable, status, takenOver, connect])

  // Take the caret when this tab becomes the visible one.
  useEffect(() => {
    if (active && status === 'connected') focus()
  }, [active, status, focus])

  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col',
        !active && 'invisible pointer-events-none',
      )}
      aria-hidden={!active}
    >
      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="h-full w-full px-3 py-2" />
        {status === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-500">
              <TerminalSquare className="h-6 w-6" />
            </span>
            {takenOver || heldElsewhere ? (
              <>
                <p className="max-w-sm text-sm text-zinc-400">
                  This terminal is open in another browser window. Only one window can view a
                  session at a time.
                </p>
                <Button
                  onClick={() => open({ reattach: true })}
                  className="rounded-full active:scale-[0.98]"
                >
                  <Plug className="h-4 w-4" />
                  Take over here
                </Button>
              </>
            ) : live ? (
              <p className="text-sm text-zinc-400">
                A session is still running —{' '}
                <span className="font-medium text-zinc-200">re-attaching…</span>
              </p>
            ) : (
              <>
                <p className="text-sm text-zinc-400">Open a shell in this terminal</p>
                <Button
                  onClick={() => open()}
                  disabled={unavailable}
                  className="rounded-full active:scale-[0.98]"
                >
                  <Plug className="h-4 w-4" />
                  Connect
                </Button>
                <p className="font-mono text-[11px] text-zinc-600">
                  starts <span className="text-zinc-400">claude</span> in{' '}
                  {projectName || 'the project'}
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The tab strip, styled as the terminal window's own chrome (it sits INSIDE the dark
 * shell surface, like a native terminal app): traffic lights, one tab per shell with
 * a live status dot, and a + to open another. Closing a tab ENDS that shell — the only
 * thing on this page that does, since leaving the page keeps them running.
 */
function TerminalTabs({
  tabs,
  activeId,
  statuses,
  heldTabIds,
  onSelect,
  onClose,
  onAdd,
  canAdd,
  meta,
}: {
  tabs: TermTab[]
  activeId: string | null
  statuses: Record<string, TerminalStatus>
  heldTabIds: string[]
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onAdd: () => void
  canAdd: boolean
  meta: string // right-hand caption: which project / what state
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2">
      {/* Window buttons — decoration, matching the "real terminal" framing. */}
      <div className="hidden shrink-0 gap-1.5 pr-1 sm:flex">
        <span className="size-2.5 rounded-full bg-red-500/70" />
        <span className="size-2.5 rounded-full bg-amber-500/70" />
        <span className="size-2.5 rounded-full bg-emerald-500/70" />
      </div>
      <div
        data-tour="tabs"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const status = statuses[tab.id] ?? 'idle'
          const held = status === 'idle' && heldTabIds.includes(tab.id)
          const isActive = tab.id === activeId
          return (
            <div
              key={tab.id}
              className={cn(
                'group flex shrink-0 items-center gap-1.5 rounded-xl py-1 pl-2.5 pr-1 text-xs transition-colors duration-200',
                isActive
                  ? 'bg-white/10 font-medium text-zinc-100'
                  : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-200',
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(tab.id)}
                className="flex items-center gap-2"
                aria-current={isActive}
                title={
                  status === 'connected'
                    ? `${tab.label} — running`
                    : held
                      ? `${tab.label} — open in another window`
                      : `${tab.label} — not connected`
                }
              >
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    status === 'connected'
                      ? 'bg-emerald-400'
                      : status === 'connecting'
                        ? 'bg-amber-400'
                        : held
                          ? 'bg-sky-400/70'
                          : 'bg-zinc-600',
                  )}
                />
                {tab.label}
              </button>
              <button
                type="button"
                onClick={() => onClose(tab.id)}
                aria-label={`Close ${tab.label}`}
                title="Close this terminal — ends its shell"
                className={cn(
                  'rounded-lg p-0.5 text-zinc-500 transition-all hover:bg-red-500/20 hover:text-red-300',
                  isActive ? 'opacity-70' : 'opacity-0 group-hover:opacity-70',
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          onClick={onAdd}
          disabled={!canAdd}
          aria-label="New terminal"
          title={canAdd ? 'New terminal' : `At most ${MAX_TABS} terminals at once`}
          className={cn(
            'ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-xl text-zinc-500 transition-colors',
            canAdd ? 'hover:bg-white/10 hover:text-zinc-100 active:scale-[0.95]' : 'opacity-40',
          )}
        >
          <Plus className="size-4" />
        </button>
      </div>
      <span className="ml-auto hidden shrink-0 truncate pl-2 font-mono text-[11px] text-zinc-500 md:block">
        {meta}
      </span>
    </div>
  )
}

/**
 * All terminals for ONE project. Mounted with `key={projectId}` so switching project
 * gives a clean set of tabs; the previous project's shells stay alive on the server
 * (they're keyed by project) and are picked up again when you switch back.
 */
function TerminalWorkspace({
  projectId,
  projectName,
  unavailable,
}: {
  projectId: string
  projectName: string
  unavailable: boolean
}) {
  const queryClient = useQueryClient()
  // Which shells the server still has — decides re-attach vs spawn, and revives
  // tabs whose ids aren't in localStorage any more.
  const { data: liveData, isFetchedAfterMount } = useQuery({
    queryKey: ['terminal-sessions'],
    queryFn: listTerminalSessions,
    refetchOnMount: 'always',
    // Poll while the page is open: on a reload the first answer can still list our
    // own just-closed sockets as attached (the server hasn't processed the closes
    // yet), which would leave those tabs sitting there un-attached. It also keeps
    // "open in another window" current when that window lets go.
    refetchInterval: 3000,
  })

  const [storedTabs, setStoredTabs] = useState<TermTab[]>(() => loadTabs(projectId))
  const [activeId, setActiveId] = useState<string>(() => loadTabs(projectId)[0].id)
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus>>({})
  // Tabs the user opened in this visit — those connect on their own.
  const [freshIds, setFreshIds] = useState<string[]>([])
  // Tabs just closed, so a session the server hasn't dropped yet doesn't flash back.
  const [closedIds, setClosedIds] = useState<string[]>([])
  const [cmdOpen, setCmdOpen] = useState(false)
  const apis = useRef(new Map<string, PaneApi>())

  const liveShells = (liveData?.sessions ?? []).filter(
    (s) => s.kind === 'shell' && s.projectId === projectId && s.tab && !closedIds.includes(s.tab),
  )
  const liveTabIds = liveShells.map((s) => s.tab as string)
  // Sessions some window is already viewing. We only auto-attach the ones nobody
  // holds — otherwise two windows on this page steal the shell back and forth. Our
  // own connected panes land here too, which is harmless: they're not idle, so the
  // auto-connect they'd trigger is skipped anyway.
  const heldTabIds = liveShells.filter((s) => s.attached).map((s) => s.tab as string)

  // A shell the server still has but this browser doesn't list (localStorage cleared,
  // or another window opened it) becomes a tab too — derived on render, so no
  // setState-in-effect. The merged list is what gets persisted below.
  const revived = liveTabIds.filter((id) => !storedTabs.some((t) => t.id === id))
  const tabs: TermTab[] =
    revived.length && storedTabs.length < MAX_TABS
      ? [
          ...storedTabs,
          ...revived
            .slice(0, MAX_TABS - storedTabs.length)
            .map((id, i) => ({ id, label: `Terminal ${storedTabs.length + i + 1}` })),
        ]
      : storedTabs

  const tabsJson = JSON.stringify(tabs)
  useEffect(() => {
    try {
      localStorage.setItem(tabsKey(projectId), tabsJson)
    } catch {
      /* storage full / disabled — tabs just won't survive a reload */
    }
  }, [tabsJson, projectId])

  const onStatus = useCallback((id: string, status: TerminalStatus) => {
    setStatuses((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }))
    // "Just created by the user" is a one-shot reason to auto-connect: once the shell
    // is up, keeping it would respawn one every time that pane goes idle.
    if (status === 'connected') {
      setFreshIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev))
    }
  }, [])

  const onApi = useCallback((id: string, api: PaneApi | null) => {
    if (api) apis.current.set(id, api)
    else apis.current.delete(id)
  }, [])

  // Keep the live-session answer honest after any pane connects or ends.
  const statusFingerprint = Object.values(statuses).join(',')
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ['terminal-sessions'] })
  }, [statusFingerprint, queryClient])

  function addTab() {
    if (tabs.length >= MAX_TABS) {
      toast.error(`At most ${MAX_TABS} terminals at once`, {
        description: 'Close one you no longer need first.',
      })
      return
    }
    const used = new Set(tabs.map((t) => t.label))
    let n = 1
    while (used.has(`Terminal ${n}`)) n += 1
    const id = `t${Date.now().toString(36)}`
    setStoredTabs([...tabs, { id, label: `Terminal ${n}` }])
    setFreshIds((prev) => [...prev, id])
    setActiveId(id)
  }

  function closeTab(id: string) {
    // A tab's shell is only ended deliberately — this is that moment.
    apis.current.get(id)?.kill()
    const next = tabs.filter((t) => t.id !== id)
    setStoredTabs(next)
    setClosedIds((prev) => [...prev, id])
    setFreshIds((prev) => prev.filter((x) => x !== id))
    setStatuses((prev) => {
      const rest = { ...prev }
      delete rest[id]
      return rest
    })
    if (id === activeId) {
      const i = tabs.findIndex((t) => t.id === id)
      setActiveId(next[Math.min(i, next.length - 1)]?.id ?? '')
    }
  }

  const activeStatus = statuses[activeId] ?? 'idle'
  const activeLive = liveTabIds.includes(activeId)
  // Live, but another window is viewing it — connecting from here takes it over.
  const activeHeld = activeStatus === 'idle' && heldTabIds.includes(activeId)

  return (
    <>
      {/* What to do with the ACTIVE terminal. The tabs themselves live in the shell's
          own window chrome below. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {tabs.length > 1
            ? `${tabs.length} terminals — each tab is its own shell and Claude session. These controls act on the active tab.`
            : 'Each tab is its own shell and Claude session. Use + in the terminal to open another.'}
        </p>
        <div data-tour="session" className="flex items-center gap-2">
        <Button
          variant="outline"
          onClick={() => setCmdOpen(true)}
          className="rounded-full active:scale-[0.98]"
          title="Browse common Claude Code slash commands"
        >
          <Command className="h-4 w-4" />
          Slash commands
        </Button>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium',
            activeStatus === 'connected'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : activeStatus === 'connecting'
                ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                : 'bg-muted text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full',
              activeStatus === 'connected'
                ? 'bg-emerald-500'
                : activeStatus === 'connecting'
                  ? 'bg-amber-500'
                  : 'bg-muted-foreground/50',
            )}
          />
          {activeStatus === 'connected'
            ? 'Connected'
            : activeStatus === 'connecting'
              ? 'Connecting…'
              : 'Disconnected'}
        </span>
        {activeStatus === 'idle' ? (
          <Button
            onClick={() => apis.current.get(activeId)?.connect({ reattach: activeLive })}
            disabled={unavailable || !activeId}
            title={
              activeHeld
                ? 'Open in another browser window — take the session over here'
                : activeLive
                  ? 'This terminal’s shell is still running — re-attach to it'
                  : 'Open a shell in the project folder'
            }
            className="rounded-full active:scale-[0.98]"
          >
            <Plug className="h-4 w-4" />
            {activeHeld ? 'Take over' : activeLive ? 'Re-attach' : 'Connect'}
          </Button>
        ) : (
          <Button
            variant="destructive"
            onClick={() => apis.current.get(activeId)?.kill()}
            title="End this terminal’s session — its shell and anything running in it are closed"
            className="rounded-full active:scale-[0.98]"
          >
            {activeStatus === 'connecting' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Unplug className="h-4 w-4" />
            )}
            Disconnect
          </Button>
        )}
        </div>
      </div>

      <div
        data-tour="shell"
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border/60 bg-[#09090b]"
      >
        <TerminalTabs
          tabs={tabs}
          activeId={activeId}
          statuses={statuses}
          heldTabIds={heldTabIds}
          onSelect={(id) => {
            setActiveId(id)
            apis.current.get(id)?.focus()
          }}
          onClose={closeTab}
          onAdd={addTab}
          canAdd={tabs.length < MAX_TABS}
          meta={
            activeStatus === 'connected'
              ? `${projectName} · ${tabs.length} terminal${tabs.length === 1 ? '' : 's'}`
              : projectName
          }
        />
        <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-white/5 text-zinc-500">
              <TerminalSquare className="h-6 w-6" />
            </span>
            <p className="text-sm text-zinc-400">No terminals open</p>
            <Button onClick={addTab} className="rounded-full active:scale-[0.98]">
              <Plus className="h-4 w-4" />
              New terminal
            </Button>
          </div>
        ) : (
          tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              tab={tab}
              projectId={projectId}
              projectName={projectName}
              active={tab.id === activeId}
              live={liveTabIds.includes(tab.id)}
              heldElsewhere={
                heldTabIds.includes(tab.id) && (statuses[tab.id] ?? 'idle') === 'idle'
              }
              // Re-attach only once the server has actually answered this visit — a
              // cached "still alive" from before a server restart would otherwise
              // spawn a fresh shell while suppressing its launch command.
              autoConnect={
                freshIds.includes(tab.id) ||
                (isFetchedAfterMount &&
                  liveTabIds.includes(tab.id) &&
                  (!heldTabIds.includes(tab.id) || statuses[tab.id] === 'connected'))
              }
              unavailable={unavailable}
              onStatus={onStatus}
              onApi={onApi}
            />
          ))
        )}
        </div>
      </div>

      <SlashCommandsDialog
        open={cmdOpen}
        onOpenChange={setCmdOpen}
        connected={activeStatus === 'connected'}
        onPick={(cmd, run) => {
          // Run: type the command and press Enter (\r). Otherwise just type it in.
          apis.current.get(activeId)?.sendText(run ? `${cmd}\r` : cmd)
          setCmdOpen(false)
        }}
      />
    </>
  )
}

// A real device pseudo-terminal: each tab spawns the user's login shell on the
// machine running the server (cwd = active project root) and streams it here over a
// dedicated WebSocket. Shells OUTLIVE this page — navigating away only closes the
// sockets, and coming back re-attaches to the same sessions (whatever Claude was
// doing is still there). Closing a tab (or Disconnect) is what actually ends one.
export default function TerminalPage() {
  const { activeProject, activeProjectId } = useProjects()
  const { data: avail } = useQuery({
    queryKey: ['terminal-available'],
    queryFn: terminalAvailable,
  })
  const unavailable = !!avail && !avail.ok

  return (
    // Fill the viewport height (minus the main content's vertical padding) so the
    // shell uses all available space; on short screens a min-height keeps it usable
    // and the page scrolls instead of crushing the terminal.
    <div className="flex h-[calc(100svh-2rem)] min-h-[32rem] flex-col gap-4 sm:h-[calc(100svh-3rem)] sm:gap-6 lg:h-[calc(100svh-4rem)]">
      <header className="shrink-0 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div data-tour="header" className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <TerminalSquare className="size-5" />
            </span>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight">Terminal</h1>
              <p className="text-sm text-muted-foreground">
                Real shells on this machine, running in your project folder. Open several with New
                terminal; each keeps running if you leave this page — come back and you're
                re-attached.
              </p>
            </div>
          </div>
        </div>
        <div
          data-tour="cwd"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none"
        >
          <span className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
              <FolderGit2 className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                Shells run in
              </span>
              <span className="block text-sm font-semibold tracking-tight">
                {activeProject?.name ?? 'No project'}
              </span>
            </span>
          </span>
          {activeProject?.rootPath && (
            <code className="ml-auto min-w-0 max-w-full truncate rounded-xl bg-muted/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
              {activeProject.rootPath}
            </code>
          )}
        </div>
      </header>

      {unavailable ? (
        <div className="flex items-start gap-3 rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-foreground">Terminal unavailable</p>
            <p className="mt-1 text-muted-foreground">
              The native <code className="font-mono">node-pty</code> binding failed to load on the
              server, so a pseudo-terminal can't be started.
            </p>
            {avail?.error && (
              <code className="mt-2 block rounded-xl bg-background/60 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                {avail.error}
              </code>
            )}
          </div>
        </div>
      ) : (
        <TerminalWorkspace
          key={activeProjectId ?? 'none'}
          projectId={activeProjectId ?? ''}
          projectName={activeProject?.name ?? 'shell'}
          unavailable={unavailable}
        />
      )}
    </div>
  )
}
