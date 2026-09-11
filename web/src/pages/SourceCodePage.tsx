import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  Clipboard,
  Code2,
  Eye,
  EyeOff,
  FolderGit2,
  FolderTree,
  Github,
  GitBranch,
  GitCommit,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Tag,
  Terminal,
  Unlink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  connectSource,
  disconnectSource,
  getSource,
  getSourceCredential,
  listSourceJobs,
  openSourceFolder,
  syncSource,
  type SourceJob,
  type SourceLogLine,
  type SourceRepo,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { addActiveJobId, loadActiveJobIds } from '@/lib/activeSourceJobs'
import { useProjects } from '@/lib/project-context'

function timeAgo(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  if (provider === 'github') return <Github className={className} />
  return <GitBranch className={className} />
}

function providerLabel(provider: string): string {
  if (provider === 'github') return 'GitHub'
  if (provider === 'bitbucket') return 'Bitbucket'
  return 'Git'
}

/**
 * The terminal-style live log, same look as the test-case / crawl panels. Several
 * repos sync at once, so each job gets its own panel and `title` says which repo's
 * output this is — an untitled panel is unreadable once there are three of them.
 */
function JobLogPanel({
  logs,
  running,
  title,
}: {
  logs: SourceLogLine[]
  running: boolean
  title?: string
}) {
  const [open, setOpen] = useState(true)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [logs, open])

  return (
    <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-left"
      >
        <Terminal className="size-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-wide text-zinc-400">
          {title ?? 'Logs'}
        </span>
        {running && (
          <span className="flex items-center gap-1 font-mono text-[10px] text-emerald-400">
            <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-400" />
            live
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] text-zinc-600">
          {logs.length} {logs.length === 1 ? 'line' : 'lines'}
        </span>
        <ChevronDown
          className={cn('size-3.5 text-zinc-500 transition-transform', !open && '-rotate-90')}
        />
      </button>
      {open && (
        <div ref={bodyRef} className="max-h-72 overflow-y-auto p-3">
          <div className="space-y-0.5 font-mono text-[11px] leading-relaxed">
            {logs.length === 0 ? (
              <div className="flex items-center gap-2 text-zinc-500">
                <span className="inline-block size-1.5 animate-pulse rounded-full bg-zinc-500" />
                Waiting for output…
              </div>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={cn(
                    'whitespace-pre-wrap break-words',
                    l.level === 'error'
                      ? 'text-red-400'
                      : l.level === 'success'
                        ? 'text-emerald-400'
                        : 'text-zinc-300',
                  )}
                >
                  <span className="mr-2 select-none text-zinc-600">
                    {new Date(l.time).toLocaleTimeString()}
                  </span>
                  {l.text}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** Status card for one connected repo (tagged). */
function ConnectedCard({
  projectId,
  repo,
  onSync,
  syncing,
  onDisconnect,
  disconnecting,
  onChange,
  busy,
}: {
  projectId: string
  repo: SourceRepo
  onSync: () => void
  syncing: boolean
  onDisconnect: () => void
  disconnecting: boolean
  onChange: () => void
  /** A job is running somewhere in the project — park all actions. */
  busy: boolean
}) {
  const commit = repo.live?.lastCommit || repo.lastCommit
  const branch = repo.live?.branch || repo.branch
  const folderMissing = repo.live === null
  const accessKeyValue = repo.credential
    ? `${repo.credential.label} · ${repo.credential.tokenPreview}`
    : 'Public repo'

  function copyAccessKey() {
    void getSourceCredential(projectId, repo.id)
      .then(({ token }) => navigator.clipboard.writeText(token))
      .then(() => toast.success('Access key copied'))
      .catch((e) =>
        toast.error('Could not copy access key', {
          description: e instanceof Error ? e.message : 'Unknown error',
        }),
      )
  }

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ProviderIcon provider={repo.provider} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-semibold text-background">
                <Tag className="h-3 w-3" /> {repo.tag}
              </span>
              <span className="text-sm font-semibold tracking-tight">
                {providerLabel(repo.provider)} repository
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                <Link2 className="h-3 w-3" /> connected
              </span>
              {repo.hasToken && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title={repo.credential?.label ?? 'A private-repo access token is stored locally.'}
                >
                  <Lock className="h-3 w-3" /> private
                </span>
              )}
            </div>
            <a
              href={repo.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-xs text-muted-foreground hover:text-foreground"
              title={repo.repoUrl}
            >
              {repo.repoUrl}
            </a>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <OpenFolderButton open={() => openSourceFolder(projectId, repo.id)} label={repo.tag} />
            <Button
              variant="outline"
              size="sm"
              onClick={onSync}
              disabled={busy || syncing || folderMissing}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {syncing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Sync
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Stat icon={GitBranch} label="Branch" value={branch || '—'} />
          <Stat icon={GitCommit} label="Last commit" value={commit || '—'} mono />
          <Stat
            icon={RefreshCw}
            label="Last synced"
            value={repo.lastSync ? timeAgo(repo.lastSync) : '—'}
          />
          <Stat
            icon={KeyRound}
            label="Access key"
            value={accessKeyValue}
            action={
              repo.credential ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={copyAccessKey}
                  className="h-6 w-6 rounded-full text-muted-foreground hover:text-foreground"
                  title="Copy access key info"
                  aria-label="Copy access key info"
                >
                  <Clipboard className="size-3.5" />
                </Button>
              ) : undefined
            }
          />
        </div>

        {folderMissing && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The source folder is missing on disk ({repo.sourcePath}). Reconnect to clone it again.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onChange}
            disabled={busy}
            className="gap-1.5 rounded-full text-muted-foreground active:scale-[0.98]"
          >
            <Pencil className="size-3.5" /> Edit & reconnect
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            disabled={busy || disconnecting}
            className="gap-1.5 rounded-full text-destructive hover:text-destructive active:scale-[0.98]"
          >
            {disconnecting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Unlink className="size-3.5" />
            )}
            Disconnect
          </Button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            Files stay on disk when you disconnect.
          </span>
        </div>
      </CardContent>
    </Card>
  )
}

function Stat({
  icon: Icon,
  label,
  value,
  mono,
  action,
}: {
  icon: typeof GitBranch
  label: string
  value: string
  mono?: boolean
  action?: React.ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
        <div className={cn('min-w-0 flex-1 truncate text-sm', mono && 'font-mono text-xs')} title={value}>
          {value}
        </div>
        {action}
      </div>
    </div>
  )
}

const TAG_SUGGESTIONS = ['Backend repo', 'Frontend repo', 'Mobile repo', 'API repo']

/** Prefill for editing an existing connection (Edit & reconnect). */
interface ConnectFormInitial {
  url: string
  tag: string
  branch: string
  hasToken: boolean
  /** The stored credential, loaded for prefill (empty for public repos). */
  token: string
  username: string
}

/** The connect / add-repo / edit-&-reconnect form. */
function ConnectForm({
  busy,
  initial,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  /** Present when editing an existing source — all fields prefilled, token kept if left empty. */
  initial?: ConnectFormInitial
  onSubmit: (body: {
    url: string
    tag?: string
    branch?: string
    token?: string
    username?: string
  }) => void
  onCancel?: () => void
}) {
  const changing = Boolean(initial)
  const [url, setUrl] = useState(initial?.url ?? '')
  const [tag, setTag] = useState(initial?.tag ?? '')
  const [branch, setBranch] = useState(initial?.branch ?? '')
  const [token, setToken] = useState(initial?.token ?? '')
  const [showToken, setShowToken] = useState(false)
  const [username, setUsername] = useState(initial?.username ?? '')

  function copyToken() {
    if (!token) return
    void navigator.clipboard
      .writeText(token)
      .then(() => toast.success('Access token copied'))
      .catch(() => toast.error('Could not copy the token'))
  }

  const isBitbucket = /bitbucket/i.test(url)
  const isGithub = /github/i.test(url)
  const canSubmit = url.trim().length > 0 && !busy

  // Provider-aware pointer to the page where the token is actually created.
  const tokenHelp = isGithub
    ? {
        href: 'https://github.com/settings/personal-access-tokens',
        label: 'Create a GitHub token',
        note: 'Fine-grained token · Repository access: the repo · Contents: Read-only.',
      }
    : isBitbucket
      ? {
          href: 'https://bitbucket.org/account/settings/app-passwords/',
          label: 'Create a Bitbucket app password',
          note: 'Tick Repositories: Read, then fill Username below. (A plain Atlassian API token has no Bitbucket scopes → 403.)',
        }
      : null

  return (
    <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="src-url">Repository URL</Label>
          <Input
            id="src-url"
            placeholder="https://github.com/owner/repo.git"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground">
            HTTPS URL of a GitHub or Bitbucket repository. Each repo is cloned into its own folder
            under{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">source/</code> so
            Claude can read it.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="src-tag" className="flex items-center gap-1.5">
            <Tag className="h-3 w-3" /> Tag {changing ? '' : '(what this repo is)'}
          </Label>
          <Input
            id="src-tag"
            placeholder="e.g. Backend repo"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="text-sm"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {TAG_SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setTag(s)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-[11px] transition-all duration-200 active:scale-[0.98]',
                  tag === s
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border/60 bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                {s}
              </button>
            ))}
            <span className="text-[11px] text-muted-foreground">
              Empty = named after the repo.
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="src-branch">Branch (optional)</Label>
            <Input
              id="src-branch"
              placeholder="default branch"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="src-token" className="flex items-center gap-1.5">
                <Lock className="h-3 w-3" /> Access token (private repos)
              </Label>
              <Link
                to="/document/source-code"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
              >
                <BookOpen className="h-3 w-3" /> How to get a token
              </Link>
            </div>
            <div className="relative">
              <Input
                id="src-token"
                type={showToken ? 'text' : 'password'}
                placeholder={
                  changing && initial?.hasToken
                    ? 'leave empty to keep the saved token'
                    : 'leave empty for public repos'
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="pr-16 font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => setShowToken((s) => !s)}
                  disabled={!token}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  title={showToken ? 'Hide token' : 'Show token'}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                >
                  {showToken ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={copyToken}
                  disabled={!token}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  title="Copy token"
                  aria-label="Copy token"
                >
                  <Clipboard className="size-3.5" />
                </button>
              </div>
            </div>
            {tokenHelp && (
              <p className="text-[11px] text-muted-foreground">
                <a
                  href={tokenHelp.href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary hover:underline"
                >
                  {tokenHelp.label} ↗
                </a>{' '}
                — {tokenHelp.note}
              </p>
            )}
          </div>
        </div>

        {isBitbucket && (
          <div className="space-y-1.5">
            <Label htmlFor="src-username">Username (Bitbucket app passwords only)</Label>
            <Input
              id="src-username"
              placeholder="your Bitbucket username — for app passwords"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              <span className="font-medium">App password</span> (recommended) → fill in your Bitbucket
              username here. <span className="font-medium">Access token</span> (
              <code className="font-mono">ATCTT…</code>) or a <span className="font-medium">scoped</span>{' '}
              API token (<code className="font-mono">ATATT…</code>) → leave this blank. A plain
              (unscoped) API token fails with <span className="font-medium">403 — no Bitbucket scopes</span>;
              see{' '}
              <Link
                to="/document/source-code"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-primary hover:underline"
              >
                the guide
              </Link>
              .
            </p>
          </div>
        )}

        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          The token is stored locally on this machine only — never in the database, the git remote,
          or any log.
        </p>

        <div className="flex items-center gap-2">
          <Button
            onClick={() =>
              onSubmit({
                url: url.trim(),
                tag: tag.trim() || undefined,
                branch: branch.trim() || undefined,
                token: token.trim() || undefined,
                username: username.trim() || undefined,
              })
            }
            disabled={!canSubmit}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            {busy ? 'Connecting…' : changing ? 'Save & reconnect' : 'Connect & clone'}
          </Button>
          {onCancel && (
            <Button
              variant="ghost"
              onClick={onCancel}
              disabled={busy}
              className="rounded-full active:scale-[0.98]"
            >
              Cancel
            </Button>
          )}
        </div>
    </div>
  )
}

export default function SourceCodePage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  // Jobs this browser started (or reconnected to after a reload). Several repos
  // can be cloning/syncing at once, so this is a LIST — the panel below shows one
  // log per job, and each card reads its own repo's status out of the poll.
  const [jobIds, setJobIds] = useState<string[]>(() => loadActiveJobIds(activeProjectId))
  // '' = no form; 'new' = add another repo; else the sourceId being re-pointed.
  const [formFor, setFormFor] = useState<'' | 'new' | string>('')
  // Repos whose sync REQUEST is in flight — the optimistic spinner that covers the
  // gap between the click and the server handing back a job. `sync.isPending` can't
  // do this any more: "Sync all" fires several mutations and only the last one wins
  // that flag.
  const [pendingSync, setPendingSync] = useState<Set<string>>(() => new Set())

  // Reset per-project state when the active project changes.
  const [seenProject, setSeenProject] = useState(activeProjectId)
  if (seenProject !== activeProjectId) {
    setSeenProject(activeProjectId)
    setJobIds(loadActiveJobIds(activeProjectId))
    setFormFor('')
    setPendingSync(new Set())
  }

  const { data: info } = useQuery({
    queryKey: ['source', activeProjectId],
    queryFn: () => getSource(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  // One poll covers every job in the project rather than one query per job — the
  // list endpoint already returns them all, and the interval re-arms itself while
  // ANY of them is running.
  const { data: jobsData } = useQuery({
    queryKey: ['source-jobs', activeProjectId],
    queryFn: () => listSourceJobs(activeProjectId as string),
    enabled: !!activeProjectId,
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === 'running') ? 1500 : false,
  })
  const allJobs = jobsData?.jobs ?? []
  // Newest job per repo — what the card's spinner and the log panels key on.
  // (`listSourceJobs` is newest-first, so the first hit per source wins.)
  const jobBySource = new Map<string, SourceJob>()
  for (const j of allJobs) if (!jobBySource.has(j.sourceId)) jobBySource.set(j.sourceId, j)
  const runningJobs = allJobs.filter((j) => j.status === 'running')
  const running = runningJobs.length > 0
  // Show a log for anything running plus the jobs this session started, so a
  // finished sync's output stays readable without dragging in history from a
  // previous visit.
  const shownJobs = allJobs.filter((j) => j.status === 'running' || jobIds.includes(j.id))

  function trackJob(jobId: string): void {
    setJobIds((prev) => (prev.includes(jobId) ? prev : [...prev, jobId]))
    addActiveJobId(activeProjectId as string, jobId)
    // Re-arm the poll immediately — the last fetch saw nothing running and turned
    // the interval off.
    queryClient.invalidateQueries({ queryKey: ['source-jobs', activeProjectId] })
  }

  // When a job finishes, refresh the source view (the watcher owns the toast).
  const finished = useRef<Set<string>>(new Set())
  useEffect(() => {
    let changed = false
    for (const j of jobsData?.jobs ?? []) {
      if (j.status === 'running' || finished.current.has(j.id)) continue
      finished.current.add(j.id)
      if (jobIds.includes(j.id)) changed = true
    }
    if (changed) {
      queryClient.invalidateQueries({ queryKey: ['source', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  }, [jobsData, jobIds, activeProjectId, queryClient])

  const sources = info?.sources ?? []

  const connect = useMutation({
    mutationFn: (body: {
      url: string
      tag?: string
      branch?: string
      token?: string
      username?: string
      sourceId?: string
    }) => connectSource({ projectId: activeProjectId as string, ...body }),
    onSuccess: (res) => {
      trackJob(res.jobId)
      setFormFor('') // close the dialog — progress shows in the log panel below
    },
    onError: (e) =>
      toast.error('Could not start clone', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const sync = useMutation({
    mutationFn: (sourceId: string) => syncSource(activeProjectId as string, sourceId),
    onMutate: (sourceId) =>
      setPendingSync((prev) => new Set(prev).add(sourceId)),
    onSuccess: (res) => trackJob(res.jobId),
    onError: (e, sourceId) => {
      const repo = sources.find((s) => s.id === sourceId)
      toast.error('Could not start sync', {
        description: `${repo ? `${repo.tag} — ` : ''}${e instanceof Error ? e.message : 'Unknown error'}`,
      })
    },
    // Runs for both outcomes, so a failed request can't leave a repo spinning
    // forever — and a batch "Sync all" clears each repo as its own call lands.
    onSettled: (_res, _err, sourceId) =>
      setPendingSync((prev) => {
        const next = new Set(prev)
        next.delete(sourceId)
        return next
      }),
  })

  const disconnect = useMutation({
    mutationFn: (sourceId: string) => disconnectSource(activeProjectId as string, sourceId),
    onSuccess: () => {
      toast.success('Source disconnected')
      setFormFor('')
      queryClient.invalidateQueries({ queryKey: ['source', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) =>
      toast.error('Could not disconnect', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const changingRepo =
    formFor && formFor !== 'new' ? (sources.find((s) => s.id === formFor) ?? null) : null

  // Edit & reconnect: load the stored token + username so the form opens prefilled.
  const { data: credData } = useQuery({
    queryKey: ['source-credential', changingRepo?.id, activeProjectId],
    queryFn: () => getSourceCredential(activeProjectId as string, changingRepo!.id),
    enabled: Boolean(changingRepo?.hasToken && activeProjectId),
    staleTime: 0,
    gcTime: 0, // never cache a secret
  })

  if (!activeProjectId || !activeProject) {
    return (
      <div className="space-y-6">
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Select a project to connect its source code.
          </CardContent>
        </Card>
      </div>
    )
  }

  const connected = sources.length > 0
  // Hold the form until the credential prefill has arrived (local + instant).
  const credReady = !changingRepo?.hasToken || Boolean(credData)
  // Is THIS repo working? Sync is per repo now, so a backend pull must not disable
  // the web/mobile buttons — only the clone dialog (which can re-point any repo)
  // still parks the page.
  const repoBusy = (id: string) =>
    pendingSync.has(id) || jobBySource.get(id)?.status === 'running'
  const busy = connect.isPending
  const folderPath = `${info?.rootPath ?? activeProject.rootPath}/source`
  const folderExists = sources.some((s) => s.live?.isRepo)
  // Repos that can be pulled right now — the folder has to exist on disk, and one
  // already syncing is simply skipped rather than re-queued.
  const syncableSources = sources.filter((s) => s.live !== null && !repoBusy(s.id))

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Code2 className="size-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Source Code</h1>
            <p className="text-sm text-muted-foreground">
              Connect this project's repositories — tag each one (Backend repo, Frontend repo, …)
              so Claude reads the real code when writing test cases, running QC, and checking
              designs.{' '}
              <Link
                to="/document/source-code"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                <BookOpen className="h-3.5 w-3.5" /> Read the setup guide
              </Link>
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
          <span className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
              <FolderGit2 className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                Source for
              </span>
              <span className="block text-sm font-semibold tracking-tight">
                {activeProject.name}
              </span>
            </span>
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span
              className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
              title={folderPath}
            >
              <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span className="truncate">{folderPath}</span>
              <span
                className={cn(
                  'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                  folderExists
                    ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400'
                    : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
                )}
              >
                {folderExists ? 'exists' : 'new'}
              </span>
            </span>
            <OpenFolderButton open={() => openSourceFolder(activeProjectId)} label="source" />
          </div>
        </div>
      </header>

      {sources.map((repo) => (
        <ConnectedCard
          key={repo.id}
          projectId={activeProjectId}
          repo={repo}
          onSync={() => sync.mutate(repo.id)}
          syncing={repoBusy(repo.id)}
          onDisconnect={() => disconnect.mutate(repo.id)}
          disconnecting={disconnect.isPending && disconnect.variables === repo.id}
          onChange={() => setFormFor(repo.id)}
          busy={busy || repoBusy(repo.id)}
        />
      ))}

      {connected ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setFormFor('new')}
            disabled={busy}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            <Plus className="size-4" /> Add repository
          </Button>
          {sources.length > 1 && (
            <Button
              variant="outline"
              onClick={() => {
                for (const s of syncableSources) sync.mutate(s.id)
                toast.info(
                  `Syncing ${syncableSources.length} ${syncableSources.length === 1 ? 'repository' : 'repositories'}`,
                  { description: syncableSources.map((s) => s.tag).join(', ') },
                )
              }}
              disabled={busy || syncableSources.length === 0}
              className="gap-1.5 rounded-full active:scale-[0.98]"
              title={
                syncableSources.length === 0
                  ? 'Every repository is already syncing'
                  : `Pull ${syncableSources.map((s) => s.tag).join(', ')} in parallel`
              }
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Sync all
              {syncableSources.length > 0 && (
                <span className="rounded-full bg-muted px-1.5 text-[11px] font-medium text-muted-foreground">
                  {syncableSources.length}
                </span>
              )}
            </Button>
          )}
          {running && (
            <span className="text-xs text-muted-foreground">
              {runningJobs.length} in progress — {runningJobs.map((j) => j.tag).join(', ')}
            </span>
          )}
        </div>
      ) : (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <FolderGit2 className="h-6 w-6" />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-semibold tracking-tight">No repository connected yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Connect the project's repos — tag each one (Backend repo, Frontend repo, …) so
                Claude can read the real code.
              </p>
            </div>
            <Button
              onClick={() => setFormFor('new')}
              disabled={busy}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              <Link2 className="size-4" /> Connect repository
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={formFor !== ''} onOpenChange={(open) => !open && !busy && setFormFor('')}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {changingRepo ? `Edit & reconnect — ${changingRepo.tag}` : 'Connect a repository'}
            </DialogTitle>
            <DialogDescription>
              {changingRepo
                ? 'Change the URL, tag, branch, or token, then re-clone.'
                : 'Clone a GitHub or Bitbucket repo into this project so Claude can read it.'}
            </DialogDescription>
          </DialogHeader>
          {credReady ? (
            <ConnectForm
              key={formFor || 'closed'}
              busy={busy}
              initial={
                changingRepo
                  ? {
                      url: changingRepo.repoUrl,
                      tag: changingRepo.tag,
                      branch: changingRepo.branch,
                      hasToken: changingRepo.hasToken,
                      token: credData?.token ?? '',
                      username: credData?.username ?? '',
                    }
                  : undefined
              }
              onSubmit={(body) =>
                connect.mutate({ ...body, sourceId: changingRepo ? changingRepo.id : undefined })
              }
              onCancel={() => setFormFor('')}
            />
          ) : (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading saved credential…
            </div>
          )}
        </DialogContent>
      </Dialog>

      {shownJobs.map((j) => (
        <JobLogPanel
          key={j.id}
          logs={j.logs}
          running={j.status === 'running'}
          title={`${j.tag} · ${j.kind}`}
        />
      ))}
    </div>
  )
}
