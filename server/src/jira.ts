// Thin read-only Jira Cloud REST client, the Jira twin of clickup.ts. It powers
// the ticket picker + crawler for projects whose tracker is Jira instead of
// ClickUp, and normalizes every result into the SAME shapes clickup.ts emits
// (Workspace / TaskHit / TaskDetail / TaskComment / TaskAttachment) so the tree,
// status grouping, and crawler downstream don't care which tracker a ticket came
// from.
//
// Like ClickUp, the portal already registers a Jira MCP server (mcp-atlassian)
// for the agent, but that's a stdio process — the web server can't query it. We
// reuse the same personal credentials (site URL + account email + API token) to
// hit Jira's public REST API v3 directly with HTTP Basic auth. The token stays
// on the server; the browser never sees it.
//
// Creds source (in priority order):
//   1. The active project's .mcp.json jira entry (what the in-app "Connect"
//      button writes: JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN) — resolved per
//      request via AsyncLocalStorage, so pasting fresh creds takes effect
//      immediately, no server restart.
//   2. The JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN environment variables.

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

export interface JiraCreds {
  url: string // site base, e.g. https://acme.atlassian.net (no trailing slash)
  email: string
  token: string
}

// Per-request creds override. Set by withJiraCreds(); read by currentCreds().
const credsStore = new AsyncLocalStorage<JiraCreds>()

/** Run `fn` with `creds` as the active Jira credentials (falls back to env if undefined). */
export function withJiraCreds<T>(creds: JiraCreds | undefined, fn: () => Promise<T>): Promise<T> {
  return creds ? credsStore.run(creds, fn) : fn()
}

/** Resolve a `${ENV_VAR}` reference to its value; passes plain strings through. */
function deref(v: unknown): string {
  if (typeof v !== 'string' || !v) return ''
  const ref = v.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  return ref ? (process.env[ref[1]] ?? '') : v
}

/** The creds in effect for this request: per-request override, else env vars. */
function currentCreds(): JiraCreds | undefined {
  const stored = credsStore.getStore()
  if (stored) return stored
  const url = (process.env.JIRA_URL ?? '').replace(/\/+$/, '')
  const email = process.env.JIRA_USERNAME ?? ''
  const token = process.env.JIRA_API_TOKEN ?? ''
  if (url && email && token) return { url, email, token }
  return undefined
}

/**
 * Read Jira credentials from a project's .mcp.json jira entry. Accepts literal
 * values (what Connect writes) or `${ENV_VAR}` references. Returns undefined
 * unless all three (url, email, token) are usable.
 */
export function resolveProjectJiraCreds(projectRoot: string): JiraCreds | undefined {
  try {
    const raw = fs.readFileSync(mcpJsonFor(projectRoot), 'utf8')
    const env = JSON.parse(raw)?.mcpServers?.jira?.env
    if (!env || typeof env !== 'object') return undefined
    const url = deref(env.JIRA_URL).replace(/\/+$/, '')
    const email = deref(env.JIRA_USERNAME)
    const token = deref(env.JIRA_API_TOKEN)
    if (url && email && token) return { url, email, token }
  } catch {
    /* no file / bad json */
  }
  return undefined
}

export function jiraConfigured(): boolean {
  return !!currentCreds()
}

function creds(): JiraCreds {
  const c = currentCreds()
  if (!c) throw Object.assign(new Error('Jira is not configured (no credentials)'), { status: 400 })
  return c
}

function authHeader(c: JiraCreds): string {
  return `Basic ${Buffer.from(`${c.email}:${c.token}`).toString('base64')}`
}

async function jiraFetch(pathAndQuery: string, init?: RequestInit): Promise<any> {
  const c = creds()
  const res = await fetch(`${c.url}/rest/api/3${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: authHeader(c),
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`Jira API ${res.status}: ${body.slice(0, 200)}`), {
      status: 502,
    })
  }
  if (res.status === 204) return null
  return res.json()
}

/**
 * Live-validate the configured creds against Jira. Like ClickUp's verifyToken,
 * the MCP "connected" badge only reflects the stdio handshake — this hits /myself
 * so the UI can surface "needs auth" for invalid/expired creds.
 */
export async function verifyToken(): Promise<{ ok: boolean; status: number | null; detail: string }> {
  const c = currentCreds()
  if (!c) return { ok: false, status: null, detail: 'No Jira credentials are configured.' }
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 6000)
    const res = await fetch(`${c.url}/rest/api/3/myself`, {
      headers: { Authorization: authHeader(c), Accept: 'application/json' },
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.ok) return { ok: true, status: res.status, detail: 'Credentials valid.' }
    const body = await res.text().catch(() => '')
    const invalid = res.status === 401 || res.status === 403
    return {
      ok: false,
      status: res.status,
      detail: invalid
        ? 'Credentials rejected by Jira (invalid or expired). Disconnect and reconnect with a fresh API token.'
        : `Jira API ${res.status}: ${body.slice(0, 120)}`,
    }
  } catch (e) {
    return { ok: false, status: null, detail: e instanceof Error ? e.message : 'Creds check failed.' }
  }
}

// ---- Status color: map Jira's statusCategory colorName → a hex the UI can tint.

const CATEGORY_COLORS: Record<string, string> = {
  'blue-gray': '#87909e', // To Do
  'medium-gray': '#87909e',
  yellow: '#e2b203', // In Progress
  brown: '#e2b203',
  green: '#22a06b', // Done
}

function statusColorFor(fields: any): string {
  const name = String(fields?.status?.statusCategory?.colorName ?? '').toLowerCase()
  return CATEGORY_COLORS[name] ?? '#87909e'
}

// ---- ADF (Atlassian Document Format) → Markdown. Jira descriptions/comments are
// ADF JSON, not text; this dependency-free walker covers the common node types.

function adfInline(nodes: any[]): string {
  let out = ''
  for (const n of nodes ?? []) {
    if (n.type === 'text') {
      let t = String(n.text ?? '')
      const marks: any[] = n.marks ?? []
      const has = (type: string) => marks.some((m) => m.type === type)
      if (has('code')) t = `\`${t}\``
      if (has('strong')) t = `**${t}**`
      if (has('em')) t = `_${t}_`
      const link = marks.find((m) => m.type === 'link')
      if (link?.attrs?.href) t = `[${t}](${link.attrs.href})`
      out += t
    } else if (n.type === 'hardBreak') {
      out += '\n'
    } else if (n.type === 'mention') {
      out += `@${String(n.attrs?.text ?? '').replace(/^@/, '')}`
    } else if (n.type === 'emoji') {
      out += String(n.attrs?.text ?? n.attrs?.shortName ?? '')
    } else if (n.type === 'inlineCard') {
      out += String(n.attrs?.url ?? '')
    } else if (Array.isArray(n.content)) {
      out += adfInline(n.content)
    }
  }
  return out
}

function adfBlocks(nodes: any[], depth = 0): string {
  const lines: string[] = []
  for (const n of nodes ?? []) {
    switch (n.type) {
      case 'paragraph':
        lines.push(adfInline(n.content ?? []), '')
        break
      case 'heading': {
        const level = Math.min(Math.max(Number(n.attrs?.level ?? 2), 1), 6)
        lines.push(`${'#'.repeat(level)} ${adfInline(n.content ?? [])}`, '')
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = n.type === 'orderedList'
        ;(n.content ?? []).forEach((item: any, i: number) => {
          const marker = ordered ? `${i + 1}.` : '-'
          const body = adfBlocks(item.content ?? [], depth + 1).trim()
          const [first, ...rest] = body.split('\n')
          lines.push(`${'  '.repeat(depth)}${marker} ${first ?? ''}`)
          for (const r of rest) if (r.trim()) lines.push(`${'  '.repeat(depth + 1)}${r}`)
        })
        lines.push('')
        break
      }
      case 'codeBlock':
        lines.push('```' + String(n.attrs?.language ?? ''), adfInline(n.content ?? []), '```', '')
        break
      case 'blockquote':
        for (const l of adfBlocks(n.content ?? [], depth).split('\n')) {
          lines.push(l ? `> ${l}` : '>')
        }
        lines.push('')
        break
      case 'rule':
        lines.push('---', '')
        break
      case 'mediaSingle':
      case 'mediaGroup':
        lines.push('_(embedded media — see attachments)_', '')
        break
      default:
        if (Array.isArray(n.content)) lines.push(adfBlocks(n.content, depth))
    }
  }
  return lines.join('\n')
}

/** Render an ADF document (or null/string) to markdown/plain text. */
export function adfToMarkdown(doc: any): string {
  if (!doc) return ''
  if (typeof doc === 'string') return doc.trim()
  if (Array.isArray(doc.content)) return adfBlocks(doc.content).replace(/\n{3,}/g, '\n\n').trim()
  return ''
}

// ---- Workspaces (Jira projects) ----

/** Jira projects, surfaced as "workspaces" so the picker UI is identical. id = project key. */
export async function getWorkspaces(): Promise<Workspace[]> {
  const out: Workspace[] = []
  const MAX = 100
  let startAt = 0
  for (let page = 0; page < 5; page++) {
    const data = await jiraFetch(
      `/project/search?maxResults=50&startAt=${startAt}&orderBy=name&expand=`,
    )
    const values: any[] = data.values ?? []
    for (const p of values) {
      out.push({ id: String(p.key), name: `${String(p.name ?? p.key)} (${String(p.key)})` })
      if (out.length >= MAX) break
    }
    if (data.isLast || values.length === 0 || out.length >= MAX) break
    startAt += values.length
  }
  return out
}

// ---- Search / list issues ----

function jqlEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}

/** Map a Jira issue (with fields) to the normalized TaskHit shape. */
function toHit(issue: any): TaskHit {
  const f = issue.fields ?? {}
  const key = String(issue.key)
  return {
    id: key, // Jira keys are the identifier everywhere — id == displayId
    customId: key,
    displayId: key,
    name: String(f.summary ?? ''),
    status: String(f.status?.name ?? ''),
    statusColor: statusColorFor(f),
    listName: String(f.project?.name ?? f.project?.key ?? ''),
    url: issue.self && key ? `${creds().url}/browse/${key}` : '',
    parent: f.parent?.key ? String(f.parent.key) : null,
  }
}

const HIT_FIELDS = ['summary', 'status', 'parent', 'project', 'issuetype', 'updated']

/**
 * Search top-level issues in a Jira project by key or summary substring. Mirrors
 * clickup.searchTasks: returns parent tickets only (subtasks are loaded on demand
 * when a row is expanded), newest first, capped.
 */
export async function searchTasks(projectKey: string, query: string): Promise<TaskHit[]> {
  const q = query.trim()
  // Exclude sub-tasks (loaded on demand when a row is expanded) but keep stories
  // under an epic — the Jira analog of ClickUp's subtasks=false. subTaskIssueTypes()
  // is a built-in JQL function returning every sub-task issue-type id.
  const clauses = [`project = "${jqlEscape(projectKey)}"`, 'issuetype NOT IN subTaskIssueTypes()']
  if (q) clauses.push(`(summary ~ "${jqlEscape(q)}*" OR key = "${jqlEscape(q)}")`)
  const jql = `${clauses.join(' AND ')} ORDER BY updated DESC`

  const data = await jiraFetch('/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: HIT_FIELDS, maxResults: 100 }),
  })
  return (data.issues ?? []).map(toHit)
}

/**
 * Subtasks (children) of one parent issue, loaded on demand. `parent = KEY`
 * matches sub-tasks in both team- and company-managed projects.
 */
export async function getSubtasks(parentKey: string): Promise<TaskHit[]> {
  const jql = `parent = "${jqlEscape(parentKey)}" ORDER BY created ASC`
  const data = await jiraFetch('/search/jql', {
    method: 'POST',
    body: JSON.stringify({ jql, fields: HIT_FIELDS, maxResults: 100 }),
  })
  return (data.issues ?? [])
    .filter((i: any) => String(i.key) !== String(parentKey))
    .map(toHit)
}

// ---- Single-issue detail + comments + attachments (used by the crawler) ----

function isoOrNull(v: unknown): string | null {
  if (v == null || v === '') return null
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Full detail for one issue (by key), including embedded attachments. */
export async function getTaskDetail(key: string): Promise<TaskDetail> {
  const c = creds()
  const issue = await jiraFetch(
    `/issue/${encodeURIComponent(key)}?fields=*all&expand=names`,
  )
  const f = issue.fields ?? {}
  const assignee = f.assignee?.displayName ?? f.assignee?.emailAddress
  const attachments: TaskAttachment[] = (f.attachment ?? []).map((a: any) => ({
    id: String(a.id),
    title: String(a.filename ?? a.id),
    url: String(a.content ?? ''), // needs auth — downloadAttachment adds it
    extension: String(a.filename ?? '').split('.').pop() ?? '',
    size: Number(a.size ?? 0),
  }))

  // Surface a few Jira-specific fields through the generic customFields channel.
  const customFields: { name: string; value: string }[] = []
  if (f.issuetype?.name) customFields.push({ name: 'Type', value: String(f.issuetype.name) })
  if (f.reporter?.displayName)
    customFields.push({ name: 'Reporter', value: String(f.reporter.displayName) })
  for (const [key2, label] of [['fixVersions', 'Fix versions'], ['components', 'Components']] as const) {
    const arr = Array.isArray(f[key2]) ? f[key2] : []
    const names = arr.map((x: any) => String(x.name ?? '')).filter(Boolean)
    if (names.length) customFields.push({ name: label, value: names.join(', ') })
  }

  return {
    id: String(issue.key),
    customId: String(issue.key),
    displayId: String(issue.key),
    name: String(f.summary ?? ''),
    status: String(f.status?.name ?? ''),
    description: adfToMarkdown(f.description),
    url: `${c.url}/browse/${issue.key}`,
    listName: String(f.project?.name ?? f.project?.key ?? ''),
    folderName: f.project?.key ? String(f.project.key) : null,
    spaceName: f.project?.name ? String(f.project.name) : null,
    priority: f.priority?.name ? String(f.priority.name) : null,
    assignees: assignee ? [String(assignee)] : [],
    tags: Array.isArray(f.labels) ? f.labels.map((l: any) => String(l)) : [],
    dueDate: isoOrNull(f.duedate),
    dateCreated: isoOrNull(f.created),
    dateUpdated: isoOrNull(f.updated),
    customFields,
    attachments,
  }
}

/** Comments on an issue, oldest first. */
export async function getTaskComments(key: string): Promise<TaskComment[]> {
  const data = await jiraFetch(
    `/issue/${encodeURIComponent(key)}/comment?orderBy=created&maxResults=100`,
  )
  const comments: any[] = data.comments ?? []
  return comments.map((c) => ({
    id: String(c.id),
    text: adfToMarkdown(c.body),
    user: String(c.author?.displayName ?? c.author?.emailAddress ?? 'unknown'),
    date: isoOrNull(c.created),
  }))
}

/**
 * Download one attachment's bytes. Unlike ClickUp's presigned URLs, Jira's
 * attachment `content` endpoint requires the same Basic auth as the API.
 */
export async function downloadAttachment(url: string): Promise<Buffer> {
  const c = creds()
  const res = await fetch(url, { headers: { Authorization: authHeader(c) } })
  if (!res.ok) {
    throw Object.assign(new Error(`attachment download failed (${res.status})`), { status: 502 })
  }
  return Buffer.from(await res.arrayBuffer())
}
