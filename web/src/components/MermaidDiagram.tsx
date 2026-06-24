import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

// Lazy, one-time mermaid import + init. Keeps the (large) library out of the main
// bundle until a diagram is actually rendered.
type MermaidApi = (typeof import('mermaid'))['default']
let mermaidPromise: Promise<MermaidApi> | null = null
function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'neutral',
        securityLevel: 'strict', // sanitizes output — safe for dangerouslySetInnerHTML
        flowchart: { useMaxWidth: true, htmlLabels: true },
      })
      return m.default
    })
  }
  return mermaidPromise
}

let renderCounter = 0

/**
 * Renders a Mermaid diagram from its source text to inline SVG. Shows a clear
 * error panel (rather than throwing) when the source is invalid, so a bad AI
 * generation never breaks the page.
 */
export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const code = chart.trim()
    if (!code) {
      setSvg('')
      setError(null)
      setLoading(false)
      return
    }
    setLoading(true)
    ;(async () => {
      try {
        const mermaid = await getMermaid()
        const id = `mmd-${++renderCounter}`
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) {
          setSvg(svg)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setSvg('')
          setError(e instanceof Error ? e.message : 'Failed to render diagram')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [chart])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Rendering diagram…
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
        <p className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="size-3.5 shrink-0" />
          The diagram couldn't be rendered — its Mermaid syntax is invalid.
        </p>
        <p className="text-amber-700">Edit the source below and fix it, or regenerate.</p>
        <pre className="overflow-x-auto rounded bg-amber-100/60 p-2 font-mono text-[11px] text-amber-900">
          {error}
        </pre>
      </div>
    )
  }

  return (
    <div
      className={cn('mermaid-diagram overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full', className)}
      // mermaid output is sanitized by securityLevel: 'strict'
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
