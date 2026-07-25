import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_SKILLS_DIR, bundledSkillDir, skillsDirFor } from './config.js'
import { getSkillInstall, listProjects, setSkillInstall } from './db.js'
import type { Project, SkillSyncStatus } from './types.js'

/**
 * Keeping a project's copy of a portal-bundled skill (today: `qc-testing`) in step
 * with the portal itself.
 *
 * The skill a run actually executes is the copy inside the project
 * (`<root>/.claude/skills/<name>/`) — `qc-portal --update` only refreshes the
 * bundled master under `templates/skills/`. Without this module those copies drift
 * and a QC engineer keeps running last month's skill after updating the portal.
 *
 * The rule, so we never silently throw away someone's work:
 *
 * - Whenever the portal writes the folder (project creation, or an update here) we
 *   record WHICH files it wrote and their combined hash (`skill_installs`).
 * - On boot, if those files still hash to that fingerprint, nobody edited them, so
 *   refreshing is lossless → **update silently**.
 * - Comparisons are scoped to the bundled file list, so a file the engineer ADDED to
 *   the folder is never treated as a version difference and never pruned.
 * - If the hash moved, the copy was hand-edited → **leave it alone** and report
 *   `customized`, so the Skills page can offer the update instead of forcing it.
 * - If the copy already matches the bundled version, just record the fingerprint so
 *   the *next* portal update can take the silent path.
 */

const IGNORED = new Set(['.DS_Store', 'Thumbs.db'])

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Relative paths of every meaningful file in a skill folder, sorted, posix-style. */
function skillFiles(dir: string, rel = '', acc: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    if (IGNORED.has(e.name) || e.name.startsWith('.')) continue
    const r = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) skillFiles(dir, r, acc)
    else if (e.isFile()) acc.push(r)
  }
  return acc.sort()
}

/**
 * Fingerprint of a specific LIST of files inside a folder: each path plus its bytes
 * folded into one sha256 (a missing file hashes as a marker, so a deletion moves the
 * hash too). Scoping to a file list is what lets us ignore files the engineer added
 * of their own — those are theirs, not a version difference.
 */
function hashFiles(dir: string, files: string[]): string {
  const h = crypto.createHash('sha256')
  for (const rel of [...files].sort()) {
    h.update(rel)
    h.update('\0')
    try {
      h.update(fs.readFileSync(path.join(dir, rel)))
    } catch {
      h.update('<missing>')
    }
    h.update('\0')
  }
  return h.digest('hex')
}

/** Fingerprint of every file in a skill folder. Null when the folder doesn't exist. */
export function hashSkillDir(dir: string): string | null {
  if (!isDir(dir)) return null
  return hashFiles(dir, skillFiles(dir))
}

/** Skills shipped with the portal (a folder with a SKILL.md under templates/skills). */
export function bundledSkillNames(): string[] {
  try {
    return fs
      .readdirSync(BUNDLED_SKILLS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(BUNDLED_SKILLS_DIR, e.name, 'SKILL.md')))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Compare one project's copy of a bundled skill against the bundled master.
 * Returns null when the skill isn't bundled with the portal at all (a skill the
 * engineer wrote or imported themselves — never our business to touch).
 */
export function skillSyncStatus(project: Project, skill: string): SkillSyncStatus | null {
  const bundledDir = bundledSkillDir(skill)
  if (!isDir(bundledDir)) return null
  const bundledFiles = skillFiles(bundledDir)
  const bundledHash = hashFiles(bundledDir, bundledFiles)

  const projectDir = path.join(skillsDirFor(project.rootPath), skill)
  if (!isDir(projectDir)) return { skill, state: 'missing' }

  const installed = getSkillInstall(project.id, skill)
  // Compare ONLY the files the portal ships. A file the engineer added to the folder
  // is theirs and never counts as being out of date. But a companion file the portal
  // used to ship and has since dropped DOES — left behind, the model still reads it.
  const contentCurrent = hashFiles(projectDir, bundledFiles) === bundledHash
  const stale = staleInstalledFiles(projectDir, installed?.files ?? [], bundledFiles)
  if (contentCurrent && stale.length === 0) return { skill, state: 'in-sync' }

  // Not current. Is this copy exactly what the portal last wrote — i.e. untouched, so
  // refreshing it loses nothing? Compare against the file list recorded at that time,
  // not today's, so a newly-added bundled file can't masquerade as a local edit.
  if (installed && hashFiles(projectDir, installed.files) === installed.hash) {
    return { skill, state: 'update-available' }
  }
  // Either hand-edited, or installed before we started fingerprinting: don't assume.
  return { skill, state: 'customized' }
}

/**
 * Files the portal installed previously, no longer part of the bundled skill, and
 * still sitting in the project — leftovers of an older version, safe to remove.
 * Files the engineer added themselves are never in `installedFiles`, so they can't
 * appear here.
 */
function staleInstalledFiles(
  projectDir: string,
  installedFiles: string[],
  bundledFiles: string[],
): string[] {
  return installedFiles.filter(
    (rel) => !bundledFiles.includes(rel) && fs.existsSync(path.join(projectDir, rel)),
  )
}

/**
 * Write the bundled version of a skill into a project, leaving it exactly as the
 * portal ships it: bundled files overwritten, plus any file the portal installed
 * previously that the new version dropped removed (a stale companion file would
 * otherwise still be read on every run).
 *
 * Files the engineer ADDED to the folder are untouched — they were never recorded as
 * portal-installed, so they can't be pruning candidates.
 */
export function applyBundledSkill(
  project: Project,
  skill: string,
): { written: string[]; removed: string[] } {
  const bundledDir = bundledSkillDir(skill)
  if (!isDir(bundledDir)) throw new Error(`"${skill}" is not bundled with the portal`)

  const projectDir = path.join(skillsDirFor(project.rootPath), skill)
  const previous = getSkillInstall(project.id, skill)?.files ?? []
  const bundled = skillFiles(bundledDir)

  fs.mkdirSync(projectDir, { recursive: true })
  for (const rel of bundled) {
    const target = path.join(projectDir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(path.join(bundledDir, rel), target)
  }

  const removed: string[] = []
  for (const rel of staleInstalledFiles(projectDir, previous, bundled)) {
    try {
      fs.rmSync(path.join(projectDir, rel))
      removed.push(rel)
    } catch {
      /* already gone */
    }
  }

  setSkillInstall(project.id, skill, { hash: hashFiles(projectDir, bundled), files: bundled })
  return { written: bundled, removed }
}

/**
 * Record the fingerprint of what's on disk right now as "what the portal wrote",
 * scoped to the bundled file list. Used right after project scaffolding, and for a
 * copy that already matches the bundled version so the NEXT update can be silent.
 */
export function recordSkillInstall(project: Project, skill: string): void {
  const bundledDir = bundledSkillDir(skill)
  if (!isDir(bundledDir)) return
  const projectDir = path.join(skillsDirFor(project.rootPath), skill)
  if (!isDir(projectDir)) return
  const bundled = skillFiles(bundledDir)
  setSkillInstall(project.id, skill, { hash: hashFiles(projectDir, bundled), files: bundled })
}

export interface SkillReconcileResult {
  updated: { project: string; skill: string }[]
  customized: { project: string; skill: string }[]
}

/**
 * Called once at startup: bring every project's untouched copy of a bundled skill up
 * to the portal's current version, and note the ones left behind because they were
 * customized (the Skills page shows those as an offer, not a surprise).
 *
 * Never throws — a project folder that has been moved or unmounted is skipped.
 */
export function reconcileBundledSkills(): SkillReconcileResult {
  const result: SkillReconcileResult = { updated: [], customized: [] }
  const skills = bundledSkillNames()
  if (skills.length === 0) return result

  for (const project of listProjects()) {
    if (!isDir(project.rootPath)) continue
    for (const skill of skills) {
      try {
        const status = skillSyncStatus(project, skill)
        if (!status) continue
        if (status.state === 'update-available') {
          applyBundledSkill(project, skill)
          result.updated.push({ project: project.name, skill })
        } else if (status.state === 'in-sync') {
          // Already current — remember it, so the NEXT portal update can be silent
          // even for copies installed before fingerprinting existed.
          recordSkillInstall(project, skill)
        } else if (status.state === 'customized') {
          result.customized.push({ project: project.name, skill })
        }
      } catch {
        /* one bad project must not stop the others */
      }
    }
  }
  return result
}
