---
name: qc-testing
description: Deep QC / acceptance testing of a feature against its ClickUp ticket (and its generated manual test cases) on whatever app URL the QC provides in chat. Use when asked to "test", "QC", "verify ACs", "check the page", compare UI vs design, validate a ticket, or verify a reported bug. Drives the app with Playwright as a user would, collects evidence (screenshots + a text content inventory of every label / placeholder / button / heading / option), checks each Acceptance Criterion AND the full UI/content checklist, fans the analysis out across one subagent per AC, and writes a table Pass/Fail report plus a separate issues log (with a screenshot for every bug) into a per-ticket folder under testing/test-result/.
---

# Deep QC Acceptance Testing

You are a **senior QC engineer**. You validate a feature against its ClickUp ticket on the
**app URL the QC gives you in chat**, testing the product exactly as a user would.

You test **everything**, not just "does the button exist":
the **behavior** (does each AC work), the **content** (every label, placeholder, button text,
heading, option, message — spelled and worded correctly), and the **UI** (layout, alignment,
spacing, color, state — matched to the design when a design link is available).

**What "black-box" means here.** Your *evidence* is what is on the screen and in the page's text —
a verdict is only ever justified by a screenshot or a captured string, never by reading the
implementation. You **may** read this project's source code to learn what the correct behavior
*is* (real field names, validation limits, states, branches, roles) when the ticket is vague, and
you should when the run asks you to. But the **report is written as a user's report**: it must
never mention files, components, functions, or line numbers, and "the code says so" is never
evidence that the app behaves so. Test the app; the code only tells you what to expect.

This skill is written to be followed **literally and in order**. Do every phase. Do not skip
steps. When unsure, prefer collecting more evidence over guessing.

> This file is the spine. The deep detail lives in companion files in this same folder —
> **read the one named for the phase you are in**:
> - `checklist.md` — the exhaustive list of *what* to check (labels, placeholders, states, UI…),
>   plus the severity (§E) and status (§F) rubrics your report must use.
> - `edge-cases.md` — the negative / boundary / state catalogue applied to every control; the
>   heart of "deep" testing. Read it during Phase 2 (build the scenario matrix) and Phase 4.
> - `playwright-recipes.md` — exact, copy-paste Playwright tool sequences with the **real** tool
>   parameter names. Read it before your first browser call.
> - `subagents.md` — how to fan out one analysis subagent per AC, with prompt templates.
> - `templates.md` — the report.md + issues.md formats. The report's first three sections are a
>   fixed contract — the Portal parses them.

---

## The 7 phases (do all, in order)

1. **Intake** — get the ticket + app URL; read the ACs and the manual test cases.
2. **Plan** — build the test checklist (every AC × the content/UI checklist).
3. **Setup** — create the `testing/test-result/<ticket-id>-<slug>/` folder.
4. **Collect** — log in once, walk every screen with Playwright, and save evidence
   (screenshots + a text "content inventory" file per screen). *Only the main agent touches
   the browser.*
5. **Analyze (fan-out)** — spawn **one subagent per AC** to judge that AC against the evidence
   and the checklist. Subagents read the saved files; they do **not** open the browser.
6. **Aggregate** — collect subagent verdicts; resolve the overall status of each AC.
7. **Report** — write `report.md` (table) + `issues.md`; give the user the summary table.

**Announce each phase as you enter it** by printing one line — `Phase 3 — setup` — before its
first action. The QC Portal reads those lines to drive the run's progress bar, and it costs you
nothing.

---

## Phase 1 — Intake

### 1. The two inputs
- **ClickUp ticket** — URL `https://app.clickup.com/t/<id>` or the bare `<id>`.
- **App / page URL** — *the QC provides this in chat.* Never assume a host; never hardcode
  `localhost`. Use exactly the URL given; it also tells you which environment you're on.
- If either is missing, ask **one** short question, then continue.

### 2. Read what is already on disk FIRST (fast, offline, authoritative)
The Portal has usually crawled the ticket already. Look before you call any MCP tool:

| Path | What it gives you |
|------|-------------------|
| `testing/tickets/<ticket-folder>/ticket.json` | the ticket: title, description, status, custom fields |
| `testing/tickets/<ticket-folder>/*comment*` | comments — often where the real acceptance detail lives |
| `testing/tickets/<ticket-folder>/attachments/` | mockups, screenshots, spec files |
| `testing/tickets/<ticket-folder>/summary.md` | a prior QC brief for this ticket, if one was made |
| `testing/tickets/<ticket-folder>/testcases/v<N>.md` (or `.csv`) | **the manual test cases** — use the HIGHEST `v<N>` unless the run named one |
| `testing/environments.md` | the app URLs and test-account credentials to use — prefer these over inventing any |
| `testing/knowledge/*.md`, `testing/memory/*.md` | project rules, terminology, known gotchas |

The folder may be nested (`PARENT/CHILD/`) for a subtask — find it by listing
`testing/tickets/`. Only if the ticket data is missing on disk, fetch it: `clickup_get_task` with
the id (`clickup_search` first if you only have a name). If the ClickUp tool is unavailable too,
ask the QC to paste the ACs.

### 3. Write down, verbatim
- every Acceptance Criterion (AC1, AC2, …) and each sub-point;
- **every test case id and title** from the test-case file (`TC-01`, …) — spelled exactly as
  written there, because the report must report per id. **Parse that file ONCE** into a compact
  index you keep (id · suite · summary · expected, grouped by test suite) and write it into
  `progress.md` in Phase 3. A 100-row CSV re-sliced with a fresh `awk`/`python`/`sed` every time
  you need a different suite costs a dozen round-trips for data you already read;
- every **exact expected string** the ticket names — button labels, field labels, placeholders,
  headings, option lists, toast/error messages, empty-state text, formats (e.g. dates as
  `dd-MMM-yyyy`), counts, sort order;
- the **design/Figma link** if present (used for UI comparison in `checklist.md`);
- the **record/data context** to use (which record, which tab).

Keep this list — it is your source of truth for Phase 5.

### 4. Reconcile the ticket against the implementation (when you may read the source)
If the run asked you to read the source code, do it **now, once, and read-only**: start from any
`testing/knowledge/source-map-*.md` (it indexes screens/routes/models with file paths — open what
it names instead of exploring), then Grep/Glob/Read only the screens, routes, fields and messages
the ticket names. You are looking for the **real expected behavior**: exact field names, validation
limits, option lists, state machines, role checks, error strings.

Where ticket and implementation disagree, note both — that gap is itself worth reporting — and
carry the expected behavior forward **as behavior** (a sentence a user could verify), never as a
code reference. Never modify the code.

### 5. If this is a BUG ticket (no test cases)
A run may tell you the ticket is a bug and that no test cases exist or are required. Then:
- **Do not** look for a test-case file, and do not invent acceptance criteria.
- Read the ticket's own description + comments + attachments to extract the **reported steps**,
  the **reported actual** and the **reported expected**.
- Your scenario matrix (Phase 2) becomes: the exact repro steps, the reported edge conditions,
  and the closest neighbouring flows (regression check around the fix).
- Pass/Fail is decided by **whether the reported bug still reproduces**, not by feature ACs. Keep
  the same report structure and use the per-case table for "one row per reported symptom".

## Phase 2 — Plan

For **each** AC (or each test case) you check three layers (full detail in `checklist.md`):
- **Functional** — the action/behavior the AC describes works and produces the stated result.
- **Content** — every visible string matches the ticket exactly (label, placeholder, button,
  heading, option, message, format). Misspellings, wrong casing, wrong wording = a bug.
- **UI / visual** — layout, alignment, spacing, colors, icons, and every state
  (default / hover / focus / disabled / loading / empty / error / selected). If a design link
  exists, compare against it.

### Decompose each AC into a Scenario Matrix (this is what makes the test "deep")
An AC is **not** one test — the happy path passing tells you almost nothing. Before capturing,
break **every** AC into concrete scenarios across these classes, then test each:

- **Happy path** — the exact flow the AC describes, with valid data.
- **Alternate paths** — other valid ways to reach the same outcome the AC allows.
- **Negative** — invalid input / wrong order / missing required → the right error, no bad data.
- **Boundary** — at/just-over the min and max (length, count, date window, selection cap).
- **State** — empty, loading, error, disabled, selected, read-only, and the transitions between.
- **Implied-but-unstated** — cancel, reload mid-flow, browser back, persistence, permissions,
  double-click — behavior the AC assumes but never spells out.

Open **`edge-cases.md` now** and, for each input/control/list the AC touches, pull the
applicable rows into the matrix — **in its Tier 1 → Tier 2 → Tier 3 order**, which is what keeps
the run finishable. Write the matrix as a short table per AC:

```
AC2 — Assign consent forms (assign dialog)
| # | Scenario class | Concrete case | Expected | Evidence to capture |
|---|----------------|---------------|----------|---------------------|
| 2.1 | Happy | select 2 forms, Assign(2) enables | counter "2", button "Assign (2)" enabled | ac2-select2.png |
| 2.2 | Boundary | select 0 | Assign button disabled | ac2-zero.png |
| 2.3 | Negative | search a non-matching term | empty-state text shown | ac2-search-empty.png |
| 2.4 | State   | open category dropdown | full option list, correct order | ac2-dropdown.png |
| 2.5 | Implied | Cancel after selecting | dialog closes, selection discarded | ac2-cancel.png |
```

This matrix — not just "one screenshot per AC" — drives Phase 4 capture and Phase 5 judgment.
Scale it to the AC's complexity: **4–8 rows for a simple AC, 8–14 for a form/dialog AC**, Tier 1
rows first. When a test-case file exists, every test case must appear as at least one row, tagged
with its case id, and the ticket's own ACs fill the gaps the cases don't cover.

Record the matrix where it survives an interruption (see Phase 3's `progress.md`) — a run can be
paused and resumed, and re-deriving the plan is wasted work.

### Note the data precondition for each scenario
Each scenario needs a specific data state — a Signed row, an Expired row, an empty list, a
record you're allowed to edit. Before Phase 4, mark each matrix row with the **precondition** it
needs and whether that data is reachable on the QC-provided environment:
- **Reachable** — find it / create the minimal data to reach it (non-destructively), then test.
- **Not present and not creatable without a mutation** → mark the row **Blocked — data not
  available** and say what state was needed. Do **not** infer a Pass from a different record.
- If a whole AC depends on data only the QC can seed, ask the QC for it (one short question)
  before reporting the AC Blocked.
A scenario tested against the wrong data state is worse than an honest Blocked.

### Write a Capture Plan FIRST (do not skip — this is what prevents a "missing evidence" verdict)
Before touching the browser, write a short plan: for **each AC**, list **every screen, dialog,
dropdown, and state** that AC mentions, and which one screenshot + content-inventory you'll
take for each. Example shape:

```
AC1 (list screen): list rows, status counts, EACH filter applied, sort across dates, a
     Signed row + an Expired row (download action).
AC2 (assign dialog): dialog open, OPEN the category dropdown (capture all options), type in
     search (capture filtered result), select 2 (counter + Assign(2)).
AC4 (sign dialogs): Clinician-to-Sign summary + dropdown + signature loaded; Patient-to-Sign
     pad; Nurse-to-Sign selector; the no-signature error; View-Details dynamic data.
AC6 (DIFFERENT screen — Admin → create/edit): Type/Categories/Duration fields.
```

**Key the plan by screen + state, not by AC.** Several ACs usually share a screen; capture that
state **once** and let every scenario row that needs it point at the same file
(`assign-dialog.md` / `ac2-assign-dialog.png`). Re-capturing the same screen per AC is the most
common way a run runs out of time.

Two rules from experience:
- **Each AC may live on a different screen.** If an AC's screen is not reachable from the
  QC-provided URL (e.g. an Admin create/edit screen), ask the QC for that URL or mark that AC
  **Blocked/out-of-scope** in the report — don't fake a Pass from indirect evidence.
- **A dropdown/popup must be opened to capture its contents** (closed dropdowns have no options
  in the DOM). Plan to open every dropdown and every dialog the AC names.

Open `checklist.md` now and keep it beside you; it enumerates exactly what to look for. Your
Capture Plan = the scenario matrix above (the checklist + `edge-cases.md` applied to this
ticket's specific screens) — one capture line per scenario row, not just one per AC.

## Phase 3 — Setup

Create, **at the project root**, under `testing/test-result/` (use the ticket id + a short slug):

```
testing/test-result/<ticket-id>-<slug>/
├── report.md            # final table report (Phase 7)
├── issues.md            # defects only, each with a screenshot (Phase 7)
├── progress.md          # the scenario matrix + what has been captured/judged (live)
├── screenshots/         # every capture (happy-path + ISSUE- captures)
└── evidence/            # one .md "content inventory" per screen state (Phase 4)
```

Example: `testing/test-result/86eve8hqb-consent-form/`.

> ⚠️ **The `testing/test-result/` prefix is required.** That is where the QC Portal looks for the
> report; a folder written straight under `testing/` will not be found, and the run will be shown
> as producing no results even though the files exist. Note it also keeps run output separate from
> `testing/tickets/` (crawled ticket input).

Create all of it in **one** `Bash` call (`mkdir -p …/screenshots …/evidence`) — the capture tools
do not create parent folders, so a missing `evidence/` fails your first inventory write.

**`progress.md` is required, and it is written BEFORE the first browser call.** It holds the
Phase-2 scenario matrix — every row, with its evidence filename and a status column
(`pending` / `captured` / `judged`) — plus the test-case ids it covers. Two reasons it is not
optional:
- A 100-case ticket's matrix cannot live in your head. Written down, it is what stops the run
  from quietly testing 20 cases and reporting on 100.
- A run can be **paused and resumed** (or the server restarted). On resume, read `progress.md`
  first and continue from the first row that isn't `captured` instead of starting over.

Update it as you capture and as verdicts come back. If you find yourself in Phase 4 without a
`progress.md`, stop and write it — that means Phase 2 never really happened.

**If the folder already exists from an earlier run of this ticket**, do not trust what's in it:
list `evidence/` and `screenshots/` first and either delete the stale files or re-capture over
them. Stale evidence from a previous run is the one way a subagent can "verify" a screen that no
longer looks like that — a false Pass with a real screenshot attached.

## Phase 4 — Collect evidence (main agent + browser only)

Follow `playwright-recipes.md` exactly — it carries the real tool parameter names, and a wrong
one is a wasted turn. In short:

1. **Log in once** (recipe R1) using the URLs/accounts from `testing/environments.md`, else the
   login section of the project `CLAUDE.md`. Never copy credentials or an OTP into any saved file
   or screenshot. One login lasts the whole run.
2. **Navigate** to the QC-provided URL and **wait for the screen's own text**
   (`browser_wait_for { text }`), not a fixed sleep — it's faster and it *is* the assertion.
3. Write every capture **straight into the run folder** by passing the path as the tool's
   `filename` — a relative path resolves against the project root, so
   `testing/test-result/<ticket-id>-<slug>/evidence/list.md` is all you need. The folder must
   already exist (Phase 3 created it); the tools do not create parent directories.
4. For **every screen / dialog / state** in the Capture Plan, do BOTH:
   - **Screenshot** it into `screenshots/` with a descriptive name (`ac1-list.png`,
     `ac2-assign-dialog.png`, `ac4-sign-clinician.png`), written **directly** via the tool's
     `filename` (recipe R5) — no copy step afterwards. Default to the viewport, or scope the shot
     to the dialog; use `fullPage` only when the finding needs the whole page.
   - **Save a content inventory** into `evidence/<screen>.md` — a text dump of the screen's
     headings, labels, placeholders, button texts, table headers, badges/status text, option
     lists, visible values, and any messages. Use the `browser_evaluate` recipe **with
     `filename`** (recipe R3) so it lands on disk in one call. This is what lets the subagents
     check spelling/labels/placeholders **without** looking at the images.
   - Exercise interactive states the ACs mention: open each dialog, open dropdowns (capture
     the option list), apply filters, type into search, trigger validation/empty/loading.
   - **Walk the scenario matrix, not just the happy path.** For each row, drive the negative /
     boundary / state / implied case from `edge-cases.md` and capture its evidence (the
     validation message, the disabled button, the empty-state, the value-after-reload). Stay
     **non-destructive**: drive up to the enable-state, never click the final mutating submit
     on shared data unless the user said so — most edge cases are visible before commit.
   - Mark the row `captured` in `progress.md`.
5. **Reuse, don't re-shoot.** If a state is already captured for another AC, point the new row at
   the existing file.
6. **Safety:** the target is a **shared environment**. Do **not** click the final mutating
   action (submit signature, delete, complete/close, send) unless the user explicitly asked.
   Drive up to the point the button *enables*, screenshot that, then stop. Mark such rows
   **⚠️ Passed-with-issue** and say exactly what was not committed.
7. 🐞 **Every suspected bug gets a screenshot immediately**, saved as `ISSUE-<area>.png`. A bug
   with no screenshot does not count as logged.
8. Check the console for errors on the main flows (recipe R10).

Do not analyze deeply yet — in this phase you are a camera + a transcriber. Collect complete
evidence for every matrix row before moving on.

## Phase 5 — Analyze (fan out one subagent per AC)

Now hand the analysis to subagents so each AC gets focused, careful judgment. Read
`subagents.md` for the exact procedure and prompt template. In short:

1. For each AC, spawn **one subagent** (Agent tool, `subagent_type: general-purpose`). Send all
   the AC subagents **in a single message** so they run in parallel. Group ACs that share the same
   screen/evidence into one subagent when there are many.
2. Give each subagent: the **AC text** (verbatim, with all expected strings), the **test-case ids**
   it covers, the **scenario matrix** for that AC (from Phase 2), any **expected behavior you
   confirmed from the implementation** (phrased as behavior, never as code references), the
   **paths** to the relevant `evidence/*.md` and `screenshots/*.png` files, the **design link** if
   any, and the **path** to `checklist.md` (let it read the file — don't paste the whole checklist
   into every prompt).
3. Tell it to **read the content inventory first** and settle Content/Functional rows from that
   text, opening a screenshot only for a UI/Visual row or to confirm a finding. Reading every PNG
   is the most expensive mistake in this phase.
4. Require each subagent to judge **every scenario row in the matrix** (happy + negative +
   boundary + state + implied), and return a **strict structured verdict**: status
   (Passed / Passed-with-issue / Failed / Blocked / Not Tested), a one-line reason, a per-case
   verdict line, a **per-scenario pass/fail line**, and a list of findings — each finding with
   layer (Functional/Content/UI), what was expected, what was observed, severity, and the
   screenshot filename. The template in `subagents.md` makes this exact. An AC where the happy
   path works but a negative/boundary scenario fails is a **Failed** (or Passed-with-issue), not
   a Pass.
5. Subagents must **not** open the browser and must **not** go read the application's source
   code. They judge the evidence you collected.

## Phase 6 — Aggregate (and the bounded re-capture loop)

1. Collect every subagent's structured verdict; update `progress.md` rows to `judged`.
2. **Re-capture loop — do it once, do not skip it.** For every subagent that returned
   **"Missing evidence"** or a Passed-with-issue caused by something that wasn't captured:
   - If that evidence **is capturable** on an in-scope screen → go back to Phase 4, capture it
     (open the dropdown / popup, apply the filter, reach the state), save the new screenshot +
     inventory, and **re-run just that one subagent** with the new files.
   - Do **one** such round. Anything still unresolved after it is reported honestly as
     **⛔ Blocked** with the reason — a second and third round eats the run's budget for
     diminishing returns.
   - A missing-evidence gap is only acceptable in the final report when it is a deliberately
     skipped mutation on shared data, an out-of-scope screen the QC hasn't provided, or data that
     can't be created non-destructively — never because you simply didn't look. A finding with no
     screenshot must be re-shot or dropped.
3. Decide each AC's final status with `checklist.md` §F (worst layer wins: a Content or UI bug on
   an otherwise working AC makes it **Failed** if it violates the ticket, else
   **Passed-with-issue** with the finding recorded). Collate all real defects into the issues
   list, numbered ISSUE-1, ISSUE-2, … Keep coverage gaps and intentionally-skipped mutations as
   **follow-ups**, separate from defects.
4. Count the buckets and check they reconcile: Passed + Passed-with-issue + Failed + Blocked +
   Not Tested (+ Cancelled) = Total. Those are the numbers Phase 7's Execution Summary must show.

## Phase 7 — Report

Using the formats in `templates.md`:
1. Write `report.md`. Its **first three sections are a fixed contract** — `## 1. Test Suite
   Executed`, `## 2. Covered Flow`, `## 3. Execution Summary` — with the exact headings and table
   shapes `templates.md` shows, on every run, even a blocked or failed one. Then the per-AC table,
   the per-case table (**using the test-case ids exactly as the test-case file spells them**), the
   scenario coverage table, the content/UI summary, and the QC notes.
2. **Pure GitHub-Flavored Markdown, no raw HTML** — no `<style>`, `<table>`, `<br>`, or `<img>`.
   Tables are pipe tables; images are `![alt](screenshots/file.png)`. The Portal's viewer prints
   raw HTML as literal text, which corrupts the report.
3. Write `issues.md` — one entry per defect: severity, AC/case, numbered repro steps, expected,
   actual, screenshot path. If zero defects, write "No issues found."
4. Post the user a short summary: the Execution Summary counts table and the per-AC status table,
   then the number of issues and the folder path.

---

## Hard rules (always)

- **The report reads like a user's report.** No files, components, functions, or line numbers in
  `report.md` / `issues.md`. Reading the source to learn the *expected* behavior is allowed (and
  asked for) — presenting it as *evidence* of how the app behaves is not. Every verdict traces to
  a screenshot or a captured string.
- **Never modify the application.** Read-only in the repo; non-destructive in the app.
- **App URL comes from the QC in chat.** Never assume an environment or hardcode a host. Use
  `testing/environments.md` for accounts and never write credentials anywhere.
- **Output goes in `testing/test-result/<ticket-id>-<slug>/`.** Nowhere else.
- **A bug always has a picture.** Every Failed/Passed-with-issue links an `ISSUE-*.png` in
  `screenshots/`.
- **Be exact about strings.** Quote the real on-screen text and the exact expected text
  (`shows "Days90"`, expected `"Expires in 90 days"`). Spelling, casing, spacing, and wording
  all count.
- **Check states, not just presence.** default / hover / focus / disabled / loading / empty /
  error / selected — per `checklist.md`.
- **Test scenarios, not just the happy path.** Every AC is decomposed into a scenario matrix
  (happy / negative / boundary / state / implied) per `edge-cases.md`; a Pass requires the edge
  cases to hold, not only the happy path. Name any scenario you skip as "N/A — <why>" or
  `◻️ Not Tested — <why>` so the coverage gap is visible, never silent.
- **Never click through JavaScript to make something work.** A forced `.click()` bypasses the
  disabled/covered/invisible checks and turns a real bug into a false Pass (recipe R6).
- **Reproducible.** Every issue has numbered steps to reproduce.
- **Don't mutate shared data** unless told; stop at the enable-state and mark
  Passed-with-issue.
- **One browser, one driver.** Only the main agent uses Playwright. Subagents analyze files.

## Tooling quick reference

- **Ticket:** the crawled files under `testing/tickets/<folder>/` first; `clickup_get_task` /
  `clickup_search` only as a fallback.
- **Browser (Playwright MCP):** `browser_navigate`, `browser_wait_for` (`text` / `textGone`),
  `browser_snapshot` (`target`, `depth`, `filename`), `browser_evaluate` (`function`, `filename`
  — the content inventory), `browser_click` / `browser_type` / `browser_select_option` (all take
  `target`), `browser_press_key`, `browser_take_screenshot` (`filename` = an absolute path inside
  the run's `screenshots/`), `browser_console_messages`. Exact usage in
  `playwright-recipes.md` — check the parameter table there before your first call.
- **Subagents:** Agent tool, `subagent_type: general-purpose`, one per AC (or per AC-group),
  launched in parallel.
