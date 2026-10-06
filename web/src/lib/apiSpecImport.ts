// Turn an API description file into saved requests: OpenAPI 3.x, Swagger 2.0 (JSON or
// YAML) and Postman Collection v2.x. Field report: a team with a Swagger file had to
// re-create every endpoint by hand (or scan a page and only get what that page calls),
// because Import accepted one cURL command at a time.
//
// Pure parsing — no network, no writes. The dialog (components/ApiSpecImportDialog.tsx)
// previews the result and saves what the engineer keeps. Every request keeps the same
// naming rule as Scan / cURL (`deriveName` + `uniqueName`), so an imported collection
// looks like one built any other way.

import type { ApiKV } from '@/lib/api'
import { deriveName, emptyDraft, uniqueName, type ApiDraft } from '@/lib/apiDraft'

export interface ImportedRequest {
  /** Stable key for the preview list. */
  id: string
  name: string
  /** Module the request is filed under: the OpenAPI tag / Postman folder. */
  group: string
  /** One line for the preview — the operation's own summary, when it has one. */
  summary: string
  draft: ApiDraft
}

export interface SpecImport {
  format: 'OpenAPI 3' | 'Swagger 2' | 'Postman'
  title: string
  requests: ImportedRequest[]
  /**
   * `{{variables}}` the requests use that the portal must know before Send works —
   * `baseUrl` when the spec has no absolute server, plus Postman's collection variables.
   * Values are the spec's own defaults ('' when it has none).
   */
  variables: { key: string; value: string }[]
  warnings: string[]
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const
const MAX_REQUESTS = 500

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Parse text as JSON, else YAML (loaded only when needed — it is not a small library). */
export async function parseSpecText(text: string): Promise<unknown> {
  const t = text.trim()
  if (!t) throw new Error('The file is empty.')
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t)
    } catch (err) {
      throw new Error(`Not valid JSON: ${(err as Error).message}`, { cause: err })
    }
  }
  const { parse } = await import('yaml')
  try {
    return parse(t, { maxAliasCount: 1000 })
  } catch (err) {
    throw new Error(`Not valid YAML: ${(err as Error).message}`, { cause: err })
  }
}

/** Detect the format and build the requests. Throws a readable Error when it's neither. */
export async function importApiSpec(text: string, existingNames: Iterable<string>): Promise<SpecImport> {
  const doc = await parseSpecText(text)
  if (!isObj(doc)) throw new Error('That file is not an API description (no top-level object).')
  const taken = new Set(existingNames)
  if (typeof doc.openapi === 'string' && doc.openapi.startsWith('3')) return fromOpenApi(doc, taken)
  if (doc.swagger === '2.0' || doc.swagger === 2) return fromSwagger2(doc, taken)
  const info = isObj(doc.info) ? doc.info : null
  if (info && /schema\.getpostman\.com|postman/i.test(str(info.schema)) && Array.isArray(doc.item)) {
    return fromPostman(doc, taken)
  }
  if (Array.isArray(doc.item) && info) return fromPostman(doc, taken)
  throw new Error(
    'Not a recognised format. Supported: OpenAPI 3.x and Swagger 2.0 (JSON or YAML), and ' +
      'Postman Collection v2 (exported as JSON).',
  )
}

// ---------------------------------------------------------------- OpenAPI / Swagger

/** Follow a local `#/components/...` reference, once per hop, with a cycle guard. */
function deref(doc: Json, v: unknown, seen = new Set<string>()): unknown {
  if (!isObj(v) || typeof v.$ref !== 'string') return v
  const ref = v.$ref
  if (!ref.startsWith('#/') || seen.has(ref)) return {}
  seen.add(ref)
  let cur: unknown = doc
  for (const part of ref.slice(2).split('/')) {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    cur = isObj(cur) ? cur[key] : undefined
  }
  return deref(doc, cur, seen)
}

/**
 * A small example value from a JSON schema: the schema's own example/default first,
 * else a typed placeholder. A `$ref` already being expanded further up (Pet → Owner →
 * Pet) stops there, and depth is capped too, so a recursive schema can't hang the import
 * or produce a body six copies deep.
 */
function sampleFromSchema(doc: Json, raw: unknown, depth = 0, stack: string[] = []): unknown {
  const ref = isObj(raw) && typeof raw.$ref === 'string' ? raw.$ref : ''
  if (ref && stack.includes(ref)) return null
  if (ref) stack = [...stack, ref]
  const s = deref(doc, raw)
  if (!isObj(s) || depth > 8) return null
  if (s.example !== undefined) return s.example
  if (s.default !== undefined) return s.default
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0]
  for (const k of ['allOf', 'oneOf', 'anyOf'] as const) {
    const list = s[k]
    if (Array.isArray(list) && list.length) {
      if (k !== 'allOf') return sampleFromSchema(doc, list[0], depth + 1, stack)
      const merged: Json = {}
      for (const part of list) {
        const v = sampleFromSchema(doc, part, depth + 1, stack)
        if (isObj(v)) Object.assign(merged, v)
      }
      return merged
    }
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type
  if (type === 'object' || isObj(s.properties)) {
    const out: Json = {}
    for (const [k, v] of Object.entries(isObj(s.properties) ? s.properties : {})) {
      out[k] = sampleFromSchema(doc, v, depth + 1, stack)
    }
    return out
  }
  if (type === 'array') return [sampleFromSchema(doc, s.items, depth + 1, stack)]
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false
  if (type === 'string') {
    if (s.format === 'date-time') return '2026-01-01T00:00:00Z'
    if (s.format === 'date') return '2026-01-01'
    if (s.format === 'email') return 'qa@example.com'
    if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000'
    return 'string'
  }
  return null
}

function paramValue(doc: Json, p: Json): string {
  const v =
    p.example !== undefined ? p.example : sampleFromSchema(doc, p.schema ?? { type: p.type })
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

interface OpBuild {
  method: string
  url: string
  query: ApiKV[]
  headers: ApiKV[]
  bodyMode: ApiDraft['bodyMode']
  body: string
  group: string
  summary: string
}

function finish(ops: OpBuild[], taken: Set<string>): ImportedRequest[] {
  return ops.slice(0, MAX_REQUESTS).map((op, i) => {
    const draft: ApiDraft = {
      ...emptyDraft(),
      method: op.method,
      url: op.url,
      query: op.query,
      headers: op.headers,
      bodyMode: op.bodyMode,
      body: op.body,
    }
    // A leading `{{baseUrl}}` would otherwise become part of every name ("GET baseUrl pets"),
    // and `new URL` percent-encodes a `{petId}` into "7BpetId 7D".
    const forName = op.url.replace(/^\{\{[^}]+\}\}/, '').replace(/\{([^{}]+)\}/g, '$1')
    const name = uniqueName(deriveName({ method: op.method, url: forName }), taken)
    taken.add(name)
    return { id: `r${i}`, name, group: op.group.slice(0, 60), summary: op.summary, draft }
  })
}

/** Path params `{id}` stay visible as-is: the engineer fills them; they are not variables. */
function openApiOps(
  doc: Json,
  base: string,
  bodyFor: (op: Json, params: Json[]) => { mode: ApiDraft['bodyMode']; body: string; type: string },
): OpBuild[] {
  const ops: OpBuild[] = []
  const paths = isObj(doc.paths) ? doc.paths : {}
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem)
    if (!isObj(item)) continue
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const m of METHODS) {
      const op = item[m]
      if (!isObj(op)) continue
      // Operation-level parameters override path-level ones with the same name + location.
      const byKey = new Map<string, Json>()
      for (const raw of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const p = deref(doc, raw)
        if (isObj(p) && typeof p.name === 'string') byKey.set(`${str(p.in)}:${p.name}`, p)
      }
      const params = [...byKey.values()]
      const query: ApiKV[] = params
        .filter((p) => p.in === 'query')
        .map((p) => ({ key: str(p.name), value: paramValue(doc, p), enabled: p.required === true }))
      const headers: ApiKV[] = params
        .filter((p) => p.in === 'header')
        .map((p) => ({ key: str(p.name), value: paramValue(doc, p), enabled: true }))
      const body = bodyFor(op, params)
      if (body.type) headers.push({ key: 'Content-Type', value: body.type, enabled: true })
      const tags = Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : []
      ops.push({
        method: m.toUpperCase(),
        url: `${base}${path}`,
        query,
        headers,
        bodyMode: body.mode,
        body: body.body,
        group: (tags[0] as string | undefined) ?? '',
        summary: str(op.summary) || str(op.operationId) || str(op.description).split('\n')[0],
      })
    }
  }
  return ops
}

function jsonBody(value: unknown): { mode: ApiDraft['bodyMode']; body: string } {
  if (value === undefined || value === null) return { mode: 'json', body: '{}' }
  return { mode: 'json', body: JSON.stringify(value, null, 2) }
}

/** Absolute server URL → used as-is. Relative / missing → `{{baseUrl}}` the engineer sets once. */
function resolveBase(server: string, warnings: string[], vars: SpecImport['variables']) {
  const trimmed = server.replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed) && !/\{[^}]+\}/.test(trimmed)) return trimmed
  vars.push({ key: 'baseUrl', value: /^https?:\/\//i.test(trimmed) ? trimmed : '' })
  warnings.push(
    trimmed
      ? `The spec's server "${trimmed}" is not a plain absolute URL, so requests use {{baseUrl}} — set it under Environment.`
      : 'The spec names no server, so requests use {{baseUrl}} — set it under Environment before you Send.',
  )
  return `{{baseUrl}}${/^\//.test(trimmed) ? trimmed : ''}`
}

function fromOpenApi(doc: Json, taken: Set<string>): SpecImport {
  const warnings: string[] = []
  const variables: SpecImport['variables'] = []
  const servers = Array.isArray(doc.servers) ? doc.servers.filter(isObj) : []
  const base = resolveBase(str(servers[0]?.url), warnings, variables)
  if (servers.length > 1) {
    warnings.push(`The spec lists ${servers.length} servers; the first one was used.`)
  }
  const ops = openApiOps(doc, base, (op) => {
    const rb = deref(doc, op.requestBody)
    if (!isObj(rb) || !isObj(rb.content)) return { mode: 'none', body: '', type: '' }
    const content = rb.content
    const type =
      Object.keys(content).find((k) => /json/i.test(k)) ?? Object.keys(content)[0] ?? ''
    const media = isObj(content[type]) ? content[type] : {}
    const examples = isObj(media.examples) ? Object.values(media.examples) : []
    const firstExample = examples.map((e) => deref(doc, e)).find(isObj)
    const value =
      media.example !== undefined
        ? media.example
        : firstExample && firstExample.value !== undefined
          ? firstExample.value
          : sampleFromSchema(doc, media.schema)
    if (/json/i.test(type)) return { ...jsonBody(value), type }
    return { mode: 'text', body: typeof value === 'string' ? value : '', type }
  })
  return done('OpenAPI 3', doc, ops, taken, variables, warnings)
}

function fromSwagger2(doc: Json, taken: Set<string>): SpecImport {
  const warnings: string[] = []
  const variables: SpecImport['variables'] = []
  const schemes = Array.isArray(doc.schemes) ? doc.schemes : []
  const scheme = schemes.includes('https') ? 'https' : str(schemes[0]) || 'https'
  const host = str(doc.host)
  const basePath = str(doc.basePath)
  const base = resolveBase(host ? `${scheme}://${host}${basePath}` : basePath, warnings, variables)
  const ops = openApiOps(doc, base, (_op, params) => {
    const bodyParam = params.find((p) => p.in === 'body')
    if (bodyParam) return { ...jsonBody(sampleFromSchema(doc, bodyParam.schema)), type: 'application/json' }
    const form = params.filter((p) => p.in === 'formData')
    if (form.length) {
      const body = form.map((p) => `${str(p.name)}=${encodeURIComponent(paramValue(doc, p))}`).join('&')
      return { mode: 'text', body, type: 'application/x-www-form-urlencoded' }
    }
    return { mode: 'none', body: '', type: '' }
  })
  return done('Swagger 2', doc, ops, taken, variables, warnings)
}

function done(
  format: SpecImport['format'],
  doc: Json,
  ops: OpBuild[],
  taken: Set<string>,
  variables: SpecImport['variables'],
  warnings: string[],
): SpecImport {
  if (!ops.length) throw new Error('The spec has no operations under "paths" to import.')
  if (ops.length > MAX_REQUESTS) {
    warnings.push(`Only the first ${MAX_REQUESTS} of ${ops.length} operations were read.`)
  }
  if (ops.some((o) => /\{[^{}]+\}/.test(o.url.replace(/\{\{[^}]+\}\}/g, '')))) {
    warnings.push('Path parameters like {id} are left in the URL — replace them before you Send.')
  }
  const info = isObj(doc.info) ? doc.info : {}
  return {
    format,
    title: str(info.title) || 'API',
    requests: finish(ops, taken),
    variables,
    warnings,
  }
}

// ---------------------------------------------------------------- Postman

function postmanUrl(u: unknown): { url: string; query: ApiKV[] } {
  if (typeof u === 'string') return splitQuery(u)
  if (!isObj(u)) return { url: '', query: [] }
  const query: ApiKV[] = Array.isArray(u.query)
    ? u.query.filter(isObj).map((q) => ({
        key: str(q.key),
        value: str(q.value),
        enabled: q.disabled !== true,
      }))
    : []
  if (typeof u.raw === 'string' && u.raw) {
    const split = splitQuery(u.raw)
    return { url: split.url, query: query.length ? query : split.query }
  }
  const host = Array.isArray(u.host) ? u.host.join('.') : str(u.host)
  const path = Array.isArray(u.path) ? u.path.map((p) => (isObj(p) ? str(p.value) : String(p))).join('/') : str(u.path)
  const protocol = str(u.protocol)
  return { url: `${protocol ? `${protocol}://` : ''}${host}${path ? `/${path}` : ''}`, query }
}

/** Split the query off a URL by hand — `new URL` would choke on `{{baseUrl}}/x`. */
function splitQuery(raw: string): { url: string; query: ApiKV[] } {
  const i = raw.indexOf('?')
  if (i < 0) return { url: raw, query: [] }
  const query = raw
    .slice(i + 1)
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=')
      const key = eq < 0 ? pair : pair.slice(0, eq)
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s)
        } catch {
          return s
        }
      }
      return { key: dec(key), value: dec(value), enabled: true }
    })
  return { url: raw.slice(0, i), query }
}

function fromPostman(doc: Json, taken: Set<string>): SpecImport {
  const warnings: string[] = []
  const ops: OpBuild[] = []
  let skippedForm = 0
  const walk = (items: unknown[], folder: string) => {
    for (const raw of items) {
      if (!isObj(raw)) continue
      if (Array.isArray(raw.item)) {
        // Nested folders flatten into "Parent / Child" — one module level in the portal.
        const name = str(raw.name)
        walk(raw.item, folder && name ? `${folder} / ${name}` : name || folder)
        continue
      }
      const req = isObj(raw.request) ? raw.request : typeof raw.request === 'string' ? { url: raw.request } : null
      if (!req) continue
      const { url, query } = postmanUrl(req.url)
      const headers: ApiKV[] = Array.isArray(req.header)
        ? req.header.filter(isObj).map((h) => ({
            key: str(h.key),
            value: str(h.value),
            enabled: h.disabled !== true,
          }))
        : []
      let bodyMode: ApiDraft['bodyMode'] = 'none'
      let body = ''
      const b = isObj(req.body) ? req.body : null
      if (b?.mode === 'raw' && typeof b.raw === 'string') {
        const lang = isObj(b.options) && isObj(b.options.raw) ? str(b.options.raw.language) : ''
        const looksJson = lang === 'json' || /^\s*[{[]/.test(b.raw)
        bodyMode = looksJson ? 'json' : 'text'
        body = b.raw
      } else if (b?.mode === 'urlencoded' && Array.isArray(b.urlencoded)) {
        bodyMode = 'text'
        body = b.urlencoded
          .filter((p) => isObj(p) && p.disabled !== true)
          .map((p) => `${str((p as Json).key)}=${encodeURIComponent(str((p as Json).value))}`)
          .join('&')
        if (!headers.some((h) => h.key.toLowerCase() === 'content-type')) {
          headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true })
        }
      } else if (b?.mode === 'formdata' || b?.mode === 'file' || b?.mode === 'graphql') {
        skippedForm++
      }
      ops.push({
        method: (str(req.method) || 'GET').toUpperCase(),
        url,
        query,
        headers,
        bodyMode,
        body,
        group: folder,
        summary: str(raw.name),
      })
    }
  }
  walk(doc.item as unknown[], '')
  if (!ops.length) throw new Error('The collection has no requests to import.')
  if (ops.length > MAX_REQUESTS) {
    warnings.push(`Only the first ${MAX_REQUESTS} of ${ops.length} requests were read.`)
  }
  if (skippedForm) {
    warnings.push(
      `${skippedForm} request${skippedForm === 1 ? ' has' : 's have'} a form-data / file / GraphQL body, which isn't supported — the body was left empty.`,
    )
  }
  // Postman's own {{variables}} use the same syntax as the portal's environments, so they
  // carry over untouched — the engineer only has to give them values.
  const variables: SpecImport['variables'] = Array.isArray(doc.variable)
    ? doc.variable
        .filter(isObj)
        .map((v) => ({ key: str(v.key), value: typeof v.value === 'string' ? v.value : '' }))
        .filter((v) => v.key)
    : []
  if (isObj(doc.auth)) {
    warnings.push('The collection has collection-level auth; add the Authorization header (or a variable for it) yourself.')
  }
  const info = isObj(doc.info) ? doc.info : {}
  return {
    format: 'Postman',
    title: str(info.name) || 'Collection',
    requests: finish(ops, taken),
    variables,
    warnings,
  }
}
