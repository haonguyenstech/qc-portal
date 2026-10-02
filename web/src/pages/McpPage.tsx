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
  MousePointerClick,
  PencilLine,
  Plug,
  PlugZap,
  Plus,
  Search,
  Smartphone,
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
  connectMaestro,
  openMcpFolder,
  removeMcp,
  updateMcp,
  revealMcpEnv,
  saveMcpToken,
  testMcp,
  type McpEntryInput,
  type McpOauthProvider,
  type SigninTracker,
} from '@/lib/api'
import type { McpServer } from '@/lib/types'
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
import { useTrackerSignin } from '@/lib/useTrackerSignin'
import { AzureOrgPrompt } from '@/components/AzureOrgPrompt'

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
  // A hosted tracker server Claude Code reaches with its OWN older login, while the
  // portal's sign-in (Tickets, issue filing) isn't done — "Connected" + a Sign in
  // button side by side read as a contradiction.
  partial: { label: 'Runs & chat only', cls: 'bg-amber-50 text-amber-700', Icon: AlertCircle },
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

/** Which tracker a server is the portal's browser sign-in for: a hosted MCP URL (Jira,
 *  ClickUp), or the Azure DevOps launcher (server/src/azureSignin.ts) — a `node -e`
 *  that fetches the portal's token before starting Microsoft's local server. */
const SIGNIN_LABEL: Record<SigninTracker, string> = { jira: 'Jira', clickup: 'ClickUp', azure: 'Azure DevOps' }

/** The ticket tracker this project already has (token built-in or signed-in server) —
 *  a project reads tickets from ONE (server: trackerConflict in trackerMcp.ts). */
function connectedTrackerOf(servers: McpServer[]): { tracker: SigninTracker; name: string } | null {
  for (const sv of servers) {
    const t = isSigninTracker(sv.name) ? sv.name : signinTrackerOf(sv)
    if (t) return { tracker: t, name: sv.name }
  }
  return null
}

function signinTrackerOf(server: McpServer | undefined): SigninTracker | null {
  const url = server?.url ?? ''
  if (/^https:\/\/mcp\.atlassian\.com\//i.test(url)) return 'jira'
  if (/^https:\/\/mcp\.clickup\.com\//i.test(url)) return 'clickup'
  const args = server?.args ?? []
  if (server?.command === 'node' && args[0] === '-e' && args[1]?.includes('/api/azure/oauth/token')) return 'azure'
  return null
}

/** What each way of connecting a tracker covers — shown under the choice. */
const MODE_COVERS: { feature: string; browser: Record<string, boolean>; only?: string[] }[] = [
  // The browser sign-in is the portal's own (useTrackerSignin): it reads Tickets and
  // files issues itself, and hands the same login to Claude Code for runs and chat.
  { feature: 'QC runs, Chat, AI team (MCP tools)', browser: { clickup: true, jira: true, azure: true, figma: true } },
  { feature: 'Browsing & crawling on Tickets', browser: { clickup: true, jira: true, azure: true }, only: ['clickup', 'jira', 'azure'] },
  // Design Check reaches Figma through whichever Figma MCP server the project has.
  { feature: 'Design Check against Figma', browser: { figma: true }, only: ['figma'] },
  // Atlassian's MCP server has no attachment download.
  { feature: 'Ticket attachments', browser: { jira: false }, only: ['jira'] },
  // Run → Issues files to ClickUp only.
  { feature: 'Filing issues from Run → Issues', browser: { clickup: true }, only: ['clickup'] },
]

function ConnectModeChoice({
  tracker,
  mode,
  onMode,
  label,
  browserName,
}: {
  tracker: string
  mode: 'browser' | 'token'
  onMode: (m: 'browser' | 'token') => void
  label: string
  browserName: string
}) {
  const options = [
    { id: 'browser' as const, title: 'Sign in with browser', hint: 'No token — log in on the provider’s page', icon: KeyRound },
    { id: 'token' as const, title: 'API token', hint: 'Paste a personal token', icon: PlugZap },
  ]
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={`How to connect ${label}`}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={mode === o.id}
            onClick={() => onMode(o.id)}
            className={cn(
              'flex items-start gap-2.5 rounded-2xl border p-3 text-left transition-all duration-200 active:scale-[0.99]',
              mode === o.id
                ? 'border-primary/50 bg-primary/[0.05]'
                : 'border-border/60 hover:border-border hover:bg-muted/40',
            )}
          >
            <o.icon className={cn('mt-0.5 h-4 w-4 shrink-0', mode === o.id ? 'text-primary' : 'text-muted-foreground')} />
            <span className="leading-tight">
              <span className="block text-sm font-semibold tracking-tight">{o.title}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{o.hint}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="space-y-1 rounded-xl bg-muted/50 px-3 py-2">
        {MODE_COVERS.filter((c) => !c.only || c.only.includes(tracker)).map((c) => {
          const ok = mode === 'token' || !!c.browser[tracker]
          return (
            <p key={c.feature} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {ok ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="h-3 w-3 shrink-0 text-amber-600" />
              )}
              <span className={ok ? 'text-foreground/80' : ''}>{c.feature}</span>
              {!ok && <span className="text-amber-700">— needs the API token</span>}
            </p>
          )
        })}
      </div>
      {mode === 'browser' && !isSigninTracker(tracker) && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          Adds <code className="font-mono">{browserName}</code>, the provider’s hosted server, then
          opens its sign-in page. Claude Code keeps the login — nothing secret in .mcp.json — and
          asks again when it expires.
        </p>
      )}
      {mode === 'browser' && isSigninTracker(tracker) && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          One sign-in for everything: Tickets{tracker === 'clickup' ? ', issue filing' : ''}, QC
          runs and Chat. Saved as <code className="font-mono">{browserName}</code> with no key in
          .mcp.json — Claude Code asks the portal for the login each time it connects.
          {tracker === 'azure' &&
            ' Sign in on the computer running the portal (Microsoft returns to localhost). Each run or chat turn gets a fresh token that lasts about an hour.'}
        </p>
      )}
    </div>
  )
}

/**
 * The tracker built-ins that can ALSO be connected by signing in in the browser: the
 * provider's hosted server (an OAuth template). Two different things get connected, so
 * the form has to say which features each one covers — the hosted server's token
 * belongs to Claude Code and only reaches its MCP tools (runs, chat), while ticket
 * crawling and Run → Issues filing call the provider's REST API with the API token.
 */
const BROWSER_SIGNIN_ALT: Partial<Record<SigninTracker, string>> = {
  clickup: 'clickup-oauth',
  jira: 'atlassian',
  // Not a hosted server: Microsoft's local one, started with the portal's token.
  azure: 'azure-devops',
}
const isSigninTracker = (id: string | undefined): id is SigninTracker =>
  id === 'jira' || id === 'clickup' || id === 'azure'
/**
 * Built-ins whose "Sign in with browser" is simply the provider's hosted OAuth template,
 * signed in through Claude Code (`claude mcp login`, the sign-in dialog) — no portal
 * login behind it, because nothing on the portal side reads it.
 */
const HOSTED_SIGNIN_ALT: Partial<Record<string, string>> = { figma: 'figma-oauth' }
/** Hosted templates a built-in's "Sign in with browser" already adds — one tile per
 *  service, the choice is made inside it. */
const COVERED_BY_BUILTIN = new Set([...Object.values(BROWSER_SIGNIN_ALT), ...Object.values(HOSTED_SIGNIN_ALT)])

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
  onTrackerSignin,
  trackerSigninPending,
  connectedTracker,
  onSigninTab,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  projectRoot?: string
  existingNames: string[]
  onAdded: (names: string[]) => void
  /** Start the portal's browser sign-in for a tracker. Owned by the PAGE, not this
   *  dialog: the dialog closes straight away, and whatever watches for the sign-in to
   *  land must outlive it. */
  onTrackerSignin: (tracker: SigninTracker, org?: string) => void
  trackerSigninPending: boolean
  /** The ticket tracker already connected — the other two are refused while it is. */
  connectedTracker: { tracker: SigninTracker; name: string } | null
  /** A sign-in tab opened in the Add click (OAuth servers), or null to drop one that
   *  will not be used (the add failed). */
  onSigninTab: (tab: Window | null) => void
}) {
  const [tab, setTab] = useState<'templates' | 'paste'>('templates')
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [picked, setPicked] = useState<McpTemplate | null>(null)
  const [templateName, setTemplateName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [pasted, setPasted] = useState('')
  // Name edits for pasted servers, keyed by the name as pasted.
  const [renames, setRenames] = useState<Record<string, string>>({})
  // ClickUp / Jira / Azure DevOps only: sign in in the browser or paste an API token.
  const [authMode, setAuthMode] = useState<'browser' | 'token'>('browser')

  const taken = useMemo(() => new Set(existingNames), [existingNames])

  function pick(t: McpTemplate) {
    setPicked(t)
    setAuthMode('browser')
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
  // The signed-in server for this built-in, when "Sign in with browser" is chosen.
  const signinTracker = isSigninTracker(picked?.id) ? picked.id : undefined
  const hostedAlt = picked && !signinTracker ? MCP_TEMPLATES.find((t) => t.id === HOSTED_SIGNIN_ALT[picked.id]) : undefined
  const browserName = signinTracker
    ? BROWSER_SIGNIN_ALT[signinTracker]
    : hostedAlt
      ? uniqueName(hostedAlt.name, taken)
      : undefined
  const viaBrowser = !!browserName && authMode === 'browser'
  // Already signed in under the template's name → adding it again would only make a copy.
  const missingField = viaBrowser
    ? undefined
    : picked?.fields.find((f) => !f.optional && !values[f.key]?.trim())
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
    onError: (err) => {
      onSigninTab(null)
      toast.error('Could not add server', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    },
  })

  function submitTemplate() {
    if (viaBrowser && signinTracker) {
      // The portal's own sign-in; its callback writes (or links) the server entry.
      // Azure: the organization field is optional — an org URL or a bare name.
      const org = values.ORG_URL?.trim().replace(/\/+$/, '').split('/').pop()
      onTrackerSignin(signinTracker, signinTracker === 'azure' ? org || undefined : undefined)
      onOpenChange(false)
      return
    }
    if (viaBrowser && hostedAlt && browserName) {
      // Add the hosted server, then sign in to it — in a tab opened NOW, in this click.
      // (`add` closes the dialog itself once the entry is saved.)
      onSigninTab(openSigninTab())
      add.mutate({ [browserName]: hostedAlt.entry })
      return
    }
    if (!picked || !templateEntry || templateProblem || missingField) return
    if (picked.builtin) {
      if (!maestroBlocked) connectBuiltin.mutate(picked)
      return
    }
    // A sign-in template (a hosted server with no token): same — its tab opens now.
    if (picked.category === 'Sign in (OAuth)') onSigninTab(openSigninTab())
    add.mutate({ [templateName.trim()]: templateEntry })
  }
  const pending = add.isPending || connectBuiltin.isPending || trackerSigninPending

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
  // The hosted ClickUp / Atlassian templates are what the ClickUp / Jira built-ins'
  // "Sign in with browser" adds — listing them too showed every tracker twice. Still
  // shown once added, so the tile says so.
  const listed = MCP_TEMPLATES.filter((t) => !COVERED_BY_BUILTIN.has(t.id) || taken.has(t.name))
  const matches = listed.filter(
    (t) => !q || `${t.label} ${t.blurb} ${t.category}`.toLowerCase().includes(q),
  )
  // A search that empties the chosen category falls back to All rather than an empty list.
  const activeCategory =
    category !== 'All' && !matches.some((t) => t.category === category) ? 'All' : category
  const visible = activeCategory === 'All' ? matches : matches.filter((t) => t.category === activeCategory)

  return (
    <Dialog open={open} onOpenChange={(o) => !add.isPending && !connectBuiltin.isPending && onOpenChange(o)}>
      <DialogContent className="max-h-[88vh] gap-4 overflow-y-auto overflow-x-hidden sm:max-w-3xl">
        <DialogHeader className="min-w-0">
          <DialogTitle className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-foreground text-background">
              <Plus className="h-4 w-4" />
            </span>
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
                    placeholder={`Search ${listed.length} servers…`}
                    aria-label="Search templates"
                    className="h-9 rounded-full pl-8 text-sm"
                  />
                </div>
                {/* Categories as one row of pills: the list stays one screen tall instead of
                    seven stacked sections. "All" still groups by category below. */}
                <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5" role="tablist" aria-label="Category">
                  {['All', ...MCP_TEMPLATE_CATEGORIES].map((c) => {
                    const count = c === 'All' ? matches.length : matches.filter((t) => t.category === c).length
                    if (c !== 'All' && !count) return null
                    const on = activeCategory === c
                    return (
                      <button
                        key={c}
                        type="button"
                        role="tab"
                        aria-selected={on}
                        onClick={() => setCategory(c)}
                        className={cn(
                          'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-all duration-200 active:scale-[0.97]',
                          on
                            ? 'border-foreground bg-foreground text-background'
                            : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                        )}
                      >
                        {c}
                        <span className={cn('tabular-nums', on ? 'text-background/70' : 'text-muted-foreground/70')}>
                          {count}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <div className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
                  {MCP_TEMPLATE_CATEGORIES.map((cat) => {
                    const items = visible.filter((t) => t.category === cat)
                    if (!items.length) return null
                    return (
                      <section key={cat} className="space-y-2">
                        {activeCategory === 'All' && (
                          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {cat}
                          </h3>
                        )}
                        {cat === 'QC essentials' && connectedTracker && (
                          <p className="flex items-start gap-1.5 rounded-xl bg-muted/60 px-3 py-2 text-[11px] leading-snug text-muted-foreground">
                            <Info className="mt-px h-3.5 w-3.5 shrink-0" />
                            <span>
                              One ticket tracker per project. This one uses{' '}
                              <b className="text-foreground">{SIGNIN_LABEL[connectedTracker.tracker]}</b> (
                              <code className="font-mono">{connectedTracker.name}</code>) — to switch, disconnect it
                              first, then add the other.
                            </span>
                          </p>
                        )}
                        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                          {items.map((t) => {
                            // A service is connected ONCE per project, in whatever form — the
                            // template's own name, its sign-in twin (`clickup-oauth`, `figma-oauth`…),
                            // or, for a tracker, any server of it (the server refuses a second too).
                            const addedAs =
                              [t.name, BROWSER_SIGNIN_ALT[t.id as SigninTracker], HOSTED_SIGNIN_ALT[t.id]].find(
                                (n): n is string => !!n && taken.has(n),
                              ) ??
                              (isSigninTracker(t.id) && connectedTracker?.tracker === t.id
                                ? connectedTracker.name
                                : undefined)
                            const added = !!addedAs
                            const locked = added
                            // One ticket tracker per project: the others wait until it is removed.
                            const otherTracker =
                              !added &&
                              !!connectedTracker &&
                              isSigninTracker(t.id) &&
                              t.id !== connectedTracker.tracker
                            const dualMode = !!t.builtin && (isSigninTracker(t.id) || !!HOSTED_SIGNIN_ALT[t.id])
                            const inUse = connectedTracker ? SIGNIN_LABEL[connectedTracker.tracker] : ''
                            // What the tile is, and — when it can't be picked — why, and what to do.
                            const tip = otherTracker ? (
                              <>
                                <b>One ticket tracker per project.</b> This project already reads its tickets
                                from {inUse} (<code className="font-mono">{connectedTracker?.name}</code>). To use{' '}
                                {t.label} instead, disconnect <code className="font-mono">{connectedTracker?.name}</code>{' '}
                                in the server list first, then add {t.label}.
                              </>
                            ) : locked ? (
                              <>
                                <b>Already added</b> as <code className="font-mono">{addedAs}</code> — a server is
                                connected once per project. Test, edit or disconnect it in the server list; to
                                connect it another way, disconnect it first.
                              </>
                            ) : (
                              <>
                                {t.blurb}
                                {dualMode && (
                                  <span className="mt-1 block opacity-80">
                                    Connect by signing in with your browser (no token) or with an API token — you
                                    choose on the next step.
                                  </span>
                                )}
                              </>
                            )
                            return (
                              <Tooltip key={t.id}>
                                <TooltipTrigger asChild>
                                  {/* A disabled button gets no pointer events, so the tooltip hangs on
                                      this wrapper — the locked tiles are the ones that most need it. */}
                                  <span className="block min-w-0" tabIndex={locked || otherTracker ? 0 : -1}>
                                    <button
                                      type="button"
                                      onClick={() => pick(t)}
                                      disabled={locked || otherTracker}
                                      className="group flex w-full min-w-0 items-center gap-2.5 rounded-2xl border border-border/60 bg-card px-3 py-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.99] disabled:pointer-events-none disabled:opacity-55"
                                    >
                                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-muted/70 text-muted-foreground transition-colors group-hover:bg-foreground group-hover:text-background">
                                        <t.icon className="h-4 w-4" />
                                      </span>
                                      <span className="min-w-0 flex-1 leading-tight">
                                        <span className="flex items-center gap-1.5">
                                          <span className="truncate text-[13px] font-semibold tracking-tight">{t.label}</span>
                                          {added ? (
                                            <span className="shrink-0 rounded-full bg-emerald-50 px-1.5 py-px text-[10px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400">
                                              Added
                                            </span>
                                          ) : otherTracker ? (
                                            <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
                                              Remove {inUse} first
                                            </span>
                                          ) : dualMode ? (
                                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                                              Sign in · token
                                            </span>
                                          ) : null}
                                        </span>
                                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                          {t.blurb}
                                        </span>
                                      </span>
                                    </button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent side="bottom" className="max-w-72 text-xs leading-snug">
                                  {tip}
                                </TooltipContent>
                              </Tooltip>
                            )
                          })}
                        </div>
                      </section>
                    )
                  })}
                  {!visible.length && (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      No template matches — use <b>Paste JSON</b> for any other server.
                    </p>
                  )}
                </div>
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

                {browserName && (
                  <ConnectModeChoice
                    tracker={picked.id}
                    mode={authMode}
                    onMode={setAuthMode}
                    label={picked.label}
                    browserName={browserName}
                  />
                )}
                {viaBrowser && signinTracker === 'azure' && (
                  <Field label="Organization (optional)">
                    <Input
                      value={values.ORG_URL ?? ''}
                      onChange={(e) => setValues((m) => ({ ...m, ORG_URL: e.target.value }))}
                      placeholder="your-org or https://dev.azure.com/your-org"
                      aria-label="Azure DevOps organization"
                      className="h-9 text-xs"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Leave empty to use your account's first organization — you can switch on the Tickets page.
                    </p>
                  </Field>
                )}
                {viaBrowser ? null : picked.builtin ? (
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
                {!viaBrowser && picked.fields.map((f, i) => (
                  <TemplateFieldInput
                    key={f.key}
                    field={f}
                    autoFocus={i === 0}
                    value={values[f.key] ?? ''}
                    onChange={(v) => setValues((m) => ({ ...m, [f.key]: v }))}
                  />
                ))}
                {!viaBrowser && picked.builtin && tokenUrl(picked.builtin) && (
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
                {picked.needsUv && !viaBrowser && (
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
              disabled={
                !picked ||
                (!viaBrowser && (!!templateProblem || !!missingField || maestroBlocked)) ||
                pending
              }
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : viaBrowser ? (
                <KeyRound className="h-4 w-4" />
              ) : (
                <PlugZap className="h-4 w-4" />
              )}
              {viaBrowser ? 'Add & sign in' : 'Add & test'}
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

/**
 * Open the tab a provider sign-in will use NOW, inside the click. Jira / ClickUp do the
 * same (useTrackerSignin); for any other OAuth server the sign-in URL only exists after
 * the server is added and `claude mcp login` has started — a window opened then is a
 * popup the browser blocks, which is why the sign-in page never opened by itself. The
 * tab says what it is waiting for until `SignInDialog` points it at the provider. Null
 * when the browser blocks even this; the dialog's "Open sign-in page" still works.
 */
function openSigninTab(): Window | null {
  const tab = window.open('', '_blank')
  try {
    tab?.document.write(
      '<!doctype html><title>Signing in…</title><body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0;color:#555">Preparing the sign-in page…</body>',
    )
  } catch {
    /* cross-origin already — nothing to write */
  }
  return tab
}

/** Send a tab opened by `openSigninTab` to the provider's sign-in page. */
function pointTab(tab: Window, url: string): void {
  tab.location.href = url
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
  tab,
  onClose,
  onSignedIn,
}: {
  name: string
  projectId: string
  /** A tab opened in the click that started this (`openSigninTab`) — pointed at the
   *  sign-in page as soon as it is known. */
  tab: Window | null
  /** `signedIn`: whether this dialog saw the sign-in succeed (the page tests the row
   *  either way, but only once). */
  onClose: (signedIn: boolean) => void
  onSignedIn: (name: string) => void
}) {
  const [jobId, setJobId] = useState<string | null>(null)
  const [pasted, setPasted] = useState('')
  const [copied, setCopied] = useState(false)

  const start = useMutation({
    mutationFn: () => startMcpSignin(name, projectId),
    onSuccess: (res) => setJobId(res.job.id),
    // Could not even start: close the tab still saying "Preparing…".
    onError: () => {
      if (tab && !tab.closed && !openedInTab) tab.close()
    },
  })
  // Start once on open; "Try again" calls it again.
  useEffect(() => {
    start.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, [])

  // Whether the waiting tab has been sent to the provider (see the poll below).
  const [openedInTab, setOpenedInTab] = useState(false)
  const { data } = useQuery({
    queryKey: ['mcp-signin', projectId, name, jobId],
    queryFn: async () => {
      const res = await getMcpSignin(name, projectId)
      const job = res.job
      if (tab && !tab.closed && !openedInTab && job?.id === jobId) {
        // The moment the URL is known, send the waiting tab there — the browser then
        // shows the sign-in page by itself, as it does for Jira / ClickUp.
        if (job.signInUrl) {
          pointTab(tab, job.signInUrl)
          setOpenedInTab(true)
        } else if (job.state === 'failed' || job.state === 'cancelled') {
          // Failed before there was a page: don't leave a tab saying "Preparing…".
          tab.close()
        }
      }
      return res
    },
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
    if (tab && !tab.closed && !openedInTab) tab.close()
    onClose(!!job && announced.current === job.id)
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
                {openedInTab
                  ? 'Opened in a new tab — sign in and allow access there; this finishes by itself.'
                  : 'Waiting — on this computer, this finishes by itself once you allow access.'}
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
  // The tab opened in the click that leads to that sign-in (`openSigninTab`).
  const signinTab = useRef<Window | null>(null)
  /** Start Claude Code's sign-in for `name` in a tab opened right now, in the click. */
  function signInWithTab(name: string) {
    signinTab.current = openSigninTab()
    setSigninName(name)
  }
  // The hosted tracker servers (Atlassian, ClickUp) sign in through the portal's own
  // login (useTrackerSignin) — one login for Tickets, filing, runs and chat. When it
  // lands, re-test that row (like `afterSignin`) so it turns green by itself.
  const jiraSignin = useTrackerSignin('jira', projectId, () => void afterTrackerSignin('jira'))
  const clickupSignin = useTrackerSignin('clickup', projectId, () => void afterTrackerSignin('clickup'))
  const azureSignin = useTrackerSignin('azure', projectId, () => void afterTrackerSignin('azure'))
  const signins = { jira: jiraSignin, clickup: clickupSignin, azure: azureSignin }
  const signinFor = (name: string) => {
    const tracker = signinTrackerOf(serverByName[name])
    return tracker ? signins[tracker] : null
  }
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
    onSuccess: (res, name) => {
      toast.success(`${name} disconnected`, {
        description: res?.signedOut
          ? `Removed from this project's .mcp.json and signed out of ${SIGNIN_LABEL[res.signedOut]} — Tickets no longer uses it.`
          : "Removed from this project's .mcp.json.",
      })
      forgetStatus([name])
      if (res?.signedOut) {
        // The Tickets page must not keep showing tickets from the login that just ended.
        for (const key of [`${res.signedOut}-signin`, `${res.signedOut}-status`]) {
          queryClient.invalidateQueries({ queryKey: [key, projectId] })
        }
        queryClient.removeQueries({ queryKey: ['ticket-workspaces'] })
        queryClient.removeQueries({ queryKey: ['ticket-tasks'] })
        queryClient.removeQueries({ queryKey: ['clickup-list-tasks'] })
      }
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
        {(remote || signinFor(name)) &&
          (status === 'needs-auth' || (signinFor(name)?.status && !signinFor(name)?.status?.signedIn)) && (
          <Button
            size="sm"
            onClick={() => {
              const portal = signinFor(name)
              if (portal) portal.start.mutate()
              else signInWithTab(name)
            }}
            title={
              signinFor(name) && status === 'connected'
                ? 'Runs and chat already work — this sign-in lets Tickets and issue filing use it too'
                : undefined
            }
            disabled={testing || disconnecting}
            className="h-8 rounded-full px-3 text-xs font-medium transition-all duration-200 active:scale-[0.98]"
          >
            <KeyRound className="h-3.5 w-3.5" />
            {signinFor(name) && status === 'connected' ? 'Sign in for Tickets' : 'Sign in'}
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
        badge={
          <CardStatusBadge
            configured
            status={statusByName[name]}
            checking={checkingStatus || testingNames.has(name)}
          />
        }
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
    // Added from a sign-in template, with its tab already open: go straight to signing
    // in — a new OAuth server is never signed in yet, and the ~7s test first is what
    // made the sign-in page feel like it never came.
    if (signinTab.current && names.length === 1) {
      await queryClient.invalidateQueries({ queryKey: ['mcp', projectId] })
      setSigninName(names[0])
      return
    }
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

  async function afterTrackerSignin(tracker: SigninTracker) {
    // The callback may have just ADDED the entry — refetch the LIST only (instant) for its
    // name, then test that one row. Waiting on the full live-health refresh first (a
    // `claude mcp list`, ~7s, twice via afterSignin) left the new row with no badge at
    // all for ~20s, which read as "signed in, but nothing happened".
    await queryClient.invalidateQueries({ queryKey: ['mcp', projectId] })
    const fresh = queryClient.getQueryData<McpServer[]>(['mcp', projectId]) ?? []
    const row = fresh.find((s) => signinTrackerOf(s) === tracker)
    if (!row) return
    forgetStatus([row.name])
    await test.mutateAsync(row.name).catch(() => undefined)
  }

  async function afterSignin(name: string) {
    // Test THIS row straight away — it shows "Checking…" at once and its own result in
    // ~7s. Waiting on the project-wide health refresh first (another `claude mcp list`)
    // left the just-signed-in row with no badge at all for 10-15s, which read as "signed
    // in, but the page didn't notice" — the same fix as afterTrackerSignin.
    forgetStatus([name])
    void queryClient.invalidateQueries({ queryKey: ['mcp-oauth', projectId] })
    await test.mutateAsync(name).catch(() => undefined)
  }

  const signOut = useMutation({
    mutationFn: (name: string) => logoutMcpSignin(name, projectId),
    onSuccess: (res, name) => {
      toast.success(`Signed out of ${name}`, { description: res.detail })
      // Like afterSignin: test this row at once ("Checking…", then "needs sign-in")
      // rather than waiting on a project-wide health refresh with no badge.
      forgetStatus([name])
      return test.mutateAsync(name).catch(() => undefined)
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
    // A tracker connected ONLY by browser sign-in: say what that leaves out, here where
    // the engineer sees it as "connected", not later as a failed crawl.
    const portal = signinFor(server.name)
    const live = statusByName[server.name]
    const partial = !!portal?.status && !portal.status.signedIn && live === 'connected'
    const signinNote = portal
      ? portal.status?.needsOrg
        ? ' · signed in to Microsoft — choose the organization above to finish'
        : portal.status?.signedIn
        ? ` · signed in to ${portal.status.site?.name ?? 'the workspace'} — Tickets, QC runs and Chat`
        : partial
          ? ' · QC runs and Chat work; sign in once more so Tickets and issue filing can use it too'
          : ' · not signed in — sign in once for Tickets, QC runs and Chat'
      : ''
    return (
      <ServerRow
        key={server.name}
        icon={iconForServer(server.name)}
        title={<span className="truncate font-mono">{server.name}</span>}
        subtitle={
          `${server.type ?? 'stdio'}${server.source === 'local' ? ' · local scope' : ''}` +
          signinNote
        }
        status={partial ? 'pending' : live}
        badge={
          <CardStatusBadge
            configured
            status={partial ? 'partial' : live}
            // A row being tested says so — a just-added / just-signed-in server has no
            // status yet, and no badge at all read as "nothing happened".
            checking={checkingStatus || testingNames.has(server.name)}
          />
        }
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

      {/* Only beside an Azure DevOps server row — the step belongs to that server. */}
      {azureSignin.status?.needsOrg &&
        !azureSignin.waiting &&
        Object.values(serverByName).some((x) => signinTrackerOf(x) === 'azure') && (
        <AzureOrgPrompt
          projectId={projectId}
          signin={azureSignin}
          onLinked={() => {
            queryClient.invalidateQueries({ queryKey: ['azure-signin', projectId] })
            queryClient.invalidateQueries({ queryKey: ['azure-status', projectId] })
            queryClient.invalidateQueries({ queryKey: ['ticket-workspaces'] })
            void afterTrackerSignin('azure')
          }}
        />
      )}

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
        onTrackerSignin={(t, org) => signins[t].start.mutate(org)}
        trackerSigninPending={Object.values(signins).some((x) => x.start.isPending)}
        connectedTracker={connectedTrackerOf(Object.values(serverByName) as McpServer[])}
        onSigninTab={(tab) => {
          if (!tab && signinTab.current && !signinTab.current.closed) signinTab.current.close()
          signinTab.current = tab
        }}
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
          tab={signinTab.current}
          onClose={(signedIn) => {
            const name = signinName
            signinTab.current = null
            setSigninName(null)
            // Closed WITHOUT signing in: a server added straight into sign-in was never
            // tested (afterAdd skips it), so test it now — otherwise its row has no badge.
            // A successful sign-in is already being tested by afterSignin.
            if (!signedIn && name) {
              forgetStatus([name])
              test.mutate(name)
            }
          }}
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
