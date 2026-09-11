import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { pageAuditAvailable } from '../pageAudit.js'
import {
  MAX_DEVICES,
  probeUrl,
  responsiveRunDir,
  sanitizeDevice,
  type DeviceSpec,
} from '../responsiveCapture.js'
import {
  cancelResponsiveJob,
  deleteResponsiveJob,
  getResponsiveJob,
  listResponsiveJobs,
  startResponsiveJob,
} from '../responsiveJobs.js'
import { resolveProject } from '../projectScope.js'

/**
 * Responsive testing — `/responsive`.
 *
 * Four jobs:
 *   • GET  /available   — can a real browser be driven on this machine?
 *   • POST /probe       — is the URL reachable, and will it allow being framed?
 *   • POST /captures    — start a device sweep (polled by id, screenshots on disk)
 *   • GET  /frame       — the framing proxy, for a URL that refuses to be framed
 *
 * The interesting one is `/frame`; see the block comment above it.
 */

export const responsiveRouter = Router()

/**
 * Only http(s), and only an absolute URL.
 *
 * Everything in this file takes a URL from the browser and asks the SERVER to
 * fetch it, which is a different trust boundary from the browser doing it: the
 * server sits on the engineer's machine, inside whatever VPN and behind whatever
 * localhost-only service is running there. That is the entire point — a QC
 * engineer's target is usually `http://localhost:5173` or a staging host only the
 * corporate network can see, and a scheme allow-list is what keeps it to fetching
 * pages. `file:` would read the disk, and `data:`/`javascript:` would let a URL
 * carry its own payload into the frame.
 */
function parseTarget(raw: unknown): { url: string } | { error: string } {
  const value = String(raw ?? '').trim()
  if (!value) return { error: 'A URL is required.' }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return { error: `"${value}" is not a URL. Include the scheme, e.g. https://example.com.` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `Only http and https URLs can be tested (got ${parsed.protocol}).` }
  }
  return { url: parsed.toString() }
}

/** GET /api/responsive/available — whether the capture half can run here. */
responsiveRouter.get('/available', async (_req, res) => {
  res.json({ browser: await pageAuditAvailable() })
})

/**
 * POST /api/responsive/probe — reach the URL once and report what the live preview
 * cannot find out for itself (a framing header, a missing viewport meta).
 *
 * Cheap and side-effect free, so the page calls it as soon as a URL is entered.
 */
responsiveRouter.post('/probe', async (req, res) => {
  const target = parseTarget(req.body?.url)
  if ('error' in target) return res.status(400).json({ error: target.error })
  res.json(await probeUrl(target.url))
})

/** POST /api/responsive/captures — start a device sweep in the background. */
responsiveRouter.post('/captures', async (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })

  const target = parseTarget(req.body?.url)
  if ('error' in target) return res.status(400).json({ error: target.error })

  const rawDevices = Array.isArray(req.body?.devices) ? req.body.devices : []
  const devices = rawDevices
    .slice(0, MAX_DEVICES)
    .map((d: unknown, i: number) => sanitizeDevice(d, i))
    .filter((d: DeviceSpec | null): d is DeviceSpec => d !== null)
  if (devices.length === 0) {
    return res.status(400).json({ error: 'Pick at least one device to capture.' })
  }
  // Two devices with the same id would write to the same PNG, so the second one
  // would silently show the first one's screenshot. Suffix the duplicates.
  const seen = new Map<string, number>()
  for (const d of devices) {
    const n = seen.get(d.id) ?? 0
    seen.set(d.id, n + 1)
    if (n) d.id = `${d.id}-${n + 1}`
  }

  try {
    const job = await startResponsiveJob(project.id, {
      url: target.url,
      devices,
      fullPage: req.body?.fullPage !== false,
      useProfile: Boolean(req.body?.useProfile),
      waitMs: Number(req.body?.waitMs) || 0,
    })
    res.json(job)
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'could not start capture' })
  }
})

/** GET /api/responsive/jobs?projectId — this project's sweeps, newest first. */
responsiveRouter.get('/jobs', (req, res) => {
  const project = resolveProject(req)
  if (!project) return res.status(400).json({ error: 'project not found' })
  res.json(listResponsiveJobs(project.id))
})

/** GET /api/responsive/jobs/:id — one sweep's log + result. */
responsiveRouter.get('/jobs/:id', (req, res) => {
  const job = getResponsiveJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(job)
})

responsiveRouter.post('/jobs/:id/cancel', (req, res) => {
  const job = cancelResponsiveJob(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(job)
})

responsiveRouter.delete('/jobs/:id', (req, res) => {
  res.json({ deleted: deleteResponsiveJob(req.params.id) })
})

/**
 * GET /api/responsive/jobs/:id/shot/:file — one device's screenshot.
 *
 * Path-guarded against the job's own folder the same way `files.ts` guards a run's
 * evidence: the id is a UUID we generated and the file name is rebuilt from the
 * device id, but this route takes both from the URL, so containment is checked
 * rather than assumed.
 */
responsiveRouter.get('/jobs/:id/shot/:file', (req, res) => {
  const dir = path.resolve(responsiveRunDir(req.params.id))
  const target = path.resolve(dir, req.params.file)
  if (!target.startsWith(dir + path.sep)) {
    return res.status(400).json({ error: 'invalid path' })
  }
  if (path.extname(target) !== '.png') return res.status(400).json({ error: 'invalid file' })
  if (!fs.existsSync(target)) return res.status(404).json({ error: 'not found' })
  // Immutable: a capture is written once and the URL carries the job id, so the
  // browser can keep it for the life of the page instead of refetching a 4MB PNG
  // every time the device tabs are switched.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable')
  res.sendFile(target)
})

/**
 * THE FRAMING PROXY — `GET /api/responsive/frame/<token><path>`
 *
 * `<token>` is base64url of the target's ORIGIN and `<path>` is the target's own
 * path, so `https://app.example.com/orders?q=1` is served at
 * `/api/responsive/frame/aHR0cHM6…/orders?q=1`.
 *
 * WHY IT EXISTS. The extension this page is modelled on can put any site in a
 * frame because an extension may rewrite response headers. A web page cannot:
 * `X-Frame-Options: DENY` and `frame-ancestors 'self'` are enforced by the
 * browser, and the failure is SILENT — no error, no status, just a blank
 * rectangle. Since the portal owns a server, the server can be the one that
 * fetches the page, and a header stripped before the HTML reaches the browser was
 * never enforced.
 *
 * WHY THE PATH CARRIES THE TARGET, rather than a `?url=` query. This was measured,
 * and it is the difference between "the page appears" and "the page is blank":
 *
 *   • Subresources have to come through the proxy too, or a `<script
 *     type="module">` is a CROSS-ORIGIN module fetch — which the browser makes in
 *     CORS mode, so a target that sends no `Access-Control-Allow-Origin` (i.e.
 *     almost every app) has its entry module blocked and renders NOTHING. A
 *     `<base href>` alone does not save it: base fixes where the URL points, not
 *     the CORS rule that applies to it. Reproduced with a module-script test app.
 *   • Once subresources are proxied, their OWN relative imports have to resolve.
 *     From `…/frame?url=/src/main.js`, `./App.js` resolves to
 *     `/api/responsive/App.js` — nonsense. From `…/frame/<token>/src/main.js` it
 *     resolves to `…/frame/<token>/src/App.js`, which maps straight back to the
 *     target. That is the whole reason for the shape.
 *
 * WHAT IS STILL NOT A BROWSER. Stated here and in the UI, because a proxy that
 * quietly half-works is worse than one whose limits are known:
 *
 *   • It sends no cookies. The browser cannot hand another origin's cookies to
 *     the portal, so a page behind a login renders as its login screen. The
 *     capture dialog is the answer there — it drives a real browser that can be
 *     signed in.
 *   • An absolute-path import INSIDE module code (`import '/node_modules/.vite/
 *     deps/react.js'`, which is how a Vite dev server wires its pre-bundles) is
 *     not rewritten — nothing here parses JavaScript — so it resolves to the
 *     portal's own root and 404s. A production build, whose chunks import each
 *     other relatively, is fine.
 *   • A dev server on localhost sends no framing header at all, so it needs none
 *     of this: the honest advice for `http://localhost:5173` is to leave the proxy
 *     OFF, and the page says so when the probe reports the URL is framable.
 *
 * Nothing here is a security boundary being lowered: the response goes to the same
 * localhost page that could already `fetch` this URL itself, the router sits behind
 * the remote-access gate like every other one, and `parseTarget` allows only
 * http/https — `file:` would read the disk and `data:`/`javascript:` would let a URL
 * carry its own payload into the frame.
 */

const FRAME_BASE = '/api/responsive/frame'

/** `https://x.dev` → a base64url token that survives being a path segment. */
function encodeOrigin(origin: string): string {
  return Buffer.from(origin, 'utf8').toString('base64url')
}

function decodeOrigin(token: string): string | null {
  try {
    const origin = Buffer.from(token, 'base64url').toString('utf8')
    const parsed = new URL(origin)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    // An origin only — a token carrying a path would let one frame's rewrites
    // point at another path prefix.
    return parsed.origin
  } catch {
    return null
  }
}

/**
 * Rewrite one URL found in the HTML so it comes back through the proxy.
 *
 * Only URLs that land on the TARGET's own origin are rewritten; a third-party CDN
 * is left as an absolute URL, which is what it already was and what CORS is
 * already configured for on that CDN. Anything that isn't a fetchable location
 * (`#anchor`, `mailto:`, `data:`, `javascript:`) is returned untouched.
 */
function proxyUrl(raw: string, origin: string, docUrl: string, token: string): string {
  const value = raw.trim()
  if (!value || /^(#|mailto:|tel:|data:|javascript:|blob:|about:)/i.test(value)) return raw
  try {
    const abs = new URL(value, docUrl)
    if (abs.origin !== origin) return abs.href
    return `${FRAME_BASE}/${token}${abs.pathname}${abs.search}${abs.hash}`
  } catch {
    return raw
  }
}

/** The `srcset` form: `a.png 1x, b.png 2x` — each candidate rewritten in place. */
function proxySrcset(raw: string, origin: string, docUrl: string, token: string): string {
  return raw
    .split(',')
    .map((part) => {
      const trimmed = part.trim()
      if (!trimmed) return part
      const [url, ...rest] = trimmed.split(/\s+/)
      return [proxyUrl(url, origin, docUrl, token), ...rest].join(' ')
    })
    .join(', ')
}

/**
 * The script injected at the very top of `<head>`.
 *
 * Two jobs, both of which the HTML rewrite above cannot do:
 *
 *   1. `history.replaceState` to the target's own path. A single-page app routes
 *      on `location.pathname`, and without this every proxied SPA reads the
 *      PROXY's path, matches no route, and renders a blank page — which is exactly
 *      what "Via portal doesn't load" looked like.
 *   2. Patch `fetch` and `XMLHttpRequest` so the app's own calls go back through
 *      the proxy. After step 1 the document sits on the portal's origin, so an
 *      app calling `/api/orders` would otherwise hit the PORTAL's API and get a
 *      404 from the wrong server. Resolution is against the TARGET base, so a
 *      relative URL means what the app meant by it.
 *
 * It is a classic (non-module) inline script so it runs before the deferred module
 * scripts it needs to be in place for.
 */
function bootstrapScript(origin: string, token: string, path: string): string {
  const cfg = JSON.stringify({ origin, token, path, base: FRAME_BASE })
  return `<script>(function(){
  var C = ${cfg};
  var PREFIX = C.base + '/' + C.token;
  var DOCBASE = C.origin + C.path;
  try { history.replaceState(null, '', C.path) } catch (e) {}
  function map(u) {
    try {
      if (typeof u !== 'string' || !u) return u;
      if (u.indexOf(PREFIX) === 0) return u;
      if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(u)) return u;
      var abs = new URL(u, DOCBASE);
      if (abs.origin !== C.origin) return abs.href;
      return PREFIX + abs.pathname + abs.search + abs.hash;
    } catch (e) { return u }
  }
  var _fetch = window.fetch;
  if (_fetch) window.fetch = function (input, init) {
    try {
      if (typeof input === 'string') return _fetch(map(input), init);
      if (input && input.url) return _fetch(new Request(map(input.url), input), init);
    } catch (e) {}
    return _fetch(input, init);
  };
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { arguments[1] = map(u) } catch (e) {}
    return _open.apply(this, arguments);
  };
})()</script>`
}

/** Rewrite a proxied HTML document so every URL in it comes back through here. */
function rewriteHtml(html: string, origin: string, docUrl: string, token: string): string {
  const path = (() => {
    try {
      const u = new URL(docUrl)
      return `${u.pathname}${u.search}`
    } catch {
      return '/'
    }
  })()

  let out = html
  // A <base> of the target's would defeat the rewrite by sending everything
  // straight back to the origin (and its module scripts back into CORS).
  out = out.replace(/<base\b[^>]*>/gi, '')
  // Stripping the HEADER is not enough when the same policy is repeated in the
  // document: a `frame-ancestors` in a meta tag is ignored by browsers, but a
  // `script-src` there is not, and it would block the injected bootstrap.
  out = out.replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')

  // src / href / action / poster / formaction — the attributes that fetch or
  // navigate. Quoted values only: an unquoted URL attribute is rare enough that
  // guessing where it ends would do more damage than leaving it alone.
  out = out.replace(
    /\b(src|href|action|poster|formaction)\s*=\s*("|')(.*?)\2/gi,
    (_m, attr: string, q: string, value: string) =>
      `${attr}=${q}${proxyUrl(value, origin, docUrl, token)}${q}`,
  )
  out = out.replace(
    /\b(srcset|imagesrcset)\s*=\s*("|')(.*?)\2/gi,
    (_m, attr: string, q: string, value: string) =>
      `${attr}=${q}${proxySrcset(value, origin, docUrl, token)}${q}`,
  )

  const boot = bootstrapScript(origin, token, path)
  return /<head[^>]*>/i.test(out)
    ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${boot}`)
    : `${boot}\n${out}`
}

/**
 * `GET /api/responsive/frame?url=` — the entry point the client builds, kept as a
 * redirect to the path form so there is one implementation of the proxy itself and
 * an old link (or a hand-typed one) still lands in the right place.
 */
responsiveRouter.get('/frame', (req, res) => {
  const target = parseTarget(req.query.url)
  if ('error' in target) return res.status(400).type('text/plain').send(target.error)
  const u = new URL(target.url)
  res.redirect(
    302,
    `${FRAME_BASE}/${encodeOrigin(u.origin)}${u.pathname}${u.search}${u.hash}`,
  )
})

/**
 * The proxy proper: everything under `/frame/<token>/…` is the target's.
 *
 * Two patterns because this is Express 4: `/frame/:token/*` does not match the
 * token on its own, and `https://target/` — no path at all — is the commonest URL
 * anyone types into the box.
 */
const framePatterns = ['/frame/:token', '/frame/:token/*']
responsiveRouter.get(framePatterns, async (req, res) => {
  const origin = decodeOrigin(req.params.token)
  if (!origin) return res.status(400).type('text/plain').send('Invalid frame token.')

  // Express hands the wildcard back as segments; the raw URL keeps the encoding a
  // path may depend on, so the target is rebuilt from it rather than from params.
  const raw = req.originalUrl.slice(`${FRAME_BASE}/${req.params.token}`.length) || '/'
  const targetUrl = `${origin}${raw.startsWith('/') ? '' : '/'}${raw}`

  try {
    const upstream = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': String(req.headers['user-agent'] ?? ''),
        accept: String(req.headers.accept ?? '*/*'),
        'accept-language': String(req.headers['accept-language'] ?? 'en'),
        // Passed through so a dev server answers a module request with the right
        // content type, and so an API call the app makes is treated as one.
        ...(req.headers['sec-fetch-dest']
          ? { 'sec-fetch-dest': String(req.headers['sec-fetch-dest']) }
          : {}),
      },
      signal: AbortSignal.timeout(20_000),
    })

    const type = upstream.headers.get('content-type') ?? 'text/html'
    res.status(upstream.status)
    res.setHeader('Content-Type', type)
    // Never cached: the point is to see the page as it is right now, usually a dev
    // server that just rebuilt.
    res.setHeader('Cache-Control', 'no-store')

    if (!type.includes('html')) {
      // Anything that is not a document is passed through as BYTES — a module,
      // a stylesheet, an image, the JSON of an API call the app made. Buffering it
      // as text would corrupt every binary one of them.
      const buf = Buffer.from(await upstream.arrayBuffer())
      return res.end(buf)
    }

    const html = rewriteHtml(await upstream.text(), origin, upstream.url || targetUrl, req.params.token)
    res.setHeader('Content-Length', Buffer.byteLength(html))
    return res.end(html)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return res
      .status(502)
      .type('text/html')
      .send(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:24px;color:#334155">` +
          `<strong>Could not load ${escapeHtml(targetUrl)}</strong><p>${escapeHtml(
            /timeout|abort/i.test(message) ? 'The server did not answer within 20s.' : message,
          )}</p></body>`,
      )
  }
})

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
