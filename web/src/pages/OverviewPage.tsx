import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  BookOpen,
  Eye,
  FileText,
  FolderGit2,
  Info,
  Loader2,
  Pencil,
  Save,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { openMcpFolder, updateProject } from '@/lib/api'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT } from '@/lib/docConvert'
import { useProjects } from '@/lib/project-context'

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

export default function OverviewPage() {
  const { activeProject, activeProjectId, refetch } = useProjects()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [converting, setConverting] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  const description = activeProject?.description ?? ''

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
              Select a project in the sidebar to see and edit its overview.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const startEditing = (seed?: string) => {
    setDraft(seed ?? description)
    setMode('edit')
    setEditing(true)
  }

  // Upload a doc (.md, .docx, .pdf, spreadsheet) — convert it to Markdown in the
  // browser and load it into the editor for review before saving as the intro.
  async function handleFile(files: FileList | File[]) {
    const file = Array.from(files)[0]
    if (!file) return
    setConverting(true)
    try {
      const { markdown } = await convertFileToMarkdown(file)
      startEditing(markdown)
      toast.success('File converted', {
        description: 'Review the Markdown, then Save to set it as the overview.',
      })
    } catch (e) {
      toast.error(`Couldn't import ${file.name}`, {
        description: e instanceof Error ? e.message : 'Conversion failed',
      })
    } finally {
      setConverting(false)
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
              A free-text intro about{' '}
              <span className="font-medium text-foreground">{activeProject.name}</span> — what it is
              and what to know before running QC.
            </p>
          </div>
        </div>
      </header>

      {/* Project context chip — which repo this intro belongs to. */}
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
        <section className="space-y-2">
          <input
            ref={inputRef}
            type="file"
            accept={KNOWLEDGE_ACCEPT}
            className="hidden"
            onChange={(e) => e.target.files && handleFile(e.target.files)}
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
              if (!converting && e.dataTransfer.files.length) handleFile(e.dataTransfer.files)
            }}
            disabled={converting}
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
              {converting ? 'Converting…' : 'Upload a file as the overview'}
            </span>
            <span className="text-[11px] text-muted-foreground">
              Word, PDF, Markdown, or spreadsheet — converted to Markdown in your browser and loaded
              into the editor for review.
            </span>
          </button>
        </section>
      )}

      {editing ? (
        <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Editing intro
              <span className="text-xs font-normal text-muted-foreground">Markdown supported</span>
            </span>
            <div className="flex items-center gap-2">
              {/* Edit ⇄ Preview toggle, mirroring the Skills editor. */}
              <div className="flex rounded-xl border border-border/60 bg-background p-0.5">
                <button
                  type="button"
                  onClick={() => setMode('edit')}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                    mode === 'edit'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Pencil className="size-3" />
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setMode('preview')}
                  className={cn(
                    'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                    mode === 'preview'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Eye className="size-3" />
                  Preview
                </button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft(description)
                  setEditing(false)
                }}
                disabled={save.isPending}
                className="rounded-full"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => save.mutate()}
                disabled={save.isPending}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
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
          {mode === 'preview' ? (
            <div className="min-h-[420px] overflow-auto px-6 py-5">
              {draft.trim() ? (
                <div className={MD_CLASS}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm italic text-muted-foreground">Nothing to preview yet.</p>
              )}
            </div>
          ) : (
            <Textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={PLACEHOLDER}
              className="min-h-[420px] resize-y rounded-none border-0 font-mono text-sm leading-relaxed focus-visible:ring-0"
            />
          )}
        </Card>
      ) : description ? (
        <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <FileText className="h-4 w-4 text-muted-foreground" />
              Overview
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => startEditing()}
              className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Button>
          </div>
          <CardContent className="px-6 py-5">
            <div className={MD_CLASS}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{description}</ReactMarkdown>
            </div>
          </CardContent>
        </Card>
      ) : (
        // No intro yet — invite the user to write one.
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-foreground text-background">
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
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Pencil className="h-4 w-4" />
              Write intro
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
