import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

/**
 * Test-case documents uploaded on the Run form to be executed AS the acceptance
 * source of one run — `<root>/testing/test-cases/<stamp>-<slug>.md`.
 *
 * Why a file at all: the Claude CLI takes a PROMPT, not bytes. A 200-case
 * regression sheet cannot ride inside the run prompt (and truncating it would
 * silently drop the cases at its end, which is the one failure a QC engineer
 * cannot see), so the document is written into the project and the run is told to
 * `Read` it — the same road a pasted screenshot takes in chat (routes/chat.ts).
 * It lands INSIDE the project on purpose: the run's cwd is the project root, the
 * report can cite a path that still exists afterwards, and the engineer can open
 * it from the run folder later.
 *
 * The on-disk name is generated HERE. The uploaded file's own name is a label
 * that only ever reaches the slug, never a path segment — so nothing the browser
 * sends can escape this folder.
 */

/** Extracted markdown per document. Bigger than this is a spec, not a test-case sheet. */
export const RUN_DOC_MAX_BYTES = 2 * 1024 * 1024

export function runTestcaseDir(root: string): string {
  return path.join(testingDirFor(root), 'test-cases')
}

/** A file-name-safe slug of the uploaded document's own name. Never a path. */
export function docSlug(input: string): string {
  const base = (input ?? '')
    .replace(/\.[^./\\]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return base || 'test-cases'
}

/** `20260825-143012` — sorts chronologically and keeps two same-named uploads apart. */
function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`
}

export interface SavedRunDoc {
  /** File name only. */
  file: string
  /** Project-relative POSIX path — what the run prompt cites. */
  relPath: string
  abs: string
  bytes: number
}

/**
 * Write one uploaded document under `testing/test-cases/`. The header records
 * where it came from, because six months later "20260825-143012-regression.md"
 * has to explain itself.
 */
export function saveRunTestcaseDoc(
  root: string,
  originalName: string,
  markdown: string,
): SavedRunDoc {
  const dir = runTestcaseDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const slug = docSlug(originalName)
  const file = `${stamp()}-${slug}.md`
  const abs = path.join(dir, file)
  const label = (originalName ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || file
  const body = `<!-- qc-portal:uploaded-test-cases: ${label} -->\n\n${markdown.trim()}\n`
  fs.writeFileSync(abs, body, 'utf8')
  return {
    file,
    relPath: `testing/test-cases/${file}`,
    abs,
    bytes: Buffer.byteLength(body, 'utf8'),
  }
}
