/**
 * The device catalog for `/responsive` — the one list in the repo.
 *
 * It lives in the WEB bundle even though the server needs it too, and the client
 * sends the chosen entries along with a capture request (`sanitizeDevice` clamps
 * them on arrival). The alternative — a catalog on each side — drifts, and the
 * first thing to drift is the label, so the screenshot in the report would end up
 * captioned with a different device than the one that was clicked.
 *
 * The numbers are CSS-pixel **viewport** sizes, not physical screens: a phone with
 * a 1290×2796 panel reports 430×932 to `window.innerWidth` because its device
 * pixel ratio is 3. Those are the numbers a media query is written against, so
 * they are the numbers a device picker must show. `dpr` is carried separately
 * because it is what decides whether a 2x asset is sharp — and it is one of the
 * things an iframe cannot fake (see `server/src/responsiveCapture.ts`).
 *
 * Heights are the *browser* viewport, chrome already subtracted, which is why a
 * "1080p" phone is 640px tall here. The device chrome the live preview draws is
 * therefore drawn OUTSIDE the screen rectangle and never eats into it.
 */

/** Which OS the emulated device is, for the user agent and for the drawn chrome. */
export type DevicePlatform = 'ios' | 'android' | 'desktop'

/** The chrome drawn around the live preview. Matches the four extension modes. */
export type DeviceChrome = 'none' | 'ios' | 'ios-old' | 'android'

export interface DevicePreset {
  id: string
  label: string
  /** Viewport in CSS px, in the device's NATURAL orientation (see `viewportOf`). */
  width: number
  height: number
  dpr: number
  platform: DevicePlatform
  group: 'iPhone' | 'Android' | 'Foldable' | 'Tablet' | 'Desktop'
}

/**
 * The presets, grouped the way the picker draws them.
 *
 * Two entries can share a size (iPhone 11 and XS Max are both 414x896, iPhone 5
 * and SE both 320x568) and both are kept: an engineer testing "does it work on an
 * SE" is answering a question about a device, and being told to pick a different
 * device with the same numbers is a worse answer than a duplicate row. The picker
 * has a search box precisely because the list is long — people arrive knowing the
 * device NAME, and the size is what they came to look up.
 *
 * Every number here is either the extension's own, or Chrome DevTools' device
 * list, which is the reference a developer will check the report against. Nothing
 * is estimated: a device whose viewport could not be confirmed is left out rather
 * than guessed at, because a wrong 393 in a ticket is worse than a missing row.
 * `dpr` is likewise never rounded to fit — `sanitizeDevice` clamps DPR to 4 on the
 * server, so a phone quoted at 4.5 would be captured at a ratio nobody picked, and
 * those are omitted too.
 */
export const DEVICE_PRESETS: DevicePreset[] = [
  // --- iPhone -------------------------------------------------------------
  { id: 'iphone-17-pro-max', label: 'iPhone 17 Pro Max', width: 440, height: 956, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-16-plus', label: 'iPhone 16 Plus', width: 430, height: 932, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-air', label: 'iPhone Air', width: 420, height: 912, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-16', label: 'iPhone 16', width: 393, height: 852, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro', width: 393, height: 852, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-13-pro', label: 'iPhone 13 Pro', width: 390, height: 844, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-13-mini', label: 'iPhone 13 mini', width: 375, height: 812, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', width: 390, height: 844, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-11-pro', label: 'iPhone 11 Pro / X', width: 375, height: 812, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-11', label: 'iPhone 11', width: 414, height: 896, dpr: 2, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-xs-max', label: 'iPhone XS Max', width: 414, height: 896, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-8-plus', label: 'iPhone 8 Plus', width: 414, height: 736, dpr: 3, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-se-3', label: 'iPhone SE (2022)', width: 375, height: 667, dpr: 2, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-se', label: 'iPhone SE', width: 320, height: 568, dpr: 2, platform: 'ios', group: 'iPhone' },
  { id: 'iphone-5', label: 'iPhone 5', width: 320, height: 568, dpr: 2, platform: 'ios', group: 'iPhone' },
  // --- Android ------------------------------------------------------------
  { id: 'pixel-9-pro', label: 'Pixel 9 Pro', width: 412, height: 915, dpr: 2.625, platform: 'android', group: 'Android' },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, dpr: 2.625, platform: 'android', group: 'Android' },
  { id: 'pixel-6-pro', label: 'Pixel 6 Pro', width: 412, height: 892, dpr: 3.5, platform: 'android', group: 'Android' },
  { id: 'pixel-5', label: 'Pixel 5', width: 393, height: 851, dpr: 2.75, platform: 'android', group: 'Android' },
  { id: 'pixel-4', label: 'Pixel 4', width: 353, height: 745, dpr: 3, platform: 'android', group: 'Android' },
  { id: 'pixel-3', label: 'Pixel 3', width: 393, height: 786, dpr: 2.75, platform: 'android', group: 'Android' },
  { id: 'pixel-2-xl', label: 'Pixel 2 XL', width: 412, height: 823, dpr: 3.5, platform: 'android', group: 'Android' },
  { id: 'galaxy-s24-ultra', label: 'Galaxy S24 Ultra', width: 412, height: 891, dpr: 3.5, platform: 'android', group: 'Android' },
  { id: 'galaxy-s23', label: 'Galaxy S23', width: 360, height: 780, dpr: 3, platform: 'android', group: 'Android' },
  { id: 'galaxy-s22-ultra', label: 'Galaxy S22 Ultra', width: 412, height: 883, dpr: 3.5, platform: 'android', group: 'Android' },
  { id: 'galaxy-s20-ultra', label: 'Galaxy S20 Ultra', width: 412, height: 915, dpr: 3.5, platform: 'android', group: 'Android' },
  { id: 'galaxy-a51', label: 'Galaxy A51 / A71', width: 412, height: 914, dpr: 2.625, platform: 'android', group: 'Android' },
  { id: 'galaxy-s8', label: 'Galaxy S8', width: 360, height: 740, dpr: 4, platform: 'android', group: 'Android' },
  { id: 'galaxy-note-5', label: 'Galaxy Note 5', width: 360, height: 640, dpr: 4, platform: 'android', group: 'Android' },
  { id: 'xiaomi-mi-11i', label: 'Xiaomi Mi 11i', width: 393, height: 873, dpr: 2.75, platform: 'android', group: 'Android' },
  { id: 'moto-g-power', label: 'Moto G Power', width: 412, height: 823, dpr: 1.75, platform: 'android', group: 'Android' },
  { id: 'nexus-5x', label: 'Nexus 5X', width: 412, height: 732, dpr: 2.625, platform: 'android', group: 'Android' },
  // --- Foldables ----------------------------------------------------------
  //
  // Their own group because they are the one class of device with TWO viewports,
  // and a sweep that only sees one of them proves nothing: the cover screen is
  // narrower than any phone in the list above and the open screen is a tablet.
  // Both are listed as separate rows so a sweep can hold the pair side by side —
  // which is the whole question a foldable asks of a layout.
  { id: 'galaxy-z-fold-5', label: 'Z Fold 5 (cover)', width: 344, height: 882, dpr: 3.5, platform: 'android', group: 'Foldable' },
  { id: 'galaxy-z-flip-3', label: 'Galaxy Z Flip 3', width: 360, height: 880, dpr: 3, platform: 'android', group: 'Foldable' },
  { id: 'surface-duo', label: 'Surface Duo', width: 540, height: 720, dpr: 2.5, platform: 'android', group: 'Foldable' },
  { id: 'zenbook-fold', label: 'Zenbook Fold (open)', width: 853, height: 1280, dpr: 2, platform: 'android', group: 'Foldable' },
  // --- Tablets (stored landscape, as the sizes are quoted) ----------------
  { id: 'ipad-mini', label: 'iPad mini', width: 1024, height: 768, dpr: 2, platform: 'ios', group: 'Tablet' },
  { id: 'ipad-10', label: 'iPad (10th gen)', width: 1080, height: 810, dpr: 2, platform: 'ios', group: 'Tablet' },
  { id: 'ipad-air', label: 'iPad Air', width: 1180, height: 820, dpr: 2, platform: 'ios', group: 'Tablet' },
  { id: 'ipad-pro-11', label: 'iPad Pro 11"', width: 1194, height: 834, dpr: 2, platform: 'ios', group: 'Tablet' },
  { id: 'ipad-pro-13', label: 'iPad Pro 12.9"', width: 1366, height: 1024, dpr: 2, platform: 'ios', group: 'Tablet' },
  { id: 'galaxy-tab-s7', label: 'Galaxy Tab S7', width: 1280, height: 800, dpr: 2, platform: 'android', group: 'Tablet' },
  { id: 'nexus-7', label: 'Nexus 7', width: 960, height: 600, dpr: 2, platform: 'android', group: 'Tablet' },
  { id: 'surface-pro-7', label: 'Surface Pro 7', width: 1368, height: 912, dpr: 2, platform: 'desktop', group: 'Tablet' },
  // --- Desktop ------------------------------------------------------------
  //
  // Not in the extension, and the reason to add them is the QC job rather than the
  // simulation: "responsive" fails at the DESKTOP breakpoints at least as often —
  // a 1280px laptop hitting a layout only ever opened on a 1920px monitor — and a
  // sweep that stops at the tablet cannot see it. 1366x768 and 1536x864 are the
  // two most common real-world desktop viewports in analytics, and both are SHORT:
  // a hero section sized in `vh` is cut off there and nowhere else.
  { id: 'laptop-1280', label: 'Laptop 1280', width: 1280, height: 800, dpr: 2, platform: 'desktop', group: 'Desktop' },
  { id: 'laptop-1366', label: 'Laptop 1366', width: 1366, height: 768, dpr: 1, platform: 'desktop', group: 'Desktop' },
  { id: 'laptop-1440', label: 'Laptop 1440', width: 1440, height: 900, dpr: 2, platform: 'desktop', group: 'Desktop' },
  { id: 'laptop-1536', label: 'Laptop 1536', width: 1536, height: 864, dpr: 1, platform: 'desktop', group: 'Desktop' },
  { id: 'macbook-pro-16', label: 'MacBook Pro 16"', width: 1728, height: 1117, dpr: 2, platform: 'desktop', group: 'Desktop' },
  { id: 'desktop-1920', label: 'Desktop 1920', width: 1920, height: 1080, dpr: 1, platform: 'desktop', group: 'Desktop' },
  { id: 'desktop-2560', label: 'Desktop 2560', width: 2560, height: 1440, dpr: 1, platform: 'desktop', group: 'Desktop' },
]

export const DEVICE_GROUPS: DevicePreset['group'][] = [
  'iPhone',
  'Android',
  'Foldable',
  'Tablet',
  'Desktop',
]

/**
 * Free-text device search for the picker.
 *
 * It matches the SIZE as well as the name ("412", "412x915", "@3") because half
 * the reason to open this list is the opposite lookup — an engineer has a bug
 * report that says 360px and wants to know which phones are that wide. `x` and
 * the real multiplication sign are both accepted; nobody types U+00D7.
 */
export function matchesDevice(device: DevicePreset, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/\u00d7/g, 'x')
  if (!q) return true
  const hay = `${device.label} ${device.group} ${device.platform} ${device.width}x${device.height} @${device.dpr}x`.toLowerCase()
  return q.split(/\s+/).every((term) => hay.includes(term))
}

export function presetById(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((d) => d.id === id)
}

/** What the picker opens with — one phone, the same default the extension ships. */
export const DEFAULT_DEVICE_IDS = ['iphone-13-pro']

/**
 * How many devices may be on screen (or in one sweep) at once.
 *
 * The live cap is a real limit rather than a tidy one: each frame is a live
 * iframe running the target's JavaScript, so eight of them is eight copies of the
 * app in one tab — and the mirroring loop touches every one of them on every
 * event. Past that the frames start dropping input rather than rendering small.
 * The capture cap is higher because a sweep is SEQUENTIAL on the server and the
 * only thing it spends is time.
 */
export const MAX_LIVE_DEVICES = 8
export const MAX_CAPTURE_DEVICES = 24

// ------------------------------------------------------------------ orientation

export type Orientation = 'portrait' | 'landscape'

/**
 * The viewport a preset has in one orientation.
 *
 * `portrait` is the preset AS AUTHORED and `landscape` is that rotated, rather
 * than "portrait = the taller of the two". The distinction matters because the
 * catalog is not all phones: a tablet is quoted landscape (iPad mini 1024×768)
 * and a laptop only exists landscape, so forcing the tall side to be portrait
 * rendered `Laptop 1280` as an 800×1280 window — a viewport no laptop has, and
 * one that fires the tablet breakpoints. The rule now matches what the picker
 * card says: click 1280×800 and you get 1280×800.
 *
 * Rotating swaps the two numbers and nothing else — a real rotation also changes
 * how much chrome the browser shows (Safari shrinks its bars in landscape), which
 * is a difference of a few pixels this deliberately does not model: a fake number
 * is worse than a round one, because a report would quote it.
 */
export function viewportOf(
  device: Pick<DevicePreset, 'width' | 'height'>,
  orientation: Orientation,
): { width: number; height: number } {
  return orientation === 'portrait'
    ? { width: device.width, height: device.height }
    : { width: device.height, height: device.width }
}

// ------------------------------------------------------------------ custom size

/**
 * The custom-size panel: a free width/height, the chrome style to draw around it,
 * and the bezel colour — the extension's "Custom size" popover, which is the one
 * control that answers "what happens at exactly 768px?".
 *
 * `diagonal` is cosmetic. It scales the drawn bezel so a 6.1" frame looks like a
 * phone and a 12.9" one like a tablet; it changes no viewport number, and the UI
 * says so rather than implying the page is being rendered at a physical size.
 */
export interface CustomDevice {
  enabled: boolean
  width: number
  height: number
  diagonalIn: number
  chrome: DeviceChrome
  color: BezelColor
}

export const BEZEL_COLORS = ['black', 'silver', 'blue', 'gold', 'copper'] as const
export type BezelColor = (typeof BEZEL_COLORS)[number]

/** The bezel fill for each colour — deliberately flat, matching the design language. */
export const BEZEL_FILL: Record<BezelColor, string> = {
  black: '#111318',
  silver: '#c3c8d0',
  blue: '#2b4a72',
  gold: '#c9a44c',
  copper: '#b5643c',
}

export const DEFAULT_CUSTOM: CustomDevice = {
  enabled: false,
  width: 390,
  height: 844,
  diagonalIn: 6.1,
  chrome: 'ios',
  color: 'black',
}

/** The custom panel's numbers as a device the rest of the page can treat normally. */
export function customPreset(custom: CustomDevice): DevicePreset {
  return {
    id: 'custom',
    label: `Custom ${custom.width}×${custom.height}`,
    width: custom.width,
    height: custom.height,
    // A custom size is a size, not a screen, so its DPR is 2 — the value that
    // makes a 2x asset behave like it does on almost every device in the list.
    dpr: 2,
    platform: custom.chrome === 'android' ? 'android' : custom.chrome === 'none' ? 'desktop' : 'ios',
    group: 'iPhone',
  }
}

/** The chrome to draw for a preset, when the engineer hasn't overridden it. */
export function chromeFor(device: DevicePreset): DeviceChrome {
  if (device.platform === 'desktop') return 'none'
  if (device.platform === 'android') return 'android'
  // An iPhone 5 / SE has a home button and the old, taller Safari chrome.
  return device.id === 'iphone-5' || device.id === 'iphone-se' ? 'ios-old' : 'ios'
}

// ------------------------------------------------------------------ zoom

/** The extension's range, and the reason it stops at 125%: past that the frame
 *  no longer fits a laptop screen next to a second one. */
export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 1.25
export const ZOOM_STEP = 0.05

export function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100))
}

// ------------------------------------------------------------------ persistence

/**
 * The whole toolbar state, remembered per machine.
 *
 * A responsive review is not one sitting: the engineer picks four phones, finds a
 * bug, files it, reloads the portal, and has to pick the same four phones again.
 * Same class of preference as the theme and the collapsed rail, so localStorage —
 * it never reaches the server, and a corrupt value falls back to the defaults
 * rather than blanking the page.
 */
export interface ResponsivePrefs {
  url: string
  deviceIds: string[]
  orientation: Orientation
  zoom: number
  custom: CustomDevice
  /** Route the live frames through the server's framing proxy. */
  proxy: boolean
  showChrome: boolean
  /**
   * Mirror one device's clicks, typing and scrolling onto all the others. Only
   * effective on frames this page is allowed to touch (same-origin — see
   * `useMirror`), which is why it is remembered separately from `proxy`: the
   * intent ("keep them in step") outlives whether it is currently possible.
   */
  syncActions: boolean
}

const PREFS_KEY = 'qc.responsive.prefs'

export const DEFAULT_PREFS: ResponsivePrefs = {
  url: '',
  deviceIds: DEFAULT_DEVICE_IDS,
  orientation: 'portrait',
  zoom: 1,
  custom: DEFAULT_CUSTOM,
  proxy: false,
  showChrome: true,
  syncActions: true,
}

export function readPrefs(): ResponsivePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<ResponsivePrefs>
    const ids = Array.isArray(parsed.deviceIds)
      ? parsed.deviceIds.filter((id) => typeof id === 'string' && (id === 'custom' || presetById(id)))
      : DEFAULT_DEVICE_IDS
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      deviceIds: ids.length ? ids.slice(0, MAX_LIVE_DEVICES) : DEFAULT_DEVICE_IDS,
      zoom: clampZoom(Number(parsed.zoom) || 1),
      custom: { ...DEFAULT_CUSTOM, ...(parsed.custom ?? {}) },
      orientation: parsed.orientation === 'landscape' ? 'landscape' : 'portrait',
    }
  } catch {
    return DEFAULT_PREFS
  }
}

export function writePrefs(prefs: ResponsivePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    /* storage unavailable — the choice just won't survive a reload */
  }
}

// ------------------------------------------------------------------ url

/**
 * What to actually put in the frame.
 *
 * `https://` is added to a bare host so `localhost:5173` in the box does not
 * become a search — except on localhost, where a dev server is almost never TLS
 * and an `https://localhost:5173` frame fails with a certificate error that reads
 * like the app is down.
 */
export function normalizeUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  const local = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.+\.local)(:\d+)?(\/|$)/i.test(value)
  return `${local ? 'http' : 'https'}://${value}`
}

/**
 * The live-frame src: either the URL itself, or the server's framing proxy.
 *
 * The proxy form carries the target's ORIGIN as a base64url path token and keeps
 * the target's own path after it (`/api/responsive/frame/<token>/orders?q=1`).
 * That shape is not cosmetic — a proxied module's relative imports resolve against
 * its own URL, so `?url=` broke every `import './App'` into
 * `/api/responsive/App`. See the block comment on the route.
 *
 * The proxy is skipped for a SAME-ORIGIN target even when it is switched on: the
 * portal's own origin frames without any help, and routing it through the proxy
 * only adds the proxy's limitations (no cookies, a rewritten path) to a page that
 * had none.
 */
export function frameSrc(url: string, proxy: boolean): string {
  if (!url) return 'about:blank'
  if (!proxy) return url
  try {
    const target = new URL(url)
    if (target.origin === window.location.origin) return url
    // base64url — a plain base64 `+`/`/`/`=` would not survive a path segment.
    const token = btoa(target.origin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `/api/responsive/frame/${token}${target.pathname}${target.search}${target.hash}`
  } catch {
    return url
  }
}

/** Whether `url` is the portal's own origin — the proxy is pointless there. */
export function isSameOrigin(url: string): boolean {
  try {
    return new URL(url).origin === window.location.origin
  } catch {
    return false
  }
}
