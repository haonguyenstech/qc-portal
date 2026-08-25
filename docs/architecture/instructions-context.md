<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Instructions page — the project context hub (CLAUDE.md + Knowledge + Memory)

**`/instructions` (`InstructionsPage.tsx`)** is the single place for *everything Claude reads on
every QC run*, kept as three tabs so standing guidance is **split into structured folders instead
of crammed into one big CLAUDE.md**:

1. **Instructions** — the lean root `CLAUDE.md` editor (`ClaudeMdCard`/`ClaudeMdEditor`, Edit⇄Preview
   + Save, via `GET/PUT /api/projects/:id/claude-md`).
2. **Knowledge** — `web/src/components/KnowledgeDocs.tsx` (moved here from Overview).
3. **Memory** — `web/src/components/MemoryNotes.tsx` (new).

**Knowledge** — a QC engineer uploads project docs — **Word (.docx), PDF, Markdown/TXT, CSV, Excel** —
to supplement the project's AI knowledge. **Conversion happens in the browser** (`web/src/lib/docConvert.ts`,
mirroring the existing xlsx-in-browser pattern): `.docx` via `mammoth` + `turndown` (+`turndown-plugin-gfm`),
`.pdf` via `pdfjs-dist` text extraction, spreadsheets → GFM tables via `xlsx`, Markdown/TXT passthrough.
All converters are **dynamically imported** so they stay out of the main bundle. The resulting Markdown
is POSTed to `routes/knowledge.ts`, which stores it under `<root>/testing/knowledge/<name>.md` (plain-text,
path-guarded filenames — mirrors `routes/templates.ts`, no DB). Routes: `GET /api/knowledge` (metadata
list), `GET /:name` (full md for preview), `PUT /:name` (save converted md), `DELETE /:name`, `POST /open`.
Scanned/image-only PDFs yield no text and surface a clear error (no OCR).

**Images are the one upload that goes to the server** (`server/src/knowledgeImages.ts`, `POST
/api/knowledge/from-image`). Most projects document their logic as a **picture** — a flow diagram,
an ERD, a state machine, an annotated screen — and a picture has no text to extract, so the browser
conversion above cannot help: the model has to SEE it. The image is written to
`testing/knowledge/assets/<slug>-<stamp>.<ext>` **first** (Read takes a path, not bytes), then one
`sonnet` pass with `--allowedTools Read` and `--strict-mcp-config` writes the Markdown doc — every
label, arrow, branch, state, entity and rule as written, an explicit note where the image is
unreadable, and a closing "What this means for testing" section. Stamped `ai · image · <date>`, so
it carries the same reviewable **AI** badge as auto-capture.

- **The image is kept, not consumed.** The doc ends with `![…](assets/<file>)`. A diagram flattened
  into prose can no longer be checked against the diagram — and the same relative path works for
  both readers: the preview resolves it through `GET /api/knowledge/assets/:file` (strict name
  pattern, resolved inside the assets folder), and a QC run, whose cwd is the project root, can
  `Read` the picture from the doc's own folder.
- **A blank or irrelevant image must not become knowledge.** `projectContext.ts` packs this folder
  into every later prompt, so "the uploaded file renders as a blank white image" would be read as a
  project fact from then on — measured: without a refusal protocol the model politely wrote a
  692-character document saying there was nothing to document, and it was saved. The prompt now has
  the model answer `NOT_USABLE: <what it is>` instead, which the route turns into a 422 (a
  suspiciously short answer is rejected under it as a backstop). **Every path that leaves without a
  written doc deletes the image it saved**, so a failed upload leaves nothing in the engineer's repo.
- **Deleting a doc deletes its images** (`deleteDocAssets`, scoped to `assets/`), and re-uploading
  under an existing name drops the replaced doc's images — otherwise each removed diagram would
  leave its picture behind with nothing pointing at it.
- The preview strips the provenance marker before rendering: `react-markdown` runs without
  `rehype-raw`, so the `<!-- qc-portal:source: … -->` comment was printing as literal text across the
  top of every AI-captured doc. The `source` field beside it already carries that information.

**Memory** — small, **in-portal-authored** markdown notes, one durable fact each (decisions, gotchas,
conventions). Unlike Knowledge (uploaded + converted docs), notes are written directly in the portal
(name + one-line description + body). Stored by `routes/memory.ts` under `<root>/testing/memory/<name>.md`
with the description in YAML frontmatter; `testing/memory/MEMORY.md` is an **auto-regenerated index**
(one line per note, rebuilt on every save/delete, removed when the folder empties). Routes:
`GET /api/memory`, `GET /:name` (description + body), `PUT /:name` (`{description, content}`),
`DELETE /:name`, `POST /open`. The editor remounts via `key` to seed form state (no setState-in-effect,
mirroring `ClaudeMdEditor`); `MEMORY.md` is reserved and can't be used as a note name.

**AI auto-capture (knowledge updates itself after runs)** — `server/src/learn.ts` (`runKnowledgeUpdate`)
runs a cheap Claude reflection after a QC run **and** after test-case generation, then persists durable
facts it learned: small facts → `testing/memory/`, longer reference write-ups → `testing/knowledge/`
(the model decides, and is told to *update* an existing note rather than duplicate). It's **best-effort
and never blocks/fails the run** — failures are silent. Captured items are stamped with a `source`
provenance (memory: a `source:` frontmatter field; knowledge: a leading `<!-- qc-portal:source: … -->`
comment, invisible when rendered) so the UI flags them with an **"AI" badge** and the engineer can
review/edit/delete them — *editing a note via the UI drops the AI tag, claiming it as the user's*. This
is the "AI updates its own knowledge, and the user can correct it" loop. Hooks: `runManager.ts` `onDone`
(QC runs, broadcasts a follow-up `system` event listing what was captured) and `testcaseJobs.ts` (after
the batch finalizes, before `finalize()`, logging into the job's `logs[]`). Toggled **per project** in
Settings → Models (see "Per-project control" under the grounding-check section); `QC_AUTO_LEARN`
(default on) and `QC_AUTO_LEARN_MODEL` (default `haiku`) now only seed new projects. The `TestCaseJobWatcher` invalidates
`['memory', …]` / `['knowledge', …]` on completion so new notes appear. Storage goes through the shared
`memoryStore.ts` / `knowledgeStore.ts` so the format stays identical to the manual editors.

**Chat feedback → memory (`learn.ts` `runFeedbackCapture`)** — the 👍/👎 under every chat answer is a
*third* writer into `testing/memory`, alongside the manual editor and auto-capture. `POST
/api/chat/:slug/feedback` saves the vote onto the message first, then reflects on question + answer +
vote (+ the reason typed with a 👎) with the project's `autoLearnModel` and writes the durable fact
behind it — **memory only, at most 2 notes**, stamped `source: feedback · liked|disliked · <date>` so
it carries the same reviewable AI provenance. Deliberately **not** gated on the project's auto-learn
toggle (that governs capture that happens on its own; this one is a button press), and clearing a vote
does **not** delete the note it wrote. Why it belongs here: chat already reads this folder on every
turn via the managed pointer block, so rating an answer is the shortest path there is from "that was
wrong" to "later answers know better". Details and the two write races in
`docs/architecture/chat.md`.

**Chat's own accuracy layers** — a chat turn is the one AI surface here that reads project context and
answers **without** anything auto-revising it afterwards, so it carries three cheap defences of its own
instead: an always-on prompt block (`FACTS_BLOCK`) that forbids the four measured causes of a wrong
ticket / test-case detail, a free `existsSync` check of every project path the answer cited
(`answerCheck.ts`), and an **on-demand** independent audit of one answer (`answerAudit.ts`), which is
the grounding check below aimed at a chat answer and gated behind a button because it re-reads the
project. It uses the project's `groundingCheckModel`, so "how much does this project spend auditing
itself" stays one setting. Full rationale in `docs/architecture/chat.md`.

**Grounding check (anti-hallucination, auto-revise after every AI write)** — `server/src/groundingCheck.ts`
runs an **independent, cheap second pass** (default `haiku`) right after the portal writes an AI artifact,
to catch and silently correct hallucination. Two entry points, both **best-effort and `never-throw`**:
- `groundTestcases()` — audits generated cases against the **ticket _and_ the project's Knowledge/Memory**
  (passed in via the `knowledge` opt — the same `readProjectContext` block the cases were written against, so a
  case grounded in documented project rules counts as grounded, ticket **OR** knowledge) and drops/fixes anything
  ungrounded (invented fields/screens/messages, contradicted or fabricated acceptance criteria), keeping
  legitimate edge/negative coverage. Called at the end of `generateTestcaseVersion` (`testcaseGen.ts`); when it
  changes anything it **overwrites the same `v<N>` file** (no new version) and logs into the run/job log.
- `groundReport()` — audits a finished QC **`report.md`** so any Pass/Fail verdict **not backed by a
  documented observation** is downgraded to Fail/Partial with an `(unverified — no supporting evidence…)`
  note. Called in `runManager.ts` `onDone` **before `parseReport`**, so the Pass/Fail counts reflect the
  grounded report. The pre-audit copy is kept on disk as `report.pre-grounding.md`; a `system` event marks
  whether it corrected anything.

To stay robust without a fragile JSON-wrapped document, the model emits **either the literal sentinel
`GROUNDED_OK`** (nothing to fix → no rewrite) **or the full corrected document** in the same format. The
result is only applied through safety guards — non-empty, ≥50% of the original length (rejects a truncated
rewrite), and (CSV) an unchanged header row — otherwise the original is kept. This complements
**AI auto-capture** above: auto-capture *learns* from a finished artifact, grounding-check *corrects* it first.

**Per-project control (Settings → Models)** — both grounding-check and auto-learn are stored **per project**
on `projects.groundingCheck` / `groundingCheckModel` / `autoLearn` / `autoLearnModel` and edited in the
`AiAutomationCard` on `/settings?tab=models` (scoped to the *active* project; each control auto-saves via
`PUT /api/projects/:id`). The resolution path reads the project's values — `runManager.ts` (`project.*`),
`testcaseGen.generateTestcaseVersion` (`opts.groundingCheck`/`groundingCheckModel`), and `testcaseJobs.ts`
(captured onto the job at start). The `QC_GROUNDING_CHECK` / `QC_AUTO_LEARN` env vars are now only the
**default for newly-created projects** (seeded in `createProject`); migrated/existing projects default ON
with `haiku`.

**Authenticator (2FA) codes — when the OTP isn't fixed (`server/src/totp.ts`)** — a production-like
environment has **no fixed OTP**: the six digits come from Google Authenticator / Authy on the QC
engineer's phone. RFC 6238 makes the code a pure function of `secret + clock`, so the portal stores the
account's **enrollment secret** once and computes the *same* code the phone shows — a headless run then
gets through 2FA on its own instead of stalling or inventing digits.

- **Storage is deliberately NOT `testing/`.** Unlike `environments.md`, a TOTP seed is a long-lived
  second factor: it must not be committed to the project repo and must never be swept into a prompt by
  `projectContext.ts`. It lives beside the portal's DB at `data/totp/<projectId>.json` (dir `0700`,
  file `0600`). The seed is **write-only over the API** — `PublicTotpEntry` strips it, and the only
  thing that ever leaves the process is a 6-digit code.
- **Routes** (in `routes/accounts.ts`, all under `/totp` so they can't collide with the sheet routes):
  `GET /api/accounts/totp` (entries, no secrets), `GET /totp/codes` (live code for each — drives the
  UI), `PUT /totp` (register/replace; `secret` accepts a base32 setup key **or** a whole
  `otpauth://totp/…` link, parsed by `parseOtpauth`), `DELETE /totp/:label`, and
  `GET /totp/:label/code` — **the one a run calls**. A bad seed is rejected at `PUT` time by actually
  generating a code with it, so a typo fails there and not mid-run. `PUT`/`DELETE` re-run
  `syncContextPointer`.
- **How the run learns to use it — two injections, mirroring Knowledge/Memory.** `totpPromptHint(projectId)`
  builds a prompt block (labels + the exact `curl … /totp/<label>/code?projectId=…`, "submit immediately,
  refetch if rejected, never write a code into a report/screenshot, report BLOCKED rather than invent one")
  that `runManager.ts` passes to `runQc` as `totpHint`; and `contextPointer.ts` adds an equivalent bullet
  to the managed `CLAUDE.md` block so an interactive terminal / Continue session gets it too. Both are
  **empty no-ops when the project has no authenticators**, so fixed-OTP projects are unchanged.
- **Test-case generation** gets a different instruction (`projectContext.ts`): never write a literal code —
  say "enter the current authenticator code for `<account>`" — and don't raise cases about the code being
  unavailable, because the portal supplies it. A hard-coded OTP in a case is wrong by the time it runs.
- `projectScope.ts` `projectIdForRoot(root)` is what lets the root-path-only modules (`contextPointer`,
  `projectContext`) reach a store keyed by project id — resolved there rather than threaded through all
  ~12 `syncContextPointer` call sites, where one omission would point the block at the wrong project.
- **UI:** `web/src/components/TotpCodes.tsx`, rendered at the bottom of `AccountsDoc` (the sheet says
  *which* account, this hands out its code). Live codes poll `GET /totp/codes` once a second with a
  drain-bar countdown, so the engineer can **eyeball-match a code against their phone** to confirm the
  key — that verification is the point of showing codes in the UI at all.

**How Knowledge/Memory reach the model — two paths, by run shape:**

1. **In-process runs (project cwd) — the context pointer.** `server/src/contextPointer.ts` maintains a
   managed block in the project's `CLAUDE.md`, delimited by `<!-- qc-portal:context (auto) -->` …
   `<!-- /qc-portal:context -->`, that tells Claude to consult `testing/knowledge/*.md` and
   `testing/memory/*.md`. `syncContextPointer(root)` is **idempotent** and is called from the knowledge +
   memory `PUT`/`DELETE` routes: it appends/updates the block when either folder has content, strips it
   (preserving the engineer's prose) when both go empty, and never writes when the file is already correct.
   **QC runs** spawn `claude` in the project root, so the pointer is what makes the split-out Knowledge/Memory
   get read there; `runQc` (`claude.ts`) also adds explicit one-line reminders to read them — **and to read
   the feature's SOURCE CODE** (Grep/Glob/Read the codebase for the screens/endpoints/fields named in the
   ticket) — before testing.
2. **Direct injection via `projectContext.ts` (test-case generation).** `readProjectContext(root)` packs
   `testing/memory/*.md` (description + body, MEMORY.md excluded) then `testing/knowledge/*.md` (provenance
   marker stripped) into one capped block (32 KB total / 6 KB per item / memory bounded to 12 KB;
   memory first, then `source-map-*` docs, then other knowledge newest-first; clipped items are
   noted inside the block so the model knows to read the full file), which `testcaseGen.ts`
   injects **into the prompt itself** (reliable regardless of what files the model opens) — and passes the
   **same block to `groundTestcases`**. Empty folders → empty block (no-op).

**Test-case generation reads the SOURCE CODE.** `generateTestcaseVersion` now ALWAYS runs `claude -p` with
`cwd = project.rootPath` so the model can read the project (and its `CLAUDE.md`). Tooling by mode:
- **no live app** → `--allowedTools Read Grep Glob --strict-mcp-config` (read-only file tools, MCP skipped for
  fast startup; the draft can't modify the repo). `--allowedTools` is variadic, so it MUST be followed by a
  flag (`--strict-mcp-config`) before the trailing prompt positional, or the prompt is swallowed as a tool name.
- **live app URL** → `--permission-mode bypassPermissions` (loads `.mcp.json` for the Playwright browser; can
  also read source). Budgets bumped (reading source costs more): md `1.50` / csv `2.50` / live-app `3.00`.
The prompt tells the model to locate & read the real implementation first (true field names, validation,
states, branches, roles) and reconcile ticket-vs-code; `project.sourcePath` (root itself, or `<root>/source`)
is surfaced as a relative hint and threaded through `routes/ai.ts` + `testcaseJobs.ts` (`job.sourcePath`).
Because the cases are now grounded in real code the auditor can't see, `groundTestcases` is called with
`sourceAware: true` — it then only fixes clear contradictions/fabrications and never strips a detail merely
because the ticket doesn't restate it.

