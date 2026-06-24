import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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

const KIND_STYLES: Record<NotificationKind, { icon: typeof Info; color: string }> = {
  success: { icon: CheckCircle2, color: 'text-emerald-500' },
  warning: { icon: AlertTriangle, color: 'text-amber-500' },
  error: { icon: XCircle, color: 'text-destructive' },
  info: { icon: Info, color: 'text-sky-500' },
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

  function toggle() {
    setOpen((v) => {
      const next = !v
      if (next && unreadCount > 0) markAllRead() // opening clears the unread badge
      return next
    })
  }

  return (
    <div ref={rootRef} className="fixed right-6 top-5 z-30">
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
        <div className="absolute right-0 mt-2 w-96 max-w-[calc(100vw-3rem)] origin-top-right overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Bell className="h-4 w-4" />
              Notifications
            </div>
            {notifications.length > 0 && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={markAllRead}
                  title="Mark all as read"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={clearAll}
                  title="Clear all"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
              <Bell className="h-6 w-6 opacity-40" />
              No notifications yet
            </div>
          ) : (
            <ul className="max-h-[26rem] divide-y divide-border overflow-y-auto">
              {notifications.map((n) => {
                const { icon: Icon, color } = KIND_STYLES[n.kind]
                return (
                  <li
                    key={n.id}
                    className={cn(
                      'group relative flex gap-3 px-4 py-3 transition-colors',
                      n.to && 'cursor-pointer hover:bg-muted/60',
                      !n.read && 'bg-primary/[0.04]',
                    )}
                    onClick={() => {
                      if (!n.read) markRead(n.id)
                      if (n.to) {
                        setOpen(false)
                        navigate(n.to)
                      }
                    }}
                  >
                    {!n.read && (
                      <span className="absolute left-1.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full bg-primary" />
                    )}
                    <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium leading-snug">{n.title}</div>
                      {n.description && (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {n.description}
                        </div>
                      )}
                      <div className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {timeAgo(n.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(n.id)
                      }}
                      className="shrink-0 self-start rounded-md p-1 text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="h-3.5 w-3.5" />
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
            className="flex w-full items-center justify-center gap-1.5 border-t border-border px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            View all notifications
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  )
}
