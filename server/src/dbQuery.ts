import { runClaude } from './claudeExec.js'
import { parseClaudeJsonResult } from './claudeExec.js'
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
  if (!trimmed) throw new Error('Enter a SQL query.')
  // Judge the CODE, not comments or string contents.
  const code = sqlCodeOnly(trimmed).trim()
  if (!code) throw new Error('Enter a SQL query.')
  // A stray inner `;` means multiple statements — refuse (defends against `SELECT 1; DROP …`).
  if (/;/.test(code)) throw new Error('Only a single statement is allowed.')
  const lead = code.replace(/^\(+/, '').trimStart().slice(0, 12).toLowerCase()
  const ok = ['select', 'with', 'show', 'explain', 'describe', 'desc '].some((k) => lead.startsWith(k))
  if (!ok) throw new Error('Only read-only queries are allowed (SELECT / WITH / SHOW / EXPLAIN).')
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
    throw new Error(
      `The query contains a write, DDL or side-effect keyword ("${hit[0].toUpperCase()}") — only read-only SELECTs are permitted.`,
    )
  }
  // `FOR UPDATE` / `FOR SHARE` take write locks — caught by `update` above, but
  // `FOR SHARE` needs its own check.
  if (/\bfor\s+(share|key\s+share|no\s+key\s+update)\b/i.test(code)) {
    throw new Error('Locking clauses (FOR SHARE / FOR UPDATE) are not permitted.')
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
  const pool = await mssql.connect({
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

// ---------------- AI: natural-language question → SQL ----------------

function stripFences(text: string): string {
  const fenced = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  return (fenced ? fenced[1] : text).trim()
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
  cwd: string
}): Promise<{ sql: string; schemaTables: number }> {
  const schema = await inspectDatabase(opts.config, opts.cred)
  const schemaText = schemaForPrompt(schema)
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
      '0.25',
      '--strict-mcp-config',
    ],
    120_000,
    { cwd: opts.cwd, usageSource: 'db-ask', model: opts.model, input: prompt },
  )
  if (result.timedOut) throw new Error('The AI timed out generating a query.')
  const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
  if (result.code !== 0 || isError || !text.trim()) {
    throw new Error('The AI could not generate a query for that question.')
  }
  const sql = assertReadOnly(stripFences(text))
  return { sql, schemaTables: schema.tables.length }
}
