import { Sparkles, Workflow } from 'lucide-react'
import type { RunKind } from './types'

/**
 * WHAT a run tested — one ticket's acceptance criteria, or an end-to-end flow.
 *
 * The vocabulary matches the Run form's own mode switch (Single ticket / E2E
 * flow) on purpose: the label a run wears afterwards should be the words the
 * engineer chose when starting it. Mirrors `testTarget.ts`, which answers the
 * other half of the question — WHERE the run drove.
 */
export const RUN_KIND_META: Record<RunKind, { label: string; hint: string; Icon: typeof Workflow }> =
  {
    ticket: { label: 'Single ticket', hint: 'Acceptance test of one ticket', Icon: Sparkles },
    flow: {
      label: 'E2E flow',
      hint: 'End-to-end path through the product — no ticket',
      Icon: Workflow,
    },
  }

/** Neutral for the everyday case, solid for the flow — a flow is the exception. */
export const RUN_KIND_TINT: Record<RunKind, string> = {
  ticket: 'border-border/60 bg-muted/60 text-muted-foreground',
  flow: 'border-transparent bg-foreground text-background',
}

/** Normalize an unknown/missing value (runs predating the column) to 'ticket'. */
export function asRunKind(value: string | null | undefined): RunKind {
  return value === 'flow' ? 'flow' : 'ticket'
}
