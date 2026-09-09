# Installing the portal as a desktop app (PWA)

The portal is installable. There is **one** portal, not a web version and a PWA version:
same URL, same `web/dist`, same bundle. Installing only changes the *window* it opens in —
its own icon in the taskbar / Dock, no address bar, no tab strip. Anyone who keeps using
`http://localhost:5174` in a browser tab sees exactly what they saw before.

That is the whole design goal, and it is why this is four files and no build-time branch.
A second build, a second entry point or a `?pwa=1` mode would be two things to keep in step,
and they would drift.

## The pieces

| File | Job |
|------|-----|
| `web/public/manifest.webmanifest` | name, `display: standalone`, `start_url: /`, the icons |
| `web/public/sw.js` | the service worker — **caches nothing**, see below |
| `web/src/lib/pwa.ts` | registers it, production only, fails soft |
| `web/index.html` | the `<link rel="manifest">` and the two `theme-color` metas |
| `web/public/pwa-icon-{192,512}.png`, `pwa-icon.svg` | the app icon |

All of it lives in `web/public`, so `vite build` copies it into `web/dist` untouched and the
server's existing `express.static(webDist)` serves it. **No server change was needed** — and
`.webmanifest` already resolves to `application/manifest+json`, which the browser requires;
if that ever regresses, the manifest is silently ignored and the install option disappears
with no error anywhere.

## The service worker caches nothing, on purpose

`sw.js` has a fetch handler that passes every request straight through. That is not a stub to
fill in later — it is the correct shape here, for three reasons that a cache would each break:

1. **The self-update.** `qc-portal --update` rebuilds `web/dist` behind the same URL. A worker
   that had precached the app shell would keep serving the OLD bundle afterwards: the sidebar
   footer would still read the previous version, "update now" would appear to do nothing, and
   the cause would be invisible. A pass-through worker cannot go stale.
2. **The remote-access gate.** Over a Cloudflare Tunnel, a visitor without a valid session gets
   the unlock page and *nothing else, the JS bundle included* (`remote-access.md`). Anything
   answered out of a cache is answered **without asking the server** — which is precisely the
   check that gate performs. So no cached navigations and no cached bundle, ever.
3. **There is nothing to win.** The server is on localhost; the assets already come off the
   local disk. And every page needs the server anyway — a run spawns `claude`, the log arrives
   over a WebSocket, the jobs are polled — so an "offline" portal could only be a shell that
   lies about being alive. Offline is not a missing feature here; it is a wrong one.

The handler exists at all because older Chromium wants a registered worker *with* a fetch
handler before it offers to install. The `activate` step deletes every cache it finds, so if a
future version of this file ever does cache, upgrading is what clears the old bytes rather than
leaving them to be served.

If the portal is ever installed on a **phone** over the tunnel and asset latency genuinely
matters, cache only the content-hashed files under `/assets/` — immutable by construction, so
they cannot be stale — and still never a navigation.

## Registration is production-only

`registerServiceWorker()` returns early unless `import.meta.env.PROD`. `npm run dev` serves the
UI from Vite on **:5175** while the portal an engineer installs is the built bundle the server
hands out on **:5174** — a different origin, so the two never collide. Registering in dev would
only put a worker in front of HMR for no gain.

Everything in that function fails soft. A browser with no `serviceWorker`, or a registration
that throws, leaves a portal that opens in a tab exactly as it always has. That is a supported
way to run it, so it is never worth an error in the UI.

## The icon is the mark on a solid tile, not the favicon

`favicon.svg` is deliberately a bare seal with **no** background, because a shaped silhouette is
easier to pick out of a strip of rounded-square tabs, and its colours flip with
`prefers-color-scheme`.

Neither trick works for an app icon. A PNG cannot answer a media query, and a transparent
slate-900 seal vanishes into a dark taskbar. So the app icon is the System-Style UI *mark*
treatment — the seal in `#f8fafc` on a solid `#0f172a` rounded tile, the same design the
existing `apple-touch-icon.png` already used — which reads on light and dark OS chrome alike.

`web/public/pwa-icon.svg` is the source; the two PNGs were rendered from it at 192 and 512
(headless Edge, `--screenshot`). Regenerate both if the mark changes — and remember `<AppLogo>`
in `web/src/App.tsx` and `favicon.svg` share that geometry.

Only non-maskable (`purpose: any`) icons are shipped: desktop Windows and macOS use the icon
as given. A maskable variant is what Android home screens want, and belongs with phone install
if that is ever scoped in.

## The title bar follows the theme

Two `theme-color` metas with `prefers-color-scheme` media queries, not one flat colour:
Chromium tints the installed window's title bar from them, so a single value would give a
dark-mode install a white title bar above a slate app. The manifest's `theme_color` is only the
fallback for a browser that ignores the metas.

## Where it installs

| Platform | How |
|----------|-----|
| Windows — Edge / Chrome | install icon in the address bar, or ⋯ → Apps → *Install QC Portal*. Pins to the taskbar and Start. |
| macOS — Edge / Chrome | same address-bar icon; lands in `~/Applications` and the Dock. |
| macOS — Safari 17+ | File → *Add to Dock* (Safari reads the manifest for the name and icon). |

`http://localhost` and `http://127.0.0.1` are **secure contexts**, so no HTTPS and no
certificate is needed for a local install. Elsewhere a service worker needs HTTPS, which is
what `/remote` provides.

## How it was verified

Against the built bundle on `:5174` in Edge 152: `isSecureContext` true, the worker
`activated` and controlling the page (`navigator.serviceWorker.controller` set), the manifest
fetched as `application/manifest+json` and parsed with `Page.getAppManifest` → `errors: []`,
`Page.getInstallabilityErrors` → `[]` (nothing standing between it and the install button), both
`theme-color` metas present, and the app itself rendering and routing normally with the worker
in front of it.
