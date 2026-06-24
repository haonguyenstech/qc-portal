import { useEffect, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BookOpen,
  Check,
  Code2,
  FileText,
  FolderGit2,
  Info,
  ListChecks,
  Loader2,
  Minus,
  Pencil,
  Save,
  Search,
  Settings2,
  Sparkles,
  Ticket,
  Trash2,
  Wand2,
  Workflow,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
import { Textarea } from '@/components/ui/textarea'
import { ConfigureListDialog } from '@/components/ConfigureListDialog'
import {
  clickupDocs,
  clickupListTasks,
  clickupStatus,
  clickupTasks,
  clickupWorkspaces,
  createDiagram,
  deleteDiagram,
  listCrawledTickets,
  listDiagrams,
  openMcpFolder,
  updateDiagram,
  updateProject,
  type ClickupDoc,
  type ClickupTask,
  type Diagram,
} from '@/lib/api'
import { MermaidDiagram } from '@/components/MermaidDiagram'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { GenerateDiagramDialog, type DiagramSources } from '@/components/GenerateDiagramDialog'
import { GenerateOverviewDialog } from '@/components/GenerateOverviewDialog'
import {
  clearListBinding,
  loadListBinding,
  saveListBinding,
  type ListBinding,
} from '@/lib/clickupList'
import { useProjects } from '@/lib/project-context'

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

/**
 * "Generate from ClickUp" — pick any mix of ClickUp docs AND tickets, then Claude
 * reads them all and drafts a single overview into the editor for review. Only
 * rendered when ClickUp is configured.
 */
function GenerateFromClickUp({
  projectId,
  projectName,
  existingOverview,
  onGenerated,
  onDiagramSaved,
}: {
  projectId: string
  projectName: string
  existingOverview: string
  onGenerated: (markdown: string) => void
  onDiagramSaved: (diagram: Diagram) => void
}) {
  const { data: status } = useQuery({ queryKey: ['clickup-status'], queryFn: clickupStatus })
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

  return (
    <Card className="overflow-hidden shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          <ListChecks className="h-4 w-4 text-primary" />
          Generate from ClickUp
        </span>
        <span className="text-xs text-muted-foreground">
          Pick any mix of docs &amp; tickets — Claude reads them all and drafts the overview
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
                className="h-9 pl-9"
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
            <div className="max-h-56 overflow-auto rounded-lg border bg-background/50">
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
                className="h-9 pl-9"
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
            <div className="max-h-56 overflow-auto rounded-lg border bg-background/50">
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
              'Select docs and/or tickets above, then pick an action.'
            )}
          </p>

          <div className="grid gap-2.5 sm:grid-cols-2">
            {/* Overview — opens the dialog (replace/update + instructions). */}
            <button
              type="button"
              onClick={() => setOverviewOpen(true)}
              disabled={total === 0}
              className={cn(
                'group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-all duration-200',
                'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:scale-[0.99]',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
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

            {/* Diagram — opens the dialog (instructions + presets + name). */}
            <button
              type="button"
              onClick={() => setDiagramOpen(true)}
              disabled={total === 0}
              className={cn(
                'group flex items-start gap-3 rounded-xl border bg-card p-3 text-left transition-all duration-200',
                'hover:-translate-y-0.5 hover:border-violet-400/50 hover:shadow-md active:scale-[0.99]',
                'disabled:pointer-events-none disabled:opacity-50',
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 transition-colors group-hover:bg-violet-500/15 dark:text-violet-400">
                <Workflow className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold tracking-tight">Generate diagram</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                  Build a Mermaid diagram — add instructions, then save it by name.
                </span>
              </span>
            </button>
          </div>
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

      <GenerateOverviewDialog
        open={overviewOpen}
        onOpenChange={setOverviewOpen}
        sources={diagramSources}
        projectId={projectId}
        projectName={projectName}
        existingOverview={existingOverview}
        onGenerated={onGenerated}
      />

      <GenerateDiagramDialog
        open={diagramOpen}
        onOpenChange={setDiagramOpen}
        sources={diagramSources}
        projectId={projectId}
        projectName={projectName}
        defaultName="Diagram"
        onCreated={onDiagramSaved}
      />
    </Card>
  )
}

// Shared markdown styling — mirrors the Skills editor preview so intros render
// consistently across the app.
const MD_CLASS = cn(
  'text-sm leading-relaxed',
  '[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_p]:my-2.5 [&_p]:text-muted-foreground',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1 [&_li]:text-muted-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-xs [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-zinc-100',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs',
  '[&_hr]:my-5 [&_hr]:border-border',
)

const PLACEHOLDER = `# What is this project?

A short intro for anyone running QC against this repo — what the app does, who
it's for, and anything worth knowing before testing.

## Key areas
- Main flows to focus on
- Known issues or things to skip

## Notes
Markdown is supported.`

const DIAGRAM_PLACEHOLDER = `flowchart TD
  User[User] --> App[Open App]
  App --> Feature[Main Feature]
  Feature --> Result[Result]`

export default function OverviewPage() {
  const { activeProject, activeProjectId, refetch } = useProjects()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [editingDiagram, setEditingDiagram] = useState(false)
  const [diagramDraft, setDiagramDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [selectedDiagramId, setSelectedDiagramId] = useState<string | null>(null)
  const [confirmDeleteDiagram, setConfirmDeleteDiagram] = useState(false)

  const description = activeProject?.description ?? ''

  // Saved diagrams for the active project (multiple, named).
  const { data: diagramsData } = useQuery({
    queryKey: ['diagrams', activeProjectId],
    queryFn: () => listDiagrams(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const diagrams = diagramsData?.diagrams ?? []
  // The diagram currently shown — the chosen one, else the first available.
  const selectedDiagram = diagrams.find((d) => d.id === selectedDiagramId) ?? diagrams[0] ?? null

  // Keep the intro draft in sync with the active project while not editing it.
  useEffect(() => {
    if (!editing) setDraft(description)
  }, [description, editing])

  const save = useMutation({
    mutationFn: () => updateProject(activeProjectId as string, { description: draft }),
    onSuccess: () => {
      toast.success('Overview saved', { description: 'Project intro updated.' })
      setEditing(false)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      refetch()
    },
    onError: (err) =>
      toast.error('Failed to save overview', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const saveDiagram = useMutation({
    mutationFn: () =>
      updateDiagram(selectedDiagram!.id, {
        projectId: activeProjectId as string,
        name: nameDraft,
        content: diagramDraft,
      }),
    onSuccess: ({ diagram }) => {
      toast.success('Diagram saved', { description: `Updated “${diagram.name}”.` })
      setEditingDiagram(false)
      setSelectedDiagramId(diagram.id)
      queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
    },
    onError: (err) =>
      toast.error('Failed to save diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const delDiagram = useMutation({
    mutationFn: () => deleteDiagram(selectedDiagram!.id, activeProjectId as string),
    onSuccess: () => {
      const remaining = diagrams.filter((d) => d.id !== selectedDiagram?.id)
      toast.success('Diagram deleted')
      setConfirmDeleteDiagram(false)
      setSelectedDiagramId(remaining[0]?.id ?? null)
      queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
    },
    onError: (err) =>
      toast.error('Failed to delete diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const addBlank = useMutation({
    mutationFn: () =>
      createDiagram({
        projectId: activeProjectId as string,
        name: 'New diagram',
        content: DIAGRAM_PLACEHOLDER,
      }),
    onSuccess: ({ diagram }) => {
      queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
      setSelectedDiagramId(diagram.id)
      setNameDraft(diagram.name)
      setDiagramDraft(diagram.content)
      setEditingDiagram(true)
    },
    onError: (err) =>
      toast.error('Failed to add diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        </header>
        <Card className="shadow-sm">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <BookOpen className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to see and edit its overview.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const startEditing = (seed?: string) => {
    setDraft(seed ?? description)
    setEditing(true)
  }

  const startEditingDiagram = () => {
    if (!selectedDiagram) return
    setNameDraft(selectedDiagram.name)
    setDiagramDraft(selectedDiagram.content)
    setEditingDiagram(true)
  }

  // A ClickUp-generated overview lands in its editor for review before saving.
  const onGenerated = (markdown: string) => startEditing(markdown)
  // A freshly generated+saved diagram: refresh the list, select it, show it.
  const onDiagramSaved = (d: Diagram) => {
    queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
    setSelectedDiagramId(d.id)
    setEditingDiagram(false)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            A free-text intro about{' '}
            <span className="font-medium text-foreground">{activeProject?.name}</span> — what it is
            and what to know before running QC.
          </p>
        </div>
        {!editing && description && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => startEditing()}
            className="shrink-0 transition-all duration-200 active:scale-[0.98]"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Button>
        )}
      </header>

      {/* Project context chip — which repo this intro belongs to. */}
      {activeProject && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 shadow-sm">
          <span className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
              <FolderGit2 className="h-4 w-4" />
            </span>
            <span className="leading-tight">
              <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                Project
              </span>
              <span className="block text-sm font-semibold tracking-tight">
                {activeProject.name}
              </span>
            </span>
          </span>
          <div className="ml-auto flex min-w-0 items-center gap-2">
            <span
              className="min-w-0 truncate rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
              title={activeProject.rootPath}
            >
              {activeProject.rootPath}
            </span>
            <OpenFolderButton open={() => openMcpFolder(activeProjectId)} label="project" />
          </div>
        </div>
      )}

      {!editing && !editingDiagram && (
        <GenerateFromClickUp
          projectId={activeProjectId}
          projectName={activeProject?.name ?? 'this project'}
          existingOverview={description}
          onGenerated={onGenerated}
          onDiagramSaved={onDiagramSaved}
        />
      )}

      {editing ? (
        <Card className="overflow-hidden shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Editing intro
              <span className="text-xs font-normal text-muted-foreground">Markdown supported</span>
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(description)
                  setEditing(false)
                }}
                disabled={save.isPending}
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="transition-all duration-200 active:scale-[0.98]"
              >
                {save.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                Save
              </Button>
            </div>
          </div>
          <Textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={PLACEHOLDER}
            className="min-h-[420px] resize-y rounded-none border-0 font-mono text-sm leading-relaxed focus-visible:ring-0"
          />
        </Card>
      ) : description ? (
        <Card className="shadow-sm">
          <CardContent className="px-6 py-5">
            <div className={MD_CLASS}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      ) : (
        // No intro yet — invite the user to write one.
        <Card className="border-dashed shadow-sm">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h2 className="text-base font-medium tracking-tight">No overview yet</h2>
              <p className="mx-auto flex max-w-sm items-center justify-center gap-1.5 text-sm text-muted-foreground">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Add a short intro so anyone running QC knows what this project is.
              </p>
            </div>
            <Button
              onClick={() => startEditing(PLACEHOLDER)}
              className="transition-all duration-200 active:scale-[0.98]"
            >
              <Pencil className="h-4 w-4" />
              Write intro
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ---- Project diagrams (multiple named Mermaid diagrams) ---- */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Workflow className="h-4 w-4 text-primary" />
            Project diagrams
            {diagrams.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {diagrams.length}
              </span>
            )}
          </h2>

          {/* Toolbar (view mode): pick a diagram + edit / delete / add blank. */}
          {!editingDiagram && diagrams.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                value={selectedDiagram?.id}
                onValueChange={(v) => {
                  setSelectedDiagramId(v)
                  setConfirmDeleteDiagram(false)
                }}
              >
                <SelectTrigger size="sm" className="h-8 w-52">
                  <SelectValue placeholder="Pick a diagram" />
                </SelectTrigger>
                <SelectContent>
                  {diagrams.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                onClick={() => startEditingDiagram()}
                disabled={!selectedDiagram}
                className="transition-all duration-200 active:scale-[0.98]"
              >
                <Code2 className="h-3.5 w-3.5" />
                Edit
              </Button>
              {confirmDeleteDiagram ? (
                <span className="inline-flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => delDiagram.mutate()}
                    disabled={delDiagram.isPending}
                    className="h-8"
                  >
                    {delDiagram.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDeleteDiagram(false)}
                    disabled={delDiagram.isPending}
                    className="h-8"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDeleteDiagram(true)}
                  disabled={!selectedDiagram}
                  className="h-8 text-destructive transition-all duration-200 hover:text-destructive active:scale-[0.98]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>

        {editingDiagram && selectedDiagram ? (
          <Card className="overflow-hidden shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                <Code2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  placeholder="Diagram name"
                  className="h-8 max-w-xs text-sm"
                />
                <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
                  Mermaid syntax
                </span>
              </span>
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingDiagram(false)}
                  disabled={saveDiagram.isPending}
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveDiagram.mutate()}
                  disabled={saveDiagram.isPending || !nameDraft.trim()}
                  className="transition-all duration-200 active:scale-[0.98]"
                >
                  {saveDiagram.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
            <div className="grid gap-0 lg:grid-cols-2">
              <Textarea
                autoFocus
                value={diagramDraft}
                onChange={(e) => setDiagramDraft(e.target.value)}
                placeholder={DIAGRAM_PLACEHOLDER}
                spellCheck={false}
                className="min-h-[360px] resize-y rounded-none border-0 border-b font-mono text-xs leading-relaxed focus-visible:ring-0 lg:border-b-0 lg:border-r"
              />
              <div className="min-h-[360px] overflow-auto bg-background/50 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  Live preview
                </p>
                <MermaidDiagram chart={diagramDraft} />
              </div>
            </div>
          </Card>
        ) : selectedDiagram ? (
          <Card className="shadow-sm">
            <CardContent className="px-6 py-5">
              <MermaidDiagram chart={selectedDiagram.content} />
            </CardContent>
          </Card>
        ) : (
          // No diagrams yet — invite the user to generate or hand-write one.
          <Card className="border-dashed shadow-sm">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
                <Workflow className="h-5 w-5" />
              </span>
              <div className="space-y-1">
                <h3 className="text-base font-medium tracking-tight">No diagrams yet</h3>
                <p className="mx-auto flex max-w-md items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  Pick ClickUp sources above and hit{' '}
                  <span className="font-medium text-foreground">Generate diagram</span>, or draw one
                  by hand.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() => addBlank.mutate()}
                disabled={addBlank.isPending}
                className="transition-all duration-200 active:scale-[0.98]"
              >
                {addBlank.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Code2 className="h-4 w-4" />
                )}
                Write diagram
              </Button>
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  )
}
