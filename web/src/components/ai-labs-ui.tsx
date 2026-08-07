/**
 * The shared surface for QC AI Labs (`/ai-labs` and `/ai-labs/:id`).
 *
 * Both pages render OUTSIDE the portal shell (see `App.tsx`) and carry their own always-dark
 * theme in literal colours rather than the portal's semantic tokens — so it looks the same
 * whichever theme the portal is in. That is deliberate and lives HERE so it's stated once;
 * don't "fix" it back to `bg-card` / `text-muted-foreground`, and don't copy this palette into
 * a page that lives inside the shell.
 *
 * It is also deliberately PLAIN. An earlier pass had drifting aurora, a gradient headline,
 * cursor spotlights and glowing card edges; over a shelf of two entries that read as decoration
 * around very little. If something here seems to need an animation to hold attention, the fix is
 * better copy.
 */
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Check } from 'lucide-react'

import type { LabTool } from '@/lib/ai-labs'
import { cn } from '@/lib/utils'

/**
 * The page frame: dark surface, one-line header, centred column.
 *
 * `back` is where the ← goes — the list for a detail page, the portal for the list. A
 * destination with no way out is a trap.
 */
export function LabShell({
  title,
  back,
  backLabel,
  children,
}: {
  title: string
  back: string
  backLabel: string
  children: React.ReactNode
}) {
  // The tab is the only chrome these pages don't draw themselves, and "QC Portal — Acceptance
  // testing" on a standalone page is the one place the shell still shows through.
  useEffect(() => {
    const prev = document.title
    document.title = title === 'QC AI Labs' ? title : `${title} · QC AI Labs`
    return () => {
      document.title = prev
    }
  }, [title])

  return (
    // [color-scheme:dark] so the browser paints native scrollbars and form controls dark too —
    // a light scrollbar down the side of this page is the tell that gives it away.
    <div className="min-h-svh bg-[#0a0a0c] text-zinc-200 [color-scheme:dark]">
      <header className="border-b border-white/[0.07]">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4 sm:px-8">
          <Link
            to={back}
            title={backLabel}
            aria-label={backLabel}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-zinc-500 transition-colors duration-200 hover:bg-white/5 hover:text-white"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <Link to="/ai-labs" className="text-sm font-semibold tracking-tight text-white">
            QC AI Labs
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24 sm:px-8">{children}</main>
    </div>
  )
}

export function Chip({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-400',
        className,
      )}
    >
      {children}
    </span>
  )
}

/** A flat tile with the initials — a logo we don't have and shouldn't fake. */
export function Monogram({ text, large }: { text: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] font-semibold tracking-tight text-zinc-300',
        large ? 'size-14 text-lg' : 'size-11 text-sm',
      )}
    >
      {text}
    </span>
  )
}

/**
 * The fit score, stated as plainly as it deserves. It used to be a gradient ring; a dial implies
 * an instrument took a reading, and this is one person's judgement — so it's a number with the
 * words "our take" next to it.
 */
export function Fit({ value }: { value: number }) {
  return (
    <span className="whitespace-nowrap text-xs text-zinc-500">
      QC fit <span className="font-semibold tabular-nums text-zinc-300">{value}</span>
      <span className="text-zinc-600">/100 · our take</span>
    </span>
  )
}

export function Badges({ tool }: { tool: LabTool }) {
  return (
    <>
      <Chip>{tool.category}</Chip>
      <Chip>{tool.pricing}</Chip>
      {tool.inPortal && (
        <Chip className="border-emerald-400/25 text-emerald-300/90">
          <Check className="size-3" />
          In portal
        </Chip>
      )}
      {tool.builtHere && (
        <Chip className="border-violet-400/25 text-violet-300/90">Built in-house</Chip>
      )}
    </>
  )
}
