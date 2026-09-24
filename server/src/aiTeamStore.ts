import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

// AI Team: the project's roster of QC bots and how they relate — who coordinates, who
// checks whose work, who hands off to whom. This is the ORGANISATION only: the bots run in
// /chat (teamChat.ts, `runTeamTurn` in routes/chat.ts). It is stored as one JSON document per project
// (`testing/ai-team/team.json`) because the team is project knowledge that should travel
// with the repo, the same as notes and memory.
//
// The document is replaced WHOLE on save (PUT), and `normalizeTeam` is the only gate: an
// unknown role/capability/link kind is dropped rather than stored, a link to a missing
// bot is dropped, and the coordinator must be an existing, enabled bot. Whatever the
// browser sends, what lands on disk is a team the rest of the portal can trust.

export const BOT_ROLES = ['lead', 'analyst', 'tester', 'critic', 'designer', 'reporter', 'custom'] as const
export const BOT_MODELS = ['haiku', 'sonnet', 'opus'] as const
export const BOT_AUTONOMY = ['ask', 'suggest', 'act'] as const
export const BOT_CAPABILITIES = [
  'read-project',
  'plan-work',
  'run-tests',
  'drive-browser',
  'drive-mobile',
  'query-database',
  'design-check',
  'draft-bugs',
  'file-bugs',
  'write-reports',
] as const
export const LINK_KINDS = ['coordinates', 'reviews', 'hands-off', 'consults'] as const
/** Actions that leave the portal. Listed here so a policy can only name real ones. */
export const APPROVAL_ACTIONS = ['file-bugs', 'comment-tickets', 'change-ticket-status', 'edit-files'] as const

/** The token that brings the whole team into a conversation (`@team-ai`). */
export const TEAM_HANDLE = 'team-ai'
/** How a bot asks the human something in chat (`@human`) — the human's next reply goes back to it. */
export const HUMAN_HANDLE = 'human'
/**
 * Handles no bot may take: each already MEANS something in a team chat, so a bot called
 * "Team AI" would be unaddressable and would turn every `@team-ai` into a call to itself.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([TEAM_HANDLE, HUMAN_HANDLE])

export type BotRole = (typeof BOT_ROLES)[number]
export type BotModel = (typeof BOT_MODELS)[number]
export type BotAutonomy = (typeof BOT_AUTONOMY)[number]
export type BotCapability = (typeof BOT_CAPABILITIES)[number]
export type LinkKind = (typeof LINK_KINDS)[number]
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number]

export interface TeamBot {
  /** Slug — also the @handle a bot will answer to. */
  id: string
  name: string
  role: BotRole
  /** One line: what this bot is for. */
  mission: string
  /** The bot's standing instructions (its system prompt, once bots run). */
  instructions: string
  model: BotModel
  autonomy: BotAutonomy
  capabilities: BotCapability[]
  /** How many copies of this bot may work at once (a tester fanning out over devices). */
  maxParallel: number
  enabled: boolean
  position: { x: number; y: number }
}

export interface TeamLink {
  id: string
  from: string
  to: string
  kind: LinkKind
  note: string
}

export interface TeamPolicy {
  /** Most back-and-forth rounds between bots before the coordinator must conclude. */
  maxRounds: number
  /** Most bot copies working at the same time across the whole team. */
  maxParallelBots: number
  /** Token ceiling for one mission; the team stops when it is reached. */
  missionTokenBudget: number
  /** Actions that always wait for a human, whatever a bot's autonomy says. */
  requireApprovalFor: ApprovalAction[]
  /** A bug is only reported once a DIFFERENT bot has reproduced it. */
  crossVerifyBugs: boolean
}

export interface TeamFile {
  version: 1
  coordinatorId: string | null
  bots: TeamBot[]
  links: TeamLink[]
  policy: TeamPolicy
  updatedAt: string
}

const MAX_BOTS = 30
const MAX_LINKS = 200
const MAX_MISSION = 300
const MAX_INSTRUCTIONS = 20_000

const DEFAULT_POLICY: TeamPolicy = {
  maxRounds: 6,
  maxParallelBots: 4,
  missionTokenBudget: 2_000_000,
  requireApprovalFor: ['file-bugs', 'comment-tickets', 'change-ticket-status', 'edit-files'],
  crossVerifyBugs: true,
}

function bot(partial: Omit<TeamBot, 'enabled'> & { enabled?: boolean }): TeamBot {
  return { enabled: true, ...partial }
}

/** The starter squad a project gets on first open, and what "Reset to starter team" restores. */
export function starterTeam(): TeamFile {
  const bots: TeamBot[] = [
    bot({
      id: 'lead',
      name: 'Lead',
      role: 'lead',
      mission: 'Turns a goal into a plan, assigns the work, tracks it and makes the final call.',
      instructions:
        'You coordinate the QC team. Break the goal into concrete tasks, assign each to the bot whose role fits, keep the board current, and conclude with a clear verdict and the evidence behind it. Escalate to the human only when blocked or when an action needs approval.',
      model: 'opus',
      autonomy: 'suggest',
      capabilities: ['read-project', 'plan-work', 'write-reports'],
      maxParallel: 1,
      position: { x: 290, y: 0 },
    }),
    bot({
      id: 'ba',
      name: 'Analyst',
      role: 'analyst',
      mission: 'Reads tickets and specs, finds missing or ambiguous acceptance criteria.',
      instructions:
        'Read the ticket, its acceptance criteria and linked documents. List what is testable, what is ambiguous and what is missing. Never invent a requirement: quote the source for every criterion.',
      model: 'sonnet',
      autonomy: 'suggest',
      capabilities: ['read-project', 'query-database'],
      maxParallel: 1,
      position: { x: 0, y: 220 },
    }),
    bot({
      id: 'tester',
      name: 'Tester',
      role: 'tester',
      mission: 'Executes test cases on real browsers and devices and collects evidence.',
      instructions:
        'Run the assigned test cases exactly as written, like a user would. Capture a screenshot and the visible text for every step. Report what happened, not what should have happened. Never perform a final mutating action on a shared environment.',
      model: 'sonnet',
      autonomy: 'act',
      capabilities: ['read-project', 'run-tests', 'drive-browser', 'drive-mobile'],
      maxParallel: 4,
      position: { x: 290, y: 220 },
    }),
    bot({
      id: 'designer',
      name: 'Designer',
      role: 'designer',
      mission: 'Compares the built UI with the design and checks responsive layouts.',
      instructions:
        'Compare each screen with its Figma frame and the design system. Check the layout on the target devices. Report differences with a screenshot of both sides.',
      model: 'sonnet',
      autonomy: 'act',
      capabilities: ['read-project', 'drive-browser', 'design-check'],
      maxParallel: 2,
      position: { x: 580, y: 220 },
    }),
    bot({
      id: 'critic',
      name: 'Critic',
      role: 'critic',
      mission: 'Tries to disprove every finding by reproducing it independently.',
      instructions:
        'For every reported bug, reproduce it yourself from the steps alone, without reusing the finder’s session. Confirm it, reject it as not reproducible, or flag it as flaky. Challenge any claim that has no evidence.',
      model: 'opus',
      autonomy: 'act',
      capabilities: ['read-project', 'drive-browser', 'query-database'],
      maxParallel: 1,
      position: { x: 145, y: 440 },
    }),
    bot({
      id: 'reporter',
      name: 'Reporter',
      role: 'reporter',
      mission: 'Writes confirmed bugs and the status report, ready for a human to send.',
      instructions:
        'Turn confirmed findings into bug reports with steps, expected, actual, severity and evidence. Check for an existing duplicate first. Draft only: filing waits for human approval.',
      model: 'haiku',
      autonomy: 'ask',
      capabilities: ['read-project', 'draft-bugs', 'file-bugs', 'write-reports'],
      maxParallel: 1,
      position: { x: 435, y: 440 },
    }),
  ]
  const link = (from: string, to: string, kind: LinkKind, note: string): TeamLink => ({
    id: `${from}-${kind}-${to}`,
    from,
    to,
    kind,
    note,
  })
  return {
    version: 1,
    coordinatorId: 'lead',
    bots,
    links: [
      link('lead', 'ba', 'coordinates', 'Assigns tickets to analyse'),
      link('lead', 'tester', 'coordinates', 'Assigns test cases to run'),
      link('lead', 'designer', 'coordinates', 'Assigns screens to check'),
      link('lead', 'reporter', 'coordinates', 'Asks for the report'),
      link('lead', 'critic', 'coordinates', 'Sends findings to verify'),
      link('ba', 'tester', 'hands-off', 'Testable criteria'),
      link('critic', 'tester', 'reviews', 'Reproduces every bug'),
      link('critic', 'designer', 'reviews', 'Double-checks UI findings'),
      link('tester', 'reporter', 'hands-off', 'Confirmed bugs + evidence'),
      link('designer', 'reporter', 'hands-off', 'Confirmed UI issues'),
      link('tester', 'ba', 'consults', 'Unclear expected result'),
    ],
    policy: { ...DEFAULT_POLICY, requireApprovalFor: [...DEFAULT_POLICY.requireApprovalFor] },
    updatedAt: new Date().toISOString(),
  }
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  list.includes(v as T) ? (v as T) : fallback
const subsetOf = <T extends string>(list: readonly T[], v: unknown): T[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => list.includes(x as T)))] : []

/** `"QA Lead #2"` -> `"qa-lead-2"`. The handle a human types after `@`. */
export function botSlug(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** Validate a whole team document. Throws only on a structurally unusable one. */
export function normalizeTeam(raw: unknown): TeamFile {
  if (!raw || typeof raw !== 'object') throw new Error('team must be an object')
  const input = raw as Record<string, unknown>
  if (!Array.isArray(input.bots)) throw new Error('team.bots must be an array')

  const bots: TeamBot[] = []
  const ids = new Set<string>()
  // What each id the document USED became. Links and the coordinator name bots by the id
  // as written, so a hand-edited `"id": "QA Lead"` (stored as `qa-lead`) or a reserved
  // handle renamed below would otherwise lose every relation it has.
  const idMap = new Map<string, string>()
  for (const item of input.bots.slice(0, MAX_BOTS)) {
    if (!item || typeof item !== 'object') continue
    const b = item as Record<string, unknown>
    const name = str(b.name, 60)
    const rawId = str(b.id, 60)
    let id = botSlug(rawId || name)
    if (!id || !name) continue
    if (RESERVED_HANDLES.has(id)) {
      const base = `${id}-bot`
      id = base
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`
    }
    if (ids.has(id)) throw new Error(`two bots share the handle @${id}`)
    ids.add(id)
    idMap.set(id, id)
    if (rawId) idMap.set(rawId, id)
    const pos = (b.position ?? {}) as Record<string, unknown>
    bots.push({
      id,
      name,
      role: oneOf(BOT_ROLES, b.role, 'custom'),
      mission: str(b.mission, MAX_MISSION),
      instructions: typeof b.instructions === 'string' ? b.instructions.slice(0, MAX_INSTRUCTIONS) : '',
      model: oneOf(BOT_MODELS, b.model, 'sonnet'),
      autonomy: oneOf(BOT_AUTONOMY, b.autonomy, 'suggest'),
      capabilities: subsetOf(BOT_CAPABILITIES, b.capabilities),
      maxParallel: clampInt(b.maxParallel, 1, 10, 1),
      enabled: b.enabled !== false,
      position: {
        x: typeof pos.x === 'number' && Number.isFinite(pos.x) ? Math.round(pos.x) : 0,
        y: typeof pos.y === 'number' && Number.isFinite(pos.y) ? Math.round(pos.y) : 0,
      },
    })
  }

  const links: TeamLink[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(input.links) ? input.links.slice(0, MAX_LINKS) : []) {
    if (!item || typeof item !== 'object') continue
    const l = item as Record<string, unknown>
    const from = idMap.get(str(l.from, 60)) ?? ''
    const to = idMap.get(str(l.to, 60)) ?? ''
    const kind = oneOf(LINK_KINDS, l.kind, 'hands-off')
    // A link to a deleted bot, a self-loop, or the same relation twice says nothing.
    if (!from || !to || from === to) continue
    const key = `${from}\0${kind}\0${to}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ id: str(l.id, 120) || `${from}-${kind}-${to}`, from, to, kind, note: str(l.note, 120) })
  }

  const coordinator = idMap.get(str(input.coordinatorId, 60)) ?? ''
  const p = (input.policy ?? {}) as Record<string, unknown>
  return {
    version: 1,
    coordinatorId: bots.some((b) => b.id === coordinator && b.enabled) ? coordinator : null,
    bots,
    links,
    policy: {
      maxRounds: clampInt(p.maxRounds, 1, 50, DEFAULT_POLICY.maxRounds),
      maxParallelBots: clampInt(p.maxParallelBots, 1, 20, DEFAULT_POLICY.maxParallelBots),
      missionTokenBudget: clampInt(p.missionTokenBudget, 10_000, 100_000_000, DEFAULT_POLICY.missionTokenBudget),
      requireApprovalFor: Array.isArray(p.requireApprovalFor)
        ? subsetOf(APPROVAL_ACTIONS, p.requireApprovalFor)
        : [...DEFAULT_POLICY.requireApprovalFor],
      crossVerifyBugs: p.crossVerifyBugs !== false,
    },
    updatedAt: new Date().toISOString(),
  }
}

function teamFile(root: string): string {
  return path.join(testingDirFor(root), 'ai-team', 'team.json')
}

function writeTeam(root: string, team: TeamFile): void {
  const target = teamFile(root)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(team, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, target)
}

/**
 * The project's team. A project that has never opened the page gets the starter squad
 * written to disk; a file that no longer parses is NOT overwritten — the error is thrown
 * so a hand-edit gone wrong is reported instead of silently replaced.
 */
export function readTeam(root: string): TeamFile {
  let text: string
  try {
    text = fs.readFileSync(teamFile(root), 'utf8')
  } catch {
    const team = starterTeam()
    writeTeam(root, team)
    return team
  }
  const parsed = JSON.parse(text) as TeamFile
  const team = normalizeTeam(parsed)
  team.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : team.updatedAt
  return team
}

export function saveTeam(root: string, raw: unknown): TeamFile {
  const team = normalizeTeam(raw)
  writeTeam(root, team)
  return team
}

export function resetTeam(root: string): TeamFile {
  const team = starterTeam()
  writeTeam(root, team)
  return team
}

export function teamFilePath(root: string): string {
  return teamFile(root)
}
