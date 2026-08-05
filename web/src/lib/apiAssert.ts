// The client-side assertion engine for API Testing.
//
// Assertions are evaluated in the BROWSER (the server's `/send` proxy returns the raw
// status/headers/body and stays dumb about verdicts), and both the single-request
// builder and the flow runner have to judge a response identically — so the engine
// lives here rather than being duplicated per caller. A second copy would drift, and
// a flow whose steps grade differently from the same request run on its own is worse
// than no flow at all.

import type { ApiAssertion, ApiSendResult } from '@/lib/api'

/** Resolve a simple dotted/bracket JSON path (e.g. `data.items[0].id`). */
export function getJsonPath(root: unknown, path: string): unknown {
  if (!path) return root
  const parts = path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  let cur: unknown = root
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

export interface AssertionResult {
  assertion: ApiAssertion
  pass: boolean
  /** WHAT was checked — the JSON path, header name, `status`, `time`, `body`. */
  key: string
  /** The value actually observed in the response, ready to display. */
  actual: string
  /** The value the check wanted. '' when the check only asks that something exist. */
  expected: string
  /** One-line `key: actual — expected …` summary, composed from the three above. */
  detail: string
}

/** Longest actual/expected value shown before it's clipped for display. */
const MAX_SHOWN = 140

function show(v: string): string {
  return v.length > MAX_SHOWN ? `${v.slice(0, MAX_SHOWN)}…` : v
}

/**
 * Build one result. `key` / `actual` / `expected` are the three things a QC engineer
 * needs to see per check ("what did I look at, what came back, what did I want"), and
 * `detail` is derived from them so the row text and the flow-step summary can never
 * disagree about the same check.
 */
function mk(
  assertion: ApiAssertion,
  pass: boolean,
  key: string,
  actual: string,
  expected: string,
): AssertionResult {
  const a = show(actual)
  const e = show(expected)
  return {
    assertion,
    pass,
    key,
    actual: a,
    expected: e,
    detail: e ? `${key}: ${a} — expected ${e}` : `${key}: ${a}`,
  }
}

/** Evaluate the request's assertions against a response — all client-side. */
export function evaluateAssertions(assertions: ApiAssertion[], res: ApiSendResult): AssertionResult[] {
  let parsedJson: unknown
  let parsedOk = false
  if (res.bodyText) {
    try {
      parsedJson = JSON.parse(res.bodyText)
      parsedOk = true
    } catch {
      parsedOk = false
    }
  }
  return assertions
    .filter((a) => a.enabled)
    .map((a) => {
      const status = res.status ?? 0
      switch (a.type) {
        case 'status-2xx':
          return mk(a, status >= 200 && status < 300, 'status', String(status), '2xx')
        case 'status-equals': {
          const want = Number(a.expected)
          return mk(a, status === want, 'status', String(status), a.expected || '?')
        }
        case 'body-contains': {
          const body = res.bodyText ?? ''
          const at = a.expected ? body.indexOf(a.expected) : -1
          return mk(
            a,
            !!a.expected && at >= 0,
            'body',
            !a.expected ? 'no text set' : at >= 0 ? `found at index ${at}` : 'not found',
            a.expected ? `contains "${a.expected}"` : '',
          )
        }
        case 'body-matches': {
          if (!a.expected) return mk(a, false, 'body', 'no pattern set', '')
          let re: RegExp
          try {
            re = new RegExp(a.expected)
          } catch {
            return mk(a, false, 'body', 'invalid regex', `/${a.expected}/`)
          }
          const m = re.exec(res.bodyText ?? '')
          return mk(a, !!m, 'body', m ? `matched "${m[0]}"` : 'no match', `matches /${a.expected}/`)
        }
        case 'json-equals': {
          const key = a.target || '(root)'
          const want = a.expected || '?'
          if (!parsedOk) return mk(a, false, key, 'response is not JSON', want)
          const actual = getJsonPath(parsedJson, a.target)
          const actualStr = actual === undefined ? 'undefined' : JSON.stringify(actual)
          // Compare on the FULL value; only clip what we display (mk does), so a big
          // object at the path (or root) doesn't dump the whole body into the row.
          const pass = String(actual) === a.expected || actualStr === a.expected
          return mk(a, pass, key, actualStr, want)
        }
        case 'json-exists': {
          const key = a.target || '(root)'
          if (!parsedOk) return mk(a, false, key, 'response is not JSON', 'any value')
          const actual = getJsonPath(parsedJson, a.target)
          return mk(
            a,
            actual !== undefined,
            key,
            actual === undefined ? 'missing' : JSON.stringify(actual),
            'any value',
          )
        }
        case 'header-equals': {
          const actual = res.headers?.[a.target.toLowerCase()]
          return mk(
            a,
            actual !== undefined && actual === a.expected,
            a.target || '?',
            actual ?? '(absent)',
            a.expected || '?',
          )
        }
        case 'header-exists': {
          const actual = res.headers?.[a.target.toLowerCase()]
          return mk(a, actual !== undefined, a.target || '?', actual ?? '(absent)', 'any value')
        }
        case 'time-below': {
          const limit = Number(a.expected)
          return mk(
            a,
            Number.isFinite(limit) && res.timeMs < limit,
            'time',
            `${res.timeMs}ms`,
            `under ${a.expected || '?'}ms`,
          )
        }
        default:
          return mk(a, false, a.type, 'unknown assertion', '')
      }
    })
}

