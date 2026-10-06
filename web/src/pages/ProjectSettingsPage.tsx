import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useSearchParams } from 'react-router-dom'
import {
  ClipboardList,
  Code2,
  Eye,
  FileCog,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderTree,
  ListChecks,
  Loader2,
  Maximize2,
  PencilLine,
  RotateCcw,
  Save,
  Send,
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
  updateProject,
  type ProjectTemplate,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { Checkbox } from '@/components/ui/checkbox'
import { assigneeClause, evidenceClause, useFilingPrefs } from '@/lib/clickup-filing'
import { CsvTable, looksLikeCsv } from '@/components/CsvTable'
import { OpenFolderButton } from '@/components/OpenFolderButton'

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

/** A sample issue rendered through the template — the ClickUp card exactly as
 *  `renderIssueTemplate` builds it for the Issues tab. */
function IssueCardPreview({ text }: { text: string }) {
  const card = renderIssueTemplate(text, SAMPLE_ISSUE_VARS, SAMPLE_ISSUE_VARS.heading)
  return (
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
  )
}

/**
 * Write / edit the ClickUp issue template by hand: the text on the left, what a real
 * issue becomes on the right. The preview renders through the SAME function the
 * Issues tab files with (`renderIssueTemplate`), against a sample issue, so what you
 * see here is what lands in ClickUp. Placeholders are clicked in, not remembered.
 */
/**
 * How a QC finding is FILED to ClickUp, beside the template that decides how it is
 * WORDED. Field report: a team wanted bugs left unassigned and the screenshots inside
 * the card's description, patched their install to get it, and lost the patch on the
 * next update (the updater resets tracked files). Per project, so it survives updates;
 * the defaults are the original behavior.
 */
function ClickupFilingOptions({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const prefs = useFilingPrefs(projectId)
  const save = useMutation({
    mutationFn: (body: { clickupInheritAssignees?: boolean; clickupEvidence?: 'comment' | 'description' }) =>
      updateProject(projectId, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('ClickUp filing updated')
    },
    onError: (err) =>
      toast.error('Could not save', { description: err instanceof Error ? err.message : undefined }),
  })
  return (
    <div className="space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
      <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        When an issue is filed
      </p>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <Checkbox
          className="mt-0.5"
          checked={prefs.inheritAssignees}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ clickupInheritAssignees: e.target.checked })}
        />
        <span>
          <span className="font-medium">Assign it to the parent ticket&apos;s assignee</span>
          <span className="block text-muted-foreground">
            Off: the bug is created unassigned, for teams that triage before assigning.
          </span>
        </span>
      </label>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <Checkbox
          className="mt-0.5"
          checked={prefs.evidence === 'description'}
          disabled={save.isPending}
          onChange={(e) =>
            save.mutate({ clickupEvidence: e.target.checked ? 'description' : 'comment' })
          }
        />
        <span>
          <span className="font-medium">Put the screenshots in the card&apos;s description</span>
          <span className="block text-muted-foreground">
            Instead of a separate comment. Linking them inline needs an imgbb key (IMGBB_API_KEY);
            without one they are attached to the card and no comment is posted.
          </span>
        </span>
      </label>
    </div>
  )
}

function IssueTemplateEditor({
  projectId,
  initial,
  savedContent,
  hasDefault,
  saving,
  onSave,
  onClose,
}: {
  projectId: string
  initial: string
  /** What is on disk now — saving identical text is a no-op, so the button says so. */
  savedContent: string | null
  hasDefault: boolean
  saving: boolean
  onSave: (content: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initial)
  const prefs = useFilingPrefs(projectId)
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
            <IssueCardPreview text={text} />
            <p className="mt-2 text-[11px] text-muted-foreground">
              Each card {assigneeClause(prefs)}, takes its priority from the issue&apos;s
              severity, and gets its screenshots {evidenceClause(prefs)} — the template only
              decides the wording.
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

/** A parsed upload waiting to be saved. Lives on the page (per kind), so switching
 *  between templates in the list does not throw away an unsaved upload. */
interface PendingUpload {
  name: string
  content: string
}

type TemplateState = 'unsaved' | 'saved' | 'unset'

function templateState(saved: ProjectTemplate | undefined, pending: PendingUpload | null): TemplateState {
  return pending ? 'unsaved' : saved ? 'saved' : 'unset'
}

function StatusPill({ saved, pending }: { saved?: ProjectTemplate; pending: PendingUpload | null }) {
  const state = templateState(saved, pending)
  return (
    <span
      className={cn(
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1',
        state === 'unsaved' &&
          'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-400/25',
        state === 'saved' &&
          'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300 dark:ring-emerald-400/25',
        state === 'unset' && 'bg-muted font-medium text-muted-foreground ring-border/60',
      )}
    >
      {state === 'unsaved' ? 'Unsaved' : state === 'saved' ? `Saved · ${formatBytes(saved!.size)}` : 'Not set'}
    </span>
  )
}

/** One row of the template list: icon, name, and whether the project has one. */
function TemplateNavItem({
  kind,
  saved,
  pending,
  active,
  onSelect,
}: {
  kind: TemplateKind
  saved: ProjectTemplate | undefined
  pending: PendingUpload | null
  active: boolean
  onSelect: () => void
}) {
  const Icon = kind.icon
  const state = templateState(saved, pending)
  return (
    <button
      type="button"
      // Tour anchor: a guide step points at one specific kind (`[data-tour="template-testcase"]`).
      data-tour={`template-${kind.key}`}
      aria-current={active ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left transition-all duration-200 active:scale-[0.98]',
        active ? 'bg-muted' : 'hover:bg-muted/60',
      )}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl transition-colors',
          active
            ? 'bg-foreground text-background'
            : 'border border-border/60 bg-muted/60 text-muted-foreground',
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate text-sm font-medium">{kind.label}</span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              state === 'unsaved' && 'bg-amber-500',
              state === 'saved' && 'bg-emerald-500',
              state === 'unset' && 'bg-muted-foreground/40',
            )}
          />
          {state === 'unsaved' ? 'Unsaved upload' : state === 'saved' ? `Saved · ${formatBytes(saved!.size)}` : 'Not set'}
        </span>
      </span>
    </button>
  )
}

type ContentView = 'preview' | 'source'

/** The template's content: rendered (CSV table / Markdown / sample ClickUp card), or as source. */
function TemplateBody({
  kind,
  name,
  content,
  view,
}: {
  kind: TemplateKind
  name: string
  content: string
  view: ContentView
}) {
  if (view === 'source') {
    return (
      <pre className="font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">{content}</pre>
    )
  }
  if (kind.key === ISSUE_TEMPLATE_KEY) {
    return (
      <div className="max-w-3xl space-y-2">
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          A sample issue as the ClickUp card
        </p>
        <IssueCardPreview text={content} />
      </div>
    )
  }
  // Uploaded CSV/Excel is stored as CSV text inside the .md — show it as a table.
  if (looksLikeCsv(name, content)) return <CsvTable csv={content} />
  // A markdown template (e.g. the default testcase.md with pipe tables) must be
  // rendered, not dumped as raw text.
  if (looksLikeMarkdown(name)) {
    return (
      <div className={MD_CLASS}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
          {content}
        </ReactMarkdown>
      </div>
    )
  }
  return <pre className="font-mono text-[12px] leading-relaxed break-words whitespace-pre-wrap">{content}</pre>
}

function ViewToggle({ view, onChange }: { view: ContentView; onChange: (v: ContentView) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-full border border-border/60 bg-muted/60 p-0.5">
      {(['preview', 'source'] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-pressed={view === v}
          className={cn(
            'flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium capitalize transition-colors',
            view === v ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {v === 'preview' ? <Eye className="size-3" /> : <Code2 className="size-3" />}
          {v}
        </button>
      ))}
    </div>
  )
}

/** The selected template: what it does, its content inline, and every action on it.
 *  Content comes from an uploaded file (drop it anywhere on the panel, or browse);
 *  the ClickUp issue template can also be written by hand. */
function TemplatePanel({
  kind,
  projectId,
  saved,
  hasDefault,
  pending,
  onPending,
}: {
  kind: TemplateKind
  projectId: string
  saved: ProjectTemplate | undefined
  // Whether the portal ships a default for this kind (templates/project-templates/).
  hasDefault: boolean
  pending: PendingUpload | null
  onPending: (p: PendingUpload | null) => void
}) {
  const queryClient = useQueryClient()
  const Icon = kind.icon
  const fileInput = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState<ContentView>('preview')
  const [expanded, setExpanded] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [editing, setEditing] = useState(false)

  const save = useMutation({
    mutationFn: (content: string) => saveTemplate(kind.key, content, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates', projectId] })
      onPending(null)
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
      onPending(null)
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
      onPending(null)
      setConfirmRemove(false)
      toast.success('Template removed', { description: kind.label })
    },
    onError: (err) =>
      toast.error('Could not remove template', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const busy = save.isPending || remove.isPending || reset.isPending || reading

  async function ingest(file: File) {
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`
    if (!ACCEPT.split(',').includes(ext)) {
      toast.error('Unsupported file type', {
        description: `${file.name} — use CSV, Markdown, TXT, JSON or Excel.`,
      })
      return
    }
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
      onPending({ name: file.name, content })
      setView('preview')
    } catch (err) {
      toast.error('Could not read the file', {
        description: err instanceof Error ? err.message : 'Unsupported or corrupt file',
      })
    } finally {
      setReading(false)
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (file) void ingest(file)
  }

  function onDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    if (!busy) setDragging(true)
  }

  function onDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file && !busy) void ingest(file)
  }

  // What to show: the pending upload if any, else the saved content.
  const contentName = pending ? pending.name : saved ? `${kind.key}.md` : null
  const content = pending ? pending.content : (saved?.content ?? '')
  const lineCount = content ? content.split(/\r?\n/).length : 0

  return (
    <Card
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="relative min-w-0 gap-0 overflow-hidden rounded-3xl border-border/60 py-0 shadow-none"
    >
      <input ref={fileInput} type="file" accept={ACCEPT} onChange={onPick} className="hidden" />

      {/* Header: what this template is + every action on it */}
      <div className="space-y-2.5 border-b border-border/60 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base leading-tight font-semibold tracking-tight">{kind.label}</h2>
                <StatusPill saved={saved} pending={pending} />
              </div>
              <p className="truncate font-mono text-[11px] text-muted-foreground">
                testing/templates/{kind.key}.md
              </p>
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {pending ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onPending(null)}
                  disabled={busy}
                  className="rounded-full text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3.5" />
                  Discard
                </Button>
                {kind.editable && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing(true)}
                    disabled={busy}
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    <PencilLine className="size-3.5" />
                    Edit
                  </Button>
                )}
                <Button
                  size="sm"
                  onClick={() => save.mutate(pending.content)}
                  disabled={busy}
                  className="rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {save.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                  {save.isPending ? 'Saving…' : saved ? 'Replace template' : 'Save template'}
                </Button>
              </>
            ) : saved ? (
              <>
                {kind.editable && (
                  <Button
                    size="sm"
                    onClick={() => setEditing(true)}
                    disabled={busy}
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    <PencilLine className="size-3.5" />
                    Edit
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy}
                  className="rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {reading ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
                  Replace
                </Button>
                {hasDefault && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmReset(true)}
                    disabled={busy}
                    title="Put back the template the portal ships with"
                    className="rounded-full transition-all duration-200 active:scale-[0.98]"
                  >
                    <RotateCcw className="size-3.5" />
                    Reset to default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setConfirmRemove(true)}
                  disabled={busy}
                  title="Remove template"
                  aria-label="Remove template"
                  className="size-8 rounded-full text-muted-foreground transition-all duration-200 hover:text-destructive active:scale-[0.98]"
                >
                  {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </Button>
              </>
            ) : null}
          </div>
        </div>
        <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{kind.description}</p>
      </div>

      {pending && (
        <div className="flex items-center gap-2 border-b border-amber-200/70 bg-amber-50/70 px-5 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
          <TriangleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0">
            Previewing <span className="font-medium">{pending.name}</span> — not used until you{' '}
            {saved ? 'replace the saved template' : 'save it'}.
          </span>
        </div>
      )}

      {contentName ? (
        <>
          <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-5 py-2">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              {contentName}
              <span className="text-muted-foreground/70">
                {' '}
                · {lineCount} lines{pending ? ' · unsaved upload' : ''}
              </span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <ViewToggle view={view} onChange={setView} />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setExpanded(true)}
                title="Open full screen"
                aria-label="Open full screen"
                className="size-7 rounded-full text-muted-foreground hover:text-foreground"
              >
                <Maximize2 className="size-3.5" />
              </Button>
            </div>
          </div>
          {kind.key === ISSUE_TEMPLATE_KEY && <ClickupFilingOptions projectId={projectId} />}
          <div className="max-h-[calc(100vh-19rem)] min-h-64 overflow-auto px-5 py-4">
            <TemplateBody kind={kind} name={contentName} content={content} view={view} />
          </div>
        </>
      ) : (
        /* Empty: one drop target with every way to get a template in */
        <div className="p-5">
          <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border/70 px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              {reading ? <Loader2 className="size-5 animate-spin" /> : <FileUp className="size-5" />}
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium">
                {reading ? 'Reading file…' : 'No template yet — drop a file here'}
              </p>
              <p className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
                <FileSpreadsheet className="size-3" />
                CSV, Markdown, TXT, JSON or Excel (.xlsx) · up to 200 KB
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                onClick={() => fileInput.current?.click()}
                disabled={busy}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                <FileUp className="size-3.5" />
                Browse files
              </Button>
              {kind.editable && (
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
              {hasDefault && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reset.mutate()}
                  disabled={busy}
                  title="Start from the template the portal ships with"
                  className="rounded-full transition-all duration-200 active:scale-[0.98]"
                >
                  {reset.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="size-3.5" />
                  )}
                  Use default
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-[1.25rem] border-2 border-dashed border-foreground/30 bg-background/85 backdrop-blur-sm">
          <FileUp className="size-6 text-foreground" />
          <p className="text-sm font-medium">Drop to preview as the {kind.label.toLowerCase()}</p>
          <p className="text-xs text-muted-foreground">Nothing is saved until you confirm.</p>
        </div>
      )}

      {kind.editable && editing && (
        <IssueTemplateEditor
          projectId={projectId}
          initial={pending?.content ?? saved?.content ?? ''}
          savedContent={saved?.content ?? null}
          hasDefault={hasDefault}
          saving={save.isPending}
          onSave={(c) => save.mutate(c)}
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
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
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
              {reset.isPending ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
              Reset to default
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]">
          <DialogHeader className="shrink-0 flex-row items-center gap-3 space-y-0 border-b border-border/60 bg-muted/30 px-5 py-3 pr-12">
            <div className="min-w-0 flex-1 space-y-1">
              <DialogTitle className="flex items-center gap-2 text-base">
                <Icon className="size-4 text-muted-foreground" />
                {kind.label}
              </DialogTitle>
              <DialogDescription className="truncate font-mono text-xs">
                {pending ? `${pending.name} · unsaved upload` : `testing/templates/${kind.key}.md`}
              </DialogDescription>
            </div>
            <ViewToggle view={view} onChange={setView} />
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
            {contentName && <TemplateBody kind={kind} name={contentName} content={content} view={view} />}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** List + selected template for one project. Keyed by project, so unsaved uploads
 *  never leak from one project into another. */
function TemplatesWorkspace({
  projectId,
  rootPath,
}: {
  projectId: string
  rootPath: string | undefined
}) {
  const [params, setParams] = useSearchParams()
  const [pending, setPending] = useState<Record<string, PendingUpload | null>>({})

  const { data: templates, isLoading } = useQuery({
    queryKey: ['templates', projectId],
    queryFn: () => listTemplates(projectId),
  })

  // Which kinds the portal ships a default for — decides where "Reset to default" shows.
  const { data: defaults } = useQuery({
    queryKey: ['template-defaults'],
    queryFn: listTemplateDefaults,
    staleTime: Infinity,
  })

  // `?kind=` deep-links one template (Run → Issues links straight to the ClickUp one).
  const requested = params.get('kind')
  const kind = TEMPLATE_KINDS.find((k) => k.key === requested) ?? TEMPLATE_KINDS[0]
  const select = (key: string) =>
    setParams(
      (p) => {
        p.set('kind', key)
        return p
      },
      { replace: true },
    )

  const byKey = new Map((templates ?? []).map((t) => [t.key, t]))
  const defaultKeys = new Set(defaults?.keys ?? [])
  const hasTemplates = (templates?.length ?? 0) > 0
  const folder = rootPath ? `${rootPath}/testing/templates` : 'testing/templates'

  return (
    <div data-tour="templates" className="grid items-start gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="space-y-3 lg:sticky lg:top-4">
        <nav
          aria-label="Templates"
          className="grid gap-1 rounded-3xl border border-border/60 bg-card p-2 sm:grid-cols-3 lg:grid-cols-1"
        >
          {TEMPLATE_KINDS.map((k) => (
            <TemplateNavItem
              key={k.key}
              kind={k}
              saved={byKey.get(k.key)}
              pending={pending[k.key] ?? null}
              active={k.key === kind.key}
              onSelect={() => select(k.key)}
            />
          ))}
        </nav>

        <div className="space-y-2.5 rounded-3xl border border-border/60 bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
              <FolderTree className="size-3.5" />
              Stored in
            </span>
            <span
              className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                hasTemplates
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                  : 'bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
              )}
            >
              {hasTemplates ? 'exists' : 'new'}
            </span>
          </div>
          <p className="font-mono text-[11px] leading-relaxed break-all text-foreground/80" title={folder}>
            {folder}
          </p>
          <OpenFolderButton open={() => openTemplatesFolder(projectId)} label="templates" />
        </div>
      </aside>

      {isLoading ? (
        <Card className="items-center justify-center gap-2 rounded-3xl border-border/60 py-24 text-sm text-muted-foreground shadow-none">
          <Loader2 className="size-5 animate-spin" />
          Loading templates…
        </Card>
      ) : (
        <TemplatePanel
          key={kind.key}
          kind={kind}
          projectId={projectId}
          saved={byKey.get(kind.key)}
          hasDefault={defaultKeys.has(kind.key)}
          pending={pending[kind.key] ?? null}
          onPending={(p) => setPending((m) => ({ ...m, [kind.key]: p }))}
        />
      )}
    </div>
  )
}

export default function ProjectSettingsPage() {
  const { activeProjectId, activeProject } = useProjects()

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header data-tour="header" className="flex items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <FileCog className="size-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Templates</h1>
          <p className="text-sm text-muted-foreground">
            The shape of generated test cases, Design Check runs and ClickUp issues
            {activeProject ? (
              <>
                {' '}
                for <span className="font-medium text-foreground">{activeProject.name}</span>
              </>
            ) : null}
            . The QC skill and the Portal both read them.
          </p>
        </div>
      </header>

      {activeProjectId ? (
        <TemplatesWorkspace
          key={activeProjectId}
          projectId={activeProjectId}
          rootPath={activeProject?.rootPath}
        />
      ) : (
        <Card className="rounded-3xl border-dashed border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex size-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
              <FileCog className="size-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No project selected</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Choose a project in the sidebar to manage its templates.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
