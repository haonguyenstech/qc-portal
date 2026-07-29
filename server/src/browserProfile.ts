import os from 'node:os'
import path from 'node:path'

/**
 * Where the persistent Chrome profile lives — the directory Playwright MCP is given
 * as `--user-data-dir`, so a QC run inherits the engineer's existing login session
 * instead of starting from a cold browser every time.
 *
 * This MUST be resolved on the SERVER, never in the browser bundle: the web app has
 * no idea whose machine the portal is running on, so a path baked into the UI is
 * whatever machine the code was written on. Shipping one produced the EPERM that
 * blocked runs on Windows — `mkdir 'C:\Users\hao.nguyen'` while the signed-in user
 * was someone else entirely.
 */
export function agentProfileDir(): string {
  return process.env.QC_SCAN_PROFILE_DIR || path.join(os.homedir(), '.pw-agent-profile')
}

/**
 * True when `dir` is not inside this machine's home directory — i.e. it came from
 * somewhere else and this user almost certainly can't write to it. Used to decide
 * whether a `--user-data-dir` already in a project's .mcp.json needs repairing; a
 * custom-but-local profile the engineer chose on purpose is left alone.
 */
export function isForeignProfileDir(dir: string): boolean {
  const home = os.homedir()
  if (!home) return false
  const rel = path.relative(home, dir)
  // Outside home when relative traversal escapes it (`..`) or stays absolute
  // (a different drive/root entirely).
  return rel.startsWith('..') || path.isAbsolute(rel)
}
