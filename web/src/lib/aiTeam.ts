/**
 * AI Team: the vocabulary the page draws from — what each role, capability, relation and
 * autonomy level MEANS, in words a QC engineer reads — and `teamWarnings`, which reads the
 * org chart for the structural mistakes that would make a real mission go wrong (nobody
 * coordinating, a tester whose bugs nobody verifies, filing without approval).
 *
 * Kept out of the page so the future mission runner and the chat `@bot` picker describe a
 * bot with the same words the team page does.
 */
import {
  BadgeCheck,
  Bot,
  ClipboardList,
  Crown,
  FileText,
  Palette,
  TestTube2,
  type LucideIcon,
} from 'lucide-react'
import type {
  AiTeam,
  ApprovalAction,
  BotAutonomy,
  BotCapability,
  BotModel,
  BotRole,
  TeamBot,
  TeamLinkKind,
} from '@/lib/api'

export interface RoleMeta {
  label: string
  icon: LucideIcon
  /** One line: why a team has this role. */
  blurb: string
  /** Capabilities a new bot of this role starts with. */
  defaults: BotCapability[]
}

export const ROLES: Record<BotRole, RoleMeta> = {
  lead: {
    label: 'Lead',
    icon: Crown,
    blurb: 'Plans, assigns and makes the final call.',
    defaults: ['read-project', 'plan-work', 'write-reports'],
  },
  analyst: {
    label: 'Analyst',
    icon: ClipboardList,
    blurb: 'Turns tickets into clear, testable criteria.',
    defaults: ['read-project', 'query-database'],
  },
  tester: {
    label: 'Tester',
    icon: TestTube2,
    blurb: 'Runs tests on real browsers and devices.',
    defaults: ['read-project', 'run-tests', 'drive-browser'],
  },
  critic: {
    label: 'Critic',
    icon: BadgeCheck,
    blurb: 'Reproduces findings independently before they count.',
    defaults: ['read-project', 'drive-browser'],
  },
  designer: {
    label: 'Designer',
    icon: Palette,
    blurb: 'Checks the UI against the design and devices.',
    defaults: ['read-project', 'drive-browser', 'design-check'],
  },
  reporter: {
    label: 'Reporter',
    icon: FileText,
    blurb: 'Writes bugs and reports for a human to send.',
    defaults: ['read-project', 'draft-bugs', 'write-reports'],
  },
  custom: {
    label: 'Custom',
    icon: Bot,
    blurb: 'A role you define in its instructions.',
    defaults: ['read-project'],
  },
}

export const ROLE_ORDER: BotRole[] = ['lead', 'analyst', 'tester', 'critic', 'designer', 'reporter', 'custom']

export const CAPABILITIES: Record<BotCapability, { label: string; hint: string; external?: boolean }> = {
  'read-project': { label: 'Read project', hint: 'Tickets, test cases, knowledge, source map' },
  'plan-work': { label: 'Plan & assign', hint: 'Break a goal into tasks and hand them out' },
  'run-tests': { label: 'Run tests', hint: 'Start QC runs from test cases' },
  'drive-browser': { label: 'Drive browser', hint: 'Control a browser like a user' },
  'drive-mobile': { label: 'Drive mobile', hint: 'Control a device or emulator via Maestro' },
  'query-database': { label: 'Query database', hint: 'Read-only SQL on connected databases' },
  'design-check': { label: 'Design check', hint: 'Compare screens with Figma and devices' },
  'draft-bugs': { label: 'Draft bugs', hint: 'Write bug reports without sending them' },
  'file-bugs': { label: 'File bugs', hint: 'Create issues in ClickUp / Jira', external: true },
  'write-reports': { label: 'Write reports', hint: 'Status reports and release verdicts' },
}

export const CAPABILITY_ORDER = Object.keys(CAPABILITIES) as BotCapability[]

export interface LinkMeta {
  label: string
  /** Reads between two names: "Lead coordinates Tester". */
  verb: string
  blurb: string
  /** CSS colour for the line — a token/palette variable, never a raw hex. */
  stroke: string
  dash?: string
  animated?: boolean
  swatch: string
}

export const LINK_KINDS: Record<TeamLinkKind, LinkMeta> = {
  coordinates: {
    label: 'Coordinates',
    verb: 'coordinates',
    blurb: 'Assigns work and expects results back.',
    stroke: 'var(--foreground)',
    animated: true,
    swatch: 'bg-foreground',
  },
  reviews: {
    label: 'Verifies',
    verb: 'verifies the work of',
    blurb: 'Re-checks findings before they count.',
    stroke: 'var(--color-amber-500)',
    dash: '6 4',
    swatch: 'bg-amber-500',
  },
  'hands-off': {
    label: 'Hands off to',
    verb: 'hands off to',
    blurb: 'Passes its output on as the next step’s input.',
    stroke: 'var(--color-emerald-500)',
    swatch: 'bg-emerald-500',
  },
  consults: {
    label: 'Consults',
    verb: 'consults',
    blurb: 'Asks for an opinion; no work changes hands.',
    stroke: 'var(--muted-foreground)',
    dash: '2 4',
    swatch: 'bg-muted-foreground',
  },
}

export const LINK_ORDER: TeamLinkKind[] = ['coordinates', 'reviews', 'hands-off', 'consults']

export const AUTONOMY: Record<BotAutonomy, { label: string; hint: string }> = {
  ask: { label: 'Ask first', hint: 'Proposes every step and waits for a yes.' },
  suggest: { label: 'Suggest', hint: 'Works on its own, asks before anything that matters.' },
  act: { label: 'Act', hint: 'Works on its own inside its capabilities and the team rules.' },
}

export const MODELS: Record<BotModel, { label: string; hint: string }> = {
  haiku: { label: 'Haiku', hint: 'Fast and cheap — drafting, formatting' },
  sonnet: { label: 'Sonnet', hint: 'Balanced — most hands-on work' },
  opus: { label: 'Opus', hint: 'Deepest reasoning — planning, verification' },
}

export const APPROVALS: Record<ApprovalAction, string> = {
  'file-bugs': 'Filing bugs',
  'comment-tickets': 'Commenting on tickets',
  'change-ticket-status': 'Changing ticket status',
  'edit-files': 'Editing project files',
}

/** `"QA Lead #2"` -> `"qa-lead-2"`, the same rule the server applies. */
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

/**
 * Handles no bot may take, because each already means something in a team chat:
 * `@team-ai` brings the whole team in, `@human` is how a bot asks the engineer. Mirrors
 * `RESERVED_HANDLES` in server/src/aiTeamStore.ts (which renames one found on disk).
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set(['team-ai', 'human'])

export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken, ...RESERVED_HANDLES])
  const root = botSlug(base) || 'bot'
  if (!used.has(root)) return root
  for (let i = 2; ; i++) if (!used.has(`${root}-${i}`)) return `${root}-${i}`
}

export interface TeamWarning {
  level: 'error' | 'warning'
  text: string
  botId?: string
}

/**
 * Structural problems in the org chart. Each one is something that would visibly go
 * wrong the first time the team ran a mission — not style advice.
 */
export function teamWarnings(team: AiTeam): TeamWarning[] {
  const out: TeamWarning[] = []
  const active = team.bots.filter((b) => b.enabled)
  const byId = new Map(team.bots.map((b) => [b.id, b]))
  const links = team.links.filter((l) => byId.get(l.from)?.enabled && byId.get(l.to)?.enabled)

  if (active.length === 0) {
    out.push({ level: 'error', text: 'Every bot is disabled — the team cannot take any work.' })
    return out
  }
  if (!team.coordinatorId) {
    out.push({ level: 'error', text: 'Nobody coordinates. Pick a coordinator, or a mission has no one to plan it.' })
  }

  const coordinator = team.coordinatorId
  for (const b of active) {
    if (b.id === coordinator) continue
    const assigned = links.some((l) => l.kind === 'coordinates' && l.to === b.id)
    const connected = links.some((l) => l.from === b.id || l.to === b.id)
    if (!connected) {
      out.push({ level: 'warning', botId: b.id, text: `@${b.id} has no relations — it would never be given or pass on work.` })
    } else if (!assigned) {
      out.push({ level: 'warning', botId: b.id, text: `Nobody coordinates @${b.id}, so it is never assigned work.` })
    }
  }

  // A tester's bugs are only trustworthy once someone else reproduced them.
  if (team.policy.crossVerifyBugs) {
    for (const b of active.filter((x) => x.capabilities.includes('run-tests') || x.role === 'tester')) {
      if (!links.some((l) => l.kind === 'reviews' && l.to === b.id)) {
        out.push({
          level: 'warning',
          botId: b.id,
          text: `Cross-verification is on, but nobody verifies @${b.id} — its bugs could never be confirmed.`,
        })
      }
    }
  }

  for (const b of active) {
    if (b.capabilities.includes('file-bugs') && !team.policy.requireApprovalFor.includes('file-bugs') && b.autonomy === 'act') {
      out.push({
        level: 'error',
        botId: b.id,
        text: `@${b.id} can file bugs on its own with no human approval. Require approval, or lower its autonomy.`,
      })
    }
  }

  // Coordination must be a tree-ish chain of command, never a loop.
  const assigns = new Map<string, string[]>()
  for (const l of links.filter((x) => x.kind === 'coordinates')) {
    assigns.set(l.from, [...(assigns.get(l.from) ?? []), l.to])
  }
  const state = new Map<string, 1 | 2>()
  let loop: string | null = null
  const visit = (id: string) => {
    if (loop) return
    state.set(id, 1)
    for (const next of assigns.get(id) ?? []) {
      if (state.get(next) === 1) loop = next
      else if (!state.has(next)) visit(next)
    }
    state.set(id, 2)
  }
  for (const id of assigns.keys()) if (!state.has(id)) visit(id)
  if (loop) {
    out.push({ level: 'error', botId: loop, text: `Coordination loops back through @${loop} — two bots would keep assigning work to each other.` })
  }

  return out
}

export function newBot(role: BotRole, team: AiTeam, position: { x: number; y: number }): TeamBot {
  const meta = ROLES[role]
  const id = uniqueSlug(meta.label, team.bots.map((b) => b.id))
  const count = team.bots.filter((b) => b.role === role).length
  return {
    id,
    name: count ? `${meta.label} ${count + 1}` : meta.label,
    role,
    mission: meta.blurb,
    instructions: '',
    model: role === 'lead' || role === 'critic' ? 'opus' : role === 'reporter' ? 'haiku' : 'sonnet',
    autonomy: role === 'reporter' ? 'ask' : 'suggest',
    capabilities: [...meta.defaults],
    maxParallel: 1,
    enabled: true,
    position,
  }
}

/** Who this bot works for, and whom it directs — the two questions the inspector answers first. */
export function relationsOf(team: AiTeam, botId: string) {
  const name = (id: string) => team.bots.find((b) => b.id === id)
  return {
    outgoing: team.links.filter((l) => l.from === botId).map((l) => ({ link: l, other: name(l.to) })),
    incoming: team.links.filter((l) => l.to === botId).map((l) => ({ link: l, other: name(l.from) })),
  }
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${+(n / 1_000).toFixed(0)}K`
  return String(n)
}
