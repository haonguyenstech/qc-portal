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

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <Badge variant={variant[status]} className={cn('capitalize', tint[status])}>
      {status}
    </Badge>
  )
}
