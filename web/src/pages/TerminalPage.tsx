import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  FolderGit2,
  Loader2,
  Plug,
  PlugZap,
  TerminalSquare,
  Unplug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { terminalAvailable } from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { useXtermSession } from '@/lib/useXtermSession'

// A real device pseudo-terminal: Connect spawns the user's login shell on the
// machine running the server (cwd = active project root) and streams it here over
// a dedicated WebSocket; Disconnect kills the shell. Behaves like a native terminal.
export default function TerminalPage() {
  const { activeProject, activeProjectId } = useProjects()
  const { data: avail } = useQuery({
    queryKey: ['terminal-available'],
    queryFn: terminalAvailable,
  })

  const { hostRef, status, connect, disconnect } = useXtermSession(
    () => (activeProjectId ? { projectId: activeProjectId } : ({} as Record<string, string>)),
    // Auto-launch Claude (skipping the per-action permission prompts) once the
    // shell is connected, so Connect drops the user straight into a Claude session.
    { initialCommand: 'claude --dangerously-skip-permissions' },
  )

  // The shell is spawned in one project's folder at Connect time and the WebSocket
  // stays bound to it. If the user switches the active project, that live shell is
  // now in the wrong folder — kill it so they can Connect fresh in the new project.
  const prevProjectId = useRef(activeProjectId)
  useEffect(() => {
    if (prevProjectId.current !== activeProjectId) {
      prevProjectId.current = activeProjectId
      disconnect()
    }
  }, [activeProjectId, disconnect])

  const unavailable = avail && !avail.ok

  return (
    // Fill the viewport height (minus the main content's vertical padding) so the
    // shell uses all available space; on short screens a min-height keeps it usable
    // and the page scrolls instead of crushing the terminal.
    <div className="flex h-[calc(100svh-2rem)] min-h-[32rem] flex-col gap-4 sm:h-[calc(100svh-3rem)] sm:gap-6 lg:h-[calc(100svh-4rem)]">
      <header className="shrink-0 space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <TerminalSquare className="size-5" />
            </span>
            <div className="space-y-1">
              <h1 className="text-3xl font-semibold tracking-tight">Terminal</h1>
              <p className="text-sm text-muted-foreground">
                A real shell on this machine, running in your project folder. Connect launches a
                Claude session automatically.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-xs font-medium',
                status === 'connected'
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : status === 'connecting'
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    : 'bg-muted text-muted-foreground',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  status === 'connected'
                    ? 'bg-emerald-500'
                    : status === 'connecting'
                      ? 'bg-amber-500'
                      : 'bg-muted-foreground/50',
                )}
              />
              {status === 'connected'
                ? 'Connected'
                : status === 'connecting'
                  ? 'Connecting…'
                  : 'Disconnected'}
            </span>
            {status === 'idle' ? (
              <Button
                onClick={connect}
                disabled={unavailable}
                className="rounded-full active:scale-[0.98]"
              >
                <Plug className="h-4 w-4" />
                Connect
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={disconnect}
                className="rounded-full active:scale-[0.98]"
              >
                {status === 'connecting' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4" />
                )}
                Disconnect
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
          <span className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
              <FolderGit2 className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                Shell runs in
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
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-3xl border border-border/60 bg-[#09090b]">
          <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-4 py-2.5">
            <PlugZap className="h-3.5 w-3.5 text-zinc-500" />
            <span className="font-mono text-[11px] text-zinc-400">
              {status === 'connected'
                ? `${activeProject?.name ?? 'shell'} — connected`
                : 'shell'}
            </span>
            <div className="ml-auto flex gap-1.5">
              <span className="size-2.5 rounded-full bg-red-500/70" />
              <span className="size-2.5 rounded-full bg-amber-500/70" />
              <span className="size-2.5 rounded-full bg-emerald-500/70" />
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
            <div ref={hostRef} className="h-full w-full px-3 py-2" />
            {status === 'idle' && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <TerminalSquare className="h-8 w-8 text-zinc-600" />
                <p className="text-sm text-zinc-400">
                  Click <span className="font-medium text-zinc-200">Connect</span> to open a shell
                </p>
                <p className="font-mono text-[11px] text-zinc-600">
                  e.g. run <span className="text-zinc-400">claude</span> to start a session
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
