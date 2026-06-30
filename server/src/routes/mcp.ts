import { Router } from 'express'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import path from 'node:path'
import spawn from 'cross-spawn'
import { CLAUDE_BIN, OAUTH_APPS, OAUTH_REDIRECT_BASE, mcpJsonFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { resolveProjectClickupToken, verifyToken, withClickupToken } from '../clickup.js'
import { runMcpCapabilityTest } from '../mcpCapabilityTest.js'
import type { McpServer } from '../types.js'

export const mcpRouter = Router()

interface McpTestResult {
  ok: boolean
  detail: string
  status?: McpServer['status']
}

/**
 * Ask the Claude CLI for live MCP health in a project dir and map each server
 * name to a status. Best-effort: resolves to {} on any error/timeout so the
 * page still loads (servers then show "unknown").
 */
function getStatuses(cwd: string): Promise<Record<string, McpServer['status']>> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(CLAUDE_BIN, ['mcp', 'list'], {
      cwd,
      env: { ...process.env },
      windowsHide: true, // no cmd window flash on Windows
    })
    // Health-checking remote servers can take ~10s; give it generous headroom.
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({})
    }, 25000)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({})
    })
    child.on('close', () => {
      clearTimeout(timer)
      const map: Record<string, McpServer['status']> = {}
      for (const raw of out.split('\n')) {
        // Lines look like: "name: <command/url> - <status text>"
        const line = raw.trim()
        const colon = line.indexOf(': ')
        const dash = line.lastIndexOf(' - ')
        if (colon === -1 || dash === -1 || dash < colon) continue
        const name = line.slice(0, colon).trim()
        const status = line.slice(dash + 3).toLowerCase()
        if (status.includes('connected')) map[name] = 'connected'
        else if (status.includes('pending') || status.includes('approve')) map[name] = 'pending'
        else if (status.includes('auth')) map[name] = 'needs-auth'
        else if (status.includes('fail') || status.includes('error')) map[name] = 'failed'
        else map[name] = 'unknown'
      }
      resolve(map)
    })
  })
}

/**
 * Run a real connection test for ONE server by invoking `claude mcp list` in the
 * project dir (which spawns each server and reports health) and parsing the line
 * for the requested name. Returns ok + a human-readable detail string.
 */
function testServer(cwd: string, name: string): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(CLAUDE_BIN, ['mcp', 'list'], {
      cwd,
      env: { ...process.env },
      windowsHide: true, // no cmd window flash on Windows
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({
        ok: false,
        detail: 'Timed out after 25s while checking server health.',
        status: 'failed',
      })
    }, 25000)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (out += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : ''
      const detail = /ENOENT/.test(msg)
        ? `Could not find the Claude CLI (tried "${CLAUDE_BIN}"). Install Claude Code and ensure \`claude\` is on PATH, or set the QC_CLAUDE_BIN env var to its full path, then restart the portal.`
        : msg || 'Failed to run claude mcp list.'
      resolve({ ok: false, detail, status: 'failed' })
    })
    child.on('close', () => {
      clearTimeout(timer)
      for (const raw of out.split('\n')) {
        const line = raw.trim()
        const colon = line.indexOf(': ')
        if (colon === -1 || line.slice(0, colon).trim() !== name) continue
        const dash = line.lastIndexOf(' - ')
        const status = (dash !== -1 ? line.slice(dash + 3) : line.slice(colon + 2)).trim()
        const lower = status.toLowerCase()
        // Strip leading status glyphs (✔ ✗ ⏸ ! •) for a clean message.
        const clean = status.replace(/^[^A-Za-z0-9]+/, '').trim()
        if (/connected/.test(lower)) {
          return resolve({
            ok: true,
            detail: 'Connected — the server responded.',
            status: 'connected',
          })
        }
        if (/pending|approve/.test(lower)) {
          return resolve({
            ok: false,
            detail: 'Pending approval — approving this project server and testing again.',
            status: 'pending',
          })
        }
        if (/auth/.test(lower)) {
          return resolve({
            ok: false,
            detail: clean || 'Needs authentication.',
            status: 'needs-auth',
          })
        }
        return resolve({ ok: false, detail: clean || 'Not connected.', status: 'failed' })
      }
      resolve({
        ok: false,
        detail: 'Server did not appear in the MCP list — check the command/token.',
        status: 'failed',
      })
    })
  })
}

interface McpEntry {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
  [key: string]: unknown
}

interface McpFile {
  mcpServers?: Record<string, McpEntry>
}

interface ClaudeConfig {
  projects?: Record<string, { mcpServers?: Record<string, McpEntry>; [key: string]: unknown }>
  [key: string]: unknown
}

/** Resolve the active project's .mcp.json path, or null if project unknown. */
function mcpPath(req: Parameters<typeof resolveProject>[0]): string | null {
  const project = resolveProject(req)
  return project ? mcpJsonFor(project.rootPath) : null
}

function readMcp(file: string): McpFile {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as McpFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMcp(file: string, data: McpFile): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function claudeConfigPath(): string | null {
  const home = process.env.HOME
  return home ? path.join(home, '.claude.json') : null
}

function readClaudeConfig(): ClaudeConfig {
  const file = claudeConfigPath()
  if (!file) return {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as ClaudeConfig
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeClaudeConfig(data: ClaudeConfig): void {
  const file = claudeConfigPath()
  if (!file) return
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function localProjectMcpServers(rootPath: string): Record<string, McpEntry> {
  return readClaudeConfig().projects?.[rootPath]?.mcpServers ?? {}
}

function removeLocalProjectMcpServer(rootPath: string, name: string): void {
  const data = readClaudeConfig()
  const servers = data.projects?.[rootPath]?.mcpServers
  if (!servers || !(name in servers)) return
  delete servers[name]
  writeClaudeConfig(data)
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  // Shell env references are not secrets themselves and are useful to show.
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed)) return trimmed
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

function publicEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined
  const masked = Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, maskSecret(value)]),
  )
  return Object.keys(masked).length ? masked : undefined
}

interface ClaudeProjectSettings {
  enabledMcpjsonServers?: unknown
  disabledMcpjsonServers?: unknown
  [key: string]: unknown
}

function readClaudeProjectSettings(file: string): ClaudeProjectSettings {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as ClaudeProjectSettings
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Claude stores approval for project-scoped .mcp.json servers in
 * .claude/settings.local.json. The portal owns these project configs, so Test
 * connection can approve the requested project server before retrying health.
 */
function approveMcpJsonServer(rootPath: string, name: string): boolean {
  const servers = readMcp(mcpJsonFor(rootPath)).mcpServers ?? {}
  if (!(name in servers)) return false

  const settingsDir = path.join(rootPath, '.claude')
  const settingsFile = path.join(settingsDir, 'settings.local.json')
  const settings = readClaudeProjectSettings(settingsFile)
  const enabled = Array.isArray(settings.enabledMcpjsonServers)
    ? settings.enabledMcpjsonServers.filter((v): v is string => typeof v === 'string')
    : []
  const disabled = Array.isArray(settings.disabledMcpjsonServers)
    ? settings.disabledMcpjsonServers.filter((v): v is string => typeof v === 'string')
    : []

  settings.enabledMcpjsonServers = [...new Set([...enabled, name])]
  settings.disabledMcpjsonServers = disabled.filter((v) => v !== name)

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return true
}

mcpRouter.get('/', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const projectServers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const localServers = localProjectMcpServers(project.rootPath)
  // Live health from the Claude CLI (best-effort) unless the caller opts out.
  const statuses =
    req.query.health === 'false' ? {} : await getStatuses(project.rootPath)

  const list: McpServer[] = Object.entries(projectServers).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    type: entry.type,
    env: publicEnv(entry.env),
    source: 'project',
    status: statuses[name] ?? 'unknown',
  }))
  for (const [name, entry] of Object.entries(localServers)) {
    if (name in projectServers) continue
    list.push({
      name,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      type: entry.type,
      env: publicEnv(entry.env),
      source: 'local',
      status: statuses[name] ?? 'unknown',
    })
  }

  // `claude mcp list` reports clickup "connected" off the stdio handshake alone —
  // the token is never exercised there. Do a real auth check so a dead/expired
  // token shows "needs-auth" instead of a misleading "connected".
  if (req.query.health !== 'false') {
    const clickup = list.find((s) => s.name === 'clickup')
    if (clickup) {
      const v = await withClickupToken(resolveProjectClickupToken(project.rootPath), verifyToken)
      if (!v.ok) clickup.status = 'needs-auth'
    }
  }

  res.json(list)
})

/**
 * Reveal the FULL env value for a server's first env key, for the localhost
 * "copy" action only. The list endpoint masks secrets so they never sit in the
 * page; this returns the real value on explicit user request. Localhost-only,
 * never logged — the same token already lives in .mcp.json on this machine.
 */
mcpRouter.get('/:name/secret', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const servers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const entry = servers[req.params.name] ?? localProjectMcpServers(project.rootPath)[req.params.name]
  const env = entry?.env
  const first = env ? Object.entries(env).find(([, v]) => typeof v === 'string') : undefined
  if (!first) return res.status(404).json({ error: 'no secret to reveal' })
  return res.json({ key: first[0], value: first[1] })
})

/**
 * Reveal the active project's root folder (where .mcp.json lives) in the OS file
 * explorer on the machine running the server.
 */
mcpRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const result = await revealFolderNative(project.rootPath)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: project.rootPath })
})

mcpRouter.post('/', (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })

  const { name, command, args, url, env, type } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }

  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  if (data.mcpServers[name]) {
    return res.status(400).json({ error: 'server already exists' })
  }

  const entry: McpEntry = {}
  if (typeof type === 'string') entry.type = type
  if (typeof command === 'string' && command.trim()) entry.command = command.trim()
  if (Array.isArray(args)) entry.args = args.filter((a) => typeof a === 'string')
  if (typeof url === 'string' && url.trim()) entry.url = url.trim()
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === 'string') clean[k] = v
    }
    if (Object.keys(clean).length) entry.env = clean
  }
  data.mcpServers[name] = entry

  writeMcp(file, data)
  return res.status(201).json({ ok: true })
})

/** Live connection test for a single configured server. */
mcpRouter.get('/test/:name', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  let result = await testServer(project.rootPath, req.params.name)
  if (result.status === 'pending' && approveMcpJsonServer(project.rootPath, req.params.name)) {
    const retry = await testServer(project.rootPath, req.params.name)
    result = {
      ...retry,
      detail: retry.ok
        ? `Approved in .claude/settings.local.json. ${retry.detail}`
        : `Approved in .claude/settings.local.json, but connection still failed: ${retry.detail}`,
    }
  }

  // For clickup, the handshake passing isn't enough — verify the token actually
  // authenticates, so "Test" catches an expired/invalid token the list can't see.
  if (req.params.name === 'clickup' && result.ok) {
    const v = await withClickupToken(resolveProjectClickupToken(project.rootPath), verifyToken)
    if (!v.ok) {
      result = { ok: false, status: 'needs-auth', detail: v.detail }
    }
  }

  res.json(result)
})

/**
 * Functional test: actually USE a server's MCP via Claude (fetch a ClickUp ticket,
 * read a Figma design, or open+close a browser with Playwright). Body: { input? }.
 */
mcpRouter.post('/test-run/:name', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    const result = await runMcpCapabilityTest({
      rootPath: project.rootPath,
      name: req.params.name,
      input: typeof req.body?.input === 'string' ? req.body.input : '',
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

mcpRouter.delete('/:name', (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })

  const data = readMcp(file)
  if (data.mcpServers && req.params.name in data.mcpServers) {
    delete data.mcpServers[req.params.name]
    writeMcp(file, data)
  }
  const project = resolveProject(req)
  if (project) removeLocalProjectMcpServer(project.rootPath, req.params.name)
  return res.json({ ok: true })
})

// ============================ OAuth ("click → authenticate") ============================

type ProviderId = 'clickup' | 'figma'

interface ProviderDef {
  /** Server name written into .mcp.json. */
  serverName: string
  /** True when OAuth app credentials are configured on the server. */
  hasApp: () => boolean
  /** Build the provider authorize URL the browser is sent to. */
  authorizeUrl: (redirectUri: string, state: string) => string
  /** Exchange the returned code for an access token. */
  exchange: (code: string, redirectUri: string) => Promise<string>
  /** Build the .mcp.json entry that uses the obtained token. */
  buildEntry: (token: string) => McpEntry
}

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  clickup: {
    serverName: 'clickup',
    hasApp: () => !!OAUTH_APPS.clickup.clientId && !!OAUTH_APPS.clickup.clientSecret,
    authorizeUrl: (redirectUri, state) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.clickup.clientId,
        redirect_uri: redirectUri,
        state,
      })
      return `https://app.clickup.com/api?${p.toString()}`
    },
    exchange: async (code, _redirectUri) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.clickup.clientId,
        client_secret: OAUTH_APPS.clickup.clientSecret,
        code,
      })
      const r = await fetch(`https://api.clickup.com/api/v2/oauth/token?${p.toString()}`, {
        method: 'POST',
      })
      const j = (await r.json()) as { access_token?: string; err?: string }
      if (!r.ok || !j.access_token) {
        throw new Error(j.err || `ClickUp token exchange failed (${r.status})`)
      }
      return j.access_token
    },
    buildEntry: (token) => ({
      type: 'stdio',
      command: 'uvx',
      args: ['--from', 'git+https://github.com/DiversioTeam/clickup-mcp.git', 'clickup-mcp'],
      env: { CLICKUP_API_KEY: token },
    }),
  },
  figma: {
    serverName: 'figma',
    hasApp: () => !!OAUTH_APPS.figma.clientId && !!OAUTH_APPS.figma.clientSecret,
    authorizeUrl: (redirectUri, state) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.figma.clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_APPS.figma.scope,
        state,
        response_type: 'code',
      })
      return `https://www.figma.com/oauth?${p.toString()}`
    },
    exchange: async (code, redirectUri) => {
      // Figma's v1 token endpoint takes client creds via HTTP Basic auth.
      const basic = Buffer.from(
        `${OAUTH_APPS.figma.clientId}:${OAUTH_APPS.figma.clientSecret}`,
      ).toString('base64')
      const body = new URLSearchParams({
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
      })
      const r = await fetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      const j = (await r.json()) as { access_token?: string; message?: string; error?: string }
      if (!r.ok || !j.access_token) {
        throw new Error(j.message || j.error || `Figma token exchange failed (${r.status})`)
      }
      return j.access_token
    },
    // Pass the OAuth bearer explicitly via the documented CLI flag.
    buildEntry: (token) => ({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio', '--figma-oauth-token', token],
    }),
  },
}

function isProviderId(v: string): v is ProviderId {
  return v === 'clickup' || v === 'figma'
}

// Where the user grabs a personal API token for each provider (token-connect flow).
const TOKEN_URLS: Record<ProviderId, string> = {
  clickup: 'https://app.clickup.com/settings/apps',
  figma: 'https://www.figma.com/settings',
}

/**
 * Build the .mcp.json entry for a pasted PERSONAL API token (not an OAuth
 * bearer). ClickUp's CLI reads CLICKUP_API_KEY (older builds: CLICKUP_MCP_API_KEY
 * — we set both); Figma's personal-access-token path is FIGMA_API_KEY.
 */
function buildTokenEntry(provider: ProviderId, token: string): McpEntry {
  if (provider === 'clickup') {
    return {
      type: 'stdio',
      command: 'uvx',
      args: ['--from', 'git+https://github.com/DiversioTeam/clickup-mcp.git', 'clickup-mcp'],
      env: { CLICKUP_API_KEY: token, CLICKUP_MCP_API_KEY: token },
    }
  }
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    env: { FIGMA_API_KEY: token },
  }
}

function redirectUriFor(provider: ProviderId): string {
  return `${OAUTH_REDIRECT_BASE}/api/mcp/oauth/${provider}/callback`
}

/** Open a URL in the user's default browser (server runs on their machine). */
function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    execFile(cmd, args, { windowsHide: true }, () => {}) // hide the transient cmd window
  } catch {
    /* best-effort; the UI also surfaces the URL */
  }
}

// In-memory pending-auth store, keyed by state. Lost on restart, which is fine —
// an interrupted auth just needs to be retried.
interface Pending {
  provider: ProviderId
  projectId: string
  rootPath: string
  createdAt: number
  result?: { ok: true } | { ok: false; error: string }
}
const pending = new Map<string, Pending>()

function prunePending(): void {
  const cutoff = Date.now() - 10 * 60 * 1000 // 10 minutes
  for (const [state, p] of pending) if (p.createdAt < cutoff) pending.delete(state)
}

/** Which providers can be authenticated, and whether each is already configured. */
mcpRouter.get('/oauth/status', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const servers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const status = (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    provider: id,
    hasApp: PROVIDERS[id].hasApp(),
    configured: PROVIDERS[id].serverName in servers,
    tokenUrl: TOKEN_URLS[id],
  }))
  res.json({ redirectBase: OAUTH_REDIRECT_BASE, providers: status })
})

/**
 * Token-connect: save a pasted personal API token into this project's
 * .mcp.json. No OAuth app required — the user copies a token from the
 * provider's settings page and pastes it back.
 */
mcpRouter.post('/oauth/:provider/token', (req, res) => {
  const providerId = req.params.provider
  if (!isProviderId(providerId)) return res.status(404).json({ error: 'unknown provider' })
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) return res.status(400).json({ error: 'token is required' })

  const file = mcpJsonFor(project.rootPath)
  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  data.mcpServers[PROVIDERS[providerId].serverName] = buildTokenEntry(providerId, token)
  writeMcp(file, data)
  return res.status(201).json({ ok: true })
})

/** Begin an OAuth flow: open the browser to the provider's consent screen. */
mcpRouter.post('/oauth/:provider/start', (req, res) => {
  const providerId = req.params.provider
  if (!isProviderId(providerId)) return res.status(404).json({ error: 'unknown provider' })
  const def = PROVIDERS[providerId]
  if (!def.hasApp()) {
    return res.status(400).json({
      error: `${providerId} OAuth app is not configured. Set ${providerId.toUpperCase()}_OAUTH_CLIENT_ID and ${providerId.toUpperCase()}_OAUTH_CLIENT_SECRET in the server environment, and register the redirect URI ${redirectUriFor(providerId)}.`,
    })
  }
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  prunePending()
  const state = crypto.randomUUID()
  pending.set(state, {
    provider: providerId,
    projectId: project.id,
    rootPath: project.rootPath,
    createdAt: Date.now(),
  })

  const redirectUri = redirectUriFor(providerId)
  const authorizeUrl = def.authorizeUrl(redirectUri, state)
  openBrowser(authorizeUrl)
  res.json({ state, authorizeUrl })
})

/** Poll the result of an in-flight auth (frontend polls until done). */
mcpRouter.get('/oauth/:provider/result', (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const p = pending.get(state)
  if (!p) return res.json({ status: 'unknown' })
  if (!p.result) return res.json({ status: 'pending' })
  if (p.result.ok) {
    pending.delete(state)
    return res.json({ status: 'done' })
  }
  const error = p.result.error
  pending.delete(state)
  return res.json({ status: 'error', error })
})

function resultPage(title: string, message: string, ok: boolean): string {
  const color = ok ? '#059669' : '#dc2626'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f8fafc;color:#0f172a}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 40px;box-shadow:0 8px 24px -6px rgba(15,23,42,.12);text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{margin:0;color:#64748b}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div>
<script>setTimeout(()=>window.close(),2500)</script></body></html>`
}

/** OAuth redirect target: exchange the code, write the server into .mcp.json. */
mcpRouter.get('/oauth/:provider/callback', async (req, res) => {
  const providerId = req.params.provider
  res.set('Content-Type', 'text/html')
  if (!isProviderId(providerId)) {
    return res.status(404).send(resultPage('Unknown provider', 'Nothing to do here.', false))
  }
  const def = PROVIDERS[providerId]
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthErr = typeof req.query.error === 'string' ? req.query.error : ''

  // Match by state; fall back to the sole pending auth for this provider when
  // the provider doesn't echo `state` back (ClickUp historically omits it).
  let p = state ? pending.get(state) : undefined
  if (!p) {
    const sameProvider = [...pending.values()].filter((x) => x.provider === providerId && !x.result)
    if (sameProvider.length === 1) p = sameProvider[0]
  }
  if (oauthErr) {
    if (p) p.result = { ok: false, error: oauthErr }
    return res
      .status(400)
      .send(resultPage('Authorization canceled', `${providerId}: ${oauthErr}`, false))
  }
  if (!code || !p) {
    return res
      .status(400)
      .send(resultPage('Invalid callback', 'Missing or expired authorization. Try again.', false))
  }

  try {
    const token = await def.exchange(code, redirectUriFor(providerId))
    const file = mcpJsonFor(p.rootPath)
    const data = readMcp(file)
    if (!data.mcpServers) data.mcpServers = {}
    data.mcpServers[def.serverName] = def.buildEntry(token)
    writeMcp(file, data)
    p.result = { ok: true }
    return res.send(
      resultPage(
        `${def.serverName} connected`,
        'Authentication succeeded. You can close this tab and return to QC Portal.',
        true,
      ),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed'
    p.result = { ok: false, error: message }
    return res.status(500).send(resultPage('Authentication failed', message, false))
  }
})
