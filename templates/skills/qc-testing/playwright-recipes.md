# Playwright recipes — exact tool sequences

Copy these patterns. They are written so a weak model can follow them literally. Only the
**main agent** runs these; subagents never touch the browser.

These recipes match the **Playwright MCP tool schema** (`@playwright/mcp` 0.0.7x). Use exactly
these parameter names — a wrong name is a rejected tool call and a wasted turn:

| Tool | Parameters you may pass |
|------|-------------------------|
| `browser_navigate` | `url` |
| `browser_wait_for` | `text` \| `textGone` \| `time` (seconds) |
| `browser_snapshot` | `target`, `depth`, `filename` |
| `browser_click` | `target` (**required**), `element`, `doubleClick`, `button`, `modifiers` |
| `browser_type` | `target` (**required**), `text`, `element`, `submit`, `slowly` |
| `browser_select_option` | `target` (**required**), `values` (array), `element` |
| `browser_press_key` | `key` |
| `browser_evaluate` | `function`, `target`, `element`, `filename` |
| `browser_take_screenshot` | `filename`, `fullPage`, `target`, `element`, `type` |
| `browser_console_messages` | `level`, `all`, `filename` |
| `browser_find` | `text` \| `regex` — searches the a11y snapshot and returns just the matching nodes **with their refs** (much cheaper than a whole snapshot when you only need to locate one element; not present on older MCP builds — fall back to a scoped `browser_snapshot`) |

`target` is either an **exact ref from the last `browser_snapshot`** (e.g. `e169`) or a **unique
CSS selector** (e.g. `button[aria-label="Notifications"]`) — so an ambiguous click is solved with a
more precise selector, *not* by clicking through JS. There is **no** `selectors`, no
`snapshotOptions`, and no `expectation` parameter.

> ⛔ **`target` is never prose.** `{"target": "bell notification icon top nav"}` fails with
> *"does not match any elements"* and costs you a turn. The human-readable description belongs in
> the separate `element` field; `target` must be a ref or a selector. If you don't have one yet,
> take a `browser_snapshot` (scoped with `target`/`depth`) and use the ref it prints.

## Write evidence straight to disk with `filename` (do this — it is the biggest speed win)

`browser_evaluate`, `browser_snapshot` and `browser_console_messages` all accept `filename`.
With it, the result is written to a file and **never passes through the conversation**: one tool
call instead of "evaluate → read 9 KB of text → Write it to a file", and the context stays small
enough that the run doesn't slow down as it grows.

- A **relative** `filename` resolves against the **project root** (the folder the run was started
  in), so pass the path you actually want:
  `filename: "testing/test-result/<ticket-slug>/evidence/list.md"`. An absolute path inside the
  project works identically.
- **The folder must already exist** — these tools do *not* create parent directories, and a
  missing folder fails with `ENOENT`. Phase 3 creates `evidence/` and `screenshots/` up front for
  exactly this reason; if you invent a new subfolder later, `mkdir -p` it first.
- Only two roots are writable: the project root and `<project>/.playwright-mcp`. A path outside
  the project is refused ("outside allowed roots") — never try to park evidence in `/tmp`.
- **Fallback:** if a tool rejects `filename` (older MCP build), call it without `filename`, then
  `Write` the returned text to that same path yourself. Same evidence either way.

General rules:
- After a navigation or a click that changes the page, **wait for the thing you expect**
  (`browser_wait_for` with `text`), then read state. Prefer that over `time` — it is faster
  *and* it is the actual assertion.
- To read what's on screen: `browser_snapshot` when you need refs **to interact**, the R3
  content inventory when you need **evidence text**. Don't do both on every screen.
- If a click reports "strict mode violation: resolved to N elements", pass a **narrower
  selector** in `target` (see R6). Do not fall back to a JS `.click()` unless R6 fails.

---

## R1. Log in (once)

Credentials come from the project, never from you:

1. If `testing/environments.md` exists, use **exactly** the app URL + test account it lists for
   this environment. Otherwise follow the login section of the project `CLAUDE.md`.
2. If neither names a usable account, ask the QC **one** short question and stop guessing.

Generic sequence (adapt the field/button names to the app):

```
browser_navigate   → { url: "<login URL derived from the QC-provided URL>" }
browser_wait_for   → { text: "<a string on the login form, e.g. 'Log In'>" }
browser_snapshot   → (get refs for the form fields)
browser_type       → { target: "<ref/selector of the identifier field>", text: "<from environments.md>" }
browser_type       → { target: "<ref/selector of the secret field>",     text: "<from environments.md>", submit: true }
browser_wait_for   → { text: "<a string that only appears once logged in>" }
```

If the app uses an OTP / two-step flow, follow the exact steps the project doc describes
(e.g. choose the OTP tab → send → enter the code) — same tools, more steps. One login lasts the
whole run; never log in again per AC.

**Never** write credentials or an OTP into an evidence file, a screenshot caption, or the report.

## R2. Navigate to the page under test

```
browser_navigate → { url: "<the exact QC-provided URL>" }
browser_wait_for → { text: "<the target screen's heading>" }     // the assertion + the wait
```

Only fall back to `{ time: 3 }` when there is no reliable text to wait for. If the expected
heading never appears, that is a **finding** (screen didn't load / wrong route), not a reason to
wait longer.

## R3. Content inventory (THE key recipe — run on every screen/dialog)

Extracts all text so subagents can check labels/placeholders/buttons/options **without vision**.
Write it **straight into the evidence file**:

> ⛔ **Use this whole function — do NOT shortcut it to `() => document.body.innerText`.** A raw
> `innerText` dump loses the exact `placeholders`, the `disabledButtons`, the `errors` and the
> `redFlags` buckets, which is precisely what the Content layer is judged on; a subagent then
> can't tell "placeholder wrong" from "placeholder absent". Ad-hoc one-liner evaluates are fine
> for a quick *read while you work*, but every file in `evidence/` must be this shape.
> **Check what you wrote**: if the evidence file comes back a few bytes long (`[]`, `""`), the
> selector matched nothing — fix the selector and re-capture instead of leaving an empty file that
> later reads as "the screen had nothing".

`browser_evaluate` with
`filename: "testing/test-result/<ticket-slug>/evidence/<screen>.md"` and

```js
() => {
  const root = document.querySelector('[role=dialog]') || document.body;
  const txt = (el) => (el.textContent || '').trim().replace(/\s+/g, ' ');
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  return {
    headings: uniq([...root.querySelectorAll('h1,h2,h3,h4,[class*="title"],[class*="heading"]')].map(txt)).slice(0, 40),
    labels: uniq([...root.querySelectorAll('label,[class*="label"]')].map(txt)).slice(0, 60),
    placeholders: uniq([...root.querySelectorAll('input,textarea,[placeholder]')].map(e => e.getAttribute('placeholder'))).slice(0, 40),
    buttons: uniq([...root.querySelectorAll('button,[role=button]')].map(txt)).slice(0, 60),
    disabledButtons: uniq([...root.querySelectorAll('button[disabled],[aria-disabled="true"]')].map(txt)).slice(0, 30),
    tabs: uniq([...root.querySelectorAll('[role=tab]')].map(txt)),
    columnHeaders: uniq([...root.querySelectorAll('th,[role=columnheader]')].map(txt)),
    badges: uniq([...root.querySelectorAll('[class*="badge"],[class*="status"],[class*="chip"]')].map(txt)).slice(0, 40),
    options: uniq([...root.querySelectorAll('[role=option],option')].map(txt)).slice(0, 80),
    errors: uniq([...root.querySelectorAll('[role=alert],[class*="error"],[class*="invalid"],[aria-invalid="true"]')].map(txt)).slice(0, 30),
    // suspicious leftover/placeholder tokens that should never ship
    redFlags: uniq((root.innerText.match(/\b(undefined|null|NaN|Infinity|lorem|Lorem|TODO|FIXME|test123)\b|\{[^}\n]{1,40}\}|\[object [A-Za-z]+\]/g) || [])),
    fullText: (root.innerText || '').slice(0, 9000),  // PRIMARY source — see note below
  };
}
```

> ⚠️ **Important (learned in practice).** In a Tailwind / class-based app, the semantic buckets
> (`headings`, `labels`, `tabs`, `columnHeaders`, `badges`, `options`) often come back **empty**
> because the app uses no `<label>`, `<th>`, `[role=tab]`, or `*title*/*badge*` classes.
> **Do not treat an empty bucket as "missing UI".** The reliable sources are **`fullText`**
> (every visible label and value, in order), **`buttons`**, and **`placeholders`** — read
> labels/headings/status text out of `fullText`. Capture dropdown **`options`** with recipe
> **R7** (open the dropdown first; closed dropdowns have no options in the DOM). Keep `fullText`
> long enough to include the whole screen.

One file per screen **state** (`list.md`, `list-filtered.md`, `assign-dialog.md`,
`assign-dialog-error.md`). Reuse a file across ACs that share the same state instead of
re-capturing it — the Capture Plan says which state each scenario needs.

## R4. Read specific labeled values (counts, totals)

Read them out of the inventory's `fullText` when you can. When you need them as clean pairs, use
a scoped `browser_evaluate` (no `filename` — this is a small result you reason about now):

```js
() => {
  const want = ['Total', 'Signed', 'Pending', 'Expired'];   // adapt to the screen
  const out = {};
  const nodes = [...document.querySelectorAll('body *')].filter(e => !e.children.length);
  for (const label of want) {
    const el = nodes.find(e => e.textContent.trim() === label);
    out[label] = el ? (el.nextElementSibling?.textContent?.trim() ?? el.parentElement?.innerText?.replace(label, '').trim() ?? null) : null;
  }
  return out;
}
```

Compare each value against the actual list and the ticket. A summary count that disagrees with
the rows shown is a finding.

## R5. Screenshot straight into the ticket folder

```
browser_take_screenshot → { filename: "testing/test-result/<ticket-slug>/screenshots/ac1-list.png" }
```

That is **one** call — no `cp` afterwards. Rules:
- Default to the **viewport** shot. Use `fullPage: true` only when the finding needs the whole
  page (long lists) — full-page PNGs are the most expensive thing a subagent can read.
- For a dialog / one control, scope it: `{ target: "[role=dialog]", filename: "…png" }` — smaller,
  clearer, cheaper.
- Bug evidence is named `ISSUE-<area>.png` (e.g. `ISSUE-ac4-summary.png`).
- **Fallback** (only if `filename` with an absolute path is rejected): take the shot, then
  `Bash` `cp` the printed temp path into the folder — copy a whole screen's shots in **one**
  `cp` call, not one per file.

## R6. Click the right element when the selector is ambiguous

Narrow the `target`; that keeps Playwright's actionability checks (visible, enabled, not covered),
which is exactly what QC must not bypass:

```
browser_snapshot → { target: "[role=dialog]", depth: 6 }   // get the precise ref
browser_click    → { target: "<ref from the snapshot>", element: "Clinician to Sign button" }
```

Selector alternatives for `target`: `button:has-text("Clinician to Sign")`,
`[data-testid=...]`, `#id`, `table tbody tr:nth-child(2) button[aria-label="Actions"]`.

> ⚠️ Clicking via `browser_evaluate` (`el.click()`) **bypasses** the checks above: it "succeeds"
> on a button that is disabled, invisible, or covered by an overlay — turning a real bug into a
> false Pass. Use it **only** as a last resort after R6's selectors fail, and when you do, note
> in the evidence that the click was forced.

Either way, React re-renders **after** the click — read the result in a **separate**
`browser_evaluate` / `browser_snapshot` call, not the one that clicked.

## R7. Open a dropdown and capture its options

For a native `<select>`: `browser_select_option → { target: "<selector>", values: ["..."] }`.
For a custom dropdown:

```
browser_click    → { target: "<selector of the trigger>", element: "Category dropdown" }
browser_wait_for → { text: "<the first option you expect>" }
browser_evaluate → { function: "() => [...document.querySelectorAll('[role=option],[role=listbox] li,[class*=\"option\"]')].map(e => e.textContent.trim()).filter(Boolean).slice(0, 100)" }
browser_take_screenshot → { filename: "testing/test-result/<ticket-slug>/screenshots/ac4-dropdown.png", target: "[role=listbox]" }
```

List every option in the evidence file; verify the full set **and the order** against the ticket.

## R8. Type into a field / search

```
browser_click    → { target: "<selector of the input>" }
browser_type     → { target: "<selector of the input>", text: "..." }        // add submit: true to press Enter
browser_wait_for → { text: "<expected result text>" }                        // or textGone for the old row
browser_evaluate → re-read the list/result (R3/R4)
```

Use `slowly: true` only when the field needs per-keystroke handlers (masks, autocomplete that
ignores a bulk fill). For a debounce with no observable text change, `{ time: 1 }` is fine.

## R9. Close a dialog / popup

```
browser_press_key → { key: "Escape" }
browser_wait_for  → { textGone: "<the dialog's heading>" }
```

If a stray click reopened a dropdown, press Escape again and confirm with `textGone` before
continuing. Whether Escape (and an overlay click) really closes the dialog is itself an
edge-case row — record the result.

## R10. Capture console errors during a flow

There is **no** `expectation` parameter. Use the dedicated tool right after the flow you care
about:

```
browser_console_messages → { level: "error" }
```

- Add `all: true` to get everything since the session started (default is since the last
  navigation).
- Add `filename: "testing/test-result/<ticket-slug>/evidence/console-<screen>.md"` to park a long dump on disk instead of
  in context.

Record any error that fires during a core action as a finding (severity ≥ Medium on the main
path). Ignore known third-party noise, but say in the note that you did.

## R11. Read scoped state without giant snapshots

```
browser_snapshot → { target: "[role=dialog]", depth: 6 }
```

- `target` scopes the tree (a ref or a CSS selector), `depth` caps how deep it goes — use both to
  keep the output small.
- For a whole-page tree you only need on disk: `browser_snapshot → { filename: "testing/test-result/<ticket-slug>/evidence/<screen>.a11y.md" }`.
- If a scoped snapshot comes back empty, fall back to the R3 content inventory.
