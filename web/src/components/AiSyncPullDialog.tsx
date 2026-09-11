import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowRight,
  CloudDownload,
  FolderGit2,
  FolderOpen,
  Globe,
  Info,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { BrowseButton } from '@/components/FolderBrowser'
import SyncStage from '@/components/SyncStage'
import { connectSync, dismissSyncJob, fetchSyncGroups, startSyncJob } from '@/lib/api'
import type { SyncJob, SyncTarget } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * The GUEST half of AI Sync: "pull a project from another machine".
 *
 * Two steps, and they are two steps ON PURPOSE. Entering the code pairs immediately —
 * that is what burns one of the host's five attempts — but pairing must not start a
 * transfer, because between the two the engineer has to answer the question this
 * whole feature exists for: does this land on a project I ALREADY HAVE, or make a new
 * one? Getting that wrong is exactly the duplicate that used to happen on import.
 *
 * So step 1 connects and learns what the other side is offering, step 2 shows the
 * match this machine found and lets them choose, and only then does the blocking
 * overlay take over.
 */

/** 4 single-character boxes: it reads as a code, and it stops a 5th digit landing. */
function CodeInput({
  value,
  onChange,
  disabled,
  onComplete,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  onComplete?: () => void
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([])
  const digits = value.padEnd(4, ' ').slice(0, 4).split('')

  function setAt(i: number, char: string) {
    const next = value.padEnd(4, ' ').split('')
    next[i] = char
    const joined = next.join('').replace(/\s/g, '')
    onChange(joined)
    if (char && i < 3) refs.current[i + 1]?.focus()
    if (char && i === 3 && joined.length === 4) onComplete?.()
  }

  return (
    <div className="flex items-center justify-center gap-2">
      {[0, 1, 2, 3].map((i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={1}
          disabled={disabled}
          value={digits[i].trim()}
          onChange={(e) => {
            const char = e.target.value.replace(/\D/g, '').slice(-1)
            setAt(i, char)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[i].trim() && i > 0) refs.current[i - 1]?.focus()
          }}
          onPaste={(e) => {
            // Pasting the whole code into the first box is what people actually do.
            const text = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 4)
            if (!text) return
            e.preventDefault()
            onChange(text)
            if (text.length === 4) onComplete?.()
            refs.current[Math.min(text.length, 3)]?.focus()
          }}
          className={cn(
            'size-12 rounded-xl border border-border/60 bg-card text-center text-xl font-semibold tabular-nums',
            'transition-all duration-200 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            'disabled:opacity-60',
          )}
        />
      ))}
    </div>
  )
}

export default function AiSyncPullDialog({
  open,
  onOpenChange,
  /** When opened from a project card: that project is the default destination. */
  preset,
  onStarted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  preset?: { id: string; name: string; rootPath: string } | null
  onStarted?: (job: SyncJob) => void
}) {
  const queryClient = useQueryClient()
  const [endpoint, setEndpoint] = useState('')
  const [code, setCode] = useState('')
  const [job, setJob] = useState<SyncJob | null>(null)
  const [groups, setGroups] = useState<string[]>([])
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [newName, setNewName] = useState('')
  const [parentPath, setParentPath] = useState('')

  const catalog = useQuery({ queryKey: ['sync-groups'], queryFn: fetchSyncGroups, enabled: open })
  const groupLabel = useMemo(() => {
    const map = new Map((catalog.data?.groups ?? []).map((g) => [g.key, g]))
    return (key: string) => map.get(key)
  }, [catalog.data])

  /** Wipe the handshake, so a previous pairing never leaks into the next opening. */
  function reset() {
    setJob(null)
    setCode('')
    setGroups([])
  }

  const connectMutation = useMutation({
    mutationFn: () => connectSync({ endpoint, code }),
    onSuccess: ({ job: next }) => {
      setJob(next)
      setGroups(next.offeredGroups)
      setNewName(next.remoteProjectName)
      // A certain match (same sync key) defaults to updating it. Anything else
      // defaults to a NEW project — the safe direction, since creating one extra is
      // recoverable and writing over the wrong project is not.
      const certain = next.match?.by === 'syncKey'
      setMode(preset ? 'existing' : certain ? 'existing' : 'new')
    },
    onError: (err) => {
      setCode('')
      toast.error('Could not connect', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    },
  })

  const startMutation = useMutation({
    mutationFn: () => {
      if (!job) throw new Error('Connect first.')
      const target: SyncTarget =
        mode === 'existing'
          ? { mode: 'existing', projectId: preset?.id ?? job.match?.projectId ?? '' }
          : { mode: 'new', name: newName.trim(), parentPath: parentPath.trim() }
      return startSyncJob(job.id, { groups, target })
    },
    onSuccess: ({ job: next }) => {
      onStarted?.(next)
      reset()
      onOpenChange(false)
      void queryClient.invalidateQueries({ queryKey: ['sync-active'] })
    },
    onError: (err) =>
      toast.error('Could not start the sync', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  /** Abandoning a paired session must release the host, not leave it blocked. */
  function close() {
    if (job && job.status === 'ready') void dismissSyncJob(job.id).catch(() => {})
    reset()
    onOpenChange(false)
  }

  const existingTarget = preset ?? (job?.match ? { id: job.match.projectId, name: job.match.name, rootPath: job.match.rootPath } : null)
  const canStart =
    !!job &&
    groups.length > 0 &&
    (mode === 'existing' ? !!existingTarget : !!newName.trim() && !!parentPath.trim()) &&
    !startMutation.isPending

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <CloudDownload className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>{job ? `Sync from ${job.host?.name ?? 'the other machine'}` : 'AI Sync from another machine'}</DialogTitle>
              <DialogDescription>
                {job
                  ? `“${job.remoteProjectName}” is ready to pull. Choose where it lands.`
                  : 'Paste the public URL the other machine showed you, then the 4-digit code.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {!job ? (
          /* ---------------------------------------------------------------- connect */
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault()
              if (endpoint.trim() && code.length === 4 && !connectMutation.isPending) {
                connectMutation.mutate()
              }
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="sync-endpoint" className="flex items-center gap-1.5">
                <Globe className="size-3.5 text-muted-foreground" />
                Endpoint
              </Label>
              <div className="group relative">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <Input
                  id="sync-endpoint"
                  autoFocus
                  placeholder="https://something.trycloudflare.com"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  className="h-11 pl-9 font-mono text-sm"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <KeyRound className="size-3.5 text-muted-foreground" />
                Security code
              </Label>
              <CodeInput
                value={code}
                onChange={setCode}
                disabled={connectMutation.isPending}
                onComplete={() => {
                  if (endpoint.trim() && !connectMutation.isPending) connectMutation.mutate()
                }}
              />
              {/* Say the cost of a wrong guess BEFORE it is guessed at. */}
              <p className="text-center text-[11px] text-muted-foreground">
                Five wrong codes revoke the other machine’s share and it has to open a new one.
              </p>
            </div>

            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={close} className="rounded-full">
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!endpoint.trim() || code.length !== 4 || connectMutation.isPending}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {connectMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Link2 className="size-4" />
                )}
                Connect
              </Button>
            </div>
          </form>
        ) : (
          /* ---------------------------------------------------------------- choose */
          <div className="space-y-4">
            <SyncStage
              from={job.host}
              to={job.self}
              state="connected"
              caption={`Paired with ${job.host?.name ?? 'the other machine'}`}
              detail={job.endpoint}
            />

            {job.match && (
              <p
                className={cn(
                  'flex items-start gap-2 rounded-2xl border p-3 text-[13px] leading-relaxed',
                  job.match.by === 'syncKey'
                    ? 'border-emerald-200/70 bg-emerald-50/50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-300'
                    : 'border-amber-200/70 bg-amber-50/50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-300',
                )}
              >
                {job.match.by === 'syncKey' ? (
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <Info className="mt-0.5 size-4 shrink-0" />
                )}
                <span>
                  {job.match.by === 'syncKey' ? (
                    <>
                      You already have this project as <strong>{job.match.name}</strong>. Updating it
                      keeps your own files and only brings across what differs.
                    </>
                  ) : (
                    <>
                      You have a project called <strong>{job.match.name}</strong>. It may or may not
                      be the same one — check the folder before you update it.
                    </>
                  )}
                </span>
              </p>
            )}

            {/* ---- destination */}
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wide">Where it lands</Label>
              <div className="space-y-1.5">
                <button
                  type="button"
                  disabled={!existingTarget}
                  onClick={() => setMode('existing')}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-all duration-200',
                    mode === 'existing' && existingTarget
                      ? 'border-primary bg-primary/5'
                      : 'border-border/60 hover:border-border',
                    !existingTarget && 'cursor-not-allowed opacity-50',
                  )}
                >
                  <FolderGit2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">
                      {existingTarget ? `Update “${existingTarget.name}”` : 'Update an existing project'}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {existingTarget?.rootPath ?? 'Nothing here matches this project yet'}
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setMode('new')}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-all duration-200',
                    mode === 'new' ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border',
                  )}
                >
                  <FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium">Create a new project</span>
                    <span className="block text-[11px] text-muted-foreground">
                      A separate copy on this machine.
                    </span>
                  </span>
                </button>
              </div>
            </div>

            {mode === 'new' && (
              <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/40 p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="sync-new-name">Project name</Label>
                  <Input
                    id="sync-new-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-10"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sync-new-parent">Create inside</Label>
                  <div className="flex gap-2">
                    <Input
                      id="sync-new-parent"
                      placeholder="/Users/you/code"
                      value={parentPath}
                      onChange={(e) => setParentPath(e.target.value)}
                      className="h-11 flex-1 font-mono text-sm"
                    />
                    <BrowseButton onPick={setParentPath} />
                  </div>
                </div>
              </div>
            )}

            {/* ---- what to pull */}
            <div className="space-y-2">
              <Label className="text-[11px] uppercase tracking-wide">What to pull</Label>
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-1.5">
                {job.offeredGroups.map((key) => {
                  const def = groupLabel(key)
                  const on = groups.includes(key)
                  return (
                    <label
                      key={key}
                      className={cn(
                        'flex cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 transition-colors',
                        on ? 'bg-muted/60' : 'hover:bg-muted/40',
                      )}
                    >
                      <Checkbox
                        checked={on}
                        onCheckedChange={() =>
                          setGroups((list) =>
                            list.includes(key) ? list.filter((k) => k !== key) : [...list, key],
                          )
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium">{def?.label ?? key}</span>
                        <span className="block text-[11px] leading-snug text-muted-foreground">
                          {def?.description ?? ''}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
              {job.mcpScrubbed && groups.includes('mcp') && (
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <Info className="mt-0.5 size-3 shrink-0" />
                  The other machine is not sharing its MCP credentials — you’ll fill the API keys in
                  yourself on the MCP page.
                </p>
              )}
            </div>

            <p className="flex items-start gap-1.5 rounded-xl bg-muted/60 p-2.5 text-[11px] leading-snug text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
              Files you have that the other machine doesn’t are never deleted. Files that differ are
              replaced with theirs; files that are already identical aren’t transferred at all.
            </p>

            <div className="flex justify-end gap-2 border-t pt-3">
              <Button type="button" variant="outline" onClick={close} className="rounded-full">
                Cancel
              </Button>
              <Button
                onClick={() => startMutation.mutate()}
                disabled={!canStart}
                className="group rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {startMutation.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <CloudDownload className="size-4" />
                )}
                Start sync
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
