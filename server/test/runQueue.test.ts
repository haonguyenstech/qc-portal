import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The QC run queue (src/runManager.ts) driven by a FAKE `claude` CLI: an expired AI
// account must HOLD the queue instead of failing every waiting run one by one, resuming
// the queue must drain it, and a finished run must re-run from its own stored request.
// Run with `npm -w server test`.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'run-queue-'))
const MODE = path.join(TMP, 'mode')
const CALLS = path.join(TMP, 'calls.log')
const FAKE = path.join(TMP, 'fake-claude.mjs')

// `auth`  = what a signed-out CLI prints: an is_error result, non-zero exit.
// `ok`    = a run that finished (it writes no report, so it grades as `failed`).
// `hang`  = keeps running until the test lets it go, so later runs stay queued.
fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
import fs from 'node:fs'
let prompt = ''
process.stdin.on('data', (c) => (prompt += c))
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ prompt }) + '\\n')
  const mode = fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim()
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
  out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: 'fake' })
  if (mode === 'auth') {
    out({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' })
    process.exit(1)
  }
  const finish = () => {
    out({ type: 'result', is_error: false, result: 'done' })
    process.exit(0)
  }
  if (mode === 'hang') {
    const t = setInterval(() => {
      if (fs.readFileSync(${JSON.stringify(MODE)}, 'utf8').trim() !== 'hang') {
        clearInterval(t)
        finish()
      }
    }, 50)
    return
  }
  finish()
})
`,
)
fs.chmodSync(FAKE, 0o755)
fs.writeFileSync(MODE, 'ok')

process.env.QC_DB_PATH = path.join(TMP, 'db', 'qc.db')
process.env.QC_CLAUDE_BIN = FAKE

const { createProject, getRun } = await import('../src/db.ts')
const rm = await import('../src/runManager.ts')
const { classifyRunFailure } = await import('../src/claude.ts')

const root = path.join(TMP, 'proj')
fs.mkdirSync(root, { recursive: true })
const project = createProject('Queue test', root)

const setMode = (m: string) => fs.writeFileSync(MODE, m)
const calls = () =>
  fs.existsSync(CALLS)
    ? fs
        .readFileSync(CALLS, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { prompt: string })
    : []

async function until(cond: () => boolean, what: string, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}
const status = (id: string) => getRun(id)?.status

const body = (ticketId: string, extra: Record<string, unknown> = {}) => ({
  projectId: project.id,
  ticketId,
  appUrl: 'https://example.test',
  testTarget: 'web' as const,
  ...extra,
})

test('classifyRunFailure reads the CLI, not the app under test', () => {
  assert.equal(classifyRunFailure('Not logged in · Please run /login')?.kind, 'auth')
  assert.equal(classifyRunFailure('OAuth token has expired. Please obtain a new token')?.kind, 'auth')
  assert.equal(classifyRunFailure('Claude AI usage limit reached|1760000000')?.kind, 'limit')
  assert.equal(classifyRunFailure("You've hit your limit · resets 3pm")?.kind, 'limit')
  assert.equal(classifyRunFailure('API Error: 429 {"type":"rate_limit_error"}')?.kind, 'limit')
  // An app answering 401 is a finding, never a reason to hold the queue.
  assert.equal(classifyRunFailure('GET /api/me returned 401 Unauthorized'), null)
  assert.equal(classifyRunFailure('error_max_turns'), null)
  assert.equal(classifyRunFailure(''), null)
})

test('an expired AI account holds the queue instead of failing every waiting run', async () => {
  setMode('hang')
  const a = rm.startRun(body('T-A'))
  await until(() => calls().length === 1, 'run A spawned')
  const b = rm.startRun(body('T-B'))
  const c = rm.startRun(body('T-C'))
  assert.equal(status(b.id), 'queued')
  assert.equal(status(c.id), 'queued')

  // A finishes; B then starts into a signed-out CLI.
  setMode('auth')
  await until(() => status(b.id) === 'error', 'run B fails on auth')
  assert.equal(status(a.id), 'failed') // finished normally, no report
  // C must NOT have been started into the same wall.
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(status(c.id), 'queued')
  const q = rm.getQueueState()
  assert.equal(q.hold?.kind, 'auth')
  assert.equal(q.hold?.runId, b.id)
  assert.deepEqual(q.queued, [c.id])

  // A run started while held waits too.
  const d = rm.startRun(body('T-D'))
  assert.equal(status(d.id), 'queued')

  // Engineer reconnects and resumes: the queue drains in order.
  setMode('ok')
  assert.equal(rm.resumeQueue(), 2)
  await until(() => status(c.id) === 'failed' && status(d.id) === 'failed', 'queue drained')
  assert.equal(rm.getQueueState().hold, null)
  assert.equal(rm.getQueueState().queued.length, 0)
})

test('a lone auth failure does not hold an empty queue', async () => {
  setMode('auth')
  const e = rm.startRun(body('T-E'))
  await until(() => status(e.id) === 'error', 'run E fails on auth')
  assert.equal(rm.getQueueState().hold, null)
  setMode('ok')
  const f = rm.startRun(body('T-F'))
  assert.equal(status(f.id), 'running') // starts at once, not stuck behind a hold
  await until(() => status(f.id) === 'failed', 'run F finished')
})

test('re-run starts a new run from the stored request', async () => {
  setMode('ok')
  const g = rm.startRun(
    body('T-G', { instructions: 'Use account qa-admin', dataPolicy: 'seed', skill: 'qc-testing' }),
  )
  await until(() => status(g.id) === 'failed', 'run G finished')
  const before = calls().length

  const again = rm.rerunRun(g.id)
  assert.notEqual(again.id, g.id)
  assert.equal(again.ticketId, 'T-G')
  await until(() => status(again.id) === 'failed', 're-run finished')
  const prompt = calls()[before].prompt
  assert.match(prompt, /Use account qa-admin/)
  assert.match(prompt, /AUTHORIZED this run to create the test data/)
  // The original is history and stays as it was.
  assert.equal(status(g.id), 'failed')
})

test('a picked test account reaches the prompt as a label only', async () => {
  setMode('ok')
  const before = calls().length
  const r = rm.startRun(body('T-ACC', { testAccount: 'qa.admin@acme.test (Admin)' }))
  await until(() => status(r.id) === 'failed', 'run finished')
  assert.match(calls()[before].prompt, /TEST ACCOUNT — .*"qa\.admin@acme\.test \(Admin\)"/)
})

test('re-run refuses a run that is still going', async () => {
  setMode('hang')
  const h = rm.startRun(body('T-H'))
  assert.throws(() => rm.rerunRun(h.id), /only a finished run/)
  setMode('ok')
  await until(() => status(h.id) === 'failed', 'run H finished')
})

test('a live mobile run reports the device it is driving, and frees it when done', async () => {
  setMode('hang')
  const m = rm.startRun(body('T-MOB', { testTarget: 'app-mobile', appUrl: 'Demo', deviceId: 'emulator-5554' }))
  await until(() => status(m.id) === 'running', 'mobile run started')
  assert.deepEqual(rm.getQueueState().busyDevices, [
    { runId: m.id, ticketId: 'T-MOB', deviceId: 'emulator-5554' },
  ])
  setMode('ok')
  await until(() => status(m.id) === 'failed', 'mobile run finished')
  assert.deepEqual(rm.getQueueState().busyDevices, [])
})

test('canceling every held run lifts the hold', async () => {
  setMode('hang')
  const a = rm.startRun(body('T-CA'))
  await until(() => status(a.id) === 'running', 'run started')
  const b = rm.startRun(body('T-CB'))
  setMode('auth')
  await until(() => status(a.id) === 'error', 'run fails on auth')
  assert.equal(rm.getQueueState().hold?.kind, 'auth')
  rm.cancelRun(b.id)
  assert.equal(rm.getQueueState().hold, null)
  setMode('ok')
  const c = rm.startRun(body('T-CC'))
  assert.equal(status(c.id), 'running')
  await until(() => status(c.id) === 'failed', 'next run finished')
})
