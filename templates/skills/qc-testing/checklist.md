# QC Checklist — what to test on every screen

Apply this to **every** screen, dialog, and state an AC touches. For each item: compare what
you see / what the page text says against (a) the ticket's exact wording and (b) the design
link if one exists. Anything that differs is a finding — record expected vs actual + a
screenshot. Group findings by layer: **Functional**, **Content**, **UI/Visual**.

Tip for a weak model: most Content checks are **string comparisons** — extract the real text
with the content-inventory recipe (`playwright-recipes.md`) and compare character-by-character
to the expected string. Don't eyeball if you can read the exact text.

---

## A. Content — text must match exactly

For each, capture the EXACT on-screen string and compare to the ticket / design:

- [ ] **Page / section headings** — wording, casing, order.
- [ ] **Field labels** — every form field label; required fields show the required marker
      (e.g. red `*`) exactly where the ticket says.
- [ ] **Placeholders** — every input/textarea/select placeholder text (e.g.
      `"search by consent form template title"`). Wrong/missing placeholder = bug.
- [ ] **Button text** — every button, exactly (`"Assign (2)"`, `"Patient to Sign"`,
      `"Submit"`, `"Cancel"`). Watch dynamic counts in labels.
- [ ] **Links / tabs** — labels and order of tabs, breadcrumbs, menu items.
- [ ] **Dropdown / radio / checkbox option lists** — open each and list ALL options; verify
      the full set, the wording, and the order against the ticket.
- [ ] **Table / list column headers** — names and order.
- [ ] **Status / badge text** — e.g. `Pending`, `Signed`, `Expired`, `Witness Required`.
- [ ] **Tooltips / hints / helper text** — hover where applicable and read the tooltip.
- [ ] **Empty-state text** — the message shown when a list/table has no data.
- [ ] **Validation messages** — the exact inline error for each invalid input.
- [ ] **Toast / dialog messages** — success and error toasts; exact title + description.
- [ ] **Counts / summaries** — e.g. "2 consent forms selected", status counts (Total/Signed/
      Pending/Expired) — verify the number matches the actual list.
- [ ] **Spelling & grammar** — flag any typo, double space, wrong capitalization, stray
      punctuation, or placeholder/leftover text (`lorem`, `test`, `TODO`, `undefined`,
      `NaN`, `null`, raw enum codes like `Days90`).
- [ ] **Formats** — dates (`dd-MMM-yyyy` unless ticket says otherwise), times, currency,
      numbers, percentages, durations. The same field should use the same format everywhere.
- [ ] **Dynamic data** — placeholders like `{Patient Full Name}`, `{Clinic Address}` must be
      replaced with real values where the AC says they should be populated (and only there).

## B. Functional — behavior must work

> This section is the **happy-path + presence** checklist. For deep negative / boundary / state
> / implied coverage of each control, apply **`edge-cases.md`** — that catalogue is what turns
> "the button works" into "the button works *and* fails safely at every edge."

- [ ] **Primary action of the AC** does what the AC states and produces the stated outcome.
- [ ] **Buttons enable/disable** at the right time (e.g. Submit disabled until valid;
      "Assign (n)" disabled at 0 selection).
- [ ] **Conditional UI** appears/hides per the rule (e.g. a button hidden unless a condition
      holds; a field shown only for certain selections).
- [ ] **Search** filters live and matches the placeholder's promise; clearing restores.
- [ ] **Filters** (date range, dropdowns, status chips) actually filter; combined filters work;
      a Clear/Reset restores.
- [ ] **Sorting / ordering** matches the AC (e.g. "latest first", "Pending > Signed > Expired").
- [ ] **Pagination** — page numbers, next/prev/first/last, per-page selector; counts update.
- [ ] **Multi-select** — selecting/deselecting updates the counter and dependent buttons.
- [ ] **Navigation** — links/tabs go to the right place; back/close returns correctly.
- [ ] **Persistence / autosave** if the AC mentions it (value remains after reload/return).
- [ ] **Permissions / read-only** — fields locked when they should be (e.g. signed form is
      view-only).
- [ ] **No console errors** during the flow (capture them; see recipes). A red error during a
      core action is at least Medium severity.

## C. UI / Visual — layout & state (compare to design link when available)

- [ ] **Layout & alignment** — elements aligned, not overlapping, not clipped/cut off; columns
      line up; nothing overflows its container.
- [ ] **Spacing** — consistent padding/margins/gaps; no cramped or huge gaps vs the design.
- [ ] **Sizing** — element widths/heights reasonable; dialogs sized as designed; text not
      truncated unexpectedly (or truncated *with* an ellipsis where intended).
- [ ] **Colors** — text, backgrounds, borders, badge colors match the design (status colors:
      Pending/Signed/Expired each correct).
- [ ] **Typography** — font sizes/weights match the hierarchy in the design; headings vs body.
- [ ] **Icons** — correct icon, correct position, correct color/size; not missing/broken.
- [ ] **Images / logos / avatars** — load (no broken-image), correct aspect ratio.
- [ ] **States** — verify each that applies:
  - **default**, **hover**, **focus**, **active/pressed**
  - **disabled** (greyed, not clickable)
  - **loading** (spinner/skeleton shows, doesn't flash forever)
  - **empty** (empty-state UI)
  - **error** (red border + message)
  - **selected / checked** (highlight, checkmark)
- [ ] **Responsiveness** (only if the ticket/design specifies breakpoints) — resize and check
      it doesn't break; otherwise note "not required".
- [ ] **Scroll** — long content scrolls; sticky headers/footers behave; no double scrollbars.
- [ ] **Z-order / focus trap** — dialogs sit above content; Escape/overlay-click closes;
      focus goes to the dialog.

## D. Comparing implemented UI vs the design (Figma) link

If the ticket has a design/Figma link, do a side-by-side:
1. Open the design reference for the screen (the QC can paste a design screenshot, or you note
   the link in the report for the dev). Capture the implemented screen at a comparable size.
2. Walk **A → C** above against the design specifically: same labels/placeholders/buttons, same
   order, same colors, same spacing, same states.
3. Report visual differences as **UI** findings with both the expected (design) and actual
   (screenshot) — name both files. Use Low severity for cosmetic-only gaps unless the ticket
   calls the visual out explicitly (then Medium+).
> If you cannot actually open the design, do not invent a comparison — verify everything you
> *can* (content + behavior + internal consistency) and note in the report that pixel-level
> design comparison needs the design reference.

## E. Severity rubric (use in issues.md)

- **High** — blocks the AC: core action broken, wrong/missing required element, data wrong,
  crash/console error on the main flow, security/permission leak.
- **Medium** — AC works but a real defect: wrong label/placeholder/message, wrong format,
  wrong order, a state missing (no loading/empty/error), notable layout break.
- **Low** — cosmetic only: minor spacing/color/alignment drift, a tooltip nuance, polish.

## F. Status rubric (use in report.md)

- **✅ Pass** — behaves exactly as the AC states, content correct, no UI defect that violates
  the ticket.
- **❌ Fail** — violates the AC (wrong/missing behavior, wrong content the ticket specified, or
  a UI defect the ticket calls out).
- **⚠️ Partial** — mostly works but has a defect, OR a mutating final step was intentionally not
  run on shared data. Always say which.
- **⛔ Blocked** — could not test (page won't load, data/prerequisite missing).
