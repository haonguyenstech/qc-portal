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
  detail: string
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
          return {
            assertion: a,
            pass: status >= 200 && status < 300,
            detail: `status ${status}`,
          }
        case 'status-equals': {
          const want = Number(a.expected)
          return {
            assertion: a,
            pass: status === want,
            detail: `status ${status} — expected ${a.expected || '?'}`,
          }
        }
        case 'body-contains':
          return {
            assertion: a,
            pass: !!a.expected && (res.bodyText ?? '').includes(a.expected),
            detail: a.expected ? `looking for "${a.expected}"` : 'no text set',
          }
        case 'body-matches': {
          if (!a.expected) return { assertion: a, pass: false, detail: 'no pattern set' }
          try {
            const re = new RegExp(a.expected)
            return {
              assertion: a,
              pass: re.test(res.bodyText ?? ''),
              detail: `/${a.expected}/`,
            }
          } catch {
            return { assertion: a, pass: false, detail: 'invalid regex' }
          }
        }
        case 'json-equals': {
          if (!parsedOk) return { assertion: a, pass: false, detail: 'response is not JSON' }
          const actual = getJsonPath(parsedJson, a.target)
          const actualStr = actual === undefined ? 'undefined' : JSON.stringify(actual)
          const want = a.expected
          // Compare on the FULL value; only clip what we display so a big object at
          // the path (or root) doesn't dump the whole body into the row.
          const pass = String(actual) === want || actualStr === want
          const shown = actualStr.length > 140 ? `${actualStr.slice(0, 140)}…` : actualStr
          return {
            assertion: a,
            pass,
            detail: `${a.target || '(root)'} = ${shown} — expected ${want || '?'}`,
          }
        }
        case 'json-exists': {
          if (!parsedOk) return { assertion: a, pass: false, detail: 'response is not JSON' }
          const actual = getJsonPath(parsedJson, a.target)
          return {
            assertion: a,
            pass: actual !== undefined,
            detail: `${a.target || '(root)'} ${actual !== undefined ? 'present' : 'missing'}`,
          }
        }
        case 'header-equals': {
          const key = a.target.toLowerCase()
          const actual = res.headers?.[key]
          return {
            assertion: a,
            pass: actual !== undefined && actual === a.expected,
            detail: `${a.target || '?'}: ${actual ?? '(absent)'} — expected ${a.expected || '?'}`,
          }
        }
        case 'header-exists': {
          const key = a.target.toLowerCase()
          const actual = res.headers?.[key]
          return {
            assertion: a,
            pass: actual !== undefined,
            detail: `${a.target || '?'} ${actual !== undefined ? 'present' : 'absent'}`,
          }
        }
        case 'time-below': {
          const limit = Number(a.expected)
          return {
            assertion: a,
            pass: Number.isFinite(limit) && res.timeMs < limit,
            detail: `${res.timeMs}ms — limit ${a.expected || '?'}ms`,
          }
        }
        default:
          return { assertion: a, pass: false, detail: 'unknown assertion' }
      }
    })
}

