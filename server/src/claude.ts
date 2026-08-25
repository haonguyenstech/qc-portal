import spawn from 'cross-spawn'
import type { ChildProcess } from 'node:child_process'
import { CLAUDE_BIN } from './config.js'
import { usageFromResultObject } from './claudeExec.js'
import { recordUsage } from './db.js'
import type { LogEvent, Phase, RunDataPolicy } from './types.js'
import { spawnEnv } from './toolPath.js'

export interface RunHandle {
  child: ChildProcess
  cancel: () => void
}

interface RunCallbacks {
  onEvent: (e: LogEvent) => void
  onDone: (result: { success: boolean; resultText: string }) => void
  onError: (message: string) => void
  onSession?: (sessionId: string) => void
}

const PHASE_ORDER: Phase[] = [
  'intake',
  'plan',
  'setup',
  'collect',
  'analyze',
  'aggregate',
  'report',
]

/**
 * Map a free-text line to a QC phase (best-effort progress hint).
 *
 * Explicit "Phase N" headers from the skill are the reliable signal, so we
 * trust those first. The fallbacks are deliberately narrow, phase-unique
 * phrases — common words like "setup", "collect", "screenshot" or "report.md"
 * appear throughout a run and would make the progress bar jump around.
 */
function detectPhase(text: string): Phase | undefined {
  const t = text.toLowerCase()
  const m = /phase\s*([1-7])\b/.exec(t)
  if (m) return PHASE_ORDER[Number(m[1]) - 1]

  if (/scenario matrix|capture plan/.test(t)) return 'plan'
  if (/content inventory/.test(t)) return 'collect'
  if (/writing\s+report\.md|generating\s+the\s+report|finali[sz]ing\s+(the\s+)?report/.test(t)) {
    return 'report'
  }
  return undefined
}

/**
 * Infer the QC phase from a tool call — the RELIABLE progress signal. The model
 * reads the skill then mostly *works* via tools without re-narrating "Phase N",
 * so text detection alone leaves the bar stuck at Intake. What the run actually
 * *does* is unambiguous: driving the app is Collect, fanning out subagents is
 * Analyze, writing report.md is Report, etc. Each match means "reached AT LEAST
 * this phase"; the UI only ever moves the bar forward, so an occasional
 * earlier-phase tool (e.g. re-reading the ticket mid-run) never rewinds it.
 */
function detectPhaseFromTool(name: string, input: unknown): Phase | undefined {
  const n = name.toLowerCase()
  const inp = (input ?? {}) as { file_path?: unknown; command?: unknown }
  const path = String(inp.file_path ?? '').toLowerCase()
  const cmd = String(inp.command ?? '').toLowerCase()

  // Report — writing the final artifacts (report.md / issues.md).
  if ((n === 'write' || n === 'edit') && /(^|\/)(report|issues)\.md$/.test(path)) return 'report'

  // Analyze — Phase 5 fans out one subagent per AC via the Task/Agent tool.
  if (n === 'task' || n === 'agent') return 'analyze'

  // Collect — DRIVING the live app: browser/device screen reads, taps, typing, or
  // saving evidence. Matches the actual driving verbs (screenshot, navigate, snapshot)
  // — NOT the device-prep tools (list_devices / start_device), which fire early during
  // probing and would otherwise jump the bar ahead prematurely.
  // Maestro names its tools bare (inspect_screen / take_screenshot / run), so match
  // them via their mcp__maestro__ prefix. `take_screenshot` already falls out of the
  // /screenshot/ pattern below, but `inspect_screen` and `run` need naming — and
  // `run` is FAR too generic to match unprefixed, hence the qualified form.
  if (/mcp__maestro__(inspect_screen|take_screenshot|run)\b/.test(n)) return 'collect'
  if (n.includes('browser_') || /screenshot|navigate|snapshot/.test(n)) {
    return 'collect'
  }
  if ((n === 'write' || n === 'edit') && (path.includes('/evidence/') || path.includes('/screenshots/'))) {
    return 'collect'
  }

  // Setup — scaffolding the testing/<ticket>/ output folder (the skill's Phase 3).
  if (n === 'bash' && /\bmkdir\b/.test(cmd) && /testing\//.test(cmd)) return 'setup'

  // Plan — building the test checklist / scenario task list (Phase 2 uses the task tools).
  if (n === 'taskcreate' || n === 'taskupdate' || n === 'tasklist') return 'plan'

  // Intake — starting the skill / pulling the ticket / reading its ACs.
  if (n === 'skill' || n.includes('clickup') || n.includes('jira') || n.includes('azure')) return 'intake'
  if (n === 'read' && /(ticket\.json|summary\.md|\/tickets\/)/.test(path)) return 'intake'

  return undefined
}

function now() {
  return new Date().toISOString()
}

/**
 * Mobile runs get sent to the skill's Maestro recipes explicitly.
 *
 * The skill's own capture recipes are Playwright-shaped (`browser_evaluate` with a
 * `filename` is what puts a content inventory on disk), and this prompt has just
 * forbidden Playwright — so without a pointer the run improvises against a file that
 * describes the wrong tool. Worse, Maestro's `take_screenshot` returns the image inline
 * and takes no path, so a run that reaches for it saves NOTHING: every mobile case then
 * grades as "no evidence captured" (⛔/◻️) and no issue can carry a picture.
 * `maestro-recipes.md` is the file that says to screenshot via `run` +
 * `- takeScreenshot: { path }` instead.
 */
const MOBILE_RECIPES_HINT =
  `Read maestro-recipes.md in the skill folder BEFORE your first device call and follow it — ` +
  `it holds the real Maestro tool names and the two things that decide whether this run has ` +
  `evidence at all: screenshots must be written to a FILE via run + "- takeScreenshot: { path: ` +
  `<absolute path> }" (take_screenshot alone saves nothing to disk), and each screen's content ` +
  `inventory comes from inspect_screen, which you then Write into evidence/<screen>.md yourself. ` +
  `Wherever the skill or playwright-recipes.md names a browser_* tool, use the Maestro equivalent ` +
  `from that file instead.`

/**
 * Launch the qc-testing skill head-less and stream normalized events.
 *
 * Uses `--output-format stream-json` so we get newline-delimited JSON we can
 * map to log/tool/phase events. Permissions are bypassed so the run never
 * blocks on a prompt — safe because the skill itself forbids mutating actions
 * and this runs on the QC's own machine against a dev environment.
 */
export function runQc(
  opts: {
    ticketId: string
    appUrl: string
    cwd?: string
    skill?: string
    instructions?: string
    model?: string // Claude model alias (haiku/sonnet/opus); omitted = configured default
    relatedTickets?: string[] // advanced mode: extra tickets covered by the same feature run
    workflowSteps?: string[] // advanced mode: ordered end-to-end flow to exercise
    kind?: 'ticket' | 'flow' // 'flow' = no ticket exists; ticketId is just the report slug
    testTarget?: 'web' | 'web-mobile' | 'app-mobile' // desktop browser (default), web app on device, or native app on device
    dataPolicy?: RunDataPolicy // what the run may do to the environment's data; default 'readonly'
    deviceId?: string // mobile targets: the Maestro device_id to drive (several booted devices → the engineer picks); omitted = whatever list_devices reports
    // Mandatory tail of this run's output folder name ("web-3f9a12c4"), supplied by
    // runManager. Two runs of the same ticket — classically one on web and one on a
    // device — otherwise agree on a folder name and the second overwrites the first's
    // report, issues and screenshots. Absent = the pre-token behavior.
    outDirSuffix?: string
    // Per-run MCP config (see playwrightRunMode.ts): a complete copy of the project's
    // MCP servers with only the Playwright browser mode swapped, so ONE run can be
    // headless (or headed) without rewriting the project's .mcp.json. Passed with
    // `--strict-mcp-config` — which is why the file has to hold EVERY server, not just
    // Playwright. Absent = the project's own .mcp.json, loaded from the cwd as always.
    mcpConfigPath?: string
    resumeSessionId?: string // continue a previously paused session instead of starting fresh
    totpHint?: string // prompt block telling the run how to fetch live authenticator (2FA) codes
  },
  cb: RunCallbacks,
): RunHandle {
  const skill = opts.skill?.trim() || 'qc-testing'
  const isQc = skill === 'qc-testing'
  const resuming = !!opts.resumeSessionId

  let prompt: string
  if (resuming) {
    // The session already holds the full original prompt and progress — just
    // tell it to pick up where it stopped.
    prompt =
      `Continue the QC acceptance test for ${
        opts.kind === 'flow' ? `the E2E flow "${opts.ticketId}"` : `ClickUp ticket ${opts.ticketId}`
      } exactly where you left off. ` +
      `Resume the ${skill} skill from the phase you had reached and carry it through to the end. ` +
      `Do not restart from scratch and do not repeat work already completed.` +
      // The session already knows the folder, but a resumed run that invents a second
      // one splits its own evidence across two folders — and the portal only reads one.
      (opts.outDirSuffix
        ? ` Keep writing everything into the SAME output folder you created for this run ` +
          `(the one ending in "-${opts.outDirSuffix}") — do not create a new folder and do not ` +
          `write into any other run's folder.`
        : '')
  } else {
    // All tickets covered by this run — the lead ticket plus any related ones
    // selected in advanced mode. More than one means it's a connected feature.
    const allTickets = [opts.ticketId, ...(opts.relatedTickets ?? [])]
      .map((t) => t.trim())
      .filter(Boolean)
    const multiTicket = allTickets.length > 1
    const steps = (opts.workflowSteps ?? []).map((s) => s.trim()).filter(Boolean)

    // An E2E flow has NO ticket: `ticketId` is only the slug its report is filed
    // under. Saying "ClickUp ticket: <slug>" sent the model hunting through
    // testing/tickets/ for a folder that doesn't exist (observed: four wasted
    // tool calls before it worked out the truth on its own).
    const isFlow = opts.kind === 'flow'
    const lines = [
      isFlow
        ? `Use the ${skill} skill to run a deep QC acceptance test of an END-TO-END FLOW through the product.`
        : multiTicket
          ? `Use the ${skill} skill to run a deep QC acceptance test across a connected feature that spans multiple ClickUp tickets.`
          : `Use the ${skill} skill to run a deep QC acceptance test.`,
    ]
    if (isFlow) {
      lines.push(
        `There is NO ticket for this run — do NOT look for one in testing/tickets/ and do not ` +
          `treat the name below as a ticket id. ` +
          // A flow can be driven by canvas steps, by an uploaded test-case document
          // (cited in the engineer's instructions further down), or by both. Promising
          // steps that aren't there sends the model looking for a list that never
          // arrives — the same wasted hunt "ClickUp ticket: <slug>" used to cause.
          (steps.length
            ? `The acceptance criteria are the flow's own steps, listed further down; test ` +
              `exactly those, in order.`
            : `The acceptance criteria are the test cases the QC engineer supplied in the ` +
              `instructions further down — read the file they name and test exactly those cases.`),
        `Flow name (write the report under this slug): ${opts.ticketId}`,
      )
    } else if (multiTicket) {
      lines.push(
        `ClickUp tickets — treat them together as ONE end-to-end feature, not as separate tests: ${allTickets.join(', ')}`,
        `Lead ticket (write the report under its slug): ${opts.ticketId}`,
      )
    } else {
      lines.push(`ClickUp ticket: ${opts.ticketId}`)
    }
    if (opts.testTarget === 'app-mobile') {
      // opts.appUrl carries the app's NAME / package / bundle id for this target
      // (never a URL). "Mobile app" is the placeholder stored when none was given.
      const appName = opts.appUrl && opts.appUrl !== 'Mobile app' ? opts.appUrl.trim() : ''
      lines.push(
        ``,
        `TEST TARGET: a NATIVE APP already installed on a MOBILE device — there is no URL. ` +
          (appName
            ? `The app under test is "${appName}" (a display name or package / bundle id) — find it ` +
              `on the device by this name and launch it. `
            : '') +
          `Do NOT use the desktop/Playwright browser. Drive the device with the connected MAESTRO MCP ` +
          `tools ONLY (no other mobile MCP is configured): call list_devices FIRST and drive a booted ` +
          `simulator/device — every other Maestro tool needs the "device_id" from that listing (the ` +
          `UDID/serial, never the human name). If nothing is booted, stop and report that as a ` +
          `blocker. The app under test must already be INSTALLED on the device — launch it; if it is ` +
          `not installed${appName ? ` (or no app matching "${appName}" is present)` : ''}, stop and ` +
          `report that as a blocker rather than trying to install it. Perform ` +
          `ALL interaction and verification on the device, capturing mobile screenshots as evidence.`,
        MOBILE_RECIPES_HINT,
      )
    } else {
      lines.push(`App URL: ${opts.appUrl}`)
      if (opts.testTarget === 'web-mobile') {
        lines.push(
          ``,
          `TEST TARGET: the web app above, opened on a MOBILE device — do NOT use the desktop/Playwright ` +
            `browser. Drive the device with the connected MAESTRO MCP tools ONLY (no other mobile MCP is ` +
            `configured): call list_devices FIRST and drive a booted simulator/device — every other ` +
            `Maestro tool needs the "device_id" from that listing (the UDID/serial, never the human ` +
            `name); the synthetic "chromium" entry is a drivable web device even though it reports ` +
            `connected:false. If nothing is available, stop and report that as a blocker. Open the App URL ` +
            `in the device's mobile browser and perform ALL interaction and verification on that device, ` +
            `capturing mobile screenshots as evidence. Test the responsive/mobile experience.`,
          MOBILE_RECIPES_HINT,
        )
      }
    }

    // Several devices/simulators booted at once means list_devices is ambiguous —
    // the engineer picked one in the Run form, so name it and forbid substituting
    // another (running the whole suite on the wrong emulator wastes the run, and the
    // report wouldn't say which device it was). No pick = previous behavior.
    const pinnedDevice = opts.testTarget !== 'web' ? opts.deviceId?.trim() : ''
    if (pinnedDevice) {
      lines.push(
        ``,
        `DEVICE: drive device_id "${pinnedDevice}" — the QC engineer picked this device for the run. ` +
          `Still call list_devices first (Maestro needs it), then pass EXACTLY this device_id to every ` +
          `subsequent Maestro tool. Do NOT switch to another entry in the listing even if others are ` +
          `booted. If this device_id is not in the listing, stop and report that as a blocker (name the ` +
          `device_ids you did find) rather than testing a different device. Say which device was tested ` +
          `in the report.`,
      )
    }

    if (steps.length) {
      lines.push(
        ``,
        `Feature workflow — exercise these steps in order as the primary acceptance path, ` +
          `verifying each step works before moving to the next:`,
        ...steps.map((s, i) => `${i + 1}. ${s}`),
      )
    }

    if (isQc) {
      lines.push(
        ``,
        `SCOPE — stay strictly inside THIS project (the current working directory). Use ONLY this ` +
          `project's own context to test and judge: its CLAUDE.md, its testing/knowledge/*.md and ` +
          `testing/memory/*.md, and its own source code in this working directory. Do NOT read, import, ` +
          `or rely on anything outside it — no global or user-level configuration (e.g. a home-directory ` +
          `~/.claude or a global CLAUDE.md), no other project's folder, knowledge, memory, or source, and ` +
          `no files outside this working directory. If any global or user-level instruction conflicts with ` +
          `this project's context, this project wins — ignore the global one for this run.`,
        ``,
        `Before testing, read this project's standing context if present and apply it ` +
          `throughout the run (real screen/field names, roles, business rules, known gotchas): ` +
          `durable facts in testing/memory/*.md (indexed by testing/memory/MEMORY.md) and ` +
          `reference docs in testing/knowledge/*.md. If testing/environments.md exists, use the ` +
          `exact app URLs and test-account credentials it lists for every login/setup step ` +
          `instead of inventing placeholders.`,
        ``,
        `Also read the SOURCE CODE for the feature under test in this repository. Start from any ` +
          `testing/knowledge/source-map-*.md doc — it indexes each connected repo's screens/routes, ` +
          `models, and validation with file paths, so open the files it names directly instead of ` +
          `exploring. Only search the codebase (Grep/Glob/Read) for what the map doesn't cover — ` +
          `the screens, components, routes/endpoints, fields, and messages named in the ticket — ` +
          `to understand the real implementation, expected behavior, validation, and edge cases ` +
          `before you exercise the app. Read only; never modify the code.`,
        ``,
        `Follow the skill literally and in order through all 7 phases.`,
        ``,
        // COVERAGE — the second-biggest source of ungraded cases after the data policy.
        // A large suite (measured: 120 cases) captured in ONE Phase-4 pass runs out of
        // budget mid-way, so whole feature areas reach Phase 5 with nothing on disk and
        // come back "◻️ Not Tested — no evidence captured". Working in waves means an
        // exhausted budget costs the LAST area's depth instead of every area's evidence.
        `COVERAGE — when the test-case file has more than ~40 cases, do NOT capture the whole ` +
          `suite before analyzing any of it. Group the cases by feature area, then work one area ` +
          `at a time: capture that area's evidence (Phase 4), immediately fan out its subagents ` +
          `(Phase 5), record the verdicts, and only then move to the next area. Cover EVERY area ` +
          `at least once before going back for depth anywhere — a shallow pass over all of them ` +
          `beats a thorough pass over the first three and nothing for the rest.`,
        `Announce the wave plan (the areas and their case ranges) before the first capture, and ` +
          `after each wave print one line — "Wave 3/8 — Lab Order (No-91–No-97) graded". If you can ` +
          `see the budget will not stretch to every area, say so at that point and name the areas ` +
          `you are dropping, so the engineer can re-run just those instead of discovering the gap ` +
          `in the report.`,
        `"◻️ Not Tested — no evidence captured" is a failure of the RUN, not a verdict on the ` +
          `product: never use it as a shrug. Every case must either be graded from evidence you ` +
          `captured this run, or carry a reason a QC engineer could act on (the state it needed, ` +
          `the account it needed, the screen that wasn't in scope). Reporting an honest gap is ` +
          `right; reporting a gap you didn't have to leave is not.`,
        ``,
        // OUTPUT FOLDER — the portal owns the tail of the name. The skill lets the
        // model name the folder `<ticket-id>-<slug>`, so two runs of the same ticket
        // (the classic case: one on desktop web, then one on a device) picked the same
        // name and the second overwrote the first's report.md / issues.md /
        // screenshots — and the portal, which used to find a run's folder by ticket
        // prefix, then showed that one surviving report for BOTH runs in History.
        opts.outDirSuffix
          ? `OUTPUT FOLDER — write this run's results into EXACTLY ONE new folder, named:\n` +
            `    testing/test-result/${opts.ticketId}-<short-feature-slug>-${opts.outDirSuffix}/\n` +
            `<short-feature-slug> is yours to choose (a few words about the feature, lowercase, ` +
            `hyphenated). The "${opts.outDirSuffix}" ending is MANDATORY and must be the LAST part ` +
            `of the folder name, character for character — it identifies this run. Create that ` +
            `folder yourself and put report.md, issues.md, screenshots/ and every other artifact ` +
            `inside it. Do NOT write into, reuse, or delete a folder from an earlier run, even one ` +
            `for the same ticket, and do NOT drop the ending — the skill's own examples omit it, ` +
            `and this instruction overrides them.`
          : `Write the report and issues into testing/test-result/<ticket-slug>/ as the skill specifies.`,
        ``,
        // Report structure contract — EVERY report.md must open with these three
        // sections, in this order and format, before any AC-level or per-case
        // detail. Non-negotiable regardless of the run's outcome. The Execution
        // Summary table is also what the portal parses for pass/fail counts, so
        // its rows must be "| <Status label> | <number> | <percent> |".
        `REPORT FORMAT — report.md MUST begin with these three sections, in THIS order, ` +
          `with THESE exact H2 headings and table shapes, on every run (even a blocked or ` +
          `failed one). Fill every row; never omit a section.`,
        ``,
        // The portal renders report.md as GitHub-Flavored Markdown (react-markdown),
        // which does NOT execute or render raw HTML — a `<style>` block or a
        // `<table class="qc">` prints as literal source text at the top of the report.
        // Force pure GFM so every table/image renders instead of leaking as raw tags.
        `WRITE PURE GITHUB-FLAVORED MARKDOWN — no raw HTML anywhere in report.md. Do NOT emit a ` +
          `<style> block, inline CSS, or any HTML tags (<table>, <tr>, <td>, <th>, <col>, <colgroup>, ` +
          `<b>, <br>, <img>, …). Every table MUST be a markdown pipe table ("| A | B |" with a ` +
          `"|---|---|" separator row); every image MUST use markdown "![alt](relative/path.png)". ` +
          `The viewer shows raw HTML as literal text, so any HTML you emit will corrupt the report.`,
        ``,
        `## 1. Test Suite Executed — a two-column "Field | Value" table with these rows: ` +
          `**Suite / Module** (the feature/screens under test), **Ticket** (id + link + title), ` +
          `**Tested by**, **Test Execution Date** (today), **Build / Environment** (the App URL / target), ` +
          `**Acceptance source** (the test-case file path + AC references), **Overall Status** ` +
          `(Pass / Partial pass / Fail with a one-line reason), and **Case counts** ` +
          `(e.g. "N total · P Passed · F Failed · I issues · B Not Tested/Blocked").`,
        ``,
        `## 2. Covered Flow — a table "Flow | Covered? | Notes", one row per major flow/area you ` +
          `exercised, with Covered? as ✅ (done) / ⚠️ (partial) / ⛔ (not covered) and a short note ` +
          `(what was verified, or why it was skipped).`,
        ``,
        `## 3. Execution Summary — a table "Status | Count | %" with ONE SEPARATE row for each of ` +
          `✅ Passed, ❌ Failed, ⛔ Blocked, ◻️ Not Tested, ⚠️ Passed-with-issue, and (only if any) 🚫 Cancelled, ` +
          `then a bold **Total** row. Keep Blocked and Not Tested as DISTINCT rows — never merge them into a ` +
          `single "Not Tested / Blocked" row — so the portal can report each bucket separately. The Count ` +
          `column must be a plain number and the percentages must sum to 100%. Follow it with a **Pass Rate** ` +
          `and a **Completion Rate** line. The counts here must reconcile exactly with the per-case results ` +
          `later in the report.`,
        ``,
        `After these three sections, continue with the AC-level outcome, per-case Test Result Details, ` +
          `and QC notes the skill specifies.`,
      )
    } else {
      lines.push(`Follow the skill literally and in order.`)
    }
    // DATA POLICY — the single biggest driver of a run's Blocked count.
    //
    // A read-only run cannot exercise any case shaped "do X, then check what X produced",
    // so every trigger/creation case comes back ⛔ Blocked — measured at 64 of 120 cases
    // (53%) on a notification ticket, all of them with the same reason ("would require
    // mutating shared DEV data"). The same suite driven by hand in /chat grades those
    // cases, for one reason only: there the engineer SAYS "create an appointment and check
    // the notification", which is the "unless the user said so" escape the skill already
    // has. So the escape becomes an explicit per-run choice instead of something only a
    // chat conversation can express — and when it is off, the wording is unchanged.
    if (opts.dataPolicy === 'seed') {
      lines.push(
        ``,
        `TEST DATA — the QC engineer has AUTHORIZED this run to create the test data it needs. ` +
          `You MAY perform the create/submit actions a case requires (create an appointment, submit ` +
          `a request, add a note, send a message, upload a file) in order to reach a state and then ` +
          `verify the result. That authorization is the "unless the user said so" case in the ` +
          `skill's safety rules — it applies to data YOU create for this test run.`,
        `Still forbidden, with no exceptions: deleting, voiding, cancelling, approving, rejecting, ` +
          `signing, closing or otherwise mutating a record you did NOT create in this run; bulk or ` +
          `batch actions; anything that emails/notifies a real person outside the test accounts; ` +
          `changing settings, roles, permissions or configuration that other users share; and any ` +
          `change to the application code or database. When in doubt about a record's origin, treat ` +
          `it as someone else's and stop at the enable-state.`,
        `Work with the test accounts from testing/environments.md, prefer obviously-synthetic values ` +
          `(a "QC <date>" name, a far-future date) so your rows are identifiable, and list every ` +
          `record you created in the report under a "Test data created" heading so it can be cleaned ` +
          `up later. Do NOT try to delete your own rows afterwards unless the case is about deletion.`,
        `Because of this, a case may NOT be reported ⛔ Blocked for the reason "would require ` +
          `mutating shared data" or "no existing instance found" — that data is now yours to create. ` +
          `Blocked is reserved for a case you genuinely cannot reach: a screen outside the given URL, ` +
          `a role you have no account for, a broken environment, or an external system you can't ` +
          `drive. If creating the data fails, that is a ❌ Failed (or a real blocker) with the error ` +
          `captured — not a silent skip.`,
      )
    } else {
      lines.push(
        ``,
        `TEST DATA — READ-ONLY run: do not commit any mutating action on the shared environment. ` +
          `Drive up to the point the final action would commit, capture that, and stop. A case that ` +
          `needs data you would have to create is ⛔ Blocked with the state it needed named exactly.`,
        `Before you settle for Blocked, LOOK for an existing record in the state the case needs — ` +
          `search, filter, sort and page through the list rather than concluding from the first ` +
          `screen that nothing exists. "No existing instance found" is only an honest Blocked after ` +
          `you actually searched for one, and the report must say which search you ran.`,
        `Say so in the report's QC notes: name the cases that only Blocked because of this policy, ` +
          `so the engineer can re-run with "Allow test-data creation" turned on and get them graded.`,
      )
    }

    // Authenticator-app 2FA: how to obtain the REAL current code instead of a fixed
    // OTP that no longer exists on production-like environments. Built by totp.ts;
    // empty (and thus a no-op) when the project registered no authenticators.
    const totpHint = opts.totpHint?.trim()
    if (totpHint) lines.push(``, totpHint)

    const notes = opts.instructions?.trim()
    if (notes) {
      lines.push(
        ``,
        `Extra instructions from the QC engineer — treat these as high priority:`,
        notes,
      )
    }
    prompt = lines.join('\n')
  }

  // The prompt goes over stdin, NOT as an argv positional. On Windows `claude` is a
  // `claude.cmd` batch shim, and cmd.exe truncates a multi-line argument at the first
  // newline — so a positional prompt would arrive as only its first line (the ticket
  // ID, App URL, and instructions silently dropped, leaving the model stuck in intake).
  // stdin also sidesteps the OS command-line length cap. `claude -p` reads the prompt
  // from stdin when no positional is given.
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
  ]
  // Pin the model only for fresh runs — a resumed session already carries the
  // model it was started with, and re-passing --model could override it.
  if (!resuming && opts.model?.trim()) {
    args.push('--model', opts.model.trim())
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId)
  }
  // Only present when this run's browser mode differs from the project's saved one.
  if (opts.mcpConfigPath) {
    args.push('--mcp-config', opts.mcpConfigPath, '--strict-mcp-config')
  }

  const child = spawn(CLAUDE_BIN, args, {
    cwd: opts.cwd ?? process.cwd(),
    env: spawnEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    // Own process group so we can signal the *whole* tree (claude + its MCP
    // servers + the Playwright browser) at once, instead of just the lead
    // process — otherwise killing claude leaves the browser orphaned. POSIX
    // only: on Windows `detached` opens a console window and the group-kill via
    // process.kill(-pid) doesn't apply (killTree falls back to child.kill).
    detached: process.platform !== 'win32',
    // Never flash a cmd window when launching claude(.cmd) on Windows.
    windowsHide: true,
  })
  // Deliver the prompt, then close stdin so the CLI sees EOF and starts immediately.
  if (child.stdin) {
    child.stdin.on('error', () => {}) // a broken pipe (child died early) must not crash us
    child.stdin.end(prompt)
  }

  cb.onEvent({ ts: now(), kind: 'system', text: `Started QC run for ${opts.ticketId}` })

  let stdoutBuf = ''
  let lastResult = ''

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stdoutBuf += chunk
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line) continue
      handleLine(line)
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    const text = String(chunk).trim()
    if (text) cb.onEvent({ ts: now(), kind: 'error', text })
  })

  child.on('error', (err) => cb.onError(err.message))

  let exited = false
  child.on('close', () => {
    exited = true
  })

  child.on('close', (code) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim())
    const success = code === 0
    cb.onEvent({
      ts: now(),
      kind: 'done',
      text: success ? 'QC run finished' : `QC run exited with code ${code}`,
    })
    cb.onDone({ success, resultText: lastResult })
  })

  // Emit a violet "Phase" marker only when the run ADVANCES to a new phase
  // (monotonic) so the log isn't spammed with repeats and the progress bar never
  // snaps backward. Returns the phase so callers can also tag the triggering event.
  let maxPhaseIdx = -1
  function notePhase(phase: Phase | undefined): Phase | undefined {
    if (!phase) return undefined
    const i = PHASE_ORDER.indexOf(phase)
    if (i > maxPhaseIdx) {
      maxPhaseIdx = i
      cb.onEvent({ ts: now(), kind: 'phase', phase, text: `Phase ${i + 1} — ${phase}` })
    }
    return phase
  }

  function emitText(text: string) {
    const phase = notePhase(detectPhase(text))
    cb.onEvent({ ts: now(), kind: 'text', phase, text })
  }

  function handleLine(line: string) {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Not JSON — surface as raw text so nothing is lost.
      cb.onEvent({ ts: now(), kind: 'text', text: line })
      return
    }

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') {
          if (msg.session_id) cb.onSession?.(String(msg.session_id))
          cb.onEvent({
            ts: now(),
            kind: 'system',
            text: `Session ${msg.session_id ?? ''} — model ${msg.model ?? 'default'}`,
          })
        }
        return

      case 'assistant': {
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text?.trim()) {
            emitText(block.text.trim())
          } else if (block.type === 'tool_use') {
            const summary = summarizeTool(block.name, block.input)
            const phase = notePhase(detectPhaseFromTool(block.name, block.input))
            cb.onEvent({ ts: now(), kind: 'tool', tool: block.name, phase, text: summary })
          }
        }
        return
      }

      case 'user': {
        // tool results coming back — keep them short
        const content = msg.message?.content ?? []
        for (const block of content) {
          if (block.type === 'tool_result') {
            const txt = extractToolResultText(block.content)
            if (txt) cb.onEvent({ ts: now(), kind: 'tool_result', text: truncate(txt, 240) })
          }
        }
        return
      }

      case 'result': {
        lastResult = msg.result ?? msg.subtype ?? ''
        const usage = usageFromResultObject(msg)
        if (usage) recordUsage({ source: 'qc-run', model: msg.model ?? null, ...usage })
        return
      }

      default:
        return
    }
  }

  return {
    child,
    cancel: () => {
      killTree(child, 'SIGTERM')
      // Escalate to SIGKILL if claude (and its browser) don't tear down in time.
      setTimeout(() => {
        if (!exited) killTree(child, 'SIGKILL')
      }, 4000).unref()
    },
  }
}

/**
 * Signal a child *and all its descendants* (claude + MCP servers + Playwright/Edge).
 *
 * POSIX: the child was spawned `detached`, so it leads its own process group and
 * `process.kill(-pid, …)` reaches the whole group; falls back to the lone process
 * if the group send fails (e.g. it already exited).
 *
 * Windows: there are no process groups, and `child.kill()` only reaches the
 * `cmd.exe`/`claude.cmd` wrapper — leaving `claude.exe`, its MCP servers, and the
 * browser orphaned and running (which is what lets extra runs pile up concurrently
 * after a cancel/pause). `taskkill /T` walks the whole tree by pid instead; `/F`
 * force-terminates and is used for the SIGKILL escalation.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid == null) return
  if (process.platform === 'win32') {
    const args = ['/PID', String(child.pid), '/T']
    if (signal === 'SIGKILL') args.push('/F')
    try {
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true }).on('error', () => {
        // taskkill missing/failed — fall back to at least the wrapper.
        try {
          child.kill(signal)
        } catch {
          /* already gone */
        }
      })
    } catch {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function summarizeTool(name: string, input: any): string {
  if (!input) return name
  switch (name) {
    case 'Bash':
      return `$ ${truncate(String(input.command ?? ''), 120)}`
    case 'Read':
      return `Read ${input.file_path ?? ''}`
    case 'Write':
      return `Write ${input.file_path ?? ''}`
    case 'Edit':
      return `Edit ${input.file_path ?? ''}`
    case 'Task':
    case 'Agent':
      return `Subagent: ${truncate(String(input.description ?? input.prompt ?? ''), 80)}`
    default:
      if (name.startsWith('browser_')) {
        const detail = input.url || input.selector || input.element || input.ref || ''
        return `${name} ${truncate(String(detail), 80)}`
      }
      if (name.startsWith('clickup')) return `${name} ${input.taskId ?? input.id ?? ''}`
      return `${name} ${truncate(JSON.stringify(input), 80)}`
  }
}

function extractToolResultText(content: any): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c?.text ?? ''))
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
