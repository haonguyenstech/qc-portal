/*
 * QC Portal service worker — the ONE thing that makes the portal installable as a
 * desktop app, and deliberately NOTHING else. It caches nothing.
 *
 * That is not laziness, it is the only correct shape here, for three reasons:
 *
 *  1. THE SELF-UPDATE. `qc-portal --update` rebuilds web/dist behind the same URL.
 *     A worker that had precached the app shell would keep serving the OLD bundle
 *     after the update — the sidebar footer would still read the previous version
 *     and nobody would know why. A pass-through worker cannot go stale.
 *
 *  2. THE REMOTE-ACCESS GATE. Over a Cloudflare Tunnel a visitor without a valid
 *     session must get the unlock page and NOTHING else, the JS bundle included
 *     (see docs/architecture/remote-access.md). Anything served out of a cache here
 *     is served without asking the server, which is exactly the check that gate is.
 *     So: no cached navigations, no cached bundle, no exceptions.
 *
 *  3. THERE IS NOTHING TO WIN. The server is on localhost; assets already come off
 *     the local disk. And every page needs the server anyway — a run spawns
 *     `claude`, the log arrives over a WebSocket, the jobs are polled — so an
 *     "offline" portal could only ever be a shell that lies about being alive.
 *
 * The fetch handler exists because older Chromium requires a registered worker WITH
 * one before it will offer to install. Keep it a plain pass-through: `respondWith`
 * of an untouched `fetch(event.request)` preserves credentials, redirects and range
 * requests exactly as the browser would have made them.
 *
 * If the portal is ever installed on a phone over the tunnel and asset latency
 * actually matters, cache ONLY the content-hashed files under /assets/ (immutable
 * by construction, so they can never be stale) and still never a navigation.
 */

// Take over from any previously installed worker immediately, so an update to this
// file can never leave two generations of it fighting over the same clients.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Nothing to keep. If an earlier version of this file ever did cache, this is
      // what removes it on upgrade rather than leaving it to serve stale bytes.
      const names = await caches.keys()
      await Promise.all(names.map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
