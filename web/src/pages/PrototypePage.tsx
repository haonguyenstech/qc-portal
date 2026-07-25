import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  ClipboardCheck,
  Clock,
  Code2,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  HelpCircle,
  History,
  ImagePlus,
  Laptop,
  Layout,
  Loader2,
  MessageCircle,
  MessageSquarePlus,
  Minus,
  Monitor,
  Palette,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  Square,
  Tablet,
  TerminalSquare,
  Ticket as TicketIcon,
  Trash2,
  Undo2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { CrawledStatusHeader, CrawledTicketRow } from '@/components/CrawledTicketRow'
import { buildCrawledTree } from '@/lib/crawled-tickets'
import { useProjects } from '@/lib/project-context'
import { cn } from '@/lib/utils'
import {
  deletePrototype,
  dismissPrototypeQuestion,
  duplicatePrototype,
  generateDesignSystem,
  generateTestcasesFromPrototype,
  getDesignSystem,
  getPrototype,
  getPrototypeVersion,
  listCrawledTickets,
  listPrototypes,
  openPrototypesFolder,
  renamePrototype,
  restorePrototypeVersion,
  streamPrototype,
  type CrawledTicket,
  type DesignSystemInfo,
  type PrototypeDecision,
  type PrototypeMessage,
  type PrototypeVersionMeta,
} from '@/lib/api'

const MODELS = ['haiku', 'sonnet', 'opus'] as const
const MODEL_INFO: Record<(typeof MODELS)[number], { label: string; desc: string }> = {
  haiku: { label: 'Haiku', desc: 'Fastest & cheapest — great for quick drafts and simple screens.' },
  sonnet: { label: 'Sonnet', desc: 'Balanced speed and quality — the everyday default for most UIs.' },
  opus: { label: 'Opus', desc: 'Most capable — richest design detail for complex, polished layouts (slower).' },
}
// Bumped to reset any previously-remembered model so everyone starts on the
// Sonnet default again; new picks are remembered under this key.
const MODEL_KEY = 'qc.prototypeModel.v2'
const STYLE_KEY = 'qc.prototypeStyle'
const CHAT_FLOAT_KEY = 'qc.prototypeChatFloat'

function loadChatFloating(): boolean {
  try {
    // Default to floating (bubble) mode unless the user explicitly docked it.
    return localStorage.getItem(CHAT_FLOAT_KEY) !== '0'
  } catch {
    return true
  }
}

// Start settings offered on the first chat (design direction for the initial build).
const STYLE_OPTIONS = [
  { value: 'clean', label: 'Clean & minimal' },
  { value: 'saas', label: 'Modern SaaS' },
  { value: 'glass', label: 'Glassmorphism' },
  { value: 'brutalist', label: 'Neo-brutalist' },
  { value: 'playful', label: 'Playful & colorful' },
  { value: 'corporate', label: 'Corporate' },
  { value: 'elegant', label: 'Elegant / luxury' },
] as const
const ACCENTS = [
  { value: 'auto', dot: 'bg-foreground/25', label: 'Auto' },
  { value: 'blue', dot: 'bg-blue-500', label: 'Blue' },
  { value: 'violet', dot: 'bg-violet-500', label: 'Violet' },
  { value: 'emerald', dot: 'bg-emerald-500', label: 'Emerald' },
  { value: 'rose', dot: 'bg-rose-500', label: 'Rose' },
  { value: 'amber', dot: 'bg-amber-500', label: 'Amber' },
  { value: 'slate', dot: 'bg-slate-500', label: 'Slate' },
] as const

interface StyleSettings {
  style: string
  theme: 'light' | 'dark'
  accent: string
}

function loadStyle(): StyleSettings {
  try {
    const raw = localStorage.getItem(STYLE_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return {
        style: STYLE_OPTIONS.some((o) => o.value === p.style) ? p.style : 'clean',
        theme: p.theme === 'dark' ? 'dark' : 'light',
        accent: ACCENTS.some((a) => a.value === p.accent) ? p.accent : 'auto',
      }
    }
  } catch {
    /* ignore */
  }
  return { style: 'clean', theme: 'light', accent: 'auto' }
}
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** An image the user attached to the composer (drag-drop / paste / pick). */
interface AttachedImage {
  id: string
  name: string
  mediaType: string
  dataUrl: string // full data: URL, for the thumbnail
  dataBase64: string // just the base64 payload, for the API
}

/** Read one image File into an AttachedImage (null if it isn't a usable image). */
function readImageFile(file: File): Promise<AttachedImage | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result || '')
      const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/)
      if (!m) return resolve(null)
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name || 'image',
        mediaType: m[1],
        dataUrl,
        dataBase64: m[2],
      })
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

const EXAMPLES = [
  'A SaaS dashboard with a sidebar, stat cards, and a recent-activity table',
  'A mobile-first login screen with email, password, and social buttons',
  'A pricing page with three tiers and a monthly/yearly toggle',
  'A settings page with tabs for Profile, Notifications, and Billing',
]

type Device = 'desktop' | 'laptop' | 'tablet' | 'mobile'
type Orientation = 'portrait' | 'landscape'

/**
 * Preview viewport presets. `width: null` = fill the available pane (desktop).
 * `frame` (portrait screen dimensions) marks a device that renders inside a bezel
 * mockup and can be rotated portrait ⇄ landscape.
 */
const DEVICES: {
  id: Device
  label: string
  icon: typeof Monitor
  width: number | null
  frame?: { w: number; h: number }
  tip: string
}[] = [
  { id: 'desktop', label: 'Desktop', icon: Monitor, width: null, tip: 'Desktop — fill the available width' },
  { id: 'laptop', label: 'Laptop', icon: Laptop, width: 1280, tip: 'Laptop — 1280px wide' },
  { id: 'tablet', label: 'Tablet', icon: Tablet, width: 834, frame: { w: 834, h: 1112 }, tip: 'Tablet — iPad, rotatable' },
  { id: 'mobile', label: 'Mobile', icon: Smartphone, width: 390, frame: { w: 390, h: 844 }, tip: 'Mobile — phone frame, rotatable' },
]

function loadModel(): string {
  try {
    const m = localStorage.getItem(MODEL_KEY)
    if (m && (MODELS as readonly string[]).includes(m)) return m
  } catch {
    /* ignore */
  }
  return 'sonnet'
}

/** A tiny CSS mock-up representing each design style, for the picker previews. */
function StyleThumb({ value }: { value: string }) {
  switch (value) {
    case 'saas':
      return (
        <div className="flex h-full gap-1 bg-zinc-50 p-1.5">
          <div className="w-1/4 rounded bg-indigo-600/90" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex gap-1">
              <div className="h-4 flex-1 rounded bg-white ring-1 ring-zinc-200" />
              <div className="h-4 flex-1 rounded bg-white ring-1 ring-zinc-200" />
            </div>
            <div className="flex-1 rounded bg-white ring-1 ring-zinc-200" />
          </div>
        </div>
      )
    case 'glass':
      return (
        <div className="h-full bg-gradient-to-br from-fuchsia-500 via-purple-500 to-indigo-500 p-2">
          <div className="h-full w-full rounded-md border border-white/50 bg-white/20 backdrop-blur-sm" />
        </div>
      )
    case 'brutalist':
      return (
        <div className="flex h-full flex-col gap-1 bg-yellow-300 p-1.5">
          <div className="h-2 w-2/3 border-2 border-black bg-white" />
          <div className="flex-1 border-2 border-black bg-white" />
          <div className="h-2 w-1/3 border-2 border-black bg-black" />
        </div>
      )
    case 'playful':
      return (
        <div className="flex h-full items-center gap-1.5 bg-rose-50 p-2">
          <div className="size-6 shrink-0 rounded-full bg-orange-400" />
          <div className="flex flex-1 flex-col gap-1">
            <div className="h-1.5 w-full rounded-full bg-pink-300" />
            <div className="h-3 w-12 rounded-full bg-violet-500" />
          </div>
        </div>
      )
    case 'corporate':
      return (
        <div className="flex h-full flex-col bg-white">
          <div className="h-3 bg-slate-800" />
          <div className="flex flex-1 flex-col gap-1 p-1.5">
            <div className="h-1 w-full rounded bg-slate-200" />
            <div className="h-1 w-full rounded bg-slate-200" />
            <div className="h-1 w-3/4 rounded bg-slate-200" />
          </div>
        </div>
      )
    case 'elegant':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1 bg-[#faf7f0] p-2">
          <div className="h-2 w-1/2 rounded-sm bg-stone-700" />
          <div className="h-px w-8 bg-amber-600" />
          <div className="h-1 w-2/3 rounded-sm bg-stone-300" />
        </div>
      )
    case 'clean':
    default:
      return (
        <div className="flex h-full flex-col justify-center gap-1 bg-white p-2">
          <div className="h-1.5 w-1/2 rounded bg-zinc-800" />
          <div className="h-1 w-3/4 rounded bg-zinc-200" />
          <div className="h-1 w-2/3 rounded bg-zinc-200" />
          <div className="mt-1 h-2 w-9 rounded bg-zinc-900" />
        </div>
      )
  }
}

/** Open the prototype HTML in a new browser tab (revoke the blob shortly after). */
/** Compact absolute date + time a prototype was created (e.g. "Jul 16, 02:30 PM"). */
function formatCreated(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function openInNewTab(html: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * Save the prototype as a standalone .html file. It's a single self-contained document,
 * so the download opens in any browser with no server — which is how a BA hands a screen
 * to a stakeholder, or attaches it to a ticket for sign-off.
 */
function downloadHtml(html: string, filename: string) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// ------------------------------------------------------- comment mode (element picker)

/** An element the user clicked in comment mode, plus what they want changed there. */
interface PinComment {
  id: string
  /** Human-readable target, e.g. `<button> "Save changes"`. */
  label: string
  /** Shallow CSS-ish path, so the model can locate the element in the markup. */
  path: string
  text: string
}

/**
 * Injected into the preview iframe while comment mode is on: highlights whatever the
 * cursor is over and posts the clicked element's description back to the parent, instead
 * of letting the click do whatever the prototype would normally do.
 *
 * This is only ever added to the RENDERED srcDoc (see withPicker) — never to the stored
 * document. The iframe is sandboxed without allow-same-origin, so postMessage is the only
 * channel out, and the parent validates the payload shape before trusting it.
 */
const PICKER_SCRIPT = `
<script>(function(){
  var box = document.createElement('div');
  box.setAttribute('data-qc-pick','1');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #3279F9;background:rgba(50,121,249,.14);border-radius:4px;box-shadow:0 0 0 1px rgba(255,255,255,.6);display:none';
  var tag = document.createElement('div');
  tag.setAttribute('data-qc-pick','1');
  tag.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:#3279F9;color:#fff;font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif;padding:2px 6px;border-radius:6px;display:none;max-width:60vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
  function mount(){ if(document.body){ document.body.appendChild(box); document.body.appendChild(tag); } }
  mount();
  document.documentElement.style.cursor = 'crosshair';
  function describe(el){
    // innerText first (it respects layout), then textContent as a fallback — an element
    // with no readable text at all still gets identified by its tag + path.
    var t = (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g,' ');
    return '<' + el.tagName.toLowerCase() + '>' + (t ? ' "' + t.slice(0,70) + '"' : '');
  }
  function pathOf(el){
    var out = [], n = el, d = 0;
    while (n && n.nodeType === 1 && n.tagName !== 'HTML' && d < 6) {
      var s = n.tagName.toLowerCase();
      if (n.id) { out.unshift(s + '#' + n.id); break; }
      var c = n.getAttribute && n.getAttribute('class');
      if (c && typeof c === 'string' && c.trim()) s += '.' + c.trim().split(/\\s+/).slice(0,3).join('.');
      out.unshift(s); n = n.parentElement; d++;
    }
    return out.join(' > ');
  }
  document.addEventListener('mouseover', function(e){
    var el = e.target;
    if (!el || el.nodeType !== 1 || el.getAttribute('data-qc-pick')) return;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
    tag.textContent = describe(el);
    tag.style.display = 'block';
    tag.style.left = r.left + 'px';
    tag.style.top = (r.top > 20 ? r.top - 19 : r.bottom + 3) + 'px';
  }, true);
  // Swallow anything the prototype would normally do — this click is a comment, not a use.
  function eat(e){ e.preventDefault(); e.stopPropagation(); }
  document.addEventListener('submit', eat, true);
  document.addEventListener('click', function(e){
    eat(e);
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    parent.postMessage({ source:'qc-prototype', type:'pick', label: describe(el), path: pathOf(el) }, '*');
  }, true);
})();</script>
`

/** Add the picker to a document for RENDERING only (never to what we store). */
function withPicker(html: string): string {
  if (!html) return html
  return /<\/body>/i.test(html)
    ? html.replace(/<\/body>/i, `${PICKER_SCRIPT}</body>`)
    : html + PICKER_SCRIPT
}

/** Turn pinned comments into one precise refine instruction. */
function commentsToPrompt(comments: PinComment[]): string {
  const lines = comments.map(
    (c, i) => `${i + 1}. On the element ${c.label}${c.path ? ` (in ${c.path})` : ''} — ${c.text}`,
  )
  return [
    `Apply these ${comments.length} targeted change${comments.length === 1 ? '' : 's'}. Each one names a SPECIFIC element in the current prototype — find that element and change only what is asked, leaving the rest of the screen exactly as it is:`,
    ...lines,
  ].join('\n')
}

/**
 * Rasterize the prototype HTML and write it to the clipboard as a PNG image.
 *
 * The live preview iframe is sandboxed WITHOUT allow-same-origin (null origin),
 * so the parent can't read its pixels. We render the same HTML into a throwaway
 * off-screen SAME-origin iframe purely so html2canvas can read the rendered DOM,
 * snapshot it, then tear it down. html2canvas is dynamically imported to stay out
 * of the main bundle (mirrors docConvert). Best-effort — throws on clipboard denial.
 */
async function captureHtmlToClipboard(html: string): Promise<void> {
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;'
  document.body.appendChild(frame)
  try {
    const doc = frame.contentDocument
    if (!doc) throw new Error('Could not prepare the preview for capture.')
    doc.open()
    doc.write(html)
    doc.close()
    // Wait for load, then a beat for Tailwind CDN / web fonts / images to settle.
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      frame.addEventListener('load', () => window.setTimeout(finish, 800), { once: true })
      window.setTimeout(finish, 3500) // hard cap so we never hang
    })
    // Grow the frame to the full content so the whole page is captured, not just the fold.
    const width = Math.max(doc.body?.scrollWidth ?? 0, 1280)
    const height = Math.max(doc.body?.scrollHeight ?? 0, doc.documentElement?.scrollHeight ?? 0, 600)
    frame.style.width = `${width}px`
    frame.style.height = `${height}px`
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(doc.body, {
      useCORS: true,
      backgroundColor: '#ffffff',
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      scale: Math.min(2, window.devicePixelRatio || 1),
      logging: false,
    })
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error('Could not rasterize the preview.')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } finally {
    frame.remove()
  }
}

/** Ticking elapsed-time readout. Mounted only while a build is running (starts at 0). */
function ElapsedTimer() {
  const start = useRef(0)
  const [ms, setMs] = useState(0)
  useEffect(() => {
    start.current = performance.now()
    const id = window.setInterval(() => setMs(performance.now() - start.current), 100)
    return () => window.clearInterval(id)
  }, [])
  return <span className="tabular-nums">{(ms / 1000).toFixed(1)}s</span>
}

// ---------------------------------------------------------------- preview

/** Hover tooltip for a toolbar control — describes what the button does. */
function Tip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Renders the preview iframe at the chosen device size. Desktop/laptop are a plain
 * bordered rectangle constrained to the device width (so Tailwind breakpoints trigger
 * as they would on that screen); tablet and mobile are wrapped in a device mockup with
 * a dark bezel, and the content scrolls inside the fixed-size "screen".
 */
function DeviceStage({
  device,
  orientation,
  html,
  nonce,
  commentMode,
}: {
  device: Device
  orientation: Orientation
  html: string
  nonce: number
  /** Comment mode injects the element picker into the RENDERED doc (see withPicker). */
  commentMode: boolean
}) {
  const spec = DEVICES.find((d) => d.id === device)
  const iframe = (
    <iframe
      // Remount on rotate too so the page relayouts at the new viewport size, and on a
      // comment-mode change so the picker script is added/removed.
      key={`${nonce}-${device}-${orientation}-${commentMode ? 'pick' : 'view'}`}
      title="Prototype preview"
      // Sandbox WITHOUT allow-same-origin: scripts (Tailwind CDN, small inline JS) run,
      // but the page is a null origin and can't touch the portal.
      sandbox="allow-scripts allow-forms allow-popups"
      srcDoc={commentMode ? withPicker(html) : html}
      className="h-full w-full border-0 bg-white"
    />
  )

  // Framed devices (mobile / tablet) — dark bezel + rotatable screen.
  if (spec?.frame) {
    const landscape = orientation === 'landscape'
    const screenW = landscape ? spec.frame.h : spec.frame.w
    const screenH = landscape ? spec.frame.w : spec.frame.h
    const isPhone = device === 'mobile'
    // The screen scrolls internally; cap its on-screen height to the pane, keep the
    // true device width so responsive breakpoints fire at the real viewport size.
    return (
      <div className="flex h-full min-h-[84vh] items-start justify-center py-2">
        <div
          className={cn(
            'relative shrink-0 border border-zinc-700/40 bg-zinc-900 shadow-2xl',
            isPhone ? 'rounded-[2.75rem] p-2.5' : 'rounded-[1.75rem] p-3',
          )}
        >
          {/* phone notch (top in portrait, left in landscape) */}
          {isPhone && (
            <div
              className={cn(
                'absolute z-10 bg-zinc-900',
                landscape
                  ? 'left-2.5 top-1/2 h-28 w-5 -translate-y-1/2 rounded-r-2xl'
                  : 'left-1/2 top-2.5 h-5 w-28 -translate-x-1/2 rounded-b-2xl',
              )}
            />
          )}
          <div
            className={cn('overflow-hidden bg-white', isPhone ? 'rounded-[2.1rem]' : 'rounded-2xl')}
            style={{ width: screenW, height: `min(84vh, ${screenH}px)` }}
          >
            {iframe}
          </div>
        </div>
      </div>
    )
  }

  // desktop / laptop — plain bordered viewport constrained by width.
  return (
    <div
      className="mx-auto h-full min-h-[84vh] w-full transition-all"
      style={spec?.width ? { maxWidth: spec.width } : undefined}
    >
      <div className="h-full min-h-[84vh] overflow-hidden rounded-xl border border-border/60 bg-white">
        {iframe}
      </div>
    </div>
  )
}

/** Shimmer placeholder shown behind the loading overlay while a build runs. */
function PreviewSkeleton() {
  const bar = 'rounded bg-zinc-200'
  return (
    <div className="qc-shimmer mx-auto flex h-full min-h-[84vh] w-full max-w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-white">
      <div className="flex flex-1 animate-pulse flex-col gap-5 p-5">
        {/* top bar */}
        <div className="flex items-center gap-3">
          <div className="size-9 rounded-xl bg-zinc-200" />
          <div className={cn(bar, 'h-3 w-28')} />
          <div className="ml-auto flex items-center gap-2">
            <div className={cn(bar, 'h-3 w-12')} />
            <div className={cn(bar, 'h-3 w-12')} />
            <div className="size-8 rounded-full bg-zinc-200" />
          </div>
        </div>
        {/* title */}
        <div className="space-y-2">
          <div className={cn(bar, 'h-5 w-1/3')} />
          <div className={cn(bar, 'h-3 w-1/2')} />
        </div>
        {/* stat cards */}
        <div className="grid grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-24 rounded-2xl bg-zinc-100 ring-1 ring-zinc-200">
              <div className="space-y-2 p-3">
                <div className={cn(bar, 'h-2.5 w-1/2')} />
                <div className={cn(bar, 'h-5 w-2/3')} />
              </div>
            </div>
          ))}
        </div>
        {/* content rows */}
        <div className="flex-1 space-y-2.5 rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="size-8 rounded-lg bg-zinc-200" />
              <div className={cn(bar, 'h-3 flex-1')} />
              <div className={cn(bar, 'h-3 w-16')} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const BUILD_PHASES = [
  'Sketching the layout…',
  'Choosing colors & typography…',
  'Building the components…',
  'Adding realistic content…',
  'Making it responsive…',
  'Polishing the details…',
]
const UPDATE_PHASES = [
  'Reading your request…',
  'Locating what to change…',
  'Applying your changes…',
  'Refining the design…',
  'Polishing the details…',
]

/** Cycles through short progress phrases so the wait feels active, not stuck. */
function RotatingStatus({ phases }: { phases: string[] }) {
  const [i, setI] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setI((n) => n + 1), 3400)
    return () => window.clearInterval(id)
  }, [])
  const idx = i % phases.length
  return (
    <span
      key={idx}
      className="inline-block animate-in fade-in slide-in-from-bottom-1 text-sm text-muted-foreground duration-300"
    >
      {phases[idx]}
    </span>
  )
}

/**
 * Animated isometric 3D block loader — three cubes drop into place bottom-to-top
 * (like something being built), hold, then rebuild in a loop. Uses `currentColor`
 * at three opacities for the top/left/right faces so it shades like a 3D cube and
 * adapts to light/dark. Set the colour via a `text-*` class on the wrapper.
 */
function BuildingCubes() {
  // One isometric cube (top + two side faces) at top-vertex (x, y).
  const HW = 15
  const Q = 7
  const BH = 14
  const cube = (x: number, y: number, delay: number) => (
    <g className="qc-build-block" style={{ animationDelay: `${delay}ms` }}>
      {/* top face — brightest */}
      <polygon
        points={`${x},${y} ${x + HW},${y + Q} ${x},${y + 2 * Q} ${x - HW},${y + Q}`}
        fill="currentColor"
        opacity={0.95}
      />
      {/* left face — mid */}
      <polygon
        points={`${x - HW},${y + Q} ${x},${y + 2 * Q} ${x},${y + 2 * Q + BH} ${x - HW},${y + Q + BH}`}
        fill="currentColor"
        opacity={0.55}
      />
      {/* right face — darkest */}
      <polygon
        points={`${x + HW},${y + Q} ${x},${y + 2 * Q} ${x},${y + 2 * Q + BH} ${x + HW},${y + Q + BH}`}
        fill="currentColor"
        opacity={0.32}
      />
    </g>
  )
  return (
    <svg viewBox="0 0 72 72" className="size-16 text-primary" role="img" aria-label="Building">
      {/* bottom → middle → top, each delayed so the tower assembles upward */}
      {cube(36, 40, 0)}
      {cube(36, 26, 260)}
      {cube(36, 12, 520)}
    </svg>
  )
}

/** Three bouncing dots — small motion cue that "something's happening". */
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-foreground/60"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  )
}

/** Centered loading card shown over the skeleton while building/updating. */
function BuildingOverlay({ updating }: { updating: boolean }) {
  const phases = updating ? UPDATE_PHASES : BUILD_PHASES
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center rounded-b-2xl bg-background/40 backdrop-blur-[1px]">
      <div className="flex w-[min(92%,26rem)] flex-col items-center gap-5 rounded-3xl border border-border/60 bg-card px-10 py-9 shadow-xl">
        <BuildingCubes />
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="flex items-center gap-2.5 text-lg font-semibold">
            {updating ? 'Updating your prototype' : 'Building your prototype'}
            <TypingDots />
          </p>
          {/* Rotating phrase keeps the wait feeling like progress. */}
          <RotatingStatus phases={phases} />
          <p className="mt-1 text-xs tabular-nums text-muted-foreground/70">
            <ElapsedTimer /> elapsed
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- preview pane

function PreviewPane({
  html,
  code,
  view,
  onView,
  pending,
  className,
  versions,
  viewVersion,
  onViewVersion,
  onRestore,
  restoring,
  onCompare,
  loadingVersion,
  commentMode,
  onCommentMode,
  comments,
  onPick,
  onRemoveComment,
  onApplyComments,
  onDownload,
}: {
  html: string | undefined
  code: string
  view: 'preview' | 'code'
  onView: (v: 'preview' | 'code') => void
  pending: boolean
  className?: string
  /** Click-to-comment on the rendered screen (Claude-Design-style annotation). */
  commentMode: boolean
  onCommentMode: (on: boolean) => void
  comments: PinComment[]
  onPick: (target: { label: string; path: string }) => void
  onRemoveComment: (id: string) => void
  onApplyComments: () => void
  onDownload: () => void
  /** Revision history of the selected prototype (oldest first). */
  versions: PrototypeVersionMeta[]
  /** Which revision is on screen — null means the current document. */
  viewVersion: number | null
  onViewVersion: (n: number | null) => void
  onRestore: (n: number) => void
  restoring: boolean
  onCompare: () => void
  loadingVersion: boolean
}) {
  const [device, setDevice] = useState<Device>('desktop')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  // Bump this to force the iframe to remount (a manual refresh).
  const [nonce, setNonce] = useState(0)
  const framed = DEVICES.find((d) => d.id === device)?.frame != null
  const [capturing, setCapturing] = useState(false)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLPreElement>(null)
  // The newest revision IS the current document, so `viewVersion === null` and
  // `viewVersion === latestVersion` mean the same thing on screen.
  const latestVersion = versions.at(-1)?.n ?? 1
  const shownVersion = viewVersion ?? latestVersion
  const viewingOlder = viewVersion != null && viewVersion !== latestVersion

  async function captureImage() {
    if (!html || capturing) return
    setCapturing(true)
    try {
      await captureHtmlToClipboard(html)
      toast.success('Preview image copied to clipboard')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not capture the preview')
    } finally {
      setCapturing(false)
    }
  }

  async function copyCode() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
      toast.success('Code copied to clipboard')
    } catch {
      toast.error('Could not copy the code')
    }
  }
  // Keep the streaming code view pinned to the bottom as it grows (smooth, no reload).
  useEffect(() => {
    if (view === 'code' && codeRef.current) codeRef.current.scrollTop = codeRef.current.scrollHeight
  }, [code, view])

  // Receive picked elements from the preview iframe. The frame is a null origin, so we
  // can't check e.origin usefully — validate the payload SHAPE instead, and only listen
  // while comment mode is actually on.
  useEffect(() => {
    if (!commentMode) return
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string; label?: unknown; path?: unknown } | null
      if (!d || typeof d !== 'object' || d.source !== 'qc-prototype' || d.type !== 'pick') return
      onPick({
        label: typeof d.label === 'string' ? d.label.slice(0, 140) : 'element',
        path: typeof d.path === 'string' ? d.path.slice(0, 300) : '',
      })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [commentMode, onPick])

  // Comment mode is about the live screen — it means nothing in the code view.
  useEffect(() => {
    if (view !== 'preview' && commentMode) onCommentMode(false)
  }, [view, commentMode, onCommentMode])

  return (
    <div
      data-tour="preview"
      className={cn('flex min-h-0 flex-col rounded-2xl border border-border/60 bg-card shadow-none', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1 rounded-full bg-muted/60 p-0.5">
          {(['preview', 'code'] as const).map((v) => (
            <Tip
              key={v}
              label={v === 'preview' ? 'Preview — see the rendered UI' : 'Code — view the generated HTML'}
            >
              <button
                type="button"
                onClick={() => onView(v)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors',
                  view === v ? 'bg-background shadow-sm' : 'text-muted-foreground',
                )}
              >
                {v}
                {v === 'code' && pending && <Loader2 className="size-3 animate-spin" />}
              </button>
            </Tip>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {view === 'preview' && (
            <div className="mr-1 flex items-center gap-1 rounded-full bg-muted/60 p-0.5">
              {DEVICES.map((d) => {
                const Icon = d.icon
                return (
                  <Tip key={d.id} label={d.tip}>
                    <button
                      type="button"
                      onClick={() => setDevice(d.id)}
                      aria-label={d.label}
                      className={cn(
                        'rounded-full px-2 py-1 transition-colors',
                        device === d.id ? 'bg-background shadow-sm' : 'text-muted-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                    </button>
                  </Tip>
                )
              })}
            </div>
          )}
          {view === 'preview' && framed && (
            <Tip label={`Rotate to ${orientation === 'portrait' ? 'landscape' : 'portrait'}`}>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOrientation((o) => (o === 'portrait' ? 'landscape' : 'portrait'))}
                className={cn(
                  'size-8 rounded-lg text-muted-foreground transition-transform hover:text-foreground',
                  orientation === 'landscape' && 'rotate-90',
                )}
              >
                <RotateCw className="size-3.5" />
              </Button>
            </Tip>
          )}
          {/* Point at the thing instead of describing it — the fastest way to say
              "this button is wrong" without writing a paragraph about which button. */}
          {view === 'preview' && (
            <Tip
              label={
                commentMode
                  ? 'Comment mode is ON — click any element in the screen to comment on it. Click here to exit.'
                  : 'Comment on the screen — click an element and say what should change, instead of describing where it is'
              }
            >
              <Button
                variant={commentMode ? 'default' : 'ghost'}
                size="icon"
                onClick={() => onCommentMode(!commentMode)}
                disabled={!html}
                className={cn(
                  'relative size-8 rounded-lg transition-all active:scale-[0.98]',
                  !commentMode && 'text-muted-foreground hover:text-foreground',
                )}
                aria-pressed={commentMode}
                aria-label="Comment mode"
              >
                <MessageSquarePlus className="size-3.5" />
                {comments.length > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] font-semibold tabular-nums text-primary-foreground ring-2 ring-card">
                    {comments.length}
                  </span>
                )}
              </Button>
            </Tip>
          )}
          {view === 'preview' && (
            <Tip label="Capture a PNG snapshot of the preview to your clipboard">
              <Button
                variant="ghost"
                size="icon"
                onClick={captureImage}
                disabled={!html || capturing}
                className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
              >
                {capturing ? <Loader2 className="size-3.5 animate-spin" /> : <Camera className="size-3.5" />}
              </Button>
            </Tip>
          )}
          <Tip label="Download as a standalone .html file — opens in any browser, no server needed">
            <Button
              variant="ghost"
              size="icon"
              onClick={onDownload}
              disabled={!html}
              className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
              aria-label="Download HTML"
            >
              <Download className="size-3.5" />
            </Button>
          </Tip>
          {view === 'code' && (
            <Tip label="Copy the generated HTML to your clipboard">
              <Button
                variant="ghost"
                size="icon"
                onClick={copyCode}
                disabled={!code}
                className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
              >
                {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
              </Button>
            </Tip>
          )}
          <Tip label="Reload the preview — re-render the current HTML">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setNonce((n) => n + 1)}
              disabled={!html || view !== 'preview'}
              className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          </Tip>
          <Tip label="Open the prototype in a new browser tab">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => html && openInNewTab(html)}
              disabled={!html}
              className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </Button>
          </Tip>
        </div>
      </div>

      {/* Revision bar — a refine APPENDS a version, so nothing is lost. Only shown once
          there's history to move through (or while an older revision is on screen). */}
      {!pending && (versions.length > 1 || viewVersion != null) && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1.5',
            viewingOlder && 'bg-amber-50 dark:bg-amber-950/40',
          )}
        >
          <History className="size-3.5 shrink-0 text-muted-foreground" />
          <Select
            value={String(shownVersion)}
            onValueChange={(v) => onViewVersion(Number(v) === latestVersion ? null : Number(v))}
          >
            <SelectTrigger className="h-7 w-[132px] rounded-lg text-xs shadow-none">
              <span className="truncate">
                v{shownVersion}
                {shownVersion === latestVersion ? ' · latest' : ''}
              </span>
            </SelectTrigger>
            <SelectContent className="max-w-[380px]">
              {[...versions].reverse().map((v) => (
                <SelectItem key={v.n} value={String(v.n)} textValue={`v${v.n}`} className="text-xs">
                  <VersionLabel v={v} latest={v.n === latestVersion} />
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {loadingVersion && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {viewingOlder ? (
            <>
              <span className="text-[11px] font-medium text-amber-700 dark:text-amber-400">
                Viewing an older revision — not the current one.
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onViewVersion(null)}
                  className="h-7 rounded-full px-2.5 text-[11px]"
                >
                  Back to latest
                </Button>
                <Tip label="Make this revision the current document (appended as a new revision, so this is undoable)">
                  <Button
                    size="sm"
                    onClick={() => onRestore(shownVersion)}
                    disabled={restoring}
                    className="h-7 gap-1 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
                  >
                    {restoring ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Undo2 className="size-3" />
                    )}
                    Restore v{shownVersion}
                  </Button>
                </Tip>
              </div>
            </>
          ) : (
            <>
              <span className="truncate text-[11px] text-muted-foreground">
                {versions.length} revision{versions.length === 1 ? '' : 's'} · every refine is kept
              </span>
              <Tip label="Compare two revisions side by side">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onCompare}
                  disabled={versions.length < 2}
                  className="ml-auto h-7 gap-1 rounded-full px-2.5 text-[11px]"
                >
                  <Columns2 className="size-3" />
                  Compare
                </Button>
              </Tip>
            </>
          )}
        </div>
      )}

      {/* Comment mode: the instruction + every pin so far, applied as ONE refine. */}
      {view === 'preview' && (commentMode || comments.length > 0) && !pending && (
        <div className="space-y-1.5 border-b border-border/60 bg-primary/5 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <MessageSquarePlus className="size-3.5 shrink-0 text-primary" />
            <span className="text-[11px] font-medium text-primary">
              {commentMode
                ? 'Click any element in the screen to comment on it'
                : `${comments.length} comment${comments.length === 1 ? '' : 's'} pinned`}
            </span>
            {comments.length > 0 && (
              <Button
                size="sm"
                onClick={onApplyComments}
                className="ml-auto h-7 gap-1 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
              >
                <ArrowUp className="size-3" />
                Apply {comments.length} comment{comments.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
          {comments.length > 0 && (
            <ol className="space-y-1">
              {comments.map((c, i) => (
                <li
                  key={c.id}
                  className="flex items-start gap-2 rounded-xl border border-border/60 bg-card px-2 py-1.5"
                >
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-[9px] font-semibold text-primary-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-[11px] leading-snug">
                    <span className="block truncate font-mono text-[10px] text-muted-foreground" title={c.path}>
                      {c.label}
                    </span>
                    <span className="text-foreground">{c.text}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveComment(c.id)}
                    className="mt-0.5 shrink-0 text-muted-foreground transition-colors hover:text-destructive"
                    aria-label="Remove comment"
                  >
                    <X className="size-3" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {view === 'code' ? (
        <div className="relative min-h-0 flex-1">
          <pre
            ref={codeRef}
            className="h-full max-h-[84vh] min-h-[84vh] overflow-auto rounded-b-2xl bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-200"
          >
            {code || (pending ? '' : '// The generated HTML will appear here.')}
            {pending && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-zinc-400 align-middle" />}
          </pre>
          {pending && (
            <div className="pointer-events-none absolute right-4 top-3 inline-flex items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-xs font-medium text-foreground shadow">
              <Loader2 className="size-3.5 animate-spin" />
              Streaming… <ElapsedTimer />
            </div>
          )}
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-auto rounded-b-2xl bg-muted/30 p-3">
          {pending ? (
            // Building or updating: always show the skeleton with a loading overlay,
            // never the stale/old preview.
            <>
              <PreviewSkeleton />
              <BuildingOverlay updating={!!html} />
            </>
          ) : html ? (
            <DeviceStage
              device={device}
              orientation={orientation}
              html={html}
              nonce={nonce}
              commentMode={commentMode}
            />
          ) : (
            <div className="flex h-full min-h-[84vh] items-center justify-center text-center text-sm text-muted-foreground">
              Your prototype will render here.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- chat

function MessageBubble({ m }: { m: PrototypeMessage }) {
  const isUser = m.role === 'user'
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
          isUser
            ? 'rounded-br-md bg-primary text-primary-foreground'
            : 'rounded-bl-md border border-border/60 bg-muted/50 text-foreground',
        )}
      >
        {!isUser && (
          <span className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Sparkles className="size-3" />
            Prototype
          </span>
        )}
        <span className="whitespace-pre-wrap break-words">{m.text}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- logs

interface LogLine {
  level: 'info' | 'success' | 'error'
  text: string
}

/** Collapsible terminal-style panel of the Claude Code build logs. */
function LogPanel({
  logs,
  open,
  onToggle,
  busy,
}: {
  logs: LogLine[]
  open: boolean
  onToggle: () => void
  busy: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [logs.length, open])
  return (
    <div className="rounded-2xl border border-border/60 bg-card shadow-none">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between px-4 py-2.5"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <TerminalSquare className="size-4 text-muted-foreground" />
          Claude logs
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {logs.length}
          </span>
          {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </span>
        <ChevronDown
          className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          ref={ref}
          className="max-h-72 overflow-auto rounded-b-2xl border-t border-border/60 bg-zinc-950 p-3 font-mono text-xs leading-relaxed"
        >
          {logs.length === 0 ? (
            <p className="text-zinc-500">No logs yet.</p>
          ) : (
            logs.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-all',
                  l.level === 'error'
                    ? 'text-red-400'
                    : l.level === 'success'
                      ? 'text-emerald-400'
                      : 'text-zinc-300',
                )}
              >
                {l.text}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- ticket linking

/**
 * Pick an already-crawled ticket to build the prototype FROM. Keyed on the ticket's
 * on-disk FOLDER (`c.name`, possibly nested PARENT/CHILD) rather than its display id,
 * because that folder is what the server reads the ticket from and where test-case
 * versions are written. Reuses the shared crawled-ticket tree so it nests and groups
 * exactly like every other crawled-ticket selector in the portal.
 */
function TicketLinkDialog({
  open,
  onOpenChange,
  projectId,
  value,
  onPick,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  value: string | null
  onPick: (t: CrawledTicket | null) => void
}) {
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const { data: crawled, isLoading } = useQuery({
    queryKey: ['crawled-tickets', projectId],
    queryFn: () => listCrawledTickets(projectId),
    enabled: !!projectId && open,
  })

  const q = query.trim().toLowerCase()
  const tree = useMemo(() => {
    const sorted = [...(crawled ?? [])].sort((a, b) =>
      (b.crawledAt ?? '').localeCompare(a.crawledAt ?? ''),
    )
    return buildCrawledTree(sorted, {
      collapsed,
      match: q
        ? (t) =>
            (t.displayId ?? t.name).toLowerCase().includes(q) ||
            (t.title ?? '').toLowerCase().includes(q)
        : undefined,
    })
  }, [crawled, q, collapsed])

  const toggleCollapse = (name: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TicketIcon className="size-4" />
            Build from a ticket
          </DialogTitle>
          <DialogDescription>
            The ticket’s description, comments and acceptance criteria become the prototype’s scope —
            so the screen uses the requirement’s real names and covers the states it asks for.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by id or title…"
            className="h-10 w-full rounded-full border border-input bg-transparent px-4 pl-9 text-sm outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50"
          />
        </div>

        <div className="max-h-[45vh] overflow-y-auto rounded-2xl border border-border/60">
          {isLoading ? (
            <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading crawled tickets…
            </div>
          ) : (crawled?.length ?? 0) === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              No crawled tickets yet — crawl one on the <span className="font-medium">Tickets</span>{' '}
              page and it’ll show up here.
            </div>
          ) : tree.count === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">
              No crawled ticket matches “{query}”.
            </div>
          ) : (
            tree.groups.map((group) => (
              <div key={group.status || '∅'}>
                <CrawledStatusHeader status={group.status} count={group.roots.length} />
                <ul className="divide-y">
                  {tree.rows(group.roots).map(({ ticket: t, depth, hasChildren }) => (
                    <li key={t.name}>
                      <CrawledTicketRow
                        ticket={t}
                        depth={depth}
                        hasChildren={hasChildren}
                        isOpen={!collapsed.has(t.name)}
                        onToggleExpand={() => toggleCollapse(t.name)}
                        selected={t.name === value}
                        onSelect={() => {
                          onPick(t)
                          onOpenChange(false)
                          setQuery('')
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          {value && (
            <Button
              variant="ghost"
              onClick={() => {
                onPick(null)
                onOpenChange(false)
              }}
              className="rounded-full text-muted-foreground"
            >
              <X className="size-4" />
              Unlink ticket
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)} className="rounded-full">
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The grounding strip above the chat: what this prototype is built FROM. A linked ticket
 * supplies the requirement (scope + real names); "Match our app" additionally lets the
 * build read the project's own source so the mock-up looks like the real product. Both
 * apply to the NEXT build, and both persist on the prototype for later refines.
 */
function GroundingBar({
  ticketId,
  ticketTitle,
  ticketFolder,
  matchApp,
  onPickTicket,
  onToggleMatchApp,
  disabled,
  designSystem,
  onOpenDesignSystem,
}: {
  ticketId: string | null
  ticketTitle: string | null
  ticketFolder: string | null
  matchApp: boolean
  onPickTicket: () => void
  onToggleMatchApp: () => void
  disabled: boolean
  designSystem: DesignSystemInfo | undefined
  onOpenDesignSystem: () => void
}) {
  const hasDs = !!designSystem?.exists
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
      <Tip
        label={
          ticketFolder
            ? 'Built from this ticket — click to change or unlink'
            : 'Build from a crawled ticket so the screen matches the requirement'
        }
      >
        <button
          type="button"
          onClick={onPickTicket}
          disabled={disabled}
          className={cn(
            'inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50',
            ticketFolder
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-dashed border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          <TicketIcon className="size-3 shrink-0" />
          {ticketFolder ? (
            <>
              <span className="font-mono">{ticketId ?? ticketFolder}</span>
              {ticketTitle && (
                <span className="max-w-[9rem] truncate font-normal opacity-70">{ticketTitle}</span>
              )}
            </>
          ) : (
            'Build from a ticket'
          )}
        </button>
      </Tip>
      {/* The design system, extracted once, is what makes every prototype look like the
          same product. Surfaced here so it's obvious whether builds are using it. */}
      <Tip
        label={
          hasDs
            ? "Using this project's design system — the real app's palette, type, components and wording. Click to view or re-extract."
            : "No design system yet. Extract the real app's visual language once, and every prototype will match the product."
        }
      >
        <button
          type="button"
          onClick={onOpenDesignSystem}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
            hasDs
              ? 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950 dark:text-violet-300'
              : 'border-dashed border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          <Palette className="size-3 shrink-0" />
          Design system
          {hasDs && <Check className="size-3" />}
        </button>
      </Tip>
      <Tip label="Read this project's real source code so the prototype matches the app's design language, field names and terminology (slower)">
        <button
          type="button"
          onClick={onToggleMatchApp}
          disabled={disabled}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50',
            matchApp
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300'
              : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground',
          )}
        >
          {matchApp ? <Check className="size-3" /> : <Code2 className="size-3" />}
          Match our app
        </button>
      </Tip>
    </div>
  )
}

// ---------------------------------------------------------------- revisions

/** Compact absolute time for a revision row ("Jul 16, 02:30 PM" → same as formatCreated). */
function VersionLabel({ v, latest }: { v: PrototypeVersionMeta; latest: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-medium tabular-nums">v{v.n}</span>
      {latest && <span className="text-[10px] uppercase tracking-wide opacity-60">latest</span>}
      <span className="truncate text-[11px] opacity-60">{v.prompt || v.summary}</span>
    </span>
  )
}

/**
 * Side-by-side comparison of two revisions, each rendered in its own sandboxed iframe.
 * This is what makes a refine safe to try: you can see exactly what changed, and restore
 * the older document from the revision bar if the new one went the wrong way.
 */
function CompareDialog({
  open,
  onOpenChange,
  projectId,
  slug,
  versions,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  slug: string
  versions: PrototypeVersionMeta[]
}) {
  const latest = versions.at(-1)?.n ?? 1
  const previous = versions.length > 1 ? versions.at(-2)!.n : latest
  const [left, setLeft] = useState(previous)
  const [right, setRight] = useState(latest)

  const leftQ = useQuery({
    queryKey: ['prototype-version', projectId, slug, left],
    queryFn: () => getPrototypeVersion(projectId, slug, left),
    enabled: open,
  })
  const rightQ = useQuery({
    queryKey: ['prototype-version', projectId, slug, right],
    queryFn: () => getPrototypeVersion(projectId, slug, right),
    enabled: open,
  })

  const picker = (value: number, onChange: (n: number) => void) => (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger className="h-8 w-full rounded-lg text-xs shadow-none">
        <span className="truncate">
          v{value}
          {value === latest ? ' · latest' : ''}
        </span>
      </SelectTrigger>
      <SelectContent className="max-w-[360px]">
        {[...versions].reverse().map((v) => (
          <SelectItem key={v.n} value={String(v.n)} textValue={`v${v.n}`} className="text-xs">
            <VersionLabel v={v} latest={v.n === latest} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const pane = (q: typeof leftQ) => (
    <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-white">
      {q.isLoading ? (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : q.data?.html ? (
        <iframe
          title={`Revision v${q.data.n}`}
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={q.data.html}
          className="h-full w-full border-0 bg-white"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
          Could not load this revision.
        </div>
      )}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[88vh] max-w-[96vw] flex-col rounded-3xl sm:max-w-[96vw]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Columns2 className="size-4" />
            Compare revisions
          </DialogTitle>
          <DialogDescription>
            Both revisions render live — scroll each independently to see what the refine changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
          <div className="flex min-h-0 flex-col gap-2">
            {picker(left, setLeft)}
            {pane(leftQ)}
          </div>
          <div className="flex min-h-0 flex-col gap-2">
            {picker(right, setRight)}
            {pane(rightQ)}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- test cases

/**
 * Draft manual test cases from the prototype. The prototype's markup carries the real
 * labels, fields, constraints and states, so the cases come out executable instead of
 * paraphrasing the ticket — and they save as a new version under the LINKED ticket, which
 * is why a ticket link is required here.
 */
function TestcasesDialog({
  open,
  onOpenChange,
  projectId,
  slug,
  ticketId,
  ticketFolder,
  model,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  slug: string
  ticketId: string | null
  ticketFolder: string | null
  model: string
}) {
  const queryClient = useQueryClient()
  const [instructions, setInstructions] = useState('')
  const [result, setResult] = useState<{ savedTo: string; version: number; count: number } | null>(
    null,
  )

  const mut = useMutation({
    mutationFn: () => generateTestcasesFromPrototype(projectId, slug, { model, instructions }),
    onSuccess: (r) => {
      setResult({
        savedTo: r.savedTo,
        version: r.version,
        // Rough case count for the confirmation line — rows/headings in the output.
        count: r.testcases.split('\n').filter((l) => /^\s*\|?\s*(TC|No)[-\s]?\d/i.test(l)).length,
      })
      queryClient.invalidateQueries({ queryKey: ['crawled-tickets', projectId] })
      queryClient.invalidateQueries({ queryKey: ['crawled', projectId] })
      queryClient.invalidateQueries({ queryKey: ['testcase-versions', projectId] })
      toast.success(`Test cases saved as v${r.version}`)
    },
    onError: (e) =>
      toast.error('Could not generate test cases', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && mut.isPending) return // a generation is in flight — don't drop it silently
        if (!v) {
          setResult(null)
          setInstructions('')
        }
        onOpenChange(v)
      }}
    >
      <DialogContent className="rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="size-4" />
            Test cases from this prototype
          </DialogTitle>
          <DialogDescription>
            {ticketFolder ? (
              <>
                Claude reads the prototype’s markup for the real field names, labels, constraints and
                states, keeps the scope from{' '}
                <span className="font-mono font-medium text-foreground">
                  {ticketId ?? ticketFolder}
                </span>
                , and saves a new test-case version under that ticket.
              </>
            ) : (
              'Link this prototype to a crawled ticket first — test-case versions are stored under the ticket, and the ticket defines the acceptance scope.'
            )}
          </DialogDescription>
        </DialogHeader>

        {ticketFolder && !result && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Extra instructions (optional)
            </label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              disabled={mut.isPending}
              rows={3}
              placeholder="e.g. focus on validation and permissions; skip visual styling cases"
              className="resize-y rounded-xl text-sm"
            />
          </div>
        )}

        {result && (
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950">
            <p className="flex items-center gap-1.5 font-medium text-emerald-800 dark:text-emerald-300">
              <Check className="size-4" />
              Saved as v{result.version}
              {result.count > 0 && ` · ~${result.count} cases`}
            </p>
            <p className="mt-1 break-all font-mono text-[11px] text-emerald-700/80 dark:text-emerald-400/80">
              {result.savedTo}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={mut.isPending}
            className="rounded-full"
          >
            {result ? 'Done' : 'Cancel'}
          </Button>
          {ticketFolder && !result && (
            <Button
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {mut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ClipboardCheck className="size-4" />
              )}
              {mut.isPending ? 'Writing cases…' : 'Generate test cases'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- page

// ---------------------------------------------------------------- comment capture

/**
 * Asked as soon as an element is clicked in comment mode: what should change HERE.
 * The target is already known, so the engineer never has to describe where it is.
 */
function CommentDialog({
  target,
  onCancel,
  onSave,
}: {
  target: { label: string; path: string } | null
  onCancel: () => void
  onSave: (text: string) => void
}) {
  const [text, setText] = useState('')
  // Remount per target (key below) seeds an empty box without a setState-in-effect.
  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquarePlus className="size-4" />
            Comment on this element
          </DialogTitle>
          <DialogDescription className="space-y-1">
            <span className="block font-mono text-xs text-foreground">{target?.label}</span>
            {target?.path && (
              <span className="block truncate font-mono text-[10px] opacity-70">{target.path}</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
              e.preventDefault()
              onSave(text.trim())
            }
          }}
          placeholder="What should change here? e.g. “make this a secondary button”, “this label should read Member ID”"
          rows={3}
          className="min-h-[84px] resize-y rounded-xl"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} className="rounded-full">
            Cancel
          </Button>
          <Button
            onClick={() => onSave(text.trim())}
            disabled={!text.trim()}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            <Check className="size-4" />
            Pin comment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- design system

/**
 * The project's design system: extract the real app's visual language ONCE, then every
 * prototype inherits it. Stored as the `design-system` knowledge doc, so it's also
 * editable on Instructions → Knowledge and reaches test-case generation and QC runs.
 */
function DesignSystemDialog({
  open,
  onOpenChange,
  projectId,
  model,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  model: string
}) {
  const queryClient = useQueryClient()
  const { data, isLoading } = useQuery({
    queryKey: ['design-system', projectId],
    queryFn: () => getDesignSystem(projectId),
    enabled: open,
  })
  const gen = useMutation({
    mutationFn: () => generateDesignSystem(projectId, model),
    onSuccess: (info) => {
      queryClient.setQueryData(['design-system', projectId], info)
      // It's a knowledge doc — the Instructions page must see it too.
      queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] })
      toast.success('Design system extracted', {
        description: 'Every prototype from now on will match your app.',
      })
    },
    onError: (e) =>
      toast.error('Could not extract the design system', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })
  const exists = !!data?.exists

  return (
    <Dialog open={open} onOpenChange={(v) => !gen.isPending && onOpenChange(v)}>
      <DialogContent className="flex max-h-[85vh] flex-col rounded-3xl sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="size-4" />
            Project design system
          </DialogTitle>
          <DialogDescription>
            Read the real app's visual language once — palette, typography, spacing, component
            shapes and wording conventions — and every prototype is built to match it. Much faster
            and far more consistent than re-reading the source on every build. Saved as the{' '}
            <span className="font-mono text-xs">design-system</span> knowledge doc, so you can edit
            it on the Instructions page.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-auto">
            <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2">
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                  exists
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
                )}
              >
                {exists ? <Check className="size-3" /> : <Sparkles className="size-3" />}
                {exists ? 'In use by every build' : 'Not extracted yet'}
              </span>
              {exists && data?.savedAt && (
                <span className="text-[11px] text-muted-foreground">
                  {(data.size / 1024).toFixed(1)} KB · {formatCreated(data.savedAt)}
                  {data.source ? ' · AI-extracted' : ' · edited by you'}
                </span>
              )}
              <Tip
                label={
                  data?.hasSource === false
                    ? 'No source code is connected to this project — connect a repo on the Source Code page first'
                    : "Read the app's source and write the design system (a cheap, read-only AI pass — it never modifies your repo)"
                }
              >
                <Button
                  onClick={() => gen.mutate()}
                  disabled={gen.isPending || data?.hasSource === false}
                  className="ml-auto gap-1.5 rounded-full active:scale-[0.98]"
                >
                  {gen.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Palette className="size-4" />
                  )}
                  {exists ? 'Re-extract' : 'Extract from source'}
                </Button>
              </Tip>
            </div>
            {gen.isPending && (
              <p className="flex items-center gap-2 rounded-2xl border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                Reading the app's styling, components and strings… this takes a minute or two, and
                only has to happen once.
              </p>
            )}
            {exists ? (
              <pre className="whitespace-pre-wrap rounded-2xl border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">
                {data?.content}
              </pre>
            ) : (
              !gen.isPending && (
                <p className="rounded-2xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                  Without a design system, prototypes look polished but generic. Extract one and
                  they'll use your product's real colours, fonts, components and terminology.
                </p>
              )
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- open questions

/**
 * Open questions the build had to guess about, and the BA's answers.
 *
 * This is what turns a prototype into a requirements instrument: instead of an assumption
 * being silently baked into the markup, it's asked out loud, and the answer is stored as a
 * decision that grounds every later build. Answering re-runs the build with the answers.
 */
function QuestionsPanel({
  questions,
  decisions,
  answers,
  onAnswerChange,
  onSend,
  onDismiss,
  disabled,
}: {
  questions: string[]
  decisions: PrototypeDecision[]
  answers: Record<string, string>
  onAnswerChange: (q: string, a: string) => void
  onSend: () => void
  onDismiss: (q: string) => void
  disabled: boolean
}) {
  const [showDecisions, setShowDecisions] = useState(false)
  const answeredCount = questions.filter((q) => (answers[q] ?? '').trim()).length
  if (!questions.length && !decisions.length) return null

  return (
    <div className="mb-2.5 space-y-2">
      {questions.length > 0 && (
        <div className="space-y-2 rounded-2xl border border-amber-200 bg-amber-50 p-2.5 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800 dark:text-amber-300">
            <HelpCircle className="size-3.5 shrink-0" />
            {questions.length} open question{questions.length === 1 ? '' : 's'} for the BA
          </p>
          <p className="text-[10px] leading-snug text-amber-700/80 dark:text-amber-400/80">
            The build had to assume these. Answer any of them and the screen is rebuilt to
            match — the answer is remembered and never asked again. They stay here until you
            answer or dismiss them.
          </p>
          {questions.map((q) => (
            <div key={q} className="space-y-1">
              <div className="flex items-start gap-1.5">
                <p className="flex-1 text-[11px] font-medium leading-snug text-foreground">{q}</p>
                <Tip label="Dismiss — this one doesn't need an answer">
                  <button
                    type="button"
                    onClick={() => onDismiss(q)}
                    disabled={disabled}
                    className="mt-0.5 shrink-0 text-amber-700/60 transition-colors hover:text-destructive disabled:opacity-50 dark:text-amber-400/60"
                    aria-label="Dismiss question"
                  >
                    <X className="size-3" />
                  </button>
                </Tip>
              </div>
              <Textarea
                value={answers[q] ?? ''}
                onChange={(e) => onAnswerChange(q, e.target.value)}
                disabled={disabled}
                placeholder="Your answer…"
                rows={1}
                className="max-h-24 min-h-[32px] resize-y rounded-lg bg-background py-1.5 text-[11px]"
              />
            </div>
          ))}
          {answeredCount > 0 && (
            <Button
              size="sm"
              onClick={onSend}
              disabled={disabled}
              className="h-7 w-full gap-1 rounded-full text-[11px] active:scale-[0.98]"
            >
              <ArrowUp className="size-3" />
              Answer {answeredCount} & rebuild
            </Button>
          )}
        </div>
      )}
      {decisions.length > 0 && (
        <div className="rounded-2xl border border-border/60 bg-muted/30 px-2.5 py-1.5">
          <button
            type="button"
            onClick={() => setShowDecisions((s) => !s)}
            className="flex w-full items-center gap-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <ClipboardCheck className="size-3.5 shrink-0" />
            {decisions.length} confirmed decision{decisions.length === 1 ? '' : 's'}
            <ChevronDown
              className={cn('ml-auto size-3.5 transition-transform', showDecisions && 'rotate-180')}
            />
          </button>
          {showDecisions && (
            <ul className="mt-1.5 space-y-1.5 border-t border-border/60 pt-1.5">
              {decisions.map((d, i) => (
                <li key={i} className="text-[11px] leading-snug">
                  <span className="block text-muted-foreground">{d.q}</span>
                  <span className="block font-medium text-foreground">→ {d.a}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export default function PrototypePageWrapper() {
  const { activeProjectId } = useProjects()
  if (!activeProjectId) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Select a project to build prototypes.
      </div>
    )
  }
  return <PrototypePage key={activeProjectId} projectId={activeProjectId} />
}

function PrototypePage({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [model, setModel] = useState<string>(() => loadModel())
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  // Controller for the in-flight build, so Stop can abort it (which kills the
  // server-side claude process too — see routes/prototype.ts).
  const abortRef = useRef<AbortController | null>(null)
  // Streaming state: the HTML built up so far + a busy flag + the prompt in flight.
  const [busy, setBusy] = useState(false)
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null)
  const [streamText, setStreamText] = useState('')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [logsOpen, setLogsOpen] = useState(false)
  // Preview vs Code view. During a build we show Code (smooth streaming), then flip
  // back to Preview when the finished HTML is ready (rendered once — no flicker).
  const [view, setView] = useState<'preview' | 'code'>('preview')
  // Chat placement: docked (in the workspace) or a floating bubble bottom-right.
  const [chatFloating, setChatFloating] = useState<boolean>(() => loadChatFloating())
  const [floatOpen, setFloatOpen] = useState(true)
  // Throttle iframe updates so the live preview visibly grows without thrashing.
  const accRef = useRef('')
  const flushRef = useRef<number | null>(null)
  // Images attached to the next prompt (drag-drop / paste / file picker).
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Follow-up suggestions the user has ticked to apply together.
  const [selectedSuggestions, setSelectedSuggestions] = useState<string[]>([])
  // Grounding for the NEXT build. `undefined` = inherit whatever the selected prototype
  // already stores; an explicit pick (including `null` = unlink) overrides it. Keeping
  // "not chosen" distinct from "chosen as none" is what lets a follow-up refine stay
  // bound to the prototype's ticket without re-picking it every turn.
  const [pendingTicket, setPendingTicket] = useState<CrawledTicket | null | undefined>(undefined)
  const [pendingMatchApp, setPendingMatchApp] = useState<boolean | undefined>(undefined)
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false)
  const [compareOpen, setCompareOpen] = useState(false)
  const [testcasesOpen, setTestcasesOpen] = useState(false)
  const [designSystemOpen, setDesignSystemOpen] = useState(false)
  // Comment mode: click an element in the preview, say what should change there. Pins are
  // client-side until applied — sending them is what turns them into one refine.
  const [commentMode, setCommentMode] = useState(false)
  const [comments, setComments] = useState<PinComment[]>([])
  const [pendingPick, setPendingPick] = useState<{ label: string; path: string } | null>(null)
  // Draft answers to the build's open questions, keyed by the question text.
  const [answers, setAnswers] = useState<Record<string, string>>({})
  // Which revision is on screen — null = the current document.
  const [viewVersion, setViewVersion] = useState<number | null>(null)
  // Start settings (design direction) for the first build of a new prototype.
  const [styleSettings, setStyleSettings] = useState<StyleSettings>(() => loadStyle())
  useEffect(() => {
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(styleSettings))
    } catch {
      /* ignore */
    }
  }, [styleSettings])

  useEffect(() => {
    try {
      localStorage.setItem(MODEL_KEY, model)
    } catch {
      /* ignore */
    }
  }, [model])

  useEffect(() => {
    try {
      localStorage.setItem(CHAT_FLOAT_KEY, chatFloating ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [chatFloating])

  const { data: list } = useQuery({
    queryKey: ['prototypes', projectId],
    queryFn: () => listPrototypes(projectId),
    enabled: !!projectId,
  })

  const { data: current } = useQuery({
    queryKey: ['prototype', projectId, selected],
    queryFn: () => getPrototype(projectId, selected as string),
    enabled: !!projectId && !!selected,
  })

  // Whether builds have the app's design system to work from (shown in the grounding bar).
  const { data: designSystem } = useQuery({
    queryKey: ['design-system', projectId],
    queryFn: () => getDesignSystem(projectId),
    enabled: !!projectId,
  })

  // Keep the chat scrolled to the newest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.messages.length, selected])

  const versions = current?.versions ?? []

  // Grounding actually in effect for the next build (see pendingTicket above).
  const ticketFolder =
    pendingTicket !== undefined ? (pendingTicket?.name ?? null) : (current?.ticketFolder ?? null)
  const ticketId =
    pendingTicket !== undefined
      ? (pendingTicket?.displayId ?? pendingTicket?.name ?? null)
      : (current?.ticketId ?? null)
  const ticketTitle =
    pendingTicket !== undefined ? (pendingTicket?.title ?? null) : (current?.ticketTitle ?? null)
  const matchApp = pendingMatchApp !== undefined ? pendingMatchApp : (current?.matchApp ?? false)

  // An older revision's HTML, fetched on demand (revision metadata alone is in `current`).
  const versionQ = useQuery({
    queryKey: ['prototype-version', projectId, selected, viewVersion],
    queryFn: () => getPrototypeVersion(projectId, selected as string, viewVersion as number),
    enabled: !!selected && viewVersion != null,
  })
  const shownHtml = viewVersion != null ? versionQ.data?.html : current?.html

  const dismissQuestionMut = useMutation({
    mutationFn: (question: string) =>
      dismissPrototypeQuestion(projectId, selected as string, question),
    onSuccess: (p) => queryClient.setQueryData(['prototype', projectId, p.slug], p),
    onError: (e) =>
      toast.error('Could not dismiss that question', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const restoreMut = useMutation({
    mutationFn: (version: number) =>
      restorePrototypeVersion(projectId, selected as string, version),
    onSuccess: (p) => {
      queryClient.setQueryData(['prototype', projectId, p.slug], p)
      queryClient.invalidateQueries({ queryKey: ['prototypes', projectId] })
      setViewVersion(null) // the restored document IS the current one now
      toast.success(`Restored — now v${p.versions?.at(-1)?.n ?? ''}`)
    },
    onError: (e) =>
      toast.error('Could not restore that revision', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  // Push the live-streamed HTML into the preview, throttled to ~every 180ms so a fast
  // stream doesn't reload the iframe on every token.
  const renderStream = (text: string) => {
    accRef.current = text
    // Coalesce bursts of deltas into ~one update per 120ms (text pane, so it's smooth).
    if (flushRef.current == null) {
      flushRef.current = window.setTimeout(() => {
        flushRef.current = null
        setStreamText(accRef.current)
      }, 120)
    }
  }

  const clearFlush = () => {
    if (flushRef.current != null) {
      window.clearTimeout(flushRef.current)
      flushRef.current = null
    }
  }

  // Add dropped/pasted/picked image files to the attachment tray.
  const addImageFiles = async (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (!imgs.length) return
    const room = MAX_IMAGES - attachedImages.length
    if (room <= 0) {
      toast.error(`Up to ${MAX_IMAGES} images.`)
      return
    }
    const picked: AttachedImage[] = []
    for (const f of imgs.slice(0, room)) {
      if (f.size > MAX_IMAGE_BYTES) {
        toast.error(`${f.name} is over 5 MB.`)
        continue
      }
      const a = await readImageFile(f)
      if (a) picked.push(a)
    }
    if (picked.length) setAttachedImages((cur) => [...cur, ...picked].slice(0, MAX_IMAGES))
  }

  const removeImage = (id: string) => setAttachedImages((cur) => cur.filter((a) => a.id !== id))

  const toggleSuggestion = (s: string) =>
    setSelectedSuggestions((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))

  // Send the ticked suggestions (plus any typed text) as one combined request.
  const applySuggestions = () => {
    if (busy) return
    const chosen = (current?.suggestions ?? []).filter((s) => selectedSuggestions.includes(s))
    const combined = [input.trim(), ...chosen].filter(Boolean).join('\n')
    if (!combined) return
    submit(combined)
  }

  const submit = (override?: string, opts?: { decisions?: { q: string; a: string }[] }) => {
    const text = (override ?? input).trim()
    const imgs = attachedImages.map((a) => ({ mediaType: a.mediaType, dataBase64: a.dataBase64 }))
    if ((!text && imgs.length === 0) || busy) return
    // An image with no words still gets a sensible instruction.
    const prompt = text || 'Build this screen based on the attached image(s).'
    setInput('') // clear the box immediately on send
    setSelectedSuggestions([]) // consumed
    setBusy(true)
    setPendingPrompt(imgs.length ? `${prompt} 🖼️×${imgs.length}` : prompt)
    setStreamText('')
    setLogs([])
    // Stay on whatever tab the user is on (Preview shows the skeleton / current build);
    // they can open Code themselves to watch it stream.
    accRef.current = ''
    const ac = new AbortController()
    abortRef.current = ac
    const targetSlug = selected ?? undefined

    streamPrototype(
      projectId,
      {
        slug: targetSlug,
        prompt,
        model,
        images: imgs,
        // Style settings only shape the FIRST build (no existing prototype).
        style: targetSlug ? undefined : styleSettings,
        // '' unlinks; the server persists both so a later refine inherits them.
        ticketFolder: ticketFolder ?? '',
        matchApp,
        decisions: opts?.decisions,
      },
      {
        onDelta: (t) => renderStream(accRef.current + t),
        onLog: (level, text) =>
          setLogs((cur) => {
            const next = [...cur, { level, text }]
            return next.length > 800 ? next.slice(-800) : next
          }),
        onDone: (p) => {
          clearFlush()
          queryClient.setQueryData(['prototype', projectId, p.slug], p)
          queryClient.invalidateQueries({ queryKey: ['prototypes', projectId] })
          setSelected(p.slug)
          setBusy(false)
          setPendingPrompt(null)
          setStreamText('')
          setAttachedImages([]) // consumed
          // The grounding is now persisted on the prototype, so drop the local override
          // and always show the new revision rather than whatever was being previewed.
          setPendingTicket(undefined)
          setPendingMatchApp(undefined)
          setViewVersion(null)
          // Comments and answers were consumed by this build.
          setComments([])
          setCommentMode(false)
          setAnswers({})
        },
        onError: (msg) => {
          clearFlush()
          setBusy(false)
          setPendingPrompt(null)
          setStreamText('')
          setInput((cur) => cur || text) // restore only what the user typed
          toast.error(targetSlug ? 'Could not update prototype' : 'Could not build prototype', {
            description: msg,
          })
        },
      },
      ac.signal,
    ).catch((e) => {
      // Transport error or a deliberate Stop (AbortError) — the latter is silent.
      clearFlush()
      setBusy(false)
      setPendingPrompt(null)
      setStreamText('')
      setInput((cur) => cur || text)
      const aborted = e instanceof DOMException && e.name === 'AbortError'
      if (!aborted) {
        toast.error('Prototype build failed', {
          description: e instanceof Error ? e.message : 'Unknown error',
        })
      }
    })
  }

  const stop = () => abortRef.current?.abort()

  /** Send every pinned comment as ONE refine, so the model sees them together. */
  const applyComments = () => {
    if (busy || comments.length === 0) return
    const extra = input.trim()
    submit([commentsToPrompt(comments), extra].filter(Boolean).join('\n\n'))
  }

  /**
   * Record the BA's answers and rebuild. The answers go up as `decisions` (persisted, and
   * injected into every later build) AND as the prompt, so this turn acts on them too.
   */
  const sendAnswers = () => {
    if (busy) return
    const picked = (current?.questions ?? [])
      .map((q) => ({ q, a: (answers[q] ?? '').trim() }))
      .filter((d) => d.a)
    if (!picked.length) return
    const prompt = [
      'The business analyst answered these open questions. Update the prototype so it matches these answers exactly:',
      ...picked.map((d, i) => `${i + 1}. Q: ${d.q}\n   A: ${d.a}`),
    ].join('\n')
    submit(prompt, { decisions: picked })
  }

  /** Save the document on screen as a standalone .html file. */
  const download = () => {
    if (!shownHtml) return
    const base = (current?.name ?? 'prototype').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '')
    const v = viewVersion ?? versions.at(-1)?.n
    downloadHtml(shownHtml, `${base || 'prototype'}${v ? `-v${v}` : ''}.html`)
  }

  // Clean up a pending throttle timer if the page unmounts mid-build.
  useEffect(
    () => () => {
      if (flushRef.current != null) window.clearTimeout(flushRef.current)
    },
    [],
  )

  const delMut = useMutation({
    mutationFn: (slug: string) => deletePrototype(projectId, slug),
    onSuccess: (_r, slug) => {
      queryClient.invalidateQueries({ queryKey: ['prototypes', projectId] })
      if (selected === slug) selectPrototype(null)
      setDeleting(null)
      toast.success('Prototype deleted')
    },
    onError: (e) =>
      toast.error('Could not delete', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const renameMut = useMutation({
    mutationFn: ({ slug, name }: { slug: string; name: string }) =>
      renamePrototype(projectId, slug, name),
    onSuccess: (p) => {
      queryClient.setQueryData(['prototype', projectId, p.slug], p)
      queryClient.invalidateQueries({ queryKey: ['prototypes', projectId] })
      setSettingsFor(null)
      toast.success('Prototype renamed')
    },
    onError: (e) =>
      toast.error('Could not rename', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const duplicateMut = useMutation({
    mutationFn: (slug: string) => duplicatePrototype(projectId, slug),
    onSuccess: (p) => {
      queryClient.setQueryData(['prototype', projectId, p.slug], p)
      queryClient.invalidateQueries({ queryKey: ['prototypes', projectId] })
      selectPrototype(p.slug)
      setSettingsFor(null)
      toast.success(`Duplicated as “${p.name}”`)
    },
    onError: (e) =>
      toast.error('Could not duplicate', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const commitRename = (slug: string) => {
    const name = renameValue.trim()
    if (!name) return
    renameMut.mutate({ slug, name })
  }

  /** Switch to another saved prototype — its own grounding + latest revision apply. */
  const selectPrototype = (slug: string | null) => {
    setSelected(slug)
    setPendingTicket(undefined)
    setPendingMatchApp(undefined)
    setViewVersion(null)
    // Pins and draft answers belong to the prototype you were looking at.
    setComments([])
    setCommentMode(false)
    setAnswers({})
  }

  const newPrototype = () => {
    selectPrototype(null)
    setInput('')
  }

  // Optimistic messages: while a turn is in flight, show the user's prompt + a
  // thinking bubble appended to whatever is stored.
  const messages = useMemo<PrototypeMessage[]>(() => {
    const base = selected ? (current?.messages ?? []) : []
    if (!busy || !pendingPrompt) return base
    return [...base, { role: 'user', text: pendingPrompt, at: '' }]
  }, [selected, current?.messages, busy, pendingPrompt])

  const modelPicker = (
    <Select value={model} onValueChange={setModel}>
      <SelectTrigger className="h-8 w-[104px] rounded-lg text-xs shadow-none">
        {/* Compact trigger: just the model name, not the full description. */}
        <span className="truncate">{MODEL_INFO[model as keyof typeof MODEL_INFO]?.label ?? model}</span>
      </SelectTrigger>
      <SelectContent className="max-w-[300px]">
        {MODELS.map((m) => (
          <SelectItem key={m} value={m} textValue={MODEL_INFO[m].label} className="text-xs">
            <div className="flex flex-col gap-0.5 py-0.5">
              <span className="font-medium">{MODEL_INFO[m].label}</span>
              <span className="text-[11px] leading-snug text-muted-foreground">{MODEL_INFO[m].desc}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div data-tour="header" className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Layout className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Prototype</h1>
            <p className="hidden max-w-2xl text-sm leading-6 text-muted-foreground sm:block">
              Describe a screen and the AI builds a working HTML prototype you can see instantly. Keep
              chatting to refine it — every prototype is saved to this project.
            </p>
          </div>
        </div>
        <div data-tour="model" className="flex shrink-0 items-center gap-2">
          {/* The QC payoff: turn the agreed screen into executable coverage. */}
          <Tip
            label={
              !selected
                ? 'Build a prototype first'
                : ticketFolder
                  ? 'Draft manual test cases from this prototype — its real labels, fields and states, scoped by the linked ticket'
                  : 'Link a ticket first — test-case versions are stored under the ticket'
            }
          >
            <Button
              variant="outline"
              onClick={() => setTestcasesOpen(true)}
              disabled={!selected || busy}
              className="h-8 gap-1.5 rounded-full text-xs active:scale-[0.98]"
            >
              <ClipboardCheck className="size-3.5" />
              Test cases
            </Button>
          </Tip>
          {modelPicker}
          <OpenFolderButton open={() => openPrototypesFolder(projectId)} label="Prototypes" />
        </div>
      </header>

      <div className={cn('grid grid-cols-1 gap-6', !chatFloating && 'lg:grid-cols-[240px_1fr]')}>
        {/* Saved prototypes. Docked: a left column (drops below the workspace on small
            screens). Ball mode: floats just to the LEFT of the chat box (lg+ only,
            where there's room); hidden while the chat is minimized to a bubble. */}
        <aside
          data-tour="saved"
          className={cn(
            chatFloating
              ? floatOpen
                ? 'fixed bottom-4 right-[calc(min(92vw,400px)+1.5rem)] z-40 hidden h-[min(80vh,640px)] w-[210px] flex-col space-y-2 overflow-auto rounded-2xl border border-border/60 bg-card p-2 shadow-2xl animate-in fade-in slide-in-from-right-4 duration-300 ease-out lg:flex'
                : 'hidden'
              : 'order-2 space-y-2 lg:order-1',
          )}
        >
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Prototypes
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={newPrototype}
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
              title="New prototype"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <div className="space-y-1">
            {(list ?? []).length === 0 && (
              <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                No prototypes yet.
              </p>
            )}
            {(list ?? []).map((item) => (
              <div
                key={item.slug}
                role="button"
                tabIndex={0}
                onClick={() => selectPrototype(item.slug)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    selectPrototype(item.slug)
                  }
                }}
                className={cn(
                  'group flex cursor-pointer items-center gap-1 rounded-lg border px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected === item.slug
                    ? 'border-primary/40 bg-primary/5'
                    : 'border-transparent hover:border-border/60 hover:bg-muted/40',
                )}
              >
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium leading-tight" title={item.name}>
                    {item.name}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] leading-tight text-muted-foreground">
                    <Clock className="size-2.5 shrink-0" />
                    {formatCreated(item.createdAt)}
                    {(item.versionCount ?? 0) > 1 && (
                      <span className="tabular-nums opacity-70">· v{item.versionCount}</span>
                    )}
                  </span>
                  {item.ticketId && (
                    <span
                      className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] leading-tight text-primary"
                      title={`Built from ${item.ticketId}`}
                    >
                      <TicketIcon className="size-2.5 shrink-0" />
                      {item.ticketId}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation()
                    setRenameValue(item.name)
                    setSettingsFor(item.slug)
                  }}
                  className="size-5 shrink-0 rounded-md text-muted-foreground opacity-60 transition-opacity hover:text-foreground group-hover:opacity-100"
                  aria-label={`Settings for ${item.name}`}
                  title="Settings"
                >
                  <Settings2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </aside>

        {/* Chat (compact) + preview (priority — takes the rest of the width).
            In floating mode the chat detaches to a bottom-right bubble and the
            preview spans the full width. */}
        <div
          className={cn(
            'order-1 grid min-w-0 grid-cols-1 gap-4 lg:order-2',
            !chatFloating && '2xl:grid-cols-[380px_minmax(0,1fr)]',
          )}
        >
          {/* Chat — on a narrow screen it sits ON TOP of the preview (the preview needs
              full width below to be usable); side-by-side (chat left) from lg up.
              Floating: a fixed bottom-right panel (or hidden behind the bubble). */}
          <div
            className={cn(
              'flex flex-col rounded-2xl border border-border/60 bg-card',
              chatFloating
                ? floatOpen
                  ? 'fixed bottom-4 right-4 z-40 h-[min(80vh,640px)] w-[min(92vw,400px)] origin-bottom-right shadow-2xl animate-in fade-in slide-in-from-bottom-4 zoom-in-95 duration-300 ease-out'
                  : 'hidden'
                : 'order-1 h-[72vh] min-h-[52vh] shadow-none 2xl:order-1 2xl:h-[84vh]',
            )}
          >
            {/* Header bar: chat title + dock/float toggle (+ minimize when floating). */}
            <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
              <span className="text-xs font-semibold text-muted-foreground">Chat</span>
              <div className="flex items-center gap-0.5">
                {chatFloating && (
                  <Tip label="Minimize to a bubble">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setFloatOpen(false)}
                      className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                      aria-label="Minimize chat"
                    >
                      <Minus className="size-4" />
                    </Button>
                  </Tip>
                )}
                <Tip label={chatFloating ? 'Dock chat back to the side' : 'Pop chat out as a floating bubble'}>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setChatFloating((f) => !f)
                      setFloatOpen(true)
                    }}
                    className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                    aria-label="Toggle chat placement"
                  >
                    {chatFloating ? <PanelRight className="size-4" /> : <MessageCircle className="size-4" />}
                  </Button>
                </Tip>
              </div>
            </div>
            {/* What this prototype is built FROM — the ticket (scope + real names) and
                whether the build may read the project's real source. */}
            <GroundingBar
              ticketId={ticketId}
              ticketTitle={ticketTitle}
              ticketFolder={ticketFolder}
              matchApp={matchApp}
              onPickTicket={() => setTicketPickerOpen(true)}
              onToggleMatchApp={() => setPendingMatchApp(!matchApp)}
              disabled={busy}
              designSystem={designSystem}
              onOpenDesignSystem={() => setDesignSystemOpen(true)}
            />
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
              {messages.length === 0 ? (
                <div className="flex min-h-full flex-col items-center justify-center gap-4 py-2 text-center">
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
                    <Sparkles className="size-6" />
                  </span>
                  <div className="space-y-1">
                    <p className="text-sm font-semibold">Describe a screen to prototype</p>
                    <p className="max-w-sm text-xs text-muted-foreground">
                      Plain language is enough. You can refine it with follow-up messages afterwards.
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-center gap-1.5">
                    {EXAMPLES.map((ex) => (
                      <button
                        key={ex}
                        type="button"
                        onClick={() => setInput(ex)}
                        className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                      >
                        {ex}
                      </button>
                    ))}
                  </div>

                  {/* Start settings — design direction for the first build. */}
                  <div className="w-full max-w-sm space-y-3 rounded-2xl border border-border/60 bg-muted/30 p-3 text-left">
                    <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      <Sparkles className="size-3" />
                      Start settings
                    </p>
                    <div className="space-y-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">Design style</span>
                      <div className="grid grid-cols-2 gap-2">
                        {STYLE_OPTIONS.map((o) => {
                          const active = styleSettings.style === o.value
                          return (
                            <button
                              key={o.value}
                              type="button"
                              onClick={() => setStyleSettings((s) => ({ ...s, style: o.value }))}
                              className={cn(
                                'group overflow-hidden rounded-xl border text-left transition-all active:scale-[0.98]',
                                active
                                  ? 'border-primary ring-2 ring-primary/30'
                                  : 'border-border/60 hover:border-border',
                              )}
                            >
                              <div className="h-14 w-full overflow-hidden">
                                <StyleThumb value={o.value} />
                              </div>
                              <div
                                className={cn(
                                  'flex items-center gap-1 px-2 py-1 text-[11px] font-medium',
                                  active ? 'bg-primary/10 text-primary' : 'bg-muted/40 text-muted-foreground',
                                )}
                              >
                                {active && <Check className="size-3 shrink-0" />}
                                <span className="truncate">{o.label}</span>
                              </div>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-1.5">
                        <span className="text-[11px] font-medium text-muted-foreground">Theme</span>
                        <div className="flex items-center gap-1 rounded-full bg-background p-0.5">
                          {(['light', 'dark'] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              onClick={() => setStyleSettings((s) => ({ ...s, theme: t }))}
                              className={cn(
                                'rounded-full px-3 py-1 text-[11px] font-medium capitalize transition-colors',
                                styleSettings.theme === t
                                  ? 'bg-foreground text-background'
                                  : 'text-muted-foreground',
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <span className="text-[11px] font-medium text-muted-foreground">Accent</span>
                        <div className="flex items-center gap-1.5">
                          {ACCENTS.map((a) => (
                            <button
                              key={a.value}
                              type="button"
                              onClick={() => setStyleSettings((s) => ({ ...s, accent: a.value }))}
                              title={a.label}
                              aria-label={a.label}
                              className={cn(
                                'size-5 rounded-full ring-offset-2 ring-offset-background transition-all',
                                a.dot,
                                styleSettings.accent === a.value
                                  ? 'ring-2 ring-foreground'
                                  : 'hover:ring-2 hover:ring-border',
                              )}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((m, i) => <MessageBubble key={i} m={m} />)
              )}
              {busy && (
                <div className="flex justify-start">
                  <div className="inline-flex items-center gap-2 rounded-2xl rounded-bl-md border border-border/60 bg-muted/50 px-3.5 py-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {selected ? 'Updating the prototype…' : 'Building your prototype…'}
                    <span className="rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                      <ElapsedTimer />
                    </span>
                  </div>
                </div>
              )}
            </div>
            <div className="border-t border-border/60 p-3">
              {/* Requirement ambiguities the build had to guess, and what's been settled. */}
              {!busy && selected && (
                <QuestionsPanel
                  questions={current?.questions ?? []}
                  decisions={current?.decisions ?? []}
                  answers={answers}
                  onAnswerChange={(q, a) => setAnswers((cur) => ({ ...cur, [q]: a }))}
                  onSend={sendAnswers}
                  onDismiss={(q) => dismissQuestionMut.mutate(q)}
                  disabled={busy || dismissQuestionMut.isPending}
                />
              )}
              {/* Follow-up suggestions — tick any (multi-select), then send them together. */}
              {!busy && (current?.suggestions?.length ?? 0) > 0 && (
                <div className="mb-2.5">
                  <div className="mb-1.5 flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                      <Sparkles className="size-3" />
                      Make it better {selectedSuggestions.length > 0 && `· ${selectedSuggestions.length} selected`}
                    </p>
                    {selectedSuggestions.length > 0 && (
                      <Button
                        size="sm"
                        onClick={applySuggestions}
                        className="h-6 gap-1 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
                      >
                        <ArrowUp className="size-3" />
                        Send {selectedSuggestions.length}
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {current!.suggestions!.map((s, i) => {
                      const active = selectedSuggestions.includes(s)
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => toggleSuggestion(s)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors active:scale-[0.98]',
                            active
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground',
                          )}
                        >
                          {active ? <Check className="size-3" /> : <Plus className="size-3" />}
                          {s}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void addImageFiles(e.target.files)
                  e.target.value = '' // allow re-picking the same file
                }}
              />
              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  if (!busy) setDragOver(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(false)
                  if (!busy && e.dataTransfer.files.length) void addImageFiles(e.dataTransfer.files)
                }}
                className={cn(
                  'rounded-2xl border bg-background p-2 transition-colors focus-within:border-border',
                  dragOver ? 'border-primary border-dashed bg-primary/5' : 'border-border/60',
                )}
              >
                {/* Attached image thumbnails */}
                {attachedImages.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {attachedImages.map((img) => (
                      <div
                        key={img.id}
                        className="group relative size-14 overflow-hidden rounded-lg border border-border/60"
                        title={img.name}
                      >
                        <img src={img.dataUrl} alt={img.name} className="size-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeImage(img.id)}
                          className="absolute right-0.5 top-0.5 flex size-4 items-center justify-center rounded-full bg-foreground/80 text-background opacity-0 transition-opacity group-hover:opacity-100"
                          aria-label={`Remove ${img.name}`}
                        >
                          <X className="size-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div data-tour="prompt" className="flex items-end gap-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={busy || attachedImages.length >= MAX_IMAGES}
                    className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                    title="Attach image (or drag & drop / paste)"
                    aria-label="Attach image"
                  >
                    <ImagePlus className="size-4" />
                  </Button>
                  <Textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        submit()
                      }
                    }}
                    onPaste={(e) => {
                      const files = Array.from(e.clipboardData?.items ?? [])
                        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
                        .map((it) => it.getAsFile())
                        .filter((f): f is File => !!f)
                      if (files.length) {
                        e.preventDefault()
                        void addImageFiles(files)
                      }
                    }}
                    disabled={busy}
                    placeholder={
                      busy
                        ? 'Building… press Stop to cancel'
                        : selected
                          ? 'Describe a change, or drop an image…'
                          : 'Describe the screen, or drop an image to build from…'
                    }
                    className="max-h-40 min-h-[44px] flex-1 resize-none border-0 bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0 disabled:opacity-60"
                    spellCheck={false}
                  />
                  {busy ? (
                    <Button
                      onClick={stop}
                      variant="destructive"
                      size="icon"
                      className="size-9 shrink-0 rounded-full active:scale-[0.98]"
                      aria-label="Stop"
                      title="Stop the build"
                    >
                      <Square className="size-3.5 fill-current" />
                    </Button>
                  ) : (
                    <Button
                      onClick={() => submit()}
                      disabled={!input.trim() && attachedImages.length === 0}
                      size="icon"
                      className="size-9 shrink-0 rounded-full active:scale-[0.98]"
                      aria-label="Send"
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
                Enter to send · Shift+Enter for a new line · drag, paste or attach an image
              </p>
            </div>
          </div>

          {/* Preview renders the finished HTML once; Code streams live while building.
              order-2 on a narrow screen puts it BELOW the chat with full width. */}
          <PreviewPane
            html={shownHtml}
            code={busy ? streamText : (shownHtml ?? '')}
            view={view}
            onView={setView}
            pending={busy}
            className="order-2 2xl:order-2"
            versions={versions}
            viewVersion={viewVersion}
            onViewVersion={setViewVersion}
            onRestore={(n) => restoreMut.mutate(n)}
            restoring={restoreMut.isPending}
            onCompare={() => setCompareOpen(true)}
            loadingVersion={versionQ.isLoading}
            commentMode={commentMode}
            onCommentMode={setCommentMode}
            comments={comments}
            onPick={setPendingPick}
            onRemoveComment={(id) => setComments((cur) => cur.filter((c) => c.id !== id))}
            onApplyComments={applyComments}
            onDownload={download}
          />
        </div>
      </div>

      {(busy || logs.length > 0) && (
        <LogPanel logs={logs} open={logsOpen} onToggle={() => setLogsOpen((o) => !o)} busy={busy} />
      )}

      {/* Floating chat bubble — shown when chat is in floating mode and collapsed. */}
      {chatFloating && !floatOpen && (
        <button
          type="button"
          onClick={() => setFloatOpen(true)}
          className="fixed bottom-5 right-5 z-40 flex size-14 items-center justify-center rounded-full bg-foreground text-background shadow-xl transition-transform duration-200 animate-in fade-in zoom-in-50 hover:scale-105 active:scale-95"
          aria-label="Open chat"
          title="Open chat"
        >
          <MessageCircle className="size-6" />
          {busy && (
            <span className="absolute -right-0.5 -top-0.5 flex size-3.5 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-primary/60" />
              <span className="relative size-2.5 rounded-full bg-primary" />
            </span>
          )}
        </button>
      )}

      {/* Keyed by target so each pick starts with an empty comment box. */}
      <CommentDialog
        key={pendingPick ? `${pendingPick.path}|${comments.length}` : 'none'}
        target={pendingPick}
        onCancel={() => setPendingPick(null)}
        onSave={(text) => {
          if (pendingPick) {
            setComments((cur) => [
              ...cur,
              { id: `${Date.now()}-${cur.length}`, label: pendingPick.label, path: pendingPick.path, text },
            ])
          }
          setPendingPick(null)
        }}
      />

      <DesignSystemDialog
        open={designSystemOpen}
        onOpenChange={setDesignSystemOpen}
        projectId={projectId}
        model={model}
      />

      <TicketLinkDialog
        open={ticketPickerOpen}
        onOpenChange={setTicketPickerOpen}
        projectId={projectId}
        value={ticketFolder}
        onPick={(t) => setPendingTicket(t)}
      />

      {selected && versions.length > 1 && (
        <CompareDialog
          open={compareOpen}
          onOpenChange={setCompareOpen}
          projectId={projectId}
          slug={selected}
          versions={versions}
        />
      )}

      {selected && (
        <TestcasesDialog
          open={testcasesOpen}
          onOpenChange={setTestcasesOpen}
          projectId={projectId}
          slug={selected}
          ticketId={ticketId}
          ticketFolder={ticketFolder}
          model={model}
        />
      )}

      <Dialog
        open={!!settingsFor}
        onOpenChange={(v) => {
          if (!v && !renameMut.isPending && !duplicateMut.isPending) setSettingsFor(null)
        }}
      >
        <DialogContent className="rounded-3xl sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="size-4" />
              Prototype settings
            </DialogTitle>
            <DialogDescription>Rename, duplicate, or delete this prototype.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Textarea
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  // ⌘/Ctrl+Enter saves; plain Enter inserts a newline.
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && settingsFor) commitRename(settingsFor)
                }}
                placeholder="Prototype name"
                rows={2}
                className="min-h-[64px] w-full resize-y rounded-lg"
              />
              <div className="flex justify-end">
                <Button
                  onClick={() => settingsFor && commitRename(settingsFor)}
                  disabled={renameMut.isPending || !renameValue.trim()}
                  className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
                >
                  {renameMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  Save name
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-border/60 pt-4">
              <Button
                variant="outline"
                onClick={() => settingsFor && duplicateMut.mutate(settingsFor)}
                disabled={duplicateMut.isPending}
                className="flex-1 gap-1.5 rounded-full active:scale-[0.98]"
              >
                {duplicateMut.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Copy className="size-4" />
                )}
                Duplicate
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  const slug = settingsFor
                  setSettingsFor(null)
                  setDeleting(slug)
                }}
                className="flex-1 gap-1.5 rounded-full text-destructive hover:text-destructive active:scale-[0.98]"
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v && !delMut.isPending) setDeleting(null)
        }}
      >
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-4 text-destructive" />
              Delete prototype
            </DialogTitle>
            <DialogDescription>
              Delete{' '}
              <span className="font-medium text-foreground">
                {(list ?? []).find((p) => p.slug === deleting)?.name ?? deleting}
              </span>
              ? This removes its conversation and HTML from disk. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleting(null)}
              disabled={delMut.isPending}
              className="rounded-full"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && delMut.mutate(deleting)}
              disabled={delMut.isPending}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {delMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
