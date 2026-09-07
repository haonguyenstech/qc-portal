import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Globe,
  KeyRound,
  Loader2,
  Lock,
  Power,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  clearRemotePassword,
  getRemoteOverview,
  revokeRemoteSessions,
  saveRemoteAccessOptions,
  saveTunnelSettings,
  setRemotePassword,
  startTunnel,
  stopTunnel,
  type RemoteOverview,
  type TunnelMode,
  type TunnelState,
} from '@/lib/api'

/**
 * Settings → Remote access. One click publishes the portal to a public hostname over
 * a Cloudflare Tunnel, one click takes it back down.
 *
 * The page is deliberately ordered gate-first: the access password sits ABOVE the
 * tunnel setup and the Publish button stays disabled until it exists, because the
 * portal spawns `claude` with bypassed permissions and hands out a shell — a public
 * URL without a password is not a convenience, it is remote code execution. See
 * `server/src/remoteAccess.ts` and `docs/architecture/remote-access.md`.
 */
export default function RemoteAccessPage() {
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ['remote'],
    queryFn: getRemoteOverview,
    // Poll hard while cloudflared is dialing the edge (that wait is the edge's, not
    // ours), and gently once it is up so a dropped connection shows within seconds.
    refetchInterval: (q) => {
      const state = q.state.data?.status.state
      if (state === 'starting' || state === 'stopping') return 1_000
      if (state === 'running') return 5_000
      return false
    },
  })

  const data = query.data
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['remote'] })

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 sm:p-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Remote access</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Publish this portal to a public HTTPS address through a Cloudflare Tunnel, so you can run
          and review QC work from another machine or a phone. Nothing is opened on your network —
          cloudflared dials out, and the portal keeps listening on localhost only.
        </p>
      </div>

      {data?.viewingRemotely && (
        <Notice tone="amber" icon={<Globe className="h-4 w-4" />}>
          You are viewing this page <strong>through the tunnel</strong>. Publishing, the access
          password and the terminal switch can only be changed on the portal machine itself — you can
          still stop publishing from here.
        </Notice>
      )}

      {query.isError && (
        <Notice tone="red" icon={<XCircle className="h-4 w-4" />}>
          Could not read the remote-access status:{' '}
          {query.error instanceof Error ? query.error.message : 'request failed'}
        </Notice>
      )}

      {!data ? (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </CardContent>
        </Card>
      ) : (
        <>
          <PublishCard data={data} onChanged={refresh} />
          <AccessGateCard data={data} onChanged={refresh} />
          {/* Keyed on updatedAt so a save (or another tab's save) re-seeds the form
              from the server instead of an effect writing state back into it. */}
          <TunnelSetupCard key={data.settings.updatedAt} data={data} onChanged={refresh} />
          <ActivityLogCard data={data} />
        </>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ shared bits

function Notice(props: { tone: 'amber' | 'red' | 'emerald'; icon: ReactNode; children: ReactNode }) {
  const tone = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200',
    red: 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200',
    emerald:
      'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-200',
  }[props.tone]
  return (
    <div className={cn('flex items-start gap-2.5 rounded-2xl border px-3.5 py-3 text-sm', tone)}>
      <span className="mt-0.5 shrink-0">{props.icon}</span>
      <div className="min-w-0 leading-snug">{props.children}</div>
    </div>
  )
}

function SectionCard(props: {
  icon: ReactNode
  title: string
  description: string
  badge?: ReactNode
  children: ReactNode
}) {
  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            {props.icon}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">{props.title}</h2>
              {props.badge}
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">{props.description}</p>
          </div>
        </div>
        {props.children}
      </CardContent>
    </Card>
  )
}

/** An On/Off pill, matching the Settings → Models rows (the portal has no Switch primitive). */
function TogglePill(props: { on: boolean; busy?: boolean; disabled?: boolean; onToggle: () => void }) {
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={props.busy || props.disabled}
      onClick={props.onToggle}
      className={cn(
        'h-8 w-[68px] shrink-0 rounded-full px-3 text-xs transition-all duration-200 active:scale-[0.98]',
        props.on
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/50 dark:text-emerald-300'
          : 'text-muted-foreground',
      )}
    >
      {props.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : props.on ? 'On' : 'Off'}
    </Button>
  )
}

function OptionRow(props: {
  icon: ReactNode
  title: string
  description: string
  control: ReactNode
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/60 px-3 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
        {props.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold tracking-tight">{props.title}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{props.description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{props.control}</div>
    </div>
  )
}

const STATE_LABEL: Record<TunnelState, string> = {
  stopped: 'Not published',
  starting: 'Publishing…',
  running: 'Live',
  stopping: 'Stopping…',
  error: 'Failed',
}

// ------------------------------------------------------------------ publish

function PublishCard({ data, onChanged }: { data: RemoteOverview; onChanged: () => void }) {
  const { status, settings, viewingRemotely } = data
  const [copied, setCopied] = useState(false)

  const publish = useMutation({
    mutationFn: startTunnel,
    onSuccess: () => {
      toast.success('Publishing…', { description: 'Waiting for Cloudflare to register the tunnel.' })
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not publish', {
        description: err instanceof Error ? err.message : 'Start failed',
      }),
  })

  const unpublish = useMutation({
    mutationFn: stopTunnel,
    onSuccess: () => {
      toast.success('Stopped', { description: 'The portal is no longer reachable from outside.' })
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not stop', {
        description: err instanceof Error ? err.message : 'Stop failed',
      }),
  })

  const up = status.state === 'running' || status.state === 'starting' || status.state === 'stopping'

  /** Every reason the Publish button might refuse, worst-blocking first. */
  const blockers = useMemo(() => {
    const list: { label: string; hint: string }[] = []
    if (!status.hasAccessPassword) {
      list.push({
        label: 'No access password',
        hint: 'Set one below — the tunnel will not start without it.',
      })
    }
    if (!status.installed) {
      list.push({ label: 'cloudflared not installed', hint: status.installHint })
    }
    if (settings.mode === 'token' && !settings.hasToken) {
      list.push({ label: 'No connector token', hint: 'Paste the token from Cloudflare below.' })
    }
    if (settings.mode !== 'quick' && !settings.hostname) {
      list.push({ label: 'No public hostname', hint: 'Enter the hostname routed to this tunnel.' })
    }
    if (settings.mode === 'named' && !settings.tunnelName) {
      list.push({ label: 'No tunnel name', hint: 'Enter the name `cloudflared tunnel list` shows.' })
    }
    return list
  }, [status, settings])

  const copy = async () => {
    if (!status.url) return
    try {
      await navigator.clipboard.writeText(status.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy the URL')
    }
  }

  return (
    <SectionCard
      icon={<Globe className="h-5 w-5" />}
      title="Public address"
      description={`Forwards ${status.target} to a Cloudflare hostname. cloudflared connects outbound, so no port is opened on your router.`}
      badge={
        <Badge
          variant="secondary"
          className={cn(
            'gap-1.5 font-medium',
            status.state === 'running' &&
              'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
            status.state === 'error' &&
              'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
            (status.state === 'starting' || status.state === 'stopping') &&
              'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
          )}
        >
          {status.state === 'starting' || status.state === 'stopping' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : status.state === 'running' ? (
            <span className="size-2 rounded-full bg-emerald-500" />
          ) : status.state === 'error' ? (
            <XCircle className="h-3 w-3" />
          ) : (
            <span className="size-2 rounded-full bg-muted-foreground/50" />
          )}
          {STATE_LABEL[status.state]}
        </Badge>
      }
    >
      {status.state === 'running' && status.url && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-3 py-2.5 dark:border-emerald-900/60 dark:bg-emerald-950/40">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-emerald-900 dark:text-emerald-200">
            {status.url}
          </code>
          <Button size="sm" variant="outline" className="h-8 rounded-full text-xs" onClick={copy}>
            {copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button size="sm" variant="outline" className="h-8 rounded-full text-xs" asChild>
            <a href={status.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="h-3.5 w-3.5" /> Open
            </a>
          </Button>
        </div>
      )}

      {status.state === 'error' && status.error && (
        <Notice tone="red" icon={<XCircle className="h-4 w-4" />}>
          {status.error}
        </Notice>
      )}

      {status.state === 'starting' && (
        <p className="rounded-2xl border border-border/60 bg-muted/60 px-3 py-2.5 text-sm text-muted-foreground">
          {settings.mode === 'quick'
            ? 'Asking Cloudflare for a trycloudflare.com hostname…'
            : `Connecting to Cloudflare and registering ${settings.hostname || 'the hostname'}…`}
          {status.restarts > 0 && ` (reconnect attempt ${status.restarts})`}
        </p>
      )}

      {status.state === 'running' && (
        <Notice tone="emerald" icon={<ShieldCheck className="h-4 w-4" />}>
          Anyone opening that URL gets the unlock screen and must enter the access password before
          any portal page or API responds.
        </Notice>
      )}

      {!up && !status.uiBundled && (
        <Notice tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
          <code className="font-mono">web/dist</code> is missing, so this server has no UI to serve —
          a visitor would reach the API only. Run <code className="font-mono">npm run build</code>{' '}
          before publishing. (Under <code className="font-mono">npm run dev</code> the UI is served by
          Vite on another port, which the tunnel does not point at.)
        </Notice>
      )}

      {!up && blockers.length > 0 && (
        <div className="space-y-1.5">
          {blockers.map((b) => (
            <div
              key={b.label}
              className="flex items-start gap-2 rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 text-xs"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
              <span>
                <strong className="font-semibold">{b.label}.</strong>{' '}
                <span className="text-muted-foreground">{b.hint}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {up ? (
          <Button
            variant="destructive"
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
            disabled={unpublish.isPending}
            onClick={() => unpublish.mutate()}
          >
            {unpublish.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Power className="h-4 w-4" />
            )}
            Stop publishing
          </Button>
        ) : (
          <Button
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
            disabled={publish.isPending || blockers.length > 0 || viewingRemotely}
            onClick={() => publish.mutate()}
          >
            {publish.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Globe className="h-4 w-4" />
            )}
            Publish to the internet
          </Button>
        )}
        {status.state === 'running' && status.mode === 'quick' && (
          <span className="text-xs text-muted-foreground">
            Quick tunnel — this address changes every time you publish.
          </span>
        )}
      </div>
    </SectionCard>
  )
}

// ------------------------------------------------------------------ the access gate

function AccessGateCard({ data, onChanged }: { data: RemoteOverview; onChanged: () => void }) {
  const { access, status, viewingRemotely } = data
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const locked = viewingRemotely

  const savePassword = useMutation({
    mutationFn: () => setRemotePassword(password),
    onSuccess: () => {
      setPassword('')
      setConfirm('')
      toast.success('Access password saved', {
        description: 'Any device that was already unlocked has to enter it again.',
      })
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not save the password', {
        description: err instanceof Error ? err.message : 'Save failed',
      }),
  })

  const removePassword = useMutation({
    mutationFn: clearRemotePassword,
    onSuccess: () => {
      toast.success('Access password removed', { description: 'Remote access is now disabled.' })
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not remove the password', {
        description: err instanceof Error ? err.message : 'Remove failed',
      }),
  })

  const saveOptions = useMutation({
    mutationFn: saveRemoteAccessOptions,
    onSuccess: () => {
      toast.success('Remote access updated')
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : 'Update failed',
      }),
  })

  const revoke = useMutation({
    mutationFn: revokeRemoteSessions,
    onSuccess: () => {
      toast.success('All remote sessions signed out')
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not sign sessions out', {
        description: err instanceof Error ? err.message : 'Failed',
      }),
  })

  const tooShort = password.length > 0 && password.length < access.minPasswordLength
  const mismatch = confirm.length > 0 && confirm !== password
  const canSave = !locked && password.length >= access.minPasswordLength && confirm === password

  return (
    <SectionCard
      icon={<KeyRound className="h-5 w-5" />}
      title="Access password"
      description="The gate in front of the tunnel. Requests arriving through Cloudflare get one unlock screen and nothing else until this password is entered — no page, no API, no WebSocket."
      badge={
        <Badge
          variant="secondary"
          className={cn(
            'gap-1.5 font-medium',
            access.hasPassword
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300'
              : 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
          )}
        >
          {access.hasPassword ? <ShieldCheck className="h-3 w-3" /> : <AlertTriangle className="h-3 w-3" />}
          {access.hasPassword ? 'Set' : 'Not set'}
        </Badge>
      }
    >
      {!access.hasPassword && (
        <Notice tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
          The portal can run shell commands, spawn Claude with permissions bypassed and read your
          project files. A public URL with no password would hand all of that to anyone who finds it,
          so publishing stays disabled until you set one.
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="remote-pw" className="text-xs text-muted-foreground">
            {access.hasPassword ? 'New password' : 'Password'}
          </Label>
          <Input
            id="remote-pw"
            type="password"
            autoComplete="new-password"
            placeholder={`At least ${access.minPasswordLength} characters`}
            value={password}
            disabled={locked}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-xl"
          />
          {tooShort && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              At least {access.minPasswordLength} characters.
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="remote-pw2" className="text-xs text-muted-foreground">
            Repeat
          </Label>
          <Input
            id="remote-pw2"
            type="password"
            autoComplete="new-password"
            value={confirm}
            disabled={locked}
            onChange={(e) => setConfirm(e.target.value)}
            className="rounded-xl"
          />
          {mismatch && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">
              The two entries do not match.
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="rounded-full transition-all duration-200 active:scale-[0.98]"
          disabled={!canSave || savePassword.isPending}
          onClick={() => savePassword.mutate()}
        >
          {savePassword.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          {access.hasPassword ? 'Replace password' : 'Set password'}
        </Button>
        {access.hasPassword && (
          <>
            <Button
              variant="outline"
              className="rounded-full text-xs"
              disabled={revoke.isPending || locked}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Lock className="h-3.5 w-3.5" />
              )}
              Sign out all devices
            </Button>
            <Button
              variant="ghost"
              className="rounded-full text-xs text-muted-foreground"
              disabled={removePassword.isPending || locked || status.state !== 'stopped'}
              title={
                status.state !== 'stopped'
                  ? 'Stop publishing before removing the password.'
                  : undefined
              }
              onClick={() => removePassword.mutate()}
            >
              Remove password
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <OptionRow
          icon={<TerminalSquare className="h-4 w-4" />}
          title="Device terminal over the tunnel"
          description="Off by default. The Terminal page is a real shell on this machine — the shortest path from a leaked URL to a compromised laptop. Leave it off unless you actually need it remotely."
          control={
            <TogglePill
              on={access.allowTerminal}
              busy={saveOptions.isPending}
              disabled={locked}
              onToggle={() => saveOptions.mutate({ allowTerminal: !access.allowTerminal })}
            />
          }
        />
        <OptionRow
          icon={<Lock className="h-4 w-4" />}
          title="Stay unlocked for"
          description="How long a remote browser keeps its session before it has to enter the password again."
          control={
            <Select
              value={String(access.sessionHours)}
              disabled={locked || saveOptions.isPending}
              onValueChange={(v) => saveOptions.mutate({ sessionHours: Number(v) })}
            >
              <SelectTrigger className="h-8 w-[110px] rounded-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[1, 4, 12, 24, 72, 168].map((h) => (
                  <SelectItem key={h} value={String(h)} className="text-xs">
                    {h < 24 ? `${h} hour${h === 1 ? '' : 's'}` : `${h / 24} day${h === 24 ? '' : 's'}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
      </div>
    </SectionCard>
  )
}

// ------------------------------------------------------------------ tunnel setup

const MODE_COPY: Record<TunnelMode, { label: string; blurb: string }> = {
  quick: {
    label: 'Quick tunnel (no account)',
    blurb:
      'Cloudflare hands out a random *.trycloudflare.com address. Nothing to configure, but the address changes on every publish and Cloudflare gives it no uptime guarantee — best for a short session.',
  },
  token: {
    label: 'Your own domain (connector token)',
    blurb:
      'In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel, add a public hostname pointing at http://localhost:5174, then paste its connector token here. The address is fixed, and you can put Cloudflare Access in front of it for company SSO.',
  },
  named: {
    label: 'Named tunnel (already set up locally)',
    blurb:
      'Runs a tunnel you created with `cloudflared tunnel login` + `cloudflared tunnel create`. Needs ~/.cloudflared credentials on this machine and a DNS route for the hostname.',
  },
}

function TunnelSetupCard({ data, onChanged }: { data: RemoteOverview; onChanged: () => void }) {
  const { settings, status, viewingRemotely } = data
  const locked = viewingRemotely
  const live = status.state === 'running' || status.state === 'starting'

  const [mode, setMode] = useState<TunnelMode>(settings.mode)
  const [hostname, setHostname] = useState(settings.hostname)
  const [tunnelName, setTunnelName] = useState(settings.tunnelName)
  const [token, setToken] = useState('')

  const save = useMutation({
    mutationFn: () =>
      saveTunnelSettings({
        mode,
        hostname,
        tunnelName,
        // Absent means "keep the stored token" — the page never receives it, so it
        // must not send back a blank and wipe it.
        token: token.trim() ? token.trim() : undefined,
      }),
    onSuccess: () => {
      setToken('')
      toast.success('Tunnel settings saved', {
        description: live ? 'Stop and publish again to apply them.' : undefined,
      })
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : 'Save failed',
      }),
  })

  const toggles = useMutation({
    mutationFn: saveTunnelSettings,
    onSuccess: () => onChanged(),
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : 'Update failed',
      }),
  })

  const dropToken = useMutation({
    mutationFn: () => saveTunnelSettings({ token: null }),
    onSuccess: () => {
      toast.success('Connector token removed')
      onChanged()
    },
    onError: (err) =>
      toast.error('Could not remove the token', {
        description: err instanceof Error ? err.message : 'Failed',
      }),
  })

  const dirty =
    mode !== settings.mode ||
    hostname.trim() !== settings.hostname ||
    tunnelName.trim() !== settings.tunnelName ||
    token.trim().length > 0

  return (
    <SectionCard
      icon={<ShieldCheck className="h-5 w-5" />}
      title="Tunnel setup"
      description="How the public address is obtained. Change this while the tunnel is stopped — a running tunnel keeps the settings it started with."
      badge={
        status.installed ? (
          <Badge variant="secondary" className="font-mono text-[10px] font-normal">
            {status.binPath}
          </Badge>
        ) : (
          <Badge
            variant="secondary"
            className="bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
          >
            cloudflared missing
          </Badge>
        )
      }
    >
      {!status.installed && (
        <Notice tone="amber" icon={<AlertTriangle className="h-4 w-4" />}>
          {status.installHint} You can also point{' '}
          <code className="font-mono">QC_CLOUDFLARED_BIN</code> at the binary.
        </Notice>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Mode</Label>
        <Select
          value={mode}
          disabled={locked || live}
          onValueChange={(v) => setMode(v as TunnelMode)}
        >
          <SelectTrigger className="rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MODE_COPY) as TunnelMode[]).map((m) => (
              <SelectItem key={m} value={m}>
                {MODE_COPY[m].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-snug text-muted-foreground">{MODE_COPY[mode].blurb}</p>
      </div>

      {mode === 'token' && (
        <div className="space-y-1.5">
          <Label htmlFor="cf-token" className="text-xs text-muted-foreground">
            Connector token {settings.hasToken && <span className="text-emerald-600">• saved</span>}
          </Label>
          <Input
            id="cf-token"
            type="password"
            autoComplete="off"
            placeholder={settings.hasToken ? 'Saved — type to replace' : 'eyJhIjoi…'}
            value={token}
            disabled={locked || live}
            onChange={(e) => setToken(e.target.value)}
            className="rounded-xl font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            Stored beside the portal database with 0600 permissions, never in a project folder, and
            never sent back to this page.
            {settings.hasToken && (
              <button
                type="button"
                className="ml-1 underline disabled:opacity-50"
                disabled={locked || live || dropToken.isPending}
                onClick={() => dropToken.mutate()}
              >
                Remove it
              </button>
            )}
          </p>
        </div>
      )}

      {mode === 'named' && (
        <div className="space-y-1.5">
          <Label htmlFor="cf-name" className="text-xs text-muted-foreground">
            Tunnel name
          </Label>
          <Input
            id="cf-name"
            placeholder="qc-portal"
            value={tunnelName}
            disabled={locked || live}
            onChange={(e) => setTunnelName(e.target.value)}
            className="rounded-xl"
          />
        </div>
      )}

      {mode !== 'quick' && (
        <div className="space-y-1.5">
          <Label htmlFor="cf-host" className="text-xs text-muted-foreground">
            Public hostname
          </Label>
          <Input
            id="cf-host"
            placeholder="qc.example.com"
            value={hostname}
            disabled={locked || live}
            onChange={(e) => setHostname(e.target.value)}
            className="rounded-xl"
          />
          <p className="text-[11px] text-muted-foreground">
            Cloudflare decides the routing, so the portal cannot discover this — it is what the page
            shows you and links to.
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <OptionRow
          icon={<Power className="h-4 w-4" />}
          title="Publish when the portal starts"
          description="Re-open the tunnel automatically on boot, so the address is up without visiting this page."
          control={
            <TogglePill
              on={settings.autoStart}
              busy={toggles.isPending}
              disabled={locked}
              onToggle={() => toggles.mutate({ autoStart: !settings.autoStart })}
            />
          }
        />
        <OptionRow
          icon={<RefreshCw className="h-4 w-4" />}
          title="Reconnect if it drops"
          description="Relaunch cloudflared after a network blip or a closed laptop lid, backing off up to a minute between tries."
          control={
            <TogglePill
              on={settings.autoRestart}
              busy={toggles.isPending}
              disabled={locked}
              onToggle={() => toggles.mutate({ autoRestart: !settings.autoRestart })}
            />
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="rounded-full transition-all duration-200 active:scale-[0.98]"
          disabled={!dirty || locked || live || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Save setup
        </Button>
        {live && (
          <span className="text-xs text-muted-foreground">
            Stop publishing to edit these settings.
          </span>
        )}
      </div>
    </SectionCard>
  )
}

// ------------------------------------------------------------------ log

function ActivityLogCard({ data }: { data: RemoteOverview }) {
  const log = data.status.log
  if (!log.length) return null
  return (
    <SectionCard
      icon={<ScrollText className="h-5 w-5" />}
      title="cloudflared log"
      description="The last few hundred lines from the tunnel process — the only place a routing or DNS mistake actually shows up. Tokens are stripped before anything is stored."
    >
      <pre className="max-h-72 overflow-auto rounded-2xl border border-border/60 bg-muted/60 p-3 font-mono text-[11px] leading-relaxed">
        {log.join('\n')}
      </pre>
    </SectionCard>
  )
}
