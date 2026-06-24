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

### Missing evidence → recapture (don't just report it)
If a subagent returns "Missing evidence", that is an instruction to the **main agent**: go back
to Phase 4, capture exactly what it asked for, and **re-run that subagent** with the new files.
Only leave a Partial-for-missing-evidence in the final report when the gap is a deliberately
skipped mutation on shared data or an out-of-scope screen the QC hasn't provided.

## What each subagent receives
Give it everything it needs to judge **without** the browser or the code:
1. The **AC text verbatim**, including every exact expected string from the ticket.
2. The **scenario matrix** for that AC (the Phase-2 table: happy / negative / boundary / state /
   implied rows). The subagent must return a verdict for **every row**.
3. The **file paths** to the relevant `screenshots/*.png` and `evidence/*.md` for that AC.
4. The **design/Figma link** if any (for UI comparison; tell it to compare only if it can open
   it, else verify content + internal consistency).
5. The **full text of `checklist.md`** (paste it in, or tell it to read the file at its path).

## Prompt template (fill the «slots»)

```
You are a QC analyst. Judge ONE acceptance criterion as a black-box tester. You may ONLY use
the evidence files listed below — do NOT open a browser and do NOT read source code. Never
mention code, files-of-the-app, functions, or line numbers in your output.

TICKET: «ticket name / id»
ACCEPTANCE CRITERION (verbatim):
«paste AC text + every exact expected string: labels, placeholders, button text, options,
 messages, formats, counts, ordering»

SCENARIO MATRIX (judge EVERY row):
«paste the Phase-2 matrix table for this AC: # | class | concrete case | expected | evidence»

DESIGN REFERENCE (optional): «figma link or "none">
EVIDENCE FILES (read these with the Read tool — PNGs show visually, .md is text):
- screenshots: «testing/<ticket>/screenshots/ac4-...png», «...»
- content inventory: «testing/<ticket>/evidence/<screen>.md»
QC CHECKLIST (apply all relevant items): read «testing/.../checklist.md» (or pasted below).

DO:
1. Read every evidence file.
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

RETURN STRICTLY THIS MARKDOWN (no preamble):

### «ACx» — «short title» — STATUS: Pass | Fail | Partial | Blocked
Reason: «one line»
Scenario results:
- «#» «class» «concrete case» → Pass | Fail | Partial | Blocked | N/A(«why») — «evidence file»
- (one line per matrix row)
Findings:
- [«Functional|Content|UI»] [«High|Medium|Low»] Expected: "«…»" | Observed: "«…»" | Evidence: «file.png»
- (one bullet per finding; write "none" if no findings)
Evidence reviewed: «list the files you actually read»
Missing evidence (if any): «what else to capture»
```

## After the subagents return
1. Collect each subagent's block.
2. **Validate**: every Fail/Partial finding must name a screenshot. If one doesn't, either you
   already have a fitting screenshot (fill it in) or go back to Phase 4, capture it, and re-run
   just that subagent. Drop any finding that cannot be evidenced.
3. Carry the verdicts into Phase 6 (aggregate) → Phase 7 (write `report.md` + `issues.md`).
4. Renumber findings globally as ISSUE-1, ISSUE-2, … in `issues.md`; reference them from the
   report's Actual column.

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
