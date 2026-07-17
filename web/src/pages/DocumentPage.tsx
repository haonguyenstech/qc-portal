import { useMemo, useState } from 'react'
import { NavLink, useNavigate, useParams } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  BellRing,
  BookOpen,
  ClipboardList,
  Compass,
  CornerDownRight,
  FileText,
  FolderGit2,
  History,
  KeyRound,
  Layers,
  LifeBuoy,
  NotebookPen,
  PlayCircle,
  Plug,
  Power,
  ScanSearch,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
  Ticket,
  Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// In-app user manual. Each topic is its OWN page (route /document/<id>) rather than
// one long scroll — a docs nav on the left switches between them. Content is authored
// inline as SECTIONS[] (no backend) so it ships with the build. Keep in step with
// CLAUDE.md when features change.

// Bump this whenever the manual's content changes — shown in the hero so readers know
// how current the docs are. Use a human-friendly date.
const LAST_UPDATED = 'July 16, 2026'

interface DocSection {
  id: string
  title: string
  icon: typeof BookOpen
  /** One-line blurb shown under the nav entry + used for search matching. */
  blurb: string
  /** GitHub-flavored Markdown body. */
  body: string
}

const SECTIONS: DocSection[] = [
  {
    id: 'overview',
    title: 'What is QC Portal',
    icon: BookOpen,
    blurb: 'The big picture and the architecture.',
    body: `
QC Portal is a **local web UI** that lets QC engineers run the **\`qc-testing\`** Claude Code skill
from the browser instead of the command line — across **multiple projects** — and manage each
project's skills and MCP servers.

It **wraps** Claude Code headless; it does **not** reimplement QC logic. The skill stays the brain;
the Portal is a **launcher + viewer + editor** around it.

### Architecture

It is a standalone monorepo with two parts, both running on your own PC (localhost):

| Part | Stack | Port | Job |
|------|-------|------|-----|
| **web** | React + Vite + Tailwind + shadcn/ui | **5175** | The UI — forms, tables, live logs, editors. |
| **server** | Node + Express + WebSocket + SQLite | **5174** | Spawns \`claude\` headless, streams progress, reads/writes \`.claude/skills\` + \`.mcp.json\`, stores run history. |

Open **http://localhost:5175**. The dev server proxies \`/api\` and \`/ws\` to the backend.

> **Localhost only.** The server binds \`127.0.0.1\` and there is no authentication — it is meant to
> run on your machine, against your own dev environments. Don't expose it to a network.
`,
  },
  {
    id: 'install',
    title: 'Install, update & run',
    icon: Power,
    blurb: 'Set it up, start/stop it, and keep it current.',
    body: `
### Install (end users)
The one-line installer checks for **Node 22.5+** and **Claude Code**, downloads the portal into
\`~/.qc-portal\`, builds it, and adds a \`qc-portal\` command to your PATH.

**Windows — Command Prompt (cmd.exe)**
\`\`\`bat
curl -fsSLo "%TEMP%\\qc-install.bat" https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.bat && "%TEMP%\\qc-install.bat"
\`\`\`

**Windows — PowerShell**
\`\`\`powershell
irm https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.ps1 | iex
\`\`\`

**macOS / Linux / WSL / Git Bash**
\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.sh | bash
\`\`\`

Open a **new** terminal afterwards so the \`qc-portal\` command is picked up on your PATH.

### Start, stop & everyday commands
Once installed, run these from any terminal:

| Command | What it does |
|---------|--------------|
| \`qc-portal\` | **Start** the server (if needed) and open it in your browser. |
| \`qc-portal --stop\` | **Stop** the running server. |
| \`qc-portal --restart\` | **Restart** the server. |
| \`qc-portal --status\` | Show whether the server is running. |
| \`qc-portal --update\` | Update to the latest version, rebuild, and restart. |
| \`qc-portal --version\` | Print the installed version. |
| \`qc-portal --help\` | List all commands. |

The portal runs as a **single process** on **http://127.0.0.1:5174** — one Express server serves both
the API and the built UI. Override the port with the \`QC_PORT\` environment variable.

### Updating
Three equivalent ways, all of which do \`git pull\` → \`npm install\` → build → restart:

- **From the app** — the sidebar footer shows an amber **Update available** badge when a newer build
  exists; click **Update now** to upgrade and reload in place.
- **From a terminal** — \`qc-portal --update\`.

> The **Release Notes** page has a **Check for updates** button that tells you whether a newer version
> exists — it doesn't update in place; it points you to run \`qc-portal --update\` (or use the footer's
> **Update now**).

If an in-app update doesn't come back, check **\`data/update.log\`** in the install folder for what went wrong.

### Run from a clone (developers)
**Prerequisites:** Node 22.5+ (uses the built-in \`node:sqlite\`) and the \`claude\` CLI on your PATH
(override with \`QC_CLAUDE_BIN\`).

\`\`\`bash
npm install          # install all workspaces
npm run dev          # server (5174) + web (5175) together
npm run build        # build the web UI, then compile the server
npm run typecheck    # typecheck both workspaces
npm start            # run the launcher; npm stop to stop it
\`\`\`

> In **dev** you open **http://localhost:5175** (Vite proxies \`/api\` + \`/ws\` to 5174). A **packaged**
> install serves everything from the single port **5174**.

### Data & uninstall
Projects and run history live in a local SQLite file under the install folder's \`data/\` (override with
\`QC_DB_PATH\`); your test artifacts live in each project's own \`testing/\` folder. To uninstall, run
\`qc-portal --stop\` and delete the install folder (\`~/.qc-portal\`).
`,
  },
  {
    id: 'concepts',
    title: 'Core concepts',
    icon: Layers,
    blurb: 'Projects, the skill, and the testing/ folder.',
    body: `
### Projects
The Portal is **not** inside any repo. You **register projects** (each an absolute path to a repo
folder) on **Settings → Projects**, and pick the **active project** in the sidebar's workspace
switcher. Every action — QC runs, crawls, test-case generation — happens **inside the active
project's folder**, so that project's skill, \`CLAUDE.md\`, \`.mcp.json\`, and \`testing/\` output are
all in scope.

### The \`qc-testing\` skill (the brain)
QC runs execute the project's \`qc-testing\` Claude Code skill headlessly. The Portal just launches
it, streams its progress, and shows the results. You manage the skill files on the **Skills** page.

### The \`testing/\` folder
Everything the Portal reads and writes for a project lives under \`<project>/testing/\`:

- \`testing/tickets/<ticket>/\` — crawled ClickUp tickets (description, comments, attachments) and
  their generated \`testcases/v<N>.md|csv\`.
- \`testing/test-result/<ticket-slug>/\` — QC run output: \`report.md\`, \`issues.md\`, evidence, screenshots.
- \`testing/knowledge/*.md\` — reference docs (specs, domain notes).
- \`testing/memory/*.md\` — durable fact notes (+ \`MEMORY.md\` index).
- \`testing/templates/*.md\` — test-case + design-check templates.

Two more folders sit at the **project root** (not under \`testing/\`): \`design-check/\` holds saved Design
Check reports, and \`source/\` holds the tagged repos cloned from the **Source Code** page
(one subfolder per repo, e.g. \`source/backend-repo\`).
`,
  },
  {
    id: 'quickstart',
    title: 'Quick start',
    icon: Compass,
    blurb: 'From zero to a finished QC run.',
    body: `
The typical end-to-end flow, in order:

1. **Register a project** — Settings → Projects → add the absolute path to your repo. Select it in
   the sidebar workspace switcher.
2. **Connect ClickUp** — add your ClickUp token on the **MCP** page (or in the project's Settings) so
   the Portal can read tickets.
3. **Connect tools (MCP)** — on the **MCP** page, enable Playwright (to drive a browser), Mobile (for
   native-app testing), and any others (e.g. Figma for Design Check).
4. **Add project context** — on **Instructions**, write a short \`CLAUDE.md\`, upload **Knowledge**
   docs, and jot **Memory** facts. This is what makes the AI use your real terms and rules.
5. **Crawl tickets** — on **Tickets**, pick the tickets you'll work on and crawl them locally.
6. **Generate test cases** — on **TestCase**, pick crawled tickets and let the AI draft them.
7. **Run the QC test** — on **Run**, pick the ticket, choose where to test (web, mobile web, or a native
   app), enter the app URL, and start. Watch it live on **Running**.
8. **Review** — open the run in **History** to read the report, issues, and screenshots — or
   **continue the session** in a terminal to keep working.
9. *(Optional)* **Design Check** — on **Design Check**, compare a ticket's build against its Figma design.
`,
  },
  {
    id: 'pages',
    title: 'Pages reference',
    icon: FileText,
    blurb: 'Every sidebar page, grouped.',
    body: `
The sidebar is grouped by purpose. Here's what each page does.

### Project
- **Overview** — the project's free-text intro (Markdown). Write it inline, or **upload a Word / PDF /
  Markdown / spreadsheet file** — it's converted to Markdown in your browser and loaded into the editor
  to review and save as the intro.
- **Source Code** — connect the project's Git repos, each with a tag (Backend repo, Frontend repo, …):
  clone GitHub / Bitbucket repos into \`source/\`, sync (re-pull), or disconnect per repo. Access
  tokens are stored locally only — never in git or logs.

### Testing
- **Tickets** — browse a **ClickUp or Jira** workspace/list (source toggle), multi-select tickets, and
  **crawl** them to disk (optionally with an AI \`summary.md\`). Crawled tickets are highlighted, show
  their test-case count, and can be deleted.
- **TestCase** — pick crawled tickets and have the AI **draft manual test cases** (Markdown or CSV),
  versioned per ticket. Supports a template, reusable rules, and an optional live App URL per ticket.
  CSV versions can be edited (whole-row), have rows deleted (with Undo), or a version deleted.
- **Run** — queue up to **10 tickets** (each its own run, one at a time) with an app URL (a per-ticket
  grid once you queue two or more) and a reachability **Check**; pick the **skill**, the **model**, and —
  for a single ticket — a test-case version to verify (with preview). **Mark bug** runs a ticket with no
  test cases as a repro. **Web** works today; mobile targets and **Feature** (related-tickets) mode are
  *Coming soon*.
- **Running** — live view of in-flight runs with the streaming 7-phase timeline and log. Each live run
  can **Stop**, a paused one **Resume** or **Discard**; the **"Up next"** queue below offers **Cancel**.
- **History** — past runs grouped by ticket with the full outcome breakdown (Passed · Failed · Blocked ·
  Untested · Cancelled) and pass-rate %; filter/search; open one for the report, issues, evidence, the
  executed test-case sheet, ClickUp issue push, and the **Continue session** terminal.
- **Design Check** — pick a crawled ticket + paste its Figma link (plus optional instructions and a
  checklist); the AI compares the **Figma design against the ticket** (reading the project's source via
  MCP when connected) and reports findings in five buckets (match / mismatch / concern / not sure /
  discuss). Pick the model; needs the **Figma and Playwright** MCP tools. Past checks are saved.
- **API Testing** — send any HTTP request from the portal (paste a **cURL** command to auto-fill it),
  add pass/fail **assertions**, get an automatic **QC & security scan** and an optional **AI check**
  against plain-language expectations, and keep every result as evidence.

### Configure
- **Instructions** — the project context hub, in five tabs: edit \`CLAUDE.md\`, manage **Knowledge**
  docs, write **Memory** notes, keep your **Accounts** (environments + test logins), and see the
  **AI Brain** map of how it all feeds a run.
- **Skills** — view/edit the project's \`.claude/skills\` (including \`qc-testing\`); **create** a new
  skill, **import** skills, **edit** a skill's name/description, **delete** one (type-to-confirm), and
  set a **default skill** that auto-selects on the Run page.
- **MCP** — manage \`.mcp.json\` servers (Playwright, Figma, ClickUp, Mobile) and test their live health.
- **Templates** — the project's reusable **test-case** and **design-check** templates.

### Tools
- **Terminal** — a real pseudo-terminal on your machine, opened in the active project's folder
  (it drops straight into a \`claude\` session).

### System
- **Settings** — **Projects** (register / edit / pin / remove, **export & import** a project as a
  \`.zip\`, and **Restart app**) and **AI models** (the AI runtime + the per-project AI automation
  toggles). Note: renaming a project **moves** its folder, and deleting one **removes it from disk** —
  see the Settings page for details.

> The **sidebar collapses** to icon-only via the toggle at its top, and the choice is remembered across
> reloads. The footer also links to **Release notes** (changelog + check-for-updates) and this
> **Documentation**; the **bell** (top-right) opens **Notifications**.
`,
  },
  {
    id: 'connect',
    title: 'Connecting services',
    icon: Plug,
    blurb: 'ClickUp, MCP tools, and source repos.',
    body: `
### ClickUp & Jira (ticket sources)
The Portal reads tickets from **ClickUp or Jira** — pick the source with the toggle at the top of the
**Tickets** page. Connect each with a personal API token on the **MCP** page (ClickUp can also be set
per project in **Settings**). Once connected, **Tickets** browses that source's workspace/project/list
and lets you crawl tickets locally. Tokens are scoped per project and never logged.

### MCP servers (tools the AI uses)
On the **MCP** page you manage the project's \`.mcp.json\` — the external tools a run can use. Each card
has an **info tooltip** explaining its purpose:

- **Playwright** — drives a real browser so the AI can open your app, click, and screenshot. Required
  for QC runs that exercise a live web app and for grounding test cases against a live URL. Before you
  connect it, a **Headless** checkbox sets whether the test browser is visible (headed by default, so
  you can watch the run) or hidden — to change it later, disconnect and reconnect.
- **Figma** — lets **Design Check** open a design file.
- **ClickUp** — ticket access from inside a run.
- **Jira** — ticket access from inside a run (site URL + email + API token).
- **Mobile** — drives a connected iOS/Android device or simulator, for native-app QC runs.

Each server shows **live health** (a real test call), not just whether it's in the config — and a
**Functional test** runs a real action through it (fetch a ticket, read a design, open a browser, list
devices). Use **Open folder** to jump to where \`.mcp.json\` lives.

> ClickUp, Figma, and Jira connect with a **personal API token**. Step-by-step instructions for
> creating each one are on the [Getting API tokens](/document/mcp-tokens) page.

> Some MCP args are machine-specific (e.g. a Playwright \`--user-data-dir\` profile path). Adjust them
> on the MCP page to match your machine.

### Source repositories
On **Source Code** you connect the project's Git repos — one or several, each with a **tag**
(Backend repo, Frontend repo, …). Paste a repository URL (with an optional branch and, for private
repos, an access token; Bitbucket also takes a username) and it clones into its own folder under
\`source/\`. Per repo you can **Sync** (re-pull), **Edit & reconnect**, or **Disconnect** (files stay
on disk). Giving the AI the real code helps QC runs, test-case generation, and Design Check reason about
actual field names and behavior. Access tokens are kept in a protected on-disk credential store —
**never** in the database, the git remote URL, or any log.

> Full walkthrough — including **how to create a GitHub or Bitbucket access token** — on the
> [Connecting source code](/document/source-code) page.
`,
  },
  {
    id: 'mcp-tokens',
    title: 'Getting API tokens',
    icon: KeyRound,
    blurb: 'Create ClickUp, Figma, Jira & Azure DevOps tokens step by step.',
    body: `
The **MCP** page connects ClickUp, Figma, Jira, and Azure DevOps with a **personal API token** — you
create the token on the provider's site, then paste it into the matching card. The **Connect** button
on each card already opens the right settings page in a new tab; this page walks through what to do
there.

Tokens are saved into the **active project's \`.mcp.json\`** on your own machine — they are scoped
per project, shown only masked afterwards, and **never logged**.

---

## ClickUp — step by step

1. Click **Connect** on the ClickUp card (or open
   **[app.clickup.com/settings/apps](https://app.clickup.com/settings/apps)** — avatar →
   **Settings** → **Apps**).
2. Under **API Token**, click **Generate** (or **Copy** if one already exists). Personal tokens
   start with \`pk_\`.
3. Back on the MCP page: paste the token into the ClickUp card and click **Save**.

The token acts as **you** — it sees the same workspaces, lists, and tickets your ClickUp account
sees.

---

## Figma — step by step

1. Click **Connect** on the Figma card (or open
   **[figma.com/settings](https://www.figma.com/settings)**), then go to the **Security** tab →
   **Personal access tokens**.
2. Click **Generate new token**. Name it (e.g. \`qc-portal\`) and set an expiration.
3. Under scopes, **File content: Read-only** is enough — Design Check only reads design files.
4. Click **Generate** and **copy it now** — it's shown once and starts with \`figd_\`.
5. Paste it into the Figma card and click **Save**.

---

## Jira — step by step

Jira needs **three** things, all entered on the card's connect form:

- **Site URL** — your Jira Cloud address, e.g. \`https://yourcompany.atlassian.net\`.
- **Account email** — the email you log in to Atlassian with.
- **API token** — created as follows:

1. Click **Connect** on the Jira card (or open
   **[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)** —
   Atlassian avatar → **Manage account** → **Security** → **API tokens**).
2. Click **Create API token** — pick the **plain API token**, *not* "API token with scopes".
   Scoped tokens authenticate but return **empty ticket lists or 401s** through the portal.
3. Name it (e.g. \`qc-portal\`), set an expiry, and **copy it now** — it's shown once and starts
   with \`ATATT\`.
4. Fill in Site URL + email + token on the Jira card and click **Save**.

> This is the same Atlassian API token used for private **Bitbucket** repos on the
> [Connecting source code](/document/source-code) page — one token can serve both.

---

## Azure DevOps — step by step

Azure DevOps needs **two** things (a third is optional), all entered on the card's connect form:

- **Organization URL** — your Azure DevOps org address, e.g. \`https://dev.azure.com/your-org\`.
- **Personal Access Token (PAT)** — created as follows.
- **Default project** *(optional)* — the board/project to read from by default; leave empty to
  work across all projects in the org.

1. Click **Connect** on the Azure DevOps card (or open
   **[dev.azure.com](https://dev.azure.com)** and sign in to your org).
2. Top right, click the **User settings** gear → **Personal access tokens** (URL shape:
   \`https://dev.azure.com/your-org/_usersSettings/tokens\`).
3. Click **New Token**. Name it (e.g. \`qc-portal\`), pick the **Organization** it applies to, and set
   an expiration.
4. Under **Scopes**, choose **Custom defined** and grant **Work Items → Read** (this is enough to pull
   bugs, user stories, and tasks from Boards). Add **Code → Read** too only if you also want it to read
   repos.
5. Click **Create** and **copy it now** — the PAT is shown once (a long opaque string, no fixed prefix).
6. Back on the MCP page: fill in **Organization URL** + PAT (+ optional **Default project**) on the
   Azure DevOps card and click **Save**.

The PAT acts as **you** — it sees the same organizations, projects, and work items your Azure DevOps
account sees, limited to the scopes you granted.

---

### Where your token goes (security)

- Tokens are written into the project's **\`.mcp.json\`** (env vars for that MCP server) on the
  machine running the portal — never into the database or any log.
- The connected card shows a **masked preview** with a reveal/copy option, and **Disconnect**
  removes the entry again.
- Rotating a token = create a new one at the provider, **Disconnect**, and reconnect with the new
  value.

### Troubleshooting

- **Card shows \`failed\` after connecting (ClickUp / Jira)** — those servers run via \`uvx\`, so
  **Astral's \`uv\`** must be installed on the machine running the portal. The MCP page shows a
  warning with a copy-able install command when it's missing.
- **Jira connects but lists no tickets / 401** — the token is a *scoped* "API token with scopes".
  Create a plain (classic) API token instead, per the steps above.
- **Azure DevOps shows \`failed\` right after connecting** — this server runs via \`npx\` (Node, not
  \`uv\`), so **Node.js** must be installed, and the first connection **downloads the server package**,
  which can briefly show \`failed\`/\`pending\` until it finishes. Wait a moment and use **Functional
  test** again.
- **Azure DevOps connects but returns nothing / 401 or 403** — the PAT is missing the **Work Items →
  Read** scope, is scoped to the wrong **organization**, or the **Organization URL** doesn't match the
  org the PAT was created in. Recreate the PAT with Work Items Read and confirm the org URL.
- **Figma test fails** — the token may be expired or missing the **File content: Read** scope;
  generate a fresh one.
- Use each card's **Functional test** to verify the connection with a real action (fetch a ticket,
  read a design file).
`,
  },
  {
    id: 'source-code',
    title: 'Connecting source code',
    icon: FolderGit2,
    blurb: 'Clone the repo & create access tokens.',
    body: `
The **Source Code** page connects the project's Git repositories so the AI reads the **real code**
(true field names, validation rules, screens, roles) when writing test cases, running QC, and
checking designs — instead of guessing from the ticket alone.

A project can connect **multiple repositories**, each with a **tag** that tells the AI what it is —
**Backend repo**, **Frontend repo**, **Mobile repo**, … Each repo clones into its own folder under
\`source/\` (the folder name comes from the tag, e.g. \`source/backend-repo\`), and the AI is told
about every tagged repo so it looks in the right one for the ticket at hand.

### Connect a repository

1. Open **Source Code** in the sidebar (Project group).
2. Paste the repository's **HTTPS URL** — e.g. \`https://github.com/owner/repo.git\` or
   \`https://bitbucket.org/workspace/repo.git\`. (An SSH URL like \`git@github.com:owner/repo\`
   is accepted and converted to HTTPS automatically.)
3. Give it a **tag** — pick a suggestion (Backend repo, Frontend repo, …) or type your own.
   Left empty, the repo's own name is used. Tags must be unique within the project.
4. *(Optional)* Enter a **branch** — leave empty for the repo's default branch.
5. **Private repo?** Paste an **access token** (see below). Public repos need no token.
   Each repository keeps its **own** token, so a Backend and a Frontend repo can use different ones.
6. Click **Connect & clone**. The clone runs as a background job with a live log.
7. **Add repository** connects the next repo the same way — repeat for every repo the
   project spans.

Each connected repo gets its own card showing the tag, branch, last commit, last sync, and auth
scheme. Per repo you can **Sync** (pull the latest, fast-forward only), **Edit & reconnect**
(the form reopens prefilled with the repo's URL, tag, and branch — change any of them, or paste a
new token, and it re-clones; leaving the token empty **keeps the saved one**), **Disconnect**
(unlink it — the files stay on disk), or open its folder. One clone/sync runs at a time per project.

### The source map (why syncing saves tokens)

After every clone/sync that brings new commits, the portal runs **one cheap AI pass** over the repo
and saves a compact **source map** — the repo's screens/routes, domain models, and where validation
and permissions live, with file paths — into **Instructions → Knowledge** as
\`source-map-<tag>.md\` (flagged with the AI badge; you can **preview** or **delete** it like any
knowledge doc — it regenerates on the next sync with new commits).

This map is what keeps repeated AI work cheap: test-case generation and QC runs get the map in
their context and **jump straight to the files it names** instead of re-exploring the repository
every time. A sync that brings no new commits keeps the existing map (no AI pass). Disconnecting a
repo removes its map; reconnecting regenerates it.

---

## GitHub — step by step

**Copy the repository URL.** On the repo page click the green **Code** button → **HTTPS** → copy
(e.g. \`https://github.com/owner/repo.git\`). Public repo? Paste it and connect — you're done.
Private repo? Create a token first:

### Option A — fine-grained personal access token (recommended)

Read-only, scoped to just this repo — the safest choice.

1. Open **[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens)**
   (or navigate: your avatar → **Settings** → **Developer settings** → **Personal access tokens** →
   **Fine-grained tokens**).
2. Click **Generate new token**. Give it a name (e.g. \`qc-portal\`) and an expiration.
3. If the repo belongs to an **organization**, set **Resource owner** to that org (the org must allow
   fine-grained tokens; ask an org admin if it's not listed).
4. Under **Repository access** choose **Only select repositories** → pick the repo.
5. Under **Permissions → Repository permissions**, set **Contents = Read-only**. Nothing else is
   needed for cloning ("Metadata: Read" is added automatically).
6. Click **Generate token** and **copy it now** — it's shown once and starts with \`github_pat_\`.
7. Back on **Source Code**: paste the repo URL + the token → **Connect & clone**.

### Option B — classic personal access token

1. Open **[github.com/settings/tokens](https://github.com/settings/tokens)** → **Generate new token
   (classic)**.
2. Tick the **\`repo\`** scope, set an expiration, generate, and copy the \`ghp_…\` token.
3. If your org enforces **SAML SSO**, go back to the token list and click **Configure SSO** →
   **Authorize** for that org, or the clone will be rejected.

GitHub tokens authenticate on their own — there is **no username field** for GitHub URLs; the portal
supplies the right git user (\`x-access-token\`) automatically.

---

## Bitbucket — step by step

**Copy the repository URL.** On the repo page click **Clone** → switch to **HTTPS** → copy the URL
(e.g. \`https://bitbucket.org/workspace/repo.git\` — if it contains \`you@bitbucket.org\`, that's fine,
the portal strips it). For a private repo, pick ONE of these three credentials.

> ⚠️ **The #1 cause of a failed Bitbucket clone** is a **403 — "API Token provided has no Bitbucket
> scopes."** It means you created a *plain* Atlassian API token, which grants **no** Bitbucket access.
> If you hit this, use **Option A (app password)** or **Option B (access token)** below — they always
> work — or recreate the API token **with scopes** (Option C).

### Option A — app password (simplest, always works) ✅

Recommended for QC engineers — no admin rights needed, and it can't hit the "no scopes" error:

1. Bitbucket avatar (bottom-left) → **Personal settings** → **App passwords** → **Create app password**.
2. Name it (e.g. \`qc-portal\`), tick **Repositories: Read**, create, and **copy the password now**
   (shown once).
3. On **Source Code**: paste the repo URL + the app password into **Access token**, **and fill in
   Username** with your Bitbucket username — the short handle shown at the top of **Personal settings**,
   **not** your email. This is the one case where the Username field is required.

### Option B — repository / workspace access token ✅

Scoped to a single repo (or workspace) — needs repo-admin rights, but never hits the scopes error:

1. In the repo: **Repository settings** → **Security** → **Access tokens** → **Create repository
   access token**. (Workspace: **Workspace settings** → **Access tokens**.)
2. Name it and give it the **Repositories: Read** scope only.
3. Copy the \`ATCTT…\` token, paste it into **Access token**, and **leave Username empty** — the
   portal supplies the fixed \`x-token-auth\` user automatically.

### Option C — Atlassian API token (must add Bitbucket scopes)

Works account-wide, but a *scoped* token is required — a plain one is rejected by Bitbucket:

1. Open **[id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)**.
2. Click **Create API token with scopes** (NOT the plain "Create API token"). Name it, set an expiry.
3. Choose **app: Bitbucket**, then select the scope **\`read:repository\`** (add **\`read:pullrequest\`**
   too if you like). Without a Bitbucket scope the clone fails with **403 — no Bitbucket scopes**.
4. **Copy it now** — it starts with \`ATATT\`. On **Source Code**: paste the repo URL + the token, and
   **leave Username empty** — the portal fills in \`x-bitbucket-api-token-auth\` automatically.

> **Two most common Bitbucket mistakes:**
> 1. **Plain (unscoped) API token** → 403 "no Bitbucket scopes." Use Option A/B, or recreate it
>    *with scopes* (Option C).
> 2. **Username filled in next to an \`ATATT…\` API token** — the portal now detects \`ATATT\` and
>    ignores the username, but the rule of thumb stays: **Username is for app passwords only.**

---

### Where your token goes (security)

- The token is stored **only on this machine**, in a permission-restricted local credential file —
  **never** in the database, never in the cloned repo's \`.git/config\` (the saved remote is
  tokenless), and never in any log (output is scrubbed).
- The connected card shows a masked preview (\`****\` + last 4 characters) and a copy button so you
  can retrieve it later.
- Disconnecting (or changing the repository) removes the stored credential.

### Troubleshooting

- **Bitbucket 403 — "API Token provided has no Bitbucket scopes"** — your Atlassian API token is
  *unscoped* (the plain **Create API token** gives one that works for Jira/Confluence but not
  Bitbucket). Fix it with **Option A (app password)** or **Option B (repository access token)** above
  — the fastest fix — or recreate the API token via **Create API token with scopes** and add
  **\`read:repository\`** for **app: Bitbucket** (Option C).
- **"Authentication failed" / asked for a password** — the token is wrong, expired, or lacks read
  access to that repo. Create a fresh one per the steps above. The job log's \`Auth:\` line shows
  which scheme was tried.
- **Bitbucket \`ATATT…\` token fails with a username filled in** — clear the Username field; API
  tokens must authenticate via their own static user, and the portal handles that automatically.
- **"git is not installed or not on PATH"** — install Git on the machine running the portal.
- **"source/ already exists and is not empty"** — the folder holds non-git files; remove it or
  disconnect the previous source first.
- **Sync fails with a fast-forward error** — someone edited the clone locally. The portal never
  force-overwrites; resolve or delete \`source/\` and reconnect.
`,
  },
  {
    id: 'qc-runs',
    title: 'Running a QC test',
    icon: PlayCircle,
    blurb: 'Phases, live progress, report, continue session.',
    body: `
### Starting a run
On **Run**, pick one or more **crawled tickets** (up to **10** — each becomes its **own** QC run,
executed strictly **one at a time**), give it an **app URL** (a single shared field for one ticket, or
a per-ticket grid once you queue two or more), pick a model, and start. Extras on the form:

- **Skill** picker — choose which \`.claude/skill\` runs (defaults to the project's default skill, or
  \`qc-testing\`), with a link to edit it.
- **Check** button next to the app URL — probes the URL server-side and reports "Reachable · HTTP 200"
  (or a plain-language error and the final redirect) before you launch.
- **Test-case version** picker (single ticket only) with an **eye** button to preview the exact version
  the run will verify.
- Reusable form **presets**, and quick-add instruction **hints** (canned lines appended to the run's
  AI instructions, managed in a dialog).
- **Mark bug** — a per-ticket toggle for a ticket that has **no test cases**: the run reproduces the
  reported issue and judges Pass/Fail on whether it's fixed, instead of running a test-case sheet.
- **Where to test** — **Web** (desktop browser via Playwright) works today; **Web on mobile** and
  **App on device** (native, via Mobile MCP) are shown as **Coming soon**. Advanced **Feature** mode
  (multiple related tickets as one connected workflow) is likewise **Coming soon**.

When a run needs to sign in, it uses the **environments + test accounts** from **Instructions →
Accounts** (real URL and credentials) instead of a placeholder.

The Portal spawns \`claude\` headless in the project folder with permissions bypassed (so it never
blocks on a prompt) and runs the \`qc-testing\` skill through its **7 phases**: intake → plan → setup
→ collect → analyze → aggregate → report.

### Watching it
**Running** streams live events over WebSocket — the current phase, the AI's narration, each tool
call (browser clicks, reads, writes), and tool results. When you queued several tickets, an **"Up
next"** list shows the waiting tickets with their position and a Cancel. A pulsing badge in the sidebar
shows how many runs are live from any page.

### Results
When a run finishes it writes \`report.md\` + \`issues.md\` (and screenshots/evidence) under
\`testing/test-result/<ticket-slug>/\`. Opening a run shows:

- the full rendered **report** and the **issues** list (screenshots are clickable), across **Report**,
  **Screenshots**, **Files**, and **Log** tabs,
- a **Test execution results** table (at the bottom of the Report tab) — the ticket's test cases cloned and filled with each case's
  Passed / Failed / Blocked / Untested / Cancelled status, with Reference cells that deep-link to the
  matching issue. The same sheet is saved to disk as \`testcases-executed.<ext>\` — a ready-to-file QC record.
- **Push issues to ClickUp** — paste the parent ticket URL, select the logged issues, and the portal
  creates them as **subtasks** (with the screenshots attached).
- **Delete run** — removes the history entry, event log, and the whole on-disk output folder (behind a
  confirm; an active run can't be deleted).

**History** groups past runs by ticket with the five-bucket outcome breakdown (Passed · Failed ·
Blocked · Untested · Cancelled) and a decision pass-rate %. Filter by All / Passed / Failed / Active,
search by ticket / project / URL, and expand or collapse all.

### When a run fails without a report
A **"Why it failed"** panel classifies the cause in plain language — a hung/disconnected Playwright
browser, an MCP server not responding, a network/connection error, the server interrupted mid-run, or
an unexpected exit — with the exact log line, a suggested fix, and one-click **View full log**.

### Continue session
A run's Claude session is **kept alive after the report is written**. On a run's detail page, the
**Continue session** panel is a real interactive terminal wired to \`claude --resume\` for that exact
session — so you can ask follow-ups or have it fix something without starting over.

> QC runs **never commit mutating actions** on a shared environment — the skill forbids it. Treat the
> app URL as a dev/staging target.
`,
  },
  {
    id: 'testcases',
    title: 'Tickets & test cases',
    icon: ClipboardList,
    blurb: 'Crawl, generate, version, and ground.',
    body: `
### Crawling
On **Tickets**, choose your ticket source — **ClickUp or Jira** (a toggle at the top; both browse and
crawl the same way) — select tickets, and crawl. Each one's description, comments, \`ticket.json\`, and
attachments download into \`testing/tickets/<ticket>/\`. Crawling runs as a **background job** you can
navigate away from; you'll get a notification when it finishes. Optionally pick a model to also write
an AI **summary.md** per ticket. You can **bind the project to a specific ClickUp list** ("Use a list")
so Tickets browses just that list instead of the whole workspace, and **delete** a crawled ticket's
downloaded files (a warning appears if the folder also holds generated test cases).

### Generating test cases
On **TestCase**, pick up to **5 crawled tickets** (fewer is better — each is its own AI run), pick the
**model** (Haiku / Sonnet / Opus), and generate. Filter the list by test-case presence (All / With test
cases / Without). You can attach a **template** — **Markdown, CSV, or Excel (.xlsx/.xls)**, the
spreadsheet converted to CSV in your browser (the AI matches its columns/format, and CSV templates
yield a real importable CSV) — toggle **rules** (happy path, negative, boundary, security, …) that
shape coverage, and give each ticket an optional **live App URL** (with a **"set one for all"** field to
apply a single URL across the batch) so the AI grounds the cases in the running app. The job runs in the
background with **Pause / Resume / Cancel** and a live log — and you can run **up to 3 generations in
parallel** (start one, pick more tickets, and Generate again; each gets its own log).

Output is **versioned** per ticket: \`testcases/v1.md\`, \`v2.csv\`, … Open the preview to switch
versions (or delete a whole version). For **CSV** versions you can also edit in place:

- **Click any cell** to open a row editor and change every field of that test case.
- **Click the trash icon on a row** to delete that single test case — a confirm dialog guards it, and
  after deleting an **Undo** banner lets you put the row back exactly where it was.

### App URLs & test accounts
If a case needs a login, the AI uses the **environments + test accounts** you saved on the
**Instructions → Accounts** tab (real URL and credentials), rather than a placeholder.

### How the AI uses your Knowledge
Test-case generation **injects the project's Knowledge + Memory directly into the prompt**, so the AI
uses your real screen/field names, roles, and business rules instead of guessing — while staying
within the ticket's scope.

### Grounding check (anti-hallucination)
After writing, an **independent, cheap second pass** audits the cases against the ticket **and** your
project knowledge, and silently rewrites the saved version to drop anything invented (fields, screens,
or acceptance criteria that neither the ticket nor your knowledge supports) — keeping legitimate edge
and negative coverage. It's best-effort and never blocks generation. Toggle it per project on
**Settings → AI models**.
`,
  },
  {
    id: 'design-check',
    title: 'Design Check',
    icon: ScanSearch,
    blurb: 'Compare a Figma design against the ticket.',
    body: `
**Design Check** pairs a crawled ticket with its **Figma link**. The AI opens the Figma design (and
reads the project's source code via MCP when a repo is connected), checks it against the ticket's
requirements, and reports findings in **five** buckets:

- **match** — the design agrees with the ticket's requirements,
- **mismatch** — the design conflicts with them,
- **concern** — something worth a closer look,
- **not sure** — the AI couldn't verify it (e.g. it couldn't open part of the design),
- **needs discussion** — a judgment call for the team.

It needs both the **Figma** and **Playwright** MCP tools connected, and you can pick the **model**
(Haiku / Sonnet / Opus). You can add free-text **instructions** ("what to focus on / what to ignore") for a one-off check, and
attach a one-off **checklist** — or save a project-wide **design-check** checklist on the **Templates**
page that the check always applies (the model reports a finding per checklist item). Findings render as
grouped cards, and every check is saved to a **history** list you can reopen.
`,
  },
  {
    id: 'api-testing',
    title: 'API Testing',
    icon: Zap,
    blurb: 'Requests, environments, assertions, scan & AI-check.',
    body: `
The **API Testing** page (sidebar → Testing → API Testing) lets you send any HTTP request from the
portal and keep the result as evidence — no external tool needed.

### Building & sending a request
Set the **method**, **URL**, query params, headers, and body — or paste a **cURL** command straight
from your browser's DevTools (or an app) and the page fills all of that in for you. You can copy the
request back out **as cURL** at any time. Saved requests live **per project**: they **auto-save on any
change**, rename with the pencil icon, and ask before deleting.

### Environments & variables
Use the **Environment** bar above the URL to define reusable **{{variables}}** — put values like a
\`baseUrl\` or \`token\` in one place and write \`{{baseUrl}}/users\` or an \`Authorization: Bearer {{token}}\`
header instead of repeating them. Open **Manage** to keep several **named environments** side by side
(e.g. *staging* and *prod*), each with its own values, and switch the active one from the dropdown —
the same saved requests then run against whichever server is active. Variables are substituted **on the
server** when you Send, so they work anywhere a value goes: URL, params, headers, or body.

Mark a value **secret** (the key icon) for tokens and passwords: it's stored but **never sent back to
the browser** and never shown in the saved result — the field reads *"•••• stored"* and you leave it
blank to keep it. If you type a \`{{name}}\` that isn't defined, Send tells you which one is missing.

### Capture (chaining requests)
On the **Capture** tab, pull a value out of one response into a variable for the next request — the
classic **log in → grab the token → call an authenticated endpoint** flow. Give a **JSON path**
(e.g. \`data.token\`) and a **variable name** (e.g. \`token\`, optionally secret); after each Send the
value is written into the active environment automatically, ready to use as \`{{token}}\`. If there's
no active environment yet, one named *Default* is created for you.

### Assertions (pass/fail checks)
Add checks with quick-add presets — **status is 2xx / equals**, **body contains / matches**,
**JSON path equals / exists**, **header equals / exists**, **response time under N ms** — and after
every Send each row is coloured green or red with a **pass/total** bar.

### Automatic QC & security scan
Every response is graded for common issues — plain HTTP, missing security headers (HSTS, nosniff,
CSP, clickjacking), permissive CORS, server/version disclosure, insecure cookies, leaked stack
traces / SQL errors / secrets / PII, wrong or missing Content-Type, slow or oversized responses —
bucketed **high / warning / info**.

### AI check against plain-language expectations
Type what the response *should* do (or pick from quick-select criteria chips) and an **AI verdict** —
pass / partial / fail with per-point reasons and flagged issues — runs **automatically right after
each Send** when an expectation is set.

### Result history
Every Send on a saved request is stored under \`testing/api-tests/\` (newest 30 kept), so you keep a
trail of what you tested and what came back.
`,
  },
  {
    id: 'context',
    title: 'Instructions, Knowledge & Memory',
    icon: FileText,
    blurb: 'Everything the AI reads on every run.',
    body: `
The **Instructions** page is the single place for *everything Claude reads on every run*, split into
five tabs so guidance stays organized instead of crammed into one giant file:

1. **Instructions** — the lean root **\`CLAUDE.md\`** editor (Edit ⇄ Preview).
2. **Knowledge** — upload project docs (**Word, PDF, Markdown/TXT, CSV, Excel**) — one or several at
   once, with per-file conversion progress; they're converted to Markdown **in the browser** and stored
   under \`testing/knowledge/\`. **Preview** or **delete** them here (uploaded docs aren't edited in the
   UI). Use these for specs, requirements, and domain notes.
3. **Memory** — small notes, one durable fact each (decisions, gotchas, conventions), written directly
   in the portal with a **name**, a one-line **description** (shown in the \`MEMORY.md\` index), and the
   fact. Stored under \`testing/memory/\` with an auto-built \`MEMORY.md\` index. A note's **name is fixed
   once created** (make a new note to rename), and each carries an **AI** or **Manual** badge showing who
   wrote it.
4. **Accounts** — the project's app URLs and **test-account logins** (see below).
5. **AI Brain** — a visual map of everything Claude knows about the project: how \`CLAUDE.md\`,
   Knowledge, and Memory connect and feed each QC run. Read-only — nothing to edit here.

### Accounts — environments & test logins
Keep your app **environment URLs** and **test-account credentials** in one place: upload a CSV/Excel
sheet (converted to a table right in your browser) or type it in by hand, with columns **Environment,
URL, Role, Username, Password, Notes** (a **Download example** button hands you a ready-to-fill
template). Claude then uses the **real** URL and account for a "log in as …" step — in both test-case
generation and full QC runs — instead of inventing a \`<System account>\` placeholder. Runs pick up
changes the next time they start.

> ⚠️ The sheet is stored as **plain text** in the project (\`testing/environments.md\`) and read by
> Claude. Put only **throwaway QA/staging** test accounts there — never real user or production
> credentials.

### How context actually reaches the AI
- **QC runs** spawn \`claude\` in the project root, so a managed pointer block in \`CLAUDE.md\` directs it
  to read \`testing/knowledge/*.md\` and \`testing/memory/*.md\`.
- **Test-case generation** has no project working directory, so the Portal **injects** the Knowledge +
  Memory straight into the prompt (capped, memory first). Either way, your context gets used.

### AI auto-capture (knowledge that updates itself)
After a QC run or a test-case generation, a cheap reflection step can persist durable facts it learned
into Memory/Knowledge, flagged with an **"AI" badge** so you can review and delete them. **Editing a
Memory note** in the UI claims it as yours (its badge flips to **Manual**); Knowledge docs are
**preview-or-delete** only. Toggle it per project on **Settings → AI models**.
`,
  },
  {
    id: 'ai-automation',
    title: 'AI automation',
    icon: ShieldCheck,
    blurb: 'Grounding check & auto-learn, per project.',
    body: `
Two best-effort AI passes run around your artifacts, both controlled **per active project** on
**Settings → AI models** (an On/Off pill + a model picker each, auto-saved):

### Grounding check
An **independent second pass** that catches and silently corrects hallucination right after the Portal
writes an AI artifact:
- **Test cases** → audited against the ticket + your project knowledge; ungrounded content is dropped/fixed.
- **QC reports** → any **Pass** verdict not backed by documented evidence is downgraded to Fail/Partial
  with an "(unverified)" note, so the pass/fail counts can't be inflated by a hallucinated pass. The
  pre-audit report is kept as \`report.pre-grounding.md\`.

It uses a cheaper model than the writer (which is what catches the writer's self-consistent mistakes),
is capped to a small budget, and **never blocks or fails** the underlying work.

### Auto-learn
The auto-capture step described under *Instructions, Knowledge & Memory* — turns finished runs into
durable Memory/Knowledge.

> New projects inherit defaults from the \`QC_GROUNDING_CHECK\` / \`QC_AUTO_LEARN\` environment variables;
> after that, each project's own toggles win and are read live on every run.
`,
  },
  {
    id: 'settings',
    title: 'Settings & models',
    icon: SlidersHorizontal,
    blurb: 'Projects, models, and templates.',
    body: `
**Settings** (under **System** in the sidebar) has two tabs driven by the \`?tab=\` query param.

### Projects (\`?tab=projects\`)
Register a project by its absolute repo path — the **folder browser** is an in-portal filesystem picker
(drive chips on Windows; type or paste a path; a **New folder** button creates and selects one). Edit a
project's name / ClickUp token / source binding, pin it to the top, or remove it. A red dot marks a
project whose folder no longer exists, and **Init** scaffolds any missing \`CLAUDE.md\` / \`qc-testing\`
skill / \`.mcp.json\`. Each card shows health chips (Skills / MCP / CLAUDE.md) and a readiness pill.

> ⚠️ **Renaming and deleting touch the folder on disk.**
> - **Renaming** a project **moves its folder** to match the new name — you confirm a From → To preview
>   first, and a warning notes that running jobs would break.
> - **Deleting** a project **permanently removes its folder from disk, recursively** (report, evidence,
>   crawled tickets, everything under it) — you must **type the project name** to confirm. Deletion is
>   blocked while the project has a running job, and refused for broad system/user roots.

**Export & import (\`.zip\`).** Each project card has a **Download** button that exports the project's
\`CLAUDE.md\`, \`.claude/skills\`, \`.mcp.json\`, and \`testing/\` folder as a single \`.zip\`. **Import project**
restores such a zip into a destination folder you pick and registers it — handy for moving a configured
project between machines.

**Restart app.** A **Restart app** card restarts the whole portal server from inside the UI (with a
confirmation that in-flight jobs are interrupted); the page auto-reloads once it's back — the same as
running \`qc-portal --restart\` in a terminal.

### AI models (\`?tab=models\`)
- **AI runtime** — the global Claude install/binary status and per-model availability (a smoke test for
  sonnet/opus/haiku).
- **AI automation** — the active project's **Grounding check** and **Auto-learn** toggles + model
  pickers (see the AI automation page).

### Templates (its own sidebar page)
The **Templates** page (separate from Settings) manages plain-text files under \`testing/templates/\`:
- **testcase** — the structure the AI matches when drafting test cases (a per-run upload still overrides it).
- **design-check** — the project's standard Design Check checklist.
`,
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: TerminalSquare,
    blurb: 'A real shell in the project folder.',
    body: `
The **Terminal** page is a real pseudo-terminal on the machine running the server, rendered in the
browser. **Connect** opens your **login shell** with the working directory set to the **active project's
root** — from there you can run anything, including typing **\`claude\`** to start a session;
**Disconnect** (or closing the tab) kills the shell. One shell per connection — nothing persists across
reconnects, and **switching the active project** disconnects the current shell (Connect again to reopen
in the new folder).

It behaves like a native terminal, so interactive TUIs work. The same engine powers **Continue session**
on a run's detail page (which instead resumes that run's \`claude\` session directly).
`,
  },
  {
    id: 'notifications',
    title: 'Notifications & jobs',
    icon: BellRing,
    blurb: 'Long tasks that survive navigation.',
    body: `
Crawling, test-case generation, Design Check, and source clone/sync all run as **server-side background
jobs**. That means you can start one and freely navigate away or reload — the job keeps running and the
page reconnects to its live progress when you return.

When a job finishes, an always-mounted watcher fires a **toast** and adds an entry to the **bell**
(top-right) — even if you'd left the page that started it, as long as the portal is still open in a
browser tab (the bell and its history live in that browser, capped locally). The **Notifications** page
is the full history. A job itself is lost only if the **server** restarts mid-run.
`,
  },
  {
    id: 'config',
    title: 'Configuration (env vars)',
    icon: Settings,
    blurb: 'Environment variables and defaults.',
    body: `
Most configuration is in the UI; these environment variables tune the server and seed defaults.

| Variable | Default | Meaning |
|----------|---------|---------|
| \`QC_PORT\` | \`5174\` | Backend port. |
| \`QC_REPO_ROOT\` | *(unset)* | Absolute path to auto-seed as the default project on first run only. |
| \`QC_CLAUDE_BIN\` | \`claude\` | Path to the Claude CLI. |
| \`QC_DB_PATH\` | \`data/qc-portal.db\` | SQLite file (projects + run history). |
| \`QC_GROUNDING_CHECK\` | \`1\` (on) | **Default for new projects** — grounding check on/off. |
| \`QC_GROUNDING_CHECK_MODEL\` | \`haiku\` | Default grounding-check model for new projects. |
| \`QC_AUTO_LEARN\` | \`1\` (on) | **Default for new projects** — AI auto-capture on/off. |
| \`QC_AUTO_LEARN_MODEL\` | \`haiku\` | Default auto-learn model for new projects. |

> The grounding/auto-learn env vars only seed **new** projects. Existing projects use their own
> per-project toggles on **Settings → AI models**.

### Advanced — MCP OAuth (optional)
Most people connect MCP tools with a **personal API token** (see *Getting API tokens*) and never need
these. They're only for the optional **OAuth** connect flow, and configure your own registered OAuth
apps:

| Variable | Default | Meaning |
|----------|---------|---------|
| \`QC_OAUTH_REDIRECT_BASE\` | \`http://localhost:$QC_PORT\` | Base URL providers redirect back to; the callback is \`<base>/api/mcp/oauth/<provider>/callback\`. |
| \`CLICKUP_OAUTH_CLIENT_ID\` / \`CLICKUP_OAUTH_CLIENT_SECRET\` | *(unset)* | Your ClickUp OAuth app credentials. |
| \`FIGMA_OAUTH_CLIENT_ID\` / \`FIGMA_OAUTH_CLIENT_SECRET\` | *(unset)* | Your Figma OAuth app credentials. |
| \`FIGMA_OAUTH_SCOPE\` | \`file_read\` | Figma OAuth scope requested. |
`,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting & FAQ',
    icon: LifeBuoy,
    blurb: 'Common snags and fixes.',
    body: `
**A page says the project folder doesn't exist (red dot).** The registered path moved or was deleted.
Edit the project path on Settings → Projects, or re-create it.

**Does removing a project delete my files?** Yes — **deleting** a project on Settings → Projects
**permanently removes its folder from disk, recursively** (you type the name to confirm). To keep the
files, use **Download** (export a \`.zip\`) first, or just unpin/leave it. Renaming a project **moves**
its folder to match the new name.

**A QC run won't start / claude not found.** Check **Settings → AI models → AI runtime** for the Claude
binary status. Set \`QC_CLAUDE_BIN\` to the CLI's full path if it isn't on \`PATH\`.

**The AI uses wrong field/screen names.** Add the real terms as **Knowledge** docs or **Memory** notes
on the Instructions page — test-case generation injects them into the prompt, and QC runs read them.

**An MCP tool shows unhealthy.** Open the **MCP** page; the status comes from a live test call. Fix the
command/args (Playwright profile paths are machine-specific) and re-test.

**The Terminal page says it's unavailable.** The native PTY module couldn't load on this machine; the
rest of the portal still works.

**A background job vanished.** Jobs live in server memory — a server restart drops in-flight crawls,
generations, and design checks. Re-start the job.

**Test cases look truncated after the grounding check.** The check refuses to apply a rewrite that
loses too much, so it keeps the original — re-generate, or lower/raise the grounding model on Settings.

**Where are my files?** Everything is under \`<project>/testing/\` — tickets, test cases, run reports,
knowledge, and memory. Most pages have an **Open folder** button to jump straight there.
`,
  },
]

// Rich prose styling for the rendered Markdown (no typography plugin needed).
const PROSE = cn(
  '[&>*:first-child]:mt-0',
  '[&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-foreground',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:tracking-tight [&_h3]:text-foreground',
  '[&_hr]:my-6 [&_hr]:border-border/60',
  '[&_p]:my-2.5 [&_p]:text-sm [&_p]:leading-relaxed [&_p]:text-muted-foreground',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5',
  '[&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5',
  '[&_li]:text-sm [&_li]:leading-relaxed [&_li]:text-muted-foreground [&_li]:marker:text-muted-foreground/50',
  '[&_li>strong]:text-foreground',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8em]',
  '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:border [&_pre]:border-border/60 [&_pre]:bg-muted/70 [&_pre]:p-3.5',
  '[&_pre_code]:block [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs [&_pre_code]:leading-relaxed',
  '[&_blockquote]:my-3 [&_blockquote]:rounded-r-lg [&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:bg-muted/50 [&_blockquote]:px-4 [&_blockquote]:py-2',
  '[&_blockquote_p]:my-1 [&_blockquote_p]:text-foreground/80',
  '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:border-border/60 [&_th]:bg-muted/60 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-foreground',
  '[&_td]:border [&_td]:border-border/60 [&_td]:px-3 [&_td]:py-2 [&_td]:align-top [&_td]:text-muted-foreground',
)

// ---- "How a ticket flows through the portal" — the hand-drawn flow panel shown on
// the Core concepts page. Two lanes of numbered step cards (each links to its page),
// joined by arrows, with the on-disk artifacts each phase writes underneath.

interface FlowStep {
  n: number
  title: string
  page: string // the portal page that owns the step (card subtitle)
  to: string // route the card links to
  icon: typeof BookOpen
}

const PREPARE_STEPS: FlowStep[] = [
  { n: 1, title: 'Register project', page: 'Settings → Projects', to: '/settings', icon: Settings },
  { n: 2, title: 'Connect services', page: 'MCP page · ClickUp + MCP', to: '/mcp', icon: Plug },
  { n: 3, title: 'Add context', page: 'Instructions page', to: '/instructions', icon: NotebookPen },
]

const TEST_STEPS: FlowStep[] = [
  { n: 4, title: 'Crawl ticket', page: 'Tickets page', to: '/tickets', icon: Ticket },
  { n: 5, title: 'Generate test cases', page: 'TestCase page', to: '/testcases', icon: ClipboardList },
  { n: 6, title: 'Launch QC run', page: 'Run page', to: '/qc-run', icon: PlayCircle },
  { n: 7, title: 'Watch live', page: 'Running page', to: '/running', icon: Activity },
  { n: 8, title: 'Report + evidence', page: 'History page', to: '/history', icon: History },
]

function FlowStepCard({ step }: { step: FlowStep }) {
  const Icon = step.icon
  return (
    <NavLink
      to={step.to}
      title={`Open the ${step.page}`}
      className="group flex min-w-0 flex-1 basis-40 items-center gap-2.5 rounded-2xl border border-border/60 bg-card px-3 py-2.5 shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-foreground text-[11px] font-semibold tabular-nums text-background">
        {step.n}
      </span>
      <span className="min-w-0 leading-tight">
        <span className="flex items-center gap-1.5 text-[13px] font-medium tracking-tight">
          <Icon className="size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
          <span className="truncate">{step.title}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{step.page}</span>
      </span>
    </NavLink>
  )
}

/** One lane: a small uppercase label chip + its step cards joined by arrows. */
function FlowLane({ label, steps }: { label: string; steps: FlowStep[] }) {
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/60 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {/* Arrow + card share one flex item so a line wrap carries the arrow with it
            (a leading “→” on the next line reads as continuation; a trailing one dangles). */}
        {steps.map((s, i) => (
          <div key={s.n} className="flex min-w-0 flex-1 basis-44 items-center gap-1.5">
            {i > 0 && (
              <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground/40 xl:block" />
            )}
            <FlowStepCard step={s} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** What each phase leaves on disk — mono path chips under the lanes. */
function FlowArtifact({ path, from }: { path: string; from: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-xl border border-border/60 bg-muted/40 px-2.5 py-1.5">
      <CornerDownRight className="size-3 shrink-0 text-muted-foreground/60" />
      <span className="truncate font-mono text-[11px] text-foreground/80">{path}</span>
      <span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">· {from}</span>
    </span>
  )
}

function ConceptsFlow() {
  return (
    <div className="mb-6 space-y-4 rounded-2xl border border-border/60 bg-muted/40 p-4 sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        How a ticket flows through the portal
      </p>
      <FlowLane label="Prepare · once per project" steps={PREPARE_STEPS} />
      <div className="flex justify-center">
        <ArrowDown className="size-4 text-muted-foreground/40" />
      </div>
      <FlowLane label="Test · per ticket" steps={TEST_STEPS} />
      <div className="space-y-1.5 border-t border-border/60 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
          What lands on disk
        </p>
        <div className="flex flex-wrap gap-1.5">
          <FlowArtifact path="testing/tickets/<ticket>/" from="crawl" />
          <FlowArtifact path="testing/tickets/<ticket>/testcases/v<N>" from="test cases" />
          <FlowArtifact path="testing/test-result/<slug>/report.md" from="QC run" />
        </div>
      </div>
    </div>
  )
}

/** Left-hand docs nav: one entry per doc page, filterable by the search box. */
function DocsNav({ activeId }: { activeId: string }) {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return SECTIONS
    return SECTIONS.filter((s) => `${s.title} ${s.blurb} ${s.body}`.toLowerCase().includes(q))
  }, [query])

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search docs…"
          className="h-11 w-full rounded-full border border-input bg-transparent px-4 pl-9 text-sm shadow-none outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 focus:shadow-sm"
        />
      </div>
      <nav className="space-y-0.5">
        {filtered.map((s) => {
          const Icon = s.icon
          const isActive = s.id === activeId
          return (
            <NavLink
              key={s.id}
              to={`/document/${s.id}`}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-all duration-200',
                isActive
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{s.title}</span>
            </NavLink>
          )
        })}
        {filtered.length === 0 && (
          <p className="px-3 py-2 text-xs text-muted-foreground">No matches.</p>
        )}
      </nav>
    </div>
  )
}

export default function DocumentPage() {
  const { slug } = useParams()
  const navigate = useNavigate()

  const index = Math.max(
    0,
    SECTIONS.findIndex((s) => s.id === slug),
  )
  const section = SECTIONS[index]
  const Icon = section.icon
  const prev = index > 0 ? SECTIONS[index - 1] : null
  const next = index < SECTIONS.length - 1 ? SECTIONS[index + 1] : null

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="space-y-2 pt-2">
        <h1 className="text-3xl font-semibold tracking-tight">Documentation</h1>
        <p className="text-sm text-muted-foreground">
          How QC Portal is structured, how it works, and how to use every part of it.
        </p>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          <History className="size-3" />
          Last updated {LAST_UPDATED}
        </span>
      </div>

      {/* Mobile page picker */}
      <div className="lg:hidden">
        <select
          value={section.id}
          onChange={(e) => navigate(`/document/${e.target.value}`)}
          className="w-full rounded-xl border border-border/60 bg-card px-3 py-2 text-sm outline-none focus:border-border focus:ring-2 focus:ring-primary/15"
        >
          {SECTIONS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
        {/* Sticky docs nav */}
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <DocsNav activeId={section.id} />
          </div>
        </aside>

        {/* The one selected doc page */}
        <div className="min-w-0 space-y-5">
          <article className="rounded-3xl border border-border/60 bg-card p-6 shadow-none sm:p-8">
            <div className="mb-5 flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
                <Icon className="size-5" />
              </span>
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">{section.title}</h2>
                <p className="text-sm text-muted-foreground">{section.blurb}</p>
              </div>
            </div>
            {section.id === 'concepts' && <ConceptsFlow />}
            <div className={cn('overflow-x-auto', PROSE)}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{section.body}</ReactMarkdown>
            </div>
          </article>

          {/* Prev / next page navigation */}
          <div className="grid gap-3 sm:grid-cols-2">
            {prev ? (
              <NavLink
                to={`/document/${prev.id}`}
                className="group flex items-center gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm"
              >
                <ArrowLeft className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5" />
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    Previous
                  </span>
                  <span className="block truncate text-sm font-medium">{prev.title}</span>
                </span>
              </NavLink>
            ) : (
              <span />
            )}
            {next && (
              <NavLink
                to={`/document/${next.id}`}
                className="group flex items-center justify-end gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-right transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm sm:col-start-2"
              >
                <span className="min-w-0">
                  <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    Next
                  </span>
                  <span className="block truncate text-sm font-medium">{next.title}</span>
                </span>
                <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </NavLink>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
