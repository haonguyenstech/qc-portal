// Parse a pasted `curl` command into the API Testing request shape, and render a
// request back out as a copy-paste curl. Deliberately tolerant: real commands come
// from browser "Copy as cURL", Postman, docs — with quotes, `\`/`^` line
// continuations, and a long tail of flags most of which we can safely ignore.

import type { ApiBodyMode, ApiKV } from './api'

export interface ParsedCurl {
  method: string
  url: string
  query: ApiKV[]
  headers: ApiKV[]
  bodyMode: ApiBodyMode
  body: string
}

/** Split a command line into argv, honoring quotes, escapes and line continuations. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let has = false // distinguishes an empty quoted "" token from whitespace
  let single = false
  let double = false
  let ansi = false // inside a $'…' ANSI-C quoted string (Chrome/Safari "Copy as cURL")
  const s = input
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (ansi) {
      // ANSI-C quoting: single-quoted but with C escape sequences decoded.
      if (c === '\\' && i + 1 < s.length) {
        const n = s[++i]
        cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
      } else if (c === "'") {
        ansi = false
      } else {
        cur += c
      }
      continue
    }
    if (single) {
      if (c === "'") single = false
      else cur += c
      continue
    }
    if (double) {
      if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
        cur += s[++i]
      } else if (c === '"') {
        double = false
      } else {
        cur += c
      }
      continue
    }
    // $'…' — start of an ANSI-C quoted string (only when the $ directly precedes ').
    if (c === '$' && s[i + 1] === "'") {
      ansi = true
      has = true
      i++
      continue
    }
    if (c === "'") {
      single = true
      has = true
      continue
    }
    if (c === '"') {
      double = true
      has = true
      continue
    }
    if (c === '\\') {
      // `\` before a newline is a line continuation; otherwise it escapes one char.
      if (s[i + 1] === '\n') {
        i++
        continue
      }
      if (s[i + 1] === '\r') {
        i++
        if (s[i + 1] === '\n') i++
        continue
      }
      if (i + 1 < s.length) {
        cur += s[++i]
        has = true
        continue
      }
      continue
    }
    // Windows caret line-continuation.
    if (c === '^' && (s[i + 1] === '\n' || s[i + 1] === '\r')) continue
    if (/\s/.test(c)) {
      if (has || cur.length) {
        tokens.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    cur += c
    has = true
  }
  if (has || cur.length) tokens.push(cur)
  return tokens
}

const kv = (key: string, value: string): ApiKV => ({ key, value, enabled: true })

// Flags that take a value we don't model — skip the flag AND its argument.
const SKIP_WITH_ARG = new Set([
  '-o',
  '--output',
  '-w',
  '--write-out',
  '--connect-timeout',
  '-m',
  '--max-time',
  '--retry',
  '-x',
  '--proxy',
  '--cacert',
  '--cert',
  '--key',
  '-c',
  '--cookie-jar',
  '--resolve',
  '--limit-rate',
])

/** Parse a curl command. Returns null when no URL can be found. */
export function parseCurl(input: string): ParsedCurl | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let tokens = tokenize(trimmed)
  // Drop a leading `curl` (and a `$ ` prompt if pasted with one).
  if (tokens[0] === '$') tokens = tokens.slice(1)
  if (tokens[0]?.toLowerCase() === 'curl') tokens = tokens.slice(1)

  let method = ''
  let url = ''
  const headers: ApiKV[] = []
  const dataParts: string[] = []
  let dataProvided = false
  let getFlag = false
  let jsonFlag = false

  const addHeader = (raw: string) => {
    const idx = raw.indexOf(':')
    if (idx < 0) {
      headers.push(kv(raw.trim(), ''))
    } else {
      headers.push(kv(raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()))
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const next = () => tokens[++i] ?? ''
    if (t === '-X' || t === '--request') {
      method = next().toUpperCase()
    } else if (t === '-H' || t === '--header') {
      addHeader(next())
    } else if (t === '-A' || t === '--user-agent') {
      headers.push(kv('User-Agent', next()))
    } else if (t === '-e' || t === '--referer') {
      headers.push(kv('Referer', next()))
    } else if (t === '-b' || t === '--cookie') {
      headers.push(kv('Cookie', next()))
    } else if (t === '-u' || t === '--user') {
      try {
        headers.push(kv('Authorization', `Basic ${btoa(next())}`))
      } catch {
        i++ // skip the value even if btoa choked on non-latin
      }
    } else if (t === '--url') {
      url = next()
    } else if (t === '-G' || t === '--get') {
      getFlag = true
    } else if (t === '--json') {
      jsonFlag = true
      dataProvided = true
      dataParts.push(next())
    } else if (
      t === '-d' ||
      t === '--data' ||
      t === '--data-raw' ||
      t === '--data-ascii' ||
      t === '--data-binary' ||
      t === '--data-urlencode'
    ) {
      dataProvided = true
      dataParts.push(next())
    } else if (SKIP_WITH_ARG.has(t)) {
      i++ // consume + discard its argument
    } else if (t.startsWith('-')) {
      // A no-arg flag we don't care about (-s, -L, -k, -i, --compressed, …). Ignore.
    } else if (!url) {
      url = t
    }
    // Extra positionals after the URL are ignored.
  }

  if (!url) return null

  const body = dataParts.join('&')

  // -G moves the data into the query string.
  const query: ApiKV[] = []
  if (getFlag && body) {
    for (const pair of body.split('&')) {
      const eq = pair.indexOf('=')
      query.push(eq < 0 ? kv(pair, '') : kv(pair.slice(0, eq), pair.slice(eq + 1)))
    }
  }

  // Pull query params off the URL into rows (leaving the base URL clean) when the
  // URL is absolute enough to parse; otherwise keep it verbatim.
  try {
    const u = new URL(url)
    u.searchParams.forEach((value, key) => query.push(kv(key, value)))
    u.search = ''
    url = u.toString()
  } catch {
    /* relative / schemeless URL — keep as typed */
  }

  const hasBody = !getFlag && dataProvided && body.length > 0
  if (!method) method = dataProvided && !getFlag ? 'POST' : 'GET'

  const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? ''
  let bodyMode: ApiBodyMode = 'none'
  if (hasBody) {
    const looksJson =
      jsonFlag ||
      /json/i.test(ctHeader) ||
      /^\s*[[{]/.test(body)
    bodyMode = looksJson ? 'json' : 'text'
    if (jsonFlag && !ctHeader) headers.push(kv('Content-Type', 'application/json'))
  }

  return {
    method,
    url,
    query,
    headers,
    bodyMode,
    body: hasBody ? body : '',
  }
}

/** Quote a token for a POSIX shell (single-quote, escaping embedded quotes). */
function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Render a request as a copy-paste curl command (multi-line for readability). */
export function toCurl(req: ParsedCurl): string {
  let url = req.url
  const enabledQuery = req.query.filter((q) => q.enabled && q.key)
  if (enabledQuery.length) {
    const qs = enabledQuery
      .map((q) => `${encodeURIComponent(q.key)}=${encodeURIComponent(q.value)}`)
      .join('&')
    url += (url.includes('?') ? '&' : '?') + qs
  }
  const parts = [`curl -X ${req.method} ${shellQuote(url)}`]
  for (const h of req.headers) {
    if (h.enabled && h.key) parts.push(`  -H ${shellQuote(`${h.key}: ${h.value}`)}`)
  }
  if (req.bodyMode !== 'none' && req.body) {
    parts.push(`  --data ${shellQuote(req.body)}`)
  }
  return parts.join(' \\\n')
}
