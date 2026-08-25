import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { syncContextPointer } from '../contextPointer.js'
import { docSource, knowledgeDir, knowledgeFile, listDocs, writeDoc } from '../knowledgeStore.js'
import {
  deleteDocAssets,
  knowledgeAssetDir,
  knowledgeDocFromImage,
  KNOWLEDGE_IMAGE_EXT,
} from '../knowledgeImages.js'
import path from 'node:path'

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

/**
 * GET /api/knowledge/assets/:file — serve an image stored beside the docs, so a doc
 * generated from a diagram can render `![](assets/…)` in the preview. Read-only, and
 * the name is matched against a strict pattern before it touches the filesystem.
 */
knowledgeRouter.get('/assets/:file', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const file = req.params.file
  if (!/^[\w.-]{1,160}\.(png|jpe?g|webp|gif)$/i.test(file) || file.includes('..')) {
    return res.status(400).json({ error: 'invalid asset name' })
  }
  const dir = knowledgeAssetDir(project.rootPath)
  const abs = path.resolve(dir, file)
  if (abs !== path.join(dir, file)) return res.status(400).json({ error: 'invalid asset name' })
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'asset not found' })
  res.sendFile(abs)
})

/**
 * POST /api/knowledge/from-image — the ONE upload the browser cannot convert itself.
 * A diagram/screenshot has no text to extract, so the image is stored under
 * testing/knowledge/assets/ and a vision pass writes the Markdown doc that describes
 * it (knowledgeImages.ts). Body: { projectId, name, fileName, mime, data (base64),
 * instructions?, projectName? }.
 */
knowledgeRouter.post('/from-image', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const mime = typeof req.body?.mime === 'string' ? req.body.mime : ''
  if (!KNOWLEDGE_IMAGE_EXT[mime]) {
    return res.status(415).json({ error: 'Only PNG, JPEG, WebP and GIF images can be read.' })
  }
  const data = typeof req.body?.data === 'string' ? req.body.data : ''
  if (!data) return res.status(400).json({ error: 'data is required' })
  const fileName =
    typeof req.body?.fileName === 'string' && req.body.fileName.trim()
      ? req.body.fileName.trim().slice(0, 200)
      : 'image'
  const docName =
    typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : fileName

  // A dropped browser tab must not leave a vision pass burning tokens for nobody.
  const controller = new AbortController()
  req.on('aborted', () => controller.abort())

  const result = await knowledgeDocFromImage({
    rootPath: project.rootPath,
    projectName:
      typeof req.body?.projectName === 'string' && req.body.projectName.trim()
        ? req.body.projectName.trim()
        : project.name || 'this project',
    docName,
    fileName,
    mime,
    base64: data,
    instructions: typeof req.body?.instructions === 'string' ? req.body.instructions : undefined,
    signal: controller.signal,
  })
  if (!result.ok) {
    if (controller.signal.aborted) return
    return res.status(result.status).json({ error: result.error })
  }
  syncContextPointer(project.rootPath)
  res.status(201).json({ ...result.doc, source: `ai · image`, asset: result.asset })
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
    // Take the doc's own images with it — otherwise every deleted diagram leaves its
    // picture behind in the engineer's repo with nothing pointing at it.
    deleteDocAssets(project.rootPath, fs.readFileSync(target, 'utf8'))
  } catch {
    /* unreadable or already gone — deleting the doc still has to work */
  }
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
