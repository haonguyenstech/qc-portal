import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import {
  clearAccessPassword,
  clearRemoteCookie,
  isRemoteRequest,
  isRemoteUnlocked,
  MIN_PASSWORD_LENGTH,
  readRemoteAccessInfo,
  revokeAllRemoteSessions,
  setAccessPassword,
  sourceKeyOf,
  unlockRemote,
  updateRemoteAccessOptions,
} from '../remoteAccess.js'
import {
  readTunnelSettings,
  readTunnelStatus,
  startTunnel,
  stopTunnel,
  tunnelIsUp,
  updateTunnelSettings,
  type TunnelMode,
} from '../tunnel.js'

export const remoteRouter = Router()

/**
 * Some of this router must NOT be reachable from the internet even by an unlocked
 * session. Anyone who is remote already has the password, so this isn't a secrecy
 * measure — it's blast radius: a stolen phone or a shared session should not be able
 * to change the password (locking the owner out), disable the terminal block, or
 * publish a tunnel that was deliberately taken down. Those stay at the keyboard.
 *
 * `POST /stop` is deliberately NOT local-only — taking the portal off the internet is
 * the one direction that is always safe to allow.
 */
function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isRemoteRequest(req)) return next()
  res.status(403).json({
    error: 'This setting can only be changed on the portal machine itself, not over the tunnel.',
  })
}

// ------------------------------------------------------------------ public (pre-gate)

/**
 * What a LOCKED browser is allowed to ask. Both this and /unlock are on
 * `remoteAccess.ts`'s allow-list, so they are the only two things a remote visitor can
 * reach before entering the password — keep them free of anything about the machine.
 */
remoteRouter.get('/gate', (req, res) => {
  const { hasPassword } = readRemoteAccessInfo()
  res.json({
    hasPassword,
    remote: isRemoteRequest(req),
    unlocked: isRemoteUnlocked(req),
  })
})

/** Exchange the access password for a session cookie. Rate-limited in `remoteAccess.ts`. */
remoteRouter.post('/unlock', (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!password) return res.status(400).json({ error: 'An access password is required.' })
  const result = unlockRemote(password, sourceKeyOf(req))
  if (!result.ok) {
    const status = result.retryAfterMs ? 429 : 401
    if (result.retryAfterMs) res.set('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)))
    return res.status(status).json({ error: result.error })
  }
  res.set('Set-Cookie', result.setCookie)
  res.json({ ok: true, expiresAt: new Date(result.expiresAt).toISOString() })
})

/** Sign this browser out (the cookie only — other devices keep their sessions). */
remoteRouter.post('/lock', (_req, res) => {
  res.set('Set-Cookie', clearRemoteCookie())
  res.json({ ok: true })
})

// ------------------------------------------------------------------ status

/** Everything the Remote access page draws. Polled while a publish is in flight. */
remoteRouter.get('/', (req, res) => {
  res.json({
    status: readTunnelStatus(),
    settings: readTunnelSettings(),
    access: readRemoteAccessInfo(),
    /** So the page can explain why its controls are read-only when viewed remotely. */
    viewingRemotely: isRemoteRequest(req),
  })
})

// ------------------------------------------------------------------ the gate's settings

remoteRouter.post('/password', localOnly, (req, res) => {
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  try {
    setAccessPassword(password)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
  // Changing the password rotated the session secret, so every other device is now
  // locked out — say so, because that is a surprise otherwise.
  res.json({ ok: true, access: readRemoteAccessInfo(), sessionsRevoked: true })
})

/**
 * Remove the password — refused while the tunnel is up. Clearing it with a live
 * hostname would leave the portal publicly reachable with no gate at all for as long
 * as it took the engineer to notice, which is the exact state this feature promises
 * cannot happen.
 */
remoteRouter.delete('/password', localOnly, (_req, res) => {
  if (tunnelIsUp()) {
    return res.status(409).json({
      error: 'Stop the tunnel first — the password cannot be removed while the portal is published.',
    })
  }
  clearAccessPassword()
  res.json({ ok: true, access: readRemoteAccessInfo() })
})

remoteRouter.put('/access', localOnly, (req, res) => {
  const body = req.body ?? {}
  updateRemoteAccessOptions({
    sessionHours: body.sessionHours === undefined ? undefined : Number(body.sessionHours),
    allowTerminal: body.allowTerminal === undefined ? undefined : body.allowTerminal === true,
  })
  res.json({ ok: true, access: readRemoteAccessInfo() })
})

remoteRouter.post('/sessions/revoke', localOnly, (_req, res) => {
  revokeAllRemoteSessions()
  res.set('Set-Cookie', clearRemoteCookie())
  res.json({ ok: true })
})

// ------------------------------------------------------------------ the tunnel

remoteRouter.put('/settings', localOnly, (req, res) => {
  const body = req.body ?? {}
  const mode = body.mode as TunnelMode | undefined
  if (mode && !['quick', 'token', 'named'].includes(mode)) {
    return res.status(400).json({ error: `Unknown tunnel mode "${String(mode)}".` })
  }
  try {
    const settings = updateTunnelSettings({
      mode,
      // null clears the stored token; undefined (field absent) keeps it — so the page
      // can save a hostname change without having to re-type the token it never saw.
      token: body.token === null ? '' : typeof body.token === 'string' ? body.token.trim() : undefined,
      tunnelName: typeof body.tunnelName === 'string' ? body.tunnelName : undefined,
      hostname: typeof body.hostname === 'string' ? body.hostname : undefined,
      autoStart: body.autoStart === undefined ? undefined : body.autoStart === true,
      autoRestart: body.autoRestart === undefined ? undefined : body.autoRestart === true,
    })
    res.json({ ok: true, settings, status: readTunnelStatus() })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * Publish. Answers as soon as cloudflared is spawned: reaching `running` waits on
 * Cloudflare's edge and the page polls GET / for that — the same reason crawling and
 * test-case generation are polled jobs rather than long requests.
 */
remoteRouter.post('/start', localOnly, (_req, res) => {
  const result = startTunnel()
  if (!result.ok) {
    // 409 when it's a state conflict ("already published"), 400 when the setup is
    // incomplete — the page shows the message either way but retries only the former.
    const conflict = result.error?.includes('already') ?? false
    return res.status(conflict ? 409 : 400).json({ error: result.error, status: result.status })
  }
  res.json({ ok: true, status: result.status })
})

remoteRouter.post('/stop', (_req, res) => {
  res.json({ ok: true, status: stopTunnel() })
})

export { MIN_PASSWORD_LENGTH }
