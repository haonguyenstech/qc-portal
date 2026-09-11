// Streaming .zip receive + extract for project import.
//
// Why this module exists instead of `express.raw()` + JSZip: both hold the
// ENTIRE archive in memory. A real QC project export is dominated by ticket
// attachments (bandicam .mp4 evidence), not text — a measured one was 1.87 GB
// across 4348 files. `express.raw({ limit: '1gb' })` rejected it with a 413
// ("The uploaded file is too large for the server to accept.") before any of
// the route's careful zip diagnostics could run, and simply raising that limit
// only moves the failure: `JSZip.loadAsync` wants the whole compressed archive
// as one Buffer, plus every member decompressed on top, so ~2 GB of zip turns
// into several GB of RSS and the server dies mid-import.
//
// So: stream the request body straight to a temp file (bounded memory, disk is
// the only thing that grows), then extract with bsdtar, which walks the archive
// member by member. bsdtar reads zip as well as tar and ships in the OS on both
// targets — `/usr/bin/tar` on macOS, `tar.exe` in System32 on Windows 10 1803+
// — so this needs no new dependency. JSZip stays as the fallback for the small
// archives it can handle when bsdtar is somehow absent.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import spawn from 'cross-spawn'
import JSZip from 'jszip'
import { spawnEnv } from './toolPath.js'

/** Hard ceiling on an uploaded archive. Generous — the point is to bound disk, not to gate real projects. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024 * 1024 // 16 GiB

/** Largest archive we will try to extract through JSZip's whole-buffer API. */
const JSZIP_FALLBACK_MAX_BYTES = 256 * 1024 * 1024 // 256 MiB

/** Raised when the upload exceeds `MAX_IMPORT_BYTES`, so the route can answer 413. */
export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`the upload exceeds the ${Math.round(limitBytes / 1024 / 1024 / 1024)} GB import limit`)
    this.name = 'UploadTooLargeError'
  }
}

/**
 * Stream a request body to a temp file without buffering it in memory.
 * The caller owns the returned path and must delete it (see `discardUpload`).
 */
export async function receiveUploadToTempFile(
  req: Readable,
  maxBytes = MAX_IMPORT_BYTES,
): Promise<{ filePath: string; bytes: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-portal-import-'))
  const filePath = path.join(dir, 'upload.zip')
  let bytes = 0
  try {
    await pipeline(
      req,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytes += chunk.length
          if (bytes > maxBytes) throw new UploadTooLargeError(maxBytes)
          yield chunk
        }
      },
      fs.createWriteStream(filePath),
    )
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true })
    throw err
  }
  return { filePath, bytes }
}

/** Delete a temp upload and the directory we made for it. */
export function discardUpload(filePath: string): void {
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
}

/**
 * Whether a file starts with the "PK" zip signature — a local file header
 * (PK\x03\x04) or an empty-archive end record (PK\x05\x06). Reads 2 bytes, so
 * it works the same on a 2 GB upload as on a tiny one.
 */
export function hasZipSignature(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r')
  try {
    const head = Buffer.alloc(2)
    const read = fs.readSync(fd, head, 0, 2, 0)
    return read === 2 && head[0] === 0x50 && head[1] === 0x4b
  } finally {
    fs.closeSync(fd)
  }
}

/** Run a command to completion, collecting stdout/stderr as text. */
function run(
  cmd: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: spawnEnv(), windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

let bsdtarChecked: boolean | null = null

/** Whether a libarchive-backed `tar` (bsdtar) is on PATH — it, unlike GNU tar, reads zip. */
async function hasBsdtar(): Promise<boolean> {
  if (bsdtarChecked !== null) return bsdtarChecked
  try {
    const { code, stdout } = await run('tar', ['--version'])
    bsdtarChecked = code === 0 && /bsdtar|libarchive/i.test(stdout)
  } catch {
    bsdtarChecked = false
  }
  return bsdtarChecked
}

/**
 * Reject an archive entry that would escape the destination folder (zip slip).
 * bsdtar already strips leading slashes and refuses `..` without `-P`, but the
 * portal's rule is that nothing writes outside a project root, so we check the
 * member list ourselves before extracting anything.
 */
function assertSafeEntry(name: string): void {
  const rel = name.replace(/\\/g, '/')
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`invalid absolute path in zip: ${name}`)
  }
  if (rel.split('/').some((seg) => seg === '..')) {
    throw new Error(`path escapes project folder: ${name}`)
  }
}

/** Turn a bsdtar/JSZip failure into something a QC engineer can act on. */
export function friendlyArchiveError(reason: string): string {
  if (/encrypt|password/i.test(reason)) {
    return (
      'This .zip is password-protected, which is not supported — re-export the project from ' +
      'QC Portal (its exports are never encrypted) and import that file.'
    )
  }
  if (/truncat|end of central directory|end of data|corrupt|unrecognized archive/i.test(reason)) {
    return (
      'This .zip looks incomplete or corrupted — its contents could not be read. ' +
      'A partial or interrupted download is the usual cause; re-download or re-export the ' +
      'project and import the fresh file.'
    )
  }
  return `Could not read that .zip file${reason ? `: ${reason}` : ''}.`
}

/**
 * Extract a .zip into `dest`, skipping the given root-relative names, without
 * ever holding the archive in memory. Returns how many members were written.
 */
export async function extractZipToFolder(
  zipPath: string,
  dest: string,
  skipNames: ReadonlySet<string>,
): Promise<number> {
  if (await hasBsdtar()) return extractWithBsdtar(zipPath, dest, skipNames)
  return extractWithJsZip(zipPath, dest, skipNames)
}

async function extractWithBsdtar(
  zipPath: string,
  dest: string,
  skipNames: ReadonlySet<string>,
): Promise<number> {
  // Pass 1: read the member list and path-guard it before a single byte lands.
  const listed = await run('tar', ['-tf', zipPath])
  if (listed.code !== 0) throw new Error(friendlyArchiveError(listed.stderr.trim()))
  const entries = listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const files = entries.filter((e) => !e.endsWith('/'))
  if (files.length === 0) throw new Error('the .zip is empty')
  for (const entry of entries) assertSafeEntry(entry)

  // Pass 2: stream the extract. `--exclude` keeps the manifest (and anything
  // else the caller skips) from being written at all.
  fs.mkdirSync(dest, { recursive: true })
  const args = ['-xf', zipPath, '-C', dest]
  for (const name of skipNames) args.push('--exclude', name)
  const out = await run('tar', args)
  if (out.code !== 0) throw new Error(friendlyArchiveError(out.stderr.trim()))
  return files.filter((f) => !skipNames.has(f)).length
}

async function extractWithJsZip(
  zipPath: string,
  dest: string,
  skipNames: ReadonlySet<string>,
): Promise<number> {
  const { size } = fs.statSync(zipPath)
  if (size > JSZIP_FALLBACK_MAX_BYTES) {
    throw new Error(
      `This archive is ${Math.round(size / 1024 / 1024)} MB, which is too large to extract ` +
        'without the `tar` command. Install a libarchive-backed tar (it ships with macOS and ' +
        'with Windows 10 1803+) and retry the import.',
    )
  }
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
  } catch (err) {
    throw new Error(friendlyArchiveError(err instanceof Error ? err.message : ''))
  }
  const files = Object.values(zip.files).filter((f) => !f.dir)
  if (files.length === 0) throw new Error('the .zip is empty')

  fs.mkdirSync(dest, { recursive: true })
  let written = 0
  for (const file of files) {
    const rel = file.name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!rel || skipNames.has(rel)) continue
    assertSafeEntry(rel)
    const target = path.resolve(dest, rel)
    if (target !== dest && !target.startsWith(dest + path.sep)) {
      throw new Error(`path escapes project folder: ${file.name}`)
    }
    fs.mkdirSync(path.dirname(target), { recursive: true })
    // An encrypted zip loads its directory fine and only fails here, when a
    // member is actually read.
    try {
      fs.writeFileSync(target, await file.async('nodebuffer'))
    } catch (err) {
      throw new Error(friendlyArchiveError(err instanceof Error ? err.message : ''))
    }
    written += 1
  }
  return written
}

/**
 * Read the `qc-portal.json` manifest out of an archive WITHOUT extracting it.
 *
 * Import needs the manifest before it decides anything (it carries the source
 * project's `syncKey`, which is how "you already have this project" is answered
 * without guessing from the name), and it must not cost a second full extract of a
 * multi-gigabyte zip. `tar -xOf` writes one member to stdout and stops.
 *
 * Returns null for an archive that has no manifest — every export before format 2,
 * which is a normal thing to import, not an error.
 */
export async function readZipManifest(
  zipPath: string,
  manifestName: string,
): Promise<Record<string, unknown> | null> {
  let text = ''
  if (await hasBsdtar()) {
    const out = await run('tar', ['-xOf', zipPath, manifestName])
    if (out.code !== 0) return null
    text = out.stdout
  } else {
    const { size } = fs.statSync(zipPath)
    if (size > JSZIP_FALLBACK_MAX_BYTES) return null
    try {
      const zip = await JSZip.loadAsync(fs.readFileSync(zipPath))
      const file = zip.file(manifestName)
      if (!file) return null
      text = await file.async('string')
    } catch {
      return null
    }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}
