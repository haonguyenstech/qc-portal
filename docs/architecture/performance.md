# Performance testing (`/performance`)

One page, two tools, because "is this slow?" is really two questions and they are
answered by different machinery:

| Tab | Engine | Answers |
|-----|--------|---------|
| **Page load** | a real Chrome, driven by `playwright-core` | How long does the page take to load? How long did each API take to return its data? **Is one API being called several times on a single page load?** |
| **API load test** | `k6`, spawned as a child process | Do those response times hold up when N users hit the endpoint at once? |

Files:

```
server/src/k6.ts                 k6 detection, script generation, run + summary parsing
server/src/pageAudit.ts          the browser audit (timings + per-request table + duplicates)
server/src/authSession.ts        the sign-in window — a headed Chrome on the audit's profile
server/src/perfJobs.ts           one in-memory job registry for both kinds, polled by id
server/src/routes/performance.ts /api/performance/*
web/src/pages/PerformancePage.tsx
web/src/lib/perfReport.ts        verdict bands + Markdown/JSON export (shared by screen and file)
web/src/components/PerfJobWatcher.tsx   announces a finished job from any page
```

## Why both, and not just k6

k6 is a load generator. It has a browser module, but pointing it at a page does not
answer the question a QC engineer actually walks in with — *the orders screen feels
slow, why?* That answer is usually **not** "the endpoint is slow under load"; it is
"the page calls `/api/whoami` three times on mount". Only a real browser watching a
real page can see that, so the page audit exists alongside k6 rather than inside it.

Conversely the browser cannot answer "what happens at 50 concurrent users", so k6 is
not optional either. Neither tab is a lesser version of the other.

## Page audit — the decisions that matter

**It loads the page N times, not once.** A single navigation is noise: a cold first
load and a warm second load differ by more than most regressions do. The headline
tiles are averages; `perRun` keeps every individual load so an outlier stays visible
instead of disappearing into the mean.

**It keeps recording for `settleMs` after the `load` event.** Duplicate API calls are
overwhelmingly a post-mount effect — an effect that re-runs, two components fetching
the same resource. A capture that stops at `load` misses exactly the bug this feature
exists to find. Default 3s.

**Duplicates are grouped by endpoint, not by exact URL.** `?page=1` and `?page=2` are
one endpoint hit twice, and an app that fires both on mount has the same problem as
one that fires the identical URL twice. An endpoint is flagged at `perLoad >= 2`: once
per load is normal, twice means the app asked the same question twice.

**API calls and static assets have SEPARATE caps** (`MAX_TRACKED_API` 2000,
`MAX_TRACKED_OTHER` 400). This was measured, not guessed: a Vite dev server serves
each ES module as its own URL, so one load of the portal's own UI is 250+ requests.
Under a single shared cap the table filled with script files and then silently
dropped the XHR/fetch calls — under-reporting precisely the duplicate calls the
feature is for. When the asset cap is hit the log says so explicitly *and* says API
calls are unaffected; "the table is capped" alone reads as "your findings are
incomplete" when they are not.

**`totals.requestCount` comes from the browser's own resource timeline**, not from
the (asset-capped) table, so a 900-request page still reports 900.

**Timings** come from `PerformanceNavigationTiming` (TTFB, DOMContentLoaded, load) and
`paint` entries (FCP). **LCP needs an init script**: a `PerformanceObserver`
registered after `load` sees nothing, because LCP entries are only buffered for an
observer that asked for them up front.

Per-request duration is read on `requestfinished`, not on `response` — `response`
fires before the body is read, so its numbers would understate a slow API. Response
size comes from `request.sizes()`; `responseEnd === -1` means the browser served it
from memory cache and there is no network duration to report.

**Signing in is a first-class step, not a terminal command** (`authSession.ts`,
`/auth-session` routes, `SignInPanel`). The audit runs in `agentProfileDir()`, and
the apps under test keep their token in **localStorage — scoped per ORIGIN and per
PROFILE**. Two things follow, and both surprised a real user: being logged in on
your own Chrome does nothing (different profile), and being logged in to
`localhost:5173` does nothing for `https://dev.tabeebmed.com` (different origin).
So the page opens a headed Chrome on that exact profile, holds it while the
engineer signs in, and closes it on "I'm signed in" — **closing is the step that
matters**, because that is when Chrome flushes storage to disk and releases the
profile lock.

**Signing out is a separate step from signing in again** (`clearAuthSession`,
`POST /auth-session/clear`). Signing in on top of a stale token does nothing
visible: the app sees the token still in localStorage, skips its own login screen,
and the next audit is bounced to `/login` exactly as before — so the panel's
button reads **"Sign in again"** once an origin is known, and clears that origin
first. A bare **Sign out** does the clear without opening a window, which is also
how you audit as a different user. The clear is scoped to ONE origin — cookies
whose domain matches the host or a parent of it, plus localStorage /
sessionStorage / IndexedDB — because the profile also carries every other site's
session and wiping those is a much bigger promise than the button makes.
localStorage is only reachable from a page on that origin, so if the navigation
lands somewhere else (an SSO bounce) we report `storageCleared: false` and say
cookies alone went, rather than clearing the identity provider's storage by
mistake.

One window at a time, and never alongside an audit: Chrome will not open a profile
twice, so `POST /page-audits` returns a 400 naming the sign-in window rather than
letting Playwright report a `SingletonLock`, and the Measure button is disabled the
same way. The window is closed after 20 minutes and on server shutdown — a
forgotten one holds the lock and would break every later audit. Which origins have
been signed in is remembered in the BROWSER (`qc.perfSignedIn.<origin>`), never
server-side: it is a convenience label, and the session itself already lives in the
profile. It records that a close-and-save happened, NOT that the session is still
valid — an expired one still shows the pill, which is why the redirect banner
below exists and why Sign out clears the label and the real session together.

**A redirect is reported before any number is.** A page behind a login bounces a
session-less browser to `/login`, and the report then describes the login screen:
fast load, one API call, "no endpoint was called more than once" — confident and
completely wrong. `page.url()` after the last load is kept as `finalUrl`, compared
to the requested URL by ORIGIN + PATH (a `?returnUrl=` or a trailing slash is not a
redirect), and `redirected` drives an amber banner above the tiles, a log line
above the duplicate verdict, and the completion toast. The banner names the fix and
which one it is: profile off → tick "Use the logged-in profile"; profile on → the
saved session expired, log in again. A run that stayed put but saw `<= 1` API
endpoint gets the softer version of the same nudge.

The audit reuses `agentProfileDir()` — the same logged-in Chrome profile the page
scanner and Playwright MCP use — so a page behind a login is reachable. Chrome will
not open one profile twice, so a locked profile gets the same friendly message
`scanJobs.ts` gives. Unticking "use the logged-in profile" launches a clean browser
instead, and that path owns its `Browser` handle and closes it (closing only the
context would leave Chrome running).

## Getting an endpoint into the load form

Three ways in, all landing on the same `LoadEndpointDraft` (`web/src/lib/loadEndpoint.ts`):
paste a cURL, pick a saved request, or press **Load test** on the API Testing page.

That last one is a HANDOFF, not a lookup: it sends the draft the engineer is
looking at right now, unsaved edits included — the saved copy lags by an
auto-save debounce, and running a stale URL at 50 VUs is worse than not offering
the button. The endpoint is parked in **sessionStorage** (`qc.perfLoadHandoff`)
and the browser navigates to `/performance?tab=load`; the load form takes it on
mount. Not the URL, because a request's headers routinely carry a bearer token
and a URL is written to history, pasted into tickets, and captured by every
screen recording. `peekLoadEndpoint()` does NOT consume: the load form
merges the endpoint inside its `useState` initializer, and React double-invokes
initializers on mount in dev and keeps the SECOND result — a consuming read would
hand the endpoint to the pass that gets thrown away. `clearLoadHandoff()` runs
afterwards from an effect, alongside persisting the merged form and the toast:
all writes to something outside React, no state set (seeding a form by calling
setState from an effect body is the cascading-render pattern React's own lint
rule exists to stop).

**Headers travel with it, including the one you never typed.** `POST
/apiTests/send` adds `content-type: application/json` when the body is JSON and
no header row says otherwise, so that row is usually ABSENT from the request the
engineer just watched succeed — and k6 adds nothing of its own.
`withImplicitContentType` mirrors the send rule for all three import paths;
without it the load test 415'd against an endpoint that had answered 200 a
moment earlier. The imported card also opens on arrival (`importedFrom`): cards
past the first are collapsed by default, so an import that appended below an
existing endpoint looked like it had brought nothing across.

## Recent runs — the list, and deleting from it

`RecentRuns` is one component used by BOTH tabs, so anything here is true of a
page audit and a load test alike.

**Every row shows the date, not just the clock time.** The registry is in memory
and the portal's server routinely stays up for days, so the list mixes runs from
several dates; a bare `14:32` made last Tuesday's run read as one from twenty
minutes ago, and these rows are how an engineer picks the report to compare
against. The year appears only when it isn't this one; the full stamp is the
row's `title`.

**Rows can be deleted** (`DELETE /jobs/:id` → `deletePerfJob`). Without it the
list is pruned only by age (`MAX_JOBS` 40), which is the wrong order when the
runs worth keeping are the baselines and the noise is the six attempts it took
to get the URL right. Three things the delete has to get right:

- A **running** job is cancelled on the way out, not refused. A delete that left
  the k6 child or the audit Chrome alive would leave a process reporting into an
  object nothing can read — and for an audit, a stray Chrome holding the profile
  lock every later run needs.
- The **load test's run folder goes too** (`removeK6RunDir`). The script is
  generated FROM the config, so leaving it beside the DB keeps a description of
  a test the engineer just said they were done with. The id is shape-checked
  before that recursive delete, since it arrives as a request parameter.
- The client clears its **active-job pointer before** the list refetches
  (`onMutate`). Leaving it set means the next poll asks for a job the server no
  longer has, and the report area flashes an error on its way to falling back to
  the newest run.

The row is a `div` wrapping two buttons, not one button containing another —
nesting them is invalid HTML and the browser may swallow one of the clicks. The
trash only appears on hover/focus, because the common gesture on this list is
"open that report".

## k6 — the decisions that matter

**The generated script lives beside the DB, never in the project repo**
(`<dirname(QC_DB_PATH)>/perf-runs/<jobId>/`). A load test's headers routinely carry a
bearer token, and a script written into the repo would be committed. Same posture as
`qcBrowser.ts`'s Playwright MCP config, same reason: the file describes this
machine's run, not the project.

**Secrets are not in that file either.** Per-endpoint headers and bodies reach k6
through environment variables (`QCP_H<i>` / `QCP_B<i>`) and are read back with
`__ENV`, so the on-disk script contains only method, URL and label. This is
verifiable from the UI: **View k6 script** shows exactly what runs. It was verified
by measurement too — a run with an `Authorization` header and one without returned
response bodies differing by exactly the length of that header, proving the header
was delivered, while `grep` over the run directory found no token.

**Per-endpoint numbers are explicit custom metrics, not tag sub-metrics.** k6 only
emits a tagged sub-metric (`http_req_duration{name:x}`) when a threshold names it; a
`Trend` per endpoint always lands in the summary. Each endpoint gets
`ep<i>_duration`, `ep<i>_waiting` (TTFB — the server's think time, i.e. how long
until data came back), `ep<i>_bytes`, `ep<i>_ok`, `ep<i>_calls`.

**The time axis is bucketed INSIDE the script, because k6's summary has none.**
The end-of-test summary is one set of aggregates for the whole run, so the question a
load test exists to answer — *did it get worse as the load arrived?* — cannot be read
off it. Streaming every sample to a CSV was rejected: a 30-minute run at 200 VUs is
tens of millions of rows, nearly all of them discarded. Instead the script owns a
FIXED set of custom metrics (`b<i>_duration`, `b<i>_reqs`, `b<i>_fail`, `b<i>_vus`)
and adds each request to the slice it landed in. k6 aggregates them for free and
prints them like any other metric.

Three things this depends on, each verified against **k6 v2.2.0**:

- **`timeBuckets(cfg)` is the single source of the axis.** Both `buildK6Script` and
  `parseK6Summary` call it, and it is derived from the config, never stored — the same
  config always produces the same axis. ~36 slices, capped at 48.
- **`QCP_START` is passed in the spawn environment**, so every VU shares one clock.
  A ramp-up starts VUs at different moments; a per-VU `Date.now()` would file the same
  wall-clock second under a different slice per VU. The script falls back to its own
  start time so it still runs by hand.
- **A slice with no samples is ABSENT from the summary, not zero.** Empty slices are
  skipped rather than drawn, or a run that finished early would end in a cliff to 0ms
  that never happened. The final slice is also dropped when it holds under a third of
  its predecessor: the run almost never ends on a boundary, and that sliver otherwise
  reports a fraction of a second's traffic as if it were a full one.

**Drift is measured on the steady part of the run, using the MEDIAN slice.** Two
corrections, both from real data:

- Comparing the first quarter of a ramped run with its last compares the ramp-UP with
  the ramp-DOWN, and reported an unchanged system as "1.5× slower by the end". The
  window is now selected on the *measured* VU count (`vus >= 0.9 × peak`), which works
  for a flat run and a ramped one without knowing which it was.
- One second of stall — a GC pause, a cold cache — lands in a single slice with a p95
  fifteen times its neighbours, and a MEAN let that slice report a steady system as
  "3.7× slower". The median of the slices is used instead. The spike is still a real
  finding; it is reported as a spike, and a spike is not drift.

**`http_req_failed.passes` is the count of FAILED requests.** It is a `Rate` over "did
this request fail", so `passes` counts the `true`s. Reading `fails` there reports every
healthy request as an error.

**Exit code 99 is a RESULT, not a failure.** It is k6's dedicated "a threshold was
crossed" code; the run completed and every number is valid. `parseK6Summary` records
it as `thresholdsPassed: false` and the report draws a red banner — treating it as an
error would throw away the report the engineer just waited minutes for.

**The summary is written by `handleSummary`, not `--summary-export`** (deprecated).
The script returns `{ 'summary.json': JSON.stringify(data) }` and k6 runs with
`cwd` set to the run directory. Verified against **k6 v2.2.0**: the shape is
`{root_group, options, state, metrics}`, with `metrics.<name>.values` holding
`avg/min/med/max/p(90)/p(95)/p(99)` and `state.testRunDurationMs`.

k6's progress redraws use `\r`. Output is split on `[\r\n]` and the `running (…)` /
`default [ … ]` lines are routed to the job's `progress` field instead of the log, so
a 5-minute run doesn't produce 300 near-identical log lines.

## The verdict, and getting it out of the page

`lib/perfReport.ts` holds three things that must never drift apart: the **bands**,
the **verdict**, and the **export**. The tables answer "what happened"; a QC
engineer still has to write "is this good, and what do I chase" into a ticket, and
a report whose exported copy grades differently from the screen is worse than no
export — so both read the same functions.

The page bands are the public Core Web Vitals ones (LCP 2.5s/4s, FCP 1.8s/3s, TTFB
0.8s/1.8s), deliberately not invented numbers, so a verdict here matches what
Lighthouse would say and survives an argument. The load-test p95 band is the
**engineer's own threshold** when the test set one: k6 already decided pass/fail on
it, and a second opinion beside k6's verdict would just be two answers.

A **redirected** page audit is graded `unknown`, not "fast" — grading the login
screen is exactly the confident-wrong-answer this feature keeps having to avoid.

**Charts are SVG STRINGS, not components** (`lib/perfCharts.ts`). The same drawing
has to appear on the page, in the PDF and in the Word file; three renderers is three
chances to drift, so one function draws all three and the page injects the string.
Colour comes from `--viz-*` custom properties — defined in `index.css` for the app
(with dark-mode steps) and inline in the exported document, which always prints
light. The series hues are the validated categorical slots 1 and 2; every bar also
carries its value as text and a word ("slow", "poor", "errors", "over target") so
nothing depends on colour, and the table under each chart is the accessible view.

**Four export formats, one source.** Markdown and JSON are built in the browser.
PDF and DOCX are the SAME report HTML (`lib/perfReportHtml.ts`) converted
server-side (`reportExport.ts`, `POST /report/pdf` | `/report/docx`) — the client
sends the rendered HTML and the server only converts, because the verdict and the
charts live in the web bundle and re-deriving them server-side would eventually let
the PDF grade a run differently from the screen. Printing needs a real Chrome and
.docx needs a zip writer; those are the halves a page cannot do.

Two things that are easy to get wrong there: the export browser is a **clean**
Chrome, never `agentProfileDir()` — sharing the audit's profile would mean an export
could not run while an audit did, and an export has no reason to be logged in. And
**Word does not read inline SVG**: `html-to-docx` passes it through as unknown
markup, so the charts would silently vanish. Each chart is screenshotted at 2× by
that same Chrome and swapped for a data-URI `<img>` before conversion.

What is screenshotted is the whole **figure** (`div.viz-root`), not the bare `svg`
inside it. The legend sits beside the svg and paints its swatches with
`background: var(--viz-series-N)` — one more thing Word cannot resolve — so
shooting only the svg left Word with colored bars above a legend of *colorless*
text: identity by color alone, with the color missing. Capturing the figure bakes
the swatches into the image. The swap happens in the DOM (`page.evaluate`), not by
regex on the markup: `viz-root` has nested children, and "up to the closing tag" is
not something a regex can be trusted to find.

Nothing is written into the project: the page's promise is that it draws nothing on
disk, so every file reaches the engineer through the browser's own download.

## Filling an endpoint from somewhere else

Typing a URL, its headers and its body into the load form is the slowest part of
setting a load test up, and it is work the engineer has usually already done — in
the browser's network tab, or on `/api-testing`. Two buttons beside **Add endpoint**
skip it:

- **Paste cURL** reuses `CurlImportDialog` and `lib/curl.ts` — the same parser the
  API Testing request builder and the Flows tab use. One parser, three callers.
- **From API Testing** opens `SavedRequestPicker`, a read-only, MULTI-select list of
  the project's saved requests (a load test worth running usually covers several
  calls, and one dialog per call is the same tedium in a different shape).

`lib/loadEndpoint.ts` does the conversion, and three things about it are load-bearing:

- **Query rows become part of the URL.** API Testing keeps them as an editable list
  and appends them server-side at send time; k6 is handed one URL string.
- **Values are percent-encoded, `{{variables}}` are not.** Encoding `{{token}}` into
  `%7B%7Btoken%7D%7D` stops the substitution pattern matching, and the load test
  would send literal braces to the server. The URL is also assembled by hand rather
  than through `new URL()`, because `{{baseUrl}}/orders` is not a parseable URL yet
  and throwing there would make every environment-based request un-importable.
- **Assertions, captures and AI expectations are dropped.** A load test measures
  timing under concurrency; k6's own pass/fail is the status check plus the
  thresholds on the form.

### Variables are resolved at RUN START, on the server

An imported request keeps its `{{variables}}` all the way through the form. They are
substituted in `routes/performance.ts` (`substituteLoadConfig`) using the same
`resolveSendVars` + `substituteVars` API Testing uses at send time — exported from
`routes/apiTests.ts` so there is one definition of what a variable means.

It has to work this way round. The browser is never given the secret values
(`/environments` masks them), so the page could not resolve them; and the load form
is persisted to **localStorage**, so if the server did hand them over, a bearer token
or a test account's password would be written into browser storage. Leaving them as
`{{token}}` keeps the secret on the server, and the resolved value reaches k6 through
the environment exactly as a hand-typed one does — never into the generated script,
never into the job's public shape, never onto disk. Verified: a run with a secret
variable produced no copy of it under `data/perf-runs` and none in the poll JSON.

Two details that follow from it:

- Substitution runs **before** `parseLoadConfig`, which requires a real `http(s)://`
  URL — `{{baseUrl}}/orders` is not one yet.
- The **script preview** substitutes in `display` mode, which resolves ordinary
  variables but keeps secret ones as `{{placeholder}}`. That preview is the one place
  the generated script is ever rendered in the browser, so a secret in a query string
  must not be printed there.

An unknown variable is refused with the same message API Testing gives, naming the
missing keys — not left to fail later as a 401 nobody can explain.

## The NFR report — the deliverable, not the readout

Everything above answers "how did this run go?" and grades it Healthy / Needs
attention / Poor. That is the right answer while you are still looking at the run.
It is not the document a QC hands to a client at the end of a test phase, which is
organised the other way round: **by requirement, not by run**.

`nfrReport.ts` + `nfrReportHtml.ts` + `components/NfrReportPanel.tsx` build that
document. The structure follows a real delivered report (an enrolment-journey NFR
report, phase 4 round 2) rather than an invented one — a format the client has
already signed off on is worth more than a nicer one they have to learn:

```
Executive summary   requirement × scope × key result × status
1  Environments, test configuration, objective and scope
2  Requirements and acceptance criteria, metric definitions
3  Detailed results — per requirement, per test case, with charts
4  Findings, recommendations (prioritised), final assessment, data limitations
```

A **requirement** is `{id, scope, criterion, metric, target, endpoints[]}`. A **test
case** is one endpoint of one run, so a report can be composed from SEVERAL runs —
which is how the source report was built, and why the panel takes a run *selection*
rather than the current run. Requirements and report metadata live in localStorage
per project: they are the engineer's notes about a client's acceptance criteria,
they change every round, and a database migration for that list would buy nothing.

Four rules the code must not soften — each one is the mistake it prevents:

- **A requirement nobody tested is PENDING — never Pass, never Failed.** The source
  report says so in as many words. `pendingReason` forces PENDING even when runs
  contain matching endpoints, because the engineer saying "this round did not cover
  it" outranks a name match. The final assessment NAMES the pending requirements on
  both branches, including the all-passed one: "everything passed" beside an unnamed
  count is the sentence most likely to be quoted as "the round passed".
- **Stability and performance are judged separately.** "No HTTP failures, but
  severely slow" is a real outcome; one merged verdict loses it. Every case reports
  both, and a requirement where every case stayed up and every case missed its
  target is `PERFORMANCE RISK`, not `FAILED`.
- **Success rate is the one metric where bigger is better**, so it is the only one
  compared with `>=`. Getting that backwards would report a passing system as
  failed, which is the most damaging mistake this file could make. It has a test.
- **Every number is one k6 actually produced.** k6's end-of-test summary carries no
  peak-RPS figure, so the report gives the AVERAGE rate under that name and says so
  in `DATA_LIMITATIONS`, which is printed as section 4.5. Quietly relabelling an
  average as a peak is the error nobody downstream can catch.

Export reuses the same server conversion as the quick report, plus a **running
footer**: `htmlToPdf(html, footer)` switches on Chrome's `displayHeaderFooter` (an
element at the end of the document prints once, at the end — only a running footer
appears on every page), and `htmlToDocx(html, footer)` passes html-to-docx's fourth
argument with `footer`/`pageNumber` on. The footer text is stripped to plain text
server-side (`footerText`) before it is interpolated into either: a report title is
data, not markup.

### The form fills itself in

A report round used to begin by hand-typing nine cover fields and every requirement,
and all of it was already in the portal. Eight of the nine are now derived:

| Field | Derived from |
|---|---|
| System under test | the active project's name |
| Phase / round | the selected runs' labels, in chronological order |
| Environment | the endpoint hostnames (`classifyEnvironment`) |
| Load origin | this machine — k6 always runs locally |
| Tested by | `git config user.name`, project-local first, then global |
| Test date | the earliest selected run |
| Systems in scope | the distinct origins, with a DISTINCT endpoint count |
| Objective and scope | the endpoints, hosts and applied load, as a sentence |
| Notes | *(nothing to derive — the one field that stays manual)* |

Requirements are derived too: **`suggestRequirements` reads the thresholds the runs
were configured with**. "Fail if p95 over 2000ms" IS an acceptance criterion — it was
typed into the load form before the run started, and asking for the same number a
second time only invites the two copies to disagree. `defaultScope` /
`defaultCriterion` then write the sentence a metric and a target already imply, so an
untouched form still produces a complete document rather than a table of "—".

Three rules hold this together, and each is a bug that was avoided rather than fixed:

- **Nothing is ever written into the engineer's fields.** A suggestion is a FALLBACK:
  `resolveMeta` prefers whatever was typed and an empty field falls back to the
  derived value. So there is no effect racing keystrokes, clearing a field is not a
  fight with the auto-fill, and changing the run selection re-derives on the next
  render instead of leaving a stale value behind. `localStorage` still holds only
  what was typed — verified by checking the key is still absent after the panel has
  filled the whole form. The explicit **Fill in** button materialises the
  suggestions when the engineer wants to edit them.
- **`classifyEnvironment` never returns "Production".** The absence of a staging
  marker is not evidence of production, and a report presented as production evidence
  when it is not is the one mistake here that cannot be walked back. It returns blank
  and says so.
- **Markers match a whole label, or a label's suffix — never a prefix.** Exact-only
  misses `epuat.example.org` and `apistaging.example.com`; suffix-for-everything
  makes `latest` and `greatest` read as test environments, and prefix matching makes
  `devices` read as development. Suffix matching is therefore allowed per marker, only
  where it survives (`uat`, `staging`, `preprod`). A trailing number is an instance,
  not an environment, so `uat2` is UAT.

## What the report answers, and the charts that answer it

A summary table says "p95 was 400ms". It cannot say whether that is the whole story,
so the report carries the numbers that decide what to do next:

| Section | The question it answers | Where it comes from |
|---|---|---|
| Response time across the run | slow, or *getting* slower? | the time buckets |
| Throughput across the run | did it flatten while load kept rising (saturation)? | the time buckets |
| Load applied | was the change the system, or just more VUs arriving? | `b<i>_vus`; drawn only for a ramped run |
| Errors across the run | *when* did the failures start? | drawn only when there were any |
| Where the time goes | server think-time, payload, connection setup, or the generator? | `http_req_blocked/connecting/tls/sending/waiting/receiving` |
| Calls per endpoint | is the mix realistic, and which endpoint owns the failures? | `ep<i>_calls` / `ep<i>_ok` |

Two rules the charts follow, both easy to break by accident:

- **One y axis, always.** Response time and requests/second do not share a scale, so
  they are two charts stacked as small multiples. A second axis lets the drawing decide
  which line looks higher.
- **Nothing rests on colour.** Every bar carries its number and a word (`met` /
  `over target` / `errors`), every stacked segment repeats its value in the legend, and
  every chart has a table beside it. The report is read in print and in Word.

The five categorical slots (`--viz-series-1..5`, light and dark) were run through the
palette validator rather than eyeballed: all pass the lightness band, chroma floor,
adjacent-pair CVD separation, normal-vision floor and contrast checks in both modes.

**`MEASUREMENT_NOTES` ships WITH the report**, in Markdown, HTML, PDF and Word, and is
collapsible on screen. Every note in it is a way a real number was read wrong —
average throughput taken for peak, a per-request percentile taken for a per-journey
one, a 2xx counted as correctness. A footnote in a wiki beside the report is a
footnote nobody opens.

## Jobs, polling, notifications

Both kinds are one registry (`perfJobs.ts`), polled over HTTP by id — no WebSocket.
A load test runs for minutes by definition, so the engineer must be able to start
one, navigate away, reload, and come back to the report. Jobs live for the life of
the server process, are pruned at 40, and are killed on shutdown
(`shutdownPerfJobs()` in `index.ts` — k6 children and audit browsers are spawned
outside `runManager`, so without it a restart orphans a running load test).

The public job shape **omits the k6 config's headers and bodies**. A poll response is
the easiest place in the portal for a credential to end up in a browser devtools log.

**Which tab is open lives in the URL** — `?tab=page` (default) / `?tab=load`, the
same convention `/settings` uses — so a reload comes back to the tool you were
using instead of always to Page load, and a link can point at one of the two. The
tab is set with `replace: true`: back should leave the page, not walk through tab
switches. `PerfJobWatcher`'s notifications deep-link to the matching tab, so
clicking "Load test passed" lands on the load report rather than on Page load.

`PerformancePage` remembers the active job id per kind per project
(`qc.perfJob.<kind>.<projectId>`) so a reload reconnects. `PerfJobWatcher`, mounted at
the app root, announces completion from any page and clears that pointer; when the
pointer is gone or the job was pruned the page falls back to the most recent run of
that tab, so a reload lands on the last report rather than an empty form.

The workbench is **keyed by project id** so switching projects remounts it. Every
piece of per-project state then comes from a lazy initializer that reads
`localStorage` once, rather than an effect that notices the project changed and
overwrites state afterwards (which is also what keeps the page clean under the repo's
`react-hooks/set-state-in-effect` lint rule).

## Installing k6

k6 is not bundled. `GET /api/performance/available` reports whether it runs here, and
the load tab shows a platform-appropriate install command
(`brew install k6` / `winget install k6 --source winget` / the Grafana apt
instructions) with a copy button. `POST /load-tests` re-checks before starting so a
missing k6 is a clear 400, not a job whose only content is `command not found`.
`QC_K6_BIN` overrides the executable path; every spawn goes through `spawnEnv()`, so
a k6 in `~/.local/bin` resolves under a stale PATH.

## Limits

| Thing | Limit | Why |
|-------|-------|-----|
| VUs | 200 | It's a QC laptop, not a load-generation cluster |
| Test duration | 30 min | A runaway soak shouldn't hold a job slot all day |
| Endpoints per test | 20 | Beyond that the per-endpoint table stops being readable |
| Page loads per audit | 10 | 3 is enough to average out noise |
| Settle window | 30s | |
