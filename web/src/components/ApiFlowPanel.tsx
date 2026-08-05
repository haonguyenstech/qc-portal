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

import { useMemo, useRef, useState } from 'react'
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
  Play,
  Plus,
  Route,
  Save,
  ShieldCheck,
  SkipForward,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { evaluateAssertions, getJsonPath } from '@/lib/apiAssert'
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
  saveApiAccount,
  saveApiFlow,
  saveApiFlowRun,
  sendApiRequest,
  type ApiAccount,
  type ApiFlow,
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

// ---------------------------------------------------------------- flows list (aside)

/**
 * The "Flows" block under the saved-requests list: pick one to open the runner, or
 * create one. Kept deliberately small — the editor and the run live in the dialog.
 */
export function ApiFlowsCard({ projectId, saved }: { projectId: string; saved: ApiRequestDef[] }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)
  const [accountsOpen, setAccountsOpen] = useState(false)
  const { data } = useQuery({
    queryKey: ['api-flows', projectId],
    queryFn: () => listApiFlows(projectId),
  })
  const flows = data?.flows ?? []

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
      setOpen(flow.name)
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
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Route className="size-3.5" />
          Flows
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setAccountsOpen(true)}
            className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            title="Test accounts a flow logs in with"
          >
            <KeyRound className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={addFlow}
            disabled={create.isPending}
            className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
            title="New flow"
          >
            {create.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {flows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border/60 px-2.5 py-2 text-[11px] leading-snug text-muted-foreground">
          A flow runs several saved requests in order — log in, capture the token, then the steps
          that need it.
        </p>
      ) : (
        <div className="space-y-1">
          {flows.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => setOpen(f.name)}
              className="flex w-full items-center gap-2 rounded-xl border border-border/60 bg-muted/40 px-2.5 py-2 text-left transition-all duration-200 hover:border-border hover:bg-muted/70 active:scale-[0.99]"
            >
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-xs font-medium">{f.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {f.steps.filter((s) => s.enabled).length} step
                  {f.steps.filter((s) => s.enabled).length === 1 ? '' : 's'}
                  {f.description ? ` · ${f.description}` : ''}
                </span>
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            </button>
          ))}
        </div>
      )}

      {open && (
        <ApiFlowDialog
          projectId={projectId}
          flow={flows.find((f) => f.name === open) ?? null}
          saved={saved}
          onClose={() => setOpen(null)}
        />
      )}
      {accountsOpen && (
        <ApiAccountsDialog projectId={projectId} onClose={() => setAccountsOpen(false)} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- flow dialog

function ApiFlowDialog({
  projectId,
  flow,
  saved,
  onClose,
}: {
  projectId: string
  flow: ApiFlow | null
  saved: ApiRequestDef[]
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  // Draft state seeded once from the flow — the dialog is mounted per flow name, so
  // there's no stale-props problem to reconcile in an effect.
  const [description, setDescription] = useState(flow?.description ?? '')
  const [stopOnFail, setStopOnFail] = useState(flow?.stopOnFail ?? true)
  const [auth, setAuth] = useState(flow?.auth ?? { accountLabel: '', totpLabel: '' })
  const [steps, setSteps] = useState<ApiFlowStep[]>(flow?.steps ?? [])
  const [runs, setRuns] = useState<StepRun[] | null>(null)
  const [running, setRunning] = useState(false)
  // The step picker is INLINE, not a nested dialog — see the dismissal guards on
  // DialogContent for what a second dialog does to this one's draft state.
  const [adding, setAdding] = useState(false)
  const [accountsOpen, setAccountsOpen] = useState(false)

  // Keeping this dialog open while the accounts dialog is stacked on top can't be
  // driven by `accountsOpen` alone. Radix decides "did the user interact outside?" on
  // TRAILING events too — the focus-outside that fires as the inner dialog unmounts —
  // and by then the flag has already flipped to false, so the guard lets it through
  // and BOTH dialogs close. Verified: clicking the inner dialog's Close button (a real
  // pointer sequence; a synthetic .click() doesn't reproduce it) closed the flow dialog
  // and threw away the step draft. So the guard stays armed for a short window after
  // the inner dialog closes, which is long enough for those trailing events.
  const guardedUntil = useRef(0)
  const blockDismiss = () => Date.now() < guardedUntil.current
  const openAccounts = () => {
    guardedUntil.current = Number.POSITIVE_INFINITY
    setAccountsOpen(true)
  }
  const closeAccounts = () => {
    guardedUntil.current = Date.now() + 400
    setAccountsOpen(false)
  }

  const savedByName = useMemo(() => new Map(saved.map((s) => [s.name, s])), [saved])

  const { data: history } = useQuery({
    queryKey: ['api-flow-runs', projectId, flow?.name],
    queryFn: () => listApiFlowRuns(projectId, flow!.name),
    enabled: !!flow,
  })

  const save = useMutation({
    mutationFn: () =>
      saveApiFlow(projectId, flow!.name, {
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
    mutationFn: () => deleteApiFlow(projectId, flow!.name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
      toast.success('Flow deleted')
      onClose()
    },
  })

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

  if (!flow) return null
  const dirty =
    description !== flow.description ||
    stopOnFail !== flow.stopOnFail ||
    JSON.stringify(auth) !== JSON.stringify(flow.auth) ||
    JSON.stringify(steps) !== JSON.stringify(flow.steps)

  return (
    <Dialog open onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent
        // Wide on purpose: a step row carries the method, name, URL, live verdict, the
        // "soft" toggle and four buttons, and a step's URL is the one thing you check
        // before running. Same wide-dialog idiom as KnowledgeDocs / VerifyDesignPage.
        className="max-h-[92vh] w-[97vw] gap-4 overflow-hidden sm:max-w-[72rem]"
        // While a SECOND dialog (accounts) is open on top, its content is portalled
        // outside this one — so a click inside it reads as "outside" here and would
        // dismiss the flow dialog, throwing away the unsaved step draft. Verified:
        // that's exactly how the old nested "Add steps" dialog lost every step it
        // added. Keep these guards for any dialog opened from inside this one.
        onPointerDownOutside={(e) => {
          if (blockDismiss()) e.preventDefault()
        }}
        onInteractOutside={(e) => {
          if (blockDismiss()) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (blockDismiss()) e.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Route className="size-4" />
            {flow.name}
          </DialogTitle>
          <DialogDescription>
            Runs these saved requests in order. Each step's captures become{' '}
            <code className="rounded bg-muted px-1 text-[11px]">{'{{variables}}'}</code> the next
            steps can use — so step 1 can log in and the rest inherit the token.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[68vh] min-w-0 pr-3">
          <div className="min-w-0 space-y-4">
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
                <input
                  type="checkbox"
                  checked={stopOnFail}
                  onChange={(e) => setStopOnFail(e.target.checked)}
                  className="size-3.5 accent-primary"
                />
                Stop on first failure
              </label>
            </div>

            {/* Run as — pick the identity instead of hard-coding a label per request. */}
            <FlowAuthPicker
              projectId={projectId}
              value={auth}
              onChange={setAuth}
              disabled={running}
              onManageAccounts={openAccounts}
            />

            {/* Steps */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Steps</Label>
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
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-3 text-xs text-muted-foreground">
                  No steps yet — add saved requests in the order they should run.
                </p>
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
                        <input
                          type="checkbox"
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
                          className="size-3.5 shrink-0 accent-primary"
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
                          <input
                            type="checkbox"
                            checked={step.continueOnFail}
                            onChange={(e) =>
                              setSteps(
                                steps.map((s) =>
                                  s.id === step.id ? { ...s, continueOnFail: e.target.checked } : s,
                                ),
                              )
                            }
                            disabled={running}
                            className="size-3 accent-primary"
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
            </div>

            {/* Run report */}
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

            {/* Previous runs — evidence the scenario passed, kept with the project. */}
            {(history?.runs ?? []).length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">Previous runs</Label>
                <div className="space-y-1">
                  {(history?.runs ?? []).slice(0, 5).map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-2.5 py-1.5 text-[11px]"
                    >
                      <span className="truncate text-muted-foreground">
                        {new Date(r.at).toLocaleString()}
                      </span>
                      <span
                        className={cn(
                          'shrink-0 font-medium',
                          r.summary.failed ? 'text-destructive' : 'text-emerald-600',
                        )}
                      >
                        {r.summary.passed}/{r.summary.total} passed
                        {r.summary.skipped ? ` · ${r.summary.skipped} skipped` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="min-w-0 sm:flex-wrap">
          <Button
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={running || remove.isPending}
            className="mr-auto gap-1.5 text-destructive hover:text-destructive"
          >
            <Trash2 className="size-4" />
            Delete
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Close
          </Button>
          <Button
            variant="secondary"
            onClick={() => save.mutate()}
            disabled={running || save.isPending || !dirty}
            className="gap-1.5 rounded-full"
          >
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
          <Button
            onClick={run}
            disabled={running || steps.every((s) => !s.enabled)}
            className="gap-1.5 rounded-full"
          >
            {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            {running ? 'Running…' : 'Run flow'}
          </Button>
        </DialogFooter>
      </DialogContent>

      {accountsOpen && <ApiAccountsDialog projectId={projectId} onClose={closeAccounts} />}
    </Dialog>
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
      <DialogContent className="max-h-[92vh] w-[97vw] gap-4 overflow-hidden sm:max-w-3xl">
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
        className="size-7 rounded-md text-muted-foreground hover:text-destructive"
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

  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-xs font-medium">Run as</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Account</Label>
              <Select
                value={value.accountLabel || NO_AUTH}
                onValueChange={(v) => onChange({ ...value, accountLabel: v === NO_AUTH ? '' : v })}
                disabled={disabled}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="No account" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AUTH} className="text-xs">
                    No account
                  </SelectItem>
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
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue placeholder="Not needed" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_AUTH} className="text-xs">
                    Not needed
                  </SelectItem>
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

          {(accountMissing || totpMissing) && (
            <p className="text-[11px] text-destructive">
              {accountMissing && `Account “${value.accountLabel}” no longer exists. `}
              {totpMissing && `Authenticator “${value.totpLabel}” no longer exists. `}
              Pick again, or the run stops on an unresolved variable.
            </p>
          )}

          <p className="text-[11px] leading-snug text-muted-foreground">
            Write <code className="rounded bg-background px-1">{'{{auth.username}}'}</code>{' '}
            <code className="rounded bg-background px-1">{'{{auth.password}}'}</code>
            {value.totpLabel && (
              <>
                {' '}
                <code className="rounded bg-background px-1">{'{{auth.otp}}'}</code>
              </>
            )}{' '}
            in the login request — the server fills them in at send time (the password never reaches
            this page). A specific account is still addressable as{' '}
            <code className="rounded bg-background px-1">{'{{account.<label>.username}}'}</code>.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onManageAccounts}
              disabled={disabled}
              className="h-7 gap-1.5 rounded-full text-[11px]"
            >
              <KeyRound className="size-3.5" />
              Manage accounts
            </Button>
            <Link
              to="/instructions?tab=accounts"
              className="text-[11px] font-medium text-primary hover:underline"
            >
              Register a 2FA authenticator →
            </Link>
          </div>
        </div>
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
  saved,
  onPick,
  counts,
}: {
  saved: ApiRequestDef[]
  onPick: (requestName: string) => void
  /** How many times each request is already in the flow, shown as a ×N badge. */
  counts: Record<string, number>
}) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = saved.filter(
    (s) => !needle || `${s.name} ${s.url} ${s.group}`.toLowerCase().includes(needle),
  )
  return (
    <div className="space-y-2 rounded-xl border border-primary/30 bg-primary/5 p-2.5">
      <p className="text-[11px] text-muted-foreground">
        Click requests in the order they should run — click one twice to use it twice.
      </p>
      {saved.length > 5 && (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter requests…"
          className="h-8 text-xs"
        />
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
              <span className="block truncate text-[10px] text-muted-foreground">{s.url}</span>
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
          <p className="px-1 py-3 text-center text-[11px] text-muted-foreground">
            {saved.length
              ? 'No saved requests match.'
              : 'Save a request first — flows run saved requests.'}
          </p>
        )}
      </div>
    </div>
  )
}
