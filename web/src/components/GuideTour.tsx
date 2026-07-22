import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// A lightweight, dependency-free product tour: a dimmed overlay with a spotlight
// cut-out around the current step's target element, plus a tooltip card that walks
// the user Back / Next through the flow. Targets are addressed by CSS selector
// (usually a `data-tour="..."` attribute) so a page just tags its regions and hands
// this a list of steps. Steps whose element is missing are skipped, and a step may
// run an `action()` first (e.g. reveal a conditional control) before it's measured.

export interface TourStep {
  /** CSS selector for the element to spotlight (e.g. `[data-tour="search"]`). */
  selector: string
  title: string
  body: React.ReactNode
  /** Preferred tooltip side; falls back automatically when there's no room. */
  placement?: 'top' | 'bottom'
  /** Optional setup run before the step shows — e.g. select a row so a bar appears. */
  action?: () => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

const PAD = 8 // spotlight breathing room around the target
const GAP = 12 // distance from spotlight to tooltip
const TT_WIDTH = 340

export function GuideTour({
  steps,
  open,
  onClose,
}: {
  steps: TourStep[]
  open: boolean
  onClose: () => void
}) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const targetRef = useRef<HTMLElement | null>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; place: 'top' | 'bottom' }>({
    top: 0,
    left: 0,
    place: 'bottom',
  })

  function measure() {
    const el = targetRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
  }

  // Resolve step `i` moving in `dir` (+1/-1): run its action, wait for the element
  // to exist (a few frames), then show it — or skip to the next in that direction.
  function resolve(i: number, dir: 1 | -1) {
    if (i < 0 || i >= steps.length) {
      onClose()
      return
    }
    const step = steps[i]
    try {
      step.action?.()
    } catch {
      /* an action failing must not break the tour */
    }
    let tries = 0
    const tick = () => {
      const el = document.querySelector<HTMLElement>(step.selector)
      if (el) {
        targetRef.current = el
        el.scrollIntoView({ block: 'center', inline: 'nearest' })
        setIndex(i)
        // Let the scroll settle a frame, then measure.
        requestAnimationFrame(() => requestAnimationFrame(measure))
        return
      }
      if (tries++ < 10) {
        requestAnimationFrame(tick)
        return
      }
      resolve(i + dir, dir) // give up on this step — move along
    }
    tick()
  }

  // (Re)start whenever the tour opens. Deferred a frame so the first target's
  // setState lands outside the effect body (and after the portal has mounted).
  useEffect(() => {
    if (!open) {
      targetRef.current = null
      return
    }
    const id = requestAnimationFrame(() => resolve(0, 1))
    return () => cancelAnimationFrame(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Keep the spotlight glued to the target as the page scrolls / resizes.
  useEffect(() => {
    if (!open) return
    const onMove = () => measure()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  // Keyboard: Esc closes, ← / → navigate.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') resolve(index + 1, 1)
      else if (e.key === 'ArrowLeft') resolve(index - 1, -1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, index])

  // Position the tooltip relative to the spotlight, flipping/clamping to stay on-screen.
  useLayoutEffect(() => {
    if (!rect) return
    const ttH = tooltipRef.current?.offsetHeight ?? 160
    const vw = window.innerWidth
    const vh = window.innerHeight
    const preferTop = steps[index]?.placement === 'top'
    const roomBelow = vh - (rect.top + rect.height)
    const roomAbove = rect.top
    const place: 'top' | 'bottom' =
      preferTop && roomAbove > ttH + GAP + PAD
        ? 'top'
        : roomBelow > ttH + GAP + PAD || roomBelow >= roomAbove
          ? 'bottom'
          : 'top'
    const top =
      place === 'bottom' ? rect.top + rect.height + PAD + GAP : rect.top - PAD - GAP - ttH
    const left = Math.min(
      Math.max(12, rect.left + rect.width / 2 - TT_WIDTH / 2),
      vw - TT_WIDTH - 12,
    )
    setPos({ top: Math.max(12, top), left, place })
  }, [rect, index, steps])

  if (!open) return null
  const step = steps[index]

  return createPortal(
    <div className="fixed inset-0 z-[90]">
      {/* Click-blocker so the page behind the tour isn't interactable. */}
      <div className="absolute inset-0" onClick={(e) => e.stopPropagation()} />

      {/* Spotlight: a transparent box whose huge box-shadow dims everything else. */}
      {rect && (
        <div
          className="pointer-events-none absolute rounded-2xl ring-2 ring-primary transition-all duration-200"
          style={{
            top: rect.top - PAD,
            left: rect.left - PAD,
            width: rect.width + PAD * 2,
            height: rect.height + PAD * 2,
            boxShadow: '0 0 0 9999px rgba(2, 6, 23, 0.62)',
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        className="absolute z-[100] rounded-2xl border border-border/60 bg-card p-4 shadow-xl"
        style={{ top: pos.top, left: pos.left, width: TT_WIDTH, maxWidth: 'calc(100vw - 24px)' }}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Step {index + 1} of {steps.length}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="End tour"
          >
            <X className="size-4" />
          </button>
        </div>
        <h3 className="text-sm font-semibold tracking-tight">{step?.title}</h3>
        <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{step?.body}</div>

        {/* Progress dots */}
        <div className="mt-3 flex items-center gap-1">
          {steps.map((_, i) => (
            <span
              key={i}
              className={cn(
                'h-1.5 rounded-full transition-all',
                i === index ? 'w-4 bg-primary' : 'w-1.5 bg-muted',
              )}
            />
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip
          </button>
          <div className="flex items-center gap-1.5">
            {index > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => resolve(index - 1, -1)}
                className="h-8 gap-1 rounded-full active:scale-[0.98]"
              >
                <ChevronLeft className="size-3.5" />
                Back
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => resolve(index + 1, 1)}
              className="h-8 gap-1 rounded-full active:scale-[0.98]"
            >
              {index === steps.length - 1 ? 'Done' : 'Next'}
              {index < steps.length - 1 && <ChevronRight className="size-3.5" />}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
