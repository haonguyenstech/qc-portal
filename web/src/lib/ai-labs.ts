/**
 * QC AI Labs — the catalog behind /ai-labs and /ai-labs/:id.
 *
 * A HAND-WRITTEN constant, not an API: there is no vendor feed to fetch, and a curated shelf is
 * only worth reading *because* a human picked the entries. It lives in lib/ so the list page and
 * the detail page read the same data without one importing the other.
 *
 * The `fit` score is an OPINION, and every surface that shows it says so. Don't dress it up as
 * data (no benchmark framing, no decimals, no leaderboard).
 *
 * `install` / `usage` are the point of the detail page: a recommendation nobody can act on is a
 * link dump. Keep every command REAL — each one here was run on a machine before it was written
 * down — and keep a step to one idea.
 */

export type Category =
  | 'Agents & MCP'
  | 'Test data'
  | 'Test design'
  | 'Web automation'
  | 'Mobile'
  | 'API & data'
  | 'Visual & UX'
  | 'Unit & code'

export type Pricing = 'Open source' | 'Free tier' | 'Paid' | 'Enterprise'

export interface LabTool {
  id: string
  name: string
  vendor: string
  /** Two letters for the mark — a logo we don't have and shouldn't fake. */
  monogram: string
  category: Category
  /** One line, in the engineer's language: what it does FOR YOU. */
  pitch: string
  /** Our fit-for-QC score, 0–100. An opinion — labelled as one everywhere it appears. */
  fit: number
  pricing: Pricing
  /** Short capability flags, rendered as chips. Keep to three or fewer per tool. */
  flags: string[]
  /** The longer read, shown on the detail page. */
  what: string
  /** Concrete jobs, not features — this is what makes the shelf worth reading. */
  useCases: string[]
  strengths: string[]
  limits: string[]
  url: string
  /** Already wired into this portal, so it costs nothing to try. */
  inPortal?: boolean
  /** Our own — built by this team, not bought. Worth saying out loud on a shelf of vendors. */
  builtHere?: boolean
  /** What has to be true before step 1 makes sense. */
  requires: string[]
  install: LabStep[]
  usage: LabStep[]
}

/** One numbered step in an install or usage guide. `code` is shown as a copyable command. */
export interface LabStep {
  title: string
  body?: string
  code?: string
}

export const CATALOG: LabTool[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    monogram: 'CC',
    category: 'Agents & MCP',
    pitch:
      'An agent that reads the repo, drives the browser and writes the report — the engine this portal runs on.',
    fit: 96,
    pricing: 'Paid',
    flags: ['Reads your repo', 'MCP host', 'Headless CI'],
    what: 'A terminal-native coding agent that can open files, run commands, drive MCP servers (Playwright, ClickUp, Figma) and produce a written result. QC Portal wraps it: every run, test-case draft and chat answer on this machine is a `claude` process with a project as its working directory.',
    useCases: [
      'Draft manual test cases from a ticket plus the real implementation',
      'Execute an exploratory pass in a browser and write up the findings',
      'Ask why a run failed, with the repo and the run log in scope',
    ],
    strengths: [
      'Sees the actual code, so cases use real field names and validation',
      'Anything you can script, it can run — no vendor-fixed action list',
    ],
    limits: [
      'Needs a repo checkout and a working credential on the machine',
      'A long agentic run costs real tokens — scope the question',
    ],
    requires: ['Node 18+ on your PATH', 'A terminal (macOS, Windows or Linux)'],
    install: [
      {
        title: 'Install the CLI',
        body: 'One global npm package. `claude --version` should answer afterwards — that is the same binary the portal spawns for every run.',
        code: 'npm install -g @anthropic-ai/claude-code',
      },
      {
        title: 'Get the shared credential (this team)',
        body: 'We do not each buy a seat — the company distributes one Claude Code credential through the Auto Agent CLI. `login` signs you in with Microsoft, pulls the credential into your keychain, and leaves a watcher running to keep it fresh.',
        code: 'npm install -g @saigontechnology/auto-agent\nauto-agent-ai login',
      },
      {
        title: 'Check it answers',
        body: 'If this prints a reply you are done. If it fails with an auth error, run `auto-agent-ai login` again — an expired credential is by far the most common cause, and the portal sidebar shows that state before a run hits it.',
        code: 'claude -p "say hi"',
      },
    ],
    usage: [
      {
        title: 'Open it in a project',
        body: 'Run it from the repo root. It reads that project\u2019s CLAUDE.md, so it starts knowing the conventions instead of asking.',
        code: 'cd /path/to/your/project\nclaude',
      },
      {
        title: 'Ask one question, no session',
        body: 'The headless form — this is exactly what QC Portal runs under the hood for a QC run, a test-case draft or a chat answer.',
        code: 'claude -p "which endpoint validates the claim number?"',
      },
      {
        title: 'Or never leave the portal',
        body: 'Chat asks questions about the project, TestCase drafts cases from a ticket, Run executes a QC pass, and Terminal drops you into a live session in the project folder. Same CLI, already pointed at the right repo.',
      },
      {
        title: 'Feed it context once, not every time',
        body: 'Instructions \u2192 CLAUDE.md, Knowledge and Memory are read on every run. Ten minutes there is worth more than a long prompt.',
      },
    ],
    url: 'https://claude.com/product/claude-code',
    inPortal: true,
  },
  {
    id: 'ai-form-filler',
    name: 'AI Form Filler',
    vendor: 'Built in-house · Chrome extension',
    monogram: 'AF',
    category: 'Test data',
    pitch:
      'One click fills every field on the page with realistic, coherent data — no API key, no backend.',
    fit: 90,
    pricing: 'Open source',
    flags: ['Chrome MV3', 'No API key', 'Handles Radix / shadcn'],
    what: 'A Manifest V3 Chrome extension that reads every form field on the current page — climbing the DOM for the real label rather than reporting "field 3" — asks a free AI model for coherent values, and fills them. It drives what a plain autofill silently skips: shadcn/Radix Selects, react-day-picker calendars, comboboxes with async options, checkboxes and radios. The fill runs from the page’s MAIN world, because synthetic clicks from an isolated content script don’t reliably move those widgets. A Preview step lets you edit each value before it lands, Undo puts the form back, and saved instructions ("fill as a 30-year-old engineer from Vietnam") make a persona one click away.',
    useCases: [
      'Fill a 40-field claim form in one click instead of typing dummy data',
      'Re-run the same flow as a different persona from a saved instruction',
      'Get data that agrees with itself — name, DOB and address — not "asdf" everywhere',
      'Reach a validation or a later step fast, when the form is just the doorway',
    ],
    strengths: [
      'Free and keyless out of the box — nothing to install behind it',
      'Fills Radix/shadcn widgets that defeat browser autofill',
      'Preview and Undo, so a wrong fill costs one click, not a page reload',
    ],
    limits: [
      'Field labels and your instruction go to the chosen AI provider',
      'Password and file inputs are skipped by design',
      'Free models vary in latency — switch to a fast one if a fill hangs',
    ],
    requires: ['Chrome or any Chromium browser (Edge, Brave)', 'Git — or download the repo as a ZIP'],
    install: [
      {
        title: 'Get the code',
        body: 'There is no Web Store listing — it installs unpacked, which also means you can read exactly what it does.',
        code: 'git clone https://github.com/haonguyenstech/ai-form-filler.git',
      },
      {
        title: 'Open the extensions page',
        body: 'Paste this into the address bar, then turn on **Developer mode** with the toggle in the top-right corner.',
        code: 'chrome://extensions',
      },
      {
        title: 'Load unpacked',
        body: 'Click **Load unpacked** and pick the folder you just cloned. The sparkle icon appears in the toolbar — pin it if you want the keyboard shortcut handy.',
      },
      {
        title: 'Nothing else to configure',
        body: 'It ships pointed at a free, keyless provider (OpenCode Zen), so there is no API key, no account and no local server. Settings \u2192 **Test connection** confirms it in one click.',
      },
    ],
    usage: [
      {
        title: 'Fill the whole form',
        body: 'Open any page with a form and click the floating bubble at the bottom-right (or press \u2318/Ctrl+Shift+F), then **Analyze & Fill Form**. It reads the real labels, asks for coherent values, fills every field and gets out of the way.',
      },
      {
        title: 'Check before it lands',
        body: 'Turn on **Preview** to review and edit each value first. If a fill goes wrong, **Undo** puts the form back — no reload, no retyping.',
      },
      {
        title: 'Just one field',
        body: 'Focus a field and click the \u2728 icon that appears on it. Useful when the rest of the form is already the way you want it.',
      },
      {
        title: 'Test as a persona',
        body: 'The **Instructions** tab stores reusable prompts — "fill as a 30-year-old engineer from Vietnam", "use an expired card". Star one and it pre-fills on every new page, which is how you re-run the same flow as a different user.',
      },
      {
        title: 'If a fill hangs',
        body: 'Free models vary in latency. In **Settings**, switch the Model dropdown to one marked fast (laguna, ling, longcat) and try again.',
      },
    ],
    url: 'https://github.com/haonguyenstech/ai-form-filler',
    builtHere: true,
  },
]

export function findTool(id: string | undefined): LabTool | null {
  return CATALOG.find((t) => t.id === id) ?? null
}
