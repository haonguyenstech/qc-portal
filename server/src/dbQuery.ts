import os from 'node:os'
import { runClaude } from './claudeExec.js'
import { parseClaudeJsonResult, salvageClaudeJson } from './claudeExec.js'
import {
  inspectDatabase,
  schemaForPrompt,
  scrub,
  type DbConfig,
  type DbCredential,
} from './dbConnect.js'

// Read-only query execution for the Database page — the manual SQL editor and the
// "ask your data" AI both run through here. This is a QC helper against a staging/dev
// DB, never a general SQL console.
//
// SAFETY IS LAYERED, because the AI writes SQL nobody reviews before it runs. No
// single layer is trusted to be perfect:
//
//   1. PARSE (assertReadOnly) — comments stripped and string/identifier contents
//      masked first (so nothing hides in a comment and ordinary literals don't false-
//      alarm), then: exactly one statement, must START with SELECT/WITH/SHOW/EXPLAIN,
//      and no write/DDL/side-effect keyword anywhere in the code.
//   2. ENGINE — every driver runs the statement in a transaction that never commits:
//      Postgres/MySQL open an explicit READ ONLY transaction (fail CLOSED if the
//      server won't), SQL Server wraps it in a transaction that is always rolled back
//      (T-SQL has no read-only mode, but its DDL *is* transactional). So a write that
//      ever slipped past layer 1 still cannot persist.
//   3. BLAST RADIUS — row cap, statement timeout, and the password scrubbed from
//      every error that reaches a log or the UI.
//
// Both entry points are covered: runReadQuery calls assertReadOnly itself, so the
// AI's SQL is re-validated at execution time and not merely when it was generated.
// If you touch this file, keep every layer — they exist because the one above it
// might be wrong.
//
// SQL SERVER: ALWAYS `new mssql.ConnectionPool(config)`, NEVER `mssql.connect(config)`.
// `mssql.connect` is a GLOBAL, single-pool helper — its own source reads:
//
//     let globalConnection = null
//     function connect (config) {
//       if (!globalConnection) { globalConnection = new ConnectionPool(config) }
//       return globalConnection.connect()
//     }
//
// so the config is honoured only on the FIRST call. A second concurrent call for a
// DIFFERENT server silently gets the first one's pool. A project can connect several
// databases (Backend DB, Analytics DB, …), so this is reachable simply by having two
// SQL Server connections and a page that touches both at once.
//
// Verified on the Database page: pinging two databases concurrently made the one on
// port 1434 report a connect failure for port 1433 — a server it has nothing to do
// with. The dangerous case is the one that DOESN'T error: when the first pool is
// healthy, a query meant for database B runs against database A and returns rows that
// look perfectly normal. On a page whose whole purpose is answering "what's in the
// data?", silently answering about the wrong database is worse than any error.
// `pool.close()` had the same shape of bug — it closed the shared global pool out
// from under whatever else was mid-query.

const MAX_ROWS = 200
const STATEMENT_TIMEOUT_MS = 20_000
const CONNECT_TIMEOUT_MS = 15_000

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

/**
 * Reduce SQL to the bare CODE the guard should judge: comments removed, and the
 * CONTENTS of every string literal / quoted identifier replaced by a placeholder.
 *
 * Both halves matter. Without comment stripping, `SELECT 1 /* … *​/` lets text hide
 * from the keyword scan; with it, a keyword can't be smuggled past in a comment.
 * Without literal masking, an ordinary query like `WHERE status = 'update'` is
 * rejected as a "write keyword" — false alarms train people to work around the
 * guard, which is worse than the guard not existing.
 *
 * Throws on an unterminated comment or quote: if we can't tell where the code ends,
 * we can't vouch for it, so refuse rather than guess.
 */
export function sqlCodeOnly(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    // -- line comment
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      if (nl === -1) break
      out += ' '
      i = nl + 1
      continue
    }
    // /* block comment */ (SQL block comments do not nest in the engines we target)
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end === -1) throw new Error('Unterminated comment in the query.')
      out += ' '
      i = end + 2
      continue
    }
    // '…' string literal — '' is an escaped quote and stays inside the literal.
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") i += 2
          else break
        } else i++
      }
      if (i >= n) throw new Error('Unterminated string literal in the query.')
      out += "''" // placeholder: an empty literal, so the shape of the code survives
      i++
      continue
    }
    // "…" / `…` / [ … ] quoted identifiers — masked so a table named "delete_log"
    // can be selected from without tripping the keyword scan.
    const closer = c === '"' ? '"' : c === '`' ? '`' : c === '[' ? ']' : ''
    if (closer) {
      const end = sql.indexOf(closer, i + 1)
      if (end === -1) throw new Error('Unterminated quoted identifier in the query.')
      out += 'x' // placeholder identifier
      i = end + 1
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Why a statement was refused, in a form the UI can render as a real dialog.
 *
 * `assertReadOnly` used to throw a bare Error, so every refusal reached the browser
 * as one red line of prose — the same treatment as "connection timed out". A QC
 * engineer who types a DELETE has done something categorically different from
 * mistyping a column: the page WILL NOT run it, no retry or reconnect will help, and
 * that has to be unmistakable. This subclass is what lets the routes tell the two
 * apart (`instanceof`) and answer with a `blocked` payload.
 *
 * It extends Error and keeps `message` intact on purpose: every existing catch that
 * only reads `.message` keeps working, and a caller that doesn't know about this type
 * degrades to the old behaviour rather than losing the guard.
 */
export type BlockedKind =
  | 'empty'
  | 'multi-statement'
  | 'not-select'
  | 'write-keyword'
  | 'lock'
  /** The QUESTION asked for a change, so no statement was ever written (Ask AI only). */
  | 'write-intent'

export class ReadOnlyViolation extends Error {
  readonly kind: BlockedKind
  /** The offending keyword, upper-cased, when one was matched (e.g. `DELETE`). */
  readonly keyword?: string
  /**
   * A read-only SELECT showing the rows the refused change would have touched.
   * Set only for `write-intent`, and only after passing assertReadOnly like any
   * other statement — it is offered to the user, never auto-run.
   */
  readonly preview?: string
  constructor(kind: BlockedKind, message: string, keyword?: string, preview?: string) {
    super(message)
    this.name = 'ReadOnlyViolation'
    this.kind = kind
    this.keyword = keyword
    this.preview = preview
  }
}

/**
 * Throw unless `sql` is a single read-only statement.
 *
 * This is layer 1 of the protection on the Database page and it is deliberately
 * strict — it runs BEFORE the driver sees the text, on both the hand-typed SQL and
 * whatever the AI wrote. It is NOT the only layer: every driver additionally runs
 * the statement inside a transaction that is rolled back / declared READ ONLY (see
 * runReadQuery), so anything that ever slips past this parser still cannot persist.
 */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) throw new ReadOnlyViolation('empty', 'Enter a SQL query.')
  // Judge the CODE, not comments or string contents.
  const code = sqlCodeOnly(trimmed).trim()
  if (!code) throw new ReadOnlyViolation('empty', 'Enter a SQL query.')
  // A stray inner `;` means multiple statements — refuse (defends against `SELECT 1; DROP …`).
  if (/;/.test(code)) throw new ReadOnlyViolation('multi-statement', 'Only a single statement is allowed.')
  const lead = code.replace(/^\(+/, '').trimStart().slice(0, 12).toLowerCase()
  const ok = ['select', 'with', 'show', 'explain', 'describe', 'desc '].some((k) => lead.startsWith(k))
  if (!ok) {
    // A statement STARTING with a write verb is a write, and saying so by name beats
    // the generic "must start with SELECT" — DELETE/UPDATE/DROP is exactly the case
    // the refusal has to be unmistakable for. The keyword blacklist below would never
    // see these: the leading-word check fires first.
    const verb = /^[a-z_]+/.exec(code.replace(/^\(+/, '').trimStart().toLowerCase())?.[0] ?? ''
    const isWrite = ['insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'create',
      'merge', 'replace', 'grant', 'revoke', 'exec', 'execute', 'call'].includes(verb)
    throw new ReadOnlyViolation(
      isWrite ? 'write-keyword' : 'not-select',
      isWrite
        ? `This is a ${verb.toUpperCase()} statement — only read-only SELECTs are permitted here.`
        : 'Only read-only queries are allowed (SELECT / WITH / SHOW / EXPLAIN).',
      isWrite ? verb.toUpperCase() : undefined,
    )
  }
  // Blacklist write / DDL / privilege / side-effect keywords anywhere — covers
  // `SELECT … INTO`, data-modifying CTEs (`WITH x AS (DELETE … RETURNING)`), and
  // procedure calls that could write behind a SELECT.
  // NOTE: `replace` and `comment` are deliberately NOT here — REPLACE() is a common
  // string function and `comment` a common column name, and MySQL's write form
  // (`REPLACE INTO`) is already caught by `into`. A guard that cries wolf on ordinary
  // queries gets worked around.
  const forbidden =
    /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|deny|merge|call|exec|execute|sp_executesql|xp_cmdshell|openrowset|opendatasource|upsert|into|attach|detach|vacuum|reindex|pragma|backup|restore|shutdown|kill|reconfigure|dbcc|bulk|load_file|outfile|dumpfile|waitfor|commit|rollback|savepoint|begin|set|lock|unlock|rename|copy)\b/i
  const hit = code.match(forbidden)
  if (hit) {
    const word = hit[0].toUpperCase()
    throw new ReadOnlyViolation(
      'write-keyword',
      `The query contains a write, DDL or side-effect keyword ("${word}") — only read-only SELECTs are permitted.`,
      word,
    )
  }
  // `FOR UPDATE` / `FOR SHARE` take write locks — caught by `update` above, but
  // `FOR SHARE` needs its own check.
  if (/\bfor\s+(share|key\s+share|no\s+key\s+update)\b/i.test(code)) {
    throw new ReadOnlyViolation('lock', 'Locking clauses (FOR SHARE / FOR UPDATE) are not permitted.')
  }
  return trimmed
}

/** Normalize a driver cell value to something JSON-serializable for the UI grid. */
function cell(v: unknown): unknown {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'bigint') return v.toString()
  if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return v
}

function capRows(rows: unknown[][]): QueryResult['rows'] {
  return rows.slice(0, MAX_ROWS).map((r) => r.map(cell))
}

/** Run a single read-only SELECT and return a column/row grid. Throws (scrubbed) on failure. */
export async function runReadQuery(
  config: DbConfig,
  cred: DbCredential | undefined,
  rawSql: string,
): Promise<QueryResult> {
  const sql = assertReadOnly(rawSql)
  try {
    switch (config.kind) {
      case 'mysql':
        return await queryMysql(config, cred, sql)
      case 'postgres':
        return await queryPostgres(config, cred, sql)
      case 'sqlserver':
        return await querySqlServer(config, cred, sql)
      default:
        throw new Error(`Unsupported database type: ${config.kind as string}`)
    }
  } catch (err) {
    throw new Error(scrub((err as Error).message || 'query failed', cred))
  }
}

async function queryMysql(config: DbConfig, cred: DbCredential | undefined, sql: string): Promise<QueryResult> {
  const mysql = await import('mysql2/promise')
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port || 3306,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    rowsAsArray: true,
  })
  try {
    // FAIL CLOSED: if the server won't give us a read-only transaction we refuse to
    // run at all, rather than quietly executing with no engine-level protection.
    // (This was previously `.catch(() => {})`, which turned the safety net into a
    // no-op on any server that rejected the statement — silently.)
    try {
      await conn.query('START TRANSACTION READ ONLY')
    } catch {
      throw new Error(
        'Could not open a read-only transaction on this MySQL server (needs 5.6+), so the query was not run.',
      )
    }
    // Statement timeout is a resource guard, not a safety guard — best-effort is fine.
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${STATEMENT_TIMEOUT_MS}`).catch(() => {})
    const [rows, fields] = await conn.query(sql)
    const columns = (fields as { name: string }[] | undefined)?.map((f) => f.name) ?? []
    const data = Array.isArray(rows) ? (rows as unknown[][]) : []
    return { columns, rows: capRows(data), rowCount: data.length, truncated: data.length > MAX_ROWS }
  } finally {
    await conn.query('ROLLBACK').catch(() => {})
    await conn.end().catch(() => {})
  }
}

async function queryPostgres(config: DbConfig, cred: DbCredential | undefined, sql: string): Promise<QueryResult> {
  const pg = (await import('pg')).default
  const client = new pg.Client({
    host: config.host,
    port: config.port || 5432,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  })
  await client.connect()
  try {
    // Not caught on purpose — if the read-only transaction can't be opened, the query
    // must not run (fail closed). Postgres rejects every write inside it, DDL included.
    await client.query('BEGIN TRANSACTION READ ONLY')
    const result = await client.query({ text: sql, rowMode: 'array' })
    const columns = (result.fields ?? []).map((f) => f.name)
    const data = (result.rows ?? []) as unknown[][]
    return { columns, rows: capRows(data), rowCount: data.length, truncated: data.length > MAX_ROWS }
  } finally {
    // In `finally`, so a failing query also leaves nothing open behind it.
    await client.query('ROLLBACK').catch(() => {})
    await client.end().catch(() => {})
  }
}

async function querySqlServer(config: DbConfig, cred: DbCredential | undefined, sql: string): Promise<QueryResult> {
  const mssql = (await import('mssql')).default
  // `new ConnectionPool`, NEVER `mssql.connect()` — see the note on sqlServerPool.
  const pool = new mssql.ConnectionPool({
    server: config.host,
    port: config.port || 1433,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: STATEMENT_TIMEOUT_MS,
    // readOnlyIntent is ONLY an Always On routing hint — it enforces nothing. The
    // real protection is the always-rolled-back transaction below.
    options: { encrypt: config.ssl, trustServerCertificate: true, readOnlyIntent: true },
  })
  await pool.connect()
  // T-SQL has no "READ ONLY transaction", so wrap the statement in an explicit
  // transaction that is ALWAYS rolled back. SQL Server makes DDL transactional too,
  // so even a CREATE/DROP/ALTER that somehow got past assertReadOnly is undone —
  // this is the safety net that makes the keyword guard non-load-bearing.
  const tx = new mssql.Transaction(pool)
  await tx.begin()
  let committed = false
  try {
    const request = new mssql.Request(tx)
    request.arrayRowMode = true
    const result = await request.query(sql)
    // With arrayRowMode the rows are arrays; `columns` may come back as an array
    // (arrayRowMode) or the default name-keyed object — handle both.
    const colMetaRaw = result.recordset?.columns as unknown
    const colMeta = Array.isArray(colMetaRaw)
      ? (colMetaRaw as { name: string }[])
      : Object.values((colMetaRaw ?? {}) as Record<string, { name: string }>)
    const columns = colMeta.map((c) => c.name)
    const data = (result.recordset ?? []) as unknown as unknown[][]
    return { columns, rows: capRows(data), rowCount: data.length, truncated: data.length > MAX_ROWS }
  } finally {
    // Never commit — a read query has nothing to keep, and rolling back is what
    // guarantees a write can't survive. `committed` stays false by design; it exists
    // so a future edit that adds a commit path has to think about this.
    if (!committed) await tx.rollback().catch(() => {})
    await pool.close().catch(() => {})
  }
}

/**
 * Is this database actually reachable RIGHT NOW?
 *
 * The Database page used to render a hard-coded "connected" badge on every registered
 * database, so a server that was switched off still read as connected — the badge only
 * ever meant "a row exists". This is the live check behind it.
 *
 * Deliberately a `SELECT 1` through `runReadQuery` rather than `inspectDatabase`: the
 * badge is polled per card, and introspecting 158 tables to answer "is it up?" would
 * cost more than every query the page runs. Reusing runReadQuery also means the health
 * probe goes through the same read-only guards as everything else here.
 *
 * Never throws — an unreachable database is the normal answer, not an exception.
 */
export async function pingDatabase(
  config: DbConfig,
  cred: DbCredential | undefined,
): Promise<{ ok: boolean; error?: string; ms: number }> {
  const started = Date.now()
  try {
    await runReadQuery(config, cred, 'SELECT 1')
    return { ok: true, ms: Date.now() - started }
  } catch (err) {
    // Already scrubbed of the password by runReadQuery.
    return { ok: false, error: (err as Error).message || 'connection failed', ms: Date.now() - started }
  }
}

// ---------------- AI: natural-language question → SQL ----------------

function stripFences(text: string): string {
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
}

// The schema IS the prompt here, and it grows with the database: a 158-table SQL
// Server came to 78 KB (2,013 columns + 436 FKs). Two things follow, and both are
// measured rather than guessed — see the constants below.
//
//  - Cost scales with it, so the run's budget has to scale too (a fixed cap silently
//    turned correct answers into "the AI could not generate a query").
//  - It has to be bounded, or a 2,000-table warehouse sends an unbounded prompt.
const MAX_SCHEMA_CHARS = 160_000

/**
 * Budget for one question, sized from the prompt.
 *
 * Measured on a real 158-table database (78 KB prompt, sonnet, neutral cwd): $0.36 —
 * against the old flat $0.25 cap, which the CLI enforces AFTER the turn finishes, so
 * the model wrote a valid query and the run was still marked `error_max_budget_usd`.
 * The floor covers a small schema and the slope covers a large one, with ~2.5x headroom
 * for pricing drift; the ceiling is what stops a runaway from being unbounded.
 */
function budgetForPrompt(chars: number): number {
  return Math.min(3, Math.max(0.5, (0.15 + (chars / 1000) * 0.006) * 2.5))
}

/**
 * Generating SQL is a PURE TEXT task — schema + question in, one SELECT out. It needs
 * no project files, so it doesn't run in the project folder: doing that loaded the
 * project's CLAUDE.md, memory and skills into every question. Measured on the same
 * question: $0.63 in the project cwd vs $0.36 in a neutral one, for context that can
 * only distract the model from the schema it was given.
 *
 * It also runs with the tools taken away. The Database page's whole premise is that
 * the AI cannot write anything (see the layered read-only guards at the top of this
 * file) — yet this call was handing the same model Bash, Write and Edit in the
 * project's own folder. It can't reach the database that way, but it should not be
 * able to touch the repo either.
 */
const NEUTRAL_CWD = os.tmpdir()
const NO_TOOLS = [
  'Task', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'Skill', 'ToolSearch', 'Workflow',
]

/**
 * Recognize the model's refusal protocol (see the prompt) and turn it into the same
 * `ReadOnlyViolation` a hand-typed DELETE produces, so both reach the UI as one
 * "this would modify data" dialog rather than two different-looking failures.
 *
 * Returns null for an ordinary answer. The PREVIEW line is run through
 * `assertReadOnly` here — the model is refusing a write, which is exactly the moment
 * not to trust its next line unchecked; a preview that doesn't validate is simply
 * dropped, and the refusal still stands.
 */
function parseWriteRefusal(answer: string): ReadOnlyViolation | null {
  const m = /^\s*REFUSE_WRITE\s*:?\s*(.*)$/im.exec(answer)
  if (!m) return null
  // The model tends to echo the request rather than write a sentence, so the sentence
  // is built here — this string is what a non-UI caller sees.
  const asked = m[1].trim()
  const why = asked
    ? `That question asks to change the database (${asked}).`
    : 'That question asks to change the database.'
  const p = /^\s*PREVIEW\s*:?\s*([\s\S]*)$/im.exec(answer)
  let preview: string | undefined
  const candidate = p ? stripFences(p[1].trim()) : ''
  if (candidate && !/^none$/i.test(candidate)) {
    try {
      preview = assertReadOnly(candidate)
    } catch {
      preview = undefined
    }
  }
  return new ReadOnlyViolation('write-intent', why, undefined, preview)
}

/**
 * Ask Claude to translate a natural-language question into ONE read-only SELECT for
 * this database's dialect, grounded in a freshly-introspected schema. Returns the SQL
 * (validated read-only) — throws if the model can't produce a safe query.
 */
export async function questionToSql(opts: {
  config: DbConfig
  cred: DbCredential | undefined
  question: string
  model: string
}): Promise<{ sql: string; schemaTables: number }> {
  const schema = await inspectDatabase(opts.config, opts.cred)
  const full = schemaForPrompt(schema)
  // Clipped rather than dropped silently: the model is told the list is partial so it
  // can say it lacks the table, instead of inventing one to fill the gap.
  const clipped = full.length > MAX_SCHEMA_CHARS
  const schemaText = clipped
    ? `${full.slice(0, MAX_SCHEMA_CHARS)}\n… schema truncated — if the table you need is not listed above, say so instead of guessing.`
    : full
  const dialect =
    opts.config.kind === 'mysql' ? 'MySQL' : opts.config.kind === 'postgres' ? 'PostgreSQL' : 'SQL Server'
  const limitHint =
    opts.config.kind === 'sqlserver'
      ? 'cap rows with SELECT TOP 200'
      : 'cap rows with LIMIT 200'

  const prompt = `You are a SQL assistant for a ${dialect} database. Using ONLY the schema below, write ONE read-only SQL query that answers the user's question.

Rules:
- ${dialect} syntax. A single statement only. SELECT / WITH / SHOW / EXPLAIN only — NEVER modify data (no INSERT/UPDATE/DELETE/DDL).
- Use the EXACT table and column names from the schema.
- ${limitHint} unless the question clearly asks for an aggregate/single value.
- Output ONLY the SQL. No explanation, no markdown code fences.

If the question asks you to CHANGE the database — delete/remove rows, insert, update,
alter or drop anything — do NOT write that statement. This tool is read-only and it
would be refused anyway. Instead reply in exactly this shape and nothing else:
REFUSE_WRITE: <one short sentence naming the change that was asked for>
PREVIEW: <a read-only SELECT showing the rows that change WOULD have affected, or the word NONE>
Answering a question ABOUT modified data ("how many were deleted last week?") is a
normal SELECT — that is not a write, so answer it normally.

Schema:
${schemaText}

Question: ${opts.question}`

  const result = await runClaude(
    [
      '-p',
      '--model',
      opts.model,
      '--output-format',
      'json',
      '--no-session-persistence',
      '--max-budget-usd',
      budgetForPrompt(prompt.length).toFixed(2),
      // Variadic — must be followed by another flag, or the next arg is eaten as a tool name.
      '--disallowedTools',
      ...NO_TOOLS,
      '--strict-mcp-config',
    ],
    120_000,
    { cwd: NEUTRAL_CWD, usageSource: 'db-ask', model: opts.model, input: prompt },
  )
  if (result.timedOut) throw new Error('The AI timed out generating a query.')
  const raw = result.stdout || result.stderr
  const { text, isError } = parseClaudeJsonResult(raw)
  // A failed run can still carry the answer: the budget cap fires after the turn, so
  // the query is written and paid for, then thrown away. Take it if it's there.
  const salvage = salvageClaudeJson(raw)
  const answer = text.trim() || (isError ? salvage.text : '')
  if (!answer) {
    const why = salvage.reason || (result.code !== 0 ? `claude exited ${result.code}` : '')
    throw new Error(
      why
        ? `The AI could not generate a query for that question (${why}).`
        : 'The AI could not generate a query for that question.',
    )
  }
  const refusal = parseWriteRefusal(answer)
  if (refusal) throw refusal
  const sql = assertReadOnly(stripFences(answer))
  return { sql, schemaTables: schema.tables.length }
}
