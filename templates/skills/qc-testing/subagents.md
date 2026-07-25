# Subagent fan-out — one analysis subagent per AC

After Phase 4 you have, on disk: `screenshots/*.png` and `evidence/*.md`. Now you fan the
**analysis** out to subagents so each AC gets careful, focused judgment. This is where the
"many subagents" parallelism happens.

## Why this shape
- **One browser, one driver.** Only the main agent uses Playwright. If several subagents drove
  the browser at once they'd collide. So subagents **read files**, they do not browse.
- **Small, focused tasks suit a weak model.** Each subagent judges exactly one AC against the
  evidence — a narrow, well-defined job with a strict output format.

## How to launch (parallel)
- Use the **Agent tool**, `subagent_type: general-purpose`, **one call per AC** (or per
  AC-group — see cost note).
- Put **all the AC subagent calls in a single message** so they run concurrently.
- If there are many ACs, you may batch (e.g. 4–6 at a time) to keep things manageable.
- Optionally also spawn **one extra "cross-screen consistency" subagent** (see bottom) that
  checks things spanning ACs (consistent date formats, consistent terminology, no red-flag
  tokens anywhere).

### Cost vs. granularity (important on a free / weak model)
Each subagent costs ~15–25k tokens. One-per-AC is the most focused but the most expensive.
To save budget without losing rigor:
- **Group ACs that share the same screen/evidence into one subagent** (e.g. AC2 + AC3 both use
  the assign dialog → one subagent judging both). Give it both ACs and the same evidence files.
- Keep ACs that need careful, separate judgment (the big behavioral ones) on their own.
- A reasonable default for a 6-AC ticket: 3–4 subagents (group the screen-sharing ones), launched
  in parallel. Scale up to one-per-AC when the user wants maximum thoroughness.

### Read the text first, the pictures only when needed (cost + accuracy)
The content inventory already holds every label, placeholder, button, option and message as
**text** — that is both cheaper and more exact than looking at a PNG. So instruct each subagent:
read the `evidence/*.md` files first and settle every Content and Functional row from them; open
a screenshot only for a **UI/Visual** row, or to confirm a finding it is about to report. Reading
every PNG "just in case" is the single most expensive mistake in this phase.

### Missing evidence → recapture (don't just report it)
If a subagent returns "Missing evidence", that is an instruction to the **main agent**: go back
to Phase 4, capture exactly what it asked for, and **re-run that subagent** with the new files.
Do **one** such re-capture round (Phase 6 caps it) — after that, an unresolved gap is reported
honestly as ⛔ Blocked with the reason. Only leave a missing-evidence gap in the final report when
it is a deliberately skipped mutation on shared data, an out-of-scope screen the QC hasn't
provided, or data that cannot be created non-destructively.

## What each subagent receives
Give it everything it needs to judge **without** the browser:
1. The **AC text verbatim**, including every exact expected string from the ticket.
2. The **test-case ids** this AC covers (`TC-01`, …) exactly as spelled in the ticket's test-case
   file, when the run has one — the verdict must be reportable per case id.
3. The **scenario matrix** for that AC (the Phase-2 table: happy / negative / boundary / state /
   implied rows). The subagent must return a verdict for **every row**.
4. The **file paths** to the relevant `evidence/*.md` (list these first) and `screenshots/*.png`
   for that AC.
5. The **expected behavior you derived from the implementation**, if you read the source in
   Phase 1 — stated as plain behavior ("the field accepts 1–50 characters and shows *X* above
   that"), never as file/function references. The subagent does **not** read code itself.
6. The **design/Figma link** if any (for UI comparison; tell it to compare only if it can open
   it, else verify content + internal consistency).
7. The **path** to `checklist.md` so it reads the file itself — do not paste the whole checklist
   into every subagent prompt; that duplicates the same 100+ lines N times.

## Prompt template (fill the «slots»)

```
You are a QC analyst. Judge ONE acceptance criterion as a black-box tester. You may ONLY use
the evidence files listed below — do NOT open a browser and do NOT go read the application's
source code. Never mention code, app files, functions, or line numbers in your output.

TICKET: «ticket name / id»
ACCEPTANCE CRITERION (verbatim):
«paste AC text + every exact expected string: labels, placeholders, button text, options,
 messages, formats, counts, ordering»

TEST CASES COVERED (report a verdict per id): «TC-01, TC-02» or «none — bug ticket»
EXPECTED BEHAVIOR CONFIRMED BY THE MAIN AGENT (treat as authoritative, phrased as behavior):
«e.g. "the note field accepts 1–50 chars; over that it shows 'Maximum 50 characters'"» or «none»

SCENARIO MATRIX (judge EVERY row):
«paste the Phase-2 matrix table for this AC: # | class | concrete case | expected | evidence»

DESIGN REFERENCE (optional): «figma link or "none">
EVIDENCE FILES:
- content inventory (READ THESE FIRST — they are the text of the screen):
  «testing/test-result/<ticket-slug>/evidence/<screen>.md», «...»
- screenshots (open ONLY for a UI/Visual row, or to confirm a finding):
  «testing/test-result/<ticket-slug>/screenshots/ac4-...png», «...»
QC CHECKLIST (apply all relevant items): read the file at «.claude/skills/qc-testing/checklist.md».

DO:
1. Read the content-inventory files. Settle every Content and Functional row from that text;
   open a screenshot only for a UI/Visual row or to confirm a finding you are about to report.
2. Judge **every scenario row** in the matrix — happy, negative, boundary, state, and implied.
   The happy path passing is NOT enough; a failing negative/boundary/state row means the AC
   does not pass.
3. Check three layers per scenario — Functional (does the behavior work as shown in the
   evidence), Content (every visible string matches the expected text EXACTLY — spelling,
   casing, wording, placeholders, option lists, formats), UI/Visual (layout, alignment,
   spacing, color, icons, and the states present in the screenshots).
4. For any mismatch, record: layer, expected (quote it), observed (quote it), severity
   (High/Medium/Low per the checklist), and the screenshot filename that proves it.
5. If the evidence is insufficient to judge a scenario row, say exactly what extra screenshot or
   state is needed (status Blocked for that row) — do NOT guess.

RETURN STRICTLY THIS MARKDOWN (no preamble, no closing commentary, under 400 words):

### «ACx» — «short title» — STATUS: Passed | Passed-with-issue | Failed | Blocked | Not Tested
Reason: «one line»
Case verdicts: «TC-01 → Passed; TC-02 → Failed» (omit this line if there are no test-case ids)
Scenario results:
- «#» «class» «concrete case» → Passed | Passed-with-issue | Failed | Blocked | N/A(«why») — «evidence file»
- (one line per matrix row)
Findings:
- [«Functional|Content|UI»] [«High|Medium|Low»] Expected: "«…»" | Observed: "«…»" | Evidence: «file.png»
- (one bullet per finding; write "none" if no findings)
Evidence reviewed: «list the files you actually read»
Missing evidence (if any): «what else to capture»
```

## After the subagents return
1. Collect each subagent's block.
2. **Validate**: every Failed / Passed-with-issue finding must name a screenshot that exists. If
   one doesn't, either you already have a fitting screenshot (fill it in) or go back to Phase 4,
   capture it, and re-run just that subagent. Drop any finding that cannot be evidenced.
3. Carry the verdicts into Phase 6 (aggregate) → Phase 7 (write `report.md` + `issues.md`).
4. Renumber findings globally as ISSUE-1, ISSUE-2, … in `issues.md`; reference them from the
   report's Actual column, and carry each `Case verdicts:` line into the report's per-case table
   using the same ids.

## Optional: cross-screen consistency subagent
One extra subagent, given ALL `evidence/*.md` files, asked to check things no single-AC agent
sees:
- date/number/currency formats are consistent across screens;
- the same concept is named the same everywhere (no "Expired Date" vs "Category" drift);
- no red-flag tokens anywhere (`undefined`, `null`, `NaN`, `{Placeholder}`, raw enum codes,
  `lorem`, `TODO`);
- terminology matches the ticket's glossary.
Return findings in the same bullet format; fold them into the issues list.

## Fallback (if subagents are unavailable or unreliable)
If you cannot spawn subagents, do the SAME analysis yourself, **one AC at a time**, reading the
same evidence files and producing the same structured block per AC before writing the report.
The structure matters more than who runs it.
