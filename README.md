# QC Portal

A local web UI for QC engineers to run the **`qc-testing`** skill without using the command line —
across **multiple projects** — plus manage each project's skills and MCP servers. Wraps Claude
Code headless; it does not reimplement the QC logic.

```
qc-portal/                                                    (standalone tool — lives anywhere)
├── web/      React 19 + Vite + Tailwind v4 + shadcn/ui + React Query   (UI, port 5175)
└── server/   Node + Express + ws + node:sqlite                          (API,  port 5174)
```

The portal is **standalone** — it does not live inside any project. You register one or more
**projects** (each an absolute path to a repo folder) on the **Projects** page; the active project
is chosen in the sidebar. For each QC run the server spawns `claude` headless **in that project's
folder**, so its `qc-testing` skill, `CLAUDE.md`, `.mcp.json`, and `testing/` output are all in scope.

## Install (end users)

The installer ensures Node 22.5+ and Claude Code are present, downloads the portal into
`~/.qc-portal`, builds it, and adds a `qc-portal` command to your PATH.

It also adds a **QC Portal** app — Desktop + Start Menu on Windows, Launchpad and
`~/Applications` on macOS. Click it and the portal opens **in its own window**: no tabs, no
address bar, its own icon in the Dock/taskbar. No terminal involved.

### Easiest: one file to double-click

[![Download for Windows](https://img.shields.io/badge/Download-Windows%20.exe-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/haonguyenstech/qc-portal/releases/latest/download/QC-Portal-Setup.exe)
&nbsp;
[![Download for macOS](https://img.shields.io/badge/Download-macOS%20.dmg-111827?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/haonguyenstech/qc-portal/releases/latest/download/QC-Portal-Installer.dmg)

No terminal at all. Both buttons always point at the newest release
([all releases](https://github.com/haonguyenstech/qc-portal/releases/latest)).

| | First time |
|---|---|
| **Windows** — `QC-Portal-Setup.exe` | SmartScreen warns about an unknown publisher: *More info* → *Run anyway*. |
| **macOS** — `QC-Portal-Installer.dmg` | Open it and read *READ ME FIRST.txt*: macOS refuses to **double-click** an unsigned installer, so you type `bash ` in Terminal and drag the `.command` in. On macOS, the terminal line below is genuinely less work. |

Neither file is code-signed yet, which is all those warnings mean. The first install takes a
few minutes in a console window: it fetches Node, Git and Claude Code if they are missing,
downloads the portal and builds it. Leave it alone until it says Done.

> **macOS 15 and later** no longer offer the old *right-click → Open* bypass for unsigned
> downloads — the dialog only says "Apple could not verify…", with **Move to Trash** as the
> default button. Nothing is wrong with the file: press **Done**, and either run it from
> Terminal (the `.dmg`'s READ ME FIRST.txt walks through it) or allow it once in
> **System Settings → Privacy & Security → Open Anyway**.

### Or from a terminal

**Windows — Command Prompt (cmd.exe, no PowerShell)**
```bat
curl -fsSLo "%TEMP%\qc-install.bat" https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.bat && "%TEMP%\qc-install.bat"
```
Uses the built-in `curl.exe` (Windows 10 1803+/11). Installs Node.js (via winget) and Claude Code if missing.

**Windows — PowerShell (alternative)**
```powershell
irm https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.ps1 | iex
```

**macOS / Linux / WSL / Git Bash**
```bash
curl -fsSL https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.sh | bash
```

Then open a **new** terminal and run:
```bash
qc-portal            # start the portal and open it in your browser
qc-portal --stop     # stop the running server
qc-portal --restart  # restart it
qc-portal --status   # is it running?
qc-portal --update   # update to the latest version and rebuild
qc-portal --version  # print the installed version
```
The portal runs as a single process on **http://127.0.0.1:5174** (override with `QC_PORT`); the
Express server serves both the API and the built web UI.

The **QC Portal** shortcut the installer created runs `qc-portal --app`, which is the same
server shown in its own window instead of a browser tab. If you would rather pin it from the
browser, Edge's install icon in the address bar does the same thing. Either way the server
has to be running — the window is a view onto it, not a copy of it. See
`docs/architecture/pwa.md` and `docs/architecture/installer.md`.

**To remove it:** `installer\windows\uninstall.ps1` (Windows) or
`bash installer/macos/uninstall.sh` (macOS/Linux). Both ask before deleting, and both leave
Node, Git and Claude Code alone.

## Develop (from a clone)

### Prerequisites
- Node 22.5+ (uses the built-in `node:sqlite`; this repo tested on Node 23).
- The `claude` CLI on your PATH (`claude --version`). Override with `QC_CLAUDE_BIN` if needed.

```bash
npm install
npm run dev          # starts server (5174) + web (5175) together
```
Open **http://localhost:5175**. The web dev server proxies `/api` and `/ws` to the backend.

### Production build
```bash
npm run build        # builds web + compiles server
npm start            # = qc-portal: serves API + UI on 5174 and opens the browser
```

## How a QC run works
1. **Run** page → enter ClickUp ticket id + app URL → **Run QC**.
2. Server spawns `claude -p "...use the qc-testing skill..." --output-format stream-json --permission-mode bypassPermissions`.
3. The stream-json output is parsed into phase/log events and pushed to the browser over WebSocket (live log + 7-phase stepper).
4. On finish, the server finds `testing/<ticket-slug>/`, parses `report.md` for Pass/Fail counts, and stores the run in SQLite. The **Run detail** page renders the report, issues, and screenshots.

## Pages
- **Projects** — register / edit / delete projects (each = an absolute path to a repo folder).
- **Run** — start a QC run on the active project, watch live progress.
- **History** — past runs with pass/fail counts (SQLite), scoped to the active project.
- **Skills** — list / edit / create skills under the active project's `.claude/skills/`.
- **MCP** — list / add / remove servers in the active project's `.mcp.json`.
- **Remote access** — publish the portal to a public HTTPS address over a Cloudflare Tunnel
  (one click to publish, one to stop), so you can run and review QC work from another machine
  or a phone. Requires [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  (`brew install cloudflared` / `winget install --id Cloudflare.cloudflared`) and an **access
  password** — the tunnel will not start without one, and every request arriving from outside
  has to enter it before any page or API responds. See
  [`docs/architecture/remote-access.md`](./docs/architecture/remote-access.md).

## Config (env vars)
| Var | Default | Meaning |
|-----|---------|---------|
| `QC_PORT` | `5174` | backend port |
| `QC_REPO_ROOT` | _(unset)_ | optional absolute path to auto-seed as the **default** project on first run; otherwise add projects via the Projects page |
| `QC_CLAUDE_BIN` | `claude` | path to the Claude CLI |
| `QC_DB_PATH` | `qc-portal/data/qc-portal.db` | SQLite file |
| `QC_CLOUDFLARED_BIN` | _(unset)_ | path to `cloudflared`, when it isn't on `PATH` (Remote access) |

> Projects are stored in SQLite, so they persist across restarts and moves of the `qc-portal/`
> folder. `QC_REPO_ROOT` only matters for seeding the first project on a brand-new database.

## Troubleshooting
MCP connection problems (ClickUp/Jira `failed`, empty Jira tickets, "conflicting scopes")
and their fixes live in [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md). Most common: ClickUp
and Jira run via `uvx`, so the machine needs Astral's [`uv`](https://docs.astral.sh/uv/)
installed (`winget install --id=astral-sh.uv -e` on Windows).

## Notes
- Binds to `127.0.0.1` only (local use), with no auth on that path. Reaching it from outside
  goes through **Remote access** — a Cloudflare Tunnel plus a mandatory access password — and
  never by exposing the port.
- Permissions are bypassed so the headless run never blocks on a prompt; the skill itself forbids
  mutating actions on the shared environment.
- `node:sqlite` is an experimental Node feature (warning suppressed in the npm scripts).
