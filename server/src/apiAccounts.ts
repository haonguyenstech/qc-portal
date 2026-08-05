// Test accounts the API Testing flows log in with.
//
// A multi-step API scenario almost always starts with authentication: POST the
// credentials, capture the token, send it as `Authorization` on every later step. So
// the credentials have to live somewhere the runner can reach — but a PASSWORD is not
// collection metadata:
//
//   - `testing/api-tests/*.json` is versioned WITH the project, so a password there
//     gets committed and shared;
//   - `projectContext.ts` sweeps `testing/**` into AI prompts, so it would also end
//     up in a model request.
//
// It therefore lives beside the portal's DB (`data/api-accounts/<projectId>.json`,
// dir 0700 / file 0600) — exactly the reasoning and layout `totp.ts` uses for
// authenticator seeds. The password is **write-only over the API**: `PublicApiAccount`
// strips it, and the only thing that ever leaves the process is the substituted
// request the server itself sends.
//
// Requests reference an account through variables the server resolves at send time:
//   {{account.<label>.username}}   {{account.<label>.password}}
// and the live 2FA digits for the same account come from totp.ts as {{otp.<label>}}.

import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH } from './config.js'
import { slugLabel } from './totp.js'

export interface ApiAccount {
  /** Slug used in the {{account.<label>.…}} variables — unique per project. */
  label: string
  username: string
  password: string
  /** Free-text reminder ("admin on staging"), safe to show in the UI. */
  note: string
  savedAt: string
}

/** What the browser is allowed to see: everything except the password itself. */
export type PublicApiAccount = Omit<ApiAccount, 'password'> & { hasPassword: boolean }

const MAX_ACCOUNTS = 20
const MAX_FIELD = 400

/** One JSON file per project, next to the portal's database — never inside the project. */
function storeFile(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
  return path.join(path.dirname(DB_PATH), 'api-accounts', `${safe}.json`)
}

function readStore(projectId: string): ApiAccount[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(projectId), 'utf8'))
    return Array.isArray(parsed?.accounts) ? (parsed.accounts as ApiAccount[]) : []
  } catch {
    return [] // nothing registered yet (or an unreadable/corrupt file)
  }
}

function writeStore(projectId: string, accounts: ApiAccount[]): void {
  const file = storeFile(projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ accounts }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

const toPublic = ({ password, ...rest }: ApiAccount): PublicApiAccount => ({
  ...rest,
  hasPassword: password.length > 0,
})

/** Registered accounts for a project, passwords stripped. */
export function listApiAccounts(projectId: string): PublicApiAccount[] {
  return readStore(projectId).map(toPublic)
}

/**
 * Register or replace one account. An EMPTY password means "keep the stored one" —
 * the UI never receives the real value, so a plain re-save (e.g. fixing the note)
 * must not blank it. Throws a user-facing Error on bad input.
 */
export function upsertApiAccount(
  projectId: string,
  input: { label: string; username?: string; password?: string; note?: string },
): PublicApiAccount {
  const label = slugLabel(input.label ?? '')
  if (!label) throw new Error('a label is required (letters, digits, dot, dash, underscore)')
  const accounts = readStore(projectId)
  const existing = accounts.find((a) => a.label === label)
  if (!existing && accounts.length >= MAX_ACCOUNTS) {
    throw new Error(`at most ${MAX_ACCOUNTS} accounts per project`)
  }
  const clip = (v: string | undefined, fallback: string) =>
    typeof v === 'string' ? v.slice(0, MAX_FIELD) : fallback
  const entry: ApiAccount = {
    label,
    username: clip(input.username, existing?.username ?? ''),
    // '' = unchanged, so only a non-empty submission replaces the stored password.
    password: input.password ? input.password.slice(0, MAX_FIELD) : (existing?.password ?? ''),
    note: clip(input.note, existing?.note ?? ''),
    savedAt: new Date().toISOString(),
  }
  const next = existing
    ? accounts.map((a) => (a.label === label ? entry : a))
    : [...accounts, entry]
  writeStore(projectId, next)
  return toPublic(entry)
}

/** Forget one account. Returns false when the label wasn't registered. */
export function deleteApiAccount(projectId: string, rawLabel: string): boolean {
  const label = slugLabel(rawLabel)
  const accounts = readStore(projectId)
  const next = accounts.filter((a) => a.label !== label)
  if (next.length === accounts.length) return false
  writeStore(projectId, next)
  return true
}

/**
 * The account variables for a project: `account.<label>.username` /
 * `account.<label>.password`, ready to merge into the send-time variable map.
 *
 * The password is marked `secret` so the existing masking path puts `{{…}}` back
 * into anything echoed to the browser or written to the on-disk run history. The
 * username is NOT secret: it's the one thing an engineer needs to see to know which
 * account a failing step ran as, and the project's `testing/environments.md` sheet
 * already documents test-account usernames in the clear.
 */
export function apiAccountVars(projectId: string): Map<string, { value: string; secret: boolean }> {
  const map = new Map<string, { value: string; secret: boolean }>()
  for (const a of readStore(projectId)) {
    map.set(`account.${a.label}.username`, { value: a.username, secret: false })
    if (a.password) map.set(`account.${a.label}.password`, { value: a.password, secret: true })
  }
  return map
}

// ---------------------------------------------------------------- import from the sheet

/**
 * One row of `testing/environments.md` that looks like a usable login.
 *
 * That sheet (Instructions → Accounts) is where a QC engineer ALREADY writes the test
 * accounts, so asking them to retype the same credentials here is how the flow picker
 * ends up showing "No account" while the engineer is looking at their account on the
 * other page. The sheet is a free-form markdown table, so this is a best-effort read:
 * columns are matched by HEADER NAME, never by position, and a row without a username
 * is skipped rather than guessed at.
 */
export interface AccountCandidate {
  /** Suggested label, derived from environment+role, else the username's local part. */
  label: string
  username: string
  role: string
  environment: string
  note: string
  /** Whether the sheet actually has a password for this row (it often doesn't). */
  hasPassword: boolean
}

/** Column aliases, so a hand-edited header still resolves. */
const COLUMNS: Record<'username' | 'password' | 'role' | 'environment' | 'note', string[]> = {
  username: ['username', 'user', 'email', 'account', 'login'],
  password: ['password', 'pass', 'pwd'],
  role: ['role', 'permission', 'user role'],
  environment: ['environment', 'env'],
  note: ['notes', 'note', 'comment'],
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

const isSeparator = (cells: string[]) => cells.every((c) => /^:?-{2,}:?$/.test(c))

/**
 * Parse every markdown table in the sheet into login candidates. Exported with the
 * password so the import route can store it; `AccountCandidate` (what the browser
 * sees) deliberately has no password field.
 */
export function parseAccountSheet(
  markdown: string,
): (AccountCandidate & { password: string })[] {
  const lines = markdown.split('\n')
  const out: (AccountCandidate & { password: string })[] = []
  const seen = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('|')) continue
    const header = splitRow(lines[i]).map((h) => h.toLowerCase())
    // A table only starts where a header is followed by the |---|---| separator.
    if (i + 1 >= lines.length || !lines[i + 1].includes('|')) continue
    if (!isSeparator(splitRow(lines[i + 1]))) continue

    const col = (which: keyof typeof COLUMNS) =>
      header.findIndex((h) => COLUMNS[which].some((alias) => h === alias || h.includes(alias)))
    const idx = {
      username: col('username'),
      password: col('password'),
      role: col('role'),
      environment: col('environment'),
      note: col('note'),
    }
    if (idx.username < 0) {
      i++ // not a credentials table — skip past its separator and keep looking
      continue
    }

    for (let j = i + 2; j < lines.length && lines[j].includes('|'); j++) {
      const cells = splitRow(lines[j])
      if (isSeparator(cells)) continue
      const at = (k: number) => (k >= 0 && k < cells.length ? cells[k] : '')
      // Markdown escaping / link syntax would only confuse a credential — take it raw.
      const username = at(idx.username).replace(/^<|>$/g, '')
      if (!username || username === '-') continue
      const environment = at(idx.environment)
      const role = at(idx.role)
      const base =
        [environment, role].filter(Boolean).join('-') || username.split('@')[0] || 'account'
      let label = slugLabel(base)
      // Two rows can share env+role (two admins on Dev) — keep both, numbered.
      for (let n = 2; !label || seen.has(label); n++) label = slugLabel(`${base}-${n}`)
      seen.add(label)
      out.push({
        label,
        username,
        role,
        environment,
        note: [at(idx.note), environment && role ? `${environment} · ${role}` : '']
          .filter(Boolean)
          .join(' — ')
          .slice(0, MAX_FIELD),
        password: at(idx.password),
        hasPassword: !!at(idx.password),
      })
    }
    i++ // resume after this table's separator
  }
  return out.slice(0, MAX_ACCOUNTS)
}

/**
 * The SELECTED account as label-free `auth.username` / `auth.password`.
 *
 * This is what lets a login request be written once and run as any account: the flow
 * picks the account, the request only ever says `{{auth.username}}`. Without it every
 * request hard-codes `{{account.<label>.…}}`, so testing the same scenario as a
 * different role means editing the saved request (and probably forgetting to put it
 * back). Empty map for an unknown label — the send then reports the unresolved
 * variable by name instead of quietly logging in as nobody.
 */
export function apiAuthVars(
  projectId: string,
  label: string,
): Map<string, { value: string; secret: boolean }> {
  const map = new Map<string, { value: string; secret: boolean }>()
  const account = readStore(projectId).find((a) => a.label === slugLabel(label))
  if (!account) return map
  map.set('auth.username', { value: account.username, secret: false })
  if (account.password) map.set('auth.password', { value: account.password, secret: true })
  return map
}
