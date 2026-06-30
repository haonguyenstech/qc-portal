import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { RunStatus } from '@/lib/types'

const variant: Record<RunStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  queued: 'outline',
  running: 'secondary',
  paused: 'secondary',
  passed: 'default',
  failed: 'destructive',
  error: 'destructive',
  canceled: 'outline',
}

const tint: Partial<Record<RunStatus, string>> = {
  passed: 'border-transparent bg-emerald-100 text-emerald-700 hover:bg-emerald-100',
  running: 'border-transparent bg-sky-100 text-sky-700 hover:bg-sky-100',
  paused: 'border-transparent bg-amber-100 text-amber-700 hover:bg-amber-100',
}

// Dot colors for the `compact` variant — a tiny status indicator for dense lists.
const dot: Record<RunStatus, string> = {
  queued: 'bg-muted-foreground/40',
  running: 'bg-sky-500',
  paused: 'bg-amber-500',
  passed: 'bg-emerald-500',
  failed: 'bg-red-500',
  error: 'bg-red-500',
  canceled: 'bg-muted-foreground/40',
}

export function StatusBadge({ status, compact }: { status: RunStatus; compact?: boolean }) {
  if (compact) {
    return (
      <span
        className={cn('inline-block size-2 shrink-0 rounded-full', dot[status])}
        title={status}
        aria-label={status}
      />
    )
  }
  return (
    <Badge variant={variant[status]} className={cn('capitalize', tint[status])}>
      {status}
    </Badge>
  )
}
