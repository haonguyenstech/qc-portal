import { Router } from 'express'
import fs from 'node:fs'
import { resolveProject } from '../projectScope.js'
import { revealFolderNative } from '../folderPicker.js'
import { syncContextPointer } from '../contextPointer.js'
import { testingDirFor } from '../config.js'
import { deleteAccounts, readAccounts, writeAccounts } from '../accountsStore.js'

export const accountsRouter = Router()

// Environments & test accounts: a single per-project sheet (testing/environments.md)
// of app URLs + non-production test-account credentials the QC run uses to log in.
// Uploaded as CSV/Excel (converted to a markdown table in the browser) or edited by
// hand. Injected into generation/QC prompts (projectContext.ts) and pointed at from
// CLAUDE.md (contextPointer.ts) so login/setup steps use the real environment + account.

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
