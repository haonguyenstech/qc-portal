# Release Notes

All notable changes to **QC Portal** are recorded here. The version shown in the
sidebar footer matches the `version` in the repo root `package.json`.

## 0.9.31 — 2026-07-20

**Copy now puts the real token on the clipboard, not the masked one**

### Fixed

- **Copying a secret from MCP "View details" copied the mask (`••••9B6B`) instead of the real value.**
  The copy button now always fetches and copies the full value, whether or not you've clicked Reveal —
  so copying an API token or PAT gives you the actual token. Copying the whole `.mcp.json` entry
  likewise yields a usable config with real secret values.

## 0.9.30 — 2026-07-20

**Only real secrets are masked in MCP config**

### Changed

- **MCP settings now mask only actual secrets.** Non-secret values — a Jira **site URL** and **account
  email**, an Azure **organization URL** and **default project** — are shown in full instead of being
  masked to something like `••••.net`. Only true secrets (API tokens, keys, and the Azure PAT) stay
  masked with a **Reveal** toggle. This applies on the connected card, in the "View details" dialog, and
  in the raw `.mcp.json` preview.

## 0.9.29 — 2026-07-20

**MCP "View details" now reads like the connect form**

### Changed

- **The MCP details dialog shows your fields with friendly names.** Instead of raw shell variable names,
  the "View details" dialog now labels each setting the way the connect form does — e.g. Azure DevOps
  shows **Organization URL**, **Default project**, and **Personal Access Token** (its fixed internal
  auth-method flag is hidden from the list but still visible in the raw `.mcp.json` entry). Every value
  has a one-click **copy** button, and the **Reveal** toggle still unmasks secrets on demand.

## 0.9.28 — 2026-07-20

**Fix the MCP "View details" dialog spilling outside its box**

### Fixed

- **The MCP server details dialog no longer overflows.** With a long command or `.mcp.json` block (e.g.
  ClickUp's `uvx --from git+https://…` line), the dialog's rows and JSON preview spilled past the white
  panel onto the page behind it. The content is now constrained to the dialog — long values truncate,
  and the `.mcp.json` preview scrolls inside its own box — with the dialog scrolling vertically if it's
  tall.

## 0.9.27 — 2026-07-20

**See a connected MCP server's full configuration**

### Added

- **"View details" on every connected MCP server.** Each connected card (ClickUp, Figma, Jira, Azure
  DevOps, Playwright, Mobile) now has a **View details** button that opens a dialog showing the server's
  complete configuration from `.mcp.json` — its transport, the exact command + arguments (or URL), and
  **all** of its environment variables, not just the one masked key shown on the card. Secrets stay
  masked by default; a **Reveal** toggle shows the real values on demand (localhost only, never logged),
  and everything — each value and the whole `.mcp.json` entry — is one click to copy.

## 0.9.26 — 2026-07-20

**"Update now" no longer gets stuck on the loading page (Windows)**

### Fixed

- **The in-app "Update now" could hang forever on a spinning page on Windows.** After the update
  rebuilt and restarted the server, the page sometimes reloaded at the wrong moment — onto the old
  server as it was being shut down, or onto one still mid-restart — and got stuck loading. The portal
  now waits until the server comes back as a genuinely **restarted** process (reporting the new
  version, or confirmed to have gone down and returned), double-checks it twice, and only **then**
  reloads. Every "is it back yet?" check now also has a hard timeout, so a stalled connection during
  the restart can't freeze the wait. If the server genuinely doesn't return in time you'll get the
  clear "Update timed out" message (pointing at `data/update.log`) instead of an endless spinner.

## 0.9.25 — 2026-07-20

**Crawl tickets from Azure DevOps Boards**

### Added

- **Azure DevOps is now a ticket source on the Tickets page.** Once you connect Azure DevOps on the
  MCP page, the **Tickets** page can browse, search, and **crawl** your Boards work items — bugs, user
  stories, and tasks — just like ClickUp and Jira. Each crawled work item's description, **repro steps**,
  **acceptance criteria**, comments, and attachments download into \`testing/tickets/\` so the QC skill,
  test-case generation, and Design Check can read them locally. When more than one tracker is connected,
  a source toggle (ClickUp / Jira / Azure DevOps) appears above the ticket list.
  - **Pick a project fast.** If you set a **default project** when connecting, the picker uses it and the
    PAT only needs Work-Items read. Leave it empty to choose from all projects (that needs the PAT's
    *Project and Team → Read* scope). The **Getting API tokens** doc page spells out the exact scopes.

## 0.9.24 — 2026-07-17

**Connect Azure DevOps Boards, and QC screenshots now show inline on ClickUp cards**

### Added

- **Azure DevOps Boards is now a connectable MCP server.** On the **MCP** page you can connect Azure
  DevOps with your **organization URL** and a **Personal Access Token** (plus an optional default
  project) — the same paste-a-token flow as Jira. Once connected, QC runs and test-case work can read
  bugs, user stories, and tasks straight from your Boards. The step-by-step token guide (how to create
  the PAT and which scope to grant) is on the in-app **Getting API tokens** doc page.

### Changed

- **QC bug screenshots now appear inline on the ClickUp card.** When the portal files a QC issue as a
  ClickUp subtask, it uploads the run's screenshots and posts them as an inline **QC evidence** comment,
  so the images show right in the card's thread instead of as a dead local path. Best-effort — a failed
  upload or comment never blocks creating the subtask.

## 0.9.23 — 2026-07-17

**Faster MCP status, a run guard for missing browser MCP, and Prototype polish**

### Added

- **Web runs won't start without their browser MCP.** A web test drives a real browser through the
  **Playwright** MCP server (mobile targets use **Mobile MCP**). If that server isn't set up for the
  active project, the Run page now disables **Start**, adds a **Browser MCP** row to the readiness
  checklist, and shows a clear message pointing you to the MCP page — so a run can no longer fail deep
  inside Claude just because the browser was never configured.

### Changed

- **MCP page checks status faster.** The server list now appears instantly and each server's live
  connection status fills in right after, instead of the whole page waiting on the health probe. Behind
  the scenes the Claude health check and the ClickUp token check run at the same time (not one after the
  other), and a stuck server can no longer hold the check up as long. What gets checked is unchanged —
  it's just quicker and no longer blocks the page.

### Fixed

- **Prototype builder polish.** New prototypes are auto-named *Prototype 1, 2, 3…*; the list shows each
  one's created time and is more compact; the settings dialog is wider with a roomier name field; the
  model picker explains each model and defaults to **Sonnet**. The chat can now float as a bubble in the
  bottom-right corner (the default) or dock beside the preview, with smooth open/close animation and the
  Prototypes list tucked alongside it. While building, an animated 3D "building" loader with rotating
  status text replaces the plain spinner, and the empty-state onboarding text is no longer clipped in the
  smaller floating chat.

## 0.9.22 — 2026-07-16

**Prototype builder — describe a screen and watch Claude build the UI**

### Added

- **New Prototype page (under Tools).** Describe a screen in plain language and Claude builds a working
  HTML/CSS mock-up you can see immediately — then keep chatting to refine it ("make the header sticky",
  "add a pricing table"). Each prototype is saved per project, so you can come back to it, and you can
  duplicate, rename, or delete one from its **settings** dialog.
- **Watch it build in real time.** The generated code streams in live with an elapsed-time readout and a
  **Stop** button, and you can expand the **Claude logs** panel to see what it's doing. A skeleton +
  overlay shows while it's building or updating so the old preview never looks broken mid-change.
- **Start settings for a fresh build.** On the first message you can pick a **design style** (with visual
  preview thumbnails — clean, modern SaaS, glassmorphism, brutalist, playful, corporate, elegant),
  a light/dark **theme**, and an **accent colour**, so the very first draft already looks the way you want.
  Claude is also instructed to always produce a polished, fully responsive layout that never breaks on
  small screens.
- **Preview like a real device.** The preview toolbar lets you view the design at **Desktop, Laptop,
  Tablet, or Mobile** widths — tablet and phone render inside a device frame you can **rotate between
  portrait and landscape**. Each control has a hover tooltip explaining what it does.
- **Capture & copy.** On the Preview tab, a **camera** button copies a PNG snapshot of the rendered
  design to your clipboard; on the Code tab, a **copy** button copies the full HTML. You can also open
  the prototype in a new browser tab.
- **Attach images to guide the design.** Drag-and-drop (or paste) reference images into the chat and
  Claude uses them when building the UI.

### Changed

- **API Testing — reusable environments & response capture.** Save multiple named environments (e.g.
  Local / Staging) with their own base URL and variables, reference them anywhere with `{{variable}}`,
  and **capture a value straight from a response** into a variable to reuse in later requests. Values you
  mark **secret** are stored on the server and masked in the UI.

### Fixed

- **API Testing request bugs.** Duplicate request headers and `Set-Cookie` responses are now handled
  correctly, and a redundant save that could show a stale "AI" badge was removed.

## 0.9.21 — 2026-07-15

**Tell Claude your environments & test accounts — no more `<System account>` placeholders**

### Added

- **New "Accounts" tab on the Instructions page.** Keep your app URLs and test-account logins for
  the project in one place: upload a CSV/Excel sheet (converted to a table right in your browser) or
  type it in by hand. A **Download example** button hands you a ready-to-fill template so you know the
  exact columns — Environment, URL, Role, Username, Password, Notes.
- **Claude now logs in with your real accounts.** When a test case says "log in as …" — or a QC run
  needs to reach the app — Claude uses the exact environment URL and test account from your sheet
  instead of inventing a placeholder. This works for both test-case generation and full QC runs
  (the sheet is fed into generation directly, and QC runs are pointed at it and told to use it).
  Runs pick it up the next time they start after you save.

### Changed

- **Use non-production accounts only.** The sheet is stored as plain text in the project
  (`testing/environments.md`) and read by Claude, so the tab shows a clear warning: put only
  throwaway QA/staging test accounts there — never real user or production credentials.

## 0.9.20 — 2026-07-15

**Project import no longer fails with "a .zip file is required" on Windows**

### Fixed

- **Importing a project now works reliably, including on Windows.** Import used to bundle the whole
  zip into a text-encoded request, which for a real project (crawled ticket attachments + evidence)
  could quietly arrive empty and fail with *"a .zip file is required"* even though a valid file was
  chosen. The zip is now uploaded directly as-is, so large projects import dependably. The dialog
  also refuses an empty/0-byte file up front with a clear message, and any server-side error now
  comes back as readable text instead of a raw error page.

## 0.9.19 — 2026-07-15

**Cleaner ClickUp issue cards with real screenshots, clickable evidence on the Issues tab, and reliable project import**

### Added

- **Screenshots on the Issues tab are now clickable.** Any `screenshots/…png` reference in a run's
  Issues tab opens a preview dialog with the actual image, the same way the Report tab already worked —
  no more hunting for the file on disk.

### Changed

- **ClickUp issue subtasks are tidier and carry the actual screenshot.** When you push QC issues to
  ClickUp, each subtask no longer repeats its own title inside the description or restates the
  acceptance-criteria line, and the "Screenshot: …" text path is now uploaded as a **real image
  attachment** on the card instead of a dead local path. Attaching is best-effort — if an image is
  missing the subtask is still created.

### Fixed

- **Importing a project no longer fails for real projects.** A project export can be large (crawled
  ticket attachments and evidence), and import was rejecting anything over ~37 MB with a raw server
  error page. Import now accepts large project zips, and any remaining error comes back as a clear,
  readable message instead of a wall of HTML.

## 0.9.18 — 2026-07-13

**New API Testing page, plus reports render cleanly instead of leaking raw HTML**

### Added

- **API Testing page (sidebar → Testing → API Testing).** Send any HTTP request from the portal and
  keep the result as evidence — no external tool needed. Paste a **cURL** command straight from your
  browser's DevTools or an app and it fills in the method, URL, query params, headers, and body for
  you (and you can copy the request back out as cURL). Saved requests live per project: they
  **auto-save on any change**, rename with the pencil icon, and ask before deleting.
- **Rule-based assertions.** Add checks — status is 2xx / equals, body contains / matches, JSON path
  equals / exists, header equals / exists, response time under N ms — with quick-add presets, and see
  a pass/total bar with each row coloured green or red after every Send.
- **Automatic QC & security scan.** Every response is graded for common issues — plain HTTP, missing
  security headers (HSTS, nosniff, CSP, clickjacking), permissive CORS, server/version disclosure,
  insecure cookies, leaked stack traces / SQL errors / secrets / PII, wrong or missing Content-Type,
  slow or oversized responses — bucketed high / warning / info.
- **AI check against plain-language expectations.** Type what the response *should* do (or pick from
  quick-select criteria chips) and the AI verdict — pass / partial / fail with per-point reasons and
  flagged issues — runs **automatically right after each Send** when an expectation is set.
- **Result history.** Every Send on a saved request is stored under `testing/api-tests/` (newest 30
  kept) so you have a trail of what you tested and what came back.

### Fixed

- **QC run reports no longer show a wall of raw HTML at the top.** Some reports opened with a literal
  `<style>` block and raw `<table>` markup printed as text, because the report viewer renders
  Markdown, not HTML. The report prompt now requires pure GitHub-Flavored Markdown — markdown pipe
  tables and `![](image)` links — so every table and screenshot renders instead of leaking as source.

## 0.9.17 — 2026-07-13

**Generated CSV test cases no longer shift values into the wrong columns**

### Fixed

- **A test case with a comma in a short field no longer pushes its Steps and Expected result into
  the Actual result and Priority columns.** When a single-line field — most often a Pre-condition
  like `Services of different modalities exist (e.g. X-Ray, CT, MRI)` — contained a comma and wasn't
  wrapped in quotes, that comma split the field and shoved every later value one or more columns to
  the right, so columns that should stay blank on a fresh sheet (Actual result, Priority) ended up
  holding the real steps and expected results. The test-case generation prompt now treats quoting
  every free-text column as an absolute rule on every row — including the short single-line values
  that are the usual culprit — and self-checks each row before finishing (a non-blank Actual result
  or Priority is the tell-tale sign of a dropped quote). The portal already flags any remaining
  shifted rows by ID in the generation log so you can spot-fix or regenerate.

## 0.9.16 — 2026-07-13

**Report results are always shown, correctly counted, and in sync between History and the run detail**

### Changed

- **Every report now opens with the same three sections — Test Suite Executed, Covered Flow, and
  Execution Summary — on every run, even a blocked or failed one.** QC reports used to vary in shape,
  which made them hard to scan and hard for the portal to total up reliably. The report format is now
  a fixed contract: a "what was tested" header, a flow-coverage table, and a summary table whose
  percentages add up to 100% with a Pass Rate and Completion Rate. The Execution Summary now lists
  **Blocked** and **Not Tested** as separate rows (never merged), so each bucket is reported on its own.

### Fixed

- **The "Test execution results" table now appears for any ticket that has generated test cases.**
  Previously it only showed when the test-case sheet already carried execution columns (Status /
  Actual result / …); a sheet without them, or a run where the per-case verdicts couldn't be
  determined, produced no table at all on some machines. The portal now adds the standard execution
  columns itself and always writes the executed sheet, so the table is consistently there to review.
- **Run History counts now match the run detail exactly.** History used to fold Blocked cases into
  "Failed", so a run showing 4 failed / 60 blocked on its detail page appeared as 64 failed in the
  list. History now shows the full breakdown — Passed · Failed · Blocked · Untested · Cancelled —
  bucket-for-bucket identical to the detail page, and older runs reconcile themselves automatically
  the first time they're listed or opened.
- **Pass rate and totals are computed over the whole suite.** The acceptance-criteria total now
  reconciles with the report's own Total row (Blocked and Not Tested are counted, not dropped), so
  the headline percentage reflects how much of everything planned actually passed.

## 0.9.15 — 2026-07-08

**Windows: canceling a run no longer leaves runs piling up on top of each other**

### Fixed

- **On Windows, stopping (or pausing) a QC run now fully shuts down its test browser and helpers —
  so the next run doesn't start while the old one is still going.** Each run launches Claude, which
  in turn opens the Playwright/Edge test browser and its MCP helpers. On Windows the portal was only
  closing the outer command-window wrapper on cancel, leaving the real Claude process and its browser
  running in the background. Because that leftover work never registered as "finished", newly started
  tickets stopped waiting their turn in the queue and ran at the same time — the runs appeared to
  execute in parallel instead of one at a time (macOS was unaffected). The portal now terminates the
  whole process tree on Windows, so a canceled run leaves nothing behind and the one-at-a-time queue
  holds. The queue ordering itself was already correct; this was strictly a Windows process-cleanup
  problem.

## 0.9.14 — 2026-07-07

**Failed runs now tell you WHY, without digging through the log**

### Added

- **A plain-language "Why it failed" banner on failed test results.** When a run ends without a
  report — for example the Playwright/MCP test browser hung or dropped its connection, the portal
  server restarted mid-run, or the app URL couldn't be reached — the run page now shows the reason up
  front instead of a bare "check the log". It appears at the top of the run and inside the (otherwise
  empty) Report and Issues tabs, explains what went wrong in everyday terms, shows the exact error
  line pulled from the log, suggests what to try next, and gives you a one-click **View full log**.
  Recognized cases include the Playwright browser hanging/disconnecting, an MCP server not
  responding, network/connection errors, a server interruption, and unexpected exits.

## 0.9.13 — 2026-07-07

**Generated test cases show up right away — no manual reload**

### Fixed

- **New test-case versions now appear as soon as each ticket finishes.** After generating, the
  crawled-ticket "Test cases" badge and the version list refreshed only after the *whole* job fully
  settled — but the job stays busy for a few more seconds running the background "learn from these
  cases" step, even though the cases are already saved. That gap made it look like nothing happened
  until you reloaded the page. The Test cases page now refreshes the moment each ticket's version is
  written, so the new version shows immediately.

## 0.9.12 — 2026-07-07

**No more console window popping up when you update from the app**

### Fixed

- **Clicking "Update now" (or the update icon) no longer flashes a terminal window on Windows.**
  When the update was started from the portal UI, each step (git, npm install, build) opened its own
  console window because it had no terminal to attach to. The updater now runs those steps fully
  headless when there's no user terminal, so the update happens quietly in the background — the page
  still reloads on its own once the new version is live. Running `qc-portal --update` yourself in a
  Command Prompt still shows full progress as before.

## 0.9.11 — 2026-07-07

**Tidier "New folder" row in the Browse… picker**

### Fixed

- **The New-folder input no longer gets cramped.** When you click **New folder** in the picker, the
  name field now spans the full row and the **Create** / **Cancel** buttons always stay visible,
  instead of being squeezed next to the current path. (If you also see a small colored icon inside
  the field, that's a browser extension adding an "AI write" button — not part of QC Portal.)

## 0.9.10 — 2026-07-07

**Create a new folder right from the "Browse…" picker**

### Added

- **A "New folder" button in the folder picker.** When adding or editing a project, the **Browse…**
  picker now has a **New folder** button — type a name, hit **Create**, and the folder is made in the
  location you're browsing and selected for you, so you can register a fresh project folder without
  leaving the portal. Invalid names are sanitized and duplicates are rejected with a clear message.

## 0.9.9 — 2026-07-07

**"Browse…" now opens a folder picker inside the portal — no more spinning forever**

### Changed

- **The "Browse…" button when adding or editing a project now opens a folder picker _inside_ the
  page** instead of a Windows/macOS system dialog. Navigate your drives and folders (or type/paste a
  path) and click **Use this folder**. The old system dialog could only appear when the portal was
  running in your own signed-in desktop — so if the portal was started from a shortcut, at login, or
  any other way, **Browse…** would just spin forever with no window ever showing. The in-portal
  picker always works, however the portal was launched. The separate "In-app" button added in 0.9.8
  is gone — there's just one **Browse…** button again, and it's the reliable one.

## 0.9.8 — 2026-07-07

**In-app folder browser so "Browse" always works, plus an executed test-case record from each run**

### Added

- **A built-in folder browser for picking a project folder.** Next to **Browse…** on Add/Edit
  project there's now an **In-app** button that opens a folder browser *inside the portal* — navigate
  drives and folders, or type/paste a path, and click **Use this folder**. Unlike the native
  **Browse…** dialog (which needs the portal to be running in your own desktop session and can hang
  with nothing appearing when it isn't), the in-app browser works no matter how the portal was
  started — from a Command Prompt, at login, or remotely. Use it whenever **Browse…** doesn't pop a
  window.
- **An "executed" test-case sheet is written after every QC run.** When a run finishes, the portal
  clones the ticket's latest test-case file and fills in the execution columns — Actual result,
  Status, Reference, Note — from the run's report, saved alongside the report as
  `testcases-executed.<ext>`. You get a ready-to-file QC execution record without copying verdicts by
  hand. The steps, expected results, and priority are spliced through untouched, so the AI can't
  corrupt them; it's best-effort and never affects the run itself.

### Changed

- **Clearer live-run and run-detail views.** The running-run and run-detail pages were reworked for
  a cleaner read of progress, phases, evidence, and the final report.

### Fixed

- **The native "Browse…" folder picker no longer leaves you staring at a spinner.** If it can't open
  a window (for example when the portal was started outside your desktop session), use the new
  **In-app** browser next to it.

## 0.9.7 — 2026-07-06

**Fix: generated CSV test cases showing as raw run-on text instead of a table**

### Fixed

- **CSV test cases render as a table again.** In 0.9.6, when the AI prefixed a title line
  (e.g. `# Test Cases — …`) before the CSV, the version was mistakenly saved as Markdown and the
  preview showed it as one long run-on paragraph. A CSV template now always saves as real CSV — the
  stray title is stripped and the header row is used — so the preview shows a proper table with the
  pinned header row and first column. Regenerating a ticket produces a clean `.csv`, and any version
  already saved this way now renders as a table in the preview without regenerating.

## 0.9.6 — 2026-07-06

**Cleaner test-case & report formatting, project-scoped AI, and new projects that don't inherit another project's settings**

### Added

- **Test cases stay strictly on-project.** Test-case generation and QC runs are now told, in the
  prompt itself, to use only *this* project's context — its Knowledge, Memory, CLAUDE.md, and
  source code — and to ignore anything global (your machine-wide `~/.claude`) or belonging to
  another project. So one project's rules can't leak into another's cases or verdicts.

### Changed

- **Test-case steps are shorter and to the point.** The generator now writes terse, action-first
  steps and expected results that mirror your test-case template, instead of padding them with
  explanations ("because…", "per AC…"). Regenerate a ticket to get the tighter style.
- **Feature (advanced) run mode is marked "Coming soon."** On the Run page the advanced
  multi-ticket mode is temporarily disabled (shown with a "Soon" badge); single-ticket runs are
  unaffected.
- **Design Check moved below History** in the sidebar's Testing group.
- **New projects no longer inherit another project's CLAUDE.md or MCP servers.** A new project
  starts with a fresh fill-in-the-blanks `CLAUDE.md` and an empty `.mcp.json`, so you don't carry
  over an unrelated project's instructions or MCP configuration. (The QC skill and the test-case
  template — which are generic — still seed automatically.)

### Fixed

- **Test-case previews render as real tables again.** The `/templates` and `/testcases` previews
  now show Markdown (and CSV-in-Markdown) content as a formatted table instead of a wall of raw
  text, and the table keeps its **header row and first ("No") column pinned** while you scroll.
- **Generated CSV test cases keep their columns aligned.** Hardened the CSV rules so a comma inside
  a field (e.g. a Summary) can no longer shift every later value into the wrong column, added a
  check that flags any row that still slips, and made a version save/render in the format it was
  actually written in (so a CSV never renders as a collapsed run-on paragraph).
- **Run report tables auto-size their columns.** Report/issue tables on the Run page now size each
  column to its content (short columns stay narrow, long text wraps) and scroll horizontally when
  wide, instead of cramming everything into fixed-width columns.
- **Report & issue line breaks are preserved.** Each labeled field (Steps / Expected / Actual /
  Business impact) now renders on its own line instead of running together into one paragraph.
- **ClickUp subtasks created from QC issues are formatted properly.** The subtask description is now
  sent as rich Markdown (bold labels, numbered steps) with proper spacing between sections, instead
  of showing raw `**asterisks**` all on one line.

## 0.9.5 — 2026-07-02

**AI Brain visualization, correct pass rates on run reports, and a starter test-case template for new projects**

### Added

- **AI Brain tab on the Instructions page.** A new animated map (Instructions → AI Brain) shows
  the AI's working brain for the active project — a pulsing core wired to every Memory note,
  Knowledge doc, and repo Source map it reads on each run. Hover a node to highlight its
  connection and see its description; click to read the full content. AI-captured items carry a
  blinking blue dot. The map follows the app theme (light and dark), is built with lightweight
  SVG/CSS animation, freezes while a preview dialog is open, and respects the system
  reduced-motion setting — so it doesn't slow the app down.
- **New projects start with a test-case template.** Creating a project now seeds
  `testing/templates/testcase.md` automatically — copied from your existing project's template
  when one exists (so new projects match your current format), otherwise from a sensible default
  bundled with the portal. An existing template file is never overwritten.

### Fixed

- **Run pages no longer show a 0% pass rate for reports that count "Pass / Fail".** The run
  detail page only recognized summary rows labeled "Passed / Failed", so reports whose summary
  table used "✅ Pass / ❌ Fail" showed 0 passed and a 0% pass rate. Both spellings are now
  accepted, and a count is only read from a cell that is purely a number — so per-case table
  rows can't be mistaken for summary counts.
- **Stored pass/fail counts now match the report.** The server previously counted pass/fail-looking
  rows across the whole report (over-counting badly on reports with per-case tables); it now reads
  the report's own Result Summary table first, with the old row counting kept only as a fallback.
  Older runs self-heal: opening a run recomputes its stored counts from the report, so History
  matches too. Partial and Blocked still count toward the fail side.

## 0.9.4 — 2026-07-02

**Multiple source repos per project + AI source maps, App URL check, and a Windows MCP approval fix**

### Added

- **Connect multiple source repositories to one project.** The Source Code page is no longer
  limited to a single repo — connect several, each with its own tag (Backend, Frontend, Mobile,
  API, or your own label). Each repo clones into its own folder under `source/`, keeps its own
  access token, and gets its own card with Sync, Edit & reconnect, Disconnect, and Open folder.
  Test-case generation and QC runs are told about every tagged repo and pick the one relevant to
  the ticket. An existing single-repo connection migrates automatically on startup (tagged
  "Source") — no re-connect needed.
- **Source maps make AI runs faster and cheaper.** After a clone or sync that brings new commits,
  the portal runs one cheap AI pass over the repo and saves a compact map (screens, routes,
  domain models, where validation lives — with file paths) into Instructions → Knowledge as
  `source-map-<tag>.md`, flagged with the AI badge. Test-case generation and QC runs jump
  straight to the files it names instead of re-exploring the repo every time. A sync with no
  new commits keeps the existing map; disconnecting removes it; you can review, edit, or delete
  it like any knowledge doc.
- **"Check" button for the App URL on the Run page.** The server pings the URL and reports
  "Reachable · HTTP 200" or a plain-language error (host not found, connection refused, TLS
  problem, timeout) — so you know the staging site is live *before* launching a run. A login
  wall still counts as reachable.
- **Preview test cases right on the Run page.** An eye button next to the version picker opens
  a read-only preview of the selected test-case version — CSV rendered as a real table,
  Markdown rendered nicely — so you can see exactly what a run will verify against.
- **New docs: "Getting API tokens" and "Connecting source code".** Step-by-step guides for
  creating ClickUp, Figma, and Jira tokens (including the Jira scoped-token trap), and for
  GitHub/Bitbucket tokens used by the multi-repo flow. The MCP page links to the token guide
  from each service card, and Core Concepts gained a clickable "how a ticket flows through the
  portal" panel.
- **CSV templates preview as a table.** Uploaded CSV/Excel templates on the Templates page now
  render as a real table instead of raw text.

### Changed

- **"Change repository" is now "Edit & reconnect", prefilled.** The form reopens with the repo's
  URL, tag, branch, and saved credentials; leaving the token empty keeps the saved one, so
  changing a branch no longer means re-pasting a token. The token field gained show/hide and
  copy buttons.
- **One clone/sync at a time per project.** Starting a second git job while one is running is
  rejected, so concurrent operations can't step on each other. Repo tags must be unique within
  a project (they map to folders).
- **The AI sees more of your Knowledge and Memory.** The project-context budget doubled (16 KB →
  32 KB), memory notes are capped so they can't crowd out reference docs, source maps are packed
  first, and anything clipped for space now tells the model to open the full file — a large
  knowledge base no longer silently starves the AI of detail.

### Fixed

- **MCP servers stuck on "Pending approval" on Windows.** Claude Code keys its per-project
  config with forward-slash paths even on Windows, while the portal wrote back-slash paths — so
  approvals landed where the CLI never looked. The portal now uses the forward-slash key and
  cleans up the stale entry older versions left behind; Test connection works on Windows again.
- **A failed source-map pass can no longer lose the repo connection.** The connection is saved
  before the map is generated, so a timed-out AI pass leaves the clone intact.
- **The test-case version picker no longer collapses shorter than the ticket picker.**

## 0.9.3 — 2026-07-02

**Windows fixes: in-app update actually finishes, terminal paste, folder picker — plus new projects activate themselves**

### Fixed

- **The in-app "Update now" no longer gets stuck loading on Windows.** The updater used
  to be started as a child of the portal server — and its first step, stopping the server,
  killed its own process tree, taking the updater down with it. The update died silently
  and the page spun forever, forcing a manual `qc-portal --update` in a terminal. The
  updater (and the in-app Restart) is now launched outside the server's process tree, so
  it survives the stop and finishes the update on its own. Note: the very first update
  *onto* 0.9.3 still uses the old updater — if it hangs, run `qc-portal --update` once;
  every update after that works from the app.
- **Updating from the app no longer flashes command windows on Windows.** Each update step
  (git, npm install, build) used to pop its own console window. The whole update now runs
  invisibly — just the loading toast, then the page reloads on the new version.
- **A newly created project becomes the active project immediately.** Before, after "Add
  project" every page (MCP, Instructions, Tickets, Settings) kept showing the *previous*
  project's data until you clicked "Set active" yourself — which read as the new project
  showing someone else's data.
- **Paste works in the in-portal Terminal on Windows.** Ctrl+V used to print `^V` instead
  of pasting. Ctrl+V (and Ctrl+Shift+V) now paste, Ctrl+Shift+C copies the selection, and
  plain Ctrl+C still interrupts the running command — same as Windows Terminal. This also
  applies to the "Continue session" terminal on a run's detail page.
- **The "Browse…" folder picker is far more reliable on Windows.** The choose-folder
  dialog could open behind the browser and never get focus, leaving the button loading
  for minutes. The dialog now forces itself to the foreground for its first seconds, a
  stuck dialog gives up after 2 minutes (and actually closes) with a clear message, and
  the picker now starts in the suggested folder like it already did on macOS.

### Changed

- **Mobile test targets are marked "Coming soon".** On the Run page, *Web (mobile)* and
  *App (mobile)* are visible but not selectable yet; runs default to *Web*.

## 0.9.2 — 2026-07-02

**ClickUp/Jira connect even when the portal was launched with a stale PATH**

### Fixed

- **`uvx`-based MCP servers (ClickUp, Jira) no longer fail just because of how the portal
  was started.** A process only sees the `PATH` from the moment it was launched — so a
  portal started from an old terminal, a shortcut, or before `uv` was installed couldn't
  find `uvx`, and every ClickUp/Jira server showed **Failed to connect**, even though the
  same command worked fine in a fresh terminal. The portal now adds the standard per-user
  tool folders (`~/.local/bin`, `~/.cargo/bin`, and WinGet's links folder on Windows) to
  `PATH` for everything it launches — QC runs, MCP health checks, test-case generation,
  the in-app terminal, and the `uv` probe. A plain `"command": "uvx"` in `.mcp.json` now
  works on every machine; no more hand-editing absolute paths, no more "restart from a
  new terminal" dance.

## 0.9.1 — 2026-07-02

**Fix ClickUp "Failed to connect" caused by a renamed token variable**

### Fixed

- **ClickUp connects again on machines set up with the older token variable.** Newer
  versions of the ClickUp MCP server read the token from `CLICKUP_MCP_API_KEY` and ignore
  the older `CLICKUP_API_KEY`. A project connected a while ago (or on another PC) may only
  have the old name in `.mcp.json` — the server then crashes on startup and the MCP page
  shows **Failed to connect**, even though the exact same token works elsewhere. The portal
  now writes **both** variable names on every connect path (token paste *and* OAuth), so any
  server version starts. **Already hit by this?** Just Disconnect ClickUp and Connect again
  with your token — that rewrites the entry with both names.
- **Troubleshooting guide updated** with this exact failure (§1b: the
  `1 validation error for Config — api_key Field required` error and its fix), and the
  hand-test command now uses the current variable name.

## 0.9.0 — 2026-07-02

**Restart from the app, a heads-up when uv is missing & a Windows MCP fix**

### Added

- **Restart the portal from Settings.** A new **Restart app** card on the Settings page
  stops and relaunches the QC Portal server on your machine — handy after changing MCP
  servers or when something seems stuck. It asks for confirmation (in-flight runs and
  background jobs are interrupted), then the page reloads by itself once the server is
  healthy again. No new browser window pops — you keep the tab you're in.
- **The MCP page now warns when `uv` is missing.** ClickUp and Jira are Python MCP servers
  that run through `uvx` (Astral's `uv`). On a machine without `uv` they just show
  **failed**, which looks like a bad token but isn't. The MCP page now checks for `uv`
  up-front and shows an amber banner with the exact install command for your OS
  (copy button included). Install it, fully reopen the portal, and test again.
- **A troubleshooting guide.** The new [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
  (linked from the README) walks through the common MCP setup problems: ClickUp/Jira
  showing `failed` (install `uv`), an empty Jira ticket list (site-root `JIRA_URL` +
  *classic* API token), and the "conflicting scopes" warning.

### Fixed

- **Windows: MCP approval and local-scope servers work again.** The portal located your
  `~/.claude.json` through the `HOME` environment variable, which usually doesn't exist on
  Windows — so approving a "Pending approval" server from the Test connection button, and
  listing servers connected outside the portal, silently did nothing there. The portal now
  resolves your home folder the proper cross-platform way.

## 0.8.2 — 2026-07-01

**Jira tickets appear for the right project — plus a steadier Windows folder picker**

### Fixed

- **The ClickUp / Jira source switch now follows the project you're in.** After you
  connected Jira, the Tickets page still checked whether ClickUp and Jira were connected
  against the *default* project instead of the one selected in the sidebar. So the switch
  could stay hidden — or Jira could look "not connected" — even though you'd connected it on
  that project. It now checks the **active** project, so the **ClickUp | Jira** toggle shows
  whenever both trackers are connected there, and your Jira issues load straight away. (One
  gotcha worth knowing: Jira needs a *classic* API token — the plain "Create API token" button
  — not a "token with scopes"; a scoped token silently returns no issues.)
- **The "choose folder" dialog on Windows no longer hides behind other windows.** The native
  folder picker — used when importing a skill or pointing the portal at a folder — could open
  *behind* the browser, leaving the button spinning forever with no dialog in sight. It now
  opens in front, and if it ever gets wedged it times out cleanly with a clear message instead
  of hanging.

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
