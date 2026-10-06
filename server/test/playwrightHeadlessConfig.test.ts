import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// A project saved HEADLESS on the MCP page must get the headless Playwright config (a
// pinned desktop viewport), not the headed one (`viewport: null` → headless Chrome's
// 800x600). Separate file: the config files are written beside QC_DB_PATH, which has to
// point at a temp dir BEFORE the module loads. Run with `npm -w server test`.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-headless-'))
process.env.QC_DB_PATH = path.join(TMP, 'db', 'qc.db')
const { repairProjectMcpConfig } = await import('../src/routes/mcp.ts')

function project(args: string[]): string {
  const dir = fs.mkdtempSync(path.join(TMP, 'proj-'))
  fs.writeFileSync(
    path.join(dir, '.mcp.json'),
    JSON.stringify({ mcpServers: { playwright: { command: 'npx', args } } }),
  )
  return dir
}
const configOf = (dir: string): Record<string, any> => {
  const args: string[] = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'))
    .mcpServers.playwright.args
  const i = args.indexOf('--config')
  assert.ok(i >= 0, 'a --config is set')
  return JSON.parse(fs.readFileSync(args[i + 1], 'utf8'))
}

test('a headless project gets the headless config with a real viewport', () => {
  const dir = project(['@playwright/mcp@latest', '--headless'])
  repairProjectMcpConfig(dir)
  const cfg = configOf(dir)
  assert.equal(cfg.browser.launchOptions.headless, true)
  assert.ok(cfg.browser.contextOptions.viewport?.width >= 1280)
})

test('a headed project keeps the maximized, viewport-less config', () => {
  const dir = project(['@playwright/mcp@latest'])
  repairProjectMcpConfig(dir)
  const cfg = configOf(dir)
  assert.equal(cfg.browser.contextOptions.viewport, null)
  assert.deepEqual(cfg.browser.launchOptions.args, ['--start-maximized'])
})
