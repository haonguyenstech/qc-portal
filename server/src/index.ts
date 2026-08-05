import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { PORT } from './config.js'
import { getEvents, listProjects, reconcileInterruptedRuns, seedDefaultProject } from './db.js'
import { reconcileBundledSkills } from './skillSync.js'
import { reconcileBundledTemplates } from './templateSync.js'
import * as hub from './hub.js'
import { shutdownActiveRuns } from './runManager.js'
import {
  handleTerminalConnection,
  killAllTerminalSessions,
  listTerminalSessions,
  terminalAvailable,
} from './terminal.js'
import { qcRouter } from './routes/qc.js'
import { filesRouter } from './routes/files.js'
import { skillsRouter } from './routes/skills.js'
import { mcpRouter, repairProjectMcpConfig } from './routes/mcp.js'
import { projectsRouter } from './routes/projects.js'
import { clickupRouter } from './routes/clickup.js'
import { jiraRouter } from './routes/jira.js'
import { azureRouter } from './routes/azure.js'
import { sourceRouter } from './routes/source.js'
import { databaseRouter } from './routes/database.js'
import { autoAgentRouter } from './routes/autoAgent.js'
import { aiRouter } from './routes/ai.js'
import { templatesRouter } from './routes/templates.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { overviewDocsRouter } from './routes/overviewDocs.js'
import { memoryRouter } from './routes/memory.js'
import { accountsRouter } from './routes/accounts.js'
import { diagramsRouter } from './routes/diagrams.js'
import { apiTestsRouter } from './routes/apiTests.js'
import { prototypeRouter } from './routes/prototype.js'
import { chatRouter } from './routes/chat.js'
import { versionRouter } from './routes/version.js'

// Optionally seed a default project from QC_REPO_ROOT (no-op if unset / already seeded).
const defaultProject = seedDefaultProject()

// Bring every project's .mcp.json in line with this machine: strip retired device
// drivers (mobile-mcp / appium-mcp), and repair a Playwright --user-data-dir that
// points at another user's home (an EPERM that blocks every browser call).
for (const project of listProjects()) {
  try {
    repairProjectMcpConfig(project.rootPath)
  } catch {
    /* unreadable/absent .mcp.json — nothing to clean */
  }
}

// Clean up runs orphaned by a previous shutdown so they don't stay "running".
const interrupted = reconcileInterruptedRuns()
if (interrupted) {
  console.log(`Reconciled ${interrupted} interrupted run(s) → error`)
}

// Keep each project's copy of a portal-bundled skill (qc-testing) in step with the
// portal: refresh the copies nobody has edited, leave customized ones alone (the
// Skills page offers those an update instead). See skillSync.ts.
{
  const { updated, customized } = reconcileBundledSkills()
  for (const u of updated) {
    console.log(`Updated skill "${u.skill}" in ${u.project} from the portal's bundled version`)
  }
  if (customized.length) {
    const list = customized.map((c) => `${c.project}/${c.skill}`).join(', ')
    console.log(
      `Skill update available but not applied (locally edited): ${list} — update it on the Skills page`,
    )
  }
}

// Same deal for the project templates the portal ships (the common test-case
// template): refresh every copy nobody has edited, leave edited ones alone —
// /templates offers those a "Reset to default". See templateSync.ts.
{
  const { updated, customized } = reconcileBundledTemplates()
  for (const u of updated) {
    console.log(`Updated template "${u.key}" in ${u.project} from the portal's bundled default`)
  }
  if (customized.length) {
    const list = customized.map((c) => `${c.project}/${c.key}`).join(', ')
    console.log(
      `Template default changed but not applied (locally edited): ${list} — reset it on the Templates page`,
    )
  }
}

const app = express()
app.use(cors())
// Larger limit so drag-and-drop skill folders (base64-encoded files) fit.
// (Project import sends the zip as a raw binary body parsed by its own route
// middleware, so it isn't affected by this JSON limit.)
app.use(express.json({ limit: '50mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

// Whether the device-terminal feature can run (node-pty native binding loaded).
app.get('/api/terminal/available', (_req, res) => {
  res.json(terminalAvailable())
})

// Terminal sessions that are still running (a shell survives leaving the page), so
// the UI can re-attach instead of starting a second one.
app.get('/api/terminal/sessions', (_req, res) => {
  res.json({ sessions: listTerminalSessions() })
})

app.use('/api/projects', projectsRouter)
app.use('/api/qc', qcRouter)
app.use('/api/files', filesRouter)
app.use('/api/skills', skillsRouter)
app.use('/api/mcp', mcpRouter)
app.use('/api/clickup', clickupRouter)
app.use('/api/jira', jiraRouter)
app.use('/api/azure', azureRouter)
app.use('/api/source', sourceRouter)
app.use('/api/database', databaseRouter)
app.use('/api/auto-agent', autoAgentRouter)
app.use('/api/ai', aiRouter)
app.use('/api/templates', templatesRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api/overview-docs', overviewDocsRouter)
app.use('/api/memory', memoryRouter)
app.use('/api/accounts', accountsRouter)
app.use('/api/diagrams', diagramsRouter)
app.use('/api/api-tests', apiTestsRouter)
app.use('/api/prototype', prototypeRouter)
app.use('/api/chat', chatRouter)
app.use('/api/version', versionRouter)

// JSON error handler for /api routes: turn body-parser failures (notably
// PayloadTooLargeError, which otherwise returns an HTML page) into a clean JSON
// message the client can surface in a toast.
app.use('/api', (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) return next()
  const e = err as { type?: string; status?: number; statusCode?: number; message?: string }
  if (e.type === 'entity.too.large') {
    return res
      .status(413)
      .json({ error: 'The uploaded file is too large for the server to accept.' })
  }
  const status = e.status ?? e.statusCode ?? 500
  return res.status(status).json({ error: e.message || 'Internal Server Error' })
})

// In a packaged install the Express server also serves the built web UI so the
// whole portal is a single process on a single port (no Vite dev server). In dev
// (`npm run dev`) web/dist may be absent — Vite serves the UI and proxies here —
// so this block is skipped cleanly when the build output isn't present.
const here = path.dirname(fileURLToPath(import.meta.url)) // .../server/dist (compiled) or .../server/src (tsx)
const webDist = path.join(here, '..', '..', 'web', 'dist')
const indexHtml = path.join(webDist, 'index.html')
if (fs.existsSync(indexHtml)) {
  app.use(express.static(webDist))
  // SPA fallback: any non-API, non-WebSocket GET serves index.html so client-side
  // routes (React Router) work on reload. Only real API paths (/api/…) and the
  // websocket (/ws, /ws/…) are excluded — matching on the trailing slash so client
  // routes such as /api-testing still fall through to the SPA (a bare \b boundary
  // would wrongly treat /api-testing as an API path).
  app.get(/^(?!\/(?:api\/|ws(?:\/|$))).*/, (_req, res) => {
    res.sendFile(indexHtml)
  })
  console.log(`Serving web UI from ${webDist}`)
} else {
  console.log('web/dist not found — API only (run `npm run build` to bundle the UI)')
}

const server = http.createServer(app)

// Two WebSocket endpoints share this HTTP server, routed by path on upgrade:
//   /ws          → live QC-run event hub (subscribe by runId)
//   /ws/terminal → a real device pseudo-terminal (one shell per connection)
const wss = new WebSocketServer({ noServer: true })
const terminalWss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url ?? '', 'http://localhost').pathname
  if (pathname === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else if (pathname === '/ws/terminal') {
    terminalWss.handleUpgrade(req, socket, head, (ws) => terminalWss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

terminalWss.on('connection', (ws: WebSocket, req) => {
  handleTerminalConnection(ws, req)
})

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (data) => {
    let msg: unknown
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (
      msg &&
      typeof msg === 'object' &&
      'subscribe' in msg &&
      typeof (msg as { subscribe: unknown }).subscribe === 'string'
    ) {
      const runId = (msg as { subscribe: string }).subscribe
      hub.subscribe(runId, ws)
      // Replay persisted events so a late subscriber catches up.
      for (const event of getEvents(runId)) {
        try {
          ws.send(JSON.stringify({ runId, event }))
        } catch {
          break
        }
      }
    }
  })

  ws.on('close', () => hub.unsubscribe(ws))
  ws.on('error', () => hub.unsubscribe(ws))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`QC Portal server listening on http://127.0.0.1:${PORT}`)
  if (defaultProject) {
    console.log(`Default project: ${defaultProject.name} (${defaultProject.rootPath})`)
  }
})

// Kill in-flight claude/Playwright trees before exit so a `tsx watch` restart or
// Ctrl-C never orphans them. tsx sends SIGTERM on restart; the terminal sends
// SIGINT on Ctrl-C. Guard against double-runs and exit once cleanup is done.
let shuttingDown = false
function gracefulExit(signal: NodeJS.Signals) {
  if (shuttingDown) return
  shuttingDown = true
  const n = shutdownActiveRuns()
  if (n) console.log(`Stopped ${n} in-flight run(s) on ${signal}`)
  // Terminal shells outlive their WebSocket by design, so they must be killed here
  // or a restart would orphan them (they're setsid session leaders).
  const t = killAllTerminalSessions()
  if (t) console.log(`Closed ${t} terminal session(s) on ${signal}`)
  // Re-raise the default behaviour so the process actually exits.
  process.exit(0)
}
process.on('SIGINT', () => gracefulExit('SIGINT'))
process.on('SIGTERM', () => gracefulExit('SIGTERM'))
