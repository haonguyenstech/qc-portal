import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Check, Minus } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The single source of truth for how a checkbox LOOKS. Both the interactive
 * `Checkbox` and the presentational `CheckboxIndicator` render this, so the two
 * never drift apart the way the old hand-rolled `rounded-[5px]` spans did.
 */
const checkboxBox = cva(
  "flex shrink-0 items-center justify-center border bg-background text-transparent transition-all duration-200 " +
    "peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 peer-focus-visible:border-ring " +
    "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      size: {
        sm: "size-4 rounded-[6px] [&_svg]:size-3",
        default: "size-[18px] rounded-[6px] [&_svg]:size-3.5",
        lg: "size-5 rounded-[7px] [&_svg]:size-3.5",
      },
      state: {
        off: "border-muted-foreground/40 hover:border-muted-foreground/70",
        on: "border-primary bg-primary text-primary-foreground",
      },
    },
    defaultVariants: { size: "default", state: "off" },
  }
)

type BoxProps = VariantProps<typeof checkboxBox>

/**
 * The box on its own — no input, no click handling. Use it when the control
 * already lives inside a `<button>` (a selectable list row), where nesting a
 * real `<input>` would be invalid HTML. The parent owns `aria-pressed`/`onClick`.
 */
function CheckboxIndicator({
  checked,
  indeterminate = false,
  size,
  className,
}: {
  checked: boolean
  indeterminate?: boolean
  className?: string
} & Pick<BoxProps, "size">) {
  const on = checked || indeterminate
  return (
    <span
      data-slot="checkbox-indicator"
      className={cn(checkboxBox({ size, state: on ? "on" : "off" }), className)}
      aria-hidden
    >
      {checked ? (
        <Check strokeWidth={3} />
      ) : indeterminate ? (
        <Minus strokeWidth={3} />
      ) : null}
    </span>
  )
}

/**
 * A real `<input type="checkbox">` under a styled box, so it stays a drop-in for
 * every native call site: `checked` / `onChange` / `disabled` / `aria-label` all
 * behave exactly as before, and it keeps native keyboard + form semantics.
 * `indeterminate` is a DOM property, not an attribute, so it is set via the ref.
 */
function Checkbox({
  className,
  size,
  indeterminate = false,
  onCheckedChange,
  onChange,
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "type" | "size"> &
  Pick<BoxProps, "size"> & {
    indeterminate?: boolean
    /** Convenience alongside `onChange`, for call sites that only want the value. */
    onCheckedChange?: (checked: boolean) => void
  }) {
  const inner = React.useRef<HTMLInputElement>(null)
  // Uncontrolled call sites still need the box to repaint, so mirror the DOM.
  const [selfChecked, setSelfChecked] = React.useState(
    Boolean(props.defaultChecked)
  )

  React.useImperativeHandle(ref, () => inner.current as HTMLInputElement)
  React.useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate
  }, [indeterminate])

  const isChecked = props.checked ?? selfChecked
  const on = Boolean(isChecked) || indeterminate

  return (
    <span
      data-slot="checkbox"
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        props.disabled ? "cursor-not-allowed" : "cursor-pointer",
        className
      )}
    >
      <input
        {...props}
        ref={inner}
        type="checkbox"
        className="peer absolute inset-0 z-10 m-0 cursor-[inherit] appearance-none opacity-0 outline-none"
        onChange={(e) => {
          setSelfChecked(e.target.checked)
          onChange?.(e)
          onCheckedChange?.(e.target.checked)
        }}
      />
      <span
        className={cn(checkboxBox({ size, state: on ? "on" : "off" }))}
        aria-hidden
      >
        {isChecked && !indeterminate ? (
          <Check strokeWidth={3} />
        ) : indeterminate ? (
          <Minus strokeWidth={3} />
        ) : null}
      </span>
    </span>
  )
}

export { Checkbox, CheckboxIndicator }
