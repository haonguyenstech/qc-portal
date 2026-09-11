import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ChevronUp, Folder, FolderOpen, FolderPlus, HardDrive, Home, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { browseFolder, createFolder } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * The in-app folder browser — navigate the SERVER's filesystem and pick a folder.
 *
 * It lives outside ProjectsPage because more than one flow now has to ask "where on
 * this machine should that go?": adding a project, importing a .zip, and AI Sync
 * landing a pulled project. A second copy would drift, and the copy that drifted
 * would be the one that cannot create a folder or cannot see Windows drives.
 *
 * It exists at all because the NATIVE picker (/api/projects/pick-folder) needs an
 * interactive desktop session and hangs for ever when the portal was started over SSH
 * or from Task Scheduler. This one is just HTTP, so it works however the server was
 * launched.
 */

export function BrowseButton({ onPick }: { onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-11 shrink-0 rounded-full transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
      >
        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
        Browse…
      </Button>
      <FolderBrowserDialog
        open={open}
        onOpenChange={setOpen}
        onPick={(p) => {
          onPick(p)
          setOpen(false)
        }}
      />
    </div>
  )
}

/** In-app folder browser: navigate the server's filesystem and pick a folder. */
export function FolderBrowserDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onPick: (path: string) => void
}) {
  // undefined → let the server start at the user's home directory.
  const [nav, setNav] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const queryClient = useQueryClient()

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['browse-folder', nav ?? '~home'],
    queryFn: () => browseFolder(nav),
    enabled: open,
  })

  // Keep the editable path box in step with wherever we navigated to. Adjusted DURING
  // RENDER rather than in an effect: an effect would paint one frame of the previous
  // folder's path in the box before correcting it.
  const [shownPath, setShownPath] = useState<string | null>(null)
  if (data?.path && data.path !== shownPath) {
    setShownPath(data.path)
    setDraft(data.path)
  }

  const goto = (p: string) => setNav(p)
  const submitDraft = () => {
    const p = draft.trim()
    if (p) setNav(p)
  }

  const createMutation = useMutation({
    mutationFn: () => createFolder(data?.path ?? '', newName),
    onSuccess: (r) => {
      toast.success('Folder created', { description: r.path })
      setCreating(false)
      setNewName('')
      setDraft(r.path) // select the new folder
      queryClient.invalidateQueries({ queryKey: ['browse-folder'] })
    },
    onError: (err) =>
      toast.error('Could not create folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Navigate to the folder on this machine, or type/paste a path below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Path bar: home, up, editable path, go */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Home"
              onClick={() => setNav(undefined)}
              className="h-9 w-9 shrink-0 rounded-full"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Up one level"
              disabled={!data?.parent}
              onClick={() => data?.parent && goto(data.parent)}
              className="h-9 w-9 shrink-0 rounded-full"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitDraft()
                }
              }}
              placeholder="Type or paste a folder path…"
              className="h-9 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={submitDraft}
              className="h-9 shrink-0 rounded-full"
            >
              Go
            </Button>
          </div>

          {/* Windows drive chips */}
          {data?.drives && data.drives.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.drives.map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => goto(d)}
                  className="h-7 rounded-full px-2.5 text-xs"
                >
                  <HardDrive className="mr-1 h-3 w-3" />
                  {d.replace(/\\$/, '')}
                </Button>
              ))}
            </div>
          )}

          {/* New-folder action / inline creator */}
          {!creating ? (
            <div className="flex items-center justify-between gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                title={data?.path}
              >
                {data?.path ?? ''}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!data?.path || !!data?.error}
                onClick={() => {
                  setNewName('')
                  setCreating(true)
                }}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                New folder
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (newName.trim() && !createMutation.isPending) createMutation.mutate()
                  } else if (e.key === 'Escape') {
                    setCreating(false)
                  }
                }}
                placeholder="New folder name"
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  'Create'
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Folder list */}
          <div className="h-72 overflow-y-auto rounded-2xl border border-border/60 bg-muted/40 p-1.5">
            {isFetching ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : isError ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
                {error instanceof Error ? error.message : 'Could not read this folder'}
              </div>
            ) : data?.error ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-amber-600 dark:text-amber-500">
                {data.error}
              </div>
            ) : data && data.entries.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No sub-folders here.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {data?.entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      onDoubleClick={() => goto(e.path)}
                      onClick={() => setDraft(e.path)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm transition-colors',
                        'hover:bg-background',
                        draft === e.path && 'bg-background ring-1 ring-border',
                      )}
                      title="Double-click to open"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{e.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Click a folder to select it, double-click to open it. Then choose{' '}
            <span className="font-medium text-foreground">Use this folder</span>.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="rounded-full"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-full"
            disabled={!draft.trim()}
            onClick={() => onPick(draft.trim())}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
