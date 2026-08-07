import { Router } from 'express'
import { resolveProject } from '../projectScope.js'
import { addLabel, createNote, deleteNote, emptyTrash, readNotes, removeLabel, renameLabel, updateNote } from '../notesStore.js'

export const notesRouter = Router()

notesRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(readNotes(project.rootPath))
})

notesRouter.post('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    res.status(201).json({ note: createNote(project.rootPath, {
      title: typeof req.body?.title === 'string' ? req.body.title : '',
      body: typeof req.body?.body === 'string' ? req.body.body : '',
      label: typeof req.body?.label === 'string' ? req.body.label : undefined,
    }) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not create note' })
  }
})

notesRouter.patch('/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    const note = updateNote(project.rootPath, req.params.id, req.body ?? {})
    if (!note) return res.status(404).json({ error: 'note not found' })
    res.json({ note })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not update note' })
  }
})

notesRouter.delete('/trash', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ ok: true, removed: emptyTrash(project.rootPath) })
})

notesRouter.delete('/:id', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!deleteNote(project.rootPath, req.params.id)) return res.status(404).json({ error: 'note not found' })
  res.json({ ok: true })
})

notesRouter.post('/labels', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    res.status(201).json({ label: addLabel(project.rootPath, typeof req.body?.name === 'string' ? req.body.name : '') })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not add label' })
  }
})

notesRouter.delete('/labels/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!removeLabel(project.rootPath, req.params.name)) return res.status(404).json({ error: 'label not found' })
  res.json({ ok: true })
})

notesRouter.patch('/labels/:name', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    const renamed = renameLabel(project.rootPath, req.params.name, typeof req.body?.name === 'string' ? req.body.name : '')
    if (!renamed) return res.status(404).json({ error: 'label not found' })
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not rename label' })
  }
})
