import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { chatAssets, type Chat } from '../src/routes/chat.ts'

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-assets-'))
  fs.mkdirSync(path.join(dir, 'testing', 'out'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'testing', 'out', 'cases.md'), '# cases\n')
  return dir
}

function chat(messages: Chat['messages']): Chat {
  return { slug: 'c', title: 't', createdAt: '', updatedAt: '', messages } as unknown as Chat
}

test('lists uploads, images and the files the answers wrote — Reads are not "made by the AI"', () => {
  const root = project()
  const abs = path.join(root, 'testing', 'out', 'cases.md')
  const a = chatAssets(
    root,
    chat([
      { role: 'user', text: 'q', at: '1', files: [{ file: 'x.md', name: 'spec.pdf' }], images: ['a.png'] },
      {
        role: 'assistant',
        text: 'a',
        at: '2',
        steps: [
          { name: 'Read', detail: 'spec.md', pos: 0, path: path.join(root, 'spec.md') },
          { name: 'Write', detail: 'cases.md', pos: 0, path: abs },
        ],
      },
      { role: 'user', text: 'q2', at: '3' },
      { role: 'assistant', text: 'b', at: '4', steps: [{ name: 'Edit', detail: 'cases.md', pos: 0, path: abs }] },
    ]),
  )
  assert.deepEqual(a.uploads.map((u) => [u.name, u.index, u.exists]), [['spec.pdf', 0, false]])
  assert.deepEqual(a.images.map((i) => i.file), ['a.png'])
  assert.equal(a.written.length, 1, 'one file, written then edited, is ONE row')
  const w = a.written[0]
  assert.equal(w.path, 'testing/out/cases.md')
  assert.deepEqual(w.tools, ['Write', 'Edit'])
  assert.equal(w.index, 3, 'jumps to the LAST answer that touched it')
  assert.equal(w.question, 2, '…anchored on the question that answer replied to')
  assert.deepEqual(a.questions, { 0: 'q', 2: 'q2' })
  assert.equal(w.inProject, true)
  assert.equal(w.exists, true)
})

test('a pre-attachments message lists its pasted files as legacy uploads', () => {
  const root = project()
  const a = chatAssets(
    root,
    chat([{ role: 'user', text: 'q\n\n--- ATTACHED FILE: a.pdf ---\nx\n\n--- ATTACHED FILE: b.csv ---\ny', at: '1' }]),
  )
  assert.deepEqual(a.uploads.map((u) => [u.name, u.legacy, u.text]), [['a.pdf', true, 'x'], ['b.csv', true, 'y']])
})

test('a write outside the project is listed but never marked servable', () => {
  const root = project()
  const outside = path.join(os.tmpdir(), 'elsewhere.txt')
  const a = chatAssets(
    root,
    chat([
      { role: 'assistant', text: 'a', at: '1', steps: [{ name: 'Write', pos: 0, path: outside }] },
      { role: 'assistant', text: 'b', at: '2', steps: [{ name: 'Write', pos: 0, path: path.join(root, '..', 'x.md') }] },
    ]),
  )
  assert.equal(a.written.length, 2)
  assert.ok(a.written.every((w) => !w.inProject))
})
