---
name: system-style-ui
description: >-
  Apply the QC Portal's System-Style UI design language (inspired by Google's
  Antigravity site) when building or restyling any web/ page or component:
  Google Sans Flex/Code typography, large radii, pill buttons, hairline
  low-contrast borders, and flat tinted surfaces instead of heavy shadows. Use
  whenever creating a new page, redesigning an existing one, or asked to make
  the UI match the "system style" / Antigravity look.
---

# System-Style UI

A clean, neutral, large-radius, hairline-bordered design language inspired by Google's Antigravity
site (`antigravity.google`). It layers on top of the project's existing slate `oklch` shadcn tokens —
**keep using the semantic tokens** (`bg-card`, `border-border`, `text-muted-foreground`, `bg-primary`,
`bg-foreground`); this skill governs *shape, font weight, and elevation*, not new colors.

**Canonical reference implementation:** `web/src/pages/McpPage.tsx`. When unsure how something should
look, copy the pattern there.

## Foundations (already wired — do not re-add)

- **Fonts** loaded once in `web/index.html` via a single Google Fonts `<link>`, and mapped to
  `--font-sans` (`"Google Sans Flex", "Google Sans", …`) and `--font-mono` (`"Google Sans Code", …`)
  in `web/src/index.css`. Use Tailwind `font-sans` / `font-mono` (the defaults) — never hardcode a
  family.
- The Flex **`wght` axis is requested `300..700`**, so `font-medium` (500), `font-semibold` (600), and
  `font-bold` (700) are real weights. ⚠️ Never narrow it back to `400..500` — the browser would
  synthesize faux-bold (ugly heavy `font-semibold`). If headings look too heavy, the font CSS is being
  served from a stale cache → hard-reload (Cmd+Shift+R), don't change the weight class.

## The recipe

Apply these consistently. Compose with `cn(...)`; use semantic tokens, never raw hex.

### Radii — go large
- Primary surfaces / cards: **`rounded-3xl`** (24px)
- Secondary surfaces, context/header bars, icon chips: **`rounded-2xl`** (16px) or `rounded-xl` (12px)
- Inline pills (path chips, key previews, toggles): **`rounded-xl`**
- Buttons: **`rounded-full`** (pill) — every button, including disabled/loading states

### Borders & elevation — flat, not shadowed
- Hairline, low-contrast border: **`border-border/60`**, strengthening to `border-border` only on hover.
- **No resting shadow** — use `shadow-none` on cards.
- Convey depth with a **tinted surface** (`bg-muted/60`) and a subtle hover lift:
  `transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm`.

### Marks & icons
- Icon badges are **high-contrast solids**: `rounded-2xl bg-foreground text-background` (a black chip
  with a light glyph). Do **not** use gradient chips (`bg-gradient-to-br from-primary/15 …`).
- Inner/neutral chips: `rounded-xl border border-border/60 bg-muted/60 text-muted-foreground`.
- Icons from `lucide-react`, typically `size-4`/`h-4 w-4` inside a `size-9`–`size-11` chip.

### Buttons
- All `rounded-full`. Primary stays the near-black `bg-primary` (matches Antigravity's black button).
- Interaction polish: `transition-all duration-200 active:scale-[0.98]`; `Loader2` + `animate-spin`
  for pending labels.

### Typography
- Headings: `font-semibold tracking-tight` (true 600 now). Body via tokens; secondary text
  `text-muted-foreground`.

### Color accents
- Status palette is fixed: emerald = ok/connected, amber = pending/warning, red/`destructive` = error.
- Reserve a blue accent (`#3279F9`-like) for *sparing* emphasis only; default everything to neutral.

## Canonical card pattern

```tsx
<Card className="flex h-full flex-col gap-3 rounded-3xl border-border/60 p-5 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm">
  <div className="flex items-center gap-3">
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground">
      <Icon className="h-4 w-4" />
    </span>
    <div className="min-w-0 leading-tight">
      <div className="text-sm font-semibold tracking-tight">Title</div>
      <div className="truncate text-xs text-muted-foreground">Subtitle</div>
    </div>
  </div>
  <Button size="sm" className="mt-auto w-full rounded-full transition-all duration-200 active:scale-[0.98]">
    Action
  </Button>
</Card>
```

## Header mark pattern

```tsx
<span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
  <Icon className="size-5" />
</span>
```

## Do / Don't

- ✅ `rounded-3xl` cards, `rounded-full` buttons, `border-border/60`, `shadow-none` + hover lift.
- ✅ Solid `bg-foreground text-background` marks; semantic tokens; `cn(...)`.
- ❌ Small radii (`rounded-md`/`rounded-lg`) on cards, square buttons, resting `shadow-sm`/`shadow-md`.
- ❌ Gradient icon chips, raw hex colors, hardcoded font families, narrowing the Flex `wght` axis.

## Workflow when restyling a page

1. Read the page; identify cards, chips, buttons, context bars, banners.
2. Bump radii (cards → `rounded-3xl`, chips → `rounded-2xl`/`xl`, buttons → `rounded-full`).
3. Replace borders with `border-border/60` (+ hover strengthen); drop resting shadows, add the hover lift.
4. Convert gradient marks to solid `bg-foreground text-background`.
5. Keep all logic/handlers/data flow untouched — these are className-only changes.
6. Verify with `npm -w web run lint` (the page should add no new errors) and a hard-reload in the browser.
