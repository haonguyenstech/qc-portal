# Release Notes

All notable changes to **QC Portal** are recorded here. The version shown in the
sidebar footer matches the `version` in the repo root `package.json`.

## 0.11.11 — 2026-08-06

**The Chat page gets a header, a readable conversation list, and a composer that stops moving**

### Added

- **A header above the conversation.** It says which chat is open, whether this one is
  **Read-only** or has **Full access** to your project, and — while an answer is being written —
  that it's still answering. Star, Rename, **Export .md** and Delete are right there, so you no
  longer have to go back to the list to act on the conversation you're reading. Export writes the
  whole transcript to a Markdown file (who said what, and when), which is what you want when a
  finding has to be attached to a ticket.

### Changed

- **The conversation list reads like a list of conversations.** Each row now has two lines — the
  name, and when it was last worked on ("59m ago", "3d ago", then a date) — with the row you're
  reading marked by a tint and an accent bar. One still being answered says **"Answering…"**
  instead of showing an unlabelled dot. The `…` menu moved onto the row, so titles use the full
  width instead of being cut 36px early even when you weren't hovering.
- **The composer no longer jumps when you send the first message.** It's pinned to the bottom from
  the moment the page opens; the greeting and quick prompts sit above it. Sending your first
  question now changes the answer area and nothing else.
- **The chat page runs edge to edge.** The outer frame and page padding are gone, so the
  transcript, the list and the composer get the whole window — a real difference on a laptop
  screen. The seam between the list and the header is now a single continuous line, and the
  search field, the day headings and the rows all line up on one column.
- **Shortcuts at the bottom of the list are a row of icons.** Tickets, Knowledge, Run history and
  Terminal were four full-width links repeating the sidebar directly above **New Chat**; now New
  Chat is the first thing you see there.

### Fixed

- **The notification panel no longer scrolls sideways.** Any notice carrying a URL (every Auto
  Agent one does) pushed the list wider than the panel, so reading a message meant scrolling
  right. Long text now wraps.
- **"What's new" is actually visible when you open notifications.** Opening the panel clears the
  unread badge, which also used to wipe the highlight at the same instant — the one thing you
  opened it to see. Unread rows now keep their mark (and a "N new" count) for as long as the panel
  is open. Each notice also carries its kind as a coloured icon and its time beside the title,
  and a notice you can click through to says **Open** on hover.
- **Clicking into the chat search box no longer lifts it off the page.** It was picking up a focus
  ring and shadow that made it look like a white pill floating over the list.

## 0.11.10 — 2026-08-06

**Chat gets a `+` menu, follow-up questions and temporary conversations — and the grounding check finally runs on real-sized tickets**

### Added

- **A `+` menu in the chat box, for the three questions a project chat can't answer on its own.**
  **Web search** lets Claude actually search the web and list its sources (without it, it was being
  *denied* the tool and answering from memory instead — the exact failure the button exists to
  prevent). **Deep research** is the same tools with a report shape — sub-questions, cross-checked
  against a second source, then Summary / Findings / Conflicts & gaps / Sources — and twenty minutes
  to do it in, because five reliably produced half a report. **Create diagram** answers as a picture:
  a flow, a state machine, a sequence, rendered right in the reply. Each applies to **one message**
  and clears itself, so the follow-up goes back to reading your project — and the badge stays on the
  message, so "why does this answer cite the web?" is still answerable a week later.
- **"Ask next" — the three questions worth asking after an answer.** Chips under the newest reply,
  written in your voice, and clicking one sends it. They ride along with the answer rather than
  costing a second round trip, so they appear the moment it finishes instead of making you wait
  again.
- **Temporary chat — ask something without it becoming project history.** A normal transcript is a
  file in your project and gets committed with everything else; that's right for "how does this
  work?" and wrong for a throwaway question or one with a customer's data pasted into it. A
  temporary conversation lives only in the server's memory: never written to disk, never in the
  rail, and dropped when you end it, after six hours idle, or on restart — pasted screenshots
  deleted with it. You choose it when the conversation starts (not halfway through, or half of it
  would already be saved). The notice says exactly that and no more: the Claude CLI still keeps its
  own session transcript in your home folder, and a privacy line that isn't quite true is worse than
  none.
- **Star a conversation to pin it to the top.** Starred chats get their own group above Today /
  Yesterday, and starring doesn't disturb when the chat was last worked on. The star also shows on
  the row, so it still explains itself when a search has filtered the group header off screen.
- **The wait tells you what it's actually doing, with the target.** Instead of one unchanging label
  over a skeleton, a long turn now lists the calls in order — *Searched for `phaseOf`*, *Read
  `ChatPage.tsx`*, *Ran `npm run build`* — finished ones ticked. A turn that's been grepping for
  forty seconds reads as working rather than hung.
- **Rename and delete are proper dialogs.** The browser's built-in prompts can't say *which*
  conversation you're about to delete, can't be styled, and are suppressed outright in some
  browsers — which reads as the menu item doing nothing.

### Changed

- **The answer types out instead of arriving in paragraph-sized jumps.** Claude doesn't stream a
  character at a time — a 12 KB answer landed as 116 chunks — so the text used to lurch forward on
  about one frame in sixteen. It now catches up smoothly, without ever flashing raw `**markdown**`
  mid-word, and it's skipped entirely if you've asked your system to reduce motion.
- **Typing in a long conversation is no longer sluggish.** Every keystroke used to re-render the
  whole transcript and re-parse every message's markdown: measured at 567 ms per keystroke in a
  60-message chat, and streaming into that chat left the page at about 12 fps. Both are fixed —
  keystrokes are back at the measurement floor and streaming runs at ~58 fps.
- **Each turn is signed and timestamped** — who said it, when (with the date when it isn't today),
  and which model answered.
- **The chat manual is written.** Two new pages in the in-app Documentation — **Chat** and
  **Database**, neither of which was documented at all — plus a pass over the rest of it: the
  Terminal page still claimed shells didn't survive a reload, the Run page still called the mobile
  targets "coming soon", and Overview was still described as a single free-text box. API flows,
  "Run as" accounts, attached specifications, nested subtask folders, Azure DevOps, the Auto Agent
  status line and the Guide tour buttons are all covered now.

### Fixed

- **The grounding check silently gave up on every real ticket.** The anti-hallucination pass that
  audits generated test cases had a flat two-minute, 15-cent budget sized for a small artifact. On a
  real one — a 23 KB ticket, 43 KB of cases, 26 KB of your Knowledge and Memory — it needs about two
  and a half minutes and runs out of money before it can emit a single corrected row, and both
  failures surface as "no AI response". So the check never ran for exactly the test cases that most
  needed checking. Both limits now scale with the size of what's being audited (with a hard ceiling
  so a runaway audit still can't balloon).
- **A perfectly good CSV was being saved as Markdown.** If the model introduced its output with a
  sentence — *"The CSV is verified valid (76 rows × 12 columns). Here is the final output:"* — the
  file no longer looked like a CSV, so 76 rows of test cases were stored as `.md` and wouldn't open
  as a spreadsheet. The output is now recognised by your template's own header row.
- **Test cases stop being reported as "shifted" when they're fine.** A template exported from a
  spreadsheet often carries empty padding columns — 32 of them for 12 real ones — and the model
  mirrored that padding at a different width every run, which made the column check flag all 84 rows
  as broken while a genuinely shifted row could hide in the slack. The padding is now stripped
  before the model ever sees the template, which makes the check meaningful in both directions.

## 0.11.9 — 2026-08-05

**A Chat page: ask Claude about your project, paste a screenshot, tag a ticket with `@`**

### Added

- **Chat (under Tools) — just ask.** Every other AI screen in the Portal is a form: pick a ticket,
  pick a model, press Generate. This one is a conversation. "Why did run 14 fail?", "what does this
  endpoint validate?", "are these test cases enough?" — Claude answers from inside your project
  folder, so your CLAUDE.md, Knowledge and Memory are already in scope, and a follow-up question
  understands what "it" refers to. Conversations are saved per project (searchable, renameable,
  grouped Today / Yesterday / 7 days) and each one picks up where you left it.
- **Two answer modes, and read-only is the default.** **Read-only** lets Claude read your repo but
  not change it, and skips loading MCP servers so answers start in about a second. **Full tools** can
  write files and drive the project's MCP servers (a browser, ClickUp) when you actually want the
  work done, not just described. The toggle sits next to the model picker and always says which one
  you're in.
- **Paste a screenshot into the chat.** Cmd/Ctrl-V a screenshot, drop an image on the box, or use the
  paperclip — up to 4 images per message. Claude opens each one and can see it, so "what's wrong with
  this screen?" is a paste and a question rather than a paragraph of description. An image on its own
  is a valid message. Your images stay with the conversation, so reopening it shows what you asked
  about.
- **Tag a ticket or its test cases with `@`.** Type `@` in the chat box and pick from your crawled
  tickets — or `@TICKET/testcases` for the cases generated for it. Claude reads the real files, so it
  answers about your actual ticket and your actual cases instead of guessing which folder you meant.
  Deleting the `@TICKET` text is how you take a tag back, and a tag whose files are gone says so
  rather than failing quietly.
- **Attach a spec to a question.** The paperclip also takes Word / PDF / Excel / CSV / Markdown and
  converts it in your browser — the document itself never leaves your machine.
- **Overview is a list of documents now.** Upload your product docs — Word, PDF, Excel, CSV,
  Markdown — and each file becomes its own document you can preview, re-review or delete on its own.
  Ten files show as ten documents instead of one blob nobody can unpick. Uploading is all it takes for
  the AI to have them: test-case generation, prototypes and the grounding check all read them.
- **Per-document "AI review & format".** Cleans up a converted document — fixes the Markdown, merges
  duplicated passages, strips PDF page numbers and running headers — while adding no facts of its own,
  and leaves tables, links, IDs and numbers exactly as they were. It rewrites that one file, so there's
  an **Undo** right there in the row: keep it, or put the original back.

### Changed

- **Code in an answer is a proper code block** — coloured for its language (TypeScript, SQL, bash,
  Python, JSON, YAML, Java, C#, Kotlin, Swift, Dart, Go and more), labelled, and with a **Copy**
  button in its header. Selecting thirty lines out of a scrolling transcript by hand was the part
  that went wrong.
- **The waiting state says what's happening.** Instead of a bare spinner (two of them, in fact),
  a waiting answer shows what Claude is doing right now — "Reading the project", "Searching the
  project" — how long it's been at it, and a placeholder for the answer taking shape. A long wait
  reads as working rather than stuck.
- **Every message shows its time**, with the date too when it isn't today, and which model answered.
- **The chat uses the whole screen.** On a large display the conversation was a narrow ribbon between
  empty margins; it now widens with the window, while paragraphs keep a comfortable line length and
  code blocks and tables get the extra room.
- **The bundled test-case template keeps itself up to date.** A new project starts with the team's
  common CSV template already in place, and when the Portal ships a newer one, `qc-portal --update`
  refreshes the copy in every project that hasn't been edited. A template you customised is left
  exactly as it is (the Templates page still offers "Reset to default"), and one you deleted on
  purpose stays deleted.
- **API Testing shows what each check actually compared.** A result now spells out the key it looked
  at, the value that came back, and the value it wanted, instead of one run-together line — so a
  failing assertion tells you why in place.

## 0.11.8 — 2026-08-05

**API scenarios that run like a Postman collection, test cases from an attached spec, and the device you picked**

### Added

- **API Testing runs a whole scenario, not one request at a time.** A "Flows" list sits under your
  saved requests: put the requests in the order they should run, hit **Run flow**, and each step's
  captured values feed the next one — log in, capture the token, then every step that needs it. Each
  step shows its status code, timing and how many of its checks passed; a failure stops the run (or
  keeps going, if you mark that step "soft") and everything after it is reported as skipped instead
  of silently vanishing. Each run is saved with the ticket's project as evidence, verdicts only —
  never response bodies, so a token in a login response can't end up in your repo.
- **Somewhere to put the login for the first step, including real 2FA.** Store a test account (label
  + username + password) in API Testing, pick it under **Run as**, and write `{{auth.username}}` /
  `{{auth.password}}` in your login request — the Portal fills them in when it sends. Pick an
  authenticator too and `{{auth.otp}}` becomes the live six-digit code, the same authenticators you
  registered on Instructions → Accounts. Because the flow picks the identity, one login request can
  be re-run as a different role by changing a dropdown instead of editing the request. The password
  is stored outside your project (never committed, never sent to an AI prompt) and is never sent back
  to the page.
- **Accounts you already wrote on Instructions → Accounts can be imported in one click.** If your
  accounts sheet has them, API Testing offers those rows for import instead of making you type them
  again — which is why the account picker used to say "No account" while you were looking at your
  account on the other page.
- **Save your API requests into modules, the way Swagger groups endpoints.** Requests fold under
  collapsible module headers, one click files everything loose under the module its URL path implies,
  and a module can be renamed across every request in it.
- **Generate test cases from an attached specification.** For a ClickUp/Jira ticket that only *links*
  to its spec and has no details of its own, upload the document on the Test cases page — **Word,
  PDF, Excel, CSV or Markdown**. Claude then drafts from the spec, with the ticket deciding which
  part of it is in scope; where the spec and the code disagree it writes the case against the spec
  and says so, since that is the bug worth finding. The document is read in your browser, so the file
  itself never leaves your machine.
- **Pick which device a mobile run drives.** With an Android emulator, an iOS simulator and Maestro's
  Chromium device all up at once, "Web on mobile" and "App on device" used to test whichever one
  Maestro happened to list first. The Run form now detects them and lets you choose — by **name**,
  not by `emulator-5554` — and remembers your choice per project. Leave it on **Auto** for the old
  behaviour.
- **Mobile devices are listed by their real names.** An Android device used to appear as its raw ADB
  serial (`emulator-5554`, `R58M12ABCDE`), so two identical-looking ids gave you no way to tell which
  of your emulators was which. The Portal now asks `adb` for the AVD name you created in Device
  Manager (`Pixel 6 API 36`) or the phone's model, and shows that instead.
- **The sidebar tells you when Auto Agent has logged out.** Every AI feature here shells out to
  `claude`, so when the shared credential lapses or its watcher dies, runs start failing with
  confusing mid-run auth errors. There's now a status line above Release notes — connected, expiring,
  stalled, expired or logged out — plus a toast the moment it drops, so you find out before a run
  does.
- **Read your test cases from the Run form.** The "Test cases" badge on a crawled ticket — and on each
  selected ticket chip — opens the same read-only preview with a version dropdown, whether you picked
  one ticket or queued several.

### Fixed

- **Ctrl+C in the Terminal copies your selection instead of killing the run.** On Windows, selecting
  Claude's output and pressing Ctrl+C out of habit used to send SIGINT and interrupt the run. It now
  copies when text is selected and stays SIGINT when nothing is — what Windows Terminal and VS Code
  do. Ctrl+V, Ctrl+Shift+C and Ctrl+Insert work as you'd expect too, and if the browser blocks
  clipboard access (opening the Portal by IP address rather than `localhost`), you get told so
  instead of quietly copying nothing.
- **`adb` is found even when the Portal was started from a shortcut.** Android Studio doesn't put
  platform-tools on the PATH, so a Portal launched outside a terminal couldn't see `adb` — which is
  exactly the setup where the friendly device names above would have silently fallen back to raw
  serials.
- **The Database page's read-only protection is layered, and each layer was tightened.** The page runs
  SQL the AI wrote and nobody reviewed, so no single check is trusted: comments are stripped and
  string contents masked before the statement is parsed (nothing hides in a comment, and an ordinary
  value like `status = 'update'` no longer false-alarms), every driver runs inside a transaction that
  is never committed — including SQL Server, whose DDL is transactional so even a `DROP` that somehow
  got past the parser is rolled back — and row caps, statement timeouts and password scrubbing apply
  on top.
- **"The AI produced nothing" errors are gone.** A newer Claude CLI returns its result in a different
  shape, and roughly a dozen features that read it — Ask AI on the Database page, crawl summaries, the
  grounding check, auto-learn, the source map, the design system, Design Check — reported an empty
  answer instead. Both shapes are now understood.

### Changed

- **Nothing under `data/` can be committed any more.** That folder is this install's own runtime
  state — the database plus several credential stores (2FA seeds, database passwords, API test-account
  passwords) — and it was being ignored file-by-file, which had already missed two of them. The whole
  folder is ignored now, so a new credential store can't be one forgotten line away from ending up in
  a commit.

## 0.11.7 — 2026-07-29

**Fixes the Playwright `EPERM` error that blocked runs on other people's machines**

### Fixed

- **Runs no longer die with `EPERM: operation not permitted, mkdir 'C:\Users\hao.nguyen'`.** If your
  QC runs were failing the moment the browser opened — every test case Blocked, no screenshots, a
  report full of "environment blocker" — this was why. When you connected Playwright, the Portal
  wrote a **browser-profile folder path belonging to the machine the Portal was built on** into your
  project's `.mcp.json`. On your machine that folder can't be created, so Chrome refused to start
  and nothing after that could run. The path is now worked out on **your** machine when you connect,
  so a fresh Playwright connection is correct for whoever is using it.
- **Projects that already have the wrong path are repaired for you.** You don't need to edit
  `.mcp.json`, reconnect Playwright, or even know which projects are affected — on startup, and
  whenever you open the MCP page, every project's Playwright profile path is checked and corrected.
  A profile folder you deliberately pointed somewhere else inside your own home folder is left
  exactly as it is, and nothing else in the file is touched.
- **The browser profile is the same one everywhere.** "Scan a page for its APIs" and Playwright QC
  runs now resolve the profile folder through one shared definition, so a run and a scan reuse the
  same logged-in Chrome session instead of drifting apart.

## 0.11.6 — 2026-07-29

**Maestro is the only mobile driver — the old ones are gone, including from your config**

### Changed

- **The hidden Mobile and Appium servers are removed for good.** 0.11.4 hid both cards and pointed
  mobile runs at Maestro, but the machinery behind them was still there — their connect buttons,
  their device tests, and the code that recognised their tools. It's all gone now. There is one
  device server to think about, and it's Maestro.
- **A leftover `mobile-mcp` or `appium-mcp` in your project is cleaned up automatically.** 0.11.4
  left those entries in `.mcp.json` and told you to remove them by hand — but with the card hidden
  there was no way to do it from the Portal, and the server was still being started on every run in
  that project, costing you time for nothing. The Portal now strips both on startup and whenever you
  open the MCP page, for every project (and for a server saved to your personal Claude config too).
  Nothing else in your `.mcp.json` is touched.

### Fixed

- **The mobile device test starts faster and explains itself better.** With only Maestro left, the
  test no longer carries the other two servers' special cases — the Node-version check Appium
  needed, and a separate device-detection path that only the Mobile server used. Maestro's own
  check (is the CLI there, is Java new enough) is unchanged.

## 0.11.5 — 2026-07-29

**A single definition for how the ClickUp server is launched**

### Fixed

- **The ClickUp MCP server's launch command lived in two places; now it lives in one.** Connecting
  ClickUp through the sign-in flow and connecting it with an API token each wrote their own copy of
  the same `uvx` command line into `.mcp.json`. Nothing was wrong with either copy — but the next
  time that command needs to change (a new package location, a pinned version), only one of them
  would have been updated, and you'd have got a working ClickUp on one path and a dead one on the
  other. Both now share one definition. Nothing changes in your existing `.mcp.json`.

## 0.11.4 — 2026-07-28

**One mobile driver instead of three — mobile runs now go through Maestro**

### Added

- **Maestro on the MCP page — one-click connect, with the two things it actually needs checked
  first.** Maestro drives an iOS/Android simulator or a Chromium browser, and it's the only device
  server the Portal can't install for you: it's a separate binary and it hard-requires **Java 17+**.
  So the card checks both *before* writing anything — if the CLI is missing it shows you the install
  command, and if your default Java is too old it says so (and which version it found) instead of
  leaving you with a dead "failed" badge. When a newer JDK is installed alongside an old default
  Java, Connect finds it and pins it for you, so you don't have to re-point your system Java.
- **Functional test for Maestro.** "List devices" reports what can actually be driven right now —
  booted simulators and devices, plus Maestro's built-in Chromium web device — and each detected
  device gets a **Drive** check that reads its screen to prove control. Simulators that are merely
  installed but shut down are left out, so the list means what it says. The test is given room for
  the slow first drive of an iOS simulator (Maestro installs its driver on the device that one time).

### Changed

- **Mobile QC runs now require Maestro, not the Mobile server.** On **QC Run**, picking **Web on
  mobile** or **App on device** checks for **Maestro** and points you there — the readiness row reads
  *Device MCP*, and the hints beside each target link to it. The run itself is told to drive the
  device through Maestro only, so it stops reaching for a different mobile server mid-run.
- **The Mobile (mobile-next) card is hidden.** With Maestro covering both mobile-web and native-app
  runs, there's one device server to set up instead of a choice between three. Appium was already
  hidden for the same reason. **Existing projects are untouched** — a `mobile-mcp` entry already in
  your `.mcp.json` keeps working; it just isn't shown or offered any more. Remove it there if you
  want it gone.
- **In-app manual and the MCP guide tour** now name Maestro as the mobile driver, and the run manual
  no longer labels the two mobile targets "Coming soon" — they've been live for a while.

### Fixed

- **A mobile run that fails mid-action is diagnosed properly again.** The run detail page works out
  *why* a run ended badly by looking at what it was doing at the time, but it only recognised the old
  mobile server's tool names — so a Maestro run that died while driving the device got a vague
  explanation instead of the real one.

## 0.11.3 — 2026-07-27

**Runs get past real 2FA on their own — authenticator codes, not a fixed OTP**

### Added

- **Authenticator (2FA) codes on the Accounts tab.** On a production-like environment the login code
  isn't a fixed OTP you can write in your accounts sheet — it's the real six digits from Google
  Authenticator / Authy, changing every 30 seconds. Until now a QC run hit that screen and either
  stalled or made a code up. Now you register the account's **setup key** once (the base32 secret
  shown next to the QR code when 2FA is enrolled — or just paste the whole `otpauth://…` link and the
  issuer, account and settings fill themselves in), and the Portal computes the exact same code your
  phone shows. A run fetches the live code itself when a login asks for one, so **it gets through 2FA
  unattended**. The card shows each code with a countdown so you can compare it against your phone and
  confirm the key is right.
- **Test cases stop hard-coding OTPs.** When a project has an authenticator registered, generated
  cases say "enter the current authenticator code for &lt;account&gt;" instead of a literal six digits —
  which would be wrong by the time anyone ran the case — and no longer raise cases about the code
  being unavailable.
- **An MFA column in the accounts sheet.** The example CSV and the starting template now include an
  **MFA** column (`None` / `Fixed OTP 123456` / `Authenticator: <label>`) so it's explicit per
  environment how a login gets its code, and Claude can't assume a fixed OTP that doesn't exist.

### Changed

- **Runs are told never to invent a code.** The run prompt and the managed `CLAUDE.md` context block
  both now spell out how to obtain a real code, that it must be submitted immediately (and refetched
  if rejected), that a code must never be written into a report, note or screenshot, and that a login
  with no matching authenticator is reported as **blocked** rather than guessed at. Projects with no
  authenticators registered are completely unaffected.

### Security

- **Setup keys are stored outside the project folder.** Unlike the accounts sheet, an authenticator
  secret is a long-lived second factor, so it never lands in your repo (and so can't be committed) and
  is never packed into a prompt. It lives beside the Portal's own database with owner-only
  permissions, is never shown again after saving, and is never sent to Claude — only a live code is.
  Deleting an entry erases its key.

## 0.11.2 — 2026-07-26

**Design-system-aware prototypes, several terminals at once, and skill updates that keep your edits**

### Added

- **Prototypes that look like your product, not a stranger.** The Prototype page can now read your
  app's real visual language **once** — its palette, fonts, spacing, button and input shapes, and the
  way it words labels, statuses and error messages — and every prototype after that is built to match
  it. Use the **Design system** pill above the chat; it needs a connected repo and takes a minute or
  two. It's saved as the `design-system` doc on **Instructions → Knowledge**, so you can read it and
  **correct anything the AI got wrong** (editing it makes it yours). This replaces re-reading your
  source on every single build, which was slow and gave a slightly different answer each time.
- **Comment on the screen instead of describing it.** Turn on comment mode in the preview toolbar,
  click any element — a button, a label, a column — and say what should change. Pin as many as you
  like, then **Apply**: they go up as one instruction that names each element precisely and leaves
  the rest of the screen alone. No more "the third button in the top-right, no, the other one".
- **The prototype now asks you the questions it had to guess.** Every build reports the real
  **requirement gaps** it hit — *"Can a closed note still be edited?"*, never questions about colours
  or taste. Answer one and the screen is rebuilt to match; your answer is kept as a **confirmed
  decision** that grounds every later build and is never asked again. That list is your record of
  what the team settled while reviewing the screen. Questions stay until you answer or dismiss them.
- **Download a prototype as a standalone `.html` file** — one self-contained file that opens in any
  browser with no server, so you can email it or attach it to the ticket.
- **Several terminals at once.** The Terminal page is now a tab strip: each tab is its own shell on
  your machine, so you can leave Claude working in one and run git or tests in another. Tabs are
  remembered per project, and a shell keeps running when you navigate away — coming back re-attaches
  to it (closing a tab is what ends it).
- **A run now records which surface it tested** — Web, Web on mobile, or App on device — and the tag
  is shown on every History row and in the run's detail header. Where a ticket was tested on more
  than one surface, History shows which ones while the group is still collapsed. Older runs get a
  best-effort guess rather than a wrong label.
- **Connected devices are detected instantly.** Picking a device for a mobile run used to wait on a
  full AI + MCP round trip (~16s, and flaky). It now asks the platform directly — `adb` for Android
  on both macOS and Windows, `xcrun simctl` for iOS simulators — so the picker fills immediately and
  "nothing is booted" comes back at once.
- **Reset a template to the one the portal ships.** Templates that have a bundled default now offer
  **Reset to default** (with a confirm, since it overwrites what's saved).
- **Memory notes are paged** — auto-capture adds notes steadily, so the list stays scannable instead
  of growing into an endless scroll.

### Changed

- **The run progress bar now tells you which phase you're in.** It's a labelled 7-step stepper, and
  the phase is inferred from what the run is actually *doing* (driving the app, fanning out
  subagents, writing the report) rather than from the model narrating "Phase N" — which it mostly
  doesn't, so the bar used to sit at **Intake** for most of a run. It only ever moves forward.
- **The `qc-testing` skill has been substantially reworked.** It now reads the ticket's **generated
  manual test cases** as an input, can **verify a reported bug**, announces each phase so the Portal
  can follow along, and carries explicit severity and status rubrics so verdicts are consistent.
  On "black-box": it may now read your source code to learn what the correct behaviour *is* (real
  field names, validation limits, states, roles) when a ticket is vague — but the report is still
  written as a user's report, and "the code says so" is never evidence that the app behaves so.
  Its Playwright recipes were corrected to the tools' **real** parameter names.
  **Note:** run output now lands in `testing/test-result/<ticket-id>-<slug>/` rather than
  `testing/<ticket>/`. Existing folders are left alone.
- **MCP page:** a server you haven't connected yet now explains in one line what it's for and why it
  matters, and a connected one is tinted so the page is scannable at a glance.
- Guided tours are anchored to specific elements on the API Testing, Settings and Templates pages,
  so a step can no longer highlight the wrong box (or silently vanish).

### Fixed

- **Two browser windows no longer fight over a terminal.** Opening the Terminal page in a second
  window used to make both windows steal every session back and forth forever, flapping between
  Connected and Connecting. A window is now told explicitly when someone else has taken a session
  over, never re-attaches to a shell another window holds (it offers **Take over** instead), and
  gives up after a few unattended attempts. A session whose window vanished is also no longer
  reported as "open somewhere else" with nobody watching it.
- **Restarting the portal no longer leaves orphaned shells behind.** Terminal shells outlive their
  browser connection by design, so shutdown now kills them explicitly.
- **Your project's copy of `qc-testing` no longer drifts behind the portal.** Updating QC Portal only
  refreshed the master copy, so projects kept running last month's skill. Copies **you never edited**
  are now refreshed automatically at startup; a copy you **hand-edited is never overwritten** — the
  Skills page offers you the update instead, and files you *added* to the folder are always kept.

## 0.11.1 — 2026-07-24

**Import now tells you why a .zip won't load, instead of a vague error**

### Fixed

- **Clearer "import project" errors.** Importing a project from a `.zip` used to fail with a single
  unhelpful message — *"could not read that .zip file"* — no matter what was actually wrong. Import now
  names the real cause and how to fix it: an **incomplete or interrupted download** ("re-download or
  re-export and import the fresh file"), a **file that isn't really a zip** (e.g. a renamed or partly
  downloaded file — it now checks the zip signature up front), and a **password-protected zip** (not
  supported — re-export from QC Portal, whose exports are never encrypted). Valid exports import exactly
  as before.

## 0.11.0 — 2026-07-24

**Database page, native app testing on a device, and Appium support for mobile runs**

### Added

- **New Database page.** Connect a project to its database (MySQL, PostgreSQL, or SQL Server) and let
  Claude use it during testing. The portal reads the schema and saves a **schema map into Knowledge** so
  runs and test-case generation know your real tables and columns. A **query & ask console** lets you ask
  a question in plain English — Claude writes a query, runs it, and shows both the SQL and the results —
  or run your own SQL by hand. **Everything is read-only** (point it at staging or a read replica), and
  the password is only used to read the schema, never logged or stored in run history.
- **Test a native app on a device.** The Launch QC Run page's **App on device** target is now available
  (it was previously "Coming soon"). Pick it, **name the app installed on the device** (a display name
  like `MyApp`, or a package / bundle id like `com.example.myapp`), and Claude launches *that* app on a
  booted device and tests it there — no URL needed. A clear reminder tells you to **install the app on
  the device first**: the portal launches an already-installed app by name, it won't install it for you.

### Changed

- **Mobile runs now work with Appium too.** Both **Web on mobile** and **App on device** can be driven by
  **either Mobile MCP or Appium** — whichever your project has connected. You only need one of the two set
  up to run, and the MCP page verifies the connected driver can actually see and control a booted device.

## 0.10.3 — 2026-07-23

**Terminal slash commands: run with one click, clearer tooltips, and a new /usage entry**

### Added

- **Run a slash command with one click.** Each command in the Terminal's **Slash commands** dialog now
  has a **Run** (▶) button that types the command into the live session *and* presses Enter for you.
  Clicking the command text still just inserts it (so you can review and press Enter yourself) — now you
  can pick whichever you want per command.
- **`/usage` added to the list.** Shows your plan usage and rate-limit status, alongside the existing
  `/help`, `/cost`, and `/status` commands.

### Changed

- **Clearer tooltips on the two actions.** Hovering the command text explains it inserts without Enter;
  hovering the Run button explains it types the command and sends Enter right away — so the two ways to
  use a command are no longer ambiguous.

## 0.10.2 — 2026-07-23

**Guided tours, an API page scanner, a terminal slash-command picker, and searchable Memory**

### Added

- **Per-page guided tours.** A single **Guide tour** button now sits at the bottom-right of every
  major page. Click it for a step-by-step walkthrough that spotlights each part of the page in turn —
  Tickets, API Testing, Instructions, Skills, MCP, Templates, Prototype, Terminal, and Settings all
  have one. The Instructions tour now actually walks through each tab (Instructions → Knowledge →
  Memory → Accounts → AI Brain) so the panel changes as you read, instead of parking on the tab strip.
- **Scan a page for its APIs.** On the **API Testing** page, paste a page URL and the portal drives a
  browser to capture the XHR/fetch calls that page makes, then shows a deletable preview list you can
  import as saved requests. It runs **headless by default** (no visible browser window); tick a box if
  you'd rather watch it in your own Chrome profile.
- **Slash-command picker in the Terminal.** A **Slash commands** button opens a dialog of the most
  useful Claude Code commands (`/clear`, `/compact`, `/context`, `/review`, `/model`, `/mcp`, and more),
  grouped by purpose. Click one to type it straight into the live session — you press Enter to run it.
- **Search your Memory notes.** The **Memory** tab now has a search box that filters notes by name or
  description as you type (and matches AI-captured notes too).

### Changed

- **Only one Guide tour button.** Consolidated the earlier duplicate per-page tour buttons into the
  single bottom-right button so no page shows two.

## 0.10.1 — 2026-07-22

**Tracker tokens are now honestly reported, and Azure DevOps tickets load reliably**

### Fixed

- **Azure DevOps & Jira cards now catch a bad token instead of showing a false "connected".** Until now
  only ClickUp actually test-called the provider — Azure and Jira went green off the bare connection
  handshake, so an expired, wrong, or misplaced token (for example a ClickUp `pk_` token pasted into
  the Azure **PAT** field) still looked healthy while the Tickets page silently loaded nothing. All
  three tracker cards now live-verify the credential and show **needs-auth** with a clear reason when
  it's rejected.
- **Azure DevOps tickets load for large projects.** Browsing a project with more than 20,000 work items
  failed with an Azure size-limit error and showed no tickets; the Tickets list now caps the query so it
  returns the most recently changed work items instead of erroring.
- **The Tickets page no longer shows ClickUp when it isn't configured for the project.** ClickUp tickets
  are now driven purely by the project's MCP configuration — if a project has no ClickUp server on the
  **MCP** page, the Tickets page won't offer ClickUp as a source. (Previously a token left in the
  server's environment could make ClickUp appear even when it wasn't set up for that project.)

### Changed

- **"Getting API tokens" docs updated** with the new `needs-auth` behavior and Azure DevOps gotchas:
  the **Default project** must exactly match a real project name, and pasting the wrong token into the
  PAT field now surfaces as `needs-auth`.

## 0.10.0 — 2026-07-20

**Crawl queue, a rebuilt issues-to-ClickUp panel, and steadier test-case generation**

### Added

- **Queue crawls back-to-back on the Tickets page.** Start a crawl while one is already running (or
  more are queued) and the new selection is added to a queue that auto-runs the next batch when the
  current finishes — the selection clears immediately so you can line up the following batch. A queue
  banner shows how many tickets/batches are waiting, with a **Clear queue** action. Each queued crawl
  still announces its own completion notification.
- **Search now finds subtasks by ID.** On the Tickets page, typing a subtask's id (or name) in the
  search box now returns that subtask — previously only parent tickets were searchable, so a subtask
  id matched nothing.
- **Selected test-case tickets show as removable chips.** On the Test cases page the tickets you've
  picked appear as badges under the search box (hover for the full title, click ✕ to unpick, or
  **Clear all**), and a selected ticket stays visible even while you filter/search for the next one.

### Changed

- **Rebuilt the "Review issues → ClickUp" panel on a run's Issues tab.** Issues are now compact
  one-line rows with a severity badge; **clicking a row scrolls to that issue's full detail below and
  highlights it**. Screenshots show as thumbnails that open in a **lightbox**, and each issue's
  description renders as real formatted text (bold labels, lists) instead of raw `**…**`.
- **Bug subtasks created in ClickUp inherit the parent ticket's assignees, tags, and priority**, so a
  logged bug lands on the right person with the right context instead of empty.
- **Deleting a test-case row now renumbers the sequence.** After removing a row, both the **No (STT)**
  and **Test Case ID** columns are re-sequenced so there are no gaps (e.g. deleting #04 shifts #05→#04)
  — each column keeps its own format (`01`, `TC-001`, `No-01`).
- **Generated CSV test cases now fill the Priority column.** The generator previously treated Priority
  as an execution column to leave blank; it's now correctly authored (High / Medium / Low).
- **The Run page no longer re-selects a ticket that's already running.** When it restores your last
  selection, any ticket with an in-flight run is dropped so you don't accidentally re-run it.

### Fixed

- **A brand-new project no longer shows MCP as "configured".** The MCP badge (and the "Fully
  configured" count) went green just because an empty `.mcp.json` scaffold existed; it now turns green
  only once at least one MCP server is actually configured.
- **The occasional malformed test-case CSV is auto-repaired.** When a generated row was misaligned by
  an unescaped comma (the intermittent "format error"), the file is now fixed in place — the same
  cases re-emitted with correct quoting/columns — instead of saving a corrupt row. It only runs when a
  defect is detected and is discarded unless it cleanly resolves the issue.

## 0.9.33 — 2026-07-20

**Test-case generation's "Set one URL for all" starts empty**

### Changed

- **The "Set one URL for all" field in Generate test cases no longer pre-fills.** It used to remember
  the last live-app URL you used and pre-populate it, which meant an old URL could quietly carry into a
  new batch. It now starts blank every time the dialog opens — a live app URL is opt-in per generation,
  matching "leave blank to generate from the ticket alone."

## 0.9.32 — 2026-07-20

**Token-guide links open in a new tab (no more losing what you typed)**

### Fixed

- **The "How to get a token" / "token guide" links no longer wipe the form you're filling in.** On
  Source Code and the MCP page, those help links used to navigate away in the same tab, so anything
  you'd already entered (repo URL, tag, other token fields) was lost and had to be re-typed. They now
  open the guide in a **new tab**, leaving your half-filled form untouched.

## 0.9.31 — 2026-07-20

**Copy now puts the real token on the clipboard, not the masked one**

### Fixed

- **Copying a secret from MCP "View details" copied the mask (`••••9B6B`) instead of the real value.**
  The copy button now always fetches and copies the full value, whether or not you've clicked Reveal —
  so copying an API token or PAT gives you the actual token. Copying the whole `.mcp.json` entry
  likewise yields a usable config with real secret values.

## 0.9.30 — 2026-07-20

**Only real secrets are masked in MCP config**

### Changed

- **MCP settings now mask only actual secrets.** Non-secret values — a Jira **site URL** and **account
  email**, an Azure **organization URL** and **default project** — are shown in full instead of being
  masked to something like `••••.net`. Only true secrets (API tokens, keys, and the Azure PAT) stay
  masked with a **Reveal** toggle. This applies on the connected card, in the "View details" dialog, and
  in the raw `.mcp.json` preview.

## 0.9.29 — 2026-07-20

**MCP "View details" now reads like the connect form**

### Changed

- **The MCP details dialog shows your fields with friendly names.** Instead of raw shell variable names,
  the "View details" dialog now labels each setting the way the connect form does — e.g. Azure DevOps
  shows **Organization URL**, **Default project**, and **Personal Access Token** (its fixed internal
  auth-method flag is hidden from the list but still visible in the raw `.mcp.json` entry). Every value
  has a one-click **copy** button, and the **Reveal** toggle still unmasks secrets on demand.

## 0.9.28 — 2026-07-20

**Fix the MCP "View details" dialog spilling outside its box**

### Fixed

- **The MCP server details dialog no longer overflows.** With a long command or `.mcp.json` block (e.g.
  ClickUp's `uvx --from git+https://…` line), the dialog's rows and JSON preview spilled past the white
  panel onto the page behind it. The content is now constrained to the dialog — long values truncate,
  and the `.mcp.json` preview scrolls inside its own box — with the dialog scrolling vertically if it's
  tall.

## 0.9.27 — 2026-07-20

**See a connected MCP server's full configuration**

### Added

- **"View details" on every connected MCP server.** Each connected card (ClickUp, Figma, Jira, Azure
  DevOps, Playwright, Mobile) now has a **View details** button that opens a dialog showing the server's
  complete configuration from `.mcp.json` — its transport, the exact command + arguments (or URL), and
  **all** of its environment variables, not just the one masked key shown on the card. Secrets stay
  masked by default; a **Reveal** toggle shows the real values on demand (localhost only, never logged),
  and everything — each value and the whole `.mcp.json` entry — is one click to copy.

## 0.9.26 — 2026-07-20

**"Update now" no longer gets stuck on the loading page (Windows)**

### Fixed

- **The in-app "Update now" could hang forever on a spinning page on Windows.** After the update
  rebuilt and restarted the server, the page sometimes reloaded at the wrong moment — onto the old
  server as it was being shut down, or onto one still mid-restart — and got stuck loading. The portal
  now waits until the server comes back as a genuinely **restarted** process (reporting the new
  version, or confirmed to have gone down and returned), double-checks it twice, and only **then**
  reloads. Every "is it back yet?" check now also has a hard timeout, so a stalled connection during
  the restart can't freeze the wait. If the server genuinely doesn't return in time you'll get the
  clear "Update timed out" message (pointing at `data/update.log`) instead of an endless spinner.

## 0.9.25 — 2026-07-20

**Crawl tickets from Azure DevOps Boards**

### Added

- **Azure DevOps is now a ticket source on the Tickets page.** Once you connect Azure DevOps on the
  MCP page, the **Tickets** page can browse, search, and **crawl** your Boards work items — bugs, user
  stories, and tasks — just like ClickUp and Jira. Each crawled work item's description, **repro steps**,
  **acceptance criteria**, comments, and attachments download into \`testing/tickets/\` so the QC skill,
  test-case generation, and Design Check can read them locally. When more than one tracker is connected,
  a source toggle (ClickUp / Jira / Azure DevOps) appears above the ticket list.
  - **Pick a project fast.** If you set a **default project** when connecting, the picker uses it and the
    PAT only needs Work-Items read. Leave it empty to choose from all projects (that needs the PAT's
    *Project and Team → Read* scope). The **Getting API tokens** doc page spells out the exact scopes.

## 0.9.24 — 2026-07-17

**Connect Azure DevOps Boards, and QC screenshots now show inline on ClickUp cards**

### Added

- **Azure DevOps Boards is now a connectable MCP server.** On the **MCP** page you can connect Azure
  DevOps with your **organization URL** and a **Personal Access Token** (plus an optional default
  project) — the same paste-a-token flow as Jira. Once connected, QC runs and test-case work can read
  bugs, user stories, and tasks straight from your Boards. The step-by-step token guide (how to create
  the PAT and which scope to grant) is on the in-app **Getting API tokens** doc page.

### Changed

- **QC bug screenshots now appear inline on the ClickUp card.** When the portal files a QC issue as a
  ClickUp subtask, it uploads the run's screenshots and posts them as an inline **QC evidence** comment,
  so the images show right in the card's thread instead of as a dead local path. Best-effort — a failed
  upload or comment never blocks creating the subtask.

## 0.9.23 — 2026-07-17

**Faster MCP status, a run guard for missing browser MCP, and Prototype polish**

### Added

- **Web runs won't start without their browser MCP.** A web test drives a real browser through the
  **Playwright** MCP server (mobile targets use **Mobile MCP**). If that server isn't set up for the
  active project, the Run page now disables **Start**, adds a **Browser MCP** row to the readiness
  checklist, and shows a clear message pointing you to the MCP page — so a run can no longer fail deep
  inside Claude just because the browser was never configured.

### Changed

- **MCP page checks status faster.** The server list now appears instantly and each server's live
  connection status fills in right after, instead of the whole page waiting on the health probe. Behind
  the scenes the Claude health check and the ClickUp token check run at the same time (not one after the
  other), and a stuck server can no longer hold the check up as long. What gets checked is unchanged —
  it's just quicker and no longer blocks the page.

### Fixed

- **Prototype builder polish.** New prototypes are auto-named *Prototype 1, 2, 3…*; the list shows each
  one's created time and is more compact; the settings dialog is wider with a roomier name field; the
  model picker explains each model and defaults to **Sonnet**. The chat can now float as a bubble in the
  bottom-right corner (the default) or dock beside the preview, with smooth open/close animation and the
  Prototypes list tucked alongside it. While building, an animated 3D "building" loader with rotating
  status text replaces the plain spinner, and the empty-state onboarding text is no longer clipped in the
  smaller floating chat.

## 0.9.22 — 2026-07-16

**Prototype builder — describe a screen and watch Claude build the UI**

### Added

- **New Prototype page (under Tools).** Describe a screen in plain language and Claude builds a working
  HTML/CSS mock-up you can see immediately — then keep chatting to refine it ("make the header sticky",
  "add a pricing table"). Each prototype is saved per project, so you can come back to it, and you can
  duplicate, rename, or delete one from its **settings** dialog.
- **Watch it build in real time.** The generated code streams in live with an elapsed-time readout and a
  **Stop** button, and you can expand the **Claude logs** panel to see what it's doing. A skeleton +
  overlay shows while it's building or updating so the old preview never looks broken mid-change.
- **Start settings for a fresh build.** On the first message you can pick a **design style** (with visual
  preview thumbnails — clean, modern SaaS, glassmorphism, brutalist, playful, corporate, elegant),
  a light/dark **theme**, and an **accent colour**, so the very first draft already looks the way you want.
  Claude is also instructed to always produce a polished, fully responsive layout that never breaks on
  small screens.
- **Preview like a real device.** The preview toolbar lets you view the design at **Desktop, Laptop,
  Tablet, or Mobile** widths — tablet and phone render inside a device frame you can **rotate between
  portrait and landscape**. Each control has a hover tooltip explaining what it does.
- **Capture & copy.** On the Preview tab, a **camera** button copies a PNG snapshot of the rendered
  design to your clipboard; on the Code tab, a **copy** button copies the full HTML. You can also open
  the prototype in a new browser tab.
- **Attach images to guide the design.** Drag-and-drop (or paste) reference images into the chat and
  Claude uses them when building the UI.

### Changed

- **API Testing — reusable environments & response capture.** Save multiple named environments (e.g.
  Local / Staging) with their own base URL and variables, reference them anywhere with `{{variable}}`,
  and **capture a value straight from a response** into a variable to reuse in later requests. Values you
  mark **secret** are stored on the server and masked in the UI.

### Fixed

- **API Testing request bugs.** Duplicate request headers and `Set-Cookie` responses are now handled
  correctly, and a redundant save that could show a stale "AI" badge was removed.

## 0.9.21 — 2026-07-15

**Tell Claude your environments & test accounts — no more `<System account>` placeholders**

### Added

- **New "Accounts" tab on the Instructions page.** Keep your app URLs and test-account logins for
  the project in one place: upload a CSV/Excel sheet (converted to a table right in your browser) or
  type it in by hand. A **Download example** button hands you a ready-to-fill template so you know the
  exact columns — Environment, URL, Role, Username, Password, Notes.
- **Claude now logs in with your real accounts.** When a test case says "log in as …" — or a QC run
  needs to reach the app — Claude uses the exact environment URL and test account from your sheet
  instead of inventing a placeholder. This works for both test-case generation and full QC runs
  (the sheet is fed into generation directly, and QC runs are pointed at it and told to use it).
  Runs pick it up the next time they start after you save.

### Changed

- **Use non-production accounts only.** The sheet is stored as plain text in the project
  (`testing/environments.md`) and read by Claude, so the tab shows a clear warning: put only
  throwaway QA/staging test accounts there — never real user or production credentials.

## 0.9.20 — 2026-07-15

**Project import no longer fails with "a .zip file is required" on Windows**

### Fixed

- **Importing a project now works reliably, including on Windows.** Import used to bundle the whole
  zip into a text-encoded request, which for a real project (crawled ticket attachments + evidence)
  could quietly arrive empty and fail with *"a .zip file is required"* even though a valid file was
  chosen. The zip is now uploaded directly as-is, so large projects import dependably. The dialog
  also refuses an empty/0-byte file up front with a clear message, and any server-side error now
  comes back as readable text instead of a raw error page.

## 0.9.19 — 2026-07-15

**Cleaner ClickUp issue cards with real screenshots, clickable evidence on the Issues tab, and reliable project import**

### Added

- **Screenshots on the Issues tab are now clickable.** Any `screenshots/…png` reference in a run's
  Issues tab opens a preview dialog with the actual image, the same way the Report tab already worked —
  no more hunting for the file on disk.

### Changed

- **ClickUp issue subtasks are tidier and carry the actual screenshot.** When you push QC issues to
  ClickUp, each subtask no longer repeats its own title inside the description or restates the
  acceptance-criteria line, and the "Screenshot: …" text path is now uploaded as a **real image
  attachment** on the card instead of a dead local path. Attaching is best-effort — if an image is
  missing the subtask is still created.

### Fixed

- **Importing a project no longer fails for real projects.** A project export can be large (crawled
  ticket attachments and evidence), and import was rejecting anything over ~37 MB with a raw server
  error page. Import now accepts large project zips, and any remaining error comes back as a clear,
  readable message instead of a wall of HTML.

## 0.9.18 — 2026-07-13

**New API Testing page, plus reports render cleanly instead of leaking raw HTML**

### Added

- **API Testing page (sidebar → Testing → API Testing).** Send any HTTP request from the portal and
  keep the result as evidence — no external tool needed. Paste a **cURL** command straight from your
  browser's DevTools or an app and it fills in the method, URL, query params, headers, and body for
  you (and you can copy the request back out as cURL). Saved requests live per project: they
  **auto-save on any change**, rename with the pencil icon, and ask before deleting.
- **Rule-based assertions.** Add checks — status is 2xx / equals, body contains / matches, JSON path
  equals / exists, header equals / exists, response time under N ms — with quick-add presets, and see
  a pass/total bar with each row coloured green or red after every Send.
- **Automatic QC & security scan.** Every response is graded for common issues — plain HTTP, missing
  security headers (HSTS, nosniff, CSP, clickjacking), permissive CORS, server/version disclosure,
  insecure cookies, leaked stack traces / SQL errors / secrets / PII, wrong or missing Content-Type,
  slow or oversized responses — bucketed high / warning / info.
- **AI check against plain-language expectations.** Type what the response *should* do (or pick from
  quick-select criteria chips) and the AI verdict — pass / partial / fail with per-point reasons and
  flagged issues — runs **automatically right after each Send** when an expectation is set.
- **Result history.** Every Send on a saved request is stored under `testing/api-tests/` (newest 30
  kept) so you have a trail of what you tested and what came back.

### Fixed

- **QC run reports no longer show a wall of raw HTML at the top.** Some reports opened with a literal
  `<style>` block and raw `<table>` markup printed as text, because the report viewer renders
  Markdown, not HTML. The report prompt now requires pure GitHub-Flavored Markdown — markdown pipe
  tables and `![](image)` links — so every table and screenshot renders instead of leaking as source.

## 0.9.17 — 2026-07-13

**Generated CSV test cases no longer shift values into the wrong columns**

### Fixed

- **A test case with a comma in a short field no longer pushes its Steps and Expected result into
  the Actual result and Priority columns.** When a single-line field — most often a Pre-condition
  like `Services of different modalities exist (e.g. X-Ray, CT, MRI)` — contained a comma and wasn't
  wrapped in quotes, that comma split the field and shoved every later value one or more columns to
  the right, so columns that should stay blank on a fresh sheet (Actual result, Priority) ended up
  holding the real steps and expected results. The test-case generation prompt now treats quoting
  every free-text column as an absolute rule on every row — including the short single-line values
  that are the usual culprit — and self-checks each row before finishing (a non-blank Actual result
  or Priority is the tell-tale sign of a dropped quote). The portal already flags any remaining
  shifted rows by ID in the generation log so you can spot-fix or regenerate.

## 0.9.16 — 2026-07-13

**Report results are always shown, correctly counted, and in sync between History and the run detail**

### Changed

- **Every report now opens with the same three sections — Test Suite Executed, Covered Flow, and
  Execution Summary — on every run, even a blocked or failed one.** QC reports used to vary in shape,
  which made them hard to scan and hard for the portal to total up reliably. The report format is now
  a fixed contract: a "what was tested" header, a flow-coverage table, and a summary table whose
  percentages add up to 100% with a Pass Rate and Completion Rate. The Execution Summary now lists
  **Blocked** and **Not Tested** as separate rows (never merged), so each bucket is reported on its own.

### Fixed

- **The "Test execution results" table now appears for any ticket that has generated test cases.**
  Previously it only showed when the test-case sheet already carried execution columns (Status /
  Actual result / …); a sheet without them, or a run where the per-case verdicts couldn't be
  determined, produced no table at all on some machines. The portal now adds the standard execution
  columns itself and always writes the executed sheet, so the table is consistently there to review.
- **Run History counts now match the run detail exactly.** History used to fold Blocked cases into
  "Failed", so a run showing 4 failed / 60 blocked on its detail page appeared as 64 failed in the
  list. History now shows the full breakdown — Passed · Failed · Blocked · Untested · Cancelled —
  bucket-for-bucket identical to the detail page, and older runs reconcile themselves automatically
  the first time they're listed or opened.
- **Pass rate and totals are computed over the whole suite.** The acceptance-criteria total now
  reconciles with the report's own Total row (Blocked and Not Tested are counted, not dropped), so
  the headline percentage reflects how much of everything planned actually passed.

## 0.9.15 — 2026-07-08

**Windows: canceling a run no longer leaves runs piling up on top of each other**

### Fixed

- **On Windows, stopping (or pausing) a QC run now fully shuts down its test browser and helpers —
  so the next run doesn't start while the old one is still going.** Each run launches Claude, which
  in turn opens the Playwright/Edge test browser and its MCP helpers. On Windows the portal was only
  closing the outer command-window wrapper on cancel, leaving the real Claude process and its browser
  running in the background. Because that leftover work never registered as "finished", newly started
  tickets stopped waiting their turn in the queue and ran at the same time — the runs appeared to
  execute in parallel instead of one at a time (macOS was unaffected). The portal now terminates the
  whole process tree on Windows, so a canceled run leaves nothing behind and the one-at-a-time queue
  holds. The queue ordering itself was already correct; this was strictly a Windows process-cleanup
  problem.

## 0.9.14 — 2026-07-07

**Failed runs now tell you WHY, without digging through the log**

### Added

- **A plain-language "Why it failed" banner on failed test results.** When a run ends without a
  report — for example the Playwright/MCP test browser hung or dropped its connection, the portal
  server restarted mid-run, or the app URL couldn't be reached — the run page now shows the reason up
  front instead of a bare "check the log". It appears at the top of the run and inside the (otherwise
  empty) Report and Issues tabs, explains what went wrong in everyday terms, shows the exact error
  line pulled from the log, suggests what to try next, and gives you a one-click **View full log**.
  Recognized cases include the Playwright browser hanging/disconnecting, an MCP server not
  responding, network/connection errors, a server interruption, and unexpected exits.

## 0.9.13 — 2026-07-07

**Generated test cases show up right away — no manual reload**

### Fixed

- **New test-case versions now appear as soon as each ticket finishes.** After generating, the
  crawled-ticket "Test cases" badge and the version list refreshed only after the *whole* job fully
  settled — but the job stays busy for a few more seconds running the background "learn from these
  cases" step, even though the cases are already saved. That gap made it look like nothing happened
  until you reloaded the page. The Test cases page now refreshes the moment each ticket's version is
  written, so the new version shows immediately.

## 0.9.12 — 2026-07-07

**No more console window popping up when you update from the app**

### Fixed

- **Clicking "Update now" (or the update icon) no longer flashes a terminal window on Windows.**
  When the update was started from the portal UI, each step (git, npm install, build) opened its own
  console window because it had no terminal to attach to. The updater now runs those steps fully
  headless when there's no user terminal, so the update happens quietly in the background — the page
  still reloads on its own once the new version is live. Running `qc-portal --update` yourself in a
  Command Prompt still shows full progress as before.

## 0.9.11 — 2026-07-07

**Tidier "New folder" row in the Browse… picker**

### Fixed

- **The New-folder input no longer gets cramped.** When you click **New folder** in the picker, the
  name field now spans the full row and the **Create** / **Cancel** buttons always stay visible,
  instead of being squeezed next to the current path. (If you also see a small colored icon inside
  the field, that's a browser extension adding an "AI write" button — not part of QC Portal.)

## 0.9.10 — 2026-07-07

**Create a new folder right from the "Browse…" picker**

### Added

- **A "New folder" button in the folder picker.** When adding or editing a project, the **Browse…**
  picker now has a **New folder** button — type a name, hit **Create**, and the folder is made in the
  location you're browsing and selected for you, so you can register a fresh project folder without
  leaving the portal. Invalid names are sanitized and duplicates are rejected with a clear message.

## 0.9.9 — 2026-07-07

**"Browse…" now opens a folder picker inside the portal — no more spinning forever**

### Changed

- **The "Browse…" button when adding or editing a project now opens a folder picker _inside_ the
  page** instead of a Windows/macOS system dialog. Navigate your drives and folders (or type/paste a
  path) and click **Use this folder**. The old system dialog could only appear when the portal was
  running in your own signed-in desktop — so if the portal was started from a shortcut, at login, or
  any other way, **Browse…** would just spin forever with no window ever showing. The in-portal
  picker always works, however the portal was launched. The separate "In-app" button added in 0.9.8
  is gone — there's just one **Browse…** button again, and it's the reliable one.

## 0.9.8 — 2026-07-07

**In-app folder browser so "Browse" always works, plus an executed test-case record from each run**

### Added

- **A built-in folder browser for picking a project folder.** Next to **Browse…** on Add/Edit
  project there's now an **In-app** button that opens a folder browser *inside the portal* — navigate
  drives and folders, or type/paste a path, and click **Use this folder**. Unlike the native
  **Browse…** dialog (which needs the portal to be running in your own desktop session and can hang
  with nothing appearing when it isn't), the in-app browser works no matter how the portal was
  started — from a Command Prompt, at login, or remotely. Use it whenever **Browse…** doesn't pop a
  window.
- **An "executed" test-case sheet is written after every QC run.** When a run finishes, the portal
  clones the ticket's latest test-case file and fills in the execution columns — Actual result,
  Status, Reference, Note — from the run's report, saved alongside the report as
  `testcases-executed.<ext>`. You get a ready-to-file QC execution record without copying verdicts by
  hand. The steps, expected results, and priority are spliced through untouched, so the AI can't
  corrupt them; it's best-effort and never affects the run itself.

### Changed

- **Clearer live-run and run-detail views.** The running-run and run-detail pages were reworked for
  a cleaner read of progress, phases, evidence, and the final report.

### Fixed

- **The native "Browse…" folder picker no longer leaves you staring at a spinner.** If it can't open
  a window (for example when the portal was started outside your desktop session), use the new
  **In-app** browser next to it.

## 0.9.7 — 2026-07-06

**Fix: generated CSV test cases showing as raw run-on text instead of a table**

### Fixed

- **CSV test cases render as a table again.** In 0.9.6, when the AI prefixed a title line
  (e.g. `# Test Cases — …`) before the CSV, the version was mistakenly saved as Markdown and the
  preview showed it as one long run-on paragraph. A CSV template now always saves as real CSV — the
  stray title is stripped and the header row is used — so the preview shows a proper table with the
  pinned header row and first column. Regenerating a ticket produces a clean `.csv`, and any version
  already saved this way now renders as a table in the preview without regenerating.

## 0.9.6 — 2026-07-06

**Cleaner test-case & report formatting, project-scoped AI, and new projects that don't inherit another project's settings**

### Added

- **Test cases stay strictly on-project.** Test-case generation and QC runs are now told, in the
  prompt itself, to use only *this* project's context — its Knowledge, Memory, CLAUDE.md, and
  source code — and to ignore anything global (your machine-wide `~/.claude`) or belonging to
  another project. So one project's rules can't leak into another's cases or verdicts.

### Changed

- **Test-case steps are shorter and to the point.** The generator now writes terse, action-first
  steps and expected results that mirror your test-case template, instead of padding them with
  explanations ("because…", "per AC…"). Regenerate a ticket to get the tighter style.
- **Feature (advanced) run mode is marked "Coming soon."** On the Run page the advanced
  multi-ticket mode is temporarily disabled (shown with a "Soon" badge); single-ticket runs are
  unaffected.
- **Design Check moved below History** in the sidebar's Testing group.
- **New projects no longer inherit another project's CLAUDE.md or MCP servers.** A new project
  starts with a fresh fill-in-the-blanks `CLAUDE.md` and an empty `.mcp.json`, so you don't carry
  over an unrelated project's instructions or MCP configuration. (The QC skill and the test-case
  template — which are generic — still seed automatically.)

### Fixed

- **Test-case previews render as real tables again.** The `/templates` and `/testcases` previews
  now show Markdown (and CSV-in-Markdown) content as a formatted table instead of a wall of raw
  text, and the table keeps its **header row and first ("No") column pinned** while you scroll.
- **Generated CSV test cases keep their columns aligned.** Hardened the CSV rules so a comma inside
  a field (e.g. a Summary) can no longer shift every later value into the wrong column, added a
  check that flags any row that still slips, and made a version save/render in the format it was
  actually written in (so a CSV never renders as a collapsed run-on paragraph).
- **Run report tables auto-size their columns.** Report/issue tables on the Run page now size each
  column to its content (short columns stay narrow, long text wraps) and scroll horizontally when
  wide, instead of cramming everything into fixed-width columns.
- **Report & issue line breaks are preserved.** Each labeled field (Steps / Expected / Actual /
  Business impact) now renders on its own line instead of running together into one paragraph.
- **ClickUp subtasks created from QC issues are formatted properly.** The subtask description is now
  sent as rich Markdown (bold labels, numbered steps) with proper spacing between sections, instead
  of showing raw `**asterisks**` all on one line.

## 0.9.5 — 2026-07-02

**AI Brain visualization, correct pass rates on run reports, and a starter test-case template for new projects**

### Added

- **AI Brain tab on the Instructions page.** A new animated map (Instructions → AI Brain) shows
  the AI's working brain for the active project — a pulsing core wired to every Memory note,
  Knowledge doc, and repo Source map it reads on each run. Hover a node to highlight its
  connection and see its description; click to read the full content. AI-captured items carry a
  blinking blue dot. The map follows the app theme (light and dark), is built with lightweight
  SVG/CSS animation, freezes while a preview dialog is open, and respects the system
  reduced-motion setting — so it doesn't slow the app down.
- **New projects start with a test-case template.** Creating a project now seeds
  `testing/templates/testcase.md` automatically — copied from your existing project's template
  when one exists (so new projects match your current format), otherwise from a sensible default
  bundled with the portal. An existing template file is never overwritten.

### Fixed

- **Run pages no longer show a 0% pass rate for reports that count "Pass / Fail".** The run
  detail page only recognized summary rows labeled "Passed / Failed", so reports whose summary
  table used "✅ Pass / ❌ Fail" showed 0 passed and a 0% pass rate. Both spellings are now
  accepted, and a count is only read from a cell that is purely a number — so per-case table
  rows can't be mistaken for summary counts.
- **Stored pass/fail counts now match the report.** The server previously counted pass/fail-looking
  rows across the whole report (over-counting badly on reports with per-case tables); it now reads
  the report's own Result Summary table first, with the old row counting kept only as a fallback.
  Older runs self-heal: opening a run recomputes its stored counts from the report, so History
  matches too. Partial and Blocked still count toward the fail side.

## 0.9.4 — 2026-07-02

**Multiple source repos per project + AI source maps, App URL check, and a Windows MCP approval fix**

### Added

- **Connect multiple source repositories to one project.** The Source Code page is no longer
  limited to a single repo — connect several, each with its own tag (Backend, Frontend, Mobile,
  API, or your own label). Each repo clones into its own folder under `source/`, keeps its own
  access token, and gets its own card with Sync, Edit & reconnect, Disconnect, and Open folder.
  Test-case generation and QC runs are told about every tagged repo and pick the one relevant to
  the ticket. An existing single-repo connection migrates automatically on startup (tagged
  "Source") — no re-connect needed.
- **Source maps make AI runs faster and cheaper.** After a clone or sync that brings new commits,
  the portal runs one cheap AI pass over the repo and saves a compact map (screens, routes,
  domain models, where validation lives — with file paths) into Instructions → Knowledge as
  `source-map-<tag>.md`, flagged with the AI badge. Test-case generation and QC runs jump
  straight to the files it names instead of re-exploring the repo every time. A sync with no
  new commits keeps the existing map; disconnecting removes it; you can review, edit, or delete
  it like any knowledge doc.
- **"Check" button for the App URL on the Run page.** The server pings the URL and reports
  "Reachable · HTTP 200" or a plain-language error (host not found, connection refused, TLS
  problem, timeout) — so you know the staging site is live *before* launching a run. A login
  wall still counts as reachable.
- **Preview test cases right on the Run page.** An eye button next to the version picker opens
  a read-only preview of the selected test-case version — CSV rendered as a real table,
  Markdown rendered nicely — so you can see exactly what a run will verify against.
- **New docs: "Getting API tokens" and "Connecting source code".** Step-by-step guides for
  creating ClickUp, Figma, and Jira tokens (including the Jira scoped-token trap), and for
  GitHub/Bitbucket tokens used by the multi-repo flow. The MCP page links to the token guide
  from each service card, and Core Concepts gained a clickable "how a ticket flows through the
  portal" panel.
- **CSV templates preview as a table.** Uploaded CSV/Excel templates on the Templates page now
  render as a real table instead of raw text.

### Changed

- **"Change repository" is now "Edit & reconnect", prefilled.** The form reopens with the repo's
  URL, tag, branch, and saved credentials; leaving the token empty keeps the saved one, so
  changing a branch no longer means re-pasting a token. The token field gained show/hide and
  copy buttons.
- **One clone/sync at a time per project.** Starting a second git job while one is running is
  rejected, so concurrent operations can't step on each other. Repo tags must be unique within
  a project (they map to folders).
- **The AI sees more of your Knowledge and Memory.** The project-context budget doubled (16 KB →
  32 KB), memory notes are capped so they can't crowd out reference docs, source maps are packed
  first, and anything clipped for space now tells the model to open the full file — a large
  knowledge base no longer silently starves the AI of detail.

### Fixed

- **MCP servers stuck on "Pending approval" on Windows.** Claude Code keys its per-project
  config with forward-slash paths even on Windows, while the portal wrote back-slash paths — so
  approvals landed where the CLI never looked. The portal now uses the forward-slash key and
  cleans up the stale entry older versions left behind; Test connection works on Windows again.
- **A failed source-map pass can no longer lose the repo connection.** The connection is saved
  before the map is generated, so a timed-out AI pass leaves the clone intact.
- **The test-case version picker no longer collapses shorter than the ticket picker.**

## 0.9.3 — 2026-07-02

**Windows fixes: in-app update actually finishes, terminal paste, folder picker — plus new projects activate themselves**

### Fixed

- **The in-app "Update now" no longer gets stuck loading on Windows.** The updater used
  to be started as a child of the portal server — and its first step, stopping the server,
  killed its own process tree, taking the updater down with it. The update died silently
  and the page spun forever, forcing a manual `qc-portal --update` in a terminal. The
  updater (and the in-app Restart) is now launched outside the server's process tree, so
  it survives the stop and finishes the update on its own. Note: the very first update
  *onto* 0.9.3 still uses the old updater — if it hangs, run `qc-portal --update` once;
  every update after that works from the app.
- **Updating from the app no longer flashes command windows on Windows.** Each update step
  (git, npm install, build) used to pop its own console window. The whole update now runs
  invisibly — just the loading toast, then the page reloads on the new version.
- **A newly created project becomes the active project immediately.** Before, after "Add
  project" every page (MCP, Instructions, Tickets, Settings) kept showing the *previous*
  project's data until you clicked "Set active" yourself — which read as the new project
  showing someone else's data.
- **Paste works in the in-portal Terminal on Windows.** Ctrl+V used to print `^V` instead
  of pasting. Ctrl+V (and Ctrl+Shift+V) now paste, Ctrl+Shift+C copies the selection, and
  plain Ctrl+C still interrupts the running command — same as Windows Terminal. This also
  applies to the "Continue session" terminal on a run's detail page.
- **The "Browse…" folder picker is far more reliable on Windows.** The choose-folder
  dialog could open behind the browser and never get focus, leaving the button loading
  for minutes. The dialog now forces itself to the foreground for its first seconds, a
  stuck dialog gives up after 2 minutes (and actually closes) with a clear message, and
  the picker now starts in the suggested folder like it already did on macOS.

### Changed

- **Mobile test targets are marked "Coming soon".** On the Run page, *Web (mobile)* and
  *App (mobile)* are visible but not selectable yet; runs default to *Web*.

## 0.9.2 — 2026-07-02

**ClickUp/Jira connect even when the portal was launched with a stale PATH**

### Fixed

- **`uvx`-based MCP servers (ClickUp, Jira) no longer fail just because of how the portal
  was started.** A process only sees the `PATH` from the moment it was launched — so a
  portal started from an old terminal, a shortcut, or before `uv` was installed couldn't
  find `uvx`, and every ClickUp/Jira server showed **Failed to connect**, even though the
  same command worked fine in a fresh terminal. The portal now adds the standard per-user
  tool folders (`~/.local/bin`, `~/.cargo/bin`, and WinGet's links folder on Windows) to
  `PATH` for everything it launches — QC runs, MCP health checks, test-case generation,
  the in-app terminal, and the `uv` probe. A plain `"command": "uvx"` in `.mcp.json` now
  works on every machine; no more hand-editing absolute paths, no more "restart from a
  new terminal" dance.

## 0.9.1 — 2026-07-02

**Fix ClickUp "Failed to connect" caused by a renamed token variable**

### Fixed

- **ClickUp connects again on machines set up with the older token variable.** Newer
  versions of the ClickUp MCP server read the token from `CLICKUP_MCP_API_KEY` and ignore
  the older `CLICKUP_API_KEY`. A project connected a while ago (or on another PC) may only
  have the old name in `.mcp.json` — the server then crashes on startup and the MCP page
  shows **Failed to connect**, even though the exact same token works elsewhere. The portal
  now writes **both** variable names on every connect path (token paste *and* OAuth), so any
  server version starts. **Already hit by this?** Just Disconnect ClickUp and Connect again
  with your token — that rewrites the entry with both names.
- **Troubleshooting guide updated** with this exact failure (§1b: the
  `1 validation error for Config — api_key Field required` error and its fix), and the
  hand-test command now uses the current variable name.

## 0.9.0 — 2026-07-02

**Restart from the app, a heads-up when uv is missing & a Windows MCP fix**

### Added

- **Restart the portal from Settings.** A new **Restart app** card on the Settings page
  stops and relaunches the QC Portal server on your machine — handy after changing MCP
  servers or when something seems stuck. It asks for confirmation (in-flight runs and
  background jobs are interrupted), then the page reloads by itself once the server is
  healthy again. No new browser window pops — you keep the tab you're in.
- **The MCP page now warns when `uv` is missing.** ClickUp and Jira are Python MCP servers
  that run through `uvx` (Astral's `uv`). On a machine without `uv` they just show
  **failed**, which looks like a bad token but isn't. The MCP page now checks for `uv`
  up-front and shows an amber banner with the exact install command for your OS
  (copy button included). Install it, fully reopen the portal, and test again.
- **A troubleshooting guide.** The new [`TROUBLESHOOTING.md`](./TROUBLESHOOTING.md)
  (linked from the README) walks through the common MCP setup problems: ClickUp/Jira
  showing `failed` (install `uv`), an empty Jira ticket list (site-root `JIRA_URL` +
  *classic* API token), and the "conflicting scopes" warning.

### Fixed

- **Windows: MCP approval and local-scope servers work again.** The portal located your
  `~/.claude.json` through the `HOME` environment variable, which usually doesn't exist on
  Windows — so approving a "Pending approval" server from the Test connection button, and
  listing servers connected outside the portal, silently did nothing there. The portal now
  resolves your home folder the proper cross-platform way.

## 0.8.2 — 2026-07-01

**Jira tickets appear for the right project — plus a steadier Windows folder picker**

### Fixed

- **The ClickUp / Jira source switch now follows the project you're in.** After you
  connected Jira, the Tickets page still checked whether ClickUp and Jira were connected
  against the *default* project instead of the one selected in the sidebar. So the switch
  could stay hidden — or Jira could look "not connected" — even though you'd connected it on
  that project. It now checks the **active** project, so the **ClickUp | Jira** toggle shows
  whenever both trackers are connected there, and your Jira issues load straight away. (One
  gotcha worth knowing: Jira needs a *classic* API token — the plain "Create API token" button
  — not a "token with scopes"; a scoped token silently returns no issues.)
- **The "choose folder" dialog on Windows no longer hides behind other windows.** The native
  folder picker — used when importing a skill or pointing the portal at a folder — could open
  *behind* the browser, leaving the button spinning forever with no dialog in sight. It now
  opens in front, and if it ever gets wedged it times out cleanly with a clear message instead
  of hanging.

## 0.8.1 — 2026-07-01

**Fix MCP servers stuck on "Pending approval"**

### Fixed

- **"Test connection" now clears a server stuck on "Pending approval."** When a project's
  MCP server (for example **Figma**) showed *Pending approval* and pressing **Test connection**
  still failed with *"Approved… but connection still failed"*, the portal was recording the
  approval in a file the current Claude CLI no longer reads. It now approves the server where the
  CLI actually looks — trusting the project and enabling its `.mcp.json` servers — so a single
  click flips it to **Connected**, even for a project you'd never opened in Claude directly. If
  you hit this with Figma, your API token was never the problem; it was purely this approval
  handshake.

## 0.8.0 — 2026-07-01

**Mobile testing, portable projects & faster everyday flows**

### Added

- **Run QC on a mobile device.** The Run page now asks *where* to run: **Web** (desktop
  browser, as before), **Web on mobile** (your App URL opened in a real device or simulator's
  mobile browser), or **App on device** (a native iOS/Android app already installed on a
  connected device). Mobile runs drive a booted device through the new **Mobile** MCP server
  and capture mobile screenshots as evidence. "App on device" needs no App URL.
- **One-click Mobile MCP setup.** The MCP page has a new **Mobile** server you can connect with
  a single click (no token). Its **functional test** auto-detects connected devices/simulators,
  lets you pick one, and then actually drives it to confirm it works — and reads "works, but no
  device is booted" as a warning, not a failure.
- **Export and import a whole project as a `.zip`.** Each project card has an **Export** button
  that bundles just the QC setup — `CLAUDE.md`, skills, `.mcp.json`, and the `testing/` folder
  (never `node_modules`/`.git`) — into one file. **Import project** re-creates a project from
  such a zip on another machine: pick the file, a name, and a destination folder.
- **Delete a finished run.** Run detail and History now have a **Delete** button that removes a
  run's history entry, event log, and its entire on-disk output folder (report, issues,
  screenshots) after a clear confirmation. Active runs can't be deleted until they finish.
- **Set a default skill per project.** On the Skills page, star a skill as the project's
  **default** — it's pinned to the top and auto-selected on the Run page for new runs.
- **Run several test-case generations at once.** Start a generation, then immediately pick more
  tickets and start another — up to 3 jobs run in parallel, each with its own progress, live
  log, and Pause/Resume/Cancel. A browser reload reconnects to all of them.
- **Clickable evidence in reports.** Screenshot and file names that appear in a report's tables
  are now chips — click one to open the image/file in a popup without leaving the Report tab.
- **"Configure MCP" prompts.** The Run and Design Check pages now warn (with a one-click link)
  when the project is missing a server those features need, and the warning clears the moment
  you add it. Each MCP server card also gained an info tooltip explaining what it's for.
- **Build the Overview from a document.** Upload (or drag in) a Word/PDF/Markdown/spreadsheet
  file on the Overview page and it's converted to Markdown in your browser for review before you
  save it as the project intro.

### Changed

- **History is grouped by ticket.** Runs now fold into collapsible ticket cards showing the real
  ticket title, a link back to ClickUp, an aggregate pass/fail bar, and a run count — with
  Expand all / Collapse all. Much easier to find a ticket's runs than the old flat table.
- **Cleaner Run page.** The form is now three clear steps (What to test → Where to run →
  Options), with skill/model/instructions folded into a collapsible Options section. The model
  default is now **Sonnet** (the all-round pick; Opus for tricky tickets, Haiku for small ones),
  and the chosen mode is kept in the URL so a run link is shareable and survives reload.
- **Redesigned run result.** The result summary leads with a pass-rate donut and a clear
  "Ready for sign-off / Needs attention / Review required" headline; each tab is now linkable
  (back/forward and bookmarks work).
- **Terminal drops you straight into Claude.** Connecting on the Terminal page now launches a
  `claude` session in the project folder instead of a bare shell, and the terminal fills the
  window. The "Continue session" panel on a run starts collapsed.
- **Navigation tidy-up.** New app logo, the home page moved to `/qc-run`, the old "Settings"
  sidebar item is now **Templates**, and project/model settings live under a new **Settings**
  entry. First launch with no projects shows a "Create a project to get started" screen.
- **Richer new-project scaffold.** Brand-new projects get a fill-in-the-blanks `CLAUDE.md`
  (Overview / Architecture / How to test / Conventions / Safety) instead of a near-empty file.

### Fixed

- **Claude usage no longer stalls or flickers.** The model-usage reading is cached and refreshed
  in the background, falling back to the last good value (marked stale) instead of re-spawning a
  slow process on every view.
- **Report tables stay readable.** Wide report tables now keep fixed columns and scroll
  horizontally instead of collapsing to one character per line or running off-screen.
- **Native-app runs no longer demand an App URL** and show a readable label in history.

## 0.7.0 — 2026-06-30

**Access keys, instant project setup & a cleaner look**

### Added

- **See and copy a project's Source Code access key.** The Source Code page now shows which
  auth method is in use and a masked preview of the stored token (e.g. `****1234`), with a
  one-click **Copy** button to put the full token on your clipboard when you need it elsewhere.
  The token is still never written to the database, the git remote, or any log.
- **New projects are set up for you automatically.** Creating a project now scaffolds its
  `CLAUDE.md`, the `qc-testing` skill, and a `.mcp.json` right away (copied from your template
  project when you have one, otherwise from sensible starters) — so a brand-new project is ready
  to run without a separate "initialize" step. The create response reports what was created.

### Changed

- **Refreshed input fields across the app.** Search, filter, and URL boxes — on Tickets, Test
  Cases, Run, History, Skills, Design Check, Diagrams/Overview, and the in-app docs — now use the
  rounded "pill" style of the System-Style UI, with larger search icons and a consistent focus ring.

## 0.6.9 — 2026-06-30

**Documented the release process**

### Changed

- Internal/contributor only: `CLAUDE.md` now spells out the step-by-step release process
  (version bump → changelog → commit → tag → push). No user-facing change.

## 0.6.8 — 2026-06-30

**Last console-window flash on Windows**

### Fixed

- **Starting the portal no longer flashes a console window when it opens your browser** on
  Windows. The launcher used `cmd /c start` to open the browser without hiding its console.
  Completes the Windows window-flash sweep from 0.6.7 — every background subprocess the portal
  spawns now runs hidden (the in-app Terminal and the "Open folder" Explorer windows are
  intentional and unchanged).

## 0.6.7 — 2026-06-30

**No more console windows popping up on Windows**

### Fixed

- **Checking for updates no longer flashes a terminal window on Windows.** The version check
  runs `git` a few times in the background, but those calls didn't suppress the console window —
  so each one popped open briefly. They now run hidden.
- Same fix applied to the other background subprocesses that could flash a window: **Source Code**
  git clone/sync and opening the **MCP OAuth** browser page.

## 0.6.6 — 2026-06-30

**Fix QC runs stuck at intake on Windows**

### Fixed

- **QC runs on Windows no longer start by asking for the ticket and App URL they were already
  given** (then finishing with `0 pass, 0 fail of 0 ACs`). The run prompt is multi-line, and on
  Windows `claude` is a `.cmd` batch shim — passing a multi-line string as a command-line argument
  let `cmd.exe` truncate it at the first newline, so only the opening "run a QC test" line reached
  the model and the ticket ID, App URL, and instructions were silently dropped. The QC-run prompt
  is now delivered over **stdin** (same fix as 0.6.5 for the other AI steps), so the model receives
  it intact.

## 0.6.5 — 2026-06-30

**Fix `spawn ENAMETOOLONG` on Windows**

### Fixed

- **Test-case generation (and the other AI steps) no longer crash with `spawn ENAMETOOLONG`
  on Windows.** The full prompt — which embeds the whole ticket, project Knowledge/Memory, and
  instructions — was passed as a command-line argument. Windows caps the entire command line at
  ~32 KB, so a large ticket (e.g. 23K+ characters) overflowed it and the run failed immediately
  with `0/1 succeeded`. The prompt is now delivered to the Claude CLI over **stdin** instead, so
  prompt size no longer touches the OS argument limit. The same fix covers crawl summaries,
  Design Check, grounding checks, auto-learn, and the MCP capability test.

## 0.6.4 — 2026-06-30

**Sidebar scrolls on short screens**

### Fixed

- **The sidebar now scrolls when the window is too short to fit every nav item.** On small
  screens the navigation list overflowed past the version footer with no way to reach the
  lower links. The nav area is now a scrollable region while the brand header, workspace
  switcher, and footer stay pinned in place.

## 0.6.3 — 2026-06-30

**`--update` no longer gets stuck**

A fix for `qc-portal --update` silently staying on the old version.

### Fixed

- **`qc-portal --update` now always advances to the latest version.** It previously ran
  `git pull --ff-only`, which aborts the moment any tracked file is locally modified — and
  `npm install` routinely rewrites the tracked `package-lock.json` (different npm version /
  platform-specific optional dependencies, especially on Windows). That dirty lockfile blocked
  every subsequent update. Update now does `git fetch` + `git reset --hard` to the upstream
  branch, discarding such local edits so the update always lands.

## 0.6.2 — 2026-06-30

**More thorough test cases**

A quality fix for test-case generation so it covers the whole ticket instead of stopping early.

### Changed

- **Generated test cases now cover every area a ticket spans.** The model is told to be
  exhaustive rather than representative — it takes stock of each feature, trigger, screen,
  and role the ticket touches and writes cases for all of them, instead of sampling the first
  few. Each area still gets happy paths, edge cases, validation/negative cases, and error states.
- **Reading is time-boxed so writing isn't cut short.** Generation now reads only the handful of
  most-relevant source files up front, then spends the rest of its budget writing cases. The
  wall-clock budget was raised (12 → 14 min) so a nearly-complete set finishes instead of being
  truncated.

## 0.6.1 — 2026-06-29

**Cleaner CSV test cases**

A reliability fix for test-case generation against CSV templates.

### Fixed

- **Generated CSV test cases no longer start with stray AI prose.** The model sometimes
  prefixed a sentence (e.g. "Let me write the complete test case CSV.") before the header
  row; that line was saved verbatim, corrupting the file on spreadsheet import. The output
  is now cleaned so it always starts with the template's real header row.

### Changed

- Test-case generation does a quicker, more focused source scan and gets more time/budget
  to finish writing the full set of cases.

## 0.6.0 — 2026-06-29

**Project knowledge, self-checking AI & in-app docs**

Give each project a memory, let the AI ground its work in it (and check itself for
hallucination), pull in your source repo, and learn the whole portal from a built-in manual.

### Added

- **Knowledge & Memory** — a new context hub on the **Instructions** page: upload project
  docs (Word, PDF, Markdown, CSV, Excel — converted in the browser) as **Knowledge**, and
  jot durable facts as **Memory** notes. Both are stored per project under `testing/`.
- **Project context feeds the AI** — test-case generation now injects your Knowledge +
  Memory straight into the prompt, so the AI uses your real screen/field names, roles, and
  business rules instead of guessing; QC runs read them too.
- **Test cases & runs read your source code** — test-case generation and QC runs now open
  the project's repository and read the real implementation of the feature (true field names,
  validation, states, roles, edge cases) before drafting or testing, so the output matches the
  actual app — not just the ticket. Read-only; the repo is never modified.
- **Grounding check (anti-hallucination)** — after the AI writes test cases or a QC report,
  an independent, cheap second pass audits it and silently corrects invented content: cases
  not supported by the ticket or your knowledge are dropped/fixed, and any unverified "Pass"
  in a report is downgraded. Best-effort — it never blocks the run.
- **AI auto-capture (auto-learn)** — after a run or generation, the portal can save durable
  facts it learned into Memory/Knowledge, flagged with an **AI** badge you can review or edit.
- **Per-project AI controls** — **Settings → Models** now has an *AI automation* card to turn
  the grounding check and auto-learn on/off and pick their model, per project.
- **Source Code page** — clone, adopt, or pull a GitHub/Bitbucket repo for a project as a
  background job; access tokens are kept in a protected on-disk store, never in git or logs.
- **Documentation page** — a built-in user manual (sidebar footer, below Release notes) with
  one page per topic, a searchable nav, and prev/next — covering the whole portal.
- **Generate from ClickUp** — draft a project Overview from crawled tickets and docs with AI.

### Changed

- **Instructions page** is now a three-tab hub — `CLAUDE.md` + Knowledge + Memory — with a
  managed pointer block that keeps `CLAUDE.md` lean while still surfacing the split-out context.

## 0.5.0 — 2026-06-25

**Terminal, live sessions & background Design Checks**

Drop into a real shell, keep a finished run's conversation going, and watch design
checks run in the background.

### Added

- **Terminal page** — a real pseudo-terminal in the browser (xterm.js + node-pty),
  opened in the active project's folder, so interactive TUIs like `claude` just work.
- **Continue session** — a QC run's Claude session now stays alive after the report is
  written; resume it in an interactive terminal right from the run detail page.
- **Instructions page** — view and edit the active project's `CLAUDE.md` without leaving
  the portal, with a rendered Markdown preview.

### Changed

- **Design Check now runs as a background job** — kick off a verify and it keeps running
  even if you reload or navigate away, with a live log and a notification when it lands.
  Past checks are persisted per project.

## 0.4.0 — 2026-06-23

**Release Notes & update checks**

Read what changed without leaving the app, and find out when a newer build is available.

### Added

- **Release Notes page** — click the version in the sidebar footer to read what changed
  across releases, rendered straight from this changelog.
- **Sidebar update check** — the footer now fetches upstream and tells you when
  `qc-portal --update` would pull a newer build, with an amber "update available" badge.
- **Design Check checklist templates** — save a standard Design Check checklist per project
  (`testing/templates/design-check.md`); the verifier reports a finding for every item.

### Changed

- Crawl and test-case model pickers now share one component and remember your last choice
  per machine.

### Fixed

- Crawled-ticket delete dialog now warns when removing a folder that has saved test cases.

## 0.3.0 — 2026-05-30

**Design Check, project diagrams & notifications**

Verify designs against Figma, see your project at a glance, and never miss a finished job.

### Added

- **Design Check page** — pick a crawled ticket, paste its Figma link, and get findings
  bucketed into match / mismatch / concern / unsure / discuss.
- **Project diagram on Overview** — an AI-generated Mermaid `flowchart` you can edit inline,
  persisted per project.
- **Notifications** — a global bell + history page; background jobs announce completion even
  when the originating page is unmounted.

### Changed

- Tickets list groups by ClickUp status under sticky, color-tinted headers.

### Fixed

- Background jobs (crawl + test-case generation) now survive browser reload and navigation.

## 0.2.0 — 2026-05-09

**Crawling & test-case generation**

Pull tickets from ClickUp and let Claude draft manual test cases from them.

### Added

- **Test-case generation** — pick up to five crawled tickets and have Claude draft versioned
  manual test cases (`testcases/v<N>.md`) with template + rules support and a preview dialog.
- **Ticket crawling** — download a ClickUp ticket's description, comments, `ticket.json`, and
  attachments into `testing/tickets/`, with an optional per-ticket AI summary.
- **Open folder** buttons that reveal a project's on-disk folder in Finder / Explorer.

### Changed

- Multi-project support: register projects and switch the active one from the sidebar.

## 0.1.0 — 2026-04-18

**First packaged release**

A local web UI that runs the `qc-testing` Claude Code skill from the browser.

### Added

- **QC runs** — launch the `qc-testing` skill headless and watch phase/log events stream
  live over WebSocket, with run history and detail views.
- **Skills & MCP management** — edit each project's `.claude/skills` and `.mcp.json`.
- **One-command install & update** — the `qc-portal` CLI to start/stop/restart the server
  and `qc-portal --update` to git-pull, reinstall, rebuild, and restart.

### Platform

- Cross-platform (macOS + Windows): no `cmd` window flash when spawning Claude, and a fix
  for `spawn claude ENOENT` on Windows.
