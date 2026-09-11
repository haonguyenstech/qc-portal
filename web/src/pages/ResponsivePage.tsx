import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  Copy,
  Download,
  Expand,
  ExternalLink,
  Link2,
  Link2Off,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  Shield,
  Smartphone,
  Sliders,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProjects } from '@/lib/project-context'
import {
  cancelResponsiveJob,
  deleteResponsiveJob,
  getResponsiveAvailability,
  getResponsiveJob,
  listResponsiveJobs,
  probeResponsiveUrl,
  responsiveShotUrl,
  startResponsiveCapture,
} from '@/lib/api'
import {
  BEZEL_FILL,
  BEZEL_COLORS,
  DEVICE_GROUPS,
  DEVICE_PRESETS,
  matchesDevice,
  MAX_CAPTURE_DEVICES,
  MAX_LIVE_DEVICES,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  chromeFor,
  clampZoom,
  customPreset,
  frameSrc,
  isSameOrigin,
  normalizeUrl,
  presetById,
  readPrefs,
  viewportOf,
  writePrefs,
  type BezelColor,
  type DeviceChrome,
  type DevicePreset,
  type Orientation,
  type ResponsivePrefs,
} from '@/lib/responsiveDevices'
import {
  KIND_EXPLAINER,
  SEVERITY_CLASS,
  SEVERITY_LABEL,
  commonKinds,
  responsiveMarkdown,
  sortedFindings,
  verdictOf,
} from '@/lib/responsiveFindings'
import type { ResponsiveDeviceCapture, ResponsiveUrlProbe } from '@/lib/types'

/**
 * RESPONSIVE — `/responsive`. Type a URL, see it on many devices at once.
 *
 * Two tabs, and the split is the whole design:
 *
 *   • **Live** is the Chrome-extension experience — the URL in up to five real
 *     device viewports side by side, rotatable, zoomable, with the phone chrome
 *     drawn around it. It is for LOOKING: instant, interactive, no server work.
 *   • **Capture** drives a real emulated device server-side (mobile user agent,
 *     device pixel ratio, touch) and comes back with a screenshot per device plus
 *     a list of what is measurably wrong. It is for EVIDENCE.
 *
 * They are not two views of one thing, and the page never pretends otherwise:
 * an iframe cannot fake a user agent, a device pixel ratio or touch support, so a
 * site that serves a different layout to phones shows its DESKTOP layout in the
 * live tab. Nor can a cross-origin frame be screenshotted from the page — the
 * camera button therefore hands the current devices to the Capture tab instead of
 * photographing an empty rectangle. See `server/src/responsiveCapture.ts` for the
 * full list of what only the server side can answer.
 *
 * The third thing the live tab cannot do by itself is know WHY a frame is blank:
 * a page that refuses to be framed gives the embedder no event at all. So the URL
 * is probed server-side and the answer is shown up front, with the framing proxy
 * (`/api/responsive/frame`) offered as a labelled fallback.
 */

// ------------------------------------------------------------------ device chrome
//
// Drawn AROUND the screen rectangle, never inside it: the numbers in the catalog
// are viewport sizes, so an iframe shrunk to make room for a fake status bar would
// be lying about the one thing this page exists to show. The bezel grows instead.

/** The status bar — time, signal, battery. Cosmetic; makes a screenshot read as a phone. */
function StatusBar({ platform, dark }: { platform: 'ios' | 'android'; dark: boolean }) {
  const time = useMemo(
    () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    [],
  )
  return (
    <div
      className={cn(
        'flex h-6 shrink-0 items-center justify-between px-4 text-[10px] font-medium tabular-nums',
        dark ? 'bg-black text-white' : 'bg-white text-black',
      )}
    >
      <span>{time}</span>
      {platform === 'ios' ? (
        <span className="flex items-center gap-1">
          <SignalBars />
          <BatteryPill />
        </span>
      ) : (
        <span className="flex items-center gap-1">
          <SignalBars />
          <span>85%</span>
          <BatteryPill />
        </span>
      )}
    </div>
  )
}

function SignalBars() {
  return (
    <svg width="14" height="9" viewBox="0 0 14 9" aria-hidden className="opacity-90">
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 3.6} y={8 - (i + 1) * 2} width="2.4" height={(i + 1) * 2} rx="0.6" fill="currentColor" />
      ))}
    </svg>
  )
}

function BatteryPill() {
  return (
    <svg width="18" height="9" viewBox="0 0 18 9" aria-hidden className="opacity-90">
      <rect x="0.5" y="0.5" width="14" height="8" rx="2" fill="none" stroke="currentColor" />
      <rect x="2" y="2" width="9" height="5" rx="1" fill="currentColor" />
      <rect x="15.5" y="3" width="2" height="3" rx="1" fill="currentColor" />
    </svg>
  )
}

/**
 * The browser bar. Its point is not decoration: a phone's address bar is 40-56px
 * of the screen a QC engineer keeps forgetting about, and drawing it is the
 * cheapest way to make "the sticky footer sits under the Safari bar" visible
 * before a user reports it.
 */
function BrowserBar({ url, chrome }: { url: string; chrome: DeviceChrome }) {
  const host = useMemo(() => {
    try {
      const u = new URL(url)
      return `${u.host}${u.pathname === '/' ? '' : u.pathname}`
    } catch {
      return url || 'about:blank'
    }
  }, [url])

  if (chrome === 'android') {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 bg-white px-3 text-[11px] text-black">
        <span className="text-[13px]">⌂</span>
        <span className="flex min-w-0 flex-1 items-center gap-1 rounded-full bg-zinc-100 px-2.5 py-1">
          <span className="text-[9px]">🔒</span>
          <span className="truncate">{host}</span>
        </span>
        <span className="flex size-4 items-center justify-center rounded border border-zinc-400 text-[9px]">1</span>
        <span className="text-[13px] leading-none">⋮</span>
      </div>
    )
  }
  // iOS puts its bar at the bottom on a modern iPhone, and at the top on the old
  // (home-button) chrome — which is exactly the difference that moves a fixed
  // footer, so the two are drawn differently rather than the same bar twice.
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-zinc-200 bg-zinc-100/95 px-3 text-[11px] text-black">
      <span className="text-zinc-500">‹</span>
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-xl bg-white px-2.5 py-1 shadow-sm">
        <span className="text-[9px] text-zinc-500">aA</span>
        <span className="truncate">{host}</span>
      </span>
      <span className="text-zinc-500">⟳</span>
    </div>
  )
}

/** Android's on-screen navigation. Below the viewport, like the real thing. */
function AndroidNav() {
  return (
    <div className="flex h-8 shrink-0 items-center justify-around bg-black px-8 text-white/70">
      <span className="size-3 rounded-sm border border-current" />
      <span className="h-3 w-8 rounded-full border border-current" />
      <span className="text-[11px]">↩</span>
    </div>
  )
}

/**
 * One device in the live tab: bezel, chrome, and the page in an iframe at the
 * exact device viewport, scaled by `zoom` with a transform.
 *
 * The transform is why the zoom control is honest. Setting the iframe to 80% of
 * the device width would change the viewport the page sees, so its breakpoints
 * would fire at the wrong size — the frame would be a smaller *browser*, not a
 * smaller *picture of a phone*. Scaling the rendered result keeps the viewport at
 * 390px and shrinks the pixels, which is what a QC engineer means by "zoom out so
 * I can see four of them".
 */
function LiveDevice({
  device,
  orientation,
  url,
  proxy,
  chrome,
  bezel,
  zoom,
  nonce,
  frameRef,
  onFocus,
  onRemove,
}: {
  device: DevicePreset
  orientation: Orientation
  url: string
  proxy: boolean
  chrome: DeviceChrome
  bezel: BezelColor
  zoom: number
  nonce: number
  frameRef?: (el: HTMLIFrameElement | null) => void
  onFocus?: () => void
  onRemove?: () => void
}) {
  const { width, height } = viewportOf(device, orientation)
  const framed = chrome !== 'none'
  const iosOld = chrome === 'ios-old'
  const android = chrome === 'android'

  const screen = (
    <div className="flex flex-col overflow-hidden bg-white" style={{ width }}>
      {framed && <StatusBar platform={android ? 'android' : 'ios'} dark={android} />}
      {framed && (android || iosOld) && <BrowserBar url={url} chrome={chrome} />}
      <iframe
        // Remount on rotate, on a URL change, on a manual reload (nonce) and when
        // the proxy is toggled: a rotated iframe that is only resized keeps the
        // layout it computed at the old width in some engines, which reads as "the
        // app doesn't reflow" — a bug the page would be inventing.
        key={`${nonce}-${device.id}-${orientation}-${proxy ? 'proxy' : 'direct'}`}
        ref={frameRef}
        title={`${device.label} preview`}
        src={frameSrc(url, proxy)}
        // No sandbox in DIRECT mode: the frame is another origin already, so the
        // browser isolates it, and a sandbox would only break the app's own
        // storage and popups. In PROXY mode the document is served from the
        // portal's origin, so it is sandboxed WITH allow-same-origin — that keeps
        // scroll-sync working (the parent needs to read its scroll position) while
        // still blocking top-level navigation away from the portal.
        sandbox={proxy ? 'allow-scripts allow-forms allow-popups allow-same-origin' : undefined}
        style={{ width, height, border: 0 }}
        className="block bg-white"
      />
      {framed && !android && !iosOld && <BrowserBar url={url} chrome={chrome} />}
      {framed && android && <AndroidNav />}
      {framed && iosOld && (
        <div className="flex h-9 shrink-0 items-center justify-center bg-black">
          <span className="size-5 rounded-full border border-white/40" />
        </div>
      )}
    </div>
  )

  // A `transform: scale` changes what is PAINTED and not what is laid out: the
  // scaled element still occupies its full unscaled box. Left alone at 60% zoom
  // that reserved ~1.5 screens of empty space under each phone and stranded the
  // caption far below its own frame (measured on screen, with four devices). So
  // the frame is measured — `offsetWidth/Height`, which is the pre-transform
  // layout size — and the wrapper reserves exactly that times the zoom.
  const inner = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = inner.current
    if (!el) return
    const measure = () => setBox({ w: el.offsetWidth, h: el.offsetHeight })
    measure()
    // The frame's height changes without a re-render here: the chrome loads its
    // fonts, and rotating swaps the screen box.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [width, height, chrome])

  return (
    <div className="flex shrink-0 flex-col items-center gap-2">
      <div
        style={{
          width: (box.w || (framed ? width + 20 : width)) * zoom,
          height: box.h ? box.h * zoom : undefined,
        }}
      >
        <div
          ref={inner}
          style={{ transform: `scale(${zoom})`, transformOrigin: 'top left', width: framed ? width + 20 : width }}
          className="relative"
        >
          {framed ? (
            <div
              className={cn(
                'relative rounded-[2.25rem] p-2.5 shadow-xl ring-1 ring-black/10',
                bezel === 'silver' ? 'text-black/60' : 'text-white/60',
              )}
              style={{ background: BEZEL_FILL[bezel] }}
            >
              <div className="overflow-hidden rounded-[1.75rem]">{screen}</div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-white shadow-sm">
              {screen}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-xs">
        <span className="font-medium">{device.label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {width}×{height}
        </span>
        {onFocus && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 rounded-full"
                onClick={onFocus}
                aria-label={`Focus ${device.label}`}
              >
                <Maximize2 className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Focus this device</TooltipContent>
          </Tooltip>
        )}
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-full text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            aria-label={`Remove ${device.label}`}
          >
            <X className="size-3" />
          </Button>
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ device picker

/**
 * The grouped device grid, straight out of the extension: iPhone, Android,
 * Foldable, Tablets, Desktop, each card showing the label and the viewport size.
 *
 * Multi-select with a cap, and the cap differs by tab (eight live frames, 24 in a
 * capture) — every live frame runs the target's own JavaScript, while a capture is
 * a sequential server-side sweep whose only cost is time.
 *
 * The search box is not decoration at 50+ devices: it matches the SIZE as well as
 * the name, so "412" answers "which phones are 412 wide?" — the question a bug
 * report that quotes a pixel width actually asks. Groups with no match disappear
 * rather than leaving empty headings behind.
 */
function DevicePicker({
  selected,
  max,
  onToggle,
  onClear,
  customEnabled,
  onToggleCustom,
}: {
  selected: string[]
  max: number
  onToggle: (id: string) => void
  onClear: () => void
  customEnabled: boolean
  onToggleCustom: () => void
}) {
  const [query, setQuery] = useState('')
  const full = selected.length >= max
  const matches = useMemo(
    () => DEVICE_PRESETS.filter((d) => matchesDevice(d, query)),
    [query],
  )
  return (
    <PopoverContent align="start" className="w-[24rem] rounded-2xl p-0">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <span className="text-xs font-semibold tracking-tight">
          {selected.length} of {max} selected
        </span>
        {selected.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-full px-2 text-[11px]"
            onClick={onClear}
          >
            Clear
          </Button>
        ) : null}
      </div>
      <div className="border-b border-border/60 p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a device or a size — iPhone, 412, 1280x800"
            className="h-8 rounded-full pl-8 text-xs"
          />
        </div>
        {full && (
          <p className="mt-1.5 px-1 text-[11px] text-muted-foreground">
            That is the maximum — deselect one to add another.
          </p>
        )}
      </div>
      <div className="max-h-[26rem] overflow-y-auto p-3">
        {DEVICE_GROUPS.map((group) => {
          const items = matches.filter((d) => d.group === group)
          if (!items.length) return null
          return (
            <div key={group} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group}
                <span className="ml-1 font-normal opacity-70">({items.length})</span>
              </p>
              <div className="grid grid-cols-3 gap-1.5">
                {items.map((d) => {
                  const on = selected.includes(d.id)
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => onToggle(d.id)}
                      disabled={!on && full}
                      className={cn(
                        'rounded-xl border p-2 text-left transition-all duration-200 active:scale-[0.98]',
                        on
                          ? 'border-primary bg-primary/10'
                          : 'border-border/60 hover:border-border hover:bg-muted/60',
                        !on && full && 'cursor-not-allowed opacity-40',
                      )}
                    >
                      <span className="flex items-start justify-between gap-1">
                        <span className="text-[11px] font-medium leading-tight">{d.label}</span>
                        {on && <Check className="mt-0.5 size-3 shrink-0 text-primary" />}
                      </span>
                      <span className="mt-1 block font-mono text-[10px] text-muted-foreground">
                        {d.width}×{d.height}
                        <span className="ml-1 opacity-70">@{d.dpr}x</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        {!matches.length && (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            No device matches “{query}”. Use{' '}
            <span className="font-medium text-foreground">Custom size</span> below for an exact
            viewport.
          </p>
        )}
        <button
          type="button"
          onClick={onToggleCustom}
          className={cn(
            'flex w-full items-center gap-2 rounded-xl border p-2 text-left text-[11px] font-medium transition-all duration-200',
            customEnabled
              ? 'border-primary bg-primary/10'
              : 'border-border/60 hover:border-border hover:bg-muted/60',
          )}
        >
          <Ruler className="size-3.5" />
          Custom size
          {customEnabled && <Check className="ml-auto size-3 text-primary" />}
        </button>
      </div>
    </PopoverContent>
  )
}

/** The custom-size panel — a free viewport, the chrome style, and the bezel colour. */
function CustomSizePanel({
  prefs,
  setPrefs,
}: {
  prefs: ResponsivePrefs
  setPrefs: (patch: (current: ResponsivePrefs) => ResponsivePrefs) => void
}) {
  const c = prefs.custom
  // Functional, like every other write here: dragging the width slider fires many
  // changes before React re-renders the panel.
  const set = (patch: Partial<typeof c>) =>
    setPrefs((p) => ({ ...p, custom: { ...p.custom, ...patch } }))
  const chromes: { key: DeviceChrome; label: string }[] = [
    { key: 'none', label: 'No OS' },
    { key: 'ios', label: 'iOS' },
    { key: 'ios-old', label: 'Old iOS' },
    { key: 'android', label: 'Android' },
  ]
  return (
    <PopoverContent align="end" className="w-72 space-y-3 rounded-2xl">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold tracking-tight">Custom size</span>
        <Checkbox
          checked={c.enabled}
          onCheckedChange={(v) => set({ enabled: Boolean(v) })}
          aria-label="Use the custom size"
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        {chromes.map((ch) => (
          <Button
            key={ch.key}
            size="sm"
            variant={c.chrome === ch.key ? 'default' : 'outline'}
            className="rounded-full text-xs"
            onClick={() => set({ chrome: ch.key })}
          >
            {ch.label}
          </Button>
        ))}
      </div>
      {(
        [
          { key: 'width' as const, label: 'Width', min: 240, max: 2560, unit: 'px' },
          { key: 'height' as const, label: 'Height', min: 320, max: 2000, unit: 'px' },
          { key: 'diagonalIn' as const, label: 'Diagonal', min: 3, max: 15, unit: '”', step: 0.1 },
        ]
      ).map((row) => (
        <div key={row.key} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <Label className="text-xs text-muted-foreground">{row.label}</Label>
            <span className="font-mono tabular-nums">
              {c[row.key]}
              {row.unit}
            </span>
          </div>
          <input
            type="range"
            min={row.min}
            max={row.max}
            step={row.step ?? 1}
            value={c[row.key]}
            onChange={(e) => set({ [row.key]: Number(e.target.value) } as Partial<typeof c>)}
            className="w-full accent-primary"
          />
        </div>
      ))}
      <p className="text-[11px] leading-snug text-muted-foreground">
        Diagonal only scales the drawn bezel — the page is still laid out at{' '}
        <span className="font-mono">
          {c.width}×{c.height}
        </span>
        .
      </p>
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">Color</Label>
        {BEZEL_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={color}
            onClick={() => set({ color })}
            className={cn(
              'size-5 rounded-full border transition-all duration-200',
              c.color === color ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : 'border-border/60',
            )}
            style={{ background: BEZEL_FILL[color] }}
          />
        ))}
      </div>
    </PopoverContent>
  )
}

// ------------------------------------------------------------------ mirroring

/**
 * MIRRORED ACTIONS — do it once on one device, watch it happen on all of them.
 *
 * This is the extension's "scrolling, clicks and typing synchronise between the
 * views", and it is the one feature whose feasibility is decided by the same-origin
 * policy rather than by effort:
 *
 *   • a CROSS-ORIGIN frame cannot be read or driven at all — not its scroll
 *     position, not its DOM, not a synthetic click. The extension can do this
 *     because it runs INSIDE the page; a web app cannot, and no amount of code
 *     here changes that.
 *   • a SAME-ORIGIN frame can be driven completely. Two ways to get one: turn on
 *     "Via portal" (the proxy serves the document from the portal's own origin),
 *     or point the page at the portal's own origin to begin with.
 *
 * So this hook is CAPABILITY-DETECTED, not flag-gated: it drives whatever frames
 * it can actually reach and reports how many those were, and the toolbar says
 * "2 of 3 frames can be driven" rather than failing quietly. That matters because
 * a page can also become unreachable mid-session — a proxied frame that navigates
 * leaves the proxy and is cross-origin from that click onwards.
 *
 * What is mirrored, and why each one:
 *   • scroll (page and inner scrollers) — PROPORTIONALLY. A 640px phone and a
 *     1080px desktop have different scroll ranges, so mirroring raw pixels puts
 *     one at the bottom while the other is halfway down.
 *   • click — the whole point: open the same menu, hit the same tab, on every size
 *     at once.
 *   • typing (`input`/`change`) — a form filled once. Written through the NATIVE
 *     value setter, or React never sees the change (it tracks the last value it
 *     wrote and ignores an assignment it did not make).
 *   • Enter / Escape / Tab — the keys that submit, dismiss and move on. Ordinary
 *     character keys are not replayed: `input` already carries the text, and
 *     replaying both types everything twice.
 */
interface MirrorReach {
  /** Frames on screen. */
  total: number
  /** Frames whose document this page is allowed to touch. */
  reachable: number
}

/**
 * A path to an element that can be looked up in the OTHER frames' documents.
 *
 * An id when there is one (ids survive a re-render at another width), otherwise an
 * `nth-of-type` chain. The chain is the fallback and not the primary because the
 * documents are NOT identical: the same page at 390px and at 1280px renders
 * different trees — a nav that becomes a hamburger, a table that becomes cards —
 * which is exactly the situation this page exists to look at.
 */
function pathOf(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const parts: string[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && node !== node.ownerDocument.documentElement) {
    const parent: Element | null = node.parentElement
    if (!parent) break
    if (node.id) {
      parts.unshift(`#${CSS.escape(node.id)}`)
      break
    }
    const tag = node.tagName.toLowerCase()
    const index =
      Array.from(parent.children).filter((c) => c.tagName === node!.tagName).indexOf(node) + 1
    parts.unshift(`${tag}:nth-of-type(${index})`)
    node = parent
  }
  return parts.join('>')
}

/** How an element would be recognised by a person — the fallback match. */
function labelOf(el: Element): string {
  const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
  return (
    text.replace(/\s+/g, ' ').trim().slice(0, 60) ||
    el.getAttribute('aria-label')?.trim() ||
    el.getAttribute('placeholder')?.trim() ||
    el.getAttribute('name')?.trim() ||
    ''
  )
}

/**
 * The same element in another document: the path first, then — because the two
 * documents may legitimately differ — the first same-tag element that reads the
 * same to a person. Nothing is invented: with no path hit and no label match it
 * returns null and that frame simply does not receive the action.
 */
function twinOf(doc: Document, path: string, tag: string, label: string): Element | null {
  if (path) {
    try {
      const direct = doc.querySelector(path)
      if (direct) return direct
    } catch {
      /* a path that isn't a valid selector in this document */
    }
  }
  if (!label) return null
  const candidates = Array.from(doc.getElementsByTagName(tag))
  return candidates.find((c) => labelOf(c) === label) ?? null
}

/** The frames this page is actually allowed to drive, paired with their window. */
function reachableFrames(
  frames: Map<string, HTMLIFrameElement>,
): { id: string; win: Window; doc: Document }[] {
  const out: { id: string; win: Window; doc: Document }[] = []
  for (const [id, frame] of frames) {
    try {
      const win = frame.contentWindow
      const doc = win?.document
      // Reading `document.body` is the actual permission check: a cross-origin
      // frame throws here rather than returning null, and a frame that is still
      // loading has a document with no body yet.
      if (win && doc && doc.body) out.push({ id, win, doc })
    } catch {
      /* not ours to drive */
    }
  }
  return out
}

function useMirror(
  enabled: boolean,
  frames: React.RefObject<Map<string, HTMLIFrameElement>>,
  /** Bumped whenever the frames remount (URL, device set, rotate, proxy). */
  nonce: number,
): MirrorReach {
  const [reach, setReach] = useState<MirrorReach>({ total: 0, reachable: 0 })

  useEffect(() => {
    const map = frames.current ?? new Map()
    // The reach readout is wanted even with mirroring OFF: it is how the toolbar
    // can explain, before anything is clicked, that these frames cannot be driven.
    // Only written when it CHANGES — this runs on a timer, and a fresh object
    // every second would re-render the whole device row for no reason.
    const survey = () =>
      setReach((prev) => {
        const next = { total: map.size, reachable: reachableFrames(map).length }
        return prev.total === next.total && prev.reachable === next.reachable ? prev : next
      })

    const cleanups: (() => void)[] = []
    /**
     * Documents already wired up. A frame's document is the identity that matters,
     * not the frame: an iframe keeps its element across a navigation but gets a
     * NEW document, which needs binding again — and re-binding one that is already
     * bound would replay every action twice.
     */
    const bound = new WeakSet<Document>()
    /**
     * True while an action is being replayed. Every replayed click fires the peer
     * frame's own listener, which would replay it back — one click would ping-pong
     * until the stack gave out.
     *
     * It is released SYNCHRONOUSLY, in a `finally`, because a replayed click,
     * keystroke and value write all dispatch synchronously: the nested listener
     * runs while the flag is still up, and by the time the loop returns there is
     * nothing left to guard against.
     *
     * The first version released it in `requestAnimationFrame` instead, and that
     * was a latch: rAF does not run while the tab is HIDDEN, so the flag stayed
     * true forever and every action after the first was silently swallowed.
     * Reproduced with `document.hidden === true` — a background tab, or any
     * headless check of this page.
     */
    let replaying = false
    /**
     * Per-frame "ignore your next scroll event": `scrollTo` on a peer makes that
     * peer fire its own scroll ASYNCHRONOUSLY, after the synchronous guard above
     * is already down, and it would then drive everyone back. Scroll is the one
     * action that needs a short time window rather than a flag.
     */
    const scrollEcho = new Map<string, number>()
    const ECHO_MS = 250

    const attach = () => {
      survey()
      if (!enabled) return
      const live = reachableFrames(map)
      if (live.length < 2) return

      for (const source of live) {
        if (bound.has(source.doc)) continue
        bound.add(source.doc)
        // Each frame has its OWN constructors, so `instanceof` must be checked
        // against that frame's globals — `el instanceof HTMLElement` using the
        // portal's own realm is false for every element inside an iframe.
        const sw = source.win as Window & typeof globalThis
        /** Run `fn` against every frame except the one the action came from. */
        const peers = (fn: (peer: { id: string; win: Window; doc: Document }) => void) => {
          if (replaying) return
          replaying = true
          try {
            for (const peer of reachableFrames(map)) {
              if (peer.id === source.id) continue
              try {
                fn(peer)
              } catch {
                /* one frame refusing must not stop the others */
              }
            }
          } finally {
            replaying = false
          }
        }

        const onScroll = (e: Event) => {
          // This frame was just scrolled BY the mirror; its own event is the echo.
          if (Date.now() < (scrollEcho.get(source.id) ?? 0)) return
          const target = e.target
          if (target === source.doc || target === source.win) {
            const el = source.doc.documentElement
            const range = Math.max(1, el.scrollHeight - source.win.innerHeight)
            const ratio = source.win.scrollY / range
            peers((peer) => {
              const pRange = Math.max(
                0,
                peer.doc.documentElement.scrollHeight - peer.win.innerHeight,
              )
              scrollEcho.set(peer.id, Date.now() + ECHO_MS)
              peer.win.scrollTo({ top: ratio * pRange })
            })
            return
          }
          // An inner scroller — a modal body, a scrollable table.
          if (!(target instanceof sw.HTMLElement)) return
          const path = pathOf(target)
          const tag = target.tagName.toLowerCase()
          const label = labelOf(target)
          const yRatio =
            target.scrollTop / Math.max(1, target.scrollHeight - target.clientHeight)
          const xRatio =
            target.scrollLeft / Math.max(1, target.scrollWidth - target.clientWidth)
          peers((peer) => {
            const twin = twinOf(peer.doc, path, tag, label) as HTMLElement | null
            if (!twin) return
            scrollEcho.set(peer.id, Date.now() + ECHO_MS)
            twin.scrollTop = yRatio * Math.max(0, twin.scrollHeight - twin.clientHeight)
            twin.scrollLeft = xRatio * Math.max(0, twin.scrollWidth - twin.clientWidth)
          })
        }

        const onClick = (e: Event) => {
          const target = e.target
          if (!(target instanceof sw.Element)) return
          const path = pathOf(target)
          const tag = target.tagName.toLowerCase()
          const label = labelOf(target)
          peers((peer) => {
            const twin = twinOf(peer.doc, path, tag, label)
            // `.click()` rather than a hand-built MouseEvent: it is what fires the
            // element's own default behaviour (a label toggling its checkbox, a
            // submit button submitting) as well as the bubbling listeners React
            // attaches at the root.
            if (twin && typeof (twin as HTMLElement).click === 'function') {
              ;(twin as HTMLElement).click()
            }
          })
        }

        const onInput = (e: Event) => {
          const target = e.target
          const isInput = target instanceof sw.HTMLInputElement
          const isArea = target instanceof sw.HTMLTextAreaElement
          const isSelect = target instanceof sw.HTMLSelectElement
          if (!isInput && !isArea && !isSelect) return
          const el = target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
          // A checkbox or radio is already mirrored by the click above; writing
          // its value here as well toggles it straight back.
          if (isInput && /^(checkbox|radio|file)$/.test((el as HTMLInputElement).type)) return
          const path = pathOf(el)
          const tag = el.tagName.toLowerCase()
          const label = labelOf(el)
          const value = el.value
          peers((peer) => {
            const twin = twinOf(peer.doc, path, tag, label) as
              | HTMLInputElement
              | HTMLTextAreaElement
              | HTMLSelectElement
              | null
            if (!twin) return
            const pw = peer.win as unknown as Record<string, { prototype: object }>
            const proto =
              twin.tagName === 'TEXTAREA'
                ? pw.HTMLTextAreaElement.prototype
                : twin.tagName === 'SELECT'
                  ? pw.HTMLSelectElement.prototype
                  : pw.HTMLInputElement.prototype
            // React tracks the last value it wrote to a controlled input and
            // ignores an assignment it didn't make, so the change has to go
            // through the prototype's own setter for the app to notice it.
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
            if (setter) setter.call(twin, value)
            else twin.value = value
            twin.dispatchEvent(new (peer.win as Window & typeof globalThis).Event('input', { bubbles: true }))
            twin.dispatchEvent(new (peer.win as Window & typeof globalThis).Event('change', { bubbles: true }))
          })
        }

        const onKeyDown = (e: Event) => {
          const key = (e as KeyboardEvent).key
          // Only the keys that DO something structural. A character key is already
          // covered by `input`, and replaying both types every letter twice.
          if (key !== 'Enter' && key !== 'Escape' && key !== 'Tab') return
          const target = e.target instanceof sw.Element ? e.target : null
          const path = target ? pathOf(target) : ''
          const tag = target ? target.tagName.toLowerCase() : ''
          const label = target ? labelOf(target) : ''
          peers((peer) => {
            const twin = path ? twinOf(peer.doc, path, tag, label) : peer.doc.body
            const init = {
              key,
              code: key,
              bubbles: true,
              cancelable: true,
            }
            const KeyboardEventCtor = (peer.win as Window & typeof globalThis).KeyboardEvent
            ;(twin ?? peer.doc.body).dispatchEvent(new KeyboardEventCtor('keydown', init))
            ;(twin ?? peer.doc.body).dispatchEvent(new KeyboardEventCtor('keyup', init))
          })
        }

        // Capture phase throughout: an app that calls `stopPropagation` in its own
        // handler would otherwise hide the click from the mirror, and the mirror
        // has to see exactly the clicks a person makes.
        source.doc.addEventListener('click', onClick, true)
        source.doc.addEventListener('input', onInput, true)
        source.doc.addEventListener('change', onInput, true)
        source.doc.addEventListener('keydown', onKeyDown, true)
        source.doc.addEventListener('scroll', onScroll, { capture: true, passive: true })
        source.win.addEventListener('scroll', onScroll, { passive: true })
        cleanups.push(() => {
          try {
            source.doc.removeEventListener('click', onClick, true)
            source.doc.removeEventListener('input', onInput, true)
            source.doc.removeEventListener('change', onInput, true)
            source.doc.removeEventListener('keydown', onKeyDown, true)
            source.doc.removeEventListener('scroll', onScroll, true)
            source.win.removeEventListener('scroll', onScroll)
          } catch {
            /* the frame is gone — nothing to detach from */
          }
        })
      }
    }

    /*
      WHEN to bind, and why it is not just "once, shortly after mount".
      That was the first implementation and it silently did nothing on a slow
      page: the frames were still loading when the last attempt ran, so nothing
      was ever bound and typing on one device reached none of the others
      (reproduced against a proxied github.com/login).

      Three triggers, all of them needed:
        • now — for frames that are already up (a remount from a rotate).
        • the frame's own `load` — the moment its document exists. A navigation
          INSIDE a frame gives it a brand-new document, and that fires load too.
        • a slow poll — a frame added later, one that becomes reachable later, and
          the client-side route change that replaces a document without a load
          event. The work per tick is a WeakSet lookup per frame.
    */
    attach()
    for (const frame of map.values()) {
      frame.addEventListener('load', attach)
      cleanups.push(() => frame.removeEventListener('load', attach))
    }
    const poll = window.setInterval(attach, 1000)
    return () => {
      window.clearInterval(poll)
      for (const c of cleanups) c()
    }
    // `nonce` is in the deps precisely because it changes when the frames remount.
  }, [enabled, frames, nonce])

  return reach
}

function ProbeBanner({
  probe,
  proxy,
  onUseProxy,
}: {
  probe: ResponsiveUrlProbe | undefined
  proxy: boolean
  onUseProxy: () => void
}) {
  if (!probe) return null
  if (probe.error) {
    return (
      <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-none">
        <CardContent className="flex items-start gap-2 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{probe.error}</span>
        </CardContent>
      </Card>
    )
  }
  if (!probe.framable && !proxy) {
    return (
      <Card className="rounded-2xl border-amber-500/40 bg-amber-500/5 shadow-none">
        <CardContent className="flex flex-wrap items-start gap-2 py-3 text-sm">
          <Shield className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1 space-y-1">
            <p>
              This page refuses to be shown in a frame —{' '}
              <span className="font-mono text-xs">{probe.frameBlockedBy}</span>. The devices below
              will stay blank, and the browser reports nothing when that happens.
            </p>
            <p className="text-xs text-muted-foreground">
              Route it through the portal instead (it strips that header), or use the Capture tab,
              which drives a real browser and is not affected.
            </p>
          </div>
          <Button size="sm" variant="outline" className="rounded-full" onClick={onUseProxy}>
            Use the proxy
          </Button>
        </CardContent>
      </Card>
    )
  }
  if (!probe.viewportMeta && probe.ok) {
    return (
      <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-none">
        <CardContent className="flex items-start gap-2 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            No <span className="font-mono text-xs">&lt;meta name="viewport"&gt;</span> in the HTML —
            a phone will lay this page out at ~980px and scale it down, so no breakpoint in the CSS
            ever fires. Worth fixing before reading anything below.
          </span>
        </CardContent>
      </Card>
    )
  }
  return null
}

// ------------------------------------------------------------------ capture tab

function Sev({ severity }: { severity: 'high' | 'medium' | 'low' }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        SEVERITY_CLASS[severity],
      )}
    >
      {SEVERITY_LABEL[severity]}
    </span>
  )
}

/** One device's screenshot + findings. */
function CaptureCard({
  jobId,
  capture,
  onOpenShot,
}: {
  jobId: string
  capture: ResponsiveDeviceCapture
  onOpenShot: (src: string, label: string) => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const findings = sortedFindings(capture)
  const shot = capture.screenshot ? responsiveShotUrl(jobId, capture.screenshot) : null
  const high = findings.filter((f) => f.severity === 'high').length

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
            <Smartphone className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold tracking-tight">{capture.device.label}</p>
            <p className="font-mono text-[11px] text-muted-foreground">
              {capture.device.width}×{capture.device.height} @{capture.device.dpr}x ·{' '}
              {capture.device.platform} · {capture.loadMs}ms
            </p>
          </div>
          <span className="ml-auto flex items-center gap-1.5">
            {capture.error ? (
              <Badge variant="outline" className="rounded-full border-destructive/40 text-destructive">
                not captured
              </Badge>
            ) : high ? (
              <Sev severity="high" />
            ) : findings.length ? (
              <Sev severity="medium" />
            ) : (
              <Badge variant="outline" className="rounded-full border-emerald-500/40 text-emerald-600">
                clean
              </Badge>
            )}
          </span>
        </div>

        {capture.error ? (
          <p className="rounded-2xl bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {capture.error}
          </p>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[13rem_1fr]">
            {shot && (
              <button
                type="button"
                onClick={() => onOpenShot(shot, capture.device.label)}
                className="group relative max-h-72 overflow-hidden rounded-2xl border border-border/60 bg-white transition-all duration-200 hover:border-border hover:shadow-sm"
              >
                <img src={shot} alt={`${capture.device.label} screenshot`} className="w-full" />
                <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-foreground/80 py-1 text-[10px] text-background opacity-0 transition-opacity group-hover:opacity-100">
                  <Expand className="size-3" /> full size
                </span>
              </button>
            )}
            <div className="space-y-1.5">
              <p className="font-mono text-[11px] text-muted-foreground">
                document {capture.scrollWidth}×{capture.documentHeight}px
                {capture.scrollWidth > capture.device.width + 2 && (
                  <span className="ml-1 font-sans font-medium text-destructive">
                    (+{capture.scrollWidth - capture.device.width}px sideways)
                  </span>
                )}
              </p>
              {!findings.length && (
                <p className="text-xs text-muted-foreground">
                  Nothing measurable is wrong at this size.
                </p>
              )}
              {findings.map((f) => {
                const isOpen = open === f.kind
                return (
                  <div key={f.kind} className="rounded-2xl border border-border/60">
                    <button
                      type="button"
                      onClick={() => setOpen(isOpen ? null : f.kind)}
                      className="flex w-full items-start gap-2 px-3 py-2 text-left"
                    >
                      <Sev severity={f.severity} />
                      <span className="min-w-0 flex-1 text-xs font-medium leading-snug">
                        {f.title}
                      </span>
                      <ChevronDown
                        className={cn(
                          'mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-180',
                        )}
                      />
                    </button>
                    {isOpen && (
                      <div className="space-y-2 border-t border-border/60 px-3 py-2 text-xs">
                        <p>{f.detail}</p>
                        <p className="text-muted-foreground">{KIND_EXPLAINER[f.kind]}</p>
                        {f.samples.length > 0 && (
                          <ul className="space-y-1">
                            {f.samples.map((s, i) => (
                              <li key={i} className="rounded-xl bg-muted/60 px-2 py-1">
                                <span className="font-mono text-[11px]">{s.selector}</span>
                                <span className="ml-1 text-[11px] text-muted-foreground">
                                  {s.rect.width}×{s.rect.height} at {s.rect.x},{s.rect.y}
                                </span>
                                {s.text && (
                                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                                    “{s.text}”
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {f.count > f.samples.length && f.samples.length > 0 && (
                          <p className="text-[11px] text-muted-foreground">
                            Showing {f.samples.length} of {f.count}.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {capture.jsErrors.length > 0 && (
                <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                  <p className="text-[11px] font-semibold text-destructive">
                    {capture.jsErrors.length} JavaScript error
                    {capture.jsErrors.length === 1 ? '' : 's'} while loading
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {capture.jsErrors.slice(0, 3).map((e, i) => (
                      <li key={i} className="truncate font-mono text-[10px] text-muted-foreground">
                        {e}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ the page

export default function ResponsivePage() {
  const { activeProjectId } = useProjects()

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Smartphone className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Responsive</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <Smartphone className="size-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar — a capture sweep is stored against one.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Keyed by project so switching remounts the workbench: every piece of state
  // below is initialized once from localStorage, the same pattern
  // `PerformancePage` uses, instead of an effect that overwrites it afterwards.
  return <ResponsiveWorkbench key={activeProjectId} projectId={activeProjectId} />
}

const ACTIVE_JOB_KEY = (projectId: string) => `qc.responsive.job.${projectId}`

function ResponsiveWorkbench({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  /**
   * The page IS the live preview — there is no second tab. Capturing real
   * screenshots is still here, behind the camera button, in a dialog: it is a
   * different ACT (drive a real emulated device server-side, wait, read
   * findings) rather than a different view of the same thing, and as a tab it
   * split a page whose whole job is "look at this URL on these devices".
   */
  const [captureOpen, setCaptureOpen] = useState(false)

  const [prefs, setPrefsState] = useState<ResponsivePrefs>(readPrefs)
  /**
   * Takes an UPDATER, not a value, and the reason is a bug that was reproduced:
   * ticking three devices in the picker without waiting for a re-render applied
   * all three against the same captured `prefs`, so only the last one survived
   * and the other two silently did nothing. Every write here reads the current
   * state, and localStorage is written from inside the reducer so the two can
   * never disagree.
   */
  const setPrefs = useCallback(
    (patch: ResponsivePrefs | ((current: ResponsivePrefs) => ResponsivePrefs)) => {
      setPrefsState((current) => {
        const next = typeof patch === 'function' ? patch(current) : patch
        writePrefs(next)
        return next
      })
    },
    [],
  )

  // What is in the URL box, vs. what the frames are actually showing. They differ
  // while typing on purpose: reloading the frames on every keystroke would hammer
  // the target app (and, on a dev server, trigger a rebuild per character).
  const [draftUrl, setDraftUrl] = useState(prefs.url)
  const [nonce, setNonce] = useState(0)
  const [focused, setFocused] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null)
  const frames = useRef(new Map<string, HTMLIFrameElement>())

  const url = prefs.url
  const devices = useMemo(() => {
    const list = prefs.deviceIds
      .map((id) => (id === 'custom' ? customPreset(prefs.custom) : presetById(id)))
      .filter((d): d is DevicePreset => Boolean(d))
    return prefs.custom.enabled && !prefs.deviceIds.includes('custom')
      ? [...list, customPreset(prefs.custom)]
      : list
  }, [prefs.deviceIds, prefs.custom])

  // Capability-detected, so the toolbar can say what is actually possible with
  // the frames currently on screen rather than guessing from the proxy switch.
  const reach = useMirror(prefs.syncActions, frames, nonce)

  const probe = useQuery({
    queryKey: ['responsive-probe', url],
    queryFn: () => probeResponsiveUrl(url),
    enabled: !!url,
    staleTime: 60_000,
    retry: false,
  })

  const availability = useQuery({
    queryKey: ['responsive-available'],
    queryFn: getResponsiveAvailability,
    staleTime: 300_000,
  })

  const jobs = useQuery({
    queryKey: ['responsive-jobs', projectId],
    queryFn: () => listResponsiveJobs(projectId),
  })

  // Which sweep the Capture tab is showing, remembered per project so a reload (or
  // a walk to another page and back) lands on the report that was being read.
  const [activeJobId, setActiveJobId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_JOB_KEY(projectId))
    } catch {
      return null
    }
  })
  useEffect(() => {
    try {
      if (activeJobId) localStorage.setItem(ACTIVE_JOB_KEY(projectId), activeJobId)
      else localStorage.removeItem(ACTIVE_JOB_KEY(projectId))
    } catch {
      /* storage unavailable */
    }
  }, [activeJobId, projectId])

  const job = useQuery({
    queryKey: ['responsive-job', activeJobId],
    queryFn: () => getResponsiveJob(activeJobId as string),
    enabled: !!activeJobId,
    // Polled only while it is running — the sweep is server-side and survives a
    // reload, so there is nothing to keep alive once it is done.
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1200 : false),
    // …and polled even while this tab is in the BACKGROUND, which React Query
    // does not do by default. A twelve-device sweep is exactly the thing an
    // engineer starts and then walks away from, and with the default the poll
    // stops the moment the tab is hidden: the page sits on "1 of 4" and the
    // completion toast never fires until the tab is focused again. Verified with
    // `document.hidden === true`. One request every 1.2s against localhost while
    // a sweep is in flight is not a cost worth that.
    refetchIntervalInBackground: true,
    retry: false,
  })

  // A finished sweep is worth a toast: a twelve-device capture takes long enough
  // that the engineer has moved to another tab by the time it lands.
  const announced = useRef<string | null>(null)
  useEffect(() => {
    const j = job.data
    if (!j || j.status === 'running' || announced.current === j.id) return
    announced.current = j.id
    if (j.status === 'done') {
      const v = verdictOf(j.result)
      if (v.level === 'ok') toast.success(v.headline)
      else toast.warning(v.headline)
    }
    void queryClient.invalidateQueries({ queryKey: ['responsive-jobs', projectId] })
  }, [job.data, queryClient, projectId])

  const [captureIds, setCaptureIds] = useState<string[]>(prefs.deviceIds)
  const [fullPage, setFullPage] = useState(true)
  const [useProfile, setUseProfile] = useState(false)
  const [waitMs, setWaitMs] = useState(0)

  const captureDevices = useMemo(
    () =>
      captureIds
        .map((id) => (id === 'custom' ? customPreset(prefs.custom) : presetById(id)))
        .filter((d): d is DevicePreset => Boolean(d))
        .map((d) => {
          const v = viewportOf(d, prefs.orientation)
          return {
            id: prefs.orientation === 'landscape' ? `${d.id}-landscape` : d.id,
            label:
              prefs.orientation === 'landscape' ? `${d.label} (landscape)` : d.label,
            width: v.width,
            height: v.height,
            dpr: d.dpr,
            platform: d.platform,
          }
        }),
    [captureIds, prefs.custom, prefs.orientation],
  )

  const start = useMutation({
    mutationFn: () =>
      startResponsiveCapture(projectId, {
        url,
        devices: captureDevices,
        fullPage,
        useProfile,
        waitMs,
      }),
    onSuccess: (created) => {
      announced.current = null
      setActiveJobId(created.id)
      setCaptureOpen(true)
      void queryClient.invalidateQueries({ queryKey: ['responsive-jobs', projectId] })
      toast.success(`Capturing ${created.config.devices.length} device(s)…`)
    },
    onError: (err: Error) => toast.error('Could not start the capture', { description: err.message }),
  })

  const cancel = useMutation({
    mutationFn: (id: string) => cancelResponsiveJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['responsive-job', activeJobId] }),
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteResponsiveJob(id),
    onSuccess: (_r, id) => {
      if (id === activeJobId) setActiveJobId(null)
      void queryClient.invalidateQueries({ queryKey: ['responsive-jobs', projectId] })
      toast.success('Sweep deleted')
    },
  })

  const applyUrl = (raw: string) => {
    const next = normalizeUrl(raw)
    if (!next) return
    setDraftUrl(next)
    setPrefs((p) => ({ ...p, url: next }))
    setNonce((n) => n + 1)
  }

  /**
   * Add or remove one device id, against the CURRENT list rather than the one
   * captured when the picker rendered — the picker is open across many clicks.
   */
  const nextIds = (list: string[], id: string, max: number): string[] => {
    if (list.includes(id)) {
      // Never leave zero devices: an empty stage looks identical to a broken page.
      return list.length === 1 ? list : list.filter((d) => d !== id)
    }
    return list.length < max ? [...list, id] : list
  }

  // Esc leaves focus mode. The extension has a lock for this; the portal keeps it
  // plain — the one thing worse than losing focus mode by accident is being stuck
  // in it with no visible way out.
  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocused(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused])

  const focusedDevice = focused ? devices.find((d) => d.id === focused) : null
  const browserOk = availability.data?.browser.ok !== false
  const currentJob = job.data
  const verdict = verdictOf(currentJob?.result ?? null)
  const common = commonKinds(currentJob?.result ?? null)

  return (
    // No max-width of its own: the shell gives `/responsive` the full width (see
    // App.tsx) precisely so the device row can use it, and a cap here would take
    // it straight back.
    <div className="space-y-5">
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <Smartphone className="size-5" />
        </span>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Responsive</h1>
          <p className="text-sm text-muted-foreground">
            One URL on many devices — look at it live, then capture the evidence.
          </p>
        </div>
      </header>

      {/* ---- the URL, shared by both tabs ---- */}
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="flex flex-wrap items-center gap-2 py-3">
          <Input
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyUrl(draftUrl)
            }}
            placeholder="http://localhost:5173/patient-management"
            className="min-w-[16rem] flex-1 rounded-full font-mono text-sm"
            spellCheck={false}
          />
          <Button className="rounded-full" onClick={() => applyUrl(draftUrl)} disabled={!draftUrl.trim()}>
            Load
          </Button>
          {url && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="rounded-full"
                  onClick={() => window.open(url, '_blank', 'noopener')}
                  aria-label="Open in a new tab"
                >
                  <ExternalLink className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Open in a real tab</TooltipContent>
            </Tooltip>
          )}
        </CardContent>
      </Card>

      <ProbeBanner
        probe={probe.data}
        proxy={prefs.proxy}
        onUseProxy={() => {
          setPrefs((p) => ({ ...p, proxy: true }))
          setNonce((n) => n + 1)
        }}
      />

      <div className="space-y-4">
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="flex flex-wrap items-center gap-2 py-3">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="rounded-full">
                    <Smartphone className="size-4" />
                    {devices.length === 1 ? devices[0].label : `${devices.length} devices`}
                    <ChevronDown className="size-3.5" />
                  </Button>
                </PopoverTrigger>
                <DevicePicker
                  selected={prefs.deviceIds}
                  max={MAX_LIVE_DEVICES}
                  onToggle={(id) =>
                    setPrefs((p) => ({ ...p, deviceIds: nextIds(p.deviceIds, id, MAX_LIVE_DEVICES) }))
                  }
                  onClear={() => setPrefs((p) => ({ ...p, deviceIds: [] }))}
                  customEnabled={prefs.deviceIds.includes('custom')}
                  onToggleCustom={() =>
                    setPrefs((p) => ({
                      ...p,
                      deviceIds: nextIds(p.deviceIds, 'custom', MAX_LIVE_DEVICES),
                      custom: { ...p.custom, enabled: true },
                    }))
                  }
                />
              </Popover>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="rounded-full"
                    onClick={() => setNonce((n) => n + 1)}
                    aria-label="Reload every frame"
                  >
                    <RefreshCw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Reload every device</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={prefs.orientation === 'landscape' ? 'default' : 'outline'}
                    size="icon"
                    className="rounded-full"
                    onClick={() =>
                      setPrefs((p) => ({
                        ...p,
                        orientation: p.orientation === 'portrait' ? 'landscape' : 'portrait',
                      }))
                    }
                    aria-label="Rotate"
                  >
                    <RotateCcw className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {prefs.orientation === 'portrait' ? 'Rotate to landscape' : 'Back to portrait'}
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="rounded-full"
                    onClick={() => {
                      // Seeded with the devices on screen, then it waits for a
                      // press: a sweep is tens of seconds of real browser work,
                      // so the camera opens the panel rather than firing one off
                      // an icon click.
                      setCaptureIds(prefs.deviceIds)
                      setCaptureOpen(true)
                    }}
                    aria-label="Capture these devices"
                  >
                    {currentJob?.status === 'running' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Camera className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Capture real screenshots + findings — a frame can't be photographed from here
                </TooltipContent>
              </Tooltip>

              {/* zoom */}
              <div className="flex items-center gap-1.5 rounded-full border border-border/60 px-2 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 rounded-full"
                  onClick={() => setPrefs((p) => ({ ...p, zoom: clampZoom(p.zoom - ZOOM_STEP) }))}
                  aria-label="Zoom out"
                >
                  <Minus className="size-3" />
                </Button>
                <input
                  type="range"
                  min={ZOOM_MIN}
                  max={ZOOM_MAX}
                  step={ZOOM_STEP}
                  value={prefs.zoom}
                  onChange={(e) => setPrefs((p) => ({ ...p, zoom: clampZoom(Number(e.target.value)) }))}
                  className="w-24 accent-primary"
                  aria-label="Zoom"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 rounded-full"
                  onClick={() => setPrefs((p) => ({ ...p, zoom: clampZoom(p.zoom + ZOOM_STEP) }))}
                  aria-label="Zoom in"
                >
                  <Plus className="size-3" />
                </Button>
                <span className="w-9 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
                  {Math.round(prefs.zoom * 100)}%
                </span>
              </div>

              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="icon" className="rounded-full" aria-label="Custom size">
                    <Sliders className="size-4" />
                  </Button>
                </PopoverTrigger>
                <CustomSizePanel prefs={prefs} setPrefs={setPrefs} />
              </Popover>

              <label className="ml-auto flex items-center gap-2 text-xs">
                <Checkbox
                  checked={prefs.showChrome}
                  onCheckedChange={(v) => setPrefs((p) => ({ ...p, showChrome: Boolean(v) }))}
                />
                Device frame
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={prefs.syncActions}
                  onCheckedChange={(v) => setPrefs((p) => ({ ...p, syncActions: Boolean(v) }))}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dotted">Sync actions</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Do it once, everywhere: a click, a keystroke or a scroll on one device is
                    replayed on all the others — matched by element, then by its label, because
                    the same page at 390px and 1280px is not the same DOM. Needs frames this
                    page is allowed to touch (same-origin): tick “Via portal”, or point it at
                    the portal's own origin.
                  </TooltipContent>
                </Tooltip>
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Checkbox
                  checked={prefs.proxy}
                  onCheckedChange={(v) => {
                    setPrefs((p) => ({ ...p, proxy: Boolean(v) }))
                    setNonce((n) => n + 1)
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help underline decoration-dotted">Via portal</span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Fetch the page through the server, stripping the headers that forbid framing.
                    Sends no cookies, so a page behind a login shows its login screen — and it is
                    what makes the frames same-origin, which is what lets actions be mirrored.
                  </TooltipContent>
                </Tooltip>
              </label>
            </CardContent>
          </Card>

          {/*
            "Via portal" on a page that frames FINE is the foot-gun this banner
            exists for: it was reported as "checking Via portal means it doesn't
            load". The proxy rewrites the page's URLs and drops its cookies, and a
            single-page app on a dev server needs none of that — a dev server
            sends no framing header at all. So when the probe says the URL is
            framable, say so and offer the switch back.
          */}
          {prefs.proxy && url && !isSameOrigin(url) && probe.data?.framable && (
            <Card className="rounded-2xl border-amber-500/40 bg-amber-500/5 shadow-none">
              <CardContent className="flex flex-wrap items-center gap-2 py-2.5 text-xs">
                <AlertTriangle className="size-3.5 shrink-0 text-amber-600" />
                <span className="min-w-0 flex-1">
                  This page allows being framed directly, so it doesn't need the portal proxy —
                  and the proxy is not a browser: it sends no cookies, and it can't rewrite an
                  absolute-path <span className="font-mono">import</span> inside a dev server's
                  module code. Turn it off unless a page refuses to appear.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="rounded-full"
                  onClick={() => {
                    setPrefs((p) => ({ ...p, proxy: false }))
                    setNonce((n) => n + 1)
                  }}
                >
                  Load it directly
                </Button>
              </CardContent>
            </Card>
          )}
          {prefs.proxy && url && isSameOrigin(url) && (
            <p className="px-1 text-xs text-muted-foreground">
              This URL is the portal's own origin, so the frames load it directly — the proxy
              would only add its own limits to a page that already frames and is already
              drivable.
            </p>
          )}

          {/*
            The one thing mirroring must never do is look broken silently. With it
            on, this says exactly how many of the frames on screen can actually be
            driven — and when the answer is "none of them", it says why and offers
            the one switch that fixes it.
          */}
          {prefs.syncActions && url && reach.total > 1 && reach.reachable < reach.total && (
            <Card className="rounded-2xl border-amber-500/40 bg-amber-500/5 shadow-none">
              <CardContent className="flex flex-wrap items-center gap-2 py-2.5 text-xs">
                <Link2Off className="size-3.5 shrink-0 text-amber-600" />
                <span className="min-w-0 flex-1">
                  {reach.reachable === 0
                    ? 'Actions can’t be mirrored: these frames are another origin, and the browser forbids reading or driving one. '
                    : `Mirroring ${reach.reachable} of ${reach.total} frames — the rest are another origin. `}
                  Fetch the page through the portal and every frame becomes drivable.
                </span>
                {!prefs.proxy && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    onClick={() => {
                      setPrefs((p) => ({ ...p, proxy: true }))
                      setNonce((n) => n + 1)
                    }}
                  >
                    Use the proxy
                  </Button>
                )}
              </CardContent>
            </Card>
          )}
          {prefs.syncActions && url && reach.total > 1 && reach.reachable === reach.total && (
            <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
              <Link2 className="size-3.5 text-emerald-600" />
              Clicks, typing and scrolling on any device are mirrored to the other{' '}
              {reach.total - 1}.
            </p>
          )}

          {!url ? (
            <Card className="rounded-3xl border-border/60 shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
                  <Smartphone className="size-5" />
                </span>
                <p className="text-sm text-muted-foreground">
                  Paste a URL above — a local dev server, a staging host, anything the browser can
                  reach.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="overflow-x-auto pb-4">
              <div className="flex items-start gap-6">
                {devices.map((device) => (
                  <LiveDevice
                    key={device.id}
                    device={device}
                    orientation={prefs.orientation}
                    url={url}
                    proxy={prefs.proxy}
                    chrome={
                      prefs.showChrome
                        ? device.id === 'custom'
                          ? prefs.custom.chrome
                          : chromeFor(device)
                        : 'none'
                    }
                    bezel={prefs.custom.color}
                    zoom={prefs.zoom}
                    nonce={nonce}
                    frameRef={(el) => {
                      if (el) frames.current.set(device.id, el)
                      else frames.current.delete(device.id)
                    }}
                    onFocus={() => setFocused(device.id)}
                    onRemove={
                      devices.length > 1
                        ? () =>
                            setPrefs((p) => ({
                              ...p,
                              deviceIds: p.deviceIds.filter((id) => id !== device.id),
                              custom:
                                device.id === 'custom' ? { ...p.custom, enabled: false } : p.custom,
                            }))
                        : undefined
                    }
                  />
                ))}
              </div>
            </div>
          )}
      </div>

      {/* ---- capture: a dialog, not a tab (see `captureOpen`) ---- */}
      <Dialog open={captureOpen} onOpenChange={setCaptureOpen}>
        <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto rounded-3xl">
          <DialogHeader>
            <DialogTitle className="tracking-tight">Capture the evidence</DialogTitle>
            <DialogDescription>
              A screenshot per device from a REAL emulated one — its viewport, device pixel
              ratio, mobile user agent and touch support — plus what is measurably wrong at
              that size. The frames behind this dialog cannot do any of that: an iframe has
              the desktop user agent and cannot be photographed cross-origin.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
          {!browserOk && (
            <Card className="rounded-2xl border-destructive/40 bg-destructive/5 shadow-none">
              <CardContent className="flex items-start gap-2 py-3 text-sm">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <span>
                  A real browser can't be driven on this machine:{' '}
                  {availability.data?.browser.error ?? 'playwright-core is unavailable'}. Install
                  Google Chrome (or run <span className="font-mono text-xs">npx playwright install chrome</span>)
                  and reload.
                </span>
              </CardContent>
            </Card>
          )}

          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-3 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="rounded-full">
                      <Smartphone className="size-4" />
                      {captureDevices.length} device{captureDevices.length === 1 ? '' : 's'}
                      <ChevronDown className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <DevicePicker
                    selected={captureIds}
                    max={MAX_CAPTURE_DEVICES}
                    onToggle={(id) => setCaptureIds((ids) => nextIds(ids, id, MAX_CAPTURE_DEVICES))}
                    onClear={() => setCaptureIds([])}
                    customEnabled={captureIds.includes('custom')}
                    onToggleCustom={() =>
                      setCaptureIds((ids) => nextIds(ids, 'custom', MAX_CAPTURE_DEVICES))
                    }
                  />
                </Popover>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={fullPage} onCheckedChange={(v) => setFullPage(Boolean(v))} />
                  Whole page
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox checked={useProfile} onCheckedChange={(v) => setUseProfile(Boolean(v))} />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="cursor-help underline decoration-dotted">Signed in</span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Reuse the QC browser profile so a page behind a login can be captured. Chrome
                      won't open one profile twice, so this path keeps the DESKTOP user agent — the
                      viewport and pixel ratio still follow each device.
                    </TooltipContent>
                  </Tooltip>
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  Settle
                  <Input
                    type="number"
                    min={0}
                    max={15000}
                    step={500}
                    value={waitMs}
                    onChange={(e) => setWaitMs(Number(e.target.value) || 0)}
                    className="h-8 w-20 rounded-full text-xs"
                  />
                  ms
                </label>
                <Button
                  className="ml-auto rounded-full"
                  onClick={() => (url ? start.mutate() : toast.error('Enter a URL first'))}
                  disabled={start.isPending || !browserOk || !url || currentJob?.status === 'running'}
                >
                  {start.isPending || currentJob?.status === 'running' ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Capturing…
                    </>
                  ) : (
                    <>
                      <Camera className="size-4" /> Capture
                    </>
                  )}
                </Button>
              </div>
              <p className="text-[11px] leading-snug text-muted-foreground">
                Each device is a real emulated one — its viewport, device pixel ratio, mobile user
                agent and touch support — loaded one after another so they don't compete for the
                CPU. {prefs.orientation === 'landscape' && 'Capturing in landscape, following the live tab. '}
                Screenshots are kept next to the portal's database, never inside a project.
              </p>
            </CardContent>
          </Card>

          {/* the sweep list */}
          {(jobs.data?.length ?? 0) > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {jobs.data?.map((j) => (
                <button
                  key={j.id}
                  type="button"
                  onClick={() => {
                    announced.current = j.id
                    setActiveJobId(j.id)
                  }}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] transition-all duration-200',
                    j.id === activeJobId
                      ? 'border-primary bg-primary/10'
                      : 'border-border/60 hover:border-border hover:bg-muted/60',
                  )}
                >
                  {j.status === 'running' && <Loader2 className="size-3 animate-spin" />}
                  <span className="max-w-[16rem] truncate font-mono">{j.label}</span>
                  <span className="text-muted-foreground">
                    {new Date(j.createdAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </button>
              ))}
            </div>
          )}

          {currentJob && (
            <>
              <Card
                className={cn(
                  'rounded-3xl shadow-none',
                  verdict.level === 'broken'
                    ? 'border-destructive/40 bg-destructive/5'
                    : verdict.level === 'warn'
                      ? 'border-amber-500/40 bg-amber-500/5'
                      : 'border-border/60',
                )}
              >
                <CardContent className="space-y-2 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-base font-semibold tracking-tight">
                      {currentJob.status === 'running'
                        ? currentJob.progress || 'Starting…'
                        : currentJob.status === 'error'
                          ? currentJob.error
                          : verdict.headline}
                    </p>
                    <span className="ml-auto flex items-center gap-1.5">
                      {currentJob.status === 'running' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="rounded-full"
                          onClick={() => cancel.mutate(currentJob.id)}
                        >
                          Stop
                        </Button>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => {
                              void navigator.clipboard.writeText(responsiveMarkdown(currentJob))
                              toast.success('Markdown copied')
                            }}
                          >
                            <Copy className="size-3.5" /> Copy report
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full"
                            onClick={() => {
                              // App mode has no download popup, so the toast is what
                              // tells the engineer where the file went.
                              const blob = new Blob([responsiveMarkdown(currentJob)], {
                                type: 'text/markdown',
                              })
                              const a = document.createElement('a')
                              const name = `responsive-${new Date(currentJob.createdAt)
                                .toISOString()
                                .slice(0, 16)
                                .replace(/[:T]/g, '')}.md`
                              a.href = URL.createObjectURL(blob)
                              a.download = name
                              a.click()
                              URL.revokeObjectURL(a.href)
                              toast.success(`Saved ${name} to your Downloads folder`)
                            }}
                          >
                            <Download className="size-3.5" /> .md
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="rounded-full text-muted-foreground hover:text-destructive"
                            onClick={() => remove.mutate(currentJob.id)}
                            aria-label="Delete this sweep"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </>
                      )}
                    </span>
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground">{currentJob.label}</p>
                  {currentJob.result?.redirected && (
                    <p className="rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      Every device ended on{' '}
                      <span className="font-mono">{currentJob.result.finalUrl}</span> — usually a
                      login wall. Everything below describes THAT page, not the one you asked for.
                      Tick “Signed in” and capture again.
                    </p>
                  )}
                  {common.length > 0 && (
                    <p className="rounded-2xl bg-muted/60 px-3 py-2 text-xs">
                      On <span className="font-semibold">every</span> device:{' '}
                      {common.join(', ')} — a layout problem rather than a breakpoint one, so it is
                      one ticket and not {currentJob.result?.captures.length}.
                    </p>
                  )}
                </CardContent>
              </Card>

              {currentJob.status === 'running' && (
                <Card className="rounded-2xl border-border/60 shadow-none">
                  <CardContent className="max-h-40 overflow-y-auto py-3">
                    {currentJob.logs.slice(-12).map((l, i) => (
                      <p
                        key={i}
                        className={cn(
                          'font-mono text-[11px]',
                          l.level === 'error'
                            ? 'text-destructive'
                            : l.level === 'success'
                              ? 'text-emerald-600'
                              : 'text-muted-foreground',
                        )}
                      >
                        {l.text}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              )}

              <div className="grid gap-3 xl:grid-cols-2">
                {currentJob.result?.captures.map((c) => (
                  <CaptureCard
                    key={c.device.id}
                    jobId={currentJob.id}
                    capture={c}
                    onOpenShot={(src, label) => setLightbox({ src, label })}
                  />
                ))}
              </div>
            </>
          )}

          {!currentJob && (
            <Card className="rounded-3xl border-border/60 shadow-none">
              <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
                <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
                  <Camera className="size-5" />
                </span>
                <p className="max-w-md text-sm text-muted-foreground">
                  Pick the devices and press Capture. Each one is loaded in a real emulated device
                  and comes back with a screenshot plus what is measurably wrong at that size —
                  sideways scroll, elements wider than the screen, tap targets under 44px, text
                  that is clipped rather than wrapped.
                </p>
              </CardContent>
            </Card>
          )}
          </div>
        </DialogContent>
      </Dialog>

      {/* focus mode — one device, everything else dimmed */}
      {focusedDevice && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-background/95 p-6 backdrop-blur"
          onClick={() => setFocused(null)}
        >
          <div onClick={(e) => e.stopPropagation()}>
            <LiveDevice
              device={focusedDevice}
              orientation={prefs.orientation}
              url={url}
              proxy={prefs.proxy}
              chrome={
                prefs.showChrome
                  ? focusedDevice.id === 'custom'
                    ? prefs.custom.chrome
                    : chromeFor(focusedDevice)
                  : 'none'
              }
              bezel={prefs.custom.color}
              zoom={prefs.zoom}
              nonce={nonce}
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="fixed right-6 top-6 rounded-full"
            onClick={() => setFocused(null)}
            aria-label="Leave focus mode"
          >
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* screenshot at full size */}
      <Dialog open={!!lightbox} onOpenChange={(o) => !o && setLightbox(null)}>
        <DialogContent className="max-h-[92vh] max-w-3xl overflow-auto rounded-3xl">
          {lightbox && (
            <>
              <p className="text-sm font-semibold tracking-tight">{lightbox.label}</p>
              <img src={lightbox.src} alt={lightbox.label} className="w-full rounded-2xl border border-border/60" />
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
