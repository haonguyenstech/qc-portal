import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor, ticketsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { runClaudeStream, CRAWL_SUMMARY_MODELS } from '../claudeExec.js'
import { listTestcaseVersions } from '../testcaseGen.js'

export const chatRouter = Router()

/**
 * Chat — a plain conversation with Claude Code, in the project's folder.
 *
 * Every other AI surface in the portal is a FORM: pick a ticket, pick a model, press
 * Generate. This is the one place a QC engineer can just ask ("why did run 14 fail?",
 * "draft cases for the login screen", "what does this endpoint validate?") and get an
 * answer, with the project's CLAUDE.md / Knowledge / Memory already in scope because
 * the CLI runs with `cwd = project.rootPath`.
 *
 * It is deliberately NOT the Terminal page's pty. That one runs the interactive TUI,
 * whose output is ANSI redraw noise — fine in xterm, unrenderable as chat bubbles.
 * Here we run `claude -p --output-format stream-json`, which yields clean assistant
 * text (streamed as deltas) plus structured tool events.
 *
 * MULTI-TURN is carried by the CLI's own session, not by replaying a transcript: the
 * `init` event's session_id is stored on the conversation and passed back as
 * `--resume <id>` on the next turn. So context, and any files Claude already read,
 * survive the turn — and the prompt we send stays just the user's message.
 *
 * Stored per project under <root>/testing/chats/<slug>.json, mirroring
 * routes/prototype.ts (no DB), so a conversation versions with the project — unless it's a
 * TEMPORARY one, which never touches the folder at all (see the `temp` registry below).
 */

export type ChatTools = 'read' | 'full'

/**
 * An ACTION picked from the composer's `+` menu for ONE message.
 *
 * A chat turn's shape is otherwise fixed: answer the question from the project. These are
 * the three other shapes worth having, each of which needs different tools, a different
 * prompt and a different time budget — so they're a per-message choice rather than a
 * setting, and `ACTION_BLOCKS` / `toolArgs` / `timeoutFor` below are the three places that
 * differ. `null` (no action) leaves the turn exactly as it was.
 *
 * `web`      — answer from the live web (WebSearch/WebFetch), with its sources.
 * `research` — a structured report: several searches, cross-checked, sources listed.
 * `diagram`  — answer AS a Mermaid diagram, which the page renders as a picture.
 *
 * There is deliberately no image GENERATION here: the Claude CLI can't produce a raster
 * image, so "create image" would have to be either a lie or a second paid service. A
 * diagram is the visual this tool can actually make, and it's the one QC work asks for
 * (a flow, a state machine, a sequence).
 */
export type ChatAction = 'web' | 'research' | 'diagram'

interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
  /** Tool names this turn used, in order — rendered as an activity trail in the UI. */
  tools?: string[]
  model?: string
  /** The turn ended badly (timeout / CLI error); the UI tints it. */
  error?: boolean
  /**
   * File names (under testing/chats/images/) of images pasted with THIS message, so a
   * reopened conversation still shows what the question was about. Served back by
   * `GET /api/chat/images/:name`.
   */
  images?: string[]
  /** Follow-up prompts the model proposed with this answer (see SUGGEST_BLOCK). */
  suggestions?: string[]
  /** The `+` menu action this message was sent with — badged in the transcript. */
  action?: ChatAction
}

interface Chat {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  tools: ChatTools
  /**
   * The Claude CLI session backing this conversation, or null before the first turn.
   * NOT a secret — it's a local transcript id — but it's the whole reason a follow-up
   * question understands "it".
   */
  sessionId: string | null
  /** Starred — sorted above everything else in the rail, whatever its date. */
  pinned?: boolean
  /**
   * TEMPORARY — this conversation is never written to testing/chats and never appears in
   * the history rail. It lives in the `temp` registry below for as long as it's being used
   * and is then dropped. See that registry for what "temporary" does and doesn't cover.
   */
  temporary?: boolean
  messages: ChatMessage[]
}

/** List-shaped chat: no messages, plus a preview line so the rail can render fast. */
interface ChatSummary {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  tools: ChatTools
  messageCount: number
  preview: string
  pinned?: boolean
  /** A turn is in flight for this conversation (see LiveTurn). */
  running?: boolean
}

/**
 * TEMPORARY CONVERSATIONS — ask something without it becoming project history.
 *
 * A chat here versions with the project: the transcript file sits in `testing/chats/` and
 * gets committed with everything else. That is the right default for "how is this feature
 * implemented?", and the wrong one for the throwaway question, the one with a customer's
 * data pasted into it, or the third rephrasing of the same thing. A conversation you can't
 * keep out of the repo is one people stop asking in.
 *
 * So a temporary chat lives HERE and nowhere else: in memory, like `crawlJobs` /
 * `testcaseJobs`. It is not written to disk, `listChats` never sees it (it reads the
 * folder), and it is dropped on discard, after `TEMP_TTL_MS` idle, or on server restart.
 * Everything else about it is a normal conversation — multi-turn `--resume`, re-attach to a
 * turn in flight, Stop, `@`-mentions — because those all key on the slug, and `loadChat` /
 * `saveChat` below are what decide where that slug's record lives.
 *
 * What it does NOT cover, and must not be described as covering: a pasted image has to be
 * a real file for the CLI to Read it, so it is written under `testing/chats/images/` and
 * deleted again when the conversation is discarded or expires (`images` here is that
 * list); and the Claude CLI keeps its own session transcript under the user's home
 * directory, which the portal doesn't own.
 */
interface TempChat {
  chat: Chat
  /** Image files written for this conversation — removed with it. */
  images: string[]
  /** Last touched (ms); drives TTL eviction. */
  at: number
}

const temp = new Map<string, TempChat>()
/** A temporary chat is a live conversation, not a store — a handful is plenty. */
const MAX_TEMP_CHATS = 8
/** Idle life. Long enough to survive a lunch break, short enough to be "temporary". */
const TEMP_TTL_MS = 6 * 60 * 60 * 1000

/** Forget a temporary conversation and delete the images that belonged to it. */
function discardTemp(key: string): void {
  const t = temp.get(key)
  if (!t) return
  temp.delete(key)
  const root = key.split('::')[0]
  for (const file of t.images) {
    try {
      fs.rmSync(path.join(imageDir(root), file), { force: true })
    } catch {
      /* best effort — an undeletable preview must not fail the request */
    }
  }
}

/** Drop expired temporary chats, and the oldest ones if the map is over its cap. */
function sweepTemp(): void {
  const now = Date.now()
  for (const [key, t] of temp) {
    if (now - t.at > TEMP_TTL_MS && !live.has(key)) discardTemp(key)
  }
  if (temp.size <= MAX_TEMP_CHATS) return
  const oldest = [...temp.entries()]
    .filter(([key]) => !live.has(key))
    .sort((a, b) => a[1].at - b[1].at)
  for (const [key] of oldest.slice(0, temp.size - MAX_TEMP_CHATS)) discardTemp(key)
}

const SLUG_RE = /^[\w-]{1,60}$/
const MAX_PROMPT = 12_000
const MAX_MESSAGES = 200
const MAX_TEXT = 60_000 // one answer; guards a runaway response from bloating the file
const MAX_TOOLS_PER_TURN = 40
/** Read-only questions are quick; a full-tools turn may drive a browser or write files. */
const CHAT_TIMEOUT = 300_000
const CHAT_TIMEOUT_FULL = 900_000
/** A web answer waits on someone else's servers; a research report waits on several. */
const CHAT_TIMEOUT_WEB = 600_000
const CHAT_TIMEOUT_RESEARCH = 1_200_000
const MAX_SUGGESTIONS = 3
const MAX_SUGGESTION_CHARS = 70

/**
 * Follow-up suggestions — "what would I usefully ask next?", the same idea as the
 * Prototype page's `<!-- SUGGESTIONS: … -->` (routes/prototype.ts).
 *
 * They ride along with the ANSWER rather than being a second AI call afterwards. A
 * follow-up call would double the turns the page costs and leave the user waiting again
 * after the answer already finished — for three chips. This way they cost one extra line
 * of output, and they arrive with the `done` frame.
 */
const SUGGEST_BLOCK =
  `\n\n--- AFTER YOUR ANSWER ---\n` +
  `End your reply with ONE line, on its own, in exactly this form:\n` +
  `<!-- SUGGESTIONS: first | second | third -->\n` +
  `They are up to ${MAX_SUGGESTIONS} SHORT (max ~7 words) follow-up questions or requests the ` +
  `QC engineer would plausibly send NEXT, written in their voice as a message to you ` +
  `(e.g. "Draft test cases for this", "Show me the validation rules", "Which endpoints does it call?"). ` +
  `Make them specific to what you just answered and to this project — never generic filler, ` +
  `never something you already covered. Separate them with | and nothing else. ` +
  `If nothing useful comes to mind, write exactly: <!-- SUGGESTIONS: none -->\n` +
  `This comment is stripped before the answer is shown, so it must be the LAST thing you write ` +
  `and must not be mentioned in the answer itself.`

/**
 * Split the trailing SUGGESTIONS comment off an answer. The comment is REMOVED from the
 * stored text no matter what: a raw HTML comment in the transcript is worse than no
 * suggestions, so parsing failures fall back to "no chips", never to leaking the marker.
 */
function splitSuggestions(raw: string): { text: string; suggestions: string[] } {
  const re = /<!--\s*SUGGESTIONS:([\s\S]*?)-->/gi
  let body = ''
  // Take the LAST one — a turn that quoted the instruction back would otherwise win.
  for (const m of raw.matchAll(re)) body = m[1]
  const text = raw.replace(re, '').trimEnd()
  const suggestions = body
    .split('|')
    .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, MAX_SUGGESTION_CHARS))
    .filter((s) => s && s.toLowerCase() !== 'none')
    .slice(0, MAX_SUGGESTIONS)
  return { text, suggestions }
}

/**
 * Pasted screenshots. The CLI takes a prompt, not image bytes — but it can READ an image
 * file, so an image reaches the model by being written to disk and named in the prompt.
 * Only these types (what a screenshot tool actually produces); the extension comes from
 * the MIME, never from the client's file name.
 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

function chatDir(root: string): string {
  return path.join(testingDirFor(root), 'chats')
}

function imageDir(root: string): string {
  return path.join(chatDir(root), 'images')
}

function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return s || 'chat'
}

/** Resolve <dir>/<slug>.json, refusing anything that could escape the folder. */
function itemFile(root: string, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null
  const dir = chatDir(root)
  const target = path.resolve(dir, `${slug}.json`)
  if (target !== path.join(dir, `${slug}.json`)) return null
  return target
}

function readChat(root: string, slug: string): Chat | null {
  const f = itemFile(root, slug)
  if (!f) return null
  try {
    const c = JSON.parse(fs.readFileSync(f, 'utf8')) as Chat
    if (!Array.isArray(c.messages)) c.messages = []
    if (c.tools !== 'full') c.tools = 'read'
    return c
  } catch {
    return null
  }
}

function writeChat(root: string, c: Chat): void {
  const f = itemFile(root, c.slug)
  if (!f) throw new Error('invalid slug')
  fs.mkdirSync(chatDir(root), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(c, null, 2), 'utf8')
}

function uniqueSlug(root: string, base: string): string {
  const dir = chatDir(root)
  const taken = (s: string) =>
    // A temporary conversation has no file, so the folder alone isn't the whole answer:
    // reusing its slug would make the next chat resolve to the in-memory one instead.
    fs.existsSync(path.join(dir, `${s}.json`)) || temp.has(liveKey(root, s))
  let slug = base
  let n = 2
  while (taken(slug)) slug = `${base}-${n++}`.slice(0, 60)
  return slug
}

/**
 * The conversation behind a slug, wherever it lives — the temporary registry first, then
 * the transcript folder. Every route reads through this so a temporary chat behaves like a
 * normal one (open it, stop it, rename it, re-attach to its turn).
 */
function loadChat(root: string, slug: string): Chat | null {
  const t = temp.get(liveKey(root, slug))
  if (t) {
    t.at = Date.now()
    return t.chat
  }
  return readChat(root, slug)
}

/**
 * Persist a conversation to wherever it belongs. `temporary` is the one bit that decides
 * whether a turn touches the project folder at all — so this is the ONLY place a chat is
 * saved from, and `writeChat` is never called directly by a route.
 */
function saveChat(root: string, chat: Chat, newImages: string[] = []): void {
  if (!chat.temporary) {
    writeChat(root, chat)
    return
  }
  const key = liveKey(root, chat.slug)
  const existing = temp.get(key)
  temp.set(key, {
    chat,
    images: [...(existing?.images ?? []), ...newImages],
    at: Date.now(),
  })
  sweepTemp()
}

function listChats(root: string): ChatSummary[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(chatDir(root), { withFileTypes: true })
  } catch {
    return [] // no chats yet
  }
  const out: ChatSummary[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue
    const c = readChat(root, e.name.slice(0, -5))
    if (!c) continue
    const last = c.messages.at(-1)
    out.push({
      slug: c.slug,
      name: c.name,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      model: c.model,
      tools: c.tools,
      messageCount: c.messages.length,
      preview: (last?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      pinned: c.pinned || undefined,
      // A reply is being generated in this one right now — the rail marks it, which is
      // how the engineer knows an answer is still coming after leaving the page.
      running: live.has(liveKey(root, c.slug)) || undefined,
    })
  }
  // Pinned first, then newest — the rail groups by date, and a starred conversation has to
  // outrank its own date or pinning a week-old chat would leave it buried under "Older".
  return out.sort(
    (a, b) =>
      Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
  )
}

/**
 * Name a brand-new conversation after its first question, the way every chat app does —
 * it's the only label that means anything in the history rail. Falls back to a date.
 */
function nameFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim()
  if (!line) return `Chat ${new Date().toLocaleDateString()}`
  return line.length > 48 ? `${line.slice(0, 48).trimEnd()}…` : line
}

function pickModel(v: unknown, fallback: string): string {
  return typeof v === 'string' && CRAWL_SUMMARY_MODELS.has(v) ? v : fallback
}

function pickTools(v: unknown, fallback: ChatTools): ChatTools {
  return v === 'read' || v === 'full' ? v : fallback
}

function pickAction(v: unknown): ChatAction | null {
  return v === 'web' || v === 'research' || v === 'diagram' ? v : null
}

/**
 * What each `+` menu action tells the model to do differently.
 *
 * Each block is written to survive being read alongside the project's CLAUDE.md and the
 * user's own message, so they say what the OUTPUT must be rather than "be helpful": a web
 * answer without its sources is unusable to a QC engineer who has to justify it, and a
 * research report that quietly answers from memory is worse than no report.
 */
const ACTION_BLOCKS: Record<ChatAction, string> = {
  web:
    `\n\n--- WEB SEARCH ---\n` +
    `Answer from the LIVE WEB, not from memory. Use WebSearch, and WebFetch to open the ` +
    `results worth reading. Say when each thing you report was published or last updated, ` +
    `and end with a short "Sources" list of the URLs you actually used. If the searches turn ` +
    `up nothing solid, say exactly that instead of filling the gap from memory — and never ` +
    `present a remembered version number, price, API shape or date as a search result. ` +
    `If the question is also about this project, read the repo for that half and keep the two ` +
    `apart ("the docs say X; this project currently does Y").\n`,
  research:
    `\n\n--- DEEP RESEARCH ---\n` +
    `Produce a RESEARCH REPORT, not a chat reply. Work in this order:\n` +
    `1. Break the question into the 3-6 sub-questions that actually decide the answer.\n` +
    `2. Search for each one (WebSearch), rephrasing when a search comes back thin, and open ` +
    `the most promising sources with WebFetch rather than trusting the snippet.\n` +
    `3. Cross-check every load-bearing claim against a SECOND independent source. Where ` +
    `sources disagree, report the disagreement — don't average it away.\n` +
    `4. If the question touches this project, gather the repo/ticket evidence too, and keep ` +
    `it visibly separate from what the web says.\n` +
    `Then write, in Markdown: **Summary** (3-5 bullets, the answer itself) — **Findings** ` +
    `(one short section per sub-question, each claim followed by its source link) — ` +
    `**Conflicts & gaps** (what the sources disagree on, and what you could NOT establish) — ` +
    `**Sources** (title — URL — date). Mark your own inference as inference. An honest gap is ` +
    `a finding; a confident guess is a defect.\n`,
  diagram:
    `\n\n--- DIAGRAM ---\n` +
    `Answer WITH A DIAGRAM: one Mermaid code fence (\`\`\`mermaid) plus a couple of ` +
    `sentences saying what it shows and anything it deliberately leaves out. The portal ` +
    `renders that fence as a picture, so the diagram is the answer — don't also spell the ` +
    `whole thing out in prose.\n` +
    `Pick the type that fits: flowchart TD for a flow or decision tree, sequenceDiagram for ` +
    `an interaction between parties/services, stateDiagram-v2 for the states a screen or ` +
    `record moves through, erDiagram for data. Keep node labels under ~6 words; WRAP ANY ` +
    `label containing punctuation, brackets or a slash in double quotes (Mermaid breaks on ` +
    `unquoted "(" and ":"). No HTML, no inline styling, no theme directives. If the diagram ` +
    `describes THIS project, read the relevant code/ticket/test cases first and label it ` +
    `from what's really there — a plausible-looking flow that isn't the real one is the worst ` +
    `possible output here.\n`,
}

/**
 * Which tools this turn may use.
 *
 * `read` — the default, and what "ask a question about my project" needs: Claude can
 * Grep/Glob/Read the repo but cannot change it, and `--strict-mcp-config` skips loading
 * the project's MCP servers so the answer starts in a second rather than ~20.
 * `full` — bypassPermissions, so the turn can actually DO the thing (write a file, drive
 * the Playwright browser via .mcp.json). The UI makes this an explicit, labeled choice.
 *
 * Both flags are variadic; the prompt is delivered over STDIN (never as a trailing
 * positional), so a tool name can't swallow it.
 */
function toolArgs(tools: ChatTools, action: ChatAction | null): string[] {
  if (tools === 'full') return ['--permission-mode', 'bypassPermissions']
  const allowed = ['Read', 'Grep', 'Glob']
  // Read-only mode is an allow-LIST, so a web action that isn't listed here doesn't just
  // answer worse — the model is denied the tool and answers from memory instead, which is
  // exactly the failure the action exists to prevent. (Verified working headlessly.)
  if (action === 'web' || action === 'research') allowed.push('WebSearch', 'WebFetch')
  return ['--allowedTools', ...allowed, '--strict-mcp-config']
}

/**
 * How long the turn may take. The action matters more than the tool mode here: a research
 * report is a dozen network round trips plus the writing, and cutting it off at the ordinary
 * five minutes would reliably produce half a report.
 */
function timeoutFor(tools: ChatTools, action: ChatAction | null): number {
  const byTools = tools === 'full' ? CHAT_TIMEOUT_FULL : CHAT_TIMEOUT
  const byAction =
    action === 'research' ? CHAT_TIMEOUT_RESEARCH : action === 'web' ? CHAT_TIMEOUT_WEB : 0
  return Math.max(byTools, byAction)
}

/**
 * Save the images pasted with a message and return their on-disk file names.
 *
 * The name is generated here (timestamp + index + MIME-derived extension) rather than
 * taken from the client: a pasted screenshot usually has no name at all, and a name that
 * came over the wire is a path-traversal waiting to happen.
 */
function saveImages(root: string, raw: unknown): { file: string; abs: string }[] {
  if (!Array.isArray(raw) || !raw.length) return []
  const dir = imageDir(root)
  const out: { file: string; abs: string }[] = []
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  for (const item of raw.slice(0, MAX_IMAGES)) {
    const o = (item ?? {}) as Record<string, unknown>
    const mime = typeof o.mime === 'string' ? o.mime : ''
    const ext = IMAGE_EXT[mime]
    const data = typeof o.data === 'string' ? o.data : ''
    if (!ext || !data) continue
    const bytes = Buffer.from(data, 'base64')
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) continue
    const file = `${stamp}-${out.length + 1}.${ext}`
    const abs = path.join(dir, file)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(abs, bytes)
    } catch {
      continue // one unwritable image must not lose the whole question
    }
    out.push({ file, abs })
  }
  return out
}

/**
 * `@`-mentions — the project artifacts a message is ABOUT.
 *
 * A question like "are these cases enough?" only means something next to a ticket, and
 * making the engineer paste a path (or hope Claude greps for the right folder) is the slow
 * way to say it. So the composer's `@` picker names a crawled ticket or its test cases, and
 * this resolves each one to real files — same trick as the images: absolute paths in the
 * prompt, opened with Read. Nothing is inlined, so tagging five tickets costs a few lines
 * of prompt rather than 200 KB of ticket text.
 */
interface Mention {
  kind: 'ticket' | 'testcase'
  /** Folder under testing/tickets/ — possibly nested (PARENT/CHILD), as the UI reports it. */
  folder: string
  /** For a testcase mention: which version, or null/absent for the newest. */
  version?: number | null
}

const MAX_MENTIONS = 8

/** Resolve & path-guard a possibly-nested ticket folder. Null if it escapes or is absent. */
function ticketDirFor(root: string, folder: string): string | null {
  const base = ticketsDirFor(root)
  // Sanitize per SEGMENT: the folder may legitimately contain '/' (a subtask nests under
  // its parent), so a whole-string sanitizer would collapse the nesting.
  const segments = folder
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..')
  if (!segments.length || segments.length > 4) return null
  if (segments.some((s) => !/^[\w.@ -]{1,80}$/.test(s))) return null
  const abs = path.resolve(base, ...segments)
  if (abs !== path.join(base, ...segments) || !fs.existsSync(abs)) return null
  return abs
}

/** The ticket's display id (ABC-123) if it crawled with one, else the folder's leaf. */
function ticketLabel(dir: string, folder: string): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'ticket.json'), 'utf8')) as {
      displayId?: unknown
    }
    if (typeof j.displayId === 'string' && j.displayId.trim()) return j.displayId.trim()
  } catch {
    /* no ticket.json, or unreadable — the folder name is a fine label */
  }
  return folder.split(/[\\/]/).pop() || folder
}

/**
 * Turn the mentions into a prompt block naming real files, and report which ones resolved
 * (the client echoes those back into the transcript). An unresolvable mention is dropped
 * silently rather than sent as a path that doesn't exist — a hallucinated Read failure mid
 * answer is worse than the tag simply not appearing.
 */
function resolveMentions(
  root: string,
  raw: unknown,
): { block: string; resolved: { kind: string; label: string }[] } {
  if (!Array.isArray(raw) || !raw.length) return { block: '', resolved: [] }
  const lines: string[] = []
  const resolved: { kind: string; label: string }[] = []
  const seen = new Set<string>()
  for (const item of raw.slice(0, MAX_MENTIONS)) {
    const m = (item ?? {}) as Partial<Mention>
    if (m.kind !== 'ticket' && m.kind !== 'testcase') continue
    if (typeof m.folder !== 'string') continue
    const key = `${m.kind}:${m.folder}:${m.version ?? 'latest'}`
    if (seen.has(key)) continue
    seen.add(key)
    const dir = ticketDirFor(root, m.folder)
    if (!dir) continue
    const label = ticketLabel(dir, m.folder)

    if (m.kind === 'ticket') {
      const files = ['ticket.md', 'comments.md', 'summary.md'].filter((f) =>
        fs.existsSync(path.join(dir, f)),
      )
      if (!files.length) continue
      lines.push(
        `- TICKET ${label} — read ${files.map((f) => path.join(dir, f)).join(', ')}` +
          ` (its attachments, if any, are in ${path.join(dir, 'attachments')})`,
      )
      resolved.push({ kind: 'ticket', label })
      continue
    }

    // Test cases: a specific version if asked for, otherwise the newest — which is what
    // "the test cases for X" means, and saves the picker a request per ticket to find out.
    const versions = listTestcaseVersions(dir)
    if (!versions.length) continue
    const pick =
      typeof m.version === 'number'
        ? versions.find((v) => v.version === m.version)
        : versions[versions.length - 1]
    if (!pick) continue
    lines.push(
      `- TEST CASES for ${label} (${pick.label}) — read ${path.join(dir, pick.file)}` +
        (pick.format === 'csv' ? ' (CSV)' : ''),
    )
    resolved.push({ kind: 'testcase', label: `${label} ${pick.label}` })
  }
  if (!lines.length) return { block: '', resolved: [] }
  return {
    block:
      `\n\n--- TAGGED WITH @ IN THIS MESSAGE ---\n` +
      `The user tagged these project artifacts; they are what the question is about. Read them ` +
      `with the Read tool BEFORE answering, and don't guess at their contents:\n${lines.join('\n')}\n`,
    resolved,
  }
}

/**
 * How the model is told about the images: absolute paths plus an instruction to Read
 * them. Absolute, because `cwd` is the project root but the files live under testing/ —
 * a relative path would be one more thing to get wrong.
 */
function imagePromptBlock(images: { abs: string }[]): string {
  if (!images.length) return ''
  const list = images.map((i) => `- ${i.abs}`).join('\n')
  return (
    `\n\n--- IMAGES ATTACHED TO THIS MESSAGE ---\n` +
    `The user pasted ${images.length === 1 ? 'this screenshot' : 'these screenshots'} into the chat. ` +
    `Open ${images.length === 1 ? 'it' : 'each of them'} with the Read tool BEFORE answering — ` +
    `Read renders images, so you can see what they show:\n${list}\n`
  )
}

// ------------------------------------------------------------- turns in flight

/**
 * A turn that is currently being generated.
 *
 * The run belongs to the CONVERSATION, not to the HTTP request that started it. Closing
 * the browser tab, reloading, or navigating to another page used to abort the CLI child —
 * and because the transcript is only written when a turn finishes, the question and the
 * half-written answer both vanished. (Verified: reload after six seconds of visible text
 * left no conversation on disk at all.)
 *
 * So the turn is registered here and keeps running with nobody watching, exactly like the
 * portal's other background jobs (crawl, test-case generation). Viewers attach and detach;
 * the answer is buffered so a late viewer can be caught up in one frame. Only an explicit
 * `POST /:slug/stop` — the Stop button — cancels it.
 *
 * In memory on purpose: a server restart drops it, same as `crawlJobs` / `testcaseJobs`.
 */
interface LiveTurn {
  key: string
  slug: string
  /** The question, echoed to a viewer that attaches after the turn started. */
  prompt: string
  at: string
  /** Image file names pasted with the question (already on disk by now). */
  images: string[]
  /** Everything streamed so far — replayed to a re-attaching viewer, and what gets saved if stopped. */
  answer: string
  calls: { name: string; detail?: string }[]
  abort: AbortController
  /**
   * The conversation was deleted while this turn was running. The turn is aborted at the
   * same moment, but it still has to fall through its own save path — and saving there
   * would write the transcript back to disk (or re-insert a temporary chat into the
   * registry) a moment after the engineer deleted it.
   */
  discarded?: boolean
  viewers: Set<import('express').Response>
}

const live = new Map<string, LiveTurn>()
/** Backstop against a runaway client; a turn clears itself the moment it finishes. */
const MAX_LIVE_TURNS = 8

const liveKey = (root: string, slug: string) => `${root}::${slug}`

function addViewer(turn: LiveTurn, res: import('express').Response): void {
  turn.viewers.add(res)
  // A viewer leaving is just that — it must NOT cancel the run (that's the whole point).
  res.on('close', () => turn.viewers.delete(res))
}

function emit(turn: LiveTurn, obj: unknown): void {
  const line = `data: ${JSON.stringify(obj)}\n\n`
  for (const r of turn.viewers) {
    try {
      r.write(line)
    } catch {
      /* socket closed; the close handler drops it */
    }
  }
}

/** Last frame: deliver it, close every attached viewer, and de-register the turn. */
function finish(turn: LiveTurn, obj: unknown): void {
  emit(turn, obj)
  for (const r of turn.viewers) {
    try {
      r.end()
    } catch {
      /* already gone */
    }
  }
  turn.viewers.clear()
  live.delete(turn.key)
}

function sseHead(res: import('express').Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a proxy buffer the stream
  })
}

// ------------------------------------------------------------------------ routes
// NOTE: every fixed path below MUST stay above `GET /:slug`, which would swallow it.

/** GET /api/chat — the project's conversations, newest first (no message bodies). */
chatRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ chats: listChats(project.rootPath) })
})

/** POST /api/chat/open — reveal testing/chats in the OS file explorer. */
chatRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = chatDir(project.rootPath)
  fs.mkdirSync(dir, { recursive: true })
  try {
    await revealFolderNative(dir)
    res.json({ ok: true, path: dir })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * GET /api/chat/images/:name — an image pasted into a message, so the transcript can show
 * it. Read-only, name-guarded to the one folder; anything else is a 400 rather than a
 * lookup outside it.
 */
chatRouter.get('/images/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const name = req.params.name
  if (!/^[\w-]{1,64}\.(png|jpg|webp|gif)$/.test(name)) {
    return res.status(400).json({ error: 'invalid image name' })
  }
  const dir = imageDir(project.rootPath)
  const abs = path.resolve(dir, name)
  if (abs !== path.join(dir, name) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: 'image not found' })
  }
  res.sendFile(abs)
})

/**
 * POST /api/chat/stream — send a message and stream the reply (Server-Sent Events).
 * Body: { projectId, prompt, slug?, model?, tools?, images?: [{mime, data}],
 *         mentions?: [{kind:'ticket'|'testcase', folder, version?}] }.
 * Frames: {type:'start', slug} as soon as the conversation exists (so the client can
 * adopt a brand-new one), {type:'delta', text} per token, {type:'tool', name} per tool
 * call, {type:'log', level, text}, then {type:'done', chat} or {type:'error', error}.
 */
chatRouter.post('/stream', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  // Bind the root once: the turn runner below is a hoisted function declaration, which
  // doesn't inherit the `project` narrowing from the guard above.
  const root = project.rootPath
  const b = (req.body ?? {}) as Record<string, unknown>
  const typed = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, MAX_PROMPT) : ''
  const hasImages = Array.isArray(b.images) && b.images.length > 0
  if (!typed && !hasImages) return res.status(400).json({ error: 'prompt is required' })
  const slug = typeof b.slug === 'string' ? b.slug : ''
  const existing = slug ? loadChat(root, slug) : null
  if (slug && !existing) return res.status(404).json({ error: 'chat not found' })
  // `temporary` is chosen when the conversation is CREATED and then belongs to it: a
  // follow-up in an existing chat inherits its flag, because the alternative is a turn that
  // silently writes a "temporary" transcript to disk (or half a conversation on disk and
  // half in memory).
  const temporary = existing ? !!existing.temporary : b.temporary === true

  // Pasted screenshots are written to disk here; the model sees them by READING those
  // files (see saveImages / imagePromptBlock) — the CLI takes a prompt, not image bytes.
  // The stored prompt keeps the user's own words, so the transcript reads naturally.
  const images = saveImages(root, b.images)
  // An image on its own is a legitimate message ("what's wrong with this?"), so give it a
  // prompt rather than rejecting it — with nothing said, describing it is the useful reply.
  const prompt = typed || 'Take a look at the attached screenshot.'
  const mentions = resolveMentions(root, b.mentions)
  // The `+` menu action applies to THIS message only (see ChatAction): it changes the
  // instructions, the allowed tools and the time budget, and nothing about the conversation.
  const action = pickAction(b.action)
  const promptForClaude =
    prompt +
    mentions.block +
    imagePromptBlock(images) +
    (action ? ACTION_BLOCKS[action] : '') +
    SUGGEST_BLOCK

  const model = pickModel(b.model, existing?.model || 'sonnet')
  const tools = pickTools(b.tools, existing?.tools || 'read')
  const now = new Date().toISOString()

  const chat: Chat = existing ?? {
    slug: uniqueSlug(root, slugify(nameFromPrompt(prompt))),
    name: nameFromPrompt(prompt),
    createdAt: now,
    updatedAt: now,
    model,
    tools,
    sessionId: null,
    temporary: temporary || undefined,
    messages: [],
  }
  chat.model = model
  chat.tools = tools

  // One reply at a time per conversation: a second turn would resume the same CLI session
  // concurrently and interleave two answers into one transcript.
  const key = liveKey(root, chat.slug)
  if (live.has(key)) {
    return res.status(409).json({ error: 'a reply is already being generated in this conversation' })
  }
  if (live.size >= MAX_LIVE_TURNS) {
    return res.status(429).json({ error: 'too many replies in flight — wait for one to finish' })
  }

  const ac = new AbortController()
  const turn: LiveTurn = {
    key,
    slug: chat.slug,
    prompt,
    at: now,
    images: images.map((i) => i.file),
    answer: '',
    calls: [],
    abort: ac,
    viewers: new Set(),
  }
  live.set(key, turn)
  // Record the conversation NOW, before a word of the answer exists. A brand-new chat had
  // no file until its first turn finished, so a reload mid-answer had nothing to re-open
  // and nothing to re-attach to — the question was gone even though the run wasn't.
  // (For a temporary chat this is the in-memory registry, never the project folder.)
  saveChat(root, chat, turn.images)

  sseHead(res)
  addViewer(turn, res)
  const send = (obj: unknown) => emit(turn, obj)

  // The conversation exists from here on — tell the client its slug now, so a Stop or a
  // reload mid-answer still lands on the right conversation instead of orphaning it.
  send({ type: 'start', slug: chat.slug, name: chat.name })

  // Say what a tag resolved to. A silent drop (renamed folder, test cases deleted since)
  // would otherwise look like the model ignored the tag.
  if (Array.isArray(b.mentions) && b.mentions.length) {
    const asked = Math.min(b.mentions.length, MAX_MENTIONS)
    send({
      type: 'log',
      level: mentions.resolved.length < asked ? 'error' : 'info',
      text: mentions.resolved.length
        ? `Tagged: ${mentions.resolved.map((r) => r.label).join(', ')}` +
          (mentions.resolved.length < asked
            ? ` — ${asked - mentions.resolved.length} tag(s) no longer exist on disk`
            : '')
        : 'None of the tagged items could be found on disk — answering without them.',
    })
  }

  if (action) {
    // Named in the log because the wait is visibly different: a research turn spends its
    // first minute searching, which reads as "stuck" without a line saying what it is.
    send({
      type: 'log',
      level: 'info',
      text:
        action === 'diagram'
          ? 'Drawing a diagram…'
          : action === 'research'
            ? 'Deep research — searching, cross-checking, then writing the report…'
            : 'Searching the web…',
    })
  }

  const usedTools: string[] = []
  let sessionId: string | null = null

  /** Save the transcript — unless the conversation was deleted while the turn ran. */
  const persist = () => {
    if (!turn.discarded) saveChat(root, chat)
  }

  /**
   * One turn. Split out because a `--resume` whose session the CLI no longer has fails
   * outright — and silently losing the user's question to a stale id would be the worst
   * outcome, so we retry once as a fresh session (context is gone, the answer isn't).
   */
  async function runTurn(resume: string | null) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(resume ? ['--resume', resume] : []),
      ...toolArgs(tools, action),
      '--model',
      model,
    ]
    return runClaudeStream(
      args,
      timeoutFor(tools, action),
      (log) => {
        // Tool calls are surfaced as their own frame so the UI can draw an activity
        // trail ("Read · Grep · Read") instead of dumping log lines into the bubble.
        if (log.tool) {
          if (usedTools.length < MAX_TOOLS_PER_TURN) {
            usedTools.push(log.tool.name)
            // `detail` (the file, the pattern, the command) is streamed for the live
            // waiting indicator only — the saved transcript keeps names alone. Kept on
            // the turn too, so a viewer that attaches late still sees the whole trail.
            turn.calls.push({ name: log.tool.name, detail: log.tool.detail })
            send({ type: 'tool', name: log.tool.name, detail: log.tool.detail })
          }
          return
        }
        send({ type: 'log', level: log.level, text: log.text })
      },
      {
        usageSource: 'chat',
        model,
        input: promptForClaude, // over stdin — a long question must not hit the argv cap
        cwd: root, // the project's CLAUDE.md / Knowledge / Memory are in scope
        signal: ac.signal,
        onDelta: (text) => {
          // Buffered as well as sent: this is what a re-attaching viewer is caught up
          // with, and what gets saved if the turn is stopped before the CLI's final
          // `result` event (which is where r.text comes from — it never arrives on a kill).
          turn.answer += text
          send({ type: 'delta', text })
        },
        suppressAssistantText: true, // already streamed as deltas; don't duplicate
        onSession: (id) => {
          sessionId = id
        },
      },
    )
  }

  let r = await runTurn(chat.sessionId)
  if (!ac.signal.aborted && chat.sessionId && r.isError && !r.text) {
    send({ type: 'log', level: 'info', text: 'Previous session unavailable — starting a fresh one.' })
    chat.sessionId = null
    usedTools.length = 0
    turn.calls.length = 0
    turn.answer = ''
    r = await runTurn(null)
  }

  if (ac.signal.aborted) {
    // The user pressed Stop. Persist what was said anyway — a partial answer they can
    // read beats a question that vanished.
    //
    // It comes from the BUFFER, not from r.text: killing the child means the CLI's final
    // `result` message never arrives, so r.text is empty and the old code here saved
    // nothing at all (verified — the conversation didn't even exist afterwards).
    const partial = (turn.answer || r.text).trim()
    if (partial) {
      appendTurn(partial, true)
      persist()
    }
    finish(turn, { type: 'stopped', chat: partial ? chat : undefined })
    return
  }

  const text = r.text.trim()
  // "Nothing but the suggestions marker" is an empty answer, not a one-line one.
  if (!splitSuggestions(text).text.trim()) {
    const why = r.timedOut
      ? 'Claude took too long to answer. Try a narrower question, or switch to a faster model.'
      : 'Claude returned nothing. Check that Auto Agent is connected on the sidebar.'
    appendTurn(why, true)
    persist()
    finish(turn, { type: 'error', error: why, chat })
    return
  }

  appendTurn(text, r.isError)
  persist()
  finish(turn, { type: 'done', chat })

  /** Record this turn (both sides) and the session that now backs the conversation. */
  function appendTurn(answer: string, failed: boolean): void {
    const at = new Date().toISOString()
    // Always split, even on a failed/aborted turn: the marker must never reach the
    // transcript, and a stopped answer occasionally still carries one.
    const { text: body, suggestions } = splitSuggestions(answer)
    chat.messages.push(
      {
        role: 'user',
        text: prompt,
        at,
        images: images.length ? images.map((i) => i.file) : undefined,
        action: action ?? undefined,
      },
      {
        role: 'assistant',
        text: body.slice(0, MAX_TEXT),
        at,
        tools: usedTools.length ? [...usedTools] : undefined,
        model,
        error: failed || undefined,
        suggestions: !failed && suggestions.length ? suggestions : undefined,
      },
    )
    chat.messages = chat.messages.slice(-MAX_MESSAGES)
    // Only adopt a session id once the turn actually produced something — otherwise a
    // failed turn would pin the conversation to a session that answers nothing.
    if (sessionId) chat.sessionId = sessionId
    chat.updatedAt = at
  }
})

/**
 * GET /api/chat/:slug/stream — watch a reply that is ALREADY being generated (SSE).
 *
 * This is what makes a reload or a trip to another page harmless: the turn kept running
 * (see LiveTurn), and re-opening the conversation re-attaches to it. The viewer is caught
 * up first — `start`, a `resume` frame with the question, the whole answer so far as one
 * delta, and every tool call — then it receives live frames like any other viewer.
 *
 * 404 when nothing is in flight, which is also how the client decides to stop trying.
 */
chatRouter.get('/:slug/stream', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = loadChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  const turn = live.get(liveKey(project.rootPath, chat.slug))
  if (!turn) return res.status(404).json({ error: 'no reply in progress' })

  sseHead(res)
  addViewer(turn, res)
  const one = (obj: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* socket closed */
    }
  }
  one({ type: 'start', slug: chat.slug, name: chat.name })
  one({ type: 'resume', slug: chat.slug, prompt: turn.prompt, at: turn.at, images: turn.images })
  // The backlog as ONE delta: the smooth-reveal hook drains it at its own pace, so a
  // 10 KB catch-up doesn't slam onto the screen in a single frame either.
  if (turn.answer) one({ type: 'delta', text: turn.answer })
  for (const c of turn.calls) one({ type: 'tool', name: c.name, detail: c.detail })
})

/**
 * POST /api/chat/:slug/stop — cancel a reply in flight.
 *
 * Since a closed browser tab no longer cancels anything, this is the ONLY way to stop a
 * turn. Whatever was already written is saved (marked as a failed turn) so the question
 * and the partial answer stay in the transcript.
 */
chatRouter.post('/:slug/stop', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const turn = live.get(liveKey(project.rootPath, req.params.slug))
  if (!turn) return res.status(404).json({ error: 'no reply in progress' })
  turn.abort.abort()
  res.json({ ok: true })
})

/** GET /api/chat/:slug — one conversation in full. */
chatRouter.get('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = loadChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  // Tells the page to re-attach to a turn that's still running (see /:slug/stream).
  if (live.has(liveKey(project.rootPath, chat.slug))) {
    return res.json({ ...chat, running: true })
  }
  res.json(chat)
})

/** POST /api/chat/:slug/rename — display name only; the slug (and file) stay put. */
chatRouter.post('/:slug/rename', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = loadChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name is required' })
  chat.name = name
  saveChat(project.rootPath, chat)
  res.json(chat)
})

/**
 * POST /api/chat/:slug/pin — star / unstar. Body: { pinned: boolean }.
 *
 * Deliberately does NOT touch `updatedAt`: that field orders the rail's date groups, so
 * starring a conversation would otherwise also yank it into "Today" and quietly rewrite
 * when it was last worked on.
 */
chatRouter.post('/:slug/pin', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = loadChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  // Starring means "keep this where I can find it again", which is the opposite of what a
  // temporary conversation is. Refuse rather than write a pin nothing will ever read.
  if (chat.temporary) {
    return res.status(400).json({ error: 'a temporary conversation is not kept in history' })
  }
  chat.pinned = req.body?.pinned === true ? true : undefined
  saveChat(project.rootPath, chat)
  res.json(chat)
})

/**
 * DELETE /api/chat/:slug — remove the conversation.
 *
 * For a temporary one this is "end chat": it is forgotten from the registry along with any
 * images it wrote, and there is no file to unlink. `fs.rmSync` with `force` is a no-op on a
 * missing path, so the disk half stays unconditional and covers a stale/half state too.
 */
chatRouter.delete('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const f = itemFile(project.rootPath, req.params.slug)
  if (!f) return res.status(400).json({ error: 'invalid slug' })
  const key = liveKey(project.rootPath, req.params.slug)
  // A reply still being written to a conversation being deleted would resurrect it in the
  // registry when it finished, so stop it first.
  const turn = live.get(key)
  if (turn) {
    turn.discarded = true
    turn.abort.abort()
  }
  discardTemp(key)
  try {
    fs.rmSync(f, { force: true })
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
  res.json({ ok: true })
})
