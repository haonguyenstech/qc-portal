import { TEST_TARGET_META, TEST_TARGET_TINT } from '@/lib/testTarget'
import type { TestTarget } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * What surface a run tested — Web / Web on mobile / App on device.
 *
 * Two runs of the same ticket often differ only in this, so it's shown on every
 * History row and in a run's detail header. `compact` drops the label and keeps the
 * icon for tight rows.
 */
export function TargetTag({
  target,
  compact = false,
  className,
}: {
  target: TestTarget
  compact?: boolean
  className?: string
}) {
  const meta = TEST_TARGET_META[target]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-xl border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        TEST_TARGET_TINT[target],
        className,
      )}
      title={`${meta.label} — ${meta.hint}`}
    >
      <meta.Icon className="size-3 shrink-0" />
      {!compact && <span className="whitespace-nowrap">{meta.label}</span>}
    </span>
  )
}
