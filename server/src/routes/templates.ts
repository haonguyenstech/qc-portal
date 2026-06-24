import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'

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
  res.json({ ok: true })
})
