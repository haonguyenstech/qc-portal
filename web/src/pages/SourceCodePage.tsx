import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronDown,
  Code2,
  FolderGit2,
  FolderTree,
  Github,
  GitBranch,
  GitCommit,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Terminal,
  Unlink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  connectSource,
  disconnectSource,
  getSource,
  getSourceJob,
  openSourceFolder,
  syncSource,
  type SourceInfo,
  type SourceLogLine,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { useProjects } from '@/lib/project-context'

// The active clone/sync job id is remembered per project so a browser reload
// reconnects to the still-running server-side job. The global SourceJobWatcher
// clears this key once the job finishes — this page only writes & reads it.
const ACTIVE_JOB_PREFIX = 'qc.sourceJob.'
function loadActiveJobId(projectId: string | null): string | null {
  if (!projectId) return null
  try {
    return localStorage.getItem(ACTIVE_JOB_PREFIX + projectId)
  } catch {
    return null
  }
}
function saveActiveJobId(projectId: string, jobId: string): void {
  try {
    localStorage.setItem(ACTIVE_JOB_PREFIX + projectId, jobId)
  } catch {
    /* storage unavailable */
  }
}

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

/** The terminal-style live log, same look as the test-case / crawl panels. */
function JobLogPanel({ logs, running }: { logs: SourceLogLine[]; running: boolean }) {
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
        <Terminal className="size-3.5 text-zinc-400" />
        <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-400">Logs</span>
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

/** Status card shown once a repo is connected. */
function ConnectedCard({
  info,
  onSync,
  syncing,
  onDisconnect,
  disconnecting,
  onChange,
}: {
  info: SourceInfo
  onSync: () => void
  syncing: boolean
  onDisconnect: () => void
  disconnecting: boolean
  onChange: () => void
}) {
  const commit = info.live?.lastCommit || info.lastCommit
  const branch = info.live?.branch || info.branch
  const folderMissing = info.live === null

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ProviderIcon provider={info.provider} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">
                {providerLabel(info.provider)} repository
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                <Link2 className="h-3 w-3" /> connected
              </span>
              {info.hasToken && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                  title="A private-repo access token is stored locally (never shown)."
                >
                  <Lock className="h-3 w-3" /> private
                </span>
              )}
            </div>
            <a
              href={info.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate font-mono text-xs text-muted-foreground hover:text-foreground"
              title={info.repoUrl}
            >
              {info.repoUrl}
            </a>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onSync}
            disabled={syncing || folderMissing}
            className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Stat icon={GitBranch} label="Branch" value={branch || '—'} />
          <Stat icon={GitCommit} label="Last commit" value={commit || '—'} mono />
          <Stat
            icon={RefreshCw}
            label="Last synced"
            value={info.lastSync ? timeAgo(info.lastSync) : '—'}
          />
        </div>

        {folderMissing && (
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200/70 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The source folder is missing on disk ({info.sourcePath}). Reconnect to clone it again.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={onChange}
            className="gap-1.5 rounded-full text-muted-foreground active:scale-[0.98]"
          >
            <RefreshCw className="size-3.5" /> Change repository
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDisconnect}
            disabled={disconnecting}
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
}: {
  icon: typeof GitBranch
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3 w-3" /> {label}
      </div>
      <div className={cn('mt-0.5 truncate text-sm', mono && 'font-mono text-xs')} title={value}>
        {value}
      </div>
    </div>
  )
}

/** The connect / change-repo form. */
function ConnectForm({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean
  onSubmit: (body: { url: string; branch?: string; token?: string; username?: string }) => void
  onCancel?: () => void
}) {
  const [url, setUrl] = useState('')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  const [username, setUsername] = useState('')

  const isBitbucket = /bitbucket/i.test(url)
  const canSubmit = url.trim().length > 0 && !busy

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
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
            HTTPS URL of a GitHub or Bitbucket repository. Cloned into{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">source/</code> under
            the project so Claude can read it.
          </p>
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
            <Label htmlFor="src-token" className="flex items-center gap-1.5">
              <Lock className="h-3 w-3" /> Access token (private repos)
            </Label>
            <Input
              id="src-token"
              type="password"
              placeholder="leave empty for public repos"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className="font-mono text-sm"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        </div>

        {isBitbucket && (
          <div className="space-y-1.5">
            <Label htmlFor="src-username">Username (Bitbucket app passwords only)</Label>
            <Input
              id="src-username"
              placeholder="leave empty for an API token (ATATT…)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="text-sm"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              An Atlassian <span className="font-medium">API token</span> (<code className="font-mono">ATATT…</code>)
              authenticates on its own — leave this blank. Only fill it in when using a Bitbucket{' '}
              <span className="font-medium">app password</span> (then it's your Bitbucket username).
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
                branch: branch.trim() || undefined,
                token: token.trim() || undefined,
                username: username.trim() || undefined,
              })
            }
            disabled={!canSubmit}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
            {busy ? 'Connecting…' : 'Connect & clone'}
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
      </CardContent>
    </Card>
  )
}

export default function SourceCodePage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(() => loadActiveJobId(activeProjectId))
  const [changing, setChanging] = useState(false)

  // Reset per-project state when the active project changes.
  const [seenProject, setSeenProject] = useState(activeProjectId)
  if (seenProject !== activeProjectId) {
    setSeenProject(activeProjectId)
    setJobId(loadActiveJobId(activeProjectId))
    setChanging(false)
  }

  const { data: info } = useQuery({
    queryKey: ['source', activeProjectId],
    queryFn: () => getSource(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  // Poll the active job while it runs; stop when done/errored.
  const { data: jobData } = useQuery({
    queryKey: ['source-job', jobId, activeProjectId],
    queryFn: () => getSourceJob(jobId as string, activeProjectId as string),
    enabled: !!jobId && !!activeProjectId,
    refetchInterval: (q) => (q.state.data?.job.status === 'running' ? 1500 : false),
  })
  const job = jobData?.job
  const running = job?.status === 'running'

  // When a job finishes, refresh the source view (the watcher owns the toast).
  const lastStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (job && job.status !== 'running' && lastStatus.current === 'running') {
      queryClient.invalidateQueries({ queryKey: ['source', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (job.status === 'done') setChanging(false)
    }
    lastStatus.current = job?.status
  }, [job, activeProjectId, queryClient])

  const connect = useMutation({
    mutationFn: (body: { url: string; branch?: string; token?: string; username?: string }) =>
      connectSource({ projectId: activeProjectId as string, ...body }),
    onSuccess: (res) => {
      setJobId(res.jobId)
      saveActiveJobId(activeProjectId as string, res.jobId)
    },
    onError: (e) =>
      toast.error('Could not start clone', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const sync = useMutation({
    mutationFn: () => syncSource(activeProjectId as string),
    onSuccess: (res) => {
      setJobId(res.jobId)
      saveActiveJobId(activeProjectId as string, res.jobId)
    },
    onError: (e) =>
      toast.error('Could not start sync', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const disconnect = useMutation({
    mutationFn: () => disconnectSource(activeProjectId as string),
    onSuccess: () => {
      toast.success('Source disconnected')
      setJobId(null)
      setChanging(false)
      queryClient.invalidateQueries({ queryKey: ['source', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
    },
    onError: (e) =>
      toast.error('Could not disconnect', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
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

  const connected = info?.connected
  const showForm = !connected || changing
  const folderPath =
    info?.sourcePath || `${activeProject.rootPath}/source`
  const folderExists = Boolean(info?.live?.isRepo)

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Code2 className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Source Code</h1>
            <p className="text-sm text-muted-foreground">
              Connect this project's repository so Claude reads the real code when writing test
              cases, running QC, and checking designs.
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

      {connected && !changing && info && (
        <ConnectedCard
          info={info}
          onSync={() => sync.mutate()}
          syncing={running || sync.isPending}
          onDisconnect={() => disconnect.mutate()}
          disconnecting={disconnect.isPending}
          onChange={() => setChanging(true)}
        />
      )}

      {showForm && (
        <ConnectForm
          busy={running || connect.isPending}
          onSubmit={(body) => connect.mutate(body)}
          onCancel={connected ? () => setChanging(false) : undefined}
        />
      )}

      {job && (job.logs.length > 0 || running) && (
        <JobLogPanel logs={job.logs} running={running} />
      )}
    </div>
  )
}
