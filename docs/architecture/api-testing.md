<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## `/api-testing` page layout (collection → request → result)

The page is a three-pane workspace, not a vertical stack, and `/api-testing` is in
`App.tsx`'s `max-w-none` list (with `/prototype`, `/chat`, `/notes`) because the capped
`max-w-6xl` left no room for the third pane.

- **Two page-level tabs, and the tab is in the URL.** `Requests` (the three panes below) and
  `Flows` (its own two-pane workspace, see the flows section) are switched by `?tab=flows`
  via `useSearchParams` — the same `?tab=` idiom `/settings` uses — so a scenario is
  linkable and survives a reload. `PageTab` draws the pill rail; `Requests` is the default
  because a flow's steps are picked from the saved requests. The requests workspace is
  **hidden, not unmounted**, on the Flows tab, so switching back keeps the response, the AI
  verdict and the draft you were reading. The header's Scan / Import cURL / Copy as cURL
  buttons render only on the Requests tab (they have no meaning for a flow); Open folder
  stays on both.
- **"New request" writes the record immediately — it does not wait for a Send.** It used to
  only reset the draft, so the collection stayed empty until a URL had been typed AND sent: the
  button looked inert, there was no row to name / move into a module / come back to, and a
  half-built request was lost on the next click. `newRequest` PUTs a blank definition (the server
  accepts an empty URL), selects it — which is what arms the auto-save effect, so every keystroke
  after that is persisted — and focuses the URL bar. Its name is the placeholder `New request`
  (`New request (2)`, …); the **first Send upgrades it** to the derived `METHOD /path` via
  `POST /:name/rename`, awaited before the send so the stored result and run history land under
  the final name. A row with no URL yet prints an italic *no URL yet* instead of a blank line.
  - `handleSend` therefore checks **`selected` FIRST**, before its method+URL duplicate lookup.
    `saved` (the query cache) can lag the draft by one auto-save debounce, and treating that lag
    as "not saved yet" created a SECOND record for the request already open on screen.
  - The new row is **pinned to the top of the list** (`pinnedFirst`) — it would otherwise be filed
    alphabetically into the middle of a long collection at birth. The pin follows the first-Send
    rename (so the row doesn't jump under the cursor) and is released the moment another request is
    opened; it lifts the request to the top of its module *and* its module to the top of the list.
  - Both naming paths go through one `uniqueName(base, taken)` helper, and its dedupe suffix is
    ` 2`, **not** ` (2)`: a request name becomes a file name and must match the server's
    `NAME_RE = /^[\w .-]{1,60}$/`, which has no parenthesis. The old create-on-send path built
    `base (2)` and swallowed the `invalid request name` error, so saving a SECOND request to an
    endpoint already in the collection silently wrote nothing. Verified before/after.
- **The collection search box is always mounted** once anything is saved — it used to appear
  only past four requests, which meant nobody knew it existed until they already had too many
  to scroll. Terms are ANDed and each is matched against name, method, URL *and* module name
  (`"post login"` finds `POST /auth/login`; `"auth"` matches the folder as well as the path),
  the count reads `n of m match` so an empty list reads as a search result rather than a bug,
  Escape clears then blurs, and `Auto-group … by path` is hidden while a search is active
  because it acts on the whole collection, not the filtered list.

- **The panes are numbered, and the numbers are the mental model:** `1 Request` (method +
  URL + Send + the environment the `{{variables}}` resolve against), `2 Configure & assert`
  (Params / Headers / Body / Assertions / Capture / AI check), `3 Result`. `StepChip` draws
  the numbers; keep them in sync with the copy that references them ("Configure → AI check",
  "Result → Checks") — those pointers are what makes the split navigable instead of hidden.
- **Three columns only from `2xl` (1536px).** Between `lg` and `2xl` the result pane spans
  the full width *under* the builder. Verified at 1280px: with the result pane beside the
  builder, the URL input collapses to a sliver and both tab rows wrap to three lines. The
  rail keeps its own column from `lg` down to 1024px.
- **The result pane answers three questions, and its tiles are also its navigation.**
  `VerdictTile` shows Checks `passed/total`, QC-scan Issues, and the AI verdict; clicking one
  selects the tab that explains it (`resultTab`). Response / Checks / Issues / AI / Runs are
  tabs rather than a stack — the old page put the body, the scan and the history one under
  the other, so "did it pass?" was several scrolls below the Send button.
- **Status is printed once.** The pill beside the `3 Result` heading is hidden on the
  Response tab, where `ResponseView` prints the richer strip (status, time, size,
  content-type) two rows down; the same `200 · 6 ms` twice reads as a rendering bug.
- **The AI expectation is authored in pane 2 and read in pane 3.** `AiCheckView` renders only
  in the result pane's AI tab — rendering it in both places (the old layout did) meant the
  same verdict appeared twice on screen after every send.
- **`HistoryPanel` draws no card and no heading of its own** — it lives inside the Runs tab.
  Its rows are two lines (verdict, then URL) because a one-line row in a ~360px column
  truncated the URL to `http://loc…`.
- **`RouteGuideTour` anchors on this page by selector:** `[data-tour="header"]`, `import`,
  `page-tabs`, `request`, `config`, `tab-assert`, `tab-capture`, `response`, `tab-flows` — and it
  *clicks* the tab anchors, including `tab-requests` (so a tour started from the Flows tab still
  finds the builder) and `tab-flows` on the last step. Moving a block means moving its `data-tour`
  with it; re-walk all 9 steps after restructuring.

## API Testing flows (run a collection, Postman-style)

`/api-testing` sends one request at a time; a real acceptance criterion is usually a **scenario**
("log in → create a claim → verify it's listed"). A **flow** is an ordered list of the project's
saved requests, run in sequence with each step's `captures` feeding the next step's `{{variables}}`.

- **Flows is a TAB of the page, not a dialog.** `ApiFlowsWorkspace` (rail of flows + `Test
  accounts`) and `ApiFlowEditor` (the picked flow) render inline under `?tab=flows`. It used to be
  a small card in the requests sidebar that opened the editor in a modal, and every complaint
  about it came from that: a step row carries method, name, URL, live verdict, the "soft" toggle
  and four buttons; a run takes as long as the API does; and the modal both cramped that and hid
  the saved requests the steps are picked from. On the page it also numbers its panes the way the
  request builder does — `1 Scenario` (name, what it covers, stop-on-fail, Save/Run/Delete),
  `2 Steps`, `3 Result` (this run + previous runs) — via `FlowChip`, with Run and Save pinned
  beside the name instead of in a footer a long steps list scrolled away from.
- **Every stored run OPENS to its per-step report** (`PastRunRow`). The `GET /flows/:name/runs`
  response already carries each step's method, URL, status, check counts, timing, `detail` and
  captured variable names, so expanding costs no fetch — and a bare "0/2 passed" from three days
  ago is unusable evidence when you can't see WHICH step failed and with what. The expansion
  header also shows `totalMs`, the account it ran as and the env, because that's what makes two
  runs of one flow differ. The list shows five with a "Show all *n*" toggle (the server keeps the
  newest 20).
- **`ApiFlowEditor` is mounted with `key={flow.name}`** and seeds its draft from the flow ONCE, so
  there is no stale-props effect. The consequence is that a **rename remounts it**: the rename
  mutation therefore writes the current draft under the NEW name inside the same `mutationFn`,
  before the refetch can swap the component out. Verified: without that, renaming a flow with two
  fresh steps came back with none. Delete goes through a confirm dialog — a flow is a file and its
  run reports go with it.

- **Definition lives on the server, the RUN happens in the browser.** `routes/apiTests.ts` stores
  flows in `testing/api-tests/_flows.json` (`GET/PUT/DELETE /flows`, `POST /flows/:name/rename`) and
  reports under `testing/api-tests/_flow-runs/<flow>/` (`POST`/`GET /flows/:name/runs`, newest 20).
  `web/src/components/ApiFlowPanel.tsx` drives the run itself — one `POST /send` per step — because
  `/send` already resolves variables and masks secrets, and assertions are graded by
  **`web/src/lib/apiAssert.ts`**, the engine extracted out of `ApiTestingPage.tsx` so the builder and
  the runner **cannot** grade the same response differently. Don't add a second server-side
  assertion evaluator.
- **`AddStepPicker` can also CREATE the request it adds: "Import cURL".** The picker could
  only offer what the collection already had, so building a scenario from a browser's "Copy as
  cURL" meant leaving the flow, switching to the Requests tab, importing, sending it once to get
  it saved, and coming back — with the half-built flow's unsaved steps at risk the whole way. The
  import now PUTs the parsed request under `uniqueName(deriveName(draft), …)` and **awaits the
  `['api-requests']` invalidation before calling `onPick`**, because a step whose request isn't in
  the list yet renders as `missing`. The dialog itself is shared: `components/CurlImportDialog.tsx`
  + `lib/apiDraft.ts` (`ApiDraft`, `emptyDraft`, `deriveName`, `uniqueName`) were extracted out of
  `ApiTestingPage.tsx` for it — importing the page from `ApiFlowPanel.tsx` would have been an
  import cycle, and a second copy of the naming rules is how the two sides drift apart.
- **Steps reference a saved request by NAME, never a copy** — editing the request updates every flow,
  and `POST /:name/rename` rewrites the matching `requestName` in every flow (otherwise a rename
  silently empties a step). A deleted request leaves the step in place, flagged `missing`, and fails
  its step rather than being skipped in silence.
- **Verdict rules:** a step passes when all its enabled assertions pass, or — with no assertions —
  on a 2xx. `stopOnFail` (per flow) marks every later step `skipped`; a per-step `continueOnFail`
  ("soft") overrides it. Captures are applied even for a failing step (a 4xx can still carry an id
  the next step needs). The stored report holds **verdicts only** (status, timing, check counts,
  captured variable names) — never response bodies, so a token in a login response can't reach the
  project repo through it.
- **The "Run as" card answers "who is this running as?" on its header line.** `FlowAuthPicker`
  puts the resolved identity there as a status pill (green + the username, amber-neutral "no
  account", red "account missing"/"2FA missing") with `Manage accounts` beside it, because the
  selects alone don't say whether the pick still resolves. Three shape rules learned on screen:
  the two pickers are capped (`sm:max-w-2xl`) — spanning the full pane left half a screen of dead
  space between an account and its authenticator; the placeholder tokens are **chips, not prose**
  (the old five-line paragraph buried `{{auth.username}}` / `{{auth.password}}` / `{{auth.otp}}`
  in four inline code spans, and every `code` carries `whitespace-nowrap` so
  `{{account.<label>.username}}` can't break across lines mid-token); and a **missing label is
  re-added to the Select as a disabled `… — deleted` item**, because Radix renders an EMPTY
  trigger for a value with no matching item — which hides *which* account vanished.
- **Authentication — the flow PICKS an identity ("Run as").** `flow.auth` holds only two LABELS
  (`accountLabel` from `apiAccounts.ts`, `totpLabel` from `totp.ts` — the **same authenticators the
  Instructions → Accounts page registers**, which is why `FlowAuthPicker` links there instead of
  duplicating that editor). The runner passes them with **every** step's send, and `resolveSendVars`
  turns them into `{{auth.username}}` / `{{auth.password}}` / `{{auth.otp}}` — so ONE login request
  runs as any account and re-testing as a different role is a dropdown, not a request edit. A
  specific account stays addressable as `{{account.<label>.username}}`. The report records which
  account ran (`account` in the run record); `_flows.json` is versioned with the project, so only
  labels may ever go in it.
  - The OTP is computed **per send** (function of the clock — never cache it), and it + the password
    are marked `secret`, which keeps them out of the echoed request and the stored history. The
    active environment wins on a key collision, so a hand-defined `otp.*` for a fixed-OTP
    environment still works.
  - **The store is separate from `testing/environments.md`, so it starts empty** — and an empty
    picker reading "No account" while the engineer is looking at their account on Instructions →
    Accounts is the confusing part. `GET /accounts/candidates` parses that sheet's markdown table
    (columns matched by HEADER NAME, never position; a row with no username is skipped) and offers
    the rows for one-click **import**; `POST /accounts/import` re-reads the sheet server-side so a
    password never makes the round trip to the browser. Rows already imported are filtered out by
    username. Both pickers also carry an explicit empty-state line instead of a bare "No account".
  - The runner **refuses to start** when a step references `{{auth.username|password}}` / `{{auth.otp}}`
    and nothing is picked. Verified: unresolved tokens are sent literally, the API answers 401, and
    that reads as "wrong password" rather than "you didn't pick an account" — a wasted debugging trip
    the pre-run check removes.
- `_flows`, `_flow-runs`, `accounts` and `flows` are in `RESERVED_NAMES`, and `_flows.json` is
  excluded from the saved-request listing — otherwise a flow file shows up as a broken "request".
- **`DialogContent` is a GRID, so its children carry `[&>*]:min-w-0`** (set once in
  `components/ui/dialog.tsx`). A grid item keeps `min-width:auto`, so one unbreakable string —
  a 97-char endpoint URL in the scan dialog's list — grows the auto track past `sm:max-w-*`:
  the panel still paints at its max width while every row, and the footer buttons with it,
  lays out wider and spills off the right edge (measured: 109 overflowing nodes, 176px past
  the panel). `truncate` inside the row never fires because the row itself was never
  constrained. Don't remove it, and don't "fix" a wide dialog by widening `max-w` instead.
- **The flow editor is on the page, which is what retired the nested-dialog guards.** History,
  because the trap is real and still live elsewhere (`NotesPage.tsx` carries the same
  `guardedUntil` ref): Radix portals an inner dialog OUTSIDE the outer `DialogContent`, so every
  click in it counts as an interaction *outside* the outer one — Radix dismissed the flow dialog
  and unmounted the unsaved `steps` draft. The original "Add steps" dialog closed both dialogs and
  added nothing. A boolean flag was not enough either: Radix also decides "interacted outside" on
  TRAILING events (the focus-outside fired as the inner dialog unmounts), by which time the flag
  is already false. Hence the old `guardedUntil` ref, armed ~400 ms past the inner close, and
  hence the step picker being **inline** (`AddStepPicker`, appends on each click, no confirm
  button) — which it still is. If you ever put the editor back in a dialog, all of that comes
  back with it. The accounts dialog is now opened from the page, so nothing is stacked.

