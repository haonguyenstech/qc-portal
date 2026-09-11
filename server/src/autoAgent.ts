import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveAutoAgentBin } from './autoAgentCli.js'

// Auto Agent (@saigontechnology/auto-agent, CLI `auto-agent-ai`) — the company's
// credential distributor for Claude Code. It signs in (Microsoft) and pulls the shared
// Claude credential into the keychain. The QC Portal still spawns plain `claude`; it
// just can't authenticate if Auto Agent is logged out or the credential lapsed — which
// shows up as confusing mid-run auth failures. This module reports that state so the
// sidebar can say so up front.
//
// WHAT COUNTS AS HEALTHY, and why this changed: up to CLI 1.1.16 `login` left a
// detached WATCHER process behind and wrote its pid to state.json, so "healthy" meant
// "that pid is alive". CLI 1.1.20 removed that mode entirely — `login` only keeps the
// credential current while it owns a TTY, and it writes no pid. Probing for one made
// every healthy machine report "Watcher stopped" for ever. What actually matters to a
// `claude` run is the one thing it reads: an unexpired credential.
//
// SECRETS: read `state.json` ONLY. The sibling `.config.json` holds `auth.accessToken`
// and the distributed Claude credentials — this module must never open it, and nothing
// here may return a token. state.json carries no secret material (role, username,
// server URL, expiry, session id).

const AGENT_DIR = path.join(os.homedir(), '.auto-agent-ai')
const STATE_FILE = path.join(AGENT_DIR, 'state.json')
const WATCH_LOG = path.join(AGENT_DIR, 'watch.log')

/** How close to expiry we start warning. */
const EXPIRY_WARN_MS = 30 * 60 * 1000

export type AutoAgentState =
  | 'connected' // signed in and the credential is good
  | 'expiring' // as above but it lapses soon
  | 'expired' // signed in but the credential has lapsed
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
  /** Last ✖ line from watch.log, when it explains the CURRENT problem. */
  lastError: string | null
  /**
   * Path to the `auto-agent-ai` binary, or null when it isn't on this machine. This is
   * what tells the UI whether Connect/Disconnect can do anything at all — without it the
   * only honest offer is "install Auto Agent".
   */
  cliPath: string | null
  checkedAt: string
}

interface RawState {
  role?: unknown
  username?: unknown
  serverUrl?: unknown
  lastExpiresAt?: unknown
}

function readState(): RawState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as RawState) : null
  } catch {
    return null
  }
}

/**
 * Last failure the CLI logged, if it's still the most recent thing that happened.
 * The log is append-only and can be ~1 MB, so read only the tail. A ✖ line that is
 * followed by a later "Watcher started" is stale history, not the current state.
 *
 * The mtime gate matters more than it looks: CLI 1.1.20 stopped writing this file at
 * all, so whatever ✖ it ends on is frozen there for ever. Presented as the current
 * problem, last week's 403 becomes a permanent red herring in the sidebar — which is
 * exactly what it did. A log older than the sign-in that wrote state.json describes a
 * session that is over.
 */
function lastWatcherError(): string | null {
  try {
    const { size, mtimeMs } = fs.statSync(WATCH_LOG)
    const stateMtime = fs.statSync(STATE_FILE).mtimeMs
    if (mtimeMs < stateMtime) return null // predates the current sign-in
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
  const cliPath = resolveAutoAgentBin()
  const base = {
    ok: false,
    username: null,
    serverUrl: null,
    role: null,
    expiresAt: null,
    lastError: null,
    cliPath,
    checkedAt,
  }

  // "Installed" is the BINARY, not the state dir. `auto-agent-ai logout` deletes the
  // whole config dir, so a dir-only test reported a deliberate sign-out as "not set up
  // on this machine" — and hid the Connect button that fixes it.
  const installed = cliPath != null || fs.existsSync(AGENT_DIR)
  const state = readState()
  if (!installed || !state) {
    return {
      ...base,
      state: installed ? 'logged-out' : 'not-installed',
      message: installed
        ? 'Auto Agent is not signed in — connect to pull the shared Claude credential.'
        : 'Auto Agent is not set up on this machine, so Claude runs use whatever credential `claude` already has.',
    }
  }

  const username = str(state.username)
  const serverUrl = str(state.serverUrl)
  const role = str(state.role)
  const expiresMs = typeof state.lastExpiresAt === 'number' ? state.lastExpiresAt : null
  const expiresAt = expiresMs ? new Date(expiresMs).toISOString() : null
  const lastError = lastWatcherError()
  const common = { username, serverUrl, role, expiresAt, lastError, cliPath, checkedAt }
  const left = expiresMs ? expiresMs - Date.now() : null

  if (left != null && left <= 0) {
    return {
      ...common,
      ok: false,
      state: 'expired',
      message: lastError
        ? `Auto Agent's Claude credential expired — ${lastError}`
        : "Auto Agent's Claude credential expired. Connect again to pull a fresh one.",
    }
  }
  if (left != null && left <= EXPIRY_WARN_MS) {
    const mins = Math.max(1, Math.round(left / 60_000))
    return {
      ...common,
      ok: false,
      state: 'expiring',
      message: `Auto Agent's Claude credential expires in ~${mins} min. It is renewed automatically if the AutoAgent Status app is running here; otherwise connect again before it lapses.`,
    }
  }
  return {
    ...common,
    ok: true,
    state: 'connected',
    message: `Auto Agent connected as ${username ?? 'this user'}${serverUrl ? ` (${serverUrl})` : ''}.`,
  }
}
