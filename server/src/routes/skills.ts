import { Router } from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skillsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { pickFolderNative, revealFolderNative } from '../folderPicker.js'
import type { SkillFile, SkillSummary } from '../types.js'

export const skillsRouter = Router()

/** Resolve the active project's skills dir, or null if the project is unknown. */
function skillsDir(req: Parameters<typeof resolveProject>[0]): string | null {
  const project = resolveProject(req)
  return project ? skillsDirFor(project.rootPath) : null
}

/** Pull `description:` out of a SKILL.md YAML frontmatter block. */
function parseDescription(md: string): string {
  const lines = md.split('\n')
  if (lines[0]?.trim() !== '---') return ''
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '---') break
    const m = /^description:\s*(.*)$/.exec(line)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/** Render a string as a YAML scalar, quoting only when needed so it round-trips. */
function yamlScalar(value: string): string {
  const s = value.replace(/[\r\n]+/g, ' ').trim()
  if (s === '') return '""'
  // Quote when the value could be mis-parsed by a YAML loader.
  if (/^[!&*?{}[\],#|>@`"']/.test(s) || /:\s/.test(s) || /\s#/.test(s) || /[:#]$/.test(s)) {
    return `"${s.replace(/"/g, '\\"')}"`
  }
  return s
}

/**
 * Update (or insert) keys inside a SKILL.md YAML frontmatter block, preserving the
 * rest of the file. Creates a frontmatter block at the top if the file has none.
 */
function updateFrontmatter(md: string, fields: Record<string, string>): string {
  const lines = md.split('\n')
  const block = (extra: Record<string, string>) =>
    ['---', ...Object.entries(extra).map(([k, v]) => `${k}: ${yamlScalar(v)}`), '---', '']

  if (lines[0]?.trim() !== '---') return block(fields).join('\n') + md

  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return block(fields).join('\n') + md // malformed — prepend a fresh block

  const remaining = { ...fields }
  for (let i = 1; i < end; i++) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(lines[i])
    if (m && m[1] in remaining) {
      lines[i] = `${m[1]}: ${yamlScalar(remaining[m[1]])}`
      delete remaining[m[1]]
    }
  }
  const toInsert = Object.entries(remaining).map(([k, v]) => `${k}: ${yamlScalar(v)}`)
  if (toInsert.length) lines.splice(end, 0, ...toInsert)
  return lines.join('\n')
}

function listSkillFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Guard: resolve a file inside a skill folder, only .md, no traversal. */
function safeSkillFile(baseDir: string, name: string, file: string): string | null {
  if (!file.endsWith('.md')) return null
  const skillDir = path.resolve(baseDir, name)
  const target = path.resolve(skillDir, file)
  if (target !== skillDir && !target.startsWith(skillDir + path.sep)) return null
  return target
}

skillsRouter.get('/', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true })
  } catch {
    return res.json([])
  }

  const summaries: SkillSummary[] = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(baseDir, e.name)
      let md = ''
      try {
        md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
      } catch {
        /* no SKILL.md */
      }
      return { name: e.name, description: parseDescription(md), files: listSkillFiles(dir) }
    })

  return res.json(summaries)
})

skillsRouter.get('/:name', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const dir = path.resolve(baseDir, req.params.name)
  if (!dir.startsWith(path.resolve(baseDir) + path.sep)) {
    return res.status(400).json({ error: 'invalid skill name' })
  }
  let names: string[]
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
  } catch {
    return res.status(404).json({ error: 'skill not found' })
  }

  const files: SkillFile[] = names.map((fileName) => ({
    name: fileName,
    content: fs.readFileSync(path.join(dir, fileName), 'utf8'),
  }))
  return res.json(files)
})

skillsRouter.put('/:name/:file', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const { content } = req.body ?? {}
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' })
  }
  const target = safeSkillFile(baseDir, req.params.name, req.params.file)
  if (!target) return res.status(400).json({ error: 'invalid file path' })
  if (!fs.existsSync(path.dirname(target))) {
    return res.status(404).json({ error: 'skill not found' })
  }
  fs.writeFileSync(target, content, 'utf8')
  return res.json({ ok: true })
})

/**
 * Edit a skill's name and/or description. Renaming moves the skill folder and
 * keeps the SKILL.md frontmatter `name:` in sync; the description is written into
 * the frontmatter. Returns the updated summary.
 */
skillsRouter.patch('/:name', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const current = req.params.name
  const dir = path.resolve(baseDir, current)
  if (dir !== path.resolve(baseDir) && !dir.startsWith(path.resolve(baseDir) + path.sep)) {
    return res.status(400).json({ error: 'invalid skill name' })
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: 'skill not found' })
  }

  const { name: rawName, description } = req.body ?? {}
  const hasDescription = typeof description === 'string'

  // Resolve & validate the target name (defaults to unchanged).
  let newName = current
  if (typeof rawName === 'string' && rawName.trim() && rawName.trim() !== current) {
    newName = rawName.trim()
    if (newName.includes('/') || newName.includes('\\') || newName.includes('..')) {
      return res.status(400).json({ error: 'invalid name' })
    }
    const newDir = path.resolve(baseDir, newName)
    if (newDir !== path.resolve(baseDir) && !newDir.startsWith(path.resolve(baseDir) + path.sep)) {
      return res.status(400).json({ error: 'invalid name' })
    }
    if (fs.existsSync(newDir)) {
      return res.status(409).json({ error: `a skill named "${newName}" already exists` })
    }
  }

  // Update frontmatter in place (folder still at the old path), then rename.
  const skillMd = path.join(dir, 'SKILL.md')
  if (fs.existsSync(skillMd) && (newName !== current || hasDescription)) {
    const md = fs.readFileSync(skillMd, 'utf8')
    const next = updateFrontmatter(md, {
      name: newName,
      ...(hasDescription ? { description } : {}),
    })
    fs.writeFileSync(skillMd, next, 'utf8')
  }

  let finalName = current
  if (newName !== current) {
    try {
      fs.renameSync(dir, path.resolve(baseDir, newName))
      finalName = newName
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'failed to rename skill' })
    }
  }

  const finalDir = path.resolve(baseDir, finalName)
  let md = ''
  try {
    md = fs.readFileSync(path.join(finalDir, 'SKILL.md'), 'utf8')
  } catch {
    /* ignore */
  }
  const summary: SkillSummary = {
    name: finalName,
    description: parseDescription(md),
    files: listSkillFiles(finalDir).filter((f) => f.endsWith('.md')),
  }
  return res.json(summary)
})

/** Delete a skill — removes its folder (and everything in it) from .claude/skills. */
skillsRouter.delete('/:name', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const dir = path.resolve(baseDir, req.params.name)
  // Guard: must be a direct child of the skills dir — never the dir itself or outside it.
  if (!dir.startsWith(path.resolve(baseDir) + path.sep)) {
    return res.status(400).json({ error: 'invalid skill name' })
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return res.status(404).json({ error: 'skill not found' })
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to delete skill' })
  }
  return res.json({ ok: true })
})

/**
 * Reveal the active project's .claude/skills directory in the OS file explorer
 * on the machine running the server. Creates the folder first if it doesn't
 * exist yet, so a brand-new project still opens cleanly.
 */
skillsRouter.post('/open', async (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  try {
    fs.mkdirSync(baseDir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create skills folder' })
  }

  const result = await revealFolderNative(baseDir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: baseDir })
})

/**
 * Import an existing skill folder from the user's device. Opens the native
 * folder picker on the machine running the server, then copies the chosen
 * folder into the active project's .claude/skills directory.
 */
skillsRouter.post('/import', async (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  // Open the dialog somewhere useful so the user doesn't have to dig through
  // hidden .claude folders. Prefer the global skills dir, then the project's own.
  const home = os.homedir()
  const startCandidates = [
    path.join(home, '.claude', 'skills'),
    baseDir,
    path.join(home, '.claude'),
    home,
  ]
  const startAt = startCandidates.find((p) => fs.existsSync(p))

  const picked = await pickFolderNative('Select a skill folder to import', startAt)
  if (picked.error) return res.status(500).json({ error: picked.error })
  if (!picked.path) return res.json({ canceled: true })

  const source = path.resolve(picked.path)
  let stat: fs.Stats
  try {
    stat = fs.statSync(source)
  } catch {
    return res.status(400).json({ error: 'selected folder no longer exists' })
  }
  if (!stat.isDirectory()) {
    return res.status(400).json({ error: 'please select a folder, not a file' })
  }
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    return res
      .status(400)
      .json({ error: 'that folder has no SKILL.md — it is not a skill folder' })
  }

  const name = path.basename(source)
  if (!name || name.includes('..')) {
    return res.status(400).json({ error: 'invalid skill folder name' })
  }
  const dest = path.resolve(baseDir, name)

  // Guard against importing a folder onto itself.
  if (dest === source) {
    return res.status(400).json({ error: 'this skill is already in the project' })
  }
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `a skill named "${name}" already exists` })
  }

  fs.mkdirSync(baseDir, { recursive: true })
  try {
    fs.cpSync(source, dest, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to copy skill folder' })
  }

  let md = ''
  try {
    md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')
  } catch {
    /* ignore */
  }
  const summary: SkillSummary = {
    name,
    description: parseDescription(md),
    files: listSkillFiles(dest).filter((f) => f.endsWith('.md')),
  }
  return res.status(201).json(summary)
})

/**
 * Receive a skill folder uploaded via drag-and-drop. The browser can't expose
 * absolute paths for dropped folders, so the client reads each file and sends
 * its relative path + base64 content here; we write them under .claude/skills.
 */
skillsRouter.post('/upload', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const { name, files } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return res.status(400).json({ error: 'invalid skill name' })
  }
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'no files were dropped' })
  }
  if (files.length > 500) {
    return res.status(400).json({ error: 'too many files (max 500)' })
  }

  // Normalise + validate every relative path before writing anything.
  type Entry = { rel: string; content: string }
  const entries: Entry[] = []
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      return res.status(400).json({ error: 'malformed file entry' })
    }
    const rel = f.path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel || rel.split('/').some((seg: string) => seg === '..' || seg === '')) {
      return res.status(400).json({ error: `invalid file path: ${f.path}` })
    }
    entries.push({ rel, content: f.content })
  }

  const hasSkillMd = entries.some((e) => e.rel === 'SKILL.md')
  if (!hasSkillMd) {
    return res
      .status(400)
      .json({ error: 'that folder has no SKILL.md at its root — it is not a skill folder' })
  }

  const dest = path.resolve(baseDir, name)
  if (dest !== path.resolve(baseDir) && !dest.startsWith(path.resolve(baseDir) + path.sep)) {
    return res.status(400).json({ error: 'invalid skill name' })
  }
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `a skill named "${name}" already exists` })
  }

  try {
    for (const e of entries) {
      const target = path.resolve(dest, e.rel)
      // Final traversal guard per file.
      if (target !== dest && !target.startsWith(dest + path.sep)) {
        throw new Error(`path escapes skill folder: ${e.rel}`)
      }
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(e.content, 'base64'))
    }
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true }) // roll back a partial copy
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to write skill files' })
  }

  let md = ''
  try {
    md = fs.readFileSync(path.join(dest, 'SKILL.md'), 'utf8')
  } catch {
    /* ignore */
  }
  const summary: SkillSummary = {
    name,
    description: parseDescription(md),
    files: listSkillFiles(dest).filter((f) => f.endsWith('.md')),
  }
  return res.status(201).json(summary)
})

skillsRouter.post('/', (req, res) => {
  const baseDir = skillsDir(req)
  if (!baseDir) return res.status(400).json({ error: 'project not found' })

  const { name, description } = req.body ?? {}
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' })
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return res.status(400).json({ error: 'invalid name' })
  }
  const dir = path.resolve(baseDir, name)
  if (fs.existsSync(dir)) {
    return res.status(400).json({ error: 'skill already exists' })
  }
  fs.mkdirSync(dir, { recursive: true })
  const desc = typeof description === 'string' ? description : ''
  const skeleton = `---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n`
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skeleton, 'utf8')

  const summary: SkillSummary = { name, description: desc, files: ['SKILL.md'] }
  return res.status(201).json(summary)
})
