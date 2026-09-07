import type {
  ClaudeModelTestResult,
  ClaudeStatus,
  McpServer,
  Project,
  QcBrowserStatus,
  RunDetail,
  RunSummary,
  SkillFile,
  SkillSummary,
} from './types'
import type { SchemaTable } from './sql-complete'

export type { SchemaTable }

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // A remote session that expired mid-visit: every subsequent call would fail with
    // "Unlock required." and the page would fill with toasts instead of asking for the
    // password. Reloading hands the navigation to the server's gate, which answers with
    // the unlock screen. (Only ever sent to a request that came through the tunnel —
    // see server/src/remoteAccess.ts.)
    if (res.status === 401 && text.includes('needsUnlock')) {
      window.location.reload()
    }
    // Unwrap the `{ "error": "…" }` envelope every route answers a failure with.
    // Without this the raw JSON reaches the `toast.error` description at ~90 call
    // sites, so a message written FOR a QC engineer — "Unknown variable(s):
    // {{token}} — define them in…" — is read as `{"error":"Unknown variable(s)…"}`.
    // Anything that is not that envelope is passed through untouched.
    let message = text
    try {
      const parsed: unknown = JSON.parse(text)
      const inner = (parsed as { error?: unknown } | null)?.error
      if (parsed && typeof parsed === 'object' && typeof inner === 'string' && inner.trim()) {
        message = inner
      }
    } catch {
      /* not JSON — the body IS the message */
    }
    throw new Error(message || `${res.status} ${res.statusText}`)
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
    /**
     * Drive the portal-owned QC browser over CDP instead of letting Playwright MCP
     * launch (and, on Stop, close) its own. Rewrites the project's .mcp.json.
     */
    persistentBrowser?: boolean
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
  /** Mobile targets: the Maestro device_id to drive; omitted = let the run pick. */
  deviceId?: string
  /** 'flow' = an E2E flow, which has no ticket — `ticketId` is only the report slug. */
  kind?: 'ticket' | 'flow'
  /**
   * Web target only: drive the browser with NO visible window for THIS run. Omitted =
   * whatever the project's Playwright MCP entry says (the MCP page's own checkbox).
   */
  headless?: boolean
  /**
   * What the run may do to the environment's data. 'readonly' (the default) never
   * commits a mutating action, which means every "do X, then check the result" case
   * comes back Blocked; 'seed' authorizes the run to create the data its cases need.
   */
  dataPolicy?: 'readonly' | 'seed'
}): Promise<{ runId: string } & RunSummary> {
  return request('/api/qc/run', { method: 'POST', body: JSON.stringify(body) })
}

/**
 * A test-case document uploaded on the Run form and stored in the project, so the
 * run can execute it. Converted to Markdown in the browser (lib/docConvert.ts)
 * before it is sent — the server only ever receives text.
 */
export interface RunTestcaseDoc {
  /** File name under testing/test-cases/. */
  file: string
  /** Project-relative path — what the run prompt tells Claude to read. */
  relPath: string
  bytes: number
}

export function uploadRunTestcaseDoc(body: {
  projectId: string
  name: string
  markdown: string
}): Promise<RunTestcaseDoc> {
  return request('/api/qc/testcase-doc', { method: 'POST', body: JSON.stringify(body) })
}

/** One AI-drafted step of an E2E flow read out of an uploaded test-case document. */
export interface FlowStepDraft {
  step: string
  title: string
  url?: string
  expected?: string
}

export interface FlowDraft {
  flowName: string
  steps: FlowStepDraft[]
  summary: string
  caseCount: number
}

/**
 * Read an uploaded test-case document and draft the E2E flow that executes it.
 * Costs a real Claude call (~20-60s), so it is only ever run on an explicit click.
 */
export function flowFromTestcases(body: {
  projectId: string
  fileName: string
  markdown: string
  appUrl?: string
  testTarget?: 'web' | 'web-mobile' | 'app-mobile'
  projectName?: string
}): Promise<FlowDraft> {
  return request('/api/ai/flow-from-testcases', { method: 'POST', body: JSON.stringify(body) })
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

/**
 * Replace this project's copy of a portal-bundled skill with the portal's current
 * version. Only needed for a copy the portal won't refresh on its own (hand-edited,
 * or installed before fingerprinting existed) — untouched copies are updated
 * automatically when the server starts.
 */
export function syncSkillFromPortal(
  name: string,
  projectId: string,
): Promise<{ ok: true; files: number }> {
  return request(
    `/api/skills/${encodeURIComponent(name)}/sync?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
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

// ---- QC browser (the portal-owned window Playwright MCP attaches to) ----

export function qcBrowserStatus(): Promise<QcBrowserStatus> {
  return request('/api/browser/status')
}

export function startQcBrowser(channel?: 'msedge' | 'chrome'): Promise<QcBrowserStatus> {
  return request('/api/browser/start', {
    method: 'POST',
    body: JSON.stringify({ channel }),
  })
}

/** Make the QC browser window full screen (CDP — `--start-maximized` is a no-op on macOS). */
export function maximizeQcBrowser(): Promise<QcBrowserStatus> {
  return request('/api/browser/maximize', { method: 'POST' })
}

export function stopQcBrowser(): Promise<QcBrowserStatus> {
  return request('/api/browser/stop', { method: 'POST' })
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

// ——— Overview documents (one file per uploaded document, testing/overview/) ———

export interface OverviewDoc {
  name: string
  size: number
  savedAt: string
}

export function listOverviewDocs(projectId: string): Promise<OverviewDoc[]> {
  return request(`/api/overview-docs?projectId=${encodeURIComponent(projectId)}`)
}

export function getOverviewDoc(
  projectId: string,
  name: string,
): Promise<OverviewDoc & { content: string }> {
  return request(
    `/api/overview-docs/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

export function saveOverviewDoc(
  projectId: string,
  name: string,
  content: string,
): Promise<OverviewDoc> {
  return request(
    `/api/overview-docs/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify({ content }) },
  )
}

/**
 * AI review & format ONE overview document, in place. `before` is the pre-review
 * Markdown so the caller can offer an undo (the file has already been overwritten).
 */
export function reviewOverviewDoc(
  projectId: string,
  name: string,
): Promise<{ name: string; changed: boolean; before: string; content: string }> {
  return request(
    `/api/overview-docs/${encodeURIComponent(name)}/review?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
  )
}

export function deleteOverviewDoc(projectId: string, name: string): Promise<{ ok: true }> {
  return request(
    `/api/overview-docs/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

export function openOverviewDocsFolder(projectId: string): Promise<{ ok: true; path: string }> {
  return request(`/api/overview-docs/open?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
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

/** What filing a bug under a parent ticket inherits from it (assignees, tags, priority). */
export interface ClickupFilingContext {
  id: string
  displayId: string
  name: string
  url: string
  listId: string
  listName: string
  assignees: { id: number; username: string }[]
  tags: string[]
  priority: { id: number; label: string } | null
}

/** What was actually applied to a filed bug — reported back so the panel can say so. */
export interface AppliedIssueFields {
  assignees: string[]
  priority: string | null
  prioritySource: 'severity' | 'parent' | null
  screenshots: number
  screenshotsFailed: number
  /** First reason a screenshot upload failed (e.g. ClickUp storage full). */
  screenshotsError: string | null
  commented: boolean
}

export function clickupIssueFilingContext(
  parent: string,
  projectId?: string,
): Promise<ClickupFilingContext> {
  return request(
    `/api/clickup/issues/filing-context?parent=${encodeURIComponent(parent)}${pid(projectId)}`,
  )
}

export function createClickupIssueSubtasks(body: {
  parentTask: string
  issues: {
    title: string
    description: string
    /** Sets the bug's ClickUp priority; falls back to the parent's when absent. */
    severity?: string | null
    screenshots?: string[]
  }[]
  projectId?: string
  slug?: string | null
}): Promise<{ created: (ClickupTask & { applied?: AppliedIssueFields })[] }> {
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

// ---- Azure DevOps (same shapes as ClickUp — the ticket UI is source-agnostic) ----
// The picker + crawler treat Azure exactly like ClickUp/Jira: a "workspace" is an
// Azure DevOps project (id = project name), a "task" is a work item, and crawl jobs
// share the same registry (so getCrawlJob/listCrawlJobs above resolve Azure jobs too).

export function azureStatus(projectId?: string): Promise<{ configured: boolean }> {
  return request(`/api/azure/status${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`)
}

export function azureWorkspaces(projectId?: string): Promise<ClickupWorkspace[]> {
  const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
  return request(`/api/azure/workspaces${qs}`)
}

/** Search work items within an Azure DevOps project (`team` is the project name). */
export function azureTasks(team: string, q: string, projectId?: string): Promise<ClickupTask[]> {
  return request(
    `/api/azure/tasks?team=${encodeURIComponent(team)}&q=${encodeURIComponent(q)}${pid(projectId)}`,
  )
}

/** Child work items of one Azure work item, loaded on demand. */
export function azureSubtasks(parent: string, projectId?: string): Promise<ClickupTask[]> {
  return request(`/api/azure/subtasks?parent=${encodeURIComponent(parent)}${pid(projectId)}`)
}

/** Start a background job that crawls one or more Azure work items to disk. */
export function startAzureCrawlJob(body: {
  projectId: string
  tickets: { id: string; displayId: string; name: string; relDir?: string }[]
  model?: string
  ticketKind?: 'feature' | 'bug' | null
}): Promise<{ jobId: string; job: CrawlJob }> {
  return request('/api/azure/crawl/jobs', {
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

// ---- Databases (connect one or more MySQL/Postgres/SQL Server/SQLite databases, each with a tag) ----

export type DbKind = 'mysql' | 'postgres' | 'sqlserver'

export interface DbKindInfo {
  value: DbKind
  label: string
  defaultPort: number
}

export interface DatabaseConn {
  id: string
  tag: string // "Backend DB", "Analytics DB", …
  kind: DbKind
  host: string
  port: number
  database: string // db name
  username: string
  ssl: boolean
  lastSync: string // ISO
  serverVersion: string
  tableCount: number
  hasPassword: boolean // a password is stored (never returned raw)
  credential: { label: string; passwordPreview: string } | null
}

export interface DatabaseInfo {
  connected: boolean
  rootPath: string
  kinds: DbKindInfo[]
  databases: DatabaseConn[]
}

export type DbJobKind = 'connect' | 'sync'

export interface DbLogLine {
  time: string
  level: 'info' | 'success' | 'error'
  text: string
}

export interface DbJob {
  id: string
  kind: DbJobKind
  projectId: string
  databaseId: string
  tag: string
  status: 'running' | 'done' | 'error'
  error?: string
  logs: DbLogLine[]
  result?: { serverVersion: string; tableCount: number; mapDoc: string | null }
  createdAt: string
  updatedAt: string
}

/** Read all of the project's connected databases + the supported database kinds. */
export function getDatabases(projectId: string): Promise<DatabaseInfo> {
  return request(`/api/database?projectId=${encodeURIComponent(projectId)}`)
}

/** Read one database's stored password (for the edit-&-reconnect prefill). */
export function getDatabaseCredential(
  projectId: string,
  databaseId: string,
): Promise<{ password: string }> {
  return request(
    `/api/database/credential?projectId=${encodeURIComponent(projectId)}&databaseId=${encodeURIComponent(databaseId)}`,
  )
}

/**
 * Connect + introspect a database under a tag. Runs as a background job — poll
 * getDatabaseJob. Pass databaseId to re-point an existing one ("Edit & reconnect").
 */
export function connectDatabase(body: {
  projectId: string
  kind: DbKind
  host?: string
  port?: number
  database: string
  username?: string
  password?: string
  ssl?: boolean
  tag?: string
  databaseId?: string
}): Promise<{ jobId: string; job: DbJob }> {
  return request(`/api/database/connect?projectId=${encodeURIComponent(body.projectId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Quick connection check — connects & reads the schema but persists nothing.
 * Resolves with { ok, ... } even on failure (never throws for a bad connection).
 */
export function testDatabaseConnection(body: {
  projectId: string
  kind: DbKind
  host?: string
  port?: number
  database: string
  username?: string
  password?: string
  ssl?: boolean
  databaseId?: string
}): Promise<{ ok: boolean; serverVersion?: string; tableCount?: number; error?: string }> {
  return request(`/api/database/test?projectId=${encodeURIComponent(body.projectId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Refresh one connected database (re-introspect the schema). Runs as a background job. */
export function syncDatabase(
  projectId: string,
  databaseId: string,
): Promise<{ jobId: string; job: DbJob }> {
  return request(`/api/database/sync?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ databaseId }),
  })
}

/** Forget one connected database (the database server itself is untouched). */
export function disconnectDatabase(projectId: string, databaseId: string): Promise<{ ok: true }> {
  return request(`/api/database/disconnect?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ databaseId }),
  })
}

export function getDatabaseJob(jobId: string, projectId: string): Promise<{ job: DbJob }> {
  return request(
    `/api/database/jobs/${encodeURIComponent(jobId)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

export function listDatabaseJobs(projectId: string): Promise<{ jobs: DbJob[] }> {
  return request(`/api/database/jobs?projectId=${encodeURIComponent(projectId)}`)
}

export interface DbQueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

/**
 * Is a registered database reachable right now? Drives the card's status badge, which
 * would otherwise say "connected" for a server that is switched off.
 */
export function getDatabaseHealth(
  projectId: string,
  databaseId: string,
): Promise<{ ok: boolean; error?: string; ms: number }> {
  return request(
    `/api/database/health?projectId=${encodeURIComponent(projectId)}&databaseId=${encodeURIComponent(databaseId)}`,
  )
}

/**
 * Tables + columns of a connected database — powers the SQL editor's completion and
 * schema browser. Read live, so it reflects the database rather than the last sync.
 */
export function getDatabaseSchema(
  projectId: string,
  databaseId: string,
): Promise<{ tables: SchemaTable[] }> {
  return request(
    `/api/database/schema?projectId=${encodeURIComponent(projectId)}&databaseId=${encodeURIComponent(databaseId)}`,
  )
}

/**
 * Why the read-only guard refused a statement. Present INSTEAD of a plain error when
 * the page must say "this would modify data" rather than "the query failed" — the two
 * need different words and a different fix, so they must stay distinguishable here.
 */
export interface DbBlocked {
  kind: 'empty' | 'multi-statement' | 'not-select' | 'write-keyword' | 'lock' | 'write-intent'
  /** The offending keyword when one was matched, e.g. `DELETE`. */
  keyword?: string
  /** A read-only SELECT showing the rows the refused change would have hit (Ask AI). */
  preview?: string
}

/** Run a READ-ONLY SQL query against a connected database. Resolves even on failure. */
export function runDatabaseQuery(
  projectId: string,
  databaseId: string,
  sql: string,
): Promise<{ ok: boolean; result?: DbQueryResult; error?: string; blocked?: DbBlocked }> {
  return request(`/api/database/query?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ databaseId, sql }),
  })
}

/**
 * Ask a natural-language question — AI writes a read-only SELECT, runs it, and
 * returns the SQL + results. Resolves even on failure (sql echoed when possible).
 */
export function askDatabase(
  projectId: string,
  databaseId: string,
  question: string,
  model?: string,
): Promise<{
  ok: boolean
  sql?: string
  result?: DbQueryResult
  error?: string
  blocked?: DbBlocked
}> {
  return request(`/api/database/ask?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ databaseId, question, model }),
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

/** Template kinds the portal ships a default for (so "Reset to default" can be offered). */
export function listTemplateDefaults(): Promise<{ keys: string[] }> {
  return request('/api/templates/defaults')
}

/** Overwrite a template with the default bundled with the portal. */
export function resetTemplateToDefault(
  key: string,
  projectId: string,
): Promise<ProjectTemplate> {
  return request(
    `/api/templates/${encodeURIComponent(key)}/reset?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
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

/**
 * Upload an IMAGE (diagram, ERD, annotated screenshot) as knowledge: the server stores
 * the picture under testing/knowledge/assets/ and a vision pass writes the Markdown doc
 * describing it. The one upload the browser can't convert itself — an image has no text
 * to extract — so this costs a real Claude call (~20-60s).
 */
export function knowledgeDocFromImage(body: {
  projectId: string
  /** Doc name to write (defaults to the file name server-side). */
  name: string
  fileName: string
  /** image/png | image/jpeg | image/webp | image/gif */
  mime: string
  /** base64, no data: prefix. */
  data: string
  instructions?: string
  projectName?: string
}): Promise<KnowledgeDoc & { asset: string }> {
  return request('/api/knowledge/from-image', { method: 'POST', body: JSON.stringify(body) })
}

/** URL of an image stored beside the knowledge docs (what `assets/…` in a doc resolves to). */
export function knowledgeAssetUrl(projectId: string, file: string): string {
  return `/api/knowledge/assets/${encodeURIComponent(file)}?projectId=${encodeURIComponent(projectId)}`
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

// ---- Authenticator (TOTP) codes for test accounts with real 2FA ----
// The enrollment secret stays on the server; only 6-digit codes come back.

export interface TotpEntry {
  label: string // slug key — what a run references to fetch a code
  issuer: string // display only, e.g. "Acme Production"
  username: string // which account this authenticator belongs to
  digits: number
  period: number // seconds per code
  algorithm: 'SHA1' | 'SHA256' | 'SHA512'
  note: string
  createdAt: string
}

export interface TotpCode {
  label: string
  code: string
  expiresIn: number // seconds until it rolls over
  period: number
}

export interface TotpInput {
  label?: string
  issuer?: string
  username?: string
  secret: string // base32 setup key OR a whole otpauth://totp/… link
  note?: string
}

/** Registered authenticators for the project (never includes secrets). */
export function listTotp(projectId: string): Promise<{ entries: TotpEntry[] }> {
  return request(`/api/accounts/totp?projectId=${encodeURIComponent(projectId)}`)
}

/** Current code for every authenticator — polled to mirror what the phone shows. */
export function getTotpCodes(projectId: string): Promise<{ codes: TotpCode[] }> {
  return request(`/api/accounts/totp/codes?projectId=${encodeURIComponent(projectId)}`)
}

/** Register or replace one authenticator (same label = replace). */
export function saveTotp(input: TotpInput, projectId: string): Promise<{ entry: TotpEntry }> {
  return request(`/api/accounts/totp?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

/** Forget one authenticator, deleting its stored secret. */
export function deleteTotp(label: string, projectId: string): Promise<{ ok: true }> {
  return request(
    `/api/accounts/totp/${encodeURIComponent(label)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
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

// ---- Workspace notes (testing/notes/notes.json) ----

export interface WorkspaceNote {
  id: string
  title: string
  body: string
  labels: string[]
  archived: boolean
  trashed: boolean
  createdAt: string
  updatedAt: string
}

export function listWorkspaceNotes(projectId: string): Promise<{ labels: string[]; notes: WorkspaceNote[] }> {
  return request(`/api/notes?projectId=${encodeURIComponent(projectId)}`)
}

export function createWorkspaceNote(input: { title: string; body: string; label?: string }, projectId: string): Promise<{ note: WorkspaceNote }> {
  return request(`/api/notes?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: JSON.stringify(input) })
}

export function updateWorkspaceNote(id: string, patch: Partial<Pick<WorkspaceNote, 'title' | 'body' | 'labels' | 'archived' | 'trashed'>>, projectId: string): Promise<{ note: WorkspaceNote }> {
  return request(`/api/notes/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

export function deleteWorkspaceNote(id: string, projectId: string): Promise<{ ok: true }> {
  return request(`/api/notes/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

export function emptyWorkspaceTrash(projectId: string): Promise<{ ok: true; removed: number }> {
  return request(`/api/notes/trash?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

export function addWorkspaceLabel(name: string, projectId: string): Promise<{ label: string }> {
  return request(`/api/notes/labels?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', body: JSON.stringify({ name }) })
}

export function deleteWorkspaceLabel(name: string, projectId: string): Promise<{ ok: true }> {
  return request(`/api/notes/labels/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`, { method: 'DELETE' })
}

export function renameWorkspaceLabel(oldName: string, newName: string, projectId: string): Promise<{ ok: true }> {
  return request(`/api/notes/labels/${encodeURIComponent(oldName)}?projectId=${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) })
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
  /**
   * A specification document attached by the QC engineer, already converted to Markdown
   * in the browser (docx/pdf/xlsx/csv via lib/docConvert). For tickets that only LINK to
   * their spec: it becomes a requirement source on par with the ticket.
   */
  spec?: { name: string; content: string } | null
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
  /**
   * A specification document attached by the QC engineer, already converted to Markdown
   * in the browser (docx/pdf/xlsx/csv via lib/docConvert). For tickets that only LINK to
   * their spec: it becomes a requirement source on par with the ticket.
   */
  spec?: { name: string; content: string } | null
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

/**
 * The configured MCP servers. Pass `{ health: false }` for an instant response
 * that skips the slow live probe (statuses come back "unknown"); fetch live
 * health separately with `mcpHealth`.
 */
export function listMcp(
  projectId: string,
  opts?: { health?: boolean },
): Promise<McpServer[]> {
  const health = opts?.health === false ? '&health=false' : ''
  return request(`/api/mcp?projectId=${encodeURIComponent(projectId)}${health}`)
}

/** Live health only — a `{ name: status }` map. The slow probe, split out so the
 *  page renders cards instantly and fills in statuses when this resolves. */
export function mcpHealth(projectId: string): Promise<Record<string, McpServer['status']>> {
  return request(`/api/mcp/health?projectId=${encodeURIComponent(projectId)}`)
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

/** Maestro CLI + JDK preflight. See `server/src/maestro.ts` for why both matter. */
export interface MaestroPreflight {
  available: boolean
  version: string | null
  javaHome: string | null
  javaMajor: number | null
  defaultJavaOk: boolean
  platform: string
}

export function mcpMaestroStatus(): Promise<MaestroPreflight> {
  return request('/api/mcp/maestro')
}

/**
 * Connect Maestro. Unlike the other one-click cards this does NOT go through
 * `addMcp` — the entry's JAVA_HOME/PATH env is resolved server-side, since the
 * browser can't see the machine's PATH or its installed JDKs.
 */
export function connectMaestro(projectId: string): Promise<{ ok: boolean }> {
  return request(`/api/mcp/maestro/connect?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
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

/** Reveal the full (unmasked) env map for a server, for the "View details" dialog. Localhost-only. */
export function revealMcpEnv(
  name: string,
  projectId: string,
): Promise<{ env: Record<string, string> }> {
  return request(
    `/api/mcp/${encodeURIComponent(name)}/env?projectId=${encodeURIComponent(projectId)}`,
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

export type McpOauthProvider = 'clickup' | 'figma' | 'jira' | 'azure'

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
 * Jira additionally needs a site URL + account email; Azure DevOps needs an
 * organization URL (+ optional default project). Passed via `extra`.
 */
export function saveMcpToken(
  provider: McpOauthProvider,
  token: string,
  projectId: string,
  extra?: { url?: string; email?: string; orgUrl?: string; project?: string },
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

/**
 * URL that serves any image file under the project root, named by a project-relative path.
 * Used by Chat: an answer that cites `testing/test-result/<run>/screenshots/ac1.png` gets a
 * clickable chip, and the dialog behind it loads the picture from here.
 */
export function projectImageUrl(projectId: string, relPath: string): string {
  return `/api/files/project-image?projectId=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relPath)}`
}

/**
 * Which of these cited image paths are real files. Returns cited path → project-relative
 * path; a path that resolves to nothing is simply absent, so the caller can leave it as
 * plain text instead of drawing a chip that 404s. Pure `stat` work server-side.
 */
export async function resolveProjectImages(
  projectId: string,
  paths: string[],
): Promise<Record<string, string>> {
  const res = await request<{ resolved: Record<string, string> }>('/api/files/resolve-images', {
    method: 'POST',
    body: JSON.stringify({ projectId, paths }),
  })
  return res.resolved ?? {}
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

export interface UpdateLog {
  lines: string[]
  /** How the launcher says the last run ENDED — null when no update has run here. */
  status: { ok: boolean | null; error?: string; version?: string; at?: string } | null
  path: string
}

/**
 * The tail of the updater's log, plus how it ended.
 *
 * This is what lets the UI say "npm install failed" instead of "check
 * data/update.log in the install folder" — a file on the machine of someone who
 * is looking at a browser.
 */
export function getUpdateLog(): Promise<UpdateLog> {
  return request('/api/version/update-log')
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
  /** Module this request is filed under in the saved list (Swagger-style); '' = ungrouped. */
  group: string
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
  /**
   * The identity this send runs as (a flow's picked account / authenticator, by
   * label). Resolves `{{auth.username}}` / `{{auth.password}}` / `{{auth.otp}}` on the
   * server, so one login request can run as any account without being edited.
   */
  auth?: { account?: string; totp?: string }
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
  def: Omit<ApiRequestDef, 'name' | 'savedAt' | 'group'> & { group?: string },
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

/** Move a saved API request into a module ('' = ungrouped). */
export function setApiRequestGroup(
  projectId: string,
  name: string,
  group: string,
): Promise<ApiRequestDef> {
  return request(`/api/api-tests/${encodeURIComponent(name)}/group?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ group }),
  })
}

/** Rename a module across every request filed under it (empty `to` = ungroup them). */
export function renameApiGroup(
  projectId: string,
  from: string,
  to: string,
): Promise<{ ok: true; moved: number }> {
  return request(`/api/api-tests/groups/rename?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ from, to }),
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

// ---- API test accounts (login credentials for a flow's first step) ----

/**
 * A test account a flow logs in as. The password is **never** returned — it lives in
 * the portal's own data dir (not the project repo) and only the server substitutes it
 * into `{{account.<label>.password}}` when it sends the request.
 */
export interface ApiAccount {
  label: string
  username: string
  note: string
  savedAt: string
  hasPassword: boolean
}

export function listApiAccounts(projectId: string): Promise<{ accounts: ApiAccount[] }> {
  return request(`/api/api-tests/accounts?projectId=${encodeURIComponent(projectId)}`)
}

/** Create/replace an account. An empty `password` keeps the stored one. */
export function saveApiAccount(
  projectId: string,
  body: { label: string; username: string; password?: string; note?: string },
): Promise<{ account: ApiAccount }> {
  return request(`/api/api-tests/accounts?projectId=${encodeURIComponent(projectId)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

/** A login found in testing/environments.md (Instructions → Accounts), ready to import. */
export interface ApiAccountCandidate {
  label: string
  username: string
  role: string
  environment: string
  note: string
  hasPassword: boolean
}

/** Rows of the project's environments.md sheet that aren't in the store yet. */
export function listApiAccountCandidates(
  projectId: string,
): Promise<{ candidates: ApiAccountCandidate[] }> {
  return request(`/api/api-tests/accounts/candidates?projectId=${encodeURIComponent(projectId)}`)
}

/** Copy sheet rows into the secure store. The password is read server-side. */
export function importApiAccounts(
  projectId: string,
  usernames: string[],
): Promise<{ imported: string[] }> {
  return request(`/api/api-tests/accounts/import?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ usernames }),
  })
}

export function deleteApiAccount(projectId: string, label: string): Promise<{ ok: true }> {
  return request(
    `/api/api-tests/accounts/${encodeURIComponent(label)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

// ---- API flows (run a collection of saved requests as one scenario) ----

/**
 * A pre-request / post-request hook: another saved request run around a step, or around
 * the whole flow. Same shape as a step and referenced by name for the same reason — the
 * setup call is a request the collection already holds.
 */
/**
 * What one step (or hook) of ONE flow sends and expects, instead of what its saved
 * request says — so the same `POST /auth/login` can be the happy path in one flow and
 * the 401 in another without being duplicated in the collection.
 *
 * `bodyMode: ''` = keep the request's body (`'none'` = send no body, which is a
 * different thing). Headers/query are merged over the request's by key. `assertionMode`
 * decides what grades the step: the request's checks, only these, or both.
 */
export interface ApiFlowOverride {
  bodyMode: '' | ApiBodyMode
  body: string
  headers: ApiKV[]
  query: ApiKV[]
  assertionMode: 'inherit' | 'replace' | 'append'
  assertions: ApiAssertion[]
}

export interface ApiFlowHook {
  id: string
  requestName: string
  enabled: boolean
  /** Keep going when the hook fails instead of leaving its step untested. */
  continueOnFail: boolean
  /** This flow's own data / checks for this call. `null` (or absent) = the request as saved. */
  override?: ApiFlowOverride | null
}

export interface ApiFlowStep {
  id: string
  /** The saved request this step runs — flows reference requests, never copy them. */
  requestName: string
  enabled: boolean
  continueOnFail: boolean
  /** Requests run right before this step — the data it needs. */
  before: ApiFlowHook[]
  /** Requests run right after it, whether it passed, failed, or was never sent. */
  after: ApiFlowHook[]
  /** This flow's own data / checks for this step. `null` (or absent) = the request as saved. */
  override?: ApiFlowOverride | null
}

export interface ApiFlow {
  name: string
  description: string
  stopOnFail: boolean
  /** Which account / authenticator the flow runs as — LABELS only, never credentials. */
  auth: { accountLabel: string; totpLabel: string }
  /** Once before the first step. */
  setup: ApiFlowHook[]
  steps: ApiFlowStep[]
  /** Once after the last step — always, even when the run stopped early. */
  teardown: ApiFlowHook[]
  savedAt?: string
}

export function listApiFlows(projectId: string): Promise<{ flows: ApiFlow[] }> {
  return request(`/api/api-tests/flows?projectId=${encodeURIComponent(projectId)}`)
}

export function saveApiFlow(
  projectId: string,
  name: string,
  body: {
    description: string
    stopOnFail: boolean
    auth: { accountLabel: string; totpLabel: string }
    setup: ApiFlowHook[]
    steps: ApiFlowStep[]
    teardown: ApiFlowHook[]
  },
): Promise<{ flow: ApiFlow }> {
  return request(
    `/api/api-tests/flows/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'PUT', body: JSON.stringify(body) },
  )
}

export function renameApiFlow(
  projectId: string,
  name: string,
  to: string,
): Promise<{ flow: ApiFlow }> {
  return request(
    `/api/api-tests/flows/${encodeURIComponent(name)}/rename?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify({ to }) },
  )
}

export function deleteApiFlow(projectId: string, name: string): Promise<{ ok: true }> {
  return request(
    `/api/api-tests/flows/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** One row's verdict in a saved flow report — verdicts only, never response bodies. */
export interface ApiFlowRunStep {
  /**
   * Where this row sat in the run. The array is the flat EXECUTION ORDER (flow setup,
   * each step wrapped in its before/after hooks, teardown) — "the cleanup ran even
   * though step 3 failed" is only readable when the cleanup is in the list. Reports
   * written before hooks existed carry no phase and read as 'step'.
   */
  phase?: 'setup' | 'before' | 'step' | 'after' | 'teardown'
  /** For a before/after row: the request name of the step it belongs to. */
  parent?: string
  requestName: string
  method: string
  url: string
  status: number | null
  timeMs: number
  outcome: 'pass' | 'fail' | 'skipped' | 'error'
  checks: { passed: number; total: number }
  detail: string
  captured: string[]
  /** This row ran with the flow's own body/checks, not the saved request's as-is. */
  overridden?: boolean
}

export interface ApiFlowRun {
  id: string
  at: string
  flow: string
  env: string | null
  account: string | null
  totalMs: number
  summary: { passed: number; failed: number; skipped: number; total: number }
  steps: ApiFlowRunStep[]
}

export function saveApiFlowRun(
  projectId: string,
  name: string,
  body: {
    env: string | null
    account: string | null
    totalMs: number
    steps: ApiFlowRunStep[]
  },
): Promise<{ run: ApiFlowRun }> {
  return request(
    `/api/api-tests/flows/${encodeURIComponent(name)}/runs?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify(body) },
  )
}

export function listApiFlowRuns(
  projectId: string,
  name: string,
): Promise<{ runs: ApiFlowRun[] }> {
  return request(
    `/api/api-tests/flows/${encodeURIComponent(name)}/runs?projectId=${encodeURIComponent(projectId)}`,
  )
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

/**
 * One reviewable change the API-testing assistant proposes. It is a PROPOSAL, not an
 * edit: the server never writes anything for the assistant, and each kind is applied by
 * the page through the same route a human click would have used, so the existing
 * validation (and secret merging) still runs. See routes/apiTests.ts `/assistant`.
 */
export type ApiAssistProposal =
  | {
      kind: 'set-variables'
      env: string
      note: string
      vars: { key: string; value: string; secret: boolean }[]
    }
  | {
      kind: 'update-request'
      name: string
      note: string
      /** Only the fields the assistant wants changed are present. */
      url?: string
      headers?: ApiKV[]
      bodyMode?: ApiBodyMode
      body?: string
    }
  | {
      kind: 'add-captures'
      name: string
      note: string
      captures: { jsonPath: string; varName: string; secret: boolean }[]
    }
  | {
      kind: 'create-flow'
      name: string
      note: string
      description: string
      steps: string[]
      setup: string[]
      teardown: string[]
    }

export interface ApiAssistResult {
  ok: boolean
  reply?: string
  proposals?: ApiAssistProposal[]
  error?: string
}

/**
 * Ask the API-testing assistant. Stateless like `aiCheckApi`: the page holds the
 * transcript and replays it, and the server reads the collection/environments/flows off
 * disk itself, so the question can be as short as "wire these up".
 *
 * `images` are base64 bytes (a pasted screenshot), `docs` are already-converted markdown
 * (the same `convertFileToMarkdown` pipeline Knowledge and Chat use).
 */
export function askApiAssistant(
  body: {
    projectId: string
    messages: { role: 'user' | 'assistant'; text: string }[]
    model?: string
    docs?: { name: string; markdown: string }[]
    images?: { mime: string; data: string }[]
  },
  /**
   * Lets the caller give up. A turn is one `claude -p` the server waits on for up to
   * 240 s, and `fetch` on its own waits forever — so without a signal the panel's only
   * honest options were "keep spinning" and "reload the page".
   */
  signal?: AbortSignal,
): Promise<ApiAssistResult> {
  return request('/api/api-tests/assistant', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  })
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

// ---- Page scan: detect a page's APIs by watching a real browser ----

/** One API request observed while a page ran in the scan browser. */
export interface ScanRequest {
  id: string
  method: string
  url: string
  resourceType: string
  status?: number
  contentType?: string
  requestContentType?: string
  hasBody: boolean
  bodyPreview?: string
  count: number
  at: string
}

export interface ScanJob {
  id: string
  projectId: string
  url: string
  headless: boolean
  status: 'running' | 'done' | 'error'
  error?: string
  requests: ScanRequest[]
  logs: { time: string; level: 'info' | 'success' | 'error'; text: string }[]
  createdAt: string
  updatedAt: string
}

/** Is page scanning usable on this machine (playwright-core + Chrome present)? */
export function getScanAvailable(): Promise<{ ok: boolean; error?: string }> {
  return request('/api/api-tests/scan/available')
}

/** Open Chrome (headless by default) at `url` and record the APIs the page calls. */
export function startApiScan(projectId: string, url: string, headless = true): Promise<ScanJob> {
  return request(`/api/api-tests/scan/jobs?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify({ url, headless }),
  })
}

/** Poll a scan job's detected requests + logs. */
export function getApiScan(projectId: string, id: string): Promise<ScanJob> {
  return request(
    `/api/api-tests/scan/jobs/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Stop capture, close the scan browser, and finalize the job. */
export function stopApiScan(projectId: string, id: string): Promise<ScanJob> {
  return request(
    `/api/api-tests/scan/jobs/${encodeURIComponent(id)}/stop?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST' },
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
  /** Display id of the crawled ticket this prototype realizes, when linked. */
  ticketId?: string | null
  ticketFolder?: string | null
  /** How many revisions are stored (see PrototypeVersionMeta). */
  versionCount?: number
}

/**
 * One stored revision of a prototype, WITHOUT its HTML — a refine appends a revision
 * rather than overwriting, so earlier documents can be previewed, compared and restored.
 * Fetch a revision's HTML on demand with getPrototypeVersion.
 */
export interface PrototypeVersionMeta {
  n: number
  /** The request that produced this revision ('' for a pre-versioning document). */
  prompt: string
  summary: string
  at: string
  model: string
  bytes: number
}

export interface Prototype {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  messages: PrototypeMessage[]
  /** The CURRENT document (always the newest or most recently restored revision). */
  html: string
  /** Short follow-up improvement ideas the model proposed for the latest version. */
  suggestions?: string[]
  /** Revision history, oldest first. */
  versions?: PrototypeVersionMeta[]
  /** Crawled-ticket folder this prototype realizes (test cases save under it). */
  ticketFolder?: string | null
  ticketId?: string | null
  ticketTitle?: string | null
  /** Whether builds are allowed to read the project's real source to match the app. */
  matchApp?: boolean
  /** Requirement ambiguities the latest build had to guess about — for the BA to settle. */
  questions?: string[]
  /** Ambiguities the BA has answered. Each answer grounds every later build. */
  decisions?: PrototypeDecision[]
}

/** One answered requirement ambiguity (see Prototype.questions / decisions). */
export interface PrototypeDecision {
  q: string
  a: string
  at: string
}

/** The project's extracted design system — the real app's visual language, as text. */
export interface DesignSystemInfo {
  exists: boolean
  /** Provenance ('' once the engineer has edited it by hand — then it's theirs). */
  source: string
  size: number
  savedAt: string | null
  content: string
  /** False when no repo is connected, so there's nothing to extract from. */
  hasSource?: boolean
}

/** Read the project's design system (stored as the `design-system` knowledge doc). */
export function getDesignSystem(projectId: string): Promise<DesignSystemInfo> {
  return request(`/api/prototype/design-system?projectId=${encodeURIComponent(projectId)}`)
}

/**
 * Extract the real app's design language from its source into the `design-system`
 * knowledge doc. Slow (a read-only AI pass over the repo) but done once — every later
 * prototype then matches the product without re-reading the code.
 */
export function generateDesignSystem(
  projectId: string,
  model?: string,
  signal?: AbortSignal,
): Promise<DesignSystemInfo> {
  return request('/api/prototype/design-system', {
    method: 'POST',
    body: JSON.stringify({ projectId, model }),
    signal,
  })
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

/**
 * The message for a streaming route that refused the request outright (chat's 413 for an
 * oversize message, 409 for a second concurrent turn, …). Those answer with `{error}` JSON,
 * so handing the body straight to the UI would show the user braces and quotes.
 */
async function streamErrorText(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(raw) as { error?: string }
    if (parsed?.error) return parsed.error
  } catch {
    /* not JSON — fall through to the raw body */
  }
  return raw || `${res.status} ${res.statusText}`
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
    /**
     * Crawled-ticket folder to build FROM (its description + comments become the scope).
     * Omit to keep the prototype's existing link; pass '' to unlink.
     */
    ticketFolder?: string
    /** Let the build read the project's real source so the prototype matches the app. */
    matchApp?: boolean
    /**
     * Answers to open questions, recorded before this build runs. Each becomes a durable
     * decision that grounds this and every later build, and is never asked again.
     */
    decisions?: { q: string; a: string }[]
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
    handlers.onError(await streamErrorText(res))
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

/** Fetch one stored revision's full HTML (for preview / side-by-side compare). */
export function getPrototypeVersion(
  projectId: string,
  slug: string,
  n: number,
): Promise<{ n: number; html: string; prompt: string; summary: string; at: string; model: string }> {
  return request(
    `/api/prototype/${encodeURIComponent(slug)}/versions/${n}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/**
 * Make an earlier revision current again. This APPENDS a revision rather than rewinding,
 * so the restore is itself undoable.
 */
export function restorePrototypeVersion(
  projectId: string,
  slug: string,
  version: number,
): Promise<Prototype> {
  return request(`/api/prototype/${encodeURIComponent(slug)}/restore`, {
    method: 'POST',
    body: JSON.stringify({ projectId, version }),
  })
}

/**
 * Drop one open question without answering it. Open questions accumulate across builds,
 * so this is how a question that doesn't need settling gets cleared.
 */
export function dismissPrototypeQuestion(
  projectId: string,
  slug: string,
  question: string,
): Promise<Prototype> {
  return request(`/api/prototype/${encodeURIComponent(slug)}/questions/dismiss`, {
    method: 'POST',
    body: JSON.stringify({ projectId, question }),
  })
}

/**
 * Draft manual test cases from a prototype — its markup supplies the real labels,
 * fields, states and messages, while the linked ticket still owns the scope. Saves a new
 * version under testing/tickets/<ticketFolder>/testcases/. Requires a linked ticket.
 */
export function generateTestcasesFromPrototype(
  projectId: string,
  slug: string,
  body: { model?: string; instructions?: string } = {},
): Promise<TestCaseResult> {
  return request(`/api/prototype/${encodeURIComponent(slug)}/testcases`, {
    method: 'POST',
    body: JSON.stringify({ projectId, ...body }),
  })
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

/** A shell still running on the server (it outlives the page that opened it). */
export interface TerminalSessionInfo {
  key: string
  kind: 'shell' | 'resume'
  projectId?: string
  tab?: string // terminal tab id on the Terminal page (shell sessions only)
  runId?: string
  cwd: string
  attached: boolean // a browser window is currently viewing it
  startedAt: string
  lastActivityAt: string
}

/** Live terminal sessions — used to re-attach instead of starting a second shell. */
export function listTerminalSessions(): Promise<{ sessions: TerminalSessionInfo[] }> {
  return request('/api/terminal/sessions')
}

// ---------------- Auto Agent (company Claude-credential CLI) ----------------

export type AutoAgentState =
  | 'connected'
  | 'expiring'
  | 'stalled'
  | 'expired'
  | 'logged-out'
  | 'not-installed'

/** Whether the company's Auto Agent CLI is still supplying a Claude credential. */
export interface AutoAgentStatus {
  state: AutoAgentState
  ok: boolean
  message: string
  username: string | null
  serverUrl: string | null
  role: string | null
  expiresAt: string | null
  watcherRunning: boolean
  lastError: string | null
  /** Path to the `auto-agent-ai` binary, or null when it isn't installed here. */
  cliPath: string | null
  checkedAt: string
}

/** Poll Auto Agent's connection state (filesystem + pid probe on the server). */
export function getAutoAgentStatus(): Promise<AutoAgentStatus> {
  return request('/api/auto-agent/status')
}

export type AutoAgentLoginState = 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * A sign-in the SERVER is running (`auto-agent-ai login`). A job rather than a request
 * because the Microsoft step happens in the user's browser: the page starts it, then
 * polls, so a reload mid-sign-in re-attaches instead of losing it.
 */
export interface AutoAgentLoginJob {
  id: string
  state: AutoAgentLoginState
  startedAt: string
  finishedAt: string | null
  /** The Microsoft URL the CLI printed — a fallback for when it can't open the browser. */
  signInUrl: string | null
  /** The CLI is waiting for a typed answer (it asks which AI session when several exist). */
  awaitingAnswer: boolean
  lines: string[]
  error: string | null
  exitCode: number | null
}

/** Start `auto-agent-ai login` on the server. */
export function startAutoAgentLogin(): Promise<AutoAgentLoginJob> {
  return request('/api/auto-agent/login', { method: 'POST' })
}

/** The sign-in in flight (or the last one), or null if none was ever started. */
export function getAutoAgentLogin(): Promise<AutoAgentLoginJob | null> {
  return request('/api/auto-agent/login')
}

/** Answer the CLI's session picker. */
export function answerAutoAgentLogin(text: string): Promise<{ ok: boolean }> {
  return request('/api/auto-agent/login/answer', {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function cancelAutoAgentLogin(): Promise<{ ok: boolean }> {
  return request('/api/auto-agent/login/cancel', { method: 'POST' })
}

/** Run `auto-agent-ai logout`: stops the watcher and drops the shared credential. */
export function autoAgentLogout(): Promise<{ ok: boolean; output: string[] }> {
  return request('/api/auto-agent/logout', { method: 'POST' })
}

// ---- MailBox (disposable inbox for sign-up / OTP / reset-link testing) -------

export interface MailboxInfo {
  address: string
  createdAt: string
  /** The service's own polling floor — the page's auto-refresh must not go under it. */
  minPollMs: number
}

export interface MailSummary {
  id: string
  from: string
  subject: string
  excerpt: string
  date: string
  read: boolean
}

export interface MailDetail extends MailSummary {
  body: string
  to: string
  /** Attachment count — reported so a dropped PDF isn't mistaken for a mail without one. */
  attachments: number
}

/** The current inbox — created on the server the first time this is called. */
export function getMailbox(): Promise<MailboxInfo> {
  return request('/api/mailbox')
}

export function listMail(): Promise<{ address: string; messages: MailSummary[] }> {
  return request('/api/mailbox/messages')
}

export function readMail(id: string): Promise<MailDetail> {
  return request(`/api/mailbox/messages/${encodeURIComponent(id)}`)
}

export function deleteMail(id: string): Promise<{ ok: boolean }> {
  return request(`/api/mailbox/messages/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Rename the inbox (the local part before the @). */
export function setMailboxAddress(name: string): Promise<{ address: string }> {
  return request('/api/mailbox/address', { method: 'POST', body: JSON.stringify({ name }) })
}

/** Abandon this inbox and take a fresh random one. */
export function resetMailbox(): Promise<{ address: string }> {
  return request('/api/mailbox/reset', { method: 'POST' })
}

// ---- Chat (plain conversation with Claude Code, in the project folder) -------

/**
 * How much a chat turn is allowed to do — `read` (ask only), `write` (may edit files in the
 * project, no MCP servers), `full` (Terminal parity: everything, MCP loaded).
 * See routes/chat.ts `toolArgs`; the labels live in ChatPage's `CHAT_MODES`.
 */
export type ChatTools = 'read' | 'write' | 'full'

/**
 * How hard the model thinks — the CLI's `--effort`. `'default'` sends no flag at all, so
 * the turn runs at whatever effort the engineer's own Claude Code is configured for.
 * See routes/chat.ts `ChatEffort`; the labels live in ChatPage's `CHAT_EFFORTS`.
 */
export type ChatEffort = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * An action picked from the composer's `+` menu, applied to ONE message: `web` answers from
 * the live web with its sources, `research` writes a cross-checked report, `diagram` answers
 * as a Mermaid diagram the page renders. See routes/chat.ts `ACTION_BLOCKS`.
 */
export type ChatAction = 'web' | 'research' | 'diagram'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
  /**
   * Tool names the turn used, in order.
   *
   * Superseded by `steps`; still sent, and still read here, because every conversation
   * saved before `steps` existed has only this — dropping the fallback would blank the
   * trail on the whole back catalogue.
   */
  tools?: string[]
  /** What the turn did, with targets and positions in the answer — see ChatToolCall. */
  steps?: ChatToolCall[]
  model?: string
  /** Effort the turn ran at — absent when it was the engineer's own default. */
  effort?: ChatEffort
  error?: boolean
  /** Images pasted with this message — file names, shown via `chatImageUrl`. */
  images?: string[]
  /**
   * Documents attached with this message. `file` is the server-generated name under
   * testing/chats/files (opened with `chatFileUrl`); `name` is the engineer's own file
   * name, which is what the chip shows.
   */
  files?: { file: string; name: string }[]
  /** Follow-up prompts proposed with this answer, offered as one-click chips. */
  suggestions?: string[]
  /** The `+` menu action this message was sent with (badged in the transcript). */
  action?: ChatAction
  /** What the portal appended to this message before sending it (see ContextBlock). */
  context?: ContextBlock[]
  /** What this turn took and cost (assistant messages only — see TurnStats). */
  stats?: TurnStats
  /** The engineer's 👍/👎 on this answer, and the memory it wrote — see ChatFeedback. */
  feedback?: ChatFeedback
  /**
   * Project files this answer named that are NOT on disk — the free citation check.
   *
   * Absent when there were none (never `[]`), so an answer saved before the check existed
   * is not drawn as "verified clean". A path here means "look before you trust this line",
   * not "the answer is wrong": in Workspace-write mode the model creates files, and an
   * answer may legitimately propose one that doesn't exist yet.
   */
  refs?: string[]
  /** The fact check, if one was run on this answer — see ChatAudit. */
  audit?: ChatAudit
}

/**
 * A RATING ON ONE ANSWER, and what the project learned from it.
 *
 * Rating an answer is not a like button: it writes to project MEMORY. The server reflects
 * on the question, the answer and the vote and persists the durable fact behind it into
 * `testing/memory` — which every later chat turn already reads — so a 👎 on a wrong answer
 * is what stops the next one repeating it. `captured` names the notes that were written
 * (they show on Instructions → Memory); `skipped` says why there weren't any, which for a
 * vote on wording is the normal outcome. See routes/chat.ts `ChatFeedback`.
 */
export interface ChatFeedback {
  vote: 'up' | 'down'
  at: string
  /** What was typed with a 👎, if anything — optional, because requiring it stops people voting. */
  note?: string
  /** Memory note names written or updated because of this vote. */
  captured?: string[]
  /** Why nothing was captured — "nothing worth remembering" is a normal answer. */
  skipped?: string
}

/**
 * ONE CHECKED CLAIM from a fact check — see ChatAudit.
 *
 * `wrong` and `unsupported` are the two that mean the answer is defective. `unverified` is
 * an honest outcome and is shown as such: the auditor looked and could not confirm it
 * either way, which is different from (and much more common than) a contradiction.
 *
 * `unsupported` exists for one specific failure and only appears on a `defect` claim: the
 * answer called something a bug, the observation may even be true, but nothing in the
 * project states the behaviour it is being measured against. That is the shape of every
 * finding that gets withdrawn the moment someone asks "where does it say it should do
 * that?", so it is graded as an issue, not as a shrug.
 */
export interface AuditClaim {
  claim: string
  status: 'supported' | 'wrong' | 'unsupported' | 'unverified'
  /** Where it was confirmed — or, for `wrong`, what the project actually says. */
  evidence?: string
  /** This claim says something in the product is broken/missing/wrong. */
  defect?: boolean
}

/**
 * THE FACT CHECK on one answer — run on demand, stored with the answer.
 *
 * A second, independent, cheap model re-reads the project and rates the answer's checkable
 * claims about it. It is a button and not something that happens automatically because it
 * re-reads real files: 30-90 seconds and real money, which would otherwise be added to
 * every question including the ones nobody is going to act on.
 *
 * `skipped` present means the check DID NOT RUN (timed out, no reply). That must never be
 * drawn as a clean verdict — "not checked" and "nothing wrong" are opposite facts.
 */
export interface ChatAudit {
  at: string
  /** Which model audited — a haiku verdict and an opus one are not equal evidence. */
  model: string
  /** `none` = the answer made no checkable claim about the project, which is normal. */
  verdict: 'clean' | 'issues' | 'unverified' | 'none'
  claims: AuditClaim[]
  skipped?: string
}

/**
 * What one turn took and cost, recorded with the answer.
 *
 * Every value was already reported by the CLI on its final `result` event and then thrown
 * away, so showing it costs no request, no token and no latency — and it lands ONCE, when
 * the turn ends, never per streamed frame.
 *
 * There is deliberately no share-of-context-window figure: the portal doesn't assemble the
 * prompt (the CLI owns the system prompt, the MCP tool schemas and the history), so any
 * split of `inputTokens` would be a guess that goes quietly wrong when the CLI changes.
 */
export interface TurnStats {
  /** Wall clock for the whole turn, ms. */
  ms: number
  /** Time to the first character of the answer, ms. */
  ttftMs?: number
  inputTokens?: number
  outputTokens?: number
  /** Of `inputTokens`, how many were served from the provider's prefix cache. */
  cacheReadTokens?: number
  costUsd?: number
}

/**
 * One block of text the PORTAL added to a message before it went to the model.
 *
 * A chat turn is never only what was typed: the resolved `@`/`/` picks, the paths of
 * pasted images, the `+` menu action's instructions and — after a lapsed session — a
 * replayed summary all ride along. None of it used to be visible, so a strange answer
 * had no explanation available to the person reading it. Shown in the transcript as
 * collapsed rows under the question.
 */
export interface ContextBlock {
  /** Short label for the collapsed row. */
  label: string
  /** The exact text that was appended (capped server-side, which says so inline). */
  text: string
}

/**
 * One tool call as it happens, streamed live during a turn: the tool's name plus its one
 * interesting argument (the file read, the pattern searched for, the command run). The
 * detail is NOT persisted — a saved message keeps `tools` (names only).
 */
/**
 * ONE THING A TURN DID — a tool call, or a block of thinking.
 *
 * `pos` is a character offset into the answer text, so the trail can be put back exactly
 * where it happened when the conversation is reopened. It is the answer's own coordinate
 * system on purpose: a timestamp would need the deltas' arrival times, which nothing
 * stores, and a step index would need the text to have been segmented at write time.
 */
export interface ChatToolCall {
  name: string
  detail?: string
  /** `think` blocks read differently from tool calls, and are not tool calls. */
  kind?: 'think'
  /**
   * Characters of answer written when this landed. Absent on a pre-`steps` transcript.
   * `pos` rather than `at`: every other `at` in this file is an ISO timestamp, including
   * one on the very same SSE frame type.
   */
  pos?: number
}

/** A pasted image on its way to the server: base64 bytes, typed by its MIME. */
export interface ChatImageUpload {
  mime: string
  data: string
}

/**
 * An attached document on its way to the server: the engineer's file name plus the
 * markdown the browser converted it to (`lib/docConvert`). The server writes it to disk
 * and has Claude Read it — the text never travels inside the prompt.
 */
export interface ChatDocUpload {
  name: string
  markdown: string
}

/**
 * A project artifact tagged with `@` — or a skill picked with `/` — in a message. Only the
 * reference travels: the server resolves an artifact to files and tells Claude to Read them,
 * and a skill to its SKILL.md to follow (see routes/chat.ts `resolveMentions`).
 */
export interface ChatMention {
  kind: 'ticket' | 'testcase' | 'database' | 'skill'
  /** Crawled-ticket folder under testing/tickets/ (nested PARENT/CHILD for a subtask). */
  folder?: string
  /** Test-case version, or omitted for the newest. */
  version?: number
  /** Connected database id — the server re-checks it belongs to this project. */
  databaseId?: string
  /** Skill folder name under the project's .claude/skills/. */
  skill?: string
}

export interface Chat {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  tools: ChatTools
  /** Effort the last turn ran at — the default for the next one. */
  effort?: ChatEffort
  /** The Claude CLI session backing the conversation (what makes follow-ups work). */
  sessionId: string | null
  /** Starred — the rail pins it above the date groups. */
  pinned?: boolean
  /**
   * Temporary — kept in the server's memory only: no transcript file in testing/chats, and
   * never listed in the history rail. Set when the conversation is created; a follow-up
   * inherits it (see routes/chat.ts `temp`).
   */
  temporary?: boolean
  /** A reply is being generated right now; the page re-attaches to it (see attachChat). */
  running?: boolean
  /**
   * Messages waiting behind the running turn. Only present while `running` — a fresh page
   * load has no stream yet, so this is how it learns what is queued.
   */
  queued?: QueuedChatMessage[]
  messages: ChatMessage[]
}

/** A conversation without its messages — what the history rail lists. */
export interface ChatSummary {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  tools: ChatTools
  effort?: ChatEffort
  messageCount: number
  preview: string
  pinned?: boolean
  /** A reply is in flight for this conversation — the rail marks it. */
  running?: boolean
}

/** The project's conversations, newest first. */
export function listChats(projectId: string): Promise<{ chats: ChatSummary[] }> {
  return request(`/api/chat?projectId=${encodeURIComponent(projectId)}`)
}

/** One conversation in full. */
export function getChat(projectId: string, slug: string): Promise<Chat> {
  return request(
    `/api/chat/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`,
  )
}

/** Rename a conversation (display name only). */
export function renameChat(projectId: string, slug: string, name: string): Promise<Chat> {
  return request(`/api/chat/${encodeURIComponent(slug)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ projectId, name }),
  })
}

/**
 * Star / unstar a conversation. Deliberately does not touch `updatedAt` server-side, so
 * pinning doesn't also drag the chat into the rail's "Today" group.
 */
export function pinChat(projectId: string, slug: string, pinned: boolean): Promise<Chat> {
  return request(`/api/chat/${encodeURIComponent(slug)}/pin`, {
    method: 'POST',
    body: JSON.stringify({ projectId, pinned }),
  })
}

/**
 * Rate one answer (`POST /api/chat/:slug/feedback`) — 'up', 'down', or null to clear.
 *
 * `index` is the message's position in the transcript. The vote is saved first and the AI
 * capture runs after it, so this call takes as long as a cheap model turn (a few seconds)
 * and resolves with what it remembered. Abandoning it does not lose the vote — or the
 * capture, which finishes server-side either way. Clearing a vote leaves any note it
 * already wrote in place: by then it is an ordinary project fact on the Memory tab.
 */
export function rateChatAnswer(
  projectId: string,
  slug: string,
  index: number,
  vote: 'up' | 'down' | null,
  note?: string,
): Promise<{ ok: true; feedback: ChatFeedback | null }> {
  return request(`/api/chat/${encodeURIComponent(slug)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ projectId, index, vote, note }),
  })
}

/**
 * Fact-check one stored answer (`POST /api/chat/:slug/audit`).
 *
 * SLOW ON PURPOSE — it spawns a second model that re-reads the project, so it takes as
 * long as a small chat turn. It never touches the answer or the conversation; the verdict
 * is stored beside the answer and comes back here. The server refuses a second check on
 * the same answer while one is running (409) rather than paying twice.
 */
export function auditChatAnswer(
  projectId: string,
  slug: string,
  index: number,
): Promise<{ ok: true; audit: ChatAudit }> {
  return request(`/api/chat/${encodeURIComponent(slug)}/audit`, {
    method: 'POST',
    body: JSON.stringify({ projectId, index }),
  })
}

export function deleteChat(projectId: string, slug: string): Promise<{ ok: true }> {
  return request(
    `/api/chat/${encodeURIComponent(slug)}?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

/** Src for an image pasted into a message (served from testing/chats/images). */
export function chatImageUrl(projectId: string, name: string): string {
  return `/api/chat/images/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`
}

/** Src for a document attached to a message (served from testing/chats/files). */
export function chatFileUrl(projectId: string, name: string): string {
  return `/api/chat/files/${encodeURIComponent(name)}?projectId=${encodeURIComponent(projectId)}`
}

/** Reveal the project's testing/chats folder in the OS file explorer. */
export function openChatsFolder(projectId: string): Promise<{ ok: boolean; path: string }> {
  return request('/api/chat/open', { method: 'POST', body: JSON.stringify({ projectId }) })
}

/** What a chat stream reports, whether it was just started or re-attached to. */
export interface ChatStreamHandlers {
  onStart?: (slug: string, name: string) => void
  /**
   * Re-attach only: the question this in-flight turn is answering. A reloaded page no
   * longer has the prompt it sent, so the server echoes it back with its images.
   */
  onResume?: (info: { prompt: string; at: string; images: string[] }) => void
  onDelta: (text: string) => void
  onTool?: (call: ChatToolCall) => void
  /**
   * The ANSWER is over; the follow-up chips are still being written. Carries the model
   * that answered and the timings, both of which the server already knows at this point —
   * the token counts and the cost cannot exist until the run ends and arrive with `done`.
   */
  onSettled?: (model: string, stats: TurnStats) => void
  /**
   * The turn finished and was saved. `dropped` appears when it finished BADLY (the CLI
   * reported an error even though it produced text): the queue does not advance past a
   * turn that never really answered, so what was waiting comes back instead.
   */
  onDone: (chat: Chat, dropped?: string[]) => void
  /**
   * The turn was stopped; `chat` carries the partial answer when one was saved.
   * `dropped` is the text of any messages that were waiting behind it — Stop halts the
   * whole conversation, so they never run and the composer takes them back.
   */
  onStopped?: (chat?: Chat, dropped?: string[]) => void
  onError: (message: string, dropped?: string[]) => void
  onLog?: (level: 'info' | 'success' | 'error', text: string) => void
  /**
   * The messages waiting behind the turn being watched, as a WHOLE list every time —
   * never a delta. A viewer that attached late gets the identical frame, so there is one
   * way to be right about the queue instead of a fold the client could get out of step.
   */
  onQueue?: (queued: QueuedChatMessage[]) => void
}

/** One message accepted while another turn was running, waiting for its own turn. */
export interface QueuedChatMessage {
  id: string
  prompt: string
  at: string
  /** File names of images pasted with it (served by `chatImageUrl`). */
  images: string[]
  action?: ChatAction
}

/** Turn an SSE body into handler calls. Shared by starting a turn and re-attaching to one. */
async function consumeChatStream(res: Response, handlers: ChatStreamHandlers): Promise<void> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let settled = false // saw a terminal (done/stopped/error) frame
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
        name?: string
        detail?: string
        kind?: 'think'
        pos?: number
        model?: string
        stats?: TurnStats
        slug?: string
        prompt?: string
        at?: string
        images?: string[]
        level?: 'info' | 'success' | 'error'
        chat?: Chat
        error?: string
        queued?: QueuedChatMessage[]
        dropped?: string[]
      }
      try {
        msg = JSON.parse(dataLine.slice(5).trim())
      } catch {
        continue
      }
      if (msg.type === 'delta') handlers.onDelta(msg.text ?? '')
      else if (msg.type === 'settled') {
        if (msg.model && msg.stats) handlers.onSettled?.(msg.model, msg.stats)
      } else if (msg.type === 'tool')
        handlers.onTool?.({ name: msg.name ?? '', detail: msg.detail, kind: msg.kind, pos: msg.pos })
      else if (msg.type === 'start' && msg.slug) {
        // One stream can carry SEVERAL turns: when a queued message follows, the server
        // hands over on the same connection and opens the next turn with `start` again.
        // So the terminal flag resets here — otherwise a connection that dropped during a
        // LATER turn would look cleanly finished because an earlier one had ended.
        settled = false
        handlers.onStart?.(msg.slug, msg.name ?? '')
      } else if (msg.type === 'resume')
        handlers.onResume?.({ prompt: msg.prompt ?? '', at: msg.at ?? '', images: msg.images ?? [] })
      else if (msg.type === 'log') handlers.onLog?.(msg.level ?? 'info', msg.text ?? '')
      else if (msg.type === 'queue') handlers.onQueue?.(msg.queued ?? [])
      else if (msg.type === 'done' && msg.chat) {
        settled = true
        handlers.onDone(msg.chat, msg.dropped)
      } else if (msg.type === 'stopped') {
        settled = true
        handlers.onStopped?.(msg.chat, msg.dropped)
      } else if (msg.type === 'error') {
        settled = true
        handlers.onError(msg.error ?? 'The message failed', msg.dropped)
      }
    }
  }
  // The stream closed with no terminal frame (server ended early) — don't leave the
  // caller stuck showing a spinner forever.
  if (!settled) handlers.onError('The answer ended before finishing. Please try again.')
}

/**
 * Watch a reply that is ALREADY being generated (`GET /api/chat/:slug/stream`).
 *
 * The turn belongs to the conversation, not to the request that started it, so reloading
 * or leaving the page doesn't stop it — this re-attaches, replays what has been written
 * so far, then streams the rest. Resolves `false` when nothing was in flight.
 */
export async function attachChat(
  projectId: string,
  slug: string,
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<boolean> {
  const res = await fetch(
    `/api/chat/${encodeURIComponent(slug)}/stream?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  )
  if (!res.ok || !res.body) return false // 404 = nothing running, the normal case
  await consumeChatStream(res, handlers)
  return true
}

/**
 * Cancel a reply in flight. Closing the tab no longer does this — the run outlives the
 * request — so Stop has to say so explicitly.
 */
export function stopChat(
  projectId: string,
  slug: string,
): Promise<{ ok: boolean; dropped: string[] }> {
  return request(`/api/chat/${encodeURIComponent(slug)}/stop`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  })
}

/**
 * Send a message and stream the reply (Server-Sent Events).
 *
 * `onStart` fires with the conversation's slug before any text — a brand-new chat is
 * created server-side on the first turn, so the client has to adopt the slug it was
 * given rather than inventing one. `onDelta` fires per token, `onTool` per tool call,
 * `onDone` with the saved conversation. Aborting the signal only stops WATCHING — the
 * turn keeps running on the server; `stopChat` is what cancels it. Resolves when the
 * stream ends.
 */
export async function streamChat(
  projectId: string,
  body: {
    slug?: string
    prompt: string
    model: string
    tools: ChatTools
    /** Effort for this turn; 'default' leaves the CLI on the engineer's own setting. */
    effort: ChatEffort
    /**
     * Start this conversation as a TEMPORARY one — nothing written to testing/chats, nothing
     * in the history rail. Only read when a NEW conversation is created; a message sent into
     * an existing `slug` inherits whatever that conversation already is.
     */
    temporary?: boolean
    /** `+` menu action for this message only — web search, deep research, diagram. */
    action?: ChatAction
    /** Pasted screenshots; the server writes them and tells Claude to Read them. */
    images?: ChatImageUpload[]
    /**
     * Documents attached with the paperclip, already converted to markdown in the browser.
     * Sent as their own field — NOT pasted into `prompt` — because the prompt is capped at
     * 48 KB and a long spec would silently lose its tail. The server writes each one under
     * testing/chats/files and tells Claude to Read it.
     */
    attachments?: ChatDocUpload[]
    /** `@`-tagged tickets / test cases the question is about. */
    mentions?: ChatMention[]
  },
  handlers: ChatStreamHandlers,
  signal: AbortSignal,
): Promise<ChatSendResult> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, ...body }),
    signal,
  })
  if (!res.ok || !res.body) {
    handlers.onError(await streamErrorText(res))
    return { kind: 'failed' }
  }
  // 202 — a reply was already being generated, so this message is WAITING its turn and
  // there is no stream to read: the answer will arrive on whichever stream is watching the
  // conversation (the running turn's, which the server hands over to this message). Feeding
  // this JSON body to the SSE reader would find no frames and report "the answer ended
  // before finishing", i.e. an error for a message that is perfectly fine.
  if (res.status === 202) {
    const info = (await res.json()) as { id?: string; slug?: string; position?: number }
    return {
      kind: 'queued',
      id: info.id ?? '',
      slug: info.slug ?? '',
      position: info.position ?? 1,
    }
  }
  await consumeChatStream(res, handlers)
  return { kind: 'streamed' }
}

/** What `streamChat` did with the message. */
export type ChatSendResult =
  | { kind: 'streamed' }
  | { kind: 'queued'; id: string; slug: string; position: number }
  | { kind: 'failed' }

/**
 * Take back a queued message before it runs (`DELETE /api/chat/:slug/queue/:id`).
 *
 * 404 means it has already started, in which case Stop is the control that applies.
 */
export function cancelQueuedChat(
  projectId: string,
  slug: string,
  id: string,
): Promise<{ ok: boolean; queued: QueuedChatMessage[] }> {
  return request(
    `/api/chat/${encodeURIComponent(slug)}/queue/${encodeURIComponent(id)}` +
      `?projectId=${encodeURIComponent(projectId)}`,
    { method: 'DELETE' },
  )
}

// ---- Performance testing (k6 load tests + browser page-load audits) ----

/** avg/min/med/max/p90/p95/p99 for one k6 trend metric, in ms (or bytes). */
export interface TrendStats {
  avg: number
  min: number
  med: number
  max: number
  p90: number
  p95: number
  p99: number
}

/** Per-endpoint results from a k6 run — "how long does THIS call take?". */
export interface LoadEndpointResult {
  name: string
  method: string
  url: string
  calls: number
  okRate: number
  duration: TrendStats
  /** Time to first byte — the server's own think time. */
  waiting: TrendStats
  avgBytes: number
}

/**
 * Where a request's time went, averaged over the run. `http_req_duration` is the
 * SUM of these, and which phase dominates decides what to chase: `waiting` is the
 * server thinking, `connecting`/`tlsHandshaking` is connection setup, `receiving`
 * is payload size, `blocked` is the load generator queueing against itself.
 */
export interface RequestPhases {
  blocked: TrendStats
  connecting: TrendStats
  tlsHandshaking: TrendStats
  sending: TrendStats
  waiting: TrendStats
  receiving: TrendStats
}

/**
 * One slice of the run's timeline.
 *
 * k6's summary is a single set of aggregates for the whole run, so the script
 * buckets its own samples into fixed custom metrics — that is the only reason
 * "did it degrade as load arrived?" can be answered at all. A slice with no
 * requests is absent, not zero.
 */
/** One rung of the response-time histogram. `toMs` is null on the top rung. */
export interface LatencyBucket {
  fromMs: number
  toMs: number | null
  count: number
}

export interface LoadTimeBucket {
  atSeconds: number
  requests: number
  rps: number
  failRate: number
  avgMs: number
  p95Ms: number
  maxMs: number
  vus: number
}

export interface LoadTestResult {
  completed: boolean
  exitCode: number
  thresholdsPassed: boolean
  durationMs: number
  requests: number
  requestsPerSecond: number
  failRate: number
  /** Whole requests that failed — counted by k6, not derived from the rate. */
  failedRequests: number
  checksPassed: number
  checksFailed: number
  overall: TrendStats
  waiting: TrendStats
  phases: RequestPhases
  /** One full pass through every endpoint = one iteration. */
  iterations: number
  iterationDuration: TrendStats
  /** Iterations k6 could not start — the generator, not the system, gave out. */
  droppedIterations: number
  vusMax: number
  dataReceived: number
  dataSent: number
  bucketSeconds: number
  buckets: LoadTimeBucket[]
  /** The response-time distribution; empty for a run recorded before it existed. */
  latency: LatencyBucket[]
  endpoints: LoadEndpointResult[]
}

/** Browser timings for a single navigation, in ms from navigation start. */
export interface PageLoadMetrics {
  ttfbMs: number
  domContentLoadedMs: number
  loadMs: number
  fcpMs: number
  lcpMs: number
  transferBytes: number
  requestCount: number
  /** Cumulative Layout Shift — the third Core Web Vital. */
  cls: number
  /** Blocking time: long tasks before the load event, the part past 50ms each. */
  tbtMs: number
  longestTaskMs: number
}

/** A JavaScript error the page reported while loading. */
export interface PageIssue {
  kind: 'pageerror' | 'console'
  text: string
  count: number
}

/** Cold-load bytes and request count for one resource type. */
export interface ResourceGroup {
  type: string
  count: number
  bytes: number
}

/** One cold-load request, positioned in time. Offsets are ms from navigation start. */
export interface TimelineEntry {
  method: string
  url: string
  resourceType: string
  api: boolean
  startMs: number
  endMs: number
  bytes: number
  status: number | null
}

export interface AuditRequest {
  method: string
  url: string
  resourceType: string
  status: number | null
  count: number
  /** count / runs — 2 means "called twice on every page load". */
  perLoad: number
  avgMs: number
  maxMs: number
  avgWaitMs: number
  avgBytes: number
  api: boolean
}

/** An API endpoint the page called more than once per load. */
export interface DuplicateEndpoint {
  method: string
  endpoint: string
  count: number
  perLoad: number
  urls: string[]
  avgMs: number
  totalMsPerLoad: number
}

export interface PageAuditResult {
  url: string
  runs: number
  /** Where the browser actually ended up — a login redirect shows up here. */
  finalUrl: string
  /** True when the browser ended on a different path than the requested URL. */
  redirected: boolean
  perRun: PageLoadMetrics[]
  /** The mean across loads. Kept for older reports; the page grades on cold/warm. */
  average: PageLoadMetrics
  /** The first load — an empty cache, what a new visitor gets. */
  cold: PageLoadMetrics
  /** The median of every load after the first. Equals `cold` when there was one. */
  warm: PageLoadMetrics
  /** How many loads went into `warm`; 0 means there is no warm measurement. */
  warmRuns: number
  issues: PageIssue[]
  resources: ResourceGroup[]
  timeline: TimelineEntry[]
  requests: AuditRequest[]
  duplicates: DuplicateEndpoint[]
  totals: {
    requestCount: number
    apiCount: number
    apiEndpointCount: number
    transferBytes: number
    slowestApiMs: number
  }
}

export type PerfJobKind = 'load' | 'page'
export type PerfJobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface PerfLogLine {
  time: string
  level: 'info' | 'success' | 'error'
  text: string
}

/** The echoed-back load config. Headers and bodies are stripped server-side. */
export interface PublicLoadConfig {
  name: string
  vus: number
  duration: string
  rampUp: string
  thresholdP95Ms: number
  thresholdErrorRate: number
  endpoints: { name: string; method: string; url: string }[]
}

export interface PublicPageConfig {
  url: string
  runs: number
  settleMs: number
  headed: boolean
  useProfile: boolean
}

export interface PerfJob {
  id: string
  projectId: string
  kind: PerfJobKind
  label: string
  status: PerfJobStatus
  progress: string
  logs: PerfLogLine[]
  loadConfig: PublicLoadConfig | null
  pageConfig: PublicPageConfig | null
  loadResult: LoadTestResult | null
  pageResult: PageAuditResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

/** One endpoint in a load test, as the form holds it (headers included). */
export interface LoadEndpointInput {
  name: string
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

export interface LoadTestInput {
  name: string
  vus: number
  duration: string
  rampUp: string
  sleepSeconds: number
  thresholdP95Ms: number
  thresholdErrorRate: number
  insecureSkipTLSVerify: boolean
  endpoints: LoadEndpointInput[]
}

export interface PerfAvailability {
  k6: { ok: boolean; version?: string; error?: string; installHint: string }
  browser: { ok: boolean; error?: string }
}

/** What the NFR report can fill in without asking — see `suggestMeta`. */
export interface NfrReportContext {
  /** This machine's git identity, or '' when git is absent or unconfigured. */
  tester: string
  host: string
  platform: string
}

/**
 * Machine + identity facts for the NFR report's cover.
 *
 * Answered by the local server about the local machine, for a report the same
 * person downloads — nothing here is sent anywhere.
 */
export function getReportContext(projectId: string): Promise<NfrReportContext> {
  return request(`/api/performance/report-context?projectId=${encodeURIComponent(projectId)}`)
}

/** Is k6 installed, and can a browser audit run, on this machine? */
export function getPerfAvailable(): Promise<PerfAvailability> {
  return request('/api/performance/available')
}

/** The k6 script this config generates — shown so it can be run from a terminal too. */
export function previewK6Script(input: LoadTestInput): Promise<{ script: string }> {
  return request('/api/performance/script', { method: 'POST', body: JSON.stringify(input) })
}

/** Start a k6 load test in the background. */
export function startLoadTest(
  projectId: string,
  input: LoadTestInput,
): Promise<{ jobId: string; job: PerfJob }> {
  return request(`/api/performance/load-tests?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Start a browser page-load audit in the background. */
export function startPageAudit(
  projectId: string,
  input: { url: string; runs: number; settleMs: number; headed: boolean; useProfile: boolean },
): Promise<{ jobId: string; job: PerfJob }> {
  return request(`/api/performance/page-audits?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

/** Poll one performance job's log + result. */
export function getPerfJob(id: string): Promise<{ job: PerfJob }> {
  return request(`/api/performance/jobs/${encodeURIComponent(id)}`)
}

/** This project's performance jobs, newest first. */
export function listPerfJobs(projectId: string): Promise<{ jobs: PerfJob[] }> {
  return request(`/api/performance/jobs?projectId=${encodeURIComponent(projectId)}`)
}

/** Stop a running performance job. */
/**
 * Convert a report to PDF or Word. The HTML is built in the browser (that is where
 * the verdict and the charts live) and the server only converts it — printing
 * needs a real Chrome and .docx needs a zip writer, neither of which a page has.
 * Returns the file itself, so the caller can hand it straight to a download.
 */
export async function exportReportFile(
  format: 'pdf' | 'docx',
  html: string,
  fileName: string,
  /** Running footer, printed on EVERY page. One line of plain text. */
  footer = '',
): Promise<Blob> {
  const res = await fetch(`/api/performance/report/${format}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html, fileName, footer }),
  })
  if (!res.ok) {
    // The failure path answers with JSON even though the success path is binary.
    const text = await res.text().catch(() => '')
    let message = text || `${res.status} ${res.statusText}`
    try {
      const parsed = JSON.parse(text) as { error?: string }
      if (parsed.error) message = parsed.error
    } catch {
      /* not JSON — show what came back */
    }
    throw new Error(message)
  }
  return res.blob()
}

/**
 * The sign-in window: a real Chrome on the SAME profile the audit uses. Needed
 * because the token lives in localStorage, which is per origin and per profile —
 * so being logged in anywhere else (your own Chrome, another origin) does nothing.
 */
export interface AuthSessionStatus {
  active: boolean
  url: string | null
  startedAt: string | null
  currentUrl: string | null
  origin: string | null
}

export function getAuthSession(): Promise<{ session: AuthSessionStatus }> {
  return request('/api/performance/auth-session')
}

export function openAuthSession(url: string): Promise<{ session: AuthSessionStatus }> {
  return request('/api/performance/auth-session', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

/** Closing is what saves the session and frees the profile for the audit. */
export function closeAuthSession(): Promise<{
  closed: boolean
  finalUrl: string | null
  origin: string | null
  session: AuthSessionStatus
}> {
  return request('/api/performance/auth-session/close', { method: 'POST' })
}

/**
 * Forget the saved login for one origin inside the audit's profile. Needed before
 * a real "sign in again": with the stale token still there the app skips its own
 * login screen, so nothing gets refreshed.
 */
export function clearAuthSession(url: string): Promise<{
  origin: string
  cookieDomains: number
  storageCleared: boolean
}> {
  return request('/api/performance/auth-session/clear', {
    method: 'POST',
    body: JSON.stringify({ url }),
  })
}

export function cancelPerfJob(id: string): Promise<{ job: PerfJob }> {
  return request(`/api/performance/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
}

/** Drop a run from Recent runs for good — cancels it first if it is still going. */
export function deletePerfJob(id: string): Promise<{ deleted: boolean }> {
  return request(`/api/performance/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// ---- Remote access (Cloudflare Tunnel) ----

export type TunnelMode = 'quick' | 'token' | 'named'
export type TunnelState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface TunnelStatus {
  state: TunnelState
  url: string | null
  mode: TunnelMode | null
  startedAt: string | null
  readyAt: string | null
  error: string | null
  log: string[]
  restarts: number
  installed: boolean
  binPath: string | null
  installHint: string
  target: string
  uiBundled: boolean
  hasAccessPassword: boolean
}

export interface TunnelSettings {
  mode: TunnelMode
  hasToken: boolean
  tunnelName: string
  hostname: string
  autoStart: boolean
  autoRestart: boolean
  updatedAt: string
}

export interface RemoteAccessInfo {
  hasPassword: boolean
  sessionHours: number
  allowTerminal: boolean
  minPasswordLength: number
  updatedAt: string
}

export interface RemoteOverview {
  status: TunnelStatus
  settings: TunnelSettings
  access: RemoteAccessInfo
  /** True when the page itself is being viewed through the tunnel — controls go read-only. */
  viewingRemotely: boolean
}

export function getRemoteOverview(): Promise<RemoteOverview> {
  return request('/api/remote')
}

/**
 * `token: null` clears the stored connector token; omitting the field keeps it — the
 * page never receives the token, so it must be able to save a hostname without it.
 */
export function saveTunnelSettings(patch: {
  mode?: TunnelMode
  token?: string | null
  tunnelName?: string
  hostname?: string
  autoStart?: boolean
  autoRestart?: boolean
}): Promise<{ ok: true; settings: TunnelSettings; status: TunnelStatus }> {
  return request('/api/remote/settings', { method: 'PUT', body: JSON.stringify(patch) })
}

export function startTunnel(): Promise<{ ok: true; status: TunnelStatus }> {
  return request('/api/remote/start', { method: 'POST' })
}

export function stopTunnel(): Promise<{ ok: true; status: TunnelStatus }> {
  return request('/api/remote/stop', { method: 'POST' })
}

export function setRemotePassword(
  password: string,
): Promise<{ ok: true; access: RemoteAccessInfo; sessionsRevoked: boolean }> {
  return request('/api/remote/password', { method: 'POST', body: JSON.stringify({ password }) })
}

export function clearRemotePassword(): Promise<{ ok: true; access: RemoteAccessInfo }> {
  return request('/api/remote/password', { method: 'DELETE' })
}

export function saveRemoteAccessOptions(patch: {
  sessionHours?: number
  allowTerminal?: boolean
}): Promise<{ ok: true; access: RemoteAccessInfo }> {
  return request('/api/remote/access', { method: 'PUT', body: JSON.stringify(patch) })
}

/** Rotate the session key — every already-unlocked device has to enter the password again. */
export function revokeRemoteSessions(): Promise<{ ok: true }> {
  return request('/api/remote/sessions/revoke', { method: 'POST' })
}
