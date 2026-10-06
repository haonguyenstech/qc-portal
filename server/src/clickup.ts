// Thin read-only ClickUp REST client used to power the ticket picker, docs, etc.
//
// The portal already has a ClickUp MCP server for Claude, but that's a stdio
// process meant for the agent — not something the web server can query. What we
// reuse is the same personal token to hit ClickUp's public REST API directly.
// The token stays on the server; the browser never sees it.
//
// Token source:
//   The active project's .mcp.json clickup entry (what the in-app "Connect"
//   button writes) — resolved per request via AsyncLocalStorage, so pasting a
//   fresh token in the UI takes effect immediately, no server restart. A project
//   entry may itself reference `${CLICKUP_API_KEY}` to pull from the environment.
//
// There is deliberately NO standalone env-var fallback: if a project's .mcp.json
// has no clickup server, ClickUp is treated as unconfigured for that project and
// the ticket UI stays empty. This keeps /tickets in lockstep with /mcp — configure
// ClickUp in MCP to see ClickUp tickets, remove it to hide them.

import { projectIdForRoot } from './projectScope.js'
import { clickupSigninToken } from './clickupMcp.js'
import { callHostedTool, hostedSite } from './hostedMcp.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { mcpJsonFor } from './config.js'

const API = 'https://api.clickup.com/api/v2'
const API_V3 = 'https://api.clickup.com/api/v3'

// Per-request token override. Set by withClickupToken(); read by currentToken().
const tokenStore = new AsyncLocalStorage<string>()

/** Run `fn` with `token` as the active ClickUp token (falls back to env if undefined). */
export function withClickupToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  return token ? tokenStore.run(token, fn) : fn()
}

/** The token in effect for this request: the active project's .mcp.json token, or none. */
function currentToken(): string | undefined {
  return tokenStore.getStore() ?? undefined
}

/**
 * Read the ClickUp token from a project's .mcp.json clickup entry. Accepts the
 * literal token (what the Connect/OAuth flow writes) or a `${ENV_VAR}` reference
 * (resolved against the environment). Returns undefined if none is usable.
 */
export function resolveProjectClickupToken(projectRoot: string): string | undefined {
  try {
    const raw = fs.readFileSync(mcpJsonFor(projectRoot), 'utf8')
    const env = JSON.parse(raw)?.mcpServers?.clickup?.env
    // No `clickup` entry is NOT "not configured" yet — the browser sign-in below may be.
    if (env && typeof env === 'object') {
      for (const key of ['CLICKUP_API_KEY', 'CLICKUP_MCP_API_KEY']) {
        let v = env[key]
        if (typeof v !== 'string' || !v) continue
        const ref = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
        if (ref) v = process.env[ref[1]] ?? ''
        if (v) return v
      }
    }
  } catch {
    /* no file / bad json */
  }
  // No API token — the portal's browser sign-in to ClickUp's hosted server, if any
  // (clickupMcp.ts). Sync on purpose: ~15 callers read this; the routes refresh the
  // token first (`refreshClickupSignin`) so what is read here is current.
  const projectId = projectIdForRoot(projectRoot)
  return projectId ? clickupSigninToken(projectId) : undefined
}

export function clickupConfigured(): boolean {
  return !!currentToken()
}

function token(): string {
  const t = currentToken()
  if (!t) throw Object.assign(new Error('ClickUp is not configured (no token)'), { status: 400 })
  return t
}

// ---- Browser sign-in: the same reads/writes through ClickUp's hosted MCP tools ----
//
// The token from ClickUp's hosted MCP sign-in is NOT accepted by the REST API
// (measured: `401 {"err":"Oauth token not found","ECODE":"OAUTH_019"}`), so a project
// signed in through the browser (clickupMcp.ts) gets the marker `mcp:<projectId>` as
// its "token", and every function below that the Tickets page and Run → Issues filing
// use branches to the MCP tools — returning the SAME normalized shapes, so nothing
// downstream knows the difference. Anything else that only REST can do (Docs) says so
// plainly instead of surfacing ClickUp's confusing 401 (`restNeedsToken`).

export const MCP_TOKEN_PREFIX = 'mcp:'
/** An attachment to fetch through the MCP download tool: `mcp-attachment:<task>|<id>`. */
const MCP_ATTACHMENT = 'mcp-attachment:'

/** The project whose browser sign-in this request uses, or null for a REST token. */
function mcpProject(): string | null {
  const t = currentToken()
  return t?.startsWith(MCP_TOKEN_PREFIX) ? t.slice(MCP_TOKEN_PREFIX.length) : null
}

function restNeedsToken(): Error {
  return Object.assign(
    new Error(
      'This ClickUp feature needs an API token — the browser sign-in covers tickets and issue filing, not this.',
    ),
    { status: 400 },
  )
}

/** One ClickUp MCP tool call for the signed-in project, in its workspace. */
async function mcpCall(name: string, args: Record<string, unknown>): Promise<any> {
  const projectId = mcpProject()!
  const k = { provider: 'clickup' as const, projectId }
  const workspace = (() => {
    try {
      return hostedSite(k).cloudId
    } catch {
      return ''
    }
  })()
  return callHostedTool(k, name, workspace ? { workspace_id: workspace, ...args } : args)
}

/** A created task, whether the tool answers with it or wraps it (`{task}`). */
function unwrapTask(data: any): any {
  return data?.task?.id ? data.task : data
}

/** MCP task rows carry `status` as a bare string (REST: `{status, color}`). */
function toHitMcp(t: any): TaskHit {
  const customId = t.custom_id ? String(t.custom_id) : null
  const status = typeof t.status === 'string' ? t.status : String(t.status?.status ?? '')
  return {
    id: String(t.id),
    customId,
    displayId: customId ?? String(t.id),
    name: String(t.name ?? ''),
    status,
    statusColor: String(t.status_color ?? t.status?.color ?? ''),
    listName: String(t.list?.name ?? t.hierarchy?.subcategory?.name ?? ''),
    url: String(t.url ?? ''),
    parent: t.parent ? String(t.parent) : null,
  }
}

/** Every task of a filter, newest first, paged like the REST list (100 / page). */
async function mcpFilterTasks(
  filter: Record<string, unknown>,
  query: string,
  maxPages: number,
): Promise<TaskHit[]> {
  const q = query.trim().toLowerCase()
  const hits: TaskHit[] = []
  for (let page = 0; page < maxPages; page++) {
    const data = await mcpCall('clickup_filter_tasks', {
      ...filter,
      page,
      order_by: 'updated',
      subtasks: !!q,
      include_closed: false,
    })
    const tasks: any[] = data?.tasks ?? []
    for (const t of tasks) {
      const hit = toHitMcp(t)
      if (!q || `${hit.displayId} ${hit.name}`.toLowerCase().includes(q)) hits.push(hit)
      if (hits.length >= 100) break
    }
    if (hits.length >= 100 || tasks.length < 100) break
  }
  return hits.slice(0, 100)
}

/** The workspace tree (spaces → folders → lists), every page of spaces. */
async function mcpHierarchy(depth: '0' | '2'): Promise<any[]> {
  const spaces: any[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const data = await mcpCall('clickup_get_workspace_hierarchy', {
      max_depth: depth,
      limit: 50,
      ...(cursor ? { cursor } : {}),
    })
    spaces.push(...((data?.hierarchy?.root?.children ?? []) as any[]))
    if (!data?.has_more || !data?.next_cursor) break
    cursor = String(data.next_cursor)
  }
  return spaces.filter((n) => n?.type === 'space')
}

async function cuFetchAt(base: string, pathAndQuery: string, init?: RequestInit): Promise<any> {
  if (mcpProject()) throw restNeedsToken()
  const res = await fetch(`${base}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: token(),
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`ClickUp API ${res.status}: ${body.slice(0, 200)}`), {
      status: res.status === 401 || res.status === 403 ? 502 : 502,
    })
  }
  if (res.status === 204) return null
  return res.json()
}

async function cuFetch(pathAndQuery: string): Promise<any> {
  return cuFetchAt(API, pathAndQuery)
}

async function cuPost(pathAndQuery: string, body: unknown): Promise<any> {
  return cuFetchAt(API, pathAndQuery, { method: 'POST', body: JSON.stringify(body) })
}

async function cuFetchV3(pathAndQuery: string): Promise<any> {
  return cuFetchAt(API_V3, pathAndQuery)
}

/**
 * Live-validate the configured token against ClickUp's API. The MCP "connected"
 * badge only reflects the stdio handshake — the token is never exercised there,
 * so a dead/expired token still shows connected. This hits /user so the UI can
 * surface "needs auth" for an invalid token.
 */
export async function verifyToken(): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const t = currentToken()
  if (t?.startsWith(MCP_TOKEN_PREFIX)) return { ok: true, status: null, detail: 'Signed in with the browser.' }
  if (!t) return { ok: false, status: null, detail: 'No ClickUp token is configured.' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`${API}/user`, { headers: { Authorization: t }, signal: ctrl.signal })
    clearTimeout(timer)
    if (res.ok) return { ok: true, status: res.status, detail: 'Token valid.' }
    const body = await res.text().catch(() => '')
    const invalid = res.status === 401 || res.status === 403
    return {
      ok: false,
      status: res.status,
      detail: invalid
        ? 'Token rejected by ClickUp (invalid or expired). Disconnect and reconnect with a fresh token.'
        : `ClickUp API ${res.status}: ${body.slice(0, 120)}`,
    }
  } catch (e) {
    return { ok: false, status: null, detail: e instanceof Error ? e.message : 'Token check failed.' }
  }
}

export interface Workspace {
  id: string
  name: string
}

export async function getWorkspaces(): Promise<Workspace[]> {
  if (mcpProject()) {
    const data = await mcpCall('clickup_get_workspace_hierarchy', { max_depth: '0', limit: 1 })
    const root = data?.hierarchy?.root
    return root?.id ? [{ id: String(root.id), name: String(root.name ?? root.id) }] : []
  }
  const data = await cuFetch('/team')
  return (data.teams ?? []).map((t: any) => ({ id: String(t.id), name: String(t.name ?? t.id) }))
}

export interface TaskHit {
  id: string
  customId: string | null
  displayId: string // custom id when present, else the raw id — what goes in the form
  name: string
  status: string
  statusColor: string
  listName: string
  url: string
  parent: string | null // internal id of the parent task when this is a subtask
}

function toHit(t: any): TaskHit {
  const customId = t.custom_id ? String(t.custom_id) : null
  return {
    id: String(t.id),
    customId,
    displayId: customId ?? String(t.id),
    name: String(t.name ?? ''),
    status: String(t.status?.status ?? ''),
    statusColor: String(t.status?.color ?? ''),
    listName: String(t.list?.name ?? ''),
    url: String(t.url ?? ''),
    parent: t.parent ? String(t.parent) : null,
  }
}

/**
 * Search open tasks in a workspace by substring of id / custom id / name.
 * ClickUp's REST API has no free-text task search, so we page recent tasks
 * (newest first) and filter in-process. Capped to keep it snappy.
 *
 * With NO query, top-level tickets only (subtasks=false) — subtasks are loaded on
 * demand when a parent is expanded, so the page cap is spent on distinct parents.
 * With a query, subtasks=true so a search can match a SUBTASK by its id/name too
 * (otherwise subtasks — never in the flat list — would be unsearchable).
 */
export async function searchTasks(teamId: string, query: string): Promise<TaskHit[]> {
  if (mcpProject()) return mcpFilterTasks({}, query, 6)
  const q = query.trim().toLowerCase()
  const includeSubtasks = q ? 'true' : 'false'
  const hits: TaskHit[] = []
  const MAX_PAGES = 6
  const MAX_HITS = 100

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await cuFetch(
      `/team/${encodeURIComponent(teamId)}/task` +
        `?page=${page}&order_by=updated&reverse=true&subtasks=${includeSubtasks}&include_closed=false`,
    )
    const tasks: any[] = data.tasks ?? []
    for (const t of tasks) {
      const hit = toHit(t)
      const hay = `${hit.displayId} ${hit.name}`.toLowerCase()
      if (!q || hay.includes(q)) hits.push(hit)
      if (hits.length >= MAX_HITS) break
    }
    if (hits.length >= MAX_HITS || tasks.length < 100) break // last page reached
  }
  return hits.slice(0, MAX_HITS)
}

// ---- list-scoped browsing (workspace → space → list → tasks) ----

export interface Space {
  id: string
  name: string
}

export async function getSpaces(teamId: string): Promise<Space[]> {
  if (mcpProject()) {
    return (await mcpHierarchy('0')).map((sp) => ({ id: String(sp.id), name: String(sp.name ?? sp.id) }))
  }
  const data = await cuFetch(`/team/${encodeURIComponent(teamId)}/space?archived=false`)
  return (data.spaces ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name ?? s.id) }))
}

export interface ListRef {
  id: string
  name: string
  folderName: string | null // null when the list lives directly under a space
}

export async function getLists(spaceId: string): Promise<ListRef[]> {
  const out: ListRef[] = []
  if (mcpProject()) {
    const space = (await mcpHierarchy('2')).find((sp) => String(sp.id) === String(spaceId))
    for (const node of space?.children ?? []) {
      if (node.type === 'list') out.push({ id: String(node.id), name: String(node.name ?? node.id), folderName: null })
      if (node.type === 'folder') {
        for (const l of node.children ?? []) {
          if (l.type === 'list') out.push({ id: String(l.id), name: String(l.name ?? l.id), folderName: String(node.name ?? '') })
        }
      }
    }
    return out
  }

  // Lists nested inside folders — the folder response already embeds its lists.
  const folders = await cuFetch(`/space/${encodeURIComponent(spaceId)}/folder?archived=false`)
  for (const f of folders.folders ?? []) {
    for (const l of f.lists ?? []) {
      out.push({ id: String(l.id), name: String(l.name ?? l.id), folderName: String(f.name ?? '') })
    }
  }

  // Folderless lists directly under the space.
  const lists = await cuFetch(`/space/${encodeURIComponent(spaceId)}/list?archived=false`)
  for (const l of lists.lists ?? []) {
    out.push({ id: String(l.id), name: String(l.name ?? l.id), folderName: null })
  }

  return out
}

/**
 * Top-level tasks in a single list — complete and accurate (no recency window).
 * Paginated fully (capped), optionally filtered by an id/name substring.
 *
 * With NO query, subtasks=false so the cap counts only parent tickets; a parent's
 * subtasks are fetched on demand via getSubtasks() when its row is expanded. With a
 * query, subtasks=true so the search can also match a SUBTASK by its id/name.
 */
export async function getListTasks(listId: string, query: string): Promise<TaskHit[]> {
  if (mcpProject()) {
    const hits = await mcpFilterTasks({ list_ids: [listId] }, query, 10)
    // MCP task rows carry no status colour; the list's status definitions do, so the
    // status groups get their real ClickUp colours instead of all-grey pills.
    const list = await mcpCall('clickup_get_list', { list_id: listId }).catch(() => null)
    const colour = new Map<string, string>(
      ((list?.statuses ?? []) as any[]).map((st) => [String(st.status).toLowerCase(), String(st.color ?? '')]),
    )
    return hits.map((h) => (h.statusColor ? h : { ...h, statusColor: colour.get(h.status.toLowerCase()) ?? '' }))
  }
  const q = query.trim().toLowerCase()
  const includeSubtasks = q ? 'true' : 'false'
  const hits: TaskHit[] = []
  const MAX_PAGES = 10 // 1000 tasks — plenty for one QC list
  const MAX_HITS = 100

  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await cuFetch(
      `/list/${encodeURIComponent(listId)}/task` +
        `?page=${page}&order_by=updated&reverse=true&subtasks=${includeSubtasks}&archived=false&include_closed=false`,
    )
    const tasks: any[] = data.tasks ?? []
    for (const t of tasks) {
      const hit = toHit(t)
      const hay = `${hit.displayId} ${hit.name}`.toLowerCase()
      if (!q || hay.includes(q)) hits.push(hit)
      if (hits.length >= MAX_HITS) break
    }
    if (hits.length >= MAX_HITS || tasks.length < 100) break
  }
  return hits.slice(0, MAX_HITS)
}

/**
 * Subtasks (all descendants) of one parent task, loaded on demand. Uses the task
 * detail endpoint with include_subtasks, which returns the whole subtree in one
 * call; each row keeps its own `parent` so the UI can nest them to any depth.
 */
export async function getSubtasks(parentId: string): Promise<TaskHit[]> {
  if (mcpProject()) {
    const data = await mcpCall('clickup_get_task', { task_id: parentId, include: ['subtasks'] })
    return ((data?.subtasks ?? []) as any[]).filter((t) => String(t.id) !== String(parentId)).map(toHitMcp)
  }
  const data = await cuFetch(
    `/task/${encodeURIComponent(parentId)}?include_subtasks=true`,
  )
  const subs: any[] = data.subtasks ?? []
  return subs.filter((s) => String(s.id) !== String(parentId)).map(toHit)
}

export interface CreatedClickupTask {
  id: string
  customId: string | null
  displayId: string
  name: string
  url: string
  parent: string | null
}

export interface CreateSubtaskInput {
  parentTask: string
  name: string
  description: string
  /** The issue's own severity word ("high", "blocker", …) — sets the bug's priority. */
  severity?: string | null
  /** Pre-fetched parent context, so filing N issues costs ONE parent lookup, not N. */
  context?: IssueFilingContext
  /** Give the subtask the parent's assignees (the project's setting; default true). */
  inheritAssignees?: boolean
}

/**
 * What the portal inherits from the parent ticket when filing a bug under it. Fetched
 * ONCE per filing batch (the parent doesn't change between issues) and also served to
 * the UI, so the engineer can see who the bug will land on BEFORE pressing the button —
 * "it fills this in automatically" is only trustworthy if it shows what it will fill in.
 */
export interface IssueFilingContext {
  id: string
  displayId: string
  name: string
  url: string
  listId: string
  listName: string
  /** ClickUp create takes user IDs; the usernames are for display only. */
  assignees: { id: number; username: string }[]
  /** Tag NAMES, which is what create expects (they must already exist in the space). */
  tags: string[]
  /** The parent's own priority, used when an issue has no severity of its own. */
  priority: { id: number; label: string } | null
}

/** ClickUp priority ids. 1 = Urgent … 4 = Low; there is no 0/none on create. */
const PRIORITY_LABEL: Record<number, string> = {
  1: 'Urgent',
  2: 'High',
  3: 'Normal',
  4: 'Low',
}

/**
 * Map a QC severity word onto a ClickUp priority. A bug's OWN severity is the better
 * signal than the parent ticket's priority — a High-severity defect under a feature
 * ticket with no priority set (the common case; verified on a real ticket) would
 * otherwise be filed with no priority at all, which is what the QC had to fix by hand.
 * The parent's priority stays as the fallback for an issue with no severity recorded.
 */
export function severityPriority(severity?: string | null): { id: number; label: string } | null {
  const s = (severity ?? '').trim().toLowerCase()
  if (!s) return null
  let id: number | null = null
  if (/blocker|critical|urgent|showstopper/.test(s)) id = 1
  else if (/high|major|severe/.test(s)) id = 2
  else if (/medium|moderate|normal/.test(s)) id = 3
  else if (/low|minor|trivial|cosmetic|nit/.test(s)) id = 4
  return id ? { id, label: PRIORITY_LABEL[id] } : null
}

/** Fields actually applied to a created bug, so the UI can report the truth. */
export interface AppliedIssueFields {
  assignees: string[]
  priority: string | null
  /** Where the priority came from — the issue's severity, or the parent ticket. */
  prioritySource: 'severity' | 'parent' | null
  /** Screenshots uploaded to the card, and how many could not be attached. */
  screenshots: number
  screenshotsFailed: number
  /** Why the failed uploads failed (first reason only) — so the panel can say
   *  "ClickUp storage is full" instead of a bare count. Null when none failed. */
  screenshotsError: string | null
  /** Whether the evidence comment was posted on the card. */
  commented: boolean
  /** Screenshot links were written into the card's description (`clickupEvidence`). */
  evidenceInDescription?: boolean
  /** The project chose not to inherit the parent's assignees, so none were sent. */
  assigneesSkipped?: boolean
}

/**
 * Read the parent ticket once and keep only what filing a bug under it needs.
 * Accepts a ClickUp URL or a bare id.
 */
export async function getIssueFilingContext(parentTask: string): Promise<IssueFilingContext> {
  const parentId = extractClickupTaskId(parentTask)
  if (!parentId) {
    throw Object.assign(new Error('A ClickUp parent ticket URL or id is required'), { status: 400 })
  }
  const parent = mcpProject()
    ? await mcpCall('clickup_get_task', { task_id: parentId })
    : await cuFetch(`/task/${encodeURIComponent(parentId)}`)
  const listId = String(parent?.list?.id ?? '')
  if (!listId) {
    throw Object.assign(new Error('Could not resolve the parent task list in ClickUp'), {
      status: 502,
    })
  }
  // REST: `{id, priority}`; the MCP tool may give the bare label ("high").
  const priorityId =
    parent?.priority?.id != null
      ? Number(parent.priority.id)
      : typeof parent?.priority === 'string'
        ? (severityPriority(parent.priority)?.id ?? NaN)
        : NaN
  const customId = parent?.custom_id ? String(parent.custom_id) : null
  return {
    id: parentId,
    displayId: customId ?? parentId,
    name: String(parent?.name ?? ''),
    url: String(parent?.url ?? ''),
    listId,
    listName: String(parent?.list?.name ?? ''),
    assignees: Array.isArray(parent?.assignees)
      ? parent.assignees
          .map((a: any) => ({ id: Number(a?.id), username: String(a?.username ?? a?.email ?? a?.id ?? '') }))
          .filter((a: { id: number }) => Number.isFinite(a.id))
      : [],
    tags: Array.isArray(parent?.tags)
      ? parent.tags.map((t: any) => String(t?.name ?? '')).filter(Boolean)
      : [],
    priority:
      Number.isFinite(priorityId) && priorityId >= 1 && priorityId <= 4
        ? {
            id: priorityId,
            label: String(
              (typeof parent?.priority === 'object' && parent?.priority?.priority) ||
                PRIORITY_LABEL[priorityId],
            ),
          }
        : null,
  }
}

export function extractClickupTaskId(input: string): string {
  const raw = input.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const parts = url.pathname.split('/').filter(Boolean)
    const tIndex = parts.findIndex((part) => part.toLowerCase() === 't')
    if (tIndex >= 0 && parts.length > tIndex + 1) return decodeURIComponent(parts[parts.length - 1])
    return decodeURIComponent(parts[parts.length - 1] ?? '').trim()
  } catch {
    return raw.replace(/^#/, '').split(/[/?#]/)[0]?.trim() ?? ''
  }
}

/**
 * Prepare a QC issue body for ClickUp's markdown_content field. The qc-testing skill
 * writes each field (**AC:**, **Steps to reproduce:**, **Expected:**, **Actual:**, …)
 * on its own line separated by a SINGLE newline. CommonMark (which ClickUp uses) joins
 * single-newline lines into one paragraph, so without this the fields render as one
 * run-on block. We insert a blank line before each bold-label field and before a list
 * that follows a paragraph, so each renders as its own separated block (bold heading +
 * numbered/bulleted list), matching the readable layout the QC engineer expects.
 */
export function normalizeIssueMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const isList = (l: string) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l)
  const isBoldLabel = (l: string) => /^\s*\*\*.+?\*\*/.test(l)
  const out: string[] = []
  for (const line of lines) {
    const prev = out.length ? out[out.length - 1] : ''
    // A blank line is only needed when the previous emitted line has content.
    if (line.trim() && prev.trim() && (isBoldLabel(line) || (isList(line) && !isList(prev)))) {
      out.push('')
    }
    out.push(line)
  }
  return out.join('\n')
}

export async function createIssueSubtask(
  input: CreateSubtaskInput,
): Promise<CreatedClickupTask & { applied: AppliedIssueFields }> {
  const name = input.name.trim().slice(0, 255)
  if (!name) throw Object.assign(new Error('Issue title is required'), { status: 400 })

  const context = input.context ?? (await getIssueFilingContext(input.parentTask))

  // Inherit the parent ticket's assignees and tags so the logged bug lands on the right
  // person with the right context — the QC engineer would otherwise set these by hand:
  //   - assignees: ClickUp create expects an array of user IDs
  //   - tags:      an array of tag NAMES that exist in the space
  //   - priority:  an integer 1-4 (Urgent…Low) — from the ISSUE's severity first, since
  //                a feature ticket usually carries no priority of its own
  //   (assignees only when the project keeps `clickupInheritAssignees` on — a team that
  //   triages its own bugs wants them unassigned, and used to patch this line out)
  const inheritAssignees = input.inheritAssignees !== false
  const assignees = inheritAssignees ? context.assignees.map((a) => a.id) : []
  const fromSeverity = severityPriority(input.severity)
  const priority = fromSeverity ?? context.priority

  // Send markdown_content (NOT description): ClickUp renders markdown_content as rich
  // text (bold labels, numbered/bulleted lists) but shows description as literal plain
  // text — which is why the raw `**...**` and run-on layout appeared before.
  const markdown = normalizeIssueMarkdown(input.description).slice(0, 6000)
  const created = mcpProject()
    ? unwrapTask(
        await mcpCall('clickup_create_task', {
          name,
          list_id: context.listId,
          parent: context.id,
          markdown_description: markdown,
          ...(assignees.length ? { assignees } : {}),
          ...(context.tags.length ? { tags: context.tags } : {}),
          // The MCP tool takes the priority WORD, not ClickUp's 1-4.
          ...(priority ? { priority: priority.label.toLowerCase() } : {}),
        }),
      )
    : await cuPost(`/list/${encodeURIComponent(context.listId)}/task`, {
        name,
        markdown_content: markdown,
        parent: context.id,
        ...(assignees.length ? { assignees } : {}),
        ...(context.tags.length ? { tags: context.tags } : {}),
        ...(priority ? { priority: priority.id } : {}),
      })

  return {
    id: String(created.id),
    customId: created.custom_id ? String(created.custom_id) : null,
    displayId: created.custom_id ? String(created.custom_id) : String(created.id),
    name: String(created.name ?? name),
    url: String(created.url ?? ''),
    parent: context.id,
    applied: {
      // Report what ClickUp actually stored, not what we asked for — a user who isn't a
      // member of the list is silently dropped, and the panel must not claim otherwise.
      assignees: Array.isArray(created.assignees)
        ? created.assignees.map((a: any) => String(a?.username ?? a?.email ?? a?.id ?? ''))
        : [],
      priority:
        typeof created.priority === 'string'
          ? created.priority.charAt(0).toUpperCase() + created.priority.slice(1)
          : created.priority?.priority
            ? String(created.priority.priority)
            : (priority?.label ?? null),
      prioritySource: fromSeverity ? 'severity' : context.priority ? 'parent' : null,
      screenshots: 0,
      screenshotsFailed: 0,
      screenshotsError: null,
      commented: false,
      assigneesSkipped: !inheritAssignees,
    },
  }
}

/**
 * Attach a file (e.g. a QC screenshot) to a ClickUp task. Uses the v2
 * `POST /task/{id}/attachment` multipart endpoint — the boundary is set by
 * fetch from the FormData body, so we must NOT send our own Content-Type.
 */
export interface UploadedAttachment {
  id: string
  /** Presigned URL ClickUp returns for the stored file (usable in markdown). */
  url: string
  title: string
}

export async function attachTaskFile(
  taskId: string,
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<UploadedAttachment> {
  if (mcpProject()) {
    const data = await mcpCall('clickup_attach_task_file', {
      task_id: taskId,
      file_name: filename,
      file_data: Buffer.from(bytes).toString('base64'),
    })
    const a = data?.attachment ?? data ?? {}
    return { id: String(a.id ?? ''), url: String(a.url ?? ''), title: String(a.title ?? filename) }
  }
  const form = new FormData()
  form.append('attachment', new Blob([bytes as BlobPart], { type: contentType }), filename)
  const res = await fetch(`${API}/task/${encodeURIComponent(taskId)}/attachment`, {
    method: 'POST',
    headers: { Authorization: token() },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // ClickUp error bodies are `{"err":"...","ECODE":"..."}` — surface the human
    // sentence, not the envelope (e.g. "Over allocated storage", not the JSON).
    let detail = body.slice(0, 200)
    try {
      const parsed = JSON.parse(detail)
      if (typeof parsed?.err === 'string' && parsed.err) detail = parsed.err
    } catch {
      /* not JSON — keep the raw body */
    }
    throw Object.assign(new Error(`ClickUp attachment ${res.status}: ${detail}`), {
      status: 502,
    })
  }
  const data = await res.json().catch(() => ({}))
  return {
    id: String(data?.id ?? ''),
    url: String(data?.url ?? ''),
    title: String(data?.title ?? filename),
  }
}

/**
 * Post a comment on a task. ClickUp renders `comment_text` with markdown, so an
 * embedded `![alt](url)` shows the image inline in the comment thread. Best used
 * with an attachment's presigned URL from {@link attachTaskFile}. `notifyAll:false`
 * keeps it quiet (no email/notification storm for automated QC evidence).
 */
export async function postTaskComment(taskId: string, commentText: string): Promise<void> {
  const text = commentText.trim()
  if (!text) return
  if (mcpProject()) {
    await mcpCall('clickup_create_task_comment', { task_id: taskId, comment_text: text, notify_all: false })
    return
  }
  await cuPost(`/task/${encodeURIComponent(taskId)}/comment`, {
    comment_text: text,
    notify_all: false,
  })
}

// ---- Docs (ClickUp API v3) ----

export interface DocRef {
  id: string
  name: string
}

/**
 * List docs in a workspace, optionally filtered by a name substring. Uses the
 * v3 Docs API. Cursor-paginated; we page until we have enough matches or run out.
 */
export async function getDocs(teamId: string, query: string): Promise<DocRef[]> {
  const q = query.trim().toLowerCase()
  const out: DocRef[] = []
  const MAX_PAGES = 5
  const MAX_HITS = 50
  let cursor: string | undefined

  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ deleted: 'false', archived: 'false', limit: '50' })
    if (cursor) qs.set('next_cursor', cursor)
    const data = await cuFetchV3(`/workspaces/${encodeURIComponent(teamId)}/docs?${qs.toString()}`)
    const docs: any[] = data.docs ?? []
    for (const d of docs) {
      const ref: DocRef = { id: String(d.id), name: String(d.name ?? 'Untitled doc') }
      if (!q || ref.name.toLowerCase().includes(q)) out.push(ref)
      if (out.length >= MAX_HITS) break
    }
    cursor = data.next_cursor ? String(data.next_cursor) : undefined
    if (!cursor || out.length >= MAX_HITS) break
  }
  return out.slice(0, MAX_HITS)
}

// ---- Single-task detail + comments + attachments (used by the crawler) ----

export interface TaskAttachment {
  id: string
  title: string
  url: string
  extension: string
  size: number // bytes
}

export interface TaskComment {
  id: string
  text: string
  user: string
  date: string | null // ISO; ClickUp returns epoch-ms strings which we convert
}

export interface TaskDetail {
  id: string
  customId: string | null
  displayId: string
  name: string
  status: string
  description: string // markdown when ClickUp provides it, else plain text
  url: string
  listName: string
  folderName: string | null
  spaceName: string | null
  priority: string | null
  assignees: string[]
  tags: string[]
  dueDate: string | null // ISO
  dateCreated: string | null
  dateUpdated: string | null
  customFields: { name: string; value: string }[]
  attachments: TaskAttachment[]
}

function epochToIso(v: unknown): string | null {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return new Date(n).toISOString()
}

/** Render a ClickUp custom-field value into a short human string; skips empties. */
function formatCustomField(f: any): { name: string; value: string } | null {
  const name = String(f.name ?? '').trim()
  if (!name) return null
  let value: unknown = f.value
  if (value == null || value === '') return null

  const type = String(f.type ?? '')
  if (type === 'drop_down') {
    const opts = f.type_config?.options ?? []
    const opt = opts.find((o: any) => o.id === value || o.orderindex === value)
    value = opt ? (opt.name ?? opt.label ?? value) : value
  } else if (type === 'labels' && Array.isArray(value)) {
    const opts = f.type_config?.options ?? []
    value = value
      .map((id: any) => opts.find((o: any) => o.id === id)?.label ?? id)
      .join(', ')
  } else if (type === 'users' && Array.isArray(value)) {
    value = value.map((u: any) => u.username ?? u.email ?? u.id).join(', ')
  } else if (type === 'date') {
    value = epochToIso(value) ?? String(value)
  }

  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.trim() ? { name, value: text.trim() } : null
}

/** Full detail for one task (by internal task id), including embedded attachments. */
export async function getTaskDetail(taskId: string): Promise<TaskDetail> {
  const t = mcpProject()
    ? await mcpCall('clickup_get_task', {
        task_id: taskId,
        include: ['description', 'attachments', 'custom_fields'],
      })
    : await cuFetch(`/task/${encodeURIComponent(taskId)}?include_markdown_description=true`)
  const customId = t.custom_id ? String(t.custom_id) : null
  const description =
    String(t.markdown_description ?? '').trim() ||
    String(t.text_content ?? t.description ?? '').trim()

  return {
    id: String(t.id),
    customId,
    displayId: customId ?? String(t.id),
    name: String(t.name ?? ''),
    status: typeof t.status === 'string' ? t.status : String(t.status?.status ?? ''),
    description,
    url: String(t.url ?? ''),
    listName: String(t.list?.name ?? ''),
    folderName: t.folder?.name ? String(t.folder.name) : null,
    spaceName: t.space?.name ? String(t.space.name) : null,
    priority:
      typeof t.priority === 'string'
        ? t.priority
        : t.priority?.priority
          ? String(t.priority.priority)
          : null,
    assignees: (t.assignees ?? []).map((a: any) => String(a.username ?? a.email ?? a.id)),
    tags: (t.tags ?? []).map((tag: any) => String(tag.name ?? tag)),
    dueDate: epochToIso(t.due_date),
    dateCreated: epochToIso(t.date_created),
    dateUpdated: epochToIso(t.date_updated),
    customFields: (t.custom_fields ?? [])
      .map(formatCustomField)
      .filter((x: unknown): x is { name: string; value: string } => x != null),
    attachments: (t.attachments ?? []).map((a: any) => ({
      id: String(a.id),
      title: String(a.title ?? a.id),
      // The MCP task detail carries no file URL — its download tool hands out a
      // SHORT-LIVED one per request, so record where to ask (`downloadAttachment`).
      url: a.url ? String(a.url) : mcpProject() ? `${MCP_ATTACHMENT}${t.id}|${a.id}` : '',
      extension: String(a.extension ?? ''),
      size: Number(a.size ?? 0),
    })),
  }
}

/** Comments on a task, oldest first. */
export async function getTaskComments(taskId: string): Promise<TaskComment[]> {
  const data = mcpProject()
    ? await mcpCall('clickup_get_task_comments', { task_id: taskId })
    : await cuFetch(`/task/${encodeURIComponent(taskId)}/comment`)
  const comments: any[] = data.comments ?? []
  return comments
    .map((c) => ({
      id: String(c.id),
      text: String(c.comment_text ?? c.text ?? '').trim(),
      user: String(c.user?.username ?? c.user?.email ?? c.user?.id ?? 'unknown'),
      date: epochToIso(c.date),
    }))
    .reverse() // ClickUp returns newest-first; read top-to-bottom chronologically
}

/**
 * Download one attachment's bytes. ClickUp attachment URLs are presigned, so we
 * fetch them WITHOUT the API token (sending it can make the storage host 403).
 */
export async function downloadAttachment(url: string): Promise<Buffer> {
  if (url.startsWith(MCP_ATTACHMENT) && mcpProject()) {
    const [taskId, attachmentId] = url.slice(MCP_ATTACHMENT.length).split('|')
    const data = await mcpCall('clickup_download_task_attachment', {
      task_id: taskId,
      attachment_id: attachmentId,
    })
    if (!data?.url) {
      throw Object.assign(new Error('attachment download failed (no URL from ClickUp)'), { status: 502 })
    }
    url = String(data.url)
  }
  const res = await fetch(url)
  if (!res.ok) {
    throw Object.assign(new Error(`attachment download failed (${res.status})`), {
      status: 502,
    })
  }
  return Buffer.from(await res.arrayBuffer())
}

/** Fetch a single page's markdown content (used as a fallback). */
async function getDocPageContent(teamId: string, docId: string, pageId: string): Promise<string> {
  try {
    const one = await cuFetchV3(
      `/workspaces/${encodeURIComponent(teamId)}/docs/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}?content_format=text%2Fmd`,
    )
    return String(one?.content ?? '').trim()
  } catch {
    return ''
  }
}

/**
 * Flatten a (possibly nested) page tree into one markdown string. The list
 * endpoint usually embeds each page's content, but can return it empty — in that
 * case we fetch the page individually as a fallback.
 */
async function flattenPages(
  teamId: string,
  docId: string,
  pages: any[],
  depth = 0,
): Promise<string> {
  let md = ''
  for (const p of pages ?? []) {
    const name = String(p.name ?? '').trim()
    let content = String(p.content ?? '').trim()
    if (!content && p.id) content = await getDocPageContent(teamId, docId, String(p.id))
    if (name) md += `${'#'.repeat(Math.min(depth + 2, 6))} ${name}\n\n`
    if (content) md += `${content}\n\n`
    if (Array.isArray(p.pages) && p.pages.length) {
      md += await flattenPages(teamId, docId, p.pages, depth + 1)
    }
  }
  return md
}

/**
 * Read a doc's full text as markdown by fetching all its pages (v3).
 * Returns the concatenated markdown (page headings + content).
 */
export async function getDocContent(teamId: string, docId: string): Promise<string> {
  const qs = new URLSearchParams({ content_format: 'text/md', max_page_depth: '-1' })
  const data = await cuFetchV3(
    `/workspaces/${encodeURIComponent(teamId)}/docs/${encodeURIComponent(docId)}/pages?${qs.toString()}`,
  )
  // The endpoint returns either an array of pages or { pages: [...] }.
  const pages: any[] = Array.isArray(data) ? data : (data.pages ?? [])
  return (await flattenPages(teamId, docId, pages)).trim()
}
