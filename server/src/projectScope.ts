import type { Request } from 'express'
import path from 'node:path'
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

/**
 * The registered project id for a root path, or null. For the modules that only ever
 * receive a `rootPath` (context pointer, prompt packing) but need something keyed by
 * project id — e.g. the authenticator/TOTP store, which must not live inside the repo.
 */
export function projectIdForRoot(root: string): string | null {
  try {
    const target = path.resolve(root)
    return listProjects().find((p) => path.resolve(p.rootPath) === target)?.id ?? null
  } catch {
    return null
  }
}
