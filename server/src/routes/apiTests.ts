import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { testingDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { runClaude, parseClaudeJsonResult, CRAWL_SUMMARY_MODELS } from '../claudeExec.js'

export const apiTestsRouter = Router()

/**
 * API Testing — a lightweight, project-scoped REST client for QC.
 *
 * Two independent concerns live here:
 *  1. `POST /send` proxies an HTTP request through the server. The browser can't
 *     call an arbitrary staging/localhost API itself (CORS + mixed content), so
 *     the server performs the request and returns the status/headers/body/timing.
 *     Mirrors the existing `/api/qc/check-url` proxy pattern; secrets in headers
 *     or the body are NEVER logged or persisted here.
 *  2. Saved requests ("collection") persist as plain JSON under
 *     <root>/testing/api-tests/<name>.json — versionable with the project and
 *     readable by the qc-testing skill. Storage mirrors routes/templates.ts.
 *  3. `POST /generate` drafts API tests from a crawled ticket via a cheap Claude
 *     pass (best-effort; strict JSON contract, validated before returning).
 */

// ---------------------------------------------------------------- shared shapes

interface ApiKV {
  key: string
  value: string
  enabled: boolean
}

type AssertionType =
  | 'status-equals'
  | 'status-2xx'
  | 'body-contains'
  | 'body-matches'
  | 'json-equals'
  | 'json-exists'
  | 'header-equals'
  | 'header-exists'
  | 'time-below'

interface ApiAssertion {
  id: string
  type: AssertionType
  target: string // JSON path / header name / expected status — meaning depends on type
  expected: string
  enabled: boolean
}

type BodyMode = 'none' | 'json' | 'text'

// A rule that, after a send, pulls a value out of the JSON response body (by dotted
// path) and stores it into the active environment as a variable — request chaining
// (e.g. capture `data.token` from login → reuse as {{token}} in later requests).
interface ApiCapture {
  id: string
  jsonPath: string
  varName: string
  secret: boolean
}

interface ApiRequestDef {
  name: string
  method: string
  url: string
  query: ApiKV[]
  headers: ApiKV[]
  bodyMode: BodyMode
  body: string
  assertions: ApiAssertion[]
  // Free-text, natural-language expectation the AI check evaluates the response against.
  aiExpect: string
  captures: ApiCapture[]
  savedAt?: string
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const ASSERTION_TYPES = new Set<AssertionType>([
  'status-equals',
  'status-2xx',
  'body-contains',
  'body-matches',
  'json-equals',
  'json-exists',
  'header-equals',
  'header-exists',
  'time-below',
])

const MAX_BODY_BYTES = 4 * 1024 * 1024 // cap the response we buffer/return at 4 MB
const DEFAULT_TIMEOUT = 30_000
const MAX_TIMEOUT = 120_000

// ---------------------------------------------------------------- sanitizers

function toKV(v: unknown): ApiKV[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      key: typeof r.key === 'string' ? r.key : '',
      value: typeof r.value === 'string' ? r.value : '',
      enabled: r.enabled !== false,
    }))
    .slice(0, 100)
}

function toAssertions(v: unknown): ApiAssertion[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r, i) => ({
      id: typeof r.id === 'string' && r.id ? r.id : `a${i}`,
      type: ASSERTION_TYPES.has(r.type as AssertionType)
        ? (r.type as AssertionType)
        : 'status-2xx',
      target: typeof r.target === 'string' ? r.target : '',
      expected: typeof r.expected === 'string' ? r.expected : '',
      enabled: r.enabled !== false,
    }))
    .slice(0, 50)
}

function toCaptures(v: unknown): ApiCapture[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r, i) => ({
      id: typeof r.id === 'string' && r.id ? r.id : `c${i}`,
      jsonPath: typeof r.jsonPath === 'string' ? r.jsonPath.slice(0, 200) : '',
      varName: typeof r.varName === 'string' ? r.varName.slice(0, 100) : '',
      secret: r.secret === true,
    }))
    .slice(0, 20)
}

function toRequestDef(name: string, b: Record<string, unknown>): ApiRequestDef {
  const method = typeof b.method === 'string' ? b.method.toUpperCase() : 'GET'
  const bodyMode: BodyMode =
    b.bodyMode === 'json' || b.bodyMode === 'text' ? (b.bodyMode as BodyMode) : 'none'
  return {
    name,
    method: HTTP_METHODS.has(method) ? method : 'GET',
    url: typeof b.url === 'string' ? b.url.slice(0, 4000) : '',
    query: toKV(b.query),
    headers: toKV(b.headers),
    bodyMode,
    body: typeof b.body === 'string' ? b.body.slice(0, MAX_BODY_BYTES) : '',
    assertions: toAssertions(b.assertions),
    aiExpect: typeof b.aiExpect === 'string' ? b.aiExpect.slice(0, 4000) : '',
    captures: toCaptures(b.captures),
  }
}

// ---------------------------------------------------------------- environments

// Named environments hold {{variable}} values (e.g. baseUrl, token) that are
// substituted into a request SERVER-SIDE at send time. Values flagged `secret` are
// stored on disk but never echoed back to the browser and never appear in the
// response's requestUrl — the browser only ever sends placeholders.
interface ApiVariable {
  key: string
  value: string
  secret: boolean
}
interface ApiEnvironment {
  name: string
  variables: ApiVariable[]
}
interface EnvironmentsFile {
  active: string | null
  environments: ApiEnvironment[]
}

const ENV_FILE = '_environments.json'
const VAR_KEY_RE = /^[\w.-]{1,100}$/
const ENV_NAME_RE = /^[\w .-]{1,40}$/
const MAX_ENVS = 20
const MAX_VARS = 100
const MAX_VAR_VALUE = 8192

function toVariable(v: unknown): ApiVariable | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const key = typeof r.key === 'string' ? r.key.trim() : ''
  if (!VAR_KEY_RE.test(key)) return null
  return {
    key,
    value: typeof r.value === 'string' ? r.value.slice(0, MAX_VAR_VALUE) : '',
    secret: r.secret === true,
  }
}

function toEnvironment(v: unknown): ApiEnvironment | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (!ENV_NAME_RE.test(name)) return null
  const byKey = new Map<string, ApiVariable>()
  if (Array.isArray(r.variables)) {
    for (const raw of r.variables.slice(0, MAX_VARS * 2)) {
      const parsed = toVariable(raw)
      if (parsed) byKey.set(parsed.key, parsed) // last write wins for a duplicate key
    }
  }
  return { name, variables: [...byKey.values()].slice(0, MAX_VARS) }
}

function toEnvironmentsFile(v: unknown): EnvironmentsFile {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const byName = new Map<string, ApiEnvironment>()
  if (Array.isArray(r.environments)) {
    for (const raw of r.environments.slice(0, MAX_ENVS * 2)) {
      const parsed = toEnvironment(raw)
      if (parsed) byName.set(parsed.name, parsed)
    }
  }
  const environments = [...byName.values()].slice(0, MAX_ENVS)
  const active =
    typeof r.active === 'string' && environments.some((e) => e.name === r.active)
      ? r.active
      : (environments[0]?.name ?? null)
  return { active, environments }
}

function environmentsFilePath(root: string): string {
  return path.join(collectionDir(root), ENV_FILE)
}

function readEnvironments(root: string): EnvironmentsFile {
  try {
    return toEnvironmentsFile(JSON.parse(fs.readFileSync(environmentsFilePath(root), 'utf8')))
  } catch {
    return { active: null, environments: [] }
  }
}

function writeEnvironments(root: string, file: EnvironmentsFile): void {
  fs.mkdirSync(collectionDir(root), { recursive: true })
  fs.writeFileSync(environmentsFilePath(root), JSON.stringify(file, null, 2), 'utf8')
}

/** Public (browser-facing) env shape: secret values are blanked, with a hasValue flag. */
function maskEnvironments(file: EnvironmentsFile) {
  return {
    active: file.active,
    environments: file.environments.map((e) => ({
      name: e.name,
      variables: e.variables.map((v) => ({
        key: v.key,
        value: v.secret ? '' : v.value,
        secret: v.secret,
        hasValue: v.secret ? v.value.length > 0 : undefined,
      })),
    })),
  }
}

/**
 * A secret variable submitted with an empty value means "unchanged" (the UI never
 * received the real value), so carry the stored value forward. To clear a secret the
 * user deletes the row.
 */
function mergeSecrets(incoming: EnvironmentsFile, existing: EnvironmentsFile): EnvironmentsFile {
  for (const env of incoming.environments) {
    const prev = existing.environments.find((e) => e.name === env.name)
    if (!prev) continue
    for (const v of env.variables) {
      if (v.secret && v.value === '') {
        const prevVar = prev.variables.find((p) => p.key === v.key)
        if (prevVar && prevVar.value) v.value = prevVar.value
      }
    }
  }
  return incoming
}

/** The active environment's variables as key → {value, secret}. Empty when none. */
function resolveActiveVars(root: string): Map<string, { value: string; secret: boolean }> {
  const file = readEnvironments(root)
  const env = file.environments.find((e) => e.name === file.active)
  const map = new Map<string, { value: string; secret: boolean }>()
  if (env) for (const v of env.variables) map.set(v.key, { value: v.value, secret: v.secret })
  return map
}

const VAR_TOKEN_RE = /\{\{\s*([\w.-]+)\s*\}\}/g

/**
 * Substitute {{key}} tokens using the given vars.
 *  - `display` mode keeps secret vars as their {{placeholder}} so real values never
 *    surface in anything echoed back to the browser.
 *  - Unknown keys are left as-is and reported in `unresolved` so callers can flag them.
 */
function substituteVars(
  input: string,
  vars: Map<string, { value: string; secret: boolean }>,
  opts: { display?: boolean } = {},
): { out: string; unresolved: Set<string> } {
  const unresolved = new Set<string>()
  const out = input.replace(VAR_TOKEN_RE, (m, key: string) => {
    const v = vars.get(key)
    if (!v) {
      unresolved.add(key)
      return m
    }
    return opts.display && v.secret ? m : v.value
  })
  return { out, unresolved }
}

/** Put {{key}} back wherever a secret value appears — for anything echoed to the UI. */
function maskSecrets(s: string, vars: Map<string, { value: string; secret: boolean }>): string {
  let out = s
  for (const [key, v] of vars) {
    if (v.secret && v.value) out = out.split(v.value).join(`{{${key}}}`)
  }
  return out
}

// ---------------------------------------------------------------- send (proxy)

apiTestsRouter.post('/send', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const method = (typeof body.method === 'string' ? body.method : 'GET').toUpperCase()
  if (!HTTP_METHODS.has(method)) {
    return res.status(400).json({ error: `unsupported method: ${method}` })
  }
  // Resolve the active environment's {{variables}} SERVER-SIDE — the browser only ever
  // sends placeholders, so secret values (tokens/passwords) never travel to the client.
  const project = resolveProject(req)
  const vars = project
    ? resolveActiveVars(project.rootPath)
    : new Map<string, { value: string; secret: boolean }>()

  const rawUrlInput = typeof body.url === 'string' ? body.url.trim() : ''
  const urlSub = substituteVars(rawUrlInput, vars)
  // Unknown {{tokens}} in the URL/query break routing — fail loud with the names.
  const unresolved = new Set(urlSub.unresolved)
  let url: URL
  try {
    url = new URL(urlSub.out)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol')
  } catch {
    return res.status(400).json({ error: 'Enter a full http:// or https:// URL.' })
  }

  // Append enabled query params (both key and value support {{variables}}).
  for (const p of toKV(body.query)) {
    if (!p.enabled || !p.key) continue
    const k = substituteVars(p.key, vars)
    const v = substituteVars(p.value, vars)
    k.unresolved.forEach((u) => unresolved.add(u))
    v.unresolved.forEach((u) => unresolved.add(u))
    url.searchParams.append(k.out, v.out)
  }

  if (unresolved.size) {
    return res.status(400).json({
      error: `Unknown variable(s): ${[...unresolved].map((k) => `{{${k}}}`).join(', ')} — define them in the active environment.`,
    })
  }

  const headers = new Headers()
  for (const h of toKV(body.headers)) {
    if (h.enabled && h.key) {
      try {
        // append, not set — a request may legitimately carry repeated header keys
        // (e.g. multiple Cookie / X-Forwarded-For rows); set() would drop all but one.
        headers.append(substituteVars(h.key, vars).out, substituteVars(h.value, vars).out)
      } catch {
        /* skip an invalid header name rather than failing the whole request */
      }
    }
  }

  const bodyMode: BodyMode =
    body.bodyMode === 'json' || body.bodyMode === 'text' ? (body.bodyMode as BodyMode) : 'none'
  let sendBody: string | undefined
  if (method !== 'GET' && method !== 'HEAD' && bodyMode !== 'none') {
    sendBody = typeof body.body === 'string' ? substituteVars(body.body, vars).out : ''
    if (bodyMode === 'json' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
  }

  // What we echo back / store must never contain a secret value — re-mask them.
  const displayUrl = maskSecrets(url.toString(), vars)

  const timeoutMs = Math.min(
    MAX_TIMEOUT,
    Math.max(1000, Number(body.timeoutMs) || DEFAULT_TIMEOUT),
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: sendBody,
      redirect: 'follow',
      signal: controller.signal,
    })
    const buf = Buffer.from(await resp.arrayBuffer())
    const truncated = buf.length > MAX_BODY_BYTES
    const bodyText = buf.subarray(0, MAX_BODY_BYTES).toString('utf8')
    const respHeaders: Record<string, string> = {}
    resp.headers.forEach((value, key) => {
      respHeaders[key] = value
    })
    // forEach comma-joins repeated headers, which mangles Set-Cookie (cookie values
    // contain commas, e.g. `Expires=Wed, 09 Jun ...`). Rebuild it from the discrete
    // cookies, newline-joined, so downstream cookie-flag checks parse each one.
    const setCookies =
      typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : []
    if (setCookies.length) respHeaders['set-cookie'] = setCookies.join('\n')
    return res.json({
      ok: true,
      status: resp.status,
      statusText: resp.statusText,
      headers: respHeaders,
      contentType: resp.headers.get('content-type') ?? '',
      bodyText,
      sizeBytes: buf.length,
      truncated,
      timeMs: Date.now() - started,
      requestUrl: displayUrl,
      method,
    })
  } catch (err) {
    const timedOut = controller.signal.aborted
    const raw =
      err instanceof Error
        ? ((err.cause as Error | undefined)?.message ?? err.message)
        : 'Request failed'
    const error = timedOut
      ? `Timed out after ${Math.round(timeoutMs / 1000)}s — the API did not respond.`
      : raw.includes('ENOTFOUND')
        ? 'Host not found — check the domain for typos.'
        : raw.includes('ECONNREFUSED')
          ? 'Connection refused — nothing is listening at that address.'
          : raw.includes('CERT') || raw.includes('certificate')
            ? `TLS certificate problem (${raw}).`
            : raw
    return res.json({
      ok: false,
      error,
      timeMs: Date.now() - started,
      requestUrl: displayUrl,
      method,
    })
  } finally {
    clearTimeout(timer)
  }
})

// ---------------------------------------------------------------- AI check

// A cheap Claude pass that judges a response against the QC engineer's plain-language
// expectation (and flags any correctness/security issues it notices). Complements the
// deterministic assertions + rule-based scan on the client — this reads intent.
const AI_CHECK_MAX_BODY = 16_000

/** Pull the first {...} JSON object out of a model reply (tolerant of fences/prose). */
function extractJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  if (!s.startsWith('{')) {
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a >= 0 && b > a) s = s.slice(a, b + 1)
  }
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

apiTestsRouter.post('/ai-check', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const body = (req.body ?? {}) as Record<string, unknown>
  const expect = typeof body.expect === 'string' ? body.expect.trim() : ''
  if (!expect) return res.status(400).json({ error: 'expect (what you expect) is required' })
  const model =
    typeof body.model === 'string' && CRAWL_SUMMARY_MODELS.has(body.model.trim())
      ? body.model.trim()
      : 'haiku'

  const request = (body.request ?? {}) as Record<string, unknown>
  const result = (body.result ?? {}) as Record<string, unknown>
  const method = typeof request.method === 'string' ? request.method : ''
  const url = typeof request.url === 'string' ? request.url : ''
  const status = Number(result.status) || 0
  const statusText = typeof result.statusText === 'string' ? result.statusText : ''
  const contentType = typeof result.contentType === 'string' ? result.contentType : ''
  const timeMs = Number(result.timeMs) || 0
  const headers =
    result.headers && typeof result.headers === 'object'
      ? JSON.stringify(result.headers).slice(0, 4000)
      : '{}'
  const bodyText =
    typeof result.bodyText === 'string' ? result.bodyText.slice(0, AI_CHECK_MAX_BODY) : ''

  const prompt = [
    `You are a senior QC engineer reviewing one HTTP API response against what the tester expects.`,
    `Judge ONLY from the response shown. Be strict and specific; do not invent data.`,
    ``,
    `REQUEST: ${method} ${url}`,
    `RESPONSE STATUS: ${status} ${statusText}`,
    `RESPONSE TIME: ${timeMs} ms`,
    `RESPONSE CONTENT-TYPE: ${contentType}`,
    `RESPONSE HEADERS (JSON): ${headers}`,
    `RESPONSE BODY (may be truncated):`,
    bodyText || '(empty body)',
    ``,
    `WHAT THE TESTER EXPECTS (plain language, may list several points):`,
    expect,
    ``,
    `Break the expectation into individual checkable points. For each, decide pass/fail from the`,
    `response and give a one-line reason citing the concrete value you saw. Also list any correctness`,
    `or security issues you notice (wrong status, leaked errors/secrets, missing fields, etc.).`,
    `Reply with ONLY this JSON (no prose, no code fences):`,
    `{"verdict":"pass|fail|partial","summary":"one sentence",`,
    `"checks":[{"expectation":"...","pass":true,"note":"..."}],`,
    `"issues":[{"severity":"high|warn|info","title":"...","detail":"..."}]}`,
  ].join('\n')

  const r = await runClaude(['-p', '--output-format', 'json', '--model', model], 120_000, {
    usageSource: 'api-ai-check',
    model,
    input: prompt,
  })
  const { text } = parseClaudeJsonResult(r.stdout)
  const parsed = extractJsonObject(text)
  if (!parsed) {
    return res.json({
      ok: false,
      error: r.timedOut ? 'AI check timed out.' : 'The AI check did not return a usable result.',
    })
  }

  // Normalize into a safe, bounded shape.
  const sev = (v: unknown): 'high' | 'warn' | 'info' =>
    v === 'high' || v === 'warn' || v === 'info' ? v : 'info'
  const verdict =
    parsed.verdict === 'pass' || parsed.verdict === 'fail' || parsed.verdict === 'partial'
      ? parsed.verdict
      : 'partial'
  const checks = Array.isArray(parsed.checks)
    ? (parsed.checks as Record<string, unknown>[]).slice(0, 40).map((c) => ({
        expectation: typeof c?.expectation === 'string' ? c.expectation.slice(0, 400) : '',
        pass: c?.pass === true,
        note: typeof c?.note === 'string' ? c.note.slice(0, 600) : '',
      }))
    : []
  const issues = Array.isArray(parsed.issues)
    ? (parsed.issues as Record<string, unknown>[]).slice(0, 40).map((i) => ({
        severity: sev(i?.severity),
        title: typeof i?.title === 'string' ? i.title.slice(0, 200) : '',
        detail: typeof i?.detail === 'string' ? i.detail.slice(0, 600) : '',
      }))
    : []
  return res.json({
    ok: true,
    verdict,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 600) : '',
    checks,
    issues,
  })
})

// ---------------------------------------------------------------- environments (routes)
// Registered BEFORE the `/:name` collection routes so `PUT /environments` isn't
// captured as a saved-request name.

/** GET /api/api-tests/environments — active env + all envs (secret values masked). */
apiTestsRouter.get('/environments', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(maskEnvironments(readEnvironments(project.rootPath)))
})

/** PUT /api/api-tests/environments — replace the env set (secret values preserved). */
apiTestsRouter.put('/environments', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const existing = readEnvironments(project.rootPath)
  const merged = mergeSecrets(toEnvironmentsFile(req.body ?? {}), existing)
  writeEnvironments(project.rootPath, merged)
  res.json(maskEnvironments(merged))
})

/**
 * POST /api/api-tests/environments/capture — upsert one variable from a response
 * capture. Targets the named env, else the active env, else a new "Default".
 */
apiTestsRouter.post('/environments/capture', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const b = (req.body ?? {}) as Record<string, unknown>
  const key = typeof b.key === 'string' ? b.key.trim() : ''
  if (!VAR_KEY_RE.test(key)) return res.status(400).json({ error: 'invalid variable name' })
  const value = typeof b.value === 'string' ? b.value.slice(0, MAX_VAR_VALUE) : ''
  const secret = b.secret === true
  const wantEnv = typeof b.env === 'string' && b.env.trim() ? b.env.trim() : ''

  const file = readEnvironments(project.rootPath)
  let targetName = wantEnv || file.active || 'Default'
  if (!ENV_NAME_RE.test(targetName)) targetName = 'Default'
  let env = file.environments.find((e) => e.name === targetName)
  if (!env) {
    if (file.environments.length >= MAX_ENVS) {
      return res.status(422).json({ error: 'environment limit reached' })
    }
    env = { name: targetName, variables: [] }
    file.environments.push(env)
  }
  const existingVar = env.variables.find((v) => v.key === key)
  if (existingVar) {
    existingVar.value = value
    existingVar.secret = secret || existingVar.secret
  } else {
    if (env.variables.length >= MAX_VARS) {
      return res.status(422).json({ error: 'variable limit reached' })
    }
    env.variables.push({ key, value, secret })
  }
  if (!file.active) file.active = targetName
  writeEnvironments(project.rootPath, file)
  res.json({ ok: true, env: targetName, key })
})

// ---------------------------------------------------------------- collection (disk)

const NAME_RE = /^[\w .-]{1,60}$/
const MAX_ITEM_BYTES = 256 * 1024 // a saved request is small metadata, not an asset
// `results` is the per-request run-history subfolder, `_environments` is the env
// store — reserve both so a saved request can't clobber them.
const RESERVED_NAMES = new Set(['results', '_environments'])

function collectionDir(root: string): string {
  return path.join(testingDirFor(root), 'api-tests')
}

/** Resolve <dir>/<name>.json, refusing names that could escape the folder. */
function itemFile(root: string, name: string): string | null {
  if (!NAME_RE.test(name) || RESERVED_NAMES.has(name.toLowerCase())) return null
  const dir = collectionDir(root)
  const target = path.resolve(dir, `${name}.json`)
  if (target !== path.join(dir, `${name}.json`)) return null
  return target
}

// ---------------------------------------------------------------- result history

// Every send can be stored as evidence under testing/api-tests/results/<request>/.
// Each run is one JSON file; we keep the newest MAX_RESULTS per request and cap the
// stored response body so history stays small.
const MAX_RESULTS = 30
const MAX_RESULT_BODY = 512 * 1024

function resultsBaseDir(root: string): string {
  return path.join(collectionDir(root), 'results')
}

/** Resolve the per-request results folder, guarding the (client-supplied) name. */
function resultsDirFor(root: string, name: string): string | null {
  const safe = name.replace(/[^\w .-]/g, '_').slice(0, 60)
  if (!safe) return null
  const base = resultsBaseDir(root)
  const target = path.resolve(base, safe)
  if (path.dirname(target) !== base) return null
  return target
}

interface ResultRecord {
  id: string
  at: string
  name: string
  request: { method: string; url: string }
  result: Record<string, unknown>
  checks: { passed: number; total: number }
  scan: { high: number; warn: number; info: number }
}

function num(v: unknown): number {
  return Number.isFinite(Number(v)) ? Number(v) : 0
}

/** GET /api/api-tests — list every saved request (metadata + full definition). */
apiTestsRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = collectionDir(project.rootPath)
  try {
    const out = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json') && d.name !== ENV_FILE)
      .map((d): ApiRequestDef | null => {
        const full = path.join(dir, d.name)
        const name = d.name.replace(/\.json$/, '')
        const stat = fs.statSync(full)
        let def: ApiRequestDef | null = null
        try {
          def = toRequestDef(name, JSON.parse(fs.readFileSync(full, 'utf8')))
        } catch {
          /* skip a corrupt file */
        }
        return def ? { ...def, savedAt: stat.mtime.toISOString() } : null
      })
      .filter((x): x is ApiRequestDef => x != null)
      .sort((a, b) => a.name.localeCompare(b.name))
    res.json(out)
  } catch {
    res.json([]) // no api-tests dir yet
  }
})

/** POST /api/api-tests/open — reveal the project's testing/api-tests folder. */
apiTestsRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = collectionDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create api-tests folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/** PUT /api/api-tests/:name — create or overwrite a saved request. */
apiTestsRouter.put('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const name = req.params.name
  const target = itemFile(project.rootPath, name)
  if (!target) return res.status(400).json({ error: 'invalid request name' })
  const def = toRequestDef(name, (req.body ?? {}) as Record<string, unknown>)
  const json = JSON.stringify(def, null, 2)
  if (Buffer.byteLength(json, 'utf8') > MAX_ITEM_BYTES) {
    return res.status(413).json({ error: 'request too large (256 KB max)' })
  }
  fs.mkdirSync(collectionDir(project.rootPath), { recursive: true })
  fs.writeFileSync(target, json, 'utf8')
  const stat = fs.statSync(target)
  res.json({ ...def, savedAt: stat.mtime.toISOString() })
})

/** POST /api/api-tests/:name/rename — rename a saved request (and its result history). */
apiTestsRouter.post('/:name/rename', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const fromName = req.params.name
  const newName = typeof req.body?.newName === 'string' ? req.body.newName.trim() : ''
  const from = itemFile(project.rootPath, fromName)
  const to = itemFile(project.rootPath, newName)
  if (!from || !to) return res.status(400).json({ error: 'invalid request name' })
  if (!fs.existsSync(from)) return res.status(404).json({ error: 'request not found' })
  // Block clobbering a different existing request (a case-only rename is allowed).
  if (from !== to && fs.existsSync(to)) {
    return res.status(409).json({ error: `a request named "${newName}" already exists` })
  }
  let def: ApiRequestDef
  try {
    def = toRequestDef(newName, JSON.parse(fs.readFileSync(from, 'utf8')))
  } catch {
    return res.status(500).json({ error: 'could not read the request' })
  }
  fs.writeFileSync(to, JSON.stringify(def, null, 2), 'utf8')
  if (from !== to) {
    try {
      fs.rmSync(from)
    } catch {
      /* best-effort */
    }
  }
  // Carry the run history over so it stays attached to the renamed request.
  const rFrom = resultsDirFor(project.rootPath, fromName)
  const rTo = resultsDirFor(project.rootPath, newName)
  if (rFrom && rTo && rFrom !== rTo && fs.existsSync(rFrom)) {
    try {
      fs.rmSync(rTo, { recursive: true, force: true })
      fs.renameSync(rFrom, rTo)
    } catch {
      /* best-effort — history move is non-fatal */
    }
  }
  const stat = fs.statSync(to)
  res.json({ ...def, savedAt: stat.mtime.toISOString() })
})

/** DELETE /api/api-tests/:name — remove a saved request (and its stored results). */
apiTestsRouter.delete('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = itemFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid request name' })
  try {
    fs.rmSync(target)
  } catch {
    /* already gone */
  }
  // Also drop this request's saved run history so it doesn't linger orphaned.
  const rdir = resultsDirFor(project.rootPath, req.params.name)
  if (rdir) {
    try {
      fs.rmSync(rdir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
  res.json({ ok: true })
})

// ---------------------------------------------------------------- result routes

/**
 * POST /api/api-tests/results — store one send's outcome as evidence under the
 * request's history folder. Prunes to the newest MAX_RESULTS. Body carries the
 * response plus the client-computed assertion/scan summaries.
 */
apiTestsRouter.post('/results', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const body = (req.body ?? {}) as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return res.status(400).json({ error: 'name is required' })
  const dir = resultsDirFor(project.rootPath, name)
  if (!dir) return res.status(400).json({ error: 'invalid request name' })

  const rawResult = (body.result ?? {}) as Record<string, unknown>
  const rawReq = (body.request ?? {}) as Record<string, unknown>
  const rawChecks = (body.checks ?? {}) as Record<string, unknown>
  const rawScan = (body.scan ?? {}) as Record<string, unknown>
  const headers =
    rawResult.headers && typeof rawResult.headers === 'object'
      ? (rawResult.headers as Record<string, string>)
      : {}
  const bodyText = typeof rawResult.bodyText === 'string' ? rawResult.bodyText : ''

  const record: ResultRecord = {
    id: randomUUID(),
    at: new Date().toISOString(),
    name,
    request: {
      method: typeof rawReq.method === 'string' ? rawReq.method : '',
      url: typeof rawReq.url === 'string' ? rawReq.url.slice(0, 2000) : '',
    },
    result: {
      ok: rawResult.ok === true,
      status: num(rawResult.status),
      statusText: typeof rawResult.statusText === 'string' ? rawResult.statusText : '',
      contentType: typeof rawResult.contentType === 'string' ? rawResult.contentType : '',
      headers,
      bodyText: bodyText.slice(0, MAX_RESULT_BODY),
      truncated: rawResult.truncated === true || bodyText.length > MAX_RESULT_BODY,
      sizeBytes: num(rawResult.sizeBytes),
      timeMs: num(rawResult.timeMs),
      requestUrl: typeof rawResult.requestUrl === 'string' ? rawResult.requestUrl : '',
      method: typeof rawResult.method === 'string' ? rawResult.method : '',
      error: typeof rawResult.error === 'string' ? rawResult.error : undefined,
    },
    checks: { passed: num(rawChecks.passed), total: num(rawChecks.total) },
    scan: { high: num(rawScan.high), warn: num(rawScan.warn), info: num(rawScan.info) },
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${record.id}.json`), JSON.stringify(record), 'utf8')
    // Prune to the newest MAX_RESULTS by mtime.
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => {
        const full = path.join(dir, d.name)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch {
          /* ignore */
        }
        return { full, mtime }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const f of files.slice(MAX_RESULTS)) {
      try {
        fs.rmSync(f.full)
      } catch {
        /* best-effort prune */
      }
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'failed to store result' })
  }
  return res.json({ id: record.id, at: record.at })
})

/** GET /api/api-tests/results?name= — list a request's run history (metadata only). */
apiTestsRouter.get('/results', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const name = typeof req.query.name === 'string' ? req.query.name : ''
  const dir = name ? resultsDirFor(project.rootPath, name) : null
  if (!dir) return res.json([])
  try {
    const out = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => {
        try {
          const r = JSON.parse(fs.readFileSync(path.join(dir, d.name), 'utf8')) as ResultRecord
          // Metadata only — omit headers/body to keep the list light.
          return {
            id: r.id,
            at: r.at,
            method: r.request?.method ?? '',
            url: r.request?.url ?? '',
            status: r.result?.status ?? 0,
            ok: r.result?.ok ?? false,
            timeMs: r.result?.timeMs ?? 0,
            sizeBytes: r.result?.sizeBytes ?? 0,
            error: (r.result as Record<string, unknown>)?.error ?? null,
            checks: r.checks ?? { passed: 0, total: 0 },
            scan: r.scan ?? { high: 0, warn: 0, info: 0 },
          }
        } catch {
          return null
        }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => (a.at < b.at ? 1 : -1)) // newest first
    res.json(out)
  } catch {
    res.json([])
  }
})

/** GET /api/api-tests/results/:name/:id — one stored result, in full. */
apiTestsRouter.get('/results/:name/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = resultsDirFor(project.rootPath, req.params.name)
  if (!dir || !/^[\w-]{1,80}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'invalid result reference' })
  }
  const file = path.join(dir, `${req.params.id}.json`)
  if (path.dirname(file) !== dir) return res.status(400).json({ error: 'invalid result reference' })
  const raw = readIfExists(file)
  if (!raw) return res.status(404).json({ error: 'result not found' })
  try {
    return res.json(JSON.parse(raw))
  } catch {
    return res.status(500).json({ error: 'corrupt result file' })
  }
})

/** DELETE /api/api-tests/results/:name — clear a request's whole run history. */
apiTestsRouter.delete('/results/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = resultsDirFor(project.rootPath, req.params.name)
  if (!dir) return res.status(400).json({ error: 'invalid request name' })
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
  res.json({ ok: true })
})

// ---------------------------------------------------------------- helpers

function readIfExists(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}
