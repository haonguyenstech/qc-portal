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

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Well-known per-user tool dirs that are frequently missing from a stale PATH. */
function extraToolDirs(): string[] {
  const home = os.homedir()
  const dirs = [
    path.join(home, '.local', 'bin'), // uv's default install dir (all platforms)
    path.join(home, '.cargo', 'bin'), // rustup/cargo installs (older uv installers)
  ]
  if (process.platform === 'win32') {
    // winget puts shims for its packages (incl. astral-sh.uv) here.
    const local = process.env.LOCALAPPDATA
    if (local) dirs.push(path.join(local, 'Microsoft', 'WinGet', 'Links'))
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
