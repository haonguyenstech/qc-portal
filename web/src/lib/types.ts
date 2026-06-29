export type RunStatus = 'queued' | 'running' | 'paused' | 'passed' | 'failed' | 'error' | 'canceled'
export interface Project { id: string; name: string; rootPath: string; isDefault: boolean; pinned?: boolean; createdAt: string; description?: string; diagram?: string; exists?: boolean; hasSkills?: boolean; hasMcp?: boolean; hasClaudeMd?: boolean; sourceRepoUrl?: string; sourceProvider?: string; sourceBranch?: string; sourcePath?: string; sourceLastSync?: string; sourceLastCommit?: string; groundingCheck?: boolean; groundingCheckModel?: string; autoLearn?: boolean; autoLearnModel?: string }
export interface RunSummary { id: string; projectId: string; projectName: string | null; ticketId: string; appUrl: string; slug: string | null; status: RunStatus; passCount: number; failCount: number; totalAcs: number; createdAt: string; finishedAt: string | null }
export type Phase = 'intake'|'plan'|'setup'|'collect'|'analyze'|'aggregate'|'report'|'unknown'
export interface LogEvent { ts: string; kind: 'text'|'tool'|'tool_result'|'phase'|'system'|'error'|'done'; phase?: Phase; text: string; tool?: string }
export interface RunDetail extends RunSummary { reportMd: string | null; issuesMd: string | null; screenshots: string[]; logTail: LogEvent[]; hasSession?: boolean }
export interface StreamMessage { runId: string; event: LogEvent }
export interface SkillSummary { name: string; description: string; files: string[] }
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
