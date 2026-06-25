import { Check, CheckCircle2, ExternalLink, Eye, Ticket } from 'lucide-react'
import { cn } from '@/lib/utils'
import { relativeTime } from '@/lib/format'
import { priorityClass } from '@/lib/crawled-tickets'
import type { CrawledTicket } from '@/lib/api'

/** Sticky status header for a group of crawled tickets. */
export function CrawledStatusHeader({ status, count }: { status: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b bg-muted/80 px-3 py-1.5 backdrop-blur supports-[backdrop-filter]:bg-muted/60">
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/60" aria-hidden />
        {status || 'No status'}
      </span>
      <span className="text-[11px] font-medium text-muted-foreground/70">{count}</span>
      <span className="h-px flex-1 bg-border/60" aria-hidden />
    </div>
  )
}

/**
 * One crawled-ticket row — the single source of truth for how a crawled ticket
 * looks anywhere it can be selected (TestCases / Run / Design Check). A square
 * checkbox indicator, mono id, title, priority badge, an optional ClickUp link, and
 * either a test-case badge (clickable when `onView` is given) or the crawl time.
 */
export function CrawledTicketRow({
  ticket,
  selected,
  onSelect,
  onView,
  blocked,
}: {
  ticket: CrawledTicket
  selected: boolean
  onSelect: () => void
  /** When provided, the "test cases" badge becomes a button that previews them. */
  onView?: () => void
  /** Selection disabled (e.g. a multi-select cap was reached and this row is off). */
  blocked?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 pr-2 transition-colors',
        selected ? 'bg-primary/5' : 'hover:bg-muted',
        blocked && 'opacity-40',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={blocked}
        aria-pressed={selected}
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground disabled:cursor-not-allowed"
      >
        <span
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40',
          )}
          aria-hidden
        >
          {selected && <Check className="size-3" />}
        </span>
        <Ticket className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 font-mono text-xs font-medium">
            {ticket.displayId ?? ticket.name}
          </span>
          {ticket.title && (
            <span className="min-w-0 truncate text-xs text-muted-foreground">{ticket.title}</span>
          )}
          {ticket.priority && (
            <span
              className={cn(
                'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize',
                priorityClass(ticket.priority),
              )}
            >
              {ticket.priority}
            </span>
          )}
        </span>
      </button>
      {ticket.url && (
        <a
          href={ticket.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open in ClickUp"
          className="inline-flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
      {ticket.hasTestcases ? (
        onView ? (
          <button
            type="button"
            onClick={onView}
            title="Preview generated test cases"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            <CheckCircle2 className="size-3" />
            {ticket.testcaseVersions > 1 ? `${ticket.testcaseVersions} versions` : 'Test cases'}
            <Eye className="size-3" />
          </button>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
            <CheckCircle2 className="size-3" />
            {ticket.testcaseVersions > 1 ? `${ticket.testcaseVersions} versions` : 'Test cases'}
          </span>
        )
      ) : ticket.crawledAt ? (
        <span className="shrink-0 px-1 text-[11px] text-muted-foreground">
          {relativeTime(ticket.crawledAt)}
        </span>
      ) : null}
    </div>
  )
}
