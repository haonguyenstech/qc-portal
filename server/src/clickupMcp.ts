import {
  finishHostedSignin,
  freshAccessToken,
  freshAuthHeader as hostedAuthHeader,
  hostedSignin,
  setHostedSite,
  signOutHosted,
  startHostedSignin,
  callHostedTool,
} from './hostedMcp.js'

/**
 * ClickUp's side of the portal's hosted-MCP sign-in (hostedMcp.ts) — the ClickUp twin
 * of atlassianMcp.ts. One browser sign-in to https://mcp.clickup.com/mcp serves the
 * Tickets page and Run → Issues filing (clickup.ts, through `resolveProjectClickupToken`)
 * AND QC runs / Chat (the `clickup-oauth` server's headersHelper).
 *
 * ClickUp's REST API does NOT accept this login (`401 OAUTH_019`, measured), so
 * clickup.ts reads and files through the hosted MCP tools instead whenever the
 * project's "token" is the `mcp:` marker below.
 */

const key = (projectId: string) => ({ provider: 'clickup' as const, projectId })

export function startClickupSignin(projectId: string, redirectUrl: string, returnTo = '/') {
  return startHostedSignin(key(projectId), redirectUrl, returnTo)
}

export async function finishClickupSignin(code: string, state: string) {
  const done = await finishHostedSignin('clickup', code, state)
  // The workspace this login was granted — read through the MCP server, because
  // ClickUp's REST API refuses this token (`OAUTH_019`; see clickup.ts).
  const data = (await callHostedTool(key(done.projectId), 'clickup_get_workspace_hierarchy', {
    max_depth: '0',
    limit: 1,
  })) as { hierarchy?: { root?: { id?: unknown; name?: unknown } } } | null
  const root = data?.hierarchy?.root
  if (!root?.id) {
    signOutHosted(key(done.projectId))
    throw Object.assign(new Error('Signed in, but this ClickUp account has no workspace.'), { status: 400 })
  }
  setHostedSite(key(done.projectId), {
    cloudId: String(root.id),
    url: `https://app.clickup.com/${root.id}`,
    name: String(root.name ?? root.id),
  })
  return done
}

export const clickupSignin = (projectId: string) => hostedSignin(key(projectId))
export const signOutClickup = (projectId: string) => signOutHosted(key(projectId))
export const clickupAuthHeader = (projectId: string) => hostedAuthHeader(key(projectId))

/**
 * What clickup.ts gets as its "token" for a browser-signed-in project: a MARKER
 * (`mcp:<projectId>`), not a credential — the REST API refuses this login, so every
 * reader there branches to the MCP tools when it sees the marker.
 */
export function clickupSigninToken(projectId: string): string | undefined {
  return hostedSignin(key(projectId)).signedIn ? `mcp:${projectId}` : undefined
}

/** Refresh the sign-in's token if it is about to expire (before a request uses it). */
export async function refreshClickupSignin(projectId: string): Promise<void> {
  if (hostedSignin(key(projectId)).signedIn) await freshAccessToken(key(projectId))
}
