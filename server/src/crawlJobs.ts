import { randomUUID } from 'node:crypto'
import { crawlOneTicket, type CrawlResult, type TicketKind, type TicketSource } from './crawl.js'
import { withClickupToken } from './clickup.js'
import { withJiraCreds, type JiraCreds } from './jira.js'
import { withAzureCreds, type AzureCreds } from './azure.js'

// In-memory background jobs for ticket crawling. A job runs server-side, so it
// keeps going even if the browser reloads or navigates away — the client polls by
// id to show progress. Jobs live for the life of the server process (a restart
// drops them); that's enough to survive browser reloads. Mirrors testcaseJobs.ts.

export type CrawlItemStatus = 'pending' | 'running' | 'done' | 'error'

export interface CrawlJobItem {
  taskId: string
  displayId: string
  name: string
  /** Nested folder path (e.g. "PARENT/CHILD") to write under testing/tickets/;
   *  omitted → flat <displayId>/. */
  relDir?: string
  status: CrawlItemStatus
  result?: CrawlResult
  error?: string
}

export type CrawlLogLevel = 'info' | 'success' | 'error'

export interface CrawlLogLine {
  time: string // ISO
  level: CrawlLogLevel
  text: string
}

const MAX_LOG_LINES = 800

interface CrawlJob {
  id: string
  projectId: string
  projectName: string
  rootPath: string
  source: TicketSource // which tracker the tickets come from
  token: string | undefined // ClickUp token captured at start (per-project .mcp.json)
  jiraCreds: JiraCreds | undefined // Jira creds captured at start (per-project .mcp.json)
  azureCreds: AzureCreds | undefined // Azure creds captured at start (per-project .mcp.json)
  model: string
  ticketKind: TicketKind | null
  items: CrawlJobItem[]
  logs: CrawlLogLine[]
  total: number
  doneCount: number
  status: 'running' | 'done'
  createdAt: string
  updatedAt: string
}

/** What we expose to the client — never the rootPath / token. */
export interface PublicCrawlJob {
  id: string
  projectId: string
  status: 'running' | 'done'
  model: string
  ticketKind: TicketKind | null
  total: number
  doneCount: number
  createdAt: string
  updatedAt: string
  items: CrawlJobItem[]
  logs: CrawlLogLine[]
}

const jobs = new Map<string, CrawlJob>()
const MAX_JOBS = 50

function nowIso(): string {
  return new Date().toISOString()
}

function toPublic(j: CrawlJob): PublicCrawlJob {
  return {
    id: j.id,
    projectId: j.projectId,
    status: j.status,
    model: j.model,
    ticketKind: j.ticketKind,
    total: j.total,
    doneCount: j.doneCount,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
    items: j.items.map((i) => ({ ...i })),
    logs: j.logs.map((l) => ({ ...l })),
  }
}

function pushLog(job: CrawlJob, level: CrawlLogLevel, text: string): void {
  job.logs.push({ time: nowIso(), level, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  for (const j of finished) {
    if (jobs.size <= MAX_JOBS) break
    jobs.delete(j.id)
  }
}

/** Process every item sequentially (gentler on the ClickUp API). Never throws. */
async function runJob(job: CrawlJob): Promise<void> {
  pushLog(
    job,
    'info',
    `Crawling ${job.total} ticket${job.total === 1 ? '' : 's'}` +
      (job.ticketKind ? ` · ${job.ticketKind === 'bug' ? 'bug' : 'feature'} ticket` : '') +
      (job.model && job.model !== 'none' ? ` · summary model ${job.model}` : ' · download only'),
  )
  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i]
    item.status = 'running'
    pushLog(job, 'info', `▶ [${i + 1}/${job.total}] ${item.displayId} — ${item.name}`)
    try {
      // Re-establish the tracker creds context — the original request is long gone.
      const runOne = () =>
        crawlOneTicket({
          taskId: item.taskId,
          rootPath: job.rootPath,
          model: job.model,
          ticketKind: job.ticketKind,
          source: job.source,
          relDir: item.relDir,
          onLog: (l) => pushLog(job, l.level, `  ${l.text}`),
        })
      const r = await (job.source === 'jira'
        ? withJiraCreds(job.jiraCreds, runOne)
        : job.source === 'azure'
          ? withAzureCreds(job.azureCreds, runOne)
          : withClickupToken(job.token, runOne))
      item.status = 'done'
      item.result = r
      const att = r.attachmentCount ? ` · ${r.attachmentCount} attachment(s)` : ''
      pushLog(job, 'success', `✓ ${item.displayId} · ${r.files.length} file(s)${att}`)
    } catch (err) {
      item.status = 'error'
      item.error = (err as Error).message || 'Crawl failed'
      pushLog(job, 'error', `✗ ${item.displayId} — ${item.error}`)
    }
    job.doneCount++
    job.updatedAt = nowIso()
  }
  job.status = 'done'
  const ok = job.items.filter((i) => i.status === 'done').length
  pushLog(job, ok === job.total ? 'success' : 'info', `Done — ${ok}/${job.total} crawled`)
}

export function startCrawlJob(opts: {
  projectId: string
  projectName: string
  rootPath: string
  source?: TicketSource
  token?: string | undefined
  jiraCreds?: JiraCreds | undefined
  azureCreds?: AzureCreds | undefined
  model: string
  ticketKind?: TicketKind | null
  tickets: { id: string; displayId: string; name: string; relDir?: string }[]
}): PublicCrawlJob {
  const job: CrawlJob = {
    id: randomUUID(),
    projectId: opts.projectId,
    projectName: opts.projectName,
    rootPath: opts.rootPath,
    source: opts.source ?? 'clickup',
    token: opts.token,
    jiraCreds: opts.jiraCreds,
    azureCreds: opts.azureCreds,
    model: opts.model,
    ticketKind: opts.ticketKind === 'bug' || opts.ticketKind === 'feature' ? opts.ticketKind : null,
    items: opts.tickets.map((t) => ({
      taskId: t.id,
      displayId: t.displayId,
      name: t.name,
      relDir: t.relDir,
      status: 'pending' as const,
    })),
    logs: [],
    total: opts.tickets.length,
    doneCount: 0,
    status: 'running',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  jobs.set(job.id, job)
  prune()

  // Fire and forget — the route returns immediately. Guard against an unexpected
  // throw so a bug can't crash the process; mark any unfinished items as errored.
  runJob(job).catch((err) => {
    for (const it of job.items) {
      if (it.status === 'pending' || it.status === 'running') {
        it.status = 'error'
        it.error = (err as Error).message || 'Crawl failed'
      }
    }
    job.status = 'done'
    pushLog(job, 'error', `Job aborted — ${(err as Error).message || 'unexpected error'}`)
  })

  return toPublic(job)
}

export function getCrawlJob(id: string): PublicCrawlJob | undefined {
  const j = jobs.get(id)
  return j ? toPublic(j) : undefined
}

export function listCrawlJobs(projectId: string): PublicCrawlJob[] {
  return [...jobs.values()]
    .filter((j) => j.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}
