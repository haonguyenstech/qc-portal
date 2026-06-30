# Release Notes

All notable changes to **QC Portal** are recorded here. The version shown in the
sidebar footer matches the `version` in the repo root `package.json`.

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
