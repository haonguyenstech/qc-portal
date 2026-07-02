import spawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import { CLAUDE_BIN } from './config.js'
import { usageFromResultObject } from './claudeExec.js'
import { recordUsage } from './db.js'
import type { LogEvent, Phase } from './types.js'
import { spawnEnv } from './toolPath.js'

export interface RunHandle {
  child: ChildProcess
  cancel: () => void
}

interface RunCallbacks {
  onEvent: (e: LogEvent) => void
  onDone: (result: { success: boolean; resultText: string }) => void
  onError: (message: string) => void
  onSession?: (sessionId: string) => void
}

const PHASE_ORDER: Phase[] = [
  'intake',
  'plan',
  'setup',
  'collect',
  'analyze',
  'aggregate',
  'report',
]

/**
 * Map a free-text line to a QC phase (best-effort progress hint).
 *
 * Explicit "Phase N" headers from the skill are the reliable signal, so we
 * trust those first. The fallbacks are deliberately narrow, phase-unique
 * phrases — common words like "setup", "collect", "screenshot" or "report.md"
 * appear throughout a run and would make the progress bar jump around.
 */
function detectPhase(text: string): Phase | undefined {
  const t = text.toLowerCase()
  const m = /phase\s*([1-7])\b/.exec(t)
  if (m) return PHASE_ORDER[Number(m[1]) - 1]

  if (/scenario matrix|capture plan/.test(t)) return 'plan'
  if (/content inventory/.test(t)) return 'collect'
  if (/writing\s+report\.md|generating\s+the\s+report|finali[sz]ing\s+(the\s+)?report/.test(t)) {
    return 'report'
  }
  return undefined
}

function now() {
  return new Date().toISOString()
}

/**
 * Launch the qc-testing skill head-less and stream normalized events.
 *
 * Uses `--output-format stream-json` so we get newline-delimited JSON we can
 * map to log/tool/phase events. Permissions are bypassed so the run never
 * blocks on a prompt — safe because the skill itself forbids mutating actions
 * and this runs on the QC's own machine against a dev environment.
 */
export function runQc(
  opts: {
    ticketId: string
    appUrl: string
    cwd?: string
    skill?: string
    instructions?: string
    model?: string // Claude model alias (haiku/sonnet/opus); omitted = configured default
    relatedTickets?: string[] // advanced mode: extra tickets covered by the same feature run
    workflowSteps?: string[] // advanced mode: ordered end-to-end flow to exercise
    testTarget?: 'web' | 'web-mobile' | 'app-mobile' // desktop browser (default), web app on device, or native app on device
    resumeSessionId?: string // continue a previously paused session instead of starting fresh
  },
  cb: RunCallbacks,
): RunHandle {
  const skill = opts.skill?.trim() || 'qc-testing'
  const isQc = skill === 'qc-testing'
  const resuming = !!opts.resumeSessionId

  let prompt: string
  if (resuming) {
    // The session already holds the full original prompt and progress — just
    // tell it to pick up where it stopped.
    prompt =
      `Continue the QC acceptance test for ClickUp ticket ${opts.ticketId} exactly where you left off. ` +
      `Resume the ${skill} skill from the phase you had reached and carry it through to the end. ` +
      `Do not restart from scratch and do not repeat work already completed.`
  } else {
    // All tickets covered by this run — the lead ticket plus any related ones
    // selected in advanced mode. More than one means it's a connected feature.
    const allTickets = [opts.ticketId, ...(opts.relatedTickets ?? [])]
      .map((t) => t.trim())
      .filter(Boolean)
    const multiTicket = allTickets.length > 1
    const steps = (opts.workflowSteps ?? []).map((s) => s.trim()).filter(Boolean)

    const lines = [
      multiTicket
        ? `Use the ${skill} skill to run a deep QC acceptance test across a connected feature that spans multiple ClickUp tickets.`
        : `Use the ${skill} skill to run a deep QC acceptance test.`,
    ]
    if (multiTicket) {
      lines.push(
        `ClickUp tickets — treat them together as ONE end-to-end feature, not as separate tests: ${allTickets.join(', ')}`,
        `Lead ticket (write the report under its slug): ${opts.ticketId}`,
      )
    } else {
      lines.push(`ClickUp ticket: ${opts.ticketId}`)
    }
    if (opts.testTarget === 'app-mobile') {
      lines.push(
        ``,
        `TEST TARGET: a NATIVE APP already installed on a MOBILE device — there is no URL. ` +
          `Do NOT use the desktop/Playwright browser. Use the Mobile MCP tools: list the available ` +
          `devices and drive a booted simulator/device (if none is booted, stop and report that as a ` +
          `blocker). The app under test must already be INSTALLED on the device — launch it; if it is ` +
          `not installed, stop and report that as a blocker rather than trying to install it. Perform ` +
          `ALL interaction and verification on the device, capturing mobile screenshots as evidence.`,
      )
    } else {
      lines.push(`App URL: ${opts.appUrl}`)
      if (opts.testTarget === 'web-mobile') {
        lines.push(
          ``,
          `TEST TARGET: the web app above, opened on a MOBILE device — do NOT use the desktop/Playwright ` +
            `browser. Use the Mobile MCP tools: list the available devices and drive a booted ` +
            `simulator/device (if none is booted, stop and report that as a blocker). Open the App URL ` +
            `in the device's mobile browser and perform ALL interaction and verification on that device, ` +
            `capturing mobile screenshots as evidence. Test the responsive/mobile experience.`,
        )
      }
    }

    if (steps.length) {
      lines.push(
        ``,
        `Feature workflow — exercise these steps in order as the primary acceptance path, ` +
          `verifying each step works before moving to the next:`,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
      )
    }

    if (isQc) {
      lines.push(
        ``,
        `Before testing, read this project's standing context if present and apply it ` +
          `throughout the run (real screen/field names, roles, business rules, known gotchas): ` +
          `durable facts in testing/memory/*.md (indexed by testing/memory/MEMORY.md) and ` +
          `reference docs in testing/knowledge/*.md.`,
        ``,
        `Also read the SOURCE CODE for the feature under test in this repository. Start from any ` +
          `testing/knowledge/source-map-*.md doc — it indexes each connected repo's screens/routes, ` +
          `models, and validation with file paths, so open the files it names directly instead of ` +
          `exploring. Only search the codebase (Grep/Glob/Read) for what the map doesn't cover — ` +
          `the screens, components, routes/endpoints, fields, and messages named in the ticket — ` +
          `to understand the real implementation, expected behavior, validation, and edge cases ` +
          `before you exercise the app. Read only; never modify the code.`,
        ``,
        `Follow the skill literally and in order through all 7 phases. ` +
          `Write the report and issues into testing/test-result/<ticket-slug>/ as the skill specifies.`,
      )
    } else {
      lines.push(`Follow the skill literally and in order.`)
    }
    lines.push(`Do not commit any mutating action on the shared environment.`)

    const notes = opts.instructions?.trim()
    if (notes) {
      lines.push(
        ``,
        `Extra instructions from the QC engineer — treat these as high priority:`,
        notes,
      )
    }
    prompt = lines.join('\n')
  }

  // The prompt goes over stdin, NOT as an argv positional. On Windows `claude` is a
  // `claude.cmd` batch shim, and cmd.exe truncates a multi-line argument at the first
  // newline — so a positional prompt would arrive as only its first line (the ticket
  // ID, App URL, and instructions silently dropped, leaving the model stuck in intake).
  // stdin also sidesteps the OS command-line length cap. `claude -p` reads the prompt
  // from stdin when no positional is given.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ]
  // Pin the model only for fresh runs — a resumed session already carries the
  // model it was started with, and re-passing --model could override it.
  if (!resuming && opts.model?.trim()) {
    args.push('--model', opts.model.trim())
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId)
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: spawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so we can signal the *whole* tree (claude + its MCP
    // servers + the Playwright browser) at once, instead of just the lead
    // process — otherwise killing claude leaves the browser orphaned. POSIX
    // only: on Windows `detached` opens a console window and the group-kill via
    // process.kill(-pid) doesn't apply (killTree falls back to child.kill).
    detached: process.platform !== 'win32',
    // Never flash a cmd window when launching claude(.cmd) on Windows.
    windowsHide: true,
  })
  // Deliver the prompt, then close stdin so the CLI sees EOF and starts immediately.
  if (child.stdin) {
    child.stdin.on('error', () => {}) // a broken pipe (child died early) must not crash us
    child.stdin.end(prompt)
  }

  cb.onEvent({ ts: now(), kind: 'system', text: `Started QC run for ${opts.ticketId}` })

  let stdoutBuf = ''
  let lastResult = ''

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      handleLine(line)
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    const text = String(chunk).trim()
    if (text) cb.onEvent({ ts: now(), kind: 'error', text })
  })

  child.on('error', (err) => cb.onError(err.message))

  let exited = false
  child.on('close', () => {
    exited = true
  })

  child.on('close', (code) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim())
    const success = code === 0
    cb.onEvent({
      ts: now(),
      kind: 'done',
      text: success ? 'QC run finished' : `QC run exited with code ${code}`,
    })
    cb.onDone({ success, resultText: lastResult })
  })

  function emitText(text: string) {
    const phase = detectPhase(text)
    if (phase) cb.onEvent({ ts: now(), kind: 'phase', phase, text: `Phase: ${phase}` })
    cb.onEvent({ ts: now(), kind: 'text', phase, text })
  }

  function handleLine(line: string) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Not JSON — surface as raw text so nothing is lost.
      cb.onEvent({ ts: now(), kind: 'text', text: line })
      return
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id) cb.onSession?.(String(msg.session_id))
          cb.onEvent({
            ts: now(),
            kind: 'system',
            text: `Session ${msg.session_id ?? ''} — model ${msg.model ?? 'default'}`,
          })
        }
        return

      case 'assistant': {
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            emitText(block.text.trim())
          } else if (block.type === 'tool_use') {
            const summary = summarizeTool(block.name, block.input)
            cb.onEvent({ ts: now(), kind: 'tool', tool: block.name, text: summary })
          }
        }
        return
      }

      case 'user': {
        // tool results coming back — keep them short
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_result') {
            const txt = extractToolResultText(block.content)
            if (txt) cb.onEvent({ ts: now(), kind: 'tool_result', text: truncate(txt, 240) })
          }
        }
        return
      }

      case 'result': {
        lastResult = msg.result ?? msg.subtype ?? ''
        const usage = usageFromResultObject(msg)
        if (usage) recordUsage({ source: 'qc-run', model: msg.model ?? null, ...usage })
        return
      }

      default:
        return
    }
  }

  return {
    child,
    cancel: () => {
      killTree(child, 'SIGTERM')
      // Escalate to SIGKILL if claude (and its browser) don't tear down in time.
      setTimeout(() => {
        if (!exited) killTree(child, 'SIGKILL')
      }, 4000).unref()
    },
  }
}

/**
 * Signal a child *and all its descendants*. The child was spawned `detached`,
 * so it leads its own process group — `process.kill(-pid, …)` reaches the group
 * (claude + MCP servers + Playwright/Edge). Falls back to the lone process if
 * the group send fails (e.g. it already exited).
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function summarizeTool(name: string, input: any): string {
  if (!input) return name
  switch (name) {
    case 'Bash':
      return `$ ${truncate(String(input.command ?? ''), 120)}`
    case 'Read':
      return `Read ${input.file_path ?? ''}`
    case 'Write':
      return `Write ${input.file_path ?? ''}`
    case 'Edit':
      return `Edit ${input.file_path ?? ''}`
    case 'Task':
    case 'Agent':
      return `Subagent: ${truncate(String(input.description ?? input.prompt ?? ''), 80)}`
    default:
      if (name.startsWith('browser_')) {
        const detail = input.url || input.selector || input.element || input.ref || ''
        return `${name} ${truncate(String(detail), 80)}`
      }
      if (name.startsWith('clickup')) return `${name} ${input.taskId ?? input.id ?? ''}`
      return `${name} ${truncate(JSON.stringify(input), 80)}`
  }
}

function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
