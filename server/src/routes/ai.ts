import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import spawn from 'cross-spawn'
import { CLAUDE_BIN, ticketsDirFor } from '../config.js'
import {
  clickupConfigured,
  getDocContent,
  getTaskDetail,
  resolveProjectClickupToken,
  withClickupToken,
} from '../clickup.js'
import { parseClaudeUsage } from '../claudeExec.js'
import { insertDesignCheck, listDesignChecks, recordUsage } from '../db.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import {
  deleteTestcaseVersion,
  editTestcaseCell,
  generateTestcaseVersion,
  listTestcaseVersions,
} from '../testcaseGen.js'
import {
  cancelTestcaseJob,
  getTestcaseJob,
  listTestcaseJobs,
  pauseTestcaseJob,
  resumeTestcaseJob,
  startTestcaseJob,
} from '../testcaseJobs.js'
import { verifyDesign } from '../verifyDesign.js'
import { cancelVerifyJob, getVerifyJob, listVerifyJobs, startVerifyJob } from '../verifyJobs.js'

export const aiRouter = Router()

const MAX_DOC_CHARS = 40_000
const MAX_TOTAL_CHARS = 60_000 // combined cap across all selected sources
const MAX_PER_SOURCE_CHARS = 24_000
const MAX_JOB_FOLDERS = 20 // hard server-side ceiling on tickets per generation job

function overviewPrompt(docName: string, content: string, projectName: string): string {
  return `You are documenting the software project "${projectName}" for QC (acceptance testing) engineers.

Below is the content of a ClickUp document titled "${docName}". Read it and write a clear, concise PROJECT OVERVIEW in GitHub-flavored Markdown that helps a QC engineer understand the project before testing it.

Structure (include a section only if the document supports it):
- A short opening paragraph: what the project/app is and who it is for.
- "## Key areas" — the main features or flows to focus on when testing.
- "## Known issues / caveats" — anything to watch out for or skip.
- "## Notes" — links, environments, credentials hints, or other useful context.

Rules:
- Base everything ONLY on the document. Do not invent features or details.
- Be concise and scannable. Prefer short paragraphs and bullet lists.
- Output ONLY the Markdown overview itself — no preamble, no surrounding code fence.

--- DOCUMENT START ---
${content}
--- DOCUMENT END ---`
}

function overviewFromSourcesPrompt(
  content: string,
  projectName: string,
  opts: { instructions: string; mode: 'replace' | 'update'; existing: string },
): string {
  const extra = opts.instructions.trim()
  const existing = opts.existing.trim()
  const isUpdate = opts.mode === 'update' && !!existing

  const task = isUpdate
    ? `Below is the project's CURRENT overview, followed by one or more ClickUp sources. UPDATE the current overview using the new sources: keep what is still accurate, revise what changed, and add what's missing. Preserve the author's structure and useful hand-written notes where they don't conflict with the sources. Return the COMPLETE updated overview (not just the changes).`
    : `Below are one or more ClickUp sources — documents and/or tickets — describing the project. Read them ALL and synthesize a single clear, concise PROJECT OVERVIEW in GitHub-flavored Markdown that helps a QC engineer understand the project before testing it.`

  return `You are documenting the software project "${projectName}" for QC (acceptance testing) engineers.

${task}
${
  extra
    ? `\nADDITIONAL INSTRUCTIONS FROM THE USER (follow these closely):\n${extra}\n`
    : ''
}
Structure (include a section only if the content supports it):
- A short opening paragraph: what the project/app is and who it is for.
- "## Key areas" — the main features or flows to focus on when testing.
- "## Known issues / caveats" — anything to watch out for or skip.
- "## Notes" — links, environments, credentials hints, or other useful context.

Rules:
- Base everything ONLY on the provided sources${isUpdate ? ' and current overview' : ''}. Do not invent features or details.
- Merge overlapping information; do not just list each source separately.
- Be concise and scannable. Prefer short paragraphs and bullet lists.
- Output ONLY the Markdown overview itself — no preamble, no surrounding code fence.
${
  isUpdate
    ? `\n--- CURRENT OVERVIEW START ---\n${existing}\n--- CURRENT OVERVIEW END ---\n`
    : ''
}
--- SOURCES START ---
${content}
--- SOURCES END ---`
}

function capPerSource(text: string): string {
  return text.length > MAX_PER_SOURCE_CHARS
    ? `${text.slice(0, MAX_PER_SOURCE_CHARS)}\n…(truncated)`
    : text
}

function diagramPrompt(content: string, projectName: string, instructions: string): string {
  const extra = instructions.trim()
  return `You are a software architect documenting the project "${projectName}" for QC (acceptance testing) engineers.

Below are one or more ClickUp sources — tickets and/or documents — describing the project. Read them ALL and produce a SINGLE Mermaid diagram that visualizes the project: its main features / areas, the user flows, and how the things described across the tickets relate to each other.
${
  extra
    ? `\nADDITIONAL INSTRUCTIONS FROM THE USER (follow these closely, they take priority where not in conflict with the strict syntax rules):\n${extra}\n`
    : ''
}
Requirements:
- Output a Mermaid "flowchart TD" (top-down) diagram.
- Use subgraphs to group related features/areas when it aids understanding.
- Derive nodes from the ACTUAL features, screens, and flows mentioned in the sources — do not invent unrelated parts.
- Aim for clarity: roughly 6–24 nodes. Connect them with meaningful edges; add short edge labels where they add meaning.
- Node text must be short and human-readable.

Strict syntax rules (so the diagram renders):
- Use ONLY valid Mermaid flowchart syntax.
- Keep node labels alphanumeric with spaces only. Do NOT put parentheses (), brackets [], braces {}, quotes, colons, or other special characters INSIDE node label text.
- Give every node a simple alphanumeric id (e.g. A1, Login, Cart).

Output rules:
- Base everything ONLY on the provided sources.
- Output ONLY the Mermaid diagram code, starting directly with "flowchart TD".
- NO preamble, NO explanation, and NO surrounding markdown code fence.

--- SOURCES START ---
${content}
--- SOURCES END ---`
}

/** Strip a leading ```mermaid / ``` fence and trailing ``` if the model adds one. */
function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:mermaid)?[ \t]*\r?\n?/i, '')
    .replace(/\r?\n?```$/i, '')
    .trim()
}

/**
 * Build a human-readable reason from a failed `claude -p --output-format json` run,
 * preferring the model/CLI message + subtype, then stderr, then the raw output.
 * Also logs the failure server-side so it shows in the dev terminal.
 */
function claudeFailureReason(
  label: string,
  result: { code: number | null; stderr: string },
  raw: string,
  parsed: { result?: string; is_error?: boolean; subtype?: string },
): string {
  const msg = (parsed.result ?? '').trim()
  const sub = (parsed.subtype ?? '').trim()
  const reason =
    (msg ? (sub ? `${msg} (${sub})` : msg) : '') ||
    result.stderr.trim().slice(0, 400) ||
    raw.slice(0, 400) ||
    'Claude returned an error.'
  console.error(`[ai/${label}] claude failed:`, {
    code: result.code,
    subtype: sub || undefined,
    reason: reason.slice(0, 200),
  })
  return reason
}

/**
 * Read the selected ClickUp docs + tickets and return them concatenated into one
 * string (per-source capped). Throws { status } on a ClickUp/config error. Shared
 * by the overview and diagram generators.
 */
async function collectClickupSources(
  cuToken: string | undefined,
  team: string,
  docs: { id: string; name: string }[],
  tickets: string[],
): Promise<string> {
  let combined = ''
  await withClickupToken(cuToken, async () => {
    if (!clickupConfigured()) {
      throw Object.assign(new Error('ClickUp is not configured'), { status: 400 })
    }
    for (const d of docs) {
      const content = (await getDocContent(team, d.id)).trim()
      if (content) combined += `=== DOCUMENT: ${d.name} ===\n${capPerSource(content)}\n\n`
    }
    for (const id of tickets) {
      const detail = await getTaskDetail(id)
      const head = `Status: ${detail.status || 'n/a'}${
        detail.priority ? `, Priority: ${detail.priority}` : ''
      }`
      const body = [head, '', detail.description || '(no description)'].join('\n')
      combined += `=== TICKET ${detail.displayId} — ${detail.name} ===\n${capPerSource(body)}\n\n`
    }
  })
  return combined.trim()
}

/** Parse the { team, docs, tickets, projectName } body shared by source generators. */
function parseSourcesBody(body: unknown): {
  team: string
  docs: { id: string; name: string }[]
  tickets: string[]
  projectName: string
} {
  const b = (body ?? {}) as Record<string, unknown>
  const team = typeof b.team === 'string' ? b.team.trim() : ''
  const docs: { id: string; name: string }[] = Array.isArray(b.docs)
    ? b.docs
        .map((d: unknown) => {
          const o = (d ?? {}) as { id?: unknown; name?: unknown }
          return { id: String(o.id ?? '').trim(), name: String(o.name ?? 'ClickUp document') }
        })
        .filter((d: { id: string }) => d.id)
    : []
  const tickets: string[] = Array.isArray(b.tickets)
    ? b.tickets
        .map((t: unknown) => {
          const o = (t ?? {}) as { id?: unknown }
          return String(o.id ?? (typeof t === 'string' ? t : '')).trim()
        })
        .filter((id: string) => id)
    : []
  const projectName =
    typeof b.projectName === 'string' && b.projectName.trim() ? b.projectName.trim() : 'this project'
  return { team, docs, tickets, projectName }
}

const CLAUDE_MODELS = [
  {
    id: 'haiku',
    label: 'Haiku',
    description:
      'Fast option for low-risk work: quick status checks, short summaries, simple copy edits, small config changes, and lightweight validation.',
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description:
      'Default for most work: QC runs, feature implementation, bug fixes, focused code review, and balanced speed/quality.',
  },
  {
    id: 'opus',
    label: 'Opus',
    description:
      'Use when mistakes are expensive: architecture decisions, hard debugging, risky refactors, security-sensitive review, and large cross-file changes.',
  },
] as const

function runCommand(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(CLAUDE_BIN, args, {
      env: { ...process.env },
      windowsHide: true, // no cmd window flash on Windows
    })
    const timer = setTimeout(() => {
      settled = true
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)

    child.stdout?.on('data', (d) => (stdout += String(d)))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: err.message, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

function parseVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+(?:[-\w.]*)?/)
  return match?.[0] ?? null
}

aiRouter.get('/claude/status', async (_req, res) => {
  const result = await runCommand(['--version'], 8000)
  const installed = result.code === 0
  res.json({
    installed,
    binary: CLAUDE_BIN,
    version: installed ? parseVersion(result.stdout || result.stderr) : null,
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    models: CLAUDE_MODELS,
    error: installed ? null : (result.stderr || result.stdout || 'Claude Code CLI not found.').trim(),
  })
})

// Real Claude subscription usage, read live from Claude Code's own `/usage` (run
// headlessly via `claude -p "/usage"`). Parsed into { label, percent, reset } per
// limit window. Cached briefly so UI polling doesn't spawn a process every time.
interface UsageLine {
  label: string
  percent: number
  reset: string
}

function parseUsageText(text: string): { windows: UsageLine[]; details: string } {
  const windows: UsageLine[] = []
  for (const line of text.split('\n')) {
    const m = /^(.+?):\s*(\d+)%\s*used\s*·\s*resets\s*(.+?)\s*$/.exec(line.trim())
    if (m) windows.push({ label: m[1].trim(), percent: Number(m[2]), reset: m[3].trim() })
  }
  // Everything after the limit lines is the "what's contributing" breakdown.
  const idx = text.indexOf("What's contributing")
  const details = idx >= 0 ? text.slice(idx).trim() : ''
  return { windows, details }
}

let usageCache: { at: number; payload: unknown } | null = null
const USAGE_TTL_MS = 60_000

aiRouter.get('/usage', async (_req, res) => {
  if (usageCache && Date.now() - usageCache.at < USAGE_TTL_MS) {
    return res.json(usageCache.payload)
  }
  const result = await runCommand(['-p', '/usage', '--output-format', 'json'], 30000)
  const raw = (result.stdout || result.stderr).trim()
  let text = ''
  try {
    text = String((JSON.parse(raw) as { result?: string }).result ?? '')
  } catch {
    /* non-json CLI error */
  }
  const parsed = parseUsageText(text)
  const payload = {
    available: parsed.windows.length > 0,
    windows: parsed.windows,
    details: parsed.details,
    raw: text,
    error:
      parsed.windows.length > 0
        ? null
        : result.timedOut
          ? 'Timed out reading Claude usage.'
          : 'Could not read Claude usage. Make sure you are signed in with a Claude subscription.',
    generatedAt: new Date().toISOString(),
  }
  usageCache = { at: Date.now(), payload }
  res.json(payload)
})

aiRouter.post('/claude/test', async (req, res) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : ''
  if (!CLAUDE_MODELS.some((m) => m.id === model)) {
    return res.status(400).json({ error: 'unknown model alias' })
  }

  const started = Date.now()
  const result = await runCommand(
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.20',
      'Reply exactly: OK',
    ],
    60000,
  )
  const durationMs = Date.now() - started
  const raw = (result.stdout || result.stderr).trim()
  let parsed: { result?: string; is_error?: boolean; total_cost_usd?: number; modelUsage?: unknown } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* non-json CLI error */
  }
  const ok = result.code === 0 && !parsed.is_error && /OK/i.test(parsed.result ?? raw)
  const usage = parseClaudeUsage(raw)
  if (usage) recordUsage({ source: 'model-test', model, ...usage })
  res.json({
    ok,
    model,
    durationMs,
    costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
    detail: result.timedOut
      ? 'Timed out while testing the model.'
      : ok
        ? 'Model responded.'
        : raw || 'Model test failed.',
  })
})

/**
 * Read a ClickUp doc and have Claude turn it into a project overview (markdown).
 * Does not save — the UI drops the result into the editor for the user to review
 * and save. Body: { team, docId, docName?, projectName? }.
 */
aiRouter.post('/overview-from-doc', async (req, res) => {
  // Use the request project's ClickUp token (from .mcp.json), env as fallback.
  const project = resolveProject(req)
  const cuToken = project ? resolveProjectClickupToken(project.rootPath) : undefined

  const team = typeof req.body?.team === 'string' ? req.body.team.trim() : ''
  const docId = typeof req.body?.docId === 'string' ? req.body.docId.trim() : ''
  const docName = typeof req.body?.docName === 'string' && req.body.docName.trim() ? req.body.docName.trim() : 'ClickUp document'
  const projectName = typeof req.body?.projectName === 'string' && req.body.projectName.trim() ? req.body.projectName.trim() : 'this project'
  if (!team || !docId) {
    return res.status(400).json({ error: 'team and docId are required' })
  }

  let content: string
  try {
    content = await withClickupToken(cuToken, async () => {
      if (!clickupConfigured()) {
        throw Object.assign(new Error('ClickUp is not configured'), { status: 400 })
      }
      return getDocContent(team, docId)
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    return res.status(status).json({ error: (err as Error).message })
  }
  if (!content) {
    return res.status(422).json({ error: 'The selected document appears to be empty.' })
  }
  const trimmed =
    content.length > MAX_DOC_CHARS ? `${content.slice(0, MAX_DOC_CHARS)}\n\n…(document truncated)` : content

  const result = await runCommand(
    [
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.50',
      overviewPrompt(docName, trimmed, projectName),
    ],
    180000,
  )
  if (result.timedOut) {
    return res.status(504).json({ error: 'Timed out while generating the overview.' })
  }
  const raw = (result.stdout || result.stderr).trim()
  let parsed: { result?: string; is_error?: boolean; subtype?: string } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* non-json CLI error */
  }
  const overview = (parsed.result ?? '').trim()
  if (result.code !== 0 || parsed.is_error || !overview) {
    return res
      .status(502)
      .json({ error: raw.slice(0, 400) || 'Claude did not return an overview.' })
  }
  res.json({ overview, docName })
})

/**
 * Read one or more ClickUp sources — documents AND tickets — and have Claude
 * synthesize a single project overview (markdown). Does not save; the UI drops
 * the result into the editor for review. Body:
 *   { team, docs: [{id,name}], tickets: [{id}], projectName?, projectId? }
 */
aiRouter.post('/overview-from-sources', async (req, res) => {
  const project = resolveProject(req)
  const cuToken = project ? resolveProjectClickupToken(project.rootPath) : undefined

  const team = typeof req.body?.team === 'string' ? req.body.team.trim() : ''
  const docs: { id: string; name: string }[] = Array.isArray(req.body?.docs)
    ? req.body.docs
        .map((d: unknown) => {
          const o = (d ?? {}) as { id?: unknown; name?: unknown }
          return { id: String(o.id ?? '').trim(), name: String(o.name ?? 'ClickUp document') }
        })
        .filter((d: { id: string }) => d.id)
    : []
  const tickets: string[] = Array.isArray(req.body?.tickets)
    ? req.body.tickets
        .map((t: unknown) => {
          const o = (t ?? {}) as { id?: unknown }
          return String(o.id ?? (typeof t === 'string' ? t : '')).trim()
        })
        .filter((id: string) => id)
    : []
  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : 'this project'
  const instructions =
    typeof req.body?.instructions === 'string' ? req.body.instructions.slice(0, 4000) : ''
  const mode: 'replace' | 'update' = req.body?.mode === 'update' ? 'update' : 'replace'
  const existing =
    typeof req.body?.existing === 'string' ? req.body.existing.slice(0, MAX_TOTAL_CHARS) : ''

  if (!team) return res.status(400).json({ error: 'team is required' })
  if (docs.length === 0 && tickets.length === 0) {
    return res.status(400).json({ error: 'select at least one document or ticket' })
  }

  let combined = ''
  try {
    await withClickupToken(cuToken, async () => {
      if (!clickupConfigured()) {
        throw Object.assign(new Error('ClickUp is not configured'), { status: 400 })
      }
      for (const d of docs) {
        const content = (await getDocContent(team, d.id)).trim()
        if (content) combined += `=== DOCUMENT: ${d.name} ===\n${capPerSource(content)}\n\n`
      }
      for (const id of tickets) {
        const detail = await getTaskDetail(id)
        const head = `Status: ${detail.status || 'n/a'}${
          detail.priority ? `, Priority: ${detail.priority}` : ''
        }`
        const body = [head, '', detail.description || '(no description)'].join('\n')
        combined += `=== TICKET ${detail.displayId} — ${detail.name} ===\n${capPerSource(body)}\n\n`
      }
    })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    return res.status(status).json({ error: (err as Error).message })
  }

  combined = combined.trim()
  if (!combined) {
    return res.status(422).json({ error: 'The selected sources appear to be empty.' })
  }
  const trimmed =
    combined.length > MAX_TOTAL_CHARS
      ? `${combined.slice(0, MAX_TOTAL_CHARS)}\n\n…(sources truncated)`
      : combined

  const result = await runCommand(
    [
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.50',
      overviewFromSourcesPrompt(trimmed, projectName, { instructions, mode, existing }),
    ],
    180000,
  )
  if (result.timedOut) {
    return res.status(504).json({ error: 'Timed out while generating the overview.' })
  }
  const raw = (result.stdout || result.stderr).trim()
  let parsed: { result?: string; is_error?: boolean; subtype?: string } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* non-json CLI error */
  }
  const overview = (parsed.result ?? '').trim()
  if (result.code !== 0 || parsed.is_error || !overview) {
    return res.status(502).json({ error: claudeFailureReason('overview', result, raw, parsed) })
  }
  res.json({ overview, sourceCount: docs.length + tickets.length })
})

/**
 * Read one or more ClickUp sources and have Claude render a Mermaid diagram of the
 * project. Does not save; the UI shows the result for review and lets the user save
 * it onto the project. Body: { team, docs:[{id,name}], tickets:[{id}], projectName? }.
 */
aiRouter.post('/diagram-from-sources', async (req, res) => {
  const project = resolveProject(req)
  const cuToken = project ? resolveProjectClickupToken(project.rootPath) : undefined

  const { team, docs, tickets, projectName } = parseSourcesBody(req.body)
  const instructions =
    typeof req.body?.instructions === 'string' ? req.body.instructions.slice(0, 4000) : ''
  if (!team) return res.status(400).json({ error: 'team is required' })
  if (docs.length === 0 && tickets.length === 0) {
    return res.status(400).json({ error: 'select at least one document or ticket' })
  }

  let combined: string
  try {
    combined = await collectClickupSources(cuToken, team, docs, tickets)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    return res.status(status).json({ error: (err as Error).message })
  }
  if (!combined) {
    return res.status(422).json({ error: 'The selected sources appear to be empty.' })
  }
  const trimmed =
    combined.length > MAX_TOTAL_CHARS
      ? `${combined.slice(0, MAX_TOTAL_CHARS)}\n\n…(sources truncated)`
      : combined

  const result = await runCommand(
    [
      '-p',
      '--model',
      'sonnet',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '1.00',
      diagramPrompt(trimmed, projectName, instructions),
    ],
    180000,
  )
  if (result.timedOut) {
    return res.status(504).json({ error: 'Timed out while generating the diagram.' })
  }
  const raw = (result.stdout || result.stderr).trim()
  let parsed: { result?: string; is_error?: boolean; subtype?: string } = {}
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    /* non-json CLI error */
  }
  const mermaid = stripFence(parsed.result ?? '')
  if (result.code !== 0 || parsed.is_error || !mermaid) {
    return res.status(502).json({ error: claudeFailureReason('diagram', result, raw, parsed) })
  }
  res.json({ mermaid, sourceCount: docs.length + tickets.length })
})

/** Parse the optional template payload from a request body. */
function parseTemplate(raw: unknown): { name?: string; content?: string } | null {
  if (raw && typeof raw === 'object') return raw as { name?: string; content?: string }
  return null
}

/**
 * Generate manual test cases for ONE already-crawled ticket, synchronously. Reads
 * the ticket's on-disk files, has Claude draft the cases, and saves a new version
 * under testing/tickets/<folder>/testcases/v<N>.md. Body:
 *   { projectId, folder, template?: { name, content }, instructions?, projectName? }
 */
aiRouter.post('/testcases', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })
  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : project.name || 'this project'

  try {
    const result = await generateTestcaseVersion({
      rootPath: project.rootPath,
      projectName,
      folder,
      template: parseTemplate(req.body?.template),
      instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : '',
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      appUrl: typeof req.body?.appUrl === 'string' ? req.body.appUrl : undefined,
      sourcePath: project.sourcePath,
      groundingCheck: project.groundingCheck,
      groundingCheckModel: project.groundingCheckModel,
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

/**
 * Rewrite ONE cell of a stored CSV test-case version with AI, overwriting that same
 * version in place. The /testcases preview lets a QC engineer click a cell, add an
 * instruction, and regenerate just that cell. Body:
 *   { projectId, folder, version, row, col, comment, model? }
 *   - row: absolute row index in the CSV (0 = header), col: column index.
 */
aiRouter.post('/testcases/cell', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })
  const version = Number(req.body?.version)
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'version is required' })
  const comment = typeof req.body?.comment === 'string' ? req.body.comment : ''
  // A direct `value` (Undo) writes the cell without AI; otherwise a comment is required.
  const value = typeof req.body?.value === 'string' ? req.body.value : undefined
  if (value === undefined && !comment.trim()) {
    return res.status(400).json({ error: 'comment is required' })
  }
  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : project.name || 'this project'

  try {
    const result = await editTestcaseCell({
      rootPath: project.rootPath,
      projectName,
      folder,
      version,
      row: Number(req.body?.row),
      col: Number(req.body?.col),
      comment,
      value,
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

/**
 * Verify a crawled ticket against a linked Figma design, synchronously. Claude
 * runs in the project folder (so it can use the project's Figma/Playwright MCP to
 * open the design) and returns categorized findings. Body:
 *   { projectId, folder, figmaUrl, instructions?, model?, projectName? }
 */
aiRouter.post('/verify-design', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })
  const figmaUrl = typeof req.body?.figmaUrl === 'string' ? req.body.figmaUrl.trim() : ''
  if (!figmaUrl) return res.status(400).json({ error: 'figmaUrl is required' })
  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : project.name || 'this project'

  try {
    const checklist = parseTemplate(req.body?.checklist)
    const result = await verifyDesign({
      rootPath: project.rootPath,
      projectName,
      folder,
      figmaUrl,
      instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : '',
      model: typeof req.body?.model === 'string' ? req.body.model : undefined,
      checklistOverride: typeof checklist?.content === 'string' ? checklist.content : undefined,
    })
    // Record the run in the DB (the markdown report was already written to disk by
    // verifyDesign). Persistence must never sink the response.
    let recordId: string | null = null
    try {
      recordId = insertDesignCheck({
        projectId: project.id,
        folder,
        figmaUrl,
        model: result.model,
        summary: result.summary,
        findings: result.findings,
        filePath: result.savedPath,
      }).id
    } catch {
      /* recording is best-effort */
    }
    res.json({ ...result, recordId })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

/**
 * Start a BACKGROUND Design Check job. The verify runs server-side and keeps going
 * across browser reloads; the client polls GET /verify-design/jobs/:id for live
 * progress + the streamed log, and renders the findings once it finishes. Body:
 *   { projectId, folder, figmaUrl, instructions?, model?, projectName?, checklist? }
 */
aiRouter.post('/verify-design/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const folder = typeof req.body?.folder === 'string' ? req.body.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })
  const figmaUrl = typeof req.body?.figmaUrl === 'string' ? req.body.figmaUrl.trim() : ''
  if (!figmaUrl) return res.status(400).json({ error: 'figmaUrl is required' })
  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : project.name || 'this project'

  const checklist = parseTemplate(req.body?.checklist)
  const job = startVerifyJob({
    projectId: project.id,
    projectName,
    rootPath: project.rootPath,
    folder,
    figmaUrl,
    instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : '',
    model: typeof req.body?.model === 'string' ? req.body.model : '',
    checklistOverride: typeof checklist?.content === 'string' ? checklist.content : undefined,
  })
  res.json({ jobId: job.id, job })
})

/** List this project's Design Check jobs (newest first). */
aiRouter.get('/verify-design/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listVerifyJobs(project.id) })
})

/** Poll a single Design Check job by id. */
aiRouter.get('/verify-design/jobs/:id', (req, res) => {
  const job = getVerifyJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** Cancel a running Design Check job (terminal) — kill the in-flight Claude run. */
aiRouter.post('/verify-design/jobs/:id/cancel', (req, res) => {
  const job = cancelVerifyJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** List a project's saved Design Check records (newest first). */
aiRouter.get('/verify-design/history', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ checks: listDesignChecks(project.id) })
})

/** Reveal the project's design-check/ folder in the OS file explorer. */
aiRouter.post('/verify-design/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = path.join(project.rootPath, 'design-check')
  fs.mkdirSync(dir, { recursive: true })
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/**
 * Start a BACKGROUND job that generates test cases for several crawled tickets.
 * The job runs server-side and keeps going across browser reloads; the client
 * polls GET /testcases/jobs/:id for progress. Body:
 *   { projectId, folders: string[], template?, instructions?, projectName? }
 */
aiRouter.post('/testcases/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const raw = Array.isArray(req.body?.folders) ? req.body.folders : []
  let folders = [
    ...new Set(
      raw
        .filter((f: unknown): f is string => typeof f === 'string' && f.trim().length > 0)
        .map((f: string) => f.trim()),
    ),
  ] as string[]
  if (!folders.length) return res.status(400).json({ error: 'folders is required' })
  if (folders.length > MAX_JOB_FOLDERS) folders = folders.slice(0, MAX_JOB_FOLDERS)

  const projectName =
    typeof req.body?.projectName === 'string' && req.body.projectName.trim()
      ? req.body.projectName.trim()
      : project.name || 'this project'

  // Optional per-ticket live app URL (folder → url). Kept only for the folders in
  // this job; invalid/non-string entries are dropped (generation re-validates too).
  const rawAppUrls =
    req.body?.appUrls && typeof req.body.appUrls === 'object' ? req.body.appUrls : {}
  const appUrls: Record<string, string> = {}
  for (const folder of folders) {
    const u = (rawAppUrls as Record<string, unknown>)[folder]
    if (typeof u === 'string' && u.trim()) appUrls[folder] = u.trim()
  }

  const job = startTestcaseJob({
    projectId: project.id,
    projectName,
    rootPath: project.rootPath,
    sourcePath: project.sourcePath ?? '',
    folders,
    appUrls,
    template: parseTemplate(req.body?.template),
    instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : '',
    model: typeof req.body?.model === 'string' ? req.body.model : '',
    groundingCheck: project.groundingCheck,
    groundingCheckModel: project.groundingCheckModel,
    autoLearn: project.autoLearn,
    autoLearnModel: project.autoLearnModel,
  })
  res.json({ jobId: job.id, job })
})

/** List this project's test-case generation jobs (newest first). */
aiRouter.get('/testcases/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ jobs: listTestcaseJobs(project.id) })
})

/** Poll a single test-case generation job by id. */
aiRouter.get('/testcases/jobs/:id', (req, res) => {
  const job = getTestcaseJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** Pause a running job (interrupt the current ticket; keep it resumable). */
aiRouter.post('/testcases/jobs/:id/pause', (req, res) => {
  const job = pauseTestcaseJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** Resume a paused job — continue with the remaining tickets. */
aiRouter.post('/testcases/jobs/:id/resume', (req, res) => {
  const job = resumeTestcaseJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/** Cancel a job (terminal) — kill the current ticket and stop the rest. */
aiRouter.post('/testcases/jobs/:id/cancel', (req, res) => {
  const job = cancelTestcaseJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json({ job })
})

/**
 * Test-case versions for a crawled ticket.
 *   GET /testcases?folder=…             → { versions: [{ version, savedAt, label }] } (latest first)
 *   GET /testcases?folder=…&version=N   → { testcases, savedAt, version } for that version
 */
aiRouter.get('/testcases', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const folder = typeof req.query.folder === 'string' ? req.query.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })

  const baseDir = ticketsDirFor(project.rootPath)
  const dir = path.resolve(baseDir, folder)
  if (dir !== baseDir && !dir.startsWith(baseDir + path.sep)) {
    return res.status(400).json({ error: 'invalid ticket path' })
  }

  const versions = listTestcaseVersions(dir)

  if (req.query.version !== undefined) {
    const want = Number(req.query.version)
    const meta = versions.find((v) => v.version === want)
    if (!meta) return res.json({ testcases: null, savedAt: null, version: want, format: 'markdown' })
    try {
      const testcases = fs.readFileSync(path.join(dir, meta.file), 'utf8')
      return res.json({ testcases, savedAt: meta.savedAt, version: want, format: meta.format })
    } catch {
      return res.json({ testcases: null, savedAt: null, version: want, format: meta.format })
    }
  }

  res.json({
    versions: versions
      .slice()
      .reverse() // latest first
      .map((v) => ({ version: v.version, savedAt: v.savedAt, label: v.label, format: v.format })),
  })
})

/** Delete one stored test-case version. DELETE /testcases?folder=…&version=N */
aiRouter.delete('/testcases', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const folder = typeof req.query.folder === 'string' ? req.query.folder.trim() : ''
  if (!folder) return res.status(400).json({ error: 'folder is required' })
  if (req.query.version === undefined) {
    return res.status(400).json({ error: 'version is required' })
  }
  const version = Number(req.query.version)
  if (!Number.isInteger(version) || version < 0) {
    return res.status(400).json({ error: 'invalid version' })
  }
  try {
    deleteTestcaseVersion(project.rootPath, folder, version)
    res.json({ ok: true })
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})
