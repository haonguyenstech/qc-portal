<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

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
  (`FeatureTicketsPicker`, RunPage — single-ticket mode only; the **E2E flow** run has no ticket at
  all), and the **Design Check** picker (`VerifyDesignPage`). The shared
  `CrawledTicketRow` takes `depth`/`hasChildren`/`isOpen`/`onToggleExpand` for the indent + chevron.
  Its emerald **"Test cases" badge is a preview button wherever `onView` is passed** — on the Run
  form both the row badge and each selected chip open
  `web/src/components/TestCaseVersionsDialog.tsx`, the shared read-only preview (version dropdown →
  `CsvTable` / rendered markdown). That dialog is keyed by folder and derives the shown version
  during render (no setState-in-effect); `TicketTestCasePicker`'s Eye button opens the same one with
  `initialVersion`, and the path helper `testcaseRelPath` lives in `web/src/lib/testcases.ts`.
  Reading test cases must not depend on how many tickets are selected — a queue of 2+ tickets gets
  the same preview as a single pick. Editing/deleting stays on `/testcases`.
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

