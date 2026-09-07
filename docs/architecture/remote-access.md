<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

# Remote access — publishing the portal over a Cloudflare Tunnel

`/remote` (sidebar → System → **Remote access**) turns the localhost-only portal into a
public HTTPS address with one click, and takes it back down with another.

Files: `server/src/tunnel.ts` (the cloudflared process), `server/src/remoteAccess.ts`
(the access gate), `server/src/routes/remote.ts`, `web/src/pages/RemoteAccessPage.tsx`,
plus three lines of wiring in `server/src/index.ts`.

## Why the gate is not optional

The portal is a **remote control for the machine it runs on**. It spawns `claude` with
`--permission-mode bypassPermissions`, hands out a real shell over `/ws/terminal`, reads
and writes any file under a project root, and holds ClickUp / Jira / database credentials
and TOTP seeds. On localhost that is fine — the only client is the engineer at the
keyboard, which is the whole premise of "Localhost only" in `CLAUDE.md`.

Publishing changes the *principal*, not just the address: "anyone who learns the URL" and
"the engineer" become the same user. A `trycloudflare.com` hostname is unauthenticated and
unlisted, which is not the same as secret.

So the tunnel and the gate ship as one feature, and the gate **fails closed**:

- `startTunnel()`'s preflight refuses to launch without an access password (≥10 chars).
- A request arriving through Cloudflare with no valid session gets the unlock page and
  **nothing else** — not the API, not the SPA's JS bundle.
- The WebSocket upgrade is checked separately, so a run stream or a shell cannot be
  attached around the HTTP gate.
- The device terminal stays blocked for remote sessions unless explicitly allowed.
- Removing the password is refused while the tunnel is up — otherwise there would be a
  window, however short, of a published portal with no gate.

## How "arrived through the tunnel" is decided

`cloudflared` runs on this same machine and connects to `127.0.0.1`, so **tunnel traffic
is indistinguishable from local traffic by socket address** — every request looks like
`::1`. Binding a second port, or comparing IPs, cannot separate them.

What Cloudflare's edge *does* add is `cf-connecting-ip` / `cf-ray` on every proxied
request. Their **presence** is therefore the signal (`isRemoteRequest`). It can only have
come from the edge — nothing on loopback sends those headers by accident — and a local
process that forges them onto its own request gains nothing: it is already local, and the
worst it achieves is locking *itself* out until it stops forging them.

`QC_REMOTE_FORCE_GUARD=1` treats every request as remote. That exists to develop and test
the gate without publishing a tunnel; it is not a security control.

The server still binds `127.0.0.1`. That has not changed and must not change.

## The middleware's position matters

`app.use(remoteAccessGuard)` sits in `index.ts` **before every router and before
`express.static`**. Behind `express.static` it would still refuse the API, but the SPA
bundle would be served to a locked visitor — application code handed out before
authentication, for no benefit. Only `/api/remote/gate` and `/api/remote/unlock` are
allow-listed (the unlock form's own two calls).

The unlock page is a **self-contained HTML string** in `remoteAccess.ts`, not a React
route, for the same reason: it has to render for a visitor who has not received one byte
of the bundle.

## Sessions

`unlockRemote()` checks the password (scrypt, `timingSafeEqual`) and issues a cookie
`qc_remote_session` = `<expiry>.<HMAC-SHA256(expiry)>`, `HttpOnly; Secure; SameSite=Lax`.

Stateless on purpose — a portal restart must not sign every device out; restarting the
server is routine (`--update`, a `tsx watch` reload) and re-entering the password on a
phone is not. The consequences are deliberate too:

- **"Sign out all devices"** rotates `sessionSecret`, so every issued cookie stops
  verifying at once. That is the only revocation there is, and it is enough.
- **Changing the password** rotates it as well: the reason to change a password is usually
  that someone saw it, and leaving old sessions alive would defeat the change.

A remote session whose cookie expired mid-visit would otherwise fill the page with
"Unlock required." toasts, so `web/src/lib/api.ts`'s `request()` reloads on a 401 carrying
`needsUnlock` — the navigation then hits the gate, which answers with the unlock page.

## Blast radius, not secrecy: what stays local-only

Anyone remote already has the password, so `localOnly` in `routes/remote.ts` is not about
secrecy — it is about what a *shared session or a stolen phone* can do. Setting or
removing the password, the terminal switch, the tunnel setup and **starting** a tunnel all
require a request that did not come through Cloudflare.

`POST /stop` is deliberately **not** local-only: taking the portal off the internet is the
one direction that is always safe to allow.

## The three modes

| Mode | Command | Trade-off |
|------|---------|-----------|
| `quick` | `cloudflared tunnel --url http://127.0.0.1:<port>` | No account, no config, one click. Random `*.trycloudflare.com` that **changes on every publish**, with no uptime promise from Cloudflare. |
| `token` | `cloudflared tunnel run --token …` | A connector token from Zero Trust → Networks → Tunnels. Fixed hostname, no `cert.pem` on the machine, and the mode that can sit behind Cloudflare Access for company SSO. |
| `named` | `cloudflared tunnel run --url … <name>` | A locally-managed tunnel: needs `cloudflared tunnel login` + a DNS route. Kept so an engineer who already has one doesn't have to re-create it as a token. |

`token` mode passes **no `--url`**. Its ingress (which hostname maps to which local
service) is *remotely* managed from the dashboard, and cloudflared refuses `--url`
alongside a remote config. So the public hostname is typed into the portal purely so the
page can show and link the right address — it cannot be discovered.

`hostname` is likewise display-only for `named`. For `quick` it is ignored: the address
comes back on stderr and is captured by the `QUICK_URL` regex.

## Why the process output is parsed at all

cloudflared has no status API. Its stderr is the only progress signal, so `tunnel.ts`
watches for two things: the quick URL, and `Registered tunnel connection` — the line that
actually means traffic will arrive. Until one of those the state is `starting`, never
`running`: **reporting a URL that 502s is worse than reporting none.** A launch that
registers nothing in 45s is killed and reported, since a cloudflared stuck dialing the
edge would otherwise keep retrying behind an error the engineer has already read.

## The generation counter — a real bug, not defensive coding

`live` is one module-level object describing "the tunnel". A killed cloudflared's `close`
(and its final stderr) can arrive **after the next one has been spawned** — the ordinary
path when someone changes mode and publishes again. Measured before the fix: the new
tunnel was up and registered, while the page reported `error: cloudflared exited with
code 0` and no URL, because the dead child's exit handler had overwritten the live one's
state.

Every launch therefore claims `live.generation`, and every handler (`data`, `error`,
`close`, the ready timeout, the restart timer, `markReady`) returns early if its own
generation is stale. `launch()` also kills any child still attached from a previous
generation, so a stop whose `close` never arrived cannot leave a second connector
tunnelling to the same port invisibly.

## Reconnect, and the orphan on the next boot

`autoRestart` relaunches cloudflared after a drop, backing off `2s → 5s → 15s → 30s →
60s` and then giving up; ten minutes of stability resets the budget so a blip at 3am
doesn't exhaust it. A quick tunnel's URL is re-minted on each launch, so the stale one is
cleared rather than shown.

`shutdownTunnel()` runs from `index.ts`'s graceful exit. `SIGKILL` (or a power cut) has no
such courtesy, and an orphaned cloudflared keeps a **public hostname pointed at this
port** while the page says "Not published" — the gate still protects it, but *off* has to
mean off. So the child's pid is written beside the DB (`tunnel.pid`) and
`reapOrphanedTunnel()` kills it at boot, before `autoStartTunnel()` considers a new one.
`isLiveCloudflared()` verifies the pid really is a cloudflared (`ps` / `tasklist`) first,
because pid reuse would otherwise kill an unrelated process.

## Secrets

The connector token lives in `tunnel.json` **beside the portal database** (0700 dir, 0600
file), never in a project folder — same reasoning as `totp.ts` and `apiAccounts.ts`: it
must not be committed to a repo and must never be swept into a prompt by
`projectContext.ts`. It is never returned to the browser; the page only learns
`hasToken`. The password hash, its salt and `sessionSecret` live in `remote-access.json`
the same way.

cloudflared does not echo the token, but it does print its own settings line on some
versions, so `scrub()` strips it (and any JWT-shaped string) from every log line before it
is stored. The log is in memory only — never the DB, never disk.

## Gotchas

- **The tunnel always targets the portal's own port**, and the target is not
  configurable. Pointing it at Vite's 5175 in dev would publish a UI that the gate does
  not protect (only `/api` would be, through Vite's proxy), which is exactly the footgun
  this feature exists to avoid. The page warns when `web/dist` is missing, since the
  tunnel would then serve an API with no UI.
- **`/remote` is project-agnostic** (`PROJECT_AGNOSTIC_PREFIXES` in `App.tsx`): publishing
  is a property of the machine, and it is what someone setting up a fresh install wants
  *before* registering a project.
- **cloudflared needs outbound UDP/TCP 7844.** A corporate network that blocks it produces
  the 45-second ready timeout, with nothing in the log but connection retries.
- `--no-autoupdate` is always passed: an unattended self-update would restart the tunnel
  mid-session, and on Windows fail on a locked binary.
- The page's tunnel form is **keyed on `settings.updatedAt`** so a save re-seeds it from
  the server. It used to sync with an effect, which `react-hooks/set-state-in-effect`
  correctly rejects.
