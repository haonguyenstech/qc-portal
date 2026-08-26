import type { LoadEndpointResult, PerfJob } from './api'
import { ms, pct } from './perfReport'

/**
 * NFR PERFORMANCE REPORT — the shape a performance test report is delivered in.
 *
 * The quick report (`perfReport.ts` / `perfReportHtml.ts`) answers "how did THIS
 * run go?" and grades it Healthy / Needs attention / Poor. That is the right
 * answer for a run you just started and are still looking at. It is not the
 * document a QC hands to a client at the end of a test phase, which is organised
 * the other way round: by **requirement**, not by run.
 *
 * The structure here follows a real delivered report (an enrolment-journey NFR
 * report, phase 4 round 2), because a format the client already accepts is worth
 * more than a nicer one they have to learn:
 *
 *   Executive summary  requirement × scope × key result × status
 *   1  Environments, test configuration, objective and scope
 *   2  Requirements and acceptance criteria, metric definitions
 *   3  Detailed results — per requirement, per test case, with charts
 *   4  Findings, recommendations (prioritised), final assessment
 *
 * Three rules the format enforces, which the code must not soften:
 *
 * 1. **A requirement nobody tested is PENDING — never Pass, never Failed.** The
 *    source report says so in as many words. A report that quietly grades an
 *    unrun requirement is worse than one that admits the gap.
 * 2. **Stability and performance are judged separately.** "No HTTP failures, but
 *    severely slow" is a real and common outcome; collapsing it into one verdict
 *    loses the finding that the system is up but missing its target.
 * 3. **Every number is one the tool actually produced.** k6's end-of-test summary
 *    has no peak-RPS figure, so this reports the AVERAGE rate under that name and
 *    says so — see `DATA_LIMITATIONS`.
 */

// ------------------------------------------------------------------ the model

/** Which measured number a requirement is judged on. */
export type NfrMetric = 'p95' | 'p50' | 'max' | 'error-rate' | 'success-rate'

export interface NfrRequirement {
  /** The client's identifier, e.g. `NFR-P001`. Free text — their scheme, not ours. */
  id: string
  /** Short scope, as it appears in the summary table: "Browser response ≤3 s". */
  scope: string
  /** The acceptance sentence, quoted in section 2. */
  criterion: string
  metric: NfrMetric
  /** Milliseconds for the timing metrics, a fraction (0–1) for the rate ones. */
  target: number
  /**
   * Endpoint names this requirement covers, matched against the test-case names in
   * the selected runs. Empty means every endpoint of every selected run.
   */
  endpoints: string[]
  /**
   * Declared but deliberately not run this round (blocked, out of scope, waiting on
   * a bug fix). Reported PENDING with this as the reason.
   */
  pendingReason: string
}

export interface NfrMeta {
  /** The system under test, e.g. "NZPA Enrolment". */
  system: string
  /** "Phase 4 · Second Run" — whatever names this round. */
  phase: string
  /** Staging / UAT / Pre-prod. */
  environment: string
  /** Where load was generated from, e.g. "AWS Sydney". */
  region: string
  /** Free lines of `Name: https://…`, listing the systems in play. */
  environments: string
  objective: string
  /** Who ran it; shown on the cover. */
  tester: string
  /** ISO date of the test round. Blank falls back to the first run's date. */
  testDate: string
  notes: string
}

export const BLANK_META: NfrMeta = {
  system: '',
  phase: '',
  environment: '',
  region: '',
  environments: '',
  objective: '',
  tester: '',
  testDate: '',
  notes: '',
}

/**
 * WHAT THE PORTAL ALREADY KNOWS.
 *
 * Every field below was, until now, typed by hand into a form the engineer opens
 * once per test round — and every one of them is already sitting in the run, the
 * project, or the machine. Retyping them is not just slow: a hand-typed environment
 * or endpoint list is how a report ends up describing a different system than the
 * one that was measured.
 *
 * Two rules hold this together:
 *
 *  1. **Nothing is written into the user's fields.** A suggestion is a FALLBACK —
 *     `resolveMeta` prefers whatever was typed, and an empty field falls back to the
 *     derived value. So a suggestion can never overwrite an edit, clearing a field
 *     is not a fight with an effect, and changing the selected runs re-derives on the
 *     next render instead of leaving a stale value behind.
 *  2. **Never guess where being wrong is worse than being blank.** In particular
 *     `environment` never returns "Production": a report mislabelled as production
 *     evidence is a worse outcome than an empty field the engineer fills in.
 */
export interface NfrContext {
  projectName?: string
  /** Who is running the tests, from this machine's git identity. */
  tester?: string
  /** The machine k6 ran on. */
  host?: string
  platform?: string
}

/** `https://api.example.com:8443/orders?x=1` → `https://api.example.com:8443`. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/**
 * Every distinct origin across the chosen runs, with how many DISTINCT endpoints it
 * carries. Counting per run instead would report the same three endpoints measured
 * twice as "6 endpoints" — the report would then describe a bigger system than the
 * one that was tested.
 */
function originsOf(runs: PerfJob[]): { origin: string; host: string; endpoints: number }[] {
  const byOrigin = new Map<string, { host: string; urls: Set<string> }>()
  for (const job of runs) {
    for (const e of job.loadResult?.endpoints ?? []) {
      const origin = originOf(e.url)
      if (!origin) continue
      const entry = byOrigin.get(origin)
      if (entry) entry.urls.add(e.url)
      else byOrigin.set(origin, { host: hostOfUrl(e.url), urls: new Set([e.url]) })
    }
  }
  return [...byOrigin.entries()]
    .map(([origin, v]) => ({ origin, host: v.host, endpoints: v.urls.size }))
    .sort((a, b) => b.endpoints - a.endpoints || a.origin.localeCompare(b.origin))
}

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[?::1\]?|0\.0\.0\.0)(:\d+)?$/i

/**
 * Environment markers, and HOW each one is allowed to match a hostname label.
 *
 * Both halves were forced by real hostnames:
 *
 *  • `exact` alone misses `epuat.example.org` and `apistaging.example.com`, where the
 *    marker is glued to a prefix — a very common shape.
 *  • `suffix` for every marker is worse: `latest` ends in "test" and `greatest` ends
 *    in "test", so a plain-named host would be labelled a test environment. Suffix
 *    matching is therefore allowed ONLY for markers long or distinctive enough to
 *    survive it. (`graduate` does not end in "uat"; `devices` merely STARTS with
 *    "dev", and prefix matching is never allowed.)
 *
 * First rule that matches a host wins, so the more specific names come first.
 */
const ENV_RULES: { name: string; exact: string[]; suffix?: string[] }[] = [
  { name: 'UAT', exact: ['uat'], suffix: ['uat'] },
  { name: 'Staging', exact: ['staging', 'stg', 'stage'], suffix: ['staging'] },
  { name: 'Pre-production', exact: ['preprod', 'pprd', 'pre'], suffix: ['preprod'] },
  { name: 'QA', exact: ['qa'] },
  { name: 'SIT', exact: ['sit'] },
  { name: 'Development', exact: ['dev', 'develop', 'development'] },
  { name: 'Test', exact: ['test', 'tst'] },
]

/**
 * The environment name a set of hosts implies — or nothing.
 *
 * There is deliberately no rule that produces "Production": the absence of a staging
 * marker is not evidence of production, and a report that claims to be production
 * evidence when it is not is the one mistake here that cannot be walked back.
 */
export function classifyEnvironment(hosts: string[]): string {
  const found = new Set<string>()
  for (const host of hosts) {
    if (!host) continue
    if (LOCAL_HOST.test(host)) {
      found.add('Local')
      continue
    }
    // The port is dropped first: `uat.example.org:8443` must still read as UAT, and
    // a numeric port must never be mistaken for a label.
    // A trailing number is an instance, not a different environment: `uat2` and
    // `staging1` are the same environments as `uat` and `staging`.
    const labels = host
      .toLowerCase()
      .replace(/:\d+$/, '')
      .split(/[.\-_]/)
      .map((l) => l.replace(/\d+$/, ''))
      .filter(Boolean)
    const rule = ENV_RULES.find((r) =>
      labels.some(
        (l) => r.exact.includes(l) || (r.suffix ?? []).some((sfx) => l !== sfx && l.endsWith(sfx)),
      ),
    )
    if (rule) found.add(rule.name)
  }
  return [...found].join(' + ')
}

/** "8 virtual users for 20s (ramp 10s)" — one run's applied load, in words. */
function loadShape(job: PerfJob): string {
  const cfg = job.loadConfig
  if (!cfg) return ''
  const vus = `${cfg.vus} virtual user${cfg.vus === 1 ? '' : 's'}`
  return `${vus} for ${cfg.duration}${cfg.rampUp ? ` (ramp ${cfg.rampUp})` : ''}`
}

/** The date the round ran, as `YYYY-MM-DD`, from the earliest selected run. */
function firstRunDate(runs: PerfJob[]): string {
  const stamps = runs.map((r) => new Date(r.createdAt).getTime()).filter(Number.isFinite)
  if (!stamps.length) return ''
  const d = new Date(Math.min(...stamps))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Everything the portal can fill in on its own. Empty string = it genuinely can't. */
export function suggestMeta(runs: PerfJob[], ctx: NfrContext = {}): NfrMeta {
  const origins = originsOf(runs)
  const endpoints = endpointNames(runs)
  // Chronological, whatever order they were ticked in: "round 1 · round 2" is the
  // only reading of a phase label that is not just the click order.
  const inOrder = [...runs].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  const labels = inOrder.map((r) => r.label.trim()).filter(Boolean)

  const systemsInScope = origins
    .map(({ origin, host, endpoints: n }) => {
      const name = origins.length === 1 ? 'System under test' : host || origin
      return `${name}: ${origin} (${n} endpoint${n === 1 ? '' : 's'})`
    })
    .join('\n')

  const objective = origins.length
    ? [
        `The objective was to assess API response time, throughput and stability of ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} on ${origins.map((o) => o.host || o.origin).join(', ')} under concurrent load.`,
        inOrder.length === 1
          ? `The run applied ${loadShape(inOrder[0])}.`
          : `${inOrder.length} runs were executed: ${inOrder.map((r) => `${r.label.trim() || 'run'} — ${loadShape(r)}`).join('; ')}.`,
      ].join('\n\n')
    : ''

  return {
    system: ctx.projectName?.trim() || '',
    phase: labels.join(' · ').slice(0, 120),
    environment: classifyEnvironment(origins.map((o) => o.host)),
    // k6 runs on the engineer's own PC — that is the Portal's architecture, not a
    // guess, so the load origin can always be stated.
    region: ctx.host
      ? `This machine — ${ctx.host}${ctx.platform ? ` (${ctx.platform})` : ''}`
      : 'This machine (k6 runs locally)',
    environments: systemsInScope,
    objective,
    tester: ctx.tester?.trim() || '',
    testDate: firstRunDate(runs),
    notes: '',
  }
}

/** Typed value wins; an empty field falls back to what the portal worked out. */
export function resolveMeta(meta: NfrMeta, suggested: NfrMeta): NfrMeta {
  const pick = (key: keyof NfrMeta) => (meta[key].trim() ? meta[key] : suggested[key])
  return {
    system: pick('system'),
    phase: pick('phase'),
    environment: pick('environment'),
    region: pick('region'),
    environments: pick('environments'),
    objective: pick('objective'),
    tester: pick('tester'),
    testDate: pick('testDate'),
    notes: pick('notes'),
  }
}

/**
 * The acceptance criterion a requirement states when nobody wrote one.
 *
 * The metric and the target already say it exactly; a report section that reads
 * "—" because the sentence was not retyped is missing nothing but the typing.
 */
export function defaultCriterion(requirement: NfrRequirement): string {
  const where = requirement.endpoints.length
    ? `${requirement.endpoints.join(', ')} must hold`
    : 'Every endpoint under test must hold'
  return `${where} ${METRIC_LABEL[requirement.metric].toLowerCase()} ${formatTarget(requirement.metric, requirement.target)}.`
}

/** The short label the summary table shows for a requirement. */
export function defaultScope(requirement: NfrRequirement): string {
  const what = requirement.endpoints.length
    ? requirement.endpoints.join(', ')
    : 'All endpoints'
  return `${what} — ${METRIC_LABEL[requirement.metric]} ${formatTarget(requirement.metric, requirement.target)}`
}

/**
 * Requirements implied by the thresholds already set on the chosen runs.
 *
 * "Fail if p95 over 2000ms" IS an acceptance criterion — the engineer entered it
 * before pressing Run. Making them retype it as a requirement is asking for the same
 * number twice and inviting the two copies to disagree.
 */
export function suggestRequirements(runs: PerfJob[]): NfrRequirement[] {
  const p95Targets = new Set<number>()
  const errorTargets = new Set<number>()
  for (const job of runs) {
    const cfg = job.loadConfig
    if (!cfg) continue
    if (cfg.thresholdP95Ms > 0) p95Targets.add(cfg.thresholdP95Ms)
    if (cfg.thresholdErrorRate >= 0) errorTargets.add(cfg.thresholdErrorRate)
  }
  const out: NfrRequirement[] = []
  const push = (metric: NfrMetric, target: number) => {
    out.push({
      ...blankRequirement(out.length),
      metric,
      target,
      scope: '',
      criterion: '',
    })
  }
  // Smallest target first: the strictest requirement reads as the headline one.
  ;[...p95Targets].sort((a, b) => a - b).forEach((t) => push('p95', t))
  ;[...errorTargets].sort((a, b) => a - b).forEach((t) => push('error-rate', t))
  return out.map((r, i) => ({ ...r, id: `NFR-P${String(i + 1).padStart(3, '0')}` }))
}

export function blankRequirement(index: number): NfrRequirement {
  return {
    id: `NFR-P${String(index + 1).padStart(3, '0')}`,
    scope: '',
    criterion: '',
    metric: 'p95',
    target: 3000,
    endpoints: [],
    pendingReason: '',
  }
}

// ------------------------------------------------------------------ evaluation

/** Per test case, the two verdicts the format keeps apart. */
export type CaseVerdict = 'pass' | 'failed'

/**
 * A requirement's status. `risk` is the source report's "PERFORMANCE RISK": every
 * case stayed up, and every case missed its target — functionally fine, and not
 * fit for purpose.
 */
export type NfrStatus = 'pass' | 'failed' | 'mixed' | 'risk' | 'pending'

export interface NfrCase {
  /** The endpoint name — the test case's identity in the report. */
  name: string
  method: string
  url: string
  /** Which run it came from, so a multi-run report stays traceable. */
  runLabel: string
  runId: string
  vus: number
  requests: number
  /** Average requests/second for this endpoint. NOT a peak — see DATA_LIMITATIONS. */
  avgRps: number
  successRate: number
  failedRequests: number
  p50: number
  p95: number
  max: number
  /** Server think time, average. */
  ttfb: number
  /** Did every request come back OK? */
  stability: CaseVerdict
  /** Did the measured metric meet the requirement's target? */
  performance: CaseVerdict
  /** The measured value the performance verdict was taken on. */
  measured: number
  /** That value, formatted for the metric it is. */
  measuredText: string
}

export interface NfrRequirementResult {
  requirement: NfrRequirement
  status: NfrStatus
  cases: NfrCase[]
  /** The one-line "Key result" cell of the executive summary. */
  keyResult: string
}

export interface NfrRecommendation {
  priority: 'high' | 'medium' | 'low'
  title: string
  detail: string
}

export interface NfrReport {
  meta: NfrMeta
  /** The runs this report was composed from, in the order chosen. */
  runs: PerfJob[]
  requirements: NfrRequirementResult[]
  findings: NfrRecommendation[]
  recommendations: NfrRecommendation[]
  finalAssessment: string
  /** True when at least one requirement was measured. */
  measured: boolean
}

export const METRIC_LABEL: Record<NfrMetric, string> = {
  p95: 'P95 response time',
  p50: 'P50 (median) response time',
  max: 'Slowest response',
  'error-rate': 'Failed-request rate',
  'success-rate': 'Success rate',
}

/** Is this metric a duration (ms) or a rate (0–1)? Drives every format + compare. */
export function isRateMetric(metric: NfrMetric): boolean {
  return metric === 'error-rate' || metric === 'success-rate'
}

export function formatTarget(metric: NfrMetric, target: number): string {
  if (metric === 'success-rate') return `≥ ${pct(target)}`
  if (metric === 'error-rate') return `≤ ${pct(target)}`
  return `≤ ${ms(target)}`
}

function measuredValue(metric: NfrMetric, endpoint: LoadEndpointResult): number {
  if (metric === 'p95') return endpoint.duration.p95
  if (metric === 'p50') return endpoint.duration.med
  if (metric === 'max') return endpoint.duration.max
  if (metric === 'success-rate') return endpoint.okRate
  return 1 - endpoint.okRate
}

export function formatMeasured(metric: NfrMetric, value: number): string {
  return isRateMetric(metric) ? pct(value) : ms(value)
}

/**
 * Success rate is the only metric where BIGGER is better, so it is the only one
 * compared the other way. Getting this backwards would report a passing system as
 * failed, which is the single most damaging mistake this file could make.
 */
function meetsTarget(metric: NfrMetric, value: number, target: number): boolean {
  if (metric === 'success-rate') return value >= target
  return value <= target
}

/** Does this requirement cover this endpoint name? Empty list = covers everything. */
function covers(requirement: NfrRequirement, endpointName: string): boolean {
  if (!requirement.endpoints.length) return true
  return requirement.endpoints.some((n) => n.toLowerCase() === endpointName.toLowerCase())
}

function caseFor(
  requirement: NfrRequirement,
  job: PerfJob,
  endpoint: LoadEndpointResult,
): NfrCase {
  const result = job.loadResult
  const durationSec = result && result.durationMs > 0 ? result.durationMs / 1000 : 0
  const measured = measuredValue(requirement.metric, endpoint)
  // okRate is a fraction of calls, so the failed COUNT is derived, not measured;
  // rounding keeps it a whole number of requests rather than 3.9999.
  const failed = Math.round(endpoint.calls * (1 - endpoint.okRate))
  return {
    name: endpoint.name || endpoint.url,
    method: endpoint.method,
    url: endpoint.url,
    runLabel: job.label,
    runId: job.id,
    vus: job.loadConfig?.vus ?? 0,
    requests: endpoint.calls,
    avgRps: durationSec > 0 ? endpoint.calls / durationSec : 0,
    successRate: endpoint.okRate,
    failedRequests: failed,
    p50: endpoint.duration.med,
    p95: endpoint.duration.p95,
    max: endpoint.duration.max,
    ttfb: endpoint.waiting.avg,
    stability: failed === 0 ? 'pass' : 'failed',
    performance: meetsTarget(requirement.metric, measured, requirement.target) ? 'pass' : 'failed',
    measured,
    measuredText: formatMeasured(requirement.metric, measured),
  }
}

function statusOf(cases: NfrCase[], pendingReason: string): NfrStatus {
  if (pendingReason.trim()) return 'pending'
  if (!cases.length) return 'pending'
  const passed = cases.filter((c) => c.performance === 'pass').length
  const stable = cases.every((c) => c.stability === 'pass')
  if (passed === cases.length) return 'pass'
  if (passed === 0) return stable ? 'risk' : 'failed'
  return 'mixed'
}

function keyResultOf(requirement: NfrRequirement, cases: NfrCase[], status: NfrStatus): string {
  if (status === 'pending') {
    return requirement.pendingReason.trim() || 'Not run — no test case covered this requirement'
  }
  const failed = cases.filter((c) => c.performance === 'failed')
  const passed = cases.filter((c) => c.performance === 'pass')
  const worst = [...cases].sort((a, b) =>
    requirement.metric === 'success-rate' ? a.measured - b.measured : b.measured - a.measured,
  )[0]

  if (status === 'pass') {
    return `All ${cases.length} test case${cases.length === 1 ? '' : 's'} met the target (worst ${worst.measuredText})`
  }
  if (status === 'risk') {
    return `No failed requests, but every test case missed the target (worst ${worst.measuredText})`
  }
  if (status === 'failed') {
    return `${failed.length} of ${cases.length} test case${cases.length === 1 ? '' : 's'} exceeded the target (worst ${worst.measuredText})`
  }
  // The same endpoint measured in two runs is two cases with ONE name, so a mixed
  // result reads "jobs list passed; jobs list exceeded the target" unless the run is
  // named too. Only qualify when it is actually ambiguous, so a single-run report
  // keeps its short, readable names.
  const perRun = new Set(cases.map((c) => c.runId)).size > 1
  const label = (c: NfrCase) => (perRun && c.runLabel ? `${c.name} (${c.runLabel})` : c.name)
  return `${passed.map(label).join(', ')} passed; ${failed.map(label).join(', ')} exceeded the target`
}

export const STATUS_LABEL: Record<NfrStatus, string> = {
  pass: 'PASS',
  failed: 'FAILED',
  mixed: 'MIXED',
  risk: 'PERFORMANCE RISK',
  pending: 'PENDING',
}

/**
 * Numbers this report cannot give, said out loud. The source format carries its own
 * "DATA LIMITATION" note for the same reason: a report that quietly substitutes a
 * number it did not measure is the one mistake nobody catches downstream.
 */
export const DATA_LIMITATIONS = [
  'Throughput here is the AVERAGE requests/second over the run, including its ramp-up. A peak figure exists in each run’s own report (taken from the busiest sampled slice) but is deliberately not used to judge a requirement: an NFR spanning several runs would then be graded on the single luckiest second of any of them.',
  'Per-endpoint throughput is that endpoint’s request count divided by the run duration — an average over the whole run, including its ramp-up.',
  'Failed-request counts are derived from the pass rate k6 reports, so they are rounded to whole requests.',
]

// ------------------------------------------------------------------ the build

/** The completed load runs a report can be built from. */
export function reportableRuns(jobs: PerfJob[]): PerfJob[] {
  return jobs.filter((j) => j.kind === 'load' && j.status === 'done' && j.loadResult !== null)
}

/** Every distinct endpoint (test case) name across the chosen runs. */
export function endpointNames(runs: PerfJob[]): string[] {
  const seen = new Set<string>()
  for (const job of runs) {
    for (const e of job.loadResult?.endpoints ?? []) seen.add(e.name || e.url)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

function findingsFor(results: NfrRequirementResult[], runs: PerfJob[]): NfrRecommendation[] {
  const out: NfrRecommendation[] = []

  const errored = results
    .flatMap((r) => r.cases)
    .filter((c) => c.stability === 'failed')
  if (errored.length) {
    const worst = [...errored].sort((a, b) => a.successRate - b.successRate)[0]
    out.push({
      priority: 'high',
      title: 'Requests failed under load',
      detail: `${errored.length} test case${errored.length === 1 ? '' : 's'} returned errors, worst ${worst.name} at ${pct(worst.successRate)} success (${worst.failedRequests.toLocaleString()} of ${worst.requests.toLocaleString()} requests). Errors that appear only under concurrency usually point at a connection pool, a rate limit, or a lock rather than the endpoint itself.`,
    })
  } else if (results.some((r) => r.cases.length)) {
    out.push({
      priority: 'low',
      title: 'Functional availability held',
      detail:
        'No HTTP failures were recorded in any executed test case. Where a requirement failed below, it failed on response time, not on availability.',
    })
  }

  for (const r of results.filter((x) => x.status === 'risk')) {
    out.push({
      priority: 'high',
      title: `${r.requirement.id} is a performance risk, not an outage`,
      detail: `Every test case stayed up and every one missed ${formatTarget(r.requirement.metric, r.requirement.target)}. The system is usable but not meeting the agreed target, which is the outcome most likely to be discovered by users rather than by monitoring.`,
    })
  }

  // Tail latency: a case whose worst call dwarfs its typical one is a stall, not a
  // uniformly slow endpoint, and the two have completely different fixes.
  for (const c of results.flatMap((r) => r.cases)) {
    if (c.p50 > 0 && c.max / c.p50 >= 10) {
      out.push({
        priority: 'medium',
        title: `${c.name} shows severe tail latency`,
        detail: `Median ${ms(c.p50)} against a slowest call of ${ms(c.max)} — ${(c.max / c.p50).toFixed(0)}× the typical request. A subset of requests stalled rather than the endpoint being uniformly slow, which points at contention, a cold cache, or a pause rather than request volume.`,
      })
    }
  }

  for (const c of results.flatMap((r) => r.cases)) {
    if (c.p95 > 0 && c.ttfb / c.p95 >= 0.8 && c.performance === 'failed') {
      out.push({
        priority: 'medium',
        title: `${c.name} spends its time on the server`,
        detail: `Server think time averages ${ms(c.ttfb)} of a ${ms(c.p95)} p95, so the delay is in producing the response, not transferring it. Profile the work behind this endpoint before adding capacity.`,
      })
    }
  }

  const pending = results.filter((r) => r.status === 'pending')
  if (pending.length) {
    out.push({
      priority: 'medium',
      title: `${pending.length} requirement${pending.length === 1 ? '' : 's'} not yet measured`,
      detail: `${pending.map((r) => r.requirement.id).join(', ')} carr${pending.length === 1 ? 'ies' : 'y'} no executed test case in this round and ${pending.length === 1 ? 'is' : 'are'} reported PENDING. ${pending.length === 1 ? 'It' : 'They'} must not be treated as passed.`,
    })
  }

  if (runs.length > 1) {
    out.push({
      priority: 'low',
      title: `Composed from ${runs.length} runs`,
      detail: `Test cases come from ${runs.map((r) => r.label).join(', ')}. Values are per run and are not pooled — a requirement covering several runs is judged case by case.`,
    })
  }

  return out
}

function recommendationsFor(results: NfrRequirementResult[]): NfrRecommendation[] {
  const out: NfrRecommendation[] = []
  const failedCases = results.flatMap((r) =>
    r.cases.filter((c) => c.performance === 'failed').map((c) => ({ r, c })),
  )

  const slowest = [...failedCases]
    .filter((x) => !isRateMetric(x.r.requirement.metric))
    .sort((a, b) => b.c.measured - a.c.measured)[0]
  if (slowest) {
    out.push({
      priority: 'high',
      title: `Profile ${slowest.c.name}`,
      detail: `It is the furthest outside its target — ${slowest.c.measuredText} against ${formatTarget(slowest.r.requirement.metric, slowest.r.requirement.target)} for ${slowest.r.requirement.id}. Start with the server-side work behind it (query plans, data assembly, external calls) before considering capacity.`,
    })
  }

  if (results.some((r) => r.cases.some((c) => c.stability === 'failed'))) {
    out.push({
      priority: 'high',
      title: 'Fix the failing requests before re-measuring timings',
      detail:
        'Response times measured alongside errors describe a system that is partly rejecting work, so they understate the real cost of the successful path. Re-run once the failures are gone.',
    })
  }

  if (results.some((r) => r.status === 'pending')) {
    out.push({
      priority: 'medium',
      title: 'Complete the pending requirements',
      detail:
        'Run the outstanding requirements and reissue this report. Until then the round has no verdict for them, and the executive summary says so.',
    })
  }

  out.push({
    priority: 'medium',
    title: 'Re-test after each fix, with the same profile',
    detail:
      'Keep the virtual-user count, duration, ramp-up and endpoint list identical between rounds. A comparison across two different profiles measures the profile, not the fix.',
  })

  return out
}

function finalAssessmentFor(results: NfrRequirementResult[]): string {
  const measured = results.filter((r) => r.status !== 'pending')
  if (!measured.length) {
    return 'No requirement was measured in this round, so no performance verdict can be given yet.'
  }
  const failing = measured.filter((r) => r.status !== 'pass')
  const unstable = measured.some((r) => r.cases.some((c) => c.stability === 'failed'))
  const pendingList = results.filter((r) => r.status === 'pending')
  const pending = pendingList.length
  // Always NAME the pending requirements, on both branches. A verdict that says
  // "everything passed" beside an unnamed count is the sentence most likely to be
  // quoted out of context as "the round passed".
  const pendingNote = pending
    ? ` ${pending} requirement${pending === 1 ? '' : 's'} (${pendingList.map((r) => r.requirement.id).join(', ')}) ${pending === 1 ? 'was' : 'were'} not executed and ${pending === 1 ? 'is' : 'are'} reported PENDING — ${pending === 1 ? 'it is' : 'they are'} not covered by this verdict.`
    : ''

  if (!failing.length) {
    return `All ${measured.length} measured requirement${measured.length === 1 ? '' : 's'} met their acceptance criteria with no failed requests.${pendingNote}`
  }

  const head = unstable
    ? 'The system did not remain fully available under the tested load'
    : 'The system remained functionally available in the tested scenarios'
  return `${head}, but ${failing.length} of ${measured.length} measured requirement${measured.length === 1 ? '' : 's'} did not meet ${failing.length === 1 ? 'its' : 'their'} target: ${failing.map((r) => r.requirement.id).join(', ')}.${pendingNote}`
}

/**
 * Compose the report. Pure: same runs + same requirements → same document, which
 * is what lets the screen, the Markdown, the PDF and the .docx agree.
 */
export function buildNfrReport(
  meta: NfrMeta,
  requirements: NfrRequirement[],
  runs: PerfJob[],
): NfrReport {
  const results: NfrRequirementResult[] = requirements.map((requirement) => {
    const cases: NfrCase[] = []
    // A requirement explicitly marked pending is not measured even if runs exist —
    // the engineer is saying "this round did not cover it", and the report must not
    // overrule them with numbers that happen to match the endpoint name.
    if (!requirement.pendingReason.trim()) {
      for (const job of runs) {
        for (const endpoint of job.loadResult?.endpoints ?? []) {
          if (covers(requirement, endpoint.name || endpoint.url)) {
            cases.push(caseFor(requirement, job, endpoint))
          }
        }
      }
    }
    const status = statusOf(cases, requirement.pendingReason)
    return { requirement, status, cases, keyResult: keyResultOf(requirement, cases, status) }
  })

  return {
    meta,
    runs,
    requirements: results,
    findings: findingsFor(results, runs),
    recommendations: recommendationsFor(results),
    finalAssessment: finalAssessmentFor(results),
    measured: results.some((r) => r.status !== 'pending'),
  }
}

/** The running footer, and the basis of the file name. */
export function reportTitle(meta: NfrMeta): string {
  const parts = [meta.system.trim() || 'Performance', 'Performance Test Report']
  if (meta.phase.trim()) parts.push(meta.phase.trim())
  return parts.join(' · ')
}

export function nfrFileName(meta: NfrMeta): string {
  const base = [meta.system.trim() || 'performance', 'NFR report', meta.phase.trim()]
    .filter(Boolean)
    .join(' ')
  return base.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'nfr-report'
}
