import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  Database,
  Eye,
  EyeOff,
  Download,
  Eraser,
  FileText,
  History,
  KeyRound,
  Link2,
  Loader2,
  Lock,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Plus,
  Plug,
  RefreshCw,
  Send,
  Server,
  ShieldAlert,
  Sparkles,
  SquareTerminal,
  Table2,
  Tag,
  Terminal,
  Unlink,
  XCircle,
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
import { Textarea } from '@/components/ui/textarea'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SchemaBrowser, SqlEditor } from '@/components/SqlEditor'
import type { SchemaTable } from '@/lib/sql-complete'
import {
  askDatabase,
  connectDatabase,
  disconnectDatabase,
  getDatabaseCredential,
  getDatabaseHealth,
  getDatabaseJob,
  getDatabaseSchema,
  getDatabases,
  runDatabaseQuery,
  syncDatabase,
  testDatabaseConnection,
  type DatabaseConn,
  type DbBlocked,
  type DbKind,
  type DbKindInfo,
  type DbLogLine,
  type DbQueryResult,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'

// The active connect/sync job id is remembered per project so a browser reload
// reconnects to the still-running server-side job. The global DatabaseJobWatcher
// clears this key once the job finishes — this page only writes & reads it.
const ACTIVE_JOB_PREFIX = 'qc.databaseJob.'
/** Which connected database the query console is pointed at, per project. */
const QUERY_DB_PREFIX = 'qc.databaseQueryTarget.'
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
  return `${Math.round(h / 24)}d ago`
}

function kindLabel(kinds: DbKindInfo[], kind: string): string {
  return kinds.find((k) => k.value === kind)?.label ?? kind
}

/** The terminal-style live log, same look as the source / crawl panels. */
function JobLogPanel({ logs, running }: { logs: DbLogLine[]; running: boolean }) {
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

function Stat({
  icon: Icon,
  label,
  value,
  mono,
  action,
}: {
  icon: typeof Server
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

/**
 * Live reachability for one database.
 *
 * This used to be the literal text "connected" on every card, which made it the one
 * badge on the page that could not be believed: a stopped server, a dropped SSH
 * tunnel, or a rotated password all still read green. It now reflects an actual
 * `SELECT 1` (GET /api/database/health).
 *
 * Three states, because "we don't know yet" is not the same as "it's up" — the first
 * check takes a moment and showing green during it would recreate the original bug in
 * miniature. A failure keeps the reason in `title`, since "unreachable" and
 * "unreachable because the password was rotated" call for different fixes.
 */
function HealthBadge({ projectId, databaseId }: { projectId: string; databaseId: string }) {
  const { data, error, isPending, isFetching } = useQuery({
    queryKey: ['database-health', projectId, databaseId],
    queryFn: () => getDatabaseHealth(projectId, databaseId),
    // Cheap (one `SELECT 1`), but not free — a background re-check every 30s is enough
    // to notice a tunnel dropping without hammering the server.
    refetchInterval: 30_000,
    staleTime: 15_000,
    // One retry, because the portal's own dev server restarting is a normal event and
    // a single failed request should not pin a badge for the next 30 seconds.
    retry: 1,
  })

  if (isPending) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" /> checking…
      </span>
    )
  }
  // "We couldn't ASK" is not "it's DOWN". Collapsing the two was wrong in the exact way
  // the old hard-coded badge was wrong, only inverted: the portal restarting made a
  // perfectly healthy database show red. Verified — the endpoint answered ok while the
  // card read "unreachable", because the request that failed was the page's own.
  if (error) {
    return (
      <span
        title={`Could not check this database: ${error instanceof Error ? error.message : 'request failed'}`}
        className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400"
      >
        <AlertTriangle className="h-3 w-3" /> status unknown
      </span>
    )
  }
  if (!data.ok) {
    return (
      <span
        title={data.error ? `Cannot reach this database: ${data.error}` : 'Cannot reach this database'}
        className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-500/15 dark:text-red-400"
      >
        <Unlink className="h-3 w-3" /> unreachable
      </span>
    )
  }
  return (
    <span
      title={`Reachable — responded in ${data.ms} ms`}
      className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400"
    >
      <Link2 className={cn('h-3 w-3', isFetching && 'animate-pulse')} /> connected
    </span>
  )
}

/** Status card for one connected database. */
function ConnectedCard({
  conn,
  projectId,
  kinds,
  onSync,
  syncing,
  onDisconnect,
  disconnecting,
  onChange,
  busy,
}: {
  conn: DatabaseConn
  projectId: string
  kinds: DbKindInfo[]
  onSync: () => void
  syncing: boolean
  onDisconnect: () => void
  disconnecting: boolean
  onChange: () => void
  busy: boolean
}) {
  const target = `${conn.host}:${conn.port}`

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Database className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-foreground px-2.5 py-0.5 text-[11px] font-semibold text-background">
                <Tag className="h-3 w-3" /> {conn.tag}
              </span>
              <span className="text-sm font-semibold tracking-tight">
                {kindLabel(kinds, conn.kind)}
              </span>
              <HealthBadge projectId={projectId} databaseId={conn.id} />
              {conn.hasPassword && (
                <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                  <Lock className="h-3 w-3" /> password saved
                </span>
              )}
            </div>
            <div className="mt-1 block truncate font-mono text-xs text-muted-foreground" title={`${target} · ${conn.database}`}>
              {`${conn.username ? `${conn.username}@` : ''}${target}/${conn.database}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={onSync}
              disabled={busy || syncing}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Sync
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Stat icon={Server} label="Server" value={conn.serverVersion || '—'} />
          <Stat icon={Table2} label="Tables mapped" value={conn.tableCount ? String(conn.tableCount) : '—'} />
          <Stat icon={RefreshCw} label="Last synced" value={conn.lastSync ? timeAgo(conn.lastSync) : '—'} />
          <Stat
            icon={KeyRound}
            label="Access"
            value={conn.credential ? conn.credential.label : 'no password'}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <Link
            to="/instructions?tab=knowledge"
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium text-primary hover:underline"
          >
            <FileText className="size-3.5" /> View schema map in Knowledge
          </Link>
          <div className="ml-auto flex items-center gap-2">
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
              {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <Unlink className="size-3.5" />}
              Disconnect
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

const TAG_SUGGESTIONS = ['Backend DB', 'Analytics DB', 'Staging DB', 'Read replica']

interface ConnectFormInitial {
  kind: DbKind
  host: string
  port: number
  database: string
  username: string
  ssl: boolean
  tag: string
  hasPassword: boolean
  password: string
}

interface TestOutcome {
  ok: boolean
  serverVersion?: string
  tableCount?: number
  error?: string
}

/** The connect / add-database / edit-&-reconnect form. */
function ConnectForm({
  busy,
  kinds,
  initial,
  onSubmit,
  onTest,
  onCancel,
}: {
  busy: boolean
  kinds: DbKindInfo[]
  initial?: ConnectFormInitial
  onSubmit: (body: {
    kind: DbKind
    host?: string
    port?: number
    database: string
    username?: string
    password?: string
    ssl?: boolean
    tag?: string
  }) => void
  onTest: (body: {
    kind: DbKind
    host?: string
    port?: number
    database: string
    username?: string
    password?: string
    ssl?: boolean
  }) => Promise<TestOutcome>
  onCancel?: () => void
}) {
  const changing = Boolean(initial)
  const [kind, setKind] = useState<DbKind>(initial?.kind ?? 'postgres')
  const [host, setHost] = useState(initial?.host ?? '')
  const [port, setPort] = useState(initial?.port ? String(initial.port) : '')
  const [database, setDatabase] = useState(initial?.database ?? '')
  const [username, setUsername] = useState(initial?.username ?? '')
  const [password, setPassword] = useState(initial?.password ?? '')
  const [showPassword, setShowPassword] = useState(false)
  const [ssl, setSsl] = useState(initial?.ssl ?? false)
  const [tag, setTag] = useState(initial?.tag ?? '')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const kindInfo = kinds.find((k) => k.value === kind)
  const portPlaceholder = kindInfo?.defaultPort ? String(kindInfo.defaultPort) : 'default'

  const canSubmit = !busy && !testing && database.trim().length > 0 && host.trim().length > 0
  const canTest = canSubmit

  // The current form values as a connect/test body (tag/databaseId added by the parent).
  function currentBody() {
    return {
      kind,
      host: host.trim() || undefined,
      port: port.trim() ? Number(port) : undefined,
      database: database.trim(),
      username: username.trim() || undefined,
      password: password.trim() || undefined,
      ssl,
    }
  }

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await onTest(currentBody())
      setTestResult(
        r.ok
          ? { ok: true, text: `${r.serverVersion ?? 'Connected'} · ${r.tableCount ?? 0} tables` }
          : { ok: false, text: r.error ?? 'Connection failed' },
      )
    } catch (e) {
      setTestResult({ ok: false, text: e instanceof Error ? e.message : 'Connection failed' })
    } finally {
      setTesting(false)
    }
  }

  function copyPassword() {
    if (!password) return
    void navigator.clipboard
      .writeText(password)
      .then(() => toast.success('Password copied'))
      .catch(() => toast.error('Could not copy the password'))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-2xl border border-amber-200/70 bg-amber-50 px-3 py-2.5 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="min-w-0">
          <span className="font-semibold">Don't connect a production database.</span> Use a staging,
          development, or read-only replica instead. The portal only reads the schema, but production
          credentials should never leave that environment — a leaked or misused connection can expose
          real customer data.
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Database type</Label>
          <Select value={kind} onValueChange={(v) => setKind(v as DbKind)}>
            <SelectTrigger className="rounded-xl">
              <SelectValue placeholder="Choose a database" />
            </SelectTrigger>
            <SelectContent>
              {kinds.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="db-tag" className="flex items-center gap-1.5">
            <Tag className="h-3 w-3" /> Tag {changing ? '' : '(what this DB is)'}
          </Label>
          <Input
            id="db-tag"
            placeholder="e.g. Backend DB"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            className="text-sm"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
          />
        </div>
      </div>

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
        <span className="text-[11px] text-muted-foreground">Empty = named after the database.</span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="db-host">Host</Label>
          <Input
            id="db-host"
            placeholder="localhost or db.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="db-port">Port</Label>
          <Input
            id="db-port"
            placeholder={portPlaceholder}
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
            className="font-mono text-sm"
            inputMode="numeric"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="db-name">Database name</Label>
          <Input
            id="db-name"
            placeholder="app_production"
            value={database}
            onChange={(e) => setDatabase(e.target.value)}
            className="font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="db-user">Username</Label>
          <Input
            id="db-user"
            placeholder="db user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="text-sm"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="db-password" className="flex items-center gap-1.5">
          <Lock className="h-3 w-3" /> Password
        </Label>
        <div className="relative">
          <Input
            id="db-password"
            type={showPassword ? 'text' : 'password'}
            placeholder={
              changing && initial?.hasPassword ? 'leave empty to keep the saved password' : 'database password'
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="pr-16 font-mono text-sm"
            autoComplete="off"
            spellCheck={false}
          />
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              disabled={!password}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title={showPassword ? 'Hide password' : 'Show password'}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
            <button
              type="button"
              onClick={copyPassword}
              disabled={!password}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              title="Copy password"
              aria-label="Copy password"
            >
              <Clipboard className="size-3.5" />
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={() => setSsl((s) => !s)}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 active:scale-[0.98]',
          ssl
            ? 'border-foreground bg-foreground text-background'
            : 'border-border/60 bg-muted/50 text-muted-foreground hover:border-border hover:text-foreground',
        )}
      >
        <Lock className="size-3.5" />
        {ssl ? 'SSL/TLS enabled' : 'Use SSL/TLS'}
      </button>

      {testResult && (
        <div
          className={cn(
            'flex items-start gap-2 rounded-2xl border px-3 py-2 text-xs',
            testResult.ok
              ? 'border-emerald-200/70 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300'
              : 'border-red-200/70 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
          )}
        >
          {testResult.ok ? (
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span className="min-w-0 break-words">
            {testResult.ok ? 'Connection succeeded — ' : 'Connection failed — '}
            {testResult.text}
          </span>
        </div>
      )}

      <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
        <Lock className="mt-0.5 h-3 w-3 shrink-0" />
        The password is stored locally on this machine only — never in the portal database or any log.
        The connection is used read-only, to read the schema for Claude.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={runTest}
          disabled={!canTest}
          className="gap-1.5 rounded-full active:scale-[0.98]"
        >
          {testing ? <Loader2 className="size-4 animate-spin" /> : <Plug className="size-4" />}
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
        <Button
          onClick={() => onSubmit({ ...currentBody(), tag: tag.trim() || undefined })}
          disabled={!canSubmit}
          className="gap-1.5 rounded-full active:scale-[0.98]"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          {busy ? 'Connecting…' : changing ? 'Save & reconnect' : 'Connect & map schema'}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy} className="rounded-full active:scale-[0.98]">
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

/** Render a cell value from a query result grid. */
function renderCell(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="text-muted-foreground/50 italic">null</span>
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  const s = String(v)
  return (
    <span className="block max-w-[28rem] truncate" title={s}>
      {s}
    </span>
  )
}

/** The columns/rows grid shared by the SQL editor and the AI answer. */
function ResultsTable({ result }: { result: DbQueryResult }) {
  if (result.columns.length === 0 && result.rowCount === 0) {
    return <p className="px-1 py-3 text-sm text-muted-foreground">Query ran — no rows returned.</p>
  }
  return (
    <div className="space-y-2">
      <div className="max-h-[26rem] overflow-auto rounded-2xl border border-border/60">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <TableRow>
              <TableHead className="w-10 text-right text-[10px] text-muted-foreground/70">#</TableHead>
              {result.columns.map((c, i) => (
                <TableHead key={i} className="whitespace-nowrap font-mono text-xs font-semibold">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row, ri) => (
              <TableRow key={ri}>
                <TableCell className="text-right text-[10px] tabular-nums text-muted-foreground/60">
                  {ri + 1}
                </TableCell>
                {row.map((val, ci) => (
                  <TableCell key={ci} className="whitespace-nowrap font-mono text-xs">
                    {renderCell(val)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[11px] text-muted-foreground">
          {result.truncated
            ? `Showing the first ${result.rows.length} rows (result was capped).`
            : `${result.rowCount} row${result.rowCount === 1 ? '' : 's'}.`}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <ToolbarButton
            onClick={() => {
              void navigator.clipboard
                .writeText(toCsv(result))
                .then(() => toast.success('Results copied as CSV'))
            }}
            icon={Clipboard}
            label="Copy CSV"
          />
          <ToolbarButton onClick={() => downloadCsv(result)} icon={Download} label="Download CSV" />
        </div>
      </div>
    </div>
  )
}

/**
 * RFC-4180 CSV: quote every field and double the inner quotes. Always quoting is the
 * safe choice — a value containing a comma, a newline or a quote is exactly the kind
 * of real data (an address, a note, a JSON blob) that silently corrupts a hand-rolled
 * export, and a spreadsheet reads fully-quoted fields identically.
 */
function toCsv(result: DbQueryResult): string {
  const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return [
    result.columns.map(cell).join(','),
    ...result.rows.map((r) => r.map(cell).join(',')),
  ].join('\r\n')
}

function downloadCsv(result: DbQueryResult): void {
  // Leading BOM so Excel opens it as UTF-8 — without it, accented and Vietnamese
  // names come out as mojibake. Escaped, not literal: an invisible character in the
  // source is unreadable and lint rejects it.
  const blob = new Blob([`\uFEFF${toCsv(result)}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `query-results-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

/** Read-only SQL block with a copy button (shows the AI-generated query). */
function SqlBlock({ sql }: { sql: string }) {
  return (
    <div className="relative rounded-2xl border border-border/60 bg-muted/50 p-3">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(sql).then(() => toast.success('SQL copied'))
        }}
        className="absolute right-2 top-2 flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
        title="Copy SQL"
        aria-label="Copy SQL"
      >
        <Clipboard className="size-3.5" />
      </button>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words pr-8 font-mono text-xs text-foreground">
        {sql}
      </pre>
    </div>
  )
}

/**
 * Copy for each way the read-only guard can refuse, keyed by `blocked.kind`.
 *
 * A refused write is NOT an error the engineer can retry their way out of, so it gets
 * a dialog rather than the inline red strip every other failure uses: it has to be
 * impossible to mistake for "the connection dropped, try again". The wording says what
 * was detected, that nothing was sent, and where to go instead — a block with no
 * alternative just reads as the tool being broken.
 */
const BLOCKED_COPY: Record<
  DbBlocked['kind'],
  { title: string; body: string; alt?: string }
> = {
  'write-keyword': {
    title: 'This query would modify data',
    body: 'The Database page is read-only by design — it runs SQL that nobody has reviewed, against a live database. The statement was not sent.',
    alt: 'Need to write? Use the Terminal page, where you are driving the client yourself.',
  },
  'not-select': {
    title: 'Only read-only queries can run here',
    body: 'A statement here has to start with SELECT, WITH, SHOW or EXPLAIN. The statement was not sent.',
    alt: 'Need to write? Use the Terminal page, where you are driving the client yourself.',
  },
  'write-intent': {
    title: 'That asks to change the database',
    body: 'The AI on this page only ever writes read-only SELECTs, so it did not draft that statement and nothing was sent.',
    alt: 'Need to write? Use the Terminal page, where you are driving the client yourself.',
  },
  'multi-statement': {
    title: 'One statement at a time',
    body: 'Several statements were found. Only a single statement is allowed, so that a read-only SELECT cannot carry a second, hidden one. Nothing was sent.',
  },
  lock: {
    title: 'Locking clauses are not allowed',
    body: 'FOR UPDATE and FOR SHARE take write locks on rows in a live database. Nothing was sent.',
  },
  empty: { title: 'Nothing to run', body: 'Type a query first.' },
}

/**
 * The "this would modify data" stop. Confirming does NOT run anything — there is no
 * write path on this page to confirm INTO — so the only actions are acknowledging it
 * and, when the AI offered one, running a SELECT that shows the rows the refused
 * change would have hit. That preview is the useful half of the request: you usually
 * want to see those rows before touching them anyway.
 */
function WriteBlockedDialog({
  blocked,
  attempted,
  databaseLabel,
  onClose,
  onUsePreview,
}: {
  blocked: DbBlocked | null
  attempted?: string | null
  databaseLabel: string
  onClose: () => void
  onUsePreview: (sql: string) => void
}) {
  const copy = blocked ? BLOCKED_COPY[blocked.kind] : null
  return (
    <Dialog open={!!blocked} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg rounded-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="size-4" />
            </span>
            {copy?.title ?? 'Query blocked'}
          </DialogTitle>
          <DialogDescription className="pt-1 text-left">{copy?.body}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {blocked?.keyword && (
            <div className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Detected</span>
              <code className="rounded-lg bg-destructive/10 px-2 py-0.5 font-mono font-semibold text-destructive">
                {blocked.keyword}
              </code>
            </div>
          )}

          <div className="rounded-2xl border border-border/60 bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Nothing ran against <span className="font-medium text-foreground">{databaseLabel}</span>.
          </div>

          {attempted && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                What was blocked
              </div>
              <pre className="max-h-32 overflow-auto rounded-2xl border border-border/60 bg-muted/50 p-3 font-mono text-xs">
                {attempted}
              </pre>
            </div>
          )}

          {blocked?.preview && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                You can look at those rows instead
              </div>
              <pre className="max-h-32 overflow-auto rounded-2xl border border-border/60 bg-muted/50 p-3 font-mono text-xs">
                {blocked.preview}
              </pre>
            </div>
          )}

          {copy?.alt && <p className="text-xs text-muted-foreground">{copy.alt}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {blocked?.preview && (
            <Button
              variant="outline"
              className="rounded-full active:scale-[0.98]"
              onClick={() => onUsePreview(blocked.preview!)}
            >
              <Eye className="size-4" />
              Show those rows
            </Button>
          )}
          <Button className="rounded-full active:scale-[0.98]" onClick={onClose}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Recent queries, per project AND database — history from another DB is noise here. */
const SQL_HISTORY_PREFIX = 'qc.databaseSqlHistory.'
const MAX_HISTORY = 25

function loadHistory(projectId: string, databaseId: string): string[] {
  try {
    const raw = localStorage.getItem(`${SQL_HISTORY_PREFIX}${projectId}.${databaseId}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return [] // a corrupt entry must never take the editor down with it
  }
}

function saveHistory(projectId: string, databaseId: string, list: string[]): void {
  try {
    localStorage.setItem(`${SQL_HISTORY_PREFIX}${projectId}.${databaseId}`, JSON.stringify(list))
  } catch {
    /* quota — history is a convenience, not state the editor depends on */
  }
}

/** `SELECT TOP 100 * FROM x` on SQL Server, `… LIMIT 100` everywhere else. */
function previewSql(kind: DbKind, table: string): string {
  return kind === 'sqlserver'
    ? `SELECT TOP 100 * FROM ${table}`
    : `SELECT * FROM ${table} LIMIT 100`
}

/**
 * The SQL editor half of the console: schema browser + editor + toolbar.
 *
 * The schema is fetched once per database per session (`staleTime: Infinity`) and is
 * what both the completion menu and the browser read. It is deliberately NOT required:
 * a schema that fails to load costs suggestions, never the ability to run a query —
 * so every consumer below treats `tables` as possibly empty rather than gating on it.
 */
function SqlWorkbench({
  projectId,
  database,
  sql,
  onSqlChange,
  onRun,
  running,
  disabled,
}: {
  projectId: string
  database: DatabaseConn
  sql: string
  onSqlChange: (next: string) => void
  onRun: () => void
  running: boolean
  disabled: boolean
}) {
  const [showSchema, setShowSchema] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<string[]>(() => loadHistory(projectId, database.id))

  // Re-read when the target database changes, without an effect: history belongs to
  // the pair, and the pair is derivable during render.
  const [seenDb, setSeenDb] = useState(database.id)
  if (seenDb !== database.id) {
    setSeenDb(database.id)
    setHistory(loadHistory(projectId, database.id))
    setHistoryOpen(false)
  }

  const {
    data: schema,
    isLoading: schemaLoading,
    error: schemaError,
    refetch: refetchSchema,
    isFetching: schemaFetching,
  } = useQuery({
    queryKey: ['database-schema', projectId, database.id],
    queryFn: () => getDatabaseSchema(projectId, database.id),
    staleTime: Infinity, // one introspection per session; "Refresh" is explicit
    retry: false,
  })
  const tables: SchemaTable[] = useMemo(() => schema?.tables ?? [], [schema])

  const remember = (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    // Most-recent-first, no duplicates — re-running a query should move it up the
    // list, not add a second copy of it.
    const next = [trimmed, ...history.filter((h) => h !== trimmed)].slice(0, MAX_HISTORY)
    setHistory(next)
    saveHistory(projectId, database.id, next)
  }

  const runNow = () => {
    if (disabled || running || !sql.trim()) return
    remember(sql)
    onRun()
  }

  const runTable = (t: SchemaTable) => {
    const q = previewSql(database.kind, t.name)
    onSqlChange(q)
    remember(q)
    // Let the new SQL land in the parent's state before the parent reads it to run.
    requestAnimationFrame(onRun)
  }

  /** Insert at the caret if the editor has focus, else append — never overwrite. */
  const insertAtCaret = (text: string) => {
    const ta = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="SQL query"]')
    if (!ta || document.activeElement !== ta) {
      onSqlChange(sql ? `${sql}${sql.endsWith(' ') ? '' : ' '}${text}` : text)
      return
    }
    const at = ta.selectionStart
    onSqlChange(sql.slice(0, at) + text + sql.slice(ta.selectionEnd))
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(at + text.length, at + text.length)
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
        {showSchema && (
          // A DEFINITE height, not `h-auto`: the panel's inner list is `overflow-auto`,
          // which only scrolls against a bounded parent. With auto height it grew to
          // fit all 158 tables and pushed the toolbar and results off the page.
          <div className="h-64 w-full shrink-0 lg:h-80 lg:w-64">
            <SchemaBrowser
              tables={tables}
              onInsert={insertAtCaret}
              onSelectTable={runTable}
              loading={schemaLoading}
              error={schemaError ? (schemaError as Error).message : null}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <SqlEditor
            value={sql}
            onChange={onSqlChange}
            onRun={runNow}
            tables={tables}
            disabled={disabled}
            placeholder={previewSql(database.kind, tables[0]?.name ?? 'your_table')}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={runNow}
          disabled={disabled || running || !sql.trim()}
          className="gap-1.5 rounded-full active:scale-[0.98]"
        >
          {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
          {running ? 'Running…' : 'Run query'}
        </Button>

        <ToolbarButton
          onClick={() => setShowSchema((v) => !v)}
          icon={showSchema ? PanelLeftClose : PanelLeftOpen}
          label={showSchema ? 'Hide schema' : 'Schema'}
        />
        <div className="relative">
          <ToolbarButton
            onClick={() => setHistoryOpen((v) => !v)}
            icon={History}
            label={`History${history.length ? ` (${history.length})` : ''}`}
            disabled={history.length === 0}
          />
          {historyOpen && history.length > 0 && (
            <>
              {/* Click-anywhere-else closes it. Behind the panel, so a pick still lands. */}
              <div className="fixed inset-0 z-20" onClick={() => setHistoryOpen(false)} />
              <div className="absolute bottom-full left-0 z-30 mb-1 max-h-72 w-[min(34rem,80vw)] overflow-auto rounded-2xl border border-border/60 bg-popover p-1 shadow-lg">
                {history.map((h, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => {
                      onSqlChange(h)
                      setHistoryOpen(false)
                    }}
                    className="block w-full truncate rounded-xl px-2 py-1.5 text-left font-mono text-[11px] transition-colors hover:bg-accent"
                    title={h}
                  >
                    {h.replace(/\s+/g, ' ')}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <ToolbarButton
          onClick={() => refetchSchema()}
          icon={RefreshCw}
          label={schemaFetching ? 'Reading…' : 'Refresh schema'}
          disabled={schemaFetching}
        />
        <ToolbarButton onClick={() => onSqlChange('')} icon={Eraser} label="Clear" disabled={!sql} />

        <span className="text-[11px] text-muted-foreground">
          {tables.length > 0
            ? `${tables.length} tables · ⌘/Ctrl+Enter to run · ⌃Space for suggestions`
            : 'A single read-only statement. ⌘/Ctrl+Enter to run.'}
        </span>
      </div>
    </div>
  )
}

/** Quiet pill button for the editor toolbar — secondary to the solid Run button. */
function ToolbarButton({
  onClick,
  icon: Icon,
  label,
  disabled,
}: {
  onClick: () => void
  icon: typeof Play
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:border-border hover:text-foreground active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

/**
 * The "query & ask" console below the connections: an AI chat that turns a question
 * into a read-only query, and a manual SQL editor. All execution is read-only server-side.
 */
function QueryConsole({
  projectId,
  databases,
  disabled,
}: {
  projectId: string
  databases: DatabaseConn[]
  disabled: boolean
}) {
  const [mode, setMode] = useState<'ask' | 'sql'>('ask')
  // Remembered per project: with more than one database connected, a reload silently
  // reset this to the first one — so the next question ran against a different
  // database than the one on screen a moment ago, and nothing said it had moved.
  const [databaseId, setDatabaseId] = useState(
    () => localStorage.getItem(QUERY_DB_PREFIX + projectId) ?? databases[0]?.id ?? '',
  )
  const pickDatabase = (id: string) => {
    setDatabaseId(id)
    localStorage.setItem(QUERY_DB_PREFIX + projectId, id)
  }
  const [question, setQuestion] = useState('')
  const [sql, setSql] = useState('')
  const [ranSql, setRanSql] = useState<string | null>(null)
  const [result, setResult] = useState<DbQueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A refusal by the read-only guard is held separately from `error`: it opens a
  // dialog instead of the inline strip, so it can't read as a transient failure.
  const [blocked, setBlocked] = useState<DbBlocked | null>(null)
  const [blockedSql, setBlockedSql] = useState<string | null>(null)

  // Keep a valid selection as connections change.
  const selected = databases.find((d) => d.id === databaseId) ?? databases[0]
  useEffect(() => {
    if (!databases.some((d) => d.id === databaseId) && databases[0]) setDatabaseId(databases[0].id)
  }, [databases, databaseId])

  const clearOutput = () => {
    setError(null)
    setBlocked(null)
    setBlockedSql(null)
    setResult(null)
    setRanSql(null)
  }

  const ask = useMutation({
    mutationFn: () => askDatabase(projectId, selected!.id, question.trim()),
    onMutate: clearOutput,
    onSuccess: (res) => {
      if (res.ok && res.result) {
        setRanSql(res.sql ?? null)
        setResult(res.result)
      } else if (res.blocked) {
        // The SQL is echoed only when the model actually wrote one; a refused
        // QUESTION has none, and showing an empty "what was blocked" box would
        // suggest something was drafted and sent.
        setBlockedSql(res.sql ?? null)
        setBlocked(res.blocked)
      } else {
        setRanSql(res.sql ?? null)
        setError(res.error ?? 'The AI could not answer that question.')
      }
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Request failed'),
  })

  const run = useMutation({
    // Takes an override so the preview SELECT can be run in the same tick it is put
    // into the editor — reading `sql` state there would still hold the old value.
    mutationFn: (override?: string) => runDatabaseQuery(projectId, selected!.id, override ?? sql),
    onMutate: clearOutput,
    onSuccess: (res) => {
      if (res.ok && res.result) setResult(res.result)
      else if (res.blocked) {
        setBlockedSql(sql)
        setBlocked(res.blocked)
      } else setError(res.error ?? 'Query failed.')
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Request failed'),
  })

  const busy = ask.isPending || run.isPending
  if (!selected) return null

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight">Query your data</div>
            <div className="text-xs text-muted-foreground">
              Ask a question in plain language, or run your own SQL. Read-only — SELECTs only.
            </div>
          </div>
          {databases.length > 1 && (
            <div className="ml-auto min-w-[12rem]">
              <Select value={selected.id} onValueChange={pickDatabase}>
                <SelectTrigger className="h-9 rounded-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {databases.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.tag} · {d.database}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div className="inline-flex rounded-full border border-border/60 bg-muted/50 p-0.5">
          {(
            [
              { key: 'ask', label: 'Ask AI', icon: Sparkles },
              { key: 'sql', label: 'SQL editor', icon: SquareTerminal },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setMode(t.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200 active:scale-[0.98]',
                mode === t.key
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <t.icon className="size-3.5" />
              {t.label}
            </button>
          ))}
        </div>

        {mode === 'ask' ? (
          <div className="space-y-2">
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. How many users signed up in the last 7 days? Which 10 orders are the largest?"
              rows={2}
              className="resize-y rounded-2xl text-sm"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && question.trim() && !disabled && !busy) {
                  ask.mutate()
                }
              }}
            />
            <div className="flex items-center gap-2">
              <Button
                onClick={() => ask.mutate()}
                disabled={disabled || busy || !question.trim()}
                className="gap-1.5 rounded-full active:scale-[0.98]"
              >
                {ask.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                {ask.isPending ? 'Asking…' : 'Ask'}
              </Button>
              <span className="text-[11px] text-muted-foreground">
                AI writes a read-only query, runs it, and shows the SQL + results. ⌘/Ctrl+Enter to send.
              </span>
            </div>
          </div>
        ) : (
          <SqlWorkbench
            projectId={projectId}
            database={selected}
            sql={sql}
            onSqlChange={setSql}
            onRun={() => run.mutate(undefined)}
            running={run.isPending}
            disabled={disabled || busy}
          />
        )}

        {ranSql && mode === 'ask' && (
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Generated SQL
            </div>
            <SqlBlock sql={ranSql} />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-2xl border border-red-200/70 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        {result && <ResultsTable result={result} />}

        <WriteBlockedDialog
          blocked={blocked}
          attempted={blockedSql}
          databaseLabel={`${selected.tag} · ${selected.database}`}
          onClose={() => setBlocked(null)}
          onUsePreview={(previewSql) => {
            setBlocked(null)
            setSql(previewSql)
            setMode('sql')
            run.mutate(previewSql)
          }}
        />
      </CardContent>
    </Card>
  )
}

export default function DatabasePage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const [jobId, setJobId] = useState<string | null>(() => loadActiveJobId(activeProjectId))
  // '' = no form; 'new' = add another database; else the databaseId being re-pointed.
  const [formFor, setFormFor] = useState<'' | 'new' | string>('')
  const [syncingId, setSyncingId] = useState<string | null>(null)

  // Reset per-project state when the active project changes.
  const [seenProject, setSeenProject] = useState(activeProjectId)
  if (seenProject !== activeProjectId) {
    setSeenProject(activeProjectId)
    setJobId(loadActiveJobId(activeProjectId))
    setFormFor('')
    setSyncingId(null)
  }

  const { data: info } = useQuery({
    queryKey: ['databases', activeProjectId],
    queryFn: () => getDatabases(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  const { data: jobData } = useQuery({
    queryKey: ['database-job', jobId, activeProjectId],
    queryFn: () => getDatabaseJob(jobId as string, activeProjectId as string),
    enabled: !!jobId && !!activeProjectId,
    refetchInterval: (q) => (q.state.data?.job.status === 'running' ? 1500 : false),
  })
  const job = jobData?.job
  const running = job?.status === 'running'

  const lastStatus = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (job && job.status !== 'running' && lastStatus.current === 'running') {
      queryClient.invalidateQueries({ queryKey: ['databases', activeProjectId] })
      setSyncingId(null)
    }
    lastStatus.current = job?.status
  }, [job, activeProjectId, queryClient])

  const connect = useMutation({
    mutationFn: (body: {
      kind: DbKind
      host?: string
      port?: number
      database: string
      username?: string
      password?: string
      ssl?: boolean
      tag?: string
      databaseId?: string
    }) => connectDatabase({ projectId: activeProjectId as string, ...body }),
    onSuccess: (res) => {
      setJobId(res.jobId)
      saveActiveJobId(activeProjectId as string, res.jobId)
      setFormFor('')
    },
    onError: (e) =>
      toast.error('Could not start connection', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const sync = useMutation({
    mutationFn: (databaseId: string) => syncDatabase(activeProjectId as string, databaseId),
    onMutate: (databaseId) => setSyncingId(databaseId),
    onSuccess: (res) => {
      setJobId(res.jobId)
      saveActiveJobId(activeProjectId as string, res.jobId)
    },
    onError: (e) => {
      setSyncingId(null)
      toast.error('Could not start sync', {
        description: e instanceof Error ? e.message : 'Unknown error',
      })
    },
  })

  const disconnect = useMutation({
    mutationFn: (databaseId: string) => disconnectDatabase(activeProjectId as string, databaseId),
    onSuccess: () => {
      toast.success('Database disconnected')
      setFormFor('')
      queryClient.invalidateQueries({ queryKey: ['databases', activeProjectId] })
      queryClient.invalidateQueries({ queryKey: ['knowledge', activeProjectId] })
    },
    onError: (e) =>
      toast.error('Could not disconnect', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const databases = info?.databases ?? []
  const kinds = info?.kinds ?? []
  const changingDb =
    formFor && formFor !== 'new' ? (databases.find((d) => d.id === formFor) ?? null) : null

  // Edit & reconnect: load the stored password so the form opens prefilled.
  const { data: credData } = useQuery({
    queryKey: ['database-credential', changingDb?.id, activeProjectId],
    queryFn: () => getDatabaseCredential(activeProjectId as string, changingDb!.id),
    enabled: Boolean(changingDb?.hasPassword && activeProjectId),
    staleTime: 0,
    gcTime: 0, // never cache a secret
  })

  if (!activeProjectId || !activeProject) {
    return (
      <div className="space-y-6">
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            Select a project to connect its database.
          </CardContent>
        </Card>
      </div>
    )
  }

  const connected = databases.length > 0
  const credReady = !changingDb?.hasPassword || Boolean(credData)
  const busy = running || connect.isPending

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Database className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Database</h1>
            <p className="text-sm text-muted-foreground">
              Connect this project's databases — tag each one (Backend DB, Analytics DB, …). On every
              sync the portal reads the schema and writes a{' '}
              <Link
                to="/instructions?tab=knowledge"
                className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
              >
                <FileText className="h-3.5 w-3.5" /> schema map into Knowledge
              </Link>{' '}
              so Claude uses the real tables & columns when writing test cases and running QC.
            </p>
            <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              Connect a staging or development database — never production.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
          <span className="flex items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Server className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                Databases for
              </span>
              <span className="block text-sm font-semibold tracking-tight">{activeProject.name}</span>
            </span>
          </span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5 text-primary/70" />
            {/* A COUNT, not a claim about reachability — that's each card's live badge
                to make. This header said "2 connected" while one of the two servers
                was switched off. */}
            {connected
              ? `${databases.length} ${databases.length === 1 ? 'database' : 'databases'}`
              : 'none connected'}
          </span>
        </div>
      </header>

      {databases.map((conn) => (
        <ConnectedCard
          key={conn.id}
          conn={conn}
          projectId={activeProjectId as string}
          kinds={kinds}
          onSync={() => sync.mutate(conn.id)}
          syncing={(running || sync.isPending) && syncingId === conn.id}
          onDisconnect={() => disconnect.mutate(conn.id)}
          disconnecting={disconnect.isPending && disconnect.variables === conn.id}
          onChange={() => setFormFor(conn.id)}
          busy={busy || sync.isPending}
        />
      ))}

      {connected && (
        <QueryConsole projectId={activeProjectId} databases={databases} disabled={busy} />
      )}

      {connected ? (
        <Button
          variant="outline"
          onClick={() => setFormFor('new')}
          disabled={busy}
          className="gap-1.5 rounded-full active:scale-[0.98]"
        >
          <Plus className="size-4" /> Add database
        </Button>
      ) : (
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <Database className="h-6 w-6" />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-semibold tracking-tight">No database connected yet</p>
              <p className="max-w-md text-sm text-muted-foreground">
                Connect a MySQL, PostgreSQL, SQL Server, or SQLite database so Claude can read its
                real schema when writing test cases and running QC.
              </p>
            </div>
            <Button
              onClick={() => setFormFor('new')}
              disabled={busy}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              <Link2 className="size-4" /> Connect database
            </Button>
          </CardContent>
        </Card>
      )}

      <Dialog open={formFor !== ''} onOpenChange={(open) => !open && !busy && setFormFor('')}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {changingDb ? `Edit & reconnect — ${changingDb.tag}` : 'Connect a database'}
            </DialogTitle>
            <DialogDescription>
              {changingDb
                ? 'Change the connection details, then reconnect and re-map the schema.'
                : 'Connect a database so Claude can read its schema. The connection is read-only.'}
            </DialogDescription>
          </DialogHeader>
          {credReady ? (
            <ConnectForm
              key={formFor || 'closed'}
              busy={busy}
              kinds={kinds}
              initial={
                changingDb
                  ? {
                      kind: changingDb.kind,
                      host: changingDb.host,
                      port: changingDb.port,
                      database: changingDb.database,
                      username: changingDb.username,
                      ssl: changingDb.ssl,
                      tag: changingDb.tag,
                      hasPassword: changingDb.hasPassword,
                      password: credData?.password ?? '',
                    }
                  : undefined
              }
              onSubmit={(body) =>
                connect.mutate({ ...body, databaseId: changingDb ? changingDb.id : undefined })
              }
              onTest={(body) =>
                testDatabaseConnection({
                  projectId: activeProjectId,
                  ...body,
                  databaseId: changingDb ? changingDb.id : undefined,
                })
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

      {job && (job.logs.length > 0 || running) && <JobLogPanel logs={job.logs} running={running} />}
    </div>
  )
}
