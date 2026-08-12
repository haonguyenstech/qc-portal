// Helpers to read a drag-and-dropped folder in the browser.
//
// Browsers never expose a dropped folder's absolute path, but they do let us
// walk its contents via the (non-standard but widely supported) Entries API.
// We read each file's bytes and base64-encode them so the server can recreate
// the folder exactly under .claude/skills.

export type DroppedFile = { path: string; content: string }

// Minimal typings for the webkit Entries API (not in lib.dom for older TS).
interface FsEntry {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (cb: (e: FsEntry[]) => void, err?: (e: unknown) => void) => void }
}

/**
 * Pull FileSystemEntry objects out of a drop event. MUST be called
 * synchronously inside the drop handler — the DataTransfer items list is
 * invalidated once the handler yields. The returned entries stay readable.
 */
export function entriesFromDrop(dt: DataTransfer): FsEntry[] {
  const out: FsEntry[] = []
  for (const item of Array.from(dt.items)) {
    const anyItem = item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }
    const entry = anyItem.webkitGetAsEntry?.()
    if (entry) out.push(entry)
  }
  return out
}

function readFile(entry: FsEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file?.(resolve, reject) ?? reject(new Error('not a file'))
  })
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string // "data:...;base64,XXXX"
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function readAllChildren(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader?.()
  if (!reader) return Promise.resolve([])
  const all: FsEntry[] = []
  return new Promise((resolve, reject) => {
    const pump = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) return resolve(all)
        all.push(...batch)
        pump() // readEntries is paginated — keep going until empty
      }, reject)
    pump()
  })
}

/** Recursively collect files under an entry, paths relative to `prefix`. */
async function collect(entry: FsEntry, prefix: string): Promise<DroppedFile[]> {
  if (entry.isFile) {
    const file = await readFile(entry)
    return [{ path: prefix + entry.name, content: await fileToBase64(file) }]
  }
  const children = await readAllChildren(entry)
  const nested = await Promise.all(children.map((c) => collect(c, prefix + entry.name + '/')))
  return nested.flat()
}

export type SkillDrop = { name: string; files: DroppedFile[] }

/**
 * Turn dropped entries into a skill payload. Expects exactly one folder.
 * Throws an Error with a user-facing message otherwise.
 */
export async function readSkillDrop(entries: FsEntry[]): Promise<SkillDrop> {
  const dirs = entries.filter((e) => e.isDirectory)
  if (dirs.length === 0) throw new Error('Drop a skill folder, not loose files.')
  if (dirs.length > 1 || entries.some((e) => e.isFile)) {
    throw new Error('Drop a single skill folder.')
  }
  const root = dirs[0]
  const children = await readAllChildren(root)
  const files = (await Promise.all(children.map((c) => collect(c, '')))).flat()
  if (files.length === 0) throw new Error('That folder is empty.')
  if (!files.some((f) => f.path === 'SKILL.md')) {
    throw new Error('That folder has no SKILL.md at its root — it is not a skill.')
  }
  return { name: root.name, files }
}

/**
 * Turn the FileList of a `<input type="file" webkitdirectory>` into the same
 * payload `readSkillDrop` produces. This is the BROWSE path, and it runs
 * entirely in the browser on purpose: the server-side native folder dialog
 * (folderPicker.ts) can only draw a window when the portal was started from
 * the user's own interactive desktop session, so on a portal launched over
 * SSH / a scheduled task / WMI it never appears and the request just pends.
 * A directory input has no such dependency and works the same on Win + Mac.
 *
 * Every entry carries `webkitRelativePath` = "<folder>/<...>/<file>", so the
 * first segment is the skill name and the rest is the path inside it.
 */
export async function readSkillFileList(list: FileList | null): Promise<SkillDrop> {
  const picked = Array.from(list ?? [])
  if (picked.length === 0) throw new Error('No folder was selected.')

  const rootNames = new Set<string>()
  const files: DroppedFile[] = []
  for (const file of picked) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    if (!rel) throw new Error('Your browser did not report the folder structure.')
    const segments = rel.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length < 2) continue // a loose file with no folder above it
    rootNames.add(segments[0])
    // macOS/Windows sprinkle these into folders; they are never part of a skill.
    const base = segments[segments.length - 1]
    if (base === '.DS_Store' || base === 'Thumbs.db') continue
    files.push({ path: segments.slice(1).join('/'), content: await fileToBase64(file) })
  }

  if (rootNames.size === 0) throw new Error('Select a skill folder, not loose files.')
  if (rootNames.size > 1) throw new Error('Select a single skill folder.')
  if (files.length === 0) throw new Error('That folder is empty.')
  if (!files.some((f) => f.path === 'SKILL.md')) {
    throw new Error('That folder has no SKILL.md at its root — it is not a skill.')
  }
  return { name: [...rootNames][0], files }
}
