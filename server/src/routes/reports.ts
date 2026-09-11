import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { testResultDirFor, ticketsDirFor } from '../config.js'
import { resolveProject } from '../projectScope.js'
import { buildSystemReport } from '../reportData.js'
import { revealFolderNative } from '../folderPicker.js'
import { assertExportableHtml, footerText, htmlToDocx, htmlToPdf, safeFileName } from '../reportExport.js'

export const reportsRouter = Router()

/**
 * GET /api/reports/summary — the whole QC picture for one project.
 *
 * Optional `from` / `to` (ISO dates) window the RUNS and DEFECTS only. Tickets are
 * never filtered by date: a window that hides the backlog would turn "12 tickets
 * still have no test cases" into "everything is fine this week".
 */
reportsRouter.get('/summary', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : null
  const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : null
  try {
    return res.json(buildSystemReport(project, { from, to }))
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : 'could not build the report' })
  }
})

/**
 * POST /api/reports/export/:format — the printable report HTML, built in the
 * browser, converted here. Same converter the Performance page uses: printing
 * needs a real Chrome and .docx needs a zip writer, neither of which a page has.
 */
reportsRouter.post('/export/:format', async (req, res) => {
  const format = req.params.format === 'docx' ? 'docx' : req.params.format === 'pdf' ? 'pdf' : null
  if (!format) return res.status(400).json({ error: 'format must be pdf or docx' })
  let html: string
  try {
    html = assertExportableHtml((req.body as { html?: unknown })?.html)
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'invalid html' })
  }
  const name = safeFileName((req.body as { fileName?: unknown })?.fileName, 'qc-report')
  const footer = footerText((req.body as { footer?: unknown })?.footer)
  try {
    const buf = format === 'pdf' ? await htmlToPdf(html, footer) : await htmlToDocx(html, footer)
    res.setHeader(
      'Content-Type',
      format === 'pdf'
        ? 'application/pdf'
        : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    res.setHeader('Content-Disposition', `attachment; filename="${name}.${format}"`)
    return res.end(buf)
  } catch (err) {
    return res
      .status(500)
      .json({ error: err instanceof Error ? err.message : `could not build the ${format}` })
  }
})

/**
 * POST /api/reports/open — reveal a ticket folder or a run's output folder in the
 * OS file manager, so a row in the report is one click from its evidence. Both
 * targets are resolved under their own base dir and escape-guarded.
 */
reportsRouter.post('/open', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  const body = (req.body ?? {}) as { kind?: unknown; target?: unknown }
  const target = typeof body.target === 'string' ? body.target : ''
  if (!target) return res.status(400).json({ error: 'target is required' })

  const baseDir =
    body.kind === 'run' ? testResultDirFor(project.rootPath) : ticketsDirFor(project.rootPath)
  const segments = target.split(/[/\\]+/).filter((s) => s && s !== '.' && s !== '..')
  const dir = path.resolve(baseDir, ...segments)
  if (!segments.length || !(dir === baseDir || dir.startsWith(baseDir + path.sep))) {
    return res.status(400).json({ error: 'invalid path' })
  }
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'folder not found' })

  const result = await revealFolderNative(dir)
  if (!result.ok) return res.status(500).json({ error: result.error ?? 'failed to open folder' })
  return res.json({ ok: true, path: dir })
})
