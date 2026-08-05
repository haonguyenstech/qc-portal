import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { BookOpen, FolderGit2, Loader2, Upload } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import { openMcpFolder, saveOverviewDoc } from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { OverviewDocs } from '@/components/OverviewDocs'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT } from '@/lib/docConvert'
import { useProjects } from '@/lib/project-context'

export default function OverviewPage() {
  const { activeProject, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [converting, setConverting] = useState<{
    done: number
    total: number
  } | null>(null)

  if (!activeProjectId || !activeProject) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <BookOpen className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <BookOpen className="h-5 w-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar to see its overview documents.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  /**
   * Store each uploaded file as its OWN document under testing/overview/. Upload 10
   * files and you get 10 documents — no merging, so each can be AI-reviewed, previewed
   * and deleted on its own (see OverviewDocs). Uploading is also all that's needed for
   * the AI to have them: the server packs testing/overview/ into every run's context.
   */
  async function uploadFiles(files: FileList | File[]) {
    const picked = Array.from(files)
    if (picked.length === 0) return
    setConverting({ done: 0, total: picked.length })
    const saved: string[] = []
    const failed: { name: string; reason: string }[] = []
    try {
      // Sequential on purpose: each converter dynamically imports a heavy parser
      // (mammoth / pdfjs / xlsx) and runs on the main thread, so converting in
      // parallel only makes the page janky without finishing sooner.
      for (const [i, file] of picked.entries()) {
        setConverting({ done: i, total: picked.length })
        try {
          const { name, markdown } = await convertFileToMarkdown(file)
          await saveOverviewDoc(activeProjectId as string, name, markdown)
          saved.push(name)
        } catch (e) {
          failed.push({
            name: file.name,
            reason: e instanceof Error ? e.message : 'Conversion failed',
          })
        }
      }
      if (saved.length)
        queryClient.invalidateQueries({
          queryKey: ['overview-docs', activeProjectId],
        })
      if (failed.length) {
        toast.error(
          saved.length
            ? `Added ${saved.length} of ${picked.length} files`
            : `Couldn't add ${failed.length === 1 ? failed[0].name : `${failed.length} files`}`,
          {
            description: failed.map((f) => `${f.name}: ${f.reason}`).join('\n'),
          },
        )
      } else {
        toast.success(`${saved.length} document${saved.length === 1 ? '' : 's'} added`, {
          description: 'The AI can read these on every run in this project.',
        })
      }
    } finally {
      setConverting(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <BookOpen className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              The documents that describe{' '}
              <span className="font-medium text-foreground">{activeProject.name}</span> — upload
              them here and every QC run in this project can read them.
            </p>
          </div>
        </div>
      </header>

      {/* Project context chip — which repo these documents belong to. */}
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

      <section className="space-y-2">
        <input
          ref={inputRef}
          type="file"
          accept={KNOWLEDGE_ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
        <button
          type="button"
          onClick={() => !converting && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            if (!converting && e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files)
          }}
          disabled={!!converting}
          className={cn(
            'flex w-full flex-col items-center gap-2 rounded-3xl border border-dashed border-border/60 bg-muted/40 px-6 py-8 text-center transition-all duration-200',
            'hover:border-border hover:bg-muted/60 disabled:pointer-events-none',
            dragOver && 'border-primary bg-primary/5',
          )}
        >
          <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
            {converting ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <Upload className="size-5" />
            )}
          </span>
          <span className="text-sm font-medium tracking-tight">
            {converting
              ? converting.total > 1
                ? `Converting… (${converting.done + 1} of ${converting.total})`
                : 'Converting…'
              : 'Upload documents'}
          </span>
          <span className="text-[11px] text-muted-foreground">
            Word, PDF, Markdown, or spreadsheet files. Upload 10 files and you get 10 documents —
            each stays its own file, converted to Markdown in your browser.
          </span>
        </button>
      </section>

      {/* One card per uploaded document, each independently AI-reviewable. Renders
          nothing until the project has documents. */}
      <OverviewDocs projectId={activeProjectId} projectName={activeProject.name} />
    </div>
  )
}
