<!-- QC Portal architecture notes. Index + core rules: ../../CLAUDE.md. Cross-references to "the section below/above" may point at a sibling file in this folder. -->

## Scheduled tasks (work the portal does with nobody watching)

**`/scheduled` (`SchedulesPage.tsx`, `ScheduleDialog.tsx`, `ScheduleWatcher.tsx`, `lib/schedule.ts`,
`routes/schedules.ts`, `scheduler.ts`, `cron.ts`, `scheduleLang.ts`, schedules/schedule_runs in
`db.ts`)** — a prompt plus a cron expression. The server fires it on its own: a 9am ticket brief, a
nightly coverage check, a Friday status. **A scheduled task is a chat turn nobody had to be present
for** — same `cwd = project.rootPath`, same tool modes, same models — which is why every piece of it
is borrowed from `/chat` rather than reinvented (`toolArgs` / `timeoutFor` are imported straight out
of `routes/chat.ts`; a second copy would drift and then a task would run under rules the chat page
does not show).

- **The rows live in the portal's SQLite DB, not in the project folder.** Notes, chats and knowledge
  are project files because a person opens them; a scheduled task has to be visible to the scheduler
  **at boot, before anyone has picked an active project**, so it sits beside `runs` keyed by
  `projectId`. Deleting a project deletes its tasks — inside `deleteProject` itself, because a task
  whose folder is gone would otherwise keep spawning `claude` in a missing directory once a day for
  ever.
- **`nextRunAt` is derived and stored.** Derived from the cron on every write (`scheduler.reschedule`
  is the ONLY writer) so the tick is one indexed comparison rather than 200 cron parses a minute, and
  so a restart already knows when each task is next due. Never edit it on its own: a `nextRunAt` that
  disagrees with the cron is a task that fires at a time the page does not show.
- **A missed window fires ONCE, late.** `dueSchedules` selects `nextRunAt <= now`, so a task due
  while the laptop was asleep runs on wake — and is then re-armed **from now**, never from the missed
  slot, so a 15-minute task does not replay 40 catch-up runs the moment the lid opens.
- **Runs are serial, portal-wide, and a task never runs twice at once.** Each run spawns a headless
  `claude`; three tasks sharing 09:00 on a laptop would be three CLIs fighting for one CPU, and the
  engineer's own chat turn would be what got slow. Both the tick and "Run now" go through `enqueue`,
  which refuses a schedule already queued or in flight. **"Run now" does not move the schedule** —
  its next firing is left exactly as it was, which is what makes trying a task safe.
- **The run row is written as `running` up front** and finished in place, so a working task is
  visible for the whole time it works; `reconcileInterruptedScheduleRuns()` at boot turns rows the
  shutdown caught mid-run into errors (their child died with the server), the same reconciliation QC
  runs get. `stopScheduler()` kills in-flight children on SIGINT/SIGTERM — they are spawned by the
  scheduler's own queue, not `runManager`, so a `tsx watch` restart would otherwise orphan one.

### Cron lives on the server. All of it.

`cron.ts` parses five-field expressions (no seconds, no `@daily` aliases — the tick is per-minute, so
a seconds field would be a lie), computes the next firing **in local time by walking calendar
fields** (so 9am stays 9am across a DST change), and writes the English sentence the UI shows.

**The browser has no cron parser at all.** `description` and `nextRunAt` ride down with every row,
and the dialog's live preview is a `POST /api/schedules/preview` round trip. That is the only way the
sentence under a card and the timer that fires it can never disagree. The one exception is
`cronToBuilder` in `ScheduleDialog.tsx`, which recognises **only the shapes the builder itself
emits** — anything else (a hand-written range, a list of hours) lands in the Custom field with the
expression intact, because a decomposition that "mostly" worked would be one that silently rewrites a
schedule on save. The preview shows **three** firings, not one: "every day at 9" and "every Monday at
9" are indistinguishable from a single next-run line.

An expression that can never fire (`0 0 30 2 *`) is a real answer — `nextRun` returns null, the row
is stored, and the card says so. It is not an error.

### One sentence → a schedule (and never without a confirmation)

`POST /api/schedules/parse` is two layers, in this order:

1. **`scheduleLang.ts` — deterministic, instant, free.** English and Vietnamese, the two languages
   this portal is used in: `every weekday at 8:30`, `mỗi thứ 2 lúc 8h`, `hàng tháng ngày 1`,
   `cuối tuần 10h`, `mỗi 30 phút`. It returns the cron **plus the character spans it consumed**, so
   the leftover text becomes the task.
2. **A cheap `haiku` pass, only when layer 1 finds no timing at all.** A model round trip for
   "every day at 9" would be latency and cost for something a regex answers exactly.

Three measured traps are written into that module, and all three are why it is spans rather than
string replacement:

- **Matching runs on a LENGTH-PRESERVING de-accented copy** (`flatten`, one output char per input
  char). `String.normalize('NFD')` shifts every index after the first accent, so matching `luc 9h`
  against `lúc 9h` cut the wrong characters and left `9h` glued to the front of the task.
- **Vietnamese weekdays are matched first and blanked out before English runs.** `thứ 2` flattens to
  `thu 2`, and an English Thursday abbreviation that swallowed it made "every Monday" also mean
  Thursday. The English pattern additionally requires at least `thur`.
- **A de-accented word is not a timing word just because a timing word flattens to the same
  letters.** `mỗi` and `mới` ("new") are both `moi`: deleting every `moi` silently removed "mới" from
  "tóm tắt ticket mới". So the introducer is only consumed when it is **adjacent to a timing phrase**
  (`extendOverIntroducer`), and the orphan list is deliberately tiny.

**A sentence with no time in it is answered with a 422 and the text kept in the composer**, never
with a task quietly scheduled for midnight. That refusal is the one guard that matters: an automation
nobody asked for is the failure mode this whole feature is designed against.

### Creating happens in chat, and nowhere else — in ONE step

`/scheduled` in the composer is the **only** way a task is created. The Scheduled page lists, runs,
pauses, edits and deletes them, and points at Chat — it has no create box of its own. It had one
briefly, and that was two creation paths: the same dialog reached from two places that would
inevitably drift apart in what they seed, what they default to and what they explain. The page's
examples are therefore **sentences you copy**, not templates you click.

**Enter creates the task outright — there is no confirmation dialog.** There was one, and it was a
form asking the engineer to re-approve the words they had just typed, in the place they had just
typed them. What carries the safety instead is the **toast**: it reads back the schedule the server
understood ("Every weekday at 9:00 AM · next Mon 14 Sept, 9:00") and carries **Undo**, which deletes
the task. A wrong schedule is one click from gone, and anything subtler is editable on `/scheduled`.
The composer is cleared and the mode left **only after the create succeeds** — a refusal has to leave
the sentence where it can be fixed, the same rule an oversize chat message follows.

### The `/scheduled` command in chat

Typing `/` in the composer already opened the skill picker; the command rows now sit **above** the
skills (a project with a dozen skills would otherwise bury the one row that is not a skill). Picking
it puts the composer in `scheduleMode`: **Enter proposes a task instead of sending a message**, and
the composer says so in a chip, with an ✕, an Escape, and a link to the page. A command leaves **no
token behind** in the text — unlike `@ABC-123` or `/qc-testing` it is not a reference the model
reads, and a leftover `/scheduled` would be sent as part of the task itself.

`MentionOption` is therefore a union: a staged mention, or a command. Widening `StagedMention`'s
`kind` instead would have let a command leak into the `ChatMention[]` a turn is sent with, where the
server has no such kind.

`ScheduleDialog` is now the **edit** form only, opened from a card on `/scheduled`. Its fields are
seeded **once** from the draft and the page remounts it with a `key` per draft — an effect that
re-seeded them would overwrite an edit in progress on the parent's next render.

### Announcing a finish

`ScheduleWatcher` is mounted in `App` above the shell, like the other job watchers, but it is the
only one that polls work the **server** started. That is the point of the feature: the answer has to
find the engineer, because nobody was watching for it. `GET /api/schedules/runs/recent?since=` is the
cursor, and the cursor is **seeded from the server's clock** (`now`, returned with every response) —
seeding from the browser's would replay the last few minutes of runs on a machine whose clock is
slightly behind, i.e. a burst of stale toasts on open.
