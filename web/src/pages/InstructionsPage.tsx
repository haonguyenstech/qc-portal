import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  Eye,
  FileText,
  FolderGit2,
  FolderOpen,
  FolderTree,
  Loader2,
  Pencil,
  Save,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { BrainCircuit, BrainCog, Info, KeyRound, Sparkles } from 'lucide-react'
import { KnowledgeDocs } from '@/components/KnowledgeDocs'
import { MemoryNotes } from '@/components/MemoryNotes'
import { AccountsDoc } from '@/components/AccountsDoc'
import { AiBrainMap } from '@/components/AiBrainMap'
import {
  getProjectClaudeMd,
  openMcpFolder,
  saveProjectClaudeMd,
  type ProjectClaudeMd,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** Tailwind recipe for rendered markdown (mirrors the Skills page preview). */
const MARKDOWN_CLASS = cn(
  'max-w-none text-sm leading-relaxed',
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

/** Loads the project's root CLAUDE.md, then renders the editor keyed on the loaded
 *  content so the draft reseeds on project switch / external change. */
function ClaudeMdCard({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['claude-md', projectId],
    queryFn: () => getProjectClaudeMd(projectId),
  })

  if (isLoading || !data) {
    return (
      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <div className="flex items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
            <FileText className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight">Project instructions</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">CLAUDE.md</p>
          </div>
        </div>
        <CardContent className="flex items-center gap-2 px-4 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading CLAUDE.md…
        </CardContent>
      </Card>
    )
  }

  return <ClaudeMdEditor key={data.savedAt ?? 'new'} projectId={projectId} file={data} />
}

/** The CLAUDE.md editor body — Edit ⇄ Preview toggle + Save, mirroring the Skills
 *  page file editor. Remounted (via `key`) whenever the loaded file changes. */
function ClaudeMdEditor({ projectId, file }: { projectId: string; file: ProjectClaudeMd }) {
  const queryClient = useQueryClient()
  const [content, setContent] = useState(file.content)
  const [mode, setMode] = useState<'edit' | 'preview'>('preview')
  const [copied, setCopied] = useState(false)

  const dirty = content !== file.content
  const lineCount = content.split('\n').length
  const charCount = content.length

  const save = useMutation({
    mutationFn: () => saveProjectClaudeMd(projectId, content),
    onSuccess: (res) => {
      queryClient.setQueryData(['claude-md', projectId], res)
      // Refresh the project list so the header's exists/new badge updates.
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('CLAUDE.md saved', { description: 'Project instructions updated.' })
    },
    onError: (err) =>
      toast.error('Could not save CLAUDE.md', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
          <FileText className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium leading-tight">Project instructions</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">CLAUDE.md</p>
        </div>

        {dirty ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            Unsaved changes
          </span>
        ) : !file.exists ? (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-600/20">
            Not created yet
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
            Saved · {formatBytes(file.size)}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {charCount} chars
          </span>

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
            type="button"
            variant="ghost"
            size="sm"
            onClick={copy}
            className="h-7 gap-1 px-2 text-[11px] active:scale-[0.98]"
          >
            {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>

          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || !dirty}
            className="rounded-full active:scale-[0.98]"
          >
            {save.isPending ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      <CardContent className="p-0">
        {mode === 'preview' ? (
          content.trim() ? (
            <div className="max-h-[calc(100svh-22rem)] min-h-[26rem] overflow-auto bg-card px-6 py-5">
              <div className={MARKDOWN_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            </div>
          ) : (
            <p className="px-6 py-12 text-center text-sm text-muted-foreground">
              Nothing to preview yet — switch to Edit and add your project guidance.
            </p>
          )
        ) : (
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder={'# Project\n\nGuidance for Claude Code when running QC in this project…'}
            className="min-h-[calc(100svh-22rem)] resize-y rounded-none border-0 bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-zinc-950/40"
          />
        )}
      </CardContent>
    </Card>
  )
}

/** Button that reveals the project's root folder (where CLAUDE.md lives) in the OS file explorer. */
function OpenFolderButton({ projectId }: { projectId: string }) {
  const mutation = useMutation({
    mutationFn: () => openMcpFolder(projectId),
    onSuccess: (res) => toast.success('Opened project folder', { description: res.path }),
    onError: (err) =>
      toast.error('Failed to open folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
    >
      {mutation.isPending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <FolderOpen className="size-3.5" />
      )}
      Open folder
    </Button>
  )
}

const TABS = ['instructions', 'knowledge', 'memory', 'accounts', 'brain'] as const
type TabValue = (typeof TABS)[number]

/** Small info icon shown inside a tab; hovering it explains what the tab is for.
 *  The tooltip's own data-state lands on this span (not the TabsTrigger), so the
 *  tab's data-state="active" styling is preserved. */
function TabInfo({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={-1}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="ml-0.5 inline-flex text-muted-foreground/70 transition-colors hover:text-foreground"
        >
          <Info className="size-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent>{children}</TooltipContent>
    </Tooltip>
  )
}

export default function InstructionsPage() {
  const { activeProjectId, activeProject } = useProjects()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const activeTab: TabValue = TABS.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'instructions'

  function onTabChange(value: string) {
    if (!TABS.includes(value as TabValue)) return
    const next = new URLSearchParams(searchParams)
    next.set('tab', value)
    setSearchParams(next)
  }

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <FileText className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Instructions</h1>
            <p className="text-sm text-muted-foreground">
              Edit the project's CLAUDE.md — the guidance Claude Code reads on every run.
            </p>
          </div>
        </header>
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <FileText className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No project selected</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Choose a project in the sidebar to view and edit its CLAUDE.md.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3" data-tour="header">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <FileText className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Instructions</h1>
            <p className="text-sm text-muted-foreground">
              Everything Claude Code reads on every QC run
              {activeProject ? ` in ${activeProject.name}` : ''} — the lean{' '}
              <span className="font-mono text-foreground">CLAUDE.md</span>, uploaded{' '}
              <span className="text-foreground">Knowledge</span> docs, and durable{' '}
              <span className="text-foreground">Memory</span> facts. Split context across these
              instead of cramming it all into one file.
            </p>
          </div>
        </div>

        {/* Per-project context: makes it unmistakable which project's context is being edited. */}
        {activeProject && (
          <div
            data-tour="context"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none"
          >
            <span className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Editing context for
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                title={activeProject.rootPath}
              >
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}</span>
              </span>
              <OpenFolderButton projectId={activeProjectId} />
            </div>
          </div>
        )}
      </header>

      <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-5">
        <TabsList className="rounded-full">
          <TabsTrigger value="instructions" className="gap-1.5 rounded-full" data-tour="tab-instructions">
            <FileText className="size-3.5" /> Instructions
            <TabInfo>
              The project's lean root <span className="font-mono">CLAUDE.md</span> — the standing
              rules & guidance Claude Code reads on every QC run. Keep it short; link out to
              Knowledge and Memory rather than pasting everything here.
            </TabInfo>
          </TabsTrigger>
          <TabsTrigger value="knowledge" className="gap-1.5 rounded-full" data-tour="tab-knowledge">
            <BrainCircuit className="size-3.5" /> Knowledge
            <TabInfo>
              Reference docs you upload (Word, PDF, Markdown, CSV, Excel) — specs, requirements,
              domain knowledge. Converted to Markdown and fed to Claude as background so it uses
              your real project terms and rules.
            </TabInfo>
          </TabsTrigger>
          <TabsTrigger value="memory" className="gap-1.5 rounded-full" data-tour="tab-memory">
            <BrainCog className="size-3.5" /> Memory
            <TabInfo>
              Small, durable notes you write here — one fact each (decisions, gotchas,
              conventions). Short and long-lived, unlike the larger uploaded Knowledge docs.
            </TabInfo>
          </TabsTrigger>
          <TabsTrigger value="accounts" className="gap-1.5 rounded-full" data-tour="tab-accounts">
            <KeyRound className="size-3.5" /> Accounts
            <TabInfo>
              The app URLs and test-account logins for this project. Upload a CSV/Excel sheet (or
              edit by hand) so Claude uses the real environments and credentials for “log in as …”
              steps instead of inventing placeholders. Use non-production test accounts only.
            </TabInfo>
          </TabsTrigger>
          <TabsTrigger value="brain" className="gap-1.5 rounded-full" data-tour="tab-brain">
            <Sparkles className="size-3.5" /> AI Brain
            <TabInfo>
              A visual map of everything Claude knows about this project — how CLAUDE.md,
              Knowledge, and Memory connect and feed each QC run.
            </TabInfo>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="instructions" className="space-y-3">
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            The project's root{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">CLAUDE.md</code>.
            Keep it lean — a managed pointer block here links Claude to the Knowledge and Memory
            folders automatically.
          </p>
          <ClaudeMdCard projectId={activeProjectId} />
        </TabsContent>

        <TabsContent value="knowledge">
          {activeProject && (
            <KnowledgeDocs projectId={activeProjectId} projectName={activeProject.name} />
          )}
        </TabsContent>

        <TabsContent value="memory">
          {activeProject && (
            <MemoryNotes projectId={activeProjectId} projectName={activeProject.name} />
          )}
        </TabsContent>

        <TabsContent value="accounts">
          {activeProject && (
            <AccountsDoc projectId={activeProjectId} projectName={activeProject.name} />
          )}
        </TabsContent>

        <TabsContent value="brain">
          {activeProject && (
            <AiBrainMap projectId={activeProjectId} projectName={activeProject.name} />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
