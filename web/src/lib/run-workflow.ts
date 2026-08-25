/**
 * The E2E flow (advanced) QC run's workflow model — the GRAPH the canvas edits
 * (see components/RunWorkflowBuilder.tsx) and the pure functions that flatten it
 * back into the run contract the server has always taken.
 *
 * An end-to-end flow is NOT tied to a ticket: it's a path through the product
 * ("sign in → create a claim → verify it's listed"), so the canvas holds steps
 * only. The run still needs a name to file its report under, which is what
 * `flowSlug()` produces from the flow's title — nothing about the server or the
 * run record changes.
 *
 * Nodes carry their own position and are joined by EDGES the engineer draws, so
 * a flow can branch. The run contract is still an ordered list of strings, which
 * is what `orderedNodes()` produces: a walk of the graph from its entry node.
 */

export type StepKind = 'navigate' | 'auth' | 'form' | 'verify' | 'data' | 'custom'

export type WorkflowNode = {
  id: string
  step: StepKind
  /** the instruction Claude follows */
  title?: string
  /** optional expected result, appended to the step text */
  expected?: string
  /**
   * The screen this step opens, if it opens one. A flow walks several pages, so
   * the URL belongs to the STEP that navigates rather than to the run — the run's
   * own `appUrl` is just the first one (`flowEntryUrl`), i.e. where it starts.
   */
  url?: string
  /** canvas position — the engineer drags a card anywhere */
  x: number
  y: number
}

/** A connection between two steps: `source` runs, then `target`. */
export type WorkflowEdge = {
  id: string
  source: string
  target: string
  /** which side of each card the line leaves/enters (top|right|bottom|left) */
  sourceHandle?: string | null
  targetHandle?: string | null
}

export const MAX_WORKFLOW_STEPS = 20
export const DEFAULT_FLOW_NAME = 'E2E flow'

/** Card footprint on the canvas, used when auto-placing a new node. */
export const NODE_WIDTH = 260
export const NODE_HEIGHT = 76
export const NODE_GAP_Y = 56

let seq = 0
export const nextNodeId = () => `s-${Date.now().toString(36)}-${(seq++).toString(36)}`
export const edgeId = (source: string, target: string) => `e-${source}-${target}`

/** One step node → the single line the run receives in `workflowSteps`. */
export function stepText(node: WorkflowNode): string {
  const title = (node.title ?? '').trim()
  const expected = (node.expected ?? '').trim()
  const url = (node.url ?? '').trim()
  if (!title) return ''
  let line = title
  if (url) line += ` — URL: ${url}`
  if (expected) line += ` — expected: ${expected}`
  return line
}

/**
 * The graph as an ORDERED list — what a run actually executes.
 *
 * A free canvas has no inherent order, so it's derived: start at the entry node
 * (no incoming edge; ties and a fully-cyclic graph fall back to the topmost
 * card), then walk depth-first along the edges. A branch's children run in
 * reading order — top to bottom, then left to right — because that is how the
 * engineer laid them out, and the report has to follow the picture. Nodes no
 * edge reaches are appended in the same reading order rather than dropped: an
 * unconnected card is a step someone typed, and silently ignoring it would run
 * a flow that isn't the one on screen.
 */
export function orderedNodes(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] {
  if (nodes.length === 0) return []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const reading = (a: WorkflowNode, b: WorkflowNode) => a.y - b.y || a.x - b.x
  const outgoing = new Map<string, WorkflowNode[]>()
  const hasIncoming = new Set<string>()
  for (const e of edges) {
    const from = byId.get(e.source)
    const to = byId.get(e.target)
    if (!from || !to) continue
    const list = outgoing.get(e.source) ?? []
    if (!list.some((n) => n.id === to.id)) list.push(to)
    outgoing.set(e.source, list)
    hasIncoming.add(e.target)
  }
  for (const list of outgoing.values()) list.sort(reading)

  const sorted = [...nodes].sort(reading)
  const roots = sorted.filter((n) => !hasIncoming.has(n.id))
  const out: WorkflowNode[] = []
  const seen = new Set<string>()
  const visit = (node: WorkflowNode) => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    out.push(node)
    for (const next of outgoing.get(node.id) ?? []) visit(next)
  }
  // No root at all means every node is in a cycle — start from the topmost card
  // so the walk still covers the graph instead of returning nothing.
  for (const root of roots.length ? roots : sorted.slice(0, 1)) visit(root)
  for (const node of sorted) visit(node)
  return out
}

/**
 * Non-empty steps in run order, each with the KIND its card was. The two travel
 * together so a template can save both without the arrays drifting out of sync —
 * `stepText` drops a titleless card, and a separately-filtered kind list would
 * then be off by one for every step after it.
 */
export function workflowStepEntries(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[] = [],
): { line: string; step: StepKind }[] {
  return orderedNodes(nodes, edges)
    .map((n) => ({ line: stepText(n), step: n.step }))
    .filter((e) => !!e.line)
}

/** Non-empty step lines in run order — what the run contract takes. */
export function workflowStepLines(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): string[] {
  return workflowStepEntries(nodes, edges).map((e) => e.line)
}

const STEP_KINDS: StepKind[] = ['navigate', 'auth', 'form', 'verify', 'data', 'custom']
export const isStepKind = (v: unknown): v is StepKind =>
  typeof v === 'string' && (STEP_KINDS as string[]).includes(v)

/**
 * Where the flow STARTS — the first step in RUN order that names a URL. That is
 * what the run record's `appUrl` becomes, so a flow is configured entirely on the
 * canvas and the form's shared App URL field is not shown in this mode.
 */
export function flowEntryUrl(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): string {
  for (const n of orderedNodes(nodes, edges)) {
    const url = (n.url ?? '').trim()
    if (url) return url
  }
  return ''
}

/** The step the run opens at — the first one in run order carrying a URL. */
export function flowEntryNodeId(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): string | null {
  for (const n of orderedNodes(nodes, edges)) {
    if ((n.url ?? '').trim()) return n.id
  }
  return null
}

/** Every step URL that was typed but isn't a usable http(s) address. */
export function invalidStepUrls(nodes: WorkflowNode[]): WorkflowNode[] {
  return nodes.filter((n) => {
    const url = (n.url ?? '').trim()
    if (!url) return false
    try {
      const u = new URL(url)
      return u.protocol !== 'http:' && u.protocol !== 'https:'
    } catch {
      return true
    }
  })
}

/**
 * The run's id/slug for a flow. The server files a run's report under this name
 * (`resolveSlug`), so it must be path-safe — a flow called "Checkout → invoice"
 * becomes `checkout-invoice`.
 */
export function flowSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return slug || 'e2e-flow'
}

/** One saved step string → its fields. The exact inverse of `stepText`. */
function parseStepLine(s: string): { title: string; expected?: string; url?: string } {
  let rest = s
  let expected: string | undefined
  let url: string | undefined
  const expectedAt = rest.lastIndexOf(' — expected: ')
  if (expectedAt !== -1) {
    expected = rest.slice(expectedAt + ' — expected: '.length).trim()
    rest = rest.slice(0, expectedAt)
  }
  const urlAt = rest.lastIndexOf(' — URL: ')
  if (urlAt !== -1) {
    url = rest.slice(urlAt + ' — URL: '.length).trim()
    rest = rest.slice(0, urlAt)
  }
  return { title: rest.trim(), expected, url }
}

/**
 * Rebuild a canvas from a saved template's step strings — laid out as the plain
 * top-to-bottom chain they were saved from. A template stores the flattened
 * lines, so branch SHAPE isn't recoverable; the run order is, and that's what
 * the lines encode.
 */
export function graphFromPreset(
  steps: string[],
  /**
   * The kind of each step, positionally. Optional because the run contract is
   * lines only — a template saved before kinds were stored (or a flow rebuilt
   * from anything else) falls back to `custom`.
   */
  kinds: (StepKind | string)[] = [],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes = steps.slice(0, MAX_WORKFLOW_STEPS).map<WorkflowNode>((s, i) => ({
    id: nextNodeId(),
    step: isStepKind(kinds[i]) ? (kinds[i] as StepKind) : 'custom',
    ...parseStepLine(s),
    x: 0,
    y: i * (NODE_HEIGHT + NODE_GAP_Y),
  }))
  const edges = nodes.slice(1).map<WorkflowEdge>((n, i) => ({
    id: edgeId(nodes[i].id, n.id),
    source: nodes[i].id,
    target: n.id,
    sourceHandle: 'bottom',
    targetHandle: 'top',
  }))
  return { nodes, edges }
}

/**
 * Build a canvas from steps the AI drafted out of an uploaded test-case document
 * (`POST /api/ai/flow-from-testcases`) — the same plain top-to-bottom chain a saved
 * template rebuilds as. The fields arrive already separated, so this does NOT go
 * through `stepText`/`parseStepLine`: round-tripping them through one string only
 * creates a way for a title containing " — URL: " to be re-split wrongly.
 */
export function graphFromDraft(
  steps: { step?: string; title?: string; url?: string; expected?: string }[],
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes = steps
    .filter((s) => (s.title ?? '').trim())
    .slice(0, MAX_WORKFLOW_STEPS)
    .map<WorkflowNode>((s, i) => ({
      id: nextNodeId(),
      step: isStepKind(s.step) ? s.step : 'custom',
      title: (s.title ?? '').trim(),
      ...((s.url ?? '').trim() ? { url: (s.url ?? '').trim() } : {}),
      ...((s.expected ?? '').trim() ? { expected: (s.expected ?? '').trim() } : {}),
      x: 0,
      y: i * (NODE_HEIGHT + NODE_GAP_Y),
    }))
  const edges = nodes.slice(1).map<WorkflowEdge>((n, i) => ({
    id: edgeId(nodes[i].id, n.id),
    source: nodes[i].id,
    target: n.id,
    sourceHandle: 'bottom',
    targetHandle: 'top',
  }))
  return { nodes, edges }
}
