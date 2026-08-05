import { Router } from 'express'
import { readAutoAgentStatus } from '../autoAgent.js'

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
