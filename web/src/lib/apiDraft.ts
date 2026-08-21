// The request draft, and the two naming rules every place that CREATES a saved request
// has to obey. Extracted out of ApiTestingPage because the Flows tab creates requests
// too (its "Add request → Import cURL" writes one before adding it as a step), and a
// second copy of these rules is exactly how the two sides drift apart.

import type { ApiRequestDef } from '@/lib/api'

/**
 * The request the builder edits. `group` (the module a saved request is filed under) is
 * deliberately NOT part of it — that's collection organization, changed from the saved
 * list, and a PUT without it keeps whatever the server has on disk.
 */
export type ApiDraft = Omit<ApiRequestDef, 'name' | 'savedAt' | 'group'>

export function emptyDraft(): ApiDraft {
  return {
    method: 'GET',
    url: '',
    query: [],
    headers: [],
    bodyMode: 'none',
    body: '',
    assertions: [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
    aiExpect: '',
    captures: [],
  }
}

/** A readable, filename-safe name derived from a request (server NAME_RE: [\w .-]). */
export function deriveName(d: Pick<ApiDraft, 'method' | 'url'>): string {
  let path = d.url
  try {
    const u = new URL(d.url)
    path = u.pathname && u.pathname !== '/' ? u.pathname : u.host
  } catch {
    /* schemeless URL — use it as typed */
  }
  const base = `${d.method} ${path}`
    .replace(/[^\w .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return base || d.method
}

/**
 * First free `base`, `base 2`, `base 3`… among the names already taken.
 *
 * The suffix is ` 2`, NOT ` (2)`: a request name becomes a file name and has to match the
 * server's `NAME_RE = /^[\w .-]{1,60}$/`, which has no parenthesis — a `base (2)` name is
 * rejected with `invalid request name`. The old create-on-send path built exactly that and
 * swallowed the failure, so the SECOND request to an endpoint already in the collection
 * silently never reached disk.
 */
export function uniqueName(base: string, taken: Set<string>): string {
  const head = (base.length <= 60 ? base : base.slice(0, 60).trim()) || 'Request'
  if (!taken.has(head)) return head
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`
    const candidate = `${head.slice(0, 60 - suffix.length).trim()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}
