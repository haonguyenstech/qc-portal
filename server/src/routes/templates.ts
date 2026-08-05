import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_TEMPLATES_DIR, bundledTemplateFile, testingDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { clearTemplateInstallHash } from '../db.js'
import { markTemplateRemoved, recordTemplateInstall } from '../templateSync.js'

export const templatesRouter = Router()

// Project-scoped reusable file templates (e.g. a test-case template), stored as
// plain text under <root>/testing/templates/<key>.md so they're versionable with
// the project and readable by the qc-testing skill. The key is the template kind
// (the UI owns the catalog of kinds); we just guard it and persist the content.

const KEY_RE = /^[a-z0-9-]{1,40}$/
const MAX_BYTES = 200 * 1024 // 200 KB — templates are prompts, not assets.

function templatesDir(root: string): string {
  return path.join(testingDirFor(root), 'templates')
}

/** Resolve <templatesDir>/<key>.md, refusing keys that could escape the folder. */
function templateFile(root: string, key: string): string | null {
  if (!KEY_RE.test(key)) return null
  const dir = templatesDir(root)
  const target = path.resolve(dir, `${key}.md`)
  if (target !== path.join(dir, `${key}.md`)) return null
  return target
}

/** GET /api/templates — list every stored template (key, content, size, savedAt). */
templatesRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = templatesDir(project.rootPath)
  try {
    const out = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => {
        const full = path.join(dir, d.name)
        const stat = fs.statSync(full)
        return {
          key: d.name.replace(/\.md$/, ''),
          content: fs.readFileSync(full, 'utf8'),
          size: stat.size,
          savedAt: stat.mtime.toISOString(),
        }
      })
    res.json(out)
  } catch {
    res.json([]) // no templates dir yet
  }
})

/**
 * GET /api/templates/defaults — which template kinds the portal ships a default for
 * (templates/project-templates/<key>.md), so the UI knows when it can offer "Reset to
 * default". Portal-wide, not project-scoped.
 */
templatesRouter.get('/defaults', (_req, res) => {
  try {
    const keys = fs
      .readdirSync(BUNDLED_TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name.replace(/\.md$/, ''))
      .filter((key) => KEY_RE.test(key))
      .sort()
    res.json({ keys })
  } catch {
    res.json({ keys: [] }) // no bundled defaults shipped
  }
})

/**
 * POST /api/templates/open — reveal the project's testing/templates folder in the
 * OS file explorer on the machine running the server. Creates it first if missing.
 */
templatesRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = templatesDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create templates folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/** PUT /api/templates/:key — create or overwrite a template's content. */
templatesRouter.put('/:key', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = templateFile(project.rootPath, req.params.key)
  if (!target) return res.status(400).json({ error: 'invalid template key' })
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) {
    return res.status(413).json({ error: 'template too large (200 KB max)' })
  }
  fs.mkdirSync(templatesDir(project.rootPath), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  // Hand-edited/uploaded: drop any portal fingerprint so a portal update can't
  // overwrite it (templateSync.ts then reports it `customized`). Content that
  // happens to equal the bundled default is `in-sync` either way.
  clearTemplateInstallHash(project.id, req.params.key)
  const stat = fs.statSync(target)
  res.json({
    key: req.params.key,
    content,
    size: stat.size,
    savedAt: stat.mtime.toISOString(),
  })
})

/**
 * POST /api/templates/:key/reset — overwrite the project's template with the default
 * bundled with the portal (templates/project-templates/<key>.md), the same file a new
 * project is seeded with. 404 when this kind has no bundled default.
 */
templatesRouter.post('/:key/reset', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = templateFile(project.rootPath, req.params.key)
  if (!target) return res.status(400).json({ error: 'invalid template key' })
  const source = bundledTemplateFile(req.params.key)
  let content: string
  try {
    content = fs.readFileSync(source, 'utf8')
  } catch {
    return res
      .status(404)
      .json({ error: `the portal ships no default "${req.params.key}" template` })
  }
  fs.mkdirSync(templatesDir(project.rootPath), { recursive: true })
  fs.writeFileSync(target, content, 'utf8')
  // Back to the portal's default → fingerprint it, so future portal updates keep
  // this copy current on their own (templateSync.ts).
  recordTemplateInstall(project, req.params.key)
  const stat = fs.statSync(target)
  res.json({
    key: req.params.key,
    content,
    size: stat.size,
    savedAt: stat.mtime.toISOString(),
  })
})

/** DELETE /api/templates/:key — remove a stored template. */
templatesRouter.delete('/:key', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = templateFile(project.rootPath, req.params.key)
  if (!target) return res.status(400).json({ error: 'invalid template key' })
  try {
    fs.rmSync(target)
  } catch {
    /* already gone */
  }
  // Deleted on purpose — remember that, or the next boot's reconcile would helpfully
  // re-seed the bundled default (templateSync.ts).
  markTemplateRemoved(project.id, req.params.key)
  res.json({ ok: true })
})
