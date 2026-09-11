// AI Sync — the guest's job registry. Same shape and same reason as `crawlJobs.ts`
// and `responsiveJobs.ts`: a sync is minutes of work, so holding the HTTP request
// open would throw it away on a browser reload. The page gets an id and polls it.
//
// This one has an extra state the others don't: `ready`. Pairing (which burns the
// 4-digit code) happens as soon as the engineer clicks Connect, but the transfer must
// not — between the two, they have to see WHAT they are about to pull and pick where
// it lands. So the job is created by the handshake, parks in `ready` holding the
// bearer token, and a second call starts the work. The token never reaches the
// browser: it lives here, in memory, for the life of the job.

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  createProject,
  ensureSyncKey,
  findProjectBySyncKey,
  getProject,
  listProjects,
  updateProject,
} from './db.js'
import { ALL_GROUP_KEYS, formatBytes, machineIdentity, type MachineIdentity } from './aiSync.js'
import {
  fetchManifest,
  finishOnHost,
  releaseHost,
  normalizeEndpoint,
  pairWithHost,
  planSync,
  pushProgress,
  summarizeSync,
  transferFiles,
  type SyncPlan,
} from './syncPull.js'
import type { Project } from './types.js'

export type SyncJobStatus = 'pairing' | 'ready' | 'running' | 'done' | 'error' | 'cancelled'
export type SyncLogLevel = 'info' | 'success' | 'error'

export interface SyncLogLine {
  time: string
  level: SyncLogLevel
  text: string
}

/** A project on THIS machine that the incoming one appears to be a copy of. */
export interface SyncMatch {
  projectId: string
  name: string
  rootPath: string
  /** How we decided. `syncKey` is certain; `name` is a guess the user confirms. */
  by: 'syncKey' | 'name'
}

/** Where the pulled files land. Chosen after the handshake, before the transfer. */
export type SyncTarget =
  | { mode: 'existing'; projectId: string }
  | { mode: 'new'; name: string; parentPath: string }

export interface SyncProgress {
  phase: 'pairing' | 'manifest' | 'compare' | 'transfer' | 'summary' | 'finished'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  message: string
}

export interface PublicSyncJob {
  id: string
  status: SyncJobStatus
  endpoint: string
  /** Who we paired with — drawn as the far end of the connection line. */
  host: MachineIdentity | null
  self: MachineIdentity
  /** The host's project name + identity, from the handshake. */
  remoteProjectName: string
  remoteSyncKey: string
  offeredGroups: string[]
  /** True when the host chose NOT to share MCP credentials, so the UI can say so. */
  mcpScrubbed: boolean
  /** An existing local project this looks like — the duplicate-import answer. */
  match: SyncMatch | null
  target: SyncTarget | null
  /** Filled once the target project exists (created or matched). */
  projectId: string | null
  projectName: string
  rootPath: string
  groups: string[]
  plan: {
    newCount: number
    changedCount: number
    sameCount: number
    transferBytes: number
    /** Per group, so the picker can show "Tickets — 41 files, 18 MB". */
    byGroup: { group: string; files: number; bytes: number }[]
  } | null
  progress: SyncProgress
  logs: SyncLogLine[]
  /** The AI's account of what arrived, once the files are down. */
  summary: string
  /** Files that could not be fetched. A sync with these is reported as partial, never clean. */
  failures: string[]
  error: string | null
  createdAt: string
  updatedAt: string
}

interface SyncJob extends PublicSyncJob {
  token: string
  abort: AbortController
}

const jobs = new Map<string, SyncJob>()
const MAX_JOBS = 20
const MAX_LOG_LINES = 400

const nowIso = () => new Date().toISOString()

function toPublic(j: SyncJob): PublicSyncJob {
  const { token: _token, abort: _abort, ...rest } = j
  return { ...rest, logs: rest.logs.map((l) => ({ ...l })) }
}

function log(job: SyncJob, level: SyncLogLevel, text: string): void {
  job.logs.push({ time: nowIso(), level, text })
  if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES)
  job.updatedAt = nowIso()
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return
  const finished = [...jobs.values()]
    .filter((j) => j.status === 'done' || j.status === 'error' || j.status === 'cancelled')
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  while (jobs.size > MAX_JOBS && finished.length) jobs.delete(finished.shift()!.id)
}

export function getSyncJob(id: string): PublicSyncJob | null {
  const j = jobs.get(id)
  return j ? toPublic(j) : null
}

export function listSyncJobs(): PublicSyncJob[] {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(toPublic)
}

/**
 * The one job the always-mounted watcher blocks the UI for, if any. `pairing` is
 * deliberately NOT included: it is a single HTTP call the pull dialog already shows a
 * spinner for, and covering the screen for it would flash an overlay over the form the
 * engineer is still filling in.
 */
export function activeSyncJob(): PublicSyncJob | null {
  const live = [...jobs.values()].find((j) => j.status === 'running')
  return live ? toPublic(live) : null
}

export function cancelSyncJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job) return false
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return false
  job.abort.abort()
  job.status = 'cancelled'
  job.updatedAt = nowIso()
  log(job, 'error', 'Cancelled.')
  void finishOnHost(job.endpoint, job.token, { ok: false, error: 'The other machine cancelled the sync.' })
  return true
}

/**
 * Drop a job. A job that is still `ready` was paired but never started, so the host is
 * holding a pairing window open for a peer that has gone — tell it, or it waits out
 * the full TTL showing a machine that is not coming back.
 */
export function dismissSyncJob(id: string): void {
  const job = jobs.get(id)
  if (!job) return
  if (job.status === 'running' || job.status === 'pairing') return
  if (job.status === 'ready' && job.token) void releaseHost(job.endpoint, job.token)
  jobs.delete(id)
}

// ------------------------------------------------------------------ step 1: connect

/**
 * Pair with the host and park. Burns one of the host's five code attempts, so a
 * failure here deletes the job rather than leaving a dead row the user might retry
 * by reflex.
 */
export async function connectSync(endpointRaw: string, code: string): Promise<PublicSyncJob> {
  const endpoint = normalizeEndpoint(endpointRaw)
  const digits = (code ?? '').trim()
  if (!/^\d{4}$/.test(digits)) throw new Error('The security code is 4 digits.')

  const job: SyncJob = {
    id: randomUUID(),
    status: 'pairing',
    endpoint,
    host: null,
    self: machineIdentity(),
    remoteProjectName: '',
    remoteSyncKey: '',
    offeredGroups: [],
    mcpScrubbed: false,
    match: null,
    target: null,
    projectId: null,
    projectName: '',
    rootPath: '',
    groups: [],
    plan: null,
    progress: {
      phase: 'pairing',
      filesDone: 0,
      filesTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      message: 'Connecting…',
    },
    logs: [],
    summary: '',
    failures: [],
    error: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    token: '',
    abort: new AbortController(),
  }
  jobs.set(job.id, job)
  prune()
  log(job, 'info', `Connecting to ${endpoint}…`)

  try {
    const shake = await pairWithHost(endpoint, digits, job.abort.signal)
    job.token = shake.token
    job.host = shake.host
    job.remoteProjectName = shake.projectName
    job.remoteSyncKey = shake.syncKey
    job.offeredGroups = shake.offeredGroups
    job.mcpScrubbed = !shake.includeMcpSecrets
    job.match = findMatch(shake.syncKey, shake.projectName)
    job.groups = [...shake.offeredGroups]
    job.status = 'ready'
    job.progress = { ...job.progress, phase: 'manifest', message: 'Connected.' }
    log(job, 'success', `Paired with ${shake.host.name} — project “${shake.projectName}”.`)
    if (job.match) {
      log(
        job,
        'info',
        job.match.by === 'syncKey'
          ? `This is the same project as your local “${job.match.name}” — it will be updated, not duplicated.`
          : `You already have a project named “${job.match.name}” — check the destination before syncing.`,
      )
    }
    return toPublic(job)
  } catch (err) {
    jobs.delete(job.id)
    throw err
  }
}

/**
 * Which local project the incoming one IS. A sync key is definitive — it was minted
 * once and copied by the first sync. A name match is only a hint, which is why it is
 * reported with `by` rather than acted on: two unrelated repos really can both be
 * called "Portal".
 */
function findMatch(syncKey: string, projectName: string): SyncMatch | null {
  const byKey = findProjectBySyncKey(syncKey)
  if (byKey) {
    return { projectId: byKey.id, name: byKey.name, rootPath: byKey.rootPath, by: 'syncKey' }
  }
  const needle = projectName.trim().toLowerCase()
  const byName = listProjects().find((p) => p.name.trim().toLowerCase() === needle)
  if (byName) {
    return { projectId: byName.id, name: byName.name, rootPath: byName.rootPath, by: 'name' }
  }
  return null
}

// ------------------------------------------------------------------ step 2: run it

export function startSync(id: string, groups: string[], target: SyncTarget): PublicSyncJob {
  const job = jobs.get(id)
  if (!job) throw new Error('That sync session is gone — connect again.')
  if (job.status !== 'ready') throw new Error(`This sync is ${job.status}, not ready to start.`)

  const allowed = new Set(job.offeredGroups.length ? job.offeredGroups : ALL_GROUP_KEYS)
  const wanted = groups.filter((g) => allowed.has(g))
  if (wanted.length === 0) throw new Error('Pick at least one thing to sync.')

  const project = resolveTarget(target)
  // Refuse a project pulling from ITSELF. Only reachable when the endpoint points back
  // at this same portal (testing, or a pasted-back-in URL), but the damage is real and
  // silent: the manifest's scrubbed `.mcp.json` would be written over the live one, so
  // "sync" would delete the machine's own API keys. Same machine + same sync identity
  // is exactly that case, and nothing legitimate looks like it.
  if (
    job.host &&
    job.host.id === job.self.id &&
    job.remoteSyncKey &&
    project.syncKey === job.remoteSyncKey
  ) {
    throw new Error(
      `“${project.name}” is the project being shared — a project cannot sync from itself. ` +
        'Pick a different destination, or point the endpoint at the other machine.',
    )
  }
  job.projectId = project.id
  job.projectName = project.name
  job.rootPath = project.rootPath
  job.target = target
  job.groups = wanted
  job.status = 'running'
  job.updatedAt = nowIso()
  log(job, 'info', `Syncing into ${project.rootPath}`)

  void run(job).catch((err) => {
    job.status = 'error'
    job.error = err instanceof Error ? err.message : String(err)
    job.updatedAt = nowIso()
    log(job, 'error', job.error)
    void finishOnHost(job.endpoint, job.token, { ok: false, error: job.error })
  })
  return toPublic(job)
}

/**
 * The destination project — matched, or created. A NEW project's folder is created
 * here rather than by the extract, so a sync that fails at the first byte still
 * leaves a registered, empty, openable project instead of a row pointing at nothing.
 */
function resolveTarget(target: SyncTarget): Project {
  if (target.mode === 'existing') {
    const project = getProject(target.projectId)
    if (!project) throw new Error('That project no longer exists.')
    if (!fs.existsSync(project.rootPath)) {
      throw new Error(`The folder for “${project.name}” is missing: ${project.rootPath}`)
    }
    return project
  }
  const name = (target.name ?? '').trim()
  if (!name) throw new Error('Give the new project a name.')
  const parent = path.resolve((target.parentPath ?? '').trim())
  if (!parent || !isDir(parent)) throw new Error(`Not a folder: ${target.parentPath}`)
  const folder = safeFolderName(name)
  if (!folder) throw new Error('That project name has no characters a folder can use.')
  const dest = path.join(parent, folder)
  // An existing folder here is fine and is NOT an error: the whole point of this
  // feature is that the second sync writes into the folder the first one made. The
  // duplicate question was answered before we got here (`match` / the target choice).
  fs.mkdirSync(dest, { recursive: true })
  return createProject(name, dest, false)
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

const safeFolderName = (name: string): string =>
  name
    .trim()
    .replace(/[/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)

async function run(job: SyncJob): Promise<void> {
  const setProgress = (patch: Partial<SyncProgress>): void => {
    job.progress = { ...job.progress, ...patch }
    job.updatedAt = nowIso()
  }

  // ---- manifest
  setProgress({ phase: 'manifest', message: 'Asking what the other machine has…' })
  void pushProgress(job.endpoint, job.token, { phase: 'manifest', message: 'Reading the manifest' })
  const manifest = await fetchManifest(job.endpoint, job.token, job.groups, job.abort.signal)
  log(job, 'info', `Manifest: ${manifest.entries.length} file(s), ${formatBytes(manifest.totalBytes)}.`)
  if (manifest.mcpScrubbed) {
    log(job, 'info', 'MCP credentials were NOT shared — fill the API keys in on the MCP page after this.')
  }

  // ---- compare
  setProgress({ phase: 'compare', message: 'Comparing with what you already have…' })
  const plan = planSync(job.rootPath, manifest)
  job.plan = {
    newCount: plan.newCount,
    changedCount: plan.changedCount,
    sameCount: plan.sameCount,
    transferBytes: plan.transferBytes,
    byGroup: groupBreakdown(plan),
  }
  setProgress({
    filesTotal: plan.toTransfer.length,
    bytesTotal: plan.transferBytes,
    message: `${plan.newCount} new, ${plan.changedCount} updated, ${plan.sameCount} already identical.`,
  })
  log(
    job,
    'info',
    `${plan.newCount} new, ${plan.changedCount} updated, ${plan.sameCount} identical — transferring ${formatBytes(plan.transferBytes)}.`,
  )

  // ---- transfer
  setProgress({ phase: 'transfer', message: 'Transferring…' })
  let lastPush = 0
  const { written, bytes, failures } = await transferFiles(
    job.endpoint,
    job.token,
    job.rootPath,
    plan,
    {
      onFile: (done, total, bytesDone, entry) => {
        setProgress({
          filesDone: done,
          filesTotal: total,
          bytesDone,
          message: `${done} of ${total} — ${entry.path}`,
        })
        // Throttled: the host only needs a moving bar, not one HTTP call per file.
        const now = Date.now()
        if (now - lastPush > 700) {
          lastPush = now
          void pushProgress(job.endpoint, job.token, {
            phase: 'transfer',
            filesDone: done,
            filesTotal: total,
            bytesDone,
            bytesTotal: plan.transferBytes,
            message: entry.path,
          })
        }
      },
      log: (level, text) => log(job, level, text),
    },
    job.abort.signal,
  )
  job.failures = failures
  if (job.abort.signal.aborted) {
    job.status = 'cancelled'
    job.updatedAt = nowIso()
    return
  }
  log(job, 'success', `Wrote ${written} file(s), ${formatBytes(bytes)}.`)

  // ---- identity: this is what makes the NEXT sync an update instead of a duplicate
  if (job.projectId && manifest.syncKey) {
    const existing = findProjectBySyncKey(manifest.syncKey)
    if (!existing || existing.id === job.projectId) {
      updateProject(job.projectId, { syncKey: manifest.syncKey })
    } else {
      // Two local projects cannot share one key, or the next match is a coin toss.
      log(job, 'info', `“${existing.name}” already carries this project's sync identity, so it was left with it.`)
      ensureSyncKey(job.projectId)
    }
  }

  // ---- the AI summary (never fatal)
  setProgress({ phase: 'summary', message: 'Summarising what changed…' })
  void pushProgress(job.endpoint, job.token, { phase: 'summary', message: 'Summarising' })
  const project = job.projectId ? getProject(job.projectId) : undefined
  job.summary = await summarizeSync({
    rootPath: job.rootPath,
    projectName: job.projectName,
    hostName: job.host?.name ?? 'the other machine',
    plan,
    written,
    bytes,
    model: project?.autoLearnModel || 'haiku',
    signal: job.abort.signal,
  })

  job.status = failures.length ? 'error' : 'done'
  job.error = failures.length
    ? `${failures.length} file(s) could not be transferred — re-run the sync to retry just those.`
    : null
  setProgress({ phase: 'finished', message: job.error ?? 'Sync complete.' })
  log(job, job.failures.length ? 'error' : 'success', job.error ?? 'Sync complete.')
  await finishOnHost(job.endpoint, job.token, {
    ok: !failures.length,
    summary: job.summary,
    error: job.error ?? undefined,
  })
}

function groupBreakdown(plan: SyncPlan): { group: string; files: number; bytes: number }[] {
  const map = new Map<string, { group: string; files: number; bytes: number }>()
  for (const file of plan.files) {
    const row = map.get(file.entry.group) ?? { group: file.entry.group, files: 0, bytes: 0 }
    row.files += 1
    row.bytes += file.entry.size
    map.set(file.entry.group, row)
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes)
}
