import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

/**
 * /chat: when the engineer asks the assistant to CREATE a ClickUp ticket / bug, hand it
 * the project's ClickUp issue template (`testing/templates/clickup-issue.md`, edited on
 * /templates) so a card filed from chat is worded exactly like one filed from Run →
 * Issues.
 *
 * In Run → Issues the portal renders the template itself (web/src/lib/issueTemplate.ts)
 * and sends the finished card. In chat the MODEL creates the card through the ClickUp
 * MCP, so here the template travels as instructions: the text, what each placeholder
 * means, and the section rules. The placeholder list below MIRRORS `ISSUE_TEMPLATE_VARS`
 * in that web module — keep the two in step.
 *
 * Only on a turn that looks like a create request (`wantsTrackerCreate`): the block is
 * ~2 KB and a question about a test case has no use for it. A follow-up such as "ok,
 * go" in the same conversation still has it, because the CLI session carries the
 * earlier turn. No template saved → no block, and chat files the way it always did.
 */

const TEMPLATE_KEY = 'clickup-issue'
const MAX_TEMPLATE_CHARS = 8_000

/** One line per placeholder — what the model must fill it with. */
const VARS: [string, string][] = [
  ['title', 'short summary of the bug, no id, no [Severity]/[Layer] tags'],
  ['id', 'the issue id from a run (e.g. ISSUE-3), else empty'],
  ['heading', 'the issue heading as written in the source, else the title'],
  ['severity', 'High / Medium / Low (or Critical/Blocker) — from the source, never invented'],
  ['priority', 'ClickUp priority for that severity: blocker/critical→Urgent, high→High, medium→Normal, low→Low'],
  ['layer', 'Functional / Content / UI when known'],
  ['ac', 'the AC / test case it was found on'],
  ['steps', 'numbered steps to reproduce, one per line ("1. …")'],
  ['expected', 'expected behaviour, quoted from the ticket/AC when possible'],
  ['actual', 'actual observed behaviour'],
  ['notes', 'any other relevant detail'],
  ['screenshots', 'bulleted list of screenshot file names'],
  ['screenshot_count', 'number of screenshots'],
  ['body', 'the whole issue text as written in the source'],
  ['structured', 'non-empty when steps / expected / actual are known'],
  ['ticket', 'the run / ticket id the issue came from'],
  ['environment', 'environment name + URL tested'],
  ['app_url', 'the URL tested'],
  ['run_date', 'date the issue was observed (YYYY-MM-DD)'],
  ['date', "today's date (YYYY-MM-DD)"],
]

const CREATE_VERB =
  /\b(create|file|post|log|raise|open|submit|report|add|push|make)\b|tạo|đăng|đẩy|báo|ghi|thêm|mở|log lên|post lên/i
const TRACKER_NOUN =
  /clickup|click up|\b(ticket|task|subtask|sub-task|bug|issue|defect|card)s?\b|lỗi|thẻ/i

/** Does this message ask for something to be created in the tracker? Liberal on purpose:
 *  a missed match files a card in the model's own wording, an extra one costs ~2 KB. */
export function wantsTrackerCreate(prompt: string): boolean {
  return CREATE_VERB.test(prompt) && TRACKER_NOUN.test(prompt)
}

export function readIssueTemplate(root: string): string | null {
  try {
    const text = fs.readFileSync(path.join(testingDirFor(root), 'templates', `${TEMPLATE_KEY}.md`), 'utf8')
    return text.trim() ? text.slice(0, MAX_TEMPLATE_CHARS) : null
  } catch {
    return null
  }
}

/** The prompt block, or '' when the turn isn't a create request or no template is saved. */
export function issueTemplateBlock(root: string, prompt: string): string {
  if (!wantsTrackerCreate(prompt)) return ''
  const template = readIssueTemplate(root)
  if (!template) return ''
  return (
    `\n\n--- CLICKUP ISSUE TEMPLATE (testing/templates/${TEMPLATE_KEY}.md) ---\n` +
    `This project words every bug / issue card it files to ClickUp with the template below. ` +
    `If this turn creates a ClickUp task or subtask for a bug, issue or defect, word it with ` +
    `this template — do not invent your own layout. (A non-bug task, e.g. a story or a ` +
    `chore, is not covered: ignore the template for it.)\n` +
    `How to apply it:\n` +
    `- The \`title:\` line inside the leading \`---\` block is the task NAME (one line). ` +
    `Everything after that block is the task DESCRIPTION, in Markdown — send it in the ` +
    `create tool's markdown description field when it has one.\n` +
    `- \`{{name}}\` → that field's value. \`{{#name}}…{{/name}}\` → keep the inside only when ` +
    `the field has a value; \`{{^name}}…{{/name}}\` → keep it only when the field is EMPTY. ` +
    `Drop a line whose placeholder is empty rather than leaving a dangling label.\n` +
    `- The finished name and description must contain NO \`{{…}}\` tags.\n` +
    `- Fill fields only from what you actually read in this conversation or the project ` +
    `(a run's issues.md, the ticket, the user's words). A field you have no source for is ` +
    `EMPTY — never make up steps, an expected result or a severity to fill the template.\n` +
    `- Set the task's priority from the severity with the {{priority}} mapping below.\n` +
    `- After creating, reply with the task link and the exact name you filed.\n` +
    `Placeholders:\n` +
    VARS.map(([n, d]) => `  {{${n}}} — ${d}`).join('\n') +
    `\nTemplate:\n\`\`\`markdown\n${template.trimEnd()}\n\`\`\``
  )
}
