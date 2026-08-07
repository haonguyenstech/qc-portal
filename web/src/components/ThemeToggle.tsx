import { useLocation } from 'react-router-dom'
import { Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'

/**
 * Light/dark switch, parked beside the notification bell.
 *
 * It mirrors `NotificationBell`'s fixed placement (including the chat page's own h-14 header
 * row) and sits one button-width to its left, so the two read as one cluster. Same 36px pill
 * shape as the bell — this is chrome, not a page control.
 */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const inChatHeader = useLocation().pathname === '/chat'
  const dark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={toggle}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-pressed={dark}
      className={cn(
        'fixed z-30 flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 text-muted-foreground shadow-sm backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:text-foreground hover:shadow-md active:scale-95',
        inChatHeader ? 'right-[3.75rem] top-2.5' : 'right-[4.25rem] top-5',
      )}
    >
      {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  )
}
