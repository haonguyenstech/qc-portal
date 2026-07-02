import fs from 'node:fs'
import path from 'node:path'
import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import { syncContextPointer } from './contextPointer.js'
import { knowledgeFile, writeDoc } from './knowledgeStore.js'
import { tagSlug, type GitLogLine } from './sourceRepo.js'

// Source map: a compact, AI-generated index of a connected repo, written ONCE per
// clone/sync into testing/knowledge/source-map-<tag>.md. Because it lives in the
// Knowledge folder it flows through the existing pipeline for free — injected into
// test-case prompts (projectContext.ts), readable by QC runs via the CLAUDE.md
// context pointer, and visible/editable on the Instructions page with an "AI" badge.
//
// The point is token economy: instead of every generation re-exploring the repo
// (5-8 exploratory file reads, every time), the model gets the map up front and
// opens only the two or three files it names. The map costs one cheap (haiku) pass
// per sync — when the code actually changed — not one per generation.
//
// Best-effort and never throws: a failed map just means the model falls back to
// exploring the repo directly, exactly as before.

const SOURCE_MAP_MODEL = 'haiku'
const MAX_MAP_CHARS = 5_500 // projectContext injects at most 6 KB per knowledge doc
const TIMEOUT_MS = 300_000 // repo exploration + write, on a cheap model

/** Knowledge-doc name for a repo tag: "Backend repo" → "source-map-backend-repo". */
export function sourceMapDocName(tag: string): string {
  return `source-map-${tagSlug(tag)}`
}

/** True when a map doc already exists for this tag (used to skip unchanged syncs). */
export function hasSourceMap(rootPath: string, tag: string): boolean {
  const file = knowledgeFile(rootPath, sourceMapDocName(tag))
  try {
    return Boolean(file && fs.statSync(file).isFile())
  } catch {
    return false
  }
}

/** Remove a repo's map doc (on disconnect / tag rename). Best-effort. */
export function deleteSourceMap(rootPath: string, tag: string): void {
  const file = knowledgeFile(rootPath, sourceMapDocName(tag))
  try {
    if (file && fs.existsSync(file)) {
      fs.rmSync(file)
      syncContextPointer(rootPath)
    }
  } catch {
    /* best-effort */
  }
}

function buildPrompt(tag: string, repoUrl: string): string {
  return `You are indexing a source repository for a QC testing team. This repo is the project's "${tag}" (${repoUrl}). Your output will be injected into future AI prompts so a model can jump STRAIGHT to the right file for any ticket instead of exploring the repo from scratch.

Explore QUICKLY — Glob the folder structure, read the manifest (package.json / pom.xml / *.csproj / go.mod / …), the README, and the main routing/navigation/config files; skim at most 10-15 files total. Do NOT read every file. Then output a compact SOURCE MAP in plain Markdown:

## What this is
One or two sentences: what the app/service does + the tech stack.

## Layout
One line per important folder — what lives there. Skip vendored/generated folders.

## Screens & routes (or API endpoints)
A table or list: feature/screen/endpoint → file path. This is the most valuable section — be thorough here.

## Domain models
Key entities and WHERE they are defined (file paths). Include real field names when short.

## Cross-cutting
Where validation rules, error/status messages, permissions/roles, and shared UI components live.

## Conventions
Naming or structural conventions worth knowing (1-4 bullets).

Rules:
- All paths RELATIVE to the repo root (you are running inside it).
- Be specific — real file paths, real names. No generic filler.
- HARD LIMIT: keep the whole map under 5000 characters. Prefer dropping detail from "Domain models" over "Screens & routes".
- Output ONLY the map (starting at "## What this is") — no preamble, no closing remarks.`
}

/**
 * Generate (or refresh) the source map for one connected repo. Runs Claude
 * read-only INSIDE the repo folder, saves the result as an AI-tagged knowledge
 * doc, and syncs the CLAUDE.md context pointer. Returns null on any failure.
 */
export async function generateSourceMap(opts: {
  rootPath: string
  sourcePath: string
  tag: string
  repoUrl: string
  onLog?: (line: GitLogLine) => void
}): Promise<{ name: string } | null> {
  const onLog = opts.onLog ?? (() => {})
  try {
    if (!fs.statSync(opts.sourcePath).isDirectory()) return null

    const result = await runClaude(
      [
        '-p',
        '--model',
        SOURCE_MAP_MODEL,
        '--output-format',
        'json',
        '--no-session-persistence',
        '--max-budget-usd',
        '0.50',
        // Read-only file tools, no MCP — indexing must never touch the repo and
        // must start fast. --allowedTools is variadic: keep a flag after it.
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
        '--strict-mcp-config',
      ],
      TIMEOUT_MS,
      {
        cwd: opts.sourcePath,
        usageSource: 'source-map',
        model: SOURCE_MAP_MODEL,
        input: buildPrompt(opts.tag, opts.repoUrl),
      },
    )
    if (result.timedOut) {
      onLog({ level: 'info', text: '  source map timed out — skipped' })
      return null
    }
    const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
    if (result.code !== 0 || isError || !text.trim()) {
      onLog({ level: 'info', text: '  source map: no AI response — skipped' })
      return null
    }

    let map = text.trim()
    if (map.length > MAX_MAP_CHARS) map = `${map.slice(0, MAX_MAP_CHARS)}\n\n…(truncated)`
    const today = new Date().toISOString().slice(0, 10)
    const rel = path.relative(opts.rootPath, opts.sourcePath) || '.'
    const content = `# Source map — ${opts.tag}\n\n_Repo \`${opts.repoUrl}\` · local folder \`./${rel}\` · indexed ${today}. File paths below are relative to that folder._\n\n${map}\n`

    const written = writeDoc({
      rootPath: opts.rootPath,
      name: sourceMapDocName(opts.tag),
      content,
      source: `ai · source map · ${opts.tag} · ${today}`,
    })
    if (!written) return null
    syncContextPointer(opts.rootPath)
    return { name: written.name }
  } catch {
    return null
  }
}
