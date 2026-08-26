import type { ApiKV, ApiRequestDef, LoadEndpointInput } from './api'
import { parseCurl } from './curl'
import { deriveName, type ApiDraft } from './apiDraft'

/**
 * FILLING A LOAD-TEST ENDPOINT FROM SOMEWHERE ELSE.
 *
 * Typing a URL, its headers and its body by hand is the slowest part of setting up a
 * load test, and it is work the engineer has usually already done — either in the
 * browser's network tab (copy as cURL) or on the API Testing page (a saved request).
 * This converts both into the shape the load form holds.
 *
 * Two things do NOT survive the trip, and pretending otherwise would produce a load
 * test that measures the wrong thing:
 *
 *  • **Query parameters become part of the URL.** API Testing keeps them as an
 *    editable list and appends them server-side at send time; k6 is handed one URL.
 *  • **Assertions, captures and AI expectations are dropped.** A load test measures
 *    timing under concurrency; it does not run per-request checks. k6's own
 *    pass/fail is the status check plus the thresholds on the form.
 *
 * `{{variables}}` are deliberately left ALONE — see `varsIn` below.
 */

export interface LoadEndpointDraft extends LoadEndpointInput {
  /** Raw `Key: Value` lines, which is how the load form edits headers. */
  headerText: string
}

const VAR_TOKEN = /\{\{\s*[\w.-]+\s*\}\}/

/**
 * The `{{variable}}` names a draft still contains.
 *
 * They are NOT resolved here. An API Testing variable can be an environment value, a
 * test account's password, or a live authenticator code, and the browser is never
 * given the secret ones — `/environments` masks them. Resolving in the page would
 * therefore either fail on exactly the values that matter, or, if the server handed
 * them over, write a bearer token into the load form, which is persisted to
 * localStorage. So they travel as `{{token}}` and the server substitutes them when
 * the run starts, the same way API Testing does at send time.
 */
export function varsIn(draft: Pick<LoadEndpointDraft, 'url' | 'headerText' | 'body'>): string[] {
  const found = new Set<string>()
  const scan = (text: string) => {
    for (const m of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) found.add(m[1])
  }
  scan(draft.url)
  scan(draft.headerText)
  scan(draft.body)
  return [...found]
}

/** Enabled, named rows → `Key: Value` lines. */
export function kvToHeaderText(rows: ApiKV[]): string {
  return rows
    .filter((r) => r.enabled !== false && r.key.trim())
    .map((r) => `${r.key.trim()}: ${r.value}`)
    .join('\n')
}

/**
 * `url` + its enabled query rows → one URL string.
 *
 * Values are percent-encoded, EXCEPT `{{variable}}` tokens: encoding those would turn
 * `{{token}}` into `%7B%7Btoken%7D%7D`, which no longer matches the substitution
 * pattern, and the load test would send the literal braces to the server. The URL is
 * assembled by hand rather than through `new URL()` for the same reason — a URL that
 * begins `{{baseUrl}}/orders` is not parseable yet, and throwing on it here would
 * make every environment-based request un-importable.
 */
export function urlWithQuery(url: string, query: ApiKV[]): string {
  const rows = query.filter((r) => r.enabled !== false && r.key.trim())
  if (!rows.length) return url
  const keepVars = (s: string) =>
    encodeURIComponent(s).replace(/%7B%7B\s*([\w.-]+)\s*%7D%7D/gi, '{{$1}}')
  const pairs = rows.map((r) => `${keepVars(r.key.trim())}=${keepVars(r.value)}`).join('&')
  // A URL that already carries a query keeps it; the rows are appended to it.
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}${pairs}`
}

/**
 * The header API Testing adds for you, so k6 doesn't send the body without it.
 *
 * `POST /apiTests/send` sets `content-type: application/json` when the body is
 * JSON and no header row already says otherwise (`routes/apiTests.ts`). That row
 * is therefore usually ABSENT from the request the engineer sees succeed — and
 * k6 adds nothing of its own, so importing the visible headers alone produced a
 * load test that 415'd against an endpoint that had just answered 200. Mirror
 * the send rule here, once, for all three import paths.
 */
function withImplicitContentType(
  headerText: string,
  draft: Pick<ApiDraft, 'method' | 'bodyMode'>,
): string {
  const method = (draft.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || draft.bodyMode !== 'json') return headerText
  if (/^\s*content-type\s*:/im.test(headerText)) return headerText
  return headerText ? `${headerText}\nContent-Type: application/json` : 'Content-Type: application/json'
}

function draftToEndpoint(
  draft: Pick<ApiDraft, 'method' | 'url' | 'query' | 'headers' | 'bodyMode' | 'body'>,
  name: string,
): LoadEndpointDraft {
  const headerText = withImplicitContentType(kvToHeaderText(draft.headers), draft)
  return {
    name,
    method: (draft.method || 'GET').toUpperCase(),
    url: urlWithQuery(draft.url, draft.query),
    // The load form parses `headerText` on submit; `headers` is filled there, not here.
    headers: {},
    // `bodyMode: 'none'` means the request has no body even if a stale one is stored.
    body: draft.bodyMode === 'none' ? '' : draft.body,
    headerText,
  }
}

/**
 * HANDOFF — API Testing's "Load test" button → Performance › API load test.
 *
 * That button sends the request the engineer is looking at RIGHT NOW, saved or
 * not, so it cannot just pass a name and let the other page look it up: the
 * unsaved edits are usually the whole point of wanting to load-test it.
 *
 * It goes through sessionStorage rather than the URL because a request's headers
 * routinely carry a bearer token, and a URL is written to browser history, is
 * what gets pasted into a ticket, and is the one string a screen recording
 * always captures. Session-scoped also means a handoff that never landed (the
 * tab was closed on the way) is not still sitting there tomorrow.
 */
const HANDOFF_KEY = 'qc.perfLoadHandoff'

export function stashLoadEndpoint(endpoint: LoadEndpointDraft): void {
  try {
    sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(endpoint))
  } catch {
    /* no session storage — the load form just opens empty, which is the old behaviour */
  }
}

/**
 * Take the parked endpoint, if there is one. READ-ONCE: it is removed before it
 * is returned, so a re-render (or React's double-invoked mount in dev) cannot
 * add the same endpoint to the form twice.
 */
/**
 * Look at the parked endpoint WITHOUT consuming it.
 *
 * Peek-then-clear rather than take-once, because the load form reads this from a
 * `useState` initializer, and React double-invokes those on mount in dev — a
 * read that removed the value would hand the endpoint to the discarded first
 * pass and give the surviving one nothing. `clearLoadHandoff()` runs afterwards,
 * from an effect, which is the right place for a write to an external store.
 */
export function peekLoadEndpoint(): LoadEndpointDraft | null {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<LoadEndpointDraft>
    if (typeof parsed?.url !== 'string' || !parsed.url.trim()) return null
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      method: typeof parsed.method === 'string' ? parsed.method : 'GET',
      url: parsed.url,
      headers: {},
      body: typeof parsed.body === 'string' ? parsed.body : '',
      headerText: typeof parsed.headerText === 'string' ? parsed.headerText : '',
    }
  } catch {
    return null
  }
}

export function clearLoadHandoff(): void {
  try {
    sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    /* nothing to clear */
  }
}

/** A pasted curl command → one endpoint. Null when no URL could be found. */
export function endpointFromCurl(command: string): LoadEndpointDraft | null {
  const parsed = parseCurl(command)
  if (!parsed) return null
  return draftToEndpoint(parsed, deriveName({ method: parsed.method, url: parsed.url }))
}

/**
 * A draft the engineer is editing — from the shared cURL import dialog, or the
 * API Testing page's own request. `name` carries the saved request's name when
 * there is one; otherwise the derived `METHOD /path` is the honest label.
 */
export function endpointFromDraft(draft: ApiDraft, name?: string): LoadEndpointDraft {
  return draftToEndpoint(draft, name?.trim() || deriveName({ method: draft.method, url: draft.url }))
}

/** A saved API Testing request → one endpoint, keeping the name it was saved under. */
export function endpointFromSavedRequest(request: ApiRequestDef): LoadEndpointDraft {
  return draftToEndpoint(request, request.name || deriveName(request))
}

/** Does this endpoint still hold at least one `{{variable}}`? */
export function hasVars(draft: Pick<LoadEndpointDraft, 'url' | 'headerText' | 'body'>): boolean {
  return VAR_TOKEN.test(draft.url) || VAR_TOKEN.test(draft.headerText) || VAR_TOKEN.test(draft.body)
}

/** True for an endpoint the engineer has not filled in — safe to replace on import. */
export function isBlankEndpoint(e: LoadEndpointDraft): boolean {
  return !e.url.trim() && !e.name.trim() && !e.headerText.trim() && !e.body.trim()
}
