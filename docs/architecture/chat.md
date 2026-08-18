<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Chat page (ask Claude Code about the project)

**`/chat` (`ChatPage.tsx`, `routes/chat.ts`, "Chat" under the sidebar's Tools group)** — a plain
conversation with Claude Code. Every other AI surface here is a FORM (pick a ticket, pick a model,
press Generate); this is the one place a QC engineer can just ask ("why did run 14 fail?", "what
does this endpoint validate?").

- **Not the Terminal page's pty.** That runs the interactive TUI, whose ANSI redraw output is fine
  in xterm and unrenderable as chat bubbles. Chat runs `claude -p --output-format stream-json
  --include-partial-messages`, giving clean assistant text (streamed as `delta` frames) plus
  structured tool events. `cwd = project.rootPath`, so CLAUDE.md / Knowledge / Memory are in scope.
- **Multi-turn is the CLI's own session, not a replayed transcript.** `runClaudeStream` gained an
  `onSession` opt that reports the stream-json `init` event's `session_id`; it's stored on the
  conversation and passed back as `--resume <id>` next turn. **This is the whole reason a follow-up
  understands "it"** — don't replace it with prompt-stuffing. A `--resume` whose session the CLI no
  longer has fails outright, so the route **retries once as a fresh session** rather than losing the
  question. A session id is only adopted once a turn actually produced text.
- **The defaults are TERMINAL PARITY, and that was a correction.** Chat used to pin `sonnet` and
  `--allowedTools Read Grep Glob --strict-mcp-config`, and answered visibly worse than the Terminal
  page on the same question — the complaint that drove this. Three measured causes, all now fixed:
  - **Model.** `/terminal` runs a bare interactive `claude`, so it gets the CLI's own default
    (`claude-opus-5[1m]` on this machine); chat pinned `sonnet`. Same flags, same repo question:
    sonnet made 1 tool call and answered generically, opus made 2 and cited `dbQuery.ts:121`.
    So `model` gained the value **`default`, which omits `--model` entirely** — the only way to
    inherit whatever the user configured — and it is the new default. The named models stay for a
    deliberately cheaper turn. The transcript records what ANSWERED (`onModel` on `runClaudeStream`,
    from the `init` event), never the literal string `default`.
    **Changing the picker on an EXISTING conversation retires the CLI session** (`sessionModel`
    on the stored chat, compared at the top of every turn). `--resume` keeps a session on the
    model it was created with, and `default` passes no `--model` to override it — so a chat
    started on haiku went on answering with haiku after the picker was switched to Terminal
    parity, and the footer said so, correctly. The mismatch drops `sessionId` and replays the
    conversation through `recapBlock` on the same path a lapsed session takes, announced in the
    log for the same reason. Compare the **choice** (`'default'`, `'haiku'`), never the resolved
    id — that never equals the next turn's `'default'` and would restart the session every message.
    Chats saved before the field exists are seeded from the previous turn's `chat.model`, read
    **before** `chat.model` is overwritten with the new pick.
  - **Tools — THREE modes** (`toolArgs`), picked in the composer's mode menu and shown in the
    header badge and the hint strip. One table, `CHAT_MODES` in `ChatPage.tsx`, owns every label:
    the wording used to be inline ternaries in four places, which is how the same setting came to
    be called both "Fast mode" and "Full tools" on one screen.
    - `full` — **the default**, because it is exactly what `claude --dangerously-skip-permissions`
      — TerminalPage's launch line — runs under (`--permission-mode bypassPermissions`), and it
      drops `--strict-mcp-config` so the project's MCP servers load.
    - `write` (**Workspace write**) — the middle mode: the read tools plus
      `Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`TodoWrite` on the allow-list, plus
      `--permission-mode acceptEdits` so an edit is applied instead of waiting on a permission
      prompt that has no UI in a headless run — and `--strict-mcp-config` still ON, which is what
      makes it meaningfully narrower than `full`: no browser, no ClickUp, nothing outside the
      folder. It keeps read-only's ~1s start (no MCP servers to boot).
    - `read` — the cheap turn: Grep/Glob/Read only, no MCP, ~1s to first token instead of ~20.

    **`read` and `write` are an INTENT and a speed choice, NOT a sandbox** — don't describe them
    as one. On the current CLI `--allowedTools` is a permission allow-list, not a tool filter: the
    `init` event still lists `Bash`/`Write`/`Task`, and with `permissions.defaultMode: "auto"` in
    the user's settings they execute. Verified twice — a headless `read`-mode run ran `git log` via
    Bash, and a stored `read` conversation has `Write` in its tool trail.
    `timeoutFor` gives `write` the **full** ceiling, not read-only's: it is the mode you pick to
    have work done, and cutting a multi-file edit off mid-way leaves the project half-changed.
    The stored value is validated against `CHAT_MODES` on read, so a `qc.chatTools.v2` written
    before `write` existed falls back to the default rather than to a mode the server rejects.
  - **Effort.** `--effort` — its own picker beside the model (`CHAT_EFFORTS` in
    `ChatPage.tsx`, `ChatEffort` server-side), because it is a separate axis from *which*
    model: "where is this validated?" is a `low` question on any model, and "are these cases
    enough?" is a judgement call that wants `high`. **Three levels, `medium` by default and
    sent EXPLICITLY**, so a chat turn runs the same way whatever the engineer's own Claude
    Code is configured for. `xhigh`/`max` are valid CLI levels and still accepted by the
    server, but deliberately **not offered**: on chat-sized questions they mostly buy minutes
    of thinking and a bigger bill. `'default'` (pass no flag, inherit the CLI's own setting)
    is likewise still accepted and no longer offered — conversations written before this
    setting existed have it stored, and they keep answering exactly as they did. Anything
    unknown or no-longer-offered, in the body or in localStorage, lands on `medium`.
    Unlike a model switch, changing effort **does NOT retire the CLI session**: `--effort` is
    applied to the turn being run, so a resumed session honours the new level and keeps the
    context that makes a follow-up understand "it". It is stored on the conversation
    (`chat.effort`, the default for its next turn) AND on the answer (`ChatMessage.effort`,
    omitted when it was the default) — the "model-visible means logged" rule from the module
    header: it reaches the model and changes the answer, so "why is this one thin?" has to be
    answerable from the transcript later.
    The footer prints the level only when it is NOT the default — a footer that says "medium"
    on every turn is noise. Verified end to end: picking **Low** put `--effort low` in the
    spawned CLI's argv (`ps`), and the saved turn's footer reads `Claude Opus 5 low`.
  - localStorage keys are **versioned** (`qc.chatModel.v2` / `qc.chatTools.v2`; `qc.chatEffort.v1` is new, so v1): reading the old
    keys would have left every existing user on the setup being fixed.
  The prompt goes over **stdin**, so the variadic `--allowedTools` can't swallow it.
- **The saved answer is `turn.answer` (the delta buffer), NOT `r.text`.** `r.text` is the CLI's
  final `result` field, which carries only the **last** assistant text block — everything the model
  said before each tool call is missing from it. Measured on a 3-step turn: 266 characters streamed
  across 3 blocks, `result` held the last 106; since the client drops its streamed copy on `done`
  and re-renders from the transcript, 60% of a correct answer vanished from the screen the moment
  the turn finished — worse the more tool steps a turn took, i.e. exactly the thorough answers.
  `r.text` is now only the fallback for when nothing streamed. Related: `runClaudeStream` emits a
  `\n\n` on each `content_block_start` after the first, because deltas from separate blocks carry
  no separator and otherwise run together as "…the folders.Now I'll read package.json".
- **The hard caps were sized for the old weak turn, and now match Terminal parity.** An opus
  turn with MCP loaded reads more, runs more tools and writes more than a pinned-sonnet one, so
  `MAX_TEXT` (60 KB → 200 KB), `MAX_TOOLS_PER_TURN` (40 → 200) and `CHAT_TIMEOUT_FULL`
  (30 min → 90 min) would each have started clipping a good answer. `MAX_PROMPT` went 12 KB → 48 KB
  **and stopped truncating**: an oversize message is a **413** now, because `.slice()` answered
  half a pasted requirement with full confidence and nothing on screen said why (same reasoning as
  `docReview.ts`). `streamErrorText` in `lib/api.ts` unwraps the `{error}` JSON so the toast shows
  the sentence rather than braces, and the composer **puts the refused text back** — the longer the
  message, the likelier it was refused, and clearing it would just lose it.
- **A lapsed `--resume` replays a summary rather than starting blind** (`recapBlock`). The retry
  already existed, but a fresh session has no context, so a follow-up ("does that apply to the
  other endpoint too?") was answered against nothing — confidently, and indistinguishably from a
  good answer. It now prepends a capped recap (last `RECAP_TURNS` turns, `RECAP_MSG_CHARS` each)
  that tells the model it is a summary and to re-read the project before relying on it, and the
  `log` frame says so on screen. It is NOT a substitute for the session (none of the files read
  then are in it) — don't grow it into one. The replayed turns are **`JSON.stringify`d, not
  written as `Who: text` lines between `---` fences**: the payload is whatever the engineer
  typed and whatever the model wrote, so a message containing the block's own delimiter would
  end it early and have its remainder read as live instruction. Same reason the mentions and
  images blocks name file PATHS instead of inlining file text. (Borrowed from
  `deepseek-harness`'s title provider: "frame exact messages as JSON so user text cannot break
  structural delimiters".) The recap is recorded as a `ContextBlock` too — the one turn whose
  answer came from a summary rather than the real session is exactly the one worth flagging.
- **The transcript records WHAT THE MODEL WAS SENT, not just what was typed** (`ContextBlock`,
  `ChatMessage.context`, `ContextRows`). A turn is never only the words in the bubble: the
  resolved `@`/`/` picks, the absolute paths of pasted images, the `+` menu action's
  instructions and — after a lapsed session — the replayed summary all ride along, and every
  one of them steers the answer. None of it appeared anywhere, so "why did it answer that?"
  had no answer available to the person reading it; on a page whose output becomes test cases
  and bug reports, that gap is what stops people trusting it. The rule is the one
  `deepseek-harness` states as **"model-visible means logged"**. Load-bearing details:
  - The prompt string and the block list are built by **one `add()` helper**, so they cannot
    drift — a block that reaches the model is a block the transcript shows, by construction.
  - `SUGGEST_BLOCK` is deliberately **not** recorded: it is byte-identical on every turn and
    asks for the chips already on screen, so storing 1.5 KB of it on all 200 retained messages
    would inflate every transcript in the repo to say nothing.
  - `contextBlock()` caps each block at `MAX_CONTEXT_BLOCK_CHARS` and **says it cut** — a
    silent trim would recreate the exact problem the record exists to fix.
  - The rows render **collapsed** under the question. This is an audit trail, not conversation.
- **Storage** is `<root>/testing/chats/<slug>.json` (mirrors `routes/prototype.ts`, no DB), written
  **temp-file-then-`rename`**, never in place. `writeFileSync` truncates the target first and
  writes second: anything that kills the process inside that window — Ctrl-C, `qc-portal
  --update`, a crash — left a half-written file, and `readChat`'s `JSON.parse` then threw into
  its `catch { return null }`, so the **whole conversation vanished from the rail** with nothing
  on screen saying why. `rename(2)` is atomic within a filesystem, so a reader sees the old
  transcript or the new one, never a cut one; the `.json.tmp` suffix keeps `listChats` (which
  matches `.json`) from picking a half-written file up. A new
  conversation is named after its first question. Routes: `GET /api/chat`, `POST /stream` (SSE:
  `start` / `resume` / `delta` / `tool` / `log` / `done` / `stopped` / `error`), `GET /:slug`,
  `GET /:slug/stream`, `POST /:slug/stop`, `POST /:slug/rename`, `POST /:slug/pin`,
  `DELETE /:slug/queue/:id`, `DELETE /:slug`, `POST /open`, `GET /images/:name` — **the fixed
  paths must stay above `GET /:slug`**. `POST /stream` answers **202** (not a stream) when a
  reply is already running: the message was queued and its answer will arrive on the stream
  already watching the conversation. SSE frames gained `queue` (the whole waiting list) and
  `dropped` on the terminal frames.
- **A turn belongs to the CONVERSATION, not to the request that started it (`LiveTurn`).** Reload,
  navigate away, close the tab — the answer keeps being written and is saved when it finishes;
  coming back re-attaches to it mid-sentence. Before this, `res.on('close')` aborted the CLI child,
  and since the transcript is only written when a turn ENDS, the question and the half-written
  answer both vanished — verified: reloading six seconds into a visible answer left no conversation
  on disk at all. Load-bearing pieces:
  - `live: Map<root::slug, LiveTurn>` holds the abort controller, the **buffered answer**, the tool
    calls and the set of viewers. In memory on purpose, like `crawlJobs` / `testcaseJobs`.
  - The chat file is written **when the turn starts**, not only when it ends — a brand-new
    conversation had no file to re-open, so its first question was the easiest one to lose.
  - `GET /:slug/stream` catches a late viewer up in one shot (`start`, a `resume` frame carrying the
    question + its images, the whole answer so far as ONE delta, then each tool call) and streams the
    rest. The client finds it through `running` on `GET /:slug` and on the rail summaries; the rail
    marks such a row with a pulsing dot and polls **only while something is running**.
  - **Switching conversations mid-answer is allowed, and leaves the turn RUNNING** (`detach`, the
    client-side counterpart of Stop). The rail's New Chat / New temporary / row-click used to
    `if (streaming) return` — with the whole point of `LiveTurn` sitting unused behind it, so a
    long answer pinned the engineer to one conversation for minutes. `detach` aborts only the LOCAL
    subscription and drops `pending` (which belongs to the conversation being left); the server is
    NOT told, so the row keeps its "Answering…" dot and reopening it re-attaches through
    `GET /:slug/stream` mid-sentence, or finds the finished answer. **Whether the server is told is
    the only difference between `detach` and `stop`** — don't collapse them. Two things it needs:
    `attachedRef` must be cleared too (or coming back finds the key still marked watched and never
    re-subscribes), and `onStart` invalidates `['chats']` so a brand-new conversation has a rail row
    to switch back to and the rail's running-only poll actually starts. No duplicate question on
    return: the transcript file holds no user message until the turn ENDS (`appendTurn`), so the
    `resume` frame is the only copy. Verified on screen — switch away at 3 s, rail says "Answering…",
    reopen at 15 s and the caret is back typing; and a turn that finishes while away shows its whole
    saved answer + follow-up chips on return.
  - **Stop is now a request** (`POST /:slug/stop`), because aborting the fetch no longer cancels
    anything. It saves the buffered partial as a failed turn — the old code tried to save `r.text`,
    which is only set from the CLI's final `result` event and is therefore always EMPTY on a kill,
    so Stop silently discarded the answer too.
    **Stop WAITS for the turn to settle** (`LiveTurn.settled`), it does not just ask it to stop.
    Answering the moment `abort()` returned told the client "done" while the partial answer was
    still being written, so its refetch could read the transcript from BEFORE the save — the
    answer being watched vanished and came back on the next poll. Bounded by
    `STOP_SETTLE_TIMEOUT`, since a Stop that never answers is worse than one that answers early.
  - **The registered turn is removed in a `finally`, and `saveChat` is a PREFLIGHT.** Express 4
    does not catch an async handler's rejection, and `finish()` — the only thing that clears the
    `live` key — is reachable on three paths. One escaped throw (a read-only checkout, a full
    disk, a virus scanner holding the file on Windows) left the conversation answering **409 for
    the rest of the process's life**, with the rail showing a permanent "Answering…" dot and
    polling for a turn that would never end, and a leaked `MAX_LIVE_TURNS` slot each time. So
    `saveChat` now runs and can 500 *before* `live.set`, the run sits in `try/catch/finally`, and
    `ensureQcBrowser()`'s rejection is normalized into the `{ok:false}` shape that code already
    handles. dsh states both halves as "a throw leaves nothing registered" and "dispose must
    reach quiescence, not just request it".
  - **One reply at a time per conversation — but a second message QUEUES rather than 409ing**
    (`TurnSpec`, `queues`, `MAX_QUEUED`, the drain loop in `POST /stream`, `QueuedRows`).
    Two turns at once would `--resume` the same CLI session and interleave two answers into
    one transcript, so the constraint is real; what changed is whose problem it is. A
    full-tools turn legitimately spends five to ten minutes grepping and reading, and for
    all of it the composer was dead — while the follow-up you think of *while reading* is
    exactly the one worth asking. Modelled on `deepseek-harness`'s agent inbox, where a
    queued prompt claims its own turn at the next turn boundary. Load-bearing pieces:
    - **A `TurnSpec` is a VALUE, resolved when Send was pressed** — prompt, assembled
      prompt, `ContextBlock`s, images, action, model, tools, the "Tagged: …" line. The tags
      it carries are the ones the engineer saw in the composer; re-resolving them minutes
      later against a project that has moved on would answer a different question.
    - **One stream carries the whole run.** The drain loop replaces the `LiveTurn` under the
      same key and **carries the viewers across** (`closeStream` is called once, in the
      `finally`), so an attached client watches turn after turn without re-subscribing and
      a detached one still finds the *current* turn under `GET /:slug/stream`. Handover
      re-uses the frames a re-attaching viewer already gets — `start`, then `resume` with
      the next question — so no new frame type was needed for it.
    - **`queue` frames are WHOLE VALUES, never deltas** (dsh's checkpoint rule). That is what
      makes the client's optimistic row safe: the next frame overwrites the list outright,
      so a local id that was never reconciled cannot linger or double up.
    - **The queue only advances past a turn that ANSWERED.** `r.isError` ends the drain even
      when the turn produced text — measured with the CLI logged out, where every queued
      message ran in turn and each "answered" with the same `Not logged in · Please run
      /login`, spending the whole queue on a fault no follow-up could fix.
    - **Nothing typed is ever swallowed.** Stop, a failed turn and an unforeseen throw all
      hand the waiting prompts back: `POST /:slug/stop` **drains the queue itself** and
      returns the text (the client that pressed Stop aborts its own subscription, so it
      never reads the `stopped` frame that carries the same list — this response is the copy
      it actually receives), `done`/`error` carry `dropped`, and `restoreDropped` puts it in
      the composer unless something has already been typed there.
    - **The Send button follows what is TYPED, not whether a reply is running** — empty
      during a turn it stops, with text it sends. Keying it on `streaming` alone is what
      made the composer dead for a whole answer. It stays disabled for the split second
      before a brand-new conversation has a slug, where sending would start a *second* chat.
      In its stop shape it carries a **tooltip** ("whatever has been written so far is kept,
      anything still queued behind it is cancelled"): the red square is the only destructive
      control in the composer and its two consequences — partial answer saved, queue dropped —
      are not guessable from the icon.
    - `DELETE /:slug/queue/:id` takes one back before it runs; a follow-up typed mid-answer
      is quite often answered *by* that answer, and the alternative is letting it run and
      then stopping it.
  - **A turn ends on SILENCE, not on the clock** (`CHAT_IDLE_TIMEOUT`, via `runClaudeStream`'s
    `idleTimeoutMs`). A question about a real repo legitimately spends ten-plus minutes grepping,
    reading and spawning sub-agents; the old fixed wall-clock budget killed exactly that turn and
    replaced every one of those calls with "Claude took too long to answer" (seen on screen after a
    trail of ~18 tool chips). Now the kill timer is **reset by any output** from the CLI and
    `timeoutFor` is only the ceiling. `idleTimeoutMs` is opt-in per caller — omit it and
    `runClaudeStream` keeps the single fixed deadline every other caller relies on.
  - **A cut-off turn saves its partial answer**, for the same reason Stop does: `r.text` only exists
    once the CLI's final `result` event lands, so a killed turn has none while `turn.answer` holds
    everything already streamed. The transcript gets that text plus an italic note saying it was cut
    off — never the note alone.
  - `ChatWorkspace` derives the open slug — nothing picked yet (i.e. a fresh mount after a reload)
    falls back to whichever conversation is still being answered, so the page lands back on it
    instead of the new-chat screen. `onResume` then **pins** that choice with `setPicked`, or the
    page would snap away the instant the turn finished. Derived, not assigned in an effect: this
    page bans setState-in-effect.
- **Pasted screenshots** — QC evidence is usually an image, so Cmd/Ctrl-V (and drop, and the
  paperclip) attaches one to the message. The CLI takes a prompt, **not image bytes**, so the path is:
  the browser sends base64 → `saveImages` writes the file under `testing/chats/images/` (name generated
  server-side from timestamp + MIME, **never** the client's file name) → `imagePromptBlock` names the
  ABSOLUTE paths in the prompt and tells the model to open them with **Read**, which renders images.
  That's why the default `read` tool mode is enough — don't remove `Read` from `toolArgs`. The user
  message stores the file names (`ChatMessage.images`), and `GET /images/:name` serves them back so a
  reopened transcript still shows what was asked about; a turn still in flight previews from the data
  URLs already in memory (the files aren't on disk until it finishes). Limits are mirrored on both
  sides (4 images, 8 MB, png/jpeg/webp/gif) — the client copy only exists so the engineer hears why
  before waiting on a turn. **An image with no text is a valid message**; the server supplies the
  wording rather than 400-ing.
- **UI is a port of shadcnuikit's "AI Chat v2"** (bordered shell, w-72 rail with search + Today /
  Yesterday / 7 Days Ago groups + footer nav + New Chat, centered column, gradient
  greeting, tinted composer well with a hint strip). It deliberately uses the reference's **small
  radii** rather than the portal's rounded-3xl house style. Every mock control is wired to something
  real: the paperclip converts a spec through the shared in-browser `docConvert` and appends it to
  the prompt (the file never reaches the server) or stages an image (see above — that one does), the
  mic slot became the **permission picker** (`ComposerModePicker` — with three modes a toggle
  button would make "the mode I want" a guessing game of how many clicks). It is deliberately
  the SAME shadcn `Select` as the model and effort pickers beside it, label over hint per row:
  it began as a hand-rolled panel portaled into the composer well (which the `+` menu still
  needs, since that one lives inside the `overflow-hidden` input card) and read as a third,
  slightly-different menu among two Selects — the drift the shared `CHAT_MODES` table exists to
  stop. Two things are kept deliberately: the per-mode **tint** on the trigger (what a turn may
  do is the one composer setting worth seeing without reading it), and the long explanation as a
  **native `title`** rather than a Radix tooltip — a tooltip anchored to that trigger stays open
  while the menu is and covers the options it is explaining (measured on screen). And the hero
  orb is layered SVG gradients standing in for the reference's Lottie (150 KB of generated paths, and
  their artwork) — **animated** by the `qc-orb-*` keyframes in `index.css` so it MOVES like the
  reference does: the two colour lobes drift on mismatched long loops, the light bands rock ±5°, the
  sphere floats/breathes, sparkles twinkle off-phase. Each drifting layer is wrapped in its own `<g>`
  because a CSS `transform` REPLACES an element's `transform=` attribute (which would flatten the
  bands' rotations), scaling layers need `transform-box: fill-box`, and every animation is
  transform/opacity only + disabled under `prefers-reduced-motion` (the artwork stays, it just stops).
  `ChatWorkspace` is mounted `key={projectId}` so switching project resets cleanly
  **without setState-in-effect**.
- **The greeting's second line types itself and cycles** (`GREETING_PHRASES`, `useTypewriter`,
  `GreetingHeadline`) — the empty state's job is to say what this page can be asked, and the quick
  chips only cover four categories, so the headline names a few more where the eye already is. It
  is a chain of `setTimeout`s, not a rAF loop (~18 ticks a second, so a per-frame loop would decide
  to do nothing on 59 of 60 frames), it starts with the FIRST phrase already complete (typing in
  from nothing on mount reads as the page still loading), and it lives in its own component so a
  tick re-renders the heading alone rather than the composer and the chips with it. `aria-label`
  carries the settled sentence; `prefers-reduced-motion` gets the static headline and no caret
  (`.qc-caret` in index.css, `steps(1, end)` so it snaps like a terminal cursor).
- **`@` tags a ticket or its test cases** — "are these cases enough?" only means something next to
  a ticket, and the alternative is pasting a folder path or hoping the model greps for the right one.
  Typing `@` in the composer opens a picker over `GET /api/clickup/crawled` (fetched only once `@` is
  typed, then cached): one row per crawled ticket, plus a `@<id>/testcases` row when it has versions.
  ↑/↓ + Enter/Tab pick, Escape closes — while the menu is open **Enter means "pick", not "send"**.
  Only the REFERENCE travels (`mentions: [{kind, folder, version?}]`); `resolveMentions`
  (routes/chat.ts) turns each into absolute file paths — `ticket.md`/`comments.md`/`summary.md`, or the
  version `listTestcaseVersions` reports (newest when no version is given) — and the model Reads them.
  Nothing is inlined, so five tags cost a few prompt lines instead of 200 KB of ticket text. The
  `@ABC-123` token stays in the message text and **deleting it is how you untag**: send filters
  mentions to those whose token is still in the text. An unresolvable tag (renamed folder, deleted
  cases) is dropped and reported in a `log` frame — a silent drop reads as the model ignoring the tag.
  Folder guarding is **per path segment**, since a subtask folder legitimately contains `/`.
  - **`@db/<tag>` tags a connected DATABASE**, which is two questions, not one: STRUCTURE is
    answered by Reading the `testing/knowledge/db-map-<tag>.md` doc connect/sync already writes,
    and DATA by curling the portal's **own** `POST /api/database/query` (`databaseMentionLine`,
    mirroring `totpPromptHint`'s shape). That endpoint is deliberately the same one `/database`
    uses, so a query the chat model wrote hits every layer of the read-only guard — **never give
    chat a second path to a driver**; a write comes back refused. Verified: real counts off the
    live DB matched a direct query, and "delete the soft-deleted rows" was declined outright.
    The mention carries the database **id**, and `resolveMentions` re-checks `row.projectId`
    against the chat's project — a chat must not reach another project's database by id
    (verified: dropped, and reported in a `log` frame rather than silently ignored).
    Database rows are built and budgeted **separately from the ticket rows** in
    `mentionOptions`: a project has one or two databases against hundreds of tickets, so one
    shared 8-row list would push the database off the menu permanently.
  - **A picked tag renders as a CHIP, painted behind the textarea** (`ComposerPaint` +
    `paintSegments`) — a `<textarea>` can't hold an element, so a tag used to read as plain
    text with a spellcheck squiggle through it, indistinguishable from typing. Same overlay
    `SqlEditor` uses: the paint layer draws the text, the textarea above is `text-transparent`
    with a visible caret and a translucent selection. **The token stays in the text**, so
    deleting it is still how you untag — a chip list beside the box would need its own remove
    control and a second source of truth. Three things are load-bearing: the chip is
    **layout-neutral** (padding cancelled by equal negative margin, font untouched — any metric
    change slides the painted glyphs off the real ones and the caret drifts along the line;
    verified by identical `scrollHeight`), scroll is mirrored with a **`transform`** not
    `scrollTop` (the paint layer has no scrollbar, so an assigned scrollTop is clamped — the
    same trap SqlEditor documents), and longest-token-first matching keeps `@X/testcases` from
    being chipped as `@X` plus loose text. `spellCheck` is off because a squiggle would draw
    across a chip with no readable word under it.
- **`/` picks one of the PROJECT'S SKILLS** — the ones `/skills` defines under
  `.claude/skills/`. A skill is a procedure the team already wrote down, and the point of it is
  that the answer follows that instead of Claude improvising; typing `/` is how every other
  Claude surface asks for one, so it's what the composer answers to. It rides the **same rails
  as `@`** — one `mention` state carrying the trigger `char`, so the ↑/↓/Enter/Tab/Escape
  handling, the painted chip and the "deleting the token untags it" rule are written once
  (`activeTrigger` replaced `activeMention`; `skillOptions` sits beside `mentionOptions`; the
  reference is `{kind:'skill', skill}`). Load-bearing details:
  - **The two blocks in the prompt are SEPARATE, and skills come first.** A tagged artifact is
    what the question is ABOUT; a skill is HOW to answer it. Folded into the one "Read every
    file listed" list, the SKILL.md gets read as reference material and then improvised over —
    so `resolveMentions` emits its own `SKILLS THE USER PICKED WITH /` block saying the skill is
    the procedure, to invoke it by name if a Skill tool is available and otherwise Read the
    SKILL.md and follow it, and that it **takes precedence over the model's default approach**.
    Naming the file too is what makes it work in `read` (fast) tool mode, where the Skill tool
    isn't in the allow-list but Read is. Verified on screen: `/brainstorm` answered "I'm
    following the brainstorm skill … its first step is to read the codebase".
  - **Only `@` costs a disk scan.** The ticket + database queries are gated on `char === '@'`
    (they were gated on "a picker is open"), so typing `/` doesn't scan `testing/tickets`.
  - **A `/` query containing a second `/` closes the menu**, which is what keeps a pasted path
    (`/Users/…`) or a URL from opening it. `@` still allows the slash — `@ABC-123/testcases`
    needs it. Verified: `and/or`, `https://x.co/y` and `/Users/hao` open nothing.
  - The log frame distinguishes them (`Following skill /x · Tagged: …`), and a skill whose
    folder is gone is dropped and counted like any other stale pick.
- **Width: the column grows past the reference's `max-w-4xl`** (`xl:max-w-5xl 2xl:max-w-[88rem]`) —
  4xl on a 1440px+ screen left the answer in a ribbon between empty gutters. Three pieces make that
  work together, so don't change one alone: the assistant bubble is **`w-fit`** (a one-line answer
  stretched across 75% of a 1300px column read as a layout bug), prose carries a **measure**
  (`[&_p]:max-w-[85ch]`, likewise `li`/`blockquote`) while code blocks and tables deliberately do NOT
  (they want every pixel), and `ThinkingBubble`'s skeleton uses **rem widths** because a % width has
  nothing to resolve against inside a fit-content box.
- **The answer TYPES OUT — `useSmoothReveal`, and the transcript rows are `memo`ised.** Two separate
  fixes, both measured, both load-bearing:
  - The CLI does not stream a character at a time: a 12.7 KB answer arrived as **116 frames of ~110
    characters**, so painting each frame as it lands advanced the text on only **6% of frames** in
    paragraph-sized jumps (max 225 chars). `useSmoothReveal` drains the received text at a rate
    proportional to the backlog (~12 frames to catch up): **61% of frames advance, median 8 chars,
    worst jump 29** — with zero added long tasks. It can't lag into the next turn, `prefers-reduced-
    motion` skips it, and `safeRevealPoint` walks the cursor past markdown punctuation so a reveal
    never rests between the stars of `**bold**` and flashes raw syntax. The caret is a `▊` CHARACTER
    appended to the text, not a sibling element — markdown renders blocks, so a `<span>` would sit on
    its own line instead of at the end of the last one. While streaming, the scroll is pinned per
    frame (not per delta), or the newest line drifts under the fold between deltas.
  - `Turn` and `CodeBlock` are `memo`ised because `input` lives on the component that renders the
    list: every keystroke re-rendered the whole transcript and re-parsed every message's markdown.
    Measured before: **33 ms per keystroke empty, 100 ms with one long answer, 567 ms in a
    60-message chat**, and streaming into that chat blocked the main thread for **18.0 s of 22.6 s**
    (~12 fps). After: **33 ms flat** (the two-frame measurement floor) and **287 ms of 20.5 s**
    (~58 fps). Don't remove the memo.
- **The waiting state is a `ThinkingBubble`, not a spinner** — what the turn is DOING, shown three
  ways at once: a **phase icon** (`phaseOf` maps the latest tool to a label + lucide icon —
  "Reading the project", "Searching the project", …; `compact` with no tool yet reads "Writing the
  answer") inside a chip wearing a rotating gradient arc (`.qc-orbit`), the label under a sweeping
  highlight (`.qc-text-shimmer`), an elapsed pill once past 3s, and skeleton lines standing in for
  the answer. It replaced a `Loader2` + "Thinking…" line that sat under a SECOND spinner the tool
  trail drew — two spinners in an empty bubble — and then the plain three-dot version of that.
  All three animations run on `transform`/`background-position` only, so a minute-long wait costs
  no main-thread work while the answer streams behind it. Details that are load-bearing:
  - The skeleton uses **`.qc-skeleton`**, whose sweep is tinted with the FOREGROUND — the shared
    `.qc-shimmer` sweeps **white**, which is invisible on a light surface. Verified in both themes.
  - Widths are **rem, not %** (see the width bullet: the bubble is fit-content, where a % width has
    nothing to resolve against).
  - Under `prefers-reduced-motion` the label falls back to a **flat muted colour** — a frozen
    gradient over `color: transparent` is how that effect disappears entirely.
  - Once text starts arriving the indicator stays **mounted** (keyed, `compact`, moved below the
    answer) so its timer doesn't restart mid-answer, and elapsed is measured against a start
    TIMESTAMP rather than counted in ticks — a backgrounded tab has its timers throttled and a
    counter read 10s for a 35s wait.
- **The wait lists what it DID — `ActivitySteps`, with each call's target.** A long turn is long
  because the model is grepping and reading; one unchanging phase label above a skeleton reads as
  hung. Under the header the bubble now shows the calls in order — `Searched for **phaseOf**`,
  `Ran **npm run build**`, `Read **ChatPage.tsx**` — finished ones ticked, the newest wearing its
  phase icon. Load-bearing pieces:
  - **The target comes from the tool's INPUT, and only the server can see it.** `claudeExec.ts`
    `toolDetail()` picks the one interesting argument per tool (`file_path` → basename, Grep/Glob
    `pattern`, Bash `description ?? command`, WebFetch `url`, …), truncates it, and hangs it on the
    `StreamLog` as `tool: {name, detail}`. The log's `text` stays the bare `⚙ <name>` every other
    log consumer already renders — don't fold the detail into it. `routes/chat.ts` reads `log.tool`
    instead of re-parsing that text, and streams it as `{type:'tool', ...step}` — spread, so the
    live `addStep` and the catch-up replay for a late viewer cannot put different shapes on one
    wire. `addStep` records on the turn and sends in one move for the same reason: a step sent but
    not recorded is invisible to anyone who reloads, one recorded but not sent to everyone watching.
  - Consecutive calls with the **same name AND target** collapse to `×N` (`stepsFrom`); different
    targets stay separate rows, since the target is the whole point. Only the last
    `MAX_VISIBLE_STEPS` show, above a `+N earlier steps` line. A **thought is never collapsed**,
    even against an identical one: two thinking blocks are two decisions, and `Thought ×2` hides
    which one led where.
- **A FINISHED turn draws its steps where they happened — `ChatStep` / `steps` / `StepTrail` /
  `splitAnswer`.** Modelled on deepseek-harness's transcript, which puts one quiet row —
  `Bash · List current folder state` — between the paragraph that announced the call and the
  paragraph that reports its result. The saved trail used to be name-only chips stacked above the
  whole answer, which is a list of verbs rather than the turn's story.
  - **This REVERSED an earlier decision** that `detail` is streamed and never persisted, whose
    stated reason was keeping a Bash command line out of the project repo. Weighed again and
    overturned deliberately: `toolDetail` already prefers Bash's `description` over its `command`
    and truncates to 64 chars, and the transcript beside it stores the entire question and the
    entire answer — strictly more exposure than a 64-character target. Reversing it back would
    take the targets out of every reopened conversation, which is the whole feature.
  - **Position is a character offset into the answer (`ChatStep.pos`), not a timestamp.** The
    answer is what gets re-rendered, so the position has to be in the answer's own coordinates or
    it can't survive a reload. It is named `pos` and not `at` because every other `at` on that
    wire is an ISO date string — including one on the same SSE frame type.
  - **`splitAnswer` snaps a step BACK to the nearest safe break, after skipping whitespace.**
    Whitespace first, because a step recorded at the end of a paragraph sits two characters short
    of the break: the blank line ending that paragraph isn't written until the model starts the
    NEXT one, which happens after the call returns. Measured on the first live turn — a `Bash` that
    ran after "I'll list the files first." was drawn *above* that sentence. Back and never forward,
    because a step runs after the text before it, and whitespace-only means nothing said is skipped.
  - **`safeBreaks` only ever cuts at a blank line outside a fenced code block**, and drops a break
    between two items of one list. Each piece becomes its own `ReactMarkdown` document, so a cut
    inside a fence paints half a code block as prose, and a cut inside a list restarts its
    numbering at 1. Past `MAX_ANSWER_PARTS` pieces the answer is left whole and the steps go on top.
  - **Only for a FINISHED turn.** While it streams there is exactly one markdown document, as
    before: the reveal animation walks a single growing string, and re-segmenting it every frame
    would re-parse the whole answer many times a second — the same cost the `Turn` memo exists to
    avoid. The live `ActivitySteps` list is already showing the same steps, in order, with targets.
  - **The row's `list-none! pl-0! [&>li]:my-0!` are load-bearing, not tidying.** `StepTrail`
    renders INSIDE the answer's markdown container, whose `[&_ol]:list-decimal [&_ol]:pl-5` and
    `[&_li]:my-1` are element selectors and outrank a plain utility class. Without the overrides
    the trail draws as a *numbered list, indented past the paragraph it sits between* — which
    destroys the one thing the row is for. Flex + `gap` rather than `space-y`, because zeroing the
    `li` margins would zero `space-y`'s margins too.
  - **More than `COLLAPSE_STEPS_OVER` (3) rows in one group fold behind a single toggle**,
    collapsed by default: `› 5 steps · Ran ×5` (`stepSummary` — the VERB the rows themselves
    use, so opening the fold shows what the summary promised). A repo question runs eight or
    ten commands between two paragraphs and pushes the answer — the thing being read — off
    screen under its own footnotes. Groups of three or fewer are left exactly as they were:
    they were never the problem, and a toggle there is one more thing to click for nothing.
    Folding applies ONLY to the saved trail; `ActivitySteps` must keep naming every step as
    it lands, because that is what says a long turn isn't hung.
  - A transcript saved before `steps` existed has only `tools`, so `ToolTrail` stays as the
    fallback for those. Don't delete it.
- **`Thought · 38s · ~4K tokens` — the shape of a thinking block, never its content.** The CLI
  redacts extended thinking in `stream-json`: verified against the live CLI, `thinking_delta`
  arrives as `{"thinking":"","estimated_tokens":100}` — an empty string and a running count. A
  first attempt summarised the reasoning text and would have shipped a row that was always blank.
  What the row *can* honestly explain is the silence, and that is worth a lot: a turn whose first
  token is 25 seconds late is the moment that reads as a hang.
  - `claudeExec.ts` opens the clock on a `content_block_start` of type `thinking`, keeps the last
    non-null `estimated_tokens` (it is a RUNNING total, so assigned and not accumulated, and it
    goes null on the final delta), and fires `onThinking({ms, tokens})` once on `content_block_stop`.
  - **Nothing asks for thinking.** The portal never passes a thinking flag, so a turn that doesn't
    think draws no rows and the capability costs nothing. Blocks under **1s** are dropped — nobody
    perceived that wait, and a row per micro-pause buries the tool calls.
  - Behaviour worth knowing when testing: the CLI triggers extended thinking on a **fresh** session
    and not on a `--resume`d one, so the row appears on the first message of a chat and rarely
    after. That is the CLI's behaviour, not the portal's.
- **The composer's `+` menu — per-MESSAGE actions** (`ComposerPlusMenu`, `CHAT_ACTIONS`,
  `ChatAction` = `web | research | diagram`; server side: `ACTION_BLOCKS`, `toolArgs(tools, action)`,
  `timeoutFor(tools, action)`). The paperclip moved in here ("Add photos & files"); the other three
  rows change how ONE turn runs and are cleared on send, so the follow-up after a web answer goes
  back to reading the project. What each needs is genuinely different, which is why it isn't a
  setting: **Web search** adds `WebSearch WebFetch` to the read-only allow-list (without that the
  model is DENIED the tool and answers from memory — the exact failure the action exists to prevent)
  and demands a Sources list; **Deep research** is the same tools with a report-shaped prompt
  (sub-questions → search → cross-check against a second source → Summary/Findings/Conflicts &
  gaps/Sources) and the longest budget, because a short one reliably produces half a report;
  **Create diagram** asks for one ```mermaid fence, rendered by `MermaidDiagram` (the same renderer
  `/diagrams` uses) via `mdComponents(renderDiagrams)` — **not while streaming**, since half a
  diagram is invalid Mermaid and the bubble would sit under a parse error for the whole turn.
  - **There is no image GENERATION**, and the menu must not pretend otherwise: the CLI has no image
    model, so the reference's "Create image" became "Create diagram" — the visual this tool can
    actually make, and the one QC work asks for (a flow, a state machine, a sequence).
  - The panel is **portaled into the composer WELL**, because the input card around the button row is
    `overflow-hidden` and a menu opening upward from inside it is sliced down to its last row
    (verified on screen — same trap the `@` menu documents). Click-outside therefore tests the
    trigger **and** the portaled panel, or a click on a menu row closes the menu on `mousedown` and
    unmounts the row before its `click` fires.
  - The action is **stored on the user message** (`ChatMessage.action`) and badged in the transcript,
    because "why does this answer cite the web?" has to be answerable a week later.
- **Temporary chat — a conversation that never reaches the project.** A normal chat's transcript is
  `testing/chats/<slug>.json` and gets committed with everything else; that's right for "how does
  this work?" and wrong for a throwaway question or one with a customer's data pasted into it. A
  temporary conversation therefore lives ONLY in the server's `temp` registry (in memory, like
  `crawlJobs` / `testcaseJobs`): no file, never in `listChats` (which reads the folder), dropped on
  end / `TEMP_TTL_MS` idle (6 h) / restart. Load-bearing details:
  - **`loadChat` / `saveChat` are the only accessors**, which is why every other feature keeps
    working for a temporary chat (multi-turn `--resume`, `GET /:slug/stream` re-attach, Stop,
    `@`-mentions — they all key on the slug). Never call `writeChat` from a route again, and
    `uniqueSlug` checks the registry as well as the folder or a new chat would resolve to the
    in-memory one.
  - **`temporary` is decided when the conversation is CREATED** and inherited by every later turn
    (`POST /stream` only reads the flag for a new chat). The UI mirrors that: the composer toggle is
    disabled once a chat exists, or half a "temporary" conversation would be on disk. `POST
    /:slug/pin` **refuses** — starring means "keep this", the opposite of the point.
  - **Deleting a chat aborts a turn in flight and marks it `discarded`**, so the turn's own save path
    (`persist()`) doesn't write the transcript back a moment after it was deleted.
  - **Pasted images are still real files** — the CLI Reads them — so the registry tracks the ones it
    wrote and `discardTemp` deletes them with the conversation. `TemporaryNotice` says exactly that
    much and no more: it does NOT claim there's no trace anywhere, because the Claude CLI keeps its
    own session transcript in the user's home folder. A privacy line that isn't exactly true is worse
    than none.
  - The client remembers only the **slug**, in `sessionStorage` (`qc.chatTemp.<projectId>`), because
    the rail can't point back at a chat it never lists — that's what lets a reload mid-answer
    re-attach. A slug the server has since dropped 404s, which the page treats as "no conversation"
    (`openSlug`, `retry: false`) instead of a dead transcript. Every way OUT of a temporary chat (End
    chat, New Chat, opening a saved one) goes through `forgetTemporary`, which DELETEs it server-side
    — otherwise it would sit in memory, screenshots and all, unreachable by any UI.
- **Star a conversation to pin it** — `POST /:slug/pin` sets `pinned` on the chat file; `listChats`
  sorts pinned first, then newest, and the rail renders them as a **"Starred" group above the date
  groups**. Two deliberate details: pinning does **NOT** touch `updatedAt` (that field orders the
  date groups, so starring would otherwise yank the chat into "Today" and rewrite when it was last
  worked on), and the star also draws **on the row**, because a search filters the group header off
  screen and "why is this one first?" needs an answer there.
- **Rename and delete are dialogs, not `window.prompt`/`confirm`** (`RenameChatDialog` /
  `DeleteChatDialog`). The native ones can't be styled, can't show *which* conversation is being
  renamed, and are suppressed outright in some browsers — which reads as "the menu item does
  nothing". Rename is keyed on its target so the field seeds without setState-in-effect, Enter
  saves, and Save is disabled while unchanged; delete names the conversation and says the transcript
  file goes with it.
- **"Ask next" — follow-up chips under the newest answer** (`FollowUps`), the Prototype page's
  `<!-- SUGGESTIONS: … -->` idea applied to a conversation. The model appends the marker to its own
  reply (`SUGGEST_BLOCK` in routes/chat.ts, up to 3 short prompts in the ENGINEER's voice), so they
  cost one line of output — **not a second AI call**, which would double the turns and make the user
  wait again after the answer already finished. `splitSuggestions` strips the marker before saving
  and stores the list on the assistant message; the marker is removed **no matter what**, so a parse
  failure means "no chips", never a raw HTML comment in the transcript. Three things hold it up:
  - The client also strips it **while streaming** (`stripSuggestMarker`) — the deltas carrying it
    reach the browser before the server ever saves, and the half-written `<!--` tail arrives frames
    ahead of the rest, so an unterminated comment is cut too. Verified per-frame over a whole turn:
    the marker is never on screen.
  - **The ANSWER settles before the TURN does** (`suggestMarkerStarted` → `answerSettled` in
    `AssistantRow`). Because the marker is stripped, the tail of every turn used to look hung: the
    text stopped growing while the caret blinked and the waiting indicator kept counting, for the
    seconds it took to write a line nobody sees. So the moment stripping starts removing something
    AND the reveal has caught up, the row renders as finished — no caret, no `ThinkingBubble`,
    `ToolTrail` and Copy back — and a separate `SuggestingChips` skeleton appears in the slot
    `FollowUps` will fill (same row markup, so the real chips replace it without the layout
    jumping). Measured on screen: caret+indicator at 0.8s → settled with Copy at 2.9s → real chips
    at 4.4s, and the raw marker never rendered once.
    Two things follow from it: Copy copies `body` (the stripped text), not `text`, which still holds
    the comment at that moment; and a **Stop pressed during that tail saves a NORMAL turn, not a
    failed one** (`routes/chat.ts` checks the buffer for `<!--`) — the answer was complete, only the
    chips were lost, and tinting it red would call a correct answer a failure.
  - The strip renders **outside `Turn`**, keyed off `chat.messages` (not the `?? []` fallback, whose
    identity changes every render). Hanging it on the last message would give that memoised row a
    prop that changes as the conversation moves — see Turn's note. Measured: typing stays at the
    33 ms two-frame floor with chips on screen.
  - **Newest answer only**, and a click **sends** — unlike the empty-state quick prompts (which are
    half-written and need a real ticket id typed in), a follow-up is a complete question.
- **Each answer carries what it TOOK — `TurnStats`, `TurnStatsLine`** in the footer beside
  the model: `Ran 16s · first token 15s · 37K in / 103 out · 53% cached · $0.04`.
  - **It is free.** The CLI reports token counts, the cache split and cost on its final
    `result` event, and `claudeExec.ts` was already parsing all of it to feed `recordUsage`
    — then collapsing the cache fields into one total and throwing the rest away. The two
    timestamps wrap work that happens regardless. **No extra request, no extra token, no
    added latency**, and the values land ONCE, when the turn ends. Do not turn this into a
    live meter: a per-delta counter is exactly the per-frame work the transcript's
    memoisation (33 ms keystroke floor, 287 ms of 20.5 s while streaming) exists to avoid.
  - **`ttftMs` against `ms` is the whole point.** A turn is long for two unrelated reasons —
    the model wrote a lot, or one bash call took four minutes — and nothing else on screen
    separates them. Measured on a real one-word answer: 16.0 s total, **14.8 s before the
    first token**, i.e. the answer itself took 1.2 s. `ttftMs` deliberately includes the
    CLI's own startup (~20 s once MCP servers load), because that is the part being asked
    about.
  - The turn clock is started in `runOneTurn`, NOT read off `StreamResult.durationMs`: a
    lapsed-session retry runs the CLI twice for one question, and the reader is asking how
    long *their message* took. Both clocks reset on that retry — the discarded attempt's
    first token measured a reply nobody will read.
  - **The footer arrives in TWO parts, and that is deliberate — the `settled` frame.** The
    model has been known since the CLI's `init` event and the timings are fixed the instant
    the reply stops, but the token counts and cost genuinely cannot exist until the run
    ends. Making the first group wait for the second left the footer blank through the whole
    follow-up-chip tail — a visible several-second gap where the answer sat finished and
    unlabelled. So `onDelta` fires `{type:'settled', model, stats}` the moment
    `SUGGEST_MARKER_RE` matches, and `done` fills in the rest. Measured on a live turn: the
    line appeared **~2.4 s earlier**, then grew.
  - **`stats.ms` is the ANSWER's duration, not the whole run's** — fixed once in `answerMs`
    at that same marker. Two consequences, both load-bearing: the reader isn't charged time
    for follow-up chips they never asked for, and — because the early frame and the saved
    record read the SAME captured number — `Ran 14s` cannot become `Ran 16s` two seconds
    later. Verified on a live turn: the duration and TTFT were byte-identical before and
    after `done`, only the token/cost tail appeared. For the same reason `ttftMs` is the
    portal's own first-delta clock and not `StreamResult.ttftMs`: only one of the two exists
    at both moments, so only one of them can be shown at either.
  - **Absent fields mean "not reported", never zero.** A killed turn never receives the
    `result` event that carries usage, so those keys are omitted rather than written as 0 —
    which would read as "this turn was free", a different and false claim.
  - **There is deliberately NO share-of-context-window figure**, and adding one would be a
    mistake: dsh can draw `System prompt / Tools / Messages` because it assembles the prompt
    itself, whereas the portal hands a string to the CLI and the CLI owns the system prompt,
    the MCP tool schemas and the history. Splitting `inputTokens` into those parts would mean
    guessing at the CLI's internals, and the guess would go silently wrong the first time it
    changed. The `/1M` denominator has the same problem — with `model: 'default'` the window
    would have to come from a hardcoded table, and the CLI auto-compacts anyway, so the
    percentage would not even predict behaviour. **The total is measured; the breakdown would
    be invented.**
- **👍 / 👎 under an answer WRITES TO PROJECT MEMORY — it is not a satisfaction survey**
  (`AnswerFeedback`, `POST /:slug/feedback`, `learn.ts` `runFeedbackCapture`, `ChatFeedback`).
  Nothing is counted, scored or sent anywhere. A vote runs the same cheap reflection the portal
  already runs after a QC run, over question + answer + vote, and persists the durable fact
  behind it into `testing/memory` — which every later chat turn reads through the managed
  CLAUDE.md pointer block. So a 👎 on "the orders API is v1" is what stops the next answer
  saying v1. That is the whole feature; the icons are the cheapest possible way to trigger it.
  - **The vote is saved BEFORE the capture runs**, in that order, because the capture is a
    model call (~10-13 s measured on `haiku`). Abandon the request and the vote is already on
    disk and the capture still finishes server-side. The response reports `captured` (note
    names) or `skipped`, and the toast names the note with an **Open Memory** action rather
    than saying "learned!" — the engineer has to be able to find, edit and delete what a
    click wrote, which is the same review loop auto-capture's "AI" badge exists for.
  - **A 👎 asks WHY and takes no for an answer.** The typed reason is by far the strongest
    input the capture gets ("the orders API is v2" beats inferring a mistake from a wrong
    answer), so the dialog asks — and `Skip` sends the vote alone, because a required box is
    how a feedback control gets ignored forever. 👍 asks nothing: the answer is the evidence.
    The dialog says the note becomes a **file in the project** and not to paste credentials
    into it, and the prompt independently forbids copying a credential/OTP into a note.
  - **Narrower than `runKnowledgeUpdate` on purpose**: memory only (a vote is a small fact,
    never a knowledge document) and `MAX_FEEDBACK_ITEMS` = 2. Verified: a 👎 with a reason
    wrote one note and a second, contradicting 👎 **updated that same note** instead of
    piling up a duplicate; a 👍 on a trivially correct answer captured nothing and reported
    `nothing worth remembering`, which is the normal outcome and is said as such.
  - **Not gated on the project's auto-learn toggle.** That setting governs capture that
    happens on its own after a run; this only ever happens because somebody pressed a button.
    It does use the project's `autoLearnModel`, so "which cheap model reflects" stays one
    setting.
  - **Un-voting does not un-remember.** Clearing a rating drops the vote and leaves the note,
    which by then is an ordinary project fact somebody may already have edited on the Memory
    tab — silently unwriting project context on an un-click is the worse surprise. The toast
    says where it is.
  - **Two races, both closed.** (1) A vote saved during a running turn would be overwritten
    when that turn persisted its own older copy of the transcript, so `LiveTurn.chat` holds
    the record the turn will save and the route patches THAT object. (2) The late capture
    result only lands if `feedback.at` still matches — re-voting or clearing during those ten
    seconds is an ordinary thing to do, and a late write that ignored it would put the rating
    back by itself.
  - **Stored on the message** (`ChatMessage.feedback`), like `model` / `effort` / `stats`, for
    the same reason: the transcript has to explain itself a week later, and a vote in a
    separate ledger could not be lined up with the answer it was about. Only a STORED answer
    gets the buttons — a rating addresses a message by its index, and the streaming turn has
    no index yet, so they appear when the finished transcript is refetched.
- **ACCURATE ANSWERS ABOUT TICKETS, TEST CASES AND RUNS — three layers, and only one of them
  costs anything** (`FACTS_BLOCK` in `routes/chat.ts`, `answerCheck.ts`, `answerAudit.ts`). The
  complaint that produced this: chat answers that pulled ticket / test-case / test-run detail
  were sometimes simply wrong — a status the ticket doesn't have, a count that isn't the count,
  a test case attributed to a version that has none. That matters more here than in most chat
  UIs, because the reader **acts** on it: files the bug, signs off the release, sends the report
  to a client. And it was measured to have four distinct causes, none of which "be accurate"
  fixes: answering a follow-up from the session's memory of a file it read ten turns ago (or
  from `recapBlock`, which is a **summary** — the files are gone); inferring a ticket's scope
  from its title, or the project's behaviour from how such projects usually behave; estimating
  a count off the first rows of a CSV; and filling a gap instead of reporting it, which is the
  one failure a QC engineer cannot detect, because a confident wrong answer looks exactly like
  a right one. **The constraint was that none of it may slow a turn down**, which is what
  decides where each layer sits:
  - **Layer 1 — `FACTS_BLOCK`, on every turn, free.** ~630 input tokens (measured) appended like
    `SUGGEST_BLOCK` (and unrecorded for the same reason: byte-identical on every message, and
    storing it on 200 retained messages per chat would bloat every transcript in the repo).
    It names the four habits above and forbids them: open the file **in this turn** before
    saying what it says; copy identifiers verbatim; **count, don't estimate**; never infer a
    fact from a name; cite the path behind each project-specific claim; keep "the ticket says"
    / "the code does" / "I infer" apart; and say plainly when something isn't there. It ends by
    telling the model **not** to hedge what it HAS read — the goal is a grounded answer, not a
    timid one, and a prompt that only pushes toward caution buys accuracy with uselessness.
    Added after the `+` action block so an action's own output contract is read first.
  - **Layer 2 — `missingRefs`, on every turn, also free.** After the answer has streamed,
    every project file path in the saved text is checked with one `existsSync` each: no AI, no
    tokens, ~1 ms on a 12 KB answer with 30 candidates. A hallucinated path is the most common
    concrete wrongness and the only class of claim that can be settled with certainty for
    nothing. Stored as `ChatMessage.refs` (**absent**, never `[]`, so a transcript from before
    this existed isn't drawn as "verified clean") and recorded rather than recomputed on read —
    the check describes the project as it was when the answer was written, and a file created
    an hour later must not silently change the verdict on an answer nobody touched.
    **It only reports a path it is SURE about**: under `testing/` (a tree the portal owns, so a
    relative path can only mean one thing) or with an existing parent directory (right
    neighbourhood, wrong file). A path whose parent is also missing is far more often written
    against another base — `src/App.tsx` in a monorepo whose app is in `web/` — than
    hallucinated, and a false alarm here spends the trust the strip depends on. Fenced code
    blocks are stripped first: paths in an import or a shell sample resolve relative to the
    file being shown, not to the project root. Verified against 11 shapes — real path, real
    path with `:line`, fake with an existing parent, fake under `testing/`, fake with a missing
    parent (silent), a URL, `api.example.com/v1/orders.json`, imports inside a fence,
    `node_modules`, and `0.11.17/0.11.18` version noise — each behaving as designed.
    Drawn as `MissingRefs`: amber, worded **"not found"**, never "wrong". A missing path has
    three innocent explanations as well as the bad one (the answer PROPOSED the file, the file
    was deleted since, the model typed a near-miss), so the strip's job is to send the reader
    to look — not to overrule the answer.
  - **Layer 3 — `answerAudit.ts`, ON DEMAND, and that is the whole design decision.** A model
    cannot reliably catch its own self-consistent mistake — the finding `groundingCheck.ts`
    already rests on — so the only real check is an INDEPENDENT second pass that re-reads the
    project. That costs 30-90 s and real money, so it is the **SearchCheck button** beside
    Copy and the 👍/👎, not something every question pays for. It runs against the **stored**
    transcript after the fact, so nothing in it can slow an answer down. It rates each
    checkable claim `supported` / `wrong` / `unverified`, with a path (or, for `wrong`, what
    the project actually says), and is told to ignore opinions, advice and anything outside the
    folder — those are not its to rate. `unverified` is a first-class verdict: an auditor that
    must choose between "confirmed" and "contradicted" will invent one.
    - The auditor runs with the read tools and **the write tools explicitly denied** — a pass
      whose job is to check the project has no business changing it, and would then be
      checking its own edit. `--strict-mcp-config`, no session persistence, capped budget.
    - **`skipped` must never render as clean.** A timeout / unparseable reply comes back as
      `verdict: 'unverified'` **with** a `skipped` reason, and `AuditPanel` says "the check did
      not finish". "Not checked" and "nothing wrong" are opposite facts.
    - Stored as `ChatMessage.audit` beside the answer, for the reason every other per-turn
      fact is: the engineer paid a minute for it and it has to still be there tomorrow.
      `AuditPanel` collapses to its headline **unless something was contradicted** — the point
      of the check is the claim that doesn't hold, and hiding that behind a disclosure wastes
      the wait. The model that audited is named in the panel: a haiku verdict and an opus one
      are not equal evidence.
    - **Two guards.** The server refuses a second audit of the same answer while one is
      running (409, keyed conversation + index) rather than paying twice — the button is
      disabled client-side, but a reload gives you a fresh button over a running audit. And
      the late write only lands if `messages[index].at` still matches, the same race
      `feedback` closes: `LiveTurn.chat` is used when a turn is live, and a transcript that
      has rolled past `MAX_MESSAGES` must not have an audit attached to a different answer
      that now sits at that index. An aborted request (navigated away) kills the child.
  **Verified end to end** against a planted transcript whose answer mixed true and false
  claims about a fixture ticket: the audit ran in **20 s on `haiku`** and caught the invented
  status ("Done" — the ticket says In Progress), the invented count ("5 test cases" — the CSV
  has 2) and the invented row (TC-003), each with the file and line, while confirming the four
  claims that were true. A second probe showed the layers covering each other: an answer
  citing `testing/tickets/DEMO-1/testcases/v9.csv` and `server/src/ghostReminder.ts` had the
  first flagged instantly and for free by layer 2 and the second — deliberately passed over
  there, since Demo3 has no `server/` directory to anchor it — caught by layer 3 with
  "no server directory exists; grep finds no ghostReminder.ts anywhere". Also verified: the
  409 on a second concurrent audit, 400 on an index that isn't an assistant message, 404 on an
  unknown slug, and the verdict surviving on disk in the transcript.
  A trap found while testing and worth keeping: the abort hook must be **`res.on('close')`
  guarded by `writableEnded`**, not `req.on('close')` — the latter fires as soon as the request
  BODY has been read on Node 18+, which aborted every audit the instant it started and then
  returned nothing at all, so the request hung until the client gave up.
- **Each turn is signed — `RowAvatar` + `RowName`** — the assistant's mark is the portal's solid
  chip (`bg-foreground text-background` + Sparkles) on the left with **"AI Assistant"** over the
  bubble; the user gets a quiet outlined chip on the right under **"Me"**. The avatar is
  `aria-hidden` **because** the name beside it is real text — labelling both makes a screen reader
  announce every speaker twice. The avatar has no top margin so it lines up with the name line.
- **Every message carries its time** (`MessageTime`) — time of day, plus the date when it isn't today,
  full stamp in the `title`. The user's shows under the bubble; the assistant's sits in the footer
  beside Copy with the model that answered. The in-flight turn stamps `pending.at` at send, so the
  time doesn't pop in only once the answer saves — and that same value is what the elapsed reading
  counts from.
- **Code in an answer is a `CodeBlock`** (`web/src/components/CodeBlock.tsx`) — language label,
  **Copy** button, syntax colours. The swap happens on markdown's **`pre`**, not `code`:
  react-markdown v9 dropped the `inline` prop, so `pre` is the only reliable "this was a fenced
  block" signal — keying off `code` and guessing from "contains a newline" renders a one-line fence
  as an inline pill. Highlighting arrives a beat after mount (lazy import) and is stamped with the
  code it came from, so a streaming answer falls back to plain text instead of showing the previous
  frame's markup; it must never be why code doesn't appear.
- **A screenshot an answer CITED is one click from the picture** (`collectImageRefs` /
  `useResolvedImages` / `ImageRefChip` / `ImageRefDialog` in `ChatPage.tsx`, `POST
  /api/files/resolve-images` + `GET /api/files/project-image` in `routes/files.ts`). A turn that
  ran the `qc-testing` skill answers with evidence — "the cancel dialog never closed — see
  `screenshots/ac3-cancel.png`" — and that path used to be dead text: the engineer had to find the
  run, open its **Screenshots** tab and match the filename by eye. Now the transcript draws it as a
  violet chip that opens the image in a dialog, the same gesture `RunDetailPage`'s evidence chips
  give inside a run.
  Two rules keep it off every other answer, and they are the point:
  - **A candidate is a path with a DIRECTORY and an image extension**, taken from prose, an inline
    `code` span, a table cell or a markdown `![](…)` src — never a bare word, and **never from
    inside a fence** (a path in a code block is a command being shown, not evidence to open).
  - **A candidate becomes a chip only after the server confirms the file EXISTS.** Same rule as
    `answerCheck`: a path the model invented, or one from another machine, stays plain text rather
    than becoming a chip that 404s. Resolution is pure `stat` — the path as written, then the same
    path inside each recent `testing/test-result/<run>/` folder (the skill writes evidence
    run-relative as often as full), then its basename under that run's `screenshots/`/`evidence/`.
  An answer with no candidates **fetches nothing and keeps the shared module-level `MD_COMPONENTS`
  identity**, so the `memo`ised-transcript cost measured above is untouched; only an answer that
  cites a real image builds its own `components`. Not while streaming either — half a path is not a
  path, and the chips would flicker in as the text arrives. `project-image` serves image extensions
  only and is containment-checked against the project root like every other file route.
- **The quick chips are category EXPANDERS, not one-shot prompts** — verified against the reference:
  clicking a chip replaces the chip row with that category's four concrete prompts (bold verb
  `prefix` + muted `rest`), and clicking one **types it into the composer instead of sending**, then
  restores the chips. The list is absolutely positioned over the chips' slot so the composer doesn't
  jump. Typing-not-sending is the point: "the newest crawled ticket" usually wants a real ticket id
  first. The reference dead-ends once a category is open (no way back to pick another), so Escape and
  an outside click also restore the chips — no extra control on screen.

