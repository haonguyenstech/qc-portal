import { useCallback, useEffect, useState } from 'react'

// A quick-insert snippet for the "Instructions for the AI" box on the run form.
export interface Hint {
  id: string
  label: string
  text: string
}

const STORAGE_KEY = 'qc.instructionHints'

// Shipped defaults — used on first run and when the user resets.
export const DEFAULT_HINTS: Hint[] = [
  { id: 'login', label: 'Login credentials', text: 'Log in with username `qa@example.com` and password `••••••` before testing.' },
  { id: 'mobile', label: 'Test on mobile', text: 'Also verify the mobile layout at a 375px viewport, not just desktop.' },
  { id: 'focus', label: 'Focus area', text: 'Pay special attention to the checkout / payment flow.' },
  { id: 'known', label: 'Known issue', text: 'Ignore the known issue with the cookie banner — it is already tracked.' },
  { id: 'validation', label: 'Form validation', text: 'Check every form field shows a clear inline validation message on bad input.' },
  { id: 'edge', label: 'Edge cases', text: 'Try empty states, very long text, and invalid input where relevant.' },
]

export function newHintId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `h-${Math.random().toString(36).slice(2)}`
  }
}

function isHint(v: unknown): v is Hint {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as Hint).id === 'string' &&
    typeof (v as Hint).label === 'string' &&
    typeof (v as Hint).text === 'string'
  )
}

function load(): Hint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_HINTS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_HINTS
    const valid = parsed.filter(isHint)
    return valid.length ? valid : DEFAULT_HINTS
  } catch {
    return DEFAULT_HINTS
  }
}

function save(hints: Hint[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hints))
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

/** Manage the user's instruction-hint chips, persisted to localStorage. */
export function useHints() {
  const [hints, setHints] = useState<Hint[]>(load)

  useEffect(() => {
    save(hints)
  }, [hints])

  const addHint = useCallback((label: string, text: string) => {
    const entry: Hint = { id: newHintId(), label: label.trim(), text: text.trim() }
    if (!entry.label || !entry.text) return false
    setHints((prev) => [...prev, entry])
    return true
  }, [])

  const updateHint = useCallback((id: string, patch: Partial<Pick<Hint, 'label' | 'text'>>) => {
    setHints((prev) => prev.map((h) => (h.id === id ? { ...h, ...patch } : h)))
  }, [])

  const removeHint = useCallback((id: string) => {
    setHints((prev) => prev.filter((h) => h.id !== id))
  }, [])

  const resetHints = useCallback(() => {
    setHints(DEFAULT_HINTS)
  }, [])

  return { hints, addHint, updateHint, removeHint, resetHints }
}
