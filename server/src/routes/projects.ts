import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listRuns,
  updateProject,
} from '../db.js'
import {
  bundledSkillDir,
  bundledTemplateFile,
  mcpJsonFor,
  skillsDirFor,
  testingDirFor,
} from '../config.js'
import { pickFolderNative } from '../folderPicker.js'
import { listTestcaseJobs } from '../testcaseJobs.js'
import { listCrawlJobs } from '../crawlJobs.js'
import type { Project } from '../types.js'

/**
 * Why a project is "busy" (a process is reading/writing its folder), or null if
 * idle. Renaming the folder while any of these run would write to a stale path.
 */
function projectBusyReason(projectId: string): string | null {
  const activeRuns = listRuns(projectId).filter(
    (r) => r.status === 'running' || r.status === 'queued' || r.status === 'paused',
  )
  if (activeRuns.length) {
    return `${activeRuns.length} QC run${activeRuns.length === 1 ? '' : 's'} in progress (or paused)`
  }
  if (listTestcaseJobs(projectId).some((j) => j.status === 'running')) {
    return 'a test-case generation job is running'
  }
  if (listCrawlJobs(projectId).some((j) => j.status === 'running')) {
    return 'a ticket crawl job is running'
  }
  return null
}

/** The one skill `init` scaffolds — the QC brain. Other template skills are skipped. */
const QC_SKILL = 'qc-testing'

export const projectsRouter = Router()

projectsRouter.get('/pick-folder', async (_req, res) => {
  const result = await pickFolderNative('Select the project folder')
  if (result.error) return res.status(500).json({ error: result.error })
  return res.json({ path: result.path, canceled: result.path === null })
})

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Turn a display name into a safe single folder-segment (no separators or
 *  illegal chars). Returns '' if nothing usable is left. */
function safeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]+/g, ' ') // drop path separators & illegal chars
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, '') // strip control chars
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '') // no leading dots (hidden / traversal)
    .slice(0, 100)
    .trim()
}

/** Light health hints about a project root so the UI can warn the user. */
function rootInfo(rootPath: string) {
  return {
    exists: isDir(rootPath),
    hasSkills: isDir(skillsDirFor(rootPath)),
    hasMcp: fs.existsSync(path.join(rootPath, '.mcp.json')),
    hasClaudeMd: fs.existsSync(path.join(rootPath, 'CLAUDE.md')),
  }
}

/** True when a folder already has the full Claude Code layout we can clone from. */
function isClaudeReady(rootPath: string): boolean {
  const i = rootInfo(rootPath)
  return i.exists && i.hasSkills && i.hasMcp && i.hasClaudeMd
}

/**
 * Pick an existing project to use as a template for `init` — one whose folder
 * already has CLAUDE.md, .claude/skills, and .mcp.json. Prefers the default
 * project, then the most recently usable one.
 */
function findTemplateProject(excludeId: string): Project | null {
  const candidates = listProjects()
    .filter((p) => p.id !== excludeId)
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return candidates.find((p) => isClaudeReady(p.rootPath)) ?? null
}

/**
 * Starter CLAUDE.md written for a brand-new project when there's no existing
 * project to clone guidance from. It's a fill-in-the-blanks scaffold (not just the
 * name) so the Instructions page is useful immediately and the `qc-testing` skill
 * has real structure to read. The engineer edits it on /instructions.
 */
function starterClaudeMd(name: string): string {
  return `# ${name}

Guidance for Claude Code when running QC against **${name}**. Keep this short and
high-signal — every QC run and the \`qc-testing\` skill read it before testing.
Replace the prompts below with the real details.

## Overview

What ${name} is, who uses it, and what it does — one or two sentences.

## Architecture & key areas

- **Stack:** what the app is built with (e.g. React + Node + Postgres).
- **Main flows:** the user journeys that matter most for QC (e.g. sign-up, checkout, search).
- **Where things live:** the screens, endpoints, and modules a tester should know about.

## How to test it

- **App URL(s):** the staging/QA address QC should open (also chosen per run).
- **Test accounts:** which roles/logins to use — never paste real secrets here (see Safety).
- **Out of scope:** flows or environments QC must NOT touch (e.g. production, real payments).

## Conventions & gotchas

- Coding conventions, naming, commands, and known quirks so Claude follows them.
- Anything that commonly breaks tests (flaky areas, slow pages, required setup steps).

## Safety

- This project may run on shared environments — Claude must not perform destructive or
  irreversible actions (deleting data, sending real emails/payments) during a QC run.
- Never store credentials or OTPs in this file. Provide them per run instead.
`
}

const skipDsStore = (src: string) => !src.endsWith('.DS_Store')

function initializeProjectFolder(project: Project): { created: string[]; templateName: string | null } {
  const root = project.rootPath
  if (!isDir(root)) {
    throw new Error(`folder not found: ${root}`)
  }

  const template = findTemplateProject(project.id)
  const created: string[] = []

  // 1. CLAUDE.md
  const targetClaudeMd = path.join(root, 'CLAUDE.md')
  if (!fs.existsSync(targetClaudeMd)) {
    const tpl = template && path.join(template.rootPath, 'CLAUDE.md')
    if (tpl && fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, targetClaudeMd)
    } else {
      fs.writeFileSync(targetClaudeMd, starterClaudeMd(project.name))
    }
    created.push('CLAUDE.md')
  }

  // 2. .claude/skills/qc-testing — scaffold ONLY the `qc-testing` skill (the QC
  // brain), never the template's other skills. Source preference: an existing
  // template project's copy (may be customized), else the skill bundled with the
  // portal (templates/skills/qc-testing) — so a brand-new install with no other
  // projects to clone from still gets the skill. Keyed on the skill folder, not
  // the parent, so a pre-existing empty .claude/skills doesn't block it.
  const targetSkills = skillsDirFor(root)
  const targetQcSkill = path.join(targetSkills, QC_SKILL)
  if (!isDir(targetQcSkill)) {
    const tplQcSkill = template ? path.join(skillsDirFor(template.rootPath), QC_SKILL) : null
    const sourceQcSkill =
      tplQcSkill && isDir(tplQcSkill)
        ? tplQcSkill
        : isDir(bundledSkillDir(QC_SKILL))
          ? bundledSkillDir(QC_SKILL)
          : null
    if (sourceQcSkill) {
      fs.mkdirSync(targetSkills, { recursive: true })
      fs.cpSync(sourceQcSkill, targetQcSkill, { recursive: true, filter: skipDsStore })
      created.push('.claude/skills/qc-testing')
    }
  }

  // 3. .mcp.json
  const targetMcp = mcpJsonFor(root)
  if (!fs.existsSync(targetMcp)) {
    const tpl = template ? mcpJsonFor(template.rootPath) : null
    if (tpl && fs.existsSync(tpl)) {
      fs.copyFileSync(tpl, targetMcp)
    } else {
      fs.writeFileSync(targetMcp, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`)
    }
    created.push('.mcp.json')
  }

  // 4. testing/templates/testcase.md — the default test-case template shown on
  // /templates and matched by test-case generation. Source preference mirrors the
  // skill scaffold: an existing template project's copy (may be customized), else
  // the default bundled with the portal (templates/project-templates/testcase.md).
  const targetTcTemplate = path.join(testingDirFor(root), 'templates', 'testcase.md')
  if (!fs.existsSync(targetTcTemplate)) {
    const tplTc = template
      ? path.join(testingDirFor(template.rootPath), 'templates', 'testcase.md')
      : null
    const sourceTc =
      tplTc && fs.existsSync(tplTc)
        ? tplTc
        : fs.existsSync(bundledTemplateFile('testcase'))
          ? bundledTemplateFile('testcase')
          : null
    if (sourceTc) {
      fs.mkdirSync(path.dirname(targetTcTemplate), { recursive: true })
      fs.copyFileSync(sourceTc, targetTcTemplate)
      created.push('testing/templates/testcase.md')
    }
  }

  return { created, templateName: template?.name ?? null }
}

projectsRouter.get('/', (_req, res) => {
  res.json(listProjects().map((p) => ({ ...p, ...rootInfo(p.rootPath) })))
})

projectsRouter.post('/', (req, res) => {
  const { name, rootPath } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    return res.status(400).json({ error: 'rootPath is required' })
  }
  const resolved = path.resolve(rootPath.trim())
  if (!isDir(resolved)) {
    return res.status(400).json({ error: `rootPath is not a folder: ${resolved}` })
  }
  const project = createProject(name.trim(), resolved, false)
  try {
    const init = initializeProjectFolder(project)
    return res.status(201).json({ ...project, ...rootInfo(project.rootPath), ...init })
  } catch (err) {
    deleteProject(project.id)
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Project initialization failed',
    })
  }
})

// ---- Export / import (ZIP) ----
//
// A QC Portal project is a folder of QC artifacts (CLAUDE.md, .claude, .mcp.json,
// testing/). Export bundles just those into a portable .zip — never the whole repo
// (no node_modules / .git) — plus a small manifest. Import re-creates the folder
// from such a zip and registers it. The transfer is the QC setup, not source code.

/** Top-level entries bundled into a project export (when present). */
const EXPORT_ENTRIES = ['CLAUDE.md', '.claude', '.mcp.json', 'testing'] as const
/** Names never written into / read out of an archive. */
const ARCHIVE_SKIP = new Set(['.DS_Store', 'node_modules', '.git'])
/** Manifest filename at the zip root (metadata, not part of the project files). */
const EXPORT_MANIFEST = 'qc-portal.json'

/** Recursively add a file or directory to the zip under `relPath` (POSIX slashes). */
function addPathToZip(zip: JSZip, absPath: string, relPath: string): void {
  const stat = fs.statSync(absPath)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absPath)) {
      if (ARCHIVE_SKIP.has(entry)) continue
      addPathToZip(zip, path.join(absPath, entry), `${relPath}/${entry}`)
    }
  } else if (stat.isFile()) {
    zip.file(relPath, fs.readFileSync(absPath))
  }
}

/** Download a project's QC artifacts as a .zip. */
projectsRouter.get('/:id/export', async (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'project not found' })
  if (!isDir(project.rootPath)) {
    return res.status(400).json({ error: 'project folder not found on disk' })
  }

  const zip = new JSZip()
  zip.file(
    EXPORT_MANIFEST,
    JSON.stringify(
      { name: project.name, exportedAt: new Date().toISOString(), format: 1 },
      null,
      2,
    ),
  )
  for (const entry of EXPORT_ENTRIES) {
    const abs = path.join(project.rootPath, entry)
    if (fs.existsSync(abs)) addPathToZip(zip, abs, entry)
  }

  try {
    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    const safe = safeFolderName(project.name) || 'project'
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.zip"`)
    return res.send(buf)
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to build export' })
  }
})

/**
 * Create a project from an exported .zip. The body carries the chosen display
 * name, a parent folder to extract into, and the base64 zip (mirrors the skill
 * upload pattern). The project folder is `<parentPath>/<safeName>`.
 */
projectsRouter.post('/import', async (req, res) => {
  const { name, parentPath, zipBase64 } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  if (typeof parentPath !== 'string' || !parentPath.trim()) {
    return res.status(400).json({ error: 'parentPath is required' })
  }
  if (typeof zipBase64 !== 'string' || !zipBase64) {
    return res.status(400).json({ error: 'a .zip file is required' })
  }

  const parent = path.resolve(parentPath.trim())
  if (!isDir(parent)) {
    return res.status(400).json({ error: `not a folder: ${parent}` })
  }
  const safe = safeFolderName(name)
  if (!safe) return res.status(400).json({ error: 'invalid project name' })
  const dest = path.join(parent, safe)
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `a folder named "${safe}" already exists here` })
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(Buffer.from(zipBase64, 'base64'))
  } catch {
    return res.status(400).json({ error: 'could not read that .zip file' })
  }
  const files = Object.values(zip.files).filter((f) => !f.dir)
  if (files.length === 0) return res.status(400).json({ error: 'the .zip is empty' })

  try {
    fs.mkdirSync(dest, { recursive: true })
    for (const file of files) {
      const rel = file.name.replace(/\\/g, '/').replace(/^\/+/, '')
      if (rel === EXPORT_MANIFEST) continue // manifest is metadata, not a project file
      if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '')) {
        throw new Error(`invalid path in zip: ${file.name}`)
      }
      const target = path.resolve(dest, rel)
      if (target !== dest && !target.startsWith(dest + path.sep)) {
        throw new Error(`path escapes project folder: ${file.name}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, await file.async('nodebuffer'))
    }
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true }) // roll back a partial extract
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to extract the zip' })
  }

  const project = createProject(name.trim(), dest, false)
  return res.status(201).json({ ...project, ...rootInfo(project.rootPath) })
})

projectsRouter.put('/:id', (req, res) => {
  const existing = getProject(req.params.id)
  if (!existing) return res.status(404).json({ error: 'project not found' })

  const {
    name,
    rootPath,
    description,
    diagram,
    pinned,
    groundingCheck,
    groundingCheckModel,
    autoLearn,
    autoLearnModel,
    defaultSkill,
  } = req.body ?? {}
  const partial: {
    name?: string
    rootPath?: string
    description?: string
    diagram?: string
    pinned?: boolean
    groundingCheck?: boolean
    groundingCheckModel?: string
    autoLearn?: boolean
    autoLearnModel?: string
    defaultSkill?: string
  } = {}
  if (typeof name === 'string' && name.trim()) partial.name = name.trim()
  if (typeof pinned === 'boolean') partial.pinned = pinned
  // Per-project AI post-step settings. Models are validated against the known aliases.
  const KNOWN_MODELS = new Set(['haiku', 'sonnet', 'opus'])
  if (typeof groundingCheck === 'boolean') partial.groundingCheck = groundingCheck
  if (typeof groundingCheckModel === 'string' && KNOWN_MODELS.has(groundingCheckModel)) {
    partial.groundingCheckModel = groundingCheckModel
  }
  if (typeof autoLearn === 'boolean') partial.autoLearn = autoLearn
  if (typeof autoLearnModel === 'string' && KNOWN_MODELS.has(autoLearnModel)) {
    partial.autoLearnModel = autoLearnModel
  }
  // Default QC skill — empty string clears it. The skill folder is validated on the
  // Skills page (it can only be set from a real skill); we just persist the name.
  if (typeof defaultSkill === 'string') partial.defaultSkill = defaultSkill.trim()
  if (typeof rootPath === 'string' && rootPath.trim()) {
    const resolved = path.resolve(rootPath.trim())
    if (!isDir(resolved)) {
      return res.status(400).json({ error: `rootPath is not a folder: ${resolved}` })
    }
    partial.rootPath = resolved
  }
  // Allow empty string so the user can clear the intro / diagram.
  if (typeof description === 'string') partial.description = description
  if (typeof diagram === 'string') partial.diagram = diagram

  // Renaming the project renames its folder on disk to match. Only fires when the
  // NAME actually changed (so editing the description/path alone never moves it).
  // The folder is moved within its own parent. Guarded: skip if the folder is
  // missing or already matches; 409 if a folder with the new name already exists.
  if (partial.name && partial.name !== existing.name) {
    const source = partial.rootPath ?? existing.rootPath
    const safe = safeFolderName(partial.name)
    if (safe && isDir(source)) {
      const target = path.join(path.dirname(source), safe)
      if (path.resolve(target) !== path.resolve(source)) {
        // Refuse to move the folder out from under an active run/job.
        const busy = projectBusyReason(req.params.id)
        if (busy) {
          return res.status(423).json({
            error: `Can't rename the folder while ${busy}. Stop it and try again.`,
          })
        }
        if (fs.existsSync(target)) {
          return res.status(409).json({ error: `a folder named "${safe}" already exists here` })
        }
        try {
          fs.renameSync(source, target)
        } catch (err) {
          return res.status(500).json({
            error: `could not rename folder: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          })
        }
        partial.rootPath = target
      }
    }
  }

  updateProject(req.params.id, partial)
  const updated = getProject(req.params.id)!
  return res.json({ ...updated, ...rootInfo(updated.rootPath) })
})

/**
 * Initialize a project folder for Claude Code: create CLAUDE.md, .claude/skills,
 * and .mcp.json by cloning them from a template project that already has them
 * (e.g. the default project). Only fills in what is missing — never overwrites.
 */
projectsRouter.post('/:id/init', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'project not found' })

  const root = project.rootPath

  try {
    const init = initializeProjectFolder(project)
    return res.json({
      ...project,
      ...rootInfo(root),
      ...init,
    })
  } catch (err) {
    return res
      .status(isDir(root) ? 500 : 400)
      .json({ error: err instanceof Error ? err.message : 'Failed to initialize project' })
  }
})

// The project's root CLAUDE.md — the Claude Code guidance the qc-testing skill and
// every headless run read. Editable from the Settings page next to file templates.
const MAX_CLAUDE_MD_BYTES = 1024 * 1024 // 1 MB — guidance, not an asset.

/** GET /api/projects/:id/claude-md — read the project's root CLAUDE.md. */
projectsRouter.get('/:id/claude-md', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'project not found' })
  const file = path.join(project.rootPath, 'CLAUDE.md')
  try {
    const content = fs.readFileSync(file, 'utf8')
    const stat = fs.statSync(file)
    return res.json({ content, exists: true, savedAt: stat.mtime.toISOString(), size: stat.size })
  } catch {
    return res.json({ content: '', exists: false, savedAt: null, size: 0 })
  }
})

/** PUT /api/projects/:id/claude-md — create or overwrite the project's CLAUDE.md. */
projectsRouter.put('/:id/claude-md', (req, res) => {
  const project = getProject(req.params.id)
  if (!project) return res.status(404).json({ error: 'project not found' })
  if (!isDir(project.rootPath)) {
    return res.status(400).json({ error: `folder not found: ${project.rootPath}` })
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (Buffer.byteLength(content, 'utf8') > MAX_CLAUDE_MD_BYTES) {
    return res.status(413).json({ error: 'CLAUDE.md too large (1 MB max)' })
  }
  const file = path.join(project.rootPath, 'CLAUDE.md')
  fs.writeFileSync(file, content, 'utf8')
  const stat = fs.statSync(file)
  return res.json({ content, exists: true, savedAt: stat.mtime.toISOString(), size: stat.size })
})

projectsRouter.delete('/:id', (req, res) => {
  const existing = getProject(req.params.id)
  if (!existing) return res.status(404).json({ error: 'project not found' })
  deleteProject(req.params.id)
  return res.json({ ok: true })
})
