import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Today's Claude token usage on THIS machine — the same numbers as the "Token usage" box
// `auto-agent-ai login` prints. The CLI has no command that outputs them, and it does
// not ask its server either: it reads Claude Code's own session transcripts
// (`<config dir>/projects/**/*.jsonl`) and sums `message.usage` for today. This is a port
// of that scan (CLI 1.1.20), kept faithful so the dialog and the terminal agree:
//
//  - "today" is the calendar day in UTC+7, fixed — the CLI's clock, not the machine's.
//  - a file untouched since 26h before that day began cannot hold a line from it.
//  - one API response is written several times (once per content block, and again by a
//    subagent's sidechain), so lines are de-duplicated by message id + request id.
//  - the headline is BILLABLE tokens: input + output + cache creation. Cache reads are
//    shown but not counted — they are where the huge number lives.
//
// Unlike the portal's own `usage_events`, this counts EVERY `claude` on the machine: the
// terminal, the IDE, and the portal's runs alike. It reads transcripts, so it reads
// prompts — but returns nothing but counts and model names.

const DAY_OFFSET_MS = 7 * 60 * 60 * 1000 // UTC+7
const LOOKBACK_MS = 26 * 60 * 60 * 1000
const CACHE_MS = 60_000

export interface ModelTokenUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

export interface ClaudeTokenUsage {
  /** `YYYY-MM-DD` in UTC+7. */
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  /** input + output + cache creation — the CLI's headline number. */
  billableTokens: number
  totalTokens: number
  models: ModelTokenUsage[]
  filesScanned: number
  generatedAt: string
}

function dayKey(d: Date): string {
  const s = new Date(d.getTime() + DAY_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`
}

function dayStartMs(d: Date): number {
  const s = new Date(d.getTime() + DAY_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - DAY_OFFSET_MS
}

function configDirs(): string[] {
  const dirs: string[] = []
  const env = process.env.CLAUDE_CONFIG_DIR?.trim()
  if (env) {
    for (const part of env.split(new RegExp(`[${path.delimiter},]`))) {
      if (part.trim()) dirs.push(part.trim())
    }
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config')
  dirs.push(path.join(xdg, 'claude'), path.join(os.homedir(), '.claude'))
  return [...new Set(dirs)]
}

async function* jsonlFiles(dir: string): AsyncGenerator<string> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) yield* jsonlFiles(full)
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full
  }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

interface Seen {
  byMessageAndRequest: Set<string>
  /** message id -> whether its first sighting was a sidechain line */
  byMessage: Map<string, boolean>
}

interface TranscriptLine {
  timestamp?: string
  requestId?: string
  isSidechain?: boolean
  message?: {
    id?: string
    model?: unknown
    usage?: Record<string, unknown>
  }
}

/** The CLI's de-duplication rule, verbatim in behaviour. */
function isDuplicate(line: TranscriptLine, seen: Seen): boolean {
  const id = line.message?.id
  if (!id) return false
  const key = `${id}\0${line.requestId ?? ''}`
  if (seen.byMessageAndRequest.has(key)) return true
  const sidechain = line.isSidechain === true
  const first = seen.byMessage.get(id)
  if (first !== undefined && (sidechain || first)) return true
  seen.byMessageAndRequest.add(key)
  if (first === undefined) seen.byMessage.set(id, sidechain)
  return false
}

async function scan(): Promise<ClaudeTokenUsage> {
  const now = new Date()
  const today = dayKey(now)
  const oldest = dayStartMs(now) - LOOKBACK_MS
  const out: ClaudeTokenUsage = {
    date: today,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    billableTokens: 0,
    totalTokens: 0,
    models: [],
    filesScanned: 0,
    generatedAt: now.toISOString(),
  }
  const models = new Map<string, ModelTokenUsage>()
  const visited = new Set<string>()
  const seen: Seen = { byMessageAndRequest: new Set(), byMessage: new Map() }

  for (const dir of configDirs()) {
    for await (const file of jsonlFiles(path.join(dir, 'projects'))) {
      let real = file
      try {
        real = await fs.promises.realpath(file)
      } catch {
        /* keep the path as found */
      }
      if (visited.has(real)) continue
      visited.add(real)
      let text: string
      try {
        if ((await fs.promises.stat(file)).mtimeMs < oldest) continue
        text = await fs.promises.readFile(file, 'utf8')
      } catch {
        continue
      }
      out.filesScanned++
      for (const raw of text.split('\n')) {
        if (!raw) continue
        let line: TranscriptLine
        try {
          line = JSON.parse(raw) as TranscriptLine
        } catch {
          continue
        }
        if (!line.timestamp) continue
        const at = new Date(line.timestamp)
        if (Number.isNaN(at.getTime()) || dayKey(at) !== today) continue
        const usage = line.message?.usage
        if (!usage || isDuplicate(line, seen)) continue
        const input = num(usage.input_tokens)
        const output = num(usage.output_tokens)
        const cacheRead = num(usage.cache_read_input_tokens)
        const cacheCreate = num(usage.cache_creation_input_tokens)
        out.inputTokens += input
        out.outputTokens += output
        out.cacheReadTokens += cacheRead
        out.cacheCreationTokens += cacheCreate
        const name = typeof line.message?.model === 'string' ? line.message.model : 'unknown'
        const m = models.get(name) ?? {
          model: name,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        }
        m.inputTokens += input
        m.outputTokens += output
        m.cacheReadTokens += cacheRead
        m.cacheCreationTokens += cacheCreate
        models.set(name, m)
      }
    }
  }

  out.billableTokens = out.inputTokens + out.outputTokens + out.cacheCreationTokens
  out.totalTokens = out.billableTokens + out.cacheReadTokens
  const size = (m: ModelTokenUsage) =>
    m.inputTokens + m.outputTokens + m.cacheCreationTokens + m.cacheReadTokens
  // `<synthetic>` lines (CLI-made placeholders) carry all-zero usage — not a model.
  out.models = [...models.values()].filter((m) => size(m) > 0).sort((a, b) => size(b) - size(a))
  return out
}

let cache: { at: number; value: ClaudeTokenUsage } | null = null
let inFlight: Promise<ClaudeTokenUsage> | null = null

/**
 * Cached for a minute and single-flight: a busy day's transcripts run to tens of MB, and
 * the dialog polls. Async so the scan never stalls the event loop mid-run.
 */
export function readClaudeTokenUsage(force = false): Promise<ClaudeTokenUsage> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.value)
  if (inFlight) return inFlight
  inFlight = scan()
    .then((value) => {
      cache = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}
