import { useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  CheckCircle2,
  ChevronsUpDown,
  ClipboardList,
  DownloadCloud,
  Loader2,
  Search,
  Ticket,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Label } from '@/components/ui/label'
import { listCrawledTickets, type CrawledTicket } from '@/lib/api'
import { relativeTime } from '@/lib/format'

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
            'flex h-11 w-full items-center gap-2 rounded-md border bg-background px-3 text-left text-sm shadow-xs transition-all',
            'hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
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
          <div className="absolute z-20 mt-1.5 w-full overflow-hidden rounded-lg border bg-popover shadow-lg">
            {/* Search box */}
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <Search className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter by id or title…"
                className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="text-muted-foreground/60 hover:text-foreground"
                  aria-label="Clear filter"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>

            <div className="max-h-72 overflow-y-auto p-1">
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
                    className="mt-1 inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
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
                tickets.map((t) => {
                  const id = idOf(t)
                  const isSel = id === value
                  return (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => {
                        onChange(id)
                        setOpen(false)
                        setQuery('')
                      }}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                        isSel ? 'bg-primary/10' : 'hover:bg-accent',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border',
                          isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                        )}
                        aria-hidden
                      >
                        {isSel && <CheckCircle2 className="size-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs font-semibold">{id}</span>
                          {t.testcaseVersions > 0 && (
                            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-600">
                              <ClipboardList className="size-2.5" />
                              {t.testcaseVersions}
                            </span>
                          )}
                        </span>
                        {t.title && <span className="line-clamp-1 text-sm">{t.title}</span>}
                        {t.crawledAt && (
                          <span className="text-[11px] text-muted-foreground">
                            crawled {relativeTime(t.crawledAt)}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })
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
