import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowUp,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Copy,
  ExternalLink,
  ImagePlus,
  Laptop,
  Layout,
  Loader2,
  MessageCircle,
  Minus,
  Monitor,
  PanelRight,
  Plus,
  RefreshCw,
  RotateCw,
  Settings2,
  Smartphone,
  Sparkles,
  Square,
  Tablet,
  TerminalSquare,
  Trash2,
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
import { useProjects } from '@/lib/project-context'
import { cn } from '@/lib/utils'
import {
  deletePrototype,
  duplicatePrototype,
  getPrototype,
  listPrototypes,
  openPrototypesFolder,
  renamePrototype,
  streamPrototype,
  type PrototypeMessage,
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
}: {
  device: Device
  orientation: Orientation
  html: string
  nonce: number
}) {
  const spec = DEVICES.find((d) => d.id === device)
  const iframe = (
    <iframe
      // Remount on rotate too so the page relayouts at the new viewport size.
      key={`${nonce}-${device}-${orientation}`}
      title="Prototype preview"
      // Sandbox WITHOUT allow-same-origin: scripts (Tailwind CDN, small inline JS) run,
      // but the page is a null origin and can't touch the portal.
      sandbox="allow-scripts allow-forms allow-popups"
      srcDoc={html}
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
}: {
  html: string | undefined
  code: string
  view: 'preview' | 'code'
  onView: (v: 'preview' | 'code') => void
  pending: boolean
  className?: string
}) {
  const [device, setDevice] = useState<Device>('desktop')
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  // Bump this to force the iframe to remount (a manual refresh).
  const [nonce, setNonce] = useState(0)
  const framed = DEVICES.find((d) => d.id === device)?.frame != null
  const [capturing, setCapturing] = useState(false)
  const [copied, setCopied] = useState(false)
  const codeRef = useRef<HTMLPreElement>(null)

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

  return (
    <div className={cn('flex min-h-0 flex-col rounded-2xl border border-border/60 bg-card shadow-none', className)}>
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
            <DeviceStage device={device} orientation={orientation} html={html} nonce={nonce} />
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

// ---------------------------------------------------------------- page

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

  // Keep the chat scrolled to the newest message.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.messages.length, selected])

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

  const submit = (override?: string) => {
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
      // Style settings only shape the FIRST build (no existing prototype).
      { slug: targetSlug, prompt, model, images: imgs, style: targetSlug ? undefined : styleSettings },
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
      if (selected === slug) setSelected(null)
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
      setSelected(p.slug)
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

  const newPrototype = () => {
    setSelected(null)
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
        <div className="flex items-start gap-3">
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
        <div className="flex shrink-0 items-center gap-2">
          {modelPicker}
          <OpenFolderButton open={() => openPrototypesFolder(projectId)} label="Prototypes" />
        </div>
      </header>

      <div className={cn('grid grid-cols-1 gap-6', !chatFloating && 'lg:grid-cols-[240px_1fr]')}>
        {/* Saved prototypes. Docked: a left column (drops below the workspace on small
            screens). Ball mode: floats just to the LEFT of the chat box (lg+ only,
            where there's room); hidden while the chat is minimized to a bubble. */}
        <aside
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
                onClick={() => setSelected(item.slug)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelected(item.slug)
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
                  </span>
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
                <div className="flex items-end gap-2">
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
            html={current?.html}
            code={busy ? streamText : (current?.html ?? '')}
            view={view}
            onView={setView}
            pending={busy}
            className="order-2 2xl:order-2"
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
