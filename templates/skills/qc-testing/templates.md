# Output templates — report.md & issues.md

Two artifacts per run, in `testing/test-result/<ticket-id>-<slug>/`. The report is
**table-driven** so QC can scan it; the issues log holds the full reproduction detail.
Neither one references source code.

## Two non-negotiable rules

1. **Pure GitHub-Flavored Markdown — no raw HTML.** The QC Portal renders `report.md` with
   react-markdown, which does **not** render HTML: a `<style>` block, `<table>`, `<br>`, or
   `<img …>` prints as literal source text and corrupts the report. Every table is a pipe table;
   every image is `![alt](screenshots/file.png)`. To put two lines in one cell, separate them
   with ` · ` or `;` — never `<br>`.
2. **Sections 1–3 below are mandatory, in this order, with these exact headings and table
   shapes, on every run** — including a blocked or failed one. Fill every row; never omit a
   section. The Portal parses section 3 for the Pass/Fail counts it shows in History, so its rows
   must be exactly `| <Status label> | <number> | <percent> |`.

---

## `report.md`

````markdown
# <Ticket id> <Ticket name> — QC Test Report

## 1. Test Suite Executed

| Field | Value |
|-------|-------|
| **Suite / Module** | <the feature + screens under test> |
| **Ticket** | <id> — <url> — <title> |
| **Tested by** | QC (Claude) |
| **Test Execution Date** | <YYYY-MM-DD> |
| **Build / Environment** | <the App URL / device target the QC gave> |
| **Acceptance source** | <testing/tickets/<folder>/testcases/v<N>.md + AC refs, or "ticket ACs only"> |
| **Overall Status** | Pass / Partial pass / Fail — <one-line reason> |
| **Case counts** | <N> total · <P> Passed · <F> Failed · <I> issues · <B> Blocked / Not Tested |

## 2. Covered Flow

| Flow | Covered? | Notes |
|------|:--------:|-------|
| <major flow or area 1> | ✅ | <what was verified> |
| <major flow or area 2> | ⚠️ | <what was partial, and why> |
| <major flow or area 3> | ⛔ | <why not covered — out-of-scope screen / data not available> |

## 3. Execution Summary

| Status | Count | % |
|--------|------:|--:|
| ✅ Passed | 12 | 60% |
| ❌ Failed | 3 | 15% |
| ⛔ Blocked | 1 | 5% |
| ◻️ Not Tested | 2 | 10% |
| ⚠️ Passed-with-issue | 2 | 10% |
| **Total** | **20** | **100%** |

**Pass Rate:** 70% — (Passed + Passed-with-issue) ÷ Total
**Completion Rate:** 85% — (Total − Not Tested − Blocked) ÷ Total

**Verdict:** <one line — ready / not ready, key risks, number of open issues>

## 4. Acceptance criteria outcome

| # | Acceptance Criterion | Steps to Test | Expected Result | Actual Result | Scenarios | Status | Evidence |
|---|----------------------|---------------|-----------------|---------------|:---------:|:------:|----------|
| AC1 | <short title> | 1. … 2. … | <what the AC requires> | <what you saw> | 4/4 | ✅ Passed | ![ac1](screenshots/ac1.png) |
| AC2 | … | 1. … | … | … (see ISSUE-1) | 4/5 | ❌ Failed | ![issue-1](screenshots/ISSUE-ac2.png) |
| AC3 | … | 1. … | … | mutating step not run on shared data | 5/6 | ⚠️ Passed-with-issue | ![ac3](screenshots/ac3.png) |

`Scenarios` = passed / total rows from that AC's scenario matrix (happy + negative + boundary +
state + implied). A green happy path with a failed edge row is **not** a Pass — the column shows
reviewers the depth tested, not just the verdict.

## 5. Test Result Details (per case)

| Case ID | Title | Expected | Actual result | Status | Reference | Evidence |
|---------|-------|----------|---------------|:------:|-----------|----------|
| TC-01 | <case title from the test-case file> | <expected> | <observed> | ✅ Passed | | ![tc-01](screenshots/ac1.png) |
| TC-02 | … | … | … | ❌ Failed | ISSUE-1 | ![tc-02](screenshots/ISSUE-ac2.png) |

- **Use the case IDs exactly as they appear** in `testing/tickets/<folder>/testcases/v<N>.md`
  (`TC-01`, `TC_001`, whatever that file uses). The Portal builds an executed test-case sheet by
  matching these ids — a renamed or invented id silently drops the case.
- One row per test case when a test-case file exists. For a **bug ticket** (no test cases), list
  one row per reported symptom / repro step instead and say so in the Acceptance source row.

## 6. Scenario coverage (per AC)

| AC | # | Class | Concrete case | Expected | Result | Evidence |
|----|---|-------|---------------|----------|:------:|----------|
| AC2 | 2.1 | Happy | select 2 forms | Assign (2) enabled | ✅ | ac2-select2.png |
| AC2 | 2.2 | Boundary | select 0 | Assign disabled | ✅ | ac2-zero.png |
| AC2 | 2.3 | Negative | search no-match | empty-state text | ❌ (ISSUE-1) | ISSUE-ac2-search.png |
| AC2 | 2.4 | State | open dropdown | full option list | ✅ | ac2-dropdown.png |
| AC2 | 2.5 | Implied | Cancel discards | selection cleared | N/A — needs a commit on shared data | — |

Every matrix row appears here. A row you skipped is `N/A — <why>`, never dropped silently.

## 7. Content & UI checks (summary)

| Check | Result | Notes |
|-------|:------:|-------|
| Labels match ticket | ✅ / ❌ | … |
| Placeholders match | ✅ / ❌ | … |
| Button texts match | ✅ / ❌ | … |
| Dropdown / option lists | ✅ / ❌ | … |
| Status / badge text | ✅ / ❌ | … |
| Date / number formats | ✅ / ❌ | … |
| Empty / loading / error states | ✅ / ❌ | … |
| Layout / alignment / spacing | ✅ / ❌ | … |
| Colors / icons / typography | ✅ / ❌ | … |
| No red-flag tokens (undefined / null / {…} / raw codes) | ✅ / ❌ | … |

## 8. QC notes & follow-ups

- <coverage gap and why — out-of-scope screen, data not seedable>
- <mutating step intentionally not run on shared data>
- <design comparison pending a design reference>
````

### Rules for the tables

- Keep each cell tight (a phrase). Full repro goes in `issues.md`; reference `ISSUE-n` in the
  Actual cell.
- Status labels come from `checklist.md` §F and are spelled **exactly** as in section 3:
  `✅ Passed`, `❌ Failed`, `⛔ Blocked`, `◻️ Not Tested`, `⚠️ Passed-with-issue`, `🚫 Cancelled`.
- Section 3's counts **must reconcile** with sections 4–6: every case/AC lands in exactly one
  bucket, the Count column is a plain number, and the percentages sum to 100%.
- Do not put any other `| <label> | <number> |` row **above** section 3 whose label reads like a
  status bucket — the Portal takes the first match, so a stray `| Passed | 4 |` earlier in the
  document would be read as the whole run's count.
- Every Failed / Passed-with-issue row's Evidence must point at a screenshot that exists
  (`ISSUE-*.png` for a defect).

---

## `issues.md`

```markdown
# <Ticket name> — Issues Found

> <environment from the tested URL>. Run date <YYYY-MM-DD>. Screenshots in `screenshots/`.

## ISSUE-1 — <short title>  [Severity: High | Medium | Low]  [Layer: Functional | Content | UI]
- **AC / Case:** ACx — TC-0y
- **Steps to reproduce:**
  1. …
  2. …
- **Expected (per AC / design):** "<exact expected>"
- **Actual:** "<exact observed>"
- **Screenshot:** `screenshots/ISSUE-<area>.png`

(repeat per issue, numbered; if zero, write "No issues found." + any non-defect follow-ups)
```

Severity (from `checklist.md` §E): **High** = blocks the AC / data wrong / crash;
**Medium** = real defect but the AC still works (wrong label, format, order, missing state,
layout break); **Low** = cosmetic only.

Status (from `checklist.md` §F): Passed / Passed-with-issue / Failed / Blocked / Not Tested —
Passed-with-issue always states whether it is a minor defect or an intentionally-skipped mutating
step on shared data.

---

## Final chat summary (post to the user)
1. The **Execution Summary** table (section 3).
2. The **per-AC status** table (AC | title | status).
3. Issue count + the folder path `testing/test-result/<ticket-id>-<slug>/`.
4. Any follow-ups (mutating steps not run on shared data; design comparison pending a design
   reference; scenarios blocked on data).
