import fs from 'node:fs'
import path from 'node:path'
import type { TaskComment, TaskDetail } from './clickup.js'

/**
 * A ticket's ACTIVITY LOG — `testing/tickets/<id>/activity.md`.
 *
 * Reported from the field as "chat can't read a ticket's activity log", and the reason
 * is that there was none to read. Measured while investigating:
 *
 * - ClickUp's public API has **no task history endpoint** — `/task/<id>/history` and
 *   `/task/<id>/activity` are 404, and `/task/<id>/time_in_status` (the one thing that
 *   comes close) is plan-gated: this workspace answers `403 TIS_027 Time In Status is
 *   not available on your plan`.
 * - The configured ClickUp MCP server exposes 28 tools and not one of them returns
 *   history — `get_task` returns current state only.
 *
 * So the change history cannot be fetched. It can, however, be **accumulated**: the
 * portal already re-crawls tickets, and every crawl holds the previous snapshot
 * (`ticket.json`) next to the fresh one. Diffing the two turns each crawl into a dated
 * entry, and over time the project owns a real log — grounded in what the portal itself
 * observed, not in what a model guesses a ticket "probably" went through.
 *
 * Three rules keep it honest, because a half-true history is worse than none:
 *
 * - **The first crawl is a BASELINE, not a history.** It says so in the file, so nobody
 *   reads "created → ready to test" as the whole story of a ticket that has been open
 *   for a year.
 * - **A crawl with no changes writes no entry** — it only refreshes the `Last checked`
 *   line. An "I looked and nothing had changed" entry per crawl would bury the four
 *   real ones under two hundred.
 * - **Only observed fields are reported, by their own names and values.** No inference
 *   about who did it: ClickUp doesn't tell us, and a wrong name in an audit trail is
 *   exactly the kind of fact that gets repeated afterwards.
 */

export const ACTIVITY_FILE = 'activity.md'

/** What a crawl stored last time: the detail fields plus the comment thread. */
export interface StoredTicket extends Partial<TaskDetail> {
  ticketKind?: string | null
  comments?: TaskComment[]
}

/** Bound the file — a busy ticket crawled daily for a year is still readable. */
const MAX_ENTRIES = 200
const MAX_BYTES = 256 * 1024

const HEADER_RE = /^#[^\n]*\n/
const LAST_CHECKED_RE = /^_Last checked: [^\n]*_\n/m

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []
}

function fmt(v: unknown): string {
  const s = v == null || v === '' ? '' : String(v)
  return s.trim() || '_(empty)_'
}

/** `a, b` → what was added and what disappeared, ignoring order. */
function setDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return {
    added: after.filter((x) => !b.has(x)),
    removed: before.filter((x) => !a.has(x)),
  }
}

/** One short line per comment, so the log reads without opening comments.md. */
function commentLine(c: TaskComment): string {
  const first = (c.text ?? '').split('\n').find((l) => l.trim()) ?? ''
  const text = first.trim().slice(0, 160)
  return `${c.user}${c.date ? ` (${c.date})` : ''}: “${text}${first.trim().length > 160 ? '…' : ''}”`
}

/**
 * Everything that differs between the stored snapshot and the fresh one, as finished
 * Markdown bullets. Empty = nothing changed, which is the caller's signal to write no
 * entry at all.
 */
export function diffTicket(
  prev: StoredTicket,
  next: TaskDetail,
  nextComments: TaskComment[],
  nextKind: string | null,
): string[] {
  const out: string[] = []
  const scalar = (label: string, before: unknown, after: unknown) => {
    const b = before == null ? '' : String(before)
    const a = after == null ? '' : String(after)
    if (b === a) return
    out.push(`- **${label}:** ${fmt(b)} → **${fmt(a)}**`)
  }

  scalar('Status', prev.status, next.status)
  scalar('Priority', prev.priority, next.priority)
  scalar('Due date', prev.dueDate, next.dueDate)
  scalar('Title', prev.name, next.name)
  scalar('List', prev.listName, next.listName)
  if ((prev.ticketKind ?? null) !== nextKind) {
    scalar('Ticket kind (set in the portal)', prev.ticketKind, nextKind)
  }

  const people = setDiff(list(prev.assignees), next.assignees)
  if (people.added.length) out.push(`- **Assignee added:** ${people.added.join(', ')}`)
  if (people.removed.length) out.push(`- **Assignee removed:** ${people.removed.join(', ')}`)

  const tags = setDiff(list(prev.tags), next.tags)
  if (tags.added.length) out.push(`- **Tag added:** ${tags.added.join(', ')}`)
  if (tags.removed.length) out.push(`- **Tag removed:** ${tags.removed.join(', ')}`)

  // The description is the requirement itself: report THAT it changed and by how much,
  // never a diff of the text — a re-worded acceptance criterion pasted into a log is
  // read later as the current requirement, and ticket.md already holds that.
  const beforeDesc = String(prev.description ?? '')
  const afterDesc = next.description ?? ''
  if (beforeDesc !== afterDesc) {
    const delta = afterDesc.length - beforeDesc.length
    out.push(
      `- **Description edited** (${beforeDesc.length} → ${afterDesc.length} chars, ${
        delta >= 0 ? '+' : ''
      }${delta}) — read ticket.md for the current text`,
    )
  }

  const prevFields = new Map(
    (Array.isArray(prev.customFields) ? prev.customFields : []).map((f) => [f.name, f.value]),
  )
  for (const f of next.customFields) {
    const before = prevFields.get(f.name)
    if (before === undefined) out.push(`- **Field set — ${f.name}:** ${fmt(f.value)}`)
    else if (before !== f.value) out.push(`- **Field ${f.name}:** ${fmt(before)} → **${fmt(f.value)}**`)
    prevFields.delete(f.name)
  }
  for (const [name, value] of prevFields) {
    out.push(`- **Field cleared — ${name}** (was ${fmt(value)})`)
  }

  const att = setDiff(
    (Array.isArray(prev.attachments) ? prev.attachments : []).map((a) => a.title),
    next.attachments.map((a) => a.title),
  )
  if (att.added.length) out.push(`- **Attachment added:** ${att.added.join(', ')}`)
  if (att.removed.length) out.push(`- **Attachment removed:** ${att.removed.join(', ')}`)

  // Comments are matched by id, not counted: an edited or deleted comment would make a
  // count agree while the thread changed underneath it.
  const prevIds = new Set((Array.isArray(prev.comments) ? prev.comments : []).map((c) => c.id))
  const fresh = nextComments.filter((c) => !prevIds.has(c.id))
  if (fresh.length) {
    out.push(`- **${fresh.length} new comment${fresh.length === 1 ? '' : 's'}:**`)
    for (const c of fresh.slice(0, 10)) out.push(`  - ${commentLine(c)}`)
    if (fresh.length > 10) out.push(`  - …and ${fresh.length - 10} more — see comments.md`)
  }
  const nextIds = new Set(nextComments.map((c) => c.id))
  const gone = (Array.isArray(prev.comments) ? prev.comments : []).filter((c) => !nextIds.has(c.id))
  if (gone.length) out.push(`- **${gone.length} comment(s) removed from the thread**`)

  return out
}

function baselineEntry(detail: TaskDetail, comments: TaskComment[], kind: string | null): string[] {
  const out = [
    `- **First crawl.** Everything before this point is not recorded — ClickUp's API exposes no task history, so this log starts here.`,
    `- Snapshot: status **${fmt(detail.status)}**, priority ${fmt(detail.priority)}, assignee ${
      detail.assignees.length ? detail.assignees.join(', ') : '_(none)_'
    }, ${comments.length} comment(s)${kind ? `, marked as a ${kind} in the portal` : ''}`,
  ]
  if (detail.dateCreated) out.push(`- Created in ClickUp: ${detail.dateCreated}`)
  if (detail.dateUpdated) out.push(`- Last updated in ClickUp: ${detail.dateUpdated}`)
  return out
}

/** Trim the oldest entries once the log outgrows its caps. */
function capBody(entries: string): string {
  let body = entries
  const blocks = body.split(/\n(?=## )/).filter(Boolean)
  if (blocks.length > MAX_ENTRIES) body = blocks.slice(0, MAX_ENTRIES).join('\n')
  while (Buffer.byteLength(body, 'utf8') > MAX_BYTES) {
    const parts = body.split(/\n(?=## )/).filter(Boolean)
    if (parts.length <= 1) break
    body = parts.slice(0, parts.length - 1).join('\n')
  }
  return body
}

export interface ActivityResult {
  /** Bullet lines written this crawl (0 = nothing had changed). */
  changes: number
  /** True when this crawl created the log (i.e. the baseline entry). */
  baseline: boolean
}

/**
 * Append this crawl's changes to `<dir>/activity.md`. Best-effort: an unwritable log
 * must never fail a crawl whose ticket files are already safely on disk.
 *
 * `prev` is the ticket.json the crawl is about to overwrite — read it BEFORE writing.
 */
export function recordTicketActivity(opts: {
  dir: string
  displayId: string
  prev: StoredTicket | null
  detail: TaskDetail
  comments: TaskComment[]
  ticketKind: string | null
  /** Injected in tests; defaults to now. */
  at?: string
}): ActivityResult {
  const at = opts.at ?? new Date().toISOString()
  const file = path.join(opts.dir, ACTIVITY_FILE)
  const baseline = !opts.prev
  const lines = baseline
    ? baselineEntry(opts.detail, opts.comments, opts.ticketKind)
    : diffTicket(opts.prev as StoredTicket, opts.detail, opts.comments, opts.ticketKind)

  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch {
    /* first time */
  }

  // Newest first: the question this file answers is almost always "what changed since I
  // last looked", and the answer has to be at the top of a file that only grows.
  const header =
    `# Activity — ${opts.displayId}\n\n` +
    `_Built by the portal by comparing each crawl with the one before it. ClickUp's API ` +
    `exposes no task history, so nothing before the first crawl below is recorded, and a ` +
    `change is dated when the portal SAW it, not when someone made it._\n\n` +
    `_Last checked: ${at}_\n`

  let body = existing
    .replace(HEADER_RE, '')
    .replace(/^_Built by the portal[^\n]*_\n/m, '')
    .replace(LAST_CHECKED_RE, '')
    .trim()

  if (lines.length) {
    const entry = `## ${at}${baseline ? ' — first crawl' : ''}\n\n${lines.join('\n')}\n`
    body = body ? `${entry}\n${body}` : entry
  }

  try {
    fs.writeFileSync(file, `${header}\n${capBody(body)}\n`, 'utf8')
  } catch {
    return { changes: 0, baseline: false } // never fail the crawl over its log
  }
  return { changes: lines.length, baseline }
}

/** Read the ticket.json a crawl is about to overwrite. Null when there isn't one yet. */
export function readStoredTicket(dir: string): StoredTicket | null {
  try {
    const raw = fs.readFileSync(path.join(dir, 'ticket.json'), 'utf8')
    const parsed = JSON.parse(raw) as StoredTicket
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
