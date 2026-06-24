import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

// A tiny app-wide notification store. Notifications persist in localStorage so the
// bell keeps a short history across reloads. This is UI-only state — nothing here
// touches the backend.

export type NotificationKind = 'success' | 'warning' | 'error' | 'info'

export interface AppNotification {
  id: string
  kind: NotificationKind
  title: string
  description?: string
  /** Optional in-app link the bell item navigates to when clicked. */
  to?: string
  createdAt: string // ISO
  read: boolean
}

interface NotificationContextValue {
  notifications: AppNotification[]
  unreadCount: number
  notify: (n: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => void
  markAllRead: () => void
  markRead: (id: string) => void
  remove: (id: string) => void
  clearAll: () => void
}

const STORAGE_KEY = 'qc.notifications'
const MAX_NOTIFICATIONS = 50

const NotificationContext = createContext<NotificationContextValue | null>(null)

function load(): AppNotification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (n): n is AppNotification =>
        n && typeof n.id === 'string' && typeof n.title === 'string',
    )
  } catch {
    return []
  }
}

let counter = 0
function makeId(): string {
  counter += 1
  // crypto.randomUUID is available in all target browsers; fall back just in case.
  try {
    return crypto.randomUUID()
  } catch {
    return `n-${Date.now()}-${counter}`
  }
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>(load)

  // Persist whenever the list changes (side effect, not setState — lint-safe).
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications))
    } catch {
      /* storage full / unavailable — ignore */
    }
  }, [notifications])

  const notify = useCallback(
    (n: Omit<AppNotification, 'id' | 'createdAt' | 'read'>) => {
      const entry: AppNotification = {
        ...n,
        id: makeId(),
        createdAt: new Date().toISOString(),
        read: false,
      }
      setNotifications((prev) => [entry, ...prev].slice(0, MAX_NOTIFICATIONS))
    },
    [],
  )

  const markAllRead = useCallback(() => {
    setNotifications((prev) =>
      prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev,
    )
  }, [])

  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    )
  }, [])

  const remove = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const unreadCount = notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0)

  const value = useMemo<NotificationContextValue>(
    () => ({ notifications, unreadCount, notify, markAllRead, markRead, remove, clearAll }),
    [notifications, unreadCount, notify, markAllRead, markRead, remove, clearAll],
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext)
  if (!ctx) throw new Error('useNotifications must be used within a NotificationProvider')
  return ctx
}
