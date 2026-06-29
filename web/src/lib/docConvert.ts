// In-browser document → Markdown conversion for the project knowledge base.
//
// Uploaded docs are converted to Markdown right here in the browser (no server
// deps, no token cost) and the resulting text is posted to /api/knowledge, which
// stores it under testing/knowledge/<name>.md for Claude to read. This mirrors
// the existing xlsx-in-browser pattern used by the test-case / template uploads.
//
// All heavy libraries (xlsx, mammoth, turndown, pdfjs) are dynamically imported
// so they stay out of the main bundle and only load when a doc is converted.

export const KNOWLEDGE_ACCEPT = '.md,.markdown,.txt,.pdf,.docx,.csv,.xlsx,.xls'

/** Max input file size we'll try to convert (raw bytes, before extraction). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25 MB

export interface ConvertedDoc {
  name: string // base name, no extension
  markdown: string
}

function baseName(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, '').trim() || 'document'
}

function extOf(filename: string): string {
  const m = filename.toLowerCase().match(/\.([^./\\]+)$/)
  return m ? m[1] : ''
}

/** Build a GFM table from an array-of-arrays (spreadsheet rows). */
function aoaToMarkdown(rows: unknown[][]): string {
  const cells = rows.map((r) =>
    (r ?? []).map((c) =>
      String(c ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, ' ')
        .trim(),
    ),
  )
  const width = Math.max(1, ...cells.map((r) => r.length))
  const pad = (r: string[]) => {
    const c = [...r]
    while (c.length < width) c.push('')
    return c
  }
  const norm = cells.map(pad)
  const header = norm[0] ?? Array(width).fill('')
  const line = (r: string[]) => `| ${r.join(' | ')} |`
  const sep = header.map(() => '---')
  return [line(header), line(sep), ...norm.slice(1).map(line)].join('\n')
}

async function fromText(file: File): Promise<string> {
  return (await file.text()).trim()
}

async function fromSpreadsheet(file: File, isCsv: boolean): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = isCsv
    ? XLSX.read(await file.text(), { type: 'string' })
    : XLSX.read(await file.arrayBuffer(), { type: 'array' })
  const parts: string[] = []
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      blankrows: false,
      defval: '',
    })
    if (!rows.length) continue
    const table = aoaToMarkdown(rows as unknown[][])
    parts.push(isCsv && wb.SheetNames.length === 1 ? table : `## ${name}\n\n${table}`)
  }
  return parts.join('\n\n').trim()
}

async function fromDocx(file: File): Promise<string> {
  const mammoth = await import('mammoth')
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })
  const TurndownService = (await import('turndown')).default
  const gfm = await import('turndown-plugin-gfm')
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
  })
  td.use(gfm.gfm)
  return td.turndown(html).trim()
}

async function fromPdf(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  // Vite resolves the ?url query to the bundled worker asset path.
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default as string
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await pdfjs.getDocument({ data }).promise
  const out: string[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const tc = await page.getTextContent()
    const text = tc.items
      .map((it) => ('str' in it ? it.str : ''))
      .join(' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+\n/g, '\n')
      .trim()
    if (text) out.push(`<!-- page ${i} -->\n\n${text}`)
  }
  return out.join('\n\n').trim()
}

/**
 * Convert one uploaded file to Markdown. Throws a human-readable Error for
 * unsupported types or when extraction yields no text (e.g. a scanned PDF).
 */
export async function convertFileToMarkdown(file: File): Promise<ConvertedDoc> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name} is too large (max 25 MB)`)
  }
  const ext = extOf(file.name)
  let markdown: string
  switch (ext) {
    case 'md':
    case 'markdown':
    case 'txt':
      markdown = await fromText(file)
      break
    case 'csv':
      markdown = await fromSpreadsheet(file, true)
      break
    case 'xlsx':
    case 'xls':
      markdown = await fromSpreadsheet(file, false)
      break
    case 'docx':
      markdown = await fromDocx(file)
      break
    case 'pdf':
      markdown = await fromPdf(file)
      break
    default:
      throw new Error(`Unsupported file type: .${ext || '?'} (use ${KNOWLEDGE_ACCEPT})`)
  }
  if (!markdown.trim()) {
    throw new Error(
      ext === 'pdf'
        ? `No text found in ${file.name} — it may be a scanned/image-only PDF.`
        : `${file.name} appears to be empty.`,
    )
  }
  return { name: baseName(file.name), markdown }
}
