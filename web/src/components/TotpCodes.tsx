import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Copy, Loader2, Plus, Smartphone, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  deleteTotp as deleteTotpApi,
  getTotpCodes,
  listTotp,
  saveTotp,
  type TotpCode,
  type TotpEntry,
} from '@/lib/api'

// Authenticator-app 2FA for test accounts. On a production-like environment the six
// digits are no longer a fixed OTP — they come from Google Authenticator / Authy on the
// engineer's phone. Registering the account's enrollment secret here lets the server
// compute the very same code, so a headless QC run fetches it instead of stalling at the
// 2FA screen. The secret is write-only: it is never sent back to the browser.

/** Poll interval for the live codes — a TOTP rolls every 30s, so once a second is plenty. */
const CODE_POLL_MS = 1000

function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      toast.error('Could not copy the code')
    }
  }
  // Grouped as 123 456 like the authenticator app shows it, so it's easy to eyeball-match.
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy code"
      className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/60 px-2.5 py-1 font-mono text-base font-semibold tabular-nums tracking-wider transition-all duration-200 hover:border-border active:scale-[0.98]"
    >
      {pretty}
      {copied ? (
        <Check className="size-3.5 text-emerald-600" />
      ) : (
        <Copy className="size-3.5 text-muted-foreground" />
      )}
    </button>
  )
}

/** Thin bar that drains as the current code approaches its rollover. */
function Countdown({ code }: { code: TotpCode }) {
  const pct = Math.max(0, Math.min(100, (code.expiresIn / code.period) * 100))
  const low = code.expiresIn <= 5
  return (
    <span className="flex items-center gap-1.5" title={`Rolls over in ${code.expiresIn}s`}>
      <span className="h-1 w-12 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-1000 ease-linear',
            low ? 'bg-amber-500' : 'bg-emerald-500',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span
        className={cn(
          'w-6 text-right font-mono text-[11px] tabular-nums',
          low ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
        )}
      >
        {code.expiresIn}s
      </span>
    </span>
  )
}

export function TotpCodes({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['totp', projectId],
    queryFn: () => listTotp(projectId),
    enabled: !!projectId,
  })
  const entries = data?.entries ?? []

  // Live codes, only polled once at least one authenticator exists. React Query pauses
  // interval refetching in a hidden tab by default, so this idles when unwatched.
  const { data: codeData } = useQuery({
    queryKey: ['totp-codes', projectId],
    queryFn: () => getTotpCodes(projectId),
    enabled: !!projectId && entries.length > 0,
    refetchInterval: CODE_POLL_MS,
  })
  const codes = new Map((codeData?.codes ?? []).map((c) => [c.label, c]))

  const remove = useMutation({
    mutationFn: (label: string) => deleteTotpApi(label, projectId),
    onSuccess: () => {
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['totp', projectId] })
      queryClient.invalidateQueries({ queryKey: ['totp-codes', projectId] })
      toast.success('Authenticator removed', { description: 'Its secret was deleted.' })
    },
    onError: (err) =>
      toast.error('Could not remove it', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-base font-semibold tracking-tight">
          <Smartphone className="h-4 w-4 text-primary" />
          Authenticator (2FA) codes
        </h3>
        {!adding && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding(true)}
            className="h-8 rounded-full active:scale-[0.98]"
          >
            <Plus className="mr-1.5 size-3.5" /> Add authenticator
          </Button>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        For accounts whose login code is <strong>not a fixed OTP</strong> — the real six digits from
        Google Authenticator / Authy. Paste the account&rsquo;s setup key (or the whole{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">otpauth://</code> QR
        link) once, and the portal computes the same code your phone shows — so a QC run gets past
        the 2FA screen on its own instead of waiting for you. Secrets are stored outside the project
        folder and are never shown again or sent to Claude; only a live code is.
      </p>

      {adding && (
        <AddAuthenticator
          projectId={projectId}
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center gap-2 px-4 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading authenticators…
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
                <Smartphone className="size-5" />
              </span>
              <p className="text-sm font-medium">No authenticators registered</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Add one for any test account that asks for a code from an authenticator app.
                Without it, a run will stall at (or guess at) the 2FA step.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {entries.map((entry) => (
                <li key={entry.label} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium leading-tight">
                      {entry.issuer || entry.label}
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {entry.label}
                      </code>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {entry.username || 'no account noted'}
                      {entry.note ? ` · ${entry.note}` : ''}
                      {entry.digits !== 6 || entry.period !== 30 || entry.algorithm !== 'SHA1'
                        ? ` · ${entry.digits} digits / ${entry.period}s / ${entry.algorithm}`
                        : ''}
                    </p>
                  </div>

                  {codes.get(entry.label) && (
                    <div className="flex items-center gap-2">
                      <CodeChip code={codes.get(entry.label)!.code} />
                      <Countdown code={codes.get(entry.label)!} />
                    </div>
                  )}

                  {confirmDelete === entry.label ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">Delete its secret?</span>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => remove.mutate(entry.label)}
                        disabled={remove.isPending}
                        className="h-8 rounded-full"
                      >
                        {remove.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(null)}
                        className="h-8 rounded-full"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(entry.label)}
                      className="h-8 rounded-full text-destructive hover:text-destructive active:scale-[0.98]"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {entries.length > 0 && (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Compare a code above with your phone to confirm the key is right. Runs are told to fetch a
          fresh code themselves and never to write one into a report or screenshot.
        </p>
      )}
    </section>
  )
}

/** Inline form: paste a setup key or an otpauth:// link; the server validates it. */
function AddAuthenticator({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string
  onDone: () => void
  onCancel: () => void
}) {
  const queryClient = useQueryClient()
  const [secret, setSecret] = useState('')
  const [label, setLabel] = useState('')
  const [issuer, setIssuer] = useState('')
  const [username, setUsername] = useState('')
  const [note, setNote] = useState('')

  const save = useMutation({
    mutationFn: () =>
      saveTotp({ secret: secret.trim(), label, issuer, username, note }, projectId),
    onSuccess: ({ entry }: { entry: TotpEntry }) => {
      queryClient.invalidateQueries({ queryKey: ['totp', projectId] })
      queryClient.invalidateQueries({ queryKey: ['totp-codes', projectId] })
      toast.success(`Authenticator "${entry.label}" saved`, {
        description: 'Check the live code matches your phone.',
      })
      onDone()
    },
    onError: (err) =>
      toast.error('Could not save that key', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const isUri = /^otpauth:\/\//i.test(secret.trim())

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-3 px-4 py-4">
        <div className="space-y-1.5">
          <label className="text-xs font-medium">Setup key or otpauth:// link</label>
          <Input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoFocus
            spellCheck={false}
            placeholder="JBSWY3DPEHPK3PXP  —  or  otpauth://totp/Acme:qa@acme.com?secret=…"
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-muted-foreground">
            {isUri
              ? 'Issuer, account, digits and period are read from the link.'
              : 'The base32 “setup key”/“secret” shown next to the QR code when 2FA is enrolled. Spaces and case don’t matter. It can’t be read back out of an authenticator app that’s already set up — re-enroll 2FA to see it again.'}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Label (optional)</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="prod-admin"
              className="text-xs"
            />
            <p className="text-[11px] text-muted-foreground">
              How runs refer to it. Auto-derived from issuer + account when blank.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Account (optional)</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="qa.admin@acme.com"
              className="text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Environment / issuer (optional)</label>
            <Input
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder="Production"
              className="text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Note (optional)</label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Admin role, prod login"
              className="text-xs"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={save.isPending}
            className="rounded-full"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || !secret.trim()}
            className="rounded-full active:scale-[0.98]"
          >
            {save.isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Save authenticator
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
