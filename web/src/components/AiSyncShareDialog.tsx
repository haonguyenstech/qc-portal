import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  Check,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Radio,
  RefreshCw,
  ShieldAlert,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import SyncStage from '@/components/SyncStage'
import { closeSyncShare, fetchSyncGroups, fetchSyncShare, openSyncShare } from '@/lib/api'
import { formatBytes, sharePercent, stageStateForShare, untilLabel } from '@/lib/sync'
import { cn } from '@/lib/utils'

/**
 * The HOST half of AI Sync: "let another machine pull this project from me".
 *
 * Two screens in one dialog, and the split matters. Before a share is open it is a
 * consent form — what leaves this machine, whether credentials go with it, and for
 * how long. Once it is open it is a handover card: the public URL and four digits,
 * big enough to read out across a desk, plus a live picture of whoever turned up.
 *
 * What it is NOT is the blocking screen. Once a peer starts pulling, the portal-wide
 * overlay (`AiSyncWatcher`) takes over on both machines — because the owner might
 * have closed this dialog, or be on another page entirely, and "the sync is running"
 * has to be true of the whole portal rather than of one dialog that happens to be open.
 */

const TTL_CHOICES = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
]

export default function AiSyncShareDialog({
  projectId,
  projectName,
  open,
  onOpenChange,
}: {
  projectId: string
  projectName: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [groups, setGroups] = useState<string[] | null>(null)
  const [includeMcpSecrets, setIncludeMcpSecrets] = useState(false)
  const [ttl, setTtl] = useState('15')
  const [copied, setCopied] = useState<string | null>(null)
  // Redraw the countdown once a second without re-fetching anything.
  const [, setTick] = useState(0)

  const catalog = useQuery({ queryKey: ['sync-groups'], queryFn: fetchSyncGroups, enabled: open })

  const status = useQuery({
    queryKey: ['sync-share', projectId],
    queryFn: () => fetchSyncShare(projectId),
    enabled: open,
    // Fast while the dialog is up: the whole point of this screen is watching for the
    // moment somebody pairs, and that is the one event it cannot predict.
    refetchInterval: open ? 1500 : false,
  })

  const share = status.data?.share ?? null
  const endpoint = status.data?.endpoint ?? null

  useEffect(() => {
    if (!open || !share) return
    const id = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [open, share])

  const allKeys = useMemo(() => (catalog.data?.groups ?? []).map((g) => g.key), [catalog.data])

  const openMutation = useMutation({
    mutationFn: () =>
      openSyncShare({
        projectId,
        groups: groups ?? allKeys,
        includeMcpSecrets,
        ttlMinutes: Number(ttl),
      }),
    onSuccess: () => {
      void status.refetch()
      void queryClient.invalidateQueries({ queryKey: ['sync-shares'] })
    },
    onError: (err) =>
      toast.error('Could not open the share', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const closeMutation = useMutation({
    mutationFn: () => closeSyncShare(projectId),
    onSuccess: () => {
      void status.refetch()
      void queryClient.invalidateQueries({ queryKey: ['sync-shares'] })
      toast.success('Share closed', { description: 'The code no longer works.' })
    },
  })

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600)
    } catch {
      toast.error('Could not copy', { description: text })
    }
  }

  const toggle = (key: string) =>
    setGroups((current) => {
      const list = current ?? allKeys
      return list.includes(key) ? list.filter((k) => k !== key) : [...list, key]
    })

  // `null` means "untouched", which renders as everything ticked — the default a
  // first-time sync almost always wants. Derived rather than copied into state on
  // load, so the catalog arriving late can't race the user's first click.
  const selected = groups ?? allKeys
  const noEndpoint = !endpoint

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <Radio className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Open “{projectName}” to AI Sync</DialogTitle>
              <DialogDescription>
                Give another machine a public URL and a 4-digit code, and it can pull this
                project’s QC artifacts from you.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {status.isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : share && share.state !== 'revoked' ? (
          /* ---------------------------------------------------------------- open */
          <div className="space-y-4">
            <SyncStage
              from={share.host}
              to={share.peer}
              state={stageStateForShare(share)}
              percent={sharePercent(share)}
              toFallback="Waiting for a machine…"
              caption={
                share.state === 'waiting'
                  ? 'Waiting for the other machine to enter the code'
                  : share.state === 'done'
                    ? 'Sync complete'
                    : share.state === 'error'
                      ? (share.error ?? 'The sync failed')
                      : `${share.peer?.name ?? 'A machine'} is pulling…`
              }
              detail={
                share.state === 'waiting'
                  ? `Code expires in ${untilLabel(share.expiresAt)}`
                  : share.progress
                    ? `${formatBytes(share.progress.bytesDone)} of ${formatBytes(share.progress.bytesTotal)} — ${share.progress.message}`
                    : undefined
              }
            />

            {/* the handover card: URL + code, the two things read out loud */}
            <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/60 p-4">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide">
                  <Globe className="size-3" /> Endpoint
                </Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-xl border border-border/60 bg-card px-3 py-2 font-mono text-xs">
                    {endpoint ?? 'No public URL — start the tunnel on /remote'}
                  </code>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 shrink-0 rounded-full"
                    disabled={!endpoint}
                    onClick={() => endpoint && copy(endpoint, 'url')}
                    aria-label="Copy endpoint"
                  >
                    {copied === 'url' ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide">
                  <KeyRound className="size-3" /> Security code
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border/60 bg-card py-3">
                    {share.code.split('').map((digit, i) => (
                      <span
                        key={`${share.id}-${i}`}
                        className="qc-sync-digit flex size-10 items-center justify-center rounded-xl bg-foreground text-xl font-semibold tabular-nums text-background"
                        style={{ animationDelay: `${i * 70}ms` }}
                      >
                        {digit}
                      </span>
                    ))}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-9 shrink-0 rounded-full"
                    onClick={() => copy(share.code, 'code')}
                    aria-label="Copy code"
                  >
                    {copied === 'code' ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
                  </Button>
                </div>
                {/* Wrong attempts are shown, not hidden: five of them revoke the share,
                    and the owner should see that happening rather than discover it. */}
                {share.failures > 0 && (
                  <p className="flex items-center gap-1.5 text-xs text-amber-700">
                    <ShieldAlert className="size-3.5" />
                    {share.failures} wrong attempt{share.failures === 1 ? '' : 's'} — the share is
                    revoked after {share.maxFailures}.
                  </p>
                )}
              </div>
            </div>

            {share.state === 'done' && share.summary && (
              <div className="space-y-1.5 rounded-2xl border border-emerald-200/70 bg-emerald-50/50 p-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">
                  What {share.peer?.name ?? 'the other machine'} received
                </p>
                <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-foreground">
                  {share.summary}
                </pre>
              </div>
            )}

            <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:justify-between">
              <p className="text-xs text-muted-foreground">
                {share.includeMcpSecrets
                  ? 'MCP credentials ARE included in this share.'
                  : 'MCP credentials are not included.'}
              </p>
              <Button
                variant="outline"
                onClick={() => closeMutation.mutate()}
                disabled={closeMutation.isPending}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {closeMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Square className="size-4" />
                )}
                Close share
              </Button>
            </div>
          </div>
        ) : (
          /* ---------------------------------------------------------------- consent */
          <div className="space-y-4">
            {share?.state === 'revoked' && (
              <p className="flex items-start gap-2 rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-[13px] text-destructive">
                <ShieldAlert className="mt-0.5 size-4 shrink-0" />
                The previous share was revoked after too many wrong codes. Opening a new one
                generates a fresh code.
              </p>
            )}

            {/* No tunnel, no endpoint to hand over. Said up front rather than after the
                engineer has ticked twelve boxes and pressed a button that can't work. */}
            {noEndpoint && (
              <div className="space-y-2 rounded-2xl border border-amber-200/70 bg-amber-50/50 p-3 text-[13px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300">
                <p className="flex items-start gap-2 font-medium">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  This portal has no public URL yet.
                </p>
                <p className="leading-relaxed">
                  AI Sync hands the other machine an address to reach you on. Publish the portal
                  first — it needs an access password and a Cloudflare Tunnel.
                </p>
                <Button asChild size="sm" variant="outline" className="rounded-full">
                  <Link to="/remote" onClick={() => onOpenChange(false)}>
                    Open Remote access
                  </Link>
                </Button>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wide">What the other machine can pull</Label>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-1.5">
                {(catalog.data?.groups ?? []).map((group) => {
                  const on = selected.includes(group.key)
                  return (
                    <label
                      key={group.key}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 transition-colors',
                        on ? 'bg-muted/60' : 'hover:bg-muted/40',
                      )}
                    >
                      <Checkbox checked={on} onCheckedChange={() => toggle(group.key)} className="mt-0.5" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-[13px] font-medium">
                          {group.label}
                          {group.heavy && (
                            <span className="rounded-full border border-amber-300/50 bg-amber-100/60 px-1.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-400">
                              can be large
                            </span>
                          )}
                        </span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">
                          {group.description}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {selected.length} of {allKeys.length} selected
                </span>
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => setGroups(selected.length === allKeys.length ? [] : allKeys)}
                >
                  {selected.length === allKeys.length ? 'Clear all' : 'Select all'}
                </button>
              </div>
            </div>

            {/* Credentials are opt-in and worded as a consequence, not a feature. */}
            {selected.includes('mcp') && (
              <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border/60 bg-muted/40 p-3">
                <Checkbox
                  checked={includeMcpSecrets}
                  onCheckedChange={(v) => setIncludeMcpSecrets(v === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block text-[13px] font-medium">Include MCP credentials</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    Off: the API keys in <code className="font-mono">.mcp.json</code> are blanked and
                    the other machine fills its own in. On: your ClickUp / Jira tokens travel to that
                    machine.
                  </span>
                </span>
              </label>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="sync-ttl" className="text-[11px] uppercase tracking-wide">
                Code valid for
              </Label>
              <Select value={ttl} onValueChange={setTtl}>
                <SelectTrigger id="sync-ttl" className="rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TTL_CHOICES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                After this, the code stops working on its own. A transfer already in progress is
                never cut off.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                Cancel
              </Button>
              <Button
                onClick={() => openMutation.mutate()}
                disabled={openMutation.isPending || selected.length === 0}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {openMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Open to AI Sync
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
