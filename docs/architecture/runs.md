<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## E2E flow (advanced) run — the workflow canvas

`/qc-run`'s second mode is a **node workflow**, ported from shadcnuikit's "Workflow Automation"
page: a searchable **node library** (left) beside a pannable **canvas** of connected step cards,
with the selected step's **inspector as a full-width strip underneath** (it was a third column —
the canvas is what needs the pixels, and the step's fields lay out fine side by side). It replaced
the old advanced UI (a second ticket picker + a list of text inputs), which was shipped disabled
behind `ADVANCED_ENABLED`.

- **The canvas is a real graph — `@xyflow/react` (React Flow).** A card is dragged anywhere, every
  card has a handle on **all four sides**, and a line pulled between two of them re-routes itself;
  a step may fan out to several, so a flow can branch. `ConnectionMode.Loose` is what makes a side
  work as both source and target — stacking a source and a target handle per side instead would
  make which one you grabbed a coin toss. **A line is removed by the `×` at its midpoint** (custom
  `StepEdge`, shown while the edge is hovered or selected) — and Delete/Backspace work only because
  `handleEdgesChange` now keeps the `select` change: in a controlled graph React Flow reads
  `selected` off the edge object we hand it, so ignoring those changes left every edge permanently
  unselected and the key with nothing to delete. `onEdgeClick` also clears the node selection,
  since otherwise Delete took the selected card along with the line (verified). Library rows are
  draggable onto the canvas (drop position
  via `screenToFlowPosition`) **and** still clickable, which appends + wires the step after the last
  one for the quick straight-chain path.
- **RunPage stays the single source of truth** (`wfNodes` + `wfEdges`); the React Flow shapes are
  derived every render and changes are applied back up — no `useNodesState` copy. Two things make
  that work and must not be dropped: `measured` is read back off `getInternalNode(id)` when
  rebuilding (a controlled graph re-renders per pointer move, and a node arriving unmeasured logs
  "trying to drag a node that is not initialized" on every move and stutters), and edges are painted
  with an inline `style.stroke` from the token because React Flow's own `.react-flow__edge-path`
  rule out-specifies a Tailwind class, leaving the line near-invisible. `Controls` gets the same
  treatment — its hard-coded near-white button fills stay light-on-light in dark mode.
- **A free canvas has no inherent order, so run order is DERIVED** by `orderedNodes(nodes, edges)`:
  start at the entry node (no incoming edge), walk depth-first, children in reading order (top to
  bottom, then left to right) — that's the order the picture reads in. Nodes no edge reaches are
  appended rather than dropped: an unconnected card is a step someone typed, and skipping it would
  run a flow that isn't the one on screen. A fully cyclic graph falls back to the topmost card so
  the walk still covers it. The step **number on each card** is that order, not creation order.
  A saved **template** stores the flattened lines, so `graphFromPreset` rebuilds a plain top-to-
  bottom chain — run order survives, branch shape doesn't.

- **A run RECORDS which kind it was** — `runs.runKind` (`RunKind = 'ticket' | 'flow'`, migration in
  `db.ts`), sent explicitly by the client as `kind` on `POST /api/qc/run` rather than inferred from
  the presence of `workflowSteps`. Two things depend on it: `claude.ts` stops telling the model
  `ClickUp ticket: <slug>` for a flow (observed: four wasted tool calls hunting `testing/tickets/`
  for a folder that cannot exist) and says there is no ticket, the steps ARE the acceptance
  criteria — the resume prompt too; and `RunKindTag` (`components/` + `lib/runKind.ts`, mirroring
  `TargetTag`/`lib/testTarget.ts`) badges every run on **Running**, **History** and the run detail
  header, because both kinds render a mono id and a flow's is only its name slugged. History also
  derives a group's kind from its runs — a flow group gets the Workflow mark, **no ClickUp link**,
  and is counted as a *flow*, not a ticket. Rows predating the column read as `'ticket'`, which is
  right for them (every advanced run before this carried real tickets).
- **An E2E flow has NO ticket.** It's a path through the product ("sign in → create a claim →
  verify it's listed"), not an acceptance check against one ticket, so the canvas holds **steps
  only** and nothing on the page mentions tickets. The run still needs a name to file its report
  under: the canvas's **flow name** is slugged by `flowSlug()` (`web/src/lib/run-workflow.ts`) and
  sent as `ticketId`. The server is unchanged — `POST /api/qc/run` has always required a non-empty
  `ticketId` and uses it as the report slug (`resolveSlug`).
- **The App URL is a per-STEP setting, not a form field.** A flow walks several pages, so
  `WorkflowNode.url` lives in the inspector beside "What Claude does" and step 2 ("Where to run")
  shows only a pointer back to the canvas — there is no App URL input on the form in this mode.
  The run record still takes exactly one URL: **`flowEntryUrl(nodes)`**, the first step that names
  one, which is where the run opens (flagged `Start` on that card and in the canvas's "Starts at"
  strip). Later steps' URLs ride into the prompt through `stepText` as `— URL: …`, so the model
  navigates there itself. Submit is gated on the entry URL existing and on `invalidStepUrls(nodes)`
  being empty, replacing the shared field's validity check. `urls={!isAppTarget}` hides all of it
  for the app-on-device target, which launches an installed app instead of an address.
- **It changes the EDITOR, not the run.** `run-workflow.ts` holds the graph model and the pure
  flatteners: `workflowStepLines(nodes, edges)` → the ordered `workflowSteps` strings (`stepText`
  renders a node as `title — URL: … — expected: …`), and `graphFromPreset(steps)` rebuilds a canvas
  from a saved **template** — its line parsing is the exact inverse of `stepText` (it splits the URL
  and expected segments back out), so saving a flow as a template and reloading it doesn't glue them
  into the title. Keep the two in step. The run contract is lines only, so a template (`lib/presets.ts`,
  `RunPreset`) additionally stores `flowName` — it is the run's **report slug**, and without it every
  loaded flow filed under the default — and `workflowKinds`, each step's kind positionally, or a
  loaded flow came back as N identical "Custom step" cards. Both are optional: older templates fall
  back to the default name and `custom`. `workflowStepEntries` yields the line **and** the kind from
  one filtered walk, so the two arrays can't drift when a titleless card is dropped.
- **RunPage holds ONE piece of state for it** (`wfNodes`, plus `flowName`); `cleanSteps` is derived
  every render. Don't mirror it into state — a second copy is how the canvas and the submitted run
  drift apart. `saveLastInputs` deliberately keeps the previous **real** ticket id **and App URL**
  in advanced mode: a flow slug there would seed single-ticket mode with a ticket that doesn't
  exist, and a step's URL isn't the shared field's value.
- **The right rail (Run readiness + Recent runs) is hidden in this mode and the page goes
  edge to edge** (`max-w-none` + negative margins clawing back AppShell's route gutter, a tighter
  `CardContent` padding, single-column grid). The rail reads a ticket and its test cases, so it has
  nothing to say about a flow — and the canvas is the page here, so it gets every pixel.
- The panes use **container queries** (`@container` + `@2xl:` / `@5xl:`), not viewport ones: the
  builder sits inside the run form's column, where a wide window says nothing about how much room
  it actually has. With viewport breakpoints the canvas collapsed to ~250px on a 1440px screen.
- Icon chips carry their own text colour in the `tone` string (`bg-foreground text-background`,
  `bg-sky-500 text-white`, …). A blanket `text-white` on the chip made the neutral marks invisible
  in dark mode — verified on screen.
- The step library (`STEP_LIBRARY`: Navigate / Sign in / Fill & submit / Verify / Check data /
  Custom) only seeds wording and an icon; every step is free text, so adding a kind costs one entry.

## Filing a run's issues to ClickUp (Run detail → Issues)

`IssueClickupPanel` (RunDetailPage) turns the run's `issues.md` into ClickUp **subtasks** under a
parent ticket, via `POST /api/clickup/issues/subtasks` → `createIssueSubtask`. Every field is filled
in for the engineer, and the parts that are easy to get wrong:

- **Priority comes from the ISSUE's severity, not the parent's priority.** Inheriting the parent's
  was the original behavior and it produced bugs with **no priority at all**, because a feature
  ticket usually has none — verified on a real ticket (`86eut664j`: one assignee, no tags,
  `priority: null`). `severityPriority()` maps the skill's severity word to ClickUp's 1-4
  (blocker/critical→Urgent … low/minor/trivial→Low); the parent's priority is the **fallback** for an
  issue with no severity recorded. A Low bug under an Urgent ticket must not be filed Urgent.
- **Severity is parsed ONCE, in `parseIssues`** (`ParsedIssue.severity`), because the card's badge
  and the filed priority have to be the same value. The client's `priorityFromSeverity` mirrors the
  server map for display only — keep the two in step.
- **The parent is fetched once per BATCH** (`getIssueFilingContext`), not once per issue. It also
  backs `GET /api/clickup/issues/filing-context`, which the panel shows **before** filing:
  assignee(s), the priority each selected issue will get, tags, and the screenshot count. An
  automation you can only check by opening ClickUp afterwards is one nobody trusts — and a parent
  with **no assignee** has to say so up front, or it silently produces unassigned bugs.
- **Screenshots are attached AND posted as an inline comment** (`attachTaskFile` → `postTaskComment`
  with `![](presigned url)`), so the evidence is in the discussion thread, not only the attachments
  panel. Both are best-effort and never fail the subtask — but a screenshot that couldn't be resolved
  or uploaded is **counted** (`applied.screenshotsFailed`) and reported, instead of vanishing.
- **`applied` reports what ClickUp actually stored** (it echoes the created task's own
  `assignees`/`priority`), because a user who isn't a member of the list is silently dropped on
  create. The panel must not claim a bug was assigned when it wasn't.
- `request()` in `lib/api.ts` throws the **raw response body**, so a ClickUp failure arrives as
  `{"error":"ClickUp API 404: {…}"}`. `errorSentence()` unwraps both layers for this panel — don't
  print the envelope at the engineer.

## One run, one output folder (`runs.outDirToken`)

A QC run's results live in `testing/test-result/<folder>/`, and the folder used to be named by the
**model** — the `qc-testing` skill says `<ticket-id>-<slug>`. Same ticket in, same wording out: a
second run of that ticket picked the **same folder** and its `report.md`, `issues.md`,
`testcases-executed.<ext>` and `screenshots/` **overwrote the first run's**. Reported from the field
as "run the ticket on web, then on a device, and the web result is gone", and visible in this repo's
own history — ticket `86eut664j` had 22 runs sharing 5 folder names, three of them filed under
`86eut664j-notifications-v14`, all reading one report.

So the **portal owns the tail of the folder name**:

    testing/test-result/<ticket-id>-<short-feature-slug>-<target>-<token>/
    e.g. 86eut664j-notifications-web-3f9a12c4   (target: web | mobile-web | mobile-app)

- **`runs.outDirToken`** (migration in `db.ts`) is 8 hex chars off the run's uuid, assigned in
  `startRun` **before** the child spawns, since it goes into the prompt. `outDirSuffix(token,
  target)` builds the `<target>-<token>` tail from the **stored** token — never re-derived, so the
  prompt and the resolver cannot disagree. It's immutable: deliberately absent from `updateRun`'s
  allowed keys.
- **`claude.ts` states the whole folder name** (it knows `ticketId`), leaves `<short-feature-slug>`
  to the model, and says the tail is mandatory **and overrides the skill's own examples** — the
  skill still documents the old shape, and a prompt that merely *asks* loses to a skill that
  *specifies*. The resume prompt repeats it as "keep writing into the folder ending in …", so a
  resumed run doesn't split its evidence across two folders.
- **Resolution is by token, and that is the half that actually fixes History.** `resolveRunOutDir`
  finds the run's own folder and **only** that one. The old `resolveSlug` matched folders by **ticket
  prefix** and picked the newest with a `report.md`, and `onDone` called it with **no `preferred`** —
  so a finishing run could adopt a folder an earlier run wrote, and `healRunCounts` (`routes/qc.ts`)
  then **persisted** that report's counts onto the older run. Both rows showed one report; the stored
  numbers changed too. Fixing the folder name alone would have left that path intact.
- **The fallback cannot re-open the hole.** If a tokened run has no matching folder (the model
  ignored the instruction), it falls back to a prefix match restricted to folders that carry **no**
  token *and* were last written **after this run started** — so it can never adopt another run's
  folder, nor an older run's. No match = `null`, i.e. "this run produced no output", which is the
  honest answer.
- **Legacy rows (`outDirToken` NULL) keep the old behavior** through `resolveSlug`, which is right
  for them — but tokened folders are filtered out of its candidates, so a 2026-07 row can't start
  displaying a run recorded later.
- A tokened run resolves its folder **even with `slug` still NULL** (the row is written before the
  folder exists), so a live or canceled run shows its own partial output — safe now that the folder
  can only be its own.

## The Run form never pre-selects a BUSY ticket

`RunPage` restores the last inputs on mount (`loadLastInputs` + `loadBugTickets`), which re-checks
the previous lead ticket. An engineer who opens `/qc-run` while the portal is already working on
that ticket came to run a **different** one, so the auto-restored selection is pruned against
`busyTicketIds()` (`web/src/lib/busyTickets.ts`) — and there are **two** sources, both required:

- an in-flight **QC run** (`runs` where status is `running`/`queued`/`paused`), and
- an in-flight **test-case generation** (`GET /api/ai/testcases/jobs`: a `running`/`paused` job's
  items that are still `pending`/`running`). This is the one that was missing, and the reported
  case — generating cases for ticket A is exactly when the engineer lines up the next run, and the
  QC-run check can't see it.

Load-bearing details:

- **A job identifies its tickets by on-disk FOLDER** (nested `PARENT/CHILD` for a subtask) while the
  Run form selects by **display id**, so the crawled-tickets list translates between them; a folder
  with no `ticket.json` display id falls back to itself, which is what the picker keys on anyway.
- **It prunes ONCE per project, and only after BOTH lists have loaded.** Latching on the first
  render meant a cached-but-stale runs list — or the jobs query landing a beat later — silently
  skipped the prune.
- **Only the AUTO-restored selection is pruned.** A busy ticket the engineer then picks by hand
  stays picked (re-queueing a ticket on purpose is legitimate); the prune must not fight them.
- **It says which tickets it left out**, with the reason (`run` vs `testcases`) — a selection that
  silently empties itself reads as the form losing your input. The note disappears for a ticket
  picked anyway, since it explains an absence.
- A ticket that is BOTH running and being generated reads as `run` — the stronger statement, and the
  queue the engineer would be adding to.

## Headless or watched — a per-RUN browser choice (`runs.headless`)

Step 2 of the Run form ("Where to run") carries a **Run headless** checkbox for the **Web**
target. It exists because the mode is a property of the RUN, not of the project: the same
engineer watches a flaky login flow with their own eyes and then wants a two-hour sweep to
run without a Chrome window stealing focus. The MCP page's Playwright checkbox stays the
project's saved default; this overrides it for one run.

- **Nothing rewrites `.mcp.json`.** `server/src/playwrightRunMode.ts` writes a COMPLETE copy
  of the project's MCP servers — every one of them, with only the Playwright entry's browser
  mode swapped — beside the DB (`data/run-mcp/<runId>.json`) and `claude.ts` passes it as
  `--mcp-config <file> --strict-mcp-config`. Mutating the project file would fight a
  concurrent chat turn reading the same file, and would silently change the engineer's saved
  default. Strict mode is what makes the override authoritative (which config wins for a
  duplicate server name is undocumented) — which is exactly why the copy must be complete,
  or a run would lose ClickUp/Jira/Maestro mid-way. `localProjectMcpServers()` (the
  `~/.claude.json` project scope the MCP page also lists) is merged in underneath.
- **No override is written when none is needed.** If the project already runs in the
  requested mode — the common case, a headed project with the box unticked — the run spawns
  byte-for-byte as it did before this existed. The file is deleted when the run finishes.
- **Headless needs its own `--config`.** The headed one says `viewport: null` +
  `--start-maximized` (fill the real window); headless has no window, so the page would
  render at Chrome's 800x600 default — mobile-ish breakpoints and wrongly-shaped screenshots.
  `writeHeadlessPlaywrightMcpConfig()` pins 1440x900 instead. Verified end to end: a real CLI
  run with a generated config reported `innerWidth/innerHeight` = 1440x900 and opened no
  window.
- **Attach mode wins.** When the project drives the portal-owned QC browser
  (`--cdp-endpoint`), that browser is a window the portal already opened and the MCP launches
  nothing, so headless is impossible: the checkbox is disabled with a pointer to the MCP page
  and, if a request slips through, the run records a `system` event saying it stayed visible.
- **The choice is persisted (`runs.headless`, migration in `db.ts`)** because `resumeRun`
  rebuilds its body from the row — without it, a run paused headless came back with a window
  mid-sweep. NULL = the run took the project's setting, which is every row before this landed.
  The Run page remembers the last choice in `localStorage` (`qc.runHeadless`); it is a working
  habit, not a per-ticket decision. Default: **off** — a QC engineer's first instinct is to
  watch the run.

## Picking the device a mobile run drives

Both mobile targets on `/qc-run` ("Web on mobile", "App on device") drive a real device through
Maestro, and `list_devices` **order** used to decide which one — a coin toss whenever an Android
emulator, an iOS simulator and Maestro's synthetic `chromium` web device are up at once. So the Run
form pins the choice:

- **`RunDevicePicker`** (in `RunPage.tsx`) renders **Auto** + one chip per detected device, labeled
  by `web/src/lib/devices.ts` (`describeDevice`) — the **name** is the chip, the `device_id` only the
  caption. Detection is the same probe the MCP page's functional test uses
  (`runMcpTest('maestro', projectId, '')`), so it costs a real Claude/Maestro run (~20 s): it is
  **not** run on page load, only when a mobile target is selected, then cached for the session
  (`['maestro-devices', projectId]`, `staleTime: Infinity`) with an explicit **Re-scan**.
- The pick persists per project (`qc.runDevice.<projectId>`), because the same emulator usually stays
  booted across runs. It is only **sent** when it's still in the current listing — a remembered device
  that's no longer booted falls back to Auto (and says so) instead of failing the run on a stale id.
- `deviceId` threads `createRun` → `POST /api/qc/run` (validated `/^[\w.:@-]{1,80}$/`, and **dropped
  for the `web` target**) → `CreateRunBody` → `runManager` → `runQc`, which adds a `DEVICE:` prompt
  block: still call `list_devices`, then pass EXACTLY this `device_id`, never substitute another, and
  report a blocker (naming what it did find) if it's absent. **No pick = the previous behavior**, so
  single-device setups are unchanged.

**Naming the device you actually set up (`server/src/mobileDevices.ts`)** — a picker only works if the
chips are distinguishable, and Maestro reports an Android device's **adb serial as its name**, so both
pickers showed `emulator-5556` / `127.0.0.1:7555` where the engineer sees "dev" and "UAT" in their
emulator manager. adb knows the answer, so `androidDeviceNames()` asks it and
`normalizeDevices()` (mcpCapabilityTest.ts) substitutes the result. What matters here:

- **Which devices get looked up is decided by what adb CAN name, not by the shape of the id.** The old
  test was a serial regex (`^emulator-\d+$` / `^[A-Z0-9]{6,}$`), which silently excluded every
  TCP-attached emulator — MuMu, LDPlayer, BlueStacks, Nox all appear as `127.0.0.1:7555`, i.e. exactly
  the reported case. `adbCanName()` instead excludes only what adb has nothing to say about: Maestro's
  synthetic `chromium` entry and iOS (which Maestro already names properly, and whose UDID shape is
  recognized when no platform is reported).
- **Resolution order is emulator console → props → `devices -l` model**: `adb emu avd name` (the AVD
  name the engineer typed, and the only source for it), else ONE `getprop` dump read in `NAME_PROPS`
  order — the qemu `avd_name` props first, then model/marketing names — else the `model:` field adb
  already printed. One getprop beats five `getprop <key>` calls: the dump is tens of KB, while waking
  a device costs latency each time. Values that name nothing (`unknown`, `generic`, …) are rejected by
  `useless()` rather than allowed to displace a later candidate — "unknown" is a worse label than the
  serial it replaced.
- **`spawnEnv()` also looks for the adb that third-party emulators SHIP** (`bundledEmulatorDirs()`,
  Windows), because a QC machine running MuMu often has no Android SDK at all — and then nothing can
  be asked, so every device stays an address. Appended **last**, so a real platform-tools adb always
  wins: these bundled copies are frequently an older adb, and an old client kills a newer running
  adb server.
- **When adb itself can't be run the UI says so** (`deviceNamesUnavailable` on the detection reply →
  `deviceNameHint()` in `web/src/lib/devices.ts` → an amber line in the MCP dialog and the Run form's
  picker, shown only while some chip is still `isUnnamed`). Naming is best-effort and a missing name
  can never break a run — but this particular cause is fixable, and a silently unnamed device reads as
  the portal being broken instead.

