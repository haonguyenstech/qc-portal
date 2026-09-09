/**
 * Register the service worker that makes the portal installable as a desktop app.
 *
 * The worker itself (web/public/sw.js) caches nothing on purpose — read the comment
 * at the top of that file, and docs/architecture/pwa.md, before giving it a cache.
 *
 * PRODUCTION ONLY. `npm run dev` serves the UI from Vite on :5175 while the portal a
 * QC engineer actually installs is the built bundle served by the server on :5174 —
 * a different origin, so nothing clashes. Registering in dev would only put a worker
 * in front of HMR for no gain.
 *
 * Everything here fails soft. An install that cannot register a worker is a portal
 * that opens in a tab exactly as it always has, which is the supported way to use
 * it; it is never worth an error in the UI.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return
  if (!('serviceWorker' in navigator)) return

  // After load, not during: registration competes with the first API calls otherwise,
  // and on a cold start those are what the engineer is waiting for.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // No worker: no install button. Nothing else about the portal changes.
    })
  })
}
