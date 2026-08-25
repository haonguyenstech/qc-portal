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

