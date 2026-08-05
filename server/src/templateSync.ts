import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BUNDLED_TEMPLATES_DIR, bundledTemplateFile, testingDirFor } from './config.js'
import { getTemplateInstallHash, listProjects, setTemplateInstallHash } from './db.js'
import type { Project } from './types.js'

/**
 * Keeping a project's copy of a portal-bundled project template (today: the common
 * test-case template) in step with the portal itself — the template twin of
 * skillSync.ts, and it follows the same rule.
 *
 * The template test-case generation actually matches is the copy inside the project
 * (`<root>/testing/templates/<key>.md`); `qc-portal --update` only refreshes the
 * bundled master under `templates/project-templates/`. Without this, a project
 * scaffolded months ago keeps drafting against the old default forever.
 *
 * So, per project and per bundled key:
 *
 * - Copy missing → write it (a project created before the portal shipped this kind).
 * - Copy identical to the bundled master → nothing to do (just record it, so the
 *   NEXT update can take the silent path).
 * - Copy identical to what the portal LAST wrote (fingerprint in `template_installs`)
 *   → untouched, refreshing is lossless → **update silently**.
 * - Anything else → the QC engineer edited it. **Leave it alone** and report it as
 *   customized; /templates already offers "Reset to default" for that case.
 *
 * Never throws — a project folder that has been moved or unmounted is skipped.
 */

const KEY_RE = /^[a-z0-9-]{1,40}$/

/**
 * sha256 of DEFAULTS THE PORTAL SHIPPED IN THE PAST, per key. Fingerprinting only
 * started with this module, so a project scaffolded by an older portal has no row in
 * `template_installs` and would otherwise be read as hand-edited and never refreshed —
 * which is exactly the copy that most needs the update. A file matching a former
 * default is provably untouched, so it's safe to treat as portal-written.
 *
 * Append (never replace) the outgoing hash here whenever a bundled default changes:
 *   shasum -a 256 templates/project-templates/<key>.md
 */
const LEGACY_DEFAULTS: Record<string, string[]> = {
  // The original Markdown test-case template, superseded by the team's CSV template.
  testcase: ['81edf9e8c6ce396be923d6bfc350b4f10ecf0ea5fb8387436de4b26778fb9b25'],
}

const sha256 = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex')

/** Template kinds the portal ships a default for (templates/project-templates/<key>.md). */
export function bundledTemplateKeys(): string[] {
  try {
    return fs
      .readdirSync(BUNDLED_TEMPLATES_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.md'))
      .map((d) => d.name.replace(/\.md$/, ''))
      .filter((key) => KEY_RE.test(key))
      .sort()
  } catch {
    return [] // no bundled defaults shipped
  }
}

/** <root>/testing/templates/<key>.md — the copy a run actually reads. */
export function projectTemplateFile(root: string, key: string): string {
  return path.join(testingDirFor(root), 'templates', `${key}.md`)
}

function hashFile(file: string): string | null {
  try {
    return sha256(fs.readFileSync(file))
  } catch {
    return null
  }
}

/**
 * Sentinel fingerprint meaning "the engineer deleted this template on purpose".
 * Without it, a reconcile would helpfully re-create on the next boot every template
 * someone removed from /templates.
 */
export const TEMPLATE_ABSENT = 'absent'

export type TemplateSyncState =
  | 'missing' // never written here — seed it
  | 'removed' // deleted on purpose — leave it deleted
  | 'in-sync'
  | 'update-available'
  | 'customized'

/** Compare one project's copy of a bundled template against the bundled master. */
export function templateSyncState(project: Project, key: string): TemplateSyncState | null {
  const bundledHash = hashFile(bundledTemplateFile(key))
  if (!bundledHash) return null // not a kind the portal ships
  const localHash = hashFile(projectTemplateFile(project.rootPath, key))
  if (localHash === null) {
    return getTemplateInstallHash(project.id, key) === TEMPLATE_ABSENT ? 'removed' : 'missing'
  }
  if (localHash === bundledHash) return 'in-sync'
  const installed = getTemplateInstallHash(project.id, key)
  if (installed === localHash) return 'update-available'
  if ((LEGACY_DEFAULTS[key] ?? []).includes(localHash)) return 'update-available'
  return 'customized'
}

/**
 * Write the bundled default into the project and record its fingerprint, so the copy
 * counts as portal-written (and a later update can refresh it silently).
 */
export function applyBundledTemplate(project: Project, key: string): void {
  const source = bundledTemplateFile(key)
  const content = fs.readFileSync(source)
  const target = projectTemplateFile(project.rootPath, key)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  setTemplateInstallHash(project.id, key, sha256(content))
}

/**
 * Record the fingerprint of what's on disk right now as "what the portal wrote".
 * Used right after project scaffolding, and for a copy that already matches the
 * bundled version so the NEXT portal update can be silent.
 */
export function recordTemplateInstall(project: Project, key: string): void {
  const hash = hashFile(projectTemplateFile(project.rootPath, key))
  if (hash) setTemplateInstallHash(project.id, key, hash)
}

/** Remember that this template was deleted deliberately, so we don't re-seed it. */
export function markTemplateRemoved(projectId: string, key: string): void {
  setTemplateInstallHash(projectId, key, TEMPLATE_ABSENT)
}

export interface TemplateReconcileResult {
  updated: { project: string; key: string }[]
  customized: { project: string; key: string }[]
}

/**
 * Called once at startup: bring every project's untouched copy of a bundled template
 * up to the portal's current version, and note the ones left behind because they were
 * edited locally (/templates shows those a "Reset to default" instead).
 */
export function reconcileBundledTemplates(): TemplateReconcileResult {
  const result: TemplateReconcileResult = { updated: [], customized: [] }
  const keys = bundledTemplateKeys()
  if (keys.length === 0) return result

  for (const project of listProjects()) {
    try {
      if (!fs.statSync(project.rootPath).isDirectory()) continue
    } catch {
      continue // folder moved / unmounted
    }
    for (const key of keys) {
      try {
        const state = templateSyncState(project, key)
        if (state === 'missing' || state === 'update-available') {
          applyBundledTemplate(project, key)
          result.updated.push({ project: project.name, key })
        } else if (state === 'in-sync') {
          recordTemplateInstall(project, key)
        } else if (state === 'customized') {
          result.customized.push({ project: project.name, key })
        }
      } catch {
        /* one bad project must not stop the others */
      }
    }
  }
  return result
}
