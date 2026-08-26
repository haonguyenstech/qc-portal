import type { BrowserContext, Page } from 'playwright-core'
import { agentProfileDir } from './browserProfile.js'
import { friendlyLaunchError, loadChromium } from './pageAudit.js'

/**
 * SIGN-IN WINDOW — how a page behind a login becomes measurable.
 *
 * A page audit runs in the persistent profile at `agentProfileDir()`, and this app
 * family keeps its token in **localStorage**, which is scoped per ORIGIN and stored
 * per PROFILE. Two consequences that surprised the engineer and drive this module:
 *
 *   • Being logged in on your own Chrome does nothing — that is a different
 *     profile, and its storage never reaches this one.
 *   • Being logged in to `localhost:5173` in this profile does nothing for
 *     `https://dev.tabeebmed.com` — different origin, different storage.
 *
 * So the only way in is to log in ONCE per origin *inside this profile*. That used
 * to mean a terminal command (`chrome --user-data-dir=…`). This opens the same
 * window from the UI instead: a headed browser on the real profile, held open
 * while the engineer signs in, then closed — which is what flushes the session to
 * disk so every later audit inherits it.
 *
 * ONE AT A TIME, and never while an audit is running: Chrome refuses to open a
 * profile twice, so the routes must serialise these. The window is also closed on
 * server shutdown, or after MAX_MS, so a forgotten Chrome doesn't hold the profile
 * lock forever and block every future audit.
 */

interface Session {
  url: string
  startedAt: string
  context: BrowserContext
  timer: NodeJS.Timeout
}

let current: Session | null = null

/** A sign-in window left open all day is a broken profile lock, not a session. */
const MAX_MS = 20 * 60_000

export interface AuthSessionStatus {
  active: boolean
  /** The URL the window was opened at. */
  url: string | null
  startedAt: string | null
  /** Where the window is now — how the UI shows that a login actually happened. */
  currentUrl: string | null
  /** Origin the session will be saved for, derived from `url`. */
  origin: string | null
}

const IDLE: AuthSessionStatus = {
  active: false,
  url: null,
  startedAt: null,
  currentUrl: null,
  origin: null,
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function firstPage(context: BrowserContext): Page | undefined {
  return context.pages()[0]
}

/** Is a sign-in window holding the profile right now? */
export function authSessionActive(): boolean {
  return current !== null
}

/** Drop the handle without touching the browser — for when Chrome closed itself. */
function forget(): void {
  if (!current) return
  clearTimeout(current.timer)
  current = null
}

/**
 * Open a real Chrome window on the audit profile at `url` and leave it open.
 * Throws the same friendly message the audit uses when the profile is locked or
 * Chrome is missing — the caller turns it into a 400 the form shows inline.
 */
export async function startAuthSession(url: string): Promise<AuthSessionStatus> {
  if (current) return await getAuthSessionStatus()
  const chromium = await loadChromium()

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(agentProfileDir(), {
      headless: false,
      channel: 'chrome',
      viewport: null,
      args: ['--start-maximized'],
    })
  } catch (err) {
    throw new Error(friendlyLaunchError(err instanceof Error ? err.message : String(err)))
  }

  const session: Session = {
    url,
    startedAt: new Date().toISOString(),
    context,
    timer: setTimeout(() => {
      void closeAuthSession()
    }, MAX_MS),
  }
  current = session

  // The engineer closing the window IS the "I'm done" gesture on some machines,
  // so treat it as one rather than leaving a dead handle that blocks audits.
  context.on('close', () => {
    if (current === session) forget()
  })

  try {
    const page = firstPage(context) ?? (await context.newPage())
    // Don't fail the whole thing on a slow login page: the window is what matters,
    // and the engineer can navigate it themselves.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  } catch {
    /* the window is open; that is the point */
  }
  return await getAuthSessionStatus()
}

/** Where the sign-in window is now. Never throws — a dead window reads as idle. */
export async function getAuthSessionStatus(): Promise<AuthSessionStatus> {
  if (!current) return { ...IDLE }
  let currentUrl: string | null = null
  try {
    currentUrl = firstPage(current.context)?.url() ?? null
  } catch {
    /* window went away between the check and the read */
  }
  return {
    active: true,
    url: current.url,
    startedAt: current.startedAt,
    currentUrl,
    origin: originOf(current.url),
  }
}

/**
 * Close the window. This is the step that MATTERS: Chrome flushes localStorage and
 * cookies to the profile on close, and the profile lock is only released here — an
 * audit started with the window still open would fail with "profile already open".
 */
export async function closeAuthSession(): Promise<{
  closed: boolean
  finalUrl: string | null
  origin: string | null
}> {
  if (!current) return { closed: false, finalUrl: null, origin: null }
  const session = current
  let finalUrl: string | null = null
  try {
    finalUrl = firstPage(session.context)?.url() ?? null
  } catch {
    /* best effort */
  }
  forget()
  await session.context.close().catch(() => {})
  return { closed: true, finalUrl, origin: originOf(session.url) }
}

/** Close a forgotten window on server shutdown. Returns whether one was open. */
export function shutdownAuthSession(): boolean {
  if (!current) return false
  const session = current
  forget()
  void session.context.close().catch(() => {})
  return true
}

/**
 * Forget the saved login for ONE origin, inside the audit's profile.
 *
 * Two situations need this and neither is served by "just sign in again":
 *
 *   • The session went stale. The token is still in localStorage, so the app
 *     redirects you straight past its own login screen and nothing is refreshed —
 *     you "signed in" and the next audit still lands on /login.
 *   • You need to audit as a DIFFERENT user. Signing in again on top of a live
 *     session is exactly what the app is designed to prevent.
 *
 * So this drops the origin's cookies plus its localStorage / sessionStorage /
 * IndexedDB, in a headless window on the same profile. Scoped to one origin on
 * purpose: the profile also carries the sessions of every other site the QC
 * browser uses, and wiping those would be a much bigger promise than the button
 * makes. Never runs while the sign-in window is open — Chrome will not open one
 * profile twice.
 */
export interface ClearAuthResult {
  origin: string
  /** How many cookie domains were dropped. */
  cookieDomains: number
  /** False when the origin could not be loaded (an SSO bounce), so only cookies went. */
  storageCleared: boolean
}

export async function clearAuthSession(url: string): Promise<ClearAuthResult> {
  const origin = originOf(url)
  if (!origin) throw new Error('Enter the site URL, including http:// or https://')
  if (current) {
    throw new Error('The sign-in window is still open — close it first (that also frees the profile).')
  }
  const chromium = await loadChromium()

  let context: BrowserContext
  try {
    context = await chromium.launchPersistentContext(agentProfileDir(), {
      headless: true,
      channel: 'chrome',
      viewport: { width: 1024, height: 768 },
    })
  } catch (err) {
    throw new Error(friendlyLaunchError(err instanceof Error ? err.message : String(err)))
  }

  try {
    const host = new URL(origin).hostname
    // A cookie's stored domain may be `example.com` or `.example.com`, and a
    // parent domain's cookie applies here too — so match by suffix, then clear
    // each distinct domain rather than guessing one spelling.
    const cookies = await context.cookies().catch(() => [])
    const domains = new Set(
      cookies
        .map((c) => c.domain)
        .filter((d) => {
          const bare = d.replace(/^\./, '')
          return host === bare || host.endsWith(`.${bare}`)
        }),
    )
    for (const domain of domains) {
      await context.clearCookies({ domain }).catch(() => {})
    }

    // localStorage is only reachable from a page ON that origin. If the app
    // bounces us to an identity provider we are no longer there, and clearing
    // would hit the wrong origin's storage — so check before touching it.
    const page = await context.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    const landed = originOf(page.url()) === origin
    if (landed) {
      await page
        .evaluate(async () => {
          try {
            localStorage.clear()
          } catch {
            /* storage disabled for this origin */
          }
          try {
            sessionStorage.clear()
          } catch {
            /* same */
          }
          const idb = indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
          const dbs = (await idb.databases?.().catch(() => [])) ?? []
          for (const db of dbs) if (db.name) indexedDB.deleteDatabase(db.name)
        })
        .catch(() => {})
    }
    return { origin, cookieDomains: domains.size, storageCleared: landed }
  } finally {
    // Closing is what writes the now-empty storage back to the profile, exactly
    // as it is what saves a successful login.
    await context.close().catch(() => {})
  }
}
