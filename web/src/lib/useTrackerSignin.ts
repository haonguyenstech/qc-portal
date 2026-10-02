/**
 * The ONE browser sign-in per tracker (Jira, ClickUp, Azure DevOps), shared by the MCP
 * page and the Tickets page.
 *
 * It is the portal's own login — to the tracker's hosted MCP server
 * (server/src/hostedMcp.ts), or to Microsoft Entra for Azure DevOps
 * (server/src/azureSignin.ts). The portal reads tickets / files issues with it directly,
 * and the project's server in .mcp.json (`atlassian`, `clickup-oauth`, `azure-devops`)
 * asks the portal for the same token each time it starts — so QC runs and Chat use it
 * too. Signing in on either page connects everything; there is no second login.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { signOutTracker, startTrackerSignin, trackerSigninStatus, type SigninTracker } from './api'

const LABEL: Record<SigninTracker, string> = { jira: 'Jira', clickup: 'ClickUp', azure: 'Azure DevOps' }
/** The `provider` the server's callback page posts (hostedMcp.ts / azureSignin.ts names). */
const PROVIDER: Record<SigninTracker, string> = { jira: 'atlassian', clickup: 'clickup', azure: 'azure' }

export function useTrackerSignin(
  tracker: SigninTracker,
  projectId: string | null | undefined,
  /** Runs once the sign-in lands — e.g. the MCP page re-tests the server row so it
   *  turns green by itself instead of waiting for a reload. */
  onSignedIn?: () => void,
) {
  const queryClient = useQueryClient()
  const [waiting, setWaiting] = useState(false)
  // The callback tab's message AND the status poll can both report the same sign-in;
  // it must land (toast, re-test the MCP row) exactly once.
  const landed = useRef(true)
  // `linkedAt` when this sign-in started. Waiting for `signedIn` is not enough: over a
  // login that is still live it is true on the very first poll, before the callback has
  // even run — the page then refreshed too early and the new row only showed on reload.
  const since = useRef(0)

  const refresh = useCallback(() => {
    for (const key of [`${tracker}-signin`, `${tracker}-status`, 'mcp', 'mcp-health']) {
      queryClient.invalidateQueries({ queryKey: [key, projectId] })
    }
    // The Tickets page's workspace list (keyed by source) — empty until signed in.
    queryClient.invalidateQueries({ queryKey: ['ticket-workspaces'] })
  }, [queryClient, projectId, tracker])

  const finish = useCallback(
    (ok: boolean) => {
      if (landed.current) return
      landed.current = true
      setWaiting(false)
      if (ok) {
        toast.success(`Signed in to ${LABEL[tracker]}`, {
          description: 'Tickets, QC runs and Chat can use it now.',
        })
      }
      refresh()
      if (ok) onSignedIn?.()
    },
    [refresh, onSignedIn, tracker],
  )

  const { data: status } = useQuery({
    queryKey: [`${tracker}-signin`, projectId, waiting],
    queryFn: async () => {
      const st = await trackerSigninStatus(tracker, projectId as string)
      // The poll notices the sign-in when the callback tab can't message us.
      if (waiting && st.signedIn && st.linkedAt > since.current) finish(true)
      return st
    },
    enabled: !!projectId,
    // While the provider's tab is open, watch for the sign-in to land.
    refetchInterval: waiting ? 2000 : false,
  })

  // The callback page posts this to its opener.
  useEffect(() => {
    if (!waiting) return
    const onMessage = (e: MessageEvent) => {
      if (
        e.origin === window.location.origin &&
        e.data?.type === 'qc-tracker-signin' &&
        e.data.provider === PROVIDER[tracker]
      ) {
        finish(!!e.data.ok)
      }
    }
    window.addEventListener('message', onMessage)
    const stop = window.setTimeout(() => setWaiting(false), 10 * 60_000)
    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(stop)
    }
  }, [waiting, finish, tracker])

  const start = useMutation({
    /** `org`: Azure DevOps only — the organization to use, when known up front. */
    mutationFn: async (org: string | void) => {
      // Open the tab NOW, inside the click — a window opened after an await is a
      // popup the browser blocks.
      const tab = window.open('', '_blank')
      try {
        const { url, since: linkedAt } = await startTrackerSignin(tracker, projectId as string, org || undefined)
        since.current = linkedAt ?? 0
        if (tab) tab.location.href = url
        else window.location.assign(url)
      } catch (err) {
        tab?.close()
        throw err
      }
    },
    onSuccess: () => {
      landed.current = false
      setWaiting(true)
    },
    onError: (err) =>
      toast.error(`Could not start the ${LABEL[tracker]} sign-in`, {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const signOut = useMutation({
    mutationFn: () => signOutTracker(tracker, projectId as string),
    onSuccess: () => {
      toast.success(`Signed out of ${LABEL[tracker]}`)
      refresh()
    },
  })

  return { status, waiting, start, signOut }
}
