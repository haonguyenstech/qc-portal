<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Notes page (a scratchpad that lives with the project)

**`/notes` (`NotesPage.tsx`, `NoteEditor.tsx`, `routes/notes.ts`, `notesStore.ts`)** — Keep-style
cards for the things that aren't Knowledge or Memory: a checklist for today, a scratch reproduction,
a reminder before the next release. Knowledge/Memory are read by every AI run and are worth writing
carefully; **notes are not injected into any prompt**, which is exactly why the page can be casual.

- **One JSON document per project** at `testing/notes/notes.json` (notes + labels), written temp-file
  + rename so a crash can't leave a half-written file. `normalize()` tolerates anything malformed
  rather than throwing the page away, and the caps (500 notes / 200-char title / 100 KB body) are
  enforced in the store, not the UI. Routes: `GET /api/notes`, `POST /`, `PATCH /:id`, `DELETE /:id`,
  plus `POST`/`PATCH`/`DELETE /labels…` and `DELETE /trash` — which **must stay above `DELETE /:id`**,
  or a trash-empty is read as deleting a note with the id `trash`.
- **Archive and trash are flags, not deletions** (`archived` / `trashed`), so the sidebar's Archive
  and Trash views are filters over one list and a restore is a `PATCH`. Emptying the trash is the
  only destructive action, and it's behind a confirm dialog.
- **The editor is TipTap, lazily imported** — it plus lowlight is heavy and only the note dialog
  needs it, so `NoteEditor` is a `lazy()` behind a `Suspense`. Bodies are HTML; `lib/noteHtml.ts`
  `LOOKS_LIKE_HTML` tells a rich-text body from a legacy plain-text one so old notes keep rendering.
- **Editor and card share ONE typography block** in `index.css` (`.note-editor .tiptap` + `.note-body`),
  so what you type is what the card shows. The block-spacing selectors are deliberately **doubled**
  (`.note-body.note-body > * + *`) to out-specify the per-element `margin: 0` resets beneath them —
  a plain `>` selector lost on specificity and every paragraph after the first rendered with no gap
  (measured 0px between consecutive `<p>`, while `<ul>`, which has no reset, correctly got 11.25px).

