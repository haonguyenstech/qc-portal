import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { reviewMarkdown } from '../docReview.js'
import { syncContextPointer } from '../contextPointer.js'
import {
  listOverviewDocs,
  overviewDocFile,
  overviewDocsDir,
  readOverviewDoc,
  writeOverviewDoc,
} from '../overviewDocs.js'

export const overviewDocsRouter = Router()

// Overview documents — the source files behind the project intro, ONE FILE PER
// UPLOAD under <root>/testing/overview/<name>.md. The browser converts each upload
// to Markdown (web/src/lib/docConvert.ts) and PUTs it here under its own name, so a
// multi-file upload stays several documents instead of one merged blob and each can
// be reviewed, previewed and deleted on its own.
//
// Uploading a document is all it takes for the AI to have it: projectContext.ts packs
// these files into the injected context block, and syncContextPointer() adds a CLAUDE.md
// bullet pointing at the folder for in-project runs. Hence the pointer re-sync on every
// write and delete below.

/** GET /api/overview-docs — metadata for every stored document. */
overviewDocsRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(listOverviewDocs(project.rootPath))
})

/**
 * POST /api/overview-docs/open — reveal testing/overview in the OS file explorer on
 * the machine running the server. Declared before the /:name routes it can't collide
 * with anyway (different methods), and creates the folder so a new project opens clean.
 */
overviewDocsRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = overviewDocsDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'failed to create overview folder',
    })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})

/** GET /api/overview-docs/:name — one document's full Markdown (preview/edit). */
overviewDocsRouter.get('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = overviewDocFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid document name' })
  const content = readOverviewDoc(project.rootPath, req.params.name)
  if (content == null) return res.status(404).json({ error: 'document not found' })
  const stat = fs.statSync(target)
  res.json({
    name: req.params.name,
    content,
    size: stat.size,
    savedAt: stat.mtime.toISOString(),
  })
})

/** PUT /api/overview-docs/:name — create or overwrite one document. */
overviewDocsRouter.put('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (!content.trim()) return res.status(400).json({ error: 'document is empty' })
  const result = writeOverviewDoc({
    rootPath: project.rootPath,
    name: req.params.name,
    content,
  })
  if (!result)
    return res.status(400).json({ error: 'invalid document name or too large (5 MB max)' })
  syncContextPointer(project.rootPath) // first upload adds the CLAUDE.md bullet
  res.json(result)
})

/**
 * POST /api/overview-docs/:name/review — AI review & format THIS document in place.
 * Same copy-editor pass as the intro's review (docReview.ts): formatting only, no
 * facts added. The pre-review Markdown comes back as `before` so the UI can offer an
 * undo — the model's output has just overwritten the engineer's file.
 */
overviewDocsRouter.post('/:name/review', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const before = readOverviewDoc(project.rootPath, req.params.name)
  if (before == null) return res.status(404).json({ error: 'document not found' })

  const outcome = await reviewMarkdown({
    content: before,
    projectName: project.name,
    label: `the overview document "${req.params.name}"`,
    cwd: project.rootPath,
  })
  if (!outcome.ok) return res.status(outcome.status).json({ error: outcome.error })

  // Nothing changed → don't rewrite the file (keeps savedAt honest, so the list
  // doesn't reorder itself for a no-op review).
  if (!outcome.changed) {
    return res.json({
      name: req.params.name,
      changed: false,
      before,
      content: before,
    })
  }
  const result = writeOverviewDoc({
    rootPath: project.rootPath,
    name: req.params.name,
    content: outcome.text,
  })
  if (!result) return res.status(500).json({ error: 'failed to save the reviewed document' })
  res.json({ ...result, changed: true, before, content: outcome.text })
})

/** DELETE /api/overview-docs/:name — remove one document. */
overviewDocsRouter.delete('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = overviewDocFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid document name' })
  try {
    fs.rmSync(target)
  } catch {
    /* already gone */
  }
  syncContextPointer(project.rootPath) // last one deleted strips the CLAUDE.md bullet
  res.json({ ok: true })
})
