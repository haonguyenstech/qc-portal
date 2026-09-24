import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH, mcpJsonFor } from './config.js'
import { localProjectMcpServers } from './routes/mcp.js'

/**
 * THE ISSUE TRACKER, LOCKED — the hard half of the AI team's approval rule.
 *
 * A team bot runs in the conversation's `full` tool mode with permissions bypassed, so
 * "never file a bug without the human's approval" in its prompt was the ONLY thing
 * standing between a Reporter and a real ClickUp ticket. When `botGuards` says the
 * tracker is locked for a bot, its run gets a COMPLETE MCP config minus every tracker
 * server, passed as `--mcp-config <file> --strict-mcp-config` — the same mechanism (and
 * the same merge of the `~/.claude.json` project scope under `.mcp.json`) as
 * `playwrightRunMode.ts`. Strict is what makes it authoritative: it also drops user-scope
 * servers and claude.ai connectors, one of which may be a tracker we cannot name.
 *
 * Servers are recognised by NAME, COMMAND, ARGS and ENV KEYS — never env values, which are
 * secrets. The file sits beside the DB (never in a repo) and is deleted after the reply.
 */

interface McpEntry {
  command?: string
  args?: unknown
  env?: Record<string, unknown>
  url?: string
  [key: string]: unknown
}

const TRACKER_RE = /clickup|jira|atlassian|linear|youtrack|asana|trello|github|gitlab|azure[-_ ]?devops/i

function isTracker(name: string, entry: McpEntry): boolean {
  const hay = [
    name,
    typeof entry.command === 'string' ? entry.command : '',
    Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string').join(' ') : '',
    typeof entry.url === 'string' ? entry.url : '',
    entry.env && typeof entry.env === 'object' ? Object.keys(entry.env).join(' ') : '',
  ].join(' ')
  return TRACKER_RE.test(hay)
}

/**
 * Write the tracker-free MCP config for one bot reply. Returns the file and the servers
 * left out, or null when it could not be written — the caller then runs with NO MCP at
 * all (`--strict-mcp-config` alone): failing closed, never open.
 */
export function trackerFreeMcpConfig(projectRoot: string, tag: string): { file: string; dropped: string[] } | null {
  let project: Record<string, McpEntry> = {}
  try {
    const data = JSON.parse(fs.readFileSync(mcpJsonFor(projectRoot), 'utf8')) as { mcpServers?: Record<string, McpEntry> }
    project = data.mcpServers ?? {}
  } catch {
    /* no .mcp.json — only the ~/.claude.json project scope, if any */
  }
  let local: Record<string, McpEntry> = {}
  try {
    local = localProjectMcpServers(projectRoot) as unknown as Record<string, McpEntry>
  } catch {
    /* unreadable ~/.claude.json — the project file alone */
  }
  const merged: Record<string, McpEntry> = { ...local, ...project }
  const kept: Record<string, McpEntry> = {}
  const dropped: string[] = []
  for (const [name, entry] of Object.entries(merged)) {
    if (!entry || typeof entry !== 'object') continue
    if (isTracker(name, entry)) dropped.push(name)
    else kept[name] = entry
  }
  const file = path.join(path.dirname(DB_PATH), 'run-mcp', `team-${tag.replace(/[^\w.-]/g, '')}.json`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ mcpServers: kept }, null, 2)}\n`, 'utf8')
  } catch {
    return null
  }
  return { file, dropped }
}

export function clearTeamMcpConfig(file: string | null | undefined): void {
  if (!file) return
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}
