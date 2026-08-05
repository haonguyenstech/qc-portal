import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'
import { safeDocName } from './knowledgeStore.js'

// Storage primitives for OVERVIEW DOCUMENTS — one file per uploaded document under
// <root>/testing/overview/<name>.md.
//
// These ARE the project's overview: a product brief, a glossary, a spec extract — one
// file per upload, because merging them into `projects.description` made a single
// unreviewable blob and each document needs to be AI-reviewable on its own.
//
// The AI gets them by upload alone: projectContext.ts packs this folder into the
// injected context block (bounded by OVERVIEW_MAX_CHARS so a big spec can't crowd out
// Knowledge), and contextPointer.ts points in-project runs at the folder. It stays a
// separate folder from testing/knowledge so the Overview page owns its own list, and so
// "what the product is" can be packed ahead of general reference material.
//
// Name sanitizing is deliberately shared with knowledgeStore (safeDocName) so a file
// name lands on the same on-disk name in both stores.

export const OVERVIEW_DOC_MAX_BYTES = 5 * 1024 * 1024 // 5 MB of extracted text per doc

export function overviewDocsDir(root: string): string {
  return path.join(testingDirFor(root), 'overview')
}

/** Resolve <overviewDocsDir>/<name>.md, refusing names that could escape the folder. */
export function overviewDocFile(root: string, rawName: string): string | null {
  const safe = safeDocName(rawName)
  if (!safe) return null
  const dir = overviewDocsDir(root)
  const target = path.resolve(dir, `${safe}.md`)
  if (target !== path.join(dir, `${safe}.md`)) return null
  return target
}

export interface OverviewDocMeta {
  name: string
  size: number
  savedAt: string
}

/** List every stored overview document, newest first. */
export function listOverviewDocs(root: string): OverviewDocMeta[] {
  const dir = overviewDocsDir(root)
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => {
        const stat = fs.statSync(path.join(dir, d.name))
        return {
          name: d.name.replace(/\.md$/, ''),
          size: stat.size,
          savedAt: stat.mtime.toISOString(),
        }
      })
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return [] // folder not created yet
  }
}

/**
 * Create or overwrite one overview document. Returns null on an invalid/empty name,
 * empty content, or content past the size cap.
 */
export function writeOverviewDoc(opts: {
  rootPath: string
  name: string
  content: string
}): OverviewDocMeta | null {
  const safe = safeDocName(opts.name)
  const target = overviewDocFile(opts.rootPath, opts.name)
  if (!safe || !target) return null
  if (!opts.content.trim()) return null
  if (Buffer.byteLength(opts.content, 'utf8') > OVERVIEW_DOC_MAX_BYTES) return null
  fs.mkdirSync(overviewDocsDir(opts.rootPath), { recursive: true })
  fs.writeFileSync(target, opts.content, 'utf8')
  const stat = fs.statSync(target)
  return { name: safe, size: stat.size, savedAt: stat.mtime.toISOString() }
}

/** Read one document's Markdown, or null when it isn't there. */
export function readOverviewDoc(root: string, name: string): string | null {
  const target = overviewDocFile(root, name)
  if (!target) return null
  try {
    return fs.readFileSync(target, 'utf8')
  } catch {
    return null
  }
}
