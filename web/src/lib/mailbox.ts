// Pulling the two things a QC engineer actually opens a test mailbox for out of a
// message: the CODE and the LINK. Everything else on the MailBox page is plumbing —
// this is the part that turns "read the mail, squint, retype six digits" into a click.

// ------------------------------------------------------------------ HTML entities

/**
 * Entities that are not a letter-with-accent. `amp` decodes here like any other, in
 * the SAME single pass as the rest — decoding it separately (or first) turns
 * `&amp;#7841;`, which is the literal text "&#7841;", into "ạ".
 */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', bull: '•', middot: '·', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', dagger: '†', permil: '‰',
  prime: '′', Prime: '″', szlig: 'ß', aring: 'å', Aring: 'Å',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', ccedil: 'ç',
  Ccedil: 'Ç', ntilde: 'ñ', Ntilde: 'Ñ', iexcl: '¡', iquest: '¿',
  times: '×', divide: '÷', plusmn: '±', frac12: '½', frac14: '¼',
  frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', not: '¬', macr: '¯',
  acute: '´', cedil: '¸', uml: '¨', ordf: 'ª', ordm: 'º', curren: '¤',
  brvbar: '¦', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
}

/** The Latin-1 vowels-with-accent, lower case; the upper-case twin is derived below. */
const ACCENTED: Record<string, string> = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', yuml: 'ÿ',
}

const ENTITIES: Record<string, string> = { ...NAMED }
for (const [name, char] of Object.entries(ACCENTED)) {
  ENTITIES[name] = char
  // `&Agrave;` — HTML entity names are case-SENSITIVE, so this is a second key, not
  // a case-insensitive lookup: `&AGRAVE;` is not an entity and must stay literal.
  ENTITIES[name[0].toUpperCase() + name.slice(1)] = char.toUpperCase()
}

const ENTITY = /&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g

/**
 * Decode the HTML entities in text that will be rendered AS TEXT.
 *
 * Mail templates written for Vietnamese arrive entity-encoded — `Xin ch&agrave;o`,
 * `M&atilde; x&aacute;c th&#7921;c` — because that is what a mail composer emits for
 * non-ASCII. The body is fine (it renders as HTML in the preview frame), but the
 * subject, the sender and the excerpt are printed as plain strings by React, so
 * without this the inbox reads "Xin ch&agrave;o" and a code hunted out of the
 * flattened text is surrounded by gibberish.
 *
 * NUMERIC refs matter more than named ones here: most Vietnamese letters (ạ ả ấ ầ ơ
 * ư…) have no HTML name at all and can only be written `&#7841;` / `&#x1EA1;`, so both
 * numeric forms are handled with `fromCodePoint`. `fromCharCode` would be wrong for
 * anything above U+FFFF. An unknown name, an out-of-range code point or a lone
 * surrogate is left exactly as written rather than replaced with a wrong character —
 * showing `&notreal;` is honest; showing `\ufffd` is not.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text // the overwhelmingly common case
  return text.replace(ENTITY, (whole, ref: string) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X'
      const cp = hex ? parseInt(ref.slice(2), 16) : Number(ref.slice(1))
      const valid =
        Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      if (!valid) return whole
      try {
        return String.fromCodePoint(cp)
      } catch {
        return whole
      }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ref) ? ENTITIES[ref] : whole
  })
}

/** Plain text from a mail body, which may be HTML, `<pre>`-wrapped text, or neither. */
export function mailText(html: string): string {
  // Tags first, entities second, and never the other way round: decoding `&lt;b&gt;`
  // before the tag strip would invent a tag and then delete the words inside it.
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ') // NBSP included: mail templates are full of them
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Words that mark the number next to them as the code being waited for — in the two
 * languages the QC team reads. Used only for RANKING: a mail whose code sits far from
 * any of these still offers its digits, just lower down.
 */
const CODE_WORDS =
  /\b(code|otp|pin|token|verification|verify|confirm|activation|activate|password|security|mã|mật khẩu|xác (?:thực|minh)|kích hoạt)\b/gi

/** Runs of 4–8 digits (or 6–8 alphanumerics), the shape every OTP in the wild takes. */
const CODE_CANDIDATE = /\b(?=[A-Z0-9-]*\d)[A-Z0-9]{4,8}\b/gi

/**
 * Things that look like a code but never are — measured against real mail, where the
 * competition for "the six digits" is an order number, a price and a year.
 */
function isNoise(value: string, before: string, after: string): boolean {
  if (/^(19|20)\d{2}$/.test(value)) return true // a bare year
  if (/\d$/.test(before) || /^\d/.test(after)) return true // part of a longer number
  if (/#\s*$/.test(before)) return true // "#10023" — an order/ticket id, never an OTP
  if (/^[.,]\d/.test(after)) return true // "1499.00" — an amount
  return false
}

export interface FoundCode {
  value: string
  /** The sentence it came from — the only way to tell two codes in one mail apart. */
  context: string
}

/**
 * Codes in a mail, best first.
 *
 * Ranked, not filtered: guessing wrong and HIDING the real code is the failure that
 * sends someone back to reading the raw mail, which is what this page exists to avoid.
 * A code beside the word "code" (or "mã") wins; ties break on appearing earlier.
 */
export function findCodes(text: string): FoundCode[] {
  // Where every code word sits, once — the ranking is by DISTANCE to the nearest one,
  // not by "a code word appears somewhere near". Presence in a wide window put a
  // 7-digit "Ref" above the actual PIN two words after the word PIN; measured.
  const wordAt = [...text.matchAll(CODE_WORDS)].map((m) => m.index ?? 0)
  const found: { code: FoundCode; score: number; at: number }[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(CODE_CANDIDATE)) {
    const value = m[0]
    const at = m.index ?? 0
    if (seen.has(value)) continue
    if (isNoise(value, text.slice(Math.max(0, at - 2), at), text.slice(at + value.length, at + value.length + 2))) {
      continue
    }
    seen.add(value)
    // A window either side — "Your code is 483920" and "483920 is your code" both count.
    const context = text.slice(Math.max(0, at - 60), at + value.length + 60).replace(/\s+/g, ' ').trim()
    const distance = wordAt.length
      ? Math.min(...wordAt.map((w) => Math.abs(w - at)))
      : Number.POSITIVE_INFINITY
    const digitsOnly = /^\d+$/.test(value)
    found.push({
      code: { value, context },
      // Distance decay, so the code NEXT TO the word beats one in the same paragraph.
      // Shape is a tiebreak only: digits-only, six of them, is the common OTP.
      score: Math.max(0, 40 - Math.min(distance, 40)) + (digitsOnly ? 3 : 0) + (value.length === 6 ? 2 : 0),
      at,
    })
  }
  return found
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .slice(0, 6)
    .map((f) => f.code)
}

const ACTION_WORDS =
  /(verify|confirm|activate|validate|reset|password|signup|sign-up|register|invite|token|magic|login|xac-?thuc|xac-?minh|kich-?hoat|dang-?ky|dat-?lai)/i

export interface FoundLink {
  url: string
  /** True for the links a test flow is actually meant to click. */
  action: boolean
}

/**
 * Links in a mail, action links first.
 *
 * `href`s are read out of the HTML rather than the flattened text, because the
 * clickable URL in a real mail is almost never the one written on screen ("Confirm
 * your email" hides it) — and it is the href that has to be opened.
 */
export function findLinks(html: string, text: string): FoundLink[] {
  const urls = new Set<string>()
  for (const m of html.matchAll(/href\s*=\s*["']((?:https?:)\/\/[^"']+)["']/gi)) urls.add(m[1])
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) urls.add(m[0])
  return [...urls]
    .map((raw) => {
      const url = raw
        .replace(/&amp;/gi, '&')
        // Trailing punctuation belongs to the sentence, not the URL.
        .replace(/[.,;:]+$/, '')
      return { url, action: ACTION_WORDS.test(url) }
    })
    // Guerrilla's own footer links are never what someone came here to click.
    .filter((l) => !/guerrillamail\.com\/?$/i.test(l.url))
    .sort((a, b) => Number(b.action) - Number(a.action))
    .slice(0, 12)
}

/**
 * Every Guerrilla domain delivers to the SAME inbox — the username is the address.
 * The API hands out `guerrillamailblock.com`, which is the one it gives to
 * programmatic clients; a form that rejects it (or an engineer who wants something
 * less alarming to paste into a demo) can hand out any of the others instead.
 */
export const MAIL_DOMAINS = [
  'sharklasers.com',
  'guerrillamail.com',
  'grr.la',
  'pokemail.net',
  'spam.me',
  'guerrillamailblock.com',
]

export const splitAddress = (address: string): { user: string; domain: string } => {
  const at = address.lastIndexOf('@')
  return at < 0
    ? { user: address, domain: MAIL_DOMAINS[0] }
    : { user: address.slice(0, at), domain: address.slice(at + 1) }
}

/**
 * A fresh random address name.
 *
 * Readable on purpose — `qc-amber-otter-4821` can be read down a phone line and told
 * apart from the last run's inbox, which `chgtsdka` cannot. But entropy matters more
 * than looks here: **this service is public and any name can be claimed by anyone**, so
 * a short or guessable name is an inbox someone else may be sitting in — the reason
 * this exists as a button rather than leaving people to type `test1`. Two words plus
 * four digits out of these lists is ~1 in 5 million, on top of the `qc-` prefix.
 */
const NAME_COLOURS = [
  'amber', 'azure', 'coral', 'crimson', 'emerald', 'indigo', 'ivory', 'jade',
  'lilac', 'maroon', 'olive', 'onyx', 'plum', 'rust', 'sage', 'slate', 'teal', 'violet',
]
const NAME_ANIMALS = [
  'otter', 'falcon', 'heron', 'ibex', 'koi', 'lemur', 'lynx', 'marten', 'mantis',
  'newt', 'osprey', 'panda', 'quail', 'raven', 'shrike', 'tapir', 'viper', 'wombat',
]

export function randomMailName(): string {
  const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
  const digits = String(Math.floor(Math.random() * 10_000)).padStart(4, '0')
  return `qc-${pick(NAME_COLOURS)}-${pick(NAME_ANIMALS)}-${digits}`
}
