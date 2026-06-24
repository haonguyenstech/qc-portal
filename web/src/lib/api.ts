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

export function createProject(body: { name: string; rootPath: string }): Promise<Project> {
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
  },
): Promise<Project> {
  return request(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export function deleteProject(id: string): Promise<{ ok: true }> {
  return request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
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
}): Promise<{ runId: string } & RunSummary> {
  return request('/api/qc/run', { method: 'POST', body: JSON.stringify(body) })
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

export function clickupStatus(): Promise<{ configured: boolean }> {
  return request('/api/clickup/status')
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
): Promise<CrawlResult> {
  return request('/api/clickup/crawl', {
    method: 'POST',
    body: JSON.stringify({ taskId, projectId, model: model ?? 'none' }),
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
  issues: { title: string; description: string }[]
  projectId?: string
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
  tickets: { id: string; displayId: string; name: string }[]
  model?: string
}): Promise<{ jobId: string; job: CrawlJob }> {
  return request('/api/clickup/crawl/jobs', {
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

export interface CrawledTicket {
  name: string // folder name under testing/tickets/ (sanitized displayId)
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

export type McpOauthProvider = 'clickup' | 'figma'

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

/** Token-connect: save a pasted personal API token into the project's .mcp.json. */
export function saveMcpToken(
  provider: McpOauthProvider,
  token: string,
  projectId: string,
): Promise<void> {
  return request(
    `/api/mcp/oauth/${encodeURIComponent(provider)}/token?projectId=${encodeURIComponent(projectId)}`,
    { method: 'POST', body: JSON.stringify({ token }) },
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
