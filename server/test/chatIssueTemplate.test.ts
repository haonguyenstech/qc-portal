import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { issueTemplateBlock, wantsTrackerCreate } from '../src/chatIssueTemplate.ts'

function project(template: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-issue-tpl-'))
  if (template !== null) {
    fs.mkdirSync(path.join(dir, 'testing', 'templates'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'testing', 'templates', 'clickup-issue.md'), template)
  }
  return dir
}

test('recognises a create request in English and Vietnamese, not a plain question', () => {
  assert.ok(wantsTrackerCreate('create a ClickUp bug for ISSUE-2'))
  assert.ok(wantsTrackerCreate('tạo ticket trên clickup cho lỗi này'))
  assert.ok(wantsTrackerCreate('log bug lên clickup giúp mình'))
  assert.ok(wantsTrackerCreate('file these issues as subtasks under 86eut664j'))
  assert.equal(wantsTrackerCreate('how many test cases does TC-login have?'), false)
  assert.equal(wantsTrackerCreate('tóm tắt report của run này'), false)
})

test('injects the saved template only on a create request', () => {
  const root = project('---\ntitle: [{{severity}}] {{title}}\n---\n**Steps:**\n{{steps}}\n')
  const block = issueTemplateBlock(root, 'tạo bug trên clickup cho ISSUE-1')
  assert.match(block, /CLICKUP ISSUE TEMPLATE/)
  assert.match(block, /title: \[\{\{severity\}\}\] \{\{title\}\}/)
  assert.match(block, /\{\{steps\}\} — /)
  assert.equal(issueTemplateBlock(root, 'what does ISSUE-1 say?'), '')
})

test('no template saved (or an empty one) → no block, chat files as before', () => {
  assert.equal(issueTemplateBlock(project(null), 'create a clickup bug'), '')
  assert.equal(issueTemplateBlock(project('  \n'), 'create a clickup bug'), '')
})
