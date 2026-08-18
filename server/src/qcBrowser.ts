import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import spawn from 'cross-spawn'
import { agentProfileDir } from './browserProfile.js'
import { DB_PATH } from './config.js'
import { spawnEnv } from './toolPath.js'

/**
 * THE QC BROWSER — one long-lived browser window the PORTAL owns, which Playwright
 * MCP attaches to over CDP instead of launching its own.
 *
 * Why this exists (two complaints, one root cause). Playwright MCP normally runs as
 * a **stdio child of `claude`** and launches the browser itself, which means:
 *
 *  1. **Stop closed the browser.** Stopping a chat turn kills the `claude` child,
 *     which tears down its MCP servers, which closes the browser they launched — so
 *     an engineer who wanted to pause a flow, fix a step and carry on lost the whole
 *     session (logins, filled forms, the page they were mid-way through). There is no
 *     fix on the stdio side: a child cannot outlive the parent that owns its pipes.
 *  2. **The window was never full screen.** The MCP launched a browser at
 *     Playwright's default headed window size and we additionally pinned
 *     `--viewport-size 1280x720`, so the page rendered in a small box on a large
 *     monitor and desktop breakpoints didn't even trigger.
 *
 * Attaching over CDP fixes both at once, and was verified end to end before this
 * module was written: killing the MCP left the browser open **on the same page**, a
 * freshly-spawned MCP re-attached to that live page, and the window measured
 * 2552x1326 on a 2560x1410 screen instead of 1280x720.
 *
 * Two further properties fall out of the portal owning the process, and both are
 * deliberate:
 *  - It is spawned **detached**, so it survives a portal restart. `ensureQcBrowser`
 *    ADOPTS a browser that already answers on the port rather than starting a second
 *    one — a second instance on the same profile is exactly what Chrome refuses to do.
 *  - Between turns it is just a browser. The engineer can click around in it, fix the
 *    state by hand, and the next turn continues from whatever is on screen. That is
 *    the "pause, adjust, continue" the stdio setup could not offer.
 */

/** CDP port. Deliberately not 9222 — that's the port the engineer's own Chrome uses. */
export const QC_BROWSER_PORT = Number(process.env.QC_BROWSER_PORT ?? 19222)

/** Channel to launch. Matches the `--browser` value QC projects already use. */
export type QcBrowserChannel = 'msedge' | 'chrome'

export function cdpEndpoint(): string {
  // 127.0.0.1, not localhost: Chrome binds the DevTools port to IPv4 only, so a
  // localhost that resolves to ::1 first fails to connect on some machines.
  return `http://127.0.0.1:${QC_BROWSER_PORT}`
}

/**
 * Profile for the QC browser. Kept SEPARATE from `agentProfileDir()` (which the
 * self-launching MCP still uses) because Chrome will not open the same user-data-dir
 * twice — sharing one would make the two modes fight whenever both are in play.
 */
export function qcBrowserProfileDir(): string {
  return process.env.QC_BROWSER_PROFILE_DIR || `${agentProfileDir()}-qc`
}

/**
 * A Playwright MCP config file that makes a browser the MCP launches ITSELF open
 * maximized with no viewport emulation — the full-screen fix for projects that
 * haven't attached to the QC browser.
 *
 * It has to be a file: `--start-maximized` is a browser launch argument and the MCP
 * CLI exposes no flag for one, but it does take `--config`. Written beside the DB
 * (never into a project repo — it describes this machine, not the project) and
 * rewritten on every boot so a portal update can change its contents.
 */
export function playwrightMcpConfigPath(): string {
  return path.join(path.dirname(DB_PATH), 'playwright-mcp.json')
}

export function writePlaywrightMcpConfig(): string | null {
  const file = playwrightMcpConfigPath()
  const body = {
    browser: {
      launchOptions: { args: ['--start-maximized'] },
      // null, not a size: the page then fills the real window instead of being
      // letterboxed inside it. This is the half of the fix that CLI flags can't do.
      contextOptions: { viewport: null },
    },
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
    return file
  } catch {
    return null // best-effort: without it the browser is small, not broken
  }
}

/**
 * The HEADLESS counterpart of the file above, for a run the engineer asked to execute
 * without a visible window (the per-run checkbox on `/qc-run`).
 *
 * It cannot reuse the headed config: that one says `viewport: null` (fill the real
 * window) plus `--start-maximized`, and headless Chrome has no window to fill — the
 * page then renders at Chrome's 800x600 default, which is a mobile-ish layout that
 * fires the wrong breakpoints and makes every screenshot the wrong shape. So headless
 * pins a real desktop viewport instead (same 1440x900 the API scanner uses).
 */
export function playwrightHeadlessMcpConfigPath(): string {
  return path.join(path.dirname(DB_PATH), 'playwright-mcp-headless.json')
}

export function writeHeadlessPlaywrightMcpConfig(): string | null {
  const file = playwrightHeadlessMcpConfigPath()
  const body = {
    browser: {
      launchOptions: { headless: true },
      contextOptions: { viewport: { width: 1440, height: 900 } },
    },
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
    return file
  } catch {
    return null
  }
}

/** Well-known install locations, per platform. First hit wins. */
function executableCandidates(channel: QcBrowserChannel): string[] {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return channel === 'chrome'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        ]
      : [
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          path.join(home, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
        ]
  }
  if (process.platform === 'win32') {
    // Both Program Files roots: Edge is 32-bit-registered on many machines, Chrome
    // can be either, and a per-user install lands in LOCALAPPDATA.
    const roots = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
      process.env.LOCALAPPDATA,
    ].filter((r): r is string => !!r)
    const rel =
      channel === 'chrome'
        ? ['Google/Chrome/Application/chrome.exe']
        : ['Microsoft/Edge/Application/msedge.exe']
    return roots.flatMap((root) => rel.map((r) => path.join(root, ...r.split('/'))))
  }
  return channel === 'chrome'
    ? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
    : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable']
}

export function resolveBrowserExecutable(channel: QcBrowserChannel): string | null {
  if (process.env.QC_BROWSER_PATH) return process.env.QC_BROWSER_PATH
  for (const candidate of executableCandidates(channel)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* not installed here */
    }
  }
  return null
}

/** The pid we started, when we started it. Null when adopted or not running. */
let ownPid: number | null = null

/**
 * Maximize the browser's window through CDP.
 *
 * `--start-maximized` is NOT enough: on macOS Chromium ignores it outright (verified —
 * the window came up `windowState: "normal"` at 1627x1020 on a 2560-wide screen, and the
 * page measured 1619x936, which is the small-window complaint all over again). CDP's
 * `Browser.setWindowBounds` works on every platform, so it's the one that decides.
 *
 * Best-effort and self-limiting: a browser that can't be maximized is still a working
 * browser, so every failure path resolves quietly.
 */
export async function maximizeQcBrowserWindow(): Promise<boolean> {
  let socket: WebSocket | undefined
  try {
    const res = await fetch(`${cdpEndpoint()}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!res.ok) return false
    const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (!webSocketDebuggerUrl) return false

    return await new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer)
        try {
          socket?.close()
        } catch {
          /* already closed */
        }
        resolve(ok)
      }
      const timer = setTimeout(() => done(false), 4000)
      socket = new WebSocket(webSocketDebuggerUrl)
      socket.addEventListener('open', () => {
        socket?.send(JSON.stringify({ id: 1, method: 'Target.getTargets' }))
      })
      socket.addEventListener('error', () => done(false))
      socket.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            id?: number
            result?: {
              targetInfos?: { type: string; targetId: string }[]
              windowId?: number
            }
          }
          if (msg.id === 1) {
            // Any target hanging off the window will do; a page is the normal case, but a
            // freshly-launched browser can briefly have only its blank tab.
            const target = msg.result?.targetInfos?.find((t) => t.type === 'page')
            if (!target) return done(false)
            socket?.send(
              JSON.stringify({
                id: 2,
                method: 'Browser.getWindowForTarget',
                params: { targetId: target.targetId },
              }),
            )
          } else if (msg.id === 2) {
            const windowId = msg.result?.windowId
            if (windowId == null) return done(false)
            socket?.send(
              JSON.stringify({
                id: 3,
                method: 'Browser.setWindowBounds',
                // windowState alone — mixing it with left/top/width/height is a protocol
                // error ("state cannot be combined with bounds").
                params: { windowId, bounds: { windowState: 'maximized' } },
              }),
            )
          } else if (msg.id === 3) {
            done(true)
          }
        } catch {
          done(false)
        }
      })
    })
  } catch {
    return false
  }
}

export interface QcBrowserStatus {
  running: boolean
  endpoint: string
  /** Browser build string from CDP, e.g. "Edg/151.0.4129.78". */
  version?: string
  /** True when this portal process spawned it (so Stop can end it). */
  startedHere: boolean
  pid?: number
  profileDir: string
  /** Which channels this machine actually has installed. */
  available: QcBrowserChannel[]
}

/** Ask the DevTools endpoint who's there. Short timeout — this is on a UI path. */
async function probe(timeoutMs = 1500): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`${cdpEndpoint()}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { ok: false }
    const body = (await res.json()) as { Browser?: string }
    return { ok: true, version: body.Browser }
  } catch {
    return { ok: false }
  }
}

export async function qcBrowserStatus(): Promise<QcBrowserStatus> {
  const { ok, version } = await probe()
  const available = (['msedge', 'chrome'] as QcBrowserChannel[]).filter((c) =>
    resolveBrowserExecutable(c),
  )
  if (!ok) ownPid = null // it went away (crashed, or the user closed the window)
  return {
    running: ok,
    endpoint: cdpEndpoint(),
    version,
    startedHere: ok && ownPid != null,
    pid: ok && ownPid != null ? ownPid : undefined,
    profileDir: qcBrowserProfileDir(),
    available,
  }
}

/**
 * Make sure a QC browser is listening on the CDP port, launching one if not.
 * Adopts an already-running instance (including one from a previous portal run).
 * Never throws — a failure comes back as `{ ok: false, error }` so a caller on a
 * turn's critical path can report it instead of dying.
 */
export async function ensureQcBrowser(
  channel: QcBrowserChannel = 'msedge',
): Promise<{ ok: boolean; endpoint: string; adopted?: boolean; error?: string }> {
  const first = await probe()
  if (first.ok) return { ok: true, endpoint: cdpEndpoint(), adopted: true }

  const exe = resolveBrowserExecutable(channel)
  if (!exe) {
    const other: QcBrowserChannel = channel === 'chrome' ? 'msedge' : 'chrome'
    const fallback = resolveBrowserExecutable(other)
    if (!fallback) {
      return {
        ok: false,
        endpoint: cdpEndpoint(),
        error: `Neither Microsoft Edge nor Google Chrome was found on this machine. Install one, or set QC_BROWSER_PATH to the executable.`,
      }
    }
    return ensureQcBrowser(other)
  }

  const profile = qcBrowserProfileDir()
  try {
    fs.mkdirSync(profile, { recursive: true })
  } catch (err) {
    return {
      ok: false,
      endpoint: cdpEndpoint(),
      error: `Could not create the browser profile folder: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }

  const args = [
    `--remote-debugging-port=${QC_BROWSER_PORT}`,
    `--user-data-dir=${profile}`,
    // The whole point of the full-screen half of this fix: a real maximized window,
    // and (via the MCP side dropping --viewport-size) no viewport emulation over it.
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
    // Chrome exits immediately when its only page is closed unless something keeps
    // it up; an about:blank start page also gives the engineer a window to look at.
    'about:blank',
  ]

  let child: ReturnType<typeof spawn>
  try {
    // detached: the browser must outlive both the turn AND the portal — see the
    // module comment. stdio ignored so its chatter can't fill our pipes.
    child = spawn(exe, args, { env: spawnEnv(), detached: true, stdio: 'ignore' })
    child.unref()
  } catch (err) {
    return {
      ok: false,
      endpoint: cdpEndpoint(),
      error: err instanceof Error ? err.message : 'failed to launch the browser',
    }
  }

  // Wait for the DevTools endpoint rather than a fixed sleep: a cold profile takes
  // seconds, a warm one is up almost immediately.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const p = await probe(1000)
    if (p.ok) {
      ownPid = child.pid ?? null
      // Only on a fresh launch: an adopted window may have been sized and placed by the
      // engineer on purpose, and yanking it fullscreen mid-session is its own annoyance.
      await maximizeQcBrowserWindow()
      return { ok: true, endpoint: cdpEndpoint() }
    }
    if (child.exitCode !== null) break // it died on startup; stop waiting
    await new Promise((r) => setTimeout(r, 500))
  }
  return {
    ok: false,
    endpoint: cdpEndpoint(),
    error: `The browser did not open a DevTools port on ${QC_BROWSER_PORT} within 20s. Another program may be holding that port — set QC_BROWSER_PORT to a free one.`,
  }
}

/**
 * Close the QC browser. Only possible for one WE started: an adopted instance (from
 * a previous portal run, or a browser the engineer launched with a debugging port)
 * has no pid here, and killing something by profile-dir pattern match is how you end
 * up closing the user's real browser.
 */
export async function stopQcBrowser(): Promise<{ ok: boolean; error?: string }> {
  const { running } = await qcBrowserStatus()
  if (!running) return { ok: true }
  if (ownPid == null) {
    return {
      ok: false,
      error:
        'This browser was not started by the current portal process, so the portal will not kill it. Close the browser window yourself.',
    }
  }
  try {
    // Negative pid = the whole process group. `detached: true` made the browser a
    // group leader, so this takes its renderer/GPU children with it; a bare kill(pid)
    // leaves those orphaned (the same lesson as killPtyTree in terminal.ts).
    try {
      process.kill(-ownPid, 'SIGTERM')
    } catch {
      process.kill(ownPid, 'SIGTERM')
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed to close the browser' }
  }
  ownPid = null
  return { ok: true }
}
