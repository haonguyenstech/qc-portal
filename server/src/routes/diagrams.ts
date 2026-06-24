import { Router } from 'express'
import { resolveProject } from '../projectScope.js'
import {
  createDiagram,
  deleteDiagram,
  getDiagram,
  listDiagrams,
  updateDiagram,
} from '../db.js'
import { writeDiagramFiles } from '../diagramFiles.js'

export const diagramsRouter = Router()

const MAX_NAME = 120
const MAX_CONTENT = 100_000 // mermaid source is small; guard against accidental dumps

function fail(res: import('express').Response, err: unknown) {
  const status = (err as { status?: number }).status ?? 500
  res.status(status).json({ error: (err as Error).message })
}

/** List a project's saved diagrams (oldest first). */
diagramsRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const diagrams = listDiagrams(project.id)
  // Materialize any not-yet-written files (e.g. diagrams migrated from the legacy
  // single column) without pruning — non-destructive on read.
  writeDiagramFiles(project.rootPath, diagrams, { prune: false })
  res.json({ diagrams })
})

/** Create a new named diagram. Body: { projectId, name, content }. */
diagramsRouter.post('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  if (!name) return res.status(400).json({ error: 'name is required' })
  if (name.length > MAX_NAME) return res.status(400).json({ error: 'name is too long' })
  if (content.length > MAX_CONTENT) return res.status(400).json({ error: 'content is too large' })
  try {
    const diagram = createDiagram(project.id, name, content)
    writeDiagramFiles(project.rootPath, listDiagrams(project.id), { prune: true })
    res.json({ diagram })
  } catch (err) {
    fail(res, err)
  }
})

/** Update a diagram's name and/or content. Body: { projectId, name?, content? }. */
diagramsRouter.patch('/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const existing = getDiagram(req.params.id)
  if (!existing || existing.projectId !== project.id) {
    return res.status(404).json({ error: 'diagram not found' })
  }
  const patch: { name?: string; content?: string } = {}
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim()
    if (!name) return res.status(400).json({ error: 'name cannot be empty' })
    if (name.length > MAX_NAME) return res.status(400).json({ error: 'name is too long' })
    patch.name = name
  }
  if (typeof req.body?.content === 'string') {
    if (req.body.content.length > MAX_CONTENT) {
      return res.status(400).json({ error: 'content is too large' })
    }
    patch.content = req.body.content
  }
  try {
    const diagram = updateDiagram(req.params.id, patch)
    writeDiagramFiles(project.rootPath, listDiagrams(project.id), { prune: true })
    res.json({ diagram })
  } catch (err) {
    fail(res, err)
  }
})

/** Delete a diagram. */
diagramsRouter.delete('/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const existing = getDiagram(req.params.id)
  if (!existing || existing.projectId !== project.id) {
    return res.status(404).json({ error: 'diagram not found' })
  }
  try {
    deleteDiagram(req.params.id)
    writeDiagramFiles(project.rootPath, listDiagrams(project.id), { prune: true })
    res.json({ ok: true })
  } catch (err) {
    fail(res, err)
  }
})
