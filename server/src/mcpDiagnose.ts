import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { exec } from 'node:child_process'
import spawn from 'cross-spawn'
import { killSpawnedTree, spawnEnv } from './toolPath.js'

/**
 * "Why won't this MCP server connect?" — the MCP page's error log.
 *
 * `claude mcp list` only ever says "✗ Failed to connect", which is useless on a
 * colleague's machine where the same .mcp.json works for you. The real reason
 * (`uvx` not on PATH, a pydantic "api_key Field required", a 401 from Jira, a
 * Python traceback) is on the server's STDERR, which the CLI swallows. So this
 * does two things:
 *
 *  1. Launches the server ITSELF, exactly as configured (command, args, env, cwd),
 *     speaks the MCP `initialize` + `tools/list` handshake over stdio — or POSTs it
 *     to a remote url — and records every byte of stderr/stdout, the exit code and
 *     the timing.
 *  2. Reads Claude Code's own per-server connection logs
 *     (`<cache>/claude-cli-nodejs/<project>/mcp-logs-<name>/*.jsonl`), which hold
 *     the error from Claude's last real attempt — the one a run actually saw.
 *
 * Secrets never leave: every env/header value of the entry (and anything that looks
 * like a bearer token) is scrubbed from ALL the text returned, logs included.
 */

export interface McpDiagEntry {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  /** A shell command Claude Code runs to get extra headers (JSON object on stdout). */
  headersHelper?: unknown
  cwd?: string
}

export interface McpDiagStep {
  /** ok | warn | error | info */
  level: 'ok' | 'warn' | 'error' | 'info'
  text: string
}

export interface McpClaudeLog {
  file: string
  modifiedAt: string
  lines: string[]
}

export interface McpDiagnosis {
  name: string
  transport: 'stdio' | 'http' | 'sse' | 'unknown'
  ok: boolean
  /** One-line verdict + the most likely fix. */
  summary: string
  hint?: string
  /** The command line / url that was tried, secrets masked. */
  target: string
  cwd?: string
  durationMs: number
  exitCode?: number | null
  signal?: string | null
  serverInfo?: string
  toolCount?: number
  steps: McpDiagStep[]
  stderr: string
  stdout: string
  claudeLogs: McpClaudeLog[]
  claudeLogDir?: string
}

const STDIO_TIMEOUT_MS = 60_000 // a cold `uvx`/`npx` downloads the package first
const HTTP_TIMEOUT_MS = 20_000
const MAX_CAPTURE = 64 * 1024
const MAX_LOG_FILES = 3
const MAX_LOG_LINES = 200

/** `${VAR}` / `${VAR:-default}` — the same expansion Claude Code applies to .mcp.json. */
function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, key: string, def?: string) => {
    const v = env[key]
    return v !== undefined && v !== '' ? v : (def ?? '')
  })
}

/** Builds a scrubber that masks every secret value we know of, plus generic tokens. */
function makeScrubber(secrets: string[]): (s: string) => string {
  const list = [...new Set(secrets.map((s) => s.trim()).filter((s) => s.length >= 6))].sort(
    (a, b) => b.length - a.length,
  )
  return (text: string) => {
    let out = text
    for (const s of list) out = out.split(s).join(`••••${s.slice(-4)}`)
    return out
      .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 ••••')
      .replace(/(access_token|refresh_token|api_key|apikey|token)(["'=:\s]+)[A-Za-z0-9._~+/-]{12,}/gi, '$1$2••••')
  }
}

function quoteArg(a: string): string {
  return /[\s"']/.test(a) ? JSON.stringify(a) : a
}

/** Colour codes and OSC-8 hyperlinks (Python `rich` logging is full of them). */
function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
}

/** Inline images (server icons) are kilobytes of base64 that say nothing. */
function shortenDataUris(text: string): string {
  return text.replace(/data:([\w/+.-]+);base64,[A-Za-z0-9+/=]{40,}/g, 'data:$1;base64,…')
}

function cap(raw: string): string {
  const text = shortenDataUris(stripAnsi(raw))
  return text.length > MAX_CAPTURE ? text.slice(0, MAX_CAPTURE) + '\n… (truncated)' : text
}

/** Recognise the failures we have actually met and say what fixes them. */
function hintFor(text: string, rawCommand?: string): string | undefined {
  const t = text.toLowerCase()
  // A full path (`C:\\Users\\x\\.local\\bin\\uvx.exe`) still means uvx.
  const command = rawCommand?.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (/enoent|command not found|is not recognized as an internal or external command|no such file or directory/.test(t)) {
    if (rawCommand && /^[a-z]:\\|^\/(users|home)\//i.test(rawCommand) && !rawCommand.startsWith(os.homedir()))
      return `The command is a full path from ANOTHER machine ("${rawCommand}"). Edit the server and set the command to just "${command}" so this machine finds its own copy.`
    if (command && /^uvx?$/.test(command))
      return '`uv` / `uvx` is not installed (or not on PATH) on this machine. Install Astral uv (https://docs.astral.sh/uv/), then restart the portal.'
    if (command && /^(npx|node|npm)$/.test(command))
      return 'Node.js / npx is not on PATH for the portal. Install Node 22+ and restart the portal from a fresh terminal.'
    return `The command "${rawCommand ?? ''}" could not be found on this machine. Install it, or fix the server's command.`
  }
  if (/api_key[\s\S]{0,40}field required|clickup_mcp_api_key/.test(t))
    return 'Newer clickup-mcp needs CLICKUP_MCP_API_KEY in env (the old variable alone is not enough). Disconnect and reconnect ClickUp to rewrite it.'
  if (/401|unauthori[sz]ed|invalid.*(token|credential)|authentication failed/.test(t))
    return 'The server started but the credential was rejected (401). For Jira use an UNSCOPED classic API token, check the e-mail/username and the site URL.'
  if (/403|forbidden/.test(t)) return 'The credential is valid but has no permission for this resource (403).'
  if (/certificate|ssl|self[- ]signed|unable to verify/.test(t))
    return 'TLS / certificate error — usually a company proxy or VPN intercepting HTTPS. Try off the VPN, or set the proxy CA for Python/Node.'
  if (/getaddrinfo|enotfound|econnrefused|etimedout|network is unreachable|name or service not known/.test(t))
    return 'Network error — the machine cannot reach the server/site (DNS, VPN, proxy or firewall).'
  if (/proxy/.test(t)) return 'A proxy is involved — check HTTPS_PROXY / HTTP_PROXY on this machine.'
  if (/no matching distribution|could not find a version|failed to download|pip|resolution failed/.test(t))
    return 'uv could not download the Python package (offline, proxy, or blocked PyPI). Try `uvx <package> --help` in a terminal on this machine.'
  if (/eacces|eperm|permission denied/.test(t)) return 'Permission denied — a file/folder the server needs is not writable by this user.'
  if (/python.*not found|no interpreter|requires-python/.test(t))
    return 'uv could not find a suitable Python. Run `uv python install` on this machine.'
  return undefined
}

// ---- Claude Code's own MCP logs ------------------------------------------------

function claudeCacheRoots(): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Caches', 'claude-cli-nodejs')]
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    return [path.join(local, 'claude-cli-nodejs', 'Cache'), path.join(local, 'claude-cli-nodejs')]
  }
  const xdg = process.env.XDG_CACHE_HOME || path.join(home, '.cache')
  return [path.join(xdg, 'claude-cli-nodejs')]
}

/** Claude Code names the folders by replacing every non-alphanumeric char with "-". */
const slug = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '-')

export function readClaudeMcpLogs(
  rootPath: string,
  name: string,
  scrub: (s: string) => string,
): { dir?: string; logs: McpClaudeLog[] } {
  const projectKeys = [...new Set([slug(rootPath), slug(rootPath.replace(/\\/g, '/'))])]
  for (const root of claudeCacheRoots()) {
    for (const key of projectKeys) {
      const dir = path.join(root, key, `mcp-logs-${slug(name)}`)
      let files: { file: string; mtime: number }[]
      try {
        files = fs
          .readdirSync(dir)
          .filter((f) => /\.(jsonl|txt|log)$/.test(f))
          .map((f) => ({ file: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      } catch {
        continue
      }
      files.sort((a, b) => b.mtime - a.mtime)
      const logs = files.slice(0, MAX_LOG_FILES).map(({ file, mtime }) => {
        let raw = ''
        try {
          raw = fs.readFileSync(path.join(dir, file), 'utf8')
        } catch {
          /* unreadable — show it empty */
        }
        const lines = raw
          .split('\n')
          .filter(Boolean)
          .slice(-MAX_LOG_LINES)
          .map((line) => {
            try {
              const j = JSON.parse(line) as Record<string, unknown>
              const msg = j.error ?? j.debug ?? j.message ?? j.info ?? line
              const level = j.error ? 'ERROR' : j.debug ? 'debug' : 'info'
              const ts = typeof j.timestamp === 'string' ? j.timestamp.replace('T', ' ').replace(/\..*$/, '') : ''
              return scrub(shortenDataUris(`${ts} [${level}] ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`))
            } catch {
              return scrub(shortenDataUris(line))
            }
          })
        return { file, modifiedAt: new Date(mtime).toISOString(), lines }
      })
      return { dir, logs }
    }
  }
  return { logs: [] }
}

// ---- live launch ----------------------------------------------------------------

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'qc-portal-diagnose', version: '1.0.0' },
  },
}

function diagnoseStdio(
  rootPath: string,
  entry: McpDiagEntry,
  scrub: (s: string) => string,
): Promise<Omit<McpDiagnosis, 'name' | 'claudeLogs' | 'claudeLogDir'>> {
  const started = Date.now()
  const env = spawnEnv(
    Object.fromEntries(
      Object.entries(entry.env ?? {}).map(([k, v]) => [k, expand(String(v), process.env)]),
    ),
  )
  const command = expand(entry.command ?? '', env)
  const args = (entry.args ?? []).map((a) => expand(String(a), env))
  const cwd = entry.cwd ? path.resolve(rootPath, expand(entry.cwd, env)) : rootPath
  const target = scrub([command, ...args].map(quoteArg).join(' '))
  const steps: McpDiagStep[] = [
    { level: 'info', text: `Launching: ${target}` },
    { level: 'info', text: `Working folder: ${cwd}` },
  ]
  const envKeys = Object.keys(entry.env ?? {})
  if (envKeys.length) steps.push({ level: 'info', text: `Env set by the config: ${envKeys.join(', ')}` })
  for (const k of envKeys) {
    if (!String(entry.env?.[k] ?? '').trim()) steps.push({ level: 'warn', text: `${k} is EMPTY in the config.` })
  }

  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let buf = ''
    let serverInfo: string | undefined
    let toolCount: number | undefined
    let initOk = false
    let rpcError: string | undefined
    let done = false

    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    const finish = (reason: 'tools' | 'exit' | 'timeout' | 'spawn-error', extra?: { code?: number | null; signal?: string | null; err?: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (reason !== 'exit' && reason !== 'spawn-error') killSpawnedTree(child)
      const durationMs = Date.now() - started
      const all = `${stderr}\n${stdout}\n${extra?.err ?? ''}\n${rpcError ?? ''}`
      let ok = false
      let summary: string
      if (reason === 'spawn-error') {
        summary = `Could not start the process: ${extra?.err}`
        steps.push({ level: 'error', text: summary })
      } else if (initOk) {
        ok = true
        summary = `Connected — ${serverInfo ?? 'server'} answered the MCP handshake in ${(durationMs / 1000).toFixed(1)}s${
          toolCount !== undefined ? ` with ${toolCount} tool(s)` : ''
        }.`
        if (toolCount === 0) {
          ok = false
          summary += ' But it offers NO tools — usually a missing/invalid credential or a disabled toolset.'
        }
      } else if (rpcError) {
        summary = `The server answered with an error: ${rpcError}`
      } else if (reason === 'timeout') {
        summary = `No MCP answer within ${STDIO_TIMEOUT_MS / 1000}s — the server hung, or is still downloading.`
        steps.push({ level: 'error', text: summary })
      } else {
        summary = `The process exited (code ${extra?.code ?? '?'}${extra?.signal ? `, ${extra.signal}` : ''}) before answering the MCP handshake.`
        steps.push({ level: 'error', text: summary })
      }
      resolve({
        transport: 'stdio',
        ok,
        summary: scrub(summary),
        hint: ok ? undefined : hintFor(all, command),
        target,
        cwd,
        durationMs,
        exitCode: extra?.code,
        signal: extra?.signal,
        serverInfo,
        toolCount,
        steps: steps.map((s) => ({ ...s, text: scrub(s.text) })),
        stderr: scrub(cap(stderr)),
        stdout: scrub(cap(stdout)),
      })
    }

    const timer = setTimeout(() => finish('timeout'), STDIO_TIMEOUT_MS)

    child.on('error', (e) => finish('spawn-error', { err: e instanceof Error ? e.message : String(e) }))
    child.on('close', (code, signal) => finish('exit', { code, signal }))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.stdout?.on('data', (d) => {
      const s = String(d)
      stdout += s
      buf += s
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string; code?: number } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.id === 1) {
          if (msg.error) {
            rpcError = `${msg.error.message ?? 'error'} (code ${msg.error.code ?? '?'})`
            steps.push({ level: 'error', text: `initialize failed: ${rpcError}` })
            finish('tools')
            return
          }
          initOk = true
          const info = msg.result?.serverInfo as { name?: string; version?: string } | undefined
          serverInfo = info ? `${info.name ?? 'server'}${info.version ? ` ${info.version}` : ''}` : undefined
          steps.push({ level: 'ok', text: `initialize OK after ${((Date.now() - started) / 1000).toFixed(1)}s${serverInfo ? ` — ${serverInfo}` : ''}` })
          child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
          child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
        } else if (msg.id === 2) {
          if (msg.error) {
            steps.push({ level: 'warn', text: `tools/list failed: ${msg.error.message ?? 'error'}` })
          } else {
            const tools = msg.result?.tools
            toolCount = Array.isArray(tools) ? tools.length : 0
            steps.push({ level: toolCount ? 'ok' : 'warn', text: `tools/list → ${toolCount} tool(s)` })
          }
          finish('tools')
          return
        }
      }
    })
    child.stdin?.on('error', () => {
      /* the process died before reading — `close` reports it */
    })
    child.stdin?.write(JSON.stringify(INIT) + '\n')
  })
}

async function diagnoseHttp(
  entry: McpDiagEntry,
  scrub: (s: string) => string,
  preSteps: McpDiagStep[] = [],
): Promise<Omit<McpDiagnosis, 'name' | 'claudeLogs' | 'claudeLogDir'>> {
  const started = Date.now()
  const url = expand(entry.url ?? '', process.env)
  const transport = entry.type === 'sse' ? 'sse' : 'http'
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...Object.fromEntries(Object.entries(entry.headers ?? {}).map(([k, v]) => [k, expand(String(v), process.env)])),
  }
  const steps: McpDiagStep[] = [
    ...preSteps,
    { level: 'info', text: `${transport === 'sse' ? 'GET' : 'POST'} ${url}` },
  ]
  const hdrNames = Object.keys(entry.headers ?? {})
  if (hdrNames.length) steps.push({ level: 'info', text: `Headers sent: ${hdrNames.join(', ')}` })
  let body = ''
  let ok = false
  let summary = ''
  let serverInfo: string | undefined
  let all = ''
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
    const r =
      transport === 'sse'
        ? await fetch(url, { method: 'GET', headers: { ...headers, accept: 'text/event-stream' }, signal: ctrl.signal })
        : await fetch(url, { method: 'POST', headers, body: JSON.stringify(INIT), signal: ctrl.signal })
    // An SSE stream may never end, so read until the first complete JSON-RPC message
    // (or the cap / 3s) instead of to EOF — one chunk cut the answer mid-word.
    const reader = r.body?.getReader()
    if (reader) {
      const dec = new TextDecoder()
      const until = Date.now() + 3000
      while (body.length < MAX_CAPTURE && Date.now() < until) {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r2) =>
            setTimeout(() => r2({ done: true, value: undefined }), Math.max(0, until - Date.now())),
          ),
        ]).catch(() => ({ done: true as const, value: undefined }))
        if (chunk.value) body += dec.decode(chunk.value, { stream: true })
        if (chunk.done || /"jsonrpc"[\s\S]*\}\s*(\n|$)/.test(body) && /\n\n|^\{/.test(body)) break
      }
      reader.cancel().catch(() => {})
    }
    clearTimeout(t)
    steps.push({ level: r.ok ? 'ok' : 'error', text: `HTTP ${r.status} ${r.statusText}` })
    const www = r.headers.get('www-authenticate')
    if (www) steps.push({ level: 'warn', text: `WWW-Authenticate: ${www}` })
    all = `${r.status} ${body} ${www ?? ''}`
    const m = body.match(/"serverInfo"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/)
    if (m) serverInfo = m[1]
    if (r.status === 401) summary = 'The server needs sign-in (401) — use "Sign in" on this row, or check the token header.'
    else if (r.ok) {
      ok = true
      summary = `Reachable — HTTP ${r.status}${serverInfo ? `, ${serverInfo} answered the handshake` : ''}.`
    } else summary = `The server answered HTTP ${r.status} ${r.statusText}.`
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const msg = err.name === 'AbortError' ? `No answer within ${HTTP_TIMEOUT_MS / 1000}s` : `${err.message}${err.cause ? ` — ${err.cause.code ?? ''} ${err.cause.message ?? ''}` : ''}`
    summary = `Could not reach the server: ${msg}`
    steps.push({ level: 'error', text: summary })
    all = msg
  }
  return {
    transport,
    ok,
    summary: scrub(summary),
    hint: ok ? undefined : hintFor(all),
    target: scrub(url),
    durationMs: Date.now() - started,
    serverInfo,
    steps: steps.map((s) => ({ ...s, text: scrub(s.text) })),
    stderr: '',
    stdout: scrub(cap(body)),
  }
}

/**
 * Run an entry's `headersHelper` the way Claude Code does (a shell command whose stdout
 * is a JSON object of headers). The portal's own Jira / ClickUp sign-in is wired up this
 * way: the token never sits in .mcp.json, so probing the url WITHOUT running the helper
 * is a guaranteed — and misleading — 401.
 */
function runHeadersHelper(
  rootPath: string,
  cmd: string,
): Promise<{ headers?: Record<string, string>; error?: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd: rootPath, env: spawnEnv(), timeout: 15_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ error: `${err.message}${stderr ? ` — ${String(stderr).trim()}` : ''}` })
      try {
        const parsed = JSON.parse(String(stdout).trim() || '{}') as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return resolve({ error: 'It did not print a JSON object.' })
        const headers = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>
        resolve({ headers })
      } catch {
        resolve({ error: `It printed something that is not JSON: ${String(stdout).trim().slice(0, 200)}` })
      }
    })
  })
}

/** Did Claude Code's most recent attempt (newest log file) end connected? */
function claudeLastConnected(logs: McpClaudeLog[]): boolean {
  const lines = logs[0]?.lines ?? []
  const lastIndex = (re: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i])) return i
    return -1
  }
  const okAt = lastIndex(/successfully connected/i)
  const errAt = lastIndex(/\[ERROR\]/)
  return okAt !== -1 && okAt > errAt
}

export async function diagnoseMcpServer(
  rootPath: string,
  name: string,
  entry: McpDiagEntry,
): Promise<McpDiagnosis> {
  // Remote server with a headersHelper: fetch its headers first, so the probe carries
  // the same credential Claude Code would send.
  const preSteps: McpDiagStep[] = []
  let helperHeaders: Record<string, string> = {}
  const helperCmd = typeof entry.headersHelper === 'string' ? entry.headersHelper.trim() : ''
  if (entry.url && helperCmd) {
    const h = await runHeadersHelper(rootPath, helperCmd)
    if (h.headers && Object.keys(h.headers).length) {
      helperHeaders = h.headers
      preSteps.push({ level: 'ok', text: `headersHelper gave: ${Object.keys(h.headers).join(', ')}` })
    } else {
      preSteps.push({
        level: 'error',
        text: h.error
          ? `headersHelper failed: ${h.error}`
          : 'headersHelper returned NO headers — the sign-in behind it is missing or expired.',
      })
    }
  }
  const probeEntry: McpDiagEntry = { ...entry, headers: { ...(entry.headers ?? {}), ...helperHeaders } }
  const secrets = [
    ...Object.values(helperHeaders).flatMap((v) => [v, v.replace(/^\S+\s+/, '')]),
    ...Object.values(entry.env ?? {}).map(String),
    ...Object.values(entry.env ?? {}).map((v) => expand(String(v), process.env)),
    ...Object.values(entry.headers ?? {}).flatMap((v) => {
      const s = expand(String(v), process.env)
      // "Bearer abc…" — also mask the bare token part.
      return [s, s.replace(/^\S+\s+/, '')]
    }),
  ]
  const scrub = makeScrubber(secrets)
  const live = entry.url
    ? await diagnoseHttp(probeEntry, scrub, preSteps)
    : entry.command
      ? await diagnoseStdio(rootPath, entry, scrub)
      : {
          transport: 'unknown' as const,
          ok: false,
          summary: 'The entry has neither a "command" nor a "url".',
          target: '',
          durationMs: 0,
          steps: [],
          stderr: '',
          stdout: '',
        }
  const { dir, logs } = readClaudeMcpLogs(rootPath, name, scrub)
  // No credential the portal can send (no header, no helper): the server signs in with
  // OAuth, and that token lives in Claude Code's own credential store, out of reach. A
  // 401 here is then EXPECTED, not a failure — Claude Code's last attempt is the truth.
  if (
    entry.url &&
    !live.ok &&
    /401/.test(live.summary) &&
    !Object.keys(probeEntry.headers ?? {}).length
  ) {
    const connected = claudeLastConnected(logs)
    live.steps.push({
      level: 'info',
      text: 'This server signs in with OAuth; Claude Code keeps that token itself, so the portal cannot send it. Judging by Claude Code\'s own last attempt instead.',
    })
    if (connected) {
      return {
        name,
        ...live,
        ok: true,
        summary: 'Connected — Claude Code\'s last attempt signed in and connected (the 401 above is the expected answer without its OAuth token).',
        hint: undefined,
        claudeLogs: logs,
        claudeLogDir: dir,
      }
    }
    live.summary = 'The server wants an OAuth sign-in, and Claude Code\'s last attempt did not connect.'
    live.hint = 'Use "Sign in" on this row, then Test again. Claude Code\'s own log below shows its last attempt.'
  }
  // Claude's own last attempt may name a reason the live launch didn't hit (or vice versa).
  const lastErr = logs[0]?.lines.filter((l) => l.includes('[ERROR]')).slice(-1)[0]
  const hint = live.hint ?? (live.ok ? undefined : lastErr ? hintFor(lastErr, entry.command) : undefined)
  return { name, ...live, hint, claudeLogs: logs, claudeLogDir: dir }
}
