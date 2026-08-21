// API flows — run a collection of saved requests as ONE scenario.
//
// A single request can't test "log in → create a claim → verify it appears", which is
// what most API acceptance criteria actually say. A flow is an ordered list of the
// project's saved requests; running it sends them one at a time and lets each step's
// `captures` feed the next step's `{{variables}}` (the login step captures the token,
// later steps send it as `Authorization`). This is the "run collection" shape.
//
// The run is driven HERE, in the browser, one `POST /send` per step, because:
//  - `/send` already resolves `{{vars}}`, injects `{{account.<label>.password}}` and a
//    live `{{otp.<label>}}`, and masks secrets out of everything it echoes back, and
//  - assertions are graded by `lib/apiAssert.ts`, the same engine the single-request
//    builder uses — a step must never grade differently from that request run alone.
// The server owns the flow DEFINITION and the saved REPORT (verdicts only, no bodies).

import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  CircleSlash,
  Download,
  KeyRound,
  Loader2,
  Pencil,
  Play,
  Plus,
  Route,
  Search,
  Save,
  ShieldCheck,
  SkipForward,
  TerminalSquare,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { evaluateAssertions, getJsonPath } from '@/lib/apiAssert'
import { deriveName, uniqueName, type ApiDraft } from '@/lib/apiDraft'
import { CurlImportDialog } from '@/components/CurlImportDialog'
import {
  captureApiVariable,
  deleteApiAccount,
  deleteApiFlow,
  importApiAccounts,
  listApiAccountCandidates,
  listApiAccounts,
  listApiFlowRuns,
  listApiFlows,
  listTotp,
  renameApiFlow,
  saveApiAccount,
  saveApiFlow,
  saveApiFlowRun,
  saveApiRequest,
  sendApiRequest,
  type ApiAccount,
  type ApiFlow,
  type ApiFlowRun,
  type ApiFlowRunStep,
  type ApiFlowStep,
  type ApiRequestDef,
} from '@/lib/api'

// ---------------------------------------------------------------- run model

type StepOutcome = 'pending' | 'running' | 'pass' | 'fail' | 'skipped' | 'error'

interface StepRun {
  step: ApiFlowStep
  outcome: StepOutcome
  status: number | null
  timeMs: number
  method: string
  url: string
  checks: { passed: number; total: number }
  detail: string
  captured: string[]
}

const OUTCOME_TONE: Record<StepOutcome, string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary',
  pass: 'text-emerald-600',
  fail: 'text-destructive',
  error: 'text-destructive',
  skipped: 'text-amber-600',
}

function newStepId(): string {
  return `s${Math.random().toString(36).slice(2, 9)}`
}

/**
 * The numbered pane label, matching the request builder's step chips — Flows is a tab
 * of the same page, so "scenario → steps → what happened" has to read the same way as
 * "request → configure → result".
 */
function FlowChip({ n, children }: { n: number; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold text-background">
        {n}
      </span>
      {children}
    </span>
  )
}

// ---------------------------------------------------------------- flows workspace

/**
 * The Flows tab of /api-testing: a rail of the project's flows on the left, the picked
 * flow's editor + runner on the right. This used to be a small card in the requests
 * sidebar that opened the editor in a DIALOG, and every problem with it came from that:
 * the steps list is wide (method, name, URL, live verdict, "soft" toggle, four buttons),
 * a run takes as long as the API does, and a modal both cramped that and hid the saved
 * requests you were adding steps from. On the page it also gets a URL (`?tab=flows`),
 * so a scenario is linkable and survives a reload — and the nested-dialog dismissal
 * guards the old code needed are simply gone.
 */
export function ApiFlowsWorkspace({
  projectId,
  saved,
}: {
  projectId: string
  saved: ApiRequestDef[]
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const { data, isLoading } = useQuery({
    queryKey: ['api-flows', projectId],
    queryFn: () => listApiFlows(projectId),
  })
  // Memoised so the search below doesn't recompute on every unrelated render.
  const flows = useMemo(() => data?.flows ?? [], [data])

  // Land on something rather than an empty pane: the picked flow, else the first one.
  const active = flows.find((f) => f.name === selected) ?? flows[0] ?? null

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return flows
    return flows.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.description ?? '').toLowerCase().includes(q) ||
        f.steps.some((s) => s.requestName.toLowerCase().includes(q)),
    )
  }, [flows, filter])

  const create = useMutation({
    mutationFn: (name: string) =>
      saveApiFlow(projectId, name, {
        description: '',
        stopOnFail: true,
        auth: { accountLabel: '', totpLabel: '' },
        steps: [],
      }),
    onSuccess: ({ flow }) => {
      queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
      setSelected(flow.name)
      setFilter('')
    },
    onError: (e) =>
      toast.error('Could not create the flow', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  function addFlow() {
    // Unique-by-default name so two quick clicks don't overwrite one flow.
    const base = 'New flow'
    let name = base
    for (let i = 2; flows.some((f) => f.name === name); i++) name = `${base} ${i}`
    create.mutate(name)
  }

  return (
    <>
      <div className="grid gap-5 lg:grid-cols-[minmax(228px,268px)_minmax(0,1fr)]">
        {/* ------------------------------------------------------------ the rail */}
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <section className="space-y-2 rounded-2xl border border-border/60 bg-card p-3 shadow-none">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Route className="size-3.5 shrink-0" />
                <span className="truncate">Flows</span>
                {flows.length > 0 && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                    {flows.length}
                  </span>
                )}
              </span>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={addFlow}
              disabled={create.isPending}
              className="h-8 w-full gap-1.5 rounded-full text-xs active:scale-[0.98]"
              title="Create an empty flow"
            >
              {create.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              New flow
            </Button>

            {flows.length > 3 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="search"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Search flows…"
                  aria-label="Search flows"
                  className="h-8 pl-8 text-xs shadow-none [&::-webkit-search-cancel-button]:hidden"
                />
              </div>
            )}

            <div className="-mx-1 max-h-[52vh] space-y-1 overflow-y-auto px-1">
              {isLoading && (
                <p className="px-1 py-2 text-[11px] text-muted-foreground">Loading…</p>
              )}
              {!isLoading && flows.length === 0 && (
                <div className="space-y-2 rounded-xl border border-dashed border-border/60 p-3 text-center">
                  <p className="text-xs font-medium">No flows yet</p>
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    A flow runs several saved requests in order — log in, capture the token, then
                    the steps that need it.
                  </p>
                </div>
              )}
              {!isLoading && flows.length > 0 && shown.length === 0 && (
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                  No flows match “{filter.trim()}”.
                </p>
              )}
              {shown.map((f) => {
                const enabled = f.steps.filter((s) => s.enabled).length
                const isActive = active?.name === f.name
                return (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => setSelected(f.name)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-all duration-200 active:scale-[0.99]',
                      isActive
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border/60 bg-muted/40 hover:border-border hover:bg-muted/70',
                    )}
                  >
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-xs font-medium">{f.name}</span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {enabled} step{enabled === 1 ? '' : 's'}
                        {f.description ? ` · ${f.description}` : ''}
                      </span>
                    </span>
                    <ChevronRight
                      className={cn(
                        'size-3.5 shrink-0',
                        isActive ? 'text-primary' : 'text-muted-foreground',
                      )}
                    />
                  </button>
                )
              })}
            </div>
          </section>

          {/* The identities a flow logs in with — one click from where they're used. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAccountsOpen(true)}
            className="h-8 w-full gap-1.5 rounded-full text-xs active:scale-[0.98]"
            title="Test accounts and 2FA authenticators a flow can run as"
          >
            <KeyRound className="size-3.5" />
            Test accounts
          </Button>
        </aside>

        {/* --------------------------------------------------------- the editor */}
        {active ? (
          // Keyed by name so the draft state re-seeds when you switch flows — the
          // editor reads the flow ONCE on mount, exactly as the dialog did.
          <ApiFlowEditor
            key={active.name}
            projectId={projectId}
            flow={active}
            saved={saved}
            onManageAccounts={() => setAccountsOpen(true)}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <section className="rounded-2xl border border-dashed border-border/60 bg-card/40 p-8 text-center shadow-none">
            <span className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
              <Route className="size-5" />
            </span>
            <h2 className="mt-3 text-base font-semibold tracking-tight">
              Run several requests as one scenario
            </h2>
            <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-muted-foreground">
              Most acceptance criteria read “log in → create something → check it's listed”. A flow
              is that, in order: each step is a saved request, and what a step captures becomes the{' '}
              <code className="rounded bg-muted px-1 text-[11px]">{'{{variables}}'}</code> the next
              ones send.
            </p>
            <Button onClick={addFlow} disabled={create.isPending} className="mt-4 gap-1.5 rounded-full">
              {create.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              New flow
            </Button>
          </section>
        )}
      </div>

      {accountsOpen && (
        <ApiAccountsDialog projectId={projectId} onClose={() => setAccountsOpen(false)} />
      )}
    </>
  )
}

// ---------------------------------------------------------------- flow editor

/**
 * One flow: what it covers, who it runs as, its ordered steps, and the run. Lives on
 * the page (see ApiFlowsWorkspace) — mounted with `key={flow.name}`, so the draft below
 * is seeded once per flow and there is no stale-props effect to reconcile.
 */
function ApiFlowEditor({
  projectId,
  flow,
  saved,
  onManageAccounts,
  onDeleted,
}: {
  projectId: string
  flow: ApiFlow
  saved: ApiRequestDef[]
  onManageAccounts: () => void
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [description, setDescription] = useState(flow.description ?? '')
  const [stopOnFail, setStopOnFail] = useState(flow.stopOnFail ?? true)
  const [auth, setAuth] = useState(flow.auth ?? { accountLabel: '', totpLabel: '' })
  const [steps, setSteps] = useState<ApiFlowStep[]>(flow.steps ?? [])
  const [runs, setRuns] = useState<StepRun[] | null>(null)
  const [running, setRunning] = useState(false)
  // The step picker is INLINE — appending a step must never cost a modal round trip.
  const [adding, setAdding] = useState(false)
  // Rename is inline on the heading; the name is the flow's identity on disk, so it
  // goes through the server's rename (which moves the file) rather than a re-save.
  const [renaming, setRenaming] = useState(false)
  const [nameDraft, setNameDraft] = useState(flow.name)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Previous runs: show five, or all of them (the server keeps the newest 20).
  const [allRuns, setAllRuns] = useState(false)

  const savedByName = useMemo(() => new Map(saved.map((s) => [s.name, s])), [saved])

  const { data: history } = useQuery({
    queryKey: ['api-flow-runs', projectId, flow?.name],
    queryFn: () => listApiFlowRuns(projectId, flow.name),
  })

  const save = useMutation({
    mutationFn: () =>
      saveApiFlow(projectId, flow.name, {
        description,
        stopOnFail,
        auth,
        steps,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
      toast.success('Flow saved')
    },
    onError: (e) =>
      toast.error('Could not save the flow', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  const remove = useMutation({
    mutationFn: () => deleteApiFlow(projectId, flow.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
      toast.success('Flow deleted')
      setConfirmDelete(false)
      onDeleted()
    },
    onError: (e) =>
      toast.error('Could not delete the flow', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  const rename = useMutation({
    // The rename moves the file, which changes this editor's `key` — so it remounts and
    // re-seeds from disk. Anything unsaved would vanish (verified: renaming a flow with
    // two fresh steps came back with none), so the draft is written under the new name
    // FIRST, inside the same mutation, before the refetch can swap the component out.
    mutationFn: async (next: string) => {
      const renamed = await renameApiFlow(projectId, flow.name, next)
      if (dirty) await saveApiFlow(projectId, next, { description, stopOnFail, auth, steps })
      return renamed
    },
    onSuccess: ({ flow: renamed }) => {
      queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
      setRenaming(false)
      setNameDraft(renamed.name)
      toast.success('Flow renamed')
    },
    onError: (e) =>
      toast.error('Could not rename the flow', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  function commitRename() {
    const next = nameDraft.trim()
    if (!next || next === flow.name) {
      setRenaming(false)
      setNameDraft(flow.name)
      return
    }
    rename.mutate(next)
  }

  function move(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    setSteps(next)
  }

  /**
   * Run the flow: each enabled step in order, feeding captures forward. A failed step
   * ends the run unless the flow (or that step) says to continue; everything after is
   * marked skipped rather than silently dropped, so the report shows what wasn't run.
   */
  async function run() {
    const active = steps.filter((s) => s.enabled)
    if (!active.length) {
      toast.error('Add at least one enabled step first')
      return
    }
    // A step that says {{auth.…}} with nothing picked sends the token LITERALLY, and the
    // API answers 401 — which reads as "wrong password", not "you didn't pick an
    // account". Verified: that's exactly what the first run of this flow looked like.
    // So refuse up front and name the missing pick.
    const needs = (re: RegExp) =>
      active.some((s) => {
        const r = savedByName.get(s.requestName)
        if (!r) return false
        return re.test(
          `${r.url} ${r.body} ${[...r.headers, ...r.query].map((k) => `${k.key}${k.value}`).join(' ')}`,
        )
      })
    if (!auth.accountLabel && needs(/\{\{\s*auth\.(username|password)\s*\}\}/)) {
      toast.error('Pick an account first', {
        description:
          'A step uses {{auth.username}} / {{auth.password}} — choose one under "Run as".',
      })
      return
    }
    if (!auth.totpLabel && needs(/\{\{\s*auth\.otp\s*\}\}/)) {
      toast.error('Pick an authenticator first', {
        description: 'A step uses {{auth.otp}} — choose the 2FA authenticator under "Run as".',
      })
      return
    }
    setRunning(true)
    const started = Date.now()
    const results: StepRun[] = active.map((step) => ({
      step,
      outcome: 'pending',
      status: null,
      timeMs: 0,
      method: savedByName.get(step.requestName)?.method ?? '',
      url: savedByName.get(step.requestName)?.url ?? '',
      checks: { passed: 0, total: 0 },
      detail: '',
      captured: [],
    }))
    setRuns([...results])

    let stopped = false
    for (let i = 0; i < active.length; i++) {
      const step = active[i]
      if (stopped) {
        results[i] = {
          ...results[i],
          outcome: 'skipped',
          detail: 'skipped — an earlier step failed',
        }
        setRuns([...results])
        continue
      }
      const req = savedByName.get(step.requestName)
      if (!req) {
        results[i] = {
          ...results[i],
          outcome: 'error',
          detail: `saved request "${step.requestName}" no longer exists`,
        }
        setRuns([...results])
        if (stopOnFail && !step.continueOnFail) stopped = true
        continue
      }

      results[i] = {
        ...results[i],
        outcome: 'running',
        method: req.method,
        url: req.url,
      }
      setRuns([...results])

      let res: Awaited<ReturnType<typeof sendApiRequest>>
      try {
        res = await sendApiRequest({
          projectId,
          method: req.method,
          url: req.url,
          query: req.query,
          headers: req.headers,
          bodyMode: req.bodyMode,
          body: req.body,
          // Every step carries the identity, not just the login one: a later step may
          // re-authenticate, and the OTP has to be recomputed at ITS send time anyway.
          auth: {
            account: auth.accountLabel || undefined,
            totp: auth.totpLabel || undefined,
          },
        })
      } catch (e) {
        results[i] = {
          ...results[i],
          outcome: 'error',
          detail: e instanceof Error ? e.message : 'request failed',
        }
        setRuns([...results])
        if (stopOnFail && !step.continueOnFail) stopped = true
        continue
      }

      if (!res.ok) {
        results[i] = {
          ...results[i],
          outcome: 'error',
          timeMs: res.timeMs,
          detail: res.error ?? 'request failed',
        }
        setRuns([...results])
        if (stopOnFail && !step.continueOnFail) stopped = true
        continue
      }

      const checks = evaluateAssertions(req.assertions, res)
      const passed = checks.filter((c) => c.pass).length
      const status = res.status ?? 0
      // No assertions on a step still has to mean something — fall back to "2xx", the
      // same implicit check a QC engineer assumes when they didn't write one.
      const ok = checks.length ? passed === checks.length : status >= 200 && status < 300
      const failDetail = checks.find((c) => !c.pass)?.detail ?? `status ${status}`

      // Captures run even when the step failed — a 4xx login can still return a
      // correlation id a later step needs, and dropping them hides why it failed.
      const captured: string[] = []
      const wanted = req.captures.filter((c) => c.jsonPath.trim() && c.varName.trim())
      if (wanted.length && res.bodyText) {
        let parsed: unknown
        try {
          parsed = JSON.parse(res.bodyText)
        } catch {
          parsed = undefined
        }
        for (const c of wanted) {
          const value = parsed === undefined ? undefined : getJsonPath(parsed, c.jsonPath.trim())
          if (value === undefined || value === null || typeof value === 'object') continue
          try {
            await captureApiVariable(projectId, {
              key: c.varName.trim(),
              value: String(value),
              secret: c.secret,
            })
            captured.push(c.varName.trim())
          } catch {
            /* a failed capture shouldn't abort the run — the step report shows what stuck */
          }
        }
      }

      results[i] = {
        ...results[i],
        outcome: ok ? 'pass' : 'fail',
        status,
        timeMs: res.timeMs,
        checks: { passed, total: checks.length },
        detail: ok ? '' : failDetail,
        captured,
      }
      setRuns([...results])
      if (!ok && stopOnFail && !step.continueOnFail) stopped = true
    }

    setRunning(false)
    // Variables changed under the environments panel — let it refetch.
    queryClient.invalidateQueries({
      queryKey: ['api-environments', projectId],
    })

    if (flow) {
      const payload: ApiFlowRunStep[] = results.map((r) => ({
        requestName: r.step.requestName,
        method: r.method,
        url: r.url,
        status: r.status,
        timeMs: r.timeMs,
        outcome:
          r.outcome === 'pass'
            ? 'pass'
            : r.outcome === 'skipped'
              ? 'skipped'
              : r.outcome === 'fail'
                ? 'fail'
                : 'error',
        checks: r.checks,
        detail: r.detail,
        captured: r.captured,
      }))
      try {
        await saveApiFlowRun(projectId, flow.name, {
          env: null,
          account: auth.accountLabel || null,
          totalMs: Date.now() - started,
          steps: payload,
        })
        queryClient.invalidateQueries({
          queryKey: ['api-flow-runs', projectId, flow.name],
        })
      } catch {
        /* the report on screen is the primary result — storing it is best-effort */
      }
    }
  }

  const summary = useMemo(() => {
    if (!runs) return null
    return {
      passed: runs.filter((r) => r.outcome === 'pass').length,
      failed: runs.filter((r) => r.outcome === 'fail' || r.outcome === 'error').length,
      skipped: runs.filter((r) => r.outcome === 'skipped').length,
      total: runs.length,
    }
  }, [runs])

  const dirty =
    description !== flow.description ||
    stopOnFail !== flow.stopOnFail ||
    JSON.stringify(auth) !== JSON.stringify(flow.auth) ||
    JSON.stringify(steps) !== JSON.stringify(flow.steps)
  const enabledCount = steps.filter((s) => s.enabled).length

  return (
    <div className="min-w-0 space-y-3">
      {/* ---------------------------------------------------- 1. the scenario */}
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card p-4 shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <FlowChip n={1}>Scenario</FlowChip>
            {renaming ? (
              <div className="flex items-center gap-1">
                <Input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') {
                      setRenaming(false)
                      setNameDraft(flow.name)
                    }
                  }}
                  maxLength={60}
                  aria-label="Flow name"
                  className="h-8 w-64 text-sm shadow-none"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={commitRename}
                  disabled={rename.isPending}
                  className="size-7 rounded-md text-emerald-600 hover:text-emerald-700"
                  aria-label="Confirm flow rename"
                >
                  {rename.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setRenaming(false)
                    setNameDraft(flow.name)
                  }}
                  className="size-7 rounded-md text-muted-foreground hover:text-foreground"
                  aria-label="Cancel flow rename"
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : (
              <div className="flex min-w-0 items-center gap-1.5">
                <h2 className="truncate text-lg font-semibold tracking-tight">{flow.name}</h2>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
                    setNameDraft(flow.name)
                    setRenaming(true)
                  }}
                  disabled={running}
                  className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                  aria-label="Rename this flow"
                  title="Rename"
                >
                  <Pencil className="size-3.5" />
                </Button>
              </div>
            )}
          </div>

          {/* Run and Save sit at the top, next to the name: on a long flow the old
              dialog footer was a scroll away from the steps you just edited. */}
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {dirty && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600">
                <TriangleAlert className="size-3.5" />
                Unsaved changes
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => save.mutate()}
              disabled={running || save.isPending || !dirty}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {save.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Save className="size-3.5" />
              )}
              Save
            </Button>
            <Button
              size="sm"
              onClick={run}
              disabled={running || !enabledCount}
              className="gap-1.5 rounded-full active:scale-[0.98]"
              title={enabledCount ? undefined : 'Enable at least one step first'}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              {running ? 'Running…' : `Run ${enabledCount} step${enabledCount === 1 ? '' : 's'}`}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setConfirmDelete(true)}
              disabled={running || remove.isPending}
              className="size-8 rounded-full text-muted-foreground hover:text-destructive"
              aria-label="Delete this flow"
              title="Delete this flow"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <p className="text-xs leading-5 text-muted-foreground">
          Runs the steps below in order. Each step's captures become{' '}
          <code className="rounded bg-muted px-1 text-[11px]">{'{{variables}}'}</code> the next
          steps can use — so step 1 can log in and the rest inherit the token.
        </p>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="flow-desc" className="text-xs">
              What this scenario covers
            </Label>
            <Input
              id="flow-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Login → create claim → verify it's listed"
              className="h-9 text-sm"
            />
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs">
            <Checkbox
              size="sm"
              checked={stopOnFail}
              onChange={(e) => setStopOnFail(e.target.checked)}
            />
            Stop on first failure
          </label>
        </div>
      </section>

      {/* Two columns on a wide screen: what the flow IS on the left, what happened on
          the right, so a fix and its verdict are never a scroll apart. */}
      <div className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(340px,32%)] 2xl:items-start">
        <div className="min-w-0 space-y-3">

          {/* Run as — pick the identity instead of hard-coding a label per request. */}
          <FlowAuthPicker
            projectId={projectId}
            value={auth}
            onChange={setAuth}
            disabled={running}
            onManageAccounts={onManageAccounts}
          />

          {/* ------------------------------------------------------ 2. the steps */}
          <section className="space-y-2 rounded-2xl border border-border/60 bg-card p-4 shadow-none">
            <div className="flex items-center justify-between gap-2">
              <FlowChip n={2}>
                Steps{steps.length > 0 ? ` · ${enabledCount}/${steps.length} enabled` : ''}
              </FlowChip>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAdding((v) => !v)}
                disabled={running}
                className="h-7 gap-1.5 rounded-full text-[11px]"
              >
                {adding ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
                {adding ? 'Done adding' : 'Add request'}
              </Button>
            </div>

            {adding && (
              <AddStepPicker
                projectId={projectId}
                saved={saved}
                // Appends immediately, one click per step: the flow's step list is
                // right below, so the result is visible without a confirm button —
                // and a click can't be lost the way the old nested dialog lost it.
                onPick={(requestName) =>
                  setSteps((prev) => [
                    ...prev,
                    {
                      id: newStepId(),
                      requestName,
                      enabled: true,
                      continueOnFail: false,
                    },
                  ])
                }
                counts={steps.reduce<Record<string, number>>((acc, s) => {
                  acc[s.requestName] = (acc[s.requestName] ?? 0) + 1
                  return acc
                }, {})}
              />
            )}

            {steps.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center">
                <p className="text-xs font-medium">No steps yet</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  Use <span className="font-medium text-foreground">Add request</span> above and pick
                  saved requests in the order they should run — the login first, then the calls that
                  need what it captured.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {steps.map((step, i) => {
                  const req = savedByName.get(step.requestName)
                  const result = runs?.find((r) => r.step.id === step.id)
                  return (
                    <div
                      key={step.id}
                      className={cn(
                        'flex items-center gap-2 rounded-xl border px-2.5 py-2',
                        step.enabled
                          ? 'border-border/60 bg-background'
                          : 'border-border/60 bg-muted/40 opacity-60',
                      )}
                    >
                      <span className="w-5 shrink-0 text-center text-[11px] font-medium text-muted-foreground">
                        {i + 1}
                      </span>
                      <Checkbox
                        size="sm"
                        checked={step.enabled}
                        onChange={(e) =>
                          setSteps(
                            steps.map((s) =>
                              s.id === step.id ? { ...s, enabled: e.target.checked } : s,
                            ),
                          )
                        }
                        disabled={running}
                        title="Include this step in the run"
                      />
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="flex items-center gap-1.5">
                          <span className="shrink-0 font-mono text-[10px] font-semibold text-muted-foreground">
                            {req?.method ?? '—'}
                          </span>
                          <span className="truncate text-xs font-medium">{step.requestName}</span>
                          {!req && (
                            <span
                              className="flex shrink-0 items-center gap-1 text-[10px] text-destructive"
                              title="This saved request was deleted"
                            >
                              <TriangleAlert className="size-3" />
                              missing
                            </span>
                          )}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {req?.url ?? 'the request this step ran was deleted'}
                        </span>
                      </span>

                      {result && <StepVerdict run={result} />}

                      <label
                        className="flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground"
                        title="Keep running even if this step fails"
                      >
                        <Checkbox
                          size="sm"
                          checked={step.continueOnFail}
                          onChange={(e) =>
                            setSteps(
                              steps.map((s) =>
                                s.id === step.id ? { ...s, continueOnFail: e.target.checked } : s,
                              ),
                            )
                          }
                          disabled={running}
                        />
                        soft
                      </label>
                      <div className="flex shrink-0 items-center">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => move(i, -1)}
                          disabled={running || i === 0}
                          className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                          title="Move up"
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => move(i, 1)}
                          disabled={running || i === steps.length - 1}
                          className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                          title="Move down"
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setSteps(steps.filter((s) => s.id !== step.id))}
                          disabled={running}
                          className="size-6 rounded-md text-muted-foreground hover:text-destructive"
                          title="Remove step"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        </div>

        {/* --------------------------------------------------- 3. what happened */}
        <section className="min-w-0 space-y-3 rounded-2xl border border-border/60 bg-card p-4 shadow-none 2xl:sticky 2xl:top-4">
          <div className="flex items-center justify-between gap-2">
            <FlowChip n={3}>Result</FlowChip>
            {running && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-primary">
                <Loader2 className="size-3.5 animate-spin" />
                running…
              </span>
            )}
          </div>

          {/* This run — the live verdict, step by step, as each one answers. */}
          {summary && (
            <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
              <p className="text-xs font-medium">
                {summary.passed}/{summary.total} passed
                {summary.failed ? ` · ${summary.failed} failed` : ''}
                {summary.skipped ? ` · ${summary.skipped} skipped` : ''}
              </p>
              <div className="space-y-1">
                {runs!
                  .filter((r) => r.detail)
                  .map((r, i) => (
                    <p key={`${r.step.id}-${i}`} className="text-[11px] text-muted-foreground">
                      <span className={cn('font-medium', OUTCOME_TONE[r.outcome])}>
                        {r.step.requestName}
                      </span>{' '}
                      — {r.detail}
                    </p>
                  ))}
                {runs!.some((r) => r.captured.length > 0) && (
                  <p className="text-[11px] text-muted-foreground">
                    Captured:{' '}
                    {[...new Set(runs!.flatMap((r) => r.captured))]
                      .map((v) => `{{${v}}}`)
                      .join(', ')}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Previous runs. Each row OPENS: the stored report already holds every step's
              verdict, and a bare "0/2 passed" from three days ago is unusable evidence —
              you need to know which step failed and with what. No fetch to expand; the
              list response carries the steps. */}
          {(history?.runs ?? []).length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label className="text-xs">Previous runs</Label>
                {(history?.runs ?? []).length > 5 && (
                  <button
                    type="button"
                    onClick={() => setAllRuns((v) => !v)}
                    className="text-[11px] font-medium text-primary hover:underline"
                  >
                    {allRuns ? 'Show 5' : `Show all ${(history?.runs ?? []).length}`}
                  </button>
                )}
              </div>
              <div className="space-y-1">
                {(allRuns ? (history?.runs ?? []) : (history?.runs ?? []).slice(0, 5)).map((r) => (
                  <PastRunRow key={r.id} run={r} />
                ))}
              </div>
            </div>
          )}
          {/* Nothing has run yet — say what the panel will hold, not nothing. */}
          {!summary && (history?.runs ?? []).length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center">
              <p className="text-xs font-medium">No run yet</p>
              <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                Hit <span className="font-medium text-foreground">Run</span> — each step reports its
                status, checks and timing here as it goes, and the summary is kept with the project.
              </p>
            </div>
          )}
        </section>
      </div>

      {/* Delete needs a confirm: a flow is a file, and its run history goes with it. */}
      <Dialog open={confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(false)}>
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{flow.name}”?</DialogTitle>
            <DialogDescription>
              The flow definition and its saved run reports are removed from the project. The saved
              requests its steps pointed at are not touched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="rounded-full">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="gap-1.5 rounded-full"
            >
              {remove.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete flow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/**
 * One stored run, collapsed to its date + verdict, expanding to the per-step report.
 * The expansion is the point: a saved run is the evidence a scenario passed, and
 * "0/2 passed" with no step detail sends you back to re-running it to find out why.
 */
function PastRunRow({ run }: { run: ApiFlowRun }) {
  const [open, setOpen] = useState(false)
  const bad = run.summary.failed > 0
  return (
    <div className="overflow-hidden rounded-xl border border-border/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] transition-colors hover:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {new Date(run.at).toLocaleString()}
        </span>
        <span
          className={cn('shrink-0 font-medium', bad ? 'text-destructive' : 'text-emerald-600')}
        >
          {run.summary.passed}/{run.summary.total} passed
          {run.summary.skipped ? ` · ${run.summary.skipped} skipped` : ''}
        </span>
      </button>

      {open && (
        <div className="space-y-1.5 border-t border-border/60 bg-muted/30 px-2.5 py-2">
          {/* What the run itself was — the identity is why two runs of one flow differ. */}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
            {run.totalMs > 0 && <span className="tabular-nums">{run.totalMs} ms total</span>}
            {run.account && (
              <span className="inline-flex items-center gap-1">
                <KeyRound className="size-2.5" />
                as {run.account}
              </span>
            )}
            {run.env && <span>env {run.env}</span>}
            {bad && <span className="text-destructive">{run.summary.failed} failed</span>}
          </p>

          {run.steps.length === 0 ? (
            <p className="text-[10px] text-muted-foreground">
              This report stored no steps — the run was started with everything disabled.
            </p>
          ) : (
            run.steps.map((s, i) => (
              <div
                key={`${run.id}-${i}`}
                className="space-y-0.5 rounded-lg border border-border/60 bg-background px-2 py-1.5"
              >
                <div className="flex items-center gap-1.5">
                  <span className="w-3.5 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] font-semibold text-muted-foreground">
                    {s.method || '—'}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[11px] font-medium">
                    {s.requestName}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 text-[10px] font-medium tabular-nums',
                      OUTCOME_TONE[s.outcome],
                    )}
                  >
                    {s.outcome === 'skipped'
                      ? 'skipped'
                      : `${s.status ?? '—'}${
                          s.checks.total ? ` · ${s.checks.passed}/${s.checks.total}` : ''
                        }${s.timeMs ? ` · ${s.timeMs}ms` : ''}`}
                  </span>
                </div>
                {s.url && (
                  <p
                    className="truncate pl-5 font-mono text-[10px] text-muted-foreground"
                    title={s.url}
                  >
                    {s.url}
                  </p>
                )}
                {/* Why it failed, in the row that failed — the whole reason to expand. */}
                {s.detail && (
                  <p
                    className={cn(
                      'pl-5 text-[10px] leading-snug',
                      s.outcome === 'fail' || s.outcome === 'error'
                        ? 'text-destructive'
                        : 'text-amber-600',
                    )}
                  >
                    {s.detail}
                  </p>
                )}
                {s.captured.length > 0 && (
                  <p className="pl-5 text-[10px] text-muted-foreground">
                    captured {s.captured.map((v) => `{{${v}}}`).join(', ')}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

/** One step's live verdict chip inside the steps list. */
function StepVerdict({ run }: { run: StepRun }) {
  if (run.outcome === 'pending') return null
  if (run.outcome === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
  }
  if (run.outcome === 'skipped') {
    return (
      <span className="flex shrink-0 items-center gap-1 text-[10px] text-amber-600">
        <SkipForward className="size-3" />
        skipped
      </span>
    )
  }
  const bad = run.outcome === 'fail' || run.outcome === 'error'
  return (
    <span
      className={cn(
        'flex shrink-0 items-center gap-1 text-[10px] font-medium',
        OUTCOME_TONE[run.outcome],
      )}
      title={run.detail || undefined}
    >
      {bad ? <CircleSlash className="size-3" /> : <Check className="size-3" />}
      {run.status ?? '—'}
      {run.checks.total > 0 && ` · ${run.checks.passed}/${run.checks.total}`}
      {run.timeMs ? ` · ${run.timeMs}ms` : ''}
    </span>
  )
}

// ---------------------------------------------------------------- accounts dialog

/**
 * Test accounts a flow's login step uses. The password is write-only: it's stored
 * beside the portal's database (never in the project repo, never swept into an AI
 * prompt) and only ever leaves the server inside the request it substitutes.
 */
export function ApiAccountsDialog({
  projectId,
  onClose,
}: {
  projectId: string
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [note, setNote] = useState('')

  const { data } = useQuery({
    queryKey: ['api-accounts', projectId],
    queryFn: () => listApiAccounts(projectId),
  })
  const accounts = data?.accounts ?? []

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['api-accounts', projectId] })
  }

  const save = useMutation({
    mutationFn: () => saveApiAccount(projectId, { label, username, password, note }),
    onSuccess: ({ account }) => {
      invalidate()
      toast.success(`Saved “${account.label}”`, {
        description: `Use {{account.${account.label}.username}} / .password in a request.`,
      })
      setLabel('')
      setUsername('')
      setPassword('')
      setNote('')
    },
    onError: (e) =>
      toast.error('Could not save the account', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  const remove = useMutation({
    mutationFn: (l: string) => deleteApiAccount(projectId, l),
    onSuccess: () => {
      invalidate()
      toast.success('Account removed')
    },
  })

  // Logins the engineer already wrote on Instructions → Accounts. Offering them here is
  // what stops the flow's picker from saying "No account" while an account exists one
  // page over.
  const { data: candidateData } = useQuery({
    queryKey: ['api-account-candidates', projectId],
    queryFn: () => listApiAccountCandidates(projectId),
  })
  const candidates = candidateData?.candidates ?? []

  const importAll = useMutation({
    mutationFn: (usernames: string[]) => importApiAccounts(projectId, usernames),
    onSuccess: ({ imported }) => {
      invalidate()
      queryClient.invalidateQueries({
        queryKey: ['api-account-candidates', projectId],
      })
      toast.success(
        imported.length === 1
          ? `Imported “${imported[0]}”`
          : `Imported ${imported.length} accounts`,
        {
          description: 'Add the password below for any row the sheet left blank.',
        },
      )
    },
    onError: (e) =>
      toast.error('Could not import', {
        description: e instanceof Error ? e.message : undefined,
      }),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Wider than a plain form dialog: a row carries a label, an email and a note on
          one line, and the import card sits above a two-column form. The BODY scrolls
          (not the whole dialog) — verified at 700x560, where scrolling the dialog itself
          pushed Close off screen. Same header / scroll-body / fixed-footer shape as the
          flow dialog. */}
      <DialogContent className="max-h-[92vh] w-[97vw] gap-4 overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            Test accounts
          </DialogTitle>
          <DialogDescription>
            Credentials a flow's first step logs in with. Stored outside the project (never
            committed, never sent to an AI prompt) and substituted server-side — the password is
            never returned to this page.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[64vh] min-w-0 pr-3">
          <div className="min-w-0 space-y-3">
            {accounts.length > 0 && (
              <div className="space-y-1">
                {accounts.map((a) => (
                  <AccountRow
                    key={a.label}
                    account={a}
                    onEdit={() => {
                      setLabel(a.label)
                      setUsername(a.username)
                      setPassword('')
                      setNote(a.note)
                    }}
                    onDelete={() => remove.mutate(a.label)}
                    deleting={remove.isPending}
                  />
                ))}
              </div>
            )}

            {candidates.length > 0 && (
              <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5">
                    <p className="text-xs font-medium">Found in your accounts sheet</p>
                    <p className="text-[11px] text-muted-foreground">
                      From{' '}
                      <Link
                        to="/instructions?tab=accounts"
                        className="font-medium text-primary hover:underline"
                      >
                        Instructions → Accounts
                      </Link>{' '}
                      (testing/environments.md) — import to use them in a flow.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => importAll.mutate(candidates.map((c) => c.username))}
                    disabled={importAll.isPending}
                    className="h-7 shrink-0 gap-1.5 rounded-full text-[11px]"
                  >
                    {importAll.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Download className="size-3.5" />
                    )}
                    Import all
                  </Button>
                </div>
                <div className="space-y-1">
                  {candidates.map((c) => (
                    <div
                      key={c.username}
                      className="flex items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-1.5"
                    >
                      <span className="min-w-0 flex-1 leading-tight">
                        <span className="block truncate font-mono text-[11px] font-medium">
                          {c.label}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {c.username}
                          {c.hasPassword ? ' · password in sheet' : ' · no password in sheet'}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => importAll.mutate([c.username])}
                        disabled={importAll.isPending}
                        className="h-7 shrink-0 rounded-full px-2 text-[11px]"
                      >
                        Import
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {accounts.length === 0 && candidates.length === 0 && (
              <p className="rounded-xl border border-dashed border-border/60 px-3 py-2.5 text-[11px] leading-snug text-muted-foreground">
                No accounts yet. Add one below, or fill in the sheet on{' '}
                <Link
                  to="/instructions?tab=accounts"
                  className="font-medium text-primary hover:underline"
                >
                  Instructions → Accounts
                </Link>{' '}
                and import it here.
              </p>
            )}

            <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="acc-label" className="text-xs">
                    Label
                  </Label>
                  <Input
                    id="acc-label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="qa-admin"
                    className="h-9 font-mono text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="acc-user" className="text-xs">
                    Username / email
                  </Label>
                  <Input
                    id="acc-user"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="qa.admin@example.com"
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="acc-pass" className="text-xs">
                    Password
                  </Label>
                  <Input
                    id="acc-pass"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="leave blank to keep the stored one"
                    autoComplete="new-password"
                    className="h-9 text-xs"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="acc-note" className="text-xs">
                    Note
                  </Label>
                  <Input
                    id="acc-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="admin on staging"
                    className="h-9 text-xs"
                  />
                </div>
              </div>
              <Button
                onClick={() => save.mutate()}
                disabled={!label.trim() || save.isPending}
                size="sm"
                className="gap-1.5 rounded-full"
              >
                {save.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plus className="size-3.5" />
                )}
                {accounts.some((a) => a.label === label.trim().toLowerCase())
                  ? 'Update account'
                  : 'Add account'}
              </Button>
            </div>

            <div className="space-y-1 rounded-xl border border-border/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <p className="font-medium text-foreground">Using it in the login request</p>
              <pre className="overflow-x-auto rounded-lg bg-muted/60 p-2 font-mono text-[10px]">
                {`{
  "email": "{{account.qa-admin.username}}",
  "password": "{{account.qa-admin.password}}",
  "otp": "{{otp.qa-admin}}"
}`}
              </pre>
              <p>
                <code className="rounded bg-muted px-1">{'{{otp.<label>}}'}</code> is the live
                6-digit code for the authenticator registered under the SAME label on the
                Instructions → Accounts page — it's computed at send time, so it's never stale and
                never stored.
              </p>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccountRow({
  account,
  onEdit,
  onDelete,
  deleting,
}: {
  account: ApiAccount
  onEdit: () => void
  onDelete: () => void
  deleting: boolean
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 px-2.5 py-2">
      <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 leading-tight">
        <span className="block truncate font-mono text-xs font-medium">{account.label}</span>
        <span className="block truncate text-[10px] text-muted-foreground">
          {account.username || 'no username'}
          {account.hasPassword ? ' · password set' : ' · no password'}
          {account.note ? ` · ${account.note}` : ''}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onEdit}
        className="h-7 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
      >
        Edit
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        disabled={deleting}
        className="size-7 rounded-full text-muted-foreground hover:text-destructive"
        title="Remove account"
      >
        <Trash2 className="size-3.5" />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- auth picker

const NO_AUTH = '__none__'

/**
 * "Run as" — pick the account (and, if the app has real 2FA, the authenticator) the
 * whole flow authenticates with, instead of hard-coding `{{account.<label>.…}}` into
 * the login request.
 *
 * Why a flow-level pick and not just per-request labels: re-running the same scenario
 * as a different role is the common case, and with labels baked into the saved request
 * that means editing the request (and remembering to change it back). The selection
 * resolves to `{{auth.username}}` / `{{auth.password}}` / `{{auth.otp}}`, so the login
 * request is written once.
 *
 * The authenticator list is the SAME store the Instructions → Accounts page registers
 * (`/api/accounts/totp`) — 2FA is registered once per project and reused here, which is
 * why this only links to that page rather than duplicating its editor.
 */
function FlowAuthPicker({
  projectId,
  value,
  onChange,
  disabled,
  onManageAccounts,
}: {
  projectId: string
  value: { accountLabel: string; totpLabel: string }
  onChange: (next: { accountLabel: string; totpLabel: string }) => void
  disabled?: boolean
  onManageAccounts: () => void
}) {
  const { data: accountsData } = useQuery({
    queryKey: ['api-accounts', projectId],
    queryFn: () => listApiAccounts(projectId),
  })
  const { data: totpData } = useQuery({
    queryKey: ['totp-entries', projectId],
    queryFn: () => listTotp(projectId),
  })
  const accounts = accountsData?.accounts ?? []
  const totps = totpData?.entries ?? []

  // A label that no longer exists must be visible, not silently ignored: the run would
  // fail on an unresolved {{auth.username}} and the reason wouldn't be on screen.
  const accountMissing =
    !!value.accountLabel && !accounts.some((a) => a.label === value.accountLabel)
  const totpMissing = !!value.totpLabel && !totps.some((t) => t.label === value.totpLabel)

  const account = accounts.find((a) => a.label === value.accountLabel) ?? null

  return (
    <div className="space-y-3 rounded-2xl border border-border/60 bg-muted/40 p-3.5">
      {/* Header: what this is, WHO it resolves to right now, and the way to change the
          stored identities. The resolved identity is the whole point of the card, so it
          reads as a pill on the header line instead of hiding inside the select. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold">Run as</p>
            <p className="truncate text-[11px] text-muted-foreground">
              {accountMissing || totpMissing
                ? 'The stored identity is gone — pick another before running'
                : value.accountLabel
                  ? `Every step sends this identity${value.totpLabel ? ' and a fresh 2FA code' : ''}`
                  : 'No identity — steps send whatever they hard-code'}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* One glance: is an identity picked, and is 2FA in play? */}
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
              accountMissing
                ? 'border-destructive/40 bg-destructive/10 text-destructive'
                : value.accountLabel
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600'
                  : 'border-border/60 bg-background text-muted-foreground',
            )}
          >
            <span
              className={cn(
                'size-1.5 rounded-full',
                accountMissing
                  ? 'bg-destructive'
                  : value.accountLabel
                    ? 'bg-emerald-500'
                    : 'bg-muted-foreground/50',
              )}
            />
            {accountMissing
              ? 'account missing'
              : value.accountLabel
                ? (account?.username ?? value.accountLabel)
                : 'no account'}
          </span>
          {value.totpLabel && (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                totpMissing
                  ? 'border-destructive/40 bg-destructive/10 text-destructive'
                  : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
              )}
            >
              <KeyRound className="size-2.5" />
              {totpMissing ? '2FA missing' : '2FA on'}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onManageAccounts}
            disabled={disabled}
            className="h-7 gap-1.5 rounded-full text-[11px] active:scale-[0.98]"
          >
            <KeyRound className="size-3.5" />
            Manage accounts
          </Button>
        </div>
      </div>

      {/* Capped width: these are two short pickers, and letting them span a 1000px pane
          put half a screen of dead space between the account and its authenticator. */}
      <div className="grid gap-2.5 sm:max-w-2xl sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Account</Label>
          <Select
            value={value.accountLabel || NO_AUTH}
            onValueChange={(v) => onChange({ ...value, accountLabel: v === NO_AUTH ? '' : v })}
            disabled={disabled}
          >
            <SelectTrigger className="h-9 w-full bg-background text-xs">
              <SelectValue placeholder="No account" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AUTH} className="text-xs">
                No account
              </SelectItem>
              {/* A value with no matching item renders an EMPTY trigger, which hides
                  WHICH account went missing — so keep the dead label as a disabled item. */}
              {accountMissing && (
                <SelectItem value={value.accountLabel} disabled className="text-xs">
                  {value.accountLabel} — deleted
                </SelectItem>
              )}
              {accounts.length === 0 && (
                // A bare "No account" reads as a bug when the engineer HAS an account
                // (theirs is usually on Instructions → Accounts). Say where to get one.
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  None stored yet — use “Manage accounts” to add or import one.
                </div>
              )}
              {accounts.map((a) => (
                <SelectItem key={a.label} value={a.label} className="text-xs">
                  {a.label}
                  {a.username ? ` — ${a.username}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Authenticator (2FA)</Label>
          <Select
            value={value.totpLabel || NO_AUTH}
            onValueChange={(v) => onChange({ ...value, totpLabel: v === NO_AUTH ? '' : v })}
            disabled={disabled}
          >
            <SelectTrigger className="h-9 w-full bg-background text-xs">
              <SelectValue placeholder="Not needed" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AUTH} className="text-xs">
                Not needed
              </SelectItem>
              {totpMissing && (
                <SelectItem value={value.totpLabel} disabled className="text-xs">
                  {value.totpLabel} — deleted
                </SelectItem>
              )}
              {totps.length === 0 && (
                <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
                  No authenticator registered — see the link below.
                </div>
              )}
              {totps.map((t) => (
                <SelectItem key={t.label} value={t.label} className="text-xs">
                  {t.label}
                  {t.issuer ? ` — ${t.issuer}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {accountMissing || totpMissing ? (
        <p className="flex items-start gap-1.5 rounded-xl border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive">
          <TriangleAlert className="mt-px size-3.5 shrink-0" />
          <span>
            {accountMissing && `Account “${value.accountLabel}” no longer exists. `}
            {totpMissing && `Authenticator “${value.totpLabel}” no longer exists. `}
            Pick again, or the run stops on an unresolved variable.
          </span>
        </p>
      ) : null}

      {/* The tokens as CHIPS, not prose. This was a five-line paragraph with four inline
          code spans in it; the one thing a reader needs is the exact spelling of the
          placeholders, and prose is the worst possible way to show that. */}
      <div className="space-y-1.5 border-t border-border/60 pt-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Write in the login request:</span>
          {['{{auth.username}}', '{{auth.password}}', ...(value.totpLabel ? ['{{auth.otp}}'] : [])].map(
            (token) => (
              <code
                key={token}
                className="whitespace-nowrap rounded-lg border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px]"
              >
                {token}
              </code>
            ),
          )}
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">
          The server substitutes them at send time — the password never reaches this page. One
          specific account stays addressable as{' '}
          <code className="whitespace-nowrap rounded bg-background px-1 font-mono text-[10px]">
            {'{{account.<label>.username}}'}
          </code>
          , and{' '}
          <Link to="/instructions?tab=accounts" className="font-medium text-primary hover:underline">
            registering a 2FA authenticator
          </Link>{' '}
          adds it to the picker above.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- add-step picker

/**
 * Inline picker that appends saved requests to the flow, one click per step (click the
 * same request twice to run it twice).
 *
 * Deliberately NOT a dialog. A second Radix dialog opened from inside the flow dialog
 * is portalled outside it, so every click in the picker registered as an interaction
 * *outside* the flow dialog: Radix dismissed the flow dialog, unmounting the step
 * draft, and the picked steps vanished. Inline, the picker shares the flow dialog's
 * state and the steps list right below it updates as you click.
 */
function AddStepPicker({
  projectId,
  saved,
  onPick,
  counts,
}: {
  projectId: string
  saved: ApiRequestDef[]
  onPick: (requestName: string) => void
  /** How many times each request is already in the flow, shown as a ×N badge. */
  counts: Record<string, number>
}) {
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState('')
  const [curlOpen, setCurlOpen] = useState(false)
  const needle = filter.trim().toLowerCase()
  const shown = saved.filter(
    (s) => !needle || `${s.name} ${s.url} ${s.group}`.toLowerCase().includes(needle),
  )

  /**
   * Import a curl command straight into the flow: it becomes a saved request (flows
   * reference requests by name and never copy them) and then a step.
   *
   * This exists because the picker could only offer what was already in the collection,
   * so building a scenario from a browser's "Copy as cURL" meant leaving the flow,
   * switching to the Requests tab, importing, sending it once to get it saved, and
   * coming back — with the half-built flow's unsaved steps at risk the whole way.
   */
  const importCurl = async (draft: ApiDraft) => {
    const name = uniqueName(deriveName(draft), new Set(saved.map((s) => s.name)))
    await saveApiRequest(projectId, name, draft)
    // Awaited, so `saved` already carries the new request when the step lands — a step
    // whose request isn't in the list yet renders as `missing`.
    await queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
    onPick(name)
    toast.success(`Added “${name}” as a step`, {
      description: 'It is now a saved request too — editable from the Requests tab.',
    })
  }

  return (
    <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          Click requests in the order they should run — click one twice to use it twice.
        </p>
        {/* The second way in: a request the collection doesn't have yet. */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCurlOpen(true)}
          className="h-7 shrink-0 gap-1.5 rounded-full bg-background text-[11px] active:scale-[0.98]"
          title="Paste a curl command — it is saved as a request and added as a step"
        >
          <TerminalSquare className="size-3.5" />
          Import cURL
        </Button>
      </div>
      {saved.length > 5 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search name, method, URL…"
            aria-label="Search saved requests to add"
            className="h-8 rounded-lg pl-8 text-xs shadow-none [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
      )}
      <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
        {shown.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => onPick(s.name)}
            className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/70 active:scale-[0.99]"
          >
            <span className="shrink-0 font-mono text-[10px] font-semibold text-muted-foreground">
              {s.method}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-xs font-medium">{s.name}</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {s.url || 'no URL yet'}
              </span>
            </span>
            {counts[s.name] > 0 && (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 text-[10px] font-medium text-primary">
                x{counts[s.name]}
              </span>
            )}
            <Plus className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        ))}
        {shown.length === 0 && (
          <div className="px-1 py-3 text-center">
            <p className="text-[11px] text-muted-foreground">
              {saved.length
                ? 'No saved requests match.'
                : 'Nothing saved yet — Import cURL above is the quickest way in.'}
            </p>
          </div>
        )}
      </div>

      <CurlImportDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={importCurl}
        title="Import a step from cURL"
        confirmLabel="Save & add step"
      />
    </div>
  )
}
