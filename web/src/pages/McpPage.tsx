import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
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
  KeyRound,
  ListChecks,
  Loader2,
  MousePointerClick,
  Plug,
  PlugZap,
  Unplug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  addMcp,
  listMcp,
  mcpOauthStatus,
  openMcpFolder,
  removeMcp,
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
  playwright: {
    needsInput: false,
    inputLabel: '',
    placeholder: '',
    action: 'Open Google & close',
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

/** Token-connect cards for ClickUp/Figma (paste a personal token) + a no-auth Playwright add. */
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
  const [copiedEnv, setCopiedEnv] = useState<string | null>(null)
  // Default to headed (headless = false) so QC can watch the browser during runs;
  // the checkbox below still lets them opt into headless before connecting.
  const [playwrightHeadless, setPlaywrightHeadless] = useState(false)

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ['mcp', projectId] })
    queryClient.invalidateQueries({ queryKey: ['mcp-oauth', projectId] })
  }

  function tokenUrlFor(provider: McpOauthProvider): string {
    return status?.providers.find((p) => p.provider === provider)?.tokenUrl ?? ''
  }

  // Connect = open the provider's token page in a new tab, then reveal a paste box.
  function beginConnect(provider: McpOauthProvider) {
    const url = tokenUrlFor(provider)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
    setToken('')
    setOpenProvider(provider)
  }

  const saveToken = useMutation({
    mutationFn: (provider: McpOauthProvider) => saveMcpToken(provider, token.trim(), projectId),
    onSuccess: (_, provider) => {
      toast.success(`${OAUTH_META[provider].label} connected`, {
        description: "Token saved to this project's .mcp.json.",
      })
      setOpenProvider(null)
      setToken('')
      refresh()
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
      refresh()
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

  // The functional-test block rendered inside a connected card for known servers.
  function capabilityTest(name: string) {
    const spec = CAPABILITY[name]
    if (!spec) return null
    const running = capTestingName === name
    const result = capResults[name]
    const input = capInputs[name] ?? ''
    const disabled = running || (spec.needsInput && !input.trim())
    return (
      <div className="space-y-1.5 rounded-lg border bg-muted/20 p-2">
        <p className="flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-muted-foreground">
          <FlaskConical className="h-3 w-3" />
          Functional test
        </p>
        {spec.needsInput && (
          <Input
            value={input}
            onChange={(e) => setCapInputs((m) => ({ ...m, [name]: e.target.value }))}
            placeholder={spec.placeholder}
            aria-label={spec.inputLabel}
            disabled={running}
            className="h-8 text-xs"
          />
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => capTest.mutate(name)}
          disabled={disabled}
          className="w-full transition-all duration-200 active:scale-[0.98]"
        >
          {running ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Testing…
            </>
          ) : (
            <>
              <FlaskConical className="h-3.5 w-3.5" />
              {spec.action}
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
      </div>
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
      refresh()
    },
    onError: (err) =>
      toast.error('Failed to add Playwright', {
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
      await navigator.clipboard.writeText(`${key}=${value}`)
      setCopiedEnv(copyId)
      window.setTimeout(() => setCopiedEnv((current) => (current === copyId ? null : current)), 1200)
    }
    return (
      <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/50 px-2 py-1 text-muted-foreground">
        <div className="min-w-0 flex-1 truncate font-mono text-[11px]" title={`${key}=${value}`}>
          API key: {key}={value}
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
          className="w-full transition-all duration-200 active:scale-[0.98]"
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
        {capabilityTest(name)}
        <Button
          size="sm"
          variant="outline"
          onClick={() => disconnect.mutate(name)}
          disabled={disconnecting || testing}
          className="w-full transition-all duration-200 hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive active:scale-[0.98]"
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

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-base font-semibold tracking-tight">Connect a service</h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(OAUTH_META) as McpOauthProvider[]).map((provider) => {
          const meta = OAUTH_META[provider]
          const Icon = meta.icon
          const info = status?.providers.find((p) => p.provider === provider)
          const configured = !!info?.configured || existingNames.includes(provider)
          const isOpen = openProvider === provider
          const saving = saveToken.isPending && saveToken.variables === provider
          const checking = checkingStatus && !isOpen

          return (
            <Card key={provider} className="flex h-full flex-col gap-3 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 leading-tight">
                  <div className="text-sm font-semibold tracking-tight">{meta.label}</div>
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
                <Button size="sm" disabled className="mt-auto w-full">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Checking status…
                </Button>
              ) : configured ? (
                connectedActions(provider)
              ) : isOpen ? (
                // Token-connect: token page opened in a new tab — paste it here.
                <div className="mt-auto space-y-2">
                  <Input
                    autoFocus
                    type="password"
                    placeholder="Paste your token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && token.trim()) saveToken.mutate(provider)
                    }}
                    className="h-9 font-mono text-xs"
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => saveToken.mutate(provider)}
                      disabled={!token.trim() || saving}
                      className="flex-1 transition-all duration-200 active:scale-[0.98]"
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
                  className="mt-auto w-full transition-all duration-200 active:scale-[0.98]"
                >
                  <Plug className="h-3.5 w-3.5" />
                  Connect
                </Button>
              )}
            </Card>
          )
        })}

        {/* Playwright needs no token — one-click project setup. */}
        <Card className="flex h-full flex-col gap-3 p-4 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
              <MousePointerClick className="h-4 w-4" />
            </span>
            <div className="min-w-0 leading-tight">
              <div className="text-sm font-semibold tracking-tight">Playwright</div>
              <div className="truncate text-xs text-muted-foreground">Browser driver</div>
            </div>
            <CardStatusBadge
              configured={playwrightAdded}
              status={statusByName['playwright']}
              checking={checkingStatus}
            />
          </div>
          {checkingStatus ? (
            <Button size="sm" disabled className="mt-auto w-full">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking status…
            </Button>
          ) : playwrightAdded ? (
            connectedActions('playwright')
          ) : (
            <div className="mt-auto space-y-2">
              <label className="flex items-center justify-between rounded-md bg-muted/50 px-2 py-1.5 text-xs text-muted-foreground">
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
                className="w-full transition-all duration-200 active:scale-[0.98]"
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
      </div>
    </section>
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
      className="shrink-0 gap-1.5 active:scale-[0.98]"
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
  const { data, isLoading, isFetching, isError, error } = useQuery({
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
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">MCP servers</h1>
        </header>
        <Card className="shadow-sm">
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
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">MCP servers</h1>
          <p className="text-sm text-muted-foreground">
            Each project has its own Model Context Protocol config — these servers apply only to
            the active project's QC runs.
          </p>
        </div>

        {/* Per-project context: makes it unmistakable which .mcp.json is being edited. */}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 shadow-sm">
            <span className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
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
                className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
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
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error instanceof Error ? error.message : 'Failed to load MCP server status'}
        </div>
      )}

      <ConnectServices
        projectId={activeProjectId}
        existingNames={servers.map((s) => s.name)}
        statusByName={Object.fromEntries(servers.map((s) => [s.name, s.status]))}
        envByName={Object.fromEntries(servers.map((s) => [s.name, s.env]))}
        checkingStatus={isLoading || isFetching}
      />
    </div>
  )
}
