// Shared API contract between server and web.
// The web app mirrors these shapes in web/src/lib/types.ts.

export type RunStatus =
  | 'queued'
  | 'running'
  | 'paused' // stopped by the user but resumable (Claude session is kept)
  | 'passed'
  | 'failed'
  | 'error'
  | 'canceled'

// A project = a repo/folder the portal manages (its own .claude/skills, .mcp.json, testing/).
export interface Project {
  id: string
  name: string
  rootPath: string
  isDefault: boolean
  pinned: boolean // user-pinned → sorts to the top of the project list
  createdAt: string // ISO
  description: string // free-text project intro shown on the Overview page
  diagram: string // AI-generated Mermaid diagram of the project, shown on the Overview page
  // Connected source-code repo (GitHub/Bitbucket), cloned locally so Claude can read
  // it. Empty strings mean "not connected". The access token is NEVER stored here —
  // it lives in data/source-credentials.json (see sourceRepo.ts).
  sourceRepoUrl: string // tokenless https remote URL
  sourceProvider: string // 'github' | 'bitbucket' | 'other' | '' (derived from host)
  sourceBranch: string // checked-out branch
  sourcePath: string // absolute local folder of the source (== rootPath or <root>/source)
  sourceLastSync: string // ISO time of the last successful clone/pull
  sourceLastCommit: string // short sha + subject of HEAD at last sync
  // Per-project AI post-step settings (Settings → Models). Default ON / haiku.
  groundingCheck: boolean // run the anti-hallucination grounding check after AI writes
  groundingCheckModel: string // model alias for that audit (haiku/sonnet/opus)
  autoLearn: boolean // auto-capture durable facts into memory/knowledge after runs
  autoLearnModel: string // model alias for that reflection
  defaultSkill: string // skill auto-selected on the Launch QC Run page ('' = no default)
}

export interface RunSummary {
  id: string
  projectId: string
  projectName: string | null // joined from projects for display
  ticketId: string
  appUrl: string
  slug: string | null // testing/<slug> folder name once known
  status: RunStatus
  passCount: number
  failCount: number
  totalAcs: number
  createdAt: string // ISO
  finishedAt: string | null
}

export interface RunDetail extends RunSummary {
  reportMd: string | null // raw testing/<slug>/report.md
  issuesMd: string | null // raw testing/<slug>/issues.md
  screenshots: string[] // relative paths under the run folder, e.g. "screenshots/ac1-list.png"
  logTail: LogEvent[] // last N events (full stream is over WS while running)
  hasSession: boolean // the Claude session is still resumable for a follow-up chat
}

// ---- live stream events (server -> web over WebSocket) ----

export type Phase =
  | 'intake'
  | 'plan'
  | 'setup'
  | 'collect'
  | 'analyze'
  | 'aggregate'
  | 'report'
  | 'unknown'

export interface LogEvent {
  ts: string // ISO
  kind: 'text' | 'tool' | 'tool_result' | 'phase' | 'system' | 'error' | 'done'
  phase?: Phase
  text: string // human-readable line for the log panel
  tool?: string // tool name when kind === 'tool'
}

export interface StreamMessage {
  runId: string
  event: LogEvent
}

// ---- request bodies ----

export interface CreateRunBody {
  projectId: string
  ticketId: string
  appUrl: string
  skill?: string // which .claude/skills/<name> to drive (defaults to qc-testing)
  instructions?: string // free-form notes from the QC engineer, fed to the AI
  model?: string // Claude model alias (haiku/sonnet/opus); omitted = Claude's configured default
  // where to run: desktop browser (default), the web app on a mobile device, or a
  // native app already installed on a mobile device — both mobile modes via Mobile MCP
  testTarget?: 'web' | 'web-mobile' | 'app-mobile'
  // Advanced mode: a single run that covers a connected feature spanning several
  // tickets. `ticketId` is the lead ticket; `relatedTickets` are the rest, and
  // `workflowSteps` is the ordered end-to-end flow Claude should exercise.
  relatedTickets?: string[]
  workflowSteps?: string[]
}

export interface CreateProjectBody {
  name: string
  rootPath: string
}

// ---- skills ----

export interface SkillFile {
  name: string // file name, e.g. "SKILL.md"
  content: string
}

export interface SkillSummary {
  name: string // folder name / skill name
  description: string // from SKILL.md frontmatter
  files: string[] // file names in the skill folder
}

// ---- mcp ----

export interface McpServer {
  name: string
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
  source: 'project' | 'local' | 'user' | 'cli'
  status?: 'connected' | 'needs-auth' | 'pending' | 'failed' | 'unknown'
}
