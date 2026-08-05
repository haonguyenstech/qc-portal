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
 * routes/prototype.ts (no DB), so a conversation versions with the project.
 */

export type ChatTools = 'read' | 'full'

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
}

const SLUG_RE = /^[\w-]{1,60}$/
const MAX_PROMPT = 12_000
const MAX_MESSAGES = 200
const MAX_TEXT = 60_000 // one answer; guards a runaway response from bloating the file
const MAX_TOOLS_PER_TURN = 40
/** Read-only questions are quick; a full-tools turn may drive a browser or write files. */
const CHAT_TIMEOUT = 300_000
const CHAT_TIMEOUT_FULL = 900_000

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
  let slug = base
  let n = 2
  while (fs.existsSync(path.join(dir, `${slug}.json`))) slug = `${base}-${n++}`.slice(0, 60)
  return slug
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
    })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
function toolArgs(tools: ChatTools): string[] {
  if (tools === 'full') return ['--permission-mode', 'bypassPermissions']
  return ['--allowedTools', 'Read', 'Grep', 'Glob', '--strict-mcp-config']
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
  const existing = slug ? readChat(root, slug) : null
  if (slug && !existing) return res.status(404).json({ error: 'chat not found' })

  // Pasted screenshots are written to disk here; the model sees them by READING those
  // files (see saveImages / imagePromptBlock) — the CLI takes a prompt, not image bytes.
  // The stored prompt keeps the user's own words, so the transcript reads naturally.
  const images = saveImages(root, b.images)
  // An image on its own is a legitimate message ("what's wrong with this?"), so give it a
  // prompt rather than rejecting it — with nothing said, describing it is the useful reply.
  const prompt = typed || 'Take a look at the attached screenshot.'
  const mentions = resolveMentions(root, b.mentions)
  const promptForClaude = prompt + mentions.block + imagePromptBlock(images)

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
    messages: [],
  }
  chat.model = model
  chat.tools = tools

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a proxy buffer the stream
  })
  const send = (obj: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`)
    } catch {
      /* socket closed */
    }
  }

  const ac = new AbortController()
  // Detect a real client disconnect via the RESPONSE stream. (req 'close' fires as soon
  // as express.json consumes the POST body, which would abort instantly.)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

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

  const usedTools: string[] = []
  let sessionId: string | null = null

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
      ...toolArgs(tools),
      '--model',
      model,
    ]
    return runClaudeStream(
      args,
      tools === 'full' ? CHAT_TIMEOUT_FULL : CHAT_TIMEOUT,
      (log) => {
        // Tool calls are surfaced as their own frame so the UI can draw an activity
        // trail ("Read · Grep · Read") instead of dumping log lines into the bubble.
        const tool = /^⚙ (.+)$/.exec(log.text)
        if (tool && usedTools.length < MAX_TOOLS_PER_TURN) {
          usedTools.push(tool[1])
          send({ type: 'tool', name: tool[1] })
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
        onDelta: (text) => send({ type: 'delta', text }),
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
    r = await runTurn(null)
  }

  if (ac.signal.aborted) {
    // The user pressed Stop (or navigated away). Persist what was said anyway: a partial
    // answer they can read beats a question that vanished.
    if (r.text.trim()) {
      appendTurn(r.text.trim(), true)
      writeChat(root, chat)
    }
    if (!res.writableEnded) res.end()
    return
  }

  const text = r.text.trim()
  if (!text) {
    const why = r.timedOut
      ? 'Claude took too long to answer. Try a narrower question, or switch to a faster model.'
      : 'Claude returned nothing. Check that Auto Agent is connected on the sidebar.'
    appendTurn(why, true)
    writeChat(root, chat)
    send({ type: 'error', error: why, chat })
    res.end()
    return
  }

  appendTurn(text, r.isError)
  writeChat(root, chat)
  send({ type: 'done', chat })
  res.end()

  /** Record this turn (both sides) and the session that now backs the conversation. */
  function appendTurn(answer: string, failed: boolean): void {
    const at = new Date().toISOString()
    chat.messages.push(
      { role: 'user', text: prompt, at, images: images.length ? images.map((i) => i.file) : undefined },
      {
        role: 'assistant',
        text: answer.slice(0, MAX_TEXT),
        at,
        tools: usedTools.length ? [...usedTools] : undefined,
        model,
        error: failed || undefined,
      },
    )
    chat.messages = chat.messages.slice(-MAX_MESSAGES)
    // Only adopt a session id once the turn actually produced something — otherwise a
    // failed turn would pin the conversation to a session that answers nothing.
    if (sessionId) chat.sessionId = sessionId
    chat.updatedAt = at
  }
})

/** GET /api/chat/:slug — one conversation in full. */
chatRouter.get('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = readChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  res.json(chat)
})

/** POST /api/chat/:slug/rename — display name only; the slug (and file) stay put. */
chatRouter.post('/:slug/rename', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const chat = readChat(project.rootPath, req.params.slug)
  if (!chat) return res.status(404).json({ error: 'chat not found' })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : ''
  if (!name) return res.status(400).json({ error: 'name is required' })
  chat.name = name
  writeChat(project.rootPath, chat)
  res.json(chat)
})

/** DELETE /api/chat/:slug */
chatRouter.delete('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const f = itemFile(project.rootPath, req.params.slug)
  if (!f) return res.status(400).json({ error: 'invalid slug' })
  try {
    fs.rmSync(f, { force: true })
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
  res.json({ ok: true })
})
