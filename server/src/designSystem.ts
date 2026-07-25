import fs from 'node:fs'
import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import { syncContextPointer } from './contextPointer.js'
import { docSource, knowledgeFile, writeDoc } from './knowledgeStore.js'

// Design system: a compact, AI-extracted description of the REAL product's visual
// language — palette, type scale, spacing/radii, component shapes, iconography, and
// the wording conventions used for labels, statuses and messages — written ONCE into
// testing/knowledge/design-system.md.
//
// Why this exists: the Prototype page's "Match our app" toggle re-reads the repo on
// EVERY build. That is slow (it needs GEN_TIMEOUT_SOURCE), costs tool turns, and gives
// a slightly different answer each time, so two prototypes of the same product don't
// look like siblings. Extracting the design language once and injecting it as text
// makes every later build fast, cheap, and CONSISTENT — the same tokens every time.
//
// It's stored as a knowledge doc, so it rides the existing pipeline for free:
// projectContext.ts injects it into prototype + test-case prompts, QC runs reach it via
// the CLAUDE.md context pointer, and it shows up on Instructions → Knowledge with an
// "AI" badge that the engineer can edit or correct (editing drops the badge, claiming
// it as theirs). Mirrors sourceMap.ts.
//
// Best-effort and never throws: no design system just means builds fall back to
// reading the source (or to a generic-but-pretty screen), exactly as before.

export const DESIGN_SYSTEM_DOC = 'design-system'

const MAX_DOC_CHARS = 5_500 // projectContext injects at most 6 KB per knowledge doc
const TIMEOUT_MS = 300_000 // repo exploration + write, on a cheap model

export interface DesignSystemInfo {
  exists: boolean
  /** Provenance marker ('' for a doc the engineer authored or edited by hand). */
  source: string
  size: number
  savedAt: string | null
  content: string
}

const NONE: DesignSystemInfo = { exists: false, source: '', size: 0, savedAt: null, content: '' }

/** Read the project's design-system doc (never throws — absent reads back as NONE). */
export function readDesignSystem(rootPath: string): DesignSystemInfo {
  const file = knowledgeFile(rootPath, DESIGN_SYSTEM_DOC)
  if (!file) return NONE
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const stat = fs.statSync(file)
    return {
      exists: true,
      source: docSource(raw),
      size: stat.size,
      savedAt: stat.mtime.toISOString(),
      // Strip the provenance marker — callers inject this into prompts / show it in the UI.
      content: raw.replace(/^<!--\s*qc-portal:source:[\s\S]*?-->\s*\n?/, '').trim(),
    }
  } catch {
    return NONE
  }
}

function buildPrompt(sourceWhere: string, projectName: string): string {
  return `You are extracting the DESIGN SYSTEM of a real application so that future AI-generated UI prototypes look like they belong in THIS product instead of looking like generic mock-ups.

The application's source code is ${sourceWhere}. You are running inside the project "${projectName}".

Explore QUICKLY and purposefully. Read the files that actually define the look:
- The styling config and tokens — tailwind.config.*, a theme/tokens file, global CSS (CSS custom properties), SCSS variables, a MUI/Chakra/Ant theme, styled-components theme.
- 3-6 representative UI files: the app shell / layout / navigation, a form, a list or table, and a shared component folder (buttons, inputs, cards, modals, badges).
- Anywhere user-facing STRINGS live: labels, validation messages, status names, empty states.
Skim at most 12-15 files total. Do NOT crawl the whole codebase, do NOT spawn sub-agents, and NEVER modify, create, or delete a file — you are READ-ONLY.

Then output a compact DESIGN SYSTEM in plain Markdown, using exactly these sections:

## Look & feel
Two or three sentences: how this product looks and feels (e.g. "dense enterprise data tool, light theme, restrained blue accent, hairline borders, almost no shadow"). Name the CSS/UI framework in use.

## Colour
The real palette with actual values — primary/brand, neutrals/surfaces, text, borders, and the semantic colours (success, warning, error, info). Give hex or token names EXACTLY as the code writes them. Note whether dark mode exists.

## Typography
Real font families, the sizes/weights actually used for page titles, section headings, body, and small/muted text. Include the token or class names if there are any.

## Spacing, radius & elevation
The spacing rhythm (e.g. 4px/8px scale), the border-radius values used for cards / inputs / buttons / pills, border colour + width conventions, and how much shadow is used (or that it's flat).

## Components
One line per common component — button variants (primary/secondary/ghost/destructive), inputs and their label/help/error layout, cards, tables/lists, badges/status pills, modals/dialogs, tabs, toasts. Describe the SHAPE and SIZE conventions, not the code.

## Layout & shell
The page frame: sidebar or top nav, header contents, page-title pattern, content max-width, how a typical page is composed.

## Wording & terminology
How this product talks: capitalisation style for labels and buttons (Title Case vs sentence case), the real names it uses for common entities and actions, real status values, and the tone/format of validation and empty-state messages. Quote 4-8 REAL examples verbatim from the code.

Rules:
- Be CONCRETE — real values, real class/token names, real strings quoted from the source. A generic answer is worthless here.
- If you genuinely cannot find something, write "not found in source" for that item rather than inventing it.
- HARD LIMIT: keep the whole document under 5000 characters. Prefer dropping detail from "Layout & shell" over "Colour" or "Wording & terminology".
- Output ONLY the document (starting at "## Look & feel") — no preamble, no closing remarks, no code fences.`
}

/**
 * Extract (or refresh) the project's design system. Runs Claude read-only inside the
 * project, saves the result as an AI-tagged knowledge doc, and syncs the CLAUDE.md
 * context pointer. Returns an error string instead of throwing, so a caller can show
 * it without any try/catch.
 */
export async function generateDesignSystem(opts: {
  rootPath: string
  sourceWhere: string
  projectName: string
  model?: string
  onLog?: (line: { level: 'info' | 'success' | 'error'; text: string }) => void
  signal?: AbortSignal
}): Promise<{ ok: true; info: DesignSystemInfo } | { ok: false; error: string }> {
  const onLog = opts.onLog ?? (() => {})
  const model = opts.model ?? 'haiku'
  try {
    onLog({ level: 'info', text: `▶ Reading the app's real design language · model ${model}` })
    const result = await runClaude(
      [
        '-p',
        '--model',
        model,
        '--output-format',
        'json',
        '--no-session-persistence',
        '--max-budget-usd',
        '0.60',
        // Read-only file tools, no MCP — extraction must never touch the repo and must
        // start fast. Both flags are variadic: each MUST be followed by another flag.
        '--allowedTools',
        'Read',
        'Grep',
        'Glob',
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
        usageSource: 'design-system',
        model,
        input: buildPrompt(opts.sourceWhere, opts.projectName),
        signal: opts.signal,
      },
    )
    if (opts.signal?.aborted) return { ok: false, error: 'stopped' }
    if (result.timedOut) {
      return { ok: false, error: 'Reading the design system timed out. Try again, or write it by hand on the Instructions → Knowledge tab.' }
    }
    const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
    if (result.code !== 0 || isError || !text.trim()) {
      return { ok: false, error: 'The AI returned nothing usable. Check that this project has source code connected.' }
    }

    let doc = text.trim()
    if (doc.length > MAX_DOC_CHARS) doc = `${doc.slice(0, MAX_DOC_CHARS)}\n\n…(truncated)`
    const today = new Date().toISOString().slice(0, 10)
    const content = `# Design system — ${opts.projectName}\n\n_Extracted from this project's source code on ${today}. This is the product's REAL visual language: AI-generated prototypes are built to match it. Correct anything that's wrong — an edit makes this doc yours._\n\n${doc}\n`

    const written = writeDoc({
      rootPath: opts.rootPath,
      name: DESIGN_SYSTEM_DOC,
      content,
      source: `ai · design system · ${today}`,
    })
    if (!written) return { ok: false, error: 'Could not save the design system doc.' }
    syncContextPointer(opts.rootPath)
    onLog({ level: 'success', text: `✔ Design system saved (${(written.size / 1024).toFixed(1)} KB)` })
    return { ok: true, info: readDesignSystem(opts.rootPath) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'design system extraction failed' }
  }
}
