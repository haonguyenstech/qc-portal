import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Eye, FileText, FolderOpen, Info, Loader2, Sparkles, Trash2, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  deleteOverviewDoc,
  getOverviewDoc,
  listOverviewDocs,
  openOverviewDocsFolder,
  reviewOverviewDoc,
  saveOverviewDoc,
  type OverviewDoc,
} from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'

// The project's overview documents — ONE FILE PER UPLOAD. Upload 10 files and you get
// 10 documents here; each is reviewed, previewed and deleted on its own, which is what
// merging every upload into one blob made impossible. Stored server-side under
// testing/overview/ (see server/src/overviewDocs.ts); this is the list + actions, while
// the upload zone stays on OverviewPage so there's a single place to drop files.

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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function PreviewDialog({
  doc,
  projectId,
  onOpenChange,
}: {
  doc: OverviewDoc | null
  projectId: string
  onOpenChange: (open: boolean) => void
}) {
  const { data, isFetching } = useQuery({
    queryKey: ['overview-doc', projectId, doc?.name],
    queryFn: () => getOverviewDoc(projectId, doc!.name),
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
            Converted to Markdown · stored in testing/overview/
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

export function OverviewDocs({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const queryClient = useQueryClient()
  const [preview, setPreview] = useState<OverviewDoc | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  // Pre-review text of the last document the AI actually changed, so it can be put
  // back — the review overwrote the file, so without this the original is gone.
  const [undo, setUndo] = useState<{ name: string; before: string } | null>(null)
  const [busyName, setBusyName] = useState<string | null>(null)

  const { data: docs } = useQuery({
    queryKey: ['overview-docs', projectId],
    queryFn: () => listOverviewDocs(projectId),
    enabled: !!projectId,
  })

  const invalidate = (name?: string) => {
    queryClient.invalidateQueries({ queryKey: ['overview-docs', projectId] })
    if (name)
      queryClient.invalidateQueries({
        queryKey: ['overview-doc', projectId, name],
      })
  }

  const review = useMutation({
    mutationFn: (name: string) => reviewOverviewDoc(projectId, name),
    onMutate: (name) => setBusyName(name),
    onSuccess: (r) => {
      toast.success(r.changed ? `Reviewed ${r.name}` : `${r.name} is already clean`, {
        description: r.changed
          ? 'Formatting tidied — no facts added. You can restore the original.'
          : 'AI found nothing to fix, so the file was left untouched.',
      })
      setUndo(r.changed ? { name: r.name, before: r.before } : null)
      invalidate(r.name)
    },
    onError: (e, name) =>
      toast.error(`Couldn't review ${name}`, {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
    onSettled: () => setBusyName(null),
  })

  const restore = useMutation({
    mutationFn: (v: { name: string; before: string }) =>
      saveOverviewDoc(projectId, v.name, v.before),
    onSuccess: (_r, v) => {
      toast.success(`${v.name} restored`)
      setUndo(null)
      invalidate(v.name)
    },
    onError: (e) =>
      toast.error('Could not restore', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const del = useMutation({
    mutationFn: (name: string) => deleteOverviewDoc(projectId, name),
    onSuccess: (_r, name) => {
      toast.success('Document removed', { description: name })
      setConfirmDelete(null)
      if (undo?.name === name) setUndo(null)
      invalidate(name)
    },
    onError: (e) =>
      toast.error('Could not remove document', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  if (!docs?.length) return null

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <FolderOpen className="h-4 w-4 text-primary" />
          Overview documents
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">
            {docs.length}
          </span>
        </h2>
        <OpenFolderButton open={() => openOverviewDocsFolder(projectId)} label="overview" />
      </div>

      <div className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="leading-relaxed">
          {projectName}&apos;s overview — one file per upload, in{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            testing/overview/
          </code>
          . Use <span className="font-medium text-foreground">AI review</span> on any file to fix
          its formatting. These are reference files for people — they are{' '}
          <span className="font-medium text-foreground">not</span> read by QC runs; put anything the
          AI should always know under Instructions → Knowledge.
        </p>
      </div>

      <ul className="space-y-2">
        {docs.map((doc) => {
          const busy = busyName === doc.name
          const reviewing = review.isPending && busy
          return (
            <li
              key={doc.name}
              className="rounded-2xl border border-border/60 bg-card px-4 py-3 transition-colors hover:border-border"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                  <FileText className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium tracking-tight">
                    {doc.name}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {formatBytes(doc.size)} · saved {new Date(doc.savedAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => review.mutate(doc.name)}
                    disabled={busy || review.isPending}
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                    title="Fix formatting, merge duplicated sections and strip conversion noise in this file. Adds no facts."
                  >
                    {reviewing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" />
                    )}
                    {reviewing ? 'Reviewing…' : 'AI review'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPreview(doc)}
                    className="rounded-full"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    Preview
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDelete(doc.name)}
                    className="rounded-full text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>

              {undo?.name === doc.name && (
                <div className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    AI rewrote this file&apos;s formatting.
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => restore.mutate(undo)}
                    disabled={restore.isPending}
                    className="h-7 rounded-full"
                  >
                    {restore.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Undo2 className="h-3 w-3" />
                    )}
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setUndo(null)}
                    className="h-7 rounded-full"
                  >
                    Keep it
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      <PreviewDialog doc={preview} projectId={projectId} onOpenChange={() => setPreview(null)} />

      <Dialog open={!!confirmDelete} onOpenChange={() => setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this document?</DialogTitle>
            <DialogDescription>
              <code className="font-mono text-xs">{confirmDelete}.md</code> is deleted from
              testing/overview/. The project intro itself is not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)} className="rounded-full">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmDelete && del.mutate(confirmDelete)}
              disabled={del.isPending}
              className="rounded-full"
            >
              {del.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
