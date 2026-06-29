import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { syncContextPointer } from '../contextPointer.js'
import {
  deleteNote,
  listNotes,
  memoryDir,
  memoryFile,
  parseNote,
  safeNoteName,
  writeNote,
} from '../memoryStore.js'

export const memoryRouter = Router()

// Project memory: small markdown notes — one durable fact each (decisions, gotchas,
// conventions). Authored here directly (unlike Knowledge, which is uploaded + converted)
// and also written automatically by the AI auto-capture step after runs (see learn.ts).
// Storage primitives live in memoryStore.ts; this router is the editor surface.

/** GET /api/memory — list every stored note (name, description, source, size, savedAt). */
memoryRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(listNotes(project.rootPath))
})

/** GET /api/memory/:name — one note's description + markdown body (for the editor). */
memoryRouter.get('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const target = memoryFile(project.rootPath, req.params.name)
  if (!target) return res.status(400).json({ error: 'invalid note name' })
  try {
    const raw = fs.readFileSync(target, 'utf8')
    const stat = fs.statSync(target)
    const { description, source, body } = parseNote(raw)
    res.json({
      name: req.params.name,
      description,
      source,
      content: body,
      size: stat.size,
      savedAt: stat.mtime.toISOString(),
    })
  } catch {
    res.status(404).json({ error: 'note not found' })
  }
})

/**
 * PUT /api/memory/:name — create or overwrite a fact note. Body: { description, content }.
 * A manual save drops any AI `source` tag — once a human edits it, the note is theirs.
 */
memoryRouter.put('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const safe = safeNoteName(req.params.name)
  if (!safe) return res.status(400).json({ error: 'invalid note name' })
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  const description = typeof req.body?.description === 'string' ? req.body.description : ''
  if (!content.trim()) return res.status(400).json({ error: 'note is empty' })
  const result = writeNote({ rootPath: project.rootPath, name: safe, description, body: content })
  if (!result) return res.status(413).json({ error: 'note too large (64 KB max — keep facts small)' })
  syncContextPointer(project.rootPath)
  res.json({ ...result, source: '' })
})

/** DELETE /api/memory/:name — remove a fact note. */
memoryRouter.delete('/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!memoryFile(project.rootPath, req.params.name)) {
    return res.status(400).json({ error: 'invalid note name' })
  }
  deleteNote(project.rootPath, req.params.name)
  syncContextPointer(project.rootPath)
  res.json({ ok: true })
})

/**
 * POST /api/memory/open — reveal the project's testing/memory folder in the OS file
 * explorer on the machine running the server. Creates it first if missing.
 */
memoryRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = memoryDir(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create memory folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})
