import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH } from './config.js'

// The MailBox page: a throwaway inbox for QC — the address you paste into a sign-up
// form to read the confirmation mail, the OTP, the reset link.
//
// WHY NOT YOPMAIL, which is what everyone asks for: YOPmail has no API. An inbox URL
// requested without the tokens its own JavaScript computes (`yp`, `yj`, `ctrl`, plus
// the `yses`/`yc` cookies) answers **HTTP 400** and a redirect to the home page, and
// `x-frame-options: sameorigin` rules out embedding the real thing in an iframe. That
// leaves scraping a page whose tokens rotate with their version file — a feature that
// breaks on their schedule, not ours. Guerrilla Mail publishes an actual JSON API and
// behaves the same way where it counts: think up any address, it exists already, no
// sign-up. The trade is the domain (`@guerrillamailblock.com`, not `@yopmail.com`).
//
// Session: Guerrilla identifies an inbox by a `sid_token`, and the address is a
// property of that session. Losing the token means losing the inbox — including the
// address already typed into the app under test — so it is persisted BESIDE THE
// DATABASE (like totp.ts / apiAccounts.ts), never in a project folder, and survives a
// portal restart. It is not a credential to anything but a disposable mailbox, but it
// is the key to one, so the file is 0600 and the token never reaches the browser.

const API = 'https://api.guerrillamail.com/ajax.php'

/** Guerrilla asks callers not to poll harder than this. The UI's auto-refresh obeys it. */
export const MIN_POLL_MS = 10_000

/** Their timeout is generous; ours is not — this page must never hang the UI. */
const FETCH_TIMEOUT_MS = 15_000

export interface MailboxSession {
  sidToken: string
  address: string
  createdAt: string
}

export interface MailSummary {
  id: string
  from: string
  subject: string
  excerpt: string
  /** ISO when Guerrilla gave a real timestamp, else their `HH:MM:SS` string as-is. */
  date: string
  read: boolean
}

export interface MailDetail extends MailSummary {
  /** The raw HTML body, exactly as delivered. Rendered SANDBOXED — see MailBoxPage. */
  body: string
  to: string
  /**
   * How many attachments the mail carries. Reported, not offered: a mail whose PDF is
   * silently dropped reads as a mail that never had one, and that is a QC engineer
   * chasing a bug in the wrong system.
   */
  attachments: number
}

// ------------------------------------------------------------------ the store

const storeFile = () => path.join(path.dirname(DB_PATH), 'mailbox.json')

function readStore(): MailboxSession | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8')) as Partial<MailboxSession>
    if (typeof parsed?.sidToken !== 'string' || typeof parsed?.address !== 'string') return null
    return {
      sidToken: parsed.sidToken,
      address: parsed.address,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
    }
  } catch {
    return null // never opened, or an unreadable file — either way, start fresh
  }
}

function writeStore(session: MailboxSession | null): void {
  const file = storeFile()
  if (!session) {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* nothing to forget */
    }
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** In-memory mirror so the common path doesn't re-read the file on every poll. */
let cached: MailboxSession | null | undefined

function currentSession(): MailboxSession | null {
  if (cached === undefined) cached = readStore()
  return cached
}

function saveSession(session: MailboxSession | null): void {
  cached = session
  writeStore(session)
}

// ------------------------------------------------------------------ the API client

interface GuerrillaResponse {
  email_addr?: string
  sid_token?: string
  alias_error?: string
  list?: unknown[]
  count?: string | number
  [key: string]: unknown
}

/**
 * One call to Guerrilla Mail.
 *
 * `agent` is passed because their API uses it (with the caller's IP) to bind the
 * session; a call that omits it can be handed a different inbox than the one before.
 * Errors are normalised to a sentence a QC engineer can act on — this page is offline
 * far more often than it is broken (a portal on a locked-down network, a captive
 * portal), and "fetch failed" reads as a portal bug.
 */
async function call(params: Record<string, string>): Promise<GuerrillaResponse> {
  const url = new URL(API)
  url.searchParams.set('agent', 'qc-portal')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  let res: Response
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json', 'User-Agent': 'qc-portal' },
    })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'is unreachable'
    throw new Error(
      `The disposable-mail service ${why}. This page needs internet access to api.guerrillamail.com.`,
    )
  }
  if (!res.ok) throw new Error(`The disposable-mail service answered ${res.status}.`)
  const text = await res.text()
  try {
    return JSON.parse(text) as GuerrillaResponse
  } catch {
    // They serve an HTML error page when rate-limited, which is the one failure a
    // QC engineer can actually fix (by polling less), so say that rather than
    // "unexpected token < in JSON".
    throw new Error(
      'The disposable-mail service did not answer with JSON — usually too many requests in a row. Wait a few seconds and refresh.',
    )
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/**
 * Guerrilla dates: `mail_timestamp` is a unix seconds value on real mail but 0 on
 * their welcome message, and `mail_date` is a bare `HH:MM:SS`. Prefer the timestamp,
 * fall back to the string — never invent a date, because "when did this arrive" is
 * exactly the question being asked when an OTP doesn't work.
 */
function mailDate(raw: Record<string, unknown>): string {
  const ts = Number(raw.mail_timestamp)
  if (Number.isFinite(ts) && ts > 0) return new Date(ts * 1000).toISOString()
  return str(raw.mail_date)
}

function toSummary(raw: Record<string, unknown>): MailSummary {
  return {
    id: str(raw.mail_id),
    from: str(raw.mail_from),
    subject: str(raw.mail_subject) || '(no subject)',
    excerpt: str(raw.mail_excerpt),
    date: mailDate(raw),
    read: str(raw.mail_read) === '1',
  }
}

// ------------------------------------------------------------------ operations

/** The inbox as it stands, creating one on first use. */
export async function getMailbox(): Promise<MailboxSession> {
  const existing = currentSession()
  if (existing) return existing
  const res = await call({ f: 'get_email_address', lang: 'en' })
  const session: MailboxSession = {
    sidToken: str(res.sid_token),
    address: str(res.email_addr),
    createdAt: new Date().toISOString(),
  }
  if (!session.sidToken || !session.address) {
    throw new Error('The disposable-mail service did not hand out an address.')
  }
  saveSession(session)
  return session
}

/**
 * Rename the inbox — "think up any address" is the whole point of a service like this,
 * and it is how a QC engineer keeps one address per test run readable
 * (`checkout-otp@…` rather than `chgtsdka@…`).
 *
 * Renaming does NOT start a new session: the same sid_token now answers for the new
 * address, and mail already in the box stays.
 */
export async function setMailboxName(name: string): Promise<MailboxSession> {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '')
  if (!clean) throw new Error('An address needs at least one letter or digit.')
  if (clean.length > 64) throw new Error('That address is too long (64 characters max).')
  const session = await getMailbox()
  const res = await call({
    f: 'set_email_user',
    email_user: clean,
    lang: 'en',
    sid_token: session.sidToken,
  })
  const error = str(res.alias_error)
  if (error) throw new Error(error)
  const address = str(res.email_addr)
  if (!address) throw new Error('The disposable-mail service refused that address.')
  const next: MailboxSession = {
    ...session,
    address,
    sidToken: str(res.sid_token) || session.sidToken,
  }
  saveSession(next)
  return next
}

/** Abandon this inbox and take a fresh random one. */
export async function resetMailbox(): Promise<MailboxSession> {
  const session = currentSession()
  if (session) {
    // Best effort: if forgetting fails, a new session is still the right outcome.
    await call({ f: 'forget_me', sid_token: session.sidToken }).catch(() => ({}))
  }
  saveSession(null)
  return getMailbox()
}

/**
 * What's in the box.
 *
 * `get_email_list`, NOT `check_email`. `check_email` is a DELTA call: it answers with
 * what arrived since the session's own internal marker, so the second call returns an
 * empty list even when the inbox has mail in it — measured here, with the welcome
 * message sitting in the box the whole time. A page that can be opened, reloaded or
 * left in a background tab must ask what IS in the inbox, not what is new.
 *
 * Sessions expire (Guerrilla keeps a box about an hour). A dead `sid_token` does NOT
 * error: the response comes back with no `list` and no `email`, just service stats —
 * so without the revival below the page would sit forever on "waiting for mail" against
 * an address that no longer exists, which is the worst way this feature can fail
 * because nothing on screen is wrong. Measured with a made-up token.
 */
export async function listMail(): Promise<{ session: MailboxSession; messages: MailSummary[] }> {
  const session = await getMailbox()
  const res = await call({ f: 'get_email_list', offset: '0', sid_token: session.sidToken })

  if (!Array.isArray(res.list) || !str(res.email)) {
    const revived = await reviveSession(session)
    // One retry only: if the fresh session answers the same way, the service is having
    // a bad day and an empty inbox is the honest answer, not an infinite loop.
    const retry = await call({ f: 'get_email_list', offset: '0', sid_token: revived.sidToken })
    return { session: revived, messages: readList(retry) }
  }

  // Guerrilla can hand back a different address for a session it has expired; trust
  // its answer over ours, or the page would show mail for an address nobody used.
  const address = str(res.email)
  if (address !== session.address) saveSession({ ...session, address })
  return { session: currentSession() ?? session, messages: readList(res) }
}

function readList(res: GuerrillaResponse): MailSummary[] {
  const list = Array.isArray(res.list) ? res.list : []
  return (
    list
      .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
      .map(toSummary)
      // Newest first: the mail being waited for is always the last one to arrive.
      .reverse()
  )
}

/**
 * Take a new session but KEEP THE ADDRESS.
 *
 * The address is only a username here, so asking the fresh session for the same one
 * gets the very same address back — which matters more than the session does: it is
 * already typed into the app under test, and a QC engineer who has to notice a silent
 * rename mid-flow has been handed a bug, not a mailbox. Mail delivered while the old
 * session was dead is gone either way; the address surviving is what keeps the next
 * attempt working.
 */
async function reviveSession(dead: MailboxSession): Promise<MailboxSession> {
  const user = dead.address.split('@')[0]
  saveSession(null)
  const fresh = await getMailbox()
  if (!user || user === fresh.address.split('@')[0]) return fresh
  try {
    return await setMailboxName(user)
  } catch {
    return fresh // the name was refused — a working inbox beats no inbox
  }
}

/** One message, with its body. */
export async function readMail(id: string): Promise<MailDetail> {
  const session = await getMailbox()
  const res = await call({ f: 'fetch_email', email_id: id, sid_token: session.sidToken })
  if (!str(res.mail_id)) throw new Error('That message is no longer in the inbox.')
  const raw = res as Record<string, unknown>
  return {
    ...toSummary(raw),
    to: str(raw.mail_recipient) || session.address,
    body: str(raw.mail_body),
    attachments: Number(raw.att) || 0,
  }
}

/** Delete one message from the inbox. */
export async function deleteMail(id: string): Promise<void> {
  const session = await getMailbox()
  await call({ f: 'del_email', 'email_ids[]': id, sid_token: session.sidToken })
}
