import type { CSSProperties } from "react"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Info,
  Loader2,
} from "lucide-react"

// Tinted circular icon badges — mirrors the icon-badge pattern used on the
// app's cards (ProjectCard, Skills rows) so toasts feel native, not generic.
const badge =
  "flex size-6 shrink-0 items-center justify-center rounded-full ring-1"

const icons = {
  success: (
    <span className={`${badge} bg-emerald-100 text-emerald-600 ring-emerald-600/20`}>
      <CheckCircle2 className="size-4" />
    </span>
  ),
  error: (
    <span className={`${badge} bg-red-100 text-red-600 ring-red-600/20`}>
      <CircleAlert className="size-4" />
    </span>
  ),
  warning: (
    <span className={`${badge} bg-amber-100 text-amber-600 ring-amber-600/20`}>
      <AlertTriangle className="size-4" />
    </span>
  ),
  info: (
    <span className={`${badge} bg-sky-100 text-sky-600 ring-sky-600/20`}>
      <Info className="size-4" />
    </span>
  ),
  loading: (
    <span className={`${badge} bg-muted text-muted-foreground ring-border`}>
      <Loader2 className="size-4 animate-spin" />
    </span>
  ),
}

/**
 * Global toast surface. Instead of sonner's flat colored toasts we use the app's
 * own card aesthetic: a neutral popover surface, a colored left accent rail keyed
 * to the status palette (emerald/red/amber/sky), and tinted circular icon badges.
 * Layout utilities use `!` so they win over sonner's internal styles.
 */
function Toaster({ ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="bottom-right"
      closeButton
      expand
      gap={10}
      offset={20}
      duration={4500}
      icons={icons}
      toastOptions={{
        classNames: {
          toast:
            "qc-toast group !gap-3 !rounded-xl !border !border-border/70 !bg-popover/95 !px-4 !py-3.5 !text-popover-foreground !shadow-lg !shadow-black/[0.06] backdrop-blur-md " +
            "transition-[box-shadow,border-color] !duration-300 hover:!shadow-xl hover:!shadow-black/[0.1] hover:!border-border " +
            // gradient accent rail keyed to status, with a soft glow
            "before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-[3px] before:rounded-full before:content-[''] before:transition-colors before:duration-300 " +
            "data-[type=default]:before:bg-gradient-to-b data-[type=default]:before:from-primary/40 data-[type=default]:before:to-primary/10 " +
            "data-[type=success]:before:bg-gradient-to-b data-[type=success]:before:from-emerald-400 data-[type=success]:before:to-emerald-600 data-[type=success]:before:shadow-[0_0_10px_-1px_theme(colors.emerald.500/0.6)] " +
            "data-[type=error]:before:bg-gradient-to-b data-[type=error]:before:from-red-400 data-[type=error]:before:to-red-600 data-[type=error]:before:shadow-[0_0_10px_-1px_theme(colors.red.500/0.6)] " +
            "data-[type=warning]:before:bg-gradient-to-b data-[type=warning]:before:from-amber-400 data-[type=warning]:before:to-amber-600 data-[type=warning]:before:shadow-[0_0_10px_-1px_theme(colors.amber.500/0.6)] " +
            "data-[type=info]:before:bg-gradient-to-b data-[type=info]:before:from-sky-400 data-[type=info]:before:to-sky-600 data-[type=info]:before:shadow-[0_0_10px_-1px_theme(colors.sky.500/0.6)] " +
            "data-[type=loading]:before:bg-gradient-to-b data-[type=loading]:before:from-muted-foreground/40 data-[type=loading]:before:to-muted-foreground/10",
          title: "!text-sm !font-semibold !tracking-tight !text-foreground",
          description: "!text-xs !leading-snug !text-muted-foreground",
          content: "!gap-0.5",
          icon: "qc-toast-icon !mr-0 mt-0.5 self-start",
          actionButton:
            "!rounded-md !bg-primary !px-2.5 !py-1 !text-xs !font-medium !text-primary-foreground transition-opacity hover:!opacity-90 active:!scale-[0.98]",
          cancelButton:
            "!rounded-md !bg-muted !px-2.5 !py-1 !text-xs !font-medium !text-muted-foreground transition-colors hover:!bg-muted/70",
          closeButton:
            "!rounded-md !border !border-border !bg-background !text-muted-foreground transition-colors hover:!bg-muted hover:!text-foreground",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius-lg)",
          // Close button → top-right, clear of the left accent rail.
          "--toast-close-button-start": "unset",
          "--toast-close-button-end": "0",
          "--toast-close-button-transform": "translate(35%, -35%)",
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
