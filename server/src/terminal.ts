import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'node:module'
import type { IncomingMessage } from 'node:http'
import type { WebSocket } from 'ws'
import { CLAUDE_BIN } from './config.js'
import { getDefaultProject, getProject, getRun, getRunSession, listProjects } from './db.js'
import { spawnEnv } from './toolPath.js'

// node-pty is a native module shipped with prebuilt binaries. Load it lazily and
// defensively: if its binding can't load (unsupported platform, broken prebuild),
// the rest of the portal must still boot — only the Terminal page is affected.
const require = createRequire(import.meta.url)
type PtyModule = typeof import('node-pty')
let ptyModule: PtyModule | null = null
let ptyLoadError: string | null = null

/**
 * node-pty's macOS/Linux prebuild ships a `spawn-helper` executable that must
 * have the exec bit set, but some npm/tarball extractions strip it — which then
 * surfaces at spawn time as `posix_spawnp failed`. Re-assert +x idempotently on
 * posix before the first spawn so a fresh install works without manual chmod.
 */
function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return
  try {
    const helper = require.resolve(
      `node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    )
    fs.chmodSync(helper, 0o755)
  } catch {
    // Not all builds use a separate helper (e.g. compiled-from-source); ignore.
  }
}

function loadPty(): PtyModule {
  if (ptyModule) return ptyModule
  ensureSpawnHelperExecutable()
  ptyModule = require('node-pty') as PtyModule
  return ptyModule
}

export function terminalAvailable(): { ok: boolean; error?: string } {
  if (ptyModule) return { ok: true }
  try {
    loadPty()
    return { ok: true }
  } catch (err) {
    ptyLoadError = err instanceof Error ? err.message : String(err)
    return { ok: false, error: ptyLoadError }
  }
}

// The user's interactive login shell — what "open a terminal" means on this box.
function resolveShell(): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'powershell.exe', args: [] }
  }
  // -l so the shell sources the user's profile (PATH, aliases) like a real terminal.
  return { file: process.env.SHELL || '/bin/bash', args: ['-l'] }
}

// Interactive `claude --resume <id>`, so .cmd resolves and stays interactive on
// Windows; spawned directly elsewhere. The user drives it like a real terminal.
function resolveClaudeResume(sessionId: string): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', CLAUDE_BIN, '--resume', sessionId] }
  }
  return { file: CLAUDE_BIN, args: ['--resume', sessionId] }
}

function projectRoot(projectId: string): string | undefined {
  const project = projectId ? getProject(projectId) : getDefaultProject() ?? listProjects()[0]
  return project?.rootPath
}

/**
 * Decide what this terminal runs. With `?runId=…` it resumes that run's Claude
 * session interactively (cwd = the run's project root); otherwise it opens the
 * user's plain login shell (cwd = the requested/active project, else home).
 * Returns an `error` instead of a command when a runId can't be resumed.
 */
function resolveTarget(req: IncomingMessage):
  | { file: string; args: string[]; cwd: string }
  | { error: string } {
  const url = new URL(req.url ?? '', 'http://localhost')
  const runId = url.searchParams.get('runId') ?? ''

  if (runId) {
    const run = getRun(runId)
    if (!run) return { error: `Run ${runId} not found.` }
    const sessionId = getRunSession(runId)
    if (!sessionId) {
      return { error: 'This run has no saved Claude session, so it cannot be continued.' }
    }
    const root = run.projectId ? projectRoot(run.projectId) : undefined
    const cwd = root && fs.existsSync(root) ? root : os.homedir()
    return { ...resolveClaudeResume(sessionId), cwd }
  }

  const root = projectRoot(url.searchParams.get('projectId') ?? '')
  const cwd = root && fs.existsSync(root) ? root : os.homedir()
  return { ...resolveShell(), cwd }
}

/**
 * Identity of the shell behind a connection, so a reconnect finds the SAME pty
 * instead of spawning a new one: one persistent shell per project **per terminal
 * tab** (`?tab=`, so the page can run several side by side), and one per resumable
 * run. Navigating away from the Terminal page closes the socket but must not close
 * the shell — see the session registry below.
 */
function sessionKey(req: IncomingMessage): string {
  const url = new URL(req.url ?? '', 'http://localhost')
  const runId = url.searchParams.get('runId') ?? ''
  if (runId) return `run:${runId}`
  const tab = url.searchParams.get('tab') ?? ''
  return `shell:${url.searchParams.get('projectId') ?? ''}${tab ? `#${tab}` : ''}`
}

function parseSize(req: IncomingMessage): { cols: number; rows: number } {
  const url = new URL(req.url ?? '', 'http://localhost')
  const cols = Number(url.searchParams.get('cols'))
  const rows = Number(url.searchParams.get('rows'))
  return {
    cols: Number.isFinite(cols) && cols > 0 ? Math.min(cols, 500) : 80,
    rows: Number.isFinite(rows) && rows > 0 ? Math.min(rows, 200) : 24,
  }
}

/**
 * Live pseudo-terminals, keyed by `sessionKey`. A pty OUTLIVES the WebSocket that
 * started it: closing the socket (leaving the Terminal page, a reload, a dropped
 * connection) only DETACHES, so the shell — and anything running in it, e.g. an
 * interactive `claude` — keeps running and the next connection re-attaches to it.
 *
 * A session only dies when: the user explicitly ends it ({type:'kill'}), the shell
 * itself exits, it sits detached past IDLE_MS, it's evicted to respect MAX_SESSIONS,
 * or the server shuts down (`killAllTerminalSessions`).
 */
interface TerminalSession {
  key: string
  pty: import('node-pty').IPty
  /** Recent output, replayed on re-attach so the user sees where they left off. */
  buffer: string[]
  bufferBytes: number
  /** The attached socket, or null while detached (shell still running). */
  ws: WebSocket | null
  onData: { dispose(): void }
  onExit: { dispose(): void }
  exited: boolean
  startedAt: number
  lastActivityAt: number
  idleTimer: NodeJS.Timeout | null
  meta: { kind: 'shell' | 'resume'; projectId?: string; tab?: string; runId?: string; cwd: string }
}

const sessions = new Map<string, TerminalSession>()
const MAX_BUFFER_BYTES = 256 * 1024 // replay context, not a full scrollback
const IDLE_MS = 6 * 60 * 60 * 1000 // a shell nobody came back to
const MAX_SESSIONS = 16 // don't accumulate forgotten shells (several tabs × projects)
/** Close code for "another window attached to this session" (app-specific range). */
export const WS_CLOSE_TAKEN_OVER = 4001

function send(ws: WebSocket | null, data: string): void {
  if (!ws) return
  try {
    ws.send(data)
  } catch {
    /* socket gone */
  }
}

/**
 * Forget a viewer whose socket is no longer open. A `close` event can be missed (a
 * socket kicked in favour of a newer one, a browser window that went away abruptly),
 * and a session that still *looks* attached is worse than useless: the UI reports
 * "open in another window" and refuses to re-attach a shell nobody is watching.
 */
function pruneDeadViewer(s: TerminalSession): void {
  if (!s.ws) return
  const state = s.ws.readyState as number
  if (state === 0 || state === 1) return // CONNECTING / OPEN → a real viewer
  s.ws = null
  if (!s.exited && !s.idleTimer) {
    s.idleTimer = setTimeout(() => destroySession(s.key), IDLE_MS)
    s.idleTimer.unref()
  }
}

/** Destroy a session for good: stop listening, kill the process tree, forget it. */
function destroySession(key: string): void {
  const s = sessions.get(key)
  if (!s) return
  sessions.delete(key)
  if (s.idleTimer) clearTimeout(s.idleTimer)
  s.onData.dispose()
  s.onExit.dispose()
  if (!s.exited) killPtyTree(s.pty)
}

/** Kill every live terminal on shutdown so no shell (or MCP child) is orphaned. */
export function killAllTerminalSessions(): number {
  const keys = [...sessions.keys()]
  for (const key of keys) destroySession(key)
  return keys.length
}

/** What's alive right now — the Terminal page uses this to re-attach on arrival. */
export function listTerminalSessions(): {
  key: string
  kind: 'shell' | 'resume'
  projectId?: string
  tab?: string
  runId?: string
  cwd: string
  attached: boolean
  startedAt: string
  lastActivityAt: string
}[] {
  for (const s of sessions.values()) pruneDeadViewer(s)
  return [...sessions.values()]
    .filter((s) => !s.exited)
    .map((s) => ({
      key: s.key,
      kind: s.meta.kind,
      projectId: s.meta.projectId,
      tab: s.meta.tab,
      runId: s.meta.runId,
      cwd: s.meta.cwd,
      attached: s.ws != null,
      startedAt: new Date(s.startedAt).toISOString(),
      lastActivityAt: new Date(s.lastActivityAt).toISOString(),
    }))
}

/** Free a slot by dropping the shell nobody has touched for longest, if any. */
function evictIfNeeded(): void {
  if (sessions.size < MAX_SESSIONS) return
  const detached = [...sessions.values()]
    .filter((s) => s.ws == null)
    .sort((a, b) => a.lastActivityAt - b.lastActivityAt)
  if (detached[0]) destroySession(detached[0].key)
}

function appendToBuffer(s: TerminalSession, data: string): void {
  s.buffer.push(data)
  s.bufferBytes += data.length
  while (s.bufferBytes > MAX_BUFFER_BYTES && s.buffer.length > 1) {
    s.bufferBytes -= s.buffer.shift()!.length
  }
}

function resizePty(s: TerminalSession, cols: number, rows: number): void {
  try {
    s.pty.resize(Math.max(1, Math.min(cols, 500)), Math.max(1, Math.min(rows, 200)))
  } catch {
    /* resize on a dead pty — ignore */
  }
}

/**
 * Point a socket at an existing session: kick whatever was attached before (one
 * viewer at a time), resize the shell to this client's window, replay the recent
 * output so the screen isn't blank, and wire input/resize/kill.
 */
function attach(s: TerminalSession, ws: WebSocket, size: { cols: number; rows: number }): void {
  pruneDeadViewer(s) // never "take over" from a socket that is already gone
  if (s.ws && s.ws !== ws) {
    const previous = s.ws
    s.ws = null
    send(previous, '\r\n\x1b[90m[this session was taken over by another window]\x1b[0m\r\n')
    try {
      // A dedicated close code, NOT a generic close: the kicked client must be able
      // to tell "someone took this over" from "my connection dropped". Without it,
      // two windows on this page each re-attach on every drop and flap forever.
      previous.close(WS_CLOSE_TAKEN_OVER, 'taken-over')
    } catch {
      /* ignore */
    }
  }
  s.ws = ws
  if (s.idleTimer) {
    clearTimeout(s.idleTimer)
    s.idleTimer = null
  }
  s.lastActivityAt = Date.now()

  resizePty(s, size.cols, size.rows)
  if (s.buffer.length) {
    send(ws, s.buffer.join(''))
    send(ws, '\r\n\x1b[90m[re-attached — this session kept running]\x1b[0m\r\n')
  }

  ws.on('message', (raw) => {
    let msg: unknown
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    const m = msg as { type?: string; data?: string; cols?: number; rows?: number }
    if (m.type === 'input' && typeof m.data === 'string') {
      s.lastActivityAt = Date.now()
      try {
        s.pty.write(m.data)
      } catch {
        /* dead pty */
      }
    } else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      resizePty(s, m.cols, m.rows)
    } else if (m.type === 'kill') {
      // Explicit "end this session" from the UI's Disconnect button — as opposed to
      // a socket that merely closed, which keeps the shell alive.
      destroySession(s.key)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  })

  // Socket gone ≠ session gone: detach and start the idle countdown.
  const detach = () => {
    if (s.ws !== ws) return
    s.ws = null
    s.lastActivityAt = Date.now()
    if (sessions.get(s.key) === s && !s.exited && !s.idleTimer) {
      s.idleTimer = setTimeout(() => destroySession(s.key), IDLE_MS)
      s.idleTimer.unref()
    }
  }
  ws.on('close', detach)
  ws.on('error', detach)
}

/**
 * Bridge a WebSocket to its pseudo-terminal — re-attaching to the session already
 * running for this project/run, or spawning one on the first connection. Server→
 * client frames are raw terminal bytes; client→server frames are JSON control
 * messages ({type:'input'|'resize'|'kill'}).
 */
export function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): void {
  const key = sessionKey(req)
  const size = parseSize(req)

  const existing = sessions.get(key)
  if (existing && !existing.exited) {
    attach(existing, ws, size)
    return
  }

  const target = resolveTarget(req)
  if ('error' in target) {
    send(ws, `\r\n\x1b[31m${target.error}\x1b[0m\r\n`)
    ws.close()
    return
  }

  evictIfNeeded()

  let pty: import('node-pty').IPty
  try {
    const { spawn } = loadPty()
    pty = spawn(target.file, target.args, {
      name: 'xterm-256color',
      cwd: target.cwd,
      cols: size.cols,
      rows: size.rows,
      env: spawnEnv({ TERM: 'xterm-256color' }) as Record<string, string>,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    send(ws, `\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m\r\n`)
    ws.close()
    return
  }

  const url = new URL(req.url ?? '', 'http://localhost')
  const runId = url.searchParams.get('runId') ?? ''
  const session: TerminalSession = {
    key,
    pty,
    buffer: [],
    bufferBytes: 0,
    ws: null,
    onData: { dispose() {} },
    onExit: { dispose() {} },
    exited: false,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    idleTimer: null,
    meta: runId
      ? { kind: 'resume', runId, cwd: target.cwd }
      : {
          kind: 'shell',
          projectId: url.searchParams.get('projectId') ?? undefined,
          tab: url.searchParams.get('tab') ?? undefined,
          cwd: target.cwd,
        },
  }

  session.onData = pty.onData((data) => {
    session.lastActivityAt = Date.now()
    appendToBuffer(session, data)
    send(session.ws, data)
  })

  session.onExit = pty.onExit(({ exitCode }) => {
    session.exited = true
    send(
      session.ws,
      `\r\n\x1b[90m[process exited${exitCode ? ` with code ${exitCode}` : ''}]\x1b[0m\r\n`,
    )
    const attached = session.ws
    destroySession(session.key)
    try {
      attached?.close()
    } catch {
      /* ignore */
    }
  })

  sessions.set(key, session)
  attach(session, ws, size)
}

/**
 * Kill the pty's whole process group, not just its leader. node-pty starts the
 * child in its own session (setsid ⇒ pgid == pid), so `process.kill(-pid, …)`
 * reaches descendants too — e.g. `claude` plus the MCP servers it spawned — which
 * a bare `pty.kill()` (SIGHUP to the leader) can leave orphaned. Escalates to
 * SIGKILL if the tree doesn't exit promptly. Falls back to `pty.kill()` on Windows
 * (no process groups; ConPTY teardown handles the tree).
 */
function killPtyTree(pty: import('node-pty').IPty): void {
  if (process.platform === 'win32') {
    try {
      pty.kill()
    } catch {
      /* already gone */
    }
    return
  }
  const pid = pty.pid
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        pty.kill(signal)
      } catch {
        /* already gone */
      }
    }
  }
  signalGroup('SIGTERM')
  setTimeout(() => signalGroup('SIGKILL'), 3000).unref()
}
