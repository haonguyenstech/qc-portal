import type {
  ClaudeModelTestResult,
  ClaudeStatus,
  McpServer,
  Project,
  RunDetail,
  RunSummary,
  SkillFile,
  SkillSummary,
} from './types'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) return undefined as T
  return res.json() as Promise<T>
}

// ---- Projects ----

export function listProjects(): Promise<Project[]> {
  return request('/api/projects')
}

/** Opens a native folder picker on the local machine; returns the chosen absolute path. */
export function pickFolder(): Promise<{ path: string | null; canceled: boolean }> {
  return request('/api/projects/pick-folder')
}

export interface FolderListing {
  path: string
  parent: string | null
  entries: { name: string; path: string }[]
  drives: string[]
  separator: string
  home: string
  error?: string
}

/**
 * Lists a folder's sub-directories via the server (no native OS dialog). Works
 * however the portal was launched. Omit `path` to start at the user's home dir.
 */
export function browseFolder(path?: string): Promise<FolderListing> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : ''
  return request(`/api/projects/browse-folder${qs}`)
}

/** Creates a new sub-folder under `parent` and returns its absolute path. */
export function createFolder(parent: string, name: string): Promise<{ path: string; name: string }> {
  return request('/api/projects/create-folder', {
    method: 'POST',
    body: JSON.stringify({ parent, name }),
  })
}

export function createProject(
  body: { name: string; rootPath: string },
): Promise<Project & { created?: string[]; templateName?: string | null }> {
  return request('/api/projects', { method: 'POST', body: JSON.stringify(body) })
}

export function updateProject(
  id: string,
  body: {
    name?: string
    rootPath?: string
    description?: string
    diagram?: string
    /** Pin (or unpin) the project so it sorts to the top of the list. */
    pinned?: boolean
    /** When true, also rename the folder on disk to match `name`. */
    renameFolder?: boolean
    /** Run the anti-hallucination grounding check after AI writes (per project). */
    groundingCheck?: boolean
    /** Model alias for the grounding check (haiku/sonnet/opus). */
    groundingCheckModel?: string
    /** Auto-capture durable facts into memory/knowledge after runs (per project). */
    autoLearn?: boolean
    /** Model alias for the auto-learn reflection. */
    autoLearnModel?: string
    /** Skill auto-selected on the Launch QC Run page ('' clears the default). */
    defaultSkill?: string
  },
): Promise<Project> {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteProject(id: string): Promise<{ ok: true; deletedPath: string | null }> {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * Download a project's QC artifacts (CLAUDE.md, .claude, .mcp.json, testing/) as a
 * .zip. Streams the response to a blob and triggers a browser save.
 */
export async function exportProject(id: string, name: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(id)}/export`)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  const blob = await res.blob()
  const safe = name.replace(/[/\\:*?"<>|]+/g, ' ').trim() || 'project'
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${safe}.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/**
 * Create a project by extracting an exported .zip into `<parentPath>/<name>`.
 * The zip is sent as the raw request body (binary) with the name + parent folder
 * as query params — no base64/JSON, so large exports transfer reliably.
 */
export async function importProject(body: {
  name: string
  parentPath: string
  file: File | Blob
}): Promise<Project> {
  const qs = new URLSearchParams({ name: body.name, parentPath: body.parentPath })
  const res = await fetch(`/api/projects/import?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/zip' },
    body: body.file,
  })
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    const text = await res.text().catch(() => '')
    if (text) {
      try {
        message = (JSON.parse(text).error as string) || text
      } catch {
        message = text
      }
    }
    throw new Error(message)
  }
  return res.json() as Promise<Project>
}

/**
 * Scaffold a project folder for Claude Code (CLAUDE.md, .claude/skills, .mcp.json),
 * cloning from a template project that already has them. Returns the refreshed
 * project plus which artifacts were created and the template used.
 */
export function initProject(
  id: string,
): Promise<Project & { created: string[]; templateName: string | null }> {
  return request(`/api/projects/${encodeURIComponent(id)}/init`, { method: 'POST' })
}

// ---- Project CLAUDE.md ----

export interface ProjectClaudeMd {
  content: string // the file's text ('' when it doesn't exist yet)
  exists: boolean // whether CLAUDE.md is present at the project root
  savedAt: string | null // ISO mtime, or null when absent
  size: number // bytes on disk
}

/** Read the project's root CLAUDE.md (the Claude Code guidance for that repo). */
export function getProjectClaudeMd(projectId: string): Promise<ProjectClaudeMd> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/claude-md`)
}

/** Create or overwrite the project's root CLAUDE.md. */
export function saveProjectClaudeMd(
  projectId: string,
  content: string,
): Promise<ProjectClaudeMd> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/claude-md`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

// ---- Runs ----

export function createRun(body: {
  projectId: string
  ticketId: string
  appUrl: string
  skill?: string
  instructions?: string
  model?: string
  relatedTickets?: string[]
  workflowSteps?: string[]
  testTarget?: 'web' | 'web-mobile' | 'app-mobile'
}): Promise<{ runId: string } & RunSummary> {
  return request('/api/qc/run', { method: 'POST', body: JSON.stringify(body) })
}

/** Server-side reachability probe for the run form's App URL (browser fetch would hit CORS). */
export function checkAppUrl(
  url: string,
): Promise<{ ok: boolean; status?: number; finalUrl?: string; error?: string }> {
  return request('/api/qc/check-url', { method: 'POST', body: JSON.stringify({ url }) })
}

export function listRuns(projectId?: string): Promise<RunSummary[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return request(`/api/qc/runs${qs}`)
}

export function getRun(id: string): Promise<RunDetail> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}`)
}

export function cancelRun(id: string): Promise<void> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

/** Stop a run but keep it resumable (the Claude session is preserved). */
export function pauseRun(id: string): Promise<void> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}/pause`, { method: 'POST' })
}

/** Continue a previously paused run from where it stopped. */
export function resumeRun(id: string): Promise<void> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}/resume`, { method: 'POST' })
}

// ---- Skills ----

export function listSkills(projectId: string): Promise<SkillSummary[]> {
  return request(`/api/skills?projectId=${encodeURIComponent(projectId)}`)
}

export function getSkill(name: string, projectId: string): Promise<SkillFile[]> {
  return request(
    `/api/skills/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

export function saveSkillFile(
  name: string,
  file: string,
  content: string,
  projectId: string,
): Promise<void> {
  return request(
    `/api/skills/${encodeURIComponent(name)}/${encodeURIComponent(file)}?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content, projectId }),
    },
  )
}

export function createSkill(
  name: string,
  description: string,
  projectId: string,
): Promise<void> {
  return request(`/api/skills?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ name, description, projectId }),
  })
}

/** Edit a skill's name and/or description; renaming moves its folder. Returns the updated summary. */
export function updateSkill(
  name: string,
  changes: { name?: string; description?: string },
  projectId: string,
): Promise<SkillSummary> {
  return request(
    `/api/skills/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ ...changes, projectId }),
    },
  )
}

/** Delete a skill, removing its folder from the project's .claude/skills. */
export function deleteSkill(name: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/skills/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's .claude/skills folder in the OS file explorer (Finder/Explorer). */
export function openSkillsFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/skills/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

/** Opens the native folder picker and imports the chosen skill folder into the project. */
export function importSkill(
  projectId: string,
): Promise<(SkillSummary & { canceled?: false }) | { canceled: true }> {
  return request(`/api/skills/import?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

/** Upload a drag-and-dropped skill folder (files carry base64 content). */
export function uploadSkill(
  name: string,
  files: { path: string; content: string }[],
  projectId: string,
): Promise<SkillSummary> {
  return request(`/api/skills/upload?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ name, files, projectId }),
  })
}

// ---- AI runtime ----

export function claudeStatus(): Promise<ClaudeStatus> {
  return request('/api/ai/claude/status')
}

export function testClaudeModel(model: string): Promise<ClaudeModelTestResult> {
  return request('/api/ai/claude/test', {
    method: 'POST',
    body: JSON.stringify({ model }),
  })
}

export interface UsageWindow {
  label: string // e.g. "Current session", "Current week (all models)"
  percent: number // 0–100 of the subscription limit used
  reset: string // human text, e.g. "Jun 28 at 12pm (Asia/Saigon)"
}

export interface UsageStatus {
  available: boolean
  windows: UsageWindow[]
  details: string // the "what's contributing" breakdown text
  raw: string
  error: string | null
  generatedAt: string
  stale?: boolean // true when a refresh failed and the last good reading is shown
}

/** Real Claude subscription usage, read live from Claude Code's `/usage`. */
export function claudeUsage(): Promise<UsageStatus> {
  return request('/api/ai/usage')
}

// ---- ClickUp ----

export interface ClickupWorkspace {
  id: string
  name: string
}

export interface ClickupTask {
  id: string
  customId: string | null
  displayId: string
  name: string
  status: string
  statusColor: string
  listName: string
  url: string
  parent: string | null // internal id of the parent task when this is a subtask
}

// Passing projectId lets the server use that project's .mcp.json ClickUp token
// (what the in-app Connect writes), so re-auth takes effect without a restart.
function pid(projectId?: string): string {
  return projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''
}

export function clickupStatus(projectId?: string): Promise<{ configured: boolean }> {
  return request(`/api/clickup/status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
}

/**
 * Reveal a tickets folder in the OS file explorer. With no `folder`, opens
 * testing/tickets; with one, opens that ticket's testcases/ subfolder (or the
 * ticket folder itself).
 */
export function openTicketsFolder(
  projectId: string,
  folder?: string,
): Promise<{ ok: true; path: string }> {
  return request(`/api/clickup/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ projectId, folder }),
  })
}

export function clickupWorkspaces(projectId?: string): Promise<ClickupWorkspace[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return request(`/api/clickup/workspaces${qs}`)
}

export function clickupTasks(team: string, q: string, projectId?: string): Promise<ClickupTask[]> {
  return request(
    `/api/clickup/tasks?team=${encodeURIComponent(team)}&q=${encodeURIComponent(q)}${pid(projectId)}`,
  )
}

export interface ClickupSpace {
  id: string
  name: string
}

export interface ClickupList {
  id: string
  name: string
  folderName: string | null
}

export function clickupSpaces(team: string, projectId?: string): Promise<ClickupSpace[]> {
  return request(`/api/clickup/spaces?team=${encodeURIComponent(team)}${pid(projectId)}`)
}

export function clickupLists(space: string, projectId?: string): Promise<ClickupList[]> {
  return request(`/api/clickup/lists?space=${encodeURIComponent(space)}${pid(projectId)}`)
}

export interface ClickupDoc {
  id: string
  name: string
}

export function clickupDocs(team: string, q: string, projectId?: string): Promise<ClickupDoc[]> {
  return request(
    `/api/clickup/docs?team=${encodeURIComponent(team)}&q=${encodeURIComponent(q)}${pid(projectId)}`,
  )
}

/** Read a ClickUp doc and have Claude write a project overview (markdown). */
export function overviewFromDoc(body: {
  team: string
  docId: string
  docName?: string
  projectName?: string
  projectId?: string
}): Promise<{ overview: string; docName: string }> {
  return request('/api/ai/overview-from-doc', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Have Claude synthesize a project overview from selected ClickUp docs AND tickets. */
export function overviewFromSources(body: {
  team: string
  docs: { id: string; name: string }[]
  tickets: { id: string; displayId: string; name: string }[]
  projectName?: string
  projectId?: string
  /** Extra free-text instructions woven into the prompt. */
  instructions?: string
  /** 'replace' drafts fresh; 'update' revises/extends the existing overview. */
  mode?: 'replace' | 'update'
  /** The current overview markdown — used when mode is 'update'. */
  existing?: string
}): Promise<{ overview: string; sourceCount: number }> {
  return request('/api/ai/overview-from-sources', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function diagramFromSources(body: {
  team: string
  docs: { id: string; name: string }[]
  tickets: { id: string; displayId: string; name: string }[]
  projectName?: string
  projectId?: string
  /** Extra free-text instructions woven into the diagram prompt. */
  instructions?: string
}): Promise<{ mermaid: string; sourceCount: number }> {
  return request('/api/ai/diagram-from-sources', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ---- Named project diagrams (multiple per project, Overview page) ----

export interface Diagram {
  id: string
  projectId: string
  name: string
  content: string // Mermaid source
  createdAt: string
  updatedAt: string
}

export function listDiagrams(projectId: string): Promise<{ diagrams: Diagram[] }> {
  return request(`/api/diagrams?projectId=${encodeURIComponent(projectId)}`)
}

export function createDiagram(body: {
  projectId: string
  name: string
  content: string
}): Promise<{ diagram: Diagram }> {
  return request('/api/diagrams', { method: 'POST', body: JSON.stringify(body) })
}

export function updateDiagram(
  id: string,
  body: { projectId: string; name?: string; content?: string },
): Promise<{ diagram: Diagram }> {
  return request(`/api/diagrams/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

export function deleteDiagram(id: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/diagrams/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

export function clickupListTasks(
  list: string,
  q: string,
  projectId?: string,
): Promise<ClickupTask[]> {
  return request(
    `/api/clickup/list-tasks?list=${encodeURIComponent(list)}&q=${encodeURIComponent(q)}${pid(projectId)}`,
  )
}

export interface CrawlResult {
  displayId: string
  name: string
  ticketKind: 'feature' | 'bug' | null
  dir: string // path relative to the project root, e.g. testing/tickets/ABC-1
  absDir: string
  files: { path: string; bytes: number }[]
  commentCount: number
  attachmentCount: number
  attachmentTotal: number
  attachmentErrors: string[]
  // Set when a model was chosen: whether the AI summary (summary.md) was written.
  // null/absent means download-only — no summary was attempted.
  summary?: { ok: boolean; model: string | null; error: string | null } | null
}

/**
 * Download a ClickUp ticket (detail + comments + attachments) into the project
 * folder. When `model` is a Claude alias (haiku/sonnet/opus), that model also
 * writes a QC summary (summary.md); omit or pass 'none' to download only.
 */
export function crawlTicket(
  taskId: string,
  projectId: string,
  model?: string,
  ticketKind?: 'feature' | 'bug' | null,
): Promise<CrawlResult> {
  return request('/api/clickup/crawl', {
    method: 'POST',
    body: JSON.stringify({ taskId, projectId, model: model ?? 'none', ticketKind }),
  })
}

/** Subtasks (all descendants) of one parent ticket, loaded on demand. */
export function clickupSubtasks(parent: string, projectId?: string): Promise<ClickupTask[]> {
  return request(
    `/api/clickup/subtasks?parent=${encodeURIComponent(parent)}${pid(projectId)}`,
  )
}

export function createClickupIssueSubtasks(body: {
  parentTask: string
  issues: { title: string; description: string; screenshots?: string[] }[]
  projectId?: string
  slug?: string | null
}): Promise<{ created: ClickupTask[] }> {
  const qs = body.projectId ? `?projectId=${encodeURIComponent(body.projectId)}` : ''
  return request(`/api/clickup/issues/subtasks${qs}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ---- Crawl background jobs (server-side, survive browser reload) ----

export type CrawlItemStatus = 'pending' | 'running' | 'done' | 'error'

export interface CrawlJobItem {
  taskId: string
  displayId: string
  name: string
  status: CrawlItemStatus
  result?: CrawlResult
  error?: string
}

export type CrawlLogLevel = 'info' | 'success' | 'error'

export interface CrawlLogLine {
  time: string
  level: CrawlLogLevel
  text: string
}

export interface CrawlJob {
  id: string
  projectId: string
  status: 'running' | 'done'
  model: string
  ticketKind: 'feature' | 'bug' | null
  total: number
  doneCount: number
  createdAt: string
  updatedAt: string
  items: CrawlJobItem[]
  logs: CrawlLogLine[]
}

/** Start a background job that crawls one or more ClickUp tickets to disk. */
export function startCrawlJob(body: {
  projectId: string
  // `relDir` (e.g. "PARENT/CHILD") nests a subtask under its parent on disk; omit for flat.
  tickets: { id: string; displayId: string; name: string; relDir?: string }[]
  model?: string
  ticketKind?: 'feature' | 'bug' | null
}): Promise<{ jobId: string; job: CrawlJob }> {
  return request('/api/clickup/crawl/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

// ---- Jira (same shapes as ClickUp — the ticket UI is source-agnostic) ----
// The picker + crawler treat Jira exactly like ClickUp: a "workspace" is a Jira
// project (id = project key), a "task" is an issue, and crawl jobs share the same
// registry (so getCrawlJob/listCrawlJobs above resolve Jira jobs too).

export function jiraStatus(projectId?: string): Promise<{ configured: boolean }> {
  return request(`/api/jira/status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
}

export function jiraWorkspaces(projectId?: string): Promise<ClickupWorkspace[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return request(`/api/jira/workspaces${qs}`)
}

/** Search issues within a Jira project (`team` is the project key). */
export function jiraTasks(team: string, q: string, projectId?: string): Promise<ClickupTask[]> {
  return request(
    `/api/jira/tasks?team=${encodeURIComponent(team)}&q=${encodeURIComponent(q)}${pid(projectId)}`,
  )
}

/** Subtasks (children) of one Jira issue, loaded on demand. */
export function jiraSubtasks(parent: string, projectId?: string): Promise<ClickupTask[]> {
  return request(`/api/jira/subtasks?parent=${encodeURIComponent(parent)}${pid(projectId)}`)
}

/** Start a background job that crawls one or more Jira issues to disk. */
export function startJiraCrawlJob(body: {
  projectId: string
  tickets: { id: string; displayId: string; name: string; relDir?: string }[]
  model?: string
  ticketKind?: 'feature' | 'bug' | null
}): Promise<{ jobId: string; job: CrawlJob }> {
  return request('/api/jira/crawl/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Poll one crawl job by id. */
export function getCrawlJob(jobId: string, projectId: string): Promise<{ job: CrawlJob }> {
  return request(
    `/api/clickup/crawl/jobs/${encodeURIComponent(jobId)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** List this project's crawl jobs (newest first). */
export function listCrawlJobs(projectId: string): Promise<{ jobs: CrawlJob[] }> {
  return request(`/api/clickup/crawl/jobs?projectId=${encodeURIComponent(projectId)}`)
}

// ---- Source code (connect one or more GitHub/Bitbucket repos, each with a tag) ----

export interface SourceRepo {
  id: string
  tag: string // "Backend repo", "Frontend repo", …
  repoUrl: string
  provider: string // 'github' | 'bitbucket' | 'other' | ''
  branch: string
  sourcePath: string // absolute local folder of the source
  lastSync: string // ISO
  lastCommit: string // "<shortSha> <subject>"
  hasToken: boolean // a private-repo token is stored (never returned raw)
  credential: {
    label: string
    tokenPreview: string
    username: boolean
  } | null
  live: { isRepo: boolean; branch: string; lastCommit: string; remoteUrl: string } | null
}

export interface SourceInfo {
  connected: boolean
  rootPath: string
  sources: SourceRepo[]
}

export type SourceJobKind = 'clone' | 'sync'

export interface SourceLogLine {
  time: string
  level: 'info' | 'success' | 'error'
  text: string
}

export interface SourceJob {
  id: string
  kind: SourceJobKind
  projectId: string
  sourceId: string
  tag: string
  status: 'running' | 'done' | 'error'
  error?: string
  branch: string
  logs: SourceLogLine[]
  result?: { sourcePath: string; branch: string; lastCommit: string }
  createdAt: string
  updatedAt: string
}

/** Read all of the project's connected source repos + live on-disk status. */
export function getSource(projectId: string): Promise<SourceInfo> {
  return request(`/api/source?projectId=${encodeURIComponent(projectId)}`)
}

/** Read one repo's stored access token (+ username) for clipboard copy / edit prefill. */
export function getSourceCredential(
  projectId: string,
  sourceId: string,
): Promise<{ token: string; username: string }> {
  return request(
    `/api/source/credential?projectId=${encodeURIComponent(projectId)}&sourceId=${encodeURIComponent(sourceId)}`,
  )
}

/**
 * Connect (clone/adopt) a repo under a tag. Runs as a background job — poll
 * getSourceJob. Pass sourceId to re-point an existing repo ("Change repository").
 */
export function connectSource(body: {
  projectId: string
  url: string
  tag?: string
  branch?: string
  token?: string
  username?: string
  sourceId?: string
}): Promise<{ jobId: string; job: SourceJob }> {
  return request(`/api/source/connect?projectId=${encodeURIComponent(body.projectId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Refresh one connected repo (git pull). Runs as a background job. */
export function syncSource(
  projectId: string,
  sourceId: string,
): Promise<{ jobId: string; job: SourceJob }> {
  return request(`/api/source/sync?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  })
}

/** Forget one connected repo (the files on disk are left alone). */
export function disconnectSource(projectId: string, sourceId: string): Promise<{ ok: true }> {
  return request(`/api/source/disconnect?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  })
}

export function getSourceJob(jobId: string, projectId: string): Promise<{ job: SourceJob }> {
  return request(
    `/api/source/jobs/${encodeURIComponent(jobId)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

export function listSourceJobs(projectId: string): Promise<{ jobs: SourceJob[] }> {
  return request(`/api/source/jobs?projectId=${encodeURIComponent(projectId)}`)
}

/** Reveal a source folder (a specific repo's, or the shared source dir) in the OS file explorer. */
export function openSourceFolder(
  projectId: string,
  sourceId?: string,
): Promise<{ ok: true; path: string }> {
  return request(`/api/source/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ sourceId }),
  })
}

export interface CrawledTicket {
  name: string // folder path under testing/tickets/ — nested (PARENT/CHILD) for subtasks, else the sanitized displayId
  parent?: string | null // `name` of the enclosing ticket folder when nested, else null/undefined
  crawledAt: string | null // ISO time of the last crawl
  hasTestcases: boolean // at least one test-case version has been generated
  testcaseVersions: number // how many test-case versions are stored
  title: string | null // ticket title (from the stored ticket.json), if available
  displayId: string | null // ticket display id (e.g. ABC-123), if available
  status: string | null // ClickUp status (e.g. "in progress"), if available
  priority: string | null // ClickUp priority (e.g. "urgent"), if available
  url: string | null // ClickUp ticket URL, if available
}

/** Tickets already crawled into the project's testing/tickets/, with last-crawl time. */
export function listCrawledTickets(projectId: string): Promise<CrawledTicket[]> {
  return request(`/api/clickup/crawled?projectId=${encodeURIComponent(projectId)}`)
}

/** Remove one crawled ticket's folder from the project's testing/tickets/. */
export function deleteCrawledTicket(name: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/clickup/crawled/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

// ---- Design verification (ticket vs Figma) ----

export type FindingCategory = 'match' | 'mismatch' | 'concern' | 'unsure' | 'discuss'

export interface DesignFinding {
  category: FindingCategory
  title: string
  detail: string
}

export interface VerifyDesignResult {
  summary: string
  findings: DesignFinding[]
  model: string
  raw: string
  /** Saved markdown report path, relative to the project root (or null). */
  savedPath: string | null
  /** ISO timestamp the report was saved. */
  savedAt: string | null
  /** DB record id for this run (or null if recording failed). */
  recordId: string | null
}

/** Have an AI model verify a crawled ticket against a linked Figma design. */
export function verifyDesign(body: {
  projectId: string
  folder: string
  figmaUrl: string
  instructions?: string
  model?: string
  projectName?: string
  /** One-off checklist for this run; overrides the saved project design-check checklist. */
  checklist?: { name: string; content: string } | null
}): Promise<VerifyDesignResult> {
  return request('/api/ai/verify-design', { method: 'POST', body: JSON.stringify(body) })
}

/** One saved Design Check record (persisted on every /verify run). */
export interface DesignCheckRecord {
  id: string
  projectId: string
  folder: string
  figmaUrl: string
  model: string
  summary: string
  findings: DesignFinding[]
  counts: { match: number; mismatch: number; concern: number; unsure: number; discuss: number; total: number }
  filePath: string | null
  createdAt: string
}

/** A project's saved Design Check history, newest first. */
export function listDesignChecks(projectId: string): Promise<DesignCheckRecord[]> {
  return request<{ checks: DesignCheckRecord[] }>(
    `/api/ai/verify-design/history?projectId=${encodeURIComponent(projectId)}`,
  ).then((r) => r.checks)
}

/** Reveal the project's design-check/ folder in the OS file explorer. */
export function openDesignCheckFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request('/api/ai/verify-design/open', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

// ---- Design Check background jobs ----
// A verify runs server-side so it finishes even if the browser reloads or navigates
// away; the client polls the job by id for the live log and the findings. A verify
// run is a single Claude run, so there's no batch and no pause/resume — just
// running → done / error / cancelled.

/** Whole-job status. `done`/`error`/`cancelled` are terminal. */
export type VerifyJobStatus = 'running' | 'done' | 'error' | 'cancelled'

export type VerifyLogLevel = 'info' | 'success' | 'error'

export interface VerifyLogLine {
  time: string
  level: VerifyLogLevel
  text: string
}

/** The findings payload, surfaced once a Design Check job finishes. */
export interface VerifyJobResult {
  summary: string
  findings: DesignFinding[]
  model: string
  savedPath: string | null
  savedAt: string | null
  recordId: string | null
}

export interface VerifyJob {
  id: string
  projectId: string
  folder: string
  figmaUrl: string
  model: string
  status: VerifyJobStatus
  logs: VerifyLogLine[]
  result: VerifyJobResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** Start a background Design Check job for a crawled ticket against a Figma design. */
export function startVerifyDesignJob(body: {
  projectId: string
  folder: string
  figmaUrl: string
  instructions?: string
  model?: string
  projectName?: string
  /** One-off checklist for this run; overrides the saved project design-check checklist. */
  checklist?: { name: string; content: string } | null
}): Promise<{ jobId: string; job: VerifyJob }> {
  return request('/api/ai/verify-design/jobs', { method: 'POST', body: JSON.stringify(body) })
}

/** Poll one Design Check job by id. */
export function getVerifyDesignJob(jobId: string): Promise<{ job: VerifyJob }> {
  return request(`/api/ai/verify-design/jobs/${encodeURIComponent(jobId)}`)
}

/** List this project's Design Check jobs (newest first). */
export function listVerifyDesignJobs(projectId: string): Promise<{ jobs: VerifyJob[] }> {
  return request(`/api/ai/verify-design/jobs?projectId=${encodeURIComponent(projectId)}`)
}

/** Cancel a running Design Check job (terminal) — kills the in-flight Claude run. */
export function cancelVerifyDesignJob(jobId: string): Promise<{ job: VerifyJob }> {
  return request(`/api/ai/verify-design/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  })
}

// ---- Project file templates ----

export interface ProjectTemplate {
  key: string // template kind, e.g. 'testcase'
  content: string // the template text
  size: number // bytes on disk
  savedAt: string // ISO mtime
}

/** Every reusable template saved under the project's testing/templates/. */
export function listTemplates(projectId: string): Promise<ProjectTemplate[]> {
  return request(`/api/templates?projectId=${encodeURIComponent(projectId)}`)
}

/** Create or overwrite a template's content. */
export function saveTemplate(
  key: string,
  content: string,
  projectId: string,
): Promise<ProjectTemplate> {
  return request(
    `/api/templates/${encodeURIComponent(key)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify({ content }) },
  )
}

/** Delete a stored template. */
export function deleteTemplate(key: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/templates/${encodeURIComponent(key)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's testing/templates folder in the OS file explorer. */
export function openTemplatesFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/templates/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

// ---- Project knowledge docs (uploaded Docs/PDF/Markdown, converted to .md) ----

export interface KnowledgeDoc {
  name: string // file base name (no extension)
  source?: string // provenance: '' for uploads; 'ai · …' for AI-captured docs
  size: number // bytes on disk
  savedAt: string // ISO mtime
}

/** List the project's uploaded knowledge docs (metadata only, newest first). */
export function listKnowledge(projectId: string): Promise<KnowledgeDoc[]> {
  return request(`/api/knowledge?projectId=${encodeURIComponent(projectId)}`)
}

/** Fetch one doc's full converted Markdown (for the preview dialog). */
export function getKnowledgeDoc(
  name: string,
  projectId: string,
): Promise<KnowledgeDoc & { content: string }> {
  return request(
    `/api/knowledge/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Create or overwrite a knowledge doc with its converted Markdown. */
export function saveKnowledgeDoc(
  name: string,
  content: string,
  projectId: string,
): Promise<KnowledgeDoc> {
  return request(
    `/api/knowledge/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify({ content }) },
  )
}

/** Delete a stored knowledge doc. */
export function deleteKnowledgeDoc(name: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/knowledge/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's testing/knowledge folder in the OS file explorer. */
export function openKnowledgeFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/knowledge/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

// ---- Environments & test accounts (single per-project sheet, testing/environments.md) ----

export interface AccountsDoc {
  content: string // the sheet's markdown (URLs + test accounts)
  exists: boolean // false when the project has no sheet yet
  size: number // bytes on disk
  savedAt: string | null // ISO mtime, or null when it doesn't exist
}

/** Read the project's environments & test-accounts sheet. */
export function getAccounts(projectId: string): Promise<AccountsDoc> {
  return request(`/api/accounts?projectId=${encodeURIComponent(projectId)}`)
}

/** Create/overwrite the sheet (blank content clears it). */
export function saveAccounts(content: string, projectId: string): Promise<AccountsDoc> {
  return request(`/api/accounts?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  })
}

/** Remove the sheet. */
export function deleteAccounts(projectId: string): Promise<{ ok: true }> {
  return request(`/api/accounts?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

/** Reveal the project's testing/ folder (where environments.md lives) in the OS file explorer. */
export function openAccountsFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/accounts/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

// ---- Project memory (in-portal-authored fact notes, testing/memory/*.md) ----

export interface MemoryNote {
  name: string // file base name (no extension)
  description: string // one-line summary (frontmatter) — shown in the list + index
  source?: string // provenance: '' for hand-authored; 'ai · …' for AI-captured notes
  size: number // bytes on disk
  savedAt: string // ISO mtime
}

/** List the project's memory notes (metadata only, newest first). */
export function listMemory(projectId: string): Promise<MemoryNote[]> {
  return request(`/api/memory?projectId=${encodeURIComponent(projectId)}`)
}

/** Fetch one note's description + markdown body (for the editor). */
export function getMemoryNote(
  name: string,
  projectId: string,
): Promise<MemoryNote & { content: string }> {
  return request(
    `/api/memory/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Create or overwrite a memory note. */
export function saveMemoryNote(
  name: string,
  description: string,
  content: string,
  projectId: string,
): Promise<MemoryNote> {
  return request(
    `/api/memory/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify({ description, content }) },
  )
}

/** Delete a stored memory note. */
export function deleteMemoryNote(name: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/memory/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's testing/memory folder in the OS file explorer. */
export function openMemoryFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/memory/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

// ---- Test cases ----

/** Output shape of a generated test-case version — CSV (template-driven) or Markdown. */
export type TestCaseFormat = 'markdown' | 'csv'

export interface TestCaseResult {
  testcases: string
  savedTo: string
  version: number
  usedTemplate: boolean
  format: TestCaseFormat
}

/**
 * Generate manual test cases from a crawled ticket (read from its on-disk files),
 * optionally following an uploaded template. Saves a NEW version under the ticket's
 * testcases/ folder and returns its version number.
 */
export function generateTestCases(body: {
  projectId: string
  folder: string
  template?: { name: string; content: string } | null
  instructions?: string
  projectName?: string
  model?: string
  /** Optional live app URL — Claude opens it to ground the cases in the real UI. */
  appUrl?: string
}): Promise<TestCaseResult> {
  return request('/api/ai/testcases', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export interface TestCaseVersion {
  version: number
  savedAt: string | null
  label: string
  format: TestCaseFormat
}

/** List the stored test-case versions for a crawled ticket (latest first). */
export function listTestCaseVersions(
  folder: string,
  projectId: string,
): Promise<{ versions: TestCaseVersion[] }> {
  return request(
    `/api/ai/testcases?folder=${encodeURIComponent(folder)}&projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Fetch one stored test-case version (Markdown or CSV) for a crawled ticket. */
export function getTestCaseVersion(
  folder: string,
  version: number,
  projectId: string,
): Promise<{
  testcases: string | null
  savedAt: string | null
  version: number
  format: TestCaseFormat
}> {
  return request(
    `/api/ai/testcases?folder=${encodeURIComponent(folder)}&version=${encodeURIComponent(version)}&projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Delete one stored test-case version for a crawled ticket. */
export function deleteTestCaseVersion(
  folder: string,
  version: number,
  projectId: string,
): Promise<{ ok: true }> {
  return request(
    `/api/ai/testcases?folder=${encodeURIComponent(folder)}&version=${encodeURIComponent(version)}&projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Result of an AI single-cell edit on a CSV test-case version. */
export interface EditTestcaseCellResult {
  testcases: string // the full updated CSV
  version: number
  format: 'csv'
  row: number
  col: number
  column: string
  oldValue: string
  newValue: string
}

/**
 * Rewrite one cell of a CSV test-case version (overwrites that version).
 * Pass `comment` to have AI rewrite the cell, or `value` to write an exact value
 * without AI (used for Undo).
 */
export function editTestcaseCell(body: {
  projectId: string
  folder: string
  version: number
  row: number
  col: number
  comment?: string
  value?: string
  model?: string
  projectName?: string
}): Promise<EditTestcaseCellResult> {
  return request('/api/ai/testcases/cell', { method: 'POST', body: JSON.stringify(body) })
}

/** Result of overwriting a whole CSV test-case row. */
export interface EditTestcaseRowResult {
  testcases: string // the full updated CSV
  version: number
  format: 'csv'
  row: number
}

/**
 * Overwrite an entire data row of a CSV test-case version with exact values
 * (one per header column, in order) — no AI. Overwrites that version.
 */
export function editTestcaseRow(body: {
  projectId: string
  folder: string
  version: number
  row: number
  values: string[]
}): Promise<EditTestcaseRowResult> {
  return request('/api/ai/testcases/row', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Delete one or more data rows of a CSV test-case version (overwrites that version).
 * `rows` are absolute parsed-CSV row indices (0 = header, so data rows start at 1);
 * at least one data row must remain. Returns the full updated CSV.
 */
export function deleteTestcaseRows(body: {
  projectId: string
  folder: string
  version: number
  rows: number[]
}): Promise<EditTestcaseRowResult> {
  return request('/api/ai/testcases/rows/delete', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Insert a data row into a CSV test-case version at absolute index `row` (used to undo
 * a delete — puts the removed row back where it was). Returns the full updated CSV.
 */
export function insertTestcaseRow(body: {
  projectId: string
  folder: string
  version: number
  row: number
  values: string[]
}): Promise<EditTestcaseRowResult> {
  return request('/api/ai/testcases/rows/insert', { method: 'POST', body: JSON.stringify(body) })
}

// ---- Test-case background jobs ----
// Generation runs server-side so a batch finishes even if the browser reloads or
// navigates away; the client polls the job by id for progress.

export type TestCaseItemStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled'

/** Whole-job status. `paused` is resumable; `done`/`cancelled` are terminal. */
export type TestCaseJobStatus = 'running' | 'paused' | 'done' | 'cancelled'

export interface TestCaseJobItem {
  folder: string
  status: TestCaseItemStatus
  version?: number
  savedTo?: string
  error?: string
}

export type TestCaseLogLevel = 'info' | 'success' | 'error'

export interface TestCaseLogLine {
  time: string
  level: TestCaseLogLevel
  folder?: string
  text: string
}

export interface TestCaseJob {
  id: string
  projectId: string
  status: TestCaseJobStatus
  total: number
  doneCount: number
  createdAt: string
  updatedAt: string
  items: TestCaseJobItem[]
  logs: TestCaseLogLine[]
}

/** Start a background job generating test cases for one or more crawled tickets. */
export function startTestCaseJob(body: {
  projectId: string
  folders: string[]
  /** Optional per-folder live app URL (folder → url) to ground that ticket's cases. */
  appUrls?: Record<string, string>
  template?: { name: string; content: string } | null
  instructions?: string
  projectName?: string
  model?: string
}): Promise<{ jobId: string; job: TestCaseJob }> {
  return request('/api/ai/testcases/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Poll one test-case generation job by id. */
export function getTestCaseJob(jobId: string): Promise<{ job: TestCaseJob }> {
  return request(`/api/ai/testcases/jobs/${encodeURIComponent(jobId)}`)
}

/** List this project's test-case generation jobs (newest first). */
export function listTestCaseJobs(projectId: string): Promise<{ jobs: TestCaseJob[] }> {
  return request(`/api/ai/testcases/jobs?projectId=${encodeURIComponent(projectId)}`)
}

/** Pause a running job (interrupts the current ticket; keeps it resumable). */
export function pauseTestCaseJob(jobId: string): Promise<{ job: TestCaseJob }> {
  return request(`/api/ai/testcases/jobs/${encodeURIComponent(jobId)}/pause`, { method: 'POST' })
}

/** Resume a paused job — continue with the remaining tickets. */
export function resumeTestCaseJob(jobId: string): Promise<{ job: TestCaseJob }> {
  return request(`/api/ai/testcases/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' })
}

/** Cancel a job (terminal) — stop the current ticket and skip the rest. */
export function cancelTestCaseJob(jobId: string): Promise<{ job: TestCaseJob }> {
  return request(`/api/ai/testcases/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
}

// ---- MCP ----

export function listMcp(projectId: string): Promise<McpServer[]> {
  return request(`/api/mcp?projectId=${encodeURIComponent(projectId)}`)
}

/**
 * Whether Astral's `uv`/`uvx` is installed on the machine running the server.
 * ClickUp + Jira MCP servers run via `uvx`, so a missing `uv` makes them fail to
 * spawn. `platform` is node's process.platform, for a matching install hint.
 */
export function mcpUvStatus(): Promise<{
  available: boolean
  version: string | null
  platform: string
}> {
  return request('/api/mcp/uv')
}

export function addMcp(body: Partial<McpServer>, projectId: string): Promise<void> {
  return request(`/api/mcp?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ ...body, projectId }),
  })
}

/** Run a real connection test against a configured server (spawns it via the Claude CLI). */
export function testMcp(
  name: string,
  projectId: string,
): Promise<{ ok: boolean; detail: string }> {
  return request(
    `/api/mcp/test/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

export function removeMcp(name: string, projectId: string): Promise<void> {
  return request(
    `/api/mcp/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the full (unmasked) env value for a server, for the copy action. */
export function revealMcpSecret(
  name: string,
  projectId: string,
): Promise<{ key: string; value: string }> {
  return request(
    `/api/mcp/${encodeURIComponent(name)}/secret?projectId=${encodeURIComponent(projectId)}`,
  )
}

export interface McpCapabilityResult {
  ok: boolean
  /** ok, but with a caveat (e.g. the MCP works yet no devices are connected) — shown amber, not green. */
  warn?: boolean
  detail: string
  data: Record<string, unknown> | null
  raw: string
}

/**
 * Functional MCP test — actually uses the server (ClickUp: fetch a ticket; Figma:
 * read a design; Playwright: open Google & close). `input` is the ticket id / Figma
 * link where the server needs one.
 */
export function runMcpTest(
  name: string,
  projectId: string,
  input?: string,
): Promise<McpCapabilityResult> {
  return request(`/api/mcp/test-run/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ input: input ?? '' }),
  })
}

/** Reveal the project's root folder (where .mcp.json lives) in the OS file explorer. */
export function openMcpFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/mcp/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
  })
}

// ---- MCP OAuth (one-click connect for ClickUp / Figma) ----

export type McpOauthProvider = 'clickup' | 'figma' | 'jira'

export interface McpOauthStatus {
  redirectBase: string
  providers: {
    provider: McpOauthProvider
    hasApp: boolean
    configured: boolean
    tokenUrl: string
  }[]
}

export function mcpOauthStatus(projectId: string): Promise<McpOauthStatus> {
  return request(`/api/mcp/oauth/status?projectId=${encodeURIComponent(projectId)}`)
}

/**
 * Token-connect: save a pasted personal API token into the project's .mcp.json.
 * Jira additionally needs a site URL + account email, passed via `extra`.
 */
export function saveMcpToken(
  provider: McpOauthProvider,
  token: string,
  projectId: string,
  extra?: { url?: string; email?: string },
): Promise<void> {
  return request(
    `/api/mcp/oauth/${encodeURIComponent(provider)}/token?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify({ token, ...extra }) },
  )
}

/** Kick off an OAuth flow — the server opens the provider consent screen in the browser. */
export function startMcpOauth(
  provider: McpOauthProvider,
  projectId: string,
): Promise<{ state: string; authorizeUrl: string }> {
  return request(
    `/api/mcp/oauth/${encodeURIComponent(provider)}/start?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  )
}

/** Poll the result of an in-flight OAuth flow until it is done or errors. */
export function mcpOauthResult(
  provider: McpOauthProvider,
  state: string,
): Promise<{ status: 'pending' | 'done' | 'error' | 'unknown'; error?: string }> {
  return request(
    `/api/mcp/oauth/${encodeURIComponent(provider)}/result?state=${encodeURIComponent(state)}`,
  )
}

// ---- Files ----

export function screenshotUrl(projectId: string, slug: string, path: string): string {
  return `/api/files/screenshot?projectId=${encodeURIComponent(projectId)}&slug=${encodeURIComponent(slug)}&path=${encodeURIComponent(path)}`
}

/** URL that serves any file under a run's testing/<slug>/ folder (reuses the file route). */
export function runFileUrl(projectId: string, slug: string, path: string): string {
  return screenshotUrl(projectId, slug, path)
}

export type RunFileKind = 'markdown' | 'image' | 'text' | 'other'

export interface RunFile {
  path: string // relative to the run's testing/<slug>/ folder
  size: number
  kind: RunFileKind
}

/** List every file in a run's output folder, for in-app preview. */
export function listRunFiles(id: string): Promise<{ slug: string | null; files: RunFile[] }> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}/files`)
}

/** Reveal a run's output folder in the OS file explorer. */
export function openRunFolder(id: string): Promise<{ ok: true; path: string }> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}/open`, { method: 'POST' })
}

/** Delete a finished run: its history record, event log, and on-disk output folder. */
export function deleteRun(id: string): Promise<{ ok: true }> {
  return request(`/api/qc/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- Version / updates ----

export interface UpdateCheck {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  behind: number
  checkedAt: string
  error: string | null
}

/** Live installed version, read from the install's package.json at request time. */
export function getVersion(): Promise<{ current: string | null }> {
  return request('/api/version')
}

/** Fetch latest upstream and report whether `qc-portal --update` would move HEAD forward. */
export function checkForUpdate(): Promise<UpdateCheck> {
  return request('/api/version/check', { method: 'POST' })
}

export interface UpdateTrigger {
  ok: boolean
  current: string | null
  error?: string
  alreadyRunning?: boolean
}

/**
 * Kick off a self-update (git pull + npm install + build + restart) in a detached
 * process on the server. Returns immediately; the server will go down and come
 * back up on its own — the caller should poll {@link getVersion} until it's back.
 */
export function triggerUpdate(): Promise<UpdateTrigger> {
  return request('/api/version/update', { method: 'POST' })
}

export interface RestartTrigger {
  ok: boolean
  error?: string
  alreadyRunning?: boolean
}

/**
 * Restart the portal server in place. Returns immediately; the server goes down
 * and comes back up on its own port — poll {@link pingHealth} until it's back,
 * then reload. Only effective when the portal was launched via `qc-portal`.
 */
export function triggerRestart(): Promise<RestartTrigger> {
  return request('/api/version/restart', { method: 'POST' })
}

/** One-shot health check — true when the server answers /api/health with 200. */
export async function pingHealth(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' })
    return res.ok
  } catch {
    return false
  }
}

/** The portal's own release notes (CHANGELOG.md) for the Release Notes page. */
export function getReleaseNotes(): Promise<{ current: string | null; markdown: string | null }> {
  return request('/api/version/changelog')
}

// ---- API Testing ----

export interface ApiKV {
  key: string
  value: string
  enabled: boolean
}

export type ApiAssertionType =
  | 'status-equals'
  | 'status-2xx'
  | 'body-contains'
  | 'body-matches'
  | 'json-equals'
  | 'json-exists'
  | 'header-equals'
  | 'header-exists'
  | 'time-below'

export interface ApiAssertion {
  id: string
  type: ApiAssertionType
  target: string
  expected: string
  enabled: boolean
}

export type ApiBodyMode = 'none' | 'json' | 'text'

/** A rule that pulls a JSON-path value out of a response into an environment variable. */
export interface ApiCapture {
  id: string
  jsonPath: string
  varName: string
  secret: boolean
}

export interface ApiRequestDef {
  name: string
  method: string
  url: string
  query: ApiKV[]
  headers: ApiKV[]
  bodyMode: ApiBodyMode
  body: string
  assertions: ApiAssertion[]
  aiExpect: string // plain-language expectation the AI check evaluates the response against
  captures: ApiCapture[]
  savedAt?: string
}

// ---- API environments (named {{variable}} sets, substituted server-side) ----

export interface ApiVariable {
  key: string
  value: string
  secret: boolean
  /** For a secret var: whether a value is stored (the value itself is masked to ''). */
  hasValue?: boolean
}
export interface ApiEnvironment {
  name: string
  variables: ApiVariable[]
}
export interface ApiEnvironments {
  active: string | null
  environments: ApiEnvironment[]
}

/** Get the project's environments (secret values arrive blanked, with hasValue). */
export function getApiEnvironments(projectId: string): Promise<ApiEnvironments> {
  return request(`/api/api-tests/environments?projectId=${encodeURIComponent(projectId)}`)
}

/** Replace the project's environments (empty secret values are preserved server-side). */
export function saveApiEnvironments(
  projectId: string,
  body: ApiEnvironments,
): Promise<ApiEnvironments> {
  return request(`/api/api-tests/environments?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** Upsert one variable (from a response capture) into an environment. */
export function captureApiVariable(
  projectId: string,
  body: { env?: string; key: string; value: string; secret: boolean },
): Promise<{ ok: true; env: string; key: string }> {
  return request('/api/api-tests/environments/capture', {
    method: 'POST',
    body: JSON.stringify({ projectId, ...body }),
  })
}

export interface AiCheckResult {
  ok: boolean
  verdict?: 'pass' | 'fail' | 'partial'
  summary?: string
  checks?: { expectation: string; pass: boolean; note: string }[]
  issues?: { severity: 'high' | 'warn' | 'info'; title: string; detail: string }[]
  error?: string
}

export interface ApiSendResult {
  ok: boolean // true when the server got any HTTP response (even a 4xx/5xx)
  status?: number
  statusText?: string
  headers?: Record<string, string>
  contentType?: string
  bodyText?: string
  sizeBytes?: number
  truncated?: boolean
  timeMs: number
  requestUrl: string
  method: string
  error?: string // network-level error when ok=false
}

/** Proxy an HTTP request through the server (avoids browser CORS) and return the response.
 *  `projectId` lets the server resolve the active environment's {{variables}}. */
export function sendApiRequest(body: {
  projectId: string
  method: string
  url: string
  query: ApiKV[]
  headers: ApiKV[]
  bodyMode: ApiBodyMode
  body: string
  timeoutMs?: number
}): Promise<ApiSendResult> {
  return request('/api/api-tests/send', { method: 'POST', body: JSON.stringify(body) })
}

/** List the project's saved API requests (testing/api-tests/*.json). */
export function listApiRequests(projectId: string): Promise<ApiRequestDef[]> {
  return request(`/api/api-tests?projectId=${encodeURIComponent(projectId)}`)
}

/** Create or overwrite a saved API request. */
export function saveApiRequest(
  projectId: string,
  name: string,
  def: Omit<ApiRequestDef, 'name' | 'savedAt'>,
): Promise<ApiRequestDef> {
  return request(`/api/api-tests/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify(def),
  })
}

/** Rename a saved API request (also moves its stored run history). */
export function renameApiRequest(
  projectId: string,
  name: string,
  newName: string,
): Promise<ApiRequestDef> {
  return request(`/api/api-tests/${encodeURIComponent(name)}/rename?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ newName }),
  })
}

/** Delete a saved API request. */
export function deleteApiRequest(projectId: string, name: string): Promise<{ ok: true }> {
  return request(
    `/api/api-tests/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's testing/api-tests folder in the OS file explorer. */
export function openApiTestsFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request('/api/api-tests/open', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

// ---- API result history ----

export interface ApiResultMeta {
  id: string
  at: string
  method: string
  url: string
  status: number
  ok: boolean
  timeMs: number
  sizeBytes: number
  error: string | null
  checks: { passed: number; total: number }
  scan: { high: number; warn: number; info: number }
}

export interface ApiResultRecord {
  id: string
  at: string
  name: string
  request: { method: string; url: string }
  result: ApiSendResult & { headers?: Record<string, string> }
  checks: { passed: number; total: number }
  scan: { high: number; warn: number; info: number }
}

/** Store one send's outcome under the request's history folder (evidence trail). */
export function saveApiResult(
  projectId: string,
  name: string,
  payload: {
    request: { method: string; url: string }
    result: ApiSendResult
    checks: { passed: number; total: number }
    scan: { high: number; warn: number; info: number }
  },
): Promise<{ id: string; at: string }> {
  return request('/api/api-tests/results', {
    method: 'POST',
    body: JSON.stringify({ projectId, name, ...payload }),
  })
}

/** Ask AI to judge a response against a plain-language expectation (best-effort). */
export function aiCheckApi(body: {
  projectId: string
  expect: string
  request: { method: string; url: string }
  result: {
    status?: number
    statusText?: string
    contentType?: string
    timeMs?: number
    headers?: Record<string, string>
    bodyText?: string
  }
  model?: string
}): Promise<AiCheckResult> {
  return request('/api/api-tests/ai-check', { method: 'POST', body: JSON.stringify(body) })
}

/** List a saved request's stored run history (newest first, metadata only). */
export function listApiResults(projectId: string, name: string): Promise<ApiResultMeta[]> {
  return request(
    `/api/api-tests/results?projectId=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`,
  )
}

/** Fetch one stored result in full (with response headers + body). */
export function getApiResult(
  projectId: string,
  name: string,
  id: string,
): Promise<ApiResultRecord> {
  return request(
    `/api/api-tests/results/${encodeURIComponent(name)}/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Clear a saved request's whole run history. */
export function clearApiResults(projectId: string, name: string): Promise<{ ok: true }> {
  return request(
    `/api/api-tests/results/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

// ---- Prototype builder (Claude-style chat → self-contained HTML prototype) ----

export interface PrototypeMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
}
export interface PrototypeMeta {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  messageCount: number
}
export interface Prototype {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  messages: PrototypeMessage[]
  html: string
  /** Short follow-up improvement ideas the model proposed for the latest version. */
  suggestions?: string[]
}

/** List the project's saved prototypes (metadata only, newest first). */
export function listPrototypes(projectId: string): Promise<PrototypeMeta[]> {
  return request(`/api/prototype?projectId=${encodeURIComponent(projectId)}`)
}

/** Fetch one prototype in full (conversation + current HTML). */
export function getPrototype(projectId: string, slug: string): Promise<Prototype> {
  return request(
    `/api/prototype/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Create a new prototype from the first prompt. Pass a signal to cancel the build. */
export function createPrototype(
  projectId: string,
  body: { prompt: string; model: string; name?: string },
  signal?: AbortSignal,
): Promise<Prototype> {
  return request('/api/prototype', {
    method: 'POST',
    body: JSON.stringify({ projectId, ...body }),
    signal,
  })
}

/** Send a follow-up prompt that refines an existing prototype. Pass a signal to cancel. */
export function sendPrototypeMessage(
  projectId: string,
  slug: string,
  body: { prompt: string; model: string },
  signal?: AbortSignal,
): Promise<Prototype> {
  return request(`/api/prototype/${encodeURIComponent(slug)}/message`, {
    method: 'POST',
    body: JSON.stringify({ projectId, ...body }),
    signal,
  })
}

/**
 * Build/refine a prototype and stream the HTML as it's written (Server-Sent Events).
 * `onDelta` fires with each incremental text chunk; `onDone` with the saved prototype;
 * `onError` with a message. Pass a signal to stop (also kills the server-side build).
 * Resolves when the stream ends; rejects (AbortError) if the caller aborts.
 */
export interface PrototypeImage {
  mediaType: string
  dataBase64: string
}

export interface PrototypeStyleSettings {
  style: string
  theme: 'light' | 'dark'
  accent: string
}

export async function streamPrototype(
  projectId: string,
  body: {
    slug?: string
    prompt: string
    model: string
    name?: string
    images?: PrototypeImage[]
    style?: PrototypeStyleSettings
  },
  handlers: {
    onDelta: (text: string) => void
    onDone: (p: Prototype) => void
    onError: (message: string) => void
    onLog?: (level: 'info' | 'success' | 'error', text: string) => void
  },
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/prototype/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...body }),
    signal,
  })
  if (!res.ok || !res.body) {
    handlers.onError((await res.text().catch(() => '')) || `${res.status} ${res.statusText}`)
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let settled = false // saw a terminal (done/error) frame
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue
      let msg: {
        type?: string
        text?: string
        level?: 'info' | 'success' | 'error'
        prototype?: Prototype
        error?: string
      }
      try {
        msg = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (msg.type === 'delta') handlers.onDelta(msg.text ?? '')
      else if (msg.type === 'log') handlers.onLog?.(msg.level ?? 'info', msg.text ?? '')
      else if (msg.type === 'done' && msg.prototype) {
        settled = true
        handlers.onDone(msg.prototype)
      } else if (msg.type === 'error') {
        settled = true
        handlers.onError(msg.error ?? 'Generation failed')
      }
    }
  }
  // The stream closed without a done/error frame (server ended early) — don't leave
  // the caller stuck in a loading state.
  if (!settled) handlers.onError('The build ended before finishing. Please try again.')
}

/** Duplicate a prototype into a new "(copy)" entry (same HTML + conversation). */
export function duplicatePrototype(projectId: string, slug: string): Promise<Prototype> {
  return request(
    `/api/prototype/${encodeURIComponent(slug)}/duplicate?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  )
}

/** Rename a prototype (display name only). */
export function renamePrototype(
  projectId: string,
  slug: string,
  newName: string,
): Promise<Prototype> {
  return request(`/api/prototype/${encodeURIComponent(slug)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ projectId, newName }),
  })
}

/** Delete a prototype. */
export function deletePrototype(projectId: string, slug: string): Promise<{ ok: true }> {
  return request(
    `/api/prototype/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Reveal the project's testing/prototypes folder in the OS file explorer. */
export function openPrototypesFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request('/api/prototype/open', {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

// ---- Terminal ----

/** Whether the device-terminal feature is usable (node-pty native binding loaded). */
export function terminalAvailable(): Promise<{ ok: boolean; error?: string }> {
  return request('/api/terminal/available')
}
