import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  ChevronDown,
  Loader2,
  MessagesSquare,
  Plug,
  Sparkles,
  Unplug,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { terminalAvailable } from '@/lib/api'
import { useXtermSession } from '@/lib/useXtermSession'
import { cn } from '@/lib/utils'
import type { RunStatus } from '@/lib/types'

/**
 * "Continue session" — the QC run finished and wrote its report, but its Claude
 * session is kept alive. This is a real interactive terminal (same engine as the
 * Terminal page) wired to resume *this run's* session: Connect runs
 * `claude --resume <sessionId>` in the project folder over the /ws/terminal PTY,
 * so the engineer can keep working in the exact session that ran the test.
 */
export default function ContinueSessionPanel({
  runId,
  runStatus,
  hasSession,
}: {
  runId: string
  runStatus: RunStatus
  hasSession: boolean
}) {
  const queryClient = useQueryClient()
  const { data: avail } = useQuery({
    queryKey: ['terminal-available'],
    queryFn: terminalAvailable,
  })
  const { hostRef, status, connect, disconnect } = useXtermSession(() => ({ runId }))
  // Collapsed by default — the terminal is heavy and rarely the first thing the
  // engineer wants. Click the header to expand and reveal the session.
  const [expanded, setExpanded] = useState(false)

  // When the session ends (the user disconnects or quits Claude), refresh the run
  // detail + files — an interactive session may have rewritten report.md / evidence.
  const prevStatus = useRef(status)
  useEffect(() => {
    if (prevStatus.current === 'connected' && status === 'idle') {
      queryClient.invalidateQueries({ queryKey: ['run', runId] })
      queryClient.invalidateQueries({ queryKey: ['run-files', runId] })
    }
    prevStatus.current = status
  }, [status, runId, queryClient])

  if (!hasSession) return null

  const unavailable = avail && !avail.ok
  // The session is in use while the original run is still executing — don't resume
  // it concurrently; wait until the run is finished.
  const runBusy = runStatus === 'running' || runStatus === 'queued'
  const canConnect = !unavailable && !runBusy

  return (
    <section className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
      <div
        className={cn(
          'flex items-start justify-between gap-3 bg-muted/60 px-5 py-4',
          expanded && 'border-b border-border/60',
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <MessagesSquare className="size-4" />
          </span>
          <div>
            <div className="text-sm font-semibold">Continue session</div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              The QC session is still open — Connect to keep working in it as a real terminal.
            </p>
          </div>
          <ChevronDown
            className={cn(
              'ml-1 size-4 shrink-0 text-muted-foreground transition-transform duration-200',
              expanded && 'rotate-180',
            )}
          />
        </button>
        <div className={cn('flex items-center gap-2', !expanded && 'hidden')}>
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
              disabled={!canConnect}
              title={
                unavailable
                  ? 'Terminal unavailable on the server'
                  : runBusy
                    ? 'Wait for the run to finish'
                    : 'Resume this run’s Claude session'
              }
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

      {!expanded ? null : unavailable ? (
        <div className="flex items-start gap-3 px-5 py-6 text-sm">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
          <div>
            <p className="font-medium text-foreground">Terminal unavailable</p>
            <p className="mt-1 text-muted-foreground">
              The native <code className="font-mono">node-pty</code> binding failed to load on the
              server, so the session can't be opened in a terminal.
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-[#09090b]">
          <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2.5">
            <Sparkles className="h-3.5 w-3.5 text-zinc-500" />
            <span className="font-mono text-[11px] text-zinc-400">
              {status === 'connected' ? `claude --resume · run ${runId.slice(0, 8)}` : 'claude session'}
            </span>
            <div className="ml-auto flex gap-1.5">
              <span className="size-2.5 rounded-full bg-red-500/70" />
              <span className="size-2.5 rounded-full bg-amber-500/70" />
              <span className="size-2.5 rounded-full bg-emerald-500/70" />
            </div>
          </div>
          <div className="relative">
            <div ref={hostRef} className="h-[55vh] min-h-80 w-full px-3 py-2" />
            {status === 'idle' && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
                <MessagesSquare className="h-8 w-8 text-zinc-600" />
                <p className="text-sm text-zinc-400">
                  {runBusy ? (
                    'Run is still in progress — wait for it to finish.'
                  ) : (
                    <>
                      Click <span className="font-medium text-zinc-200">Connect</span> to resume the
                      Claude session
                    </>
                  )}
                </p>
                {!runBusy && (
                  <p className="font-mono text-[11px] text-zinc-600">
                    Picks up the exact session that ran this test — ask it anything.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
