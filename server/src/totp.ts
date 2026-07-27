import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DB_PATH, PORT } from './config.js'

// Authenticator-app (TOTP) codes for test accounts whose 2FA can't be a fixed OTP —
// e.g. a production-like environment where the real six digits come from Google
// Authenticator / Authy on the QC engineer's phone. Given the account's enrollment
// SECRET (the base32 "setup key" behind the QR code), RFC 6238 says the code is a
// pure function of secret + clock, so the portal can compute the very same digits the
// phone shows and a headless run never has to wait for a human.
//
// Storage is deliberately NOT the project's testing/ folder: unlike environments.md,
// a TOTP seed is a long-lived second factor, it must not be committed to the project
// repo, and it must never be swept into a prompt by projectContext.ts. It lives beside
// the portal's own database (0600) and only ever leaves this process as a 6-digit code.

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

const ALGORITHMS: TotpAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

export interface TotpEntry {
  label: string // slug key — used in the API path and named in run prompts
  issuer: string // e.g. "Acme Production" (display only)
  username: string // which account this authenticator belongs to (display only)
  digits: number
  period: number // seconds per code
  algorithm: TotpAlgorithm
  secret: string // base32 seed — NEVER returned by the API
  note: string
  createdAt: string
}

/** What the client sees — everything except the seed. */
export type PublicTotpEntry = Omit<TotpEntry, 'secret'>

export interface TotpCode {
  label: string
  code: string
  /** Seconds until this code rolls over. */
  expiresIn: number
  period: number
}

const DEFAULTS = { digits: 6, period: 30, algorithm: 'SHA1' as TotpAlgorithm }
const MAX_ENTRIES = 40

// ---------------------------------------------------------------- base32 + RFC 6238

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode a base32 secret as authenticator apps present it — spaces and hyphens are
 * cosmetic grouping, case is irrelevant, padding is optional.
 */
export function decodeBase32(input: string): Buffer {
  const clean = input
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase()
  if (!clean) throw new Error('secret is empty')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = B32.indexOf(ch)
    if (idx < 0) throw new Error(`not a valid base32 secret (unexpected character "${ch}")`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (out.length < 10) throw new Error('secret is too short to be an authenticator key')
  return Buffer.from(out)
}

/** Compute the code for a secret at a point in time (RFC 6238 / HOTP truncation). */
export function totpCode(
  secret: string,
  opts: { digits?: number; period?: number; algorithm?: TotpAlgorithm; at?: number } = {},
): { code: string; expiresIn: number; period: number } {
  const digits = opts.digits ?? DEFAULTS.digits
  const period = opts.period ?? DEFAULTS.period
  const algorithm = opts.algorithm ?? DEFAULTS.algorithm
  const at = opts.at ?? Date.now()

  const seconds = Math.floor(at / 1000)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / period)))

  const mac = crypto
    .createHmac(algorithm.toLowerCase(), decodeBase32(secret))
    .update(counter)
    .digest()
  const offset = mac[mac.length - 1] & 0x0f
  const truncated =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3]

  const code = String(truncated % 10 ** digits).padStart(digits, '0')
  return { code, expiresIn: period - (seconds % period), period }
}

// ---------------------------------------------------------------- input parsing

export interface TotpInput {
  label?: string
  issuer?: string
  username?: string
  secret?: string
  digits?: number
  period?: number
  algorithm?: string
  note?: string
}

/**
 * Accept what the authenticator's QR code actually encodes
 * (`otpauth://totp/Issuer:user@x?secret=…&digits=6&period=30`) so the engineer can
 * paste the URI instead of picking the seed out of it. Non-URI input passes through.
 */
export function parseOtpauth(raw: string): TotpInput | null {
  const value = raw.trim()
  if (!/^otpauth:\/\//i.test(value)) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('that otpauth:// link could not be parsed')
  }
  if (url.host.toLowerCase() !== 'totp') {
    throw new Error(`only otpauth://totp links are supported (got "${url.host}")`)
  }
  const secret = url.searchParams.get('secret') ?? ''
  if (!secret) throw new Error('that otpauth:// link has no secret parameter')

  // Path is "/Issuer:account" or just "/account"; the issuer query param wins when present.
  const pathLabel = decodeURIComponent(url.pathname.replace(/^\//, ''))
  const [maybeIssuer, maybeUser] = pathLabel.includes(':')
    ? [pathLabel.slice(0, pathLabel.indexOf(':')), pathLabel.slice(pathLabel.indexOf(':') + 1)]
    : ['', pathLabel]

  const digits = Number(url.searchParams.get('digits') ?? '')
  const period = Number(url.searchParams.get('period') ?? '')
  return {
    issuer: (url.searchParams.get('issuer') ?? maybeIssuer).trim(),
    username: maybeUser.trim(),
    secret,
    digits: Number.isFinite(digits) && digits > 0 ? digits : undefined,
    period: Number.isFinite(period) && period > 0 ? period : undefined,
    algorithm: url.searchParams.get('algorithm') ?? undefined,
  }
}

/** Normalize a human label into the slug used as the key and in the API path. */
export function slugLabel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ---------------------------------------------------------------- store

/** One JSON file per project, next to the portal's database — never inside the project. */
function storeFile(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '') || 'default'
  return path.join(path.dirname(DB_PATH), 'totp', `${safe}.json`)
}

function readStore(projectId: string): TotpEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(projectId), 'utf8'))
    return Array.isArray(parsed?.entries) ? (parsed.entries as TotpEntry[]) : []
  } catch {
    return [] // no authenticators registered yet (or an unreadable/corrupt file)
  }
}

function writeStore(projectId: string, entries: TotpEntry[]): void {
  const file = storeFile(projectId)
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify({ entries }, null, 2), { encoding: 'utf8', mode: 0o600 })
}

const toPublic = ({ secret, ...rest }: TotpEntry): PublicTotpEntry => rest

/** Registered authenticators for a project, seeds stripped. */
export function listTotp(projectId: string): PublicTotpEntry[] {
  return readStore(projectId).map(toPublic)
}

export function hasTotp(projectId: string): boolean {
  return readStore(projectId).length > 0
}

/**
 * Register or replace one authenticator. Throws a user-facing Error on bad input —
 * the seed is validated by actually generating a code with it, so a typo is caught
 * here rather than halfway through a run.
 */
export function upsertTotp(projectId: string, input: TotpInput): PublicTotpEntry {
  const fromUri = input.secret ? parseOtpauth(input.secret) : null
  const merged: TotpInput = fromUri ? { ...fromUri, ...stripEmpty(input), secret: fromUri.secret } : input

  const secret = (merged.secret ?? '').replace(/[\s-]/g, '')
  if (!secret) throw new Error('a secret (base32 setup key or otpauth:// link) is required')

  const digits = clampInt(merged.digits, DEFAULTS.digits, 6, 10)
  const period = clampInt(merged.period, DEFAULTS.period, 15, 300)
  const algorithmRaw = (merged.algorithm ?? DEFAULTS.algorithm).toUpperCase().replace('-', '')
  const algorithm = (ALGORITHMS as string[]).includes(algorithmRaw)
    ? (algorithmRaw as TotpAlgorithm)
    : DEFAULTS.algorithm

  // Validate by using it: a bad base32 seed fails here, not mid-run.
  totpCode(secret, { digits, period, algorithm })

  const label =
    slugLabel(input.label ?? '') ||
    slugLabel([merged.issuer, merged.username].filter(Boolean).join('-')) ||
    'authenticator'

  const entry: TotpEntry = {
    label,
    issuer: (merged.issuer ?? '').trim().slice(0, 120),
    username: (merged.username ?? '').trim().slice(0, 160),
    digits,
    period,
    algorithm,
    secret,
    note: (merged.note ?? '').trim().slice(0, 400),
    createdAt: new Date().toISOString(),
  }

  const entries = readStore(projectId)
  const at = entries.findIndex((e) => e.label === label)
  if (at >= 0) entries[at] = { ...entry, createdAt: entries[at].createdAt }
  else {
    if (entries.length >= MAX_ENTRIES) throw new Error(`too many authenticators (max ${MAX_ENTRIES})`)
    entries.push(entry)
  }
  writeStore(projectId, entries)
  return toPublic(entry)
}

export function deleteTotp(projectId: string, label: string): boolean {
  const slug = slugLabel(label)
  const entries = readStore(projectId)
  const next = entries.filter((e) => e.label !== slug)
  if (next.length === entries.length) return false
  writeStore(projectId, next)
  return true
}

/** The code the phone would be showing right now, or null when the label is unknown. */
export function codeFor(projectId: string, label: string): TotpCode | null {
  const slug = slugLabel(label)
  const entry = readStore(projectId).find((e) => e.label === slug)
  if (!entry) return null
  const { code, expiresIn, period } = totpCode(entry.secret, entry)
  return { label: entry.label, code, expiresIn, period }
}

/** Current code for every registered authenticator (drives the live UI list). */
export function allCodes(projectId: string): TotpCode[] {
  return readStore(projectId).map((entry) => {
    const { code, expiresIn, period } = totpCode(entry.secret, entry)
    return { label: entry.label, code, expiresIn, period }
  })
}

// ---------------------------------------------------------------- prompt hint

/**
 * The paragraph injected into a QC run's prompt so the model knows 2FA is solvable
 * without a human: it fetches the live code from the portal on localhost. Empty when
 * the project has no authenticators, so nothing changes for fixed-OTP environments.
 */
export function totpPromptHint(projectId: string): string {
  const entries = listTotp(projectId)
  if (!entries.length) return ''
  const base = `http://127.0.0.1:${PORT}/api/accounts/totp`
  const lines = entries.map((e) => {
    const who = [e.issuer, e.username].filter(Boolean).join(' · ')
    return `  - \`${e.label}\`${who ? ` — ${who}` : ''}${e.note ? ` (${e.note})` : ''}`
  })
  return (
    `TWO-FACTOR / OTP — some test accounts in this project use an authenticator app, so there is ` +
    `NO fixed OTP and you must never invent, guess, or reuse one. When a login asks for a ` +
    `verification / authenticator / 2FA code, get the real current code from this portal by running:\n` +
    `  curl -s "${base}/<label>/code?projectId=${projectId}"\n` +
    `which returns JSON like {"code":"123456","expiresIn":18}. Registered labels:\n` +
    `${lines.join('\n')}\n` +
    `Use the \`code\` value verbatim and submit it immediately — it is valid only for \`expiresIn\` ` +
    `seconds. If it is rejected or \`expiresIn\` was under 5 when you fetched it, fetch a fresh code ` +
    `and retry once. Treat the code as a secret: do not write it into the report, issues, notes, or ` +
    `any screenshot. If no label matches the account you need, report the login as BLOCKED rather ` +
    `than inventing a code.`
  )
}

// ---------------------------------------------------------------- helpers

function stripEmpty(input: TotpInput): TotpInput {
  const out: TotpInput = {}
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null && v !== '') (out as Record<string, unknown>)[k] = v
  }
  return out
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}
