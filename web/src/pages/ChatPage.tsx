import { isValidElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
// Aliased: the DOM's ClipboardEvent/DragEvent are also in scope in this file.
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  ArrowUp,
  Bug,
  ChevronDown,
  ClipboardList,
  Compass,
  Copy,
  FileSearch,
  History,
  Library,
  Loader2,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  Ticket,
  Trash2,
  Wrench,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CodeBlock } from '@/components/CodeBlock'
import { Input } from '@/components/ui/input'
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
  renameChat,
  streamChat,
  type Chat,
  type ChatMention,
  type CrawledTicket,
  type ChatMessage,
  type ChatSummary,
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
const MD_COMPONENTS: Components = {
  // The swap happens on `pre`, not `code`: react-markdown v9 dropped the `inline` prop, so
  // `pre` IS the only reliable signal that this was a fenced block. Doing it on `code` and
  // guessing from "has a newline" turns a one-line fence into an inline pill.
  pre: ({ children, ...rest }) => {
    const child = Array.isArray(children) ? children[0] : children
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      const text = String(child.props.children ?? '').replace(/\n$/, '')
      const lang = /language-([\w#+-]+)/.exec(child.props.className ?? '')?.[1]
      if (text) return <CodeBlock code={text} language={lang} />
    }
    return <pre {...rest}>{children}</pre>
  },
}

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

// ------------------------------------------------------------------ history rail

/**
 * The per-row "…" menu. Built by hand rather than with Radix: this app doesn't ship a
 * dropdown-menu primitive, and a two-item menu doesn't justify adding one.
 */
function RowMenu({ onRename, onDelete }: { onRename: () => void; onDelete: () => void }) {
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
          'flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground md:opacity-0 md:group-hover:opacity-100',
          open && 'bg-accent md:opacity-100',
        )}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-20 w-36 overflow-hidden rounded-md border bg-popover p-1 shadow-md">
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

function ChatRail({
  chats,
  activeSlug,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  chats: ChatSummary[]
  activeSlug: string | null
  onSelect: (slug: string) => void
  onNew: () => void
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
    return BUCKETS.map((label) => ({
      label,
      items: shown.filter((c) => bucketOf(c.updatedAt) === label),
    })).filter((g) => g.items.length)
  }, [chats, q])

  return (
    <div className="hidden md:flex">
      <div className="flex h-full flex-col border-e lg:w-72">
        <div className="border-b px-4 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-0 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats..."
              className="border-transparent bg-background pl-6 text-sm shadow-none focus:border-transparent! focus:shadow-none focus:ring-0!"
            />
          </div>
        </div>

        <div className="grow space-y-4 overflow-y-auto p-4 lg:space-y-8">
          {groups.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">
              {q.trim() ? 'No conversation matches that.' : 'No conversations yet.'}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <h3 className="mb-4 text-xs text-muted-foreground">{group.label}</h3>
                <div className="space-y-0.5">
                  {group.items.map((c) => (
                    <div key={c.slug} className="group flex items-center">
                      <button
                        type="button"
                        onClick={() => onSelect(c.slug)}
                        title={c.preview || c.name}
                        className={cn(
                          'block w-full min-w-0 truncate rounded-lg p-2 px-3 text-start text-sm transition-colors hover:bg-muted',
                          c.slug === activeSlug && 'bg-muted font-medium',
                        )}
                      >
                        {c.name}
                      </button>
                      <RowMenu
                        onRename={() => onRename(c.slug, c.name)}
                        onDelete={() => onDelete(c.slug)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="space-y-0.5 px-4 pb-2">
          {RAIL_LINKS.map((l) => (
            <NavLink
              key={l.to}
              to={l.to}
              className="flex items-center gap-2 rounded-lg p-2 px-3 text-sm text-foreground transition-colors hover:bg-muted"
            >
              <l.icon className="size-4 text-muted-foreground" />
              {l.label}
            </NavLink>
          ))}
        </div>

        <div className="p-4">
          <Button onClick={onNew} className="w-full">
            <span className="text-base leading-none">+</span>
            New Chat
          </Button>
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
      <svg viewBox="0 0 288 288" className="w-full" aria-hidden="true">
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
            <circle cx="144" cy="146" r="84" fill="url(#orb-violet)" />
            <circle cx="144" cy="146" r="84" fill="url(#orb-peach)" />
            <circle cx="144" cy="146" r="84" fill="url(#orb-pale)" />
            <circle cx="144" cy="146" r="84" fill="url(#orb-crescent)" />
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

        {/* Glass rim — brightest top-left and bottom-right, nearly gone in between. */}
        <circle cx="144" cy="146" r="83.4" fill="none" stroke="url(#orb-rim)" strokeWidth="1.4" />

        <circle cx="151" cy="119" r="1.5" fill="#fcd34d" />
        <circle cx="167" cy="171" r="1.5" fill="#fcd34d" />
        <circle cx="136" cy="153" r="1" fill="#e879f9" />
        <circle cx="159" cy="147" r="0.9" fill="#d8b4fe" />
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
function phaseLabel(tools: string[]): string {
  const last = tools[tools.length - 1]
  if (!last) return 'Thinking'
  if (last === 'Read' || last === 'NotebookRead') return 'Reading the project'
  if (last === 'Grep' || last === 'Glob') return 'Searching the project'
  if (last === 'Bash') return 'Running a command'
  if (last === 'Write' || last === 'Edit' || last === 'MultiEdit') return 'Editing files'
  if (last === 'WebFetch' || last === 'WebSearch') return 'Looking something up'
  if (last === 'TodoWrite') return 'Planning'
  if (last.startsWith('mcp__')) return 'Using an MCP tool'
  return `Using ${last}`
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
  tools,
  compact,
  startedAt,
}: {
  tools: string[]
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

  return (
    <div className={cn('space-y-3', compact && 'mt-3')}>
      <div className="flex items-center gap-2.5">
        <span className="flex items-center gap-1" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="qc-dot size-1.5 rounded-full bg-foreground/70"
              style={{ animationDelay: `${i * 0.16}s` }}
            />
          ))}
        </span>
        <span className="text-sm font-medium text-foreground/80">{phaseLabel(tools)}</span>
        {/* Only past a few seconds: a timer on a fast answer is noise, but on a slow one
            it's the difference between "working" and "stuck". */}
        {seconds >= 3 && (
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {seconds}s
          </span>
        )}
      </div>
      {/* Skeleton answer — the shape of what's coming, so the bubble isn't an empty box.
          Dropped once real text is on screen: the answer itself is the better skeleton.
          Fixed widths, not percentages: the bubble is fit-content, where a % width has
          nothing stable to resolve against. */}
      {!compact && (
        <div className="space-y-2" aria-hidden>
          {['20rem', '16rem', '11rem'].map((w, i) => (
            <div
              key={w}
              className="qc-shimmer h-2.5 max-w-full rounded-full bg-foreground/10"
              style={{ width: w, animationDelay: `${i * 0.18}s` }}
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
}: {
  text: string
  images?: string[]
  previews?: string[]
  projectId?: string
  at?: string
}) {
  const srcs = previews ?? (images && projectId ? images.map((n) => chatImageUrl(projectId, n)) : [])
  return (
    <div className="flex justify-end gap-3">
      <div className="max-w-[85%] flex-1 justify-end text-end sm:max-w-[75%]">
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
    </div>
  )
}

function AssistantRow({
  text,
  tools,
  streaming,
  failed,
  at,
  model,
}: {
  text: string
  tools?: string[]
  streaming?: boolean
  failed?: boolean
  at?: string
  model?: string
}) {
  return (
    <div className="group flex justify-start gap-3">
      <div className="max-w-[85%] flex-1 sm:max-w-[75%]">
        <div className="space-y-2">
          <div
            className={cn(
              // w-fit so the bubble hugs its content: on a wide screen the column is ~1300px,
              // and a one-line answer stretched across 75% of that read as a layout bug.
              'w-fit min-w-0 max-w-full rounded-lg border p-4',
              failed ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'bg-muted text-foreground',
            )}
          >
            <ToolTrail tools={tools ?? []} />
            {/* Keyed, and the indicator stays MOUNTED once text starts arriving — it just
                goes compact and moves below the answer. Remounting it there would restart
                its elapsed timer from zero mid-answer. */}
            {text && (
              <div key="answer" className={MD_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
                  {text}
                </ReactMarkdown>
              </div>
            )}
            {(streaming || !text) && (
              <ThinkingBubble key="waiting" tools={tools ?? []} compact={!!text} startedAt={at} />
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

function Turn({ m, projectId }: { m: ChatMessage; projectId: string }) {
  return m.role === 'user' ? (
    <UserRow text={m.text} images={m.images} projectId={projectId} at={m.at} />
  ) : (
    <AssistantRow text={m.text} tools={m.tools} failed={m.error} at={m.at} model={m.model} />
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

  const [slug, setSlug] = useState<string | null>(null)
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
  /** The `@…` being typed right now (where it starts, the caret, what's typed) — or null. */
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [converting, setConverting] = useState(false)
  // The turn in flight: what was asked, what has streamed back, which tools ran.
  const [pending, setPending] = useState<{
    prompt: string
    answer: string
    tools: string[]
    images: string[]
    /** When it was sent — the saved message gets its `at` from the server, this is the
     *  same stamp for the row that's still streaming, so the time doesn't pop in late. */
    at: string
  } | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  /** Which quick-prompt category is expanded into its four suggestions, if any. */
  const [openCategory, setOpenCategory] = useState<(typeof QUICK)[number] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const quickRef = useRef<HTMLDivElement | null>(null)

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

  // Leaving the page (or switching project, which remounts this) must not leave a
  // headless `claude` running with nobody reading it — aborting the fetch kills it.
  useEffect(() => () => abortRef.current?.abort(), [])

  const { data: railData } = useQuery({
    queryKey: ['chats', projectId],
    queryFn: () => listChats(projectId),
    enabled: !!projectId,
  })
  const chats = railData?.chats ?? []

  const { data: chat } = useQuery({
    queryKey: ['chat', projectId, slug],
    queryFn: () => getChat(projectId, slug as string),
    enabled: !!projectId && !!slug,
  })

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
  const empty = !slug && !pending

  // Follow the answer as it streams — but only while the user is already at the bottom,
  // so scrolling up to re-read something isn't yanked back down mid-answer.
  useEffect(() => {
    const el = logRef.current
    if (el && atBottom) el.scrollTop = el.scrollHeight
  }, [messages.length, pending?.answer, pending?.tools.length, slug, atBottom])

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
      setInput('')
      setAttached([])
      setImages([])
      setMentions([])
      setMention(null)
      setAtBottom(true)
      setPending({
        prompt: base || 'Take a look at the attached screenshot.',
        answer: '',
        tools: [],
        // Previews come from the data URLs already in memory — the files aren't on disk
        // (and so aren't servable) until the turn finishes.
        images: sending.map((i) => i.dataUrl),
        at: new Date().toISOString(),
      })
      const ac = new AbortController()
      abortRef.current = ac
      // The slug this turn belongs to: the open conversation, or whatever the server
      // names the new one (delivered in the `start` frame before any text).
      let targetSlug = slug
      void streamChat(
        projectId,
        {
          slug: slug ?? undefined,
          prompt,
          model,
          tools,
          images: sending.length ? sending.map((i) => ({ mime: i.mime, data: i.data })) : undefined,
          mentions: tags.length ? tags : undefined,
        },
        {
          onStart: (s) => {
            targetSlug = s
            setSlug(s)
          },
          onDelta: (t) => setPending((p) => (p ? { ...p, answer: p.answer + t } : p)),
          onTool: (name) => setPending((p) => (p ? { ...p, tools: [...p.tools, name] } : p)),
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
    },
    [projectId, slug, model, tools, streaming, attached, images, mentions, queryClient],
  )

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

  const removeChat = useMutation({
    mutationFn: (s: string) => deleteChat(projectId, s),
    onSuccess: (_r, s) => {
      if (s === slug) setSlug(null)
      toast.success('Conversation deleted')
      void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
    },
    onError: (e: Error) => toast.error('Could not delete', { description: e.message }),
  })

  const rename = useMutation({
    mutationFn: (v: { slug: string; name: string }) => renameChat(projectId, v.slug, v.name),
    onSuccess: (saved) => {
      queryClient.setQueryData(['chat', projectId, saved.slug], saved)
      void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
    },
    onError: (e: Error) => toast.error('Could not rename', { description: e.message }),
  })

  return (
    <div className="relative flex h-[calc(100svh-2rem)] min-h-[34rem] rounded-md sm:h-[calc(100svh-3rem)] lg:h-[calc(100svh-4rem)] lg:border">
      <ChatRail
        chats={chats}
        activeSlug={slug}
        onSelect={(s) => {
          if (streaming) return
          setSlug(s)
          setAtBottom(true)
        }}
        onNew={() => {
          if (streaming) return
          setSlug(null)
          setInput('')
          setAttached([])
          setImages([])
          setMentions([])
          setMention(null)
          taRef.current?.focus()
        }}
        onRename={(s, current) => {
          const name = window.prompt('Rename this conversation', current)
          if (name && name.trim() && name.trim() !== current) {
            rename.mutate({ slug: s, name: name.trim() })
          }
        }}
        onDelete={(s) => {
          if (window.confirm('Delete this conversation? The transcript file is removed.')) {
            removeChat.mutate(s)
          }
        }}
      />

      <div className="flex w-full grow flex-col">
        {/* The reference caps this column at max-w-4xl, which on a 1440px+ screen leaves the
            answer in a narrow ribbon with empty gutters either side — and answers here carry
            code blocks and CSV tables that want the room. So it widens with the viewport
            instead of stopping at 4xl. */}
        <div className="mx-auto flex h-full w-full max-w-4xl flex-col items-center justify-center space-y-4 p-4 xl:max-w-5xl 2xl:max-w-[88rem]">
          {/* Transcript. Hidden (not unmounted) when empty, exactly like the reference,
              so the greeting + composer sit centred in the column. */}
          <div
            ref={logRef}
            onScroll={onScroll}
            role="log"
            className={cn(
              'relative w-full flex-1 flex-col space-y-4 overflow-y-auto pe-2 pt-10 md:pt-0',
              empty ? 'hidden' : 'flex',
            )}
          >
            {messages.map((m, i) => (
              <Turn key={`${m.at}-${i}`} m={m} projectId={projectId} />
            ))}
            {pending && (
              <>
                <UserRow text={pending.prompt} previews={pending.images} at={pending.at} />
                <AssistantRow
                  text={pending.answer}
                  tools={pending.tools}
                  streaming
                  at={pending.at}
                />
              </>
            )}
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

          {empty && (
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
          )}

          {/* Composer well — a tinted tray whose hint strip sits above the input card.
              Drop anywhere on the well, not just the textarea: a dropped screenshot that
              lands 4px off and navigates the browser to the file is a lost attachment. */}
          <div
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
              <span>•</span>
              <span>
                <code className="font-mono text-foreground">@</code> to tag a ticket
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
                placeholder="Ask me anything... (paste a screenshot to attach it)"
                className="max-h-48 min-h-[52px] w-full resize-none border-none bg-transparent p-4 text-sm shadow-none outline-none placeholder:text-muted-foreground"
              />

              <div className="flex items-center justify-between gap-2 p-3">
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <label
                        htmlFor="chat-file-upload"
                        className="flex size-8 cursor-pointer items-center justify-center rounded-2xl transition-colors hover:bg-secondary-foreground/10"
                      >
                        <input
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
                        {converting ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Paperclip className="size-4" />
                        )}
                      </label>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      Attach a spec or doc ({KNOWLEDGE_ACCEPT}) — converted to text in your browser
                      — or a screenshot (PNG/JPEG/WebP/GIF). You can also paste or drop an image
                      straight into the box.
                    </TooltipContent>
                  </Tooltip>

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
                      onClick={() => abortRef.current?.abort()}
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

          {/* Quick prompts. A category's list is absolutely positioned over the same
              slot the chips occupy, so expanding one swaps the row in place instead of
              shoving the composer up the page — same trick as the reference. */}
          {empty && (
            <div
              ref={quickRef}
              className="relative flex min-h-9 w-full flex-col items-center justify-center space-y-2"
            >
              {openCategory ? (
                <div className="absolute left-0 top-0 w-full">
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
                          <span className="whitespace-pre-wrap text-muted-foreground">{rest}</span>
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
          )}
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
