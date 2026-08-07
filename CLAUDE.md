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

```
server/src/
  index.ts          Express app + WebSocket hub wiring + graceful shutdown
  config.ts         env vars (QC_PORT, QC_REPO_ROOT, QC_CLAUDE_BIN, QC_DB_PATH)
  db.ts             node:sqlite — projects + runs + events + sources (multi-repo: one tagged
                    row per connected repo; legacy projects.source* columns migrate on boot);
                    seed/reconcile on boot
  claude.ts         headless claude launcher + stream-json parser (QC runs, over WebSocket)
  autoAgent.ts      Auto Agent status: the company's `auto-agent-ai` CLI
                    (@saigontechnology/auto-agent) distributes the shared Claude Code
                    credential — signs in via Microsoft, pulls it into the keychain, and
                    leaves a WATCHER running to keep it fresh. Every AI feature here
                    shells out to `claude`, so when Auto Agent logs out / its watcher dies
                    / the credential lapses, runs fail with confusing mid-run auth errors.
                    readAutoAgentStatus() reports that as one of connected | expiring |
                    stalled | expired | logged-out | not-installed from ~/.auto-agent-ai/
                    state.json + a pid probe + the tail of watch.log (a ✖ line followed by
                    a later "Watcher started" is stale, not current). SECRET: read
                    state.json ONLY — the sibling .config.json holds auth.accessToken and
                    the distributed Claude credentials and must never be opened here.
                    Surfaced by GET /api/auto-agent/status (routes/autoAgent.ts) and the
                    sidebar's AutoAgentStatusIndicator, ABOVE Release notes.
  claudeExec.ts     shared one-shot claude helpers: runClaude (buffered JSON),
                    runClaudeStream (stream-json → log callback), parseClaudeJsonResult —
                    which MUST accept BOTH `--output-format json` shapes: a single
                    `{type:'result',result,is_error}` object (older CLI) and the whole
                    message ARRAY ending in that object (current CLI). Reading `.result`
                    off the array yields undefined, which all ~12 callers report as "the AI
                    produced nothing" (Ask AI on /database, crawl summaries, grounding
                    check, auto-learn, source map, design system, verify design, …).
                    Don't narrow it back to one shape.
  testcaseGen.ts    core test-case generation: read ticket → stream claude → write versioned .md
  testcaseJobs.ts   in-memory background-job registry for test-case generation (logs + per-item status)
  crawl.ts          core single-ticket crawl: download detail+comments+attachments (+ optional summary.md)
  crawlJobs.ts      in-memory background-job registry for ticket crawling (logs + per-item status)
  sourceRepo.ts     git plumbing for the Source Code page: clone/adopt/pull a GitHub/Bitbucket
                    repo, provider detection, token-scrubbing, + the on-disk credential store
  sourceJobs.ts     in-memory background-job registry for source clone/sync (logs + status);
                    after a clone/sync with new commits it refreshes the repo's SOURCE MAP
  sourceMap.ts      source map: one cheap (haiku) read-only AI pass over a connected repo →
                    testing/knowledge/source-map-<tag>.md (AI-badged, via knowledgeStore) so
                    test-case gen + QC runs jump straight to the files it names instead of
                    re-exploring the repo each time; skipped when a sync brings no new commits;
                    deleted on disconnect/tag-rename (regenerates on reconnect)
  designSystem.ts   design system: one cheap (haiku) read-only AI pass over the project's source →
                    testing/knowledge/design-system.md (AI-badged, via knowledgeStore) capturing the
                    REAL product's palette, type scale, spacing/radii, component shapes and wording
                    conventions, so prototype builds match the app WITHOUT re-reading the repo every
                    time (mirrors sourceMap.ts); driven from the Prototype page
  runManager.ts     in-flight run lifecycle (spawn, stream, shutdown)
  terminal.ts       device pseudo-terminal: node-pty shell bridged over /ws/terminal; sessions
                    persist across page navigation (registry keyed by project/run, detach on socket
                    close, re-attach with replay, killed only on {type:'kill'} / exit / idle / shutdown)
  hub.ts            WebSocket pub/sub by runId (replays persisted events to late subscribers)
  projectScope.ts   resolves the active project's root path; path-guards file writes
  toolPath.ts       spawnEnv(): process.env with PATH augmented by well-known per-user tool
                    dirs (~/.local/bin, ~/.cargo/bin, WinGet Links) — used by EVERY child
                    spawn (claude, uvx probe, terminal) so uvx/npx MCP servers start even
                    when the portal was launched with a stale PATH; never spawn with a bare
                    { ...process.env }
  clickup.ts        ClickUp ticket lookup + crawl
  folderPicker.ts   native OS dialogs: pickFolderNative (choose-folder picker, used by skill
                    import) + revealFolderNative (open a folder in Finder/Explorer/xdg-open)
  contextPointer.ts managed CLAUDE.md pointer block linking Overview docs + Knowledge + Memory
                    (keeps CLAUDE.md lean)
  overviewDocs.ts   storage primitives for testing/overview — the project's overview documents, one
                    file per upload (see the /overview section); packed into prompts by
                    projectContext.ts, so uploading one is all it takes for the AI to have it
  docReview.ts      "AI review & format" for an engineer-authored/uploaded document: a copy-editor
                    pass that adds no facts. Its output is SAVED OVER the file, so it refuses rather
                    than degrades — oversize input is 413 (never truncated), a collapsed rewrite is
                    rejected, and it never throws
  memoryStore.ts    storage primitives for testing/memory notes (frontmatter description + source,
                    MEMORY.md index) — shared by routes/memory.ts + learn.ts
  knowledgeStore.ts storage primitives for testing/knowledge docs (provenance marker) — shared
                    by routes/knowledge.ts + learn.ts
  totp.ts           authenticator (TOTP) codes for accounts with REAL 2FA — RFC 6238 over
                    node:crypto + a per-project seed store beside the DB (data/totp/<id>.json,
                    0600, NOT in the project repo); see "Authenticator (2FA) codes" below
  apiAccounts.ts    login credentials an API-Testing FLOW authenticates with — the same
                    "beside the DB, never in the project" store totp.ts uses
                    (data/api-accounts/<projectId>.json, 0700/0600). Password is
                    write-only over the API; requests reference an account as
                    {{account.<label>.username}} / .password, resolved server-side in
                    routes/apiTests.ts `resolveSendVars` together with a LIVE
                    {{otp.<label>}} from totp.ts. See "API Testing flows" below
  projectContext.ts readProjectContext(root): packs testing/memory/*.md + testing/overview/*.md + testing/knowledge/*.md
                    into one capped block injected into prompts (test-case gen + grounding) so the
                    model uses real project terms/rules even when there's no project cwd
  learn.ts          AI auto-capture: reflect on a finished QC run / test-case gen and persist
                    durable facts into memory (+ knowledge), tagged with a source provenance
  groundingCheck.ts independent post-write audit (anti-hallucination): groundTestcases (cases vs
                    ticket) + groundReport (report verdicts vs documented evidence); auto-revises
                    in place. Cheap (haiku), best-effort, never throws — see section below
  notesStore.ts     storage primitives for the /notes workspace — ONE JSON document per
                    project at testing/notes/notes.json (notes + labels), written through a
                    temp file + rename so a crash can't leave a half-written file; caps
                    (500 notes / 200-char title / 100 KB body) and a normalize() that
                    tolerates anything malformed rather than throwing the page away
  routes/           projects, qc, files, skills, mcp, clickup, source, ai, templates,
                    knowledge, memory, notes, database, diagrams, prototype, chat, version

web/src/
  App.tsx           two branches: `/ai-labs` renders BARE (no shell — see "QC AI Labs"),
                    everything else goes through AppShell. The job watchers sit in App,
                    above both, so jobs still announce on the bare page.
                    AppShell = sidebar nav + routes + ProjectSwitcher + always-mounted
                    NotificationBell + TestCaseJobWatcher + CrawlJobWatcher; the sidebar
                    footer (VersionFooter) carries AutoAgentStatusIndicator ABOVE the
                    Release notes card — keep it in BOTH the collapsed and expanded
                    branches, they render separately
  main.tsx          React Query + Project + Notification providers + Toaster mount
  index.css         Tailwind v4 theme — oklch design tokens (light + .dark)
  pages/            OverviewPage, DiagramsPage (at /diagrams), SourceCodePage (at /source),
                    TicketsPage, TestCasePage, RunPage, RunningPage, HistoryPage,
                    RunDetailPage, SkillsPage, McpPage, NotificationsPage, TerminalPage (at /terminal),
                    PrototypePage (at /prototype — see "Prototype page" below),
                    ChatPage (at /chat — see "Chat page" below),
                    DatabasePage (at /database — see "Database page" below),
                    NotesPage (at /notes — see "Notes page" below),
                    AiLabsPage + AiLabDetailPage (at /ai-labs and /ai-labs/:id —
                    see "QC AI Labs" below),
                    InstructionsPage (at /instructions — CLAUDE.md + Knowledge + Memory hub),
                    ReleaseNotesPage
                    (at /releases — renders CHANGELOG.md + check-for-updates),
                    DocumentPage (at /document/:slug — self-contained in-app user manual, ONE page per
                    topic: /document redirects to /document/overview, a left docs nav (searchable) +
                    prev/next switch between pages; sidebar link in the footer below Release notes;
                    content authored inline as SECTIONS[] rendered via react-markdown — keep in step
                    with this file),
                    ProjectsPage (at /settings)
  components/ui/    shadcn primitives (button, card, dialog, select, tabs, table, scroll-area, …)
  components/       feature pieces: NotificationBell, TestCaseJobWatcher, CrawlJobWatcher, ManageRulesDialog,
                    ContinueSessionPanel (resume a finished run's session in a terminal, see "Continue session" below),
                    GenerateFromClickUp (shared ClickUp source picker for Overview + Diagrams),
                    KnowledgeDocs (Instructions → Knowledge tab) + MemoryNotes (Instructions → Memory tab),
                    OverviewDocs (the /overview document list: per-document AI review, preview, delete),
                    MermaidDiagram (lazy mermaid render, used by DiagramsPage),
                    CodeBlock (a fenced code block in rendered markdown: language label,
                    copy button, syntax colours via lib/highlight.ts),
                    OpenFolderButton (reveals a project folder in the OS file explorer),
                    ThemeToggle (light/dark, fixed top-right beside NotificationBell),
                    SqlEditor (the /database SQL editor — see that section),
                    NoteEditor (lazy TipTap rich-text editor for /notes),
                    dialogs (RunPresetsDialog, ManageHintsDialog, TicketPicker, …)
  lib/
    api.ts          typed fetch wrapper — ALL backend calls live here
    types.ts        shared API types
    project-context.tsx  useProjects() — active project + list, persisted
    notifications.tsx    NotificationProvider + useNotifications() — bell store, localStorage-backed
    testRules.ts    DEFAULT_RULES + useTestRules() + buildInstructions() for test-case prompts
    highlight.ts    highlightCode()/resolveLanguage() for CodeBlock — `highlight.js/lib/core`
                    plus a CURATED language set, every one a dynamic import so none of it
                    lands in the main bundle (the barrel would add ~1 MB). Fence labels are
                    mapped through ALIASES (ts→typescript, html→xml, sh→bash, …); an unknown
                    language returns null and the caller renders plain text. Token colours
                    live in index.css (`.hljs-*`), NOT an imported hljs theme
    apiAssert.ts    evaluateAssertions()/getJsonPath() — the API-Testing assertion engine,
                    shared by the request builder and the flow runner (see "API Testing
                    flows"); one copy on purpose, so a step can't grade differently
    devices.ts      describeDevice()/devicesFromDetection() — labels one Maestro `list_devices`
                    entry for a picker (name primary, device_id only in the caption; AVD
                    underscores humanized). Shared by the MCP page's functional-test dialog
                    and the Run form's device picker so a device reads the SAME in both.
                    See "Picking the device a mobile run drives" below.
    sql-complete.ts schema-aware SQL completion for SqlEditor — pure functions
                    (text + caret + live schema in, a ranked suggestion list out), so the
                    component above it only handles keys and painting
    theme.ts        useTheme()/applyTheme()/resolveTheme() — light|dark in localStorage
                    (`qc.theme`); the pre-paint boot script in web/index.html reads the SAME
                    key, so keep both in step or the app flashes the wrong theme
    noteHtml.ts     LOOKS_LIKE_HTML — tells a rich-text note body from a legacy plain one
    utils.ts        cn() (clsx + tailwind-merge)
    useRunStream.ts WebSocket hook for live run events
```

## Routing note

`/settings` renders `ProjectsPage.tsx` (the file name predates the rename). It has two tabs driven
by the `?tab=` query param: `?tab=projects` (default) and `?tab=models`. `/projects` redirects to
`/settings`. When editing "the settings page," edit `web/src/pages/ProjectsPage.tsx`. The `models` tab
holds `ClaudeUsageCard` + `AiRuntimeCard` (global) and `AiAutomationCard` (the active project's
per-project grounding-check / auto-learn toggles — see "Per-project control" below).

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
| `/instructions` (Knowledge tab) | `testing/knowledge` | `POST /api/knowledge/open` | `openKnowledgeFolder` |
| `/instructions` (Memory tab) | `testing/memory` | `POST /api/memory/open` | `openMemoryFolder` |

The MCP `/open` route does NOT `mkdir` — the project root always exists.

## Instructions page — the project context hub (CLAUDE.md + Knowledge + Memory)

**`/instructions` (`InstructionsPage.tsx`)** is the single place for *everything Claude reads on
every QC run*, kept as three tabs so standing guidance is **split into structured folders instead
of crammed into one big CLAUDE.md**:

1. **Instructions** — the lean root `CLAUDE.md` editor (`ClaudeMdCard`/`ClaudeMdEditor`, Edit⇄Preview
   + Save, via `GET/PUT /api/projects/:id/claude-md`).
2. **Knowledge** — `web/src/components/KnowledgeDocs.tsx` (moved here from Overview).
3. **Memory** — `web/src/components/MemoryNotes.tsx` (new).

**Knowledge** — a QC engineer uploads project docs — **Word (.docx), PDF, Markdown/TXT, CSV, Excel** —
to supplement the project's AI knowledge. **Conversion happens in the browser** (`web/src/lib/docConvert.ts`,
mirroring the existing xlsx-in-browser pattern): `.docx` via `mammoth` + `turndown` (+`turndown-plugin-gfm`),
`.pdf` via `pdfjs-dist` text extraction, spreadsheets → GFM tables via `xlsx`, Markdown/TXT passthrough.
All converters are **dynamically imported** so they stay out of the main bundle. The resulting Markdown
is POSTed to `routes/knowledge.ts`, which stores it under `<root>/testing/knowledge/<name>.md` (plain-text,
path-guarded filenames — mirrors `routes/templates.ts`, no DB). Routes: `GET /api/knowledge` (metadata
list), `GET /:name` (full md for preview), `PUT /:name` (save converted md), `DELETE /:name`, `POST /open`.
Scanned/image-only PDFs yield no text and surface a clear error (no OCR).

**Memory** — small, **in-portal-authored** markdown notes, one durable fact each (decisions, gotchas,
conventions). Unlike Knowledge (uploaded + converted docs), notes are written directly in the portal
(name + one-line description + body). Stored by `routes/memory.ts` under `<root>/testing/memory/<name>.md`
with the description in YAML frontmatter; `testing/memory/MEMORY.md` is an **auto-regenerated index**
(one line per note, rebuilt on every save/delete, removed when the folder empties). Routes:
`GET /api/memory`, `GET /:name` (description + body), `PUT /:name` (`{description, content}`),
`DELETE /:name`, `POST /open`. The editor remounts via `key` to seed form state (no setState-in-effect,
mirroring `ClaudeMdEditor`); `MEMORY.md` is reserved and can't be used as a note name.

**AI auto-capture (knowledge updates itself after runs)** — `server/src/learn.ts` (`runKnowledgeUpdate`)
runs a cheap Claude reflection after a QC run **and** after test-case generation, then persists durable
facts it learned: small facts → `testing/memory/`, longer reference write-ups → `testing/knowledge/`
(the model decides, and is told to *update* an existing note rather than duplicate). It's **best-effort
and never blocks/fails the run** — failures are silent. Captured items are stamped with a `source`
provenance (memory: a `source:` frontmatter field; knowledge: a leading `<!-- qc-portal:source: … -->`
comment, invisible when rendered) so the UI flags them with an **"AI" badge** and the engineer can
review/edit/delete them — *editing a note via the UI drops the AI tag, claiming it as the user's*. This
is the "AI updates its own knowledge, and the user can correct it" loop. Hooks: `runManager.ts` `onDone`
(QC runs, broadcasts a follow-up `system` event listing what was captured) and `testcaseJobs.ts` (after
the batch finalizes, before `finalize()`, logging into the job's `logs[]`). Toggled **per project** in
Settings → Models (see "Per-project control" under the grounding-check section); `QC_AUTO_LEARN`
(default on) and `QC_AUTO_LEARN_MODEL` (default `haiku`) now only seed new projects. The `TestCaseJobWatcher` invalidates
`['memory', …]` / `['knowledge', …]` on completion so new notes appear. Storage goes through the shared
`memoryStore.ts` / `knowledgeStore.ts` so the format stays identical to the manual editors.

**Grounding check (anti-hallucination, auto-revise after every AI write)** — `server/src/groundingCheck.ts`
runs an **independent, cheap second pass** (default `haiku`) right after the portal writes an AI artifact,
to catch and silently correct hallucination. Two entry points, both **best-effort and `never-throw`**:
- `groundTestcases()` — audits generated cases against the **ticket _and_ the project's Knowledge/Memory**
  (passed in via the `knowledge` opt — the same `readProjectContext` block the cases were written against, so a
  case grounded in documented project rules counts as grounded, ticket **OR** knowledge) and drops/fixes anything
  ungrounded (invented fields/screens/messages, contradicted or fabricated acceptance criteria), keeping
  legitimate edge/negative coverage. Called at the end of `generateTestcaseVersion` (`testcaseGen.ts`); when it
  changes anything it **overwrites the same `v<N>` file** (no new version) and logs into the run/job log.
- `groundReport()` — audits a finished QC **`report.md`** so any Pass/Fail verdict **not backed by a
  documented observation** is downgraded to Fail/Partial with an `(unverified — no supporting evidence…)`
  note. Called in `runManager.ts` `onDone` **before `parseReport`**, so the Pass/Fail counts reflect the
  grounded report. The pre-audit copy is kept on disk as `report.pre-grounding.md`; a `system` event marks
  whether it corrected anything.

To stay robust without a fragile JSON-wrapped document, the model emits **either the literal sentinel
`GROUNDED_OK`** (nothing to fix → no rewrite) **or the full corrected document** in the same format. The
result is only applied through safety guards — non-empty, ≥50% of the original length (rejects a truncated
rewrite), and (CSV) an unchanged header row — otherwise the original is kept. This complements
**AI auto-capture** above: auto-capture *learns* from a finished artifact, grounding-check *corrects* it first.

**Per-project control (Settings → Models)** — both grounding-check and auto-learn are stored **per project**
on `projects.groundingCheck` / `groundingCheckModel` / `autoLearn` / `autoLearnModel` and edited in the
`AiAutomationCard` on `/settings?tab=models` (scoped to the *active* project; each control auto-saves via
`PUT /api/projects/:id`). The resolution path reads the project's values — `runManager.ts` (`project.*`),
`testcaseGen.generateTestcaseVersion` (`opts.groundingCheck`/`groundingCheckModel`), and `testcaseJobs.ts`
(captured onto the job at start). The `QC_GROUNDING_CHECK` / `QC_AUTO_LEARN` env vars are now only the
**default for newly-created projects** (seeded in `createProject`); migrated/existing projects default ON
with `haiku`.

**Authenticator (2FA) codes — when the OTP isn't fixed (`server/src/totp.ts`)** — a production-like
environment has **no fixed OTP**: the six digits come from Google Authenticator / Authy on the QC
engineer's phone. RFC 6238 makes the code a pure function of `secret + clock`, so the portal stores the
account's **enrollment secret** once and computes the *same* code the phone shows — a headless run then
gets through 2FA on its own instead of stalling or inventing digits.

- **Storage is deliberately NOT `testing/`.** Unlike `environments.md`, a TOTP seed is a long-lived
  second factor: it must not be committed to the project repo and must never be swept into a prompt by
  `projectContext.ts`. It lives beside the portal's DB at `data/totp/<projectId>.json` (dir `0700`,
  file `0600`). The seed is **write-only over the API** — `PublicTotpEntry` strips it, and the only
  thing that ever leaves the process is a 6-digit code.
- **Routes** (in `routes/accounts.ts`, all under `/totp` so they can't collide with the sheet routes):
  `GET /api/accounts/totp` (entries, no secrets), `GET /totp/codes` (live code for each — drives the
  UI), `PUT /totp` (register/replace; `secret` accepts a base32 setup key **or** a whole
  `otpauth://totp/…` link, parsed by `parseOtpauth`), `DELETE /totp/:label`, and
  `GET /totp/:label/code` — **the one a run calls**. A bad seed is rejected at `PUT` time by actually
  generating a code with it, so a typo fails there and not mid-run. `PUT`/`DELETE` re-run
  `syncContextPointer`.
- **How the run learns to use it — two injections, mirroring Knowledge/Memory.** `totpPromptHint(projectId)`
  builds a prompt block (labels + the exact `curl … /totp/<label>/code?projectId=…`, "submit immediately,
  refetch if rejected, never write a code into a report/screenshot, report BLOCKED rather than invent one")
  that `runManager.ts` passes to `runQc` as `totpHint`; and `contextPointer.ts` adds an equivalent bullet
  to the managed `CLAUDE.md` block so an interactive terminal / Continue session gets it too. Both are
  **empty no-ops when the project has no authenticators**, so fixed-OTP projects are unchanged.
- **Test-case generation** gets a different instruction (`projectContext.ts`): never write a literal code —
  say "enter the current authenticator code for `<account>`" — and don't raise cases about the code being
  unavailable, because the portal supplies it. A hard-coded OTP in a case is wrong by the time it runs.
- `projectScope.ts` `projectIdForRoot(root)` is what lets the root-path-only modules (`contextPointer`,
  `projectContext`) reach a store keyed by project id — resolved there rather than threaded through all
  ~12 `syncContextPointer` call sites, where one omission would point the block at the wrong project.
- **UI:** `web/src/components/TotpCodes.tsx`, rendered at the bottom of `AccountsDoc` (the sheet says
  *which* account, this hands out its code). Live codes poll `GET /totp/codes` once a second with a
  drain-bar countdown, so the engineer can **eyeball-match a code against their phone** to confirm the
  key — that verification is the point of showing codes in the UI at all.

**How Knowledge/Memory reach the model — two paths, by run shape:**

1. **In-process runs (project cwd) — the context pointer.** `server/src/contextPointer.ts` maintains a
   managed block in the project's `CLAUDE.md`, delimited by `<!-- qc-portal:context (auto) -->` …
   `<!-- /qc-portal:context -->`, that tells Claude to consult `testing/knowledge/*.md` and
   `testing/memory/*.md`. `syncContextPointer(root)` is **idempotent** and is called from the knowledge +
   memory `PUT`/`DELETE` routes: it appends/updates the block when either folder has content, strips it
   (preserving the engineer's prose) when both go empty, and never writes when the file is already correct.
   **QC runs** spawn `claude` in the project root, so the pointer is what makes the split-out Knowledge/Memory
   get read there; `runQc` (`claude.ts`) also adds explicit one-line reminders to read them — **and to read
   the feature's SOURCE CODE** (Grep/Glob/Read the codebase for the screens/endpoints/fields named in the
   ticket) — before testing.
2. **Direct injection via `projectContext.ts` (test-case generation).** `readProjectContext(root)` packs
   `testing/memory/*.md` (description + body, MEMORY.md excluded) then `testing/knowledge/*.md` (provenance
   marker stripped) into one capped block (32 KB total / 6 KB per item / memory bounded to 12 KB;
   memory first, then `source-map-*` docs, then other knowledge newest-first; clipped items are
   noted inside the block so the model knows to read the full file), which `testcaseGen.ts`
   injects **into the prompt itself** (reliable regardless of what files the model opens) — and passes the
   **same block to `groundTestcases`**. Empty folders → empty block (no-op).

**Test-case generation reads the SOURCE CODE.** `generateTestcaseVersion` now ALWAYS runs `claude -p` with
`cwd = project.rootPath` so the model can read the project (and its `CLAUDE.md`). Tooling by mode:
- **no live app** → `--allowedTools Read Grep Glob --strict-mcp-config` (read-only file tools, MCP skipped for
  fast startup; the draft can't modify the repo). `--allowedTools` is variadic, so it MUST be followed by a
  flag (`--strict-mcp-config`) before the trailing prompt positional, or the prompt is swallowed as a tool name.
- **live app URL** → `--permission-mode bypassPermissions` (loads `.mcp.json` for the Playwright browser; can
  also read source). Budgets bumped (reading source costs more): md `1.50` / csv `2.50` / live-app `3.00`.
The prompt tells the model to locate & read the real implementation first (true field names, validation,
states, branches, roles) and reconcile ticket-vs-code; `project.sourcePath` (root itself, or `<root>/source`)
is surfaced as a relative hint and threaded through `routes/ai.ts` + `testcaseJobs.ts` (`job.sourcePath`).
Because the cases are now grounded in real code the auditor can't see, `groundTestcases` is called with
`sourceAware: true` — it then only fixes clear contradictions/fabrications and never strips a detail merely
because the ticket doesn't restate it.

## Tickets page (crawl) & Overview page

**`/tickets` (`TicketsPage.tsx`)** — browse a ClickUp workspace or a bound list, multi-select
tickets, and **crawl** them: each ticket's description, comments, `ticket.json`, and attachments are
downloaded into `testing/tickets/<safeSegment(displayId)>/` (the `safeSegment()` displayId→folder
map lives in `crawl.ts` and is re-imported by `routes/clickup.ts`). Notable behaviors:

- **Subtask selection + nesting** — selecting a subtask auto-selects its whole parent chain
  (`toggleSelect`), and the selection count shows a `· N parents + M subtasks` breakdown when any
  subtask is picked. On crawl, each ticket is written to a **nested** folder mirroring the ClickUp
  tree: the client computes a per-ticket `relDir` (`relDirFor`, `PARENT/CHILD` from selected ancestors)
  and threads it through `startCrawlJob` → `crawlJobs.ts` → `crawlOneTicket`, which sanitizes each
  segment and path-guards the join. Omitting `relDir` keeps the classic flat `<displayId>/` layout, so
  single crawls and **already-crawled flat folders are unchanged**. **The on-disk folder is now the key
  everything joins on** — it may be a nested path — so the frontend joins a ClickUp ticket to its
  crawled folder by the real `displayId` from `ticket.json` (with a flat-name fallback for legacy
  folders), NOT by recomputing `safeSegment(displayId)`. `GET /api/clickup/crawled` **recurses** to find
  every folder containing `ticket.json`, returning `name` (nested relative path, posix separators) +
  `parent` (enclosing folder or null); reserved content dirs (`testcases/`, `attachments/`) are never
  treated as tickets. Disk ops (`/open`, testcase versions, verify-design) already resolve via
  `path.resolve(baseDir, folder)` + escape-guard, so they're nesting-safe; the **delete** route
  sanitizes each path segment (not `safeSegment`, which would collapse the `/`) and deleting a parent
  removes its nested subtask folders too. `fillTestcases.ts` uses `findCrawledTicketDir` (crawl.ts) to
  locate a possibly-nested ticket folder. `/testcases` renders these as an expandable **parent→subtask
  tree** (see that section).
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

**`/overview` (`OverviewPage.tsx`)** — the project's **overview documents**: the product/spec files
that say what this project IS. The page is deliberately just two things — an upload zone and the list
of documents (`OverviewDocs.tsx`). There is no intro editor, no merge mode, and no "add to intro":
**one upload = one document**, so 10 files show as 10 documents, each reviewable on its own. Every
richer shape was tried and removed — merging uploads into `projects.description` produced a single
blob nobody could review or replace piecemeal, and a mode switch just made the engineer choose
between two paths to the same place. `projects.description` still exists in the DB but nothing on
this page reads or writes it any more.

**Uploading is all it takes for the AI to have the file.** Both context paths carry
`testing/overview/`:
- `projectContext.ts` packs the folder into the injected block — after Memory, **before** Knowledge
  (it describes the product itself), bounded by `OVERVIEW_MAX_CHARS` so one big spec can't crowd out
  the reference docs. So test-case generation, prototypes and the grounding check all see it.
- `contextPointer.ts` adds an **Overview documents** bullet to the managed `CLAUDE.md` block for
  in-project runs, so `PUT`/`DELETE` in `routes/overviewDocs.ts` both call `syncContextPointer` —
  the first upload adds the bullet, deleting the last one strips it.

Storage + routes: `server/src/overviewDocs.ts` (store) and `routes/overviewDocs.ts`
(`GET /api/overview-docs`, `GET`/`PUT`/`DELETE /:name`, `POST /:name/review`, `POST /open`). Name
sanitizing is shared with `knowledgeStore.safeDocName`, so a file lands on the same on-disk name in
either store. Knowledge (`/instructions`) is still the place for standing reference material the AI
must always have; Overview is "what the product is", and the two are separate folders so the
Overview page owns its own list and gets packed first.

Client: `uploadFiles()` converts each file with the shared in-browser `docConvert` **sequentially**
(the parsers are heavy main-thread dynamic imports, so parallel conversion only janks the page) and
`PUT`s each under its own name. A per-file failure (scanned PDF, wrong type) never aborts the batch:
the toast reads `Added N of M files` and names each failure, so a doc that silently dropped out can't
be mistaken for a clean import.

**Per-document "AI review"** (`POST /api/overview-docs/:name/review` → `server/src/docReview.ts`
`reviewMarkdown()`) is a **copy-editor** pass, not a generator: fix Markdown structure, merge
duplicated passages, strip conversion noise (PDF page numbers, running headers), keep the author's
wording — and add **no** fact, with tables/links/IDs/URLs/numbers surviving verbatim. It rewrites
that one file in place, which is why every failure mode is a data-loss risk and the module **refuses
rather than degrades**:
- Input over `MAX_REVIEW_CHARS` is **413, never truncated** — unlike a normal prompt, the output is
  written *over* the engineer's file, so half a document in means the other half deleted.
- A result under 25% of the original length is rejected as a collapsed rewrite.
- `reviewMarkdown` never throws; a failure is an `{ok:false, status, error}` and the route saves
  nothing.
- The response returns `before`, which the row's amber **Restore** / **Keep it** strip re-`PUT`s. An
  AI edit the engineer can't undo is one they have to fight — keep that undo.

**`/diagrams` (`DiagramsPage.tsx`)** — multiple named **Mermaid diagrams** per project (sidebar
"Diagrams", under Source Code in the Project group). Diagrams are generated from ClickUp sources via
`POST /api/ai/diagram-from-sources`, stored as rows (`routes/diagrams.ts`, keyed by project), picked
from a dropdown, edited inline with a live `MermaidDiagram` preview (lazy dynamic `import` of
`mermaid`, `securityLevel: 'strict'`), or hand-written. **This page was split out of Overview** — if
you're looking for "the project diagram," it lives here now.

**`web/src/components/GenerateFromClickUp.tsx`** — the shared ClickUp source picker (docs + crawled
tickets, multi-select, per-project list binding) used by **both** pages, parameterized by
`mode: 'overview' | 'diagram'` so each surfaces its one action (overview → `GenerateOverviewDialog`;
diagram → `GenerateDiagramDialog`). The ticket tab shows **only crawled tickets** (joined against
`GET /api/clickup/crawled` by `safeSegment(displayId)`), since only those have local data.

## Test-case generation, background jobs & notifications

The `/testcases` page (`TestCasePage.tsx`) lets a QC engineer pick **already-crawled** ClickUp
tickets and have Claude draft manual test cases. Key behaviors:

- **Multi-select up to 5 tickets** (`MAX_TICKETS`) — fewer is better (each ticket is a separate
  Claude run with its own context; the UI says so). An optional **test-case template** file and
  **instructions/rules** (`testRules.ts` + `ManageRulesDialog`) shape the prompt.
- **Parent→subtask tree** — the crawled-ticket list nests subtasks under their parent (built from the
  `parent` field returned by `GET /api/clickup/crawled`, which reflects the nested on-disk layout).
  Top-level tickets group by ClickUp status as before; descendants render indented beneath them
  (regardless of their own status) with a chevron to collapse. Filtering keeps a match's ancestor chain
  in view so the tree stays coherent. Selection/generation still key on each ticket's folder path
  (`c.name`, possibly nested) — `path.resolve` on the server makes that nesting-safe. The tree is shared:
  **`buildCrawledTree(all, {match, collapsed})`** in `web/src/lib/crawled-tickets.ts` returns
  status-grouped roots + a `rows()` flattener, and every crawled-ticket **selector** uses it —
  `/testcases` (inline), the **Run form** picker (`CrawledTicketPicker`) + Run **queue** list
  (`FeatureTicketsPicker`, RunPage), and the **Design Check** picker (`VerifyDesignPage`). The shared
  `CrawledTicketRow` takes `depth`/`hasChildren`/`isOpen`/`onToggleExpand` for the indent + chevron.
  Its emerald **"Test cases" badge is a preview button wherever `onView` is passed** — on the Run
  form both the row badge and each selected chip open
  `web/src/components/TestCaseVersionsDialog.tsx`, the shared read-only preview (version dropdown →
  `CsvTable` / rendered markdown). That dialog is keyed by folder and derives the shown version
  during render (no setState-in-effect); `TicketTestCasePicker`'s Eye button opens the same one with
  `initialVersion`, and the path helper `testcaseRelPath` lives in `web/src/lib/testcases.ts`.
  Reading test cases must not depend on how many tickets are selected — a queue of 2+ tickets and a
  feature run get the same preview as a single pick. Editing/deleting stays on `/testcases`.
  (`GenerateFromClickUp` on Overview/Diagrams reads ClickUp **live by id**, not from disk, so it stays a
  flat ClickUp list; `TicketPicker.tsx` is unused/dead.)
- **Model picker** — same `haiku` / `sonnet` / `opus` options as the crawl picker on `/tickets`,
  persisted in `localStorage` (`qc.testcaseModel`), validated server-side against
  `CRAWL_SUMMARY_MODELS` with a `sonnet` fallback.
- **Versioned output** — each generation writes `testing/tickets/<folder>/testcases/v<N>.md`
  (a pre-versioning `testcases.md` surfaces as `v0 (legacy)`). The crawled-tickets list shows a
  badge; an Eye button opens a wide, scrollable **preview dialog** with a version dropdown.

**Attach a specification document** — a ClickUp/Jira ticket often just LINKS to the spec (or to a
section of it) and carries no acceptance criteria, so generating from the ticket alone drafts almost
nothing. The `/testcases` page therefore has a **Specification** upload card beside the Template one:
**.docx / .pdf / .xlsx / .csv / .md**, converted to Markdown **in the browser** by the shared
`web/src/lib/docConvert.ts` (the same pipeline Knowledge uploads use), so the file itself is never
uploaded and the server needs no upload route or temp files. The extracted text rides along as
`spec: { name, content }` on `POST /api/ai/testcases` and `/testcases/jobs` (`parseSpec` in
routes/ai.ts → `startTestcaseJob` → `generateTestcaseVersion`), capped at `MAX_SPEC_CHARS` (120 KB —
deliberately larger than the 40 KB ticket cap, since here the spec IS the requirement).

- In the prompt it's an **authoritative requirement source on par with the ticket**, not background:
  a requirement that appears ONLY in the spec is in scope. The **ticket still bounds WHICH PART** of a
  (usually much larger) spec this run covers. Spec-vs-ticket disagreement → cover the ticket's version
  and note the discrepancy; spec-vs-code disagreement → assert the spec and note it, since that is
  the bug worth finding.
- **It is also passed to `groundTestcases`** (appended to `ticketContent` under an
  `ATTACHED SPECIFICATION` heading). Non-negotiable: the audit deletes cases the ticket doesn't
  support, so without this it would strip every spec-derived case — i.e. all of them, for exactly
  the stub-ticket case this feature exists for.
- The spec is **not** persisted anywhere (not on the job's public shape, not in localStorage): it
  belongs to the run being configured, and a converted PDF would blow past localStorage.
- A scanned/image-only PDF extracts no text; that surfaces as an explicit error instead of an empty
  spec silently reaching the prompt.

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

## API Testing flows (run a collection, Postman-style)

`/api-testing` sends one request at a time; a real acceptance criterion is usually a **scenario**
("log in → create a claim → verify it's listed"). A **flow** is an ordered list of the project's
saved requests, run in sequence with each step's `captures` feeding the next step's `{{variables}}`.

- **Definition lives on the server, the RUN happens in the browser.** `routes/apiTests.ts` stores
  flows in `testing/api-tests/_flows.json` (`GET/PUT/DELETE /flows`, `POST /flows/:name/rename`) and
  reports under `testing/api-tests/_flow-runs/<flow>/` (`POST`/`GET /flows/:name/runs`, newest 20).
  `web/src/components/ApiFlowPanel.tsx` drives the run itself — one `POST /send` per step — because
  `/send` already resolves variables and masks secrets, and assertions are graded by
  **`web/src/lib/apiAssert.ts`**, the engine extracted out of `ApiTestingPage.tsx` so the builder and
  the runner **cannot** grade the same response differently. Don't add a second server-side
  assertion evaluator.
- **Steps reference a saved request by NAME, never a copy** — editing the request updates every flow,
  and `POST /:name/rename` rewrites the matching `requestName` in every flow (otherwise a rename
  silently empties a step). A deleted request leaves the step in place, flagged `missing`, and fails
  its step rather than being skipped in silence.
- **Verdict rules:** a step passes when all its enabled assertions pass, or — with no assertions —
  on a 2xx. `stopOnFail` (per flow) marks every later step `skipped`; a per-step `continueOnFail`
  ("soft") overrides it. Captures are applied even for a failing step (a 4xx can still carry an id
  the next step needs). The stored report holds **verdicts only** (status, timing, check counts,
  captured variable names) — never response bodies, so a token in a login response can't reach the
  project repo through it.
- **Authentication — the flow PICKS an identity ("Run as").** `flow.auth` holds only two LABELS
  (`accountLabel` from `apiAccounts.ts`, `totpLabel` from `totp.ts` — the **same authenticators the
  Instructions → Accounts page registers**, which is why `FlowAuthPicker` links there instead of
  duplicating that editor). The runner passes them with **every** step's send, and `resolveSendVars`
  turns them into `{{auth.username}}` / `{{auth.password}}` / `{{auth.otp}}` — so ONE login request
  runs as any account and re-testing as a different role is a dropdown, not a request edit. A
  specific account stays addressable as `{{account.<label>.username}}`. The report records which
  account ran (`account` in the run record); `_flows.json` is versioned with the project, so only
  labels may ever go in it.
  - The OTP is computed **per send** (function of the clock — never cache it), and it + the password
    are marked `secret`, which keeps them out of the echoed request and the stored history. The
    active environment wins on a key collision, so a hand-defined `otp.*` for a fixed-OTP
    environment still works.
  - **The store is separate from `testing/environments.md`, so it starts empty** — and an empty
    picker reading "No account" while the engineer is looking at their account on Instructions →
    Accounts is the confusing part. `GET /accounts/candidates` parses that sheet's markdown table
    (columns matched by HEADER NAME, never position; a row with no username is skipped) and offers
    the rows for one-click **import**; `POST /accounts/import` re-reads the sheet server-side so a
    password never makes the round trip to the browser. Rows already imported are filtered out by
    username. Both pickers also carry an explicit empty-state line instead of a bare "No account".
  - The runner **refuses to start** when a step references `{{auth.username|password}}` / `{{auth.otp}}`
    and nothing is picked. Verified: unresolved tokens are sent literally, the API answers 401, and
    that reads as "wrong password" rather than "you didn't pick an account" — a wasted debugging trip
    the pre-run check removes.
- `_flows`, `_flow-runs`, `accounts` and `flows` are in `RESERVED_NAMES`, and `_flows.json` is
  excluded from the saved-request listing — otherwise a flow file shows up as a broken "request".
- **Never open a second Radix `Dialog` from inside the flow dialog without guarding it.** Radix
  portals the inner dialog OUTSIDE the outer `DialogContent`, so every click in it counts as an
  interaction *outside* the flow dialog: Radix dismisses the flow dialog, unmounting the unsaved
  `steps` draft. Verified — the original "Add steps" dialog closed both dialogs and added nothing.
  The step picker is therefore **inline** (`AddStepPicker`, appends on each click, no confirm
  button), and the accounts dialog — which genuinely has to be a dialog — is paired with
  `onPointerDownOutside` / `onInteractOutside` / `onEscapeKeyDown` guards on the flow's
  `DialogContent` (so Escape closes only the inner one, and normal dismissal still works when
  nothing is stacked).
  - Those guards must **NOT** test an `accountsOpen`-style boolean. Radix also decides
    "interacted outside" on TRAILING events — the focus-outside fired as the inner dialog unmounts —
    by which time the flag is already false, so the guard passes and BOTH dialogs close. Verified
    with a real pointer sequence on the inner dialog's Close button (a synthetic `.click()` does not
    reproduce it). Hence `guardedUntil` (a ref): armed while stacked and kept armed ~400 ms past the
    close. Re-test all four dismissals — Close, ✕, Escape, click-outside — plus "flow dialog still
    closes normally afterwards", when touching this.

## Picking the device a mobile run drives

Both mobile targets on `/qc-run` ("Web on mobile", "App on device") drive a real device through
Maestro, and `list_devices` **order** used to decide which one — a coin toss whenever an Android
emulator, an iOS simulator and Maestro's synthetic `chromium` web device are up at once. So the Run
form pins the choice:

- **`RunDevicePicker`** (in `RunPage.tsx`) renders **Auto** + one chip per detected device, labeled
  by `web/src/lib/devices.ts` (`describeDevice`) — the **name** is the chip, the `device_id` only the
  caption. Detection is the same probe the MCP page's functional test uses
  (`runMcpTest('maestro', projectId, '')`), so it costs a real Claude/Maestro run (~20 s): it is
  **not** run on page load, only when a mobile target is selected, then cached for the session
  (`['maestro-devices', projectId]`, `staleTime: Infinity`) with an explicit **Re-scan**.
- The pick persists per project (`qc.runDevice.<projectId>`), because the same emulator usually stays
  booted across runs. It is only **sent** when it's still in the current listing — a remembered device
  that's no longer booted falls back to Auto (and says so) instead of failing the run on a stale id.
- `deviceId` threads `createRun` → `POST /api/qc/run` (validated `/^[\w.:@-]{1,80}$/`, and **dropped
  for the `web` target**) → `CreateRunBody` → `runManager` → `runQc`, which adds a `DEVICE:` prompt
  block: still call `list_devices`, then pass EXACTLY this `device_id`, never substitute another, and
  report a blocker (naming what it did find) if it's absent. **No pick = the previous behavior**, so
  single-device setups are unchanged.

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
  **Seeded on project creation**: `initializeProjectFolder` (routes/projects.ts) copies the template
  project's `testing/templates/testcase.md` when one exists, else the portal-bundled default
  (`templates/project-templates/testcase.md` via `bundledTemplateFile`), so a new project starts
  with a test-case template already in place. Never overwrites an existing file.
  The bundled default is the team's **common CSV template** (`ID,Feature,Test suite,Summary,
  Pre-condition,Steps,Expected result,Actual result,Priority,Status,Reference,Note` + sample rows).
  Note the file name stays `<key>.md` while the CONTENT is CSV — that's the existing design, not a
  mistake: `detectTemplateFormat` (testcaseGen.ts) / `looksLikeCsv` (CsvTable.tsx) decide the format
  from the first content line, and uploading a `.csv` on `/templates` has always been stored as
  `testcase.md`. So a generation against it writes a real `v<N>.csv`.
- **Bundled templates auto-update with the portal (`server/src/templateSync.ts`)** — the template a
  run actually reads is the project's copy, so without this a `qc-portal --update` would leave every
  project drafting against the old default forever. Same rule (and shape) as `skillSync.ts`:
  `reconcileBundledTemplates()` runs once at boot from `index.ts` and, per project × bundled key,
  compares `testing/templates/<key>.md` against the bundled master —
  missing → seed; identical → just fingerprint it (so the NEXT update is silent);
  identical to the fingerprint the portal recorded when it last wrote the file
  (`template_installs`, db.ts) → **refresh silently**; anything else → the engineer edited it, so
  **leave it alone** and log it as customized (`/templates` already offers "Reset to default").
  A copy matching an older shipped default counts as untouched via `LEGACY_DEFAULTS` (hashes of past
  bundled files) — fingerprinting only started with this module, so pre-existing copies have no row
  and would otherwise read as hand-edited; **append** the outgoing hash there whenever you change a
  bundled default. Route side: `PUT /:key` clears the fingerprint (now the user's), `POST /:key/reset`
  records it, and `DELETE /:key` writes the `TEMPLATE_ABSENT` sentinel so the next boot doesn't
  helpfully re-seed a template someone deleted on purpose. Project seeding only fingerprints the copy
  when it came from the bundled file, never from a template project's (possibly customized) one.
- `design-check` — the project's **standard Design Check checklist**. `verifyDesign.ts` injects it into
  the verify prompt as criteria the model must report a finding for (capped at 6 KB,
  `MAX_CHECKLIST_CHARS`). Resolution mirrors `/testcases`: a one-off file uploaded on `/verify` wins
  (`checklist` in the `verify-design` body → `checklistOverride`); otherwise the server auto-reads the
  saved `testing/templates/design-check.md` (key `CHECKLIST_TEMPLATE_KEY` via `readChecklist`). The page's
  Checklist upload (md/csv/xlsx, Excel→CSV in-browser, preview dialog) shows "Using project checklist"
  with Preview/Override when one is saved, exactly like the TestCase template upload.

## Prototype page (requirement → working screen → test cases)

**`/prototype` (`PrototypePage.tsx`, `routes/prototype.ts`)** — a Claude-style chat that turns a
request into a **self-contained HTML/CSS prototype** (Tailwind Play CDN), streamed live and rendered
in a sandboxed iframe with device frames (desktop/laptop/tablet/mobile + rotate), a Code view, PNG
capture, and reference-image attachments. Each prototype is a conversation stored per project at
`testing/prototypes/<slug>.json`; follow-ups refine the SAME document. It is a **QC/BA instrument**,
not just a mock-up generator — these things make it that:

1. **Build from a ticket.** A prototype can be linked to an already-crawled ticket **folder**
   (`ticketFolder`, possibly nested `PARENT/CHILD` — the same key `/testcases` uses, NOT the display
   id). `readLinkedTicket` reads that folder's `ticket.md` + `comments.md` (capped at
   `MAX_TICKET_CHARS`) plus `ticket.json` for the display id/title, and the prompt makes the ticket
   the **scope**: real names verbatim, the states it implies, and an inline amber "Assumption" note
   where it's ambiguous. The picker (`TicketLinkDialog`) reuses the shared `buildCrawledTree` +
   `CrawledTicketRow`, so it nests and groups like every other crawled-ticket selector.
2. **Project- and source-grounded.** `readProjectContext(root)` (Knowledge + Memory) is injected into
   **every** build — same block `testcaseGen.ts` uses, so prototypes speak the product's terminology.
   **"Match our app"** (`matchApp`, opt-in per build) additionally runs the build with
   `cwd = project.rootPath` and READ-ONLY file tools so the model takes the real design language,
   field labels and messages from the codebase (steered by the `source-map-*` knowledge doc first).
   Tool-enabled builds get `GEN_TIMEOUT_SOURCE` instead of `GEN_TIMEOUT` and the prompt time-boxes
   reading hard. `toolArgsFor()` names the mutating tools in **`--disallowedTools`** as well as
   omitting them from `--allowedTools` — verified: allow-list-only still makes the model *attempt*
   `Write`/`Bash` (the CLI denies them, but the attempts spam `⚙ Write` into the build log). Both
   flags are variadic, so each MUST be followed by another flag before the trailing prompt positional.
   A build **must never modify the repo**; don't weaken this.
3. **Revision history (non-destructive refines).** Every build/refine **appends** a `PrototypeVersion`
   (`{n, html, prompt, summary, at, model}`) via `pushVersion` — `prototype.html` always mirrors the
   newest/restored entry. Capped at `MAX_VERSIONS` (numbers stay monotonic after trimming, so a number
   is never reused). `migrate()` backfills a pre-versioning document as v1 on read, so old prototypes
   gain history for free. **`toPublic()` strips every revision's HTML** from list/detail responses
   (they'd otherwise be ~12× larger); a revision's HTML is fetched on demand from
   `GET /:slug/versions/:n`. The UI shows a revision bar (select + Compare, and an amber "viewing an
   older revision" state with Restore) and a side-by-side `CompareDialog` of two live iframes.
   `POST /:slug/restore` **appends** the restored document as a new revision rather than rewinding,
   so a restore is itself undoable. This is the guard against a refine wrecking an agreed screen.
4. **Prototype → test cases.** `POST /:slug/testcases` calls `generateTestcaseVersion` with the new
   `prototypeUi: { name, html }` option (capped at `MAX_PROTOTYPE_CHARS`), which adds a prompt block
   treating the markup as **OBSERVED UI** — exact labels, fields and constraints, states, validation
   messages — while **the ticket still owns scope** (a disagreement becomes a case/note, not extra
   coverage). Requires a linked ticket, because versions are written under
   `testing/tickets/<folder>/testcases/`. It auto-reads the saved `testing/templates/testcase.md`
   (`readTestcaseTemplate`, mirroring verifyDesign's `readChecklist`) so output matches the team format.
   **The route and `generateTestcasesFromPrototype` stay; the page's "Test cases" button and its
   dialog are gone** — drafting cases belongs on `/testcases`, where the template, rules, model and
   ticket selection all live, and a second half-featured entry point on this page only split that.

5. **The project design system (`designSystem.ts`).** The product's visual language is extracted
   ONCE — palette, type scale, spacing/radii, component shapes, layout shell, and the wording
   conventions for labels/statuses/messages — into `testing/knowledge/design-system.md`, and every
   later build inherits it. This is the fix for `matchApp` being slow, expensive, and inconsistent
   (re-derived per build, so two prototypes of the same product didn't look like siblings). Because
   it's a knowledge doc it needs **no prompt plumbing for the content** — `readProjectContext`
   already injects it; `buildPrompt` only adds a directive saying the doc is **authoritative and
   overrides the generic design guidance and any style preset**. When both the design system and
   `matchApp` are on, the source-reading block flips to "the look is already described — spend your
   reads on field names, validation and business logic instead". `projectContext.ts` `PRIORITY_DOCS`
   packs it (with `source-map-*`) before all other knowledge so it can't be crowded out of the
   budget. Routes `GET`/`POST /api/prototype/design-system` — both MUST stay **above `GET /:slug`**,
   which would otherwise swallow the path. Driven from the `Design system` pill in `GroundingBar`
   → `DesignSystemDialog`; extraction takes ~60-90s on haiku and is a one-off.
6. **Comment mode — click the element, don't describe it.** `PICKER_SCRIPT` is injected into the
   **rendered** `srcDoc` only (`withPicker`, never into the stored document) and highlights whatever
   the cursor is over; a click is swallowed (`preventDefault` on `click` *and* `submit`, so the
   prototype can't act on it) and `postMessage`s the element's `label` (`<button> "Save changes"`)
   plus a shallow CSS-ish `path` to the parent. The iframe is a **null origin**, so `e.origin` is
   useless — `PreviewPane` validates the payload **shape** (`source: 'qc-prototype'`) instead, and
   only listens while comment mode is on. Pins are client-side state; `commentsToPrompt` sends them
   as ONE refine that names each target and says to leave everything else alone. The iframe `key`
   includes comment mode so toggling remounts with/without the picker.
7. **Open questions → decision ledger (the BA half).** Every build emits a third meta comment
   `<!-- QUESTIONS: … -->`: up to `MAX_QUESTIONS` **genuine requirement ambiguities** it had to guess
   about — explicitly NOT visual taste, and never something already settled. `QuestionsPanel` shows
   them as an amber card; answering one sends `decisions: [{q, a}]` with the refine, and
   `applyDecisions` folds it into `prototype.decisions` (a re-answer **replaces** the old one, and the
   matching open question is dropped so it isn't re-asked mid-build). `buildPrompt` injects the
   ledger as **CONFIRMED DECISIONS — treat as requirement, don't ask again**. Restore clears
   `questions` but deliberately **keeps `decisions`**: an answered requirement question stays
   answered regardless of which revision is on screen.
   The open list **accumulates** via `mergeQuestions` (capped at `MAX_OPEN_QUESTIONS`) rather than
   being replaced by each build's fresh list — verified: answering one question, or any refine that
   raises nothing new, would otherwise silently wipe every question the BA hadn't got to yet.
   Anything already in the ledger is filtered out, so the only ways a question leaves the list are
   being answered or `POST /:slug/questions/dismiss` (the × in `QuestionsPanel`) — a list that
   accumulates needs an explicit way to clear one, or it nags forever.
8. **Export.** `downloadHtml` saves the document on screen as a standalone `.html` (named
   `<prototype>-v<n>.html`) — client-side only, no route. A single self-contained file is how a BA
   hands a screen to a stakeholder or attaches it to a ticket.

Both grounding choices persist on the prototype, so a follow-up refine inherits them. In the client,
`pendingTicket`/`pendingMatchApp` use `undefined` = "inherit what's stored" vs `null` = "explicitly
unlinked" — that distinction is what lets a refine stay requirement-bound without re-picking the
ticket every turn. `POST /stream` is the live path (SSE: `delta` / `log` / `done` / `error`);
`POST /` and `POST /:slug/message` are the buffered equivalents and must stay in step with it —
including the `questions` / `decisions` handling.

`buildContextFor(project, {ticket, matchApp, decisions})` is the single place that assembles a
build's grounding (ticket + knowledge block + source-reading + design-system flag + ledger), so all
three entry points ground identically. Prefer extending it over re-deriving context at a call site.

## Chat page (ask Claude Code about the project)

**`/chat` (`ChatPage.tsx`, `routes/chat.ts`, "Chat" under the sidebar's Tools group)** — a plain
conversation with Claude Code. Every other AI surface here is a FORM (pick a ticket, pick a model,
press Generate); this is the one place a QC engineer can just ask ("why did run 14 fail?", "what
does this endpoint validate?").

- **Not the Terminal page's pty.** That runs the interactive TUI, whose ANSI redraw output is fine
  in xterm and unrenderable as chat bubbles. Chat runs `claude -p --output-format stream-json
  --include-partial-messages`, giving clean assistant text (streamed as `delta` frames) plus
  structured tool events. `cwd = project.rootPath`, so CLAUDE.md / Knowledge / Memory are in scope.
- **Multi-turn is the CLI's own session, not a replayed transcript.** `runClaudeStream` gained an
  `onSession` opt that reports the stream-json `init` event's `session_id`; it's stored on the
  conversation and passed back as `--resume <id>` next turn. **This is the whole reason a follow-up
  understands "it"** — don't replace it with prompt-stuffing. A `--resume` whose session the CLI no
  longer has fails outright, so the route **retries once as a fresh session** rather than losing the
  question. A session id is only adopted once a turn actually produced text.
- **The defaults are TERMINAL PARITY, and that was a correction.** Chat used to pin `sonnet` and
  `--allowedTools Read Grep Glob --strict-mcp-config`, and answered visibly worse than the Terminal
  page on the same question — the complaint that drove this. Three measured causes, all now fixed:
  - **Model.** `/terminal` runs a bare interactive `claude`, so it gets the CLI's own default
    (`claude-opus-5[1m]` on this machine); chat pinned `sonnet`. Same flags, same repo question:
    sonnet made 1 tool call and answered generically, opus made 2 and cited `dbQuery.ts:121`.
    So `model` gained the value **`default`, which omits `--model` entirely** — the only way to
    inherit whatever the user configured — and it is the new default. The named models stay for a
    deliberately cheaper turn. The transcript records what ANSWERED (`onModel` on `runClaudeStream`,
    from the `init` event), never the literal string `default`.
  - **Tools.** `full` (`--permission-mode bypassPermissions`) is now the default, because it is
    exactly what `claude --dangerously-skip-permissions` — TerminalPage's launch line — runs under,
    and it drops `--strict-mcp-config` so the project's MCP servers load. `read` survives as an
    explicit "fast mode" (~1s to first token instead of ~20).
    **`read` is a speed choice, NOT a sandbox** — don't describe it as one. On the current CLI
    `--allowedTools` is a permission allow-list, not a tool filter: the `init` event still lists
    `Bash`/`Write`/`Task`, and with `permissions.defaultMode: "auto"` in the user's settings they
    execute. Verified twice — a headless `read`-mode run ran `git log` via Bash, and a stored
    `read` conversation has `Write` in its tool trail.
  - localStorage keys are **versioned** (`qc.chatModel.v2` / `qc.chatTools.v2`): reading the old
    keys would have left every existing user on the setup being fixed.
  The prompt goes over **stdin**, so the variadic `--allowedTools` can't swallow it.
- **The saved answer is `turn.answer` (the delta buffer), NOT `r.text`.** `r.text` is the CLI's
  final `result` field, which carries only the **last** assistant text block — everything the model
  said before each tool call is missing from it. Measured on a 3-step turn: 266 characters streamed
  across 3 blocks, `result` held the last 106; since the client drops its streamed copy on `done`
  and re-renders from the transcript, 60% of a correct answer vanished from the screen the moment
  the turn finished — worse the more tool steps a turn took, i.e. exactly the thorough answers.
  `r.text` is now only the fallback for when nothing streamed. Related: `runClaudeStream` emits a
  `\n\n` on each `content_block_start` after the first, because deltas from separate blocks carry
  no separator and otherwise run together as "…the folders.Now I'll read package.json".
- **The hard caps were sized for the old weak turn, and now match Terminal parity.** An opus
  turn with MCP loaded reads more, runs more tools and writes more than a pinned-sonnet one, so
  `MAX_TEXT` (60 KB → 200 KB), `MAX_TOOLS_PER_TURN` (40 → 200) and `CHAT_TIMEOUT_FULL`
  (30 min → 90 min) would each have started clipping a good answer. `MAX_PROMPT` went 12 KB → 48 KB
  **and stopped truncating**: an oversize message is a **413** now, because `.slice()` answered
  half a pasted requirement with full confidence and nothing on screen said why (same reasoning as
  `docReview.ts`). `streamErrorText` in `lib/api.ts` unwraps the `{error}` JSON so the toast shows
  the sentence rather than braces, and the composer **puts the refused text back** — the longer the
  message, the likelier it was refused, and clearing it would just lose it.
- **A lapsed `--resume` replays a summary rather than starting blind** (`recapBlock`). The retry
  already existed, but a fresh session has no context, so a follow-up ("does that apply to the
  other endpoint too?") was answered against nothing — confidently, and indistinguishably from a
  good answer. It now prepends a capped recap (last `RECAP_TURNS` turns, `RECAP_MSG_CHARS` each)
  that tells the model it is a summary and to re-read the project before relying on it, and the
  `log` frame says so on screen. It is NOT a substitute for the session (none of the files read
  then are in it) — don't grow it into one.
- **Storage** is `<root>/testing/chats/<slug>.json` (mirrors `routes/prototype.ts`, no DB). A new
  conversation is named after its first question. Routes: `GET /api/chat`, `POST /stream` (SSE:
  `start` / `resume` / `delta` / `tool` / `log` / `done` / `stopped` / `error`), `GET /:slug`,
  `GET /:slug/stream`, `POST /:slug/stop`, `POST /:slug/rename`, `POST /:slug/pin`,
  `DELETE /:slug`, `POST /open`, `GET /images/:name` — **the fixed paths must stay above
  `GET /:slug`**.
- **A turn belongs to the CONVERSATION, not to the request that started it (`LiveTurn`).** Reload,
  navigate away, close the tab — the answer keeps being written and is saved when it finishes;
  coming back re-attaches to it mid-sentence. Before this, `res.on('close')` aborted the CLI child,
  and since the transcript is only written when a turn ENDS, the question and the half-written
  answer both vanished — verified: reloading six seconds into a visible answer left no conversation
  on disk at all. Load-bearing pieces:
  - `live: Map<root::slug, LiveTurn>` holds the abort controller, the **buffered answer**, the tool
    calls and the set of viewers. In memory on purpose, like `crawlJobs` / `testcaseJobs`.
  - The chat file is written **when the turn starts**, not only when it ends — a brand-new
    conversation had no file to re-open, so its first question was the easiest one to lose.
  - `GET /:slug/stream` catches a late viewer up in one shot (`start`, a `resume` frame carrying the
    question + its images, the whole answer so far as ONE delta, then each tool call) and streams the
    rest. The client finds it through `running` on `GET /:slug` and on the rail summaries; the rail
    marks such a row with a pulsing dot and polls **only while something is running**.
  - **Switching conversations mid-answer is allowed, and leaves the turn RUNNING** (`detach`, the
    client-side counterpart of Stop). The rail's New Chat / New temporary / row-click used to
    `if (streaming) return` — with the whole point of `LiveTurn` sitting unused behind it, so a
    long answer pinned the engineer to one conversation for minutes. `detach` aborts only the LOCAL
    subscription and drops `pending` (which belongs to the conversation being left); the server is
    NOT told, so the row keeps its "Answering…" dot and reopening it re-attaches through
    `GET /:slug/stream` mid-sentence, or finds the finished answer. **Whether the server is told is
    the only difference between `detach` and `stop`** — don't collapse them. Two things it needs:
    `attachedRef` must be cleared too (or coming back finds the key still marked watched and never
    re-subscribes), and `onStart` invalidates `['chats']` so a brand-new conversation has a rail row
    to switch back to and the rail's running-only poll actually starts. No duplicate question on
    return: the transcript file holds no user message until the turn ENDS (`appendTurn`), so the
    `resume` frame is the only copy. Verified on screen — switch away at 3 s, rail says "Answering…",
    reopen at 15 s and the caret is back typing; and a turn that finishes while away shows its whole
    saved answer + follow-up chips on return.
  - **Stop is now a request** (`POST /:slug/stop`), because aborting the fetch no longer cancels
    anything. It saves the buffered partial as a failed turn — the old code tried to save `r.text`,
    which is only set from the CLI's final `result` event and is therefore always EMPTY on a kill,
    so Stop silently discarded the answer too.
  - One reply at a time per conversation (409): a second concurrent turn would `--resume` the same
    CLI session and interleave two answers into one transcript.
  - **A turn ends on SILENCE, not on the clock** (`CHAT_IDLE_TIMEOUT`, via `runClaudeStream`'s
    `idleTimeoutMs`). A question about a real repo legitimately spends ten-plus minutes grepping,
    reading and spawning sub-agents; the old fixed wall-clock budget killed exactly that turn and
    replaced every one of those calls with "Claude took too long to answer" (seen on screen after a
    trail of ~18 tool chips). Now the kill timer is **reset by any output** from the CLI and
    `timeoutFor` is only the ceiling. `idleTimeoutMs` is opt-in per caller — omit it and
    `runClaudeStream` keeps the single fixed deadline every other caller relies on.
  - **A cut-off turn saves its partial answer**, for the same reason Stop does: `r.text` only exists
    once the CLI's final `result` event lands, so a killed turn has none while `turn.answer` holds
    everything already streamed. The transcript gets that text plus an italic note saying it was cut
    off — never the note alone.
  - `ChatWorkspace` derives the open slug — nothing picked yet (i.e. a fresh mount after a reload)
    falls back to whichever conversation is still being answered, so the page lands back on it
    instead of the new-chat screen. `onResume` then **pins** that choice with `setPicked`, or the
    page would snap away the instant the turn finished. Derived, not assigned in an effect: this
    page bans setState-in-effect.
- **Pasted screenshots** — QC evidence is usually an image, so Cmd/Ctrl-V (and drop, and the
  paperclip) attaches one to the message. The CLI takes a prompt, **not image bytes**, so the path is:
  the browser sends base64 → `saveImages` writes the file under `testing/chats/images/` (name generated
  server-side from timestamp + MIME, **never** the client's file name) → `imagePromptBlock` names the
  ABSOLUTE paths in the prompt and tells the model to open them with **Read**, which renders images.
  That's why the default `read` tool mode is enough — don't remove `Read` from `toolArgs`. The user
  message stores the file names (`ChatMessage.images`), and `GET /images/:name` serves them back so a
  reopened transcript still shows what was asked about; a turn still in flight previews from the data
  URLs already in memory (the files aren't on disk until it finishes). Limits are mirrored on both
  sides (4 images, 8 MB, png/jpeg/webp/gif) — the client copy only exists so the engineer hears why
  before waiting on a turn. **An image with no text is a valid message**; the server supplies the
  wording rather than 400-ing.
- **UI is a port of shadcnuikit's "AI Chat v2"** (bordered shell, w-72 rail with search + Today /
  Yesterday / 7 Days Ago groups + footer nav + New Chat, centered column, gradient
  greeting, tinted composer well with a hint strip). It deliberately uses the reference's **small
  radii** rather than the portal's rounded-3xl house style. Every mock control is wired to something
  real: the paperclip converts a spec through the shared in-browser `docConvert` and appends it to
  the prompt (the file never reaches the server) or stages an image (see above — that one does), the
  mic slot became the tools toggle, and the hero
  orb is layered SVG gradients standing in for the reference's Lottie (150 KB of generated paths, and
  their artwork) — **animated** by the `qc-orb-*` keyframes in `index.css` so it MOVES like the
  reference does: the two colour lobes drift on mismatched long loops, the light bands rock ±5°, the
  sphere floats/breathes, sparkles twinkle off-phase. Each drifting layer is wrapped in its own `<g>`
  because a CSS `transform` REPLACES an element's `transform=` attribute (which would flatten the
  bands' rotations), scaling layers need `transform-box: fill-box`, and every animation is
  transform/opacity only + disabled under `prefers-reduced-motion` (the artwork stays, it just stops).
  `ChatWorkspace` is mounted `key={projectId}` so switching project resets cleanly
  **without setState-in-effect**.
- **The greeting's second line types itself and cycles** (`GREETING_PHRASES`, `useTypewriter`,
  `GreetingHeadline`) — the empty state's job is to say what this page can be asked, and the quick
  chips only cover four categories, so the headline names a few more where the eye already is. It
  is a chain of `setTimeout`s, not a rAF loop (~18 ticks a second, so a per-frame loop would decide
  to do nothing on 59 of 60 frames), it starts with the FIRST phrase already complete (typing in
  from nothing on mount reads as the page still loading), and it lives in its own component so a
  tick re-renders the heading alone rather than the composer and the chips with it. `aria-label`
  carries the settled sentence; `prefers-reduced-motion` gets the static headline and no caret
  (`.qc-caret` in index.css, `steps(1, end)` so it snaps like a terminal cursor).
- **`@` tags a ticket or its test cases** — "are these cases enough?" only means something next to
  a ticket, and the alternative is pasting a folder path or hoping the model greps for the right one.
  Typing `@` in the composer opens a picker over `GET /api/clickup/crawled` (fetched only once `@` is
  typed, then cached): one row per crawled ticket, plus a `@<id>/testcases` row when it has versions.
  ↑/↓ + Enter/Tab pick, Escape closes — while the menu is open **Enter means "pick", not "send"**.
  Only the REFERENCE travels (`mentions: [{kind, folder, version?}]`); `resolveMentions`
  (routes/chat.ts) turns each into absolute file paths — `ticket.md`/`comments.md`/`summary.md`, or the
  version `listTestcaseVersions` reports (newest when no version is given) — and the model Reads them.
  Nothing is inlined, so five tags cost a few prompt lines instead of 200 KB of ticket text. The
  `@ABC-123` token stays in the message text and **deleting it is how you untag**: send filters
  mentions to those whose token is still in the text. An unresolvable tag (renamed folder, deleted
  cases) is dropped and reported in a `log` frame — a silent drop reads as the model ignoring the tag.
  Folder guarding is **per path segment**, since a subtask folder legitimately contains `/`.
  - **`@db/<tag>` tags a connected DATABASE**, which is two questions, not one: STRUCTURE is
    answered by Reading the `testing/knowledge/db-map-<tag>.md` doc connect/sync already writes,
    and DATA by curling the portal's **own** `POST /api/database/query` (`databaseMentionLine`,
    mirroring `totpPromptHint`'s shape). That endpoint is deliberately the same one `/database`
    uses, so a query the chat model wrote hits every layer of the read-only guard — **never give
    chat a second path to a driver**; a write comes back refused. Verified: real counts off the
    live DB matched a direct query, and "delete the soft-deleted rows" was declined outright.
    The mention carries the database **id**, and `resolveMentions` re-checks `row.projectId`
    against the chat's project — a chat must not reach another project's database by id
    (verified: dropped, and reported in a `log` frame rather than silently ignored).
    Database rows are built and budgeted **separately from the ticket rows** in
    `mentionOptions`: a project has one or two databases against hundreds of tickets, so one
    shared 8-row list would push the database off the menu permanently.
  - **A picked tag renders as a CHIP, painted behind the textarea** (`ComposerPaint` +
    `paintSegments`) — a `<textarea>` can't hold an element, so a tag used to read as plain
    text with a spellcheck squiggle through it, indistinguishable from typing. Same overlay
    `SqlEditor` uses: the paint layer draws the text, the textarea above is `text-transparent`
    with a visible caret and a translucent selection. **The token stays in the text**, so
    deleting it is still how you untag — a chip list beside the box would need its own remove
    control and a second source of truth. Three things are load-bearing: the chip is
    **layout-neutral** (padding cancelled by equal negative margin, font untouched — any metric
    change slides the painted glyphs off the real ones and the caret drifts along the line;
    verified by identical `scrollHeight`), scroll is mirrored with a **`transform`** not
    `scrollTop` (the paint layer has no scrollbar, so an assigned scrollTop is clamped — the
    same trap SqlEditor documents), and longest-token-first matching keeps `@X/testcases` from
    being chipped as `@X` plus loose text. `spellCheck` is off because a squiggle would draw
    across a chip with no readable word under it.
- **Width: the column grows past the reference's `max-w-4xl`** (`xl:max-w-5xl 2xl:max-w-[88rem]`) —
  4xl on a 1440px+ screen left the answer in a ribbon between empty gutters. Three pieces make that
  work together, so don't change one alone: the assistant bubble is **`w-fit`** (a one-line answer
  stretched across 75% of a 1300px column read as a layout bug), prose carries a **measure**
  (`[&_p]:max-w-[85ch]`, likewise `li`/`blockquote`) while code blocks and tables deliberately do NOT
  (they want every pixel), and `ThinkingBubble`'s skeleton uses **rem widths** because a % width has
  nothing to resolve against inside a fit-content box.
- **The answer TYPES OUT — `useSmoothReveal`, and the transcript rows are `memo`ised.** Two separate
  fixes, both measured, both load-bearing:
  - The CLI does not stream a character at a time: a 12.7 KB answer arrived as **116 frames of ~110
    characters**, so painting each frame as it lands advanced the text on only **6% of frames** in
    paragraph-sized jumps (max 225 chars). `useSmoothReveal` drains the received text at a rate
    proportional to the backlog (~12 frames to catch up): **61% of frames advance, median 8 chars,
    worst jump 29** — with zero added long tasks. It can't lag into the next turn, `prefers-reduced-
    motion` skips it, and `safeRevealPoint` walks the cursor past markdown punctuation so a reveal
    never rests between the stars of `**bold**` and flashes raw syntax. The caret is a `▊` CHARACTER
    appended to the text, not a sibling element — markdown renders blocks, so a `<span>` would sit on
    its own line instead of at the end of the last one. While streaming, the scroll is pinned per
    frame (not per delta), or the newest line drifts under the fold between deltas.
  - `Turn` and `CodeBlock` are `memo`ised because `input` lives on the component that renders the
    list: every keystroke re-rendered the whole transcript and re-parsed every message's markdown.
    Measured before: **33 ms per keystroke empty, 100 ms with one long answer, 567 ms in a
    60-message chat**, and streaming into that chat blocked the main thread for **18.0 s of 22.6 s**
    (~12 fps). After: **33 ms flat** (the two-frame measurement floor) and **287 ms of 20.5 s**
    (~58 fps). Don't remove the memo.
- **The waiting state is a `ThinkingBubble`, not a spinner** — what the turn is DOING, shown three
  ways at once: a **phase icon** (`phaseOf` maps the latest tool to a label + lucide icon —
  "Reading the project", "Searching the project", …; `compact` with no tool yet reads "Writing the
  answer") inside a chip wearing a rotating gradient arc (`.qc-orbit`), the label under a sweeping
  highlight (`.qc-text-shimmer`), an elapsed pill once past 3s, and skeleton lines standing in for
  the answer. It replaced a `Loader2` + "Thinking…" line that sat under a SECOND spinner the tool
  trail drew — two spinners in an empty bubble — and then the plain three-dot version of that.
  All three animations run on `transform`/`background-position` only, so a minute-long wait costs
  no main-thread work while the answer streams behind it. Details that are load-bearing:
  - The skeleton uses **`.qc-skeleton`**, whose sweep is tinted with the FOREGROUND — the shared
    `.qc-shimmer` sweeps **white**, which is invisible on a light surface. Verified in both themes.
  - Widths are **rem, not %** (see the width bullet: the bubble is fit-content, where a % width has
    nothing to resolve against).
  - Under `prefers-reduced-motion` the label falls back to a **flat muted colour** — a frozen
    gradient over `color: transparent` is how that effect disappears entirely.
  - Once text starts arriving the indicator stays **mounted** (keyed, `compact`, moved below the
    answer) so its timer doesn't restart mid-answer, and elapsed is measured against a start
    TIMESTAMP rather than counted in ticks — a backgrounded tab has its timers throttled and a
    counter read 10s for a 35s wait.
- **The wait lists what it DID — `ActivitySteps`, with each call's target.** A long turn is long
  because the model is grepping and reading; one unchanging phase label above a skeleton reads as
  hung. Under the header the bubble now shows the calls in order — `Searched for **phaseOf**`,
  `Ran **npm run build**`, `Read **ChatPage.tsx**` — finished ones ticked, the newest wearing its
  phase icon. Load-bearing pieces:
  - **The target comes from the tool's INPUT, and only the server can see it.** `claudeExec.ts`
    `toolDetail()` picks the one interesting argument per tool (`file_path` → basename, Grep/Glob
    `pattern`, Bash `description ?? command`, WebFetch `url`, …), truncates it, and hangs it on the
    `StreamLog` as `tool: {name, detail}`. The log's `text` stays the bare `⚙ <name>` every other
    log consumer already renders — don't fold the detail into it. `routes/chat.ts` reads `log.tool`
    instead of re-parsing that text, and streams `{type:'tool', name, detail}`.
  - **`detail` is streamed, never persisted.** A saved `ChatMessage.tools` stays names-only (a Bash
    command line is exactly the kind of thing that shouldn't be written into the project repo), so
    a reopened transcript draws the plain `ToolTrail` chips. That trail is therefore hidden while
    streaming — otherwise the same calls appear twice, once with targets and once without.
  - Consecutive calls with the **same name AND target** collapse to `×N` (`stepsFrom`); different
    targets stay separate rows, since the target is the whole point. Only the last
    `MAX_VISIBLE_STEPS` show, above a `+N earlier steps` line.
- **The composer's `+` menu — per-MESSAGE actions** (`ComposerPlusMenu`, `CHAT_ACTIONS`,
  `ChatAction` = `web | research | diagram`; server side: `ACTION_BLOCKS`, `toolArgs(tools, action)`,
  `timeoutFor(tools, action)`). The paperclip moved in here ("Add photos & files"); the other three
  rows change how ONE turn runs and are cleared on send, so the follow-up after a web answer goes
  back to reading the project. What each needs is genuinely different, which is why it isn't a
  setting: **Web search** adds `WebSearch WebFetch` to the read-only allow-list (without that the
  model is DENIED the tool and answers from memory — the exact failure the action exists to prevent)
  and demands a Sources list; **Deep research** is the same tools with a report-shaped prompt
  (sub-questions → search → cross-check against a second source → Summary/Findings/Conflicts &
  gaps/Sources) and the longest budget, because a short one reliably produces half a report;
  **Create diagram** asks for one ```mermaid fence, rendered by `MermaidDiagram` (the same renderer
  `/diagrams` uses) via `mdComponents(renderDiagrams)` — **not while streaming**, since half a
  diagram is invalid Mermaid and the bubble would sit under a parse error for the whole turn.
  - **There is no image GENERATION**, and the menu must not pretend otherwise: the CLI has no image
    model, so the reference's "Create image" became "Create diagram" — the visual this tool can
    actually make, and the one QC work asks for (a flow, a state machine, a sequence).
  - The panel is **portaled into the composer WELL**, because the input card around the button row is
    `overflow-hidden` and a menu opening upward from inside it is sliced down to its last row
    (verified on screen — same trap the `@` menu documents). Click-outside therefore tests the
    trigger **and** the portaled panel, or a click on a menu row closes the menu on `mousedown` and
    unmounts the row before its `click` fires.
  - The action is **stored on the user message** (`ChatMessage.action`) and badged in the transcript,
    because "why does this answer cite the web?" has to be answerable a week later.
- **Temporary chat — a conversation that never reaches the project.** A normal chat's transcript is
  `testing/chats/<slug>.json` and gets committed with everything else; that's right for "how does
  this work?" and wrong for a throwaway question or one with a customer's data pasted into it. A
  temporary conversation therefore lives ONLY in the server's `temp` registry (in memory, like
  `crawlJobs` / `testcaseJobs`): no file, never in `listChats` (which reads the folder), dropped on
  end / `TEMP_TTL_MS` idle (6 h) / restart. Load-bearing details:
  - **`loadChat` / `saveChat` are the only accessors**, which is why every other feature keeps
    working for a temporary chat (multi-turn `--resume`, `GET /:slug/stream` re-attach, Stop,
    `@`-mentions — they all key on the slug). Never call `writeChat` from a route again, and
    `uniqueSlug` checks the registry as well as the folder or a new chat would resolve to the
    in-memory one.
  - **`temporary` is decided when the conversation is CREATED** and inherited by every later turn
    (`POST /stream` only reads the flag for a new chat). The UI mirrors that: the composer toggle is
    disabled once a chat exists, or half a "temporary" conversation would be on disk. `POST
    /:slug/pin` **refuses** — starring means "keep this", the opposite of the point.
  - **Deleting a chat aborts a turn in flight and marks it `discarded`**, so the turn's own save path
    (`persist()`) doesn't write the transcript back a moment after it was deleted.
  - **Pasted images are still real files** — the CLI Reads them — so the registry tracks the ones it
    wrote and `discardTemp` deletes them with the conversation. `TemporaryNotice` says exactly that
    much and no more: it does NOT claim there's no trace anywhere, because the Claude CLI keeps its
    own session transcript in the user's home folder. A privacy line that isn't exactly true is worse
    than none.
  - The client remembers only the **slug**, in `sessionStorage` (`qc.chatTemp.<projectId>`), because
    the rail can't point back at a chat it never lists — that's what lets a reload mid-answer
    re-attach. A slug the server has since dropped 404s, which the page treats as "no conversation"
    (`openSlug`, `retry: false`) instead of a dead transcript. Every way OUT of a temporary chat (End
    chat, New Chat, opening a saved one) goes through `forgetTemporary`, which DELETEs it server-side
    — otherwise it would sit in memory, screenshots and all, unreachable by any UI.
- **Star a conversation to pin it** — `POST /:slug/pin` sets `pinned` on the chat file; `listChats`
  sorts pinned first, then newest, and the rail renders them as a **"Starred" group above the date
  groups**. Two deliberate details: pinning does **NOT** touch `updatedAt` (that field orders the
  date groups, so starring would otherwise yank the chat into "Today" and rewrite when it was last
  worked on), and the star also draws **on the row**, because a search filters the group header off
  screen and "why is this one first?" needs an answer there.
- **Rename and delete are dialogs, not `window.prompt`/`confirm`** (`RenameChatDialog` /
  `DeleteChatDialog`). The native ones can't be styled, can't show *which* conversation is being
  renamed, and are suppressed outright in some browsers — which reads as "the menu item does
  nothing". Rename is keyed on its target so the field seeds without setState-in-effect, Enter
  saves, and Save is disabled while unchanged; delete names the conversation and says the transcript
  file goes with it.
- **"Ask next" — follow-up chips under the newest answer** (`FollowUps`), the Prototype page's
  `<!-- SUGGESTIONS: … -->` idea applied to a conversation. The model appends the marker to its own
  reply (`SUGGEST_BLOCK` in routes/chat.ts, up to 3 short prompts in the ENGINEER's voice), so they
  cost one line of output — **not a second AI call**, which would double the turns and make the user
  wait again after the answer already finished. `splitSuggestions` strips the marker before saving
  and stores the list on the assistant message; the marker is removed **no matter what**, so a parse
  failure means "no chips", never a raw HTML comment in the transcript. Three things hold it up:
  - The client also strips it **while streaming** (`stripSuggestMarker`) — the deltas carrying it
    reach the browser before the server ever saves, and the half-written `<!--` tail arrives frames
    ahead of the rest, so an unterminated comment is cut too. Verified per-frame over a whole turn:
    the marker is never on screen.
  - **The ANSWER settles before the TURN does** (`suggestMarkerStarted` → `answerSettled` in
    `AssistantRow`). Because the marker is stripped, the tail of every turn used to look hung: the
    text stopped growing while the caret blinked and the waiting indicator kept counting, for the
    seconds it took to write a line nobody sees. So the moment stripping starts removing something
    AND the reveal has caught up, the row renders as finished — no caret, no `ThinkingBubble`,
    `ToolTrail` and Copy back — and a separate `SuggestingChips` skeleton appears in the slot
    `FollowUps` will fill (same row markup, so the real chips replace it without the layout
    jumping). Measured on screen: caret+indicator at 0.8s → settled with Copy at 2.9s → real chips
    at 4.4s, and the raw marker never rendered once.
    Two things follow from it: Copy copies `body` (the stripped text), not `text`, which still holds
    the comment at that moment; and a **Stop pressed during that tail saves a NORMAL turn, not a
    failed one** (`routes/chat.ts` checks the buffer for `<!--`) — the answer was complete, only the
    chips were lost, and tinting it red would call a correct answer a failure.
  - The strip renders **outside `Turn`**, keyed off `chat.messages` (not the `?? []` fallback, whose
    identity changes every render). Hanging it on the last message would give that memoised row a
    prop that changes as the conversation moves — see Turn's note. Measured: typing stays at the
    33 ms two-frame floor with chips on screen.
  - **Newest answer only**, and a click **sends** — unlike the empty-state quick prompts (which are
    half-written and need a real ticket id typed in), a follow-up is a complete question.
- **Each turn is signed — `RowAvatar` + `RowName`** — the assistant's mark is the portal's solid
  chip (`bg-foreground text-background` + Sparkles) on the left with **"AI Assistant"** over the
  bubble; the user gets a quiet outlined chip on the right under **"Me"**. The avatar is
  `aria-hidden` **because** the name beside it is real text — labelling both makes a screen reader
  announce every speaker twice. The avatar has no top margin so it lines up with the name line.
- **Every message carries its time** (`MessageTime`) — time of day, plus the date when it isn't today,
  full stamp in the `title`. The user's shows under the bubble; the assistant's sits in the footer
  beside Copy with the model that answered. The in-flight turn stamps `pending.at` at send, so the
  time doesn't pop in only once the answer saves — and that same value is what the elapsed reading
  counts from.
- **Code in an answer is a `CodeBlock`** (`web/src/components/CodeBlock.tsx`) — language label,
  **Copy** button, syntax colours. The swap happens on markdown's **`pre`**, not `code`:
  react-markdown v9 dropped the `inline` prop, so `pre` is the only reliable "this was a fenced
  block" signal — keying off `code` and guessing from "contains a newline" renders a one-line fence
  as an inline pill. Highlighting arrives a beat after mount (lazy import) and is stamped with the
  code it came from, so a streaming answer falls back to plain text instead of showing the previous
  frame's markup; it must never be why code doesn't appear.
- **The quick chips are category EXPANDERS, not one-shot prompts** — verified against the reference:
  clicking a chip replaces the chip row with that category's four concrete prompts (bold verb
  `prefix` + muted `rest`), and clicking one **types it into the composer instead of sending**, then
  restores the chips. The list is absolutely positioned over the chips' slot so the composer doesn't
  jump. Typing-not-sending is the point: "the newest crawled ticket" usually wants a real ticket id
  first. The reference dead-ends once a category is open (no way back to pick another), so Escape and
  an outside click also restore the chips — no extra control on screen.

## Database page (read-only SQL console + Ask AI)

**`/database` (`DatabasePage.tsx`, `routes/database.ts`, `dbConnect.ts` + `dbQuery.ts`)** — connect a
project's databases (Postgres / MySQL / SQL Server), browse the schema, run SELECTs, or ask a question
in English. **Everything about it is read-only** — see "The Database page must never be able to write"
under Critical constraints; that section is the contract, this one is the page.

- **The connected badge is a live `SELECT 1`** (`pingDatabase` → `GET /api/database/health`, per card).
  It used to be the literal word "connected" on every registered row, so a stopped server, a closed
  SSH tunnel and a rotated password all still read green — the one badge on the page that has to be
  believable. Three states, because "checking" is not "up": showing green while the first probe is in
  flight recreates the original bug in miniature. The failure keeps its reason in `title`.
- **`new mssql.ConnectionPool(...)`, NEVER `mssql.connect(...)`** — in `dbQuery.ts` *and*
  `dbConnect.ts`. The global helper honours its config only on the FIRST call and hands every later
  concurrent caller that first pool, which a project with two SQL Server databases reaches just by
  touching both at once. Verified: pinging two databases concurrently made the one on port 1434 report
  a connect failure for 1433. The dangerous case is the one that doesn't error — a query meant for
  database B answered from database A, on a page whose entire purpose is "what's in the data?".
  `pool.close()` had the same shape of bug (it closed the shared global pool mid-query elsewhere).
- **The SQL editor is a `<textarea>` with three agreeing layers** (`SqlEditor.tsx`): gutter | coloured
  `<pre>` (aria-hidden) | transparent-text textarea with the real caret. A code-editor dependency is
  ~200 KB for one panel, and the repo already owns both halves (`lib/highlight.ts`, and the keyboard-
  menu pattern from the chat composer's `@` picker); the textarea keeps native undo, IME and
  accessibility. The layers share font, size, line-height, padding and `whitespace-pre`, and scroll is
  mirrored — any metric change slides the painted glyphs off the real ones. **No wrapping**, or the
  gutter can't line up (one logical line becomes N visual rows). The chat composer's `ComposerPaint`
  is the same overlay trick; both document the `transform`-not-`scrollTop` trap.
- **Completion comes from the LIVE schema** (`GET /api/database/schema`, cached per database per
  session with an explicit refresh), because nobody remembers whether the column is `CreatedAt`,
  `CreatedAtUtc` or `created_at`. `lib/sql-complete.ts` is pure functions so it can be exercised
  without mounting an editor. A schema that fails to load costs suggestions, **never** the ability to
  run a query — treat `tables` as possibly empty rather than gating on it. Column names only; no data
  leaves the database on that route.
- **A refusal is a dialog, not the inline red strip** — `ReadOnlyViolation` carries a `blocked`
  `{kind, keyword?, preview?}` to the client so `WriteBlockedDialog` can say what was detected and
  that nothing was sent. **Confirming runs nothing**; the only real action is running the AI's SELECT
  preview of the rows the refused change would have hit.
- **Ask AI runs in a NEUTRAL cwd with the tools taken away.** Generating SQL is schema + question in,
  one SELECT out — it needs no project files, and running it in the project folder loaded that
  project's CLAUDE.md, memory and skills into every question ($0.63 vs $0.36 on the same question).
  `NO_TOOLS` is named in `--disallowedTools` for the same reason the Prototype builder does it: the
  page's premise is that the AI can't write anything, and it was being handed Bash/Write/Edit in the
  repo. The budget is **sized from the prompt** (`budgetForPrompt`) because the schema IS the prompt
  and grows with the database — a 158-table SQL Server came to 78 KB, and the old flat $0.25 cap fires
  AFTER the turn, so a correct query was written, paid for and then thrown away as
  `error_max_budget_usd`. `salvageClaudeJson` (claudeExec.ts) recovers exactly that answer.
- **Result export is fully-quoted RFC-4180 CSV** (`toCsv`) — always quoting is what keeps an address,
  a note or a JSON blob from silently corrupting the file. SQL history is per project **and** per
  database (`qc.databaseSqlHistory.*`, 25 entries); history from another DB is noise.

## Notes page (a scratchpad that lives with the project)

**`/notes` (`NotesPage.tsx`, `NoteEditor.tsx`, `routes/notes.ts`, `notesStore.ts`)** — Keep-style
cards for the things that aren't Knowledge or Memory: a checklist for today, a scratch reproduction,
a reminder before the next release. Knowledge/Memory are read by every AI run and are worth writing
carefully; **notes are not injected into any prompt**, which is exactly why the page can be casual.

- **One JSON document per project** at `testing/notes/notes.json` (notes + labels), written temp-file
  + rename so a crash can't leave a half-written file. `normalize()` tolerates anything malformed
  rather than throwing the page away, and the caps (500 notes / 200-char title / 100 KB body) are
  enforced in the store, not the UI. Routes: `GET /api/notes`, `POST /`, `PATCH /:id`, `DELETE /:id`,
  plus `POST`/`PATCH`/`DELETE /labels…` and `DELETE /trash` — which **must stay above `DELETE /:id`**,
  or a trash-empty is read as deleting a note with the id `trash`.
- **Archive and trash are flags, not deletions** (`archived` / `trashed`), so the sidebar's Archive
  and Trash views are filters over one list and a restore is a `PATCH`. Emptying the trash is the
  only destructive action, and it's behind a confirm dialog.
- **The editor is TipTap, lazily imported** — it plus lowlight is heavy and only the note dialog
  needs it, so `NoteEditor` is a `lazy()` behind a `Suspense`. Bodies are HTML; `lib/noteHtml.ts`
  `LOOKS_LIKE_HTML` tells a rich-text body from a legacy plain-text one so old notes keep rendering.
- **Editor and card share ONE typography block** in `index.css` (`.note-editor .tiptap` + `.note-body`),
  so what you type is what the card shows. The block-spacing selectors are deliberately **doubled**
  (`.note-body.note-body > * + *`) to out-specify the per-element `margin: 0` resets beneath them —
  a plain `>` selector lost on specificity and every paragraph after the first rendered with no gap
  (measured 0px between consecutive `<p>`, while `<ul>`, which has no reset, correctly got 11.25px).

## Shell chrome — theme, page search, and the app mark

- **Light/dark is a real toggle** (`components/ThemeToggle.tsx` + `lib/theme.ts`), stored in
  localStorage as `qc.theme` and falling back to the OS setting until the engineer picks one. The
  class goes on `<html>` (Tailwind v4's dark variant is `.dark *`) and is applied by an **inline boot
  script in `web/index.html` before first paint** — without it the app renders light and snaps to dark
  a frame later. That script and `theme.ts` read the same key: change one, change the other. The hook
  seeds its state by reading the class off the DOM, so mounting can't flash the wrong theme.
- **The sidebar has a type-to-filter** (`NavFilter`, ⌘/Ctrl+K; ⌘/Ctrl+B collapses the rail) matching
  on the page label **and** its group name, so "testing" finds the whole Testing group. Both shortcuts
  are skipped while typing in a field so they can't hijack a page's own input, and Enter opens the
  first match. Collapsed, the input is replaced by a button that expands the rail and focuses it.
- **`AppLogo` is a solid with negative space** — a scalloped certification seal with the check knocked
  out through a `<mask>`, not a lucide-weight line drawing (a line icon reads as one item borrowed
  from an icon set, and hairlines dissolve at 16px). The mask id comes from `useId` because two can
  legitimately mount at once. **Its geometry is duplicated in `web/public/favicon.svg`** (plus the PNG
  fallback and the apple-touch icon) — change one, change all of them.

## QC AI Labs (curated shelf of AI tools)

**`/ai-labs` (`AiLabsPage.tsx`, "QC AI Labs" under the sidebar's Tools group)** — the one **reading**
page in the portal: which AI products are worth a QC engineer's time, what each is for, and where it
doesn't pay off. No server route, no query, no project scope — it renders a constant.

- **Two routes, both bare:** `/ai-labs` (`AiLabsPage`, the shelf) and **`/ai-labs/:id`
  (`AiLabDetailPage`, one tool)**. A card is a LINK, not a dialog — the detail page carries the
  **install and usage guide**, and a guide with commands in it is something people leave open beside
  a terminal, bookmark, and send to a teammate, none of which a modal can do. An unknown `:id`
  renders a "not on the shelf" card rather than throwing; the URL is hand-editable.
  Shared data lives in **`lib/ai-labs.ts`** (types + `CATALOG` + `findTool`), the dark surface and
  the small shared pieces in **`components/ai-labs-ui.tsx`** (`LabShell` also owns `document.title`).
- **`install` / `usage` are the reason the detail page exists** — a recommendation nobody can act on
  is a link dump. Every command in them was RUN on a machine before it was written down (the
  `@anthropic-ai/claude-code` + `@saigontechnology/auto-agent` pair, `auto-agent-ai login`, the
  unpacked-extension steps). Keep it that way, keep one idea per step, and keep the vendor link
  visible so a drifted command has somewhere to go. Step bodies take `` `code` `` and `**bold**`
  through a 10-line `renderInline` — don't pull in react-markdown for two paragraphs.
- **It renders OUTSIDE the shell.** `App.tsx` is a two-branch router — `/ai-labs` → the page bare,
  `*` → `AppShell` (sidebar, bell, page padding, every other route). The page is its own destination
  and the portal's chrome around it filed it as just another settings screen. The **job watchers sit
  in `App`**, above both branches, so a crawl or test-case job finishing still notifies while you're
  reading here — they render nothing, so the bare page pays nothing for them. The only tie back is one
  ← in its header (detail → shelf, shelf → portal): a destination with no way out is a trap.
- **It carries its own always-dark theme, in literal colours, on purpose.** Semantic tokens would make
  it follow the portal's light/dark setting, and the page is deliberately not a portal surface. This
  is the ONE place ignoring the token system is correct — don't "fix" it back to
  `bg-card`/`text-muted-foreground`, and don't copy its palette into a page inside the shell.
- **It is PLAIN, and that was a correction.** The first version had drifting aurora, an animated
  gradient headline, cursor-tracked spotlights, glowing card edges, a stats row and a fit dial; over a
  shelf of two entries that read as decoration around very little ("xến xúa" was the verdict), so all
  of it came out — along with the search box, category rail, sort control and shortlist, which were
  machinery for a catalog that doesn't exist yet. What's left is the writing on a quiet dark surface.
  If something here seems to need an animation to hold attention, the fix is better copy.
- `ui/dialog.tsx` gained an **`overlayClassName`** prop for this page (the default 50% black scrim
  doesn't sit far enough back from a dark surface). Additive — every existing dialog is unchanged.
- **`CATALOG` is a hand-written constant, on purpose.** There is no vendor feed to fetch, and a
  curated shelf is only worth reading *because* a human picked the entries. Adding a tool = one
  object (pitch, category, fit, flags, `what`, `useCases`, `strengths`, `limits`, url). Keep
  `useCases` job-shaped ("reproduce a bug report step by step"), not feature-shaped — the jobs are
  what make it a shelf rather than a link dump.
- **It holds exactly two entries** — Claude Code and **AI Form Filler** (our own Chrome MV3
  extension, `builtHere: true`, repo `haonguyenstech/ai-form-filler`) — because the shelf is a
  recommendation, not an inventory. Grow it past a handful and search/filter/sort earn their way
  back; until then don't add controls for two cards.
- **The fit score is an OPINION and the page says so** — it renders as `QC fit 96/100 · our take`,
  and the footer repeats it. It used to be a gradient ring; a dial implies an instrument took a
  reading. Don't dress it up as data (no benchmark framing, no decimals, no leaderboard).
- **`limits` ("Watch out for") is not a disclaimer** — it's the half a vendor's own page omits, and
  the reason a reader trusts the shelf. Every entry has at least two.
- `inPortal` flags what this portal already runs on; `builtHere` flags what we wrote ourselves.

## Terminal page (device shell)

**`/terminal` (`TerminalPage.tsx`, "Terminal" under the sidebar's Tools group)** — a real
pseudo-terminal on the machine running the server, rendered in-browser with **xterm.js**
(`@xterm/xterm` + `@xterm/addon-fit`). **Connect** spawns the user's login shell
(`$SHELL -l`, or `%ComSpec%`/PowerShell on Windows) with `cwd` = the **active project's root** via
**`node-pty`**, bridged over a dedicated **`/ws/terminal`** WebSocket. It behaves like a native
terminal (interactive TUIs work — the page auto-runs `claude --dangerously-skip-permissions` on
connect).

- **Several terminals at once** — the page is a **tab strip** (`TerminalTabs`) over one `TerminalPane`
  per tab, each pane its own `useXtermSession` connected with `?tab=<id>` → its own shell + Claude
  session. Inactive panes stay **mounted but `invisible`** (not `hidden`: xterm's fit addon needs a real
  size), so switching tabs is instant and nothing is replayed. Tabs are persisted per project in
  `localStorage` (`qc.terminalTabs.<projectId>`, capped at `MAX_TABS` = 6) and the whole workspace is
  mounted with `key={projectId}`, so each project has its own set. A shell the server still has whose id
  isn't in localStorage is **derived back into the tab list on render** (no setState-in-effect). Header
  controls (status pill, Connect/Re-attach, Disconnect, Slash commands) act on the **active** tab via an
  imperative `PaneApi` registry (`apis` ref); the **×** on a tab is what ends its shell.
- **One viewer per session, and never a tug-of-war** — attaching kicks whatever socket was attached,
  closing it with code **`WS_CLOSE_TAKEN_OVER` (4001)** so the loser can tell "someone took this over"
  from "my connection dropped". That distinction is load-bearing: the client re-attaches on its own, so
  with a generic close two windows on `/terminal` steal every session back and forth forever
  (`lastActivityAt` churning every ~2 s, the UI flapping Connected → Disconnected → Connecting…). The
  client therefore **never auto-attaches a session another window holds** (`attached` from
  `/api/terminal/sessions`, polled every 3 s — offering "Take over" instead) and stops auto-retrying
  after `AUTO_CONNECT_ATTEMPTS` (3). On the server, `pruneDeadViewer()` drops a viewer whose socket is
  no longer OPEN before reporting or attaching — a missed `close` event would otherwise leave a session
  permanently "open in another window" with nobody watching it.
- **Sessions persist across navigation** — the pty **outlives its socket**. `terminal.ts` keeps a
  registry keyed by `sessionKey(req)` (`shell:<projectId>#<tab>` for the page, `run:<runId>` for Continue
  session): leaving the page / reloading / a dropped socket only **detaches**, and the next connection
  **re-attaches** to the same shell, replaying the last 256 KB of output. A session ends only on an
  explicit `{type:'kill'}` (the **Disconnect** button), the shell exiting, 6 h detached (`IDLE_MS`),
  eviction past `MAX_SESSIONS` (16, oldest detached first), or shutdown — `gracefulExit` calls
  `killAllTerminalSessions()`, without which restarts orphan setsid'd shells. `GET /api/terminal/sessions` lists what's alive, and
  `TerminalPage` uses it to auto-re-attach each tab on mount and to label the button **Re-attach** vs
  Connect. On re-attach `useXtermSession.connect({reattach:true})` **skips `initialCommand`** — replaying
  it would type the launch line into the Claude session already running in there. Auto-connect is
  **status-driven, not latch-based** (fires only while a pane is `idle`, and only after
  `isFetchedAfterMount` so a cached "still alive" from before a server restart can't spawn a launch-less
  shell); a pane the user disconnected is never resurrected (`userEnded` ref), and "just created by the
  user" is dropped from `freshIds` on first connect so an exited shell isn't respawned in a loop.
- **WebSocket protocol** — server→client frames are **raw terminal bytes** (`term.write`); client→server
  frames are **JSON control** messages: `{type:'input',data}` for keystrokes, `{type:'resize',cols,rows}`
  on fit, and `{type:'kill'}` to end the session (plain socket close keeps it running). Connection query
  params: `projectId` (or `runId`), `cols`, `rows`.
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
  node-pty's child is a setsid session leader) so `claude` *and the MCP servers it spawns* die when the
  session is destroyed, escalating SIGTERM→SIGKILL. Don't downgrade this to a bare `pty.kill()` — that
  leaves MCP children orphaned. Note this now fires on **session destroy**, not on socket close:
  navigating off `RunDetailPage` leaves the resumed session running (keyed `run:<id>`) and coming back
  re-attaches; **Disconnect** is what ends it. See the Terminal page's session-registry bullet.

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
