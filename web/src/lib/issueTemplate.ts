/**
 * The project's ClickUp issue template — how a QC run's issue is WORDED when it is
 * filed as a ClickUp subtask (Run detail → Issues).
 *
 * Stored like every other project template, at `testing/templates/clickup-issue.md`
 * (key `ISSUE_TEMPLATE_KEY`), and edited on /templates. It is rendered HERE, in the
 * browser, not on the server: the Issues tab has to show the exact card it is about
 * to create before the button is pressed (the same rule `ClickupFilingBar` follows for
 * the inherited fields), and a preview rendered by a second implementation is a
 * preview of something else. The server receives the finished title + body.
 *
 * The syntax is a deliberately small Mustache subset, because the people writing it
 * are QC engineers, not template authors:
 *
 *   {{name}}                 the field's text ('' when the issue has none)
 *   {{#name}} … {{/name}}    kept only when the field has a value
 *   {{^name}} … {{/name}}    kept only when it is EMPTY
 *
 * An optional front-matter block sets the card's NAME (one line):
 *
 *   ---
 *   title: {{#severity}}[{{severity}}] {{/severity}}{{title}}
 *   ---
 *
 * Everything after it is the card's Markdown body. No front matter → the name stays
 * the issue heading as written (the pre-template behaviour).
 *
 * No template saved at all → nothing here runs and the issue is filed exactly as it
 * was before templates existed (`legacy` wording in RunDetailPage).
 */
import { priorityFromSeverity } from './clickup-filing'

export const ISSUE_TEMPLATE_KEY = 'clickup-issue'

/** ClickUp caps a task name at 255; the server slices the body at 6000. */
const MAX_TITLE = 255
const MAX_BODY = 6000

/** Every placeholder a template may use, with what it holds — drives the editor's
 *  reference list AND the "unknown placeholder" warning, so the two cannot disagree. */
export const ISSUE_TEMPLATE_VARS = [
  { name: 'title', description: 'Short issue summary, without the ISSUE-n id or the [Severity]/[Layer] tags' },
  { name: 'id', description: 'The run-local id, e.g. ISSUE-3' },
  { name: 'heading', description: 'The issue heading exactly as the run wrote it' },
  { name: 'severity', description: 'Severity as written — High / Medium / Low …' },
  { name: 'priority', description: 'The ClickUp priority that severity files as (Urgent / High / Normal / Low)' },
  { name: 'layer', description: 'Functional / Content / UI, when the run recorded one' },
  { name: 'ac', description: 'The AC / test case the issue was found on' },
  { name: 'steps', description: 'Numbered steps to reproduce' },
  { name: 'expected', description: 'Expected behaviour' },
  { name: 'actual', description: 'Actual (observed) behaviour' },
  { name: 'notes', description: 'Any other fields the run wrote for this issue' },
  { name: 'screenshots', description: 'Bulleted list of the screenshot file names (the images themselves are attached and commented automatically)' },
  { name: 'screenshot_count', description: 'How many screenshots the issue has' },
  { name: 'body', description: 'The whole issue text as the run wrote it (minus the AC and Screenshot lines)' },
  { name: 'structured', description: 'Non-empty when steps / expected / actual were found — use {{^structured}}{{body}}{{/structured}} as a fallback' },
  { name: 'ticket', description: 'The run’s ticket id' },
  { name: 'environment', description: 'Environment line from issues.md, else the tested URL' },
  { name: 'app_url', description: 'The URL the run tested' },
  { name: 'run_date', description: 'Run date from issues.md' },
  { name: 'date', description: 'Today (the filing date), YYYY-MM-DD' },
] as const

export type IssueVarName = (typeof ISSUE_TEMPLATE_VARS)[number]['name']
export type IssueVars = Record<IssueVarName, string>

const KNOWN = new Set<string>(ISSUE_TEMPLATE_VARS.map((v) => v.name))

// ---- Parsing an issues.md section into fields --------------------------------

/** Pull "[Severity: Low]" style tags out of a heading. */
const TAG_RE = /\[\s*([A-Za-z][\w /-]*?)\s*:\s*([^\]]+?)\s*\]/g
/** "ISSUE-3", "Issue #3", "DEFECT 3" at the start of a heading. */
const ID_RE = /^\s*((?:issue|defect)[-\s#]*\d+)\s*(?:[—–:|-]+\s*)?/i
/** A field line: `- **Label:** value`, `**Label**: value`, or `- Label: value` for a known label. */
const BOLD_FIELD_RE = /^(\s*)(?:[-*+]\s+)?\*\*\s*([^*]+?)\s*:?\s*\*\*\s*:?\s*(.*)$/
const PLAIN_FIELD_RE = /^(\s*)[-*+]\s+([A-Za-z][\w /()]{1,40}?)\s*:\s*(.*)$/

type FieldKind = 'ac' | 'steps' | 'expected' | 'actual' | 'screenshot' | 'severity' | 'layer'

function classifyLabel(label: string): FieldKind | null {
  const l = label.toLowerCase().replace(/\(.*?\)/g, '').trim()
  if (/^(ac|acs|acceptance|test\s*case|tc|case)\b/.test(l)) return 'ac'
  if (/\bsteps?\b|repro/.test(l)) return 'steps'
  if (/^expected/.test(l)) return 'expected'
  if (/^(actual|observed)/.test(l)) return 'actual'
  if (/screenshot|evidence|attachment/.test(l)) return 'screenshot'
  if (/severity|impact|priority/.test(l)) return 'severity'
  if (/^(layer|category)\b/.test(l)) return 'layer'
  return null
}

/** Remove the common leading indentation of a multi-line value. */
function dedent(lines: string[]): string {
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines
    .map((l) => l.slice(cut).trimEnd())
    .join('\n')
    .trim()
}

function cleanInline(value: string): string {
  return value.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim()
}

function capitalize(word: string): string {
  return word ? word[0].toUpperCase() + word.slice(1) : word
}

export interface IssueSectionFields {
  id: string
  title: string
  severity: string
  layer: string
  ac: string
  steps: string
  expected: string
  actual: string
  notes: string
}

/**
 * Split one `## ISSUE-n — …` section (its raw heading + body lines) into the fields a
 * template can place. Anything that isn't a recognised field is kept, verbatim, in
 * `notes` — a template must never silently drop what the run wrote.
 */
export function parseIssueSection(rawHeading: string, body: string[]): IssueSectionFields {
  const fields: IssueSectionFields = {
    id: '',
    title: '',
    severity: '',
    layer: '',
    ac: '',
    steps: '',
    expected: '',
    actual: '',
    notes: '',
  }

  // Heading: "ISSUE-1 — Short title  [Severity: Low]  [Layer: Functional]"
  let heading = rawHeading.replace(/`/g, '').replace(/\*\*/g, '')
  for (const m of heading.matchAll(TAG_RE)) {
    const kind = classifyLabel(m[1])
    if (kind === 'severity') fields.severity = cleanInline(m[2])
    else if (kind === 'layer') fields.layer = cleanInline(m[2])
  }
  heading = heading.replace(TAG_RE, ' ')
  const id = heading.match(ID_RE)
  if (id) {
    fields.id = id[1].replace(/\s*#\s*/, '-').replace(/\s+/g, '-').toUpperCase()
    heading = heading.slice(id[0].length)
  }
  fields.title = heading.replace(/^[\s—–:|-]+/, '').replace(/\s+/g, ' ').trim()

  // Body: field lines open a field; deeper-indented / unlabelled lines continue it.
  const notes: string[] = []
  let current: { kind: FieldKind | null; label: string; lines: string[]; raw: string[] } | null =
    null
  const flush = () => {
    if (!current) return
    const value = dedent(current.lines)
    if (current.kind && current.kind !== 'screenshot') {
      const k = current.kind
      const v = k === 'severity' || k === 'layer' || k === 'ac' ? cleanInline(value) : value
      // A severity in the heading tag wins; the body copy only fills a gap.
      if (!fields[k]) fields[k] = v
    } else if (!current.kind) {
      notes.push(...current.raw)
    }
    current = null
  }

  for (const line of body) {
    const bold = line.match(BOLD_FIELD_RE)
    const plain = bold ? null : line.match(PLAIN_FIELD_RE)
    const m = bold ?? (plain && classifyLabel(plain[2]) ? plain : null)
    // Only a TOP-level bullet opens a field; an indented "**Note:**" inside the steps
    // list belongs to the steps.
    if (m && m[1].length < 2) {
      flush()
      current = { kind: classifyLabel(m[2]), label: m[2], lines: [m[3]], raw: [line] }
      continue
    }
    if (current) {
      current.lines.push(line)
      current.raw.push(line)
    } else if (line.trim()) {
      notes.push(line)
    }
  }
  flush()

  if (fields.severity) fields.severity = capitalize(fields.severity.split(/[\s|/,]+/)[0])
  fields.notes = dedent(notes)
  return fields
}

/** The `> Environment: … Run date … Screenshots in …` line at the top of issues.md. */
export function parseIssuesPreamble(md: string): { environment: string; runDate: string } {
  const quote = md
    .split('\n')
    .filter((l) => /^\s*>/.test(l))
    .map((l) => l.replace(/^\s*>\s?/, ''))
    .join(' ')
  const runDate = quote.match(/run\s*date\s*:?\s*(\d{4}-\d{2}-\d{2})/i)?.[1] ?? ''
  let environment = quote.split(/\.\s+run\s*date/i)[0] ?? ''
  environment = environment
    .replace(/^\s*environment\s*:\s*/i, '')
    .replace(/\.\s*screenshots?\s+in\b.*$/i, '')
    .replace(/\.\s*$/, '')
    .trim()
  return { environment: environment.length > 200 ? '' : environment, runDate }
}

// ---- Rendering --------------------------------------------------------------

const SECTION_RE = /\{\{\s*([#^])\s*([a-z_]+)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/
const VAR_RE = /\{\{\s*([a-z_]+)\s*\}\}/g
/** A section tag alone on its line takes the line break with it, like Mustache's
 *  "standalone" rule — otherwise every {{#x}} line leaves a blank line behind. */
const STANDALONE_RE = /^[ \t]*(\{\{\s*[#^/]\s*[a-z_]+\s*\}\})[ \t]*\r?\n/gm

function renderText(text: string, vars: Partial<Record<string, string>>): string {
  let out = text.replace(STANDALONE_RE, '$1')
  // Leftmost section first, repeatedly — handles nesting of DIFFERENT names.
  for (let guard = 0; guard < 500; guard++) {
    const m = out.match(SECTION_RE)
    if (!m || m.index === undefined) break
    const has = (vars[m[2]] ?? '').trim().length > 0
    const keep = m[1] === '#' ? has : !has
    out = out.slice(0, m.index) + (keep ? m[3] : '') + out.slice(m.index + m[0].length)
  }
  return out.replace(VAR_RE, (_all, name: string) => vars[name] ?? '')
}

/** Split off the optional front matter. Only `title:` is read. */
export function splitIssueTemplate(template: string): { title: string | null; body: string } {
  const text = template.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  const m = text.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/)
  if (!m) return { title: null, body: text }
  const title = m[1]
    .split('\n')
    .map((l) => l.match(/^\s*title\s*:\s*(.*)$/i)?.[1])
    .find((v) => v !== undefined)
  return { title: title?.trim() || null, body: text.slice(m[0].length) }
}

/**
 * Problems worth showing the author before they save: a placeholder nobody fills (a
 * typo renders as nothing, silently), or a section that is opened but never closed
 * (renders its tags as literal text on the card).
 */
export function issueTemplateProblems(
  template: string,
): { text: string; blocking: boolean }[] {
  const problems: { text: string; blocking: boolean }[] = []
  const unknown = new Set<string>()
  for (const m of template.matchAll(/\{\{\s*[#^/]?\s*([A-Za-z_][\w-]*)\s*\}\}/g)) {
    if (!KNOWN.has(m[1])) unknown.add(m[1])
  }
  if (unknown.size) {
    problems.push({
      text: `Unknown placeholder${unknown.size === 1 ? '' : 's'}: ${[...unknown].map((n) => `{{${n}}}`).join(', ')} — ${unknown.size === 1 ? 'it renders' : 'they render'} as nothing.`,
      blocking: false,
    })
  }
  const opened = new Map<string, number>()
  for (const m of template.matchAll(/\{\{\s*([#^/])\s*([a-z_]+)\s*\}\}/g)) {
    const n = m[2]
    opened.set(n, (opened.get(n) ?? 0) + (m[1] === '/' ? -1 : 1))
  }
  const unbalanced = [...opened].filter(([, n]) => n !== 0).map(([name]) => name)
  if (unbalanced.length) {
    // Blocking: the stray tag would be filed onto a real card as literal text.
    problems.push({
      text: `Section${unbalanced.length === 1 ? '' : 's'} not closed or not opened: ${unbalanced.map((n) => `{{#${n}}}…{{/${n}}}`).join(', ')}.`,
      blocking: true,
    })
  }
  if (!splitIssueTemplate(template).body.trim()) {
    problems.push({ text: 'The body is empty — the card would have no description.', blocking: true })
  }
  return problems
}

/** Render a template against one issue's fields → the card ClickUp will receive. */
export function renderIssueTemplate(
  template: string,
  vars: IssueVars,
  fallbackTitle: string,
): { title: string; description: string } {
  const { title, body } = splitIssueTemplate(template)
  const name = title ? renderText(title, vars).replace(/\s+/g, ' ').trim() : ''
  const description = renderText(body, vars)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    // A dangling rule (every footer field was empty) is noise on the card.
    .replace(/\n+(?:-{3,}|\*{3,})\s*$/, '')
    .trim()
  return {
    title: (name || fallbackTitle).slice(0, MAX_TITLE),
    description: description.slice(0, MAX_BODY),
  }
}

/** Assemble every placeholder's value for one issue. */
export function buildIssueVars(input: {
  heading: string
  legacyTitle: string
  fields: IssueSectionFields
  severity: string | null
  body: string
  screenshots: string[]
  ticket: string
  appUrl: string
  environment: string
  runDate: string
  today?: Date
}): IssueVars {
  const f = input.fields
  const severity = f.severity || (input.severity ? capitalize(input.severity) : '')
  const d = input.today ?? new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    title: f.title || input.legacyTitle,
    id: f.id,
    heading: input.heading.replace(/\s+/g, ' ').trim(),
    severity,
    priority: priorityFromSeverity(severity || null) ?? '',
    layer: f.layer,
    ac: f.ac,
    steps: f.steps,
    expected: f.expected,
    actual: f.actual,
    notes: f.notes,
    screenshots: input.screenshots.map((s) => `- ${s.split('/').pop()}`).join('\n'),
    screenshot_count: input.screenshots.length ? String(input.screenshots.length) : '',
    body: input.body,
    structured: f.steps || f.expected || f.actual ? 'yes' : '',
    ticket: input.ticket,
    environment: input.environment || input.appUrl,
    app_url: input.appUrl,
    run_date: input.runDate,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  }
}

/** A realistic issue the /templates editor previews against. */
export const SAMPLE_ISSUE_VARS: IssueVars = buildIssueVars({
  heading: 'ISSUE-2 — Save button stays enabled after a failed submit  [Severity: High]  [Layer: Functional]',
  legacyTitle: 'ISSUE-2 — Save button stays enabled after a failed submit Severity: High Layer: Functional',
  fields: parseIssueSection(
    'ISSUE-2 — Save button stays enabled after a failed submit  [Severity: High]  [Layer: Functional]',
    [
      '- **AC / Case:** AC3 — TC-07',
      '- **Steps to reproduce:**',
      '  1. Open Settings → Profile',
      '  2. Clear the required "Email" field',
      '  3. Click Save twice',
      '- **Expected (per AC):** "Email is required" shows and Save is disabled until the field is valid.',
      '- **Actual:** The error shows, but Save stays enabled and a second click sends a duplicate request.',
      '- **Screenshot:** `screenshots/ISSUE-profile-save.png`',
    ],
  ),
  severity: 'high',
  body: [
    '- **Steps to reproduce:**',
    '  1. Open Settings → Profile',
    '  2. Clear the required "Email" field',
    '  3. Click Save twice',
    '- **Expected (per AC):** "Email is required" shows and Save is disabled until the field is valid.',
    '- **Actual:** The error shows, but Save stays enabled and a second click sends a duplicate request.',
  ].join('\n'),
  screenshots: ['screenshots/ISSUE-profile-save.png'],
  ticket: 'profile-settings',
  appUrl: 'https://staging.example.com/',
  environment: 'Staging — https://staging.example.com/',
  runDate: '2026-09-30',
})
