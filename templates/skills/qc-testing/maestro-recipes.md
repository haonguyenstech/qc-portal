# Maestro recipes — driving a MOBILE device (the mobile equivalent of `playwright-recipes.md`)

Read this **instead of** `playwright-recipes.md` when the run's brief says the target is a
mobile device — either **the web app opened on a device** or **a native app installed on a
device**. Everywhere the skill says `browser_*`, the mobile equivalent from this file applies.

Maestro is the only mobile MCP the Portal configures. It is a *flow runner*, not a browser
automation API: there is no per-action tool. You send **YAML commands** to a device and you read
the screen back. Three tools do almost everything:

| Tool | Params | What it's for |
|------|--------|---------------|
| `list_devices` | — | every bootable/booted device; gives you the `device_id` |
| `inspect_screen` | `device_id` | the current screen's view hierarchy as compact JSON — **this is your content inventory** |
| `run` | `device_id`, `yaml` (or `files` / `dir`), `env` | do anything: launch, tap, type, scroll, assert, **screenshot to a file** |

`cheat_sheet` (no params) returns the full Maestro command reference — call it once if you need a
command this file doesn't cover. `take_screenshot`, `open_maestro_viewer`, and the `*_cloud_*`
tools exist too; see R3 for why `take_screenshot` is **not** how you capture evidence.

---

## R0 — Device first, and only that device

```
list_devices  →  [{ device_id: "…", name: "iPhone 15 Pro", connected: true }, …]
```

- **Every other tool needs `device_id`** — the UDID / adb serial, never the human name.
- If the run's brief pinned a `device_id`, pass exactly that one to every call. If it isn't in
  the listing, **stop and report a blocker** naming the ids you did find; testing a different
  device silently makes the whole report about the wrong device.
- The synthetic `chromium` entry is a drivable **web** device even though it reports
  `connected: false` — that's the target for "the web app on a mobile device" when no real
  device is booted.
- Nothing booted at all → stop and report that as a blocker. Do not try to install or provision.

## R1 — Open the thing under test

**Native app** (`appId` is the package name on Android / bundle id on iOS):

```yaml
# run { device_id, yaml: … }
- launchApp:
    appId: "com.example.app"
    clearState: false     # true only when the case needs a first-run state
```

Don't know the `appId`? Launch by the name the brief gave you from the home screen
(`- tapOn: "Clinic"`), then read `inspect_screen` — or ask. If the app isn't installed, that's a
blocker: **report it, never install it.**

**Web app on a device** — open the URL in the device's browser:

```yaml
- openLink: "https://staging.example.com/login"
```

Log in **once** with the accounts from `testing/environments.md`. Never write a credential or an
OTP into an evidence file, a screenshot name, or the report.

## R2 — Read the screen (`inspect_screen`) before every guess

`inspect_screen` returns the hierarchy with abbreviated keys — `txt` (text), `rid` (resource id),
`a11y` (accessibility text / content-desc), `hint`, `val`, `b` (bounds), `c` (children). Flags
(`clickable`, `checked`, `enabled`, `selected`, `focused`) only appear when they differ from the
platform default listed in the payload's `ui_schema`.

Three rules that decide whether your next command works:

1. **Those abbreviated keys are NOT selector keys.** Selectors take `text`, `id`, `index`, and
   the position matchers (`below`, `above`, `leftOf`, `rightOf`). Map an `a11y` value to `text:`;
   never pass `a11y` / `accessibilityText` as a selector.
2. **`text:` is a FULL-STRING regex (ignore-case).** A partial string does **not** match:
   `text: "Appointment"` misses an element whose real text is
   `"Appointment Rescheduled — 15-Jul-2026"`. Use the whole string, or anchor a regex
   (`text: "Appointment Rescheduled.*"`).
3. **Copy `txt` values verbatim from the hierarchy, never off a screenshot.** An icon that
   *looks* like a "Favorite" button often has no such text, and a selector you typed from a
   picture is how a mobile run burns ten turns on a tap that can never match.

## R3 — Evidence on disk: screenshot via `run`, inventory via `inspect_screen` + Write

**This is the recipe that decides whether the run has any evidence at all.** The `take_screenshot`
tool returns the image *inline in the conversation* and takes **no path** — nothing lands on disk,
so an issue filed from it has no picture and the report links a file that doesn't exist. Capture
into the run folder with the `takeScreenshot` **command** instead:

```yaml
# run { device_id, yaml: … }   — pass an ABSOLUTE path; relative paths resolve against
# Maestro's workspace dir, which is not necessarily this project's root.
- takeScreenshot:
    path: "/abs/path/to/project/testing/test-result/<ticket>-<slug>-<token>/screenshots/ac1-list.png"
```

Then **verify it landed** (`Bash: ls -l …/screenshots/`) after your first screenshot of the run.
If the file isn't there, `find` the png Maestro wrote and move it in — once, then keep using the
form that worked. A screenshot you believe in but never checked is how a report ends up linking
images that don't exist.

The **content inventory** has no one-call equivalent either: call `inspect_screen`, then **Write**
the meaningful text you got back into `evidence/<screen>.md` yourself — headings, labels,
placeholders/`hint`, button texts, list rows, badges, option lists, visible values, messages,
plus the `enabled`/`checked`/`selected` flags. That file is what the Phase 5 subagents read to
judge content and functional rows without opening a single PNG, so it has to carry the real
strings, not your summary of them.

Every state in the Capture Plan gets **both**: one screenshot file and one inventory file.

## R4 — Interact

```yaml
- tapOn: "Sign in"                    # full-string, ignore-case regex
- tapOn:
    id: "submit_button"
    index: 0                          # 0-based, when several match
- tapOn:
    text: "Edit"
    below: { text: "Appointment details" }   # or above / leftOf / rightOf
- inputText: "qc.tester@example.com"  # types into the focused field
- eraseText                            # clears the focused field (or `eraseText: 10`)
- hideKeyboard                         # flaky on iOS — prefer pressKey
- pressKey: "Enter"                    # enter | home | lock | backspace | volume up/down
- back                                 # Android only; on iOS tap the app's own back control
- swipe: { direction: LEFT, duration: 300 }
- scroll
- scrollUntilVisible:
    element: "Load more"
    direction: DOWN
    timeout: 10000
- longPressOn: "Menu"
- doubleTapOn: "Image"
```

Batch a few commands into one `run` call when they're a single user action with a known outcome
(open a menu → tap an item → wait for the next screen). Keep exploration one step at a time with
an `inspect_screen` after it — a batch that fails mid-way leaves you unsure which step broke.

## R5 — Wait for the screen, never sleep

```yaml
- extendedWaitUntil:
    visible: "Notification Center"
    timeout: 8000
- extendedWaitUntil:
    notVisible: { id: "loader" }
    timeout: 5000
- waitForAnimationToEnd
```

A wait on the screen's own text **is** the assertion. Fixed sleeps are slower and prove nothing.

## R6 — Assertions that are worth writing

```yaml
- assertVisible: "Appointment Rescheduled"
- assertVisible:
    text: "Submit"
    enabled: true
- assertNotVisible: "Error"
```

A **failing `run`** is a real signal: the command it stopped on is the one that didn't hold, and
the error text belongs in the finding. But it also aborts the rest of that YAML — so put an
assertion you *expect might fail* in its **own** `run` call, or the steps after it never execute
and cases behind it look untested when they were simply never reached.

Never fake a pass: there is no equivalent of a forced JS click here, and `optional: true` on a
command means "don't fail the flow", not "the app worked".

## R7 — Permissions, state, and the device conditions a case names

```yaml
- launchApp:
    appId: "com.example.app"
    permissions: { notifications: allow, location: deny }
- setPermissions: { permissions: { camera: deny } }
- setOrientation: LANDSCAPE          # then PORTRAIT again afterwards
- setAirplaneMode: enabled           # Android only — offline / no-network cases
- setLocation: { latitude: 10.77, longitude: 106.69 }
- clearState                          # first-run / logged-out cases
- stopApp
```

Background/foreground, rotation, offline, and denied-permission cases are **mobile-only ACs** the
web checklist never covers — if the ticket is about a mobile app, they belong in the scenario
matrix (see `edge-cases.md`, applied to the device instead of the browser).

## R8 — What Maestro cannot do, and what that means for a verdict

- **No console log, no network panel, no DOM.** The web checklist's console-error and
  computed-style checks have no equivalent. Don't report them as passed; say the layer wasn't
  observable on this target.
- **No `browser_evaluate`.** Anything you'd have computed in the page you must read out of
  `inspect_screen` or see in a screenshot.
- **Pixel/spacing comparison is by screenshot only** — judge layout, truncation, overlap and
  contrast from the image, and be explicit that it's a visual judgement.
- **The first drive of an iOS simulator is slow** (Maestro installs its XCUITest runner; the
  Portal already raises the startup timeout to 120s). A first-call timeout is usually cold start,
  not a broken device — retry once before calling it a blocker.

## R9 — Mobile Blocked vs Failed vs Not Tested

The same rule as the web target, and the same trap: a device is fiddlier, so it's tempting to
call every unreached case Blocked.

- The app/screen genuinely isn't reachable (not installed, no account for that role, the screen
  needs a build you don't have) → **⛔ Blocked**, naming what was missing.
- A command failed because the app did something wrong (element never appeared, wrong text,
  validation didn't fire) → **❌ Failed**, with the error and a screenshot.
- A selector you guessed wrong, a tap that missed, a cold-start timeout → **neither**. Re-read
  `inspect_screen`, fix the selector, and test the case.
- The run's brief authorized test-data creation → a case that needs data is **not** Blocked;
  create the data on the device and grade it.
