import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  ChevronsUpDown,
  DownloadCloud,
  Loader2,
  Search,
  Ticket,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { listCrawledTickets, type CrawledTicket } from '@/lib/api'
import { CrawledStatusHeader, CrawledTicketRow } from '@/components/CrawledTicketRow'
import { groupCrawledByStatus } from '@/lib/crawled-tickets'

interface Props {
  value: string
  onChange: (value: string) => void
  projectId?: string
  disabled?: boolean
}

/**
 * Ticket field for the Run form, sourced from the tickets already **crawled** to
 * disk (testing/tickets/) — those are the ones with local data ready for QC. It's a
 * searchable dropdown over the crawled list (display id + title + test-case badge);
 * picking one sets the run's ticket id. No live ClickUp search here — crawl first
 * on the Tickets page.
 */
export function CrawledTicketPicker({ value, onChange, projectId, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  const { data: crawled, isLoading } = useQuery({
    queryKey: ['crawled-tickets', projectId],
    queryFn: () => listCrawledTickets(projectId as string),
    enabled: !!projectId,
  })

  const tickets = useMemo(() => {
    const list = crawled ?? []
    const q = query.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (t) =>
            (t.displayId ?? t.name).toLowerCase().includes(q) ||
            (t.title ?? '').toLowerCase().includes(q),
        )
      : list
    // Most recently crawled first.
    return [...filtered].sort((a, b) => (b.crawledAt ?? '').localeCompare(a.crawledAt ?? ''))
  }, [crawled, query])

  const selected = useMemo(
    () => (crawled ?? []).find((t) => (t.displayId ?? t.name) === value),
    [crawled, value],
  )

  const idOf = (t: CrawledTicket) => t.displayId ?? t.name
  const total = crawled?.length ?? 0

  return (
    <div className="space-y-2" ref={rootRef}>
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <Ticket className="size-3.5 text-muted-foreground" />
          Ticket
          {total > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {total} crawled
            </span>
          )}
        </Label>
        <Link
          to="/tickets"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <DownloadCloud className="size-3.5" />
          Crawl more
        </Link>
      </div>

      <div className="relative">
        {/* Trigger */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={cn(
            'flex h-11 w-full items-center gap-2 rounded-xl border border-border/60 bg-background px-3 text-left text-sm shadow-none transition-all',
            'hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:cursor-not-allowed disabled:opacity-50',
            open && 'border-primary/50 ring-2 ring-ring/30',
          )}
        >
          {selected ? (
            <>
              <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
              <span className="font-mono text-xs font-semibold text-foreground">{idOf(selected)}</span>
              {selected.title && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{selected.title}</span>
              )}
            </>
          ) : value ? (
            <>
              <Ticket className="size-4 shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs text-foreground">{value}</span>
              <span className="text-xs text-muted-foreground">· not crawled</span>
            </>
          ) : (
            <>
              <Ticket className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 text-muted-foreground">Choose a crawled ticket…</span>
            </>
          )}
          {value && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="Clear ticket"
              onClick={(e) => {
                e.stopPropagation()
                onChange('')
              }}
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground/60" />
        </button>

        {open && !disabled && (
          <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-2xl border border-border/60 bg-popover shadow-lg">
            {/* Search box */}
            <div className="relative border-b border-border/60 p-2.5">
              <Search className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by id or title…"
                className="h-11 w-full rounded-full border border-input bg-transparent px-4 pl-9 text-sm shadow-none outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 focus:shadow-sm"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-5 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                  aria-label="Clear filter"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading crawled tickets…
                </div>
              ) : total === 0 ? (
                <div className="flex flex-col items-center gap-2 px-3 py-8 text-center">
                  <DownloadCloud className="size-6 text-muted-foreground/40" />
                  <p className="text-sm font-medium">No crawled tickets yet</p>
                  <p className="max-w-[15rem] text-xs text-muted-foreground">
                    Crawl tickets on the Tickets page first — they’ll show up here ready to test.
                  </p>
                  <Link
                    to="/tickets"
                    onClick={() => setOpen(false)}
                    className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <DownloadCloud className="size-3.5" />
                    Go to Tickets
                  </Link>
                </div>
              ) : tickets.length === 0 ? (
                <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Search className="size-3.5" />
                  No crawled ticket matches “{query}”.
                </div>
              ) : (
                groupCrawledByStatus(tickets).map((group) => (
                  <div key={group.status || '∅'}>
                    <CrawledStatusHeader status={group.status} count={group.tickets.length} />
                    <ul className="divide-y">
                      {group.tickets.map((t) => (
                        <li key={t.name}>
                          <CrawledTicketRow
                            ticket={t}
                            selected={idOf(t) === value}
                            onSelect={() => {
                              onChange(idOf(t))
                              setOpen(false)
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
          </div>
        )}

        {/* Click-away backdrop while open. */}
        {open && (
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {selected?.testcaseVersions
          ? `${selected.testcaseVersions} test-case version${selected.testcaseVersions === 1 ? '' : 's'} ready for this ticket.`
          : 'Pick a ticket you’ve crawled — its description, comments and any test cases are on disk.'}
      </p>
    </div>
  )
}
