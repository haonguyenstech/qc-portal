// AI Sync — the GUEST half. Machine B talks to machine A's peer endpoints, works out
// what it is actually missing, and writes only that into its own project folder.
//
// ---------------------------------------------------------------- what "sync" means here
//
// Not a mirror, and deliberately so. A mirror deletes: the second time two QC
// engineers sync, the one who pulled loses the ticket folder they crawled themselves
// that morning, with no way back — there is no trash and no history in a project
// folder. So the rule is ADD AND UPDATE, NEVER DELETE:
//
//   * a file the host has and this machine does not  -> written
//   * a file both have, with different sha256        -> overwritten from the host
//   * a file both have, same sha256                  -> skipped entirely (not even fetched)
//   * a file only this machine has                   -> left exactly where it is
//
// The comparison is a content hash, not mtime. Two machines do not agree on clocks,
// and copying a file forward — which is precisely what this feature does — gives the
// copy a fresh mtime, so "newer wins" would either re-send everything for ever or
// silently skip a real change depending on which way the drift went. A sha256 of the
// bytes has neither failure mode, and it is what makes the second sync of a 2 GB
// project transfer almost nothing.
//
// Every write goes through the same path guard the rest of the portal uses: a member
// path is resolved against the destination root and refused if it lands outside, so a
// hostile or corrupted manifest cannot write into the user's home directory. The
// bytes are streamed to a temp file beside the target and renamed into place, so a
// dropped connection leaves the previous version intact rather than a half file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseClaudeJsonResult, runClaude } from './claudeExec.js'
import {
  formatBytes,
  machineIdentity,
  type MachineIdentity,
  type ManifestEntry,
  type SyncManifest,
} from './aiSync.js'

// ------------------------------------------------------------------ the endpoint

/**
 * Normalise what the QC engineer pasted into a base URL we can append paths to.
 * People paste `foo.trycloudflare.com`, the full URL, or one with a trailing slash
 * and a path they happened to be on — all three must work, because the alternative
 * is a "could not connect" with no clue which of the three was wrong.
 */
export function normalizeEndpoint(raw: string): string {
  let value = (raw ?? '').trim()
  if (!value) throw new Error('Paste the public URL from the other machine.')
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`“${raw}” is not a valid URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The endpoint must be an http:// or https:// URL.')
  }
  // Keep the origin only: the peer API lives at a fixed path, and a pasted
  // `/settings?tab=projects` would otherwise be prefixed onto every call.
  return url.origin
}

/** A peer call that failed in a way worth showing verbatim. */
export class SyncTransportError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message)
    this.name = 'SyncTransportError'
  }
}

const PEER_TIMEOUT_MS = 30_000

async function peerJson<T>(
  endpoint: string,
  route: string,
  init: { method?: string; token?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PEER_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  init.signal?.addEventListener('abort', onAbort)
  let res: Response
  try {
    res = await fetch(`${endpoint}/api/sync/peer${route}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    })
  } catch (err) {
    throw new SyncTransportError(describeNetworkError(err, endpoint), null)
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw new SyncTransportError(peerErrorMessage(res, text), res.status)
  try {
    return JSON.parse(text) as T
  } catch {
    // A tunnel that is up but pointing at something else, or Cloudflare's own error
    // page: an HTML body reaching a JSON parse is the single most confusing failure
    // in this feature, so it gets its own sentence.
    throw new SyncTransportError(
      'That URL answered with a web page instead of the sync API — check it is the other machine’s QC Portal address.',
      res.status,
    )
  }
}

function peerErrorMessage(res: Response, text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: string }
    if (parsed?.error) return parsed.error
  } catch {
    /* not the portal's JSON envelope */
  }
  if (res.status === 401 && /needsUnlock/.test(text)) {
    return 'That portal is locked behind its remote-access password, and the sync endpoints were refused. Update the other machine to a version with AI Sync.'
  }
  if (res.status === 404) {
    return 'No project is open for AI Sync at that address right now — ask the other machine to click “Open to AI Sync”.'
  }
  if (res.status === 502 || res.status === 503 || res.status === 530) {
    return `The tunnel answered ${res.status} — the other machine’s portal is not reachable through it right now.`
  }
  return `${res.status} ${res.statusText}`.trim()
}

function describeNetworkError(err: unknown, endpoint: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/abort/i.test(message)) return `No answer from ${endpoint} within 30 seconds.`
  if (/ENOTFOUND|getaddrinfo/i.test(message)) return `Cannot resolve ${endpoint} — check the address.`
  if (/ECONNREFUSED/i.test(message)) return `${endpoint} refused the connection.`
  // A bare `host:port` is assumed https (the tunnel always is). When that fails on
  // what is clearly a plain-http address, say so — otherwise "fetch failed" is all
  // the engineer gets and the missing four characters are invisible.
  if (endpoint.startsWith('https://') && /:\d+$/.test(new URL(endpoint).host)) {
    return `Could not reach ${endpoint}. That address has a port, so it may be plain HTTP — try it with an explicit http:// prefix.`
  }
  if (/certificate|SSL|TLS/i.test(message)) return `TLS failed talking to ${endpoint}: ${message}`
  return `Could not reach ${endpoint}: ${message}`
}

// ------------------------------------------------------------------ handshake

export interface Handshake {
  token: string
  expiresAt: string
  projectName: string
  syncKey: string
  host: MachineIdentity
  offeredGroups: string[]
  includeMcpSecrets: boolean
}

export function pairWithHost(endpoint: string, code: string, signal?: AbortSignal): Promise<Handshake> {
  return peerJson<Handshake>(endpoint, '/pair', {
    method: 'POST',
    body: { code, peer: machineIdentity() },
    signal,
  })
}

export function fetchManifest(
  endpoint: string,
  token: string,
  groups: readonly string[],
  signal?: AbortSignal,
): Promise<SyncManifest> {
  return peerJson<SyncManifest>(endpoint, '/manifest', {
    method: 'POST',
    token,
    body: { groups },
    signal,
  })
}

/** Best-effort: the host's blocking panel wants to move, but a failed ping must not fail a sync. */
export async function pushProgress(
  endpoint: string,
  token: string,
  progress: Record<string, unknown>,
): Promise<void> {
  try {
    await peerJson(endpoint, '/progress', { method: 'POST', token, body: progress })
  } catch {
    /* the transfer is what matters */
  }
}

/** Tell the host the guest paired but is not going to pull, so it can listen again. */
export async function releaseHost(endpoint: string, token: string): Promise<void> {
  try {
    await peerJson(endpoint, '/release', { method: 'POST', token })
  } catch {
    /* the host's pairing window expires on its own */
  }
}

export async function finishOnHost(
  endpoint: string,
  token: string,
  outcome: { ok: boolean; summary?: string; error?: string },
): Promise<void> {
  try {
    await peerJson(endpoint, '/done', { method: 'POST', token, body: outcome })
  } catch {
    /* the host's session expires on its own */
  }
}

// ------------------------------------------------------------------ the diff

export type SyncAction = 'new' | 'changed' | 'same'

export interface PlannedFile {
  entry: ManifestEntry
  action: SyncAction
}

export interface SyncPlan {
  files: PlannedFile[]
  toTransfer: PlannedFile[]
  newCount: number
  changedCount: number
  sameCount: number
  transferBytes: number
}

function sha256OfFile(abs: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Compare the host's manifest against what is already on this disk. `same` files are
 * never fetched — that is the whole reason the second sync of a big project is fast.
 */
export function planSync(destRoot: string, manifest: SyncManifest): SyncPlan {
  const files: PlannedFile[] = manifest.entries.map((entry) => {
    const abs = safeJoin(destRoot, entry.path)
    if (!fs.existsSync(abs)) return { entry, action: 'new' as const }
    const local = sha256OfFile(abs)
    return { entry, action: local === entry.sha256 ? ('same' as const) : ('changed' as const) }
  })
  const toTransfer = files.filter((f) => f.action !== 'same')
  return {
    files,
    toTransfer,
    newCount: files.filter((f) => f.action === 'new').length,
    changedCount: files.filter((f) => f.action === 'changed').length,
    sameCount: files.filter((f) => f.action === 'same').length,
    transferBytes: toTransfer.reduce((sum, f) => sum + f.entry.size, 0),
  }
}

/** Resolve a manifest path under `root`, refusing anything that escapes it. */
export function safeJoin(root: string, rel: string): string {
  const cleaned = (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (!cleaned || cleaned.split('/').some((seg) => seg === '..' || seg === '')) {
    throw new Error(`refusing unsafe path from the host: ${rel}`)
  }
  const base = path.resolve(root)
  const abs = path.resolve(base, cleaned)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error(`refusing path outside the project folder: ${rel}`)
  }
  return abs
}

// ------------------------------------------------------------------ the transfer

export interface TransferCallbacks {
  onFile: (done: number, total: number, bytesDone: number, entry: ManifestEntry) => void
  log: (level: 'info' | 'success' | 'error', text: string) => void
}

/**
 * Download the planned files into `destRoot`. Streams each one to `<name>.qcsync-tmp`
 * and renames on success, so an interrupted sync never leaves a truncated file where a
 * good one used to be — and re-running picks the rest up, because a file that did land
 * now hashes equal and is skipped.
 */
export async function transferFiles(
  endpoint: string,
  token: string,
  destRoot: string,
  plan: SyncPlan,
  cb: TransferCallbacks,
  signal: AbortSignal,
): Promise<{ written: number; bytes: number; failures: string[] }> {
  let written = 0
  let bytes = 0
  const failures: string[] = []

  for (const file of plan.toTransfer) {
    if (signal.aborted) break
    const { entry } = file
    const abs = safeJoin(destRoot, entry.path)
    const tmp = `${abs}.qcsync-tmp`
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      const res = await fetch(
        `${endpoint}/api/sync/peer/file?path=${encodeURIComponent(entry.path)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal, redirect: 'follow' },
      )
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        throw new Error(peerErrorMessage(res, text))
      }
      // Streamed rather than buffered: one run's evidence folder can hold a several
      // hundred MB screen recording, and `arrayBuffer()` on that is a needless spike.
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), fs.createWriteStream(tmp))
      fs.renameSync(tmp, abs)
      written += 1
      bytes += entry.size
      cb.onFile(written, plan.toTransfer.length, bytes, entry)
    } catch (err) {
      fs.rmSync(tmp, { force: true })
      if (signal.aborted) break
      const message = err instanceof Error ? err.message : String(err)
      failures.push(`${entry.path}: ${message}`)
      cb.log('error', `Failed: ${entry.path} — ${message}`)
      // One unreadable file must not throw away a sync that is 90% done; it is
      // reported at the end and a re-run retries exactly it.
      if (failures.length > 50) {
        throw new Error(`Too many files failed (${failures.length}) — stopping.`)
      }
    }
  }
  return { written, bytes, failures }
}

// ------------------------------------------------------------------ the AI summary

/**
 * The "AI" in AI Sync: a short, human summary of what actually arrived, written by a
 * cheap model from the file list alone (no file CONTENT is sent — the paths already
 * say what changed, and shipping a colleague's ticket notes into a prompt to describe
 * them would be a poor trade).
 *
 * Strictly a garnish. It runs after the files are on disk, never blocks the result,
 * and a missing/failed CLI degrades to a plain counted summary rather than an error —
 * a sync that copied 412 files correctly is a success even if nothing described it.
 */
export async function summarizeSync(opts: {
  rootPath: string
  projectName: string
  hostName: string
  plan: SyncPlan
  written: number
  bytes: number
  model: string
  signal?: AbortSignal
}): Promise<string> {
  const fallback = plainSummary(opts)
  const sample = opts.plan.toTransfer.slice(0, 300).map((f) => `${f.action === 'new' ? '+' : '~'} ${f.entry.path}`)
  if (sample.length === 0) return 'Everything was already up to date — no files needed transferring.'

  const prompt = [
    `You are summarising a QC Portal "AI Sync": QC artifacts pulled from the machine "${opts.hostName}" into the local project "${opts.projectName}".`,
    '',
    `${opts.plan.newCount} new file(s), ${opts.plan.changedCount} updated, ${opts.plan.sameCount} already identical.`,
    `Transferred ${formatBytes(opts.bytes)}.`,
    '',
    'File list (+ = new, ~ = updated, truncated to 300):',
    ...sample,
    '',
    'Write 2-4 short bullet points for a QC engineer saying WHAT changed in their project',
    '(e.g. "3 new tickets: ABC-12, ABC-13, ABC-14", "the qc-testing skill was updated",',
    '"test results for 2 tickets arrived"). Group by area; name real ticket ids and skill',
    'names from the paths. No preamble, no heading, no closing remark. Plain "- " bullets only.',
  ].join('\n')

  try {
    const result = await runClaude(
      ['-p', '--model', opts.model, '--output-format', 'json', '--no-session-persistence', '--max-budget-usd', '0.10'],
      90_000,
      { cwd: opts.rootPath, usageSource: 'ai-sync', model: opts.model, input: prompt, signal: opts.signal },
    )
    if (result.timedOut) return fallback
    const { text, isError } = parseClaudeJsonResult(result.stdout || result.stderr)
    if (result.code !== 0 || isError || !text.trim()) return fallback
    return text.trim()
  } catch {
    return fallback
  }
}

function plainSummary(opts: { plan: SyncPlan; written: number; bytes: number; hostName: string }): string {
  const parts = [
    `- Pulled ${opts.written} file(s) (${formatBytes(opts.bytes)}) from ${opts.hostName}.`,
    `- ${opts.plan.newCount} new, ${opts.plan.changedCount} updated, ${opts.plan.sameCount} already identical.`,
  ]
  return parts.join('\n')
}
