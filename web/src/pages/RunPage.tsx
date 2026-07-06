import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bookmark,
  Boxes,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  Gauge,
  Globe,
  Layers,
  Lightbulb,
  ListOrdered,
  Loader2,
  NotebookPen,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Smartphone,
  Sparkles,
  TabletSmartphone,
  Ticket,
  TriangleAlert,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import {
  checkAppUrl,
  createRun,
  listCrawledTickets,
  listRuns,
  listSkills,
  type CrawledTicket,
  type TestCaseFormat,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import { useProjects } from '@/lib/project-context'
import { useHints } from '@/lib/hints'
import { loadLastInputs, saveLastInputs, isValidHttpUrl } from '@/lib/runForm'
import { relativeTime } from '@/lib/format'
import { StatusBadge } from '@/lib/status'
import { ManageHintsDialog } from '@/components/ManageHintsDialog'
import { RunPresetsDialog } from '@/components/RunPresetsDialog'
import { useRunPresets, type RunPreset } from '@/lib/presets'
import { CrawledTicketPicker } from '@/components/CrawledTicketPicker'
import { CrawledStatusHeader, CrawledTicketRow } from '@/components/CrawledTicketRow'
import { groupCrawledByStatus } from '@/lib/crawled-tickets'
import { TicketTestCasePicker, testcaseRelPath } from '@/components/TicketTestCasePicker'
import { McpRequiredNotice } from '@/components/McpRequiredNotice'

// Which Claude model drives the QC run. Each maps to --model haiku/sonnet/opus
// on the headless claude spawn. Sonnet is the default — the best all-round
// balance of coverage and cost for most QC runs.
const RUN_MODEL_KEY = 'qc.runModel'
const DEFAULT_RUN_MODEL = 'sonnet'
type QcModel = {
  value: string
  label: string
  tag: string
  icon: typeof Cpu
  description: string
}
const QC_MODELS: QcModel[] = [
  {
    value: 'haiku',
    label: 'Haiku',
    tag: 'fastest · lowest fee',
    icon: Zap,
    description:
      'Cheapest and quickest. Best for small, well-specified tickets with only a flow or two — saves the most on cost.',
  },
  {
    value: 'sonnet',
    label: 'Sonnet',
    tag: 'balanced · recommended',
    icon: Gauge,
    description:
      'Strong reasoning at a moderate price. The best all-round choice for most QC runs — good coverage without a high bill.',
  },
  {
    value: 'opus',
    label: 'Opus',
    tag: 'deepest · highest fee',
    icon: Brain,
    description:
      'Most thorough multi-step testing and edge-case hunting. Best result for long, complex, ambiguous or high-risk tickets — but slower and the most expensive.',
  },
]

function loadRunModel(): string {
  try {
    const saved = localStorage.getItem(RUN_MODEL_KEY)
    if (saved && QC_MODELS.some((m) => m.value === saved)) return saved
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_RUN_MODEL
}

// Simple = one ticket, one run (the original flow). Advanced = pick several
// related tickets + define an ordered feature workflow, all driven as one run.
type RunMode = 'simple' | 'advanced'
// Feature (advanced) mode is temporarily disabled — shown as "Coming soon" and not
// selectable. Flip to true to bring it back; the advanced-mode code below is intact.
const ADVANCED_ENABLED = false
const RUN_MODE_KEY = 'qc.runMode'
const MAX_FEATURE_TICKETS = 5

function loadRunMode(): RunMode {
  try {
    return localStorage.getItem(RUN_MODE_KEY) === 'advanced' ? 'advanced' : 'simple'
  } catch {
    return 'simple'
  }
}

// Where the QC run executes:
//  web        — desktop browser (Playwright), the App URL
//  web-mobile — the App URL opened in a mobile device's browser via Mobile MCP
//  app-mobile — a native app driven on a mobile device via Mobile MCP (App URL optional)
type TestTarget = 'web' | 'web-mobile' | 'app-mobile'
const TEST_TARGET_KEY = 'qc.runTestTarget'
const TEST_TARGETS: TestTarget[] = ['web', 'web-mobile', 'app-mobile']

// Mobile targets are not ready yet — shown as "Coming soon" and unselectable.
const COMING_SOON_TARGETS: TestTarget[] = ['web-mobile', 'app-mobile']

function loadTestTarget(): TestTarget {
  try {
    const v = localStorage.getItem(TEST_TARGET_KEY)
    if (!TEST_TARGETS.includes(v as TestTarget)) return 'web'
    return COMING_SOON_TARGETS.includes(v as TestTarget) ? 'web' : (v as TestTarget)
  } catch {
    return 'web'
  }
}

const TARGET_META: Record<TestTarget, { label: string; hint: string; Icon: typeof Globe }> = {
  web: { label: 'Web', hint: 'Desktop browser', Icon: Globe },
  'web-mobile': { label: 'Web on mobile', hint: 'Mobile browser', Icon: Smartphone },
  'app-mobile': { label: 'App on device', hint: 'Native app', Icon: TabletSmartphone },
}

/** Numbered step header that splits the run form into clear, scannable sections. */
function StepHeader({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-foreground text-[11px] font-semibold text-background">
        {n}
      </span>
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {hint && <span className="text-xs text-muted-foreground">· {hint}</span>}
    </div>
  )
}

const ticketIdOf = (t: CrawledTicket) => t.displayId ?? t.name

/**
 * Advanced-mode ticket picker: choose several crawled tickets that together make
 * up one feature. The first pick is the **lead** (the run's report lands under
 * its slug); the rest ride along as related context in the same run.
 */
function FeatureTicketsPicker({
  tickets,
  value,
  onChange,
  disabled,
}: {
  tickets: CrawledTicket[]
  value: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const atMax = value.length >= MAX_FEATURE_TICKETS
  const q = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = q
      ? tickets.filter(
          (t) =>
            ticketIdOf(t).toLowerCase().includes(q) ||
            (t.title ?? '').toLowerCase().includes(q),
        )
      : tickets
    return [...list].sort((a, b) => (b.crawledAt ?? '').localeCompare(a.crawledAt ?? ''))
  }, [tickets, q])

  function toggle(id: string) {
    if (value.includes(id)) onChange(value.filter((v) => v !== id))
    else if (!atMax) onChange([...value, id])
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5">
          <Layers className="size-3.5 text-muted-foreground" />
          Tickets in this feature
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
            {value.length}/{MAX_FEATURE_TICKETS}
          </span>
        </Label>
        <Link
          to="/tickets"
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          <Ticket className="size-3.5" />
          Crawl more
        </Link>
      </div>

      {/* selected chips, in run order — the first is the lead ticket */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id, i) => (
            <span
              key={id}
              className="group inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 py-1 pl-2.5 pr-1.5 text-xs font-medium text-foreground"
            >
              {i === 0 && (
                <span className="rounded-full bg-primary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary-foreground">
                  Lead
                </span>
              )}
              <span className="font-mono">{id}</span>
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${id}`}
                  onClick={() => toggle(id)}
                  className="grid size-4 place-items-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {/* searchable checklist of crawled tickets */}
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-muted/60">
        <div className="relative border-b border-border/60 p-2.5">
          <Search className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder="Filter crawled tickets by id or title…"
            className="h-11 w-full rounded-full border border-input bg-transparent px-4 pl-9 text-sm shadow-none outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 focus:shadow-sm disabled:opacity-50"
          />
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          {tickets.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 px-3 py-8 text-center">
              <Ticket className="size-6 text-muted-foreground/40" />
              <p className="text-sm font-medium">No crawled tickets yet</p>
              <p className="max-w-[16rem] text-xs text-muted-foreground">
                Crawl tickets on the Tickets page first — they’ll appear here ready to test.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
              <Search className="size-3.5" />
              No crawled ticket matches “{query}”.
            </div>
          ) : (
            groupCrawledByStatus(filtered).map((group) => (
              <div key={group.status || '∅'}>
                <CrawledStatusHeader status={group.status} count={group.tickets.length} />
                <ul className="divide-y">
                  {group.tickets.map((t) => {
                    const id = ticketIdOf(t)
                    const isSel = value.includes(id)
                    return (
                      <li key={t.name}>
                        <CrawledTicketRow
                          ticket={t}
                          selected={isSel}
                          onSelect={() => toggle(id)}
                          blocked={disabled || (!isSel && atMax)}
                        />
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Pick the tickets that make up one feature. The first one is the{' '}
        <span className="font-medium text-foreground">lead</span> — the run’s report is written
        under its folder.
      </p>
    </div>
  )
}

/**
 * Ordered, editable list of workflow steps for an advanced feature run. Steps
 * are exercised in order as the primary acceptance path. Add / remove / reorder.
 */
function WorkflowStepsEditor({
  steps,
  onChange,
  disabled,
}: {
  steps: string[]
  onChange: (next: string[]) => void
  disabled?: boolean
}) {
  function setAt(i: number, val: string) {
    const next = [...steps]
    next[i] = val
    onChange(next)
  }
  function add() {
    onChange([...steps, ''])
  }
  function removeAt(i: number) {
    const next = steps.filter((_, idx) => idx !== i)
    onChange(next.length ? next : [''])
  }
  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        <ListOrdered className="size-3.5 text-muted-foreground" />
        Feature workflow
        <span className="font-normal text-muted-foreground">· ordered steps</span>
      </Label>
      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold tabular-nums text-muted-foreground">
              {i + 1}
            </span>
            <Input
              value={step}
              onChange={(e) => setAt(i, e.target.value)}
              disabled={disabled}
              placeholder={
                i === 0 ? 'e.g. Sign up with a new email' : 'Describe the next step…'
              }
              className="h-10 flex-1 shadow-xs transition-shadow focus-visible:shadow-sm"
            />
            <div className="flex shrink-0 items-center">
              <button
                type="button"
                disabled={disabled || i === 0}
                onClick={() => move(i, -1)}
                aria-label="Move step up"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={disabled || i === steps.length - 1}
                onClick={() => move(i, 1)}
                aria-label="Move step down"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeAt(i)}
                aria-label="Remove step"
                className="grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-30"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <button
        type="button"
        disabled={disabled}
        onClick={add}
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-border/60 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus className="size-3.5" />
        Add step
      </button>
      <p className="text-xs text-muted-foreground">
        Claude exercises these in order, verifying each before moving on — describe the end-to-end
        flow that ties the tickets together.
      </p>
    </div>
  )
}

export default function RunPage() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { activeProject } = useProjects()
  const [ticketId, setTicketId] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [testTarget, setTestTarget] = useState<TestTarget>(loadTestTarget)
  const [skill, setSkill] = useState('')
  const [model, setModel] = useState<string>(loadRunModel)
  const [instructions, setInstructions] = useState('')
  // The Single/Feature tab lives in the URL (?mode=simple|advanced) so it's
  // shareable/bookmarkable and survives reload; localStorage is the fallback default.
  const modeParam = searchParams.get('mode')
  const requestedMode: RunMode =
    modeParam === 'advanced' ? 'advanced' : modeParam === 'simple' ? 'simple' : loadRunMode()
  // Force simple while Feature (advanced) is disabled, even if a stale URL/localStorage
  // value asks for advanced.
  const mode: RunMode = ADVANCED_ENABLED ? requestedMode : 'simple'
  const [showOptions, setShowOptions] = useState(false)
  const [featureTickets, setFeatureTickets] = useState<string[]>([])
  const [workflowSteps, setWorkflowSteps] = useState<string[]>([''])
  const [testcaseVersion, setTestcaseVersion] = useState<number | null>(null)
  const [testcaseFormat, setTestcaseFormat] = useState<TestCaseFormat | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [managingHints, setManagingHints] = useState(false)
  const [managingPresets, setManagingPresets] = useState(false)
  const instructionsRef = useRef<HTMLTextAreaElement>(null)

  const { hints, addHint: createHint, updateHint, removeHint, resetHints } = useHints()
  const { presets, addPreset, renamePreset, removePreset } = useRunPresets()

  const { data: skills } = useQuery({
    queryKey: ['skills', activeProject?.id],
    queryFn: () => listSkills(activeProject!.id),
    enabled: !!activeProject,
  })

  // The crawled tickets, used to resolve the selected ticket's folder (so we can
  // load its test-case versions) — same query key the picker uses, so it's shared.
  const { data: crawledTickets } = useQuery({
    queryKey: ['crawled-tickets', activeProject?.id],
    queryFn: () => listCrawledTickets(activeProject!.id),
    enabled: !!activeProject,
  })
  const selectedTicket = (crawledTickets ?? []).find(
    (t) => (t.displayId ?? t.name) === ticketId,
  )
  const selectedFolder = selectedTicket?.name ?? null

  // Reset the chosen test-case version whenever the ticket changes (render-phase
  // pattern — the picker re-selects the latest version for the new ticket).
  const [seenTicket, setSeenTicket] = useState(ticketId)
  if (seenTicket !== ticketId) {
    setSeenTicket(ticketId)
    setTestcaseVersion(null)
  }

  const { data: recentRuns } = useQuery({
    queryKey: ['runs', activeProject?.id],
    queryFn: () => listRuns(activeProject!.id),
    enabled: !!activeProject,
  })

  // Restore the last inputs for this project when it changes.
  useEffect(() => {
    if (!activeProject) return
    const saved = loadLastInputs(activeProject.id)
    setTicketId(saved?.ticketId ?? '')
    setAppUrl(saved?.appUrl ?? '')
    setInstructions(saved?.instructions ?? '')
    // The project's default skill (set on the Skills page) wins on load; otherwise
    // restore the last-used skill. Reconciled against the skills list below.
    setSkill(activeProject.defaultSkill || saved?.skill || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  // app-mobile drives a native app already installed on the device — there's no URL,
  // so the URL field is hidden and never required/validated in that mode.
  const isAppTarget = testTarget === 'app-mobile'
  const appUrlInvalid =
    !isAppTarget && appUrl.trim().length > 0 && !isValidHttpUrl(appUrl)
  const appUrlHelp =
    testTarget === 'web-mobile'
      ? 'The deployed page Claude opens in the mobile browser.'
      : 'The deployed page Claude should open and test.'

  // One-click reachability probe for the App URL (server-side fetch — CORS-free).
  const urlCheck = useMutation({ mutationFn: (url: string) => checkAppUrl(url) })
  // A stale verdict is misleading — drop it as soon as the URL is edited.
  useEffect(() => {
    urlCheck.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appUrl])

  // Reconcile the chosen skill against the available list: keep a still-valid
  // selection, otherwise fall back to the project's default skill (set on the
  // Skills page), then qc-testing, then the first available skill.
  const defaultSkill = activeProject?.defaultSkill
  useEffect(() => {
    if (!skills || skills.length === 0) return
    setSkill((prev) => {
      if (prev && skills.some((s) => s.name === prev)) return prev
      if (defaultSkill && skills.some((s) => s.name === defaultSkill)) return defaultSkill
      return skills.find((s) => s.name === 'qc-testing')?.name ?? skills[0].name
    })
  }, [skills, defaultSkill])

  const activeSkill = useMemo(
    () => skills?.find((s) => s.name === skill),
    [skills, skill],
  )

  const modelInfo =
    QC_MODELS.find((m) => m.value === model) ??
    QC_MODELS.find((m) => m.value === DEFAULT_RUN_MODEL)!
  function chooseModel(value: string) {
    setModel(value)
    try {
      localStorage.setItem(RUN_MODEL_KEY, value)
    } catch {
      /* storage unavailable */
    }
  }

  // Persist the mode to the URL (?mode=) + localStorage default.
  function writeMode(next: RunMode) {
    try {
      localStorage.setItem(RUN_MODE_KEY, next)
    } catch {
      /* storage unavailable */
    }
    const params = new URLSearchParams(searchParams)
    params.set('mode', next)
    setSearchParams(params, { replace: true })
  }

  function chooseMode(next: RunMode) {
    if (next === mode) return
    // Carry the chosen ticket across the switch so nothing is lost: simple→advanced
    // seeds the feature list with the single ticket; advanced→simple keeps the lead.
    if (next === 'advanced' && featureTickets.length === 0 && ticketId.trim()) {
      setFeatureTickets([ticketId.trim()])
    } else if (next === 'simple' && !ticketId.trim() && featureTickets.length > 0) {
      setTicketId(featureTickets[0])
    }
    writeMode(next)
  }

  // Load a saved template into the form. Switches mode and fills the matching
  // fields; the ticket(s) are restored for feature templates (simple templates
  // never carry a ticket, so the ticket field is left as-is).
  function applyPreset(p: RunPreset) {
    const nextMode: RunMode = p.mode === 'advanced' ? 'advanced' : 'simple'
    writeMode(nextMode)
    setAppUrl(p.appUrl)
    if (p.skill) setSkill(p.skill)
    setInstructions(p.instructions)
    chooseModel(
      p.model && QC_MODELS.some((m) => m.value === p.model) ? p.model : DEFAULT_RUN_MODEL,
    )
    if (nextMode === 'advanced') {
      setFeatureTickets((p.tickets ?? []).slice(0, MAX_FEATURE_TICKETS))
      setWorkflowSteps(p.workflowSteps && p.workflowSteps.length ? p.workflowSteps : [''])
    }
    toast.success('Template loaded', {
      description:
        nextMode === 'advanced' && p.tickets?.length
          ? `${p.name} — ${p.tickets.length} ticket${p.tickets.length === 1 ? '' : 's'} ready to run.`
          : `${p.name} — review and run.`,
    })
  }

  function addHint(text: string) {
    setInstructions((prev) => {
      const trimmed = prev.trimEnd()
      const next = trimmed ? `${trimmed}\n${text}` : text
      return next
    })
    // Let the value settle, then focus the textarea so the user can keep typing.
    requestAnimationFrame(() => instructionsRef.current?.focus())
  }

  // The tickets that drive this run: a single ticket in simple mode, or the
  // ordered feature list in advanced mode (first = lead, the rest are related).
  const runTickets =
    mode === 'advanced' ? featureTickets : ticketId.trim() ? [ticketId.trim()] : []
  const leadTicket = runTickets[0] ?? ''
  const cleanSteps = workflowSteps.map((s) => s.trim()).filter(Boolean)
  const appUrlReady = isAppTarget || !!appUrl.trim()
  const canSubmit =
    !submitting && !!leadTicket && appUrlReady && !appUrlInvalid && !!activeProject
  const recent = recentRuns ?? []
  const liveRuns = recent.filter((run) => run.status === 'running' || run.status === 'queued').length
  const completedRuns = recent.filter((run) => run.status === 'passed' || run.status === 'failed').length
  const selectedTestcaseLabel =
    mode === 'simple' && testcaseVersion != null ? `v${testcaseVersion}` : mode === 'advanced' ? `${cleanSteps.length} step${cleanSteps.length === 1 ? '' : 's'}` : 'Optional'
  const readyChecks = [
    { label: 'Project', ok: !!activeProject, value: activeProject?.name ?? 'Select one' },
    { label: mode === 'advanced' ? 'Lead ticket' : 'Ticket', ok: !!leadTicket, value: leadTicket || 'Choose ticket' },
    {
      label: isAppTarget ? 'App' : 'App URL',
      ok: appUrlReady && !appUrlInvalid,
      value: isAppTarget
        ? 'On device'
        : appUrlInvalid
          ? 'Invalid URL'
          : appUrl.trim()
            ? 'Ready'
            : 'Required',
    },
    { label: 'Skill', ok: !!skill, value: skill || 'Choose skill' },
  ]

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!leadTicket || !activeProject || (!isAppTarget && !appUrl.trim())) return
    if (!isAppTarget && !isValidHttpUrl(appUrl)) {
      toast.error('Invalid App URL', { description: 'Enter a full http:// or https:// address.' })
      return
    }
    setSubmitting(true)
    try {
      // Simple mode only: when a test-case version is chosen, tell Claude to verify
      // against that file (it runs in the project folder, so the path is readable).
      const base = instructions.trim()
      const tcLine =
        mode === 'simple' && selectedFolder && testcaseVersion != null
          ? `Verify against the manual test cases in ${testcaseRelPath(selectedFolder, testcaseVersion, testcaseFormat ?? 'markdown')} — treat each case as an acceptance check.`
          : ''
      const finalInstructions = [base, tcLine].filter(Boolean).join('\n\n')

      await createRun({
        projectId: activeProject.id,
        ticketId: leadTicket,
        appUrl: isAppTarget ? '' : appUrl.trim(),
        skill: skill || undefined,
        instructions: finalInstructions || undefined,
        model,
        relatedTickets:
          mode === 'advanced' && runTickets.length > 1 ? runTickets.slice(1) : undefined,
        workflowSteps: mode === 'advanced' && cleanSteps.length ? cleanSteps : undefined,
        testTarget,
      })
      saveLastInputs(activeProject.id, {
        ticketId: leadTicket,
        appUrl: appUrl.trim(),
        skill,
        instructions: instructions.trim(),
      })
      queryClient.invalidateQueries({ queryKey: ['runs'] })
      toast.success(
        mode === 'advanced' && runTickets.length > 1 ? 'Feature QC run started' : 'QC run started',
        {
          description:
            mode === 'advanced' && runTickets.length > 1
              ? `Testing ${runTickets.length} tickets as one feature — tracking on the Running page.`
              : 'Tracking progress on the Running page.',
        },
      )
      navigate('/running')
    } catch (err) {
      toast.error('Failed to start run', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Play className="size-5" />
          </span>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-3xl font-semibold tracking-tight">Launch QC Run</h1>
              {activeProject && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <span className="size-1.5 rounded-full bg-emerald-500" />
                  {activeProject.name}
                </Badge>
              )}
            </div>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Configure a ticket, live app URL, model, and run instructions. When started, the run
              moves to the live tracker and writes a structured QC report.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:min-w-[24rem]">
          <div className="rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 shadow-none">
            <div className="text-lg font-semibold tabular-nums">{recent.length}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Runs
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 shadow-none">
            <div className="text-lg font-semibold tabular-nums">{liveRuns}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Live
            </div>
          </div>
          <div className="rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 shadow-none">
            <div className="text-lg font-semibold tabular-nums">{completedRuns}</div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Complete
            </div>
          </div>
        </div>
      </header>

      <McpRequiredNotice
        required={testTarget === 'web' ? ['playwright'] : ['mobile-mcp']}
        feature="run QC tests"
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
          <CardContent className="p-6">
          <form
            onSubmit={onSubmit}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.requestSubmit()
              }
            }}
            className="space-y-5"
          >
            {/* mode toggle + run templates */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex w-full rounded-full border border-border/60 bg-muted/60 p-1 sm:w-auto">
                {(
                  [
                    { value: 'simple' as const, label: 'Single ticket', icon: Sparkles, disabled: false },
                    {
                      value: 'advanced' as const,
                      label: 'Feature (advanced)',
                      icon: Workflow,
                      disabled: !ADVANCED_ENABLED,
                    },
                  ]
                ).map((opt) => {
                  const Icon = opt.icon
                  const active = mode === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => !opt.disabled && chooseMode(opt.value)}
                      aria-pressed={active}
                      disabled={opt.disabled}
                      title={opt.disabled ? 'Coming soon' : undefined}
                      className={cn(
                        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-all sm:flex-none',
                        opt.disabled
                          ? 'cursor-not-allowed text-muted-foreground/50'
                          : active
                            ? 'bg-background text-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                      {opt.label}
                      {opt.disabled && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Soon
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setManagingPresets(true)}
                disabled={!activeProject}
                className="gap-1.5 rounded-full"
              >
                <Bookmark className="size-3.5" />
                Templates
                {presets.length > 0 && (
                  <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                    {presets.length}
                  </span>
                )}
              </Button>
            </div>

            {mode === 'advanced' && (
              <div className="flex items-start gap-2 rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <Layers className="mt-0.5 size-3.5 shrink-0 text-primary" />
                <span>
                  <span className="font-medium text-foreground">Feature run:</span> pick the related
                  tickets and lay out the end-to-end workflow. They run as{' '}
                  <span className="font-medium text-foreground">one</span> QC session with a single
                  report — best for a multi-ticket feature, and a deeper model (Sonnet/Opus) is
                  recommended.
                </span>
              </div>
            )}

            {/* 1 — what to test */}
            <section className="space-y-3">
              <StepHeader
                n={1}
                title="What to test"
                hint={mode === 'advanced' ? 'a feature across tickets' : 'a crawled ticket'}
              />
              {mode === 'simple' ? (
                <div className="space-y-4">
                  <CrawledTicketPicker
                    value={ticketId}
                    onChange={setTicketId}
                    projectId={activeProject?.id}
                    disabled={!activeProject}
                  />

                  {/* Test cases for the chosen ticket (or a prompt to generate them). */}
                  {ticketId.trim() && selectedFolder && (
                    <TicketTestCasePicker
                      folder={selectedFolder}
                      projectId={activeProject?.id}
                      value={testcaseVersion}
                      onChange={(v, f) => {
                        setTestcaseVersion(v)
                        setTestcaseFormat(f)
                      }}
                      disabled={!activeProject}
                    />
                  )}
                </div>
              ) : (
                <div className="space-y-4">
                  <FeatureTicketsPicker
                    tickets={crawledTickets ?? []}
                    value={featureTickets}
                    onChange={setFeatureTickets}
                    disabled={!activeProject}
                  />
                  <WorkflowStepsEditor
                    steps={workflowSteps}
                    onChange={setWorkflowSteps}
                    disabled={!activeProject}
                  />
                </div>
              )}
            </section>

            {/* 2 — where to run */}
            <section className="space-y-3">
              <StepHeader n={2} title="Where to run" hint="device or browser" />
              {/* Test target — web (Playwright), the web app on a mobile device, or a native app on a device (Mobile MCP). */}
              <div className="space-y-2">
                <Label className="sr-only">Test target</Label>
                <div className="grid grid-cols-3 gap-1.5">
                  {TEST_TARGETS.map((t) => {
                    const meta = TARGET_META[t]
                    const active = testTarget === t
                    const comingSoon = COMING_SOON_TARGETS.includes(t)
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          setTestTarget(t)
                          try {
                            localStorage.setItem(TEST_TARGET_KEY, t)
                          } catch {
                            /* ignore */
                          }
                        }}
                        disabled={!activeProject || comingSoon}
                        aria-pressed={active}
                        className={cn(
                          'relative flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-all duration-200 active:scale-[0.98] disabled:opacity-60',
                          active
                            ? 'border-primary/40 bg-primary/5'
                            : 'border-border/60 bg-muted/40 hover:border-border hover:bg-muted/70',
                          comingSoon && 'cursor-not-allowed hover:border-border/60 hover:bg-muted/40',
                        )}
                      >
                        {comingSoon && (
                          <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-200 bg-amber-50 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide text-amber-700">
                            Coming soon
                          </span>
                        )}
                        <meta.Icon
                          className={cn('size-4', active ? 'text-primary' : 'text-muted-foreground')}
                        />
                        <span className="text-xs font-medium leading-tight">{meta.label}</span>
                        <span className="text-[10px] leading-tight text-muted-foreground">
                          {meta.hint}
                        </span>
                      </button>
                    )
                  })}
                </div>
                {testTarget === 'web-mobile' && (
                  <p className="text-[11px] text-muted-foreground">
                    Opens the App URL on a booted device via the{' '}
                    <Link to="/mcp" className="font-medium text-primary hover:underline">
                      Mobile MCP
                    </Link>{' '}
                    — connect the Mobile server and boot a device first.
                  </p>
                )}
              </div>

              {isAppTarget ? (
                // Native app: no URL — the app must already be installed on the device.
                <div className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-0.5 leading-snug">
                    <p className="font-medium">No App URL needed — Claude drives the installed app.</p>
                    <p>
                      Install the app on the booted device first and connect the{' '}
                      <Link to="/mcp" className="font-medium underline">
                        Mobile MCP
                      </Link>{' '}
                      server. Claude launches the already-installed app on the device — it won't
                      install it for you.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="appUrl" className="flex items-center gap-1.5">
                    <Globe className="size-3.5 text-muted-foreground" />
                    App URL
                  </Label>
                  <div className="group relative">
                    <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                    <Input
                      id="appUrl"
                      type="url"
                      placeholder="https://staging.example.com/page"
                      value={appUrl}
                      onChange={(e) => setAppUrl(e.target.value)}
                      disabled={!activeProject}
                      aria-invalid={appUrlInvalid}
                      className="h-11 pl-9 pr-20 font-mono text-sm shadow-xs transition-shadow focus-visible:shadow-sm"
                    />
                    {/* Small in-field probe — pings the URL from the server to prove it's reachable. */}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="absolute right-1.5 top-1/2 h-8 -translate-y-1/2 rounded-full px-3 text-xs shadow-none"
                      disabled={!isValidHttpUrl(appUrl) || urlCheck.isPending}
                      onClick={() => urlCheck.mutate(appUrl.trim())}
                    >
                      {urlCheck.isPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        'Check'
                      )}
                    </Button>
                  </div>
                  {appUrlInvalid ? (
                    <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                      <TriangleAlert className="size-3.5" />
                      Enter a full http:// or https:// URL.
                    </p>
                  ) : urlCheck.data ? (
                    urlCheck.data.ok ? (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                        <Check className="size-3.5" />
                        Reachable · HTTP {urlCheck.data.status}
                        {urlCheck.data.finalUrl && urlCheck.data.finalUrl !== appUrl.trim() && (
                          <span className="truncate font-normal text-muted-foreground">
                            → {urlCheck.data.finalUrl}
                          </span>
                        )}
                      </p>
                    ) : (
                      <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                        <TriangleAlert className="size-3.5" />
                        {urlCheck.data.error ?? 'The URL did not respond.'}
                      </p>
                    )
                  ) : urlCheck.isError ? (
                    <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                      <TriangleAlert className="size-3.5" />
                      Could not check the URL — is the portal server running?
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{appUrlHelp}</p>
                  )}
                </div>
              )}
            </section>

            {/* 3 — options (collapsible: skill, model, instructions — sensible defaults, open only if needed) */}
            <section className="space-y-3">
              <button
                type="button"
                onClick={() => setShowOptions((v) => !v)}
                aria-expanded={showOptions}
                className="flex w-full items-center gap-2 text-left"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-foreground text-[11px] font-semibold text-background">
                  3
                </span>
                <span className="text-sm font-semibold tracking-tight">Options</span>
                <span className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                  <span className="hidden truncate sm:inline">
                    {skill || 'qc-testing'} · {modelInfo.label}
                    {instructions.trim() ? ' · notes' : ''}
                  </span>
                  <ChevronDown
                    className={cn('size-4 shrink-0 transition-transform', showOptions && 'rotate-180')}
                  />
                </span>
              </button>
              {showOptions && (
                <div className="space-y-5 rounded-2xl border border-border/60 bg-muted/30 p-4">
            {/* skill picker */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="skill" className="flex items-center gap-1.5">
                  <Boxes className="size-3.5 text-muted-foreground" />
                  Skill
                </Label>
                {skill && (
                  <Link
                    to="/skills"
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                  >
                    <Pencil className="size-3" />
                    Edit skill
                    <ChevronRight className="size-3" />
                  </Link>
                )}
              </div>
              <Select
                value={skill}
                onValueChange={setSkill}
                disabled={!activeProject || !skills?.length}
              >
                <SelectTrigger id="skill" className="h-11 w-full shadow-xs">
                  <SelectValue placeholder={skills?.length ? 'Choose a skill' : 'No skills found'} />
                </SelectTrigger>
                <SelectContent>
                  {skills?.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      <span className="flex items-center gap-2">
                        <Boxes className="size-3.5 text-muted-foreground" />
                        <span className="font-mono">{s.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="line-clamp-2 text-xs text-muted-foreground">
                {activeSkill?.description ||
                  'The Claude skill that drives this run — qc-testing is the standard acceptance flow.'}
              </p>
            </div>

            {/* model picker — which Claude model runs the QC test */}
            <div className="space-y-2">
              <Label htmlFor="model" className="flex items-center gap-1.5">
                <Cpu className="size-3.5 text-muted-foreground" />
                AI model
              </Label>
              <Select value={model} onValueChange={chooseModel} disabled={!activeProject}>
                <SelectTrigger id="model" className="h-11 w-full shadow-xs">
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <modelInfo.icon className="size-3.5 text-muted-foreground" />
                      <span className="font-medium">{modelInfo.label}</span>
                      <span className="text-xs text-muted-foreground">· {modelInfo.tag}</span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {QC_MODELS.map((m) => {
                    const Icon = m.icon
                    return (
                      <SelectItem key={m.value} value={m.value} className="py-2">
                        <span className="flex items-start gap-2">
                          <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex flex-col gap-0.5">
                            <span className="flex items-center gap-1.5">
                              <span className="font-medium">{m.label}</span>
                              <span className="text-xs text-muted-foreground">· {m.tag}</span>
                            </span>
                            <span className="max-w-[20rem] text-xs leading-snug text-muted-foreground">
                              {m.description}
                            </span>
                          </span>
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{modelInfo.label}:</span>{' '}
                {modelInfo.description} <span className="text-muted-foreground/80">Opus for tricky
                tickets, Haiku for small ones, Sonnet for the best balance.</span>
              </p>
            </div>

            {/* free-form AI instructions */}
            <div className="space-y-2">
              <Label htmlFor="instructions" className="flex items-center gap-1.5">
                <NotebookPen className="size-3.5 text-muted-foreground" />
                Instructions for the AI
                <span className="font-normal text-muted-foreground">· optional</span>
              </Label>
              <Textarea
                id="instructions"
                ref={instructionsRef}
                placeholder="Anything the AI should know: login details, which flows to focus on, known issues to skip, devices to check…"
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                disabled={!activeProject}
                rows={4}
                className="resize-y leading-relaxed transition-shadow focus-visible:shadow-sm"
              />
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <span className="mr-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <Lightbulb className="size-3.5" />
                  Add a hint:
                </span>
                {hints.map((hint) => (
                  <button
                    key={hint.id}
                    type="button"
                    onClick={() => addHint(hint.text)}
                    disabled={!activeProject}
                    title={hint.text}
                    className="group inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                  >
                    <Plus className="size-3 transition-transform group-hover:rotate-90" />
                    {hint.label}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setManagingHints(true)}
                  className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                >
                  <Settings2 className="size-3.5" />
                  Manage
                </button>
              </div>
            </div>
                </div>
              )}
            </section>

            {/* action band */}
            <div className="-mx-6 mt-2 flex flex-col gap-3 border-t border-border/60 bg-muted/60 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              {activeProject ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Activity className="size-3.5" />
                  Runs in{' '}
                  <span className="font-mono font-medium text-foreground">{activeProject.name}</span>
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-xs font-medium text-amber-600">
                  <TriangleAlert className="size-3.5" />
                  No project selected — choose one in the sidebar.
                </p>
              )}
              <Button
                type="submit"
                size="lg"
                disabled={!canSubmit}
                title={!activeProject ? 'Select a project first' : 'Run QC  ·  ⌘/Ctrl + Enter'}
                className="group h-11 rounded-full px-6 text-sm font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    {mode === 'advanced' && runTickets.length > 1 ? 'Run feature QC' : 'Run QC'}
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
        </Card>

        <aside className="space-y-3">
          {/* Readiness — compact checklist (no big tiles), run mode folded into the footer. */}
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-2.5 p-4">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <Check className="size-4 text-muted-foreground" />
                  Run readiness
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {readyChecks.filter((c) => c.ok).length}/{readyChecks.length}
                </span>
              </div>
              <ul className="space-y-1.5">
                {readyChecks.map((item) => (
                  <li key={item.label} className="flex items-center gap-2.5 text-sm">
                    <span
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full',
                        item.ok
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {item.ok ? <Check className="size-3" /> : <Clock className="size-3" />}
                    </span>
                    <span className="shrink-0 text-muted-foreground">{item.label}</span>
                    <span className="ml-auto min-w-0 truncate font-medium">{item.value}</span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-border/60 pt-2.5 text-xs">
                <span className="text-muted-foreground">
                  {mode === 'advanced' ? 'Feature workflow' : 'Single ticket'}
                </span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
                  {selectedTestcaseLabel}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Recent runs — slim rows, status dot inline. */}
          <Card className="rounded-3xl border-border/60 shadow-none">
            <CardContent className="space-y-1 p-3">
              <div className="flex items-center justify-between px-1">
                <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
                  <Clock className="size-4 text-muted-foreground" />
                  Recent runs
                </span>
                <Link
                  to="/history"
                  className="inline-flex items-center gap-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
                >
                  All
                  <ChevronRight className="size-3" />
                </Link>
              </div>
              {recent.length === 0 ? (
                <p className="px-1 py-1.5 text-xs text-muted-foreground">No runs yet.</p>
              ) : (
                <ul>
                  {recent.slice(0, 4).map((run) => (
                    <li key={run.id}>
                      <Link
                        to={`/run/${run.id}`}
                        className="group flex items-center gap-2 rounded-xl px-1.5 py-1.5 transition-colors hover:bg-muted/50"
                      >
                        <StatusBadge status={run.status} compact />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">
                          {run.ticketId}
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                          {relativeTime(run.createdAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>

      <ManageHintsDialog
        open={managingHints}
        onOpenChange={setManagingHints}
        hints={hints}
        addHint={createHint}
        updateHint={updateHint}
        removeHint={removeHint}
        resetHints={resetHints}
      />

      <RunPresetsDialog
        open={managingPresets}
        onOpenChange={setManagingPresets}
        presets={presets}
        current={{
          mode,
          appUrl,
          skill,
          instructions,
          model,
          tickets: featureTickets,
          workflowSteps: cleanSteps,
        }}
        addPreset={addPreset}
        renamePreset={renamePreset}
        removePreset={removePreset}
        onApply={applyPreset}
      />
    </div>
  )
}
