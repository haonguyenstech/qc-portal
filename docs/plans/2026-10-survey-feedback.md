# Plan — handling the SDC1 2026 QC Portal usage survey

Source: `SDC1 2026 - QC Portal Usage Survey` (18 QC, 20–30/09/2026). 14 have used the portal,
10 use it regularly. The pain is concentrated in **Run**; the "never used" features
(Responsive, Performance, E2E, API Testing) are a discovery/training gap, not a lack of need.

Status labels: `[TODO]` · `[DOING]` · `[DONE]` · `[NEEDS PEOPLE]` (not a code task) · `[DEFERRED]`

Priorities: **P0** now · **P1** next sprint · **P2/P3** later.

---

## A — Run reliability (P0) — hang.trinh, nhung.thai, phong.nguyen3

### A1. An expired AI account burns the whole queue — `[DONE]`
- Cause: a run is judged by exit code only; the `result` event's `is_error` is never read
  (`claude.ts`), and `startNextQueued` fires on every failure regardless of why
  (`runManager.ts`). Chat already stops its queue on this (`routes/chat.ts`).
- Do: classify a run's failure as `auth` / `limit` from `is_error` + stderr/result text
  ("Not logged in", "usage limit", "rate limit", 401…). On `auth`/`limit`: **pause the queue**
  (queued runs stay `queued`), show a banner, and let the user resume it.
- Done when: 5 queued runs + an expired account → 1 run fails, 4 stay queued, and resume
  continues them.

### A2. Re-run a failed run without rebuilding the form — `[DONE]`
- Cause: no rerun API; RunDetail just says "re-run". `resumeRun` rebuilds the body without
  `skill`/`model`/`instructions`/`deviceId`/`dataPolicy`.
- Do: persist the full create body, `POST /api/qc/runs/:id/rerun`, **Re-run** button on
  RunDetail + History; fix the `resumeRun` body.
- Done when: one click starts a new run with the same tickets/URL/device/options.

### A3. ~30 minutes before "blocked" — `[DONE]`
- Cause: no timeout of any kind on a QC run.
- Do: idle watchdog (no stream event for N min → warning event, 2N → stop as `stalled`);
  prompt rule "if the URL won't open or login fails, write a BLOCKED report and stop";
  RunDetail failure classifier learns `auth` / `limit` / `stalled`.
- Done when: a run against a dead URL ends in minutes with a clear reason.

### A4. Run is slower / more "blocked" than Chat — `[NEEDS PEOPLE]`
- Hypothesis: Run does not inject project context (memory/knowledge/overview) the way
  test-case generation does; it only tells the model to read `testing/environments.md`.
- Do: inject `readProjectContext` into the Run prompt; measure Run vs Chat on 3 real tickets
  (`[NEEDS PEOPLE]` for the measurement).
- Finding while implementing: the Run prompt ALREADY tells the model to read
  testing/memory, testing/knowledge and environments.md, so injecting them again only
  duplicates tokens — not done. What Chat had and Run lacked was addressed instead: an
  account to sign in with (B1), fail-fast on an unreachable target (A3), and the existing
  "Allow test-data creation" switch. Re-measure on 3 real tickets before changing more.

## B — Login credentials in a Run (P0) — chau.le

### B1. Test-account picker on the Run page — `[DONE]`
- Today the only way is the free-text "Instructions" box, stored verbatim (a secret in the DB).
- Do: a "Test account" picker in step 2 ("Where to run") fed by `testing/environments.md` and
  the TOTP labels; the prompt carries the LABEL only; a hint line on the form.

## C — Mobile (P1) — hang.trinh, nhung.thai, my.tran

### C1. One run at a time even on separate simulators — `[DONE]` (scoped, see note)
- Do: queue by resource — a web run holds `playwright-profile`, a mobile run holds
  `device:<id>`; runs that don't share a resource run in parallel. Picker hint: boot a second
  simulator to test by hand while the AI drives one.
- Done as: the picker marks the device a live run is driving ("in use by a run") and says
  to boot a second simulator and pick it — the actual complaint was "I can't use the device
  while the AI drives it", which a second device solves. Parallel execution was NOT done
  (`[DEFERRED]`): no one asked for throughput, and it breaks the "one at a time" promise the
  UI makes in several places.

### C2. Re-runs are not faster — `[DEFERRED]` (spike: replay a recorded Maestro flow)

## D — Playwright drops (P1) — my.tran

### D1. Health-check the QC browser before a run — `[NEEDS PEOPLE]`
- Do: await `ensureQcBrowser()` before spawning (it is fire-and-forget today) and record a
  clear error when it can't start. Mid-run reconnect is a spike — `[DEFERRED]`.
- Finding: `ensureQcBrowser` only runs for projects in attach mode, and
  docs/architecture/qc-browser.md records that NO project has it on (its UI was removed). So
  awaiting it would change nothing for anyone; the drops my.tran saw are Playwright MCP's
  own browser. Needs a repro first: Chat or Run? the exact error line? Meanwhile a dropped
  run is now diagnosed, stopped by the watchdog if it hangs (A3), and re-runnable (A2).

## E — API Testing (P1) — man.ho, thu.tra

### E1. Resizable collection sidebar + full-URL tooltip — `[DONE]`
### E2. Scanned requests get a `METHOD /path` name — `[DONE]`
### E3. Import OpenAPI/Swagger (JSON/YAML) and Postman v2.1 — `[DONE]`

## F — Responsive (P1) — thu.tra + 5 asking for a guide

### F1. Guide tour for `/responsive` (and `/performance`) — `[DONE]`
### F2. Reproduce "Responsive doesn't work" — `[NEEDS PEOPLE]` (ask thu.tra for URL + screenshot)

## G — Natural language in chat / test cases (P2) — my.tran, thu.tra

### G1. Writing-style rule in the test-case + chat prompts — `[DONE]`
### G2. Collect 2–3 bad/good examples — `[NEEDS PEOPLE]`

## H — Training & adoption (P0, no code) — `[NEEDS PEOPLE]`
- Demo: Responsive + Performance; demo: E2E flow + API Testing; one-page guide for login in
  Run / TOTP / Run as; 1-1 with the 4 non-users and the 2 who stopped; man.ho's project policy.

## I — New requests (P2/P3)

### I1. Terminal drawer reachable from any page — `[DEFERRED]`
### I2. "AI explain this failure" on RunDetail — `[DEFERRED]`
### I3. OWASP ZAP security scan — `[DEFERRED]` (spike)

---

## Measure
Re-run the same survey ~6 weeks after Sprint 2. Targets: regular users 10/18 → ≥ 13/18;
Run no longer named as hard to use; Responsive / Performance / API Testing ≥ 5 users each.

## Progress log

- **2026-10-05 — A1, A2, A3, B1 done.**
  - A1: `classifyRunFailure` (claude.ts) + queue hold / `resumeQueue` (runManager.ts),
    `GET /api/qc/queue`, `POST /api/qc/queue/resume`, Running page `QueueHoldBanner`,
    RunDetail `account` diagnosis. An empty queue is never held.
  - A2: `runs.requestJson` + `rerunRun` / `POST /api/qc/runs/:id/rerun`; **Re-run** on RunDetail and
    History (hidden for rows recorded before the column — `canRerun`). `resumeRun` now keeps
    `skill` / `deviceId`.
  - A3: idle watchdog `QC_RUN_IDLE_MINUTES` (default 20) + PRECONDITION CHECK prompt rule +
    RunDetail `stalled` diagnosis.
  - B1: `parseRunAccounts` (identities only, no password column) + `GET /api/accounts/run-options`
    + `RunAccountPicker` ("Sign in as") + `TEST ACCOUNT` prompt block.
  - Verified: `npm run typecheck`; `npm -w server test` 65/65 (new: runQueue, runStall,
    runAccounts); an isolated server with a fake CLI (hold → banner → Resume queue drains →
    Re-run carries the account) driven in Edge; real accounts sheets parse correctly.
  - Docs: docs/architecture/runs.md (4 new sections), CLAUDE.md env table.

- **2026-10-05 — E1, E2, E3 done; D1 moved to NEEDS PEOPLE.**
  - E1: resizable Collection rail (220–560px, remembered) + URLs wrap to two lines.
    Verified by dragging it in Edge at 1366px: 248 → 398px, persisted.
  - E2: already existed (`deriveName`). While there: Scan import's ` (2)` suffix was rejected
    by the server and silently dropped → now `uniqueName`.
  - E3: `lib/apiSpecImport.ts` + `ApiSpecImportDialog` ("Import OpenAPI / Postman"); new dep
    `yaml` (lazy chunk). Verified on OpenAPI 3 YAML / Swagger 2 / Postman fixtures (recursive
    $ref, path params, urlencoded, form-data warning, bad input) and end to end in Edge on an
    isolated server: upload → preview → untick one → 3 saved under the `pets` module.
  - Docs: docs/architecture/api-testing.md.

- **2026-10-05 — F1, G1, C1 done.**
  - F1: route tours for `/responsive` (6 steps) and `/performance` (6 steps, switches tabs via
    mousedown — Radix ignores `.click()`), plus `data-tour` anchors. The `/api-testing` tour
    now mentions OpenAPI/Postman import and the resizable rail. Walked both in Edge: every
    step resolves, the tab switches at the right step.
  - G1: chat `STYLE_BLOCK` (answer first, no preamble/recap, native phrasing in the
    engineer's own language, length follows the question; an action's format wins) and one
    "native phrasing, not a translation" line in the test-case style block. The language
    itself is NOT changed. Needs G2's real examples to judge.
  - C1: `busyDevices` on `GET /api/qc/queue` + "in use by a run" on the device picker + the
    "boot a second simulator" hint. Unit-tested; NOT seen in the browser (needs a booted
    device + a real Maestro probe).
  - Verified: typecheck both workspaces; server tests all pass.

## Follow-up feedback (2026-10-05): "Update now wiped my local patches"

A teammate's install had local patches (ClickUp: unassigned bugs, evidence in the description;
Playwright: 1920x1080 headless viewport). `qc-portal --update` hard-resets tracked files, so
both were lost. Handled:

- `[DONE]` **Update keeps a copy before it resets** — `backupLocalEdits()` in
  `bin/qc-portal.mjs` → `data/update-backups/<time>-<sha>.patch` (restore with
  `git apply --3way`), stops the update if it can't save; the path is in
  `update-status.json` and shown in a persistent toast. Verified in a throwaway clone.
- `[DONE]` **Bug: a project saved headless got the HEADED Playwright config** at boot
  (`applyPlaywrightWindowConfig`) → its runs rendered at ~800x600. Now the headless file.
  Test fails on the old code, passes on the new.
- `[DONE]` **Headless viewport 1440x900 → 1920x1080** (user's call).
- `[DONE]` **ClickUp filing preferences per project** (user's call: settings, defaults
  unchanged) — `clickupInheritAssignees`, `clickupEvidence`; UI under Templates → ClickUp
  issue template. Route test against faked ClickUp/imgbb; toggle verified in Edge.
- Caveat for that teammate: the update that BRINGS the backup runs the launcher already on
  their disk (the old one), so their next update still resets without a copy. They should
  save `git diff > ~/qc-portal-local.patch` once before updating — after it, the two
  settings replace their ClickUp patch and the viewport is already 1920x1080.

## Real-model verification (2026-10-05, isolated server + real `claude`, haiku)

- **A3 PRECONDITION CHECK — PASS.** A run against a dead URL (127.0.0.1:59999) ended in
  **76 s** (field report: ~30 min), going Phase 3 → Phase 7 with a Blocked report naming the
  exact reason ("port 59999 not listening"); no waves, no evidence capture, no subagents.
- **Headless viewport — PASS.** A real headless Playwright MCP with the boot-repaired config
  measured `{"w": 1920, "h": 1080}`; also confirmed the boot repair wires a `--headless`
  project to the headless config file.
- **G1 chat style — PARTIAL → tightened.** First pass: answers were short, sourced and in the
  asker's language, but each opened with pre-tool narration ("Tôi cần tìm… Hãy để tôi khám
  phá." — the literal-translation tone the survey complained about). Added a rule against
  announcing tool use. Re-test: 2 of 3 clean (both Vietnamese), the English one still had one
  "I'll search…" line. A prompt can't guarantee this on haiku.
- **Not verified with a model:** B1's TEST ACCOUNT block (needs a real app with a login),
  C1's busy-device line (needs a booted device), the post-update backup toast (needs a real
  update from the UI), real ClickUp filing (needs a workspace).
