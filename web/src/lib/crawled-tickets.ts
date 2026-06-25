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
