import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Braces,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Figma,
  FileJson,
  FolderGit2,
  FolderOpen,
  Info,
  KeyRound,
  LayoutGrid,
  LogOut,
  ListChecks,
  Loader2,
  Maximize2,
  MonitorPlay,
  MousePointerClick,
  PencilLine,
  Play,
  Plug,
  PlugZap,
  Plus,
  Search,
  Smartphone,
  Square,
  SquareKanban,
  Unplug,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  addMcp,
  cancelMcpSignin,
  getMcpSignin,
  importMcp,
  logoutMcpSignin,
  pasteMcpSignin,
  startMcpSignin,
  listMcp,
  mcpHealth,
  mcpOauthStatus,
  mcpUvStatus,
  mcpMaestroStatus,
  maximizeQcBrowser,
  qcBrowserStatus,
  startQcBrowser,
  stopQcBrowser,
  updateProject,
  connectMaestro,
  openMcpFolder,
  removeMcp,
  updateMcp,
  revealMcpEnv,
  saveMcpToken,
  testMcp,
  type McpEntryInput,
  type McpOauthProvider,
} from '@/lib/api'
import type { McpServer, Project } from '@/lib/types'
import { useProjects } from '@/lib/project-context'
import {
  BUILTIN_MCP_NAMES,
  MCP_NAME_RE,
  MCP_TEMPLATES,
  MCP_TEMPLATE_CATEGORIES,
  entrySummary,
  fillTemplate,
  iconForServer,
  parsePastedMcp,
  uniqueName,
  type McpTemplate,
  type McpTemplateField,
} from '@/lib/mcpTemplates'

const OAUTH_META: Record<
  McpOauthProvider,
  { label: string; icon: typeof Figma; blurb: string; tokenHint: string }
> = {
  clickup: {
    label: 'ClickUp',
    icon: ListChecks,
    blurb: 'Tickets & tasks',
    tokenHint: 'Get a token — Settings → Apps',
  },
  figma: {
    label: 'Figma',
    icon: Figma,
    blurb: 'Design files',
    tokenHint: 'Get a token — Settings → Personal access tokens',
  },
  jira: {
    label: 'Jira',
    icon: SquareKanban,
    blurb: 'Issues & boards',
    tokenHint: 'Get a token — Atlassian → Security → API tokens',
  },
  azure: {
    label: 'Azure DevOps',
    icon: Cloud,
    blurb: 'Boards & work items',
    tokenHint: 'Get a PAT — Azure DevOps → User settings → Personal access tokens',
  },
}

// One-line "what is this server for?" copy, surfaced via the header info tooltip
// on each card so a QC engineer knows why a server matters before connecting it.
const SERVER_PURPOSE: Record<string, string> = {
  clickup:
    'Pulls QC tickets, tasks, and comments straight from ClickUp so runs and ticket crawls read requirements from the source.',
  figma:
    'Opens Figma design files so Design Check can compare the built UI against the intended design.',
  jira:
    'Pulls QC issues, stories, and their status from Jira so runs and test-case work read requirements straight from the tracker.',
  azure:
    'Pulls QC work items (bugs, user stories, tasks) from Azure DevOps Boards so runs and test-case work read requirements straight from the tracker.',
  playwright:
    'Drives a real browser — navigating, clicking, typing, screenshotting — so QC runs can exercise and verify the web app.',
  maestro:
    'Drives an iOS/Android simulator or a Chromium browser through Maestro, and can save a run as a reusable YAML flow you re-run as a regression test.',
}

/** Small info glyph with a hover/focus tooltip explaining a server's purpose. */
function PurposeTip({ name, label }: { name: string; label: string }) {
  const text = SERVER_PURPOSE[name]
  if (!text) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What ${label} is used for`}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="w-fit max-w-none whitespace-nowrap leading-relaxed">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

// Badge shown on a connected card, driven by LIVE health — not just "is it in
// .mcp.json". A server can be configured but Pending approval / Needs auth / Failed.
const CARD_STATUS: Record<string, { label: string; cls: string; Icon: typeof Figma }> = {
  connected: { label: 'Connected', cls: 'bg-emerald-50 text-emerald-700', Icon: CheckCircle2 },
  pending: { label: 'Pending approval', cls: 'bg-amber-50 text-amber-700', Icon: Clock },
  'needs-auth': { label: 'Needs auth', cls: 'bg-amber-50 text-amber-700', Icon: KeyRound },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700', Icon: AlertCircle },
}

/**
 * One server as a compact list row: icon + name, live badge, inline actions — no
 * config (tokens, commands) and no purpose text; those live in Details and the
 * name's info tooltip. Anything
 * taller — the token form, a test result, an install hint — unfolds under the row.
 * A connected server gets a faint emerald wash so live integrations stand out.
 */
function ServerRow({
  icon: Icon,
  title,
  subtitle,
  badge,
  actions,
  status,
  children,
}: {
  icon: typeof Figma
  title: ReactNode
  subtitle: string
  badge?: ReactNode
  actions?: ReactNode
  status?: string
  children?: ReactNode
}) {
  const hasBody = Array.isArray(children) ? children.some(Boolean) : !!children
  return (
    <div
      className={cn(
        'px-4 py-3 transition-colors hover:bg-muted/30',
        status === 'connected' && 'bg-emerald-500/[0.04]',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:flex-nowrap">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border bg-muted/60 text-muted-foreground',
            status === 'connected' ? 'border-emerald-500/40' : 'border-border/60',
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 leading-tight md:w-48 md:flex-none">
          <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">{title}</div>
          <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
        </div>
        <div className="flex-1" />
        <div className="flex shrink-0 items-center [&>span]:ml-0">{badge}</div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      {hasBody && <div className="mt-2.5 space-y-2 md:pl-11">{children}</div>}
    </div>
  )
}

/** A low-emphasis icon action with a tooltip, for the end of a server row. */
function RowIconButton({
  label,
  onClick,
  disabled,
  destructive,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-all duration-200 active:scale-[0.95] disabled:pointer-events-none disabled:opacity-50',
            destructive
              ? 'hover:bg-destructive/10 hover:text-destructive'
              : 'hover:bg-muted hover:text-foreground',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function playwrightArgs(headless: boolean): string[] {
  return [
    // No @latest: npx reuses the cached install instead of a per-spawn registry check.
    '@playwright/mcp',
    ...(headless ? ['--headless'] : []),
    '--no-sandbox',
    '--image-responses',
    'omit',
    '--block-service-workers',
    '--blocked-origins',
    'googletagmanager.com;google-analytics.com;doubleclick.net;facebook.net;googlesyndication.com;adservice.google.com',
    '--timeout-navigation',
    '20000',
    // NO --viewport-size. It emulates a fixed viewport over the real window, so a
    // pinned 1280x720 rendered the app in a small box on a large monitor and desktop
    // breakpoints never fired. The server adds a `--config` that opens the window
    // maximized with `viewport: null` instead (see writePlaywrightMcpConfig), or drops
    // launch flags entirely when the project attaches to the QC browser.
    // NO --user-data-dir here either. The profile directory is a fact about the machine
    // running the server, which this bundle can't know — the server appends it (see
    // normalizePlaywrightProfile in routes/mcp.ts). Hardcoding one shipped the
    // author's own home path to every install and broke Chrome with EPERM.
  ]
}

function CardStatusBadge({
  configured,
  status,
  checking,
}: {
  configured: boolean
  status?: string
  checking?: boolean
}) {
  if (checking) {
    return (
      <span className="ml-auto flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking
      </span>
    )
  }
  if (!configured) return null
  // Only badge a server when the live probe returned a recognized status
  // (connected / pending / needs-auth / failed). An unconfirmed 'unknown' health
  // shows no badge at all — we don't surface a grey "Configured" fallback.
  const s = status ? CARD_STATUS[status] : undefined
  if (!s) return null
  return (
    <span
      className={cn(
        'ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        s.cls,
      )}
    >
      <s.Icon className="h-3 w-3" />
      {s.label}
    </span>
  )
}

// Friendly labels for the known token-connect env vars, so the details dialog reads
// like the connect form ("Organization URL") instead of raw shell names.
const ENV_FIELD_LABELS: Record<string, string> = {
  CLICKUP_API_KEY: 'API token',
  CLICKUP_MCP_API_KEY: 'API token (legacy var)',
  FIGMA_API_KEY: 'API token',
  JIRA_URL: 'Site URL',
  JIRA_USERNAME: 'Account email',
  JIRA_API_TOKEN: 'API token',
  AZURE_DEVOPS_ORG_URL: 'Organization URL',
  AZURE_DEVOPS_PAT: 'Personal Access Token',
  AZURE_DEVOPS_DEFAULT_PROJECT: 'Default project',
  AZURE_DEVOPS_AUTH_METHOD: 'Auth method',
}

// Fixed, non-user-entered env vars hidden from the details dialog's field list (they
// still appear in the raw .mcp.json entry) — e.g. Azure's constant AUTH_METHOD=pat.
const HIDDEN_DETAIL_ENV = new Set(['AZURE_DEVOPS_AUTH_METHOD'])

/** A label + monospace value row with a copy button, used in the details dialog. */
function FieldRow({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string
  value: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className="min-w-0 flex-1 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px]"
        title={value}
      >
        {value}
      </span>
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )
}

/** A labeled form field (small caption above the control) for the connect forms. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

/** A labeled group of MCP cards (e.g. "Tickets & tasks") with a header + responsive grid. */
/** Mask a secret for the preview: keep the last 4 characters, like the server does. */
function maskValue(v: string): string {
  const t = v.trim()
  if (!t) return ''
  return t.length <= 4 ? '••••' : `••••${t.slice(-4)}`
}

/** A template field's input (secret fields get an eye toggle). */
function TemplateFieldInput({
  field,
  value,
  onChange,
  autoFocus,
}: {
  field: McpTemplateField
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
}) {
  const [show, setShow] = useState(false)
  if (field.kind === 'checkbox') {
    return (
      <label className="flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <span>{field.label}</span>
        <Checkbox checked={value === 'true'} onChange={(e) => onChange(e.target.checked ? 'true' : '')} />
      </label>
    )
  }
  return (
    <Field label={field.label}>
      <div className="relative">
        <Input
          autoFocus={autoFocus}
          type={field.secret && !show ? 'password' : 'text'}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={field.label}
          className={cn('h-9 text-xs', field.secret && 'pr-9 font-mono')}
        />
        {field.secret && (
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Hide value' : 'Show value'}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      {field.hint && <p className="text-[11px] leading-snug text-muted-foreground">{field.hint}</p>}
    </Field>
  )
}

/** Why a server name can't be used, or null when it can. */
function nameProblem(name: string, taken: Set<string>): string | null {
  if (!name) return 'Name is required.'
  if (!MCP_NAME_RE.test(name)) return 'Letters, numbers, - and _ only (max 64).'
  if (taken.has(name)) return `"${name}" is already in use.`
  return null
}

/**
 * "Add server": pick a ready-made template and fill its fields, or paste any MCP
 * config (JSON in the usual shapes, or a `claude mcp add` line). Either way the
 * result goes through ONE all-or-nothing import call, then every added server gets a
 * live connection test — which is also what approves a new project server.
 */
function AddServerDialog({
  open,
  onOpenChange,
  projectId,
  projectRoot,
  existingNames,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectRoot?: string
  existingNames: string[]
  onAdded: (names: string[]) => void
}) {
  const [tab, setTab] = useState<'templates' | 'paste'>('templates')
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<McpTemplate | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [pasted, setPasted] = useState('')
  // Name edits for pasted servers, keyed by the name as pasted.
  const [renames, setRenames] = useState<Record<string, string>>({})

  const taken = useMemo(() => new Set(existingNames), [existingNames])

  function pick(t: McpTemplate) {
    setPicked(t)
    setTemplateName(uniqueName(t.name, taken))
    setValues(
      Object.fromEntries(
        t.fields.map((f) => [f.key, f.prefill === 'project-root' ? (projectRoot ?? '') : '']),
      ),
    )
  }

  const parsed = useMemo(() => parsePastedMcp(pasted), [pasted])
  const pastedRows = useMemo(() => {
    if (!parsed.ok) return []
    const rows = parsed.servers.map((s) => ({ ...s, finalName: (renames[s.name] ?? s.name).trim() }))
    // A name is a problem if it is taken OR used twice within this paste.
    return rows.map((r) => {
      const others = new Set(rows.filter((o) => o !== r).map((o) => o.finalName))
      const problem =
        nameProblem(r.finalName, taken) ??
        (others.has(r.finalName) ? `"${r.finalName}" appears twice in this paste.` : null)
      return { ...r, problem }
    })
  }, [parsed, renames, taken])

  // A built-in keeps its fixed name, so only a name clash matters (the tile is
  // disabled once it is configured).
  const templateProblem = picked && !picked.builtin ? nameProblem(templateName.trim(), taken) : null
  const missingField = picked?.fields.find((f) => !f.optional && !values[f.key]?.trim())
  const templateEntry = picked ? fillTemplate(picked, values) : null

  const { data: oauth } = useQuery({
    queryKey: ['mcp-oauth', projectId],
    queryFn: () => mcpOauthStatus(projectId),
  })
  const tokenUrl = (provider?: string) =>
    oauth?.providers.find((p) => p.provider === provider)?.tokenUrl ?? ''
  // Maestro's CLI + JDK preflight boots a JVM — only while its template is open.
  const { data: maestroPf, isFetching: maestroChecking } = useQuery({
    queryKey: ['mcp-maestro'],
    queryFn: mcpMaestroStatus,
    enabled: picked?.builtin === 'maestro',
    staleTime: 60_000,
  })
  const maestroBlocked = picked?.builtin === 'maestro' && (maestroChecking || !maestroPf?.available)

  // A built-in connects through its own route, never the generic import: the token
  // routes verify + shape the entry, and Playwright's profile / Maestro's JAVA_HOME
  // are machine facts only the server knows.
  const connectBuiltin = useMutation({
    mutationFn: async (t: McpTemplate) => {
      const v = (k: string) => values[k]?.trim() ?? ''
      switch (t.builtin) {
        case 'playwright':
          await addMcp(
            { name: 'playwright', command: 'npx', args: playwrightArgs(v('HEADLESS') === 'true'), type: 'stdio' },
            projectId,
          )
          break
        case 'maestro':
          await connectMaestro(projectId)
          break
        case 'jira':
          await saveMcpToken('jira', v('TOKEN'), projectId, { url: v('URL'), email: v('EMAIL') })
          break
        case 'azure':
          await saveMcpToken('azure', v('TOKEN'), projectId, {
            orgUrl: v('ORG_URL'),
            project: v('PROJECT') || undefined,
          })
          break
        default:
          await saveMcpToken(t.builtin as McpOauthProvider, v('TOKEN'), projectId)
      }
      return t.name
    },
    onSuccess: (name) => {
      toast.success(`${picked?.label ?? name} added`, {
        description: "Saved to this project's .mcp.json — testing the connection…",
      })
      onOpenChange(false)
      onAdded([name])
    },
    onError: (err) =>
      toast.error('Could not connect', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const add = useMutation({
    mutationFn: (servers: Record<string, McpEntryInput>) => importMcp(servers, projectId),
    onSuccess: (res) => {
      toast.success(
        res.added.length === 1 ? `${res.added[0]} added` : `${res.added.length} servers added`,
        { description: "Saved to this project's .mcp.json — testing the connection…" },
      )
      onOpenChange(false)
      onAdded(res.added)
    },
    onError: (err) =>
      toast.error('Could not add server', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  function submitTemplate() {
    if (!picked || !templateEntry || templateProblem || missingField) return
    if (picked.builtin) {
      if (!maestroBlocked) connectBuiltin.mutate(picked)
      return
    }
    add.mutate({ [templateName.trim()]: templateEntry })
  }
  const pending = add.isPending || connectBuiltin.isPending

  const pasteBlocked =
    !parsed.ok || pastedRows.some((r) => r.problem || r.error) || pastedRows.length === 0
  function submitPaste() {
    if (pasteBlocked) return
    add.mutate(Object.fromEntries(pastedRows.map((r) => [r.finalName, r.entry])))
  }

  // Preview JSON with secrets masked — the template's secret fields, every header.
  const previewJson = useMemo(() => {
    if (!picked || !templateEntry) return ''
    const secretVals = picked.fields
      .filter((f) => f.secret && values[f.key]?.trim())
      .map((f) => values[f.key].trim())
    const mask = (s: string) => secretVals.reduce((acc, v) => acc.split(v).join(maskValue(v)), s)
    const shown = JSON.parse(JSON.stringify(templateEntry), (_k, v) =>
      typeof v === 'string' ? mask(v) : v,
    )
    return JSON.stringify({ [templateName.trim() || picked.name]: shown }, null, 2)
  }, [picked, templateEntry, values, templateName])

  const q = query.trim().toLowerCase()
  const visible = MCP_TEMPLATES.filter(
    (t) => !q || `${t.label} ${t.blurb} ${t.category}`.toLowerCase().includes(q),
  )

  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && !connectBuiltin.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[88vh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            Add MCP server
          </DialogTitle>
          <DialogDescription>
            Saved to this project's <code>.mcp.json</code>, then tested live.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'templates' | 'paste')} className="min-w-0">
          <TabsList className="rounded-full">
            <TabsTrigger value="templates" className="rounded-full">
              <LayoutGrid className="h-3.5 w-3.5" />
              Templates
            </TabsTrigger>
            <TabsTrigger value="paste" className="rounded-full">
              <Braces className="h-3.5 w-3.5" />
              Paste JSON
            </TabsTrigger>
          </TabsList>

          <TabsContent value="templates" className="mt-3 min-w-0">
            {!picked ? (
              <div className="space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search templates…"
                    aria-label="Search templates"
                    className="h-9 rounded-full pl-8 text-sm"
                  />
                </div>
                {MCP_TEMPLATE_CATEGORIES.map((cat) => {
                  const items = visible.filter((t) => t.category === cat)
                  if (!items.length) return null
                  return (
                    <div key={cat} className="space-y-1.5">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        {cat}
                      </div>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {items.map((t) => {
                          const added = taken.has(t.name)
                          // A built-in exists once per project, under its fixed name.
                          const locked = added && !!t.builtin
                          return (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => pick(t)}
                              disabled={locked}
                              className="flex min-w-0 items-start gap-2.5 rounded-2xl border border-border/60 p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.99] disabled:pointer-events-none disabled:opacity-55"
                            >
                              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                                <t.icon className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 flex-1 leading-tight">
                                <span className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
                                  <span className="truncate">{t.label}</span>
                                  {added && (
                                    <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                      Added
                                    </span>
                                  )}
                                </span>
                                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                                  {t.blurb}
                                </span>
                              </span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
                {!visible.length && (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No template matches — use <b>Paste JSON</b> for any other server.
                  </p>
                )}
              </div>
            ) : (
              <div className="min-w-0 space-y-3">
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => setPicked(null)}
                    aria-label="Back to templates"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/60 text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                    <picked.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="text-sm font-semibold tracking-tight">{picked.label}</div>
                    <div className="truncate text-xs text-muted-foreground">{picked.blurb}</div>
                  </div>
                  <a
                    href={picked.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Docs
                  </a>
                </div>

                {picked.builtin ? (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Saved as <code className="font-mono">{picked.name}</code> — the portal finds
                    this built-in by that name, so keep it unless you know what relies on it.
                  </p>
                ) : (
                  <Field label="Server name">
                    <Input
                      value={templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                      aria-label="Server name"
                      className="h-9 font-mono text-xs"
                    />
                    {templateProblem && (
                      <p className="text-[11px] text-red-600">{templateProblem}</p>
                    )}
                  </Field>
                )}
                {picked.fields.map((f, i) => (
                  <TemplateFieldInput
                    key={f.key}
                    field={f}
                    autoFocus={i === 0}
                    value={values[f.key] ?? ''}
                    onChange={(v) => setValues((m) => ({ ...m, [f.key]: v }))}
                  />
                ))}
                {picked.builtin && tokenUrl(picked.builtin) && (
                  <a
                    href={tokenUrl(picked.builtin)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Get a token from {picked.label}
                  </a>
                )}
                {picked.builtin === 'maestro' &&
                  (maestroChecking ? (
                    <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Checking the Maestro CLI and Java on this machine…
                    </p>
                  ) : maestroPf && !maestroPf.available ? (
                    <div className="space-y-1.5 rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700">
                      <p className="flex items-start gap-1.5">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        {maestroPf.javaHome === null && !maestroPf.defaultJavaOk
                          ? `Maestro needs Java 17+${maestroPf.javaMajor ? ` (found Java ${maestroPf.javaMajor})` : ''}. Install a JDK, then reopen this.`
                          : "The Maestro CLI isn't installed on this machine. Install it, then reopen this."}
                      </p>
                      <code className="block truncate rounded-md bg-amber-100/70 px-1.5 py-1 font-mono text-[10px] text-amber-900">
                        {maestroPf.javaHome === null && !maestroPf.defaultJavaOk
                          ? 'brew install openjdk@21'
                          : 'curl -fsSL "https://get.maestro.mobile.dev" | bash'}
                      </code>
                    </div>
                  ) : null)}
                {picked.needsUv && (
                  <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Runs through <code>uvx</code> — needs Astral's uv installed on this machine.
                  </p>
                )}
                {!picked.builtin && (
                <div className="min-w-0 space-y-1.5">
                  <span className="text-xs font-medium text-muted-foreground">.mcp.json entry</span>
                  <pre className="max-h-48 w-full min-w-0 overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100">
                    {previewJson}
                  </pre>
                </div>
                )}
              </div>
            )}
          </TabsContent>

          <TabsContent value="paste" className="mt-3 min-w-0 space-y-3">
            <Textarea
              autoFocus
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value)
                setRenames({})
              }}
              spellCheck={false}
              aria-label="MCP config to import"
              placeholder={`{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"],\n      "env": { "API_KEY": "…" }\n    }\n  }\n}\n\n…or: claude mcp add --transport http my-server https://example.com/mcp`}
              className="h-52 resize-y rounded-2xl font-mono text-[11px] leading-relaxed"
            />
            <p className="text-[11px] leading-snug text-muted-foreground">
              Accepts <code>.mcp.json</code> / Claude Desktop (<code>mcpServers</code>), VS Code
              (<code>servers</code>), a single server entry, or a <code>claude mcp add …</code> line.
            </p>
            {!parsed.ok && parsed.error && (
              <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-2.5 py-2 text-xs text-red-700">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 break-words">{parsed.error}</span>
              </p>
            )}
            {parsed.ok && (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  Found {pastedRows.length} server{pastedRows.length === 1 ? '' : 's'} ·{' '}
                  {parsed.format}
                </div>
                {pastedRows.map((r) => (
                  <div
                    key={r.name}
                    className={cn(
                      'min-w-0 space-y-1.5 rounded-2xl border p-2.5',
                      r.problem || r.error ? 'border-red-300/70' : 'border-border/60',
                    )}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Input
                        value={renames[r.name] ?? r.name}
                        onChange={(e) => setRenames((m) => ({ ...m, [r.name]: e.target.value }))}
                        aria-label={`Name for ${r.name}`}
                        className="h-8 w-44 shrink-0 font-mono text-xs"
                      />
                      <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px]">
                        {r.entry.type}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                        title={entrySummary(r.entry)}
                      >
                        {entrySummary(r.entry)}
                      </span>
                    </div>
                    {(r.error || r.problem) && (
                      <p className="text-[11px] text-red-600">{r.error ?? r.problem}</p>
                    )}
                    {r.placeholders.length > 0 && (
                      <p className="flex items-start gap-1 text-[11px] leading-snug text-amber-700">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>
                          Looks like a placeholder, not a real value:{' '}
                          <code>{r.placeholders.join(', ')}</code> — edit it above first.
                        </span>
                      </p>
                    )}
                    {r.ignored.length > 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Ignored (not used by Claude Code): <code>{r.ignored.join(', ')}</code>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {tab === 'templates' ? (
            <Button
              onClick={submitTemplate}
              disabled={!picked || !!templateProblem || !!missingField || maestroBlocked || pending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              Add &amp; test
            </Button>
          ) : (
            <Button
              onClick={submitPaste}
              disabled={pasteBlocked || add.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {add.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
              {pastedRows.length > 1 ? `Add ${pastedRows.length} & test` : 'Add & test'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// What stops working when a built-in is renamed away — the portal finds each by name.
const BUILTIN_RENAME_WARNING: Record<string, string> = {
  clickup: 'Ticket crawling and ClickUp issue filing read the token from the server named "clickup".',
  jira: 'Ticket crawling reads the Jira credentials from the server named "jira".',
  azure: 'Ticket crawling reads the Azure DevOps credentials from the server named "azure".',
  figma: 'Design Check and the qc-testing skill call Figma as "figma".',
  playwright:
    'Headless/headed run mode, the QC browser attach, and the qc-testing skill (mcp__playwright__*) all need the name "playwright".',
  maestro: 'Mobile runs and the qc-testing skill call Maestro as "maestro".',
}

/** A server as the Edit dialog's Settings form holds it. */
interface ServerDraft {
  transport: 'stdio' | 'http' | 'sse'
  command: string
  /** One argument per line — an argument may itself contain spaces. */
  args: string
  url: string
  cwd: string
  env: { k: string; v: string }[]
  headers: { k: string; v: string }[]
}

function draftFromEntry(e: McpEntryInput): ServerDraft {
  const t = e.type === 'sse' ? 'sse' : e.url || e.type === 'http' ? 'http' : 'stdio'
  const rows = (m?: Record<string, string>) => Object.entries(m ?? {}).map(([k, v]) => ({ k, v }))
  return {
    transport: t,
    command: e.command ?? '',
    args: (e.args ?? []).join('\n'),
    url: e.url ?? '',
    cwd: e.cwd ?? '',
    env: rows(e.env),
    headers: rows(e.headers),
  }
}

function entryFromDraft(d: ServerDraft): McpEntryInput {
  const map = (rows: { k: string; v: string }[]) => {
    const out = Object.fromEntries(rows.filter((r) => r.k.trim()).map((r) => [r.k.trim(), r.v]))
    return Object.keys(out).length ? out : undefined
  }
  const e: McpEntryInput = { type: d.transport }
  if (d.transport === 'stdio') {
    if (d.command.trim()) e.command = d.command.trim()
    const args = d.args.split('\n').map((a) => a.trim()).filter(Boolean)
    if (args.length) e.args = args
    if (d.cwd.trim()) e.cwd = d.cwd.trim()
  } else {
    if (d.url.trim()) e.url = d.url.trim()
    const headers = map(d.headers)
    if (headers) e.headers = headers
  }
  const env = map(d.env)
  if (env) e.env = env
  return e
}

/** Editable key/value rows (env vars, headers). Values masked until "Show values". */
function KvRows({
  label,
  rows,
  onChange,
  keyPlaceholder,
  show,
}: {
  label: string
  rows: { k: string; v: string }[]
  onChange: (rows: { k: string; v: string }[]) => void
  keyPlaceholder: string
  show: boolean
}) {
  const set = (i: number, patch: Partial<{ k: string; v: string }>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  // Per-field reveal (the header's "Show values" still reveals them all) + copy.
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set())
  const [copied, setCopied] = useState<number | null>(null)
  const toggleReveal = (i: number) =>
    setRevealed((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  async function copy(i: number, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(i)
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1200)
    } catch {
      toast.error('Could not copy', { description: 'The browser blocked clipboard access.' })
    }
  }
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <button
          type="button"
          onClick={() => onChange([...rows, { k: '', v: '' }])}
          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3 w-3" />
          Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
          None
        </p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <Input
                value={r.k}
                onChange={(e) => set(i, { k: e.target.value })}
                placeholder={keyPlaceholder}
                aria-label={`${label} name ${i + 1}`}
                className="h-8 w-2/5 font-mono text-[11px]"
              />
              <div className="relative min-w-0 flex-1">
                <Input
                  value={r.v}
                  type={show || revealed.has(i) ? 'text' : 'password'}
                  onChange={(e) => set(i, { v: e.target.value })}
                  placeholder="value"
                  aria-label={`${label} value ${i + 1}`}
                  className="h-8 pr-16 font-mono text-[11px]"
                />
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
                  {!show && (
                    <button
                      type="button"
                      onClick={() => toggleReveal(i)}
                      aria-label={revealed.has(i) ? `Hide ${r.k || 'value'}` : `Show ${r.k || 'value'}`}
                      title={revealed.has(i) ? 'Hide value' : 'Show value'}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {revealed.has(i) ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => copy(i, r.v)}
                    disabled={!r.v}
                    aria-label={`Copy ${r.k || 'value'}`}
                    title="Copy value"
                    className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                  >
                    {copied === i ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  onChange(rows.filter((_, j) => j !== i))
                  setRevealed(new Set())
                  setCopied(null)
                }}
                aria-label={`Remove ${r.k || 'row'}`}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Edit one server: its name, and its whole entry — as a form (Settings) or as the raw
 * `.mcp.json` JSON. The dialog loads the REAL env/header values first (the list only
 * ever holds masked ones), because saving a form seeded with "••••1234" would write
 * the mask over the token.
 */
function EditServerDialog({
  name,
  server,
  projectId,
  existingNames,
  onClose,
  onSaved,
}: {
  name: string
  server: McpServer
  projectId: string
  existingNames: string[]
  onClose: () => void
  onSaved: (from: string, to: string) => void
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['mcp-edit', projectId, name],
    queryFn: () => revealMcpEnv(name, projectId),
    // Real secrets: fetch fresh on every open and don't keep them in the cache.
    gcTime: 0,
    staleTime: 0,
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto overflow-x-hidden sm:max-w-xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2">
            <PencilLine className="h-4 w-4" />
            Edit <span className="font-mono text-sm">{name}</span>
          </DialogTitle>
          <DialogDescription>
            Changes are saved to this project's <code>.mcp.json</code>, then the connection is
            tested again.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading the current settings…
          </div>
        ) : error ? (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700">
            {error instanceof Error ? error.message : 'Could not load this server.'}
          </p>
        ) : (
          <EditServerForm
            name={name}
            initial={{
              type: server.type,
              command: server.command,
              args: server.args,
              url: server.url,
              cwd: server.cwd,
              env: data?.env && Object.keys(data.env).length ? data.env : undefined,
              headers: data?.headers && Object.keys(data.headers).length ? data.headers : undefined,
            }}
            projectId={projectId}
            existingNames={existingNames}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditServerForm({
  name,
  initial,
  projectId,
  existingNames,
  onClose,
  onSaved,
}: {
  name: string
  initial: McpEntryInput
  projectId: string
  existingNames: string[]
  onClose: () => void
  onSaved: (from: string, to: string) => void
}) {
  const [newName, setNewName] = useState(name)
  const [tab, setTab] = useState<'settings' | 'json'>('settings')
  const [draft, setDraft] = useState<ServerDraft>(() => draftFromEntry(initial))
  const [jsonText, setJsonText] = useState('')
  const [jsonError, setJsonError] = useState<string | null>(null)
  const [show, setShow] = useState(false)

  const next = newName.trim()
  const taken = useMemo(
    () => new Set([...existingNames.filter((n) => n !== name), ...BUILTIN_MCP_NAMES]),
    [existingNames, name],
  )
  const nameErr = next === name ? null : nameProblem(next, taken)
  const renamingBuiltin = next !== name && !!BUILTIN_RENAME_WARNING[name]

  /** The entry being edited, from whichever tab is showing. */
  function currentEntry(): { entry?: McpEntryInput; error?: string } {
    if (tab === 'settings') return { entry: entryFromDraft(draft) }
    try {
      const parsed = JSON.parse(jsonText) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'The entry must be a JSON object, e.g. { "command": "npx", "args": [...] }.' }
      }
      return { entry: parsed as McpEntryInput }
    } catch (e) {
      return { error: `Not valid JSON — ${e instanceof Error ? e.message : 'parse error'}` }
    }
  }

  function switchTab(to: 'settings' | 'json') {
    if (to === tab) return
    if (to === 'json') {
      setJsonText(JSON.stringify(entryFromDraft(draft), null, 2))
      setJsonError(null)
      setTab('json')
      return
    }
    const { entry, error } = currentEntry()
    if (!entry) {
      setJsonError(error ?? 'Invalid JSON')
      return
    }
    setDraft(draftFromEntry(entry))
    setTab('settings')
  }

  const save = useMutation({
    mutationFn: (entry: McpEntryInput) => updateMcp(name, entry, next, projectId),
    onSuccess: () => {
      toast.success(next === name ? `${name} saved` : `Saved as ${next}`, {
        description: 'Testing the connection…',
      })
      onSaved(name, next)
      onClose()
    },
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  function submit() {
    const { entry, error } = currentEntry()
    if (!entry) {
      setJsonError(error ?? 'Invalid JSON')
      return
    }
    save.mutate(entry)
  }

  const set = (patch: Partial<ServerDraft>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <div className="min-w-0 space-y-3">
      <Field label="Server name">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          aria-label="Server name"
          className="h-9 font-mono text-xs"
        />
        {nameErr && <p className="text-[11px] text-red-600">{nameErr}</p>}
      </Field>
      {renamingBuiltin && (
        <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            <b>{name}</b> is a built-in. {BUILTIN_RENAME_WARNING[name]} After renaming, those
            features treat it as not connected — and it can't be renamed back, only re-added from
            its template.
          </span>
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => switchTab(v as 'settings' | 'json')} className="min-w-0">
        <div className="flex items-center gap-2">
          <TabsList className="rounded-full">
            <TabsTrigger value="settings" className="rounded-full">
              <LayoutGrid className="h-3.5 w-3.5" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="json" className="rounded-full">
              <Braces className="h-3.5 w-3.5" />
              JSON
            </TabsTrigger>
          </TabsList>
          {tab === 'settings' && (draft.env.length > 0 || draft.headers.length > 0) && (
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {show ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {show ? 'Hide values' : 'Show values'}
            </button>
          )}
        </div>

        <TabsContent value="settings" className="mt-3 min-w-0 space-y-3">
          <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 p-1 text-xs">
            {(['stdio', 'http', 'sse'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => set({ transport: t })}
                className={cn(
                  'flex-1 rounded-full px-2 py-1 font-medium transition-all duration-200',
                  draft.transport === t
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'stdio' ? 'Local command (stdio)' : t === 'http' ? 'Remote (http)' : 'Remote (sse)'}
              </button>
            ))}
          </div>
          {draft.transport === 'stdio' ? (
            <>
              <Field label="Command">
                <Input
                  value={draft.command}
                  onChange={(e) => set({ command: e.target.value })}
                  placeholder="npx"
                  aria-label="Command"
                  className="h-9 font-mono text-xs"
                />
              </Field>
              <Field label="Arguments (one per line)">
                <Textarea
                  value={draft.args}
                  onChange={(e) => set({ args: e.target.value })}
                  spellCheck={false}
                  placeholder={'-y\nsome-mcp-server'}
                  aria-label="Arguments"
                  className="min-h-24 rounded-xl font-mono text-[11px] leading-relaxed"
                />
              </Field>
            </>
          ) : (
            <Field label="URL">
              <Input
                value={draft.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="https://example.com/mcp"
                aria-label="URL"
                className="h-9 font-mono text-xs"
              />
            </Field>
          )}
          <KvRows
            label="Environment variables"
            rows={draft.env}
            onChange={(env) => set({ env })}
            keyPlaceholder="API_KEY"
            show={show}
          />
          {draft.transport !== 'stdio' && (
            <KvRows
              label="Headers"
              rows={draft.headers}
              onChange={(headers) => set({ headers })}
              keyPlaceholder="Authorization"
              show={show}
            />
          )}
        </TabsContent>

        <TabsContent value="json" className="mt-3 min-w-0 space-y-2">
          <Textarea
            value={jsonText}
            onChange={(e) => {
              setJsonText(e.target.value)
              setJsonError(null)
            }}
            spellCheck={false}
            aria-label=".mcp.json entry"
            className="h-72 resize-y rounded-2xl font-mono text-[11px] leading-relaxed"
          />
          <p className="text-[11px] text-muted-foreground">
            Just this server's entry — the value under <code>"{next || name}"</code> in{' '}
            <code>mcpServers</code>. Values are shown in full here.
          </p>
        </TabsContent>
      </Tabs>

      {jsonError && (
        <p className="flex items-start gap-1.5 rounded-xl bg-red-50 px-2.5 py-2 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{jsonError}</span>
        </p>
      )}

      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          onClick={submit}
          disabled={!!nameErr || save.isPending}
          className="rounded-full transition-all duration-200 active:scale-[0.98]"
        >
          {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save &amp; test
        </Button>
      </DialogFooter>
    </div>
  )
}

/** A remote server: the only kind `claude mcp login` can sign in to. */
function isRemoteServer(s: McpServer | undefined): boolean {
  return !!s && (s.type === 'http' || s.type === 'sse' || (!s.command && !!s.url))
}

/**
 * OAuth sign-in to a remote MCP server. The server runs `claude mcp login`, so the
 * token is stored — and refreshed — by Claude Code itself, never in .mcp.json.
 *
 * The page opens the provider's page in THIS browser (the CLI runs with
 * `--no-browser`). On the portal's own machine the provider's redirect reaches the
 * CLI's localhost callback and the dialog finishes by itself; from anywhere else
 * (Remote access) that redirect fails, and pasting the address it left behind
 * finishes it instead. Closing the dialog while it is waiting cancels the sign-in.
 */
function SignInDialog({
  name,
  projectId,
  onClose,
  onSignedIn,
}: {
  name: string
  projectId: string
  onClose: () => void
  onSignedIn: (name: string) => void
}) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [copied, setCopied] = useState(false)

  const start = useMutation({
    mutationFn: () => startMcpSignin(name, projectId),
    onSuccess: (res) => setJobId(res.job.id),
  })
  // Start once on open; "Try again" calls it again.
  useEffect(() => {
    start.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, [])

  const { data } = useQuery({
    queryKey: ['mcp-signin', projectId, name, jobId],
    queryFn: () => getMcpSignin(name, projectId),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.job?.state === 'running' ? 1000 : false),
    gcTime: 0,
  })
  // A job from an earlier attempt must not be read as this one's result.
  const job = data?.job && data.job.id === jobId ? data.job : null
  const state = start.isPending ? 'starting' : start.isError ? 'failed' : (job?.state ?? 'starting')

  // Announce a success once per job, however many polls report it.
  const announced = useRef<string | null>(null)
  useEffect(() => {
    if (job?.state === 'succeeded' && announced.current !== job.id) {
      announced.current = job.id
      toast.success(`Signed in to ${name}`, { description: 'Testing the connection…' })
      onSignedIn(name)
    }
  }, [job, name, onSignedIn])

  const paste = useMutation({
    mutationFn: () => pasteMcpSignin(name, pasted.trim(), projectId),
    onSuccess: () => setPasted(''),
    onError: (err) =>
      toast.error('Could not send that address', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  function close() {
    // Leaving mid-sign-in cancels it, so the CLI's callback port isn't held for 10 min.
    if (job?.state === 'running') cancelMcpSignin(name, projectId).catch(() => undefined)
    onClose()
  }

  async function copyLink() {
    if (!job?.signInUrl) return
    try {
      await navigator.clipboard.writeText(job.signInUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy — select the link and copy it by hand.')
    }
  }

  const error = start.isError
    ? start.error instanceof Error
      ? start.error.message
      : 'Could not start the sign-in.'
    : job?.state === 'failed' || job?.state === 'cancelled'
      ? job.error
      : null

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Sign in to <span className="font-mono text-sm">{name}</span>
          </DialogTitle>
          <DialogDescription>
            Signs in with the provider's own page. Claude Code keeps the sign-in and refreshes
            it — nothing is written to <code>.mcp.json</code>.
          </DialogDescription>
        </DialogHeader>

        {state === 'starting' && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Preparing the sign-in…
          </div>
        )}

        {state === 'running' && !job?.signInUrl && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Asking {name} where to sign in…
          </div>
        )}

        {state === 'running' && job?.signInUrl && (
          <div className="min-w-0 space-y-4">
            <div className="space-y-2 rounded-2xl border border-border/60 bg-muted/40 p-3">
              <p className="text-xs font-medium">1. Open the sign-in page and allow access</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  asChild
                  size="sm"
                  className="rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  <a href={job.signInUrl} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" />
                    Open sign-in page
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={copyLink}
                  className="rounded-full border-border/60 shadow-none"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? 'Copied' : 'Copy link'}
                </Button>
              </div>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting — on this computer, this finishes by itself once you allow access.
              </p>
            </div>

            <div className="space-y-2 rounded-2xl border border-border/60 p-3">
              <p className="text-xs font-medium">
                2. Browser says it can't reach <code>localhost</code>?
              </p>
              <p className="text-[11px] leading-snug text-muted-foreground">
                That happens when you use the portal from another computer. Copy the whole address
                from that browser tab and paste it here.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                  placeholder="http://localhost:…/callback?code=…"
                  aria-label="Redirect address"
                  className="h-9 min-w-0 flex-1 font-mono text-xs"
                  onKeyDown={(e) => e.key === 'Enter' && pasted.trim() && paste.mutate()}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => paste.mutate()}
                  disabled={!pasted.trim() || paste.isPending || !job.awaitingPaste}
                  className="rounded-full border-border/60 shadow-none"
                >
                  {paste.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Finish
                </Button>
              </div>
              {job.pasteError && (
                <p className="rounded-xl bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">
                  {job.pasteError}
                </p>
              )}
            </div>
          </div>
        )}

        {state === 'succeeded' && (
          <p className="flex items-start gap-2 rounded-2xl bg-emerald-50 px-3 py-3 text-sm text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Signed in. QC runs in this project now get {name}'s tools. Some providers (ClickUp)
              end a sign-in after a day — this card will ask again when that happens.
            </span>
          </p>
        )}

        {(state === 'failed' || state === 'cancelled') && (
          <p className="flex items-start gap-2 rounded-2xl bg-red-50 px-3 py-3 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">{error ?? 'The sign-in did not finish.'}</span>
          </p>
        )}

        <DialogFooter>
          {(state === 'failed' || state === 'cancelled') && (
            <Button
              variant="outline"
              onClick={() => start.mutate()}
              className="rounded-full border-border/60 shadow-none"
            >
              Try again
            </Button>
          )}
          <Button
            variant={state === 'succeeded' ? 'default' : 'ghost'}
            onClick={close}
            className="rounded-full"
          >
            {state === 'running' ? 'Cancel' : state === 'succeeded' ? 'Done' : 'Close'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Token-connect cards for ClickUp/Figma/Jira (paste a personal token) + no-auth Playwright/Mobile. */
function ConnectServices({
  projectId,
  projectRoot,
  existingNames,
  statusByName,
  envByName,
  serverByName,
  checkingStatus,
}: {
  projectId: string
  projectRoot?: string
  existingNames: string[]
  statusByName: Record<string, string | undefined>
  envByName: Record<string, Record<string, string> | undefined>
  serverByName: Record<string, McpServer | undefined>
  checkingStatus: boolean
}) {
  const queryClient = useQueryClient()
  // "View details" dialog: which server, a cache of its full (unmasked) env fetched
  // on demand — used BOTH for the Reveal display and for copying real values — and
  // whether the display is currently unmasked.
  const [detailsName, setDetailsName] = useState<string | null>(null)
  const [fullEnv, setFullEnv] = useState<Record<string, string> | null>(null)
  const [showReveal, setShowReveal] = useState(false)
  const [revealingEnv, setRevealingEnv] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  // "Add server" (templates / paste JSON) and "Rename" dialogs.
  const [addOpen, setAddOpen] = useState(false)
  const [editName, setEditName] = useState<string | null>(null)
  // Disconnect asks first: it deletes the entry — tokens included — from .mcp.json.
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null)
  // OAuth sign-in dialog for a remote (http/sse) server.
  const [signinName, setSigninName] = useState<string | null>(null)
  // Header values for the details dialog, fetched alongside the env on reveal.
  const [fullHeaders, setFullHeaders] = useState<Record<string, string> | null>(null)

  // Returns a promise that resolves once the (slow, live-health) MCP list has
  // refetched. Mutations `return refresh()` from onSuccess so their `isPending`
  // spans the refetch — the button keeps spinning until the card flips to its
  // connected state instead of going dead for the 5-10s health check.
  function refresh() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ['mcp', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-health', projectId] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-oauth', projectId] }),
    ])
  }

  // Disconnect = remove the server entry from this project's .mcp.json.
  // Per-name pending sets — a single useMutation only tracks its LATEST call, so
  // testing/disconnecting two servers at once would drop the first card's spinner.
  // Tracking by name lets each card reflect its own in-flight state independently.
  const [disconnectingNames, setDisconnectingNames] = useState<Set<string>>(() => new Set())
  const disconnect = useMutation({
    mutationFn: (name: string) => removeMcp(name, projectId),
    onMutate: (name) => setDisconnectingNames((s) => new Set(s).add(name)),
    onSuccess: (_, name) => {
      toast.success(`${name} disconnected`, {
        description: "Removed from this project's .mcp.json.",
      })
      forgetStatus([name])
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to disconnect', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
    onSettled: (_res, _err, name) =>
      setDisconnectingNames((s) => {
        const next = new Set(s)
        next.delete(name)
        return next
      }),
  })

  // Live connection test — spawns the server via the Claude CLI and reports health.
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; detail: string }>
  >({})
  const [testingNames, setTestingNames] = useState<Set<string>>(() => new Set())
  // Drop everything remembered about a server NAME — its last test result and its
  // badge in the (localStorage-backed) health map. Without this a server disconnected
  // and then added again under the same name showed the OLD "Connected" at once, and
  // kept it until the slow `claude mcp list` refetch came back.
  function forgetStatus(names: string[]) {
    setTestResults((m) => {
      const next = { ...m }
      for (const n of names) delete next[n]
      return next
    })
    queryClient.setQueryData<Record<string, McpServer['status']>>(['mcp-health', projectId], (m) => {
      if (!m) return m
      const next = { ...m }
      for (const n of names) delete next[n]
      return next
    })
  }

  const test = useMutation({
    mutationFn: (name: string) => testMcp(name, projectId),
    onMutate: (name) => setTestingNames((s) => new Set(s).add(name)),
    onSuccess: (res, name) => {
      setTestResults((m) => ({ ...m, [name]: res }))
      // The badge follows THIS test at once instead of waiting for the health refetch,
      // so the result line and the badge can never disagree.
      if (res.status) {
        queryClient.setQueryData<Record<string, McpServer['status']>>(
          ['mcp-health', projectId],
          (m) => ({ ...(m ?? {}), [name]: res.status }),
        )
      }
      refresh()
      if (res.ok) toast.success(`${name} is connected`, { description: res.detail })
      else toast.error(`${name} is not connected`, { description: res.detail })
    },
    onError: (err, name) => {
      const detail = err instanceof Error ? err.message : 'Test failed'
      setTestResults((m) => ({ ...m, [name]: { ok: false, detail } }))
      toast.error(`${name} test failed`, { description: detail })
    },
    onSettled: (_res, _err, name) =>
      setTestingNames((s) => {
        const next = new Set(s)
        next.delete(name)
        return next
      }),
  })

  // Open the "View details" dialog for a server (starts masked, no cached env).
  function openDetails(name: string) {
    setFullEnv(null)
    setFullHeaders(null)
    setShowReveal(false)
    setCopiedField(null)
    setDetailsName(name)
  }

  // Fetch the server's full (unmasked) env once and cache it. Used for both the
  // Reveal display and for copying real values to the clipboard.
  async function ensureFullEnv(): Promise<Record<string, string>> {
    return (await ensureFullConfig()).env
  }

  async function ensureFullConfig(): Promise<{
    env: Record<string, string>
    headers: Record<string, string>
  }> {
    if (fullEnv) return { env: fullEnv, headers: fullHeaders ?? {} }
    if (!detailsName) return { env: {}, headers: {} }
    const { env, headers = {} } = await revealMcpEnv(detailsName, projectId)
    setFullEnv(env)
    setFullHeaders(headers)
    return { env, headers }
  }

  // Reveal / hide the real values in the dialog display.
  async function toggleReveal() {
    if (showReveal) {
      setShowReveal(false)
      return
    }
    setRevealingEnv(true)
    try {
      await ensureFullEnv()
      setShowReveal(true)
    } catch (err) {
      toast.error('Failed to reveal values', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setRevealingEnv(false)
    }
  }

  async function copyField(id: string, value: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedField(id)
      window.setTimeout(() => setCopiedField((c) => (c === id ? null : c)), 1200)
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  // Copy an env var's REAL value — a masked secret is fetched in full first, so the
  // clipboard never gets the "••••" placeholder. Non-secrets are already full.
  async function copyEnvValue(key: string) {
    const masked = (detailsName && envByName[detailsName]?.[key]) || ''
    try {
      const value = masked.includes('••••') ? ((await ensureFullEnv())[key] ?? '') : masked
      await copyField(`env:${key}`, value)
    } catch (err) {
      toast.error('Failed to copy value', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Copy the full .mcp.json entry with REAL secret values (a usable config).
  async function copyJsonEntry() {
    if (!detailsName) return
    const server = serverByName[detailsName]
    const masked = envByName[detailsName] ?? {}
    const keys = Object.keys(masked)
    const headerKeys = Object.keys(server?.headers ?? {})
    try {
      const full =
        keys.length || headerKeys.length ? await ensureFullConfig() : { env: {}, headers: {} }
      const env: Record<string, string> = full.env
      const entry: Record<string, unknown> = {}
      if (server?.type) entry.type = server.type
      if (server?.command) entry.command = server.command
      if (server?.args?.length) entry.args = server.args
      if (server?.url) entry.url = server.url
      if (server?.cwd) entry.cwd = server.cwd
      if (keys.length) entry.env = Object.fromEntries(keys.map((k) => [k, env[k] ?? masked[k]]))
      if (headerKeys.length) {
        const headers: Record<string, string> = full.headers
        entry.headers = Object.fromEntries(
          headerKeys.map((k) => [k, headers[k] ?? server?.headers?.[k] ?? '']),
        )
      }
      await copyField('json', JSON.stringify({ [detailsName]: entry }, null, 2))
    } catch (err) {
      toast.error('Failed to copy config', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Full-configuration dialog for a connected server. Shows the transport, the
  // spawn command/args (or URL), and every env var — masked, with a Reveal toggle
  // that fetches the real values on explicit request (localhost-only, never logged).
  function detailsDialog() {
    const name = detailsName
    const server = name ? serverByName[name] : undefined
    const meta = name && name in OAUTH_META ? OAUTH_META[name as McpOauthProvider] : null
    const Icon = meta?.icon ?? (name && !BUILTIN_MCP_NAMES.has(name) ? iconForServer(name) : FileJson)
    const maskedEnv = (name && envByName[name]) || {}
    const envKeys = Object.keys(maskedEnv)
    // Fields shown in the readable list = user-entered env, minus fixed constants.
    const fieldKeys = envKeys.filter((k) => !HIDDEN_DETAIL_ENV.has(k))
    const revealed = showReveal && !!fullEnv
    const valueFor = (key: string) =>
      revealed ? (fullEnv?.[key] ?? '') : maskedEnv[key]

    // The effective .mcp.json entry, with env swapped to real values when revealed.
    const entry: Record<string, unknown> = {}
    if (server?.type) entry.type = server.type
    if (server?.command) entry.command = server.command
    if (server?.args?.length) entry.args = server.args
    if (server?.url) entry.url = server.url
    if (server?.cwd) entry.cwd = server.cwd
    if (envKeys.length) {
      entry.env = Object.fromEntries(envKeys.map((k) => [k, valueFor(k)]))
    }
    const headerKeys = Object.keys(server?.headers ?? {})
    if (headerKeys.length) {
      entry.headers = Object.fromEntries(
        headerKeys.map((k) => [
          k,
          revealed ? (fullHeaders?.[k] ?? '') : (server?.headers?.[k] ?? ''),
        ]),
      )
    }
    const entryJson = JSON.stringify({ [name ?? 'server']: entry }, null, 2)

    return (
      <Dialog open={!!detailsName} onOpenChange={(o) => !o && setDetailsName(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
          <DialogHeader className="min-w-0">
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              <span className="font-mono text-sm">{name}</span>
              {name && <CardStatusBadge configured status={statusByName[name]} />}
            </DialogTitle>
            <DialogDescription>
              The full configuration saved in this project's <code>.mcp.json</code>. Secrets are
              masked — reveal them only on this machine.
            </DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-4 text-sm">
            {/* Transport + command / url */}
            <div className="min-w-0 space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-xs font-medium text-muted-foreground">Transport</span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">
                  {server?.type ?? 'stdio'}
                </span>
              </div>
              {server?.url && (
                <FieldRow
                  label="URL"
                  value={server.url}
                  copied={copiedField === 'url'}
                  onCopy={() => copyField('url', server.url as string)}
                />
              )}
              {server?.command && (
                <FieldRow
                  label="Command"
                  value={[server.command, ...(server.args ?? [])].join(' ')}
                  copied={copiedField === 'cmd'}
                  onCopy={() => copyField('cmd', [server.command, ...(server.args ?? [])].join(' '))}
                />
              )}
            </div>

            {/* Configured fields (friendly labels; constants hidden) */}
            {fieldKeys.length > 0 && (
              <div className="min-w-0 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Settings ({fieldKeys.length})
                  </span>
                  <button
                    type="button"
                    onClick={toggleReveal}
                    disabled={revealingEnv}
                    className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {revealingEnv ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : revealed ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    {revealed ? 'Hide' : 'Reveal'}
                  </button>
                </div>
                <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
                  {fieldKeys.map((key) => (
                    <div key={key} className="flex min-w-0 items-center gap-2 bg-muted/40 px-2.5 py-1.5">
                      <span
                        className="w-36 shrink-0 truncate text-[11px] font-medium text-muted-foreground"
                        title={key}
                      >
                        {ENV_FIELD_LABELS[key] ?? key}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={valueFor(key)}>
                        {valueFor(key)}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyEnvValue(key)}
                        aria-label={`Copy ${ENV_FIELD_LABELS[key] ?? key}`}
                        className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                      >
                        {copiedField === `env:${key}` ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Raw .mcp.json entry */}
            <div className="min-w-0 space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">.mcp.json entry</span>
                {fieldKeys.length === 0 && headerKeys.length > 0 && (
                  <button
                    type="button"
                    onClick={toggleReveal}
                    disabled={revealingEnv}
                    className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {revealingEnv ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : revealed ? (
                      <EyeOff className="h-3 w-3" />
                    ) : (
                      <Eye className="h-3 w-3" />
                    )}
                    {revealed ? 'Hide' : 'Reveal'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={copyJsonEntry}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {copiedField === 'json' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  Copy
                </button>
              </div>
              <pre className="max-h-56 w-full min-w-0 overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-100">
                {entryJson}
              </pre>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDetailsName(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  function disconnectDialog() {
    const name = confirmDisconnect
    const busy = !!name && disconnectingNames.has(name)
    const hasSecrets =
      !!name &&
      (Object.keys(envByName[name] ?? {}).length > 0 ||
        Object.keys(serverByName[name]?.headers ?? {}).length > 0)
    return (
      <Dialog open={!!name} onOpenChange={(o) => !o && !busy && setConfirmDisconnect(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Unplug className="h-4 w-4" />
              Disconnect {name}?
            </DialogTitle>
            <DialogDescription>
              Removes <code className="font-mono">{name}</code> from this project's{' '}
              <code>.mcp.json</code>, so QC runs no longer get its tools.
              {hasSecrets && ' Its saved token/settings are deleted too — you will need them again to reconnect.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDisconnect(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                name &&
                disconnect.mutate(name, { onSuccess: () => setConfirmDisconnect(null) })
              }
              disabled={busy}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // One-line test result under a row, after Test connection.
  function resultLine(name: string) {
    const result = testResults[name]
    if (!result) return null
    return (
      <p
        className={cn(
          'flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] leading-snug',
          result.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
        )}
      >
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
        ) : (
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
        )}
        <span className="min-w-0 break-words">{result.detail}</span>
      </p>
    )
  }

  // Actions for a configured server, inline at the end of its row: one labelled
  // primary (Test) and low-emphasis icon buttons for the rest.
  function connectedActions(name: string) {
    const testing = testingNames.has(name)
    const disconnecting = disconnectingNames.has(name)
    const remote = isRemoteServer(serverByName[name])
    const status = statusByName[name]
    // A remote server with a static token header signs in through that header, not OAuth.
    const usesHeaderToken = Object.keys(serverByName[name]?.headers ?? {}).length > 0
    return (
      <>
        {remote && status === 'needs-auth' && (
          <Button
            size="sm"
            onClick={() => setSigninName(name)}
            disabled={testing || disconnecting}
            className="h-8 rounded-full px-3 text-xs font-medium transition-all duration-200 active:scale-[0.98]"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Sign in
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => test.mutate(name)}
          disabled={testing || disconnecting}
          className="h-8 rounded-full border-border/60 px-3 text-xs font-medium shadow-none transition-all duration-200 active:scale-[0.98]"
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <PlugZap className="h-3.5 w-3.5" />
          )}
          {testing ? 'Testing…' : 'Test'}
        </Button>
        <RowIconButton label="Details" onClick={() => openDetails(name)} disabled={disconnecting}>
          <FileJson className="h-3.5 w-3.5" />
        </RowIconButton>
        <RowIconButton label="Edit" onClick={() => setEditName(name)} disabled={disconnecting || testing}>
          <PencilLine className="h-3.5 w-3.5" />
        </RowIconButton>
        {remote && status === 'connected' && !usesHeaderToken && (
          <RowIconButton
            label="Sign out"
            onClick={() => signOut.mutate(name)}
            disabled={disconnecting || testing || (signOut.isPending && signOut.variables === name)}
          >
            {signOut.isPending && signOut.variables === name ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LogOut className="h-3.5 w-3.5" />
            )}
          </RowIconButton>
        )}
        <RowIconButton
          label="Disconnect"
          destructive
          onClick={() => setConfirmDisconnect(name)}
          disabled={disconnecting || testing}
        >
          {disconnecting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Unplug className="h-3.5 w-3.5" />
          )}
        </RowIconButton>
      </>
    )
  }

  // ---- row renderers (closures over the mutations + state above) ----

  // A configured built-in. Only CONFIGURED servers are listed — connecting one is a
  // template in the Add server dialog, like every other server.
  const BUILTIN_ROW: Record<string, { label: string; blurb: string; icon: typeof Figma }> = {
    ...Object.fromEntries(
      Object.entries(OAUTH_META).map(([k, m]) => [k, { label: m.label, blurb: m.blurb, icon: m.icon }]),
    ),
    playwright: { label: 'Playwright', blurb: 'Browser driver', icon: MousePointerClick },
    maestro: { label: 'Maestro', blurb: 'iOS / Android / web flows', icon: Smartphone },
  }

  function builtinRow(name: string) {
    const meta = BUILTIN_ROW[name]
    return (
      <ServerRow
        key={name}
        icon={meta.icon}
        title={
          <>
            <span className="truncate">{meta.label}</span>
            <PurposeTip name={name} label={meta.label} />
          </>
        }
        subtitle={meta.blurb}
        status={statusByName[name]}
        badge={<CardStatusBadge configured status={statusByName[name]} checking={checkingStatus} />}
        actions={checkingStatus ? null : connectedActions(name)}
      >
        {!checkingStatus && resultLine(name)}
      </ServerRow>
    )
  }

  // Everything in .mcp.json that isn't one of the built-in cards above — added from
  // a template, pasted, or hand-written. Without this section such a server was
  // spawned on every run yet invisible (and unremovable) on this page.
  const BUILTIN_ORDER = ['clickup', 'jira', 'azure', 'figma', 'playwright', 'maestro']
  const customServers = Object.values(serverByName).filter(
    (s): s is McpServer => !!s && !BUILTIN_MCP_NAMES.has(s.name),
  )

  // Test each new server in turn: a first test also APPROVES a pending project
  // server, and parallel approvals would race on the same ~/.claude.json write.
  async function afterAdd(names: string[]) {
    forgetStatus(names)
    await refresh()
    // Read the refreshed list, not the props: this closure predates the refetch.
    const fresh = queryClient.getQueryData<McpServer[]>(['mcp', projectId]) ?? []
    let needsSignin: string | null = null
    for (const n of names) {
      const res = await test.mutateAsync(n).catch(() => undefined)
      const server = fresh.find((s) => s.name === n)
      if (!needsSignin && res?.status === 'needs-auth' && isRemoteServer(server)) needsSignin = n
    }
    // A just-added OAuth server's next step is signing in — offer it straight away.
    if (needsSignin) setSigninName(needsSignin)
  }

  async function afterSignin(name: string) {
    forgetStatus([name])
    await refresh()
    await test.mutateAsync(name).catch(() => undefined)
  }

  const signOut = useMutation({
    mutationFn: (name: string) => logoutMcpSignin(name, projectId),
    onSuccess: (res, name) => {
      toast.success(`Signed out of ${name}`, { description: res.detail })
      forgetStatus([name])
      return refresh()
    },
    onError: (err, name) =>
      toast.error(`Could not sign out of ${name}`, {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // After an edit the old result says nothing about the new config — forget it and
  // test again under the (possibly new) name.
  async function afterEdit(from: string, to: string) {
    forgetStatus([from, to])
    await refresh()
    await test.mutateAsync(to).catch(() => undefined)
  }

  function customCard(server: McpServer) {
    return (
      <ServerRow
        key={server.name}
        icon={iconForServer(server.name)}
        title={<span className="truncate font-mono">{server.name}</span>}
        subtitle={`${server.type ?? 'stdio'}${server.source === 'local' ? ' · local scope' : ''}`}
        status={statusByName[server.name]}
        badge={<CardStatusBadge configured status={statusByName[server.name]} checking={checkingStatus} />}
        actions={checkingStatus ? null : connectedActions(server.name)}
      >
        {!checkingStatus && resultLine(server.name)}
      </ServerRow>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold tracking-tight">Connect a service</h2>
        <Link
          to="/document/mcp-tokens"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-3 py-1 text-xs text-muted-foreground transition-all duration-200 hover:border-border hover:text-foreground"
        >
          <BookOpen className="h-3.5 w-3.5" />
          How to get a token
        </Link>
        <Button
          size="sm"
          onClick={() => setAddOpen(true)}
          className="h-8 shrink-0 rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" />
          Add server
        </Button>
      </div>

      {/* One list of the servers this project HAS — built-ins first, then anything
          added from a template or pasted. Connecting a new one (built-in or not) is
          the Add server dialog. */}
      <div className="divide-y divide-border/60 overflow-hidden rounded-3xl border border-border/60 bg-card">
        {BUILTIN_ORDER.filter((n) => existingNames.includes(n)).map(builtinRow)}
        {customServers.map(customCard)}
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-dashed border-border">
            <Plus className="h-4 w-4" />
          </span>
          <span className="text-sm font-medium">Add server</span>
          <span className="text-xs">{MCP_TEMPLATES.length} templates · or paste JSON</span>
        </button>
      </div>

      {/* Mounted only while open: every open starts clean, so a half-typed token
          from last time never lingers in the form. */}
      {addOpen && (
      <AddServerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        projectRoot={projectRoot}
        existingNames={existingNames}
        onAdded={afterAdd}
      />
      )}
      {editName && serverByName[editName] && (
        <EditServerDialog
          key={editName}
          name={editName}
          server={serverByName[editName] as McpServer}
          projectId={projectId}
          existingNames={existingNames}
          onClose={() => setEditName(null)}
          onSaved={afterEdit}
        />
      )}

      {signinName && (
        <SignInDialog
          key={signinName}
          name={signinName}
          projectId={projectId}
          onClose={() => setSigninName(null)}
          onSignedIn={afterSignin}
        />
      )}

      {detailsDialog()}
      {disconnectDialog()}
    </div>
  )
}

/** Button that reveals the project's root folder (where .mcp.json lives) in the OS file explorer. */
function OpenFolderButton({ projectId }: { projectId: string }) {
  const mutation = useMutation({
    mutationFn: () => openMcpFolder(projectId),
    onSuccess: (res) => toast.success('Opened project folder', { description: res.path }),
    onError: (err) =>
      toast.error('Failed to open folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
    >
      {mutation.isPending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <FolderOpen className="size-3.5" />
      )}
      Open folder
    </Button>
  )
}

/**
 * Warns when Astral's `uv` isn't installed on the server machine. ClickUp
 * (clickup-mcp) and Jira (mcp-atlassian) run via `uvx`, so without `uv` they
 * fail to spawn — this surfaces the fix up-front with a platform-matched,
 * copy-able install command. Renders nothing while checking or when uv is present.
 */
function UvWarning() {
  const { data } = useQuery({
    queryKey: ['mcp-uv'],
    queryFn: mcpUvStatus,
    staleTime: 30_000,
    refetchInterval: (q) => (q.state.data?.available === false ? 15_000 : false),
  })
  const [copied, setCopied] = useState(false)
  if (!data || data.available) return null

  const install =
    data.platform === 'win32'
      ? 'winget install --id=astral-sh.uv -e'
      : 'curl -LsSf https://astral.sh/uv/install.sh | sh'

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-amber-300/70 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <p className="font-semibold">ClickUp &amp; Jira need Astral's uv installed</p>
          <p className="text-amber-800">
            These servers run through <code className="font-mono text-xs">uvx</code>, which isn't on
            this machine — so they'll show <span className="font-medium">failed</span> until you
            install it. Run this{data.platform === 'win32' ? ' in PowerShell or CMD' : ''}, then
            reopen the portal:
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-6">
        <code className="flex-1 truncate rounded-lg border border-amber-300/70 bg-amber-100/60 px-2.5 py-1.5 font-mono text-xs">
          {install}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 shrink-0 rounded-full border-amber-300 bg-transparent text-amber-900 hover:bg-amber-100"
          onClick={() => {
            void navigator.clipboard?.writeText(install)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}

/**
 * THE QC BROWSER card — one long-lived browser window the portal owns, which
 * Playwright MCP attaches to over CDP instead of launching its own.
 *
 * It exists because of two things a QC engineer hit constantly:
 *  - **Stop closed the browser.** Stopping a chat turn kills the `claude` child, which
 *    tears down its MCP servers, which closes the browser they launched. There was no
 *    way to pause a flow, fix a step and continue — the logins, the filled form and the
 *    page you were on all went with it.
 *  - **The window was never full screen.** The MCP launched a default-size window and
 *    we pinned `--viewport-size 1280x720` on top, so the app rendered in a small box.
 *
 * Attaching fixes both. The toggle is per project because it changes which browser that
 * project's runs drive; the browser itself is one per machine, so status/Start/Stop are
 * global.
 */
function QcBrowserCard({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const { data, isFetching } = useQuery({
    queryKey: ['qc-browser'],
    queryFn: qcBrowserStatus,
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
  const attached = project.persistentBrowser === true

  const start = useMutation({
    mutationFn: () => startQcBrowser(),
    onSuccess: () => {
      toast.success('QC browser opened', {
        description: 'It stays open when you press Stop, so you can adjust and continue.',
      })
      queryClient.invalidateQueries({ queryKey: ['qc-browser'] })
    },
    onError: (err) =>
      toast.error('Could not open the QC browser', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const stop = useMutation({
    mutationFn: stopQcBrowser,
    onSuccess: () => {
      toast.success('QC browser closed')
      queryClient.invalidateQueries({ queryKey: ['qc-browser'] })
    },
    onError: (err) =>
      toast.error('Could not close the QC browser', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const maximize = useMutation({
    mutationFn: maximizeQcBrowser,
    onSuccess: () => toast.success('Window maximized'),
    onError: (err) =>
      toast.error('Could not resize the window', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  const toggle = useMutation({
    mutationFn: (next: boolean) => updateProject(project.id, { persistentBrowser: next }),
    onSuccess: (_res, next) => {
      toast.success(next ? 'Browser automation attached' : 'Back to a per-run browser', {
        description: next
          ? "This project's Playwright now drives the QC browser, which survives Stop."
          : 'Playwright will launch (and close) its own browser again.',
      })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['mcp', project.id] })
      queryClient.invalidateQueries({ queryKey: ['mcp-health', project.id] })
    },
    onError: (err) =>
      toast.error('Could not change the setting', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const running = data?.running === true
  const noBrowser = data && data.available.length === 0

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <MonitorPlay className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-semibold">QC browser</p>
              <span
                title={running ? data?.version : 'Not running'}
                className={cn(
                  'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  isFetching && !data
                    ? 'bg-muted text-muted-foreground'
                    : running
                      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {isFetching && !data ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      running ? 'bg-emerald-500' : 'bg-muted-foreground/50',
                    )}
                  />
                )}
                {isFetching && !data ? 'Checking' : running ? 'Open' : 'Closed'}
              </span>
              {attached && (
                <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-400">
                  This project attaches to it
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              A browser window the portal owns, so pressing <span className="font-medium">Stop</span>{' '}
              pauses the run instead of closing it — the pages, logins and half-filled forms stay
              put, you fix what you need, and the next message carries on from there. It also opens{' '}
              <span className="font-medium">maximized</span> rather than in a 1280×720 box.
            </p>
          </div>
        </div>

        {noBrowser ? (
          <p className="rounded-2xl border border-amber-300/70 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            Neither Microsoft Edge nor Google Chrome was found on the machine running the portal.
            Install one (or set <code className="font-mono">QC_BROWSER_PATH</code>) to use this.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={running ? 'outline' : 'default'}
              disabled={start.isPending || running}
              onClick={() => start.mutate()}
              className="h-9 rounded-full active:scale-[0.98]"
            >
              {start.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? 'Already open' : 'Open browser'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={maximize.isPending || !running}
              onClick={() => maximize.mutate()}
              title="Resize the window to fill the screen"
              className="h-9 rounded-full active:scale-[0.98]"
            >
              {maximize.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Maximize2 className="size-4" />
              )}
              Maximize
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={stop.isPending || !running}
              onClick={() => stop.mutate()}
              className="h-9 rounded-full active:scale-[0.98]"
            >
              {stop.isPending ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              variant={attached ? 'outline' : 'default'}
              disabled={toggle.isPending}
              onClick={() => toggle.mutate(!attached)}
              className="ml-auto h-9 rounded-full active:scale-[0.98]"
            >
              {toggle.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : attached ? (
                <Unplug className="size-4" />
              ) : (
                <Plug className="size-4" />
              )}
              {attached ? 'Detach this project' : 'Attach this project'}
            </Button>
          </div>
        )}

        {running && (
          <p className="font-mono text-[11px] text-muted-foreground">
            {data?.endpoint}
            {data?.version ? ` · ${data.version}` : ''}
            {!data?.startedHere && ' · started outside this portal session — close it yourself'}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// Persisted health cache — the live probe (`claude mcp list`) is slow, so we keep
// the last-known { name: status } map per project in localStorage. On reload the
// cards seed from it and show their previous Connected/… badge INSTANTLY, while a
// fresh probe runs quietly in the background instead of flashing "Checking".
type HealthMap = Record<string, McpServer['status']>
function healthCacheKey(projectId: string) {
  return `qc.mcpHealth.${projectId}`
}
function readHealthCache(projectId: string): { map: HealthMap; at: number } | null {
  try {
    const raw = localStorage.getItem(healthCacheKey(projectId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as { map?: HealthMap; at?: number }
    // An EMPTY map is never a real reading — it is what a timed-out probe used to
    // return, and seeding it hid every badge for the next five minutes.
    if (parsed && typeof parsed === 'object' && parsed.map && Object.keys(parsed.map).length) {
      return { map: parsed.map, at: typeof parsed.at === 'number' ? parsed.at : 0 }
    }
  } catch {
    /* corrupt/absent cache — fall through to a live probe */
  }
  return null
}
function writeHealthCache(projectId: string, map: HealthMap) {
  if (!Object.keys(map).length) return
  try {
    localStorage.setItem(healthCacheKey(projectId), JSON.stringify({ map, at: Date.now() }))
  } catch {
    /* storage full/blocked — the in-memory query still works */
  }
}

export default function McpPage() {
  const { activeProjectId, activeProject } = useProjects()
  // Two-phase load: the structural list comes back instantly (health=false), so
  // the cards render immediately; live health is a separate, slower query whose
  // result is merged in below. This keeps the page from blocking on the probe.
  const { data: listData, isLoading, isError, error } = useQuery({
    queryKey: ['mcp', activeProjectId],
    queryFn: () => listMcp(activeProjectId as string, { health: false }),
    enabled: !!activeProjectId,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })
  // Seed from the persisted cache so a reload paints the last-known statuses
  // immediately. initialDataUpdatedAt lets React Query decide freshness: a recent
  // cache (< staleTime) is used as-is; an older one refetches quietly in the
  // background (data stays visible, so no "Checking" flash — see checkingStatus).
  const cached = useMemo(
    () => (activeProjectId ? readHealthCache(activeProjectId) : null),
    [activeProjectId],
  )
  const {
    data: health,
    isFetching: healthChecking,
    error: healthError,
    refetch: refetchHealth,
  } = useQuery({
    queryKey: ['mcp-health', activeProjectId],
    queryFn: () => mcpHealth(activeProjectId as string),
    enabled: !!activeProjectId,
    // A cold `claude mcp list` can overrun the server's cap once; the second try
    // finds the servers warm. On a final failure React Query KEEPS the last map, so
    // the badges stay instead of vanishing.
    retry: 1,
    retryDelay: 1500,
    initialData: cached?.map,
    initialDataUpdatedAt: cached?.at,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  // Persist every resolved health map so the next reload can seed from it.
  useEffect(() => {
    if (activeProjectId && health) writeHealthCache(activeProjectId, health)
  }, [activeProjectId, health])
  // Merge live statuses onto the structural list. Until health resolves, servers
  // keep their "unknown" status and the cards show a "Checking" badge.
  const data = useMemo(
    () =>
      listData?.map((s) => ({ ...s, status: health?.[s.name] ?? s.status })),
    [listData, health],
  )

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Plug className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">MCP servers</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <Plug className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to manage its MCP servers.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const servers = data ?? []
  // At-a-glance health for the header summary strip.
  const connectedCount = servers.filter((s) => s.status === 'connected').length
  const attentionCount = servers.filter(
    (s) => s.status === 'pending' || s.status === 'needs-auth' || s.status === 'failed',
  ).length
  const coldChecking = (isLoading || healthChecking) && !health

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Plug className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">MCP servers</h1>
            <p className="text-sm text-muted-foreground">
              Each project has its own Model Context Protocol config — these servers apply only to
              the active project's QC runs.
            </p>
          </div>
          {/* At-a-glance connection health — answers "are my integrations up?" without
              scanning each card. Hidden until there's at least one configured server. */}
          {(servers.length > 0 || coldChecking) && (
            <div className="mt-0.5 flex shrink-0 flex-wrap items-center justify-end gap-1.5 text-xs">
              {coldChecking ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-3 py-1 font-medium text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking…
                </span>
              ) : (
                <>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-medium',
                      connectedCount > 0
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'border border-border/60 bg-muted/60 text-muted-foreground',
                    )}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {connectedCount}/{servers.length} connected
                  </span>
                  {attentionCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 font-medium text-amber-700">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {attentionCount} need attention
                    </span>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {healthError && !healthChecking && (
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 px-4 py-2.5 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              {healthError instanceof Error ? healthError.message : 'The live status check failed.'}
              {health ? ' Showing the last known status.' : ''}
            </span>
            <button
              type="button"
              onClick={() => refetchHealth()}
              className="rounded-full border border-amber-300/70 px-3 py-1 font-medium transition-colors hover:bg-amber-100"
            >
              Retry
            </button>
          </div>
        )}

        {/* Per-project context: makes it unmistakable which .mcp.json is being edited. */}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
            <span className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Editing config for
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                title={`${activeProject.rootPath}/.mcp.json`}
              >
                <FileJson className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/.mcp.json</span>
                <span
                  className={cn(
                    'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    activeProject.hasMcp
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {activeProject.hasMcp ? 'exists' : 'new'}
                </span>
              </span>
              <OpenFolderButton projectId={activeProjectId} />
            </div>
          </div>
        )}
      </header>

      {isError && (
        <div className="flex items-center gap-2 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load MCP server status'}
        </div>
      )}

      <UvWarning />

      {activeProject && <QcBrowserCard project={activeProject} />}

      <ConnectServices
        projectId={activeProjectId}
        projectRoot={activeProject?.rootPath}
        existingNames={servers.map((s) => s.name)}
        statusByName={Object.fromEntries(servers.map((s) => [s.name, s.status]))}
        envByName={Object.fromEntries(servers.map((s) => [s.name, s.env]))}
        serverByName={Object.fromEntries(servers.map((s) => [s.name, s]))}
        // Only show "Checking" on a cold load with nothing to display yet. Once we
        // have statuses (from cache or a prior fetch), background refreshes are silent.
        checkingStatus={(isLoading || healthChecking) && !health}
      />
    </div>
  )
}
