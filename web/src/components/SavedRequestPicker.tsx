import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { listApiRequests, type ApiRequestDef } from '@/lib/api'

/**
 * Pick saved API Testing requests, for somewhere that is not API Testing.
 *
 * A load test is almost always run against calls the engineer already built and sent
 * on `/api-testing`; retyping the URL, the headers and the body is the slow part of
 * setting one up, and a retyped header is how a load test ends up measuring an
 * unauthenticated 401 instead of the real endpoint.
 *
 * MULTI-select on purpose: a load test worth running usually covers several calls,
 * and adding them one dialog at a time is the same tedium in a different shape.
 *
 * The list is read-only here. Nothing is written back to the collection, so a
 * request cannot be damaged by being borrowed.
 */
export function SavedRequestPicker({
  open,
  onOpenChange,
  projectId,
  onPick,
  title = 'Add from API Testing',
  confirmLabel = 'Add',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  onPick: (requests: ApiRequestDef[]) => void
  title?: string
  confirmLabel?: string
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [filter, setFilter] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['api-requests', projectId],
    queryFn: () => listApiRequests(projectId),
    enabled: open && !!projectId,
  })

  const requests = useMemo(() => data ?? [], [data])

  const matches = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return requests
    return requests.filter((r) =>
      `${r.method} ${r.name} ${r.group} ${r.url}`.toLowerCase().includes(q),
    )
  }, [requests, filter])

  /** Grouped the way the collection is filed, ungrouped last. */
  const groups = useMemo(() => {
    const byGroup = new Map<string, ApiRequestDef[]>()
    for (const r of matches) {
      const key = r.group || ''
      const list = byGroup.get(key)
      if (list) list.push(r)
      else byGroup.set(key, [r])
    }
    return [...byGroup.entries()].sort((a, b) => {
      if (!a[0]) return 1
      if (!b[0]) return -1
      return a[0].localeCompare(b[0])
    })
  }, [matches])

  function toggle(name: string): void {
    setSelected((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
  }

  function close(): void {
    setSelected([])
    setFilter('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : close())}>
      {/* A column that never scrolls itself — only the list does — so the footer
          buttons stay on screen however long the collection is. */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-4xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Search className="size-4 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Requests saved on the API Testing page. The URL, headers and body come across;
            assertions and captures do not — a load test measures timing, not correctness.
          </DialogDescription>
        </DialogHeader>

        <div className="shrink-0">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name, module or URL…"
            className="h-9 rounded-xl text-xs"
          />
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border/60">
          {isLoading ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading saved requests…
            </div>
          ) : error ? (
            <div className="flex items-start gap-2 p-4 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              {error instanceof Error ? error.message : 'Could not read the collection.'}
            </div>
          ) : !requests.length ? (
            <p className="p-4 text-xs text-muted-foreground">
              This project has no saved requests yet. Build one on the API Testing page and
              save it, then it will show up here.
            </p>
          ) : !matches.length ? (
            <p className="p-4 text-xs text-muted-foreground">Nothing matches “{filter}”.</p>
          ) : (
            groups.map(([group, list]) => (
              <div key={group || '__ungrouped'}>
                <p className="sticky top-0 z-10 bg-muted/80 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur">
                  {group || 'Ungrouped'}
                </p>
                {list.map((r) => {
                  const on = selected.includes(r.name)
                  return (
                    <label
                      key={r.name}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 border-b border-border/60 px-3 py-2 transition-colors duration-200 last:border-b-0',
                        on ? 'bg-muted/60' : 'hover:bg-muted/40',
                      )}
                    >
                      <Checkbox checked={on} onCheckedChange={() => toggle(r.name)} />
                      <span className="w-14 shrink-0 font-mono text-[10px] font-semibold uppercase text-muted-foreground">
                        {r.method}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{r.name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {r.url}
                        </span>
                      </span>
                    </label>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" className="rounded-full" onClick={close}>
            Cancel
          </Button>
          <Button
            className="rounded-full"
            disabled={!selected.length}
            onClick={() => {
              // Emitted in COLLECTION order, not click order: the endpoint list should
              // read the way the collection does, not the way it happened to be ticked.
              onPick(requests.filter((r) => selected.includes(r.name)))
              close()
            }}
          >
            {confirmLabel}
            {selected.length ? ` ${selected.length}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
