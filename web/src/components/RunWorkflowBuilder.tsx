import { memo, useCallback, useMemo, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  getSmoothStepPath,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  CheckCircle2,
  Compass,
  Database,
  Globe,
  KeyRound,
  ListOrdered,
  PencilLine,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Workflow,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  edgeId,
  flowEntryNodeId,
  flowEntryUrl,
  invalidStepUrls,
  MAX_WORKFLOW_STEPS,
  NODE_GAP_Y,
  NODE_HEIGHT,
  NODE_WIDTH,
  nextNodeId,
  orderedNodes,
  type StepKind,
  type WorkflowEdge,
  type WorkflowNode,
} from '@/lib/run-workflow'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

/**
 * The E2E flow (advanced) run, built as a real node GRAPH on a pannable canvas
 * (`@xyflow/react`), the way the shadcnuikit "Workflow Automation" reference works:
 * drag a card anywhere, drag from any of its four sides to another card, and the
 * connector re-routes itself. Branches are allowed — a step can fan out to two.
 *
 * What it PRODUCES is still deliberately plain, so nothing downstream moves: the
 * graph is walked into the run's ordered `workflowSteps` strings by `orderedNodes`
 * (see lib/run-workflow.ts). There is no server change, and no ticket — an
 * end-to-end flow is a path through the product, not a check against one ticket.
 */

const STEP_LIBRARY: {
  step: StepKind
  name: string
  hint: string
  icon: typeof Compass
  tone: string
  seed: string
}[] = [
  {
    step: 'navigate',
    name: 'Navigate',
    hint: 'Open a screen',
    icon: Compass,
    tone: 'bg-sky-500 text-white',
    seed: 'Open the app and go to ',
  },
  {
    step: 'auth',
    name: 'Sign in',
    hint: 'Authenticate as a user',
    icon: KeyRound,
    tone: 'bg-violet-500 text-white',
    seed: 'Sign in as ',
  },
  {
    step: 'form',
    name: 'Fill & submit',
    hint: 'Enter data, submit',
    icon: PencilLine,
    tone: 'bg-amber-500 text-white',
    seed: 'Fill in ',
  },
  {
    step: 'verify',
    name: 'Verify',
    hint: 'Check what is on screen',
    icon: CheckCircle2,
    tone: 'bg-emerald-500 text-white',
    seed: 'Verify that ',
  },
  {
    step: 'data',
    name: 'Check data',
    hint: 'Record, list or API result',
    icon: Database,
    tone: 'bg-cyan-600 text-white',
    seed: 'Check that the record ',
  },
  {
    step: 'custom',
    name: 'Custom step',
    hint: 'Anything else',
    icon: Sparkles,
    tone: 'bg-foreground text-background',
    seed: '',
  },
]

const stepMeta = (step?: StepKind) =>
  STEP_LIBRARY.find((s) => s.step === step) ?? STEP_LIBRARY[STEP_LIBRARY.length - 1]

/** The drag payload a library item hands the canvas. */
const DND_TYPE = 'application/qc-step'

// ── the card React Flow renders for a step ──────────────────────────────────

type StepNodeData = {
  step: StepKind
  title?: string
  url?: string
  expected?: string
  order: number
  entry: boolean
}

/**
 * All four sides carry ONE handle each, and the canvas runs in
 * `ConnectionMode.Loose` — so a side is both a source and a target and the
 * engineer can pull a line out of, or into, any edge of a card. Two stacked
 * handles per side (one of each type) would sit on top of each other and make
 * which one you grabbed a coin toss.
 */
const SIDES: { id: string; position: Position; className: string }[] = [
  { id: 'top', position: Position.Top, className: '!top-[-5px]' },
  { id: 'right', position: Position.Right, className: '!right-[-5px]' },
  { id: 'bottom', position: Position.Bottom, className: '!bottom-[-5px]' },
  { id: 'left', position: Position.Left, className: '!left-[-5px]' },
]

const StepNode = memo(function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const meta = stepMeta(data.step)
  const Icon = meta.icon
  const title = (data.title || '').trim() || 'Untitled step'
  const subtitle = (data.expected || '').trim() || meta.name
  const url = (data.url || '').trim()

  return (
    <div
      style={{ width: NODE_WIDTH }}
      className={cn(
        'rounded-2xl border bg-card px-3 py-2.5 text-left shadow-none transition-colors',
        selected ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border/60 hover:border-border',
      )}
    >
      {SIDES.map((s) => (
        <Handle
          key={s.id}
          id={s.id}
          type="source"
          position={s.position}
          className={cn(
            '!size-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground/50 transition-colors hover:!bg-primary',
            s.className,
          )}
        />
      ))}

      <div className="flex items-center gap-2.5">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl', meta.tone)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-medium leading-tight">{title}</span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-muted-foreground">
              {data.order}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
          {url && (
            <p className="mt-1 flex min-w-0 items-center gap-1">
              <Globe className="size-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[10px] text-muted-foreground">{url}</span>
              {data.entry && (
                <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600">
                  Start
                </span>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  )
})

const nodeTypes = { step: StepNode }

// ── the connector between two steps ─────────────────────────────────────────

type StepEdgeData = {
  /** hovered/selected — the line lights up and offers its × */
  active: boolean
  onDelete: (id: string) => void
}

/**
 * A connection carries its own REMOVE control, because a line is easy to draw by
 * accident and the keyboard alone is not a discoverable way to take one back:
 * the × sits at the midpoint whenever the edge is hovered or selected. Delete /
 * Backspace still work — see `handleEdgesChange`, which has to keep the
 * selection for that to be possible at all in a controlled graph.
 */
const StepEdge = memo(function StepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps<Edge<StepEdgeData>>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
  })
  const active = !!selected || !!data?.active

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: active ? 'var(--color-primary)' : style?.stroke,
          strokeWidth: active ? 2 : 1.5,
        }}
      />
      {active && (
        <EdgeLabelRenderer>
          <button
            type="button"
            // `nodrag nopan` or the click pans the canvas instead of hitting the
            // button; `pointerEvents` because the label layer is inert by default.
            className="nodrag nopan absolute grid size-5 place-items-center rounded-full border border-border/60 bg-card text-muted-foreground shadow-sm transition-colors hover:border-destructive/60 hover:bg-destructive hover:text-white"
            style={{
              pointerEvents: 'all',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            aria-label="Remove this connection"
            title="Remove this connection"
            onClick={(e) => {
              e.stopPropagation()
              data?.onDelete(id)
            }}
          >
            <X className="size-3" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const edgeTypes = { step: StepEdge }

/** A library row — the reference's icon chip + name + subtitle. Draggable. */
function LibraryItem({
  icon: Icon,
  tone,
  name,
  hint,
  disabled,
  onAdd,
  step,
}: {
  icon: typeof Compass
  tone: string
  name: string
  hint: string
  disabled?: boolean
  onAdd: () => void
  step: StepKind
}) {
  return (
    <button
      type="button"
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_TYPE, step)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={onAdd}
      disabled={disabled}
      className={cn(
        'group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-all duration-200',
        disabled
          ? 'cursor-not-allowed opacity-45'
          : 'cursor-grab hover:bg-muted/70 active:cursor-grabbing active:scale-[0.98]',
      )}
    >
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-xl', tone)}>
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{hint}</span>
      </span>
      {!disabled && (
        <Plus className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </button>
  )
}

// ── the canvas ──────────────────────────────────────────────────────────────

type CanvasProps = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  order: Map<string, number>
  entryId: string | null
  selectedId: string | null
  disabled?: boolean
  onSelect: (id: string | null) => void
  onNodesChange: (next: WorkflowNode[]) => void
  onEdgesChange: (next: WorkflowEdge[]) => void
}

function Canvas({
  nodes,
  edges,
  order,
  entryId,
  selectedId,
  disabled,
  onSelect,
  onNodesChange,
  onEdgesChange,
}: CanvasProps) {
  const { screenToFlowPosition, getInternalNode } = useReactFlow()
  const { theme } = useTheme()

  // React Flow's own shapes are derived every render from the props above —
  // the graph has ONE source of truth, in RunPage. A second copy inside
  // useNodesState is how the canvas and the submitted run drift apart.
  //
  // `measured` is carried over from React Flow's own store on every rebuild.
  // A drag re-renders this component per pointer move (position → RunPage →
  // back down), and a node arriving without measurements is treated as not yet
  // initialized: it logs "trying to drag a node that is not initialized" on
  // every move and the card stutters. Reading it back is what keeps a fully
  // controlled graph smooth.
  const rfNodes = useMemo<Node<StepNodeData>[]>(() => {
    const next = nodes.map((n) => ({
      measured: getInternalNode(n.id)?.measured,
      id: n.id,
      type: 'step',
      position: { x: n.x, y: n.y },
      selected: n.id === selectedId,
      draggable: !disabled,
      data: {
        step: n.step,
        title: n.title,
        url: n.url,
        expected: n.expected,
        order: order.get(n.id) ?? 0,
        entry: n.id === entryId,
      },
    }))
    return next
  }, [nodes, selectedId, disabled, order, entryId, getInternalNode])

  // Which connection is selected/hovered. Selection is LOCAL because it is
  // pure canvas state — but it has to be held somewhere: React Flow reads
  // `selected` off the edge object we hand it, so ignoring its `select`
  // changes (as this did) left every edge permanently unselected and the
  // Delete key with nothing to remove.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)

  const removeEdgeById = useCallback(
    (id: string) => {
      onEdgesChange(edges.filter((e) => e.id !== id))
      setSelectedEdgeId((cur) => (cur === id ? null : cur))
      setHoveredEdgeId((cur) => (cur === id ? null : cur))
    },
    [edges, onEdgesChange],
  )

  const rfEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        ...e,
        type: 'step',
        animated: true,
        selected: e.id === selectedEdgeId,
        data: {
          active: !disabled && (e.id === selectedEdgeId || e.id === hoveredEdgeId),
          onDelete: removeEdgeById,
        },
        // Painted from the token here rather than through a CSS class: React
        // Flow's own stylesheet sets `.react-flow__edge-path` stroke, and a
        // Tailwind utility loses to it on specificity — the line came out the
        // library's near-invisible default grey on our surface.
        style: { stroke: 'var(--color-muted-foreground)', strokeWidth: 1.5 },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: 'var(--color-muted-foreground)',
        },
      })),
    [edges, selectedEdgeId, hoveredEdgeId, disabled, removeEdgeById],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<StepNodeData>>[]) => {
      let next = nodes
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          next = next.map((n) => (n.id === c.id ? { ...n, x: c.position!.x, y: c.position!.y } : n))
        } else if (c.type === 'remove') {
          next = next.filter((n) => n.id !== c.id)
          onEdgesChange(edges.filter((e) => e.source !== c.id && e.target !== c.id))
          if (selectedId === c.id) onSelect(null)
        }
      }
      if (next !== nodes) onNodesChange(next)
    },
    [nodes, edges, selectedId, onNodesChange, onEdgesChange, onSelect],
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      for (const c of changes) {
        // Selecting is what makes Delete/Backspace able to remove a connection,
        // so this branch is load-bearing, not cosmetic.
        if (c.type === 'select') setSelectedEdgeId((cur) => (c.selected ? c.id : cur === c.id ? null : cur))
      }
      const removed = new Set(changes.filter((c) => c.type === 'remove').map((c) => c.id))
      if (removed.size) {
        onEdgesChange(edges.filter((e) => !removed.has(e.id)))
        setSelectedEdgeId((cur) => (cur && removed.has(cur) ? null : cur))
        setHoveredEdgeId((cur) => (cur && removed.has(cur) ? null : cur))
      }
    },
    [edges, onEdgesChange],
  )

  const onConnect = useCallback(
    (c: Connection) => {
      if (c.source === c.target) return // a step can't follow itself
      const next = addEdge(
        { ...c, id: edgeId(c.source, c.target) },
        edges.map((e) => ({ ...e }) as Edge),
      )
      onEdgesChange(
        next.map<WorkflowEdge>((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        })),
      )
    },
    [edges, onEdgesChange],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const step = e.dataTransfer.getData(DND_TYPE) as StepKind
      if (!step || disabled || nodes.length >= MAX_WORKFLOW_STEPS) return
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const node: WorkflowNode = {
        id: nextNodeId(),
        step,
        title: stepMeta(step).seed,
        // Dropped where the cursor is, not where the card's corner would land.
        x: at.x - NODE_WIDTH / 2,
        y: at.y - NODE_HEIGHT / 2,
      }
      onNodesChange([...nodes, node])
      onSelect(node.id)
    },
    [disabled, nodes, screenToFlowPosition, onNodesChange, onSelect],
  )

  return (
    <div
      className="h-[38rem] w-full"
      onDrop={onDrop}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={theme}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_, n) => {
          onSelect(n.id)
          setSelectedEdgeId(null)
        }}
        // A card and a line are never selected at once, or Delete takes both —
        // verified: with a step still selected, deleting a connection removed
        // the card with it.
        onEdgeClick={(_, e) => {
          onSelect(null)
          setSelectedEdgeId(e.id)
        }}
        onEdgeMouseEnter={(_, e) => setHoveredEdgeId(e.id)}
        onEdgeMouseLeave={() => setHoveredEdgeId(null)}
        onPaneClick={() => {
          onSelect(null)
          setSelectedEdgeId(null)
        }}
        edgesFocusable={!disabled}
        nodesConnectable={!disabled}
        nodesDraggable={!disabled}
        elementsSelectable={!disabled}
        deleteKeyCode={disabled ? null : ['Backspace', 'Delete']}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        {/* React Flow paints its controls with hard-coded near-white fills, so
            they stay light-on-light in dark mode — repainted from the tokens. */}
        <Controls
          showInteractive={false}
          className="!rounded-xl !border !border-border/60 !shadow-none [&_button]:!border-border/60 [&_button]:!bg-card [&_button]:!fill-foreground [&_button:hover]:!bg-muted"
        />
      </ReactFlow>
    </div>
  )
}

// ── the builder (library | canvas | inspector) ──────────────────────────────

export function RunWorkflowBuilder({
  nodes,
  edges,
  onChange,
  onEdgesChange,
  flowName,
  onFlowNameChange,
  disabled,
  urls = true,
}: {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
  onChange: (next: WorkflowNode[]) => void
  onEdgesChange: (next: WorkflowEdge[]) => void
  /** Names the run — its report is filed under this name's slug. */
  flowName: string
  onFlowNameChange: (next: string) => void
  disabled?: boolean
  /**
   * Whether a step can carry a URL. Off for the app-on-device target, which
   * launches an installed app instead of opening an address.
   */
  urls?: boolean
}) {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // The selection is derived, never mirrored into state — a node removed elsewhere
  // simply stops being found, and the inspector closes.
  const selected = nodes.find((n) => n.id === selectedId) ?? null

  const q = query.trim().toLowerCase()
  const librarySteps = useMemo(
    () =>
      q
        ? STEP_LIBRARY.filter(
            (s) => s.name.toLowerCase().includes(q) || s.hint.toLowerCase().includes(q),
          )
        : STEP_LIBRARY,
    [q],
  )
  const full = nodes.length >= MAX_WORKFLOW_STEPS

  // Run order (and with it the step numbers on the cards) is a walk of the
  // graph, not the order the cards were created in.
  const ordered = useMemo(() => orderedNodes(nodes, edges), [nodes, edges])
  const order = useMemo(
    () => new Map(ordered.map((n, i) => [n.id, i + 1])),
    [ordered],
  )
  const entryUrl = urls ? flowEntryUrl(nodes, edges) : ''
  const entryId = urls ? flowEntryNodeId(nodes, edges) : null
  const badUrls = urls ? invalidStepUrls(nodes) : []
  const selectedUrlInvalid = !!selected && badUrls.some((n) => n.id === selected.id)

  /**
   * Clicking a library row appends the step below the last one in RUN order and
   * wires it up, so the quick path still builds a straight chain; dragging is
   * what places a card freely (and leaves it unconnected until you draw a line).
   */
  function addStep(step: StepKind) {
    if (disabled || full) return
    const last = ordered[ordered.length - 1]
    const node: WorkflowNode = {
      id: nextNodeId(),
      step,
      title: stepMeta(step).seed,
      x: last ? last.x : 0,
      y: last ? last.y + NODE_HEIGHT + NODE_GAP_Y : 0,
    }
    onChange([...nodes, node])
    if (last) {
      onEdgesChange([
        ...edges,
        {
          id: edgeId(last.id, node.id),
          source: last.id,
          target: node.id,
          sourceHandle: 'bottom',
          targetHandle: 'top',
        },
      ])
    }
    setSelectedId(node.id)
  }

  function update(id: string, patch: Partial<WorkflowNode>) {
    onChange(nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)))
  }

  function remove(id: string) {
    onChange(nodes.filter((n) => n.id !== id))
    onEdgesChange(edges.filter((e) => e.source !== id && e.target !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const selectedIndex = selected ? (order.get(selected.id) ?? 0) : 0

  return (
    // Container queries, NOT viewport ones: this sits inside the run form, so a wide
    // window says nothing about how much room the three panes actually have.
    <div className="@container overflow-hidden rounded-2xl border border-border/60 bg-card">
      <div className="grid @2xl:grid-cols-[16rem_minmax(0,1fr)]">
        {/* ── Node library ─────────────────────────────────────────────── */}
        <div className="border-b border-border/60 @2xl:border-b-0 @2xl:border-r">
          <div className="space-y-2.5 p-3">
            <div className="flex items-center gap-1.5">
              <Workflow className="size-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold tracking-tight">Node library</span>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                disabled={disabled}
                placeholder="Search nodes…"
                className="h-9 rounded-full pl-8 text-sm shadow-none"
              />
            </div>
          </div>

          <div className="px-2 pb-3">
            <div className="flex items-center justify-between px-2 pb-1 pt-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Steps
              </span>
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {nodes.length}/{MAX_WORKFLOW_STEPS}
              </span>
            </div>
            {librarySteps.length === 0 ? (
              <p className="px-2 pb-2 text-xs text-muted-foreground">No node matches “{query}”.</p>
            ) : (
              librarySteps.map((s) => (
                <LibraryItem
                  key={s.step}
                  step={s.step}
                  icon={s.icon}
                  tone={s.tone}
                  name={s.name}
                  hint={s.hint}
                  disabled={disabled || full}
                  onAdd={() => addStep(s.step)}
                />
              ))
            )}
            <p className="px-2 pt-2 text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">Drag</span> a node onto the canvas to
              place it anywhere, or click to chain it after the last step. Pull a line from any side
              of a card to the next one — hover a line and click its{' '}
              <span className="font-medium text-foreground">×</span> to remove it. Delete also
              removes whatever card or line is selected.
            </p>
          </div>
        </div>

        {/* ── Canvas ───────────────────────────────────────────────────── */}
        <div className="min-w-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
            <Input
              value={flowName}
              onChange={(e) => onFlowNameChange(e.target.value)}
              disabled={disabled}
              aria-label="Flow name"
              placeholder="Name this flow — e.g. Checkout to invoice"
              className="h-8 min-w-0 max-w-xs flex-1 border-transparent bg-muted/60 text-sm font-medium shadow-none focus-visible:border-input"
            />
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ListOrdered className="size-3.5" />
              {nodes.length} step{nodes.length === 1 ? '' : 's'}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || nodes.length === 0}
              onClick={() => {
                onChange([])
                onEdgesChange([])
                setSelectedId(null)
              }}
              className="ml-auto h-7 gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Clear canvas
            </Button>
          </div>

          {/* Where the run opens. The App URL lives on the steps now, so this line
              is the only place the flow's entry point is visible at a glance. */}
          {urls && nodes.length > 0 && (
            <div className="flex min-w-0 items-center gap-1.5 border-b border-border/60 bg-muted/30 px-3 py-1.5 text-[11px]">
              {badUrls.length > 0 ? (
                <>
                  <TriangleAlert className="size-3.5 shrink-0 text-destructive" />
                  <span className="font-medium text-destructive">
                    {badUrls.length} step{badUrls.length === 1 ? '' : 's'} have an invalid URL — use
                    a full http:// or https:// address.
                  </span>
                </>
              ) : entryUrl ? (
                <>
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="shrink-0 text-muted-foreground">Starts at</span>
                  <span className="truncate font-mono font-medium">{entryUrl}</span>
                </>
              ) : (
                <>
                  <Globe className="size-3.5 shrink-0 text-amber-600" />
                  <span className="text-amber-600">
                    No step has an App URL yet — set one on the step that opens the app.
                  </span>
                </>
              )}
            </div>
          )}

          {nodes.length === 0 ? (
            <div className="flex h-[38rem] flex-col items-center justify-center gap-2 bg-[radial-gradient(circle,var(--color-border)_1px,transparent_1px)] bg-[length:16px_16px] p-6 text-center">
              <span className="grid size-11 place-items-center rounded-2xl bg-foreground text-background">
                <Workflow className="size-5" />
              </span>
              <p className="text-sm font-medium">Build the end-to-end flow</p>
              <p className="max-w-[28rem] text-xs leading-relaxed text-muted-foreground">
                Drag steps from the library onto the canvas and join them up — sign in, navigate,
                fill a form, verify what comes back. They run in order as{' '}
                <span className="font-medium text-foreground">one</span> QC session with a single
                report.
                {urls && ' Each step carries its own App URL — the first one is where the run opens.'}
              </p>
            </div>
          ) : (
            <ReactFlowProvider>
              <Canvas
                nodes={nodes}
                edges={edges}
                order={order}
                entryId={entryId}
                selectedId={selectedId}
                disabled={disabled}
                onSelect={setSelectedId}
                onNodesChange={onChange}
                onEdgesChange={onEdgesChange}
              />
            </ReactFlowProvider>
          )}
        </div>

      </div>

      {/* ── Inspector ──────────────────────────────────────────────────────
          A full-width strip UNDER the canvas rather than a third column: the
          canvas is what needs the pixels, and the step's own fields lay out
          perfectly well side by side. */}
      <div className="min-w-0 border-t border-border/60">
        {!selected ? (
          <div className="flex items-center justify-center gap-1.5 p-4 text-center">
            <Sparkles className="size-3.5 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">Select a step to set it up.</p>
          </div>
        ) : (
          <div className="space-y-3 p-3">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  'grid size-8 shrink-0 place-items-center rounded-xl',
                  stepMeta(selected.step).tone,
                )}
              >
                {(() => {
                  const Icon = stepMeta(selected.step).icon
                  return <Icon className="size-4" />
                })()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  Step {selectedIndex} · {stepMeta(selected.step).name}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {stepMeta(selected.step).hint}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => remove(selected.id)}
                className="shrink-0 gap-1.5 rounded-full text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
                Remove step
              </Button>
            </div>

            <div className="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_17rem]">
              <div className="space-y-1.5">
                <Label htmlFor="wf-step-title" className="text-xs">
                  What Claude does
                </Label>
                <Textarea
                  id="wf-step-title"
                  value={selected.title ?? ''}
                  onChange={(e) => update(selected.id, { title: e.target.value })}
                  disabled={disabled}
                  rows={3}
                  placeholder="e.g. Sign up with a new email address"
                  className="resize-y text-sm shadow-none"
                />
              </div>

              <div className="space-y-3">
                {urls && (
                  <div className="space-y-1.5">
                    <Label htmlFor="wf-step-url" className="flex items-center gap-1.5 text-xs">
                      <Globe className="size-3.5 text-muted-foreground" />
                      App URL <span className="text-muted-foreground">· optional</span>
                    </Label>
                    <Input
                      id="wf-step-url"
                      type="url"
                      value={selected.url ?? ''}
                      onChange={(e) => update(selected.id, { url: e.target.value })}
                      disabled={disabled}
                      aria-invalid={selectedUrlInvalid}
                      placeholder="https://staging.example.com/page"
                      className="h-9 font-mono text-xs shadow-none"
                    />
                    {selectedUrlInvalid ? (
                      <p className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                        <TriangleAlert className="size-3.5" />
                        Enter a full http:// or https:// URL.
                      </p>
                    ) : (
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        {selected.id === entryId
                          ? 'The run opens here — this is the flow’s starting page.'
                          : 'Set it when this step moves to a different page. The first step with a URL is where the run starts.'}
                      </p>
                    )}
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="wf-step-expected" className="text-xs">
                    Expected result <span className="text-muted-foreground">· optional</span>
                  </Label>
                  <Textarea
                    id="wf-step-expected"
                    value={selected.expected ?? ''}
                    onChange={(e) => update(selected.id, { expected: e.target.value })}
                    disabled={disabled}
                    rows={2}
                    placeholder="e.g. the confirmation email arrives and the account is active"
                    className="resize-y text-sm shadow-none"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Step type</Label>
                <div className="grid grid-cols-3 gap-1">
                  {STEP_LIBRARY.map((s) => {
                    const active = stepMeta(selected.step).step === s.step
                    return (
                      <button
                        key={s.step}
                        type="button"
                        disabled={disabled}
                        onClick={() => update(selected.id, { step: s.step })}
                        aria-pressed={active}
                        className={cn(
                          'flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-center transition-all duration-200 active:scale-[0.98]',
                          active
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/60 bg-muted/40 hover:border-border hover:bg-muted/70',
                        )}
                      >
                        <s.icon className="size-3.5 text-muted-foreground" />
                        <span className="text-[10px] font-medium leading-tight">{s.name}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
