import { AUTO_LEARN_MODEL } from './config.js'
import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import { syncContextPointer } from './contextPointer.js'
import { listNotes, writeNote } from './memoryStore.js'
import { listDocs, writeDoc } from './knowledgeStore.js'

// AI auto-capture: after a QC run or test-case generation finishes, reflect on what
// happened and persist durable facts the project should remember — small facts into
// testing/memory, longer reference write-ups into testing/knowledge. Best-effort and
// non-fatal: any failure resolves with an empty result and never throws (callers fire
// it and forget). Captured items are tagged with a `source` provenance so the UI can
// flag them and the engineer can review/edit/delete them.

const MAX_ITEMS = 6
const MAX_BODY_CHARS = 8_000
const MAX_DESC_CHARS = 200
const MAX_CONTEXT_CHARS = 24_000

export interface LearnResult {
  memory: string[] // names of memory notes written/updated
  knowledge: string[] // names of knowledge docs written/updated
  skipped?: string // reason nothing was captured (for logs), if any
}

interface LearnItem {
  target: 'memory' | 'knowledge'
  mode: 'create' | 'update'
  name: string
  description: string
  body: string
}

function buildPrompt(
  projectName: string,
  context: string,
  existingMemory: { name: string; description: string }[],
  existingKnowledge: string[],
): string {
  const memList = existingMemory.length
    ? existingMemory.map((m) => `- ${m.name}: ${m.description || '(no description)'}`).join('\n')
    : '(none yet)'
  const knowList = existingKnowledge.length ? existingKnowledge.map((k) => `- ${k}`).join('\n') : '(none yet)'
  return `You are the memory keeper for the QC project "${projectName}". An automated QC activity just finished. Your job is to capture ONLY durable, reusable facts that will help future QC work — and to avoid clutter.

What just happened:
--- CONTEXT START ---
${context}
--- CONTEXT END ---

The project already remembers these MEMORY notes (name: description):
${memList}

And these KNOWLEDGE docs (by name):
${knowList}

Decide what (if anything) is worth remembering for the FUTURE — not one-off run results. Good captures: how a feature really behaves (e.g. "login requires an OTP from email"), a stable gotcha, an environment/data convention, a recurring defect pattern, an integration quirk. Do NOT capture: this run's pass/fail counts, ticket-specific trivia, transient state, or anything already covered above.

For each fact, choose:
- target "memory" for a small, single fact (one idea) — most captures.
- target "knowledge" only for a longer reference write-up (e.g. a multi-step flow description).
- mode "update" + the EXIST­ING name when it refines something already listed above (your body REPLACES the old one, so restate the whole fact). Otherwise mode "create" with a new short kebab-case name.

Output ONLY a JSON object, no prose, no code fence:
{"items":[{"target":"memory","mode":"create","name":"login-uses-otp","description":"one line","body":"the fact in markdown"}]}
Rules: at most ${MAX_ITEMS} items; description ≤ 1 line; be specific and executable; never placeholders like "TBD". If nothing is worth remembering, output {"items":[]}.`
}

/** Extract the items[] array from the model's JSON result, tolerating minor noise. */
function parseItems(text: string): LearnItem[] {
  let raw = text.trim()
  // Strip a ```json fence if the model added one despite instructions.
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) raw = fence[1].trim()
  // Fall back to the outermost {...} if there's leading/trailing chatter.
  if (!raw.startsWith('{')) {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s !== -1 && e > s) raw = raw.slice(s, e + 1)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const items = (parsed as { items?: unknown })?.items
  if (!Array.isArray(items)) return []
  const out: LearnItem[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const target = o.target === 'knowledge' ? 'knowledge' : 'memory'
    const mode = o.mode === 'update' ? 'update' : 'create'
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    const description = typeof o.description === 'string' ? o.description.trim().slice(0, MAX_DESC_CHARS) : ''
    const body = typeof o.body === 'string' ? o.body.trim().slice(0, MAX_BODY_CHARS) : ''
    if (!name || !body) continue
    out.push({ target, mode, name, description, body })
    if (out.length >= MAX_ITEMS) break
  }
  return out
}

/**
 * Run the AI auto-capture step. `context` describes what just happened (report,
 * generated cases, …); `source` is a short provenance label stamped onto every
 * captured item (e.g. "ai · QC run PROJ-12 · 2026-06-29"). Never throws.
 */
export async function runKnowledgeUpdate(opts: {
  rootPath: string
  projectName: string
  source: string
  context: string
  model?: string
}): Promise<LearnResult> {
  const context = (opts.context ?? '').trim().slice(0, MAX_CONTEXT_CHARS)
  if (!context) return { memory: [], knowledge: [], skipped: 'no context' }

  const model = opts.model?.trim() || AUTO_LEARN_MODEL
  const existingMemory = listNotes(opts.rootPath).map((n) => ({ name: n.name, description: n.description }))
  const existingKnowledge = listDocs(opts.rootPath).map((d) => d.name)

  const result = await runClaude(
    [
      '-p',
      '--model',
      model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.30',
    ],
    120_000,
    // Reflection context can be large — deliver the prompt over stdin to avoid the
    // OS command-line length cap (Windows ENAMETOOLONG).
    {
      cwd: opts.rootPath,
      usageSource: 'knowledge-update',
      model,
      input: buildPrompt(opts.projectName, context, existingMemory, existingKnowledge),
    },
  )
  if (result.timedOut) return { memory: [], knowledge: [], skipped: 'timed out' }
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (result.code !== 0 || isError || !text) {
    return { memory: [], knowledge: [], skipped: 'no AI response' }
  }

  const items = parseItems(text)
  if (items.length === 0) return { memory: [], knowledge: [], skipped: 'nothing worth remembering' }

  const memory: string[] = []
  const knowledge: string[] = []
  for (const it of items) {
    if (it.target === 'knowledge') {
      const w = writeDoc({
        rootPath: opts.rootPath,
        name: it.name,
        content: it.body,
        source: opts.source,
      })
      if (w) knowledge.push(w.name)
    } else {
      const w = writeNote({
        rootPath: opts.rootPath,
        name: it.name,
        description: it.description,
        body: it.body,
        source: opts.source,
      })
      if (w) memory.push(w.name)
    }
  }

  if (memory.length || knowledge.length) syncContextPointer(opts.rootPath)
  return { memory, knowledge }
}
