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

// ---- Images a chat answer cited ----
//
// A chat turn that ran the `qc-testing` skill answers with EVIDENCE: "the dialog never
// closed — see testing/test-result/ABC-1-checkout/screenshots/ac3-cancel.png". On the run
// page those filenames are already clickable (RunDetailPage's evidence chips) because that
// page knows the run's file list; in Chat there is no run, only prose. So the transcript
// turns such a path into a chip and loads the picture from here.
//
// Two routes, both read-only and both containment-checked against the project root:
// `/resolve-images` says which cited paths are real files (so a hallucinated path is left
// as plain text instead of becoming a chip that 404s), and `/project-image` serves one.

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])

/** How many cited paths one answer may ask about, and how many run folders we search. */
const MAX_IMAGE_PATHS = 40
const MAX_RUN_DIRS = 40

/** Project-relative, forward-slashed — the form both routes speak in. */
function relOf(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/')
}

/** True when `abs` is a real file inside `root`. */
function fileInside(root: string, abs: string): boolean {
  const resolved = path.resolve(abs)
  const rel = path.relative(root, resolved)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false
  try {
    return fs.statSync(resolved).isFile()
  } catch {
    return false
  }
}

/** Run output folders, newest first — where a cited screenshot almost always lives. */
function recentRunDirs(root: string): string[] {
  const base = testResultDirFor(root)
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(base, e.name))
      .map((dir) => ({ dir, at: fs.statSync(dir).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_RUN_DIRS)
      .map((e) => e.dir)
  } catch {
    return []
  }
}

/**
 * Resolve one cited image path to a real file under the project.
 *
 * The skill writes evidence paths RELATIVE TO THE RUN FOLDER (`screenshots/ac1.png`) as
 * often as it writes the full `testing/test-result/<run>/screenshots/ac1.png`, and an
 * answer may shorten either. So: try the path as given, then the same path inside each
 * recent run folder, then its bare filename under that folder's `screenshots/` and
 * `evidence/`. Returns the project-relative path, or undefined when nothing matches —
 * never a guess.
 */
function resolveImageRef(root: string, cited: string): string | undefined {
  const clean = cited.trim().replace(/^\.\//, '')
  if (!clean || clean.includes('\0')) return undefined
  const ext = path.extname(clean).toLowerCase()
  if (!IMAGE_EXTS.has(ext)) return undefined

  const direct = path.isAbsolute(clean) ? clean : path.resolve(root, clean)
  if (fileInside(root, direct)) return relOf(root, path.resolve(direct))
  if (path.isAbsolute(clean)) return undefined

  const name = clean.split('/').pop()!
  for (const dir of recentRunDirs(root)) {
    for (const candidate of [
      path.resolve(dir, clean),
      path.resolve(dir, 'screenshots', name),
      path.resolve(dir, 'evidence', name),
      path.resolve(dir, name),
    ]) {
      if (fileInside(root, candidate)) return relOf(root, candidate)
    }
  }
  return undefined
}

/**
 * POST /api/files/resolve-images — body `{ projectId, paths: string[] }`, answers
 * `{ resolved: { [cited]: projectRelativePath } }` with an entry only for the paths that
 * are real image files. Pure `stat` work, no AI and no network, so the transcript can ask
 * on render; a path it doesn't hear back about stays plain text.
 */
filesRouter.post('/resolve-images', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const paths = (req.body as { paths?: unknown })?.paths
  if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' })
  const root = path.resolve(project.rootPath)
  const resolved: Record<string, string> = {}
  for (const cited of paths.slice(0, MAX_IMAGE_PATHS)) {
    if (typeof cited !== 'string' || cited in resolved) continue
    const hit = resolveImageRef(root, cited)
    if (hit) resolved[cited] = hit
  }
  return res.json({ resolved })
})

/**
 * GET /api/files/project-image?projectId&path — serve one image file named by a path
 * relative to the project root. Image extensions only; anything outside the root, or not
 * a file, is refused rather than looked up.
 */
filesRouter.get('/project-image', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const rel = req.query.path
  if (typeof rel !== 'string' || !rel) return res.status(400).json({ error: 'path is required' })
  const root = path.resolve(project.rootPath)
  if (!IMAGE_EXTS.has(path.extname(rel).toLowerCase())) {
    return res.status(400).json({ error: 'not an image' })
  }
  const target = path.resolve(root, rel)
  if (!fileInside(root, target)) return res.status(404).json({ error: 'not found' })
  return res.sendFile(target)
})
