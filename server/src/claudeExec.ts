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
  },
): Promise<StreamResult> {
  return new Promise((resolve) => {
    let settled = false
    let resultText = ''
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
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      opts?.signal?.removeEventListener('abort', onAbort)
      try {
        child.kill()
      } catch {
        /* already closed */
      }
      resolve({ text: resultText, isError, code: null, timedOut: true, aborted: false })
    }, timeoutMs)

    // Kill the child as soon as the caller cancels (pause/cancel of a job).
    function onAbort(): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
      const text = String(chunk).trim()
      if (text) onLog({ level: 'error', text: text.slice(0, 300) })
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts?.signal?.removeEventListener('abort', onAbort)
      onLog({ level: 'error', text: err.message })
      resolve({ text: resultText, isError: true, code: null, timedOut: false, aborted: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
        result?: string
        is_error?: boolean
        message?: { content?: { type?: string; text?: string; name?: string }[] }
        event?: { type?: string; delta?: { type?: string; text?: string } }
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
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            opts?.onDelta?.(ev.delta.text)
          }
          return
        }
        case 'system':
          if (msg.subtype === 'init') {
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
              onLog({ level: 'info', text: `⚙ ${block.name}` })
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

/** Pull the `result` text out of `claude -p --output-format json` output. */
export function parseClaudeJsonResult(raw: string): { text: string; isError: boolean } {
  let parsed: { result?: string; is_error?: boolean } = {}
  try {
    parsed = JSON.parse(raw.trim()) as typeof parsed
  } catch {
    /* non-json CLI error */
  }
  return { text: (parsed.result ?? '').trim(), isError: !!parsed.is_error }
}

/** Claude model aliases the portal exposes for crawl summaries. */
export const CRAWL_SUMMARY_MODELS = new Set(['haiku', 'sonnet', 'opus'])
