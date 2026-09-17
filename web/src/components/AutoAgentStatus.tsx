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
  claudeUsage,
  getAutoAgentUsage,
  getClaudeTokenUsage,
  cancelAutoAgentLogin,
  getAutoAgentLogin,
  getAutoAgentStatus,
  startAutoAgentLogin,
  type AutoAgentLoginJob,
  type AutoAgentState,
  type AutoAgentStatus,
  type AutoAgentUsageBucket,
} from '@/lib/api'

/**
 * Sidebar indicator for the company's **Auto Agent** CLI (`auto-agent-ai`), which
 * distributes the shared Claude Code credential. Every QC run, test-case generation
 * and Ask-AI call ultimately shells out to `claude`, so when Auto Agent logs out or
 * the credential lapses, all of that starts failing with confusing mid-run auth
 * errors. This puts the state where it's always visible — directly above Release
 * notes — and raises a toast + bell notification the moment it drops, so nobody
 * discovers it halfway through a run.
 *
 * What "healthy" means is the credential, not a process: CLI 1.1.20 removed the
 * detached watcher the earlier versions left running, so there is nothing to probe
 * for any more (see `server/src/autoAgent.ts`).
 *
 * Polled (not pushed): the server check is a filesystem read, cheap enough to run
 * every 30s and needs no socket.
 *
 * Clicking it opens `AutoAgentPanel`, which can also CONNECT and DISCONNECT — the CLI
 * used to mean an open terminal window parked on `auto-agent-ai login` forever. It
 * doesn't have to: the sign-in is a loopback OAuth flow, and with a piped stdin the
 * CLI pulls the credential and exits instead of holding a countdown screen open, so
 * the server can run it and the browser step happens in a normal tab (see
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
 * The CLI's own number formatting (1.58M, 266.6K, 996), so the dialog reads exactly like
 * the box `auto-agent-ai login` prints and the two can be compared at a glance.
 */
function cliTokens(n: number): string {
  if (n < 1e3) return String(n)
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 2 : 1)}K`
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`
}

/** `claude-opus-4-8-20260101` -> `opus-4-8`: the date stamp is noise in a chip. */
function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function TokenCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-xs tabular-nums">{cliTokens(value)}</span>
    </div>
  )
}

/**
 * Today's token usage for the whole MACHINE, the box `auto-agent-ai login` shows. Read
 * from Claude Code's transcripts server-side (`claudeTokenUsage.ts`), so it includes the
 * terminal and the IDE, not just the portal — which is why it sits above the portal's
 * own breakdown rather than replacing it.
 */
function MachineTokenUsage({ open }: { open: boolean }) {
  const queryClient = useQueryClient()
  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: ['claude-token-usage'],
    queryFn: () => getClaudeTokenUsage(),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  })
  const refresh = useMutation({
    mutationFn: () => getClaudeTokenUsage(true),
    onSuccess: (fresh) => queryClient.setQueryData(['claude-token-usage'], fresh),
    onError: (err: Error) => toast.error('Could not read token usage', { description: err.message }),
  })

  return (
    <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">Token usage · today</p>
          <p className="truncate text-[10px] text-muted-foreground">
            Every Claude session on this machine{data ? ` · ${data.date} (UTC+7)` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          aria-label="Re-scan token usage"
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={cn('size-3.5', (refresh.isPending || isFetching) && 'animate-spin')} />
        </button>
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Scanning Claude transcripts…
        </p>
      ) : isError || !data ? (
        <p className="text-xs text-muted-foreground">Could not read today's token usage.</p>
      ) : (
        <>
          <p className="text-2xl font-semibold tabular-nums tracking-tight">
            {cliTokens(data.billableTokens)}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">billable tokens</span>
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl border border-border/60 bg-background/60 px-3 py-2">
            <TokenCell label="Input" value={data.inputTokens} />
            <TokenCell label="Output" value={data.outputTokens} />
            <TokenCell label="Cache create" value={data.cacheCreationTokens} />
            <TokenCell label="Cache read" value={data.cacheReadTokens} />
          </div>
          {data.models.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.models.map((m) => (
                <span
                  key={m.model}
                  title={m.model}
                  className="rounded-xl border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] tabular-nums"
                >
                  <span className="font-medium">{shortModel(m.model)}</span>{' '}
                  <span className="text-muted-foreground">
                    {cliTokens(m.inputTokens + m.outputTokens + m.cacheCreationTokens)}
                  </span>
                </span>
              ))}
            </div>
          )}
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Billable = input + output + cache create; cache reads are listed but not counted.
            Same figures as the box <code className="font-mono">auto-agent-ai login</code> prints.
          </p>
        </>
      )}
    </div>
  )
}

/** 17416861 -> "17.4M". Token counts span five orders of magnitude on one screen. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
  return String(n)
}

function usd(n: number): string {
  return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`
}

/** Source keys are code identifiers (`grounding-testcases`); show them as words. */
function sourceLabel(key: string): string {
  const named: Record<string, string> = {
    'qc-run': 'QC runs',
    chat: 'Chat',
    'mcp-test': 'MCP tests',
    'api-ai-check': 'API AI checks',
    testcase: 'Test-case generation',
    'db-ask': 'Database · Ask AI',
    schedule: 'Scheduled tasks',
  }
  if (named[key]) return named[key]
  const text = key.replace(/-/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const PERIODS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const

function UsageStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/60 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums tracking-tight">{value}</p>
      {sub && <p className="truncate text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function BreakdownRow({ bucket, max, label }: { bucket: AutoAgentUsageBucket; max: number; label: string }) {
  const total = bucket.inputTokens + bucket.outputTokens
  return (
    <div className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {compact(total)} · {bucket.calls} {bucket.calls === 1 ? 'call' : 'calls'} · {usd(bucket.costUsd)}
        </span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-foreground/70"
          style={{ width: `${max > 0 ? Math.max(2, (total / max) * 100) : 0}%` }}
        />
      </div>
    </div>
  )
}

/**
 * How much the shared credential is being used. Two different sources, kept apart on
 * purpose: the subscription LIMITS are the credential's own (Claude's `/usage`, every
 * consumer of it counted), while the token numbers are only what THIS portal spent —
 * recorded per `claude` call in `usage_events`. Blending them would claim a precision
 * neither has. The dollar figure is the API-equivalent price the CLI reports, not a bill:
 * a subscription credential isn't charged per token.
 */
function AutoAgentUsageSection({ open }: { open: boolean }) {
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const usage = useQuery({
    queryKey: ['auto-agent-usage', days],
    queryFn: () => getAutoAgentUsage(days),
    enabled: open,
    refetchInterval: open ? 30_000 : false,
  })
  // Server-cached for 10 minutes, so opening the dialog doesn't spawn `claude` each time.
  const limits = useQuery({
    queryKey: ['claude-usage'],
    queryFn: claudeUsage,
    enabled: open,
    staleTime: 5 * 60_000,
  })

  const data = usage.data
  const peakDay = Math.max(0, ...(data?.daily ?? []).map((d) => d.inputTokens + d.outputTokens))
  const topSources = (data?.bySource ?? []).slice(0, 6)
  const maxSource = topSources[0] ? topSources[0].inputTokens + topSources[0].outputTokens : 0

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">Portal usage</p>
        <div className="flex rounded-full border border-border/60 bg-background/60 p-0.5">
          {PERIODS.map((p) => (
            <button
              key={p.days}
              type="button"
              onClick={() => setDays(p.days)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
                days === p.days
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {limits.data?.available && (
        <div className="space-y-2">
          {limits.data.windows.map((w) => (
            <div key={w.label} className="space-y-0.5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate">{w.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {w.percent}% · resets {w.reset}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    w.percent >= 90 ? 'bg-red-500' : w.percent >= 70 ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                  style={{ width: `${Math.min(100, w.percent)}%` }}
                />
              </div>
            </div>
          ))}
          {limits.data.stale && (
            <p className="text-[10px] text-muted-foreground">Limits are from the last good reading.</p>
          )}
        </div>
      )}

      {usage.isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> Reading usage…
        </p>
      ) : usage.isError || !data ? (
        <p className="text-xs text-muted-foreground">Could not read token usage from the server.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <UsageStat label="Calls" value={String(data.totals.calls)} />
            <UsageStat label="Input" value={compact(data.totals.inputTokens)} sub="incl. cache" />
            <UsageStat label="Output" value={compact(data.totals.outputTokens)} />
            <UsageStat label="≈ Cost" value={usd(data.totals.costUsd)} sub="API-equivalent" />
          </div>

          {data.days > 1 && (
            <div>
              <div className="flex h-12 items-end gap-0.5">
                {data.daily.map((d) => {
                  const total = d.inputTokens + d.outputTokens
                  return (
                    <Tooltip key={d.key}>
                      <TooltipTrigger asChild>
                        <div className="flex h-full flex-1 items-end">
                          <div
                            className={cn(
                              'w-full rounded-[2px]',
                              total > 0 ? 'bg-foreground/60 hover:bg-foreground' : 'bg-muted',
                            )}
                            style={{
                              height: `${peakDay > 0 ? (total / peakDay) * 100 : 0}%`,
                              minHeight: total > 0 ? 3 : 1,
                            }}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent>
                        {new Date(`${d.key}T00:00:00`).toLocaleDateString(undefined, {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                        : {compact(total)} tokens · {d.calls} calls · {usd(d.costUsd)}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
                <span>{new Date(data.since).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span>
                <span>Today</span>
              </div>
            </div>
          )}

          {topSources.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">By feature</p>
              {topSources.map((b) => (
                <BreakdownRow key={b.key} bucket={b} max={maxSource} label={sourceLabel(b.key)} />
              ))}
              {data.bySource.length > topSources.length && (
                <p className="text-[10px] text-muted-foreground">
                  +{data.bySource.length - topSources.length} more features
                </p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No AI calls from the portal in this period.</p>
          )}

          {data.byModel.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.byModel.map((m) => (
                <span
                  key={m.key}
                  className="rounded-xl border border-border/60 bg-background/60 px-2 py-0.5 text-[11px] tabular-nums"
                >
                  <span className="font-medium">{m.key}</span>{' '}
                  <span className="text-muted-foreground">
                    {compact(m.inputTokens + m.outputTokens)} · {usd(m.costUsd)}
                  </span>
                </span>
              ))}
            </div>
          )}

          <p className="text-[10px] leading-relaxed text-muted-foreground">
            Counts only calls this portal made
            {data.lastCallAt ? ` (last call ${relative(data.lastCallAt)})` : ''}. Your terminal and
            other machines on the same credential are not included
            {limits.data?.available ? ' — the limit bars above are.' : '.'}
          </p>
        </>
      )}
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
        description: 'The shared Claude credential was removed from this machine.',
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
      toast.success('Auto Agent connected', { description: 'The shared Claude credential was pulled.' })
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
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
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
              <Field label="CLI" value={status?.cliPath ?? 'Not installed on this machine'} />
              {status?.lastError && (
                <p className="pt-1 text-xs text-amber-600 dark:text-amber-400">
                  Last error: {status.lastError}
                </p>
              )}
            </>
          )}
        </div>

        {status?.state !== 'not-installed' && (
          <>
            <MachineTokenUsage open={open} />
            <AutoAgentUsageSection open={open} />
          </>
        )}

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
