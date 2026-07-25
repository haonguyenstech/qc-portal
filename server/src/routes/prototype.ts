import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor, ticketsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { readProjectContext } from '../projectContext.js'
import { generateTestcaseVersion } from '../testcaseGen.js'
import { generateDesignSystem, readDesignSystem } from '../designSystem.js'
import { listSources } from '../db.js'
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

/**
 * One saved revision of a prototype's document. Every build/refine appends one, so a
 * refine is NON-DESTRUCTIVE: the engineer can preview, compare, and restore an earlier
 * revision instead of losing it (a BA iterating with stakeholders needs "go back to v2").
 */
interface PrototypeVersion {
  n: number
  html: string
  /** The request that produced this revision ('' for a migrated pre-versioning doc). */
  prompt: string
  summary: string
  at: string
  model: string
}

/** A revision without its HTML — what list/detail responses carry (see toPublic). */
interface PrototypeVersionMeta {
  n: number
  prompt: string
  summary: string
  at: string
  model: string
  bytes: number
}

/**
 * A requirement ambiguity the build had to guess about, and the answer the BA gave.
 *
 * This is the loop that makes a prototype a REQUIREMENTS instrument rather than a
 * picture: every build reports what it had to assume, the BA answers, and the answer
 * becomes a durable decision that grounds every later build (and is never re-asked).
 */
interface Decision {
  q: string
  a: string
  at: string
}

interface Prototype {
  slug: string
  name: string
  createdAt: string
  updatedAt: string
  model: string
  messages: PrototypeMessage[]
  /** The CURRENT document — always mirrors the newest (or restored) entry in `versions`. */
  html: string
  // Short follow-up improvement ideas the model proposed for the latest version.
  suggestions?: string[]
  /** Open requirement ambiguities the latest build had to guess about (for the BA). */
  questions?: string[]
  /** Answered ambiguities, oldest first — injected into every later build. */
  decisions?: Decision[]
  /** Revision history, oldest first (capped at MAX_VERSIONS). */
  versions?: PrototypeVersion[]
  /** Crawled-ticket folder under testing/tickets/ this prototype realizes, if linked. */
  ticketFolder?: string | null
  ticketId?: string | null
  ticketTitle?: string | null
  /** Whether the last build was allowed to read the project's real source code. */
  matchApp?: boolean
}

/** What the API returns: the current HTML plus revision METADATA (not every revision's HTML). */
type PublicPrototype = Omit<Prototype, 'versions'> & { versions: PrototypeVersionMeta[] }

const SLUG_RE = /^[\w-]{1,60}$/
const MAX_HTML = 600 * 1024 // a single prototype page is small; cap what we buffer/store
const MAX_PROMPT = 4000
const MAX_MESSAGES = 60 // keep the newest turns; the current HTML carries the state anyway
const GEN_TIMEOUT = 180_000
/** Reading the real source costs extra wall-clock, so tool-enabled builds get more room. */
const GEN_TIMEOUT_SOURCE = 420_000
const MAX_VERSIONS = 12 // keep the newest revisions; a prototype doc is tens of KB
const MAX_TICKET_CHARS = 20_000
const MAX_QUESTIONS = 3 // per build — what the model may raise in one turn
const MAX_OPEN_QUESTIONS = 8 // the standing list, which accumulates across builds
const MAX_DECISIONS = 40 // the ledger is prompt-injected; bound it
const MAX_DECISION_CHARS = 300
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

/**
 * Backfill `versions` for a prototype saved before revision history existed: its single
 * stored `html` becomes v1, labeled with the first request and the latest summary we have.
 * Idempotent, so it costs nothing once the file has been rewritten.
 */
function migrate(p: Prototype): Prototype {
  if (!Array.isArray(p.versions) || p.versions.length === 0) {
    p.versions = p.html
      ? [
          {
            n: 1,
            html: p.html,
            prompt: p.messages?.find((m) => m.role === 'user')?.text ?? '',
            summary:
              [...(p.messages ?? [])].reverse().find((m) => m.role === 'assistant')?.text ??
              'Initial build.',
            at: p.createdAt,
            model: p.model,
          },
        ]
      : []
  }
  return p
}

/** Append a revision and make it current. Keeps only the newest MAX_VERSIONS. */
function pushVersion(
  p: Prototype,
  v: { html: string; prompt: string; summary: string; model: string; at: string },
): void {
  const versions = p.versions ?? []
  const n = versions.length ? Math.max(...versions.map((x) => x.n)) + 1 : 1
  versions.push({ n, ...v })
  // Numbers stay monotonic even after trimming, so a version number is never reused.
  p.versions = versions.length > MAX_VERSIONS ? versions.slice(-MAX_VERSIONS) : versions
  p.html = v.html
}

/** Strip every revision's HTML — the detail response would otherwise be ~12× larger. */
function toPublic(p: Prototype): PublicPrototype {
  const { versions, ...rest } = p
  return {
    ...rest,
    versions: (versions ?? []).map((v) => ({
      n: v.n,
      prompt: v.prompt,
      summary: v.summary,
      at: v.at,
      model: v.model,
      bytes: v.html.length,
    })),
  }
}

function readPrototype(root: string, slug: string): Prototype | null {
  const f = itemFile(root, slug)
  if (!f) return null
  try {
    return migrate(JSON.parse(fs.readFileSync(f, 'utf8')) as Prototype)
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

// ---------------------------------------------------------------- ticket linking

/** Resolve testing/tickets/<folder>, refusing anything that escapes the tickets dir. */
function ticketDir(root: string, folder: string): string | null {
  const base = ticketsDirFor(root)
  const dir = path.resolve(base, folder)
  if (dir !== base && !dir.startsWith(base + path.sep)) return null
  return dir
}

interface LinkedTicket {
  folder: string
  displayId: string | null
  title: string | null
  /** ticket.md + comments.md, capped — the requirement the prototype must realize. */
  content: string
}

/**
 * Read an already-crawled ticket off disk so a prototype can be built FROM the
 * requirement instead of a free-text description. Returns null when the folder isn't
 * a crawled ticket (never throws — an unreadable link just degrades to a plain build).
 */
function readLinkedTicket(root: string, folder: string): LinkedTicket | null {
  const clean = folder.trim().replace(/\\/g, '/')
  if (!clean) return null
  const dir = ticketDir(root, clean)
  if (!dir) return null
  let displayId: string | null = null
  let title: string | null = null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'ticket.json'), 'utf8'))
    if (typeof j.displayId === 'string') displayId = j.displayId
    if (typeof j.name === 'string') title = j.name
  } catch {
    /* no ticket.json — fall back to the folder name */
  }
  const parts: string[] = []
  for (const file of ['ticket.md', 'comments.md']) {
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8').trim()
      if (text) parts.push(text)
    } catch {
      /* missing file — skip */
    }
  }
  let content = parts.join('\n\n---\n\n').trim()
  if (!content) return null
  if (content.length > MAX_TICKET_CHARS) {
    content = `${content.slice(0, MAX_TICKET_CHARS)}\n\n…(ticket truncated)`
  }
  return { folder: clean, displayId, title, content }
}

/**
 * Describe where each connected repo sits relative to the project root, so a
 * source-reading build can be pointed at it. Mirrors testcaseGen's sourceWhere.
 */
function describeSources(root: string, projectId: string): string {
  const rels: { tag: string; rel: string }[] = []
  for (const s of listSources(projectId)) {
    const sp = (s.sourcePath ?? '').trim()
    if (!sp) continue
    const rel = path.relative(root, sp)
    if (rel.startsWith('..')) continue
    rels.push({ tag: s.tag, rel: rel || '.' })
  }
  if (rels.length === 0 || (rels.length === 1 && rels[0].rel === '.')) {
    return 'in the current working directory'
  }
  const list = rels
    .map((r) => (r.rel === '.' ? `the working directory itself (${r.tag})` : `\`./${r.rel}\` (${r.tag})`))
    .join(', ')
  return `in ${rels.length > 1 ? 'these repositories' : 'this repository'} inside the current working directory: ${list}. Pick the repo(s) relevant to this screen`
}

// ---------------------------------------------------------------- generation

/** One meta comment's `|`-separated items, cleaned and capped. */
function metaList(text: string, tag: string, max: number, itemChars: number): string[] {
  const m = text.match(new RegExp(`<!--\\s*${tag}:\\s*([\\s\\S]*?)-->`, 'i'))
  if (!m) return []
  return m[1]
    .split('|')
    .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, itemChars))
    .filter((s) => s && !/^(none|n\/a|nothing)\.?$/i.test(s))
    .slice(0, max)
}

interface Extracted {
  html: string
  summary: string
  suggestions: string[]
  /** Requirement ambiguities the model had to guess about (see Decision). */
  questions: string[]
}

/** Pull the HTML document + the leading SUMMARY / SUGGESTIONS / QUESTIONS comments out of the reply. */
function extractHtmlFromText(textIn: string): Extracted {
  let text = textIn.trim()
  const fence = text.match(/```(?:html)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const sm = text.match(/<!--\s*SUMMARY:\s*([\s\S]*?)-->/i)
  const summary = sm ? sm[1].trim().replace(/\s+/g, ' ').slice(0, 300) : 'Updated the prototype.'
  const suggestions = metaList(text, 'SUGGESTIONS', 3, 60)
  const questions = metaList(text, 'QUESTIONS', MAX_QUESTIONS, 200)
  // Trim any prose before the document itself (keep the leading meta comments).
  const commentIdx = text.search(/<!--\s*(SUMMARY|SUGGESTIONS|QUESTIONS):/i)
  const docIdx = text.search(/<!doctype html|<html[\s>]/i)
  const start = commentIdx >= 0 && (docIdx < 0 || commentIdx < docIdx) ? commentIdx : docIdx
  let html = start > 0 ? text.slice(start) : text
  html = html.slice(0, MAX_HTML)
  return { html, summary, suggestions, questions }
}

function extractHtml(raw: string): Extracted {
  return extractHtmlFromText(parseClaudeJsonResult(raw).text)
}

/** The prompt shared by the buffered + streaming generators. */
function buildPrompt(opts: {
  prompt: string
  currentHtml: string
  history: PrototypeMessage[]
  imageCount?: number
  design?: DesignSettings | null
  /** The crawled ticket this prototype realizes (requirement-driven build). */
  ticket?: LinkedTicket | null
  /** The project's standing Knowledge + Memory block (readProjectContext). */
  knowledgeBlock?: string
  /** Set when the build may read the repo — where the source lives, relative to cwd. */
  sourceWhere?: string | null
  projectName?: string
  /** True when the project has an extracted design system inside the knowledge block. */
  hasDesignSystem?: boolean
  /** Ambiguities the BA has already answered — authoritative, never re-ask them. */
  decisions?: Decision[]
}): string {
  const {
    prompt,
    currentHtml,
    history,
    imageCount = 0,
    design = null,
    ticket = null,
    knowledgeBlock = '',
    sourceWhere = null,
    projectName = 'this project',
    hasDesignSystem = false,
    decisions = [],
  } = opts
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
    // The BA-facing half of the loop: surface what you had to GUESS, don't bury it.
    `- Then add one more comment: <!-- QUESTIONS: question one | question two --> listing up to ${MAX_QUESTIONS} GENUINE ambiguities in the requirement that you had to make a judgement call about — things only a business analyst or product owner can settle (e.g. "Can a closed note still be edited, or is it read-only?", "Should the total include tax?"). Rules for this list:`,
    `  • Only REAL requirement gaps that change behaviour or scope. NEVER ask about visual taste, colours, spacing, or wording you can reasonably pick yourself.`,
    `  • Ask about what you actually assumed in this build, phrased as a direct question a BA can answer in one sentence.`,
    `  • Do NOT repeat anything already settled in CONFIRMED DECISIONS below.`,
    `  • If nothing is genuinely ambiguous, write exactly: <!-- QUESTIONS: none -->`,
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
  // Ticket-driven build: the prototype must realize a real requirement, so the ticket is
  // the SCOPE and the model must not wander outside it.
  if (ticket) {
    parts.push(
      ``,
      `REQUIREMENT — this prototype realizes a real ticket${
        ticket.displayId ? ` (${ticket.displayId})` : ''
      }${ticket.title ? `: ${ticket.title}` : ''}. Build the screen the ticket describes:`,
      `- The ticket below is the SCOPE. Design exactly the screen(s), fields, states, actions and rules it specifies — do not invent unrelated features, and do not omit ones it asks for.`,
      `- Use the ticket's OWN names for screens, sections, fields, buttons, statuses and messages, verbatim. A QC engineer will compare this prototype against the ticket.`,
      `- Cover the states the ticket implies (empty, loading, validation errors, success, permission-restricted) — show them inline or as clearly-labeled variants, so they can be reviewed.`,
      `- Where the ticket is ambiguous, make a sensible choice and mark it in the UI with a small amber "Assumption" note so the BA can confirm it.`,
      `- Reflect any acceptance criteria you can see in the ticket; the screen should make each one visibly checkable.`,
      ``,
      `--- TICKET START ---`,
      ticket.content,
      `--- TICKET END ---`,
    )
  }
  // A prototype the team will sign off on has to look like THEIR product. The extracted
  // design system says exactly how, in text — so this works even without source tools.
  if (hasDesignSystem) {
    parts.push(
      ``,
      `THIS PRODUCT'S DESIGN SYSTEM — the project knowledge below contains a "Knowledge — design-system" doc extracted from the REAL application's source code. It is AUTHORITATIVE for how this prototype must look:`,
      `- Use ITS palette, fonts, type scale, spacing rhythm, radii, border and shadow conventions, and component shapes. Where it gives a real hex value, token, or class name, use that exact value.`,
      `- Follow its WORDING conventions: the same capitalisation style for labels and buttons, the product's real names for entities/actions/statuses, and its tone for validation and empty-state messages.`,
      `- It OVERRIDES the generic design guidance above and any style preset wherever the two disagree — the goal is a screen that looks like it already ships in this product, not a beautiful stranger.`,
      `- Only depart from it where this screen genuinely needs something it doesn't cover; then stay consistent with its spirit.`,
    )
  }
  // Answered ambiguities are requirement, not suggestion — and must never be re-asked.
  if (decisions.length) {
    parts.push(
      ``,
      `CONFIRMED DECISIONS — the business analyst has already answered these questions about this screen. Treat each answer as part of the REQUIREMENT: build it that way, and do NOT ask about it again in your QUESTIONS list:`,
      ...decisions.map((d) => `- Q: ${d.q}\n  A: ${d.a}`),
    )
  }
  // Source-aware build (opt-in): make the prototype look like the REAL product.
  if (sourceWhere) {
    parts.push(
      ``,
      `MATCH THE REAL APP — you are running INSIDE this project's repository and the application's SOURCE CODE is ${sourceWhere}. Before designing, do a QUICK, FOCUSED look at the real implementation so the prototype matches the product instead of a generic mock-up:`,
      hasDesignSystem
        ? `- THE DESIGN SYSTEM DOC ABOVE ALREADY DESCRIBES THE APP'S LOOK — do NOT spend reads rediscovering colours, fonts, spacing or component styling. Use your reads ONLY for this feature's real field names, validation rules, statuses and business logic.`
        : `- CHECK THE PROJECT KNOWLEDGE below FIRST for a SOURCE MAP doc ("Knowledge — source-map-…"): it indexes screens/routes, models and validation with file paths. When present, jump DIRECTLY to the files it names — do not re-explore the repo.`,
      `- The PROJECT KNOWLEDGE & MEMORY block below ALREADY CONTAINS this project's knowledge and memory — do NOT spend reads re-opening testing/knowledge/*.md or testing/memory/*.md.`,
      `- Take the app's REAL design language from the code (colors, spacing scale, radii, component shapes, typography, iconography) and the REAL field labels, validation messages, statuses and terminology. Reuse them rather than inventing your own.`,
      `- READ ONLY — never modify, create, or delete a file.`,
      `- TIME-BOX THIS HARD: open at most a handful of the most relevant files (roughly 5-8 reads), do not crawl the codebase, do not spawn sub-agents, and do not write a summary of what you found. The moment you understand the app's look and the feature's real names, STOP reading and write the HTML.`,
      `- If you cannot locate the relevant source, fall back to a well-designed generic screen — do not stall.`,
      ``,
      `SCOPE — stay strictly inside THIS project ("${projectName}"). Ground the design only in this project's own source, CLAUDE.md, and the knowledge/memory block below. Ignore any global or user-level configuration (e.g. a home-directory ~/.claude or global CLAUDE.md) and never read another project's folder.`,
    )
  }
  if (knowledgeBlock) {
    parts.push(``, knowledgeBlock)
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

/** Shared context that grounds a build in the project (ticket, knowledge, source). */
interface BuildContext {
  ticket?: LinkedTicket | null
  knowledgeBlock?: string
  /** Non-null enables read-only source tools + a project cwd. */
  sourceWhere?: string | null
  cwd?: string
  projectName?: string
  hasDesignSystem?: boolean
  decisions?: Decision[]
}

/**
 * Assemble the grounding for a build: the ticket, the project's Knowledge + Memory
 * (which is where the extracted design system rides in), whether source reading is on,
 * and the answered-ambiguity ledger. One place, so every entry point grounds alike.
 */
function buildContextFor(
  project: { id: string; rootPath: string; name: string },
  opts: { ticket: LinkedTicket | null; matchApp: boolean; decisions?: Decision[] },
): BuildContext {
  return {
    ticket: opts.ticket,
    knowledgeBlock: readProjectContext(project.rootPath).block,
    sourceWhere: opts.matchApp ? describeSources(project.rootPath, project.id) : null,
    cwd: project.rootPath,
    projectName: project.name || 'this project',
    hasDesignSystem: readDesignSystem(project.rootPath).exists,
    decisions: opts.decisions ?? [],
  }
}

/**
 * Tooling for a build. A source-aware build runs inside the project with READ-ONLY file
 * tools; otherwise no tools at all (fastest startup, and it can't touch the repo).
 *
 * The mutating tools are ALSO named in --disallowedTools, not just left out of the allow
 * list. Verified: with only --allowedTools the model still *attempts* Write/Bash (the CLI
 * denies them, so nothing reaches disk — but the attempts surface as alarming `⚙ Write`
 * lines in the build log and waste turns). Denying them outright removes them from the
 * model's tool surface. A prototype build must never modify the repo.
 *
 * Both flags are variadic, so each MUST be followed by another flag before the trailing
 * prompt positional, or the next arg is swallowed as a tool name.
 */
function toolArgsFor(ctx: BuildContext): string[] {
  return ctx.sourceWhere
    ? [
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        '--disallowedTools',
        'Write',
        'Edit',
        'MultiEdit',
        'NotebookEdit',
        'Bash',
        '--strict-mcp-config',
      ]
    : ['--strict-mcp-config']
}

async function generate(opts: {
  prompt: string
  model: string
  currentHtml: string
  history: PrototypeMessage[]
  images?: ImageInput[]
  design?: DesignSettings | null
  ctx?: BuildContext
  signal?: AbortSignal
}): Promise<Extracted | { error: string }> {
  const { prompt, model, currentHtml, history, images = [], design = null, ctx = {}, signal } = opts
  const promptText = buildPrompt({
    prompt,
    currentHtml,
    history,
    imageCount: images.length,
    design,
    ticket: ctx.ticket,
    knowledgeBlock: ctx.knowledgeBlock,
    sourceWhere: ctx.sourceWhere,
    projectName: ctx.projectName,
    hasDesignSystem: ctx.hasDesignSystem,
    decisions: ctx.decisions,
  })
  const { input, extraArgs } = buildClaudeInput(promptText, images)
  const r = await runClaude(
    ['-p', '--output-format', 'json', ...toolArgsFor(ctx), ...extraArgs, '--model', model],
    ctx.sourceWhere ? GEN_TIMEOUT_SOURCE : GEN_TIMEOUT,
    {
      usageSource: 'prototype',
      model,
      input,
      cwd: ctx.sourceWhere ? ctx.cwd : undefined,
      signal,
    },
  )
  if (signal?.aborted) return { error: 'stopped' }
  if (r.timedOut) return { error: 'The prototype build timed out — try a simpler request or a faster model.' }
  const out = extractHtml(r.stdout)
  if (!out.html || !out.html.includes('<')) {
    return { error: 'The AI did not return usable HTML. Try rephrasing the request.' }
  }
  return out
}

/** Parse `decisions: [{q,a}]` off a request body — answers the BA gave to open questions. */
function toDecisions(v: unknown): Decision[] {
  if (!Array.isArray(v)) return []
  const now = new Date().toISOString()
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      q: typeof r.q === 'string' ? r.q.trim().slice(0, MAX_DECISION_CHARS) : '',
      a: typeof r.a === 'string' ? r.a.trim().slice(0, MAX_DECISION_CHARS) : '',
      at: now,
    }))
    .filter((d) => d.q && d.a)
    .slice(0, MAX_DECISIONS)
}

/**
 * Fold newly-answered questions into the ledger: an answer for a question already in
 * the ledger REPLACES it (the BA corrected themselves), and the matching open question
 * is dropped so it isn't asked again while the build runs.
 */
function applyDecisions(p: Prototype, incoming: Decision[]): void {
  if (!incoming.length) return
  const answered = new Set(incoming.map((d) => d.q))
  const kept = (p.decisions ?? []).filter((d) => !answered.has(d.q))
  p.decisions = [...kept, ...incoming].slice(-MAX_DECISIONS)
  p.questions = (p.questions ?? []).filter((q) => !answered.has(q))
}

/**
 * Merge the questions a build just raised into the standing open list.
 *
 * The list ACCUMULATES rather than being replaced: answering one question must not
 * silently discard the others the BA hasn't got to yet (verified — a refine that raises
 * nothing new would otherwise wipe every outstanding question). Anything already in the
 * decision ledger is filtered out, and a question is otherwise cleared only by being
 * answered or explicitly dismissed.
 */
function mergeQuestions(p: Prototype, fresh: string[]): void {
  const settled = new Set((p.decisions ?? []).map((d) => d.q))
  const merged: string[] = []
  for (const q of [...fresh, ...(p.questions ?? [])]) {
    if (!q || settled.has(q) || merged.includes(q)) continue
    merged.push(q)
  }
  p.questions = merged.slice(0, MAX_OPEN_QUESTIONS)
}

function pickModel(v: unknown, fallback = 'sonnet'): string {
  return typeof v === 'string' && CRAWL_SUMMARY_MODELS.has(v.trim()) ? v.trim() : fallback
}

/**
 * The project's saved test-case template (testing/templates/testcase.md), so cases
 * drafted from a prototype match the team's format. Mirrors verifyDesign's readChecklist.
 * Null when there's none — generation still works, it just uses the default shape.
 */
function readTestcaseTemplate(root: string): { name: string; content: string } | null {
  const file = path.join(testingDirFor(root), 'templates', 'testcase.md')
  try {
    const content = fs.readFileSync(file, 'utf8').trim()
    return content ? { name: 'testcase.md', content } : null
  } catch {
    return null
  }
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
            // Surface the link + revision count so the list can badge them without a full read.
            ticketId: p.ticketId ?? null,
            ticketFolder: p.ticketFolder ?? null,
            versionCount: Array.isArray(p.versions) ? p.versions.length : p.html ? 1 : 0,
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

/**
 * GET /api/prototype/design-system — the project's extracted design system, if any.
 *
 * MUST stay above `GET /:slug`, which would otherwise swallow this path.
 */
prototypeRouter.get('/design-system', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const info = readDesignSystem(project.rootPath)
  res.json({
    ...info,
    // Extraction needs somewhere to read from; say so before the user clicks.
    hasSource: listSources(project.id).some((s) => (s.sourcePath ?? '').trim()),
  })
})

/**
 * POST /api/prototype/design-system — extract the real app's visual language into
 * testing/knowledge/design-system.md, so every later prototype matches the product
 * without re-reading the repo. Body: { projectId, model? }.
 */
prototypeRouter.post('/design-system', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const ac = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) ac.abort()
  })
  const result = await generateDesignSystem({
    rootPath: project.rootPath,
    sourceWhere: describeSources(project.rootPath, project.id),
    projectName: project.name || 'this project',
    model: pickModel((req.body ?? {}).model, 'haiku'),
    signal: ac.signal,
  })
  if (ac.signal.aborted) return
  if (!result.ok) return res.status(502).json({ error: result.error })
  res.json(result.info)
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

  const ticket = readLinkedTicket(project.rootPath, String(b.ticketFolder ?? ''))
  const matchApp = b.matchApp === true
  const gen = await generate({
    prompt,
    model,
    currentHtml: '',
    history: [],
    design: toDesign(b.style),
    ctx: buildContextFor(project, { ticket, matchApp }),
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
    questions: gen.questions,
    decisions: [],
    versions: [],
    ticketFolder: ticket?.folder ?? null,
    ticketId: ticket?.displayId ?? null,
    ticketTitle: ticket?.title ?? null,
    matchApp,
  }
  pushVersion(proto, { html: gen.html, prompt, summary: gen.summary, model, at: now })
  writePrototype(project.rootPath, proto)
  res.json(toPublic(proto))
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
  // Ticket link: an explicit ticketFolder on this request wins, else keep whatever the
  // prototype was already linked to, so a follow-up refine stays requirement-bound.
  const ticketReq = typeof b.ticketFolder === 'string' ? b.ticketFolder : null
  const ticketFolder = ticketReq !== null ? ticketReq : (existing?.ticketFolder ?? '')
  const ticket = ticketFolder ? readLinkedTicket(project.rootPath, ticketFolder) : null
  // "Match our real app" is opt-in per build (it enables read-only source tools, which
  // costs wall-clock); default to what this prototype used last time.
  const matchApp = typeof b.matchApp === 'boolean' ? b.matchApp : (existing?.matchApp ?? false)
  // Answers the BA gave to open questions on this turn. Folded into the ledger BEFORE
  // the build so they ground it (and are dropped from the open-question list).
  const newDecisions = toDecisions(b.decisions)
  if (existing) applyDecisions(existing, newDecisions)
  const decisions = existing ? (existing.decisions ?? []) : newDecisions
  const ctx = buildContextFor(project, { ticket, matchApp, decisions })

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
  const finish = (html: string, summary: string, suggestions: string[], questions: string[]) => {
    const now = new Date().toISOString()
    let proto: Prototype
    if (existing) {
      existing.messages.push(
        { role: 'user', text: userText, at: now },
        { role: 'assistant', text: summary, at: now },
      )
      existing.messages = existing.messages.slice(-MAX_MESSAGES)
      existing.model = model
      existing.updatedAt = now
      existing.suggestions = suggestions
      mergeQuestions(existing, questions)
      // A refine APPENDS a revision (pushVersion sets .html) — the previous document
      // stays on disk so the engineer can compare or restore it.
      pushVersion(existing, { html, prompt, summary, model, at: now })
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
        questions,
        // A brand-new prototype starts its ledger with whatever was answered up front.
        decisions: newDecisions,
        versions: [],
      }
      pushVersion(proto, { html, prompt, summary, model, at: now })
    }
    // Persist the grounding this build used, so a follow-up refine inherits it.
    proto.ticketFolder = ticket?.folder ?? (ticketFolder ? ticketFolder : null)
    proto.ticketId = ticket?.displayId ?? proto.ticketId ?? null
    proto.ticketTitle = ticket?.title ?? proto.ticketTitle ?? null
    proto.matchApp = matchApp
    writePrototype(project.rootPath, proto)
    send({
      type: 'log',
      level: 'success',
      text: `✔ Prototype ready — v${proto.versions?.at(-1)?.n ?? 1} (${(html.length / 1024).toFixed(1)} KB)`,
    })
    send({ type: 'done', prototype: toPublic(proto) })
    res.end()
  }

  const groundBits = [
    ticket ? `ticket ${ticket.displayId ?? ticket.folder}` : null,
    ctx.hasDesignSystem ? 'the app design system' : null,
    ctx.knowledgeBlock ? 'project knowledge' : null,
    decisions.length ? `${decisions.length} confirmed decision${decisions.length === 1 ? '' : 's'}` : null,
    matchApp ? 'reading real source' : null,
  ].filter(Boolean)
  send({
    type: 'log',
    level: 'info',
    text: `▶ ${existing ? 'Refining' : 'Building'} prototype · model ${model}${images.length ? ` · ${images.length} image${images.length === 1 ? '' : 's'}` : ''}${groundBits.length ? ` · grounded in ${groundBits.join(', ')}` : ''}`,
  })
  const promptText = buildPrompt({
    prompt,
    currentHtml,
    history,
    imageCount: images.length,
    design,
    ticket: ctx.ticket,
    knowledgeBlock: ctx.knowledgeBlock,
    sourceWhere: ctx.sourceWhere,
    projectName: ctx.projectName,
    hasDesignSystem: ctx.hasDesignSystem,
    decisions: ctx.decisions,
  })
  const { input, extraArgs } = buildClaudeInput(promptText, images)
  const r = await runClaudeStream(
    [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...toolArgsFor(ctx),
      ...extraArgs,
      '--model',
      model,
    ],
    matchApp ? GEN_TIMEOUT_SOURCE : GEN_TIMEOUT,
    (log) => send({ type: 'log', level: log.level, text: log.text }),
    {
      usageSource: 'prototype',
      model,
      input,
      // Only a source-aware build runs inside the project; a plain build stays cwd-less
      // so it can't reach the repo at all.
      cwd: matchApp ? project.rootPath : undefined,
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
    const g = await generate({
      prompt,
      model,
      currentHtml,
      history,
      images,
      design,
      ctx,
      signal: ac.signal,
    })
    if (ac.signal.aborted) {
      if (!res.writableEnded) res.end()
      return
    }
    if ('error' in g) {
      send({ type: 'error', error: g.error })
      return res.end()
    }
    return finish(g.html, g.summary, g.suggestions, g.questions)
  }
  if (r.timedOut) {
    send({ type: 'error', error: 'The prototype build timed out — try a simpler request or a faster model.' })
    return res.end()
  }
  const { html, summary, suggestions, questions } = extractHtmlFromText(r.text)
  if (!html || !html.includes('<')) {
    send({ type: 'error', error: 'The AI did not return usable HTML. Try rephrasing the request.' })
    return res.end()
  }
  finish(html, summary, suggestions, questions)
})

/**
 * GET /api/prototype/:slug — one prototype: messages, the CURRENT html, and revision
 * metadata (each revision's HTML is fetched on demand via /versions/:n).
 */
prototypeRouter.get('/:slug', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  res.json(toPublic(proto))
})

/** GET /api/prototype/:slug/versions/:n — one revision's HTML (preview / compare). */
prototypeRouter.get('/:slug/versions/:n', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  const n = Number(req.params.n)
  const v = (proto.versions ?? []).find((x) => x.n === n)
  if (!v) return res.status(404).json({ error: 'version not found' })
  res.json({ n: v.n, html: v.html, prompt: v.prompt, summary: v.summary, at: v.at, model: v.model })
})

/**
 * POST /api/prototype/:slug/restore — make an earlier revision current again. Body: { version }.
 * This APPENDS a new revision rather than rewinding, so a restore is itself undoable.
 */
prototypeRouter.post('/:slug/restore', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  const n = Number((req.body ?? {}).version)
  const v = (proto.versions ?? []).find((x) => x.n === n)
  if (!v) return res.status(404).json({ error: 'version not found' })
  const now = new Date().toISOString()
  const summary = `Restored v${v.n}.`
  proto.messages.push({ role: 'assistant', text: summary, at: now })
  proto.messages = proto.messages.slice(-MAX_MESSAGES)
  proto.updatedAt = now
  // The restored document carries no fresh suggestions/questions — clear the stale ones.
  // The DECISION ledger is deliberately kept: an answered requirement question stays
  // answered no matter which revision is on screen.
  proto.suggestions = []
  proto.questions = []
  pushVersion(proto, {
    html: v.html,
    prompt: `Restore v${v.n}`,
    summary,
    model: proto.model,
    at: now,
  })
  writePrototype(project.rootPath, proto)
  res.json(toPublic(proto))
})

/**
 * POST /api/prototype/:slug/questions/dismiss — drop one open question. Body: { question }.
 *
 * Open questions accumulate (see mergeQuestions), so there has to be a way to clear one
 * that doesn't need answering — otherwise the list nags forever.
 */
prototypeRouter.post('/:slug/questions/dismiss', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  const question = typeof req.body?.question === 'string' ? req.body.question : ''
  if (!question) return res.status(400).json({ error: 'question is required' })
  proto.questions = (proto.questions ?? []).filter((q) => q !== question)
  proto.updatedAt = new Date().toISOString()
  writePrototype(project.rootPath, proto)
  res.json(toPublic(proto))
})

/**
 * POST /api/prototype/:slug/testcases — draft manual test cases from this prototype.
 *
 * The prototype is grounded UI (real field names, states, validation, actions), so it
 * makes a far better basis for cases than the ticket alone. Requires a linked ticket:
 * versions are stored under testing/tickets/<folder>/testcases/, and the ticket is what
 * defines the acceptance scope. Body: { projectId, model?, instructions? }.
 */
prototypeRouter.post('/:slug/testcases', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const proto = readPrototype(project.rootPath, req.params.slug)
  if (!proto) return res.status(404).json({ error: 'prototype not found' })
  if (!proto.html?.trim()) return res.status(422).json({ error: 'this prototype has no HTML yet' })
  const folder = (proto.ticketFolder ?? '').trim()
  if (!folder) {
    return res.status(400).json({
      error:
        'Link this prototype to a crawled ticket first — test-case versions are stored under that ticket.',
    })
  }
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const result = await generateTestcaseVersion({
      rootPath: project.rootPath,
      projectName: project.name || 'this project',
      folder,
      // Read the project's saved test-case template so the output matches the team's
      // format, exactly as the /testcases page does when no per-run file is uploaded.
      template: readTestcaseTemplate(project.rootPath),
      instructions: typeof b.instructions === 'string' ? b.instructions : '',
      model: pickModel(b.model, proto.model || 'sonnet'),
      sources: listSources(project.id).map((s) => ({ tag: s.tag, path: s.sourcePath })),
      groundingCheck: project.groundingCheck,
      groundingCheckModel: project.groundingCheckModel,
      prototypeUi: { name: proto.name, html: proto.html },
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
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

  applyDecisions(proto, toDecisions(req.body?.decisions))
  const gen = await generate({
    prompt,
    model,
    currentHtml: proto.html,
    history: proto.messages,
    ctx: buildContextFor(project, {
      ticket: proto.ticketFolder ? readLinkedTicket(project.rootPath, proto.ticketFolder) : null,
      matchApp: !!proto.matchApp,
      decisions: proto.decisions ?? [],
    }),
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
  proto.model = model
  proto.updatedAt = now
  proto.suggestions = gen.suggestions
  mergeQuestions(proto, gen.questions)
  pushVersion(proto, { html: gen.html, prompt, summary: gen.summary, model, at: now })
  writePrototype(project.rootPath, proto)
  res.json(toPublic(proto))
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
    // Carry the whole revision history and the grounding links into the copy, so a
    // duplicate is a real fork the engineer can keep iterating (and roll back) on.
    versions: (src.versions ?? []).map((v) => ({ ...v })),
    suggestions: src.suggestions ? [...src.suggestions] : undefined,
    questions: src.questions ? [...src.questions] : undefined,
    decisions: (src.decisions ?? []).map((d) => ({ ...d })),
    ticketFolder: src.ticketFolder ?? null,
    ticketId: src.ticketId ?? null,
    ticketTitle: src.ticketTitle ?? null,
    matchApp: src.matchApp ?? false,
  }
  writePrototype(project.rootPath, proto)
  res.json(toPublic(proto))
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
  res.json(toPublic(proto))
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
