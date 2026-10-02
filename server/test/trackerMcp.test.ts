import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { trackerConflict, trackerOfEntry, trackerServers } from '../src/trackerMcp.ts'
import { azureLauncherArgs, isAzureLauncher } from '../src/azureSignin.ts'

function project(mcp: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-mcp-'))
  if (mcp !== undefined) fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify(mcp))
  return dir
}

test('finds the token built-in first, then any hosted server signed in to in the browser', () => {
  const root = project({
    mcpServers: {
      'my-clickup': { type: 'http', url: 'https://mcp.clickup.com/mcp' },
      clickup: { command: 'uvx', args: ['clickup-mcp'], env: { CLICKUP_API_KEY: 'pk_x' } },
      atlassian: { type: 'http', url: 'https://mcp.atlassian.com/v1/mcp' },
      other: { type: 'http', url: 'https://example.com/mcp' },
    },
  })
  assert.deepEqual(trackerServers(root, 'clickup'), [
    { name: 'clickup', kind: 'token' },
    { name: 'my-clickup', kind: 'oauth' },
  ])
  assert.deepEqual(trackerServers(root, 'jira'), [{ name: 'atlassian', kind: 'oauth' }])
})

test('Azure DevOps: the PAT built-in, then the portal-launched signed-in server under any name', () => {
  const root = project({
    mcpServers: {
      'ado-work': { type: 'stdio', command: 'node', args: azureLauncherArgs(5174, 'p1') },
      azure: { command: 'npx', args: ['-y', '@tiberriver256/mcp-server-azure-devops'] },
      // Some other `node -e` server is not it.
      scratch: { command: 'node', args: ['-e', 'console.log(1)'] },
    },
  })
  assert.deepEqual(trackerServers(root, 'azure'), [
    { name: 'azure', kind: 'token' },
    { name: 'ado-work', kind: 'oauth' },
  ])
  assert.deepEqual(trackerServers(root, 'clickup'), [])
})

test('the Azure launcher is recognised whatever port / project it names (boot repair relies on it)', () => {
  const entry = { command: 'node', args: azureLauncherArgs(6000, 'another-machine') }
  assert.equal(isAzureLauncher(entry), true)
  assert.deepEqual(entry.args.slice(2), ['6000', 'another-machine'])
  assert.equal(isAzureLauncher({ command: 'npx', args: entry.args }), false)
  assert.equal(isAzureLauncher(undefined), false)
})

test('no .mcp.json, or malformed → nothing, never a throw', () => {
  assert.deepEqual(trackerServers(project(undefined), 'clickup'), [])
  const bad = project(undefined)
  fs.writeFileSync(path.join(bad, '.mcp.json'), '{ nope')
  assert.deepEqual(trackerServers(bad, 'jira'), [])
})

test('one ticket tracker per project: another tracker is refused, naming the server to remove', () => {
  const root = project({ mcpServers: { 'clickup-oauth': { type: 'http', url: 'https://mcp.clickup.com/mcp' } } })
  const refusal = trackerConflict(root, 'jira')
  assert.match(refusal ?? '', /already uses ClickUp \("clickup-oauth"\)/)
  assert.match(refusal ?? '', /Disconnect "clickup-oauth"/)
  assert.ok(trackerConflict(root, 'azure'))
  // The same tracker a second time (a token next to the sign-in) is refused too…
  assert.match(trackerConflict(root, 'clickup') ?? '', /ClickUp is already connected in this project \("clickup-oauth"\)/)
  // …but signing in again relinks that row, and that is fine.
  assert.equal(trackerConflict(root, 'clickup', undefined, { allowSame: true }), null)
  // An edit replacing that very server does not conflict with itself.
  assert.equal(trackerConflict(root, 'jira', 'clickup-oauth'), null)
  assert.equal(trackerConflict(project({ mcpServers: {} }), 'jira'), null)
})

test('trackerOfEntry: built-in names, hosted URLs, the Azure launcher — nothing else', () => {
  assert.equal(trackerOfEntry('jira', { command: 'uvx' }), 'jira')
  assert.equal(trackerOfEntry('work', { url: 'https://mcp.atlassian.com/v1/mcp' }), 'jira')
  assert.equal(trackerOfEntry('ado', { command: 'node', args: azureLauncherArgs(5174, 'p') }), 'azure')
  assert.equal(trackerOfEntry('github', { url: 'https://api.githubcopilot.com/mcp/' }), null)
  assert.equal(trackerOfEntry('playwright', { command: 'npx' }), null)
})
