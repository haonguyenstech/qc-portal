import { runChatCapture } from './learn.js'

/**
 * AUTO-CAPTURE FROM /chat — a background reflection on a conversation that has gone QUIET.
 *
 * A QC run and a test-case job already teach the project what they learned
 * (`learn.ts` `runKnowledgeUpdate`), and a 👍/👎 teaches it what one answer settled
 * (`runFeedbackCapture`). Ordinary chat taught it nothing: the engineer asks "which
 * environment is staging?", gets a correct answer, and next week asks again.
 *
 * Three rules shape this module, and each one exists because the obvious version is worse:
 *
 * 1. **It never runs on the turn's own path.** The capture is a whole extra model call —
 *    a minute of Haiku. Awaiting it before `done` would hold the composer, the streamed
 *    answer and the queue behind a job the reader did not ask for. So the turn calls
 *    `noteChatTurn` and returns; nothing on the request path ever waits for this.
 *
 * 2. **One capture per QUIET conversation, not one per message.** A chat is a
 *    back-and-forth: reflecting after every turn would spend a model call per message,
 *    reflect on half-finished thoughts ("do that for staging too"), and write a note for
 *    each half of an exchange whose conclusion only arrives at the end. So each turn
 *    RESETS a `QUIET_MS` timer and the capture reads the whole exchange at once. A
 *    conversation that is still being typed into simply keeps pushing its own capture
 *    forward — which is the correct behaviour, not a delay to work around.
 *
 * 3. **One capture at a time, process-wide.** Two conversations going quiet together
 *    would otherwise spawn two `claude` processes beside whatever the engineer is running,
 *    and both would read the SAME memory folder to decide what already exists — so the
 *    second would happily create a note the first was in the middle of writing. The chain
 *    below serialises them; a few seconds later is fine for something nobody is waiting on.
 *
 * Everything here is best-effort and silent: a failure leaves the project exactly as it
 * was, which is the same outcome as "nothing worth remembering" and needs no UI.
 */

/** How long a conversation must go untouched before it is reflected on. */
const QUIET_MS = 90_000

/**
 * How many exchanges one capture reads. The tail, not the head: a conversation drifts, and
 * what it CONCLUDED is at the end. Older turns were already covered by an earlier capture
 * anyway — a long session goes quiet more than once.
 */
const MAX_TURNS = 6

/**
 * A backstop, not a policy. Each pending entry is a few KB of text held until its timer
 * fires, so the cap only matters if something upstream stops calling `forget` — the
 * oldest is dropped rather than left to grow for the life of the process.
 */
const MAX_PENDING = 24

/**
 * The transcript budget, enforced here rather than left to `runChatCapture`'s own cap:
 * this side knows where the turn boundaries are, so it can drop whole OLD exchanges
 * instead of truncating the newest answer mid-sentence.
 */
const MAX_TRANSCRIPT_CHARS = 12_000

/** An answer shorter than this settled nothing worth a model call ("Yes.", "Done."). */
const MIN_ANSWER_CHARS = 200

interface Exchange {
  question: string
  answer: string
}

interface Pending {
  rootPath: string
  projectName: string
  slug: string
  model?: string
  turns: Exchange[]
  timer: NodeJS.Timeout
}

const pending = new Map<string, Pending>()

/** Serialises every capture, process-wide — see rule 3. */
let chain: Promise<unknown> = Promise.resolve()

const keyFor = (rootPath: string, slug: string) => `${rootPath}::${slug}`

/**
 * Record an answered turn and (re)arm this conversation's capture.
 *
 * Call it AFTER the answer has been sent — it returns immediately and schedules the rest.
 * The caller decides whether capture is wanted at all (the project's auto-learn toggle);
 * this module only decides whether there is anything worth reflecting on.
 */
export function noteChatTurn(opts: {
  rootPath: string
  projectName: string
  slug: string
  model?: string
  question: string
  answer: string
}): void {
  const question = (opts.question ?? '').trim()
  const answer = (opts.answer ?? '').trim()
  // A trivial answer on its own is not worth a model call — but it is worth KEEPING when
  // the conversation already has something in it, because "yes, staging" is often the
  // line that settles the exchange before it.
  const key = keyFor(opts.rootPath, opts.slug)
  const existing = pending.get(key)
  if (!answer || (answer.length < MIN_ANSWER_CHARS && !existing)) return

  const turns = [...(existing?.turns ?? []), { question, answer }].slice(-MAX_TURNS)
  if (existing) clearTimeout(existing.timer)
  else if (pending.size >= MAX_PENDING) {
    // Fire the oldest now rather than dropping what it learned — its timer is cleared by
    // `flush`, and it was going to run in a minute or two anyway.
    const oldest = pending.keys().next().value
    if (oldest) flush(oldest)
  }

  // Re-inserted, not patched in place: `pending` is walked in insertion order when the
  // cap is hit, so a conversation that is still being typed into has to move to the back
  // of that queue — otherwise the busiest chat is the first one evicted.
  pending.delete(key)

  const timer = setTimeout(() => flush(key), QUIET_MS)
  // Node keeps the process alive for a pending timer; a reflection nobody is waiting on
  // must not be what stops the server from shutting down.
  timer.unref?.()
  pending.set(key, {
    rootPath: opts.rootPath,
    projectName: opts.projectName,
    slug: opts.slug,
    model: opts.model,
    turns,
    timer,
  })
}

/**
 * Drop a conversation's pending capture.
 *
 * Deleting a conversation has to take its unwritten memory with it: the whole point of
 * deleting is that it leaves nothing behind, and a note appearing on the Memory page a
 * minute later — sourced to a chat that no longer exists — is the opposite of that.
 */
export function forgetChatLearning(rootPath: string, slug: string): void {
  const key = keyFor(rootPath, slug)
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)
}

function flush(key: string): void {
  const entry = pending.get(key)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(key)

  // Trim from the FRONT to fit the budget. `runChatCapture` caps the string too, but a
  // blind `slice` there would cut the tail — and the tail is where the conversation
  // reached its conclusion, which is the only part worth remembering.
  const blocks = entry.turns.map(
    (t) => `Q: ${t.question || '(no text — an image or a file)'}\nA: ${t.answer}`,
  )
  while (blocks.length > 1 && blocks.join('\n\n').length > MAX_TRANSCRIPT_CHARS) blocks.shift()
  const transcript = blocks.join('\n\n')

  chain = chain
    .then(() =>
      runChatCapture({
        rootPath: entry.rootPath,
        projectName: entry.projectName,
        source: `chat · ${entry.slug} · ${new Date().toISOString().slice(0, 10)}`,
        transcript,
        model: entry.model,
      }),
    )
    .catch(() => {
      /* best-effort — a capture that fails leaves the project as it was */
    })
}
