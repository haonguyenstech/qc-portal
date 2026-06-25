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
- **Background jobs** — both **ticket crawling** (`/tickets`) and **test-case generation** (`/testcases`) run as server-side in-memory jobs the browser **polls** over HTTP (no WebSocket). They survive browser reload / navigation, accumulate per-item status + a bounded log, and announce completion via an always-mounted watcher; see the section below.

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

## Layout

```
server/src/
  index.ts          Express app + WebSocket hub wiring + graceful shutdown
  config.ts         env vars (QC_PORT, QC_REPO_ROOT, QC_CLAUDE_BIN, QC_DB_PATH)
  db.ts             node:sqlite — projects + runs + events; seed/reconcile on boot
  claude.ts         headless claude launcher + stream-json parser (QC runs, over WebSocket)
  claudeExec.ts     shared one-shot claude helpers: runClaude (buffered JSON),
                    runClaudeStream (stream-json → log callback), parseClaudeJsonResult
  testcaseGen.ts    core test-case generation: read ticket → stream claude → write versioned .md
  testcaseJobs.ts   in-memory background-job registry for test-case generation (logs + per-item status)
  crawl.ts          core single-ticket crawl: download detail+comments+attachments (+ optional summary.md)
  crawlJobs.ts      in-memory background-job registry for ticket crawling (logs + per-item status)
  runManager.ts     in-flight run lifecycle (spawn, stream, shutdown)
  terminal.ts       device pseudo-terminal: node-pty shell bridged over /ws/terminal (one shell per socket)
  hub.ts            WebSocket pub/sub by runId (replays persisted events to late subscribers)
  projectScope.ts   resolves the active project's root path; path-guards file writes
  clickup.ts        ClickUp ticket lookup + crawl
  folderPicker.ts   native OS dialogs: pickFolderNative (choose-folder picker, used by skill
                    import) + revealFolderNative (open a folder in Finder/Explorer/xdg-open)
  routes/           projects, qc, files, skills, mcp, clickup, templates, ai

web/src/
  App.tsx           sidebar nav + React Router routes + ProjectSwitcher + always-mounted
                    NotificationBell + TestCaseJobWatcher + CrawlJobWatcher
  main.tsx          React Query + Project + Notification providers + Toaster mount
  index.css         Tailwind v4 theme — oklch design tokens (light + .dark)
  pages/            OverviewPage, TicketsPage, TestCasePage, RunPage, RunningPage, HistoryPage,
                    RunDetailPage, SkillsPage, McpPage, NotificationsPage, TerminalPage (at /terminal),
                    ReleaseNotesPage
                    (at /releases — renders CHANGELOG.md + check-for-updates), ProjectsPage (at /settings)
  components/ui/    shadcn primitives (button, card, dialog, select, tabs, table, scroll-area, …)
  components/       feature pieces: NotificationBell, TestCaseJobWatcher, CrawlJobWatcher, ManageRulesDialog,
                    ContinueSessionPanel (resume a finished run's session in a terminal, see "Continue session" below),
                    MermaidDiagram (lazy mermaid render, used by OverviewPage),
                    OpenFolderButton (reveals a project folder in the OS file explorer),
                    dialogs (RunPresetsDialog, ManageHintsDialog, TicketPicker, …)
  lib/
    api.ts          typed fetch wrapper — ALL backend calls live here
    types.ts        shared API types
    project-context.tsx  useProjects() — active project + list, persisted
    notifications.tsx    NotificationProvider + useNotifications() — bell store, localStorage-backed
    testRules.ts    DEFAULT_RULES + useTestRules() + buildInstructions() for test-case prompts
    utils.ts        cn() (clsx + tailwind-merge)
    useRunStream.ts WebSocket hook for live run events
```

## Routing note

`/settings` renders `ProjectsPage.tsx` (the file name predates the rename). It has two tabs driven
by the `?tab=` query param: `?tab=projects` (default) and `?tab=models`. `/projects` redirects to
`/settings`. When editing "the settings page," edit `web/src/pages/ProjectsPage.tsx`.

## "Open folder" buttons

Every page that edits an on-disk project folder shows an **Open folder** button that reveals that
folder in the OS file explorer **on the machine running the server** (Finder / Explorer / xdg-open) —
the server is localhost, so the window appears on the user's own screen. All of them go through the
single `revealFolderNative(dir)` helper in `folderPicker.ts`; never re-implement the per-platform
open command. The canonical button is the shared `web/src/components/OpenFolderButton.tsx`
(`open: () => Promise<{ ok, path }>` + a `label` for the success toast), used by `/tickets` and
`/testcases`; `/skills`, `/mcp`, and `/templates` still carry equivalent inline copies — prefer the
shared component for any new page and fold those in when you touch them. It lives in each page's
"Editing … for `<project>`" header card next to the mono path chip + `exists`/`new` badge.

Each resource router owns its own `POST …/open` route, which resolves the project's target dir,
`mkdir -p`s it first (so a brand-new project opens cleanly), then calls `revealFolderNative`:

| Page | Folder revealed | Route | api.ts |
|------|-----------------|-------|--------|
| `/skills` | `.claude/skills` | `POST /api/skills/open` | `openSkillsFolder` |
| `/mcp` | project root (where `.mcp.json` lives) | `POST /api/mcp/open` | `openMcpFolder` |
| `/templates` (`/settings`→ProjectSettingsPage) | `testing/templates` | `POST /api/templates/open` | `openTemplatesFolder` |
| `/tickets` and `/testcases` | `testing/tickets` (test cases nest under each ticket folder) | `POST /api/clickup/open` | `openTicketsFolder` |

The MCP `/open` route does NOT `mkdir` — the project root always exists.

## Tickets page (crawl) & Overview page

**`/tickets` (`TicketsPage.tsx`)** — browse a ClickUp workspace or a bound list, multi-select
tickets, and **crawl** them: each ticket's description, comments, `ticket.json`, and attachments are
downloaded into `testing/tickets/<safeSegment(displayId)>/` (the `safeSegment()` displayId→folder
map lives in `crawl.ts` and is re-imported by `routes/clickup.ts`). Notable behaviors:

- **Status grouping** — `buildTree()` sorts top-level tickets by ClickUp `status` (stable within a
  status), and `groupByStatus()` folds them into runs rendered under sticky, color-tinted status
  headers. Subtask order is left untouched.
- **Crawl runs as a background job** — clicking Crawl calls `POST /api/clickup/crawl/jobs`
  (`crawlJobs.ts`), which crawls the tickets sequentially server-side and returns immediately. The
  page persists the active job id per project (`qc.crawlJob.<projectId>`), reconnects on reload, and
  polls `GET /api/clickup/crawl/jobs/:id` (1.5s while running). The page's progress bar, `CrawlLogPanel`,
  and post-crawl results panel are all **derived from the polled job**, so they survive reload/nav.
  The job captures the project's ClickUp token at start (`resolveProjectClickupToken`) and re-establishes
  it with `withClickupToken` inside the runner — the per-request token context is gone by then.
  `POST /api/clickup/crawl` (synchronous single) still exists and shares the same `crawlOneTicket` core.
- **Crawl model picker** — the crawl is a plain download *unless* a model is chosen. The picker
  (`CRAWL_MODELS`: `none` = download only, else `haiku`/`sonnet`/`opus`, persisted in
  `localStorage` as `qc.crawlModel`) makes the crawl additionally run Claude (`runClaude`, buffered
  JSON) to write a QC brief to `summary.md` per ticket. The server validates the model against
  `CRAWL_SUMMARY_MODELS` and returns `summary: null` for download-only (an object only when a
  summary was attempted) — don't reintroduce a falsy-`ok` object for the none case.
- **Crawled / test-case awareness** — already-crawled tickets are highlighted (emerald rail + badge)
  with a delete button. `GET /api/clickup/crawled` reports `testcaseVersions` per folder, surfaced as
  a violet "N test cases" row badge and an **amber warning in the delete dialog** (deleting the folder
  also removes its `testcases/`, which a re-crawl won't restore).

**`/overview` (`OverviewPage.tsx`)** — project summary plus an AI-generated **Mermaid project
diagram**. The diagram source (a `flowchart TD`) is generated from ClickUp sources via
`POST /api/ai/diagram-from-sources`, persisted on the project row (`projects.diagram` column, exposed
on the `Project` type), editable inline, and rendered by `MermaidDiagram` (lazy dynamic `import` of
`mermaid`, `securityLevel: 'strict'`). The ticket section here shows **only crawled tickets** (joined
against `GET /api/clickup/crawled` by `safeSegment(displayId)`), since only those have local data.

## Test-case generation, background jobs & notifications

The `/testcases` page (`TestCasePage.tsx`) lets a QC engineer pick **already-crawled** ClickUp
tickets and have Claude draft manual test cases. Key behaviors:

- **Multi-select up to 5 tickets** (`MAX_TICKETS`) — fewer is better (each ticket is a separate
  Claude run with its own context; the UI says so). An optional **test-case template** file and
  **instructions/rules** (`testRules.ts` + `ManageRulesDialog`) shape the prompt.
- **Model picker** — same `haiku` / `sonnet` / `opus` options as the crawl picker on `/tickets`,
  persisted in `localStorage` (`qc.testcaseModel`), validated server-side against
  `CRAWL_SUMMARY_MODELS` with a `sonnet` fallback.
- **Versioned output** — each generation writes `testing/tickets/<folder>/testcases/v<N>.md`
  (a pre-versioning `testcases.md` surfaces as `v0 (legacy)`). The crawled-tickets list shows a
  badge; an Eye button opens a wide, scrollable **preview dialog** with a version dropdown.

**Background jobs** (`testcaseJobs.ts`) — clicking Generate starts a server-side job; the route
returns immediately. The job runs items **sequentially**, holds per-item status + a bounded
`logs[]` (max 800 lines), and is kept in an **in-memory registry** (survives browser reload/nav;
a *server restart* drops it). `PublicTestcaseJob` never leaks `rootPath` / `template` /
`instructions`. The client persists the active job id per project (`qc.testcaseJob.<projectId>`)
so a reload reconnects, and polls `GET /api/ai/testcases/jobs/:id` (TanStack `refetchInterval`
1.5s while `status === 'running'`, off when done). Routes live in `routes/ai.ts`:
`POST /testcases` (synchronous single), `POST /testcases/jobs` (start batch, folders capped at 20),
`GET /testcases/jobs/:id`, `GET /testcases/jobs`.

**Realtime logs** — generation uses `runClaudeStream` (`--output-format stream-json --verbose`),
forwarding init/assistant/tool/stderr events plus lifecycle markers into the job's `logs[]`. The
page renders a collapsible terminal-style **`JobLogPanel`** (zinc-950, show/hide, auto-scroll,
level-colored) that updates as the poll lands. `runClaude` (buffered JSON) is left untouched for
crawl summaries — don't merge the two.

**Notifications** (`notifications.tsx` + `NotificationBell.tsx` + `NotificationsPage.tsx` at
`/notifications`) — a global, `localStorage`-backed store (`qc.notifications`, cap 50) shown in a
top-right bell with an unread badge and a full-history page. **Completion is announced by always-mounted
watchers** (in `App.tsx`): `TestCaseJobWatcher` (keys `qc.testcaseJob.*`) and `CrawlJobWatcher`
(keys `qc.crawlJob.*`), NOT by the originating page — the page may be unmounted when a job finishes.
Each watcher polls all active jobs of its kind regardless of route, fires the toast + bell notification
once per job (deduped via a module-level `handled` set), invalidates the relevant queries (test cases:
`['crawled', …]` / `['testcase-versions', …]`; crawl: `['crawled-tickets', …]` / `['crawled', …]`),
and clears the stored job id. Keep completion ownership in the watcher to avoid duplicate/again-missed
notifications — pages only *start* jobs and *poll* for live progress.

## Design Check page & project templates

**`/verify` (`VerifyDesignPage.tsx`, labeled "Design Check" in the sidebar)** — pick a crawled
ticket + paste its Figma link; `POST /api/ai/verify-design` (`server/src/verifyDesign.ts`) runs Claude
once in the project dir (tools enabled so it can open the design via Figma/Playwright MCP) and returns
structured `findings` bucketed into `match` / `mismatch` / `concern` / `unsure` / `discuss`, rendered as
grouped cards. Output shape is fixed by the prompt's JSON contract — don't reshape it into a template.

**Project templates (`/templates` → `ProjectSettingsPage.tsx`, `routes/templates.ts`)** — plain-text
files under `testing/templates/<key>.md`. The UI owns the catalog in `TEMPLATE_KINDS`; add a kind there
to expose a new upload slot. Current kinds:
- `testcase` — structure Claude matches when drafting test cases (a per-run upload on `/testcases` still overrides it).
- `design-check` — the project's **standard Design Check checklist**. `verifyDesign.ts` injects it into
  the verify prompt as criteria the model must report a finding for (capped at 6 KB,
  `MAX_CHECKLIST_CHARS`). Resolution mirrors `/testcases`: a one-off file uploaded on `/verify` wins
  (`checklist` in the `verify-design` body → `checklistOverride`); otherwise the server auto-reads the
  saved `testing/templates/design-check.md` (key `CHECKLIST_TEMPLATE_KEY` via `readChecklist`). The page's
  Checklist upload (md/csv/xlsx, Excel→CSV in-browser, preview dialog) shows "Using project checklist"
  with Preview/Override when one is saved, exactly like the TestCase template upload.

## Terminal page (device shell)

**`/terminal` (`TerminalPage.tsx`, "Terminal" under the sidebar's Tools group)** — a real
pseudo-terminal on the machine running the server, rendered in-browser with **xterm.js**
(`@xterm/xterm` + `@xterm/addon-fit`). **Connect** spawns the user's login shell
(`$SHELL -l`, or `%ComSpec%`/PowerShell on Windows) with `cwd` = the **active project's root** via
**`node-pty`**, bridged over a dedicated **`/ws/terminal`** WebSocket; **Disconnect** (or `ws` close)
kills the shell — one shell per socket, nothing persists across reconnects. It behaves like a native
terminal (interactive TUIs work — e.g. type `claude` to start a session).

- **WebSocket protocol** — server→client frames are **raw terminal bytes** (`term.write`); client→server
  frames are **JSON control** messages: `{type:'input',data}` for keystrokes and `{type:'resize',cols,rows}`
  on fit. Connection query params: `projectId`, `cols`, `rows`.
- **Upgrade routing** — `index.ts` uses two `noServer` `WebSocketServer`s and a single `server.on('upgrade')`
  that dispatches by pathname (`/ws` → run hub, `/ws/terminal` → `handleTerminalConnection`); unknown paths
  are `socket.destroy()`ed. Don't go back to `new WebSocketServer({ server, path })` — multiple path-bound
  servers on one HTTP server don't compose.
- **node-pty** is a native module shipped with prebuilt binaries (mac/win, arm64/x64). It's loaded lazily
  and defensively in `terminal.ts` — if the binding can't load, `GET /api/terminal/available` returns
  `{ok:false,error}` and the page shows an "unavailable" card instead of crashing the portal. On posix the
  module re-asserts the prebuild's `spawn-helper` exec bit before the first spawn (some extractions strip it,
  surfacing as `posix_spawnp failed`).

## Continue session (resume a finished run in a terminal)

A QC run's Claude session is **kept alive after the report is written** so the engineer can keep
working in it — the session is not closed when the run ends. The "Continue session" panel on
`RunDetailPage` is a **real interactive terminal** (the same xterm/PTY engine as the Terminal page),
wired to resume *that run's* session. This reuses the existing session capture: `onSession` stores the
stream-json `init` event's `session_id` into `runs.sessionId`.

- **Server** — `/ws/terminal?runId=<id>` (in `terminal.ts`, `resolveTarget`) spawns
  **`claude --resume <sessionId>`** interactively (cwd = the run's project root) instead of a plain
  shell. Bad/absent session or unknown run → an error line is written to the terminal and the socket
  closes. On Windows the resume goes through `cmd.exe /c claude …` so the `.cmd` resolves.
- **`GET /api/qc/runs/:id`** returns **`hasSession`** (`getRunSession(id) != null`) so the panel only
  shows when the conversation can be continued.
- **UI** — `ContinueSessionPanel.tsx` (under the summary, when `run.hasSession`) uses the shared
  **`useXtermSession`** hook (`web/src/lib/useXtermSession.ts`) — the xterm + fit + WebSocket plumbing
  factored out of the Terminal page, parameterized only by the connect query (`runId` here,
  `projectId` for the plain Terminal page). **Connect** is disabled while the run is still
  `running`/`queued` (the session is in use). On disconnect it invalidates `['run', id]` /
  `['run-files', id]` so a report/evidence the interactive session changed refreshes.
- **Process cleanup** — `killPtyTree` signals the pty's whole **process group** (`process.kill(-pid)`;
  node-pty's child is a setsid session leader) so `claude` *and the MCP servers it spawns* die on
  disconnect, escalating SIGTERM→SIGKILL. Don't downgrade this to a bare `pty.kill()` — that leaves
  MCP children orphaned.

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
- **Headless runs use `--permission-mode bypassPermissions`** so they never block on a prompt; the
  `qc-testing` skill itself forbids final mutating actions on shared environments. Don't weaken that.
- **Cross-platform (Win + Mac).** Use `cross-spawn`, `path.join`; never string-concat paths into a
  shell line. The repo path contains a space (`STS-Data /Project/...`) — always pass paths as args.
- **`node:sqlite` is experimental** — the warning is suppressed via `--disable-warning` in the npm
  scripts. Requires Node 22.5+ (tested on 23).
- **Machine-specific values exist.** `McpPage.tsx` hardcodes a Playwright `--user-data-dir`
  (`/Users/hao.nguyen/.pw-agent-profile`); be aware when touching MCP server args.

## Env vars

| Var | Default | Meaning |
|-----|---------|---------|
| `QC_PORT` | `5174` | backend port |
| `QC_REPO_ROOT` | _(unset)_ | absolute path to auto-seed as the default project on first run only |
| `QC_CLAUDE_BIN` | `claude` | path to the Claude CLI |
| `QC_DB_PATH` | `data/qc-portal.db` | SQLite file (projects + run history persist here) |
