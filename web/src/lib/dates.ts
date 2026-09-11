/**
 * Local-time conversion between the `YYYY-MM-DD` strings our API query params
 * use and the `Date` objects the calendar works in.
 *
 * WHY THIS IS HAND-WRITTEN RATHER THAN `new Date(s)` / `toISOString()`
 * `new Date('2026-09-01')` parses as **UTC midnight**, so in any negative-UTC
 * timezone it renders as 31 Aug — a picker built on it shows the day before the
 * one that is stored, and writes back the day before the one that was clicked.
 * `toISOString().slice(0, 10)` has the mirror-image bug in positive offsets.
 * Both helpers here therefore touch local parts only.
 */

/** `YYYY-MM-DD` -> a Date at LOCAL midnight, or undefined when unset/invalid. */
export function parseDay(value: string | null | undefined): Date | undefined {
  if (!value) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return undefined
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** A Date -> `YYYY-MM-DD`, read from its LOCAL parts. */
export function formatDay(date: Date | undefined): string {
  if (!date) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
