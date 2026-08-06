import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Info,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useNotifications, type NotificationKind } from '@/lib/notifications'

/** Icon + its tinted chip, per kind — the portal's status palette (emerald ok / amber warning
 *  / red failed / sky info) in the same icon-chip shape the rest of the app uses. */
const KIND_STYLES: Record<NotificationKind, { icon: typeof Info; color: string; chip: string }> = {
  success: { icon: CheckCircle2, color: 'text-emerald-600 dark:text-emerald-400', chip: 'bg-emerald-500/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-600 dark:text-amber-400', chip: 'bg-amber-500/10' },
  error: { icon: XCircle, color: 'text-destructive', chip: 'bg-destructive/10' },
  info: { icon: Info, color: 'text-sky-600 dark:text-sky-400', chip: 'bg-sky-500/10' },
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return 'just now'
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export default function NotificationBell() {
  const { notifications, unreadCount, markAllRead, markRead, remove, clearAll } =
    useNotifications()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()
  const inChatHeader = useLocation().pathname === '/chat'

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /**
   * Which rows were unread when the panel was opened.
   *
   * Opening marks everything read (the badge has to clear), which used to wipe the unread
   * tint at the same instant — so the one thing the panel is opened to find out, "what's
   * new since I last looked?", was never visible. The ids are snapshotted first and keep
   * their highlight for as long as the panel stays open.
   */
  const [newIds, setNewIds] = useState<Set<string>>(new Set())
  /** How many rows the panel is currently marking as new (the badge itself is already cleared). */
  const newCount = notifications.reduce((n, x) => n + (newIds.has(x.id) || !x.read ? 1 : 0), 0)

  // Side effects run in the HANDLER, never inside a setState updater: React runs the updater
  // during render, so marking everything read from in there updated the notification provider
  // mid-render ("Cannot update a component while rendering a different component").
  function toggle() {
    if (open) {
      setOpen(false)
      return
    }
    setNewIds(new Set(notifications.filter((n) => !n.read).map((n) => n.id)))
    if (unreadCount > 0) markAllRead() // opening clears the unread badge
    setOpen(true)
  }

  return (
    <div
      ref={rootRef}
      className={cn(
        'fixed z-30',
        // Chat is full-bleed and has its own h-14 header, so the bell has to sit ON that row
        // rather than float above the transcript: (56 - 36) / 2 = 10px, and right-4 lines it
        // up with the header's own px-4 controls. Every other page keeps the floating offset.
        inChatHeader ? 'right-4 top-2.5' : 'right-6 top-5',
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-full border bg-card/80 text-muted-foreground shadow-sm backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:text-foreground hover:shadow-md active:scale-95',
          open && 'border-primary/30 bg-primary/10 text-primary',
        )}
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-white tabular-nums">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-[24rem] max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-2xl border border-border/60 bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-semibold tracking-tight">Notifications</span>
              {newCount > 0 && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary tabular-nums">
                  {newCount} new
                </span>
              )}
            </div>
            {notifications.length > 0 && (
              <div className="flex shrink-0 items-center gap-0.5">
                {newCount > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      markAllRead()
                      setNewIds(new Set())
                    }}
                    title="Mark all as read"
                    aria-label="Mark all as read"
                    className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <CheckCheck className="size-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={clearAll}
                  title="Clear all"
                  aria-label="Clear all notifications"
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
              <span className="flex size-10 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
                <Bell className="size-4" />
              </span>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">No notifications yet</p>
                <p className="text-xs text-muted-foreground">
                  Finished crawls, generations and runs land here.
                </p>
              </div>
            </div>
          ) : (
            /* overflow-x-hidden is load-bearing: `overflow-y-auto` alone computes overflow-x to
               `auto` too, so one unbreakable token in a description (an https:// URL — every
               Auto Agent notice carries one) pushed the min-content width past the panel and the
               whole list scrolled sideways. The wrap classes below are the other half of it. */
            <ul className="max-h-[26rem] divide-y divide-border/60 overflow-y-auto overflow-x-hidden overscroll-contain">
              {notifications.map((n) => {
                const { icon: Icon, color, chip } = KIND_STYLES[n.kind]
                const isNew = newIds.has(n.id) || !n.read
                return (
                  <li
                    key={n.id}
                    className={cn(
                      'group relative flex gap-3 px-4 py-3 transition-colors',
                      n.to && 'cursor-pointer hover:bg-muted/50',
                      isNew && 'bg-primary/[0.035]',
                    )}
                    onClick={() => {
                      if (!n.read) markRead(n.id)
                      if (n.to) {
                        setOpen(false)
                        navigate(n.to)
                      }
                    }}
                  >
                    {/* Unread marks the row from its left edge instead of a floating dot that
                        used to be centred vertically — i.e. parked at a random height beside a
                        three-line description. */}
                    {isNew && (
                      <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" aria-hidden />
                    )}
                    <span
                      className={cn(
                        'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-xl',
                        chip,
                      )}
                    >
                      <Icon className={cn('size-4', color)} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 break-words text-sm font-medium leading-snug">
                          {n.title}
                        </span>
                        {/* Time moved up beside the title: it saves the row a third line, and
                            "when" belongs with "what", not under the description. */}
                        <span
                          title={new Date(n.createdAt).toLocaleString()}
                          className="shrink-0 text-[11px] tabular-nums text-muted-foreground/80"
                        >
                          {timeAgo(n.createdAt)}
                        </span>
                      </div>
                      {n.description && (
                        <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                          {n.description}
                        </p>
                      )}
                      {n.to && (
                        <span className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                          Open
                          <ChevronRight className="size-3" />
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(n.id)
                      }}
                      className="size-6 shrink-0 self-start rounded-full text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X className="mx-auto size-3.5" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}

          <button
            type="button"
            onClick={() => {
              setOpen(false)
              navigate('/notifications')
            }}
            className="flex w-full items-center justify-center gap-1.5 border-t border-border/60 px-4 py-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            View all notifications
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
