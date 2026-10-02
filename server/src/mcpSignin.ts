import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import spawn from 'cross-spawn'
import { CLAUDE_BIN } from './config.js'
import { killSpawnedTree, spawnEnv } from './toolPath.js'

/**
 * MCP page: "Sign in" for a remote (http/sse) MCP server that uses OAuth — ClickUp,
 * Figma, Linear, Notion, Atlassian, Sentry's hosted servers, or any other.
 *
 * The portal does NOT run the OAuth flow itself. `claude mcp login <name>` already
 * does discovery, client registration, PKCE, stores the token in Claude Code's own
 * credential store and REFRESHES it — and every headless `claude -p` run the portal
 * spawns then uses that token. So `.mcp.json` holds only `{type, url}`: no secret
 * ever lands in the repo. This module only drives that command. Measured on CLI
 * 2.1.281, and every rule below comes from it:
 *
 * - It needs a TTY. With a piped/closed stdin it prints the URL and then exits 1
 *   ("stdin isn't a terminal") in BOTH modes — so it runs in a pty (node-pty, the
 *   Terminal page's native module).
 * - `--no-browser`, always. The CLI would open a browser on the machine the SERVER
 *   runs on, which is the wrong machine when the portal is used through /remote. The
 *   page opens the URL in the engineer's own browser instead.
 * - In a pty it does two things at once: it listens on `localhost:<port>/callback`
 *   (so a browser on this machine completes by itself) AND prompts "Or paste the
 *   redirect URL here" (so a browser elsewhere completes by pasting the address the
 *   failed redirect left in its address bar). A pasted URL is checked against the
 *   sign-in's `state`; a wrong one is re-prompted, not fatal.
 * - A server from .mcp.json that is not approved yet is refused outright ("awaiting
 *   approval") — the caller approves it first.
 * - The callback port is fixed per server, so two sign-ins at once would fight over
 *   it: one sign-in at a time, portal-wide.
 *
 * Output is ANSI-stripped, the `code=` of a pasted redirect URL (the pty echoes it)
 * is masked, and all of it is kept in memory only — never logged.
 */

const require = createRequire(import.meta.url)
type PtyModule = typeof import('node-pty')
type Pty = ReturnType<PtyModule['spawn']>
let ptyModule: PtyModule | null = null

// Same load as terminal.ts: lazily, re-asserting spawn-helper's exec bit, so a broken
// native build only disables this button instead of the portal.
function loadPty(): PtyModule {
  if (ptyModule) return ptyModule
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(
        require.resolve(`node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`),
        0o755,
      )
    } catch {
      /* compiled from source — no separate helper */
    }
  }
  ptyModule = require('node-pty') as PtyModule
  return ptyModule
}

export type McpSigninState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface McpSigninJob {
  id: string
  projectId: string
  server: string
  state: McpSigninState
  startedAt: string
  finishedAt: string | null
  /** The provider's authorize URL — the page opens it in the engineer's browser. */
  signInUrl: string | null
  /** The CLI is waiting at "Or paste the redirect URL here". */
  awaitingPaste: boolean
  /** The last pasted URL was refused (wrong sign-in / not a redirect URL). */
  pasteError: string | null
  /** Recent CLI output, ANSI-stripped, `code=` masked, bounded. In memory only. */
  lines: string[]
  error: string | null
  exitCode: number | null
}

interface LiveJob extends McpSigninJob {
  pty: Pty | null
  timer: NodeJS.Timeout | null
  /** Everything printed so far (stripped, masked), for patterns split across chunks. */
  text: string
  /** Where in `text` the most recent paste was sent, so an old prompt/refusal isn't re-read. */
  pasteMark: number
  /** An escape sequence cut off at the end of the last chunk — finished by the next one. */
  rawTail: string
  /** The line still being printed (no newline yet) — `lines` holds only complete ones. */
  partial: string
}

const MAX_LINES = 200
const MAX_TEXT = 64 * 1024
/** The outer guard for a sign-in nobody finishes. */
const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000
const LOGOUT_TIMEOUT_MS = 30 * 1000

let current: LiveJob | null = null

/**
 * CSI (colour, cursor) and OSC sequences. The OSC body is `[^\x07\x1B]*` on purpose:
 * the CLI prints the URL as an OSC 8 hyperlink — `ESC]8;;<url>ESC\<url>ESC]8;;ESC\` —
 * and a greedy body would run from the first OSC to the LAST terminator and swallow
 * the visible URL between them.
 */
// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const ANSI = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g

/** The authorization code in a pasted redirect URL is the one secret on screen. */
function scrub(s: string): string {
  return s.replace(/([?&]code=)[^&\s]+/gi, '$1***')
}

const PASTE_PROMPT = /paste the redirect URL/i
const PASTE_REFUSED = /doesn.t look like a redirect URL[^\n]*/i

// eslint-disable-next-line no-control-regex -- see ANSI
const ANSI_AT = new RegExp(ANSI.source, 'y')

/**
 * Where an escape sequence starts that the chunk ended in the MIDDLE of (-1: none).
 * Walks the sequences in order: a complete one is skipped, a lone `ESC\` (an OSC
 * terminator) is not a start, and an OSC whose terminator hasn't arrived yet — e.g.
 * `ESC]8;;https://…ESC` cut before the `\` — is held back from its START, or its
 * body would leak into the text as garbage.
 */
function openEscapeAt(raw: string): number {
  for (let i = raw.indexOf('\x1B'); i !== -1; i = raw.indexOf('\x1B', i + 1)) {
    ANSI_AT.lastIndex = i
    const m = ANSI_AT.exec(raw)
    if (m) {
      i += m[0].length - 1
      continue
    }
    const t = raw.slice(i)
    if (
      t === '\x1B' ||
      (t[1] === '[' && /^\x1B\[[0-9;?]*[ -/]*$/.test(t)) ||
      (t[1] === ']' && !/\x07|\x1B\\/.test(t))
    ) {
      return i
    }
  }
  return -1
}

/**
 * Output arrives in arbitrary CHUNKS, not lines: ClickUp's authorize URL (a ~500-char
 * JWT client id) was split mid-`%2F`, and reading the URL from the first chunk handed
 * the engineer a URL cut off inside `redirect_uri` — ClickUp: "Invalid redirect_uri".
 * So an escape sequence cut at a chunk end is held back until it is complete, the URL
 * is taken only once whitespace ENDS it, and `lines` only ever holds finished lines.
 */
function pushOutput(job: LiveJob, chunk: string): void {
  let raw = job.rawTail + chunk
  job.rawTail = ''
  const cut = openEscapeAt(raw)
  if (cut !== -1 && raw.length - cut < 4096) {
    job.rawTail = raw.slice(cut)
    raw = raw.slice(0, cut)
  }
  const clean = scrub(raw.replace(ANSI, '').replace(/\r(?!\n)/g, '\n'))
  job.text += clean
  if (job.text.length > MAX_TEXT) {
    const drop = job.text.length - MAX_TEXT
    job.text = job.text.slice(drop)
    job.pasteMark = Math.max(0, job.pasteMark - drop)
  }
  if (!job.signInUrl) {
    // The first https URL after the CLI's "visit" line is the authorize URL.
    const m = /visit[^\n]*\n\s*(https?:\/\/\S+)(?=\s)/i.exec(job.text)
    if (m) job.signInUrl = m[1]
  }
  // Only what came AFTER the last paste counts: a refusal re-prints the prompt, so
  // both "refused" and "waiting again" are read from there.
  const since = job.text.slice(job.pasteMark)
  const refused = PASTE_REFUSED.exec(since)
  if (refused) job.pasteError = refused[0].trim()
  job.awaitingPaste = PASTE_PROMPT.test(since)
  const parts = (job.partial + clean).split('\n')
  job.partial = parts.pop() ?? ''
  for (const part of parts) {
    const line = part.trimEnd()
    if (line.trim()) job.lines.push(line)
  }
  if (job.lines.length > MAX_LINES) job.lines.splice(0, job.lines.length - MAX_LINES)
}

function snapshot(job: LiveJob): McpSigninJob {
  const { pty: _pty, timer: _timer, text: _text, pasteMark: _mark, rawTail: _tail, partial, ...rest } = job
  // The unfinished line too — the paste prompt has no newline after it.
  return { ...rest, lines: partial.trim() ? [...rest.lines, partial.trimEnd()] : [...rest.lines] }
}

function finish(job: LiveJob, state: McpSigninState, error: string | null): void {
  if (job.state !== 'running') return
  job.state = state
  job.error = error
  job.finishedAt = new Date().toISOString()
  job.awaitingPaste = false
  if (job.timer) clearTimeout(job.timer)
  job.timer = null
  const pty = job.pty
  job.pty = null
  if (pty && state !== 'succeeded') {
    try {
      pty.kill()
    } catch {
      /* already gone */
    }
  }
}

/** `claude …` in a pty — through cmd.exe on Windows so a `claude.cmd` shim resolves too. */
function claudeCommand(args: string[]): { file: string; args: string[] } {
  if (process.platform === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/c', CLAUDE_BIN, ...args] }
  }
  return { file: CLAUDE_BIN, args }
}

/**
 * Start `claude mcp login <server> --no-browser` in the project folder. The caller has
 * already checked the server exists, is http/sse, and approved it if it is a project
 * (.mcp.json) server. `onSuccess` runs once the CLI exits 0 (drop cached health).
 */
export function startMcpSignin(
  rootPath: string,
  projectId: string,
  server: string,
  onSuccess: () => void,
): { ok: true; job: McpSigninJob } | { ok: false; status: number; error: string } {
  if (current?.state === 'running') {
    if (current.projectId === projectId && current.server === server) {
      return { ok: true, job: snapshot(current) }
    }
    return {
      ok: false,
      status: 409,
      error: `A sign-in to "${current.server}" is still waiting — finish or cancel it first.`,
    }
  }

  let pty: Pty
  try {
    const cmd = claudeCommand(['mcp', 'login', server, '--no-browser'])
    pty = loadPty().spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      // Wide, so nothing the CLI lays out by column ever breaks the URL across lines.
      cols: 1000,
      rows: 40,
      cwd: rootPath,
      env: spawnEnv() as Record<string, string>,
    })
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: `Could not start the Claude CLI: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const job: LiveJob = {
    id: randomUUID(),
    projectId,
    server,
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    signInUrl: null,
    awaitingPaste: false,
    pasteError: null,
    lines: [],
    error: null,
    exitCode: null,
    pty,
    timer: null,
    text: '',
    pasteMark: 0,
    rawTail: '',
    partial: '',
  }
  current = job

  pty.onData((d) => pushOutput(job, d))
  pty.onExit(({ exitCode }) => {
    job.exitCode = exitCode
    if (job.state !== 'running') return // cancelled / timed out
    job.pty = null
    if (exitCode === 0) {
      finish(job, 'succeeded', null)
      onSuccess()
      return
    }
    // The CLI's own "Couldn't complete authentication …" says more than a code.
    const why = [...job.lines]
      .reverse()
      .find((l) => /couldn.t|fail|error|denied|invalid|expired|not found|awaiting approval/i.test(l))
    finish(job, 'failed', why ?? `Sign-in exited with code ${exitCode}.`)
  })
  job.timer = setTimeout(() => {
    finish(job, 'failed', 'Sign-in timed out — the browser step was never completed.')
  }, SIGNIN_TIMEOUT_MS)
  job.timer.unref()

  return { ok: true, job: snapshot(job) }
}

/** The sign-in for this project + server, or null when there is none. */
export function getMcpSignin(projectId: string, server: string): McpSigninJob | null {
  return current && current.projectId === projectId && current.server === server
    ? snapshot(current)
    : null
}

function running(projectId: string, server: string): LiveJob | null {
  return current &&
    current.state === 'running' &&
    current.projectId === projectId &&
    current.server === server &&
    current.pty
    ? current
    : null
}

/**
 * Hand the CLI the address the browser landed on after sign-in (the redirect to
 * `localhost:<port>/callback?code=…` that a browser on another machine cannot reach).
 */
export function pasteMcpSignin(
  projectId: string,
  server: string,
  url: string,
): { ok: boolean; error?: string } {
  const job = running(projectId, server)
  if (!job) return { ok: false, error: 'No sign-in is running for this server.' }
  const value = url.trim()
  if (!/^https?:\/\/\S+$/i.test(value)) {
    return { ok: false, error: 'Paste the full address from the browser, starting with http://' }
  }
  try {
    job.pasteMark = job.text.length
    job.pasteError = null
    job.awaitingPaste = false
    job.pty!.write(`${value}\r`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function cancelMcpSignin(projectId: string, server: string): { ok: boolean; error?: string } {
  const job = running(projectId, server)
  if (!job) return { ok: false, error: 'No sign-in is running for this server.' }
  finish(job, 'cancelled', 'Sign-in cancelled.')
  return { ok: true }
}

/**
 * `claude mcp logout <server>` — drops the stored OAuth token. Non-interactive (it
 * runs fine with no TTY), so a plain spawn.
 */
export function runMcpLogout(rootPath: string, server: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (r: { ok: boolean; detail: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(CLAUDE_BIN, ['mcp', 'logout', server], {
        cwd: rootPath,
        env: spawnEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      resolve({ ok: false, detail: err instanceof Error ? err.message : String(err) })
      return
    }
    const timer = setTimeout(() => {
      killSpawnedTree(child)
      done({ ok: false, detail: 'Sign-out timed out.' })
    }, LOGOUT_TIMEOUT_MS)
    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.on('error', (err) => done({ ok: false, detail: err.message }))
    child.on('close', (code) => {
      const detail = scrub(out.replace(ANSI, '')).trim()
      done({ ok: code === 0, detail: detail || (code === 0 ? 'Signed out.' : `Exited with code ${code}.`) })
    })
  })
}
