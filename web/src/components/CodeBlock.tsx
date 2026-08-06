import { memo, useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { highlightCode, resolveLanguage } from '@/lib/highlight'

/**
 * A fenced code block in rendered markdown: language label, one-click copy, and syntax
 * colouring.
 *
 * Copy is the point of the header bar. An answer that hands back a service class is
 * something the engineer is going to paste somewhere, and selecting 30 lines out of a
 * scrolling transcript by hand is where that goes wrong.
 *
 * Highlighting is applied AFTER mount (the highlighter is a lazy import — see
 * lib/highlight.ts), so the block renders readable plain text immediately and gains colour
 * a beat later. It must never be the reason code doesn't appear.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  className,
}: {
  code: string
  language?: string
  className?: string
}) {
  // Stamped with what it was highlighted FROM, and only used when that still matches what
  // we're rendering. A streaming answer re-renders this with a longer `code` every few
  // frames, so a stale highlight must fall back to plain text rather than show the old
  // block's markup — and deriving that during render keeps setState out of the effect body.
  const [done, setDone] = useState<{ code: string; lang: string; html: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const known = resolveLanguage(language)
  const html = done && done.code === code && done.lang === known ? done.html : null

  useEffect(() => {
    if (!known) return
    let alive = true
    void highlightCode(code, known).then((out) => {
      if (alive && out) setDone({ code, lang: known, html: out })
    })
    return () => {
      alive = false
    }
  }, [code, known])

  // Show the fence's own label ("tsx") rather than the resolved one ("typescript") — it's
  // what the answer said, and it's usually the more specific of the two.
  const label = language?.trim() || (known ? known : '')

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  return (
    <div
      className={cn(
        'group/code my-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-zinc-400">
          {label || 'code'}
        </span>
        <button
          type="button"
          onClick={() => {
            void copyText(code).then((ok) => {
              if (ok) setCopied(true)
              else toast.error('Could not copy to the clipboard')
            })
          }}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
        >
          {copied ? (
            <>
              <Check className="size-3.5 text-emerald-400" />
              Copied
            </>
          ) : (
            <>
              <Copy className="size-3.5" />
              Copy
            </>
          )}
        </button>
      </div>
      {/* hljs: the token colours live in index.css so both this and any future code
          surface share one palette. */}
      <pre className="hljs overflow-x-auto p-4 text-xs leading-relaxed">
        {html ? (
          <code
            className="font-mono"
            // highlight.js escapes the source it wraps, so this is its own markup only.
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <code className="font-mono">{code}</code>
        )}
      </pre>
    </div>
  )
})
