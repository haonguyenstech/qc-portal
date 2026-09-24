import fs from 'node:fs'
import path from 'node:path'

/**
 * WHAT THE TEAM ALREADY READ — shared, so the next bot does not read it again.
 *
 * Every team reply is a fresh `claude` run with no session, so each bot used to open the
 * same files from scratch: on screen, nearly every reply of an exchange began "I re-read
 * testing/tickets/KAN-1/ticket.md…", each one a tool round trip (seconds) and its tokens.
 * Now a Read by any bot is noted (`StreamLog.tool.path`), and every LATER prompt carries
 * those files' CURRENT content — read from disk when the prompt is built, so an edit since
 * is never shown stale. The list is kept on the conversation (`Chat.teamFiles`), so the
 * next exchange starts with it too.
 *
 * Guarded: only regular text files INSIDE the project root, never `.git/`, `.env*` or
 * `.mcp.json` (credentials — a bot that read one should not hand it to every other bot).
 * Capped per file and in total; a cut file says so, and the bot is told to Read it itself
 * for the rest.
 */

const MAX_FILES = 12
const FILE_CHARS = 8_000
const TOTAL_CHARS = 24_000
const MAX_BYTES = 256 * 1024

/** The project-relative path of a file a bot read, or null when it must not be shared. */
export function shareablePath(root: string, filePath: string): string | null {
  const abs = path.resolve(root, filePath)
  const rel = path.relative(root, abs)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(/[\\/]/)
  const name = parts[parts.length - 1].toLowerCase()
  if (parts.includes('.git') || parts.includes('node_modules')) return null
  if (name === '.mcp.json' || name.startsWith('.env')) return null
  return rel.split(path.sep).join('/')
}

/** Add a path to a most-recent-last list, de-duplicated and capped. */
export function rememberFile(list: string[], rel: string): string[] {
  return [...list.filter((p) => p !== rel), rel].slice(-MAX_FILES)
}

/**
 * The prompt block for the files the team has read, newest first until the cap. `readBy`
 * names the bot that read each one in THIS exchange (absent = an earlier exchange).
 */
export function knownFilesBlock(root: string, files: string[], readBy: Map<string, string>): string {
  const out: { path: string; readBy?: string; content: string; cut?: true }[] = []
  let total = 0
  for (const rel of [...files].reverse()) {
    if (total >= TOTAL_CHARS) break
    const abs = path.resolve(root, rel)
    if (!shareablePath(root, abs)) continue
    let text: string
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size > MAX_BYTES) continue
      text = fs.readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue // binary
    const room = Math.min(FILE_CHARS, TOTAL_CHARS - total)
    const cut = text.length > room
    const content = cut ? text.slice(0, room) : text
    total += content.length
    out.push({ path: rel, ...(readBy.has(rel) ? { readBy: readBy.get(rel) } : {}), content, ...(cut ? { cut: true as const } : {}) })
  }
  return out.length ? JSON.stringify(out) : ''
}
