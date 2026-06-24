import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor, ticketsDirFor } from './config.js'
import { CRAWL_SUMMARY_MODELS, parseClaudeJsonResult, runClaude } from './claudeExec.js'

const DEFAULT_MODEL = 'sonnet'
const MAX_TICKET_CHARS = 40_000
const MAX_INSTRUCTIONS_CHARS = 4_000
const MAX_CHECKLIST_CHARS = 6_000
const VERIFY_TIMEOUT_MS = 300_000 // 5 min — inspecting a Figma design via tools is slow.

// Project-wide "Design Check" checklist, managed on the Templates page and applied
// to every verification as standard criteria. Stored as plain markdown.
const CHECKLIST_TEMPLATE_KEY = 'design-check'

/** Read the project's standard Design Check checklist, or '' when none is set. */
function readChecklist(rootPath: string): string {
  try {
    const file = path.join(testingDirFor(rootPath), 'templates', `${CHECKLIST_TEMPLATE_KEY}.md`)
    const text = fs.readFileSync(file, 'utf8').trim()
    if (!text) return ''
    return text.length > MAX_CHECKLIST_CHARS
      ? `${text.slice(0, MAX_CHECKLIST_CHARS)}\n\n…(checklist truncated)`
      : text
  } catch {
    return '' // no checklist template — verification still runs on the ticket alone.
  }
}

/** The verdict buckets the UI groups findings into. */
export const FINDING_CATEGORIES = [
  'match',
  'mismatch',
  'concern',
  'unsure',
  'discuss',
] as const
export type FindingCategory = (typeof FINDING_CATEGORIES)[number]

export interface DesignFinding {
  category: FindingCategory
  title: string
  detail: string
}

export interface VerifyResult {
  summary: string
  findings: DesignFinding[]
  model: string
  raw: string
  /** Saved markdown report path, relative to the project root (or null on write failure). */
  savedPath: string | null
  /** ISO timestamp the report was saved. */
  savedAt: string | null
}

// Human-readable labels + the order findings are written into the report (most
// actionable first), mirroring how the UI groups them.
const REPORT_LABELS: Record<FindingCategory, string> = {
  mismatch: "Doesn't match",
  concern: 'Concern',
  discuss: 'Needs discussion',
  unsure: 'Not sure',
  match: 'Matches',
}
const REPORT_ORDER: FindingCategory[] = ['mismatch', 'concern', 'discuss', 'unsure', 'match']

/** Make a filesystem-safe single path segment from a ticket folder name. */
function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'ticket'
}

/** Compact filesystem-safe timestamp, e.g. 2026-06-24_10-15-30. */
function fileStamp(iso: string): string {
  return iso.replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '-')
}

/** Build the markdown report saved to <root>/design-check/. */
function buildReport(opts: {
  projectName: string
  folder: string
  figmaUrl: string
  model: string
  createdAt: string
  result: { summary: string; findings: DesignFinding[] }
}): string {
  const { result } = opts
  const lines: string[] = []
  lines.push(`# Design Check — ${opts.folder}`)
  lines.push('')
  lines.push(`- **Project:** ${opts.projectName}`)
  lines.push(`- **Ticket:** ${opts.folder}`)
  lines.push(`- **Figma:** ${opts.figmaUrl}`)
  lines.push(`- **Model:** ${opts.model}`)
  lines.push(`- **Date:** ${opts.createdAt}`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(result.summary || '(no summary)')
  lines.push('')
  lines.push(`## Findings (${result.findings.length})`)
  for (const cat of REPORT_ORDER) {
    const items = result.findings.filter((f) => f.category === cat)
    if (items.length === 0) continue
    lines.push('')
    lines.push(`### ${REPORT_LABELS[cat]} (${items.length})`)
    lines.push('')
    for (const f of items) {
      lines.push(`- **${f.title}**${f.detail ? ` — ${f.detail}` : ''}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

function normalizeModel(raw: string | undefined): string {
  const m = typeof raw === 'string' ? raw.trim() : ''
  return CRAWL_SUMMARY_MODELS.has(m) ? m : DEFAULT_MODEL
}

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

/** Resolve & path-guard a ticket folder under <root>/testing/test-result/. */
function ticketDir(rootPath: string, folder: string): string {
  const baseDir = ticketsDirFor(rootPath)
  const dir = path.resolve(baseDir, folder)
  if (dir !== baseDir && !dir.startsWith(baseDir + path.sep)) {
    throw statusError('invalid ticket path', 400)
  }
  return dir
}

function verifyPrompt(opts: {
  ticketContent: string
  figmaUrl: string
  instructions: string
  checklist: string
  projectName: string
}): string {
  const instructionBlock = opts.instructions
    ? `\nAdditional instructions from the QC engineer — weigh these heavily:\n${opts.instructions}\n`
    : ''
  const checklistBlock = opts.checklist
    ? `\nThis project has a STANDARD Design Check checklist. Go through EVERY item below and report at least one finding for each — use "unsure" when you could not verify an item rather than skipping it:\n${opts.checklist}\n`
    : ''

  return `You are a meticulous design-QC reviewer for the project "${opts.projectName}". Your job is to verify whether a ClickUp ticket's requirements are satisfied by a Figma design, and to flag every gap, risk, or open question.

The Figma design is here: ${opts.figmaUrl}

If you have a Figma tool, a browser/Playwright tool, or web access available, USE IT to open and inspect that design. If you cannot access it, do NOT guess what it looks like — instead categorize the affected requirements as "unsure" or "discuss" and say plainly that the design could not be opened.

Compare the TICKET requirements below against the DESIGN. Produce a flat list of findings. Each finding is one concrete, specific point — a single requirement, element, state, or question — categorized as exactly one of:
- "match": the design clearly satisfies this requirement.
- "mismatch": the design contradicts or fails this requirement.
- "concern": implemented but with a risk/quality issue (spacing, accessibility, edge state, responsiveness, copy, etc.).
- "unsure": you could not confidently verify it (e.g. couldn't see the design, or the ticket is ambiguous).
- "discuss": needs a human decision or clarification before it can be judged.
${checklistBlock}${instructionBlock}
Return ONLY valid JSON (no code fence, no prose) in exactly this shape:
{
  "summary": "<one or two sentence overall verdict>",
  "findings": [
    { "category": "match|mismatch|concern|unsure|discuss", "title": "<short label>", "detail": "<one to three sentences of specifics, referencing the requirement and what the design shows>" }
  ]
}
Be specific and honest. Prefer several precise findings over a few vague ones. Do not fabricate design details you did not see.

--- TICKET START ---
${opts.ticketContent}
--- TICKET END ---`
}

/** Pull the findings JSON out of the model's text, tolerating stray fences/prose. */
function parseFindings(text: string): { summary: string; findings: DesignFinding[] } | null {
  let body = text.trim()
  // Strip a leading ```json / ``` fence if present.
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(body)
  if (fence) body = fence[1].trim()
  // Otherwise grab the outermost { … }.
  if (!body.startsWith('{')) {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    body = body.slice(start, end + 1)
  }
  let parsed: { summary?: unknown; findings?: unknown }
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : []
  const findings: DesignFinding[] = []
  for (const f of rawFindings) {
    if (!f || typeof f !== 'object') continue
    const cat = String((f as { category?: unknown }).category ?? '').toLowerCase()
    const category = (FINDING_CATEGORIES as readonly string[]).includes(cat)
      ? (cat as FindingCategory)
      : 'discuss'
    const title = String((f as { title?: unknown }).title ?? '').trim()
    const detail = String((f as { detail?: unknown }).detail ?? '').trim()
    if (!title && !detail) continue
    findings.push({ category, title: title || '(untitled)', detail })
  }
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
    findings,
  }
}

/**
 * Verify a crawled ticket against a Figma design with Claude. Runs in the project
 * folder with tools enabled so it can open the design via the project's MCP servers.
 */
export async function verifyDesign(opts: {
  rootPath: string
  projectName: string
  folder: string
  figmaUrl: string
  instructions?: string
  model?: string
  /** One-off checklist for this run; overrides the saved testing/templates/design-check.md. */
  checklistOverride?: string
}): Promise<VerifyResult> {
  const folder = opts.folder.trim()
  if (!folder) throw statusError('folder is required', 400)
  const figmaUrl = opts.figmaUrl.trim()
  if (!figmaUrl) throw statusError('a Figma design link is required', 400)

  const dir = ticketDir(opts.rootPath, folder)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw statusError('ticket has not been crawled yet', 404)
  }

  const parts: string[] = []
  for (const file of ['ticket.md', 'comments.md', 'summary.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (text) parts.push(text)
    } catch {
      /* missing — skip */
    }
  }
  let ticketContent = parts.join('\n\n---\n\n').trim()
  if (!ticketContent) throw statusError('No ticket content found in this folder.', 422)
  if (ticketContent.length > MAX_TICKET_CHARS) {
    ticketContent = `${ticketContent.slice(0, MAX_TICKET_CHARS)}\n\n…(ticket truncated)`
  }

  const instructions =
    typeof opts.instructions === 'string'
      ? opts.instructions.trim().slice(0, MAX_INSTRUCTIONS_CHARS)
      : ''
  // A one-off upload from the page wins; otherwise use the saved project checklist.
  const override =
    typeof opts.checklistOverride === 'string' ? opts.checklistOverride.trim() : ''
  const checklist = override
    ? override.slice(0, MAX_CHECKLIST_CHARS)
    : readChecklist(opts.rootPath)
  const model = normalizeModel(opts.model)

  const result = await runClaude(
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--no-session-persistence',
      // Run unattended; the QC skill's mutation guards still apply. Needed so the
      // model can use the project's Figma/Playwright MCP tools to open the design.
      '--permission-mode',
      'bypassPermissions',
      '--max-budget-usd',
      '0.80',
      verifyPrompt({ ticketContent, figmaUrl, instructions, checklist, projectName: opts.projectName }),
    ],
    VERIFY_TIMEOUT_MS,
    { cwd: opts.rootPath, usageSource: 'design-verify', model },
  )

  if (result.timedOut) throw statusError('Timed out while verifying the design.', 504)
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (isError || !text) {
    throw statusError('Claude did not return a result. Check the model and Figma access.', 502)
  }
  const parsed = parseFindings(text)
  if (!parsed) {
    throw statusError('Could not parse the verification result from the model.', 502)
  }

  // Persist a markdown report under <root>/design-check/. A write failure must NOT
  // sink the verification — we still return the findings, just with savedPath null.
  const createdAt = new Date().toISOString()
  let savedPath: string | null = null
  let savedAt: string | null = null
  try {
    const outDir = path.join(opts.rootPath, 'design-check')
    fs.mkdirSync(outDir, { recursive: true })
    const fileName = `${safeSegment(folder)}-${fileStamp(createdAt)}.md`
    const report = buildReport({
      projectName: opts.projectName,
      folder,
      figmaUrl,
      model,
      createdAt,
      result: parsed,
    })
    fs.writeFileSync(path.join(outDir, fileName), report, 'utf8')
    // Forward-slashed relative path for display/storage, regardless of OS.
    savedPath = `design-check/${fileName}`
    savedAt = createdAt
  } catch {
    /* report write failed — keep the result usable */
  }

  return { summary: parsed.summary, findings: parsed.findings, model, raw: text, savedPath, savedAt }
}
