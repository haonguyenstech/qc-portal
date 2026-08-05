import fs from 'node:fs'
import path from 'node:path'
import { PORT, testingDirFor } from './config.js'
import { projectIdForRoot } from './projectScope.js'
import { hasTotp, listTotp } from './totp.js'

// Keeps the project's CLAUDE.md lean by maintaining a small auto-generated block
// that points Claude at the structured Knowledge + Memory folders instead of
// inlining everything. The block is delimited by HTML comment markers so it can
// be rewritten/removed without touching the engineer's own prose. Headless runs
// read CLAUDE.md, so the pointer is what makes the split content actually get used.

const BEGIN = '<!-- qc-portal:context (auto) -->'
const END = '<!-- /qc-portal:context -->'

function hasMarkdown(dir: string, exclude: string[] = []): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.toLowerCase().endsWith('.md') && !exclude.includes(f.toLowerCase()))
  } catch {
    return false // folder absent
  }
}

/** Build the managed block, or '' when there's nothing to point at. */
function buildBlock(root: string): string {
  const hasKnowledge = hasMarkdown(path.join(testingDirFor(root), 'knowledge'))
  const hasOverview = hasMarkdown(path.join(testingDirFor(root), 'overview'))
  const hasMemory = hasMarkdown(path.join(testingDirFor(root), 'memory'), ['memory.md'])
  const hasEnvironments = fs.existsSync(path.join(testingDirFor(root), 'environments.md'))
  const projectId = projectIdForRoot(root)
  const hasAuthenticators = !!projectId && hasTotp(projectId)
  if (!hasKnowledge && !hasOverview && !hasMemory && !hasEnvironments && !hasAuthenticators) {
    return ''
  }

  const lines = ['## Project context (managed by QC Portal)', '']
  lines.push(
    'Before doing QC work in this project, consult the structured context below — ' +
      'this keeps standing guidance out of this file.',
  )
  lines.push('')
  if (hasEnvironments) {
    lines.push(
      '- **Environments & test accounts** — app URLs and login credentials in ' +
        '`testing/environments.md`. Use these exact URLs and accounts for any login or ' +
        'setup step instead of inventing placeholders.',
    )
  }
  if (hasAuthenticators && projectId) {
    // Production-like environments have no fixed OTP — the six digits come from an
    // authenticator app. The portal holds the enrollment secret and can compute the
    // same code the phone shows, so the run fetches it instead of guessing or stalling.
    const labels = listTotp(projectId)
      .map((e) => `\`${e.label}\`${e.username ? ` (${e.username})` : ''}`)
      .join(', ')
    lines.push(
      '- **Two-factor / OTP codes** — accounts marked as using an authenticator app have ' +
        '**no fixed OTP**; never invent or reuse one. Get the real current code with ' +
        '`curl -s "http://127.0.0.1:' +
        PORT +
        '/api/accounts/totp/<label>/code?projectId=' +
        projectId +
        '"` → `{"code":"123456","expiresIn":18}`. Available labels: ' +
        labels +
        '. Submit it immediately (it expires in `expiresIn` seconds), fetch a fresh one if ' +
        'rejected, and never write a code into a report, note, or screenshot.',
    )
  }
  if (hasOverview) {
    lines.push(
      '- **Overview documents** — what this project IS: the product/spec documents the QC ' +
        'engineer uploaded, one file each in `testing/overview/*.md`. Read them to get the ' +
        'real feature names, flows and rules right.',
    )
  }
  if (hasKnowledge) {
    lines.push(
      '- **Knowledge** — reference docs in `testing/knowledge/*.md` ' +
        '(specs, requirements, domain notes uploaded by the QC engineer).',
    )
  }
  if (hasMemory) {
    lines.push(
      '- **Memory** — durable facts in `testing/memory/*.md` ' +
        '(decisions, gotchas, conventions; `testing/memory/MEMORY.md` indexes them).',
    )
  }
  return `${BEGIN}\n${lines.join('\n')}\n${END}`
}

/**
 * Strip any existing managed block (and the blank lines hugging it) from CLAUDE.md
 * text, returning the engineer-authored remainder.
 */
function stripBlock(text: string): string {
  const begin = text.indexOf(BEGIN)
  if (begin === -1) return text
  const endIdx = text.indexOf(END, begin)
  if (endIdx === -1) return text.slice(0, begin).replace(/\s+$/, '') + '\n'
  const before = text.slice(0, begin).replace(/\s+$/, '')
  const after = text.slice(endIdx + END.length).replace(/^\s+/, '')
  return [before, after].filter(Boolean).join('\n\n') + (after ? '\n' : '\n')
}

/**
 * Re-sync the managed context pointer in <root>/CLAUDE.md to reflect the current
 * Knowledge/Memory folders. Idempotent: no write when the file is already correct.
 * Creates CLAUDE.md if it's missing but there's content to point at; never deletes
 * the file (only removes the managed block) when the folders go empty.
 */
export function syncContextPointer(root: string): void {
  const file = path.join(root, 'CLAUDE.md')
  let existing = ''
  try {
    existing = fs.readFileSync(file, 'utf8')
  } catch {
    existing = '' // no CLAUDE.md yet
  }

  const body = stripBlock(existing).replace(/\s+$/, '')
  const block = buildBlock(root)

  let next: string
  if (!block) {
    next = body ? `${body}\n` : ''
  } else if (!body) {
    next = `${block}\n`
  } else {
    next = `${body}\n\n${block}\n`
  }

  // Don't create an empty CLAUDE.md just to remove a block that never existed.
  if (next === existing) return
  if (!next && !fs.existsSync(file)) return

  if (!next) {
    // Folders emptied and the file would be blank — leave just a trailing newline
    // rather than an unexpected empty file only if the file already existed.
    fs.writeFileSync(file, '', 'utf8')
    return
  }
  fs.writeFileSync(file, next, 'utf8')
}
