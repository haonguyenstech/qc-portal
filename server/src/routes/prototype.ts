import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import {
  runClaude,
  runClaudeStream,
  parseClaudeJsonResult,
  CRAWL_SUMMARY_MODELS,
} from '../claudeExec.js'

export const prototypeRouter = Router()

/**
 * Prototype builder — a Claude-style chat that turns a plain-language prompt into a
 * self-contained HTML/CSS prototype (Tailwind via the Play CDN), rendered live in a
 * sandboxed iframe on the client. Each prototype is a conversation: follow-up prompts
 * refine the SAME document. Stored per project under <root>/testing/prototypes/<slug>.json
 * (mirrors routes/apiTests.ts) so it versions with the project. No live app is touched.
 */

interface PrototypeMessage {
  role: 'user' | 'assistant'
  text: string
  at: string
}
interface Prototype {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  messages: PrototypeMessage[]
  html: string
  // Short follow-up improvement ideas the model proposed for the latest version.
  suggestions?: string[]
}

const SLUG_RE = /^[\w-]{1,60}$/
const MAX_HTML = 600 * 1024 // a single prototype page is small; cap what we buffer/store
const MAX_PROMPT = 4000
const MAX_MESSAGES = 60 // keep the newest turns; the current HTML carries the state anyway
const GEN_TIMEOUT = 180_000
const MAX_IMAGES = 4
const MAX_IMAGE_B64 = 7 * 1024 * 1024 // ~5 MB decoded per image
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** A base64 image the user attached to a prompt (drag-drop / paste). */
interface ImageInput {
  mediaType: string
  dataBase64: string
}

function toImages(v: unknown): ImageInput[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      mediaType: typeof r.mediaType === 'string' ? r.mediaType : '',
      dataBase64: typeof r.dataBase64 === 'string' ? r.dataBase64 : '',
    }))
    .filter((i) => IMAGE_MEDIA_TYPES.has(i.mediaType) && i.dataBase64.length > 0 && i.dataBase64.length <= MAX_IMAGE_B64)
    .slice(0, MAX_IMAGES)
}

// ---- first-build design direction (style / theme / accent the user picks) --------

const STYLE_DESC: Record<string, string> = {
  clean: 'Clean & minimal — generous whitespace, restrained, elegant, few colours',
  saas: 'Modern SaaS product — polished dashboard aesthetic, cards, subtle depth, crisp',
  glass:
    'Glassmorphism — frosted translucent panels with backdrop blur over a vivid gradient background',
  brutalist: 'Neo-brutalist — bold thick borders, very high contrast, chunky type, raw offset blocks',
  playful: 'Playful & colourful — rounded shapes, friendly bright palette, big rounded buttons',
  corporate: 'Corporate & professional — trustworthy, conservative, structured, data-friendly',
  elegant: 'Elegant / luxury — refined premium muted palette, tasteful serif headings, lots of air',
}
const ACCENT_DESC: Record<string, string> = {
  blue: 'blue',
  violet: 'violet',
  emerald: 'emerald green',
  rose: 'rose / pink',
  amber: 'amber / orange',
  slate: 'slate grey',
}

interface DesignSettings {
  style: string
  theme: 'light' | 'dark'
  accent: string
}

function toDesign(v: unknown): DesignSettings | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const style = typeof r.style === 'string' ? r.style : ''
  if (!STYLE_DESC[style]) return null
  const theme = r.theme === 'dark' ? 'dark' : 'light'
  const accent = typeof r.accent === 'string' && ACCENT_DESC[r.accent] ? r.accent : 'auto'
  return { style, theme, accent }
}

/**
 * Build what we feed claude on stdin. With images we must use `--input-format
 * stream-json` and send a user message whose content has text + image blocks
 * (verified: the model reads the image this way, no tools/permission prompt needed).
 * Without images, plain text over stdin (the default) is enough.
 */
function buildClaudeInput(
  promptText: string,
  images: ImageInput[],
): { input: string; extraArgs: string[] } {
  if (!images.length) return { input: promptText, extraArgs: [] }
  const content: unknown[] = [{ type: 'text', text: promptText }]
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 },
    })
  }
  const msg = { type: 'user', message: { role: 'user', content } }
  return { input: JSON.stringify(msg) + '\n', extraArgs: ['--input-format', 'stream-json'] }
}

function protoDir(root: string): string {
  return path.join(testingDirFor(root), 'prototypes')
}

/** Filesystem-safe slug derived from a display name. */
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
  return s || 'prototype'
}

/** Resolve <dir>/<slug>.json, refusing anything that could escape the folder. */
function itemFile(root: string, slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null
  const dir = protoDir(root)
  const target = path.resolve(dir, `${slug}.json`)
  if (target !== path.join(dir, `${slug}.json`)) return null
  return target
}

function readPrototype(root: string, slug: string): Prototype | null {
  const f = itemFile(root, slug)
  if (!f) return null
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Prototype
  } catch {
    return null
  }
}

function writePrototype(root: string, p: Prototype): void {
  const f = itemFile(root, p.slug)
  if (!f) throw new Error('invalid slug')
  fs.mkdirSync(protoDir(root), { recursive: true })
  fs.writeFileSync(f, JSON.stringify(p, null, 2), 'utf8')
}

function uniqueSlug(root: string, base: string): string {
  const dir = protoDir(root)
  let slug = base
  let n = 2
  while (fs.existsSync(path.join(dir, `${slug}.json`))) slug = `${base}-${n++}`.slice(0, 60)
  return slug
}

/**
 * Default display name for a new prototype: "Prototype 1", "Prototype 2", …
 * Picks one past the highest existing "Prototype N" so names stay sequential and
 * don't collide even after deletes.
 */
function nextPrototypeName(root: string): string {
  const dir = protoDir(root)
  let max = 0
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue
      try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')) as Prototype
        const m = /^Prototype (\d+)$/.exec((p.name ?? '').trim())
        if (m) max = Math.max(max, Number(m[1]))
      } catch {
        /* skip unreadable file */
      }
    }
  } catch {
    /* no prototypes dir yet → start at 1 */
  }
  return `Prototype ${max + 1}`
}

// ---------------------------------------------------------------- generation

/** Pull the HTML document + the leading SUMMARY / SUGGESTIONS comments out of the reply. */
function extractHtmlFromText(textIn: string): { html: string; summary: string; suggestions: string[] } {
  let text = textIn.trim()
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const sm = text.match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i)
  const summary = sm ? sm[1].trim().replace(/\s+/g, ' ').slice(0, 300) : 'Updated the prototype.'
  const sg = text.match(/<!--\s*SUGGESTIONS:\s*([\s\S]*?)-->/i)
  const suggestions = sg
    ? sg[1]
        .split('|')
        .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 60))
        .filter(Boolean)
        .slice(0, 3)
    : []
  // Trim any prose before the document itself (keep the leading meta comments).
  const commentIdx = text.search(/<!--\s*(SUMMARY|SUGGESTIONS):/i)
  const docIdx = text.search(/<!doctype html|<html[\s>]/i)
  const start = commentIdx >= 0 && (docIdx < 0 || commentIdx < docIdx) ? commentIdx : docIdx
  let html = start > 0 ? text.slice(start) : text
  html = html.slice(0, MAX_HTML)
  return { html, summary, suggestions }
}

function extractHtml(raw: string): { html: string; summary: string; suggestions: string[] } {
  return extractHtmlFromText(parseClaudeJsonResult(raw).text)
}

/** The prompt shared by the buffered + streaming generators. */
function buildPrompt(opts: {
  prompt: string
  currentHtml: string
  history: PrototypeMessage[]
  imageCount?: number
  design?: DesignSettings | null
}): string {
  const { prompt, currentHtml, history, imageCount = 0, design = null } = opts
  const priorRequests = history
    .filter((m) => m.role === 'user')
    .slice(-12)
    .map((m) => `- ${m.text}`)
    .join('\n')

  const parts = [
    `You are a world-class product designer AND senior front-end engineer. You build a single-screen HTML prototype for a product/QC team, and DESIGN QUALITY IS THE #1 PRIORITY.`,
    ``,
    `Output rules (follow EXACTLY):`,
    `- Output ONE complete, valid HTML5 document and NOTHING else — no prose, no markdown, no code fences.`,
    `- Begin the document with exactly one HTML comment: <!-- SUMMARY: one short sentence on what you built or changed -->`,
    `- Immediately after it add one more comment: <!-- SUGGESTIONS: idea one | idea two | idea three --> with EXACTLY 3 short (max ~5 words) concrete next improvements tailored to THIS screen (e.g. "Add a dark mode toggle", "Add a testimonials section", "Show empty & loading states"). Separate them with | and nothing else.`,
    `- Load Tailwind via the Play CDN: put <script src="https://cdn.tailwindcss.com"></script> in <head>.`,
    ``,
    `DESIGN — make it genuinely beautiful and polished, NEVER plain, bland, or sketchy. Treat this like a portfolio-quality screen:`,
    `  • Strong visual hierarchy: a clear focal point, purposeful sizes/weights, generous and CONSISTENT spacing (use an 8px rhythm). Don't crowd elements; give the layout room to breathe.`,
    `  • Refined typography: a sensible type scale, comfortable line-height, tracking on headings; pair weights (e.g. bold headings, muted secondary text). Prefer a nice Google Font via the CDN link when it elevates the look.`,
    `  • Tasteful, cohesive color: pick a real palette (a primary + neutrals + 1 accent) with proper contrast (WCAG AA). Use subtle gradients, tints, and layered surfaces — avoid pure black-on-white blandness.`,
    `  • Depth & detail: soft shadows, rounded corners, hairline borders, hover/focus states, smooth transitions, and small delightful touches (icons, badges, avatars). Use inline SVG icons (e.g. Heroicons-style) rather than leaving empty boxes.`,
    `  • Rich, realistic placeholder content (real-sounding names, copy, numbers, and images via https://picsum.photos or gradient placeholders) — never "lorem ipsum" blocks or empty gray rectangles.`,
    `  • Polish every state and edge: aligned, pixel-tidy, no orphaned/overflowing elements. It must look like a finished, shippable product screen — invest effort into making it impressive.`,
    `- Use placeholder text/data. It is a STATIC prototype — no real backend, and no external assets beyond the Tailwind CDN, a Google Font, inline SVG, and picsum.photos images.`,
    `- Keep everything in the single file; inline any small JS you add.`,
    `- RESPONSIVE IS MANDATORY — the layout must look right and NEVER break on any device (small phones ~320px, tablets, and large desktops). Specifically:`,
    `  • Design mobile-first, then layer breakpoints with Tailwind's sm: / md: / lg: / xl: prefixes.`,
    `  • Use fluid layouts (flex / grid with flex-wrap, grid-cols that collapse on small screens, gap-*, w-full, max-w-*, mx-auto). Never hard-code fixed pixel widths that can overflow.`,
    `  • The page must NEVER scroll horizontally: apply min-w-0 on flex children, break long words/URLs (break-words), and let wide content (tables, code, images) scroll inside its own overflow-x-auto container.`,
    `  • Images/media: max-w-full and h-auto. Text scales sensibly (e.g. text-base md:text-lg). Tap targets stay comfortable on touch.`,
    `  • Collapse multi-column layouts to a single column on mobile; turn side navs into a stacked/top layout at small sizes. Nothing should be cut off or clipped at any width.`,
    `  • Add a proper <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.`,
  ]
  // First build only: honour the design direction the user picked in the start settings.
  if (design && !currentHtml.trim()) {
    parts.push(
      ``,
      `DESIGN DIRECTION (the user chose these in the start settings — honour them):`,
      `- Aesthetic: ${STYLE_DESC[design.style]}.`,
      `- Theme: ${design.theme === 'dark' ? 'dark-first (dark surfaces, light readable text)' : 'light'}.`,
    )
    if (design.accent !== 'auto') {
      parts.push(
        `- Accent colour: ${ACCENT_DESC[design.accent] ?? design.accent} — use it for primary actions, links and highlights.`,
      )
    }
  }
  if (currentHtml.trim()) {
    parts.push(
      ``,
      `This is the CURRENT prototype. Modify it to satisfy the new request while preserving everything else that still applies:`,
      `<<<CURRENT_HTML`,
      currentHtml,
      `CURRENT_HTML>>>`,
    )
  }
  if (priorRequests) parts.push(``, `Earlier requests in this session:`, priorRequests)
  if (imageCount > 0) {
    parts.push(
      ``,
      `The user attached ${imageCount} reference image${imageCount === 1 ? '' : 's'} (shown with this message). Use ${imageCount === 1 ? 'it' : 'them'} as the primary visual reference — match the layout, components, colours, and spacing you see as closely as a static Tailwind prototype allows.`,
    )
  }
  parts.push(``, `New request:`, prompt, ``, `Return the full HTML document now.`)
  return parts.join('\n')
}

async function generate(opts: {
  prompt: string
  model: string
  currentHtml: string
  history: PrototypeMessage[]
  images?: ImageInput[]
  design?: DesignSettings | null
  signal?: AbortSignal
}): Promise<{ html: string; summary: string; suggestions: string[] } | { error: string }> {
  const { prompt, model, currentHtml, history, images = [], design = null, signal } = opts
  const promptText = buildPrompt({ prompt, currentHtml, history, imageCount: images.length, design })
  const { input, extraArgs } = buildClaudeInput(promptText, images)
  const r = await runClaude(
    ['-p', '--output-format', 'json', '--strict-mcp-config', ...extraArgs, '--model', model],
    GEN_TIMEOUT,
    {
      usageSource: 'prototype',
      model,
      input,
      signal,
    },
  )
  if (signal?.aborted) return { error: 'stopped' }
  if (r.timedOut) return { error: 'The prototype build timed out — try a simpler request or a faster model.' }
  const { html, summary, suggestions } = extractHtml(r.stdout)
  if (!html || !html.includes('<')) {
    return { error: 'The AI did not return usable HTML. Try rephrasing the request.' }
  }
  return { html, summary, suggestions }
}

function pickModel(v: unknown, fallback = 'sonnet'): string {
  return typeof v === 'string' && CRAWL_SUMMARY_MODELS.has(v.trim()) ? v.trim() : fallback
}

// ---------------------------------------------------------------- routes

/** GET /api/prototype — list saved prototypes (metadata only, newest first). */
prototypeRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = protoDir(project.rootPath)
  try {
    const out = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => {
        try {
          const p = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8')) as Prototype
          return {
            slug: p.slug,
            name: p.name,
            createdAt: p.createdAt,
            updatedAt: p.updatedAt,
            messageCount: p.messages?.length ?? 0,
          }
        } catch {
          return null
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
    res.json(out)
  } catch {
    res.json([]) // no prototypes dir yet
  }
})

/** POST /api/prototype/open — reveal the project's testing/prototypes folder. */
prototypeRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = protoDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create prototypes folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/** POST /api/prototype — create a new prototype from the first prompt. */
prototypeRouter.post('/', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, MAX_PROMPT) : ''
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })
  const model = pickModel(b.model)
  const name =
    typeof b.name === 'string' && b.name.trim()
      ? b.name.trim().slice(0, 60)
      : nextPrototypeName(project.rootPath)

  const ac = new AbortController()
  // Detect a real client disconnect via the RESPONSE stream. (req 'close' fires as
  // soon as the POST body is consumed by express.json, which would abort instantly.)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  const gen = await generate({
    prompt,
    model,
    currentHtml: '',
    history: [],
    design: toDesign(b.style),
    signal: ac.signal,
  })
  if (ac.signal.aborted) return // client stopped — don't create anything or write to a dead socket
  if ('error' in gen) return res.status(502).json({ error: gen.error })

  const now = new Date().toISOString()
  const slug = uniqueSlug(project.rootPath, slugify(name))
  const proto: Prototype = {
    slug,
    name,
    createdAt: now,
    updatedAt: now,
    model,
    messages: [
      { role: 'user', text: prompt, at: now },
      { role: 'assistant', text: gen.summary, at: now },
    ],
    html: gen.html,
    suggestions: gen.suggestions,
  }
  writePrototype(project.rootPath, proto)
  res.json(proto)
})

/**
 * POST /api/prototype/stream — build/refine a prototype and stream the HTML as it's
 * written (Server-Sent Events). Body: { projectId, prompt, model, slug?, name? }.
 * Frames: {type:'delta', text} while generating, then {type:'done', prototype} once
 * saved, or {type:'error', error}. Falls back to a buffered build if the CLI doesn't
 * emit partial deltas, so it never hard-fails on that.
 */
prototypeRouter.post('/stream', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, MAX_PROMPT) : ''
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })
  const slug = typeof b.slug === 'string' ? b.slug : ''
  const existing = slug ? readPrototype(project.rootPath, slug) : null
  if (slug && !existing) return res.status(404).json({ error: 'prototype not found' })
  const model = pickModel(b.model, existing?.model || 'sonnet')
  const images = toImages(b.images)
  const design = toDesign(b.style) // only used on a fresh build (no existing HTML)

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
  // Detect a real client disconnect via the RESPONSE stream. (req 'close' fires as
  // soon as the POST body is consumed by express.json, which would abort instantly.)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  const currentHtml = existing?.html ?? ''
  const history = existing?.messages ?? []
  // Note attached images in the stored user turn (we don't persist the image bytes).
  const userText = images.length
    ? `${prompt}\n\n🖼️ ${images.length} image${images.length === 1 ? '' : 's'} attached`
    : prompt
  const finish = (html: string, summary: string, suggestions: string[]) => {
    const now = new Date().toISOString()
    let proto: Prototype
    if (existing) {
      existing.messages.push(
        { role: 'user', text: userText, at: now },
        { role: 'assistant', text: summary, at: now },
      )
      existing.messages = existing.messages.slice(-MAX_MESSAGES)
      existing.html = html
      existing.model = model
      existing.updatedAt = now
      existing.suggestions = suggestions
      proto = existing
    } else {
      const name =
        typeof b.name === 'string' && b.name.trim()
          ? b.name.trim().slice(0, 60)
          : nextPrototypeName(project.rootPath)
      const s = uniqueSlug(project.rootPath, slugify(name))
      proto = {
        slug: s,
        name,
        createdAt: now,
        updatedAt: now,
        model,
        messages: [
          { role: 'user', text: userText, at: now },
          { role: 'assistant', text: summary, at: now },
        ],
        html,
        suggestions,
      }
    }
    writePrototype(project.rootPath, proto)
    send({ type: 'log', level: 'success', text: `✔ Prototype ready (${(html.length / 1024).toFixed(1)} KB)` })
    send({ type: 'done', prototype: proto })
    res.end()
  }

  send({
    type: 'log',
    level: 'info',
    text: `▶ ${existing ? 'Refining' : 'Building'} prototype · model ${model}${images.length ? ` · ${images.length} image${images.length === 1 ? '' : 's'}` : ''}`,
  })
  const promptText = buildPrompt({ prompt, currentHtml, history, imageCount: images.length, design })
  const { input, extraArgs } = buildClaudeInput(promptText, images)
  const r = await runClaudeStream(
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      ...extraArgs,
      '--model',
      model,
    ],
    GEN_TIMEOUT,
    (log) => send({ type: 'log', level: log.level, text: log.text }),
    {
      usageSource: 'prototype',
      model,
      input,
      signal: ac.signal,
      onDelta: (text) => send({ type: 'delta', text }),
      suppressAssistantText: true, // the HTML already streams via delta frames
    },
  )
  if (ac.signal.aborted) {
    if (!res.writableEnded) res.end()
    return
  }

  // If partial streaming produced nothing usable (e.g. the CLI didn't emit deltas or
  // rejected the flag), fall back to a plain buffered build so it still works.
  if (!r.text || !r.text.includes('<')) {
    const g = await generate({ prompt, model, currentHtml, history, images, design, signal: ac.signal })
    if (ac.signal.aborted) {
      if (!res.writableEnded) res.end()
      return
    }
    if ('error' in g) {
      send({ type: 'error', error: g.error })
      return res.end()
    }
    return finish(g.html, g.summary, g.suggestions)
  }
  if (r.timedOut) {
    send({ type: 'error', error: 'The prototype build timed out — try a simpler request or a faster model.' })
    return res.end()
  }
  const { html, summary, suggestions } = extractHtmlFromText(r.text)
  if (!html || !html.includes('<')) {
    send({ type: 'error', error: 'The AI did not return usable HTML. Try rephrasing the request.' })
    return res.end()
  }
  finish(html, summary, suggestions)
})

/** GET /api/prototype/:slug — one prototype in full (messages + html). */
prototypeRouter.get('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  res.json(proto)
})

/** POST /api/prototype/:slug/message — send a follow-up that refines the prototype. */
prototypeRouter.post('/:slug/message', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const prompt = typeof b.prompt === 'string' ? b.prompt.trim().slice(0, MAX_PROMPT) : ''
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })
  const model = pickModel(b.model, proto.model || 'sonnet')

  const ac = new AbortController()
  // Detect a real client disconnect via the RESPONSE stream. (req 'close' fires as
  // soon as the POST body is consumed by express.json, which would abort instantly.)
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })

  const gen = await generate({
    prompt,
    model,
    currentHtml: proto.html,
    history: proto.messages,
    signal: ac.signal,
  })
  if (ac.signal.aborted) return // client stopped — leave the stored prototype untouched
  if ('error' in gen) return res.status(502).json({ error: gen.error })

  const now = new Date().toISOString()
  proto.messages.push(
    { role: 'user', text: prompt, at: now },
    { role: 'assistant', text: gen.summary, at: now },
  )
  proto.messages = proto.messages.slice(-MAX_MESSAGES)
  proto.html = gen.html
  proto.model = model
  proto.updatedAt = now
  writePrototype(project.rootPath, proto)
  res.json(proto)
})

/** POST /api/prototype/:slug/duplicate — copy a prototype into a new "(copy)" entry. */
prototypeRouter.post('/:slug/duplicate', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const src = readPrototype(project.rootPath, req.params.slug)
  if (!src) return res.status(404).json({ error: 'prototype not found' })
  const now = new Date().toISOString()
  const name = `${src.name} (copy)`.slice(0, 60)
  const slug = uniqueSlug(project.rootPath, slugify(name))
  const proto: Prototype = {
    slug,
    name,
    createdAt: now,
    updatedAt: now,
    model: src.model,
    messages: src.messages.map((m) => ({ ...m })),
    html: src.html,
  }
  writePrototype(project.rootPath, proto)
  res.json(proto)
})

/** POST /api/prototype/:slug/rename — change the display name (slug/file stay put). */
prototypeRouter.post('/:slug/rename', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim().slice(0, 60) : ''
  if (!newName) return res.status(400).json({ error: 'newName is required' })
  proto.name = newName
  proto.updatedAt = new Date().toISOString()
  writePrototype(project.rootPath, proto)
  res.json(proto)
})

/** DELETE /api/prototype/:slug — remove a prototype. */
prototypeRouter.delete('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const f = itemFile(project.rootPath, req.params.slug)
  if (!f) return res.status(400).json({ error: 'invalid slug' })
  try {
    fs.rmSync(f)
  } catch {
    /* already gone */
  }
  res.json({ ok: true })
})
