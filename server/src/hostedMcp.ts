import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  auth,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { DB_PATH } from './config.js'

/**
 * The PORTAL's own browser sign-in to a tracker's HOSTED MCP server — Atlassian
 * (Jira) and ClickUp — so ONE sign-in serves the Tickets page, issue filing, QC runs
 * and Chat, with no API token.
 *
 * Why not reuse the login `claude mcp login` makes: that one is Claude Code's, kept in
 * its credential store and usable only by its own MCP client. So the portal is its own
 * MCP client with its OWN OAuth — dynamic client registration + PKCE, exactly what
 * Claude Code does; both providers register any client on the fly, nothing to set up
 * in a developer console. Claude Code is then pointed at the SAME login through a
 * `.mcp.json` headersHelper (`claudeHeadersHelper`), so there is never a second one.
 *
 * Per project and per provider, because tracker credentials are per project
 * everywhere else. State (client registration, tokens, the pending PKCE verifier, the
 * chosen site / workspace) lives BESIDE THE DB, mode 0600 — never in the project repo,
 * never in .mcp.json, never logged. The SDK refreshes the access token through
 * `saveTokens`.
 */

export type HostedProvider = 'atlassian' | 'clickup'

interface ProviderInfo {
  label: string
  url: string
  /** The router this provider's /oauth/* routes live on (routes/jira.ts, routes/clickup.ts). */
  apiBase: string
}

export const HOSTED: Record<HostedProvider, ProviderInfo> = {
  atlassian: { label: 'Jira', url: 'https://mcp.atlassian.com/v1/mcp', apiBase: '/api/jira' },
  clickup: { label: 'ClickUp', url: 'https://mcp.clickup.com/mcp', apiBase: '/api/clickup' },
}

export const ATLASSIAN_MCP_URL = HOSTED.atlassian.url
/** The redirect path each provider's router answers (`/oauth/callback`). */
export const callbackPath = (p: HostedProvider) => `${HOSTED[p].apiBase}/oauth/callback`
export const headersPath = (p: HostedProvider) => `${HOSTED[p].apiBase}/oauth/headers`
/** Jira's, kept as a name: routes/jira.ts and older helpers use it. */
export const CALLBACK_PATH = callbackPath('atlassian')

interface Stored {
  redirectUrl?: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  /** When `tokens` was stored — with `expires_in`, when to refresh. */
  tokensAt?: number
  verifier?: string
  /** Where the tickets come from: Atlassian's Jira site (getAccessibleAtlassianResources),
   *  or the ClickUp workspace the token was granted for. */
  site?: { cloudId: string; url: string; name: string }
  /** When the last sign-in fully LANDED (site picked, Claude Code linked). The page
   *  polls for this to CHANGE: `signedIn` alone is already true when the engineer
   *  signs in again over a live login, so a poll keyed on it fired at once — before
   *  the callback had re-added the server to .mcp.json — and the MCP page refreshed
   *  too early and showed nothing until a reload. */
  linkedAt?: number
}

const dir = () => path.join(path.dirname(DB_PATH), 'tracker-oauth')
/** One state file per provider + project — the key every helper below takes. */
type Key = { provider: HostedProvider; projectId: string }
const fileFor = (k: Key) =>
  path.join(dir(), `${k.provider}-${k.projectId.replace(/[^\w-]/g, '')}.json`)

function load(k: Key): Stored {
  try {
    return JSON.parse(fs.readFileSync(fileFor(k), 'utf8')) as Stored
  } catch {
    return {}
  }
}

function save(k: Key, next: Stored): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const file = fileFor(k)
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows: ACLs, not modes */
  }
}

function patch(k: Key, change: Partial<Stored>): void {
  save(k, { ...load(k), ...change })
}

/** OAuth `state` → the sign-in it belongs to. Memory only; a restart drops pending sign-ins. */
const pending = new Map<string, Key & { at: number; returnTo: string }>()
const PENDING_TTL = 15 * 60_000

class PortalProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization` — the URL the engineer must open. */
  authorizeUrl: URL | null = null

  constructor(
    private readonly key: Key,
    private readonly redirect: string | undefined,
    private readonly stateValue?: string,
    /** Starting a sign-in: act as if there were no token, so `auth` produces a URL —
     *  WITHOUT deleting the stored one. An abandoned sign-in must not log anyone out. */
    private readonly ignoreTokens = false,
  ) {}

  get redirectUrl() {
    return this.redirect ?? load(this.key).redirectUrl
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'QC Portal',
      redirect_uris: [String(this.redirectUrl ?? `http://localhost${callbackPath(this.key.provider)}`)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  state() {
    return this.stateValue ?? crypto.randomBytes(16).toString('hex')
  }
  clientInformation() {
    const s = load(this.key)
    // A registration is bound to its redirect URI: signing in from another origin
    // (localhost vs a /remote tunnel) must register again, or the provider rejects it.
    if (this.redirect && s.redirectUrl && s.redirectUrl !== this.redirect) return undefined
    return s.client
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    patch(this.key, { client, redirectUrl: String(this.redirectUrl ?? '') })
  }
  tokens() {
    return this.ignoreTokens ? undefined : load(this.key).tokens
  }
  saveTokens(tokens: OAuthTokens) {
    patch(this.key, { tokens, tokensAt: Date.now() })
  }
  redirectToAuthorization(url: URL) {
    this.authorizeUrl = url
  }
  saveCodeVerifier(verifier: string) {
    patch(this.key, { verifier })
  }
  codeVerifier() {
    const v = load(this.key).verifier
    if (!v) throw new Error('No sign-in in progress for this project — start it again.')
    return v
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const s = load(this.key)
    if (scope === 'all' || scope === 'tokens') delete s.tokens
    if (scope === 'all' || scope === 'client') delete s.client
    if (scope === 'all' || scope === 'verifier') delete s.verifier
    save(this.key, s)
  }
}

/** Start a browser sign-in: returns the provider's authorize URL to open. */
export async function startHostedSignin(
  k: Key,
  redirectUrl: string,
  returnTo = '/',
): Promise<string> {
  for (const [s2, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(s2)
  const state = crypto.randomBytes(16).toString('hex')
  const provider = new PortalProvider(k, redirectUrl, state, true)
  if (load(k).redirectUrl !== redirectUrl) patch(k, { redirectUrl, client: undefined })
  const result = await auth(provider, { serverUrl: HOSTED[k.provider].url })
  if (result !== 'REDIRECT' || !provider.authorizeUrl) {
    throw Object.assign(new Error(`${HOSTED[k.provider].label} did not return a sign-in page.`), {
      status: 502,
    })
  }
  pending.set(state, { ...k, at: Date.now(), returnTo })
  return provider.authorizeUrl.toString()
}

/** Finish a sign-in from the OAuth callback. Returns the project it belonged to and
 *  the portal page that started it (where a same-tab sign-in goes back to). */
export async function finishHostedSignin(
  provider: HostedProvider,
  code: string,
  state: string,
): Promise<{ projectId: string; returnTo: string }> {
  const entry = pending.get(state)
  if (!entry || entry.provider !== provider || Date.now() - entry.at > PENDING_TTL) {
    throw Object.assign(new Error('This sign-in link has expired — start it again from the portal.'), {
      status: 400,
    })
  }
  pending.delete(state)
  const k: Key = { provider, projectId: entry.projectId }
  const result = await auth(new PortalProvider(k, undefined, state), {
    serverUrl: HOSTED[provider].url,
    authorizationCode: code,
  })
  if (result !== 'AUTHORIZED') {
    throw Object.assign(new Error(`${HOSTED[provider].label} did not accept the sign-in.`), {
      status: 502,
    })
  }
  patch(k, { verifier: undefined })
  dropClient(k)
  return { projectId: entry.projectId, returnTo: entry.returnTo }
}

/** Remember where this login's tickets come from (a Jira site / ClickUp workspace). */
export function setHostedSite(k: Key, site: NonNullable<Stored['site']>): void {
  patch(k, { site })
}

export function hostedSignin(k: Key): {
  signedIn: boolean
  site: Stored['site'] | null
  linkedAt: number
} {
  const s = load(k)
  return { signedIn: !!s.tokens && !!s.site, site: s.site ?? null, linkedAt: s.linkedAt ?? 0 }
}

/** The sign-in has landed everywhere — the last step of the callback. */
export function markHostedLinked(k: Key): void {
  patch(k, { linkedAt: Date.now() })
}

export function signOutHosted(k: Key): void {
  dropClient(k)
  try {
    fs.rmSync(fileFor(k))
  } catch {
    /* already gone */
  }
}

// ---- Calling tools --------------------------------------------------------------

/** One connected client per project, reused for a few minutes — `initialize` is a
 *  round trip a type-to-search box should not pay per keystroke. */
const clients = new Map<string, { client: Client; at: number }>()
const clientKey = (k: Key) => `${k.provider}:${k.projectId}`
const CLIENT_TTL = 5 * 60_000

function dropClient(k: Key): void {
  const c = clients.get(clientKey(k))
  clients.delete(clientKey(k))
  void c?.client.close().catch(() => undefined)
}

async function clientFor(k: Key): Promise<Client> {
  const cached = clients.get(clientKey(k))
  if (cached && Date.now() - cached.at < CLIENT_TTL) return cached.client
  if (cached) dropClient(k)
  const provider = new PortalProvider(k, undefined)
  const transport = new StreamableHTTPClientTransport(new URL(HOSTED[k.provider].url), {
    authProvider: provider,
  })
  const client = new Client({ name: 'qc-portal', version: '1.0.0' })
  try {
    await client.connect(transport)
  } catch (err) {
    if (provider.authorizeUrl) throw needsSignin(k.provider)
    throw err
  }
  clients.set(clientKey(k), { client, at: Date.now() })
  return client
}

function needsSignin(provider: HostedProvider): Error {
  return Object.assign(
    new Error(`The ${HOSTED[provider].label} sign-in has expired — sign in again on the Tickets page.`),
    { status: 401, needsSignin: true },
  )
}

/**
 * Call one tool on the provider's hosted MCP server and return its result parsed as
 * JSON (both providers answer with JSON text). A tool-level error becomes a 502.
 */
export async function callHostedTool(
  k: Key,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let client: Client
  try {
    client = await clientFor(k)
  } catch (err) {
    if ((err as { needsSignin?: boolean }).needsSignin) throw err
    throw Object.assign(new Error(`Could not reach ${HOSTED[k.provider].label}: ${(err as Error).message}`), {
      status: 502,
    })
  }
  let result
  try {
    result = await client.callTool({ name, arguments: args })
  } catch (err) {
    dropClient(k)
    const msg = (err as Error).message ?? ''
    if (/401|unauthori[sz]ed|invalid_token/i.test(msg)) throw needsSignin(k.provider)
    throw Object.assign(new Error(`${HOSTED[k.provider].label} ${name} failed: ${msg.slice(0, 200)}`), {
      status: 502,
    })
  }
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim()
  if (result.isError) {
    throw Object.assign(new Error(`${HOSTED[k.provider].label} ${name}: ${text.slice(0, 240) || 'tool error'}`), {
      status: 502,
    })
  }
  if (result.structuredContent) return result.structuredContent
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** The login's site / workspace; throws a "sign in" error when there is none. */
export function hostedSite(k: Key): NonNullable<Stored['site']> {
  const s = load(k)
  if (!s.tokens || !s.site) throw needsSignin(k.provider)
  return s.site
}

/**
 * The current access token, refreshed when it is about to expire — what Claude Code's
 * headersHelper prints, and what the ClickUp REST client uses. Null when not signed in
 * or the refresh was refused (the engineer has to sign in again).
 */
export async function freshAccessToken(k: Key): Promise<string | null> {
  const s = load(k)
  if (!s.tokens?.access_token) return null
  const expiresAt = s.tokens.expires_in && s.tokensAt ? s.tokensAt + s.tokens.expires_in * 1000 : 0
  // Refresh a couple of minutes early: a run may hold the connection for a while.
  if (expiresAt && Date.now() > expiresAt - 120_000 && s.tokens.refresh_token) {
    try {
      // With a refresh token on file `auth` refreshes instead of redirecting.
      await auth(new PortalProvider(k, undefined), { serverUrl: HOSTED[k.provider].url })
      dropClient(k)
    } catch {
      return null
    }
  }
  return load(k).tokens?.access_token ?? null
}

/**
 * The `Authorization` header for Claude Code's server — what the `.mcp.json`
 * headersHelper prints. This is how ONE browser sign-in serves the portal AND
 * runs/chat: Claude Code never signs in itself, it asks the portal for the current
 * token each time it connects, so nothing secret is written to .mcp.json.
 * `{}` when not signed in — Claude Code then reports the server as needing sign-in.
 */
export async function freshAuthHeader(k: Key): Promise<Record<string, string>> {
  const token = await freshAccessToken(k)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** The raw stored token, no refresh (an attachment download — best-effort). */
export function storedAccessToken(k: Key): string | null {
  return load(k).tokens?.access_token ?? null
}

/** The shell command Claude Code runs to get that header (`headersHelper`). Built
 *  SERVER-side: port and project id are this machine's, and the boot repair
 *  rewrites them on a project synced from another machine. */
export function claudeHeadersHelper(port: number, projectId: string, provider: HostedProvider = 'atlassian'): string {
  return `curl -s "http://127.0.0.1:${port}${headersPath(provider)}?projectId=${projectId}"`
}
/** Matches a helper this portal wrote, whatever port / project id; group 1 = provider base. */
export const HEADERS_HELPER_RE = /\/api\/(jira|clickup)\/oauth\/headers\?projectId=/
/** Which provider a matched helper belongs to. */
export const helperProvider = (helper: string): HostedProvider | null => {
  const m = HEADERS_HELPER_RE.exec(helper)
  return m ? (m[1] === 'jira' ? 'atlassian' : 'clickup') : null
}
