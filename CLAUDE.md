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
  contextPointer.ts managed CLAUDE.md pointer block linking Knowledge + Memory (keeps CLAUDE.md lean)
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
  projectContext.ts readProjectContext(root): packs testing/memory/*.md + testing/knowledge/*.md
                    into one capped block injected into prompts (test-case gen + grounding) so the
                    model uses real project terms/rules even when there's no project cwd
  learn.ts          AI auto-capture: reflect on a finished QC run / test-case gen and persist
                    durable facts into memory (+ knowledge), tagged with a source provenance
  groundingCheck.ts independent post-write audit (anti-hallucination): groundTestcases (cases vs
                    ticket) + groundReport (report verdicts vs documented evidence); auto-revises
                    in place. Cheap (haiku), best-effort, never throws — see section below
  routes/           projects, qc, files, skills, mcp, clickup, source, ai, templates,
                    knowledge, memory, diagrams, prototype, version

web/src/
  App.tsx           sidebar nav + React Router routes + ProjectSwitcher + always-mounted
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
                    MermaidDiagram (lazy mermaid render, used by DiagramsPage),
                    OpenFolderButton (reveals a project folder in the OS file explorer),
                    dialogs (RunPresetsDialog, ManageHintsDialog, TicketPicker, …)
  lib/
    api.ts          typed fetch wrapper — ALL backend calls live here
    types.ts        shared API types
    project-context.tsx  useProjects() — active project + list, persisted
    notifications.tsx    NotificationProvider + useNotifications() — bell store, localStorage-backed
    testRules.ts    DEFAULT_RULES + useTestRules() + buildInstructions() for test-case prompts
    apiAssert.ts    evaluateAssertions()/getJsonPath() — the API-Testing assertion engine,
                    shared by the request builder and the flow runner (see "API Testing
                    flows"); one copy on purpose, so a step can't grade differently
    devices.ts      describeDevice()/devicesFromDetection() — labels one Maestro `list_devices`
                    entry for a picker (name primary, device_id only in the caption; AVD
                    underscores humanized). Shared by the MCP page's functional-test dialog
                    and the Run form's device picker so a device reads the SAME in both.
                    See "Picking the device a mobile run drives" below.
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

**`/overview` (`OverviewPage.tsx`)** — the project's free-text **intro** (markdown, persisted on
`projects.description`) and an AI **"Generate from ClickUp"** picker (overview mode). Editing the
intro hides the generator; a generated draft lands in the editor for review before saving. (The AI
**knowledge documents** section moved to `/instructions` → Knowledge tab — see that section above.)

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
