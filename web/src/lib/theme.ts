import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark'

/** Same key the inline boot script in `index.html` reads — keep both in step. */
export const THEME_KEY = 'qc.theme'

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** The theme actually on screen: the engineer's stored pick, else the OS setting. */
export function resolveTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY)
  return stored === 'light' || stored === 'dark' ? stored : systemTheme()
}

/** Tailwind v4's dark variant is `.dark *`, so the class goes on <html>. */
export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
  document.documentElement.style.colorScheme = theme
}

/**
 * Light/dark toggle backed by localStorage.
 *
 * Initial state is read from the DOM (the boot script in `index.html` already applied the
 * right class before first paint), so mounting can't flash the wrong theme. Until the user
 * picks one we follow the OS — hence the `change` listener, which stops mattering the moment
 * something is stored.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  )

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq) return
    function onChange() {
      if (localStorage.getItem(THEME_KEY)) return // an explicit pick wins over the OS
      const next = systemTheme()
      applyTheme(next)
      setThemeState(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
    setThemeState(next)
  }, [])

  const toggle = useCallback(
    () => setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark'),
    [setTheme],
  )

  return { theme, setTheme, toggle }
}
