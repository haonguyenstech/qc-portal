import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Reveals a project folder in the OS file explorer on the machine running the
 * server. `open` is the api.ts call that returns the revealed path; `label`
 * names the folder in the success toast (e.g. "tickets", "test cases").
 */
export function OpenFolderButton({
  open,
  label,
}: {
  open: () => Promise<{ ok: true; path: string }>
  label: string
}) {
  const mutation = useMutation({
    mutationFn: open,
    onSuccess: (res) => toast.success(`Opened ${label} folder`, { description: res.path }),
    onError: (err) =>
      toast.error('Failed to open folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="shrink-0 gap-1.5 active:scale-[0.98]"
    >
      {mutation.isPending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <FolderOpen className="size-3.5" />
      )}
      Open folder
    </Button>
  )
}
