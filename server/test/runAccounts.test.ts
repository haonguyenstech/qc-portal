import assert from 'node:assert/strict'
import { test } from 'node:test'

// "Sign in as" on the Run form (src/accountsStore.ts): the account rows offered from
// testing/environments.md — identities only, never a password column.
// Run with `npm -w server test`.

const { parseRunAccounts } = await import('../src/accountsStore.ts')

test('reads username + role + environment, never the password', () => {
  const md = [
    '# Environments',
    '',
    '| Environment | Role | Username | Password |',
    '|---|---|---|---|',
    '| DEV | Admin | qa.admin@acme.test | S3cret! |',
    '| DEV | Doctor | **dr.qc** | hunter2 |',
    '|  |  |  |  |',
    '| UAT | Admin | qa.admin@acme.test | other |',
  ].join('\n')
  const rows = parseRunAccounts(md)
  assert.deepEqual(rows, [
    { label: 'qa.admin@acme.test (Admin)', detail: 'DEV' },
    { label: 'dr.qc (Doctor)', detail: 'DEV' },
  ])
  assert.ok(!JSON.stringify(rows).includes('S3cret'))
  assert.ok(!JSON.stringify(rows).includes('hunter2'))
})

test('prefers a Username column over an "Account type" one; Vietnamese headers work', () => {
  const md = [
    '| Account type | Email | Mật khẩu |',
    '| --- | --- | --- |',
    '| Staff | staff@acme.test | x |',
    '',
    '| Tài khoản | Mật khẩu | Vai trò |',
    '| :-- | :-- | :-- |',
    '| qc01 | y | Quản lý |',
  ].join('\n')
  assert.deepEqual(
    parseRunAccounts(md).map((r) => r.label),
    ['staff@acme.test (Staff)', 'qc01 (Quản lý)'],
  )
})

test('a sheet with no account table offers nothing', () => {
  assert.deepEqual(parseRunAccounts('| URL | Notes |\n|---|---|\n| https://dev | main |'), [])
  assert.deepEqual(parseRunAccounts(''), [])
})
