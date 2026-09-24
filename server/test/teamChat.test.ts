import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { normalizeTeam, starterTeam } from '../src/aiTeamStore.ts'
import {
  DirectiveFilter,
  addressees,
  botGuards,
  botPrompt,
  disabledNamed,
  earlierMaterial,
  joinChatTeam,
  mentionsTeam,
  parseDirective,
  pendingAskers,
  resolveCalls,
  runPool,
  scopeTeam,
  threadFrom,
} from '../src/teamChat.ts'
import { knownFilesBlock, rememberFile, shareablePath } from '../src/teamFiles.ts'

// The pure half of the AI team: routing, the control line, guards, the thread, the store.
// Run with `npm -w server test`.

const team = starterTeam()
const lead = (id = 'lead') => ({ id, name: 'Lead', role: 'lead' })

test('handles: whole words, never in code, email or a longer handle', () => {
  assert.deepEqual(addressees('type `@tester` to call, and @ba please', team, 'lead'), ['ba'])
  assert.deepEqual(addressees('```\n@critic\n```', team), [])
  assert.deepEqual(addressees('mail me a@tester.com', team), [])
  assert.deepEqual(addressees('@tester-2 no', team), [])
  assert.equal(mentionsTeam('hi @team-ai'), true)
  assert.equal(mentionsTeam('hi @team-ai-x'), false)
  assert.equal(mentionsTeam('`@team-ai`'), false)
})

test('parseDirective: strips the line, reads the LAST one, tolerates junk', () => {
  const a = parseDirective('Hello @tester.\n<!--team {"call":["BA","@designer","ba"],"askHuman":true}-->')
  assert.equal(a.text, 'Hello @tester.')
  assert.deepEqual(a.directive, { call: ['ba', 'designer'], askHuman: true })

  const b = parseDirective('x <!--team {"call":["tester"]}--> y <!-- team {"call":[]} -->')
  assert.equal(b.text, 'x  y')
  assert.deepEqual(b.directive, { call: [], askHuman: false })

  const bad = parseDirective('text\n<!--team {call: nope}-->')
  assert.equal(bad.text, 'text')
  assert.equal(bad.directive, null)

  const cut = parseDirective('partial answer\n<!--team {"call":["ba"')
  assert.equal(cut.text, 'partial answer')
  assert.equal(cut.directive, null)

  assert.deepEqual(parseDirective('no line here'), { text: 'no line here', directive: null })
  // An ordinary HTML comment is not a control line.
  assert.equal(parseDirective('a <!-- note --> b').text, 'a <!-- note --> b')
})

test('resolveCalls: enabled bots only, never the speaker, team-ai = everyone else', () => {
  const t2 = normalizeTeam({ ...team, bots: team.bots.map((b) => (b.id === 'designer' ? { ...b, enabled: false } : b)) })
  assert.deepEqual(resolveCalls(['ba', 'designer', 'nobody', 'lead', 'ba'], t2, 'lead'), ['ba'])
  assert.deepEqual(resolveCalls(['team-ai'], t2, 'lead'), ['ba', 'tester', 'critic', 'reporter'])
})

test('DirectiveFilter: the control line never reaches the wire, even split across chunks', () => {
  const run = (chunks: string[]) => {
    const f = new DirectiveFilter()
    return { out: chunks.map((c) => f.push(c)).join(''), full: f.full }
  }
  const text = 'Answer body.\n<!--team {"call":["ba"],"askHuman":false}-->'
  // every possible split point
  for (let i = 1; i < text.length; i++) {
    const r = run([text.slice(0, i), text.slice(i)])
    assert.equal(r.out, 'Answer body.\n', `split at ${i}`)
    assert.equal(r.full, text)
  }
  // char by char
  assert.equal(run([...text]).out, 'Answer body.\n')
  // a held-back "<!-" that turns out to be something else is released
  assert.equal(run(['a <!', '-- note --> b']).out, 'a <!-- note --> b')
  assert.equal(run(['x <', 'b>y']).out, 'x <b>y')
})

test('thread pins the latest question when the window no longer reaches it', () => {
  const msgs: { role: string; text: string; bot?: { id: string; name: string; role: string }; error?: boolean }[] = [
    { role: 'user', text: 'OLD' },
    { role: 'assistant', text: 'a' },
    { role: 'user', text: 'THE QUESTION' },
  ]
  for (let i = 0; i < 25; i++) msgs.push({ role: 'assistant', text: 'r' + i, bot: lead(), ...(i === 24 ? { error: true } : {}) })
  const th = threadFrom(msgs)
  assert.equal(th[0].text, 'THE QUESTION')
  assert.equal(th[0].from, 'human')
  assert.match(th[1].text, /5 earlier replies/)
  assert.equal(th.length, 22)
  assert.equal(th.at(-1)!.failed, true)
  assert.equal(threadFrom(msgs.slice(0, 5))[0].text, 'OLD')
})

test('pendingAskers: the stored flag wins, @human in text is the fallback', () => {
  const R = { id: 'reporter', name: 'R', role: 'reporter' }
  const T = { id: 'tester', name: 'T', role: 'tester' }
  const ex = [
    { role: 'user', text: 'q' },
    { role: 'assistant', text: 'draft ready, ok to file?', bot: R, asksHuman: true },
    { role: 'assistant', text: 'I mention @human but did not ask', bot: T, asksHuman: false },
  ]
  assert.deepEqual(pendingAskers(ex, team), ['reporter'])
  assert.deepEqual(pendingAskers([{ role: 'user', text: 'q' }, { role: 'assistant', text: '@human ok?', bot: T }], team), ['tester'])
  assert.deepEqual(pendingAskers([...ex, { role: 'user', text: 'ok' }], team), [])
  assert.deepEqual(pendingAskers([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'x', bot: R, asksHuman: true, error: true }], team), [])
})

test('guards: direct = approved; approval rules and ask-autonomy lock', () => {
  const rep = team.bots.find((b) => b.id === 'reporter')!
  const tester = team.bots.find((b) => b.id === 'tester')!
  assert.deepEqual(botGuards(team, rep, true), { tracker: false, edits: false })
  assert.deepEqual(botGuards(team, tester, false), { tracker: true, edits: true })
  const open = { ...team, policy: { ...team.policy, requireApprovalFor: [] as never[] } }
  assert.deepEqual(botGuards(open, tester, false), { tracker: false, edits: false })
  assert.deepEqual(botGuards(open, rep, false), { tracker: true, edits: true })
})

test('store: reserved handles renamed, links follow ids as written', () => {
  const t2 = normalizeTeam({ ...team, bots: team.bots.map((b) => (b.id === 'designer' ? { ...b, enabled: false } : b)) })
  assert.deepEqual(disabledNamed('@designer look', t2), ['designer'])
  const t3 = normalizeTeam({
    coordinatorId: 'Team AI',
    bots: [{ id: 'Team AI', name: 'Team AI' }, { id: 'QA Lead', name: 'x' }],
    links: [{ from: 'Team AI', to: 'QA Lead', kind: 'consults' }],
  })
  assert.deepEqual(t3.bots.map((b) => b.id), ['team-ai-bot', 'qa-lead'])
  assert.equal(t3.coordinatorId, 'team-ai-bot')
  assert.equal(t3.links[0].from, 'team-ai-bot')
  assert.equal(normalizeTeam({ bots: [{ id: 'human', name: 'h' }] }).bots[0].id, 'human-bot')
  assert.equal(normalizeTeam(starterTeam()).links.length, starterTeam().links.length)
})

test('earlierMaterial carries attachments, never actions', () => {
  const em = earlierMaterial([
    { role: 'user', text: 'x', context: [{ label: 'Tagged items and picked skills', text: 'TICKET ABC' }, { label: 'Action: diagram', text: 'DRAW' }] },
  ])
  assert.match(em, /TICKET ABC/)
  assert.doesNotMatch(em, /DRAW/)
})

test('prompt: real tools, autonomy, peers, control line', () => {
  const tester = team.bots.find((b) => b.id === 'tester')!
  const base = {
    team, bot: tester, thread: [], calledBy: ['human'], attachments: '', earlier: '', known: '', peers: ['@ba'],
    access: { mode: 'read' as const, chatMode: 'read' as const, mcp: 'all' as const, editsLocked: true, web: false },
    rules: '', round: 1, maxRounds: 6, closing: false as const,
  }
  const p = botPrompt(base)
  assert.match(p, /cannot do that in this reply/)
  assert.match(p, /Editing project files is locked/)
  assert.match(p, /Your autonomy: ACT/)
  assert.match(p, /@ba is answering at the same time/)
  assert.match(p, /<!--team \{"call": \[\], "askHuman": false\}-->/)
  assert.match(p, /calls nobody; only "call" does/)
  assert.match(botPrompt({ ...base, closing: 'cap' }), /"call" must stay \[\]/)
})

test('runPool: bounded concurrency, input order', async () => {
  let inFlight = 0
  let peak = 0
  const t0 = Date.now()
  const res = await runPool([300, 100, 200, 50, 10], 3, async (ms, i) => {
    inFlight++
    peak = Math.max(peak, inFlight)
    await new Promise((r) => setTimeout(r, ms))
    inFlight--
    return i
  })
  assert.deepEqual(res, [0, 1, 2, 3, 4])
  assert.equal(peak, 3)
  assert.ok(Date.now() - t0 < 450)
  assert.deepEqual(await runPool([], 4, async () => 1), [])
})

test('teamFiles: guarded, capped, newest first', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-'))
  fs.mkdirSync(path.join(root, 'testing/tickets/K'), { recursive: true })
  fs.writeFileSync(path.join(root, 'testing/tickets/K/ticket.md'), 'TICKET BODY')
  fs.writeFileSync(path.join(root, '.env'), 'SECRET')
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(20000))
  assert.equal(shareablePath(root, path.join(root, 'testing/tickets/K/ticket.md')), 'testing/tickets/K/ticket.md')
  assert.equal(shareablePath(root, path.join(root, '.env')), null)
  assert.equal(shareablePath(root, '/etc/passwd'), null)
  assert.equal(shareablePath(root, path.join(root, '../x')), null)
  let list: string[] = []
  for (const f of ['a', 'b', 'a']) list = rememberFile(list, f)
  assert.deepEqual(list, ['b', 'a'])
  const kb = JSON.parse(knownFilesBlock(root, ['testing/tickets/K/ticket.md', '.env', 'big.txt', 'missing.md'], new Map([['big.txt', '@lead']])))
  assert.equal(kb.length, 2)
  assert.equal(kb[0].path, 'big.txt')
  assert.equal(kb[0].cut, true)
  assert.equal(kb[0].readBy, '@lead')
  assert.equal(kb[0].content.length, 8000)
  assert.equal(kb[1].content, 'TICKET BODY')
  assert.equal(knownFilesBlock(root, [], new Map()), '')
})

test('joinChatTeam: a picked bot brings only itself; @team-ai brings everyone', () => {
  const now = 'T'
  const ba = joinChatTeam(undefined, { whole: false, bots: ['ba'] }, now)
  assert.deepEqual(ba, { joinedAt: 'T', members: ['ba'] })
  const two = joinChatTeam(ba, { whole: false, bots: ['designer', 'ba'] }, 'T2')
  assert.deepEqual(two, { joinedAt: 'T', members: ['ba', 'designer'] })
  assert.equal(joinChatTeam(two, { whole: false, bots: ['ba'] }, 'T3'), two, 'no change = same object')
  const all = joinChatTeam(two, { whole: true, bots: [] }, 'T4')
  assert.deepEqual(all, { joinedAt: 'T' })
  assert.equal(joinChatTeam(all, { whole: false, bots: ['tester'] }, 'T5'), all, 'whole team already has everyone')
  assert.deepEqual(joinChatTeam(undefined, { whole: true, bots: [] }, 'T'), { joinedAt: 'T' })
  assert.equal(joinChatTeam(undefined, { whole: false, bots: [] }, 'T'), undefined)
  assert.deepEqual(joinChatTeam(undefined, { whole: false, bots: ['../x', 'BA'] }, 'T'), undefined, 'bad handles ignored')
})

test('scopeTeam: members only, their relations, coordinator only if a member', () => {
  const s1 = scopeTeam(team, ['ba', 'tester'])
  assert.deepEqual(s1.bots.map((b) => b.id), ['ba', 'tester'])
  assert.equal(s1.coordinatorId, null)
  assert.ok(s1.links.every((l) => ['ba', 'tester'].includes(l.from) && ['ba', 'tester'].includes(l.to)))
  assert.ok(s1.links.length > 0)
  assert.equal(scopeTeam(team, ['lead', 'ba']).coordinatorId, 'lead')
  assert.equal(scopeTeam(team, undefined), team)
})
