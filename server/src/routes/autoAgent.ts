import { Router } from 'express'
import { readAutoAgentStatus } from '../autoAgent.js'
import {
  answerAutoAgentLogin,
  cancelAutoAgentLogin,
  getAutoAgentLogin,
  runAutoAgentLogout,
  startAutoAgentLogin,
} from '../autoAgentCli.js'

export const autoAgentRouter = Router()

/**
 * GET /api/auto-agent/status — is the company's Auto Agent CLI still supplying a
 * Claude credential? Polled by the sidebar indicator, so it stays cheap (filesystem
 * + pid probe only) and never fails the request: an unreadable state is itself a
 * status, not a 500.
 */
autoAgentRouter.get('/status', (_req, res) => {
  res.json(readAutoAgentStatus())
})

/**
 * Connect / disconnect — the portal driving `auto-agent-ai login` / `logout` so the
 * engineer doesn't need a terminal window parked on it (see `autoAgentCli.ts` for why
 * a background child is enough).
 *
 * Sign-in is a JOB, not a request: the Microsoft step happens in the user's browser and
 * can take a minute, so POST /login starts it and the page POLLS GET /login. That also
 * means a reload mid-sign-in re-attaches instead of losing it, the same reason ticket
 * crawling and test-case generation are polled jobs.
 */
autoAgentRouter.post('/login', (_req, res) => {
  const started = startAutoAgentLogin()
  // 409, not 400: "already running" is a state conflict the page recovers from by
  // simply polling the job it asked to create.
  if (!started.ok) return res.status(started.error.includes('already') ? 409 : 400).json(started)
  res.json(started.job)
})

autoAgentRouter.get('/login', (_req, res) => {
  res.json(getAutoAgentLogin())
})

/** Answer the CLI's "which AI session?" picker (only asked when several are assigned). */
autoAgentRouter.post('/login/answer', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!text.trim()) return res.status(400).json({ ok: false, error: 'An answer is required.' })
  const result = answerAutoAgentLogin(text)
  res.status(result.ok ? 200 : 409).json(result)
})

autoAgentRouter.post('/login/cancel', (_req, res) => {
  const result = cancelAutoAgentLogin()
  res.status(result.ok ? 200 : 409).json(result)
})

autoAgentRouter.post('/logout', async (_req, res) => {
  const result = await runAutoAgentLogout()
  res.status(result.ok ? 200 : 400).json(result)
})
