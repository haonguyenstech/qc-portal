/**
 * MCP page: the "Add server" dialog's two halves — a catalog of ready-made server
 * templates, and a parser for whatever an engineer pastes out of a README.
 *
 * Nothing here is machine-specific (see "Never put a machine-specific path in the
 * web bundle" in CLAUDE.md): a template that needs a folder asks for it, and the page
 * prefills it from the ACTIVE project's root at runtime, never from this file.
 */
import {
  Bug,
  Cloud,
  Database,
  Figma,
  FileSearch,
  FolderOpen,
  GitBranch,
  GitMerge,
  Globe,
  Library,
  ListChecks,
  MonitorPlay,
  MousePointerClick,
  NotebookText,
  Search,
  Smartphone,
  SquareKanban,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import type { McpEntryInput } from './api'

export interface McpTemplateField {
  /** `{{KEY}}` anywhere in the template entry is replaced by this field's value. */
  key: string
  label: string
  placeholder?: string
  secret?: boolean
  /** An empty optional field drops every arg / env var / header that mentions it. */
  optional?: boolean
  hint?: string
  /** `project-root`: prefilled with the active project's folder by the page. */
  prefill?: 'project-root'
  /** A yes/no option (value 'true' / ''), drawn as a checkbox. */
  kind?: 'checkbox'
}

/** The portal's own servers — each has a dedicated connect call, not a plain import. */
export type BuiltinMcp = 'clickup' | 'figma' | 'jira' | 'azure' | 'playwright' | 'maestro'

export interface McpTemplate {
  id: string
  /** Default server name written into .mcp.json (editable before adding). */
  name: string
  label: string
  blurb: string
  category: string
  icon: LucideIcon
  entry: McpEntryInput
  fields: McpTemplateField[]
  docsUrl: string
  /** Runs through `uvx` — the page's uv warning applies. */
  needsUv?: boolean
  /**
   * A built-in: connected through its own route (token verified, Playwright's
   * machine-specific profile and Maestro's JDK resolved SERVER-side), and its name is
   * fixed — the portal finds it by that name. `entry` is unused for these.
   */
  builtin?: BuiltinMcp
}

export const MCP_TEMPLATE_CATEGORIES = ['QC essentials', 'Sign in (OAuth)', 'Code & docs', 'Browser & web', 'Data', 'Monitoring', 'Productivity']

/**
 * Hosted servers that use OAuth: added as a bare `{type:'http', url}` and signed in to
 * from the page (`claude mcp login`), so no token is ever typed or stored in .mcp.json.
 * Every URL here was probed with `claude mcp login` and returned a real authorize page.
 * The ClickUp/Figma names are deliberately NOT `clickup`/`figma`: those are the token
 * built-ins that ticket crawling and the tracker checks read their token from.
 */
function oauthTemplate(
  id: string,
  label: string,
  blurb: string,
  icon: LucideIcon,
  url: string,
  docsUrl: string,
): McpTemplate {
  return {
    id,
    name: id,
    label,
    blurb,
    category: 'Sign in (OAuth)',
    icon,
    entry: { type: 'http', url },
    fields: [],
    docsUrl,
  }
}

const OAUTH_TEMPLATES: McpTemplate[] = [
  oauthTemplate(
    'clickup-oauth',
    'ClickUp (sign in)',
    'ClickUp’s hosted server — sign in with your account, no token. It asks again daily.',
    ListChecks,
    'https://mcp.clickup.com/mcp',
    'https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server',
  ),
  oauthTemplate(
    'figma-oauth',
    'Figma (sign in)',
    'Figma’s hosted server — read designs to compare against the build, no token.',
    Figma,
    'https://mcp.figma.com/mcp',
    'https://developers.figma.com/docs/figma-mcp-server/',
  ),
  oauthTemplate(
    'linear',
    'Linear',
    'Issues, projects and cycles in Linear — sign in with your account.',
    SquareKanban,
    'https://mcp.linear.app/mcp',
    'https://linear.app/docs/mcp',
  ),
  oauthTemplate(
    'atlassian',
    'Atlassian (Jira, Confluence)',
    'Jira issues and Confluence pages through Atlassian’s hosted server.',
    SquareKanban,
    'https://mcp.atlassian.com/v1/mcp',
    'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  ),
  oauthTemplate(
    'notion-oauth',
    'Notion (sign in)',
    'Specs and test plans in Notion — sign in instead of sharing pages with a token.',
    NotebookText,
    'https://mcp.notion.com/mcp',
    'https://developers.notion.com/docs/mcp',
  ),
  oauthTemplate(
    'sentry-oauth',
    'Sentry (sign in)',
    'Errors and stack traces behind a bug, through Sentry’s hosted server.',
    Bug,
    'https://mcp.sentry.dev/mcp',
    'https://docs.sentry.io/product/sentry-mcp/',
  ),
]

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: 'clickup',
    name: 'clickup',
    label: 'ClickUp',
    blurb: 'Pull QC tickets, tasks and comments straight from ClickUp.',
    category: 'QC essentials',
    icon: ListChecks,
    entry: {},
    fields: [{ key: 'TOKEN', label: 'API token', placeholder: 'pk_…', secret: true }],
    docsUrl: '/document/mcp-tokens',
    needsUv: true,
    builtin: 'clickup',
  },
  {
    id: 'jira',
    name: 'jira',
    label: 'Jira',
    blurb: 'Pull QC issues, stories and their status from Jira.',
    category: 'QC essentials',
    icon: SquareKanban,
    entry: {},
    fields: [
      { key: 'URL', label: 'Site URL', placeholder: 'https://you.atlassian.net' },
      { key: 'EMAIL', label: 'Account email', placeholder: 'you@company.com' },
      {
        key: 'TOKEN',
        label: 'API token',
        secret: true,
        hint: 'A classic (unscoped) Atlassian API token.',
      },
    ],
    docsUrl: '/document/mcp-tokens',
    needsUv: true,
    builtin: 'jira',
  },
  {
    id: 'azure',
    name: 'azure',
    label: 'Azure DevOps',
    blurb: 'Pull bugs, user stories and tasks from Azure DevOps Boards.',
    category: 'QC essentials',
    icon: Cloud,
    entry: {},
    fields: [
      { key: 'ORG_URL', label: 'Organization URL', placeholder: 'https://dev.azure.com/your-org' },
      { key: 'PROJECT', label: 'Default project (optional)', placeholder: 'e.g. Mobile App', optional: true },
      { key: 'TOKEN', label: 'Personal Access Token', secret: true },
    ],
    docsUrl: '/document/mcp-tokens',
    builtin: 'azure',
  },
  {
    id: 'figma',
    name: 'figma',
    label: 'Figma',
    blurb: 'Open design files so Design Check can compare the UI to the design.',
    category: 'QC essentials',
    icon: Figma,
    entry: {},
    fields: [{ key: 'TOKEN', label: 'Personal access token', placeholder: 'figd_…', secret: true }],
    docsUrl: '/document/mcp-tokens',
    builtin: 'figma',
  },
  {
    id: 'playwright',
    name: 'playwright',
    label: 'Playwright',
    blurb: 'Drive a real browser so QC runs can exercise and verify the web app.',
    category: 'QC essentials',
    icon: MousePointerClick,
    entry: {},
    fields: [
      {
        key: 'HEADLESS',
        label: 'Headless (no visible browser window)',
        kind: 'checkbox',
        optional: true,
      },
    ],
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    builtin: 'playwright',
  },
  {
    id: 'maestro',
    name: 'maestro',
    label: 'Maestro',
    blurb: 'Drive an iOS/Android simulator or Chromium, and save runs as YAML flows.',
    category: 'QC essentials',
    icon: Smartphone,
    entry: {},
    fields: [],
    docsUrl: 'https://maestro.dev',
    builtin: 'maestro',
  },
  {
    id: 'github',
    name: 'github',
    label: 'GitHub',
    blurb: 'Repos, PRs, issues and Actions through GitHub’s hosted server.',
    category: 'Code & docs',
    icon: GitBranch,
    entry: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: { Authorization: 'Bearer {{GITHUB_TOKEN}}' },
    },
    fields: [
      {
        key: 'GITHUB_TOKEN',
        label: 'Personal access token',
        placeholder: 'github_pat_…',
        secret: true,
        hint: 'GitHub → Settings → Developer settings → Personal access tokens',
      },
    ],
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'gitlab',
    name: 'gitlab',
    label: 'GitLab',
    blurb: 'Projects, merge requests, issues and files on GitLab.',
    category: 'Code & docs',
    icon: GitMerge,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gitlab'],
      env: {
        GITLAB_PERSONAL_ACCESS_TOKEN: '{{GITLAB_TOKEN}}',
        GITLAB_API_URL: '{{GITLAB_API_URL}}',
      },
    },
    fields: [
      { key: 'GITLAB_TOKEN', label: 'Personal access token', placeholder: 'glpat-…', secret: true },
      {
        key: 'GITLAB_API_URL',
        label: 'API URL (self-hosted only)',
        placeholder: 'https://gitlab.example.com/api/v4',
        optional: true,
      },
    ],
    docsUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-gitlab',
  },
  {
    id: 'context7',
    name: 'context7',
    label: 'Context7',
    blurb: 'Up-to-date library & framework docs, looked up on demand.',
    category: 'Code & docs',
    icon: Library,
    entry: {
      type: 'http',
      url: 'https://mcp.context7.com/mcp',
      headers: { CONTEXT7_API_KEY: '{{CONTEXT7_API_KEY}}' },
    },
    fields: [
      {
        key: 'CONTEXT7_API_KEY',
        label: 'API key (optional)',
        placeholder: 'ctx7sk-…',
        secret: true,
        optional: true,
        hint: 'Works without one; a free key raises the rate limit.',
      },
    ],
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    id: 'chrome-devtools',
    name: 'chrome-devtools',
    label: 'Chrome DevTools',
    blurb: 'Console, network, performance traces and screenshots from a live Chrome.',
    category: 'Browser & web',
    icon: MonitorPlay,
    entry: { type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    fields: [],
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    id: 'fetch',
    name: 'fetch',
    label: 'Fetch',
    blurb: 'Fetch any URL and read it as Markdown — API docs, a public page, a spec.',
    category: 'Browser & web',
    icon: Globe,
    entry: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    fields: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    needsUv: true,
  },
  {
    id: 'brave-search',
    name: 'brave-search',
    label: 'Brave Search',
    blurb: 'Web search results, for checking what a feature should behave like.',
    category: 'Browser & web',
    icon: Search,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@brave/brave-search-mcp-server'],
      env: { BRAVE_API_KEY: '{{BRAVE_API_KEY}}' },
    },
    fields: [{ key: 'BRAVE_API_KEY', label: 'API key', secret: true, hint: 'brave.com/search/api' }],
    docsUrl: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'postgres',
    name: 'postgres',
    label: 'PostgreSQL',
    blurb: 'Read-only SQL against a Postgres database — inspect schema and verify data.',
    category: 'Data',
    icon: Database,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', '{{DATABASE_URL}}'],
    },
    fields: [
      {
        key: 'DATABASE_URL',
        label: 'Connection string',
        placeholder: 'postgresql://user:pass@host:5432/db',
        secret: true,
        hint: 'Use a read-only user — this lands in .mcp.json as plain text.',
      },
    ],
    docsUrl: 'https://www.npmjs.com/package/@modelcontextprotocol/server-postgres',
  },
  {
    id: 'filesystem',
    name: 'filesystem',
    label: 'Filesystem',
    blurb: 'Read and search files in one folder outside the project (logs, exports, fixtures).',
    category: 'Data',
    icon: FolderOpen,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '{{ALLOWED_DIR}}'],
    },
    fields: [
      {
        key: 'ALLOWED_DIR',
        label: 'Allowed folder',
        placeholder: '/path/to/folder',
        prefill: 'project-root',
        hint: 'The server can read and WRITE inside this folder only.',
      },
    ],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'sentry',
    name: 'sentry',
    label: 'Sentry',
    blurb: 'Look up the errors and stack traces behind a reported bug.',
    category: 'Monitoring',
    icon: Bug,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@sentry/mcp-server@latest'],
      env: { SENTRY_ACCESS_TOKEN: '{{SENTRY_TOKEN}}', SENTRY_HOST: '{{SENTRY_HOST}}' },
    },
    fields: [
      { key: 'SENTRY_TOKEN', label: 'User auth token', placeholder: 'sntryu_…', secret: true },
      {
        key: 'SENTRY_HOST',
        label: 'Host (self-hosted only)',
        placeholder: 'sentry.example.com',
        optional: true,
      },
    ],
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    id: 'notion',
    name: 'notion',
    label: 'Notion',
    blurb: 'Read specs, PRDs and test plans kept in Notion pages.',
    category: 'Productivity',
    icon: NotebookText,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@notionhq/notion-mcp-server'],
      env: { NOTION_TOKEN: '{{NOTION_TOKEN}}' },
    },
    fields: [
      {
        key: 'NOTION_TOKEN',
        label: 'Integration token',
        placeholder: 'ntn_…',
        secret: true,
        hint: 'notion.so/profile/integrations — then share the pages with it.',
      },
    ],
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    id: 'sequential-thinking',
    name: 'sequential-thinking',
    label: 'Sequential Thinking',
    blurb: 'A scratchpad tool for step-by-step reasoning on tricky test plans.',
    category: 'Productivity',
    icon: Workflow,
    entry: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    },
    fields: [],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  ...OAUTH_TEMPLATES,
]

/** Icon for a configured server: its template's when the name still matches one. */
export function iconForServer(name: string): LucideIcon {
  return MCP_TEMPLATES.find((t) => t.name === name)?.icon ?? FileSearch
}

/** Same rule the server (and `claude mcp add`) enforces. */
export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Names the portal has its own card for — see BUILTIN_SERVERS in routes/mcp.ts. */
export const BUILTIN_MCP_NAMES = new Set(['clickup', 'figma', 'jira', 'azure', 'playwright', 'maestro'])

/** `base`, or `base-2`, `base-3`… — the first one not in `taken`. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let i = 2; ; i++) if (!set.has(`${base}-${i}`)) return `${base}-${i}`
}

/**
 * The template's entry with `{{KEY}}` replaced by the typed values. A string that
 * mentions an EMPTY field is dropped from its container (the arg, env var or header
 * goes away) — so an optional "self-hosted URL" left blank leaves no half-filled
 * `GITLAB_API_URL=""` behind for the server to choke on.
 */
export function fillTemplate(t: McpTemplate, values: Record<string, string>): McpEntryInput {
  const empty = t.fields.filter((f) => !values[f.key]?.trim()).map((f) => `{{${f.key}}}`)
  const drop = (s: string) => empty.some((token) => s.includes(token))
  const sub = (s: string) =>
    s.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k: string) => values[k]?.trim() ?? '')
  const map = (m?: Record<string, string>) => {
    if (!m) return undefined
    const out = Object.fromEntries(
      Object.entries(m)
        .filter(([, v]) => !drop(v))
        .map(([k, v]) => [k, sub(v)]),
    )
    return Object.keys(out).length ? out : undefined
  }
  const entry: McpEntryInput = { ...t.entry }
  if (t.entry.args) entry.args = t.entry.args.filter((a) => !drop(a)).map(sub)
  if (t.entry.url) entry.url = sub(t.entry.url)
  entry.env = map(t.entry.env)
  entry.headers = map(t.entry.headers)
  if (!entry.env) delete entry.env
  if (!entry.headers) delete entry.headers
  return entry
}

// ---- Paste JSON ------------------------------------------------------------------

export interface ParsedServer {
  /** The name as pasted (or derived, for a bare entry) — the key name edits hang off. */
  name: string
  entry: McpEntryInput
  /** Keys in the pasted entry that .mcp.json doesn't use and were dropped. */
  ignored: string[]
  /** Values that look like a README placeholder ("YOUR_API_KEY", "<token>"). */
  placeholders: string[]
  /** Why this entry can't be added as-is (no command/url, bad url). */
  error?: string
}

export type ParseResult =
  | { ok: true; servers: ParsedServer[]; format: string }
  | { ok: false; error: string }

const ENTRY_KEYS = new Set(['type', 'command', 'args', 'url', 'env', 'headers', 'cwd', 'oauth'])

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function looksLikeEntry(v: unknown): v is Record<string, unknown> {
  return isObj(v) && (typeof v.command === 'string' || typeof v.url === 'string')
}

const PLACEHOLDER_RE = /^<.*>$|^\[.*\]$|your[-_ ]?(api[-_ ]?)?(key|token|secret|pat)|^x{4,}$|^\.\.\.$|^(changeme|replace[-_ ]?me|todo)$/i

function strMap(v: unknown): Record<string, string> | undefined {
  if (!isObj(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val
    else if (typeof val === 'number' || typeof val === 'boolean') out[k] = String(val)
  }
  return Object.keys(out).length ? out : undefined
}

function normalizeEntry(name: string, raw: Record<string, unknown>): ParsedServer {
  const entry: McpEntryInput = {}
  if (typeof raw.type === 'string' && raw.type.trim()) entry.type = raw.type.trim()
  if (typeof raw.command === 'string' && raw.command.trim()) entry.command = raw.command.trim()
  if (Array.isArray(raw.args)) entry.args = raw.args.map((a) => String(a))
  if (typeof raw.url === 'string' && raw.url.trim()) entry.url = raw.url.trim()
  if (typeof raw.cwd === 'string' && raw.cwd.trim()) entry.cwd = raw.cwd.trim()
  const env = strMap(raw.env)
  if (env) entry.env = env
  const headers = strMap(raw.headers)
  if (headers) entry.headers = headers
  // A pre-registered OAuth client (`claude mcp add --client-id … --callback-port …`).
  // Passed through as-is; the server keeps only plain, non-secret values.
  if (entry.url && isObj(raw.oauth)) entry.oauth = raw.oauth as McpEntryInput['oauth']
  // VS Code writes `"type": "sse"`/"http"; Claude Desktop omits it. Default the obvious.
  if (!entry.type) entry.type = entry.url ? 'http' : 'stdio'

  const placeholders = [
    ...Object.entries(entry.env ?? {}),
    ...Object.entries(entry.headers ?? {}),
  ]
    .filter(([, v]) => PLACEHOLDER_RE.test(v.replace(/^Bearer\s+/i, '').trim()))
    .map(([k]) => k)
  for (const a of entry.args ?? []) if (PLACEHOLDER_RE.test(a)) placeholders.push(a)

  let error: string | undefined
  if (!entry.command && !entry.url) error = 'Needs a "command" (stdio) or a "url" (http/sse).'
  else if (entry.url && !/^https?:\/\//i.test(entry.url)) error = 'The url must start with http:// or https://.'

  return {
    name,
    entry,
    ignored: Object.keys(raw).filter((k) => !ENTRY_KEYS.has(k)),
    placeholders,
    error,
  }
}

/** A readable default name for a pasted bare entry: the package, or the url's host. */
function deriveName(raw: Record<string, unknown>): string {
  const clean = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'custom'
  if (typeof raw.url === 'string') {
    try {
      const labels = new URL(raw.url).hostname.split('.').filter((l) => !/^(www|mcp|api)$/.test(l))
      if (labels.length) return clean(labels[0])
    } catch {
      /* fall through */
    }
  }
  const args = Array.isArray(raw.args) ? raw.args.map(String) : []
  const pkg = args.find((a) => !a.startsWith('-'))
  if (pkg) return clean(pkg.replace(/@[^@/]*$/, '').split('/').pop() ?? pkg)
  if (typeof raw.command === 'string') return clean(raw.command.split(/[\\/]/).pop() ?? raw.command)
  return 'custom'
}

/** Split a shell line into words, honouring '…' and "…" quotes. */
function shellWords(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let has = false
  for (const ch of line.replace(/\\\r?\n/g, ' ')) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur)
      cur = ''
      has = false
    } else cur += ch
  }
  if (cur || has) out.push(cur)
  return out
}

/**
 * `claude mcp add [--transport t] [-e K=V] [-H "K: V"] [-s scope] <name> [--] <cmd|url> [args…]`
 * — the form most READMEs now give first.
 */
function parseClaudeAdd(text: string): ParseResult | null {
  const words = shellWords(text.trim())
  const at = words.findIndex((w, i) => w === 'mcp' && words[i + 1] === 'add')
  if (at === -1 || !/claude(\.exe)?$/.test(words[at - 1] ?? '')) return null
  const rest = words.slice(at + 2)
  // Like the CLI: options may sit anywhere BEFORE `--`; after it, every word belongs
  // to the server's own command line.
  const dd = rest.indexOf('--')
  const pre = dd === -1 ? rest : rest.slice(0, dd)
  const post = dd === -1 ? [] : rest.slice(dd + 1)
  const raw: Record<string, unknown> = {}
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  const words2: string[] = []
  for (let i = 0; i < pre.length; i++) {
    const w = pre[i]
    const val = (flag: string) => (w.startsWith(`${flag}=`) ? w.slice(flag.length + 1) : pre[++i] ?? '')
    if (w === '-t' || w === '--transport' || w.startsWith('--transport=')) raw.type = val('--transport')
    else if (w === '-e' || w === '--env' || w.startsWith('--env=')) {
      const kv = val('--env')
      const eq = kv.indexOf('=')
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (w === '-H' || w === '--header' || w.startsWith('--header=')) {
      const kv = val('--header')
      const c = kv.indexOf(':')
      if (c > 0) headers[kv.slice(0, c).trim()] = kv.slice(c + 1).trim()
    } else if (w === '-s' || w === '--scope' || w.startsWith('--scope=')) val('--scope')
    else if (!w.startsWith('-')) words2.push(w)
  }
  const name = words2[0] ?? ''
  const positional = [...words2.slice(1), ...post]
  if (!name || !positional.length) {
    return { ok: false, error: 'Could not read the server name and command from that `claude mcp add` line.' }
  }
  if (/^https?:\/\//i.test(positional[0])) raw.url = positional[0]
  else {
    raw.command = positional[0]
    raw.args = positional.slice(1)
  }
  if (Object.keys(env).length) raw.env = env
  if (Object.keys(headers).length) raw.headers = headers
  return { ok: true, servers: [normalizeEntry(name, raw)], format: 'claude mcp add' }
}

/**
 * Whatever was pasted, as a list of servers. Accepts:
 *  - `.mcp.json` / Claude Desktop: `{ "mcpServers": { name: entry } }`
 *  - VS Code: `{ "servers": { … } }` or `{ "mcp": { "servers": { … } } }`
 *  - a bare map `{ name: entry, … }`
 *  - a single entry `{ "command": …, "args": … }` (named after its package / host)
 *  - a `claude mcp add …` command line
 */
export function parsePastedMcp(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: '' }
  if (!/^[{["]/.test(trimmed)) {
    const cli = parseClaudeAdd(trimmed)
    if (cli) return cli
    return { ok: false, error: 'Paste a JSON config (starting with {) or a `claude mcp add …` command.' }
  }
  let data: unknown
  try {
    // A snippet copied out of a larger file often arrives as `"name": { … }` minus
    // the outer braces — try once more wrapped before giving up.
    data = JSON.parse(trimmed)
  } catch (err) {
    try {
      data = JSON.parse(`{${trimmed.replace(/,\s*$/, '')}}`)
    } catch {
      return { ok: false, error: `Not valid JSON — ${err instanceof Error ? err.message : 'parse error'}` }
    }
  }
  if (!isObj(data)) return { ok: false, error: 'Expected a JSON object.' }

  let map: Record<string, unknown>
  let format = 'server map'
  if (isObj(data.mcpServers)) {
    map = data.mcpServers
    format = '.mcp.json'
  } else if (isObj(data.servers)) {
    map = data.servers
    format = 'VS Code'
  } else if (isObj(data.mcp) && isObj(data.mcp.servers)) {
    map = data.mcp.servers
    format = 'VS Code'
  } else if (looksLikeEntry(data)) {
    return { ok: true, servers: [normalizeEntry(deriveName(data), data)], format: 'single entry' }
  } else {
    map = data
  }

  const servers = Object.entries(map)
    .filter(([, v]) => isObj(v))
    .map(([name, v]) => normalizeEntry(name, v as Record<string, unknown>))
  if (!servers.length) return { ok: false, error: 'No server entries found in that JSON.' }
  return { ok: true, servers, format }
}

/** One-line summary of where a server runs: `npx -y pkg` or its url. */
export function entrySummary(e: { command?: string; args?: string[]; url?: string }): string {
  if (e.url) return e.url
  return [e.command, ...(e.args ?? [])].filter(Boolean).join(' ')
}
