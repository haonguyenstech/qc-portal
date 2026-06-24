import type { Request } from 'express'
import { getDefaultProject, getProject, listProjects } from './db.js'
import type { Project } from './types.js'

/**
 * Resolve which project a request targets: explicit `projectId` (query or body),
 * else fall back to the default project, else the first one (the default project
 * can be deleted, so don't rely on it existing). Returns undefined only when an
 * id was given but not found, or there are no projects at all.
 */
export function resolveProject(req: Request): Project | undefined {
  const id =
    (typeof req.query.projectId === 'string' && req.query.projectId) ||
    (req.body && typeof req.body.projectId === 'string' && req.body.projectId) ||
    ''
  if (id) return getProject(id)
  return getDefaultProject() ?? listProjects()[0]
}
