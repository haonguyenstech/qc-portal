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
 * Bridge one WebSocket to one freshly-spawned pseudo-terminal. The pty lives for
 * the life of the socket — connect spawns the shell, disconnect (ws close) kills
 * it. Server→client frames are raw terminal bytes; client→server frames are JSON
 * control messages ({type:'input'|'resize'}).
 */
export function handleTerminalConnection(ws: WebSocket, req: IncomingMessage): void {
  const target = resolveTarget(req)
  if ('error' in target) {
    try {
      ws.send(`\r\n\x1b[31m${target.error}\x1b[0m\r\n`)
    } catch {
      /* ignore */
    }
    ws.close()
    return
  }

  let pty: import('node-pty').IPty
  try {
    const { spawn } = loadPty()
    const { cols, rows } = parseSize(req)
    pty = spawn(target.file, target.args, {
      name: 'xterm-256color',
      cwd: target.cwd,
      cols,
      rows,
      env: spawnEnv({ TERM: 'xterm-256color' }) as Record<string, string>,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      ws.send(`\r\n\x1b[31mFailed to start terminal: ${msg}\x1b[0m\r\n`)
    } catch {
      /* ignore */
    }
    ws.close()
    return
  }

  const onData = pty.onData((data) => {
    try {
      ws.send(data)
    } catch {
      /* socket gone */
    }
  })

  const onExit = pty.onExit(({ exitCode }) => {
    try {
      ws.send(`\r\n\x1b[90m[process exited${exitCode ? ` with code ${exitCode}` : ''}]\x1b[0m\r\n`)
    } catch {
      /* ignore */
    }
    ws.close()
  })

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
      pty.write(m.data)
    } else if (m.type === 'resize' && typeof m.cols === 'number' && typeof m.rows === 'number') {
      try {
        pty.resize(Math.max(1, Math.min(m.cols, 500)), Math.max(1, Math.min(m.rows, 200)))
      } catch {
        /* resize on a dead pty — ignore */
      }
    }
  })

  let cleanedUp = false
  const cleanup = () => {
    if (cleanedUp) return
    cleanedUp = true
    onData.dispose()
    onExit.dispose()
    killPtyTree(pty)
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
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
