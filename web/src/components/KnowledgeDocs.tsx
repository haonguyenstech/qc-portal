import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertCircle,
  BrainCircuit,
  CheckCircle2,
  Eye,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileType,
  Info,
  Loader2,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  deleteKnowledgeDoc,
  getKnowledgeDoc,
  listKnowledge,
  openKnowledgeFolder,
  saveKnowledgeDoc,
  type KnowledgeDoc,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT } from '@/lib/docConvert'

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

type FileKind = { label: string; Icon: LucideIcon; color: string }

const FILE_KINDS: (FileKind & { ext: string[] })[] = [
  { ext: ['docx'], label: 'Word', Icon: FileType, color: 'text-blue-600 dark:text-blue-400' },
  { ext: ['pdf'], label: 'PDF', Icon: FileText, color: 'text-red-600 dark:text-red-400' },
  {
    ext: ['xlsx', 'xls', 'csv'],
    label: 'Excel / CSV',
    Icon: FileSpreadsheet,
    color: 'text-emerald-600 dark:text-emerald-400',
  },
  {
    ext: ['md', 'markdown', 'txt'],
    label: 'Markdown',
    Icon: FileCode,
    color: 'text-violet-600 dark:text-violet-400',
  },
]

const DEFAULT_KIND: FileKind = { label: 'Doc', Icon: FileText, color: 'text-muted-foreground' }

/** The accepted formats, surfaced as pills in the drop zone. */
const ACCEPT_PILLS: FileKind[] = FILE_KINDS.map(({ label, Icon, color }) => ({ label, Icon, color }))

function kindOf(filename: string): FileKind {
  const ext = filename.toLowerCase().match(/\.([^./\\]+)$/)?.[1] ?? ''
  return FILE_KINDS.find((k) => k.ext.includes(ext)) ?? DEFAULT_KIND
}

/** Per-file status while a batch of uploads is being converted + saved. */
type UploadItem = { name: string; status: 'converting' | 'done' | 'error'; error?: string }

// Mirrors the Overview intro markdown styling so doc previews render consistently.
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

function PreviewDialog({
  doc,
  projectId,
  onOpenChange,
}: {
  doc: KnowledgeDoc | null
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const { data, isFetching } = useQuery({
    queryKey: ['knowledge-doc', projectId, doc?.name],
    queryFn: () => getKnowledgeDoc(doc!.name, projectId),
    enabled: !!doc,
  })

  return (
    <Dialog open={!!doc} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[72rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <FileText className="h-4 w-4 text-muted-foreground" />
            {doc?.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Converted to Markdown · stored in testing/knowledge/
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

export function KnowledgeDocs({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [preview, setPreview] = useState<KnowledgeDoc | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const { data: docs } = useQuery({
    queryKey: ['knowledge', projectId],
    queryFn: () => listKnowledge(projectId),
    enabled: !!projectId,
  })

  const del = useMutation({
    mutationFn: (name: string) => deleteKnowledgeDoc(name, projectId),
    onSuccess: (_r, name) => {
      toast.success('Document removed', { description: name })
      setConfirmDelete(null)
      queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] })
    },
    onError: (e) =>
      toast.error('Could not remove document', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  async function handleFiles(files: FileList | File[]) {
    const list = Array.from(files)
    if (!list.length) return
    setBusy(true)
    setUploads(list.map((f) => ({ name: f.name, status: 'converting' })))
    let ok = 0
    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      try {
        const { name, markdown } = await convertFileToMarkdown(file)
        await saveKnowledgeDoc(name, markdown, projectId)
        ok++
        setUploads((prev) =>
          prev.map((u, idx) => (idx === i ? { ...u, status: 'done' } : u)),
        )
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Conversion failed'
        setUploads((prev) =>
          prev.map((u, idx) => (idx === i ? { ...u, status: 'error', error } : u)),
        )
        toast.error(`Couldn't add ${file.name}`, { description: error })
      }
    }
    setBusy(false)
    if (ok > 0) {
      toast.success(`Added ${ok} document${ok === 1 ? '' : 's'}`, {
        description: 'Converted to Markdown for AI knowledge.',
      })
      queryClient.invalidateQueries({ queryKey: ['knowledge', projectId] })
    }
    // Auto-dismiss the progress panel only when everything succeeded; keep it
    // up when there were errors so the engineer can read what failed.
    if (ok === list.length) {
      window.setTimeout(() => setUploads([]), 2500)
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <BrainCircuit className="h-4 w-4 text-primary" />
          AI knowledge documents
          {docs && docs.length > 0 && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
              {docs.length}
            </span>
          )}
        </h2>
        <OpenFolderButton open={() => openKnowledgeFolder(projectId)} label="knowledge" />
      </div>

      <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="space-y-1 leading-relaxed">
          <p>
            Upload docs (.docx), PDFs, Markdown, or spreadsheets to supplement{' '}
            {projectName}&apos;s AI knowledge.
          </p>
          <p>
            Each is converted to Markdown and stored under{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">testing/knowledge/</code>{' '}
            so Claude reads it during QC runs, test-case generation, and design checks.
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={KNOWLEDGE_ACCEPT}
        className="hidden"
        onChange={(e) => e.target.files && handleFiles(e.target.files)}
      />

      {/* Drag-and-drop / click upload zone. */}
      <button
        type="button"
        onClick={() => !busy && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (!busy && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files)
        }}
        disabled={busy}
        className={cn(
          'flex w-full flex-col items-center gap-2 rounded-3xl border border-dashed border-border/60 bg-muted/40 px-6 py-8 text-center transition-all duration-200',
          'hover:border-border hover:bg-muted/60 disabled:pointer-events-none',
          dragOver && 'border-primary bg-primary/5',
        )}
      >
        <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
          {busy ? <Loader2 className="size-5 animate-spin" /> : <Upload className="size-5" />}
        </span>
        <span className="text-sm font-medium tracking-tight">
          {busy ? 'Converting…' : 'Drop files here or click to upload'}
        </span>
        <span className="text-[11px] text-muted-foreground">
          Converted to Markdown in your browser — nothing leaves your machine.
        </span>
        <span className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
          {ACCEPT_PILLS.map(({ label, Icon, color }) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-card px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <Icon className={cn('size-3', color)} />
              {label}
            </span>
          ))}
        </span>
      </button>

      {/* Per-file conversion progress for the active / most recent batch. */}
      {uploads.length > 0 && (
        <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
            <span className="flex items-center gap-2 text-xs font-semibold tracking-tight">
              {busy ? (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
              ) : (
                <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" />
              )}
              {busy
                ? `Converting ${uploads.filter((u) => u.status !== 'converting').length}/${uploads.length}…`
                : `Processed ${uploads.length} file${uploads.length === 1 ? '' : 's'}`}
            </span>
            {!busy && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setUploads([])}
                className="h-7 shrink-0 rounded-full px-2 text-xs"
              >
                <X className="size-3.5" /> Dismiss
              </Button>
            )}
          </div>
          <ul className="divide-y divide-border/60">
            {uploads.map((u) => {
              const kind = kindOf(u.name)
              return (
                <li key={u.name} className="flex items-center gap-3 px-4 py-2.5">
                  <kind.Icon className={cn('size-4 shrink-0', kind.color)} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm" title={u.name}>
                      {u.name}
                    </div>
                    {u.status === 'error' && u.error && (
                      <div className="truncate text-[11px] text-destructive" title={u.error}>
                        {u.error}
                      </div>
                    )}
                  </div>
                  {u.status === 'converting' && (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  )}
                  {u.status === 'done' && (
                    <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  )}
                  {u.status === 'error' && (
                    <AlertCircle className="size-4 shrink-0 text-destructive" />
                  )}
                </li>
              )
            })}
          </ul>
        </Card>
      )}

      {docs && docs.length > 0 ? (
        <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5">
            <span className="text-xs font-semibold tracking-tight">
              {docs.length} document{docs.length === 1 ? '' : 's'}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {formatBytes(docs.reduce((sum, d) => sum + d.size, 0))} total
            </span>
          </div>
          <CardContent className="p-0">
            <ul className="divide-y divide-border/60">
              {docs.map((d) => (
                <li
                  key={d.name}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                    <FileText className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium tracking-tight" title={d.name}>
                        {d.name}
                      </span>
                      {d.source?.toLowerCase().startsWith('ai') && (
                        <span
                          title={d.source}
                          className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary"
                        >
                          <Sparkles className="size-2.5" /> AI
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatBytes(d.size)} · {timeAgo(d.savedAt)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPreview(d)}
                    className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
                  >
                    <Eye className="size-3.5" /> Preview
                  </Button>
                  {confirmDelete === d.name ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => del.mutate(d.name)}
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
                      onClick={() => setConfirmDelete(d.name)}
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
      ) : null}

      <PreviewDialog doc={preview} projectId={projectId} onOpenChange={(o) => !o && setPreview(null)} />
    </section>
  )
}
