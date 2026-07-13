import type { CrawledTicket } from '@/lib/api'

/** Color-code a ClickUp priority into our status palette (urgent→red … low→muted).
 *  Shared by every crawled-ticket list so they read identically. */
export function priorityClass(priority: string): string {
  const p = priority.toLowerCase()
  if (p === 'urgent') return 'border-red-200 bg-red-50 text-red-700'
  if (p === 'high') return 'border-amber-200 bg-amber-50 text-amber-700'
  if (p === 'normal') return 'border-blue-200 bg-blue-50 text-blue-700'
  return 'border-border bg-muted text-muted-foreground' // low / unknown
}

/** Group crawled tickets by ClickUp status, preserving order within a group and
 *  sinking the "No status" bucket to the bottom (mirrors the TestCases list). */
export function groupCrawledByStatus(
  tickets: CrawledTicket[],
): { status: string; tickets: CrawledTicket[] }[] {
  const map = new Map<string, CrawledTicket[]>()
  for (const t of tickets) {
    const key = t.status?.trim() || ''
    const arr = map.get(key)
    if (arr) arr.push(t)
    else map.set(key, [t])
  }
  return [...map.entries()]
    .map(([status, items]) => ({ status, tickets: items }))
    .sort((a, b) => {
      if (!a.status) return 1
      if (!b.status) return -1
      return a.status.localeCompare(b.status)
    })
}

/** One rendered row of a crawled-ticket tree: the ticket + its nesting depth. */
export interface CrawledTreeRow {
  ticket: CrawledTicket
  depth: number
  hasChildren: boolean
}

export interface CrawledTree {
  /** Top-level tickets grouped by ClickUp status (for section headers). */
  groups: { status: string; roots: CrawledTicket[] }[]
  /** Count of visible tickets (roots + shown descendants) after filtering. */
  count: number
  /** Flatten a group's roots into pre-order rows, honoring the collapsed set. */
  rows: (roots: CrawledTicket[]) => CrawledTreeRow[]
}

/**
 * Build the parent→subtask forest for a crawled-ticket list. Since a crawled folder
 * `name` may be nested (PARENT/CHILD), subtasks are joined to their parent by the
 * `parent` field the server reports. Shared by every crawled-ticket selector so they
 * nest identically. When `match` is given, only matching tickets — PLUS every
 * ancestor of a match — stay visible, so a nested hit keeps its parent chain in view.
 * Roots group by status; a root's descendants render nested beneath it regardless of
 * their own status. `collapsed` (by folder `name`) hides a parent's children.
 */
export function buildCrawledTree(
  all: CrawledTicket[],
  opts: { match?: (t: CrawledTicket) => boolean; collapsed?: Set<string> } = {},
): CrawledTree {
  const match = opts.match ?? (() => true)
  const collapsed = opts.collapsed ?? new Set<string>()
  const byName = new Map(all.map((c) => [c.name, c] as const))

  const visible = new Set<string>()
  for (const c of all) {
    if (!match(c)) continue
    visible.add(c.name)
    let p = c.parent ?? null
    while (p && byName.has(p) && !visible.has(p)) {
      visible.add(p)
      p = byName.get(p)?.parent ?? null
    }
  }
  const visibleTickets = all.filter((c) => visible.has(c.name))

  const childrenByParent = new Map<string, CrawledTicket[]>()
  for (const c of visibleTickets) {
    if (c.parent && byName.has(c.parent)) {
      const arr = childrenByParent.get(c.parent)
      if (arr) arr.push(c)
      else childrenByParent.set(c.parent, [c])
    }
  }
  const roots = visibleTickets.filter((c) => !c.parent || !byName.has(c.parent))
  const groups = groupCrawledByStatus(roots).map((g) => ({ status: g.status, roots: g.tickets }))

  const rows = (rootsIn: CrawledTicket[]): CrawledTreeRow[] => {
    const out: CrawledTreeRow[] = []
    const visit = (node: CrawledTicket, depth: number) => {
      const kids = childrenByParent.get(node.name) ?? []
      out.push({ ticket: node, depth, hasChildren: kids.length > 0 })
      if (kids.length && !collapsed.has(node.name)) for (const k of kids) visit(k, depth + 1)
    }
    for (const r of rootsIn) visit(r, 0)
    return out
  }

  return { groups, count: visibleTickets.length, rows }
}
