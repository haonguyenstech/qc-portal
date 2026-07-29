import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  BookOpen,
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
  FlaskConical,
  Globe,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  MousePointerClick,
  Plug,
  PlugZap,
  Smartphone,
  SquareKanban,
  Unplug,
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
import {
  addMcp,
  listMcp,
  mcpHealth,
  mcpOauthStatus,
  mcpUvStatus,
  mcpMaestroStatus,
  connectMaestro,
  openMcpFolder,
  removeMcp,
  revealMcpEnv,
  revealMcpSecret,
  runMcpTest,
  saveMcpToken,
  testMcp,
  type McpCapabilityResult,
  type McpOauthProvider,
} from '@/lib/api'
import type { McpServer } from '@/lib/types'
import { useProjects } from '@/lib/project-context'

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

/**
 * Inline one-liner describing what a server is for, shown in the BODY of a
 * not-yet-connected card. It fills the empty space that "Connect" (pinned to the
 * bottom via mt-auto) would otherwise leave, and tells the QC why the integration
 * matters. Connected cards omit it (their body already holds the token + actions).
 */
function PurposeBlurb({ name }: { name: string }) {
  const text = SERVER_PURPOSE[name]
  if (!text) return null
  return <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>
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

// Functional ("does it actually work?") test per known server: a real action run
// through the MCP via Claude. Mirrors the server's CAPABILITY_TESTS.
const CAPABILITY: Record<
  string,
  { needsInput: boolean; inputLabel: string; placeholder: string; action: string }
> = {
  clickup: {
    needsInput: true,
    inputLabel: 'Ticket ID',
    placeholder: 'e.g. 86eqk2hfk',
    action: 'Fetch ticket',
  },
  figma: {
    needsInput: true,
    inputLabel: 'Figma design link',
    placeholder: 'https://www.figma.com/design/…',
    action: 'Read design',
  },
  jira: {
    needsInput: true,
    inputLabel: 'Issue key',
    placeholder: 'e.g. PROJ-123',
    action: 'Fetch issue',
  },
  playwright: {
    needsInput: false,
    inputLabel: '',
    placeholder: '',
    action: 'Open Google & close',
  },
  maestro: {
    needsInput: false,
    inputLabel: '',
    placeholder: '',
    action: 'List devices',
  },
}

// Badge shown on a connected card, driven by LIVE health — not just "is it in
// .mcp.json". A server can be configured but Pending approval / Needs auth / Failed.
const CARD_STATUS: Record<string, { label: string; cls: string; Icon: typeof Figma }> = {
  connected: { label: 'Connected', cls: 'bg-emerald-50 text-emerald-700', Icon: CheckCircle2 },
  pending: { label: 'Pending approval', cls: 'bg-amber-50 text-amber-700', Icon: Clock },
  'needs-auth': { label: 'Needs auth', cls: 'bg-amber-50 text-amber-700', Icon: KeyRound },
  failed: { label: 'Failed', cls: 'bg-red-50 text-red-700', Icon: AlertCircle },
}

// Whole-card treatment. A connected server gets a subtle emerald tint + border so
// the active integrations pop out of the grid at a glance; everything else keeps the
// neutral hairline card. Opacity-based emerald reads correctly in light AND dark.
function mcpCardClass(status?: string): string {
  return cn(
    'flex h-full flex-col gap-2.5 rounded-3xl border p-4 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm',
    status === 'connected'
      ? 'border-emerald-500/40 bg-emerald-500/[0.04] hover:border-emerald-500/60'
      : 'border-border/60 hover:border-border',
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
    '--viewport-size',
    '1280x720',
    // NO --user-data-dir here. The profile directory is a fact about the machine
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

/** Colored result line shared by the functional-test surfaces (green / amber / red). */
function ResultLine({ result }: { result: { ok: boolean; warn?: boolean; detail: string } }) {
  const Icon = !result.ok ? AlertCircle : result.warn ? AlertTriangle : CheckCircle2
  return (
    <p
      className={cn(
        'flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs leading-snug',
        !result.ok
          ? 'bg-red-50 text-red-700'
          : result.warn
            ? 'bg-amber-50 text-amber-700'
            : 'bg-emerald-50 text-emerald-700',
      )}
    >
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{result.detail}</span>
    </p>
  )
}

/**
 * Split a detected device label into something renderable. Maestro reports a
 * simulator as one long string — "iPhone 15 Pro - iOS 17.2 - 240CB27F-…-F3485DDA3ED6"
 * — so the primary line takes the first segment and the rest becomes a caption.
 *
 * `platform` is NOT a two-way iOS-or-Android guess: Maestro's always-present
 * `chromium` entry is a desktop browser, and labeling it "Android" is simply wrong.
 *
 * The RAW string stays the value sent to the drive step (that prompt matches the
 * device by name/id), so this only shapes what's on screen.
 */
function describeDevice(raw: string): {
  name: string
  caption: string
  platform: 'iOS' | 'Android' | 'Web'
} {
  const parts = raw
    .split(/\s+[-–—|·]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const name = parts[0] || raw
  const platform = /chromium|chrome|browser|safari|firefox|webkit|\bweb\b/i.test(raw)
    ? 'Web'
    : /iphone|ipad|ipod|\bios\b|simulator/i.test(raw)
      ? 'iOS'
      : 'Android'
  // Don't prefix a platform the label already states — "iOS · iOS 17.2 · <udid>" reads
  // like a bug.
  const rest = parts.slice(1)
  const stated = rest.some((p) => new RegExp(`^${platform}\\b`, 'i').test(p))
  return { name, caption: [...(stated ? [] : [platform]), ...rest].join(' · '), platform }
}

/**
 * Mobile functional test — a two-step dialog. On open it auto-detects connected
 * devices/simulators (empty-input capability test); if any are found it shows a
 * device picker + an enabled "Run test" that actually drives the selected device.
 * No devices → amber notice, test stays disabled.
 */
function MobileFunctionalTest({
  name,
  label,
  projectId,
  onClose,
}: {
  name: string
  label: string
  projectId: string
  onClose: () => void
}) {
  const [device, setDevice] = useState('')
  const detect = useMutation({ mutationFn: () => runMcpTest(name, projectId, '') })
  const runTest = useMutation({ mutationFn: (dev: string) => runMcpTest(name, projectId, dev) })

  // The component is freshly mounted each time the dialog opens (parent gates it),
  // so a bare mount-time detect is enough — no state to reset.
  useEffect(() => {
    detect.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const detectResult = detect.data
  const devices =
    detectResult && Array.isArray(detectResult.data?.devices)
      ? (detectResult.data!.devices as unknown[]).map(String)
      : []
  const selected = device || devices[0] || ''
  const detecting = detect.isPending
  const testing = runTest.isPending
  const detectError = detect.isError
    ? { ok: false, detail: detect.error instanceof Error ? detect.error.message : 'Detection failed' }
    : null

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !detecting && !testing) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4" />
            Functional test — {label}
          </DialogTitle>
          <DialogDescription>
            Detects connected devices/simulators, then drives the one you pick to confirm the server
            actually works — not just that it's configured.
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is a grid, so a grid item's automatic minimum size is
            its min-content width — a device label containing an unbreakable 36-char udid
            blows the column past the dialog's max-width and paints the rows and footer
            outside the card. Verified: without this the content box measures 591px inside
            a 448px dialog. */}
        <div className="min-w-0 space-y-3">
          {detecting ? (
            <p className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Detecting devices…
            </p>
          ) : detectError ? (
            <ResultLine result={detectError} />
          ) : detectResult && devices.length === 0 ? (
            // Detection succeeded but nothing to drive (amber), or a real failure (red).
            <ResultLine result={detectResult} />
          ) : detectResult ? (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {devices.length} device{devices.length > 1 ? 's' : ''} detected · pick one to test
              </label>
              <div className="space-y-1.5">
                {devices.map((d) => {
                  const active = selected === d
                  const info = describeDevice(d)
                  const DeviceIcon = info.platform === 'Web' ? Globe : Smartphone
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDevice(d)}
                      disabled={testing}
                      aria-pressed={active}
                      // The raw label carries the udid/serial, which the row truncates.
                      title={d}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.99] disabled:opacity-60',
                        active
                          ? 'border-primary/40 bg-primary/5'
                          : 'border-border/60 bg-muted/40 hover:border-border hover:bg-muted/70',
                      )}
                    >
                      <span
                        className={cn(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-background',
                          active ? 'border-primary/30 text-primary' : 'border-border/60 text-muted-foreground',
                        )}
                      >
                        <DeviceIcon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-sm font-medium">{info.name}</span>
                        <span className="block truncate text-[11px] text-muted-foreground">
                          {info.caption}
                        </span>
                      </span>
                      {active && <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ) : null}

          {runTest.data && <ResultLine result={runTest.data} />}
          {runTest.isError && (
            <ResultLine
              result={{
                ok: false,
                detail: runTest.error instanceof Error ? runTest.error.message : 'Test failed',
              }}
            />
          )}
        </div>

        <DialogFooter className="min-w-0 sm:flex-wrap">
          <Button variant="ghost" onClick={onClose} disabled={detecting || testing}>
            Close
          </Button>
          <Button
            variant="secondary"
            onClick={() => detect.mutate()}
            disabled={detecting || testing}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {detecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Re-scan
          </Button>
          <Button
            onClick={() => selected && runTest.mutate(selected)}
            disabled={detecting || testing || !selected}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {testing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Testing…
              </>
            ) : (
              <>
                <FlaskConical className="h-4 w-4" />
                Run test
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A labeled group of MCP cards (e.g. "Tickets & tasks") with a header + responsive grid. */
function McpGroup({
  icon: Icon,
  title,
  blurb,
  children,
}: {
  icon: typeof Figma
  title: string
  blurb: string
  children: ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
          <Icon className="h-4 w-4" />
        </span>
        <div className="leading-tight">
          <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
          <p className="text-xs text-muted-foreground">{blurb}</p>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  )
}

/** Token-connect cards for ClickUp/Figma/Jira (paste a personal token) + no-auth Playwright/Mobile. */
function ConnectServices({
  projectId,
  existingNames,
  statusByName,
  envByName,
  serverByName,
  checkingStatus,
}: {
  projectId: string
  existingNames: string[]
  statusByName: Record<string, string | undefined>
  envByName: Record<string, Record<string, string> | undefined>
  serverByName: Record<string, McpServer | undefined>
  checkingStatus: boolean
}) {
  const queryClient = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['mcp-oauth', projectId],
    queryFn: () => mcpOauthStatus(projectId),
  })
  const [openProvider, setOpenProvider] = useState<McpOauthProvider | null>(null)
  const [token, setToken] = useState('')
  // Reveal toggle for the token paste field (eye icon).
  const [showToken, setShowToken] = useState(false)
  // Jira needs a site URL + account email alongside the API token (mcp-atlassian).
  const [jiraUrl, setJiraUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  // Azure DevOps needs an organization URL (+ optional default project) with the PAT.
  const [azureOrgUrl, setAzureOrgUrl] = useState('')
  const [azureProject, setAzureProject] = useState('')
  const [copiedEnv, setCopiedEnv] = useState<string | null>(null)
  // "View details" dialog: which server, a cache of its full (unmasked) env fetched
  // on demand — used BOTH for the Reveal display and for copying real values — and
  // whether the display is currently unmasked.
  const [detailsName, setDetailsName] = useState<string | null>(null)
  const [fullEnv, setFullEnv] = useState<Record<string, string> | null>(null)
  const [showReveal, setShowReveal] = useState(false)
  const [revealingEnv, setRevealingEnv] = useState(false)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  // Default to headed (headless = false) so QC can watch the browser during runs;
  // the checkbox below still lets them opt into headless before connecting.
  const [playwrightHeadless, setPlaywrightHeadless] = useState(false)

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

  function tokenUrlFor(provider: McpOauthProvider): string {
    return status?.providers.find((p) => p.provider === provider)?.tokenUrl ?? ''
  }

  // Connect = open the provider's token page in a new tab, then reveal a paste box.
  function beginConnect(provider: McpOauthProvider) {
    const url = tokenUrlFor(provider)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    setToken('')
    setShowToken(false)
    setJiraUrl('')
    setJiraEmail('')
    setAzureOrgUrl('')
    setAzureProject('')
    setOpenProvider(provider)
  }

  // Whether the connect form has everything it needs to save (Jira also needs URL +
  // email; Azure DevOps needs the organization URL).
  function canSaveToken(provider: McpOauthProvider): boolean {
    if (!token.trim()) return false
    if (provider === 'jira') return !!jiraUrl.trim() && !!jiraEmail.trim()
    if (provider === 'azure') return !!azureOrgUrl.trim()
    return true
  }

  const saveToken = useMutation({
    mutationFn: (provider: McpOauthProvider) =>
      saveMcpToken(
        provider,
        token.trim(),
        projectId,
        provider === 'jira'
          ? { url: jiraUrl.trim(), email: jiraEmail.trim() }
          : provider === 'azure'
            ? { orgUrl: azureOrgUrl.trim(), project: azureProject.trim() || undefined }
            : undefined,
      ),
    onSuccess: (_, provider) => {
      toast.success(`${OAUTH_META[provider].label} connected`, {
        description: "Token saved to this project's .mcp.json.",
      })
      setOpenProvider(null)
      setToken('')
      setShowToken(false)
      setJiraUrl('')
      setJiraEmail('')
      setAzureOrgUrl('')
      setAzureProject('')
      // Auto-run the live connection test so the user doesn't have to click it.
      test.mutate(provider)
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to save token', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

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
  const test = useMutation({
    mutationFn: (name: string) => testMcp(name, projectId),
    onMutate: (name) => setTestingNames((s) => new Set(s).add(name)),
    onSuccess: (res, name) => {
      setTestResults((m) => ({ ...m, [name]: res }))
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

  // Functional MCP test (fetch ticket / read design / open browser).
  const [capInputs, setCapInputs] = useState<Record<string, string>>({})
  const [capResults, setCapResults] = useState<Record<string, McpCapabilityResult>>({})
  // Which server's functional-test dialog is open (null = closed).
  const [capDialogName, setCapDialogName] = useState<string | null>(null)
  const capTest = useMutation({
    mutationFn: (name: string) => runMcpTest(name, projectId, capInputs[name] ?? ''),
    onSuccess: (res, name) => {
      setCapResults((m) => ({ ...m, [name]: res }))
      if (res.ok) toast.success(`${name} works`, { description: res.detail })
      else toast.error(`${name} test failed`, { description: res.detail })
    },
    onError: (err, name) => {
      const detail = err instanceof Error ? err.message : 'Test failed'
      setCapResults((m) => ({ ...m, [name]: { ok: false, detail, data: null, raw: '' } }))
      toast.error(`${name} test failed`, { description: detail })
    },
  })
  const capTestingName = capTest.isPending ? (capTest.variables as string) : null

  function serverLabel(name: string): string {
    if (name === 'playwright') return 'Playwright'
    if (name === 'maestro') return 'Maestro'
    return OAUTH_META[name as McpOauthProvider]?.label ?? name
  }

  // The functional-test dialog — a real action run through the MCP via Claude.
  function functionalTestDialog() {
    const name = capDialogName
    const spec = name ? CAPABILITY[name] : null
    if (!name || !spec) return null
    // Maestro has its own auto-detect → pick device → run dialog.
    if (name === 'maestro') return null
    const running = capTestingName === name
    const result = capResults[name]
    const input = capInputs[name] ?? ''
    const disabled = running || (spec.needsInput && !input.trim())
    return (
      <Dialog
        open
        onOpenChange={(o) => {
          if (!o && !running) setCapDialogName(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" />
              Functional test — {serverLabel(name)}
            </DialogTitle>
            <DialogDescription>
              Runs a real action through {serverLabel(name)} via Claude to confirm the server
              actually works, not just that it's configured.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {spec.needsInput && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  {spec.inputLabel}
                </label>
                <Input
                  autoFocus
                  value={input}
                  onChange={(e) => setCapInputs((m) => ({ ...m, [name]: e.target.value }))}
                  placeholder={spec.placeholder}
                  aria-label={spec.inputLabel}
                  disabled={running}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !disabled) capTest.mutate(name)
                  }}
                  className="h-9 text-sm"
                />
              </div>
            )}
            {result && (
              <p
                className={cn(
                  'flex items-start gap-1.5 rounded-md px-2.5 py-2 text-xs leading-snug',
                  !result.ok
                    ? 'bg-red-50 text-red-700'
                    : result.warn
                      ? 'bg-amber-50 text-amber-700'
                      : 'bg-emerald-50 text-emerald-700',
                )}
              >
                {!result.ok ? (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : result.warn ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <span className="min-w-0 break-words">{result.detail}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCapDialogName(null)} disabled={running}>
              Close
            </Button>
            <Button
              onClick={() => capTest.mutate(name)}
              disabled={disabled}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Testing…
                </>
              ) : (
                <>
                  <FlaskConical className="h-4 w-4" />
                  {spec.action}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  const playwrightAdded = existingNames.includes('playwright')
  const addPlaywright = useMutation({
    mutationFn: () =>
      addMcp(
        {
          name: 'playwright',
          command: 'npx',
          args: playwrightArgs(playwrightHeadless),
          type: 'stdio',
        },
        projectId,
      ),
    onSuccess: () => {
      toast.success('Playwright added', { description: 'No authentication required.' })
      test.mutate('playwright')
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to add Playwright', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const maestroAdded = existingNames.includes('maestro')
  // Preflight the CLI + JDK only while the card would show a Connect button —
  // the probe boots a JVM, so there's no reason to pay for it on every page view
  // once the server is configured.
  const { data: maestroPf, isFetching: maestroChecking } = useQuery({
    queryKey: ['mcp-maestro'],
    queryFn: mcpMaestroStatus,
    enabled: !maestroAdded,
    staleTime: 60_000,
  })
  const addMaestro = useMutation({
    mutationFn: () => connectMaestro(projectId),
    onSuccess: () => {
      toast.success('Maestro added', {
        description: 'Boot a simulator (or use the Chromium device), then test.',
      })
      test.mutate('maestro')
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to add Maestro', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  function envPreview(name: string) {
    const env = envByName[name]
    const entries = env ? Object.entries(env) : []
    if (!entries.length) return null
    const [key, value] = entries[0]
    const copyId = `${name}:${key}`
    const copied = copiedEnv === copyId
    async function copyValue() {
      // The shown value is masked — fetch the real key on demand to copy it.
      try {
        const real = await revealMcpSecret(name, projectId)
        await navigator.clipboard.writeText(real.value)
        setCopiedEnv(copyId)
        window.setTimeout(
          () => setCopiedEnv((current) => (current === copyId ? null : current)),
          1200,
        )
      } catch (err) {
        toast.error('Failed to copy key', {
          description: err instanceof Error ? err.message : 'Unknown error',
        })
      }
    }
    return (
      <div className="flex min-w-0 items-center gap-1 rounded-xl bg-muted/60 px-2.5 py-1.5 text-muted-foreground">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px]" title={value}>
          {value}
        </div>
        <button
          type="button"
          onClick={copyValue}
          aria-label={`Copy ${key}`}
          className="shrink-0 rounded p-0.5 transition-colors hover:bg-background hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </button>
      </div>
    )
  }

  // Open the "View details" dialog for a server (starts masked, no cached env).
  function openDetails(name: string) {
    setFullEnv(null)
    setShowReveal(false)
    setCopiedField(null)
    setDetailsName(name)
  }

  // Fetch the server's full (unmasked) env once and cache it. Used for both the
  // Reveal display and for copying real values to the clipboard.
  async function ensureFullEnv(): Promise<Record<string, string>> {
    if (fullEnv) return fullEnv
    if (!detailsName) return {}
    const { env } = await revealMcpEnv(detailsName, projectId)
    setFullEnv(env)
    return env
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
    try {
      const env = keys.length ? await ensureFullEnv() : {}
      const entry: Record<string, unknown> = {}
      if (server?.type) entry.type = server.type
      if (server?.command) entry.command = server.command
      if (server?.args?.length) entry.args = server.args
      if (server?.url) entry.url = server.url
      if (keys.length) entry.env = Object.fromEntries(keys.map((k) => [k, env[k] ?? masked[k]]))
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
    const Icon = meta?.icon ?? FileJson
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
    if (envKeys.length) {
      entry.env = Object.fromEntries(envKeys.map((k) => [k, valueFor(k)]))
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

  // Actions shown once a service is connected. One prominent primary (Test
  // connection) over a single compact row of equal, low-emphasis actions
  // (Test feature · Details · Disconnect) — keeps connected cards short and calm
  // instead of stacking four full-width buttons of four different weights.
  function connectedActions(name: string) {
    const testing = testingNames.has(name)
    const disconnecting = disconnectingNames.has(name)
    const result = testResults[name]
    const hasFn = !!CAPABILITY[name]
    return (
      <div className="mt-auto space-y-1.5">
        {result && (
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
        )}
        <Button
          size="sm"
          onClick={() => test.mutate(name)}
          disabled={testing || disconnecting}
          className="h-9 w-full rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          {testing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Testing…
            </>
          ) : (
            <>
              <PlugZap className="h-3.5 w-3.5" />
              Test connection
            </>
          )}
        </Button>
        {/* Segmented toolbar — three peer actions read as one cohesive control
            instead of three loose ghost buttons; a hairline divider sets the
            destructive Disconnect apart. */}
        <div className="flex items-center gap-0.5 rounded-full border border-border/60 bg-muted/40 p-1">
          {hasFn && (
            <button
              type="button"
              onClick={() => setCapDialogName(name)}
              disabled={disconnecting}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-background hover:text-foreground hover:shadow-sm active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
            >
              <FlaskConical className="h-3.5 w-3.5" />
              Test feature
            </button>
          )}
          <button
            type="button"
            onClick={() => openDetails(name)}
            disabled={disconnecting}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-full px-2 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-background hover:text-foreground hover:shadow-sm active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
          >
            <FileJson className="h-3.5 w-3.5" />
            Details
          </button>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border/60" />
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => disconnect.mutate(name)}
                disabled={disconnecting || testing}
                aria-label="Disconnect"
                className="flex shrink-0 items-center justify-center rounded-full px-2.5 py-1.5 text-muted-foreground transition-all duration-200 hover:bg-destructive/10 hover:text-destructive active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50"
              >
                {disconnecting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Unplug className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent>Disconnect</TooltipContent>
          </Tooltip>
        </div>
      </div>
    )
  }

  // ---- card renderers (closures over the mutations + state above) ----

  // A token-connect provider card (ClickUp / Figma / Jira). Jira's connect form
  // adds a Site URL + Account email field on top of the API token.
  function providerCard(provider: McpOauthProvider) {
    const meta = OAUTH_META[provider]
    const Icon = meta.icon
    const info = status?.providers.find((p) => p.provider === provider)
    const configured = !!info?.configured || existingNames.includes(provider)
    const isOpen = openProvider === provider
    const saving = saveToken.isPending && saveToken.variables === provider
    const checking = checkingStatus && !isOpen
    const canSave = canSaveToken(provider)

    return (
      <Card
        key={provider}
        className={mcpCardClass(statusByName[provider])}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <span className="truncate">{meta.label}</span>
              <PurposeTip name={provider} label={meta.label} />
            </div>
            <div className="truncate text-xs text-muted-foreground">{meta.blurb}</div>
          </div>
          <CardStatusBadge
            configured={configured}
            status={statusByName[provider]}
            checking={checking}
          />
        </div>
        {configured && envPreview(provider)}

        {checking ? (
          <Button size="sm" disabled className="mt-auto h-9 w-full rounded-full font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : configured ? (
          connectedActions(provider)
        ) : isOpen ? (
          // Token-connect: the provider's token page opened in a new tab — paste it here.
          <div className="mt-auto space-y-2.5">
            {provider === 'jira' && (
              <>
                <Field label="Site URL">
                  <Input
                    autoFocus
                    type="url"
                    placeholder="https://you.atlassian.net"
                    value={jiraUrl}
                    onChange={(e) => setJiraUrl(e.target.value)}
                    aria-label="Jira site URL"
                    className="h-9 rounded-xl text-xs"
                  />
                </Field>
                <Field label="Account email">
                  <Input
                    type="email"
                    placeholder="you@company.com"
                    value={jiraEmail}
                    onChange={(e) => setJiraEmail(e.target.value)}
                    aria-label="Jira account email"
                    className="h-9 rounded-xl text-xs"
                  />
                </Field>
              </>
            )}
            {provider === 'azure' && (
              <>
                <Field label="Organization URL">
                  <Input
                    autoFocus
                    type="url"
                    placeholder="https://dev.azure.com/your-org"
                    value={azureOrgUrl}
                    onChange={(e) => setAzureOrgUrl(e.target.value)}
                    aria-label="Azure DevOps organization URL"
                    className="h-9 rounded-xl text-xs"
                  />
                </Field>
                <Field label="Default project (optional)">
                  <Input
                    type="text"
                    placeholder="e.g. Mobile App"
                    value={azureProject}
                    onChange={(e) => setAzureProject(e.target.value)}
                    aria-label="Azure DevOps default project"
                    className="h-9 rounded-xl text-xs"
                  />
                </Field>
              </>
            )}
            <Field label={provider === 'azure' ? 'Personal Access Token' : 'API token'}>
              <div className="relative">
                <Input
                  autoFocus={provider !== 'jira' && provider !== 'azure'}
                  type={showToken ? 'text' : 'password'}
                  placeholder={provider === 'azure' ? 'Paste your PAT' : 'Paste your API token'}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSave) saveToken.mutate(provider)
                  }}
                  aria-label={`${meta.label} API token`}
                  className="h-9 rounded-xl pr-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </Field>
            <div className="flex gap-2 pt-0.5">
              <Button
                size="sm"
                onClick={() => saveToken.mutate(provider)}
                disabled={!canSave || saving}
                className="h-9 flex-1 rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save &amp; connect
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOpenProvider(null)
                  setToken('')
                  setShowToken(false)
                  setJiraUrl('')
                  setJiraEmail('')
                  setAzureOrgUrl('')
                  setAzureProject('')
                }}
                disabled={saving}
                className="h-9 rounded-full"
              >
                Cancel
              </Button>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <a
                href={info?.tokenUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                {meta.tokenHint}
              </a>
              <span className="text-border">·</span>
              <Link
                to="/document/mcp-tokens"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                <BookOpen className="h-3 w-3" />
                Step-by-step guide
              </Link>
            </div>
          </div>
        ) : (
          <>
            <PurposeBlurb name={provider} />
            <Button
              size="sm"
              onClick={() => beginConnect(provider)}
              className="mt-auto h-9 w-full rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
            >
              <Plug className="h-3.5 w-3.5" />
              Connect
            </Button>
          </>
        )}
      </Card>
    )
  }

  // Playwright needs no token — one-click project setup.
  function playwrightCard() {
    return (
      <Card
        key="playwright"
        className={mcpCardClass(statusByName['playwright'])}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
            <MousePointerClick className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <span className="truncate">Playwright</span>
              <PurposeTip name="playwright" label="Playwright" />
            </div>
            <div className="truncate text-xs text-muted-foreground">Browser driver</div>
          </div>
          <CardStatusBadge
            configured={playwrightAdded}
            status={statusByName['playwright']}
            checking={checkingStatus}
          />
        </div>
        {checkingStatus ? (
          <Button size="sm" disabled className="mt-auto h-9 w-full rounded-full font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : playwrightAdded ? (
          connectedActions('playwright')
        ) : (
          <>
            <PurposeBlurb name="playwright" />
            <div className="mt-auto space-y-2">
            <label className="flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
              <span>Headless</span>
              <input
                type="checkbox"
                checked={playwrightHeadless}
                onChange={(e) => setPlaywrightHeadless(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
            </label>
            <Button
              size="sm"
              onClick={() => addPlaywright.mutate()}
              disabled={addPlaywright.isPending}
              className="h-9 w-full rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
            >
              {addPlaywright.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              Connect
            </Button>
            </div>
          </>
        )}
      </Card>
    )
  }

  // Maestro (mobile.dev) needs no token, but it IS the one card whose prerequisites
  // the portal can't satisfy on demand: a separately-installed `maestro` binary and
  // a JDK 17+. So the Connect button is gated on a live preflight, and an unmet
  // prerequisite becomes an actionable install hint instead of a dead "failed" badge.
  function maestroCard() {
    const pf = maestroPf
    const blocked = !!pf && !pf.available
    const javaMissing = blocked && pf.javaHome === null && !pf.defaultJavaOk
    return (
      <Card key="maestro" className={mcpCardClass(statusByName.maestro)}>
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
            <Smartphone className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <span className="truncate">Maestro</span>
              <PurposeTip name="maestro" label="Maestro" />
            </div>
            <div className="truncate text-xs text-muted-foreground">
              iOS / Android / web flows
            </div>
          </div>
          <CardStatusBadge
            configured={maestroAdded}
            status={statusByName.maestro}
            checking={checkingStatus}
          />
        </div>
        {checkingStatus ? (
          <Button size="sm" disabled className="mt-auto h-9 w-full rounded-full font-medium">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : maestroAdded ? (
          connectedActions('maestro')
        ) : (
          <>
            <PurposeBlurb name="maestro" />
            <div className="mt-auto space-y-2">
              {blocked && (
                <div className="space-y-1.5 rounded-xl bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-700">
                  <p className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      {javaMissing ? (
                        <>
                          Maestro needs <span className="font-medium">Java 17+</span>
                          {pf.javaMajor ? ` (found Java ${pf.javaMajor})` : ''}. Install a JDK,
                          then re-check.
                        </>
                      ) : (
                        <>
                          The <span className="font-medium">Maestro CLI</span> isn't installed on
                          this machine. Install it, then re-check.
                        </>
                      )}
                    </span>
                  </p>
                  <code className="block truncate rounded-md bg-amber-100/70 px-1.5 py-1 font-mono text-[10px] text-amber-900">
                    {javaMissing
                      ? 'brew install openjdk@21'
                      : 'curl -fsSL "https://get.maestro.mobile.dev" | bash'}
                  </code>
                </div>
              )}
              <Button
                size="sm"
                onClick={() => addMaestro.mutate()}
                disabled={addMaestro.isPending || maestroChecking || blocked}
                className="h-9 w-full rounded-full font-medium transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
              >
                {addMaestro.isPending || maestroChecking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Plug className="h-3.5 w-3.5" />
                )}
                {maestroChecking ? 'Checking Maestro…' : 'Connect'}
              </Button>
            </div>
          </>
        )}
      </Card>
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
      </div>

      <McpGroup
        icon={ListChecks}
        title="Tickets & tasks"
        blurb="Read QC requirements straight from your tracker."
      >
        {providerCard('clickup')}
        {providerCard('jira')}
        {providerCard('azure')}
      </McpGroup>

      <McpGroup
        icon={Figma}
        title="Design"
        blurb="Compare the built UI against the intended design."
      >
        {providerCard('figma')}
      </McpGroup>

      <McpGroup
        icon={MousePointerClick}
        title="Browser & device"
        blurb="Drive the real app to exercise and verify it."
      >
        {playwrightCard()}
        {maestroCard()}
      </McpGroup>

      {functionalTestDialog()}
      {detailsDialog()}
      {capDialogName === 'maestro' && (
        <MobileFunctionalTest
          name={capDialogName}
          label={serverLabel(capDialogName)}
          projectId={projectId}
          onClose={() => setCapDialogName(null)}
        />
      )}
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
    if (parsed && typeof parsed === 'object' && parsed.map) {
      return { map: parsed.map, at: typeof parsed.at === 'number' ? parsed.at : 0 }
    }
  } catch {
    /* corrupt/absent cache — fall through to a live probe */
  }
  return null
}
function writeHealthCache(projectId: string, map: HealthMap) {
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
  const { data: health, isFetching: healthChecking } = useQuery({
    queryKey: ['mcp-health', activeProjectId],
    queryFn: () => mcpHealth(activeProjectId as string),
    enabled: !!activeProjectId,
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
