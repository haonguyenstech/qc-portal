/**
 * "mỗi ngày lúc 9h tóm tắt ticket mới" → `0 9 * * *` plus "tóm tắt ticket mới".
 *
 * The composer's `/scheduled` command lets an engineer type one sentence, so SOMETHING has
 * to turn that sentence into a cron expression and a task. Two layers, in this order:
 *
 * 1. **This module — deterministic, instant, free.** It recognises the phrasings people
 *    actually use for a recurring QC task, in English and Vietnamese (the two languages
 *    this portal is used in), and returns the cron plus the leftover text as the prompt.
 * 2. **Claude — only when layer 1 finds no timing at all** (`routes/schedules.ts` `/parse`).
 *    A model round trip for "every day at 9" would be a second of latency and a cost for
 *    something a regex answers exactly.
 *
 * What it must NEVER do is guess. A sentence with no recognisable timing returns null and
 * the caller escalates; it does not quietly schedule something for midnight. And whatever
 * either layer produces is shown in a confirmation dialog before anything is stored — the
 * engineer approves a schedule, they never discover one.
 *
 * **Matching happens on a LENGTH-PRESERVING de-accented copy**, and every hit is recorded
 * as a `[start, end)` span into the ORIGINAL string. That is the whole trick that makes
 * the leftover prompt read properly: matching "luc 9h" against "lúc 9h" with
 * `String.normalize('NFD')` would shift every index after the first accent, so the strip
 * cut the wrong characters and left "9h" glued to the front of the task.
 */

export type Span = [number, number]

export interface ParsedWhen {
  cron: string
  /** Character ranges of the ORIGINAL text this consumed, for `stripWhen`. */
  spans: Span[]
}

/**
 * Lower-case and de-accent, ONE OUTPUT CHARACTER PER INPUT CHARACTER, so an index into the
 * result is an index into the input. `đ` → `d` is the one non-decomposable case.
 */
function flatten(s: string): string {
  let out = ''
  for (const ch of s.toLowerCase()) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    // A character that decomposes to several base letters (none in Vietnamese, but e.g.
    // a ligature) would break the 1:1 mapping — keep the original in that case.
    out += base.length === 1 ? base : ch
  }
  return out
}

const VI_WEEKDAYS: [RegExp, number][] = [
  [/\bchu nhat\b|\bcn\b/g, 0],
  [/\bthu (?:2|hai)\b/g, 1],
  [/\bthu (?:3|ba)\b/g, 2],
  [/\bthu (?:4|tu)\b/g, 3],
  [/\bthu (?:5|nam)\b/g, 4],
  [/\bthu (?:6|sau)\b/g, 5],
  [/\bthu (?:7|bay)\b/g, 6],
]

const EN_WEEKDAYS: [RegExp, number][] = [
  [/\bsun(?:day)?s?\b/g, 0],
  [/\bmon(?:day)?s?\b/g, 1],
  [/\btues?(?:day)?s?\b/g, 2],
  [/\bwed(?:nesday)?s?\b/g, 3],
  // "thur" at minimum, never bare "thu": Vietnamese "thứ 5" flattens to "thu 5", and an
  // English Thursday abbreviation that swallowed it turned "thứ 2" into Monday AND Thursday.
  [/\bthur(?:s)?(?:day)?s?\b/g, 4],
  [/\bfri(?:day)?s?\b/g, 5],
  [/\bsat(?:urday)?s?\b/g, 6],
]

/** Every match of `re` in the flattened text, as spans + captures. */
function findAll(flat: string, re: RegExp): { span: Span; groups: string[] }[] {
  const out: { span: Span; groups: string[] }[] = []
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
  for (const m of flat.matchAll(rx)) {
    const i = m.index ?? 0
    out.push({ span: [i, i + m[0].length], groups: m.slice(1) as string[] })
  }
  return out
}

/** The first match, or null. */
function findOne(flat: string, re: RegExp): { span: Span; groups: string[] } | null {
  return findAll(flat, re)[0] ?? null
}

interface TimeHit {
  hour: number
  minute: number
  span: Span
}

/** A period word right after a time ("9 giờ chiều", "9 pm") belongs to the time span. */
const PERIOD_AFTER = /^\s*(sang|trua|chieu|toi|dem|morning|afternoon|evening|night)\b/

function extendOverPeriod(flat: string, span: Span): Span {
  const m = PERIOD_AFTER.exec(flat.slice(span[1]))
  return m ? [span[0], span[1] + m[0].length] : span
}

/**
 * The clock time in a sentence: `9am`, `9:30`, `at 17:00`, `lúc 9h`, `9h30`, `14 giờ`,
 * `9 giờ chiều`.
 *
 * A bare number only reads as a time when a marker (`at`, `lúc`, `am/pm`, `h`, `giờ`, or a
 * `hh:mm` colon) says it is one — otherwise "summarise 5 tickets" would be scheduled for
 * 05:00.
 */
function findTime(flat: string): TimeHit | null {
  // 9am / 9:30 pm / 9.30am
  const ampm = findOne(flat, /\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/)
  if (ampm) {
    let h = Number(ampm.groups[0]) % 12
    if (ampm.groups[2] === 'pm') h += 12
    return { hour: h, minute: Number(ampm.groups[1] ?? 0), span: ampm.span }
  }
  // Vietnamese: lúc 9h, 9h30, 14 giờ  (an optional "vào lúc" / "lúc" prefix comes too)
  const vi = findOne(flat, /(?:\b(?:vao\s+)?luc\s*)?\b(\d{1,2})\s*(?:h|gio)(?:\s*(\d{2}))?\b/)
  if (vi) {
    let h = Number(vi.groups[0])
    const m = Number(vi.groups[1] ?? 0)
    if (h <= 23 && m <= 59) {
      const span = extendOverPeriod(flat, vi.span)
      // "chiều"/"tối" push a 1-12 hour into the afternoon — "3 giờ chiều" is 15:00.
      if (/(chieu|toi|dem)/.test(flat.slice(span[0], span[1])) && h < 12) h += 12
      return { hour: h, minute: m, span }
    }
  }
  // at 9 / at 09:30 / at 9.30
  const at = findOne(flat, /\b(?:at|vao)\s+(\d{1,2})(?:[:.](\d{2}))?\b/)
  if (at) {
    const h = Number(at.groups[0])
    const m = Number(at.groups[1] ?? 0)
    if (h <= 23 && m <= 59) {
      const span = extendOverPeriod(flat, at.span)
      return { hour: /(pm|chieu|toi|evening|night)/.test(flat.slice(span[0], span[1])) && h < 12 ? h + 12 : h, minute: m, span }
    }
  }
  // A bare 24h clock ("09:30") anywhere is unambiguous enough to take.
  const bare = findOne(flat, /\b([01]?\d|2[0-3]):([0-5]\d)\b/)
  if (bare) return { hour: Number(bare.groups[0]), minute: Number(bare.groups[1]), span: bare.span }
  return null
}

/**
 * Weekdays named in the text.
 *
 * Vietnamese runs FIRST and its hits are blanked out of the copy English is matched
 * against: "thứ 2" flattens to "thu 2", and letting the English patterns see it made
 * "every Monday" also mean Thursday.
 */
function collectWeekdays(flat: string): { days: number[]; spans: Span[] } {
  const days = new Set<number>()
  const spans: Span[] = []
  let rest = flat
  const take = (re: RegExp, d: number) => {
    for (const hit of findAll(rest, re)) {
      days.add(d)
      spans.push(hit.span)
      rest = `${rest.slice(0, hit.span[0])}${' '.repeat(hit.span[1] - hit.span[0])}${rest.slice(hit.span[1])}`
    }
  }
  for (const [re, d] of VI_WEEKDAYS) take(re, d)
  for (const [re, d] of EN_WEEKDAYS) take(re, d)
  return { days: [...days].sort((a, b) => a - b), spans }
}

/**
 * Pull a span backwards over the word that introduced it — "MỖI thứ 2", "EVERY Monday".
 *
 * Without this the introducer is left behind in the task ("mỗi, kiểm tra các ticket chưa
 * có test case"), and it cannot simply be deleted everywhere instead: de-accented, `moi`
 * is also "mới" ("new"), which is a real word in "tóm tắt ticket mới". Only an occurrence
 * that is actually adjacent to a timing phrase is timing.
 */
const INTRODUCER = /(?:\b(?:moi|hang|cac|every|each|vao|luc)\s+)$/

function extendOverIntroducer(flat: string, span: Span): Span {
  const m = INTRODUCER.exec(flat.slice(0, span[0]))
  return m ? [span[0] - m[0].length, span[1]] : span
}

/** A keyword hit that also contributes its span ("every day", "hàng tuần", "weekdays"). */
function keyword(flat: string, re: RegExp, spans: Span[]): boolean {
  const hit = findOne(flat, re)
  if (!hit) return false
  spans.push(hit.span)
  return true
}

/**
 * Read a recurrence out of free text, or null when there is nothing to read.
 *
 * Order matters: an interval ("every 15 minutes") wins over a clock time, because
 * "every 30 minutes starting at 9" is an interval with a clock time inside it, and
 * scheduling it once at 09:00 would be a wrong answer rather than a rough one.
 */
export function parseWhen(input: string): ParsedWhen | null {
  const text = String(input ?? '')
  const flat = flatten(text)
  const spans: Span[] = []

  // ---- intervals
  const everyMin =
    findOne(flat, /\b(?:every|each)\s+(\d{1,3})\s*(?:min(?:ute)?s?|m)\b/) ??
    findOne(flat, /\b(?:moi|cach|sau)\s+(\d{1,3})\s*phut\b/) ??
    findOne(flat, /\b(\d{1,3})\s*phut\s*(?:mot lan|\/\s*lan)\b/)
  if (everyMin) {
    const n = Math.min(Math.max(Number(everyMin.groups[0]), 1), 59)
    return { cron: `*/${n} * * * *`, spans: [everyMin.span] }
  }
  const everyHour =
    findOne(flat, /\b(?:every|each)\s+(\d{1,2})\s*(?:hours?|hrs?|h)\b/) ??
    findOne(flat, /\b(?:moi|cach|sau)\s+(\d{1,2})\s*(?:gio|tieng)\b/)
  if (everyHour) {
    const n = Math.min(Math.max(Number(everyHour.groups[0]), 1), 23)
    return { cron: `0 */${n} * * *`, spans: [everyHour.span] }
  }
  const hourly = findOne(flat, /\b(?:hourly|every hour|moi gio)\b/)
  if (hourly) return { cron: `0 * * * *`, spans: [hourly.span] }

  // ---- a clock time, plus whatever day scope surrounds it
  const time = findTime(flat)
  if (time) spans.push(time.span)
  const { days, spans: daySpans } = collectWeekdays(flat)
  spans.push(...daySpans)

  const monthly = keyword(flat, /\b(monthly|every month|hang thang|moi thang)\b/, spans)
  const domHit = monthly ? findOne(flat, /\b(?:on\s+(?:the\s+)?|ngay\s+)(\d{1,2})(?:st|nd|rd|th)?\b/) : null
  if (domHit) spans.push(domHit.span)
  const weekday = keyword(
    flat,
    /\b(weekdays?|working days?|business days?|ngay thuong|ngay lam viec|cac ngay trong tuan)\b/,
    spans,
  )
  const weekend = keyword(flat, /\b(weekends?|cuoi tuan)\b/, spans)
  const weekly = keyword(flat, /\b(weekly|every week|hang tuan|moi tuan)\b/, spans)
  const daily = keyword(
    flat,
    /\b(daily|every day|each day|every morning|every evening|every night|hang ngay|moi ngay|moi sang|moi toi|moi chieu)\b/,
    spans,
  )

  if (!time && !days.length && !weekday && !weekend && !monthly && !weekly && !daily) return null

  // A day scope with no clock time defaults to 9:00 — the start of a QC working day, and
  // the one convention worth having, since "every Monday" with no hour is otherwise
  // unschedulable. The dialog shows it like everything else, so it is a default the
  // engineer sees and can change, not a hidden one.
  const hour = time ? time.hour : 9
  const minute = time ? time.minute : 0
  const dom = domHit ? Math.min(Math.max(Number(domHit.groups[0]), 1), 31) : null
  // Swallow the introducer in front of each hit, so "mỗi thứ 2 lúc 8h" leaves only the task.
  for (let i = 0; i < spans.length; i++) spans[i] = extendOverIntroducer(flat, spans[i])

  if (monthly) return { cron: `${minute} ${hour} ${dom ?? 1} * *`, spans }
  if (days.length) return { cron: `${minute} ${hour} * * ${days.join(',')}`, spans }
  if (weekday) return { cron: `${minute} ${hour} * * 1-5`, spans }
  if (weekend) return { cron: `${minute} ${hour} * * 0,6`, spans }
  if (weekly) return { cron: `${minute} ${hour} * * 1`, spans }
  return { cron: `${minute} ${hour} * * *`, spans }
}

/**
 * Words left over from the timing that are not part of the task: the preposition or
 * conjunction that joined them ("every day AT 9AM AND summarise…"). Matched on the
 * flattened text AFTER the spans are blanked, so only orphans are hit.
 */
const ORPHANS = [
  // Deliberately short. `moi` was in this list until "mới" ("new") was silently deleted
  // from "tóm tắt ticket mới" — a de-accented word is not a timing word just because a
  // timing word flattens to the same letters, so only ones with no other everyday
  // meaning are here.
  /(^|[\s,])(at|on|every|each|and|luc)(?=[\s,]|$)/g,
]

/**
 * The task, with the timing taken out: "every day at 9am summarise new tickets" →
 * "summarise new tickets".
 *
 * If stripping would leave nothing (the engineer typed only a time), the ORIGINAL text is
 * returned rather than an empty prompt — a task with no instruction is the one thing the
 * confirmation dialog cannot ask anybody to approve.
 */
export function stripWhen(input: string, spans: Span[]): string {
  const text = String(input ?? '')
  if (!text.trim()) return ''
  // Blank the spans in place (rather than splice them out) so every remaining span index
  // still points where it did — they were all measured against the same original string.
  const chars = [...text]
  for (const [a, b] of spans) {
    for (let i = Math.max(0, a); i < Math.min(chars.length, b); i++) chars[i] = ' '
  }
  let out = chars.join('')
  // Orphan removal runs on the flattened copy so "lúc" and "luc" are one rule; the match
  // spans are then blanked out of the real text, same trick as above.
  for (const re of ORPHANS) {
    const flat = flatten(out)
    const marks: Span[] = []
    for (const m of flat.matchAll(re)) {
      const i = (m.index ?? 0) + (m[1]?.length ?? 0)
      marks.push([i, i + m[2].length])
    }
    const c = [...out]
    for (const [a, b] of marks) for (let i = a; i < b; i++) c[i] = ' '
    out = c.join('')
  }
  out = out
    .replace(/\s*[,;:]\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, '')
    .trim()
  return out || text.trim()
}

/** A short title from the task text — the first clause, capped, without trailing punctuation. */
export function titleFrom(prompt: string): string {
  const first = String(prompt ?? '')
    .split(/[\n.!?]/)[0]
    .trim()
    .replace(/\s+/g, ' ')
  if (!first) return 'Scheduled task'
  const short = first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first
  return short.charAt(0).toUpperCase() + short.slice(1)
}
