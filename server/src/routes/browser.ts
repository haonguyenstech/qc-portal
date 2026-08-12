import { Router } from 'express'
import {
  ensureQcBrowser,
  maximizeQcBrowserWindow,
  qcBrowserStatus,
  stopQcBrowser,
  type QcBrowserChannel,
} from '../qcBrowser.js'

/**
 * The QC browser — the portal-owned window Playwright MCP attaches to over CDP.
 * See `qcBrowser.ts` for why it exists (Stop used to close the browser, and the
 * MCP's own window was never full screen).
 */
export const browserRouter = Router()

const CHANNELS: QcBrowserChannel[] = ['msedge', 'chrome']

browserRouter.get('/status', async (_req, res) => {
  res.json(await qcBrowserStatus())
})

browserRouter.post('/start', async (req, res) => {
  const raw = (req.body ?? {}).channel
  const channel = CHANNELS.includes(raw) ? (raw as QcBrowserChannel) : 'msedge'
  const result = await ensureQcBrowser(channel)
  if (!result.ok) return res.status(500).json({ ...result, ...(await qcBrowserStatus()) })
  return res.json({ ...result, ...(await qcBrowserStatus()) })
})

/**
 * Maximize the window. Separate from /start because a browser we ADOPTED is left at
 * whatever size the engineer put it — this is the explicit "make it full screen" they
 * can press when that's what they want.
 */
browserRouter.post('/maximize', async (_req, res) => {
  const ok = await maximizeQcBrowserWindow()
  if (!ok) {
    return res
      .status(409)
      .json({ error: 'Could not resize the window — is the QC browser open?' })
  }
  return res.json({ ok: true, ...(await qcBrowserStatus()) })
})

browserRouter.post('/stop', async (_req, res) => {
  const result = await stopQcBrowser()
  if (!result.ok) return res.status(409).json(result)
  return res.json({ ...result, ...(await qcBrowserStatus()) })
})
