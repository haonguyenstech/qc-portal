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
// "ask your data" AI both run through here. SAFETY: only a single SELECT/WITH/SHOW/
// EXPLAIN statement is allowed, execution runs inside a READ-ONLY transaction where
// the driver supports it, results are capped, and the password is scrubbed from any
// error. This is a QC helper against a staging/dev DB — never a general SQL console.

const MAX_ROWS = 200
const STATEMENT_TIMEOUT_MS = 20_000
const CONNECT_TIMEOUT_MS = 15_000

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
}

/** Throw unless `sql` is a single read-only statement. Best-effort but strict. */
export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '')
  if (!trimmed) throw new Error('Enter a SQL query.')
  // A stray inner `;` means multiple statements — refuse (defends against `SELECT 1; DROP …`).
  if (/;/.test(trimmed)) throw new Error('Only a single statement is allowed.')
  const lead = trimmed.replace(/^\(+/, '').trimStart().slice(0, 12).toLowerCase()
  const ok = ['select', 'with', 'show', 'explain', 'describe', 'desc '].some((k) => lead.startsWith(k))
  if (!ok) throw new Error('Only read-only queries are allowed (SELECT / WITH / SHOW / EXPLAIN).')
  // Blacklist write / DDL keywords anywhere (covers `SELECT … INTO`, CTE-hidden writes).
  const forbidden =
    /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|call|exec|execute|replace|into|attach|vacuum|reindex|pragma)\b/i
  if (forbidden.test(trimmed)) {
    throw new Error('The query contains a write or DDL keyword — only read-only SELECTs are permitted.')
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
    await conn.query('SET SESSION TRANSACTION READ ONLY').catch(() => {})
    await conn.query(`SET SESSION MAX_EXECUTION_TIME = ${STATEMENT_TIMEOUT_MS}`).catch(() => {})
    const [rows, fields] = await conn.query(sql)
    const columns = (fields as { name: string }[] | undefined)?.map((f) => f.name) ?? []
    const data = Array.isArray(rows) ? (rows as unknown[][]) : []
    return { columns, rows: capRows(data), rowCount: data.length, truncated: data.length > MAX_ROWS }
  } finally {
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
    await client.query('BEGIN TRANSACTION READ ONLY')
    const result = await client.query({ text: sql, rowMode: 'array' })
    await client.query('ROLLBACK').catch(() => {})
    const columns = (result.fields ?? []).map((f) => f.name)
    const data = (result.rows ?? []) as unknown[][]
    return { columns, rows: capRows(data), rowCount: data.length, truncated: data.length > MAX_ROWS }
  } finally {
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
    options: { encrypt: config.ssl, trustServerCertificate: true, readOnlyIntent: true },
  })
  try {
    const request = pool.request()
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
