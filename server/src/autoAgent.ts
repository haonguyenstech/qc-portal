import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Auto Agent (@saigontechnology/auto-agent, CLI `auto-agent-ai`) — the company's
// credential distributor for Claude Code. It signs in (Microsoft), pulls the shared
// Claude credential into the keychain, and leaves a WATCHER process running to keep
// it fresh. The QC Portal still spawns plain `claude`; it just can't authenticate if
// Auto Agent is logged out, its watcher died, or the credential lapsed — which shows
// up as confusing mid-run auth failures. This module reports that state so the
// sidebar can say so up front.
//
// SECRETS: read `state.json` ONLY. The sibling `.config.json` holds `auth.accessToken`
// and the distributed Claude credentials — this module must never open it, and nothing
// here may return a token. state.json carries no secret material (role, username,
// server URL, expiry, session id, watcher pid).

const AGENT_DIR = path.join(os.homedir(), '.auto-agent-ai')
const STATE_FILE = path.join(AGENT_DIR, 'state.json')
const WATCH_LOG = path.join(AGENT_DIR, 'watch.log')

/** How close to expiry we start warning (the watcher normally refreshes well before). */
const EXPIRY_WARN_MS = 30 * 60 * 1000

export type AutoAgentState =
  | 'connected' // logged in, watcher alive, credential valid
  | 'expiring' // as above but the credential lapses soon
  | 'stalled' // logged in + credential valid, but the watcher process is gone
  | 'expired' // logged in but the credential has lapsed
  | 'logged-out' // Auto Agent is installed but nobody is signed in
  | 'not-installed' // no Auto Agent state on this machine at all

export interface AutoAgentStatus {
  state: AutoAgentState
  /** True only for `connected` — the one state that needs no attention. */
  ok: boolean
  /** Short, user-facing sentence for the sidebar tooltip / notification. */
  message: string
  username: string | null
  serverUrl: string | null
  role: string | null
  /** ISO timestamp the pulled credential expires, when known. */
  expiresAt: string | null
  watcherRunning: boolean
  /** Last ✖ line from watch.log, when it explains the current problem. */
  lastError: string | null
  checkedAt: string
}

interface RawState {
  role?: unknown
  username?: unknown
  serverUrl?: unknown
  lastExpiresAt?: unknown
  watchPid?: unknown
}

function readState(): RawState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as RawState) : null
  } catch {
    return null
  }
}

/** Is that pid still alive? `kill(pid, 0)` tests existence without signalling. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = alive but owned by another user; only ESRCH means "no such process".
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Last failure the watcher logged, if it's the most recent thing that happened.
 * The log is append-only and can be ~1 MB, so read only the tail. A ✖ line that is
 * followed by a later "Watcher started" is stale history, not the current state.
 */
function lastWatcherError(): string | null {
  try {
    const { size } = fs.statSync(WATCH_LOG)
    const span = Math.min(size, 8192)
    const fd = fs.openSync(WATCH_LOG, 'r')
    const buf = Buffer.alloc(span)
    try {
      fs.readSync(fd, buf, 0, span, Math.max(0, size - span))
    } finally {
      fs.closeSync(fd)
    }
    const lines = buf
      .toString('utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (/watcher started/i.test(line)) return null // recovered since
      if (line.includes('✖')) {
        // Drop the leading "HH:MM:SS " stamp and cap the length for the UI.
        return line.replace(/^\d{2}:\d{2}:\d{2}\s*/, '').replace(/^✖\s*/, '').slice(0, 200)
      }
    }
    return null
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/**
 * Read Auto Agent's connection state. Pure filesystem + pid probe — no network, no
 * child process, so the sidebar can poll it cheaply. Never throws.
 */
export function readAutoAgentStatus(): AutoAgentStatus {
  const checkedAt = new Date().toISOString()
  const base = {
    ok: false,
    username: null,
    serverUrl: null,
    role: null,
    expiresAt: null,
    watcherRunning: false,
    lastError: null,
    checkedAt,
  }

  const installed = fs.existsSync(AGENT_DIR)
  const state = readState()
  if (!installed || !state) {
    return {
      ...base,
      state: installed ? 'logged-out' : 'not-installed',
      message: installed
        ? 'Auto Agent is not signed in — run `auto-agent-ai login` to pull the Claude credential.'
        : 'Auto Agent is not set up on this machine, so Claude runs use whatever credential `claude` already has.',
    }
  }

  const username = str(state.username)
  const serverUrl = str(state.serverUrl)
  const role = str(state.role)
  const expiresMs = typeof state.lastExpiresAt === 'number' ? state.lastExpiresAt : null
  const expiresAt = expiresMs ? new Date(expiresMs).toISOString() : null
  const watcherRunning = pidAlive(typeof state.watchPid === 'number' ? state.watchPid : 0)
  const lastError = lastWatcherError()
  const common = { username, serverUrl, role, expiresAt, watcherRunning, lastError, checkedAt }
  const left = expiresMs ? expiresMs - Date.now() : null

  if (left != null && left <= 0) {
    return {
      ...common,
      ok: false,
      state: 'expired',
      message: lastError
        ? `Auto Agent's Claude credential expired — ${lastError}`
        : "Auto Agent's Claude credential expired. Run `auto-agent-ai login` to pull a fresh one.",
    }
  }
  if (!watcherRunning) {
    return {
      ...common,
      ok: false,
      state: 'stalled',
      message: lastError
        ? `Auto Agent's watcher stopped — ${lastError}`
        : "Auto Agent's watcher is not running, so the Claude credential will not be refreshed. Run `auto-agent-ai login`.",
    }
  }
  if (left != null && left <= EXPIRY_WARN_MS) {
    const mins = Math.max(1, Math.round(left / 60_000))
    return {
      ...common,
      ok: false,
      state: 'expiring',
      message: `Auto Agent's Claude credential expires in ~${mins} min. The watcher should refresh it automatically.`,
    }
  }
  return {
    ...common,
    ok: true,
    state: 'connected',
    message: `Auto Agent connected as ${username ?? 'this user'}${serverUrl ? ` (${serverUrl})` : ''}.`,
  }
}
