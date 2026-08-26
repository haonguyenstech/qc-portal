import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  FileDown,
  FileText,
  Loader2,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import { exportReportFile, getReportContext, type PerfJob } from '@/lib/api'
import {
  BLANK_META,
  blankRequirement,
  buildNfrReport,
  defaultCriterion,
  defaultScope,
  endpointNames,
  formatTarget,
  isRateMetric,
  METRIC_LABEL,
  nfrFileName,
  reportableRuns,
  reportTitle,
  resolveMeta,
  STATUS_LABEL,
  suggestMeta,
  suggestRequirements,
  type NfrMeta,
  type NfrMetric,
  type NfrRequirement,
  type NfrStatus,
} from '@/lib/nfrReport'
import { nfrReportHtml, nfrReportMarkdown } from '@/lib/nfrReportHtml'
import { downloadBlob, downloadText } from '@/lib/perfReport'

/**
 * NFR REPORT BUILDER — the load tab's deliverable, as opposed to its readout.
 *
 * The run report above this panel answers "how did that run go?". This one answers
 * the question a client asks at the end of a test phase: "did the system meet the
 * non-functional requirements we agreed?" Those are different documents, so this is
 * a separate panel rather than more buttons on the existing one.
 *
 * Everything here is kept in localStorage per project, NOT on the server: the
 * requirements are the engineer's working notes about a client's acceptance
 * criteria, they change between rounds, and putting them in the database would
 * mean a migration for a list that belongs to whoever is writing the report.
 *
 * The one constraint worth knowing: **runs live in the server's memory** and are
 * lost when it restarts, so a report can only be composed from runs still listed.
 * The panel says so rather than letting a selection quietly empty itself.
 */

const META_PREFIX = 'qc.perfNfrMeta.' // + <projectId>
const REQS_PREFIX = 'qc.perfNfrReqs.' // + <projectId>

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — the panel still works for this session */
  }
}

const STATUS_CLASS: Record<NfrStatus, string> = {
  pass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-destructive/10 text-destructive',
  mixed: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  risk: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  pending: 'bg-muted text-muted-foreground',
}

const METRICS: NfrMetric[] = ['p95', 'p50', 'max', 'error-rate', 'success-rate']

/**
 * One labelled field.
 *
 * `auto` marks a field the portal has worked out for itself. The badge is shown only
 * while the field is EMPTY, because that is exactly when the derived value is the
 * one the report will use — once something is typed, the suggestion is irrelevant
 * and saying otherwise would be a lie about what the document contains.
 */
function Field({
  label,
  hint,
  auto,
  children,
}: {
  label: string
  hint?: string
  auto?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-medium">{label}</Label>
        {auto ? (
          <span className="rounded-xl bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            auto
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** One requirement's row in the editor. */
function RequirementEditor({
  requirement,
  index,
  available,
  onChange,
  onRemove,
}: {
  requirement: NfrRequirement
  index: number
  available: string[]
  onChange: (next: NfrRequirement) => void
  onRemove: () => void
}) {
  const rate = isRateMetric(requirement.metric)
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/40 p-3.5 transition-all duration-200 hover:border-border">
      <div className="flex items-start gap-2">
        <div className="grid flex-1 gap-3 sm:grid-cols-[130px_1fr]">
          <Field label="ID">
            <Input
              value={requirement.id}
              placeholder="NFR-P001"
              className="h-8 rounded-xl text-xs"
              onChange={(e) => onChange({ ...requirement, id: e.target.value })}
            />
          </Field>
          <Field label="Scope (summary table)" auto={!requirement.scope.trim()}>
            <Input
              value={requirement.scope}
              // The metric and the target already say this exactly. An untyped scope
              // is filled from them rather than printing "—" in the summary table.
              placeholder={defaultScope(requirement)}
              className="h-8 rounded-xl text-xs"
              onChange={(e) => onChange({ ...requirement, scope: e.target.value })}
            />
          </Field>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove requirement ${index + 1}`}
          className="size-8 shrink-0 rounded-full text-muted-foreground transition-all duration-200 hover:text-destructive active:scale-[0.98]"
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <div className="mt-3">
        <Field
          label="Acceptance criterion"
          auto={!requirement.criterion.trim()}
          hint="Quoted verbatim in section 2 of the report."
        >
          <Textarea
            value={requirement.criterion}
            placeholder={defaultCriterion(requirement)}
            rows={2}
            className="rounded-xl text-xs"
            onChange={(e) => onChange({ ...requirement, criterion: e.target.value })}
          />
        </Field>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Judged on">
          <Select
            value={requirement.metric}
            onValueChange={(v) => {
              const metric = v as NfrMetric
              // ms and 0–1 rates are not interchangeable, so switching between the
              // two families resets the target rather than reading 3000 as 300000%.
              const changedFamily = isRateMetric(metric) !== isRateMetric(requirement.metric)
              onChange({
                ...requirement,
                metric,
                target: changedFamily
                  ? metric === 'success-rate'
                    ? 0.99
                    : isRateMetric(metric)
                      ? 0.01
                      : 3000
                  : requirement.target,
              })
            }}
          >
            <SelectTrigger className="h-8 rounded-xl text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METRICS.map((m) => (
                <SelectItem key={m} value={m} className="text-xs">
                  {METRIC_LABEL[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={rate ? 'Target (%)' : 'Target (ms)'}
          hint={`Reads as ${formatTarget(requirement.metric, requirement.target)}`}
        >
          <Input
            type="number"
            min={0}
            step={rate ? 0.1 : 100}
            value={rate ? Number((requirement.target * 100).toFixed(3)) : requirement.target}
            className="h-8 rounded-xl text-xs"
            onChange={(e) => {
              const raw = Number(e.target.value)
              const value = Number.isFinite(raw) ? Math.max(0, raw) : 0
              onChange({ ...requirement, target: rate ? value / 100 : value })
            }}
          />
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="Test cases covered"
          hint={
            available.length
              ? 'Nothing ticked means every endpoint in the selected runs.'
              : 'Select a completed run above to choose endpoints.'
          }
        >
          <div className="flex flex-wrap gap-1.5">
            {available.map((name) => {
              const on = requirement.endpoints.some((n) => n.toLowerCase() === name.toLowerCase())
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() =>
                    onChange({
                      ...requirement,
                      endpoints: on
                        ? requirement.endpoints.filter(
                            (n) => n.toLowerCase() !== name.toLowerCase(),
                          )
                        : [...requirement.endpoints, name],
                    })
                  }
                  className={cn(
                    'rounded-xl border px-2.5 py-1 text-[11px] transition-all duration-200 active:scale-[0.98]',
                    on
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border/60 bg-background text-muted-foreground hover:border-border',
                  )}
                >
                  {name}
                </button>
              )
            })}
            {!available.length ? (
              <span className="text-[11px] text-muted-foreground">No endpoints yet.</span>
            ) : null}
          </div>
        </Field>
      </div>

      <div className="mt-3">
        <Field
          label="Not run this round (optional)"
          hint="Filling this in reports the requirement as PENDING — never Pass or Failed — whatever the runs contain."
        >
          <Input
            value={requirement.pendingReason}
            placeholder="Waiting for EP-885 to be fixed"
            className="h-8 rounded-xl text-xs"
            onChange={(e) => onChange({ ...requirement, pendingReason: e.target.value })}
          />
        </Field>
      </div>
    </div>
  )
}

export default function NfrReportPanel({
  projectId,
  projectName,
  jobs,
}: {
  projectId: string
  /** Names the system under test on the cover, unless the engineer overrides it. */
  projectName?: string
  jobs: PerfJob[]
}) {
  const [open, setOpen] = useState(false)
  const [meta, setMeta] = useState<NfrMeta>(() => ({
    ...BLANK_META,
    ...read<Partial<NfrMeta>>(META_PREFIX + projectId, {}),
  }))
  const [requirements, setRequirements] = useState<NfrRequirement[]>(() =>
    read<NfrRequirement[]>(REQS_PREFIX + projectId, []),
  )
  /**
   * `null` means "the engineer has not picked yet", which is different from "picked
   * nothing" — the first shows the newest run ticked, the second shows none. Both
   * the default AND the pruning of runs that no longer exist are DERIVED from this
   * plus the live run list, so neither needs an effect to keep them in step: a run
   * that vanished (server restart, or the 40-run cap) simply stops being selected
   * on the next render instead of leaving a dangling id behind.
   */
  const [picked, setPicked] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'pdf' | 'docx' | null>(null)
  const [copied, setCopied] = useState(false)

  const runs = useMemo(() => reportableRuns(jobs), [jobs])

  const selected = useMemo(() => {
    const wanted = picked ?? (runs.length ? [runs[0].id] : [])
    return wanted.filter((id) => runs.some((r) => r.id === id))
  }, [picked, runs])

  function toggleRun(id: string): void {
    setPicked(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  function updateMeta(next: NfrMeta): void {
    setMeta(next)
    write(META_PREFIX + projectId, next)
  }

  /**
   * Takes an updater rather than the next array. Two edits dispatched in the same
   * tick — add, add — both read the same `requirements` closure and the second
   * silently overwrites the first; the functional form composes instead.
   */
  function updateRequirements(
    change: (current: NfrRequirement[]) => NfrRequirement[],
  ): void {
    setRequirements((current) => {
      const next = change(current)
      write(REQS_PREFIX + projectId, next)
      return next
    })
  }

  const chosen = useMemo(
    () => selected.map((id) => runs.find((r) => r.id === id)).filter((r): r is PerfJob => !!r),
    [selected, runs],
  )
  const available = useMemo(() => endpointNames(chosen), [chosen])

  /**
   * The machine's own facts (git identity, hostname, OS). Cheap, and it does not
   * change while the panel is open, so it is fetched once and reused; a failure is
   * silent because every field it feeds falls back to being typed.
   */
  const { data: context } = useQuery({
    queryKey: ['perf-report-context', projectId],
    queryFn: () => getReportContext(projectId),
    enabled: !!projectId,
    staleTime: 10 * 60_000,
  })

  /**
   * Everything the portal can work out, recomputed from the CURRENT run selection.
   * `resolveMeta` then prefers whatever was typed — so a suggestion never overwrites
   * an edit, and swapping runs updates the derived fields without an effect racing
   * the user's keystrokes.
   */
  const suggested = useMemo(
    () =>
      suggestMeta(chosen, {
        projectName,
        tester: context?.tester,
        host: context?.host,
        platform: context?.platform,
      }),
    [chosen, projectName, context],
  )
  const effective = useMemo(() => resolveMeta(meta, suggested), [meta, suggested])
  /** Fields still running on a suggestion — what the "auto" badge marks. */
  const autoFilled = useMemo(
    () =>
      (Object.keys(BLANK_META) as (keyof NfrMeta)[]).filter(
        (key) => !meta[key].trim() && !!suggested[key].trim(),
      ),
    [meta, suggested],
  )
  const isAuto = (key: keyof NfrMeta) => autoFilled.includes(key)

  /** Materialise every suggestion into the form, so it can be edited rather than accepted whole. */
  function acceptSuggestions(): void {
    updateMeta(effective)
    toast.success(
      `Filled in ${autoFilled.length} field${autoFilled.length === 1 ? '' : 's'} — edit any of them freely`,
    )
  }

  /**
   * The requirements the chosen runs already imply.
   *
   * "Fail if p95 over 2000ms" IS an acceptance criterion — it was typed into the load
   * form before the run started. Asking for the same number a second time invites the
   * two copies to disagree, and the report is then judged against the wrong one.
   * Already-present targets are dropped so the button never duplicates a row.
   */
  const suggestedRequirements = useMemo(() => {
    const have = new Set(requirements.map((r) => `${r.metric}:${r.target}`))
    return suggestRequirements(chosen).filter((r) => !have.has(`${r.metric}:${r.target}`))
  }, [chosen, requirements])

  /** A new blank requirement starts at the p95 target the runs were actually run with. */
  const defaultP95Target = useMemo(() => {
    const targets = chosen
      .map((job) => job.loadConfig?.thresholdP95Ms ?? 0)
      .filter((t) => t > 0)
    return targets.length ? Math.min(...targets) : 3000
  }, [chosen])

  function addSuggestedRequirements(): void {
    const additions = suggestedRequirements
    updateRequirements((current) => [
      ...current,
      ...additions.map((r, i) => ({
        ...r,
        id: `NFR-P${String(current.length + i + 1).padStart(3, '0')}`,
      })),
    ])
    toast.success(
      `Added ${additions.length} requirement${additions.length === 1 ? '' : 's'} from the run thresholds`,
    )
  }

  const report = useMemo(
    () => buildNfrReport(effective, requirements, chosen),
    [effective, requirements, chosen],
  )

  const ready = requirements.length > 0 && chosen.length > 0
  const fileName = nfrFileName(effective)
  const footer = reportTitle(effective)

  async function exportFile(format: 'pdf' | 'docx'): Promise<void> {
    setBusy(format)
    try {
      const blob = await exportReportFile(format, nfrReportHtml(report), fileName, footer)
      downloadBlob(`${fileName}.${format}`, blob)
      toast.success(format === 'pdf' ? 'NFR report downloaded as PDF' : 'NFR report downloaded as Word')
    } catch (err) {
      toast.error(`Could not build the ${format === 'pdf' ? 'PDF' : 'Word file'}`, {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="rounded-3xl border-border/60 shadow-none">
      <CardContent className="p-4 sm:p-5">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-3 text-left"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <ClipboardList className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-tight">NFR report</span>
            <span className="block truncate text-xs text-muted-foreground">
              {requirements.length
                ? `${requirements.length} requirement${requirements.length === 1 ? '' : 's'} · ${chosen.length} run${chosen.length === 1 ? '' : 's'} selected`
                : 'Judge runs against a client’s acceptance criteria, and export the deliverable'}
            </span>
          </span>
          {open ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        {open ? (
          <div className="mt-4 space-y-5 border-t border-border/60 pt-4">
            {/* -------------------------------------------------- runs */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold tracking-tight">Runs in this report</h3>
              {runs.length ? (
                <div className="space-y-1.5">
                  {runs.map((job) => {
                    const on = selected.includes(job.id)
                    return (
                      <label
                        key={job.id}
                        className={cn(
                          'flex cursor-pointer items-center gap-2.5 rounded-2xl border px-3 py-2 transition-all duration-200',
                          on ? 'border-border bg-muted/60' : 'border-border/60 hover:border-border',
                        )}
                      >
                        <Checkbox
                          checked={on}
                          onCheckedChange={() => toggleRun(job.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium">{job.label}</span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {new Date(job.createdAt).toLocaleString()} ·{' '}
                            {job.loadConfig?.vus ?? '?'} VUs ·{' '}
                            {job.loadResult?.endpoints.length ?? 0} endpoint
                            {job.loadResult?.endpoints.length === 1 ? '' : 's'}
                          </span>
                        </span>
                      </label>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No completed load runs yet. Runs are kept in the server’s memory, so they are also
                  cleared when the portal restarts — run a load test, then build the report.
                </p>
              )}
            </section>

            {/* ------------------------------------------ report details */}
            <section className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold tracking-tight">Report details</h3>
                {autoFilled.length ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                    onClick={acceptSuggestions}
                  >
                    <Wand2 className="size-3.5" />
                    Fill in {autoFilled.length}
                  </Button>
                ) : null}
              </div>
              {/* The grey text in an empty field is not a hint here — it is what the
                  report will actually say. Saying so once beats an "auto" badge that
                  looks decorative. */}
              <p className="text-[11px] text-muted-foreground">
                Fields marked <span className="font-medium text-foreground">auto</span> are worked
                out from the selected runs, the project and this machine — the grey text is what the
                report will use. Type to override, clear to go back to it.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="System under test" auto={isAuto('system')}>
                  <Input
                    value={meta.system}
                    placeholder={suggested.system || 'NZPA Enrolment'}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, system: e.target.value })}
                  />
                </Field>
                <Field label="Phase / round" auto={isAuto('phase')}>
                  <Input
                    value={meta.phase}
                    placeholder={suggested.phase || 'Phase 4 · Second Run'}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, phase: e.target.value })}
                  />
                </Field>
                <Field
                  label="Environment"
                  auto={isAuto('environment')}
                  // Read off the endpoint hostnames. Deliberately silent rather than
                  // guessing "Production": a report wrongly presented as production
                  // evidence is the one mistake here that cannot be walked back.
                  hint={
                    suggested.environment
                      ? undefined
                      : 'The endpoint hostnames don’t say — name it yourself.'
                  }
                >
                  <Input
                    value={meta.environment}
                    placeholder={suggested.environment || 'Staging / UAT'}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, environment: e.target.value })}
                  />
                </Field>
                <Field label="Load origin" auto={isAuto('region')}>
                  <Input
                    value={meta.region}
                    placeholder={suggested.region}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, region: e.target.value })}
                  />
                </Field>
                <Field
                  label="Tested by"
                  auto={isAuto('tester')}
                  hint={context && !context.tester ? 'No git identity on this machine.' : undefined}
                >
                  <Input
                    value={meta.tester}
                    placeholder={suggested.tester || 'Your name'}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, tester: e.target.value })}
                  />
                </Field>
                <Field
                  label="Test date"
                  auto={isAuto('testDate')}
                  hint={suggested.testDate ? `First selected run: ${suggested.testDate}` : undefined}
                >
                  <Input
                    type="date"
                    value={meta.testDate}
                    className="h-8 rounded-xl text-xs"
                    onChange={(e) => updateMeta({ ...meta, testDate: e.target.value })}
                  />
                </Field>
              </div>
              <Field
                label="Systems in scope"
                auto={isAuto('environments')}
                hint="One per line, as `Name: https://…`."
              >
                <Textarea
                  value={meta.environments}
                  rows={3}
                  placeholder={
                    suggested.environments ||
                    'BlueBeat: https://epstaging.crm6.dynamics.com/\nWebsite: http://epuat.example.org/'
                  }
                  className="rounded-xl font-mono text-[11px]"
                  onChange={(e) => updateMeta({ ...meta, environments: e.target.value })}
                />
              </Field>
              <Field label="Objective and scope" auto={isAuto('objective')}>
                <Textarea
                  value={meta.objective}
                  rows={3}
                  placeholder={
                    suggested.objective ||
                    'The objective was to assess performance across the enrolment journey…'
                  }
                  className="rounded-xl text-xs"
                  onChange={(e) => updateMeta({ ...meta, objective: e.target.value })}
                />
              </Field>
              <Field label="Notes (optional)">
                <Textarea
                  value={meta.notes}
                  rows={2}
                  className="rounded-xl text-xs"
                  onChange={(e) => updateMeta({ ...meta, notes: e.target.value })}
                />
              </Field>
            </section>

            {/* ------------------------------------------- requirements */}
            <section className="space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold tracking-tight">
                  Requirements and acceptance criteria
                </h3>
                <div className="flex items-center gap-2">
                  {suggestedRequirements.length ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                      onClick={addSuggestedRequirements}
                    >
                      <Wand2 className="size-3.5" />
                      From run thresholds ({suggestedRequirements.length})
                    </Button>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                    onClick={() =>
                      updateRequirements((current) => [
                        ...current,
                        { ...blankRequirement(current.length), target: defaultP95Target },
                      ])
                    }
                  >
                    <Plus className="size-3.5" />
                    Add requirement
                  </Button>
                </div>
              </div>
              {requirements.length ? (
                <div className="space-y-2.5">
                  {requirements.map((requirement, i) => (
                    <RequirementEditor
                      key={i}
                      requirement={requirement}
                      index={i}
                      available={available}
                      onChange={(next) =>
                        updateRequirements((current) =>
                          current.map((r, j) => (j === i ? next : r)),
                        )
                      }
                      onRemove={() =>
                        updateRequirements((current) => current.filter((_, j) => j !== i))
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Add the requirements the client signed off on. Each one is judged against the
                  selected runs and lands in the report’s executive summary.
                </p>
              )}
            </section>

            {/* ----------------------------------------------- preview */}
            {requirements.length ? (
              <section className="space-y-2">
                <h3 className="text-xs font-semibold tracking-tight">Executive summary</h3>
                <div className="overflow-x-auto rounded-2xl border border-border/60">
                  <table className="w-full min-w-[520px] text-left text-xs">
                    <thead className="bg-muted/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">Requirement</th>
                        <th className="px-3 py-2 font-medium">Scope</th>
                        <th className="px-3 py-2 font-medium">Key result</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.requirements.map((r, i) => (
                        <tr key={i} className="border-t border-border/60">
                          <td className="px-3 py-2 font-medium">{r.requirement.id || '—'}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {r.requirement.scope || '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{r.keyResult}</td>
                          <td className="px-3 py-2">
                            <span
                              className={cn(
                                'inline-flex rounded-xl px-2 py-0.5 text-[10px] font-semibold',
                                STATUS_CLASS[r.status],
                              )}
                            >
                              {STATUS_LABEL[r.status]}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted-foreground">{report.finalAssessment}</p>
              </section>
            ) : null}

            {/* ------------------------------------------------ export */}
            <section className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-4">
              <Button
                variant="outline"
                size="sm"
                disabled={!ready || busy !== null}
                className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                onClick={() => void exportFile('pdf')}
              >
                {busy === 'pdf' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileDown className="size-3.5" />
                )}
                PDF
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!ready || busy !== null}
                className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                onClick={() => void exportFile('docx')}
              >
                {busy === 'docx' ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileText className="size-3.5" />
                )}
                Word
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!ready}
                className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                onClick={() => {
                  void navigator.clipboard.writeText(nfrReportMarkdown(report)).then(
                    () => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                      toast.success('NFR report copied as Markdown')
                    },
                    () => toast.error('Could not copy the report'),
                  )
                }}
              >
                <Copy className="size-3.5" />
                {copied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!ready}
                className="h-8 rounded-full text-xs transition-all duration-200 active:scale-[0.98]"
                onClick={() => {
                  downloadText(`${fileName}.md`, nfrReportMarkdown(report), 'text/markdown')
                  toast.success('Markdown report downloaded')
                }}
              >
                <Download className="size-3.5" />
                .md
              </Button>
              {!ready ? (
                <span className="text-[11px] text-muted-foreground">
                  {chosen.length
                    ? 'Add at least one requirement to export.'
                    : 'Select at least one completed run to export.'}
                </span>
              ) : null}
            </section>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
