import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Clock3,
  FileJson,
  History as HistoryIcon,
  Check,
  Info,
  KeyRound,
  Loader2,
  CircleStop,
  Pencil,
  Plus,
  Radar,
  Search,
  Send,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  Trash2,
  Variable,
  Wand2,
  WrapText,
  X,
  XCircle,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { useProjects } from '@/lib/project-context'
import { cn } from '@/lib/utils'
import { parseCurl, toCurl } from '@/lib/curl'
import { scanResponse, type ApiFinding, type Severity } from '@/lib/apiChecks'
import {
  aiCheckApi,
  captureApiVariable,
  clearApiResults,
  deleteApiRequest,
  getApiEnvironments,
  getApiResult,
  getApiScan,
  getScanAvailable,
  listApiRequests,
  listApiResults,
  openApiTestsFolder,
  renameApiRequest,
  saveApiEnvironments,
  saveApiRequest,
  saveApiResult,
  sendApiRequest,
  startApiScan,
  stopApiScan,
  type AiCheckResult,
  type ApiAssertion,
  type ApiAssertionType,
  type ApiBodyMode,
  type ApiCapture,
  type ApiEnvironment,
  type ApiEnvironments,
  type ApiKV,
  type ApiRequestDef,
  type ApiResultMeta,
  type ApiSendResult,
  type ApiVariable,
  type ScanJob,
  type ScanRequest,
} from '@/lib/api'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

/** Tailwind text color per HTTP method, for the method chips. */
function methodColor(m: string): string {
  switch (m) {
    case 'GET':
      return 'text-emerald-600'
    case 'POST':
      return 'text-sky-600'
    case 'PUT':
    case 'PATCH':
      return 'text-amber-600'
    case 'DELETE':
      return 'text-red-600'
    default:
      return 'text-muted-foreground'
  }
}

// Quick-select QC criteria for the AI check — clicking a chip toggles its line into
// the plain-language expectation, so common checks don't have to be typed by hand.
const AI_CRITERIA: { label: string; text: string }[] = [
  { label: 'Success (2xx)', text: 'The HTTP status is a success (2xx).' },
  { label: 'Valid JSON', text: 'The response body is valid, well-formed JSON.' },
  {
    label: 'No secrets',
    text: 'The body exposes no passwords, tokens, secrets or API keys.',
  },
  { label: 'Required fields present', text: 'All expected fields are present and non-null.' },
  {
    label: 'Correct data types',
    text: 'Every field has the correct data type (ids, dates, booleans, numbers).',
  },
  {
    label: 'No internal errors leaked',
    text: 'No stack traces, SQL errors or internal implementation details are exposed.',
  },
  {
    label: 'Clear error on failure',
    text: 'On an error status the body includes a clear, human-readable error message and/or code.',
  },
  { label: 'Fast (< 2s)', text: 'The response time is reasonable (under about 2 seconds).' },
  {
    label: 'Pagination info',
    text: 'A list response includes pagination info (page, page size, total count).',
  },
  {
    label: 'Matches the request',
    text: 'The returned data matches the request (respects the ids, filters and params sent).',
  },
  {
    label: 'Consistent naming',
    text: 'Field naming is consistent across the response (e.g. all camelCase).',
  },
]

const ASSERTION_LABELS: Record<ApiAssertionType, string> = {
  'status-2xx': 'Status is 2xx',
  'status-equals': 'Status equals',
  'body-contains': 'Body contains',
  'body-matches': 'Body matches regex',
  'json-equals': 'JSON path equals',
  'json-exists': 'JSON path exists',
  'header-equals': 'Header equals',
  'header-exists': 'Header exists',
  'time-below': 'Response time < (ms)',
}

type Draft = Omit<ApiRequestDef, 'name' | 'savedAt'>

function emptyDraft(): Draft {
  return {
    method: 'GET',
    url: '',
    query: [],
    headers: [],
    bodyMode: 'none',
    body: '',
    assertions: [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
    aiExpect: '',
    captures: [],
  }
}

/** The draft-relevant slice of a saved request (drops name/savedAt) for equality checks. */
function draftOf(r: ApiRequestDef): Draft {
  return {
    method: r.method,
    url: r.url,
    query: r.query ?? [],
    headers: r.headers ?? [],
    bodyMode: r.bodyMode ?? 'none',
    body: r.body ?? '',
    assertions: r.assertions ?? [],
    aiExpect: r.aiExpect ?? '',
    captures: r.captures ?? [],
  }
}

/** True when a draft is byte-identical to what's already saved — nothing to persist. */
function sameAsSaved(saved: ApiRequestDef | undefined, draft: Draft): boolean {
  return !!saved && JSON.stringify(draftOf(saved)) === JSON.stringify(draft)
}

/** The full URL a request actually hits — base URL plus its enabled query params. */
function composedUrl(r: { url: string; query: ApiKV[] }): string {
  const enabled = r.query.filter((q) => q.enabled && q.key)
  if (!enabled.length) return r.url
  try {
    const u = new URL(r.url)
    for (const q of enabled) u.searchParams.append(q.key, q.value)
    return u.toString()
  } catch {
    const qs = enabled.map((q) => `${q.key}=${q.value}`).join('&')
    return r.url + (r.url.includes('?') ? '&' : '?') + qs
  }
}

/** Identity of a request for dedup on auto-save: method + the full URL it hits. */
function requestKey(r: { method: string; url: string; query: ApiKV[] }): string {
  return `${r.method} ${composedUrl(r)}`
}

/** A readable, filename-safe name derived from a request (server NAME_RE: [\w .-]). */
function deriveName(d: Draft): string {
  let path = d.url
  try {
    const u = new URL(d.url)
    path = u.pathname && u.pathname !== '/' ? u.pathname : u.host
  } catch {
    /* schemeless URL — use it as typed */
  }
  const base = `${d.method} ${path}`
    .replace(/[^\w .-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return base || d.method
}

function statusTone(status?: number): string {
  if (!status) return 'bg-muted text-muted-foreground'
  if (status >= 200 && status < 300) return 'bg-emerald-100 text-emerald-700'
  if (status >= 300 && status < 400) return 'bg-sky-100 text-sky-700'
  if (status >= 400 && status < 500) return 'bg-amber-100 text-amber-700'
  return 'bg-red-100 text-red-700'
}

function formatBytes(n?: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

/** Resolve a simple dotted/bracket JSON path (e.g. `data.items[0].id`). */
function getJsonPath(root: unknown, path: string): unknown {
  if (!path) return root
  const parts = path
    .replace(/\[(\w+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter(Boolean)
  let cur: unknown = root
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

interface AssertionResult {
  assertion: ApiAssertion
  pass: boolean
  detail: string
}

/** Evaluate the request's assertions against a response — all client-side. */
function evaluateAssertions(assertions: ApiAssertion[], res: ApiSendResult): AssertionResult[] {
  let parsedJson: unknown
  let parsedOk = false
  if (res.bodyText) {
    try {
      parsedJson = JSON.parse(res.bodyText)
      parsedOk = true
    } catch {
      parsedOk = false
    }
  }
  return assertions
    .filter((a) => a.enabled)
    .map((a) => {
      const status = res.status ?? 0
      switch (a.type) {
        case 'status-2xx':
          return {
            assertion: a,
            pass: status >= 200 && status < 300,
            detail: `status ${status}`,
          }
        case 'status-equals': {
          const want = Number(a.expected)
          return {
            assertion: a,
            pass: status === want,
            detail: `status ${status} — expected ${a.expected || '?'}`,
          }
        }
        case 'body-contains':
          return {
            assertion: a,
            pass: !!a.expected && (res.bodyText ?? '').includes(a.expected),
            detail: a.expected ? `looking for "${a.expected}"` : 'no text set',
          }
        case 'body-matches': {
          if (!a.expected) return { assertion: a, pass: false, detail: 'no pattern set' }
          try {
            const re = new RegExp(a.expected)
            return {
              assertion: a,
              pass: re.test(res.bodyText ?? ''),
              detail: `/${a.expected}/`,
            }
          } catch {
            return { assertion: a, pass: false, detail: 'invalid regex' }
          }
        }
        case 'json-equals': {
          if (!parsedOk) return { assertion: a, pass: false, detail: 'response is not JSON' }
          const actual = getJsonPath(parsedJson, a.target)
          const actualStr = actual === undefined ? 'undefined' : JSON.stringify(actual)
          const want = a.expected
          // Compare on the FULL value; only clip what we display so a big object at
          // the path (or root) doesn't dump the whole body into the row.
          const pass = String(actual) === want || actualStr === want
          const shown = actualStr.length > 140 ? `${actualStr.slice(0, 140)}…` : actualStr
          return {
            assertion: a,
            pass,
            detail: `${a.target || '(root)'} = ${shown} — expected ${want || '?'}`,
          }
        }
        case 'json-exists': {
          if (!parsedOk) return { assertion: a, pass: false, detail: 'response is not JSON' }
          const actual = getJsonPath(parsedJson, a.target)
          return {
            assertion: a,
            pass: actual !== undefined,
            detail: `${a.target || '(root)'} ${actual !== undefined ? 'present' : 'missing'}`,
          }
        }
        case 'header-equals': {
          const key = a.target.toLowerCase()
          const actual = res.headers?.[key]
          return {
            assertion: a,
            pass: actual !== undefined && actual === a.expected,
            detail: `${a.target || '?'}: ${actual ?? '(absent)'} — expected ${a.expected || '?'}`,
          }
        }
        case 'header-exists': {
          const key = a.target.toLowerCase()
          const actual = res.headers?.[key]
          return {
            assertion: a,
            pass: actual !== undefined,
            detail: `${a.target || '?'} ${actual !== undefined ? 'present' : 'absent'}`,
          }
        }
        case 'time-below': {
          const limit = Number(a.expected)
          return {
            assertion: a,
            pass: Number.isFinite(limit) && res.timeMs < limit,
            detail: `${res.timeMs}ms — limit ${a.expected || '?'}ms`,
          }
        }
        default:
          return { assertion: a, pass: false, detail: 'unknown assertion' }
      }
    })
}

// ---------------------------------------------------------------- KV editor

function KVEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: ApiKV[]
  onChange: (rows: ApiKV[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  const update = (i: number, patch: Partial<ApiKV>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () => onChange([...rows, { key: '', value: '', enabled: true }])
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">None yet.</p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={r.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
            className="size-4 shrink-0 rounded border-border accent-primary"
            aria-label="Enabled"
          />
          <Input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="h-9 flex-1 rounded-lg font-mono text-xs shadow-none"
          />
          <Input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="h-9 flex-[2] rounded-lg font-mono text-xs shadow-none"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => remove(i)}
            className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
            aria-label="Remove row"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={add}
        className="rounded-full active:scale-[0.98]"
      >
        <Plus className="size-3.5" />
        Add
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- Assertion editor

const ASSERTION_PRESETS: { label: string; patch: Partial<ApiAssertion> }[] = [
  { label: 'Status 2xx', patch: { type: 'status-2xx' } },
  { label: 'Status =', patch: { type: 'status-equals', expected: '200' } },
  { label: 'Body contains', patch: { type: 'body-contains' } },
  { label: 'JSON path =', patch: { type: 'json-equals' } },
  { label: 'Has field', patch: { type: 'json-exists' } },
  { label: 'Header exists', patch: { type: 'header-exists' } },
  { label: 'Time < 2s', patch: { type: 'time-below', expected: '2000' } },
]

const needsTarget = (t: ApiAssertionType) =>
  t === 'json-equals' || t === 'json-exists' || t === 'header-equals' || t === 'header-exists'
const needsExpected = (t: ApiAssertionType) =>
  t !== 'status-2xx' && t !== 'json-exists' && t !== 'header-exists'
const isEquals = (t: ApiAssertionType) => t === 'json-equals' || t === 'header-equals'

function AssertionEditor({
  rows,
  onChange,
  results,
}: {
  rows: ApiAssertion[]
  onChange: (rows: ApiAssertion[]) => void
  results: AssertionResult[] | null
}) {
  const update = (i: number, patch: Partial<ApiAssertion>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  // Derive the next id from existing ones (pure — no Date/random) so keys stay unique.
  const nextId = () => {
    const nums = rows
      .map((r) => Number.parseInt(r.id.replace(/^a/, ''), 10))
      .filter((n) => Number.isFinite(n))
    return `a${(nums.length ? Math.max(...nums) : 0) + 1}`
  }
  const add = (patch?: Partial<ApiAssertion>) =>
    onChange([
      ...rows,
      { id: nextId(), type: 'status-2xx', target: '', expected: '', enabled: true, ...patch },
    ])
  const resultFor = (a: ApiAssertion) => results?.find((r) => r.assertion.id === a.id) ?? null
  const passed = results?.filter((r) => r.pass).length ?? 0
  const total = results?.length ?? 0

  return (
    <div className="space-y-3">
      {/* Result summary — appears once a response has been evaluated. */}
      {total > 0 && (
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums',
              passed === total ? 'text-emerald-600' : 'text-red-600',
            )}
          >
            {passed === total ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <XCircle className="size-4" />
            )}
            {passed}/{total} passed
          </span>
          <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            {results!.map((r, i) => (
              <span
                key={i}
                className={cn('h-full', r.pass ? 'bg-emerald-500' : 'bg-red-500')}
                style={{ width: `${100 / total}%` }}
              />
            ))}
          </span>
        </div>
      )}

      {/* Quick-add presets */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-muted-foreground">Quick add:</span>
        {ASSERTION_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => add(p.patch)}
            className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground active:scale-[0.98]"
          >
            <Plus className="size-3" />
            {p.label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            No checks yet — add one above to turn the response into a pass/fail verdict.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((a, i) => {
            const r = resultFor(a)
            return (
              <div
                key={a.id}
                className={cn(
                  'rounded-xl border border-l-[3px] p-2.5 transition-colors',
                  r
                    ? r.pass
                      ? 'border-border/60 border-l-emerald-500 bg-emerald-50/30'
                      : 'border-border/60 border-l-red-500 bg-red-50/30'
                    : cn(
                        'border-border/60 border-l-border bg-muted/20',
                        !a.enabled && 'opacity-55',
                      ),
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                    className="size-4 shrink-0 rounded border-border accent-primary"
                    aria-label={a.enabled ? 'Enabled — click to skip' : 'Disabled — click to enable'}
                    title={a.enabled ? 'Enabled' : 'Disabled (skipped)'}
                  />
                  <Select
                    value={a.type}
                    onValueChange={(v) => update(i, { type: v as ApiAssertionType })}
                  >
                    <SelectTrigger className="h-9 w-[180px] shrink-0 rounded-lg text-xs shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ASSERTION_LABELS) as ApiAssertionType[]).map((t) => (
                        <SelectItem key={t} value={t} className="text-xs">
                          {ASSERTION_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {needsTarget(a.type) && (
                    <Input
                      value={a.target}
                      onChange={(e) => update(i, { target: e.target.value })}
                      placeholder={
                        a.type === 'json-equals' || a.type === 'json-exists'
                          ? 'data.items[0].id'
                          : 'Header-Name'
                      }
                      className="h-9 min-w-0 flex-1 rounded-lg font-mono text-xs shadow-none"
                    />
                  )}
                  {isEquals(a.type) && (
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">=</span>
                  )}
                  {needsExpected(a.type) && (
                    <Input
                      value={a.expected}
                      onChange={(e) => update(i, { expected: e.target.value })}
                      placeholder={
                        a.type === 'time-below'
                          ? 'ms e.g. 2000'
                          : a.type === 'body-matches'
                            ? 'regex'
                            : a.type === 'status-equals'
                              ? '200'
                              : 'expected value'
                      }
                      className="h-9 min-w-0 flex-1 rounded-lg font-mono text-xs shadow-none"
                    />
                  )}
                  {r && (
                    <Badge
                      variant="outline"
                      className={cn(
                        'ml-auto shrink-0 gap-1',
                        r.pass
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                          : 'border-red-200 bg-red-50 text-red-700',
                      )}
                    >
                      {r.pass ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
                      {r.pass ? 'Pass' : 'Fail'}
                    </Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(i)}
                    className={cn(
                      'size-9 shrink-0 rounded-lg text-muted-foreground hover:text-destructive',
                      !r && 'ml-auto',
                    )}
                    aria-label="Remove check"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                {/* The actual observed value — why it passed or failed. */}
                {r && (
                  <p
                    className={cn(
                      'mt-1.5 line-clamp-2 break-all pl-6 font-mono text-[11px]',
                      r.pass ? 'text-muted-foreground' : 'text-red-600',
                    )}
                    title={r.detail}
                  >
                    {r.detail}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() => add()}
        className="rounded-full active:scale-[0.98]"
      >
        <Plus className="size-3.5" />
        Add custom check
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- Capture editor

function CaptureEditor({
  rows,
  onChange,
  activeEnv,
}: {
  rows: ApiCapture[]
  onChange: (rows: ApiCapture[]) => void
  activeEnv: string | null
}) {
  const update = (i: number, patch: Partial<ApiCapture>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const nextId = () => {
    const nums = rows
      .map((r) => Number.parseInt(r.id.replace(/^c/, ''), 10))
      .filter((n) => Number.isFinite(n))
    return `c${(nums.length ? Math.max(...nums) : 0) + 1}`
  }
  const add = () =>
    onChange([...rows, { id: nextId(), jsonPath: '', varName: '', secret: false }])

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        After each send, pull a value out of the JSON response by path and store it in the{' '}
        {activeEnv ? (
          <>
            <span className="font-medium text-foreground">{activeEnv}</span> environment
          </>
        ) : (
          'active environment'
        )}{' '}
        as a variable — reuse it later as <span className="font-mono">{'{{name}}'}</span>. Great for
        login → token → authenticated calls.
      </p>
      {!activeEnv && (
        <p className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-700">
          <AlertTriangle className="size-3.5 shrink-0" />
          No active environment — captures will create one named “Default”.
        </p>
      )}
      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center">
          <p className="text-xs text-muted-foreground">
            No captures yet — add one to extract a value from the response into a variable.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((c, i) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2">
              <Input
                value={c.jsonPath}
                onChange={(e) => update(i, { jsonPath: e.target.value })}
                placeholder="data.token"
                className="h-9 min-w-0 flex-1 rounded-lg font-mono text-xs shadow-none"
              />
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                value={c.varName}
                onChange={(e) => update(i, { varName: e.target.value })}
                placeholder="token"
                className="h-9 min-w-0 flex-1 rounded-lg font-mono text-xs shadow-none"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => update(i, { secret: !c.secret })}
                className={cn(
                  'size-9 shrink-0 rounded-lg',
                  c.secret ? 'text-amber-600' : 'text-muted-foreground hover:text-foreground',
                )}
                title={c.secret ? 'Stored as a secret (masked)' : 'Store as a secret'}
                aria-label="Toggle secret"
              >
                <KeyRound className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => remove(i)}
                className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
                aria-label="Remove capture"
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button variant="outline" size="sm" onClick={add} className="rounded-full active:scale-[0.98]">
        <Plus className="size-3.5" />
        Add capture
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- Response view

function ResponseView({ res }: { res: ApiSendResult }) {
  const pretty = useMemo(() => {
    if (!res.bodyText) return ''
    try {
      return JSON.stringify(JSON.parse(res.bodyText), null, 2)
    } catch {
      return res.bodyText
    }
  }, [res.bodyText])
  const isJson = (res.contentType ?? '').includes('json')
  // Controlled so the Copy button knows which tab (pretty / raw / headers) to copy.
  const [tab, setTab] = useState('body')
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)

  const headersText = useMemo(
    () =>
      Object.entries(res.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n'),
    [res.headers],
  )
  const copyText = tab === 'headers' ? headersText : tab === 'raw' ? (res.bodyText ?? '') : pretty
  const copyNow = async () => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }
  const preWrap = wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'

  if (!res.ok) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        <div>
          <p className="font-medium">Request failed</p>
          <p className="text-destructive/80">{res.error}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={cn('rounded-full px-2.5 py-1 font-semibold tabular-nums', statusTone(res.status))}>
          {res.status} {res.statusText}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
          <Clock3 className="size-3" />
          {res.timeMs} ms
        </span>
        <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">
          {formatBytes(res.sizeBytes)}
          {res.truncated && ' (truncated)'}
        </span>
        {res.contentType && (
          <span className="truncate rounded-full bg-muted px-2.5 py-1 font-mono text-muted-foreground">
            {res.contentType.split(';')[0]}
          </span>
        )}
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList className="rounded-full">
            <TabsTrigger value="body" className="rounded-full text-xs">
              {isJson ? 'Pretty' : 'Body'}
            </TabsTrigger>
            <TabsTrigger value="raw" className="rounded-full text-xs">
              Raw
            </TabsTrigger>
            <TabsTrigger value="headers" className="rounded-full text-xs">
              Headers ({Object.keys(res.headers ?? {}).length})
            </TabsTrigger>
          </TabsList>
          <div className="flex items-center gap-1.5">
            {tab !== 'headers' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setWrap((w) => !w)}
                className={cn(
                  'h-8 gap-1.5 rounded-full text-xs active:scale-[0.98]',
                  wrap ? 'text-primary' : 'text-muted-foreground',
                )}
                title={wrap ? 'Wrapping long lines' : 'Wrap long lines'}
              >
                <WrapText className="size-3.5" />
                Wrap
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={copyNow}
              disabled={!copyText}
              className="h-8 gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground active:scale-[0.98]"
              title="Copy this view to the clipboard"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-500" />
              ) : (
                <Clipboard className="size-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
        <TabsContent value="body">
          <pre
            className={cn(
              'max-h-[420px] overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100',
              preWrap,
            )}
          >
            {pretty || '(empty body)'}
          </pre>
        </TabsContent>
        <TabsContent value="raw">
          <pre
            className={cn(
              'max-h-[420px] overflow-auto rounded-xl bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-100',
              preWrap,
            )}
          >
            {res.bodyText || '(empty body)'}
          </pre>
        </TabsContent>
        <TabsContent value="headers">
          <div className="max-h-[420px] overflow-auto rounded-xl border border-border/60">
            <table className="w-full text-xs">
              <tbody>
                {Object.entries(res.headers ?? {}).map(([k, v]) => (
                  <tr key={k} className="border-b border-border/40 last:border-0">
                    <td className="w-1/3 whitespace-nowrap px-3 py-1.5 align-top font-mono font-medium text-foreground">
                      {k}
                    </td>
                    <td className="break-all px-3 py-1.5 font-mono text-muted-foreground">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------- cURL import

function CurlImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onImport: (draft: Draft) => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const doImport = () => {
    const parsed = parseCurl(text)
    if (!parsed) {
      setError('Could not find a URL in that command. Paste a full curl command.')
      return
    }
    onImport({
      method: parsed.method,
      url: parsed.url,
      query: parsed.query,
      headers: parsed.headers,
      bodyMode: parsed.bodyMode,
      body: parsed.body,
      assertions: [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
      aiExpect: '',
      captures: [],
    })
    setText('')
    setError(null)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TerminalSquare className="size-4 text-primary" />
            Import from cURL
          </DialogTitle>
          <DialogDescription>
            Paste a <span className="font-mono">curl</span> command — from your browser's “Copy as
            cURL”, Postman, or the API docs. Method, URL, headers, query and body are filled in.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          placeholder={`curl 'https://api.example.com/login' \\\n  -H 'Content-Type: application/json' \\\n  --data '{"email":"a@b.co","password":"…"}'`}
          className="min-h-[160px] rounded-xl font-mono text-xs shadow-none"
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <AlertCircle className="size-3.5" />
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="rounded-full">
            Cancel
          </Button>
          <Button
            onClick={doImport}
            disabled={!text.trim()}
            className="rounded-full active:scale-[0.98]"
          >
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Scan page for APIs

/** Turn one detected request into an editable draft (URL split into base + query). */
function scanToDraft(r: ScanRequest): Draft {
  let base = r.url
  const query: ApiKV[] = []
  try {
    const u = new URL(r.url)
    base = `${u.origin}${u.pathname}`
    for (const [key, value] of u.searchParams) query.push({ key, value, enabled: true })
  } catch {
    /* schemeless / odd URL — keep as-is */
  }
  const isJson = (r.requestContentType ?? '').includes('json')
  const bodyMode: ApiBodyMode = r.hasBody ? (isJson ? 'json' : 'text') : 'none'
  let body = r.bodyPreview ?? ''
  if (bodyMode === 'json' && body) {
    try {
      body = JSON.stringify(JSON.parse(body), null, 2)
    } catch {
      /* leave the raw body */
    }
  }
  return {
    method: r.method,
    url: base,
    query,
    headers: [],
    bodyMode,
    body,
    assertions: [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
    aiExpect: '',
    captures: [],
  }
}

/**
 * Scan a page for its APIs. Opens a headed Chrome (logged-in profile) at a page
 * URL, records the XHR/fetch traffic as a background job, then previews the
 * detected endpoints as a deletable/selectable list to import as saved requests.
 * Mounted only while open (seeds fresh; reconnects to a running scan via the
 * per-project stored job id).
 */
function ScanPageDialog({
  projectId,
  open,
  onOpenChange,
  existingNames,
  onImported,
}: {
  projectId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  existingNames: string[]
  onImported: () => void
}) {
  const queryClient = useQueryClient()
  const jobKey = `qc.apiScanJob.${projectId}`
  const [url, setUrl] = useState('')
  // Off = headless (no window). On = open a visible Chrome (for pages needing login).
  const [headed, setHeaded] = useState(false)
  const [jobId, setJobId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(jobKey)
    } catch {
      return null
    }
  })
  const [removed, setRemoved] = useState<Set<string>>(new Set())
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [importing, setImporting] = useState(false)

  const setJob = (id: string | null) => {
    setJobId(id)
    try {
      if (id) localStorage.setItem(jobKey, id)
      else localStorage.removeItem(jobKey)
    } catch {
      /* storage unavailable */
    }
  }

  const { data: avail } = useQuery({
    queryKey: ['api-scan-available'],
    queryFn: getScanAvailable,
    enabled: open,
    staleTime: 60_000,
  })

  const { data: job } = useQuery({
    queryKey: ['api-scan', projectId, jobId],
    queryFn: () => getApiScan(projectId, jobId as string),
    enabled: open && !!jobId,
    refetchInterval: (q) =>
      (q.state.data as ScanJob | undefined)?.status === 'running' ? 1200 : false,
    retry: false,
  })

  const start = useMutation({
    mutationFn: (u: string) => startApiScan(projectId, u, !headed),
    onSuccess: (j) => {
      setRemoved(new Set())
      setUnchecked(new Set())
      setJob(j.id)
      queryClient.setQueryData(['api-scan', projectId, j.id], j)
    },
    onError: (e) =>
      toast.error('Could not start scan', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const stop = useMutation({
    mutationFn: () => stopApiScan(projectId, jobId as string),
    onSuccess: (j) => queryClient.setQueryData(['api-scan', projectId, j.id], j),
    onError: (e) =>
      toast.error('Could not stop scan', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const running = job?.status === 'running'
  const visible = (job?.requests ?? []).filter((r) => !removed.has(r.id))
  const selected = visible.filter((r) => !unchecked.has(r.id))

  const toggle = (id: string) =>
    setUnchecked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const remove = (id: string) => setRemoved((s) => new Set(s).add(id))
  const allSelected = visible.length > 0 && selected.length === visible.length
  const toggleAll = () =>
    setUnchecked(allSelected ? new Set(visible.map((r) => r.id)) : new Set())

  const doImport = async () => {
    if (!selected.length) return
    setImporting(true)
    const taken = new Set(existingNames)
    let ok = 0
    for (const r of selected) {
      const draft = scanToDraft(r)
      const base = deriveName(draft)
      let name = base
      let n = 2
      while (taken.has(name)) name = `${base} (${n++})`.slice(0, 60)
      taken.add(name)
      try {
        await saveApiRequest(projectId, name, draft)
        ok++
      } catch {
        /* skip a single bad save (oversize / bad name) — keep importing the rest */
      }
    }
    setImporting(false)
    queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
    onImported()
    if (ok) toast.success(`Imported ${ok} request${ok === 1 ? '' : 's'}`)
    else toast.error('Nothing imported')
    reset()
    onOpenChange(false)
  }

  const reset = () => {
    if (running) stop.mutate()
    setJob(null)
    setRemoved(new Set())
    setUnchecked(new Set())
  }

  const canStart = !!url.trim() && !start.isPending && avail?.ok !== false

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && importing) return
        onOpenChange(v)
      }}
    >
      <DialogContent className="rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radar className="size-4 text-primary" />
            Scan a page for its APIs
          </DialogTitle>
          <DialogDescription>
            Loads a page URL using your logged-in profile and records the API calls it makes — by
            default in the background with <span className="font-medium">no browser window</span>.
            Preview the detected endpoints, delete any you don't want, and import the rest.
          </DialogDescription>
        </DialogHeader>

        {avail?.ok === false ? (
          <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Scanning isn't available on this machine.</p>
              <p className="text-amber-700/80">
                {avail.error ?? 'Google Chrome + Playwright are required.'}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {/* URL bar */}
            <div className="flex items-center gap-2">
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canStart) start.mutate(url.trim())
                }}
                placeholder="http://localhost:5173/administration/medical-billing-management"
                className="h-10 flex-1 rounded-xl font-mono text-xs shadow-none"
                spellCheck={false}
                autoFocus
                disabled={!!jobId}
              />
              {jobId ? (
                <Button
                  variant="outline"
                  onClick={reset}
                  className="h-10 shrink-0 gap-1.5 rounded-full active:scale-[0.98]"
                >
                  <X className="size-4" />
                  New scan
                </Button>
              ) : (
                <Button
                  onClick={() => start.mutate(url.trim())}
                  disabled={!canStart}
                  className="h-10 shrink-0 gap-2 rounded-full px-5 active:scale-[0.98]"
                >
                  {start.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Radar className="size-4" />
                  )}
                  Scan
                </Button>
              )}
            </div>

            {/* Mode: headless by default, opt into a visible window for login-walled pages. */}
            {!jobId && (
              <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={headed}
                  onChange={(e) => setHeaded(e.target.checked)}
                  className="size-3.5 rounded border-border accent-primary"
                />
                Open a visible browser window (only needed if the page makes you log in first)
              </label>
            )}

            {/* Live status + stop */}
            {jobId && job && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
                <span className="inline-flex items-center gap-2 text-xs">
                  {running ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin text-primary" />
                      <span className="font-medium">Recording…</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                      <span className="font-medium">Capture ended</span>
                    </>
                  )}
                  <span className="text-muted-foreground">
                    {visible.length} API request{visible.length === 1 ? '' : 's'} found
                  </span>
                </span>
                {running && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => stop.mutate()}
                    disabled={stop.isPending}
                    className="h-8 gap-1.5 rounded-full active:scale-[0.98]"
                  >
                    {stop.isPending ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CircleStop className="size-3.5" />
                    )}
                    Stop &amp; preview
                  </Button>
                )}
              </div>
            )}
            {job?.error && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertCircle className="size-3.5" />
                {job.error}
              </p>
            )}

            {/* Detected requests */}
            {jobId && (
              <>
                {visible.length > 0 && (
                  <div className="flex items-center justify-between px-1">
                    <button
                      type="button"
                      onClick={toggleAll}
                      className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      <input
                        type="checkbox"
                        checked={allSelected}
                        readOnly
                        className="size-3.5 rounded border-border accent-primary"
                      />
                      {allSelected ? 'Deselect all' : 'Select all'}
                    </button>
                    <span className="text-[11px] text-muted-foreground">
                      {selected.length} selected
                    </span>
                  </div>
                )}
                <div className="max-h-[340px] space-y-1.5 overflow-auto rounded-xl border border-border/60 p-1.5">
                  {visible.length === 0 ? (
                    <p className="px-2 py-8 text-center text-xs text-muted-foreground">
                      {running
                        ? job?.headless
                          ? 'Loading the page and recording its API calls…'
                          : 'Waiting for the page to call its APIs — interact with the window if needed.'
                        : 'No API calls captured. Try a page that loads data, or run with a visible window and log in first.'}
                    </p>
                  ) : (
                    visible.map((r) => {
                      const checked = !unchecked.has(r.id)
                      return (
                        <div
                          key={r.id}
                          className={cn(
                            'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 transition-colors',
                            checked
                              ? 'border-border/60 bg-card'
                              : 'border-transparent bg-muted/20 opacity-60',
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggle(r.id)}
                            className="size-4 shrink-0 rounded border-border accent-primary"
                            aria-label="Import this request"
                          />
                          <span
                            className={cn(
                              'w-14 shrink-0 font-mono text-[10px] font-bold',
                              methodColor(r.method),
                            )}
                          >
                            {r.method}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                            title={r.url}
                          >
                            {r.url}
                          </span>
                          {r.count > 1 && (
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                              ×{r.count}
                            </span>
                          )}
                          {r.status !== undefined && r.status > 0 && (
                            <span
                              className={cn(
                                'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
                                statusTone(r.status),
                              )}
                            >
                              {r.status}
                            </span>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => remove(r.id)}
                            className="size-7 shrink-0 rounded-md text-muted-foreground hover:text-destructive"
                            aria-label="Remove from list"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      )
                    })
                  )}
                </div>
                <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <Info className="size-3 shrink-0 text-sky-500" />
                  Login/auth isn't imported — if an endpoint needs a token, add it as a header or{' '}
                  <span className="font-mono">{'{{variable}}'}</span> after importing.
                </p>
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
            disabled={importing}
            className="rounded-full"
          >
            Close
          </Button>
          <Button
            onClick={doImport}
            disabled={!selected.length || importing}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Import {selected.length > 0 ? `${selected.length} ` : ''}request
            {selected.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- Environments

/** Variable rows editor for one environment (key / value / secret). */
function VariableRows({
  vars,
  onChange,
}: {
  vars: ApiVariable[]
  onChange: (vars: ApiVariable[]) => void
}) {
  const update = (i: number, patch: Partial<ApiVariable>) =>
    onChange(vars.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
  const remove = (i: number) => onChange(vars.filter((_, idx) => idx !== i))
  const add = () => onChange([...vars, { key: '', value: '', secret: false }])
  return (
    <div className="space-y-2">
      {vars.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          No variables yet. Add <span className="font-mono">baseUrl</span>,{' '}
          <span className="font-mono">token</span>, etc.
        </p>
      )}
      {vars.map((v, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={v.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder="name"
            className="h-9 w-[34%] shrink-0 rounded-lg font-mono text-xs shadow-none"
          />
          <Input
            value={v.value}
            onChange={(e) => update(i, { value: e.target.value })}
            type={v.secret ? 'password' : 'text'}
            placeholder={v.secret && v.hasValue && !v.value ? '•••• stored (blank = keep)' : 'value'}
            className="h-9 flex-1 rounded-lg font-mono text-xs shadow-none"
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => update(i, { secret: !v.secret })}
            className={cn(
              'size-9 shrink-0 rounded-lg',
              v.secret ? 'text-amber-600' : 'text-muted-foreground hover:text-foreground',
            )}
            title={v.secret ? 'Secret — masked, stays on the server' : 'Mark as secret'}
            aria-label="Toggle secret"
          >
            <KeyRound className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => remove(i)}
            className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
            aria-label="Remove variable"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add} className="rounded-full active:scale-[0.98]">
        <Plus className="size-3.5" />
        Add variable
      </Button>
    </div>
  )
}

const ENV_NAME_RE = /^[\w .-]{1,40}$/

/** Manage named environments + their variables. Mounted only while open (seeds fresh). */
function ManageEnvironmentsDialog({
  projectId,
  initial,
  onClose,
}: {
  projectId: string
  initial: ApiEnvironments | undefined
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [envs, setEnvs] = useState<ApiEnvironment[]>(() =>
    (initial?.environments ?? []).map((e) => ({
      name: e.name,
      variables: e.variables.map((v) => ({ ...v })),
    })),
  )
  const [active, setActive] = useState<string | null>(() => initial?.active ?? null)
  const [sel, setSel] = useState<string | null>(
    () => initial?.active ?? initial?.environments[0]?.name ?? null,
  )
  const [newEnvName, setNewEnvName] = useState('')

  const selEnv = envs.find((e) => e.name === sel) ?? null

  const save = useMutation({
    mutationFn: () => saveApiEnvironments(projectId, { active, environments: envs }),
    onSuccess: (data) => {
      queryClient.setQueryData(['api-environments', projectId], data)
      queryClient.invalidateQueries({ queryKey: ['api-environments', projectId] })
      toast.success('Environments saved')
      onClose()
    },
    onError: (e) =>
      toast.error('Could not save environments', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const addEnv = () => {
    const name = newEnvName.trim()
    if (!name) return
    if (!ENV_NAME_RE.test(name)) {
      toast.error('Use letters, numbers, spaces, dots or dashes (max 40).')
      return
    }
    if (envs.some((e) => e.name === name)) {
      toast.error('An environment with that name already exists.')
      return
    }
    setEnvs([...envs, { name, variables: [] }])
    setSel(name)
    if (!active) setActive(name)
    setNewEnvName('')
  }
  const deleteEnv = (name: string) => {
    const next = envs.filter((e) => e.name !== name)
    setEnvs(next)
    if (sel === name) setSel(next[0]?.name ?? null)
    if (active === name) setActive(next[0]?.name ?? null)
  }
  const updateVars = (vars: ApiVariable[]) => {
    if (!selEnv) return
    setEnvs(envs.map((e) => (e.name === selEnv.name ? { ...e, variables: vars } : e)))
  }

  return (
    <Dialog open onOpenChange={(v) => !v && !save.isPending && onClose()}>
      <DialogContent className="rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-primary" />
            Environments
          </DialogTitle>
          <DialogDescription>
            Define <span className="font-mono">{'{{variables}}'}</span> per environment (e.g.
            staging vs prod). They’re substituted into the request on the server; values marked{' '}
            <span className="inline-flex items-center gap-0.5 align-middle">
              <KeyRound className="size-3" /> secret
            </span>{' '}
            never come back to the browser.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[200px_1fr]">
          {/* Environment list */}
          <div className="space-y-2">
            <div className="space-y-1">
              {envs.length === 0 && (
                <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                  No environments yet.
                </p>
              )}
              {envs.map((e) => (
                <div
                  key={e.name}
                  className={cn(
                    'group flex items-center gap-1.5 rounded-xl border px-2.5 py-2 transition-colors',
                    sel === e.name
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:border-border/60 hover:bg-muted/40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => setSel(e.name)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <span className="min-w-0 truncate text-xs font-medium" title={e.name}>
                      {e.name}
                    </span>
                    {active === e.name && (
                      <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-emerald-700">
                        active
                      </span>
                    )}
                  </button>
                  {active !== e.name && (
                    <button
                      type="button"
                      onClick={() => setActive(e.name)}
                      className="shrink-0 text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      title="Set active"
                    >
                      set
                    </button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteEnv(e.name)}
                    className="size-6 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    aria-label={`Delete ${e.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <Input
                value={newEnvName}
                onChange={(e) => setNewEnvName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addEnv()
                  }
                }}
                placeholder="New environment"
                className="h-8 flex-1 rounded-lg text-xs shadow-none"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={addEnv}
                disabled={!newEnvName.trim()}
                className="size-8 shrink-0 rounded-lg"
                aria-label="Add environment"
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          {/* Variables for the selected environment */}
          <div className="min-w-0">
            {selEnv ? (
              <VariableRows vars={selEnv.variables} onChange={updateVars} />
            ) : (
              <p className="py-8 text-center text-xs text-muted-foreground">
                Add or select an environment to edit its variables.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={save.isPending}
            className="rounded-full"
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            {save.isPending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- QC scan

const SEVERITY_META: Record<Severity, { label: string; icon: typeof ShieldAlert; tone: string; dot: string }> = {
  high: { label: 'High', icon: ShieldAlert, tone: 'border-red-200 bg-red-50 text-red-700', dot: 'bg-red-500' },
  warn: { label: 'Warning', icon: AlertTriangle, tone: 'border-amber-200 bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  info: { label: 'Info', icon: Info, tone: 'border-border/60 bg-muted/40 text-muted-foreground', dot: 'bg-muted-foreground/50' },
}

function QcScanPanel({ findings }: { findings: ApiFinding[] }) {
  if (findings.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
        <CheckCircle2 className="size-4 shrink-0" />
        QC scan found no issues in the response.
      </div>
    )
  }
  const counts: Record<Severity, number> = {
    high: findings.filter((f) => f.severity === 'high').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {(['high', 'warn', 'info'] as Severity[]).map((s) =>
          counts[s] > 0 ? (
            <Badge key={s} variant="outline" className={cn('gap-1', SEVERITY_META[s].tone)}>
              {counts[s]} {SEVERITY_META[s].label}
              {counts[s] === 1 ? '' : s === 'info' ? '' : 's'}
            </Badge>
          ) : null,
        )}
      </div>
      <ul className="space-y-1.5">
        {findings.map((f) => {
          const meta = SEVERITY_META[f.severity]
          const Icon = meta.icon
          return (
            <li
              key={f.id}
              className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-card p-2.5"
            >
              <Icon
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  f.severity === 'high'
                    ? 'text-red-500'
                    : f.severity === 'warn'
                      ? 'text-amber-500'
                      : 'text-muted-foreground',
                )}
              />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                  {f.title}
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {f.category}
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">{f.detail}</p>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- AI check view

function AiCheckView({ result }: { result: AiCheckResult }) {
  const verdict = result.verdict ?? 'partial'
  const verdictTone =
    verdict === 'pass'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : verdict === 'fail'
        ? 'border-red-200 bg-red-50 text-red-700'
        : 'border-amber-200 bg-amber-50 text-amber-700'
  const VerdictIcon = verdict === 'pass' ? CheckCircle2 : verdict === 'fail' ? XCircle : AlertTriangle
  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn('gap-1 uppercase', verdictTone)}>
          <VerdictIcon className="size-3" />
          {verdict}
        </Badge>
        {result.summary && <span className="text-sm text-foreground">{result.summary}</span>}
      </div>
      {(result.checks?.length ?? 0) > 0 && (
        <ul className="space-y-1.5">
          {result.checks!.map((c, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              {c.pass ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
              )}
              <span className="min-w-0">
                <span className="font-medium">{c.expectation}</span>
                {c.note && <span className="text-muted-foreground"> — {c.note}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {(result.issues?.length ?? 0) > 0 && (
        <div className="space-y-1.5 border-t border-border/60 pt-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldAlert className="size-3.5" />
            Issues AI noticed
          </p>
          {result.issues!.map((iss, i) => {
            const Icon = iss.severity === 'high' ? ShieldAlert : iss.severity === 'warn' ? AlertTriangle : Info
            return (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-border/60 bg-card p-2 text-sm">
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    iss.severity === 'high'
                      ? 'text-red-500'
                      : iss.severity === 'warn'
                        ? 'text-amber-500'
                        : 'text-muted-foreground',
                  )}
                />
                <span className="min-w-0">
                  <span className="font-medium">{iss.title}</span>
                  {iss.detail && <span className="text-muted-foreground"> — {iss.detail}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- run history

function timeAgo(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const sec = Math.round((Date.now() - d.getTime()) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return d.toLocaleString()
}

function HistoryPanel({
  items,
  onLoad,
  onClear,
  clearing,
}: {
  items: ApiResultMeta[]
  onLoad: (id: string) => void
  onClear: () => void
  clearing: boolean
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-none">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HistoryIcon className="size-4 text-muted-foreground" />
          Run history
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {items.length}
          </span>
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={clearing}
          className="gap-1.5 rounded-full text-muted-foreground hover:text-destructive active:scale-[0.98]"
        >
          {clearing ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          Clear
        </Button>
      </div>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onLoad(r.id)}
              className="flex w-full items-center gap-2.5 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/60 hover:bg-muted/40"
            >
              <span
                className={cn(
                  'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                  r.ok ? statusTone(r.status) : 'bg-red-100 text-red-700',
                )}
              >
                {r.ok ? r.status : 'ERR'}
              </span>
              <span className={cn('shrink-0 font-mono text-[10px] font-bold', methodColor(r.method))}>
                {r.method}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={r.url}>
                {r.url}
              </span>
              {r.checks.total > 0 && (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums',
                    r.checks.passed === r.checks.total ? 'text-emerald-600' : 'text-red-600',
                  )}
                >
                  {r.checks.passed === r.checks.total ? (
                    <CheckCircle2 className="size-3" />
                  ) : (
                    <XCircle className="size-3" />
                  )}
                  {r.checks.passed}/{r.checks.total}
                </span>
              )}
              {r.scan.high > 0 && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums text-red-600">
                  <ShieldAlert className="size-3" />
                  {r.scan.high}
                </span>
              )}
              <span className="hidden shrink-0 text-[11px] tabular-nums text-muted-foreground/70 sm:inline">
                {r.timeMs}ms
              </span>
              <span className="shrink-0 text-[11px] text-muted-foreground/70" title={new Date(r.at).toLocaleString()}>
                {timeAgo(r.at)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------- page

/** Lazily read the persisted working draft for a project (no setState-in-effect). */
function loadDraft(projectId: string): { draft: Draft; selected: string | null } {
  try {
    const raw = localStorage.getItem(`qc.apiTest.draft.${projectId}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        draft: { ...emptyDraft(), ...parsed.draft },
        selected: typeof parsed.selected === 'string' ? parsed.selected : null,
      }
    }
  } catch {
    /* corrupt / unavailable — fall through to a fresh draft */
  }
  return { draft: emptyDraft(), selected: null }
}

export default function ApiTestingPage() {
  const { activeProjectId } = useProjects()
  if (!activeProjectId) {
    return (
      <div className="py-16 text-center text-sm text-muted-foreground">
        Select a project to use API testing.
      </div>
    )
  }
  // Remount on project switch so per-project state (draft, name) re-seeds cleanly
  // from localStorage via useState initializers — no restore effect needed.
  return <ApiTesting key={activeProjectId} projectId={activeProjectId} />
}

function ApiTesting({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const draftKey = `qc.apiTest.draft.${projectId}`

  // Lazy initializer runs once on mount — seed from the persisted draft.
  const [draft, setDraft] = useState<Draft>(() => loadDraft(projectId).draft)
  const [selected, setSelected] = useState<string | null>(() => loadDraft(projectId).selected)
  const [res, setRes] = useState<ApiSendResult | null>(null)
  const [aiResult, setAiResult] = useState<AiCheckResult | null>(null)
  const [curlOpen, setCurlOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [manageEnvOpen, setManageEnvOpen] = useState(false)
  // Inline rename of a saved request: the name being renamed + the edited value.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // The saved request pending delete-confirmation (null = no dialog open).
  const [deleting, setDeleting] = useState<string | null>(null)
  // Filter text for the saved-requests sidebar (shown once the collection grows).
  const [filter, setFilter] = useState('')

  // Persist the working draft + which request is open (writing to localStorage is
  // an external-system sync, not a setState, so this effect is fine).
  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify({ draft, selected }))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [draft, selected, draftKey])

  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }))

  const { data: saved } = useQuery({
    queryKey: ['api-requests', projectId],
    queryFn: () => listApiRequests(projectId),
    enabled: !!projectId,
  })

  // Named {{variable}} environments (values substituted server-side at send time).
  const { data: environments } = useQuery({
    queryKey: ['api-environments', projectId],
    queryFn: () => getApiEnvironments(projectId),
    enabled: !!projectId,
  })
  const activeEnv = environments?.active ?? null

  // Switch the active environment (send the current masked set back — the server
  // preserves secret values that arrive blank).
  const setActiveEnv = useMutation({
    mutationFn: (name: string | null) =>
      saveApiEnvironments(projectId, {
        active: name,
        environments: environments?.environments ?? [],
      }),
    onSuccess: (data) => queryClient.setQueryData(['api-environments', projectId], data),
    onError: (e) =>
      toast.error('Could not switch environment', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  // Auto-save: whenever the open (selected) request changes, persist the edits to
  // its file. Debounced so typing a URL/body doesn't hammer the server. New (unsaved)
  // requests aren't auto-created here — they're saved on the first Send.
  useEffect(() => {
    if (!selected) return
    // Skip the write when the draft already matches the saved file — otherwise every
    // load/select would rewrite the request byte-identically and churn its mtime.
    if (sameAsSaved((saved ?? []).find((s) => s.name === selected), draft)) return
    const t = setTimeout(() => {
      saveApiRequest(projectId, selected, draft)
        .then(() => queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] }))
        .catch(() => {
          /* a transient save failure is non-fatal — the draft is still in localStorage */
        })
    }, 700)
    return () => clearTimeout(t)
  }, [draft, selected, projectId, queryClient, saved])

  // AI check — judge a response against the plain-language expectation. Takes the
  // response as an argument (not from state) so it can run straight from send's
  // onSuccess, before setRes has committed.
  const aiCheck = useMutation({
    mutationFn: ({ response, expect }: { response: ApiSendResult; expect: string }) =>
      aiCheckApi({
        projectId,
        expect,
        request: { method: response.method, url: response.requestUrl },
        result: {
          status: response.status,
          statusText: response.statusText,
          contentType: response.contentType,
          timeMs: response.timeMs,
          headers: response.headers,
          bodyText: response.bodyText,
        },
      }),
    onSuccess: (r) => {
      setAiResult(r)
      if (!r.ok) toast.error('AI check failed', { description: r.error ?? 'No result.' })
    },
    onError: (e) =>
      toast.error('AI check failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const runAiCheck = (response: ApiSendResult, expect: string) => {
    if (!response.ok || !expect.trim()) return
    aiCheck.mutate({ response, expect: expect.trim() })
  }

  // Response → environment variable capture (request chaining). Evaluates each rule's
  // JSON-path against the response body and upserts the value into the active env.
  const runCaptures = (r: ApiSendResult, captures: ApiCapture[]) => {
    const usable = captures.filter((c) => c.jsonPath.trim() && c.varName.trim())
    if (!r.ok || !usable.length) return
    let parsed: unknown
    try {
      parsed = JSON.parse(r.bodyText ?? '')
    } catch {
      toast.error('Capture skipped', { description: 'The response body is not valid JSON.' })
      return
    }
    const done: string[] = []
    const tasks: Promise<unknown>[] = []
    for (const c of usable) {
      const val = getJsonPath(parsed, c.jsonPath.trim())
      if (val === undefined) continue
      const value = typeof val === 'string' ? val : JSON.stringify(val)
      done.push(c.varName.trim())
      tasks.push(
        captureApiVariable(projectId, {
          env: activeEnv ?? undefined,
          key: c.varName.trim(),
          value,
          secret: c.secret,
        }),
      )
    }
    if (!tasks.length) {
      toast.error('Nothing captured', { description: 'No configured path matched the response.' })
      return
    }
    Promise.all(tasks)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ['api-environments', projectId] })
        toast.success(`Captured ${done.join(', ')}`)
      })
      .catch(() => toast.error('Could not store captured variable(s)'))
  }

  const send = useMutation({
    mutationFn: (vars: { name: string; req: Draft }) =>
      sendApiRequest({
        projectId,
        method: vars.req.method,
        url: vars.req.url,
        query: vars.req.query,
        headers: vars.req.headers,
        bodyMode: vars.req.bodyMode,
        body: vars.req.body,
      }),
    onSuccess: (r, vars) => {
      setRes(r)
      // As soon as the response lands, auto-run the AI check against the request's
      // expectation (if any) — the AI runs after Send, never before it.
      runAiCheck(r, vars.req.aiExpect)
      // Then apply any response captures into the active environment.
      runCaptures(r, vars.req.captures)
      // Store the outcome as evidence under the request's history, with the
      // client-computed assertion + QC-scan summaries.
      if (!vars.name) return
      const checks = r.ok ? evaluateAssertions(vars.req.assertions, r) : []
      const scan = r.ok ? scanResponse(r, { url: r.requestUrl, method: r.method }) : []
      void saveApiResult(projectId, vars.name, {
        request: { method: vars.req.method, url: composedUrl(vars.req) },
        result: r,
        checks: { passed: checks.filter((c) => c.pass).length, total: checks.length },
        scan: {
          high: scan.filter((f) => f.severity === 'high').length,
          warn: scan.filter((f) => f.severity === 'warn').length,
          info: scan.filter((f) => f.severity === 'info').length,
        },
      })
        .then(() =>
          queryClient.invalidateQueries({ queryKey: ['api-results', projectId, vars.name] }),
        )
        .catch(() => {
          /* storing evidence is best-effort — never block the response */
        })
    },
    onError: (e) =>
      toast.error('Could not send request', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const delMut = useMutation({
    mutationFn: (n: string) => deleteApiRequest(projectId, n),
    onSuccess: (_r, n) => {
      queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      if (selected === n) setSelected(null)
      setDeleting(null)
      toast.success(`Deleted "${n}"`)
    },
    onError: (e) =>
      toast.error('Could not delete', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const renameMut = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      renameApiRequest(projectId, from, to),
    onSuccess: (d, { from }) => {
      queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      queryClient.invalidateQueries({ queryKey: ['api-results', projectId, from] })
      queryClient.invalidateQueries({ queryKey: ['api-results', projectId, d.name] })
      if (selected === from) setSelected(d.name)
      setRenaming(null)
    },
    onError: (e) =>
      toast.error('Could not rename', {
        description: e instanceof Error ? e.message : 'Invalid or duplicate name.',
      }),
  })

  const commitRename = (from: string) => {
    const to = renameValue.trim()
    if (!to || to === from) {
      setRenaming(null)
      return
    }
    renameMut.mutate({ from, to })
  }

  /**
   * Send the request, and auto-save it to the collection first — but only when it's
   * a NEW request (a different method+URL than anything already saved), so repeat
   * sends of the same call never pile up duplicates.
   */
  const handleSend = () => {
    if (!draft.url) return
    setAiResult(null)
    const key = requestKey(draft)
    const dup = (saved ?? []).find((s) => requestKey(s) === key)
    let savedName: string
    if (dup) {
      // Same request already saved — keep it selected, don't duplicate.
      savedName = dup.name
      setSelected(dup.name)
    } else {
      const taken = new Set((saved ?? []).map((s) => s.name))
      const base = deriveName(draft)
      let unique = base
      let n = 2
      while (taken.has(unique)) unique = `${base} (${n++})`.slice(0, 60)
      savedName = unique
      // Fire-and-forget: saving must never delay the actual send. Selecting it also
      // switches on the auto-save effect for subsequent edits.
      saveApiRequest(projectId, unique, draft)
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
          setSelected(unique)
        })
        .catch(() => {
          /* a bad name/oversize is non-fatal — the request still sends */
        })
    }
    // Snapshot the draft so the stored result reflects exactly what was sent.
    send.mutate({ name: savedName, req: { ...draft } })
  }

  // Send from anywhere with ⌘/Ctrl+Enter — the guard inside handleSend covers an
  // empty URL. A ref keeps the listener stable while always calling the latest closure.
  const handleSendRef = useRef(handleSend)
  useEffect(() => {
    handleSendRef.current = handleSend
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        handleSendRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const loadItem = (item: ApiRequestDef) => {
    setDraft({
      method: item.method,
      url: item.url,
      query: item.query ?? [],
      headers: item.headers ?? [],
      bodyMode: item.bodyMode ?? 'none',
      body: item.body ?? '',
      assertions:
        item.assertions?.length > 0
          ? item.assertions
          : [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
      aiExpect: item.aiExpect ?? '',
      captures: item.captures ?? [],
    })
    setSelected(item.name)
    setRes(null)
    setAiResult(null)
  }

  const results = useMemo(
    () => (res && res.ok ? evaluateAssertions(draft.assertions, res) : null),
    [res, draft.assertions],
  )
  const passCount = results?.filter((r) => r.pass).length ?? 0
  const totalChecks = results?.length ?? 0

  const findings = useMemo(
    () => (res && res.ok ? scanResponse(res, { url: res.requestUrl, method: res.method }) : null),
    [res],
  )
  const highCount = findings?.filter((f) => f.severity === 'high').length ?? 0

  const copyCurl = async () => {
    try {
      await navigator.clipboard.writeText(
        toCurl({
          method: draft.method,
          url: draft.url,
          query: draft.query,
          headers: draft.headers,
          bodyMode: draft.bodyMode,
          body: draft.body,
        }),
      )
      toast.success('Copied as cURL')
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  // Stored run history for the currently-selected saved request (evidence trail).
  const { data: history } = useQuery({
    queryKey: ['api-results', projectId, selected],
    queryFn: () => listApiResults(projectId, selected as string),
    enabled: !!projectId && !!selected,
  })

  const loadResult = async (id: string) => {
    if (!selected) return
    try {
      const rec = await getApiResult(projectId, selected, id)
      setRes(rec.result)
      // The stored AI verdict isn't part of the record, so clear any lingering one —
      // a stale "AI: pass" badge next to an older response is misleading.
      setAiResult(null)
    } catch (e) {
      toast.error('Could not load result', {
        description: e instanceof Error ? e.message : 'Unknown error',
      })
    }
  }

  const clearHistory = useMutation({
    mutationFn: () => clearApiResults(projectId, selected as string),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['api-results', projectId, selected] })
      toast.success('Cleared run history')
    },
    onError: (e) =>
      toast.error('Could not clear history', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const bodyDisabled = draft.method === 'GET' || draft.method === 'HEAD'

  // Request state, surfaced as a one-line status under the URL bar so the auto-save
  // model is never a mystery: a brand-new request, edited-but-saving, or clean.
  const savedItem = (saved ?? []).find((s) => s.name === selected)
  const isDirty = !!selected && !sameAsSaved(savedItem, draft)
  const isNewUnsaved = !selected && !!draft.url
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const sendHint = isMac ? '⌘↵' : 'Ctrl+↵'

  // Saved-requests sidebar filter — matches name, method or URL.
  const filteredSaved = useMemo(() => {
    const all = saved ?? []
    const q = filter.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.method.toLowerCase().includes(q) ||
        s.url.toLowerCase().includes(q),
    )
  }, [saved, filter])

  // Toggle a preset criterion line in/out of the AI expectation text.
  const hasCriterion = (text: string) =>
    draft.aiExpect.split('\n').some((l) => l.trim() === `- ${text}`)
  const toggleCriterion = (text: string) => {
    const line = `- ${text}`
    if (hasCriterion(text)) {
      patch({
        aiExpect: draft.aiExpect
          .split('\n')
          .filter((l) => l.trim() !== line)
          .join('\n')
          .trim(),
      })
    } else {
      const base = draft.aiExpect.trim()
      patch({ aiExpect: base ? `${base}\n${line}` : line })
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Zap className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">API Testing</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Send HTTP requests to your app's API, assert on the response, and save reusable
              requests per project. Requests are proxied through the portal server, so CORS and
              localhost/staging URLs just work.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => setScanOpen(true)}
            className="gap-1.5 rounded-full active:scale-[0.98]"
            title="Open a page in Chrome and auto-detect the APIs it calls"
          >
            <Radar className="size-3.5" />
            Scan page for APIs
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCurlOpen(true)}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            <TerminalSquare className="size-3.5" />
            Import cURL
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={copyCurl}
            disabled={!draft.url}
            className="gap-1.5 rounded-full active:scale-[0.98]"
            title="Copy this request as a curl command"
          >
            <Clipboard className="size-3.5" />
            Copy as cURL
          </Button>
          <OpenFolderButton open={() => openApiTestsFolder(projectId)} label="API tests" />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[240px_1fr]">
        {/* Saved collection */}
        <aside className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Saved requests
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setDraft(emptyDraft())
                setSelected(null)
                setRes(null)
                setAiResult(null)
              }}
              className="size-7 rounded-lg text-muted-foreground hover:text-foreground"
              title="New request"
            >
              <Plus className="size-4" />
            </Button>
          </div>
          {(saved ?? []).length > 4 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter requests…"
                className="h-8 rounded-lg pl-8 text-xs shadow-none"
              />
            </div>
          )}
          <div className="space-y-1">
            {(saved ?? []).length === 0 && (
              <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                No saved requests yet.
              </p>
            )}
            {(saved ?? []).length > 0 && filteredSaved.length === 0 && (
              <p className="rounded-xl border border-dashed border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
                No requests match “{filter.trim()}”.
              </p>
            )}
            {filteredSaved.map((item) => {
              const isRenaming = renaming === item.name
              return (
                <div
                  key={item.name}
                  role={isRenaming ? undefined : 'button'}
                  tabIndex={isRenaming ? undefined : 0}
                  onClick={isRenaming ? undefined : () => loadItem(item)}
                  onKeyDown={
                    isRenaming
                      ? undefined
                      : (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            loadItem(item)
                          }
                        }
                  }
                  className={cn(
                    'group flex items-center gap-2 rounded-xl border px-2.5 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    !isRenaming && 'cursor-pointer',
                    selected === item.name
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:border-border/60 hover:bg-muted/40',
                  )}
                >
                  {isRenaming ? (
                    <>
                      <Input
                        autoFocus
                        value={renameValue}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(item.name)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        className="h-7 flex-1 rounded-md px-2 text-xs shadow-none"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          commitRename(item.name)
                        }}
                        disabled={renameMut.isPending}
                        className="size-6 shrink-0 rounded-md text-emerald-600 hover:text-emerald-700"
                        aria-label="Confirm rename"
                      >
                        {renameMut.isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenaming(null)
                        }}
                        className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                        aria-label="Cancel rename"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className={cn('shrink-0 font-mono text-[10px] font-bold', methodColor(item.method))}>
                          {item.method}
                        </span>
                        <span className="min-w-0 truncate text-xs font-medium" title={item.name}>
                          {item.name}
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          setRenaming(item.name)
                          setRenameValue(item.name)
                        }}
                        className="size-6 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                        aria-label={`Rename ${item.name}`}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDeleting(item.name)
                        }}
                        className="size-6 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        </aside>

        {/* Request builder + response */}
        <div className="min-w-0 space-y-4">
          {/* Environment bar — the active {{variable}} set for this request. */}
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/30 px-3 py-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Boxes className="size-3.5" />
              Environment
            </span>
            {(environments?.environments.length ?? 0) > 0 ? (
              <Select
                value={activeEnv ?? '__none__'}
                onValueChange={(v) => setActiveEnv.mutate(v === '__none__' ? null : v)}
              >
                <SelectTrigger className="h-8 w-[180px] rounded-lg text-xs shadow-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__" className="text-xs">
                    No environment
                  </SelectItem>
                  {environments!.environments.map((e) => (
                    <SelectItem key={e.name} value={e.name} className="text-xs">
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="text-xs text-muted-foreground">None yet</span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setManageEnvOpen(true)}
              className="h-8 gap-1.5 rounded-full active:scale-[0.98]"
            >
              <Pencil className="size-3.5" />
              Manage
            </Button>
            <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground sm:inline-flex">
              Use <span className="font-mono">{'{{var}}'}</span> in the URL, params, headers or body.
            </span>
          </div>

          {/* URL bar */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex flex-1 items-center gap-2 rounded-xl border border-border/60 bg-card p-1.5 shadow-none">
              <Select value={draft.method} onValueChange={(v) => patch({ method: v })}>
                <SelectTrigger
                  className={cn(
                    'h-9 w-[110px] shrink-0 rounded-lg border-0 bg-muted/60 font-mono text-xs font-bold shadow-none',
                    methodColor(draft.method),
                  )}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {METHODS.map((m) => (
                    <SelectItem key={m} value={m} className={cn('font-mono text-xs font-bold', methodColor(m))}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={draft.url}
                onChange={(e) => patch({ url: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && draft.url) handleSend()
                }}
                placeholder="https://api.example.com/v1/resource"
                className="h-9 flex-1 rounded-lg border-0 font-mono text-xs shadow-none focus-visible:ring-0"
              />
            </div>
            <Button
              onClick={handleSend}
              disabled={!draft.url || send.isPending}
              title={`Send (${sendHint})`}
              className="h-11 shrink-0 gap-2 rounded-full px-6 active:scale-[0.98] sm:h-12"
            >
              {send.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send
              <kbd className="hidden rounded bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary-foreground/80 sm:inline">
                {sendHint}
              </kbd>
            </Button>
          </div>

          {/* Request state — makes the auto-save model obvious at a glance. */}
          {isNewUnsaved ? (
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              <Info className="size-3 text-sky-500" />
              New request — <span className="font-medium text-foreground">Send</span> to save it to
              your collection.
            </p>
          ) : selected ? (
            <p className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
              {isDirty ? (
                <>
                  <Loader2 className="size-3 animate-spin text-amber-500" />
                  Saving changes to{' '}
                  <span className="font-medium text-foreground">{selected}</span>…
                </>
              ) : (
                <>
                  <Check className="size-3 text-emerald-500" />
                  <span className="font-medium text-foreground">{selected}</span> is saved — edits
                  persist automatically.
                </>
              )}
            </p>
          ) : null}

          {/* Request config tabs */}
          <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-none">
            <Tabs defaultValue="params">
              <TabsList className="rounded-full">
                <TabsTrigger value="params" className="rounded-full text-xs">
                  Params
                  {draft.query.filter((q) => q.enabled && q.key).length > 0 &&
                    ` (${draft.query.filter((q) => q.enabled && q.key).length})`}
                </TabsTrigger>
                <TabsTrigger value="headers" className="rounded-full text-xs">
                  Headers
                  {draft.headers.filter((h) => h.enabled && h.key).length > 0 &&
                    ` (${draft.headers.filter((h) => h.enabled && h.key).length})`}
                </TabsTrigger>
                <TabsTrigger value="body" className="rounded-full text-xs" disabled={bodyDisabled}>
                  Body
                </TabsTrigger>
                <TabsTrigger value="assert" className="rounded-full text-xs">
                  Assertions
                  {draft.assertions.filter((a) => a.enabled).length > 0 &&
                    ` (${draft.assertions.filter((a) => a.enabled).length})`}
                </TabsTrigger>
                <TabsTrigger value="capture" className="gap-1 rounded-full text-xs">
                  <Variable className="size-3" />
                  Capture
                  {draft.captures.length > 0 && ` (${draft.captures.length})`}
                </TabsTrigger>
                <TabsTrigger value="ai" className="gap-1 rounded-full text-xs">
                  <Sparkles className="size-3" />
                  AI check
                  {draft.aiExpect.trim() && ' •'}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="params" className="pt-4">
                <KVEditor
                  rows={draft.query}
                  onChange={(query) => patch({ query })}
                  keyPlaceholder="param"
                  valuePlaceholder="value"
                />
              </TabsContent>
              <TabsContent value="headers" className="pt-4">
                <KVEditor
                  rows={draft.headers}
                  onChange={(headers) => patch({ headers })}
                  keyPlaceholder="Header-Name"
                  valuePlaceholder="value"
                />
              </TabsContent>
              <TabsContent value="body" className="space-y-3 pt-4">
                <div className="flex items-center gap-2">
                  {(['none', 'json', 'text'] as ApiBodyMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => patch({ bodyMode: m })}
                      className={cn(
                        'rounded-full px-3 py-1 text-xs font-medium transition-colors',
                        draft.bodyMode === m
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {m === 'none' ? 'None' : m === 'json' ? 'JSON' : 'Text'}
                    </button>
                  ))}
                  {draft.bodyMode === 'json' && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                      <FileJson className="size-3" />
                      Content-Type set automatically
                    </span>
                  )}
                </div>
                {draft.bodyMode !== 'none' && (
                  <Textarea
                    value={draft.body}
                    onChange={(e) => patch({ body: e.target.value })}
                    placeholder={draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Raw request body'}
                    className="min-h-[180px] rounded-xl font-mono text-xs shadow-none"
                    spellCheck={false}
                  />
                )}
              </TabsContent>
              <TabsContent value="assert" className="pt-4">
                <AssertionEditor
                  rows={draft.assertions}
                  onChange={(assertions) => patch({ assertions })}
                  results={results}
                />
              </TabsContent>
              <TabsContent value="capture" className="pt-4">
                <CaptureEditor
                  rows={draft.captures}
                  onChange={(captures) => patch({ captures })}
                  activeEnv={activeEnv}
                />
              </TabsContent>
              <TabsContent value="ai" className="space-y-3 pt-4">
                <p className="text-xs text-muted-foreground">
                  Describe in plain language what a correct response looks like — or quick-pick common
                  criteria below. After you Send, AI reads the actual response and judges it against
                  this, great for checks that are awkward to express as exact-match rules.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {AI_CRITERIA.map((c) => {
                    const active = hasCriterion(c.text)
                    return (
                      <button
                        key={c.label}
                        type="button"
                        onClick={() => toggleCriterion(c.text)}
                        title={c.text}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors active:scale-[0.98]',
                          active
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border/60 bg-muted/40 text-muted-foreground hover:border-border hover:text-foreground',
                        )}
                      >
                        {active ? <Check className="size-3" /> : <Plus className="size-3" />}
                        {c.label}
                      </button>
                    )
                  })}
                </div>
                <Textarea
                  value={draft.aiExpect}
                  onChange={(e) => patch({ aiExpect: e.target.value })}
                  placeholder={
                    'e.g. Returns 200 with a JSON list of users. Each has id, name and email but NO password or token. The list is sorted by name.'
                  }
                  className="min-h-[120px] rounded-xl text-xs shadow-none"
                  spellCheck={false}
                />
                <div className="flex items-center gap-2">
                  <Button
                    onClick={() => res && runAiCheck(res, draft.aiExpect)}
                    disabled={!res || !res.ok || !draft.aiExpect.trim() || aiCheck.isPending}
                    className="gap-1.5 rounded-full active:scale-[0.98]"
                  >
                    {aiCheck.isPending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Wand2 className="size-4" />
                    )}
                    {aiResult ? 'Re-run AI check' : 'Run AI check'}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    {!res
                      ? 'Send a request first.'
                      : 'Runs automatically after each Send when an expectation is set.'}
                  </span>
                </div>
                {aiResult && aiResult.ok && <AiCheckView result={aiResult} />}
              </TabsContent>
            </Tabs>
          </div>

          {/* Response */}
          <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-none">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <ChevronRight className="size-4 text-muted-foreground" />
                Response
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {aiCheck.isPending && (
                  <Badge variant="outline" className="gap-1 border-border/60 bg-muted/40 text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    AI checking…
                  </Badge>
                )}
                {!aiCheck.isPending && aiResult?.ok && aiResult.verdict && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'gap-1 uppercase',
                      aiResult.verdict === 'pass'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : aiResult.verdict === 'fail'
                          ? 'border-red-200 bg-red-50 text-red-700'
                          : 'border-amber-200 bg-amber-50 text-amber-700',
                    )}
                    title="AI check verdict — see the AI check tab"
                  >
                    <Sparkles className="size-3" />
                    AI: {aiResult.verdict}
                  </Badge>
                )}
                {findings && highCount > 0 && (
                  <Badge variant="outline" className="gap-1 border-red-200 bg-red-50 text-red-700">
                    <ShieldAlert className="size-3" />
                    {highCount} high issue{highCount === 1 ? '' : 's'}
                  </Badge>
                )}
                {results && totalChecks > 0 && (
                  <Badge
                    variant="outline"
                    className={cn(
                      'gap-1',
                      passCount === totalChecks
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-red-200 bg-red-50 text-red-700',
                    )}
                  >
                    {passCount === totalChecks ? (
                      <CheckCircle2 className="size-3" />
                    ) : (
                      <XCircle className="size-3" />
                    )}
                    {passCount}/{totalChecks} checks passed
                  </Badge>
                )}
              </div>
            </div>
            {send.isPending ? (
              <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Sending…
              </div>
            ) : res ? (
              <div className="space-y-4">
                <ResponseView res={res} />
                {findings && (
                  <div className="space-y-2 border-t border-border/60 pt-4">
                    <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      <ShieldAlert className="size-3.5" />
                      QC scan — issues &amp; vulnerabilities
                    </h3>
                    <QcScanPanel findings={findings} />
                  </div>
                )}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                Send a request to see the response, assertion results, and the QC scan here.
              </p>
            )}
          </div>

          {/* Stored run history for the selected request — evidence across sends. */}
          {selected && (history?.length ?? 0) > 0 && (
            <HistoryPanel
              items={history ?? []}
              onLoad={loadResult}
              onClear={() => clearHistory.mutate()}
              clearing={clearHistory.isPending}
            />
          )}
        </div>
      </div>

      <CurlImportDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={(d) => {
          setDraft(d)
          setSelected(null)
          setRes(null)
          setAiResult(null)
        }}
      />

      <ScanPageDialog
        projectId={projectId}
        open={scanOpen}
        onOpenChange={setScanOpen}
        existingNames={(saved ?? []).map((s) => s.name)}
        onImported={() => queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })}
      />

      {manageEnvOpen && (
        <ManageEnvironmentsDialog
          projectId={projectId}
          initial={environments}
          onClose={() => setManageEnvOpen(false)}
        />
      )}

      <Dialog
        open={!!deleting}
        onOpenChange={(v) => {
          if (!v && !delMut.isPending) setDeleting(null)
        }}
      >
        <DialogContent className="rounded-3xl sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 className="size-4 text-destructive" />
              Delete saved request
            </DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium text-foreground">{deleting}</span>? This also
              removes its stored run history. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleting(null)}
              disabled={delMut.isPending}
              className="rounded-full"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleting && delMut.mutate(deleting)}
              disabled={delMut.isPending}
              className="gap-1.5 rounded-full active:scale-[0.98]"
            >
              {delMut.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
