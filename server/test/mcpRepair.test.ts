import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { repairProjectMcpConfig } from '../src/routes/mcp.ts'

function project(servers: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-repair-'))
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: servers }))
  return dir
}
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')).mcpServers

const CLICKUP = {
  command: 'uvx',
  args: ['--from', 'git+https://github.com/DiversioTeam/clickup-mcp.git', 'clickup-mcp'],
  env: { CLICKUP_API_KEY: 'x' },
}

test('an unpinned clickup-mcp entry gets --with mcp<2 (mcp 2.x breaks it on start)', () => {
  const dir = project({ clickup: CLICKUP })
  repairProjectMcpConfig(dir)
  assert.deepEqual(read(dir).clickup.args.slice(0, 2), ['--with', 'mcp<2'])
  assert.equal(read(dir).clickup.args.at(-1), 'clickup-mcp')
})

test('the pin is found by the package, not the server name, and added once', () => {
  const dir = project({ 'my-clickup': CLICKUP })
  repairProjectMcpConfig(dir)
  repairProjectMcpConfig(dir)
  const args: string[] = read(dir)['my-clickup'].args
  assert.equal(args.filter((a) => a === '--with').length, 1)
})

test('an entry that already pins mcp is left alone', () => {
  const pinned = { ...CLICKUP, args: ['--with', 'mcp==1.9.0', ...CLICKUP.args] }
  const dir = project({ clickup: pinned })
  const before = fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8')
  repairProjectMcpConfig(dir)
  assert.equal(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'), before)
})

test('other uvx servers are not touched', () => {
  const jira = { command: 'uvx', args: ['mcp-atlassian'] }
  const dir = project({ jira })
  repairProjectMcpConfig(dir)
  assert.deepEqual(read(dir).jira.args, ['mcp-atlassian'])
})
