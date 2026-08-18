<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Design Check page & project templates

**`/verify` (`VerifyDesignPage.tsx`, labeled "Design Check" in the sidebar)** — pick a crawled
ticket + paste its Figma link; `POST /api/ai/verify-design` (`server/src/verifyDesign.ts`) runs Claude
once in the project dir (tools enabled so it can open the design via Figma/Playwright MCP) and returns
structured `findings` bucketed into `match` / `mismatch` / `concern` / `unsure` / `discuss`, rendered as
grouped cards. Output shape is fixed by the prompt's JSON contract — don't reshape it into a template.

**Project templates (`/templates` → `ProjectSettingsPage.tsx`, `routes/templates.ts`)** — plain-text
files under `testing/templates/<key>.md`. The UI owns the catalog in `TEMPLATE_KINDS`; add a kind there
to expose a new upload slot. Current kinds:
- `testcase` — structure Claude matches when drafting test cases (a per-run upload on `/testcases` still overrides it).
  **Seeded on project creation**: `initializeProjectFolder` (routes/projects.ts) copies the template
  project's `testing/templates/testcase.md` when one exists, else the portal-bundled default
  (`templates/project-templates/testcase.md` via `bundledTemplateFile`), so a new project starts
  with a test-case template already in place. Never overwrites an existing file.
  The bundled default is the team's **common CSV template** (`ID,Feature,Test suite,Summary,
  Pre-condition,Steps,Expected result,Actual result,Priority,Status,Reference,Note` + sample rows).
  Note the file name stays `<key>.md` while the CONTENT is CSV — that's the existing design, not a
  mistake: `detectTemplateFormat` (testcaseGen.ts) / `looksLikeCsv` (CsvTable.tsx) decide the format
  from the first content line, and uploading a `.csv` on `/templates` has always been stored as
  `testcase.md`. So a generation against it writes a real `v<N>.csv`.
- **Bundled templates auto-update with the portal (`server/src/templateSync.ts`)** — the template a
  run actually reads is the project's copy, so without this a `qc-portal --update` would leave every
  project drafting against the old default forever. Same rule (and shape) as `skillSync.ts`:
  `reconcileBundledTemplates()` runs once at boot from `index.ts` and, per project × bundled key,
  compares `testing/templates/<key>.md` against the bundled master —
  missing → seed; identical → just fingerprint it (so the NEXT update is silent);
  identical to the fingerprint the portal recorded when it last wrote the file
  (`template_installs`, db.ts) → **refresh silently**; anything else → the engineer edited it, so
  **leave it alone** and log it as customized (`/templates` already offers "Reset to default").
  A copy matching an older shipped default counts as untouched via `LEGACY_DEFAULTS` (hashes of past
  bundled files) — fingerprinting only started with this module, so pre-existing copies have no row
  and would otherwise read as hand-edited; **append** the outgoing hash there whenever you change a
  bundled default. Route side: `PUT /:key` clears the fingerprint (now the user's), `POST /:key/reset`
  records it, and `DELETE /:key` writes the `TEMPLATE_ABSENT` sentinel so the next boot doesn't
  helpfully re-seed a template someone deleted on purpose. Project seeding only fingerprints the copy
  when it came from the bundled file, never from a template project's (possibly customized) one.
- `design-check` — the project's **standard Design Check checklist**. `verifyDesign.ts` injects it into
  the verify prompt as criteria the model must report a finding for (capped at 6 KB,
  `MAX_CHECKLIST_CHARS`). Resolution mirrors `/testcases`: a one-off file uploaded on `/verify` wins
  (`checklist` in the `verify-design` body → `checklistOverride`); otherwise the server auto-reads the
  saved `testing/templates/design-check.md` (key `CHECKLIST_TEMPLATE_KEY` via `readChecklist`). The page's
  Checklist upload (md/csv/xlsx, Excel→CSV in-browser, preview dialog) shows "Using project checklist"
  with Preview/Override when one is saved, exactly like the TestCase template upload.

