import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Boxes, Folder, ListChecks, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { clickupLists, clickupSpaces, clickupWorkspaces } from '@/lib/api'
import type { ListBinding } from '@/lib/clickupList'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  current: ListBinding | null
  onSave: (binding: ListBinding) => void
  onClear: () => void
  /** Active project — its .mcp.json ClickUp token is what the server should use. */
  projectId?: string
}

export function ConfigureListDialog({
  open,
  onOpenChange,
  current,
  onSave,
  onClear,
  projectId,
}: Props) {
  const [team, setTeam] = useState(current?.team ?? '')
  const [space, setSpace] = useState('')
  const [listId, setListId] = useState(current?.listId ?? '')

  // Re-seed from the current binding each time the dialog opens.
  useEffect(() => {
    if (open) {
      setTeam(current?.team ?? '')
      setSpace('')
      setListId(current?.listId ?? '')
    }
  }, [open, current])

  const { data: workspaces } = useQuery({
    queryKey: ['clickup-workspaces', projectId],
    queryFn: () => clickupWorkspaces(projectId),
    enabled: open,
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!workspaces?.length) return
    setTeam((prev) => (prev && workspaces.some((w) => w.id === prev) ? prev : workspaces[0].id))
  }, [workspaces])

  const { data: spaces, isFetching: spacesLoading } = useQuery({
    queryKey: ['clickup-spaces', projectId, team],
    queryFn: () => clickupSpaces(team, projectId),
    enabled: open && !!team,
    staleTime: 60_000,
  })

  useEffect(() => {
    if (!spaces?.length) return
    setSpace((prev) => (prev && spaces.some((s) => s.id === prev) ? prev : spaces[0].id))
  }, [spaces])

  const { data: lists, isFetching: listsLoading } = useQuery({
    queryKey: ['clickup-lists', projectId, space],
    queryFn: () => clickupLists(space, projectId),
    enabled: open && !!space,
    staleTime: 60_000,
  })

  const chosenList = lists?.find((l) => l.id === listId)

  function onSubmit() {
    const w = workspaces?.find((x) => x.id === team)
    const l = lists?.find((x) => x.id === listId)
    if (!w || !l) return
    onSave({
      team: w.id,
      teamName: w.name,
      listId: l.id,
      listName: l.name,
      folderName: l.folderName,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
              <ListChecks className="size-4" />
            </span>
            Pick a ClickUp list
          </DialogTitle>
          <DialogDescription>
            Bind this project to one list. The ticket picker then shows every open task in it —
            complete and accurate. Saved on this device.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <Boxes className="size-3.5 text-muted-foreground" />
              Workspace
            </Label>
            <Select value={team} onValueChange={setTeam}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue placeholder="Choose a workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces?.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <Folder className="size-3.5 text-muted-foreground" />
              Space
            </Label>
            <Select value={space} onValueChange={setSpace} disabled={!team || spacesLoading}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue placeholder={spacesLoading ? 'Loading…' : 'Choose a space'} />
              </SelectTrigger>
              <SelectContent>
                {spaces?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5 text-xs">
              <ListChecks className="size-3.5 text-muted-foreground" />
              List
              {listsLoading && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            </Label>
            <Select value={listId} onValueChange={setListId} disabled={!space || listsLoading}>
              <SelectTrigger className="h-10 w-full rounded-xl">
                <SelectValue placeholder={listsLoading ? 'Loading…' : 'Choose a list'} />
              </SelectTrigger>
              <SelectContent>
                {lists?.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">No lists in this space.</div>
                )}
                {lists?.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.folderName ? `${l.folderName} / ${l.name}` : l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {current ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full text-muted-foreground hover:text-destructive"
              onClick={() => {
                onClear()
                onOpenChange(false)
              }}
            >
              Clear binding
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="button"
            onClick={onSubmit}
            disabled={!chosenList}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            Use this list
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
