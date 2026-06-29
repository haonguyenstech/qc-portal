import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

// Storage primitives for project memory — small markdown "fact" notes under
// <root>/testing/memory/<name>.md, each with a one-line `description` (and an
// optional `source` provenance) in YAML frontmatter, plus an auto-generated
// MEMORY.md index. Shared by routes/memory.ts (the editor) and learn.ts (the AI
// auto-capture step), so there's a single source of truth for the format.

export const MEMORY_INDEX_FILE = 'MEMORY.md'
const MAX_BYTES = 64 * 1024 // a fact note, not a document

export function memoryDir(root: string): string {
  return path.join(testingDirFor(root), 'memory')
}

/** Sanitize a user/AI-supplied note name into a safe `<name>` (no extension). */
export function safeNoteName(input: string): string | null {
  const base = (input ?? '').replace(/\.md$/i, '').trim()
  const safe = base
    .replace(/[/\\]+/g, '-')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
  if (!safe) return null
  if (safe.toLowerCase() === 'memory') return null // reserve MEMORY.md for the index
  return safe
}

/** Resolve <memoryDir>/<name>.md, refusing names that could escape the folder. */
export function memoryFile(root: string, rawName: string): string | null {
  const safe = safeNoteName(rawName)
  if (!safe) return null
  const dir = memoryDir(root)
  const target = path.resolve(dir, `${safe}.md`)
  if (target !== path.join(dir, `${safe}.md`)) return null
  return target
}

export interface ParsedNote {
  description: string
  source: string // '' for hand-authored notes; 'ai · …' for AI-captured ones
  body: string
}

/** Split a stored note into its frontmatter (description + source) and body. */
export function parseNote(raw: string): ParsedNote {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { description: '', source: '', body: raw.replace(/^\s+/, '') }
  const front = m[1]
  const field = (key: string) => {
    const fm = front.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))
    return fm ? fm[1].trim().replace(/^["']|["']$/g, '') : ''
  }
  return { description: field('description'), source: field('source'), body: raw.slice(m[0].length).replace(/^\s+/, '') }
}

/** Serialize a note with a frontmatter description (+ optional source) and body. */
export function serializeNote(description: string, body: string, source?: string): string {
  const desc = description.replace(/\r?\n/g, ' ').trim()
  const lines = ['---', `description: ${desc}`]
  if (source && source.trim()) lines.push(`source: ${source.replace(/\r?\n/g, ' ').trim()}`)
  lines.push('---', '', body.trim(), '')
  return lines.join('\n')
}

export interface NoteMeta {
  name: string
  description: string
  source: string
  size: number
  savedAt: string
}

/** Read every note's metadata (excludes the MEMORY.md index), newest first. */
export function listNotes(root: string): NoteMeta[] {
  const dir = memoryDir(root)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md') && d.name !== MEMORY_INDEX_FILE)
      .map((d) => {
        const full = path.join(dir, d.name)
        const stat = fs.statSync(full)
        const { description, source } = parseNote(fs.readFileSync(full, 'utf8'))
        return {
          name: d.name.replace(/\.md$/, ''),
          description,
          source,
          size: stat.size,
          savedAt: stat.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return [] // no memory dir yet
  }
}

/** Rewrite testing/memory/MEMORY.md as a one-line-per-note index (or remove it). */
export function regenerateIndex(root: string): void {
  const dir = memoryDir(root)
  const indexPath = path.join(dir, MEMORY_INDEX_FILE)
  const notes = [...listNotes(root)].sort((a, b) => a.name.localeCompare(b.name))
  if (notes.length === 0) {
    try {
      fs.rmSync(indexPath)
    } catch {
      /* nothing to remove */
    }
    return
  }
  const lines = [
    '# Project memory',
    '',
    'Durable facts for QC work in this project — one per file. Consult these before testing.',
    '',
    ...notes.map(
      (n) => `- [${n.name}](${encodeURI(n.name)}.md)${n.description ? ` — ${n.description}` : ''}`,
    ),
    '',
  ]
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(indexPath, lines.join('\n'), 'utf8')
}

export interface WriteNoteResult {
  name: string
  description: string
  size: number
  savedAt: string
}

/**
 * Create or overwrite a memory note and refresh the index. Returns null when the
 * name is invalid, the body is empty, or the serialized note exceeds the size cap.
 * Does NOT sync the CLAUDE.md context pointer — the caller batches that.
 */
export function writeNote(opts: {
  rootPath: string
  name: string
  description: string
  body: string
  source?: string
}): WriteNoteResult | null {
  const safe = safeNoteName(opts.name)
  const target = memoryFile(opts.rootPath, opts.name)
  if (!safe || !target) return null
  if (!opts.body.trim()) return null
  const serialized = serializeNote(opts.description, opts.body, opts.source)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) return null
  fs.mkdirSync(memoryDir(opts.rootPath), { recursive: true })
  fs.writeFileSync(target, serialized, 'utf8')
  regenerateIndex(opts.rootPath)
  const stat = fs.statSync(target)
  return {
    name: safe,
    description: opts.description.trim(),
    size: stat.size,
    savedAt: stat.mtime.toISOString(),
  }
}

/** Delete a note (if present) and refresh the index. */
export function deleteNote(rootPath: string, rawName: string): void {
  const target = memoryFile(rootPath, rawName)
  if (!target) return
  try {
    fs.rmSync(target)
  } catch {
    /* already gone */
  }
  regenerateIndex(rootPath)
}
