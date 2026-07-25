import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GuideTour, type TourStep } from '@/components/GuideTour'

// Switch a page's shadcn Tabs by clicking the matching trigger, so a step can
// reveal the tab it describes (the panel below actually changes as the tour walks).
function clickTab(name: string) {
  document.querySelector<HTMLElement>(`[data-tour="tab-${name}"]`)?.click()
}

const clickTour = (name: string) =>
  document.querySelector<HTMLElement>(`[data-tour="${name}"]`)?.click()

/**
 * Every step points at ONE element that really exists on the page, anchored by a
 * `data-tour` attribute rather than a generic tag selector. Two rules learned from
 * auditing these tours in the browser:
 *  - A missing target is skipped SILENTLY (GuideTour.resolve), so a step aimed at
 *    markup that never renders simply disappears — the user just gets fewer steps.
 *  - Two steps sharing one selector spotlight the same box twice, so the highlight
 *    appears frozen while the text changes.
 * Keep one distinct, existing anchor per step.
 */
const PAGE_GUIDES: Record<string, TourStep[]> = {
  '/tickets': [
    { selector: '[data-tour="header"]', title: 'Crawl tickets into your project', body: 'Pull work items from your tracker (ClickUp, Jira, or Azure DevOps) and download each one — description, comments, and attachments — into the project so the QC skill can read them offline.', placement: 'bottom' },
    { selector: '[data-tour="dest"]', title: 'Where files land', body: 'Everything downloads into this project’s testing/tickets/ folder. Use Open folder to jump straight to it on your machine.', placement: 'bottom' },
    { selector: '[data-tour="browse"]', title: 'Choose your source', body: 'Switch between connected trackers, pick a workspace or project, or bind this project to a single ClickUp list so you always see the right tickets.', placement: 'bottom' },
    { selector: '[data-tour="search"]', title: 'Find tickets fast', body: 'Search by title or id. Tickets group under sticky status headers, and subtasks expand under their parent via the chevron.', placement: 'bottom' },
    { selector: '[data-tour="list"]', title: 'Pick what to crawl', body: 'Click a ticket to select it (picking a subtask auto-includes its parents). A green Crawled badge means it’s already downloaded; a violet badge counts generated test cases. Hover a row to open it in the tracker or delete its files.', placement: 'top' },
    // The action bar only exists once something is selected, so select the first row
    // for the demo — the step says so, and clicking the row again clears it.
    { selector: '[data-tour="actionbar"]', title: 'Crawl or queue', body: 'This bar appears as soon as tickets are selected (we just picked the first one for you — click it again to clear it). Choose how each ticket is processed — plain download or an AI brief (Haiku/Sonnet/Opus) — then Crawl. Start another batch while one runs and it queues automatically; crawling continues on the server even if you leave the page.', placement: 'top', action: () => document.querySelector<HTMLElement>('[data-tour="list"] button[aria-pressed="false"]')?.click() },
  ],
  '/api-testing': [
    { selector: '[data-tour="header"]', title: 'Test APIs from the portal', body: 'Build repeatable HTTP checks against local, staging, or deployed APIs. The portal proxies requests through its server, so browser CORS restrictions do not prevent you testing localhost or protected environments.', placement: 'bottom' },
    { selector: '[data-tour="import"]', title: 'Start from a real request', body: 'Import a cURL command when you already have a working request, or scan a browser page to discover the APIs it calls. This captures the practical endpoint, method, and request shape before you refine it.', placement: 'bottom' },
    { selector: '[data-tour="request"]', title: 'Define the request target', body: 'Set the method and full URL, including route parameters. Keep environment-specific values in variables or captures where possible so a saved request can be reused safely.', placement: 'bottom' },
    { selector: '[data-tour="config"]', title: 'Build a complete check', body: 'Params for query values, Headers for authentication and content type, Body for payload data, Assertions for response checks, and Capture to reuse values such as IDs or tokens in later requests.', placement: 'top' },
    { selector: '[data-tour="tab-assert"]', title: 'Make assertions meaningful', body: 'Assert more than a 200 status: verify response fields, error shapes, counts, headers, and expected failure cases. Keep assertions stable enough for regression testing but strict enough to catch a contract break.', placement: 'bottom', action: () => clickTour('tab-assert') },
    { selector: '[data-tour="tab-capture"]', title: 'Use captures to chain endpoints', body: 'Capture a value from one response — an access token, a created record id, a pagination cursor — and reference it in a following request. This turns isolated calls into a realistic API flow.', placement: 'bottom', action: () => clickTour('tab-capture') },
    { selector: '[data-tour="response"]', title: 'Read and save the result', body: 'After sending, inspect status, timing, response body, and assertion results. Save reliable requests to the project so regression checks do not need to be rebuilt next time.', placement: 'top' },
  ],
  '/instructions': [
    { selector: '[data-tour="header"]', title: 'Manage QC context', body: 'This is the persistent project context Claude can use during QC work. It is split across five tabs so each kind of guidance lives in the right place. This tour walks through each one.', placement: 'bottom', action: () => clickTab('instructions') },
    { selector: '[data-tour="context"]', title: 'Which project you are editing', body: 'Everything on this page is written into the active project’s folder. Check this bar before editing — and use Open folder to inspect the files on disk.', placement: 'bottom' },
    { selector: '[data-tour="tab-instructions"]', title: '1 · Instructions', body: 'The lean root CLAUDE.md — conventions, boundaries, and test priorities Claude follows on every run. Keep it short; link out to Knowledge and Memory instead of pasting everything here.', placement: 'bottom', action: () => clickTab('instructions') },
    { selector: '[data-tour="tab-knowledge"]', title: '2 · Knowledge', body: 'Upload longer reference material — specs, architecture notes, product policies (Word, PDF, Markdown, CSV, Excel). The portal converts it to background context without bloating the always-read CLAUDE.md.', placement: 'bottom', action: () => clickTab('knowledge') },
    { selector: '[data-tour="tab-memory"]', title: '3 · Memory', body: 'Small, durable facts you write by hand — one per note (a known integration constraint, a naming convention, a gotcha). Short and long-lived, unlike the larger uploaded Knowledge docs.', placement: 'bottom', action: () => clickTab('memory') },
    { selector: '[data-tour="tab-accounts"]', title: '4 · Accounts', body: 'App URLs and test-account logins so Claude uses real environments and credentials for “log in as …” steps instead of inventing placeholders. Use non-production test accounts only, and update them when access changes.', placement: 'bottom', action: () => clickTab('accounts') },
    { selector: '[data-tour="tab-brain"]', title: '5 · AI Brain', body: 'A visual map of how Instructions, Knowledge, and Memory connect and feed each run. The quickest way to spot missing context before asking Claude to test a complex workflow.', placement: 'bottom', action: () => clickTab('brain') },
  ],
  '/skills': [
    { selector: '[data-tour="header"]', title: 'Edit the QC skills', body: 'Skills are reusable, project-scoped workflows that tell Claude how to perform testing work consistently. The qc-testing skill is the one QC runs execute.', placement: 'bottom' },
    { selector: '[data-tour="new-skill"]', title: 'Create a new workflow', body: 'Add a skill for a new repeatable process — or import one you already have. Keep names narrowly scoped so run setup can pick the right behavior.', placement: 'bottom' },
    { selector: '[data-tour="rail"]', title: 'Find and select a skill', body: 'Search and pick a skill here. A star marks the project default (auto-selected for QC runs); an amber Update badge means the portal ships a newer version of a bundled skill.', placement: 'bottom' },
    { selector: '[data-tour="files"]', title: 'Organize supporting files', body: 'A skill is more than one instruction file. Each tab is a companion file — checklists, recipes, output templates — that the skill tells Claude to read at the right phase.', placement: 'bottom' },
    { selector: '[data-tour="editor"]', title: 'Make instructions actionable', body: 'Edit or preview a file here. Describe preconditions, steps, expected evidence, and safety limits: deterministic enough to reuse, but leaving room for the actual ticket context. Save writes straight into the project.', placement: 'top' },
    { selector: '[data-tour="skill-actions"]', title: 'Set the default and validate it', body: 'Set the skill as this project’s default, rename it, or delete it. Then test a change on a representative ticket from QC Run — tighten wording whenever a run produces inconsistent coverage.', placement: 'bottom' },
  ],
  '/mcp': [
    { selector: 'main h1', title: 'Connect MCP capabilities', body: 'MCP servers give QC access to external tools — browser automation, mobile devices, trackers, design files. Configuration is per project, stored in the project’s .mcp.json.', placement: 'bottom' },
    { selector: 'main section:nth-of-type(1)', title: 'Tickets & tasks', body: 'Connect the tracker QC reads requirements from. Once connected, crawling a ticket pulls its description, comments, and attachments into the project.', placement: 'top' },
    { selector: 'main section:nth-of-type(2)', title: 'Design', body: 'Connect Figma when you want the run to compare the built UI against the intended design. Optional — a run without it verifies behavior and content only.', placement: 'top' },
    { selector: 'main section:nth-of-type(3)', title: 'Browser & device — required for a web run', body: 'A web QC run drives a real browser, so it needs a working Playwright server here; mobile targets need the device server. Use Test connection before starting a run rather than discovering the problem mid-run. Tokens entered here stay in this project’s config — never put them in skills or tickets.', placement: 'top' },
  ],
  '/templates': [
    { selector: '[data-tour="header"]', title: 'Set reusable file templates', body: 'Templates define the structure of generated artifacts, keeping test cases and checklists compatible with the format your team already uses. They live under the project’s testing/templates/.', placement: 'bottom' },
    { selector: '[data-tour="template-testcase"]', title: 'Test-case template', body: 'Upload an approved example instead of recreating columns by hand — generated manual test cases follow its structure. A per-run upload on the Test Cases page still overrides it.', placement: 'top' },
    { selector: '[data-tour="template-design-check"]', title: 'Design Check checklist', body: 'The standard checklist a Design Check reports against. The run must return a finding for every criterion you list here.', placement: 'top' },
    { selector: '[data-tour="templates"]', title: 'Treat a template as a contract', body: 'Preview or replace a stored template when the process changes. Changing one changes FUTURE generated output, not existing files — agree the format with reviewers first, especially when another system consumes the CSV/Excel columns.', placement: 'top' },
  ],
  '/prototype': [
    { selector: '[data-tour="header"]', title: 'Build an interactive prototype', body: 'Describe a screen and AI creates a working HTML prototype saved with the project. A quick way to explore a flow before engineering work begins.', placement: 'bottom' },
    { selector: '[data-tour="saved"]', title: 'Manage saved iterations', body: 'Pick an existing prototype to keep refining it, or start a new one for a separate idea. Each saved item keeps both the HTML and the conversation.', placement: 'bottom' },
    { selector: '[data-tour="model"]', title: 'Pick the design depth first', body: 'The model and visual direction shape the first build, so choose them before the initial prompt. Refinements afterwards should be short and specific.', placement: 'bottom' },
    { selector: '[data-tour="prompt"]', title: 'Prompt with product detail', body: 'Describe the user, goal, screen structure, behavior, and states — and ask for loading, empty, error, success, hover, and mobile states, not just the happy path. Attach an image to copy an existing design.', placement: 'top' },
    { selector: '[data-tour="preview"]', title: 'Review the live preview', body: 'Check hierarchy, navigation, empty states, and interactions in the rendered prototype; switch to Code to read the HTML, or resize to a device frame to sanity-check mobile.', placement: 'top' },
  ],
  '/terminal': [
    { selector: '[data-tour="header"]', title: 'Use a project terminal', body: 'A real shell on this machine, opened in the active project’s folder. Connect launches a Claude session there, so commands operate on the repository selected in the portal.', placement: 'bottom' },
    { selector: '[data-tour="tabs"]', title: 'Run several terminals at once', body: 'Each tab is its own shell with its own Claude session — keep a QC conversation in one and run git or tests in another. Tabs are remembered per project, and closing a tab (the ×) is what ends that shell.', placement: 'bottom' },
    { selector: '[data-tour="session"]', title: 'Connect and manage the active tab', body: 'These controls act on the selected tab: the indicator shows idle / connecting / connected, and Disconnect ends that shell and anything it started. Leaving the page does not — you are re-attached when you come back. Slash commands lists the Claude commands you can type.', placement: 'bottom' },
    { selector: '[data-tour="cwd"]', title: 'Check the working folder first', body: 'The shell is spawned in this folder. Confirm it is the repository you mean before running anything: changes here are real, on this machine, and are not undone when the session ends.', placement: 'bottom' },
    { selector: '[data-tour="shell"]', title: 'Investigate a run for real', body: 'Inspect logs, run local checks, and read repository files when a QC result needs follow-up. Interactive tools work — typing `claude` starts a session — and long-running commands should be checked for their final state rather than blindly restarted.', placement: 'top' },
  ],
  '/settings': [
    { selector: 'main h1', title: 'Settings is the project control center', body: 'Every downstream page uses the active project selected here. A project determines the repository folder, local testing files, tracker data, MCP configuration, skills, templates, and saved QC output.', placement: 'bottom' },
    { selector: '[data-tour="settings-tabs"]', title: 'Separate project setup from model checks', body: 'Projects is where you register and prepare repositories. AI models is where you check Claude Code availability and choose the right cost-versus-depth option for future work.', placement: 'bottom' },
    { selector: '[data-tour="project-controls"]', title: 'Understand the project lifecycle', body: 'A project is a repository folder that QC can work against. Add an existing folder when the repository is already on this machine; import a ZIP when you need to create a local project copy first.', placement: 'bottom' },
    { selector: '[data-tour="project-actions"]', title: 'Add or import deliberately', body: 'Adding a folder references the local repository. Importing creates a project from an archive. Before confirming either action, make sure the folder is the intended repository — not a parent directory or build output folder.', placement: 'bottom' },
    { selector: '[data-tour="project-readiness"]', title: 'Read project readiness signals', body: 'Registered tells you how many repositories the portal knows. Active project is the context used by Tickets, Test Cases, QC Run, Skills, MCP, and Templates. The final signal tells you whether required folder setup is complete.', placement: 'bottom' },
    { selector: '[data-tour="project-search"]', title: 'Find projects safely at scale', body: 'Use the project search when many repositories are registered. Search checks both project names and paths, helping you avoid activating a similarly named but incorrect checkout.', placement: 'bottom' },
    { selector: '[data-tour="project-cards"]', title: 'Manage one repository at a time', body: 'Each card shows the project identity, filesystem path, setup state, and available actions. Set the correct card active before changing tracker connections, templates, instructions, or running QC.', placement: 'top' },
    { selector: '[data-tour="restart-app"]', title: 'Restart the portal safely', body: 'Restart app stops and relaunches the QC Portal server on this machine, then reloads this page once it is healthy. Use it after changing settings or MCP configuration, or when the portal is stuck. Do not restart while a QC run, ticket crawl, or test-case job is active: those background jobs are interrupted and will not resume.', placement: 'top' },
    { selector: '[data-tour="tab-models"]', title: 'Check the AI model runtime', body: 'Open AI models to verify Claude Code can run and compare the supported models. Use fast models for routine work, balanced models for standard QC, and deeper reasoning only for complex or risky work.', placement: 'bottom', action: () => clickTour('tab-models') },
  ],
}

export function RouteGuideTour() {
  const { pathname } = useLocation()
  const [open, setOpen] = useState(false)
  const steps = PAGE_GUIDES[pathname]
  if (!steps) return null
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)} className="fixed bottom-5 right-5 z-40 gap-1.5 rounded-full bg-card shadow-lg" title="Take a quick guided tour of this page">
        <Compass className="size-3.5" />
        Guide tour
      </Button>
      <GuideTour steps={steps} open={open} onClose={() => setOpen(false)} />
    </>
  )
}
