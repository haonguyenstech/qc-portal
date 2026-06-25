# Release Notes

All notable changes to **QC Portal** are recorded here. The version shown in the
sidebar footer matches the `version` in the repo root `package.json`.

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
