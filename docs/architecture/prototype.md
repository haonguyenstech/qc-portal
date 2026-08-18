<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Prototype page (requirement → working screen → test cases)

**`/prototype` (`PrototypePage.tsx`, `routes/prototype.ts`)** — a Claude-style chat that turns a
request into a **self-contained HTML/CSS prototype** (Tailwind Play CDN), streamed live and rendered
in a sandboxed iframe with device frames (desktop/laptop/tablet/mobile + rotate), a Code view, PNG
capture, and reference-image attachments. Each prototype is a conversation stored per project at
`testing/prototypes/<slug>.json`; follow-ups refine the SAME document. It is a **QC/BA instrument**,
not just a mock-up generator — these things make it that:

1. **Build from a ticket.** A prototype can be linked to an already-crawled ticket **folder**
   (`ticketFolder`, possibly nested `PARENT/CHILD` — the same key `/testcases` uses, NOT the display
   id). `readLinkedTicket` reads that folder's `ticket.md` + `comments.md` (capped at
   `MAX_TICKET_CHARS`) plus `ticket.json` for the display id/title, and the prompt makes the ticket
   the **scope**: real names verbatim, the states it implies, and an inline amber "Assumption" note
   where it's ambiguous. The picker (`TicketLinkDialog`) reuses the shared `buildCrawledTree` +
   `CrawledTicketRow`, so it nests and groups like every other crawled-ticket selector.
2. **Project- and source-grounded.** `readProjectContext(root)` (Knowledge + Memory) is injected into
   **every** build — same block `testcaseGen.ts` uses, so prototypes speak the product's terminology.
   **"Match our app"** (`matchApp`, opt-in per build) additionally runs the build with
   `cwd = project.rootPath` and READ-ONLY file tools so the model takes the real design language,
   field labels and messages from the codebase (steered by the `source-map-*` knowledge doc first).
   Tool-enabled builds get `GEN_TIMEOUT_SOURCE` instead of `GEN_TIMEOUT` and the prompt time-boxes
   reading hard. `toolArgsFor()` names the mutating tools in **`--disallowedTools`** as well as
   omitting them from `--allowedTools` — verified: allow-list-only still makes the model *attempt*
   `Write`/`Bash` (the CLI denies them, but the attempts spam `⚙ Write` into the build log). Both
   flags are variadic, so each MUST be followed by another flag before the trailing prompt positional.
   A build **must never modify the repo**; don't weaken this.
3. **Revision history (non-destructive refines).** Every build/refine **appends** a `PrototypeVersion`
   (`{n, html, prompt, summary, at, model}`) via `pushVersion` — `prototype.html` always mirrors the
   newest/restored entry. Capped at `MAX_VERSIONS` (numbers stay monotonic after trimming, so a number
   is never reused). `migrate()` backfills a pre-versioning document as v1 on read, so old prototypes
   gain history for free. **`toPublic()` strips every revision's HTML** from list/detail responses
   (they'd otherwise be ~12× larger); a revision's HTML is fetched on demand from
   `GET /:slug/versions/:n`. The UI shows a revision bar (select + Compare, and an amber "viewing an
   older revision" state with Restore) and a side-by-side `CompareDialog` of two live iframes.
   `POST /:slug/restore` **appends** the restored document as a new revision rather than rewinding,
   so a restore is itself undoable. This is the guard against a refine wrecking an agreed screen.
4. **Prototype → test cases.** `POST /:slug/testcases` calls `generateTestcaseVersion` with the new
   `prototypeUi: { name, html }` option (capped at `MAX_PROTOTYPE_CHARS`), which adds a prompt block
   treating the markup as **OBSERVED UI** — exact labels, fields and constraints, states, validation
   messages — while **the ticket still owns scope** (a disagreement becomes a case/note, not extra
   coverage). Requires a linked ticket, because versions are written under
   `testing/tickets/<folder>/testcases/`. It auto-reads the saved `testing/templates/testcase.md`
   (`readTestcaseTemplate`, mirroring verifyDesign's `readChecklist`) so output matches the team format.
   **The route and `generateTestcasesFromPrototype` stay; the page's "Test cases" button and its
   dialog are gone** — drafting cases belongs on `/testcases`, where the template, rules, model and
   ticket selection all live, and a second half-featured entry point on this page only split that.

5. **The project design system (`designSystem.ts`).** The product's visual language is extracted
   ONCE — palette, type scale, spacing/radii, component shapes, layout shell, and the wording
   conventions for labels/statuses/messages — into `testing/knowledge/design-system.md`, and every
   later build inherits it. This is the fix for `matchApp` being slow, expensive, and inconsistent
   (re-derived per build, so two prototypes of the same product didn't look like siblings). Because
   it's a knowledge doc it needs **no prompt plumbing for the content** — `readProjectContext`
   already injects it; `buildPrompt` only adds a directive saying the doc is **authoritative and
   overrides the generic design guidance and any style preset**. When both the design system and
   `matchApp` are on, the source-reading block flips to "the look is already described — spend your
   reads on field names, validation and business logic instead". `projectContext.ts` `PRIORITY_DOCS`
   packs it (with `source-map-*`) before all other knowledge so it can't be crowded out of the
   budget. Routes `GET`/`POST /api/prototype/design-system` — both MUST stay **above `GET /:slug`**,
   which would otherwise swallow the path. Driven from the `Design system` pill in `GroundingBar`
   → `DesignSystemDialog`; extraction takes ~60-90s on haiku and is a one-off.
6. **Comment mode — click the element, don't describe it.** `PICKER_SCRIPT` is injected into the
   **rendered** `srcDoc` only (`withPicker`, never into the stored document) and highlights whatever
   the cursor is over; a click is swallowed (`preventDefault` on `click` *and* `submit`, so the
   prototype can't act on it) and `postMessage`s the element's `label` (`<button> "Save changes"`)
   plus a shallow CSS-ish `path` to the parent. The iframe is a **null origin**, so `e.origin` is
   useless — `PreviewPane` validates the payload **shape** (`source: 'qc-prototype'`) instead, and
   only listens while comment mode is on. Pins are client-side state; `commentsToPrompt` sends them
   as ONE refine that names each target and says to leave everything else alone. The iframe `key`
   includes comment mode so toggling remounts with/without the picker.
7. **Open questions → decision ledger (the BA half).** Every build emits a third meta comment
   `<!-- QUESTIONS: … -->`: up to `MAX_QUESTIONS` **genuine requirement ambiguities** it had to guess
   about — explicitly NOT visual taste, and never something already settled. `QuestionsPanel` shows
   them as an amber card; answering one sends `decisions: [{q, a}]` with the refine, and
   `applyDecisions` folds it into `prototype.decisions` (a re-answer **replaces** the old one, and the
   matching open question is dropped so it isn't re-asked mid-build). `buildPrompt` injects the
   ledger as **CONFIRMED DECISIONS — treat as requirement, don't ask again**. Restore clears
   `questions` but deliberately **keeps `decisions`**: an answered requirement question stays
   answered regardless of which revision is on screen.
   The open list **accumulates** via `mergeQuestions` (capped at `MAX_OPEN_QUESTIONS`) rather than
   being replaced by each build's fresh list — verified: answering one question, or any refine that
   raises nothing new, would otherwise silently wipe every question the BA hadn't got to yet.
   Anything already in the ledger is filtered out, so the only ways a question leaves the list are
   being answered or `POST /:slug/questions/dismiss` (the × in `QuestionsPanel`) — a list that
   accumulates needs an explicit way to clear one, or it nags forever.
8. **Export.** `downloadHtml` saves the document on screen as a standalone `.html` (named
   `<prototype>-v<n>.html`) — client-side only, no route. A single self-contained file is how a BA
   hands a screen to a stakeholder or attaches it to a ticket.

Both grounding choices persist on the prototype, so a follow-up refine inherits them. In the client,
`pendingTicket`/`pendingMatchApp` use `undefined` = "inherit what's stored" vs `null` = "explicitly
unlinked" — that distinction is what lets a refine stay requirement-bound without re-picking the
ticket every turn. `POST /stream` is the live path (SSE: `delta` / `log` / `done` / `error`);
`POST /` and `POST /:slug/message` are the buffered equivalents and must stay in step with it —
including the `questions` / `decisions` handling.

`buildContextFor(project, {ticket, matchApp, decisions})` is the single place that assembles a
build's grounding (ticket + knowledge block + source-reading + design-system flag + ledger), so all
three entry points ground identically. Prefer extending it over re-deriving context at a call site.

