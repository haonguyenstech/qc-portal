# Installing without a terminal — the .exe and the .dmg

The portal has had a working installer since long before this: `install.ps1`,
`install.bat` and `install.sh` at the repo root, run with a `curl | bash` / `irm | iex`
one-liner. They ensure Node 22.5+, git and Claude Code, clone into `~/.qc-portal`, build,
and put a `qc-portal` command on the PATH. **Those are still the installer.** Everything
in `installer/` is packaging and shortcuts around them.

That split is the single rule of this directory: **there is one implementation of the
install**. A `.exe` that carried its own copy of the install logic would be a second one,
and the copy would drift the first time someone fixed a bug in only one of them.

## What was actually missing

Two things, both about the terminal:

1. **A shortcut that opens an app.** The install put `qc-portal` on the PATH — which means a
   QC engineer has to open a terminal and type it, and what appeared was a browser tab.
   There was no icon to click and nothing that looked like an application.
2. **One file to double-click.** The install itself needed a command pasted into a
   terminal, which is a barrier for exactly the person the portal is for.

## The shape

```
installer/
  icons/qc-portal.ico    Windows shortcut icon (6 PNG entries, 16-256)
  icons/qc-portal.icns   macOS bundle icon (16-1024, via iconutil)
  windows/shortcut.ps1   creates the Desktop + Start Menu .lnk        <- called BY install.ps1/.bat
  windows/uninstall.ps1  removes exactly what those two created
  windows/qc-portal.iss  Inno Setup script -> one QC-Portal-Setup.exe
  macos/shortcut.sh      creates ~/Applications/QC Portal.app          <- called BY install.sh
  macos/uninstall.sh     removes exactly what install.sh created
  macos/build-dmg.sh     builds one QC-Portal-Installer.dmg
```

`install.ps1`, `install.bat` and `install.sh` each gained **one step at the end** that calls
the matching `shortcut.*` script, guarded so a missing file or a failure only prints a line —
an install that worked must not be reported as failed because an icon could not be drawn.
`install.sh` also serves Linux, WSL and Git Bash, so its step returns early unless
`uname -s` is `Darwin`.

## The .exe is a wrapper, not a package

`qc-portal.iss` bundles exactly one file: **`..\..\install.ps1` — the root installer
itself**, referenced at build time rather than copied. The `.exe` extracts it to `%TEMP%`
and runs it in a visible PowerShell window.

It carries no Node, no repo and no built app, and this is the load-bearing part: the install
stays an ordinary **git checkout**, which is what lets `qc-portal --update` (and the Release
notes page's "update now") keep working. Package the app into a blob and that whole
mechanism has to be replaced by a signed app-updater feed — see "Self-update" in
`layout.md` for why that mechanism is not something to casually replace.

The console window is deliberate. The first install takes minutes (npm install, then a full
build); a silent wizard with no output reads as a hang, and users kill it.

Build it on Windows — Inno Setup only compiles there:

```powershell
winget install JRSoftware.InnoSetup
& "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" installer\windows\qc-portal.iss
# -> installer\windows\dist\QC-Portal-Setup.exe
```

## The .dmg is a delivery vehicle

`build-dmg.sh` produces a ~110 KB image holding `Install QC Portal.command` plus a
`READ ME FIRST.txt`. The `.command`'s entire body is the README's `curl | bash` line, so the
logic is **fetched fresh at install time** — a disk image passed round on a USB stick can
never install a stale installer.

```bash
bash installer/macos/build-dmg.sh   # -> installer/macos/dist/QC-Portal-Installer.dmg
```

`installer/*/dist/` is gitignored: the `.exe` and `.dmg` are release downloads, not source.

## Publishing them — the README buttons must not need editing

The two artefacts are **GitHub release assets**, never committed (`installer/*/dist/` is
gitignored). A 2 MB `.exe` per release would sit in the git history for ever, and a repo is
not a download server.

So each release, after the tag is pushed:

```bash
bash installer/macos/build-dmg.sh          # the .dmg builds anywhere
# the .exe must be compiled on Windows (see above), then:
gh release create vX.Y.Z --title "X.Y.Z — <title>" --notes-file <notes> \
  installer/windows/dist/QC-Portal-Setup.exe installer/macos/dist/QC-Portal-Installer.dmg
```

The README's download buttons point at
`releases/latest/download/QC-Portal-Setup.exe` — a **version-independent** URL that GitHub
resolves to the newest release carrying an asset of that exact name. That is why the asset
filenames are fixed and must not gain a version suffix: rename them and every published link
breaks silently, and nobody notices until a QC engineer downloads nothing.

The corollary: a release whose assets were never uploaded leaves those buttons pointing at
the PREVIOUS release's installers. That is the failure mode to watch for — the buttons keep
working, they just hand out something older than the tag suggests. Both installers clone
`main` at install time, so what they build is current regardless; the stale part would only
be the installer logic itself.

## Signing — the part that costs money

Neither artefact is signed, and the failure modes differ, so tell users the right thing:

| | What the user sees | Way through |
|---|---|---|
| **Windows** `.exe` | SmartScreen: "Windows protected your PC", unknown publisher | *More info* -> *Run anyway*. It installs fine. |
| **macOS** `.dmg` | "Apple could not verify ... is free of malware", default button **Move to Trash** — only when downloaded with a browser | *System Settings -> Privacy & Security -> Open Anyway*, or the `curl` one-liner, or get the image off a share instead. Hence `READ ME FIRST.txt`. |

**The macOS block, measured.** Three rounds of wrong advice went into this doc before it was
actually tested, so here are the observations (macOS 26.4):

| The `.dmg` | Double-click |
|---|---|
| no `com.apple.quarantine` (built locally, USB stick, share, sync client) | **runs** |
| quarantined, flags `0001` — what a browser sets | **blocked**: "Apple could not verify ... is free of malware", default button *Move to Trash* |
| after the user approves it once (the `0002` bit) | runs |

Three conclusions follow, and each one killed a plausible fix:

- **It is not `spctl`.** The block reproduces on a machine reporting
  `spctl --status: assessments disabled`, so `spctl --master-disable` is not a workaround —
  this gate lives in LaunchServices/XProtect, not in the assessment `spctl` controls.
- **It is not "unsigned" as such.** The *same unsigned image*, unquarantined, double-clicks.
  Which is also why the `~/Applications/QC Portal.app` the installer writes is never blocked,
  and why `AutoAgent Status.app` — ad-hoc signed, no Team ID, not notarised — launches
  perfectly: it was written locally by an npm CLI, never downloaded.
- **Ad-hoc signing buys nothing.** It satisfies no notarisation check.
- **The `right-click -> Open` bypass is gone**, removed in macOS 15. It was in this doc, the
  README and the image's own README, and all three were wrong: the dialog offers only *Move
  to Trash* and *Done*.

So for a browser download there are exactly two answers: *System Settings -> Privacy &
Security -> Open Anyway*, or **notarise**. And one way to avoid the question entirely — hand
the image over on a share or a USB stick, where nothing marks it.

**Why the payload is an `.app`, not a `.command`.** A bare shell script **can never be
notarised**: there is nothing to sign. An `.app` bundle whose executable is a shell script
can be, which is the only reason route 1 exists for us at all. The bundle
(`Install QC Portal.app`) is three files — an `Info.plist`, the icon, and a script that opens
Terminal and runs `curl -fsSL <install.sh> | bash`. Fetching the installer fresh rather than
carrying a copy means an image left on a share for six months cannot install a stale
installer, and leaves no second script inside the bundle for Gatekeeper to assess. Terminal
does the work because the install takes minutes and prints its progress — a progress bar we
would otherwise have to invent, badly.

**Notarising, when there is a Developer ID.** `build-dmg.sh` does the whole thing; it is
skipped with a printed note when the two variables are absent:

```bash
# once per machine:
xcrun notarytool store-credentials qcportal --apple-id <you@example.com> \
  --team-id <TEAMID> --password <app-specific-password>

QC_SIGN_ID="Developer ID Application: <Name> (<TEAMID>)" \
QC_NOTARY_PROFILE=qcportal bash installer/macos/build-dmg.sh
```

It signs the app **with the hardened runtime** (`--options runtime`, which notarisation
requires — without it the upload is accepted and the ticket then fails), signs the image,
submits it, waits, and staples the ticket so a machine with no network still sees it.

Fixing them properly: an OV/EV code-signing certificate on Windows (a few hundred USD a
year), and an Apple Developer ID plus notarisation on macOS ($99/year). Until someone buys
those, the two rows above are documentation, not bugs.

## Why not Electron / Tauri

It was considered and rejected. A packaged app would remove exactly **one** prerequisite —
Node — while the portal still needs the `claude` CLI (with its own login), git, and
optionally k6, cloudflared, uvx and adb, because the portal *wraps* those tools rather than
containing them. Against that: `node-pty` is a native module needing a rebuild per platform
and per Electron ABI, `node:sqlite` pins a recent Node, the download goes from a shell
script to ~150-200 MB, and `qc-portal --update` would have to be rewritten as a signed
updater feed. The cost is real and permanent; the gain is one prerequisite.

## Clicking the icon opens an app window, not a tab

The shortcut does not run `qc-portal`. It runs **`qc-portal --app`**, and that flag is the
difference between "a browser opens on a local URL" and "an app opens".

`openAppWindow()` in `bin/qc-portal.mjs` starts the server as usual, then launches Edge
(Chrome as fallback, `QC_APP_BROWSER` to override) with **`--app=<url>`**: Chromium then
draws a window with no tab strip, no address bar and no browser UI, taking its title and
icon from `web/public/manifest.webmanifest`. No `--user-data-dir`, so the window shares the
normal profile and the portal's theme and last-open project match what a browser tab shows.

Three things there are load-bearing:

- **The executable is run directly, not `open -a`.** On macOS, `open -a "Microsoft Edge"
  --args --app=...` silently DROPS the arguments whenever Edge is already running — the user
  gets an ordinary tab and nothing explains why. And `open -na` would fight the running
  instance's profile lock. Executing the binary lets Chromium's own singleton hand the
  command line to the live process, which opens the app window. (Which is also why no
  `--app=` process lingers afterwards: the spawned one exits immediately.)
- **No Chromium anywhere falls back to a normal tab.** A portal in a tab works; only the
  chromeless window is lost. Failing the launch instead would trade a cosmetic loss for a
  broken one.
- **`--restart` still opens a tab, not an app window.** The in-app Restart button sets
  `QC_NO_OPEN` and opens nothing at all; the distinction is that `open` is now
  `'tab' | 'app' | false` rather than a boolean, so don't collapse it back.

Known wart: clicking the icon while an app window is already open gives a **second** window
rather than focusing the first — Chromium's `--app=` has no "reuse the window" mode, and the
cross-platform ways to find and raise the existing one are fragile enough that a duplicate
window is the better failure. The server is untouched either way; `--app` only ever adds a
view onto the one already running.

## What app mode changes for the features — audited

The window is the same bundle on the same origin, so nothing about the portal's own
behaviour changes. What changes is the **browser UI that is no longer there**, and only one
feature relied on it.

Checked in a real app-mode window (`display-mode: standalone`), driven over CDP:

| | Result |
|---|---|
| Service worker | registered and controlling the page |
| `fetch /api` | 200 |
| WebSocket (`/ws`, so run logs and the terminal) | connects |
| `navigator.clipboard.writeText` (30 call sites: copy code, copy SQL, copy path) | ok — localhost is a secure context |
| Blob downloads (`a.download`, 6 export paths) | the file lands in `~/Downloads` |
| `window.open` / `target="_blank"` (32 anchors: ClickUp tickets, docs) | opens a normal browser window; the app window is not navigated away |
| `<input type="file">` (10+ upload paths) | the picker opens (`Page.fileChooserOpened` fires) |
| Uncaught page errors | none |

**The one thing that broke: a download nobody could see.** In a tab, Chromium's download
bubble is the confirmation that an export worked. An app window has no toolbar, therefore no
bubble — so a save that lands silently in `~/Downloads` reads as a button that did nothing.
Performance PDF/Word, the NFR report and project export already toasted; four paths did not,
and now do (naming the file, since nothing else will):

- Database page -> **Download CSV**
- Prototype -> download the standalone `.html`
- Chat -> export the transcript as `.md`
- Instructions -> Accounts -> **Example CSV**

Verified end to end with real mouse clicks in the app window: Instructions -> Accounts ->
*Example CSV* saved `environments-example.csv` **and** raised the toast
"Example downloaded / environments-example.csv".

Two things deliberately keep working the way a browser would, because app mode should not
change what the portal *is*: an external link still opens in an ordinary browser window
(the app window must not navigate off the portal), and the print/save shortcuts remain
Chromium's own.

## The Windows shortcut runs through a .vbs, and that is on purpose

`bin/qc-portal.mjs` spawns the server **detached** and then exits. A `.lnk` pointing straight
at `node` would therefore flash a console window on every start — the app looks broken before
it looks fast. `shortcut.ps1` writes a one-line `launch.vbs` and points the shortcut at
`wscript.exe`, which starts it with no window at all; the `.lnk` keeps the real icon via
`IconLocation`.

On macOS the same problem is solved by `LSUIElement` in the bundle's `Info.plist`: without
it, a launcher that starts a server and exits would sit in the Dock as a running app owning
no window.

## Every .ps1 here is pure ASCII, and that is not a style choice

PowerShell 5.1 — what Windows 10 still ships, and what these machines run — reads a `.ps1`
with **no byte-order mark as ANSI, not UTF-8**. A UTF-8 em dash (`E2 80 94`) therefore
decodes to three cp1252 characters, the last of which is a **right curly quote** — and 5.1
treats a curly quote as a string delimiter. One em dash in a comment ends a string early and
the whole file fails to parse.

That is not theoretical: `shortcut.ps1` and `uninstall.ps1` were written with em dashes like
every other file in this repo, and PowerShell 5.1 rejected both — 1 and 2 parse errors, at
the exact lines carrying a dash. The root `install.ps1` passed only because it happened to be
ASCII already.

So: no em dashes, no curly quotes, no ellipses in a `.ps1` (or the `.iss`, which shares the
tooling). A BOM would also fix it, but a BOM is invisible and one editor or filter that drops
it brings the bug back silently; ASCII cannot be undone by accident. Markdown and the shell
scripts are unaffected — this is a PowerShell 5.1 encoding rule, not a house style.

## How it was verified

- **The app window, on macOS**: `qc-portal --app` and the generated bundle's own launcher
  both produce an Edge window whose entire chrome is the three traffic-light buttons plus a
  title label reading "QC Portal — Acceptance testing" — no tab strip and no address bar
  (a normal Edge window has no such label, because its title lives in the tab strip). A
  screenshot could not be taken to show it: `screencapture` produced no file, almost
  certainly for want of Screen Recording permission for the terminal.
- **macOS, the whole file install, step by step** (which is what caught the bash 3.2 bug the
  piecewise checks missed): downloaded the published `.dmg`, mounted it, double-clicked
  *Install QC Portal*, watched Terminal install Node/Claude checks -> clone -> build ->
  `Done!`, and confirmed `~/.qc-portal` at the shipped version, `~/Applications/QC
  Portal.app` created (unquarantined, launcher carrying `--app`), the `~/.local/bin/qc-portal`
  shim, and clicking the app opening the chromeless window. The installer app also ad-hoc
  signs and verifies (`codesign --verify --strict`), which is what says the bundle is
  structurally notarisable.
- **macOS, end to end on the pieces that are fiddly**: the `Info.plist` text taken straight
  out of `shortcut.sh` passes `plutil -lint` and reads back with the right keys
  (`LSUIElement`, `CFBundleIconFile`, version); the generated bundle launches
  (`open` returns 0) and its launcher answers `qc-portal --status` correctly; the `.icns`
  is a valid `iconutil` archive; the `.dmg` builds, mounts, and holds the `.command` with
  its executable bit intact.
- **The `.ico`** parses as a 6-entry icon directory (16/32/48/64/128/256, all PNG payloads,
  256 correctly written as `0` in the directory as the format requires).
- **On Windows 10 (PowerShell 5.1), over SSH**: `install.ps1`, `shortcut.ps1` and
  `uninstall.ps1` all parse (`[Parser]::ParseFile`, 0 errors) — after the ASCII fix above,
  which that same check is what caught. `shortcut.ps1` was then RUN against a throwaway
  install dir: both shortcuts appear, with `wscript.exe` as the target, the quoted
  `launch.vbs` as the argument (the path contains a space, and it survives), the right
  working directory, and `qc-portal.ico` as the icon — which `System.Drawing.Icon` loads,
  so Windows accepts the file. The generated `launch.vbs` carries `--app`. `node
  bin/qc-portal.mjs --help` runs there and lists `--app`, and the browser probe picks
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`. The test shortcuts and
  temp files were removed afterwards.
- **Still not verified**: the `.exe` has never been compiled (Inno Setup is not installed on
  that machine), and the app window has not been seen on a Windows desktop — a GUI launched
  from an SSH session lands in a non-interactive session, so it would not appear on the
  user's screen anyway.
