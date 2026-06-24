# Playwright recipes — exact tool sequences

Copy these patterns. They are written so a weak model can follow them literally. Only the
**main agent** runs these; subagents never touch the browser.

General rules:
- After any navigation or click that changes the page, **wait**, then read state.
- To read what's on screen, prefer `browser_snapshot` (accessibility tree) and the
  content-inventory `browser_evaluate` below — they give you exact text.
- If a click says "strict mode violation: resolved to N elements", the selector is ambiguous —
  use the `browser_evaluate` click-by-text recipe to click the exact one.
- Save screenshots with a `filename`; then COPY them from the Playwright output folder into the
  ticket's `screenshots/` folder with `Bash` `cp` (the tool saves to a temp folder and prints
  the path).

---

## R1. Log in (once)

Follow the **"Local verification with Playwright"** section of the project `CLAUDE.md` for the
OTP tab, email, and OTP code. Sequence:

1. `browser_navigate` → the app login URL (derive the origin from the QC-provided URL).
2. `browser_wait_for` `{ time: 3 }` then `browser_snapshot` to see the login form.
3. Click the **OTP** tab → choose **By Email** → type the email → click **Send OTP**.
4. Type the OTP code → click **Log In**.
5. `browser_wait_for` `{ time: 2 }`; confirm the URL is no longer `/login`.

Never write the email/OTP into any saved file or screenshot.

## R2. Navigate to the page under test

```
browser_navigate  → <the exact QC-provided URL>
browser_wait_for  → { time: 4 }
browser_snapshot  → confirm the target screen rendered (look for its heading)
```

## R3. Content inventory (THE key recipe — run on every screen/dialog)

Run this to extract all text so subagents can check labels/placeholders/buttons/options
without needing vision. Save the result into `evidence/<screen>.md`.

`browser_evaluate` with:
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
    tabs: uniq([...root.querySelectorAll('[role=tab]')].map(txt)),
    columnHeaders: uniq([...root.querySelectorAll('th,[role=columnheader]')].map(txt)),
    badges: uniq([...root.querySelectorAll('[class*="badge"],[class*="status"],[class*="chip"]')].map(txt)).slice(0, 40),
    options: uniq([...root.querySelectorAll('[role=option],option')].map(txt)).slice(0, 80),
    // suspicious leftover/placeholder tokens that should never ship
    redFlags: uniq((root.innerText.match(/\b(undefined|null|NaN|lorem|Lorem|TODO|test123|Days\d+|\{[A-Za-z ]+\})\b/g) || [])),
    fullText: (root.innerText || '').slice(0, 9000),  // PRIMARY source — see note below
  };
}
```

> ⚠️ **Important (learned in practice).** In a Tailwind / class-based app like this one, the
> semantic buckets (`headings`, `labels`, `tabs`, `columnHeaders`, `badges`, `options`) often
> come back **empty** because the app uses no `<label>`, `<th>`, `[role=tab]`, or
> `*title*/*badge*` classes. **Do not treat empty buckets as "missing UI".** The reliable
> sources are **`fullText`** (every visible label and value, in order), **`buttons`**, and
> **`placeholders`** — read labels/headings/status text out of `fullText`. Capture dropdown
> **`options`** with recipe **R7** (open the dropdown first; closed dropdowns have no options
> in the DOM). Always keep `fullText` long enough to include the whole screen.

Write the returned object verbatim into `evidence/<screen>.md` under a heading naming the
screen/state. Repeat for each dialog and each important state (empty, filtered, error).

## R4. Status counts / specific value reads

To grab a labeled value (e.g. status counts), `browser_evaluate`:
```js
() => {
  const find = (label) => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === label);
    return el ? (el.nextElementSibling?.textContent?.trim() ?? null) : null;
  };
  return { Total: find('Total'), Signed: find('Signed'), Pending: find('Pending'), Expired: find('Expired') };
}
```
Adapt the labels to the screen. Compare each value to the actual list / the ticket.

## R5. Screenshot + persist into the ticket folder

```
browser_take_screenshot → { filename: "ac1-list.png" }            // viewport
browser_take_screenshot → { filename: "ac1-list.png", fullPage: true }  // whole page
```
Then `Bash`:
```
cp <printed-temp-path>/ac1-list.png testing/<ticket>/screenshots/
```
For a bug, name it `ISSUE-<area>.png` (e.g. `ISSUE-ac4-summary.png`).

## R6. Click an ambiguous element (by exact text)

When `browser_click` reports multiple matches, click the precise one with `browser_evaluate`:
```js
() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'Clinician to Sign');
  if (b) { b.click(); return 'clicked'; }
  return 'not found';
}
```
Note: React re-renders **after** the click — to read the result, make a **separate**
`browser_evaluate`/`browser_snapshot` call (don't read in the same call you clicked).

## R7. Open a dropdown and capture its options

```
// open it
browser_evaluate → click the trigger by its visible text (R6 pattern)
browser_wait_for → { time: 1 }
// read options
browser_evaluate → { return [...document.querySelectorAll('[role=option],li,[class*="option"]')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,100); }
browser_take_screenshot → { filename: "ac4-dropdown.png" }
```
List every option in the evidence file; verify the full set + order vs the ticket.

## R8. Type into a field / search

```
browser_click → the input
browser_type  → { text: "...", selectors: [the input] }
browser_wait_for → { time: 1 }   // debounce
browser_evaluate → re-read the list/result (R3/R4)
```

## R9. Close a dialog / popup

```
browser_press_key → { key: "Escape" }
```
If a stray click reopened a dropdown, press Escape again, then `browser_snapshot` to confirm
the dialog closed before continuing.

## R10. Capture console errors during a flow

Pass an expectation to surface console output, e.g. on a `browser_click` or `browser_navigate`:
```
expectation: { includeConsole: true, consoleOptions: { levels: ["error","warn"], maxMessages: 20 } }
```
Record any errors that fire during a core action as a finding (severity ≥ Medium if on the main
path).

## R11. Reading scoped state without giant snapshots

To keep output small, scope a snapshot to a dialog/section:
```
browser_snapshot → { snapshotOptions: { selector: "[role=dialog]", maxLength: 2500 } }
```
If a scoped snapshot returns empty, fall back to the R3 content-inventory `browser_evaluate`.
