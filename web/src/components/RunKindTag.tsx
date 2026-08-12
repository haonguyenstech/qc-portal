import { RUN_KIND_META, RUN_KIND_TINT } from '@/lib/runKind'
import type { RunKind } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * What a run tested — a single ticket, or an end-to-end flow.
 *
 * The two are otherwise indistinguishable once a run is listed: both show a mono
 * string where the ticket id goes, except a flow's is only its NAME slugged
 * (`checkout-invoice`), so a Running/History row read as a ticket nobody could
 * find. Sits beside `TargetTag` — that one says WHERE the run drove, this one
 * says what it was. `compact` drops the label and keeps the icon for tight rows.
 */
export function RunKindTag({
  kind,
  compact = false,
  className,
}: {
  kind: RunKind
  compact?: boolean
  className?: string
}) {
  const meta = RUN_KIND_META[kind]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-xl border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        RUN_KIND_TINT[kind],
        className,
      )}
      title={`${meta.label} — ${meta.hint}`}
    >
      <meta.Icon className="size-3 shrink-0" />
      {!compact && <span className="whitespace-nowrap">{meta.label}</span>}
    </span>
  )
}
