# AI Sync — moving a project between two machines

Two QC engineers, two laptops, one project. Machine **A** opens a project to AI Sync
and reads out a public URL and four digits; machine **B** types them in and pulls A's
QC artifacts into its own copy. Both portals are held still while the files move.

Files: `server/src/aiSync.ts` (host), `server/src/syncPull.ts` + `syncJobs.ts` (guest),
`server/src/routes/sync.ts`, `web/src/components/AiSync{ShareDialog,PullDialog,Watcher}.tsx`,
`web/src/components/SyncStage.tsx`, `web/src/lib/sync.ts`.

---

## Why it exists at all: export/import made duplicates

The portal already had Export (a .zip of the QC artifacts) and Import (extract that zip
into a new folder and register it). That works exactly once. The **second** time the
same project arrives, import has nowhere to put it: the destination folder exists, so
it answers 409, and the engineer does the only thing left — imports under a slightly
different name. Now the machine has two projects that are the same project, diverging
from that moment on, and a QC run against the wrong one silently tests the wrong
instructions.

So AI Sync is not "import over the network". It is the thing import could not be:
**repeatable**. Running it a second time updates what is already there, transfers only
what differs, and keeps whatever this machine has that the other one doesn't.

The duplicate problem was fixed in import too, not just routed around — see
[Import, de-duplicated](#import-de-duplicated) at the end.

---

## The transport: the tunnel, and a second door beside the gate

B reaches A over the **Cloudflare Tunnel** that `/remote` already publishes (see
`remote-access.md`). Nothing new listens on a network interface; the portal still binds
`127.0.0.1`. A has to have a tunnel running, which means A has already set a remote
access password — the share dialog says so up front and links to `/remote` rather than
letting the engineer fill in a form that could not work.

But the access gate in `remoteAccess.ts` refuses *everything* from a remote visitor
without that ≥10-character password, and reading a colleague's password out loud to
get at one project's test cases is not a trade anybody should make. So AI Sync adds one
allow-listed prefix — `/api/sync/peer/` — and carries its own, much smaller door.

**That prefix is safe only because of what is behind it**, and none of the following
may be dropped on the grounds that another part is enough:

| | |
|---|---|
| **Nothing exists until the owner opens it** | With no share session every peer endpoint answers **404**. The surface is absent, not merely denied. |
| **One project** | A session names one `projectId`; the manifest is built from it. There is no "list projects", no path parameter, no way to name another. |
| **Five wrong codes REVOKE it** | Not a timed lockout — revocation. The owner must open a new share, which mints a new code. An attacker gets 5 tries out of 10,000, with a human watching the failure count climb on screen. |
| **TTL** | An unpaired session dies (default 15 min, max 2 h). A session mid-transfer is exempt — a 2 GB pull legitimately outlives the pairing window. |
| **Read-only, manifest-bounded** | `readSharedFile` serves only paths in the set the manifest was built from, re-resolved under the project root. There is no write path in the host module at all. |
| **Credentials stay put by default** | `.mcp.json` carries API keys. Its `env`/`headers` values are blanked unless the owner ticks "include credentials", and the manifest hashes the **scrubbed** bytes — what is advertised is what is sent. |

Everything else — opening a share, connecting to another machine, starting a pull — is
`localOnly`. A stolen remote session cannot publish a project the owner never offered,
nor point this laptop at a URL of its choosing and make it download gigabytes.

**Verified on a running server**: with no share open, `/peer/pair` → 404. Five wrong
codes → `revoked`, and the correct code then fails too. `../../../../etc/passwd`,
`/etc/passwd`, and a real project file outside the chosen groups → 403. A forged token,
a missing token, and a token whose share was closed → 401. With `QC_REMOTE_FORCE_GUARD=1`,
`/api/projects`, `/api/health`, `/index.html`, `/api/sync/share` and `/api/sync/connect`
all return 503 from the gate while `/api/sync/peer/pair` reaches the router.

---

## What travels: an allow-list, not "the folder minus some exclusions"

`SYNC_GROUPS` in `aiSync.ts` is thirteen named slices — Instructions & overview, Skills,
MCP servers, Tickets, Test cases, Run results & evidence, Knowledge & memory, Notes,
Templates, API tests, Diagrams, Prototypes, Chat history. All are ticked by default;
the owner can untick any of them, and the guest sees the same list again and can take
less than was offered.

It is an allow-list because the project root is **a real repo on someone's machine**. A
"everything except node_modules" rule would ship source code, `.env` files and build
output across the internet the first time somebody registered a project they had not
tidied. Nothing beside the database — TOTP seeds, API accounts, `remote-access.json` —
is in any group, so none of it can be named.

Two groups are flagged `heavy` (Run results & evidence, Prototypes) because a run's
evidence folder can hold a several-hundred-megabyte screen recording.

---

## What "sync" means: add and update, never delete

```
host has it, guest doesn't      -> written
both have it, sha256 differs    -> overwritten from the host
both have it, sha256 matches    -> skipped entirely (never fetched)
guest has it, host doesn't      -> left exactly where it is
```

A mirror would delete, and a project folder has no trash and no history: the second
time two engineers sync, whoever pulled would lose the ticket they crawled that
morning, with no way back. So the guest-only file survives, always.

**The comparison is a content hash, not mtime.** Two machines do not agree on clocks,
and copying a file forward — precisely what this feature does — gives the copy a fresh
mtime, so "newer wins" either re-sends everything for ever or silently skips a real
change, depending on which way the drift went. sha256 has neither failure mode, and it
is the reason the second sync of a big project transfers almost nothing.

**Measured**: first sync of a 6-file project — 6 new, 293 KB, every file byte-identical
afterwards. Then one file edited on the host and one guest-only file added: second sync
reported `0 new, 1 updated, 5 identical`, transferred **35 bytes**, and the guest-only
file was still there.

Each file streams to `<name>.qcsync-tmp` and is renamed into place, so a dropped
connection leaves the previous version intact rather than a truncated one — and
re-running picks up the rest, because whatever did land now hashes equal and is
skipped. A file that fails is recorded and the sync continues; the job then reports
`error` with the list, never a clean "done".

---

## Identity: `projects.syncKey`

A name can be edited and a folder can be moved, on either side, so neither answers "do
I already have this?". `syncKey` does: a UUID minted on demand (`ensureSyncKey`), sent
in the manifest, and **adopted by the guest's project after a successful sync**. That
adoption is the whole trick — it is what makes the *second* sync an update instead of
an offer to create a third copy.

It is never stolen: if another local project already carries that key, the guest's
project keeps its own and the job logs why. Two local projects sharing one key would
make the next match a coin toss.

The export `.zip` manifest carries it too (`format: 2`), so importing a zip recognises
the project the same way. A format-1 zip still imports and falls back to matching by
name.

`connectSync` reports the match as `by: 'syncKey'` (certain — the pull dialog defaults
to updating it) or `by: 'name'` (a guess — shown in amber, and the default stays "create
a new project", because one spare project is recoverable and overwriting the wrong one
is not).

---

## Blocking: both machines, and only while bytes move

`AiSyncWatcher` is mounted once in `App`, above the shell, like the other job watchers —
a sync survives navigating away. Unlike them it puts up a modal veil, on **both** ends.

The reason is not caution. A sync rewrites files under a project root while the portal
is a tool for reading and writing files under a project root; editing a test case or
launching a QC run during the two minutes a transfer is overwriting that same folder
produces a result nobody can reconstruct afterwards, because the losing write just
quietly isn't there.

**The first version blocked at PAIR time and that was wrong** — seen on screen: the
host locked the instant the code was typed, while the guest was still choosing what to
pull and where it should land, and stayed locked for a transfer that might never start.
So `shareIsBlocking` is `state === 'syncing'` only, and `jobIsBlocking` is
`status === 'running'` only (`pairing` is one HTTP call the dialog already spins for).
Pairing shows on the share dialog's stage instead — information without a lock.

The escape hatch is never removed: the guest can cancel and the host can stop sharing,
so a stalled peer or a dead tunnel costs one click. What there is no button for is
"carry on working anyway".

Abandoning a paired session releases the host (`POST /peer/release`) — state goes back
to `waiting` with the same code and the same failure budget, exactly as if the pairing
had never happened. Without it the host waits out the full TTL showing a machine that
is not coming back.

**A project cannot sync from itself.** Only reachable if the endpoint points back at
this same portal, but the damage is real and silent: the manifest's scrubbed
`.mcp.json` would be written over the live one, deleting the machine's own API keys.
Same machine id + same sync key is exactly that case and is refused in `startSync`.

---

## The "AI" part

After the files are down, a cheap model (the project's `autoLearnModel`, default haiku)
writes 2–4 bullets saying what actually changed — "3 new tickets: ABC-12, ABC-13,
ABC-14", "the qc-testing skill was updated". It is built from the **file list only**;
no file content is sent, because the paths already say what changed and shipping a
colleague's ticket notes into a prompt to describe them is a poor trade.

It is a garnish and is treated as one: it runs after the transfer, is never awaited by
anything that matters, and a missing or failing CLI degrades to a counted plain-text
summary. A sync that copied 412 files correctly is a success even if nothing described
it. The summary is handed back to the host too, so the machine that gave the files away
can see what left it.

---

## The stage (`SyncStage.tsx`)

Two machine tiles and the link between them, shared by the share dialog, the pull
dialog and both halves of the blocking overlay — so the two people watching opposite
screens see one truth. `lib/sync.ts` owns the vocabulary (`percentOf`, the stage states,
`formatBytes`) for the same reason: 42% computed two ways on two screens reads as a
broken sync.

Machines are named by **hostname with the LAN IP underneath** — the IP is what separates
two laptops that are both called "MacBook-Pro".

**Progress is a percentage of BYTES, not files.** A run-evidence folder is a few hundred
tiny `.md` files next to one 300 MB recording; a file count races to 97% and then sits
still for two minutes, which reads as a hang.

The link carries liveness on its own: packets ride it whenever bytes are moving and stop
dead when they are not, so a stalled transfer is visible without reading a number.
Packets are shown **only during `transfer`** — `compare` hashes local files and sends
nothing, and a moving line while nothing moves is a lie the user later reads as "it
stalled at 0%".

The middle column is a **fixed width** because the packet animation rides a CSS
`offset-path` measured in pixels (`.qc-sync-packet` in `index.css`); the tiles flex
around it. Keep the two in step. Every animation is transform/opacity/`stroke-dashoffset`
only, and all of it is disabled under `prefers-reduced-motion`.

---

## Import, de-duplicated

`GET /api/projects/import/check?name=&parentPath=` answers **before the upload starts**:
does that folder exist, is a project registered at it, is the name taken, and what is
the first free name (`"App (2)"`). The check is up front deliberately — the old flow
discovered the collision only after streaming a 1.87 GB zip across and then answered
409, which is how people ended up importing under a different name in the first place.

`POST /api/projects/import` then takes `mode=new` (default, unchanged) or
`mode=update&projectId=…`, which extracts into the existing project's folder, creates no
second row, and — like AI Sync — never deletes a file the zip doesn't have. It refuses
while that project is busy (a run, a crawl, a generation job), the same rule a rename
follows. The rollback-on-failure `rm -rf` only fires for `mode=new`: wiping the
destination in update mode would delete the project the user asked to update.

`ImportProjectForm` turns all that into one dialog with the two answers that actually
differ — **Update "X"** or **Import as "X (2)"**.

---

## Things that will bite

- **`aiSync.ts` holds sessions in memory only.** A server restart drops every share and
  every token. That is correct — a pairing code should not survive a reboot — but it
  means a restart mid-transfer fails the guest's next request with 401, not a hang.
- **The peer prefix in `remoteAccess.ts` is a security boundary, not a convenience
  list.** Nothing else may be added to `PUBLIC_PREFIXES`.
- **`manifestFor` sets the session to `syncing`**, which is what raises the host's
  blocking overlay. If the guest fetches a manifest and then dies, the host stays
  blocked until it notices — cancel/stop-sharing is the way out.
- **A bare `host:port` endpoint is assumed https**, because the tunnel always is. The
  error names the missing `http://` rather than leaving "fetch failed" as the whole
  message.
- **Group membership is first-wins.** A path claimed by an earlier group is not
  re-listed by a later one, so `entries` never double-counts and the byte totals on the
  two screens agree.
