import spawn from 'cross-spawn'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnEnv } from './toolPath.js'

// Driving the Auto Agent CLI (`auto-agent-ai`) from the portal, so signing in is a
// button instead of "open a terminal and keep it open".
//
// `autoAgent.ts` next door READS Auto Agent's state and must stay a pure filesystem
// probe; this module is the only place that RUNS the CLI. The split is deliberate:
// the status endpoint is polled every 30s by the sidebar and may never depend on a
// child process.
//
// Why this works as a background child at all: `auto-agent-ai login` does NOT need to
// stay in the foreground. Its Microsoft sign-in is a LOOPBACK OAuth flow (the CLI
// listens on 127.0.0.1, opens the browser, waits for the callback), and the credential
// watcher it starts afterwards is spawned `detached` + `unref`'d by the CLI itself. So
// the login child exits as soon as sign-in completes and the watcher keeps running with
// no terminal attached — exactly what the engineer's open cmd window was doing.
//
// SECRETS: the OAuth tokens travel from the browser to the CLI's own loopback server
// and never appear on stdout, and this module keeps the output IN MEMORY only — never
// the DB, never disk. `scrub()` below is the belt-and-braces for that promise.

const BIN_NAME = 'auto-agent-ai'

/** Explicit path for an install that isn't on PATH (mirrors QC_CLAUDE_BIN / QC_K6_BIN). */
const BIN_ENV = process.env.QC_AUTO_AGENT_BIN?.trim() || ''

/**
 * Where the CLI is, or null when Auto Agent isn't installed on this machine.
 *
 * Resolved against `spawnEnv()`'s PATH rather than `process.env.PATH`: a portal started
 * from a desktop shortcut has the stale PATH that `toolPath.ts` exists to repair, and
 * Auto Agent installs into exactly those late-added dirs (Homebrew on macOS, per-user
 * npm/WinGet shims on Windows). Not cached — an install (or a `logout`, which removes
 * nothing but the state dir) must show up on the next poll without a restart.
 */
export function resolveAutoAgentBin(): string | null {
  if (BIN_ENV) return fs.existsSync(BIN_ENV) ? BIN_ENV : null
  const env = spawnEnv()
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  // On Windows the shim is `auto-agent-ai.cmd`; PATHEXT decides what "on PATH" means.
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : ['']
  for (const dir of (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, BIN_NAME + ext)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* next candidate */
      }
    }
  }
  return null
}

// ------------------------------------------------------------------ the login job

export type AutoAgentLoginState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface AutoAgentLoginJob {
  id: string
  state: AutoAgentLoginState
  startedAt: string
  finishedAt: string | null
  /**
   * The Microsoft sign-in URL the CLI printed. The CLI also opens the browser itself,
   * but on a machine with no default browser (or when the tab was closed) this is the
   * difference between a recoverable login and a five-minute silent timeout.
   */
  signInUrl: string | null
  /**
   * True when the CLI is waiting for a typed answer — it asks which AI session to use
   * when more than one is assigned. With a piped stdin (no TTY) the CLI falls back to a
   * NUMBERED list read line-by-line, which is why this is answerable from a web form at
   * all; the arrow-key picker it uses in a real terminal would not be.
   */
  awaitingAnswer: boolean
  /** Recent CLI output, ANSI-stripped and bounded. In memory only. */
  lines: string[]
  error: string | null
  exitCode: number | null
}

interface LiveJob extends AutoAgentLoginJob {
  child: ReturnType<typeof spawn> | null
  timer: NodeJS.Timeout | null
}

const MAX_LINES = 200
/** The CLI gives sign-in 5 minutes; this is the outer guard for a child that hangs. */
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000
const LOGOUT_TIMEOUT_MS = 30 * 1000

/** One login at a time — two concurrent `login` runs would fight over the same state.json. */
let current: LiveJob | null = null

/**
 * ANSI escapes — the CLI colours everything and hides the cursor. The ESC prefix is
 * part of the pattern on purpose: matching a bare `[…m` would also eat ordinary text
 * in brackets. Covers CSI (colour, cursor) and OSC (title) sequences.
 */
// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const ANSI = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g

/**
 * Defensive scrub before anything is stored or shown. Nothing the CLI prints today
 * carries a token (see the module note), so this is here to keep that true if the CLI
 * ever starts echoing one — a leak into the portal's UI would be silent otherwise.
 */
function scrub(line: string): string {
  return line
    .replace(/((?:access|refresh|handshake)?_?token=)[^\s&]+/gi, '$1***')
    .replace(/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '***')
}

const SIGNIN_URL = /https?:\/\/\S*cli_redirect=\S+/i
/** The CLI's non-TTY session picker ends with a bare `❯ ` prompt and no newline. */
const ANSWER_PROMPT = /❯\s*$/

function pushOutput(job: LiveJob, chunk: string): void {
  const clean = chunk.replace(ANSI, '')
  job.awaitingAnswer = ANSWER_PROMPT.test(clean.trimEnd()) ? true : job.awaitingAnswer
  for (const raw of clean.split(/\r?\n/)) {
    const line = scrub(raw.replace(/\r/g, '').trimEnd())
    if (!line.trim()) continue
    if (!job.signInUrl) {
      const found = SIGNIN_URL.exec(line)
      if (found) job.signInUrl = found[0]
    }
    job.lines.push(line)
  }
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
}

function snapshot(job: LiveJob): AutoAgentLoginJob {
  const { child: _child, timer: _timer, ...rest } = job
  return { ...rest, lines: [...rest.lines] }
}

function finish(job: LiveJob, state: AutoAgentLoginState, error: string | null): void {
  if (job.state !== 'running') return
  job.state = state
  job.error = error
  job.finishedAt = new Date().toISOString()
  job.awaitingAnswer = false
  if (job.timer) clearTimeout(job.timer)
  job.timer = null
  job.child = null
}

/**
 * Start `auto-agent-ai login --role client`.
 *
 * `--role client` is passed on purpose: without it the CLI asks for the role with an
 * ARROW-KEY picker, which a piped stdin cannot answer — the login would hang forever
 * on a prompt nobody can see. Client is also the only role this portal's users have
 * (the owner flow needs a handshake token typed at a terminal, which is out of scope
 * here and stays a terminal job).
 *
 * cwd is the home dir, not a project: the CLI writes to `~/.auto-agent-ai` and the
 * watcher it spawns inherits cwd — a watcher holding a project folder open would be a
 * surprise for anyone deleting that folder later.
 */
export function startAutoAgentLogin(): { ok: true; job: AutoAgentLoginJob } | { ok: false; error: string } {
  if (current?.state === 'running') return { ok: false, error: 'A sign-in is already running.' }
  const bin = resolveAutoAgentBin()
  if (!bin) {
    return {
      ok: false,
      error:
        'Auto Agent is not installed on this machine (no `auto-agent-ai` on PATH). Install it, or set QC_AUTO_AGENT_BIN to its full path.',
    }
  }

  const job: LiveJob = {
    id: randomUUID(),
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    signInUrl: null,
    awaitingAnswer: false,
    lines: [],
    error: null,
    exitCode: null,
    child: null,
    timer: null,
  }

  let child: ReturnType<typeof spawn>
  try {
    child = spawn(bin, ['login', '--role', 'client'], {
      cwd: os.homedir(),
      env: spawnEnv(),
      // Piped, not inherited: the portal server usually has no terminal at all, and
      // stdin must stay open and writable for the session picker's answer.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  job.child = child
  current = job
  child.stdout?.on('data', (d: Buffer) => pushOutput(job, d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => pushOutput(job, d.toString('utf8')))
  child.on('error', (err) => finish(job, 'failed', err.message))
  child.on('close', (code) => {
    job.exitCode = code
    if (job.state !== 'running') return // cancelled / already failed
    if (code === 0) finish(job, 'succeeded', null)
    else {
      // The CLI's own "Login failed: …" line says far more than an exit code.
      const why = [...job.lines].reverse().find((l) => /login failed|failed|error/i.test(l))
      finish(job, 'failed', why ?? `Auto Agent sign-in exited with code ${code ?? 'unknown'}.`)
    }
  })
  job.timer = setTimeout(() => {
    if (job.state !== 'running') return
    try {
      child.kill()
    } catch {
      /* already gone */
    }
    finish(job, 'failed', 'Sign-in timed out — the browser step was never completed.')
  }, LOGIN_TIMEOUT_MS)
  job.timer.unref()

  return { ok: true, job: snapshot(job) }
}

/** The login the browser is watching, or null when none has been started. */
export function getAutoAgentLogin(): AutoAgentLoginJob | null {
  return current ? snapshot(current) : null
}

/** Answer the CLI's session picker (a line on stdin). */
export function answerAutoAgentLogin(text: string): { ok: boolean; error?: string } {
  if (!current || current.state !== 'running' || !current.child) {
    return { ok: false, error: 'No sign-in is running.' }
  }
  try {
    current.child.stdin?.write(`${text.replace(/[\r\n]/g, '')}\n`)
    current.awaitingAnswer = false
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Give up on a sign-in that is still waiting for the browser. */
export function cancelAutoAgentLogin(): { ok: boolean; error?: string } {
  if (!current || current.state !== 'running') return { ok: false, error: 'No sign-in is running.' }
  const child = current.child
  finish(current, 'cancelled', 'Sign-in cancelled.')
  try {
    child?.kill()
  } catch {
    /* already gone */
  }
  return { ok: true }
}

/**
 * Run `auto-agent-ai logout` — stops the watcher, drops the keychain credential and
 * deletes `~/.auto-agent-ai`. Non-interactive, so a plain spawn is enough.
 *
 * The portal keeps spawning plain `claude` afterwards; it just won't have the shared
 * credential any more, which is precisely what the sidebar then reports.
 */
export function runAutoAgentLogout(): Promise<{ ok: boolean; error?: string; output: string[] }> {
  const bin = resolveAutoAgentBin()
  if (!bin) {
    return Promise.resolve({
      ok: false,
      error: 'Auto Agent is not installed on this machine (no `auto-agent-ai` on PATH).',
      output: [],
    })
  }
  // A running login would race the logout over the same state dir; stop it first.
  if (current?.state === 'running') cancelAutoAgentLogin()

  return new Promise((resolve) => {
    const output: string[] = []
    const collect = (d: Buffer) => {
      for (const raw of d.toString('utf8').replace(ANSI, '').split(/\r?\n/)) {
        const line = scrub(raw.trimEnd())
        if (line.trim()) output.push(line)
      }
    }
    let settled = false
    const done = (res: { ok: boolean; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...res, output: output.slice(-MAX_LINES) })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(bin, ['logout'], {
        cwd: os.homedir(),
        env: spawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      done({ ok: false, error: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ ok: false, error: 'Sign-out timed out.' })
    }, LOGOUT_TIMEOUT_MS)
    timer.unref()
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (err) => done({ ok: false, error: err.message }))
    child.on('close', (code) =>
      done(
        code === 0
          ? { ok: true }
          : { ok: false, error: output.at(-1) ?? `Sign-out exited with code ${code ?? 'unknown'}.` },
      ),
    )
  })
}
