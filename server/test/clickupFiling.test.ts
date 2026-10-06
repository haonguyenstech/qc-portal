import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'

// Filing QC issues to ClickUp (POST /api/clickup/issues/subtasks) under the project's
// filing preferences — inherit the parent's assignees or not, screenshots as a comment or
// inside the description. A team patched these into their install and lost the patch on
// the next update, so they are per-project settings now. ClickUp and imgbb are faked at
// `fetch`; nothing leaves the machine. Run with `npm -w server test`.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-filing-'))
process.env.QC_DB_PATH = path.join(TMP, 'db', 'qc.db')
process.env.IMGBB_API_KEY = 'imgbb-test-key'

const express = (await import('express')).default
const { createProject, updateProject } = await import('../src/db.ts')
const { clickupRouter } = await import('../src/routes/clickup.ts')

// ---- a project with a ClickUp token and one run screenshot ---------------------------
const root = path.join(TMP, 'proj')
fs.mkdirSync(path.join(root, 'testing', 'test-result', 'T1-run', 'screenshots'), { recursive: true })
fs.writeFileSync(path.join(root, 'testing', 'test-result', 'T1-run', 'screenshots', 'bug.png'), 'png')
fs.writeFileSync(
  path.join(root, '.mcp.json'),
  JSON.stringify({ mcpServers: { clickup: { command: 'x', env: { CLICKUP_API_KEY: 'pk_test' } } } }),
)
const project = createProject('Filing', root)

// ---- fake ClickUp + imgbb ----------------------------------------------------------
interface Call {
  url: string
  method: string
  body: any
}
let calls: Call[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  if (!/api\.clickup\.com|api\.imgbb\.com/.test(url)) return realFetch(input, init)
  const method = init?.method ?? 'GET'
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
  calls.push({ url, method, body })
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
  if (url.includes('imgbb')) return json({ success: true, data: { url: 'https://i.ibb.co/x/bug.png' } })
  if (/\/task\/PARENT1$/.test(url)) {
    return json({
      id: 'PARENT1',
      name: 'Parent',
      url: 'https://app.clickup.com/t/PARENT1',
      list: { id: 'L1', name: 'List' },
      assignees: [{ id: 42, username: 'Vinh Ngo' }],
      tags: [],
    })
  }
  if (/\/list\/L1\/task$/.test(url)) {
    return json({ id: 'NEW1', name: body.name, url: 'u', assignees: body.assignees ? [{ id: 42, username: 'Vinh Ngo' }] : [] })
  }
  if (/\/task\/NEW1\/comment$/.test(url)) return json({ id: 'c1' })
  return new Response('{}', { status: 404 })
}) as typeof fetch

const app = express()
app.use(express.json())
app.use('/api/clickup', clickupRouter)
const server = app.listen(0, '127.0.0.1')
await new Promise((r) => server.once('listening', r))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
test.after(() => server.close())

async function file() {
  calls = []
  const res = await realFetch(`${base}/api/clickup/issues/subtasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      parentTask: 'PARENT1',
      slug: 'T1-run',
      issues: [{ title: 'Button is cut off', description: 'It is cut off.', screenshots: ['screenshots/bug.png'] }],
    }),
  })
  assert.equal(res.status, 201, await res.clone().text())
  const out = (await res.json()) as { created: { applied: Record<string, unknown> }[] }
  const create = calls.find((c) => /\/list\/L1\/task$/.test(c.url))!
  return {
    applied: out.created[0].applied,
    create,
    order: calls.map((c) => (c.url.includes('imgbb') ? 'imgbb' : c.url.replace(/.*api\/v2/, ''))),
    commented: calls.some((c) => /\/comment$/.test(c.url)),
  }
}

test('default: the parent assignee is inherited and the screenshot is posted as a comment', async () => {
  const r = await file()
  assert.deepEqual(r.create.body.assignees, [42])
  assert.ok(!r.create.body.markdown_content.includes('i.ibb.co'))
  assert.equal(r.commented, true)
  assert.equal(r.applied.commented, true)
  assert.equal(r.applied.evidenceInDescription, false)
  assert.equal(r.applied.assigneesSkipped, false)
})

test('the project can file unassigned with the evidence inside the description', async () => {
  updateProject(project.id, { clickupInheritAssignees: false, clickupEvidence: 'description' })
  const r = await file()
  assert.equal(r.create.body.assignees, undefined)
  assert.match(r.create.body.markdown_content, /It is cut off\.[\s\S]*!\[bug\.png\]\(https:\/\/i\.ibb\.co\/x\/bug\.png\)/)
  // Uploaded BEFORE the card exists, so the link can be in it; and no comment at all.
  assert.ok(r.order.indexOf('imgbb') < r.order.indexOf('/list/L1/task'))
  assert.equal(r.commented, false)
  assert.equal(r.applied.evidenceInDescription, true)
  assert.equal(r.applied.assigneesSkipped, true)
  assert.equal(r.applied.screenshots, 1)
})

test('filing-context reports the project preferences for the preview', async () => {
  const res = await realFetch(`${base}/api/clickup/issues/filing-context?parent=PARENT1&projectId=${project.id}`)
  const ctx = (await res.json()) as { settings: Record<string, unknown> }
  assert.deepEqual(ctx.settings, { inheritAssignees: false, evidence: 'description', imgbb: true })
})
