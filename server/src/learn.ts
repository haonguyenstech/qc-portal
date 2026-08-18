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
/**
 * A 👍/👎 on ONE chat answer is a much narrower signal than a whole finished run, so it
 * gets a much smaller allowance: two notes at most, and memory only. A vote that could
 * write six items (or a long knowledge doc) would turn a single click into a page of new
 * project context nobody asked for — and clutter is the one failure mode that makes people
 * stop reading memory at all.
 */
const MAX_FEEDBACK_ITEMS = 2
/** Question + answer the vote was about, capped — the tail of a long answer is dropped. */
const MAX_FEEDBACK_CHARS = 6_000

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
function parseItems(text: string, max = MAX_ITEMS): LearnItem[] {
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
    if (out.length >= max) break
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

  const items = await askForItems({
    rootPath: opts.rootPath,
    model,
    usageSource: 'knowledge-update',
    prompt: buildPrompt(opts.projectName, context, existingMemory, existingKnowledge),
  })
  if ('skipped' in items) return { memory: [], knowledge: [], skipped: items.skipped }
  if (items.items.length === 0) return { memory: [], knowledge: [], skipped: 'nothing worth remembering' }
  return applyItems(opts.rootPath, opts.source, items.items)
}

/**
 * Ask the cheap model for a JSON `items[]` list, or say why there isn't one.
 *
 * Shared by every capture path so they cannot drift on the parts that are easy to get
 * wrong: the prompt goes over **stdin** (reflection context is large, and a command line
 * that long is an ENAMETOOLONG on Windows), the run is budget-capped and session-less, and
 * a timeout / non-zero exit / empty result is reported as a REASON rather than as an empty
 * capture — "nothing worth remembering" and "the model never answered" are different facts.
 */
async function askForItems(opts: {
  rootPath: string
  model: string
  prompt: string
  usageSource: string
  maxItems?: number
}): Promise<{ items: LearnItem[] } | { skipped: string }> {
  const result = await runClaude(
    [
      '-p',
      '--model',
      opts.model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      '0.30',
    ],
    120_000,
    {
      cwd: opts.rootPath,
      usageSource: opts.usageSource,
      model: opts.model,
      input: opts.prompt,
    },
  )
  if (result.timedOut) return { skipped: 'timed out' }
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (result.code !== 0 || isError || !text) return { skipped: 'no AI response' }
  return { items: parseItems(text, opts.maxItems ?? MAX_ITEMS) }
}

/** Write the captured items to memory / knowledge and refresh the CLAUDE.md pointer once. */
function applyItems(rootPath: string, source: string, items: LearnItem[]): LearnResult {
  const memory: string[] = []
  const knowledge: string[] = []
  for (const it of items) {
    if (it.target === 'knowledge') {
      const w = writeDoc({ rootPath, name: it.name, content: it.body, source })
      if (w) knowledge.push(w.name)
    } else {
      const w = writeNote({
        rootPath,
        name: it.name,
        description: it.description,
        body: it.body,
        source,
      })
      if (w) memory.push(w.name)
    }
  }
  if (memory.length || knowledge.length) syncContextPointer(rootPath)
  return { memory, knowledge }
}

/**
 * WHAT A 👍 / 👎 ON ONE CHAT ANSWER TEACHES THE PROJECT.
 *
 * The vote itself is worthless as memory ("the engineer liked answer #7"): what is worth
 * keeping is the thing the vote *implies* — the fact a good answer established, or the
 * correction a bad one needs — because that is what changes the NEXT answer. Chat already
 * reads `testing/memory` on every turn (via the CLAUDE.md pointer block), so a note written
 * here is in scope for every later question without anyone wiring anything up. That is the
 * whole mechanism: rate an answer, and the project gets better at answering.
 *
 * Deliberately narrower than `runKnowledgeUpdate`: memory only (a vote is a small fact, not
 * a reference document) and `MAX_FEEDBACK_ITEMS` at a time. Deliberately NOT gated on the
 * project's auto-learn toggle either — that setting governs capture that happens on its own
 * after a run, and this one only ever happens because somebody pressed a button.
 *
 * Never throws; a failure comes back as `skipped` so the button can say so.
 */
export async function runFeedbackCapture(opts: {
  rootPath: string
  projectName: string
  source: string
  vote: 'up' | 'down'
  /** What the engineer typed with a 👎, if anything. */
  note?: string
  question: string
  answer: string
  model?: string
}): Promise<{ memory: string[]; skipped?: string }> {
  const question = (opts.question ?? '').trim().slice(0, MAX_FEEDBACK_CHARS)
  const answer = (opts.answer ?? '').trim().slice(0, MAX_FEEDBACK_CHARS)
  if (!answer) return { memory: [], skipped: 'nothing to reflect on' }

  const model = opts.model?.trim() || AUTO_LEARN_MODEL
  const existing = listNotes(opts.rootPath).map((n) => ({ name: n.name, description: n.description }))
  const memList = existing.length
    ? existing.map((m) => `- ${m.name}: ${m.description || '(no description)'}`).join('\n')
    : '(none yet)'
  const rating =
    opts.vote === 'up'
      ? 'THUMBS UP — this answer was good and they want more answers like it.'
      : 'THUMBS DOWN — this answer was wrong, incomplete or unhelpful.'
  const said = opts.note?.trim() ? `They also said: "${opts.note.trim()}"` : 'They left no comment.'

  const prompt = `You are the memory keeper for the QC project "${opts.projectName}". A QC engineer just rated ONE answer from this project's chat assistant. You decide what — if anything — the project should REMEMBER so future answers are better.

The question they asked:
--- QUESTION START ---
${question || '(not recorded)'}
--- QUESTION END ---

The answer they rated:
--- ANSWER START ---
${answer}
--- ANSWER END ---

Their rating: ${rating}
${said}

The project already remembers these MEMORY notes (name: description):
${memList}

Capture ONLY what will still be true and useful next week, for ANY future question — never a summary of this answer, never praise, never the rating.
- On a THUMBS UP: the durable FACT the answer established about this project or system (e.g. "staging login needs an OTP from the mail catcher"), or — only when it is a real reusable preference — the answer HABIT worth repeating ("answers should name the file and line").
- On a THUMBS DOWN: the CORRECTION that stops the same mistake next time, written as the truth to follow ("the orders API is v2; v1 was removed"), not as commentary about a bad answer.

Do NOT capture: the vote itself, a restatement of the question, this conversation's one-off details, or anything already covered by the notes above. NEVER copy a credential, token, OTP, cookie or personal data into a note, even if one appears above. If the rating carries nothing durable — a vote on wording, or "thanks, correct" with no new fact — output {"items":[]}. That is a normal, common and acceptable outcome.

Use mode "update" with the EXISTING name when it refines a note listed above (your body REPLACES the old one, so restate the whole fact). Otherwise mode "create" with a new short kebab-case name.

Output ONLY a JSON object, no prose, no code fence:
{"items":[{"mode":"create","name":"orders-api-is-v2","description":"one line","body":"the fact in markdown"}]}
Rules: at most ${MAX_FEEDBACK_ITEMS} items; description ≤ 1 line; be specific and executable; never placeholders like "TBD".`

  let asked: Awaited<ReturnType<typeof askForItems>>
  try {
    asked = await askForItems({
      rootPath: opts.rootPath,
      model,
      prompt,
      usageSource: 'chat-feedback',
      maxItems: MAX_FEEDBACK_ITEMS,
    })
  } catch {
    return { memory: [], skipped: 'no AI response' }
  }
  if ('skipped' in asked) return { memory: [], skipped: asked.skipped }
  // Memory only, whatever the model asked for: a vote on one answer is a small fact, and a
  // knowledge document written from a thumbs-up is a page nobody agreed to.
  const items = asked.items.map((it) => ({ ...it, target: 'memory' as const }))
  if (!items.length) return { memory: [], skipped: 'nothing worth remembering' }
  const applied = applyItems(opts.rootPath, opts.source, items)
  return { memory: applied.memory }
}
