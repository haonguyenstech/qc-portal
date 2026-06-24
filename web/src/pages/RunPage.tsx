import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
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
  Sparkles,
  Ticket,
  TriangleAlert,
  Wand2,
  Workflow,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import { TicketTestCasePicker, testcaseRelPath } from '@/components/TicketTestCasePicker'

// Which Claude model drives the QC run. `auto` sends no --model flag, so the
// project's configured default is used (this is the historical behavior).
// The others map to --model haiku/sonnet/opus on the headless claude spawn.
const RUN_MODEL_KEY = 'qc.runModel'
type QcModel = {
  value: string
  label: string
  tag: string
  icon: typeof Cpu
  description: string
}
const QC_MODELS: QcModel[] = [
  {
    value: 'auto',
    label: 'Auto',
    tag: 'project default',
    icon: Wand2,
    description:
      "Uses Claude's configured default model — pick this if you're not sure which to choose.",
  },
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
  return 'auto'
}

// Simple = one ticket, one run (the original flow). Advanced = pick several
// related tickets + define an ordered feature workflow, all driven as one run.
type RunMode = 'simple' | 'advanced'
const RUN_MODE_KEY = 'qc.runMode'
const MAX_FEATURE_TICKETS = 5

function loadRunMode(): RunMode {
  try {
    return localStorage.getItem(RUN_MODE_KEY) === 'advanced' ? 'advanced' : 'simple'
  } catch {
    return 'simple'
  }
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
      <div className="overflow-hidden rounded-lg border bg-background">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            disabled={disabled}
            placeholder="Filter crawled tickets by id or title…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
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
            filtered.map((t) => {
              const id = ticketIdOf(t)
              const isSel = value.includes(id)
              const blocked = !isSel && atMax
              return (
                <button
                  key={t.name}
                  type="button"
                  disabled={disabled || blocked}
                  onClick={() => toggle(id)}
                  title={blocked ? `Up to ${MAX_FEATURE_TICKETS} tickets per run` : undefined}
                  className={cn(
                    'flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors',
                    isSel ? 'bg-primary/10' : 'hover:bg-accent',
                    blocked && 'cursor-not-allowed opacity-40 hover:bg-transparent',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-4 shrink-0 place-items-center rounded border',
                      isSel
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40',
                    )}
                    aria-hidden
                  >
                    {isSel && <Check className="size-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="truncate font-mono text-xs font-semibold">{id}</span>
                    {t.title && <span className="line-clamp-1 text-sm">{t.title}</span>}
                  </span>
                </button>
              )
            })
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
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
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
  const { activeProject } = useProjects()
  const [ticketId, setTicketId] = useState('')
  const [appUrl, setAppUrl] = useState('')
  const [skill, setSkill] = useState('')
  const [model, setModel] = useState<string>(loadRunModel)
  const [instructions, setInstructions] = useState('')
  const [mode, setMode] = useState<RunMode>(loadRunMode)
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
    setSkill(saved?.skill ?? '') // reconciled against the skills list below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject?.id])

  const appUrlInvalid = appUrl.trim().length > 0 && !isValidHttpUrl(appUrl)

  // Default to qc-testing when present, otherwise the first available skill.
  useEffect(() => {
    if (!skills || skills.length === 0) return
    setSkill((prev) => {
      if (prev && skills.some((s) => s.name === prev)) return prev
      return skills.find((s) => s.name === 'qc-testing')?.name ?? skills[0].name
    })
  }, [skills])

  const activeSkill = useMemo(
    () => skills?.find((s) => s.name === skill),
    [skills, skill],
  )

  const modelInfo = QC_MODELS.find((m) => m.value === model) ?? QC_MODELS[0]
  function chooseModel(value: string) {
    setModel(value)
    try {
      localStorage.setItem(RUN_MODEL_KEY, value)
    } catch {
      /* storage unavailable */
    }
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
    setMode(next)
    try {
      localStorage.setItem(RUN_MODE_KEY, next)
    } catch {
      /* storage unavailable */
    }
  }

  // Load a saved template into the form. Switches mode and fills the matching
  // fields; the ticket(s) are restored for feature templates (simple templates
  // never carry a ticket, so the ticket field is left as-is).
  function applyPreset(p: RunPreset) {
    const nextMode: RunMode = p.mode === 'advanced' ? 'advanced' : 'simple'
    setMode(nextMode)
    try {
      localStorage.setItem(RUN_MODE_KEY, nextMode)
    } catch {
      /* storage unavailable */
    }
    setAppUrl(p.appUrl)
    if (p.skill) setSkill(p.skill)
    setInstructions(p.instructions)
    chooseModel(p.model && QC_MODELS.some((m) => m.value === p.model) ? p.model : 'auto')
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
  const canSubmit =
    !submitting && !!leadTicket && !!appUrl.trim() && !appUrlInvalid && !!activeProject
  const recent = recentRuns ?? []
  const liveRuns = recent.filter((run) => run.status === 'running' || run.status === 'queued').length
  const completedRuns = recent.filter((run) => run.status === 'passed' || run.status === 'failed').length
  const selectedTestcaseLabel =
    mode === 'simple' && testcaseVersion != null ? `v${testcaseVersion}` : mode === 'advanced' ? `${cleanSteps.length} step${cleanSteps.length === 1 ? '' : 's'}` : 'Optional'
  const readyChecks = [
    { label: 'Project', ok: !!activeProject, value: activeProject?.name ?? 'Select one' },
    { label: mode === 'advanced' ? 'Lead ticket' : 'Ticket', ok: !!leadTicket, value: leadTicket || 'Choose ticket' },
    { label: 'App URL', ok: !!appUrl.trim() && !appUrlInvalid, value: appUrlInvalid ? 'Invalid URL' : appUrl.trim() ? 'Ready' : 'Required' },
    { label: 'Skill', ok: !!skill, value: skill || 'Choose skill' },
  ]

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!leadTicket || !appUrl.trim() || !activeProject) return
    if (!isValidHttpUrl(appUrl)) {
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
        appUrl: appUrl.trim(),
        skill: skill || undefined,
        instructions: finalInstructions || undefined,
        model: model === 'auto' ? undefined : model,
        relatedTickets:
          mode === 'advanced' && runTickets.length > 1 ? runTickets.slice(1) : undefined,
        workflowSteps: mode === 'advanced' && cleanSteps.length ? cleanSteps : undefined,
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
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="border-b bg-gradient-to-br from-muted/80 via-card to-card px-6 py-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm ring-1 ring-black/5">
                <Play className="size-5" />
              </span>
              <div className="space-y-2">
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
              <div className="rounded-lg border bg-background/80 px-3 py-2 shadow-xs">
                <div className="text-lg font-semibold tabular-nums">{recent.length}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Runs
                </div>
              </div>
              <div className="rounded-lg border bg-background/80 px-3 py-2 shadow-xs">
                <div className="text-lg font-semibold tabular-nums">{liveRuns}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Live
                </div>
              </div>
              <div className="rounded-lg border bg-background/80 px-3 py-2 shadow-xs">
                <div className="text-lg font-semibold tabular-nums">{completedRuns}</div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Complete
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <Card className="overflow-hidden border-border/60 py-0 shadow-md">
          <CardHeader className="gap-3 border-b bg-muted/25 py-5">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <Sparkles className="size-5" />
            </span>
            <div className="space-y-1">
              <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
                New run
                {activeProject && (
                  <Badge variant="secondary" className="gap-1 font-normal">
                    <span className="size-1.5 rounded-full bg-emerald-500" />
                    {activeProject.name}
                  </Badge>
                )}
              </CardTitle>
              <CardDescription>
                {activeProject
                  ? 'Point Claude at a ticket and a live URL — when you start, it opens the Running page to track progress.'
                  : 'Select a project in the sidebar to start a run.'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-6">
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
              <div className="inline-flex w-full rounded-lg border bg-muted/40 p-1 sm:w-auto">
                {(
                  [
                    { value: 'simple' as const, label: 'Single ticket', icon: Sparkles },
                    { value: 'advanced' as const, label: 'Feature (advanced)', icon: Workflow },
                  ]
                ).map((opt) => {
                  const Icon = opt.icon
                  const active = mode === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => chooseMode(opt.value)}
                      aria-pressed={active}
                      className={cn(
                        'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all sm:flex-none',
                        active
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                      {opt.label}
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
                className="gap-1.5"
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
              <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/[0.03] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
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

            <div className="space-y-5">
              {mode === 'simple' ? (
                <>
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
                </>
              ) : (
                <>
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
                </>
              )}

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
                    className="h-11 pl-9 font-mono text-sm shadow-xs transition-shadow focus-visible:shadow-sm"
                  />
                </div>
                {appUrlInvalid ? (
                  <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                    <TriangleAlert className="size-3.5" />
                    Enter a full http:// or https:// URL.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">The deployed page Claude should open and test.</p>
                )}
              </div>
            </div>

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
                {modelInfo.description}
              </p>
              {/* why-to-choose guidance: best result vs. best fee */}
              <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span>
                  <span className="font-medium text-foreground">Choosing a model:</span> for the
                  best result on a long or tricky ticket pick{' '}
                  <span className="font-medium text-foreground">Opus</span>; for the lowest fee on a
                  small, clear ticket pick <span className="font-medium text-foreground">Haiku</span>
                  ; <span className="font-medium text-foreground">Sonnet</span> is the recommended
                  balance of quality and cost for most runs.
                </span>
              </div>
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

            {/* action band */}
            <div className="-mx-6 mt-2 flex flex-col gap-3 border-t bg-muted/40 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
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
                className="group h-11 px-6 text-sm font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.98]"
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

        <aside className="space-y-4">
          <Card className="overflow-hidden py-0 shadow-sm">
            <CardHeader className="border-b bg-gradient-to-br from-muted/70 via-card to-card py-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Check className="size-4 text-muted-foreground" />
                Run readiness
              </CardTitle>
              <CardDescription>Everything needed before Claude can start testing.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              {readyChecks.map((item) => (
                <div key={item.label} className="flex items-center gap-3 rounded-lg border bg-background/70 p-3">
                  <span
                    className={cn(
                      'flex size-7 shrink-0 items-center justify-center rounded-full',
                      item.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    {item.ok ? <Check className="size-4" /> : <Clock className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {item.label}
                    </div>
                    <div className="truncate text-sm font-medium">{item.value}</div>
                  </div>
                </div>
              ))}
              <div className="rounded-lg border bg-muted/30 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Run mode
                </div>
                <div className="mt-1 flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">
                    {mode === 'advanced' ? 'Feature workflow' : 'Single ticket'}
                  </span>
                  <span className="rounded-full bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
                    {selectedTestcaseLabel}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden py-0 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 border-b py-4">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4 text-muted-foreground" />
                Recent runs
              </CardTitle>
              <Link
                to="/history"
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                View all
                <ChevronRight className="size-3" />
              </Link>
            </CardHeader>
            <CardContent className="p-0">
              {recent.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  No runs yet. Start one and it will appear here.
                </div>
              ) : (
                <ul className="divide-y divide-border/60">
                  {recent.slice(0, 5).map((run) => (
                    <li key={run.id}>
                      <Link
                        to={`/run/${run.id}`}
                        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-sm font-medium">{run.ticketId}</div>
                          <div className="mt-1 flex items-center gap-2">
                            <StatusBadge status={run.status} />
                            <span className="text-xs tabular-nums text-muted-foreground">
                              {relativeTime(run.createdAt)}
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="bg-primary text-primary-foreground shadow-sm">
            <CardContent className="space-y-2 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Lightbulb className="size-4" />
                Tip
              </div>
              <p className="text-sm leading-6 text-primary-foreground/80">
                Use Sonnet for most QC runs. Switch to Opus when the ticket is broad, ambiguous,
                or spans multiple related workflows.
              </p>
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
