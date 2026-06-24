import fs from 'node:fs'
import path from 'node:path'
import { ticketsDirFor } from './config.js'
import {
  downloadAttachment,
  getTaskComments,
  getTaskDetail,
  type TaskAttachment,
  type TaskComment,
  type TaskDetail,
} from './clickup.js'
import { CRAWL_SUMMARY_MODELS, parseClaudeJsonResult, runClaude } from './claudeExec.js'

// Core single-ticket crawl: download a ClickUp ticket's detail + comments +
// attachments into <root>/testing/test-result/<displayId>/, optionally writing an AI
// summary.md. Extracted so both the synchronous /crawl route and the background
// crawl-job runner share exactly one implementation.

const MAX_SUMMARY_INPUT_CHARS = 40_000

export interface CrawlLog {
  level: 'info' | 'success' | 'error'
  text: string
}

export interface CrawlResult {
  displayId: string
  name: string
  dir: string // path relative to the project root, e.g. testing/test-result/ABC-1
  absDir: string
  files: { path: string; bytes: number }[]
  commentCount: number
  attachmentCount: number
  attachmentTotal: number
  attachmentErrors: string[]
  summary: { ok: boolean; model: string | null; error: string | null } | null
}

/** An Error carrying an HTTP status the route can surface. */
function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

/** Make a string safe to use as a single path segment (no separators, no dots). */
export function safeSegment(s: string): string {
  return (
    s
      .replace(/[/\\]+/g, '-')
      .replace(/[^\w.\- ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '') // never a dotfile / traversal
      .slice(0, 120) || 'ticket'
  )
}

export function ticketMarkdown(t: TaskDetail): string {
  const lines: string[] = [`# ${t.displayId} — ${t.name}`, '']
  const meta: [string, string | null][] = [
    ['Status', t.status || null],
    ['Priority', t.priority],
    ['Assignees', t.assignees.length ? t.assignees.join(', ') : null],
    ['Tags', t.tags.length ? t.tags.join(', ') : null],
    ['List', [t.folderName, t.listName].filter(Boolean).join(' / ') || null],
    ['Space', t.spaceName],
    ['Due', t.dueDate],
    ['Created', t.dateCreated],
    ['Updated', t.dateUpdated],
    ['URL', t.url || null],
  ]
  for (const [k, v] of meta) if (v) lines.push(`- **${k}:** ${v}`)
  if (t.customFields.length) {
    lines.push('', '## Custom fields', '')
    for (const f of t.customFields) lines.push(`- **${f.name}:** ${f.value}`)
  }
  lines.push('', '## Description', '', t.description || '_No description._')
  return lines.join('\n') + '\n'
}

export function commentsMarkdown(displayId: string, comments: TaskComment[]): string {
  const lines: string[] = [`# Comments — ${displayId}`, '']
  if (!comments.length) lines.push('_No comments._')
  for (const c of comments) {
    lines.push(`### ${c.user}${c.date ? ` · ${c.date}` : ''}`, '', c.text || '_(empty)_', '')
  }
  return lines.join('\n') + '\n'
}

/** Pick a unique, safe filename for an attachment inside `dir`. */
function attachmentFilename(a: TaskAttachment, taken: Set<string>): string {
  let base = safeSegment(a.title || a.id)
  if (a.extension && !base.toLowerCase().endsWith(`.${a.extension.toLowerCase()}`)) {
    base = `${base}.${a.extension}`
  }
  let name = base
  let n = 1
  while (taken.has(name.toLowerCase())) {
    const dot = base.lastIndexOf('.')
    name = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`
    n++
  }
  taken.add(name.toLowerCase())
  return name
}

/** Prompt Claude to turn a crawled ticket's content into a short QC-focused brief. */
function summaryPrompt(displayId: string, name: string, content: string): string {
  return `You are a senior QC (acceptance testing) engineer. A ClickUp ticket has just been downloaded for testing. Read it and write a SHORT QC brief in GitHub-flavored Markdown that helps an engineer get oriented fast.

Ticket: ${displayId} — ${name}

Structure (keep it tight — this is a quick brief, not a full plan):
- A one or two sentence summary of what this ticket asks for.
- "## What to test" — 3 to 6 bullet points of the key things a QC engineer should verify.
- "## Watch out for" — edge cases, ambiguities, or risks implied by the ticket (omit if none).

Rules:
- Base everything ONLY on the ticket content below. Do not invent requirements.
- Be concise and scannable. No preamble, no surrounding code fence.

--- TICKET CONTENT START ---
${content}
--- TICKET CONTENT END ---`
}

/**
 * Crawl one ticket to disk. `model` (haiku/sonnet/opus) additionally writes an AI
 * summary.md — anything else means download-only. Progress is reported via `onLog`.
 * Throws an Error (with a `.status`) on a guarded-path violation.
 */
export async function crawlOneTicket(opts: {
  taskId: string
  rootPath: string
  model?: string
  onLog?: (log: CrawlLog) => void
}): Promise<CrawlResult> {
  const onLog = opts.onLog ?? (() => {})
  const useModel = CRAWL_SUMMARY_MODELS.has(opts.model ?? '') ? (opts.model as string) : ''

  const detail = await getTaskDetail(opts.taskId)
  const comments = await getTaskComments(opts.taskId)

  // Resolve & path-guard the destination: <root>/testing/test-result/<displayId>/
  const baseDir = ticketsDirFor(opts.rootPath)
  const dir = path.resolve(baseDir, safeSegment(detail.displayId))
  if (dir !== path.join(baseDir, path.basename(dir)) || !dir.startsWith(baseDir + path.sep)) {
    throw statusError('invalid ticket path', 400)
  }
  fs.mkdirSync(dir, { recursive: true })

  const written: { path: string; bytes: number }[] = []
  const writeFile = (name: string, content: string | Buffer) => {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    fs.writeFileSync(path.join(dir, name), buf)
    written.push({ path: name, bytes: buf.byteLength })
  }

  writeFile('ticket.md', ticketMarkdown(detail))
  writeFile('comments.md', commentsMarkdown(detail.displayId, comments))
  writeFile('ticket.json', JSON.stringify({ ...detail, comments }, null, 2))
  onLog({ level: 'info', text: `${detail.displayId} — ${comments.length} comment(s), 3 base files` })

  // Attachments → <dir>/attachments/. Failures are collected, not fatal.
  const attachmentErrors: string[] = []
  let attachmentCount = 0
  if (detail.attachments.length) {
    const attDir = path.join(dir, 'attachments')
    fs.mkdirSync(attDir, { recursive: true })
    const taken = new Set<string>()
    for (const a of detail.attachments) {
      const name = attachmentFilename(a, taken)
      try {
        if (!a.url) throw new Error('no url')
        const buf = await downloadAttachment(a.url)
        fs.writeFileSync(path.join(attDir, name), buf)
        written.push({ path: `attachments/${name}`, bytes: buf.byteLength })
        attachmentCount++
      } catch (err) {
        const msg = `${a.title}: ${(err as Error).message}`
        attachmentErrors.push(msg)
        onLog({ level: 'error', text: `⚠ attachment ${msg}` })
      }
    }
    onLog({ level: 'info', text: `${attachmentCount}/${detail.attachments.length} attachment(s) saved` })
  }

  // Optional AI summary of the freshly-crawled ticket → summary.md. Best-effort:
  // a failure here never fails the crawl (the raw download is already on disk).
  // null = no summary requested (download only); an object = it was attempted.
  let summary: { ok: boolean; model: string | null; error: string | null } | null = null
  if (useModel) {
    onLog({ level: 'info', text: `Writing AI summary (${useModel})…` })
    try {
      let content = ticketMarkdown(detail)
      const cmt = commentsMarkdown(detail.displayId, comments)
      if (cmt) content += `\n\n${cmt}`
      if (content.length > MAX_SUMMARY_INPUT_CHARS) {
        content = `${content.slice(0, MAX_SUMMARY_INPUT_CHARS)}\n…(truncated)`
      }
      const result = await runClaude(
        [
          '-p',
          '--model',
          useModel,
          '--output-format',
          'json',
          '--no-session-persistence',
          '--max-budget-usd',
          '0.30',
          summaryPrompt(detail.displayId, detail.name, content),
        ],
        150_000,
        { usageSource: 'crawl-summary', model: useModel },
      )
      const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
      if (result.timedOut) {
        summary = { ok: false, model: useModel, error: 'Summary timed out.' }
      } else if (result.code === 0 && !isError && text) {
        writeFile('summary.md', `${text}\n`)
        summary = { ok: true, model: useModel, error: null }
      } else {
        summary = { ok: false, model: useModel, error: 'Claude did not return a summary.' }
      }
    } catch (err) {
      summary = { ok: false, model: useModel, error: (err as Error).message }
    }
    onLog(
      summary.ok
        ? { level: 'success', text: `summary.md written (${useModel})` }
        : { level: 'error', text: `summary skipped: ${summary.error ?? 'failed'}` },
    )
  }

  return {
    displayId: detail.displayId,
    name: detail.name,
    dir: path.relative(opts.rootPath, dir),
    absDir: dir,
    files: written,
    commentCount: comments.length,
    attachmentCount,
    attachmentTotal: detail.attachments.length,
    attachmentErrors,
    summary,
  }
}
