import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ListChecks, Loader2, Search, Settings2, Ticket } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ConfigureListDialog } from '@/components/ConfigureListDialog'
import {
  clickupListTasks,
  clickupStatus,
  clickupTasks,
  clickupWorkspaces,
} from '@/lib/api'
import {
  clearListBinding,
  loadListBinding,
  saveListBinding,
  type ListBinding,
} from '@/lib/clickupList'

const TEAM_KEY = 'qc.clickupTeam'

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

interface Props {
  value: string
  onChange: (value: string) => void
  projectId?: string
  disabled?: boolean
}

/**
 * The "ClickUp ticket" field. With a ClickUp token configured it becomes an
 * autocomplete over real tasks. Two modes:
 *  - list mode: when the project is bound to a ClickUp list, it shows every open
 *    task in that list (complete & accurate);
 *  - search mode: otherwise it searches recent tasks across a workspace.
 * Falls back to a plain text input when ClickUp isn't configured.
 */
export function TicketPicker({ value, onChange, projectId, disabled }: Props) {
  const { data: status } = useQuery({ queryKey: ['clickup-status'], queryFn: clickupStatus })
  const configured = !!status?.configured

  const [binding, setBinding] = useState<ListBinding | null>(null)
  const [configuring, setConfiguring] = useState(false)

  // Load the per-project list binding whenever the project changes.
  useEffect(() => {
    setBinding(projectId ? loadListBinding(projectId) : null)
  }, [projectId])

  const { data: workspaces } = useQuery({
    queryKey: ['clickup-workspaces', projectId],
    queryFn: () => clickupWorkspaces(projectId),
    enabled: configured && !binding,
    staleTime: 5 * 60_000,
  })

  const [team, setTeam] = useState<string>(() => {
    try {
      return localStorage.getItem(TEAM_KEY) ?? ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return
    setTeam((prev) => (prev && workspaces.some((w) => w.id === prev) ? prev : workspaces[0].id))
  }, [workspaces])

  useEffect(() => {
    try {
      if (team) localStorage.setItem(TEAM_KEY, team)
    } catch {
      /* ignore */
    }
  }, [team])

  const [open, setOpen] = useState(false)
  const debounced = useDebounced(value, 300)

  const { data: tasks, isFetching } = useQuery({
    queryKey: binding
      ? ['clickup-list-tasks', projectId, binding.listId, debounced.trim()]
      : ['clickup-tasks', projectId, team, debounced.trim()],
    queryFn: () =>
      binding
        ? clickupListTasks(binding.listId, debounced.trim(), projectId)
        : clickupTasks(team, debounced.trim(), projectId),
    enabled: configured && open && !disabled && (binding ? true : !!team),
    staleTime: 15_000,
  })

  function saveBinding(b: ListBinding) {
    if (!projectId) return
    saveListBinding(projectId, b)
    setBinding(b)
  }

  function clearBinding() {
    if (!projectId) return
    clearListBinding(projectId)
    setBinding(null)
  }

  // Plain input when ClickUp isn't wired up — same look as before.
  if (!configured) {
    return (
      <div className="space-y-2">
        <Label htmlFor="ticketId" className="flex items-center gap-1.5">
          <Ticket className="size-3.5 text-muted-foreground" />
          ClickUp ticket
        </Label>
        <div className="group relative">
          <Ticket className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <Input
            id="ticketId"
            placeholder="ABC-1234"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            className="pl-9 font-mono"
          />
        </div>
        <p className="text-xs text-muted-foreground">The ticket whose acceptance criteria to verify.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="ticketId" className="flex items-center gap-1.5">
          <Ticket className="size-3.5 text-muted-foreground" />
          ClickUp ticket
        </Label>
        <div className="flex items-center gap-1">
          {!binding && workspaces && workspaces.length > 1 && (
            <Select value={team} onValueChange={setTeam} disabled={disabled}>
              <SelectTrigger
                size="sm"
                className="h-7 max-w-40 border-none bg-transparent text-xs text-muted-foreground shadow-none hover:text-foreground"
              >
                <SelectValue placeholder="Workspace" />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id} className="text-xs">
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <button
            type="button"
            onClick={() => setConfiguring(true)}
            disabled={disabled || !projectId}
            title={binding ? 'Change the bound list' : 'Bind this project to a ClickUp list'}
            className="inline-flex max-w-52 items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary disabled:opacity-50"
          >
            {binding ? (
              <>
                <ListChecks className="size-3.5 shrink-0" />
                <span className="truncate">{binding.listName}</span>
              </>
            ) : (
              <>
                <Settings2 className="size-3.5" />
                Use a list
              </>
            )}
          </button>
        </div>
      </div>

      <div className="relative">
        <div className="group relative">
          <Ticket className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <Input
            id="ticketId"
            placeholder={binding ? `Search “${binding.listName}” or type an id…` : 'Search ClickUp tasks or type an id…'}
            value={value}
            autoComplete="off"
            onChange={(e) => {
              onChange(e.target.value)
              setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(false)
            }}
            disabled={disabled}
            className="pl-9 font-mono"
          />
          {isFetching && (
            <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>

        {open && (
          <div className="absolute z-20 mt-1.5 max-h-72 w-full overflow-y-auto rounded-2xl border border-border/60 bg-popover p-1 shadow-lg">
            {!tasks && isFetching && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {binding ? 'Loading list…' : 'Searching…'}
              </div>
            )}
            {tasks && tasks.length === 0 && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Search className="size-3.5" />
                No matching tasks — you can still type an id.
              </div>
            )}
            {tasks?.map((t) => (
              <button
                key={t.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(t.displayId)
                  setOpen(false)
                }}
                className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent"
              >
                <span
                  className="mt-1 size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: t.statusColor || 'var(--muted-foreground)' }}
                  title={t.status}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{t.displayId}</span>
                    {t.status && (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {t.status}
                      </span>
                    )}
                  </span>
                  <span className="line-clamp-1 text-sm">{t.name}</span>
                  {!binding && t.listName && (
                    <span className="line-clamp-1 text-[11px] text-muted-foreground">{t.listName}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {binding
          ? `Tasks from “${binding.listName}”${binding.folderName ? ` (${binding.folderName})` : ''} · or type an id.`
          : 'Search recent tasks across the workspace, or bind a list for the full set.'}
      </p>

      <ConfigureListDialog
        open={configuring}
        onOpenChange={setConfiguring}
        current={binding}
        onSave={saveBinding}
        onClear={clearBinding}
        projectId={projectId}
      />
    </div>
  )
}
