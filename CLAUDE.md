# QC Portal — CLAUDE.md

A local web UI that lets QC engineers run the **`qc-testing`** Claude Code skill from the browser
instead of the command line — across **multiple projects** — and manage each project's skills and
MCP servers. It **wraps** Claude Code headless; it does **not** reimplement QC logic. The skill
stays the brain; the Portal is a launcher + viewer + editor around it.

See `SPEC.md` for the original design rationale and `README.md` for user-facing setup.

## Architecture

A standalone npm-workspaces monorepo with two parts, both running on the QC's own PC (localhost):

| Part | Stack | Port | Job |
|------|-------|------|-----|
| `web/` | React 19 + Vite 8 + Tailwind v4 + shadcn/ui (new-york) + React Query + React Router 7 | **5175** | UI only — forms, tables, live log, editors. Draws nothing on disk. |
| `server/` | Node 22.5+ + Express 4 + `ws` + `node:sqlite` | **5174** | Spawns `claude` headless, streams progress over WebSocket, reads/writes `.claude/skills` + `.mcp.json`, serves screenshots, stores run history. |

The Portal is **not** inside any project. You register **projects** (each an absolute path to a
repo folder) on the Settings → Projects page; the active project is chosen in the sidebar. Each QC
run spawns `claude` headless **in that project's folder**, so the project's `qc-testing` skill,
`CLAUDE.md`, `.mcp.json`, and `testing/` output are all in scope.

Two run mechanisms exist:
- **QC runs** (the `qc-testing` skill) — `Browser ──HTTP /api──► Express ──spawns──► claude -p (headless) ──stream-json──► phase/log events ──WebSocket /ws──► Browser`.
- **Background jobs** — both **ticket crawling** (`/tickets`) and **test-case generation** (`/testcases`) run as server-side in-memory jobs the browser **polls** over HTTP (no WebSocket). They survive browser reload / navigation, accumulate per-item status + a bounded log, and announce completion via an always-mounted watcher (`docs/architecture/testcase-generation.md`).

## Commands

Run from the repo root unless noted.

```bash
npm install                # install all workspaces
npm run dev                # server (5174) + web (5175) together, via concurrently
npm run build              # build web then compile server
npm run typecheck          # typecheck both workspaces

npm -w web run lint        # eslint the web workspace
npm -w web run dev         # web only
npm -w server run dev      # server only (tsx watch)
npm -w server start        # run compiled server (dist/index.js)
```

Open **http://localhost:5175**. The Vite dev server proxies `/api` and `/ws` → `127.0.0.1:5174`.

## Releasing

We ship by bumping a version, recording it in the changelog, and tagging the commit.
**The root `package.json` `version` is the single source of truth** — the sidebar footer
reads it (via `/api`, `routes/version.ts` → `readPkgVersion` of the repo-root `package.json`)
and the `## X.Y.Z` headers in `CHANGELOG.md` must match it. The `web/` and `server/`
workspace `package.json` versions are **not** bumped — leave them.

Pick the bump with semver intent: **patch** (`0.6.7 → 0.6.8`) for fixes / small tweaks,
**minor** (`0.6.x → 0.7.0`) for new user-facing features, **major** for breaking changes.
Recent history is patch-heavy fixes; default to patch unless a real feature landed.

Step by step, from a clean-ish tree on `main`:

1. **Finish the code change** and self-review the diff (`git diff`).
2. **Verify it compiles** — `npm run typecheck` (both workspaces). Run `npm run build` when
   the change touches the build/runtime (server or web app code); a non-trivial server change
   warrants `npm -w server run build`. (Note: `npm -w web run lint` currently reports
   pre-existing errors unrelated to most changes — don't let that block a release, but don't
   add new ones.)
3. **Bump `version`** in the **root** `package.json`.
4. **Add a `CHANGELOG.md` entry** at the top (newest first, directly under the intro), in this
   shape — a dated header, a bold one-line title, then `### Added` / `### Changed` / `### Fixed`
   subsections written for the QC engineer (what changed and why it matters, not the code):
   ```markdown
   ## 0.6.8 — 2026-06-30

   **Short human title**

   ### Fixed

   - **Lead sentence in bold.** Then the detail…
   ```
   Use today's date (`currentDate` in context). `ReleaseNotesPage` (`/releases`) renders this
   file verbatim, so keep it reader-facing.
5. **Commit** everything together with a `Release X.Y.Z — <title>` subject, a body explaining
   the root cause / rationale, and the repo's `Co-Authored-By` trailer.
6. **Tag** the commit `vX.Y.Z` (the `v` prefix matches existing tags).
7. **Push** the branch **and** the tag: `git push origin main && git push origin vX.Y.Z`.

End users upgrade with `qc-portal --update` (git fetch + hard-reset to the upstream branch,
then `npm install` + `npm run build`; see `bin/qc-portal.mjs`), or the **Release notes** page's
"check for updates" / "update now". So a release isn't usable until both the commit and the tag
are pushed.

## Layout

The **full annotated tree** — every module, what it does, and the traps in each — lives in
**`docs/architecture/layout.md`**. Read it before touching a server module you don't already know.
The shape:

```
server/src/
  index.ts          Express app + WebSocket hub wiring + graceful shutdown
  config.ts         env vars     db.ts  node:sqlite (projects/runs/events/sources, migrate on boot)
  claude.ts         headless claude launcher + stream-json parser (QC runs, over WebSocket)
  claudeExec.ts     shared one-shot helpers: runClaude / runClaudeStream / parseClaudeJsonResult
  runManager.ts     in-flight run lifecycle + which on-disk folder a run's output lives in
  hub.ts            WebSocket pub/sub by runId        terminal.ts  node-pty over /ws/terminal
  qcBrowser.ts      the portal-owned browser Playwright MCP attaches to over CDP
  playwrightRunMode.ts  per-RUN headless/headed browser choice (a per-run MCP config; never
                    rewrites the project's .mcp.json)
  autoAgent.ts      Auto Agent (shared Claude credential) status
  k6.ts pageAudit.ts perfJobs.ts   Performance page: k6 load tests + browser page-load
                    audits (+ their shared job registry). The generated k6 script and its
                    summary live BESIDE THE DB, never in a repo, and credentials reach k6
                    through the environment so they never touch that file. k6's summary
                    has NO time series, so the script buckets its own samples into a fixed
                    metric set (`timeBuckets`, shared by the generator and the parser) —
                    that is the only reason "did it degrade under load?" can be answered.
  authSession.ts reportExport.ts    Performance page: the "sign in first" window (a headed
                    Chrome on the audit's own profile — closing it is what saves the session)
                    and report export (the CLIENT's report HTML → PDF via headless Chrome,
                    → .docx via html-to-docx with each chart FIGURE — svg plus its
                    legend — rasterised first; an optional running footer goes on
                    EVERY page via Chrome's displayHeaderFooter / html-to-docx's
                    4th argument, and is stripped to plain text first).
  crawl.ts crawlJobs.ts            ticket crawling (+ in-memory job registry)
  testcaseGen.ts testcaseJobs.ts   test-case generation (+ in-memory job registry)
  sourceRepo.ts sourceJobs.ts sourceMap.ts   Source Code page: clone/sync + AI source map
  designSystem.ts   AI pass → testing/knowledge/design-system.md (Prototype page)
  projectArchive.ts streaming zip receive/extract for project import (never buffers the archive)
  projectContext.ts readProjectContext(root): memory + overview + knowledge → one capped
                    prompt block          contextPointer.ts  managed CLAUDE.md pointer block
  memoryStore.ts knowledgeStore.ts overviewDocs.ts notesStore.ts   testing/* storage primitives
  docReview.ts      "AI review & format" of an uploaded doc — refuses rather than degrades
  learn.ts          AI auto-capture after a run       groundingCheck.ts  anti-hallucination audit
  answerCheck.ts    free existsSync check of the paths a chat answer cited (every turn)
  answerAudit.ts    on-demand fact check of ONE chat answer by an independent cheap model
  totp.ts apiAccounts.ts   2FA seeds + API login accounts — stored BESIDE THE DB, never in a repo
  clickup.ts folderPicker.ts projectScope.ts toolPath.ts mobileDevices.ts
  routes/           projects, qc, files, skills, mcp, clickup, source, ai, templates,
                    knowledge, memory, notes, database, diagrams, prototype, chat,
                    performance, version

web/src/
  App.tsx           two branches: `/ai-labs` renders BARE, everything else via AppShell; the job
                    watchers sit in App above both so jobs still announce on the bare page
  main.tsx  index.css (Tailwind v4 oklch tokens, light + .dark)
  pages/ components/ components/ui/ (shadcn primitives)
  lib/  api.ts (ALL backend calls) types.ts project-context.tsx notifications.tsx theme.ts
        testRules.ts highlight.ts apiAssert.ts devices.ts sql-complete.ts noteHtml.ts
        utils.ts useRunStream.ts useXtermSession.ts
        perfReport.ts perfCharts.ts perfReportHtml.ts  (Performance: verdict bands, derived
        metrics (peak RPS, drift, phase shares) + MEASUREMENT_NOTES, the SVG charts —
        bars, lines and stacks, ONE y axis each — and the printable report. ONE source
        for screen, Markdown, PDF and Word)
        loadEndpoint.ts  (Performance: a pasted cURL or a saved API Testing request →
        one load-test endpoint. Query rows fold into the URL; {{variables}} survive
        encoding and are resolved SERVER-SIDE at run start, never in the browser)
        nfrReport.ts nfrReportHtml.ts  (Performance: the NFR deliverable — requirements
        judged across one or MORE runs, PASS/FAILED/MIXED/PERFORMANCE RISK/PENDING,
        rendered in the client report format. Paired with components/NfrReportPanel.tsx.
        8 of the 9 cover fields and the requirements themselves are DERIVED from the
        runs/project/machine — always as a fallback (`resolveMeta`), never written
        over what was typed, and `classifyEnvironment` never guesses "Production")
```

Four module-level rules that bite mid-edit, so they stay here:

- **`autoAgent.ts` reads `~/.auto-agent-ai/state.json` ONLY.** The sibling `.config.json` holds
  `auth.accessToken` and the distributed Claude credentials and must never be opened.
- **`parseClaudeJsonResult` must accept BOTH `--output-format json` shapes** — a single
  `{type:'result',result,is_error}` object (older CLI) and the whole message ARRAY ending in that
  object (current CLI). Reading `.result` off the array yields undefined, which all ~12 callers
  report as "the AI produced nothing". Don't narrow it back to one shape.
- **Every child spawn goes through `toolPath.ts` `spawnEnv()`** (PATH augmented with `~/.local/bin`,
  `~/.cargo/bin`, WinGet Links, bundled emulator adb) so uvx/npx MCP servers start under a stale
  PATH. Never spawn with a bare `{ ...process.env }`.
- **All file writes go through `projectScope.ts` path-guarding** so they can't escape the project root.

## Routing note

`/settings` renders `ProjectsPage.tsx` (the file name predates the rename). It has two tabs driven
by the `?tab=` query param: `?tab=projects` (default) and `?tab=models`. `/projects` redirects to
`/settings`. When editing "the settings page," edit `web/src/pages/ProjectsPage.tsx`. The `models` tab
holds `ClaudeUsageCard` + `AiRuntimeCard` (global) and `AiAutomationCard` (the active project's
per-project grounding-check / auto-learn toggles — see "Per-project control" in `docs/architecture/instructions-context.md`).

## Feature notes — read the file before touching the feature

Per-feature design notes live in **`docs/architecture/`**. They are not optional background: each
one records **why** the code is shaped the way it is, and the failures that were measured on screen
before it was. **Read the matching file before changing that area**, and update it in the same
commit when the behaviour changes.

| Working on | Read |
|------------|------|
| any server module you don't already know | `layout.md` — full annotated tree + per-module traps |
| an "Open folder" button on any page | `open-folder-buttons.md` |
| `/instructions`, Knowledge, Memory, grounding check, auto-learn, TOTP/2FA codes, how project context reaches the model | `instructions-context.md` |
| `/tickets` (crawl), `/overview` (overview documents), `/diagrams` | `tickets-and-overview.md` |
| `/testcases`, background jobs, notifications/watchers, spec upload | `testcase-generation.md` |
| `/api-testing` — saved requests, flows, per-step data/check overrides, "Run as" accounts, assertions | `api-testing.md` |
| `/performance` — k6 load tests, browser page-load audits, duplicate-API detection, the NFR report | `performance.md` |
| `/qc-run` — the E2E flow canvas, run output folders (`runs.outDirToken`), busy-ticket pruning, mobile device picking, filing issues to ClickUp | `runs.md` |
| `/verify` (Design Check) or project templates (`testing/templates`, bundled template sync) | `design-check-and-templates.md` |
| `/prototype` — builds, revisions, decisions ledger, design system, comment mode | `prototype.md` |
| `/chat` — sessions, streaming, `@`/`/` mentions, temporary chats, composer, follow-ups | `chat.md` |
| `/database` — read-only SQL console, SQL editor, Ask AI | `database.md` |
| `/notes` | `notes.md` |
| the sidebar/theme/app mark, or `/ai-labs` | `shell-and-ai-labs.md` |
| `/terminal` or Continue session (resume a run's session) | `terminal-and-sessions.md` |
| the portal-owned QC browser / Playwright attach mode | `qc-browser.md` |

## Conventions

**Data fetching** — TanStack Query everywhere. Reads use `useQuery({ queryKey: [...], queryFn })`;
keys are scoped by project, e.g. `['mcp', projectId]`, `['projects']`. Writes use `useMutation`
with `onSuccess`/`onError` that fire a `sonner` `toast` and `queryClient.invalidateQueries(...)` to
refresh. Never call `fetch` from a component — add a function to `lib/api.ts` and import it.

**Styling** — Tailwind v4 + shadcn/ui (new-york style, lucide icons, slate base) following the
**System-Style UI** design language (see its own section below — fonts, radii, borders, elevation,
pills). Use semantic tokens (`bg-primary`, `text-muted-foreground`, `border-border`, `bg-card`),
never raw hex. Status colors follow a fixed palette: emerald = ok/connected/ready, amber =
pending/warning, red/`destructive` = failed/error. Compose classes with `cn(...)`. Common interaction
polish: `transition-all duration-200 active:scale-[0.98]`, hover lift (`hover:-translate-y-0.5
hover:shadow-sm`), and `Loader2 className="animate-spin"` for pending states. Icons come from
`lucide-react`. The **`system-style-ui` project skill** (`.claude/skills/system-style-ui/`) carries
the full recipe and `McpPage.tsx` is the canonical reference implementation.

**Component shape** — pages are single files that define small local sub-components (e.g.
`ProjectCard`, `AiRuntimeCard`, `ConnectServices`, `StatTile`) above the default export. Follow that
pattern rather than splitting prematurely. Status/health is driven by **live** data (e.g. a `testMcp`
call), not just presence in config — keep that distinction.

**Server** — ES modules; relative imports use the compiled `.js` extension (e.g.
`from './db.js'`). Each resource is an Express router under `routes/` mounted in `index.ts`. All file
writes go through `projectScope.ts` path-guarding so they can't escape the project root.

## System-Style UI (design language)

The portal follows a **System-Style UI** inspired by Google's Antigravity site
(`antigravity.google`): clean, neutral, large-radius, hairline-bordered, flat surfaces over heavy
shadows. It is layered on top of the existing slate oklch token set — semantic tokens still apply;
this just fixes the *shape, weight, and elevation* vocabulary. The `system-style-ui` project skill
holds the actionable recipe; `web/src/pages/McpPage.tsx` is the canonical implementation.

- **Typography** — UI font `Google Sans Flex` → `Google Sans` → sans-serif; mono `Google Sans Code`.
  Loaded in `web/index.html` (one Google Fonts `<link>`) and wired to `--font-sans` / `--font-mono`
  in `web/src/index.css`. **The Flex `wght` axis is requested `300..700`** so `font-medium` (500),
  `font-semibold` (600), and `font-bold` (700) are *real* weights — narrowing it (e.g. `400..500`,
  which Antigravity itself ships) makes the browser synthesize faux-bold for `font-semibold`. Don't
  narrow it back. Headings use `font-semibold tracking-tight`.
- **Radii (large)** — primary surfaces/cards `rounded-3xl` (24px); secondary surfaces, context bars,
  and icon chips `rounded-2xl` / `rounded-xl` (16/12px); inline pills `rounded-xl`. **Buttons are
  fully rounded pills (`rounded-full`).**
- **Borders & elevation (flat)** — hairline, low-contrast borders: `border-border/60`, strengthening
  to `border-border` only on hover. No resting drop shadow (`shadow-none`); convey elevation with a
  tinted surface (`bg-muted/60`) plus a subtle hover lift (`hover:-translate-y-0.5 hover:shadow-sm`).
- **Marks** — icon badges are high-contrast solids (`rounded-2xl bg-foreground text-background`), not
  gradient chips. Reserve the blue accent (`#3279F9`-like) for sparing emphasis; default to neutral.

## Critical constraints

- **Localhost only.** Server binds `127.0.0.1`. No auth in this MVP — do not add network exposure.
- **Never log/persist secrets.** OTPs and credentials must not hit the log stream, DB, or disk.
- **The Database page must never be able to write.** `/database` runs SQL the AI wrote and
  nobody reviewed, so `server/src/dbQuery.ts` protects the DB in **layers, none of which may be
  removed on the assumption another one is enough**: (1) `assertReadOnly` — `sqlCodeOnly` strips
  comments and masks string/identifier CONTENTS first (nothing hides in a comment; ordinary
  literals like `status = 'update'` don't false-alarm), then one statement only, must start
  SELECT/WITH/SHOW/EXPLAIN, no write/DDL/side-effect keyword in the code; (2) **engine-level** —
  Postgres/MySQL open an explicit `READ ONLY` transaction and **fail closed** if the server
  won't, SQL Server (which has no read-only transaction, and whose `readOnlyIntent` is only an
  Always On routing hint that enforces NOTHING) wraps the statement in a transaction that is
  **always rolled back** — its DDL is transactional, so even a `DROP`/`CREATE` that got past
  layer 1 is undone; (3) row cap + statement timeout + password scrubbed from errors. Both the
  SQL editor and Ask AI funnel through `runReadQuery`, which re-validates — never add a path
  that reaches a driver without it.
  **A refusal is a `ReadOnlyViolation`, not a bare Error**, so `/query` and `/ask` can answer
  with a `blocked: {kind, keyword?, preview?}` alongside `error` and `DatabasePage` can draw
  `WriteBlockedDialog` instead of the inline red strip every other failure uses — "this would
  modify data" must not read as "the connection dropped, try again". A statement STARTING with
  a write verb reports `write-keyword` with that verb named, not the generic `not-select`.
  Ask AI refuses at the QUESTION (`write-intent`): the prompt's `REFUSE_WRITE:` / `PREVIEW:`
  protocol makes the model decline to draft the write and instead offer a SELECT showing the
  rows it would have hit — that preview goes through `assertReadOnly` like anything else and is
  offered to the user, never auto-run. **Confirming the dialog runs nothing**: there is no write
  path to confirm into, and adding one would undo the whole section above. A question *about*
  changed data ("how many were deleted last week?") is a normal SELECT — verified not to trip it.
- **Headless runs use `--permission-mode bypassPermissions`** so they never block on a prompt; the
  `qc-testing` skill itself forbids final mutating actions on shared environments. Don't weaken that.
- **Cross-platform (Win + Mac).** Use `cross-spawn`, `path.join`; never string-concat paths into a
  shell line. The repo path contains a space (`STS-Data /Project/...`) — always pass paths as args.
- **`node:sqlite` is experimental** — the warning is suppressed via `--disable-warning` in the npm
  scripts. Requires Node 22.5+ (tested on 23).
- **Never put a machine-specific path in the web bundle.** `web/` runs in a browser and cannot know
  whose machine the server is on, so any absolute path it writes into `.mcp.json` is the path of the
  machine the *code* was written on. `McpPage.tsx` used to hardcode a Playwright `--user-data-dir`
  (`/Users/hao.nguyen/.pw-agent-profile`), which shipped to every install and killed every browser
  call on Windows with `EPERM … mkdir 'C:\Users\hao.nguyen'`. Resolve such values **server-side**:
  `browserProfile.ts` `agentProfileDir()` owns the profile dir (shared with `scanJobs.ts`), the POST
  `/api/mcp` route fills it in, and `repairProjectMcpConfig()` (routes/mcp.ts — also run for every
  project at boot from `index.ts`) rewrites a foreign one already on disk. Maestro's `env` is
  resolved server-side for the same reason (see `POST /maestro/connect`).

## Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `QC_PORT` | `5174` | backend port |
| `QC_REPO_ROOT` | _(unset)_ | absolute path to auto-seed as the default project on first run only |
| `QC_CLAUDE_BIN` | `claude` | path to the Claude CLI |
| `QC_DB_PATH` | `data/qc-portal.db` | SQLite file (projects + run history persist here) |
| `QC_AUTO_LEARN` | `1` (on) | **default for new projects** — AI auto-captures memory/knowledge after runs (per-project toggle in Settings → Models) |
| `QC_AUTO_LEARN_MODEL` | `haiku` | default auto-learn model for new projects (`learn.ts`) |
| `QC_GROUNDING_CHECK` | `1` (on) | **default for new projects** — post-write audit auto-revises test cases/reports to drop hallucination (per-project toggle in Settings → Models) |
| `QC_GROUNDING_CHECK_MODEL` | `haiku` | default grounding-check model for new projects (`groundingCheck.ts`) |
| `QC_BROWSER_PORT` | `19222` | CDP port for the QC browser (deliberately not 9222 — that's the engineer's own Chrome) |
| `QC_BROWSER_PROFILE_DIR` | `~/.pw-agent-profile-qc` | QC browser profile; separate from the self-launch one because Chrome won't open a profile twice |
| `QC_BROWSER_PATH` | _(unset)_ | explicit browser executable, when neither Edge nor Chrome is where we look |
| `QC_K6_BIN` | `k6` | path to the k6 binary, for an install that isn't on PATH (Performance › API load test) |
| `IMGBB_API_KEY` | _(unset)_ | free imgbb API key (api.imgbb.com); when set, issue screenshots upload to imgbb and their URLs are embedded in the ClickUp comment — a workaround for a workspace that has hit ClickUp's "Over allocated storage" limit (`GBUSED_005`) |
