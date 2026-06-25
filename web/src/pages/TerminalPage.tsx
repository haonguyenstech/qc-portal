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

  const { hostRef, status, connect, disconnect } = useXtermSession(() =>
    activeProjectId ? { projectId: activeProjectId } : ({} as Record<string, string>),
  )

  const unavailable = avail && !avail.ok

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 rounded-3xl border border-border/60 bg-muted/60 p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-foreground text-background">
              <TerminalSquare className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-xl font-semibold tracking-tight">Terminal</h1>
              <p className="text-sm text-muted-foreground">
                A real shell on this machine, running in your project folder.
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
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
          <span className="font-medium text-foreground">{activeProject?.name ?? 'No project'}</span>
          {activeProject?.rootPath && (
            <code className="truncate rounded-xl bg-background/60 px-2 py-0.5 font-mono text-[11px]">
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
        <div className="overflow-hidden rounded-3xl border border-border/60 bg-[#09090b]">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
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
          <div className="relative">
            <div ref={hostRef} className="h-[60vh] min-h-80 w-full px-3 py-2" />
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
