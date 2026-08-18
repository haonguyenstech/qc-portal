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
  persistentBrowser: boolean // drive the portal-owned QC browser over CDP (survives Stop)
}

/** Where a run drives the product under test. */
export type TestTarget = 'web' | 'web-mobile' | 'app-mobile'

/** What a run tests: one ticket's acceptance criteria, or an end-to-end flow. */
export type RunKind = 'ticket' | 'flow'

export interface RunSummary {
  id: string
  projectId: string
  projectName: string | null // joined from projects for display
  ticketId: string
  appUrl: string
  // Which surface this run tested, so History can label it. Runs recorded before
  // this was persisted fall back to a best guess (see db.rowToSummary).
  testTarget: TestTarget
  /**
   * What this run WAS: a single-ticket acceptance test, or an E2E flow — which
   * has no ticket, and whose `ticketId` is the flow name's slug. Without it the
   * two are indistinguishable on Running/History, where a flow's slug sits in
   * the ticket column looking like a ticket id. Rows written before this read
   * as 'ticket'.
   */
  kind: RunKind
  /**
   * Web runs only: whether this run drove the browser with NO visible window
   * (the per-run checkbox on `/qc-run`). Stored so a paused run resumes in the
   * same mode — otherwise a resume silently fell back to the project's default
   * and popped a window mid-sweep. NULL/undefined = the project's own `.mcp.json`
   * setting decided, which is every run recorded before this landed.
   */
  headless?: boolean
  slug: string | null // testing/<slug> folder name once known
  /**
   * The unique token the portal required at the END of this run's output folder
   * name, so the folder belongs to THIS run and nothing else. Two runs of the same
   * ticket (the classic case: one on web, then one on a device) used to agree on a
   * model-invented folder name and the second silently overwrote the first's
   * report, issues and screenshots. NULL = a row from before this landed, which
   * still resolves its folder by ticket prefix.
   */
  outDirToken: string | null
  status: RunStatus
  passCount: number
  failCount: number
  blockedCount: number
  untestedCount: number
  cancelledCount: number
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
  // native app already installed on a mobile device — both mobile modes via Maestro MCP
  testTarget?: TestTarget
  // Mobile targets only: the Maestro `device_id` (UDID / adb serial / "chromium") the
  // run must drive, picked in the Run form when several devices are booted. Omitted =
  // let the run pick whatever `list_devices` reports first, the previous behavior.
  deviceId?: string
  // 'flow' = an E2E flow: there is NO ticket, and `ticketId` is only the flow
  // name's slug (the run files its report under it). Sent by the client rather
  // than inferred, so the prompt never sends the model looking for a ticket
  // folder that doesn't exist. Omitted = 'ticket', the previous behavior.
  kind?: RunKind
  // Web target only: run the browser with no visible window. Omitted = whatever the
  // project's .mcp.json says (the previous behavior); true/false overrides it for THIS
  // run only, via a per-run MCP config (see playwrightRunMode.ts).
  headless?: boolean
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

/**
 * How a project's copy of a portal-bundled skill compares to the bundled master:
 * - `in-sync`           — identical, nothing to do
 * - `update-available`  — the portal ships a newer version and this copy is untouched
 * - `customized`        — hand-edited (or predates fingerprinting), so it's never
 *                         overwritten automatically; the UI offers the update
 * - `missing`           — the project has no copy of this skill
 */
export interface SkillSyncStatus {
  skill: string
  state: 'in-sync' | 'update-available' | 'customized' | 'missing'
}

export interface SkillSummary {
  name: string // folder name / skill name
  description: string // from SKILL.md frontmatter
  files: string[] // file names in the skill folder
  // Present only for skills bundled with the portal (today: qc-testing).
  sync?: SkillSyncStatus['state']
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
