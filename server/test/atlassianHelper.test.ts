import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HEADERS_HELPER_RE, claudeHeadersHelper } from '../src/atlassianMcp.ts'

test('the headersHelper names this portal and project, and the repair pattern recognises it', () => {
  const cmd = claudeHeadersHelper(5174, 'abc-123')
  assert.equal(cmd, 'curl -s "http://127.0.0.1:5174/api/jira/oauth/headers?projectId=abc-123"')
  // A helper written on another machine (other port / project id) is still "ours".
  assert.ok(HEADERS_HELPER_RE.test(claudeHeadersHelper(5180, 'other-id')))
  assert.equal(HEADERS_HELPER_RE.test('my-own-script --token'), false)
})
