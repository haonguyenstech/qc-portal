# Troubleshooting — MCP connections (ClickUp / Jira / Figma)

Common setup problems on the machine running QC Portal, and the exact fix.
Everything here runs **on the user's own PC** (the portal is localhost).

---

## 1. ClickUp or Jira MCP shows `✘ failed` → install `uv`

**Symptom.** On the MCP page (or `claude`'s `/mcp` view) the **clickup** and/or
**jira** server is `✘ failed`, while `figma` / `playwright` / `mobile-mcp` are fine.

**Cause.** ClickUp (`clickup-mcp`) and Jira (`mcp-atlassian`) are **Python** MCP
servers. The portal runs them with **`uvx`** (from Astral's **`uv`**) — the Python
equivalent of `npx`. If `uv` isn't installed, `uvx` isn't on `PATH`, so the server
can't even start. This has **always** been how ClickUp is run — a machine where it
"used to work" simply already had `uv` installed. A fresh/different PC won't.

> The MCP page now shows an amber banner with the exact install command when `uv`
> is missing (via `GET /api/mcp/uv`, which probes `uvx --version`).

**Check** (CMD or PowerShell, either works):

```
uvx --version
```

- Prints a version (e.g. `uv 0.11.x`) → installed, look elsewhere.
- `'uvx' is not recognized...` → not installed, fix below.

**Fix — install `uv`:**

- **Windows:** `winget install --id=astral-sh.uv -e`
  (or `powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"`)
- **macOS / Linux:** `curl -LsSf https://astral.sh/uv/install.sh | sh`

Then **fully close and reopen QC Portal** (and any terminal) so the new `PATH`
is picked up. Re-run **Test connection** → it should flip to **Connected**.

**Still failing after installing `uv`?** Run the server command by hand to see the
real error (bad token, blocked network, missing `git`, etc.):

```
# Windows PowerShell
$env:CLICKUP_MCP_API_KEY="<token>"; uvx --from git+https://github.com/DiversioTeam/clickup-mcp.git clickup-mcp
```

`uvx --from git+…` clones from GitHub on first run, so **`git`** and network access
are also required. Success looks like the command sitting silently after
`Starting ClickUp MCP Server...` — an MCP server waits for a client; Ctrl+C to stop.

---

## 1b. ClickUp fails with `1 validation error for Config — api_key Field required`

**Symptom.** Running the command above (or the portal's clickup server) exits with:

```
Unexpected error: 1 validation error for Config
api_key
  Field required
```

**Cause.** Newer `clickup-mcp` versions read the token from **`CLICKUP_MCP_API_KEY`**
and ignore the older `CLICKUP_API_KEY`. A `.mcp.json` entry that only sets the old
variable makes the server crash at startup → the portal shows `✘ failed`.

**Fix.** On the MCP page, **Disconnect** clickup and **Connect** again with the
token — the portal writes **both** env vars so any server version starts. (Or
hand-edit `.mcp.json` and add `"CLICKUP_MCP_API_KEY": "<same token>"` next to
`"CLICKUP_API_KEY"` in the clickup `env` block.)

---

## 2. Jira connects but shows no issues / tickets list is empty

Two independent causes — check both.

### 2a. `JIRA_URL` must be the site root only

When connecting Jira, the **Site URL** is only the base origin — **not** a board or
backlog URL.

- ❌ `https://yoursite.atlassian.net/jira/software/projects/P2/boards/2/backlog`
- ✅ `https://yoursite.atlassian.net`

The project key (e.g. `P2`, `KAN`) is **not** entered here — it appears in the
**Project** dropdown on the Tickets page. Fix the `JIRA_URL` in `.mcp.json` (drop
everything after `.atlassian.net`) or Disconnect → Connect again with the base URL.

### 2b. Use a **classic** Atlassian API token, not a scoped one

The portal calls the Jira REST API directly at `https://<site>.atlassian.net/rest/api/3`
with Basic auth — this only works with a **classic (unscoped)** API token.

At <https://id.atlassian.com/manage-profile/security/api-tokens>:

- ✅ **"Create API token"** — classic, unscoped. Use this.
- ❌ **"Create API token with scopes"** — a scoped token is silently rejected on the
  direct site URL (401 on `/myself`, and `project/search` returns `total: 0` as if
  anonymous), so the ticket list is empty.

**Verify a token** (expect HTTP `200`; `401` means wrong token type/account/email):

```
curl -s -o /dev/null -w "%{http_code}\n" -u "EMAIL:TOKEN" https://<site>.atlassian.net/rest/api/3/myself
```

If `401` persists with a classic token, the account for `EMAIL` may not be a member
of that Atlassian site — use the email that actually logs into the site, or have an
admin invite it.

---

## 3. "Conflicting scopes" warning in `claude`'s MCP diagnostics

**Symptom.**

```
Server "clickup" is defined in multiple scopes with different endpoints:
  user (https://mcp.clickup.com/mcp), project (uvx ... clickup-mcp).
```

**Cause.** The same server name exists in **user** scope (global) *and* **project**
scope (`.mcp.json`) with different endpoints. QC Portal only manages **project**
scope; the user-scope copy came from a `claude mcp add … -s user` or an older setup.
OAuth/tokens don't carry between endpoints, and it's noise.

**Fix — keep the project copy, remove the user-scope duplicates:**

```
claude mcp remove clickup -s user
claude mcp remove figma -s user
claude mcp remove playwright -s user
```

This is a **warning**, not the cause of a `failed` server — if a server is also
failing, fix that separately (usually §1).

---

## 4. MCP server stuck on "Pending approval" (fixed in 0.8.1)

Pressing **Test connection** on a server showing *Pending approval* now approves it
where the current Claude CLI actually reads project MCP approval
(`~/.claude.json` project entry + `.mcp.json` enablement). Update the portal
(`qc-portal --update`) if you still see the old *"Approved… but connection still
failed"* message.

---

## Quick reference

| Symptom | Likely cause | Fix |
|---|---|---|
| clickup/jira `✘ failed` | no `uv` installed | install `uv`, reopen portal (§1) |
| Jira empty ticket list | `JIRA_URL` has a path | use `https://<site>.atlassian.net` (§2a) |
| Jira empty ticket list / 401 | scoped API token | create a **classic** token (§2b) |
| "Conflicting scopes" | dup server in user scope | `claude mcp remove <name> -s user` (§3) |
| "Pending approval" loops | old approval handshake | update portal to ≥ 0.8.1 (§4) |
