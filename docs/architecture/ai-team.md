# AI Team (`/ai-team`)

The project's squad of QC bots and how it is organised: each bot's role, model, autonomy and
what it may do, who **coordinates**, who **verifies** whose findings, who **hands off** to
whom, and who **consults** whom. Plus the team rules every mission obeys.

**This page manages the organisation only; the bots run in `/chat`** once `@team-ai` brings
them into a conversation (see "In chat" below). Missions and a live board, still to come,
will read this same document rather than invent their own idea of the team.

## Storage

One JSON document per project at `testing/ai-team/team.json`, beside notes and memory: the
team is project knowledge and should travel with the repo.

- `server/src/aiTeamStore.ts` owns the shape and the **starter squad** (Lead, Analyst,
  Tester, Designer, Critic, Reporter) written on first open and restored by *Reset*.
- The document is replaced **whole** on save (`PUT /api/ai-team`). `normalizeTeam` is the
  only gate: unknown roles, capabilities, link kinds and approval actions are dropped; a
  link to a missing bot, a self-loop or a duplicate relation is dropped; the coordinator
  must be an existing **enabled** bot or it becomes `null`; two bots with one handle is
  refused outright (a handle is what `@bot` will address).
- **`team-ai` and `human` are reserved handles** (`RESERVED_HANDLES`, mirrored in
  `web/src/lib/aiTeam.ts`): in chat `@team-ai` brings the whole team in and `@human` is how a
  bot asks the engineer. The inspector refuses them; one found on disk is renamed `-bot`.
- Links and the coordinator are resolved through the ids AS WRITTEN (`idMap`), so a
  hand-edited `"id": "QA Lead"` (stored `qa-lead`) or a renamed reserved handle keeps its
  relations instead of silently losing them.
- A file that no longer parses is **reported, not overwritten** (422). The page offers to
  replace it with the starter squad, behind a confirm.

## Relations

| Kind | Meaning | Line |
|---|---|---|
| `coordinates` | assigns work, expects results back | foreground, animated |
| `reviews` ("Verifies") | re-checks findings before they count | amber, dashed |
| `hands-off` | output becomes the next bot's input | emerald |
| `consults` | asks an opinion, no work changes hands | muted, dotted |

A line drawn **from the coordinator** defaults to `coordinates`, any other to `hands-off`;
the new relation is selected so its kind can be changed at once. Relations are directional
(*Reverse* swaps them). Line colours are CSS variables (`--foreground`,
`--color-amber-500`…), never hex — and the arrowheads are our own SVG `<marker>`s because
React Flow's built-in marker cannot take a CSS variable colour.

Each line picks the card sides FACING each other (`facingHandles`). Without that every edge
leaves a card's first handle (the top) and the lead's reports fan out of its head.

## Team health (`web/src/lib/aiTeam.ts` → `teamWarnings`)

Only structural mistakes that would visibly break a mission, never style advice:

- no enabled bot / no coordinator (error)
- a bot with no relations, or one nobody coordinates (warning — it would never get work)
- cross-verification on, but a tester nobody verifies (warning — its bugs can never be confirmed)
- a bot that may file bugs with autonomy *Act* while filing needs no approval (error)
- a coordination loop (error — two bots assigning work to each other forever)

The starter squad must come up **Healthy**. "More parallel copies than the team cap" was
tried as a warning and removed: queueing past the cap is the intended behaviour, not a fault.

## Editing model

`AiTeamPage` loads the document; `TeamEditor` (keyed by project + reset generation) owns the
draft. Edits save **debounced** (600ms); a drag moves the card on screen and saves once, when
the drag ENDS. Saves write the React Query cache as well, so leaving and returning shows the
team as last saved, and the query uses `staleTime: Infinity` so a background refetch never
clobbers an edit in progress. Deleting a bot or relation is done from the inspector
(`deleteKeyCode={null}`): a stray Backspace on the canvas removing a bot and all its
relations is too easy.

## In chat

`@team-ai` in `/chat` brings this team into a conversation (picking one bot, `@ba`, brings
only that bot — the chat keeps its own member list), and each bot answers with its own
role, model, instructions, capabilities and **autonomy**, calling on the others by @handle
within the team rules' round limit. Who is called next is read from each reply's control
line, not its prose. The loop is `server/src/teamRunner.ts`, covered by
`server/test/teamRunner.test.ts` (`npm -w server test`). See "THE AI TEAM IN A CONVERSATION"
in `chat.md`.

What the chat honours from this document, and how hard:

| Setting | In chat |
|---|---|
| role, mission, instructions, model | in the bot's prompt / `--model` |
| capabilities | prompt, and the tool mode (`botTools`: heavy capabilities get the chat's mode, the rest `read`) |
| autonomy | prompt; an `ask` bot is also locked out of tracker + edits until the human addresses it |
| `requireApprovalFor` | **enforced** for bots the human did not address directly: tracker actions → the tracker MCP servers are removed (`teamMcp.ts`), `edit-files` → `Edit`/`Write`/`NotebookEdit` denied. Bash is not denied |
| `maxRounds` | the round cap (plus `MAX_TEAM_REPLIES` = 16) |
| `crossVerifyBugs` | prompt rule |
| `maxParallelBots` | the bots of one round reply in parallel, at most this many at once |
| `maxParallel`, `missionTokenBudget` | not yet (one copy of a bot per round; no token ceiling) |

## Where this is going

1. Missions — the coordinator plans, bots work in parallel within `maxParallel` and
   `policy.maxParallelBots`, the Critic re-verifies findings (`crossVerifyBugs`), actions in
   `requireApprovalFor` wait in a human approval inbox, `missionTokenBudget` stops the run.
