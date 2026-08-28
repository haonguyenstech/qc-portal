// PATH hardening for spawned children (claude, uvx, npx, shells).
//
// The portal server inherits PATH from however it was launched — a shortcut, an
// old terminal, a service — which often predates user-level tool installs. The
// classic symptom: `uvx` works in a fresh terminal, but every uvx-based MCP
// server (ClickUp, Jira) shows "Failed to connect" in the portal, because the
// `claude` child we spawn (and the MCP servers *it* spawns from .mcp.json)
// never sees `%USERPROFILE%\.local\bin`. Rather than asking users to hardcode
// absolute paths in .mcp.json, append the well-known per-user tool directories
// to PATH for every child the portal spawns.

import crossSpawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Where the Android SDK usually lives, so `adb` (and `emulator`) resolve for
 * Maestro's Android driver and for our friendly-device-name lookup. Android
 * Studio doesn't put platform-tools on PATH, so a portal launched from a shortcut
 * almost never sees it.
 */
function androidSdkDirs(): string[] {
  const home = os.homedir()
  const roots: string[] = []
  for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (env) roots.push(env)
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA
    if (local) roots.push(path.join(local, 'Android', 'Sdk'))
  } else if (process.platform === 'darwin') {
    roots.push(path.join(home, 'Library', 'Android', 'sdk'))
  } else {
    roots.push(path.join(home, 'Android', 'Sdk'))
  }
  return roots.flatMap((root) => [path.join(root, 'platform-tools'), path.join(root, 'emulator')])
}

/**
 * Third-party Android emulators (MuMu, LDPlayer, BlueStacks, Nox) each ship their
 * OWN `adb` and are frequently the only Android tooling on a QC machine — the
 * engineer never installed Android Studio, so `androidSdkDirs()` finds nothing and
 * every device reads as a bare `127.0.0.1:7555` in the device pickers because
 * nothing can be asked for its name.
 *
 * Appended LAST (see spawnEnv), so a real platform-tools adb always wins — these
 * bundled copies are often an old adb version, and an old client kills a newer
 * running adb server.
 */
function bundledEmulatorDirs(): string[] {
  if (process.platform !== 'win32') return []
  const dirs: string[] = []
  for (const base of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)']]) {
    if (!base) continue
    for (const p of [
      ['Netease', 'MuMuPlayer-12.0', 'shell'],
      ['Netease', 'MuMuPlayerGlobal-12.0', 'shell'],
      ['Netease', 'MuMu', 'emulator', 'nemu', 'vmonitor', 'bin'],
      ['BlueStacks_nxt'],
      ['BlueStacks'],
      ['Nox', 'bin'],
    ]) {
      dirs.push(path.join(base, ...p))
    }
  }
  // LDPlayer installs to a drive root by default rather than Program Files.
  const systemDrive = process.env.SystemDrive ?? 'C:'
  for (const p of [
    ['LDPlayer', 'LDPlayer9'],
    ['LDPlayer', 'LDPlayer64'],
  ]) {
    dirs.push(path.join(`${systemDrive}\\`, ...p))
  }
  return dirs
}

/** Well-known per-user tool dirs that are frequently missing from a stale PATH. */
function extraToolDirs(): string[] {
  const home = os.homedir()
  const dirs = [
    path.join(home, '.local', 'bin'), // uv's default install dir (all platforms)
    path.join(home, '.cargo', 'bin'), // rustup/cargo installs (older uv installers)
    path.join(home, '.maestro', 'bin'), // Maestro's curl installer (all platforms)
    ...androidSdkDirs(),
    ...bundledEmulatorDirs(),
  ]
  if (process.platform === 'win32') {
    // winget puts shims for its packages (incl. astral-sh.uv) here.
    const local = process.env.LOCALAPPDATA
    if (local) dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'))
    // Where `npm i -g` puts its .cmd shims (claude, auto-agent-ai). Frequently missing
    // from the PATH of a server launched detached by the `qc-portal` command — the same
    // gap `resolveClaudeBin()` works around with explicit candidates, and the reason a
    // perfectly good `npm i -g @saigontechnology/auto-agent` could read as "not installed".
    const appData = process.env.APPDATA
    if (appData) dirs.push(path.join(appData, 'npm'))
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  }
  return dirs
}

/**
 * A copy of process.env (plus `extra` overrides) whose PATH additionally
 * contains every well-known tool dir that exists on this machine. Existing
 * PATH entries always win — the extras are appended, never prepended.
 */
export function spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  // Windows spells it "Path" (env keys there are case-insensitive) — reuse the
  // existing key so we don't end up with two PATH-ish entries in the child.
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = (env[pathKey] ?? '').split(path.delimiter).filter(Boolean)
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const seen = new Set(current.map(norm))
  const additions = extraToolDirs().filter((dir) => {
    if (seen.has(norm(dir))) return false
    try {
      return fs.statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
  if (additions.length) env[pathKey] = [...current, ...additions].join(path.delimiter)
  return env
}

/**
 * Kill a spawned child **and its descendants** on both platforms.
 *
 * Windows has no process groups, and on Windows every CLI we spawn is a `.cmd` shim —
 * so cross-spawn actually starts `cmd.exe`, and `child.kill()` reaches only that
 * wrapper. The real process (e.g. `node auto-agent-ai login`, still holding its
 * loopback OAuth server open) survives, which turns "cancelled" into "still running
 * where nobody can see it". `taskkill /T` walks the tree by pid instead; `/F` forces it.
 *
 * For children spawned WITHOUT `detached`. QC runs use `killTree` in `claude.ts`,
 * which additionally signals the POSIX process GROUP because it spawns detached (and
 * has a whole tree of MCP servers and a browser to take down with it) — keep both:
 * this one's posix branch would not reach a group, and that one's would fail here.
 */
export function killSpawnedTree(child: ChildProcess): void {
  const fallback = () => {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  if (process.platform !== 'win32' || child.pid == null) {
    fallback()
    return
  }
  try {
    crossSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', fallback)
  } catch {
    fallback()
  }
}
