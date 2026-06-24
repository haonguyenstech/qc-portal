import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  listRuns,
  updateProject,
} from '../db.js'
import { mcpJsonFor, skillsDirFor } from '../config.js'
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

/** Minimal CLAUDE.md used when no template project is available. */
function starterClaudeMd(name: string): string {
  return `# ${name}

Project guidance for Claude Code.

## Overview

Describe what this project is and how it is structured.

## Conventions

- Add coding conventions, commands, and gotchas here so Claude follows them.
`
}

const skipDsStore = (src: string) => !src.endsWith('.DS_Store')

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
  return res.status(201).json({ ...project, ...rootInfo(project.rootPath) })
})

projectsRouter.put('/:id', (req, res) => {
  const existing = getProject(req.params.id)
  if (!existing) return res.status(404).json({ error: 'project not found' })

  const { name, rootPath, description, diagram, pinned } = req.body ?? {}
  const partial: {
    name?: string
    rootPath?: string
    description?: string
    diagram?: string
    pinned?: boolean
  } = {}
  if (typeof name === 'string' && name.trim()) partial.name = name.trim()
  if (typeof pinned === 'boolean') partial.pinned = pinned
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
  if (!isDir(root)) {
    return res.status(400).json({ error: `folder not found: ${root}` })
  }

  const template = findTemplateProject(project.id)
  const created: string[] = []

  try {
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

    // 2. .claude/skills/ — only scaffold the `qc-testing` skill, never the
    // template's other skills. We copy just that one subfolder (if the template
    // has it) so a fresh project starts with the QC brain and nothing else.
    const targetSkills = skillsDirFor(root)
    if (!isDir(targetSkills)) {
      fs.mkdirSync(targetSkills, { recursive: true })
      const tplQcSkill = template ? path.join(skillsDirFor(template.rootPath), QC_SKILL) : null
      if (tplQcSkill && isDir(tplQcSkill)) {
        fs.cpSync(tplQcSkill, path.join(targetSkills, QC_SKILL), {
          recursive: true,
          filter: skipDsStore,
        })
      }
      created.push('.claude/skills')
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
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'Failed to initialize project' })
  }

  return res.json({
    ...project,
    ...rootInfo(root),
    created,
    templateName: template?.name ?? null,
  })
})

projectsRouter.delete('/:id', (req, res) => {
  const existing = getProject(req.params.id)
  if (!existing) return res.status(404).json({ error: 'project not found' })
  deleteProject(req.params.id)
  return res.json({ ok: true })
})
