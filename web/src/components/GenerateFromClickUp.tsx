import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  FileText,
  Info,
  ListChecks,
  Loader2,
  Minus,
  Search,
  Settings2,
  Ticket,
  Wand2,
  Workflow,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ConfigureListDialog } from '@/components/ConfigureListDialog'
import {
  clickupDocs,
  clickupListTasks,
  clickupStatus,
  clickupTasks,
  clickupWorkspaces,
  listCrawledTickets,
  type ClickupDoc,
  type ClickupTask,
  type Diagram,
} from '@/lib/api'
import { GenerateDiagramDialog, type DiagramSources } from '@/components/GenerateDiagramDialog'
import { GenerateOverviewDialog } from '@/components/GenerateOverviewDialog'
import {
  clearListBinding,
  loadListBinding,
  saveListBinding,
  type ListBinding,
} from '@/lib/clickupList'

const TEAM_KEY = 'qc.clickupTeam'

/** Mirrors the server's safeSegment() so a ticket id maps to its on-disk folder. */
function safeSegment(s: string): string {
  return (
    s
      .replace(/[/\\]+/g, '-')
      .replace(/[^\w.\- ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120) || 'ticket'
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms)
    return () => clearTimeout(id)
  }, [value, ms])
  return v
}

/** A multi-select row with a checkbox indicator. */
function SourceRow({
  icon,
  selected,
  onToggle,
  children,
}: {
  icon: ReactNode
  selected: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors',
        selected ? 'bg-primary/5 text-foreground' : 'hover:bg-muted text-foreground',
      )}
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
        )}
        aria-hidden
      >
        {selected && <Check className="size-3" />}
      </span>
      {icon}
      {children}
    </button>
  )
}

/** Header checkbox that selects/deselects every item currently in a list. */
function SelectAllBar({
  checked,
  partial,
  count,
  onToggle,
}: {
  checked: boolean
  partial: boolean
  count: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={checked}
      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors',
          checked || partial
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/40',
        )}
        aria-hidden
      >
        {checked ? <Check className="size-3" /> : partial ? <Minus className="size-3" /> : null}
      </span>
      {checked ? 'Deselect all' : 'Select all'}
      <span className="text-muted-foreground/70">({count})</span>
    </button>
  )
}

export type GenerateMode = 'overview' | 'diagram'

/**
 * "Generate from ClickUp" — pick any mix of ClickUp docs AND tickets, then Claude
 * reads them all and either drafts the project overview (`mode="overview"`) or a
 * Mermaid diagram (`mode="diagram"`). Used on both the Overview and Diagrams pages,
 * each surfacing its one relevant action. Only rendered when ClickUp is configured.
 */
export function GenerateFromClickUp({
  projectId,
  projectName,
  mode,
  existingOverview = '',
  onGenerated,
  onDiagramSaved,
}: {
  projectId: string
  projectName: string
  mode: GenerateMode
  existingOverview?: string
  onGenerated?: (markdown: string) => void
  onDiagramSaved?: (diagram: Diagram) => void
}) {
  const { data: status } = useQuery({ queryKey: ['clickup-status'], queryFn: () => clickupStatus() })
  const configured = !!status?.configured

  const {
    data: workspaces,
    isError: wsError,
    error: wsErr,
  } = useQuery({
    queryKey: ['clickup-workspaces', projectId],
    queryFn: () => clickupWorkspaces(projectId),
    enabled: configured,
  })

  const [team, setTeam] = useState<string>(() => {
    try {
      return localStorage.getItem(TEAM_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [tab, setTab] = useState<'docs' | 'tickets'>('docs')
  const [selectedDocs, setSelectedDocs] = useState<Map<string, ClickupDoc>>(new Map())
  const [selectedTickets, setSelectedTickets] = useState<Map<string, ClickupTask>>(new Map())
  const [docQuery, setDocQuery] = useState('')
  const [ticketQuery, setTicketQuery] = useState('')
  const docDebounced = useDebounced(docQuery, 300)
  const ticketDebounced = useDebounced(ticketQuery, 300)

  // Per-project ClickUp list binding — shared with the Tickets page. When set,
  // tickets come from that exact list (workspace → space → list, chosen in the
  // dialog); otherwise they come from a workspace-wide search.
  const [binding, setBinding] = useState<ListBinding | null>(() => loadListBinding(projectId))
  const [configuring, setConfiguring] = useState(false)
  const [seenProject, setSeenProject] = useState(projectId)
  if (seenProject !== projectId) {
    setSeenProject(projectId)
    setBinding(loadListBinding(projectId))
    setSelectedDocs(new Map())
    setSelectedTickets(new Map())
  }

  // Default to the first workspace once they load.
  useEffect(() => {
    if (!team && workspaces && workspaces.length) setTeam(workspaces[0].id)
  }, [workspaces, team])

  function chooseTeam(id: string) {
    setTeam(id)
    setSelectedDocs(new Map())
    setSelectedTickets(new Map())
    try {
      localStorage.setItem(TEAM_KEY, id)
    } catch {
      /* ignore */
    }
  }

  function saveBinding(b: ListBinding) {
    saveListBinding(projectId, b)
    setBinding(b)
    setSelectedTickets(new Map())
  }
  function clearBinding() {
    clearListBinding(projectId)
    setBinding(null)
    setSelectedTickets(new Map())
  }

  const {
    data: docs,
    isFetching: docsFetching,
    isError: docsError,
    error: docErr,
  } = useQuery({
    queryKey: ['clickup-docs', projectId, team, docDebounced],
    queryFn: () => clickupDocs(team, docDebounced, projectId),
    enabled: configured && !!team && tab === 'docs',
  })

  const {
    data: allTickets,
    isFetching: ticketsFetching,
    isError: ticketsError,
    error: ticketErr,
  } = useQuery({
    queryKey: binding
      ? ['clickup-list-tasks', projectId, binding.listId, ticketDebounced]
      : ['clickup-tasks', projectId, team, ticketDebounced],
    queryFn: () =>
      binding
        ? clickupListTasks(binding.listId, ticketDebounced, projectId)
        : clickupTasks(team, ticketDebounced, projectId),
    enabled: configured && tab === 'tickets' && (binding ? true : !!team),
  })

  // Only offer tickets that have already been crawled into the project — those are
  // the ones with local content the overview/diagram is actually built from.
  const { data: crawled } = useQuery({
    queryKey: ['crawled-tickets', projectId],
    queryFn: () => listCrawledTickets(projectId),
    enabled: configured && tab === 'tickets',
  })
  const crawledSet = new Set((crawled ?? []).map((c) => c.name))
  const tickets = (allTickets ?? []).filter((t) => crawledSet.has(safeSegment(t.displayId)))

  const docCount = selectedDocs.size
  const ticketCount = selectedTickets.size
  const total = docCount + ticketCount

  function toggleDoc(d: ClickupDoc) {
    setSelectedDocs((prev) => {
      const next = new Map(prev)
      if (next.has(d.id)) next.delete(d.id)
      else next.set(d.id, d)
      return next
    })
  }
  function toggleTicket(t: ClickupTask) {
    setSelectedTickets((prev) => {
      const next = new Map(prev)
      if (next.has(t.id)) next.delete(t.id)
      else next.set(t.id, t)
      return next
    })
  }

  // Select-all state for the currently-listed docs / tickets.
  const allDocsSelected = !!docs?.length && docs.every((d) => selectedDocs.has(d.id))
  const allTicketsSelected = !!tickets?.length && tickets.every((t) => selectedTickets.has(t.id))

  function toggleAllDocs() {
    setSelectedDocs((prev) => {
      const next = new Map(prev)
      if (allDocsSelected) for (const d of docs ?? []) next.delete(d.id)
      else for (const d of docs ?? []) next.set(d.id, d)
      return next
    })
  }
  function toggleAllTickets() {
    setSelectedTickets((prev) => {
      const next = new Map(prev)
      if (allTicketsSelected) for (const t of tickets ?? []) next.delete(t.id)
      else for (const t of tickets ?? []) next.set(t.id, t)
      return next
    })
  }

  // Both actions open a dedicated dialog (overview: mode + instructions; diagram:
  // instructions + presets + name). Sources come from the current selection.
  const [overviewOpen, setOverviewOpen] = useState(false)
  const [diagramOpen, setDiagramOpen] = useState(false)
  const diagramSources: DiagramSources = {
    team,
    docs: [...selectedDocs.values()].map((d) => ({ id: d.id, name: d.name })),
    tickets: [...selectedTickets.values()].map((t) => ({
      id: t.id,
      displayId: t.displayId,
      name: t.name,
    })),
  }

  if (!configured) return null

  const isOverview = mode === 'overview'

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-primary" />
          Generate from ClickUp
        </span>
        <span className="text-xs text-muted-foreground">
          {isOverview
            ? 'Pick any mix of docs & tickets — Claude reads them all and drafts the overview'
            : 'Pick any mix of docs & tickets — Claude reads them all and draws a diagram'}
        </span>
      </div>

      <CardContent className="space-y-3 p-4">
        {wsError && (
          <p className="flex items-start gap-1.5 rounded-md bg-red-50 px-3 py-2 text-xs text-destructive">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Couldn’t reach ClickUp — reconnect it on the{' '}
              <span className="font-medium">MCP</span> page (token may be expired).
              {wsErr instanceof Error ? ` (${wsErr.message})` : ''}
            </span>
          </p>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'docs' | 'tickets')}>
          <TabsList className="w-full">
            <TabsTrigger value="docs" className="flex-1">
              <FileText className="h-3.5 w-3.5" />
              Docs
              {docCount > 0 && (
                <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                  {docCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="tickets" className="flex-1">
              <Ticket className="h-3.5 w-3.5" />
              Tickets
              {ticketCount > 0 && (
                <span className="ml-1 rounded-full bg-primary/15 px-1.5 text-[10px] font-semibold text-primary">
                  {ticketCount}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="docs" className="mt-3 space-y-3">
            {workspaces && workspaces.length > 1 && (
              <div className="flex items-center justify-end gap-2">
                <span className="text-xs text-muted-foreground">Workspace</span>
                <Select value={team || undefined} onValueChange={chooseTeam}>
                  <SelectTrigger size="sm" className="h-8 w-44">
                    <SelectValue placeholder="Workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {workspaces.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search docs by name…"
                value={docQuery}
                onChange={(e) => setDocQuery(e.target.value)}
                className="h-11 rounded-full pl-9 shadow-none"
              />
            </div>
            {!!docs?.length && (
              <SelectAllBar
                checked={allDocsSelected}
                partial={!allDocsSelected && docs.some((d) => selectedDocs.has(d.id))}
                count={docs.length}
                onToggle={toggleAllDocs}
              />
            )}
            <div className="max-h-56 overflow-auto rounded-xl border border-border/60 bg-muted/60">
              {docsError ? (
                <p className="px-3 py-6 text-center text-xs text-destructive">
                  {docErr instanceof Error ? docErr.message : 'Failed to load docs'}
                </p>
              ) : docsFetching && !docs ? (
                <p className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading docs…
                </p>
              ) : !docs || docs.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                  No docs found.
                </p>
              ) : (
                <ul className="divide-y">
                  {docs.map((d) => (
                    <li key={d.id}>
                      <SourceRow
                        selected={selectedDocs.has(d.id)}
                        onToggle={() => toggleDoc(d)}
                        icon={<FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      >
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                      </SourceRow>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>

          <TabsContent value="tickets" className="mt-3 space-y-3">
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => setConfiguring(true)}
                title={binding ? 'Change the bound list' : 'Pick a workspace, space & list'}
                className="inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
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
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={
                  binding ? `Search “${binding.listName}”…` : 'Search tickets by id or name…'
                }
                value={ticketQuery}
                onChange={(e) => setTicketQuery(e.target.value)}
                className="h-11 rounded-full pl-9 shadow-none"
              />
            </div>
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <Info className="h-3 w-3 shrink-0" />
              Only tickets already crawled into this project are shown.
            </p>
            {!!tickets.length && (
              <SelectAllBar
                checked={allTicketsSelected}
                partial={!allTicketsSelected && tickets.some((t) => selectedTickets.has(t.id))}
                count={tickets.length}
                onToggle={toggleAllTickets}
              />
            )}
            <div className="max-h-56 overflow-auto rounded-xl border border-border/60 bg-muted/60">
              {ticketsError ? (
                <p className="px-3 py-6 text-center text-xs text-destructive">
                  {ticketErr instanceof Error ? ticketErr.message : 'Failed to load tickets'}
                </p>
              ) : ticketsFetching && !allTickets ? (
                <p className="flex items-center justify-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading tickets…
                </p>
              ) : tickets.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                  No crawled tickets here.
                  <br />
                  Crawl tickets on the{' '}
                  <a href="/tickets" className="font-medium text-primary hover:underline">
                    Tickets
                  </a>{' '}
                  page first — only crawled tickets can be used.
                </p>
              ) : (
                <ul className="divide-y">
                  {tickets.map((t) => (
                    <li key={t.id}>
                      <SourceRow
                        selected={selectedTickets.has(t.id)}
                        onToggle={() => toggleTicket(t)}
                        icon={
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: t.statusColor || 'var(--muted-foreground)' }}
                            title={t.status}
                            aria-hidden
                          />
                        }
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <span className="shrink-0 font-mono text-xs font-medium">
                              {t.displayId}
                            </span>
                            <span className="truncate">{t.name}</span>
                          </span>
                        </span>
                      </SourceRow>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <div className="space-y-2.5">
          <p className="text-xs text-muted-foreground">
            {total > 0 ? (
              <>
                Selected:{' '}
                <span className="font-medium text-foreground">
                  {docCount} doc{docCount === 1 ? '' : 's'} · {ticketCount} ticket
                  {ticketCount === 1 ? '' : 's'}
                </span>
              </>
            ) : (
              `Select docs and/or tickets above, then ${
                isOverview ? 'draft the overview' : 'generate a diagram'
              }.`
            )}
          </p>

          {isOverview ? (
            <button
              type="button"
              onClick={() => setOverviewOpen(true)}
              disabled={total === 0}
              className={cn(
                'group flex w-full items-start gap-3 rounded-2xl border border-border/60 bg-muted/60 p-3 text-left transition-all duration-200',
                'hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.99]',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
                <Wand2 className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold tracking-tight">
                  Read &amp; write overview
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  Draft fresh or update the existing intro from the selected sources.
                </span>
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setDiagramOpen(true)}
              disabled={total === 0}
              className={cn(
                'group flex w-full items-start gap-3 rounded-2xl border border-border/60 bg-muted/60 p-3 text-left transition-all duration-200',
                'hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.99]',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground text-background">
                <Workflow className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold tracking-tight">Generate diagram</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  Build a Mermaid diagram — add instructions, then save it by name.
                </span>
              </span>
            </button>
          )}
        </div>
      </CardContent>

      <ConfigureListDialog
        open={configuring}
        onOpenChange={setConfiguring}
        current={binding}
        onSave={saveBinding}
        onClear={clearBinding}
        projectId={projectId}
      />

      {isOverview && (
        <GenerateOverviewDialog
          open={overviewOpen}
          onOpenChange={setOverviewOpen}
          sources={diagramSources}
          projectId={projectId}
          projectName={projectName}
          existingOverview={existingOverview}
          onGenerated={(md) => onGenerated?.(md)}
        />
      )}

      {!isOverview && (
        <GenerateDiagramDialog
          open={diagramOpen}
          onOpenChange={setDiagramOpen}
          sources={diagramSources}
          projectId={projectId}
          projectName={projectName}
          defaultName="Diagram"
          onCreated={(d) => onDiagramSaved?.(d)}
        />
      )}
    </Card>
  )
}
