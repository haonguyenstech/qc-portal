import { parseClaudeJsonResult, runClaude } from './claudeExec.js'

export interface McpCapabilityResult {
  ok: boolean
  detail: string
  data: Record<string, unknown> | null
  raw: string
}

/** Which known servers have a functional test, and whether they need user input. */
export const CAPABILITY_TESTS: Record<
  string,
  { needsInput: boolean; inputLabel: string; inputPlaceholder: string; action: string }
> = {
  clickup: {
    needsInput: true,
    inputLabel: 'Ticket ID',
    inputPlaceholder: 'e.g. 86eqk2hfk',
    action: 'Fetch ticket',
  },
  figma: {
    needsInput: true,
    inputLabel: 'Figma design link',
    inputPlaceholder: 'https://www.figma.com/design/…',
    action: 'Read design',
  },
  playwright: {
    needsInput: false,
    inputLabel: '',
    inputPlaceholder: '',
    action: 'Open Google & close',
  },
}

function statusError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

/** Build the per-server prompt that exercises the MCP and returns strict JSON. */
function capabilityPrompt(name: string, input: string): string | null {
  switch (name) {
    case 'clickup':
      return `Using the ClickUp MCP tools available to you, fetch the task with id "${input}".
Reply with ONLY a JSON object and nothing else:
- on success: {"ok": true, "name": "<task name>", "status": "<task status>"}
- on failure: {"ok": false, "error": "<short reason>"}
No prose, no markdown, no code fence.`
    case 'figma':
      // Call the Figma MCP tool ONCE and report what it returns. Figma designs are
      // often huge, so the tool result frequently exceeds the response size limit and
      // comes back wrapped as "Error: result … exceeds maximum allowed tokens. Output
      // saved to <file>". That is NOT an auth/access failure — the fetch SUCCEEDED.
      // Spell that out so a small model doesn't misread the size error as a failure.
      return `Call the Figma MCP tool ONCE to fetch the design at this link: ${input}
Use ONLY the Figma MCP tool — do not use Bash or any other tool.
IMPORTANT: If the tool returns design data of ANY size — even if the response is very
large, gets truncated, or is saved to a file because it exceeded a size limit — that
means it WORKED. A size/length limit is success, NOT an authentication or access error.
Reply with ONLY a JSON object and nothing else:
- if the tool returned any design data (including an over-size/saved-to-file result): {"ok": true, "summary": "<the file or frame name>"}
- only if the tool itself failed (authentication, permission, or file-not-found): {"ok": false, "error": "<short reason>"}
No prose, no markdown, no code fence.`
    case 'playwright':
      return `Using the Playwright MCP browser tools, do exactly this: open a browser to https://www.google.com , read the page <title>, then CLOSE the browser.
Reply with ONLY a JSON object and nothing else:
- on success: {"ok": true, "title": "<the page title you read>"}
- on failure: {"ok": false, "error": "<short reason>"}
No prose, no markdown, no code fence.`
    default:
      return null
  }
}

/** Strip a stray code fence and isolate the outermost JSON object. */
function extractJson(text: string): Record<string, unknown> | null {
  let body = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(body)
  if (fence) body = fence[1].trim()
  if (!body.startsWith('{')) {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end <= start) return null
    body = body.slice(start, end + 1)
  }
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Functionally test one MCP server by having Claude actually use it (in the
 * project folder so the project's .mcp.json servers load). Returns a friendly
 * detail line plus the parsed data. Playwright/Figma can be slow, hence 180s.
 */
export async function runMcpCapabilityTest(opts: {
  rootPath: string
  name: string
  input?: string
}): Promise<McpCapabilityResult> {
  const spec = CAPABILITY_TESTS[opts.name]
  if (!spec) {
    throw statusError(`No functional test for "${opts.name}" — use Test connection instead.`, 400)
  }
  const input = (opts.input ?? '').trim()
  if (spec.needsInput && !input) {
    throw statusError(`${spec.inputLabel} is required.`, 400)
  }
  const prompt = capabilityPrompt(opts.name, input)
  if (!prompt) throw statusError(`No functional test for "${opts.name}".`, 400)

  const result = await runClaude(
    [
      '-p',
      '--model',
      'haiku',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--max-budget-usd',
      '0.40',
    ],
    180_000,
    { cwd: opts.rootPath, usageSource: 'mcp-test', model: 'haiku', input: prompt },
  )

  if (result.timedOut) {
    return { ok: false, detail: 'Timed out exercising the MCP server.', data: null, raw: '' }
  }
  const { text } = parseClaudeJsonResult(result.stdout || result.stderr)
  const data = extractJson(text)
  if (!data) {
    return {
      ok: false,
      detail: text ? `Unexpected reply: ${text.slice(0, 200)}` : 'No reply from the model.',
      data: null,
      raw: text,
    }
  }
  const ok = data.ok === true
  let detail: string
  if (!ok) {
    detail = `Failed: ${String(data.error ?? 'the MCP could not complete the action')}`
  } else if (opts.name === 'clickup') {
    detail = `Read ticket: ${String(data.name ?? '(no name)')} · status ${String(data.status ?? '?')}`
  } else if (opts.name === 'figma') {
    detail = `Read design: ${String(data.summary ?? '(no summary)')}`
  } else if (opts.name === 'playwright') {
    detail = `Opened & closed browser · page title: ${String(data.title ?? '(none)')}`
  } else {
    detail = 'MCP responded.'
  }
  return { ok, detail, data, raw: text }
}
