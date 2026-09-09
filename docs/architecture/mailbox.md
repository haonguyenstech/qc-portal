# MailBox (`/mailbox`)

A throwaway inbox inside the portal: the address you paste into a sign-up form, the code
that comes back, the "confirm your email" link. The alternative it replaces is a second
browser tab on a public mail site, the address retyped by hand, and the six digits retyped
again — which is where they get retyped WRONG and a passing flow gets filed as a bug.

Files: `server/src/mailbox.ts`, `server/src/routes/mailbox.ts`, `web/src/pages/MailBoxPage.tsx`,
`web/src/lib/mailbox.ts`.

## Why not YOPmail, which is what everyone asks for

**YOPmail has no API.** Measured, not assumed:

- `GET https://yopmail.com/en/inbox?login=…` with no tokens answers **HTTP 400** and a body
  that is a `window.top.location.replace('/en/')` redirect. A real inbox read needs the
  `yses`/`yc` cookies **and** the `yp`, `yj`, `ctrl` values their own `ver/N/webmail.js`
  computes — i.e. scraping a page whose tokens rotate with their version file.
- `x-frame-options: sameorigin`, so embedding the real site in an iframe is out too.

That leaves a feature that breaks on their release schedule. **Guerrilla Mail** publishes a
documented JSON API and has the same model where it counts — make up any address, it already
exists, no sign-up. The trade is the domain: `@sharklasers.com` and friends, never
`@yopmail.com`. If a test account is already registered against a `@yopmail.com` address,
this page cannot read its mail; that is a real limit, not an oversight.

## The service, and the two calls that look interchangeable but are not

- `f=get_email_address` → a session (`sid_token`) plus a random address.
- `f=set_email_user` → rename the local part. Same session, mail already in the box stays.
- **A dead `sid_token` does not error.** The response comes back with no `list` and no
  `email`, just service stats — measured with a made-up token. Sessions expire after about
  an hour, so without `reviveSession` the page would sit forever on "waiting for mail"
  against an address that no longer exists, with nothing on screen looking wrong. On that
  answer the server takes a NEW session and immediately asks it for the SAME username,
  which gets the same address back: the address is what was typed into the app under test,
  and it must survive its session. Verified by poisoning the stored token and restarting.
- **`f=get_email_list&offset=0` is the list call. `f=check_email&seq=0` is NOT.** `check_email`
  is a DELTA: it returns what arrived since the session's own marker, so the second call
  answers with an empty list while the inbox visibly holds mail — measured here with the
  welcome message sitting in the box the whole time. A page that can be opened, reloaded or
  left in a background tab has to ask what IS in the inbox.
- `f=fetch_email` → the body. `f=del_email` → delete. `f=forget_me` → abandon the inbox.
- They ask callers not to poll faster than ~10s (`MIN_POLL_MS`); the page refreshes every 15s.

**Random is a button, not a suggestion.** This service is public and **any name can be
claimed by anyone**, so a hand-typed `test1` is an inbox somebody else may already be sitting
in — reading the codes, or being read. `randomMailName()` rolls `qc-<colour>-<animal>-<4
digits>` (~1 in 5 million on top of the prefix): enough entropy to be private, still readable
enough to tell this run's inbox from the last one's, which `chgtsdka` is not. The button on
the address row applies it on the same session, so mail already in the box stays; the dice
inside the rename form only FILLS the field, so a rolled name can be tweaked before it becomes
the address.

**All their domains reach the same inbox — the username IS the address.** The API hands out
`@guerrillamailblock.com` (what it gives programmatic clients) while the service's own welcome
mail to the same session says `@sharklasers.com`. So the page shows a domain picker and hands
out whichever the engineer picks; the server keeps the canonical address it was given.

## Session storage

The `sid_token` is the key to the inbox, and losing it loses the address already typed into
the app under test — so it is persisted BESIDE THE DATABASE (`data/mailbox.json`, 0600), like
`totp.ts` and `apiAccounts.ts`, never in a project folder, and survives a portal restart. It
**never reaches the browser**: every call goes through `routes/mailbox.ts`.

## Rendering a stranger's HTML

The body is HTML that anyone can send to a public address, displayed inside a portal whose API
can reach the engineer's projects, database connections and file system. It is rendered in an
**`<iframe sandbox="" srcDoc=…>`** and must stay that way:

- no `allow-scripts` → the body cannot run JavaScript;
- no `allow-same-origin` → even if it could, it can read nothing of ours;
- `srcDoc` rather than a `src` URL → it never becomes a network document.

`dangerouslySetInnerHTML` here would be a straight XSS hole with a public front door.

### How close is it to Gmail?

`frameDoc` treats two kinds of mail differently, because doing one's job to the other is what
makes a test mailbox look unlike a real client:

- **A real HTML mail** (it brought its own `<html>`/`<body>`/table layout) is left ALONE apart
  from `img{max-width:100%}`. It was authored to look a certain way in a mail client, and a
  font or padding of ours is a difference between what QC sees here and what the customer sees
  in Gmail — which is exactly what is being checked. Verified against a table-layout marketing
  mail: `<style>` in the head applied (`.btn` → its own blue, radius, weight), inline styles and
  table borders kept, the mail's own `background` and `font-family` won, computed `padding` and
  `margin` on `body` were `0px` — i.e. nothing of ours reached it.
- **A plain-text mail** arrives wrapped in a bare `<pre>`, which does not wrap: with no styling
  it scrolls sideways off the panel and the code at the end of the line is the part you cannot
  see. That one gets a readable font, padding and wrapping.

**Remote images DO load** inside `sandbox=""` — verified by `naturalWidth` on two real images
fetched over the network. What still differs from Gmail: **`cid:` inline images** (attachment
parts referenced from the HTML) do not resolve, and **attachments cannot be opened** — the
count is shown (`att`) rather than hidden, because a mail whose PDF is silently dropped reads
as a mail that never had one. Body height cannot be auto-fitted either: the frame is an opaque
origin (the whole point of `sandbox=""`), so its content height is unreadable — hence a fixed
60vh with a **Taller** toggle instead of a guess.

## HTML entities — the headers, not the body

A mail whose subject is not pure ASCII arrives **entity-encoded**, because that is what a
mail composer emits: `Xin ch&agrave;o`, `M&atilde; x&aacute;c th&#7921;c c&#7911;a b&#7841;n`.
The body was always fine — it renders as HTML in the preview frame — but the subject, the
sender, the excerpt and the `to` line are printed as plain strings by React, so the inbox
read literally "Xin ch&agrave;o", and `mailText` (which only knew `&nbsp; &amp; &lt; &gt;
&quot;` plus decimal refs) fed the same gibberish to the code finder.

`decodeEntities()` in `web/src/lib/mailbox.ts` is now the one decoder, and the page applies
it in each query's `select` — once per query, rather than at the six render sites where the
seventh one added would forget. **`body` is deliberately not decoded**: the frame renders
it as markup, and decoding `&lt;b&gt;` there would invent a tag the sender never wrote.

Three things about it are load-bearing:

- **Numeric refs matter more than named ones.** Most Vietnamese letters (ạ ả ấ ầ ơ ư …) have
  no HTML name at all and can only be written `&#7841;` / `&#x1EA1;`, so both numeric forms
  are handled — with `fromCodePoint`, since `fromCharCode` is wrong above U+FFFF.
- **One pass, `&amp;` included.** Decoding `&amp;` separately or first turns `&amp;#7841;`
  — which is the literal text `&#7841;` — into "ạ".
- **Entity names are case-sensitive**, so `&Agrave;` is a second table key rather than a
  case-insensitive lookup: `&AGRAVE;` is not an entity and must stay as written. Anything
  unknown, out of range, or a lone surrogate is left exactly as written — showing
  `&notreal;` is honest, showing `�` is not.

Verified in the running app with an entity-encoded Vietnamese mail (subject, sender,
excerpt, `to`, the extracted code and the link's `&`): nothing matching `/&[a-z#0-9]+;/i`
survives anywhere on the page.

## Codes and links (`web/src/lib/mailbox.ts`)

The extraction is **ranked, never filtered**: guessing wrong and HIDING the real code sends the
engineer back to reading raw HTML, which is the thing this page exists to replace.

- Codes are ranked by **distance to the nearest code word** (`code`, `otp`, `mã`, `xác thực`, …),
  not by "a code word appears somewhere nearby". Presence-in-a-window put a 7-digit `Ref` above
  the actual PIN two words after the word PIN — measured, then fixed with distance decay.
- Rejected outright: bare years, digits inside a longer number, `#10023` (an order id), `1499.00`
  (an amount). Each of those beat the real code in a sample before it was excluded.
- Links come from the `href`s in the HTML, not from the flattened text — the clickable URL in a
  real mail is almost never the one written on screen ("Confirm your email" hides it). Ones
  matching verify/confirm/activate/reset (and the Vietnamese `kich-hoat`, `xac-thuc`, `dat-lai`)
  are tagged **action** and sorted first.

## Known limit — inbound delivery is unverified from the dev machine

The read path is proven end to end against real service data (list → open → body → delete, plus
rename and a fresh inbox). **Mail arriving from an outside sender was never observed here**:
Guerrilla's own `f=send_email` reports `valid:true` but nothing was delivered, and outbound port
25 is blocked on this network, so a real SMTP hand-off could not be attempted either. Send one
mail from an ordinary account to the address the page shows before trusting it in a test plan.

That also leaves one rendering question open: the VIEWER is proven to render rich HTML
faithfully, but whether the SERVICE hands us the HTML part of a multipart mail is unproven —
the only real message available here is Guerrilla's own welcome mail, which is
`content_type: text` and arrives wrapped in `<pre>`.
