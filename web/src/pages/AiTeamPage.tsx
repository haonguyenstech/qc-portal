import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  Crown,
  Loader2,
  Network,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useProjects } from '@/lib/project-context'
import { useTheme } from '@/lib/theme'
import {
  getAiTeam,
  resetAiTeam,
  saveAiTeam,
  type AiTeam,
  type ApprovalAction,
  type BotAutonomy,
  type BotModel,
  type BotRole,
  type TeamBot,
  type TeamLink,
  type TeamLinkKind,
} from '@/lib/api'
import {
  APPROVALS,
  AUTONOMY,
  CAPABILITIES,
  CAPABILITY_ORDER,
  LINK_KINDS,
  LINK_ORDER,
  MODELS,
  ROLES,
  ROLE_ORDER,
  botSlug,
  RESERVED_HANDLES,
  formatTokens,
  newBot,
  relationsOf,
  teamWarnings,
  type TeamWarning,
} from '@/lib/aiTeam'

/**
 * AI Team — the project's squad of QC bots and how they are organised: who coordinates,
 * who verifies whose findings, who hands work to whom. This page manages the TEAM only;
 * the bots run in /chat once `@team-ai` brings them in (see docs/architecture/ai-team.md).
 *
 * The team is edited locally and saved whole, debounced, to `testing/ai-team/team.json`.
 * A drag only moves the card on screen; the position is saved when the drag ENDS, so a
 * drag is one write, not sixty.
 */

const SAVE_DELAY_MS = 600
const NODE_WIDTH = 232

type Selection = { kind: 'bot'; id: string } | { kind: 'link'; id: string } | null

// ── canvas: bot card ─────────────────────────────────────────────────────────

type BotNodeData = {
  bot: TeamBot
  coordinator: boolean
  issues: number
}

const SIDES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
]

const BotNode = memo(function BotNode({ data, selected }: NodeProps<Node<BotNodeData>>) {
  const { bot, coordinator, issues } = data
  const role = ROLES[bot.role]
  const Icon = role.icon
  return (
    <div
      style={{ width: NODE_WIDTH }}
      className={cn(
        'relative rounded-2xl border bg-card px-3 py-2.5 text-left shadow-none transition-colors',
        selected ? 'border-primary/60 ring-2 ring-primary/30' : 'border-border/60 hover:border-border',
        !bot.enabled && 'opacity-50',
      )}
    >
      {SIDES.map((s) => (
        <Handle
          key={s.id}
          id={s.id}
          type="source"
          position={s.position}
          className="!size-2.5 !rounded-full !border-2 !border-background !bg-muted-foreground/50 transition-colors hover:!bg-primary"
        />
      ))}
      {coordinator && (
        <span className="absolute -top-2.5 left-3 inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-background">
          <Crown className="size-2.5" /> Coordinator
        </span>
      )}
      <div className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-10 shrink-0 place-items-center rounded-xl',
            coordinator ? 'bg-foreground text-background' : 'border border-border/60 bg-muted/60 text-foreground',
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-sm font-semibold leading-tight tracking-tight">{bot.name}</span>
            {issues > 0 && (
              <AlertTriangle className="size-3 shrink-0 text-amber-500" aria-label={`${issues} issue(s)`} />
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">@{bot.id}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1">
        <Pill>{role.label}</Pill>
        <Pill>{MODELS[bot.model].label}</Pill>
        <Pill>{AUTONOMY[bot.autonomy].label}</Pill>
        {bot.maxParallel > 1 && <Pill>×{bot.maxParallel}</Pill>}
        {!bot.enabled && <Pill>Off</Pill>}
      </div>
    </div>
  )
})

function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'rounded-full border border-border/60 bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </span>
  )
}

const nodeTypes = { bot: BotNode }

// ── canvas: relation line ────────────────────────────────────────────────────

type LinkEdgeData = { link: TeamLink; active: boolean }

const LinkEdge = memo(function LinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps<Edge<LinkEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })
  if (!data) return null
  const meta = LINK_KINDS[data.link.kind]
  const active = !!selected || data.active
  const marker = `ai-team-arrow-${data.link.kind}`
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${marker})`}
        style={{
          stroke: meta.stroke,
          strokeWidth: active ? 2.5 : 1.5,
          strokeDasharray: meta.dash,
          opacity: active ? 1 : 0.75,
        }}
      />
      {active && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan pointer-events-none absolute rounded-full border border-border/60 bg-card px-2 py-0.5 text-[10px] font-medium"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {meta.label}
            {data.link.note ? ` · ${data.link.note}` : ''}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  )
})

const edgeTypes = { link: LinkEdge }

/** One arrowhead per relation colour — React Flow's built-in marker can't read a CSS var. */
function ArrowMarkers() {
  return (
    <svg className="absolute size-0" aria-hidden>
      <defs>
        {LINK_ORDER.map((kind) => (
          <marker
            key={kind}
            id={`ai-team-arrow-${kind}`}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" style={{ fill: LINK_KINDS[kind].stroke }} />
          </marker>
        ))}
      </defs>
    </svg>
  )
}

/**
 * Which side of each card a line leaves and enters. Without this every line starts at
 * the first handle (the top), so a lead's four reports all fan out of its head and the
 * chart reads as a tangle. Vertical wins unless the two cards sit roughly side by side.
 */
function facingHandles(team: AiTeam, link: TeamLink): { sourceHandle: string; targetHandle: string } {
  const a = team.bots.find((b) => b.id === link.from)?.position
  const b = team.bots.find((x) => x.id === link.to)?.position
  if (!a || !b) return { sourceHandle: 'bottom', targetHandle: 'top' }
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dy) > 90) return dy > 0 ? { sourceHandle: 'bottom', targetHandle: 'top' } : { sourceHandle: 'top', targetHandle: 'bottom' }
  return dx > 0 ? { sourceHandle: 'right', targetHandle: 'left' } : { sourceHandle: 'left', targetHandle: 'right' }
}

function TeamCanvas({
  team,
  selection,
  warnings,
  onSelect,
  onMove,
  onMoveEnd,
  onConnect,
}: {
  team: AiTeam
  selection: Selection
  warnings: TeamWarning[]
  onSelect: (s: Selection) => void
  onMove: (id: string, position: { x: number; y: number }) => void
  onMoveEnd: () => void
  onConnect: (from: string, to: string) => void
}) {
  const { theme } = useTheme()
  const [hovered, setHovered] = useState<string | null>(null)

  const nodes = useMemo<Node<BotNodeData>[]>(
    () =>
      team.bots.map((bot) => ({
        id: bot.id,
        type: 'bot',
        position: bot.position,
        selected: selection?.kind === 'bot' && selection.id === bot.id,
        data: {
          bot,
          coordinator: team.coordinatorId === bot.id,
          issues: warnings.filter((w) => w.botId === bot.id).length,
        },
      })),
    [team.bots, team.coordinatorId, selection, warnings],
  )

  const edges = useMemo<Edge<LinkEdgeData>[]>(
    () =>
      team.links.map((link) => ({
        id: link.id,
        source: link.from,
        target: link.to,
        ...facingHandles(team, link),
        type: 'link',
        selected: selection?.kind === 'link' && selection.id === link.id,
        // Only the chain of command moves: it is the relation that carries work.
        animated: !!LINK_KINDS[link.kind].animated,
        data: { link, active: hovered === link.id },
      })),
    [team, selection, hovered],
  )

  const handleNodesChange = useCallback(
    (changes: NodeChange<Node<BotNodeData>>[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) onMove(c.id, c.position)
      }
    },
    [onMove],
  )

  return (
    <div className="relative h-[40rem] w-full">
      <ArrowMarkers />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={theme}
        connectionMode={ConnectionMode.Loose}
        onNodesChange={handleNodesChange}
        onNodeDragStop={onMoveEnd}
        onConnect={(c: Connection) => c.source && c.target && onConnect(c.source, c.target)}
        onNodeClick={(_, n) => onSelect({ kind: 'bot', id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: 'link', id: e.id })}
        onEdgeMouseEnter={(_, e) => setHovered(e.id)}
        onEdgeMouseLeave={() => setHovered(null)}
        onPaneClick={() => onSelect(null)}
        // Deleting is done from the inspector, where it names what goes. A stray
        // Backspace on the canvas taking a bot and all its relations is too easy.
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls
          showInteractive={false}
          className="!rounded-xl !border !border-border/60 !shadow-none [&_button]:!border-border/60 [&_button]:!bg-card [&_button]:!fill-foreground [&_button:hover]:!bg-muted"
        />
      </ReactFlow>
      <div className="pointer-events-none absolute bottom-3 right-3 flex flex-col gap-1 rounded-2xl border border-border/60 bg-card/90 px-3 py-2 backdrop-blur">
        {LINK_ORDER.map((kind) => (
          <div key={kind} className="flex items-center gap-2 text-[11px]">
            <svg width="26" height="6" aria-hidden>
              <line
                x1="0"
                y1="3"
                x2="26"
                y2="3"
                style={{ stroke: LINK_KINDS[kind].stroke }}
                strokeWidth="2"
                strokeDasharray={LINK_KINDS[kind].dash}
              />
            </svg>
            <span className="text-muted-foreground">{LINK_KINDS[kind].label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── inspector pieces ─────────────────────────────────────────────────────────

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <div className="space-y-2">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string; hint?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-full border border-border/60 bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.hint}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 rounded-full px-2 py-1 text-xs transition-colors',
            value === o.value ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function BotChip({ bot }: { bot: TeamBot | undefined }) {
  if (!bot) return <span className="text-xs text-muted-foreground">missing bot</span>
  const Icon = ROLES[bot.role].icon
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate text-xs font-medium">{bot.name}</span>
    </span>
  )
}

function BotInspector({
  team,
  bot,
  warnings,
  onChange,
  onRename,
  onMakeCoordinator,
  onSelect,
  onRemoveLink,
  onDelete,
}: {
  team: AiTeam
  bot: TeamBot
  warnings: TeamWarning[]
  onChange: (patch: Partial<TeamBot>) => void
  onRename: (nextId: string) => void
  onMakeCoordinator: () => void
  onSelect: (s: Selection) => void
  onRemoveLink: (id: string) => void
  onDelete: () => void
}) {
  // The inspector is keyed by bot id, so a rename or a new selection remounts this.
  const [handle, setHandle] = useState(bot.id)
  const { outgoing, incoming } = relationsOf(team, bot.id)
  const isCoordinator = team.coordinatorId === bot.id
  const role = ROLES[bot.role]
  const commitHandle = () => {
    const next = botSlug(handle)
    if (!next || next === bot.id) return setHandle(bot.id)
    if (RESERVED_HANDLES.has(next)) {
      toast.error(`@${next} is reserved in team chat`, {
        description: next === 'human' ? 'Bots use @human to ask you something.' : '@team-ai brings the whole team into a chat.',
      })
      return setHandle(bot.id)
    }
    if (team.bots.some((b) => b.id === next)) {
      toast.error(`@${next} is already taken`)
      return setHandle(bot.id)
    }
    onRename(next)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-2xl',
            isCoordinator ? 'bg-foreground text-background' : 'border border-border/60 bg-muted/60',
          )}
        >
          <role.icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <Input
            value={bot.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className="h-8 rounded-xl text-sm font-semibold"
            aria-label="Bot name"
          />
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs text-muted-foreground">@</span>
            <Input
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
              onBlur={commitHandle}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              className="h-7 rounded-xl font-mono text-xs"
              aria-label="Handle"
            />
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="space-y-1 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-2.5">
          {warnings.map((w) => (
            <p key={w.text} className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w.text}
            </p>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {isCoordinator ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">
            <Crown className="size-3.5" /> Coordinates the team
          </span>
        ) : (
          <Button size="sm" variant="outline" onClick={onMakeCoordinator} disabled={!bot.enabled}>
            <Crown className="size-3.5" /> Make coordinator
          </Button>
        )}
        <label className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3 py-1 text-xs">
          <Checkbox size="sm" checked={bot.enabled} onCheckedChange={(v) => onChange({ enabled: v })} />
          Active
        </label>
      </div>

      <Section title="Role" hint={role.blurb}>
        <div className="grid grid-cols-4 gap-1">
          {ROLE_ORDER.map((r) => {
            const Icon = ROLES[r].icon
            return (
              <button
                key={r}
                type="button"
                title={ROLES[r].blurb}
                onClick={() => onChange({ role: r })}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-xl border px-1 py-1.5 text-[10px] transition-colors',
                  bot.role === r
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {ROLES[r].label}
              </button>
            )
          })}
        </div>
      </Section>

      <Section title="Mission">
        <Textarea
          value={bot.mission}
          onChange={(e) => onChange({ mission: e.target.value })}
          rows={2}
          className="min-h-0 resize-none rounded-xl text-xs"
          placeholder="One line: what this bot is for"
        />
      </Section>

      <Section title="Model" hint={MODELS[bot.model].hint}>
        <Segmented<BotModel>
          value={bot.model}
          onChange={(model) => onChange({ model })}
          options={(Object.keys(MODELS) as BotModel[]).map((m) => ({ value: m, label: MODELS[m].label, hint: MODELS[m].hint }))}
        />
      </Section>

      <Section title="Autonomy" hint={AUTONOMY[bot.autonomy].hint}>
        <Segmented<BotAutonomy>
          value={bot.autonomy}
          onChange={(autonomy) => onChange({ autonomy })}
          options={(Object.keys(AUTONOMY) as BotAutonomy[]).map((a) => ({ value: a, label: AUTONOMY[a].label, hint: AUTONOMY[a].hint }))}
        />
      </Section>

      <Section title="Can do">
        <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {CAPABILITY_ORDER.map((c) => {
            const on = bot.capabilities.includes(c)
            return (
              <label
                key={c}
                title={CAPABILITIES[c].hint}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-xl border px-2 py-1.5 text-xs transition-colors',
                  on ? 'border-border bg-muted/60' : 'border-border/60 text-muted-foreground hover:border-border',
                )}
              >
                <Checkbox
                  size="sm"
                  checked={on}
                  onCheckedChange={(v) =>
                    onChange({
                      capabilities: v ? [...bot.capabilities, c] : bot.capabilities.filter((x) => x !== c),
                    })
                  }
                />
                <span className="min-w-0 truncate">{CAPABILITIES[c].label}</span>
                {CAPABILITIES[c].external && <ShieldCheck className="ml-auto size-3 shrink-0 text-amber-500" />}
              </label>
            )
          })}
        </div>
      </Section>

      <Section title="Parallel copies" hint="How many of this bot may work at once, e.g. one per device.">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="size-8 p-0"
            onClick={() => onChange({ maxParallel: Math.max(1, bot.maxParallel - 1) })}
          >
            −
          </Button>
          <span className="w-8 text-center text-sm font-semibold tabular-nums">{bot.maxParallel}</span>
          <Button
            size="sm"
            variant="outline"
            className="size-8 p-0"
            onClick={() => onChange({ maxParallel: Math.min(10, bot.maxParallel + 1) })}
          >
            +
          </Button>
        </div>
      </Section>

      <Section title="Relations" hint="Drag from this card's edge onto another bot to add one.">
        {outgoing.length + incoming.length === 0 ? (
          <p className="text-xs text-muted-foreground">No relations yet.</p>
        ) : (
          <div className="space-y-1">
            {[...outgoing.map((r) => ({ ...r, dir: 'out' as const })), ...incoming.map((r) => ({ ...r, dir: 'in' as const }))].map(
              ({ link, other, dir }) => (
                <div
                  key={link.id}
                  className="group flex items-center gap-2 rounded-xl border border-border/60 px-2 py-1.5 hover:border-border"
                >
                  <span className={cn('size-2 shrink-0 rounded-full', LINK_KINDS[link.kind].swatch)} />
                  <button
                    type="button"
                    onClick={() => onSelect({ kind: 'link', id: link.id })}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs"
                  >
                    {dir === 'out' ? (
                      <>
                        <span className="shrink-0 text-muted-foreground">{LINK_KINDS[link.kind].verb}</span>
                        <BotChip bot={other} />
                      </>
                    ) : (
                      <>
                        <BotChip bot={other} />
                        <span className="shrink-0 text-muted-foreground">{LINK_KINDS[link.kind].verb} this bot</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label="Remove relation"
                    onClick={() => onRemoveLink(link.id)}
                    className="rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ),
            )}
          </div>
        )}
      </Section>

      <Section title="Instructions" hint="The bot's standing brief — what it always does and never does.">
        <Textarea
          value={bot.instructions}
          onChange={(e) => onChange({ instructions: e.target.value })}
          rows={6}
          className="rounded-xl font-mono text-xs"
          placeholder="e.g. Always capture a screenshot per step. Never submit a payment."
        />
      </Section>

      <Button variant="ghost" size="sm" className="w-full text-destructive hover:text-destructive" onClick={onDelete}>
        <Trash2 className="size-3.5" /> Remove {bot.name} from the team
      </Button>
    </div>
  )
}

function LinkInspector({
  team,
  link,
  onChange,
  onSwap,
  onDelete,
  onSelect,
}: {
  team: AiTeam
  link: TeamLink
  onChange: (patch: Partial<TeamLink>) => void
  onSwap: () => void
  onDelete: () => void
  onSelect: (s: Selection) => void
}) {
  const from = team.bots.find((b) => b.id === link.from)
  const to = team.bots.find((b) => b.id === link.to)
  return (
    <div className="space-y-5">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Relation</p>
        <div className="mt-2 flex items-center gap-2 rounded-2xl border border-border/60 bg-muted/40 p-3">
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect({ kind: 'bot', id: link.from })}>
            <BotChip bot={from} />
          </button>
          <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
          <button type="button" className="min-w-0 flex-1 text-right" onClick={() => onSelect({ kind: 'bot', id: link.to })}>
            <BotChip bot={to} />
          </button>
        </div>
        <p className="mt-2 text-xs">
          <span className="font-medium">{from?.name}</span>{' '}
          <span className="text-muted-foreground">{LINK_KINDS[link.kind].verb}</span>{' '}
          <span className="font-medium">{to?.name}</span>.
        </p>
      </div>

      <Section title="Kind">
        <div className="space-y-1">
          {LINK_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              onClick={() => onChange({ kind })}
              className={cn(
                'flex w-full items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors',
                link.kind === kind ? 'border-foreground bg-muted/60' : 'border-border/60 hover:border-border',
              )}
            >
              <span className={cn('mt-1 size-2.5 shrink-0 rounded-full', LINK_KINDS[kind].swatch)} />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{LINK_KINDS[kind].label}</span>
                <span className="block text-[11px] text-muted-foreground">{LINK_KINDS[kind].blurb}</span>
              </span>
            </button>
          ))}
        </div>
      </Section>

      <Section title="What passes along it">
        <Input
          value={link.note}
          onChange={(e) => onChange({ note: e.target.value })}
          placeholder="e.g. Confirmed bugs + evidence"
          className="h-8 rounded-xl text-xs"
        />
      </Section>

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="flex-1" onClick={onSwap}>
          <ArrowLeftRight className="size-3.5" /> Reverse
        </Button>
        <Button variant="ghost" size="sm" className="flex-1 text-destructive hover:text-destructive" onClick={onDelete}>
          <Trash2 className="size-3.5" /> Remove
        </Button>
      </div>
    </div>
  )
}

/** Nothing selected: the chain of command and what needs fixing. */
function TeamOverview({
  team,
  warnings,
  onSelect,
}: {
  team: AiTeam
  warnings: TeamWarning[]
  onSelect: (s: Selection) => void
}) {
  const coordinator = team.bots.find((b) => b.id === team.coordinatorId)
  const byId = new Map(team.bots.map((b) => [b.id, b]))
  const directs = (id: string) =>
    team.links.filter((l) => l.kind === 'coordinates' && l.from === id).map((l) => byId.get(l.to)).filter(Boolean) as TeamBot[]

  const verifications = team.links.filter((l) => l.kind === 'reviews')
  const handoffs = team.links.filter((l) => l.kind === 'hands-off')

  return (
    <div className="space-y-5">
      <Section title="Chain of command">
        {coordinator ? (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => onSelect({ kind: 'bot', id: coordinator.id })}
              className="flex w-full items-center gap-2 rounded-xl bg-foreground px-3 py-2 text-left text-background"
            >
              <Crown className="size-3.5" />
              <span className="text-xs font-semibold">{coordinator.name}</span>
              <span className="ml-auto text-[10px] opacity-70">coordinates</span>
            </button>
            <div className="ml-3 space-y-1 border-l border-border/60 pl-3">
              {directs(coordinator.id).length === 0 && (
                <p className="text-xs text-muted-foreground">Assigns work to nobody yet.</p>
              )}
              {directs(coordinator.id).map((b) => (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => onSelect({ kind: 'bot', id: b.id })}
                  className="flex w-full items-center gap-2 rounded-xl border border-border/60 px-2.5 py-1.5 text-left hover:border-border"
                >
                  <BotChip bot={b} />
                  <span className="ml-auto truncate text-[10px] text-muted-foreground">{ROLES[b.role].label}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No coordinator — select a bot and make it one.</p>
        )}
      </Section>

      <Section title="Who verifies whom">
        {verifications.length === 0 ? (
          <p className="text-xs text-muted-foreground">No verification — findings would count unchecked.</p>
        ) : (
          <div className="space-y-1">
            {verifications.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onSelect({ kind: 'link', id: l.id })}
                className="flex w-full items-center gap-1.5 rounded-xl border border-border/60 px-2.5 py-1.5 text-left hover:border-border"
              >
                <BotChip bot={byId.get(l.from)} />
                <ShieldCheck className="size-3 shrink-0 text-amber-500" />
                <BotChip bot={byId.get(l.to)} />
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Work flow">
        {handoffs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No hand-offs yet.</p>
        ) : (
          <div className="space-y-1">
            {handoffs.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => onSelect({ kind: 'link', id: l.id })}
                className="w-full rounded-xl border border-border/60 px-2.5 py-1.5 text-left hover:border-border"
              >
                <span className="flex items-center gap-1.5">
                  <BotChip bot={byId.get(l.from)} />
                  <ArrowRight className="size-3 shrink-0 text-emerald-500" />
                  <BotChip bot={byId.get(l.to)} />
                </span>
                {l.note && <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{l.note}</span>}
              </button>
            ))}
          </div>
        )}
      </Section>

      <Section title="Team health">
        {warnings.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" /> The team is organised soundly.
          </p>
        ) : (
          <div className="space-y-1.5">
            {warnings.map((w) => (
              <button
                key={w.text}
                type="button"
                disabled={!w.botId}
                onClick={() => w.botId && onSelect({ kind: 'bot', id: w.botId })}
                className={cn(
                  'flex w-full gap-1.5 rounded-xl border px-2.5 py-1.5 text-left text-xs',
                  w.level === 'error'
                    ? 'border-red-500/40 bg-red-500/5 text-red-700 dark:text-red-400'
                    : 'border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400',
                )}
              >
                <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w.text}
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-0.5 truncate text-lg font-semibold tracking-tight">{value}</div>
      {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function PolicyCard({ team, onChange }: { team: AiTeam; onChange: (patch: Partial<AiTeam['policy']>) => void }) {
  const p = team.policy
  const BUDGETS = [500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000]
  return (
    <Card className="rounded-3xl border-border/60 py-0 shadow-none">
      <CardContent className="space-y-5 p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60">
            <ShieldCheck className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Team rules</h2>
            <p className="text-xs text-muted-foreground">
              Limits every mission obeys, whatever an individual bot is allowed to do.
            </p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <Section title="Max discussion rounds" hint="Then the coordinator must conclude.">
            <Input
              type="number"
              min={1}
              max={50}
              value={p.maxRounds}
              onChange={(e) => onChange({ maxRounds: Number(e.target.value) || 1 })}
              className="h-8 w-28 rounded-xl text-sm"
            />
          </Section>
          <Section title="Bots working at once" hint="Across the whole team.">
            <Input
              type="number"
              min={1}
              max={20}
              value={p.maxParallelBots}
              onChange={(e) => onChange({ maxParallelBots: Number(e.target.value) || 1 })}
              className="h-8 w-28 rounded-xl text-sm"
            />
          </Section>
          <Section title="Token budget per mission" hint="The team stops when it is spent.">
            <div className="flex flex-wrap gap-1">
              {BUDGETS.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => onChange({ missionTokenBudget: b })}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    p.missionTokenBudget === b
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border/60 text-muted-foreground hover:border-border',
                  )}
                >
                  {formatTokens(b)}
                </button>
              ))}
            </div>
          </Section>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <Section title="Always ask a human before">
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(Object.keys(APPROVALS) as ApprovalAction[]).map((a) => (
                <label
                  key={a}
                  className="flex cursor-pointer items-center gap-2 rounded-xl border border-border/60 px-2.5 py-1.5 text-xs hover:border-border"
                >
                  <Checkbox
                    size="sm"
                    checked={p.requireApprovalFor.includes(a)}
                    onCheckedChange={(v) =>
                      onChange({
                        requireApprovalFor: v ? [...p.requireApprovalFor, a] : p.requireApprovalFor.filter((x) => x !== a),
                      })
                    }
                  />
                  {APPROVALS[a]}
                </label>
              ))}
            </div>
          </Section>
          <Section title="Evidence">
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border/60 px-2.5 py-2 text-xs hover:border-border">
              <Checkbox
                size="sm"
                className="mt-0.5"
                checked={p.crossVerifyBugs}
                onCheckedChange={(v) => onChange({ crossVerifyBugs: v })}
              />
              <span>
                <span className="block font-medium">Cross-verify every bug</span>
                <span className="block text-muted-foreground">
                  A bug only counts once a different bot has reproduced it on its own.
                </span>
              </span>
            </label>
          </Section>
        </div>
      </CardContent>
    </Card>
  )
}

// ── page ─────────────────────────────────────────────────────────────────────

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error'

function PageHeader() {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
        <UsersRound className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">AI Team</h1>
        <p className="text-sm text-muted-foreground">
          Your squad of QC bots — their roles, what each may do, who coordinates and who checks whose work.
        </p>
      </div>
    </div>
  )
}

export default function AiTeamPage() {
  const { activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const [confirmReset, setConfirmReset] = useState(false)
  // Bumped by a reset: the only event that should throw the local draft away.
  const [generation, setGeneration] = useState(0)
  const query = useQuery({
    queryKey: ['ai-team', activeProjectId],
    queryFn: () => getAiTeam(activeProjectId!),
    enabled: !!activeProjectId,
    refetchOnWindowFocus: false,
    // The editor owns the draft once loaded; a background refetch must not clobber it.
    staleTime: Infinity,
  })
  const reset = useMutation({
    mutationFn: () => resetAiTeam(activeProjectId!),
    onSuccess: ({ team }) => {
      setConfirmReset(false)
      queryClient.setQueryData(['ai-team', activeProjectId], (old: { team: AiTeam; file: string } | undefined) =>
        old ? { ...old, team } : { team, file: '' },
      )
      setGeneration((g) => g + 1)
      toast.success('Team reset to the starter squad')
    },
    onError: (err: Error) => toast.error('Could not reset the team', { description: err.message }),
  })

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader />
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="py-16 text-center text-sm text-muted-foreground">
            Select a project in the sidebar to manage its AI team.
          </CardContent>
        </Card>
      </div>
    )
  }

  if (query.isError) {
    return (
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader />
        <Card className="rounded-3xl border-red-500/40 shadow-none">
          <CardContent className="space-y-3 p-6 text-sm">
            <p className="flex items-center gap-2 font-medium text-red-600 dark:text-red-400">
              <AlertTriangle className="size-4" /> The team file could not be read
            </p>
            <p className="text-muted-foreground">{(query.error as Error).message}</p>
            <Button size="sm" variant="outline" onClick={() => setConfirmReset(true)}>
              <RotateCcw className="size-3.5" /> Replace it with the starter squad
            </Button>
          </CardContent>
        </Card>
        <ResetDialog open={confirmReset} onOpenChange={setConfirmReset} pending={reset.isPending} onConfirm={() => reset.mutate()} />
      </div>
    )
  }

  if (!query.data) {
    return (
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader />
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading the team…
        </p>
      </div>
    )
  }

  // Keyed by project and reset generation: switching project, or a reset, starts a fresh
  // draft instead of syncing server state into local state inside an effect. Saves write
  // the cache too, so coming back to the page opens the team as last saved.
  return (
    <TeamEditor
      key={`${activeProjectId}:${generation}`}
      projectId={activeProjectId}
      initial={query.data.team}
      onReset={() => reset.mutate()}
      resetting={reset.isPending}
    />
  )
}

function ResetDialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset to the starter squad?</DialogTitle>
          <DialogDescription>
            Every bot, relation and rule is replaced by the default six-bot team. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TeamEditor({
  projectId,
  initial,
  onReset,
  resetting,
}: {
  projectId: string
  initial: AiTeam
  onReset: () => void
  resetting: boolean
}) {
  const [team, setTeam] = useState<AiTeam>(initial)
  const [selection, setSelection] = useState<Selection>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [confirm, setConfirm] = useState<{ kind: 'reset' } | { kind: 'delete'; bot: TeamBot } | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latest = useRef<AiTeam>(initial)
  const queryClient = useQueryClient()

  const save = useMutation({
    mutationFn: (next: AiTeam) => saveAiTeam(projectId, next),
    onMutate: () => setSaveState('saving'),
    onSuccess: ({ team: saved }) => {
      queryClient.setQueryData(['ai-team', projectId], (old: { team: AiTeam; file: string } | undefined) =>
        old ? { ...old, team: saved } : old,
      )
      // A newer local edit may have landed while this one was in flight — keep it.
      setSaveState(timer.current ? 'pending' : 'saved')
    },
    onError: (err: Error) => {
      setSaveState('error')
      toast.error('Could not save the team', { description: err.message })
    },
  })

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    save.mutate(latest.current)
  }, [save])

  const commit = useCallback(
    (next: AiTeam, persist = true) => {
      latest.current = next
      setTeam(next)
      if (!persist) return
      setSaveState('pending')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        timer.current = null
        save.mutate(latest.current)
      }, SAVE_DELAY_MS)
    },
    [save],
  )

  // Never lose the last edit to a navigation.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current)
      void saveAiTeam(projectId, latest.current)
    }
  }, [projectId])

  const warnings = useMemo(() => teamWarnings(team), [team])

  const update = useCallback(
    (fn: (t: AiTeam) => AiTeam, persist = true) => {
      commit(fn(latest.current), persist)
    },
    [commit],
  )

  const patchBot = (id: string, patch: Partial<TeamBot>) =>
    update((t) => {
      const bots = t.bots.map((b) => (b.id === id ? { ...b, ...patch } : b))
      // A disabled bot cannot keep coordinating.
      const coordinatorId = patch.enabled === false && t.coordinatorId === id ? null : t.coordinatorId
      return { ...t, bots, coordinatorId }
    })

  const renameBot = (from: string, to: string) => {
    update((t) => ({
      ...t,
      coordinatorId: t.coordinatorId === from ? to : t.coordinatorId,
      bots: t.bots.map((b) => (b.id === from ? { ...b, id: to } : b)),
      links: t.links.map((l) => {
        const next = { ...l, from: l.from === from ? to : l.from, to: l.to === from ? to : l.to }
        return { ...next, id: `${next.from}-${next.kind}-${next.to}` }
      }),
    }))
    setSelection({ kind: 'bot', id: to })
  }

  const patchLink = (id: string, patch: Partial<TeamLink>) => {
    let nextId = id
    update((t) => {
      const current = t.links.find((l) => l.id === id)
      if (!current) return t
      const merged = { ...current, ...patch }
      const clash = t.links.some(
        (l) => l.id !== id && l.from === merged.from && l.to === merged.to && l.kind === merged.kind,
      )
      if (clash) {
        toast.error('That relation already exists')
        return t
      }
      nextId = `${merged.from}-${merged.kind}-${merged.to}`
      return { ...t, links: t.links.map((l) => (l.id === id ? { ...merged, id: nextId } : l)) }
    })
    setSelection({ kind: 'link', id: nextId })
  }

  const removeLink = (id: string) => {
    update((t) => ({ ...t, links: t.links.filter((l) => l.id !== id) }))
    if (selection?.kind === 'link' && selection.id === id) setSelection(null)
  }

  const connect = (from: string, to: string) => {
    if (from === to) return
    const t = latest.current
    // The likeliest meaning of a line from the coordinator is "assigns work to".
    const kind: TeamLinkKind = t.coordinatorId === from ? 'coordinates' : 'hands-off'
    if (t.links.some((l) => l.from === from && l.to === to && l.kind === kind)) {
      toast.info('Those two are already related that way')
      return
    }
    const link: TeamLink = { id: `${from}-${kind}-${to}`, from, to, kind, note: '' }
    commit({ ...t, links: [...t.links, link] })
    setSelection({ kind: 'link', id: link.id })
    toast.success(`${LINK_KINDS[kind].label} relation added`, { description: 'Change its kind in the panel on the right.' })
  }

  const addBot = (role: BotRole) => {
    const t = latest.current
    const maxY = t.bots.reduce((m, b) => Math.max(m, b.position.y), 0)
    const bot = newBot(role, t, { x: 120 + (t.bots.length % 4) * 250, y: maxY + 200 })
    commit({ ...t, bots: [...t.bots, bot], coordinatorId: t.coordinatorId ?? (role === 'lead' ? bot.id : null) })
    setSelection({ kind: 'bot', id: bot.id })
    setAddOpen(false)
  }

  const deleteBot = (bot: TeamBot) => {
    update((t) => ({
      ...t,
      coordinatorId: t.coordinatorId === bot.id ? null : t.coordinatorId,
      bots: t.bots.filter((b) => b.id !== bot.id),
      links: t.links.filter((l) => l.from !== bot.id && l.to !== bot.id),
    }))
    setSelection(null)
    setConfirm(null)
  }

  const active = team.bots.filter((b) => b.enabled)
  const coordinator = team.bots.find((b) => b.id === team.coordinatorId)
  const errors = warnings.filter((w) => w.level === 'error').length
  const selectedBot = selection?.kind === 'bot' ? team.bots.find((b) => b.id === selection.id) : undefined
  const selectedLink = selection?.kind === 'link' ? team.links.find((l) => l.id === selection.id) : undefined

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="space-y-4">
        <PageHeader />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Bots" value={`${active.length} active`} sub={`${team.bots.length} on the team`} />
          <StatTile
            label="Coordinator"
            value={coordinator ? coordinator.name : '—'}
            sub={coordinator ? `@${coordinator.id}` : 'Nobody plans the work'}
          />
          <StatTile
            label="Relations"
            value={team.links.length}
            sub={`${team.links.filter((l) => l.kind === 'reviews').length} verification, ${team.links.filter((l) => l.kind === 'hands-off').length} hand-off`}
          />
          <StatTile
            label="Health"
            value={
              warnings.length === 0 ? (
                <span className="text-emerald-600 dark:text-emerald-400">Healthy</span>
              ) : (
                <span className={errors ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}>
                  {warnings.length} {warnings.length === 1 ? 'issue' : 'issues'}
                </span>
              )
            }
            sub={errors ? `${errors} must be fixed` : warnings.length ? 'Worth a look' : 'Ready for missions'}
          />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="gap-0 overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-3">
            <Network className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold tracking-tight">Org chart</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">
              · drag cards to arrange, drag from an edge to relate two bots
            </span>
            <div className="ml-auto flex items-center gap-2">
              <SaveBadge state={saveState} onRetry={flush} />
              <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: 'reset' })}>
                <RotateCcw className="size-3.5" /> Reset
              </Button>
              <Popover open={addOpen} onOpenChange={setAddOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm">
                    <Plus className="size-3.5" /> Add bot
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 rounded-2xl p-1.5">
                  {ROLE_ORDER.map((r) => {
                    const Icon = ROLES[r].icon
                    return (
                      <button
                        key={r}
                        type="button"
                        onClick={() => addBot(r)}
                        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left hover:bg-muted"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl border border-border/60 bg-muted/60">
                          <Icon className="size-3.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-medium">{ROLES[r].label}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">{ROLES[r].blurb}</span>
                        </span>
                      </button>
                    )
                  })}
                </PopoverContent>
              </Popover>
            </div>
          </div>
          <ReactFlowProvider>
            <TeamCanvas
              team={team}
              selection={selection}
              warnings={warnings}
              onSelect={setSelection}
              onMove={(id, position) =>
                update((t) => ({ ...t, bots: t.bots.map((b) => (b.id === id ? { ...b, position } : b)) }), false)
              }
              onMoveEnd={() => update((t) => t)}
              onConnect={connect}
            />
          </ReactFlowProvider>
        </Card>

        <Card className="rounded-3xl border-border/60 py-0 shadow-none lg:max-h-[43.5rem] lg:overflow-y-auto">
          <CardContent className="p-5">
            {selectedBot ? (
              <BotInspector
                key={selectedBot.id}
                team={team}
                bot={selectedBot}
                warnings={warnings.filter((w) => w.botId === selectedBot.id)}
                onChange={(patch) => patchBot(selectedBot.id, patch)}
                onRename={(next) => renameBot(selectedBot.id, next)}
                onMakeCoordinator={() => update((t) => ({ ...t, coordinatorId: selectedBot.id }))}
                onSelect={setSelection}
                onRemoveLink={removeLink}
                onDelete={() => setConfirm({ kind: 'delete', bot: selectedBot })}
              />
            ) : selectedLink ? (
              <LinkInspector
                team={team}
                link={selectedLink}
                onChange={(patch) => patchLink(selectedLink.id, patch)}
                onSwap={() => patchLink(selectedLink.id, { from: selectedLink.to, to: selectedLink.from })}
                onDelete={() => removeLink(selectedLink.id)}
                onSelect={setSelection}
              />
            ) : (
              <TeamOverview team={team} warnings={warnings} onSelect={setSelection} />
            )}
          </CardContent>
        </Card>
      </div>

      <PolicyCard team={team} onChange={(patch) => update((t) => ({ ...t, policy: { ...t.policy, ...patch } }))} />

      <Card className="rounded-3xl border-border/60 py-0 shadow-none">
        <CardContent className="p-5">
          <h2 className="mb-3 text-sm font-semibold tracking-tight">Roster</h2>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {team.bots.map((b) => {
              const Icon = ROLES[b.role].icon
              const issues = warnings.filter((w) => w.botId === b.id).length
              return (
                <button
                  key={b.id}
                  type="button"
                  onClick={() => setSelection({ kind: 'bot', id: b.id })}
                  className={cn(
                    'flex items-start gap-3 rounded-2xl border p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm',
                    selection?.kind === 'bot' && selection.id === b.id ? 'border-foreground' : 'border-border/60',
                    !b.enabled && 'opacity-60',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-xl',
                      team.coordinatorId === b.id ? 'bg-foreground text-background' : 'border border-border/60 bg-muted/60',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{b.name}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">@{b.id}</span>
                      {issues > 0 && <AlertTriangle className="size-3 text-amber-500" />}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{b.mission || ROLES[b.role].blurb}</span>
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      <Pill>{MODELS[b.model].label}</Pill>
                      <Pill>{AUTONOMY[b.autonomy].label}</Pill>
                      <Pill>{b.capabilities.length} abilities</Pill>
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
          {(
            <p className="mt-3 truncate font-mono text-[11px] text-muted-foreground">
              Saved in testing/ai-team/team.json
            </p>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          {confirm?.kind === 'delete' ? (
            <>
              <DialogHeader>
                <DialogTitle>Remove {confirm.bot.name}?</DialogTitle>
                <DialogDescription>
                  @{confirm.bot.id} and its{' '}
                  {team.links.filter((l) => l.from === confirm.bot.id || l.to === confirm.bot.id).length} relations
                  leave the team.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Keep
                </Button>
                <Button variant="destructive" onClick={() => deleteBot(confirm.bot)}>
                  <Trash2 className="size-3.5" /> Remove
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Reset to the starter squad?</DialogTitle>
                <DialogDescription>
                  Every bot, relation and rule is replaced by the default six-bot team. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button variant="destructive" onClick={onReset} disabled={resetting}>
                  {resetting ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  Reset
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SaveBadge({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  if (state === 'idle') return null
  if (state === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-500/5 px-3 py-1 text-xs text-red-600 dark:text-red-400"
      >
        <AlertTriangle className="size-3.5" /> Not saved — retry
      </button>
    )
  }
  const saving = state === 'saving' || state === 'pending'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
      {saving ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5 text-emerald-500" />}
      {saving ? 'Saving…' : 'Saved'}
    </span>
  )
}
