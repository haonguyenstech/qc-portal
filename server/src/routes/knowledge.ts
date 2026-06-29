import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { syncContextPointer } from '../contextPointer.js'
import { docSource, knowledgeDir, knowledgeFile, listDocs, writeDoc } from '../knowledgeStore.js'

export const knowledgeRouter = Router()

// Project knowledge base: documents (Docs/PDF/Markdown/Excel) the QC engineer
// uploads to supplement the project's AI knowledge. The browser converts every
// upload to Markdown (see web/src/lib/docConvert.ts) and posts the text here;
// we store it under <root>/testing/knowledge/<name>.md so every headless Claude
// run in the project dir (QC, test-case gen, design check) can read it. The AI
// auto-capture step (learn.ts) also writes longer reference write-ups here.
//
// Storage primitives live in knowledgeStore.ts; this router is the upload surface.

/** GET /api/knowledge — list every stored doc (name, source, size, savedAt) — metadata only. */
knowledgeRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(listDocs(project.rootPath))
})

/** GET /api/knowledge/:name — full Markdown of one doc (for the preview dialog). */
knowledgeRouter.get('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = knowledgeFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid document name' })
  try {
    const content = fs.readFileSync(target, 'utf8')
    const stat = fs.statSync(target)
    res.json({
      name: req.params.name,
      content,
      source: docSource(content),
      size: stat.size,
      savedAt: stat.mtime.toISOString(),
    })
  } catch {
    res.status(404).json({ error: 'document not found' })
  }
})

/** PUT /api/knowledge/:name — create or overwrite a doc's converted Markdown. */
knowledgeRouter.put('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!knowledgeFile(project.rootPath, req.params.name)) {
    return res.status(400).json({ error: 'invalid document name' })
  }
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (!content.trim()) return res.status(400).json({ error: 'document is empty' })
  // A manual upload/save drops any AI provenance marker — the doc becomes the user's.
  const result = writeDoc({ rootPath: project.rootPath, name: req.params.name, content })
  if (!result) return res.status(413).json({ error: 'document too large (5 MB of text max)' })
  syncContextPointer(project.rootPath)
  res.json({ ...result, source: '' })
})

/** DELETE /api/knowledge/:name — remove a stored doc. */
knowledgeRouter.delete('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = knowledgeFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid document name' })
  try {
    fs.rmSync(target)
  } catch {
    /* already gone */
  }
  syncContextPointer(project.rootPath)
  res.json({ ok: true })
})

/**
 * POST /api/knowledge/open — reveal the project's testing/knowledge folder in the
 * OS file explorer on the machine running the server. Creates it first if missing.
 */
knowledgeRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = knowledgeDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create knowledge folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})
