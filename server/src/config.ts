import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)) // .../qc-portal/server/src

// Per-project path helpers — every managed project has the same layout under its own root.
export const testingDirFor = (root: string) => path.join(root, 'testing')
// Crawled tickets (+ their test cases) live here: <root>/testing/tickets/<displayId>/.
export const ticketsDirFor = (root: string) => path.resolve(testingDirFor(root), 'tickets')
// QC run results (report.md, issues.md, evidence/, screenshots/) live here:
// <root>/testing/test-result/<ticket-id>-<slug>/. The qc-testing skill writes here.
export const testResultDirFor = (root: string) =>
  path.resolve(testingDirFor(root), 'test-result')
export const skillsDirFor = (root: string) => path.join(root, '.claude', 'skills')
export const mcpJsonFor = (root: string) => path.join(root, '.mcp.json')

// Skills bundled with the portal itself (shipped in the repo at <root>/templates/
// skills/<name>). `init` scaffolds the `qc-testing` skill from here when there's
// no existing project to clone it from — e.g. on a brand-new install. `here` is
// server/dist at runtime, so the repo root is two levels up (same as DB_PATH).
export const BUNDLED_SKILLS_DIR = path.join(here, '..', '..', 'templates', 'skills')
export const bundledSkillDir = (name: string) => path.join(BUNDLED_SKILLS_DIR, name)

// The portal is a STANDALONE tool that manages many projects — it does not assume
// it lives inside any project. Optionally seed ONE default project from QC_REPO_ROOT
// (an absolute repo path). If unset or not a real folder, the portal simply starts
// with whatever projects are already in the database; add more via the Projects page.
function resolveDefaultRoot(): string | null {
  const env = process.env.QC_REPO_ROOT
  if (!env) return null
  const root = path.resolve(env)
  try {
    if (fs.statSync(root).isDirectory()) return root
  } catch {
    /* not a directory */
  }
  return null
}
export const DEFAULT_PROJECT_ROOT: string | null = resolveDefaultRoot()

export const PORT = Number(process.env.QC_PORT ?? 5174)

// The `claude` binary. Override with QC_CLAUDE_BIN if not on PATH.
//
// On Windows the portal server is launched detached by the `qc-portal` command,
// and `%APPDATA%\npm` (where `npm i -g` puts `claude.cmd`) is not always on that
// process's PATH — which surfaces as `spawn claude ENOENT`. So if no override is
// given, probe the standard install locations and use an absolute path when we
// find one. Falls back to plain `claude` (PATH lookup via cross-spawn) so
// non-Windows behaviour is unchanged.
function resolveClaudeBin(): string {
  const override = process.env.QC_CLAUDE_BIN
  if (override) return override
  if (process.platform === 'win32') {
    const { APPDATA, LOCALAPPDATA, USERPROFILE } = process.env
    const candidates = [
      APPDATA && path.join(APPDATA, 'npm', 'claude.cmd'),
      APPDATA && path.join(APPDATA, 'npm', 'claude.exe'),
      LOCALAPPDATA && path.join(LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'),
      USERPROFILE && path.join(USERPROFILE, '.local', 'bin', 'claude.exe'),
      USERPROFILE && path.join(USERPROFILE, 'AppData', 'Local', 'claude', 'claude.exe'),
    ].filter((p): p is string => Boolean(p))
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* not here — try next */
      }
    }
  }
  return 'claude'
}

export const CLAUDE_BIN = resolveClaudeBin()

// Local SQLite database file.
export const DB_PATH =
  process.env.QC_DB_PATH ?? path.join(here, '..', '..', 'data', 'qc-portal.db')

// ---- MCP OAuth ----
// The browser is redirected back here after the user approves. Must match the
// redirect URI registered in each provider's OAuth app exactly.
export const OAUTH_REDIRECT_BASE =
  process.env.QC_OAUTH_REDIRECT_BASE ?? `http://localhost:${PORT}`

/**
 * OAuth app credentials, read from the environment so secrets never live in the
 * repo. Set these in your shell (e.g. ~/.zshrc) before starting the server:
 *   CLICKUP_OAUTH_CLIENT_ID / CLICKUP_OAUTH_CLIENT_SECRET
 *   FIGMA_OAUTH_CLIENT_ID   / FIGMA_OAUTH_CLIENT_SECRET
 * Each app must register the redirect URI: <OAUTH_REDIRECT_BASE>/api/mcp/oauth/<provider>/callback
 */
export const OAUTH_APPS = {
  clickup: {
    clientId: process.env.CLICKUP_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.CLICKUP_OAUTH_CLIENT_SECRET ?? '',
  },
  figma: {
    clientId: process.env.FIGMA_OAUTH_CLIENT_ID ?? '',
    clientSecret: process.env.FIGMA_OAUTH_CLIENT_SECRET ?? '',
    scope: process.env.FIGMA_OAUTH_SCOPE ?? 'file_read',
  },
} as const
