<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## API Testing flows (run a collection, Postman-style)

`/api-testing` sends one request at a time; a real acceptance criterion is usually a **scenario**
("log in → create a claim → verify it's listed"). A **flow** is an ordered list of the project's
saved requests, run in sequence with each step's `captures` feeding the next step's `{{variables}}`.

- **Definition lives on the server, the RUN happens in the browser.** `routes/apiTests.ts` stores
  flows in `testing/api-tests/_flows.json` (`GET/PUT/DELETE /flows`, `POST /flows/:name/rename`) and
  reports under `testing/api-tests/_flow-runs/<flow>/` (`POST`/`GET /flows/:name/runs`, newest 20).
  `web/src/components/ApiFlowPanel.tsx` drives the run itself — one `POST /send` per step — because
  `/send` already resolves variables and masks secrets, and assertions are graded by
  **`web/src/lib/apiAssert.ts`**, the engine extracted out of `ApiTestingPage.tsx` so the builder and
  the runner **cannot** grade the same response differently. Don't add a second server-side
  assertion evaluator.
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
- **Never open a second Radix `Dialog` from inside the flow dialog without guarding it.** Radix
  portals the inner dialog OUTSIDE the outer `DialogContent`, so every click in it counts as an
  interaction *outside* the flow dialog: Radix dismisses the flow dialog, unmounting the unsaved
  `steps` draft. Verified — the original "Add steps" dialog closed both dialogs and added nothing.
  The step picker is therefore **inline** (`AddStepPicker`, appends on each click, no confirm
  button), and the accounts dialog — which genuinely has to be a dialog — is paired with
  `onPointerDownOutside` / `onInteractOutside` / `onEscapeKeyDown` guards on the flow's
  `DialogContent` (so Escape closes only the inner one, and normal dismissal still works when
  nothing is stacked).
  - Those guards must **NOT** test an `accountsOpen`-style boolean. Radix also decides
    "interacted outside" on TRAILING events — the focus-outside fired as the inner dialog unmounts —
    by which time the flag is already false, so the guard passes and BOTH dialogs close. Verified
    with a real pointer sequence on the inner dialog's Close button (a synthetic `.click()` does not
    reproduce it). Hence `guardedUntil` (a ref): armed while stacked and kept armed ~400 ms past the
    close. Re-test all four dismissals — Close, ✕, Escape, click-outside — plus "flow dialog still
    closes normally afterwards", when touching this.

