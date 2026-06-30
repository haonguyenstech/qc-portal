import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ClipboardList,
  Eye,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderGit2,
  FolderOpen,
  FolderTree,
  ListChecks,
  Loader2,
  Save,
  Settings,
  Trash2,
  X,
} from 'lucide-react'
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
  deleteTemplate,
  listTemplates,
  openTemplatesFolder,
  saveTemplate,
  type ProjectTemplate,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'

/** Catalog of file templates a project can define. The key maps to the on-disk
 *  file (testing/templates/<key>.md); add new kinds here to expose more. */
interface TemplateKind {
  key: string
  label: string
  icon: typeof FileText
  description: string
}

const TEMPLATE_KINDS: TemplateKind[] = [
  {
    key: 'testcase',
    label: 'Test case template',
    icon: ClipboardList,
    description:
      'The structure Claude matches when drafting test cases on the TestCase page. Upload there still overrides this per run.',
  },
  {
    key: 'design-check',
    label: 'Design Check checklist',
    icon: ListChecks,
    description:
      'A standard checklist of things to verify on the Design Check page (spacing, component states, copy, responsiveness, accessibility…). Auto-applied to every Design Check run as criteria — the model reports a finding for each item.',
  },
]

// Accepted uploads. Text formats are read as-is; spreadsheets are parsed to CSV
// text (so the stored template stays plain text Claude can read).
const ACCEPT = '.csv,.tsv,.md,.txt,.json,.xls,.xlsx'
const MAX_BYTES = 200 * 1024

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

/** Read an uploaded template file into plain text. Spreadsheets (.xls/.xlsx) are
 *  parsed to CSV (one block per sheet) via a lazily-loaded SheetJS. */
async function readTemplateFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'xlsx' || ext === 'xls') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
    return wb.SheetNames.map((name) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name])
      return wb.SheetNames.length > 1 ? `# ${name}\n${csv}` : csv
    })
      .join('\n\n')
      .trim()
  }
  return (await file.text()).trim()
}

/** One template: upload a file (csv / md / txt / json / excel) → preview → save.
 *  No manual typing — the content always comes from an uploaded file. */
function TemplateCard({
  kind,
  projectId,
  saved,
}: {
  kind: TemplateKind
  projectId: string
  saved: ProjectTemplate | undefined
}) {
  const queryClient = useQueryClient()
  const Icon = kind.icon
  const fileInput = useRef<HTMLInputElement>(null)
  // A freshly uploaded-and-parsed file awaiting save (null once saved/cleared).
  const [pending, setPending] = useState<{ name: string; content: string } | null>(null)
  const [reading, setReading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)

  const save = useMutation({
    mutationFn: (content: string) => saveTemplate(kind.key, content, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      setPending(null)
      toast.success('Template saved', {
        description: `${kind.label} · testing/templates/${kind.key}.md`,
      })
    },
    onError: (err) =>
      toast.error('Could not save template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const remove = useMutation({
    mutationFn: () => deleteTemplate(kind.key, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      setPending(null)
      toast.success('Template removed', { description: kind.label })
    },
    onError: (err) =>
      toast.error('Could not remove template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setReading(true)
    try {
      const content = await readTemplateFile(file)
      if (!content) {
        toast.error('That file looks empty', { description: file.name })
        return
      }
      if (new Blob([content]).size > MAX_BYTES) {
        toast.error('Template too large', { description: 'Parsed content exceeds 200 KB.' })
        return
      }
      setPending({ name: file.name, content })
    } catch (err) {
      toast.error('Could not read the file', {
        description: err instanceof Error ? err.message : 'Unsupported or corrupt file',
      })
    } finally {
      setReading(false)
    }
  }

  const busy = save.isPending || remove.isPending || reading
  // What to preview: the pending upload if any, else the saved content.
  const previewName = pending ? pending.name : saved ? `${kind.key}.md` : null
  const previewContent = pending ? pending.content : (saved?.content ?? '')

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight">{kind.label}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            testing/templates/{kind.key}.md
          </p>
        </div>
        {pending ? (
          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-600/20">
            Unsaved
          </span>
        ) : saved ? (
          <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20">
            Saved · {formatBytes(saved.size)}
          </span>
        ) : (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            Not set
          </span>
        )}
      </div>
      <CardContent className="space-y-3 p-4">
        <p className="text-xs text-muted-foreground">{kind.description}</p>

        <input ref={fileInput} type="file" accept={ACCEPT} onChange={onPick} className="hidden" />

        {previewName ? (
          <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/60 px-3 py-2">
            <FileText className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm">{previewName}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowPreview(true)}
              disabled={!previewContent}
              className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs"
            >
              <Eye className="size-3.5" /> Preview
            </Button>
            {pending && (
              <button
                type="button"
                onClick={() => setPending(null)}
                disabled={busy}
                className="shrink-0 rounded-xl p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Discard upload"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={busy}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border/60 py-8 text-center text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground"
          >
            {reading ? (
              <Loader2 className="size-6 animate-spin" />
            ) : (
              <FileUp className="size-6" />
            )}
            <span className="text-sm font-medium">
              {reading ? 'Reading file…' : 'Upload a template file'}
            </span>
            <span className="flex items-center gap-1 text-[11px]">
              <FileSpreadsheet className="size-3" />
              CSV, Markdown, TXT, JSON or Excel (.xlsx)
            </span>
          </button>
        )}

        <div className="flex items-center gap-2">
          {pending && (
            <Button
              onClick={() => save.mutate(pending.content)}
              disabled={busy}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {save.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="size-4" />
                  {saved ? 'Replace template' : 'Save template'}
                </>
              )}
            </Button>
          )}
          {previewName && (
            <Button
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              size="sm"
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <FileUp className="size-3.5" />
              {pending ? 'Pick another' : 'Replace'}
            </Button>
          )}
          {saved && !pending && (
            <Button
              variant="ghost"
              onClick={() => remove.mutate()}
              disabled={busy}
              className="ml-auto rounded-full text-muted-foreground transition-all duration-200 hover:text-destructive active:scale-[0.98]"
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Remove
            </Button>
          )}
        </div>
      </CardContent>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[60rem]">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Icon className="h-4 w-4 text-muted-foreground" />
              {kind.label}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {previewName ?? `${kind.key}.md`}
              {pending ? ' · unsaved upload' : saved ? ` · testing/templates/${kind.key}.md` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            <pre className="font-mono text-[12px] leading-relaxed whitespace-pre">
              {previewContent}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Button that reveals the project's testing/templates folder in the OS file explorer. */
function OpenFolderButton({ projectId }: { projectId: string }) {
  const mutation = useMutation({
    mutationFn: () => openTemplatesFolder(projectId),
    onSuccess: (res) => toast.success('Opened templates folder', { description: res.path }),
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

export default function ProjectSettingsPage() {
  const { activeProjectId, activeProject } = useProjects()

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', activeProjectId],
    queryFn: () => listTemplates(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
          <p className="text-sm text-muted-foreground">Per-project file templates and preferences.</p>
        </header>
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Settings className="size-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No project selected</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Choose a project in the sidebar to manage its templates.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const byKey = new Map((templates ?? []).map((t) => [t.key, t]))
  const hasTemplates = (templates?.length ?? 0) > 0

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Settings className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
            <p className="text-sm text-muted-foreground">
              Per-project file templates{activeProject ? ` for ${activeProject.name}` : ''}. Upload
              a file (no manual typing); it's stored under{' '}
              <span className="font-mono text-foreground">testing/templates/</span> so the QC skill
              and the Portal can reuse it.
            </p>
          </div>
        </div>

        {/* Per-project context: makes it unmistakable which testing/templates is being edited. */}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card px-4 py-3 shadow-none">
            <span className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Editing templates for
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-3 py-1.5 font-mono text-xs text-muted-foreground"
                title={`${activeProject.rootPath}/testing/templates`}
              >
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/testing/templates</span>
                <span
                  className={cn(
                    'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    hasTemplates ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {hasTemplates ? 'exists' : 'new'}
                </span>
              </span>
              <OpenFolderButton projectId={activeProjectId} />
            </div>
          </div>
        )}
      </header>

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold tracking-tight">File templates</h2>
        </div>
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading templates…
          </div>
        ) : (
          <div className="space-y-4">
            {TEMPLATE_KINDS.map((kind) => (
              <TemplateCard
                key={kind.key}
                kind={kind}
                projectId={activeProjectId}
                saved={byKey.get(kind.key)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
