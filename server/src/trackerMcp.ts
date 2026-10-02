import fs from 'node:fs'
import { mcpJsonFor } from './config.js'
import { isAzureLauncher } from './azureSignin.js'

/**
 * Which MCP server in a project's `.mcp.json` talks to each ticket tracker.
 *
 * A tracker can be connected two ways on the MCP page: the token built-in, under its
 * FIXED name (`clickup`, `jira`), or the provider's hosted server signed in to in the
 * browser (`clickup-oauth` → https://mcp.clickup.com/mcp, `atlassian` →
 * https://mcp.atlassian.com/…), under whatever name the engineer kept. Azure DevOps'
 * signed-in server is not hosted: it is Microsoft's local server started by the
 * portal's launcher (azureSignin.ts), recognised by that launcher. Anything that
 * tells the model which tool to call has to name the one that is really there —
 * `mcp__clickup__get_task` in a project that only signed in to `clickup-oauth` is a tool
 * that does not exist, and the model reports the ticket as unreachable.
 *
 * Reads the file only (names, `url`); never a token. Never throws.
 */

export type Tracker = 'clickup' | 'jira' | 'azure'

export interface TrackerServer {
  /** The server's key in .mcp.json — the `<name>` in `mcp__<name>__<tool>`. */
  name: string
  /** `token` = the built-in (also what ticket crawl and issue filing read);
   *  `oauth` = the hosted server, signed in to in the browser. */
  kind: 'token' | 'oauth'
}

type Entry = { url?: unknown; command?: unknown; args?: unknown }

const SIGNED_IN: Record<Tracker, (e: Entry) => boolean> = {
  clickup: (e) => typeof e.url === 'string' && /^https:\/\/mcp\.clickup\.com\//i.test(e.url),
  jira: (e) => typeof e.url === 'string' && /^https:\/\/mcp\.atlassian\.com\//i.test(e.url),
  azure: isAzureLauncher,
}

/** Every server for `tracker`, the token built-in first. */
export function trackerServers(root: string, tracker: Tracker): TrackerServer[] {
  let servers: Record<string, Entry> = {}
  try {
    const parsed = JSON.parse(fs.readFileSync(mcpJsonFor(root), 'utf8'))
    if (parsed && typeof parsed.mcpServers === 'object') servers = parsed.mcpServers
  } catch {
    return []
  }
  const out: TrackerServer[] = []
  if (servers[tracker]) out.push({ name: tracker, kind: 'token' })
  for (const [name, entry] of Object.entries(servers)) {
    if (name === tracker) continue
    if (entry && typeof entry === 'object' && SIGNED_IN[tracker](entry)) {
      out.push({ name, kind: 'oauth' })
    }
  }
  return out
}

// ---- One ticket tracker per project ----------------------------------------------

export const TRACKERS: readonly Tracker[] = ['clickup', 'jira', 'azure']
export const TRACKER_LABEL: Record<Tracker, string> = { clickup: 'ClickUp', jira: 'Jira', azure: 'Azure DevOps' }

/**
 * Which tracker an entry about to be written would connect: one of the token built-ins
 * by its FIXED name, or a signed-in server (hosted URL / the Azure launcher) under any
 * name. Null for everything else.
 */
export function trackerOfEntry(name: string, entry: Entry | undefined): Tracker | null {
  if ((TRACKERS as readonly string[]).includes(name)) return name as Tracker
  if (!entry || typeof entry !== 'object') return null
  return TRACKERS.find((t) => SIGNED_IN[t](entry)) ?? null
}

/**
 * A project reads its tickets from ONE tracker, connected ONCE. Returns the refusal for
 * connecting `wanted` — while another tracker is configured, or (unless `allowSame`) while
 * `wanted` itself already is, token or sign-in, any name — naming the server to remove;
 * null when it is fine. `ignore` is a server being replaced (an edit, a token re-saved
 * over its own entry), which does not count against itself. `allowSame` is for a
 * re-sign-in, which relinks the row that is already there.
 */
export function trackerConflict(
  root: string,
  wanted: Tracker,
  ignore?: string,
  opts: { allowSame?: boolean } = {},
): string | null {
  for (const t of TRACKERS) {
    if (t === wanted && opts.allowSame) continue
    const other = trackerServers(root, t).find((s) => s.name !== ignore)
    if (!other) continue
    if (t === wanted) {
      return (
        `${TRACKER_LABEL[t]} is already connected in this project ("${other.name}"). Disconnect it on the ` +
        `MCP page first if you want to connect it another way.`
      )
    }
    return (
      `This project already uses ${TRACKER_LABEL[t]} ("${other.name}") for its tickets — one ticket ` +
      `tracker per project. Disconnect "${other.name}" on the MCP page first, then add ${TRACKER_LABEL[wanted]}.`
    )
  }
  return null
}
