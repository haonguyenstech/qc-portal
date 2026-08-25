<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->


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
  qcBrowser.ts      THE QC BROWSER: one long-lived browser window the PORTAL owns, which
                    Playwright MCP attaches to over CDP (--cdp-endpoint) instead of
                    launching its own. Fixes two things a stdio MCP cannot: pressing Stop
                    killed the `claude` child, which tore down its MCP servers, which
                    CLOSED the browser (so there was no way to pause a flow, fix a step and
                    continue); and the MCP's own window was never full screen. Spawned
                    DETACHED so it outlives both the turn and the portal; ensureQcBrowser()
                    ADOPTS one already answering on the port rather than starting a second
                    (Chrome refuses two instances on one profile). maximizeQcBrowserWindow()
                    does the sizing over CDP because `--start-maximized` is a NO-OP on macOS
                    (verified: windowState 'normal', page 1619x936 on a 2560-wide screen).
                    Also writes the `--config` file that makes a SELF-LAUNCHED browser
                    maximize with `viewport: null`. See the section below.
  playwrightRunMode.ts  PER-RUN headless/headed browser choice for a web QC run. Writes a
                    COMPLETE copy of the project's MCP servers with only the Playwright
                    entry's mode swapped, handed to the CLI as `--mcp-config <file>
                    --strict-mcp-config` — strict is what makes the override win (duplicate
                    server-name precedence between the two configs is undocumented), which is
                    also WHY the file must hold every server or a run loses ClickUp/Jira
                    mid-way. Returns no override at all when the project already runs in the
                    requested mode (so the common case spawns byte-for-byte as before) or
                    when Playwright is attached to the QC browser (`--cdp-endpoint`), where
                    `--headless` describes a launch that never happens. NEVER rewrites the
                    project's .mcp.json — that's the engineer's saved default, and chat reads
                    it concurrently. The run's mode is persisted on the row (`runs.headless`)
                    so a paused run resumes headless instead of popping a window.
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
  runManager.ts     in-flight run lifecycle (spawn, stream, shutdown) + which on-disk folder
                    a run's output lives in (see "One run, one output folder" below)
  terminal.ts       device pseudo-terminal: node-pty shell bridged over /ws/terminal; sessions
                    persist across page navigation (registry keyed by project/run, detach on socket
                    close, re-attach with replay, killed only on {type:'kill'} / exit / idle / shutdown)
  hub.ts            WebSocket pub/sub by runId (replays persisted events to late subscribers)
  projectScope.ts   resolves the active project's root path; path-guards file writes
  projectArchive.ts streaming .zip receive + extract for project import (Settings -> Projects).
                    NEVER buffer the archive: a real export is mostly ticket-attachment .mp4
                    evidence (a measured one was 1.87 GB / 4348 entries), and both
                    express.raw({limit:'1gb'}) and JSZip.loadAsync hold the whole thing in
                    memory -- the first 413'd the upload, the second would OOM the server.
                    So the request body streams to a temp file, then bsdtar (`tar`, which reads
                    zip and ships in macOS + Windows 10 1803+) extracts member by member.
                    Entry names are path-guarded from `tar -tf` BEFORE any byte is written, so
                    zip-slip can't escape the project root. JSZip remains the fallback for
                    archives under 256 MB when bsdtar is absent.
  toolPath.ts       spawnEnv(): process.env with PATH augmented by well-known per-user tool
                    dirs (~/.local/bin, ~/.cargo/bin, WinGet Links) — used by EVERY child
                    spawn (claude, uvx probe, terminal) so uvx/npx MCP servers start even
                    when the portal was launched with a stale PATH; never spawn with a bare
                    { ...process.env }
  clickup.ts        ClickUp ticket lookup + crawl
  ticketActivity.ts a ticket's activity log — ClickUp exposes no task history (404 /history,
                    403 TIS_027 for time_in_status, no MCP tool), so the portal accumulates one:
                    each crawl diffs the ticket.json it is about to overwrite against the fresh
                    detail + comments and prepends a dated entry to activity.md. First crawl = a
                    baseline that says so; an unchanged crawl writes no entry
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
  knowledgeImages.ts the ONE knowledge upload the browser can't convert: an image (diagram, ERD,
                    annotated screen) has no text to extract, so the picture is saved under
                    testing/knowledge/assets/ and a vision pass (sonnet, Read-only, no MCP) writes
                    the doc describing it. The image is KEPT and embedded as assets/<file> — a
                    diagram flattened to prose can no longer be checked against the picture. A
                    blank/irrelevant image comes back as the NOT_USABLE sentinel → 422, and any
                    path that leaves without a doc deletes the image it saved
  flowFromTestcases.ts reads an UPLOADED test-case document and drafts the E2E flow that executes
                    it (Run form, advanced mode) — validated JSON, ≤20 steps, no tools
  runTestcaseDocs.ts stores that document under testing/test-cases/ so the run can Read it in full;
                    server-generated file names, refuses oversize rather than truncating
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
  answerCheck.ts    missingRefs(root, answer): the FREE half of chat accuracy — every project
                    file path a chat answer named, checked with existsSync. No AI, no tokens,
                    ~1 ms, so it runs on every turn. Only reports a path whose base is
                    unambiguous (under testing/, or its parent dir exists) — see "Accurate
                    answers" in chat.md for why silence beats a false alarm here
  answerAudit.ts    runAnswerAudit(): the PAID half — an independent cheap model re-reads the
                    project and rates one stored chat answer's checkable claims
                    supported/wrong/unsupported/unverified. ON DEMAND ONLY (a button),
                    because it costs 30-90 s; read tools with the write tools explicitly
                    denied; never throws, and a timeout comes back as `skipped`, never as a
                    clean verdict. `unsupported` is DEFECT CLAIMS ONLY — the answer called
                    something a bug and nothing in the project requires the behaviour it is
                    measured against; it counts as an issue (see "the defect bar" in chat.md)
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
                    isUnnamed()/deviceNameHint() explain a chip still showing its id.
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

