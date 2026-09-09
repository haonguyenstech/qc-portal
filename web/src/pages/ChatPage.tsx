import { cloneElement, isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
// Aliased: the DOM's ClipboardEvent/DragEvent are also in scope in this file.
import type {
  ClipboardEvent as ReactClipboardEvent,
  DragEvent as ReactDragEvent,
  ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink, useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  ArrowUp,
  Blocks,
  Brain,
  Bug,
  Check,
  ChevronDown,
  CircleCheck,
  CircleHelp,
  Clock,
  ClipboardList,
  Compass,
  Copy,
  Database,
  Download,
  FileSearch,
  FileText,
  Gauge,
  Globe,
  History,
  ImageIcon,
  Library,
  ListTodo,
  Loader2,
  MessageSquareDashed,
  MoreHorizontal,
  NotebookPen,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  Plus,
  Search,
  SearchCheck,
  ShieldAlert,
  ShieldCheck,
  ShieldHalf,
  Sparkles,
  Square,
  Workflow,
  Star,
  Telescope,
  TerminalSquare,
  ThumbsDown,
  ThumbsUp,
  Ticket,
  Trash2,
  TriangleAlert,
  User,
  Wand2,
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
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { copyText } from '@/lib/clipboard'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT, MAX_FILE_BYTES } from '@/lib/docConvert'
import { useProjects } from '@/lib/project-context'
import {
  auditChatAnswer,
  chatImageUrl,
  projectImageUrl,
  resolveProjectImages,
  createWorkspaceNote,
  deleteChat,
  getChat,
  getDatabases,
  listChats,
  listCrawledTickets,
  listSkills,
  pinChat,
  rateChatAnswer,
  renameChat,
  streamChat,
  attachChat,
  stopChat,
  type Chat,
  type ChatAction,
  type ChatMention,
  type CrawledTicket,
  type ChatMessage,
  type ContextBlock,
  type TurnStats,
  type QueuedChatMessage,
  cancelQueuedChat,
  type ChatSummary,
  type ChatToolCall,
  type ChatEffort,
  type ChatAudit,
  type AuditClaim,
  type ChatFeedback,
  type ChatTools,
  type DatabaseConn,
} from '@/lib/api'
import type { SkillSummary } from '@/lib/types'

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

/**
 * Evidence images an answer CITED, made clickable.
 *
 * A chat turn that ran the `qc-testing` skill answers with evidence: "the cancel dialog
 * never closed — see testing/test-result/ABC-1-checkout/screenshots/ac3-cancel.png". Until
 * now that path was dead text: the engineer had to find the run, open its Screenshots tab
 * and match the filename by eye. So the transcript turns a cited image path into a chip
 * that opens the picture in a dialog, exactly as RunDetailPage does inside a run.
 *
 * Two rules keep this from touching an answer that has no evidence in it:
 * - Only paths WITH a directory and an image extension are candidates; a bare word is not.
 * - A candidate becomes a chip only after the server confirms the file exists
 *   (`resolveProjectImages`). A path the model invented, or one from another machine, stays
 *   plain text — the same "never report what we aren't sure about" rule `answerCheck` uses.
 * With no candidates nothing is fetched and the markdown renders through the exact same
 * module-level `components` identity it did before.
 */
const IMAGE_REF_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.@~-]+\/)+[A-Za-z0-9_.@()-]+\.(?:png|jpe?g|gif|webp|bmp)/gi

/** Image-shaped paths named in an answer, deduped, order preserved. Fences excluded: a
 *  path inside a code block is a command being shown, not evidence to open. */
function collectImageRefs(text: string): string[] {
  if (!text || !/\.(png|jpe?g|gif|webp|bmp)\b/i.test(text)) return []
  const body = text.replace(/```[\s\S]*?(?:```|$)/g, '\n').replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n')
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of body.matchAll(IMAGE_REF_RE)) {
    const raw = m[0]
    const start = m.index ?? 0
    // The tail of a URL (`https://host/a.png`) is not a file in this project.
    if (/[A-Za-z0-9_@:/-]$/.test(body.slice(Math.max(0, start - 3), start))) continue
    const cleaned = raw.replace(/^\.\//, '')
    if (cleaned.startsWith('..') || seen.has(cleaned)) continue
    seen.add(cleaned)
    out.push(cleaned)
    if (out.length >= 40) break
  }
  return out
}

/** cited path → project-relative path, for the ones that are real files. */
function useResolvedImages(projectId: string | undefined, refs: string[]) {
  const key = refs.join('|')
  const { data } = useQuery({
    queryKey: ['chat-image-refs', projectId, key],
    queryFn: () => resolveProjectImages(projectId!, refs),
    enabled: !!projectId && refs.length > 0,
    staleTime: 60_000,
  })
  return data
}

/** The chip itself — a filename, an image glyph, and the click that opens the picture. */
function ImageRefChip({ cited, onOpen }: { cited: string; onOpen: () => void }) {
  const name = cited.split('/').pop() ?? cited
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${cited} — click to view`}
      className={cn(
        'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-xl border px-1.5 py-0.5 align-middle',
        'font-mono text-[11px] leading-none transition-colors',
        'border-violet-500/30 bg-violet-500/5 text-violet-600 hover:border-violet-500/50',
        'hover:bg-violet-500/10 dark:text-violet-400',
      )}
    >
      <ImageIcon className="size-3 shrink-0" />
      <span className="truncate">{name}</span>
    </button>
  )
}

/** Walk rendered markdown children, swapping confirmed image paths for chips. */
function linkifyImageRefs(
  node: ReactNode,
  resolved: Record<string, string>,
  onOpen: (cited: string) => void,
  keyPrefix = 'img',
): ReactNode {
  if (typeof node === 'string') {
    if (!node.includes('.')) return node
    const parts: ReactNode[] = []
    let last = 0
    let i = 0
    IMAGE_REF_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = IMAGE_REF_RE.exec(node)) !== null) {
      const cited = match[0].replace(/^\.\//, '')
      if (!resolved[cited]) continue
      if (match.index > last) parts.push(node.slice(last, match.index))
      parts.push(<ImageRefChip key={`${keyPrefix}-${i++}`} cited={cited} onOpen={() => onOpen(cited)} />)
      last = match.index + match[0].length
    }
    if (parts.length === 0) return node
    if (last < node.length) parts.push(node.slice(last))
    return parts
  }
  if (Array.isArray(node)) {
    return node.map((child, idx) => linkifyImageRefs(child, resolved, onOpen, `${keyPrefix}-${idx}`))
  }
  if (isValidElement(node)) {
    const el = node as React.ReactElement<{ children?: ReactNode }>
    if (el.props?.children != null) {
      return cloneElement(el, {
        children: linkifyImageRefs(el.props.children, resolved, onOpen, keyPrefix),
      })
    }
  }
  return node
}

/** Flatten a node tree to plain text — an inline `code` path is one text child. */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children)
  return ''
}

/**
 * The finished-answer `components`, with evidence chips. Built only for an answer that
 * actually cites a real image — otherwise the shared `MD_COMPONENTS` identity is used, so
 * every other turn on the page renders exactly as it did before.
 */
function imageRefComponents(
  resolved: Record<string, string>,
  onOpen: (cited: string) => void,
): Components {
  const linkify = (children: ReactNode) => linkifyImageRefs(children, resolved, onOpen)
  return {
    ...MD_COMPONENTS,
    p: ({ children, ...rest }) => <p {...rest}>{linkify(children)}</p>,
    li: ({ children, ...rest }) => <li {...rest}>{linkify(children)}</li>,
    td: ({ children, ...rest }) => <td {...rest}>{linkify(children)}</td>,
    // An inline `code` path becomes the chip itself, not a chip inside a code pill.
    code: ({ children, className, ...rest }) => {
      const cited = className ? '' : nodeText(children).trim().replace(/^\.\//, '')
      if (cited && resolved[cited]) {
        return <ImageRefChip cited={cited} onOpen={() => onOpen(cited)} />
      }
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      )
    },
    // `![alt](screenshots/ac1.png)` — a relative src is meaningless to the browser, so
    // point it at the file route and make it open the same dialog.
    img: ({ src, alt }) => {
      const cited = typeof src === 'string' ? src.replace(/^\.\//, '') : ''
      if (cited && resolved[cited]) {
        return <ImageRefChip cited={cited} onOpen={() => onOpen(cited)} />
      }
      return <span className="text-xs text-muted-foreground">{alt || cited}</span>
    },
  }
}

/** The picture, full size, over the transcript. Escape / clicking away closes it. */
function ImageRefDialog({
  projectId,
  cited,
  rel,
  onClose,
}: {
  projectId: string
  cited: string
  rel: string
  onClose: () => void
}) {
  const src = projectImageUrl(projectId, rel)
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="break-all font-mono text-sm">{cited.split('/').pop()}</DialogTitle>
          <DialogDescription className="break-all font-mono text-[11px]">{rel}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-2">
          <img src={src} alt={cited} className="mx-auto max-w-full" />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" asChild>
            <a href={src} target="_blank" rel="noreferrer">
              Open in new tab
            </a>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Module-level so a re-render never hands ReactMarkdown a new `components` identity. */
const MD_COMPONENTS = mdComponents(true)
const MD_COMPONENTS_STREAMING = mdComponents(false)

const MODELS = [
  // `default` sends no --model, so the CLI uses the same model an interactive `claude`
  // does in the Terminal page. That parity is the point — pinning Sonnet here answered
  // measurably shallower than the Terminal on the same repo question.
  // Named for what it GIVES you, not for how it's implemented: "Same as Terminal" made the
  // strongest option sound like a compatibility setting, and the Terminal page is not where
  // most people form their idea of "good". The hint keeps the mechanism visible one line down.
  { value: 'default', label: 'Best (your default)', hint: 'Same model as the Terminal' },
  { value: 'haiku', label: 'Claude Haiku' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
]

// v2: the defaults changed to Terminal parity (model `default`, full tools). A stored
// `sonnet` / `read` from the old keys would silently keep every existing user on the weaker
// setup, which is the whole thing being fixed — so the keys are versioned rather than read.
/**
 * The footer records the model that ANSWERED, which since the `default` option is a real
 * CLI id (`claude-opus-5[1m]`, `claude-haiku-4-5-20251001`) rather than the short alias it
 * used to be. Show the readable middle; the full id stays in the `title`.
 */
function shortModel(model: string): string {
  const m = /^claude-([a-z]+)-?([\d.]+)?/.exec(model)
  if (!m) return model
  const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
  return m[2] ? `Claude ${name} ${m[2]}` : `Claude ${name}`
}

/**
 * HOW HARD THE MODEL THINKS, as its own picker beside the model.
 *
 * It is a genuinely separate axis: "where is this field validated?" is a `low` question on
 * any model, and "does this ticket's test coverage hold up?" is a judgement call that gets
 * measurably better when the model is allowed to reason before it writes.
 *
 * THREE levels, defaulting to `medium`. The CLI also accepts `xhigh` and `max`; they are
 * deliberately not offered — on chat-sized questions they mostly buy minutes of thinking and
 * a bigger bill, and a picker whose top two options nobody should routinely choose is a trap.
 * `medium` is sent EXPLICITLY (not by omitting the flag), so a chat turn runs the same way
 * whatever the engineer's own Claude Code happens to be configured for.
 *
 * `'default'` — inherit that configured effort by passing no flag — stays in the type because
 * conversations and localStorage values written before this table existed carry it; it is
 * simply not offered any more, and `pickEffort`/the validation below map anything unknown
 * onto `medium`. See routes/chat.ts `ChatEffort`.
 */
const CHAT_EFFORTS: { value: ChatEffort; label: string; hint?: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, cheapest — for lookups' },
  { value: 'medium', label: 'Medium', hint: 'Balanced — the default' },
  { value: 'high', label: 'High', hint: 'Thinks before answering' },
]

/** The level a missing or no-longer-offered stored value lands on. */
const DEFAULT_EFFORT: ChatEffort = 'medium'

const effortLabel = (e: ChatEffort) =>
  e === 'default' ? 'Default' : (CHAT_EFFORTS.find((x) => x.value === e)?.label ?? e)

const MODEL_KEY = 'qc.chatModel.v2'
const TOOLS_KEY = 'qc.chatTools.v2'
/** v1 — this setting is new, so there is no old value whose meaning could have changed. */
const EFFORT_KEY = 'qc.chatEffort.v1'
/**
 * How tall the composer opens, in px — dragged by the grip on top of the input card.
 *
 * A fixed 152px (≈6 lines) is right on a desktop monitor and eats a third of a 13" laptop
 * screen, so the height is the engineer's to set and it is remembered per browser. It is a
 * MINIMUM, not a fixed height: the box still grows with what's typed (`field-sizing-content`)
 * up to `max(that height, min(26rem, 45vh))` — the `45vh` is what stops a grown box from
 * swallowing the conversation on a short screen.
 */
const COMPOSER_H_KEY = 'qc.chatComposerHeight.v1'
const COMPOSER_H_DEFAULT = 152
const COMPOSER_H_MIN = 56
const COMPOSER_H_MAX = 640
const clampComposerH = (px: number) =>
  Math.round(Math.min(COMPOSER_H_MAX, Math.max(COMPOSER_H_MIN, px)))
/** Mirrors the server's cap (routes/chat.ts). Over it the server 413s rather than truncating. */
const MAX_PROMPT = 48_000
/**
 * How many messages may wait behind the reply being written. Mirrors `MAX_QUEUED` in
 * routes/chat.ts — this copy only exists so the Send button can go quiet at the limit
 * instead of the engineer learning it from a 429 after typing.
 */
const MAX_QUEUED = 3

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

// --------------------------------------------------------------- @ and / pickers

/**
 * `@` tags a crawled ticket or its test cases; `/` picks one of the project's own skills.
 *
 * "Are these cases enough?" only means something next to a ticket, and the alternatives
 * are pasting a folder path or hoping the model greps for the right one. The token that
 * lands in the message (`@ABC-123`, `/qc-testing`) is what the engineer reads; the
 * machine-readable reference rides alongside in `mentions` and is resolved server-side —
 * to files to Read for an artifact, to a SKILL.md to follow for a skill.
 *
 * The token stays in the text on purpose: it's the record of what was asked, and it's why
 * a mention whose token the engineer deleted is dropped at send time.
 */
interface StagedMention {
  token: string
  kind: 'ticket' | 'testcase' | 'database' | 'skill'
  /** Tickets/test cases only — the folder under testing/tickets/. */
  folder?: string
  /** Databases only — the connected database's id (re-checked against the project). */
  databaseId?: string
  /** Skills only — the folder name under .claude/skills/. */
  skill?: string
}

/** One row of the `@` / `/` menu. */
interface MentionOption extends StagedMention {
  label: string
  detail: string
}

const MAX_MENTION_ROWS = 8

/** Which picker is open: `@` for project artifacts, `/` for the project's skills. */
type TriggerChar = '@' | '/'

/**
 * The `@…` or `/…` being typed at the caret, if any: which character opened it, where it
 * starts, and what's been typed after it. Anchored to a word boundary so an email address,
 * a decorator (`@Injectable`) or `and/or` mid word doesn't open the menu.
 */
function activeTrigger(
  text: string,
  caret: number,
): { char: TriggerChar; start: number; query: string } | null {
  const m = /(?:^|\s)([@/])([\w.\-/]*)$/.exec(text.slice(0, caret))
  if (!m) return null
  // A `/` inside the query only makes sense for `@ABC-123/testcases`. A skill name is one
  // folder, so a second segment means this is a pasted path (`/Users/…`), not a pick.
  if (m[1] === '/' && m[2].includes('/')) return null
  return { char: m[1] as TriggerChar, start: caret - m[2].length - 1, query: m[2] }
}

/**
 * `@db/<tag>` — the token for a connected database. Spaces would end the `@…` token, so
 * the tag is slugged; it still has to READ as the tag ("Mezher Dev DB" → `@db/mezher-dev-db`).
 */
function dbToken(tag: string): string {
  const slug = tag.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `@db/${slug || 'database'}`
}

/**
 * Turn `@`-able artifacts into menu rows, filtered by what's been typed.
 *
 * Databases come FIRST and are counted separately from the ticket budget: a project has
 * one or two of them against hundreds of tickets, so sharing one 8-row list would push
 * the database off the menu permanently — it would exist and be unreachable.
 */
function mentionOptions(
  tickets: CrawledTicket[],
  databases: DatabaseConn[],
  query: string,
): MentionOption[] {
  const q = query.trim().toLowerCase()
  const out: MentionOption[] = []
  for (const d of databases) {
    const token = dbToken(d.tag)
    // Matched on the token AND the human names, so "@mez", "@db", and the database's
    // own name all find it.
    if (q && !`${token} ${d.tag} ${d.database} ${d.kind}`.toLowerCase().includes(q)) continue
    out.push({
      token,
      kind: 'database',
      databaseId: d.id,
      label: token.slice(1),
      detail: `${d.tag} · ${d.database}${d.tableCount ? ` · ${d.tableCount} tables` : ''}`,
    })
  }
  const ticketRows: MentionOption[] = []
  for (const t of tickets) {
    const id = t.displayId?.trim() || t.name.split('/').pop() || t.name
    const haystack = `${id} ${t.title ?? ''} ${t.name}`.toLowerCase()
    if (q && !haystack.includes(q)) continue
    ticketRows.push({
      token: `@${id}`,
      kind: 'ticket',
      folder: t.name,
      label: id,
      detail: t.title?.trim() || t.name,
    })
    if (t.testcaseVersions > 0) {
      ticketRows.push({
        token: `@${id}/testcases`,
        kind: 'testcase',
        folder: t.name,
        label: `${id}/testcases`,
        detail: `Latest of ${t.testcaseVersions} test-case version${t.testcaseVersions === 1 ? '' : 's'}`,
      })
    }
    if (ticketRows.length >= MAX_MENTION_ROWS * 2) break
  }
  return [...out, ...ticketRows].slice(0, MAX_MENTION_ROWS + out.length)
}

/**
 * Turn the project's skills into `/` menu rows.
 *
 * A skill is a procedure the team already wrote down on the Skills page — the whole point
 * is that the answer follows it instead of Claude improvising its own. Typing `/` is how
 * every other Claude surface asks for one, so it's what the composer answers to.
 */
function skillOptions(skills: SkillSummary[], query: string): MentionOption[] {
  const q = query.trim().toLowerCase()
  const out: MentionOption[] = []
  for (const s of skills) {
    if (q && !`${s.name} ${s.description}`.toLowerCase().includes(q)) continue
    out.push({
      token: `/${s.name}`,
      kind: 'skill',
      skill: s.name,
      label: s.name,
      detail: s.description.trim() || 'No description in its SKILL.md',
    })
    if (out.length >= MAX_MENTION_ROWS) break
  }
  return out
}

/**
 * Split the composer text around the staged `@` tokens, so each can be painted as a chip.
 *
 * Longest token first: `@ABC-123/testcases` must win over `@ABC-123`, which is a prefix of
 * it — the other order would chip the ticket id and leave `/testcases` as loose text.
 */
function paintSegments(text: string, tokens: string[]): { text: string; tag: boolean }[] {
  if (!tokens.length) return [{ text, tag: false }]
  const alt = [...new Set(tokens)]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const out: { text: string; tag: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(new RegExp(`(?:${alt})`, 'g'))) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), tag: false })
    out.push({ text: m[0], tag: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), tag: false })
  return out
}

/**
 * The chips behind the composer.
 *
 * A `<textarea>` cannot contain an element, so a tagged `@db/mezher-dev-db` rendered as
 * plain text (complete with a spellcheck squiggle) — indistinguishable from something the
 * engineer typed by hand. The fix is the overlay `SqlEditor` already uses: this layer
 * paints the text, the textarea above it is transparent except for its caret. **The token
 * therefore stays in the text**, which is what keeps deleting it the way to untag (see
 * StagedMention) — a chip list beside the box would have needed its own remove affordance
 * and a second source of truth.
 *
 * The chip is layout-NEUTRAL and must stay that way: padding is cancelled by an equal
 * negative margin, and the font is untouched (no weight or tracking change). Anything that
 * alters the text's metrics moves the painted glyphs off the real ones, and the caret
 * drifts further from the text with every character on the line.
 */
const ComposerPaint = memo(function ComposerPaint({
  text,
  tokens,
  paintRef,
}: {
  text: string
  tokens: string[]
  paintRef: React.RefObject<HTMLDivElement | null>
}) {
  const segments = useMemo(() => paintSegments(text, tokens), [text, tokens])
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        ref={paintRef}
        className="whitespace-pre-wrap break-words p-4 text-sm text-foreground"
      >
        {segments.map((s, i) =>
          s.tag ? (
            <span
              key={i}
              className="mx-[-3px] rounded-md bg-sky-500/15 px-[3px] text-sky-700 dark:text-sky-300"
            >
              {s.text}
            </span>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {/* Forces a final line box so a trailing newline scrolls like it does in the textarea. */}
        {'​'}
      </div>
    </div>
  )
})

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

// ------------------------------------------------------ the composer's mode picker

/**
 * The THREE things a turn may be allowed to do, as one table the pill, the menu, the header
 * badge and the hint strip all read from — the labels used to be inline ternaries in four
 * places, which is how "Fast mode" and "Full tools" ended up naming the same setting two
 * ways on one screen.
 *
 * The middle mode is the one worth explaining: **Workspace write** lets Claude change files
 * in THIS project and nothing else — no MCP servers, so no browser, no ClickUp, no outside
 * system — and it keeps read-only's ~1s start because there are no servers to boot. See
 * routes/chat.ts `toolArgs`.
 *
 * Honest wording matters here: none of these is a sandbox (`--allowedTools` is a permission
 * allow-list, and the engineer's own `permissions.defaultMode` can widen it), so the copy
 * says what the turn is FOR, and only `full` is described as unrestricted.
 */
const CHAT_MODES: {
  value: ChatTools
  label: string
  hint: string
  icon: LucideIcon
  /** Tint for the active trigger + the header badge. */
  pill: string
  /** The long form, for the tooltip and the badge's title. */
  title: string
}[] = [
  {
    value: 'read',
    label: 'Read only',
    hint: 'Answer from the repo, change nothing',
    icon: ShieldCheck,
    pill: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    title:
      'Read only — file tools only, MCP servers skipped, so answers start in about a second. Claude explores less, so expect shallower answers.',
  },
  {
    value: 'write',
    label: 'Workspace write',
    hint: 'May edit files in this project only',
    icon: ShieldHalf,
    pill: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    title:
      'Workspace write — Claude may read AND edit files in this project, but MCP servers stay off, so it can’t drive a browser, ClickUp or anything outside the folder. Still starts in about a second.',
  },
  {
    value: 'full',
    label: 'Full access',
    hint: 'Everything the Terminal page can do',
    icon: ShieldAlert,
    pill: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    title:
      'Full access — the same setup the Terminal page runs: full permissions and this project’s MCP servers. Most accurate, ~20s slower to start.',
  },
]

const modeMeta = (t: ChatTools) => CHAT_MODES.find((m) => m.value === t) ?? CHAT_MODES[2]

/**
 * The permission picker in the composer.
 *
 * Deliberately the SAME control as the model and effort pickers next to it — one shadcn
 * `Select`, label over hint in each row, the label collapsing to the icon below `lg`. It
 * started as a hand-rolled panel portaled into the composer well (the `+` menu still needs
 * that, because it lives inside the `overflow-hidden` input card); as a sibling of two
 * Selects that read as a third, slightly-different menu, which is exactly the drift the
 * shared `CHAT_MODES` table was introduced to stop. The only thing kept from the pill
 * version is the per-mode TINT on the trigger: "what is this turn allowed to do" is the one
 * composer setting worth seeing without reading it.
 */
/**
 * The three composer pills (model, effort, what-it-may-do) share one size. Every pixel of
 * chrome under the textarea is a pixel the input box above it doesn't get, so these are
 * deliberately smaller than a default `size="sm"` trigger — the `!` suffixes beat
 * shadcn's own `data-[size=sm]:h-8` and its `[&_svg:not([class*='size-'])]:size-4`.
 */
const COMPOSER_PILL = "h-7! w-fit gap-1.5 px-2.5 text-xs focus:ring-0! [&_svg]:size-3.5!"

function ComposerModePicker({
  tools,
  onPick,
}: {
  tools: ChatTools
  onPick: (t: ChatTools) => void
}) {
  const active = modeMeta(tools)
  return (
    <Select value={tools} onValueChange={(v) => onPick(v as ChatTools)}>
      {/* The long explanation is a NATIVE `title`, not a Radix tooltip: a tooltip anchored to
          this trigger stays open while the menu is (the trigger keeps focus) and covers the
          very options it is explaining — measured on screen. The header badge does the same,
          and each row carries its own one-line hint. */}
      <SelectTrigger
        size="sm"
        title={active.title}
        aria-label={`What this chat may do: ${active.label}`}
        className={cn(COMPOSER_PILL, active.pill)}
      >
        <active.icon className="size-4" />
        <div className="hidden lg:flex">
          <SelectValue>{active.label}</SelectValue>
        </div>
      </SelectTrigger>
      <SelectContent>
        {CHAT_MODES.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <span className="flex flex-col items-start gap-0.5">
              <span>{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.hint}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
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

/**
 * The greeting's second line types itself out and swaps every few seconds.
 *
 * It isn't decoration: the empty state's job is to say what this page can be asked, and the
 * quick chips below only cover four categories. Cycling the headline names a few more kinds
 * of question in the place the eye already is. Keep them short — the line re-centres as the
 * text grows, and a long phrase would wrap and shove the chips down mid-animation.
 */
const GREETING_PHRASES = [
  'Assist You Today?',
  'Help With Your Tickets?',
  'Speed Up Your Testing?',
  'Explain This Project?',
  'Review Your Test Cases?',
]

const TYPE_MS = 55 // per character while writing
const ERASE_MS = 28 // faster going back — re-reading the same word is dead time
const HOLD_MS = 2200 // the phrase sits still long enough to actually be read
const BLANK_MS = 350 // a beat on the empty line before the next one starts

/**
 * One character per tick, driven by a chain of `setTimeout`s rather than a `requestAnimation
 * Frame` loop (`useSmoothReveal`'s shape): this advances ~18 times a second at most, so a
 * per-frame loop would spend 59 of every 60 frames deciding to do nothing.
 *
 * It starts on the FIRST phrase fully written, so the very first paint is the finished
 * sentence and the animation begins by erasing it — a headline that types in from nothing on
 * mount reads as the page still loading.
 */
function useTypewriter(phrases: string[]): { text: string; caret: boolean } {
  const [reduced] = useState(
    () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )
  const [i, setI] = useState(0)
  const [len, setLen] = useState(phrases[0].length)
  const [erasing, setErasing] = useState(false)

  useEffect(() => {
    if (reduced) return
    const word = phrases[i % phrases.length]
    const atEnd = !erasing && len >= word.length
    const atStart = erasing && len <= 0
    const delay = atEnd ? HOLD_MS : atStart ? BLANK_MS : erasing ? ERASE_MS : TYPE_MS
    const id = setTimeout(() => {
      if (atEnd) setErasing(true)
      else if (atStart) {
        setErasing(false)
        setI((v) => (v + 1) % phrases.length)
      } else setLen((l) => l + (erasing ? -1 : 1))
    }, delay)
    return () => clearTimeout(id)
  }, [phrases, i, len, erasing, reduced])

  // Someone who asked for less motion gets the headline, not the typing.
  if (reduced) return { text: phrases[0], caret: false }
  return { text: phrases[i % phrases.length].slice(0, Math.max(0, len)), caret: true }
}

/**
 * Its own component so the typewriter's ~18 ticks a second re-render this heading ALONE —
 * hanging the hook on the page would re-render the composer and the quick prompts with it.
 * `aria-label` carries the settled sentence, so a screen reader reads it once instead of
 * announcing a half-typed word.
 */
function GreetingHeadline({ projectName }: { projectName?: string | null }) {
  const { text, caret } = useTypewriter(GREETING_PHRASES)
  return (
    <h1
      aria-label={`${greeting()}${projectName ? `, ${projectName}` : ''}. How can I ${GREETING_PHRASES[0]}`}
      className="text-center text-2xl font-medium leading-normal lg:text-4xl"
    >
      <span aria-hidden>
        {greeting()}
        {projectName ? `, ${projectName}` : ''} <br /> How Can I{' '}
        <span className="bg-gradient-to-r from-purple-400 to-indigo-300 bg-clip-text text-transparent">
          {text}
        </span>
        {caret && (
          <span className="qc-caret ms-0.5 text-indigo-300/80" aria-hidden>
            ▍
          </span>
        )}
      </span>
    </h1>
  )
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

/**
 * A conversation's name as the history rail shows it.
 *
 * A new chat is named after its first question, and a question is typed the way people
 * type — "how does the crawl work?" — so the rail read as a column of lowercase fragments.
 * Only the FIRST character is raised: CSS `capitalize` would title-case every word (and
 * mangle `ticket.json` → `Ticket.json`), and `::first-letter` doesn't apply to the inline
 * span it renders in. A name the engineer renamed by hand starting lowercase on purpose is
 * the acceptable cost — this is display only, the stored `name` is untouched.
 */
function railTitle(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/**
 * Which history groups the engineer has collapsed.
 *
 * Kept in localStorage rather than component state alone: the rail unmounts on every trip
 * to another page, and a fold you have to redo each time you come back is worse than no
 * fold at all. Stored by group LABEL — the labels are a fixed set ("Starred", "Today", …),
 * so nothing here goes stale when conversations move between buckets overnight.
 */
const COLLAPSED_KEY = 'qc.chat.railCollapsed'

function readCollapsedGroups(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function writeCollapsedGroups(labels: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(labels))
  } catch {
    /* private mode / quota — the fold just doesn't survive the page */
  }
}

/**
 * Whether the whole history rail is folded away, persisted like the app sidebar's own
 * collapse (`qc.sidebar.collapsed`) and for the same reason: on a laptop the 18rem rail and
 * the sidebar together eat half the width of the answer you are reading, and the rail is the
 * one of the two you don't need while reading. Folded it keeps a narrow strip — the engineer
 * must be able to get back without hunting, and a rail that vanishes entirely reads as a bug.
 */
const RAIL_KEY = 'qc.chat.railFolded'

function readRailFolded(): boolean {
  try {
    return localStorage.getItem(RAIL_KEY) === '1'
  } catch {
    return false
  }
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

/**
 * Fold / unfold the whole conversation list. The same control the app sidebar uses
 * (`PanelLeftClose` / `PanelLeftOpen` + a right-side tooltip), because it does the same
 * thing one panel over — a second vocabulary for "hide this rail" on one screen is a cost
 * with no upside.
 */
function RailFoldButton({ folded, onToggle }: { folded: boolean; onToggle: () => void }) {
  const Icon = folded ? PanelLeftOpen : PanelLeftClose
  const label = folded ? 'Show conversation list' : 'Hide conversation list'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground active:scale-95"
        >
          <Icon className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
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

  const [collapsed, setCollapsed] = useState<string[]>(readCollapsedGroups)
  const toggleGroup = (label: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label]
      writeCollapsedGroups(next)
      return next
    })
  // A search that hides its own hits is a bug, not a preference: while there's a query every
  // group is open, and the remembered fold comes back the moment the box is cleared.
  const searching = !!q.trim()

  const [folded, setFolded] = useState<boolean>(readRailFolded)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const setRailFolded = (next: boolean) => {
    setFolded(next)
    try {
      localStorage.setItem(RAIL_KEY, next ? '1' : '0')
    } catch {
      /* storage unavailable — the fold just doesn't survive the page */
    }
  }
  // Unfolding to search has to land the cursor in the box: the icon in the strip IS the
  // search field as far as the reader is concerned, and an unfold that leaves them to click
  // again is the collapse costing them a step instead of saving one.
  const unfoldAndSearch = () => {
    setRailFolded(false)
    requestAnimationFrame(() => searchRef.current?.focus())
  }

  if (folded) {
    return (
      <div className="hidden md:flex">
        <div className="flex h-full w-12 flex-col items-center border-e">
          {/* h-14 + border-b, exactly like the expanded rail's search row and the chat header
              beside it — folding must not move the seam that runs across the page. */}
          <div className="flex h-14 w-full shrink-0 items-center justify-center border-b">
            <RailFoldButton folded onToggle={() => setRailFolded(false)} />
          </div>
          <div className="flex w-full flex-col items-center gap-1 py-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={unfoldAndSearch}
                  aria-label="Search chats"
                  className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Search className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Search chats</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onNew}
                  aria-label="New chat"
                  className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">New chat</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onNewTemporary}
                  aria-label="Temporary chat"
                  className="flex size-9 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <MessageSquareDashed className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Temporary chat</TooltipContent>
            </Tooltip>
          </div>
          {/* An answer being written while the rail is folded still has to be visible — that
              dot is the only place the page says a conversation you can't see is running. */}
          {chats.some((c) => c.running) && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setRailFolded(false)}
                  aria-label="A conversation is still answering"
                  className="flex size-9 items-center justify-center rounded-xl"
                >
                  <span className="qc-pulse size-2 rounded-full bg-emerald-500" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">
                {chats.filter((c) => c.running).length} conversation(s) still answering — open the
                list
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>
    )
  }

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
              ref={searchRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search chats..."
              className="h-8 border-transparent bg-transparent px-0 text-sm shadow-none focus-visible:border-transparent focus-visible:shadow-none focus-visible:ring-0"
            />
            <RailFoldButton folded={false} onToggle={() => setRailFolded(true)} />
          </div>
        </div>

        <div className="grow space-y-4 overflow-y-auto p-4 lg:space-y-8">
          {groups.length === 0 ? (
            <p className="px-3 text-xs text-muted-foreground">
              {q.trim() ? 'No conversation matches that.' : 'No conversations yet.'}
            </p>
          ) : (
            groups.map((group) => {
              const open = searching || !collapsed.includes(group.label)
              return (
                <div key={group.label}>
                  {/* px-3 = the rows' own padding, so label, row text and the search field
                      all start on one text column. The whole header is the hit target — a
                      12px chevron on its own is a miss half the time. */}
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.label)}
                    aria-expanded={open}
                    title={open ? `Collapse ${group.label}` : `Expand ${group.label}`}
                    className="mb-2 flex w-full items-center gap-1.5 rounded-lg px-3 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      className={cn('size-3 shrink-0 transition-transform', !open && '-rotate-90')}
                      aria-hidden
                    />
                    <span className="truncate">{group.label}</span>
                    {/* The count shows only while folded: open, the rows themselves are the
                        count, and a number beside every header is noise. */}
                    {!open && (
                      <span className="tabular-nums opacity-70">{group.items.length}</span>
                    )}
                  </button>
                  <div className={cn('space-y-0.5', !open && 'hidden')}>
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
                                {railTitle(c.name)}
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
              )
            })
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

/**
 * The same description, for a step that may be a THOUGHT rather than a call.
 *
 * Keyed on `kind`, never on the name: a step called "Think" that came back from a tool of
 * that name is a tool call, and quietly relabelling it would be a lie about what ran.
 */
function describeStep(c: ChatToolCall): { label: string; verb: string; Icon: LucideIcon } {
  // "Thought", past tense: the row only ever appears once the block has CLOSED, and the
  // detail beside it is how long it took — a present-tense label next to a finished
  // duration reads as though it were still going.
  if (c.kind === 'think') return { label: 'Thinking it through', verb: 'Thought', Icon: Brain }
  return describeTool(c.name)
}

function phaseOf(calls: ChatToolCall[]): { label: string; Icon: LucideIcon } {
  const last = calls[calls.length - 1]
  if (!last) return { label: 'Thinking', Icon: Sparkles }
  const { label, Icon } = describeStep(last)
  return { label, Icon }
}

/**
 * The turn's tool calls, collapsed for display: consecutive calls to the same tool with the
 * same target become one row with a count, so twelve reads of one file don't fill the bubble.
 * Distinct targets stay distinct — the target IS the information here.
 */
function stepsFrom(calls: ChatToolCall[]): (ChatToolCall & { n: number })[] {
  const out: (ChatToolCall & { n: number })[] = []
  for (const c of calls) {
    const last = out[out.length - 1]
    // Thoughts are never folded together even when identical: two thinking blocks are two
    // separate decisions, and "Think ×2" hides which one led where.
    if (last && c.kind !== 'think' && last.name === c.name && last.detail === c.detail) last.n += 1
    else out.push({ ...c, n: 1 })
  }
  return out
}

/** How many steps stay on screen; the rest are summarised as "+N earlier steps". */
const MAX_VISIBLE_STEPS = 4

/** Above this many rows a FINISHED turn's trail folds behind one line (see StepTrail). */
const COLLAPSE_STEPS_OVER = 3

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
        const { verb, Icon } = describeStep(s)
        return (
          <li
            key={`${s.kind ?? ''}${s.name}-${s.detail ?? ''}-${i}`}
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
              <span
                // A thought is a sentence; a target is a path, a pattern or a command.
                // Mono is right for the second and actively hard to read for the first.
                className={cn(
                  'min-w-0 truncate text-[11px] opacity-80',
                  s.kind !== 'think' && 'font-mono',
                )}
                title={s.detail}
              >
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
  const { label, Icon } =
    compact && !calls.length ? { label: 'Writing the answer', Icon: PenLine } : phaseOf(calls)

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

/**
 * The tool calls of a turn saved BEFORE steps were recorded — names only, no targets and
 * no positions, because that is all those transcripts contain.
 *
 * Kept as its own component rather than folded into StepTrail: the old shape genuinely
 * carries less, and drawing it in the new layout would imply the detail is missing from
 * this particular turn rather than from every turn of that era.
 */
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
 * A finished turn's steps, drawn where they happened.
 *
 * One quiet line each — icon, what it was, what it was aimed at — reading as part of the
 * answer's flow rather than as a chrome strip above it. The row is deliberately NOT a
 * card, a pill or an accordion: it sits between two paragraphs, and anything with its own
 * background there breaks the reading line the answer depends on.
 */
function StepTrail({ steps }: { steps: ChatToolCall[] }) {
  const rows = stepsFrom(steps)
  // A long turn writes eight or ten of these between two paragraphs, and the answer — the
  // thing actually being read — ends up pushed off screen by its own footnotes. Past this
  // many they fold behind ONE line that still says what they were (`Ran ×5 · Read ×2`), so
  // the trail stays checkable without being the loudest thing in the bubble. Short trails
  // are untouched: three rows were never the problem, and a toggle on them is one more
  // thing to click for nothing. Collapsed by DEFAULT — a folded trail the reader opens is
  // the whole point, and one that has to be folded first has already cost them the screen.
  // This only ever runs for a FINISHED turn; the live list (`ActivitySteps`) must keep
  // naming every step as it lands, because that is what says the turn isn't hung.
  const collapsible = rows.length > COLLAPSE_STEPS_OVER
  const [open, setOpen] = useState(false)
  if (!rows.length) return null
  return (
    <div className="my-2 flex flex-col gap-1.5">
      {collapsible && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
        >
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border/60"
            aria-hidden
          >
            <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
          </span>
          <span className="shrink-0 text-xs">{rows.length} steps</span>
          <span className="shrink-0 text-xs opacity-40" aria-hidden>
            ·
          </span>
          <span className="min-w-0 truncate text-xs opacity-70">{stepSummary(rows)}</span>
        </button>
      )}
      {(!collapsible || open) && (
        <ol
        // The `!` overrides are load-bearing: this <ol> lives INSIDE the answer's markdown
        // container, whose `[&_ol]:list-decimal [&_ol]:pl-5` and `[&_li]:my-1` are element
        // selectors and therefore outrank a plain utility class. Without them the trail is
        // drawn as a numbered list, indented past the paragraph it sits between — which is
        // exactly the alignment this row exists to keep. Flex + gap rather than space-y,
        // because forcing the li margins to zero would kill space-y's margins too.
        // The wrapper owns the outer margin now, so the list itself carries none.
        className="flex list-none! flex-col gap-1.5 pl-0! [&>li]:my-0!"
        aria-label="What this turn did here"
      >
        {rows.map((s, i) => {
          const { verb, Icon } = describeStep(s)
          return (
            <li
              key={`${s.kind ?? ''}${s.name}-${s.detail ?? ''}-${i}`}
              className="flex min-w-0 items-center gap-2 text-muted-foreground"
            >
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border/60"
                aria-hidden
              >
                <Icon className="size-3" />
              </span>
              <span className="shrink-0 text-xs">{verb}</span>
              {s.detail && (
                <>
                  <span className="shrink-0 text-xs opacity-40" aria-hidden>
                    ·
                  </span>
                  <span
                    className={cn(
                      'min-w-0 truncate text-xs opacity-70',
                      s.kind !== 'think' && 'font-mono text-[11px]',
                    )}
                    title={s.detail}
                  >
                    {s.detail}
                  </span>
                </>
              )}
              {s.n > 1 && <span className="shrink-0 text-xs tabular-nums opacity-50">×{s.n}</span>}
            </li>
          )
        })}
        </ol>
      )}
    </div>
  )
}

/**
 * `Ran ×5 · Read ×2` — what a folded trail did, in the order it did it.
 *
 * The VERB, not the tool name: it is the same word the rows themselves use, so opening the
 * fold shows exactly what the summary line promised.
 */
function stepSummary(rows: (ChatToolCall & { n: number })[]): string {
  const counts: { verb: string; n: number }[] = []
  for (const r of rows) {
    const { verb } = describeStep(r)
    const last = counts[counts.length - 1]
    if (last && last.verb === verb) last.n += r.n
    else counts.push({ verb, n: r.n })
  }
  return counts.map((c) => (c.n > 1 ? `${c.verb} ×${c.n}` : c.verb)).join(' · ')
}

/**
 * Offsets in `text` where the answer can be CUT IN TWO and both halves still render as the
 * markdown they were written as.
 *
 * Only blank lines qualify, and only outside a fenced code block: a fence has blank lines
 * inside it all the time, and splitting there paints half a code block as prose and the
 * other half as an unterminated fence. A break that would land between two items of the
 * same list is dropped too — two documents means two lists, and the second one restarts
 * its numbering at 1.
 */
function safeBreaks(text: string): number[] {
  const lines = text.split('\n')
  const out: number[] = []
  let fence: string | null = null
  let at = 0
  /** The last non-blank line seen, to tell "blank line inside a list" from "end of a list". */
  let prev = ''
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (open) fence = fence && line.trimStart().startsWith(fence) ? null : (fence ?? open[1])
    at += line.length + 1 // the '\n' that split() consumed
    if (fence || line.trim() !== '' || k === lines.length - 1) {
      if (line.trim() !== '') prev = line
      continue
    }
    const next = lines[k + 1] ?? ''
    const listish = (l: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(l) || /^\s{2,}\S/.test(l)
    if (listish(prev) && listish(next)) continue
    out.push(at)
  }
  return out
}

/** A run of the answer, or the steps that landed at one point in it. */
type AnswerPart = { text: string; steps?: undefined } | { steps: ChatToolCall[]; text?: undefined }

/**
 * Above how many pieces the answer is left whole and the steps go on top of it.
 *
 * A turn that alternates a call and a sentence forty times would otherwise render forty
 * markdown documents, and read as a chopped-up transcript rather than an answer.
 */
const MAX_ANSWER_PARTS = 13

/**
 * Put the steps back where they happened.
 *
 * Each step's `pos` is snapped BACK to the nearest safe break — never forward. A step
 * runs after the text that precedes it, so moving it earlier can put it before the
 * sentence that announced it, while snapping back only ever leaves it in the gap it
 * already belonged to. In practice the snap is a no-op: the CLI starts a new text block
 * after every tool call, and the portal writes a paragraph break between blocks, so `pos`
 * is nearly always sitting on a break already.
 */
function splitAnswer(text: string, steps: ChatToolCall[]): AnswerPart[] {
  const positioned = steps.filter((s) => typeof s.pos === 'number')
  if (!positioned.length) return [{ text }]
  // 0 and the end are always safe, and the end matters: a turn whose last act was a tool
  // call has a `pos` past every blank line, and without it that step would snap backwards
  // over the closing paragraph and read as though it ran before the conclusion.
  const breaks = [0, ...safeBreaks(text), text.length]
  const snap = (pos: number) => {
    // Skip WHITESPACE first, and only then snap back. A step recorded at the end of a
    // paragraph sits two characters short of the break, because the blank line that ends
    // that paragraph isn't written until the model starts the NEXT one — which happens
    // after the call returns. Without this, every step lands one paragraph too early:
    // measured on the first live turn, a `Bash` that ran after "I'll list the files
    // first." was drawn above that sentence. Whitespace-only means no text is skipped,
    // so this can never move a step past something the model actually said.
    let p = pos
    while (p < text.length && /\s/.test(text[p])) p++
    let best = 0
    for (const b of breaks) if (b <= p) best = b
    return best
  }
  const byBreak = new Map<number, ChatToolCall[]>()
  for (const s of positioned) {
    const b = snap(s.pos as number)
    const bucket = byBreak.get(b)
    if (bucket) bucket.push(s)
    else byBreak.set(b, [s])
  }
  const parts: AnswerPart[] = []
  let cursor = 0
  for (const b of [...byBreak.keys()].sort((x, y) => x - y)) {
    const chunk = text.slice(cursor, b)
    if (chunk.trim()) parts.push({ text: chunk })
    parts.push({ steps: byBreak.get(b)! })
    cursor = b
  }
  const tail = text.slice(cursor)
  if (tail.trim()) parts.push({ text: tail })
  if (parts.length > MAX_ANSWER_PARTS) {
    return [{ steps: positioned }, ...(text.trim() ? [{ text }] : [])]
  }
  return parts
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
/**
 * WHAT THE MODEL WAS ACTUALLY SENT, under the question that was typed.
 *
 * A turn is never just the words in the bubble: the portal appends the resolved `@`/`/`
 * picks, the absolute paths of pasted images, the `+` menu action's instructions, and —
 * when a lapsed CLI session is replayed — a summary of the conversation so far. All of
 * that steers the answer, and until now none of it appeared anywhere, so "why did it
 * answer that?" had no answer available to the person reading it. Since this page's
 * output ends up in test cases and bug reports, that gap is what stops people trusting it.
 *
 * Collapsed by default — this is an audit trail, not part of the conversation. One row
 * per block; opening one shows the exact text (server-capped, and it says so inline).
 */
function ContextRows({ blocks }: { blocks: ContextBlock[] }) {
  const [open, setOpen] = useState<number | null>(null)
  if (!blocks.length) return null
  return (
    <div className="mt-1.5 flex flex-col items-end gap-1">
      {blocks.map((b, i) => (
        <div key={`${b.label}-${i}`} className="w-full">
          <button
            type="button"
            onClick={() => setOpen((cur) => (cur === i ? null : i))}
            aria-expanded={open === i}
            className={cn(
              'ms-auto flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1',
              'text-[11px] text-muted-foreground transition-colors hover:border-border hover:text-foreground',
            )}
          >
            <FileText className="size-3" />
            <span>Context sent · {b.label}</span>
            <ChevronDown
              className={cn('size-3 transition-transform', open === i && 'rotate-180')}
            />
          </button>
          {open === i && (
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/50 p-2.5 text-start font-mono text-[11px] leading-relaxed text-muted-foreground">
              {b.text}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * WHAT THIS TURN TOOK — in the answer's footer, beside the model that wrote it.
 *
 * A chat turn here is not cheap: a full-tools Opus question runs for minutes and costs
 * real money. "Why was that one slow?" has two completely different answers — the model
 * wrote a lot, or one bash command took four minutes — and only time-to-first-token
 * against total time tells them apart. A week later the transcript is the only place
 * that question can still be answered, so the numbers live there rather than on screen
 * for a moment.
 *
 * Every value came free with the turn (the CLI reports them on its final event), and they
 * arrive ONCE, when it ends — this must never become a meter that ticks per delta, which
 * is exactly the kind of per-frame work the transcript's memoisation exists to avoid.
 */
function TurnStatsLine({ stats }: { stats: TurnStats }) {
  const parts: string[] = [`Ran ${fmtDuration(stats.ms)}`]
  if (stats.ttftMs !== undefined) parts.push(`first token ${fmtDuration(stats.ttftMs)}`)
  if (stats.inputTokens !== undefined || stats.outputTokens !== undefined) {
    parts.push(`${fmtTokens(stats.inputTokens ?? 0)} in / ${fmtTokens(stats.outputTokens ?? 0)} out`)
  }
  // Share of the input that the provider served from its warm prefix cache — the reason a
  // long conversation doesn't cost its whole history again on every turn.
  if (stats.cacheReadTokens && stats.inputTokens) {
    parts.push(`${Math.round((stats.cacheReadTokens / stats.inputTokens) * 100)}% cached`)
  }
  // Sub-cent turns round to $0.00, which reads as free; show them as a floor instead.
  if (stats.costUsd) parts.push(stats.costUsd < 0.01 ? '<$0.01' : `$${stats.costUsd.toFixed(2)}`)
  return (
    <>
      <span className="px-1.5 text-[11px] text-muted-foreground">•</span>
      <span className="text-[11px] text-muted-foreground">{parts.join(' · ')}</span>
    </>
  )
}

/** `847ms` / `12s` / `4m 30s` — whichever reads without arithmetic. */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rest = s % 60
  return rest ? `${m}m ${rest}s` : `${m}m`
}

/** `8.8K` rather than `8823` — this is a size, not a count anyone will add up. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/**
 * MESSAGES WAITING THEIR TURN, under the answer they're queued behind.
 *
 * They are drawn as the questions they are — same side, same shape as a sent message — but
 * dimmed and outlined rather than solid, because they have not been asked yet. Each carries
 * its own cancel: a follow-up typed in the middle of a long answer is quite often answered
 * BY that answer, and the alternative would be letting it run and then stopping it.
 */
function QueuedRows({
  items,
  onCancel,
}: {
  items: QueuedChatMessage[]
  onCancel: (id: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((m, i) => (
        <div key={m.id} className="flex justify-end gap-3">
          <div className="max-w-[85%] flex-1 justify-end text-end sm:max-w-[75%]">
            <div className="mb-1 flex items-center justify-end gap-1.5 pe-1 text-[11px] text-muted-foreground">
              <Clock className="size-3" />
              <span>{i === 0 ? 'Next in this conversation' : `Waiting · ${i + 1}`}</span>
            </div>
            <div className="inline-flex items-start gap-2 rounded-lg border border-dashed border-border/70 bg-muted/40 p-3 text-start text-sm text-muted-foreground">
              <span className="whitespace-pre-wrap break-words">{m.prompt}</span>
              <button
                type="button"
                onClick={() => onCancel(m.id)}
                aria-label="Cancel this queued message"
                className="mt-0.5 shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
          <RowAvatar who="user" />
        </div>
      ))}
    </div>
  )
}

function UserRow({
  text,
  images,
  previews,
  projectId,
  at,
  action,
  context,
}: {
  text: string
  images?: string[]
  previews?: string[]
  projectId?: string
  at?: string
  /** The `+` menu action this message ran with — shown, because it changes the answer. */
  action?: ChatAction | null
  /** Blocks the portal appended to this message before sending it (see ContextRows). */
  context?: ContextBlock[]
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
        {context && context.length > 0 && <ContextRows blocks={context} />}
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
 * The model has started writing the SUGGESTIONS marker — i.e. THE ANSWER IS FINISHED and
 * everything still arriving is a line the reader will never see.
 *
 * Without this the turn looked like it was still thinking after it had visibly stopped:
 * the caret blinked and the waiting indicator kept counting while the only thing streaming
 * was a stripped HTML comment. The answer settles as soon as this flips, and the wait for
 * the follow-up chips gets its own small indicator instead of holding the whole reply open.
 *
 * Detected as "stripping removed something" rather than by searching for `<!--`, so it
 * stays in step with `stripSuggestMarker` — including its half-written `<!--` tail case.
 */
function suggestMarkerStarted(raw: string): boolean {
  return stripSuggestMarker(raw).length < raw.trimEnd().length
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
    // `ps-12` = the avatar column (`size-8`) plus the row's `gap-3` plus `RowName`'s own
    // `ps-1`, so the row starts on the same edge as the "AI Assistant" label and the bubble
    // under it. It renders OUTSIDE `Turn` (see above) and so has to reproduce that indent
    // by hand; `SuggestingChips`, which sits inside the column, needs only the `ps-1`.
    <div className="flex w-full flex-wrap items-center gap-2 ps-12 pe-1">
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

/**
 * The gap between "the answer finished" and "the chips arrived" — the tail of the turn
 * where the model is writing the SUGGESTIONS marker and nothing visible is happening.
 *
 * It deliberately mirrors `FollowUps`' own row (aligned to the same left edge — this one
 * is already inside the message column, so it needs `ps-1` where that one spells out
 * `ps-12` — same "Ask next" label slot,
 * two chip-shaped placeholders) so the real chips replace it in place instead of the
 * layout jumping when they land. Skeleton, not a spinner: it says WHAT is coming.
 */
function SuggestingChips() {
  return (
    <div className="flex w-full flex-wrap items-center gap-2 ps-1 pe-1" aria-hidden>
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        Ask next
      </span>
      {['w-40', 'w-28'].map((w) => (
        <span
          key={w}
          className={cn('qc-skeleton h-7 rounded-full border border-border/60 bg-card', w)}
        />
      ))}
    </div>
  )
}

/** A note's title from the question that produced the answer — first line, one sentence-ish. */
function noteTitleFrom(question: string | undefined, answer: string): string {
  const source = (question ?? '').trim() || answer.trim()
  const firstLine = source
    .split('\n')
    .map((line) => line.replace(/^#+\s*/, '').trim())
    .find((line) => line.length > 0)
  if (!firstLine) return 'Chat answer'
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine
}

/**
 * Save this answer to `/notes` — the one action an answer worth keeping needs that Copy can't
 * do (a copied answer lives in a clipboard nobody can search a week later). It writes a
 * workspace note through the SAME `POST /api/notes` the Notes page uses, so a note created
 * here is an ordinary note: labelable, editable, trashable there. The question rides along as
 * the title (and a quoted first line), because an answer with no question above it is a
 * paragraph nobody can place.
 */
function SaveToNoteButton({
  answer,
  question,
  projectId,
}: {
  answer: string
  question?: string
  projectId: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [saved, setSaved] = useState(false)
  const save = useMutation({
    mutationFn: () =>
      createWorkspaceNote(
        {
          title: noteTitleFrom(question, answer),
          body: question?.trim() ? `> ${question.trim().replace(/\n/g, '\n> ')}\n\n${answer}` : answer,
        },
        projectId,
      ),
    onSuccess: () => {
      setSaved(true)
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', projectId] })
      toast.success('Saved to Notes', {
        action: { label: 'Open Notes', onClick: () => navigate('/notes') },
      })
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not save the note'),
  })
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={save.isPending}
          onClick={() => save.mutate()}
          className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
        >
          {save.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : saved ? (
            <Check className="size-4 text-emerald-500" />
          ) : (
            <NotebookPen className="size-4" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>{saved ? 'Saved to Notes' : 'Save this answer to Notes'}</TooltipContent>
    </Tooltip>
  )
}

/**
 * 👍 / 👎 UNDER AN ANSWER — the control that teaches the project.
 *
 * It is deliberately NOT a satisfaction survey: nothing here is counted, scored or sent
 * anywhere. A vote runs `POST /:slug/feedback`, which reflects on the question, the answer
 * and the vote with a cheap model and writes the durable fact behind it into the project's
 * MEMORY — the same `testing/memory` folder every later chat turn already reads. So the
 * honest description of the button is "remember this", and the toast says which note it
 * wrote rather than thanking the engineer for their feedback.
 *
 * Three things follow from that, and they are why this isn't three lines of JSX:
 *
 * - **A 👎 asks WHY, and takes no for an answer.** The reason is by far the most useful
 *   input the capture gets ("the orders API is v2" beats inferring a mistake from a wrong
 *   answer), so the dialog asks for it — and sends without one if the engineer would rather
 *   not, because a required box is how a feedback control gets ignored forever. A 👍 asks
 *   nothing: the answer itself is the evidence.
 * - **The note becomes a FILE in the repo**, so the dialog says so, and says not to paste
 *   credentials into it. The portal's rule is that a secret never reaches disk, and this is
 *   the one box on the page whose contents are written to a versioned project folder.
 * - **Un-voting does not un-remember.** Clearing a rating drops the vote and leaves the
 *   note, which by then is an ordinary project fact somebody may already have edited on the
 *   Memory tab. The toast says where it is instead of quietly deleting project context.
 *
 * The vote shows immediately from local state (the mutation is the slow part — the capture
 * is a model call), while the refetched transcript carries the durable record.
 */
function AnswerFeedback({
  projectId,
  slug,
  index,
  feedback,
}: {
  projectId: string
  slug: string
  /** The answer's position in the transcript — what the server rates. */
  index: number
  /** The rating already stored with this message, if it has one. */
  feedback?: ChatFeedback
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [vote, setVote] = useState<'up' | 'down' | null>(feedback?.vote ?? null)
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const rate = useMutation({
    mutationFn: (v: { vote: 'up' | 'down' | null; note?: string }) =>
      rateChatAnswer(projectId, slug, index, v.vote, v.note),
    onSuccess: (r, v) => {
      setVote(v.vote)
      setAsking(false)
      setNote('')
      queryClient.invalidateQueries({ queryKey: ['chat', projectId, slug] })
      if (!v.vote) {
        toast.success('Rating removed', {
          description: 'Anything it already remembered stays on the Memory tab.',
        })
        return
      }
      const names = r.feedback?.captured ?? []
      if (!names.length) {
        toast.success('Noted', { description: 'Nothing durable to remember from this one.' })
        return
      }
      queryClient.invalidateQueries({ queryKey: ['memory', projectId] })
      toast.success(`Remembered — ${names.join(', ')}`, {
        description: 'Later answers in this project read this.',
        action: { label: 'Open Memory', onClick: () => navigate('/instructions?tab=memory') },
      })
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not save that rating'),
  })
  const busy = rate.isPending
  const btn = (active: boolean) =>
    cn(
      'flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60',
      active && 'text-emerald-500 hover:text-emerald-500',
    )
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-pressed={vote === 'up'}
            onClick={() => rate.mutate({ vote: vote === 'up' ? null : 'up' })}
            className={btn(vote === 'up')}
          >
            {busy && vote !== 'down' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ThumbsUp className={cn('size-4', vote === 'up' && 'fill-current')} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {vote === 'up'
            ? 'Rated good — click to undo. Anything already remembered stays on the Memory tab.'
            : 'Good answer — the AI saves what makes it right to project memory, so later answers use it.'}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={busy}
            aria-pressed={vote === 'down'}
            // Undoing needs no reason; giving one does — hence the dialog on the way in only.
            onClick={() => (vote === 'down' ? rate.mutate({ vote: null }) : setAsking(true))}
            className={cn(
              'flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60',
              vote === 'down' && 'text-amber-600 hover:text-amber-600 dark:text-amber-500',
            )}
          >
            {busy && vote === 'down' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ThumbsDown className={cn('size-4', vote === 'down' && 'fill-current')} />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {vote === 'down'
            ? 'Rated wrong — click to undo. Anything already remembered stays on the Memory tab.'
            : 'Wrong or unhelpful — say what it got wrong and the AI remembers the correction.'}
        </TooltipContent>
      </Tooltip>
      <Dialog open={asking} onOpenChange={(o) => !o && setAsking(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>What was wrong with this answer?</DialogTitle>
            <DialogDescription>
              Optional — but it is what makes the difference. The AI turns it into a note in this
              project&apos;s memory, so later answers stop repeating the mistake. It becomes a file
              in the project, so don&apos;t paste credentials or codes.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={4}
            autoFocus
            placeholder="e.g. the orders API is v2 — v1 was removed in July"
            className="resize-none"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => rate.mutate({ vote: 'down' })} disabled={busy}>
              Skip
            </Button>
            <Button
              onClick={() => rate.mutate({ vote: 'down', note: note.trim() || undefined })}
              disabled={busy}
            >
              {busy && <Loader2 className="size-4 animate-spin" />}
              Save and remember
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * FILES THIS ANSWER NAMED THAT AREN'T THERE — the free accuracy check, drawn.
 *
 * The server checked every project path in the answer with one `existsSync` each (no AI,
 * no tokens, ~1 ms — see `answerCheck.ts`), and these are the ones that don't exist. It is
 * the single most common concrete way an answer is wrong, and the only one that can be
 * caught for certain and for free.
 *
 * Worded as "not found", never "wrong", and amber rather than red, because a missing path
 * has three innocent explanations as well as the bad one: the answer PROPOSED the file, it
 * was written before the file was deleted, or the model typed a near-miss of a real path.
 * The strip's job is to send the reader to look, not to overrule the answer.
 */
function MissingRefs({ refs }: { refs: string[] }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-500">
      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-medium">
          {refs.length === 1 ? 'This file' : `These ${refs.length} files`} named above{' '}
          {refs.length === 1 ? "isn't" : "aren't"} in the project — check before relying on{' '}
          {refs.length === 1 ? 'it' : 'them'}.
        </p>
        <p className="break-all font-mono text-[11px] opacity-80">{refs.join('  ·  ')}</p>
      </div>
    </div>
  )
}

/** How each checked claim is drawn. `wrong` is the only status that means "the answer is
 *  defective"; `unverified` says the auditor looked and couldn't confirm, which is honest
 *  and common — colouring it red would train the reader to ignore the whole panel. */
const CLAIM_LOOK: Record<
  AuditClaim['status'],
  { icon: LucideIcon; tone: string; label: string }
> = {
  supported: { icon: CircleCheck, tone: 'text-emerald-600 dark:text-emerald-500', label: 'Confirmed' },
  wrong: { icon: TriangleAlert, tone: 'text-destructive', label: 'Contradicted' },
  // A defect claim whose EXPECTED half rests on nothing this project says. The observation
  // may well be right — only the jump to "this is a bug" isn't — so it is amber, not red.
  unsupported: {
    icon: ShieldAlert,
    tone: 'text-amber-600 dark:text-amber-500',
    label: 'Called a bug, but nothing requires it',
  },
  unverified: { icon: CircleHelp, tone: 'text-muted-foreground', label: 'Not confirmed' },
}

/** The one-line headline for a finished check, and the tint of its border. */
function auditHeadline(audit: ChatAudit): { text: string; tone: string } {
  const wrong = audit.claims.filter((c) => c.status === 'wrong').length
  const ok = audit.claims.filter((c) => c.status === 'supported').length
  const open = audit.claims.filter((c) => c.status === 'unverified').length
  const loose = audit.claims.filter((c) => c.status === 'unsupported').length
  if (audit.skipped) {
    return { text: `The check did not finish — ${audit.skipped}. Nothing was verified.`, tone: 'border-border/60' }
  }
  if (audit.verdict === 'none') {
    return {
      text: 'Nothing here to check against the project — this answer makes no factual claim about it.',
      tone: 'border-border/60',
    }
  }
  if (audit.verdict === 'issues') {
    // Two different failures share this verdict, and they lead the sentence differently: a
    // contradiction means the answer is wrong, an unsupported defect means it called
    // something a bug that nothing in the project asks for. Amber when only the latter.
    const parts: string[] = []
    if (wrong) parts.push(`${wrong} claim${wrong === 1 ? '' : 's'} the project contradicts`)
    if (loose)
      parts.push(`${loose} "bug${loose === 1 ? '' : 's'}" nothing in the project requires`)
    if (ok) parts.push(`${ok} confirmed`)
    if (open) parts.push(`${open} not confirmed`)
    return {
      text: `${parts.join(', ')}.`,
      tone: wrong ? 'border-destructive/40' : 'border-amber-500/40',
    }
  }
  if (audit.verdict === 'clean') {
    return {
      text: `${ok} claim${ok === 1 ? '' : 's'} confirmed against the files${open ? `, ${open} could not be confirmed` : ''}.`,
      tone: 'border-emerald-500/30',
    }
  }
  return {
    text: `Nothing could be confirmed either way — ${open} claim${open === 1 ? '' : 's'} left open.`,
    tone: 'border-amber-500/30',
  }
}

/**
 * THE FACT CHECK, drawn under the answer it is about.
 *
 * Collapsed to its headline unless something was CONTRADICTED — the point of the check is
 * the one claim that doesn't hold, and making the reader expand a panel to find out
 * whether there is one wastes the 40 seconds they just spent. A clean result is a single
 * reassuring line they can open if they want the citations.
 */
function AuditPanel({ audit, pending }: { audit?: ChatAudit; pending?: boolean }) {
  const [open, setOpen] = useState(false)
  // Deliberately derived, not state: the first render of a result with contradictions must
  // already be expanded, and an effect would flash the collapsed version first.
  const expanded = open || (!pending && audit?.verdict === 'issues')
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Re-reading the project to check this answer — this takes a while, and you can keep working.
      </div>
    )
  }
  if (!audit) return null
  const head = auditHeadline(audit)
  return (
    <div className={cn('rounded-2xl border bg-muted/40 text-xs', head.tone)}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left"
        aria-expanded={expanded}
      >
        <SearchCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="block font-medium text-foreground">Fact check · {head.text}</span>
          <span className="block text-[11px] text-muted-foreground">
            {shortModel(audit.model)} re-read the project · {new Date(audit.at).toLocaleString()}
          </span>
        </span>
        {!!audit.claims.length && (
          <ChevronDown
            className={cn('mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')}
          />
        )}
      </button>
      {expanded && !!audit.claims.length && (
        <ul className="space-y-2 border-t border-border/60 px-3 py-2">
          {audit.claims.map((c, i) => {
            const look = CLAIM_LOOK[c.status]
            return (
              <li key={i} className="flex items-start gap-2">
                <look.icon className={cn('mt-0.5 size-3.5 shrink-0', look.tone)} />
                <div className="min-w-0 space-y-0.5">
                  <p className="text-foreground">{c.claim}</p>
                  <p className="text-[11px] text-muted-foreground">
                    <span className={look.tone}>{look.label}</span>
                    {c.evidence ? ` — ${c.evidence}` : ''}
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

/**
 * Run (or re-run) the fact check on one stored answer.
 *
 * Lives here rather than inside the button because the button and the RESULT sit in two
 * different places in the row — the icon belongs with Copy and the 👍/👎, the panel belongs
 * under the answer — and both need to know it is running.
 */
function useAnswerAudit(projectId?: string, slug?: string, index?: number) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => auditChatAnswer(projectId!, slug!, index!),
    onSuccess: (r) => {
      // Refetch so the verdict is read back off the stored message: the panel then shows
      // exactly what a reader who reopens this conversation tomorrow will see.
      queryClient.invalidateQueries({ queryKey: ['chat', projectId, slug] })
      if (r.audit.skipped) {
        toast.error('The fact check did not finish', { description: r.audit.skipped })
        return
      }
      const wrong = r.audit.claims.filter((c) => c.status === 'wrong').length
      const loose = r.audit.claims.filter((c) => c.status === 'unsupported').length
      if (wrong || loose) {
        toast.warning(auditHeadline(r.audit).text, { description: 'Opened below the answer.' })
      } else if (r.audit.verdict === 'clean') {
        toast.success('Checked — nothing contradicted', {
          description: `${r.audit.claims.length} claim(s) re-read against the files.`,
        })
      } else {
        toast.success('Checked', { description: auditHeadline(r.audit).text })
      }
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not check this answer'),
  })
}

/** A highlighted passage and where to float the button. Viewport coordinates, because the
 *  bubble is `position: fixed` — the transcript scroller is not a usable offset parent. */
interface SelectionAnchor {
  text: string
  /** Vertical middle of the selection's last line. */
  top: number
  /** Where the selection ENDS — the bubble sits just past it, where the cursor was released. */
  left: number
}

/**
 * The passage currently highlighted inside an ANSWER, or null.
 *
 * Reads on pointer/key RELEASE rather than on `selectionchange`: the latter fires on every
 * character as a drag grows, so the bubble would chase the cursor across the paragraph instead
 * of appearing once, where the drag ended.
 */
function useAnswerSelection(scrollerRef: React.RefObject<HTMLDivElement | null>) {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)
  // The bubble itself, so a click on it isn't read as "clicked away".
  const bubbleRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const read = () => {
      const sel = window.getSelection()
      const scroller = scrollerRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !scroller) return setAnchor(null)
      const text = sel.toString().trim()
      if (!text) return setAnchor(null)
      const range = sel.getRangeAt(0)
      const host = range.commonAncestorContainer
      const el = host.nodeType === Node.ELEMENT_NODE ? (host as Element) : host.parentElement
      if (!el || !scroller.contains(el) || !el.closest('[data-answer]')) return setAnchor(null)
      // The LAST client rect, not the bounding box: over several lines the bounding box's
      // right edge is the widest line's, which can be nowhere near where the drag stopped.
      const rects = range.getClientRects()
      const rect = rects[rects.length - 1] ?? range.getBoundingClientRect()
      if (!rect || (rect.width === 0 && rect.height === 0)) return setAnchor(null)
      setAnchor({ text, top: rect.top + rect.height / 2, left: rect.right })
    }
    // A tick late on purpose — on `mouseup` the selection isn't final yet.
    const onRelease = () => window.setTimeout(read, 0)
    const onDown = (e: MouseEvent) => {
      if (bubbleRef.current?.contains(e.target as Node)) return
      setAnchor(null)
    }
    document.addEventListener('mouseup', onRelease)
    document.addEventListener('keyup', onRelease)
    document.addEventListener('mousedown', onDown)
    // Re-anchor rather than hide: the selection stays highlighted while the transcript scrolls
    // (which it does on its own while an answer streams), and a button that vanishes then reads
    // as broken. Capture, because the scroller's own scroll event doesn't reach document.
    document.addEventListener('scroll', read, true)
    window.addEventListener('resize', read)
    return () => {
      document.removeEventListener('mouseup', onRelease)
      document.removeEventListener('keyup', onRelease)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('scroll', read, true)
      window.removeEventListener('resize', read)
    }
  }, [scrollerRef])
  return { anchor, setAnchor, bubbleRef }
}

/**
 * Highlight a passage in an answer and save just that — floated beside the selection.
 *
 * The footer button saves the WHOLE answer, which is the wrong unit most of the time: the part
 * worth keeping is usually one paragraph, one command, one field list out of a long reply, and
 * the alternative is saving the lot and editing it down on `/notes`.
 */
function SelectionNoteBubble({
  scrollerRef,
  projectId,
}: {
  scrollerRef: React.RefObject<HTMLDivElement | null>
  projectId: string
}) {
  const { anchor, setAnchor, bubbleRef } = useAnswerSelection(scrollerRef)
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (text: string) =>
      createWorkspaceNote({ title: noteTitleFrom(undefined, text), body: text }, projectId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspace-notes', projectId] })
      toast.success('Selection saved to Notes')
      // Drop the highlight with the bubble: leaving it up over text that's already saved
      // invites a second identical note.
      window.getSelection()?.removeAllRanges()
      setAnchor(null)
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Could not save the note'),
  })
  if (!anchor) return null
  // Clamped so a selection ending at the right edge of the window doesn't push the bubble
  // off screen (and widen the document doing it).
  const left = Math.min(anchor.left + 8, window.innerWidth - 44)
  return createPortal(
    <div
      ref={bubbleRef}
      // The selection must survive the click: a mousedown anywhere collapses it, and the
      // handler reads `anchor.text` — but the browser would also have cleared the highlight
      // under the user before the toast lands.
      onMouseDown={(e) => e.preventDefault()}
      style={{ top: anchor.top, left }}
      className="fixed z-50 -translate-y-1/2"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate(anchor.text)}
            aria-label="Save the selected text to Notes"
            className="flex size-8 items-center justify-center rounded-full border border-border/60 bg-popover text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground disabled:opacity-60"
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <NotebookPen className="size-4" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top">Save selection to Notes</TooltipContent>
      </Tooltip>
    </div>,
    document.body,
  )
}

function AssistantRow({
  text,
  tools,
  steps,
  calls,
  streaming,
  failed,
  at,
  model,
  effort,
  stats,
  question,
  projectId,
  slug,
  index,
  feedback,
  refs,
  audit,
}: {
  text: string
  /** A saved turn's tool names — the trail above the answer, for pre-`steps` transcripts. */
  tools?: string[]
  /** A saved turn's steps, with targets and positions — drawn inside the answer. */
  steps?: ChatToolCall[]
  /** The in-flight turn's calls, with targets. Live only; never persisted. */
  calls?: ChatToolCall[]
  streaming?: boolean
  failed?: boolean
  at?: string
  model?: string
  /** Only set when the turn ran at a chosen effort — a default-effort turn shows nothing. */
  effort?: ChatEffort
  /** What the turn took and cost — absent while it's still streaming. */
  stats?: TurnStats
  /** The question this answer replied to — titles the note the save button writes. */
  question?: string
  /** Omitted while the project is unknown; without it there's nowhere to save a note. */
  projectId?: string
  /** The conversation this answer belongs to — a rating addresses a stored message. */
  slug?: string
  /** Its position in the transcript. Absent on the streaming turn, which isn't stored yet. */
  index?: number
  /** The rating already on this answer, if any — see AnswerFeedback. */
  feedback?: ChatFeedback
  /** Files this answer named that aren't on disk — the free check (see MissingRefs). */
  refs?: string[]
  /** The fact check already run on this answer, if any — see AuditPanel. */
  audit?: ChatAudit
}) {
  // While streaming, what's on screen trails the received text by a few frames on purpose
  // (see useSmoothReveal). A saved message renders whole — and was already stripped of the
  // suggestions marker server-side, so it costs nothing there.
  const body = streaming ? stripSuggestMarker(text) : text
  const visible = useSmoothReveal(body, !!streaming)
  // The TURN is still open (the server hasn't sent `done`), but the ANSWER is over: the
  // marker has started and the reveal has caught up to the last visible character. From
  // here the row renders exactly like a finished one — no caret, no waiting indicator,
  // Copy available — and only the small chip below says the chips are still coming.
  const answerSettled = !!streaming && suggestMarkerStarted(text) && visible.length >= body.length
  const live = !!streaming && !answerSettled
  // Interleaved only once the turn is FINISHED. While it streams there is exactly one
  // markdown document, as before: the reveal animation walks a single growing string, and
  // re-segmenting it on every frame would re-parse the whole answer many times a second
  // for a layout the reader is about to see settle anyway. The live trail below the text
  // is already showing these same steps, in order, with their targets.
  const parts = useMemo<AnswerPart[]>(
    () => (streaming || !steps?.length ? [{ text: visible }] : splitAnswer(visible, steps)),
    [visible, steps, streaming],
  )
  // Evidence images this answer cited (see collectImageRefs). Not while it streams: half a
  // path is not a path, and the chips would flicker in as the text arrives.
  const imageRefs = useMemo(() => (live ? [] : collectImageRefs(body)), [body, live])
  const resolvedImages = useResolvedImages(projectId, imageRefs)
  const [openImage, setOpenImage] = useState<string | null>(null)
  const hasImageRefs = !!resolvedImages && Object.keys(resolvedImages).length > 0
  // The shared module-level identity for every answer without evidence — only one that
  // cites a real image gets its own `components`, and only after the check came back.
  const components = useMemo(() => {
    if (live) return MD_COMPONENTS_STREAMING
    if (!hasImageRefs) return MD_COMPONENTS
    return imageRefComponents(resolvedImages!, setOpenImage)
  }, [live, hasImageRefs, resolvedImages])
  // Unconditional, as a hook must be — whether the answer can be checked is decided at the
  // button below (a streaming turn has no stored position to check yet).
  const auditRun = useAnswerAudit(projectId, slug, index)
  const canAudit = !!projectId && !!slug && index !== undefined && !failed
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
            {/* Only for a transcript from before steps were recorded — a turn that HAS
                steps draws them inside the answer, in the places they happened. */}
            {!live && !steps?.length && <ToolTrail tools={tools ?? []} />}
            {/* Keyed, and the indicator stays MOUNTED once text starts arriving — it just
                goes compact and moves below the answer. Remounting it there would restart
                its elapsed timer from zero mid-answer. */}
            {visible && (
              /* `data-answer` is what `useAnswerSelection` matches on: highlighting your own
                 question, a tool chip or the composer has nothing to save to a note. */
              <div key="answer" data-answer className={MD_CLASS}>
                {/* The caret is a CHARACTER appended to the text, not an element beside the
                    markdown: markdown renders blocks, so a sibling <span> would sit on its
                    own line under the answer instead of at the end of the last one. */}
                {parts.map((p, i) =>
                  p.steps ? (
                    <StepTrail key={`s${i}`} steps={p.steps} />
                  ) : (
                    <ReactMarkdown key={`t${i}`} remarkPlugins={[remarkGfm]} components={components}>
                      {live && i === parts.length - 1 ? `${p.text}▊` : p.text}
                    </ReactMarkdown>
                  ),
                )}
              </div>
            )}
            {(live || !visible) && (
              <ThinkingBubble key="waiting" calls={calls ?? []} compact={!!visible} startedAt={at} />
            )}
          </div>
          {/* Accuracy, directly under the answer rather than in the icon row: both of these
              qualify what was just said, and a reader who trusts a wrong line has already
              stopped reading by the time they reach a row of buttons. Neither is drawn while
              the turn streams — the checks run against the SAVED answer. */}
          {!live && !!refs?.length && <MissingRefs refs={refs} />}
          {!live && (auditRun.isPending || !!audit) && (
            <AuditPanel audit={audit} pending={auditRun.isPending} />
          )}
          {/* The answer is done; only the follow-up chips are outstanding. Its own quiet
              line, in the slot the chips will take, so the reply itself reads as finished. */}
          {answerSettled && <SuggestingChips />}
          {!live && body && (
            <div className="flex items-center gap-0 text-muted-foreground opacity-100 transition-opacity duration-150">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() =>
                      // `body`, not `text`: while the marker is still streaming the raw
                      // text carries a comment the reader never saw and must not copy.
                      void copyText(body).then((ok) =>
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
              {/* Same `body` as Copy, for the same reason: the raw text may still carry the
                  suggestions marker, which must never land in a saved note. */}
              {projectId && !failed && (
                <SaveToNoteButton answer={body} question={question} projectId={projectId} />
              )}
              {/* Only for a STORED answer: rating one addresses it by its position in the
                  transcript, and the turn still streaming has no position yet. It gets its
                  buttons a moment later, when the finished transcript is refetched. */}
              {projectId && slug && index !== undefined && !failed && (
                <AnswerFeedback
                  projectId={projectId}
                  slug={slug}
                  index={index}
                  feedback={feedback}
                />
              )}
              {/* Fact-check. Same "stored answer only" rule as the rating — and deliberately
                  a BUTTON: it re-reads the project with a second model, so it costs a real
                  minute and is worth it for the answer you're about to act on, not for every
                  question asked while pairing. */}
              {canAudit && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => auditRun.mutate()}
                      disabled={auditRun.isPending}
                      aria-label="Fact-check this answer"
                      className="flex size-9 items-center justify-center rounded-full transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
                    >
                      {auditRun.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <SearchCheck className={cn('size-4', audit && 'text-emerald-600 dark:text-emerald-500')} />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    {auditRun.isPending
                      ? 'Checking this answer against the project…'
                      : audit
                        ? 'Check again — a second model re-reads the project and re-rates every factual claim in this answer.'
                        : 'Check the facts. A second model re-reads the project and says which claims in this answer hold up, which the files contradict, and which it could not confirm. Takes a minute and costs a little — worth it before you act on the answer.'}
                  </TooltipContent>
                </Tooltip>
              )}
              <MessageTime at={at} />
              {model && (
                <>
                  <span className="px-1.5 text-[11px] text-muted-foreground">•</span>
                  <span className="text-[11px] text-muted-foreground" title={model}>
                    {shortModel(model)}
                  </span>
                  {/* Muted and unlabelled next to the model, the way the CLI itself shows
                      it — an absent effort means "your own default", not "unknown". */}
                  {effort && effort !== 'default' && effort !== DEFAULT_EFFORT && (
                    <span
                      className="ps-1 text-[11px] text-muted-foreground/70"
                      title={`Reasoning effort: ${effortLabel(effort)}`}
                    >
                      {effortLabel(effort).toLowerCase()}
                    </span>
                  )}
                </>
              )}
              {stats && <TurnStatsLine stats={stats} />}
            </div>
          )}
        </div>
      </div>
      {/* The evidence viewer. Rendered only while a chip is open, so an answer with no
          screenshots costs nothing. */}
      {openImage && projectId && resolvedImages?.[openImage] && (
        <ImageRefDialog
          projectId={projectId}
          cited={openImage}
          rel={resolvedImages[openImage]}
          onClose={() => setOpenImage(null)}
        />
      )}
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
const Turn = memo(function Turn({
  m,
  projectId,
  question,
  slug,
  index,
}: {
  m: ChatMessage
  projectId: string
  /** The user message above this one — a plain string, so the memo still holds. */
  question?: string
  /** Conversation + position, which is how a rating addresses this answer. */
  slug?: string
  index?: number
}) {
  return m.role === 'user' ? (
    <UserRow
      text={m.text}
      images={m.images}
      projectId={projectId}
      at={m.at}
      action={m.action}
      context={m.context}
    />
  ) : (
    <AssistantRow
      text={m.text}
      tools={m.tools}
      steps={m.steps}
      failed={m.error}
      at={m.at}
      model={m.model}
      effort={m.effort}
      stats={m.stats}
      question={question}
      projectId={projectId}
      slug={slug}
      index={index}
      feedback={m.feedback}
      refs={m.refs}
      audit={m.audit}
    />
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
  const file = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'chat'}.md`
  a.href = url
  a.download = file
  a.click()
  URL.revokeObjectURL(url)
  // Say so explicitly. In a browser tab Chromium's own download bubble is the
  // confirmation; the desktop-app window (`qc-portal --app`) has NO toolbar and so
  // no bubble, and a save with no feedback reads as a button that does nothing.
  toast.success('Transcript downloaded', { description: file })
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
  // pe-[6.5rem] keeps this row clear of the FIXED chrome cluster that floats over it on
  // /chat — NotificationBell (`right-4`) and ThemeToggle (`right-[3.75rem]`), both 2.25rem
  // wide, so the two together own the rightmost 6rem. `pe-14` (3.5rem) reserved room for one
  // of them, and the mode badge and this row's own buttons were drawn under the other
  // (verified on screen: "Read only" was sliced in half by the theme button). If either of
  // those two moves, this number moves with it.
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 pe-[6.5rem]">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* Same treatment as the rail row, or the conversation you just clicked would be
            titled two different ways on the same screen. Rename still seeds the RAW name. */}
        <span className="truncate text-sm font-medium">
          {name ? railTitle(name) : 'New chat'}
        </span>
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

      {/* One source for the wording — see CHAT_MODES. */}
      {(() => {
        const mode = modeMeta(tools)
        return (
          <span
            title={mode.title}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]',
              mode.pill,
            )}
          >
            <mode.icon className="size-3" />
            {mode.label}
          </span>
        )
      })()}

      {live && (
        <>
          {/* Starring is the one action worth a click of its own — it's how a conversation
              stays at the top of the rail. `temporary` refuses it server-side. */}
          {!temporary && (
            <button
              type="button"
              onClick={onPin}
              aria-label={pinned ? 'Unstar this conversation' : 'Star this conversation'}
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
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
  const [model, setModel] = useState<string>(() => localStorage.getItem(MODEL_KEY) || 'default')
  const [tools, setTools] = useState<ChatTools>(() => {
    // Validated against the table, not a string compare: a stored value from before
    // `write` existed (or a hand-edited one) must fall back to the default, not to a mode
    // the server would reject.
    const saved = localStorage.getItem(TOOLS_KEY)
    return CHAT_MODES.some((m) => m.value === saved) ? (saved as ChatTools) : 'full'
  })
  const [effort, setEffort] = useState<ChatEffort>(() => {
    // Validated against the table for the same reason `tools` is: a hand-edited or
    // future-dated value must land on the inherit-the-CLI default, never be forwarded.
    const saved = localStorage.getItem(EFFORT_KEY)
    return CHAT_EFFORTS.some((e) => e.value === saved) ? (saved as ChatEffort) : DEFAULT_EFFORT
  })
  /** The composer's open height in px — see COMPOSER_H_KEY. */
  const [composerH, setComposerH] = useState<number>(() => {
    const saved = Number(localStorage.getItem(COMPOSER_H_KEY))
    return Number.isFinite(saved) && saved > 0 ? clampComposerH(saved) : COMPOSER_H_DEFAULT
  })
  /** True while the grip is being dragged — kills the tint/transition flicker mid-drag. */
  const [resizingComposer, setResizingComposer] = useState(false)
  /** Files attached to the NEXT message — converted to markdown here in the browser. */
  const [attached, setAttached] = useState<{ name: string; markdown: string }[]>([])
  /** Images pasted/dropped/picked for the NEXT message (see StagedImage). */
  const [images, setImages] = useState<StagedImage[]>([])
  /** `@`-tagged artifacts and `/`-picked skills staged for the next message (StagedMention). */
  const [mentions, setMentions] = useState<StagedMention[]>([])
  /**
   * The `+` menu action armed for the NEXT message (web search / deep research / diagram),
   * or null for an ordinary turn. Per message on purpose — it's cleared on send, so the
   * follow-up after a web answer goes back to reading the project unless you ask again.
   */
  const [action, setAction] = useState<ChatAction | null>(null)
  /**
   * The `@…` or `/…` being typed right now — which character opened it, where it starts, the
   * caret, and what's typed after it — or null when no picker is open. One piece of state for
   * both, so the arrows/Enter/Escape handling and the painted chips are written once.
   */
  const [mention, setMention] = useState<{
    char: TriggerChar
    start: number
    end: number
    query: string
  } | null>(null)
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
    /**
     * Set by the `settled` frame — the answer is over, the chips are still coming.
     *
     * They arrive early on purpose. The model has been known since the CLI's `init` event
     * and the timings are fixed the moment the reply stops, so making them wait for the
     * token counts (which genuinely can't exist until the run ends) left the footer blank
     * through the whole follow-up-chip tail. The values are the SERVER'S, measured once —
     * this side never computes its own, or the reading would change when `done` lands.
     */
    model?: string
    stats?: TurnStats
  } | null>(null)
  /**
   * MESSAGES WAITING THEIR TURN behind the one being answered.
   *
   * A full-tools turn legitimately spends minutes grepping and reading, and the follow-up
   * you think of while watching it is the one worth asking. The composer used to be dead
   * for all of that (the server answered 409); now the message is accepted and runs next.
   *
   * Replaced WHOLESALE by every `queue` frame — the server sends the entire list, never a
   * delta, so there is one way to be right about it instead of a fold this side could get
   * out of step with. A local optimistic entry is therefore safe: the next frame overwrites.
   */
  const [queued, setQueued] = useState<QueuedChatMessage[]>([])
  const [atBottom, setAtBottom] = useState(true)

  /**
   * Put messages that never ran back where they came from.
   *
   * Stopping a reply — or a turn that failed — cancels whatever was queued behind it, and
   * those are words the engineer typed. Losing them silently is the one outcome this page
   * refuses everywhere else (an oversize message is a 413 with the text put back, a stopped
   * turn still saves its partial answer), so they go into the composer, unless something
   * has already been typed there.
   */
  const restoreDropped = useCallback((dropped?: string[]) => {
    if (!dropped?.length) return
    setInput((cur) => (cur.trim() ? cur : dropped.join('\n\n')))
    toast.info(
      dropped.length === 1
        ? 'The queued message was put back in the composer'
        : `${dropped.length} queued messages were put back in the composer`,
      { description: 'A reply that stops or fails also cancels anything waiting behind it.' },
    )
  }, [])

  /** The conversation the rename / delete dialog is about, or null when closed. */
  const [renaming, setRenaming] = useState<{ slug: string; name: string } | null>(null)
  const [deleting, setDeleting] = useState<{ slug: string; name: string } | null>(null)
  /** Which quick-prompt category is expanded into its four suggestions, if any. */
  const [openCategory, setOpenCategory] = useState<(typeof QUICK)[number] | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const paintRef = useRef<HTMLDivElement | null>(null)
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
  useEffect(() => {
    localStorage.setItem(EFFORT_KEY, effort)
  }, [effort])
  useEffect(() => {
    localStorage.setItem(COMPOSER_H_KEY, String(composerH))
  }, [composerH])

  /**
   * Drag the composer taller/shorter.
   *
   * Listeners go on the WINDOW, not the grip: a pointer that leaves the 10px strip mid-drag
   * (which it does the moment you move fast) would otherwise drop the drag halfway. Dragging
   * UP grows the box, so the delta is start-minus-now.
   */
  const startComposerResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      const startY = e.clientY
      const startH = composerH
      setResizingComposer(true)
      const onMove = (ev: PointerEvent) => setComposerH(clampComposerH(startH + (startY - ev.clientY)))
      const onUp = () => {
        setResizingComposer(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [composerH],
  )

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
        // The catch-up ends with the whole queue, so a page that reloaded mid-answer comes
        // back knowing what is still waiting — not just what is being answered.
        onQueue: (list) => setQueued(list),
        onDelta: (t) => setPending((p) => (p ? { ...p, answer: p.answer + t } : p)),
        onTool: (call) => setPending((p) => (p ? { ...p, tools: [...p.tools, call] } : p)),
        onSettled: (model, stats) => setPending((p) => (p ? { ...p, model, stats } : p)),
        onStopped: (saved, dropped) => {
          setPending(null)
          setQueued([])
          restoreDropped(dropped)
          if (saved) queryClient.setQueryData(['chat', projectId, saved.slug], saved)
          void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
        },
        onDone: (saved, dropped) => {
          // Not an unconditional clear — a queued message may be handed this same stream
          // next, and its own `queue` frame says what remains. `dropped` only arrives when
          // the turn failed, which does end the queue.
          setPending(null)
          if (dropped?.length) setQueued([])
          restoreDropped(dropped)
          queryClient.setQueryData(['chat', projectId, saved.slug], saved)
          void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
        },
        onError: (_message, dropped) => {
          setPending(null)
          setQueued([])
          restoreDropped(dropped)
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
  }, [projectId, slug, running, restoreDropped, queryClient])

  // The `@` menu's source lists. Fetched only once the engineer actually types `@` (it's a
  // disk scan of testing/tickets), then cached for the session by React Query — and not at
  // all for `/`, which needs neither.
  const atOpen = mention?.char === '@'
  const slashOpen = mention?.char === '/'
  const { data: crawled, isFetching: crawledFetching } = useQuery({
    queryKey: ['crawled-tickets', projectId],
    queryFn: () => listCrawledTickets(projectId),
    enabled: !!projectId && atOpen,
    staleTime: 60_000,
  })
  // Connected databases, on the same "only once `@` is typed" terms.
  const { data: dbInfo } = useQuery({
    queryKey: ['databases', projectId],
    queryFn: () => getDatabases(projectId),
    enabled: !!projectId && atOpen,
    staleTime: 60_000,
  })
  // The `/` menu's source list — the project's skills, as the Skills page defines them.
  const { data: skills, isFetching: skillsFetching } = useQuery({
    queryKey: ['skills', projectId],
    queryFn: () => listSkills(projectId),
    enabled: !!projectId && slashOpen,
    staleTime: 60_000,
  })
  const mentionRows = useMemo(() => {
    if (!mention) return []
    return mention.char === '/'
      ? skillOptions(skills ?? [], mention.query)
      : mentionOptions(crawled ?? [], dbInfo?.databases ?? [], mention.query)
  }, [crawled, dbInfo, skills, mention])

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

  /** Track (or close) the `@…` / `/…` under the caret after any edit or cursor move. */
  const syncMention = useCallback((el: HTMLTextAreaElement) => {
    const caret = el.selectionStart ?? el.value.length
    const found = activeTrigger(el.value, caret)
    setMention(
      found ? { char: found.char, start: found.start, end: caret, query: found.query } : null,
    )
    setMentionIndex(0)
  }, [])

  /**
   * Keep the painted layer aligned when the textarea scrolls its own content.
   *
   * A `transform`, not `scrollTop`: the paint layer has no scrollbar of its own, so its
   * scrollable height doesn't match and an assigned scrollTop is silently clamped — which
   * is how the chips end up sitting a line above the text they belong to.
   */
  const syncPaintScroll = useCallback(() => {
    const ta = taRef.current
    if (ta && paintRef.current) {
      paintRef.current.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    }
  }, [])

  /** The staged tokens ComposerPaint chips — identity kept stable so its memo holds. */
  const mentionTokens = useMemo(() => mentions.map((m) => m.token), [mentions])

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
          : [
              ...prev,
              {
                token: opt.token,
                kind: opt.kind,
                folder: opt.folder,
                databaseId: opt.databaseId,
                skill: opt.skill,
              },
            ],
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
      if (!base && !images.length) return
      // Sending DURING a turn is allowed — the message waits its turn (see `queued`). The
      // one case that isn't: the split second before the server has named a brand-new
      // conversation, when there is no slug to queue into and sending would create a
      // SECOND chat instead. The Send button is disabled for that window too.
      const queueing = streaming
      if (queueing && !openSlug) return
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
        .map((m) => ({
          kind: m.kind,
          folder: m.folder,
          databaseId: m.databaseId,
          skill: m.skill,
        }))
      const sendingAction = action
      setInput('')
      setAttached([])
      setImages([])
      setMentions([])
      setMention(null)
      setAction(null)
      setAtBottom(true)
      const shown = base || 'Take a look at the attached screenshot.'
      const sentAt = new Date().toISOString()
      /** A local stand-in until the server answers with the real id; any `queue` frame wins. */
      const localId = `local-${sentAt}-${Math.random().toString(36).slice(2, 8)}`
      if (queueing) {
        // Show it immediately. The server emits the authoritative list a moment later and
        // that REPLACES this, so the optimistic row can never linger or double up.
        setQueued((q) => [
          ...q,
          { id: localId, prompt: shown, at: sentAt, images: [], action: sendingAction ?? undefined },
        ])
      } else {
        setPending({
          prompt: shown,
          answer: '',
          tools: [],
          // Previews come from the data URLs already in memory — the files aren't on disk
          // (and so aren't servable) until the turn finishes.
          images: sending.map((i) => i.dataUrl),
          action: sendingAction,
          at: sentAt,
        })
      }
      const ac = new AbortController()
      // A queued send is a short POST, not a subscription: it must NOT take over
      // `abortRef`, which belongs to the stream currently watching the running turn.
      if (!queueing) abortRef.current = ac
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
          effort,
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
            // Tell the rail NOW that this conversation exists and is answering. Without it
            // a brand-new chat has no row to switch back to, and the rail's poll — which
            // only runs while something is `running` — never starts, so the "Answering…"
            // dot would never clear on its own either.
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
          // The server hands this stream over to a queued message when the current turn
          // finishes, opening it with the same `resume` frame a re-attaching viewer gets.
          // So the row for the next question appears here, on the same connection.
          onResume: ({ prompt: q, at: qAt, images: files }) => {
            setPending({ prompt: q, answer: '', tools: [], images: [], imageFiles: files, at: qAt })
          },
          onQueue: (list) => setQueued(list),
          onDelta: (t) => setPending((p) => (p ? { ...p, answer: p.answer + t } : p)),
          onTool: (call) => setPending((p) => (p ? { ...p, tools: [...p.tools, call] } : p)),
          onSettled: (model, stats) => setPending((p) => (p ? { ...p, model, stats } : p)),
          onStopped: (saved?: Chat, dropped?: string[]) => {
            setPending(null)
            setQueued([])
            restoreDropped(dropped)
            if (saved) queryClient.setQueryData(['chat', projectId, saved.slug], saved)
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
          onDone: (saved: Chat, dropped?: string[]) => {
            // NOT an unconditional `setQueued([])`: a queued message may be starting on this
            // same stream, and its own `queue` frame is what says what is left behind it.
            // `dropped` only arrives when the turn failed, which does clear the queue.
            setPending(null)
            if (dropped?.length) setQueued([])
            restoreDropped(dropped)
            // Seed the cache from the response so the finished turn appears without a
            // round trip (and the transcript doesn't blink empty in between).
            queryClient.setQueryData(['chat', projectId, saved.slug], saved)
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
          onError: (message, dropped?: string[]) => {
            setPending(null)
            setQueued([])
            toast.error('The message failed', { description: message })
            restoreDropped(dropped)
            // A refused message (413 oversize, 409 already answering) never reached the
            // transcript, so clearing the composer would simply lose what was typed — and
            // the longer the message, the more likely it was refused. Put it back, unless
            // the user has already started typing something else.
            setInput((cur) => (cur.trim() ? cur : base))
            void queryClient.invalidateQueries({ queryKey: ['chat', projectId, targetSlug] })
            void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
          },
        },
        ac.signal,
      )
        .then((r) => {
          // Accepted but waiting: swap the optimistic row for the server's identity so its
          // cancel button addresses the real message. Any `queue` frame overrides this.
          if (r?.kind === 'queued') {
            setQueued((q) => q.map((m) => (m.id === localId ? { ...m, id: r.id } : m)))
          } else if (r?.kind === 'failed' && queueing) {
            // Refused (queue full, conversation gone): take the row back off screen —
            // `onError` has already put the text back in the composer.
            setQueued((q) => q.filter((m) => m.id !== localId))
          }
        })
        .catch((err) => {
          // An abort is the Stop button, not a failure — the server still saves whatever
          // had been written, so refetch rather than reporting an error.
          if (queueing) setQueued((q) => q.filter((m) => m.id !== localId))
          else setPending(null)
          if ((err as Error)?.name !== 'AbortError') {
            toast.error('The message failed', { description: (err as Error)?.message })
          }
          void queryClient.invalidateQueries({ queryKey: ['chat', projectId, targetSlug] })
          void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
        })
        .finally(() => {
          // Release the slot so the re-attach effect can take over a later turn. A queued
          // send never owned it, so this is a no-op for one.
          if (abortRef.current === ac) abortRef.current = null
        })
    },
    [
      projectId,
      openSlug,
      model,
      tools,
      effort,
      temporary,
      action,
      streaming,
      attached,
      images,
      mentions,
      rememberTemp,
      restoreDropped,
      queryClient,
    ],
  )

  /**
   * Stop WATCHING the reply in flight — without cancelling it.
   *
   * This is what makes "switch away and come back" work. The turn is registered
   * server-side precisely so it outlives the request that started it, so leaving a
   * conversation must abort only the LOCAL subscription: the answer keeps being written,
   * the rail keeps the row marked "Answering…", and reopening it re-attaches through
   * `GET /:slug/stream` mid-sentence (or finds it finished). `pending` belongs to the
   * conversation being left, so it goes with it — otherwise the next screen would open
   * showing someone else's question.
   *
   * Cancelling for real is `stop` below; the difference is whether the server is told.
   */
  const detach = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    // Release the re-attach guard too, or coming back to this conversation would find
    // its key still marked as watched and never subscribe again.
    attachedRef.current = null
    setPending(null)
    // The queue belongs to the conversation being left, not to this page.
    setQueued([])
  }, [])

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
    // Stop halts the whole conversation, queue included. Aborting the local subscription
    // means the `stopped` frame (which carries the dropped text) may not reach us, so the
    // rows go now and `stopChat`'s own response is what the toast below reports.
    setQueued([])
    if (!openSlug) return
    void stopChat(projectId, openSlug)
      // Messages that were waiting behind the stopped turn never ran, and this response is
      // the copy of them this client actually receives: Stop aborts the local subscription
      // above, so the `stopped` FRAME (which carries the same list) is never read here.
      .then((r) => restoreDropped(r.dropped))
      .catch(() => {
        /* already finished — the transcript refresh below covers it */
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: ['chat', projectId, openSlug] })
        void queryClient.invalidateQueries({ queryKey: ['chats', projectId] })
      })
  }, [projectId, openSlug, restoreDropped, queryClient])

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
          if (s === openSlug) return
          // A reply in flight is left RUNNING, not cancelled — see `detach`.
          detach()
          // Opening a saved conversation ends the temporary one (it can't be reached again)
          // and leaves temporary MODE — otherwise the next New Chat would quietly be
          // temporary too.
          if (isTemporary) forgetTemporary(openSlug)
          setPicked(s)
          setTemporary(false)
          setAtBottom(true)
        }}
        onNew={() => {
          detach()
          startNew(false)
        }}
        onNewTemporary={() => {
          detach()
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
                  <GreetingHeadline projectName={projectName} />
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
              <Turn
                key={`${m.at}-${i}`}
                m={m}
                projectId={projectId}
                question={messages[i - 1]?.role === 'user' ? messages[i - 1]?.text : undefined}
                slug={openSlug ?? undefined}
                index={i}
              />
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
                  model={pending.model}
                  stats={pending.stats}
                  question={pending.prompt}
                  projectId={projectId}
                />
              </>
            )}
            {/* Waiting their turn, under the answer they'll follow. Shown as the questions
                they are, dimmed — they haven't been asked yet. */}
            {queued.length > 0 && (
              <QueuedRows
                items={queued}
                onCancel={(id) => {
                  if (!projectId || !openSlug) return
                  // Optimistic: the row goes now, and the server's `queue` frame confirms.
                  setQueued((q) => q.filter((m) => m.id !== id))
                  void cancelQueuedChat(projectId, openSlug, id).catch(() => {
                    // 404 = it already started, which Stop covers; the frame will correct us.
                  })
                }}
              />
            )}
            {/* Inside the scroller, under the newest answer — it belongs to that answer,
                and pinning it above the composer would cover the transcript instead. */}
            {followUps.length > 0 && <FollowUps items={followUps} onPick={send} />}
            <div className="h-px w-full shrink-0 scroll-mt-4" aria-hidden />
          </div>

          {/* Highlight a passage in any answer above and this floats in beside it. Portaled to
              the body, so the scroller's `overflow-y-auto` can't clip it. */}
          <SelectionNoteBubble scrollerRef={logRef} projectId={projectId} />

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
            {/* The `@` / `/` menu. Anchored to the WELL (which doesn't clip) and opening
                upward, so it never covers the message being typed. */}
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
                          {opt.kind === 'skill' ? (
                            <Wand2 className="size-4 shrink-0 text-amber-500" />
                          ) : opt.kind === 'database' ? (
                            <Database className="size-4 shrink-0 text-sky-500" />
                          ) : opt.kind === 'ticket' ? (
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
                    {mention.char === '/'
                      ? skillsFetching
                        ? 'Looking for this project’s skills…'
                        : (skills?.length ?? 0) === 0
                          ? 'This project has no skills yet — add one on the Skills page.'
                          : `No skill matches “${mention.query}”.`
                      : crawledFetching
                        ? 'Looking for tickets and databases…'
                        : (crawled?.length ?? 0) === 0 && (dbInfo?.databases.length ?? 0) === 0
                          ? 'Nothing to tag yet — crawl a ticket on the Tickets page, or connect a database on the Database page.'
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
              <span>{modeMeta(tools).label}</span>
              {/* Only when it isn't the default level — a line that always says "Medium
                  effort" teaches nobody anything. */}
              {effort !== DEFAULT_EFFORT && (
                <>
                  <span>•</span>
                  <span>{effortLabel(effort)} effort</span>
                </>
              )}
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
                <code className="font-mono text-foreground">@</code> to tag a ticket or database
              </span>
              <span>•</span>
              <span>
                <code className="font-mono text-foreground">/</code> for a skill
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
              {/* The resize grip. Full width so it's easy to hit, but only 10px tall — it
                  sits between the hint strip and the text, and any pixel it takes is a pixel
                  the input box doesn't get. Keyboard-reachable (a `separator` is the role a
                  resizer carries), arrows nudge it, double-click restores the default. */}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the message box"
                aria-valuenow={composerH}
                aria-valuemin={COMPOSER_H_MIN}
                aria-valuemax={COMPOSER_H_MAX}
                tabIndex={0}
                title="Drag to resize the message box (double-click to reset)"
                onPointerDown={startComposerResize}
                onDoubleClick={() => setComposerH(COMPOSER_H_DEFAULT)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault()
                    setComposerH((h) => clampComposerH(h + (e.key === 'ArrowUp' ? 24 : -24)))
                  }
                }}
                className={cn(
                  'group flex h-2.5 w-full cursor-ns-resize touch-none items-center justify-center outline-none',
                  resizingComposer && 'cursor-grabbing',
                )}
              >
                <span
                  className={cn(
                    'h-1 w-10 rounded-full bg-border transition-colors',
                    resizingComposer
                      ? 'bg-primary'
                      : 'group-hover:bg-muted-foreground/60 group-focus-visible:bg-primary',
                  )}
                />
              </div>

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

              <div className="relative">
              <ComposerPaint text={input} tokens={mentionTokens} paintRef={paintRef} />
              <textarea
                ref={taRef}
                value={input}
                onScroll={syncPaintScroll}
                // Off because the text under a chip is transparent, so a spellcheck
                // squiggle would draw across the chip with no word visible under it — and
                // a message full of ticket ids and table names is mostly false positives.
                spellCheck={false}
                onChange={(e) => {
                  setInput(e.target.value.slice(0, MAX_PROMPT))
                  syncMention(e.target)
                  syncPaintScroll()
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
                // text-transparent: the glyphs come from ComposerPaint underneath. The
                // caret and a translucent selection are what's left visible here, so the
                // painted text still reads through a selection.
                // Opens at the DRAGGED height (`--composer-h`, default 152px ≈ 6 lines; see
                // COMPOSER_H_KEY) and GROWS with the content (`field-sizing-content`) until
                // `min(26rem, 45vh)`, then scrolls. A one-line box was the first complaint —
                // the questions asked here are paragraphs with a path and a ticket id in
                // them — and 6 fixed lines was the next one, on a 13" laptop; hence the grip
                // above rather than another hardcoded number. The `max(...)` is what lets a
                // deliberately TALL box stay tall: it must never be clipped by the vh cap.
                // ComposerPaint underneath must keep identical padding and font metrics or
                // the caret drifts off the glyphs.
                style={
                  {
                    '--composer-h': `${composerH}px`,
                    minHeight: 'var(--composer-h)',
                    maxHeight: 'max(var(--composer-h), min(26rem, 45vh))',
                  } as React.CSSProperties
                }
                className="relative w-full resize-none border-none bg-transparent p-4 text-sm text-transparent caret-foreground shadow-none outline-none field-sizing-content selection:bg-primary/25 placeholder:text-muted-foreground"
              />
              </div>

              {/* px-3 py-2, not p-3: every pixel of chrome here is a pixel the input box
                  above doesn't get. Same reason the buttons are size-8. */}
              <div className="flex items-center justify-between gap-2 px-3 py-2">
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
                      className={COMPOSER_PILL}
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
                          {/* The trigger renders its own explicit label (above), so the
                              second line lives here without ever leaking into the pill. */}
                          <span className="flex flex-col items-start gap-0.5">
                            <span>{m.label}</span>
                            {m.hint && (
                              <span className="text-xs text-muted-foreground">{m.hint}</span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Effort sits next to the model because it is the second half of the same
                      decision — which brain, and how hard it thinks. Same Select as the
                      model picker rather than a nested "Model › Effort" sheet: two flat
                      pills say what is armed without a click, and the label collapses to
                      the icon on narrow screens exactly like the model's does. */}
                  <Select value={effort} onValueChange={(v) => setEffort(v as ChatEffort)}>
                    <SelectTrigger
                      size="sm"
                      className={COMPOSER_PILL}
                      aria-label="Reasoning effort"
                    >
                      <Gauge className="size-4 text-muted-foreground" />
                      <div className="hidden lg:flex">
                        <SelectValue>{effortLabel(effort)}</SelectValue>
                      </div>
                    </SelectTrigger>
                    <SelectContent>
                      {CHAT_EFFORTS.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          <span className="flex flex-col items-start gap-0.5">
                            <span>{e.label}</span>
                            {e.hint && (
                              <span className="text-xs text-muted-foreground">{e.hint}</span>
                            )}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* The reference's mic slot, moved next to the model picker: a voice
                      button would be decoration, and what a turn may DO belongs beside
                      which model does it — and beside how hard it thinks. */}
                  <ComposerModePicker tools={tools} onPick={setTools} />
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
                            'size-8 rounded-full',
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

                  {/* The button follows WHAT IS TYPED, not whether a reply is running: with
                      something in the composer it sends (queuing behind the current turn),
                      empty during a turn it stops. Keying it on `streaming` alone is what
                      made the composer dead for the whole of a ten-minute answer. */}
                  {streaming && !input.trim() && !images.length ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon"
                          variant="destructive"
                          onClick={() => stop()}
                          aria-label="Stop generating"
                          className="size-8 rounded-full"
                        >
                          <Square className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs">
                        Stop this reply. Whatever has been written so far is kept, and anything
                        still queued behind it is cancelled.
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Button
                      size="icon"
                      onClick={() => send(input)}
                      disabled={
                        (!input.trim() && !images.length) ||
                        !projectId ||
                        // The split second before a brand-new conversation has a slug: there
                        // is nothing to queue into yet, and sending would start a SECOND chat.
                        (streaming && !openSlug) ||
                        queued.length >= MAX_QUEUED
                      }
                      aria-label={streaming ? 'Send — waits for the current reply' : 'Send'}
                      className="size-8 rounded-full"
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
