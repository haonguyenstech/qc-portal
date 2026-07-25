import { Globe, Smartphone, TabletSmartphone } from 'lucide-react'
import type { TestTarget } from './types'

/**
 * The three surfaces a QC run can drive, with the label/icon vocabulary used
 * everywhere they're shown — the Run form's target picker, the History rows, and a
 * run's detail header. Keep this the single source so a run is described the same
 * way when it's started and when it's read back weeks later.
 */
export const TEST_TARGET_META: Record<
  TestTarget,
  { label: string; hint: string; Icon: typeof Globe }
> = {
  web: { label: 'Web', hint: 'Desktop browser', Icon: Globe },
  'web-mobile': { label: 'Web on mobile', hint: 'Mobile browser', Icon: Smartphone },
  'app-mobile': { label: 'App on device', hint: 'Native app', Icon: TabletSmartphone },
}

/** Tint per target so the tag is scannable in a long list (neutral → violet → sky). */
export const TEST_TARGET_TINT: Record<TestTarget, string> = {
  web: 'border-border/60 bg-muted/60 text-muted-foreground',
  'web-mobile': 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  'app-mobile': 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
}

/** Normalize an unknown/missing value to a usable target (mirrors the server default). */
export function asTestTarget(value: string | null | undefined): TestTarget {
  return value === 'web-mobile' || value === 'app-mobile' ? value : 'web'
}
