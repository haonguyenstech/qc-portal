import { Router } from 'express'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import spawn from 'cross-spawn'
import { CLAUDE_BIN, OAUTH_APPS, OAUTH_REDIRECT_BASE, mcpJsonFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import {
  cancelMcpSignin,
  getMcpSignin,
  pasteMcpSignin,
  runMcpLogout,
  startMcpSignin,
} from '../mcpSignin.js'
import { revealFolderNative } from '../folderPicker.js'
import {
  resolveProjectClickupToken,
  verifyToken as verifyClickup,
  withClickupToken,
} from '../clickup.js'
import {
  resolveProjectAzureCreds,
  verifyToken as verifyAzure,
  withAzureCreds,
} from '../azure.js'
import { resolveProjectJiraCreds, verifyToken as verifyJira, withJiraCreds } from '../jira.js'
import { runMcpCapabilityTest } from '../mcpCapabilityTest.js'
import { maestroEnvFor, probeMaestro, type MaestroPreflight } from '../maestro.js'
import { agentProfileDir, isForeignProfileDir } from '../browserProfile.js'
import { cdpEndpoint, writePlaywrightMcpConfig } from '../qcBrowser.js'
import type { McpServer } from '../types.js'
import { killSpawnedTree, spawnEnv } from '../toolPath.js'

export const mcpRouter = Router()

// ---- `uv`/`uvx` availability ----------------------------------------------
// ClickUp (clickup-mcp) and Jira (mcp-atlassian) are Python MCP servers the
// portal runs via `uvx`. On a machine without Astral's `uv` installed the server
// simply fails to spawn ("failed"), which is confusing. Probe once (cached) so
// the MCP page can warn up-front with an install hint instead of a dead server.

let uvCache: { at: number; available: boolean; version: string | null } | null = null

function probeUv(): Promise<{ available: boolean; version: string | null }> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (r: { available: boolean; version: string | null }) => {
      if (done) return
      done = true
      resolve(r)
    }
    try {
      const child = spawn('uvx', ['--version'], { env: spawnEnv(), windowsHide: true })
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString()
      })
      child.on('error', () => finish({ available: false, version: null }))
      child.on('close', (code: number | null) =>
        finish({ available: code === 0, version: code === 0 ? out.trim() || null : null }),
      )
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish({ available: false, version: null })
      }, 4000)
    } catch {
      finish({ available: false, version: null })
    }
  })
}

// Report whether `uvx` is on PATH (cached 30s so re-checks pick up a fresh install
// without hammering a spawn on every poll). `platform` lets the UI show the right
// install command.
mcpRouter.get('/uv', async (_req, res) => {
  const now = Date.now()
  if (!uvCache || now - uvCache.at > 30_000 || uvCache.available === false) {
    const r = await probeUv()
    uvCache = { at: now, ...r }
  }
  res.json({ available: uvCache.available, version: uvCache.version, platform: process.platform })
})

// ---- Maestro CLI availability ---------------------------------------------
// Maestro is the one device MCP the portal can't install on demand (separate
// binary + Java 17). Same cached-probe shape as /uv, but a longer TTL: the probe
// boots a JVM, so it's slow (~2-5s) compared to `uvx --version`.

let maestroCache: { at: number; value: MaestroPreflight } | null = null

mcpRouter.get('/maestro', async (_req, res) => {
  const now = Date.now()
  // Re-probe unavailable/unusable results sooner so a fresh install is picked up
  // without a restart; cache a good result longer since it can't regress silently.
  const ttl = maestroCache?.value.available ? 120_000 : 20_000
  if (!maestroCache || now - maestroCache.at > ttl) {
    maestroCache = { at: now, value: await probeMaestro() }
  }
  res.json(maestroCache.value)
})

/**
 * Connect Maestro. This gets its own route (rather than the generic POST / the
 * other one-click cards use) because the entry's `env` is resolved HERE: the
 * JAVA_HOME pin and the PATH that puts that JDK's bin first are machine facts the
 * browser can't know — it has no access to the server's PATH or its installed JDKs.
 * Refuses up-front when the CLI or a Java 17+ is missing, so we never write a
 * server entry that is guaranteed to show up as "failed".
 */
mcpRouter.post('/maestro/connect', async (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })

  const pf = await probeMaestro()
  maestroCache = { at: Date.now(), value: pf }
  if (!pf.available) {
    return res.status(400).json({
      error:
        pf.javaHome === null && !pf.defaultJavaOk
          ? 'Maestro needs Java 17 or higher, and no JDK 17+ was found on this machine.'
          : 'The Maestro CLI is not installed on this machine.',
      preflight: pf,
    })
  }

  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  if (data.mcpServers.maestro) return res.status(400).json({ error: 'server already exists' })

  data.mcpServers.maestro = {
    type: 'stdio',
    command: 'maestro',
    args: ['mcp'],
    env: maestroEnvFor(pf),
  }
  writeMcp(file, data)
  return res.status(201).json({ ok: true, preflight: pf })
})

interface McpTestResult {
  ok: boolean
  detail: string
  status?: McpServer['status']
}

/**
 * How long `claude mcp list` may take. It spawns EVERY server in scope (project,
 * local, user, claude.ai connectors, plugins) and waits on each, so a cold start —
 * the first `npx`/`uvx` spawn after a reboot or an update — measured 15s+ on a
 * 10-server machine. The old 15s cap turned exactly that into an empty map, i.e.
 * "no status" for every server on the page.
 */
const MCP_LIST_TIMEOUT_MS = 45_000

/** A health probe that did not finish — NOT the same thing as "no servers". */
export class McpProbeTimeout extends Error {}

function parseStatuses(out: string): Record<string, McpServer['status']> {
  const map: Record<string, McpServer['status']> = {}
  for (const raw of out.split('\n')) {
    // Lines look like: "name: <command/url> - <status text>"
    const line = raw.trim()
    const colon = line.indexOf(': ')
    const dash = line.lastIndexOf(' - ')
    if (colon === -1 || dash === -1 || dash < colon) continue
    const name = line.slice(0, colon).trim()
    const status = line.slice(dash + 3).toLowerCase()
    if (status.includes('connected')) map[name] = 'connected'
    else if (status.includes('pending') || status.includes('approve')) map[name] = 'pending'
    else if (status.includes('auth')) map[name] = 'needs-auth'
    else if (status.includes('fail') || status.includes('error')) map[name] = 'failed'
    else map[name] = 'unknown'
  }
  return map
}

// One probe per project at a time, plus a short memory of the last GOOD one. A page
// reload fires /health while a Test click (or a second tab) may already be probing;
// two `claude mcp list` runs spawn every server twice, fight for the CPU and push
// each other past the timeout — the very failure the probe is meant to report.
const inflight = new Map<string, Promise<Record<string, McpServer['status']>>>()
const lastGood = new Map<string, { at: number; map: Record<string, McpServer['status']> }>()
const REUSE_MS = 5_000

/** Forget a project's remembered health (after a write changed its servers). */
export function invalidateMcpHealth(cwd: string): void {
  lastGood.delete(cwd)
}

/**
 * Ask the Claude CLI for live MCP health in a project dir and map each server name
 * to a status. REJECTS with McpProbeTimeout when the CLI doesn't finish in time, so
 * callers can tell "couldn't check" from "checked, nothing connected" — resolving
 * `{}` there made the page drop every badge (and cache the empty map).
 */
function getStatuses(cwd: string): Promise<Record<string, McpServer['status']>> {
  const recent = lastGood.get(cwd)
  if (recent && Date.now() - recent.at < REUSE_MS) return Promise.resolve({ ...recent.map })
  const running = inflight.get(cwd)
  if (running) return running.then((m) => ({ ...m }))

  const probe = new Promise<Record<string, McpServer['status']>>((resolve, reject) => {
    let out = ''
    const child = spawn(CLAUDE_BIN, ['mcp', 'list'], {
      cwd,
      env: spawnEnv(),
      windowsHide: true, // no cmd window flash on Windows
    })
    const timer = setTimeout(() => {
      killSpawnedTree(child)
      reject(new McpProbeTimeout(`claude mcp list did not finish within ${MCP_LIST_TIMEOUT_MS / 1000}s`))
    }, MCP_LIST_TIMEOUT_MS)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const map = parseStatuses(out)
      lastGood.set(cwd, { at: Date.now(), map })
      resolve(map)
    })
  }).finally(() => inflight.delete(cwd))
  inflight.set(cwd, probe)
  return probe.then((m) => ({ ...m }))
}

/**
 * Run a real connection test for ONE server by invoking `claude mcp list` in the
 * project dir (which spawns each server and reports health) and parsing the line
 * for the requested name. Returns ok + a human-readable detail string.
 */
function testServer(cwd: string, name: string): Promise<McpTestResult> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(CLAUDE_BIN, ['mcp', 'list'], {
      cwd,
      env: spawnEnv(),
      windowsHide: true, // no cmd window flash on Windows
    })
    const timer = setTimeout(() => {
      killSpawnedTree(child)
      resolve({
        ok: false,
        detail: `Timed out after ${MCP_LIST_TIMEOUT_MS / 1000}s while checking server health.`,
        status: 'failed',
      })
    }, MCP_LIST_TIMEOUT_MS)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (out += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : ''
      const detail = /ENOENT/.test(msg)
        ? `Could not find the Claude CLI (tried "${CLAUDE_BIN}"). Install Claude Code and ensure \`claude\` is on PATH, or set the QC_CLAUDE_BIN env var to its full path, then restart the portal.`
        : msg || 'Failed to run claude mcp list.'
      resolve({ ok: false, detail, status: 'failed' })
    })
    child.on('close', () => {
      clearTimeout(timer)
      for (const raw of out.split('\n')) {
        const line = raw.trim()
        const colon = line.indexOf(': ')
        if (colon === -1 || line.slice(0, colon).trim() !== name) continue
        const dash = line.lastIndexOf(' - ')
        const status = (dash !== -1 ? line.slice(dash + 3) : line.slice(colon + 2)).trim()
        const lower = status.toLowerCase()
        // Strip leading status glyphs (✔ ✗ ⏸ ! •) for a clean message.
        const clean = status.replace(/^[^A-Za-z0-9]+/, '').trim()
        if (/connected/.test(lower)) {
          return resolve({
            ok: true,
            detail: 'Connected — the server responded.',
            status: 'connected',
          })
        }
        if (/pending|approve/.test(lower)) {
          return resolve({
            ok: false,
            detail: 'Pending approval — approving this project server and testing again.',
            status: 'pending',
          })
        }
        if (/auth/.test(lower)) {
          return resolve({
            ok: false,
            detail: clean || 'Needs authentication.',
            status: 'needs-auth',
          })
        }
        return resolve({ ok: false, detail: clean || 'Not connected.', status: 'failed' })
      }
      // A project server Claude has REJECTED (listed in disabledMcpjsonServers) is
      // left out of `mcp list` entirely. It isn't broken — it's unapproved, so report
      // it as pending and let the test route approve it (which also takes it off the
      // disabled list) instead of failing forever with no way out from the page.
      if (isRejectedProjectServer(cwd, name)) {
        return resolve({
          ok: false,
          detail: 'Rejected in this project\'s Claude settings — approving it and testing again.',
          status: 'pending',
        })
      }
      resolve({
        ok: false,
        detail: 'Server did not appear in the MCP list — check the command/token.',
        status: 'failed',
      })
    })
  })
}

interface McpEntry {
  command?: string
  args?: string[]
  url?: string
  type?: string
  env?: Record<string, string>
  headers?: Record<string, string>
  cwd?: string
  [key: string]: unknown
}

interface McpFile {
  mcpServers?: Record<string, McpEntry>
}

interface ClaudeConfig {
  projects?: Record<string, { mcpServers?: Record<string, McpEntry>; [key: string]: unknown }>
  [key: string]: unknown
}

/** Resolve the active project's .mcp.json path, or null if project unknown. */
function mcpPath(req: Parameters<typeof resolveProject>[0]): string | null {
  const project = resolveProject(req)
  return project ? mcpJsonFor(project.rootPath) : null
}

function readMcp(file: string): McpFile {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as McpFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeMcp(file: string, data: McpFile): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
  // The servers changed — a remembered health map now describes a different config.
  invalidateMcpHealth(path.dirname(file))
}

/**
 * Device drivers the portal no longer offers. Maestro is the ONE mobile driver now
 * (it covers both mobile-web and native-app runs), so these two have no card, no
 * functional test, and nothing that resolves them — an entry left behind by an older
 * portal would just be an invisible, unremovable server that still gets spawned on
 * every run. Pruned on read so upgrading cleans a project up without the engineer
 * having to hand-edit .mcp.json (or ~/.claude.json for a local-scope entry).
 */
const RETIRED_SERVERS = ['mobile-mcp', 'appium-mcp']

/**
 * Point a Playwright entry's `--user-data-dir` at THIS machine's profile directory,
 * mutating `entry` in place. Returns true when it changed something.
 *
 * The flag used to be written by the web app, which meant the portal author's own
 * home directory was baked into the bundle and copied into every project that
 * connected Playwright. On another machine — especially Windows, where it becomes
 * `C:\Users\<someone-else>` — Chrome can't create it and EVERY browser call dies
 * with `EPERM: operation not permitted, mkdir …` before the first page loads. A run
 * that can't drive the browser can't test anything, so this is a total blocker, and
 * the error names a stranger's path, which makes it look like anything but a config
 * bug. Resolve it here, where `os.homedir()` is the real one.
 *
 * A profile the engineer pointed somewhere else INSIDE their own home is theirs to
 * keep — only a path outside it (`isForeignProfileDir`) is rewritten.
 */
/** Drop `--flag` (and its value, when it takes one) from an args list, in place. */
function dropArg(args: string[], flag: string, hasValue: boolean): boolean {
  const i = args.indexOf(flag)
  if (i === -1) return false
  const value = args[i + 1]
  const take = hasValue && typeof value === 'string' && !value.startsWith('--') ? 2 : 1
  args.splice(i, take)
  return true
}

/** Ensure `--flag <value>` is present exactly once with this value, in place. */
function setArg(args: string[], flag: string, value: string): boolean {
  const i = args.indexOf(flag)
  if (i === -1) {
    args.push(flag, value)
    return true
  }
  const current = args[i + 1]
  if (current === value) return false
  if (typeof current !== 'string' || current.startsWith('--')) {
    args.splice(i + 1, 0, value)
  } else {
    args[i + 1] = value
  }
  return true
}

/**
 * Point a Playwright entry at the portal-owned QC browser (`--cdp-endpoint`) instead
 * of letting it launch its own, or back again. Mutating `entry` in place; returns true
 * when something changed. See `qcBrowser.ts` for WHY the attached mode exists — in
 * short, a browser the MCP launched dies with the `claude` process that spawned the
 * MCP, so pressing Stop closed the browser instead of pausing.
 *
 * Which flags come off in attached mode is the load-bearing part:
 *  - `--viewport-size` MUST go. It emulates a fixed viewport over the real window, so
 *    leaving it would keep the page rendering at 1280x720 inside a maximized browser —
 *    i.e. the full-screen complaint would survive the fix.
 *  - `--user-data-dir` and `--browser` belong to whoever LAUNCHES the browser; with a
 *    CDP endpoint they describe a browser this MCP isn't starting, so they only
 *    mislead the next person reading the file.
 *  - `--headless` is meaningless against an already-open window, and a QC engineer
 *    watching a flow wants to see it.
 */
function applyPlaywrightAttachMode(entry: McpEntry, attach: boolean): boolean {
  if (!Array.isArray(entry.args)) return false
  const args = [...entry.args]
  let changed = false

  if (attach) {
    changed = dropArg(args, '--viewport-size', true) || changed
    changed = dropArg(args, '--user-data-dir', true) || changed
    changed = dropArg(args, '--browser', true) || changed
    changed = dropArg(args, '--headless', false) || changed
    changed = setArg(args, '--cdp-endpoint', cdpEndpoint()) || changed
  } else {
    changed = dropArg(args, '--cdp-endpoint', true) || changed
  }

  if (changed) entry.args = args
  return changed
}

/**
 * Self-launch mode only: make the browser the MCP opens itself maximized, via the
 * `--config` file written by `writePlaywrightMcpConfig` (a browser launch argument
 * has no CLI flag), and take the fixed `--viewport-size` off so the page fills that
 * window. Without both halves the browser opens in a small box on a large monitor —
 * desktop breakpoints never fire and screenshots are the wrong shape.
 *
 * In attach mode this does nothing: the QC browser is already maximized by its own
 * launch args, and `--config` would describe a launch that never happens.
 */
function applyPlaywrightWindowConfig(entry: McpEntry, attach: boolean): boolean {
  if (!Array.isArray(entry.args)) return false
  const args = [...entry.args]
  let changed = false
  if (attach) {
    changed = dropArg(args, '--config', true) || changed
  } else {
    changed = dropArg(args, '--viewport-size', true) || changed
    const cfg = writePlaywrightMcpConfig()
    if (cfg) changed = setArg(args, '--config', cfg) || changed
  }
  if (changed) entry.args = args
  return changed
}

function normalizePlaywrightProfile(entry: McpEntry): boolean {
  if (!Array.isArray(entry.args)) return false
  // A Playwright attached to the QC browser launches nothing, so it has no profile to
  // fix — and re-adding one here would put back a flag attach mode just removed.
  if (entry.args.includes('--cdp-endpoint')) return false
  const local = agentProfileDir()
  const i = entry.args.indexOf('--user-data-dir')
  if (i === -1) {
    entry.args = [...entry.args, '--user-data-dir', local]
    return true
  }
  const current = entry.args[i + 1]
  // A trailing flag with no value is malformed — treat it as missing and fill it in.
  if (typeof current !== 'string' || current.startsWith('--')) {
    entry.args = [...entry.args.slice(0, i + 1), local, ...entry.args.slice(i + 1)]
    return true
  }
  if (!isForeignProfileDir(current)) return false
  entry.args = [...entry.args]
  entry.args[i + 1] = local
  return true
}

/** Add the `mcp<2` pin (see CLICKUP_MCP_ARGS) to a clickup-mcp entry lacking it. */
function pinClickupMcpSdk(entry: McpEntry): boolean {
  if (entry.command !== 'uvx' || !Array.isArray(entry.args)) return false
  const args = entry.args
  if (!args.some((a) => typeof a === 'string' && a.includes('DiversioTeam/clickup-mcp'))) return false
  const pinned = args.some((a, i) => a === '--with' && /^mcp\s*[<=~]/.test(args[i + 1] ?? ''))
  if (pinned) return false
  entry.args = [...CLICKUP_MCP_PIN, ...args]
  return true
}

/**
 * Bring one project's .mcp.json in line with what this portal (and this machine)
 * actually supports: drop retired servers, pin clickup-mcp's `mcp` SDK below 2, and
 * repair a Playwright profile path that belongs to a different user. Idempotent —
 * writes only when something changed.
 */
export function repairProjectMcpConfig(rootPath: string, attachBrowser = false): void {
  const file = mcpJsonFor(rootPath)
  const data = readMcp(file)
  const servers = data.mcpServers
  if (servers) {
    let changed = false
    for (const name of RETIRED_SERVERS) {
      if (name in servers) {
        delete servers[name]
        changed = true
      }
    }
    for (const entry of Object.values(servers)) {
      if (entry && typeof entry === 'object' && pinClickupMcpSdk(entry)) changed = true
    }
    const playwright = servers.playwright
    if (playwright) {
      // Attach mode first: it strips the flags the two calls below would otherwise
      // re-add (profile, viewport), and normalizePlaywrightProfile bails out once a
      // --cdp-endpoint is present.
      if (applyPlaywrightAttachMode(playwright, attachBrowser)) changed = true
      if (normalizePlaywrightProfile(playwright)) changed = true
      if (applyPlaywrightWindowConfig(playwright, attachBrowser)) changed = true
    }
    if (changed) writeMcp(file, data)
  }
  const local = localProjectMcpServers(rootPath)
  for (const name of RETIRED_SERVERS) {
    if (name in local) removeLocalProjectMcpServer(rootPath, name)
  }
}

function claudeConfigPath(): string | null {
  // os.homedir() works on Windows too (USERPROFILE) — process.env.HOME is
  // usually unset there, which silently disabled ~/.claude.json reads/writes.
  const home = os.homedir()
  return home ? path.join(home, '.claude.json') : null
}

function readClaudeConfig(): ClaudeConfig {
  const file = claudeConfigPath()
  if (!file) return {}
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as ClaudeConfig
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeClaudeConfig(data: ClaudeConfig): void {
  const file = claudeConfigPath()
  if (!file) return
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/**
 * Claude Code keys the ~/.claude.json `projects` map with FORWARD slashes even
 * on Windows, while our rootPath comes from path.resolve() (back-slashes there).
 * Always read/write that map through this key, or the entry lands where the CLI
 * never looks — which is exactly the "Pending approval" bug on Windows.
 */
export function claudeProjectKey(rootPath: string): string {
  return rootPath.replace(/\\/g, '/')
}

export function localProjectMcpServers(rootPath: string): Record<string, McpEntry> {
  const projects = readClaudeConfig().projects
  return (
    projects?.[claudeProjectKey(rootPath)]?.mcpServers ??
    projects?.[rootPath]?.mcpServers ??
    {}
  )
}

export function removeLocalProjectMcpServer(rootPath: string, name: string): void {
  const data = readClaudeConfig()
  let removed = false
  for (const key of new Set([claudeProjectKey(rootPath), rootPath])) {
    const servers = data.projects?.[key]?.mcpServers
    if (servers && name in servers) {
      delete servers[name]
      removed = true
    }
  }
  if (removed) writeClaudeConfig(data)
}

function maskSecret(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  // Shell env references are not secrets themselves and are useful to show.
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed)) return trimmed
  if (trimmed.length <= 4) return '••••'
  return `••••${trimmed.slice(-4)}`
}

// Only actual secrets are masked. URLs, usernames/emails, project names, and flags
// (JIRA_URL, JIRA_USERNAME, AZURE_DEVOPS_ORG_URL, …_DEFAULT_PROJECT, …_AUTH_METHOD)
// are not secrets and are far more useful shown in full.
function isSecretKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|PASSWD|PWD|API[-_]?KEY|(^|_)KEY(_|$)|(^|_)PAT(_|$)/i.test(key)
}

function publicEnv(env?: Record<string, string>): Record<string, string> | undefined {
  if (!env) return undefined
  const masked = Object.fromEntries(
    Object.entries(env)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, isSecretKey(key) ? maskSecret(value) : value]),
  )
  return Object.keys(masked).length ? masked : undefined
}

// Header VALUES are masked whatever their name: remote servers put the credential in
// `Authorization` / `X-Api-Key` / a vendor header, and no name rule catches them all.
function maskedHeaders(headers: unknown): Record<string, string> | undefined {
  const map = stringMap(headers)
  if (!map) return undefined
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, maskSecret(v)]))
}

interface ClaudeProjectSettings {
  enabledMcpjsonServers?: unknown
  disabledMcpjsonServers?: unknown
  [key: string]: unknown
}

function readClaudeProjectSettings(file: string): ClaudeProjectSettings {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as ClaudeProjectSettings
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * Is `name` a project (.mcp.json) server that Claude has been told to reject — in
 * `disabledMcpjsonServers` of ~/.claude.json's project entry or of
 * .claude/settings.local.json? Such a server is silently absent from `mcp list`.
 */
function isRejectedProjectServer(rootPath: string, name: string): boolean {
  if (!(name in (readMcp(mcpJsonFor(rootPath)).mcpServers ?? {}))) return false
  const projects = readClaudeConfig().projects ?? {}
  const entry = projects[claudeProjectKey(rootPath)] ?? projects[rootPath]
  if (asStringArray(entry?.disabledMcpjsonServers).includes(name)) return true
  const settings = readClaudeProjectSettings(path.join(rootPath, '.claude', 'settings.local.json'))
  return asStringArray(settings.disabledMcpjsonServers).includes(name)
}

/**
 * Approve a project-scoped .mcp.json server so `claude mcp list` stops reporting
 * it "Pending approval". Current Claude Code (2.1.x) reads this approval from the
 * per-project entry in ~/.claude.json (`hasTrustDialogAccepted` +
 * `enabledMcpjsonServers`) — NOT from .claude/settings.local.json, which older
 * versions used. We write BOTH: the ~/.claude.json entry is what actually clears
 * the gate today; the settings.local.json write is kept for backward compat. The
 * portal owns these project configs, so Test connection can approve the requested
 * server before retrying health.
 */
export function approveMcpJsonServer(rootPath: string, name: string): boolean {
  const servers = readMcp(mcpJsonFor(rootPath)).mcpServers ?? {}
  if (!(name in servers)) return false

  // Primary: ~/.claude.json project entry (what the CLI consults). A project that
  // was never opened interactively has no entry here at all — create it.
  // Written under the forward-slash key (see claudeProjectKey), merging from and
  // deleting any stale back-slash orphan a previous portal version left behind.
  const config = readClaudeConfig()
  if (!config.projects) config.projects = {}
  const key = claudeProjectKey(rootPath)
  const project = config.projects[key] ?? config.projects[rootPath] ?? {}
  if (rootPath !== key && rootPath in config.projects) delete config.projects[rootPath]
  project.hasTrustDialogAccepted = true
  project.enabledMcpjsonServers = [...new Set([...asStringArray(project.enabledMcpjsonServers), name])]
  project.disabledMcpjsonServers = asStringArray(project.disabledMcpjsonServers).filter((v) => v !== name)
  config.projects[key] = project
  writeClaudeConfig(config)

  // Backward compat: mirror into .claude/settings.local.json for older CLIs.
  const settingsDir = path.join(rootPath, '.claude')
  const settingsFile = path.join(settingsDir, 'settings.local.json')
  const settings = readClaudeProjectSettings(settingsFile)
  settings.enabledMcpjsonServers = [...new Set([...asStringArray(settings.enabledMcpjsonServers), name])]
  settings.disabledMcpjsonServers = asStringArray(settings.disabledMcpjsonServers).filter((v) => v !== name)

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return true
}

/**
 * Live health for every configured server in a project. Runs the (slow) Claude
 * CLI `mcp list` and the ClickUp token check **in parallel** — they're
 * independent, so the total wait is the slower of the two rather than their sum.
 * `configuredNames` is the set of servers actually in config, so a tracker's
 * override only applies when it's configured. Best-effort throughout.
 */
// Tracker servers whose "connected" badge is only a stdio handshake — the token
// is never exercised there. `verifyTrackerAuth` hits a cheap authenticated
// endpoint so a dead/expired/wrong credential shows "needs-auth" instead of a
// misleading "connected" (e.g. an Azure PAT field holding the wrong token).
const TRACKER_SERVERS = ['clickup', 'azure', 'jira'] as const

/** Live-validate one tracker's stored credentials. Returns null for non-trackers. */
function verifyTrackerAuth(
  name: string,
  rootPath: string,
): Promise<{ ok: boolean; status: number | null; detail: string }> | null {
  if (name === 'clickup')
    return withClickupToken(resolveProjectClickupToken(rootPath), verifyClickup)
  if (name === 'azure') return withAzureCreds(resolveProjectAzureCreds(rootPath), verifyAzure)
  if (name === 'jira') return withJiraCreds(resolveProjectJiraCreds(rootPath), verifyJira)
  return null
}

async function computeStatuses(
  rootPath: string,
  configuredNames: Set<string>,
): Promise<Record<string, McpServer['status']>> {
  const statuses = await getStatuses(rootPath)
  // A rejected project server never appears in `mcp list`; without this its row could
  // never show a badge. "Pending approval" is what it is — and Test approves it.
  for (const n of configuredNames) {
    if (!(n in statuses) && isRejectedProjectServer(rootPath, n)) statuses[n] = 'pending'
  }
  // Only downgrade a server the handshake reported "connected" — a "failed"/
  // "pending" status is already more informative than "needs-auth".
  const toCheck = TRACKER_SERVERS.filter(
    (n) => configuredNames.has(n) && statuses[n] === 'connected',
  )
  await Promise.all(
    toCheck.map(async (n) => {
      const ok = await verifyTrackerAuth(n, rootPath)!.then((v) => v.ok).catch(() => true)
      if (!ok) statuses[n] = 'needs-auth'
    }),
  )
  return statuses
}

mcpRouter.get('/', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  // Drop retired device drivers and repair a foreign Playwright profile path before
  // listing, so neither can linger in the config (or break the next run).
  repairProjectMcpConfig(project.rootPath)
  const projectServers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const localServers = localProjectMcpServers(project.rootPath)
  const configuredNames = new Set([
    ...Object.keys(projectServers),
    ...Object.keys(localServers),
  ])
  // Live health from the Claude CLI (best-effort) unless the caller opts out.
  // The page loads this with health=false for an instant render, then fetches
  // /health separately so the (slow) probe fills statuses in progressively.
  const statuses =
    req.query.health === 'false'
      ? {}
      : await computeStatuses(project.rootPath, configuredNames).catch(() => ({}))

  const list: McpServer[] = Object.entries(projectServers).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args,
    url: entry.url,
    type: entry.type,
    env: publicEnv(entry.env),
    headers: maskedHeaders(entry.headers),
    oauth: sanitizeOauth(entry.oauth),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
    source: 'project',
    status: statuses[name] ?? 'unknown',
  }))
  for (const [name, entry] of Object.entries(localServers)) {
    if (name in projectServers) continue
    list.push({
      name,
      command: entry.command,
      args: entry.args,
      url: entry.url,
      type: entry.type,
      env: publicEnv(entry.env),
      headers: maskedHeaders(entry.headers),
      oauth: sanitizeOauth(entry.oauth),
      cwd: typeof entry.cwd === 'string' ? entry.cwd : undefined,
      source: 'local',
      status: statuses[name] ?? 'unknown',
    })
  }

  res.json(list)
})

/**
 * Live health only — a `{ name: status }` map. Split out of `GET /` so the page
 * can render the server cards instantly and stream statuses in afterwards.
 */
mcpRouter.get('/health', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const projectServers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const localServers = localProjectMcpServers(project.rootPath)
  const configuredNames = new Set([
    ...Object.keys(projectServers),
    ...Object.keys(localServers),
  ])
  try {
    res.json(await computeStatuses(project.rootPath, configuredNames))
  } catch (err) {
    // "Couldn't check" must not look like "nothing is connected": an error keeps the
    // page's last known badges (and never lands in its cache), where {} wiped them.
    const timedOut = err instanceof McpProbeTimeout
    res.status(timedOut ? 504 : 500).json({
      error: timedOut
        ? 'The live status check timed out — the MCP servers took too long to start.'
        : `Could not run claude mcp list: ${(err as Error).message}`,
    })
  }
})

// ------------------------------------------------ OAuth sign-in (remote servers)
//
// "Sign in" for an http/sse server: drives `claude mcp login` (see mcpSignin.ts for
// why the portal never runs the OAuth flow itself). Declared ahead of the
// `/:name/...` routes so a server literally named "secret" or "env" can't shadow them.

/** The configured http/sse entry for `name`, or why it can't be signed in to. */
function signinTarget(
  rootPath: string,
  name: string,
): { ok: true; inMcpJson: boolean } | { ok: false; status: number; error: string } {
  const projectServers = readMcp(mcpJsonFor(rootPath)).mcpServers ?? {}
  const entry = projectServers[name] ?? localProjectMcpServers(rootPath)[name]
  if (!entry) return { ok: false, status: 404, error: `No server named "${name}".` }
  const remote = entry.type === 'http' || entry.type === 'sse' || (!entry.command && !!entry.url)
  if (!remote) {
    return {
      ok: false,
      status: 400,
      error: `"${name}" runs locally (stdio) — it takes its credential in its settings, not a sign-in.`,
    }
  }
  return { ok: true, inMcpJson: name in projectServers }
}

mcpRouter.get('/signin/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ job: getMcpSignin(project.id, req.params.name) })
})

mcpRouter.post('/signin/:name/start', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const name = req.params.name
  const target = signinTarget(project.rootPath, name)
  if (!target.ok) return res.status(target.status).json({ error: target.error })
  // The CLI refuses an unapproved .mcp.json server outright, so approve it first —
  // the same approval Test connection already grants.
  if (target.inMcpJson) approveMcpJsonServer(project.rootPath, name)
  const rootPath = project.rootPath
  const r = startMcpSignin(rootPath, project.id, name, () => invalidateMcpHealth(rootPath))
  if (!r.ok) return res.status(r.status).json({ error: r.error })
  res.json({ job: r.job })
})

mcpRouter.post('/signin/:name/paste', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const url = typeof req.body?.url === 'string' ? req.body.url : ''
  const r = pasteMcpSignin(project.id, req.params.name, url)
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

mcpRouter.post('/signin/:name/cancel', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const r = cancelMcpSignin(project.id, req.params.name)
  if (!r.ok) return res.status(400).json({ error: r.error })
  res.json({ ok: true })
})

mcpRouter.post('/signin/:name/logout', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = signinTarget(project.rootPath, req.params.name)
  if (!target.ok) return res.status(target.status).json({ error: target.error })
  const r = await runMcpLogout(project.rootPath, req.params.name)
  invalidateMcpHealth(project.rootPath)
  if (!r.ok) return res.status(500).json({ error: r.detail })
  res.json({ ok: true, detail: r.detail })
})

/**
 * Reveal the FULL env value for a server's first env key, for the localhost
 * "copy" action only. The list endpoint masks secrets so they never sit in the
 * page; this returns the real value on explicit user request. Localhost-only,
 * never logged — the same token already lives in .mcp.json on this machine.
 */
mcpRouter.get('/:name/secret', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const servers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const entry = servers[req.params.name] ?? localProjectMcpServers(project.rootPath)[req.params.name]
  const env = entry?.env
  const first = env ? Object.entries(env).find(([, v]) => typeof v === 'string') : undefined
  if (!first) return res.status(404).json({ error: 'no secret to reveal' })
  return res.json({ key: first[0], value: first[1] })
})

/**
 * Reveal the FULL (unmasked) env map for a server, for the localhost "View
 * details" dialog's reveal toggle. Same contract as /:name/secret — localhost
 * only, never logged; the values already live in .mcp.json on this machine.
 */
mcpRouter.get('/:name/env', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const servers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const entry = servers[req.params.name] ?? localProjectMcpServers(project.rootPath)[req.params.name]
  const env = entry?.env
  const out: Record<string, string> = {}
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v
  }
  return res.json({ env: out, headers: stringMap(entry?.headers) ?? {} })
})

/**
 * Reveal the active project's root folder (where .mcp.json lives) in the OS file
 * explorer on the machine running the server.
 */
mcpRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const result = await revealFolderNative(project.rootPath)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: project.rootPath })
})

mcpRouter.post('/', (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })

  const { name } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }

  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  if (data.mcpServers[name]) {
    return res.status(400).json({ error: 'server already exists' })
  }

  const entry = sanitizeEntry(req.body)
  // The browser can't know this machine's home directory, so it never sends a
  // profile path — fill in (or correct) it here. See normalizePlaywrightProfile.
  if (name === 'playwright') normalizePlaywrightProfile(entry)
  data.mcpServers[name] = entry

  writeMcp(file, data)
  return res.status(201).json({ ok: true })
})

/**
 * Servers the portal has its own code paths for. Their NAME is load-bearing: the
 * tracker token resolvers (clickup.ts / jira.ts / azure.ts), Playwright's run mode and
 * QC-browser attach, and the qc-testing skill's `mcp__playwright__*` tools all look an
 * entry up by it. Renaming one AWAY is allowed — the engineer asked for it, and the
 * rename dialog spells out what stops working — but nothing may be renamed ONTO one:
 * the portal would start rewriting that server's args as if it were Playwright.
 */
const BUILTIN_SERVERS = new Set(['clickup', 'figma', 'jira', 'azure', 'playwright', 'maestro'])

/** Same rule `claude mcp add` enforces — anything else the CLI can't address. */
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') clean[k] = v
  return Object.keys(clean).length ? clean : undefined
}

/**
 * An http/sse server's `oauth` block — what `claude mcp add --client-id … --callback-port …`
 * writes for a provider that needs a pre-registered OAuth client. Only plain values
 * survive, and never anything secret-named: the CLI keeps a client secret in its own
 * credential store, so one found here would be a leak into the repo, not config.
 */
function sanitizeOauth(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const clean: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(value)) {
    if (/secret/i.test(k)) continue
    if (k === 'callbackPort') {
      const port = Number(v)
      if (Number.isInteger(port) && port > 0 && port < 65536) clean[k] = port
      continue
    }
    if (typeof v === 'string' ? v.trim() : typeof v === 'number' || typeof v === 'boolean') {
      clean[k] = typeof v === 'string' ? v.trim() : v
    }
  }
  return Object.keys(clean).length ? clean : undefined
}

/** Keep only the .mcp.json fields Claude Code reads, with the right types. */
function sanitizeEntry(raw: Record<string, unknown>): McpEntry {
  const { command, args, url, env, type, headers, cwd, oauth } = raw
  const entry: McpEntry = {}
  if (typeof type === 'string' && type.trim()) entry.type = type.trim()
  if (typeof command === 'string' && command.trim()) entry.command = command.trim()
  if (Array.isArray(args)) entry.args = args.filter((a): a is string => typeof a === 'string')
  if (typeof url === 'string' && url.trim()) entry.url = url.trim()
  if (typeof cwd === 'string' && cwd.trim()) entry.cwd = cwd.trim()
  const cleanEnv = stringMap(env)
  if (cleanEnv) entry.env = cleanEnv
  const cleanHeaders = stringMap(headers)
  if (cleanHeaders) entry.headers = cleanHeaders
  const cleanOauth = entry.url ? sanitizeOauth(oauth) : undefined
  if (cleanOauth) entry.oauth = cleanOauth
  return entry
}

/**
 * Add one or more servers in one write — the "Paste JSON" and template dialogs.
 * Body: `{ servers: { name: entry } }`. The browser already unwrapped whatever shape
 * was pasted (`{mcpServers:{…}}`, a bare map, a single entry); this re-validates
 * every name and entry and refuses the WHOLE batch on any problem, so a paste never
 * lands half-applied. A name already in use is a conflict, never an overwrite —
 * replacing a working server by pasting over it is too easy to do by accident.
 */
mcpRouter.post('/import', (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })
  const project = resolveProject(req)!

  const servers = req.body?.servers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return res.status(400).json({ error: 'servers must be an object of { name: config }' })
  }
  const names = Object.keys(servers)
  if (!names.length) return res.status(400).json({ error: 'no servers to add' })

  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  const local = localProjectMcpServers(project.rootPath)
  const entries: Record<string, McpEntry> = {}
  for (const name of names) {
    if (!SERVER_NAME_RE.test(name)) {
      return res.status(400).json({
        error: `"${name}" is not a valid server name — use letters, numbers, - and _ only (max 64).`,
      })
    }
    if (name in data.mcpServers || name in local) {
      return res.status(409).json({ error: `A server named "${name}" already exists — rename it first.` })
    }
    const raw = (servers as Record<string, unknown>)[name]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return res.status(400).json({ error: `"${name}" must be an object.` })
    }
    const entry = sanitizeEntry(raw as Record<string, unknown>)
    if (!entry.command && !entry.url) {
      return res.status(400).json({ error: `"${name}" needs a "command" (stdio) or a "url" (http/sse).` })
    }
    if (entry.url && !/^https?:\/\//i.test(entry.url)) {
      return res.status(400).json({ error: `"${name}" url must start with http:// or https://.` })
    }
    if (entry.url && !entry.type) entry.type = 'http'
    if (name === 'playwright') normalizePlaywrightProfile(entry)
    entries[name] = entry
  }
  Object.assign(data.mcpServers, entries)
  writeMcp(file, data)
  return res.status(201).json({ ok: true, added: names })
})

/** Swap `from` for `to` in an approval list, keeping its position. */
function renameInList(value: unknown, from: string, to: string): string[] | undefined {
  const list = asStringArray(value)
  if (!list.includes(from)) return undefined
  return [...new Set(list.map((v) => (v === from ? to : v)))]
}

/** Rebuild an object with one key renamed, so the entry keeps its place in the file. */
function renameKey<T>(obj: Record<string, T>, from: string, to: string): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k === from ? to : k, v]))
}

/**
 * Rename a server. Moves the entry in .mcp.json (or the local ~/.claude.json scope,
 * whichever holds it) and carries its approval over, so a renamed server doesn't
 * drop back to "Pending approval". Renaming onto a built-in name is refused — see
 * BUILTIN_SERVERS.
 */
/**
 * Move server `from` to `to` in whichever scope holds it, carrying its approval with
 * it. Checks everything BEFORE touching a file, so a refusal leaves no half-rename.
 */
function renameServer(
  rootPath: string,
  from: string,
  to: string,
): { status: number; error?: string } {
  if (!SERVER_NAME_RE.test(to)) {
    return { status: 400, error: 'Use letters, numbers, - and _ only (max 64).' }
  }
  if (to === from) return { status: 200 }
  if (BUILTIN_SERVERS.has(to)) {
    return { status: 400, error: `"${to}" is reserved for the portal's built-in ${to} server.` }
  }

  const file = mcpJsonFor(rootPath)
  const data = readMcp(file)
  const projectServers = data.mcpServers ?? {}
  const local = localProjectMcpServers(rootPath)
  if (to in projectServers || to in local) {
    return { status: 409, error: `A server named "${to}" already exists.` }
  }

  if (from in projectServers) {
    data.mcpServers = renameKey(projectServers, from, to)
    writeMcp(file, data)
  } else if (!(from in local)) {
    return { status: 404, error: `No server named "${from}".` }
  }

  // ~/.claude.json: the local-scope entry (if that's where it lives) and the approval.
  const config = readClaudeConfig()
  let configChanged = false
  for (const key of new Set([claudeProjectKey(rootPath), rootPath])) {
    const entry = config.projects?.[key]
    if (!entry) continue
    if (entry.mcpServers && from in entry.mcpServers) {
      entry.mcpServers = renameKey(entry.mcpServers, from, to)
      configChanged = true
    }
    for (const field of ['enabledMcpjsonServers', 'disabledMcpjsonServers'] as const) {
      const next = renameInList(entry[field], from, to)
      if (next) {
        entry[field] = next
        configChanged = true
      }
    }
  }
  if (configChanged) writeClaudeConfig(config)

  // Older CLIs read the approval from .claude/settings.local.json.
  const settingsFile = path.join(rootPath, '.claude', 'settings.local.json')
  if (fs.existsSync(settingsFile)) {
    const settings = readClaudeProjectSettings(settingsFile)
    let changed = false
    for (const field of ['enabledMcpjsonServers', 'disabledMcpjsonServers'] as const) {
      const next = renameInList(settings[field], from, to)
      if (next) {
        settings[field] = next
        changed = true
      }
    }
    if (changed) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  }
  return { status: 200 }
}

mcpRouter.post('/:name/rename', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const to = typeof req.body?.newName === 'string' ? req.body.newName.trim() : ''
  const r = renameServer(project.rootPath, req.params.name, to)
  if (r.error) return res.status(r.status).json({ error: r.error })
  return res.json({ ok: true, name: to })
})

/**
 * Edit a server: replace its entry (the Edit dialog's Settings form or raw JSON) and
 * optionally rename it, in whichever scope holds it. Body: `{ entry, newName? }`.
 * The entry is validated like an import — and BEFORE the rename, so a bad entry
 * never leaves a server renamed with its old config.
 */
mcpRouter.put('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const from = req.params.name
  const to = typeof req.body?.newName === 'string' && req.body.newName.trim() ? req.body.newName.trim() : from

  const raw = req.body?.entry
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return res.status(400).json({ error: 'entry must be an object' })
  }
  const entry = sanitizeEntry(raw as Record<string, unknown>)
  if (!entry.command && !entry.url) {
    return res.status(400).json({ error: 'Needs a "command" (stdio) or a "url" (http/sse).' })
  }
  if (entry.url && !/^https?:\/\//i.test(entry.url)) {
    return res.status(400).json({ error: 'The url must start with http:// or https://.' })
  }
  if (entry.url && !entry.type) entry.type = 'http'
  // Same as POST /: the browser never knows this machine's Playwright profile path.
  if (to === 'playwright') normalizePlaywrightProfile(entry)
  // The Settings form has no field for a pre-registered OAuth client, so an edit
  // arrives without it. Carry it over while the url is unchanged — otherwise saving
  // an unrelated header silently breaks sign-in for that server.
  const prev =
    readMcp(mcpJsonFor(project.rootPath)).mcpServers?.[from] ??
    localProjectMcpServers(project.rootPath)[from]
  if (!entry.oauth && prev?.oauth && prev.url === entry.url) {
    const kept = sanitizeOauth(prev.oauth)
    if (kept) entry.oauth = kept
  }

  const r = renameServer(project.rootPath, from, to)
  if (r.error) return res.status(r.status).json({ error: r.error })

  const file = mcpJsonFor(project.rootPath)
  const data = readMcp(file)
  if (data.mcpServers && to in data.mcpServers) {
    data.mcpServers[to] = entry
    writeMcp(file, data)
  } else {
    // A local-scope entry lives in ~/.claude.json, under this project's key.
    const config = readClaudeConfig()
    let written = false
    for (const key of new Set([claudeProjectKey(project.rootPath), project.rootPath])) {
      const servers = config.projects?.[key]?.mcpServers
      if (servers && to in servers) {
        servers[to] = entry
        written = true
      }
    }
    if (!written) return res.status(404).json({ error: `No server named "${to}".` })
    writeClaudeConfig(config)
  }
  return res.json({ ok: true, name: to })
})

/** Live connection test for a single configured server. */
mcpRouter.get('/test/:name', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  let result = await testServer(project.rootPath, req.params.name)
  invalidateMcpHealth(project.rootPath)
  if (result.status === 'pending' && approveMcpJsonServer(project.rootPath, req.params.name)) {
    const retry = await testServer(project.rootPath, req.params.name)
    result = {
      ...retry,
      detail: retry.ok
        ? `Approved this project's MCP servers. ${retry.detail}`
        : `Approved this project's MCP servers, but connection still failed: ${retry.detail}`,
    }
  }

  // For a tracker (clickup/azure/jira), the handshake passing isn't enough —
  // verify the credentials actually authenticate, so "Test" catches an
  // expired/invalid/wrong token the list can't see.
  const trackerCheck = result.ok ? verifyTrackerAuth(req.params.name, project.rootPath) : null
  if (trackerCheck) {
    const v = await trackerCheck
    if (!v.ok) {
      result = { ok: false, status: 'needs-auth', detail: v.detail }
    }
  }

  // An approval may have just changed what `mcp list` reports — drop the memory.
  invalidateMcpHealth(project.rootPath)
  res.json(result)
})

/**
 * Functional test: actually USE a server's MCP via Claude (fetch a ClickUp ticket,
 * read a Figma design, or open+close a browser with Playwright). Body: { input? }.
 */
mcpRouter.post('/test-run/:name', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    const result = await runMcpCapabilityTest({
      rootPath: project.rootPath,
      name: req.params.name,
      input: typeof req.body?.input === 'string' ? req.body.input : '',
    })
    res.json(result)
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500
    res.status(status).json({ error: (err as Error).message })
  }
})

mcpRouter.delete('/:name', (req, res) => {
  const file = mcpPath(req)
  if (!file) return res.status(400).json({ error: 'project not found' })

  const data = readMcp(file)
  if (data.mcpServers && req.params.name in data.mcpServers) {
    delete data.mcpServers[req.params.name]
    writeMcp(file, data)
  }
  const project = resolveProject(req)
  if (project) removeLocalProjectMcpServer(project.rootPath, req.params.name)
  return res.json({ ok: true })
})

// ============================ OAuth ("click → authenticate") ============================

type ProviderId = 'clickup' | 'figma' | 'jira' | 'azure'

/**
 * `uvx` args for clickup-mcp — one definition, used by both entry builders.
 *
 * `--with mcp<2` is load-bearing: clickup-mcp is installed from git HEAD with no lock,
 * so uvx resolves the NEWEST `mcp` SDK, and mcp 2.x removed `Server.list_tools` — the
 * server then exits on start ("'Server' object has no attribute 'list_tools'"), which
 * the MCP page can only report as CONNECTION_CLOSED. Measured 2026-09-24 against
 * mcp 2.2.0; `mcp<2` starts cleanly. Existing entries get the same pin from
 * `pinClickupMcpSdk` (run by repairProjectMcpConfig).
 */
const CLICKUP_MCP_PIN = ['--with', 'mcp<2']
const CLICKUP_MCP_ARGS = [
  ...CLICKUP_MCP_PIN,
  '--from',
  'git+https://github.com/DiversioTeam/clickup-mcp.git',
  'clickup-mcp',
]

interface ProviderDef {
  /** Server name written into .mcp.json. */
  serverName: string
  /** True when OAuth app credentials are configured on the server. */
  hasApp: () => boolean
  /** Build the provider authorize URL the browser is sent to. */
  authorizeUrl: (redirectUri: string, state: string) => string
  /** Exchange the returned code for an access token. */
  exchange: (code: string, redirectUri: string) => Promise<string>
  /** Build the .mcp.json entry that uses the obtained token. */
  buildEntry: (token: string) => McpEntry
}

const PROVIDERS: Record<ProviderId, ProviderDef> = {
  clickup: {
    serverName: 'clickup',
    hasApp: () => !!OAUTH_APPS.clickup.clientId && !!OAUTH_APPS.clickup.clientSecret,
    authorizeUrl: (redirectUri, state) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.clickup.clientId,
        redirect_uri: redirectUri,
        state,
      })
      return `https://app.clickup.com/api?${p.toString()}`
    },
    exchange: async (code, _redirectUri) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.clickup.clientId,
        client_secret: OAUTH_APPS.clickup.clientSecret,
        code,
      })
      const r = await fetch(`https://api.clickup.com/api/v2/oauth/token?${p.toString()}`, {
        method: 'POST',
      })
      const j = (await r.json()) as { access_token?: string; err?: string }
      if (!r.ok || !j.access_token) {
        throw new Error(j.err || `ClickUp token exchange failed (${r.status})`)
      }
      return j.access_token
    },
    // Current clickup-mcp reads CLICKUP_MCP_API_KEY; older builds read
    // CLICKUP_API_KEY. Set both so either version starts.
    buildEntry: (token) => ({
      type: 'stdio',
      command: 'uvx',
      args: CLICKUP_MCP_ARGS,
      env: { CLICKUP_API_KEY: token, CLICKUP_MCP_API_KEY: token },
    }),
  },
  figma: {
    serverName: 'figma',
    hasApp: () => !!OAUTH_APPS.figma.clientId && !!OAUTH_APPS.figma.clientSecret,
    authorizeUrl: (redirectUri, state) => {
      const p = new URLSearchParams({
        client_id: OAUTH_APPS.figma.clientId,
        redirect_uri: redirectUri,
        scope: OAUTH_APPS.figma.scope,
        state,
        response_type: 'code',
      })
      return `https://www.figma.com/oauth?${p.toString()}`
    },
    exchange: async (code, redirectUri) => {
      // Figma's v1 token endpoint takes client creds via HTTP Basic auth.
      const basic = Buffer.from(
        `${OAUTH_APPS.figma.clientId}:${OAUTH_APPS.figma.clientSecret}`,
      ).toString('base64')
      const body = new URLSearchParams({
        redirect_uri: redirectUri,
        code,
        grant_type: 'authorization_code',
      })
      const r = await fetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })
      const j = (await r.json()) as { access_token?: string; message?: string; error?: string }
      if (!r.ok || !j.access_token) {
        throw new Error(j.message || j.error || `Figma token exchange failed (${r.status})`)
      }
      return j.access_token
    },
    // Pass the OAuth bearer explicitly via the documented CLI flag.
    buildEntry: (token) => ({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'figma-developer-mcp', '--stdio', '--figma-oauth-token', token],
    }),
  },
  // Jira has no OAuth app here — it is token-connect only (site URL + email +
  // API token). The OAuth stubs throw because hasApp() is false, so the
  // /oauth/:provider/start path is blocked before they can be reached.
  jira: {
    serverName: 'jira',
    hasApp: () => false,
    authorizeUrl: () => {
      throw new Error('Jira uses token connect, not OAuth')
    },
    exchange: async () => {
      throw new Error('Jira uses token connect, not OAuth')
    },
    buildEntry: () => {
      throw new Error('Jira uses token connect, not OAuth')
    },
  },
  // Azure DevOps Boards — token-connect only (org URL + Personal Access Token).
  // Same OAuth stubs-throw shape as Jira.
  azure: {
    serverName: 'azure',
    hasApp: () => false,
    authorizeUrl: () => {
      throw new Error('Azure DevOps uses token connect, not OAuth')
    },
    exchange: async () => {
      throw new Error('Azure DevOps uses token connect, not OAuth')
    },
    buildEntry: () => {
      throw new Error('Azure DevOps uses token connect, not OAuth')
    },
  },
}

function isProviderId(v: string): v is ProviderId {
  return v === 'clickup' || v === 'figma' || v === 'jira' || v === 'azure'
}

// Where the user grabs a personal API token for each provider (token-connect flow).
const TOKEN_URLS: Record<ProviderId, string> = {
  clickup: 'https://app.clickup.com/settings/apps',
  figma: 'https://www.figma.com/settings',
  jira: 'https://id.atlassian.com/manage-profile/security/api-tokens',
  // ADO PATs are created per-organization; this is the generic tokens page.
  azure: 'https://dev.azure.com',
}

/**
 * Build the .mcp.json entry for a pasted PERSONAL API token (not an OAuth
 * bearer). ClickUp's CLI reads CLICKUP_API_KEY (older builds: CLICKUP_MCP_API_KEY
 * — we set both); Figma's personal-access-token path is FIGMA_API_KEY. Jira
 * (mcp-atlassian) needs a site URL + account email alongside the API token.
 */
function buildTokenEntry(
  provider: ProviderId,
  token: string,
  extra?: { url?: string; email?: string; orgUrl?: string; project?: string },
): McpEntry {
  if (provider === 'clickup') {
    return {
      type: 'stdio',
      command: 'uvx',
      args: CLICKUP_MCP_ARGS,
      env: { CLICKUP_API_KEY: token, CLICKUP_MCP_API_KEY: token },
    }
  }
  if (provider === 'jira') {
    // mcp-atlassian auto-enables only Jira tools when just the JIRA_* vars are set.
    return {
      type: 'stdio',
      command: 'uvx',
      args: ['mcp-atlassian'],
      env: {
        JIRA_URL: extra?.url ?? '',
        JIRA_USERNAME: extra?.email ?? '',
        JIRA_API_TOKEN: token,
      },
    }
  }
  if (provider === 'azure') {
    // Azure DevOps Boards via the PAT-based community server (works headless,
    // unlike the official server's default interactive browser login).
    const env: Record<string, string> = {
      AZURE_DEVOPS_ORG_URL: extra?.orgUrl ?? '',
      AZURE_DEVOPS_AUTH_METHOD: 'pat',
      AZURE_DEVOPS_PAT: token,
    }
    if (extra?.project) env.AZURE_DEVOPS_DEFAULT_PROJECT = extra.project
    return {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@tiberriver256/mcp-server-azure-devops'],
      env,
    }
  }
  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', 'figma-developer-mcp', '--stdio'],
    env: { FIGMA_API_KEY: token },
  }
}

function redirectUriFor(provider: ProviderId): string {
  return `${OAUTH_REDIRECT_BASE}/api/mcp/oauth/${provider}/callback`
}

/** Open a URL in the user's default browser (server runs on their machine). */
function openBrowser(url: string): void {
  const platform = process.platform
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    execFile(cmd, args, { windowsHide: true }, () => {}) // hide the transient cmd window
  } catch {
    /* best-effort; the UI also surfaces the URL */
  }
}

// In-memory pending-auth store, keyed by state. Lost on restart, which is fine —
// an interrupted auth just needs to be retried.
interface Pending {
  provider: ProviderId
  projectId: string
  rootPath: string
  createdAt: number
  result?: { ok: true } | { ok: false; error: string }
}
const pending = new Map<string, Pending>()

function prunePending(): void {
  const cutoff = Date.now() - 10 * 60 * 1000 // 10 minutes
  for (const [state, p] of pending) if (p.createdAt < cutoff) pending.delete(state)
}

/** Which providers can be authenticated, and whether each is already configured. */
mcpRouter.get('/oauth/status', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const servers = readMcp(mcpJsonFor(project.rootPath)).mcpServers ?? {}
  const status = (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
    provider: id,
    hasApp: PROVIDERS[id].hasApp(),
    configured: PROVIDERS[id].serverName in servers,
    tokenUrl: TOKEN_URLS[id],
  }))
  res.json({ redirectBase: OAUTH_REDIRECT_BASE, providers: status })
})

/**
 * Token-connect: save a pasted personal API token into this project's
 * .mcp.json. No OAuth app required — the user copies a token from the
 * provider's settings page and pastes it back.
 */
mcpRouter.post('/oauth/:provider/token', (req, res) => {
  const providerId = req.params.provider
  if (!isProviderId(providerId)) return res.status(404).json({ error: 'unknown provider' })
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : ''
  if (!token) return res.status(400).json({ error: 'token is required' })

  let extra: { url?: string; email?: string; orgUrl?: string; project?: string } | undefined
  if (providerId === 'jira') {
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : ''
    if (!url || !email) {
      return res.status(400).json({ error: 'Jira needs a site URL and account email' })
    }
    extra = { url: url.replace(/\/+$/, ''), email } // drop any trailing slash on the site URL
  } else if (providerId === 'azure') {
    const orgUrl = typeof req.body?.orgUrl === 'string' ? req.body.orgUrl.trim() : ''
    const project = typeof req.body?.project === 'string' ? req.body.project.trim() : ''
    if (!orgUrl) {
      return res
        .status(400)
        .json({ error: 'Azure DevOps needs an organization URL, e.g. https://dev.azure.com/your-org' })
    }
    extra = { orgUrl: orgUrl.replace(/\/+$/, ''), project: project || undefined }
  }

  const file = mcpJsonFor(project.rootPath)
  const data = readMcp(file)
  if (!data.mcpServers) data.mcpServers = {}
  data.mcpServers[PROVIDERS[providerId].serverName] = buildTokenEntry(providerId, token, extra)
  writeMcp(file, data)
  return res.status(201).json({ ok: true })
})

/** Begin an OAuth flow: open the browser to the provider's consent screen. */
mcpRouter.post('/oauth/:provider/start', (req, res) => {
  const providerId = req.params.provider
  if (!isProviderId(providerId)) return res.status(404).json({ error: 'unknown provider' })
  const def = PROVIDERS[providerId]
  if (!def.hasApp()) {
    return res.status(400).json({
      error: `${providerId} OAuth app is not configured. Set ${providerId.toUpperCase()}_OAUTH_CLIENT_ID and ${providerId.toUpperCase()}_OAUTH_CLIENT_SECRET in the server environment, and register the redirect URI ${redirectUriFor(providerId)}.`,
    })
  }
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  prunePending()
  const state = crypto.randomUUID()
  pending.set(state, {
    provider: providerId,
    projectId: project.id,
    rootPath: project.rootPath,
    createdAt: Date.now(),
  })

  const redirectUri = redirectUriFor(providerId)
  const authorizeUrl = def.authorizeUrl(redirectUri, state)
  openBrowser(authorizeUrl)
  res.json({ state, authorizeUrl })
})

/** Poll the result of an in-flight auth (frontend polls until done). */
mcpRouter.get('/oauth/:provider/result', (req, res) => {
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const p = pending.get(state)
  if (!p) return res.json({ status: 'unknown' })
  if (!p.result) return res.json({ status: 'pending' })
  if (p.result.ok) {
    pending.delete(state)
    return res.json({ status: 'done' })
  }
  const error = p.result.error
  pending.delete(state)
  return res.json({ status: 'error', error })
})

function resultPage(title: string, message: string, ok: boolean): string {
  const color = ok ? '#059669' : '#dc2626'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#f8fafc;color:#0f172a}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:32px 40px;box-shadow:0 8px 24px -6px rgba(15,23,42,.12);text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 8px;color:${color}}p{margin:0;color:#64748b}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div>
<script>setTimeout(()=>window.close(),2500)</script></body></html>`
}

/** OAuth redirect target: exchange the code, write the server into .mcp.json. */
mcpRouter.get('/oauth/:provider/callback', async (req, res) => {
  const providerId = req.params.provider
  res.set('Content-Type', 'text/html')
  if (!isProviderId(providerId)) {
    return res.status(404).send(resultPage('Unknown provider', 'Nothing to do here.', false))
  }
  const def = PROVIDERS[providerId]
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const state = typeof req.query.state === 'string' ? req.query.state : ''
  const oauthErr = typeof req.query.error === 'string' ? req.query.error : ''

  // Match by state; fall back to the sole pending auth for this provider when
  // the provider doesn't echo `state` back (ClickUp historically omits it).
  let p = state ? pending.get(state) : undefined
  if (!p) {
    const sameProvider = [...pending.values()].filter((x) => x.provider === providerId && !x.result)
    if (sameProvider.length === 1) p = sameProvider[0]
  }
  if (oauthErr) {
    if (p) p.result = { ok: false, error: oauthErr }
    return res
      .status(400)
      .send(resultPage('Authorization canceled', `${providerId}: ${oauthErr}`, false))
  }
  if (!code || !p) {
    return res
      .status(400)
      .send(resultPage('Invalid callback', 'Missing or expired authorization. Try again.', false))
  }

  try {
    const token = await def.exchange(code, redirectUriFor(providerId))
    const file = mcpJsonFor(p.rootPath)
    const data = readMcp(file)
    if (!data.mcpServers) data.mcpServers = {}
    data.mcpServers[def.serverName] = def.buildEntry(token)
    writeMcp(file, data)
    p.result = { ok: true }
    return res.send(
      resultPage(
        `${def.serverName} connected`,
        'Authentication succeeded. You can close this tab and return to QC Portal.',
        true,
      ),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed'
    p.result = { ok: false, error: message }
    return res.status(500).send(resultPage('Authentication failed', message, false))
  }
})
