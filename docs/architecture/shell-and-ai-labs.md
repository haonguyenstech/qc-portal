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
- **The footer is ONE card in three tiers** (`VersionFooter` + `AutoAgentStatusIndicator`):
  version, health, links. Two earlier shapes failed the same way — they were a PILE. First three
  bordered cards (~150px, louder than the nav above them), then three loose rows, which fixed the
  height but left mono version text, a tiny green word and an icon button floating with nothing
  holding them together. What makes it read as designed is the grouping: a hairline box on a
  tinted surface, the version + re-check button as its header, two status lines beneath it, and
  Docs / Releases split 50/50 on their own hairline at the bottom.
  - **Both status lines are the same KIND of statement in the same shape** — icon, one sentence —
    so `Auto Agent · Connected` and `Up to date` scan as one health block rather than two widgets.
  - **Healthy is QUIET: the icon carries "fine", the text stays `muted-foreground`.** Two green
    sentences stacked read as a success banner, and then a real drop no longer stands out. Only a
    problem gets the coloured sentence (`status.ok` for Auto Agent, amber for an update).
  - **An available update tints the whole card amber** and adds the labelled `Update now` button;
    it is the one action here, and an icon-only version of it would be a bare arrow that
    reinstalls the app.
  - **"Last checked 8m ago" lives in the refresh button's tooltip**, where it was already
    duplicated. The collapsed rail's footer is unchanged — icons with tooltips, since 72px has no
    room for a label.
- **The project picker is a Popover, NOT a `Select`** (`ProjectPicker`), and that is the whole
  reason it was rebuilt: on a real machine this list is 10+ repos, and a `Select` cannot hold a
  text input — Radix routes every keystroke to its own typeahead, so a filter box inside one eats
  itself. With a popover the panel can carry what actually picks a project apart:
  - **the filter matches NAME *and* PATH** — two repos called `web` are told apart only by where
    they live — and the header shows `matches/total`;
  - **the folder path under every name**, ellipsised in FRONT (`shortPath`): `truncate` cuts the
    tail, which is backwards for a path where every entry starts `/Users/<me>/…` and the end is
    the part that says which repo. The full path stays in the `title`;
  - **pinned projects first**, and the state that decides whether a run will work at all —
    `missing` (red) when the folder is gone, `setup` (amber) when the skill / `.mcp.json` /
    `CLAUDE.md` trio is incomplete. Picking a dead project and learning it from a failed run is
    the failure this replaces;
  - **hand-rolled keyboard**: ↑/↓ walk the FILTERED list, Enter picks, Escape closes (Radix). The
    cursor is an index into that flattened list, so it is re-aimed at the first match whenever the
    query changes and clamped whenever the list shrinks — otherwise Enter picks whatever happens
    to sit under a stale index.
  The trigger keeps the initial-chip + name, but its second line is now the PATH, not "10
  projects" (the count moved into the panel): which folder a run will spawn in is the useful fact.
  The collapsed rail is unchanged — one square that expands the rail, because a 72px column has
  nowhere to put a filter.
- **Collapsing the rail does not cost you the labels: hovering it PEEKS.** A collapsed rail trades
  every label for width, and the usual click-to-expand/click-to-collapse makes you pay for one
  label with two clicks and a reflow of the page you were reading. So hovering the collapsed rail
  opens it as an OVERLAY (`peek` in `AppShell`): `<aside>` is `fixed` and `<main>`'s padding
  follows `collapsed` ALONE, so the peek floats over the content and **nothing on the page moves**
  — that is the whole trick, and it breaks the moment `main`'s padding is made to follow the peek.
  The parts that took measuring:
  - **`showExpanded = !collapsed || peek` is what every child reads**, not `collapsed` — brand
    block, project picker, filter, nav, footer. Miss one and the rail is 240px wide with an
    icon-only column inside it.
  - **Both edges are delayed** (~120ms in, ~180ms out): without the first, a pointer crossing the
    rail on its way elsewhere flashes it open; without the second, clipping a corner of the panel
    on the way to a row snaps it shut.
  - **A portalled menu keeps it open.** The project picker's panel lives outside the aside, so
    moving into it fires `mouseleave` and would yank the trigger away mid-click; `menuOpenRef`
    blocks the retreat while it is open. That flag is a **ref**, not state — it is read by the
    close path that the same handler triggers, and as state it read stale, leaving the rail
    peeked open for ever after Escape.
  - **On menu close the retreat is always SCHEDULED**, never conditioned on "is the pointer still
    over the rail?" (coordinates we don't have, and a `hovering` flag went stale exactly when it
    mattered). Scheduling is self-healing: if the pointer really is over the rail, the browser
    re-dispatches `mouseenter` when the panel unmounts and that cancels the pending close; if it
    is not, the rail retreats and one pixel of movement brings it back. Sticking open is the
    failure to avoid, not retreating a moment early.
  - **While peeking, the toggle says "Keep expanded"** (it pins: `setCollapsed(false)`), because
    "Expand sidebar" on a rail that is visibly open reads as a no-op. ⌘/Ctrl+B still does both.
- **The expanded rail is an ACCORDION, and its rows are short.** 23 pages in six groups did not
  fit a 13" laptop, so: rows are `h-8` with a 13px label (the icon-only rail keeps its 40px
  squares — there the square IS the touch target), groups sit 6px apart instead of 16px, and each
  group header (`NavGroup`) folds. Folded state is `qc.sidebar.foldedGroups` in localStorage
  (`useFoldedNavGroups`) — a third, independent thing from `qc.sidebar.collapsed` (whole rail to
  icons) and `qc.sidebar.hidden` (pages switched off in Settings): "not right now" vs "make it
  narrow" vs "I never use this". Three deliberate details:
  - **A folded group still renders the row that owns the current URL**, and tints its header —
    the page you are standing on must never vanish from the rail, or a fold reads as "I got
    logged out of this section".
  - **Fold-all rides on the search row**, not a row of its own: a dedicated toolbar would spend
    the vertical space the folding exists to win back. It flips to expand-all once every group
    is shut.
  - **Only the expanded rail folds.** The icon-only rail has no headers to click, so it keeps the
    hairline dividers, and the fade masks are re-measured on fold (`updateFade`) or the top/bottom
    gradients claim an overflow that is no longer there.
- **The page list itself lives in `lib/nav.ts`, not `App.tsx`** — `navGroups` plus the show/hide
  state, because **Settings -> Sidebar draws its switches from the same array** and importing it
  back out of `App.tsx` would be a cycle (App imports the page, the page imports App). Add a page
  in one place and it appears in the rail AND in Settings.

  Hiding a row (`useHiddenNav`, `qc.sidebar.hidden` in localStorage, `SidebarMenuCard` in
  `ProjectsPage.tsx` under `?tab=sidebar`) is a per-MACHINE VIEW preference: nothing is written to
  the repo, the DB or the project, so two engineers on the same project keep their own rails.
  Three things that are deliberate:
  - **It removes the ROW, never the route.** Every `<Route>` stays mounted, so a hidden page is
    still reachable by URL and from links on other pages — this is a shorter rail, not a feature
    flag, and must not become one (a "disabled" page that still answers is worse than either).
  - **`/settings` cannot be hidden** (`NAV_ALWAYS_VISIBLE`) — it is where hiding is undone, so
    hiding it would be a one-way door out of the UI. The filter and the rail both read
    `visibleNavGroups()`, so a hidden page doesn't come back through ⌘K, and a group whose every
    row is off disappears entirely (the Settings card labels that "group hidden", or it reads as
    a bug).
  - **The write fires a `qc:nav-hidden` window event.** The rail and the Settings card are on
    screen together, and the `storage` event only fires in the OTHER tabs — without it a toggle
    would land on the next reload. `readHiddenNav()` also drops entries for routes that no longer
    exist, so a renamed page can't stay hidden by a stale key.
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

