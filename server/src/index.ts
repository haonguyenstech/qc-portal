import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import cors from 'cors'
import express from 'express'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { PORT } from './config.js'
import { getEvents, reconcileInterruptedRuns, seedDefaultProject } from './db.js'
import * as hub from './hub.js'
import { shutdownActiveRuns } from './runManager.js'
import { qcRouter } from './routes/qc.js'
import { filesRouter } from './routes/files.js'
import { skillsRouter } from './routes/skills.js'
import { mcpRouter } from './routes/mcp.js'
import { projectsRouter } from './routes/projects.js'
import { clickupRouter } from './routes/clickup.js'
import { aiRouter } from './routes/ai.js'
import { templatesRouter } from './routes/templates.js'
import { diagramsRouter } from './routes/diagrams.js'

// Optionally seed a default project from QC_REPO_ROOT (no-op if unset / already seeded).
const defaultProject = seedDefaultProject()

// Clean up runs orphaned by a previous shutdown so they don't stay "running".
const interrupted = reconcileInterruptedRuns()
if (interrupted) {
  console.log(`Reconciled ${interrupted} interrupted run(s) → error`)
}

const app = express()
app.use(cors())
// Larger limit so drag-and-drop skill folders (base64-encoded files) fit.
app.use(express.json({ limit: '50mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true })
})

app.use('/api/projects', projectsRouter)
app.use('/api/qc', qcRouter)
app.use('/api/files', filesRouter)
app.use('/api/skills', skillsRouter)
app.use('/api/mcp', mcpRouter)
app.use('/api/clickup', clickupRouter)
app.use('/api/ai', aiRouter)
app.use('/api/templates', templatesRouter)
app.use('/api/diagrams', diagramsRouter)

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
  // routes (React Router) work on reload. /api/* and /ws are handled above.
  app.get(/^(?!\/(api|ws)\b).*/, (_req, res) => {
    res.sendFile(indexHtml)
  })
  console.log(`Serving web UI from ${webDist}`)
} else {
  console.log('web/dist not found — API only (run `npm run build` to bundle the UI)')
}

const server = http.createServer(app)

const wss = new WebSocketServer({ server, path: '/ws' })

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
  // Re-raise the default behaviour so the process actually exits.
  process.exit(0)
}
process.on('SIGINT', () => gracefulExit('SIGINT'))
process.on('SIGTERM', () => gracefulExit('SIGTERM'))
