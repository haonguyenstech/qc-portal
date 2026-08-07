/**
 * Schema-aware completion for the Database page's SQL editor.
 *
 * This is the whole reason the editor is worth having over a textarea: nobody
 * remembers whether the column is `CreatedAt`, `CreatedAtUtc` or `created_at`, and on
 * a 158-table database getting it wrong costs a round trip to an error message. The
 * suggestions come from the LIVE schema (GET /api/database/schema), so what's offered
 * is what exists.
 *
 * Kept as pure functions — text + caret + schema in, a ranked list out — so the
 * behaviour can be exercised without mounting an editor, and so the component below it
 * only has to worry about keys and painting.
 */

export interface SchemaColumn {
  name: string
  type: string
  key: string
  nullable: boolean
}
export interface SchemaTable {
  name: string
  kind: 'table' | 'view'
  columns: SchemaColumn[]
}

export type SuggestKind = 'table' | 'column' | 'keyword'

export interface Suggestion {
  /** What's shown, and what gets inserted. */
  label: string
  kind: SuggestKind
  /** Right-hand caption: a column's type, a table's column count. */
  detail?: string
  /** Which table a column came from — shown when the column isn't qualified. */
  from?: string
}

/** What the caret is sitting in, and therefore what should be offered. */
export interface CompletionContext {
  /** The partial word being typed (may be ''). */
  prefix: string
  /** Where `prefix` starts — the range an accepted suggestion replaces. */
  start: number
  /** Set when the caret follows `<qualifier>.` — only that table's columns apply. */
  qualifier: string | null
}

// Enough T-SQL/ANSI to cover a read-only query. Deliberately not the full grammar:
// a keyword list long enough to bury the schema names defeats the point.
const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'JOIN', 'LEFT JOIN',
  'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'AS', 'AND', 'OR',
  'NOT', 'IN', 'IS NULL', 'IS NOT NULL', 'LIKE', 'BETWEEN', 'EXISTS', 'CASE', 'WHEN',
  'THEN', 'ELSE', 'END', 'DISTINCT', 'TOP', 'LIMIT', 'OFFSET', 'UNION', 'UNION ALL',
  'WITH', 'ASC', 'DESC', 'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'COALESCE(',
  'CAST(', 'CONVERT(', 'DATEADD(', 'DATEDIFF(', 'GETDATE()', 'GETUTCDATE()',
]

/** Clauses after which a bare identifier is almost certainly a TABLE, not a column. */
const TABLE_CLAUSES = /\b(FROM|JOIN|UPDATE|INTO|TABLE)\s+[\w."[\]]*$/i

/** Strip the brackets/quotes a dialect allows around an identifier. */
function bare(name: string): string {
  return name.replace(/^[[\]"`]+|[[\]"`]+$/g, '').replace(/^.*\./, '')
}

/**
 * Read the caret's surroundings. `start` is where an accepted suggestion begins
 * overwriting, so accepting mid-word replaces the word instead of doubling it.
 */
export function completionContext(text: string, caret: number): CompletionContext {
  const before = text.slice(0, caret)
  const word = /[\w$]*$/.exec(before)?.[0] ?? ''
  const start = caret - word.length
  // `alias.` or `Table.` immediately before the partial word.
  const qualifier = /([\w$]+|\[[^\]]+\]|"[^"]+")\s*\.\s*[\w$]*$/.exec(before)?.[1] ?? null
  return { prefix: word, start, qualifier: qualifier ? bare(qualifier) : null }
}

/**
 * The tables named in this statement's FROM/JOIN clauses, mapped by every name they
 * can be referred to by — the table itself and any alias. `FROM Appointments a` means
 * both `Appointments.` and `a.` should offer that table's columns.
 */
export function tablesInScope(text: string): Map<string, string> {
  const scope = new Map<string, string>()
  const re = /\b(?:FROM|JOIN)\s+([\w$."[\]]+)(?:\s+(?:AS\s+)?([\w$]+))?/gi
  for (const m of text.matchAll(re)) {
    const table = bare(m[1])
    if (!table) continue
    scope.set(table.toLowerCase(), table)
    // Don't take a following keyword ("FROM Orders WHERE …") for an alias.
    const alias = m[2]
    if (alias && !/^(WHERE|ON|INNER|LEFT|RIGHT|FULL|CROSS|JOIN|GROUP|ORDER|HAVING|UNION|AS|SET|WITH|LIMIT|OFFSET)$/i.test(alias)) {
      scope.set(alias.toLowerCase(), table)
    }
  }
  return scope
}

/**
 * Rank: a prefix match beats a match in the middle of the word, and within each the
 * shorter name wins (typing "Pat" should reach `Patients` before `PatientDocuments`).
 * Returns null when the candidate doesn't match at all.
 */
function score(label: string, prefix: string): number | null {
  if (!prefix) return 100
  const l = label.toLowerCase()
  const p = prefix.toLowerCase()
  if (l.startsWith(p)) return 1000 - label.length
  const at = l.indexOf(p)
  if (at > 0) return 500 - at - label.length
  return null
}

export interface SuggestOptions {
  text: string
  caret: number
  tables: SchemaTable[]
  /** Cap the menu — a 2,000-column database must not render 2,000 rows. */
  limit?: number
}

/**
 * The ranked suggestions for the caret's position.
 *
 * Order of preference, and why:
 *  - After `x.` — ONLY that table's columns. A qualified name can't be anything else,
 *    and mixing keywords in there is noise.
 *  - After FROM/JOIN — tables first.
 *  - Everywhere else — columns of the tables already in the statement first (that's
 *    what you're most likely typing), then tables, then keywords.
 */
export function suggest({ text, caret, tables, limit = 40 }: SuggestOptions): Suggestion[] {
  const ctx = completionContext(text, caret)
  const scope = tablesInScope(text)
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const out: Scored[] = []
  const push = (s: Suggestion, base: number, order = 0) => {
    const sc = score(s.label, ctx.prefix)
    if (sc != null) out.push({ s, rank: base + sc, order })
  }

  if (ctx.qualifier) {
    const table = byName.get((scope.get(ctx.qualifier.toLowerCase()) ?? ctx.qualifier).toLowerCase())
    for (const c of table?.columns ?? []) {
      push({ label: c.name, kind: 'column', detail: c.type, from: table!.name }, 0)
    }
    return rank(out, limit)
  }

  // Group priority. The list is sorted DESCENDING, so the preferred group carries the
  // HIGHEST base — the bands are far enough apart (20k) that no within-group score
  // (max ~1k) can jump a band.
  //  - after FROM/JOIN → tables, obviously.
  //  - a statement that already names tables → their columns; that's what you're
  //    typing in SELECT/WHERE/ON/GROUP BY.
  //  - nothing named yet → keywords, because the query starts with SELECT or WITH and
  //    there are no columns in scope to offer anyway.
  const wantsTable = TABLE_CLAUSES.test(text.slice(0, caret))
  const hasScope = scope.size > 0
  const tableBase = wantsTable ? 60_000 : 40_000
  const scopedBase = wantsTable ? 20_000 : 60_000
  const keywordBase = wantsTable ? 0 : hasScope ? 20_000 : 60_000

  for (const t of tables) {
    push({ label: t.name, kind: 'table', detail: `${t.columns.length} cols`, from: t.kind === 'view' ? 'view' : undefined }, tableBase)
  }
  // Columns of the tables this statement already mentions, de-duplicated by name so a
  // column on three joined tables doesn't fill the menu three times.
  const seen = new Set<string>()
  for (const name of new Set(scope.values())) {
    const t = byName.get(name.toLowerCase())
    for (const c of t?.columns ?? []) {
      const key = c.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      push({ label: c.name, kind: 'column', detail: c.type, from: t!.name }, scopedBase)
    }
  }
  // `order` = position in KEYWORDS, which is written most-useful-first. With an empty
  // prefix every keyword scores the same, and an alphabetical tiebreak opened the menu
  // on "AND, AS, ASC" — on an empty editor, where the only sensible first word is
  // SELECT or WITH. The list's own order is the ranking.
  KEYWORDS.forEach((k, i) => push({ label: k, kind: 'keyword' }, keywordBase, i))

  return rank(out, limit)
}

interface Scored {
  s: Suggestion
  rank: number
  /** Tiebreak within a group before falling back to alphabetical. Lower wins. */
  order: number
}

function rank(out: Scored[], limit: number): Suggestion[] {
  return out
    .sort((a, b) => b.rank - a.rank || a.order - b.order || a.s.label.localeCompare(b.s.label))
    .slice(0, limit)
    .map((o) => o.s)
}

/**
 * Apply a suggestion, returning the new text and where the caret lands.
 * A function keyword (`COUNT(`) puts the caret inside the parens; everything else adds
 * a trailing space so you can keep typing.
 */
export function applySuggestion(
  text: string,
  ctx: CompletionContext,
  caret: number,
  s: Suggestion,
): { text: string; caret: number } {
  const openParen = s.label.endsWith('(')
  const insert = openParen ? `${s.label})` : s.kind === 'keyword' ? `${s.label} ` : s.label
  const next = text.slice(0, ctx.start) + insert + text.slice(caret)
  return { text: next, caret: ctx.start + (openParen ? s.label.length : insert.length) }
}
