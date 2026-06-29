import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

// Storage primitives for project knowledge — reference docs under
// <root>/testing/knowledge/<name>.md (uploaded + converted to Markdown by the
// browser, or written by the AI auto-capture step in learn.ts). Shared by
// routes/knowledge.ts and learn.ts.
//
// AI-captured docs carry provenance as a leading HTML comment marker, which is
// invisible when the Markdown is rendered but lets the UI flag them with a badge.

export const KNOWLEDGE_MAX_BYTES = 5 * 1024 * 1024 // 5 MB of extracted text per doc

const SOURCE_RE = /^<!--\s*qc-portal:source:\s*(.*?)\s*-->\s*\n?/

export function knowledgeDir(root: string): string {
  return path.join(testingDirFor(root), 'knowledge')
}

/** Sanitize a user/AI-supplied document name into a safe `<name>` (no extension). */
export function safeDocName(input: string): string | null {
  const base = (input ?? '').replace(/\.md$/i, '').trim()
  const safe = base
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
  return safe || null
}

/** Resolve <knowledgeDir>/<name>.md, refusing names that could escape the folder. */
export function knowledgeFile(root: string, rawName: string): string | null {
  const safe = safeDocName(rawName)
  if (!safe) return null
  const dir = knowledgeDir(root)
  const target = path.resolve(dir, `${safe}.md`)
  if (target !== path.join(dir, `${safe}.md`)) return null
  return target
}

/** Pull the provenance source from a doc's leading marker, if any. */
export function docSource(raw: string): string {
  const m = raw.match(SOURCE_RE)
  return m ? m[1].trim() : ''
}

export interface DocMeta {
  name: string
  source: string
  size: number
  savedAt: string
}

/** List every stored doc (newest first) with its provenance source ('' if authored/uploaded). */
export function listDocs(root: string): DocMeta[] {
  const dir = knowledgeDir(root)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => {
        const full = path.join(dir, d.name)
        const stat = fs.statSync(full)
        // Read just the head to detect the provenance marker cheaply.
        let head = ''
        try {
          head = fs.readFileSync(full, 'utf8').slice(0, 300)
        } catch {
          /* ignore */
        }
        return {
          name: d.name.replace(/\.md$/, ''),
          source: docSource(head),
          size: stat.size,
          savedAt: stat.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return [] // no knowledge dir yet
  }
}

export interface WriteDocResult {
  name: string
  size: number
  savedAt: string
}

/**
 * Create or overwrite a knowledge doc. When `source` is set, a provenance marker is
 * prepended (invisible in rendered Markdown). Returns null on an invalid name or when
 * the content exceeds the size cap. Does NOT sync the context pointer — caller batches.
 */
export function writeDoc(opts: {
  rootPath: string
  name: string
  content: string
  source?: string
}): WriteDocResult | null {
  const safe = safeDocName(opts.name)
  const target = knowledgeFile(opts.rootPath, opts.name)
  if (!safe || !target) return null
  const body = opts.content.replace(SOURCE_RE, '') // never double-stamp
  if (!body.trim()) return null
  const marker = opts.source && opts.source.trim() ? `<!-- qc-portal:source: ${opts.source.trim()} -->\n` : ''
  const full = marker + body
  if (Buffer.byteLength(full, 'utf8') > KNOWLEDGE_MAX_BYTES) return null
  fs.mkdirSync(knowledgeDir(opts.rootPath), { recursive: true })
  fs.writeFileSync(target, full, 'utf8')
  const stat = fs.statSync(target)
  return { name: safe, size: stat.size, savedAt: stat.mtime.toISOString() }
}
