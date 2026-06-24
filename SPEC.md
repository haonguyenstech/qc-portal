# QC Portal — Spec / Plan

**Goal:** Give QC a **web UI** to do everything they do today in the cmd, without typing commands.
Run QC tests, read nice reports, and also **manage skills and MCP servers** from the browser.

**Runs:** Locally on each QC's own PC (Windows or Mac). Open `http://localhost:5174` in a browser.

---

## 1. Do we need a backend? — YES

A React app runs **inside the browser sandbox**. By itself it **cannot**:

- run the `claude` command (headless QC run),
- drive Playwright / take screenshots,
- read or write files on disk (`SKILL.md`, `report.md`, `.mcp.json`),
- run `claude mcp add/list/remove`.

So the Portal has **two parts**:

| Part | Tech | Job |
|------|------|-----|
| **Frontend (UI only)** | React + Vite | Forms, buttons, tables, live log, editors. Talks to backend over HTTP/WebSocket. Draws nothing on disk. |
| **Backend (the engine)** | Node (Express) | Runs `claude` headless, streams progress, reads/writes skill files, edits `.mcp.json`, serves screenshots, stores history. |

Both run on the QC's PC. Frontend = what you see. Backend = what actually does the work.

```
┌──────────────────────────── QC's PC (Windows / Mac) ────────────────────────────┐
│                                                                                   │
│   Browser  ──HTTP/WebSocket──►  Node backend  ──spawns──►  claude -p (headless)   │
│  (React UI)                     (localhost:5174)            └─ runs qc-testing     │
│      ▲                               │                         skill (Playwright   │
│      │  live log + results           │  reads/writes           + subagents)        │
│      └───────────────────────────────┘                                            │
│                                       │                                            │
│                                       ├─ testing/<ticket>/  (report.md, issues.md, │
│                                       │                      screenshots/)         │
│                                       ├─ .claude/skills/*    (skill files)         │
│                                       └─ .mcp.json           (MCP servers)         │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**Key principle:** do **not** rewrite the QC logic. The existing `qc-testing` skill stays the brain.
The Portal is just a friendly **launcher + viewer + editor** around it.

---

## 2. The 3 features (pages)

### Page 1 — Run QC  (the main one)
- **Form:** ClickUp ticket (id or dropdown), App URL, options (e.g. "post issues back to ClickUp").
- **▶ Run** → backend launches `claude` headless with the `qc-testing` skill.
- **Live progress:** the 7 phases as a stepper (Intake → Plan → Setup → Collect → Analyze → Aggregate → Report) + streaming log lines ("logging in…", "capturing AC2 dialog…").
- **Result:** when done, render `report.md` as a **Pass/Fail table**, a **screenshot gallery**, and the **issues list**. Click an issue → zoom its `ISSUE-*.png`.

### Page 2 — Skills manager
- **List** all skills in `.claude/skills/` (name + description from `SKILL.md` frontmatter).
- **Edit** a skill: markdown editor for `SKILL.md` and companion files (`checklist.md`, `edge-cases.md`, …). Save writes the file.
- **Create** a new skill from a template (auto-make folder + `SKILL.md` skeleton).
- **Enable/disable**, duplicate, delete.

### Page 3 — MCP manager
- **List** MCP servers (from `.mcp.json` + `claude mcp list`), show status (connected / needs auth).
- **Add** a server (form: name, command, args / URL) → writes `.mcp.json` or runs `claude mcp add`.
- **Edit / remove** a server. Reconnect / re-auth button (ties into your existing `mcp-token-auth` flow).

### (Bonus) Page 4 — History
- Every past run: date, ticket, app URL, pass/fail counts, link to its report folder. Search + compare.

---

## 3. Backend API (draft)

```
POST   /api/qc/run            { ticketId, appUrl, options }  -> { runId }
GET    /api/qc/runs                                          -> [ run summaries ]
GET    /api/qc/runs/:id                                      -> run detail + parsed report
WS     /api/qc/runs/:id/stream                               -> live log + phase events
GET    /api/files/screenshot?path=...                        -> serve a PNG
GET    /api/clickup/tasks                                    -> ticket dropdown (via MCP/API)

GET    /api/skills                                           -> list skills
GET    /api/skills/:name                                     -> files of one skill
PUT    /api/skills/:name/:file   { content }                 -> save a skill file
POST   /api/skills               { name, description }       -> create new skill

GET    /api/mcp                                              -> list MCP servers + status
POST   /api/mcp                  { name, command, args }     -> add server
DELETE /api/mcp/:name                                        -> remove server
```

### How a QC run works (backend)
1. Receive `{ ticketId, appUrl }`.
2. Spawn headless Claude in the repo dir:
   ```
   claude -p "Use the qc-testing skill. Ticket <id>. App URL <url>."
     --output-format stream-json --verbose
     --permission-mode acceptEdits   # or a pre-approved allowlist
   ```
3. Read the `stream-json` stdout line by line → map tool calls/text to **phase + log events** → push over WebSocket to the UI.
4. On exit, read `testing/<ticket>/report.md` + `issues.md`, parse the tables, store a run record (SQLite), notify the UI.

---

## 4. Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| Frontend | **React 19 + Vite + Tailwind + Radix** | Same as `hmezher-healthcare-fe` — reuse `components/ui/`. |
| Markdown editor | CodeMirror or Monaco | For the Skills manager. |
| Report render | `react-markdown` + remark-gfm | Render `report.md` tables. |
| Backend | **Node + Express + `ws`** | Spawn `claude`, file I/O, stream. |
| Spawn | `cross-spawn` / `execa` | Cross-platform (Win + Mac). |
| Storage | **SQLite** (better-sqlite3) or flat JSON | Run history. Start with JSON if simpler. |
| Engine | **`claude` CLI headless** (chosen) | Reuse the skill as-is, least new code. |

**Folder layout (new app):**
```
qc-portal/
├── SPEC.md          (this file)
├── server/          Node backend (Express + ws)
│   ├── index.ts
│   ├── routes/      qc, skills, mcp, files
│   └── claude.ts    headless launcher + stream parser
└── web/             React + Vite UI
    ├── pages/       Run, Skills, Mcp, History
    └── components/
```
*(Lives inside the repo so `claude` runs with the project's skills + CLAUDE.md. Add `qc-portal/` to `.gitignore` if you don't want it committed, or make it a sibling repo — open question below.)*

---

## 5. Cross-platform notes (Windows + Mac)
- Use `cross-spawn`/`execa` — never hardcode shell or `/` paths; use `path.join`.
- Detect the `claude` binary (PATH, or let the user set it in a Settings page).
- Playwright MCP + ClickUp MCP already work on both OSes.
- Watch the **space in the repo path** (`STS-Data /Project/...`) — always quote / pass as args, never string-concat into a shell line.

---

## 6. Security / safety
- Backend binds to **127.0.0.1 only** (not exposed to the network).
- Never write OTP/credentials to disk or the log stream (the skill already forbids this).
- Headless run uses a **pre-approved tool allowlist** so it doesn't hang on permission prompts, but still **cannot** click final mutating actions (skill's "shared environment" rule stays).
- Skill/MCP editors write only inside `.claude/skills/` and `.mcp.json` — path-guard against escaping the repo.

---

## 7. Milestones

- **M0 — Spec** ✅ (this doc).
- **M1 — Pipeline proof (MVP):** Run page form → backend spawns headless `claude` → stream raw log to UI → show final `report.md` as text. *Proves end-to-end.*
- **M2 — Results dashboard:** parse report → Pass/Fail table + screenshot gallery + issues; phase stepper; run history.
- **M3 — Skills manager:** list / edit / create skill files from UI.
- **M4 — MCP manager:** list / add / remove MCP servers; reconnect.
- **M5 — Polish:** ClickUp ticket dropdown, auto-post issues to ticket, PDF export, batch queue.

---

## 8. Open questions (need your call)
1. **Where does `qc-portal/` live** — inside this repo (commit it? or gitignore?) or a separate repo?
2. **ClickUp:** read tickets via the ClickUp MCP, or via ClickUp REST API + token?
3. **History storage:** SQLite (nicer queries) vs flat JSON files (simpler) — pick for MVP.
4. **Auth on the portal:** none (single local user) for MVP, or a simple login now?
5. **Auto-post issues back to ClickUp** — want this in MVP or later?
