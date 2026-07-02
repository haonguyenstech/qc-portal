import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BrainCircuit, BrainCog, FileText, FolderGit2, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getKnowledgeDoc, getMemoryNote, listKnowledge, listMemory } from '@/lib/api'

// AI Brain — an animated "neural map" of everything the AI reads on every run:
// a pulsing brain at the center, wired to each Memory note and Knowledge doc.
// Pure SVG + CSS animation (no new deps); clicking a node opens its content.
//
// THEMING: every color goes through a --qc-* CSS variable declared in the scoped
// <style> block — light mode gets an airy "daylight" palette, .dark keeps the
// deep-space look. Dynamic colors are applied via style={} (presentation
// attributes don't support var()).
//
// PERFORMANCE: no SVG blur filters (feGaussianBlur re-rasterizes every frame),
// glows are faked with layered translucent circles, travelling pulse dots are
// capped, and ALL animation is paused while the preview dialog is open.

type NodeKind = 'memory' | 'knowledge' | 'source-map'

interface BrainNode {
  id: string
  kind: NodeKind
  name: string
  description?: string
  ai: boolean // AI-captured (has a provenance source)
  x: number
  y: number
  delay: number // stagger, seconds
  pulse: boolean // whether this edge gets a travelling pulse dot (capped)
}

const KIND_META: Record<NodeKind, { label: string; Icon: typeof FileText; text: string }> = {
  memory: { label: 'Memory note', Icon: BrainCog, text: 'text-amber-600 dark:text-amber-400' },
  knowledge: {
    label: 'Knowledge doc',
    Icon: FileText,
    text: 'text-violet-600 dark:text-violet-400',
  },
  'source-map': {
    label: 'Source map',
    Icon: FolderGit2,
    text: 'text-emerald-600 dark:text-emerald-400',
  },
}

// Per-kind accent — resolved by the theme via CSS variables.
const EDGE_COLOR: Record<NodeKind, string> = {
  memory: 'var(--qc-memory)',
  knowledge: 'var(--qc-knowledge)',
  'source-map': 'var(--qc-map)',
}

const VIEW_W = 1000
const VIEW_H = 660
const CX = VIEW_W / 2
const CY = VIEW_H / 2
const MAX_NODES = 24 // beyond this the map gets unreadable — fold the rest into "+N"
const MAX_PULSES = 8 // travelling dots are the priciest animation — cap them

// Fixed ambient particles (deterministic — no Math.random so renders are stable).
const STARS = Array.from({ length: 18 }, (_, i) => ({
  x: ((i * 271) % VIEW_W) + 8,
  y: ((i * 199 + 60) % VIEW_H) + 4,
  r: 0.8 + (i % 3) * 0.5,
  dur: 3 + (i % 5) * 1.1,
  delay: (i % 7) * 0.6,
}))

/** Spread nodes on an ellipse around the brain, memory on the left, knowledge on the right. */
function layoutNodes(
  memory: { name: string; description: string; source?: string }[],
  knowledge: { name: string; source?: string }[],
): { nodes: BrainNode[]; hidden: number } {
  const items = [
    ...memory.map((n) => ({
      id: `memory:${n.name}`,
      kind: 'memory' as NodeKind,
      name: n.name,
      description: n.description,
      ai: Boolean(n.source),
    })),
    ...knowledge.map((d) => ({
      id: `knowledge:${d.name}`,
      kind: (d.name.startsWith('source-map-') ? 'source-map' : 'knowledge') as NodeKind,
      name: d.name,
      ai: Boolean(d.source),
    })),
  ]
  const hidden = Math.max(0, items.length - MAX_NODES)
  const shown = items.slice(0, MAX_NODES)
  const count = shown.length
  const pulseEvery = Math.max(1, Math.ceil(count / MAX_PULSES))
  const rx = VIEW_W * 0.395
  const ry = VIEW_H * 0.355
  const nodes = shown.map((item, i) => {
    // Start at the top and walk clockwise; a small alternating radial jitter keeps
    // dense maps from reading as a perfect (boring) ring.
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(count, 1)
    const wobble = i % 2 === 0 ? 1 : 0.8
    return {
      ...item,
      x: CX + Math.cos(angle) * rx * wobble,
      y: CY + Math.sin(angle) * ry * wobble,
      delay: i * 0.12,
      pulse: i % pulseEvery === 0,
    }
  })
  return { nodes, hidden }
}

/** Curved edge from the brain to a node (control point pulled toward the center). */
function edgePath(n: BrainNode): string {
  const mx = CX + (n.x - CX) * 0.5
  const my = CY + (n.y - CY) * 0.5 - (n.x > CX ? 26 : -26)
  return `M ${CX} ${CY} Q ${mx} ${my} ${n.x} ${n.y}`
}

function truncateLabel(s: string, n = 22): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

/** Preview dialog — fetches and renders the clicked node's markdown. */
function NodePreview({
  node,
  projectId,
  onClose,
}: {
  node: BrainNode
  projectId: string
  onClose: () => void
}) {
  const isMemory = node.kind === 'memory'
  const { data, isLoading, error } = useQuery({
    queryKey: [isMemory ? 'memory-note' : 'knowledge-doc', projectId, node.name],
    queryFn: () =>
      isMemory ? getMemoryNote(node.name, projectId) : getKnowledgeDoc(node.name, projectId),
  })
  const meta = KIND_META[node.kind]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <meta.Icon className={cn('size-4', meta.text)} />
            {node.name}
            {node.ai && (
              <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                <Sparkles className="size-3" /> AI
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {meta.label}
            {node.description ? ` — ${node.description}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60svh] overflow-y-auto rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
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
      </DialogContent>
    </Dialog>
  )
}

export function AiBrainMap({ projectId, projectName }: { projectId: string; projectName: string }) {
  const memoryQuery = useQuery({
    queryKey: ['memory', projectId],
    queryFn: () => listMemory(projectId),
  })
  const knowledgeQuery = useQuery({
    queryKey: ['knowledge', projectId],
    queryFn: () => listKnowledge(projectId),
  })
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<BrainNode | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)

  // Freeze the whole map while the dialog is up — SMIL + CSS animations behind a
  // modal are pure wasted work and make the open/close transition stutter.
  const frozen = selected !== null
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    try {
      if (frozen) svg.pauseAnimations()
      else svg.unpauseAnimations()
    } catch {
      /* older engines without SMIL control */
    }
  }, [frozen])

  const memory = useMemo(() => memoryQuery.data ?? [], [memoryQuery.data])
  const knowledge = useMemo(() => knowledgeQuery.data ?? [], [knowledgeQuery.data])
  const { nodes, hidden } = useMemo(() => layoutNodes(memory, knowledge), [memory, knowledge])
  const loading = memoryQuery.isLoading || knowledgeQuery.isLoading
  const counts = {
    knowledge: knowledge.filter((d) => !d.name.startsWith('source-map-')).length,
    maps: knowledge.filter((d) => d.name.startsWith('source-map-')).length,
    ai: memory.filter((n) => n.source).length + knowledge.filter((d) => d.source).length,
  }
  const hoveredNode = hovered ? nodes.find((n) => n.id === hovered) : undefined

  return (
    <div className="qc-brain-wrap space-y-3">
      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <BrainCircuit className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        A live map of the AI's working brain for {projectName} — every Memory fact, Knowledge doc,
        and repo Source map it draws on during QC runs and test-case generation. Click a node to
        read it.
      </p>

      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        {/* Stats strip */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border/60 bg-muted/60 px-5 py-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-2 rounded-full bg-amber-500 dark:bg-amber-400" /> {memory.length}{' '}
            memory {memory.length === 1 ? 'note' : 'notes'}
          </span>
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-2 rounded-full bg-violet-500 dark:bg-violet-400" />{' '}
            {counts.knowledge} knowledge {counts.knowledge === 1 ? 'doc' : 'docs'}
          </span>
          <span className="flex items-center gap-1.5 font-medium">
            <span className="size-2 rounded-full bg-emerald-500 dark:bg-emerald-400" />{' '}
            {counts.maps} source {counts.maps === 1 ? 'map' : 'maps'}
          </span>
          {counts.ai > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Sparkles className="size-3 text-primary" /> {counts.ai} AI-captured
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            thinking with {nodes.length} {nodes.length === 1 ? 'connection' : 'connections'}
          </span>
        </div>

        <CardContent className="relative bg-[var(--qc-surface)] p-0">
          {/* Theme palette + scoped keyframes. `.qc-frozen` pauses every CSS animation. */}
          <style>{`
            .qc-brain-wrap {
              --qc-surface: #f6f8fc;
              --qc-bg-0: #e9effb;
              --qc-bg-1: #f1f5fc;
              --qc-bg-2: #f6f8fc;
              --qc-grid: #c7d3ea;
              --qc-star: #a3b4d8;
              --qc-memory: #d97706;
              --qc-knowledge: #7c3aed;
              --qc-map: #059669;
              --qc-accent: #3279F9;
              --qc-accent-soft: #7cabfb;
              --qc-node-fill: #ffffff;
              --qc-label: #5b6b8c;
              --qc-label-active: #0f172a;
              --qc-halo: #f6f8fc;
              --qc-core-0: #ffffff;
              --qc-core-1: #e7eefc;
              --qc-core-2: #d8e5fb;
              --qc-core-ring: #3279F9;
              --qc-core-icon: #2f6ae0;
              --qc-orbit-0: #b6c6e6;
              --qc-orbit-1: #c2d0ea;
              --qc-title: #4c5d85;
              --qc-subtitle: #8b9ac0;
              --qc-hint: #5b6b8c;
              --qc-glow-opacity: 0.18;
            }
            .dark .qc-brain-wrap {
              --qc-surface: #070810;
              --qc-bg-0: #101a33;
              --qc-bg-1: #0a0f1f;
              --qc-bg-2: #070810;
              --qc-grid: #233052;
              --qc-star: #5b6b96;
              --qc-memory: #fbbf24;
              --qc-knowledge: #a78bfa;
              --qc-map: #34d399;
              --qc-accent: #3279F9;
              --qc-accent-soft: #7cabfb;
              --qc-node-fill: #111527;
              --qc-label: #9aa5c4;
              --qc-label-active: #f4f4f5;
              --qc-halo: #070810;
              --qc-core-0: #20335e;
              --qc-core-1: #101a33;
              --qc-core-2: #0a1226;
              --qc-core-ring: #3f6fd1;
              --qc-core-icon: #9dc0fc;
              --qc-orbit-0: #2b3d6b;
              --qc-orbit-1: #243257;
              --qc-title: #8fa3cf;
              --qc-subtitle: #55648c;
              --qc-hint: #8fa3cf;
              --qc-glow-opacity: 0.55;
            }
            @keyframes qcSynapse { to { stroke-dashoffset: -32; } }
            @keyframes qcNodeIn {
              from { opacity: 0; transform: scale(0.5); }
              to { opacity: 1; transform: scale(1); }
            }
            @keyframes qcBreathe {
              0%, 100% { transform: scale(1); }
              50% { transform: scale(1.05); }
            }
            @keyframes qcRing {
              0%, 100% { transform: scale(1); opacity: 0.5; }
              50% { transform: scale(1.18); opacity: 0.08; }
            }
            @keyframes qcTwinkle {
              0%, 100% { opacity: 0.15; }
              50% { opacity: 0.7; }
            }
            @keyframes qcOrbit { to { transform: rotate(360deg); } }
            @keyframes qcOrbitBack { to { transform: rotate(-360deg); } }
            @keyframes qcBlink {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.35; }
            }
            .qc-frozen * { animation-play-state: paused !important; }
            @media (prefers-reduced-motion: reduce) {
              .qc-brain-svg * { animation: none !important; }
            }
          `}</style>

          {loading ? (
            <p className="flex items-center justify-center gap-2 py-32 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Mapping the AI brain…
            </p>
          ) : nodes.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-28 text-center">
              <BrainCircuit className="size-10 text-muted-foreground/50" />
              <p className="text-sm font-medium text-foreground">The brain is empty — for now</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                Add Memory notes or upload Knowledge docs (or connect a repo to generate a source
                map) and they will appear here, wired into the AI.
              </p>
            </div>
          ) : (
            <svg
              ref={svgRef}
              viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
              className={cn('qc-brain-svg block w-full', frozen && 'qc-frozen')}
              role="img"
              aria-label={`AI brain map for ${projectName}`}
            >
              <defs>
                <radialGradient id="qc-bg-glow" cx="50%" cy="50%" r="65%">
                  <stop offset="0%" style={{ stopColor: 'var(--qc-bg-0)' }} />
                  <stop offset="55%" style={{ stopColor: 'var(--qc-bg-1)' }} />
                  <stop offset="100%" style={{ stopColor: 'var(--qc-bg-2)' }} />
                </radialGradient>
                <radialGradient id="qc-brain-glow" cx="50%" cy="50%" r="50%">
                  <stop
                    offset="0%"
                    style={{ stopColor: 'var(--qc-accent)', stopOpacity: 'var(--qc-glow-opacity)' }}
                  />
                  <stop offset="55%" style={{ stopColor: 'var(--qc-accent)', stopOpacity: 0.08 }} />
                  <stop offset="100%" style={{ stopColor: 'var(--qc-accent)', stopOpacity: 0 }} />
                </radialGradient>
                <radialGradient id="qc-core-fill" cx="38%" cy="32%" r="80%">
                  <stop offset="0%" style={{ stopColor: 'var(--qc-core-0)' }} />
                  <stop offset="60%" style={{ stopColor: 'var(--qc-core-1)' }} />
                  <stop offset="100%" style={{ stopColor: 'var(--qc-core-2)' }} />
                </radialGradient>
                <pattern id="qc-grid" width="46" height="46" patternUnits="userSpaceOnUse">
                  <circle cx="1" cy="1" r="1" style={{ fill: 'var(--qc-grid)' }} opacity="0.5" />
                </pattern>
              </defs>

              {/* Backdrop: gradient, dot grid, twinkling particles (CSS opacity). */}
              <rect width={VIEW_W} height={VIEW_H} fill="url(#qc-bg-glow)" />
              <rect width={VIEW_W} height={VIEW_H} fill="url(#qc-grid)" />
              {STARS.map((s, i) => (
                <circle
                  key={i}
                  cx={s.x}
                  cy={s.y}
                  r={s.r}
                  style={{
                    fill: 'var(--qc-star)',
                    animation: `qcTwinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
                  }}
                />
              ))}

              {/* Edges — dashed "synapses" that flow from the brain outward. A capped
                  subset carries a travelling pulse dot. Hovering a node lights its edge. */}
              {nodes.map((n) => {
                const active = hovered === n.id
                const dimmed = hovered !== null && !active
                const d = edgePath(n)
                return (
                  <g
                    key={`edge-${n.id}`}
                    opacity={dimmed ? 0.25 : 1}
                    style={{ transition: 'opacity 0.25s' }}
                  >
                    <path
                      d={d}
                      fill="none"
                      strokeWidth={active ? 2.2 : 1.2}
                      strokeOpacity={active ? 0.95 : 0.45}
                      strokeLinecap="round"
                      strokeDasharray="4 12"
                      style={{
                        stroke: EDGE_COLOR[n.kind],
                        animation: `qcSynapse ${active ? 0.8 : 2.6}s linear ${n.delay}s infinite`,
                      }}
                    />
                    {(n.pulse || active) && (
                      <circle r={active ? 4 : 2.4} style={{ fill: EDGE_COLOR[n.kind] }}>
                        <animateMotion
                          dur={`${2.6 + n.delay}s`}
                          repeatCount="indefinite"
                          path={d}
                          keyPoints="1;0"
                          keyTimes="0;1"
                          calcMode="linear"
                        />
                      </circle>
                    )}
                  </g>
                )
              })}

              {/* Brain core — static glow, CSS-breathing rings, orbiting particles, icon. */}
              <circle cx={CX} cy={CY} r={150} fill="url(#qc-brain-glow)" />
              {[62, 84].map((r, i) => (
                <g
                  key={r}
                  style={{
                    animation: `qcRing ${3.2 + i * 1.4}s ease-in-out ${i * 0.6}s infinite`,
                    transformOrigin: `${CX}px ${CY}px`,
                  }}
                >
                  <circle
                    cx={CX}
                    cy={CY}
                    r={r}
                    fill="none"
                    strokeWidth={1.2}
                    style={{ stroke: 'var(--qc-accent)' }}
                  />
                </g>
              ))}

              {/* Two counter-rotating orbits with electrons (CSS transform — cheap). */}
              <g
                style={{
                  animation: 'qcOrbit 22s linear infinite',
                  transformOrigin: `${CX}px ${CY}px`,
                }}
              >
                <circle
                  cx={CX}
                  cy={CY}
                  r={110}
                  fill="none"
                  strokeWidth={0.8}
                  strokeDasharray="2 8"
                  style={{ stroke: 'var(--qc-orbit-0)' }}
                />
                <circle cx={CX + 110} cy={CY} r={3.2} style={{ fill: 'var(--qc-accent-soft)' }} />
                <circle cx={CX - 110} cy={CY} r={2.2} style={{ fill: 'var(--qc-knowledge)' }} />
              </g>
              <g
                style={{
                  animation: 'qcOrbitBack 30s linear infinite',
                  transformOrigin: `${CX}px ${CY}px`,
                }}
              >
                <circle
                  cx={CX}
                  cy={CY}
                  r={132}
                  fill="none"
                  strokeWidth={0.8}
                  strokeDasharray="1 10"
                  style={{ stroke: 'var(--qc-orbit-1)' }}
                />
                <circle cx={CX} cy={CY - 132} r={2.6} style={{ fill: 'var(--qc-map)' }} />
                <circle cx={CX} cy={CY + 132} r={2} style={{ fill: 'var(--qc-memory)' }} />
              </g>

              <g
                style={{
                  animation: 'qcBreathe 3s ease-in-out infinite',
                  transformOrigin: `${CX}px ${CY}px`,
                }}
              >
                {/* faked glow: layered translucent circles instead of a blur filter */}
                <circle cx={CX} cy={CY} r={52} opacity={0.14} style={{ fill: 'var(--qc-accent)' }} />
                <circle
                  cx={CX}
                  cy={CY}
                  r={48.5}
                  opacity={0.18}
                  style={{ fill: 'var(--qc-accent)' }}
                />
                <circle
                  cx={CX}
                  cy={CY}
                  r={46}
                  fill="url(#qc-core-fill)"
                  strokeWidth={1.5}
                  style={{ stroke: 'var(--qc-core-ring)' }}
                />
                <BrainCircuit
                  x={CX - 23}
                  y={CY - 23}
                  width={46}
                  height={46}
                  strokeWidth={1.5}
                  style={{ stroke: 'var(--qc-core-icon)' }}
                />
              </g>
              <text
                x={CX}
                y={CY + 76}
                textAnchor="middle"
                fontSize={13}
                fontWeight={600}
                letterSpacing="0.06em"
                style={{ fill: 'var(--qc-title)' }}
              >
                AI BRAIN
              </text>
              <text
                x={CX}
                y={CY + 93}
                textAnchor="middle"
                fontSize={10.5}
                style={{ fill: 'var(--qc-subtitle)' }}
              >
                {truncateLabel(projectName, 30)}
              </text>

              {/* Nodes */}
              {nodes.map((n) => {
                const meta = KIND_META[n.kind]
                const active = hovered === n.id
                const dimmed = hovered !== null && !active
                return (
                  <g
                    key={n.id}
                    className="cursor-pointer"
                    opacity={dimmed ? 0.35 : 1}
                    style={{
                      animation: `qcNodeIn 0.5s ease-out ${n.delay}s both`,
                      transformOrigin: `${n.x}px ${n.y}px`,
                      transition: 'opacity 0.25s',
                    }}
                    onMouseEnter={() => setHovered(n.id)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => setSelected(n)}
                  >
                    {/* halo (static translucent circle — no filter) */}
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? 30 : 24}
                      opacity={active ? 0.16 : 0.08}
                      style={{ fill: EDGE_COLOR[n.kind], transition: 'all 0.2s' }}
                    />
                    <circle
                      cx={n.x}
                      cy={n.y}
                      r={active ? 21 : 17}
                      strokeWidth={active ? 2 : 1.3}
                      strokeOpacity={active ? 1 : 0.75}
                      style={{
                        fill: 'var(--qc-node-fill)',
                        stroke: EDGE_COLOR[n.kind],
                        transition: 'all 0.2s',
                      }}
                    />
                    <meta.Icon
                      x={n.x - 9}
                      y={n.y - 9}
                      width={18}
                      height={18}
                      strokeWidth={1.6}
                      style={{ stroke: EDGE_COLOR[n.kind] }}
                    />
                    {n.ai && (
                      <circle
                        cx={n.x + 14}
                        cy={n.y - 13}
                        r={4}
                        style={{
                          fill: 'var(--qc-accent)',
                          animation: 'qcBlink 1.6s ease-in-out infinite',
                        }}
                      />
                    )}
                    <text
                      x={n.x}
                      y={n.y + (n.y >= CY ? 38 : -28)}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={active ? 600 : 500}
                      strokeWidth={3}
                      paintOrder="stroke"
                      style={{
                        fill: active ? 'var(--qc-label-active)' : 'var(--qc-label)',
                        stroke: 'var(--qc-halo)',
                      }}
                    >
                      {truncateLabel(n.name)}
                    </text>
                  </g>
                )
              })}

              {/* Hover hint — the hovered note's one-line description, bottom center. */}
              {hoveredNode && (
                <text
                  x={CX}
                  y={VIEW_H - 16}
                  textAnchor="middle"
                  fontSize={11.5}
                  style={{ fill: 'var(--qc-hint)' }}
                >
                  {truncateLabel(
                    hoveredNode.description ||
                      `${KIND_META[hoveredNode.kind].label} — click to read`,
                    90,
                  )}
                </text>
              )}

              {hidden > 0 && (
                <text
                  x={VIEW_W - 16}
                  y={VIEW_H - 14}
                  textAnchor="end"
                  fontSize={11}
                  style={{ fill: 'var(--qc-subtitle)' }}
                >
                  +{hidden} more not shown — see the Knowledge / Memory tabs
                </text>
              )}
            </svg>
          )}
        </CardContent>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border/60 bg-muted/40 px-5 py-2.5 text-[11px] text-muted-foreground">
          {(Object.keys(KIND_META) as NodeKind[]).map((kind) => {
            const meta = KIND_META[kind]
            return (
              <span key={kind} className="flex items-center gap-1.5">
                <meta.Icon className={cn('size-3.5', meta.text)} />
                {meta.label}
              </span>
            )
          })}
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-[#3279F9]" /> AI-captured (blue pulse)
          </span>
          <span className="ml-auto hidden sm:inline">
            Pulses = the AI reading this context on every run
          </span>
        </div>
      </Card>

      {selected && (
        <NodePreview node={selected} projectId={projectId} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
