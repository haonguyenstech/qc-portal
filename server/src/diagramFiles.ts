import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'
import { safeSegment } from './crawl.js'
import type { Diagram } from './db.js'

// Diagrams live in the DB (source of truth) but are ALSO mirrored to files under
// <root>/testing/diagrams/ so they're visible in the project folder and can be
// committed alongside the repo. One <safeName>.md per diagram, holding the Mermaid
// source inside a ```mermaid fence (renders on GitHub / in markdown editors).

export function diagramsDir(rootPath: string): string {
  return path.join(testingDirFor(rootPath), 'diagrams')
}

/** Pick a unique, filesystem-safe `<name>.md` for a diagram within this batch. */
function fileNameFor(name: string, taken: Set<string>): string {
  const base = safeSegment(name) || 'diagram'
  let fname = `${base}.md`
  let n = 2
  while (taken.has(fname.toLowerCase())) {
    fname = `${base}-${n}.md`
    n++
  }
  taken.add(fname.toLowerCase())
  return fname
}

function fileContent(d: Diagram): string {
  return `# ${d.name}\n\n\`\`\`mermaid\n${d.content.trim()}\n\`\`\`\n`
}

/**
 * Mirror the project's diagrams to <root>/testing/diagrams/.
 * - Always (re)writes a .md file per diagram.
 * - When `prune` is true, also deletes managed .md files no longer backed by a
 *   diagram (so renames/deletes don't leave orphans). Best-effort; never throws.
 */
export function writeDiagramFiles(
  rootPath: string,
  diagrams: Diagram[],
  opts: { prune: boolean },
): void {
  try {
    const dir = diagramsDir(rootPath)
    fs.mkdirSync(dir, { recursive: true })

    const taken = new Set<string>()
    const desired = new Map<string, string>() // filename -> content
    for (const d of diagrams) desired.set(fileNameFor(d.name, taken), fileContent(d))

    if (opts.prune) {
      let existing: string[] = []
      try {
        existing = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
      } catch {
        /* dir just created / unreadable */
      }
      for (const f of existing) {
        if (!desired.has(f)) {
          try {
            fs.rmSync(path.join(dir, f))
          } catch {
            /* ignore */
          }
        }
      }
    }

    for (const [fname, content] of desired) {
      try {
        fs.writeFileSync(path.join(dir, fname), content)
      } catch {
        /* ignore individual write failures */
      }
    }
  } catch {
    /* mirroring to disk must never break the DB-backed API */
  }
}
