#!/usr/bin/env node
// qc-portal — launcher for the QC Portal.
//
//   qc-portal            start the server (if needed) and open the browser
//   qc-portal --open     same as above
//   qc-portal --stop     stop the running server
//   qc-portal --restart  stop then start
//   qc-portal --status   report whether the server is running
//   qc-portal --update   git pull + npm install + build, then restart if it was running
//   qc-portal --version  print the installed version
//
// Single process, single port: the Express server serves both the API and the
// built web UI. Cross-platform (macOS / Linux / Windows) — no shell string-concat.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // <root>/bin
const ROOT = path.join(here, '..')
const SERVER_ENTRY = path.join(ROOT, 'server', 'dist', 'index.js')
const DATA_DIR = path.join(ROOT, 'data')
const PID_FILE = path.join(DATA_DIR, 'server.pid')
const LOG_FILE = path.join(DATA_DIR, 'server.log')
const PORT = Number(process.env.QC_PORT ?? 5174)
const URL = `http://127.0.0.1:${PORT}`

const isWin = process.platform === 'win32'

function readPkgVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  } catch {
    return 'unknown'
  }
}

function readPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0) // signal 0 = existence check
    return true
  } catch (err) {
    return err.code === 'EPERM' // exists but owned by another user
  }
}

function clearPid() {
  try {
    fs.rmSync(PID_FILE)
  } catch {
    /* already gone */
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/health`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(800, () => {
      req.destroy()
      resolve(false)
    })
  })
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await ping()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

function openBrowser(url) {
  const cmd = isWin ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = isWin ? ['/c', 'start', '""', url] : [url]
  // windowsHide: `cmd /c start` would otherwise flash a console window before the
  // browser opens. The browser still launches.
  spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).unref()
}

function ensureBuilt() {
  if (fs.existsSync(SERVER_ENTRY)) return true
  console.error('QC Portal is not built yet. Run `qc-portal --update` or `npm run build` in the install folder.')
  return false
}

async function start({ open = true } = {}) {
  if (await ping()) {
    console.log(`QC Portal already running at ${URL}`)
    if (open) openBrowser(URL)
    return
  }
  if (!ensureBuilt()) process.exit(1)

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SERVER_ENTRY], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true, // run the background server without a console window
    env: { ...process.env, QC_PORT: String(PORT) },
  })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))

  process.stdout.write('Starting QC Portal')
  const ok = await waitForHealth()
  process.stdout.write('\n')
  if (!ok) {
    console.error(`Server did not become healthy. Check the log: ${LOG_FILE}`)
    process.exit(1)
  }
  console.log(`QC Portal running at ${URL}`)
  if (open) openBrowser(URL)
}

function stop() {
  const pid = readPid()
  if (!pid || !isAlive(pid)) {
    console.log('QC Portal is not running.')
    clearPid()
    return false
  }
  try {
    process.kill(pid, isWin ? undefined : 'SIGTERM')
  } catch {
    /* may have just exited */
  }
  // On Windows a detached node tree is most reliably killed with taskkill /t.
  if (isWin)
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  clearPid()
  console.log('QC Portal stopped.')
  return true
}

async function status() {
  const up = await ping()
  const pid = readPid()
  if (up) console.log(`QC Portal is running at ${URL}${pid ? ` (pid ${pid})` : ''}`)
  else console.log('QC Portal is not running.')
}

// Nothing in an update may wait on a human. The updater runs with no console and
// its stdio pointed at a log file, so a prompt is INVISIBLE — git asking for
// credentials (a proxy, an expired token, a repo that went private) would sit
// there unanswered forever with the server already stopped. Make every such
// question fail fast instead of blocking.
const NON_INTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GCM_INTERACTIVE: 'never',
  npm_config_yes: 'true',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
}

/**
 * Run one update step. Returns null on success, or a human sentence on failure.
 *
 * DOES NOT EXIT. It used to call `process.exit` on a non-zero status, which is
 * what made a failed update permanent: `update()` stops the server BEFORE the
 * first step, so exiting here left the portal dead with no way back except a
 * terminal the QC engineer probably doesn't have open.
 *
 * Every step is also BOUNDED. `spawnSync` has no timeout unless one is given, so
 * a stalled `git fetch` or `npm install` — a dropped VPN, a corporate proxy, a
 * credential prompt nobody can see — hung here forever, which is exactly the
 * "updating…" spinner that never finishes. (Note: with `shell: true` on Windows
 * the timeout kills cmd.exe and the grandchild may survive; that is acceptable,
 * because the point is to stop WAITING and put the server back.)
 */
function run(cmd, args, timeout) {
  // When the updater is launched from the portal UI it has no attached terminal
  // (stdout is redirected to a log file, not a TTY). On Windows, a shell:true step
  // (git / npm via cmd.exe) with stdio:'inherit' then pops its OWN console window
  // — windowsHide does not reliably suppress a window for an inherited-console
  // child. So only inherit stdio when we actually have a user terminal; otherwise
  // run fully headless (no inherited console → no window). Phase progress is still
  // captured because the launcher's own console.log is redirected to the log file.
  const headless = process.env.QC_HEADLESS === '1' || !process.stdout.isTTY
  const label = `${cmd} ${args.join(' ')}`
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: headless ? 'ignore' : 'inherit',
    shell: isWin,
    windowsHide: true,
    timeout,
    killSignal: 'SIGKILL',
    env: { ...process.env, ...NON_INTERACTIVE_ENV },
  })
  // A killed-on-timeout child reports ETIMEDOUT, or comes back signalled with no
  // status — both mean "it never finished", which is a different fix for the user
  // than "it ran and failed", so they get different sentences.
  if (r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal)) {
    const waited = timeout && timeout >= 60_000 ? `${Math.round(timeout / 60_000)} minutes` : `${Math.round((timeout ?? 0) / 1000)}s`
    return `\`${label}\` did not finish within ${waited} and was stopped. Check the network, VPN or proxy and try again.`
  }
  if (r.error) return `\`${label}\` could not start: ${r.error.message}`
  if (r.status !== 0) return `\`${label}\` failed (exit ${r.status}).`
  return null
}

// How long each step may take before it is treated as hung. Generous — a cold
// `npm install` on a laptop over a slow link is genuinely slow — but finite.
const GIT_TIMEOUT_MS = 3 * 60_000
const NPM_TIMEOUT_MS = 15 * 60_000

// The branch this checkout tracks (the installer clones `main`); fall back to it.
function currentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: isWin,
    windowsHide: true,
  })
  const name = (r.stdout ?? '').trim()
  return name && name !== 'HEAD' ? name : 'main'
}

/**
 * Record how the update ended, where the server can read it.
 *
 * The server reports the version from package.json ON DISK, which `git reset` has
 * already moved by the time a later step fails — so a build that failed still
 * looks like a version bump, and the browser would announce "update complete" and
 * reload onto the old bundle wearing the new number. This marker is the only thing
 * that knows the difference, so the UI can say what actually happened.
 */
function writeUpdateStatus(status) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(DATA_DIR, 'update-status.json'),
      JSON.stringify({ ...status, at: new Date().toISOString() }),
    )
  } catch {
    /* the update itself matters more than the note about it */
  }
}

/** The update steps, in order. Returns a failure sentence, or null when all passed. */
function updateSteps() {
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('Pulling latest…')
    const branch = currentBranch()
    let failure = run('git', ['fetch', 'origin', branch], GIT_TIMEOUT_MS)
    if (failure) return failure
    // Force the checkout to match the remote. A plain `git pull --ff-only` aborts
    // the moment a tracked file is dirty, and `npm install` routinely rewrites the
    // tracked package-lock.json (different npm version / platform-specific optional
    // deps, esp. on Windows) — which silently blocked every subsequent update. A
    // hard reset to the upstream tip discards those local edits and always advances.
    failure = run('git', ['reset', '--hard', `origin/${branch}`], GIT_TIMEOUT_MS)
    if (failure) return failure
  } else {
    console.warn('Not a git checkout — skipping pull. Re-run the install script to update the source.')
  }
  console.log('Installing dependencies…')
  let failure = run('npm', ['install'], NPM_TIMEOUT_MS)
  if (failure) return failure
  console.log('Building…')
  failure = run('npm', ['run', 'build'], NPM_TIMEOUT_MS)
  if (failure) return failure
  return null
}

/**
 * Update in place, and — whatever happens — put the server back.
 *
 * The recovery is the point. The server is stopped BEFORE the first step, so any
 * step that failed or hung used to leave the portal simply gone: the browser sat
 * on "Updating QC Portal…" until it timed out, and there was nothing to come back
 * to. A failed update must degrade to "you are still on the old version", which
 * the engineer can see and retry, not to "the portal is not running".
 */
async function update() {
  const wasRunning = await ping()
  if (wasRunning) {
    console.log('Stopping server before update…')
    stop()
  }

  // Cleared up front so a stale marker from a previous run can never be read as
  // the verdict on this one.
  writeUpdateStatus({ ok: null, running: true })

  const failure = updateSteps()
  if (failure) {
    console.error(`Update failed: ${failure}`)
    writeUpdateStatus({ ok: false, error: failure, version: readPkgVersion() })
    if (wasRunning) {
      // The old build is still on disk, so this normally succeeds even when the
      // update did not. Reported either way — this line is what the UI shows.
      console.log('Update did not complete — restarting the previous version…')
      await start({ open: false })
    }
    process.exit(1)
  }

  console.log(`Updated to v${readPkgVersion()}.`)
  writeUpdateStatus({ ok: true, version: readPkgVersion() })
  if (wasRunning) {
    console.log('Restarting…')
    await start({ open: false })
  }
}

function help() {
  console.log(`QC Portal v${readPkgVersion()}

Usage:
  qc-portal              start the server (if needed) and open the browser
  qc-portal --open       same as above
  qc-portal --stop       stop the running server
  qc-portal --restart    restart the server
  qc-portal --status     show whether the server is running
  qc-portal --update     update to the latest version and rebuild
  qc-portal --version    print the installed version
  qc-portal --help       show this help

Server URL: ${URL}  (override the port with QC_PORT)`)
}

const arg = (process.argv[2] ?? '').replace(/^--?/, '').toLowerCase()
switch (arg) {
  case '':
  case 'open':
  case 'start':
    await start({ open: true })
    break
  case 'stop':
    stop()
    break
  case 'restart':
    stop()
    // QC_NO_OPEN lets the in-app "Restart" button restart without popping a new
    // browser window (the user already has the portal open).
    await start({ open: !process.env.QC_NO_OPEN })
    break
  case 'status':
    await status()
    break
  case 'update':
  case 'upgrade':
    await update()
    break
  case 'v':
  case 'version':
    console.log(readPkgVersion())
    break
  case 'h':
  case 'help':
    help()
    break
  default:
    console.error(`Unknown command: ${process.argv[2]}\n`)
    help()
    process.exit(1)
}
