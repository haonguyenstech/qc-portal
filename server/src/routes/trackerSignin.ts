import type { Router } from 'express'
import { getProject } from '../db.js'
import { resolveProject } from '../projectScope.js'
import { isRemoteRequest } from '../remoteAccess.js'
import {
  HOSTED,
  callbackPath,
  freshAuthHeader,
  hostedSignin,
  markHostedLinked,
  signOutHosted,
  startHostedSignin,
  type HostedProvider,
} from '../hostedMcp.js'
import { azureSignin, markAzureLinked, signOutAzure, startAzureSignin } from '../azureSignin.js'
import { linkClaudeToPortalSignin } from './mcp.js'
import { trackerConflict } from '../trackerMcp.js'

/** Every tracker the portal signs in to itself: the hosted-MCP ones, and Azure DevOps
 *  (azureSignin.ts — Entra, through Microsoft's local server). */
export type SigninProvider = HostedProvider | 'azure'

/** What the shared routes below need from one provider's sign-in. */
interface SigninBackend {
  label: string
  status: (projectId: string) => {
    signedIn: boolean
    site?: { url: string; name: string } | null
    linkedAt: number
    orgs?: string[]
    needsOrg?: boolean
  }
  start: (projectId: string, origin: URL, returnTo: string, org?: string) => Promise<string>
  markLinked: (projectId: string) => void
  signOut: (projectId: string) => void
}

function backendFor(provider: SigninProvider): SigninBackend {
  if (provider === 'azure') {
    return {
      label: 'Azure DevOps',
      status: azureSignin,
      // Microsoft redirects to a loopback port on THIS machine (azureSignin.ts), so the
      // portal page's origin is only where that port forwards the code.
      start: (id, origin, returnTo, org) => startAzureSignin(id, origin.origin, returnTo, org),
      markLinked: markAzureLinked,
      signOut: signOutAzure,
    }
  }
  const k = (projectId: string) => ({ provider, projectId })
  return {
    label: HOSTED[provider].label,
    status: (id) => hostedSignin(k(id)),
    start: (id, origin, returnTo) => startHostedSignin(k(id), `${origin.origin}${callbackPath(provider)}`, returnTo),
    markLinked: (id) => markHostedLinked(k(id)),
    signOut: (id) => signOutHosted(k(id)),
  }
}

/**
 * The browser sign-in routes for one tracker (hostedMcp.ts, azureSignin.ts), mounted on
 * that tracker's router — `/api/jira/oauth/*`, `/api/clickup/oauth/*`, `/api/azure/oauth/*`:
 *
 *   GET  /oauth/status    { signedIn, site, usingToken, linkedAt, orgs? }
 *   POST /oauth/start     { origin, returnTo } → { url, since } (the provider's page, and
 *                         the `linkedAt` the page waits to see change)
 *   GET  /oauth/callback  the provider redirects here; finishes, links Claude Code
 *   GET  /oauth/headers   what the `.mcp.json` headersHelper prints (hosted servers only;
 *                         Azure's launcher has its own /oauth/token in routes/azure.ts)
 *   POST /oauth/signout
 *
 * One implementation for all three, so the sign-ins cannot drift apart.
 */
export function mountTrackerSignin(
  router: Router,
  provider: SigninProvider,
  opts: {
    /** Finish the OAuth exchange + any tracker-specific step (pick the site/workspace). */
    finish: (code: string, state: string) => Promise<{ projectId: string; returnTo: string }>
    /** Whether an API token is configured too (it wins over the sign-in). */
    usingToken: (rootPath: string) => boolean
  },
): void {
  const backend = backendFor(provider)
  const label = backend.label

  router.get('/oauth/status', (req, res) => {
    const project = resolveProject(req)
    if (!project) return res.status(400).json({ error: 'project not found' })
    const { signedIn, site, linkedAt, orgs, needsOrg } = backend.status(project.id)
    res.json({
      signedIn,
      site: site ? { url: site.url, name: site.name } : null,
      usingToken: opts.usingToken(project.rootPath),
      linkedAt,
      ...(orgs ? { orgs } : {}),
      ...(needsOrg ? { needsOrg } : {}),
    })
  })

  router.post('/oauth/start', async (req, res) => {
    const project = resolveProject(req)
    if (!project) return res.status(400).json({ error: 'project not found' })
    // The browser's own origin: the redirect has to come back to wherever the engineer
    // is (localhost in dev and prod, or the /remote tunnel), and only the page knows it.
    let origin: URL
    try {
      origin = new URL(String(req.body?.origin ?? ''))
      if (origin.protocol !== 'http:' && origin.protocol !== 'https:') throw new Error()
    } catch {
      return res.status(400).json({ error: 'origin must be the page URL origin' })
    }
    // The page to come back to — a same-site PATH only, never a URL (open redirect).
    const rawReturn = typeof req.body?.returnTo === 'string' ? req.body.returnTo : '/'
    const returnTo = /^\/(?![/\\])/.test(rawReturn) ? rawReturn.slice(0, 300) : '/'
    if (provider === 'azure' && isRemoteRequest(req)) {
      return res.status(400).json({
        error:
          'Azure DevOps sign-in only works on the computer running the portal — Microsoft sends ' +
          'the browser back to localhost. Sign in there once; this page then uses it too.',
      })
    }
    // Signing in AGAIN to the same tracker relinks its row — only another tracker is refused.
    const conflict = trackerConflict(project.rootPath, provider === 'atlassian' ? 'jira' : provider, undefined, {
      allowSame: true,
    })
    if (conflict) return res.status(409).json({ error: conflict })
    const org = typeof req.body?.org === 'string' ? req.body.org.trim().slice(0, 100) : undefined
    try {
      // Read BEFORE starting: the page knows this sign-in landed when linkedAt moves past it.
      const since = backend.status(project.id).linkedAt
      const url = await backend.start(project.id, origin, returnTo, org || undefined)
      res.json({ url, since })
    } catch (err) {
      res.status((err as { status?: number }).status ?? 500).json({ error: (err as Error).message })
    }
  })

  router.get('/oauth/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : ''
    const state = typeof req.query.state === 'string' ? req.query.state : ''
    const denied = typeof req.query.error === 'string' ? req.query.error : ''
    let ok = false
    let returnTo = '/'
    let message: string
    if (denied || !code || !state) {
      message = denied
        ? `${label} did not sign you in (${denied}). Close this tab and try again.`
        : `This page needs the code ${label} sends back. Start the sign-in from the portal.`
    } else {
      try {
        const done = await opts.finish(code, state)
        returnTo = done.returnTo
        const site = backend.status(done.projectId).site
        // The same sign-in also connects QC runs and Chat.
        const project = getProject(done.projectId)
        if (project) linkClaudeToPortalSignin(project.rootPath, done.projectId, provider)
        // Last: the page's status poll treats this as "done", so .mcp.json is written first.
        backend.markLinked(done.projectId)
        ok = true
        message = `Signed in to ${label}${site ? ` — ${site.name}` : ''}. Taking you back to the portal…`
      } catch (err) {
        message = (err as Error).message || 'Sign-in failed.'
        // Azure DevOps signed in but found no organization (azureSignin.ts `needsOrg`):
        // add the server row anyway, so the MCP page has the row to ask beside.
        const pid = (err as { projectId?: string }).projectId
        const project = provider === 'azure' && pid ? getProject(pid) : undefined
        if (project) linkClaudeToPortalSignin(project.rootPath, project.id, provider)
      }
    }
    // Tell the portal tab (it polls status too, so a blocked opener still works). A
    // sign-in that ran in THIS tab (popup blocked) has no opener — go back to the page
    // that started it instead of stranding the engineer on this one.
    const payload = JSON.stringify({ type: 'qc-tracker-signin', provider, ok })
    const back = JSON.stringify(returnTo)
    res
      .status(ok ? 200 : 400)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>${label} sign-in</title>` +
          `<body style="font:15px system-ui;display:grid;place-items:center;height:90vh;margin:0">` +
          `<p>${escapeHtml(message)}</p><script>try{window.opener&&window.opener.postMessage(${payload},location.origin)}catch(e){}` +
          (ok
            ? `setTimeout(function(){if(window.opener){window.close()}else{location.replace(${back})}},1200)`
            : '') +
          `</script></body>`,
      )
  })

  /**
   * The headers Claude Code sends — what the `.mcp.json` headersHelper prints. Local
   * callers only: a token over the public tunnel would hand the login to anyone
   * holding the access password's session.
   */
  if (provider !== 'azure') router.get('/oauth/headers', async (req, res) => {
    if (isRemoteRequest(req)) return res.status(403).json({})
    // The EXACT project only — resolveProject falls back to the default project, which
    // would hand Claude Code another project's login.
    const id = typeof req.query.projectId === 'string' ? req.query.projectId : ''
    const project = id ? getProject(id) : undefined
    // Always valid JSON and 200: a failing helper makes Claude Code drop the server with
    // an error instead of reporting it as needing sign-in.
    if (!project) return res.json({})
    res.json(await freshAuthHeader({ provider, projectId: project.id }))
  })

  router.post('/oauth/signout', (req, res) => {
    const project = resolveProject(req)
    if (!project) return res.status(400).json({ error: 'project not found' })
    backend.signOut(project.id)
    res.json({ ok: true })
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
