import fs from 'node:fs'
import path from 'node:path'
import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import {
  knowledgeDir,
  knowledgeFile,
  safeDocName,
  writeDoc,
  type WriteDocResult,
} from './knowledgeStore.js'
import { readProjectContext } from './projectContext.js'

/**
 * Turn an uploaded IMAGE into a knowledge document — the Instructions → Knowledge tab
 * accepting the thing most projects actually document with: a logic/flow diagram, an
 * ERD, a state machine, an annotated screenshot, a whiteboard photo.
 *
 * Why it can't follow the other uploads' road: everything else on that tab is converted
 * to Markdown **in the browser** (`web/src/lib/docConvert.ts`) because the text is
 * already in the file. An image has no text to extract — the meaning is in the picture —
 * so this is the one upload that has to be read by a model, and the model has to SEE it.
 *
 * Two rules that shape the whole module:
 *
 * - **The image is KEPT, not consumed.** It is stored beside the docs in
 *   `testing/knowledge/assets/` and embedded at the top of the generated Markdown.
 *   A diagram flattened into prose loses the diagram: the engineer can no longer check
 *   the description against the picture, and a QC run can no longer open the picture
 *   itself. The relative `assets/<file>` link works for both — the portal serves it in
 *   the preview (`GET /api/knowledge/assets/:file`), and a run's cwd is the project root,
 *   so the model can `Read` it from the doc's own folder.
 * - **The description is written to be USED by a test run**, not to be admired: every
 *   label, node, arrow, branch, state, field and rule that is legible, and an explicit
 *   note about anything that is not. A confident summary of a diagram nobody can re-check
 *   is exactly the hallucination the grounding check exists to catch elsewhere.
 */

const MODEL = 'sonnet' // reading a diagram is a vision task — haiku is not the tool
const BUDGET_USD = '0.60'
const TIMEOUT_MS = 240_000

/** What the browser may send. Mirrors chat's IMAGE_EXT — the formats Read renders. */
export const KNOWLEDGE_IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** One image. Big enough for a full-page screenshot of a diagram tool. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * The model's refusal protocol. A blank or irrelevant image must not become a knowledge
 * doc: `projectContext.ts` packs this folder into every later prompt, so "the uploaded
 * file renders as a blank white image" would be read as a project FACT from then on.
 * Measured: without the sentinel the model politely wrote a 692-character document
 * explaining that there was nothing to document, and it was saved.
 */
const NOT_USABLE = 'NOT_USABLE:'

/** Backstop under the sentinel — a two-line answer is a refusal in some other wording. */
const MIN_DOC_CHARS = 200

/** A stored doc's raw Markdown, or '' when it doesn't exist yet. */
function readDocContent(root: string, name: string): string {
  const target = knowledgeFile(root, name)
  if (!target) return ''
  try {
    return fs.readFileSync(target, 'utf8')
  } catch {
    return ''
  }
}

export function knowledgeAssetDir(root: string): string {
  return path.join(knowledgeDir(root), 'assets')
}

/** `<slug>-<stamp>.<ext>`, generated HERE — the upload's own name never builds a path. */
function assetFileName(docName: string, ext: string): string {
  const slug =
    docName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'diagram'
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
  return `${slug}-${stamp}.${ext}`
}

function buildPrompt(opts: {
  absPath: string
  fileName: string
  projectName: string
  contextBlock: string
  instructions: string
}): string {
  return `You are documenting the software project "${opts.projectName}" for QC (acceptance testing) engineers.

A QC engineer uploaded an image — most often a logic/flow diagram, an ERD, a state machine, a sequence diagram, an architecture sketch, or an annotated screenshot of the product. Open it with the Read tool (Read renders images, so you can see it):

${opts.absPath}

${opts.contextBlock ? `${opts.contextBlock}\n\n` : ''}Write a Markdown reference document describing what that image shows, for an engineer who will TEST this product and cannot see the picture while working.

Cover, when the image shows them:
- What kind of diagram or screen this is, and what part of the product it covers.
- Every node / box / screen / state, by its EXACT label as written in the image.
- Every arrow, transition or connector: what goes from where to where, with the condition or event written on it.
- Decision points and their branches — including the negative / error / rejected path, which is what a tester needs most.
- Roles, actors, swimlanes, systems and any external service the image names.
- Data: entities, fields, types, keys, cardinality (1-N, N-N) for an ERD; columns, statuses and validation messages for a screen.
- Business rules, notes, legends and colour meanings written anywhere on the image.
Then close with a short "## What this means for testing" section: the flows worth exercising and the edge cases the diagram implies.

Rules:
- Describe ONLY what is actually in the image${opts.contextBlock ? " and in the project context above" : ''}. Never fill a gap with what a system like this usually does.
- Keep the original wording of labels, statuses and messages, in the language they are written in — a tester has to match them on screen character for character.
- When part of the image is unreadable (too small, cut off, blurred), say so explicitly in the document instead of guessing. A named gap is useful; an invented arrow is not.
- If the image carries nothing a tester could use — it is blank, unreadable, or simply not a diagram or a product screen — do NOT write a document about it. Reply with exactly one line — NOT_USABLE: <what the image actually is> — and nothing else.
- Structure with "## " sections and short bullets. Use a Markdown table for entities/fields and for transition lists.
${opts.instructions ? `\nThe engineer added this instruction — follow it: ${opts.instructions}\n` : ''}
Output ONLY the Markdown document. Start with a single "# " title naming what the image shows (not the file name). Do NOT re-embed the image, do not add a preamble, and do not wrap the answer in a code fence.`
}

function stripFence(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?```$/, '')
    .trim()
}

export async function knowledgeDocFromImage(opts: {
  rootPath: string
  projectName: string
  /** The knowledge doc name to write (already the user's choice of title). */
  docName: string
  /** Original upload file name — kept as the image's alt text. */
  fileName: string
  mime: string
  base64: string
  instructions?: string
  signal?: AbortSignal
}): Promise<
  | { ok: true; doc: WriteDocResult; asset: string }
  | { ok: false; status: number; error: string }
> {
  const ext = KNOWLEDGE_IMAGE_EXT[opts.mime]
  if (!ext) {
    return { ok: false, status: 415, error: 'Only PNG, JPEG, WebP and GIF images can be read.' }
  }
  const safeName = safeDocName(opts.docName)
  if (!safeName) return { ok: false, status: 400, error: 'invalid document name' }

  const bytes = Buffer.from(opts.base64, 'base64')
  if (!bytes.length) return { ok: false, status: 400, error: 'The image is empty.' }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `That image is too large (${Math.round(bytes.length / 1024 / 1024)} MB, limit ${
        MAX_IMAGE_BYTES / 1024 / 1024
      } MB).`,
    }
  }

  // The image lands on disk BEFORE the model runs — Read takes a path, not bytes.
  const dir = knowledgeAssetDir(opts.rootPath)
  const asset = assetFileName(safeName, ext)
  const abs = path.join(dir, asset)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(abs, bytes)
  } catch (err) {
    return { ok: false, status: 500, error: `Could not save the image: ${(err as Error).message}` }
  }

  // Anything that leaves without a written doc takes the image with it — an orphan
  // asset in the engineer's repo is litter they'd have to find and clean up.
  const abandon = <T>(result: T): T => {
    try {
      fs.rmSync(abs, { force: true })
    } catch {
      /* best effort */
    }
    return result
  }

  const context = readProjectContext(opts.rootPath, { maxChars: 8_000 })
  const result = await runClaude(
    [
      '-p',
      '--model',
      MODEL,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      BUDGET_USD,
      // Read is the whole point (it renders the image); nothing here may write to the
      // repo, and no MCP server needs to start for it. Both flags are variadic: each
      // MUST be followed by another flag.
      '--allowedTools',
      'Read',
      '--disallowedTools',
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      '--strict-mcp-config',
    ],
    TIMEOUT_MS,
    {
      cwd: opts.rootPath,
      usageSource: 'knowledge-image',
      model: MODEL,
      signal: opts.signal,
      input: buildPrompt({
        absPath: abs,
        fileName: opts.fileName,
        projectName: opts.projectName,
        contextBlock: context.block,
        instructions: (opts.instructions ?? '').trim().slice(0, 1_000),
      }),
    },
  )
  if (opts.signal?.aborted) return abandon({ ok: false as const, status: 499, error: 'stopped' })
  if (result.timedOut) {
    return abandon({ ok: false as const, status: 504, error: 'Timed out while reading the image.' })
  }
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  const doc = stripFence(text)
  if (result.code !== 0 || isError || !doc) {
    return abandon({
      ok: false as const,
      status: 502,
      error: 'The AI returned nothing. Check Settings → Models that Claude is signed in, then retry.',
    })
  }
  if (doc.toUpperCase().startsWith(NOT_USABLE)) {
    return abandon({
      ok: false as const,
      status: 422,
      error: `Nothing to document in that image — ${
        doc.slice(NOT_USABLE.length).trim().slice(0, 200) || 'it carries no diagram or screen.'
      }`,
    })
  }
  if (doc.length < MIN_DOC_CHARS) {
    // A two-line answer is a refusal ("I can't make out this image"), and saving it as
    // project knowledge would put that sentence into every future prompt.
    return abandon({
      ok: false as const,
      status: 422,
      error: `The AI could not describe that image: ${doc.slice(0, 200)}`,
    })
  }

  // The picture leads the document. Relative on purpose: the preview resolves it
  // through the assets route, and a run reading testing/knowledge/ from the project
  // root can Read the same path.
  const alt = opts.fileName.replace(/[[\]()]/g, '').slice(0, 120) || safeName
  const content = `${doc}\n\n## Source image\n\n![${alt}](assets/${asset})\n`
  // Re-uploading under an existing name overwrites that doc, so its old image would
  // otherwise stay in the repo forever with nothing pointing at it. Read it first,
  // drop it only once the new doc is safely written (asset names are timestamped, so
  // the one we just saved is never in this list).
  const replaced = readDocContent(opts.rootPath, safeName)
  const written = writeDoc({
    rootPath: opts.rootPath,
    name: safeName,
    content,
    source: `ai · image · ${new Date().toISOString().slice(0, 10)}`,
  })
  if (!written) {
    return abandon({ ok: false as const, status: 413, error: 'document too large (5 MB of text max)' })
  }
  if (replaced) deleteDocAssets(opts.rootPath, replaced)
  return { ok: true, doc: written, asset }
}

/**
 * Delete the asset files a doc's Markdown embeds. Called when the doc is deleted —
 * otherwise every removed diagram leaves its image behind in the engineer's repo.
 * Only touches files inside `testing/knowledge/assets/`.
 */
export function deleteDocAssets(root: string, markdown: string): void {
  const dir = knowledgeAssetDir(root)
  const seen = new Set<string>()
  for (const m of markdown.matchAll(/assets\/([\w.-]+)/g)) {
    const file = m[1]
    if (seen.has(file) || file.includes('..')) continue
    seen.add(file)
    const abs = path.resolve(dir, file)
    if (abs !== path.join(dir, file)) continue // never step outside the assets folder
    try {
      fs.rmSync(abs, { force: true })
    } catch {
      /* already gone */
    }
  }
}
