import fs from 'node:fs'
import path from 'node:path'
import spawn from 'cross-spawn'
import { DB_PATH } from './config.js'
import { spawnEnv } from './toolPath.js'

/**
 * k6 — the load-testing engine behind the Performance page's "API load test" tab.
 *
 * The portal does NOT reimplement load generation: it writes a small k6 script,
 * runs `k6 run` as a child process, and parses the summary k6 itself produces.
 * Three deliberate decisions are baked in here, each with a reason:
 *
 *  1. **The script lives beside the DB, never in the project repo.** A load test's
 *     headers routinely carry a bearer token, and a script written into the repo
 *     would commit it. `perf-runs/<id>/` sits next to the SQLite file — the same
 *     posture `qcBrowser.ts` uses for its Playwright MCP config, and for the same
 *     reason: the file describes this machine's run, not the project.
 *
 *  2. **Secrets never touch that file either.** Per-endpoint headers and bodies are
 *     handed to k6 through `-e` environment variables and read back with `__ENV`,
 *     so the on-disk script contains only method/URL/label. Nothing logs them.
 *
 *  3. **Per-endpoint metrics are explicit custom metrics, not tag sub-metrics.**
 *     k6 only emits a tagged sub-metric (`http_req_duration{name:x}`) when a
 *     threshold names it; a Trend per endpoint always lands in the summary, which
 *     is what "how long does THIS api take to return data" needs.
 *
 * Verified against k6 v2.2.0: the summary JSON is `{root_group, options, state,
 * metrics}` with `metrics.<name>.values` holding avg/min/med/max/p(90)/p(95).
 */

/** The k6 executable. Overridable for an install that isn't on PATH. */
export function k6Bin(): string {
  return process.env.QC_K6_BIN || 'k6'
}

/** Where a run's generated script + summary live — beside the DB, never in a repo. */
export function perfRunsDir(): string {
  return path.join(path.dirname(DB_PATH), 'perf-runs')
}

/**
 * Drop one run's folder (generated script + summary) when its job is deleted.
 *
 * Deleting a run from the list has to mean the file too: the script is generated
 * FROM the config, so leaving it behind keeps a description of a test the
 * engineer just said they were done with. The id is a `randomUUID` the registry
 * owns, but this is a recursive delete on a path built from a request parameter,
 * so it is shape-checked before anything is removed.
 */
export function removeK6RunDir(id: string): void {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return
  try {
    fs.rmSync(path.join(perfRunsDir(), id), { recursive: true, force: true })
  } catch {
    /* the report is already gone from the list; a leftover folder is not worth an error */
  }
}

export interface K6Availability {
  ok: boolean
  version?: string
  error?: string
  /** Platform-appropriate install command, shown by the UI when k6 is missing. */
  installHint: string
}

function installHint(): string {
  if (process.platform === 'win32') return 'winget install k6 --source winget'
  if (process.platform === 'darwin') return 'brew install k6'
  return 'sudo gpg -k && sudo apt-get install k6   # or: https://grafana.com/docs/k6/latest/set-up/install-k6/'
}

/** Is k6 installed and runnable on this machine? Never throws. */
export function k6Available(): Promise<K6Availability> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(k6Bin(), ['version'], { env: spawnEnv(), windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : 'k6 not found', installHint: installHint() })
      return
    }
    let out = ''
    let settled = false
    const done = (r: K6Availability) => {
      if (settled) return
      settled = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      done({ ok: false, error: 'k6 did not respond', installHint: installHint() })
    }, 10_000)
    child.stdout?.on('data', (d) => {
      out += String(d)
    })
    child.stderr?.on('data', (d) => {
      out += String(d)
    })
    child.on('error', () => {
      clearTimeout(timer)
      done({ ok: false, error: 'k6 is not installed (or not on PATH).', installHint: installHint() })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        done({ ok: true, version: out.trim().split(/\r?\n/)[0] || 'k6', installHint: installHint() })
      } else {
        done({ ok: false, error: out.trim() || `k6 exited ${code}`, installHint: installHint() })
      }
    })
  })
}

// ------------------------------------------------------------------ config

export interface K6Endpoint {
  /** Short label the report groups this endpoint's metrics under. */
  name: string
  method: string
  url: string
  headers: Record<string, string>
  /** Request body for write methods; empty string means "no body". */
  body: string
}

export interface K6TestConfig {
  name: string
  /** Virtual users held for `duration` (after `rampUp`, when set). */
  vus: number
  /** Hold time, e.g. `30s` / `2m`. */
  duration: string
  /** Optional ramp-up to `vus` before the hold. Empty string = start at full load. */
  rampUp: string
  /** Think-time between endpoints inside one iteration, in seconds. */
  sleepSeconds: number
  /** Fail the test if p(95) response time exceeds this, in ms. 0 = no threshold. */
  thresholdP95Ms: number
  /** Fail the test if the error rate exceeds this fraction (0–1). <0 = no threshold. */
  thresholdErrorRate: number
  /** Accept self-signed certificates (staging environments usually need this). */
  insecureSkipTLSVerify: boolean
  endpoints: K6Endpoint[]
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const MAX_ENDPOINTS = 20
const MAX_VUS = 200
const MAX_TOTAL_SECONDS = 30 * 60

/** Seconds in a k6 duration string (`30s`, `2m`, `1h`), or null if malformed. */
export function durationSeconds(raw: string): number | null {
  const m = /^(\d+)(ms|s|m|h)$/.exec(raw.trim())
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n)) return null
  switch (m[2]) {
    case 'ms':
      return n / 1000
    case 's':
      return n
    case 'm':
      return n * 60
    default:
      return n * 3600
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/**
 * The time axis of a run, decided ONCE and used by both the generated script and
 * the summary parser.
 *
 * k6's end-of-test summary has no time series in it at all — it is a single set of
 * aggregates for the whole run — so "did it get slower as load arrived?", the
 * question a load test exists to answer, cannot be read off it. Rather than stream
 * every sample to a CSV (tens of millions of rows on a long run, most of it thrown
 * away), the script buckets its own samples into a FIXED set of custom metrics,
 * which k6 aggregates for free and prints in the summary like any other metric.
 *
 * Both sides must agree on the bucket width, so it is derived here from the config
 * and never stored: the same config always produces the same axis.
 */
const TARGET_BUCKETS = 36
const MAX_BUCKETS = 48

export function timeBuckets(cfg: K6TestConfig): { count: number; seconds: number } {
  const hold = durationSeconds(cfg.duration) ?? 0
  const ramp = cfg.rampUp ? (durationSeconds(cfg.rampUp) ?? 0) : 0
  // The generated script adds a 5s ramp-down stage when a ramp-up is set.
  const total = Math.max(1, hold + ramp + (cfg.rampUp ? 5 : 0))
  const seconds = Math.max(1, Math.ceil(total / TARGET_BUCKETS))
  // Two spare buckets absorb the clock skew between "the server spawned k6" and
  // "k6 started sending", plus any overrun; empty ones are dropped when parsing.
  const count = Math.min(MAX_BUCKETS, Math.ceil(total / seconds) + 2)
  return { count, seconds }
}

/**
 * Validate + normalize a load-test config coming off the wire. Throws a message
 * meant to be shown verbatim — the UI surfaces it in the error strip.
 */
export function parseLoadConfig(raw: unknown): K6TestConfig {
  const body = (raw ?? {}) as Record<string, unknown>
  const rawEndpoints = Array.isArray(body.endpoints) ? body.endpoints : []
  if (!rawEndpoints.length) throw new Error('Add at least one endpoint to load test.')
  if (rawEndpoints.length > MAX_ENDPOINTS) {
    throw new Error(`Too many endpoints — ${MAX_ENDPOINTS} at most in one test.`)
  }

  const endpoints: K6Endpoint[] = rawEndpoints.map((e, i) => {
    const o = (e ?? {}) as Record<string, unknown>
    const url = str(o.url).trim()
    if (!/^https?:\/\/\S+$/i.test(url)) {
      throw new Error(`Endpoint ${i + 1}: "${url || '(empty)'}" is not an http(s) URL.`)
    }
    const method = str(o.method, 'GET').trim().toUpperCase()
    if (!METHODS.includes(method)) {
      throw new Error(`Endpoint ${i + 1}: unsupported method "${method}".`)
    }
    const headers: Record<string, string> = {}
    const rawHeaders = (o.headers ?? {}) as Record<string, unknown>
    if (rawHeaders && typeof rawHeaders === 'object') {
      for (const [k, v] of Object.entries(rawHeaders)) {
        const key = k.trim()
        // A header name with a newline in it is header injection, not a typo.
        if (!key || /[\r\n:]/.test(key)) continue
        headers[key] = String(v ?? '').replace(/[\r\n]+/g, ' ')
      }
    }
    let name = str(o.name).trim()
    if (!name) {
      try {
        name = `${method} ${new URL(url).pathname || '/'}`
      } catch {
        name = `${method} ${i + 1}`
      }
    }
    return {
      name: name.slice(0, 80),
      method,
      url,
      headers,
      body: str(o.body).slice(0, 200_000),
    }
  })

  const vus = Math.max(1, Math.min(MAX_VUS, Math.round(Number(body.vus) || 1)))
  const duration = str(body.duration, '30s').trim() || '30s'
  const holdSeconds = durationSeconds(duration)
  if (holdSeconds === null) throw new Error(`Duration "${duration}" is not valid — use 30s, 2m, 1h.`)
  const rampUp = str(body.rampUp).trim()
  const rampSeconds = rampUp ? durationSeconds(rampUp) : 0
  if (rampSeconds === null) throw new Error(`Ramp-up "${rampUp}" is not valid — use 10s, 1m.`)
  if (holdSeconds + rampSeconds > MAX_TOTAL_SECONDS) {
    throw new Error('A single test may not run longer than 30 minutes.')
  }
  if (holdSeconds <= 0) throw new Error('Duration must be greater than zero.')

  const sleepRaw = Number(body.sleepSeconds)
  const sleepSeconds = Number.isFinite(sleepRaw) ? Math.max(0, Math.min(60, sleepRaw)) : 0
  const p95Raw = Number(body.thresholdP95Ms)
  const thresholdP95Ms = Number.isFinite(p95Raw) && p95Raw > 0 ? Math.round(p95Raw) : 0
  const errRaw = Number(body.thresholdErrorRate)
  const thresholdErrorRate =
    Number.isFinite(errRaw) && errRaw >= 0 && errRaw <= 1 ? errRaw : -1

  return {
    name: str(body.name, 'Load test').trim().slice(0, 80) || 'Load test',
    vus,
    duration,
    rampUp,
    sleepSeconds,
    thresholdP95Ms,
    thresholdErrorRate,
    insecureSkipTLSVerify: body.insecureSkipTLSVerify !== false,
    endpoints,
  }
}

// ------------------------------------------------------------------ script

/**
 * JSON that is also safe to paste into a JS source file. JSON.stringify emits raw
 * U+2028/U+2029, which are line terminators inside a JS string literal — legal in
 * JSON, a syntax error in the script we generate.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export const SUMMARY_FILE = 'summary.json'
export const SCRIPT_FILE = 'script.js'

/**
 * The k6 script for one config. Contains no credentials: headers and bodies arrive
 * at runtime through `__ENV.QCP_H<i>` / `__ENV.QCP_B<i>` (see runK6).
 */
export function buildK6Script(cfg: K6TestConfig): string {
  const stages = cfg.rampUp
    ? `stages: [
    { duration: ${jsLiteral(cfg.rampUp)}, target: ${cfg.vus} },
    { duration: ${jsLiteral(cfg.duration)}, target: ${cfg.vus} },
    { duration: '5s', target: 0 },
  ],`
    : `vus: ${cfg.vus},
  duration: ${jsLiteral(cfg.duration)},`

  const thresholds: string[] = []
  if (cfg.thresholdP95Ms > 0) {
    thresholds.push(`    http_req_duration: ['p(95)<${cfg.thresholdP95Ms}'],`)
  }
  if (cfg.thresholdErrorRate >= 0) {
    thresholds.push(`    http_req_failed: ['rate<=${cfg.thresholdErrorRate}'],`)
  }

  const plan = cfg.endpoints.map((e) => ({ name: e.name, method: e.method, url: e.url }))
  const buckets = timeBuckets(cfg)

  return `// Generated by QC Portal — Performance › API load test.
// Credentials are NOT in this file: headers/bodies come from the environment.
import http from 'k6/http'
import exec from 'k6/execution'
import { check, sleep } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const PLAN = ${jsLiteral(plan)}
const SLEEP = ${cfg.sleepSeconds}

// The time axis. QCP_START is the moment the portal spawned k6, passed in so every
// VU shares one clock — a ramp-up starts VUs at different times, and a per-VU
// Date.now() would put the same wall-clock second in a different bucket per VU.
// Falling back to this VU's own start keeps the script runnable by hand.
const BUCKET_COUNT = ${buckets.count}
const BUCKET_SECONDS = ${buckets.seconds}
const START = Number(__ENV.QCP_START) || Date.now()

// One metric set per endpoint, so the report can answer "how slow is THIS call?"
// rather than only reporting the blended p95 across everything.
const M = PLAN.map((_, i) => ({
  duration: new Trend('ep' + i + '_duration', true),
  waiting: new Trend('ep' + i + '_waiting', true),
  bytes: new Trend('ep' + i + '_bytes'),
  ok: new Rate('ep' + i + '_ok'),
  calls: new Counter('ep' + i + '_calls'),
}))

// Secrets live in the process environment, never on disk.
const HEADERS = PLAN.map((_, i) => {
  try {
    return JSON.parse(__ENV['QCP_H' + i] || '{}')
  } catch (e) {
    return {}
  }
})
const BODIES = PLAN.map((_, i) => __ENV['QCP_B' + i] || null)

// One metric set per slice of the run. k6 aggregates these across VUs and prints
// them in the summary, which is how the report draws response time, throughput and
// errors OVER TIME without streaming a single sample to disk.
const B = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
  duration: new Trend('b' + i + '_duration', true),
  reqs: new Counter('b' + i + '_reqs'),
  fail: new Rate('b' + i + '_fail'),
  vus: new Trend('b' + i + '_vus'),
}))

function bucketNow() {
  const i = Math.floor((Date.now() - START) / 1000 / BUCKET_SECONDS)
  return B[i < 0 ? 0 : i > BUCKET_COUNT - 1 ? BUCKET_COUNT - 1 : i]
}

export const options = {
  ${stages}
  insecureSkipTLSVerify: ${cfg.insecureSkipTLSVerify},
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,${
    thresholds.length ? `\n  thresholds: {\n${thresholds.join('\n')}\n  },` : ''
  }
}

export default function () {
  for (let i = 0; i < PLAN.length; i++) {
    const e = PLAN[i]
    const res = http.request(e.method, e.url, BODIES[i], {
      headers: HEADERS[i],
      tags: { name: e.name },
      timeout: '60s',
      redirects: 3,
    })
    const good = res.status >= 200 && res.status < 400
    const b = bucketNow()
    b.duration.add(res.timings.duration)
    b.reqs.add(1)
    b.fail.add(!good)
    b.vus.add(exec.instance.vusActive)
    M[i].duration.add(res.timings.duration)
    M[i].waiting.add(res.timings.waiting)
    M[i].bytes.add(res.body ? res.body.length : 0)
    M[i].ok.add(good)
    M[i].calls.add(1)
    check(res, { [e.name + ' responded 2xx/3xx']: () => good })
    if (SLEEP > 0) sleep(SLEEP)
  }
}

// Write the machine-readable summary the portal parses; the human summary is
// rendered by the portal itself, so stdout stays as the progress log.
export function handleSummary(data) {
  return { ${jsLiteral(SUMMARY_FILE)}: JSON.stringify(data), stdout: '' }
}
`
}

// ------------------------------------------------------------------ results

export interface TrendStats {
  avg: number
  min: number
  med: number
  max: number
  p90: number
  p95: number
  p99: number
}

export interface EndpointResult {
  name: string
  method: string
  url: string
  calls: number
  /** Fraction of calls that returned 2xx/3xx (0–1). */
  okRate: number
  duration: TrendStats
  /** Server think-time (TTFB minus connect) — "how long until data came back". */
  waiting: TrendStats
  /** Average response body size in bytes. */
  avgBytes: number
}

/**
 * Where a request's time actually went, averaged over the run.
 *
 * `http_req_duration` is the headline, but it is a SUM of these phases, and which
 * one dominates changes the fix entirely: `waiting` is the server thinking,
 * `connecting`/`tlsHandshaking` is connection setup (a pool or keep-alive problem,
 * not an application one), `receiving` is payload size, and `blocked` is the client
 * itself queueing — the load generator running out of headroom rather than the
 * system under test being slow.
 */
export interface RequestPhases {
  blocked: TrendStats
  connecting: TrendStats
  tlsHandshaking: TrendStats
  sending: TrendStats
  waiting: TrendStats
  receiving: TrendStats
}

/** One slice of the run — see `timeBuckets`. */
export interface LoadTimeBucket {
  /** Seconds from the start of the run to the START of this slice. */
  atSeconds: number
  requests: number
  /** Requests per second inside this slice. */
  rps: number
  failRate: number
  avgMs: number
  p95Ms: number
  maxMs: number
  /** Average virtual users active while this slice was being sampled. */
  vus: number
}

export interface LoadTestResult {
  /** True when k6 completed; thresholds may still have been crossed. */
  completed: boolean
  /** k6 exit code (99 = a threshold was crossed, which is a real result). */
  exitCode: number
  thresholdsPassed: boolean
  durationMs: number
  requests: number
  requestsPerSecond: number
  failRate: number
  /** Whole requests that failed — k6 counts these, so it is exact, not derived. */
  failedRequests: number
  checksPassed: number
  checksFailed: number
  overall: TrendStats
  /** Time-to-first-byte across all requests. */
  waiting: TrendStats
  phases: RequestPhases
  /** One full pass through every endpoint = one iteration. */
  iterations: number
  iterationDuration: TrendStats
  /** Iterations k6 could not start because the load generator ran out of room. */
  droppedIterations: number
  /** Peak virtual users the run actually reached. */
  vusMax: number
  dataReceived: number
  dataSent: number
  bucketSeconds: number
  buckets: LoadTimeBucket[]
  endpoints: EndpointResult[]
}

const ZERO: TrendStats = { avg: 0, min: 0, med: 0, max: 0, p90: 0, p95: 0, p99: 0 }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function trend(metrics: Record<string, unknown>, key: string): TrendStats {
  const m = metrics[key] as { values?: Record<string, unknown> } | undefined
  const v = m?.values
  if (!v) return { ...ZERO }
  return {
    avg: num(v.avg),
    min: num(v.min),
    med: num(v.med),
    max: num(v.max),
    p90: num(v['p(90)']),
    p95: num(v['p(95)']),
    p99: num(v['p(99)']),
  }
}

function counter(metrics: Record<string, unknown>, key: string, field = 'count'): number {
  const m = metrics[key] as { values?: Record<string, unknown> } | undefined
  return num(m?.values?.[field])
}

/** Turn k6's summary JSON into the shape the Performance page renders. */
export function parseK6Summary(
  raw: unknown,
  cfg: K6TestConfig,
  exitCode: number,
): LoadTestResult {
  const data = (raw ?? {}) as Record<string, unknown>
  const metrics = (data.metrics ?? {}) as Record<string, unknown>
  const state = (data.state ?? {}) as Record<string, unknown>
  const checks = metrics.checks as { values?: Record<string, unknown> } | undefined

  const bucketPlan = timeBuckets(cfg)
  const buckets: LoadTimeBucket[] = []
  for (let i = 0; i < bucketPlan.count; i += 1) {
    // A slice in which nothing happened is not emitted by k6 at all — a metric with
    // no samples is absent from the summary. An absent slice is DROPPED rather than
    // drawn as a zero: a run that finished early would otherwise end in a cliff down
    // to 0ms that never happened.
    const requests = counter(metrics, `b${i}_reqs`)
    if (requests <= 0) continue
    const d = trend(metrics, `b${i}_duration`)
    buckets.push({
      atSeconds: i * bucketPlan.seconds,
      requests,
      rps: requests / bucketPlan.seconds,
      failRate: counter(metrics, `b${i}_fail`, 'rate'),
      avgMs: d.avg,
      p95Ms: d.p95,
      maxMs: d.max,
      vus: trend(metrics, `b${i}_vus`).avg,
    })
  }

  // The run almost never ends exactly on a slice boundary, so the last slice is a
  // sliver — a fraction of a second's traffic reported as if it were a full one.
  // Left in, every throughput chart ends in a cliff to near-zero that never
  // happened. A slice holding under a third of its predecessor is that sliver;
  // a genuine ramp-down does not fall that far in one step.
  if (buckets.length >= 2) {
    const last = buckets[buckets.length - 1]
    const prev = buckets[buckets.length - 2]
    if (last.requests < prev.requests / 3) buckets.pop()
  }

  return {
    completed: true,
    exitCode,
    // 99 is k6's dedicated "thresholds crossed" code — the run itself succeeded.
    thresholdsPassed: exitCode !== 99,
    durationMs: num(state.testRunDurationMs),
    requests: counter(metrics, 'http_reqs'),
    requestsPerSecond: counter(metrics, 'http_reqs', 'rate'),
    failRate: counter(metrics, 'http_req_failed', 'rate'),
    // `http_req_failed` is a Rate over "did this request fail", so its `passes` is
    // the count of requests that DID fail. Reading `fails` here would report every
    // healthy request as an error.
    failedRequests: counter(metrics, 'http_req_failed', 'passes'),
    checksPassed: num(checks?.values?.passes),
    checksFailed: num(checks?.values?.fails),
    overall: trend(metrics, 'http_req_duration'),
    waiting: trend(metrics, 'http_req_waiting'),
    phases: {
      blocked: trend(metrics, 'http_req_blocked'),
      connecting: trend(metrics, 'http_req_connecting'),
      tlsHandshaking: trend(metrics, 'http_req_tls_handshaking'),
      sending: trend(metrics, 'http_req_sending'),
      waiting: trend(metrics, 'http_req_waiting'),
      receiving: trend(metrics, 'http_req_receiving'),
    },
    iterations: counter(metrics, 'iterations'),
    iterationDuration: trend(metrics, 'iteration_duration'),
    droppedIterations: counter(metrics, 'dropped_iterations'),
    vusMax: counter(metrics, 'vus_max', 'max'),
    dataReceived: counter(metrics, 'data_received'),
    dataSent: counter(metrics, 'data_sent'),
    bucketSeconds: bucketPlan.seconds,
    buckets,
    endpoints: cfg.endpoints.map((e, i) => ({
      name: e.name,
      method: e.method,
      url: e.url,
      calls: counter(metrics, `ep${i}_calls`),
      okRate: counter(metrics, `ep${i}_ok`, 'rate'),
      duration: trend(metrics, `ep${i}_duration`),
      waiting: trend(metrics, `ep${i}_waiting`),
      avgBytes: trend(metrics, `ep${i}_bytes`).avg,
    })),
  }
}

// ------------------------------------------------------------------ run

export interface K6RunHandle {
  /** Resolves when k6 exits. Never rejects — failures come back on the result. */
  done: Promise<{ result: LoadTestResult | null; error: string | null; exitCode: number }>
  /** Kill the k6 process (cancel). Idempotent. */
  kill: () => void
  /** Directory holding script.js + summary.json for this run. */
  dir: string
}

/**
 * Write the script and start `k6 run`. Output lines are delivered through
 * `onLine`; k6's carriage-return progress redraws are handed to `onProgress`
 * instead of flooding the log.
 */
export function runK6(opts: {
  id: string
  cfg: K6TestConfig
  onLine: (level: 'info' | 'error', text: string) => void
  onProgress: (text: string) => void
}): K6RunHandle {
  const dir = path.join(perfRunsDir(), opts.id)
  fs.mkdirSync(dir, { recursive: true })
  const scriptPath = path.join(dir, SCRIPT_FILE)
  fs.writeFileSync(scriptPath, buildK6Script(opts.cfg), 'utf8')
  const summaryPath = path.join(dir, SUMMARY_FILE)
  try {
    fs.rmSync(summaryPath, { force: true }) // never parse a previous run's summary
  } catch {
    /* nothing to remove */
  }

  // Credentials go through the environment, not the script file or the CLI args
  // (an `-e` value would show up in the process list on some platforms).
  // QCP_START gives every VU one clock for the time buckets (see `timeBuckets`);
  // the rest are the credentials, which is why this never touches the script file.
  const secrets: Record<string, string> = { QCP_START: String(Date.now()) }
  opts.cfg.endpoints.forEach((e, i) => {
    if (Object.keys(e.headers).length) secrets[`QCP_H${i}`] = JSON.stringify(e.headers)
    if (e.body) secrets[`QCP_B${i}`] = e.body
  })

  let killed = false
  const child = spawn(k6Bin(), ['run', '--no-color', SCRIPT_FILE], {
    cwd: dir,
    env: spawnEnv(secrets),
    windowsHide: true,
  })

  // k6 redraws progress with \r; split on both so a redraw doesn't become a
  // 4000-character "line" and the real messages stay readable.
  let pending = ''
  const consume = (chunk: string, level: 'info' | 'error') => {
    pending += chunk
    const parts = pending.split(/[\r\n]/)
    pending = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.trimEnd()
      if (!line.trim()) continue
      if (/^(running \(|default\s+[✓✗]?\s*\[)/.test(line.trim())) {
        opts.onProgress(line.trim())
      } else {
        opts.onLine(level, line)
      }
    }
  }
  child.stdout?.on('data', (d) => consume(String(d), 'info'))
  child.stderr?.on('data', (d) => consume(String(d), 'error'))

  const done = new Promise<{ result: LoadTestResult | null; error: string | null; exitCode: number }>(
    (resolve) => {
      child.on('error', (err) => {
        const msg = /ENOENT/.test(String(err))
          ? `k6 is not installed (or not on PATH). Install it with: ${installHint()}`
          : err instanceof Error
            ? err.message
            : 'k6 failed to start'
        resolve({ result: null, error: msg, exitCode: -1 })
      })
      child.on('close', (code) => {
        if (pending.trim()) opts.onLine('info', pending.trim())
        pending = ''
        const exitCode = code ?? -1
        if (killed) {
          resolve({ result: null, error: null, exitCode })
          return
        }
        let summary: unknown = null
        try {
          summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
        } catch {
          summary = null
        }
        if (!summary) {
          resolve({
            result: null,
            error:
              exitCode === 0
                ? 'k6 finished but produced no summary — check the log above.'
                : `k6 exited with code ${exitCode} — check the log above.`,
            exitCode,
          })
          return
        }
        resolve({ result: parseK6Summary(summary, opts.cfg, exitCode), error: null, exitCode })
      })
    },
  )

  return {
    done,
    dir,
    kill: () => {
      if (killed) return
      killed = true
      try {
        child.kill()
      } catch {
        /* already exited */
      }
    },
  }
}
