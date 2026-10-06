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
                    "Installed" is the BINARY (autoAgentCli.ts), not the state dir:
                    `logout` deletes ~/.auto-agent-ai entirely, and a dir-only test read a
                    deliberate sign-out as "not set up on this machine".
                    Surfaced by GET /api/auto-agent/status (routes/autoAgent.ts) and the
                    sidebar's AutoAgentStatusIndicator, ABOVE Release notes.
  claudeTokenUsage.ts  the Auto Agent dialog's "Token usage · today": a PORT of the box
                    `auto-agent-ai login` prints. The CLI has no usage command and does not
                    ask its server — it sums `message.usage` from Claude Code's transcripts
                    (`<config dir>/projects/**/*.jsonl`), so this does the same, faithfully:
                    the day is UTC+7 FIXED (the CLI's clock, not the machine's), files older
                    than 26h before that day are skipped, a response written several times
                    is de-duplicated by message id + request id (a sidechain copy never
                    counts twice), and billable = input + output + cache create. Covers every
                    `claude` on the machine — unlike `usage_events`, which is the portal's own
                    calls only and feeds the dialog's "Portal usage" section
                    (GET /api/auto-agent/usage). Async, cached 60s, single-flight. Counts and
                    model names only; transcript content never leaves the module.
  autoAgentCli.ts   RUNS that CLI, so Connect / Disconnect are buttons in the sidebar panel
                    instead of a terminal window parked on `auto-agent-ai login` forever.
                    The split from autoAgent.ts is deliberate: the status endpoint is polled
                    every 30s and may never depend on a child process. Why a background
                    child suffices: the Microsoft step is a LOOPBACK OAuth flow (the CLI
                    listens on 127.0.0.1, opens the browser, waits ≤5 min for the callback)
                    and the credential watcher is spawned detached+unref'd BY THE CLI — so
                    the login child exits at sign-in and the watcher survives with no
                    terminal. Sign-in is therefore an in-memory JOB the browser POLLS
                    (POST/GET /api/auto-agent/login), not an awaited request: a closed
                    dialog or a reloaded page must not abandon a half-done sign-in.
                    `--role client` is passed because the role prompt is an ARROW-KEY
                    picker a piped stdin cannot answer; the session picker (asked only with
                    several sessions assigned) falls back to a NUMBERED list read line by
                    line, which is the only reason /login/answer can answer it from a form.
                    Output is ANSI-stripped, bounded, scrub()ed and kept IN MEMORY only —
                    never the DB, never disk. QC_AUTO_AGENT_BIN overrides the PATH lookup,
                    which goes through spawnEnv() like every other tool here.
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
  k6.ts             Performance › API load test: detect k6, GENERATE the k6 script, spawn
                    `k6 run`, parse its summary. The script + summary are written BESIDE THE
                    DB (data/perf-runs/<jobId>/), never into a project repo, and per-endpoint
                    headers/bodies reach k6 through the ENVIRONMENT (`__ENV.QCP_H<i>` /
                    `QCP_B<i>`) so a bearer token never lands on disk. Exit code 99 means "a
                    threshold was crossed" — a valid RESULT, not a failure; don't turn it into
                    an error or the report is thrown away. Per-endpoint numbers are explicit
                    custom metrics (ep<i>_duration/_waiting/_bytes/_ok/_calls), because k6 only
                    emits a tagged sub-metric when a threshold names it.
  pageAudit.ts      Performance › Page load: loads a page N times in a real Chrome
                    (playwright-core, same logged-in profile as scanJobs.ts) and reports load
                    timings + a per-request table + which APIs were called MORE THAN ONCE per
                    load. Keeps recording for `settleMs` AFTER the load event — duplicate calls
                    are a post-mount effect, so stopping at `load` misses the whole point.
                    API calls and static assets have SEPARATE caps: one shared cap fills with
                    a dev server's ES modules and then silently drops the XHR/fetch calls the
                    feature exists to count.
                    Reports `redirected` + `finalUrl`: a session-less browser lands on /login
                    and every number then describes THAT page, so the report says so first.
  authSession.ts    Performance › Page load "sign in first": opens a HEADED Chrome on the
                    audit's own profile (`agentProfileDir()`), holds it while the engineer
                    logs in, and closes it — closing is what flushes localStorage to disk and
                    frees the profile lock. One at a time, never during an audit (Chrome won't
                    open a profile twice); auto-closed after 20min and on shutdown.
  perfJobs.ts       in-memory background-job registry shared by both of the above (logs +
                    result + cancel). Its PUBLIC shape strips the k6 config's headers/bodies —
                    a poll response is the easiest place for a credential to leak.
  reportExport.ts   Performance › report export: the CLIENT's report HTML in, a PDF (headless
                    Chrome page.pdf) or a .docx (html-to-docx) out. Uses a CLEAN Chrome, never
                    agentProfileDir() — sharing the audit's profile would block exports while an
                    audit ran. Word cannot read inline SVG, so each chart FIGURE (div.viz-root:
                    svg PLUS its legend, whose swatches are CSS vars Word cannot resolve either)
                    is screenshotted at 2x and swapped for a data-URI <img>, in the DOM rather
                    than by regex. An optional running footer is stripped to plain text
                    (footerText) and printed on EVERY page.
  responsiveCapture.ts  Responsive › Capture: one URL on N REAL emulated devices (viewport +
                    deviceScaleFactor + mobile UA + isMobile + hasTouch), a screenshot each,
                    and the layout findings measured IN the page (AUDIT_SCRIPT — a string, not
                    a function, because this workspace has no DOM lib). Devices run in
                    SEQUENCE: six Chromes on one CPU time the slowest one out, which reads as
                    "that device is broken". One device failing is recorded on that device; only
                    a browser that cannot launch throws (the route turns that into a 400, so a
                    launch failure is an inline message and not a job that exists to say it
                    never started). Shares `loadChromium()` with pageAudit.ts. The UA is built
                    from the INSTALLED Chrome's version, never shipped in the web bundle. Also
                    `probeUrl`: whether the page allows being framed at all — a refused iframe
                    raises no event in the browser, so the live tab could not find out for
                    itself. Screenshots go BESIDE THE DB (data/responsive-runs/<jobId>/).
  responsiveJobs.ts in-memory job registry for those sweeps (logs + progress + cancel), the
                    same shape as perfJobs.ts. Its own registry, not a third `kind` there:
                    every Performance poll would otherwise ship a payload it never reads.
                    Pruning a job deletes its screenshots — an evicted row leaves them
                    unreachable.
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
  tunnel.ts         Remote access (/remote): publishes the portal to a public HTTPS address by
                    running `cloudflared`. Three modes — quick (random *.trycloudflare.com, no
                    account), token (a Zero Trust connector token; fixed hostname, NO --url
                    because its ingress is remotely managed), named (a locally-managed tunnel).
                    cloudflared has no status API, so its stderr IS the progress signal: state
                    stays `starting` until the quick URL or "Registered tunnel connection"
                    appears, because reporting a URL that 502s is worse than reporting none.
                    Every launch claims `live.generation` and every handler checks it — a killed
                    child's `close` arriving AFTER the next spawn used to overwrite a working
                    tunnel's state with "exited with code 0". The connector token is stored
                    BESIDE THE DB (0600), never in a repo, never returned to the browser, and
                    scrubbed from the log. The pid is written beside the DB too, so
                    reapOrphanedTunnel() can kill a cloudflared a SIGKILLed portal left holding
                    a public hostname open. REFUSES to start without an access password.
  remoteAccess.ts   the gate in front of that tunnel, and the reason publishing is allowed at
                    all: the portal spawns claude with permissions bypassed and hands out a
                    shell, so a public URL without a password is remote code execution. FAILS
                    CLOSED — a locked visitor gets one self-contained unlock page and nothing
                    else, not even the JS bundle (hence app.use() BEFORE express.static in
                    index.ts). "Came through the tunnel" = the presence of Cloudflare's
                    cf-connecting-ip / cf-ray, because cloudflared connects to 127.0.0.1 and is
                    otherwise indistinguishable from a local client. Sessions are a stateless
                    HMAC cookie (a restart must not sign every phone out); "sign out all
                    devices" and changing the password both rotate the signing secret. The
                    device terminal stays blocked for remote sessions unless allowed.
                    QC_REMOTE_FORCE_GUARD=1 treats every request as remote — for testing the
                    gate, not a security control. See remote-access.md.
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
                    dirs (~/.local/bin, ~/.cargo/bin, WinGet Links, %APPDATA%\npm) — used by
                    EVERY child spawn (claude, uvx probe, terminal) so uvx/npx MCP servers
                    start even when the portal was launched with a stale PATH; never spawn
                    with a bare { ...process.env }. %APPDATA%\npm is where `npm i -g` puts
                    its .cmd shims and is regularly missing from the PATH of a detached
                    server — the same gap resolveClaudeBin() works around by hand.
                    Also killSpawnedTree(child): kill a child AND its descendants for
                    children spawned WITHOUT detached. On Windows every CLI is a .cmd shim,
                    so cross-spawn really starts cmd.exe and child.kill() reaches only that
                    wrapper — the real process survives a "cancel". claude.ts's killTree is
                    the sibling for DETACHED spawns (it signals the posix process GROUP);
                    keep both, neither branch covers the other's case
  mailbox.ts        MailBox (/mailbox): a throwaway inbox for sign-up / OTP / reset-link
                    testing, over Guerrilla Mail's JSON API. YOPmail — what everyone asks
                    for — has NO api: an inbox URL without the tokens its own JS computes
                    answers HTTP 400, and x-frame-options blocks embedding it. Traps:
                    get_email_list is the LIST call (check_email is a DELTA and returns an
                    empty list on the second call while the inbox visibly holds mail); all
                    their domains reach the same box, the username IS the address; the
                    sid_token lives beside the DB (0600) and never reaches the browser.
                    See docs/architecture/mailbox.md
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
                    Also runFeedbackCapture (a chat 👍/👎) and runChatCapture (a quiet chat
                    conversation) — same machinery, much smaller allowances
  chatLearn.ts      the scheduler that makes /chat auto-capture bearable: an answered turn
                    arms a 90s QUIET timer on that conversation and each new turn RESETS it,
                    so one reflection reads the last few exchanges instead of one per
                    message. Fired AFTER the turn's `done` frame and never awaited — nothing
                    the reader is watching may wait on a model call — and captures are
                    serialised process-wide, or two of them would read the same memory folder
                    and each create the note the other was writing. forgetChatLearning() is
                    what DELETE /api/chat/:slug calls so deleting a chat also cancels the
                    memory it had not written yet
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
                    knowledge, memory, notes, database, diagrams, prototype, chat,
                    performance, version
                    routes/mcp.ts also backs the MCP page's "More servers": POST /import
                    (template or pasted JSON — the BROWSER unwraps the pasted shape in
                    web/src/lib/mcpTemplates.ts, the server re-validates every name +
                    entry and refuses the whole batch, never overwrites an existing name)
                    and PUT /:name (the Edit dialog: replace the entry — form or raw JSON —
                    and optionally rename; the entry is validated BEFORE the rename, and a
                    rename moves the entry AND its approval in ~/.claude.json /
                    settings.local.json). The dialog loads the REAL env/header values
                    first — seeding the form with the list's masked "••••1234" would save
                    the mask over the token. BUILTIN_SERVERS (clickup, figma,
                    jira, azure, playwright, maestro) MAY be renamed away (the dialog warns
                    what stops working — their NAME is how the token resolvers, Playwright
                    run mode / QC-browser attach and the skill's mcp__playwright__* tools
                    find them) but nothing may be renamed ONTO one. The page lists only
                    CONFIGURED servers; connecting a built-in is a "QC essentials" template
                    that calls its own route (token save / addMcp / maestro/connect), never
                    the generic import. Live health (`getStatuses`) is `claude mcp list`,
                    which spawns EVERY server in scope: capped at 45s (a cold start measured
                    15s+ and the old 15s cap returned `{}` = every badge gone, then cached
                    for 5 min by the page), a timeout is a 504 ERROR never an empty map,
                    one probe per project at a time (+5s reuse, cleared by writeMcp and by
                    Test). A project server in `disabledMcpjsonServers` is absent from the
                    list, so it is reported `pending` and Test approves it.
                    OAuth SIGN-IN for a remote (http/sse) server — /signin/:name/{start,
                    paste,cancel,logout} + GET /signin/:name, declared AHEAD of the
                    `/:name/...` routes — drives `claude mcp login` through mcpSignin.ts
                    (below); the "Sign in (OAuth)" templates add a bare `{type:'http',url}`
                    and the page offers Sign in as soon as the first Test says needs-auth.
                    `sanitizeEntry` keeps an entry's `oauth` block (a pre-registered
                    client: `clientId`, `callbackPort` — what `claude mcp add --client-id`
                    writes) minus anything secret-named, and PUT carries it over when the
                    url is unchanged, because the Settings form has no field for it and
                    used to drop it silently on every save
  mcpDiagnose.ts    the MCP page's "Error log" (GET /api/mcp/diagnose/:name). `claude mcp
                    list` only ever says "Failed to connect", and the real cause is on the
                    server's STDERR, which the CLI swallows. So it launches the server
                    ITSELF as configured (command/args/env/cwd, `${VAR}` expanded, through
                    spawnEnv) and speaks `initialize` + `tools/list`, or POSTs the
                    handshake to a remote url; records stderr/stdout (ANSI stripped, 64KB
                    cap), exit code, timing; and reads Claude Code's own per-server log
                    (`<cache>/claude-cli-nodejs/<slug(project)>/mcp-logs-<slug(name)>/`,
                    slug = every non-alphanumeric -> "-"). EVERY env/header value of the
                    entry is scrubbed from ALL returned text, Claude's log included.
                    `hintFor` maps the failures we have met (uvx missing, a full path
                    copied from another machine, clickup-mcp's renamed key, 401, TLS/proxy)
                    to a one-line fix. 0 tools after a good handshake is reported as a fail
                    A remote entry's `headersHelper` (the portal's own Jira/ClickUp sign-in)
                    is RUN first and its headers sent — skipping it gave a 401 for a server
                    whose badge said Connected. With no header and no helper the server
                    uses Claude Code's OAuth token, which the portal cannot read: a 401 is
                    then expected, and the verdict comes from Claude Code's newest log
                    The route adds the SAME tracker credential check the badge uses
                    (`verifyTrackerAuth`): mcp-atlassian handshakes and lists 63 tools with a
                    dead token, so without it the log said Connected beside "Needs auth"
  mcpSignin.ts      the job behind that Sign in. The portal never runs OAuth itself:
                    `claude mcp login` does discovery / client registration / PKCE and
                    keeps + REFRESHES the token in Claude Code's credential store, which
                    every headless run then uses — so .mcp.json holds no secret. Measured
                    on CLI 2.1.281: it needs a TTY (piped stdin exits 1 in both modes), so
                    it runs in a node-pty; always `--no-browser`, because the CLI's own
                    browser opens on the SERVER's machine, wrong under /remote — the page
                    opens the URL in the engineer's browser instead. In a pty the CLI both
                    listens on localhost:<port>/callback (a local browser finishes by
                    itself) and prompts for the redirect URL (a remote one pastes the
                    address its failed redirect left); a wrong paste is re-prompted, not
                    fatal. It refuses an unapproved .mcp.json server, so start approves
                    first. The callback port is fixed per server: ONE sign-in at a time,
                    portal-wide. The URL is an OSC 8 hyperlink, so the ANSI strip's OSC
                    body must not be greedy (it would eat the visible URL); the `code=` of
                    a pasted URL (the pty echoes it) is masked; memory only, never logged
                    Output is read in CHUNKS, not lines: ClickUp's authorize URL (a ~500-char
                    JWT client id) arrived split mid-`%2F`, and taking the URL from the first
                    chunk opened ClickUp with half a `redirect_uri` ("Invalid redirect_uri").
                    So the URL is accepted only once whitespace ends it, an escape sequence
                    cut at a chunk end is held back from its START (`openEscapeAt`), and
                    `lines` holds finished lines (+ the open one in the snapshot)
  hostedMcp.ts      the portal's OWN browser sign-in to a tracker's hosted MCP server (Atlassian,
                    ClickUp): DCR + PKCE, state beside the DB (0600), and the headersHelper
                    that hands the same login to Claude Code. clickupMcp.ts / atlassianMcp.ts
                    are the per-provider halves; routes/trackerSignin.ts the shared routes
  azureSignin.ts    the same ONE sign-in for Azure DevOps, through Microsoft Entra (no DCR, so
                    not hostedMcp.ts): the public client of Microsoft's local server, a
                    LOOPBACK redirect listener (the client takes only http://localhost:<port>/),
                    tokens beside the DB, and the `node -e` launcher .mcp.json runs to start
                    `@azure-devops/mcp --authentication envvar` with a fresh token
  atlassianMcp.ts   the Tickets page's OWN browser sign-in to Jira: an MCP client of Atlassian's
                    hosted server with its own OAuth (DCR + PKCE), state beside the DB (0600),
                    used by jira.ts when the project has no API token. Not the MCP page's
                    `atlassian` login (Claude Code's, unusable by the portal) - see
                    tickets-and-overview.md
  trackerMcp.ts     which .mcp.json server talks to ClickUp / Jira / Azure DevOps: the token built-in
                    under its FIXED name, or the hosted server signed in to in the browser
                    (url mcp.clickup.com / mcp.atlassian.com, any name). Chat's ticket
                    hint names the real one (a hard-coded `mcp__clickup__*` does not exist
                    in a sign-in-only project), and routes/clickup.ts says "signed in for
                    runs and chat only" instead of a bare "not configured" — the hosted
                    login is Claude Code's, scoped to the MCP server, so ticket crawl and
                    Run → Issues filing (REST API) still need the API token. The MCP page's
                    ClickUp / Jira form offers both ("Sign in with browser" adds the
                    `clickup-oauth` / `atlassian` template, then Sign in opens) and lists
                    which features each covers; never present sign-in as enough for those two

web/src/
  App.tsx           two branches: `/ai-labs` renders BARE (no shell — see "QC AI Labs"),
                    everything else goes through AppShell. The job watchers sit in App,
                    above both, so jobs still announce on the bare page.
                    AppShell = sidebar nav + routes + ProjectSwitcher + always-mounted
                    NotificationBell + TestCaseJobWatcher + CrawlJobWatcher; the sidebar
                    footer (VersionFooter) carries AutoAgentStatusIndicator ABOVE the
                    Release notes card — keep it in BOTH the collapsed and expanded
                    branches, they render separately. That indicator is a BUTTON in both:
                    it opens AutoAgentPanel (same file), which shows the full status and
                    runs Connect / Disconnect. The panel polls the sign-in job rather than
                    awaiting it, and Disconnect is two-step — it stops every AI feature in
                    the portal until someone signs in again
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


## Self-update — the sidebar's "Update now"

`bin/qc-portal.mjs --update` + `routes/version.ts` + `VersionFooter` in `App.tsx`.
The server spawns the launcher **detached**, the launcher stops the server, rebuilds,
and starts a fresh one; the browser polls `/api/version` and reloads. Every rule below
exists because that sequence produced a spinner that never finished.

**A failed update must not leave the portal dead.** `update()` stops the server BEFORE
the first step, and `run()` used to `process.exit` on a non-zero status — so any step
that failed took the portal down permanently, and the only way back was a terminal the
QC engineer usually doesn't have open. `run()` now returns a sentence instead of
exiting, and `update()` restarts the previous version on ANY failure. Verified both
ways in a sandbox: with the old launcher a failing build left `/api/version`
unreachable; with the new one the server is answering again seconds later.

**Every step is bounded.** `spawnSync` has no timeout unless one is passed, so a
stalled `git fetch` or `npm install` — dropped VPN, corporate proxy, a credential
prompt nobody can see — blocked forever with the server already stopped. Git gets 3
minutes, npm 15. On Windows a `shell: true` timeout kills `cmd.exe` and may leave the
grandchild running; that is accepted, because the point is to stop WAITING and put the
server back. The steps also run with `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS` /
`GCM_INTERACTIVE=never`: the updater's stdio is a log file, so any prompt is invisible
and waiting on one is waiting on nobody.

**"The server is back" is not "the update worked."** `/api/version` reads
`package.json` FROM DISK, and `git reset --hard` moves it before the steps that can
still fail — so a failed build reports the new version while running the old bundle,
and the browser would announce "update complete" and reload onto it. The launcher
therefore writes `data/update-status.json` (`{ok, error, version, at, backup}`, cleared to
`{ok:null,running:true}` at the start so a stale marker can't answer for this run), and
`GET /api/version/update-log` returns it alongside the log tail. The UI reports failure
from the MARKER, never from the version number.

**Local edits are saved before the reset, never silently discarded.** `git reset --hard`
is deliberate (a dirty `package-lock.json` used to block every update), but it also wiped
an engineer's own patches to their install without a word — field report: ClickUp filing
and headless-viewport patches gone after "Update now", unrecoverable from git.
`backupLocalEdits()` runs after the fetch and before the reset: every edited TRACKED file
except `package-lock.json` goes into `data/update-backups/<time>-<sha>.patch` (data/ is
gitignored, so the reset can't touch it), restorable with `git apply --3way <file>`. If the
edits exist but can't be saved, the update STOPS before changing anything. The path rides
in `update-status.json` as `backup`, and the UI then shows a persistent toast naming it
instead of auto-reloading past it. git runs there with no shell: the file list may hold
spaces. Verified in a throwaway clone: two edited files saved, the lockfile skipped, reset
done, `git apply --3way` restored both cleanly.

**The in-flight guard is a lease, not a latch.** `updateStarted = true` forever was
justified by "the updater restarts the server, giving a fresh process" — true only when
the update succeeds. After a failure the flag stayed set, so every retry got
`alreadyRunning: true` and the browser went straight back to waiting for a restart that
was never coming. It is now a 20-minute lease.

**The button's spinner is state, not a derivation.** `update.isPending || (isSuccess &&
data.ok)` never becomes false again — the mutation succeeds the moment the server
*accepts* the request — so the button stayed disabled and spinning for the life of the
page even after the update had failed and said so. It is now cleared in a `finally`.
The toast counts elapsed time while it waits: a silent spinner and a hang look
identical, and this step legitimately takes minutes.

**The browser's budget must outlast the launcher's.** Phase 2 waits 35 minutes — the
launcher's own worst case (3 + 15 + 15) plus the restart — so the browser gives up only
after the launcher certainly has, and what it then sees is the restored old server.
