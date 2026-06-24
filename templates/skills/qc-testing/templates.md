# Output templates — report.md & issues.md

Two artifacts per run, in `testing/<ticket>/`. The report is **table-driven** so QC can scan
it; the issues log holds the full reproduction detail. Never reference source code in either.

---

## `report.md` (table view)

```markdown
# <Ticket name> — QC Test Report

| Field | Value |
|-------|-------|
| **Ticket** | <url> |
| **Feature / Tab** | <area tested> |
| **Tested URL** | <the app URL the QC provided> |
| **Record / Patient** | <context used> |
| **Design ref** | <figma link or "none"> |
| **Environment** | <derived from the tested URL> |
| **Date** | <YYYY-MM-DD> |
| **Tester** | QC |

## Result Summary

| Total ACs | ✅ Pass | ❌ Fail | ⚠️ Partial | ⛔ Blocked | 🐞 Issues |
|:---------:|:------:|:------:|:----------:|:---------:|:---------:|
| 6 | 4 | 1 | 1 | 0 | 3 |

**Verdict:** <one line — ready / not ready, key risks, # open issues>

## Test Results

`Scenarios` = passed / total from that AC's scenario matrix (happy + negative + boundary + state
+ implied). A high pass-count on the happy path with a failed edge scenario still makes the AC
Fail/Partial — the column shows reviewers the depth tested, not just the verdict.

| # | Acceptance Criterion | Steps to Test | Expected Result | Actual Result | Scenarios | Status | Evidence |
|---|----------------------|---------------|-----------------|---------------|:---------:|:------:|----------|
| AC1 | <short title> | 1. … <br> 2. … | <what AC requires> | <what you saw> (see ISSUE-2) | 4/4 | ✅ Pass | <img src="screenshots/ac1.png" width="150"/> |
| AC2 | … | 1. … | … | … (see ISSUE-1) | 4/5 | ❌ Fail | <img src="screenshots/ISSUE-ac2.png" width="150"/> |
| AC3 | … | 1. … | … | not committed on shared data | 5/6 | ⚠️ Partial | <img src="screenshots/ac3.png" width="150"/> |

> Legend: ✅ Pass · ❌ Fail · ⚠️ Partial · ⛔ Blocked. Details of every Fail/Partial are in `issues.md`.

### Scenario coverage (per AC)

Expand each AC's matrix so reviewers see exactly which edge cases were tested. Mark skipped
rows `N/A — <why>`; never drop a row silently.

| AC | # | Class | Concrete case | Expected | Result | Evidence |
|----|---|-------|---------------|----------|:------:|----------|
| AC2 | 2.1 | Happy | select 2 forms | Assign (2) enabled | ✅ | ac2-select2.png |
| AC2 | 2.2 | Boundary | select 0 | Assign disabled | ✅ | ac2-zero.png |
| AC2 | 2.3 | Negative | search no-match | empty-state text | ❌ (ISSUE-1) | ISSUE-ac2-search.png |
| AC2 | 2.4 | State | open dropdown | full option list | ✅ | ac2-dropdown.png |
| AC2 | 2.5 | Implied | Cancel discards | selection cleared | ✅ | ac2-cancel.png |

## Content & UI checks (summary)

| Check | Result | Notes |
|-------|:------:|-------|
| Labels match ticket | ✅ / ❌ | … |
| Placeholders match | ✅ / ❌ | … |
| Button texts match | ✅ / ❌ | … |
| Dropdown/option lists | ✅ / ❌ | … |
| Status/badge text | ✅ / ❌ | … |
| Date/number formats | ✅ / ❌ | … |
| Empty / loading / error states | ✅ / ❌ | … |
| Layout / alignment / spacing | ✅ / ❌ | … |
| Colors / icons / typography | ✅ / ❌ | … |
| No red-flag tokens (undefined/null/{…}/raw codes) | ✅ / ❌ | … |
```

Rules for the table:
- Keep each cell tight (a phrase). Full repro goes in `issues.md`; reference `ISSUE-n` in the
  Actual cell.
- `<br>` breaks lines in a cell; embed evidence with
  `<img src="screenshots/<file>" width="150"/>` so it renders as a thumbnail.
- Every Fail/Partial row's Evidence must point at an `ISSUE-*.png`.

---

## `issues.md`

```markdown
# <Ticket name> — Issues Found

> <environment from the tested URL>, black-box QC. Run date <YYYY-MM-DD>. Screenshots in `screenshots/`.

## ISSUE-1 — <short title>  [Severity: High | Medium | Low]  [Layer: Functional | Content | UI]
- **AC:** ACx
- **Steps to reproduce:**
  1. …
  2. …
- **Expected (per AC / design):** "<exact expected>"
- **Actual:** "<exact observed>"
- **Screenshot:** `screenshots/ISSUE-<area>.png`

(repeat per issue, numbered; if zero, write "No issues found." + any non-defect follow-ups)
```

Severity (from `checklist.md` §E): **High** = blocks the AC / data wrong / crash;
**Medium** = real defect but AC still works (wrong label, format, order, missing state, layout
break); **Low** = cosmetic only.

Status (from `checklist.md` §F): **Pass / Fail / Partial / Blocked** — Partial always states
whether it's a defect or an intentionally-skipped mutating step on shared data.

---

## Final chat summary (post to the user)
1. The **Result Summary** counts table.
2. The **per-AC status** table (AC | title | status).
3. Issue count + the folder path `testing/<ticket>/`.
4. Any follow-ups (e.g. mutating steps not run on shared data; design comparison pending a
   design reference).
