import HTMLtoDOCX from 'html-to-docx'
import JSZip from 'jszip'
import type { Browser } from 'playwright-core'
import { friendlyLaunchError, loadChromium } from './pageAudit.js'

/**
 * REPORT EXPORT — one HTML document in, a PDF or a .docx out.
 *
 * The web app builds the report HTML (`lib/perfReportHtml.ts`) because that is
 * where the verdict bands and the chart drawing already live; duplicating either
 * here would let the PDF grade a run differently from the screen. The server's
 * only job is conversion, which is also the only half that cannot be done in the
 * browser: printing to PDF needs a real Chrome, and .docx needs a zip writer.
 *
 * The browser used here is a CLEAN one, never `agentProfileDir()`. Chrome refuses
 * to open a profile twice, so borrowing the audit's profile would mean an export
 * could not run while an audit did — and an export has no reason to be logged in.
 */

const MAX_HTML_BYTES = 8 * 1024 * 1024

/** A running footer is one line of plain text, so it can never inject markup. */
const MAX_FOOTER_CHARS = 200

export function assertExportableHtml(html: unknown): string {
  if (typeof html !== 'string' || !html.trim()) throw new Error('No report content to export.')
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw new Error('That report is too large to export.')
  }
  return html
}

/**
 * The running-footer text, sanitised. It is interpolated into a Chrome footer
 * template and into the .docx footer part, so it is stripped to plain text and
 * escaped rather than trusted — a report title is data, not markup.
 */
export function footerText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[\r\n]+/g, ' ').replace(/[<>&"']/g, ' ').trim().slice(0, MAX_FOOTER_CHARS)
}

/** A throwaway Chrome for rendering. Callers must close it. */
async function launch(): Promise<Browser> {
  const chromium = await loadChromium()
  try {
    return await chromium.launch({ headless: true, channel: 'chrome' })
  } catch (err) {
    throw new Error(friendlyLaunchError(err instanceof Error ? err.message : String(err)))
  }
}

/**
 * Print the report through real Chrome — the charts are SVG, so they stay sharp.
 *
 * `footer` turns on Chrome's running footer, which is the only way to get a line
 * on EVERY page: an element at the end of the document prints once, at the end.
 * Chrome's own quirk is that switching `displayHeaderFooter` on makes it apply
 * its default 0-height header/footer templates, so the empty header template is
 * passed explicitly and the bottom margin is grown to leave room for the footer.
 */
export async function htmlToPdf(html: string, footer = ''): Promise<Buffer> {
  const browser = await launch()
  try {
    const page = await browser.newPage()
    // The document carries its own styles and no remote assets, so nothing is
    // fetched here; `load` is reached the moment the markup is parsed.
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    const clean = footerText(footer)
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: clean ? '18mm' : '14mm', left: '12mm', right: '12mm' },
      ...(clean
        ? {
            displayHeaderFooter: true,
            headerTemplate: '<span></span>',
            footerTemplate: `<div style="width:100%;padding:0 12mm;font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#6b6a66;display:flex;justify-content:space-between;">
              <span>${clean}</span>
              <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
            </div>`,
          }
        : {}),
    })
    return pdf
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * Word does not read inline SVG, and `html-to-docx` passes it through as unknown
 * markup — which lands in the document as nothing at all. So the charts are
 * rasterised first, by the same Chrome that would have printed them.
 *
 * What gets screenshotted is the whole FIGURE (`div.viz-root`), not the bare
 * `svg` inside it: the legend lives beside the svg and paints its swatches with
 * `background: var(--viz-series-N)`, and a CSS variable is one more thing Word
 * cannot resolve — shooting only the svg left Word with two colored bars and a
 * legend of colorless text, which is identity by color alone with the color
 * missing. Capturing the figure bakes the swatches into the image.
 *
 * The swap is done in the DOM rather than by regex on the markup: `viz-root`
 * contains nested elements, so "up to the closing tag" is not something a regex
 * can be trusted to find. A report whose charts silently vanished in Word would
 * be worse than one that never offered .docx.
 */
async function inlineChartsAsPng(html: string): Promise<string> {
  if (!html.includes('class="viz-root"')) return html

  const browser = await launch()
  try {
    // Near the charts' own 720px design width, so the rasterised text keeps the
    // proportions it was drawn at instead of being stretched across a wide page.
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { width: 820, height: 1200 },
    })
    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })

    const figures = await page.locator('div.viz-root').all()
    const images: string[] = []
    for (const figure of figures) {
      try {
        const shot = await figure.screenshot({ type: 'png' })
        images.push(`data:image/png;base64,${shot.toString('base64')}`)
      } catch {
        images.push('') // one unrenderable chart must not lose the whole document
      }
    }

    await page.evaluate((sources: string[]) => {
      document.querySelectorAll('div.viz-root').forEach((el, i) => {
        const src = sources[i]
        if (!src) {
          el.remove()
          return
        }
        const img = document.createElement('img')
        img.src = src
        // Width in px so Word lays it out at a sensible size rather than full-bleed.
        img.setAttribute('width', '640')
        el.replaceWith(img)
      })
    }, images)

    return await page.content()
  } finally {
    await browser.close().catch(() => {})
  }
}

/**
 * OOXML measurements are INTEGERS — twips, half-points, EMUs, eighths of a point.
 * The schema types (ST_TwipsMeasure, ST_SignedTwipsMeasure, ST_HpsMeasure,
 * ST_DecimalNumber…) admit no decimal point, and Word enforces that: one fractional
 * value and it refuses to open the file at all, with "Word experienced an error
 * trying to open the file" and no hint as to which value.
 *
 * A decimal here is therefore always a generator bug, never intent, so rounding is
 * safe: the largest possible correction is half a twip, 1/2880 inch.
 */
const DECIMAL_ATTR = /(\s)([\w:]+)="(-?\d+\.\d+)"/g

/**
 * Measurement attributes that are OPTIONAL, and can therefore be dropped when their
 * value is not a number at all. Word applies its own default for a missing one; it
 * rejects the document for a present-but-invalid one.
 */
const DROPPABLE_ATTRS = new Set([
  'w:header',
  'w:footer',
  'w:gutter',
  'w:space',
  'w:leftFromText',
  'w:rightFromText',
  'w:topFromText',
  'w:bottomFromText',
])
const NON_NUMERIC_ATTR = /(\s)([\w:]+)="(undefined|NaN|null|)"/g

/**
 * Make one .docx part schema-legal.
 *
 * This repairs the OUTPUT rather than the generator on purpose. `html-to-docx`
 * divides the content width by the column count to size table cells, so any table
 * whose column count does not divide 10800 twips evenly — seven columns gives
 * 1542.857142857143 — produces a file Word will not open. Fixing it per table would
 * mean never writing a 7-, 11- or 13-column table again in any report, enforced by
 * nothing but memory. Fixing it here is enforced by the code.
 */
function repairOoxmlPart(xml: string): { xml: string; rounded: number; dropped: number } {
  let rounded = 0
  let dropped = 0
  // The XML declaration's version="1.0" is not an element attribute; keep it out of
  // the rewrite instead of teaching the pattern about it.
  const declEnd = xml.startsWith('<?xml') ? xml.indexOf('?>') + 2 : 0
  const head = xml.slice(0, declEnd)
  let body = xml.slice(declEnd)

  body = body.replace(DECIMAL_ATTR, (_all, space: string, attr: string, value: string) => {
    rounded += 1
    return `${space}${attr}="${Math.round(Number(value))}"`
  })
  body = body.replace(NON_NUMERIC_ATTR, (all, space: string, attr: string) => {
    if (!DROPPABLE_ATTRS.has(attr)) return all
    dropped += 1
    return space.slice(0, -1) || ''
  })
  return { xml: head + body, rounded, dropped }
}

/**
 * Rewrite every XML part of a generated .docx so no measurement is fractional.
 *
 * Failure is deliberately silent-but-honest: if the archive cannot be reopened, the
 * ORIGINAL bytes are returned. A file Word may refuse is still better than an export
 * button that errors, and the original is exactly what shipped before this existed.
 */
async function repairDocx(buffer: Buffer): Promise<Buffer> {
  try {
    const zip = await JSZip.loadAsync(buffer)
    let changed = false
    for (const path of Object.keys(zip.files)) {
      if (!/\.(xml|rels)$/i.test(path) || zip.files[path].dir) continue
      const original = await zip.file(path)!.async('string')
      const { xml, rounded, dropped } = repairOoxmlPart(original)
      if (rounded || dropped) {
        zip.file(path, xml)
        changed = true
      }
    }
    if (!changed) return buffer
    // DEFLATE, and mimetype-agnostic: a .docx is an ordinary zip, unlike ODF there
    // is no stored-first entry to preserve.
    return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  } catch {
    return buffer
  }
}

export async function htmlToDocx(html: string, footer = ''): Promise<Buffer> {
  const withImages = await inlineChartsAsPng(html)
  const clean = footerText(footer)
  const out = (await HTMLtoDOCX(
    withImages,
    null,
    {
      orientation: 'portrait',
      // header/footer/gutter are given even though nothing here changes them from
      // the defaults: html-to-docx copies this object into `<w:pgMar>` key by key,
      // so a missing key becomes `w:header="undefined"` — which, like a fractional
      // width, is a value Word refuses the whole document over.
      margins: { top: 720, right: 720, bottom: 720, left: 720, header: 360, footer: 360, gutter: 0 },
      table: { row: { cantSplit: true } },
      // `pageNumber` is only honoured when `footer` is on, so the two move together.
      footer: Boolean(clean),
      pageNumber: Boolean(clean),
    },
    clean
      ? `<p style="text-align:center;font-size:8pt;color:#6b6a66;">${clean}</p>`
      : undefined,
  )) as Buffer | ArrayBuffer
  return repairDocx(Buffer.isBuffer(out) ? out : Buffer.from(out))
}

/** Strip anything a filename can't carry, on either platform. */
export function safeFileName(raw: unknown, fallback: string): string {
  const base = typeof raw === 'string' ? raw : ''
  const clean = base
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90)
  return clean || fallback
}
