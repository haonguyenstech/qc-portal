import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  ArrowRight,
  BrainCircuit,
  BrainCog,
  ClipboardList,
  FileText,
  FolderGit2,
  Loader2,
  MessagesSquare,
  PenLine,
  PlayCircle,
  ScanSearch,
  Search,
  Sparkles,
  ThumbsUp,
  UserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  getKnowledgeDoc,
  getMemoryNote,
  getProjectClaudeMd,
  listKnowledge,
  listMemory,
} from '@/lib/api'

/**
 * AI BRAIN — everything Claude reads about this project, in one place.
 *
 * WHAT THIS TAB IS FOR, and what the previous version got wrong. It used to be a single
 * ornament: a neon "neural map" on a starfield, with each note drawn as a labelled node
 * on one ring. Measured on a real project (48 memory notes, 2 knowledge docs, 1 source
 * map) it failed in three ways at once, and all three are the same failure — it was built
 * for a project with eight items:
 *
 * 1. **It could not show the brain.** `MAX_NODES` was 24, so the footer read "+27 more not
 *    shown — see the Knowledge / Memory tabs". A map of the AI's knowledge that hides half
 *    of it, and refers you elsewhere for the rest, is not a map.
 * 2. **The labels were unreadable.** Names truncated at 22 characters put
 *    `notification-priority…` on screen twice, next to `notification-search-b…`. The name
 *    is the only content a node carries, so a truncated one identifies nothing.
 * 3. **It answered no question.** You could not search it, filter it, or see where any of
 *    it came from — which matters far more now that four different things write here (a
 *    QC run, a chat conversation, a 👍/👎, and the engineer).
 *
 * So this is three honest panels instead of one pretty one:
 *
 * - **The pipeline** — how context actually reaches a run: three source folders → the
 *   managed pointer block in CLAUDE.md → every surface that spawns `claude`. This is what
 *   the tab always claimed to explain, and a glowing circle never explained it.
 * - **The constellation** — the whole brain at a glance, one dot per item, grouped by kind
 *   and ringed by origin. Dots carry NO label, which is exactly why it scales: hovering
 *   identifies one in a readout that has room for the full name and description, so 200
 *   items are as legible as 8 and nothing is ever "not shown".
 * - **The inventory** — the same items as searchable rows with provenance, size and date.
 *   This is the half that answers a question ("what did the AI capture from chat last
 *   week?"), and it is the reason the visual half is allowed to stay visual.
 *
 * Styling follows the house System-Style UI — hairline borders, large radii, flat
 * surfaces, neutral with a sparing accent — rather than the dark-space palette the old
 * version invented for itself.
 */

type Kind = 'memory' | 'knowledge' | 'source-map'

/** Who wrote it. Parsed from the `source` provenance stamp the writers leave behind. */
type Origin = 'you' | 'run' | 'chat' | 'feedback' | 'ai'

interface BrainItem {
  id: string
  kind: Kind
  name: string
  description: string
  origin: Origin
  source: string
  size: number
  savedAt: string
}

const KIND_META: Record<
  Kind,
  {
    label: string
    /** Group name, for a filter chip or a column heading. */
    plural: string
    /** Counted noun — "1 source map" reads as a typo when the label never declines. */
    unit: [one: string, many: string]
    Icon: typeof FileText
    dot: string
    text: string
    css: string
  }
> = {
  memory: {
    label: 'Memory note',
    plural: 'Memory',
    unit: ['memory note', 'memory notes'],
    Icon: BrainCog,
    dot: 'bg-amber-500 dark:bg-amber-400',
    text: 'text-amber-600 dark:text-amber-400',
    css: 'var(--qc-memory)',
  },
  knowledge: {
    label: 'Knowledge doc',
    plural: 'Knowledge',
    unit: ['knowledge doc', 'knowledge docs'],
    Icon: FileText,
    dot: 'bg-violet-500 dark:bg-violet-400',
    text: 'text-violet-600 dark:text-violet-400',
    css: 'var(--qc-knowledge)',
  },
  'source-map': {
    label: 'Source map',
    plural: 'Source maps',
    unit: ['source map', 'source maps'],
    Icon: FolderGit2,
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    text: 'text-emerald-600 dark:text-emerald-400',
    css: 'var(--qc-map)',
  },
}

const ORIGIN_META: Record<Origin, { label: string; long: string; Icon: typeof FileText }> = {
  you: { label: 'You', long: 'Written by hand', Icon: UserRound },
  run: { label: 'Run', long: 'Captured after a QC run', Icon: PlayCircle },
  chat: { label: 'Chat', long: 'Captured from a chat conversation', Icon: MessagesSquare },
  feedback: { label: 'Rating', long: 'Captured from a 👍 / 👎 on a chat answer', Icon: ThumbsUp },
  ai: { label: 'AI', long: 'Captured by the AI', Icon: Sparkles },
}

/**
 * Which writer left this behind.
 *
 * The stamp is a human string (`ai · QC run PROJ-12 · 2026-06-29`, `chat · hi-41 · …`,
 * `feedback · liked · …`), so only its first segment is load-bearing — the rest is for a
 * person reading the file. An unrecognised stamp is still "the AI wrote this", which is
 * the distinction that matters: the badge exists so nobody mistakes a captured note for
 * something they wrote themselves.
 */
function originOf(source: string | undefined): Origin {
  const head = (source ?? '').split('·')[0]?.trim().toLowerCase()
  if (!head) return 'you'
  if (head === 'chat') return 'chat'
  if (head === 'feedback') return 'feedback'
  if (head === 'ai') return 'run'
  return 'ai'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

function formatWhen(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.round((Date.now() - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(t).toLocaleDateString()
}

/* ---------------------------------------------------------------------------
 * The constellation
 * -------------------------------------------------------------------------*/

const VIEW_W = 900
const VIEW_H = 470
const CX = VIEW_W / 2
const CY = VIEW_H / 2
/** Inner ring radius; the wide viewBox is filled by stretching x, not y. */
const R_INNER = 126
const RING_GAP = 33
/** Items fan across this many concentric rings so a dense wedge doesn't collide. */
const RINGS = 3
const X_STRETCH = 1.42
/** Angular breathing room between one kind's wedge and the next. */
const WEDGE_GAP = 0.18

interface Placed extends BrainItem {
  x: number
  y: number
}

/**
 * Place every item on a wedge sized by its kind's share of the brain.
 *
 * Grouped rather than evenly spread, because the shape itself should say something true:
 * a project whose brain is nearly all memory notes LOOKS like that, and the three colours
 * stay in three arcs instead of interleaving into confetti. Nothing is ever dropped — the
 * old version's `MAX_NODES` was the bug, not the crowding it was trying to avoid.
 */
function layout(items: BrainItem[]): Placed[] {
  const kinds: Kind[] = ['memory', 'knowledge', 'source-map']
  const present = kinds.filter((k) => items.some((i) => i.kind === k))
  if (!present.length) return []
  const total = items.length
  const usable = Math.PI * 2 - WEDGE_GAP * present.length
  let cursor = -Math.PI / 2 + WEDGE_GAP / 2
  const out: Placed[] = []
  for (const kind of present) {
    const list = items.filter((i) => i.kind === kind)
    const span = usable * (list.length / total)
    list.forEach((item, j) => {
      // A single item sits in the middle of its wedge rather than at its edge, or a lone
      // knowledge doc would be pinned against the memory arc it is meant to be apart from.
      const t = list.length === 1 ? 0.5 : j / (list.length - 1)
      const a = cursor + span * t
      const r = R_INNER + (j % RINGS) * RING_GAP
      out.push({ ...item, x: CX + Math.cos(a) * r * X_STRETCH, y: CY + Math.sin(a) * r })
    })
    cursor += span + WEDGE_GAP
  }
  return out
}

/**
 * How many spokes carry a travelling pulse at once.
 *
 * The pulses are the one animation here that means something — each is the AI pulling a
 * piece of context in — so they run on a rotating SUBSET rather than on all 51 edges. Every
 * edge lit at once is a light show; eight is a heartbeat, and it costs eight `animateMotion`
 * elements instead of fifty-one.
 */
const MAX_PULSES = 8
/** Where the sweep and the outermost decorative ring sit. */
const R_OUTER = R_INNER + RING_GAP * (RINGS - 1)
const R_SWEEP = R_OUTER + 46

/**
 * The sweep, as an ARC rather than a wedge.
 *
 * A filled pie slice was the first attempt and it looked like exactly that on screen — a
 * hard-edged blue triangle sitting on top of the map, because a radial gradient can fade a
 * wedge along its radius but not along its two straight edges. A stroked arc with a
 * gradient that dies out along its length has no edges to give away, and reads as what it
 * is meant to be: something travelling round the ring.
 *
 * Drawn in local coordinates around the origin; the group it sits in carries the x-stretch.
 */
function arcPath(r: number, from: number, to: number): string {
  const x1 = (Math.cos(from) * r).toFixed(2)
  const y1 = (Math.sin(from) * r).toFixed(2)
  const x2 = (Math.cos(to) * r).toFixed(2)
  const y2 = (Math.sin(to) * r).toFixed(2)
  const large = Math.abs(to - from) > Math.PI ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

function Constellation({
  items,
  projectName,
  onOpen,
}: {
  items: BrainItem[]
  projectName: string
  onOpen: (item: BrainItem) => void
}) {
  const placed = useMemo(() => layout(items), [items])
  const [hovered, setHovered] = useState<string | null>(null)
  const active = hovered ? placed.find((p) => p.id === hovered) : undefined

  /** Which spokes get a travelling pulse — spread evenly so the motion circles the ring. */
  const pulseEvery = Math.max(1, Math.ceil(placed.length / MAX_PULSES))

  return (
    <div className="qc-brain relative">
      {/* Palette + the whole motion vocabulary. Every animation here is a CSS transform or
          opacity on a handful of elements — no SVG blur filters (they re-rasterise every
          frame) and no per-item SMIL. The old version paid for a starfield, two orbits and
          24 dashed edges to say nothing; this pays for four things that each mean one. */}
      <style>{`
        .qc-brain {
          --qc-memory: #d97706;
          --qc-knowledge: #7c3aed;
          --qc-map: #059669;
          --qc-accent: #3279f9;
          --qc-wash: rgba(50, 121, 249, 0.07);
        }
        .dark .qc-brain {
          --qc-memory: #fbbf24;
          --qc-knowledge: #a78bfa;
          --qc-map: #34d399;
          --qc-accent: #6ea0fb;
          --qc-wash: rgba(110, 160, 251, 0.10);
        }
        /* The core's slow breath — the only thing that never stops. */
        @keyframes qcBreathe { 0%, 100% { opacity: 0.45; transform: scale(1); } 50% { opacity: 0.8; transform: scale(1.07); } }
        /* A ring expanding out of the core and fading, twice per cycle. */
        @keyframes qcRipple { 0% { transform: scale(0.62); opacity: 0.5; } 100% { transform: scale(1.5); opacity: 0; } }
        @keyframes qcSpin { to { transform: rotate(360deg); } }
        @keyframes qcSpinBack { to { transform: rotate(-360deg); } }
        /* Items arrive from the core outward, staggered, once. */
        @keyframes qcArrive { from { opacity: 0; transform: scale(0.3); } to { opacity: 1; transform: scale(1); } }
        /* A barely-there shimmer so a dense ring reads as alive, not as a printed chart. */
        @keyframes qcShimmer { 0%, 100% { opacity: 0.78; } 50% { opacity: 1; } }
        .qc-brain [data-anim] { animation-play-state: running; }
        @media (prefers-reduced-motion: reduce) {
          .qc-brain [data-anim] { animation: none !important; }
          .qc-brain [data-motion] { display: none; }
        }
      `}</style>

      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="block w-full"
        role="img"
        aria-label={`Everything the AI reads about ${projectName}: ${items.length} items`}
      >
        <defs>
          {/* Backdrop wash — a tinted pool under the core so the panel has a centre of
              gravity. Flat surfaces are the house style; this is depth by LIGHT, not by
              a drop shadow. */}
          <radialGradient id="qc-wash" cx="50%" cy="50%" r="62%">
            <stop offset="0%" stopColor="var(--qc-accent)" stopOpacity="0.10" />
            <stop offset="55%" stopColor="var(--qc-accent)" stopOpacity="0.035" />
            <stop offset="100%" stopColor="var(--qc-accent)" stopOpacity="0" />
          </radialGradient>
          {/* Fades along the arc: nothing at the tail, brightest at the head. */}
          <linearGradient id="qc-sweep" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--qc-accent)" stopOpacity="0" />
            <stop offset="60%" stopColor="var(--qc-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--qc-accent)" stopOpacity="0.75" />
          </linearGradient>
          {/* The core's halo. A FLAT disc at low opacity was the first try and it read as
              a pale blue ball sitting on the page; a gradient that dies out at its own
              edge is the difference between a light source and a sticker. */}
          <radialGradient id="qc-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--qc-accent)" stopOpacity="0.55" />
            <stop offset="58%" stopColor="var(--qc-accent)" stopOpacity="0.18" />
            <stop offset="100%" stopColor="var(--qc-accent)" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="qc-core" cx="36%" cy="30%" r="80%">
            <stop offset="0%" className="[stop-color:var(--color-card)]" />
            <stop offset="100%" stopColor="var(--qc-accent)" stopOpacity="0.07" />
          </radialGradient>
          <pattern id="qc-grid" width="34" height="34" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" className="fill-border" opacity="0.55" />
          </pattern>
        </defs>

        <rect width={VIEW_W} height={VIEW_H} fill="url(#qc-grid)" />
        <rect width={VIEW_W} height={VIEW_H} fill="url(#qc-wash)" />

        {/* Everything circular lives in one x-stretched group, so a "circle" here comes out
            as the same ellipse the items are laid out on and the sweep tracks the ring
            exactly instead of drifting across it. */}
        <g transform={`translate(${CX} ${CY}) scale(${X_STRETCH} 1)`}>
          <g
            data-anim
            data-motion
            style={{ animation: 'qcSpin 14s linear infinite', transformOrigin: '0px 0px' }}
          >
            {/* A wide, faint pass under a thin bright one — the cheap way to draw a
                glow without an feGaussianBlur that re-rasterises on every frame. */}
            <path
              d={arcPath(R_SWEEP, -1.15, 0)}
              fill="none"
              stroke="url(#qc-sweep)"
              strokeWidth={14}
              strokeLinecap="round"
              opacity={0.28}
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={arcPath(R_SWEEP, -1.15, 0)}
              fill="none"
              stroke="url(#qc-sweep)"
              strokeWidth={2}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </g>

          {/* Guide rings. The outermost is dashed and counter-rotates — one slow, quiet
              movement that gives the whole panel a sense of depth without competing with
              the dots for attention. */}
          {[R_INNER, R_INNER + RING_GAP, R_OUTER].map((r) => (
            <circle
              key={r}
              r={r}
              fill="none"
              className="stroke-border/60"
              strokeWidth={1 / X_STRETCH}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <g
            data-anim
            data-motion
            style={{ animation: 'qcSpinBack 90s linear infinite', transformOrigin: '0px 0px' }}
          >
            <circle
              r={R_SWEEP}
              fill="none"
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray="2 14"
              vectorEffect="non-scaling-stroke"
            />
          </g>
        </g>

        {/* Spokes. Every item is wired to the core — that IS the point of the picture — so
            they are drawn at an opacity low enough to read as texture, and only the
            hovered one is drawn as a line you are meant to follow. */}
        {placed.map((p) => {
          const on = hovered === p.id
          return (
            <line
              key={`spoke-${p.id}`}
              x1={CX}
              y1={CY}
              x2={p.x}
              y2={p.y}
              strokeWidth={on ? 1.6 : 1}
              strokeOpacity={on ? 0.9 : hovered ? 0.05 : 0.15}
              style={{ stroke: KIND_META[p.kind].css, transition: 'stroke-opacity 0.2s' }}
            />
          )
        })}

        {/* Travelling pulses — context being pulled INTO the brain, which is the direction
            that tells the truth: these files are read, not written, on every run. */}
        {placed.map((p, i) => {
          if (i % pulseEvery !== 0 && hovered !== p.id) return null
          const d = `M ${p.x} ${p.y} L ${CX} ${CY}`
          return (
            <circle
              key={`pulse-${p.id}`}
              data-motion
              r={hovered === p.id ? 3.6 : 2.4}
              style={{ fill: KIND_META[p.kind].css }}
              opacity={hovered && hovered !== p.id ? 0.15 : 0.85}
            >
              <animateMotion
                dur={`${2.6 + (i % 5) * 0.45}s`}
                begin={`${(i % 7) * 0.35}s`}
                repeatCount="indefinite"
                path={d}
                calcMode="linear"
              />
            </circle>
          )
        })}

        {/* Core. Layered translucent circles instead of a blur filter, a breath, and two
            ripples leaving on the offbeat — the visual for "this is being read right now". */}
        <g data-anim data-motion style={{ transformOrigin: `${CX}px ${CY}px` }}>
          {[0, 2.2].map((delay) => (
            <circle
              key={delay}
              cx={CX}
              cy={CY}
              r={62}
              fill="none"
              strokeWidth={1.5}
              data-anim
              style={{
                stroke: 'var(--qc-accent)',
                transformOrigin: `${CX}px ${CY}px`,
                animation: `qcRipple 4.4s ease-out ${delay}s infinite`,
              }}
            />
          ))}
        </g>
        <circle
          cx={CX}
          cy={CY}
          r={102}
          data-anim
          fill="url(#qc-glow)"
          style={{
            transformOrigin: `${CX}px ${CY}px`,
            animation: 'qcBreathe 4.5s ease-in-out infinite',
            opacity: 0.5,
          }}
        />
        <circle cx={CX} cy={CY} r={56} fill="url(#qc-core)" className="stroke-border" strokeWidth={1} />
        <BrainCircuit
          x={CX - 22}
          y={CY - 28}
          width={44}
          height={44}
          strokeWidth={1.3}
          style={{ stroke: 'var(--qc-accent)' }}
        />
        <text
          x={CX}
          y={CY + 30}
          textAnchor="middle"
          fontSize={12}
          fontWeight={600}
          className="fill-foreground"
        >
          {items.length}
        </text>
        <text
          x={CX}
          y={CY + 42}
          textAnchor="middle"
          fontSize={9}
          letterSpacing="0.06em"
          className="fill-muted-foreground"
        >
          IN CONTEXT
        </text>

        {/* Items. A FILLED dot was captured by the AI, a HOLLOW one was written by hand —
            the one distinction worth encoding in the shape, because it is the one that
            decides how much you trust a line before acting on it. */}
        {placed.map((p, i) => {
          const on = hovered === p.id
          const filled = p.origin !== 'you'
          const dim = hovered !== null && !on
          return (
            <g
              key={p.id}
              className="cursor-pointer"
              data-anim
              style={{
                transformOrigin: `${p.x}px ${p.y}px`,
                // Arrive once, staggered outward from the core; then shimmer forever, but
                // only just — the pointer, not the animation, is what should draw the eye.
                animation: `qcArrive 0.45s cubic-bezier(0.2, 0.9, 0.3, 1) ${i * 0.018}s both, qcShimmer ${4 + (i % 5) * 0.7}s ease-in-out ${i * 0.09}s infinite`,
                opacity: dim ? 0.4 : 1,
                transition: 'opacity 0.2s',
              }}
              onMouseEnter={() => setHovered(p.id)}
              onMouseLeave={() => setHovered(null)}
              onClick={() => onOpen(p)}
            >
              {/* A generous invisible target: the visible dot is 6px, which is a fine
                  thing to look at and a terrible thing to hit. */}
              <circle cx={p.x} cy={p.y} r={13} fill="transparent" />
              {on && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={15}
                  opacity={0.18}
                  style={{ fill: KIND_META[p.kind].css }}
                />
              )}
              <circle
                cx={p.x}
                cy={p.y}
                r={on ? 8 : 5.5}
                strokeWidth={on ? 2 : 1.5}
                className={cn(!filled && 'fill-card')}
                style={{
                  fill: filled ? KIND_META[p.kind].css : undefined,
                  stroke: KIND_META[p.kind].css,
                  transition: 'r 0.15s',
                }}
              />
            </g>
          )
        })}
      </svg>

      {/* The readout. Fixed height so nothing on the page moves as the pointer travels,
          and HTML rather than <text> so a long description wraps and truncates properly —
          the old version drew this as SVG text and cut it at 90 characters. */}
      <div className="flex min-h-[52px] items-center gap-3 border-t border-border/60 px-5 py-2.5">
        {active ? (
          <>
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60"
              style={{ color: KIND_META[active.kind].css }}
            >
              {(() => {
                const Icon = KIND_META[active.kind].Icon
                return <Icon className="size-3.5" />
              })()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{active.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {active.description || KIND_META[active.kind].label} ·{' '}
                {ORIGIN_META[active.origin].long} · {formatBytes(active.size)}
              </span>
            </span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              click to read
            </span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">
            Hover a dot to identify it, click to read it. Filled = captured by the AI, hollow =
            written by you.
          </span>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * The pipeline
 * -------------------------------------------------------------------------*/

function PipelineBox({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0 flex-1 rounded-2xl border border-border/60 bg-card p-4', className)}>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  )
}

/** The chevron between two stages. Rotates to point down once the row stacks. */
function Flow() {
  const style = 'size-4 shrink-0 text-muted-foreground/60'
  return (
    <div className="flex items-center justify-center py-1 lg:py-0">
      <ArrowRight className={cn(style, 'rotate-90 lg:rotate-0')} />
    </div>
  )
}

function Pipeline({
  counts,
  claudeMd,
}: {
  counts: Record<Kind, number>
  claudeMd: { exists: boolean; size: number } | undefined
}) {
  const consumers = [
    { label: 'QC runs', Icon: PlayCircle },
    { label: 'Test-case generation', Icon: ClipboardList },
    { label: 'Chat', Icon: MessagesSquare },
    { label: 'Design Check', Icon: ScanSearch },
  ]
  return (
    <div className="flex flex-col gap-1 lg:flex-row lg:items-stretch lg:gap-2">
      <PipelineBox title="What you keep">
        <ul className="space-y-2">
          {(Object.keys(KIND_META) as Kind[]).map((kind) => {
            const meta = KIND_META[kind]
            return (
              <li key={kind} className="flex items-center gap-2 text-sm">
                <meta.Icon className={cn('size-4 shrink-0', meta.text)} />
                <span className="min-w-0 flex-1 truncate">{meta.plural}</span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {counts[kind]}
                </span>
              </li>
            )
          })}
        </ul>
      </PipelineBox>

      <Flow />

      <PipelineBox title="How it gets there">
        <p className="flex items-center gap-2 text-sm">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-mono text-[13px]">CLAUDE.md</span>
          {claudeMd?.exists && (
            <span className="ml-auto font-mono text-xs text-muted-foreground">
              {formatBytes(claudeMd.size)}
            </span>
          )}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          A managed pointer block in the project's{' '}
          <span className="font-mono">CLAUDE.md</span> links to the folders above, so the
          file stays lean and nothing has to be pasted into it.
        </p>
      </PipelineBox>

      <Flow />

      <PipelineBox title="Where it's read">
        <ul className="grid grid-cols-2 gap-x-3 gap-y-2 lg:grid-cols-1">
          {consumers.map((c) => (
            <li key={c.label} className="flex items-center gap-2 text-sm">
              <c.Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{c.label}</span>
            </li>
          ))}
        </ul>
      </PipelineBox>
    </div>
  )
}

/* ---------------------------------------------------------------------------
 * The preview dialog
 * -------------------------------------------------------------------------*/

function ItemPreview({
  item,
  projectId,
  onClose,
}: {
  item: BrainItem
  projectId: string
  onClose: () => void
}) {
  const navigate = useNavigate()
  const isMemory = item.kind === 'memory'
  const { data, isLoading, error } = useQuery({
    queryKey: [isMemory ? 'memory-note' : 'knowledge-doc', projectId, item.name],
    queryFn: () =>
      isMemory ? getMemoryNote(item.name, projectId) : getKnowledgeDoc(item.name, projectId),
  })
  const meta = KIND_META[item.kind]
  const origin = ORIGIN_META[item.origin]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <meta.Icon className={cn('size-4 shrink-0', meta.text)} />
            <span className="truncate">{item.name}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="inline-flex items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px]">
              <origin.Icon className="size-3" /> {origin.long}
            </span>
            <span className="text-[11px]">
              {meta.label} · {formatBytes(item.size)} · {formatWhen(item.savedAt)}
            </span>
          </DialogDescription>
        </DialogHeader>
        {item.description && (
          <p className="-mt-1 text-sm text-muted-foreground">{item.description}</p>
        )}
        <div className="max-h-[55svh] overflow-y-auto rounded-2xl border border-border/60 bg-muted/30 px-4 py-3">
          {isLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : error ? (
            <p className="py-8 text-sm text-destructive">
              {error instanceof Error ? error.message : 'Failed to load'}
            </p>
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_pre]:overflow-x-auto">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data?.content ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
        {/* Read-only here on purpose — this tab is the overview, and the editors already
            exist one tab away. Sending the reader THERE beats a second edit surface that
            has to be kept in step with them. */}
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/instructions?tab=${isMemory ? 'memory' : 'knowledge'}`)}
          >
            <PenLine className="size-3.5" />
            Edit in {isMemory ? 'Memory' : 'Knowledge'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------------------------------------------------------
 * The inventory
 * -------------------------------------------------------------------------*/

type Filter = 'all' | Kind | 'captured' | 'yours'

function FilterChip({
  on,
  onClick,
  children,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors',
        on
          ? 'border-transparent bg-foreground text-background'
          : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function InventoryRow({ item, onOpen }: { item: BrainItem; onOpen: () => void }) {
  const meta = KIND_META[item.kind]
  const origin = ORIGIN_META[item.origin]
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60',
          meta.text,
        )}
      >
        <meta.Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{item.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {item.description || meta.label}
        </span>
      </span>
      <span
        className="hidden shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-flex"
        title={origin.long}
      >
        <origin.Icon className="size-3" />
        {origin.label}
      </span>
      <span className="hidden w-16 shrink-0 text-right font-mono text-[11px] text-muted-foreground md:inline">
        {formatBytes(item.size)}
      </span>
      <span className="hidden w-20 shrink-0 text-right text-[11px] text-muted-foreground lg:inline">
        {formatWhen(item.savedAt)}
      </span>
    </button>
  )
}

/* ---------------------------------------------------------------------------
 * The tab
 * -------------------------------------------------------------------------*/

export function AiBrainMap({ projectId, projectName }: { projectId: string; projectName: string }) {
  const memoryQuery = useQuery({
    queryKey: ['memory', projectId],
    queryFn: () => listMemory(projectId),
  })
  const knowledgeQuery = useQuery({
    queryKey: ['knowledge', projectId],
    queryFn: () => listKnowledge(projectId),
  })
  const claudeMdQuery = useQuery({
    queryKey: ['claude-md', projectId],
    queryFn: () => getProjectClaudeMd(projectId),
  })

  const [selected, setSelected] = useState<BrainItem | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')

  const items = useMemo<BrainItem[]>(() => {
    const memory = (memoryQuery.data ?? []).map((n) => ({
      id: `memory:${n.name}`,
      kind: 'memory' as Kind,
      name: n.name,
      description: n.description ?? '',
      origin: originOf(n.source),
      source: n.source ?? '',
      size: n.size,
      savedAt: n.savedAt,
    }))
    const knowledge = (knowledgeQuery.data ?? []).map((d) => ({
      id: `knowledge:${d.name}`,
      // A generated repo map is a knowledge doc on disk, but it is a different KIND of
      // thing to read — nobody wrote it and nobody maintains it — so it gets its own
      // colour rather than being counted among the specs somebody uploaded.
      kind: (d.name.startsWith('source-map-') ? 'source-map' : 'knowledge') as Kind,
      name: d.name,
      description: '',
      origin: originOf(d.source),
      source: d.source ?? '',
      size: d.size,
      savedAt: d.savedAt,
    }))
    return [...memory, ...knowledge]
  }, [memoryQuery.data, knowledgeQuery.data])

  const counts = useMemo(() => {
    const c: Record<Kind, number> = { memory: 0, knowledge: 0, 'source-map': 0 }
    for (const i of items) c[i.kind] += 1
    return c
  }, [items])
  const capturedCount = items.filter((i) => i.origin !== 'you').length

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (filter === 'captured' && i.origin === 'you') return false
      if (filter === 'yours' && i.origin !== 'you') return false
      if (filter !== 'all' && filter !== 'captured' && filter !== 'yours' && i.kind !== filter) {
        return false
      }
      if (!q) return true
      return i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)
    })
  }, [items, filter, query])

  const loading = memoryQuery.isLoading || knowledgeQuery.isLoading

  if (loading) {
    return (
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="flex items-center justify-center gap-2 py-28 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reading the project's context…
        </CardContent>
      </Card>
    )
  }

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        <Pipeline counts={counts} claudeMd={claudeMdQuery.data} />
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <BrainCircuit className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Nothing in the brain yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Write a Memory note, upload a Knowledge doc, or connect a repo to generate a
                source map. Anything you keep here is read on every run — and the AI adds to it
                on its own after runs and chats.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <Pipeline counts={counts} claudeMd={claudeMdQuery.data} />

      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 bg-muted/60 px-5 py-3 text-xs">
          {(Object.keys(KIND_META) as Kind[]).map((kind) => (
            <span key={kind} className="flex items-center gap-1.5 font-medium">
              <span className={cn('size-2 rounded-full', KIND_META[kind].dot)} />
              {counts[kind]} {KIND_META[kind].unit[counts[kind] === 1 ? 0 : 1]}
            </span>
          ))}
          {capturedCount > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Sparkles className="size-3 text-primary" /> {capturedCount} captured by the AI
            </span>
          )}
          <span className="ml-auto text-muted-foreground">
            {items.length} {items.length === 1 ? 'item' : 'items'} read on every run in{' '}
            {projectName}
          </span>
        </div>
        <CardContent className="p-0">
          <Constellation items={items} projectName={projectName} onOpen={setSelected} />
        </CardContent>
      </Card>

      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search the brain…"
                className="h-9 rounded-full pl-9"
              />
            </div>
            <FilterChip on={filter === 'all'} onClick={() => setFilter('all')}>
              All {items.length}
            </FilterChip>
            {(Object.keys(KIND_META) as Kind[])
              .filter((k) => counts[k] > 0)
              .map((kind) => (
                <FilterChip key={kind} on={filter === kind} onClick={() => setFilter(kind)}>
                  <span className={cn('size-2 rounded-full', KIND_META[kind].dot)} />
                  {KIND_META[kind].plural} {counts[kind]}
                </FilterChip>
              ))}
            {capturedCount > 0 && capturedCount < items.length && (
              <>
                <FilterChip on={filter === 'captured'} onClick={() => setFilter('captured')}>
                  <Sparkles className="size-3" /> AI {capturedCount}
                </FilterChip>
                <FilterChip on={filter === 'yours'} onClick={() => setFilter('yours')}>
                  <UserRound className="size-3" /> Yours {items.length - capturedCount}
                </FilterChip>
              </>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Nothing matches “{query}”.
            </p>
          ) : (
            <div className="space-y-2">
              {shown.map((item) => (
                <InventoryRow key={item.id} item={item} onOpen={() => setSelected(item)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {selected && (
        <ItemPreview item={selected} projectId={projectId} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
