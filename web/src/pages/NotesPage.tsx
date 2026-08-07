import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  Archive,
  CheckSquare,
  Clock,
  Edit3,
  Grid2X2,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tags,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useProjects } from '@/lib/project-context'
import { addWorkspaceLabel, createWorkspaceNote, deleteWorkspaceLabel, deleteWorkspaceNote, emptyWorkspaceTrash, listWorkspaceNotes, renameWorkspaceLabel, updateWorkspaceNote, type WorkspaceNote } from '@/lib/api'
import { LOOKS_LIKE_HTML } from '@/lib/noteHtml'

// TipTap + lowlight are heavy, and only the note dialog needs them — load on first open.
const NoteEditor = lazy(() => import('@/components/NoteEditor'))

type Label = string

type Note = WorkspaceNote

const LABELS: { name: Label; color: string }[] = [
  { name: 'Family', color: 'bg-pink-500' },
  { name: 'Tasks', color: 'bg-purple-500' },
  { name: 'Personal', color: 'bg-emerald-500' },
  { name: 'Meetings', color: 'bg-cyan-500' },
  { name: 'Shopping', color: 'bg-teal-500' },
  { name: 'Planning', color: 'bg-orange-500' },
  { name: 'Travel', color: 'bg-blue-500' },
]

type ConfirmState =
  | { kind: 'delete-forever'; note: Note }
  | { kind: 'empty-trash' }
  | { kind: 'delete-label'; name: string }

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function LabelChip({ label, labels }: { label: Label; labels: { name: Label; color: string }[] }) {
  const color = labels.find((item) => item.name === label)?.color ?? 'bg-muted-foreground'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2.5 py-1 text-[11px] font-medium text-foreground">
      <span className={cn('size-2 rounded-full', color)} />
      {label}
    </span>
  )
}

/**
 * A note body, whatever shape it was stored in.
 *
 * Three sources write these and only one of them writes HTML: the rich-text editor (HTML),
 * the Chat page's "save to Notes" (MARKDOWN — a copied answer is markdown by nature), and
 * pre-editor notes (plain text). The card used to dump anything non-HTML through
 * `whitespace-pre-line`, so a saved chat answer rendered as literal `> quote`, `**bold**` and
 * backticked field lists — the wall of syntax in the screenshot that prompted this. Markdown
 * goes through react-markdown into the SAME `.note-body` styles the editor's HTML uses, so
 * both shapes look like one product.
 */
const NoteBody = memo(function NoteBody({ body, className }: { body: string; className?: string }) {
  if (LOOKS_LIKE_HTML.test(body)) {
    return <div className={cn('note-body', className)} dangerouslySetInnerHTML={{ __html: body }} />
  }
  return (
    <div className={cn('note-body', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{body}</ReactMarkdown>
    </div>
  )
})

/** Body text with markup stripped — the one-line preview a list row shows. */
function plainText(body: string): string {
  return body
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#>*_`~]/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Is this element taller than the box clamping it?
 *
 * The card clamps a body to a fixed height, and the fade + "Read more" must appear ONLY when
 * something is actually hidden — a gradient over the last line of a three-line note reads as a
 * rendering bug. Observed rather than computed, because markdown height isn't known until the
 * browser has laid it out (and changes with the column width).
 */
function useOverflowing(deps: unknown) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const measure = useCallback(() => {
    const el = ref.current
    if (el) setOverflowing(el.scrollHeight - el.clientHeight > 4)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
    // `deps` re-measures when the body changes; the observer covers resize + late layout
    // (markdown images, a font swapping in).
  }, [deps, measure])
  return { ref, overflowing }
}

function NoteMenu({
  note,
  onEdit,
  onArchive,
  onDelete,
}: {
  note: Note
  onEdit: (note: Note) => void
  onArchive: (note: Note) => void
  onDelete: (note: Note) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function closeOnOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menuOpen])

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label={`More options for ${note.title}`}
        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {menuOpen && (
        <div ref={menuRef} className="absolute right-0 top-8 z-20 w-44 rounded-xl border border-border/70 bg-popover p-1 text-sm shadow-lg">
          {!note.trashed && (
            <button type="button" onClick={() => { onEdit(note); setMenuOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted">
              <Pencil className="size-3.5" />
              Edit note
            </button>
          )}
          <button type="button" onClick={() => { onArchive(note); setMenuOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-muted">
            {note.trashed || note.archived ? <RotateCcw className="size-3.5" /> : <Archive className="size-3.5" />}
            {note.trashed ? 'Restore note' : note.archived ? 'Restore note' : 'Archive note'}
          </button>
          <button type="button" onClick={() => { onDelete(note); setMenuOpen(false) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-destructive hover:bg-destructive/10">
            <Trash2 className="size-3.5" />
            {note.trashed ? 'Delete forever' : 'Move to trash'}
          </button>
        </div>
      )}
    </div>
  )
}

/** "Edited 7 Aug 2026" / "Created 7 Aug 2026" — whichever actually happened last. */
function noteStamp(note: Note): string {
  return note.updatedAt !== note.createdAt
    ? `Edited ${formatDate(note.updatedAt)}`
    : `Created ${formatDate(note.createdAt)}`
}

/** Height the grid clamps a body to — about eight lines, enough to recognise a note by. */
const CARD_BODY_CLAMP = 'max-h-44'

function NoteCard({
  note,
  labels,
  onOpen,
  onEdit,
  onArchive,
  onDelete,
}: {
  note: Note
  labels: { name: Label; color: string }[]
  onOpen: (note: Note) => void
  onEdit: (note: Note) => void
  onArchive: (note: Note) => void
  onDelete: (note: Note) => void
}) {
  const { ref, overflowing } = useOverflowing(note.body)
  return (
    <article
      draggable={!note.trashed}
      onDragStart={(event) => event.dataTransfer.setData('text/note-id', note.id)}
      // No `h-full`: it resolves against the grid ROW, which undoes `items-start` and brings
      // back the empty card under a short note.
      className="group relative flex flex-col rounded-2xl border border-border/60 bg-card transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
    >
      {/* The whole card opens the reader — clamped content needs a way to be read in full, and
          a card-sized target beats hunting for a link. Absolute rather than wrapping the
          content, so the ⋯ menu and label chips stay clickable on top of it. */}
      <button
        type="button"
        onClick={() => onOpen(note)}
        aria-label={`Open "${note.title}"`}
        className="absolute inset-0 z-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="pointer-events-none relative z-10 flex min-h-0 flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          {/* Clamped to two lines: a chat-saved note is titled with the whole question, and at
              24px unclamped one of them wrapped to six lines and pushed its own body off. */}
          <h2 title={note.title} className="min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug tracking-tight line-clamp-2">
            {note.title}
          </h2>
          <span className="pointer-events-auto">
            <NoteMenu note={note} onEdit={onEdit} onArchive={onArchive} onDelete={onDelete} />
          </span>
        </div>
        {note.body ? (
          <div className="mt-3">
            {/* The fade is positioned against the CLAMP box, not this wrapper — with
                "Read more" inside the same relative parent, `bottom-0` landed on the link's
                line and left the actually-cut line of text sharp above it. */}
            <div className="relative">
              <div ref={ref} className={cn('overflow-hidden', CARD_BODY_CLAMP)}>
                <NoteBody body={note.body} />
              </div>
              {/* Fades the cut instead of slicing a line in half — and only when something
                  really is hidden (see useOverflowing). */}
              {overflowing && <div aria-hidden className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-card" />}
            </div>
            {overflowing && (
              <span className="mt-1 inline-block text-xs font-medium text-muted-foreground group-hover:text-foreground">
                Read more
              </span>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm italic text-muted-foreground/70">No content yet.</p>
        )}
        <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
          {note.labels.map((label) => <LabelChip key={label} label={label} labels={labels} />)}
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="size-3" />
            {noteStamp(note)}
          </span>
        </div>
      </div>
    </article>
  )
}

/** List view: one scannable line per note — title, a flattened snippet, labels, date. */
function NoteRow({
  note,
  labels,
  onOpen,
  onEdit,
  onArchive,
  onDelete,
}: {
  note: Note
  labels: { name: Label; color: string }[]
  onOpen: (note: Note) => void
  onEdit: (note: Note) => void
  onArchive: (note: Note) => void
  onDelete: (note: Note) => void
}) {
  const snippet = useMemo(() => plainText(note.body ?? ''), [note.body])
  return (
    <article
      draggable={!note.trashed}
      onDragStart={(event) => event.dataTransfer.setData('text/note-id', note.id)}
      className="group relative flex items-center gap-4 rounded-xl border border-border/60 bg-card px-4 py-3 transition-colors hover:border-border hover:bg-muted/40"
    >
      <button type="button" onClick={() => onOpen(note)} aria-label={`Open "${note.title}"`} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <div className="pointer-events-none relative min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold tracking-tight">{note.title}</h2>
        {snippet && <p className="truncate text-xs text-muted-foreground">{snippet}</p>}
      </div>
      <div className="relative hidden shrink-0 items-center gap-2 sm:flex">
        {note.labels.map((label) => <LabelChip key={label} label={label} labels={labels} />)}
      </div>
      <span className="relative hidden shrink-0 text-[11px] text-muted-foreground md:inline">{noteStamp(note)}</span>
      <div className="relative">
        <NoteMenu note={note} onEdit={onEdit} onArchive={onArchive} onDelete={onDelete} />
      </div>
    </article>
  )
}

export default function NotesPage() {
  const { activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const notesQuery = useQuery({
    queryKey: ['workspace-notes', activeProjectId],
    queryFn: () => listWorkspaceNotes(activeProjectId!),
    enabled: !!activeProjectId,
  })
  const notes = notesQuery.data?.notes ?? []
  const labels = (notesQuery.data?.labels ?? []).map((name) => ({
    name,
    color: LABELS.find((label) => label.name === name)?.color ?? 'bg-slate-500',
  }))
  const [query, setQuery] = useState('')
  const [activeSection, setActiveSection] = useState<'notes' | 'archive' | 'trash'>('notes')
  const [activeLabel, setActiveLabel] = useState<Label | null>(null)
  const [view, setView] = useState<'grid' | 'list'>('grid')
  const [formOpen, setFormOpen] = useState(false)
  const [editingNote, setEditingNote] = useState<Note | null>(null)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [newLabel, setNewLabel] = useState<Label | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  /** The note open in the reader. Cards clamp their body, so this is how a long one is read. */
  const [readingNote, setReadingNote] = useState<Note | null>(null)
  const [dragOverTrash, setDragOverTrash] = useState(false)
  const [labelsOpen, setLabelsOpen] = useState(false)
  const [labelName, setLabelName] = useState('')
  const [editingLabel, setEditingLabel] = useState<string | null>(null)
  const [editingLabelName, setEditingLabelName] = useState('')

  // The delete-label confirm dialog stacks a second Radix Dialog over the labels
  // dialog. Radix dismisses the outer dialog on any "interaction outside" — and
  // decides that on TRAILING events too (the focus-outside fired as the inner dialog
  // unmounts), by which time a plain boolean flag is already false. So the guard
  // stays armed ~400ms past the inner dialog's close (see ApiFlowPanel — same trap).
  const guardedUntil = useRef(0)
  const blockDismiss = () => Date.now() < guardedUntil.current
  const armGuard = () => { guardedUntil.current = Number.POSITIVE_INFINITY }
  const disarmGuard = () => { guardedUntil.current = Date.now() + 400 }

  // The note editor's link popover is a floating layer inside this dialog. Radix's Escape
  // handler is a document CAPTURE listener registered before the editor mounts, so it always
  // fires first: without this, one Escape closed the popover AND the dialog, discarding the
  // unsaved note. No trailing window here (unlike the labels guard, which fights TRAILING
  // focus events) — the popover clears the flag in the same key press, so a second Escape
  // closes the dialog as expected.
  const editorLayerOpen = useRef(false)

  const createMutation = useMutation({
    mutationFn: () => createWorkspaceNote({ title: newTitle, body: newBody, label: newLabel ?? undefined }, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      setFormOpen(false)
      setEditingNote(null)
      toast.success('Note saved to the workspace')
    },
    onError: (error) => toast.error('Could not save note', { description: error instanceof Error ? error.message : undefined }),
  })
  const updateMutation = useMutation({
    mutationFn: ({ note, title, body, label }: { note: Note; title: string; body: string; label: Label | null }) =>
      updateWorkspaceNote(note.id, { title, body, labels: label ? [label] : [] }, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      setFormOpen(false)
      setEditingNote(null)
      toast.success('Note updated')
    },
    onError: (error) => toast.error('Could not update note', { description: error instanceof Error ? error.message : undefined }),
  })
  const archiveMutation = useMutation({
    mutationFn: (note: Note) => updateWorkspaceNote(note.id, { archived: !note.archived }, activeProjectId!),
    onSuccess: (_data, note) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      toast.success(note.archived ? 'Note restored' : 'Note archived')
    },
    onError: (error) => toast.error('Could not update note', { description: error instanceof Error ? error.message : undefined }),
  })
  const deleteMutation = useMutation({
    mutationFn: (note: Note) => deleteWorkspaceNote(note.id, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      toast.success('Note deleted forever')
    },
    onError: (error) => toast.error('Could not delete note', { description: error instanceof Error ? error.message : undefined }),
  })
  const trashMutation = useMutation({
    mutationFn: (note: Note) => updateWorkspaceNote(note.id, { trashed: true, archived: false }, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      toast.success('Note moved to Trash')
    },
    onError: (error) => toast.error('Could not move note to Trash', { description: error instanceof Error ? error.message : undefined }),
  })
  const emptyTrashMutation = useMutation({
    mutationFn: () => emptyWorkspaceTrash(activeProjectId!),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      toast.success(data.removed > 0 ? `Trash emptied (${data.removed} note${data.removed === 1 ? '' : 's'} deleted)` : 'Trash is already empty')
    },
    onError: (error) => toast.error('Could not empty Trash', { description: error instanceof Error ? error.message : undefined }),
  })
  const labelMutation = useMutation({
    mutationFn: (name: string) => addWorkspaceLabel(name, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      setLabelName('')
    },
    onError: (error) => toast.error('Could not add label', { description: error instanceof Error ? error.message : undefined }),
  })
  const deleteLabelMutation = useMutation({
    mutationFn: (name: string) => deleteWorkspaceLabel(name, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      if (activeLabel && labels.some((label) => label.name === activeLabel) === false) setActiveLabel(null)
      toast.success('Label deleted')
    },
    onError: (error) => toast.error('Could not delete label', { description: error instanceof Error ? error.message : undefined }),
  })
  const renameLabelMutation = useMutation({
    mutationFn: ({ oldName, newName }: { oldName: string; newName: string }) => renameWorkspaceLabel(oldName, newName, activeProjectId!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
      setEditingLabel(null)
      toast.success('Label renamed')
    },
    onError: (error) => toast.error('Could not rename label', { description: error instanceof Error ? error.message : undefined }),
  })

  const counts = useMemo(() => ({
    notes: notes.filter((note) => !note.trashed && !note.archived).length,
    archive: notes.filter((note) => !note.trashed && note.archived).length,
    trash: notes.filter((note) => note.trashed).length,
  }), [notes])

  const filteredNotes = useMemo(() => notes.filter((note) => {
    const matchesSection = activeSection === 'trash' ? note.trashed : !note.trashed && (activeSection === 'archive' ? note.archived : !note.archived)
    const matchesQuery = `${note.title} ${note.body ?? ''} ${note.labels.join(' ')}`.toLowerCase().includes(query.toLowerCase())
    const matchesLabel = !activeLabel || note.labels.includes(activeLabel)
    return matchesSection && matchesQuery && matchesLabel
  }), [activeLabel, activeSection, notes, query])

  function openAddDialog() {
    setEditingNote(null)
    setNewTitle('')
    setNewBody('')
    setNewLabel(null)
    setFormOpen(true)
  }

  function openEditDialog(note: Note) {
    setEditingNote(note)
    setNewTitle(note.title)
    setNewBody(note.body)
    setNewLabel(note.labels[0] ?? null)
    setFormOpen(true)
  }

  function submitForm() {
    if (!activeProjectId) return
    if (editingNote) updateMutation.mutate({ note: editingNote, title: newTitle, body: newBody, label: newLabel })
    else createMutation.mutate()
  }

  function archiveNote(note: Note) {
    if (note.trashed) {
      updateWorkspaceNote(note.id, { trashed: false }, activeProjectId!).then(() => {
        queryClient.invalidateQueries({ queryKey: ['workspace-notes', activeProjectId] })
        toast.success('Note restored')
      })
      return
    }
    archiveMutation.mutate(note)
  }

  function deleteNote(note: Note) {
    if (note.trashed) setConfirmState({ kind: 'delete-forever', note })
    else trashMutation.mutate(note)
  }

  function dropNoteInTrash(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    setDragOverTrash(false)
    const id = event.dataTransfer.getData('text/note-id')
    const note = notes.find((item) => item.id === id)
    if (note && !note.trashed) trashMutation.mutate(note)
  }

  function confirmAction() {
    if (!confirmState) return
    if (confirmState.kind === 'delete-forever') deleteMutation.mutate(confirmState.note)
    else if (confirmState.kind === 'empty-trash') emptyTrashMutation.mutate()
    else deleteLabelMutation.mutate(confirmState.name)
    setConfirmState(null)
    disarmGuard()
  }

  function addLabel() {
    const name = labelName.trim()
    if (!name || labels.some((label) => label.name.toLowerCase() === name.toLowerCase())) return
    labelMutation.mutate(name)
  }

  function deleteLabel(name: string) {
    armGuard()
    setConfirmState({ kind: 'delete-label', name })
  }

  function renameLabel(name: string) {
    const nextName = editingLabelName.trim()
    if (!nextName || nextName.toLowerCase() === name.toLowerCase()) return
    renameLabelMutation.mutate({ oldName: name, newName: nextName })
  }

  const confirmTitle = confirmState
    ? confirmState.kind === 'delete-forever'
      ? `Delete "${confirmState.note.title}" forever?`
      : confirmState.kind === 'empty-trash'
        ? 'Empty Trash?'
        : `Delete the "${confirmState.name}" label?`
    : ''

  const confirmDescription = confirmState
    ? confirmState.kind === 'delete-forever'
      ? 'This permanently removes the note from the workspace. This cannot be undone.'
      : confirmState.kind === 'empty-trash'
        ? `Permanently delete all ${counts.trash} note${counts.trash === 1 ? '' : 's'} in Trash. This cannot be undone.`
        : `The label is removed from every note that uses it. The notes themselves are kept.`
    : ''

  const emptyStateMessage = query
    ? 'No notes match your search.'
    : activeSection === 'trash'
      ? 'Trash is empty.'
      : activeSection === 'archive'
        ? 'Archive is empty.'
        : 'No notes yet — add your first note.'

  return (
    <div className="min-h-[calc(100svh-4rem)] bg-background">
      {/* sm:pe-24: this page is max-w-none, so the header reaches the window edge — where the
          fixed notification bell and theme toggle sit (right-6 / right-[4.25rem]) and would
          cover the view-toggle pill. Same treatment as the Prototype header's pe-12. */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:pe-24">
        <button type="button" onClick={openAddDialog} className="flex h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-6 text-sm font-medium text-background transition-all hover:opacity-90 active:scale-[0.98] sm:w-64">
          <Edit3 className="size-4" />
          Add Note
        </button>
        <label className="relative block sm:w-52">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" className="h-10 w-full rounded-lg border border-border/70 bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground" />
        </label>
        <div className="ml-auto flex rounded-lg border border-border/70 bg-card p-0.5">
          <button type="button" onClick={() => setView('grid')} aria-label="Grid view" className={cn('rounded-md p-2', view === 'grid' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}><Grid2X2 className="size-4" /></button>
          <button type="button" onClick={() => setView('list')} aria-label="List view" className={cn('rounded-md p-2', view === 'list' ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}><List className="size-4" /></button>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="h-fit rounded-xl border border-border/70 bg-card p-2.5">
          <button type="button" onClick={() => { setActiveSection('notes'); setActiveLabel(null) }} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors', activeSection === 'notes' && !activeLabel ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted')}>
            <CheckSquare className="size-4" /> Notes
            {counts.notes > 0 && <span className="ml-auto rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{counts.notes}</span>}
          </button>
          <button type="button" onClick={() => { setActiveSection('archive'); setActiveLabel(null) }} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-muted', activeSection === 'archive' && 'bg-muted font-medium')}>
            <Archive className="size-4" /> Archive
            {counts.archive > 0 && <span className="ml-auto rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-muted-foreground">{counts.archive}</span>}
          </button>
          <button
            type="button"
            onClick={() => { setActiveSection('trash'); setActiveLabel(null) }}
            onDragEnter={(event) => { event.preventDefault(); setDragOverTrash(true) }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragOverTrash(false)}
            onDrop={dropNoteInTrash}
            className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-destructive/10 hover:text-destructive', activeSection === 'trash' && 'bg-destructive/10 font-medium text-destructive', dragOverTrash && 'bg-destructive/15 text-destructive ring-1 ring-inset ring-destructive/40')}
          >
            <Trash2 className="size-4" /> Trash
            {counts.trash > 0 && <span className="ml-auto rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-destructive">{counts.trash}</span>}
          </button>
          <div className="my-3 border-t border-border/70" />
          <div className="flex items-center justify-between pb-2 pr-1.5 pl-3">
            <p className="text-sm text-muted-foreground">Labels</p>
            <button type="button" onClick={() => setLabelsOpen(true)} aria-label="Manage labels" className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <Tags className="size-4" />
            </button>
          </div>
          <div className="space-y-0.5">
            {labels.map(({ name, color }) => (
              <button
                key={name}
                type="button"
                onClick={() => setActiveLabel(activeLabel === name ? null : name)}
                title={activeLabel === name ? 'Clear label filter' : `Filter by ${name}`}
                className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors hover:bg-muted', activeLabel === name && 'bg-muted font-medium')}
              >
                <span className={cn('size-2 rounded-full', color)} /> {name}
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0">
          {activeSection === 'trash' && counts.trash > 0 && (
            <div className="mb-4 flex items-center justify-between rounded-xl border border-border/70 bg-card px-4 py-3">
              <p className="text-sm text-muted-foreground">
                {counts.trash} note{counts.trash === 1 ? '' : 's'} in Trash
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmState({ kind: 'empty-trash' })} className="h-8 rounded-full text-destructive hover:text-destructive">
                <Trash2 className="size-3.5" />
                Empty Trash
              </Button>
            </div>
          )}
          {filteredNotes.length > 0 ? (
            /* A real grid, not CSS multicol.
             *
             * `columns-[13rem]` asked the browser for as many ~208px columns as fit, which on a
             * wide screen shredded every card into a narrow ribbon — titles wrapping to six
             * lines, code-ish text breaking mid-token. Worse, masonry balances by HEIGHT: one
             * long chat-saved answer became a 1000px column that dictated the whole layout.
             * Equal-width tracks + a clamped body (CARD_BODY_CLAMP) makes the wall of cards
             * scannable. `items-start`, so each card is its own height: stretching a row to
             * its tallest member left ~180px of empty card under three short notes sitting
             * beside one long one — and the clamp already stops any card running away.
             *
             * `auto-fill` + an 18rem floor rather than viewport breakpoints, because what
             * matters is how wide THIS column is, and it isn't the window: the page also spends
             * ~200px on the app sidebar and 16rem on the label rail. Fixed `xl:grid-cols-3`
             * measured 223px-wide cards on a 1280px screen — the same too-narrow ribbon in a
             * tidier wrapper. */
            <section
              className={cn(
                view === 'grid'
                  ? 'grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] items-start gap-4'
                  : 'flex flex-col gap-2',
              )}
            >
              {filteredNotes.map((note) =>
                view === 'grid' ? (
                  <NoteCard key={note.id} note={note} labels={labels} onOpen={setReadingNote} onEdit={openEditDialog} onArchive={archiveNote} onDelete={deleteNote} />
                ) : (
                  <NoteRow key={note.id} note={note} labels={labels} onOpen={setReadingNote} onEdit={openEditDialog} onArchive={archiveNote} onDelete={deleteNote} />
                ),
              )}
            </section>
          ) : (
            <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground">{emptyStateMessage}</div>
          )}
        </div>
      </div>

      {/* Reader — the other half of clamping the cards. Kept read-only on purpose: the editor
          dialog is a separate, heavier surface (lazy TipTap), and most opens are "let me see the
          rest of this", not "let me change it". Reads the LIVE note out of the query rather than
          the captured one, so saving an edit updates what's on screen behind it. */}
      <Dialog open={!!readingNote} onOpenChange={(open) => { if (!open) setReadingNote(null) }}>
        <DialogContent className="flex max-h-[85svh] flex-col gap-0 overflow-hidden rounded-3xl border-border/60 p-0 shadow-none sm:max-w-2xl">
          {readingNote && (() => {
            const live = notes.find((note) => note.id === readingNote.id) ?? readingNote
            return (
              <>
                <DialogHeader className="shrink-0 border-b border-border/60 bg-muted/30 px-6 py-4 pr-14 text-left">
                  <DialogTitle className="text-xl leading-snug tracking-tight">{live.title}</DialogTitle>
                  <DialogDescription className="flex flex-wrap items-center gap-2 pt-1">
                    {live.labels.map((label) => <LabelChip key={label} label={label} labels={labels} />)}
                    <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Clock className="size-3" />
                      {noteStamp(live)}
                    </span>
                  </DialogDescription>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                  {live.body ? (
                    <NoteBody body={live.body} />
                  ) : (
                    <p className="text-sm italic text-muted-foreground/70">This note has no content yet.</p>
                  )}
                </div>
                <DialogFooter className="shrink-0 border-t border-border/60 bg-muted/20 px-6 py-3">
                  {!live.trashed && (
                    <Button type="button" variant="outline" onClick={() => { setReadingNote(null); openEditDialog(live) }} className="rounded-full">
                      <Pencil className="size-3.5" />
                      Edit note
                    </Button>
                  )}
                  <Button type="button" onClick={() => setReadingNote(null)} className="rounded-full">Close</Button>
                </DialogFooter>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

      <Dialog open={formOpen} onOpenChange={(open) => { setFormOpen(open); if (!open) setEditingNote(null) }}>
        {/* Wide + scroll-structured: the note body is a rich-text editor, so the dialog is sized
            like a writing surface (max-w-3xl) rather than a form. `flex-col` + `min-h-0` on the
            form and an `overflow-y-auto` middle section keep the header and footer pinned while
            a long note scrolls — without it, a tall editor pushes Save off the bottom of the
            viewport with no way to reach it. */}
        <DialogContent
          onEscapeKeyDown={(event) => { if (editorLayerOpen.current) event.preventDefault() }}
          className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-3xl border-border/60 p-0 shadow-none sm:max-w-3xl"
        >
          <DialogHeader className="shrink-0 border-b border-border/60 bg-muted/30 px-6 py-4 pr-14">
            <DialogTitle className="text-xl tracking-tight">{editingNote ? 'Edit Note' : 'Add Note'}</DialogTitle>
            <DialogDescription>{editingNote ? 'Update the note and save your changes.' : 'Capture a thought, task, or idea for later.'}</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              submitForm()
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
              <div className="space-y-2">
                <label htmlFor="note-title" className="text-sm font-medium">Title</label>
                <Input
                  id="note-title"
                  autoFocus
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  placeholder="e.g. Release ideas"
                  className="rounded-xl border-border/70"
                />
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Note</p>
                <Suspense fallback={<div className="flex h-64 items-center justify-center rounded-xl border border-border/70 bg-background text-sm text-muted-foreground">Loading editor…</div>}>
                  <NoteEditor
                    key={editingNote?.id ?? 'new'}
                    value={newBody}
                    onChange={setNewBody}
                    placeholder="Write something worth remembering…"
                    minHeightClass="min-h-64"
                    onNestedLayerChange={(open) => { editorLayerOpen.current = open }}
                  />
                </Suspense>
              </div>
              <div className="space-y-2">
                <p className="text-sm font-medium">Label <span className="font-normal text-muted-foreground">(optional)</span></p>
                <div className="flex flex-wrap gap-2">
                  {labels.map(({ name }) => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setNewLabel(newLabel === name ? null : name)}
                      className={cn(
                        'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                        newLabel === name ? 'border-foreground bg-foreground text-background' : 'border-border/70 text-muted-foreground hover:border-foreground hover:text-foreground',
                      )}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <DialogFooter className="shrink-0 border-t border-border/60 bg-muted/20 px-6 py-4">
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)} className="rounded-full">Cancel</Button>
              <Button type="submit" disabled={!newTitle.trim() || createMutation.isPending || updateMutation.isPending} className="rounded-full">{editingNote ? 'Save Changes' : 'Add Note'}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={labelsOpen} onOpenChange={setLabelsOpen}>
        <DialogContent
          onPointerDownOutside={(event) => { if (blockDismiss()) event.preventDefault() }}
          onInteractOutside={(event) => { if (blockDismiss()) event.preventDefault() }}
          onEscapeKeyDown={(event) => { if (blockDismiss()) event.preventDefault() }}
          className="gap-0 overflow-hidden rounded-3xl border-border/60 p-0 shadow-none sm:max-w-md"
        >
          <DialogHeader className="gap-0.5 border-b border-border/60 bg-muted/30 px-5 py-4 pr-14">
            <div className="flex items-center gap-2">
              <DialogTitle className="text-lg tracking-tight">Edit Labels</DialogTitle>
              <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] font-semibold tabular-nums text-muted-foreground">
                {labels.length}
              </span>
            </div>
            <DialogDescription className="text-xs text-muted-foreground">Rename, remove, or create labels for your notes.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[min(20rem,50vh)] space-y-1.5 overflow-y-auto p-4">
            {labels.map(({ name, color }) => (
              editingLabel === name ? (
                <div key={name} className="flex items-center gap-2 rounded-xl border border-primary/30 bg-primary/5 p-1.5 pl-3">
                  <span className={cn('size-2.5 shrink-0 rounded-full', color)} />
                  <Input value={editingLabelName} onChange={(event) => setEditingLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') renameLabel(name); if (event.key === 'Escape') setEditingLabel(null) }} autoFocus aria-label={`Rename ${name}`} className="h-8 rounded-lg border-border/70 bg-background text-sm" />
                  <Button type="button" size="sm" onClick={() => renameLabel(name)} disabled={!editingLabelName.trim()} className="h-8 rounded-full px-3.5 text-xs">Save</Button>
                  <button type="button" onClick={() => setEditingLabel(null)} className="px-1 text-xs font-medium text-muted-foreground hover:text-foreground">Cancel</button>
                </div>
              ) : (
                <div key={name} className="group flex items-center gap-2.5 rounded-xl border border-border/60 bg-card px-3 py-1.5 text-sm transition-colors hover:border-border hover:bg-muted/50">
                  <span className={cn('size-2.5 shrink-0 rounded-full', color)} />
                  <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                  <button type="button" onClick={() => { setEditingLabel(name); setEditingLabelName(name) }} aria-label={`Rename ${name} label`} className="rounded-md p-1.5 text-muted-foreground opacity-70 transition-all hover:bg-background hover:text-foreground group-hover:opacity-100"><Pencil className="size-3.5" /></button>
                  <button type="button" onClick={() => deleteLabel(name)} aria-label={`Delete ${name} label`} className="rounded-md p-1.5 text-muted-foreground opacity-70 transition-all hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"><Trash2 className="size-3.5" /></button>
                </div>
              )
            ))}
          </div>
          <div className="border-t border-border/60 bg-muted/20 px-4 py-3">
            <div className="flex gap-2">
              <div className="relative min-w-0 flex-1">
                <Plus className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={labelName} onChange={(event) => setLabelName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addLabel() } }} placeholder="New label…" className="h-9 rounded-lg border-border/70 bg-background pl-9 text-sm" />
              </div>
              <Button type="button" onClick={addLabel} disabled={!labelName.trim()} className="h-9 rounded-full px-4 text-sm">Add label</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmState} onOpenChange={(open) => { if (!open) { setConfirmState(null); disarmGuard() } }}>
        <DialogContent className="rounded-3xl border-border/60 p-6 shadow-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-xl tracking-tight">{confirmTitle}</DialogTitle>
            <DialogDescription>{confirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => { setConfirmState(null); disarmGuard() }} className="rounded-full">Cancel</Button>
            <Button type="button" variant="destructive" onClick={confirmAction} className="rounded-full">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
