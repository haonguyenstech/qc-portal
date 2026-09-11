import fs from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext } from 'playwright-core'
import { DB_PATH } from './config.js'
import { agentProfileDir } from './browserProfile.js'
import { loadChromium } from './pageAudit.js'

/**
 * RESPONSIVE CAPTURE — the server half of `/responsive`.
 *
 * The page has two halves and they answer different questions:
 *
 *   • the LIVE side (browser-only, `web/src/pages/ResponsivePage.tsx`) puts the URL
 *     in N iframes at real device viewports so the engineer can scroll and click —
 *     the Chrome-extension experience, instant, no server work.
 *   • this side loads the URL in a REAL emulated device (viewport + device pixel
 *     ratio + mobile user agent + touch) and comes back with a screenshot and a
 *     list of what is actually broken at that size.
 *
 * The second one exists because the first cannot be trusted as evidence, for three
 * measured reasons:
 *
 *   1. An iframe is not a phone. It has the desktop user agent, `deviceScaleFactor`
 *      1, no touch, and — the one that silently ruins a verdict — no effect on
 *      `window.matchMedia('(hover: hover)')` or on the `dvh` unit. An app that
 *      serves a different layout to a mobile UA renders its DESKTOP layout in the
 *      iframe, and the frame looks fine while the phone is broken.
 *   2. A cross-origin iframe cannot be screenshotted from the page. html2canvas
 *      reads the DOM, and the DOM of another origin is not readable — so a
 *      "screenshot" button on the live side could only ever photograph an empty
 *      rectangle. Evidence has to be taken by something that owns the browser.
 *   3. Most deployed apps refuse to be framed at all (`X-Frame-Options`,
 *      `frame-ancestors`). The live side reports that honestly rather than showing
 *      a blank frame (see `probeUrl`), and this side is the answer for those apps:
 *      a headless browser is not bound by a framing header.
 *
 * Findings are computed IN THE PAGE (`AUDIT_SCRIPT`) rather than from the
 * screenshot: "the body scrolls 74px wider than the viewport, because
 * `table.invoice-lines` is 448px wide" is a bug report someone can fix, and a
 * picture of a horizontal scrollbar is not.
 */

// ------------------------------------------------------------------ types

/**
 * One device to capture. The catalog lives in the WEB bundle
 * (`web/src/lib/responsiveDevices.ts`) and the client sends the chosen entries
 * here, so there is exactly one list of devices in the repo and the label under a
 * screenshot is the label that was clicked.
 *
 * The user agent is deliberately NOT part of it: a UA string names a browser
 * version, and the browser is the one on THIS machine, not the one the bundle was
 * built against. `userAgentFor` derives it server-side from `platform`.
 */
export interface DeviceSpec {
  /** Stable id — also the screenshot filename, so it must stay filename-safe. */
  id: string
  label: string
  width: number
  height: number
  /** Device pixel ratio. 3 on a modern phone, 1 on a plain desktop. */
  dpr: number
  platform: 'ios' | 'android' | 'desktop'
}

export type FindingSeverity = 'high' | 'medium' | 'low'

/** One offending element, named the way a developer can find it again. */
export interface FindingSample {
  /** A best-effort CSS-ish path — `div.invoice > table.lines`. */
  selector: string
  /** First ~80 chars of its text, so the element is recognisable on screen. */
  text: string
  /** Rounded on-screen box, CSS pixels. */
  rect: { x: number; y: number; width: number; height: number }
}

export interface ResponsiveFinding {
  kind:
    | 'no-viewport-meta'
    | 'zoom-disabled'
    | 'horizontal-overflow'
    | 'wide-element'
    | 'small-tap-target'
    | 'tiny-text'
    | 'clipped-text'
    | 'fixed-overlay'
    | 'oversized-image'
  severity: FindingSeverity
  /** One line, already written for a QC engineer — the row title in the table. */
  title: string
  /** The measurement behind it. Never a suggestion; always a number. */
  detail: string
  /** How many elements matched (may exceed `samples.length`). */
  count: number
  samples: FindingSample[]
}

/** What one device came back with. */
export interface DeviceCapture {
  device: DeviceSpec
  /** Screenshot file name inside the job's folder, or null when it failed. */
  screenshot: string | null
  /** Full-page height of that screenshot in CSS px (the scrollable document). */
  documentHeight: number
  /** How wide the document actually scrolls. > width means a horizontal scrollbar. */
  scrollWidth: number
  title: string
  finalUrl: string
  /** The `<meta name="viewport">` content attribute, or null when there is none. */
  viewportMeta: string | null
  findings: ResponsiveFinding[]
  /** Uncaught JS errors seen while loading, deduped. */
  jsErrors: string[]
  loadMs: number
  /** Set when this device could not be captured at all; `findings` is then empty. */
  error: string | null
}

export interface ResponsiveCaptureResult {
  url: string
  /** True when every device was redirected away from `url` (a login wall). */
  redirected: boolean
  finalUrl: string
  capturedAt: string
  captures: DeviceCapture[]
}

export interface ResponsiveCaptureOptions {
  url: string
  devices: DeviceSpec[]
  /** Capture the whole scrollable page, not just the first screen. */
  fullPage: boolean
  /** Reuse the logged-in QC profile so an authenticated page can be captured. */
  useProfile: boolean
  /** Extra settle time after load, for content that arrives late. 0–15000ms. */
  waitMs: number
  /** Where the .png files go — one folder per job, beside the DB. */
  outDir: string
  onLog: (level: 'info' | 'success' | 'error', text: string) => void
  signal?: AbortSignal
}

export const MAX_DEVICES = 12
const MAX_SAMPLES = 6
const NAV_TIMEOUT_MS = 45_000

// ------------------------------------------------------------------ storage

/**
 * Screenshots live BESIDE THE DB (`data/responsive-runs/<jobId>/`), never inside a
 * managed project. A responsive sweep is portal output about an arbitrary URL — it
 * is not the project's QC evidence, and writing megabytes of PNG into a checkout
 * would put them in front of `git status` on someone else's branch. Same rule the
 * k6 runs already follow (`k6.ts` `perfRunsRoot`).
 */
export function responsiveRunsRoot(): string {
  return path.join(path.dirname(DB_PATH), 'responsive-runs')
}

export function responsiveRunDir(jobId: string): string {
  return path.join(responsiveRunsRoot(), jobId.replace(/[^\w.-]/g, ''))
}

/** Drop one job's screenshots. Called when its job is deleted or pruned. */
export function removeResponsiveRunDir(jobId: string): void {
  try {
    fs.rmSync(responsiveRunDir(jobId), { recursive: true, force: true })
  } catch {
    /* already gone — nothing to do */
  }
}

// ------------------------------------------------------------------ user agents

/**
 * The user agent a device should send.
 *
 * Built from the Chrome that is actually installed rather than hardcoded, because
 * the whole point of the UA here is to be believed: a site that gates its mobile
 * layout on `Mobile Safari` gets one, and a site that sniffs the Chrome major
 * version gets the real one. `chromeVersion` is filled in from the launched
 * browser; before that it falls back to a recent version, which is only ever wrong
 * by a number no layout depends on.
 */
function userAgentFor(platform: DeviceSpec['platform'], chromeVersion: string): string {
  if (platform === 'ios') {
    // iOS Safari. Every browser on iOS is WebKit, so this is what a real iPhone
    // sends — and it is what `@media (-webkit-touch-callout)` style sniffing wants.
    return 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
  }
  if (platform === 'android') {
    return `Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Mobile Safari/537.36`
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

/** Clamp one client-sent device spec into something safe to hand a browser. */
export function sanitizeDevice(raw: unknown, index: number): DeviceSpec | null {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const width = Math.round(Number(obj.width))
  const height = Math.round(Number(obj.height))
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null
  if (width < 240 || width > 3840 || height < 320 || height > 4320) return null
  const platform =
    obj.platform === 'ios' || obj.platform === 'android' || obj.platform === 'desktop'
      ? obj.platform
      : 'desktop'
  const label = String(obj.label ?? '').trim().slice(0, 60) || `${width}×${height}`
  // The id becomes a filename, so it is rebuilt here rather than trusted — a
  // client-supplied `../../id` would otherwise choose where the PNG lands.
  const safeId =
    String(obj.id ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || `device-${index + 1}`
  return {
    id: safeId,
    label,
    width,
    height,
    // 1–4: a DPR above 4 buys nothing and multiplies the screenshot's pixel count
    // by its square, which is how a 12-device sweep runs the machine out of memory.
    dpr: Math.min(4, Math.max(1, Number(obj.dpr) || 1)),
    platform,
  }
}

// ------------------------------------------------------------------ the in-page audit

/**
 * Runs inside the page, once, after it has settled. Returns the findings plus the
 * few document facts the report needs.
 *
 * It is a STRING, not a function passed to `page.evaluate`, for the same reason
 * `pageAudit.ts`'s init script is: the server workspace compiles with
 * `types: ["node"]` and has no DOM lib, so DOM code here would not typecheck. The
 * shape it returns is asserted once, at the single call site below.
 *
 * Thresholds are the accessibility/mobile-web ones, not invented:
 *   • 44×44 CSS px is Apple's minimum touch target; 24×24 is WCAG 2.2 AA (2.5.8).
 *     A touch device is judged at 44, a desktop viewport is not judged at all.
 *   • 12px is the floor below which body text stops being readable on a phone
 *     without zoom (iOS itself refuses to render form text below 16px without
 *     zooming the page, which is why 16px is called out separately for inputs).
 * Everything is measured against the LAYOUT viewport, so a 1px sub-pixel rounding
 * artefact never reads as an overflow (hence the 2px slack).
 */
const AUDIT_SCRIPT = String.raw`
(() => {
  const SLACK = 2
  const vw = window.innerWidth
  const vh = window.innerHeight
  const touch = 'ontouchstart' in window || navigator.maxTouchPoints > 0
  const MAX_SAMPLES = ${MAX_SAMPLES}

  /** A short, recognisable path to an element. */
  function selectorOf(el) {
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 3; depth++) {
      let part = node.tagName.toLowerCase()
      if (node.id) {
        part += '#' + node.id
        parts.unshift(part)
        break
      }
      const cls = (node.getAttribute('class') || '')
        .split(/\s+/)
        .filter((c) => c && !/^(ng|css|jsx)-|[0-9a-f]{6,}/i.test(c))
        .slice(0, 2)
      if (cls.length) part += '.' + cls.join('.')
      parts.unshift(part)
      node = node.parentElement
    }
    return parts.join(' > ')
  }

  function textOf(el) {
    const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '')
      .replace(/\s+/g, ' ')
      .trim()
    return t.slice(0, 80)
  }

  function sampleOf(el, rect) {
    const r = rect || el.getBoundingClientRect()
    return {
      selector: selectorOf(el),
      text: textOf(el),
      rect: {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
    }
  }

  /** Skip anything the user cannot see — a hidden mobile menu is not a finding. */
  function visible(el, style, rect) {
    if (!rect.width || !rect.height) return false
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) === 0) return false
    return true
  }

  const findings = []
  function add(kind, severity, title, detail, count, samples) {
    if (!count) return
    findings.push({ kind, severity, title, detail, count, samples: samples.slice(0, MAX_SAMPLES) })
  }

  // ---- viewport meta ---------------------------------------------------
  const metaEl = document.querySelector('meta[name="viewport"]')
  const viewportMeta = metaEl ? metaEl.getAttribute('content') : null

  // ---- horizontal overflow --------------------------------------------
  const docEl = document.documentElement
  const scrollWidth = Math.max(docEl.scrollWidth, document.body ? document.body.scrollWidth : 0)
  const documentHeight = Math.max(docEl.scrollHeight, document.body ? document.body.scrollHeight : 0)

  // Every element whose box extends past the right edge of the viewport. Walked
  // once and reused by both the overflow finding and the wide-element one, because
  // a full DOM walk is the expensive part of this script.
  const wide = []
  const tiny = []
  const smallTargets = []
  const clipped = []
  const overlays = []
  const heavyImages = []

  const all = document.body ? document.body.querySelectorAll('*') : []
  for (const el of all) {
    let style
    try {
      style = window.getComputedStyle(el)
    } catch (_) {
      continue
    }
    const rect = el.getBoundingClientRect()
    if (!visible(el, style, rect)) continue

    const right = rect.left + window.scrollX + rect.width
    // Only the element itself, not its scrolling ancestor: a carousel that scrolls
    // sideways ON PURPOSE has overflow-x set, and reporting its children would bury
    // the real finding under fifty rows.
    const scrollsOnPurpose =
      style.overflowX === 'auto' || style.overflowX === 'scroll'
    if (!scrollsOnPurpose && rect.width > vw + SLACK && rect.width > 40) {
      wide.push(sampleOf(el, rect))
    }

    // Text too small to read on a phone.
    const fontSize = parseFloat(style.fontSize) || 0
    const ownText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent && n.textContent.trim().length > 2,
    )
    if (touch && ownText && fontSize > 0 && fontSize < 12) {
      tiny.push(sampleOf(el, rect))
    }

    // Tap targets. Only on a touch viewport, and only for things that are actually
    // clickable — a 12px icon inside a 48px button is fine, so an element whose
    // clickable ANCESTOR is big enough is skipped by measuring the ancestor.
    if (touch) {
      const tag = el.tagName.toLowerCase()
      const role = (el.getAttribute('role') || '').toLowerCase()
      const interactive =
        tag === 'a' || tag === 'button' || tag === 'input' || tag === 'select' ||
        tag === 'textarea' || role === 'button' || role === 'link' || role === 'checkbox' ||
        el.hasAttribute('onclick')
      if (interactive && (rect.width < 44 || rect.height < 44)) {
        // Ignore an inline link inside a paragraph: WCAG 2.5.8 exempts text links
        // in a block of prose, and flagging them makes every article page fail.
        const inProse = tag === 'a' && style.display === 'inline'
        if (!inProse) smallTargets.push(sampleOf(el, rect))
      }
      // A text input under 16px makes iOS Safari zoom the page on focus, which is
      // the "the page jumps when I tap the field" bug, reported as a layout bug.
      if ((tag === 'input' || tag === 'textarea' || tag === 'select') && fontSize > 0 && fontSize < 16) {
        tiny.push(sampleOf(el, rect))
      }
    }

    // Clipped text — the box hides its own content rather than wrapping.
    if (
      ownText &&
      (style.overflow === 'hidden' || style.overflowX === 'hidden') &&
      el.scrollWidth > el.clientWidth + SLACK &&
      style.textOverflow !== 'ellipsis'
    ) {
      clipped.push(sampleOf(el, rect))
    }

    // A fixed bar that eats the screen. On a 640px-tall phone a 240px cookie
    // banner is a third of the page, and it is invisible in a desktop review.
    if ((style.position === 'fixed' || style.position === 'sticky') && rect.height > vh * 0.25 && rect.width > vw * 0.5) {
      overlays.push(sampleOf(el, rect))
    }

    // An image served far larger than it is drawn — the mobile-data finding.
    if (el.tagName.toLowerCase() === 'img' && el.naturalWidth > 0 && rect.width > 0) {
      const ratio = el.naturalWidth / (rect.width * (window.devicePixelRatio || 1))
      if (ratio >= 2 && el.naturalWidth > 800) {
        const s = sampleOf(el, rect)
        s.text = el.naturalWidth + '×' + el.naturalHeight + ' served for a ' + Math.round(rect.width) + 'px box'
        heavyImages.push(s)
      }
    }
  }

  if (!viewportMeta && (touch || vw < 900)) {
    add(
      'no-viewport-meta',
      'high',
      'No viewport meta tag — the page is not responsive at all on a phone',
      'Without <meta name="viewport" content="width=device-width, initial-scale=1"> the browser lays the page out at ~980px and scales it down, so every breakpoint in the CSS is dead.',
      1,
      [],
    )
  } else if (viewportMeta && /user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/.test(viewportMeta)) {
    add(
      'zoom-disabled',
      'low',
      'Pinch-zoom is disabled',
      'The viewport meta is "' + viewportMeta + '". Blocking zoom fails WCAG 1.4.4 and is the usual reason a user cannot read small print on a phone.',
      1,
      [],
    )
  }

  if (scrollWidth > vw + SLACK) {
    add(
      'horizontal-overflow',
      'high',
      'The page scrolls sideways',
      'The document is ' + scrollWidth + 'px wide in a ' + vw + 'px viewport — ' + (scrollWidth - vw) + 'px of horizontal scroll.',
      1,
      wide.slice(0, MAX_SAMPLES),
    )
  }
  add(
    'wide-element',
    scrollWidth > vw + SLACK ? 'medium' : 'high',
    wide.length + ' element' + (wide.length === 1 ? '' : 's') + ' wider than the screen',
    'Widest is ' + (wide.length ? Math.max.apply(null, wide.map((w) => w.rect.width)) : 0) + 'px against a ' + vw + 'px viewport.',
    wide.length,
    wide,
  )
  add(
    'small-tap-target',
    'medium',
    smallTargets.length + ' tap target' + (smallTargets.length === 1 ? '' : 's') + ' under 44×44px',
    'Apple asks for 44×44 CSS px and WCAG 2.2 AA for 24×24. Smallest here is ' +
      (smallTargets.length
        ? Math.min.apply(null, smallTargets.map((s) => Math.min(s.rect.width, s.rect.height)))
        : 0) + 'px.',
    smallTargets.length,
    smallTargets,
  )
  add(
    'tiny-text',
    'low',
    tiny.length + ' element' + (tiny.length === 1 ? '' : 's') + ' with text under 12px (or a sub-16px input)',
    'Body text under 12px is hard to read on a phone; a form field under 16px makes iOS Safari zoom the page when it is focused.',
    tiny.length,
    tiny,
  )
  add(
    'clipped-text',
    'medium',
    clipped.length + ' box' + (clipped.length === 1 ? '' : 'es') + ' cutting off its own text',
    'The content is wider than the box and overflow is hidden with no ellipsis, so the text is simply gone at this width.',
    clipped.length,
    clipped,
  )
  add(
    'fixed-overlay',
    'low',
    overlays.length + ' fixed bar' + (overlays.length === 1 ? '' : 's') + ' covering a quarter of the screen or more',
    'On a ' + vh + 'px-tall viewport these take ' +
      (overlays.length ? Math.max.apply(null, overlays.map((o) => Math.round((o.rect.height / vh) * 100))) : 0) +
      '% of the height at most.',
    overlays.length,
    overlays,
  )
  add(
    'oversized-image',
    'low',
    heavyImages.length + ' image' + (heavyImages.length === 1 ? '' : 's') + ' served much larger than displayed',
    'Each is at least twice the pixels it needs at this device pixel ratio — wasted mobile data, and the usual cause of a slow first paint on 4G.',
    heavyImages.length,
    heavyImages,
  )

  return {
    viewportMeta,
    scrollWidth,
    documentHeight,
    title: document.title || '',
    findings,
  }
})()
`

/** The shape `AUDIT_SCRIPT` returns. Asserted once, where it is evaluated. */
interface AuditPayload {
  viewportMeta: string | null
  scrollWidth: number
  documentHeight: number
  title: string
  findings: ResponsiveFinding[]
}

// ------------------------------------------------------------------ capture

/**
 * Capture `url` on every requested device, in sequence.
 *
 * Sequential on purpose: each context is a real Chrome renderer, and six of them
 * loading the same app at once compete for the same CPU — which shows up as
 * timeouts on the slowest device and reads as "that device is broken". A sweep of
 * six phones takes about as long as six page loads, which is the honest cost.
 *
 * One device failing (a timeout, a crash) is recorded on that device and the sweep
 * continues; only a browser that cannot be launched at all throws.
 */
export async function captureResponsive(
  opts: ResponsiveCaptureOptions,
): Promise<ResponsiveCaptureResult> {
  const chromium = await loadChromium()
  const devices = opts.devices.slice(0, MAX_DEVICES)
  if (devices.length === 0) throw new Error('Pick at least one device to capture.')
  const waitMs = Math.max(0, Math.min(15_000, Math.round(opts.waitMs) || 0))

  fs.mkdirSync(opts.outDir, { recursive: true })

  let browser: Browser | null = null
  let persistent: BrowserContext | null = null
  try {
    if (opts.useProfile) {
      // The logged-in profile is a persistent context, and Chrome will not open one
      // profile twice — so the emulation cannot be per-context here. Each device is
      // instead applied to a PAGE in that one context via CDP-free means: viewport
      // and DPR are settable per page, the UA is not. That trade is stated in the
      // UI ("signed-in capture keeps the desktop user agent") rather than hidden,
      // because a wrong UA changes what some apps serve.
      persistent = await chromium.launchPersistentContext(agentProfileDir(), {
        headless: true,
        channel: 'chrome',
        viewport: { width: devices[0].width, height: devices[0].height },
      })
    } else {
      browser = await chromium.launch({ headless: true, channel: 'chrome' })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      /channel|executable|not found|ENOENT/i.test(message)
        ? 'Could not start Chrome. Install Google Chrome, or run `npx playwright install chrome`.'
        : message,
    )
  }

  const chromeVersion = (browser ?? persistent?.browser())?.version()?.split('/').pop() || '140.0.0.0'
  const captures: DeviceCapture[] = []

  try {
    for (const device of devices) {
      if (opts.signal?.aborted) break
      const started = Date.now()
      opts.onLog('info', `Capturing ${device.label} — ${device.width}×${device.height} @${device.dpr}x`)

      const capture: DeviceCapture = {
        device,
        screenshot: null,
        documentHeight: 0,
        scrollWidth: 0,
        title: '',
        finalUrl: opts.url,
        viewportMeta: null,
        findings: [],
        jsErrors: [],
        loadMs: 0,
        error: null,
      }

      let context: BrowserContext | null = null
      try {
        if (browser) {
          context = await browser.newContext({
            viewport: { width: device.width, height: device.height },
            deviceScaleFactor: device.dpr,
            userAgent: userAgentFor(device.platform, chromeVersion),
            isMobile: device.platform !== 'desktop',
            hasTouch: device.platform !== 'desktop',
            // A phone is not in New York in July, but a locale/timezone mismatch
            // makes date-formatting differences look like layout differences. Left
            // at the machine's own values on purpose.
          })
        }
        const page = await (context ?? persistent!).newPage()
        if (!context) {
          // Persistent-profile path: no per-context emulation, so at least the
          // viewport and DPR follow the device.
          await page.setViewportSize({ width: device.width, height: device.height })
        }

        const errors = new Set<string>()
        page.on('pageerror', (err) => {
          if (errors.size < 20) errors.add(err.message.replace(/\s+/g, ' ').slice(0, 240))
        })

        await page.goto(opts.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
        // `networkidle` is not waited on as a gate — an app with a websocket or a
        // poll never reaches it — but a short idle wait catches the common case of
        // content that arrives one fetch after load.
        await page
          .waitForLoadState('networkidle', { timeout: 4_000 })
          .catch(() => {})
        if (waitMs) await page.waitForTimeout(waitMs)

        const payload = (await page.evaluate(AUDIT_SCRIPT)) as AuditPayload
        capture.viewportMeta = payload.viewportMeta
        capture.scrollWidth = payload.scrollWidth
        capture.documentHeight = payload.documentHeight
        capture.title = payload.title
        capture.findings = payload.findings
        capture.finalUrl = page.url()
        capture.jsErrors = [...errors]

        const file = `${device.id}.png`
        await page.screenshot({
          path: path.join(opts.outDir, file),
          fullPage: opts.fullPage,
          // A 12000px-tall full-page shot at DPR 3 is a 100MB PNG that no browser
          // will draw. Chrome clips a screenshot past ~16384 device px anyway, so
          // the cap is stated rather than discovered as a corrupt file.
          ...(opts.fullPage ? { scale: 'css' as const } : {}),
        })
        capture.screenshot = file
        capture.loadMs = Date.now() - started

        const worst = capture.findings.filter((f) => f.severity === 'high').length
        opts.onLog(
          worst ? 'error' : 'success',
          `${device.label} — ${capture.findings.length} finding${capture.findings.length === 1 ? '' : 's'}${worst ? `, ${worst} serious` : ''}`,
        )
        await page.close().catch(() => {})
      } catch (err) {
        capture.error = err instanceof Error ? err.message : String(err)
        capture.loadMs = Date.now() - started
        opts.onLog('error', `${device.label} — ${capture.error}`)
      } finally {
        if (context) await context.close().catch(() => {})
      }
      captures.push(capture)
    }
  } finally {
    if (persistent) await persistent.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }

  // A redirect is only worth shouting about when it moved off the requested page —
  // a trailing slash or a locale prefix is not a login wall.
  const finalUrls = captures.map((c) => c.finalUrl).filter(Boolean)
  const redirected =
    finalUrls.length > 0 && finalUrls.every((u) => !samePage(u, opts.url))

  return {
    url: opts.url,
    redirected,
    finalUrl: finalUrls[0] ?? opts.url,
    capturedAt: new Date().toISOString(),
    captures,
  }
}

/** Same origin and same path, ignoring a trailing slash and the query. */
function samePage(a: string, b: string): boolean {
  try {
    const ua = new URL(a)
    const ub = new URL(b)
    const norm = (p: string) => p.replace(/\/+$/, '')
    return ua.origin === ub.origin && norm(ua.pathname) === norm(ub.pathname)
  } catch {
    return a === b
  }
}

// ------------------------------------------------------------------ probe

export interface UrlProbe {
  ok: boolean
  status: number
  finalUrl: string
  /** Whether the page can be shown in the live iframe side of the page. */
  framable: boolean
  /** The header that forbids framing, verbatim, when there is one. */
  frameBlockedBy: string | null
  /** `<meta name="viewport">` content, read from the HTML without a browser. */
  viewportMeta: string | null
  /** Set when the URL could not be reached at all. */
  error: string | null
}

/**
 * Ask the URL, server-side, the two questions the live preview cannot ask itself.
 *
 * A cross-origin iframe that is refused gives the embedding page NOTHING — no
 * error event, no status, just a blank rectangle and a console message the portal
 * cannot read. So the framing verdict has to come from the headers, fetched here.
 * Without this the live side's failure mode is "the phones are white and I don't
 * know why", which is the single most confusing thing this page could do.
 */
export async function probeUrl(url: string): Promise<UrlProbe> {
  const probe: UrlProbe = {
    ok: false,
    status: 0,
    finalUrl: url,
    framable: true,
    frameBlockedBy: null,
    viewportMeta: null,
    error: null,
  }
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Ask as a browser would: some servers answer a bare fetch with a 403 that
        // says nothing about how they'd answer the iframe.
        'user-agent': userAgentFor('desktop', '140.0.0.0'),
        accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(12_000),
    })
    probe.status = res.status
    probe.ok = res.ok
    probe.finalUrl = res.url || url

    const xfo = res.headers.get('x-frame-options')
    const csp = res.headers.get('content-security-policy') ?? ''
    const ancestors = /frame-ancestors\s+([^;]+)/i.exec(csp)
    if (xfo && /deny|sameorigin/i.test(xfo)) {
      probe.framable = false
      probe.frameBlockedBy = `X-Frame-Options: ${xfo}`
    } else if (ancestors) {
      const value = ancestors[1].trim()
      // 'self' / 'none' both exclude the portal's own origin; a list might allow it,
      // but we cannot know the portal's public origin here, so it is reported as-is
      // and treated as blocking only for the two unambiguous values.
      if (/'none'|'self'/i.test(value) && !/\*/.test(value)) {
        probe.framable = false
        probe.frameBlockedBy = `Content-Security-Policy: frame-ancestors ${value}`
      }
    }

    const ct = res.headers.get('content-type') ?? ''
    if (ct.includes('html')) {
      // Only the head matters, and a 20MB SPA shell does not need to be buffered
      // to read one meta tag.
      const html = (await res.text()).slice(0, 200_000)
      const meta = /<meta[^>]+name=["']viewport["'][^>]*content=["']([^"']+)["']/i.exec(html)
      probe.viewportMeta = meta ? meta[1] : null
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    probe.error = /timeout|abort/i.test(message)
      ? 'The URL did not answer within 12s.'
      : `Could not reach the URL: ${message}`
  }
  return probe
}
