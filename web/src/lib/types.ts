export type RunStatus = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error' | 'canceled'
export interface Project { id: string; name: string; rootPath: string; isDefault: boolean; pinned?: boolean; createdAt: string; description?: string; diagram?: string; exists?: boolean; hasSkills?: boolean; hasMcp?: boolean; hasClaudeMd?: boolean; sourceRepoUrl?: string; sourceProvider?: string; sourceBranch?: string; sourcePath?: string; sourceLastSync?: string; sourceLastCommit?: string; groundingCheck?: boolean; groundingCheckModel?: string; autoLearn?: boolean; autoLearnModel?: string; defaultSkill?: string; persistentBrowser?: boolean; syncKey?: string }
/** Where a run drove the product under test (desktop browser / device browser / native app). */
export type TestTarget = 'web' | 'web-mobile' | 'app-mobile'
/** What a run tested: one ticket's acceptance criteria, or an end-to-end flow (no ticket — `ticketId` is the flow name's slug). */
export type RunKind = 'ticket' | 'flow'
export interface RunSummary { id: string; projectId: string; projectName: string | null; ticketId: string; appUrl: string; testTarget: TestTarget; kind?: RunKind; headless?: boolean; slug: string | null; outDirToken?: string | null; status: RunStatus; passCount: number; failCount: number; blockedCount: number; untestedCount: number; cancelledCount: number; totalAcs: number; createdAt: string; finishedAt: string | null }
export type Phase = 'intake'|'plan'|'setup'|'collect'|'analyze'|'aggregate'|'report'|'unknown'
export interface LogEvent { ts: string; kind: 'text'|'tool'|'tool_result'|'phase'|'system'|'error'|'done'; phase?: Phase; text: string; tool?: string }
export interface RunDetail extends RunSummary { reportMd: string | null; issuesMd: string | null; screenshots: string[]; logTail: LogEvent[]; hasSession?: boolean }
export interface StreamMessage { runId: string; event: LogEvent }
/** How a project's copy of a portal-bundled skill compares to the portal's own version. */
export type SkillSyncState = 'in-sync' | 'update-available' | 'customized' | 'missing'
export interface SkillSummary { name: string; description: string; files: string[]; sync?: SkillSyncState }
export interface SkillFile { name: string; content: string }
export interface McpServer { name: string; command?: string; args?: string[]; url?: string; type?: string; env?: Record<string, string>; source: string; status?: string }

export interface ClaudeModelInfo {
  id: string
  label: string
  description: string
}

export interface ClaudeStatus {
  installed: boolean
  binary: string
  version: string | null
  installCommand: string
  models: ClaudeModelInfo[]
  error: string | null
}

export interface ClaudeModelTestResult {
  ok: boolean
  model: string
  durationMs: number
  costUsd: number | null
  detail: string
}

/**
 * The QC browser — the portal-owned browser window Playwright MCP attaches to over
 * CDP. It stays open when a turn is stopped, which is the whole point: a stdio MCP's
 * browser dies with the `claude` process that spawned it.
 */
export interface QcBrowserStatus {
  running: boolean
  endpoint: string
  version?: string
  /** True when this portal process launched it, so Stop can close it. */
  startedHere: boolean
  pid?: number
  profileDir: string
  /** Channels actually installed on the server machine. */
  available: ('msedge' | 'chrome')[]
  /** Present on a failed start. */
  error?: string
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

// ---- Responsive testing (/responsive) ----
//
// The wire shapes of `server/src/responsiveCapture.ts` + `responsiveJobs.ts`. The
// device catalog itself is NOT here — it lives in `lib/responsiveDevices.ts`,
// which is the one list both the picker and the capture request read.

export interface ResponsiveDeviceSpec {
  id: string
  label: string
  width: number
  height: number
  dpr: number
  platform: 'ios' | 'android' | 'desktop'
}

export type ResponsiveSeverity = 'high' | 'medium' | 'low'

export interface ResponsiveFindingSample {
  selector: string
  text: string
  rect: { x: number; y: number; width: number; height: number }
}

export interface ResponsiveFinding {
  kind:
    | 'no-viewport-meta'
    | 'zoom-disabled'
    | 'horizontal-overflow'
    | 'wide-element'
    | 'small-tap-target'
    | 'tiny-text'
    | 'clipped-text'
    | 'fixed-overlay'
    | 'oversized-image'
  severity: ResponsiveSeverity
  title: string
  detail: string
  count: number
  samples: ResponsiveFindingSample[]
}

export interface ResponsiveDeviceCapture {
  device: ResponsiveDeviceSpec
  screenshot: string | null
  documentHeight: number
  scrollWidth: number
  title: string
  finalUrl: string
  viewportMeta: string | null
  findings: ResponsiveFinding[]
  jsErrors: string[]
  loadMs: number
  error: string | null
}

export interface ResponsiveCaptureResult {
  url: string
  redirected: boolean
  finalUrl: string
  capturedAt: string
  captures: ResponsiveDeviceCapture[]
}

export interface ResponsiveJob {
  id: string
  projectId: string
  label: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  progress: string
  logs: { time: string; level: 'info' | 'success' | 'error'; text: string }[]
  config: {
    url: string
    devices: ResponsiveDeviceSpec[]
    fullPage: boolean
    useProfile: boolean
    waitMs: number
  }
  result: ResponsiveCaptureResult | null
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ResponsiveUrlProbe {
  ok: boolean
  status: number
  finalUrl: string
  framable: boolean
  frameBlockedBy: string | null
  viewportMeta: string | null
  error: string | null
}

// ---- Scheduled tasks (/scheduled) ----
//
// `description` and `nextRunAt` are computed SERVER-SIDE (server/src/cron.ts) and arrive
// with every row on purpose: the browser has no cron parser, so the sentence under a task
// and the timer that fires it cannot drift apart.
export type ScheduleMode = 'read' | 'write' | 'full'
export type ScheduleStatus = 'ok' | 'error' | 'running'
export interface Schedule {
  id: string
  projectId: string
  title: string
  prompt: string
  cron: string
  /** "Every weekday at 9:00 AM" — the human reading of `cron`. */
  description: string
  mode: ScheduleMode
  model: string
  effort: string
  enabled: boolean
  createdAt: string
  updatedAt: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: ScheduleStatus | null
  runCount: number
  /** True while its claude is actually working right now. */
  running: boolean
}
export interface ScheduleRun {
  id: string
  scheduleId: string
  projectId: string
  /** The task's title when this run fired — renaming the task never rewrites history. */
  title: string
  trigger: 'schedule' | 'manual'
  status: ScheduleStatus
  answer: string
  error: string | null
  costUsd: number
  startedAt: string
  finishedAt: string | null
}
/** What `/parse` returns: a schedule proposed, never stored — the engineer confirms it. */
export interface ScheduleDraft {
  title: string
  prompt: string
  cron: string
  description: string
  nextRunAt: string | null
}

// ---------------------------------------------------------------- AI Sync
// Mirrors server/src/aiSync.ts + syncJobs.ts. See docs/architecture/ai-sync.md.

/** A machine, as the other side sees it. Named by hostname, disambiguated by LAN IP. */
export interface MachineIdentity { id: string; name: string; platform: string; ip: string }

/** One tickable slice of a project. The catalog is served by GET /api/sync/groups. */
export interface SyncGroupDef {
  key: string
  label: string
  description: string
  entries: string[]
  heavy?: boolean
}

export type ShareState = 'waiting' | 'paired' | 'syncing' | 'done' | 'error' | 'revoked'

/** How far the guest has got, pushed up to the host so both sides show one truth. */
export interface SharePeerProgress {
  phase: string
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  message: string
}

/** The host's view of its own open share — includes the 4-digit code, since it owns it. */
export interface SyncShare {
  id: string
  projectId: string
  projectName: string
  code: string
  state: ShareState
  offeredGroups: string[]
  includeMcpSecrets: boolean
  expiresAt: string
  failures: number
  maxFailures: number
  host: MachineIdentity
  peer: (MachineIdentity & { pairedAt: string }) | null
  progress: SharePeerProgress | null
  filesServed: number
  bytesServed: number
  totalBytes: number
  filesTotal: number
  summary: string
  error: string | null
  finishedAt: string | null
}

export interface SyncShareStatus {
  share: SyncShare | null
  self: MachineIdentity
  /** The public URL to hand over, or null when no tunnel is running. */
  endpoint: string | null
  tunnelState: string
  tunnelInstalled: boolean
  hasAccessPassword: boolean
}

export type SyncJobStatus = 'pairing' | 'ready' | 'running' | 'done' | 'error' | 'cancelled'

export interface SyncLogLine { time: string; level: 'info' | 'success' | 'error'; text: string }

/** A local project the incoming one appears to BE. `syncKey` is certain, `name` a guess. */
export interface SyncMatch {
  projectId: string
  name: string
  rootPath: string
  by: 'syncKey' | 'name'
}

export type SyncTarget =
  | { mode: 'existing'; projectId: string }
  | { mode: 'new'; name: string; parentPath: string }

export interface SyncProgress {
  phase: 'pairing' | 'manifest' | 'compare' | 'transfer' | 'summary' | 'finished'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  message: string
}

/** The guest's pull job. The bearer token stays on the server and is never in here. */
export interface SyncJob {
  id: string
  status: SyncJobStatus
  endpoint: string
  host: MachineIdentity | null
  self: MachineIdentity
  remoteProjectName: string
  remoteSyncKey: string
  offeredGroups: string[]
  mcpScrubbed: boolean
  match: SyncMatch | null
  target: SyncTarget | null
  projectId: string | null
  projectName: string
  rootPath: string
  groups: string[]
  plan: {
    newCount: number
    changedCount: number
    sameCount: number
    transferBytes: number
    byGroup: { group: string; files: number; bytes: number }[]
  } | null
  progress: SyncProgress
  logs: SyncLogLine[]
  summary: string
  failures: string[]
  error: string | null
  createdAt: string
  updatedAt: string
}

/** What GET /api/projects/import/check answers, so a duplicate is caught before the upload. */
export interface ImportCheck {
  dest: string
  parentExists: boolean
  folderExists: boolean
  project: { id: string; name: string; rootPath: string } | null
  nameTaken: { id: string; name: string; rootPath: string } | null
  suggestedName: string
}
