import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
  PencilLine,
  RotateCcw,
  Save,
  Send,
  Settings,
  TriangleAlert,
  Trash2,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  ISSUE_TEMPLATE_KEY,
  ISSUE_TEMPLATE_VARS,
  SAMPLE_ISSUE_VARS,
  issueTemplateProblems,
  renderIssueTemplate,
} from '@/lib/issueTemplate'
import {
  deleteTemplate,
  getTemplateDefault,
  listTemplateDefaults,
  listTemplates,
  openTemplatesFolder,
  resetTemplateToDefault,
  saveTemplate,
  type ProjectTemplate,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { CsvTable, looksLikeCsv } from '@/components/CsvTable'

// Markdown preview styling (GFM tables included) — mirrors the block used by the
// Knowledge/Memory previews so a markdown template (e.g. the default testcase.md,
// which is a markdown doc with pipe tables) renders as formatted headings + tables
// instead of raw `| ... |` text.
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
  '[&_hr]:my-5 [&_hr]:border-border',
  // Table styling lives on MD_TABLE_WRAP below (per-table scroll container), so a
  // markdown table can pin its header row + first column instead of scrolling away.
)

// Each markdown table is wrapped in its own scroll box: the header row stays pinned
// on vertical scroll and the first ("No") column stays pinned on horizontal scroll,
// matching the CSV preview. Sticky cells carry a solid bg so nothing bleeds through.
const MD_TABLE_WRAP = cn(
  'my-3 max-h-[70vh] overflow-auto rounded-2xl border border-border/60',
  '[&_th]:sticky [&_th]:top-0 [&_th]:z-20 [&_th]:whitespace-nowrap [&_th]:border [&_th]:bg-muted [&_th]:px-2.5 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold',
  '[&_th:first-child]:left-0 [&_th:first-child]:z-30',
  '[&_td]:border [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:align-top [&_td]:text-xs',
  '[&_tbody_td:first-child]:sticky [&_tbody_td:first-child]:left-0 [&_tbody_td:first-child]:z-10 [&_tbody_td:first-child]:bg-muted [&_tbody_td:first-child]:font-medium [&_tbody_td:first-child]:text-foreground',
)

/** react-markdown renderers: wrap every table so it scrolls with a sticky header + first column. */
const MD_COMPONENTS: Components = {
  table({ node: _node, className: _className, ...props }) {
    return (
      <div className={MD_TABLE_WRAP}>
        <table {...props} className="w-max min-w-full border-collapse text-left text-xs" />
      </div>
    )
  },
}

/** Does this preview name point at a markdown file? (saved templates are always .md) */
function looksLikeMarkdown(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}

/** Catalog of file templates a project can define. The key maps to the on-disk
 *  file (testing/templates/<key>.md); add new kinds here to expose more. */
interface TemplateKind {
  key: string
  label: string
  icon: typeof FileText
  description: string
  /** What happens once it is removed — said in the confirm dialog. */
  removeNote: string
  /** Written by hand in the page's editor (placeholders), not only uploaded. */
  editable?: boolean
}

const TEMPLATE_KINDS: TemplateKind[] = [
  {
    key: 'testcase',
    label: 'Test case template',
    icon: ClipboardList,
    description:
      'The structure Claude matches when drafting test cases on the TestCase page. Upload there still overrides this per run.',
    removeNote:
      'Test-case generation then falls back to no template — cases are drafted in the model’s own structure until you upload one again.',
  },
  {
    key: 'design-check',
    label: 'Design Check checklist',
    icon: ListChecks,
    description:
      'A standard checklist of things to verify on the Design Check page (spacing, component states, copy, responsiveness, accessibility…). Auto-applied to every Design Check run as criteria — the model reports a finding for each item.',
    removeNote:
      'Design Check then runs without the project checklist until you upload one again.',
  },
  {
    key: ISSUE_TEMPLATE_KEY,
    label: 'ClickUp issue template',
    icon: Send,
    description:
      'How a QC run’s issue is worded when it is filed to ClickUp from Run → Issues: the card name and its description, built from placeholders like {{title}}, {{steps}}, {{expected}}, {{actual}}. Assignee, tags, priority and screenshots are still filled in automatically.',
    removeNote:
      'Issues are then filed with the issue text exactly as the run wrote it, as before templates existed.',
    editable: true,
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

/**
 * Write / edit the ClickUp issue template by hand: the text on the left, what a real
 * issue becomes on the right. The preview renders through the SAME function the
 * Issues tab files with (`renderIssueTemplate`), against a sample issue, so what you
 * see here is what lands in ClickUp. Placeholders are clicked in, not remembered.
 */
function IssueTemplateEditor({
  initial,
  savedContent,
  hasDefault,
  saving,
  onSave,
  onClose,
}: {
  initial: string
  /** What is on disk now — saving identical text is a no-op, so the button says so. */
  savedContent: string | null
  hasDefault: boolean
  saving: boolean
  onSave: (content: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initial)
  const area = useRef<HTMLTextAreaElement>(null)
  const loadDefault = useMutation({
    mutationFn: () => getTemplateDefault(ISSUE_TEMPLATE_KEY),
    onSuccess: (res) => setText(res.content),
    onError: (err) =>
      toast.error('Could not load the default template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const problems = issueTemplateProblems(text)
  const card = renderIssueTemplate(text, SAMPLE_ISSUE_VARS, SAMPLE_ISSUE_VARS.heading)
  const unchanged = savedContent !== null && text === savedContent
  const tooBig = new Blob([text]).size > MAX_BYTES
  const blocked = problems.some((p) => p.blocking)

  function insert(snippet: string) {
    const el = area.current
    if (!el) return setText((t) => t + snippet)
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? start
    const next = text.slice(0, start) + snippet + text.slice(end)
    setText(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + snippet.length, start + snippet.length)
    })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="flex max-h-[94vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[84rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Send className="size-4 text-muted-foreground" />
            ClickUp issue template
          </DialogTitle>
          <DialogDescription className="text-xs">
            testing/templates/{ISSUE_TEMPLATE_KEY}.md · Markdown with{' '}
            <code className="font-mono">{'{{placeholders}}'}</code>. The optional{' '}
            <code className="font-mono">title:</code> line between <code className="font-mono">---</code>{' '}
            sets the card name.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden lg:grid-cols-2">
          {/* Left: the template + its placeholders */}
          <div className="flex min-h-0 flex-col gap-3 overflow-auto border-b border-border/60 p-4 lg:border-r lg:border-b-0">
            <Textarea
              ref={area}
              value={text}
              onChange={(e) => setText(e.target.value)}
              spellCheck={false}
              placeholder={'---\ntitle: [{{severity}}] {{title}}\n---\n**Steps to reproduce:**\n{{steps}}\n\n**Expected:** {{expected}}\n\n**Actual:** {{actual}}'}
              className="min-h-[20rem] flex-1 resize-none font-mono text-[12px] leading-relaxed shadow-none [field-sizing:fixed]"
            />
            {problems.length > 0 && (
              <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                {problems.map((p) => (
                  <p key={p.text} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-px size-3 shrink-0" />
                    {p.text}
                    {p.blocking ? ' Fix it to save.' : ''}
                  </p>
                ))}
              </div>
            )}
            <div className="space-y-1.5">
              <p className="text-[11px] font-semibold text-foreground">
                Placeholders{' '}
                <span className="font-normal text-muted-foreground">
                  — click to insert. Wrap text in{' '}
                  <code className="font-mono">{'{{#name}}…{{/name}}'}</code> to show it only when
                  the field has a value, <code className="font-mono">{'{{^name}}…{{/name}}'}</code>{' '}
                  only when it is empty.
                </span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {ISSUE_TEMPLATE_VARS.map((v) => (
                  <button
                    key={v.name}
                    type="button"
                    title={v.description}
                    onClick={() => insert(`{{${v.name}}}`)}
                    className="rounded-xl border border-border/60 bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-foreground/80 transition-colors hover:border-border hover:bg-muted"
                  >
                    {`{{${v.name}}}`}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: what a real issue becomes */}
          <div className="flex min-h-0 flex-col overflow-auto bg-muted/20 p-4">
            <p className="mb-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Preview · a sample issue as the ClickUp card
            </p>
            <div className="rounded-2xl border border-border/60 bg-card">
              <div className="border-b border-border/60 bg-muted/40 px-3.5 py-2">
                <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  Name
                </p>
                <p className="text-sm font-semibold break-words">{card.title}</p>
              </div>
              <div className={cn(MD_CLASS, 'px-3.5 py-2.5 [&_li]:text-foreground/90 [&_p]:text-foreground/90')}>
                {card.description ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                    {card.description}
                  </ReactMarkdown>
                ) : (
                  <p className="text-muted-foreground italic">
                    Empty — the issue would be filed with its text as written instead.
                  </p>
                )}
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Assignee and tags come from the parent ticket, priority from the issue&apos;s
              severity, and screenshots are attached and posted as a comment — the template
              only decides the wording.
            </p>
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center gap-2 border-t border-border/60 bg-muted/30 px-5 py-3 sm:justify-between">
          <div>
            {hasDefault && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => loadDefault.mutate()}
                disabled={saving || loadDefault.isPending}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                {loadDefault.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                Start from the default
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {tooBig && <span className="text-[11px] text-destructive">Over 200 KB</span>}
            <Button type="button" variant="outline" onClick={onClose} disabled={saving} className="rounded-full">
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => onSave(text)}
              disabled={saving || !text.trim() || tooBig || blocked || unchanged}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save template
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** One template: upload a file (csv / md / txt / json / excel) → preview → save.
 *  No manual typing — the content always comes from an uploaded file. */
function TemplateCard({
  kind,
  projectId,
  saved,
  hasDefault,
}: {
  kind: TemplateKind
  projectId: string
  saved: ProjectTemplate | undefined
  // Whether the portal ships a default for this kind (templates/project-templates/).
  hasDefault: boolean
}) {
  const queryClient = useQueryClient()
  const Icon = kind.icon
  const fileInput = useRef<HTMLInputElement>(null)
  // A freshly uploaded-and-parsed file awaiting save (null once saved/cleared).
  const [pending, setPending] = useState<{ name: string; content: string } | null>(null)
  const [reading, setReading] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState(false)

  const save = useMutation({
    mutationFn: (content: string) => saveTemplate(kind.key, content, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      setPending(null)
      setEditing(false)
      toast.success('Template saved', {
        description: `${kind.label} · testing/templates/${kind.key}.md`,
      })
    },
    onError: (err) =>
      toast.error('Could not save template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  // Put back the template the portal ships (the same file a new project is seeded
  // with). Overwrites whatever is saved, so it goes through a confirm step.
  const reset = useMutation({
    mutationFn: () => resetTemplateToDefault(kind.key, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      setPending(null)
      setConfirmReset(false)
      toast.success('Default template restored', {
        description: `${kind.label} · testing/templates/${kind.key}.md`,
      })
    },
    onError: (err) =>
      toast.error('Could not restore the default template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const remove = useMutation({
    mutationFn: () => deleteTemplate(kind.key, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      setPending(null)
      setConfirmRemove(false)
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

  const busy = save.isPending || remove.isPending || reset.isPending || reading
  // What to preview: the pending upload if any, else the saved content.
  const previewName = pending ? pending.name : saved ? `${kind.key}.md` : null
  const previewContent = pending ? pending.content : (saved?.content ?? '')
  // Uploaded CSV/Excel is stored as CSV text inside the .md — show it as a table.
  const previewIsCsv = previewName ? looksLikeCsv(previewName, previewContent) : false
  // Otherwise a markdown template (e.g. the default testcase.md with pipe tables)
  // must be rendered, not dumped as raw text.
  const previewIsMarkdown = !previewIsCsv && previewName ? looksLikeMarkdown(previewName) : false

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
              onClick={() => (kind.editable ? setEditing(true) : setShowPreview(true))}
              disabled={!previewContent}
              className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs"
            >
              {kind.editable ? (
                <>
                  <PencilLine className="size-3.5" /> Preview &amp; edit
                </>
              ) : (
                <>
                  <Eye className="size-3.5" /> Preview
                </>
              )}
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
          {kind.editable && !pending && !saved && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
              disabled={busy}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <PencilLine className="size-3.5" />
              Write one
            </Button>
          )}
          {hasDefault && !pending && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => (saved ? setConfirmReset(true) : reset.mutate())}
              disabled={busy}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
              title="Put back the template the portal ships with"
            >
              {reset.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              {saved ? 'Reset to default' : 'Use default'}
            </Button>
          )}
          {saved && !pending && (
            <Button
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
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

      {kind.editable && editing && (
        <IssueTemplateEditor
          initial={pending?.content ?? saved?.content ?? ''}
          savedContent={saved?.content ?? null}
          hasDefault={hasDefault}
          saving={save.isPending}
          onSave={(content) => save.mutate(content)}
          onClose={() => setEditing(false)}
        />
      )}

      <Dialog open={confirmRemove} onOpenChange={(o) => !remove.isPending && setConfirmRemove(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Trash2 className="size-4 text-destructive" />
              Remove this template?
            </DialogTitle>
            <DialogDescription className="space-y-2 text-left">
              <span className="block">
                <span className="font-mono text-foreground">testing/templates/{kind.key}.md</span>{' '}
                is deleted from disk.
              </span>
              <span className="block">
                {kind.removeNote}
                {hasDefault
                  ? ' You can put the portal’s default back at any time with “Use default”.'
                  : ''}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={remove.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="active:scale-[0.98]"
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Remove template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmReset} onOpenChange={(o) => !reset.isPending && setConfirmReset(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <RotateCcw className="size-4 text-muted-foreground" />
              Reset to the default template?
            </DialogTitle>
            <DialogDescription className="space-y-2 text-left">
              <span className="block">
                <span className="font-mono text-foreground">testing/templates/{kind.key}.md</span>{' '}
                will be overwritten with the default the portal ships — the same file a new
                project starts with.
              </span>
              <span className="block">
                Your current {kind.label.toLowerCase()} is replaced and cannot be recovered.
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={reset.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
              className="active:scale-[0.98]"
            >
              {reset.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              Reset to default
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]">
          <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Icon className="h-4 w-4 text-muted-foreground" />
              {kind.label}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {previewName ?? `${kind.key}.md`}
              {pending ? ' · unsaved upload' : saved ? ` · testing/templates/${kind.key}.md` : ''}
              {previewIsCsv ? ' · shown as a table' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {previewIsCsv ? (
              <CsvTable csv={previewContent} />
            ) : previewIsMarkdown ? (
              <div className={MD_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {previewContent}
                </ReactMarkdown>
              </div>
            ) : (
              <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words">
                {previewContent}
              </pre>
            )}
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

  // Which kinds the portal ships a default for — decides where "Reset to default" shows.
  const { data: defaults } = useQuery({
    queryKey: ['template-defaults'],
    queryFn: listTemplateDefaults,
    staleTime: Infinity,
  })

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Settings className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
            <p className="text-sm text-muted-foreground">
              Per-project file templates and preferences.
            </p>
          </div>
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
  const defaultKeys = new Set(defaults?.keys ?? [])
  const hasTemplates = (templates?.length ?? 0) > 0

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="space-y-4">
        <div data-tour="header" className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Settings className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
            <p className="text-sm text-muted-foreground">
              Per-project file templates{activeProject ? ` for ${activeProject.name}` : ''}. Upload
              a file (the ClickUp issue template can also be written here); it's stored under{' '}
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

      <section data-tour="templates" className="space-y-3">
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
              // Wrapper carries the tour anchor so a guide step can point at one
              // specific template kind (`[data-tour="template-testcase"]`).
              <div key={kind.key} data-tour={`template-${kind.key}`}>
                <TemplateCard
                  kind={kind}
                  projectId={activeProjectId}
                  saved={byKey.get(kind.key)}
                  hasDefault={defaultKeys.has(kind.key)}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
