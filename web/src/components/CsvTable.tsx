// Shared read-only CSV preview table. TestCasePage keeps its own interactive
// variant (click-to-refine cells); this one is for plain "show me the file"
// previews (templates, checklists). Fold VerifyDesignPage's copy in when touched.

import { cn } from '@/lib/utils'

/** Parse RFC-4180-ish CSV into rows of cells (handles quotes, "" escapes, multi-line cells). */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/\r\n?/g, '\n')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  row.push(field)
  rows.push(row)
  // Drop trailing rows that are entirely empty (CSVs often end with blank lines).
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === '')) rows.pop()
  return rows
}

/** Heuristic: does this file look like CSV? (by extension, or a comma-y header). */
export function looksLikeCsv(name: string, content: string): boolean {
  const n = name.toLowerCase()
  if (n.endsWith('.csv') || n.endsWith('.tsv')) return true
  const first = content.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
  if (first.startsWith('#') || first.startsWith('|')) return false
  return (first.match(/,/g)?.length ?? 0) >= 2
}

/** Renders CSV as a scrollable table, trimming fully-empty trailing columns. */
export function CsvTable({ csv }: { csv: string }) {
  const rows = parseCsv(csv)
  if (rows.length === 0) {
    return <p className="py-12 text-center text-sm text-muted-foreground">Empty CSV.</p>
  }
  // Find the last column index that holds any content, so the trailing ",,,," padding
  // some exports carry doesn't render as a row of empty columns.
  let cols = 1
  for (const r of rows) {
    for (let i = r.length - 1; i >= 0; i--) {
      if (r[i].trim() !== '') {
        cols = Math.max(cols, i + 1)
        break
      }
    }
  }
  const [head, ...body] = rows
  const idx = Array.from({ length: cols }, (_, i) => i)
  // First column stays pinned on horizontal scroll (usually the "No" column), header
  // row stays pinned on vertical scroll. The scroll container caps its own height so
  // there's actually something to scroll the header against. Sticky cells need an
  // opaque background or the scrolled content shows through them.
  return (
    // w-max lets the table grow past the dialog width so overflow-auto gives a real
    // horizontal scrollbar; min-w-full keeps it filling narrow tables. max-h caps the
    // body so the sticky header has room to pin.
    <div className="max-h-[75vh] overflow-auto rounded-2xl border border-border/60">
      <table className="w-max min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {idx.map((i) => (
              <th
                key={i}
                className={cn(
                  'sticky top-0 min-w-[12rem] whitespace-nowrap border bg-muted px-3 py-2 text-left font-semibold',
                  // top-left corner must sit above both the sticky row and sticky column.
                  i === 0 ? 'left-0 z-30' : 'z-20',
                )}
              >
                {head[i] ?? ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="even:bg-muted/20">
              {idx.map((ci) => (
                <td
                  key={ci}
                  className={cn(
                    'min-w-[12rem] max-w-[34rem] whitespace-pre-wrap break-words border px-3 py-2 align-top text-muted-foreground',
                    // Pinned first column: a solid (opaque) shaded background so other
                    // columns can't bleed through it while scrolling horizontally. Reads
                    // as a deliberate index column rather than following the zebra stripe.
                    ci === 0 && 'sticky left-0 z-10 bg-muted font-medium text-foreground',
                  )}
                >
                  {r[ci] ?? ''}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
