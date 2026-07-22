// Thin read-only Azure DevOps Boards REST client, the Azure twin of jira.ts /
// clickup.ts. It powers the ticket picker + crawler for projects whose tracker is
// Azure DevOps, and normalizes every result into the SAME shapes clickup.ts emits
// (Workspace / TaskHit / TaskDetail / TaskComment / TaskAttachment) so the tree,
// status grouping, and crawler downstream don't care which tracker a ticket came
// from.
//
// Like ClickUp/Jira, the portal already registers an Azure DevOps MCP server for
// the agent, but that's a stdio process — the web server can't query it. We reuse
// the same personal credentials (organization URL + Personal Access Token) to hit
// Azure DevOps REST API v7.1 directly with HTTP Basic auth (empty username, PAT as
// password). The token stays on the server; the browser never sees it.
//
// Creds source (in priority order):
//   1. The active project's .mcp.json azure entry (what the in-app "Connect"
//      button writes: AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT /
//      AZURE_DEVOPS_DEFAULT_PROJECT) — resolved per request via AsyncLocalStorage,
//      so pasting fresh creds takes effect immediately, no server restart.
//   2. The AZURE_DEVOPS_ORG_URL / AZURE_DEVOPS_PAT / AZURE_DEVOPS_DEFAULT_PROJECT
//      environment variables.

import { AsyncLocalStorage } from 'node:async_hooks'
import fs from 'node:fs'
import { mcpJsonFor } from './config.js'
import type {
  Workspace,
  TaskHit,
  TaskDetail,
  TaskComment,
  TaskAttachment,
} from './clickup.js'

const API_VERSION = '7.1'
// The work-item Comments endpoint is still a preview API in every current release.
const COMMENTS_API_VERSION = '7.1-preview.4'

export interface AzureCreds {
  orgUrl: string // e.g. https://dev.azure.com/your-org (no trailing slash)
  pat: string
  project?: string // optional default project (AZURE_DEVOPS_DEFAULT_PROJECT)
}

// Per-request creds override. Set by withAzureCreds(); read by currentCreds().
const credsStore = new AsyncLocalStorage<AzureCreds>()

/** Run `fn` with `creds` as the active Azure credentials (falls back to env if undefined). */
export function withAzureCreds<T>(creds: AzureCreds | undefined, fn: () => Promise<T>): Promise<T> {
  return creds ? credsStore.run(creds, fn) : fn()
}

/** Resolve a `${ENV_VAR}` reference to its value; passes plain strings through. */
function deref(v: unknown): string {
  if (typeof v !== 'string' || !v) return ''
  const ref = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return ref ? (process.env[ref[1]] ?? '') : v
}

/** The creds in effect for this request: per-request override, else env vars. */
function currentCreds(): AzureCreds | undefined {
  const stored = credsStore.getStore()
  if (stored) return stored
  const orgUrl = (process.env.AZURE_DEVOPS_ORG_URL ?? '').replace(/\/+$/, '')
  const pat = process.env.AZURE_DEVOPS_PAT ?? ''
  const project = process.env.AZURE_DEVOPS_DEFAULT_PROJECT ?? ''
  if (orgUrl && pat) return { orgUrl, pat, project: project || undefined }
  return undefined
}

/**
 * Read Azure credentials from a project's .mcp.json azure entry. Accepts literal
 * values (what Connect writes) or `${ENV_VAR}` references. Returns undefined
 * unless both org URL and PAT are usable.
 */
export function resolveProjectAzureCreds(projectRoot: string): AzureCreds | undefined {
  try {
    const raw = fs.readFileSync(mcpJsonFor(projectRoot), 'utf8')
    const env = JSON.parse(raw)?.mcpServers?.azure?.env
    if (!env || typeof env !== 'object') return undefined
    const orgUrl = deref(env.AZURE_DEVOPS_ORG_URL).replace(/\/+$/, '')
    const pat = deref(env.AZURE_DEVOPS_PAT)
    const project = deref(env.AZURE_DEVOPS_DEFAULT_PROJECT)
    if (orgUrl && pat) return { orgUrl, pat, project: project || undefined }
  } catch {
    /* no file / bad json */
  }
  return undefined
}

export function azureConfigured(): boolean {
  return !!currentCreds()
}

function creds(): AzureCreds {
  const c = currentCreds()
  if (!c) throw Object.assign(new Error('Azure DevOps is not configured (no credentials)'), { status: 400 })
  return c
}

/** Azure DevOps PAT auth: HTTP Basic with an empty username and the PAT as password. */
function authHeader(c: AzureCreds): string {
  return `Basic ${Buffer.from(`:${c.pat}`).toString('base64')}`
}

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

/**
 * Fetch a full Azure DevOps REST URL with PAT auth. Azure answers an invalid PAT
 * on some paths with a 302 → sign-in page that resolves to a 200 *HTML* body
 * instead of a 401; guard on the content-type so that surfaces as an auth error
 * rather than a JSON-parse blow-up.
 */
async function azFetch(url: string, init?: RequestInit): Promise<any> {
  const c = creds()
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(c),
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const ctype = res.headers.get('content-type') ?? ''
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const invalid = res.status === 401 || res.status === 403
    throw statusError(
      invalid
        ? 'Azure DevOps rejected the PAT (invalid, expired, or missing a required scope).'
        : `Azure DevOps API ${res.status}: ${body.slice(0, 200)}`,
      502,
    )
  }
  if (res.status === 204) return null
  if (ctype.includes('text/html')) {
    // A sign-in page came back with a 200 — the PAT is not authenticating.
    throw statusError('Azure DevOps rejected the PAT (invalid or expired — got a sign-in page).', 502)
  }
  return res.json()
}

/**
 * Live-validate the configured creds against Azure DevOps. Like ClickUp/Jira, the
 * MCP "connected" badge only reflects the stdio handshake — this hits a cheap
 * endpoint so the UI can surface "needs auth" for invalid/expired PATs.
 */
export async function verifyToken(): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const c = currentCreds()
  if (!c) return { ok: false, status: null, detail: 'No Azure DevOps credentials are configured.' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`${c.orgUrl}/_apis/projects?$top=1&api-version=${API_VERSION}`, {
      headers: { Authorization: authHeader(c), Accept: 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    const ctype = res.headers.get('content-type') ?? ''
    if (res.ok && ctype.includes('application/json')) {
      return { ok: true, status: res.status, detail: 'Credentials valid.' }
    }
    if (res.ok && ctype.includes('text/html')) {
      return {
        ok: false,
        status: res.status,
        detail: 'PAT rejected by Azure DevOps (got a sign-in page). Disconnect and reconnect with a fresh PAT.',
      }
    }
    const body = await res.text().catch(() => '')
    const invalid = res.status === 401 || res.status === 403
    return {
      ok: false,
      status: res.status,
      detail: invalid
        ? 'PAT rejected by Azure DevOps (invalid, expired, or missing scope). Disconnect and reconnect with a fresh PAT.'
        : `Azure DevOps API ${res.status}: ${body.slice(0, 120)}`,
    }
  } catch (e) {
    return { ok: false, status: null, detail: e instanceof Error ? e.message : 'Creds check failed.' }
  }
}

// ---- Status color: map a work-item State name → a hex the UI can tint.

function stateColor(state: unknown): string {
  const s = String(state ?? '').toLowerCase()
  if (['new', 'to do', 'proposed', 'open', 'approved'].includes(s)) return '#87909e' // gray
  if (['active', 'in progress', 'committed', 'doing', 'design'].includes(s)) return '#e2b203' // yellow
  if (s === 'resolved') return '#3279f9' // blue
  if (['closed', 'done', 'completed'].includes(s)) return '#22a06b' // green
  if (['removed', 'rejected'].includes(s)) return '#c9372c' // red
  return '#87909e'
}

// ---- HTML → Markdown. Azure work-item descriptions/repro-steps/comments are HTML,
// not text; this dependency-free converter covers the common tags (the Azure twin
// of jira.ts's ADF walker).

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n))
      } catch {
        return ''
      }
    })
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).trim()
}

/** Render an Azure HTML field (or plain string) to markdown/plain text. */
export function htmlToMarkdown(html: unknown): string {
  if (html == null || html === '') return ''
  let s = String(html)
  if (!/[<&]/.test(s)) return s.trim() // already plain text
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, h, t) => `[${stripTags(t)}](${h})`)
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/(?:strong|b)>/gi, (_, __, t) => `**${stripTags(t)}**`)
  s = s.replace(/<(em|i)>([\s\S]*?)<\/(?:em|i)>/gi, (_, __, t) => `_${stripTags(t)}_`)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `- ${stripTags(t)}\n`)
  s = s.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, t) => `\n## ${stripTags(t)}\n`)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|tr|ul|ol|table)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = decodeEntities(s)
  return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isoOrNull(v: unknown): string | null {
  if (v == null || v === '') return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ---- Workspaces (Azure DevOps projects) ----

/**
 * Azure DevOps projects, surfaced as "workspaces" so the picker UI is identical.
 * id = project name (what WIQL and the work-item web URL key on).
 *
 * Listing projects needs the PAT's "Project and Team (Read)" scope; a Work-Items-
 * only PAT can't. So when a default project is configured we return just that one
 * (no API call, always works); otherwise we list via the API and, if that's
 * rejected, fall back to the default project when there is one.
 */
export async function getWorkspaces(): Promise<Workspace[]> {
  const c = creds()
  if (c.project) return [{ id: c.project, name: c.project }]
  try {
    const data = await azFetch(`${c.orgUrl}/_apis/projects?$top=200&api-version=${API_VERSION}`)
    const out: Workspace[] = (data.value ?? [])
      .map((p: any) => ({ id: String(p.name), name: String(p.name) }))
      .filter((w: Workspace) => w.id)
    return out
  } catch (e) {
    throw statusError(
      (e as Error).message +
        ' (grant the PAT "Project and Team (Read)", or set a default project when connecting).',
      (e as { status?: number }).status ?? 502,
    )
  }
}

// ---- Search / list work items ----

const HIT_FIELDS = [
  'System.Id',
  'System.Title',
  'System.State',
  'System.WorkItemType',
  'System.TeamProject',
  'System.Parent',
]

/** Map an Azure work item (batch shape: {id, fields}) to the normalized TaskHit. */
function toHit(wi: any): TaskHit {
  const f = wi.fields ?? {}
  const id = String(wi.id)
  const project = String(f['System.TeamProject'] ?? '')
  const type = String(f['System.WorkItemType'] ?? '')
  return {
    id, // Azure work-item ids are the identifier everywhere — id == displayId
    customId: null,
    displayId: id,
    name: String(f['System.Title'] ?? ''),
    status: String(f['System.State'] ?? ''),
    statusColor: stateColor(f['System.State']),
    listName: [project, type].filter(Boolean).join(' · '),
    url: project ? `${creds().orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}` : '',
    parent: f['System.Parent'] != null ? String(f['System.Parent']) : null,
  }
}

/** Batch-fetch work items by id (preserving the caller's order) → TaskHits. */
async function fetchHits(ids: number[]): Promise<TaskHit[]> {
  if (!ids.length) return []
  const c = creds()
  const data = await azFetch(`${c.orgUrl}/_apis/wit/workitemsbatch?api-version=${API_VERSION}`, {
    method: 'POST',
    body: JSON.stringify({ ids, fields: HIT_FIELDS }),
  })
  const byId = new Map<string, any>((data.value ?? []).map((wi: any) => [String(wi.id), wi]))
  return ids.map((id) => byId.get(String(id))).filter(Boolean).map(toHit)
}

/** Escape a single-quoted WIQL string literal (single quotes are doubled). */
function wiqlEscape(s: string): string {
  return s.replace(/'/g, "''")
}

/**
 * Search work items in an Azure DevOps project by title substring or id. Mirrors
 * clickup.searchTasks / jira.searchTasks: a flat list, newest-changed first, capped.
 * WIQL flat queries return only ids, so we page ids → batch-fetch the fields.
 */
export async function searchTasks(project: string, query: string): Promise<TaskHit[]> {
  const c = creds()
  const q = query.trim()
  let where = ''
  if (q) {
    const clauses = [`[System.Title] CONTAINS '${wiqlEscape(q)}'`]
    if (/^\d+$/.test(q)) clauses.push(`[System.Id] = ${q}`)
    where = ` WHERE (${clauses.join(' OR ')})`
  }
  const wiql = `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`
  // Cap the WIQL result server-side with `$top`. Without it, an unfiltered browse
  // of a large project (>20,000 work items) is rejected with VS402337 ("number of
  // work items returned exceeds the size limit of 20000") and no tickets load. The
  // `$top` URL param bounds the query to the N most-recently-changed ids up front.
  const data = await azFetch(
    `${c.orgUrl}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}&$top=100`,
    { method: 'POST', body: JSON.stringify({ query: wiql }) },
  )
  const ids: number[] = (data.workItems ?? [])
    .map((w: any) => Number(w.id))
    .filter((n: number) => Number.isFinite(n))
    .slice(0, 100)
  return fetchHits(ids)
}

/**
 * Children of one work item, loaded on demand. Azure has no formal "subtask"
 * type; the hierarchy is a link, so we read the parent's forward hierarchy
 * relations (reliable on every Azure DevOps version) → batch-fetch the children.
 */
export async function getSubtasks(parentId: string): Promise<TaskHit[]> {
  const c = creds()
  const wi = await azFetch(
    `${c.orgUrl}/_apis/wit/workitems/${encodeURIComponent(parentId)}?$expand=relations&api-version=${API_VERSION}`,
  )
  const childIds: number[] = (wi.relations ?? [])
    .filter((r: any) => r.rel === 'System.LinkTypes.Hierarchy-Forward')
    .map((r: any) => Number(String(r.url ?? '').split('/').pop()))
    .filter((n: number) => Number.isFinite(n))
    .slice(0, 100)
  return fetchHits(childIds)
}

// ---- Single work-item detail + comments + attachments (used by the crawler) ----

/** Full detail for one work item (by id), including embedded attachments. */
export async function getTaskDetail(id: string): Promise<TaskDetail> {
  const c = creds()
  const wi = await azFetch(
    `${c.orgUrl}/_apis/wit/workitems/${encodeURIComponent(id)}?$expand=all&api-version=${API_VERSION}`,
  )
  const f = wi.fields ?? {}
  const project = String(f['System.TeamProject'] ?? '')

  // Description: Azure spreads a ticket's prose across Description, Repro Steps
  // (bugs), and Acceptance Criteria — fold them into one markdown body for QC.
  const sections: string[] = []
  const desc = htmlToMarkdown(f['System.Description'])
  if (desc) sections.push(desc)
  const repro = htmlToMarkdown(f['Microsoft.VSTS.TCM.ReproSteps'])
  if (repro) sections.push(`## Repro steps\n\n${repro}`)
  const accept = htmlToMarkdown(f['Microsoft.VSTS.Common.AcceptanceCriteria'])
  if (accept) sections.push(`## Acceptance criteria\n\n${accept}`)

  // AssignedTo / CreatedBy come back as identity objects ({displayName, ...}).
  const identityName = (v: any): string =>
    typeof v === 'object' && v ? String(v.displayName ?? v.uniqueName ?? '') : String(v ?? '')
  const assignee = identityName(f['System.AssignedTo'])

  const tags = String(f['System.Tags'] ?? '')
    .split(';')
    .map((t) => t.trim())
    .filter(Boolean)

  const attachments: TaskAttachment[] = (wi.relations ?? [])
    .filter((r: any) => r.rel === 'AttachedFile')
    .map((r: any) => {
      const title = String(r.attributes?.name ?? String(r.url ?? '').split('/').pop() ?? 'attachment')
      return {
        id: String(String(r.url ?? '').split('/').pop() ?? ''),
        title,
        url: String(r.url ?? ''), // needs auth — downloadAttachment adds it
        extension: title.includes('.') ? (title.split('.').pop() ?? '') : '',
        size: Number(r.attributes?.resourceSize ?? 0),
      }
    })

  // Surface Azure-specific fields through the generic customFields channel.
  const customFields: { name: string; value: string }[] = []
  if (f['System.WorkItemType']) customFields.push({ name: 'Type', value: String(f['System.WorkItemType']) })
  const createdBy = identityName(f['System.CreatedBy'])
  if (createdBy) customFields.push({ name: 'Created by', value: createdBy })
  if (f['System.AreaPath']) customFields.push({ name: 'Area path', value: String(f['System.AreaPath']) })
  if (f['System.IterationPath'])
    customFields.push({ name: 'Iteration path', value: String(f['System.IterationPath']) })

  const priority = f['Microsoft.VSTS.Common.Priority']

  return {
    id,
    customId: null,
    displayId: id,
    name: String(f['System.Title'] ?? ''),
    status: String(f['System.State'] ?? ''),
    description: sections.join('\n\n'),
    url: project ? `${c.orgUrl}/${encodeURIComponent(project)}/_workitems/edit/${id}` : '',
    listName: project,
    folderName: null,
    spaceName: project || null,
    priority: priority != null && priority !== '' ? String(priority) : null,
    assignees: assignee ? [assignee] : [],
    tags,
    dueDate: isoOrNull(f['Microsoft.VSTS.Scheduling.DueDate']),
    dateCreated: isoOrNull(f['System.CreatedDate']),
    dateUpdated: isoOrNull(f['System.ChangedDate']),
    customFields,
    attachments,
  }
}

/** Comments on a work item, oldest first. */
export async function getTaskComments(id: string): Promise<TaskComment[]> {
  const c = creds()
  // The comments endpoint is project-scoped; resolve the work item's project first.
  let project = c.project ?? ''
  try {
    const meta = await azFetch(
      `${c.orgUrl}/_apis/wit/workitems/${encodeURIComponent(id)}?fields=System.TeamProject&api-version=${API_VERSION}`,
    )
    project = String(meta.fields?.['System.TeamProject'] ?? project)
  } catch {
    /* keep the default project fallback */
  }
  if (!project) return []
  const data = await azFetch(
    `${c.orgUrl}/${encodeURIComponent(project)}/_apis/wit/workItems/${encodeURIComponent(id)}/comments?api-version=${COMMENTS_API_VERSION}`,
  )
  const comments: any[] = data.comments ?? []
  return comments.map((cm) => ({
    id: String(cm.id),
    text: htmlToMarkdown(cm.text),
    user: String(cm.createdBy?.displayName ?? cm.createdBy?.uniqueName ?? 'unknown'),
    date: isoOrNull(cm.createdDate),
  }))
}

/**
 * Download one attachment's bytes. Azure's attachment URLs require the same PAT
 * Basic auth as the API.
 */
export async function downloadAttachment(url: string): Promise<Buffer> {
  const c = creds()
  const u = url.includes('?') ? url : `${url}?api-version=${API_VERSION}`
  const res = await fetch(u, { headers: { Authorization: authHeader(c) } })
  if (!res.ok) {
    throw statusError(`attachment download failed (${res.status})`, 502)
  }
  return Buffer.from(await res.arrayBuffer())
}
