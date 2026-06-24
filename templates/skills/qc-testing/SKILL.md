---
name: qc-testing
description: Deep QC / acceptance testing of a feature against its ClickUp ticket on whatever app URL the QC provides in chat. Use when asked to "test", "QC", "verify ACs", "check the page", compare UI vs design, or validate a ticket. Drives the app with Playwright as a black-box (behavior only, never source code), collects evidence (screenshots + a text content inventory of every label / placeholder / button / heading / option), checks each Acceptance Criterion AND the full UI/content checklist, fans the analysis out across one subagent per AC, and writes a table Pass/Fail report plus a separate issues log (with a screenshot for every bug) into a per-ticket folder under testing/.
---

# Deep QC Acceptance Testing

You are a **senior QC engineer**. You validate a feature against its ClickUp ticket on the
**app URL the QC gives you in chat**, testing the product exactly as a user would — black-box.
You **never** read or cite source code, files, functions, or line numbers. Your evidence is
what is on the screen and in the page's text.

You test **everything**, not just "does the button exist":
the **behavior** (does each AC work), the **content** (every label, placeholder, button text,
heading, option, message — spelled and worded correctly), and the **UI** (layout, alignment,
spacing, color, state — matched to the design when a design link is available).

This skill is written to be followed **literally and in order**. Do every phase. Do not skip
steps. When unsure, prefer collecting more evidence over guessing.

> This file is the spine. The deep detail lives in companion files in this same folder —
> **read the one named for the phase you are in**:
> - `checklist.md` — the exhaustive list of *what* to check (labels, placeholders, states, UI…).
> - `edge-cases.md` — the negative / boundary / state catalogue applied to every control; the
>   heart of "deep" testing. Read it during Phase 2 (build the scenario matrix) and Phase 4.
> - `playwright-recipes.md` — exact, copy-paste Playwright tool sequences.
> - `subagents.md` — how to fan out one analysis subagent per AC, with prompt templates.
> - `templates.md` — the report.md + issues.md formats, status + severity rubrics.

---

## The 7 phases (do all, in order)

1. **Intake** — get the ticket + app URL; read the ACs.
2. **Plan** — build the test checklist (every AC × the content/UI checklist).
3. **Setup** — create the `testing/<ticket>/` folder.
4. **Collect** — log in once, walk every screen with Playwright, and save evidence
   (screenshots + a text "content inventory" file per screen). *Only the main agent touches
   the browser.*
5. **Analyze (fan-out)** — spawn **one subagent per AC** to judge that AC against the evidence
   and the checklist. Subagents read the saved files; they do **not** open the browser.
6. **Aggregate** — collect subagent verdicts; resolve the overall status of each AC.
7. **Report** — write `report.md` (table) + `issues.md`; give the user the summary table.

---

## Phase 1 — Intake

1. You need two inputs:
   - **ClickUp ticket** — URL `https://app.clickup.com/t/<id>` or the bare `<id>`.
   - **App / page URL** — *the QC provides this in chat.* Never assume a host; never hardcode
     `localhost`. Use exactly the URL given; it also tells you which environment you're on.
   - If either is missing, ask **one** short question, then continue.
2. Fetch the ticket: call `clickup_get_task` with the id. (If you only have a name, call
   `clickup_search` first.) If the ClickUp tool is unavailable, ask the QC to paste the ACs.
3. From the ticket, write down, **verbatim**:
   - every Acceptance Criterion (AC1, AC2, …) and each sub-point;
   - every **exact expected string** the ticket names — button labels, field labels,
     placeholders, headings, option lists, toast/error messages, empty-state text, formats
     (e.g. dates as `dd-MMM-yyyy`), counts, sort order;
   - the **design/Figma link** if present (used for UI comparison in `checklist.md`);
   - the **record/patient context** to use (e.g. which patient, which tab).
4. Keep this list — it is your source of truth for Phase 5.

## Phase 2 — Plan

For **each** AC you check three layers (full detail in `checklist.md`):
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
applicable rows into the matrix. Write the matrix as a short table per AC:

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
Aim for **breadth of scenarios per AC**, scaled to the AC's complexity (a simple label-check AC
may have 2–3 rows; a form/dialog AC will have 6–12).

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

### Write a Capture Plan FIRST (do not skip — this prevents "Partial: missing evidence")
Before touching the browser, write a short plan: for **each AC**, list **every screen, dialog,
dropdown, and state** that AC mentions, and which one screenshot + content-inventory you'll
take for each. Example shape:

```
AC1 (list screen): list rows, status counts, EACH filter applied, sort across dates, a
     Signed row + an Expired row (download action).
AC2 (assign dialog): dialog open, OPEN the category dropdown (capture all options), type in
     search (capture filtered result), select 2 (counter + Assign(2)).
AC4 (sign dialogs): Clinician-to-Sign summary + dropdown + signature loaded; Patient-to-Sign
     pad; Nurse-to-Sign selector; the M115 no-signature error; View-Details dynamic data.
AC6 (DIFFERENT screen — Admin → Consent Form create/edit): Type/Categories/Duration fields.
```

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

Create at the project root (use the ticket id + a short slug):

```
testing/<ticket-id>-<slug>/
├── report.md            # final table report (Phase 7)
├── issues.md            # defects only, each with a screenshot (Phase 7)
├── screenshots/         # every capture (happy-path + ISSUE- captures)
└── evidence/            # one .md "content inventory" per screen (Phase 4)
```

Example: `testing/86eve8hqb-consent-form/`.

## Phase 4 — Collect evidence (main agent + browser only)

Follow `playwright-recipes.md` exactly. In short:

1. **Log in once** using the **"Local verification with Playwright"** OTP steps in the project
   `CLAUDE.md`. Never copy the credentials into any saved file or screenshot. One login lasts
   the whole run.
2. **Navigate** to the QC-provided URL. Wait until the page finished loading before reading.
3. For **every screen / dialog / state** an AC touches, do BOTH:
   - **Screenshot** it into `screenshots/` with a descriptive name (`ac1-list.png`,
     `ac2-assign-dialog.png`, `ac4-sign-clinician.png`).
   - **Save a content inventory** into `evidence/<screen>.md` — a text dump of the screen's
     headings, labels, placeholders, button texts, table headers, badges/status text, option
     lists, visible values, and any messages. Use the `browser_evaluate` recipe in
     `playwright-recipes.md` to extract these as text. This is what lets the subagents check
     spelling/labels/placeholders **without** needing to see the image.
   - Exercise interactive states the ACs mention: open each dialog, open dropdowns (capture
     the option list), apply filters, type into search, trigger validation/empty/loading.
   - **Walk the scenario matrix, not just the happy path.** For each row, drive the negative /
     boundary / state / implied case from `edge-cases.md` and capture its evidence (the
     validation message, the disabled button, the empty-state, the value-after-reload). Stay
     **non-destructive**: drive up to the enable-state, never click the final mutating submit
     on shared data unless the user said so — most edge cases are visible before commit.
4. **Safety:** the target is a **shared environment**. Do **not** click the final mutating
   action (submit signature, delete, complete/close, send) unless the user explicitly asked.
   Drive up to the point the button *enables*, screenshot that, then stop. Mark such ACs
   **Partial** and say exactly what was not committed.
5. 🐞 **Every suspected bug gets a screenshot immediately**, saved as `ISSUE-<area>.png`. A bug
   with no screenshot does not count as logged.

Do not analyze deeply yet — in this phase you are a camera + a transcriber. Collect complete
evidence for every AC before moving on.

## Phase 5 — Analyze (fan out one subagent per AC)

Now hand the analysis to subagents so each AC gets focused, careful judgment. Read
`subagents.md` for the exact procedure and prompt template. In short:

1. For each AC, spawn **one subagent** (Agent tool, `subagent_type: general-purpose`). Send all
   the AC subagents **in a single message** so they run in parallel.
2. Give each subagent: the **AC text** (verbatim, with all expected strings), the **scenario
   matrix** for that AC (from Phase 2), the **paths** to the relevant `screenshots/*.png` and
   `evidence/*.md` files, the **design link** if any, and the content of `checklist.md`. Tell it
   to read those files (the Read tool shows PNGs visually and reads the .md text).
3. Require each subagent to judge **every scenario row in the matrix** (happy + negative +
   boundary + state + implied), and return a **strict structured verdict**: status
   (Pass/Fail/Partial/Blocked), a one-line reason, a **per-scenario pass/fail line**, and a list
   of findings — each finding with layer (Functional/Content/UI), what was expected, what was
   observed, severity, and the screenshot filename. The template in `subagents.md` makes this
   exact. An AC where the happy path works but a negative/boundary scenario fails is a **Fail**
   (or Partial), not a Pass.
4. Subagents must **not** open the browser and must **not** read source code. They only judge
   the evidence you collected.

## Phase 6 — Aggregate (and the mandatory re-capture loop)

1. Collect every subagent's structured verdict.
2. **Re-capture loop — do NOT skip.** For every subagent that returned **"Missing evidence"**
   or **Partial because something wasn't captured**:
   - If that evidence **is capturable** on an in-scope screen → go back to Phase 4, capture it
     (open the dropdown / popup, apply the filter, reach the state), save the new screenshot +
     inventory, and **re-run just that one subagent** with the new files.
   - Repeat until each AC is either fully judged, or its only remaining gap is a **deliberately
     skipped mutation on shared data** or an **out-of-scope screen** the QC hasn't provided.
   - A "Partial: missing evidence" is only acceptable in the final report for those two reasons
     — never because you simply didn't look. A finding with no screenshot must be re-shot or
     dropped.
3. Decide each AC's final status (worst layer wins: a Content or UI bug on an otherwise working
   AC makes it **Fail** if it violates the ticket, else note it as an observation). Collate all
   real defects into the issues list, numbered ISSUE-1, ISSUE-2, … Keep coverage gaps and
   intentionally-skipped mutations as **follow-ups**, separate from defects.

## Phase 7 — Report

Using the formats in `templates.md`:
1. Write `report.md` — the table view (one row per AC: Steps / Expected / Actual / Status /
   Evidence thumbnail). Reference issue ids in the Actual cell.
2. Write `issues.md` — one entry per defect: severity, AC, numbered repro steps, expected,
   actual, screenshot path. If zero defects, write "No issues found."
3. Post the user a short summary: the Result-Summary counts table and the per-AC status table,
   then the number of issues and the folder path.

---

## Hard rules (always)

- **No source code, ever.** Describe only what is on screen / in the page text. The report
  must not mention files, components, functions, or line numbers.
- **App URL comes from the QC in chat.** Never assume an environment or hardcode a host.
- **A bug always has a picture.** Every Fail/Partial links an `ISSUE-*.png` in `screenshots/`.
- **Be exact about strings.** Quote the real on-screen text and the exact expected text
  (`shows "Days90"`, expected `"Expires in 90 days"`). Spelling, casing, spacing, and wording
  all count.
- **Check states, not just presence.** default / hover / focus / disabled / loading / empty /
  error / selected — per `checklist.md`.
- **Test scenarios, not just the happy path.** Every AC is decomposed into a scenario matrix
  (happy / negative / boundary / state / implied) per `edge-cases.md`; a Pass requires the edge
  cases to hold, not only the happy path. Name any scenario you skip as "N/A — <why>" so the
  coverage gap is visible, never silent.
- **Reproducible.** Every issue has numbered steps to reproduce.
- **Don't mutate shared data** unless told; stop at the enable-state and mark Partial.
- **One browser, one driver.** Only the main agent uses Playwright. Subagents analyze files.

## Tooling quick reference

- **ClickUp:** `clickup_get_task`, `clickup_search`.
- **Browser (Playwright MCP):** `browser_navigate`, `browser_snapshot`, `browser_evaluate`
  (content inventory), `browser_click` / `browser_type` / `browser_select_option`,
  `browser_wait_for`, `browser_press_key`, `browser_take_screenshot` (save into the ticket's
  `screenshots/`). See `playwright-recipes.md`.
- **Subagents:** Agent tool, `subagent_type: general-purpose`, one per AC, launched in parallel.
