import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BrainCog,
  Eye,
  FileText,
  Info,
  Loader2,
  Pencil,
  PenLine,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  deleteMemoryNote,
  getMemoryNote,
  listMemory,
  openMemoryFolder,
  saveMemoryNote,
  type MemoryNote,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'

/**
 * Provenance label for a note: AI-captured (source starts with "ai") vs.
 * hand-authored. `source` for AI notes is like "ai · feedback" — surfaced in the
 * tooltip so the origin/type is still readable.
 */
function ProvenanceBadge({ source }: { source?: string }) {
  const isAi = !!source?.toLowerCase().startsWith('ai')
  if (isAi) {
    return (
      <span
        title={source}
        className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
      >
        <Sparkles className="size-2.5" /> AI
      </span>
    )
  }
  return (
    <span
      title="Hand-authored note"
      className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground"
    >
      <PenLine className="size-2.5" /> Manual
    </span>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const s = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

// Mirrors the knowledge/preview markdown styling so note bodies render consistently.
const MD_CLASS = cn(
  'text-sm leading-relaxed',
  '[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mt-5 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-4 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_p]:my-2.5 [&_p]:text-muted-foreground',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1 [&_li]:text-muted-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-xs [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-zinc-100',
  '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs',
)

/** The form body — state is seeded from props at mount (the wrapper remounts it via
 *  `key` on note/data change), so no setState-in-effect is needed. */
function NoteForm({
  isNew,
  initialName,
  initialDescription,
  initialContent,
  noteName,
  projectId,
  onClose,
}: {
  isNew: boolean
  initialName: string
  initialDescription: string
  initialContent: string
  noteName: string | null // existing note name (for query invalidation)
  projectId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(initialName)
  const [description, setDescription] = useState(initialDescription)
  const [content, setContent] = useState(initialContent)

  const save = useMutation({
    mutationFn: () => saveMemoryNote(name.trim(), description.trim(), content, projectId),
    onSuccess: () => {
      toast.success(isNew ? 'Memory note added' : 'Memory note saved', { description: name.trim() })
      queryClient.invalidateQueries({ queryKey: ['memory', projectId] })
      if (noteName) queryClient.invalidateQueries({ queryKey: ['memory-note', projectId, noteName] })
      // The pointer block in CLAUDE.md may have appeared — refresh its editor.
      queryClient.invalidateQueries({ queryKey: ['claude-md', projectId] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      onClose()
    },
    onError: (e) =>
      toast.error('Could not save note', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const canSave = name.trim().length > 0 && content.trim().length > 0 && !save.isPending

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="mem-name" className="text-xs font-medium">
            Name
          </Label>
          <Input
            id="mem-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isNew} // renaming would orphan the file — create a new note instead
            placeholder="e.g. login-uses-otp"
            className="rounded-xl"
          />
          {!isNew && (
            <p className="text-[11px] text-muted-foreground">
              The file name is fixed once created — make a new note to use a different name.
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mem-desc" className="text-xs font-medium">
            Description <span className="text-muted-foreground">(one line, for the index)</span>
          </Label>
          <Input
            id="mem-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this fact is about — shown in MEMORY.md"
            className="rounded-xl"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mem-body" className="text-xs font-medium">
            Fact
          </Label>
          <Textarea
            id="mem-body"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder={'The durable fact, in Markdown.\n\nKeep it small and specific — one idea per note.'}
            className="min-h-[16rem] resize-y rounded-xl font-mono text-xs leading-relaxed"
          />
        </div>
      </div>

      <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-muted/30 px-5 py-3">
        <Button variant="ghost" onClick={onClose} disabled={save.isPending} className="rounded-full">
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={!canSave} className="rounded-full active:scale-[0.98]">
          {save.isPending ? (
            <Loader2 className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <Save className="mr-1.5 size-3.5" />
          )}
          Save
        </Button>
      </DialogFooter>
    </>
  )
}

/** Edit/create dialog. `note === null` opens a blank form for a brand-new note. */
function NoteEditor({
  open,
  note,
  projectId,
  onOpenChange,
}: {
  open: boolean
  note: MemoryNote | null // null = creating
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const isNew = note === null

  // Load the full note body when editing; the form remounts (via key) once it lands.
  const { data, isFetching } = useQuery({
    queryKey: ['memory-note', projectId, note?.name],
    queryFn: () => getMemoryNote(note!.name, projectId),
    enabled: open && !!note,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BrainCog className="h-4 w-4 text-muted-foreground" />
            {isNew ? 'New memory note' : note?.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            One durable fact per note · stored in testing/memory/
          </DialogDescription>
        </DialogHeader>

        {isNew ? (
          <NoteForm
            key="new"
            isNew
            initialName=""
            initialDescription=""
            initialContent=""
            noteName={null}
            projectId={projectId}
            onClose={() => onOpenChange(false)}
          />
        ) : isFetching && !data ? (
          <div className="px-5 py-12">
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          </div>
        ) : data ? (
          <NoteForm
            key={`${data.name}:${data.savedAt}`}
            isNew={false}
            initialName={data.name}
            initialDescription={data.description}
            initialContent={data.content}
            noteName={note?.name ?? null}
            projectId={projectId}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function PreviewDialog({
  note,
  projectId,
  onOpenChange,
}: {
  note: MemoryNote | null
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const { data, isFetching } = useQuery({
    queryKey: ['memory-note', projectId, note?.name],
    queryFn: () => getMemoryNote(note!.name, projectId),
    enabled: !!note,
  })

  return (
    <Dialog open={!!note} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <BrainCog className="h-4 w-4 text-muted-foreground" />
            {note?.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {note?.description || 'Durable fact · testing/memory/'}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {isFetching && !data ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : (
            <div className={MD_CLASS}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{data?.content ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function MemoryNotes({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState<{ open: boolean; note: MemoryNote | null }>({
    open: false,
    note: null,
  })
  const [preview, setPreview] = useState<MemoryNote | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: notes } = useQuery({
    queryKey: ['memory', projectId],
    queryFn: () => listMemory(projectId),
    enabled: !!projectId,
  })

  const del = useMutation({
    mutationFn: (name: string) => deleteMemoryNote(name, projectId),
    onSuccess: (_r, name) => {
      toast.success('Note removed', { description: name })
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['memory', projectId] })
      queryClient.invalidateQueries({ queryKey: ['claude-md', projectId] })
    },
    onError: (e) =>
      toast.error('Could not remove note', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <BrainCog className="h-4 w-4 text-primary" />
          Memory
          {notes && notes.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {notes.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <OpenFolderButton open={() => openMemoryFolder(projectId)} label="memory" />
          <Button
            size="sm"
            onClick={() => setEditing({ open: true, note: null })}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            <Plus className="size-3.5" /> New note
          </Button>
        </div>
      </div>

      <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1 leading-relaxed">
          <p>
            Durable facts for {projectName} — one per note (decisions, gotchas, conventions).
          </p>
          <p>
            Stored under{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">testing/memory/</code>{' '}
            with an auto-generated{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">MEMORY.md</code>{' '}
            index, so Claude reads them on every run instead of you cramming them into CLAUDE.md.
          </p>
        </div>
      </div>

      {notes && notes.length > 0 ? (
        <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
            <span className="text-xs font-semibold tracking-tight">
              {notes.length} note{notes.length === 1 ? '' : 's'}
            </span>
            <span
              className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground"
              title="An index of every note, regenerated automatically on each change"
            >
              <FileText className="size-3" /> MEMORY.md index
            </span>
          </div>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/60">
              {notes.map((n) => (
                <li
                  key={n.name}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                    <BrainCog className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium tracking-tight" title={n.name}>
                        {n.name}
                      </span>
                      <ProvenanceBadge source={n.source} />
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground" title={n.description}>
                      {n.description || 'No description'} · {formatBytes(n.size)} ·{' '}
                      {timeAgo(n.savedAt)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPreview(n)}
                    className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
                  >
                    <Eye className="size-3.5" /> Preview
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing({ open: true, note: n })}
                    className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
                  >
                    <Pencil className="size-3.5" /> Edit
                  </Button>
                  {confirmDelete === n.name ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => del.mutate(n.name)}
                        disabled={del.isPending}
                        className="h-8 rounded-full"
                      >
                        {del.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                        Confirm
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(null)}
                        disabled={del.isPending}
                        className="h-8 rounded-full"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmDelete(n.name)}
                      className="shrink-0 rounded-full text-destructive hover:text-destructive active:scale-[0.98]"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <BrainCog className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No memory notes yet</p>
              <p className="max-w-sm text-sm text-muted-foreground">
                Capture a durable fact — a decision, a gotcha, a convention — so Claude remembers it
                on every run.
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => setEditing({ open: true, note: null })}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              <Plus className="size-3.5" /> New note
            </Button>
          </CardContent>
        </Card>
      )}

      <NoteEditor
        open={editing.open}
        note={editing.note}
        projectId={projectId}
        onOpenChange={(o) => setEditing((s) => ({ ...s, open: o }))}
      />
      <PreviewDialog
        note={preview}
        projectId={projectId}
        onOpenChange={(o) => !o && setPreview(null)}
      />
    </section>
  )
}
