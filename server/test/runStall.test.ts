import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The QC-run idle watchdog (src/claude.ts): a CLI that goes silent is stopped as
// stalled instead of hanging until someone notices. Separate file because the idle
// threshold is read from the environment at import time.
// Run with `npm -w server test`.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-stall-'))
const FAKE = path.join(TMP, 'fake-claude.mjs')
// Prints its init line, then never says anything again.
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
process.stdin.resume()
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }) + '\\n')
  setInterval(() => {}, 1000)
})
`,
)
fs.chmodSync(FAKE, 0o755)

process.env.QC_DB_PATH = path.join(TMP, 'db', 'qc.db')
process.env.QC_CLAUDE_BIN = FAKE
process.env.QC_RUN_IDLE_MINUTES = '0.01' // 600ms

const { createProject, getEvents, getRun } = await import('../src/db.ts')
const rm = await import('../src/runManager.ts')

test('a silent run is warned, then stopped as stalled', async () => {
  const root = path.join(TMP, 'proj')
  fs.mkdirSync(root, { recursive: true })
  const project = createProject('Stall test', root)
  const run = rm.startRun({
    projectId: project.id,
    ticketId: 'T-STALL',
    appUrl: 'https://example.test',
    testTarget: 'web',
  })
  const end = Date.now() + 10_000
  while (getRun(run.id)?.status === 'running') {
    if (Date.now() > end) throw new Error('watchdog never stopped the run')
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(getRun(run.id)?.status, 'error')
  const texts = getEvents(run.id).map((e) => e.text)
  assert.ok(texts.some((t) => /No activity from the AI/.test(t)), 'half-time warning')
  assert.ok(texts.some((t) => /Run stopped: no activity from the AI/.test(t)), 'stall error')
})
