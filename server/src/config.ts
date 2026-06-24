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
export const CLAUDE_BIN = process.env.QC_CLAUDE_BIN ?? 'claude'

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
