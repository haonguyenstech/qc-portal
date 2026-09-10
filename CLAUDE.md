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
8. **Publish the desktop installers** — `bash installer/publish-release.sh`. A release without
   them is not finished: the README's download buttons then hand out the PREVIOUS version's
   installers, still working, just older than the tag says. See the next section (and build
   the `.exe` on Windows first; the script tells you how).

End users upgrade with `qc-portal --update` (git fetch + hard-reset to the upstream branch,
then `npm install` + `npm run build`; see `bin/qc-portal.mjs`), or the **Release notes** page's
"check for updates" / "update now". That path stops the server BEFORE it rebuilds, so every
step is bounded and every failure restarts the previous version — a failed update must
degrade to "still on the old version", never to a portal that is gone. See
"Self-update" in `docs/architecture/layout.md` before touching it. So a release isn't usable until both the commit and the tag
are pushed.

### Shipping the desktop installers (`.exe` / `.dmg`)

The portal also ships as a **desktop app**: the installers leave a *QC Portal* icon behind
(Desktop + Start Menu on Windows, `~/Applications` + Launchpad on macOS) and that shortcut
runs **`qc-portal --app`**, which shows the portal in a chromeless Chromium window instead of
a browser tab. Read `docs/architecture/installer.md` and `pwa.md` before touching any of it.
The rules that bite:

- **The installers are thin, and must stay thin.** `install.ps1` / `install.bat` /
  `install.sh` at the repo root are *the* install — one implementation. `installer/` only adds
  packaging and shortcuts, and `qc-portal.iss` bundles `..\..\install.ps1` **itself**, not a
  copy. Nothing bundles Node or the built app: the install stays an ordinary **git checkout**,
  which is the only reason `qc-portal --update` still works. Package it into a blob and that
  whole self-update path has to be replaced by a signed updater feed.
- **Every `.ps1` and the `.iss` are pure ASCII.** PowerShell 5.1 (what Windows 10 ships) reads
  a BOM-less `.ps1` as ANSI, so a UTF-8 em dash decodes to a **curly quote — which 5.1 treats
  as a string delimiter**. One em dash in a comment and the file will not parse. This was
  measured, not theorised: it broke `shortcut.ps1` and `uninstall.ps1` outright. A BOM would
  also fix it, but a BOM is invisible and one tool that strips it brings the bug back silently.
- **`installer/*/dist/` is gitignored — the artefacts are GitHub release assets.** A 2 MB
  `.exe` per release would live in the git history for ever.
- **Each artefact is uploaded TWICE, under two names**, and both are load-bearing:
  `QC-Portal-Setup-X.Y.Z.exe` / `QC-Portal-Installer-X.Y.Z.dmg` are the ones to hand to a
  person — the filename says which version it is, which matters the moment two of them are in
  someone's Downloads folder. `QC-Portal-Setup.exe` / `QC-Portal-Installer.dmg`, with **no
  suffix**, are what the README's buttons reach through the version-independent
  `releases/latest/download/<name>`; GitHub resolves that by **exact filename**, so that pair
  must never gain a version — rename it and every published link breaks silently. The
  mirror-image failure: a release whose assets were never uploaded leaves those buttons
  serving the **previous** release's installers, still working, just older than the tag says.

So after the tag is pushed, **`bash installer/publish-release.sh`** does the lot: builds the
`.dmg`, makes the versioned copies, uploads all four assets to `vX.Y.Z` with `--clobber`, and
then re-checks that `releases/latest/download/...` still returns 200 for both stable names. It
refuses to publish half a release, and `QC_DRY_RUN=1` builds and prints without uploading.

The one thing it cannot do is build the `.exe` — **Inno Setup only runs on Windows** — so
compile that there first and copy it into `installer/windows/dist/`; the script prints the
exact commands when it is missing. Note ISCC lands under `%LOCALAPPDATA%\Programs\Inno
Setup 6` when winget has no admin rights, not `Program Files (x86)`. Clone `main` for that
build so the `.exe` wraps the `install.ps1` that actually shipped.

Neither artefact is code-signed, and the two warnings differ, so tell users the right one.
Windows SmartScreen says "unknown publisher" (*More info* → *Run anyway*). macOS **refuses
the double-click**, and the old *right-click → Open* bypass **no longer exists** (removed in
macOS 15) — never write it down. Measured facts, because this went wrong twice: the block is
the **quarantine flag a browser sets**, not `spctl` (it reproduces with
`spctl --status: assessments disabled`), and not the missing signature as such — an
*unquarantined* copy of the same image double-clicks fine. So an image handed over on a USB
stick, a share or a sync client shows no warning at all, and the locally created
`~/Applications/QC Portal.app` is never blocked either. For a browser download there are only
two answers: *System Settings → Privacy & Security → Open Anyway*, or **notarise**. The dmg's
payload is therefore an `.app`, not a `.command` — a bare script cannot be notarised, an app
bundle can — and `build-dmg.sh` does sign + notarise + staple when `QC_SIGN_ID` and
`QC_NOTARY_PROFILE` are set. That needs an Apple Developer ID ($99/yr); Windows needs a
code-signing certificate.

Also: **app mode has no browser toolbar, so it has no download popup.** Any new export must
`toast` and name the file, or it saves into `~/Downloads` in total silence and reads as a
button that does nothing.

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
  tunnel.ts         Remote access: publishes the portal to a public HTTPS address by running
                    `cloudflared` (quick / connector-token / named tunnel). REFUSES to start
                    without an access password.
  remoteAccess.ts   the gate in front of that tunnel — a locked visitor gets one unlock page
                    and NOTHING else, not even the JS bundle. Its middleware must stay ahead
                    of every router AND of express.static in index.ts
  qcBrowser.ts      the portal-owned browser Playwright MCP attaches to over CDP
  playwrightRunMode.ts  per-RUN headless/headed browser choice (a per-run MCP config; never
                    rewrites the project's .mcp.json)
  autoAgent.ts      Auto Agent (shared Claude credential) status — read-only probe
  autoAgentCli.ts   RUNS `auto-agent-ai login` / `logout` for the sidebar's Connect /
                    Disconnect buttons. Sign-in is a POLLED in-memory job (the Microsoft
                    step is a loopback OAuth flow in the user's browser); the watcher the
                    CLI starts is detached, so no terminal has to stay open. Output is
                    ANSI-stripped, scrubbed and kept in memory only.
  k6.ts pageAudit.ts perfJobs.ts   Performance page: k6 load tests + browser page-load
                    audits (+ their shared job registry). The generated k6 script and its
                    summary live BESIDE THE DB, never in a repo, and credentials reach k6
                    through the environment so they never touch that file. k6's summary
                    has NO time series, so the script buckets its own samples into a fixed
                    metric set (`timeBuckets`, shared by the generator and the parser) —
                    that is the only reason "did it degrade under load?" can be answered.
                    The same trick gives the response-time HISTOGRAM (`LATENCY_EDGES`,
                    also shared both ways) — percentiles carry five numbers and cannot
                    carry the SHAPE of a distribution. `pageAudit.ts` keeps a FIRST
                    visit and a RETURNING one apart end to end (`cold` / `warm`, warm
                    being a per-metric MEDIAN): their mean is a load that never
                    happened. It also records CLS, blocking time, uncaught JS errors,
                    and a cold-load request TIMELINE — the only thing on that page that
                    says WHEN rather than how long.
  authSession.ts reportExport.ts    Performance page: the "sign in first" window (a headed
                    Chrome on the audit's own profile — closing it is what saves the session)
                    and report export (the CLIENT's report HTML → PDF via headless Chrome,
                    → .docx via html-to-docx with each chart FIGURE — svg plus its
                    legend — rasterised first; an optional running footer goes on
                    EVERY page via Chrome's displayHeaderFooter / html-to-docx's
                    4th argument, and is stripped to plain text first. The .docx is
                    then REPAIRED (`repairDocx`): html-to-docx emits fractional
                    `w:w` widths and `w:*="undefined"` page margins, and OOXML
                    measurements are integers — Word refuses the whole file over
                    either, while `textutil`/XML parsers read it happily).
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
  mailbox.ts        MailBox: a disposable inbox (Guerrilla Mail's JSON API — YOPmail has no
                    API at all). The session token is stored BESIDE THE DB, never in a repo,
                    and never reaches the browser. `get_email_list` is the LIST call;
                    `check_email` is a delta and answers empty on the second call
  totp.ts apiAccounts.ts   2FA seeds + API login accounts — stored BESIDE THE DB, never in a repo
  clickup.ts folderPicker.ts projectScope.ts toolPath.ts mobileDevices.ts
  routes/           projects, qc, files, skills, mcp, clickup, source, ai, templates,
                    knowledge, memory, notes, database, diagrams, prototype, chat,
                    performance, version, remote

web/src/
  App.tsx           two branches: `/ai-labs` renders BARE, everything else via AppShell; the job
                    watchers sit in App above both so jobs still announce on the bare page
  main.tsx  index.css (Tailwind v4 oklch tokens, light + .dark)
  pages/ components/ components/ui/ (shadcn primitives)
  lib/  api.ts (ALL backend calls) types.ts project-context.tsx notifications.tsx theme.ts
        pwa.ts (registers the service worker that makes the portal installable —
        it caches NOTHING on purpose; see docs/architecture/pwa.md)
        testRules.ts highlight.ts apiAssert.ts devices.ts sql-complete.ts noteHtml.ts
        mailbox.ts  (MailBox: OTP/verify-link extraction — RANKED, never filtered, by
        distance to the nearest code word; the mail body itself is rendered in a
        `sandbox=""` iframe and must stay that way)
        utils.ts useRunStream.ts useXtermSession.ts
        clickup-filing.ts + components/ClickupFilingBar.tsx  (filing a finding to ClickUp:
        the severity->priority map, the error wording, and the parent field + inherit
        preview + create call. ONE implementation for the run Issues tab AND Design
        Check — a second copy drifts, and then the priority shown before filing stops
        matching the one applied)
        perfReport.ts perfCharts.ts perfReportHtml.ts  (Performance: verdict bands, derived
        metrics (peak RPS, drift, phase shares) + MEASUREMENT_NOTES /
        PAGE_MEASUREMENT_NOTES, the SVG charts — bars, lines, stacks and the page
        WATERFALL, ONE y axis each — and the printable report. ONE source
        for screen, Markdown, PDF and Word. `warmMetrics`/`coldMetrics` are how a
        first visit and a returning one stay apart; any ratio check needs an
        ABSOLUTE floor or a 4ms API with one 92ms call grades the run Poor)
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
  `auth.accessToken` and the distributed Claude credentials and must never be opened. It also
  stays a pure filesystem probe — the sidebar polls it every 30s; spawning the CLI belongs in
  `autoAgentCli.ts`.
- **`parseClaudeJsonResult` must accept BOTH `--output-format json` shapes** — a single
  `{type:'result',result,is_error}` object (older CLI) and the whole message ARRAY ending in that
  object (current CLI). Reading `.result` off the array yields undefined, which all ~12 callers
  report as "the AI produced nothing". Don't narrow it back to one shape.
- **Every child spawn goes through `toolPath.ts` `spawnEnv()`** (PATH augmented with `~/.local/bin`,
  `~/.cargo/bin`, WinGet Links, `%APPDATA%\npm`, bundled emulator adb) so uvx/npx MCP servers start
  under a stale PATH. Never spawn with a bare `{ ...process.env }`. **And never end one with a bare
  `child.kill()`** — on Windows the child is the `cmd.exe` shim around a `.cmd`, so the real process
  outlives the kill: use `killSpawnedTree()` (same module), or `claude.ts`'s `killTree` for a
  detached spawn.
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
| `/mailbox` — the disposable inbox, OTP/link extraction | `mailbox.md` |
| the sidebar/theme/app mark, or `/ai-labs` | `shell-and-ai-labs.md` |
| `/terminal` or Continue session (resume a run's session) | `terminal-and-sessions.md` |
| the portal-owned QC browser / Playwright attach mode | `qc-browser.md` |
| `/remote` — publishing the portal over a Cloudflare Tunnel, and the access gate in front of it | `remote-access.md` |
| installing the portal as a desktop app (the manifest / service worker) | `pwa.md` |
| the installers, the `.exe` / `.dmg`, desktop shortcuts | `installer.md` |

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

- **Localhost only by default.** The server binds `127.0.0.1` and there is no auth on that
  path — do not add network exposure. The ONE sanctioned way out is `/remote`: a Cloudflare
  Tunnel (`tunnel.ts`), which is an OUTBOUND connection, so the bind address is unchanged and
  no port is forwarded. It ships welded to the access gate in `remoteAccess.ts` and **neither
  half may be softened**: the portal spawns `claude` with permissions bypassed and hands out a
  shell, so a public URL without a password is remote code execution, not a convenience.
  Concretely — the tunnel refuses to start with no access password; a request arriving through
  Cloudflare without a valid session gets the unlock page and nothing else, the JS bundle
  included (so the guard stays ahead of `express.static`); the WebSocket upgrade is gated
  separately or a shell could be attached around HTTP; and the password cannot be removed while
  the tunnel is up. Read `docs/architecture/remote-access.md` before touching any of it.
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
| `QC_CLOUDFLARED_BIN` | _(unset)_ | explicit path to the `cloudflared` binary, for an install the PATH lookup can't find (Remote access) |
| `QC_REMOTE_FORCE_GUARD` | `0` | treat EVERY request as if it arrived through the tunnel, so the access gate can be tested without publishing one. A development switch, not a security control |
| `QC_AUTO_AGENT_BIN` | _(unset)_ | explicit path to the `auto-agent-ai` CLI, for an install the PATH lookup can't find (sidebar → Auto Agent → Connect) |
| `IMGBB_API_KEY` | _(unset)_ | free imgbb API key (api.imgbb.com); when set, issue screenshots upload to imgbb and their URLs are embedded in the ClickUp comment — a workaround for a workspace that has hit ClickUp's "Over allocated storage" limit (`GBUSED_005`) |
