import {
  CALLBACK_PATH,
  callHostedTool,
  claudeHeadersHelper,
  finishHostedSignin,
  freshAuthHeader as hostedAuthHeader,
  hostedSignin,
  hostedSite,
  setHostedSite,
  signOutHosted,
  startHostedSignin,
  storedAccessToken,
  ATLASSIAN_MCP_URL,
  HEADERS_HELPER_RE,
} from './hostedMcp.js'

/**
 * Jira's side of the portal's hosted-MCP sign-in (hostedMcp.ts): the Atlassian
 * provider, plus the one Jira-specific step — picking the Jira SITE the tickets come
 * from right after sign-in, so the first search doesn't have to.
 */

export { ATLASSIAN_MCP_URL, CALLBACK_PATH, HEADERS_HELPER_RE, claudeHeadersHelper }
export const HEADERS_PATH = '/api/jira/oauth/headers'

const key = (projectId: string) => ({ provider: 'atlassian' as const, projectId })

export function startAtlassianSignin(projectId: string, redirectUrl: string, returnTo = '/') {
  return startHostedSignin(key(projectId), redirectUrl, returnTo)
}

export async function finishAtlassianSignin(code: string, state: string) {
  const done = await finishHostedSignin('atlassian', code, state)
  type Site = { id?: string; url?: string; name?: string; scopes?: string[] }
  const resources = await callAtlassianTool(done.projectId, 'getAccessibleAtlassianResources', {})
  // A bare array, or wrapped (`{resources:[…]}`) — take the first array either way.
  const sites: Site[] = Array.isArray(resources)
    ? resources
    : ((Object.values((resources ?? {}) as object).find(Array.isArray) as Site[] | undefined) ?? [])
  const jira = sites.find((r) => (r.scopes ?? []).some((s) => /jira/i.test(s))) ?? sites[0]
  if (!jira?.id || !jira.url) {
    throw Object.assign(new Error('Signed in, but this Atlassian account has no Jira site.'), {
      status: 400,
    })
  }
  setHostedSite(key(done.projectId), {
    cloudId: jira.id,
    url: jira.url.replace(/\/+$/, ''),
    name: jira.name ?? jira.url,
  })
  return done
}

export const atlassianSignin = (projectId: string) => hostedSignin(key(projectId))
export const signOutAtlassian = (projectId: string) => signOutHosted(key(projectId))
export const atlassianSite = (projectId: string) => hostedSite(key(projectId))
export const atlassianAccessToken = (projectId: string) => storedAccessToken(key(projectId))
export const freshAuthHeader = (projectId: string) => hostedAuthHeader(key(projectId))
export const callAtlassianTool = (projectId: string, name: string, args: Record<string, unknown>) =>
  callHostedTool(key(projectId), name, args)
