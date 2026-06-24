# Edge cases — the catalogue you apply to every control

The other files cover *that the happy path works*. This file covers **going deep**: for every
field, control, list, and flow an AC touches, you walk the relevant rows below and test each.
A "Pass" on the happy path means nothing if the negative and boundary cases are untested.

> **Shared-environment rule (NON-DESTRUCTIVE).** You may type anything into a field and trigger
> client-side validation, but you **stop at the enable-state** — do **not** click the final
> mutating submit (save / sign / delete / send / complete) unless the user explicitly told you
> to. Most edge cases below are observable *before* commit (the field error, the disabled
> button, the counter). Drive up to that point, screenshot it, and mark the scenario tested.
> If a case can only be confirmed by committing (e.g. server-side uniqueness), mark it
> **Partial — needs commit (not run on shared data)** and say so.

---

## How to use this file

1. In **Phase 2**, after listing each AC's screens, build a **scenario matrix** (see SKILL.md
   Phase 2). For each input/control the AC touches, pick the applicable rows from §1–§7 below.
2. In **Phase 4**, exercise each scenario and capture evidence (the validation message, the
   disabled button, the unchanged counter, the preserved value after reload).
3. In **Phase 5**, each subagent judges the **whole scenario matrix** for its AC, not just the
   happy path.

Not every row applies to every control — use judgment, but **default to testing more**. A row
you deliberately skip should be named as "N/A — <why>" so coverage is visible, not silently
dropped.

---

## §1. Text / textarea inputs

- [ ] **Empty** — leave blank, blur/submit → required error fires (or field is optional and no error).
- [ ] **Whitespace-only** — spaces/tabs only → treated as empty (not accepted as valid content).
- [ ] **Leading / trailing spaces** — `"  John  "` → trimmed on display/save, or flagged.
- [ ] **Min length** — one char below the stated minimum → error; exactly at minimum → accepted.
- [ ] **Max length** — at the limit → accepted; over the limit → blocked or truncated *with*
      feedback (not a silent cut). Paste a 5000-char string and watch for layout break / freeze.
- [ ] **Special characters** — `< > & " ' / \ % $ # @ { }` and emoji → no broken render, no
      HTML injection (text shows literally, not interpreted), no crash.
- [ ] **Unicode / accents / RTL** — `José`, `日本語`, `محمد` → render correctly, not `???`/boxes.
- [ ] **Numbers in a text field / letters in a number field** — wrong type rejected or coerced
      sensibly.
- [ ] **Only-format-invalid** — e.g. email `john@`, phone `abc` → the *specific* format error,
      not a generic one.

## §2. Number / currency / quantity inputs

- [ ] **Zero** — accepted or rejected per the rule; check it's not silently treated as empty.
- [ ] **Negative** — `-1` → rejected where it makes no sense (age, count, price).
- [ ] **Decimals / precision** — `1.999`, `0.001` → rounded/formatted as the ticket says;
      currency shows 2 dp.
- [ ] **Very large** — `999999999` → no overflow, no scientific notation, no layout break.
- [ ] **Boundaries** — at min, min−1, max, max+1 → correct accept/reject at each edge.
- [ ] **Non-numeric** — letters / symbols → blocked.
- [ ] **Leading zeros** — `007` → handled (kept or stripped consistently).

## §3. Date / time pickers

- [ ] **Past / future limits** — a date outside the allowed window → blocked with the right message.
- [ ] **Start after end** — for ranges, end < start → error; equal start=end handled.
- [ ] **Invalid / impossible** — `31-Feb`, `00-00`, manual typing of garbage → rejected.
- [ ] **Format** — displayed in the ticket's format (`dd-MMM-yyyy` unless stated); the same
      everywhere.
- [ ] **Timezone** — value entered = value shown after reload (no off-by-one-day drift).
- [ ] **Clear** — clearing a non-required date works; clearing a required one re-triggers the error.

## §4. Dropdowns / radio / checkbox / multi-select

- [ ] **No selection** — leave at default/placeholder → required error if mandatory.
- [ ] **Full option set** — open and list ALL options; verify count, wording, order vs ticket
      (recipe R7). Look for missing, duplicated, or extra options.
- [ ] **Search-in-dropdown** — type a match (filters), a non-match (empty-state), partial,
      different case → behaves; clearing restores the full list.
- [ ] **Select then deselect** — counter and dependent buttons update both ways
      (e.g. `Assign (2)` → `Assign (0)` → button disables).
- [ ] **Select all / none** — if present, toggles every row and the counter.
- [ ] **Max selection** — if a cap exists, the (cap+1)th is blocked with feedback.

## §5. Search / filter / sort / pagination / lists

- [ ] **No results** — a query that matches nothing → the exact empty-state text, not a blank box.
- [ ] **Special chars / very long query** → no crash; sensible handling.
- [ ] **Whitespace / case** — `"  signed "` and `"SIGNED"` behave per spec (usually trimmed,
      case-insensitive).
- [ ] **Clear / reset** — restores the unfiltered list and resets the counter.
- [ ] **Combined filters** — two+ filters applied together narrow correctly; clearing one keeps
      the other.
- [ ] **Sort edges** — sort with ties, with empty/null values, ascending↔descending toggle,
      and across the field the AC names (e.g. "latest first" actually newest-to-oldest).
- [ ] **Pagination edges** — first page (prev disabled), last page (next disabled), per-page
      change resets/keeps page sensibly, count text matches the rows shown, last-item-on-a-page
      deletion behavior (if applicable, non-destructive: just observe).
- [ ] **Single vs many vs zero rows** — list renders correctly at each (1 row, full page, empty).

## §6. Buttons / actions / forms as a whole

- [ ] **Disabled-until-valid** — primary button stays disabled until every required field is
      valid; enables the instant they are; re-disables if you invalidate one again.
- [ ] **Double-click / rapid click** — clicking the enabled action twice fast doesn't double-fire
      (observe the loading/disable-on-submit guard; do NOT actually commit on shared data).
- [ ] **Cancel / close** — discards changes; reopening shows the original (or the documented
      "keep draft" behavior). Escape and overlay-click do the same as Cancel.
- [ ] **Unsaved-changes guard** — if the ticket implies one, navigating away mid-edit warns.
- [ ] **Tab / keyboard** — Tab order is logical; Enter submits where expected; focus lands in
      the dialog and is trapped.

## §7. Cross-cutting / state & resilience

- [ ] **Reload mid-flow** — refresh with the dialog/form open → reasonable recovery (re-prompts
      or preserves per spec), no white screen.
- [ ] **Browser back / forward** — returns to a sane state, doesn't duplicate or lose data.
- [ ] **Persistence** — a value the AC says should survive (autosave, draft) is still there
      after reload or navigating away and back.
- [ ] **Slow / failed network** — if observable (throttle or a failing call), a spinner shows
      and a clear error appears — not an infinite spinner or a silent dead button.
- [ ] **Permissions / read-only** — a state that should be locked (e.g. signed form, other
      user's record) cannot be edited; the controls are genuinely disabled, not just hidden.
- [ ] **Concurrent / stale data** — if the ticket implies it, opening the same record twice and
      changing one doesn't silently clobber (observe only; don't commit).
- [ ] **Console** — no red errors during any of the above (recipe R10).

---

## Severity reminder for edge-case findings (ties to checklist §E)

- A boundary/negative case that **lets bad data through or crashes** → **High**.
- A wrong/missing/generic validation message, a missing loading/empty/error state, a format
  drift at an edge → **Medium**.
- Cosmetic-only at an edge (slightly off spacing when the error shows) → **Low**.
