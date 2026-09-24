import { missingRefs } from './answerCheck.js'
import type { TeamBot, TeamFile } from './aiTeamStore.js'
import type { runClaudeStream, StreamResult } from './claudeExec.js'
import type {
  Chat,
  ChatAction,
  ChatStep,
  ChatTools,
  LiveTurn,
  TeamSlot,
  TurnSpec,
  TurnStats,
} from './routes/chat.js'
import {
  DirectiveFilter,
  EDIT_TOOLS,
  MAX_TEAM_REPLIES,
  addressees,
  botGuards,
  botPrompt,
  botRef,
  botTools,
  disabledNamed,
  earlierMaterial,
  mentionedHandles,
  parseDirective,
  pendingAskers,
  resolveCalls,
  runPool,
  scopeTeam,
  threadFrom,
  HUMAN_HANDLE,
  type ToolAccess,
} from './teamChat.js'
import { knownFilesBlock, rememberFile, shareablePath } from './teamFiles.js'
import { clearTeamMcpConfig, trackerFreeMcpConfig } from './teamMcp.js'

/**
 * ANSWER ONE MESSAGE WITH THE AI TEAM — the orchestration loop, out of routes/chat.ts.
 *
 * It lived as a 400-line closure inside the `/stream` handler, reading half a dozen of the
 * handler's variables, so nothing about it could be tested without a real `claude`: the
 * "one bot fails mid-exchange" path was only ever checked by reading it. Everything it
 * needs from the route now comes in through `TeamRunContext` — including the CLI runner,
 * so server/test/teamRunner.test.ts drives it with a scripted fake. The route keeps what
 * is the route's: the live-turn registry, the queue, the stream and its handovers.
 *
 * THE BOTS OF ONE ROUND RUN IN PARALLEL (`runPool`, at most `policy.maxParallelBots` at
 * once). They are independent by construction — each replies to the thread as it stood
 * when the round began, and is told who else is answering alongside it — so running them
 * one after another only added their times up. Rounds stay sequential: round N+1 is who
 * round N called on, and it needs their words.
 *
 * WHO IS CALLED NEXT comes from each reply's CONTROL LINE (`parseDirective`), never from
 * the prose; a reply without one falls back to its @handles. The line never reaches the
 * wire (`DirectiveFilter`) or the transcript; what it said is kept on the message as
 * `teamCalls` / `asksHuman`.
 *
 * Frames, beyond an ordinary turn's, all carrying `seg` (one per bot reply) because
 * several stream at once: `speaker` opens a reply, `delta`/`tool` feed it, `said` carries
 * the saved conversation once that bot is done, and `done` ends the whole exchange. The
 * question is written with the FIRST saved reply, exactly as an ordinary turn writes it
 * with its answer, so a Stop before anyone spoke leaves nothing behind.
 *
 * ONE BOT FAILING DOES NOT END THE EXCHANGE: its failure is saved as its message (marked
 * failed), a log line says so, and the rest carry on. Only an exchange in which NOBODY has
 * answered ends with an error — a broken CLI or a lost login.
 *
 * It never touches `chat.sessionId`: each bot runs fresh with the thread in its prompt,
 * so the plain assistant's own session survives a team exchange untouched.
 */

export type TeamOutcome = 'done' | 'stopped' | 'error'

export interface TeamRunContext {
  root: string
  /** The conversation being answered into — mutated in place, saved via `persist`. */
  chat: Chat
  spec: TurnSpec
  /** The live-turn record re-attaching viewers are caught up from. */
  turn: LiveTurn
  signal: AbortSignal
  /** Emit a frame to whoever is watching. */
  send: (frame: unknown) => void
  /** Save the conversation (a no-op once it was deleted mid-turn). */
  persist: () => void
  /** Cancel the queue behind this turn and hand its text back. */
  dropRemaining: () => string[]
  /** Register what the route's drain-level `catch` should save if something escapes. */
  setRescue: (fn: (why: string) => void) => void
  loadTeam: () => TeamFile
  runClaude: typeof runClaudeStream
  /** Accuracy + defect rules every reply follows. */
  rules: string
  actionBlock: (action: ChatAction) => string
  toolArgs: (tools: ChatTools, action: ChatAction | null) => string[]
  timeoutFor: (tools: ChatTools, action: ChatAction | null) => number
  limits: { maxMessages: number; maxText: number; maxToolsPerTurn: number; idleTimeoutMs: number }
  /** Auto-learn hook, called once after `done` with what the bots said. */
  onLearn?: (question: string, answer: string) => void
}

type Spoken =
  | { outcome: 'ok'; text: string; calls: string[] }
  | { outcome: 'failed'; why: string }
  | { outcome: 'stopped' }

export async function runTeamTurn(ctx: TeamRunContext): Promise<TeamOutcome> {
  const { root, chat, spec: s, turn: t, signal, send, persist, dropRemaining, limits } = ctx

  let userPushed = false
  const pushUser = (at: string) => {
    if (userPushed) return
    userPushed = true
    // From here a re-attaching viewer must not draw the question again.
    t.continuation = true
    chat.messages.push({
      role: 'user',
      text: s.prompt,
      at,
      images: s.images.length ? s.images.map((i) => i.file) : undefined,
      files: s.docs.length ? s.docs.map((d) => ({ file: d.file, name: d.name })) : undefined,
      action: s.action ?? undefined,
      context: s.injected.length ? s.injected.map((c) => ({ ...c })) : undefined,
    })
  }
  /** The question plus a notice in place of an answer — the team could not answer at all. */
  const failWhole = (why: string): TeamOutcome => {
    const at = new Date().toISOString()
    pushUser(at)
    chat.messages.push({ role: 'assistant', text: why, at, error: true })
    chat.messages = chat.messages.slice(-limits.maxMessages)
    chat.updatedAt = at
    persist()
    send({ type: 'error', error: why, chat, dropped: dropRemaining() })
    return 'error'
  }

  if (s.mentionLog) send({ type: 'log', ...s.mentionLog })

  let fullTeam: TeamFile
  try {
    fullTeam = ctx.loadTeam()
  } catch (err) {
    return failWhole(
      `The AI team could not be loaded (${err instanceof Error ? err.message : String(err)}). ` +
        'Fix or reset it on the AI Team page.',
    )
  }
  // WHO IS IN THIS CHAT (see teamChat.ts `scopeTeam`). A bot the human names by typing its
  // handle joins, just as picking it from the @ menu does — otherwise "@tester, can you…"
  // in a chat that only has the Analyst would go unanswered.
  if (chat.team?.members) {
    const newcomers = addressees(s.prompt, fullTeam, undefined, false).filter((id) => !chat.team!.members!.includes(id))
    if (newcomers.length) {
      chat.team = { ...chat.team, members: [...chat.team.members, ...newcomers] }
      send({
        type: 'log',
        level: 'info',
        text: `${newcomers.map((id) => `@${id}`).join(', ')} joined this chat.`,
      })
    }
  }
  const members = chat.team?.members
  const team = scopeTeam(fullTeam, members)
  const enabled = team.bots.filter((bot) => bot.enabled)
  if (!enabled.length) {
    return failWhole(
      members
        ? `None of the bots in this chat (${members.map((id) => `@${id}`).join(', ')}) is active. Turn one on on the AI Team page, or bring another in with @.`
        : 'The AI team has no active bots. Turn one on on the AI Team page.',
    )
  }
  const byId = new Map(team.bots.map((bot) => [bot.id, bot]))
  const maxRounds = Math.max(1, team.policy.maxRounds)
  const maxParallel = Math.max(1, team.policy.maxParallelBots)
  const coordinator =
    team.coordinatorId && byId.get(team.coordinatorId)?.enabled ? byId.get(team.coordinatorId)! : null
  // Read BEFORE this message is pushed: material from the human's earlier messages only.
  const earlier = earlierMaterial(chat.messages)

  // Who the human is talking to: the bots they named; else the bots that asked them
  // something at the end of the last exchange — this message is the answer; else whoever
  // coordinates. The first two are DIRECT: the human's message is their approval, so
  // their tracker / file-edit locks are lifted for this exchange.
  const named = addressees(s.prompt, team, undefined, false)
  const askers = named.length ? [] : pendingAskers(chat.messages, team)
  const direct = new Set(named.length ? named : askers)
  const first = direct.size ? [...direct] : [(coordinator ?? enabled[0]).id]
  let wave: { id: string; calledBy: string[] }[] = first.map((id) => ({ id, calledBy: ['human'] }))
  let round = 0
  let replies = 0

  const off = disabledNamed(s.prompt, fullTeam)
  if (off.length) {
    send({
      type: 'log',
      level: 'info',
      text: `${off.map((id) => `@${id}`).join(', ')} ${off.length === 1 ? 'is' : 'are'} turned off on the AI Team page, so ${off.length === 1 ? 'it' : 'they'} will not answer.`,
    })
  }
  if (askers.length) {
    send({
      type: 'log',
      level: 'info',
      text: `Your reply goes to ${askers.map((id) => `@${id}`).join(', ')}, who asked you. Name a bot to talk to someone else.`,
    })
  }

  // What the team has read, shared with every later prompt (see teamFiles.ts). `readBy`
  // is this exchange's attribution; the list itself lives on the conversation.
  const readBy = new Map<string, string>()
  const noteRead = (bot: TeamBot, filePath: string) => {
    const rel = shareablePath(root, filePath)
    if (!rel) return
    if (!readBy.has(rel)) readBy.set(rel, `@${bot.id}`)
    chat.teamFiles = rememberFile(chat.teamFiles ?? [], rel)
  }

  const speakers = new Map<number, TeamSlot>()
  t.speakers = speakers
  let segs = 0
  ctx.setRescue((why) => {
    const at = new Date().toISOString()
    pushUser(at)
    // Every reply still streaming that is not already in the transcript keeps what it
    // said; with none, a notice says why the exchange ended.
    let wrote = false
    for (const slot of speakers.values()) {
      const partial = slot.answer.trim()
      if (slot.saved || !partial) continue
      slot.saved = true
      wrote = true
      chat.messages.push({ role: 'assistant', text: `${partial}\n\n---\n\n*${why}*`, at, error: true, bot: slot.bot })
    }
    if (!wrote) chat.messages.push({ role: 'assistant', text: why, at, error: true })
    chat.messages = chat.messages.slice(-limits.maxMessages)
    persist()
  })

  /** Said once per exchange: which bots found the tracker locked, and how to unlock it. */
  let lockAnnounced = false

  /**
   * One bot's reply: streamed into its own slot, then saved as its own message. Never
   * throws and never sends a terminal frame — several run at once, and only the round
   * that owns them may end the exchange.
   */
  async function speak(
    bot: TeamBot,
    calledBy: string[],
    closing: false | 'cap' | 'report',
    peers: string[],
  ): Promise<Spoken> {
    const ref = botRef(bot)
    const seg = ++segs
    const slot: TeamSlot = { seg, bot: ref, calledBy: [...calledBy], answer: '', calls: [], saved: false }
    speakers.set(seg, slot)
    send({ type: 'speaker', seg, bot: ref, calledBy })

    // `slot.answer` is the VISIBLE text (what the wire and a re-attach carry); the filter
    // also keeps the raw reply, control line included, for `parseDirective`.
    const filter = new DirectiveFilter()
    const usedTools: string[] = []
    const startedAt = Date.now()
    let firstDeltaAt: number | null = null
    let resolvedModel: string | null = null
    let usage: StreamResult['usage'] | undefined
    const record = (text: string, failed: boolean, extra?: { teamCalls?: string[]; asksHuman?: boolean }) => {
      const at = new Date().toISOString()
      pushUser(at)
      const body = text.slice(0, limits.maxText)
      const miss = failed ? [] : missingRefs(root, body)
      const stats: TurnStats = {
        ms: Date.now() - startedAt,
        ...(firstDeltaAt !== null ? { ttftMs: firstDeltaAt - startedAt } : {}),
        ...(usage
          ? {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              ...(usage.cacheReadTokens ? { cacheReadTokens: usage.cacheReadTokens } : {}),
              ...(usage.costUsd ? { costUsd: usage.costUsd } : {}),
            }
          : {}),
      }
      chat.messages.push({
        role: 'assistant',
        text: body,
        at,
        bot: ref,
        addressedBy: calledBy.length ? [...calledBy] : undefined,
        tools: usedTools.length ? [...usedTools] : undefined,
        steps: slot.calls.length ? slot.calls.map((c) => ({ ...c, pos: Math.min(c.pos, body.length) })) : undefined,
        model: resolvedModel ?? bot.model,
        effort: s.effort === 'default' ? undefined : s.effort,
        error: failed || undefined,
        refs: miss.length ? miss : undefined,
        stats,
        ...(extra?.teamCalls?.length ? { teamCalls: extra.teamCalls } : {}),
        ...(extra?.asksHuman ? { asksHuman: true } : {}),
      })
      chat.messages = chat.messages.slice(-limits.maxMessages)
      chat.updatedAt = at
      slot.saved = true
    }
    /** Saved (or failed to save) — the row is the transcript's now. */
    const finish = () => {
      speakers.delete(seg)
      send({ type: 'said', seg, chat })
    }

    let mcpFile: string | null = null
    try {
      // The `+` action (diagram / web / research) is an instruction for whoever the human
      // addressed, in the first round — not for every bot called on after them.
      const action = round === 1 && calledBy.includes('human') && !closing ? s.action : null
      const tools = botTools(bot, s.tools)
      const guards = botGuards(team, bot, direct.has(bot.id))
      let mcp: ToolAccess['mcp'] = 'all'
      const extra: string[] = []
      if (tools === 'full' && guards.tracker) {
        const cfg = trackerFreeMcpConfig(root, `${chat.slug}-${Date.now()}-${seg}-${bot.id}`)
        if (cfg) {
          mcpFile = cfg.file
          mcp = 'no-tracker'
          extra.push('--mcp-config', cfg.file, '--strict-mcp-config')
          if (!lockAnnounced && cfg.dropped.length) {
            lockAnnounced = true
            send({
              type: 'log',
              level: 'info',
              text: `The issue tracker (${cfg.dropped.join(', ')}) is locked for bots you did not address directly — they draft and ask you first. Reply to that bot (or @name it) to approve.`,
            })
          }
        } else {
          // Could not write the config: fail CLOSED — no MCP at all rather than a tracker.
          mcp = 'none'
          extra.push('--strict-mcp-config')
          send({ type: 'log', level: 'error', text: `${bot.name} runs without MCP servers: its tool config could not be written.` })
        }
      }
      if (guards.edits) extra.push('--disallowedTools', ...EDIT_TOOLS)

      const thread = threadFrom(userPushed ? chat.messages : [...chat.messages, { role: 'user', text: s.prompt }])
      const prompt = botPrompt({
        team,
        bot,
        thread,
        calledBy,
        attachments: s.attachments + (action ? ctx.actionBlock(action) : ''),
        earlier,
        known: knownFilesBlock(root, chat.teamFiles ?? [], readBy),
        peers,
        access: {
          mode: tools,
          chatMode: s.tools,
          mcp,
          editsLocked: guards.edits,
          web: action === 'web' || action === 'research',
        },
        rules: ctx.rules,
        round,
        maxRounds,
        closing,
      })

      const r = await ctx.runClaude(
        [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          // Each reply is a fresh run with the thread in its prompt, so there is no session
          // worth keeping — and sixteen stray ones per message would be clutter in the
          // engineer's own `claude --resume` list.
          '--no-session-persistence',
          ...ctx.toolArgs(tools, action),
          ...extra,
          '--model',
          bot.model,
          ...(s.effort === 'default' ? [] : ['--effort', s.effort]),
        ],
        ctx.timeoutFor(tools, action),
        (log) => {
          if (log.tool) {
            if (log.tool.name === 'Read' && log.tool.path) noteRead(bot, log.tool.path)
            if (slot.calls.length < limits.maxToolsPerTurn) {
              usedTools.push(log.tool.name)
              const step: ChatStep = { name: log.tool.name, detail: log.tool.detail, pos: slot.answer.length }
              slot.calls.push(step)
              send({ type: 'tool', seg, ...step })
            }
            return
          }
          // Several bots log at once in a parallel round — say whose line it is.
          send({ type: 'log', level: log.level, text: `@${bot.id} · ${log.text}` })
        },
        {
          usageSource: 'team-chat',
          model: bot.model,
          input: prompt,
          cwd: root,
          signal,
          onDelta: (chunk) => {
            if (firstDeltaAt === null) firstDeltaAt = Date.now()
            const visible = filter.push(chunk)
            if (!visible) return
            slot.answer += visible
            send({ type: 'delta', seg, text: visible })
          },
          suppressAssistantText: true,
          onModel: (m) => {
            resolvedModel = m
          },
          idleTimeoutMs: limits.idleTimeoutMs,
        },
      )
      usage = r.usage

      if (signal.aborted) {
        // Stop: keep what this bot said. The round sends the one `stopped` frame.
        const partial = parseDirective(filter.full).text.trim()
        if (partial) record(partial, true)
        speakers.delete(seg)
        return { outcome: 'stopped' }
      }
      // The buffer, not `r.text` — `result` holds only the LAST text block of a
      // multi-step reply (see the plain turn). `r.text` only when nothing streamed.
      const { text: visibleText, directive } = parseDirective(filter.full.trim() ? filter.full : r.text)
      const text = visibleText.trim()
      if (!text || r.isError) {
        // Saved as this bot's message, marked failed — the others see a notice, the reader
        // sees why — and the exchange carries on.
        const why = !text
          ? r.timedOut
            ? `${bot.name} was cut off after ${Math.round(ctx.timeoutFor(tools, action) / 60_000)} minutes.`
            : `${bot.name} returned nothing. Check that Auto Agent is connected on the sidebar.`
          : `${bot.name}'s reply failed.`
        record(text || why, true)
        persist()
        finish()
        send({ type: 'log', level: 'error', text: why })
        return { outcome: 'failed', why }
      }
      // Who is called next: the control line; a reply that forgot it falls back to its
      // @handles (the old rule), so a missing line never strands delegated work.
      const calls = directive ? resolveCalls(directive.call, team, bot.id) : addressees(text, team, bot.id)
      const asksHuman = directive ? directive.askHuman : mentionedHandles(text).includes(HUMAN_HANDLE)
      if (!directive) {
        send({ type: 'log', level: 'info', text: `@${bot.id} · no control line — routed by the @handles in its text.` })
      }
      record(text, false, { teamCalls: calls, asksHuman })
      persist()
      finish()
      return { outcome: 'ok', text, calls }
    } catch (err) {
      // Unexpected (a CLI helper rejecting, a transcript write failing). In a parallel
      // round a throw would abandon the bots still running beside this one, so it is
      // turned into this bot's failure instead.
      if (signal.aborted) {
        speakers.delete(seg)
        return { outcome: 'stopped' }
      }
      const why = `${bot.name}'s reply failed: ${err instanceof Error ? err.message : String(err)}`
      try {
        if (!slot.saved) record(slot.answer.trim() ? `${slot.answer.trim()}\n\n---\n\n*${why}*` : why, true)
        persist()
      } catch {
        /* the transcript is what failed — the frames below still tell the reader */
      }
      finish()
      send({ type: 'log', level: 'error', text: why })
      return { outcome: 'failed', why }
    } finally {
      clearTeamMcpConfig(mcpFile)
    }
  }

  /** The one terminal frame for a Stop, however many bots were running. */
  const stopAll = (): TeamOutcome => {
    speakers.clear()
    if (userPushed) persist()
    send({ type: 'stopped', chat: userPushed ? chat : undefined, dropped: dropRemaining() })
    return 'stopped'
  }

  send({
    type: 'log',
    level: 'info',
    text: `AI team — ${wave.map((w) => `@${w.id}`).join(', ')} ${wave.length === 1 ? 'is' : 'are'} answering.`,
  })

  /** What the team actually said, for auto-learn once the exchange is over. */
  const spoken: { bot: TeamBot; text: string }[] = []
  // The coordinator's LATEST reply delegated work, and these bots have answered since
  // (in a LATER round — a bot answering beside it in the same round was not delegated
  // to). If nobody hands those answers back to it, it gets a `report` turn at the end.
  let coordDelegated = false
  let coordRound = 0
  const answeredSince: string[] = []
  // Rounds: everyone called on in one round speaks (in parallel), then everyone THEY
  // called on.
  let cutOff = false
  while (wave.length) {
    if (round >= maxRounds || replies >= MAX_TEAM_REPLIES) {
      cutOff = true
      break
    }
    round++
    const runnable = wave.filter((w) => byId.get(w.id)?.enabled)
    const room = MAX_TEAM_REPLIES - replies
    if (runnable.length > room) cutOff = true
    const batch = runnable.slice(0, room)
    const handles = batch.map((w) => `@${w.id}`)
    if (batch.length > 1 && round > 1) {
      send({
        type: 'log',
        level: 'info',
        text: `Round ${round} — ${handles.join(', ')} answering${maxParallel > 1 ? ' in parallel' : ''}.`,
      })
    }
    const results = await runPool(batch, maxParallel, async (w): Promise<Spoken> => {
      // Stopped while this one was still waiting for a free slot: never start it.
      if (signal.aborted) return { outcome: 'stopped' }
      return speak(byId.get(w.id)!, w.calledBy, false, handles.filter((h) => h !== `@${w.id}`))
    })
    if (signal.aborted || results.some((r) => r.outcome === 'stopped')) return stopAll()
    // A failed reply spent its share of the budget as surely as an answer did.
    replies += batch.length

    // Processed in the order they were CALLED, not the order they finished, so who is
    // called next (and in what order) does not depend on which model was faster.
    const next: { id: string; calledBy: string[] }[] = []
    let answered = 0
    let lastWhy = ''
    batch.forEach((w, i) => {
      const said = results[i]
      const bot = byId.get(w.id)!
      if (said.outcome === 'failed') {
        lastWhy = said.why
        return
      }
      if (said.outcome !== 'ok') return
      answered++
      spoken.push({ bot, text: said.text })
      if (coordinator && bot.id === coordinator.id) {
        coordDelegated = said.calls.length > 0
        coordRound = round
        answeredSince.length = 0
      } else if (coordDelegated && round > coordRound && !answeredSince.includes(`@${bot.id}`)) {
        answeredSince.push(`@${bot.id}`)
      }
      for (const id of said.calls) {
        const caller = `@${bot.id}`
        const hit = next.find((n) => n.id === id)
        if (hit) {
          if (!hit.calledBy.includes(caller)) hit.calledBy.push(caller)
        } else {
          next.push({ id, calledBy: [caller] })
        }
      }
    })
    if (batch.length && !answered && !spoken.length) {
      // Nobody has answered at all: a broken CLI or a lost login, not one bot. (A round
      // that fails AFTER others answered simply ends the exchange — a failed reply calls
      // on nobody — with its notice in the transcript.)
      ctx.setRescue(() => {})
      send({ type: 'error', error: `The AI team could not answer: ${lastWhy}`, chat, dropped: dropRemaining() })
      return 'error'
    }
    if (cutOff) break
    wave = next
  }

  if (cutOff) {
    // The cap stopped a conversation that was still going. Say so, and let whoever
    // coordinates close it rather than leaving the last question hanging.
    send({
      type: 'log',
      level: 'info',
      text: `The team reached its limit (${maxRounds} rounds, ${MAX_TEAM_REPLIES} replies at most)${coordinator ? ` — @${coordinator.id} is wrapping up` : ''}.`,
    })
    if (coordinator) {
      const said = await speak(coordinator, [], 'cap', [])
      if (said.outcome === 'stopped') return stopAll()
      if (said.outcome === 'ok') spoken.push({ bot: coordinator, text: said.text })
    }
  } else if (coordinator && coordDelegated && answeredSince.length) {
    // The exchange ended on its own, but the coordinator handed out work and nobody
    // brought the answers back — so it would never deliver the summary it promised
    // (seen on screen: "when you both answer I'll combine it", then silence). One
    // closing turn, calling on nobody, so this cannot extend the exchange further.
    send({ type: 'log', level: 'info', text: `@${coordinator.id} is bringing the answers together.` })
    const said = await speak(coordinator, [...answeredSince], 'report', [])
    if (said.outcome === 'stopped') return stopAll()
    if (said.outcome === 'ok') spoken.push({ bot: coordinator, text: said.text })
  }

  ctx.setRescue(() => {})
  send({ type: 'done', chat })
  // After `done`, never awaited by the reader: the route's hook decides whether to learn.
  if (spoken.length) {
    ctx.onLearn?.(s.prompt, spoken.map((x) => `${x.bot.name} (@${x.bot.id}, ${x.bot.role}): ${x.text}`).join('\n\n'))
  }
  return 'done'
}
