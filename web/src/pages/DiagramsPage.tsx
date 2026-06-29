import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Code2,
  FolderGit2,
  Info,
  Loader2,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
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
import { Textarea } from '@/components/ui/textarea'
import {
  createDiagram,
  deleteDiagram,
  listDiagrams,
  openMcpFolder,
  updateDiagram,
  type Diagram,
} from '@/lib/api'
import { MermaidDiagram } from '@/components/MermaidDiagram'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { GenerateFromClickUp } from '@/components/GenerateFromClickUp'
import { useProjects } from '@/lib/project-context'

const DIAGRAM_PLACEHOLDER = `flowchart TD
  User[User] --> App[Open App]
  App --> Feature[Main Feature]
  Feature --> Result[Result]`

export default function DiagramsPage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [nameDraft, setNameDraft] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: diagramsData } = useQuery({
    queryKey: ['diagrams', activeProjectId],
    queryFn: () => listDiagrams(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const diagrams = diagramsData?.diagrams ?? []
  const selected = diagrams.find((d) => d.id === selectedId) ?? diagrams[0] ?? null

  const saveMut = useMutation({
    mutationFn: () =>
      updateDiagram(selected!.id, {
        projectId: activeProjectId as string,
        name: nameDraft,
        content: draft,
      }),
    onSuccess: ({ diagram }) => {
      toast.success('Diagram saved', { description: `Updated “${diagram.name}”.` })
      setEditing(false)
      setSelectedId(diagram.id)
      queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
    },
    onError: (err) =>
      toast.error('Failed to save diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const delMut = useMutation({
    mutationFn: () => deleteDiagram(selected!.id, activeProjectId as string),
    onSuccess: () => {
      const remaining = diagrams.filter((d) => d.id !== selected?.id)
      toast.success('Diagram deleted')
      setConfirmDelete(false)
      setSelectedId(remaining[0]?.id ?? null)
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
      setSelectedId(diagram.id)
      setNameDraft(diagram.name)
      setDraft(diagram.content)
      setEditing(true)
    },
    onError: (err) =>
      toast.error('Failed to add diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  if (!activeProjectId || !activeProject) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Workflow className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Diagrams</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <Workflow className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to manage its diagrams.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const startEditing = () => {
    if (!selected) return
    setNameDraft(selected.name)
    setDraft(selected.content)
    setEditing(true)
  }

  const onDiagramSaved = (d: Diagram) => {
    queryClient.invalidateQueries({ queryKey: ['diagrams', activeProjectId] })
    setSelectedId(d.id)
    setEditing(false)
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Workflow className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Diagrams</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Named Mermaid diagrams for{' '}
              <span className="font-medium text-foreground">{activeProject.name}</span> — generate
              them from ClickUp or draw them by hand.
            </p>
          </div>
        </div>
        {!editing && diagrams.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => addBlank.mutate()}
            disabled={addBlank.isPending}
            className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {addBlank.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            New diagram
          </Button>
        )}
      </header>

      {/* Project context chip */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
        <span className="flex items-center gap-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
            <FolderGit2 className="h-4 w-4" />
          </span>
          <span className="leading-tight">
            <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
              Project
            </span>
            <span className="block text-sm font-semibold tracking-tight">{activeProject.name}</span>
          </span>
        </span>
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span
            className="min-w-0 truncate rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
            title={activeProject.rootPath}
          >
            {activeProject.rootPath}
          </span>
          <OpenFolderButton open={() => openMcpFolder(activeProjectId)} label="project" />
        </div>
      </div>

      {!editing && (
        <GenerateFromClickUp
          projectId={activeProjectId}
          projectName={activeProject.name}
          mode="diagram"
          onDiagramSaved={onDiagramSaved}
        />
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <Workflow className="h-4 w-4 text-primary" />
            Saved diagrams
            {diagrams.length > 0 && (
              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
                {diagrams.length}
              </span>
            )}
          </h2>

          {!editing && diagrams.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                value={selected?.id}
                onValueChange={(v) => {
                  setSelectedId(v)
                  setConfirmDelete(false)
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
                onClick={startEditing}
                disabled={!selected}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                <Code2 className="h-3.5 w-3.5" />
                Edit
              </Button>
              {confirmDelete ? (
                <span className="inline-flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => delMut.mutate()}
                    disabled={delMut.isPending}
                    className="h-8 rounded-full"
                  >
                    {delMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                    Confirm
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDelete(false)}
                    disabled={delMut.isPending}
                    className="h-8 rounded-full"
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmDelete(true)}
                  disabled={!selected}
                  className="h-8 rounded-full text-destructive transition-all duration-200 hover:text-destructive active:scale-[0.98]"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              )}
            </div>
          )}
        </div>

        {editing && selected ? (
          <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
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
                  onClick={() => setEditing(false)}
                  disabled={saveMut.isPending}
                  className="rounded-full"
                >
                  <X className="h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => saveMut.mutate()}
                  disabled={saveMut.isPending || !nameDraft.trim()}
                  className="rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {saveMut.isPending ? (
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
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={DIAGRAM_PLACEHOLDER}
                spellCheck={false}
                className="min-h-[360px] resize-y rounded-none border-0 border-b font-mono text-xs leading-relaxed focus-visible:ring-0 lg:border-b-0 lg:border-r"
              />
              <div className="min-h-[360px] overflow-auto bg-muted/60 p-4">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  Live preview
                </p>
                <MermaidDiagram chart={draft} />
              </div>
            </div>
          </Card>
        ) : selected ? (
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="px-6 py-5">
              <MermaidDiagram chart={selected.content} />
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
            <CardContent className="flex flex-col items-center gap-3 py-14 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background">
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
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
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
