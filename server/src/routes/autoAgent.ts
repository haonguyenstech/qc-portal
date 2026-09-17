import { Router } from 'express'
import { readAutoAgentStatus } from '../autoAgent.js'
import { readClaudeTokenUsage } from '../claudeTokenUsage.js'
import { listUsageSince, type UsageEventRow } from '../db.js'
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
 * GET /api/auto-agent/token-usage[?refresh=1] — today's tokens across EVERY `claude` on
 * this machine, the same box `auto-agent-ai login` prints (see `claudeTokenUsage.ts`).
 */
autoAgentRouter.get('/token-usage', async (req, res) => {
  try {
    res.json(await readClaudeTokenUsage(req.query.refresh === '1'))
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

interface UsageBucket {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

function addTo(map: Map<string, UsageBucket>, key: string, e: UsageEventRow): void {
  const b = map.get(key) ?? { key, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  b.calls += 1
  b.inputTokens += e.inputTokens
  b.outputTokens += e.outputTokens
  b.costUsd += e.costUsd
  map.set(key, b)
}

function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * GET /api/auto-agent/usage?days=1|7|30 — what THIS portal has spent on the shared
 * credential, from the `usage_events` every `claude` call already records. Only the
 * portal's own calls: the credential's other consumers (the engineer's terminal, other
 * machines) are invisible from here, and the dialog says so. Days are LOCAL calendar
 * days — `days=1` is "today since midnight", not the last 24h.
 */
autoAgentRouter.get('/usage', (req, res) => {
  const days = [1, 7, 30].includes(Number(req.query.days)) ? Number(req.query.days) : 7
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const events = listUsageSince(start.toISOString())

  const bySource = new Map<string, UsageBucket>()
  const byModel = new Map<string, UsageBucket>()
  const byDay = new Map<string, UsageBucket>()
  // Pre-seed every day so a quiet day draws as an empty bar, not a missing one.
  for (let i = 0; i < days; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = localDay(d)
    byDay.set(key, { key, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
  }
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }
  for (const e of events) {
    totals.calls += 1
    totals.inputTokens += e.inputTokens
    totals.outputTokens += e.outputTokens
    totals.costUsd += e.costUsd
    addTo(bySource, e.source, e)
    addTo(byModel, e.model ?? 'default', e)
    addTo(byDay, localDay(new Date(e.ts)), e)
  }
  const ranked = (m: Map<string, UsageBucket>) =>
    [...m.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))

  res.json({
    days,
    since: start.toISOString(),
    totals,
    bySource: ranked(bySource),
    byModel: ranked(byModel),
    daily: [...byDay.values()],
    lastCallAt: events.length ? events[events.length - 1].ts : null,
    generatedAt: new Date().toISOString(),
  })
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
