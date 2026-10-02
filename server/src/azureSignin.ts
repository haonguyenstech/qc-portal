import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DB_PATH } from './config.js'

/**
 * The portal's own browser sign-in to Azure DevOps (Microsoft Entra), the Azure twin of
 * hostedMcp.ts — ONE login for the Tickets page, QC runs and Chat, with no PAT.
 *
 * Why not the way Jira / ClickUp do it: Azure DevOps' hosted MCP server
 * (mcp.dev.azure.com) signs in through Entra, and Entra has no dynamic client
 * registration — Claude Code can only use it with an app registration a TENANT ADMIN
 * creates. And the official local server's own browser login (`@azure-devops/mcp`,
 * `--authentication interactive`) keeps its token in process memory only, so every run
 * and every chat turn — each a fresh server process — would pop a browser again, and a
 * headless run would hang on it.
 *
 * So the portal signs in itself, as the SAME public client that local server uses
 * (authorization code + PKCE, no secret), keeps the refresh token, and starts the server
 * with `--authentication envvar` and a fresh access token (`AZURE_LAUNCHER`). The REST
 * client (azure.ts) sends the same token as a Bearer.
 *
 * The client only accepts `http://localhost[:port]` with path `/` as its redirect
 * (measured with `prompt=none`: `/api/...` and `127.0.0.1` are refused), so the redirect
 * lands on a short-lived LOOPBACK listener that forwards it to the portal's own callback
 * route on the page's origin. That is also why this sign-in cannot start from a /remote
 * tunnel: Microsoft would send the browser to the remote viewer's own localhost.
 *
 * State lives BESIDE THE DB (`tracker-oauth/azure-<projectId>.json`, mode 0600) — never
 * in the project repo, never in .mcp.json, never logged.
 */

/** The public client of Microsoft's local Azure DevOps MCP server (`@azure-devops/mcp`). */
const CLIENT_ID = '0d50963b-7bb9-4fe7-94c7-a99af00b5136'
/**
 * The Entra authority for an organization's tenant. An Azure DevOps organization belongs
 * to ONE tenant, and a token from the account's home tenant (`common`) cannot see an
 * organization in another — the account then "has no organizations" (measured, for a
 * guest). So, like Microsoft's own server (`org-tenants.js`), sign in to the
 * organization's tenant whenever the organization is known (`orgTenant`).
 */
const ZERO_TENANT = '00000000-0000-0000-0000-000000000000'
const authority = (tenant?: string) =>
  `https://login.microsoftonline.com/${tenant && tenant !== ZERO_TENANT ? tenant : 'common'}/oauth2/v2.0`

/** The Entra tenant an organization belongs to — Azure DevOps names it in a header on an
 *  anonymous request. Undefined when unknown (no such org, network) or MSA-backed. */
export async function orgTenant(org: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://vssps.dev.azure.com/${encodeURIComponent(org)}`, {
      method: 'HEAD',
      redirect: 'manual',
    })
    const t = res.headers.get('x-vss-resourcetenant') ?? ''
    return /^[0-9a-f-]{36}$/i.test(t) && t !== ZERO_TENANT ? t : undefined
  } catch {
    return undefined
  }
}
/** Azure DevOps' resource id — the same scope that server asks for. */
const SCOPE = '499b84ac-1321-427f-aa17-267ca6975798/.default offline_access openid profile'

interface Stored {
  tokens?: { access_token: string; refresh_token?: string; expires_at: number }
  /** The tenant `tokens` were issued for (the organization's); none = `common`. */
  tenant?: string
  /** The organization tickets and the MCP server use. `cloudId` = the org name. */
  site?: { cloudId: string; url: string; name: string }
  /** Every organization this account belongs to — the Tickets page offers a switch. */
  orgs?: string[]
  /** When the last sign-in fully landed — the page waits for this to MOVE (see hostedMcp.ts). */
  linkedAt?: number
}

const dir = () => path.join(path.dirname(DB_PATH), 'tracker-oauth')
const fileFor = (projectId: string) => path.join(dir(), `azure-${projectId.replace(/[^\w-]/g, '')}.json`)

function load(projectId: string): Stored {
  try {
    return JSON.parse(fs.readFileSync(fileFor(projectId), 'utf8')) as Stored
  } catch {
    return {}
  }
}

function save(projectId: string, next: Stored): void {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 })
  const file = fileFor(projectId)
  fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 })
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows: ACLs, not modes */
  }
}

const patch = (projectId: string, change: Partial<Stored>) => save(projectId, { ...load(projectId), ...change })

function fail(message: string, status = 502): Error {
  return Object.assign(new Error(message), { status })
}

// ---- The loopback redirect ---------------------------------------------------------

interface Pending {
  projectId: string
  at: number
  returnTo: string
  /** The portal page's origin — where the loopback forwards the code. */
  origin: string
  verifier: string
  redirectUri: string
  /** An organization asked for up front (optional). */
  org?: string
  /** That organization's tenant — the authority this sign-in uses. */
  tenant?: string
}
/** OAuth `state` → its sign-in. Memory only; a restart drops pending sign-ins. */
const pending = new Map<string, Pending>()
const PENDING_TTL = 15 * 60_000

let loopback: { server: http.Server; port: number } | null = null
let loopbackStarting: Promise<number> | null = null

function prunePending(): void {
  for (const [s, v] of pending) if (Date.now() - v.at > PENDING_TTL) pending.delete(s)
  if (!pending.size && loopback) {
    loopback.server.close()
    loopback = null
  }
}

/** One listener for every pending sign-in, on a free port; closed once none is left. */
function loopbackPort(): Promise<number> {
  if (loopback) return Promise.resolve(loopback.port)
  if (loopbackStarting) return loopbackStarting
  loopbackStarting = new Promise<number>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const entry = pending.get(url.searchParams.get('state') ?? '')
      if (url.pathname !== '/' || !entry) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('This Azure DevOps sign-in link has expired. Start it again from the QC Portal.')
        return
      }
      // Hand the code to the portal's own callback, on the page's origin — so the
      // "signed in" page there can message the tab that opened it.
      res.writeHead(302, { location: `${entry.origin}/api/azure/oauth/callback${url.search}` })
      res.end()
    })
    server.on('error', reject)
    // Loopback only — this port must never be reachable from the network.
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      loopback = { server, port }
      // Never keep the process alive for a sign-in nobody finishes.
      server.unref()
      resolve(port)
    })
  }).finally(() => {
    loopbackStarting = null
  })
  return loopbackStarting
}

// ---- Sign-in -----------------------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Start a sign-in: returns Microsoft's sign-in page URL. */
export async function startAzureSignin(
  projectId: string,
  origin: string,
  returnTo = '/',
  org?: string,
): Promise<string> {
  prunePending()
  const port = await loopbackPort()
  const redirectUri = `http://localhost:${port}`
  const verifier = b64url(crypto.randomBytes(48))
  const state = crypto.randomBytes(16).toString('hex')
  const tenant = org ? await orgTenant(orgName(org)) : undefined
  pending.set(state, { projectId, at: Date.now(), returnTo, origin, verifier, redirectUri, org, tenant })
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPE,
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    // Always let the engineer pick the account — the browser's current Microsoft
    // session is often a different (personal / other-tenant) one.
    prompt: 'select_account',
  })
  return `${authority(tenant)}/authorize?${q}`
}

type TokenAnswer = {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

async function tokenRequest(
  form: Record<string, string>,
  tenant?: string,
): Promise<NonNullable<Stored['tokens']>> {
  const res = await fetch(`${authority(tenant)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE, ...form }),
  })
  const j = (await res.json().catch(() => ({}))) as TokenAnswer
  if (!res.ok || !j.access_token) {
    // Without the trace / correlation ids Entra appends (same line or the next).
    const why = (j.error_description ?? j.error ?? `HTTP ${res.status}`).split(/\r?\n| Trace ID:/)[0].trim()
    throw fail(`Microsoft did not accept the sign-in: ${why}`, res.status === 400 ? 401 : 502)
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
  }
}

/** One ADO GET with the sign-in's token. Throws an error that says WHICH call failed and
 *  what Azure DevOps answered — "HTTP 404" alone could not be told apart. */
async function adoJson(url: string, token: string, step: string): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'manual',
  })
  const ctype = res.headers.get('content-type') ?? ''
  if (!res.ok || !ctype.includes('json')) {
    const body = ctype.includes('json') ? ((await res.json().catch(() => ({}))) as { message?: string }) : {}
    const why = res.status >= 300 && res.status < 400 ? 'sent to a sign-in page' : `HTTP ${res.status}`
    throw fail(`${step}: ${why}${body.message ? ` — ${String(body.message).slice(0, 200)}` : ''}`)
  }
  return res.json()
}

/** First version that answers; the profile / accounts APIs have moved between preview
 *  and released versions, and an unsupported one can answer 404. */
async function adoJsonAnyVersion(base: string, versions: string[], token: string, step: string): Promise<any> {
  let last: unknown
  for (const v of versions) {
    try {
      return await adoJson(`${base}${base.includes('?') ? '&' : '?'}api-version=${v}`, token, step)
    } catch (err) {
      last = err
    }
  }
  throw last
}

/** The organizations this account is a member of. */
async function listOrgs(token: string): Promise<string[]> {
  const me = await adoJsonAnyVersion(
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me',
    ['7.1', '7.1-preview.3', '6.0'],
    token,
    'Reading your Azure DevOps profile',
  )
  const accounts = await adoJsonAnyVersion(
    `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(me.id)}`,
    ['7.1', '7.1-preview.1', '6.0'],
    token,
    'Listing your Azure DevOps organizations',
  )
  return ((accounts?.value ?? []) as { accountName?: string }[])
    .map((a) => a.accountName ?? '')
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
}

/** "your-org", "https://dev.azure.com/your-org/", "your-org.visualstudio.com" → "your-org". */
export function orgName(input: string): string {
  const t = input.trim().replace(/\/+$/, '')
  const legacy = /^(?:https?:\/\/)?([^./]+)\.visualstudio\.com/i.exec(t)
  if (legacy) return legacy[1]
  return t.split('/').pop() ?? ''
}

/** Can this token read that organization? (The check when it was typed, not listed.) */
async function canReadOrg(token: string, org: string): Promise<boolean> {
  try {
    await adoJson(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?$top=1&api-version=7.1`, token, org)
    return true
  } catch {
    return false
  }
}

const siteFor = (org: string) => ({ cloudId: org, url: `https://dev.azure.com/${org}`, name: org })

/**
 * Finish a sign-in from the callback: tokens + the organization tickets come from.
 * The tokens are SAVED before the organization lookup: when that lookup fails, the
 * engineer types the organization (`setAzureOrg`) instead of signing in again.
 */
export async function finishAzureSignin(code: string, state: string): Promise<{ projectId: string; returnTo: string }> {
  const entry = pending.get(state)
  if (!entry || Date.now() - entry.at > PENDING_TTL) {
    throw fail('This sign-in link has expired — start it again from the portal.', 400)
  }
  pending.delete(state)
  prunePending()
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: entry.redirectUri,
    code_verifier: entry.verifier,
  }, entry.tenant)
  const prev = load(entry.projectId).site?.cloudId
  // A new login: the organization is chosen again below (or typed, if that fails).
  save(entry.projectId, { ...load(entry.projectId), tokens, tenant: entry.tenant, site: undefined, orgs: undefined })

  let orgs: string[] = []
  let lookupError: Error | null = null
  try {
    orgs = await listOrgs(tokens.access_token)
  } catch (err) {
    lookupError = err as Error
  }
  const find = (name?: string) => (name ? orgs.find((o) => o.toLowerCase() === name.toLowerCase()) : undefined)
  const asked = entry.org ? orgName(entry.org) : ''
  // Asked for > kept from the last sign-in > the first of the account's. The Tickets
  // page can switch later when there are several.
  let org = find(asked) ?? find(prev) ?? orgs[0]
  // Typed but not listed (or the list failed): accept it if the token can read it.
  if (asked && org?.toLowerCase() !== asked.toLowerCase() && (await canReadOrg(tokens.access_token, asked))) {
    org = asked
    orgs = [...new Set([...orgs, asked])].sort((a, b) => a.localeCompare(b))
  }
  if (!org) {
    // `projectId` on the error: the tokens ARE saved, so the callback still adds the
    // server row — the MCP page asks for the organization next to it (`needsOrg`).
    throw Object.assign(fail(
      lookupError
        ? `Signed in to Microsoft, but could not list your Azure DevOps organizations (${lookupError.message}). ` +
            'Type your organization name on the MCP page to finish — usually no second sign-in.'
        : 'Signed in, but this Microsoft account is not a member of any Azure DevOps organization. ' +
            'Type your organization name on the MCP page to finish, or sign in with the work account it uses.',
      400,
    ), { projectId: entry.projectId })
  }
  patch(entry.projectId, { orgs, site: siteFor(org) })
  return { projectId: entry.projectId, returnTo: entry.returnTo }
}

export function azureSignin(projectId: string): {
  signedIn: boolean
  site: Stored['site'] | null
  linkedAt: number
  orgs: string[]
  /** Signed in to Microsoft, but no organization yet (the lookup failed) — type one. */
  needsOrg: boolean
} {
  const s = load(projectId)
  return {
    signedIn: !!s.tokens && !!s.site,
    site: s.site ?? null,
    linkedAt: s.linkedAt ?? 0,
    orgs: s.orgs ?? [],
    needsOrg: !!s.tokens && !s.site,
  }
}

export function markAzureLinked(projectId: string): void {
  patch(projectId, { linkedAt: Date.now() })
}

/**
 * Choose the organization: one of the account's, or a typed one the token can read —
 * which is also how a sign-in whose organization lookup failed is finished. Returns
 * whether this was that first choice (the caller then links Claude Code).
 */
export async function setAzureOrg(projectId: string, input: string): Promise<{ first: boolean }> {
  const org = orgName(input)
  const s = load(projectId)
  if (!s.tokens) throw fail('Not signed in to Azure DevOps — sign in first.', 400)
  if (!org) throw fail('Type the organization name (dev.azure.com/<name>).', 400)
  const listed = (s.orgs ?? []).find((o) => o.toLowerCase() === org.toLowerCase())
  if (!listed) {
    let token = await freshAzureToken(projectId, 5 * 60_000, true)
    let ok = !!token && (await canReadOrg(token, org))
    // Not readable with this login: the organization may live in another tenant. Redeem
    // the refresh token THERE (Entra allows it for an account that is a member or guest
    // of that tenant), as Microsoft's own server signs in to the org's tenant.
    const tenant = ok ? undefined : await orgTenant(org)
    if (!ok && tenant && tenant !== s.tenant && s.tokens.refresh_token) {
      const tokens = await tokenRequest(
        { grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token },
        tenant,
      ).catch(() => null)
      if (tokens && (await canReadOrg(tokens.access_token, org))) {
        patch(projectId, {
          tokens: { ...tokens, refresh_token: tokens.refresh_token ?? s.tokens.refresh_token },
          tenant,
        })
        token = tokens.access_token
        ok = true
      }
    }
    if (!ok) {
      // A tenant that needs its own sign-in (MFA / consent there): the page starts one
      // with this organization, which now goes to the right tenant from the start.
      throw Object.assign(
        fail(
          tenant
            ? `"${org}" belongs to another Microsoft tenant — sign in again for it.`
            : `This sign-in cannot read the Azure DevOps organization "${org}". Check the name (dev.azure.com/<name>).`,
          tenant ? 409 : 400,
        ),
        { resignin: !!tenant },
      )
    }
  }
  const name = listed ?? org
  patch(projectId, {
    site: siteFor(name),
    orgs: [...new Set([...(load(projectId).orgs ?? []), name])].sort((a, b) => a.localeCompare(b)),
  })
  return { first: !s.site }
}

export function signOutAzure(projectId: string): void {
  try {
    fs.rmSync(fileFor(projectId))
  } catch {
    /* already gone */
  }
}

// ---- Tokens ------------------------------------------------------------------------

/** One refresh per project at a time — several bots can start the server at once. */
const refreshing = new Map<string, Promise<string | null>>()

/**
 * The access token, refreshed when it has less than `minValidMs` left. Null when not
 * signed in, or Microsoft refused the refresh (the engineer has to sign in again).
 */
export function freshAzureToken(
  projectId: string,
  minValidMs = 5 * 60_000,
  /** Also before an organization is chosen (`setAzureOrg` checks a typed one with it). */
  withoutOrg = false,
): Promise<string | null> {
  const s = load(projectId)
  if (!s.tokens?.access_token || (!s.site && !withoutOrg)) return Promise.resolve(null)
  if (Date.now() < s.tokens.expires_at - minValidMs) return Promise.resolve(s.tokens.access_token)
  if (!s.tokens.refresh_token) return Promise.resolve(null)
  const inFlight = refreshing.get(projectId)
  if (inFlight) return inFlight
  const p = tokenRequest({ grant_type: 'refresh_token', refresh_token: s.tokens.refresh_token }, s.tenant)
    .then((tokens) => {
      // Entra may or may not rotate the refresh token; keep the old one if it didn't.
      const now = load(projectId)
      if (!now.tokens) return null // signed out meanwhile
      patch(projectId, { tokens: { ...tokens, refresh_token: tokens.refresh_token ?? s.tokens!.refresh_token } })
      return tokens.access_token
    })
    .catch(() => null)
    .finally(() => refreshing.delete(projectId))
  refreshing.set(projectId, p)
  return p
}

/** The stored token + org, no refresh — sync, for azure.ts's resolver (routes refresh first). */
export function azureSigninCreds(projectId: string): { orgUrl: string; bearer: string } | undefined {
  const s = load(projectId)
  if (!s.tokens?.access_token || !s.site) return undefined
  return { orgUrl: s.site.url, bearer: s.tokens.access_token }
}

// ---- Claude Code's server ----------------------------------------------------------

/**
 * How Claude Code starts the Azure DevOps server for a signed-in project: a tiny Node
 * launcher that asks THIS portal for a fresh token + the organization, then runs
 * Microsoft's server with it (`--authentication envvar`). Inline (`node -e`) so
 * .mcp.json names no path on this machine — only the port and project id, which the
 * boot repair rewrites on a project synced from elsewhere. Writes to stderr only:
 * stdout is the MCP channel.
 *
 * The server reads the token ONCE at start, so the launcher asks for one with at least
 * 45 minutes left; a run or chat turn longer than the token's life (~1h) would see its
 * Azure calls fail from then on. Each new run / turn starts a new server and gets a
 * new token.
 */
const AZURE_LAUNCHER =
  "const[p,i]=process.argv.slice(1);" +
  "fetch('http://127.0.0.1:'+p+'/api/azure/oauth/token?projectId='+encodeURIComponent(i))" +
  '.then(r=>r.json()).then(j=>{' +
  "if(!j.token||!j.org){console.error(j.error||'Not signed in to Azure DevOps - sign in on the QC Portal (MCP or Tickets page).');process.exit(1)}" +
  "const c=require('child_process').spawn('npx',['-y','@azure-devops/mcp',j.org,'--authentication','envvar']," +
  "{stdio:'inherit',shell:process.platform==='win32',env:Object.assign({},process.env,{ADO_MCP_AUTH_TOKEN:j.token})});" +
  "for(const s of['SIGINT','SIGTERM'])process.on(s,()=>c.kill(s));" +
  "c.on('exit',x=>process.exit(x==null?1:x))" +
  "}).catch(e=>{console.error('The QC Portal is not reachable for the Azure DevOps sign-in: '+e.message);process.exit(1)})"

/** `.mcp.json` args for the signed-in Azure DevOps server (`command: "node"`). */
export function azureLauncherArgs(port: number, projectId: string): string[] {
  return ['-e', AZURE_LAUNCHER, String(port), projectId]
}

/** Is this `.mcp.json` entry the launcher above (whatever port / project it names)? */
export function isAzureLauncher(entry: { command?: unknown; args?: unknown } | undefined): boolean {
  return (
    !!entry &&
    entry.command === 'node' &&
    Array.isArray(entry.args) &&
    entry.args[0] === '-e' &&
    typeof entry.args[1] === 'string' &&
    entry.args[1].includes('/api/azure/oauth/token')
  )
}

/** Minimum life left on a token handed to the launcher. */
export const LAUNCHER_MIN_VALID_MS = 45 * 60_000
