import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import spawn from 'cross-spawn'
import { DB_PATH } from './config.js'

// Git plumbing for the "Source Code" page: clone a GitHub/Bitbucket repo into a
// project folder (so Claude can read it), pull to refresh, and report status.
//
// SECRETS: the access token is NEVER written to the DB, the git remote
// (.git/config), or any log line. It is persisted only in
// data/source-credentials.json (localhost-only) and injected into git commands
// as an ephemeral argument; every command's output is scrubbed before it is
// surfaced. Mirrors how ClickUp tokens are kept out of the DB/logs.

export type SourceProvider = 'github' | 'bitbucket' | 'other'

export interface ParsedRepo {
  /** Tokenless https URL we persist + show (any embedded credentials stripped). */
  cleanUrl: string
  provider: SourceProvider
  host: string
}

export interface RepoStatus {
  isRepo: boolean
  branch: string
  /** "<shortSha> <subject>" of HEAD, or '' if unknown. */
  lastCommit: string
  /** Tokenless origin URL read from the clone, or '' if none. */
  remoteUrl: string
}

export interface SourceCredential {
  token: string
  username?: string
}

export interface GitLogLine {
  level: 'info' | 'success' | 'error'
  text: string
}

// ---------------- credential store (on disk, never in the DB / logs) ----------------

const CREDS_FILE = path.join(path.dirname(DB_PATH), 'source-credentials.json')

function readAllCreds(): Record<string, SourceCredential> {
  try {
    const raw = fs.readFileSync(CREDS_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeAllCreds(all: Record<string, SourceCredential>): void {
  fs.mkdirSync(path.dirname(CREDS_FILE), { recursive: true })
  fs.writeFileSync(CREDS_FILE, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(CREDS_FILE, 0o600) // tighten if the file pre-existed with looser perms
  } catch {
    /* best-effort on platforms without chmod semantics */
  }
}

export function getSourceCredential(projectId: string): SourceCredential | undefined {
  const cred = readAllCreds()[projectId]
  return cred?.token ? cred : undefined
}

export function setSourceCredential(projectId: string, cred: SourceCredential): void {
  const all = readAllCreds()
  all[projectId] = cred
  writeAllCreds(all)
}

export function deleteSourceCredential(projectId: string): void {
  const all = readAllCreds()
  if (projectId in all) {
    delete all[projectId]
    writeAllCreds(all)
  }
}

// ---------------- url parsing + auth ----------------

/**
 * Validate and normalize a repo URL. Accepts https URLs and `git@host:owner/repo`
 * SSH shorthand (converted to https, since token auth needs https). Strips any
 * embedded credentials so we never persist a token inside the URL.
 */
export function parseRepoUrl(input: string): ParsedRepo {
  const raw = (input ?? '').trim()
  if (!raw) throw new Error('Repository URL is required')

  let url: URL
  const ssh = raw.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (ssh) {
    url = new URL(`https://${ssh[1]}/${ssh[2]}.git`)
  } else {
    try {
      url = new URL(raw)
    } catch {
      throw new Error('Enter a valid https repository URL (e.g. https://github.com/owner/repo.git)')
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Only https repository URLs are supported')
    }
  }

  // Strip any embedded credentials (user:pass@) — we never persist tokens in the URL.
  url.username = ''
  url.password = ''

  const host = url.hostname.toLowerCase()
  const provider: SourceProvider = host.includes('github')
    ? 'github'
    : host.includes('bitbucket')
      ? 'bitbucket'
      : 'other'

  // Normalize path: ensure a single trailing .git, no trailing slash.
  let pathname = url.pathname.replace(/\/+$/, '')
  if (!/\.git$/i.test(pathname)) pathname += '.git'
  url.pathname = pathname

  return { cleanUrl: url.toString(), provider, host }
}

/** Build an authed https URL by injecting the token (ephemeral — never persisted). */
function buildAuthedUrl(parsed: ParsedRepo, cred: SourceCredential): string {
  const url = new URL(parsed.cleanUrl)
  const token = cred.token

  // Atlassian *account* API tokens (prefix "ATAT…", created at id.atlassian.com)
  // authenticate Bitbucket git over HTTPS only via the static username
  // `x-bitbucket-api-token-auth` (or the account email). The Bitbucket username
  // does NOT work with them, so force the static user even if one was supplied.
  const isAtlassianApiToken = /^ATAT/i.test(token)

  if (parsed.provider === 'bitbucket' && isAtlassianApiToken) {
    url.username = 'x-bitbucket-api-token-auth'
    url.password = encodeURIComponent(token)
  } else if (cred.username) {
    // Username + token/app-password (Bitbucket app passwords work this way).
    url.username = encodeURIComponent(cred.username)
    url.password = encodeURIComponent(token)
  } else if (parsed.provider === 'github') {
    url.username = 'x-access-token'
    url.password = encodeURIComponent(token)
  } else if (parsed.provider === 'bitbucket') {
    // Repository/Workspace/Project *access* tokens ("ATCTT…") use this static user.
    url.username = 'x-token-auth'
    url.password = encodeURIComponent(token)
  } else {
    url.password = encodeURIComponent(token)
  }
  return url.toString()
}

/**
 * Human-readable description of the auth scheme used — for the job log so a failed
 * clone shows WHICH method was tried. Never includes the token; usernames are
 * generalized (they may be an email) rather than echoed.
 */
function authSchemeLabel(parsed: ParsedRepo, cred?: SourceCredential): string {
  if (!cred?.token) return 'no credentials (public clone)'
  if (parsed.provider === 'bitbucket' && /^ATAT/i.test(cred.token)) {
    return 'Bitbucket API token (user: x-bitbucket-api-token-auth)'
  }
  if (cred.username) return 'supplied username + token/app-password'
  if (parsed.provider === 'github') return 'GitHub token (user: x-access-token)'
  if (parsed.provider === 'bitbucket') return 'Bitbucket access token (user: x-token-auth)'
  return 'token'
}

/** Remove the token (and an authed URL containing it) from any text we log/return. */
function scrub(text: string, cred?: SourceCredential): string {
  let out = text
  if (cred?.token) out = out.split(cred.token).join('***').split(encodeURIComponent(cred.token)).join('***')
  // Belt-and-braces: redact any `user:secret@host` that slipped through.
  out = out.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1***@')
  return out
}

// ---------------- git command runner ----------------

interface RunGitOpts {
  cwd?: string
  cred?: SourceCredential // only for scrubbing output — never logged directly
  onLog?: (line: GitLogLine) => void
  /** Human-safe label for the log (never contains the authed URL). */
  label?: string
}

// Git emits a progress tick (Enumerating/Counting/Compressing/Receiving/Resolving)
// every few hundred objects. On a big repo that's hundreds of near-identical lines.
// Keep only each phase's final "…, done." milestone; drop the intermediate ticks.
const PROGRESS_PHASE = /^(remote:\s*)?(Enumerating|Counting|Compressing|Receiving|Resolving|Unpacking) objects:/i
function isNoisyProgress(line: string): boolean {
  return PROGRESS_PHASE.test(line) && !/done\.?\s*$/i.test(line)
}

function runGit(args: string[], opts: RunGitOpts): Promise<string> {
  return new Promise((resolve, reject) => {
    if (opts.label) opts.onLog?.({ level: 'info', text: opts.label })
    const child = spawn('git', args, {
      cwd: opts.cwd,
      // Never prompt for credentials interactively — fail fast instead of hanging.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      windowsHide: true, // no console window flash on Windows (server runs console-less)
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', (d) => {
      const chunk = scrub(d.toString(), opts.cred)
      stderr += chunk
      // Split on CR too — git separates progress ticks with bare \r.
      for (const line of chunk.split(/[\r\n]+/)) {
        const t = line.trim()
        if (t && !isNoisyProgress(t)) opts.onLog?.({ level: 'info', text: `  ${t}` })
      }
    })
    child.on('error', (err) => {
      const msg =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'git is not installed or not on PATH'
          : scrub(err.message, opts.cred)
      reject(new Error(msg))
    })
    child.on('close', (code) => {
      if (code === 0) return resolve(stdout)
      const detail = scrub(stderr.trim() || stdout.trim(), opts.cred) || `git exited with code ${code}`
      reject(new Error(detail))
    })
  })
}

// ---------------- status helpers ----------------

function isGitRepo(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, '.git')).isDirectory()
  } catch {
    return false
  }
}

/** True when a directory is empty or absent (safe to `git clone` into). */
function isEmptyOrAbsent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0
  } catch {
    return true // doesn't exist
  }
}

export async function repoStatus(dir: string): Promise<RepoStatus> {
  if (!isGitRepo(dir)) {
    return { isRepo: false, branch: '', lastCommit: '', remoteUrl: '' }
  }
  const safe = async (args: string[]) => {
    try {
      return (await runGit(args, { cwd: dir })).trim()
    } catch {
      return ''
    }
  }
  const branch = await safe(['rev-parse', '--abbrev-ref', 'HEAD'])
  const lastCommit = await safe(['log', '-1', '--format=%h %s'])
  const remoteUrl = scrub(await safe(['remote', 'get-url', 'origin']))
  return { isRepo: true, branch, lastCommit, remoteUrl }
}

// ---------------- clone + pull ----------------

export interface CloneInput {
  rootPath: string
  parsed: ParsedRepo
  branch?: string
  cred?: SourceCredential
  onLog?: (line: GitLogLine) => void
}

export interface CloneResult {
  sourcePath: string
  branch: string
  lastCommit: string
}

/** Compare two repo URLs ignoring scheme noise, trailing slashes, and `.git`. */
function sameRemote(a: string, parsed: ParsedRepo): boolean {
  try {
    return parseRepoUrl(a).cleanUrl.toLowerCase() === parsed.cleanUrl.toLowerCase()
  } catch {
    return false
  }
}

/** Adopt an existing checkout (optionally switching branch); never clones. */
async function adoptRepo(
  dir: string,
  branch: string | undefined,
  cred: SourceCredential | undefined,
  onLog?: (line: GitLogLine) => void,
): Promise<CloneResult> {
  onLog?.({ level: 'info', text: `Found an existing git checkout at ${dir} — adopting it.` })
  if (branch) {
    try {
      await runGit(['checkout', branch], { cwd: dir, cred, onLog, label: `git checkout ${branch}` })
    } catch (err) {
      onLog?.({ level: 'info', text: `  (could not switch branch: ${(err as Error).message})` })
    }
  }
  const status = await repoStatus(dir)
  return { sourcePath: dir, branch: status.branch, lastCommit: status.lastCommit }
}

/** Run `git clone <authed> <targetDir>` then reset the stored remote to tokenless. */
async function cloneInto(
  targetDir: string,
  parsed: ParsedRepo,
  branch: string | undefined,
  cred: SourceCredential | undefined,
  onLog?: (line: GitLogLine) => void,
): Promise<void> {
  const authed = cred ? buildAuthedUrl(parsed, cred) : parsed.cleanUrl
  onLog?.({ level: 'info', text: `Auth: ${authSchemeLabel(parsed, cred)}` })
  const args = ['clone', '--progress']
  if (branch) args.push('--branch', branch)
  args.push(authed, targetDir)
  // label shows the clean URL; `authed` (with token) lives only in `args`, never logged.
  await runGit(args, {
    cred,
    onLog,
    label: `git clone ${parsed.cleanUrl}${branch ? ` (branch ${branch})` : ''} → ${targetDir}`,
  })
  // Persist a TOKENLESS remote so the token never lands in .git/config.
  await runGit(['remote', 'set-url', 'origin', parsed.cleanUrl], { cwd: targetDir, cred })
}

/**
 * Connect a repo to a project:
 *  - the project root is already a git checkout → adopt it (never destroy the root);
 *  - the root is empty → clone straight into it (the root becomes the source);
 *  - otherwise clone into <root>/source (kept apart from testing/ output). If that
 *    folder already holds the SAME repo we adopt it; a DIFFERENT repo is replaced
 *    via a temp-dir swap so a failed re-clone never wipes the working checkout.
 */
export async function cloneSource(input: CloneInput): Promise<CloneResult> {
  const { rootPath, parsed, branch, cred, onLog } = input

  if (isGitRepo(rootPath)) {
    const result = await adoptRepo(rootPath, branch, cred, onLog)
    onLog?.({ level: 'success', text: `Source ready at ${rootPath}` })
    return result
  }

  // Clone straight into an empty/new project root.
  if (isEmptyOrAbsent(rootPath)) {
    await cloneInto(rootPath, parsed, branch, cred, onLog)
    const status = await repoStatus(rootPath)
    onLog?.({ level: 'success', text: `Source ready at ${rootPath}` })
    return { sourcePath: rootPath, branch: status.branch, lastCommit: status.lastCommit }
  }

  const sub = path.join(rootPath, 'source')
  if (isGitRepo(sub)) {
    const status = await repoStatus(sub)
    if (sameRemote(status.remoteUrl, parsed)) {
      const result = await adoptRepo(sub, branch, cred, onLog)
      onLog?.({ level: 'success', text: `Source ready at ${sub}` })
      return result
    }
    // A different repo is requested — replace our managed source/ via temp swap.
    onLog?.({ level: 'info', text: `Replacing existing source at ${sub} with the new repository.` })
    const tmp = path.join(rootPath, `.source-incoming-${randomUUID()}`)
    try {
      await cloneInto(tmp, parsed, branch, cred, onLog)
    } catch (err) {
      fs.rmSync(tmp, { recursive: true, force: true })
      throw err
    }
    fs.rmSync(sub, { recursive: true, force: true })
    fs.renameSync(tmp, sub)
    const fresh = await repoStatus(sub)
    onLog?.({ level: 'success', text: `Source ready at ${sub}` })
    return { sourcePath: sub, branch: fresh.branch, lastCommit: fresh.lastCommit }
  }

  if (!isEmptyOrAbsent(sub)) {
    throw new Error(
      `${sub} already exists and is not an empty folder or a git repo. ` +
        'Remove it or disconnect the existing source first.',
    )
  }

  await cloneInto(sub, parsed, branch, cred, onLog)
  const status = await repoStatus(sub)
  onLog?.({ level: 'success', text: `Source ready at ${sub}` })
  return { sourcePath: sub, branch: status.branch, lastCommit: status.lastCommit }
}

export interface PullInput {
  sourcePath: string
  parsed: ParsedRepo
  branch?: string
  cred?: SourceCredential
  onLog?: (line: GitLogLine) => void
}

export async function pullSource(input: PullInput): Promise<CloneResult> {
  const { sourcePath, parsed, branch, cred, onLog } = input
  if (!isGitRepo(sourcePath)) {
    throw new Error(`No git checkout found at ${sourcePath} — reconnect the source.`)
  }
  // Pull straight from an authed URL passed as an argument so the stored remote
  // stays tokenless. Fast-forward only to avoid surprise merge commits.
  const authed = cred ? buildAuthedUrl(parsed, cred) : parsed.cleanUrl
  const args = ['pull', '--ff-only', '--progress', authed]
  if (branch) args.push(branch)
  await runGit(args, {
    cwd: sourcePath,
    cred,
    onLog,
    label: `git pull --ff-only ${parsed.cleanUrl}${branch ? ` ${branch}` : ''}`,
  })
  const status = await repoStatus(sourcePath)
  onLog?.({ level: 'success', text: `Synced — now at ${status.lastCommit || status.branch}` })
  return { sourcePath, branch: status.branch, lastCommit: status.lastCommit }
}
