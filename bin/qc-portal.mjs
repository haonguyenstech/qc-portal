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
  if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
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

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: isWin })
  if (r.status !== 0) {
    console.error(`\n\`${cmd} ${args.join(' ')}\` failed.`)
    process.exit(r.status ?? 1)
  }
}

// The branch this checkout tracks (the installer clones `main`); fall back to it.
function currentBranch() {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: isWin,
  })
  const name = (r.stdout ?? '').trim()
  return name && name !== 'HEAD' ? name : 'main'
}

async function update() {
  const wasRunning = await ping()
  if (wasRunning) {
    console.log('Stopping server before update…')
    stop()
  }
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    console.log('Pulling latest…')
    const branch = currentBranch()
    run('git', ['fetch', 'origin', branch])
    // Force the checkout to match the remote. A plain `git pull --ff-only` aborts
    // the moment a tracked file is dirty, and `npm install` routinely rewrites the
    // tracked package-lock.json (different npm version / platform-specific optional
    // deps, esp. on Windows) — which silently blocked every subsequent update. A
    // hard reset to the upstream tip discards those local edits and always advances.
    run('git', ['reset', '--hard', `origin/${branch}`])
  } else {
    console.warn('Not a git checkout — skipping pull. Re-run the install script to update the source.')
  }
  console.log('Installing dependencies…')
  run('npm', ['install'])
  console.log('Building…')
  run('npm', ['run', 'build'])
  console.log(`Updated to v${readPkgVersion()}.`)
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
