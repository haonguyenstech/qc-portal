import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Router } from 'express'

const execFileAsync = promisify(execFile)

export const versionRouter = Router()

// This file lives in routes/, so at runtime `here` is server/dist/routes (compiled)
// or server/src/routes (tsx watch) — either way the portal install root is THREE
// levels up. This is the same git checkout that `qc-portal --update` pulls into.
const here = path.dirname(fileURLToPath(import.meta.url))
const INSTALL_ROOT = path.join(here, '..', '..', '..')

function readCurrentVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? null
  } catch {
    return null
  }
}

async function git(args: string[], timeout = 15000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: INSTALL_ROOT, timeout })
  return stdout.trim()
}

function parseVersion(json: string): string | null {
  try {
    return (JSON.parse(json) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

// Current installed version — cheap, no git, used for the sidebar footer.
versionRouter.get('/', (_req, res) => {
  res.json({ current: readCurrentVersion() })
})

// Release notes — the portal's own CHANGELOG.md, rendered by the Release Notes page.
versionRouter.get('/changelog', (_req, res) => {
  const current = readCurrentVersion()
  try {
    const markdown = fs.readFileSync(path.join(INSTALL_ROOT, 'CHANGELOG.md'), 'utf8')
    res.json({ current, markdown })
  } catch {
    res.json({ current, markdown: null })
  }
})

// Check whether the upstream tracking branch is ahead of the local checkout.
// Mirrors `qc-portal --update` (git pull --ff-only against the upstream branch),
// so "update available" here means that pull would actually move HEAD forward.
versionRouter.post('/check', async (_req, res) => {
  const current = readCurrentVersion()

  if (!fs.existsSync(path.join(INSTALL_ROOT, '.git'))) {
    return res.json({
      current,
      latest: current,
      updateAvailable: false,
      behind: 0,
      checkedAt: new Date().toISOString(),
      error: 'Not a git checkout — update via your install script.',
    })
  }

  try {
    // Resolve the upstream tracking branch (what `git pull` would use).
    const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    await git(['fetch', '--quiet', '--no-tags'], 30000)
    const behind = Number(await git(['rev-list', '--count', `HEAD..${upstream}`])) || 0
    let latest = current
    try {
      latest = parseVersion(await git(['show', `${upstream}:package.json`])) ?? current
    } catch {
      // Upstream package.json unreadable — fall back to the commit count signal.
    }
    return res.json({
      current,
      latest,
      updateAvailable: behind > 0,
      behind,
      checkedAt: new Date().toISOString(),
      error: null,
    })
  } catch (err) {
    return res.json({
      current,
      latest: current,
      updateAvailable: false,
      behind: 0,
      checkedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : 'Failed to check for updates.',
    })
  }
})

// Guards against firing the updater twice within the same process lifetime.
// (It resets naturally — the updater restarts the server, giving a fresh process.)
let updateStarted = false

// Trigger a self-update. Spawns `qc-portal --update` in a DETACHED process so it
// outlives our own death: the launcher stops this server, runs git pull + npm
// install + npm run build, then restarts it. The browser polls /api/health and
// reloads once the server is back. Same code path as the `qc-portal --update` CLI.
versionRouter.post('/update', (_req, res) => {
  const current = readCurrentVersion()

  if (!fs.existsSync(path.join(INSTALL_ROOT, '.git'))) {
    return res.status(400).json({
      ok: false,
      current,
      error: 'Not a git checkout — update via your install script.',
    })
  }

  const launcher = path.join(INSTALL_ROOT, 'bin', 'qc-portal.mjs')
  if (!fs.existsSync(launcher)) {
    return res.status(400).json({
      ok: false,
      current,
      error: 'Launcher not found — run `qc-portal --update` manually.',
    })
  }

  if (updateStarted) {
    return res.json({ ok: true, current, alreadyRunning: true })
  }
  updateStarted = true

  try {
    const dataDir = path.join(INSTALL_ROOT, 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const out = fs.openSync(path.join(dataDir, 'update.log'), 'a')
    const child = spawn(process.execPath, [launcher, '--update'], {
      cwd: INSTALL_ROOT,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env },
    })
    child.unref()
  } catch (err) {
    updateStarted = false
    return res.status(500).json({
      ok: false,
      current,
      error: err instanceof Error ? err.message : 'Failed to start the update.',
    })
  }

  return res.json({ ok: true, current })
})
