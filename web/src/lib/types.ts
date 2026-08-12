export type RunStatus = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error' | 'canceled'
export interface Project { id: string; name: string; rootPath: string; isDefault: boolean; pinned?: boolean; createdAt: string; description?: string; diagram?: string; exists?: boolean; hasSkills?: boolean; hasMcp?: boolean; hasClaudeMd?: boolean; sourceRepoUrl?: string; sourceProvider?: string; sourceBranch?: string; sourcePath?: string; sourceLastSync?: string; sourceLastCommit?: string; groundingCheck?: boolean; groundingCheckModel?: string; autoLearn?: boolean; autoLearnModel?: string; defaultSkill?: string; persistentBrowser?: boolean }
/** Where a run drove the product under test (desktop browser / device browser / native app). */
export type TestTarget = 'web' | 'web-mobile' | 'app-mobile'
/** What a run tested: one ticket's acceptance criteria, or an end-to-end flow (no ticket — `ticketId` is the flow name's slug). */
export type RunKind = 'ticket' | 'flow'
export interface RunSummary { id: string; projectId: string; projectName: string | null; ticketId: string; appUrl: string; testTarget: TestTarget; kind?: RunKind; slug: string | null; outDirToken?: string | null; status: RunStatus; passCount: number; failCount: number; blockedCount: number; untestedCount: number; cancelledCount: number; totalAcs: number; createdAt: string; finishedAt: string | null }
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
