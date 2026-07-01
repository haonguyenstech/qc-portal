# Release Notes

All notable changes to **QC Portal** are recorded here. The version shown in the
sidebar footer matches the `version` in the repo root `package.json`.

## 0.8.1 — 2026-07-01

**Fix MCP servers stuck on "Pending approval"**

### Fixed

- **"Test connection" now clears a server stuck on "Pending approval."** When a project's
  MCP server (for example **Figma**) showed *Pending approval* and pressing **Test connection**
  still failed with *"Approved… but connection still failed"*, the portal was recording the
  approval in a file the current Claude CLI no longer reads. It now approves the server where the
  CLI actually looks — trusting the project and enabling its `.mcp.json` servers — so a single
  click flips it to **Connected**, even for a project you'd never opened in Claude directly. If
  you hit this with Figma, your API token was never the problem; it was purely this approval
  handshake.

## 0.8.0 — 2026-07-01

**Mobile testing, portable projects & faster everyday flows**

### Added

- **Run QC on a mobile device.** The Run page now asks *where* to run: **Web** (desktop
  browser, as before), **Web on mobile** (your App URL opened in a real device or simulator's
  mobile browser), or **App on device** (a native iOS/Android app already installed on a
  connected device). Mobile runs drive a booted device through the new **Mobile** MCP server
  and capture mobile screenshots as evidence. "App on device" needs no App URL.
- **One-click Mobile MCP setup.** The MCP page has a new **Mobile** server you can connect with
  a single click (no token). Its **functional test** auto-detects connected devices/simulators,
  lets you pick one, and then actually drives it to confirm it works — and reads "works, but no
  device is booted" as a warning, not a failure.
- **Export and import a whole project as a `.zip`.** Each project card has an **Export** button
  that bundles just the QC setup — `CLAUDE.md`, skills, `.mcp.json`, and the `testing/` folder
  (never `node_modules`/`.git`) — into one file. **Import project** re-creates a project from
  such a zip on another machine: pick the file, a name, and a destination folder.
- **Delete a finished run.** Run detail and History now have a **Delete** button that removes a
  run's history entry, event log, and its entire on-disk output folder (report, issues,
  screenshots) after a clear confirmation. Active runs can't be deleted until they finish.
- **Set a default skill per project.** On the Skills page, star a skill as the project's
  **default** — it's pinned to the top and auto-selected on the Run page for new runs.
- **Run several test-case generations at once.** Start a generation, then immediately pick more
  tickets and start another — up to 3 jobs run in parallel, each with its own progress, live
  log, and Pause/Resume/Cancel. A browser reload reconnects to all of them.
- **Clickable evidence in reports.** Screenshot and file names that appear in a report's tables
  are now chips — click one to open the image/file in a popup without leaving the Report tab.
- **"Configure MCP" prompts.** The Run and Design Check pages now warn (with a one-click link)
  when the project is missing a server those features need, and the warning clears the moment
  you add it. Each MCP server card also gained an info tooltip explaining what it's for.
- **Build the Overview from a document.** Upload (or drag in) a Word/PDF/Markdown/spreadsheet
  file on the Overview page and it's converted to Markdown in your browser for review before you
  save it as the project intro.

### Changed

- **History is grouped by ticket.** Runs now fold into collapsible ticket cards showing the real
  ticket title, a link back to ClickUp, an aggregate pass/fail bar, and a run count — with
  Expand all / Collapse all. Much easier to find a ticket's runs than the old flat table.
- **Cleaner Run page.** The form is now three clear steps (What to test → Where to run →
  Options), with skill/model/instructions folded into a collapsible Options section. The model
  default is now **Sonnet** (the all-round pick; Opus for tricky tickets, Haiku for small ones),
  and the chosen mode is kept in the URL so a run link is shareable and survives reload.
- **Redesigned run result.** The result summary leads with a pass-rate donut and a clear
  "Ready for sign-off / Needs attention / Review required" headline; each tab is now linkable
  (back/forward and bookmarks work).
- **Terminal drops you straight into Claude.** Connecting on the Terminal page now launches a
  `claude` session in the project folder instead of a bare shell, and the terminal fills the
  window. The "Continue session" panel on a run starts collapsed.
- **Navigation tidy-up.** New app logo, the home page moved to `/qc-run`, the old "Settings"
  sidebar item is now **Templates**, and project/model settings live under a new **Settings**
  entry. First launch with no projects shows a "Create a project to get started" screen.
- **Richer new-project scaffold.** Brand-new projects get a fill-in-the-blanks `CLAUDE.md`
  (Overview / Architecture / How to test / Conventions / Safety) instead of a near-empty file.

### Fixed

- **Claude usage no longer stalls or flickers.** The model-usage reading is cached and refreshed
  in the background, falling back to the last good value (marked stale) instead of re-spawning a
  slow process on every view.
- **Report tables stay readable.** Wide report tables now keep fixed columns and scroll
  horizontally instead of collapsing to one character per line or running off-screen.
- **Native-app runs no longer demand an App URL** and show a readable label in history.

## 0.7.0 — 2026-06-30

**Access keys, instant project setup & a cleaner look**

### Added

- **See and copy a project's Source Code access key.** The Source Code page now shows which
  auth method is in use and a masked preview of the stored token (e.g. `****1234`), with a
  one-click **Copy** button to put the full token on your clipboard when you need it elsewhere.
  The token is still never written to the database, the git remote, or any log.
- **New projects are set up for you automatically.** Creating a project now scaffolds its
  `CLAUDE.md`, the `qc-testing` skill, and a `.mcp.json` right away (copied from your template
  project when you have one, otherwise from sensible starters) — so a brand-new project is ready
  to run without a separate "initialize" step. The create response reports what was created.

### Changed

- **Refreshed input fields across the app.** Search, filter, and URL boxes — on Tickets, Test
  Cases, Run, History, Skills, Design Check, Diagrams/Overview, and the in-app docs — now use the
  rounded "pill" style of the System-Style UI, with larger search icons and a consistent focus ring.

## 0.6.9 — 2026-06-30

**Documented the release process**

### Changed

- Internal/contributor only: `CLAUDE.md` now spells out the step-by-step release process
  (version bump → changelog → commit → tag → push). No user-facing change.

## 0.6.8 — 2026-06-30

**Last console-window flash on Windows**

### Fixed

- **Starting the portal no longer flashes a console window when it opens your browser** on
  Windows. The launcher used `cmd /c start` to open the browser without hiding its console.
  Completes the Windows window-flash sweep from 0.6.7 — every background subprocess the portal
  spawns now runs hidden (the in-app Terminal and the "Open folder" Explorer windows are
  intentional and unchanged).

## 0.6.7 — 2026-06-30

**No more console windows popping up on Windows**

### Fixed

- **Checking for updates no longer flashes a terminal window on Windows.** The version check
  runs `git` a few times in the background, but those calls didn't suppress the console window —
  so each one popped open briefly. They now run hidden.
- Same fix applied to the other background subprocesses that could flash a window: **Source Code**
  git clone/sync and opening the **MCP OAuth** browser page.

## 0.6.6 — 2026-06-30

**Fix QC runs stuck at intake on Windows**

### Fixed

- **QC runs on Windows no longer start by asking for the ticket and App URL they were already
  given** (then finishing with `0 pass, 0 fail of 0 ACs`). The run prompt is multi-line, and on
  Windows `claude` is a `.cmd` batch shim — passing a multi-line string as a command-line argument
  let `cmd.exe` truncate it at the first newline, so only the opening "run a QC test" line reached
  the model and the ticket ID, App URL, and instructions were silently dropped. The QC-run prompt
  is now delivered over **stdin** (same fix as 0.6.5 for the other AI steps), so the model receives
  it intact.

## 0.6.5 — 2026-06-30

**Fix `spawn ENAMETOOLONG` on Windows**

### Fixed

- **Test-case generation (and the other AI steps) no longer crash with `spawn ENAMETOOLONG`
  on Windows.** The full prompt — which embeds the whole ticket, project Knowledge/Memory, and
  instructions — was passed as a command-line argument. Windows caps the entire command line at
  ~32 KB, so a large ticket (e.g. 23K+ characters) overflowed it and the run failed immediately
  with `0/1 succeeded`. The prompt is now delivered to the Claude CLI over **stdin** instead, so
  prompt size no longer touches the OS argument limit. The same fix covers crawl summaries,
  Design Check, grounding checks, auto-learn, and the MCP capability test.

## 0.6.4 — 2026-06-30

**Sidebar scrolls on short screens**

### Fixed

- **The sidebar now scrolls when the window is too short to fit every nav item.** On small
  screens the navigation list overflowed past the version footer with no way to reach the
  lower links. The nav area is now a scrollable region while the brand header, workspace
  switcher, and footer stay pinned in place.

## 0.6.3 — 2026-06-30

**`--update` no longer gets stuck**

A fix for `qc-portal --update` silently staying on the old version.

### Fixed

- **`qc-portal --update` now always advances to the latest version.** It previously ran
  `git pull --ff-only`, which aborts the moment any tracked file is locally modified — and
  `npm install` routinely rewrites the tracked `package-lock.json` (different npm version /
  platform-specific optional dependencies, especially on Windows). That dirty lockfile blocked
  every subsequent update. Update now does `git fetch` + `git reset --hard` to the upstream
  branch, discarding such local edits so the update always lands.

## 0.6.2 — 2026-06-30

**More thorough test cases**

A quality fix for test-case generation so it covers the whole ticket instead of stopping early.

### Changed

- **Generated test cases now cover every area a ticket spans.** The model is told to be
  exhaustive rather than representative — it takes stock of each feature, trigger, screen,
  and role the ticket touches and writes cases for all of them, instead of sampling the first
  few. Each area still gets happy paths, edge cases, validation/negative cases, and error states.
- **Reading is time-boxed so writing isn't cut short.** Generation now reads only the handful of
  most-relevant source files up front, then spends the rest of its budget writing cases. The
  wall-clock budget was raised (12 → 14 min) so a nearly-complete set finishes instead of being
  truncated.

## 0.6.1 — 2026-06-29

**Cleaner CSV test cases**

A reliability fix for test-case generation against CSV templates.

### Fixed

- **Generated CSV test cases no longer start with stray AI prose.** The model sometimes
  prefixed a sentence (e.g. "Let me write the complete test case CSV.") before the header
  row; that line was saved verbatim, corrupting the file on spreadsheet import. The output
  is now cleaned so it always starts with the template's real header row.

### Changed

- Test-case generation does a quicker, more focused source scan and gets more time/budget
  to finish writing the full set of cases.

## 0.6.0 — 2026-06-29

**Project knowledge, self-checking AI & in-app docs**

Give each project a memory, let the AI ground its work in it (and check itself for
hallucination), pull in your source repo, and learn the whole portal from a built-in manual.

### Added

- **Knowledge & Memory** — a new context hub on the **Instructions** page: upload project
  docs (Word, PDF, Markdown, CSV, Excel — converted in the browser) as **Knowledge**, and
  jot durable facts as **Memory** notes. Both are stored per project under `testing/`.
- **Project context feeds the AI** — test-case generation now injects your Knowledge +
  Memory straight into the prompt, so the AI uses your real screen/field names, roles, and
  business rules instead of guessing; QC runs read them too.
- **Test cases & runs read your source code** — test-case generation and QC runs now open
  the project's repository and read the real implementation of the feature (true field names,
  validation, states, roles, edge cases) before drafting or testing, so the output matches the
  actual app — not just the ticket. Read-only; the repo is never modified.
- **Grounding check (anti-hallucination)** — after the AI writes test cases or a QC report,
  an independent, cheap second pass audits it and silently corrects invented content: cases
  not supported by the ticket or your knowledge are dropped/fixed, and any unverified "Pass"
  in a report is downgraded. Best-effort — it never blocks the run.
- **AI auto-capture (auto-learn)** — after a run or generation, the portal can save durable
  facts it learned into Memory/Knowledge, flagged with an **AI** badge you can review or edit.
- **Per-project AI controls** — **Settings → Models** now has an *AI automation* card to turn
  the grounding check and auto-learn on/off and pick their model, per project.
- **Source Code page** — clone, adopt, or pull a GitHub/Bitbucket repo for a project as a
  background job; access tokens are kept in a protected on-disk store, never in git or logs.
- **Documentation page** — a built-in user manual (sidebar footer, below Release notes) with
  one page per topic, a searchable nav, and prev/next — covering the whole portal.
- **Generate from ClickUp** — draft a project Overview from crawled tickets and docs with AI.

### Changed

- **Instructions page** is now a three-tab hub — `CLAUDE.md` + Knowledge + Memory — with a
  managed pointer block that keeps `CLAUDE.md` lean while still surfacing the split-out context.

## 0.5.0 — 2026-06-25

**Terminal, live sessions & background Design Checks**

Drop into a real shell, keep a finished run's conversation going, and watch design
checks run in the background.

### Added

- **Terminal page** — a real pseudo-terminal in the browser (xterm.js + node-pty),
  opened in the active project's folder, so interactive TUIs like `claude` just work.
- **Continue session** — a QC run's Claude session now stays alive after the report is
  written; resume it in an interactive terminal right from the run detail page.
- **Instructions page** — view and edit the active project's `CLAUDE.md` without leaving
  the portal, with a rendered Markdown preview.

### Changed

- **Design Check now runs as a background job** — kick off a verify and it keeps running
  even if you reload or navigate away, with a live log and a notification when it lands.
  Past checks are persisted per project.

## 0.4.0 — 2026-06-23

**Release Notes & update checks**

Read what changed without leaving the app, and find out when a newer build is available.

### Added

- **Release Notes page** — click the version in the sidebar footer to read what changed
  across releases, rendered straight from this changelog.
- **Sidebar update check** — the footer now fetches upstream and tells you when
  `qc-portal --update` would pull a newer build, with an amber "update available" badge.
- **Design Check checklist templates** — save a standard Design Check checklist per project
  (`testing/templates/design-check.md`); the verifier reports a finding for every item.

### Changed

- Crawl and test-case model pickers now share one component and remember your last choice
  per machine.

### Fixed

- Crawled-ticket delete dialog now warns when removing a folder that has saved test cases.

## 0.3.0 — 2026-05-30

**Design Check, project diagrams & notifications**

Verify designs against Figma, see your project at a glance, and never miss a finished job.

### Added

- **Design Check page** — pick a crawled ticket, paste its Figma link, and get findings
  bucketed into match / mismatch / concern / unsure / discuss.
- **Project diagram on Overview** — an AI-generated Mermaid `flowchart` you can edit inline,
  persisted per project.
- **Notifications** — a global bell + history page; background jobs announce completion even
  when the originating page is unmounted.

### Changed

- Tickets list groups by ClickUp status under sticky, color-tinted headers.

### Fixed

- Background jobs (crawl + test-case generation) now survive browser reload and navigation.

## 0.2.0 — 2026-05-09

**Crawling & test-case generation**

Pull tickets from ClickUp and let Claude draft manual test cases from them.

### Added

- **Test-case generation** — pick up to five crawled tickets and have Claude draft versioned
  manual test cases (`testcases/v<N>.md`) with template + rules support and a preview dialog.
- **Ticket crawling** — download a ClickUp ticket's description, comments, `ticket.json`, and
  attachments into `testing/tickets/`, with an optional per-ticket AI summary.
- **Open folder** buttons that reveal a project's on-disk folder in Finder / Explorer.

### Changed

- Multi-project support: register projects and switch the active one from the sidebar.

## 0.1.0 — 2026-04-18

**First packaged release**

A local web UI that runs the `qc-testing` Claude Code skill from the browser.

### Added

- **QC runs** — launch the `qc-testing` skill headless and watch phase/log events stream
  live over WebSocket, with run history and detail views.
- **Skills & MCP management** — edit each project's `.claude/skills` and `.mcp.json`.
- **One-command install & update** — the `qc-portal` CLI to start/stop/restart the server
  and `qc-portal --update` to git-pull, reinstall, rebuild, and restart.

### Platform

- Cross-platform (macOS + Windows): no `cmd` window flash when spawning Claude, and a fix
  for `spawn claude ENOENT` on Windows.
