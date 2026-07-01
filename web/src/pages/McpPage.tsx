import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  Figma,
  FileJson,
  FolderGit2,
  FolderOpen,
  FlaskConical,
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
  mcpOauthStatus,
  openMcpFolder,
  removeMcp,
  revealMcpSecret,
  runMcpTest,
  saveMcpToken,
  testMcp,
  type McpCapabilityResult,
  type McpOauthProvider,
} from '@/lib/api'
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
  playwright:
    'Drives a real browser — navigating, clicking, typing, screenshotting — so QC runs can exercise and verify the web app.',
  'mobile-mcp':
    'Drives a connected iOS/Android device or simulator so QC runs can test the mobile app.',
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
  'mobile-mcp': {
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

function playwrightArgs(headless: boolean): string[] {
  return [
    '@playwright/mcp@latest',
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
    '--user-data-dir',
    '/Users/hao.nguyen/.pw-agent-profile',
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
  const s = (status && CARD_STATUS[status]) || {
    label: 'Configured',
    cls: 'bg-muted text-muted-foreground',
    Icon: Check,
  }
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
 * Mobile functional test — a two-step dialog. On open it auto-detects connected
 * devices/simulators (empty-input capability test); if any are found it shows a
 * device picker + an enabled "Run test" that actually drives the selected device.
 * No devices → amber notice, test stays disabled.
 */
function MobileFunctionalTest({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const [device, setDevice] = useState('')
  const detect = useMutation({ mutationFn: () => runMcpTest('mobile-mcp', projectId, '') })
  const runTest = useMutation({ mutationFn: (dev: string) => runMcpTest('mobile-mcp', projectId, dev) })

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
            Functional test — Mobile
          </DialogTitle>
          <DialogDescription>
            Detects connected devices/simulators, then drives the one you pick to confirm the server
            actually works — not just that it's configured.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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
                  const ios = /iphone|ipad|ipod/i.test(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setDevice(d)}
                      disabled={testing}
                      aria-pressed={active}
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
                        <Smartphone className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate text-sm font-medium">{d}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {ios ? 'iOS' : 'Android'}
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

        <DialogFooter>
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
  checkingStatus,
}: {
  projectId: string
  existingNames: string[]
  statusByName: Record<string, string | undefined>
  envByName: Record<string, Record<string, string> | undefined>
  checkingStatus: boolean
}) {
  const queryClient = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['mcp-oauth', projectId],
    queryFn: () => mcpOauthStatus(projectId),
  })
  const [openProvider, setOpenProvider] = useState<McpOauthProvider | null>(null)
  const [token, setToken] = useState('')
  // Jira needs a site URL + account email alongside the API token (mcp-atlassian).
  const [jiraUrl, setJiraUrl] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [copiedEnv, setCopiedEnv] = useState<string | null>(null)
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
    setJiraUrl('')
    setJiraEmail('')
    setOpenProvider(provider)
  }

  // Whether the connect form has everything it needs to save (Jira also needs URL + email).
  function canSaveToken(provider: McpOauthProvider): boolean {
    if (!token.trim()) return false
    if (provider === 'jira') return !!jiraUrl.trim() && !!jiraEmail.trim()
    return true
  }

  const saveToken = useMutation({
    mutationFn: (provider: McpOauthProvider) =>
      saveMcpToken(
        provider,
        token.trim(),
        projectId,
        provider === 'jira' ? { url: jiraUrl.trim(), email: jiraEmail.trim() } : undefined,
      ),
    onSuccess: (_, provider) => {
      toast.success(`${OAUTH_META[provider].label} connected`, {
        description: "Token saved to this project's .mcp.json.",
      })
      setOpenProvider(null)
      setToken('')
      setJiraUrl('')
      setJiraEmail('')
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to save token', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  // Disconnect = remove the server entry from this project's .mcp.json.
  const disconnect = useMutation({
    mutationFn: (name: string) => removeMcp(name, projectId),
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
  })
  const disconnectingName = disconnect.isPending ? (disconnect.variables as string) : null

  // Live connection test — spawns the server via the Claude CLI and reports health.
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; detail: string }>
  >({})
  const test = useMutation({
    mutationFn: (name: string) => testMcp(name, projectId),
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
  })
  const testingName = test.isPending ? (test.variables as string) : null

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
    if (name === 'mobile-mcp') return 'Mobile'
    return OAUTH_META[name as McpOauthProvider]?.label ?? name
  }

  // Card button that opens the functional-test dialog for a known server.
  function functionalTestTrigger(name: string) {
    if (!CAPABILITY[name]) return null
    return (
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setCapDialogName(name)}
        className="w-full rounded-full transition-all duration-200 active:scale-[0.98]"
      >
        <FlaskConical className="h-3.5 w-3.5" />
        Functional test
      </Button>
    )
  }

  // The functional-test dialog — a real action run through the MCP via Claude.
  function functionalTestDialog() {
    const name = capDialogName
    const spec = name ? CAPABILITY[name] : null
    if (!name || !spec) return null
    // Mobile has its own auto-detect → pick device → run dialog (rendered separately).
    if (name === 'mobile-mcp') return null
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
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to add Playwright', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const mobileAdded = existingNames.includes('mobile-mcp')
  const addMobile = useMutation({
    mutationFn: () =>
      addMcp(
        {
          name: 'mobile-mcp',
          command: 'npx',
          args: ['-y', '@mobilenext/mobile-mcp@latest'],
          type: 'stdio',
        },
        projectId,
      ),
    onSuccess: () => {
      toast.success('Mobile added', {
        description: 'Connect a device/simulator, then test.',
      })
      return refresh()
    },
    onError: (err) =>
      toast.error('Failed to add Mobile', {
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

  // Actions shown once a service is connected: live Test + Disconnect.
  function connectedActions(name: string) {
    const testing = testingName === name
    const disconnecting = disconnectingName === name
    const result = testResults[name]
    return (
      <div className="mt-auto space-y-1.5">
        <Button
          size="sm"
          onClick={() => test.mutate(name)}
          disabled={testing || disconnecting}
          className="w-full rounded-full transition-all duration-200 active:scale-[0.98]"
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
        {result && (
          <p
            className={cn(
              'flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug',
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
        {functionalTestTrigger(name)}
        <Button
          size="sm"
          variant="outline"
          onClick={() => disconnect.mutate(name)}
          disabled={disconnecting || testing}
          className="w-full rounded-full transition-all duration-200 hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive active:scale-[0.98]"
        >
          {disconnecting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Disconnecting…
            </>
          ) : (
            <>
              <Unplug className="h-3.5 w-3.5" />
              Disconnect
            </>
          )}
        </Button>
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
        className="flex h-full flex-col gap-3 rounded-3xl border-border/60 p-5 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
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
          <Button size="sm" disabled className="mt-auto w-full rounded-full">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : configured ? (
          connectedActions(provider)
        ) : isOpen ? (
          // Token-connect: token page opened in a new tab — paste it here.
          <div className="mt-auto space-y-2">
            {provider === 'jira' && (
              <>
                <Input
                  autoFocus
                  type="url"
                  placeholder="Site URL — https://you.atlassian.net"
                  value={jiraUrl}
                  onChange={(e) => setJiraUrl(e.target.value)}
                  aria-label="Jira site URL"
                  className="h-9 text-xs"
                />
                <Input
                  type="email"
                  placeholder="Account email"
                  value={jiraEmail}
                  onChange={(e) => setJiraEmail(e.target.value)}
                  aria-label="Jira account email"
                  className="h-9 text-xs"
                />
              </>
            )}
            <Input
              autoFocus={provider !== 'jira'}
              type="password"
              placeholder="Paste your API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) saveToken.mutate(provider)
              }}
              aria-label={`${meta.label} API token`}
              className="h-9 font-mono text-xs"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => saveToken.mutate(provider)}
                disabled={!canSave || saving}
                className="flex-1 rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setOpenProvider(null)
                  setToken('')
                  setJiraUrl('')
                  setJiraEmail('')
                }}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
            <a
              href={info?.tokenUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              {meta.tokenHint}
            </a>
          </div>
        ) : (
          <Button
            size="sm"
            onClick={() => beginConnect(provider)}
            className="mt-auto w-full rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            <Plug className="h-3.5 w-3.5" />
            Connect
          </Button>
        )}
      </Card>
    )
  }

  // Playwright needs no token — one-click project setup.
  function playwrightCard() {
    return (
      <Card
        key="playwright"
        className="flex h-full flex-col gap-3 rounded-3xl border-border/60 p-5 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
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
          <Button size="sm" disabled className="mt-auto w-full rounded-full">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : playwrightAdded ? (
          connectedActions('playwright')
        ) : (
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
              className="w-full rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {addPlaywright.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plug className="h-3.5 w-3.5" />
              )}
              Connect
            </Button>
          </div>
        )}
      </Card>
    )
  }

  // Mobile (mobile-next/mobile-mcp) needs no token — one-click project setup.
  function mobileCard() {
    return (
      <Card
        key="mobile-mcp"
        className="flex h-full flex-col gap-3 rounded-3xl border-border/60 p-5 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
            <Smartphone className="h-4 w-4" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
              <span className="truncate">Mobile</span>
              <PurposeTip name="mobile-mcp" label="Mobile" />
            </div>
            <div className="truncate text-xs text-muted-foreground">iOS / Android driver</div>
          </div>
          <CardStatusBadge
            configured={mobileAdded}
            status={statusByName['mobile-mcp']}
            checking={checkingStatus}
          />
        </div>
        {checkingStatus ? (
          <Button size="sm" disabled className="mt-auto w-full rounded-full">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Checking status…
          </Button>
        ) : mobileAdded ? (
          connectedActions('mobile-mcp')
        ) : (
          <Button
            size="sm"
            onClick={() => addMobile.mutate()}
            disabled={addMobile.isPending}
            className="mt-auto w-full rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {addMobile.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}
            Connect
          </Button>
        )}
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold tracking-tight">Connect a service</h2>
      </div>

      <McpGroup
        icon={ListChecks}
        title="Tickets & tasks"
        blurb="Read QC requirements straight from your tracker."
      >
        {providerCard('clickup')}
        {providerCard('jira')}
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
        {mobileCard()}
      </McpGroup>

      {functionalTestDialog()}
      {capDialogName === 'mobile-mcp' && (
        <MobileFunctionalTest projectId={projectId} onClose={() => setCapDialogName(null)} />
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

export default function McpPage() {
  const { activeProjectId, activeProject } = useProjects()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['mcp', activeProjectId],
    queryFn: () => listMcp(activeProjectId as string),
    enabled: !!activeProjectId,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  })

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

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Plug className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">MCP servers</h1>
            <p className="text-sm text-muted-foreground">
              Each project has its own Model Context Protocol config — these servers apply only to
              the active project's QC runs.
            </p>
          </div>
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

      <ConnectServices
        projectId={activeProjectId}
        existingNames={servers.map((s) => s.name)}
        statusByName={Object.fromEntries(servers.map((s) => [s.name, s.status]))}
        envByName={Object.fromEntries(servers.map((s) => [s.name, s.env]))}
        checkingStatus={isLoading}
      />
    </div>
  )
}
