import fs from 'node:fs'
import { syncContextPointer } from './contextPointer.js'
import { knowledgeFile, writeDoc } from './knowledgeStore.js'
import { tagSlug } from './sourceRepo.js'
import type { DbConfig, DbSchema } from './dbConnect.js'

// Database map: a compact, DETERMINISTIC index of a connected database's schema,
// written on every connect/sync into testing/knowledge/db-map-<tag>.md. Because it
// lives in the Knowledge folder it flows through the existing pipeline for free —
// injected into test-case prompts (projectContext.ts), read by QC runs via the
// CLAUDE.md context pointer, and visible/editable on the Instructions page (AI badge).
//
// No AI pass — the schema is read straight from information_schema and rendered as
// Markdown tables, so it's exact and costs nothing.

// projectContext injects at most 6 KB per knowledge doc; keep the rendered map well
// under that so a large schema is summarized rather than silently clipped mid-table.
const MAX_MAP_CHARS = 5_800

/** Knowledge-doc name for a DB tag: "Backend DB" → "db-map-backend-db". */
export function dbMapDocName(tag: string): string {
  return `db-map-${tagSlug(tag)}`
}

export function hasDbMap(rootPath: string, tag: string): boolean {
  const file = knowledgeFile(rootPath, dbMapDocName(tag))
  try {
    return Boolean(file && fs.statSync(file).isFile())
  } catch {
    return false
  }
}

/** Remove a database's map doc (on disconnect / tag rename). Best-effort. */
export function deleteDbMap(rootPath: string, tag: string): void {
  const file = knowledgeFile(rootPath, dbMapDocName(tag))
  try {
    if (file && fs.existsSync(file)) {
      fs.rmSync(file)
      syncContextPointer(rootPath)
    }
  } catch {
    /* best-effort */
  }
}

function renderSchema(config: DbConfig, schema: DbSchema): string {
  const lines: string[] = []
  const tables = schema.tables.filter((t) => t.kind === 'table')
  const views = schema.tables.filter((t) => t.kind === 'view')

  lines.push('## Overview')
  lines.push(
    `${schema.serverVersion} · ${tables.length} table${tables.length === 1 ? '' : 's'}` +
      (views.length ? ` · ${views.length} view${views.length === 1 ? '' : 's'}` : '') +
      `. Use these exact table and column names when writing test cases, test data, and QC checks.`,
  )
  lines.push('')

  const fkByTable = new Map<string, string[]>()
  for (const fk of schema.foreignKeys) {
    const list = fkByTable.get(fk.table) ?? []
    list.push(`\`${fk.column}\` → \`${fk.refTable}.${fk.refColumn}\``)
    fkByTable.set(fk.table, list)
  }

  for (const t of [...tables, ...views]) {
    lines.push(`## ${t.kind === 'view' ? 'View' : 'Table'}: ${t.name}`)
    lines.push('| column | type | null | key | default |')
    lines.push('|---|---|---|---|---|')
    for (const c of t.columns) {
      const def = c.default == null ? '' : `\`${c.default}\``.slice(0, 40)
      lines.push(
        `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} | ${c.key || ''} | ${def} |`,
      )
    }
    const fks = fkByTable.get(t.name)
    if (fks?.length) lines.push('', `**Foreign keys:** ${fks.join(', ')}`)
    lines.push('')
  }

  return lines.join('\n').trim()
}

export interface DbMapResult {
  name: string
  tableCount: number
}

/**
 * Render + save the database map for one connected database as an AI-tagged
 * knowledge doc, and sync the CLAUDE.md context pointer. Returns null on failure
 * (best-effort — a missing map just means the model won't know the schema up front).
 */
export function writeDbMap(opts: {
  rootPath: string
  tag: string
  config: DbConfig
  schema: DbSchema
}): DbMapResult | null {
  try {
    const today = new Date().toISOString().slice(0, 10)
    const where = `\`${opts.config.database}\` on \`${opts.config.host}:${opts.config.port}\``
    let body = renderSchema(opts.config, opts.schema)
    if (body.length > MAX_MAP_CHARS) {
      body = `${body.slice(0, MAX_MAP_CHARS)}\n\n…(schema truncated — open the Database page to see the full map)`
    }
    const content = `# Database map — ${opts.tag} (${opts.config.kind})\n\n_Database ${where} · introspected ${today}. These are the real table and column names._\n\n${body}\n`

    const written = writeDoc({
      rootPath: opts.rootPath,
      name: dbMapDocName(opts.tag),
      content,
      source: `ai · database map · ${opts.tag} · ${today}`,
    })
    if (!written) return null
    syncContextPointer(opts.rootPath)
    return { name: written.name, tableCount: opts.schema.tables.length }
  } catch {
    return null
  }
}
