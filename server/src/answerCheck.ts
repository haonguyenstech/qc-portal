import fs from 'node:fs'
import path from 'node:path'

// Answer citation check — the CHEAP half of chat's accuracy work.
//
// A chat answer's most common concrete wrongness is a file it names that isn't there:
// "the rules are in testing/tickets/ABC-1/testcases/v3.csv" when the ticket crawled as
// ABC-2 and only has a v1. The engineer opens the path, finds nothing, and now doesn't
// know which half of the answer to trust — and the model itself can't catch it, because
// from inside the turn a plausible path IS the answer.
//
// So this verifies the one class of claim that can be checked with certainty and for
// free: does the file exist. It is pure `fs.existsSync` over paths lifted out of the
// finished text — no AI call, no tokens, no network — which is why it can run on EVERY
// turn without touching the latency the request is judged on. Measured on a 12 KB answer
// with 30 candidate paths: under 2 ms.
//
// What it deliberately does NOT do is judge the answer. A missing path is reported as
// "not found", never as "wrong": in `write` mode the model creates files (those exist by
// the time this runs), and an answer may legitimately propose a file that doesn't exist
// yet. The finding is a prompt to look, and the UI wording has to keep it that way.

/** Only extensions a project artifact actually has — keeps `v1.2/3.4` style noise out. */
const EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'md', 'mdx', 'csv', 'tsv', 'yml', 'yaml',
  'html', 'css', 'scss', 'less', 'sql', 'py', 'java', 'cs', 'go', 'rb', 'php', 'kt', 'swift',
  'dart', 'vue', 'svelte', 'sh', 'ps1', 'bat', 'txt', 'xml', 'toml', 'ini', 'env', 'conf',
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'pdf', 'xlsx', 'xls', 'docx', 'zip', 'har',
])

/** Directories whose contents are not the project's own work and are not worth flagging. */
const IGNORE_SEGMENTS = ['node_modules', 'dist', 'build', '.git', 'coverage', '.next']

/** A first segment that is really a hostname — `api.example.com/v1/orders.json` is not a file. */
const HOSTNAME_RE = /^[\w-]+\.(com|net|org|io|dev|co|app|gov|edu|ai|sh|me|cloud|local)$/i

/** path-with-at-least-one-slash-and-an-extension. Spaces excluded on purpose: a prose
 *  sentence would otherwise be swallowed into the "file name". */
const PATH_RE = /(?:\.{0,2}\/)?(?:[A-Za-z0-9_.@~-]+\/)+[A-Za-z0-9_.@-]+\.[A-Za-z0-9]{1,6}/g

/** How many candidates we bother resolving, and how many findings we report. */
const MAX_CANDIDATES = 200
const MAX_MISSING = 6

/**
 * Drop fenced code blocks before scanning.
 *
 * Paths inside a fence are usually IMPORTS and shell samples — `from './lib/api'`,
 * `require('../x.js')` — resolved relative to the file being shown, not to the project
 * root, so checking them produces noise and nothing else. Paths the reader is meant to
 * OPEN are written in prose or in an inline `code` span, and those are kept.
 */
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/g, '\n').replace(/~~~[\s\S]*?(?:~~~|$)/g, '\n')
}

/** True when `abs` is inside `root` — the same containment rule every write path uses. */
function inside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * File paths this answer names that do not exist in the project.
 *
 * Never throws and never reports a path it isn't SURE about: a citation is only reported
 * when its base is unambiguous — it lives under `testing/` (a tree the portal owns, so a
 * relative path can only mean one thing) or its parent directory really exists (the right
 * neighbourhood, wrong file). A path whose parent is also missing is far more likely to be
 * written relative to some other base (`src/App.tsx` in a monorepo whose app is in `web/`)
 * than to be a hallucination, and guessing there would spend the engineer's trust on noise.
 */
export function missingRefs(root: string, answer: string): string[] {
  if (!answer || !root) return []
  const out: string[] = []
  const seen = new Set<string>()
  const body = stripFences(answer)
  let n = 0
  try {
    for (const m of body.matchAll(PATH_RE)) {
      if (n >= MAX_CANDIDATES || out.length >= MAX_MISSING) break
      const raw = m[0]
      const start = m.index ?? 0
      // Part of a longer token, or the tail of a URL — `://host/a/b.json`, `www.x.io/a.png`.
      const before = body.slice(Math.max(0, start - 3), start)
      if (/[A-Za-z0-9_@:/-]$/.test(before)) continue
      const cleaned = raw.replace(/^\.\//, '').replace(/[.,;:)\]}]+$/, '')
      if (!cleaned.includes('/') || cleaned.startsWith('..')) continue
      const ext = cleaned.split('.').pop()!.toLowerCase()
      if (!EXTS.has(ext)) continue
      const segments = cleaned.split('/')
      if (segments.some((s) => IGNORE_SEGMENTS.includes(s))) continue
      if (HOSTNAME_RE.test(segments[0] ?? '')) continue
      if (seen.has(cleaned)) continue
      seen.add(cleaned)
      n++
      // An absolute path is only ours to judge when it points inside this project; another
      // machine's path or a system file is not a claim about the project.
      const abs = path.isAbsolute(cleaned) ? cleaned : path.resolve(root, cleaned)
      if (!inside(root, abs)) continue
      if (fs.existsSync(abs)) continue
      const rel = path.relative(root, abs).split(path.sep).join('/')
      const sure = rel.startsWith('testing/') || fs.existsSync(path.dirname(abs))
      if (sure) out.push(rel)
    }
  } catch {
    // A malformed path (or an unreadable mount) must never cost the engineer their answer.
    return out
  }
  return out
}
