import spawn, { sync as spawnSync } from 'cross-spawn'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DB_PATH, PORT } from './config.js'
import { hasAccessPassword, MIN_PASSWORD_LENGTH } from './remoteAccess.js'
import { killSpawnedTree, spawnEnv } from './toolPath.js'

// Publishing the portal to a public hostname with a Cloudflare Tunnel.
//
// A tunnel is an OUTBOUND connection: `cloudflared` runs on this machine, dials
// Cloudflare's edge, and the edge proxies https://<hostname> back down that
// connection to http://127.0.0.1:<portal port>. Nothing listens on a public
// interface and no router port is forwarded — which is exactly why the portal can
// keep binding 127.0.0.1 (see "Localhost only" in CLAUDE.md) and still be reachable
// from a phone. The access gate in `remoteAccess.ts` is the other half of that
// bargain and this module REFUSES TO START without it.
//
// Three modes, because they trade a fixed domain against setup cost:
//
//   quick — `cloudflared tunnel --url …`. No Cloudflare account, no config, one
//           click. The hostname is a random *.trycloudflare.com that CHANGES every
//           start, and Cloudflare offers it no uptime promise. Right for "let a
//           teammate look at this run for ten minutes".
//   token — `cloudflared tunnel run --token …`. A connector token copied from
//           Cloudflare Zero Trust → Networks → Tunnels. The public hostname and the
//           service it maps to live in the dashboard, so the portal never needs a
//           cert.pem and the same token works on any machine. Right for a fixed
//           company domain, and the mode that can sit behind Cloudflare Access.
//   named — `cloudflared tunnel run <name>`. A tunnel managed LOCALLY: it needs
//           `cloudflared tunnel login` (writes ~/.cloudflared/cert.pem) plus a DNS
//           route. Kept because an engineer who already set one up should not have
//           to re-create it as a token.
//
// The child's output is the only progress signal there is (cloudflared has no status
// API), so it is parsed for the quick URL and for "Registered tunnel connection" —
// the line that actually means traffic will arrive. Until one of those, the tunnel is
// `starting`, never `running`: reporting a URL that 502s is worse than reporting none.

export type TunnelMode = 'quick' | 'token' | 'named'
export type TunnelState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

// ------------------------------------------------------------------ the binary

const BIN_ENV = process.env.QC_CLOUDFLARED_BIN?.trim() || ''

/** Install locations a portal launched from a desktop shortcut won't have on PATH. */
function extraBinDirs(): string[] {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return [
      process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'cloudflared'),
      process.env['ProgramFiles(x86)'] &&
        path.join(process.env['ProgramFiles(x86)'], 'cloudflared'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'cloudflared'),
    ].filter((p): p is string => Boolean(p))
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', path.join(home, '.local', 'bin')]
}

/**
 * Where `cloudflared` is, or null when it isn't installed. Resolved against
 * `spawnEnv()`'s PATH for the same reason `autoAgentCli.ts` does it — a stale PATH is
 * the normal case for a server started from a shortcut. Not cached: installing
 * cloudflared must show up on the next poll without restarting the portal.
 */
export function resolveCloudflaredBin(): string | null {
  if (BIN_ENV) return fs.existsSync(BIN_ENV) ? BIN_ENV : null
  const env = spawnEnv()
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  const dirs = [
    ...(env[pathKey] ?? '').split(path.delimiter).filter(Boolean),
    ...extraBinDirs(),
  ]
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, 'cloudflared' + ext.toLowerCase())
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* next candidate */
      }
    }
  }
  return null
}

const INSTALL_HINT =
  process.platform === 'win32'
    ? 'Install it with `winget install --id Cloudflare.cloudflared`, then restart the portal.'
    : process.platform === 'darwin'
      ? 'Install it with `brew install cloudflared`.'
      : 'Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/.'

// ------------------------------------------------------------------ stored settings

export interface TunnelSettings {
  mode: TunnelMode
  /** Connector token (mode `token`). NEVER returned to the browser. */
  token: string
  /** Tunnel name (mode `named`). */
  tunnelName: string
  /**
   * The public hostname. Required for `token`/`named` — those modes get their routing
   * from Cloudflare, so this is what the portal SHOWS and links to, and it is the only
   * way the UI can hand over a working URL. Ignored for `quick`.
   */
  hostname: string
  /** Publish again automatically when the portal starts. */
  autoStart: boolean
  /** Restart cloudflared if it drops (network blip, laptop lid, edge restart). */
  autoRestart: boolean
  updatedAt: string
}

const DEFAULTS: TunnelSettings = {
  mode: 'quick',
  token: '',
  tunnelName: '',
  hostname: '',
  autoStart: false,
  autoRestart: true,
  updatedAt: '',
}

/** Beside the database (0600) — a connector token is a credential, like `totp.ts`'s seeds. */
const storeFile = () => path.join(path.dirname(DB_PATH), 'tunnel.json')

/**
 * The running cloudflared's pid, so a portal that was SIGKILLed (or whose machine
 * lost power) can clean up after itself on the next boot. This matters more here than
 * for the portal's other children: an orphaned tunnel keeps a PUBLIC hostname pointing
 * at this port, so the Remote access page would say "Not published" while the old URL
 * still served the portal. The gate still protects it, but "off" has to mean off.
 */
const pidFile = () => path.join(path.dirname(DB_PATH), 'tunnel.pid')

function writePidFile(pid: number | undefined): void {
  if (!pid) return
  try {
    fs.mkdirSync(path.dirname(pidFile()), { recursive: true, mode: 0o700 })
    fs.writeFileSync(pidFile(), String(pid), 'utf8')
  } catch {
    /* best effort — a missing pid file only costs us the boot-time cleanup */
  }
}

function clearPidFile(): void {
  try {
    fs.rmSync(pidFile(), { force: true })
  } catch {
    /* already gone */
  }
}

/** Is this pid a live cloudflared? Guards against pid REUSE killing something else. */
function isLiveCloudflared(pid: number): boolean {
  try {
    process.kill(pid, 0) // throws if no such process (or not ours)
  } catch {
    return false
  }
  const probe =
    process.platform === 'win32'
      ? spawnSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', windowsHide: true })
      : spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  return /cloudflared/i.test(probe.stdout ?? '')
}

/**
 * Kill a cloudflared left behind by a previous portal process. Called from `index.ts`
 * at boot, BEFORE `autoStartTunnel()` — two connectors on the same local port would
 * both serve, and only one of them would be the one this portal can stop.
 */
export function reapOrphanedTunnel(): boolean {
  let pid: number
  try {
    pid = Number(fs.readFileSync(pidFile(), 'utf8').trim())
  } catch {
    return false
  }
  clearPidFile()
  if (!Number.isInteger(pid) || pid <= 1 || !isLiveCloudflared(pid)) return false
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(pid, 'SIGTERM')
    }
    return true
  } catch {
    return false
  }
}

let cache: TunnelSettings | null = null

function readSettings(): TunnelSettings {
  if (cache) return cache
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Partial<TunnelSettings>
    cache = {
      ...DEFAULTS,
      ...parsed,
      mode: (['quick', 'token', 'named'] as const).includes(parsed.mode as TunnelMode)
        ? (parsed.mode as TunnelMode)
        : 'quick',
    }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

function writeSettings(next: TunnelSettings): void {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  cache = next
}

/** What the browser sees — the token is reported only as "set" or "not set". */
export interface PublicTunnelSettings extends Omit<TunnelSettings, 'token'> {
  hasToken: boolean
}

export function readTunnelSettings(): PublicTunnelSettings {
  const { token, ...rest } = readSettings()
  return { ...rest, hasToken: Boolean(token) }
}

export function updateTunnelSettings(patch: Partial<TunnelSettings>): PublicTunnelSettings {
  const current = readSettings()
  const next: TunnelSettings = {
    ...current,
    ...patch,
    // An empty string in the patch means "leave the stored token alone"; clearing it
    // is an explicit `token: null` from the route, mapped to '' before it gets here.
    token: patch.token === undefined ? current.token : patch.token,
    hostname: (patch.hostname ?? current.hostname).trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
    tunnelName: (patch.tunnelName ?? current.tunnelName).trim(),
    updatedAt: new Date().toISOString(),
  }
  writeSettings(next)
  return readTunnelSettings()
}

// ------------------------------------------------------------------ live status

export interface TunnelStatus {
  state: TunnelState
  /** The public URL, once it is actually serving. */
  url: string | null
  mode: TunnelMode | null
  startedAt: string | null
  /** When the tunnel first reported a registered connection. */
  readyAt: string | null
  error: string | null
  /** cloudflared output, ANSI-stripped, secret-scrubbed and bounded. In memory only. */
  log: string[]
  /** How many times auto-restart has re-launched cloudflared since the last manual start. */
  restarts: number
  installed: boolean
  binPath: string | null
  installHint: string
  /** The local address being published. */
  target: string
  /** False when web/dist is missing, i.e. the tunnel would serve an API with no UI. */
  uiBundled: boolean
  /** Mirrors `remoteAccess.hasAccessPassword()` — the precondition for starting. */
  hasAccessPassword: boolean
}

const MAX_LOG = 300
/** cloudflared normally registers within a couple of seconds; 45s means something is wrong. */
const READY_TIMEOUT_MS = 45_000
const RESTART_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000]
/** Stay up this long and the restart budget resets — a blip at 3am shouldn't exhaust it. */
const STABLE_MS = 10 * 60 * 1000

interface Live {
  state: TunnelState
  url: string | null
  mode: TunnelMode | null
  startedAt: string | null
  readyAt: string | null
  error: string | null
  log: string[]
  restarts: number
  child: ReturnType<typeof spawn> | null
  readyTimer: NodeJS.Timeout | null
  restartTimer: NodeJS.Timeout | null
  /** Set while a deliberate stop is in flight, so `close` isn't treated as a crash. */
  stopping: boolean
  /**
   * Which launch the live state belongs to. A killed cloudflared's `close` (and its
   * last stderr) can arrive AFTER the next one has been spawned — the ordinary path
   * when the engineer changes mode and publishes again — and without this the dead
   * child's exit code overwrites the new child's status, leaving a tunnel that is
   * actually up reported as "exited with code 0". Every handler checks its own
   * generation before touching `live`.
   */
  generation: number
}

const live: Live = {
  state: 'stopped',
  url: null,
  mode: null,
  startedAt: null,
  readyAt: null,
  error: null,
  log: [],
  restarts: 0,
  child: null,
  readyTimer: null,
  restartTimer: null,
  stopping: false,
  generation: 0,
}

// `here` is server/dist at runtime (server/src under tsx), so the web bundle is two
// levels up — the same arithmetic index.ts uses to serve it. fileURLToPath, not
// `new URL().pathname`: the latter yields `/C:/…` on Windows and never exists.
const here = path.dirname(fileURLToPath(import.meta.url))
const webDistIndex = () => path.join(here, '..', '..', 'web', 'dist', 'index.html')

const uiBundled = (): boolean => {
  try {
    return fs.existsSync(webDistIndex())
  } catch {
    return false
  }
}

export const tunnelTarget = (): string => `http://127.0.0.1:${PORT}`

export function readTunnelStatus(): TunnelStatus {
  const bin = resolveCloudflaredBin()
  return {
    state: live.state,
    url: live.url,
    mode: live.mode,
    startedAt: live.startedAt,
    readyAt: live.readyAt,
    error: live.error,
    log: [...live.log],
    restarts: live.restarts,
    installed: Boolean(bin),
    binPath: bin,
    installHint: INSTALL_HINT,
    target: tunnelTarget(),
    uiBundled: uiBundled(),
    hasAccessPassword: hasAccessPassword(),
  }
}

// ------------------------------------------------------------------ output parsing

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const ANSI = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g
const QUICK_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i
const REGISTERED = /Registered tunnel connection|Connection [0-9a-f-]{8,} registered/i
/** cloudflared's own fatal lines, which say far more than the exit code. */
const FATAL = /(?:failed to (?:parse|unmarshal) .*token|tunnel credentials file .* doesn't exist|Couldn't (?:start|connect)|error="?[^"]*unauthorized|Cannot determine default origin certificate path|tunnel not found|failed to create tunnel)/i

/**
 * A connector token is a bearer credential for the tunnel. cloudflared does not echo
 * it, but the token also appears in argv, and cloudflared prints its own command line
 * on some versions — so scrub before anything is stored or shown.
 */
function scrub(line: string): string {
  const token = readSettings().token
  let out = line
  if (token && token.length > 8) out = out.split(token).join('***')
  return out
    .replace(/(--token[= ]+)\S+/gi, '$1***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '***')
}

function pushLog(chunk: string): void {
  for (const raw of chunk.replace(ANSI, '').split(/\r?\n/)) {
    const line = scrub(raw.replace(/\r/g, '').trimEnd())
    if (!line.trim()) continue
    live.log.push(line)
  }
  if (live.log.length > MAX_LOG) live.log.splice(0, live.log.length - MAX_LOG)
}

function markReady(gen: number, url: string): void {
  if (gen !== live.generation) return
  if (live.state === 'running') return
  live.url = url
  live.state = 'running'
  live.readyAt = new Date().toISOString()
  live.error = null
  if (live.readyTimer) clearTimeout(live.readyTimer)
  live.readyTimer = null
  // The restart budget is per outage, not per lifetime.
  const settled = setTimeout(() => {
    if (gen === live.generation && live.state === 'running') live.restarts = 0
  }, STABLE_MS)
  settled.unref()
}

// ------------------------------------------------------------------ start / stop

export interface StartResult {
  ok: boolean
  error?: string
  status: TunnelStatus
}

/**
 * Everything that must be true before a public hostname points at this machine.
 * Ordered cheapest-first, and the password check is NOT optional — see the module
 * note and `remoteAccess.ts`.
 */
function preflight(settings: TunnelSettings): string | null {
  if (!hasAccessPassword()) {
    return `Set an access password (at least ${MIN_PASSWORD_LENGTH} characters) before publishing. Without it, anyone with the URL could run commands on this machine.`
  }
  if (!resolveCloudflaredBin()) {
    return `cloudflared is not installed on this machine. ${INSTALL_HINT}`
  }
  if (settings.mode === 'token' && !settings.token.trim()) {
    return 'This mode needs a connector token from Cloudflare Zero Trust → Networks → Tunnels.'
  }
  if (settings.mode === 'token' && !settings.hostname.trim()) {
    return 'Enter the public hostname you mapped to this tunnel in Cloudflare, so the portal can show you the right URL.'
  }
  if (settings.mode === 'named' && !settings.tunnelName.trim()) {
    return 'Enter the name of the tunnel to run (the one `cloudflared tunnel list` shows).'
  }
  if (settings.mode === 'named' && !settings.hostname.trim()) {
    return 'Enter the public hostname routed to this tunnel.'
  }
  return null
}

function argsFor(settings: TunnelSettings): string[] {
  const target = tunnelTarget()
  switch (settings.mode) {
    case 'quick':
      // `--no-autoupdate`: an unattended self-update would restart the tunnel (and on
      // Windows fail on a locked binary) in the middle of someone's session.
      return ['tunnel', '--no-autoupdate', '--url', target]
    case 'token':
      // No `--url` here on purpose: a token tunnel is REMOTELY managed, and its
      // ingress (which hostname → which local service) comes from the dashboard.
      // Passing --url alongside a remote config is refused by cloudflared.
      return ['tunnel', '--no-autoupdate', 'run', '--token', settings.token.trim()]
    case 'named':
      return ['tunnel', '--no-autoupdate', 'run', '--url', target, settings.tunnelName.trim()]
  }
}

/**
 * Launch cloudflared. Resolves as soon as the child is spawned — reaching `running`
 * is reported through `readTunnelStatus()`, which the page polls, because the wait is
 * the edge's and can outlive an HTTP request.
 */
export function startTunnel(): StartResult {
  if (live.state === 'starting' || live.state === 'running') {
    return { ok: false, error: 'The tunnel is already published.', status: readTunnelStatus() }
  }
  const settings = readSettings()
  const problem = preflight(settings)
  if (problem) {
    // Nothing was launched, so nothing is published — drop the previous run's URL
    // rather than showing an address that no longer answers next to the error.
    live.generation += 1
    live.state = 'error'
    live.error = problem
    live.url = null
    live.readyAt = null
    return { ok: false, error: problem, status: readTunnelStatus() }
  }
  live.restarts = 0
  live.log = []
  return launch(settings, false)
}

function launch(settings: TunnelSettings, isRestart: boolean): StartResult {
  const bin = resolveCloudflaredBin()
  if (!bin) {
    live.state = 'error'
    live.error = `cloudflared is not installed on this machine. ${INSTALL_HINT}`
    return { ok: false, error: live.error, status: readTunnelStatus() }
  }

  // Claim this launch. Anything still attached to the previous one is now stale.
  const gen = (live.generation += 1)
  // A child from a previous launch can still be alive here — a stop whose `close` has
  // not arrived, or an `error` state we never killed. Detached and killed so it can't
  // keep tunnelling invisibly to the same local port.
  if (live.child) {
    const stale = live.child
    stale.removeAllListeners()
    killSpawnedTree(stale)
    live.child = null
    clearPidFile()
  }

  live.state = 'starting'
  live.mode = settings.mode
  live.stopping = false
  live.error = null
  // A quick tunnel's hostname is minted per launch, so a stale URL must not survive a
  // restart. The configured modes keep theirs.
  live.url = settings.mode === 'quick' ? null : `https://${settings.hostname}`
  live.readyAt = null
  if (!isRestart) live.startedAt = new Date().toISOString()
  pushLog(`$ cloudflared ${argsFor(settings).map((a) => (a === settings.token.trim() ? '***' : a)).join(' ')}`)

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, argsFor(settings), {
      // Home, not a project: cloudflared reads ~/.cloudflared and a child holding a
      // project folder open would surprise anyone deleting it later.
      cwd: os.homedir(),
      env: spawnEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    live.state = 'error'
    live.error = err instanceof Error ? err.message : String(err)
    return { ok: false, error: live.error, status: readTunnelStatus() }
  }

  live.child = child
  writePidFile(child.pid)

  const onData = (d: Buffer) => {
    if (gen !== live.generation) return
    const text = d.toString('utf8')
    pushLog(text)
    if (live.state === 'starting' || live.state === 'running') {
      if (settings.mode === 'quick') {
        const found = QUICK_URL.exec(text.replace(ANSI, ''))
        if (found) markReady(gen, found[0])
      }
      if (REGISTERED.test(text)) markReady(gen, live.url ?? `https://${settings.hostname}`)
    }
    if (live.state === 'starting' && FATAL.test(text)) {
      const why = [...live.log].reverse().find((l) => FATAL.test(l))
      live.error = why ?? 'cloudflared reported a fatal error.'
    }
  }
  // cloudflared logs to stderr; stdout is parsed too so a version change can't mute us.
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onData)

  child.on('error', (err) => {
    if (gen !== live.generation) return
    live.error = err.message
    live.state = 'error'
    live.child = null
  })

  child.on('close', (code) => {
    if (gen !== live.generation) return
    live.child = null
    clearPidFile()
    if (live.stopping) {
      live.state = 'stopped'
      live.url = null
      live.readyAt = null
      live.stopping = false
      return
    }
    const wasRunning = live.state === 'running'
    const why =
      live.error ??
      [...live.log].reverse().find((l) => FATAL.test(l)) ??
      `cloudflared exited with code ${code ?? 'unknown'}.`
    if (readSettings().autoRestart && live.restarts < RESTART_DELAYS_MS.length) {
      const delay = RESTART_DELAYS_MS[live.restarts]
      live.restarts += 1
      live.state = 'starting'
      live.error = wasRunning ? `Connection dropped — reconnecting in ${delay / 1000}s.` : why
      pushLog(`[portal] cloudflared exited (${code ?? '?'}) — restart ${live.restarts} in ${delay}ms`)
      live.restartTimer = setTimeout(() => {
        if (gen !== live.generation) return
        launch(readSettings(), true)
      }, delay)
      live.restartTimer.unref()
      return
    }
    live.state = 'error'
    live.url = null
    live.readyAt = null
    live.error = why
  })

  if (live.readyTimer) clearTimeout(live.readyTimer)
  live.readyTimer = setTimeout(() => {
    if (gen !== live.generation || live.state !== 'starting') return
    // Kill it — a cloudflared stuck dialing the edge would otherwise keep retrying
    // behind an error the engineer has already been shown. Retired by hand rather
    // than through stopTunnel(): that path ends in 'stopped', which would erase the
    // timeout message the moment the dying child's `close` arrived.
    const stuck = live.child
    live.generation += 1
    live.child = null
    live.stopping = false
    if (stuck) {
      stuck.removeAllListeners()
      killSpawnedTree(stuck)
    }
    clearPidFile()
    live.state = 'error'
    live.url = null
    live.readyAt = null
    live.error =
      live.error ??
      'cloudflared did not register a connection within 45 seconds. Check the log below, and that this machine can reach Cloudflare on port 7844.'
  }, READY_TIMEOUT_MS)
  live.readyTimer.unref()

  return { ok: true, status: readTunnelStatus() }
}

/** Take the portal off the public hostname. Idempotent. */
export function stopTunnel(): TunnelStatus {
  if (live.restartTimer) clearTimeout(live.restartTimer)
  live.restartTimer = null
  if (live.readyTimer) clearTimeout(live.readyTimer)
  live.readyTimer = null

  const child = live.child
  if (!child) {
    live.generation += 1
    clearPidFile()
    live.state = 'stopped'
    live.url = null
    live.readyAt = null
    live.stopping = false
    return readTunnelStatus()
  }
  live.stopping = true
  live.state = 'stopping'
  pushLog('[portal] stopping cloudflared')
  // The TREE, not the child: on Windows `child` is the cmd.exe shim and the real
  // cloudflared would outlive a bare kill — still tunnelling, invisibly.
  killSpawnedTree(child)
  return readTunnelStatus()
}

export const tunnelIsUp = (): boolean => live.state === 'running' || live.state === 'starting'

/**
 * Publish on boot when the engineer asked for it. Silent by design: a failure here
 * lands in the status the page polls, and a portal that won't start because its tunnel
 * won't start is a worse outcome than an unpublished portal.
 */
export function autoStartTunnel(): void {
  const settings = readSettings()
  if (!settings.autoStart) return
  const result = startTunnel()
  if (!result.ok) {
    console.log(`Remote access auto-start skipped: ${result.error}`)
  } else {
    console.log(`Remote access: publishing over Cloudflare Tunnel (${settings.mode})`)
  }
}

/** Called from the graceful-exit path so a restart never orphans a live tunnel. */
export function shutdownTunnel(): boolean {
  if (!live.child && live.state === 'stopped') return false
  stopTunnel()
  return true
}
