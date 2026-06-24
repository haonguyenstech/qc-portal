import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testResultDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'

export const filesRouter = Router()

filesRouter.get('/screenshot', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const slug = req.query.slug
  const rel = req.query.path
  if (typeof slug !== 'string' || typeof rel !== 'string') {
    return res.status(400).json({ error: 'slug and path are required' })
  }
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..')) {
    return res.status(400).json({ error: 'invalid slug' })
  }

  const runDir = path.resolve(testResultDirFor(project.rootPath), slug)
  const target = path.resolve(runDir, rel)
  if (target !== runDir && !target.startsWith(runDir + path.sep)) {
    return res.status(400).json({ error: 'invalid path' })
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    return res.status(404).json({ error: 'not found' })
  }

  return res.sendFile(target)
})
