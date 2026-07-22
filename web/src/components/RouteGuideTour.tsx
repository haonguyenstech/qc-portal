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

const PAGE_GUIDES: Record<string, TourStep[]> = {
  '/tickets': [
    { selector: '[data-tour="header"]', title: 'Crawl tickets into your project', body: 'Pull work items from your tracker (ClickUp, Jira, or Azure DevOps) and download each one — description, comments, and attachments — into the project so the QC skill can read them offline.', placement: 'bottom' },
    { selector: '[data-tour="dest"]', title: 'Where files land', body: 'Everything downloads into this project’s testing/tickets/ folder. Use Open folder to jump straight to it on your machine.', placement: 'bottom' },
    { selector: '[data-tour="browse"]', title: 'Choose your source', body: 'Switch between connected trackers, pick a workspace or project, or bind this project to a single ClickUp list so you always see the right tickets.', placement: 'bottom' },
    { selector: '[data-tour="search"]', title: 'Find tickets fast', body: 'Search by title or id. Tickets group under sticky status headers, and subtasks expand under their parent via the chevron.', placement: 'bottom' },
    { selector: '[data-tour="list"]', title: 'Pick what to crawl', body: 'Click a ticket to select it (picking a subtask auto-includes its parents). A green Crawled badge means it’s already downloaded; a violet badge counts generated test cases. Hover a row to open it in the tracker or delete its files.', placement: 'top' },
    { selector: '[data-tour="actionbar"]', title: 'Crawl or queue', body: 'Once tickets are selected, this bar appears: choose how each is processed — plain download or an AI brief (Haiku/Sonnet/Opus) — then Crawl. Start another batch while one runs and it queues automatically; crawling continues on the server even if you leave the page.', placement: 'top' },
  ],
  '/api-testing': [
    { selector: 'main h1', title: 'Test APIs from the portal', body: 'Build repeatable HTTP checks against local, staging, or deployed APIs. The portal proxies requests through its server, so browser CORS restrictions do not prevent you testing localhost or protected environments.', placement: 'bottom' },
    { selector: 'main button', title: 'Start from a real request', body: 'Import a cURL command when you already have a working request, or scan a browser page to discover the APIs it calls. This captures the practical endpoint, method, and request shape before you refine it.', placement: 'bottom' },
    { selector: 'main input', title: 'Define the request target', body: 'Set the method and full URL, including route parameters. Keep environment-specific values in variables or captures where possible so a saved request can be reused safely.', placement: 'bottom' },
    { selector: 'main [role="tablist"]', title: 'Build a complete check', body: 'Use Params for query values, Headers for authentication and content type, Body for payload data, Assert for response checks, and Capture to reuse values such as IDs or tokens in later requests.', placement: 'top' },
    { selector: 'main [role="tablist"]', title: 'Use captures to chain endpoints', body: 'Capture a value from one response—for example an access token, created record ID, or pagination cursor—and reference it in a following request. This turns isolated calls into a realistic API flow.', placement: 'top' },
    { selector: 'main [role="tablist"]', title: 'Make assertions meaningful', body: 'Assert more than a 200 status: verify response fields, error shapes, counts, headers, and expected failure cases. Keep assertions stable enough for regression testing but strict enough to catch a contract break.', placement: 'top' },
    { selector: 'main section', title: 'Read and save the result', body: 'After sending, inspect status, timing, response body, and assertion results. Save reliable requests to the project so regression checks do not need to be rebuilt next time.', placement: 'top' },
  ],
  '/instructions': [
    { selector: 'main h1', title: 'Manage QC context', body: 'This is the persistent project context Claude can use during QC work. It is split across five tabs so each kind of guidance lives in the right place. This tour walks through each one.', placement: 'bottom', action: () => clickTab('instructions') },
    { selector: '[data-tour="tab-instructions"]', title: '1 · Instructions', body: 'The lean root CLAUDE.md — conventions, boundaries, and test priorities Claude follows on every run. Keep it short; link out to Knowledge and Memory instead of pasting everything here.', placement: 'bottom', action: () => clickTab('instructions') },
    { selector: '[data-tour="tab-knowledge"]', title: '2 · Knowledge', body: 'Upload longer reference material — specs, architecture notes, product policies (Word, PDF, Markdown, CSV, Excel). The portal converts it to background context without bloating the always-read CLAUDE.md.', placement: 'bottom', action: () => clickTab('knowledge') },
    { selector: '[data-tour="tab-memory"]', title: '3 · Memory', body: 'Small, durable facts you write by hand — one per note (a known integration constraint, a naming convention, a gotcha). Short and long-lived, unlike the larger uploaded Knowledge docs.', placement: 'bottom', action: () => clickTab('memory') },
    { selector: '[data-tour="tab-accounts"]', title: '4 · Accounts', body: 'App URLs and test-account logins so Claude uses real environments and credentials for “log in as …” steps instead of inventing placeholders. Use non-production test accounts only, and update them when access changes.', placement: 'bottom', action: () => clickTab('accounts') },
    { selector: '[data-tour="tab-brain"]', title: '5 · AI Brain', body: 'A visual map of how Instructions, Knowledge, and Memory connect and feed each run. The quickest way to spot missing context before asking Claude to test a complex workflow.', placement: 'bottom', action: () => clickTab('brain') },
  ],
  '/skills': [
    { selector: 'main h1', title: 'Edit the QC skills', body: 'Skills are reusable, project-scoped workflows that tell Claude how to perform testing work consistently.', placement: 'bottom' },
    { selector: 'main button', title: 'Create or select a workflow', body: 'Create a skill for a new repeatable process, then choose it from the skill list to edit its instructions and supporting files.', placement: 'bottom' },
    { selector: 'main input', title: 'Find the right skill quickly', body: 'Use search and the skill list to locate the workflow you need before editing. Keep names narrowly scoped so run setup can choose the correct behavior.', placement: 'bottom' },
    { selector: 'main textarea', title: 'Make instructions actionable', body: 'Describe preconditions, steps, expected evidence, and safety limits. A good skill is deterministic enough to reuse but leaves room for the actual ticket context.', placement: 'top' },
    { selector: 'main section', title: 'Organize supporting files', body: 'A skill can include more than its primary instruction file. Keep examples, scripts, checklists, and reference files close to the workflow so Claude has the exact material needed at run time.', placement: 'top' },
    { selector: 'main section', title: 'Validate a skill through a real run', body: 'After editing, choose the skill from QC Run and test it on a representative ticket. Tighten ambiguous wording whenever a run produces inconsistent coverage or unsafe assumptions.', placement: 'top' },
  ],
  '/mcp': [
    { selector: 'main h1', title: 'Connect MCP capabilities', body: 'MCP servers give QC access to external tools such as browser automation, mobile devices, and connected services. Configuration is isolated to the active project.', placement: 'bottom' },
    { selector: 'main section', title: 'Connect only what the workflow needs', body: 'Add the required service, provide its configuration, and use its health/status indicators before relying on it in a QC run. Web QC normally requires Playwright.', placement: 'top' },
    { selector: 'main button', title: 'Verify before running', body: 'Use the connection and setup actions to confirm a server is available. If it is unhealthy, fix configuration or authentication here rather than discovering the problem mid-run.', placement: 'top' },
    { selector: 'main section', title: 'Know the required capability', body: 'A web QC run needs a working Playwright MCP server because it drives a real browser. Other connections are optional unless a selected workflow explicitly depends on them.', placement: 'top' },
    { selector: 'main section', title: 'Protect configuration secrets', body: 'MCP configuration may include tokens or environment settings. Use the project-scoped setup, avoid placing secrets in skills or tickets, and rotate credentials through the connected service when needed.', placement: 'top' },
  ],
  '/templates': [
    { selector: 'main h1', title: 'Set reusable file templates', body: 'Templates define the required structure for generated artifacts, keeping test cases and other QC files compatible with your team’s existing format.', placement: 'bottom' },
    { selector: 'main section', title: 'Upload the format you need', body: 'Each template card describes its purpose and supported file types. Upload an approved example rather than manually recreating columns, headings, or formulas.', placement: 'top' },
    { selector: 'main button', title: 'Replace templates deliberately', body: 'Preview or replace a stored template when your process changes. The project copy is saved under testing/templates and is reused by later generation flows.', placement: 'top' },
    { selector: 'main section', title: 'Choose the correct template type', body: 'Use a test-case template to control generated manual cases and the appropriate project template for other artifacts. Keep headers, mandatory fields, and example rows representative of the expected output.', placement: 'top' },
    { selector: 'main section', title: 'Treat templates as a contract', body: 'Changing a template changes future generated output, not existing files. Agree the format with downstream reviewers first, especially when CSV or Excel columns are consumed by another system.', placement: 'top' },
  ],
  '/prototype': [
    { selector: 'main h1', title: 'Build an interactive prototype', body: 'Describe a screen and AI creates a working HTML prototype saved with the project. Treat it as a quick way to explore flows before engineering work begins.', placement: 'bottom' },
    { selector: 'main aside', title: 'Manage saved iterations', body: 'Select an existing prototype to continue refining it, or create a new one for a separate idea. Saved items preserve both the HTML and the conversation.', placement: 'bottom' },
    { selector: 'main textarea', title: 'Prompt with product detail', body: 'Describe the user, goal, screen structure, behavior, states, and visual direction. Follow up with focused changes instead of rewriting the whole request.', placement: 'top' },
    { selector: 'main iframe', title: 'Review the live preview', body: 'Use the rendered prototype to validate hierarchy, navigation, empty states, and interactions. Open or save an iteration when it is ready to share.', placement: 'top' },
    { selector: 'main button', title: 'Pick the right design depth', body: 'Choose the model and visual direction before the first build; they shape the initial prototype. Use short, specific follow-ups for refinements such as a changed state, breakpoint, or component behavior.', placement: 'bottom' },
    { selector: 'main textarea', title: 'Prototype the whole experience', body: 'Ask for loading, empty, error, success, hover, and mobile states—not just the happy-path screen. This makes the preview useful for product review and later QA planning.', placement: 'top' },
  ],
  '/terminal': [
    { selector: 'main h1', title: 'Use a project terminal', body: 'This is a real shell running in the active project folder. Connecting launches a Claude session, so commands operate against the repository currently selected in the portal.', placement: 'bottom' },
    { selector: 'main button', title: 'Connect and manage the session', body: 'Connect when you are ready to work; the status indicator confirms whether the terminal is available. Disconnect when you no longer need the active shell.', placement: 'bottom' },
    { selector: 'main section', title: 'Work with normal shell discipline', body: 'Review the active path before commands, prefer reversible changes, and use the terminal for project-scoped work. The session is powerful because it runs on this machine.', placement: 'top' },
    { selector: 'main section', title: 'Use the session for investigation', body: 'Inspect logs, run local checks, and examine repository files when a QC result needs follow-up. Do not assume terminal changes are isolated—commit or revert intentional work through the project’s normal process.', placement: 'top' },
    { selector: 'main section', title: 'Reconnect after interruptions', body: 'If the shell disconnects, reconnect from this page and confirm the working directory before continuing. Long-running commands and Claude sessions should be checked for their final state rather than blindly restarted.', placement: 'top' },
  ],
  '/settings': [
    { selector: 'main h1', title: 'Settings is the project control center', body: 'Every downstream page uses the active project selected here. A project determines the repository folder, local testing files, tracker data, MCP configuration, skills, templates, and saved QC output.', placement: 'bottom' },
    { selector: '[data-tour="settings-tabs"]', title: 'Separate project setup from model checks', body: 'Projects is where you register and prepare repositories. AI models is where you check Claude Code availability and choose the right cost-versus-depth option for future work.', placement: 'bottom' },
    { selector: '[data-tour="project-controls"]', title: 'Understand the project lifecycle', body: 'A project is a repository folder that QC can work against. Add an existing folder when the repository is already on this machine; import a ZIP when you need to create a local project copy first.', placement: 'bottom' },
    { selector: '[data-tour="project-actions"]', title: 'Add or import deliberately', body: 'Adding a folder references the local repository. Importing creates a project from an archive. Before confirming either action, make sure the folder is the intended repository—not a parent directory or build output folder.', placement: 'bottom' },
    { selector: '[data-tour="project-readiness"]', title: 'Read project readiness signals', body: 'Registered tells you how many repositories the portal knows. Active project is the context used by Tickets, Test Cases, QC Run, Skills, MCP, and Templates. The final signal tells you whether required folder setup is complete.', placement: 'bottom' },
    { selector: '[data-tour="project-search"]', title: 'Find projects safely at scale', body: 'Use the project search when many repositories are registered. Search checks both project names and paths, helping you avoid activating a similarly named but incorrect checkout.', placement: 'bottom' },
    { selector: '[data-tour="project-cards"]', title: 'Manage one repository at a time', body: 'Each card shows the project identity, filesystem path, setup state, and available actions. Set the correct card active before changing tracker connections, templates, instructions, or running QC.', placement: 'top' },
    { selector: '[data-tour="restart-app"]', title: 'Restart the portal safely', body: 'Restart app stops and relaunches the QC Portal server on this machine, then reloads this page once it is healthy. Use it after changing settings or MCP configuration, or when the portal is stuck. Do not restart while a QC run, ticket crawl, or test-case job is active: those background jobs are interrupted and will not resume.', placement: 'top' },
    { selector: '[data-tour="settings-tabs"]', title: 'Check the AI model runtime', body: 'Open AI models when you need to verify that Claude Code can run and compare the supported models. Use fast models for routine work, balanced models for standard QC, and deeper reasoning only for complex or risky work.', placement: 'bottom' },
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
