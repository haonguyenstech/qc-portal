# Responsive testing — `/responsive`

Type a URL, see it on many devices at once, then capture the evidence.

The page is modelled on the **Mobile View — Mobile Simulator** Chrome extension
(`hocbjiaeeijekejepphjihbpogikmofh`): 2–5 device frames over the page at once, real
bezels with a status bar and browser chrome, portrait/landscape, 50–125% zoom, a
custom size with four OS chrome styles and a bezel colour, and a focus mode. What
the extension can do and a web page cannot is what shapes the whole design, so that
list comes first.

## One view, and what it cannot do by itself

The page IS the live preview. There is no second tab: capturing real screenshots
lives behind the camera button, in a dialog, because it is a different ACT (drive a
real emulated device server-side, wait, read findings) rather than a different view
of the same thing — and as a tab it split a page whose whole job is "look at this
URL on these devices".

An extension runs **inside** the page. The portal is a web app, and three of the
extension's abilities are simply not available to one:

| The extension can | A web page cannot | So the portal |
|---|---|---|
| put any site in a frame (it may rewrite response headers) | frame a site that sends `X-Frame-Options` / `frame-ancestors` — and the failure is SILENT: no event, no status, just a blank rectangle | probes the URL server-side and says so up front, and offers `/api/responsive/frame` — the same page fetched by the server with those headers stripped |
| emulate a device properly | fake a user agent, a device pixel ratio, or touch support in an iframe — a phone-detecting app renders its DESKTOP layout in the frame | drives a real emulated device server-side, from the camera button's dialog |
| screenshot the frame | read a cross-origin frame's pixels or DOM at all | make the camera button open that dialog instead of photographing an empty rectangle |
| sync scrolling, clicks and typing between the views | touch a cross-origin frame at all | mirror actions on every frame it is ALLOWED to touch, and say how many those are (see "Mirrored actions") |

Every control that can only work under some conditions says so in the UI, next to
itself, rather than quietly doing nothing.

## Live preview

- **The catalog is one list**, `web/src/lib/responsiveDevices.ts`: the picker reads
  it and a capture request sends the chosen entries to the server, which clamps them
  (`sanitizeDevice`). Two catalogs would drift, and the first thing to drift is the
  label — so the screenshot in a report would be captioned with a device nobody
  picked.
- **53 presets in five groups** — iPhone, Android, **Foldable**, Tablet, Desktop.
  Nothing in it is estimated: every row is either the extension's own number or
  Chrome DevTools' (the list a developer will check the report against), and a
  device whose viewport could not be confirmed is left OUT rather than guessed at —
  a wrong `393` pasted into a ticket is worse than a missing row. Same rule for DPR:
  the server clamps it to 4, so a phone quoted at 4.5 would be captured at a ratio
  nobody picked, and those are omitted too.
- **Foldables are their own group** because they are the one class of device with
  **two** viewports — a cover screen narrower than any phone in the list and an open
  screen the size of a tablet. Both are separate rows so a sweep can hold the pair
  side by side, which is the entire question a foldable asks of a layout.
- **The picker searches the SIZE as well as the name** (`matchesDevice`). At 53 rows
  a grid alone is a scroll, but the deeper reason is the reverse lookup: a bug report
  says "breaks at 412px" and the question is *which phones are 412 wide* — typing
  `412` answers it, and `1280x800` or `@3` work the same way. Multi-term
  (`ipad pro`), `×` normalised to `x` because nobody types U+00D7.
- **Eight live frames, 24 in a capture.** The live cap is a real limit and not a tidy
  one: every frame runs the target's own JavaScript and the mirroring loop touches
  each of them on every event, so past eight the frames start dropping input rather
  than rendering small. A capture is sequential on the server, and the only thing it
  spends is time.
- **The numbers are CSS-pixel viewport sizes**, not panels: an iPhone 13 Pro is
  390×844 with `dpr: 3`. Those are the numbers a media query is written against.
  Heights already have the browser chrome subtracted, which is why a "1080p" phone
  is 640px tall.
- **Chrome is drawn OUTSIDE the screen rectangle.** The status bar, address bar and
  Android nav grow the bezel; they never eat into the iframe. An iframe shrunk to
  make room for a fake status bar would misreport the one thing the page exists to
  show. (Drawing them is not decoration either: a phone's address bar is the 40–56px
  a QC engineer forgets, and it makes "the sticky footer sits under the Safari bar"
  visible before a user files it.)
- **Zoom is a `transform`, not a smaller viewport.** Setting the iframe to 80% width
  would move the app's breakpoints — it would be a smaller *browser*, not a smaller
  *picture of a phone*. Two consequences that were measured on screen:
  - a scaled element still occupies its **unscaled** layout box, so each frame is
    measured (`offsetWidth/Height`, pre-transform) and its wrapper reserves
    `size × zoom`. Without that, at 60% zoom every caption was stranded a screen and
    a half below its own frame.
  - the viewport the page sees stays exactly the device's.
- **Orientation is a rotation of the preset AS AUTHORED**, not "portrait = the taller
  side". The catalog is not all phones: a tablet is quoted landscape (iPad mini
  1024×768) and a laptop only exists landscape. The naive rule rendered
  `Laptop 1280` as an 800×1280 window — a viewport no laptop has, firing the tablet
  breakpoints.
- **Every toolbar write is functional** (`setPrefs((p) => …)`). Ticking three devices
  in the open picker without waiting for a re-render applied all three against the
  same captured state, so only the last one survived and the other two silently did
  nothing. Reproduced, then fixed.
- The whole toolbar is remembered per machine in `localStorage`
  (`qc.responsive.prefs`) — a responsive review is not one sitting, and re-picking
  four phones after every reload is the fastest way to make the page annoying.

### Mirrored actions — "Sync actions"

Do it once on one device and watch it happen on all of them: clicks, typing,
Enter/Escape/Tab, page scroll and inner-scroller scroll. This is the extension's
"scrolling, clicks and typing synchronise between the views", and feasibility is
decided by the same-origin policy rather than by effort — a cross-origin frame
cannot be read or driven **at all**.

So `useMirror` is **capability-detected, not flag-gated**: it drives whatever frames
it can reach and the toolbar reports how many those were ("mirroring 2 of 3 frames",
with a one-click offer to turn the proxy on). Two ways to have drivable frames: tick
"Via portal", or point the page at the portal's own origin. A frame can also *become*
unreachable mid-session — a proxied frame that navigates leaves the proxy.

- **Matching is by path, then by label.** An id when there is one, else an
  `nth-of-type` chain, else the first same-tag element whose visible text /
  aria-label / placeholder reads the same. The chain cannot be the only rule
  because the documents are legitimately different: the same page at 390px and at
  1280px renders a different tree — a nav that becomes a hamburger, a table that
  becomes cards. With no path hit and no label match, that frame just doesn't get
  the action; nothing is invented.
- **Typing is written through the native value setter.** React tracks the last
  value it wrote to a controlled input and ignores an assignment it didn't make, so
  a plain `el.value = …` types into a field the app never hears about.
- **Only Enter / Escape / Tab are replayed as keys.** `input` already carries the
  text; replaying both types every letter twice.
- **Capture-phase listeners**, so an app calling `stopPropagation` in its own
  handler can't hide the click from the mirror.
- **`instanceof` is checked against each frame's own globals.** Every frame has its
  own constructors — `el instanceof HTMLElement` using the portal's realm is false
  for every element inside an iframe.

Two bugs worth keeping written down, both measured:

1. **The loop guard must be released synchronously.** The first version released it
   in `requestAnimationFrame`, and rAF does not run while the tab is HIDDEN — so
   the flag latched on and every action after the first was silently swallowed
   (reproduced with `document.hidden === true`, i.e. a background tab or any
   headless check). A replayed click, keystroke and value write all dispatch
   synchronously, so a `finally` is enough. Scroll is the exception — `scrollTo` on
   a peer makes it fire its own scroll event *later* — and gets a short per-frame
   echo window (`scrollEcho`, 250ms) instead.
2. **Binding once shortly after mount binds nothing on a slow page.** The frames
   were still loading, so typing on one device reached none of the others
   (reproduced against a proxied `github.com/login`). Listeners are now attached
   immediately, on each frame's `load` (a navigation inside a frame gives it a NEW
   document), and on a 1s poll for frames that appear or become reachable later —
   with a `WeakSet` of bound documents so nothing is ever bound twice, which would
   replay every action twice.

Scroll is mirrored **proportionally**: a 640px phone and a 1080px desktop have
different scroll ranges, so mirroring raw pixels puts one at the bottom while the
other is halfway. Verified in a headed browser — 300/1036 on one frame put the
others at 126/435, the same 29%. (It cannot be verified in a hidden headless page:
that page does not scroll at all, source frame included.)

### The framing proxy — `GET /api/responsive/frame/<token><path>`

`<token>` is base64url of the target's ORIGIN, and the target's own path follows
it: `https://app.example.com/orders?q=1` is served at
`/api/responsive/frame/aHR0cHM6…/orders?q=1`. The response has
`X-Frame-Options` and `Content-Security-Policy` stripped (**header and
`<meta http-equiv>`** — a policy repeated in the document survives a header
strip), every URL in the HTML rewritten back through the proxy, and a bootstrap
script injected at the top of `<head>`.

**Why the path carries the target rather than a `?url=` query.** This was the
answer to a reported bug — "checking Via portal means it doesn't load" — and it
is the difference between a page appearing and a blank rectangle:

1. **Subresources have to come through the proxy too.** Left pointing at the
   target, a `<script type="module">` is a CROSS-ORIGIN module fetch, which the
   browser always makes in CORS mode — so a target that sends no
   `Access-Control-Allow-Origin` (i.e. almost every app) has its entry module
   blocked and renders **nothing**. A `<base href>` does not save it: base fixes
   where a URL points, not which CORS rule applies. Reproduced with a
   module-script test app: `route: (js did not run)`.
2. **Then their own relative imports have to resolve.** From
   `…/frame?url=/src/main.js`, `./App.js` resolves to `/api/responsive/App.js` —
   nonsense. From `…/frame/<token>/src/main.js` it resolves to
   `…/frame/<token>/src/App.js`, which maps straight back to the target.

**The injected bootstrap** does the two things an HTML rewrite cannot:

- `history.replaceState` to the target's own path. A single-page app routes on
  `location.pathname`, and without this every proxied SPA read the PROXY's path,
  matched no route, and rendered blank. (Measured: `framePath` was
  `/api/responsive/frame` and `#root` was empty.)
- patches `fetch` and `XMLHttpRequest` so the app's own calls come back through
  the proxy. After the `replaceState` the document sits on the portal's origin, so
  an app calling `/api/orders` would otherwise hit the PORTAL's API — the wrong
  server. Resolution is against the TARGET base, so a relative URL means what the
  app meant by it.

Verified end to end against a test app that sends `X-Frame-Options: DENY`, loads a
module script from an absolute path, and calls its own API: before, `route: (js did
not run) · api: (not called)`; after, `route: /dashboard · api: from the TEST app`.
Also re-verified against `github.com/login` (renders fully styled, in every frame,
with mirroring still working).

**What it is still not.** A browser. The UI says each of these where it matters:

- **it sends no cookies** — the browser cannot hand another origin's cookies to
  the portal, so a page behind a login shows its login screen. The capture dialog
  is the answer there; it drives a real browser that can be signed in.
- **an absolute-path import INSIDE module code is not rewritten** — nothing here
  parses JavaScript — so a Vite dev server's `/node_modules/.vite/deps/*`
  pre-bundles resolve to the portal's root and 404. A production build, whose
  chunks import each other relatively, is fine.
- **a dev server needs none of this.** `http://localhost:5173` sends no framing
  header, so it frames directly; the proxy would only add its own limits. When the
  probe says a URL is framable and the proxy is on anyway, the page says so and
  offers "Load it directly" — that combination is what the bug report was.
- **a same-origin target skips the proxy entirely**, even with the box ticked
  (`frameSrc`): the portal's own origin frames and is already drivable.

Nothing here is a security boundary being lowered: the response goes to the same
localhost page that could already `fetch` that URL itself, the router sits behind
the remote-access gate like every other one, and `parseTarget` allows only
`http`/`https` — `file:` would read the disk and `data:`/`javascript:` would let a
URL carry its own payload into the frame. In proxy mode the frame IS same-origin,
so it is sandboxed **with** `allow-same-origin` (mirroring needs to read it) and
without top-level navigation. In direct mode there is no sandbox: the frame is
another origin already, and a sandbox would only break the app's own storage and
popups.

## Capture & findings (the camera button's dialog)

`POST /api/responsive/captures` → a polled in-memory job (`responsiveJobs.ts`, the
same shape as `perfJobs.ts`), one Chrome context per device with **viewport +
`deviceScaleFactor` + a mobile user agent + `isMobile` + `hasTouch`**.

- **Devices are captured in sequence.** Six contexts loading the same app at once
  compete for one CPU, and that shows up as a timeout on the slowest device — which
  reads as "that device is broken". A sweep costs about as many seconds as it has
  devices.
- **One device failing does not fail the sweep**; the error is recorded on that
  device. Only a browser that cannot launch at all throws — and it throws to the
  route, which answers 400, so a launch failure is an inline message and not a job
  whose only content is "it never started".
- **The user agent is derived server-side** from the platform and the *installed*
  Chrome's version. A UA string in the web bundle would name the browser the bundle
  was built against — the same class of mistake as a machine-specific path.
- **Screenshots live beside the DB** (`data/responsive-runs/<jobId>/<device>.png`),
  never inside a project: a sweep is portal output about an arbitrary URL, not the
  project's QC evidence, and megabytes of PNG in a checkout land in front of
  `git status` on someone else's branch. They are deleted with their job, including
  when it is pruned.
- **`useProfile` (Signed in) keeps the desktop user agent.** Chrome will not open one
  profile twice, so that path is a single persistent context and only the viewport
  and DPR can follow each device. Stated in the UI rather than hidden, because a
  wrong UA changes what some apps serve.
- **Polling continues while the tab is in the BACKGROUND**
  (`refetchIntervalInBackground: true`). React Query pauses an interval on a hidden
  document by default, and a many-device sweep is exactly what an engineer starts
  and walks away from: the page sat on "1 of 4" and the completion toast never fired
  until the tab was focused again.

### The findings are measured in the page, not read off the screenshot

`AUDIT_SCRIPT` runs once per device after the page settles. "The body scrolls 74px
wider than the viewport because `table.invoice-lines` is 448px wide" is a bug report
someone can act on; a picture of a horizontal scrollbar is not. It is a string, not
a function handed to `page.evaluate`, because the server workspace compiles with
`types: ["node"]` and has no DOM lib.

| Finding | Severity | Threshold, and why that one |
|---|---|---|
| `no-viewport-meta` | high | Without the tag a phone lays the page out at ~980px and scales it down, so every media query in the CSS is inert. Nothing else in the list matters until it is fixed. |
| `horizontal-overflow` | high | Document `scrollWidth` > viewport + 2px slack (sub-pixel rounding must not read as a bug). |
| `wide-element` | high / medium | Elements individually wider than the viewport — the *cause* of the sideways scroll. An element whose own `overflow-x` is `auto`/`scroll` is skipped: a carousel scrolls sideways on purpose. |
| `small-tap-target` | medium | 44×44 CSS px is Apple's minimum, 24×24 is WCAG 2.2 AA (2.5.8). Touch viewports only, and an inline text link inside prose is exempt — flagging those fails every article page. |
| `clipped-text` | medium | `scrollWidth > clientWidth`, overflow hidden, no ellipsis: the text is *gone*, not visibly truncated. |
| `tiny-text` | low | <12px body text; separately, a form field under 16px, which is what makes iOS Safari zoom the page on focus — reported by users as "the layout jumps when I tap the field". |
| `fixed-overlay` | low | A fixed/sticky bar over a quarter of the viewport height. Invisible in a desktop review, a third of the page on a short phone. |
| `zoom-disabled` | low | `user-scalable=no` / `maximum-scale=1` — fails WCAG 1.4.4. |
| `oversized-image` | low | ≥2× the pixels it is drawn at, at that device's DPR. |

Two readings the UI derives, because they change what happens next:

- **`commonKinds`** — a finding on every device is a layout bug (one ticket); the
  same finding on one device is a breakpoint bug (a different fix).
- **`verdictOf`** — a device that failed to capture is **not** counted as clean, and
  a redirected sweep is announced in the error voice. Both are the same trap
  `perfJobs` guards for a redirected audit: the closing line is the one that gets
  quoted, and "clean on 6 devices" must never describe a login screen.

`responsiveMarkdown` is the export, and it is the **same source** as the screen —
the rule `systemReport.ts` and `perfReport.ts` already follow, so a finding pasted
into a ticket cannot disagree with the row it was copied from.

## Files

```
server/src/responsiveCapture.ts   device emulation, AUDIT_SCRIPT, screenshots, probeUrl
server/src/responsiveJobs.ts      the polled in-memory job registry
server/src/routes/responsive.ts   /available /probe /captures /jobs /shot /frame
web/src/lib/responsiveDevices.ts  THE device catalog + orientation/zoom/custom/prefs
web/src/lib/responsiveFindings.ts severity, wording, verdict, commonKinds, Markdown
web/src/pages/ResponsivePage.tsx  the two tabs, the drawn chrome, the report
```

Wired in `server/src/index.ts` (router + `shutdownResponsiveJobs` on exit — its
Chromes are launched outside `runManager`, so a restart mid-sweep would orphan
them), `web/src/App.tsx` (`/responsive`) and `web/src/lib/nav.ts` (Testing group —
it takes a URL and answers a pass/fail question about it, the same shape as Design
Check next door).
