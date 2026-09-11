import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  LogOut,
  PlugZap,
  RefreshCw,
  ShieldOff,
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
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNotifications } from '@/lib/notifications'
import {
  answerAutoAgentLogin,
  autoAgentLogout,
  cancelAutoAgentLogin,
  getAutoAgentLogin,
  getAutoAgentStatus,
  startAutoAgentLogin,
  type AutoAgentLoginJob,
  type AutoAgentState,
  type AutoAgentStatus,
} from '@/lib/api'

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
 *
 * Clicking it opens `AutoAgentPanel`, which can also CONNECT and DISCONNECT — the CLI
 * used to mean an open terminal window parked on `auto-agent-ai login` forever. It
 * doesn't have to: the sign-in is a loopback OAuth flow and the credential watcher is
 * detached, so the server can run it and the browser step happens in a normal tab (see
 * `server/src/autoAgentCli.ts`).
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
      return 'Click to connect — the portal runs the sign-in for you.'
    case 'stalled':
      return 'The watcher exited — click to connect again and restart it.'
    case 'not-installed':
      return 'Claude runs will use whatever credential the `claude` CLI already has.'
    default:
      return null
  }
}

/** "in 2 h 40 m" / "3 min ago" — an ISO stamp tells a QC engineer nothing at a glance. */
function relative(iso: string | null): string | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  const mins = Math.round(Math.abs(ms) / 60_000)
  const text = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`
  return ms >= 0 ? `in ${text}` : `${text} ago`
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-xs font-medium">{value}</span>
    </div>
  )
}

/**
 * Connect / disconnect Auto Agent from inside the portal.
 *
 * The sign-in is a server-side JOB that this panel polls, not a request it awaits: the
 * Microsoft step happens in a browser tab the CLI opens, which can take a minute, and a
 * closed dialog (or a reloaded page) must not abandon a sign-in that is already half
 * done. Same reason ticket crawling and test-case generation are polled jobs.
 */
function AutoAgentPanel({
  open,
  onOpenChange,
  status,
  isError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: AutoAgentStatus | undefined
  isError: boolean
}) {
  const queryClient = useQueryClient()
  const [answer, setAnswer] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  const { data: job } = useQuery({
    queryKey: ['auto-agent-login'],
    queryFn: getAutoAgentLogin,
    enabled: open,
    // Only while something is happening: a finished job is a static record.
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 1000 : false),
  })
  const running = job?.state === 'running'

  const refreshStatus = () => void queryClient.invalidateQueries({ queryKey: ['auto-agent-status'] })

  const connect = useMutation({
    mutationFn: startAutoAgentLogin,
    onSuccess: (started) => {
      queryClient.setQueryData(['auto-agent-login'], started)
      toast.info('Signing in to Auto Agent', {
        description: 'Complete the Microsoft sign-in in the browser tab that just opened.',
      })
    },
    onError: (err: Error) => toast.error('Could not start the sign-in', { description: err.message }),
  })
  const cancel = useMutation({
    mutationFn: cancelAutoAgentLogin,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['auto-agent-login'] }),
  })
  const reply = useMutation({
    mutationFn: answerAutoAgentLogin,
    onSuccess: () => {
      setAnswer('')
      void queryClient.invalidateQueries({ queryKey: ['auto-agent-login'] })
    },
    onError: (err: Error) => toast.error('Could not send that answer', { description: err.message }),
  })
  const disconnect = useMutation({
    mutationFn: autoAgentLogout,
    onSuccess: () => {
      setConfirmDisconnect(false)
      toast.success('Auto Agent disconnected', {
        description: 'The watcher was stopped and the shared Claude credential removed.',
      })
      refreshStatus()
      void queryClient.invalidateQueries({ queryKey: ['auto-agent-login'] })
    },
    onError: (err: Error) => toast.error('Could not disconnect', { description: err.message }),
  })

  // Announce the OUTCOME once, when the job stops running. The status poll is what
  // proves it worked, so the sidebar is re-read here rather than trusting exit 0.
  const lastJobState = useRef<AutoAgentLoginJob['state'] | null>(null)
  useEffect(() => {
    if (!job) return
    const before = lastJobState.current
    lastJobState.current = job.state
    if (before !== 'running' || job.state === 'running') return
    if (job.state === 'succeeded') {
      toast.success('Auto Agent connected', { description: 'The credential watcher is running.' })
    } else if (job.state === 'failed') {
      toast.error('Auto Agent sign-in failed', { description: job.error ?? undefined })
    }
    refreshStatus()
    // `job` is the only trigger: refreshStatus is a fresh closure every render, so
    // depending on it would re-run this effect on every render instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job])

  const installed = status?.cliPath != null
  const connected = status?.state === 'connected'
  const expiry = relative(status?.expiresAt ?? null)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Auto Agent AI</DialogTitle>
          <DialogDescription>
            The company CLI that supplies the shared Claude credential every run, chat and
            AI feature here depends on.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/40 p-3">
          {isError ? (
            <p className="text-xs text-muted-foreground">
              Could not read Auto Agent's status from the server.
            </p>
          ) : (
            <>
              <p className="text-xs">{status?.message}</p>
              {status?.username && <Field label="Signed in as" value={status.username} />}
              {status?.serverUrl && <Field label="Server" value={status.serverUrl} />}
              {status?.role && <Field label="Role" value={status.role} />}
              {expiry && (
                <Field
                  label="Credential expires"
                  value={`${expiry} (${new Date(status!.expiresAt!).toLocaleTimeString()})`}
                />
              )}
              <Field label="Watcher" value={status?.watcherRunning ? 'Running' : 'Not running'} />
              <Field label="CLI" value={status?.cliPath ?? 'Not installed on this machine'} />
              {status?.lastError && (
                <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
                  Last error: {status.lastError}
                </p>
              )}
            </>
          )}
        </div>

        {/* The live sign-in. The CLI opens the browser itself; the URL is here for the
            case where it can't (no default browser, or the tab was closed by mistake) —
            without it a failed hand-off is a five-minute silent timeout. */}
        {job && (running || job.state === 'failed') && (
          <div className="space-y-2 rounded-2xl border border-border/60 p-3">
            <p className="flex items-center gap-2 text-xs font-medium">
              {running ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Waiting for the Microsoft
                  sign-in…
                </>
              ) : (
                <>
                  <AlertTriangle className="size-3.5 text-red-500" /> Sign-in failed
                </>
              )}
            </p>
            {job.error && <p className="text-xs text-muted-foreground">{job.error}</p>}
            {running && job.signInUrl && (
              <Button variant="outline" size="sm" className="w-full" asChild>
                <a href={job.signInUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-3.5" /> Open the sign-in page
                </a>
              </Button>
            )}
            {/* Only asked when several AI sessions are assigned. The CLI prints a numbered
                list; with a piped stdin it reads the choice as a plain line, which is the
                only reason a web form can answer it at all. */}
            {running && job.awaitingAnswer && (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (answer.trim()) reply.mutate(answer.trim())
                }}
              >
                <Input
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  placeholder="Type the number of the session to use"
                  className="h-8 text-xs"
                />
                <Button type="submit" size="sm" disabled={!answer.trim() || reply.isPending}>
                  Send
                </Button>
              </form>
            )}
            {job.lines.length > 0 && (
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-muted/60 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                {job.lines.join('\n')}
              </pre>
            )}
            {running && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                Cancel sign-in
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => connect.mutate()}
            disabled={!installed || running || connect.isPending || disconnect.isPending}
          >
            {running || connect.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : connected ? (
              <RefreshCw className="size-4" />
            ) : (
              <PlugZap className="size-4" />
            )}
            {connected ? 'Reconnect' : 'Connect'}
          </Button>

          {/* Two-step: disconnecting stops every AI feature in the portal until someone
              signs in again, which is not something to do on a mis-click. */}
          {confirmDisconnect ? (
            <>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
              >
                {disconnect.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogOut className="size-4" />
                )}
                Yes, disconnect
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(false)}>
                Keep it
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDisconnect(true)}
              disabled={!installed || status?.state === 'not-installed' || running}
            >
              <LogOut className="size-4" /> Disconnect
            </Button>
          )}

          <Button variant="ghost" size="sm" className="ml-auto" onClick={refreshStatus}>
            <RefreshCw className="size-4" /> Re-check
          </Button>
        </div>

        {!installed && (
          <p className="text-xs text-muted-foreground">
            No <code className="font-mono">auto-agent-ai</code> on this machine, so there is
            nothing to connect to. Install it (or point{' '}
            <code className="font-mono">QC_AUTO_AGENT_BIN</code> at it) and re-check — Claude
            runs meanwhile use whatever credential the <code className="font-mono">claude</code>{' '}
            CLI already has.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function AutoAgentStatusIndicator({ collapsed }: { collapsed: boolean }) {
  const { notify } = useNotifications()
  const [panelOpen, setPanelOpen] = useState(false)
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
          <p className="text-xs opacity-70">Click to connect, disconnect or re-check.</p>
        </>
      )}
    </div>
  )

  const panel = (
    <AutoAgentPanel
      open={panelOpen}
      onOpenChange={setPanelOpen}
      status={status}
      isError={isError}
    />
  )

  if (collapsed) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => setPanelOpen(true)}
              aria-label={`Auto Agent: ${look.label} — open the connection panel`}
              className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-sidebar-accent"
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
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{detail}</TooltipContent>
        </Tooltip>
        {panel}
      </>
    )
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            aria-label={`Auto Agent: ${look.label} — open the connection panel`}
            /* A CHECKLIST LINE, not a card. This lives inside the footer's status
               card next to "Up to date", and the two have to read as the same kind
               of statement — icon, one sentence, colour carrying the verdict. The
               old bordered card with its own 28px chip competed with the nav. */
            className="flex h-6 w-full items-center gap-1.5 rounded-md px-1.5 text-left transition-colors hover:bg-muted"
          >
            {isLoading ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <look.Icon className={cn('size-3 shrink-0', look.text)} />
            )}
            {/* Healthy is QUIET — the icon carries "fine", and only a problem gets
                the coloured sentence. Two green lines stacked in a footer read as a
                success banner, and then a real drop no longer stands out. */}
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[11px] font-medium',
                status?.ok ? 'text-muted-foreground' : look.text,
              )}
            >
              Auto Agent · {isLoading ? 'Checking…' : look.label}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{detail}</TooltipContent>
      </Tooltip>
      {panel}
    </>
  )
}
