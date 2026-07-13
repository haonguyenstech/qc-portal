// Automated QC scan of an API response — the "find issues / lỗ hổng" half of API
// testing. Independent of the user's own assertions: these are heuristics every QC
// engineer would want run on every response (security headers, data leaks, error
// handling, performance). All best-effort and non-authoritative — findings are hints
// to investigate, graded by severity so the real problems stand out.

import type { ApiSendResult } from './api'

export type Severity = 'high' | 'warn' | 'info'

export interface ApiFinding {
  id: string
  severity: Severity
  category: 'security' | 'correctness' | 'performance' | 'quality'
  title: string
  detail: string
}

export const SEVERITY_RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 }

/** Node's fetch lowercases header names; look one up defensively anyway. */
function header(res: ApiSendResult, name: string): string | undefined {
  const h = res.headers ?? {}
  const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? h[key] : undefined
}

/** Run every heuristic against a successful response. Returns findings, worst first. */
export function scanResponse(res: ApiSendResult, req: { url: string; method: string }): ApiFinding[] {
  const findings: ApiFinding[] = []
  if (!res.ok) return findings // a network failure has no response to scan

  const add = (
    id: string,
    severity: Severity,
    category: ApiFinding['category'],
    title: string,
    detail: string,
  ) => findings.push({ id, severity, category, title, detail })

  const status = res.status ?? 0
  const isHttps = /^https:/i.test(req.url)
  const body = res.bodyText ?? ''
  const contentType = (res.contentType ?? '').toLowerCase()

  // ---- correctness -------------------------------------------------------
  if (status >= 500) {
    add('status-5xx', 'high', 'correctness', `Server error (${status})`, 'The API returned a 5xx — an unhandled failure on the server.')
  } else if (status >= 400) {
    add('status-4xx', 'warn', 'correctness', `Client error (${status})`, `The request was rejected with ${status} ${res.statusText ?? ''}.`.trim())
  }
  if (status >= 300 && status < 400) {
    add('status-3xx', 'info', 'correctness', `Redirect (${status})`, 'The endpoint redirected — the response follows the final hop.')
  }
  if (contentType.includes('json') && body.trim()) {
    try {
      JSON.parse(body)
    } catch {
      add('bad-json', 'warn', 'correctness', 'Malformed JSON body', 'Content-Type is JSON but the body did not parse — clients may break.')
    }
  }
  if (status >= 200 && status < 300 && !body.trim()) {
    add('empty-2xx', 'info', 'quality', 'Empty success body', 'A 2xx response with no body — confirm this is intended.')
  }
  if (body.trim() && !contentType) {
    add('no-content-type', 'warn', 'quality', 'Missing Content-Type', 'The response has a body but no Content-Type header — clients must guess how to parse it.')
  }

  // ---- performance -------------------------------------------------------
  if (res.timeMs > 5000) {
    add('slow-high', 'high', 'performance', `Very slow response (${res.timeMs} ms)`, 'Over 5s — likely a timeout risk for real clients.')
  } else if (res.timeMs > 2000) {
    add('slow-warn', 'warn', 'performance', `Slow response (${res.timeMs} ms)`, 'Over 2s — worth profiling.')
  }
  if (res.truncated) {
    add('large-body', 'info', 'performance', 'Large response body', 'The body was truncated for display — the endpoint returns a lot of data.')
  }

  // ---- security: transport & headers ------------------------------------
  if (!isHttps) {
    add('no-https', 'high', 'security', 'Unencrypted transport (HTTP)', 'The endpoint is plain HTTP — credentials and data travel in cleartext.')
  } else if (!header(res, 'strict-transport-security')) {
    add('no-hsts', 'warn', 'security', 'No HSTS header', 'Strict-Transport-Security is missing — browsers may still try HTTP.')
  }
  if ((header(res, 'x-content-type-options') ?? '').toLowerCase() !== 'nosniff') {
    add('no-nosniff', 'warn', 'security', 'Missing X-Content-Type-Options: nosniff', 'Without it, browsers may MIME-sniff the body into an executable type.')
  }
  if (!header(res, 'content-security-policy')) {
    add('no-csp', 'info', 'security', 'No Content-Security-Policy', 'For HTML-serving endpoints this leaves XSS less contained.')
  }
  if (!header(res, 'x-frame-options') && !/frame-ancestors/i.test(header(res, 'content-security-policy') ?? '')) {
    add('no-frame', 'info', 'security', 'No clickjacking protection', 'Neither X-Frame-Options nor CSP frame-ancestors is set.')
  }

  // ---- security: CORS ----------------------------------------------------
  const acao = header(res, 'access-control-allow-origin')
  const acac = (header(res, 'access-control-allow-credentials') ?? '').toLowerCase() === 'true'
  if (acao === '*' && acac) {
    add('cors-cred-wildcard', 'high', 'security', 'CORS allows any origin with credentials', 'Access-Control-Allow-Origin: * together with credentials exposes authenticated responses to any site.')
  } else if (acao === '*') {
    add('cors-wildcard', 'warn', 'security', 'Permissive CORS (Allow-Origin: *)', 'Any website can read this response — confirm that is intended for a public API.')
  }

  // ---- security: information disclosure ---------------------------------
  const server = header(res, 'server')
  if (server && /\d/.test(server)) {
    add('server-version', 'info', 'security', 'Server version disclosed', `Server: ${server} — reveals software/version to attackers.`)
  }
  const poweredBy = header(res, 'x-powered-by')
  if (poweredBy) {
    add('x-powered-by', 'warn', 'security', 'Technology disclosed (X-Powered-By)', `X-Powered-By: ${poweredBy} — remove to reduce fingerprinting.`)
  }

  // ---- security: cookies -------------------------------------------------
  const setCookie = header(res, 'set-cookie')
  if (setCookie) {
    const c = setCookie.toLowerCase()
    if (!c.includes('httponly')) add('cookie-httponly', 'warn', 'security', 'Cookie without HttpOnly', 'A Set-Cookie is missing HttpOnly — readable by JavaScript (XSS token theft).')
    if (isHttps && !c.includes('secure')) add('cookie-secure', 'warn', 'security', 'Cookie without Secure', 'A Set-Cookie is missing Secure — it can be sent over plain HTTP.')
    if (!c.includes('samesite')) add('cookie-samesite', 'info', 'security', 'Cookie without SameSite', 'A Set-Cookie is missing SameSite — weaker CSRF protection.')
  }

  // ---- security: sensitive data / error leakage in the body -------------
  if (body) {
    const sample = body.slice(0, 20000)
    if (
      /\b(at\s+[\w.$]+\s*\(|Traceback \(most recent call last\)|Exception in thread|System\.[A-Za-z.]+Exception|goroutine \d+ \[|\.(java|py|rb|php|go|ts|js):\d+)\b/.test(
        sample,
      )
    ) {
      add('stacktrace', 'high', 'security', 'Possible stack trace / internal error leaked', 'The body looks like it contains a stack trace or internal error — leaks implementation details.')
    }
    if (/\b(SQLSTATE|SQL syntax|ORA-\d{5}|ORDER BY clause|native client|psql:|mysql_)\b/i.test(sample)) {
      add('sql-error', 'high', 'security', 'Possible database error leaked', 'The body mentions a database/SQL error — a sign of missing error handling (and injection surface).')
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(sample)) {
      add('private-key', 'high', 'security', 'Private key material in response', 'The body contains a PEM private key block.')
    }
    if (/"(password|passwd|pwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)"\s*:\s*"[^"]+"/i.test(sample)) {
      add('sensitive-field', 'high', 'security', 'Possible secret in response body', 'A field name like password/secret/token appears with a value — confirm it should be returned.')
    }
    if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(sample) && /\b(ssn|dob|creditcard|card_number|cvv)\b/i.test(sample)) {
      add('pii', 'warn', 'security', 'Possible PII in response', 'The body appears to contain personal data (emails alongside SSN/DOB/card fields) — verify it should be exposed.')
    }
  }

  findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return findings
}
