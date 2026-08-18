<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## The QC browser — pause a flow instead of closing it

Playwright MCP normally runs as a **stdio child of `claude`** and launches the browser
itself. Two complaints come straight out of that arrangement, and neither is fixable on the
stdio side:

1. **Stop closed the browser.** Stopping a chat turn (or pausing a QC run) kills the
   `claude` child → its MCP servers are torn down → the browser they launched closes. The
   logins, the half-filled form and the page you were mid-way through all go with it, so
   "let me pause, fix this step, and carry on" was impossible.
2. **The window was never full screen.** The MCP opened a default-size headed window and
   `playwrightArgs` pinned `--viewport-size 1280x720` on top of it, so the app rendered in a
   small box on a large monitor — desktop breakpoints never fired and evidence screenshots
   were the wrong shape.

**The fix is a browser the PORTAL owns** (`server/src/qcBrowser.ts`, `routes/browser.ts`),
which the project's Playwright entry attaches to with `--cdp-endpoint`. Verified end to end
before it was built, and again after: a turn was stopped mid-flight and the browser stayed
open **on the same page** (`/notes`), then a fresh turn snapshotted that live page without
navigating; the window measured 2560x1410 maximized instead of 1619x936.

- **Per project, opt-in** — `projects.persistentBrowser` (migration in `db.ts`, toggled by
  the `QcBrowserCard` on `/mcp`). It changes which browser a project's runs drive, so it is
  the engineer's call; existing projects default OFF and behave exactly as before.
- **The toggle rewrites `.mcp.json`** through `applyPlaywrightAttachMode` (routes/mcp.ts),
  called from the projects `PUT` route and from `repairProjectMcpConfig` at boot. Which
  flags come OFF in attached mode is load-bearing: `--viewport-size` **must** go (it
  emulates a fixed viewport over the real window, so leaving it keeps the page at 1280x720
  inside a maximized browser — the full-screen bug would survive the fix), and
  `--user-data-dir` / `--browser` / `--headless` describe a launch this MCP no longer does.
  `normalizePlaywrightProfile` bails out when a `--cdp-endpoint` is present, or it would put
  the profile flag straight back.
- **`ensureQcBrowser()` runs at the START of a turn** — `routes/chat.ts` awaits it (and says
  in a `log` frame whether it adopted or opened one), `runManager.ts` fires it as a `system`
  event. The endpoint has to be listening before the CLI starts, or every browser tool fails
  mid-turn with a connection error that reads like a broken MCP install.
- **Adopt, don't duplicate.** The browser is spawned **detached** so it survives a portal
  restart, and `ensureQcBrowser` adopts whatever answers on `QC_BROWSER_PORT`. Chrome refuses
  to open one profile twice, so starting a second would fail anyway. The consequence to keep:
  after a portal restart the pid is unknown, so **Stop refuses** rather than guessing — the
  card says so and the engineer closes the window themselves. Never "find" it by matching a
  profile path against the process list; that is how you close someone's real browser.
- **`--start-maximized` is a no-op on macOS** (verified: `windowState: "normal"`). So sizing
  goes through CDP `Browser.setWindowBounds` (`maximizeQcBrowserWindow`, over the `ws` the
  server already depends on) — on a **fresh launch only**, plus an explicit **Maximize**
  button, because a window the engineer positioned deliberately shouldn't be yanked
  fullscreen mid-session. Send `windowState` **alone**; combining it with left/top/width/
  height is a protocol error.
- **Self-launch mode got the full-screen half too**, since not every project attaches:
  `writePlaywrightMcpConfig()` writes `data/playwright-mcp.json` (beside the DB — it
  describes this machine, never a project repo) with `launchOptions.args:
  ['--start-maximized']` and `contextOptions.viewport: null`, referenced as `--config`. A
  browser launch argument has no CLI flag on the MCP, which is why it must be a file. On
  macOS this yields a page that fills its window but not a maximized window (see above);
  on Windows and Linux it maximizes.
- **A run can ask for HEADLESS, per run.** `/qc-run`'s "Run headless" checkbox is a property
  of the run, not of the project: the same engineer watches a flaky login flow, then wants a
  long sweep to run without a window stealing focus. `playwrightRunMode.ts` serves it by
  writing a COMPLETE per-run MCP config (every server the project has, only Playwright's
  browser mode swapped) and passing it as `--mcp-config … --strict-mcp-config` — it never
  rewrites the project's `.mcp.json`, which is the engineer's saved default and is read
  concurrently by chat. Headless gets its OWN `--config` file
  (`writeHeadlessPlaywrightMcpConfig` → `data/playwright-mcp-headless.json`): the headed one
  says `viewport: null` + `--start-maximized`, and a headless Chrome has no window to fill,
  so the page would render at Chrome's 800x600 default — the wrong breakpoints and the wrong
  screenshot shape. It pins 1440x900 instead (verified end to end: `window.innerWidth/Height`
  came back 1440x900 through a real CLI run with the generated config, no window opened).
  **In attach mode there is nothing to hide** — the QC browser is a window the portal already
  opened — so the checkbox is disabled on the Run page and the run records a `system` event
  saying so rather than silently ignoring the request.
- **Between turns it is just a browser.** That's the point of the feature, not a side
  effect: the engineer clicks around, fixes the state by hand, and the next message
  continues from whatever is on screen.

