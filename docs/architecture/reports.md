<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## `/reports` — the QC status report

**`ReportsPage.tsx`** answers the one question the portal could not: **where does this project
stand?** Every other page answers a slice of it — Tickets says what was crawled, TestCase says what
was written, History says what one run found, Performance says how fast it is — and none of them
crosses the others. This page joins the chain:

```
ticket  ->  test cases  ->  run  ->  defects
```

It is a **new sidebar group** (`Report`), not a row under Testing, because it is the only page that
reads across the pages it summarises; buried among them, nobody finds it.

### Why the join happens server-side

`server/src/reportData.ts` `buildSystemReport()` does the whole thing in one pass and the page
renders a finished object. The alternative — joining in the browser — is N+1 requests per ticket (a
`report.md` and an `issues.md` per run; the reference project has 33 runs across 34 tickets) and a
page that paints half a truth while the rest arrives.

Each link lives somewhere different, which is the whole difficulty:

| Link | Where it lives |
|---|---|
| Ticket | a folder under `testing/tickets/`, possibly nested (parent/subtask) |
| Test cases | `testcases/v<N>.{md,csv}` inside that folder, plus a legacy `testcases.md` |
| Run | a row in the `runs` table, joined to the ticket by `ticketId` |
| Result | `testing/test-result/<slug>/report.md`, located via `resolveRunOutDir` |
| Defects | `## ISSUE-n …` headings in that folder's `issues.md` |

### The four rules that decide every number

These are not style choices; each one was wrong first and produced a visibly absurd report.

1. **A ticket's result is its LATEST run that produced a report — never a sum across re-runs.**
   Measured on the reference project: ticket `86eut664j` has **22 runs against 331 test cases**.
   Summing them claimed *842 cases executed out of 331 that exist* — a coverage bar at 254% and a
   totals row nobody could defend. The build loop walks runs **oldest-first** so the last reporting
   run to pass through wins, and `currentDefects` is a **Map keyed by ticket folder**, so a later
   run *replaces* the earlier defect list rather than appending to it. A defect fixed two runs ago
   must not still be on the board.

2. **Blocked is not failed.** Pass rate is `pass / (pass + fail)`. Blocked and not-tested cases are
   reported beside it and excluded from the ratio, because a case nobody could reach is a coverage
   gap, not a pass — and folding it in is exactly how a gap disappears from a status report. The
   page and both exports print that sentence next to the number.

3. **`funnel.clean` and the `clean` stage are the same test.** `funnel.clean` used to be an inline
   `runCount > 0 && fail === 0 && defectCount === 0`, which counts a ticket whose runs all died
   before writing a report as clean — `ticketStage()` has the extra `exec.total > 0` guard and does
   not. On the reference project the coverage chain therefore said **Clean 5** directly above a
   ticket filter that said **Passed clean 0**. It now filters on `t.stage === 'clean'`.

4. **Only on-disk evidence.** The report never calls ClickUp/Jira/Azure. It describes what the AI
   actually tested against. A ticket whose tracker status has moved since its last crawl is flagged
   `stale` (tracker `dateUpdated` newer than the folder's mtime) and counted in
   `totals.staleTickets` — never silently refreshed. Quietly mixing today's tracker state with last
   week's test evidence is how a closed ticket gets signed off against a superseded acceptance
   criterion.

### Open defects vs. history

Two different lists, and confusing them is the easiest mistake here:

- **`defects`** — the OPEN board: the latest reporting run's issues per ticket (and per flow run).
  This is what "7 open defects" means.
- **`recurring`** — computed over **`history`** (every defect from every run in the window), keeping
  only titles seen in **more than one run**. That is the "keeps coming back after a claimed fix"
  signal, and it cannot come from the open board, which holds one run each.

Matching normalises away the `ISSUE-n` prefix and any parenthetical, so
`ISSUE-1 (High) — Wrong date format` and `ISSUE-3 — Wrong date format` collapse into one.

**Severity is parsed from two heading forms**, both common in the same project:
`## ISSUE-2 — … (Medium severity)` and `## ISSUE-1 (High) — …`. Matching only the first left
**26 of 51 defects as "unknown"** on the reference project; with both, 2 of 17. "Unclassified" is
shown as its own bar and labelled as *no severity recorded* — it is not a low-severity bucket.

**A file with no recognisable `## ISSUE-n` heading contributes ZERO defects, on purpose.** This is a
counting pass, not the ClickUp filing parser in `RunDetailPage.tsx` (which must reproduce a body
faithfully enough to become a task description, and therefore falls back to a table or to the whole
file). Applying that fallback here would put a phantom defect on the chart for every run whose
`issues.md` says "no issues found".

### Reading the page

The layout was rebuilt against the reference project (34 tickets, 33 runs, 941 test cases), and
each of these fixes a failure that only shows at that size. The page was 5,081px tall; it is now
~3,250px, and nothing was removed.

- **A ticket with no result says so once, in words.** 23 of the 34 tickets have never been run, and
  each was drawing four em-dashes across Pass / Fail / Blocked / Defects — a *green* one, a *red*
  one, an *amber* one. Colour on a dash means nothing, and 92 of them turned the table into
  texture. Those four cells now merge into one muted `never run` / `ran, but produced no report`.
  The runs table does the same for the 17 of 25 newest runs that produced no report. Where a real
  number is present it is coloured; a zero is a grey dash (`Num`), never a green one.
- **Execution outcome is ONE stacked bar, not four.** The reference project's story is that 64 of
  its 123 executed cases were *blocked* — more than passed — and as a fourth bar against a shared
  max that reads as "a longish amber bar". As a segment it is half the page. The legend carries the
  count and the share.
- **The pass rate always prints its denominator.** `84.3%` beside `941 test cases` invites the
  reading that 941 cases were judged; 51 were. The tile's hint is
  `43 of 51 judged · 64 blocked`.
- **The coverage chain shows the LOSS at each step.** A funnel's point is where it narrows, and two
  bars of different length do not say "24 tickets fell out here". Each step past the first carries
  a `−n` column.
- **The verdict and the six counts are one card.** They are the same statement at two zoom levels;
  as a full-bleed `bg-red-500/5` box floating over a row of six bordered tiles they read as seven
  unrelated facts, and the tint was the loudest thing on a page whose job is to be read. The card
  is neutral, the grade arrives as a left rail plus an icon chip (`bg-<c>-500/10`, a tint OF the
  surface, so it survives dark mode), and the counts are a divided strip welded underneath. The
  strip's hairlines are `gap-px` over a border-coloured ground, so they stay correct at every wrap
  point instead of needing an nth-child rule per breakpoint.
- **Nine tracker statuses go in two columns**, next to the four severity bars. Nine near-identical
  grey bars down 350px was the tallest section on the page carrying the least on it, and pairing
  severity with the recurring list left ~200px of empty card under severity while the recurring
  titles wrapped to two lines in a half-width column. Recurring is now full width, one line each.
- **Both tables are their own scroll pane with a pinned header** (`max-h-[70vh]` / `[60vh]`). 34
  rows is ~2,000px and the column headings were gone after the eighth. The rule under the header is
  an `inset` box-shadow and the background sits on the `th` cells: with `border-collapse` a sticky
  cell leaves its own border behind, and an unpainted `th` lets the scrolled row show through it.
- **`defectTitle()` strips the `ISSUE-3 (Medium) —` prefix for display**, in `systemReport.ts` so
  the screen, the Markdown and the document exports all agree. Next to a severity pill, in a list
  whose every row is a defect, that prefix is three things the reader already has, eating the first
  third of the line. The number is not an identity either — the same defect is ISSUE-1 in one run
  and ISSUE-3 in the next, which is why the recurrence matcher discards it too. A title that IS the
  bare heading survives whole rather than becoming an empty cell.

### Other measured details

- **A zero-parse `report.md` is treated as no report.** `parseReport` answers all-zeros for a file
  whose summary table it could not read; letting that overwrite the DB's live counters would erase
  a finished run's result from the chart.
- **Run→ticket matching is on `displayId`, folder basename OR the raw ClickUp id**, lower-cased. A
  run's `ticketId` is whatever was typed on `/qc-run`, and the displayId and the folder name diverge
  the moment a displayId contains characters `safeSegment()` had to strip.
- **Artefact parsing is cached** by `runId:folder-mtime` and bounded at 500 entries. Re-reading
  every `report.md` and `issues.md` on each request is the one genuinely expensive part.
- **The date window filters runs and defects only — never tickets.** A window that hid the backlog
  would turn "12 tickets still have no test cases" into "everything is fine this week". The page
  says so, in the filter bar.
- **Coverage is capped at 1.** The latest run may have judged cases the newest test-case file has
  since dropped, and a 130% bar reads as a bug rather than as drift.

### Exports

Three formats, **one source**: `systemReport.ts` holds the verdict, the thresholds and the
formatting; `systemReportHtml.ts` builds the printable document from it; `ReportsPage.tsx` renders
the screen from the same module. A PDF mailed to a client cannot disagree with the page it came
from.

- **Markdown** — built in the browser, saved directly. Leads with the verdict and the numbers; it is
  what gets pasted into a ticket comment.
- **PDF / Word** — `POST /api/reports/export/:format`, which is the same `reportExport.ts`
  converter the Performance page uses (printing needs a real Chrome; `.docx` needs a zip writer,
  and the server then **repairs** html-to-docx's fractional `w:w` widths, which Word refuses).

The printable HTML therefore obeys the same constraints as the Performance report: **self-contained,
light-mode, and boring markup** — headings, paragraphs, tables, no flexbox or grid, because
`html-to-docx` does not understand them. Bars are rendered as nested `<table>`s with a coloured
cell, not as a div with a percentage width, for the same reason.

**Every export toasts with the file name.** App mode has no browser toolbar and therefore no
download popup — without the toast the button reads as doing nothing.

### The date window's picker

The filter bar uses **shadcn's Date Picker** (Popover + Calendar on `react-day-picker`), wrapped as
`components/DatePicker.tsx` so callers still deal in the `YYYY-MM-DD` strings the query params use.
Each end constrains the other (`disabled: {before}` / `{after}`), so an inverted window — which
would silently report zero runs — cannot be picked at all.

Two traps, both hit while adding it:

- **`npx shadcn add` OVERWRITES `button.tsx`, and its current registry version is wrong for this
  repo.** It rewrote the imports to `cn` (a real but unrelated npm package the CLI then *installs*)
  and to the `radix-ui` umbrella, neither of which this repo uses — and it changed the base button
  from **`rounded-full` to `rounded-md`**, which would un-pill every button in the app and silently
  break the design language. Revert `button.tsx` after any `shadcn add`, point the generated files
  at `@/lib/utils` and the per-package `@radix-ui/react-*`, and drop the `cn` / `radix-ui` /
  `date-fns` dependencies it added.
- **`new Date('2026-09-01')` parses as UTC midnight.** In a negative-UTC timezone the picker then
  shows the day *before* the one stored and writes back the day *before* the one clicked;
  `toISOString().slice(0,10)` has the mirror-image bug in positive offsets. `lib/dates.ts`
  `parseDay`/`formatDay` touch local parts only. Verified at UTC+7: clicking 1 Sept displays
  "01 Sept 2026" and sends `from=2026-09-01`.

### Routes

| Route | Does |
|---|---|
| `GET /api/reports/summary?projectId=&from=&to=` | the whole joined report |
| `POST /api/reports/export/:format` | browser-built HTML → PDF / .docx |
| `POST /api/reports/open` | reveal a ticket folder (`kind: 'ticket'`) or a run's output folder (`kind: 'run'`) — each segment filtered and the result escape-guarded under its own base dir |
