import spawn from 'cross-spawn'
import { CLAUDE_BIN } from './config.js'
import { recordUsage } from './db.js'
import { spawnEnv } from './toolPath.js'

/** Extract cost + token usage from a Claude CLI result object (or null). */
export function usageFromResultObject(
  j: unknown,
): { costUsd: number; inputTokens: number; outputTokens: number } | null {
  if (!j || typeof j !== 'object') return null
  const o = j as {
    total_cost_usd?: number
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  const cost = typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0
  const u = o.usage ?? {}
  const inputTokens =
    (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  const outputTokens = u.output_tokens ?? 0
  if (!cost && !inputTokens && !outputTokens) return null
  return { costUsd: cost, inputTokens, outputTokens }
}

/** Parse cost/tokens from a buffered `--output-format json` result string. */
export function parseClaudeUsage(
  raw: string,
): { costUsd: number; inputTokens: number; outputTokens: number } | null {
  try {
    return usageFromResultObject(JSON.parse(raw.trim()))
  } catch {
    return null
  }
}

export interface ClaudeResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Deliver the prompt to the spawned CLI over stdin (`claude -p` reads stdin when no
 * prompt positional is given). Passing the prompt this way — instead of as the final
 * argv entry — keeps a large prompt off the OS command line, which Windows caps at
 * ~32 KB (a longer one throws `spawn ENAMETOOLONG`). No-op when input is undefined.
 */
function writeStdin(child: { stdin?: NodeJS.WritableStream | null }, input?: string): void {
  if (input == null || !child.stdin) return
  // A broken pipe (child died early) must not crash the server.
  child.stdin.on('error', () => {})
  child.stdin.end(input)
}

/**
 * Run the Claude CLI headlessly with the given args and resolve with its output.
 * Never rejects — a spawn error or timeout resolves with code: null so callers
 * can treat AI as a best-effort, non-fatal step.
 *
 * Pass opts.cwd to run inside a project folder so the project's .mcp.json servers
 * (Figma, Playwright, …) load — required when the prompt needs tools.
 */
export function runClaude(
  args: string[],
  timeoutMs: number,
  opts?: {
    cwd?: string
    usageSource?: string
    model?: string | null
    input?: string
    signal?: AbortSignal
  },
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    // When opts.input is set, the prompt is delivered over stdin (so a large prompt
    // can't blow the OS command-line length limit — Windows caps argv at 32 KB and
    // throws ENAMETOOLONG). Otherwise stdin is 'ignore' so the CLI sees EOF immediately
    // instead of waiting ~3s for piped stdin that never comes.
    const child = spawn(CLAUDE_BIN, args, {
      env: spawnEnv(),
      cwd: opts?.cwd,
      stdio: [opts?.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true, // no cmd window flash on Windows
    })
    writeStdin(child, opts?.input)
    const timer = setTimeout(() => {
      settled = true
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, timeoutMs)

    // Caller-driven cancellation (e.g. the HTTP request was aborted): kill the child
    // so a headless run doesn't keep burning tokens after nobody's listening.
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ code: null, stdout, stderr, timedOut: false })
    }
    if (opts?.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (d) => (stdout += String(d)))
    child.stderr?.on('data', (d) => (stderr += String(d)))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: err.message, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (opts?.usageSource) {
        const usage = parseClaudeUsage(stdout)
        if (usage) recordUsage({ source: opts.usageSource, model: opts.model, ...usage })
      }
      resolve({ code, stdout, stderr, timedOut: false })
    })
  })
}

export interface StreamLog {
  level: 'info' | 'success' | 'error'
  text: string
  /**
   * Set on a `⚙ <tool>` line only: the tool call in structured form, so a caller can
   * show WHAT it is working on ("Read · ChatPage.tsx") instead of re-parsing the text.
   * `text` is deliberately left as the bare `⚙ <name>` every other log consumer already
   * renders — this rides alongside it.
   */
  tool?: { name: string; detail?: string }
}

/** Max length of the target shown beside a tool name (a whole bash line is unreadable). */
const TOOL_DETAIL_CHARS = 64

/**
 * The one interesting argument of a tool call — the file being read, the pattern being
 * searched for, the command being run. "Reading" for 40 seconds says nothing; "Reading
 * ChatPage.tsx" is the same wait with the work attached.
 */
function toolDetail(name: string, input: unknown): string | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const base = (v: unknown) => {
    const p = str(v)
    return p ? p.split(/[\\/]/).filter(Boolean).pop() : undefined
  }
  let d: string | undefined
  switch (name) {
    case 'Read':
    case 'NotebookRead':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      d = base(i.file_path ?? i.notebook_path)
      break
    case 'Grep':
      d = str(i.pattern)
      break
    case 'Glob':
      d = str(i.pattern)
      break
    case 'Bash':
      d = str(i.description) ?? str(i.command)
      break
    case 'WebFetch':
      d = str(i.url)
      break
    case 'WebSearch':
      d = str(i.query)
      break
    case 'Task':
      d = str(i.description)
      break
    default:
      d = str(i.description) ?? str(i.pattern) ?? base(i.file_path)
  }
  if (!d) return undefined
  d = d.replace(/\s+/g, ' ')
  return d.length > TOOL_DETAIL_CHARS ? `${d.slice(0, TOOL_DETAIL_CHARS - 1)}…` : d
}

export interface StreamResult {
  text: string
  isError: boolean
  code: number | null
  timedOut: boolean
  /** True when the caller's AbortSignal fired and the child was killed. */
  aborted: boolean
}

/**
 * Run the Claude CLI with `--output-format stream-json` and forward meaningful
 * events as log lines via `onLog` so callers can surface progress in real time.
 * Resolves with the final `result` text. Never rejects (mirrors runClaude).
 *
 * Pass opts.signal to make the run cancellable — when it fires, the child is
 * killed and the result comes back with `aborted: true`.
 *
 * This is additive — runClaude (buffered JSON) is left untouched for the callers
 * that don't need streaming (e.g. crawl summaries).
 */
export function runClaudeStream(
  args: string[],
  timeoutMs: number,
  onLog: (log: StreamLog) => void,
  opts?: {
    signal?: AbortSignal
    usageSource?: string
    model?: string | null
    cwd?: string
    input?: string
    // Called with each incremental text chunk when the CLI is run with
    // `--include-partial-messages` (stream_event / content_block_delta). Lets a caller
    // surface the assistant's output token-by-token; no-op otherwise.
    onDelta?: (text: string) => void
    // When true, the full assistant text block isn't emitted via onLog (a caller that
    // already consumes it through onDelta doesn't want it duplicated into the log).
    // Tool-use and other events are still logged.
    suppressAssistantText?: boolean
    // The CLI's session id, reported once from the stream-json `init` event. A caller
    // that wants a MULTI-TURN conversation stores it and passes `--resume <id>` on the
    // next run — otherwise every turn starts from an empty context (see routes/chat.ts).
    onSession?: (sessionId: string) => void
    // The model the CLI actually resolved, from the same `init` event. A caller that runs
    // WITHOUT `--model` (to inherit the user's own default, as chat does for Terminal
    // parity) has no other way to record which model answered.
    onModel?: (model: string) => void
    // Kill the child after this long with NO output at all, and treat `timeoutMs` as an
    // absolute ceiling instead of the only clock. A turn that is still grepping, reading
    // and writing text is making progress — the wall-clock cap exists for a HUNG child,
    // not a thorough one, and killing a working turn throws the whole answer away.
    // Omit it and the behaviour is exactly as before: one fixed timer.
    idleTimeoutMs?: number
  },
): Promise<StreamResult> {
  return new Promise((resolve) => {
    let settled = false
    let resultText = ''
    /** Any text delta has been forwarded — drives the block separator (see stream_event). */
    let sawText = false
    let isError = false
    let stdoutBuf = ''
    let usage: { costUsd: number; inputTokens: number; outputTokens: number } | null = null
    // When opts.input is set, the prompt arrives over stdin (keeps a large prompt off
    // the OS command line — Windows caps argv at ~32 KB → ENAMETOOLONG). Otherwise stdin
    // is 'ignore' so the CLI sees EOF immediately instead of waiting ~3s for piped stdin
    // that never comes ("no stdin data received in 3s" warning).
    // Pass opts.cwd to run inside a project folder so its .mcp.json servers
    // (Playwright, …) load — required when the prompt needs to open the real app.
    const child = spawn(CLAUDE_BIN, args, {
      env: spawnEnv(),
      cwd: opts?.cwd,
      stdio: [opts?.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true, // no cmd window flash on Windows
    })
    writeStdin(child, opts?.input)
    const idleMs = opts?.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 0
    function onTimeout(): void {
      if (settled) return
      settled = true
      clearTimers()
      opts?.signal?.removeEventListener('abort', onAbort)
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ text: resultText, isError, code: null, timedOut: true, aborted: false })
    }
    // With an idle timeout, `timer` is the silence clock (reset by touch() on every byte)
    // and `hardTimer` is the absolute ceiling. Without one, `timer` alone is the old fixed
    // deadline and hardTimer never exists.
    let timer = setTimeout(onTimeout, idleMs || timeoutMs)
    const hardTimer = idleMs ? setTimeout(onTimeout, timeoutMs) : null
    function clearTimers(): void {
      clearTimeout(timer)
      if (hardTimer) clearTimeout(hardTimer)
    }
    /** The child said something — it isn't hung. Restart the silence clock. */
    function touch(): void {
      if (!idleMs || settled) return
      clearTimeout(timer)
      timer = setTimeout(onTimeout, idleMs)
    }

    // Kill the child as soon as the caller cancels (pause/cancel of a job).
    function onAbort(): void {
      if (settled) return
      settled = true
      clearTimers()
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ text: resultText, isError: true, code: null, timedOut: false, aborted: true })
    }
    if (opts?.signal) {
      if (opts.signal.aborted) queueMicrotask(onAbort)
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      touch()
      stdoutBuf += chunk
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line) handleLine(line)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      touch()
      const text = String(chunk).trim()
      if (text) onLog({ level: 'error', text: text.slice(0, 300) })
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimers()
      opts?.signal?.removeEventListener('abort', onAbort)
      onLog({ level: 'error', text: err.message })
      resolve({ text: resultText, isError: true, code: null, timedOut: false, aborted: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimers()
      opts?.signal?.removeEventListener('abort', onAbort)
      if (stdoutBuf.trim()) handleLine(stdoutBuf.trim())
      if (opts?.usageSource && usage) {
        recordUsage({ source: opts.usageSource, model: opts.model, ...usage })
      }
      resolve({
        text: resultText,
        isError: isError || (code !== 0 && !resultText),
        code,
        timedOut: false,
        aborted: false,
      })
    })

    function handleLine(line: string): void {
      let msg: {
        type?: string
        subtype?: string
        model?: string
        session_id?: string
        result?: string
        is_error?: boolean
        message?: { content?: { type?: string; text?: string; name?: string; input?: unknown }[] }
        event?: {
          type?: string
          delta?: { type?: string; text?: string }
          content_block?: { type?: string }
        }
      }
      try {
        msg = JSON.parse(line)
      } catch {
        return // ignore non-JSON noise
      }
      switch (msg.type) {
        case 'stream_event': {
          // Partial streaming (--include-partial-messages): forward text deltas live.
          const ev = msg.event
          if (ev?.type === 'content_block_start' && ev.content_block?.type === 'text') {
            // A turn that stops to run a tool resumes in a NEW text block, and the deltas
            // carry no separator — so "…listing the folders.Now I'll read package.json"
            // is what the reader gets. Paragraph-break each block after the first.
            if (sawText) opts?.onDelta?.('\n\n')
            return
          }
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            sawText = true
            opts?.onDelta?.(ev.delta.text)
          }
          return
        }
        case 'system':
          if (msg.subtype === 'init') {
            if (msg.session_id) opts?.onSession?.(msg.session_id)
            if (msg.model) opts?.onModel?.(msg.model)
            onLog({ level: 'info', text: `Claude session started — model ${msg.model ?? 'default'}` })
          }
          return
        case 'assistant': {
          for (const block of msg.message?.content ?? []) {
            if (block.type === 'text' && block.text?.trim()) {
              if (!opts?.suppressAssistantText) {
                for (const l of block.text.trim().split('\n')) onLog({ level: 'info', text: l })
              }
            } else if (block.type === 'tool_use' && block.name) {
              onLog({
                level: 'info',
                text: `⚙ ${block.name}`,
                tool: { name: block.name, detail: toolDetail(block.name, block.input) },
              })
            }
          }
          return
        }
        case 'result':
          resultText = (msg.result ?? '').trim()
          isError = !!msg.is_error
          usage = usageFromResultObject(msg)
          return
        default:
          return
      }
    }
  })
}

/**
 * Pull the `result` text out of `claude -p --output-format json` output.
 *
 * The CLI has TWO shapes for this format and both are still in the wild:
 *  - a single result object `{type:'result', result:'…', is_error:false}` (older), and
 *  - the whole message array `[{type:'system'…}, {type:'assistant'…}, {type:'result'…}]`
 *    (current CLI), where the answer is the LAST `type:'result'` entry.
 * Reading `.result` off the array yields `undefined`, which every caller reports as
 * "the AI produced nothing" — so handle both rather than assuming one.
 */
export function parseClaudeJsonResult(raw: string): { text: string; isError: boolean } {
  interface ResultMsg {
    type?: string
    result?: string
    is_error?: boolean
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    /* non-json CLI error */
    return { text: '', isError: false }
  }
  let msg: ResultMsg = {}
  if (Array.isArray(parsed)) {
    // Last result message wins; fall back to any entry carrying a `result` string.
    const msgs = parsed as ResultMsg[]
    msg =
      [...msgs].reverse().find((m) => m?.type === 'result') ??
      [...msgs].reverse().find((m) => typeof m?.result === 'string') ??
      {}
  } else if (parsed && typeof parsed === 'object') {
    msg = parsed as ResultMsg
  }
  return { text: (msg.result ?? '').trim(), isError: !!msg.is_error }
}

/** Claude model aliases the portal exposes for crawl summaries. */
export const CRAWL_SUMMARY_MODELS = new Set(['haiku', 'sonnet', 'opus'])
