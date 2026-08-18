<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

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

