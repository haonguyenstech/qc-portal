<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Terminal page (device shell)

**`/terminal` (`TerminalPage.tsx`, "Terminal" under the sidebar's Tools group)** — a real
pseudo-terminal on the machine running the server, rendered in-browser with **xterm.js**
(`@xterm/xterm` + `@xterm/addon-fit`). **Connect** spawns the user's login shell
(`$SHELL -l`, or `%ComSpec%`/PowerShell on Windows) with `cwd` = the **active project's root** via
**`node-pty`**, bridged over a dedicated **`/ws/terminal`** WebSocket. It behaves like a native
terminal (interactive TUIs work — the page auto-runs `claude --dangerously-skip-permissions` on
connect).

- **Several terminals at once** — the page is a **tab strip** (`TerminalTabs`) over one `TerminalPane`
  per tab, each pane its own `useXtermSession` connected with `?tab=<id>` → its own shell + Claude
  session. Inactive panes stay **mounted but `invisible`** (not `hidden`: xterm's fit addon needs a real
  size), so switching tabs is instant and nothing is replayed. Tabs are persisted per project in
  `localStorage` (`qc.terminalTabs.<projectId>`, capped at `MAX_TABS` = 6) and the whole workspace is
  mounted with `key={projectId}`, so each project has its own set. A shell the server still has whose id
  isn't in localStorage is **derived back into the tab list on render** (no setState-in-effect). Header
  controls (status pill, Connect/Re-attach, Disconnect, Slash commands) act on the **active** tab via an
  imperative `PaneApi` registry (`apis` ref); the **×** on a tab is what ends its shell.
- **One viewer per session, and never a tug-of-war** — attaching kicks whatever socket was attached,
  closing it with code **`WS_CLOSE_TAKEN_OVER` (4001)** so the loser can tell "someone took this over"
  from "my connection dropped". That distinction is load-bearing: the client re-attaches on its own, so
  with a generic close two windows on `/terminal` steal every session back and forth forever
  (`lastActivityAt` churning every ~2 s, the UI flapping Connected → Disconnected → Connecting…). The
  client therefore **never auto-attaches a session another window holds** (`attached` from
  `/api/terminal/sessions`, polled every 3 s — offering "Take over" instead) and stops auto-retrying
  after `AUTO_CONNECT_ATTEMPTS` (3). On the server, `pruneDeadViewer()` drops a viewer whose socket is
  no longer OPEN before reporting or attaching — a missed `close` event would otherwise leave a session
  permanently "open in another window" with nobody watching it.
- **Sessions persist across navigation** — the pty **outlives its socket**. `terminal.ts` keeps a
  registry keyed by `sessionKey(req)` (`shell:<projectId>#<tab>` for the page, `run:<runId>` for Continue
  session): leaving the page / reloading / a dropped socket only **detaches**, and the next connection
  **re-attaches** to the same shell, replaying the last 256 KB of output. A session ends only on an
  explicit `{type:'kill'}` (the **Disconnect** button), the shell exiting, 6 h detached (`IDLE_MS`),
  eviction past `MAX_SESSIONS` (16, oldest detached first), or shutdown — `gracefulExit` calls
  `killAllTerminalSessions()`, without which restarts orphan setsid'd shells. `GET /api/terminal/sessions` lists what's alive, and
  `TerminalPage` uses it to auto-re-attach each tab on mount and to label the button **Re-attach** vs
  Connect. On re-attach `useXtermSession.connect({reattach:true})` **skips `initialCommand`** — replaying
  it would type the launch line into the Claude session already running in there. Auto-connect is
  **status-driven, not latch-based** (fires only while a pane is `idle`, and only after
  `isFetchedAfterMount` so a cached "still alive" from before a server restart can't spawn a launch-less
  shell); a pane the user disconnected is never resurrected (`userEnded` ref), and "just created by the
  user" is dropped from `freshIds` on first connect so an exited shell isn't respawned in a loop.
- **WebSocket protocol** — server→client frames are **raw terminal bytes** (`term.write`); client→server
  frames are **JSON control** messages: `{type:'input',data}` for keystrokes, `{type:'resize',cols,rows}`
  on fit, and `{type:'kill'}` to end the session (plain socket close keeps it running). Connection query
  params: `projectId` (or `runId`), `cols`, `rows`.
- **Upgrade routing** — `index.ts` uses two `noServer` `WebSocketServer`s and a single `server.on('upgrade')`
  that dispatches by pathname (`/ws` → run hub, `/ws/terminal` → `handleTerminalConnection`); unknown paths
  are `socket.destroy()`ed. Don't go back to `new WebSocketServer({ server, path })` — multiple path-bound
  servers on one HTTP server don't compose.
- **node-pty** is a native module shipped with prebuilt binaries (mac/win, arm64/x64). It's loaded lazily
  and defensively in `terminal.ts` — if the binding can't load, `GET /api/terminal/available` returns
  `{ok:false,error}` and the page shows an "unavailable" card instead of crashing the portal. On posix the
  module re-asserts the prebuild's `spawn-helper` exec bit before the first spawn (some extractions strip it,
  surfacing as `posix_spawnp failed`).

## Continue session (resume a finished run in a terminal)

A QC run's Claude session is **kept alive after the report is written** so the engineer can keep
working in it — the session is not closed when the run ends. The "Continue session" panel on
`RunDetailPage` is a **real interactive terminal** (the same xterm/PTY engine as the Terminal page),
wired to resume *that run's* session. This reuses the existing session capture: `onSession` stores the
stream-json `init` event's `session_id` into `runs.sessionId`.

- **Server** — `/ws/terminal?runId=<id>` (in `terminal.ts`, `resolveTarget`) spawns
  **`claude --resume <sessionId> --dangerously-skip-permissions`** interactively (cwd = the run's
  project root — the bypass flag is the DEFAULT, mirroring both the headless run's
  `--permission-mode bypassPermissions` and the Terminal page's launch line, so a resumed
  conversation doesn't start prompting for tools it was already using) instead of a plain
  shell. Bad/absent session or unknown run → an error line is written to the terminal and the socket
  closes. On Windows the resume goes through `cmd.exe /c claude …` so the `.cmd` resolves.
- **`GET /api/qc/runs/:id`** returns **`hasSession`** (`getRunSession(id) != null`) so the panel only
  shows when the conversation can be continued.
- **UI** — `ContinueSessionPanel.tsx` (under the summary, when `run.hasSession`) uses the shared
  **`useXtermSession`** hook (`web/src/lib/useXtermSession.ts`) — the xterm + fit + WebSocket plumbing
  factored out of the Terminal page, parameterized only by the connect query (`runId` here,
  `projectId` for the plain Terminal page). **Connect** is disabled while the run is still
  `running`/`queued` (the session is in use). On disconnect it invalidates `['run', id]` /
  `['run-files', id]` so a report/evidence the interactive session changed refreshes.
- **Process cleanup** — `killPtyTree` signals the pty's whole **process group** (`process.kill(-pid)`;
  node-pty's child is a setsid session leader) so `claude` *and the MCP servers it spawns* die when the
  session is destroyed, escalating SIGTERM→SIGKILL. Don't downgrade this to a bare `pty.kill()` — that
  leaves MCP children orphaned. Note this now fires on **session destroy**, not on socket close:
  navigating off `RunDetailPage` leaves the resumed session running (keyed `run:<id>`) and coming back
  re-attaches; **Disconnect** is what ends it. See the Terminal page's session-registry bullet.

