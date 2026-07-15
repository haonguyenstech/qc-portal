import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

// Storage for the project's Environments & Test Accounts sheet — a single markdown
// doc under <root>/testing/environments.md holding the app URLs and the (non-production)
// test-account credentials a QC run needs to log in. Uploaded as CSV/Excel (converted to
// a markdown table in the browser) or edited by hand in the portal.
//
// This is deliberately a per-project plaintext file on the QC engineer's own localhost
// machine, injected into generation/QC prompts (projectContext.ts) and pointed at from
// CLAUDE.md (contextPointer.ts) so "log in as …" steps use the real environment + account
// instead of inventing placeholders. Kept out of the streamed run log and DB events.

const MAX_BYTES = 256 * 1024
export const ACCOUNTS_FILE = 'environments.md'

export function accountsFile(root: string): string {
  return path.join(testingDirFor(root), ACCOUNTS_FILE)
}

export interface AccountsDoc {
  content: string
  exists: boolean
  size: number
  savedAt: string | null
}

const EMPTY: AccountsDoc = { content: '', exists: false, size: 0, savedAt: null }

/** Read the stored sheet (content + metadata); EMPTY when it doesn't exist yet. */
export function readAccounts(root: string): AccountsDoc {
  const file = accountsFile(root)
  try {
    const content = fs.readFileSync(file, 'utf8')
    const stat = fs.statSync(file)
    return { content, exists: true, size: stat.size, savedAt: stat.mtime.toISOString() }
  } catch {
    return EMPTY
  }
}

/**
 * Create or overwrite the sheet. Blank content deletes it (clearing the sheet is the
 * same as removing the file). Returns null when the content exceeds the size cap.
 */
export function writeAccounts(root: string, content: string): AccountsDoc | null {
  if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return null
  const file = accountsFile(root)
  if (!content.trim()) {
    try {
      fs.rmSync(file)
    } catch {
      /* nothing to remove */
    }
    return EMPTY
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  const stat = fs.statSync(file)
  return { content, exists: true, size: stat.size, savedAt: stat.mtime.toISOString() }
}

/** Remove the sheet (if present). */
export function deleteAccounts(root: string): void {
  try {
    fs.rmSync(accountsFile(root))
  } catch {
    /* already gone */
  }
}

/** Whether the project has a non-empty environments/accounts sheet. */
export function hasAccounts(root: string): boolean {
  try {
    return fs.statSync(accountsFile(root)).size > 0
  } catch {
    return false
  }
}
