import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

// The AI team's orchestration loop (src/teamRunner.ts), driven by a SCRIPTED fake CLI —
// the paths a live run can't reliably produce on demand: a bot failing mid-round, every
// bot failing, Stop in the middle of a parallel round, the round cap, a throwing runner.
// Run with `npm -w server test`.

// The tracker-free MCP config is written beside the DB: keep it out of the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'team-run-'))
process.env.QC_DB_PATH = path.join(TMP, 'db', 'qc.db')

const { runTeamTurn } = await import('../src/teamRunner.ts')
const { starterTeam, normalizeTeam } = await import('../src/aiTeamStore.ts')
type TeamFile = ReturnType<typeof starterTeam>

// ---- fake CLI -----------------------------------------------------------------------

interface Plan {
  /** Streamed text chunks, control line included when the test wants one. */
  chunks?: string[]
  /** ms between chunks. */
  delay?: number
  isError?: boolean
  throws?: string
  /** Tool calls reported before the text. */
  tools?: { name: string; path?: string }[]
}
interface Call {
  bot: string
  args: string[]
  prompt: string
  start: number
  end: number
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      resolve()
    })
  })

function fakeCli(script: (bot: string, n: number, prompt: string) => Plan) {
  const calls: Call[] = []
  const counts = new Map<string, number>()
  const run = async (
    args: string[],
    _timeout: number,
    onLog: (l: { level: 'info' | 'success' | 'error'; text: string; tool?: { name: string; detail?: string; path?: string } }) => void,
    opts?: { input?: string; signal?: AbortSignal; onDelta?: (t: string) => void },
  ) => {
    const prompt = opts?.input ?? ''
    const bot = /\(@([a-z0-9-]+)\)/.exec(prompt)?.[1] ?? '?'
    const n = (counts.get(bot) ?? 0) + 1
    counts.set(bot, n)
    const call: Call = { bot, args, prompt, start: Date.now(), end: 0 }
    calls.push(call)
    const plan = script(bot, n, prompt)
    if (plan.throws) throw new Error(plan.throws)
    for (const tl of plan.tools ?? []) onLog({ level: 'info', text: `⚙ ${tl.name}`, tool: { name: tl.name, detail: tl.path, path: tl.path } })
    let text = ''
    for (const c of plan.chunks ?? []) {
      await sleep(plan.delay ?? 5, opts?.signal)
      if (opts?.signal?.aborted) {
        call.end = Date.now()
        return { text: '', isError: true, code: null, timedOut: false, aborted: true }
      }
      text += c
      opts?.onDelta?.(c)
    }
    call.end = Date.now()
    return { text, isError: !!plan.isError, code: 0, timedOut: false, aborted: false }
  }
  return { run, calls }
}

const line = (call: string[], askHuman = false) => `\n<!--team ${JSON.stringify({ call, askHuman })}-->`

// ---- harness ------------------------------------------------------------------------

interface Frame {
  type: string
  [k: string]: unknown
}

function harness(opts: {
  team?: TeamFile
  prompt?: string
  script: (bot: string, n: number, prompt: string) => Plan
  tools?: 'read' | 'write' | 'full'
  action?: 'diagram' | 'web' | 'research' | null
  messages?: unknown[]
  abortAfterMs?: number
  members?: string[]
}) {
  const root = fs.mkdtempSync(path.join(TMP, 'proj-'))
  const frames: Frame[] = []
  const chat = {
    slug: 'c1',
    name: 'c1',
    createdAt: '',
    updatedAt: '',
    model: 'default',
    tools: opts.tools ?? 'read',
    sessionId: null,
    team: { joinedAt: '', ...(opts.members ? { members: opts.members } : {}) } as { joinedAt: string; members?: string[] },
    messages: (opts.messages ?? []) as { role: string; text: string; [k: string]: unknown }[],
  }
  const spec = {
    id: 's1',
    prompt: opts.prompt ?? '@team-ai hello',
    promptForClaude: '',
    injected: [],
    images: [],
    docs: [],
    action: opts.action ?? null,
    model: 'default',
    tools: opts.tools ?? 'read',
    effort: 'low',
    at: '',
    mentionLog: null,
    team: true,
    attachments: '',
  }
  const turn: { continuation?: boolean; speakers?: Map<number, unknown> } = {}
  const ac = new AbortController()
  if (opts.abortAfterMs) setTimeout(() => ac.abort(), opts.abortAfterMs)
  let rescue: (why: string) => void = () => {}
  let saves = 0
  const learned: string[] = []
  const cli = fakeCli(opts.script)
  const ctx = {
    root,
    chat,
    spec,
    turn,
    signal: ac.signal,
    send: (f: unknown) => frames.push(f as Frame),
    persist: () => {
      saves++
    },
    dropRemaining: () => [],
    setRescue: (fn: (why: string) => void) => {
      rescue = fn
    },
    loadTeam: () => opts.team ?? starterTeam(),
    runClaude: cli.run,
    rules: '',
    actionBlock: (a: string) => `\nACTION-BLOCK-${a}`,
    toolArgs: () => [],
    timeoutFor: () => 60_000,
    limits: { maxMessages: 200, maxText: 200_000, maxToolsPerTurn: 50, idleTimeoutMs: 60_000 },
    onLearn: (_q: string, a: string) => learned.push(a),
  }
  return {
    root,
    frames,
    chat,
    turn,
    cli,
    learned,
    rescue: () => rescue,
    saves: () => saves,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: () => runTeamTurn(ctx as any),
  }
}

const botsSaid = (chat: { messages: { role: string; bot?: unknown }[] }) =>
  chat.messages.filter((m) => m.role === 'assistant').map((m) => (m.bot as { id: string } | undefined)?.id ?? '-')

// ---- tests --------------------------------------------------------------------------

test('coordinator delegates by control line; the round runs in PARALLEL; report turn closes the loop', async () => {
  const h = harness({
    script: (bot, n) =>
      bot === 'lead' && n === 1
        ? { chunks: ['Asking the team — ', '@tester is just a name here.', line(['ba', 'designer', 'critic'])] }
        : bot === 'lead'
          ? { chunks: ['Combined answer.', line([])] }
          : { chunks: [`${bot} part 1 `, `${bot} part 2`, line([])], delay: 60 },
  })
  const out = await h.run()
  assert.equal(out, 'done')
  // Tester was only NAMED in prose — the control line decides, so it never ran.
  assert.deepEqual(h.cli.calls.map((c) => c.bot).sort(), ['ba', 'critic', 'designer', 'lead', 'lead'])
  // The three delegated bots overlapped in time.
  const r2 = h.cli.calls.filter((c) => ['ba', 'designer', 'critic'].includes(c.bot))
  const latestStart = Math.max(...r2.map((c) => c.start))
  const earliestEnd = Math.min(...r2.map((c) => c.end))
  assert.ok(latestStart < earliestEnd, 'round 2 ran in parallel')
  // Transcript: question, lead, the three, lead's report — control lines stripped.
  assert.equal(h.chat.messages[0].role, 'user')
  assert.deepEqual(botsSaid(h.chat)[0], 'lead')
  assert.equal(botsSaid(h.chat).at(-1), 'lead')
  for (const m of h.chat.messages) assert.doesNotMatch(String(m.text), /<!--team/)
  assert.deepEqual((h.chat.messages[1] as { teamCalls?: string[] }).teamCalls, ['ba', 'designer', 'critic'])
  // The report turn named whom it was bringing together.
  const report = h.cli.calls.filter((c) => c.bot === 'lead')[1]
  assert.match(report.prompt, /bots you called on \(@ba, @designer, @critic\) have answered/)
  // Nothing of the control line ever went over the wire.
  const wire = h.frames.filter((f) => f.type === 'delta').map((f) => f.text).join('')
  assert.doesNotMatch(wire, /<!--|team \{/)
  assert.ok(h.frames.some((f) => f.type === 'log' && /Round 2 — @ba, @designer, @critic answering in parallel/.test(String(f.text))))
  assert.equal(h.frames.at(-1)!.type, 'done')
  assert.equal(h.learned.length, 1)
  assert.equal(h.turn.speakers!.size, 0)
})

test('peers are told who answers beside them', async () => {
  const h = harness({
    script: (bot, n) => (bot === 'lead' && n === 1 ? { chunks: ['go', line(['ba', 'designer'])] } : { chunks: ['ok', line([])] }),
  })
  await h.run()
  const ba = h.cli.calls.find((c) => c.bot === 'ba')!
  assert.match(ba.prompt, /@designer is answering at the same time as you/)
  assert.doesNotMatch(h.cli.calls[0].prompt, /answering at the same time/)
})

test('a reply without a control line falls back to its @handles, and says so', async () => {
  const h = harness({
    script: (bot) => (bot === 'lead' ? { chunks: ['please @ba check this'] } : { chunks: ['done', line([])] }),
  })
  assert.equal(await h.run(), 'done')
  assert.ok(h.cli.calls.some((c) => c.bot === 'ba'))
  assert.ok(h.frames.some((f) => f.type === 'log' && /@lead · no control line/.test(String(f.text))))
})

test('maxParallelBots = 1 runs the round one at a time', async () => {
  const t = normalizeTeam({ ...starterTeam(), policy: { ...starterTeam().policy, maxParallelBots: 1 } })
  const h = harness({
    team: t,
    script: (bot, n) =>
      bot === 'lead' && n === 1 ? { chunks: ['go', line(['ba', 'designer'])] } : { chunks: ['a', 'b', line([])], delay: 30 },
  })
  await h.run()
  const [a, b] = h.cli.calls.filter((c) => c.bot === 'ba' || c.bot === 'designer')
  assert.ok(a.end <= b.start, 'sequential')
})

test('one bot failing mid-round: saved as failed, the others carry on, exchange is done', async () => {
  const h = harness({
    script: (bot, n) =>
      bot === 'lead' && n === 1
        ? { chunks: ['go', line(['ba', 'designer', 'critic'])] }
        : bot === 'designer'
          ? { chunks: ['Not logged in'], isError: true }
          : { chunks: [`${bot} ok`, line([])] },
  })
  assert.equal(await h.run(), 'done')
  const d = h.chat.messages.find((m) => (m.bot as { id?: string } | undefined)?.id === 'designer')!
  assert.equal(d.error, true)
  assert.ok(h.frames.some((f) => f.type === 'log' && f.level === 'error' && /Designer's reply failed/.test(String(f.text))))
  // The failure calls nobody, and the coordinator still reports on the two that answered.
  const report = h.cli.calls.filter((c) => c.bot === 'lead')[1]
  assert.match(report.prompt, /\(@ba, @critic\) have answered/)
  assert.ok(!h.frames.some((f) => f.type === 'error'))
})

test('nobody answering at all ends the exchange with an error', async () => {
  const h = harness({ script: () => ({ chunks: [], isError: true }) })
  assert.equal(await h.run(), 'error')
  const err = h.frames.find((f) => f.type === 'error')!
  assert.match(String(err.error), /The AI team could not answer: Lead returned nothing/)
  assert.equal(h.chat.messages[0].role, 'user')
  assert.equal(h.chat.messages[1].error, true)
})

test('a throwing runner becomes that bot\'s failure, not a crash of the round', async () => {
  const h = harness({
    script: (bot, n) =>
      bot === 'lead' && n === 1
        ? { chunks: ['go', line(['ba', 'designer'])] }
        : bot === 'ba'
          ? { throws: 'spawn EACCES' }
          : { chunks: ['fine', line([])] },
  })
  assert.equal(await h.run(), 'done')
  const ba = h.chat.messages.find((m) => (m.bot as { id?: string } | undefined)?.id === 'ba')!
  assert.equal(ba.error, true)
  assert.match(String(ba.text), /spawn EACCES/)
  assert.ok(h.chat.messages.some((m) => (m.bot as { id?: string } | undefined)?.id === 'designer' && !m.error))
})

test('Stop in the middle of a parallel round: every partial kept, ONE stopped frame', async () => {
  const h = harness({
    abortAfterMs: 150,
    script: (bot, n) =>
      bot === 'lead' && n === 1
        ? { chunks: ['go', line(['ba', 'designer', 'critic'])] }
        : { chunks: Array.from({ length: 40 }, (_, i) => `${bot}${i} `), delay: 20 },
  })
  assert.equal(await h.run(), 'stopped')
  assert.equal(h.frames.filter((f) => f.type === 'stopped').length, 1)
  assert.ok(!h.frames.some((f) => f.type === 'done' || f.type === 'error'))
  const partials = h.chat.messages.filter((m) => ['ba', 'designer', 'critic'].includes(String((m.bot as { id?: string } | undefined)?.id)))
  assert.equal(partials.length, 3)
  for (const p of partials) assert.equal(p.error, true)
  assert.equal(h.turn.speakers!.size, 0)
})

test('Stop before anyone spoke leaves nothing behind', async () => {
  const h = harness({ abortAfterMs: 20, script: () => ({ chunks: ['a', 'b', 'c'], delay: 50 }) })
  assert.equal(await h.run(), 'stopped')
  assert.equal(h.chat.messages.length, 0)
  const st = h.frames.find((f) => f.type === 'stopped')!
  assert.equal(st.chat, undefined)
})

test('the round cap cuts a ping-pong off and the coordinator closes with call = []', async () => {
  const t = normalizeTeam({ ...starterTeam(), policy: { ...starterTeam().policy, maxRounds: 3 } })
  const h = harness({
    team: t,
    script: (bot, _n, prompt) =>
      /round limit/.test(prompt) ? { chunks: ['Wrapping up.', line([])] } : { chunks: ['over to you', line([bot === 'lead' ? 'ba' : 'lead'])] },
  })
  assert.equal(await h.run(), 'done')
  assert.ok(h.frames.some((f) => f.type === 'log' && /reached its limit \(3 rounds/.test(String(f.text))))
  const last = h.cli.calls.at(-1)!
  assert.equal(last.bot, 'lead')
  assert.match(last.prompt, /"call" must stay \[\]/)
  assert.equal(h.cli.calls.length, 4) // 3 rounds + closing
})

test('askHuman routes the next unaddressed reply back — and that reply is the approval', async () => {
  const first = harness({
    tools: 'full',
    prompt: '@reporter draft it',
    script: () => ({ chunks: ['Draft ready. May I file it?', line([], true)] }),
  })
  await first.run()
  assert.equal((first.chat.messages[1] as { asksHuman?: boolean }).asksHuman, true)

  const second = harness({
    tools: 'full',
    prompt: 'yes, go ahead',
    messages: first.chat.messages,
    script: () => ({ chunks: ['Filed.', line([])] }),
  })
  await second.run()
  assert.equal(second.cli.calls[0].bot, 'reporter')
  assert.ok(second.frames.some((f) => f.type === 'log' && /Your reply goes to @reporter/.test(String(f.text))))
  // Direct → no tracker lock, no edit lock.
  assert.ok(!second.cli.calls[0].args.includes('--strict-mcp-config'))
  assert.ok(!second.cli.calls[0].args.includes('--disallowedTools'))
})

test('a bot the human did not address runs with the tracker removed and edits denied', async () => {
  const h = harness({
    tools: 'full',
    script: (bot, n) => (bot === 'lead' && n === 1 ? { chunks: ['go', line(['tester'])] } : { chunks: ['ok', line([])] }),
  })
  await h.run()
  const tester = h.cli.calls.find((c) => c.bot === 'tester')!
  const i = tester.args.indexOf('--mcp-config')
  assert.ok(i >= 0 && tester.args.includes('--strict-mcp-config'))
  assert.ok(tester.args.includes('--disallowedTools'))
  // The per-reply config file is gone once the reply is.
  assert.equal(fs.existsSync(tester.args[i + 1]), false)
  assert.match(tester.prompt, /EXCEPT the issue tracker/)
})

test('the + action reaches only the bots the human addressed in round one', async () => {
  const h = harness({
    action: 'diagram',
    script: (bot, n) => (bot === 'lead' && n === 1 ? { chunks: ['go', line(['critic'])] } : { chunks: ['ok', line([])] }),
  })
  await h.run()
  assert.match(h.cli.calls[0].prompt, /ACTION-BLOCK-diagram/)
  assert.doesNotMatch(h.cli.calls.find((c) => c.bot === 'critic')!.prompt, /ACTION-BLOCK/)
})

test('what one bot READ is handed to the next as current content', async () => {
  let rootSeen = ''
  const h = harness({
    script: (bot, n) => {
      if (bot === 'lead' && n === 1) {
        return { tools: [{ name: 'Read', path: path.join(rootSeen, 'testing/t.md') }], chunks: ['read it', line(['ba'])] }
      }
      return { chunks: ['ok', line([])] }
    },
  })
  rootSeen = h.root
  fs.mkdirSync(path.join(h.root, 'testing'), { recursive: true })
  fs.writeFileSync(path.join(h.root, 'testing/t.md'), 'THE TICKET TEXT')
  await h.run()
  assert.deepEqual((h.chat as { teamFiles?: string[] }).teamFiles, ['testing/t.md'])
  const ba = h.cli.calls.find((c) => c.bot === 'ba')!
  assert.match(ba.prompt, /FILES THE TEAM ALREADY READ/)
  assert.match(ba.prompt, /THE TICKET TEXT/)
  assert.match(ba.prompt, /"readBy":"@lead"/)
})

test('rescue after a throw between speakers does not duplicate a saved reply', async () => {
  const h = harness({ script: () => ({ chunks: ['hello', line([])] }) })
  await h.run()
  const before = h.chat.messages.length
  // The rescue hook is cleared at `done`.
  h.rescue()('boom')
  assert.equal(h.chat.messages.length, before)
})

test('a chat with only the Analyst: it answers, sees only itself, and cannot call outsiders', async () => {
  const h = harness({
    members: ['ba'],
    prompt: 'what is missing in the ACs?',
    script: () => ({ chunks: ['Two gaps.', line(['tester', 'lead'])] }),
  })
  assert.equal(await h.run(), 'done')
  // No coordinator in this chat → the only member answers; its calls to non-members drop.
  assert.deepEqual(h.cli.calls.map((c) => c.bot), ['ba'])
  const roster = JSON.parse(/THE TEAM \(JSON\):\n(.*)/.exec(h.cli.calls[0].prompt)![1])
  assert.deepEqual(roster.map((r: { handle: string }) => r.handle), ['@ba'])
  // Calling nobody stores no `teamCalls` at all (the transcript keeps only what happened).
  assert.equal((h.chat.messages[1] as { teamCalls?: string[] }).teamCalls, undefined)
  assert.deepEqual(h.chat.team.members, ['ba'])
})

test('typing a handle in a partial chat brings that bot in', async () => {
  const h = harness({
    members: ['ba'],
    prompt: '@tester can you run it?',
    script: () => ({ chunks: ['On it.', line([])] }),
  })
  await h.run()
  assert.deepEqual(h.chat.team.members, ['ba', 'tester'])
  assert.deepEqual(h.cli.calls.map((c) => c.bot), ['tester'])
  assert.ok(h.frames.some((f) => f.type === 'log' && /@tester joined this chat/.test(String(f.text))))
})

test('a partial chat whose only member is turned off says so', async () => {
  const t = normalizeTeam({ ...starterTeam(), bots: starterTeam().bots.map((b) => (b.id === 'ba' ? { ...b, enabled: false } : b)) })
  const h = harness({ team: t, members: ['ba'], prompt: 'hi', script: () => ({ chunks: ['x', line([])] }) })
  assert.equal(await h.run(), 'error')
  assert.match(String(h.frames.find((f) => f.type === 'error')!.error), /None of the bots in this chat \(@ba\) is active/)
  assert.equal(h.cli.calls.length, 0)
})
