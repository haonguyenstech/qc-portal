import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH } from './config.js'

// Database connectivity for the "Database" page: connect to a project's MySQL /
// PostgreSQL / SQL Server database and introspect its schema, so Claude can read
// real table/column names when writing test cases and running QC.
//
// SECRETS: the password is NEVER written to the DB or any log line. It lives only
// in data/database-credentials.json (localhost-only, chmod 0600) keyed by the
// database-row id, and is injected into a connection config in memory. Every
// error surfaced to a log is scrubbed of it. Mirrors sourceRepo.ts / ClickUp.

export type DbKind = 'mysql' | 'postgres' | 'sqlserver'

export const DB_KINDS: { value: DbKind; label: string; defaultPort: number }[] = [
  { value: 'postgres', label: 'PostgreSQL', defaultPort: 5432 },
  { value: 'mysql', label: 'MySQL / MariaDB', defaultPort: 3306 },
  { value: 'sqlserver', label: 'SQL Server', defaultPort: 1433 },
]

export function isDbKind(v: unknown): v is DbKind {
  return typeof v === 'string' && DB_KINDS.some((k) => k.value === v)
}

export function defaultPort(kind: DbKind): number {
  return DB_KINDS.find((k) => k.value === kind)?.defaultPort ?? 0
}

/** Non-secret connection settings (persisted in the DB). */
export interface DbConfig {
  kind: DbKind
  host: string
  port: number
  database: string
  username: string
  ssl: boolean
}

export interface DbCredential {
  password: string
}

export interface DbCredentialInfo {
  /** e.g. "postgres · ****cret" — never the raw password. */
  label: string
  passwordPreview: string
}

// ---------------- credential store (on disk, never in the DB / logs) ----------------

const CREDS_FILE = path.join(path.dirname(DB_PATH), 'database-credentials.json')

function readAllCreds(): Record<string, DbCredential> {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAllCreds(all: Record<string, DbCredential>): void {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true })
  fs.writeFileSync(CREDS_FILE, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(CREDS_FILE, 0o600)
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

export function getDbCredential(id: string): DbCredential | undefined {
  const cred = readAllCreds()[id]
  return cred?.password ? cred : undefined
}

export function setDbCredential(id: string, cred: DbCredential): void {
  const all = readAllCreds()
  all[id] = cred
  writeAllCreds(all)
}

export function deleteDbCredential(id: string): void {
  const all = readAllCreds()
  if (id in all) {
    delete all[id]
    writeAllCreds(all)
  }
}

export function dbCredentialInfo(config: DbConfig, cred?: DbCredential): DbCredentialInfo | null {
  if (!cred?.password) return null
  const pw = cred.password.trim()
  const tail = pw.length > 4 ? pw.slice(-4) : pw
  return { label: `${config.kind} · ${config.username || 'user'}`, passwordPreview: `****${tail}` }
}

/** Remove the password (and any `pw@host` that slipped through) from logged text. */
export function scrub(text: string, cred?: DbCredential): string {
  let out = text
  if (cred?.password) out = out.split(cred.password).join('***')
  out = out.replace(/(:\/\/[^/@\s]+:)[^/@\s]+(@)/gi, '$1***$2')
  return out
}

// ---------------- introspected schema ----------------

export interface DbColumn {
  name: string
  type: string
  nullable: boolean
  /** '', 'PK', 'FK', 'UNIQUE' — best-effort per driver. */
  key: string
  default: string | null
}

export interface DbTable {
  name: string
  kind: 'table' | 'view'
  columns: DbColumn[]
}

export interface DbForeignKey {
  table: string
  column: string
  refTable: string
  refColumn: string
}

export interface DbSchema {
  serverVersion: string
  tables: DbTable[]
  foreignKeys: DbForeignKey[]
}

const CONNECT_TIMEOUT_MS = 15_000

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

/**
 * Connect to a database and read its full schema (tables, columns, keys) then
 * disconnect. Used by both connect and sync — the connection attempt IS the test.
 * Throws with a scrubbed message on any failure. Drivers are imported lazily so a
 * missing/broken driver only fails that DB kind, not the whole server.
 */
export async function inspectDatabase(config: DbConfig, cred?: DbCredential): Promise<DbSchema> {
  try {
    switch (config.kind) {
      case 'mysql':
        return await inspectMysql(config, cred)
      case 'postgres':
        return await inspectPostgres(config, cred)
      case 'sqlserver':
        return await inspectSqlServer(config, cred)
      default:
        throw new Error(`Unsupported database type: ${config.kind as string}`)
    }
  } catch (err) {
    throw new Error(scrub((err as Error).message || 'connection failed', cred))
  }
}

// ---- MySQL / MariaDB ----

async function inspectMysql(config: DbConfig, cred?: DbCredential): Promise<DbSchema> {
  const mysql = await import('mysql2/promise')
  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port || 3306,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  })
  try {
    const [verRows] = await conn.query('SELECT VERSION() AS v')
    const serverVersion = `MySQL ${str((verRows as Record<string, unknown>[])[0]?.v)}`
    const [tblRows] = await conn.query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
      [config.database],
    )
    const [colRows] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type,
              IS_NULLABLE AS nullable, COLUMN_KEY AS ckey, COLUMN_DEFAULT AS dflt
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [config.database],
    )
    const [fkRows] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, REFERENCED_TABLE_NAME AS rt, REFERENCED_COLUMN_NAME AS rc
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
      [config.database],
    )
    const tables = buildTables(
      tblRows as Record<string, unknown>[],
      colRows as Record<string, unknown>[],
      (r) => str(r.type).toUpperCase().includes('VIEW'),
      (r) => ({
        name: str(r.name),
        type: str(r.type),
        nullable: str(r.nullable).toUpperCase() === 'YES',
        key: str(r.ckey) === 'PRI' ? 'PK' : str(r.ckey) === 'UNI' ? 'UNIQUE' : str(r.ckey) === 'MUL' ? 'FK' : '',
        default: r.dflt == null ? null : str(r.dflt),
      }),
    )
    const foreignKeys = (fkRows as Record<string, unknown>[]).map((r) => ({
      table: str(r.t),
      column: str(r.c),
      refTable: str(r.rt),
      refColumn: str(r.rc),
    }))
    return { serverVersion, tables, foreignKeys }
  } finally {
    await conn.end().catch(() => {})
  }
}

// ---- PostgreSQL ----

async function inspectPostgres(config: DbConfig, cred?: DbCredential): Promise<DbSchema> {
  const pg = (await import('pg')).default
  const client = new pg.Client({
    host: config.host,
    port: config.port || 5432,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  })
  await client.connect()
  try {
    const ver = await client.query('SELECT version() AS v')
    const serverVersion = str(ver.rows[0]?.v).split(',')[0] || 'PostgreSQL'
    const tbl = await client.query(
      `SELECT table_name AS name, table_type AS type FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name`,
    )
    const col = await client.query(
      `SELECT table_name AS t, column_name AS name, data_type AS type,
              character_maximum_length AS len, is_nullable AS nullable, column_default AS dflt
         FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
    )
    const keys = await client.query(
      `SELECT tc.constraint_type AS ctype, kcu.table_name AS t, kcu.column_name AS c,
              ccu.table_name AS rt, ccu.column_name AS rc
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         LEFT JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type IN ('PRIMARY KEY','FOREIGN KEY','UNIQUE')`,
    )
    const keyMap = new Map<string, string>() // "table.col" → PK|FK|UNIQUE
    const foreignKeys: DbForeignKey[] = []
    for (const r of keys.rows as Record<string, unknown>[]) {
      const ct = str(r.ctype)
      const mark = ct === 'PRIMARY KEY' ? 'PK' : ct === 'FOREIGN KEY' ? 'FK' : 'UNIQUE'
      const k = `${str(r.t)}.${str(r.c)}`
      if (!keyMap.has(k) || mark === 'PK') keyMap.set(k, mark)
      if (ct === 'FOREIGN KEY' && r.rt) {
        foreignKeys.push({ table: str(r.t), column: str(r.c), refTable: str(r.rt), refColumn: str(r.rc) })
      }
    }
    const tables = buildTables(
      tbl.rows as Record<string, unknown>[],
      col.rows as Record<string, unknown>[],
      (r) => str(r.type).toUpperCase().includes('VIEW'),
      (r, tableName) => {
        const len = r.len == null ? '' : `(${str(r.len)})`
        return {
          name: str(r.name),
          type: `${str(r.type)}${len}`,
          nullable: str(r.nullable).toUpperCase() === 'YES',
          key: keyMap.get(`${tableName}.${str(r.name)}`) ?? '',
          default: r.dflt == null ? null : str(r.dflt),
        }
      },
    )
    return { serverVersion, tables, foreignKeys }
  } finally {
    await client.end().catch(() => {})
  }
}

// ---- SQL Server ----

async function inspectSqlServer(config: DbConfig, cred?: DbCredential): Promise<DbSchema> {
  const mssql = (await import('mssql')).default
  const pool = await mssql.connect({
    server: config.host,
    port: config.port || 1433,
    user: config.username,
    password: cred?.password,
    database: config.database,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    options: { encrypt: config.ssl, trustServerCertificate: true },
  })
  try {
    const ver = await pool.request().query('SELECT @@VERSION AS v')
    const serverVersion = str(ver.recordset[0]?.v).split('\n')[0] || 'SQL Server'
    const tbl = await pool.request().query(
      `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE IN ('BASE TABLE','VIEW') ORDER BY TABLE_NAME`,
    )
    const col = await pool.request().query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, DATA_TYPE AS type,
              CHARACTER_MAXIMUM_LENGTH AS len, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt
         FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    )
    const keys = await pool.request().query(
      `SELECT tc.CONSTRAINT_TYPE AS ctype, kcu.TABLE_NAME AS t, kcu.COLUMN_NAME AS c
         FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','FOREIGN KEY','UNIQUE')`,
    )
    const fk = await pool.request().query(
      `SELECT fk_tab.name AS t, fk_col.name AS c, pk_tab.name AS rt, pk_col.name AS rc
         FROM sys.foreign_keys f
         JOIN sys.foreign_key_columns fkc ON f.object_id = fkc.constraint_object_id
         JOIN sys.tables fk_tab ON fkc.parent_object_id = fk_tab.object_id
         JOIN sys.columns fk_col ON fkc.parent_object_id = fk_col.object_id AND fkc.parent_column_id = fk_col.column_id
         JOIN sys.tables pk_tab ON fkc.referenced_object_id = pk_tab.object_id
         JOIN sys.columns pk_col ON fkc.referenced_object_id = pk_col.object_id AND fkc.referenced_column_id = pk_col.column_id`,
    )
    const keyMap = new Map<string, string>()
    for (const r of keys.recordset as Record<string, unknown>[]) {
      const ct = str(r.ctype)
      const mark = ct === 'PRIMARY KEY' ? 'PK' : ct === 'FOREIGN KEY' ? 'FK' : 'UNIQUE'
      const k = `${str(r.t)}.${str(r.c)}`
      if (!keyMap.has(k) || mark === 'PK') keyMap.set(k, mark)
    }
    const tables = buildTables(
      tbl.recordset as Record<string, unknown>[],
      col.recordset as Record<string, unknown>[],
      (r) => str(r.type).toUpperCase().includes('VIEW'),
      (r, tableName) => {
        const len = r.len == null ? '' : `(${str(r.len)})`
        return {
          name: str(r.name),
          type: `${str(r.type)}${len}`,
          nullable: str(r.nullable).toUpperCase() === 'YES',
          key: keyMap.get(`${tableName}.${str(r.name)}`) ?? '',
          default: r.dflt == null ? null : str(r.dflt),
        }
      },
    )
    const foreignKeys = (fk.recordset as Record<string, unknown>[]).map((r) => ({
      table: str(r.t),
      column: str(r.c),
      refTable: str(r.rt),
      refColumn: str(r.rc),
    }))
    return { serverVersion, tables, foreignKeys }
  } finally {
    await pool.close().catch(() => {})
  }
}

/** A compact, one-line-per-table schema rendering for an AI prompt (token-cheap). */
export function schemaForPrompt(schema: DbSchema): string {
  const lines: string[] = []
  for (const t of schema.tables) {
    const cols = t.columns
      .map((c) => `${c.name} ${c.type}${c.key ? ` [${c.key}]` : ''}`)
      .join(', ')
    lines.push(`${t.kind === 'view' ? 'VIEW' : 'TABLE'} ${t.name}(${cols})`)
  }
  for (const fk of schema.foreignKeys) {
    lines.push(`FK ${fk.table}.${fk.column} -> ${fk.refTable}.${fk.refColumn}`)
  }
  return lines.join('\n')
}

// ---- shared assembly ----

/** Join a table list + a flat column list into per-table column arrays. */
function buildTables(
  tableRows: Record<string, unknown>[],
  columnRows: Record<string, unknown>[],
  isView: (r: Record<string, unknown>) => boolean,
  toColumn: (r: Record<string, unknown>, tableName: string) => DbColumn,
): DbTable[] {
  const byTable = new Map<string, DbTable>()
  for (const r of tableRows) {
    const name = str(r.name)
    byTable.set(name, { name, kind: isView(r) ? 'view' : 'table', columns: [] })
  }
  for (const r of columnRows) {
    const t = str(r.t)
    const table = byTable.get(t)
    if (table) table.columns.push(toColumn(r, t))
  }
  return [...byTable.values()]
}
