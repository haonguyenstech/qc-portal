import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
// Aliased: the DOM's ClipboardEvent/DragEvent are also in scope in this file.
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  ArrowUp,
  Blocks,
  Bug,
  Check,
  ChevronDown,
  ClipboardList,
  Compass,
  Copy,
  Download,
  FileSearch,
  FileText,
  Globe,
  History,
  Library,
  ListTodo,
  Loader2,
  MessageSquareDashed,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Workflow,
  Star,
  Telescope,
  TerminalSquare,
  Ticket,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/CodeBlock'
import { MermaidDiagram } from '@/components/MermaidDiagram'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT, MAX_FILE_BYTES } from '@/lib/docConvert'
import { useProjects } from '@/lib/project-context'
import {
  chatImageUrl,
  deleteChat,
  getChat,
  listChats,
  listCrawledTickets,
  pinChat,
  renameChat,
  streamChat,
  attachChat,
  stopChat,
  type Chat,
  type ChatAction,
  type ChatMention,
  type CrawledTicket,
  type ChatMessage,
  type ChatSummary,
  type ChatToolCall,
  type ChatTools,
} from '@/lib/api'

/**
 * Chat — ask Claude Code about this project in plain language and read the answer as a
 * conversation, instead of filling in a form or driving the interactive TUI on
 * /terminal. Every turn runs `claude -p` in the project folder (so CLAUDE.md, Knowledge
 * and Memory are in scope) and the CLI session is resumed on the next turn, which is
 * what makes a follow-up question understand "it".
 *
 * The layout is a direct port of shadcnuikit's "AI Chat v2" screen — bordered shell,
 * 18rem conversation rail with search + grouped history + footer nav + New chat, a
 * centered max-w-4xl column, gradient greeting, and the tinted composer well with its
 * hint strip. Every mock control is wired to something real rather than dropped: the
 * paperclip converts a spec in-browser, the mic slot became the tools toggle, and the
 * quick chips send actual QC prompts. This page deliberately follows the reference's
 * small radii instead of the portal's rounded-3xl house style.
 */

// Markdown styling — same vocabulary as OverviewPage, tightened for chat lines. The
// reference leans on @tailwindcss/typography's `prose`, which this app doesn't ship.
const MD_CLASS = cn(
  'text-sm leading-relaxed break-words',
  '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold',
  // Prose gets a MEASURE, code and tables don't: the column is ~1300px on a large screen,
  // where an uncapped paragraph runs ~140 characters a line and is genuinely hard to read —
  // but a code block or a CSV table wants every pixel. So the cap goes on text only.
  '[&_p]:my-2 [&_p]:max-w-[85ch] [&_li]:max-w-[85ch] [&_blockquote]:max-w-[85ch]',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1',
  '[&_a]:font-medium [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold',
  '[&_code]:rounded [&_code]:bg-foreground/10 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  // A fenced block is rendered by CodeBlock, which owns its own shell — undo the inline
  // `code` pill inside it so the header bar isn't fighting a padded, tinted <code>.
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-inherit',
  '[&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:italic',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs',
  '[&_hr]:my-4',
)

/**
 * How markdown code renders in an answer.
 *
 * A fenced block becomes a `CodeBlock` — language label, copy button, syntax colours —
 * because an answer that hands back a service class is something the engineer pastes
 * somewhere, and hand-selecting 30 lines out of a scrolling transcript is where that goes
 * wrong. Inline `code` stays the plain pill it was.
 *
 * `pre` is a passthrough: CodeBlock renders its own `<pre>`, so leaving react-markdown's
 * would nest one block shell inside another.
 */
function mdComponents(renderDiagrams: boolean): Components {
  return {
    // The swap happens on `pre`, not `code`: react-markdown v9 dropped the `inline` prop, so
    // `pre` IS the only reliable signal that this was a fenced block. Doing it on `code` and
    // guessing from "has a newline" turns a one-line fence into an inline pill.
    pre: ({ children, ...rest }) => {
      const child = Array.isArray(children) ? children[0] : children
      if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
        const text = String(child.props.children ?? '').replace(/\n$/, '')
        const lang = /language-([\w#+-]+)/.exec(child.props.className ?? '')?.[1]
        // A ```mermaid fence IS the answer for the diagram action — render the picture.
        // Not while streaming: half a diagram is invalid Mermaid, so the bubble would sit
        // under a red parse error for the whole turn and then flip to a diagram at the end.
        if (text && lang === 'mermaid') {
          return renderDiagrams ? (
            <MermaidDiagram chart={text} className="my-3" />
          ) : (
            <CodeBlock code={text} language={lang} />
          )
        }
        if (text) return <CodeBlock code={text} language={lang} />
      }
      return <pre {...rest}>{children}</pre>
    },
  }
}

/** Module-level so a re-render never hands ReactMarkdown a new `components` identity. */
const MD_COMPONENTS = mdComponents(true)
const MD_COMPONENTS_STREAMING = mdComponents(false)

const MODELS = [
  { value: 'haiku', label: 'Claude Haiku' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
]

const MODEL_KEY = 'qc.chatModel'
const TOOLS_KEY = 'qc.chatTools'
const MAX_PROMPT = 12_000

/**
 * Pasted screenshots. A QC engineer's evidence is almost always an image — a broken
 * screen, a stack trace, a Figma crop — so Cmd/Ctrl-V into the composer has to work, not
 * just the file picker. Kept in step with routes/chat.ts (`IMAGE_EXT`, `MAX_IMAGES`,
 * `MAX_IMAGE_BYTES`): the server rejects anything else, so refusing it here is only so
 * the engineer hears WHY before waiting on a turn.
 */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

// --------------------------------------------------------------- @ mentions

/**
 * `@` tags a crawled ticket or its test cases.
 *
 * "Are these cases enough?" only means something next to a ticket, and the alternatives
 * are pasting a folder path or hoping the model greps for the right one. The token that
 * lands in the message (`@ABC-123`) is what the engineer reads; the machine-readable
 * reference rides alongside in `mentions` and is resolved to files server-side.
 *
 * The token stays in the text on purpose: it's the record of what was asked, and it's why
 * a mention whose token the engineer deleted is dropped at send time.
 */
interface StagedMention {
  token: string
  kind: 'ticket' | 'testcase'
  folder: string
}

/** One row of the `@` menu. */
interface MentionOption extends StagedMention {
  label: string
  detail: string
}

const MAX_MENTION_ROWS = 8

/**
 * The `@…` being typed at the caret, if any: where it starts and what's been typed after
 * it. Anchored to a word boundary so an email address or a decorator (`@Injectable`) mid
 * word doesn't open the menu.
 */
function activeMention(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\w.\-/]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  return { start: caret - m[1].length - 1, query: m[1] }
}

/** Turn `@`-able artifacts into menu rows, filtered by what's been typed. */
function mentionOptions(tickets: CrawledTicket[], query: string): MentionOption[] {
  const q = query.trim().toLowerCase()
  const out: MentionOption[] = []
  for (const t of tickets) {
    const id = t.displayId?.trim() || t.name.split('/').pop() || t.name
    const haystack = `${id} ${t.title ?? ''} ${t.name}`.toLowerCase()
    if (q && !haystack.includes(q)) continue
    out.push({
      token: `@${id}`,
      kind: 'ticket',
      folder: t.name,
      label: id,
      detail: t.title?.trim() || t.name,
    })
    if (t.testcaseVersions > 0) {
      out.push({
        token: `@${id}/testcases`,
        kind: 'testcase',
        folder: t.name,
        label: `${id}/testcases`,
        detail: `Latest of ${t.testcaseVersions} test-case version${t.testcaseVersions === 1 ? '' : 's'}`,
      })
    }
    if (out.length >= MAX_MENTION_ROWS * 2) break
  }
  return out.slice(0, MAX_MENTION_ROWS)
}

/** An image staged for the next message: a data URL to preview, base64 bytes to send. */
interface StagedImage {
  name: string
  mime: string
  dataUrl: string
  data: string
}

function readImage(file: File): Promise<StagedImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('could not be read'))
    fr.onload = () => {
      const dataUrl = String(fr.result ?? '')
      // "data:image/png;base64,AAAA…" — the bytes are what the server writes to disk.
      const comma = dataUrl.indexOf(',')
      if (comma === -1) return reject(new Error('could not be read'))
      resolve({
        name: file.name || 'pasted image',
        mime: file.type,
        dataUrl,
        data: dataUrl.slice(comma + 1),
      })
    }
    fr.readAsDataURL(file)
  })
}

// --------------------------------------------------------- the composer's + menu

/**
 * What the `+` button offers.
 *
 * `attach` is the paperclip that was already here (it just moved into the menu, where the
 * reference puts it). The other three are real changes to how the turn runs — different
 * tools, different instructions, a different time budget — chosen per MESSAGE, so a
 * conversation can search the web for one question and read the repo for the next. See
 * routes/chat.ts `ACTION_BLOCKS`.
 *
 * NOTE on "Create image": the reference's item generates a picture, which the Claude CLI
 * cannot do — there is no image model behind it. Rather than a button that apologises, this
 * is **Create diagram**: the model answers with a Mermaid diagram and the page renders it
 * (`MermaidDiagram`, the same renderer /diagrams uses). That's the visual this tool can
 * actually produce, and it's the one QC work asks for — a flow, a state machine, a sequence.
 */
const CHAT_ACTIONS: {
  value: ChatAction
  label: string
  hint: string
  icon: LucideIcon
  /** Tint for the icon chip + the active pill. */
  tone: string
  /** Placeholder while the action is armed — it says what the message should be. */
  placeholder: string
}[] = [
  {
    value: 'diagram',
    label: 'Create diagram',
    hint: 'Visualize a flow or structure',
    icon: Workflow,
    tone: 'text-amber-600 dark:text-amber-400',
    placeholder: 'Describe what to diagram — a flow, the states of a screen, a sequence…',
  },
  {
    value: 'web',
    label: 'Web search',
    hint: 'Find real-time info, with sources',
    icon: Globe,
    tone: 'text-sky-600 dark:text-sky-400',
    placeholder: 'What should I look up on the web?',
  },
  {
    value: 'research',
    label: 'Deep research',
    hint: 'Get a detailed, cross-checked report',
    icon: Telescope,
    tone: 'text-blue-600 dark:text-blue-400',
    placeholder: 'What should I research? Expect a few minutes for the report.',
  },
]

const actionMeta = (a: ChatAction) => CHAT_ACTIONS.find((x) => x.value === a)!

/**
 * The `+` menu (the reference's "Add photos & files / Create image / Web search / Deep
 * research" sheet). Hand-rolled like `RowMenu` — this app ships no dropdown primitive, and
 * a four-item menu doesn't justify adding one. Opens UPWARD: the composer sits at the
 * bottom of the page.
 */
function ComposerPlusMenu({
  action,
  converting,
  anchor,
  onPickAction,
  onAttach,
}: {
  action: ChatAction | null
  converting: boolean
  /**
   * The composer WELL, which the panel is portaled into.
   *
   * The panel cannot render where the button is: the input card around that row is
   * `overflow-hidden` (it clips the textarea to the rounded corners), so a menu opening
   * upward from inside it is sliced down to its last row — verified on screen. The `@` menu
   * solves the same problem by living on the well, which doesn't clip; this borrows the well
   * rather than duplicating that markup, so the two menus stay in one place.
   */
  anchor: HTMLDivElement | null
  onPickAction: (a: ChatAction) => void
  onAttach: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      // BOTH: the panel is portaled elsewhere in the tree, so testing only the trigger's
      // wrapper would count a click on a menu row as "outside" — closing the menu on
      // mousedown and unmounting the row before its click could ever fire.
      const t = e.target as Node
      if (!ref.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const row =
    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent'

  const panel = (
    <div
      ref={panelRef}
      className="absolute bottom-full left-0 z-30 mb-2 w-[19rem] max-w-full overflow-hidden rounded-xl border bg-popover p-1 shadow-md"
    >
      <button
        type="button"
        onClick={() => {
          setOpen(false)
          onAttach()
        }}
        className={row}
      >
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Paperclip className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm">Add photos &amp; files</span>
          <span className="block truncate text-xs text-muted-foreground">
            Upload from this computer
          </span>
        </span>
      </button>
      {CHAT_ACTIONS.map((a) => (
        <button
          key={a.value}
          type="button"
          onClick={() => {
            setOpen(false)
            onPickAction(a.value)
          }}
          className={cn(row, action === a.value && 'bg-accent')}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
            <a.icon className={cn('size-4', a.tone)} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm">{a.label}</span>
            <span className="block truncate text-xs text-muted-foreground">{a.hint}</span>
          </span>
          {action === a.value && <Check className="ms-auto size-4 shrink-0" />}
        </button>
      ))}
    </div>
  )

  return (
    <div ref={ref} className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setOpen((v) => !v)}
            aria-label="Add files, or pick what this message should do"
            aria-expanded={open}
            className={cn('size-8 rounded-2xl', open && 'bg-secondary-foreground/10')}
          >
            {converting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className={cn('size-4 transition-transform duration-200', open && 'rotate-45')} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Attach a file, or make this message search the web</TooltipContent>
      </Tooltip>

      {open && (anchor ? createPortal(panel, anchor) : panel)}
    </div>
  )
}

/**
 * The reference's Summary / Code / Design / Research pills, as QC work.
 *
 * These are **category expanders**, not one-shot prompts — same behaviour as the
 * reference: clicking a chip swaps the chip row for that category's four concrete
 * prompts (a bold verb `prefix` + the muted `rest`), and clicking one of those TYPES it
 * into the composer rather than sending. The engineer edits it — "the newest crawled
 * ticket" usually wants a ticket id — and presses Enter themselves.
 */
const QUICK: {
  icon: typeof Bug
  label: string
  prefix: string
  items: string[]
}[] = [
  {
    icon: ClipboardList,
    label: 'Test cases',
    prefix: 'Draft test cases for',
    items: [
      ' the newest crawled ticket',
      ' the login and permission flows',
      " a form's validation rules",
      ' the edge cases we are missing',
    ],
  },
  {
    icon: FileSearch,
    label: 'Explain',
    prefix: 'Explain',
    items: [
      ' how this feature is implemented',
      ' what this endpoint validates',
      ' every state this screen can be in',
      ' which roles can see what',
    ],
  },
  {
    icon: Bug,
    label: 'Investigate',
    prefix: 'Investigate',
    items: [
      ' why the newest run failed',
      ' this error message',
      ' a test that fails intermittently',
      " a bug I can't reproduce",
    ],
  },
  {
    icon: ShieldCheck,
    label: 'Coverage',
    prefix: 'Check',
    items: [
      ' our test cases against the real code',
      " which acceptance criteria aren't covered",
      ' the cases match the ticket',
      ' for duplicate or dead test cases',
    ],
  },
]

/** The reference's Explore / Library / History / Upgrade rail footer, pointed at real pages. */
const RAIL_LINKS: { to: string; label: string; icon: typeof Compass }[] = [
  { to: '/tickets', label: 'Tickets', icon: Compass },
  { to: '/instructions', label: 'Knowledge', icon: Library },
  { to: '/history', label: 'Run history', icon: History },
  { to: '/terminal', label: 'Terminal', icon: TerminalSquare },
]

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good Morning'
  if (h < 18) return 'Good Afternoon'
  return 'Good Evening'
}

/** Today / Yesterday / 7 Days Ago / Older — the reference's history grouping. */
function bucketOf(iso: string): string {
  const then = new Date(iso)
  const now = new Date()
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = (day(now) - day(then)) / 86_400_000
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff <= 7) return '7 Days Ago'
  return 'Older'
}
const BUCKETS = ['Today', 'Yesterday', '7 Days Ago', 'Older']

/**
 * The rail row's second line: when this conversation was last worked on.
 *
 * Relative inside a week (the group header already says which day, so "3h ago" is what adds
 * information), then a plain date — "37d ago" is nobody's mental model of last month.
 */
function railTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days <= 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ------------------------------------------------------------------ history rail

/**
 * The per-row "…" menu. Built by hand rather than with Radix: this app doesn't ship a
 * dropdown-menu primitive, and a two-item menu doesn't justify adding one.
 */
function RowMenu({
  pinned,
  onPin,
  onRename,
  onDelete,
  onExport,
  always,
}: {
  pinned: boolean
  onPin: () => void
  onRename: () => void
  onDelete: () => void
  /** Only the header offers this — a rail row doesn't need a download in a two-item menu. */
  onExport?: () => void
  /** The rail reveals the trigger on row hover; the header's is always there. */
  always?: boolean
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Conversation options"
        className={cn(
          'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
          !always && 'md:opacity-0 md:group-hover:opacity-100',
          open && 'bg-accent md:opacity-100',
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-40 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onPin()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <Star className={cn('size-3.5', pinned && 'fill-amber-400 text-amber-500')} />
            {pinned ? 'Unstar' : 'Star'}
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onRename()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
          >
            <PenLine className="size-3.5" />
            Rename
          </button>
          {onExport && (
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                onExport()
              }}
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent"
            >
              <Download className="size-3.5" />
              Export .md
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-destructive transition-colors hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" />
            Delete
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Rename, as a dialog rather than `window.prompt`.
 *
 * The native prompt can't be styled, can't show what it's renaming, and on some browsers
 * is suppressed outright — which read as "the Rename menu item does nothing". Mounted with
 * `key={target.slug}` by the caller so the field seeds from the current name without a
 * setState-in-effect.
 */
function RenameChatDialog({
  target,
  busy,
  onCancel,
  onSave,
}: {
  target: { slug: string; name: string } | null
  busy: boolean
  onCancel: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState(target?.name ?? '')
  const clean = name.trim().slice(0, 80)
  const unchanged = clean === target?.name
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
          <DialogDescription>
            The name is what the history rail shows. The transcript file keeps its own name.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            // Enter saves — the whole dialog is one field, so making the user reach for the
            // button would be worse than the prompt() this replaced.
            if (e.key === 'Enter' && clean && !unchanged && !busy) {
              e.preventDefault()
              onSave(clean)
            }
          }}
          placeholder="Conversation name"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onSave(clean)} disabled={!clean || unchanged || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Delete, as a dialog: it names the conversation and says the transcript file goes with it. */
function DeleteChatDialog({
  target,
  busy,
  onCancel,
  onConfirm,
}: {
  target: { slug: string; name: string } | null
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this conversation?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{target?.name}</span> and its transcript
            file are removed from <span className="font-mono text-xs">testing/chats</span>. This
            can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The temporary-chat notice.
 *
 * A conversation here normally becomes part of the project: `testing/chats/<slug>.json` is
 * committed with everything else. That's right for "how does this feature work?" and wrong
 * for a throwaway question or one with a customer's data pasted into it — so a temporary
 * chat is held in the server's memory instead and never reaches the folder or the rail.
 *
 * The notice says exactly that and no more. It deliberately does NOT claim the conversation
 * leaves no trace anywhere: pasted screenshots have to be real files for Claude to Read
 * them (they're deleted with the chat), and the Claude CLI keeps its own session transcript
 * in the user's home folder, which the portal doesn't own. A privacy promise that isn't
 * exactly true is worse than none — someone will rely on it.
 */
function TemporaryNotice({ live, onEnd }: { live: boolean; onEnd: () => void }) {
  return (
    <div className="flex w-full shrink-0 items-start gap-2.5 rounded-xl border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs">
      <MessageSquareDashed className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium text-foreground">
          Temporary chat — this conversation won't appear in your history
        </p>
        <p className="text-muted-foreground">
          Nothing is written to <code className="font-mono">testing/chats</code>, so it isn't
          committed with the project. It's held in memory while you use it and dropped when you
          end it, after 6 hours idle, or when the server restarts. Claude Code still keeps its
          own session transcript in your home folder.
        </p>
      </div>
      {live && (
        <Button
          variant="outline"
          size="sm"
          onClick={onEnd}
          className="h-7 shrink-0 rounded-full px-3 text-xs"
        >
          <Trash2 className="size-3.5" />
          End chat
        </Button>
      )}
    </div>
  )
}

function ChatRail({
  chats,
  activeSlug,
  onSelect,
  onNew,
  onNewTemporary,
  onPin,
  onRename,
  onDelete,
}: {
  chats: ChatSummary[]
  activeSlug: string | null
  onSelect: (slug: string) => void
  onNew: () => void
  onNewTemporary: () => void
  onPin: (slug: string, pinned: boolean) => void
  onRename: (slug: string, current: string) => void
  onDelete: (slug: string) => void
}) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const match = q.trim().toLowerCase()
    const shown = match
      ? chats.filter(
          (c) =>
            c.name.toLowerCase().includes(match) || c.preview.toLowerCase().includes(match),
        )
      : chats
    // Starred first, as its own group — a starred conversation is one you keep coming back
    // to, so it must outrank its own date instead of sinking into "Older" after a week.
    return [
      { label: 'Starred', items: shown.filter((c) => c.pinned) },
      ...BUCKETS.map((label) => ({
        label,
        items: shown.filter((c) => !c.pinned && bucketOf(c.updatedAt) === label),
      })),
    ].filter((g) => g.items.length)
  }, [chats, q])

  return (
    <div className="hidden md:flex">
      <div className="flex h-full flex-col border-e lg:w-72">
        {/* h-14, exactly like the chat header next to it: this row's bottom border and the
            header's are the SAME line across the page, so any difference in height (it used
            to be an h-11 input + py-2 = 60px) shows up as a visible step at the seam. */}
        <div className="flex h-14 shrink-0 items-center border-b px-4">
          {/* The icon sits in the same text column the rows start in (px-3 → 28px from the
              rail edge) rather than hanging outside it at left-0. */}
          <div className="flex w-full items-center gap-2 px-3">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            {/* Flat search field: the Input base adds a ring + shadow on focus, which reads
                as a white pill lifting off the rail. Kill all three on focus. */}
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats..."
              className="h-8 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:shadow-none focus-visible:ring-0"
            />
          </div>
        </div>

        <div className="grow space-y-4 overflow-y-auto p-4 lg:space-y-8">
          {groups.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">
              {q.trim() ? 'No conversation matches that.' : 'No conversations yet.'}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                {/* px-3 = the rows' own padding, so label, row text and the search field all
                    start on one text column. */}
                <h3 className="mb-2 px-3 text-xs text-muted-foreground">{group.label}</h3>
                <div className="space-y-0.5">
                  {group.items.map((c) => {
                    const active = c.slug === activeSlug
                    return (
                      /**
                       * Two lines, and the "…" sits ON the row rather than beside it.
                       *
                       * A one-line row of bare text said only the name — not when it was last
                       * worked on, not which one is open — and the menu button shared the
                       * row's width, so every title truncated 36px early even when nothing
                       * was hovered. Now the button owns the full row (`pe-10` keeps the text
                       * clear of the menu) and the second line carries the time, or
                       * "Answering…" while a reply is still being written.
                       */
                      <div key={c.slug} className="group relative">
                        {active && (
                          <span
                            className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary"
                            aria-hidden
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => onSelect(c.slug)}
                          title={c.preview || c.name}
                          className={cn(
                            'w-full min-w-0 rounded-xl px-3 py-2 pe-10 text-start transition-colors hover:bg-muted',
                            active && 'bg-muted',
                          )}
                        >
                          <div className="flex min-w-0 items-center gap-1.5">
                            {/* The star stays on the row itself, not only in the group header:
                                once a search filters the list the group is off screen, and
                                "why is this one first?" needs an answer on the row. */}
                            {c.pinned && (
                              <Star className="size-3 shrink-0 fill-amber-400 text-amber-500" />
                            )}
                            <span
                              className={cn(
                                'min-w-0 flex-1 truncate text-sm',
                                active && 'font-medium',
                              )}
                            >
                              {c.name}
                            </span>
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                            {/* Still generating — the answer keeps being written even when
                                you leave the page, so the rail has to say which one. */}
                            {c.running ? (
                              <>
                                <span className="qc-pulse size-1.5 shrink-0 rounded-full bg-emerald-500" />
                                <span className="truncate text-emerald-600 dark:text-emerald-400">
                                  Answering…
                                </span>
                              </>
                            ) : (
                              <time
                                dateTime={c.updatedAt}
                                title={new Date(c.updatedAt).toLocaleString()}
                                className="tabular-nums"
                              >
                                {railTime(c.updatedAt)}
                              </time>
                            )}
                          </div>
                        </button>
                        <div className="absolute right-0.5 top-1.5">
                          <RowMenu
                            pinned={!!c.pinned}
                            onPin={() => onPin(c.slug, !c.pinned)}
                            onRename={() => onRename(c.slug, c.name)}
                            onDelete={() => onDelete(c.slug)}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-2 border-t border-border/60 p-4">
          <Button onClick={onNew} className="w-full">
            <span className="text-base leading-none">+</span>
            New Chat
          </Button>
          {/* Second button rather than a mode you have to remember to set: "ask this one
              without saving it" is a decision made at the moment you start typing, and a
              toggle three controls away in the composer is one you find after the fact. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" onClick={onNewTemporary} className="w-full">
                <MessageSquareDashed className="size-4" />
                Temporary chat
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              A conversation that isn't saved to <code className="font-mono">testing/chats</code>{' '}
              and never appears in this list — for a throwaway question, or one you don't want
              committed with the project.
            </TooltipContent>
          </Tooltip>

          {/**
           * Shortcuts OUT of the rail, as one quiet row of icons.
           *
           * These four were full-width labelled rows above the primary buttons — but every one
           * of them is already in the app sidebar two inches to the left, so the rail was
           * spending its most valuable space (the bottom, next to the primary action) repeating
           * the nav and making New Chat compete with four look-alike links. Icons keep the
           * shortcut without the duplication reading as navigation.
           */}
          <div className="flex items-center gap-1 pt-1">
            {RAIL_LINKS.map((l) => (
              <Tooltip key={l.to}>
                <TooltipTrigger asChild>
                  <NavLink
                    to={l.to}
                    aria-label={l.label}
                    className="flex h-9 flex-1 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <l.icon className="size-4" />
                  </NavLink>
                </TooltipTrigger>
                <TooltipContent>{l.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------- transcript

/**
 * The reference's hero orb: a glassy sphere with a violet lobe at the top-left, a peach
 * one at the lower-right, a pale diagonal light sweep across the middle, a bright glass
 * rim and a few sparkles.
 *
 * The original is a Lottie animation — 150 KB of generated paths, and the template's own
 * artwork. This is the same composition rebuilt as ~2 KB of layered SVG gradients: no
 * animation runtime, nothing copied. Everything sits inside one clipped circle so the
 * blurred colour lobes still give a clean sphere edge for the rim to sit on.
 */
function HeroOrb() {
  return (
    // Mirrors the reference's `mask-b-from-100%`: the sphere fades out toward the
    // greeting instead of ending on a hard line.
    <div className="mx-auto -mt-4 hidden w-72 [mask-image:linear-gradient(to_bottom,#000_74%,transparent_100%)] md:block">
      {/* The reference's hero is a Lottie; this is the same reading done with the SVG we
          already draw — see the qc-orb-* keyframes in index.css for what moves and why. */}
      <svg viewBox="0 0 288 288" className="qc-orb-float w-full" aria-hidden="true">
        <defs>
          <radialGradient id="orb-base" cx="45%" cy="40%" r="62%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="55%" stopColor="#fbeef5" />
            <stop offset="100%" stopColor="#f1dcea" />
          </radialGradient>
          <radialGradient id="orb-violet" cx="27%" cy="20%" r="56%">
            <stop offset="0%" stopColor="#b478d8" stopOpacity="0.82" />
            <stop offset="55%" stopColor="#cfa6ea" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#c79ae8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-peach" cx="81%" cy="66%" r="60%">
            <stop offset="0%" stopColor="#f78f55" stopOpacity="0.92" />
            <stop offset="52%" stopColor="#f9b184" stopOpacity="0.46" />
            <stop offset="100%" stopColor="#f9b184" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-pale" cx="64%" cy="24%" r="40%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-crescent" cx="22%" cy="84%" r="42%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          {/* Soft-edged white, for the two swirl bands. */}
          <radialGradient id="orb-sweep" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.88" />
            <stop offset="60%" stopColor="#ffffff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          {/* The violet comma that curls along the top-left inner wall. */}
          <radialGradient id="orb-swirl" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#a855dd" stopOpacity="0.62" />
            <stop offset="60%" stopColor="#bb82e2" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#bb82e2" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="orb-halo" cx="50%" cy="50%" r="50%">
            <stop offset="70%" stopColor="#f6e7f2" stopOpacity="0" />
            <stop offset="88%" stopColor="#f3e2f0" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#f3e2f0" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="orb-rim" x1="16%" y1="6%" x2="84%" y2="96%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
            <stop offset="42%" stopColor="#ffffff" stopOpacity="0.16" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.75" />
          </linearGradient>
          <clipPath id="orb-clip">
            <circle cx="144" cy="146" r="84" />
          </clipPath>
          <filter id="orb-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="10" />
          </filter>
        </defs>

        {/* Outer halo, so the sphere sits in light rather than on a flat page. */}
        <circle cx="144" cy="146" r="99" fill="url(#orb-halo)" />

        <g clipPath="url(#orb-clip)">
          <circle cx="144" cy="146" r="84" fill="url(#orb-base)" />
          {/* The colour is layered as lobes, then two bands sweep across them — that
              overlap is what reads as liquid swirling inside the glass rather than a
              plain gradient. Order matters: bands must land ON TOP of the lobes. */}
          <g filter="url(#orb-soft)">
            {/* Each drifting layer is WRAPPED in its own <g>: a CSS transform on an element
                that already carries a `transform=` attribute replaces it, which would flatten
                the bands' rotations. */}
            <g className="qc-orb-lobe-a">
              <circle cx="144" cy="146" r="84" fill="url(#orb-violet)" />
            </g>
            <g className="qc-orb-lobe-b">
              <circle cx="144" cy="146" r="84" fill="url(#orb-peach)" />
            </g>
            <circle cx="144" cy="146" r="84" fill="url(#orb-pale)" />
            <circle cx="144" cy="146" r="84" fill="url(#orb-crescent)" />
            <g className="qc-orb-swirl">
              {/* Violet comma curling from the left wall along the top. */}
              <ellipse cx="130" cy="98" rx="62" ry="26" fill="url(#orb-swirl)" transform="rotate(-16 130 98)" />
              {/* The pale band cutting diagonally across the middle, which carves the
                  violet above it into that comma and separates it from the peach. */}
              <ellipse cx="150" cy="152" rx="94" ry="27" fill="url(#orb-sweep)" transform="rotate(-22 150 152)" />
              {/* The second, lower band curving along the bottom-left inner wall. */}
              <ellipse cx="128" cy="206" rx="80" ry="22" fill="url(#orb-sweep)" transform="rotate(-13 128 206)" />
              {/* Pale crescent hugging the left wall, so the violet reads as floating
                  INSIDE the glass instead of being painted onto the rim. */}
              <ellipse cx="74" cy="158" rx="17" ry="56" fill="url(#orb-sweep)" transform="rotate(9 74 158)" />
            </g>
          </g>
        </g>

        {/* Glass rim — brightest top-left and bottom-right, nearly gone in between. */}
        <circle cx="144" cy="146" r="83.4" fill="none" stroke="url(#orb-rim)" strokeWidth="1.4" />

        {/* Sparkles, each on its own phase — in step they'd blink like an indicator. */}
        <circle className="qc-orb-spark" cx="151" cy="119" r="1.5" fill="#fcd34d" />
        <circle
          className="qc-orb-spark"
          style={{ animationDelay: '1.1s' }}
          cx="167"
          cy="171"
          r="1.5"
          fill="#fcd34d"
        />
        <circle
          className="qc-orb-spark"
          style={{ animationDelay: '2.3s' }}
          cx="136"
          cy="153"
          r="1"
          fill="#e879f9"
        />
        <circle
          className="qc-orb-spark"
          style={{ animationDelay: '0.6s' }}
          cx="159"
          cy="147"
          r="0.9"
          fill="#d8b4fe"
        />
      </svg>
    </div>
  )
}

/**
 * The clock on a message: the time of day it was sent, plus the day when that isn't today.
 * A transcript you come back to needs to say WHEN — "did I ask this before or after the
 * deploy?" is a question the bubble alone can't answer. Full date/time goes in the title.
 */
function messageTime(iso: string): { short: string; full: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  return {
    short: sameDay ? time : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`,
    full: d.toLocaleString(),
  }
}

/** The muted time stamp under a bubble. */
function MessageTime({ at, className }: { at?: string; className?: string }) {
  const t = at ? messageTime(at) : null
  if (!t) return null
  return (
    <time dateTime={at} title={t.full} className={cn('text-[11px] tabular-nums text-muted-foreground', className)}>
      {t.short}
    </time>
  )
}

/**
 * What the turn is doing right now, named after its most recent tool call. A bare
 * "Thinking…" for 40 seconds while the model reads twelve files is the part that reads as
 * hung; "Reading the project" is the same wait with the reason attached.
 */
function describeTool(name: string): { label: string; verb: string; Icon: LucideIcon } {
  if (name === 'Read' || name === 'NotebookRead')
    return { label: 'Reading the project', verb: 'Read', Icon: FileText }
  if (name === 'Grep' || name === 'Glob')
    return { label: 'Searching the project', verb: 'Searched for', Icon: Search }
  if (name === 'Bash') return { label: 'Running a command', verb: 'Ran', Icon: TerminalSquare }
  if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit')
    return { label: 'Editing files', verb: 'Edited', Icon: PenLine }
  // Split, because with the Web search / Deep research actions these are most of the wait:
  // "Searching the web · playwright trace viewer" then "Reading a page · playwright.dev".
  if (name === 'WebSearch')
    return { label: 'Searching the web', verb: 'Searched the web for', Icon: Globe }
  if (name === 'WebFetch') return { label: 'Reading a page', verb: 'Opened', Icon: Globe }
  if (name === 'TodoWrite') return { label: 'Planning', verb: 'Planned', Icon: ListTodo }
  if (name.startsWith('mcp__')) {
    // mcp__playwright__browser_click → "playwright · browser click"
    const [, server, ...rest] = name.split('__')
    return {
      label: 'Using an MCP tool',
      verb: `${server ?? 'MCP'} ${rest.join(' ').replace(/_/g, ' ')}`.trim(),
      Icon: Blocks,
    }
  }
  return { label: `Using ${name}`, verb: name, Icon: Wrench }
}

function phaseOf(tools: string[]): { label: string; Icon: LucideIcon } {
  const last = tools[tools.length - 1]
  if (!last) return { label: 'Thinking', Icon: Sparkles }
  const { label, Icon } = describeTool(last)
  return { label, Icon }
}

/**
 * The turn's tool calls, collapsed for display: consecutive calls to the same tool with the
 * same target become one row with a count, so twelve reads of one file don't fill the bubble.
 * Distinct targets stay distinct — the target IS the information here.
 */
function stepsFrom(calls: ChatToolCall[]): { name: string; detail?: string; n: number }[] {
  const out: { name: string; detail?: string; n: number }[] = []
  for (const c of calls) {
    const last = out[out.length - 1]
    if (last && last.name === c.name && last.detail === c.detail) last.n += 1
    else out.push({ name: c.name, detail: c.detail, n: 1 })
  }
  return out
}

/** How many steps stay on screen; the rest are summarised as "+N earlier steps". */
const MAX_VISIBLE_STEPS = 4

/**
 * The live activity list: what the turn has actually DONE while the engineer waits.
 *
 * A 40-second wait under one unchanging word reads as hung. Naming each call as it lands —
 * `Read · ChatPage.tsx`, `Searched for · phaseOf`, `Ran · npm run build` — makes the same
 * wait legible, and it's the honest answer to "is it stuck or is it working?".
 */
function ActivitySteps({ calls, active }: { calls: ChatToolCall[]; active: boolean }) {
  const steps = stepsFrom(calls)
  if (!steps.length) return null
  const hidden = Math.max(0, steps.length - MAX_VISIBLE_STEPS)
  const shown = steps.slice(-MAX_VISIBLE_STEPS)
  return (
    <ol className="space-y-1.5 text-xs" aria-label="What this turn has done so far">
      {hidden > 0 && (
        <li className="ps-0.5 text-[11px] text-muted-foreground/70">
          +{hidden} earlier step{hidden > 1 ? 's' : ''}
        </li>
      )}
      {shown.map((s, i) => {
        // Only the newest call can still be running — and only while nothing has come back
        // yet. Everything above it has, by definition, already returned.
        const running = active && i === shown.length - 1
        const { verb, Icon } = describeTool(s.name)
        return (
          <li
            key={`${s.name}-${s.detail ?? ''}-${i}`}
            className={cn(
              'flex min-w-0 items-center gap-2',
              running ? 'text-foreground/80' : 'text-muted-foreground',
            )}
          >
            {running ? (
              <Icon className="size-3.5 shrink-0" />
            ) : (
              <Check className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-500" />
            )}
            <span className="shrink-0">{verb}</span>
            {s.detail && (
              <span className="min-w-0 truncate font-mono text-[11px] opacity-80" title={s.detail}>
                {s.detail}
              </span>
            )}
            {s.n > 1 && <span className="shrink-0 tabular-nums opacity-60">×{s.n}</span>}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The waiting state: three drifting dots, what it's doing, how long it's been, and
 * skeleton lines standing in for the answer.
 *
 * It replaced a spinner beside the word "Thinking…" — and a second spinner above it, since
 * the tool trail drew its own. Two spinners stacked in an empty bubble was the ugly part;
 * one calm indicator that says what's happening is the fix.
 */
function ThinkingBubble({
  calls,
  compact,
  startedAt,
}: {
  /** Tool calls so far, newest last — the header names the latest, the list shows them all. */
  calls: ChatToolCall[]
  compact?: boolean
  /** When the turn was sent (ISO). The elapsed reading is derived from it. */
  startedAt?: string
}) {
  // Elapsed is measured against that START TIME, not by counting ticks: a background tab
  // has its timers throttled hard, so a tick counter reported 10s for a 35s wait —
  // verified. The first reading lands a second in, which is fine: it's hidden until 3s.
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const start = startedAt ? Date.parse(startedAt) : NaN
    if (Number.isNaN(start)) return
    const id = window.setInterval(() => setSeconds(Math.round((Date.now() - start) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [startedAt])

  // `compact` means text is already on screen, so "Thinking" is no longer true — it's
  // writing. A tool call still wins, since that's the more specific thing it's doing.
  const tools = calls.map((c) => c.name)
  const { label, Icon } =
    compact && !tools.length ? { label: 'Writing the answer', Icon: PenLine } : phaseOf(tools)

  return (
    <div className={cn('space-y-3.5', compact && 'mt-3')} role="status" aria-live="polite">
      <div className="flex items-center gap-2.5">
        {/* The phase icon, with a gradient arc orbiting its border. It names what's
            happening AND animates, which is the job the two stacked spinners used to do
            badly. The icon swaps as the turn moves from thinking → reading → answering,
            so the wait visibly progresses instead of just elapsing. */}
        <span
          className="qc-orbit relative flex size-7 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60"
          aria-hidden
        >
          <Icon className="size-3.5 text-foreground/70" />
        </span>
        <span className="qc-text-shimmer text-sm font-medium">{label}</span>
        {/* Only past a few seconds: a timer on a fast answer is noise, but on a slow one
            it's the difference between "working" and "stuck". */}
        {seconds >= 3 && (
          <span className="rounded-full border border-border/60 px-1.5 py-0.5 font-mono text-[10px] leading-none tabular-nums text-muted-foreground">
            {seconds}s
          </span>
        )}
      </div>
      {/* What it has done so far. Only while there's no answer yet: once text is on screen
          the wait is over, and the finished message draws the trail above itself. */}
      {!compact && <ActivitySteps calls={calls} active />}
      {/* Skeleton answer — the shape of what's coming, so the bubble isn't an empty box.
          Dropped once real text is on screen: the answer itself is the better skeleton.
          Fixed widths, not percentages: the bubble is fit-content, where a % width has
          nothing stable to resolve against. */}
      {!compact && (
        <div className="space-y-2.5" aria-hidden>
          {['22rem', '18rem', '12rem'].map((w, i) => (
            <div
              key={w}
              className="qc-skeleton h-2.5 max-w-full rounded-full"
              style={{ width: w, animationDelay: `${i * 0.16}s` }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** The tool calls a turn made — "what did it actually look at?". */
function ToolTrail({ tools }: { tools: string[] }) {
  if (!tools.length) return null
  // Collapse runs of the same tool ("Read Read Read" → "Read ×3"), so a turn that read
  // twenty files doesn't push the answer off the screen.
  const runs: { name: string; n: number }[] = []
  for (const t of tools) {
    const last = runs[runs.length - 1]
    if (last && last.name === t) last.n += 1
    else runs.push({ name: t, n: 1 })
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {runs.slice(-12).map((r, i) => (
        <span
          key={`${r.name}-${i}`}
          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
        >
          <Wrench className="size-3" />
          {r.name}
          {r.n > 1 && <span className="tabular-nums opacity-70">×{r.n}</span>}
        </span>
      ))}
    </div>
  )
}

// ------------------------------------------------------------- smooth streaming

/**
 * Nudge a reveal position off a spot that would look broken.
 *
 * Markdown syntax only means anything once it's complete: stopping between the two stars
 * of `**bold**` paints a literal `**` for a frame, and stopping inside a fence marker
 * flashes the raw backticks. Both read as the text glitching. So the cursor walks forward
 * over any run of markdown punctuation instead of resting inside it.
 */
function safeRevealPoint(text: string, idx: number): number {
  let i = Math.min(idx, text.length)
  while (i < text.length && /[*_~`[\]()#>|\\]/.test(text[i])) i++
  return i
}

/**
 * How much of `full` to show right now, so an answer TYPES OUT instead of appearing in
 * blocks.
 *
 * The CLI doesn't stream a character at a time — a 12.7 KB answer arrived as 116 frames of
 * ~110 characters each (measured), so painting each frame as it lands makes the text jump
 * in paragraph-sized steps about five times a second. This drains whatever has arrived at
 * a steady per-frame rate instead: the reveal is always chasing the real text and always
 * catching up within ~200 ms, so it feels continuous without ever falling behind the model.
 *
 * The rate is proportional to the backlog, which is what keeps it honest — a fast burst is
 * revealed fast, and the animation can't lag into the next turn.
 */
function useSmoothReveal(full: string, enabled: boolean): string {
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (!enabled) return
    // Someone who asked for less motion wants the text, not the typing.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const id = requestAnimationFrame(() => setShown(full.length))
      return () => cancelAnimationFrame(id)
    }
    let raf = 0
    const step = () => {
      setShown((s) => {
        if (s >= full.length) return s // caught up: same value, so React bails out
        const backlog = full.length - s
        // ~12 frames to drain, floored so a trickle still moves visibly.
        return safeRevealPoint(full, s + Math.max(2, Math.ceil(backlog / 12)))
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [full, enabled])

  // Not streaming (a saved message, or the reveal has caught up) → the text itself.
  if (!enabled) return full
  return full.slice(0, Math.min(shown, full.length))
}

/**
 * Who said it. The assistant wears the portal's solid high-contrast mark (same vocabulary as
 * the sidebar logo); "Me" is a quiet outlined chip, so the eye still lands on the answer
 * rather than on the engineer's own message.
 *
 * `aria-hidden`, because `RowName` beside it says the same thing in text — labelling both
 * makes a screen reader announce every turn's speaker twice.
 */
function RowAvatar({ who }: { who: 'user' | 'assistant' }) {
  const assistant = who === 'assistant'
  return (
    <div
      aria-hidden
      className={cn(
        // No top margin: it lines up with the NAME line, Slack-style, so the mark and the
        // word it stands for read as one unit.
        'flex size-8 shrink-0 select-none items-center justify-center rounded-xl border',
        assistant
          ? 'border-transparent bg-foreground text-background'
          : 'border-border/60 bg-muted/60 text-foreground/70',
      )}
    >
      {assistant ? <Sparkles className="size-4" /> : <User className="size-4" />}
    </div>
  )
}

/** The speaker's name over the bubble. Paired with the avatar, never instead of it. */
function RowName({ who, className }: { who: 'user' | 'assistant'; className?: string }) {
  return (
    <div className={cn('mb-1 text-xs font-medium text-foreground/70', className)}>
      {who === 'assistant' ? 'AI Assistant' : 'Me'}
    </div>
  )
}

/**
 * `images` are the ones that came with a SAVED message (file names served back by the
 * server); `previews` are data URLs for the turn still in flight, which isn't on disk yet.
 * Either way the engineer sees what they attached, so a follow-up ("the second one")
 * refers to something still on screen.
 */
function UserRow({
  text,
  images,
  previews,
  projectId,
  at,
  action,
}: {
  text: string
  images?: string[]
  previews?: string[]
  projectId?: string
  at?: string
  /** The `+` menu action this message ran with — shown, because it changes the answer. */
  action?: ChatAction | null
}) {
  const meta = action ? actionMeta(action) : null
  const srcs = previews ?? (images && projectId ? images.map((n) => chatImageUrl(projectId, n)) : [])
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-[85%] flex-1 justify-end text-end sm:max-w-[75%]">
        <RowName who="user" className="pe-1" />
        {meta && (
          <div className="mb-1.5 flex justify-end">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
              <meta.icon className={cn('size-3', meta.tone)} />
              {meta.label}
            </span>
          </div>
        )}
        {srcs.length > 0 && (
          <div className="mb-2 flex flex-wrap justify-end gap-2">
            {srcs.map((src, i) => (
              <a key={src} href={src} target="_blank" rel="noreferrer">
                <img
                  src={src}
                  alt={`Attached image ${i + 1}`}
                  className="max-h-40 rounded-lg border object-contain"
                />
              </a>
            ))}
          </div>
        )}
        <div className="inline-flex whitespace-pre-wrap break-words rounded-lg bg-primary p-4 text-start text-sm text-primary-foreground">
          {text}
        </div>
        <MessageTime at={at} className="mt-1 block pe-1" />
      </div>
      <RowAvatar who="user" />
    </div>
  )
}

/**
 * Hide the trailing `<!-- SUGGESTIONS: … -->` marker WHILE STREAMING.
 *
 * The server strips it before saving (routes/chat.ts `splitSuggestions`), but the deltas
 * that carry it reach the browser first — so without this the last thing the engineer
 * watches type out is an HTML comment. The half-written case matters just as much: a bare
 * `<!--` arrives frames before the rest, so an unterminated comment tail is cut too.
 */
function stripSuggestMarker(text: string): string {
  const cut = text.replace(/<!--\s*SUGGESTIONS:[\s\S]*?-->/gi, '')
  const open = cut.lastIndexOf('<!--')
  return (open >= 0 && !cut.slice(open).includes('-->') ? cut.slice(0, open) : cut).trimEnd()
}

/**
 * The model's proposed next messages, offered as one-click chips under the newest answer —
 * the Prototype page's "Make it better" row, for a conversation.
 *
 * Rendered OUTSIDE `Turn` on purpose. Hanging it off the last message would give that
 * memoised row a prop that changes as the conversation moves, and re-rendering a finished
 * turn means re-parsing its markdown (see Turn's note). This way the transcript is
 * untouched and only these three buttons re-render.
 *
 * A click SENDS. Unlike the empty-state quick prompts — which are half-written and need a
 * real ticket id typed in — a follow-up is a complete question, so making it a two-step
 * (fill, then Enter) is friction for nothing.
 */
const FollowUps = memo(function FollowUps({
  items,
  onPick,
}: {
  items: string[]
  onPick: (text: string) => void
}) {
  if (!items.length) return null
  return (
    <div className="flex w-full flex-wrap items-center gap-2 px-1">
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        Ask next
      </span>
      {items.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onPick(s)}
          title={s}
          className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full border border-border/60 bg-card px-3 py-1.5 text-xs text-foreground/80 transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-accent hover:text-accent-foreground hover:shadow-sm active:scale-[0.98]"
        >
          {s}
          <ArrowUp className="size-3 shrink-0 rotate-45 opacity-60" />
        </button>
      ))}
    </div>
  )
})

function AssistantRow({
  text,
  tools,
  calls,
  streaming,
  failed,
  at,
  model,
}: {
  text: string
  /** A saved turn's tool names — the trail above the answer. */
  tools?: string[]
  /** The in-flight turn's calls, with targets. Live only; never persisted. */
  calls?: ChatToolCall[]
  streaming?: boolean
  failed?: boolean
  at?: string
  model?: string
}) {
  // While streaming, what's on screen trails the received text by a few frames on purpose
  // (see useSmoothReveal). A saved message renders whole — and was already stripped of the
  // suggestions marker server-side, so it costs nothing there.
  const visible = useSmoothReveal(streaming ? stripSuggestMarker(text) : text, !!streaming)
  return (
    <div className="group flex justify-start gap-3">
      <RowAvatar who="assistant" />
      <div className="max-w-[85%] flex-1 sm:max-w-[75%]">
        <RowName who="assistant" className="ps-1" />
        <div className="space-y-2">
          <div
            className={cn(
              // w-fit so the bubble hugs its content: on a wide screen the column is ~1300px,
              // and a one-line answer stretched across 75% of that read as a layout bug.
              'w-fit min-w-0 max-w-full rounded-lg border p-4',
              failed ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-muted text-foreground',
            )}
          >
            {/* Not while streaming: the waiting indicator below already lists the same
                calls, with their targets and in the order they ran. */}
            {!streaming && <ToolTrail tools={tools ?? []} />}
            {/* Keyed, and the indicator stays MOUNTED once text starts arriving — it just
                goes compact and moves below the answer. Remounting it there would restart
                its elapsed timer from zero mid-answer. */}
            {visible && (
              <div key="answer" className={MD_CLASS}>
                {/* The caret is a CHARACTER appended to the text, not an element beside the
                    markdown: markdown renders blocks, so a sibling <span> would sit on its
                    own line under the answer instead of at the end of the last one. */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={streaming ? MD_COMPONENTS_STREAMING : MD_COMPONENTS}
                >
                  {streaming ? `${visible}▊` : visible}
                </ReactMarkdown>
              </div>
            )}
            {(streaming || !visible) && (
              <ThinkingBubble key="waiting" calls={calls ?? []} compact={!!visible} startedAt={at} />
            )}
          </div>
          {!streaming && text && (
            <div className="flex items-center gap-0 text-muted-foreground opacity-100 transition-opacity duration-150">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText(text).then((ok) =>
                        ok ? toast.success('Answer copied') : toast.error('Could not copy'),
                      )
                    }
                    className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <Copy className="size-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Copy this answer</TooltipContent>
              </Tooltip>
              <MessageTime at={at} />
              {model && (
                <>
                  <span className="px-1.5 text-[11px] text-muted-foreground">•</span>
                  <span className="text-[11px] text-muted-foreground">{model}</span>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * MEMOISED, and it has to stay that way.
 *
 * `input` lives on the workspace that renders this list, so every keystroke re-renders it —
 * and re-rendering a finished turn means react-markdown re-parsing its whole answer. Measured
 * before this: 33 ms per keystroke on an empty chat, 100 ms with one long answer on screen,
 * and **567 ms** in a 60-message conversation, i.e. typing became unusable in exactly the
 * conversations worth keeping. A saved message never changes, so it re-renders for nothing.
 */
const Turn = memo(function Turn({ m, projectId }: { m: ChatMessage; projectId: string }) {
  return m.role === 'user' ? (
    <UserRow text={m.text} images={m.images} projectId={projectId} at={m.at} action={m.action} />
  ) : (
    <AssistantRow text={m.text} tools={m.tools} failed={m.error} at={m.at} model={m.model} />
  )
})

// ------------------------------------------------------------------ chat header

/** The transcript as a portable markdown file — client-side only, no route (cf. Prototype's
 *  `downloadHtml`). Speaker + time per turn, so a pasted answer keeps its provenance. */
function downloadTranscript(name: string, messages: ChatMessage[]) {
  const body = messages
    .map((m) => {
      const who = m.role === 'user' ? 'Me' : 'AI Assistant'
      const when = m.at ? ` — ${new Date(m.at).toLocaleString()}` : ''
      return `## ${who}${when}\n\n${m.text}`
    })
    .join('\n\n---\n\n')
  const md = `# ${name}\n\n${body}\n`
  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'chat'}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * The bar above the transcript.
 *
 * Two problems it exists for. (1) The notification bell is `fixed right-6 top-5`, so with the
 * page padding gone it floated straight over the transcript with no surface under it — hence
 * `pe-16`, which keeps the header's own controls clear of it. (2) Nothing on screen said which
 * conversation was open, whether this turn can WRITE to the repo, or how to rename/export/delete
 * it without going back to the rail.
 *
 * The tool-mode pill is deliberately read-ONLY here: the composer owns that toggle (making
 * `full` an explicit, per-message choice), and a second control for it would let the two
 * disagree on screen.
 */
function ChatHeader({
  name,
  streaming,
  tools,
  temporary,
  onPin,
  onRename,
  onDelete,
  onExport,
  pinned,
}: {
  name: string | null
  streaming: boolean
  tools: ChatTools
  temporary: boolean
  pinned: boolean
  onPin?: () => void
  onRename?: () => void
  onDelete?: () => void
  onExport?: () => void
}) {
  const live = !!onRename // a conversation exists (the new-chat screen has nothing to act on)
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 pe-14">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-sm font-medium">{name ?? 'New chat'}</span>
        {temporary && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-600 dark:text-violet-400">
            <MessageSquareDashed className="size-3" />
            Temporary
          </span>
        )}
        {streaming && (
          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
            Answering…
          </span>
        )}
      </div>

      <span
        title={
          tools === 'full'
            ? 'This conversation can write files and use the project’s MCP servers'
            : 'Read-only tools — the project can’t be modified'
        }
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
          tools === 'full'
            ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
            : 'border-border/60 bg-muted/60 text-muted-foreground',
        )}
      >
        <ShieldCheck className="size-3" />
        {tools === 'full' ? 'Full access' : 'Read-only'}
      </span>

      {live && (
        <>
          {/* Starring is the one action worth a click of its own — it's how a conversation
              stays at the top of the rail. `temporary` refuses it server-side. */}
          {!temporary && (
            <button
              type="button"
              onClick={onPin}
              aria-label={pinned ? 'Unstar this conversation' : 'Star this conversation'}
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <Star className={cn('size-4', pinned && 'fill-amber-400 text-amber-500')} />
            </button>
          )}
          <RowMenu
            always
            pinned={pinned}
            onPin={() => onPin?.()}
            onRename={() => onRename?.()}
            onDelete={() => onDelete?.()}
            onExport={onExport}
          />
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------- the page

/**
 * Every conversation belongs to ONE project, so this is mounted with `key={projectId}`
 * below — switching project gives a clean slate (no open chat, no half-streamed turn)
 * without resetting state from an effect. Same pattern as TerminalPage's workspace.
 */
function ChatWorkspace({
  projectId,
  projectName,
  projectPath,
}: {
  projectId: string
  projectName: string | null
  projectPath: string | null
}) {
  const queryClient = useQueryClient()

  /**
   * Which conversation this TAB has open temporarily.
   *
   * A temporary chat is invisible to the rail by design, so nothing on the server can point
   * the page back at it after a reload — and the turn in flight keeps being written either
   * way. So the SLUG (never a word of the conversation) is remembered per tab in
   * sessionStorage: reloading mid-answer re-attaches like any other chat, closing the tab
   * forgets it, and the server drops it on its own after that.
   */
  const tempStoreKey = `qc.chatTemp.${projectId}`
  const [restoredTemp] = useState(() => sessionStorage.getItem(tempStoreKey))
  const rememberTemp = useCallback(
    (slug: string | null) => {
      if (slug) sessionStorage.setItem(tempStoreKey, slug)
      else sessionStorage.removeItem(tempStoreKey)
    },
    [tempStoreKey],
  )

  // undefined = "nothing picked yet this mount"; null = the engineer asked for a NEW chat.
  // The difference is what lets a reload land back on a conversation still being answered
  // (see `slug` below) without also fighting the New Chat button.
  const [picked, setPicked] = useState<string | null | undefined>(restoredTemp ?? undefined)
  /**
   * "The NEXT new conversation is temporary." Once one exists, the conversation's own flag
   * wins (see `isTemporary`) — a chat can't switch halfway, or half of it would be on disk.
   * Restored from the tab: if a temporary chat was open, that's still the mode.
   */
  const [temporary, setTemporary] = useState(!!restoredTemp)
  const [input, setInput] = useState('')
  const [model, setModel] = useState<string>(() => localStorage.getItem(MODEL_KEY) || 'sonnet')
  const [tools, setTools] = useState<ChatTools>(() =>
    localStorage.getItem(TOOLS_KEY) === 'full' ? 'full' : 'read',
  )
  /** Files attached to the NEXT message — converted to markdown here in the browser. */
  const [attached, setAttached] = useState<{ name: string; markdown: string }[]>([])
  /** Images pasted/dropped/picked for the NEXT message (see StagedImage). */
  const [images, setImages] = useState<StagedImage[]>([])
  /** `@`-tagged tickets/test cases staged for the next message (see StagedMention). */
  const [mentions, setMentions] = useState<StagedMention[]>([])
  /**
   * The `+` menu action armed for the NEXT message (web search / deep research / diagram),
   * or null for an ordinary turn. Per message on purpose — it's cleared on send, so the
   * follow-up after a web answer goes back to reading the project unless you ask again.
   */
  const [action, setAction] = useState<ChatAction | null>(null)
  /** The `@…` being typed right now (where it starts, the caret, what's typed) — or null. */
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [converting, setConverting] = useState(false)
  // The turn in flight: what was asked, what has streamed back, which tools ran.
  const [pending, setPending] = useState<{
    prompt: string
    answer: string
    /** Tool calls so far, with their targets — live only, not part of the saved message. */
    tools: ChatToolCall[]
    /** Data-URL previews of images sent with this turn (they aren't on disk yet). */
    images: string[]
    /** The `+` menu action it was sent with, so the streaming row is badged like a saved one. */
    action?: ChatAction | null
    /** File names instead — a RE-ATTACHED turn's images are already written to disk. */
    imageFiles?: string[]
    /** When it was sent — the saved message gets its `at` from the server, this is the
     *  same stamp for the row that's still streaming, so the time doesn't pop in late. */
    at: string
  } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** The conversation the rename / delete dialog is about, or null when closed. */
  const [renaming, setRenaming] = useState<{ slug: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<{ slug: string; name: string } | null>(null)
  /** Which quick-prompt category is expanded into its four suggestions, if any. */
  const [openCategory, setOpenCategory] = useState<(typeof QUICK)[number] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const quickRef = useRef<HTMLDivElement | null>(null)
  // The file picker moved into the `+` menu, so it's opened programmatically now rather than
  // by a <label> wrapping the input.
  const fileRef = useRef<HTMLInputElement | null>(null)
  /**
   * The composer well, as STATE rather than a ref: the `+` menu is portaled into it, so the
   * element has to be a render input (a ref wouldn't re-render the menu once it's attached).
   * Set from the ref callback — not an effect.
   */
  const [wellEl, setWellEl] = useState<HTMLDivElement | null>(null)

  // Expanding a category REPLACES the chips, so without this there'd be no way back to
  // pick a different one — the reference has that dead end; don't inherit it. Escape or
  // a click anywhere outside restores the chips, with no extra control on screen.
  useEffect(() => {
    if (!openCategory) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenCategory(null)
    }
    const onDown = (e: MouseEvent) => {
      if (!quickRef.current?.contains(e.target as Node)) setOpenCategory(null)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [openCategory])

  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model)
  }, [model])
  useEffect(() => {
    localStorage.setItem(TOOLS_KEY, tools)
  }, [tools])

  // Leaving the page only stops WATCHING: the turn is registered server-side and runs to
  // completion, so coming back re-attaches (or finds the finished answer) instead of
  // losing the question. Cancelling for real is the Stop button — see `stop` below.
  useEffect(() => () => abortRef.current?.abort(), [])

  const { data: railData } = useQuery({
    queryKey: ['chats', projectId],
    queryFn: () => listChats(projectId),
    enabled: !!projectId,
    // Only while an answer is being written somewhere: the rail's "still answering" dot
    // has to go out on its own, and nothing else tells this page when another
    // conversation's turn finished. Idle, it doesn't poll at all.
    refetchInterval: (q) => (q.state.data?.chats.some((c) => c.running) ? 4000 : false),
  })
  const chats = railData?.chats ?? []

  /**
   * The conversation on screen. Nothing picked yet (a fresh mount, i.e. a reload) falls
   * back to whichever conversation is still being ANSWERED — the turn kept running while
   * the page was gone, and the page always starts on the new-chat screen, so otherwise it
   * would finish unseen and the engineer would have to guess which rail row to click.
   * Derived rather than assigned in an effect (this page bans setState-in-effect).
   */
  const slug = picked === undefined ? (chats.find((c) => c.running)?.slug ?? null) : picked

  const { data: chat, isError: chatMissing } = useQuery({
    queryKey: ['chat', projectId, slug],
    queryFn: () => getChat(projectId, slug as string),
    enabled: !!projectId && !!slug,
    // A conversation can genuinely be gone by the time we ask for it — a temporary one the
    // server has since dropped (restart, TTL), or one deleted in another window. Retrying
    // that 404 three times only delays the page falling back to the new-chat screen.
    retry: false,
  })

  /**
   * The conversation actually open. A slug the server no longer has counts as none: the
   * page must land on the new-chat screen and a message must not be sent into a 404.
   */
  const openSlug = chatMissing ? null : slug
  /**
   * Is what's on screen a temporary conversation? Once one exists its OWN flag decides —
   * the toggle only chooses what the next new chat will be. While the record is still
   * loading, a slug restored from this tab is known to be temporary, which keeps the notice
   * from blinking in a beat after the transcript.
   */
  const isTemporary = openSlug
    ? chat
      ? !!chat.temporary
      : openSlug === restoredTemp
    : temporary

  // Don't ask for it again after a reload: the server has dropped it, so the stored slug is
  // now just a way to land the page on an empty transcript. Storage only — no state here.
  useEffect(() => {
    if (chatMissing) rememberTemp(null)
  }, [chatMissing, rememberTemp])

  /**
   * Re-attach to a reply that was already being generated.
   *
   * The turn outlives the request that started it, so a reload / a trip to another page /
   * a closed tab leaves it running server-side. `chat.running` says so; this subscribes to
   * `GET /:slug/stream`, which replays the question and everything written so far and then
   * streams the rest — the engineer comes back to the answer still typing itself out.
   *
   * `attachedRef` guards against a second subscription for the same turn (the query
   * refetches while `running` stays true), and a live `abortRef` against attaching to the
   * turn THIS page just sent — that one already streams into the same state.
   */
  const attachedRef = useRef<string | null>(null)
  const running = chat?.running
  useEffect(() => {
    if (!projectId || !slug || !running) return
    const key = `${projectId}:${slug}`
    if (attachedRef.current === key || abortRef.current) return
    attachedRef.current = key
    const ac = new AbortController()
    abortRef.current = ac
    const clear = () => {
      if (abortRef.current === ac) abortRef.current = null
      attachedRef.current = null
    }
    void attachChat(
      projectId,
      slug,
      {
        onResume: ({ prompt, at, images: files }) => {
          // Pin the selection now that we're watching this one. Without it the page would
          // snap back to the new-chat screen the moment the turn finished, because the
          // slug was only being DERIVED from "which conversation is still running".
          setPicked(slug)
          setPending({ prompt, answer: '', tools: [], images: [], imageFiles: files, at })
        },
        onDelta: (t) => setPending((p) => (p ? { ...p, answer: p.answer + t } : p)),
        onTool: (call) => setPending((p) => (p ? { ...p, tools: [...p.tools, call] } : p)),
        onStopped: (saved) => {
          setPending(null)
          if (saved) queryClient.setQueryData(['chat', projectId, saved.slug], saved)
          void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
        },
        onDone: (saved) => {
          setPending(null)
          queryClient.setQueryData(['chat', projectId, saved.slug], saved)
          void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
        },
        onError: () => {
          setPending(null)
          void queryClient.invalidateQueries({ queryKey: ['chat', projectId, slug] })
        },
      },
      ac.signal,
    )
      .catch(() => setPending(null))
      .finally(clear)
    return () => {
      ac.abort()
      clear()
    }
  }, [projectId, slug, running, queryClient])

  // The `@` menu's source list. Fetched only once the engineer actually types `@` (it's a
  // disk scan of testing/tickets), then cached for the session by React Query.
  const { data: crawled, isFetching: crawledFetching } = useQuery({
    queryKey: ['crawled-tickets', projectId],
    queryFn: () => listCrawledTickets(projectId),
    enabled: !!projectId && mention !== null,
    staleTime: 60_000,
  })
  const mentionRows = useMemo(
    () => (mention ? mentionOptions(crawled ?? [], mention.query) : []),
    [crawled, mention],
  )

  const messages = chat?.messages ?? []
  const streaming = pending !== null
  const empty = !openSlug && !pending

  // Follow-ups belong to the NEWEST answer only — the ones from four turns ago are about a
  // question that's already been moved on from, and a strip after every turn would double
  // the length of the transcript.
  // Keyed off the QUERY's array, not the `?? []` fallback above, whose identity changes
  // every render — that would hand `FollowUps` a new array per keystroke and undo its memo.
  const saved = chat?.messages
  const followUps = useMemo(() => {
    if (streaming) return []
    const last = saved?.[saved.length - 1]
    return last?.role === 'assistant' && !last.error ? (last.suggestions ?? []) : []
  }, [saved, streaming])

  // Follow the answer as it streams — but only while the user is already at the bottom,
  // so scrolling up to re-read something isn't yanked back down mid-answer.
  useEffect(() => {
    const el = logRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [messages.length, pending?.answer, pending?.tools.length, slug, atBottom])

  // The text now reveals a few characters per FRAME, not once per delta, so pinning the
  // view on delta boundaries alone would let the newest line drift under the fold between
  // them. While a turn is streaming and the user is at the bottom, hold it there per frame.
  useEffect(() => {
    if (!streaming || !atBottom) return
    let raf = 0
    const pin = () => {
      const el = logRef.current
      if (el) el.scrollTop = el.scrollHeight
      raf = requestAnimationFrame(pin)
    }
    raf = requestAnimationFrame(pin)
    return () => cancelAnimationFrame(raf)
  }, [streaming, atBottom])

  const onScroll = useCallback(() => {
    const el = logRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }, [])

  /** Track (or close) the `@…` under the caret after any edit or cursor move. */
  const syncMention = useCallback((el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length
    const found = activeMention(el.value, caret)
    setMention(found ? { start: found.start, end: caret, query: found.query } : null)
    setMentionIndex(0)
  }, [])

  /** Replace the typed `@…` with the picked artifact's token and stage the reference. */
  const pickMention = useCallback(
    (opt: MentionOption) => {
      if (!mention) return
      const next = `${input.slice(0, mention.start)}${opt.token} ${input.slice(mention.end)}`.slice(
        0,
        MAX_PROMPT,
      )
      const caret = mention.start + opt.token.length + 1
      setInput(next)
      setMentions((prev) =>
        prev.some((m) => m.token === opt.token)
          ? prev
          : [...prev, { token: opt.token, kind: opt.kind, folder: opt.folder }],
      )
      setMention(null)
      // Put the caret after the token so typing continues where it looks like it should.
      requestAnimationFrame(() => {
        const el = taRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(caret, caret)
      })
    },
    [input, mention],
  )

  const send = useCallback(
    (text: string) => {
      const base = text.trim()
      // An image on its own is a real message ("what's wrong here?"), so images alone are
      // enough to send; the server supplies the wording when nothing was typed.
      if ((!base && !images.length) || streaming) return
      if (!projectId) {
        toast.error('Pick a project first', {
          description: 'Chat runs Claude inside the active project’s folder.',
        })
        return
      }
      // An attached document rides along in the prompt itself — it's already markdown,
      // and the server never sees the file.
      const prompt = (
        attached.length
          ? `${base}\n\n${attached
              .map((a) => `--- ATTACHED FILE: ${a.name} ---\n${a.markdown}`)
              .join('\n\n')}`
          : base
      ).slice(0, MAX_PROMPT)

      const sending = images
      // Only tags whose token is still in the message count. Deleting `@ABC-123` from the
      // text is how you take a tag back — there's no other affordance, and a reference the
      // engineer can't see but the model still reads would be a lie about what was asked.
      const tags: ChatMention[] = mentions
        .filter((m) => base.includes(m.token))
        .map((m) => ({ kind: m.kind, folder: m.folder }))
      const sendingAction = action
      setInput('')
      setAttached([])
      setImages([])
      setMentions([])
      setMention(null)
      setAction(null)
      setAtBottom(true)
      setPending({
        prompt: base || 'Take a look at the attached screenshot.',
        answer: '',
        tools: [],
        // Previews come from the data URLs already in memory — the files aren't on disk
        // (and so aren't servable) until the turn finishes.
        images: sending.map((i) => i.dataUrl),
        action: sendingAction,
        at: new Date().toISOString(),
      })
      const ac = new AbortController()
      abortRef.current = ac
      // The slug this turn belongs to: the open conversation, or whatever the server
      // names the new one (delivered in the `start` frame before any text).
      let targetSlug = openSlug
      void streamChat(
        projectId,
        {
          slug: openSlug ?? undefined,
          prompt,
          model,
          tools,
          // Only read when this creates a conversation; a follow-up inherits the one it's
          // sent into, so an existing chat can't be flipped by the toggle mid-thread.
          temporary: !openSlug && temporary ? true : undefined,
          action: sendingAction ?? undefined,
          images: sending.length ? sending.map((i) => ({ mime: i.mime, data: i.data })) : undefined,
          mentions: tags.length ? tags : undefined,
        },
        {
          onStart: (s) => {
            targetSlug = s
            setPicked(s)
            // Remember it for THIS TAB only, and only while it's temporary — it's the one
            // conversation the rail can't point back at after a reload.
            if (!openSlug && temporary) rememberTemp(s)
          },
          onDelta: (t) => setPending((p) => (p ? { ...p, answer: p.answer + t } : p)),
          onTool: (call) => setPending((p) => (p ? { ...p, tools: [...p.tools, call] } : p)),
          onStopped: (saved?: Chat) => {
            setPending(null)
            if (saved) queryClient.setQueryData(['chat', projectId, saved.slug], saved)
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
          onDone: (saved: Chat) => {
            setPending(null)
            // Seed the cache from the response so the finished turn appears without a
            // round trip (and the transcript doesn't blink empty in between).
            queryClient.setQueryData(['chat', projectId, saved.slug], saved)
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
          onError: (message) => {
            setPending(null)
            toast.error('The message failed', { description: message })
            void queryClient.invalidateQueries({ queryKey: ['chat', projectId, targetSlug] })
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
        },
        ac.signal,
      ).catch((err) => {
        // An abort is the Stop button, not a failure — the server still saves whatever
        // had been written, so refetch rather than reporting an error.
        setPending(null)
        if ((err as Error)?.name !== 'AbortError') {
          toast.error('The message failed', { description: (err as Error)?.message })
        }
        void queryClient.invalidateQueries({ queryKey: ['chat', projectId, targetSlug] })
        void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
      })
      .finally(() => {
        // Release the slot so the re-attach effect can take over a later turn.
        if (abortRef.current === ac) abortRef.current = null
      })
    },
    [
      projectId,
      openSlug,
      model,
      tools,
      temporary,
      action,
      streaming,
      attached,
      images,
      mentions,
      rememberTemp,
      queryClient,
    ],
  )

  /**
   * Cancel the reply in flight.
   *
   * Aborting the fetch is no longer enough — the turn runs server-side and survives a
   * closed tab on purpose — so Stop has to TELL the server. Whatever was written by then
   * is saved as a (failed) turn, which is why the transcript is refetched afterwards.
   */
  const stop = useCallback(() => {
    abortRef.current?.abort()
    setPending(null)
    if (!openSlug) return
    void stopChat(projectId, openSlug)
      .catch(() => {
        /* already finished — the transcript refresh below covers it */
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['chat', projectId, openSlug] })
        void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
      })
  }, [projectId, openSlug, queryClient])

  /**
   * Stage image files (paste, drop, or the file picker). Images can't go through
   * `docConvert` — there's no text in them — so they take this path instead and reach the
   * model as files the server writes and Claude Reads.
   */
  const addImages = useCallback(
    (files: File[]) => {
      if (!files.length) return
      const room = MAX_IMAGES - images.length
      if (room <= 0) {
        toast.error(`Up to ${MAX_IMAGES} images per message`)
        return
      }
      const rejected: string[] = []
      const take: File[] = []
      for (const f of files) {
        if (!IMAGE_MIMES.includes(f.type)) rejected.push(`${f.name || 'image'} (unsupported type)`)
        else if (f.size > MAX_IMAGE_BYTES) rejected.push(`${f.name || 'image'} (over 8 MB)`)
        else if (take.length < room) take.push(f)
        else rejected.push(`${f.name || 'image'} (over the ${MAX_IMAGES}-image limit)`)
      }
      if (rejected.length) {
        toast.error(`Could not attach ${rejected.length} image${rejected.length === 1 ? '' : 's'}`, {
          description: rejected.join(', '),
        })
      }
      // The reads are async; append as each lands rather than blocking the paste.
      for (const f of take) {
        void readImage(f)
          .then((img) => setImages((cur) => (cur.length >= MAX_IMAGES ? cur : [...cur, img])))
          .catch((err: Error) =>
            toast.error('Could not attach that image', { description: err.message }),
          )
      }
    },
    [images.length],
  )

  /** Cmd/Ctrl-V a screenshot straight into the composer. */
  const onPaste = useCallback(
    (e: ReactClipboardEvent) => {
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return // plain text paste — leave it to the textarea
      e.preventDefault()
      addImages(files)
    },
    [addImages],
  )

  /** Convert dropped/selected DOCUMENTS to markdown in the browser (same pipeline as Knowledge). */
  const attachDocs = useCallback(async (files: File[]) => {
    if (!files.length) return
    setConverting(true)
    const ok: { name: string; markdown: string }[] = []
    const failed: string[] = []
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        failed.push(`${file.name} (too large)`)
        continue
      }
      try {
        const doc = await convertFileToMarkdown(file)
        if (!doc.markdown.trim()) {
          failed.push(`${file.name} (no text found)`)
          continue
        }
        ok.push({ name: file.name, markdown: doc.markdown })
      } catch (err) {
        failed.push(`${file.name} (${(err as Error).message})`)
      }
    }
    setConverting(false)
    if (ok.length) setAttached((prev) => [...prev, ...ok])
    if (failed.length) {
      toast.error(`Could not attach ${failed.length} file${failed.length === 1 ? '' : 's'}`, {
        description: failed.join(', '),
      })
    }
  }, [])

  /**
   * One entry point for every way a file arrives (picker, drop): an image is staged as an
   * image, anything else is converted to text. Splitting here means the engineer never has
   * to know which kind of attachment the page wants.
   */
  const attachAny = useCallback(
    (files: File[]) => {
      const pics = files.filter((f) => f.type.startsWith('image/'))
      const docs = files.filter((f) => !f.type.startsWith('image/'))
      if (pics.length) addImages(pics)
      if (docs.length) void attachDocs(docs)
    },
    [addImages, attachDocs],
  )

  /** Dropping a screenshot onto the composer is the same gesture with a mouse. */
  const onDrop = useCallback(
    (e: ReactDragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      if (!files.length) return
      e.preventDefault()
      attachAny(files)
    },
    [attachAny],
  )

  /**
   * End a temporary conversation server-side.
   *
   * Leaving one behind isn't harmless-but-untidy: nothing in the UI can reach it again (it
   * was never in the rail, and the tab has stopped remembering it), so it would sit in the
   * server's memory — with the screenshots it wrote still on disk — until its TTL. So every
   * way OUT of a temporary chat goes through here.
   */
  const forgetTemporary = useCallback(
    (s: string | null) => {
      rememberTemp(null)
      if (!s) return
      void deleteChat(projectId, s)
        .catch(() => {
          /* already gone (restart, TTL) — it's ended either way */
        })
        .finally(() => queryClient.removeQueries({ queryKey: ['chat', projectId, s] }))
    },
    [projectId, queryClient, rememberTemp],
  )

  /**
   * Start a fresh conversation. `asTemporary` is the only difference between the rail's two
   * buttons — one helper so they can't drift into resetting different things.
   */
  const startNew = useCallback(
    (asTemporary: boolean) => {
      if (isTemporary) forgetTemporary(openSlug)
      setPicked(null)
      setTemporary(asTemporary)
      setInput('')
      setAttached([])
      setImages([])
      setMentions([])
      setMention(null)
      setAction(null)
      taRef.current?.focus()
    },
    [forgetTemporary, isTemporary, openSlug],
  )

  const removeChat = useMutation({
    mutationFn: (s: string) => deleteChat(projectId, s),
    onSuccess: (_r, s) => {
      if (s === openSlug) setPicked(null)
      setDeleting(null)
      toast.success('Conversation deleted')
      void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
    },
    onError: (e: Error) => toast.error('Could not delete', { description: e.message }),
  })



  const rename = useMutation({
    mutationFn: (v: { slug: string; name: string }) => renameChat(projectId, v.slug, v.name),
    onSuccess: (saved) => {
      setRenaming(null)
      queryClient.setQueryData(['chat', projectId, saved.slug], saved)
      void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
    },
    onError: (e: Error) => toast.error('Could not rename', { description: e.message }),
  })

  const pin = useMutation({
    mutationFn: (v: { slug: string; pinned: boolean }) => pinChat(projectId, v.slug, v.pinned),
    onSuccess: (saved) => {
      queryClient.setQueryData(['chat', projectId, saved.slug], saved)
      void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
    },
    onError: (e: Error) => toast.error('Could not star', { description: e.message }),
  })

  return (
    <div className="relative flex h-svh min-h-[34rem]">
      <ChatRail
        chats={chats}
        activeSlug={openSlug}
        onSelect={(s) => {
          if (streaming) return
          // Opening a saved conversation ends the temporary one (it can't be reached again)
          // and leaves temporary MODE — otherwise the next New Chat would quietly be
          // temporary too.
          if (isTemporary) forgetTemporary(openSlug)
          setPicked(s)
          setTemporary(false)
          setAtBottom(true)
        }}
        onNew={() => {
          if (streaming) return
          startNew(false)
        }}
        onNewTemporary={() => {
          if (streaming) return
          startNew(true)
        }}
        onPin={(s, pinned) => pin.mutate({ slug: s, pinned })}
        onRename={(s, current) => setRenaming({ slug: s, name: current })}
        onDelete={(s) =>
          setDeleting({ slug: s, name: chats.find((c) => c.slug === s)?.name ?? 'this conversation' })
        }
      />

      {/* Keyed on the target so the rename field seeds from the current name on open. */}
      <RenameChatDialog
        key={renaming?.slug ?? 'none'}
        target={renaming}
        busy={rename.isPending}
        onCancel={() => setRenaming(null)}
        onSave={(name) => renaming && rename.mutate({ slug: renaming.slug, name })}
      />
      <DeleteChatDialog
        target={deleting}
        busy={removeChat.isPending}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && removeChat.mutate(deleting.slug)}
      />

      <div className="flex w-full min-w-0 grow flex-col">
        <ChatHeader
          name={openSlug ? (chat?.name ?? null) : null}
          streaming={streaming}
          tools={tools}
          temporary={isTemporary && !!openSlug}
          pinned={!!chat?.pinned}
          onPin={openSlug ? () => pin.mutate({ slug: openSlug, pinned: !chat?.pinned }) : undefined}
          onRename={
            openSlug
              ? () => setRenaming({ slug: openSlug, name: chat?.name ?? '' })
              : undefined
          }
          onDelete={
            openSlug
              ? () => setDeleting({ slug: openSlug, name: chat?.name ?? 'this conversation' })
              : undefined
          }
          onExport={
            openSlug && messages.length
              ? () => downloadTranscript(chat?.name ?? 'chat', messages)
              : undefined
          }
        />

        {/* The reference caps this column at max-w-4xl, which on a 1440px+ screen leaves the
            answer in a narrow ribbon with empty gutters either side — and answers here carry
            code blocks and CSV tables that want the room. So it widens with the viewport
            instead of stopping at 4xl. */}
        {/* min-h-0 + flex-1, not h-full: the header above is a sibling in the same flex column,
            so h-full would size this to the WHOLE column and push the composer off-screen. */}
        <div className="mx-auto flex min-h-0 w-full max-w-4xl flex-1 flex-col gap-4 p-4 xl:max-w-5xl 2xl:max-w-[88rem]">
          {/* Above everything, in both the empty and the answered state: what this
              conversation is has to be visible BEFORE the question is typed, not explained
              afterwards. */}
          {isTemporary && (
            <TemporaryNotice live={!!openSlug} onEnd={() => startNew(true)} />
          )}

          {/**
           * THE scroll area, in both states — and the composer below it never moves.
           *
           * The reference centres greeting + composer in the column and only then, once a
           * message exists, drops the composer to the bottom: so sending the very first
           * question re-laid out the whole page under the cursor. Here the greeting (and its
           * quick prompts) live INSIDE this scroller, centred by `flex-1`, so the composer is
           * pinned to the bottom from the first frame and the first send changes nothing but
           * the content of this box.
           */}
          <div
            ref={logRef}
            onScroll={onScroll}
            role="log"
            className="relative flex min-h-0 w-full flex-1 flex-col space-y-4 overflow-y-auto pe-2"
          >
            {empty && (
              <div className="flex flex-1 flex-col items-center justify-center">
                <div className="mb-10">
                  <HeroOrb />
                  <h1 className="text-center text-2xl font-medium leading-normal lg:text-4xl">
                    {greeting()}
                    {projectName ? `, ${projectName}` : ''} <br /> How Can I{' '}
                    <span className="bg-gradient-to-r from-purple-400 to-indigo-300 bg-clip-text text-transparent">
                      Assist You Today?
                    </span>
                  </h1>
                </div>

                {/**
                 * Quick prompts. The reference overlays a category's four prompts on the chips'
                 * own slot (`absolute`, a 36px-tall row) so the composer below can't move — but
                 * the composer is pinned now, and this block lives INSIDE the scroller, which
                 * clips: the overlay's 4th row was cut off by the scroller's edge. So the list
                 * takes real height in flow, and the centred greeting shifts a little instead.
                 */}
                <div
                  ref={quickRef}
                  className="flex w-full flex-col items-center justify-center space-y-2"
                >
                  {openCategory ? (
                    <div className="w-full">
                      <div className="flex w-full flex-col space-y-1">
                        {openCategory.items.map((rest) => {
                          const full = `${openCategory.prefix}${rest}`
                          return (
                            <Button
                              key={rest}
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                // Types it in for review — the engineer edits and sends.
                                setInput(full)
                                setOpenCategory(null)
                                taRef.current?.focus()
                              }}
                              className="w-full justify-start"
                            >
                              <span className="whitespace-pre-wrap font-medium text-primary">
                                {openCategory.prefix}
                              </span>
                              <span className="whitespace-pre-wrap text-muted-foreground">
                                {rest}
                              </span>
                            </Button>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap justify-center gap-2">
                      {QUICK.map((q) => (
                        <Button
                          key={q.label}
                          variant="outline"
                          size="sm"
                          onClick={() => setOpenCategory(q)}
                          className="rounded-full"
                        >
                          <q.icon className="size-4" />
                          {q.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {messages.map((m, i) => (
              <Turn key={`${m.at}-${i}`} m={m} projectId={projectId} />
            ))}
            {pending && (
              <>
                <UserRow
                  text={pending.prompt}
                  previews={pending.imageFiles ? undefined : pending.images}
                  images={pending.imageFiles}
                  projectId={projectId}
                  at={pending.at}
                  action={pending.action}
                />
                <AssistantRow
                  text={pending.answer}
                  calls={pending.tools}
                  streaming
                  at={pending.at}
                />
              </>
            )}
            {/* Inside the scroller, under the newest answer — it belongs to that answer,
                and pinning it above the composer would cover the transcript instead. */}
            {followUps.length > 0 && <FollowUps items={followUps} onPick={send} />}
            <div className="h-px w-full shrink-0 scroll-mt-4" aria-hidden />
          </div>

          {/* Jump back to the newest message — only once you've scrolled away from it. */}
          <div className="absolute bottom-28 right-6 z-10">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const el = logRef.current
                if (el) el.scrollTop = el.scrollHeight
                setAtBottom(true)
              }}
              aria-label="Scroll to the newest message"
              className={cn(
                'size-8 rounded-full shadow-sm transition-all duration-150 ease-out',
                atBottom || empty
                  ? 'pointer-events-none translate-y-4 scale-95 opacity-0'
                  : 'opacity-100',
              )}
            >
              <ChevronDown className="size-4" />
            </Button>
          </div>

          {/* Composer well — a tinted tray whose hint strip sits above the input card.
              Drop anywhere on the well, not just the textarea: a dropped screenshot that
              lands 4px off and navigates the browser to the file is a lost attachment. */}
          <div
            ref={setWellEl}
            onDrop={onDrop}
            onDragOver={(e) => e.preventDefault()}
            className="relative w-full rounded-2xl bg-primary/10 p-1 pt-0"
          >
            {/* The `@` menu. Anchored to the WELL (which doesn't clip) and opening upward,
                so it never covers the message being typed. */}
            {mention && (
              <div className="absolute bottom-full left-0 z-20 mb-2 w-full overflow-hidden rounded-xl border bg-popover shadow-md">
                {mentionRows.length > 0 ? (
                  <ul className="max-h-64 overflow-y-auto py-1">
                    {mentionRows.map((opt, i) => (
                      <li key={opt.token}>
                        <button
                          type="button"
                          // Pointer-down, not click: the textarea's blur would close the
                          // menu before a click ever landed.
                          onMouseDown={(e) => {
                            e.preventDefault()
                            pickMention(opt)
                          }}
                          onMouseEnter={() => setMentionIndex(i)}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
                            i === mentionIndex ? 'bg-accent' : 'hover:bg-accent/60',
                          )}
                        >
                          {opt.kind === 'ticket' ? (
                            <Ticket className="size-4 shrink-0 text-muted-foreground" />
                          ) : (
                            <ClipboardList className="size-4 shrink-0 text-violet-500" />
                          )}
                          <span className="shrink-0 font-mono text-xs font-medium">
                            {opt.label}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                            {opt.detail}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3 py-2.5 text-xs text-muted-foreground">
                    {crawledFetching
                      ? 'Looking for crawled tickets…'
                      : (crawled?.length ?? 0) === 0
                        ? 'No crawled tickets yet — crawl one on the Tickets page to tag it.'
                        : `Nothing matches “${mention.query}”.`}
                  </p>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
              <span>
                Answers come from{' '}
                <span className="font-medium text-foreground">
                  {projectName ?? 'no project'}
                </span>
              </span>
              <span>•</span>
              <span>{tools === 'full' ? 'Full tools' : 'Read-only'}</span>
              {isTemporary && (
                <>
                  <span>•</span>
                  <span className="font-medium text-violet-600 dark:text-violet-400">
                    Temporary
                  </span>
                </>
              )}
              <span>•</span>
              <span>
                <code className="font-mono text-foreground">@</code> to tag a ticket
              </span>
              <span>•</span>
              <span>
                <code className="font-mono text-foreground">+</code> for web search
              </span>
              {projectPath && (
                <>
                  <span className="hidden lg:inline">•</span>
                  <code className="hidden min-w-0 truncate font-mono lg:inline">{projectPath}</code>
                </>
              )}
            </div>

            <div className="w-full overflow-hidden rounded-2xl bg-background">
              {images.length > 0 && (
                <div className="flex flex-wrap gap-2 px-4 pt-3">
                  {images.map((img, i) => (
                    <div key={img.dataUrl} className="group relative">
                      <img
                        src={img.dataUrl}
                        alt={img.name}
                        className="size-16 rounded-lg border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove ${img.name}`}
                        className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* What this message will DO, once an action is armed. Above the text because
                  it changes what to type — and removable, since arming it is one click. */}
              {action && (
                <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
                  {(() => {
                    const meta = actionMeta(action)
                    return (
                      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                        <meta.icon className={cn('size-3.5', meta.tone)} />
                        <span className="font-medium">{meta.label}</span>
                        <span className="hidden text-muted-foreground sm:inline">{meta.hint}</span>
                        <button
                          type="button"
                          onClick={() => setAction(null)}
                          aria-label={`Cancel ${meta.label}`}
                          className="text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    )
                  })()}
                </div>
              )}

              {attached.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                  {attached.map((a, i) => (
                    <span
                      key={`${a.name}-${i}`}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                    >
                      <Paperclip className="size-3" />
                      <span className="max-w-[14rem] truncate">{a.name}</span>
                      <button
                        type="button"
                        onClick={() => setAttached((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Remove ${a.name}`}
                        className="text-muted-foreground transition-colors hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value.slice(0, MAX_PROMPT))
                  syncMention(e.target)
                }}
                // Clicking/arrowing into an existing `@…` should reopen the menu, so the
                // caret is re-read on selection changes too, not just on edits.
                onSelect={(e) => syncMention(e.currentTarget)}
                onBlur={() => setMention(null)}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  // While the `@` menu is open it owns the arrows, Tab and Enter — Enter
                  // there means "pick this ticket", not "send the message".
                  if (mention && mentionRows.length) {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                      e.preventDefault()
                      const step = e.key === 'ArrowDown' ? 1 : -1
                      setMentionIndex(
                        (i) => (i + step + mentionRows.length) % mentionRows.length,
                      )
                      return
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault()
                      pickMention(mentionRows[Math.min(mentionIndex, mentionRows.length - 1)])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setMention(null)
                      return
                    }
                  }
                  // Enter sends, Shift+Enter is a newline. IME composition must never
                  // count as a send.
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    send(input)
                  }
                }}
                rows={1}
                placeholder={
                  action
                    ? actionMeta(action).placeholder
                    : 'Ask me anything... (paste a screenshot to attach it)'
                }
                className="max-h-48 min-h-[52px] w-full resize-none border-none bg-transparent p-4 text-sm shadow-none outline-none placeholder:text-muted-foreground"
              />

              <div className="flex items-center justify-between gap-2 p-3">
                <div className="flex items-center gap-2">
                  {/* Lives outside the menu: the menu unmounts on click, and an <input> that
                      unmounts in the same tick never opens its picker. */}
                  <input
                    ref={fileRef}
                    id="chat-file-upload"
                    type="file"
                    multiple
                    accept={`${KNOWLEDGE_ACCEPT},${IMAGE_MIMES.join(',')}`}
                    className="hidden"
                    onChange={(e) => {
                      attachAny(Array.from(e.target.files ?? []))
                      e.target.value = '' // same file twice in a row must re-fire
                    }}
                  />
                  <ComposerPlusMenu
                    action={action}
                    converting={converting}
                    anchor={wellEl}
                    onPickAction={(a) => {
                      // Picking the armed action again disarms it — the pill's ✕ is the other
                      // way, and a menu row that only ever turns something ON is a trap.
                      setAction((cur) => (cur === a ? null : a))
                      taRef.current?.focus()
                    }}
                    onAttach={() => fileRef.current?.click()}
                  />

                  <Select value={model} onValueChange={setModel}>
                    <SelectTrigger
                      size="sm"
                      className="w-fit rounded-full focus:ring-0!"
                      aria-label="Model"
                    >
                      <Sparkles className="size-4 text-muted-foreground" />
                      <div className="hidden lg:flex">
                        {/* Explicit child: SelectValue would otherwise mirror the item. */}
                        <SelectValue>
                          {MODELS.find((m) => m.value === model)?.label ?? model}
                        </SelectValue>
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {MODELS.map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex gap-2">
                  {/* Temporary, as a composer control as well as a rail button: this is
                      where you are when you realise the thing you're about to paste
                      shouldn't be committed with the project.
                      Wrapped in a span because a `disabled` button swallows the pointer
                      events Radix needs, and the tooltip is the only place the "already
                      decided" rule is explained. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex">
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => setTemporary((v) => !v)}
                          disabled={!!openSlug}
                          aria-pressed={isTemporary}
                          aria-label={isTemporary ? 'Temporary chat' : 'Saved to history'}
                          className={cn(
                            'size-9 rounded-full',
                            isTemporary &&
                              'border-violet-500/40 bg-violet-500/15 text-violet-600 hover:bg-violet-500/25 disabled:opacity-100 dark:text-violet-400',
                          )}
                        >
                          <MessageSquareDashed className="size-4" />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {openSlug
                        ? isTemporary
                          ? 'This conversation is temporary — it isn’t saved to testing/chats and won’t appear in your history. Start a new chat to change that.'
                          : 'This conversation is saved to testing/chats. Start a temporary chat instead if you don’t want it kept.'
                        : isTemporary
                          ? 'The next message starts a TEMPORARY conversation — not saved to testing/chats, never in your history. Click to save it instead.'
                          : 'This conversation will be saved to testing/chats and listed in your history. Click to make it temporary.'}
                    </TooltipContent>
                  </Tooltip>

                  {/* The reference's mic slot. A voice button would be decoration; the
                      control that actually matters here is what a turn may DO. */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => setTools(tools === 'read' ? 'full' : 'read')}
                        aria-label={tools === 'full' ? 'Full tools' : 'Read-only'}
                        className={cn(
                          'size-9 rounded-full',
                          tools === 'full' &&
                            'border-amber-500/40 bg-amber-500/15 text-amber-600 hover:bg-amber-500/25 dark:text-amber-400',
                        )}
                      >
                        {tools === 'full' ? (
                          <Wrench className="size-4" />
                        ) : (
                          <ShieldCheck className="size-4" />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      {tools === 'full'
                        ? 'Full tools — Claude can edit files and use this project’s MCP servers. Slower to start. Click for read-only.'
                        : 'Read-only — Claude can read the repo but not change it, and MCP servers are skipped so answers start fast. Click for full tools.'}
                    </TooltipContent>
                  </Tooltip>

                  {streaming ? (
                    <Button
                      size="icon"
                      variant="destructive"
                      onClick={() => stop()}
                      aria-label="Stop generating"
                      className="size-9 rounded-full"
                    >
                      <Square className="size-4" />
                    </Button>
                  ) : (
                    <Button
                      size="icon"
                      onClick={() => send(input)}
                      disabled={(!input.trim() && !images.length) || !projectId}
                      aria-label="Send"
                      className="size-9 rounded-full"
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  )
}

export default function ChatPage() {
  const { activeProject, activeProjectId } = useProjects()
  return (
    <ChatWorkspace
      key={activeProjectId ?? 'none'}
      projectId={activeProjectId ?? ''}
      projectName={activeProject?.name ?? null}
      projectPath={activeProject?.rootPath ?? null}
    />
  )
}
