/**
 * Shared bits of the Scheduled feature that are NOT components — the draft shape the
 * dialog takes, and the one date format every "when does it run" line uses.
 *
 * They live here rather than in `ScheduleDialog.tsx` because both the page and the chat
 * composer read them, and a file that exports a component plus helpers breaks Fast Refresh
 * (eslint `react-refresh/only-export-components`).
 *
 * Note what is NOT here: anything that READS a cron expression. The browser has no cron
 * parser at all — `description`, `nextRunAt` and the dialog's preview all come from the
 * server (`server/src/cron.ts`), which is the only way the sentence on a card and the timer
 * that fires it cannot drift apart.
 */
import type { ScheduleMode } from './types'

/** The task being proposed or edited. `id` present → editing an existing task. */
export interface ScheduleDraftInput {
  id?: string
  title?: string
  prompt: string
  cron: string
  mode?: ScheduleMode
  model?: string
  effort?: string
}

/** "Fri, 12 Sep, 9:00 AM" — every upcoming/last-run line in the feature. */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}
