import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { syncContextPointer } from '../contextPointer.js'
import { testingDirFor } from '../config.js'
import { deleteAccounts, readAccounts, writeAccounts } from '../accountsStore.js'
import { allCodes, codeFor, deleteTotp, listTotp, upsertTotp } from '../totp.js'

export const accountsRouter = Router()

// Environments & test accounts: a single per-project sheet (testing/environments.md)
// of app URLs + non-production test-account credentials the QC run uses to log in.
// Uploaded as CSV/Excel (converted to a markdown table in the browser) or edited by
// hand. Injected into generation/QC prompts (projectContext.ts) and pointed at from
// CLAUDE.md (contextPointer.ts) so login/setup steps use the real environment + account.

// Authenticator (TOTP) codes live alongside the sheet: environments.md documents WHICH
// account to use, these routes hand out the real 2FA digits for it. Registered under
// /totp so they can't collide with the sheet routes above. The seed never leaves the
// server — only a 6-digit code does, and only to localhost.

/** GET /api/accounts/totp — registered authenticators (no secrets). */
accountsRouter.get('/totp', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ entries: listTotp(project.id) })
})

/** GET /api/accounts/totp/codes — current code for every authenticator (drives the live UI). */
accountsRouter.get('/totp/codes', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json({ codes: allCodes(project.id) })
})

/**
 * PUT /api/accounts/totp — register/replace one authenticator.
 * Body: { label?, issuer?, username?, secret, digits?, period?, algorithm?, note? }.
 * `secret` accepts a base32 setup key OR the whole `otpauth://totp/…` QR link.
 */
accountsRouter.put('/totp', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  try {
    const entry = upsertTotp(project.id, req.body ?? {})
    syncContextPointer(project.rootPath) // surface the "how to get a 2FA code" bullet in CLAUDE.md
    res.json({ entry })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not save that key' })
  }
})

/** DELETE /api/accounts/totp/:label — forget one authenticator (removes its seed). */
accountsRouter.delete('/totp/:label', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  if (!deleteTotp(project.id, req.params.label)) {
    return res.status(404).json({ error: 'no authenticator with that label' })
  }
  syncContextPointer(project.rootPath)
  res.json({ ok: true })
})

/**
 * GET /api/accounts/totp/:label/code — the code the phone would be showing right now.
 * This is what a QC run curls when a login asks for a 2FA code (see totpPromptHint).
 * Deliberately unlogged: the response body is a live credential.
 */
accountsRouter.get('/totp/:label/code', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const code = codeFor(project.id, req.params.label)
  if (!code) {
    return res.status(404).json({
      error: `no authenticator labeled "${req.params.label}" for this project`,
      available: listTotp(project.id).map((e) => e.label),
    })
  }
  res.set('Cache-Control', 'no-store')
  res.json(code)
})

/** GET /api/accounts — the stored sheet (content + metadata). */
accountsRouter.get('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(readAccounts(project.rootPath))
})

/** PUT /api/accounts — create/overwrite (blank content clears it). Body: { content }. */
accountsRouter.put('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const content = typeof req.body?.content === 'string' ? req.body.content : ''
  const result = writeAccounts(project.rootPath, content)
  if (!result) return res.status(413).json({ error: 'sheet too large (256 KB max)' })
  syncContextPointer(project.rootPath)
  res.json(result)
})

/** DELETE /api/accounts — remove the sheet. */
accountsRouter.delete('/', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  deleteAccounts(project.rootPath)
  syncContextPointer(project.rootPath)
  res.json({ ok: true })
})

/**
 * POST /api/accounts/open — reveal the project's testing/ folder (where
 * environments.md lives) in the OS file explorer. Creates it first if missing.
 */
accountsRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const dir = testingDirFor(project.rootPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'failed to create testing folder' })
  }
  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})
