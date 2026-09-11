/**
 * Cron parsing, "when does this fire next?", and the English sentence the UI shows.
 *
 * A scheduled task has to answer two questions at once — "when does it run?" (a machine
 * question, answered by a cron expression) and "when does it run?" (a human question,
 * answered by "Every weekday at 9:00 AM"). Both come from HERE, so the row on the
 * Scheduled page and the timer that actually fires can never disagree. The browser is
 * deliberately given no cron parser of its own: the server sends `nextRunAt` and
 * `description` down with every schedule.
 *
 * Five fields only (minute hour day-of-month month day-of-week) — no seconds field and no
 * `@daily` aliases. The scheduler ticks once a minute, so a seconds field would be a lie,
 * and every alias has a plain five-field spelling the describer already reads.
 *
 * LOCAL TIME, always. A QC engineer who says "every day at 9" means 9 on the clock on the
 * wall next to them, and the portal runs on that same machine. Firing is computed by
 * walking local calendar fields (not by adding 86_400_000 ms), so the hour stays 9 across
 * a DST change instead of drifting to 8 or 10.
 */

export interface CronFields {
  minute: number[]
  hour: number[]
  dom: number[]
  month: number[]
  dow: number[]
  /** True when the field was a bare `*` — needed by the day rule below. */
  domStar: boolean
  dowStar: boolean
}

const DOW_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
}

const MONTH_NAMES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
}

function fieldValue(raw: string, kind: 'dow' | 'month' | 'num'): number {
  const t = raw.trim().toLowerCase()
  if (kind === 'dow' && t in DOW_NAMES) return DOW_NAMES[t]
  if (kind === 'month' && t in MONTH_NAMES) return MONTH_NAMES[t]
  if (!/^\d{1,4}$/.test(t)) throw new Error(`"${raw}" is not a number this field understands`)
  return Number(t)
}

/**
 * One cron field → the sorted list of values it matches.
 *
 * Out-of-range values are an ERROR, not a clamp: `0 25 * * *` clamped to 23:00 would be a
 * task that silently runs at a time nobody asked for, which is worse than a rejected form.
 */
function parseField(
  raw: string,
  min: number,
  max: number,
  kind: 'dow' | 'month' | 'num',
  label: string,
): number[] {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    const piece = part.trim()
    if (!piece) throw new Error(`empty ${label} value`)
    const [range, stepRaw] = piece.split('/')
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step "/${stepRaw}" in ${label}`)
    let lo: number
    let hi: number
    if (range === '*' || range === '?') {
      lo = min
      hi = max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-')
      lo = fieldValue(a, kind)
      hi = fieldValue(b, kind)
    } else {
      lo = fieldValue(range, kind)
      hi = stepRaw === undefined ? lo : max
    }
    // Sunday is 0 AND 7 in every cron dialect; normalise before the range check so
    // `* * * * 7` doesn't read as out of range.
    if (kind === 'dow') {
      if (lo === 7) lo = 0
      if (hi === 7) hi = 0
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`${label} "${piece}" is outside ${min}-${max}`)
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  if (!out.size) throw new Error(`${label} matches nothing`)
  return [...out].sort((a, b) => a - b)
}

/** Parse a five-field cron expression, or throw with a sentence a QC engineer can act on. */
export function parseCron(expr: string): CronFields {
  const parts = String(expr ?? '').trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new Error(
      `A schedule needs 5 cron fields (minute hour day-of-month month day-of-week); got ${parts.length ? parts.length : 0}`,
    )
  }
  const [mi, ho, dm, mo, dw] = parts
  return {
    minute: parseField(mi, 0, 59, 'num', 'minute'),
    hour: parseField(ho, 0, 23, 'num', 'hour'),
    dom: parseField(dm, 1, 31, 'num', 'day of month'),
    month: parseField(mo, 1, 12, 'month', 'month'),
    dow: parseField(dw, 0, 6, 'dow', 'day of week'),
    domStar: dm.trim() === '*' || dm.trim() === '?',
    dowStar: dw.trim() === '*' || dw.trim() === '?',
  }
}

/** True when `expr` parses. Used by the routes to reject a bad form before it is stored. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/**
 * Does this calendar day match the day fields?
 *
 * The famous cron rule: when BOTH day-of-month and day-of-week are restricted the day
 * matches if EITHER does (so `0 9 1 * mon` is "the 1st, and every Monday"). When only one
 * is restricted, only that one decides.
 */
function dayMatches(f: CronFields, d: Date): boolean {
  if (!f.month.includes(d.getMonth() + 1)) return false
  const domOk = f.dom.includes(d.getDate())
  const dowOk = f.dow.includes(d.getDay())
  if (f.domStar && f.dowStar) return true
  if (f.domStar) return dowOk
  if (f.dowStar) return domOk
  return domOk || dowOk
}

/** How far ahead we are willing to look. Nothing legal fires less often than once a year. */
const MAX_DAYS_AHEAD = 1500

/**
 * The next firing STRICTLY after `from`, or null when the expression can never fire
 * (`0 0 30 2 *` — the 30th of February). Null is a real answer the UI shows, not an error:
 * the schedule is stored, it just never comes due.
 */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  const f = parseCron(expr)
  // Start at the top of the NEXT minute: a run that just fired at 09:00:30 must not be
  // handed 09:00 again as its next slot.
  const cursor = new Date(from.getTime())
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  for (let day = 0; day < MAX_DAYS_AHEAD; day++) {
    const probe = new Date(cursor.getTime())
    probe.setDate(probe.getDate() + day)
    if (day > 0) probe.setHours(0, 0, 0, 0)
    if (!dayMatches(f, probe)) continue
    for (const h of f.hour) {
      if (h < probe.getHours()) continue
      for (const m of f.minute) {
        if (h === probe.getHours() && m < probe.getMinutes()) continue
        const hit = new Date(probe.getTime())
        hit.setHours(h, m, 0, 0)
        // A spring-forward hour does not exist on the wall clock; setHours lands on the
        // hour after it, which is the behaviour every other cron has. The guard is only
        // here so a skipped hour can never hand back a time in the past.
        if (hit.getTime() > from.getTime()) return hit
      }
    }
  }
  return null
}

/** `nextRun` as an ISO string, or null — the shape stored on the row and sent to the UI. */
export function nextRunIso(expr: string, from: Date = new Date()): string | null {
  try {
    return nextRun(expr, from)?.toISOString() ?? null
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ describing

const DOW_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_LABEL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function clock(h: number, m: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** Is this list exactly `min..max` stepped by `step`? (How a stepped field is recognised back.) */
function isStep(values: number[], min: number, max: number): number | null {
  if (values.length < 2) return null
  const step = values[1] - values[0]
  if (values[0] !== min) return null
  for (let i = 1; i < values.length; i++) if (values[i] - values[i - 1] !== step) return null
  if (values[values.length - 1] + step <= max) return null
  return step
}

function dayPhrase(f: CronFields): string {
  const everyDay = f.domStar && f.dowStar
  if (everyDay) return 'every day'
  const parts: string[] = []
  if (!f.dowStar) {
    const d = f.dow
    if (d.length === 5 && d.join() === '1,2,3,4,5') parts.push('every weekday')
    else if (d.length === 2 && d.join() === '0,6') parts.push('every weekend day')
    else parts.push(`every ${joinList(d.map((n) => DOW_LABEL[n]))}`)
  }
  if (!f.domStar) {
    const step = isStep(f.dom, 1, 31)
    if (step && f.dom[0] === 1) parts.push(`every ${step} days`)
    else parts.push(`on day ${joinList(f.dom.map(String))} of the month`)
  }
  return joinList(parts)
}

/**
 * The sentence under a schedule's title ("Every weekday at 9:00 AM").
 *
 * It is generated from the SAME parse the timer uses, so it cannot describe a schedule
 * other than the one that will fire. Anything it has no phrasing for degrades to the cron
 * expression itself rather than to a wrong sentence.
 */
export function describeCron(expr: string): string {
  let f: CronFields
  try {
    f = parseCron(expr)
  } catch {
    return `cron ${expr}`
  }
  const monthPart =
    f.month.length === 12 ? '' : ` in ${joinList(f.month.map((n) => MONTH_LABEL[n - 1]))}`

  const minuteStep = isStep(f.minute, 0, 59)
  const everyHour = f.hour.length === 24
  const day = dayPhrase(f)
  const dayTail = day === 'every day' ? '' : `, ${day}`

  // Every N minutes
  if (minuteStep && everyHour) {
    return `Every ${minuteStep === 1 ? 'minute' : `${minuteStep} minutes`}${dayTail}${monthPart}`
  }
  if (f.minute.length === 60 && everyHour) return `Every minute${dayTail}${monthPart}`
  // Hourly at :mm
  if (f.minute.length === 1 && everyHour) {
    return `Every hour at :${String(f.minute[0]).padStart(2, '0')}${dayTail}${monthPart}`
  }
  // Every N hours at :mm
  const hourStep = isStep(f.hour, 0, 23)
  if (f.minute.length === 1 && hourStep) {
    return `Every ${hourStep} hours at :${String(f.minute[0]).padStart(2, '0')}${dayTail}${monthPart}`
  }
  // A handful of explicit times
  if (f.minute.length * f.hour.length <= 6) {
    const times: string[] = []
    for (const h of f.hour) for (const m of f.minute) times.push(clock(h, m))
    const when = day === 'every day' ? 'Every day' : day.charAt(0).toUpperCase() + day.slice(1)
    return `${when} at ${joinList(times)}${monthPart}`
  }
  return `cron ${expr}`
}
