import fs from 'node:fs'
import path from 'node:path'
import { knowledgeDir, listDocs } from './knowledgeStore.js'
import { listNotes, memoryDir, parseNote } from './memoryStore.js'

// Reads a project's standing context — durable Memory facts (testing/memory/*.md)
// and reference Knowledge docs (testing/knowledge/*.md) — and packs it into one
// capped, labeled block that can be injected directly into a one-shot prompt.
//
// Why inject instead of relying on CLAUDE.md? Test-case generation now runs inside the
// project (so the model CAN read CLAUDE.md and the source), but injecting the knowledge/
// memory directly is more reliable than hoping the model opens those files — it guarantees
// the project's real terminology, screens, roles, and business rules are in context, and
// lets the grounding check treat a knowledge-derived case as grounded rather than invented.
//
// Best-effort and never throws: a missing folder or unreadable file is skipped.

const DEFAULT_MAX_CHARS = 32_000 // total budget for the whole block (multi-repo source maps need room)
const PER_ITEM_CHARS = 6_000 // cap any single note/doc so one huge doc can't crowd out the rest
const MEMORY_MAX_CHARS = 12_000 // memory packs first — bound it so notes can't starve knowledge docs
const SOURCE_MAP_PREFIX = 'source-map-' // repo index docs (sourceMap.ts) — highest-value knowledge
const KNOWLEDGE_MARKER_RE = /^<!--\s*qc-portal:source:[\s\S]*?-->\s*\n?/ // provenance comment

export interface ProjectContext {
  /** The ready-to-inject block, or '' when the project has no knowledge/memory. */
  block: string
  hasContent: boolean
  docCount: number
  noteCount: number
  /** True when something was clipped to fit the budget. */
  truncated: boolean
}

const EMPTY: ProjectContext = {
  block: '',
  hasContent: false,
  docCount: 0,
  noteCount: 0,
  truncated: false,
}

function clip(s: string, n: number): { text: string; clipped: boolean } {
  if (s.length <= n) return { text: s, clipped: false }
  return { text: s.slice(0, n).trimEnd() + '\n…(truncated)', clipped: true }
}

/**
 * Read the active project's Memory + Knowledge into one capped context block.
 * Memory comes first (concise, high-signal facts), then Knowledge docs. Both are
 * newest-first. Returns an empty block when there's nothing to inject.
 */
export function readProjectContext(rootPath: string, opts?: { maxChars?: number }): ProjectContext {
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS
  const sections: string[] = []
  let used = 0
  let truncated = false
  let docCount = 0
  let noteCount = 0

  // Append one labeled section if there's budget left; returns false to stop.
  const push = (heading: string, raw: string): boolean => {
    const body = raw.trim()
    if (!body) return true // empty item — skip but keep going
    if (used >= maxChars) {
      truncated = true
      return false
    }
    const budget = Math.min(PER_ITEM_CHARS, maxChars - used)
    const { text, clipped } = clip(body, budget)
    if (clipped) truncated = true
    const chunk = `${heading}\n${text}`
    sections.push(chunk)
    used += chunk.length + 2 // + the join separator
    return true
  }

  // Memory first — small durable facts carry the most signal per character. Bounded
  // to MEMORY_MAX_CHARS so a pile of long notes can't starve the knowledge docs.
  try {
    const dir = memoryDir(rootPath)
    for (const n of listNotes(rootPath)) {
      if (used >= MEMORY_MAX_CHARS) {
        truncated = true
        break
      }
      let parsed: ReturnType<typeof parseNote>
      try {
        parsed = parseNote(fs.readFileSync(path.join(dir, `${n.name}.md`), 'utf8'))
      } catch {
        continue
      }
      const desc = parsed.description ? `_${parsed.description}_\n\n` : ''
      if (!push(`### Memory — ${n.name}`, desc + parsed.body)) break
      noteCount++
    }
  } catch {
    /* no memory folder */
  }

  // Knowledge docs — source maps FIRST (the repo indexes the prompts steer by;
  // being crowded out would silently re-enable full repo exploration), then the
  // remaining reference material newest-first.
  try {
    const dir = knowledgeDir(rootPath)
    const docs = listDocs(rootPath).sort((a, b) => {
      const aMap = a.name.startsWith(SOURCE_MAP_PREFIX) ? 0 : 1
      const bMap = b.name.startsWith(SOURCE_MAP_PREFIX) ? 0 : 1
      return aMap - bMap // stable: keeps newest-first within each group
    })
    for (const d of docs) {
      let raw: string
      try {
        raw = fs.readFileSync(path.join(dir, `${d.name}.md`), 'utf8')
      } catch {
        continue
      }
      if (!push(`### Knowledge — ${d.name}`, raw.replace(KNOWLEDGE_MARKER_RE, ''))) break
      docCount++
    }
  } catch {
    /* no knowledge folder */
  }

  if (!sections.length) return EMPTY

  const intro =
    'The following is standing project context the QC engineer maintains (durable Memory ' +
    'facts and reference Knowledge docs). Use it to ground your work in this project\'s real ' +
    'terminology, screens, fields, roles, business rules, and known conventions, so you get ' +
    'details right instead of guessing. It is authoritative BACKGROUND — it does NOT widen ' +
    'scope: only cover what the ticket / feature under test actually requires.'

  // When something was clipped, say so INSIDE the block — the model is otherwise
  // told not to re-read these folders, and this is the one case where it should.
  const omissionNote = truncated
    ? '\n\n(Note: some items above were clipped or omitted for space. If a detail you need is missing, read the full files in testing/knowledge/ and testing/memory/.)'
    : ''

  const block = `--- PROJECT KNOWLEDGE & MEMORY START ---\n${intro}\n\n${sections.join(
    '\n\n',
  )}${omissionNote}\n--- PROJECT KNOWLEDGE & MEMORY END ---`

  return { block, hasContent: true, docCount, noteCount, truncated }
}
