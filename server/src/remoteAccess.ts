import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { DB_PATH } from './config.js'

// The access gate in front of the Cloudflare Tunnel (see `tunnel.ts`).
//
// WHY THIS EXISTS AT ALL — and why it may not be softened:
//
// The portal is a REMOTE CONTROL for the machine it runs on. It spawns `claude`
// with `--permission-mode bypassPermissions`, hands out a real shell over
// /ws/terminal, reads and writes any file under a project root, and holds ClickUp /
// Jira / database credentials. On localhost that is fine: the only client is the
// engineer sitting at the keyboard. The moment a tunnel publishes it to a public
// hostname, "anyone who learns the URL" and "the engineer" become the same
// principal — a trycloudflare.com URL is unauthenticated, unlisted but not secret,
// and is enough to run commands on a company laptop.
//
// So the tunnel and this gate ship together, and the gate FAILS CLOSED:
//   * the tunnel cannot start until an access password is set (`tunnel.ts` asks);
//   * a request that arrives through Cloudflare with no valid session gets the
//     unlock page and NOTHING else — not the API, not even the JS bundle;
//   * the WebSocket upgrade is checked the same way, so a run stream or a terminal
//     can't be attached around the HTTP gate.
//
// HOW "remote" IS DETECTED. cloudflared runs on this same machine and connects to
// 127.0.0.1, so tunnel traffic is indistinguishable from local traffic by socket
// address — every request looks like ::1. What Cloudflare's edge does add is
// `cf-connecting-ip` / `cf-ray`, which it sets on every proxied request. Their
// PRESENCE is therefore the signal: it can only have come from the edge (nothing on
// loopback sends them by accident), and a local process spoofing them onto its own
// request gains nothing — it is already local, and the worst it achieves is locking
// ITSELF out. The server still binds 127.0.0.1; that is unchanged.

// ------------------------------------------------------------------ stored settings

export interface RemoteAccessSettings {
  /** scrypt hash of the access password, hex. Empty = no password set = tunnel refused. */
  passwordHash: string
  passwordSalt: string
  /**
   * HMAC key for session cookies. Rotating it is how "sign out everywhere" works —
   * every issued cookie stops verifying at once.
   */
  sessionSecret: string
  /** How long an unlocked browser stays unlocked. */
  sessionHours: number
  /**
   * Whether a remote session may reach the device terminal (/api/terminal, /ws/terminal).
   * Off by default: an interactive shell is the one thing on the portal that needs no
   * further creativity to become a full machine compromise, and a QC reviewing a run
   * from their phone does not need it.
   */
  allowTerminal: boolean
  updatedAt: string
}

const DEFAULTS: RemoteAccessSettings = {
  passwordHash: '',
  passwordSalt: '',
  sessionSecret: '',
  sessionHours: 12,
  allowTerminal: false,
  updatedAt: '',
}

/**
 * Beside the portal's own database (0600), never inside a project — same reasoning as
 * `totp.ts` and `apiAccounts.ts`: a credential that must not be committed to a repo and
 * must never be swept into a prompt by `projectContext.ts`.
 */
const storeFile = () => path.join(path.dirname(DB_PATH), 'remote-access.json')

function readSettings(): RemoteAccessSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Partial<RemoteAccessSettings>
    return {
      ...DEFAULTS,
      ...parsed,
      sessionHours: clampHours(parsed.sessionHours),
      allowTerminal: parsed.allowTerminal === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

function writeSettings(next: RemoteAccessSettings): void {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  cache = next
}

const clampHours = (n: unknown): number => {
  const v = Number(n)
  if (!Number.isFinite(v)) return DEFAULTS.sessionHours
  return Math.min(24 * 30, Math.max(1, Math.round(v)))
}

/** Read once, keep in memory — the guard runs on every single request. */
let cache: RemoteAccessSettings | null = null
const settings = (): RemoteAccessSettings => (cache ??= readSettings())

// ------------------------------------------------------------------ the password

export const MIN_PASSWORD_LENGTH = 10

export function hasAccessPassword(): boolean {
  return Boolean(settings().passwordHash)
}

/**
 * What the browser is allowed to know about the gate. The hash, the salt and the
 * session secret never leave this process.
 */
export interface RemoteAccessInfo {
  hasPassword: boolean
  sessionHours: number
  allowTerminal: boolean
  minPasswordLength: number
  updatedAt: string
}

export function readRemoteAccessInfo(): RemoteAccessInfo {
  const s = settings()
  return {
    hasPassword: Boolean(s.passwordHash),
    sessionHours: s.sessionHours,
    allowTerminal: s.allowTerminal,
    minPasswordLength: MIN_PASSWORD_LENGTH,
    updatedAt: s.updatedAt,
  }
}

const hash = (password: string, salt: string): string =>
  crypto.scryptSync(password, salt, 32).toString('hex')

/**
 * Set (or replace) the access password. Replacing it rotates the session secret too,
 * so changing the password signs every already-unlocked browser out — the only
 * behaviour that makes sense when the reason for the change is "someone saw it".
 */
export function setAccessPassword(password: string): void {
  const value = password.trim()
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`The access password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
  }
  const salt = crypto.randomBytes(16).toString('hex')
  writeSettings({
    ...settings(),
    passwordSalt: salt,
    passwordHash: hash(value, salt),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString(),
  })
  failures.clear()
}

/**
 * Remove the password. Callers must stop the tunnel first — a published portal with
 * no password is exactly what this module exists to prevent, so `routes/remote.ts`
 * refuses while the tunnel is up rather than leaving a window open.
 */
export function clearAccessPassword(): void {
  writeSettings({
    ...settings(),
    passwordHash: '',
    passwordSalt: '',
    sessionSecret: '',
    updatedAt: new Date().toISOString(),
  })
}

export function updateRemoteAccessOptions(patch: {
  sessionHours?: number
  allowTerminal?: boolean
}): void {
  const s = settings()
  writeSettings({
    ...s,
    sessionHours: patch.sessionHours === undefined ? s.sessionHours : clampHours(patch.sessionHours),
    allowTerminal: patch.allowTerminal === undefined ? s.allowTerminal : patch.allowTerminal === true,
    updatedAt: new Date().toISOString(),
  })
}

/** Rotate the session secret: every unlocked browser has to enter the password again. */
export function revokeAllRemoteSessions(): void {
  if (!settings().passwordHash) return
  writeSettings({
    ...settings(),
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    updatedAt: new Date().toISOString(),
  })
}

// ------------------------------------------------------------------ brute force guard

/**
 * A public hostname invites a dictionary attack, and a 10-character password is not
 * a 10-character password if it can be guessed 50 times a second. Per-source counter,
 * in memory only (a restart clearing it is fine — the attacker's window is the process
 * lifetime, not forever).
 */
const MAX_FAILURES = 8
const LOCKOUT_MS = 15 * 60 * 1000
const failures = new Map<string, { count: number; until: number }>()

function lockoutRemaining(key: string): number {
  const entry = failures.get(key)
  if (!entry) return 0
  if (entry.count < MAX_FAILURES) return 0
  const left = entry.until - Date.now()
  if (left <= 0) {
    failures.delete(key)
    return 0
  }
  return left
}

function noteFailure(key: string): void {
  const entry = failures.get(key) ?? { count: 0, until: 0 }
  entry.count += 1
  entry.until = Date.now() + LOCKOUT_MS
  failures.set(key, entry)
}

// ------------------------------------------------------------------ sessions

const COOKIE = 'qc_remote_session'

/** `<expiry ms>.<hmac>` — stateless, so a server restart doesn't sign everyone out. */
function issueToken(): { token: string; expiresAt: number } {
  const s = settings()
  const expiresAt = Date.now() + s.sessionHours * 3600_000
  const mac = crypto.createHmac('sha256', s.sessionSecret).update(String(expiresAt)).digest('hex')
  return { token: `${expiresAt}.${mac}`, expiresAt }
}

function verifyToken(token: string | undefined): boolean {
  const s = settings()
  if (!token || !s.sessionSecret) return false
  const [expiryPart, mac] = token.split('.')
  const expiresAt = Number(expiryPart)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !mac) return false
  const expected = crypto
    .createHmac('sha256', s.sessionSecret)
    .update(String(expiresAt))
    .digest('hex')
  // Length-checked before timingSafeEqual — it throws on a length mismatch, which
  // would turn a malformed cookie into a 500 instead of a 401.
  if (mac.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

/**
 * Check the password and hand back a Set-Cookie value. `sourceKey` is whatever
 * identifies the caller for rate limiting (the Cloudflare client IP).
 */
export function unlockRemote(
  password: string,
  sourceKey: string,
): { ok: true; setCookie: string; expiresAt: number } | { ok: false; error: string; retryAfterMs?: number } {
  const s = settings()
  if (!s.passwordHash) {
    return { ok: false, error: 'Remote access has no password set, so it is disabled.' }
  }
  const locked = lockoutRemaining(sourceKey)
  if (locked > 0) {
    return {
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(locked / 60000)} minute(s).`,
      retryAfterMs: locked,
    }
  }
  const candidate = hash(password, s.passwordSalt)
  const good =
    candidate.length === s.passwordHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(s.passwordHash))
  if (!good) {
    noteFailure(sourceKey)
    return { ok: false, error: 'Wrong access password.' }
  }
  failures.delete(sourceKey)
  const { token, expiresAt } = issueToken()
  // Secure: the tunnel is always https. SameSite=Lax so a plain link into the portal
  // still arrives unlocked. Max-Age matches the token so the browser and the server
  // agree on when it stops working.
  const maxAge = Math.floor((expiresAt - Date.now()) / 1000)
  return {
    ok: true,
    expiresAt,
    setCookie: `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  }
}

export const clearRemoteCookie = (): string =>
  `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`

// ------------------------------------------------------------------ request classification

/**
 * Treat every request as if it arrived through the tunnel. For DEVELOPING the gate
 * itself — otherwise the only way to see the unlock page is to publish a tunnel.
 */
const FORCE_GUARD = ['1', 'true', 'yes', 'on'].includes(
  (process.env.QC_REMOTE_FORCE_GUARD ?? '').trim().toLowerCase(),
)

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

/** Did this request come in through Cloudflare? (See the module note on detection.) */
export function isRemoteRequest(req: IncomingMessage): boolean {
  if (FORCE_GUARD) return true
  return Boolean(header(req, 'cf-connecting-ip') || header(req, 'cf-ray'))
}

/** Who to rate-limit. The edge's client IP, falling back to the socket. */
const sourceKeyOf = (req: IncomingMessage): string =>
  header(req, 'cf-connecting-ip') || req.socket.remoteAddress || 'unknown'

export function isRemoteUnlocked(req: IncomingMessage): boolean {
  return verifyToken(readCookie(req.headers.cookie, COOKIE))
}

/**
 * Is this request allowed to proceed?
 *   'local'    — not through the tunnel; the gate does not apply
 *   'ok'       — remote and unlocked
 *   'no-password' / 'locked' / 'terminal-blocked' — refuse, with that reason
 */
export type GateVerdict = 'local' | 'ok' | 'no-password' | 'locked' | 'terminal-blocked'

const TERMINAL_PATH = /^\/(?:api\/terminal|ws\/terminal)/

export function gateVerdict(req: IncomingMessage, pathname: string): GateVerdict {
  if (!isRemoteRequest(req)) return 'local'
  if (!settings().passwordHash) return 'no-password'
  if (!isRemoteUnlocked(req)) return 'locked'
  if (TERMINAL_PATH.test(pathname) && !settings().allowTerminal) return 'terminal-blocked'
  return 'ok'
}

// ------------------------------------------------------------------ the middleware

/**
 * Paths a locked remote browser may still reach: the unlock form's own endpoints.
 * Everything else — including the static JS bundle — waits until the cookie is valid,
 * so an un-unlocked visitor gets one HTML page and no portal code at all.
 */
const PUBLIC_PATHS = new Set(['/api/remote/gate', '/api/remote/unlock'])

/**
 * The ONE prefix that is reachable through the tunnel without the access password.
 *
 * This is a deliberate second door, not an oversight, and it is safe only because of
 * what is behind it: AI Sync's peer API (`routes/sync.ts`) can pair against a 4-digit
 * code and then READ files from ONE project that the owner explicitly opened, for a
 * bounded time, with five wrong codes revoking the whole thing. It cannot list
 * projects, write a byte, spawn anything, or reach any other route. See the module
 * note in `aiSync.ts` for the full argument.
 *
 * Nothing else may be added here. Everything the portal does that is not that — the
 * API, the shell, even the JS bundle — stays behind the password.
 */
const PUBLIC_PREFIXES = ['/api/sync/peer/']

export function remoteAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const pathname = req.path
  if (PUBLIC_PATHS.has(pathname)) return next()
  if (PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return next()

  const verdict = gateVerdict(req, pathname)
  if (verdict === 'local' || verdict === 'ok') return next()

  const isApi = pathname === '/api' || pathname.startsWith('/api/')

  if (verdict === 'terminal-blocked') {
    const message =
      'The device terminal is disabled for remote access. Enable it on the portal machine under Settings → Remote access.'
    if (isApi) {
      res.status(403).json({ error: message })
    } else {
      res.status(403).type('text/plain').send(message)
    }
    return
  }

  if (verdict === 'no-password') {
    const message =
      'Remote access is disabled: no access password is set on the portal machine.'
    if (isApi) {
      res.status(503).json({ error: message, remoteDisabled: true })
    } else {
      res.status(503).type('text/html').send(unlockPage(message, false))
    }
    return
  }

  // Locked. An API caller gets a machine-readable 401 (so the SPA can redirect to a
  // fresh unlock instead of showing "network error" everywhere); a navigation gets
  // the form.
  if (isApi) {
    res.status(401).json({ error: 'Unlock required.', needsUnlock: true })
    return
  }
  res.status(401).type('text/html').send(unlockPage(null, true))
}

/** The same check for the WebSocket upgrade, which never reaches Express middleware. */
export function wsUpgradeAllowed(req: IncomingMessage, pathname: string): boolean {
  const verdict = gateVerdict(req, pathname)
  return verdict === 'local' || verdict === 'ok'
}

export { sourceKeyOf }

// ------------------------------------------------------------------ the unlock page

/**
 * Deliberately a self-contained HTML string rather than a React route: it must render
 * for a visitor who has not been served one byte of the application bundle. Styled to
 * match the portal's System-Style UI (large radii, hairline borders, pill button) and
 * theme-aware via prefers-color-scheme, since there is no token stylesheet here.
 */
function unlockPage(fatal: string | null, showForm: boolean): string {
  const form = showForm
    ? `
      <form id="f" autocomplete="on">
        <label for="p">Access password</label>
        <input id="p" name="password" type="password" autocomplete="current-password" autofocus required />
        <button type="submit" id="b">Unlock</button>
        <p class="err" id="e" hidden></p>
      </form>`
    : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>QC Portal — locked</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f7f7f8; --card:#fff; --fg:#0b0b0c; --muted:#6b6b74; --border:#e3e3e7; --accent:#0b0b0c; --accent-fg:#fff; --danger:#b42318; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#0b0b0c; --card:#141416; --fg:#f4f4f5; --muted:#9a9aa4; --border:#26262b; --accent:#f4f4f5; --accent-fg:#0b0b0c; --danger:#ff6b6b; } }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
    background:var(--bg); color:var(--fg);
    font:400 14px/1.5 "Google Sans Flex","Google Sans",system-ui,-apple-system,sans-serif; }
  .card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border);
    border-radius:24px; padding:28px; }
  .mark { width:40px; height:40px; border-radius:14px; background:var(--accent); color:var(--accent-fg);
    display:grid; place-items:center; font-weight:600; margin-bottom:18px; }
  h1 { margin:0 0 6px; font-size:18px; font-weight:600; letter-spacing:-0.01em; }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  label { display:block; font-size:12px; font-weight:500; color:var(--muted); margin-bottom:6px; }
  input { width:100%; padding:10px 14px; border-radius:12px; border:1px solid var(--border);
    background:transparent; color:var(--fg); font:inherit; }
  input:focus { outline:2px solid var(--accent); outline-offset:1px; }
  button { width:100%; margin-top:14px; padding:10px 16px; border:0; border-radius:999px;
    background:var(--accent); color:var(--accent-fg); font:inherit; font-weight:500; cursor:pointer; }
  button[disabled] { opacity:.6; cursor:default; }
  .err { margin:12px 0 0; color:var(--danger); font-size:13px; }
</style>
</head>
<body>
  <div class="card">
    <div class="mark">QC</div>
    <h1>${fatal ? 'Remote access is off' : 'This portal is locked'}</h1>
    <p class="sub">${
      fatal
        ? escapeHtml(fatal)
        : 'You are reaching QC Portal over a Cloudflare Tunnel. Enter the access password set on the portal machine.'
    }</p>
    ${form}
  </div>
<script>
(function () {
  var f = document.getElementById('f');
  if (!f) return;
  f.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var b = document.getElementById('b'), e = document.getElementById('e');
    b.disabled = true; b.textContent = 'Unlocking…'; e.hidden = true;
    fetch('/api/remote/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ password: document.getElementById('p').value })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) { location.replace('/'); return; }
        e.textContent = (res.j && res.j.error) || 'Unlock failed.';
        e.hidden = false; b.disabled = false; b.textContent = 'Unlock';
      })
      .catch(function () {
        e.textContent = 'Could not reach the portal.';
        e.hidden = false; b.disabled = false; b.textContent = 'Unlock';
      });
  });
})();
</script>
</body>
</html>`
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
