import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Building2, CheckCircle2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { setAzureSigninOrg } from '@/lib/api'
import type { useTrackerSignin } from '@/lib/useTrackerSignin'

/**
 * The last step of an Azure DevOps browser sign-in whose organization lookup came back
 * empty (server/src/azureSignin.ts `needsOrg`): the account signed in to Microsoft, but
 * its organization lives in ANOTHER tenant (a guest account, typically), which the home
 * tenant's token cannot list. Naming it lets the server find that tenant and finish —
 * usually with no second sign-in; when the tenant insists on its own, this starts it.
 *
 * Lives on the MCP page, where the sign-in started: the Tickets page only points there.
 */
export function AzureOrgPrompt({
  projectId,
  signin,
  onLinked,
}: {
  projectId: string
  /** The page's Azure sign-in (`useTrackerSignin('azure', …)`) — reused, not a second one. */
  signin: ReturnType<typeof useTrackerSignin>
  /** The sign-in is complete and `azure-devops` is in .mcp.json — refresh / test the row. */
  onLinked: () => void
}) {
  const [org, setOrg] = useState('')
  const finish = useMutation({
    mutationFn: (name: string) => setAzureSigninOrg(name, projectId),
    onSuccess: (r, name) => {
      if (!r.ok) {
        // That tenant needs its own sign-in — start it for this organization.
        toast.info(r.error, { description: 'Opening the Microsoft sign-in for it…' })
        signin.start.mutate(name)
        return
      }
      toast.success('Signed in to Azure DevOps', {
        description: `${name} — Tickets, QC runs and Chat can use it now.`,
      })
      onLinked()
    },
    onError: (err) =>
      toast.error('Could not use that organization', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })
  const busy = finish.isPending || signin.start.isPending || signin.waiting

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (org.trim()) finish.mutate(org.trim())
      }}
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-300/60 bg-amber-50/60 px-4 py-3 dark:border-amber-500/30 dark:bg-amber-500/10"
    >
      <Building2 className="size-4 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium tracking-tight">Finish the Azure DevOps sign-in</p>
        <p className="text-xs text-muted-foreground">
          Signed in to Microsoft, but no organization was found for this account. Which one?
          (dev.azure.com/<b>name</b>)
        </p>
      </div>
      <Input
        value={org}
        onChange={(e) => setOrg(e.target.value)}
        placeholder="your-org"
        aria-label="Azure DevOps organization"
        className="h-9 w-48 rounded-full bg-background text-sm"
      />
      <Button
        type="submit"
        disabled={!org.trim() || busy}
        className="rounded-full transition-all duration-200 active:scale-[0.98]"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
        Use it
      </Button>
    </form>
  )
}
