import os from 'node:os'
import { Router } from 'express'
import spawn from 'cross-spawn'
import { spawnEnv } from '../toolPath.js'
import {
  authSessionActive,
  clearAuthSession,
  closeAuthSession,
  getAuthSessionStatus,
  startAuthSession,
} from '../authSession.js'
import { buildK6Script, k6Available, parseLoadConfig } from '../k6.js'
import { pageAuditAvailable } from '../pageAudit.js'
import {
  cancelPerfJob,
  deletePerfJob,
  getPerfJob,
  listPerfJobs,
  startLoadJob,
  startPageJob,
} from '../perfJobs.js'
import { resolveProject } from '../projectScope.js'
import { resolveSendVars, substituteVars } from './apiTests.js'
import {
  assertExportableHtml,
  footerText,
  htmlToDocx,
  htmlToPdf,
  safeFileName,
} from '../reportExport.js'

/**
 * Performance testing — `/performance`.
 *
 * Two tools behind one page, because a QC engineer asking "is this slow?" needs
 * both halves of the answer:
 *   • POST /page-audits — a real browser loads the page N times and reports load
 *     timings plus which APIs got called more than once per load.
 *   • POST /load-tests  — k6 hammers the endpoints and reports how response times
 *     hold up under concurrency.
 *
 * Both return a job id the client polls; nothing here blocks on a run finishing.
 */

export const performanceRouter = Router()

/** GET /api/performance/available — can each half run on this machine? */
performanceRouter.get('/available', async (_req, res) => {
  const [k6, browser] = await Promise.all([k6Available(), pageAuditAvailable()])
  res.json({ k6, browser })
})

/** `darwin arm64` → `macOS arm64` — the OS as a person writes it in a report. */
function platformLabel(): string {
  const name =
    process.platform === 'darwin'
      ? 'macOS'
      : process.platform === 'win32'
        ? 'Windows'
        : process.platform === 'linux'
          ? 'Linux'
          : process.platform
  return `${name} ${os.arch()}`
}

/**
 * The machine's git identity — the closest thing the portal has to "who ran this".
 *
 * Read from the PROJECT first so a repo-local identity wins over the global one,
 * which is how a contractor's per-client identity is usually configured. Failure is
 * not an error: git may be absent, or simply never configured, and the NFR panel
 * then leaves the field for the engineer.
 */
function gitUserName(cwd?: string): string {
  const read = (args: string[], dir?: string): string => {
    try {
      const out = spawn.sync('git', args, {
        cwd: dir,
        env: spawnEnv(),
        windowsHide: true,
        encoding: 'utf8',
        timeout: 3000,
      })
      return out.status === 0 ? String(out.stdout ?? '').trim() : ''
    } catch {
      return ''
    }
  }
  return (cwd ? read(['config', 'user.name'], cwd) : '') || read(['config', '--global', 'user.name'])
}

/**
 * GET /api/performance/report-context — what the NFR report can fill in by itself.
 *
 * Everything here describes THIS machine, and it is answered to a server bound to
 * 127.0.0.1 for a report the same person downloads, so it never leaves the box. It
 * exists because a report round otherwise begins by hand-typing facts the portal
 * already holds.
 */
performanceRouter.get('/report-context', (req, res) => {
  // No project on the query, or one that no longer exists, is not an error here:
  // the global git identity still answers, and the rest describes the machine.
  const root = resolveProject(req)?.rootPath
  res.json({
    tester: gitUserName(root),
    host: os.hostname(),
    platform: platformLabel(),
  })
})

/**
 * POST /api/performance/script — the k6 script a config would produce.
 *
 * Not decoration: the whole point of wrapping k6 rather than reimplementing it is
 * that the engineer can take the script to the command line. Headers and bodies are
 * absent from it by design (they arrive through the environment), so this is also
 * the thing that makes that guarantee inspectable.
 */
performanceRouter.post('/script', (req, res) => {
  const project = resolveProject(req)
  // Same substitution the run does, so the preview is the script that would actually
  // run — but in `display` mode, because this one is rendered in the browser.
  const resolved = project
    ? substituteLoadConfig(req.body, project.rootPath, project.id, { display: true })
    : { body: req.body, unresolved: [] as string[] }
  if (resolved.unresolved.length) {
    return res.status(400).json({
      error: `Unknown variable(s): ${resolved.unresolved.map((k) => `{{${k}}}`).join(', ')} — define them in the API Testing environment that is active, or replace them with a literal value.`,
    })
  }
  try {
    const cfg = parseLoadConfig(resolved.body)
    res.json({ script: buildK6Script(cfg) })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'invalid config' })
  }
})

/** POST /api/performance/load-tests — start a k6 run in the background. */
/**
 * Substitute `{{variables}}` through a load-test config, before it is validated.
 *
 * An endpoint imported from API Testing carries that page's variables — an
 * environment value, a test account's password, a live authenticator code. The
 * browser is never given the secret ones (`/environments` masks them), and the load
 * form is persisted to localStorage, so resolving them in the page would either fail
 * on exactly the values that matter or write a bearer token into browser storage.
 * They are resolved HERE instead, at run start, from the same sources and with the
 * same rules API Testing uses at send time.
 *
 * It runs BEFORE `parseLoadConfig`, which requires a real `http(s)://` URL — a URL
 * that begins `{{baseUrl}}` is not one yet.
 *
 * Nothing substituted here is echoed back: the job's public shape already strips
 * headers and bodies, and the resolved values reach k6 through the environment
 * rather than the generated script.
 */
function substituteLoadConfig(
  raw: unknown,
  root: string,
  projectId: string,
  /**
   * `display` keeps SECRET variables as their `{{placeholder}}`. The script preview
   * is rendered in the browser, and a secret in a query string would otherwise be
   * printed there — the one place the generated script is ever shown.
   */
  opts: { display?: boolean } = {},
): { body: unknown; unresolved: string[] } {
  const body = (raw ?? {}) as Record<string, unknown>
  if (!Array.isArray(body.endpoints)) return { body, unresolved: [] }

  const vars = resolveSendVars(root, projectId)
  const unresolved = new Set<string>()
  const sub = (value: unknown): string => {
    const { out, unresolved: missing } = substituteVars(String(value ?? ''), vars, opts)
    missing.forEach((k) => unresolved.add(k))
    return out
  }

  const endpoints = body.endpoints.map((e) => {
    const o = (e ?? {}) as Record<string, unknown>
    const headers: Record<string, string> = {}
    const rawHeaders = (o.headers ?? {}) as Record<string, unknown>
    if (rawHeaders && typeof rawHeaders === 'object') {
      // Header NAMES can hold a variable too — an API-key header whose name differs
      // per environment is a real pattern, and skipping the key would resolve half
      // the header and silently send the other half as braces.
      for (const [k, v] of Object.entries(rawHeaders)) headers[sub(k)] = sub(v)
    }
    return { ...o, url: sub(o.url), headers, body: sub(o.body) }
  })

  return { body: { ...body, endpoints }, unresolved: [...unresolved] }
}

performanceRouter.post('/load-tests', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'no project selected' })

  // Fail fast with an actionable message rather than a job whose only content is
  // "k6: command not found".
  const k6 = await k6Available()
  if (!k6.ok) {
    return res.status(400).json({
      error: k6.error ?? 'k6 is not installed.',
      installHint: k6.installHint,
    })
  }

  const resolved = substituteLoadConfig(req.body, project.rootPath, project.id)
  if (resolved.unresolved.length) {
    return res.status(400).json({
      error: `Unknown variable(s): ${resolved.unresolved.map((k) => `{{${k}}}`).join(', ')} — define them in the API Testing environment that is active, or replace them with a literal value.`,
    })
  }

  let cfg
  try {
    cfg = parseLoadConfig(resolved.body)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid config' })
  }
  const job = startLoadJob(project.id, cfg)
  res.json({ jobId: job.id, job })
})

/**
 * Sign-in window — `/auth-session`.
 *
 * The audit's profile is the ONLY place a login counts (localStorage is per origin
 * AND per profile, so the engineer's own Chrome never helps). These three routes
 * open a real window on that profile, report where it is, and close it — closing
 * being the step that flushes the session to disk and frees the profile lock.
 */
performanceRouter.get('/auth-session', async (_req, res) => {
  res.json({ session: await getAuthSessionStatus() })
})

performanceRouter.post('/auth-session', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return res.status(400).json({ error: 'Enter the URL to sign in at, including http:// or https://' })
  }
  try {
    const session = await startAuthSession(url)
    res.json({ session })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not open the browser' })
  }
})

performanceRouter.post('/auth-session/close', async (_req, res) => {
  const result = await closeAuthSession()
  res.json({ ...result, session: await getAuthSessionStatus() })
})

/**
 * POST /auth-session/clear — forget the saved login for ONE origin.
 *
 * Signing in again on top of a stale token does nothing visible: the app skips
 * its own login screen and the next audit still gets bounced. Dropping the
 * origin's cookies + storage first is what makes "sign in again" mean it. Also
 * how you switch to auditing as a different user.
 */
performanceRouter.post('/auth-session/clear', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return res.status(400).json({ error: 'Enter the site URL, including http:// or https://' })
  }
  try {
    res.json(await clearAuthSession(url))
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not clear the session' })
  }
})

/** POST /api/performance/page-audits — load a page N times and measure it. */
performanceRouter.post('/page-audits', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'no project selected' })

  const body = (req.body ?? {}) as Record<string, unknown>
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!/^https?:\/\/\S+$/i.test(url)) {
    return res.status(400).json({ error: 'Enter the full page URL, including http:// or https://' })
  }
  // Chrome will not open one profile twice, and the raw failure is a Playwright
  // stack about a SingletonLock. Name the actual situation instead.
  if (authSessionActive() && body.useProfile !== false) {
    return res.status(400).json({
      error:
        'The sign-in window is still open — close it first (that is also what saves the session).',
    })
  }
  const runs = Math.max(1, Math.min(10, Math.round(Number(body.runs) || 3)))
  const settleRaw = Number(body.settleMs)
  const settleMs = Number.isFinite(settleRaw) ? Math.max(0, Math.min(30_000, Math.round(settleRaw))) : 3000

  try {
    const job = await startPageJob(project.id, {
      url,
      runs,
      settleMs,
      headed: body.headed === true,
      // Default to the logged-in QC profile: most pages worth measuring are
      // behind a login, and a clean browser would just measure the login screen.
      useProfile: body.useProfile !== false,
    })
    res.json({ jobId: job.id, job })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not start the audit' })
  }
})

/**
 * Report export — `/report/pdf` and `/report/docx`.
 *
 * The CLIENT sends the rendered report HTML; the server only converts it. That
 * split is deliberate: the verdict bands and the charts live in the web bundle
 * (they are what the screen draws), and re-deriving them here would eventually
 * let the PDF disagree with the page. Conversion is the half a browser cannot do.
 */
performanceRouter.post('/report/pdf', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  let html: string
  try {
    html = assertExportableHtml(body.html)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid report' })
  }
  try {
    const pdf = await htmlToPdf(html, footerText(body.footer))
    const name = safeFileName(body.fileName, 'performance-report')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`)
    res.send(pdf)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'could not build the PDF' })
  }
})

performanceRouter.post('/report/docx', async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  let html: string
  try {
    html = assertExportableHtml(body.html)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid report' })
  }
  try {
    const docx = await htmlToDocx(html, footerText(body.footer))
    const name = safeFileName(body.fileName, 'performance-report')
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    res.setHeader('Content-Disposition', `attachment; filename="${name}.docx"`)
    res.send(docx)
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'could not build the Word file' })
  }
})

/** GET /api/performance/jobs — this project's perf jobs, newest first. */
performanceRouter.get('/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.json({ jobs: [] })
  res.json({ jobs: listPerfJobs(project.id) })
})

/** GET /api/performance/jobs/:id — poll one job's log + result. */
performanceRouter.get('/jobs/:id', (req, res) => {
  const job = getPerfJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'performance job not found' })
  res.json({ job })
})

/**
 * DELETE /api/performance/jobs/:id — drop a run from the list for good.
 *
 * The registry is in memory and capped at 40, so the list is otherwise pruned
 * only by age — which is the wrong order when the runs worth keeping are the
 * baselines and the noise is the six attempts it took to get the URL right.
 * A still-running job is cancelled as part of the delete (`deletePerfJob`).
 */
performanceRouter.delete('/jobs/:id', (req, res) => {
  res.json({ deleted: deletePerfJob(req.params.id) })
})

/** POST /api/performance/jobs/:id/cancel — stop a running job. */
performanceRouter.post('/jobs/:id/cancel', (req, res) => {
  const job = cancelPerfJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'performance job not found' })
  res.json({ job })
})
