/**
 * The portal's date picker: shadcn's Popover + Calendar, wrapped so a caller
 * still deals in the plain `YYYY-MM-DD` strings our API query params use.
 *
 * The `YYYY-MM-DD` <-> `Date` conversion lives in `lib/dates.ts` — it is not
 * incidental, and the comment there says which timezone bug it exists to avoid.
 */

import { useState } from 'react'
import { CalendarIcon, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDay, parseDay } from '@/lib/dates'

export interface DatePickerProps {
  /** `YYYY-MM-DD`, or '' for unset. */
  value: string
  onChange: (value: string) => void
  /** Shown on the trigger when nothing is picked. */
  placeholder?: string
  /** Days the calendar refuses — e.g. `{ before: someDate }`. */
  disabled?: React.ComponentProps<typeof Calendar>['disabled']
  /** Show the inline clear button once a date is set. */
  clearable?: boolean
  className?: string
  'aria-label'?: string
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Pick a date',
  disabled,
  clearable = true,
  className,
  'aria-label': ariaLabel,
}: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const selected = parseDay(value)

  return (
    <div className={cn('relative inline-flex', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={ariaLabel}
            className={cn(
              'h-7 justify-start gap-1.5 rounded-full border-border/60 px-3 text-xs font-normal shadow-none transition-all duration-200 hover:border-border active:scale-[0.98]',
              // Room for the clear button so a long date never slides under it.
              selected && clearable ? 'pr-7' : '',
              !selected && 'text-muted-foreground',
            )}
          >
            <CalendarIcon className="size-3.5 shrink-0" />
            {selected
              ? selected.toLocaleDateString(undefined, {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                })
              : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto rounded-2xl p-0" align="start">
          <Calendar
            mode="single"
            selected={selected}
            defaultMonth={selected}
            disabled={disabled}
            autoFocus
            captionLayout="dropdown"
            onSelect={(date) => {
              onChange(formatDay(date))
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {selected && clearable && (
        <button
          type="button"
          aria-label="Clear date"
          // Stops the click reaching the trigger, which would open the popover
          // on the way out and leave a calendar hanging over a cleared field.
          onClick={(e) => {
            e.stopPropagation()
            onChange('')
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}
