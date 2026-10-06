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

// ---------------------------------------------------------------- run account picker

/**
 * One test account the Run form can offer as "Sign in as". Only the IDENTITY leaves
 * the server — the username plus its role / environment — never a password: the run
 * reads the credentials from environments.md itself, so the picked label is all that
 * reaches the prompt, the stored run request and localStorage.
 */
export interface RunAccountOption {
  /** What the run is told to sign in as, e.g. "qa.admin@acme.test (Admin)". */
  label: string
  /** Secondary text for the picker (environment / URL), may be empty. */
  detail: string
}

// Column headers, matched loosely (EN + VI) because the sheet is whatever the team
// uploaded. A password-ish column is never read, even when it also says "user".
const SECRET_COL = /pass|mật ?khẩu|\bpwd\b|secret|otp|\bpin\b|token|key/i
// Strongest first: an "Account type" column must not win over a "Username" one.
const USER_COLS = [/user ?name|e-?mail|\blogin\b/i, /tài khoản|\baccount\b|\buser\b/i]
const ROLE_COL = /role|vai trò|persona|\btype\b|loại|nhóm|quyền|permission|description|mô tả|purpose/i
const ENV_COL = /\benv|environment|môi trường|\burl\b|site|server/i

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.replace(/\*\*|`/g, '').trim())
}

/** Every account row found in the sheet's markdown tables (deduped, capped). */
export function parseRunAccounts(markdown: string): RunAccountOption[] {
  const lines = markdown.split(/\r?\n/)
  const out: RunAccountOption[] = []
  const seen = new Set<string>()
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = lines[i].trim()
    const sep = lines[i + 1].trim()
    if (!header.startsWith('|') || !/^\|?\s*:?-{2,}/.test(sep)) continue
    const cols = splitRow(header)
    const usable = (re: RegExp) => cols.findIndex((c) => re.test(c) && !SECRET_COL.test(c))
    const userIdx = USER_COLS.map(usable).find((idx) => idx >= 0) ?? -1
    if (userIdx < 0) continue
    const roleIdx = cols.findIndex(
      (c, j) => j !== userIdx && ROLE_COL.test(c) && !SECRET_COL.test(c),
    )
    const envIdx = cols.findIndex(
      (c, j) => j !== userIdx && j !== roleIdx && ENV_COL.test(c) && !SECRET_COL.test(c),
    )
    let j = i + 2
    for (; j < lines.length && lines[j].trim().startsWith('|'); j++) {
      const cells = splitRow(lines[j])
      const user = cells[userIdx]?.trim() ?? ''
      // Blank / placeholder cells aren't accounts.
      if (!user || /^[-–—.]+$/.test(user)) continue
      const role = roleIdx >= 0 ? (cells[roleIdx] ?? '').trim() : ''
      const env = envIdx >= 0 ? (cells[envIdx] ?? '').trim() : ''
      const label = (role ? `${user} (${role})` : user).slice(0, 160)
      if (seen.has(label)) continue
      seen.add(label)
      out.push({ label, detail: env.slice(0, 160) })
      if (out.length >= 50) return out
    }
    i = j - 1
  }
  return out
}

/** The project's pickable test accounts — empty when it has no sheet. */
export function listRunAccounts(root: string): RunAccountOption[] {
  const doc = readAccounts(root)
  return doc.exists ? parseRunAccounts(doc.content) : []
}
