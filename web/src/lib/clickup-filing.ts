/**
 * Filing a QC finding to ClickUp — the parts that must be IDENTICAL wherever the
 * portal offers it.
 *
 * Two pages file bugs: the run detail's Issues tab (parsed out of `issues.md`) and
 * the Design Check page (findings from `/verify`). They used to be one implementation
 * living inside `RunDetailPage`; a second copy would drift, and the priority shown
 * before filing would stop matching the priority actually applied — which is exactly
 * the failure `severityPriority()` was added to fix. So the shape of a filable item,
 * the severity→priority map, and the error/summary wording all live here, and
 * `components/ClickupFilingBar.tsx` renders the commit bar for both.
 *
 * `priorityFromSeverity` MIRRORS `severityPriority()` in server/src/clickup.ts, which
 * is what actually sets the field — this copy exists only so a panel can show the
 * outcome before the button is pressed. Keep the two in step.
 */
import { useEffect, useState } from 'react'
import type { AppliedIssueFields } from './api'

/**
 * One thing that can become a ClickUp subtask. `description` is already the final
 * body (the caller owns its wording), `severity` drives the priority, `screenshots`
 * are run-relative paths the server resolves against the run's output folder — empty
 * for sources that carry no evidence, like a Design Check finding.
 */
export interface FilingItem {
  id: string
  title: string
  description: string
  severity: string | null
  screenshots: string[]
}

/** Map a parsed severity word onto a display label + our status-color palette. */
export function severityMeta(sev: string): { label: string; className: string } {
  if (/critical|blocker|urgent/.test(sev))
    return { label: sev, className: 'border-red-200 bg-red-50 text-red-700' }
  if (/high/.test(sev)) return { label: sev, className: 'border-amber-200 bg-amber-50 text-amber-700' }
  if (/medium|moderate|normal/.test(sev))
    return { label: sev, className: 'border-blue-200 bg-blue-50 text-blue-700' }
  return { label: sev, className: 'border-border bg-muted text-muted-foreground' } // low / minor / trivial
}

/**
 * Severity word -> the ClickUp priority label the bug will be filed with. MIRRORS
 * `severityPriority()` in server/src/clickup.ts. Display only — see the file header.
 */
export function priorityFromSeverity(severity: string | null): string | null {
  const s = (severity ?? '').toLowerCase()
  if (!s) return null
  if (/blocker|critical|urgent|showstopper/.test(s)) return 'Urgent'
  if (/high|major|severe/.test(s)) return 'High'
  if (/medium|moderate|normal/.test(s)) return 'Normal'
  if (/low|minor|trivial|cosmetic|nit/.test(s)) return 'Low'
  return null
}

/** Strip the server's `ClickUp attachment <status>: ` envelope from a failure
 *  reason — "ClickUp attachment 400: Over allocated storage" → "Over allocated
 *  storage". The surrounding UI already says these are ClickUp attachments. */
export function screenshotErrorSentence(err?: string | null): string | undefined {
  if (!err) return undefined
  return err.replace(/^ClickUp attachment \d+: /, '') || undefined
}

/** Long-form version of a created card's inherited fields, for the chip's tooltip. */
export function appliedSummary(applied?: AppliedIssueFields): string | undefined {
  if (!applied) return undefined
  const parts = [
    applied.assignees.length
      ? `Assigned to ${applied.assignees.join(', ')}`
      : 'Unassigned (the parent ticket has no assignee)',
    applied.priority
      ? `Priority ${applied.priority}${applied.prioritySource === 'severity' ? ' (from the issue severity)' : applied.prioritySource === 'parent' ? ' (from the parent ticket)' : ''}`
      : 'No priority (neither the issue nor the parent had one)',
    applied.screenshots
      ? `${applied.screenshots} screenshot${applied.screenshots === 1 ? '' : 's'} attached${applied.commented ? ' and posted as a comment' : ''}`
      : 'No screenshots attached',
  ]
  if (applied.screenshotsFailed) {
    const why = screenshotErrorSentence(applied.screenshotsError)
    parts.push(
      why
        ? `${applied.screenshotsFailed} could not be attached (${why})`
        : `${applied.screenshotsFailed} could not be attached`,
    )
  }
  return parts.join(' · ')
}

/**
 * Turn a thrown API error into one readable sentence. `request()` throws the raw
 * response body, so a ClickUp failure arrives as `{"error":"ClickUp API 404: {…}"}`
 * — which is what the panel used to print at the engineer verbatim.
 */
export function errorSentence(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!raw.trim()) return fallback
  let text = raw.trim()
  try {
    const parsed = JSON.parse(text) as { error?: string }
    if (parsed?.error) text = parsed.error
  } catch {
    /* not JSON — use it as-is */
  }
  // ClickUp appends its own JSON body: "ClickUp API 404: {"err":"Not found",…}".
  const nested = text.match(/^(.*?)[:\s]*\{.*"err"\s*:\s*"([^"]+)".*\}\s*$/)
  if (nested) text = `${nested[1].trim()} — ${nested[2]}`
  return text.slice(0, 240) || fallback
}

/**
 * Hold a value still for `ms` after the last change. Used by the ClickUp parent field:
 * the filing-context lookup is a real API call, so it must not fire per keystroke.
 */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return settled
}
