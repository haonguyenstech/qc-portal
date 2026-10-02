<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

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
- **A ticket's activity log is BUILT BY THE PORTAL, not fetched** (`server/src/ticketActivity.ts` →
  `testing/tickets/<folder>/activity.md`). Reported as "chat can't read a ticket's activity log", and
  the reason was that nothing produced one. Measured against the live workspace: ClickUp's public API
  has **no task history endpoint** (`/task/<id>/history` and `/task/<id>/activity` are 404), the one
  thing that comes close — `/task/<id>/time_in_status` — is plan-gated (`403 TIS_027`), and the
  configured ClickUp MCP exposes 28 tools of which none returns history. So the log is **accumulated
  instead**: every crawl reads the `ticket.json` it is about to overwrite, diffs it against the fresh
  detail + comments, and prepends a dated entry — status / priority / due date / title / list changes,
  assignees and tags added or removed, custom fields set, cleared or changed, attachments added or
  removed, and new comments (matched **by comment id**, never by count, so an edited or deleted
  comment can't hide behind an unchanged total). Three rules keep it honest: the first crawl writes a
  **baseline** entry that says the history before it isn't recorded; a crawl that changed nothing
  writes **no entry** (only the `Last checked:` line moves, which is how you tell a stale snapshot
  from a fresh one); and a **description edit reports only that it changed and by how many characters**
  — pasting the old requirement text into a log is how a superseded acceptance criterion gets quoted
  back later as the current one. Newest first, capped at 200 entries / 256 KB, and best-effort: a log
  failure never fails a crawl whose ticket files are already on disk. `routes/chat.ts` lists
  `activity.md` in the `@`-mention block, which is what makes "what changed on this ticket" answerable
  — before it, the model read the other three files, found no history, and correctly reported that
  none existed.
- **`safeSegment('')` returns the literal `'ticket'`, so empty path segments must be dropped BEFORE
  sanitizing** — `crawlOneTicket` filtered them afterwards, where the fallback string is truthy and
  survives. Every crawl without an explicit `relDir` (i.e. every single-ticket crawl through
  `POST /api/clickup/crawl`, since 0.9.16) therefore filed itself under
  `testing/tickets/ticket/` instead of its own `<displayId>/` folder, each crawl overwriting the
  previous one's files whatever ticket it was for. The flat-layout fallback the comment describes was
  unreachable. Fixed by filtering empties first; verified by crawling a ticket and watching it land in
  `testing/tickets/86eut664j/`.
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


### Jira / ClickUp without an API token — ONE browser sign-in for Tickets, runs and chat

The Tickets page reads Jira via REST (`jira.ts`) with the `jira` entry's site + email + API token,
or — with no token — through the portal's own browser sign-in (`atlassianMcp.ts`): the portal is an
MCP client of `https://mcp.atlassian.com/v1/mcp` with its own OAuth (dynamic client registration +
PKCE, nothing to register with Atlassian) and calls `getVisibleJiraProjects` /
`searchJiraIssuesUsingJql` / `getJiraIssue` (`responseContentFormat: 'adf'`, so `adfToMarkdown`
renders it exactly like REST). No model involved; a search is one HTTP round trip.

**There is exactly one Jira login.** `claude mcp login` would be a second one, owned by Claude Code
and unusable by the portal — engineers saw "Jira connected" on /mcp and "no tracker" on /tickets and
reasonably called it a bug. So the portal's sign-in also feeds Claude Code: on success
`linkClaudeToPortalJira` (routes/mcp.ts) writes the project's hosted-Atlassian entry (or `atlassian`)
as `{type:'http', url, headersHelper: 'curl -s "http://127.0.0.1:<port>/api/jira/oauth/headers?projectId=<id>"'}`
and approves it. Claude Code runs that helper each time it connects and sends the header it prints
(verified: CLI 2.1.287 runs `headersHelper` for http servers in a TRUSTED workspace — the portal's
approve step sets the trust). Both pages start the same flow (`web/src/lib/useJiraSignin.ts`): the
MCP page's Jira "Sign in with browser" and the `atlassian` row's Sign in button no longer use
`claude mcp login`.

- `/oauth/headers` answers `{Authorization: Bearer …}` (refreshed when <2 min left) or `{}` — always
  200, since a failing helper makes Claude Code drop the server instead of showing "needs sign-in".
  It takes the EXACT `projectId` (never `resolveProject`'s default-project fallback, which would hand
  out another project's login) and refuses tunnel (`/remote`) requests.
- No token in `.mcp.json`. The helper's port + project id are this machine's; the boot repair
  (`repairProjectMcpConfig`) rewrites them on a project synced from elsewhere. `sanitizeEntry` keeps
  `headersHelper`, or an edit on /mcp would silently sign Claude Code out.
- `resolveProjectJiraCreds` falls back to the sign-in (`mcpProjectId` on `JiraCreds`) only when there
  is no API token — that fallback must sit AFTER, not inside, the `jira`-entry check (a project with
  no `jira` entry at all returned "not configured" before reaching it). A token always wins.
- State (registration, tokens, PKCE verifier, the Jira site) is per project, beside the DB in
  `tracker-oauth/atlassian-<projectId>.json`, mode 0600. Sign out deletes it (two-click confirm: it
  signs runs and chat out too).
- **Starting a sign-in never logs anyone out.** `startAtlassianSignin` hides the stored token from
  `auth` (`ignoreTokens`) instead of deleting it — it used to delete it, so clicking Sign in and
  closing the Atlassian tab dropped a working login for Tickets, runs AND chat. New tokens replace
  the old only when the callback succeeds.
- **The page updates by itself.** The hook (`useTrackerSignin`) watches for the callback (postMessage +
  a 2 s status poll, landing exactly once) and lives on the PAGE, never in the Add-server dialog that
  closes as the sign-in starts. On /mcp it then re-tests the Atlassian row (`afterJiraSignin` →
  `afterSignin`), so it turns green without a reload. A sign-in that ran in the same tab (popup
  blocked) has no opener: the callback page `location.replace`s back to the page that started it
  (`returnTo` — a same-site PATH only, `//host` refused, so it can't be an open redirect).
- **Disconnect on /mcp ends the sign-in too.** `DELETE /api/mcp/:name` on the signed-in tracker row
  (`atlassian` / `clickup-oauth` / `azure-devops`) also deletes the portal's login (`signOutHosted`) unless another
  hosted row for that tracker is still configured, and answers `signedOut` so the page drops the
  Tickets caches. Before, /tickets kept loading through a login the MCP page no longer showed.
- **The poll waits for `linkedAt` to MOVE, not for `signedIn`.** The callback stamps `linkedAt` as
  its LAST step, after `.mcp.json` is written; `/oauth/start` returns the value it is waiting to see
  change (`since`). Keyed on `signedIn`, a sign-in over a login that was still live (the server row
  disconnected, then added again) "landed" on the first poll, before the callback had re-added the
  row, so the MCP page refreshed too early and the row only appeared on reload.
- **Attachments are not covered** — no attachment tool, and the token is scoped to the MCP server. The
  crawl reports each file as failed ("attachments need the Jira API token").
- **ClickUp works the same way** (`clickupMcp.ts`, both on the generic `hostedMcp.ts` +
  `routes/trackerSignin.ts`, so the two sign-ins cannot drift). ClickUp's REST API does NOT accept
  the hosted sign-in's token (measured: `401 {"err":"Oauth token not found","ECODE":"OAUTH_019"}`),
  so a signed-in project's "token" is the MARKER `mcp:<projectId>` (`clickupSigninToken`) and every
  `clickup.ts` function Tickets and Run → Issues use branches on it to the MCP tools, returning the
  same normalized shapes: workspaces/spaces/lists ← `clickup_get_workspace_hierarchy`, task lists +
  search ← `clickup_filter_tasks` (status colours from `clickup_get_list`, the rows carry none),
  subtasks/detail/filing context ← `clickup_get_task`, comments ← `clickup_get_task_comments`,
  create ← `clickup_create_task` (priority as a WORD), screenshots ← `clickup_attach_task_file`
  (base64), evidence comment ← `clickup_create_task_comment`. Attachments: the MCP detail has no
  file URL, so it records `mcp-attachment:<task>|<id>` and `downloadAttachment` asks
  `clickup_download_task_attachment` for a fresh SHORT-LIVED url at download time. Anything else
  (Docs) reaches `cuFetchAt`, which refuses with "needs an API token" instead of ClickUp's 401.
  `resolveProjectClickupToken` must check the sign-in AFTER, not inside, the `clickup`-entry check
  (the Jira bug again: a project with no `clickup` entry returned "not configured"). The workspace
  is picked at sign-in from the hierarchy root. Claude Code's `clickup-oauth` gets the same
  `headersHelper` link (`/api/clickup/oauth/headers`).
- **Azure DevOps signs in through Entra, NOT a hosted server** (`azureSignin.ts`, same shared routes
  via a `SigninBackend` in `routes/trackerSignin.ts`, same `useTrackerSignin` hook). Microsoft's
  hosted server (`mcp.dev.azure.com`) needs an Entra app registration a TENANT ADMIN makes (Entra has
  no dynamic client registration), and the official local server's own browser login
  (`@azure-devops/mcp --authentication interactive`) keeps its token in process MEMORY only (read in
  its `dist/auth.js`, 2.10.0) — every run and chat turn starts a fresh server, so each would pop a
  browser and a headless run would hang. So the portal signs in itself AS THAT SERVER'S PUBLIC
  CLIENT (`0d50963b-…`, auth code + PKCE, scope `499b84ac-…/.default`), keeps the refresh token in
  `tracker-oauth/azure-<projectId>.json`, and:
  - **The redirect is a loopback port, not a portal route.** That client accepts only
    `http://localhost[:port]` with path `/` (measured with `prompt=none`, which redirects to a valid
    URI and errors on an invalid one: `/api/...` and `127.0.0.1` are refused). A short-lived listener
    on 127.0.0.1:<random> 302s the code to `<page origin>/api/azure/oauth/callback`, so the callback
    page can still message its opener. Consequence: refused from a /remote tunnel (Microsoft would
    send the viewer's browser to THEIR localhost).
  - **Claude Code's server is `azure-devops`**: `{command:'node', args:['-e', <launcher>, port,
    projectId]}`. The launcher fetches `/api/azure/oauth/token` (local only, exact project, a token
    with ≥45 min left + the org) and runs `npx -y @azure-devops/mcp <org> --authentication envvar`
    with `ADO_MCP_AUTH_TOKEN`. Inline so .mcp.json names no path on this machine; the boot repair
    rewrites its port/project (`isAzureLauncher`). It writes to stderr only — stdout is the MCP
    channel — and exits 1 with "sign in again" when there is no login, so the row shows failed.
    The server reads the token ONCE: a single run / chat turn longer than ~1h loses Azure partway.
  - **Tickets** read with the same token as a `Bearer` (`AzureCreds.bearer`); a PAT in the `azure`
    entry still wins. The router refreshes the token before the sync resolver reads it (the
    ClickUp split). The org is picked at sign-in (asked for > last one > first of the account's,
    from `app.vssps.visualstudio.com` profile + accounts), and switched on the Tickets strip
    (`POST /api/azure/oauth/site`) when the account has several.
  - **The organization's TENANT, not the home one.** An org belongs to one Entra tenant, and a token
    from `common` (the account's home tenant) lists none of another tenant's orgs — measured: a
    valid token, profile 200, accounts `[]`, for an account whose org is elsewhere. So, like
    Microsoft's own server (`org-tenants.js`), `orgTenant` reads `x-vss-resourcetenant` from an
    anonymous `HEAD vssps.dev.azure.com/<org>` and signs in to THAT tenant when the org is known up
    front. Otherwise the tokens are SAVED first and the sign-in waits in `needsOrg`: the MCP page
    shows `AzureOrgPrompt`, the typed org's tenant gets the refresh token redeemed there (no second
    sign-in for a member / guest), and only a tenant that insists (MFA, consent) gets a fresh
    sign-in, started for that org.
- **One ticket tracker per project.** ClickUp, Jira or Azure DevOps — never two at once, in any
  form (token built-in or signed-in server, any name). `trackerConflict` (trackerMcp.ts) is the one
  rule, enforced SERVER-side on every way in: `POST /api/mcp`, `/import` (also refuses a paste that
  connects two), `PUT /:name` (an edit that turns a server into another tracker), the token connect
  routes, and every browser sign-in start. The refusal names the server to disconnect first. The
  Add-server dialog locks the other trackers' tiles ("Remove ClickUp first") with a note saying
  which one is in use. A project that already had two before the rule keeps working — it just
  cannot add another.
- **And every server is connected ONCE.** The same tracker a second way (a token next to its
  sign-in) is refused too — except a RE-sign-in (`allowSame`), which relinks the row already there,
  and a token re-saved over the built-in's own entry. Any other server: `duplicateOf` (routes/mcp.ts)
  refuses an identical url (trailing slash ignored) or identical command + args under another name,
  on `POST /` and `/import` (within the paste too). The dialog locks a tile whose service is present
  in ANY form — its own name, its sign-in twin (`clickup-oauth`, `figma-oauth`), or for a tracker any
  of its servers — and its tooltip names the server it was added as.
- **/tickets never signs in.** With no tracker connected it shows one "Configure MCP" button; every
  sign-in (and Azure's "which organization?" step) happens on /mcp. The Tickets page keeps only the
  signed-in strip (where it reads from, Azure's org switch, sign out).
