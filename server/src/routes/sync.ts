// AI Sync routes. Three audiences in one router, and the split between them is the
// security boundary — read `aiSync.ts`'s module note before changing any of it.
//
//   /api/sync/peer/*   THE ONLY PART REACHABLE THROUGH THE TUNNEL. Pairing plus
//                      read-only manifest/file access for one shared project, gated
//                      by the 4-digit code and a session bearer token. Allow-listed
//                      in `remoteAccess.ts` so it works before the access password —
//                      which is why everything it can do is bounded there, not here.
//   host endpoints     Opening/closing a share. `localOnly`: someone holding a stolen
//                      remote session must not be able to publish a project that the
//                      owner never offered.
//   guest endpoints    Connecting to another machine and pulling. Also `localOnly`:
//                      "make this laptop fetch gigabytes from a URL I choose" is not
//                      something a remote visitor gets to ask for.

import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import {
  closeShare,
  finishShare,
  listShares,
  machineIdentity,
  manifestFor,
  openShare,
  pair,
  readShare,
  releaseShare,
  readSharedFile,
  reportPeerProgress,
  SyncAuthError,
  SYNC_GROUPS,
  type MachineIdentity,
} from '../aiSync.js'
import { isRemoteRequest } from '../remoteAccess.js'
import {
  activeSyncJob,
  cancelSyncJob,
  connectSync,
  dismissSyncJob,
  getSyncJob,
  listSyncJobs,
  startSync,
  type SyncTarget,
} from '../syncJobs.js'
import { readTunnelStatus } from '../tunnel.js'

export const syncRouter = Router()

/** Same rule, and the same reason, as `routes/remote.ts`'s copy. */
function localOnly(req: Request, res: Response, next: NextFunction): void {
  if (!isRemoteRequest(req)) return next()
  res.status(403).json({
    error: 'AI Sync can only be driven from the portal machine itself, not over the tunnel.',
  })
}

const bearer = (req: Request): string | undefined => {
  const header = req.get('authorization') ?? ''
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
}

function authFail(res: Response, err: unknown): void {
  if (err instanceof SyncAuthError) {
    res.status(err.status).json({ error: err.message, revoked: err.revoked })
    return
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

// ------------------------------------------------------------------ peer (through the tunnel)

/**
 * Exchange the 4-digit code for a bearer token. Every failure burns one of the five
 * attempts every open share has; the fifth revokes them. See `aiSync.pair`.
 */
syncRouter.post('/peer/pair', (req, res) => {
  const code = typeof req.body?.code === 'string' ? req.body.code : ''
  const raw = (req.body?.peer ?? {}) as Partial<MachineIdentity>
  // The peer describes itself; it is a LABEL on a screen, never an authorisation, so
  // it is only length-clamped rather than trusted.
  const peer: MachineIdentity = {
    id: String(raw.id ?? '').slice(0, 64),
    name: String(raw.name ?? 'Unknown machine').slice(0, 80),
    platform: String(raw.platform ?? '').slice(0, 32),
    ip: String(raw.ip ?? '').slice(0, 64),
  }
  try {
    res.json(pair(code, peer))
  } catch (err) {
    authFail(res, err)
  }
})

syncRouter.post('/peer/manifest', (req, res) => {
  const groups = Array.isArray(req.body?.groups) ? (req.body.groups as unknown[]).map(String) : []
  try {
    res.json(manifestFor(bearer(req), groups))
  } catch (err) {
    authFail(res, err)
  }
})

syncRouter.get('/peer/file', (req, res) => {
  const rel = typeof req.query.path === 'string' ? req.query.path : ''
  try {
    const buf = readSharedFile(bearer(req), rel)
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(buf.length))
    res.send(buf)
  } catch (err) {
    authFail(res, err)
  }
})

syncRouter.post('/peer/progress', (req, res) => {
  try {
    reportPeerProgress(bearer(req), (req.body ?? {}) as Record<string, never>)
    res.json({ ok: true })
  } catch (err) {
    authFail(res, err)
  }
})

/** "I paired but I'm not pulling after all" — puts the share back to listening. */
syncRouter.post('/peer/release', (req, res) => {
  try {
    releaseShare(bearer(req))
    res.json({ ok: true })
  } catch (err) {
    authFail(res, err)
  }
})

syncRouter.post('/peer/done', (req, res) => {
  try {
    finishShare(bearer(req), {
      ok: req.body?.ok === true,
      summary: typeof req.body?.summary === 'string' ? req.body.summary.slice(0, 4000) : '',
      error: typeof req.body?.error === 'string' ? req.body.error.slice(0, 500) : undefined,
    })
    res.json({ ok: true })
  } catch (err) {
    authFail(res, err)
  }
})

// ------------------------------------------------------------------ host

/** The group catalog + who this machine is. Static; the picker is drawn from it. */
syncRouter.get('/groups', (_req, res) => {
  res.json({ groups: SYNC_GROUPS, self: machineIdentity() })
})

/**
 * Everything the share side draws, including whether there is a public URL to hand
 * over. The tunnel is read here rather than in the page so "Open to AI Sync" and
 * "you have no endpoint to give them yet" are one answer, not two races.
 */
syncRouter.get('/share', localOnly, (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : ''
  const tunnel = readTunnelStatus()
  res.json({
    share: projectId ? readShare(projectId) : null,
    self: machineIdentity(),
    endpoint: tunnel.state === 'running' ? tunnel.url : null,
    tunnelState: tunnel.state,
    tunnelInstalled: tunnel.installed,
    hasAccessPassword: tunnel.hasAccessPassword,
  })
})

/** Every open share, for the always-mounted watcher that raises the blocking panel. */
syncRouter.get('/shares', localOnly, (_req, res) => {
  res.json({ shares: listShares() })
})

syncRouter.post('/share', localOnly, (req, res) => {
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : ''
  if (!projectId) return res.status(400).json({ error: 'projectId is required' })
  try {
    const share = openShare({
      projectId,
      groups: Array.isArray(req.body?.groups) ? (req.body.groups as unknown[]).map(String) : undefined,
      includeMcpSecrets: req.body?.includeMcpSecrets === true,
      ttlMinutes: req.body?.ttlMinutes === undefined ? undefined : Number(req.body.ttlMinutes),
    })
    res.status(201).json({ share })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

syncRouter.delete('/share', localOnly, (req, res) => {
  const projectId =
    (typeof req.body?.projectId === 'string' && req.body.projectId) ||
    (typeof req.query.projectId === 'string' && req.query.projectId) ||
    ''
  if (!projectId) return res.status(400).json({ error: 'projectId is required' })
  closeShare(projectId)
  res.json({ ok: true })
})

// ------------------------------------------------------------------ guest

syncRouter.post('/connect', localOnly, async (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : ''
  const code = typeof req.body?.code === 'string' ? req.body.code : ''
  try {
    res.status(201).json({ job: await connectSync(endpoint, code) })
  } catch (err) {
    const status = err instanceof SyncAuthError ? err.status : 400
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

syncRouter.post('/jobs/:id/start', localOnly, (req, res) => {
  const groups = Array.isArray(req.body?.groups) ? (req.body.groups as unknown[]).map(String) : []
  const raw = req.body?.target ?? {}
  const target: SyncTarget =
    raw.mode === 'existing'
      ? { mode: 'existing', projectId: String(raw.projectId ?? '') }
      : { mode: 'new', name: String(raw.name ?? ''), parentPath: String(raw.parentPath ?? '') }
  try {
    res.json({ job: startSync(req.params.id, groups, target) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

syncRouter.get('/jobs', localOnly, (_req, res) => {
  res.json({ jobs: listSyncJobs() })
})

/** What the guest's blocking panel polls — one call whether or not anything is running. */
syncRouter.get('/active', localOnly, (_req, res) => {
  res.json({ job: activeSyncJob() })
})

syncRouter.get('/jobs/:id', localOnly, (req, res) => {
  const job = getSyncJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'sync job not found' })
  res.json({ job })
})

syncRouter.post('/jobs/:id/cancel', localOnly, (req, res) => {
  res.json({ ok: cancelSyncJob(req.params.id), job: getSyncJob(req.params.id) })
})

syncRouter.post('/jobs/:id/dismiss', localOnly, (req, res) => {
  dismissSyncJob(req.params.id)
  res.json({ ok: true })
})
