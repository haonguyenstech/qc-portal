import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH, mcpJsonFor } from './config.js'
import {
  playwrightHeadlessMcpConfigPath,
  writeHeadlessPlaywrightMcpConfig,
  writePlaywrightMcpConfig,
} from './qcBrowser.js'
import { localProjectMcpServers } from './routes/mcp.js'

/**
 * PER-RUN headless / headed browser choice for a web QC run.
 *
 * The project's `.mcp.json` fixes one browser mode for every run (the checkbox on the
 * MCP page). But headless-or-not is a property of THE RUN, not of the project: the same
 * engineer wants to watch a flaky login flow with their own eyes and then let a long
 * regression sweep run without a window stealing focus. `/qc-run` therefore carries its
 * own checkbox, and this module makes it take effect **without touching the project's
 * `.mcp.json`** — that file is the engineer's saved default and a run must not rewrite
 * it behind their back (a concurrent chat turn reads the same file).
 *
 * How: build a COMPLETE MCP config for this one run — every server the project has,
 * with only the Playwright entry's browser mode swapped — write it beside the DB and
 * hand it to the CLI as `--mcp-config <file> --strict-mcp-config`. Strict is what makes
 * the override authoritative (with both configs live, which one wins for a duplicate
 * server name is undocumented), so the config has to be complete or a run would lose
 * ClickUp/Jira/Maestro halfway through. Hence the merge of `localProjectMcpServers`
 * (the `~/.claude.json` project scope the MCP page also lists) under the `.mcp.json`
 * entries, which win.
 *
 * Two cases return null — no override, spawn the run exactly as before:
 *  - **The project already runs in the requested mode.** The common case (a headed
 *    project, box unchecked) then behaves bit-for-bit like it did before this existed.
 *  - **Attach mode** (`--cdp-endpoint`): the browser is the portal-owned QC browser,
 *    already open and visible, and this MCP launches nothing — `--headless` describes a
 *    launch that never happens. See `qcBrowser.ts`.
 */

interface McpEntry {
  command?: string
  args?: string[]
  [key: string]: unknown
}

interface McpFile {
  mcpServers?: Record<string, McpEntry>
}

export interface PlaywrightRunMode {
  /** Path of the per-run MCP config to pass to the CLI, or null when none is needed. */
  override: string | null
  /** Why no override was written — only set when `override` is null. */
  reason?: 'already' | 'attached' | 'no-playwright' | 'unreadable'
}

function dropArg(args: string[], flag: string, hasValue: boolean): void {
  const i = args.indexOf(flag)
  if (i === -1) return
  const value = args[i + 1]
  args.splice(i, hasValue && typeof value === 'string' && !value.startsWith('--') ? 2 : 1)
}

function setArg(args: string[], flag: string, value: string): void {
  const i = args.indexOf(flag)
  if (i === -1) {
    args.push(flag, value)
    return
  }
  const current = args[i + 1]
  if (typeof current !== 'string' || current.startsWith('--')) args.splice(i + 1, 0, value)
  else args[i + 1] = value
}

/** Where this run's config file lives — beside the DB, never inside a project repo. */
function runConfigPath(runId: string): string {
  return path.join(path.dirname(DB_PATH), 'run-mcp', `${runId.replace(/[^\w.-]/g, '')}.json`)
}

/**
 * Prepare the MCP config for one run's browser mode. Returns the file to pass as
 * `--mcp-config` (with `--strict-mcp-config`), or null with the reason it wasn't needed.
 */
export function playwrightRunConfig(
  runId: string,
  projectRoot: string,
  headless: boolean,
): PlaywrightRunMode {
  let data: McpFile
  try {
    data = JSON.parse(fs.readFileSync(mcpJsonFor(projectRoot), 'utf8')) as McpFile
  } catch {
    return { override: null, reason: 'unreadable' }
  }
  const playwright = data.mcpServers?.playwright
  if (!playwright || !Array.isArray(playwright.args)) {
    return { override: null, reason: 'no-playwright' }
  }
  if (playwright.args.includes('--cdp-endpoint')) return { override: null, reason: 'attached' }
  if (playwright.args.includes('--headless') === headless) {
    return { override: null, reason: 'already' }
  }

  const args = [...playwright.args]
  if (headless) {
    args.push('--headless')
    const cfg = writeHeadlessPlaywrightMcpConfig() ?? playwrightHeadlessMcpConfigPath()
    setArg(args, '--config', cfg)
  } else {
    dropArg(args, '--headless', false)
    const cfg = writePlaywrightMcpConfig()
    if (cfg) setArg(args, '--config', cfg)
  }

  const merged: Record<string, McpEntry> = {
    ...localProjectMcpServers(projectRoot),
    ...(data.mcpServers ?? {}),
    playwright: { ...playwright, args },
  }
  const file = runConfigPath(runId)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mcpServers: merged }, null, 2) + '\n', 'utf8')
  } catch {
    // Can't write it → run with the project's own config rather than failing the run.
    return { override: null, reason: 'unreadable' }
  }
  return { override: file }
}

/** Delete a finished run's config file — it describes one run and nothing reads it after. */
export function clearPlaywrightRunConfig(runId: string): void {
  try {
    fs.rmSync(runConfigPath(runId), { force: true })
  } catch {
    /* best effort */
  }
}
