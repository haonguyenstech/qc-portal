<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Shell chrome — theme, page search, and the app mark

- **Light/dark is a real toggle** (`components/ThemeToggle.tsx` + `lib/theme.ts`), stored in
  localStorage as `qc.theme` and falling back to the OS setting until the engineer picks one. The
  class goes on `<html>` (Tailwind v4's dark variant is `.dark *`) and is applied by an **inline boot
  script in `web/index.html` before first paint** — without it the app renders light and snaps to dark
  a frame later. That script and `theme.ts` read the same key: change one, change the other. The hook
  seeds its state by reading the class off the DOM, so mounting can't flash the wrong theme.
- **The sidebar has a type-to-filter** (`NavFilter`, ⌘/Ctrl+K; ⌘/Ctrl+B collapses the rail) matching
  on the page label **and** its group name, so "testing" finds the whole Testing group. Both shortcuts
  are skipped while typing in a field so they can't hijack a page's own input, and Enter opens the
  first match. Collapsed, the input is replaced by a button that expands the rail and focuses it.
- **`AppLogo` is a solid with negative space** — a scalloped certification seal with the check knocked
  out through a `<mask>`, not a lucide-weight line drawing (a line icon reads as one item borrowed
  from an icon set, and hairlines dissolve at 16px). The mask id comes from `useId` because two can
  legitimately mount at once. **Its geometry is duplicated in `web/public/favicon.svg`** (plus the PNG
  fallback and the apple-touch icon) — change one, change all of them.

## QC AI Labs (curated shelf of AI tools)

**`/ai-labs` (`AiLabsPage.tsx`, "QC AI Labs" under the sidebar's Tools group)** — the one **reading**
page in the portal: which AI products are worth a QC engineer's time, what each is for, and where it
doesn't pay off. No server route, no query, no project scope — it renders a constant.

- **Two routes, both bare:** `/ai-labs` (`AiLabsPage`, the shelf) and **`/ai-labs/:id`
  (`AiLabDetailPage`, one tool)**. A card is a LINK, not a dialog — the detail page carries the
  **install and usage guide**, and a guide with commands in it is something people leave open beside
  a terminal, bookmark, and send to a teammate, none of which a modal can do. An unknown `:id`
  renders a "not on the shelf" card rather than throwing; the URL is hand-editable.
  Shared data lives in **`lib/ai-labs.ts`** (types + `CATALOG` + `findTool`), the dark surface and
  the small shared pieces in **`components/ai-labs-ui.tsx`** (`LabShell` also owns `document.title`).
- **`install` / `usage` are the reason the detail page exists** — a recommendation nobody can act on
  is a link dump. Every command in them was RUN on a machine before it was written down (the
  `@anthropic-ai/claude-code` + `@saigontechnology/auto-agent` pair, `auto-agent-ai login`, the
  unpacked-extension steps). Keep it that way, keep one idea per step, and keep the vendor link
  visible so a drifted command has somewhere to go. Step bodies take `` `code` `` and `**bold**`
  through a 10-line `renderInline` — don't pull in react-markdown for two paragraphs.
- **It renders OUTSIDE the shell.** `App.tsx` is a two-branch router — `/ai-labs` → the page bare,
  `*` → `AppShell` (sidebar, bell, page padding, every other route). The page is its own destination
  and the portal's chrome around it filed it as just another settings screen. The **job watchers sit
  in `App`**, above both branches, so a crawl or test-case job finishing still notifies while you're
  reading here — they render nothing, so the bare page pays nothing for them. The only tie back is one
  ← in its header (detail → shelf, shelf → portal): a destination with no way out is a trap.
- **It carries its own always-dark theme, in literal colours, on purpose.** Semantic tokens would make
  it follow the portal's light/dark setting, and the page is deliberately not a portal surface. This
  is the ONE place ignoring the token system is correct — don't "fix" it back to
  `bg-card`/`text-muted-foreground`, and don't copy its palette into a page inside the shell.
- **It is PLAIN, and that was a correction.** The first version had drifting aurora, an animated
  gradient headline, cursor-tracked spotlights, glowing card edges, a stats row and a fit dial; over a
  shelf of two entries that read as decoration around very little ("xến xúa" was the verdict), so all
  of it came out — along with the search box, category rail, sort control and shortlist, which were
  machinery for a catalog that doesn't exist yet. What's left is the writing on a quiet dark surface.
  If something here seems to need an animation to hold attention, the fix is better copy.
- `ui/dialog.tsx` gained an **`overlayClassName`** prop for this page (the default 50% black scrim
  doesn't sit far enough back from a dark surface). Additive — every existing dialog is unchanged.
- **`CATALOG` is a hand-written constant, on purpose.** There is no vendor feed to fetch, and a
  curated shelf is only worth reading *because* a human picked the entries. Adding a tool = one
  object (pitch, category, fit, flags, `what`, `useCases`, `strengths`, `limits`, url). Keep
  `useCases` job-shaped ("reproduce a bug report step by step"), not feature-shaped — the jobs are
  what make it a shelf rather than a link dump.
- **It holds exactly two entries** — Claude Code and **AI Form Filler** (our own Chrome MV3
  extension, `builtHere: true`, repo `haonguyenstech/ai-form-filler`) — because the shelf is a
  recommendation, not an inventory. Grow it past a handful and search/filter/sort earn their way
  back; until then don't add controls for two cards.
- **The fit score is an OPINION and the page says so** — it renders as `QC fit 96/100 · our take`,
  and the footer repeats it. It used to be a gradient ring; a dial implies an instrument took a
  reading. Don't dress it up as data (no benchmark framing, no decimals, no leaderboard).
- **`limits` ("Watch out for") is not a disclaimer** — it's the half a vendor's own page omits, and
  the reason a reader trusts the shelf. Every entry has at least two.
- `inPortal` flags what this portal already runs on; `builtHere` flags what we wrote ourselves.

