import { Router } from 'express'
import { resolveProject } from '../projectScope.js'
import { readTeam, resetTeam, saveTeam, teamFilePath } from '../aiTeamStore.js'

export const aiTeamRouter = Router()

/** GET /api/ai-team — the active project's bot team (seeded with the starter squad). */
aiTeamRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    res.json({ team: readTeam(project.rootPath), file: teamFilePath(project.rootPath) })
  } catch (err) {
    res.status(422).json({
      error: `testing/ai-team/team.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      file: teamFilePath(project.rootPath),
    })
  }
})

/** PUT /api/ai-team — replace the whole team. The server normalises what it stores. */
aiTeamRouter.put('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    res.json({ team: saveTeam(project.rootPath, req.body?.team) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not save the team' })
  }
})

/** POST /api/ai-team/reset — back to the starter squad. */
aiTeamRouter.post('/reset', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ team: resetTeam(project.rootPath) })
})
