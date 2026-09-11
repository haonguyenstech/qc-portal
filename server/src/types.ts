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
  // Identity that survives a rename or a move, so AI Sync / import can tell "the same
  // project, on another machine" from "a different project that happens to be called
  // the same thing". Generated lazily; copied onto the guest's project by the first
  // sync, which is what makes the SECOND sync an update instead of a duplicate.
  syncKey: string
}

/** Where a run drives the product under test. */
export type TestTarget = 'web' | 'web-mobile' | 'app-mobile'

/** What a run tests: one ticket's acceptance criteria, or an end-to-end flow. */
export type RunKind = 'ticket' | 'flow'

/**
 * What a run is allowed to do to the data on the environment under test.
 *
 * `readonly` — never commit a mutating action: drive up to the enable-state and stop.
 * The historical (and still default) behavior.
 *
 * `seed` — the engineer authorizes the run to CREATE the test data a case needs (and
 * edit/clean up what it created itself). Still never destructive to data it didn't
 * create. This exists because a read-only run has to mark every "do X, then check the
 * result" case Blocked, which is why the same suite driven by hand in `/chat` — where
 * the engineer simply says "create an appointment and check the notification" — grades
 * far more cases than the same suite on `/qc-run`.
 */
export type RunDataPolicy = 'readonly' | 'seed'

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
  // What the run may do to the environment's data. Omitted = 'readonly' (the previous
  // behavior); 'seed' means the engineer authorized this run to create the data its
  // cases need instead of marking them Blocked. See RunDataPolicy.
  dataPolicy?: RunDataPolicy
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

// ---- system report (/reports) ----------------------------------------------
// The QC status picture for one project: ticket -> test cases -> run -> defects,
// joined server-side by `reportData.ts`. Mirrored verbatim in web/src/lib/types.ts.

/** Where a ticket has stopped in the delivery chain. */
export type TicketStage = 'crawled' | 'planned' | 'partial' | 'defects' | 'clean'

export interface ExecCounts {
  pass: number
  fail: number
  blocked: number
  untested: number
  cancelled: number
  total: number
}

export interface ReportDefect {
  id: string
  title: string
  severity: 'critical' | 'high' | 'medium' | 'low' | 'unknown'
  runId: string
  runSlug: string | null
  /** The ticket FOLDER this defect's run was for, or null for a flow run. */
  ticketKey: string | null
  at: string
  /** The skill's "Affected cases:" line, verbatim, when it wrote one. */
  affects: string
}

export interface ReportRunRow {
  id: string
  ticketId: string
  ticketFolder: string | null
  ticketTitle: string | null
  kind: RunKind
  testTarget: TestTarget
  appUrl: string
  status: RunStatus
  slug: string | null
  hasReport: boolean
  exec: ExecCounts
  defectCount: number
  createdAt: string
  finishedAt: string | null
  durationMs: number | null
}

export interface ReportTicketRow {
  folder: string
  parent: string | null
  displayId: string
  title: string
  url: string | null
  status: string
  priority: string
  assignees: string[]
  tags: string[]
  listName: string
  dueDate: string | null
  dateUpdated: string | null
  crawledAt: string | null
  /** The tracker moved after our snapshot — the evidence below predates it. */
  stale: boolean
  commentCount: number
  attachmentCount: number
  hasSummary: boolean
  hasActivity: boolean
  testcaseVersions: number
  latestTestcaseFile: string | null
  testcaseCount: number
  runIds: string[]
  runCount: number
  lastRunAt: string | null
  lastRunStatus: RunStatus | null
  /** The latest run that produced a report.md — the one `exec` describes. */
  latestReportRunId: string | null
  latestReportAt: string | null
  /** The LATEST reporting run's outcome, never a sum across re-runs. */
  exec: ExecCounts
  defectCount: number
  defectsBySeverity: Record<string, number>
  stage: TicketStage
  /** pass / (pass + fail), or null when nothing was judged either way. */
  passRate: number | null
  /** (pass + fail) / testcaseCount, capped at 1; null with no test-case file. */
  coverage: number | null
}

export interface ReportRecurringDefect {
  title: string
  severity: ReportDefect['severity']
  occurrences: number
  runIds: string[]
  tickets: string[]
  firstSeen: string
  lastSeen: string
}

export interface SystemReport {
  projectId: string
  projectName: string
  rootPath: string
  generatedAt: string
  range: { from: string | null; to: string | null }
  warnings: string[]
  funnel: { tickets: number; planned: number; executed: number; clean: number }
  totals: {
    tickets: number
    subtasks: number
    staleTickets: number
    testcases: number
    runs: number
    flowRuns: number
    runsFailed: number
    /** Open now: the latest reporting run's defects, per ticket. */
    defects: number
    /** Every defect ever recorded across every run — the recurrence input. */
    defectsAllTime: number
    recurringDefects: number
    exec: ExecCounts
    passRate: number | null
    designChecks: number
    designMismatches: number
  }
  statusBuckets: { status: string; count: number }[]
  defectsBySeverity: Record<string, number>
  tickets: ReportTicketRow[]
  runs: ReportRunRow[]
  defects: ReportDefect[]
  recurring: ReportRecurringDefect[]
  designChecks: {
    id: string
    folder: string
    figmaUrl: string
    counts: { match: number; mismatch: number; concern: number; unsure: number; discuss: number; total: number }
    createdAt: string
  }[]
}
