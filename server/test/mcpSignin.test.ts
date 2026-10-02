import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The MCP page's OAuth "Sign in" job (src/mcpSignin.ts), driven by a FAKE `claude` that
// prints what `claude mcp login --no-browser` printed in a pty on CLI 2.1.281: the
// authorize URL as an OSC 8 hyperlink, the paste prompt, a refusal + re-prompt for a
// URL from the wrong sign-in, and exit 0 once the right one arrives. The success path
// can't be reached against a real provider without a real account, so it is pinned
// here. Run with `npm -w server test`.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-signin-'))
const FAKE = path.join(TMP, 'claude')
const AUTH_URL =
  'https://mcp.example.com/authorize?response_type=code&client_id=abc&code_challenge=xyz' +
  '&redirect_uri=http%3A%2F%2Flocalhost%3A49754%2Fcallback&state=GOOD&resource=https%3A%2F%2Fmcp.example.com%2Fmcp'

// ClickUp's real shape: a ~500-char JWT client id, so the CLI's write reaches the pty
// in more than one chunk — split here mid-`%2F` AND mid-escape-sequence on purpose.
const LONG_URL =
  'https://mcp.clickup.com/oauth/authorize?response_type=code&client_id=mcp-client-' +
  'x'.repeat(420) +
  '&code_challenge=abc&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A50116%2Fcallback&state=GOOD'

fs.writeFileSync(
  FAKE,
  `#!/usr/bin/env node
const [cmd, sub, name] = process.argv.slice(2)
const w = (s) => process.stdout.write(s)
if (cmd !== 'mcp') process.exit(2)
if (sub === 'logout') { w('Signed out of "' + name + '". Run \`claude mcp login ' + name + '\` to authenticate again.\\n'); process.exit(0) }
if (name === 'unapproved') { w('"unapproved" is from .mcp.json and awaiting approval. Run \`claude\` in this directory to review it first.\\n'); process.exit(1) }
;(async () => {
const url = name === 'chunked' ? ${JSON.stringify(LONG_URL)} : ${JSON.stringify(AUTH_URL)}
w('Starting authentication for "' + name + '"\\u2026\\n')
const visit = 'Visit this URL to authorize:\\n  \\x1b]8;;' + url + '\\x1b\\\\' + url + '\\x1b]8;;\\x1b\\\\\\n\\n'
if (name === 'chunked') {
  // Cut inside the visible URL's "%2F", then again inside the closing OSC 8 sequence.
  const a = visit.indexOf('http%3A%', visit.indexOf('\\x1b\\\\')) + 'http%3A%'.length
  const b = visit.lastIndexOf('\\x1b]8;;') + 3
  w(visit.slice(0, a)); await new Promise((r) => setTimeout(r, 300))
  w(visit.slice(a, b)); await new Promise((r) => setTimeout(r, 300))
  w(visit.slice(b))
} else w(visit)
w('Waiting for authorization\\u2026 (^C to cancel)\\n')
const prompt = () => w('Or paste the redirect URL here: ')
prompt()
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (name === 'denied') { w("Couldn't complete authentication for \\"denied\\": access_denied\\n"); process.exit(1) }
  if (line.includes('state=GOOD')) { w('Authentication successful.\\n'); process.exit(0) }
  w("That doesn't look like a redirect URL for this sign-in \\u2014 paste the full address from the browser page this sign-in opened.\\n")
  prompt()
})
})()
`,
  { mode: 0o755 },
)
process.env.QC_CLAUDE_BIN = FAKE

const { startMcpSignin, getMcpSignin, pasteMcpSignin, cancelMcpSignin, runMcpLogout } =
  await import('../src/mcpSignin.ts')

const skip = process.platform === 'win32' ? 'the fake CLI is a shebang script' : false

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 8000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = read()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`timed out; last value: ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

test('reads the OSC 8 URL whole, refuses a wrong paste, succeeds on the right one', { skip }, async () => {
  let successes = 0
  const r = startMcpSignin(TMP, 'p1', 'svc', () => successes++)
  assert.equal(r.ok, true)

  const waiting = await until(() => getMcpSignin('p1', 'svc')!, (j) => j.awaitingPaste)
  assert.equal(waiting.signInUrl, AUTH_URL, 'the visible URL, not eaten by the OSC strip')
  assert.equal(waiting.state, 'running')

  // A second sign-in while one waits would fight over the CLI's callback port.
  const other = startMcpSignin(TMP, 'p1', 'other', () => {})
  assert.equal(other.ok, false)
  if (!other.ok) assert.equal(other.status, 409)
  // …but asking again for the SAME one just returns it.
  assert.equal(startMcpSignin(TMP, 'p1', 'svc', () => {}).ok, true)

  assert.equal(pasteMcpSignin('p1', 'svc', 'not a url').ok, false)
  assert.equal(pasteMcpSignin('p1', 'svc', 'http://localhost:49754/callback?code=TOPSECRET&state=BAD').ok, true)
  const refused = await until(() => getMcpSignin('p1', 'svc')!, (j) => !!j.pasteError && j.awaitingPaste)
  assert.match(refused.pasteError!, /doesn.t look like a redirect URL/)
  assert.ok(!refused.lines.some((l) => l.includes('TOPSECRET')), 'the pasted code is masked')

  assert.equal(pasteMcpSignin('p1', 'svc', 'http://localhost:49754/callback?code=abc&state=GOOD').ok, true)
  const done = await until(() => getMcpSignin('p1', 'svc')!, (j) => j.state !== 'running')
  assert.equal(done.state, 'succeeded')
  assert.equal(done.exitCode, 0)
  assert.equal(successes, 1)
})

test('a URL split across output chunks is read WHOLE (ClickUp: "Invalid redirect_uri")', { skip }, async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-signin-chunked-'))
  assert.equal(startMcpSignin(projectRoot, 'p-chunked', 'chunked', () => {}).ok, true)
  const job = await until(
    () => getMcpSignin('p-chunked', 'chunked'),
    (j) => !!j?.signInUrl && !!j?.awaitingPaste,
  )
  assert.equal(job!.signInUrl, LONG_URL)
  // The log shows it as ONE line too, not two halves.
  assert.ok(job!.lines.some((l) => l.trim() === LONG_URL))
  cancelMcpSignin('p-chunked', 'chunked')
})

test('a failed sign-in reports the CLI’s own reason', { skip }, async () => {
  assert.equal(startMcpSignin(TMP, 'p1', 'denied', () => assert.fail('not a success')).ok, true)
  await until(() => getMcpSignin('p1', 'denied')!, (j) => j.awaitingPaste)
  pasteMcpSignin('p1', 'denied', 'http://localhost:1/callback?code=x&state=GOOD')
  const done = await until(() => getMcpSignin('p1', 'denied')!, (j) => j.state !== 'running')
  assert.equal(done.state, 'failed')
  assert.match(done.error!, /access_denied/)
})

test('an unapproved server fails with the approval message, not a bare exit code', { skip }, async () => {
  assert.equal(startMcpSignin(TMP, 'p1', 'unapproved', () => {}).ok, true)
  const done = await until(() => getMcpSignin('p1', 'unapproved')!, (j) => j.state !== 'running')
  assert.equal(done.state, 'failed')
  assert.match(done.error!, /awaiting approval/)
})

test('cancel ends the sign-in and frees the slot', { skip }, async () => {
  assert.equal(startMcpSignin(TMP, 'p1', 'svc', () => assert.fail('cancelled')).ok, true)
  await until(() => getMcpSignin('p1', 'svc')!, (j) => j.awaitingPaste)
  assert.equal(cancelMcpSignin('p1', 'svc').ok, true)
  assert.equal(getMcpSignin('p1', 'svc')!.state, 'cancelled')
  assert.equal(pasteMcpSignin('p1', 'svc', 'http://localhost/x').ok, false)
  // The one-at-a-time slot is free again.
  const next = startMcpSignin(TMP, 'p1', 'other', () => {})
  assert.equal(next.ok, true)
  cancelMcpSignin('p1', 'other')
})

test('logout runs `claude mcp logout <name>`', { skip }, async () => {
  const r = await runMcpLogout(TMP, 'svc')
  assert.equal(r.ok, true)
  assert.match(r.detail, /Signed out of "svc"/)
})
