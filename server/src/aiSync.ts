// AI Sync — the HOST half. Machine A publishes ONE project, behind a 4-digit
// pairing code, so machine B can pull its QC artifacts over the Cloudflare Tunnel.
//
// ---------------------------------------------------------------- why a second door
//
// Everything else the portal exposes through the tunnel sits behind the access gate
// in `remoteAccess.ts`: a >=10-character password, and nothing at all — not even the
// JS bundle — until it verifies. AI Sync deliberately puts a SECOND, much narrower
// door beside it, because the thing being asked for is different: a QC engineer wants
// to read four digits off a colleague's screen, not to hand over the password that
// unlocks a shell on their laptop.
//
// A 4-digit code is 10,000 possibilities, which is nothing if it can be guessed in a
// loop. So the door is not the code alone — it is the code PLUS all of this, and none
// of it may be dropped on the assumption another part is enough:
//
//   * Nothing exists until the owner opens it. With no share session, every peer
//     endpoint answers 404 — the surface is absent, not merely denied.
//   * One project. A session names one projectId and the manifest is built from it;
//     there is no "list projects", no path parameter, and no way to name another.
//   * One shot at a time. A session leaves `waiting` the moment it pairs, and a
//     paired session refuses further pairing — so the race a guesser needs is a race
//     against a human who is watching a screen that says "connected".
//   * FIVE wrong codes REVOKE the session outright (not a timed lockout — revocation).
//     The owner has to re-open it, which regenerates the code. An attacker therefore
//     gets 5 of 10,000 per opening, with a person watching the failures arrive.
//   * TTL. A session that nobody pairs with dies (default 15 minutes).
//   * Read-only, and only what the manifest lists. File bytes are served from the
//     exact path set the manifest was built from, resolved and re-checked under the
//     project root. There is no write path in this module at all — the guest writes
//     to ITS own disk, on its own machine, under its own path guard.
//   * Credentials do not travel by default. `.mcp.json` carries API keys; its env
//     values are blanked unless the owner explicitly ticks "include credentials", and
//     the manifest hashes the SCRUBBED bytes so what is advertised is what is sent.
//
// What this module never does: touch the access gate's settings, serve anything
// outside one project root, accept a file, spawn a process, or read the stores that
// live beside the DB (TOTP seeds, API accounts, remote-access.json). Those are not
// in any group and cannot be named.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureSyncKey, getProject } from './db.js'

// ------------------------------------------------------------------ what can be synced

/**
 * A selectable slice of a project. `entries` are root-relative paths — a file or a
 * directory; a directory is walked recursively.
 *
 * The list is deliberately an ALLOW-LIST of the QC artifacts, not "the folder minus
 * some exclusions": the project root is a real repo on someone's machine, and a sync
 * that defaulted to everything would ship source code, `.env` files and `.git` across
 * the internet the first time somebody registered a project they had not tidied.
 */
export interface SyncGroupDef {
  key: string
  label: string
  /** One line, shown under the checkbox — what the QC engineer is actually agreeing to send. */
  description: string
  entries: string[]
  /** Marked in the UI as potentially very large (run evidence: screenshots, video). */
  heavy?: boolean
}

export const SYNC_GROUPS: readonly SyncGroupDef[] = [
  {
    key: 'instructions',
    label: 'Instructions & overview',
    description: 'CLAUDE.md and the project overview documents.',
    entries: ['CLAUDE.md', 'testing/overview'],
  },
  {
    key: 'skills',
    label: 'Skills',
    description: 'The .claude/skills folder — qc-testing and any custom skill.',
    entries: ['.claude/skills'],
  },
  {
    key: 'mcp',
    label: 'MCP servers',
    description: '.mcp.json. API keys are blanked unless you tick "include credentials".',
    entries: ['.mcp.json'],
  },
  {
    key: 'tickets',
    label: 'Tickets',
    description: 'Crawled tickets and their attachments.',
    entries: ['testing/tickets'],
  },
  {
    key: 'testcases',
    label: 'Test cases',
    description: 'Generated manual test cases.',
    entries: ['testing/test-cases'],
  },
  {
    key: 'results',
    label: 'Run results & evidence',
    description: 'Reports, issue logs and screenshots from QC runs.',
    entries: ['testing/test-result'],
    heavy: true,
  },
  {
    key: 'knowledge',
    label: 'Knowledge & memory',
    description: 'What the AI has learned about this project.',
    entries: ['testing/knowledge', 'testing/memory'],
  },
  {
    key: 'notes',
    label: 'Notes',
    description: 'The Notes page.',
    entries: ['testing/notes'],
  },
  {
    key: 'templates',
    label: 'Templates',
    description: 'Project report / test-case templates.',
    entries: ['testing/templates'],
  },
  {
    key: 'apitests',
    label: 'API tests',
    description: 'Saved API requests and flows.',
    entries: ['testing/api-tests'],
  },
  {
    key: 'diagrams',
    label: 'Diagrams',
    description: 'Saved Mermaid diagrams.',
    entries: ['testing/diagrams'],
  },
  {
    key: 'prototypes',
    label: 'Prototypes',
    description: 'Prototype builds, revisions and the design system.',
    entries: ['testing/prototypes'],
    heavy: true,
  },
  {
    key: 'chats',
    label: 'Chat history',
    description: 'Saved /chat conversations.',
    entries: ['testing/chats'],
  },
] as const

export const ALL_GROUP_KEYS: readonly string[] = SYNC_GROUPS.map((g) => g.key)

/** Never walked into, never sent — the same set the .zip export refuses. */
const WALK_SKIP = new Set(['.DS_Store', 'node_modules', '.git', 'Thumbs.db'])

/** The one file whose CONTENT is rewritten before it is hashed or sent. */
const MCP_FILE = '.mcp.json'

// ------------------------------------------------------------------ machine identity

export interface MachineIdentity {
  /** Stable per machine+user, so the two sides can tell "the same peer" from "another one". */
  id: string
  /** `os.hostname()` — what a person recognises. */
  name: string
  platform: string
  /** First non-internal IPv4, for the endpoint hint and for telling two same-named hosts apart. */
  ip: string
}

function lanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return ''
}

let identity: MachineIdentity | null = null

export function machineIdentity(): MachineIdentity {
  if (identity) return identity
  const name = os.hostname().replace(/\.local$/i, '')
  identity = {
    // Hashed rather than raw: this travels to the other machine, and a username plus a
    // hostname is more than the other side needs in order to say "same laptop as before".
    id: crypto
      .createHash('sha256')
      .update(`${os.hostname()}|${os.userInfo().username}`)
      .digest('hex')
      .slice(0, 12),
    name,
    platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
    ip: lanIp(),
  }
  return identity
}

// ------------------------------------------------------------------ the manifest

export interface ManifestEntry {
  /** Root-relative, POSIX slashes — the transfer format, so Windows and macOS agree. */
  path: string
  group: string
  size: number
  /** sha256 of the bytes that will actually be SERVED (see the .mcp.json note). */
  sha256: string
  mtime: string
}

export interface SyncManifest {
  projectName: string
  /** Identity that survives a rename — how the guest recognises "I already have this project". */
  syncKey: string
  host: MachineIdentity
  groups: string[]
  entries: ManifestEntry[]
  totalBytes: number
  /** True when `.mcp.json` was scrubbed, so the guest can say so instead of silently breaking MCP. */
  mcpScrubbed: boolean
  builtAt: string
}

const toPosix = (p: string): string => p.split(path.sep).join('/')

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel)
  let stat: fs.Stats
  try {
    stat = fs.statSync(abs)
  } catch {
    return // the entry simply isn't in this project
  }
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs)) {
      if (WALK_SKIP.has(name)) continue
      walk(root, path.join(rel, name), out)
    }
  } else if (stat.isFile()) {
    out.push(toPosix(rel))
  }
}

/**
 * Blank every env value in a `.mcp.json` while keeping its KEYS, so the guest sees
 * which variables it must fill in rather than a server that silently starts without
 * credentials. Anything unparseable is refused rather than forwarded — a file we
 * cannot read is a file we cannot promise carries no secret.
 */
export function scrubMcpJson(raw: string): string {
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, { env?: Record<string, string>; headers?: Record<string, string> }> }
  for (const server of Object.values(parsed.mcpServers ?? {})) {
    for (const bag of [server.env, server.headers]) {
      if (!bag) continue
      for (const key of Object.keys(bag)) bag[key] = ''
    }
  }
  return JSON.stringify(parsed, null, 2)
}

/**
 * The exact bytes served for one manifest path. Everything is read straight off disk
 * except `.mcp.json`, which is scrubbed first when credentials are not being shared —
 * and is hashed from THIS function's output, so the manifest never advertises a digest
 * for content the guest will not receive.
 */
function servedBytes(root: string, rel: string, includeMcpSecrets: boolean): Buffer {
  const abs = path.join(root, rel)
  if (rel === MCP_FILE && !includeMcpSecrets) {
    try {
      return Buffer.from(scrubMcpJson(fs.readFileSync(abs, 'utf8')), 'utf8')
    } catch {
      // Unreadable or not JSON: send an empty server map rather than the raw file.
      return Buffer.from(JSON.stringify({ mcpServers: {} }, null, 2), 'utf8')
    }
  }
  return fs.readFileSync(abs)
}

export function buildManifest(
  root: string,
  projectName: string,
  syncKey: string,
  groups: readonly string[],
  includeMcpSecrets: boolean,
): SyncManifest {
  const wanted = new Set(groups)
  const entries: ManifestEntry[] = []
  const seen = new Set<string>()
  let totalBytes = 0
  let mcpScrubbed = false

  for (const group of SYNC_GROUPS) {
    if (!wanted.has(group.key)) continue
    const found: string[] = []
    for (const entry of group.entries) walk(root, entry, found)
    for (const rel of found) {
      if (seen.has(rel)) continue // a path belongs to the first group that claims it
      seen.add(rel)
      let buf: Buffer
      let mtime: Date
      try {
        buf = servedBytes(root, rel, includeMcpSecrets)
        mtime = fs.statSync(path.join(root, rel)).mtime
      } catch {
        continue // vanished between the walk and the read
      }
      if (rel === MCP_FILE && !includeMcpSecrets) mcpScrubbed = true
      entries.push({
        path: rel,
        group: group.key,
        size: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        mtime: mtime.toISOString(),
      })
      totalBytes += buf.length
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))
  return {
    projectName,
    syncKey,
    host: machineIdentity(),
    groups: [...wanted],
    entries,
    totalBytes,
    mcpScrubbed,
    builtAt: new Date().toISOString(),
  }
}

// ------------------------------------------------------------------ the share session

export type ShareState = 'waiting' | 'paired' | 'syncing' | 'done' | 'error' | 'revoked'

/** How far the GUEST has got — pushed up by the guest so the host's blocking overlay is live. */
export interface SharePeerProgress {
  phase: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  message: string
}

interface ShareSession {
  id: string
  projectId: string
  projectName: string
  syncKey: string
  rootPath: string
  code: string
  /** HMAC key for this session's bearer tokens. Dies with the session. */
  secret: string
  state: ShareState
  offeredGroups: string[]
  includeMcpSecrets: boolean
  createdAt: number
  expiresAt: number
  /** Wrong codes seen, in total. Five revokes the session. */
  failures: number
  peer: (MachineIdentity & { pairedAt: string }) | null
  /** Built at pair time from the groups the guest asked for — also the ALLOW-LIST for file reads. */
  manifest: SyncManifest | null
  servedPaths: Set<string>
  progress: SharePeerProgress | null
  filesServed: number
  bytesServed: number
  error: string | null
  finishedAt: string | null
  /** An AI summary the guest wrote and handed back, so the host sees what left the machine. */
  summary: string
}

/** Wrong codes tolerated before the whole session is revoked. See the module note. */
export const MAX_CODE_FAILURES = 5
const DEFAULT_TTL_MIN = 15
const MAX_TTL_MIN = 120

const sessions = new Map<string, ShareSession>() // by session id
const byProject = new Map<string, string>() // projectId -> session id

/** What the host's own page is allowed to see — includes the code, since it is the owner. */
export interface ShareView {
  id: string
  projectId: string
  projectName: string
  code: string
  state: ShareState
  offeredGroups: string[]
  includeMcpSecrets: boolean
  expiresAt: string
  failures: number
  maxFailures: number
  host: MachineIdentity
  peer: (MachineIdentity & { pairedAt: string }) | null
  progress: SharePeerProgress | null
  filesServed: number
  bytesServed: number
  totalBytes: number
  filesTotal: number
  summary: string
  error: string | null
  finishedAt: string | null
}

function toView(s: ShareSession): ShareView {
  return {
    id: s.id,
    projectId: s.projectId,
    projectName: s.projectName,
    code: s.code,
    state: s.state,
    offeredGroups: s.offeredGroups,
    includeMcpSecrets: s.includeMcpSecrets,
    expiresAt: new Date(s.expiresAt).toISOString(),
    failures: s.failures,
    maxFailures: MAX_CODE_FAILURES,
    host: machineIdentity(),
    peer: s.peer,
    progress: s.progress,
    filesServed: s.filesServed,
    bytesServed: s.bytesServed,
    totalBytes: s.manifest?.totalBytes ?? 0,
    filesTotal: s.manifest?.entries.length ?? 0,
    summary: s.summary,
    error: s.error,
    finishedAt: s.finishedAt,
  }
}

/**
 * Expire a session that nobody paired with. A session that is mid-transfer is NOT
 * expired: a 2 GB pull legitimately outlives the pairing window, and dropping it
 * halfway is worse than holding the door for the peer that is already inside.
 */
function prune(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    const inFlight = s.state === 'syncing'
    if (!inFlight && now > s.expiresAt) {
      sessions.delete(id)
      if (byProject.get(s.projectId) === id) byProject.delete(s.projectId)
    }
  }
}

/** A 4-digit code, uniformly distributed (`% 10000` on a random byte range is not). */
function newCode(): string {
  return String(crypto.randomInt(0, 10_000)).padStart(4, '0')
}

export function openShare(opts: {
  projectId: string
  groups?: readonly string[]
  includeMcpSecrets?: boolean
  ttlMinutes?: number
}): ShareView {
  prune()
  const project = getProject(opts.projectId)
  if (!project) throw new Error('project not found')
  if (!fs.existsSync(project.rootPath)) {
    throw new Error('This project’s folder is missing on disk, so there is nothing to share.')
  }
  // Re-opening replaces the old session: the code changes, and anything already paired
  // against the old one stops verifying. That is what "close and share again" must mean.
  closeShare(opts.projectId)

  const requested = (opts.groups ?? ALL_GROUP_KEYS).filter((g) => ALL_GROUP_KEYS.includes(g))
  const ttl = Math.min(MAX_TTL_MIN, Math.max(1, Math.round(opts.ttlMinutes ?? DEFAULT_TTL_MIN)))
  const session: ShareSession = {
    id: crypto.randomUUID(),
    projectId: project.id,
    projectName: project.name,
    syncKey: ensureSyncKey(project.id),
    rootPath: project.rootPath,
    code: newCode(),
    secret: crypto.randomBytes(32).toString('hex'),
    state: 'waiting',
    offeredGroups: requested.length ? requested : [...ALL_GROUP_KEYS],
    includeMcpSecrets: opts.includeMcpSecrets === true,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl * 60_000,
    failures: 0,
    peer: null,
    manifest: null,
    servedPaths: new Set(),
    progress: null,
    filesServed: 0,
    bytesServed: 0,
    error: null,
    finishedAt: null,
    summary: '',
  }
  sessions.set(session.id, session)
  byProject.set(project.id, session.id)
  return toView(session)
}

export function readShare(projectId: string): ShareView | null {
  prune()
  const id = byProject.get(projectId)
  const s = id ? sessions.get(id) : undefined
  return s ? toView(s) : null
}

/** Every open share, so the always-mounted watcher can find one without knowing the project. */
export function listShares(): ShareView[] {
  prune()
  return [...sessions.values()].map(toView)
}

export function closeShare(projectId: string): void {
  const id = byProject.get(projectId)
  if (!id) return
  sessions.delete(id)
  byProject.delete(projectId)
}

// ------------------------------------------------------------------ pairing & tokens

/**
 * `<sessionId>.<expiry>.<hmac>` — verified against the session's own secret, so
 * closing the share (or re-opening it) invalidates every token it ever issued.
 */
function issueToken(s: ShareSession): string {
  const expiry = s.expiresAt
  const mac = crypto.createHmac('sha256', s.secret).update(`${s.id}.${expiry}`).digest('hex')
  return `${s.id}.${expiry}.${mac}`
}

function sessionForToken(token: string | undefined): ShareSession | null {
  if (!token) return null
  const [id, expiryPart, mac] = token.split('.')
  const s = id ? sessions.get(id) : undefined
  if (!s || !mac) return null
  // An in-flight transfer keeps its token past the pairing TTL for the same reason
  // `prune` keeps the session: a long pull must not be cut off halfway.
  if (Number(expiryPart) <= Date.now() && s.state !== 'syncing') return null
  const expected = crypto.createHmac('sha256', s.secret).update(`${id}.${expiryPart}`).digest('hex')
  if (mac.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  return s
}

export class SyncAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly revoked = false,
  ) {
    super(message)
    this.name = 'SyncAuthError'
  }
}

/** What a freshly paired guest learns. Deliberately nothing about the machine itself. */
export interface PairResult {
  token: string
  expiresAt: string
  projectName: string
  syncKey: string
  host: MachineIdentity
  offeredGroups: string[]
  includeMcpSecrets: boolean
}

export function pair(code: string, peer: MachineIdentity): PairResult {
  prune()
  // One open share at a time is the normal case; when several are open the code picks
  // which. A code that matches nothing burns an attempt on EVERY open session, so
  // opening a second share does not hand an attacker a second budget.
  const open = [...sessions.values()].filter((s) => s.state === 'waiting')
  if (open.length === 0) {
    throw new SyncAuthError('No project is open for AI Sync on that portal right now.', 404)
  }

  const digits = (code ?? '').trim()
  const match = open.find(
    (s) =>
      s.code.length === digits.length &&
      crypto.timingSafeEqual(Buffer.from(s.code), Buffer.from(digits.padEnd(s.code.length))),
  )

  if (!match) {
    let revoked = false
    for (const s of open) {
      s.failures += 1
      if (s.failures >= MAX_CODE_FAILURES) {
        s.state = 'revoked'
        s.error = 'Revoked after too many wrong codes. Open the share again on the host machine.'
        revoked = true
      }
    }
    throw new SyncAuthError(
      revoked
        ? 'Wrong code — too many attempts, so the share was revoked. Ask for a new code.'
        : 'Wrong code.',
      401,
      revoked,
    )
  }

  match.state = 'paired'
  match.peer = { ...peer, pairedAt: new Date().toISOString() }
  match.failures = 0
  return {
    token: issueToken(match),
    expiresAt: new Date(match.expiresAt).toISOString(),
    projectName: match.projectName,
    syncKey: match.syncKey,
    host: machineIdentity(),
    offeredGroups: match.offeredGroups,
    includeMcpSecrets: match.includeMcpSecrets,
  }
}

function authed(token: string | undefined): ShareSession {
  const s = sessionForToken(token)
  if (!s) throw new SyncAuthError('This sync session is no longer valid. Pair again.', 401)
  if (s.state === 'revoked') throw new SyncAuthError(s.error ?? 'This sync session was revoked.', 403)
  return s
}

/**
 * Build (and remember) the manifest for a paired guest. The path set it produces is
 * the ONLY thing `readSharedFile` will serve — so a guest cannot name a path the
 * owner's group choice did not include, whatever it sends.
 */
export function manifestFor(token: string | undefined, groups: readonly string[]): SyncManifest {
  const s = authed(token)
  const allowed = new Set(s.offeredGroups)
  const wanted = groups.filter((g) => allowed.has(g))
  const manifest = buildManifest(
    s.rootPath,
    s.projectName,
    s.syncKey,
    wanted.length ? wanted : s.offeredGroups,
    s.includeMcpSecrets,
  )
  s.manifest = manifest
  s.servedPaths = new Set(manifest.entries.map((e) => e.path))
  s.state = 'syncing'
  s.progress = {
    phase: 'manifest',
    filesDone: 0,
    filesTotal: manifest.entries.length,
    bytesDone: 0,
    bytesTotal: manifest.totalBytes,
    message: 'Comparing files…',
  }
  return manifest
}

/** The bytes for one manifest path, or a SyncAuthError. Read-only by construction. */
export function readSharedFile(token: string | undefined, rel: string): Buffer {
  const s = authed(token)
  const wanted = (rel ?? '').replace(/\\/g, '/')
  if (!s.servedPaths.has(wanted)) {
    throw new SyncAuthError('That file is not part of this sync.', 403)
  }
  // Belt and braces: the allow-list already decided this, but the path still has to
  // resolve inside the project root before anything is read off disk.
  const abs = path.resolve(s.rootPath, wanted)
  const root = path.resolve(s.rootPath)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new SyncAuthError('That file is not part of this sync.', 403)
  }
  const buf = servedBytes(s.rootPath, wanted, s.includeMcpSecrets)
  s.filesServed += 1
  s.bytesServed += buf.length
  return buf
}

export function reportPeerProgress(token: string | undefined, progress: Partial<SharePeerProgress>): void {
  const s = authed(token)
  if (s.state === 'paired') s.state = 'syncing'
  s.progress = {
    phase: progress.phase ?? s.progress?.phase ?? 'transfer',
    filesDone: progress.filesDone ?? s.progress?.filesDone ?? 0,
    filesTotal: progress.filesTotal ?? s.progress?.filesTotal ?? 0,
    bytesDone: progress.bytesDone ?? s.progress?.bytesDone ?? 0,
    bytesTotal: progress.bytesTotal ?? s.progress?.bytesTotal ?? 0,
    message: progress.message ?? s.progress?.message ?? '',
  }
}

/**
 * The guest paired, looked at what was on offer, and walked away without starting.
 *
 * Re-opens the pairing window rather than killing the session: the code is unchanged
 * and the failure budget is untouched, so this is exactly equivalent to never having
 * paired — which is what "I changed my mind" should cost. Without it the host sits
 * showing a half-connected peer until the TTL runs out.
 */
export function releaseShare(token: string | undefined): void {
  const s = sessionForToken(token)
  if (!s || s.state !== 'paired') return
  s.state = 'waiting'
  s.peer = null
  s.progress = null
}

/**
 * The guest says it is finished. The session is KEPT (state `done`/`error`) rather
 * than deleted so the host's blocking overlay can show the outcome — the host closes
 * it by dismissing that panel.
 */
export function finishShare(
  token: string | undefined,
  outcome: { ok: boolean; summary?: string; error?: string },
): void {
  const s = authed(token)
  s.state = outcome.ok ? 'done' : 'error'
  s.error = outcome.ok ? null : (outcome.error ?? 'The sync failed on the other machine.')
  s.summary = outcome.summary ?? ''
  s.finishedAt = new Date().toISOString()
}

/** Format bytes for a log line / a progress caption. Shared by both halves. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
