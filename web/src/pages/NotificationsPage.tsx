import { useNavigate } from 'react-router-dom'
import {
  AlertTriangle,
  Bell,
  CheckCheck,
  CheckCircle2,
  Info,
  Trash2,
  X,
  XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useNotifications, type NotificationKind } from '@/lib/notifications'

const KIND_STYLES: Record<NotificationKind, { icon: typeof Info; color: string; ring: string }> = {
  success: { icon: CheckCircle2, color: 'text-emerald-500', ring: 'bg-emerald-500/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-500', ring: 'bg-amber-500/10' },
  error: { icon: XCircle, color: 'text-destructive', ring: 'bg-destructive/10' },
  info: { icon: Info, color: 'text-sky-500', ring: 'bg-sky-500/10' },
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function NotificationsPage() {
  const { notifications, unreadCount, markAllRead, markRead, remove, clearAll } =
    useNotifications()
  const navigate = useNavigate()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <Bell className="h-6 w-6" />
            Notifications
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {notifications.length === 0
              ? 'Updates from your test-case generation jobs show up here.'
              : `${notifications.length} notification${notifications.length === 1 ? '' : 's'}` +
                (unreadCount > 0 ? ` · ${unreadCount} unread` : '')}
          </p>
        </div>
        {notifications.length > 0 && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={markAllRead}
              disabled={unreadCount === 0}
              className="transition-all duration-200 active:scale-[0.98]"
            >
              <CheckCheck className="h-4 w-4" />
              Mark all read
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={clearAll}
              className="text-muted-foreground transition-all duration-200 hover:text-destructive active:scale-[0.98]"
            >
              <Trash2 className="h-4 w-4" />
              Clear all
            </Button>
          </div>
        )}
      </div>

      {notifications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Bell className="h-6 w-6 text-muted-foreground" />
            </span>
            <div className="text-sm font-medium">No notifications yet</div>
            <div className="max-w-sm text-sm text-muted-foreground">
              When a background test-case generation job finishes, you'll see it here.
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {notifications.map((n) => {
                const { icon: Icon, color, ring } = KIND_STYLES[n.kind]
                return (
                  <li
                    key={n.id}
                    className={cn(
                      'group relative flex items-start gap-4 px-5 py-4 transition-colors',
                      n.to && 'cursor-pointer hover:bg-muted/50',
                      !n.read && 'bg-primary/[0.04]',
                    )}
                    onClick={() => {
                      if (!n.read) markRead(n.id)
                      if (n.to) navigate(n.to)
                    }}
                  >
                    {!n.read && (
                      <span className="absolute left-2 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary" />
                    )}
                    <span
                      className={cn(
                        'flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
                        ring,
                      )}
                    >
                      <Icon className={cn('h-4.5 w-4.5', color)} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium leading-snug">{n.title}</span>
                        {!n.read && (
                          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            New
                          </span>
                        )}
                      </div>
                      {n.description && (
                        <p className="mt-1 text-sm text-muted-foreground">{n.description}</p>
                      )}
                      <div className="mt-1.5 text-xs text-muted-foreground/70">
                        {formatWhen(n.createdAt)}
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={(e) => {
                        e.stopPropagation()
                        remove(n.id)
                      }}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground/50 opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
