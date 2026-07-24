import { DatabaseSync } from 'node:sqlite'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  AUTO_LEARN,
  AUTO_LEARN_MODEL,
  DB_PATH,
  DEFAULT_PROJECT_ROOT,
  GROUNDING_CHECK,
  GROUNDING_CHECK_MODEL,
} from './config.js'
import type { LogEvent, Project, RunSummary } from './types.js'
import { renameSourceCredential } from './sourceRepo.js'

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rootPath TEXT NOT NULL,
    isDefault INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    ticketId TEXT NOT NULL,
    appUrl TEXT NOT NULL,
    slug TEXT,
    status TEXT NOT NULL,
    passCount INTEGER NOT NULL DEFAULT 0,
    failCount INTEGER NOT NULL DEFAULT 0,
    blockedCount INTEGER NOT NULL DEFAULT 0,
    untestedCount INTEGER NOT NULL DEFAULT 0,
    cancelledCount INTEGER NOT NULL DEFAULT 0,
    totalAcs INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    finishedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    runId TEXT NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    phase TEXT,
    text TEXT NOT NULL,
    tool TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_runId ON events(runId);

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    model TEXT,
    costUsd REAL NOT NULL DEFAULT 0,
    inputTokens INTEGER NOT NULL DEFAULT 0,
    outputTokens INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
`)

// Migration: add projectId to runs if upgrading from the pre-multi-project schema.
// Must run before creating the index that references the column.
{
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'projectId')) {
    db.exec(`ALTER TABLE runs ADD COLUMN projectId TEXT`)
  }
}

// Migration: add sessionId to runs so a paused run can be resumed via
// `claude --resume <sessionId>`. Server-internal — not part of RunSummary.
{
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'sessionId')) {
    db.exec(`ALTER TABLE runs ADD COLUMN sessionId TEXT`)
  }
}

// Migration: add the per-outcome breakdown to runs (blocked / not-tested /
// cancelled) so the History list shows the SAME buckets as a run's detail page.
// Existing rows default to 0 and self-heal on next detail view (routes/qc.ts).
{
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[]
  for (const name of ['blockedCount', 'untestedCount', 'cancelledCount']) {
    if (!cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
    }
  }
}

// Migration: add description to projects (free-text intro shown on the Overview page).
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'description')) {
    db.exec(`ALTER TABLE projects ADD COLUMN description TEXT`)
  }
}

// Migration: add diagram to projects (AI-generated Mermaid diagram of the project).
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'diagram')) {
    db.exec(`ALTER TABLE projects ADD COLUMN diagram TEXT`)
  }
}

// Migration: add pinned to projects (user-pinned projects sort to the top).
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'pinned')) {
    db.exec(`ALTER TABLE projects ADD COLUMN pinned INTEGER DEFAULT 0`)
  }
}

// Migration: add connected-source-repo columns to projects (the /source page).
// The access token is NOT stored in the DB — it lives in data/source-credentials.json.
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  const add = (name: string) => {
    if (!cols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE projects ADD COLUMN ${name} TEXT`)
    }
  }
  add('sourceRepoUrl')
  add('sourceProvider')
  add('sourceBranch')
  add('sourcePath')
  add('sourceLastSync')
  add('sourceLastCommit')
}

// Multi-repo sources: each project can connect SEVERAL repos, each with a tag
// ("Backend repo", "Frontend repo", …). Tokens stay in source-credentials.json,
// keyed by the source id.
db.exec(`
  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    tag TEXT NOT NULL,
    repoUrl TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    sourcePath TEXT NOT NULL DEFAULT '',
    lastSync TEXT NOT NULL DEFAULT '',
    lastCommit TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sources_projectId ON sources(projectId);
`)

// Connected databases: each project can connect SEVERAL databases, each with a tag
// ("Backend DB", "Analytics DB", …). The password is NOT stored here — it lives in
// data/database-credentials.json, keyed by the database id. Mirrors `sources`.
db.exec(`
  CREATE TABLE IF NOT EXISTS databases (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    tag TEXT NOT NULL,
    kind TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT '',
    port INTEGER NOT NULL DEFAULT 0,
    dbName TEXT NOT NULL DEFAULT '',
    username TEXT NOT NULL DEFAULT '',
    ssl INTEGER NOT NULL DEFAULT 0,
    lastSync TEXT NOT NULL DEFAULT '',
    serverVersion TEXT NOT NULL DEFAULT '',
    tableCount INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_databases_projectId ON databases(projectId);
`)

// Migration: fold the legacy single-repo projects.source* columns into one tagged
// `sources` row (tag "Source"), re-keying the on-disk credential from projectId to
// the new source id, then blank the legacy columns so this never re-runs.
{
  const legacy = db
    .prepare(
      `SELECT id, sourceRepoUrl, sourceProvider, sourceBranch, sourcePath,
              sourceLastSync, sourceLastCommit
         FROM projects WHERE sourceRepoUrl IS NOT NULL AND sourceRepoUrl != ''`,
    )
    .all() as Record<string, string | null>[]
  for (const row of legacy) {
    const projectId = row.id as string
    const already = db
      .prepare(`SELECT COUNT(*) AS n FROM sources WHERE projectId = ?`)
      .get(projectId) as { n: number }
    if (already.n === 0) {
      const sourceId = crypto.randomUUID()
      db.prepare(
        `INSERT INTO sources (id, projectId, tag, repoUrl, provider, branch, sourcePath,
                              lastSync, lastCommit, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sourceId,
        projectId,
        'Source',
        row.sourceRepoUrl ?? '',
        row.sourceProvider ?? '',
        row.sourceBranch ?? '',
        row.sourcePath ?? '',
        row.sourceLastSync ?? '',
        row.sourceLastCommit ?? '',
        new Date().toISOString(),
      )
      renameSourceCredential(projectId, sourceId)
    }
    db.prepare(
      `UPDATE projects SET sourceRepoUrl = '', sourceProvider = '', sourceBranch = '',
         sourcePath = '', sourceLastSync = '', sourceLastCommit = '' WHERE id = ?`,
    ).run(projectId)
  }
}

// Migration: per-project AI post-step settings (Settings → Models). These control
// the grounding check (anti-hallucination auto-revise) and AI auto-learn that run
// after test-case generation / a QC run. They default ON with the haiku model so
// existing projects keep current behavior; the UI edits them per project.
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  const addCol = (name: string, ddl: string) => {
    if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${ddl}`)
  }
  addCol('groundingCheck', `INTEGER NOT NULL DEFAULT 1`)
  addCol('groundingCheckModel', `TEXT NOT NULL DEFAULT 'haiku'`)
  addCol('autoLearn', `INTEGER NOT NULL DEFAULT 1`)
  addCol('autoLearnModel', `TEXT NOT NULL DEFAULT 'haiku'`)
}

// Migration: per-project default QC skill — the skill auto-selected on the Launch
// QC Run page (set from the Skills page). Empty string means "no default" and the
// run form falls back to qc-testing / the first available skill.
{
  const cols = db.prepare(`PRAGMA table_info(projects)`).all() as { name: string }[]
  if (!cols.some((c) => c.name === 'defaultSkill')) {
    db.exec(`ALTER TABLE projects ADD COLUMN defaultSkill TEXT NOT NULL DEFAULT ''`)
  }
}

db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_projectId ON runs(projectId)`)

// Multiple named Mermaid diagrams per project (the Overview page lets the user
// keep several, each with its own name + content). The legacy single
// projects.diagram column is kept in sync with the most-recently-touched diagram
// for backward-compat.
db.exec(`
  CREATE TABLE IF NOT EXISTS diagrams (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_diagrams_projectId ON diagrams(projectId);
`)

// One row per Design Check run (/verify). The full findings are stored as JSON and
// also written to a markdown file under <root>/design-check/ (filePath, relative to
// the project root); the per-category counts are denormalized for quick listing.
db.exec(`
  CREATE TABLE IF NOT EXISTS design_checks (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    folder TEXT NOT NULL,
    figmaUrl TEXT NOT NULL,
    model TEXT,
    summary TEXT,
    findingsJson TEXT NOT NULL DEFAULT '[]',
    matchCount INTEGER NOT NULL DEFAULT 0,
    mismatchCount INTEGER NOT NULL DEFAULT 0,
    concernCount INTEGER NOT NULL DEFAULT 0,
    unsureCount INTEGER NOT NULL DEFAULT 0,
    discussCount INTEGER NOT NULL DEFAULT 0,
    totalFindings INTEGER NOT NULL DEFAULT 0,
    filePath TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_design_checks_projectId ON design_checks(projectId);
`)

function now(): string {
  return new Date().toISOString()
}

// Migration: backfill the legacy single projects.diagram into the diagrams table
// as a first named entry, so existing projects keep their diagram under the new
// multi-diagram model. Only runs for projects that have no diagrams rows yet.
{
  const projs = db
    .prepare(`SELECT id, diagram FROM projects WHERE diagram IS NOT NULL AND diagram != ''`)
    .all() as { id: string; diagram: string }[]
  const countStmt = db.prepare(`SELECT COUNT(*) AS n FROM diagrams WHERE projectId = ?`)
  const insertStmt = db.prepare(
    `INSERT INTO diagrams (id, projectId, name, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const p of projs) {
    const n = Number((countStmt.get(p.id) as { n: number }).n)
    if (n === 0) {
      const ts = now()
      insertStmt.run(crypto.randomUUID(), p.id, 'Project diagram', p.diagram, ts, ts)
    }
  }
}

export function newRunId(): string {
  return crypto.randomUUID()
}

// ---------------- projects ----------------

const insertProjectStmt = db.prepare(`
  INSERT INTO projects
    (id, name, rootPath, isDefault, createdAt, groundingCheck, groundingCheckModel, autoLearn, autoLearnModel)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const listProjectsStmt = db.prepare(`SELECT * FROM projects ORDER BY pinned DESC, createdAt ASC`)
const getProjectStmt = db.prepare(`SELECT * FROM projects WHERE id = ?`)
const getDefaultProjectStmt = db.prepare(`SELECT * FROM projects WHERE isDefault = 1 LIMIT 1`)
const deleteProjectStmt = db.prepare(`DELETE FROM projects WHERE id = ?`)

function rowToProject(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    name: row.name as string,
    rootPath: row.rootPath as string,
    isDefault: Number(row.isDefault) === 1,
    pinned: Number(row.pinned) === 1,
    createdAt: row.createdAt as string,
    description: (row.description as string | null) ?? '',
    diagram: (row.diagram as string | null) ?? '',
    sourceRepoUrl: (row.sourceRepoUrl as string | null) ?? '',
    sourceProvider: (row.sourceProvider as string | null) ?? '',
    sourceBranch: (row.sourceBranch as string | null) ?? '',
    sourcePath: (row.sourcePath as string | null) ?? '',
    sourceLastSync: (row.sourceLastSync as string | null) ?? '',
    sourceLastCommit: (row.sourceLastCommit as string | null) ?? '',
    groundingCheck: Number(row.groundingCheck ?? 1) === 1,
    groundingCheckModel: (row.groundingCheckModel as string | null) || 'haiku',
    autoLearn: Number(row.autoLearn ?? 1) === 1,
    autoLearnModel: (row.autoLearnModel as string | null) || 'haiku',
    defaultSkill: (row.defaultSkill as string | null) ?? '',
  }
}

export function listProjects(): Project[] {
  return (listProjectsStmt.all() as Record<string, unknown>[]).map(rowToProject)
}

export function getProject(id: string): Project | undefined {
  const row = getProjectStmt.get(id) as Record<string, unknown> | undefined
  return row ? rowToProject(row) : undefined
}

export function getDefaultProject(): Project | undefined {
  const row = getDefaultProjectStmt.get() as Record<string, unknown> | undefined
  return row ? rowToProject(row) : undefined
}

export function createProject(name: string, rootPath: string, isDefault = false): Project {
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    rootPath,
    isDefault,
    pinned: false,
    createdAt: now(),
    description: '',
    diagram: '',
    sourceRepoUrl: '',
    sourceProvider: '',
    sourceBranch: '',
    sourcePath: '',
    sourceLastSync: '',
    sourceLastCommit: '',
    // New projects inherit the env-var defaults; the UI edits them per project after.
    groundingCheck: GROUNDING_CHECK,
    groundingCheckModel: GROUNDING_CHECK_MODEL,
    autoLearn: AUTO_LEARN,
    autoLearnModel: AUTO_LEARN_MODEL,
    defaultSkill: '',
  }
  insertProjectStmt.run(
    project.id,
    project.name,
    project.rootPath,
    project.isDefault ? 1 : 0,
    project.createdAt,
    project.groundingCheck ? 1 : 0,
    project.groundingCheckModel,
    project.autoLearn ? 1 : 0,
    project.autoLearnModel,
  )
  return project
}

export function updateProject(
  id: string,
  partial: Partial<
    Pick<
      Project,
      | 'name'
      | 'rootPath'
      | 'description'
      | 'diagram'
      | 'pinned'
      | 'groundingCheck'
      | 'groundingCheckModel'
      | 'autoLearn'
      | 'autoLearnModel'
      | 'defaultSkill'
    >
  >,
): void {
  const keys = (
    [
      'name',
      'rootPath',
      'description',
      'diagram',
      'pinned',
      'groundingCheck',
      'groundingCheckModel',
      'autoLearn',
      'autoLearnModel',
      'defaultSkill',
    ] as const
  ).filter((k) => k in partial)
  if (keys.length === 0) return
  const boolCols = new Set(['pinned', 'groundingCheck', 'autoLearn'])
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  const values = keys.map((k) =>
    boolCols.has(k) ? (partial[k as keyof typeof partial] ? 1 : 0) : (partial[k] as string),
  )
  db.prepare(`UPDATE projects SET ${setClause} WHERE id = ?`).run(...values, id)
}

export function deleteProject(id: string): void {
  deleteProjectStmt.run(id)
}

/** One connected source repo of a project (no token — that lives on disk, keyed by id). */
export interface SourceRow {
  id: string
  projectId: string
  tag: string
  repoUrl: string
  provider: string
  branch: string
  sourcePath: string
  lastSync: string
  lastCommit: string
  createdAt: string
}

function sourceFromRow(row: Record<string, unknown>): SourceRow {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    tag: (row.tag as string | null) ?? '',
    repoUrl: (row.repoUrl as string | null) ?? '',
    provider: (row.provider as string | null) ?? '',
    branch: (row.branch as string | null) ?? '',
    sourcePath: (row.sourcePath as string | null) ?? '',
    lastSync: (row.lastSync as string | null) ?? '',
    lastCommit: (row.lastCommit as string | null) ?? '',
    createdAt: (row.createdAt as string | null) ?? '',
  }
}

/** All source repos connected to a project, oldest first (stable card order). */
export function listSources(projectId: string): SourceRow[] {
  const rows = db
    .prepare(`SELECT * FROM sources WHERE projectId = ? ORDER BY createdAt ASC`)
    .all(projectId) as Record<string, unknown>[]
  return rows.map(sourceFromRow)
}

export function getSourceRow(id: string): SourceRow | undefined {
  const row = db.prepare(`SELECT * FROM sources WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? sourceFromRow(row) : undefined
}

/** Insert or fully update a source repo row (after a clone/sync finishes). */
export function saveSource(source: SourceRow): void {
  db.prepare(
    `INSERT INTO sources (id, projectId, tag, repoUrl, provider, branch, sourcePath,
                          lastSync, lastCommit, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tag = excluded.tag, repoUrl = excluded.repoUrl, provider = excluded.provider,
       branch = excluded.branch, sourcePath = excluded.sourcePath,
       lastSync = excluded.lastSync, lastCommit = excluded.lastCommit`,
  ).run(
    source.id,
    source.projectId,
    source.tag,
    source.repoUrl,
    source.provider,
    source.branch,
    source.sourcePath,
    source.lastSync,
    source.lastCommit,
    source.createdAt,
  )
}

/** Forget one connected source repo (the files on disk are left alone). */
export function deleteSourceRow(id: string): void {
  db.prepare(`DELETE FROM sources WHERE id = ?`).run(id)
}

/** One connected database of a project (no password — that lives on disk, keyed by id). */
export interface DatabaseRow {
  id: string
  projectId: string
  tag: string
  kind: string
  host: string
  port: number
  dbName: string
  username: string
  ssl: boolean
  lastSync: string
  serverVersion: string
  tableCount: number
  createdAt: string
}

function databaseFromRow(row: Record<string, unknown>): DatabaseRow {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    tag: (row.tag as string | null) ?? '',
    kind: (row.kind as string | null) ?? '',
    host: (row.host as string | null) ?? '',
    port: Number(row.port ?? 0),
    dbName: (row.dbName as string | null) ?? '',
    username: (row.username as string | null) ?? '',
    ssl: Number(row.ssl ?? 0) === 1,
    lastSync: (row.lastSync as string | null) ?? '',
    serverVersion: (row.serverVersion as string | null) ?? '',
    tableCount: Number(row.tableCount ?? 0),
    createdAt: (row.createdAt as string | null) ?? '',
  }
}

/** All databases connected to a project, oldest first (stable card order). */
export function listDatabases(projectId: string): DatabaseRow[] {
  const rows = db
    .prepare(`SELECT * FROM databases WHERE projectId = ? ORDER BY createdAt ASC`)
    .all(projectId) as Record<string, unknown>[]
  return rows.map(databaseFromRow)
}

export function getDatabaseRow(id: string): DatabaseRow | undefined {
  const row = db.prepare(`SELECT * FROM databases WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? databaseFromRow(row) : undefined
}

/** Insert or fully update a database row (after a connect/sync finishes). */
export function saveDatabase(dbRow: DatabaseRow): void {
  db.prepare(
    `INSERT INTO databases (id, projectId, tag, kind, host, port, dbName, username, ssl,
                            lastSync, serverVersion, tableCount, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tag = excluded.tag, kind = excluded.kind, host = excluded.host, port = excluded.port,
       dbName = excluded.dbName, username = excluded.username, ssl = excluded.ssl,
       lastSync = excluded.lastSync, serverVersion = excluded.serverVersion,
       tableCount = excluded.tableCount`,
  ).run(
    dbRow.id,
    dbRow.projectId,
    dbRow.tag,
    dbRow.kind,
    dbRow.host,
    dbRow.port,
    dbRow.dbName,
    dbRow.username,
    dbRow.ssl ? 1 : 0,
    dbRow.lastSync,
    dbRow.serverVersion,
    dbRow.tableCount,
    dbRow.createdAt,
  )
}

/** Forget one connected database (the database server itself is untouched). */
export function deleteDatabaseRow(id: string): void {
  db.prepare(`DELETE FROM databases WHERE id = ?`).run(id)
}

/**
 * Seed a default project from QC_REPO_ROOT on first run, if configured.
 * No-op when a default already exists or no root is configured — the portal is
 * standalone and gets its projects from the database / the Projects page.
 */
export function seedDefaultProject(): Project | undefined {
  const existing = getDefaultProject()
  if (existing) return existing
  if (!DEFAULT_PROJECT_ROOT) return undefined
  const name = path.basename(DEFAULT_PROJECT_ROOT) || 'default'
  return createProject(name, DEFAULT_PROJECT_ROOT, true)
}

// ---------------- diagrams ----------------

export interface Diagram {
  id: string
  projectId: string
  name: string
  content: string
  createdAt: string
  updatedAt: string
}

const listDiagramsStmt = db.prepare(
  `SELECT * FROM diagrams WHERE projectId = ? ORDER BY createdAt ASC`,
)
const getDiagramStmt = db.prepare(`SELECT * FROM diagrams WHERE id = ?`)
const insertDiagramStmt = db.prepare(
  `INSERT INTO diagrams (id, projectId, name, content, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
)
const deleteDiagramStmt = db.prepare(`DELETE FROM diagrams WHERE id = ?`)
const latestDiagramStmt = db.prepare(
  `SELECT content FROM diagrams WHERE projectId = ? ORDER BY updatedAt DESC LIMIT 1`,
)

function rowToDiagram(row: Record<string, unknown>): Diagram {
  return {
    id: row.id as string,
    projectId: row.projectId as string,
    name: row.name as string,
    content: (row.content as string | null) ?? '',
    createdAt: row.createdAt as string,
    updatedAt: row.updatedAt as string,
  }
}

// Keep the legacy projects.diagram column pointing at the most-recently-updated
// diagram (or empty) so anything still reading it stays sensible.
function mirrorPrimaryDiagram(projectId: string): void {
  const row = latestDiagramStmt.get(projectId) as { content?: string } | undefined
  db.prepare(`UPDATE projects SET diagram = ? WHERE id = ?`).run(row?.content ?? '', projectId)
}

export function listDiagrams(projectId: string): Diagram[] {
  return (listDiagramsStmt.all(projectId) as Record<string, unknown>[]).map(rowToDiagram)
}

export function getDiagram(id: string): Diagram | undefined {
  const row = getDiagramStmt.get(id) as Record<string, unknown> | undefined
  return row ? rowToDiagram(row) : undefined
}

export function createDiagram(projectId: string, name: string, content: string): Diagram {
  const ts = now()
  const diagram: Diagram = {
    id: crypto.randomUUID(),
    projectId,
    name: name.trim() || 'Untitled diagram',
    content,
    createdAt: ts,
    updatedAt: ts,
  }
  insertDiagramStmt.run(
    diagram.id,
    diagram.projectId,
    diagram.name,
    diagram.content,
    diagram.createdAt,
    diagram.updatedAt,
  )
  mirrorPrimaryDiagram(projectId)
  return diagram
}

export function updateDiagram(
  id: string,
  partial: { name?: string; content?: string },
): Diagram | undefined {
  const existing = getDiagram(id)
  if (!existing) return undefined
  const name = partial.name != null ? partial.name.trim() || existing.name : existing.name
  const content = partial.content != null ? partial.content : existing.content
  const updatedAt = now()
  db.prepare(`UPDATE diagrams SET name = ?, content = ?, updatedAt = ? WHERE id = ?`).run(
    name,
    content,
    updatedAt,
    id,
  )
  mirrorPrimaryDiagram(existing.projectId)
  return { ...existing, name, content, updatedAt }
}

export function deleteDiagram(id: string): void {
  const existing = getDiagram(id)
  deleteDiagramStmt.run(id)
  if (existing) mirrorPrimaryDiagram(existing.projectId)
}

// ---------------- design checks ----------------

export interface DesignCheckFinding {
  category: string
  title: string
  detail: string
}

export interface DesignCheckRecord {
  id: string
  projectId: string
  folder: string
  figmaUrl: string
  model: string
  summary: string
  findings: DesignCheckFinding[]
  counts: { match: number; mismatch: number; concern: number; unsure: number; discuss: number; total: number }
  /** Path to the saved markdown report, relative to the project root (or null). */
  filePath: string | null
  createdAt: string
}

const insertDesignCheckStmt = db.prepare(`
  INSERT INTO design_checks (
    id, projectId, folder, figmaUrl, model, summary, findingsJson,
    matchCount, mismatchCount, concernCount, unsureCount, discussCount, totalFindings,
    filePath, createdAt
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const listDesignChecksStmt = db.prepare(
  `SELECT * FROM design_checks WHERE projectId = ? ORDER BY createdAt DESC LIMIT ?`,
)

function rowToDesignCheck(row: Record<string, unknown>): DesignCheckRecord {
  let findings: DesignCheckFinding[] = []
  try {
    const parsed = JSON.parse((row.findingsJson as string) ?? '[]')
    if (Array.isArray(parsed)) findings = parsed as DesignCheckFinding[]
  } catch {
    /* corrupt JSON — fall back to empty */
  }
  return {
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? '',
    folder: row.folder as string,
    figmaUrl: row.figmaUrl as string,
    model: (row.model as string | null) ?? '',
    summary: (row.summary as string | null) ?? '',
    findings,
    counts: {
      match: Number(row.matchCount) || 0,
      mismatch: Number(row.mismatchCount) || 0,
      concern: Number(row.concernCount) || 0,
      unsure: Number(row.unsureCount) || 0,
      discuss: Number(row.discussCount) || 0,
      total: Number(row.totalFindings) || 0,
    },
    filePath: (row.filePath as string | null) ?? null,
    createdAt: row.createdAt as string,
  }
}

/** Record one Design Check run. Returns the saved record (id + timestamp filled in). */
export function insertDesignCheck(input: {
  projectId: string
  folder: string
  figmaUrl: string
  model: string
  summary: string
  findings: DesignCheckFinding[]
  filePath: string | null
}): DesignCheckRecord {
  const id = crypto.randomUUID()
  const createdAt = now()
  const c = { match: 0, mismatch: 0, concern: 0, unsure: 0, discuss: 0 }
  for (const f of input.findings) {
    if (f.category in c) (c as Record<string, number>)[f.category]++
  }
  const total = input.findings.length
  insertDesignCheckStmt.run(
    id,
    input.projectId,
    input.folder,
    input.figmaUrl,
    input.model,
    input.summary,
    JSON.stringify(input.findings),
    c.match,
    c.mismatch,
    c.concern,
    c.unsure,
    c.discuss,
    total,
    input.filePath,
    createdAt,
  )
  return {
    id,
    projectId: input.projectId,
    folder: input.folder,
    figmaUrl: input.figmaUrl,
    model: input.model,
    summary: input.summary,
    findings: input.findings,
    counts: { ...c, total },
    filePath: input.filePath,
    createdAt,
  }
}

/** List a project's Design Check records, newest first. */
export function listDesignChecks(projectId: string, limit = 50): DesignCheckRecord[] {
  return (listDesignChecksStmt.all(projectId, limit) as Record<string, unknown>[]).map(
    rowToDesignCheck,
  )
}

// ---------------- runs ----------------

const insertRunStmt = db.prepare(`
  INSERT INTO runs (id, projectId, ticketId, appUrl, slug, status, passCount, failCount, blockedCount, untestedCount, cancelledCount, totalAcs, createdAt, finishedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

const RUN_SELECT = `
  SELECT r.*, p.name AS projectName
  FROM runs r LEFT JOIN projects p ON p.id = r.projectId
`
const getRunStmt = db.prepare(`${RUN_SELECT} WHERE r.id = ?`)
const listRunsStmt = db.prepare(`${RUN_SELECT} ORDER BY r.createdAt DESC`)
const listRunsByProjectStmt = db.prepare(`${RUN_SELECT} WHERE r.projectId = ? ORDER BY r.createdAt DESC`)

function rowToSummary(row: Record<string, unknown>): RunSummary {
  return {
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? '',
    projectName: (row.projectName as string | null) ?? null,
    ticketId: row.ticketId as string,
    appUrl: row.appUrl as string,
    slug: (row.slug as string | null) ?? null,
    status: row.status as RunSummary['status'],
    passCount: Number(row.passCount),
    failCount: Number(row.failCount),
    blockedCount: Number(row.blockedCount ?? 0),
    untestedCount: Number(row.untestedCount ?? 0),
    cancelledCount: Number(row.cancelledCount ?? 0),
    totalAcs: Number(row.totalAcs),
    createdAt: row.createdAt as string,
    finishedAt: (row.finishedAt as string | null) ?? null,
  }
}

export function insertRun(summary: RunSummary): void {
  insertRunStmt.run(
    summary.id,
    summary.projectId,
    summary.ticketId,
    summary.appUrl,
    summary.slug,
    summary.status,
    summary.passCount,
    summary.failCount,
    summary.blockedCount,
    summary.untestedCount,
    summary.cancelledCount,
    summary.totalAcs,
    summary.createdAt,
    summary.finishedAt,
  )
}

export function updateRun(id: string, partial: Partial<RunSummary>): void {
  const allowed: (keyof RunSummary)[] = [
    'ticketId',
    'appUrl',
    'slug',
    'status',
    'passCount',
    'failCount',
    'blockedCount',
    'untestedCount',
    'cancelledCount',
    'totalAcs',
    'createdAt',
    'finishedAt',
  ]
  const keys = allowed.filter((k) => k in partial)
  if (keys.length === 0) return
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  const values = keys.map((k) => partial[k] as string | number | null)
  db.prepare(`UPDATE runs SET ${setClause} WHERE id = ?`).run(...values, id)
}

export function getRun(id: string): RunSummary | undefined {
  const row = getRunStmt.get(id) as Record<string, unknown> | undefined
  return row ? rowToSummary(row) : undefined
}

const setRunSessionStmt = db.prepare(`UPDATE runs SET sessionId = ? WHERE id = ?`)
const getRunSessionStmt = db.prepare(`SELECT sessionId FROM runs WHERE id = ?`)

/** Persist the Claude session id so a paused run can later be resumed. */
export function setRunSession(id: string, sessionId: string): void {
  setRunSessionStmt.run(sessionId, id)
}

export function getRunSession(id: string): string | null {
  const row = getRunSessionStmt.get(id) as { sessionId: string | null } | undefined
  return row?.sessionId ?? null
}

export function listRuns(projectId?: string): RunSummary[] {
  const rows = (
    projectId ? listRunsByProjectStmt.all(projectId) : listRunsStmt.all()
  ) as Record<string, unknown>[]
  return rows.map(rowToSummary)
}

const deleteRunStmt = db.prepare(`DELETE FROM runs WHERE id = ?`)
const deleteRunEventsStmt = db.prepare(`DELETE FROM events WHERE runId = ?`)

/** Remove a run and its event log from the database (the on-disk output folder,
 * if any, is removed separately by the caller). */
export function deleteRun(id: string): void {
  deleteRunEventsStmt.run(id)
  deleteRunStmt.run(id)
}

// ---------------- events ----------------

const insertEventStmt = db.prepare(`
  INSERT INTO events (runId, ts, kind, phase, text, tool) VALUES (?, ?, ?, ?, ?, ?)
`)
const getEventsStmt = db.prepare(`
  SELECT ts, kind, phase, text, tool FROM events WHERE runId = ? ORDER BY rowid ASC
`)
const getEventsLimitStmt = db.prepare(`
  SELECT ts, kind, phase, text, tool FROM events WHERE runId = ? ORDER BY rowid DESC LIMIT ?
`)

export function appendEvent(runId: string, event: LogEvent): void {
  insertEventStmt.run(runId, event.ts, event.kind, event.phase ?? null, event.text, event.tool ?? null)
}

function rowToEvent(row: Record<string, unknown>): LogEvent {
  return {
    ts: row.ts as string,
    kind: row.kind as LogEvent['kind'],
    phase: (row.phase as LogEvent['phase']) ?? undefined,
    text: row.text as string,
    tool: (row.tool as string | null) ?? undefined,
  }
}

export function getEvents(runId: string, limit?: number): LogEvent[] {
  if (limit != null) {
    const rows = getEventsLimitStmt.all(runId, limit) as Record<string, unknown>[]
    return rows.map(rowToEvent).reverse()
  }
  const rows = getEventsStmt.all(runId) as Record<string, unknown>[]
  return rows.map(rowToEvent)
}

// ---------------- usage ----------------

const insertUsageStmt = db.prepare(`
  INSERT INTO usage_events (id, ts, source, model, costUsd, inputTokens, outputTokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)

/** Record one Claude invocation's cost/token usage (best-effort, never throws). */
export function recordUsage(u: {
  source: string
  model?: string | null
  costUsd?: number
  inputTokens?: number
  outputTokens?: number
}): void {
  try {
    insertUsageStmt.run(
      crypto.randomUUID(),
      now(),
      u.source,
      u.model ?? null,
      u.costUsd ?? 0,
      u.inputTokens ?? 0,
      u.outputTokens ?? 0,
    )
  } catch {
    /* usage tracking must never break a real operation */
  }
}

export interface UsageTotals {
  costUsd: number
  inputTokens: number
  outputTokens: number
  count: number
}

const sumUsageSinceStmt = db.prepare(`
  SELECT
    COALESCE(SUM(costUsd), 0) AS costUsd,
    COALESCE(SUM(inputTokens), 0) AS inputTokens,
    COALESCE(SUM(outputTokens), 0) AS outputTokens,
    COUNT(*) AS count
  FROM usage_events WHERE ts >= ?
`)

/** Sum cost/tokens for all usage events at or after the given ISO timestamp. */
export function sumUsageSince(tsISO: string): UsageTotals {
  const row = sumUsageSinceStmt.get(tsISO) as Record<string, unknown>
  return {
    costUsd: Number(row.costUsd) || 0,
    inputTokens: Number(row.inputTokens) || 0,
    outputTokens: Number(row.outputTokens) || 0,
    count: Number(row.count) || 0,
  }
}

const oldestUsageSinceStmt = db.prepare(
  `SELECT MIN(ts) AS oldest FROM usage_events WHERE ts >= ?`,
)

/** ISO timestamp of the earliest usage event within the window, or null if none. */
export function oldestUsageSince(tsISO: string): string | null {
  const row = oldestUsageSinceStmt.get(tsISO) as { oldest?: string | null }
  return row?.oldest ?? null
}

/**
 * Runs left in 'running'/'queued' when the server stopped are orphaned — their
 * claude child process was killed and can never resume. Mark them as errored so
 * they don't appear stuck forever. Called once at startup (nothing is live yet).
 */
export function reconcileInterruptedRuns(): number {
  const stuck = db
    .prepare(`SELECT id FROM runs WHERE status IN ('running', 'queued')`)
    .all() as { id: string }[]
  const now = new Date().toISOString()
  for (const r of stuck) {
    updateRun(r.id, { status: 'error', finishedAt: now })
    appendEvent(r.id, {
      ts: now,
      kind: 'error',
      text: 'Run was interrupted (the server stopped) and did not finish.',
    })
  }
  return stuck.length
}
