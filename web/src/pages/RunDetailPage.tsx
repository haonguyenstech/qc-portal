import { cloneElement, isValidElement, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'

// The qc-testing skill writes report/issues with a single newline between labeled
// fields (AC / Steps / Expected / Actual / Business impact). Plain Markdown collapses
// those into one run-on paragraph, so remark-breaks turns each soft newline into a
// real line break — keeping each field on its own line. (Tables/lists are unaffected.)
const REMARK_PLUGINS = [remarkGfm, remarkBreaks]
import {
  AlertCircle,
  ArrowUpRight,
  ArrowLeft,
  Ban,
  CalendarClock,
  File as FileIcon,
  FileCode2,
  FileText,
  Files,
  Folder,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Send,
  Terminal,
  Timer,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import ContinueSessionPanel from '@/components/ContinueSessionPanel'
import {
  createClickupIssueSubtasks,
  deleteRun,
  getRun,
  listCrawledTickets,
  listRunFiles,
  openRunFolder,
  runFileUrl,
  screenshotUrl,
  type ClickupTask,
  type RunFile,
} from '@/lib/api'
import { StatusBadge } from '@/lib/status'
import type { LogEvent } from '@/lib/types'
import { cn } from '@/lib/utils'

const prose =
  'max-w-none text-sm leading-relaxed text-foreground/90 ' +
  '[&_h1]:mb-3 [&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight first:[&_h1]:mt-0 ' +
  '[&_h2]:mb-2 [&_h2]:mt-7 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight ' +
  '[&_h2]:border-b [&_h2]:pb-1.5 first:[&_h2]:mt-0 ' +
  '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold ' +
  '[&_p]:my-3 [&_p]:leading-relaxed [&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 ' +
  '[&_li]:my-1 [&_li]:marker:text-muted-foreground [&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_strong]:font-semibold [&_strong]:text-foreground ' +
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs ' +
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-zinc-800 [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-zinc-100 ' +
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-zinc-100 ' +
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_blockquote]:italic ' +
  '[&_hr]:my-6 [&_hr]:border-border ' +
  // Table display + width are handled by the `table` component (a wrapper div with
  // overflow-x-auto + a real display:table that sizes columns to content), so here we
  // only style borders/spacing — NOT `block`/`w-full`, which would break auto column sizing.
  '[&_table]:my-5 [&_table]:border-separate [&_table]:border-spacing-0 [&_table]:text-sm ' +
  '[&_thead_tr]:bg-muted/70 [&_th]:border-y [&_th]:border-r [&_th]:border-border [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground [&_th]:whitespace-nowrap first:[&_th]:rounded-l-lg first:[&_th]:border-l last:[&_th]:rounded-r-lg ' +
  // Columns size to their content. A max-width cap lets short columns (No, Priority,
  // Status) stay narrow while long free-text (Steps, Result) wraps instead of ballooning
  // the whole table. align-top + break-words keep multi-line cells readable.
  '[&_td]:max-w-[28rem] [&_td]:whitespace-normal [&_td]:break-words [&_td]:border-b [&_td]:border-r [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top first:[&_td]:border-l [&_tbody_tr:hover]:bg-muted/30 ' +
  '[&_td:first-child]:font-medium'

/**
 * Remove the report's per-case "Test Result Details" section (a level-2 heading
 * through to the next level-2 heading). We only do this when the executed
 * test-case table is shown above the report, since that table already presents
 * the same per-case pass/fail breakdown — the prose section would just duplicate it.
 */
function stripCaseDetailSection(md: string): string {
  const lines = md.split('\n')
  const isDetailHeading = (l: string) =>
    /^##\s+/.test(l) &&
    /(test\s+result\s+details|test\s+case\s+details|detailed\s+results|per[-\s]?case\s+results)/i.test(l)
  const start = lines.findIndex(isDetailHeading)
  if (start === -1) return md
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next same-or-higher-level heading (## or #), not ### subsections.
    if (/^#{1,2}\s+/.test(lines[i])) {
      end = i
      break
    }
  }
  const out = [...lines.slice(0, start), ...lines.slice(end)]
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function MarkdownView({ md, empty, icon }: { md: string | null; empty: string; icon: React.ReactNode }) {
  if (!md) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
          {icon}
        </div>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </div>
    )
  }
  return (
    <div className={prose}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={mdTableComponents}>
        {md}
      </Markdown>
    </div>
  )
}

/**
 * Report tables list evidence as bare filenames (e.g. `ac2-bell-popover.png`,
 * `nc-main.md`). This renders the report markdown but turns any such filename that
 * maps to a real run output file into a clickable chip that opens the file in a
 * dialog viewer — so the engineer can inspect a screenshot/note without leaving
 * the Report tab or hunting through the Files/Screenshots tabs.
 */

// Filename-shaped tokens we attempt to resolve against the run's output files.
const EVIDENCE_TOKEN = /[\w.\-/]+\.(?:png|jpe?g|gif|webp|svg|md|txt|json|csv|log)/gi

function evidenceLinkClass(kind: RunFile['kind']): string {
  return cn(
    'mx-0.5 inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5',
    'align-middle font-mono text-[11px] leading-none transition-colors',
    'border-primary/30 bg-primary/5 text-primary hover:border-primary/50 hover:bg-primary/10',
    kind === 'image' && 'border-violet-500/30 bg-violet-500/5 text-violet-600 hover:bg-violet-500/10 dark:text-violet-400',
  )
}

function EvidenceLink({ file, onOpen }: { file: RunFile; onOpen: (f: RunFile) => void }) {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <button type="button" onClick={() => onOpen(file)} className={evidenceLinkClass(file.kind)}>
      <span className="shrink-0">{fileKindIcon(file.kind)}</span>
      <span className="truncate">{name}</span>
    </button>
  )
}

/** Walk markdown-rendered children, swapping recognized evidence filenames for chips. */
function linkifyEvidence(
  node: React.ReactNode,
  byName: Map<string, RunFile>,
  onOpen: (f: RunFile) => void,
  keyPrefix = 'ev',
): React.ReactNode {
  if (typeof node === 'string') {
    if (!node.includes('.')) return node
    const parts: React.ReactNode[] = []
    let last = 0
    let match: RegExpExecArray | null
    EVIDENCE_TOKEN.lastIndex = 0
    let i = 0
    while ((match = EVIDENCE_TOKEN.exec(node)) !== null) {
      const token = match[0]
      const file = byName.get((token.split('/').pop() ?? token).toLowerCase())
      if (!file) continue
      if (match.index > last) parts.push(node.slice(last, match.index))
      parts.push(<EvidenceLink key={`${keyPrefix}-${i++}`} file={file} onOpen={onOpen} />)
      last = match.index + token.length
    }
    if (parts.length === 0) return node
    if (last < node.length) parts.push(node.slice(last))
    return parts
  }
  if (Array.isArray(node)) {
    return node.map((child, idx) => linkifyEvidence(child, byName, onOpen, `${keyPrefix}-${idx}`))
  }
  if (isValidElement(node)) {
    const el = node as React.ReactElement<{ children?: React.ReactNode }>
    if (el.props?.children != null) {
      return cloneElement(el, {
        children: linkifyEvidence(el.props.children, byName, onOpen, keyPrefix),
      })
    }
  }
  return node
}

// Wrap every markdown table in a horizontal-scroll container and render a real
// display:table that AUTO-SIZES its columns to content (w-max), with a full-width
// floor (min-w-full) so a small table still fills the row and a wide one scrolls
// instead of cramming its columns. The per-cell max-width in `prose` keeps a long
// free-text column from ballooning. Shared by every Markdown renderer on this page.
/** Flatten a React node tree to its plain text (for deriving heading anchors). */
function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children)
  return ''
}

/** Anchor id for an issue heading — `## ISSUE-1 …` → `issue-1` — else undefined. */
function issueHeadingId(children: React.ReactNode): string | undefined {
  const m = nodeText(children).match(/\b((?:issue|bug|def|defect)-\d+)\b/i)
  return m ? m[1].toLowerCase() : undefined
}

const mdTableComponents: Components = {
  table: ({ children, className, ...props }) => (
    <div className="my-5 w-full overflow-x-auto">
      <table {...props} className={cn(className, '!my-0 w-max min-w-full')}>
        {children}
      </table>
    </div>
  ),
  // Tag issue headings with a scroll anchor so a Reference chip can deep-link to
  // one; scroll-mt keeps it clear of the sticky tab bar.
  h2: ({ children, ...props }) => (
    <h2 id={issueHeadingId(children)} className="scroll-mt-24" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 id={issueHeadingId(children)} className="scroll-mt-24" {...props}>
      {children}
    </h3>
  ),
}

function EvidenceReport({
  md,
  empty,
  icon,
  projectId,
  slug,
  files,
}: {
  md: string | null
  empty: string
  icon: React.ReactNode
  projectId: string
  slug: string | null
  files: RunFile[]
}) {
  const [active, setActive] = useState<RunFile | null>(null)
  // basename → file, so a bare `nc-main.md` in a cell resolves to evidence/nc-main.md.
  const byName = useMemo(() => {
    const map = new Map<string, RunFile>()
    for (const f of files) {
      const name = f.path.split('/').pop()?.toLowerCase()
      if (name && !map.has(name)) map.set(name, f)
    }
    return map
  }, [files])

  if (!md) {
    return <MarkdownView md={md} empty={empty} icon={icon} />
  }

  return (
    <>
      <div className={prose}>
        <Markdown
          remarkPlugins={REMARK_PLUGINS}
          components={{
            ...mdTableComponents,
            td: ({ children, ...props }) => (
              <td {...props}>{linkifyEvidence(children, byName, setActive)}</td>
            ),
          }}
        >
          {md}
        </Markdown>
      </div>

      <Dialog open={!!active} onOpenChange={(open) => !open && setActive(null)}>
        <DialogContent className="max-h-[88vh] max-w-4xl overflow-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-mono text-sm">
              {active && fileKindIcon(active.kind)}
              {active?.path.split('/').pop()}
            </DialogTitle>
          </DialogHeader>
          {active && slug && (
            <FilePreview projectId={projectId} slug={slug} file={active} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function logLineClass(kind: LogEvent['kind']): string {
  switch (kind) {
    case 'error':
      return 'text-red-400'
    case 'tool':
      return 'text-sky-400'
    case 'tool_result':
      return 'text-emerald-400'
    case 'phase':
      return 'text-violet-400 font-semibold'
    case 'system':
      return 'text-amber-400'
    case 'done':
      return 'text-emerald-300 font-semibold'
    default:
      return 'text-zinc-200'
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

function formatDuration(start: string, end: string | null): string | null {
  if (!end) return null
  const a = new Date(start).getTime()
  const b = new Date(end).getTime()
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null
  const secs = Math.round((b - a) / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  if (mins < 60) return rem ? `${mins}m ${rem}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

// The project's status vocabulary (matches the executed test-case sheet):
// Passed / Failed / Blocked / Cancelled / Untested. Order = display order.
type OutcomeKey = 'passed' | 'failed' | 'blocked' | 'cancelled' | 'untested'

type OutcomeDatum = {
  key: OutcomeKey
  label: string
  value: number
  color: string
  tone: string
}

const outcomeConfig: Record<OutcomeKey, Omit<OutcomeDatum, 'key' | 'value'>> = {
  passed: {
    label: 'Passed',
    color: '#10b981',
    tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  },
  failed: {
    label: 'Failed',
    color: '#ef4444',
    tone: 'bg-red-50 text-red-700 ring-red-200',
  },
  blocked: {
    label: 'Blocked',
    color: '#f59e0b',
    tone: 'bg-amber-50 text-amber-700 ring-amber-200',
  },
  cancelled: {
    label: 'Cancelled',
    color: '#64748b',
    tone: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
  untested: {
    label: 'Untested',
    color: '#94a3b8',
    tone: 'bg-muted text-muted-foreground ring-border',
  },
}

const OUTCOME_ORDER: OutcomeKey[] = ['passed', 'failed', 'blocked', 'cancelled', 'untested']

function emptyOutcomeCounts(): Record<OutcomeKey, number> {
  return { passed: 0, failed: 0, blocked: 0, cancelled: 0, untested: 0 }
}

/** Normalize any status label to one of the five defined buckets. */
function statusBucket(raw: string): OutcomeKey | null {
  const s = raw.trim().toLowerCase()
  if (!s) return null
  if (s.startsWith('pass')) return 'passed'
  if (s.startsWith('fail')) return 'failed'
  if (s.startsWith('block')) return 'blocked'
  if (s.startsWith('cancel')) return 'cancelled'
  if (s.startsWith('untest') || s.startsWith('not')) return 'untested'
  if (s.startsWith('partial')) return 'failed' // no Partial in this workflow
  return null
}

/** Shared view model — cards + segmented bar + pass rate — from a bucket count. */
function buildOutcomeView(counts: Record<OutcomeKey, number>, unit: string) {
  const data = OUTCOME_ORDER.map((key) => ({ key, value: counts[key], ...outcomeConfig[key] }))
  const total = data.reduce((sum, item) => sum + item.value, 0)
  // Pass rate is over the WHOLE suite (Passed / Total) — Blocked/Untested/
  // Cancelled count against it, so the rate reflects how much of everything
  // planned is actually confirmed passing, not just the executed subset.
  const passRate = total > 0 ? Math.round((counts.passed / total) * 100) : null
  const attention = counts.failed + counts.blocked
  return { counts, data, total, passRate, attention, unit }
}

/** Count the executed test-case sheet's Status column into the five buckets. */
function countExecutedOutcomes(text: string, isCsv: boolean) {
  const rows = trimEmptyTrailingColumns(isCsv ? parseCsvClient(text) : parseMdTableClient(text))
  if (rows.length < 2) return null
  const statusIdx = rows[0].findIndex(isStatusHeaderCell)
  if (statusIdx < 0) return null
  const counts = emptyOutcomeCounts()
  for (const r of rows.slice(1)) {
    // A blank status means the case wasn't executed → Untested (the default).
    counts[statusBucket((r[statusIdx] ?? '').trim()) ?? 'untested']++
  }
  return buildOutcomeView(counts, 'test cases')
}

function parseReportOutcomes(md: string | null, fallback: { passCount: number; failCount: number }) {
  const counts = emptyOutcomeCounts()

  if (md) {
    for (const line of md.split('\n')) {
      if (!line.includes('|')) continue
      const cells = line
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
      if (cells.length < 2) continue

      // The count cell must be JUST a number (optionally bold) — otherwise rows
      // like `| Pass | TC-01 … |` in per-case tables would be misread as counts.
      if (!/^\*{0,2}\s*\d+\s*\*{0,2}$/.test(cells[1])) continue
      const label = cells[0].toLowerCase().replace(/[^a-z]/g, '')
      const value = Number.parseInt(cells[1].replace(/[^\d]/g, ''), 10)
      if (!Number.isFinite(value)) continue

      // Map the report's summary labels onto the defined buckets. The mandated
      // Execution Summary lists Passed and Passed-with-issue as SEPARATE rows —
      // match the more specific one first and ADD both into `passed` (a
      // passed-with-issue case still passed), so the specific row can't overwrite
      // the plain Passed count.
      if (label.includes('passedwithissue') || label.includes('passwithissue')) counts.passed += value
      else if (label === 'pass' || label.includes('passed')) counts.passed += value
      else if (label === 'fail' || label.includes('failed')) counts.failed = value
      else if (label.includes('partial')) counts.failed += value
      // "Not Tested" is matched BEFORE "blocked" (same order as the server parser),
      // so a legacy combined "Not Tested / Blocked" row buckets identically on both
      // sides and History can't drift from the detail tiles.
      else if (label.includes('nottested') || label.includes('untested') || label.includes('notrun'))
        counts.untested = value
      else if (label.includes('blocked')) counts.blocked = value
      else if (label.includes('cancel')) counts.cancelled = value
    }
  }

  if (OUTCOME_ORDER.every((k) => counts[k] === 0)) {
    counts.passed = fallback.passCount
    counts.failed = fallback.failCount
  }

  return buildOutcomeView(counts, 'acceptance criteria')
}

type ParsedIssue = {
  id: string
  title: string
  description: string
  screenshots: string[]
}

// Screenshot paths the qc-testing skill writes into an issue body, e.g.
// `screenshots/ISSUE-ac3-cancel-confirm-dialog.png`. We attach these to the
// ClickUp subtask as real images instead of leaving a dead local path.
const SCREENSHOT_TOKEN = /screenshots\/[\w.\-]+\.(?:png|jpe?g|gif|webp)/gi

function extractScreenshots(text: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  SCREENSHOT_TOKEN.lastIndex = 0
  while ((m = SCREENSHOT_TOKEN.exec(text)) !== null) out.add(m[0])
  return [...out]
}

// A body line we drop before sending to ClickUp:
//  - the redundant "AC:" bullet (the AC is already covered by Steps/Expected)
//  - the raw "Screenshot: <path>" line (the image is attached to the card instead)
function isDroppedIssueLine(line: string): boolean {
  return (
    /^\s*[-*+]\s*\*{0,2}\s*AC\b/i.test(line) ||
    /^\s*(?:[-*+]\s*)?\*{0,2}\s*Screenshot\b/i.test(line)
  )
}

function stripMd(value: string): string {
  return value
    .replace(/[`*_#[\]]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseIssues(md: string | null): ParsedIssue[] {
  if (!md?.trim()) return []
  const lines = md.split('\n')
  const sections: { title: string; body: string[] }[] = []
  let current: { title: string; body: string[] } | null = null

  for (const line of lines) {
    const heading = line.match(/^(#{2,4})\s+(.+)$/)
    if (heading) {
      const level = heading[1].length
      const title = stripMd(heading[2])
      const isIssueHeading =
        level === 2 &&
        (/^issue[-\s#]*\d+/i.test(title) || /^defect[-\s#]*\d+/i.test(title))
      if (isIssueHeading) {
        if (current) sections.push(current)
        current = { title, body: [] }
        continue
      }
      if (level === 2 && current) {
        sections.push(current)
        current = null
      }
    }
    if (current) current.body.push(line)
  }
  if (current) sections.push(current)

  const fromSections = sections
    .map((section, index) => {
      const screenshots = extractScreenshots(section.body.join('\n'))
      // Note 1: the title is already the ClickUp task name — don't repeat it in the body.
      // Notes 2 & 4: drop the "AC:" and raw "Screenshot:" lines.
      const description = section.body.filter((line) => !isDroppedIssueLine(line)).join('\n').trim()
      return {
        id: `issue-${index}`,
        title: section.title.slice(0, 140),
        description,
        screenshots,
      }
    })
    .filter((issue) => issue.title.length > 0)

  if (fromSections.length > 0) return fromSections.slice(0, 20)

  const tableRows = lines
    .filter((line) => /^\|.+\|$/.test(line.trim()) && !/^\|?\s*:?-{3,}/.test(line.trim()))
    .map((line) =>
      line
        .split('|')
        .map((cell) => stripMd(cell))
        .filter(Boolean),
    )
  if (tableRows.length > 1) {
    const headers = tableRows[0].map((h) => h.toLowerCase())
    const titleIndex = Math.max(
      headers.findIndex((h) => h.includes('issue')),
      headers.findIndex((h) => h.includes('title')),
      headers.findIndex((h) => h.includes('defect')),
    )
    return tableRows
      .slice(1)
      .map((cells, index) => {
        const title = cells[titleIndex >= 0 ? titleIndex : 0] || `QC issue ${index + 1}`
        const description = cells.join(' | ')
        return {
          id: `issue-table-${index}`,
          title: title.slice(0, 140),
          description,
          screenshots: extractScreenshots(description),
        }
      })
      .slice(0, 20)
  }

  const firstContent = lines.find((line) => stripMd(line).length > 0)
  return [
    {
      id: 'issue-full',
      title: stripMd(firstContent ?? 'QC issue').slice(0, 140),
      description: md.trim().slice(0, 6000),
      screenshots: extractScreenshots(md),
    },
  ]
}

// ---- Failure diagnosis ----------------------------------------------------
// When a run ends without a report (e.g. the Playwright/MCP browser connection
// hung), the Report and Issues tabs are empty and the ONLY clue is buried deep in
// the event log. This scans the log for the real failure reason and surfaces it up
// front, with a plain-language explanation for the common Playwright/MCP cases.

type FailureCategory = 'playwright' | 'mcp' | 'connection' | 'interrupted' | 'exit' | 'error'

interface FailureDiagnosis {
  category: FailureCategory
  title: string
  detail: string
  hint?: string
  /** Key raw log lines that back the diagnosis (deduped + capped). */
  evidence: string[]
}

// Signature patterns matched against error/tool-result log text.
const SIG_PLAYWRIGHT =
  /playwright|\bbrowser_[a-z_]+|\bbrowser\b[^.\n]{0,60}\b(?:closed|disconnected|crashed|not connected|unavailable)|\btarget\b[^.\n]{0,60}\bclosed\b|has been closed|browsercontext|browsertype\.launch|page\.(?:goto|click|wait)|net::err|\bchromium\b|\bwebkit\b|\bmsedge\b|user-data-dir/i
const SIG_MCP = /\bmcp\b|mcp server|model context protocol|failed to (?:reconnect|connect) to/i
const SIG_CONNECTION =
  /econnrefused|econnreset|enotfound|etimedout|epipe|connection (?:refused|reset|closed|timed out|error|lost)|failed to (?:start|connect|launch|initialize|respond)|timed out|timeout|not responding|unresponsive|\bhang|\bhung|stalled|deadline exceeded/i
// The portal restarted/stopped mid-run (server shutdown, update, crash) — the run's
// child was killed and reconcile flagged it. Unambiguous, so it's classified first.
const SIG_INTERRUPTED =
  /\binterrupted\b|server (?:stopped|restarted|was shut down|shutdown|shutting down)|did not finish/i

/** A browser/device-driving tool whose presence signals the run was mid-browser-action. */
function isBrowserTool(tool?: string): boolean {
  return !!tool && (tool.startsWith('browser_') || /playwright|^mobile_|^mcp__playwright/i.test(tool))
}

function truncateLine(s: string, n = 300): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

/**
 * Inspect a finished run's event log and, when it ended badly, return a plain
 * explanation of WHY. Returns null when nothing actionable is found. Only meant
 * for runs that failed / errored / were canceled without a report.
 */
function diagnoseFailure(log: LogEvent[], status: string): FailureDiagnosis | null {
  if (status !== 'error' && status !== 'failed' && status !== 'canceled') return null

  // Collect the lines most likely to explain the failure: stderr / error events,
  // a non-zero process exit, and any tool-result/text/system line that trips a
  // known failure signature.
  const raw: string[] = []
  let exitCode: number | null = null
  let lastBrowserTool: string | null = null
  let sawPlaywright = false
  let sawMcp = false
  let sawConnection = false
  let sawInterrupted = false

  for (const e of log) {
    const text = e.text ?? ''
    if (e.kind === 'tool' && isBrowserTool(e.tool)) lastBrowserTool = e.tool ?? null

    const exitMatch = text.match(/exited with code (\d+)/i)
    if (e.kind === 'done' && exitMatch) {
      const code = Number(exitMatch[1])
      if (Number.isFinite(code) && code !== 0) exitCode = code
      continue
    }

    const signalsFailure =
      e.kind === 'error' ||
      SIG_PLAYWRIGHT.test(text) ||
      SIG_MCP.test(text) ||
      SIG_CONNECTION.test(text) ||
      SIG_INTERRUPTED.test(text)
    if (!signalsFailure) continue

    if (SIG_INTERRUPTED.test(text)) sawInterrupted = true
    if (SIG_PLAYWRIGHT.test(text) || isBrowserTool(e.tool)) sawPlaywright = true
    if (SIG_MCP.test(text)) sawMcp = true
    if (SIG_CONNECTION.test(text)) sawConnection = true

    // Keep genuinely informative lines (error events always; others only when they
    // matched a signature above), deduped and capped.
    const line = truncateLine(text)
    if (line && !raw.includes(line)) raw.push(line)
  }

  const evidence = raw.slice(-4)

  // Classify — most specific first. A server interruption is unambiguous, so it
  // wins even if the run had touched the browser earlier.
  if (sawInterrupted) {
    return {
      category: 'interrupted',
      title: 'The run was interrupted before it finished',
      detail:
        'The portal server stopped or restarted while this run was in progress, so testing was ' +
        'cut short and no report was written.',
      hint:
        'Start the run again. If this happens right after an update or restart, wait until the ' +
        'server is fully back up (the page reconnects on its own) before launching a new run.',
      evidence,
    }
  }
  // A browser tool left mid-flight with a connection/timeout signal is the classic
  // "Playwright MCP hung" case.
  if (sawPlaywright || lastBrowserTool) {
    return {
      category: 'playwright',
      title: 'The test browser (Playwright) stopped responding',
      detail:
        'The run could not drive the automated browser — the Playwright browser connection ' +
        (sawConnection ? 'hung or dropped' : 'failed') +
        `, so testing couldn't continue and no report was written${
          lastBrowserTool ? ` (it stalled during \`${lastBrowserTool}\`)` : ''
        }.`,
      hint:
        'Re-run the test. If it keeps happening, make sure no other QC run is using the browser ' +
        '(runs share one browser profile and execute one at a time), then restart the portal so ' +
        'the Playwright MCP server starts cleanly.',
      evidence,
    }
  }
  if (sawMcp) {
    return {
      category: 'mcp',
      title: 'An MCP tool server did not respond',
      detail:
        'A required MCP server failed to start or stopped responding, so the run could not ' +
        'complete and no report was produced.',
      hint: 'Open the MCP page to confirm the server connects, then re-run the test.',
      evidence,
    }
  }
  if (sawConnection) {
    return {
      category: 'connection',
      title: 'The run hit a connection error',
      detail:
        'A network or connection error stopped the run before it could finish testing and write ' +
        'a report.',
      hint: 'Check that the app URL is reachable from this machine, then re-run.',
      evidence,
    }
  }
  if (evidence.length > 0) {
    return {
      category: 'error',
      title: 'The run ended with an error',
      detail: 'The run stopped before writing a report. The error it reported is shown below.',
      hint: 'Check the full log for context, then re-run.',
      evidence,
    }
  }
  if (exitCode != null) {
    return {
      category: 'exit',
      title: 'The run exited unexpectedly',
      detail: `The Claude process ended (exit code ${exitCode}) before writing a report, so no results were recorded.`,
      hint: 'Open the full log to see what it was doing when it stopped, then re-run.',
      evidence,
    }
  }
  return null
}

const FAILURE_TONE: Record<FailureCategory, { ring: string; icon: string; chip: string }> = {
  playwright: {
    ring: 'border-red-500/30 bg-red-50/60 dark:bg-red-500/5',
    icon: 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400',
    chip: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  },
  mcp: {
    ring: 'border-red-500/30 bg-red-50/60 dark:bg-red-500/5',
    icon: 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400',
    chip: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  },
  connection: {
    ring: 'border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5',
    icon: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400',
  },
  interrupted: {
    ring: 'border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5',
    icon: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400',
  },
  exit: {
    ring: 'border-amber-500/30 bg-amber-50/60 dark:bg-amber-500/5',
    icon: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
    chip: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-400',
  },
  error: {
    ring: 'border-red-500/30 bg-red-50/60 dark:bg-red-500/5',
    icon: 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400',
    chip: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-400',
  },
}

/** Prominent, plain-language explanation of why a run failed, with the raw evidence. */
function RunFailureNotice({
  diagnosis,
  onViewLog,
  compact = false,
}: {
  diagnosis: FailureDiagnosis
  onViewLog?: () => void
  compact?: boolean
}) {
  const tone = FAILURE_TONE[diagnosis.category]
  return (
    <div
      className={cn(
        'rounded-3xl border p-5 shadow-none',
        tone.ring,
        compact && 'rounded-2xl p-4',
      )}
    >
      <div className="flex items-start gap-3">
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-2xl', tone.icon)}>
          <AlertCircle className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold tracking-tight">{diagnosis.title}</h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                tone.chip,
              )}
            >
              Why it failed
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{diagnosis.detail}</p>

          {diagnosis.evidence.length > 0 && (
            <div className="overflow-hidden rounded-xl border border-border/60 bg-zinc-950">
              <div className="border-b border-zinc-800 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                From the log
              </div>
              <div className="max-h-40 space-y-1 overflow-auto p-3 font-mono text-[11px] leading-relaxed text-red-300">
                {diagnosis.evidence.map((line, i) => (
                  <div key={i} className="whitespace-pre-wrap break-words">
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}

          {diagnosis.hint && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium text-foreground">What to try:</span> {diagnosis.hint}
            </p>
          )}

          {onViewLog && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onViewLog}
              className="mt-1 rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Terminal className="mr-1.5 size-3.5" />
              View full log
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

/** A compact key/value pair for the run's meta strip (started, finished, output…). */
function MetaInline({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-background text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
          {label}
        </div>
        <div className="truncate text-xs font-medium">{children}</div>
      </div>
    </div>
  )
}

/** Circular pass-rate gauge — the single headline metric for a run with results. */
function PassRateDonut({ rate, color }: { rate: number | null; color: string }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const dash = ((rate ?? 0) / 100) * circumference

  return (
    <div className="relative flex size-40 shrink-0 items-center justify-center">
      <svg viewBox="0 0 128 128" className="size-40 -rotate-90">
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="12"
          stroke="currentColor"
          className="text-muted"
        />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="12"
          strokeLinecap="round"
          stroke={color}
          strokeDasharray={`${dash} ${circumference}`}
          className="transition-[stroke-dasharray] duration-700"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-semibold tabular-nums tracking-tight">
          {rate === null ? '—' : `${rate}%`}
        </span>
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          pass rate
        </span>
      </div>
    </div>
  )
}

/** Outcome cards + a single segmented bar — the full pass/fail/partial/blocked split. */
function OutcomeBreakdown({ data, total }: { data: OutcomeDatum[]; total: number }) {
  return (
    <div className="flex w-full flex-col justify-center gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {data.map((item) => {
          const pct = total > 0 ? Math.round((item.value / total) * 100) : 0
          return (
            <div key={item.key} className={cn('rounded-2xl px-3 py-2.5 ring-1', item.tone)}>
              <div className="text-2xl font-semibold tabular-nums leading-none">{item.value}</div>
              <div className="mt-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide">
                <span>{item.label}</span>
                <span className="tabular-nums opacity-70">{pct}%</span>
              </div>
            </div>
          )
        })}
      </div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        title={data.map((d) => `${d.label} ${d.value}`).join(' · ')}
      >
        {data.map((item) =>
          item.value > 0 && total > 0 ? (
            <span
              key={item.key}
              className="h-full transition-[width] duration-500"
              style={{ width: `${(item.value / total) * 100}%`, backgroundColor: item.color }}
            />
          ) : null,
        )}
      </div>
    </div>
  )
}

function IssueClickupPanel({
  issuesMd,
  projectId,
  ticketId,
  slug,
}: {
  issuesMd: string | null
  projectId: string
  ticketId: string
  slug: string | null
}) {
  const issues = parseIssues(issuesMd)
  const [parentTask, setParentTask] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set(issues.map((issue) => issue.id)))
  const [created, setCreated] = useState<ClickupTask[]>([])

  const selectedIssues = issues.filter((issue) => selected.has(issue.id))
  const mutation = useMutation({
    mutationFn: () =>
      createClickupIssueSubtasks({
        parentTask,
        projectId,
        slug,
        issues: selectedIssues.map((issue) => ({
          title: issue.title,
          description: [
            issue.description,
            '',
            `Source: QC run ${ticketId}`,
          ].join('\n'),
          screenshots: issue.screenshots,
        })),
      }),
    onSuccess: (result) => {
      setCreated((prev) => [...result.created, ...prev])
      toast.success(`Created ${result.created.length} ClickUp subtask${result.created.length === 1 ? '' : 's'}`)
    },
    onError: (err) => {
      toast.error('Could not create ClickUp subtasks', {
        description: err instanceof Error ? err.message : 'ClickUp request failed.',
      })
    },
  })

  if (issues.length === 0) return null

  const allSelected = selected.size === issues.length

  return (
    <div className="mb-6 overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
      <div className="border-b border-border/60 bg-muted/60 px-5 py-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Send className="size-4" />
              Review issues and create ClickUp subtasks
            </div>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Paste the parent ClickUp ticket URL, pick issues, then create them inside that ticket's
              subtask list.
            </p>
          </div>
          <span className="w-fit rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums text-muted-foreground">
            {selectedIssues.length} selected
          </span>
        </div>
      </div>

      <div className="space-y-4 p-5">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
          <Input
            value={parentTask}
            onChange={(event) => setParentTask(event.target.value)}
            placeholder="Paste ClickUp ticket URL, e.g. https://app.clickup.com/t/86eut664j"
            className="h-10 rounded-full"
          />
          <Button
            onClick={() => mutation.mutate()}
            disabled={!parentTask.trim() || selectedIssues.length === 0 || mutation.isPending}
            className="min-w-40 rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Create subtasks
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setSelected(allSelected ? new Set() : new Set(issues.map((issue) => issue.id)))
            }
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {allSelected ? 'Clear selection' : 'Select all'}
          </Button>
          <span className="text-xs text-muted-foreground">
            Review the parsed issue cards before creating ClickUp subtasks.
          </span>
        </div>

        <div className="grid gap-3">
          {issues.map((issue, index) => {
            const checked = selected.has(issue.id)
            return (
              <label
                key={issue.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-2xl border border-border/60 p-3 transition-colors',
                  checked ? 'border-primary/30 bg-primary/5' : 'bg-muted/60 hover:bg-muted/40',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (event.target.checked) next.add(issue.id)
                      else next.delete(issue.id)
                      return next
                    })
                  }}
                  className="mt-1 size-4 accent-primary"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      #{index + 1}
                    </span>
                    <p className="font-medium leading-5">{issue.title}</p>
                  </div>
                  <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-muted-foreground">
                    {issue.description}
                  </p>
                </div>
              </label>
            )
          })}
        </div>

        {created.length > 0 && (
          <div className="rounded-2xl border border-border/60 bg-muted/30 p-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Created subtasks
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {created.map((task) => (
                <a
                  key={task.id}
                  href={task.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-background px-2 py-1 text-xs font-medium hover:text-primary"
                >
                  {task.displayId}
                  <ArrowUpRight className="size-3" />
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Numeric count badge shown on a tab trigger (e.g. Log 51). */
function TabBadge({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums leading-none transition-colors',
        n === 0
          ? 'bg-muted/60 text-muted-foreground/50'
          : active
            ? 'bg-primary/15 text-primary'
            : 'bg-muted-foreground/10 text-muted-foreground',
      )}
    >
      {n}
    </span>
  )
}

/** Presence dot for content tabs that aren't countable (report / issues markdown). */
function PresenceDot({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full transition-colors',
        on ? 'bg-emerald-500' : 'bg-muted-foreground/30',
      )}
    />
  )
}

/** A single content tab: icon + label + a count badge or presence dot. */
function TabItem({
  value,
  icon,
  label,
  count,
  present,
  active,
}: {
  value: TabValue
  icon: React.ReactNode
  label: string
  count?: number
  present?: boolean
  active: boolean
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'group min-h-9 flex-none gap-2 rounded-xl px-3.5 font-medium text-muted-foreground',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm',
        'hover:text-foreground',
      )}
    >
      <span className="text-muted-foreground/70 transition-colors group-data-[state=active]:text-foreground">
        {icon}
      </span>
      {label}
      {count !== undefined ? (
        <TabBadge n={count} active={active} />
      ) : (
        <PresenceDot on={!!present} />
      )}
    </TabsTrigger>
  )
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function fileKindIcon(kind: RunFile['kind']) {
  if (kind === 'image') return <ImageIcon className="size-3.5" />
  if (kind === 'markdown') return <FileText className="size-3.5" />
  if (kind === 'text') return <FileCode2 className="size-3.5" />
  return <FileIcon className="size-3.5" />
}

/** Preview a single output file: markdown rendered, images inline, text as a block. */
function FilePreview({ projectId, slug, file }: { projectId: string; slug: string; file: RunFile }) {
  const url = runFileUrl(projectId, slug, file.path)
  const isText = file.kind === 'markdown' || file.kind === 'text'
  const { data, isLoading, isError } = useQuery({
    queryKey: ['run-file', projectId, slug, file.path],
    queryFn: () =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      }),
    enabled: isText,
  })

  if (file.kind === 'image') {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <img
          src={url}
          alt={file.path}
          className="max-h-[70vh] w-full rounded-2xl border border-border/60 bg-muted/30 object-contain shadow-none"
        />
      </a>
    )
  }
  if (file.kind === 'other') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <FileIcon className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No preview for this file type.</p>
        <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
          <a href={url} target="_blank" rel="noreferrer">
            Open file
          </a>
        </Button>
      </div>
    )
  }
  if (isLoading) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
  }
  if (isError) {
    return <p className="py-12 text-center text-sm text-destructive">Could not load this file.</p>
  }
  if (file.kind === 'markdown') {
    return (
      <div className={prose}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={mdTableComponents}>
          {data ?? ''}
        </Markdown>
      </div>
    )
  }
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-relaxed shadow-none">
      {data}
    </pre>
  )
}

// ---- Executed test cases (filled after the run) ---------------------------

/** The run-fill writes this filled copy into the run's output folder. */
const EXECUTED_RE = /^testcases-executed\.(csv|md)$/i

/** Minimal CSV parser (quoted fields, escaped quotes, embedded newlines). */
function parseCsvClient(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

/** Parse a Markdown pipe table into rows (drops the `---` separator line). */
function parseMdTableClient(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
    .filter((l) => !(/^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes('-')))
    .map((l) =>
      l
        .replace(/^\s*\|/, '')
        .replace(/\|\s*$/, '')
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, '|').replace(/<br\s*\/?>/gi, '\n')),
    )
}

/**
 * Drop trailing columns that are empty across the header AND every row — some
 * test-case CSVs carry a run of trailing commas, which would otherwise render as
 * a stretch of blank columns after the last real one (e.g. after Note).
 */
function trimEmptyTrailingColumns(rows: string[][]): string[][] {
  if (!rows.length) return rows
  const width = Math.max(...rows.map((r) => r.length))
  let last = width - 1
  while (last >= 0 && rows.every((r) => (r[last] ?? '').trim() === '')) last--
  if (last === width - 1) return rows
  return rows.map((r) => r.slice(0, last + 1))
}

const isStatusHeaderCell = (h: string) => {
  const n = h.trim().toLowerCase().replace(/[^a-z]/g, '')
  return n === 'status' || n === 'teststatus' || n === 'executionstatus'
}

const isReferenceHeaderCell = (h: string) => {
  const n = h.trim().toLowerCase().replace(/[^a-z]/g, '')
  return n === 'reference' || n === 'ref' || n === 'bug' || n === 'bugid' || n === 'issue'
}

/** issue id (ISSUE-1 / BUG-42 / DEF-3) → full title, parsed from issues.md headings. */
function parseIssueTitles(md: string | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!md) return map
  for (const line of md.split('\n')) {
    const m = line.match(/^#{2,4}\s+((?:issue|bug|def|defect)-\d+)\b\s*(.*)$/i)
    if (!m) continue
    const id = m[1].toUpperCase()
    // Strip a leading severity like "(Medium)" and the em-dash/colon separator.
    const title = m[2].replace(/^\s*\([^)]*\)\s*/, '').replace(/^\s*[—\-:]\s*/, '').trim()
    if (!map.has(id)) map.set(id, title || m[1])
  }
  return map
}

const REF_TOKEN = /(https?:\/\/[^\s)]+|\b(?:issue|bug|def|defect)-\d+\b)/gi

/**
 * Render a Reference cell: issue ids (ISSUE-1) become chips linking to this run's
 * Issues tab (with the full issue title inline + on hover); raw URLs become
 * external links. Anything else stays plain text.
 */
function ReferenceCell({ value, issues }: { value: string; issues: Map<string, string> }) {
  if (!value) return <span className="text-muted-foreground/40">—</span>
  if (!REF_TOKEN.test(value)) return <>{value}</>
  const parts: React.ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  REF_TOKEN.lastIndex = 0
  while ((m = REF_TOKEN.exec(value)) !== null) {
    if (m.index > last) parts.push(value.slice(last, m.index))
    const tok = m[0]
    if (/^https?:/i.test(tok)) {
      parts.push(
        <a
          key={key++}
          href={tok}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-primary underline underline-offset-2 hover:opacity-80"
        >
          {tok}
        </a>,
      )
    } else {
      const id = tok.toUpperCase()
      const title = issues.get(id)
      parts.push(
        <span key={key++} className="inline-flex flex-col gap-0.5">
          <Link
            to={{ search: 'tab=issues', hash: `#${id.toLowerCase()}` }}
            title={title ? `${id} — ${title}` : id}
            className="inline-flex w-fit items-center gap-1 rounded-md border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[11px] font-medium text-primary transition-colors hover:border-primary/50 hover:bg-primary/10"
          >
            <AlertCircle className="size-3" />
            {tok}
          </Link>
          {title && <span className="text-xs leading-snug text-muted-foreground">{title}</span>}
        </span>,
      )
    }
    last = m.index + tok.length
  }
  if (last < value.length) parts.push(value.slice(last))
  return <span className="inline-flex flex-wrap items-baseline gap-1.5">{parts}</span>
}

/** Status pill tone — Passed/Failed/Blocked/Cancelled/Untested. */
function statusTone(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (s.startsWith('pass'))
    return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/30'
  if (s.startsWith('fail'))
    return 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/30'
  if (s.startsWith('block'))
    return 'bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:ring-amber-500/30'
  if (s.startsWith('cancel'))
    return 'bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-500/30'
  // Untested / unknown
  return 'bg-muted text-muted-foreground ring-border'
}

/** Renders the filled test-case sheet as a table with a color-coded Status column. */
function ExecutedTestcasesTab({
  projectId,
  slug,
  file,
  issuesMd,
}: {
  projectId: string
  slug: string | null
  file: RunFile | null
  issuesMd?: string | null
}) {
  const url = file && slug ? runFileUrl(projectId, slug, file.path) : ''
  const isCsv = !!file && /\.csv$/i.test(file.path)
  const issueTitles = useMemo(() => parseIssueTitles(issuesMd ?? null), [issuesMd])
  const { data, isLoading, isError } = useQuery({
    queryKey: ['run-file', projectId, slug, file?.path],
    queryFn: () =>
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      }),
    enabled: !!file && !!slug,
  })

  if (!file || !slug) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
          <ListChecks className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">No executed test-case sheet for this run.</p>
        <p className="max-w-md text-xs text-muted-foreground">
          It's written automatically after a successful run that has a report and a test-case file
          for the ticket.
        </p>
      </div>
    )
  }
  if (isLoading) return <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
  if (isError || !data)
    return (
      <p className="py-12 text-center text-sm text-destructive">
        Could not load the executed test cases.
      </p>
    )

  const rows = trimEmptyTrailingColumns(isCsv ? parseCsvClient(data) : parseMdTableClient(data))
  if (rows.length < 2) {
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-2xl border border-border/60 bg-muted/30 p-4 font-mono text-xs leading-relaxed">
        {data}
      </pre>
    )
  }
  const header = rows[0]
  const body = rows.slice(1)
  const statusIdx = header.findIndex(isStatusHeaderCell)
  const referenceIdx = header.findIndex(isReferenceHeaderCell)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Cloned from the ticket's test-case file and filled from this run's report ·{' '}
          <span className="font-mono">{file.path}</span>
        </p>
        <Button
          asChild
          variant="outline"
          size="sm"
          className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
        >
          <a href={url} target="_blank" rel="noreferrer">
            Open raw
            <ArrowUpRight className="ml-1.5 size-3.5" />
          </a>
        </Button>
      </div>
      <div className="max-h-[70vh] w-full overflow-auto rounded-2xl border border-border/60">
        <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              {/* Pinned row-number column header (top-left corner). */}
              <th className="sticky left-0 top-0 z-30 border-b border-r border-border/60 bg-muted px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                No.
              </th>
              {header.map((h, i) => (
                <th
                  key={i}
                  className="sticky top-0 z-20 whitespace-nowrap border-b border-r border-border/60 bg-muted px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground last:border-r-0"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((r, ri) => {
              const isFailed =
                statusIdx >= 0 && (r[statusIdx] ?? '').trim().toLowerCase().startsWith('fail')
              return (
              <tr
                key={ri}
                className={cn(
                  'group',
                  isFailed
                    ? 'bg-red-50/70 hover:bg-red-100/70 dark:bg-red-500/10 dark:hover:bg-red-500/[0.15]'
                    : 'hover:bg-muted/30',
                )}
              >
                {/* Pinned sequential row number. */}
                <td
                  className={cn(
                    'sticky left-0 z-10 border-b border-r border-border/60 px-3 py-2.5 text-right align-top font-mono text-xs tabular-nums',
                    isFailed
                      ? 'bg-red-50 text-red-600 group-hover:bg-red-100/70 dark:bg-red-500/10 dark:text-red-400'
                      : 'bg-card text-muted-foreground group-hover:bg-muted/30',
                  )}
                >
                  {ri + 1}
                </td>
                {header.map((_, ci) => {
                  const value = (r[ci] ?? '').trim()
                  const cls =
                    'max-w-[28rem] whitespace-pre-wrap break-words border-b border-r border-border/60 px-3 py-2.5 align-top last:border-r-0'
                  if (ci === statusIdx && value) {
                    return (
                      <td key={ci} className={cls}>
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1',
                            statusTone(value),
                          )}
                        >
                          {value}
                        </span>
                      </td>
                    )
                  }
                  if (ci === referenceIdx) {
                    return (
                      <td key={ci} className={cls}>
                        <ReferenceCell value={value} issues={issueTitles} />
                      </td>
                    )
                  }
                  return (
                    <td key={ci} className={cn(cls, ci === 0 && 'font-medium')}>
                      {value || <span className="text-muted-foreground/40">—</span>}
                    </td>
                  )
                })}
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** A file browser for the run's output folder (evidence + any extra files). */
function FilesTab({
  projectId,
  slug,
  files,
}: {
  projectId: string
  slug: string | null
  files: RunFile[]
}) {
  const [sel, setSel] = useState<string | null>(null)
  const active = files.find((f) => f.path === sel) ?? files[0] ?? null

  if (!slug || files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex size-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
          <Files className="size-5" />
        </div>
        <p className="text-sm text-muted-foreground">No extra evidence files for this run.</p>
      </div>
    )
  }

  return (
    <div className="grid overflow-hidden rounded-2xl border border-border/60 bg-card shadow-none lg:grid-cols-[18rem_1fr]">
      <ul className="max-h-[34rem] space-y-1 overflow-auto border-b border-border/60 bg-muted/25 p-2 lg:border-b-0 lg:border-r">
        {files.map((f) => {
          const isActive = active?.path === f.path
          return (
            <li key={f.path}>
              <button
                type="button"
                onClick={() => setSel(f.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-xs transition-colors',
                  isActive
                    ? 'bg-background text-foreground ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span className="shrink-0">{fileKindIcon(f.kind)}</span>
                <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                  {humanSize(f.size)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="min-w-0 p-4">
        {active && <FilePreview projectId={projectId} slug={slug} file={active} />}
      </div>
    </div>
  )
}

function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-6">
      <div className="h-8 w-24 rounded-full bg-muted" />
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-48 rounded-xl bg-muted" />
          <div className="h-6 w-20 rounded-full bg-muted" />
        </div>
        <div className="h-4 w-64 rounded bg-muted" />
      </div>
      <div className="h-56 rounded-3xl bg-muted" />
      <div className="h-72 rounded-3xl bg-muted" />
    </div>
  )
}

const TAB_VALUES = ['report', 'issues', 'screenshots', 'files', 'log'] as const
type TabValue = (typeof TAB_VALUES)[number]

export default function RunDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const { data: run, isLoading, isError, error } = useQuery({
    queryKey: ['run', id],
    queryFn: () => getRun(id),
    enabled: !!id,
  })
  // Output files (evidence etc.) for the Files tab + Open-folder button.
  const { data: filesData } = useQuery({
    queryKey: ['run-files', id],
    queryFn: () => listRunFiles(id),
    enabled: !!id,
  })
  // The run record only carries the ticket id; join against crawled tickets for
  // a human-readable title to show alongside it.
  const { data: crawledTickets } = useQuery({
    queryKey: ['crawled', run?.projectId],
    queryFn: () => listCrawledTickets(run!.projectId),
    enabled: !!run?.projectId,
  })
  const ticketTitle =
    (crawledTickets ?? []).find(
      (t) => (t.displayId ?? t.name) === run?.ticketId,
    )?.title ?? null

  // Delete the run (record + on-disk output) and return to history.
  const deleteMutation = useMutation({
    mutationFn: () => deleteRun(id),
    onSuccess: () => {
      toast.success('Test result deleted')
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      setConfirmDelete(false)
      navigate('/history')
    },
    onError: (err) => {
      toast.error('Could not delete this run', {
        description: err instanceof Error ? err.message : 'Delete failed.',
      })
    },
  })

  // The executed test-case sheet — fetched here (shares the cache with the table)
  // so the hero summary can count the REAL per-case statuses (Passed/Failed/
  // Blocked/Cancelled/Untested) instead of the report's ad-hoc buckets.
  const filesSlugForCounts = filesData?.slug ?? run?.slug ?? null
  const executedFileForCounts =
    (filesData?.files ?? []).find((f) => EXECUTED_RE.test(f.path.split('/').pop() ?? '')) ?? null
  const executedIsCsv = !!executedFileForCounts && /\.csv$/i.test(executedFileForCounts.path)
  const { data: executedText } = useQuery({
    queryKey: ['run-file', run?.projectId, filesSlugForCounts, executedFileForCounts?.path],
    queryFn: () =>
      fetch(runFileUrl(run!.projectId, filesSlugForCounts!, executedFileForCounts!.path)).then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      }),
    enabled: !!run?.projectId && !!filesSlugForCounts && !!executedFileForCounts,
  })
  const executedOutcomes = useMemo(
    () => (executedText ? countExecutedOutcomes(executedText, executedIsCsv) : null),
    [executedText, executedIsCsv],
  )

  // Deep-link scroll: a Reference chip links to ?tab=issues#issue-1 — once the
  // Issues tab is active and rendered, scroll that heading into view.
  const locationHash = location.hash
  const tabForScroll = searchParams.get('tab')
  useEffect(() => {
    if (tabForScroll !== 'issues' || !locationHash) return
    const targetId = decodeURIComponent(locationHash.replace(/^#/, ''))
    if (!targetId) return
    let tries = 0
    let raf = 0
    const tick = () => {
      const el = document.getElementById(targetId)
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        el.classList.add('ring-2', 'ring-primary/50', 'rounded-lg')
        window.setTimeout(() => el.classList.remove('ring-2', 'ring-primary/50', 'rounded-lg'), 2000)
      } else if (tries++ < 20) {
        raf = requestAnimationFrame(tick)
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [tabForScroll, locationHash])

  if (isLoading) {
    return <DetailSkeleton />
  }

  if (isError || !run) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2 rounded-full transition-all duration-200 active:scale-[0.98]">
          <Link to="/history">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to history
          </Link>
        </Button>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
              <AlertCircle className="h-6 w-6" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Could not load this run</p>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : 'Run not found'}
              </p>
            </div>
            <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
              <Link to="/history">Back to history</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const duration = formatDuration(run.createdAt, run.finishedAt)
  const isFail = run.status === 'failed' || run.status === 'error'
  const isCanceled = run.status === 'canceled'
  // When a run ended without a report, dig the real failure reason out of the log
  // (e.g. a hung Playwright/MCP browser) so we can show it instead of a bare
  // "check the log" — the Report/Issues tabs would otherwise be blank.
  const diagnosis = !run.reportMd ? diagnoseFailure(run.logTail, run.status) : null
  // A still-running run is using its session/output — deletion is blocked until it ends.
  const isRunActive =
    run.status === 'running' || run.status === 'queued' || run.status === 'paused'
  // The report's Result Summary is the authoritative QC verdict (it applies
  // rules the per-case fill can't, e.g. "Blocked: no data / non-mutating run").
  // Prefer it; fall back to counting the executed test-case sheet only when the
  // report has no parseable summary table.
  const reportOutcomes = parseReportOutcomes(run.reportMd, run)
  const outcomes =
    reportOutcomes.total > 0 ? reportOutcomes : (executedOutcomes ?? reportOutcomes)
  const hasResults = outcomes.total > 0
  const passRate = outcomes.passRate

  // Land on the first tab that actually has content. A canceled/errored run often
  // has only a log, so defaulting to an empty "Report" tab hides the useful part.
  const defaultTab: TabValue = run.reportMd
    ? 'report'
    : run.issuesMd
      ? 'issues'
      : run.screenshots.length > 0
        ? 'screenshots'
        : 'log'

  // The active tab lives in the URL (?tab=…) so each tab is linkable/back-able.
  const tabParam = searchParams.get('tab')
  const activeTab: TabValue =
    tabParam && (TAB_VALUES as readonly string[]).includes(tabParam)
      ? (tabParam as TabValue)
      : defaultTab
  const onTabChange = (value: string) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.set('tab', value)
        return next
      },
      { replace: true },
    )
  }

  // Headline outcome accent: green = passed, red = fail/error, neutral otherwise.
  const accentColor = isFail ? '#ef4444' : run.status === 'passed' ? '#10b981' : '#64748b'
  const headline =
    run.status === 'passed'
      ? 'Ready for sign-off'
      : isFail
        ? 'Needs attention'
        : 'Review required'

  // Files for the Files tab — exclude report/issues/screenshots (own tabs already)
  // and the executed test-case sheet (its own Test Cases tab).
  const filesSlug = filesData?.slug ?? run.slug
  const executedFile =
    (filesData?.files ?? []).find((f) => EXECUTED_RE.test(f.path.split('/').pop() ?? '')) ?? null
  const evidenceFiles = (filesData?.files ?? []).filter(
    (f) =>
      f.path !== 'report.md' &&
      f.path !== 'issues.md' &&
      !f.path.startsWith('screenshots/') &&
      f.path !== executedFile?.path,
  )

  return (
    <div className="space-y-6">
      {/* Hero — identity, actions, and the single consolidated result summary. */}
      <section className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
        <div className="space-y-5 px-6 pb-6 pt-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0 space-y-3">
              <Button asChild variant="ghost" size="sm" className="-ml-3 h-8 rounded-full transition-all duration-200 active:scale-[0.98]">
                <Link to="/history">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  History
                </Link>
              </Button>
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="font-mono text-3xl font-semibold tracking-tight sm:text-4xl">
                  {run.ticketId}
                </h1>
                <StatusBadge status={run.status} />
              </div>
              {ticketTitle && (
                <p className="text-lg font-medium tracking-tight text-foreground">
                  {ticketTitle}
                </p>
              )}
              <p className="text-sm text-muted-foreground">
                Acceptance test report
                {run.projectName && (
                  <>
                    {' · '}
                    <span className="font-medium text-foreground">{run.projectName}</span>
                  </>
                )}
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm" className="rounded-full transition-all duration-200 active:scale-[0.98]">
                <a href={run.appUrl} target="_blank" rel="noreferrer">
                  Open app
                  <ArrowUpRight className="ml-2 h-4 w-4" />
                </a>
              </Button>
              {filesSlug && <OpenFolderButton open={() => openRunFolder(run.id)} label="run output" />}
              {!isRunActive && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-full text-destructive transition-all duration-200 hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive active:scale-[0.98]"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </Button>
              )}
            </div>
          </div>

          {/* Result summary — donut + breakdown when results exist, else an explainer. */}
          {hasResults ? (
            <div className="flex flex-col items-center gap-6 rounded-2xl border border-border/60 bg-muted/40 p-5 md:flex-row md:items-stretch md:gap-8">
              <div className="flex flex-col items-center justify-center gap-2 md:border-r md:border-border/60 md:pr-8">
                <PassRateDonut rate={passRate} color={accentColor} />
                <div className="text-center">
                  <div className="text-sm font-semibold tracking-tight">{headline}</div>
                  <div className="text-xs text-muted-foreground">
                    {outcomes.total} {outcomes.unit}
                  </div>
                </div>
              </div>
              <OutcomeBreakdown data={outcomes.data} total={outcomes.total} />
            </div>
          ) : (
            // No pass/fail recorded — explain why instead of showing a row of zeros.
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-4 py-10 text-center">
              <span
                className={cn(
                  'flex size-11 items-center justify-center rounded-full',
                  isFail
                    ? 'bg-red-100 text-red-600'
                    : isCanceled
                      ? 'bg-amber-100 text-amber-600'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {isFail ? (
                  <AlertCircle className="size-5" />
                ) : isCanceled ? (
                  <Ban className="size-5" />
                ) : (
                  <ListChecks className="size-5" />
                )}
              </span>
              <p className="text-sm font-medium">
                {isCanceled
                  ? 'Run was canceled'
                  : isFail
                    ? 'Run did not complete'
                    : 'No acceptance criteria evaluated'}
              </p>
              <p className="max-w-md text-xs text-muted-foreground">
                {isCanceled
                  ? 'It was stopped before any acceptance criteria were checked. See the log for what ran.'
                  : isFail
                    ? diagnosis
                      ? 'The run ended early, so no pass/fail results were recorded — see the reason below.'
                      : 'The run ended early, so no pass/fail results were recorded. Check the log for details.'
                    : 'This run recorded no acceptance criteria.'}
              </p>
            </div>
          )}
        </div>

        {/* Meta strip — context that supports the result, kept low-key in the footer. */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border/60 bg-muted/30 px-6 py-4 sm:grid-cols-3 xl:grid-cols-5">
          <MetaInline icon={<CalendarClock className="h-4 w-4" />} label="Started">
            <span className="font-mono" title={formatDate(run.createdAt)}>
              {formatDate(run.createdAt)}
            </span>
          </MetaInline>
          <MetaInline icon={<CalendarClock className="h-4 w-4" />} label="Finished">
            <span className="font-mono" title={formatDate(run.finishedAt)}>
              {formatDate(run.finishedAt)}
            </span>
          </MetaInline>
          <MetaInline icon={<Timer className="h-4 w-4" />} label="Duration">
            <span className="font-mono">{duration ?? '—'}</span>
          </MetaInline>
          <MetaInline icon={<Globe className="h-4 w-4" />} label="App URL">
            <a
              href={run.appUrl}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-primary underline-offset-2 hover:underline"
              title={run.appUrl}
            >
              {run.appUrl}
            </a>
          </MetaInline>
          {filesSlug && (
            <MetaInline icon={<Folder className="h-4 w-4" />} label="Output">
              <span className="font-mono" title={`testing/${filesSlug}`}>
                testing/{filesSlug}
              </span>
            </MetaInline>
          )}
        </div>
      </section>

      {/* Why the run failed — surfaced up front so the reason (e.g. a hung
          Playwright/MCP browser) isn't buried in the Log tab. */}
      {diagnosis && (
        <RunFailureNotice diagnosis={diagnosis} onViewLog={() => onTabChange('log')} />
      )}

      {run.hasSession && (
        <ContinueSessionPanel runId={run.id} runStatus={run.status} hasSession={run.hasSession} />
      )}

      {/* Content tabs */}
      <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
        <CardContent className="px-0">
          <Tabs value={activeTab} onValueChange={onTabChange}>
            <div className="sticky top-0 z-10 border-b border-border/60 bg-card/95 px-5 py-3 backdrop-blur">
              <TabsList className="h-auto w-full justify-start gap-1 overflow-x-auto rounded-2xl bg-muted/70 p-1.5">
                <TabItem
                  value="report"
                  icon={<FileText className="size-4" />}
                  label="Report"
                  present={!!run.reportMd}
                  active={activeTab === 'report'}
                />
                <TabItem
                  value="issues"
                  icon={<AlertCircle className="size-4" />}
                  label="Issues"
                  present={!!run.issuesMd}
                  active={activeTab === 'issues'}
                />
                <TabItem
                  value="screenshots"
                  icon={<ImageIcon className="size-4" />}
                  label="Screenshots"
                  count={run.screenshots.length}
                  active={activeTab === 'screenshots'}
                />
                <TabItem
                  value="files"
                  icon={<Files className="size-4" />}
                  label="Files"
                  count={evidenceFiles.length}
                  active={activeTab === 'files'}
                />
                <TabItem
                  value="log"
                  icon={<Terminal className="size-4" />}
                  label="Log"
                  count={run.logTail.length}
                  active={activeTab === 'log'}
                />
              </TabsList>
            </div>

            <TabsContent value="report" className="m-0 space-y-8 p-6">
              {/* Full report first (summary + narrative), then the per-case
                  results as a table in the ticket's test-case shape. */}
              <section className="space-y-3">
                {!run.reportMd && diagnosis ? (
                  <RunFailureNotice diagnosis={diagnosis} onViewLog={() => onTabChange('log')} />
                ) : (
                  <EvidenceReport
                    md={
                      executedFile && run.reportMd
                        ? stripCaseDetailSection(run.reportMd)
                        : run.reportMd
                    }
                    empty="No report was generated for this run."
                    icon={<FileText className="h-5 w-5" />}
                    projectId={run.projectId}
                    slug={filesSlug}
                    files={filesData?.files ?? []}
                  />
                )}
              </section>
              {executedFile && (
                <section className="space-y-3">
                  <div className="flex items-center gap-2 border-t border-border/60 pt-6">
                    <ListChecks className="size-4 text-muted-foreground" />
                    <h2 className="text-base font-semibold tracking-tight">Test execution results</h2>
                  </div>
                  <ExecutedTestcasesTab
                    projectId={run.projectId}
                    slug={filesSlug}
                    file={executedFile}
                    issuesMd={run.issuesMd}
                  />
                </section>
              )}
            </TabsContent>

            <TabsContent value="issues" className="m-0 p-6">
              <IssueClickupPanel
                issuesMd={run.issuesMd}
                projectId={run.projectId}
                ticketId={run.ticketId}
                slug={run.slug ?? null}
              />
              {!run.issuesMd && diagnosis ? (
                <RunFailureNotice diagnosis={diagnosis} onViewLog={() => onTabChange('log')} />
              ) : (
                <EvidenceReport
                  md={run.issuesMd}
                  empty="No issues were logged for this run."
                  icon={<AlertCircle className="h-5 w-5" />}
                  projectId={run.projectId}
                  slug={filesSlug}
                  files={filesData?.files ?? []}
                />
              )}
            </TabsContent>

            <TabsContent value="screenshots" className="m-0 p-6">
              {run.screenshots.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
                    <ImageIcon className="h-5 w-5" />
                  </div>
                  <p className="text-sm text-muted-foreground">No screenshots were captured.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {run.screenshots.map((path) => {
                    const src = screenshotUrl(run.projectId, run.slug ?? '', path)
                    const name = path.split('/').pop() ?? path
                    return (
                      <a
                        key={path}
                        href={src}
                        target="_blank"
                        rel="noreferrer"
                        className="group overflow-hidden rounded-2xl border border-border/60 bg-card shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.98]"
                      >
                        <div className="overflow-hidden">
                          <img
                            src={src}
                            alt={`Screenshot ${name}`}
                            loading="lazy"
                            className="aspect-video w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                          />
                        </div>
                        <div className="flex items-center gap-1.5 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                          <FileText className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate font-mono" title={name}>
                            {name}
                          </span>
                        </div>
                      </a>
                    )
                  })}
                </div>
              )}
            </TabsContent>

            <TabsContent value="files" className="m-0 p-6">
              <FilesTab projectId={run.projectId} slug={filesSlug} files={evidenceFiles} />
            </TabsContent>

            <TabsContent value="log" className="m-0 p-6">
              <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-none">
                <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
                  <span className="flex gap-1.5" aria-hidden>
                    <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80" />
                    <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
                  </span>
                  <span className="ml-1 font-mono text-[11px] tracking-wide text-zinc-500">
                    qc-testing · event log
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-zinc-600">
                    {run.logTail.length} {run.logTail.length === 1 ? 'event' : 'events'}
                  </span>
                </div>
                <ScrollArea className="h-96 p-4">
                  <div className="space-y-1 font-mono text-xs leading-relaxed">
                    {run.logTail.length === 0 && (
                      <div className="flex items-center gap-2 text-zinc-500">
                        <span className="inline-block h-1.5 w-1.5 rounded-full bg-zinc-600" />
                        No log entries.
                      </div>
                    )}
                    {run.logTail.map((e, i) => (
                      <div key={i} className={cn(logLineClass(e.kind))}>
                        <span className="mr-2 select-none text-zinc-600">
                          {new Date(e.ts).toLocaleTimeString()}
                        </span>
                        {e.tool && <span className="mr-1 text-zinc-400">[{e.tool}]</span>}
                        <span className="whitespace-pre-wrap break-words">{e.text}</span>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Delete confirmation — removes the run record AND its on-disk output folder. */}
      <Dialog
        open={confirmDelete}
        onOpenChange={(open) => !deleteMutation.isPending && setConfirmDelete(open)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <Trash2 className="size-4" />
              </span>
              Delete test result?
            </DialogTitle>
            <DialogDescription className="pt-1">
              This permanently deletes run{' '}
              <span className="font-mono font-medium text-foreground">{run.ticketId}</span> — its
              report, issues, screenshots, and evidence on disk
              {filesSlug && (
                <>
                  {' '}
                  (<span className="font-mono">testing/{filesSlug}</span>)
                </>
              )}
              , plus its history entry and log. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleteMutation.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              {deleteMutation.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 size-4" />
              )}
              Delete result
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
