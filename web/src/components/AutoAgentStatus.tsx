import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Loader2, PlugZap, ShieldOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNotifications } from '@/lib/notifications'
import { getAutoAgentStatus, type AutoAgentState, type AutoAgentStatus } from '@/lib/api'

/**
 * Sidebar indicator for the company's **Auto Agent** CLI (`auto-agent-ai`), which
 * distributes the shared Claude Code credential. Every QC run, test-case generation
 * and Ask-AI call ultimately shells out to `claude`, so when Auto Agent logs out,
 * its watcher dies, or the credential lapses, all of that starts failing with
 * confusing mid-run auth errors. This puts the state where it's always visible —
 * directly above Release notes — and raises a toast + bell notification the moment
 * it drops, so nobody discovers it halfway through a run.
 *
 * Polled (not pushed): the server check is a filesystem read + pid probe, so it's
 * cheap enough to run every 30s and needs no socket.
 */

const POLL_MS = 30_000

interface Look {
  label: string
  dot: string
  text: string
  border: string
  Icon: typeof CheckCircle2
}

function lookFor(state: AutoAgentState): Look {
  switch (state) {
    case 'connected':
      return {
        label: 'Connected',
        dot: 'bg-emerald-500',
        text: 'text-emerald-600 dark:text-emerald-400',
        border: 'border-sidebar-border/60 bg-muted/40',
        Icon: CheckCircle2,
      }
    case 'expiring':
      return {
        label: 'Expiring soon',
        dot: 'bg-amber-500',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-500/40 bg-amber-500/5',
        Icon: AlertTriangle,
      }
    case 'stalled':
      return {
        label: 'Watcher stopped',
        dot: 'bg-amber-500',
        text: 'text-amber-600 dark:text-amber-400',
        border: 'border-amber-500/40 bg-amber-500/5',
        Icon: AlertTriangle,
      }
    case 'expired':
      return {
        label: 'Credential expired',
        dot: 'bg-red-500',
        text: 'text-red-600 dark:text-red-400',
        border: 'border-red-500/40 bg-red-500/5',
        Icon: ShieldOff,
      }
    case 'logged-out':
      return {
        label: 'Signed out',
        dot: 'bg-red-500',
        text: 'text-red-600 dark:text-red-400',
        border: 'border-red-500/40 bg-red-500/5',
        Icon: ShieldOff,
      }
    default:
      return {
        label: 'Not set up',
        dot: 'bg-muted-foreground/50',
        text: 'text-muted-foreground',
        border: 'border-sidebar-border/60 bg-muted/40',
        Icon: PlugZap,
      }
  }
}

/** The fix the user should apply, by state — shown in the tooltip. */
function hintFor(state: AutoAgentState): string | null {
  switch (state) {
    case 'expired':
    case 'logged-out':
      return 'Run `auto-agent-ai login` in a terminal, then re-check.'
    case 'stalled':
      return 'The watcher exited — run `auto-agent-ai login` to restart it.'
    case 'not-installed':
      return 'Claude runs will use whatever credential the `claude` CLI already has.'
    default:
      return null
  }
}

export function AutoAgentStatusIndicator({ collapsed }: { collapsed: boolean }) {
  const { notify } = useNotifications()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['auto-agent-status'],
    queryFn: getAutoAgentStatus,
    refetchInterval: POLL_MS,
    // Keep polling in a background tab: a run started here can outlive the tab's
    // focus, and the drop is exactly what we want to catch while unattended.
    refetchIntervalInBackground: true,
  })

  // Announce transitions, not the standing state — a toast on every poll would be
  // noise. `null` until the first reading, so a fresh page load doesn't announce a
  // problem that was already there before it opened.
  const prev = useRef<AutoAgentState | null>(null)
  useEffect(() => {
    if (!data) return
    const before = prev.current
    prev.current = data.state
    if (before === null || before === data.state) return

    if (data.state === 'connected') {
      toast.success('Auto Agent reconnected', { description: data.message })
      notify({ kind: 'success', title: 'Auto Agent reconnected', description: data.message })
      return
    }
    // Anything else is a drop from a previously-known state — tell the user, and
    // make it sticky (no auto-dismiss) since AI features are broken until fixed.
    const failing = data.state === 'expired' || data.state === 'logged-out'
    const title = failing ? 'Auto Agent disconnected' : 'Auto Agent needs attention'
    const description = [data.message, hintFor(data.state)].filter(Boolean).join(' ')
    if (failing) toast.error(title, { description, duration: Infinity })
    else toast.warning(title, { description })
    notify({ kind: failing ? 'error' : 'warning', title, description })
  }, [data, notify])

  const status: AutoAgentStatus | undefined = data
  const state: AutoAgentState = isError ? 'not-installed' : (status?.state ?? 'connected')
  const look = lookFor(state)
  const hint = hintFor(state)

  const detail = (
    <div className="max-w-[16rem] space-y-1">
      <p className="font-medium">Auto Agent · {look.label}</p>
      {isError ? (
        <p className="text-xs">Could not read Auto Agent's status from the server.</p>
      ) : (
        <>
          {status?.message && <p className="text-xs">{status.message}</p>}
          {status?.lastError && <p className="text-xs opacity-80">Last error: {status.lastError}</p>}
          {hint && <p className="text-xs opacity-80">{hint}</p>}
        </>
      )}
    </div>
  )

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={`Auto Agent: ${look.label}`}
            className="flex size-9 items-center justify-center rounded-xl text-muted-foreground"
          >
            <span className="relative flex size-4 items-center justify-center">
              <look.Icon className={cn('size-4', look.text)} />
              {!status?.ok && !isLoading && (
                <span
                  className={cn(
                    'absolute -right-0.5 -top-0.5 size-1.5 rounded-full ring-2 ring-sidebar',
                    look.dot,
                  )}
                  aria-hidden
                />
              )}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">{detail}</TooltipContent>
      </Tooltip>
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className={cn('rounded-2xl border px-2 py-1.5 transition-colors', look.border)}>
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-sidebar-border/60 bg-background">
              <look.Icon className={cn('size-3.5', look.text)} />
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate font-medium text-foreground">Auto Agent AI</span>
              <span className={cn('flex items-center gap-1 text-[10px]', look.text)}>
                {isLoading ? (
                  <>
                    <Loader2 className="size-2.5 animate-spin" /> Checking…
                  </>
                ) : (
                  <>
                    <span className={cn('size-1.5 rounded-full', look.dot)} aria-hidden />
                    {look.label}
                  </>
                )}
              </span>
            </span>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">{detail}</TooltipContent>
    </Tooltip>
  )
}
