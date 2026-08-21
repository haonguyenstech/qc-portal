import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  AlertTriangle,
  Bug,
  Boxes,
  CheckCircle2,
  ChevronRight,
  Clipboard,
  Clock3,
  FileJson,
  FolderTree,
  History as HistoryIcon,
  Check,
  Info,
  KeyRound,
  Loader2,
  CircleStop,
  Pencil,
  Plus,
  Radar,
  Route,
  Search,
  Send,
  ListChecks,
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
  type LucideIcon,
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
import { Checkbox } from '@/components/ui/checkbox'
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
import { toCurl } from '@/lib/curl'
import { CurlImportDialog } from '@/components/CurlImportDialog'
import { deriveName, emptyDraft, uniqueName, type ApiDraft } from '@/lib/apiDraft'
import { scanResponse, type ApiFinding, type Severity } from '@/lib/apiChecks'
import { evaluateAssertions, getJsonPath, type AssertionResult } from '@/lib/apiAssert'
import { ApiFlowsWorkspace } from '@/components/ApiFlowPanel'
import {
  aiCheckApi,
  captureApiVariable,
  clearApiResults,
  deleteApiRequest,
  getApiEnvironments,
  getApiResult,
  getApiScan,
  getScanAvailable,
  listApiFlows,
  listApiRequests,
  listApiResults,
  openApiTestsFolder,
  renameApiGroup,
  renameApiRequest,
  setApiRequestGroup,
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

// `Draft` / `emptyDraft` / `deriveName` / `uniqueName` live in `lib/apiDraft.ts` — the
// Flows tab creates saved requests too (Add request → Import cURL), and the naming rules
// have to be the same code on both sides, not a copy.
type Draft = ApiDraft

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

/**
 * "New request" creates the record immediately, so it needs a name before it has a URL
 * to derive one from. Those placeholder names are recognisable, and the first Send
 * upgrades them to the derived `METHOD /path` name — see `handleSend`.
 */
const PLACEHOLDER_NAME = 'New request'
const isPlaceholderName = (name: string) =>
  name === PLACEHOLDER_NAME || new RegExp(`^${PLACEHOLDER_NAME} \\d+$`).test(name)

// ---------------------------------------------------------------- modules (groups)

/** Bucket key for requests with no module — never a real module name (those are trimmed). */
const UNGROUPED = ''

/**
 * Guess a module from a URL the Swagger way: the first meaningful path segment
 * after any `/api`/version prefix (`/api/v1/orders/12` → `orders`). Returns '' when
 * there's nothing usable, which leaves the request ungrouped.
 */
function moduleFromUrl(url: string): string {
  let pathname = url
  try {
    pathname = new URL(url).pathname
  } catch {
    pathname = url.replace(/^[a-z]+:\/\/[^/]*/i, '').split('?')[0]
  }
  const segments = pathname
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^(api|rest|v\d+)$/i.test(s))
  const first = segments[0] ?? ''
  // A leading id/uuid/placeholder isn't a module name.
  if (!first || /^[\d.]+$/.test(first) || /^[{:]/.test(first) || first.length > 60) return ''
  return first
}

/** Module label for display — real name, or the ungrouped bucket's heading. */
function moduleLabel(group: string): string {
  return group || 'Ungrouped'
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
          <Checkbox
            checked={r.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
            aria-label="Enabled"
          />
          <Input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="h-9 flex-1 font-mono text-xs shadow-none"
          />
          <Input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="h-9 flex-[2] font-mono text-xs shadow-none"
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

/**
 * One labeled cell of a check's result (key / actual / expected). `break-all` +
 * line-clamp keeps a long JSON value from stretching the row, and the full text stays
 * reachable via the row's title.
 */
function ResultCell({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'pass' | 'fail'
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5">
      <span className="block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'block line-clamp-2 break-all font-mono text-[11px]',
          tone === 'fail' ? 'text-red-600' : tone === 'pass' ? 'text-emerald-700' : 'text-foreground',
        )}
      >
        {value}
      </span>
    </div>
  )
}

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
                  <Checkbox
                    checked={a.enabled}
                    onChange={(e) => update(i, { enabled: e.target.checked })}
                    aria-label={a.enabled ? 'Enabled — click to skip' : 'Disabled — click to enable'}
                    title={a.enabled ? 'Enabled' : 'Disabled (skipped)'}
                  />
                  <Select
                    value={a.type}
                    onValueChange={(v) => update(i, { type: v as ApiAssertionType })}
                  >
                    <SelectTrigger className="h-9 w-[180px] shrink-0 text-xs shadow-none">
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
                      className="h-9 min-w-0 flex-1 font-mono text-xs shadow-none"
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
                      className="h-9 min-w-0 flex-1 font-mono text-xs shadow-none"
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
                {/* Key · actual · expected — the three things needed to see WHY it
                    passed or failed, side by side instead of one run-on sentence. */}
                {r && (
                  <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-3" title={r.detail}>
                    <ResultCell label="Key" value={r.key} />
                    <ResultCell
                      label="Actual value"
                      value={r.actual}
                      tone={r.pass ? 'pass' : 'fail'}
                    />
                    <ResultCell label="Expected value" value={r.expected || '—'} />
                  </div>
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
                className="h-9 min-w-0 flex-1 font-mono text-xs shadow-none"
              />
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <Input
                value={c.varName}
                onChange={(e) => update(i, { varName: e.target.value })}
                placeholder="token"
                className="h-9 min-w-0 flex-1 font-mono text-xs shadow-none"
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
  // File each imported endpoint under the module its URL path implies (Swagger-style).
  const [groupByPath, setGroupByPath] = useState(true)

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
        await saveApiRequest(projectId, name, {
          ...draft,
          group: groupByPath ? moduleFromUrl(draft.url) : '',
        })
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
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-5xl">
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
                className="h-10 flex-1 font-mono text-xs shadow-none"
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
                <Checkbox
                  size="sm"
                  checked={headed}
                  onChange={(e) => setHeaded(e.target.checked)}
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
                      <Checkbox size="sm" checked={allSelected} readOnly />
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
                          <Checkbox
                            checked={checked}
                            onChange={() => toggle(r.id)}
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

        <DialogFooter className="sm:items-center sm:justify-between">
          {/* A scan usually spans several features — file them like Swagger does. */}
          <label className="flex items-center gap-2 text-xs text-muted-foreground sm:mr-auto">
            <Checkbox
              size="sm"
              checked={groupByPath}
              onChange={(e) => setGroupByPath(e.target.checked)}
            />
            Group into modules by URL path
          </label>
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
            className="h-9 w-[34%] shrink-0 font-mono text-xs shadow-none"
          />
          <Input
            value={v.value}
            onChange={(e) => update(i, { value: e.target.value })}
            type={v.secret ? 'password' : 'text'}
            placeholder={v.secret && v.hasValue && !v.value ? '•••• stored (blank = keep)' : 'value'}
            className="h-9 flex-1 font-mono text-xs shadow-none"
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
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-3xl sm:max-w-4xl">
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
                className="h-8 flex-1 text-xs shadow-none"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={addEnv}
                disabled={!newEnvName.trim()}
                className="size-8 shrink-0 rounded-full"
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

/**
 * Stored runs for the selected request. It lives inside the result panel's Runs tab,
 * so it draws no card of its own (a card inside a card reads as a rendering mistake)
 * and no "Run history" heading — the tab already says that. Two lines per run: the
 * verdict on top, the URL under it, because the column is narrow and a one-line row
 * truncated the URL to "http://loc…".
 */
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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          Click a run to load its response back into the panel.
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClear}
          disabled={clearing}
          className="h-7 shrink-0 gap-1.5 rounded-full text-[11px] text-muted-foreground hover:text-destructive active:scale-[0.98]"
        >
          {clearing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Trash2 className="size-3.5" />
          )}
          Clear
        </Button>
      </div>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              onClick={() => onLoad(r.id)}
              className="flex w-full flex-col gap-0.5 rounded-xl border border-transparent px-2.5 py-2 text-left transition-colors hover:border-border/60 hover:bg-muted/40"
            >
              <span className="flex w-full min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                    r.ok ? statusTone(r.status) : 'bg-red-100 text-red-700',
                  )}
                >
                  {r.ok ? r.status : 'ERR'}
                </span>
                <span
                  className={cn('shrink-0 font-mono text-[10px] font-bold', methodColor(r.method))}
                >
                  {r.method}
                </span>
                {r.checks.total > 0 && (
                  <span
                    className={cn(
                      'inline-flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums',
                      r.checks.passed === r.checks.total ? 'text-emerald-600' : 'text-red-600',
                    )}
                    title="Assertions passed"
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
                  <span
                    className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums text-red-600"
                    title="High-severity QC scan findings"
                  >
                    <ShieldAlert className="size-3" />
                    {r.scan.high}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                  {r.timeMs}ms
                </span>
                <span
                  className="shrink-0 text-[11px] text-muted-foreground/70"
                  title={new Date(r.at).toLocaleString()}
                >
                  {timeAgo(r.at)}
                </span>
              </span>
              <span
                className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80"
                title={r.url}
              >
                {r.url}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Move one saved request into a module: pick an existing one, start a new one, or
 * clear it. Mounted only while a request is picked, so its state seeds fresh from
 * that request (no setState-in-effect).
 */
function MoveToModuleDialog({
  request,
  modules,
  pending,
  onCancel,
  onMove,
}: {
  request: ApiRequestDef
  modules: string[]
  pending: boolean
  onCancel: () => void
  onMove: (group: string) => void
}) {
  const NONE = '__none__'
  const NEW = '__new__'
  const [choice, setChoice] = useState<string>(request.group || NONE)
  // Seed a new module with the Swagger-style guess from the URL — usually right.
  const [fresh, setFresh] = useState(() => moduleFromUrl(request.url))
  const group = choice === NONE ? '' : choice === NEW ? fresh.trim() : choice
  const canSave = choice !== NEW || !!fresh.trim()

  return (
    <Dialog open onOpenChange={(v) => !v && onCancel()}>
      <DialogContent className="rounded-3xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="size-4 text-primary" />
            Move to module
          </DialogTitle>
          <DialogDescription>
            Group <span className="font-medium text-foreground">{request.name}</span> with the rest
            of its module, the way Swagger groups endpoints by tag.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger className="h-9 text-sm shadow-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE} className="text-sm">
                Ungrouped
              </SelectItem>
              {modules.map((m) => (
                <SelectItem key={m} value={m} className="text-sm">
                  {m}
                </SelectItem>
              ))}
              <SelectItem value={NEW} className="text-sm">
                New module…
              </SelectItem>
            </SelectContent>
          </Select>
          {choice === NEW && (
            <Input
              autoFocus
              value={fresh}
              onChange={(e) => setFresh(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) onMove(group)
              }}
              placeholder="Module name (e.g. Orders)"
              maxLength={60}
              className="h-9 text-sm shadow-none"
            />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} className="rounded-full active:scale-[0.98]">
            Cancel
          </Button>
          <Button
            onClick={() => onMove(group)}
            disabled={!canSave || pending}
            className="gap-1.5 rounded-full active:scale-[0.98]"
          >
            {pending && <Loader2 className="size-3.5 animate-spin" />}
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/** Lazily read which modules the user has folded shut in the saved list. */
function loadCollapsedModules(projectId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`qc.apiTest.modules.${projectId}`)
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) return new Set(parsed.filter((x): x is string => typeof x === 'string'))
  } catch {
    /* corrupt / unavailable — start with everything expanded */
  }
  return new Set()
}

// ---------------------------------------------------------------- result summary

/**
 * One verdict tile in the result column. Tiles are the answer to "did my request
 * pass?" at a glance, and clicking one jumps to the tab that explains it — so the
 * summary is never a dead end the reader has to translate into a click themselves.
 */
function VerdictTile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  value: string
  hint: string
  tone: 'ok' | 'bad' | 'warn' | 'idle'
  active: boolean
  onClick: () => void
}) {
  const tones = {
    ok: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
    bad: 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400',
    warn: 'border-amber-500/30 bg-amber-500/5 text-amber-600 dark:text-amber-400',
    idle: 'border-border/60 bg-muted/40 text-muted-foreground',
  } as const
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        'flex min-w-0 flex-col gap-0.5 rounded-2xl border p-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm active:scale-[0.98]',
        tones[tone],
        active && 'ring-2 ring-ring/40',
      )}
    >
      <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide opacity-80">
        <Icon className="size-3" />
        <span className="truncate">{label}</span>
      </span>
      <span className="truncate text-sm font-semibold tabular-nums">{value}</span>
    </button>
  )
}

/**
 * Read-only pass/fail list for the assertions that ran against the response on
 * screen. The Assertions tab is where checks are *authored*; this is where they are
 * *read*, so "what failed" doesn't require leaving the result panel.
 */
function ChecksList({ results }: { results: AssertionResult[] }) {
  if (results.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
        No assertions on this request yet. Add one in{' '}
        <span className="font-medium text-foreground">Configure → Assertions</span> so a Send can
        pass or fail on its own.
      </p>
    )
  }
  return (
    <ul className="space-y-1.5">
      {results.map((r, i) => (
        <li
          key={`${r.key}-${i}`}
          className={cn(
            'flex items-start gap-2.5 rounded-xl border p-2.5',
            r.pass ? 'border-emerald-500/25 bg-emerald-500/5' : 'border-red-500/25 bg-red-500/5',
          )}
        >
          {r.pass ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          ) : (
            <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
          )}
          <div className="min-w-0 space-y-0.5">
            <p className="font-mono text-xs font-medium">{r.key}</p>
            <p className="break-words text-xs text-muted-foreground">
              got <span className="font-mono text-foreground">{r.actual || '(empty)'}</span>
              {r.expected && (
                <>
                  {' · '}expected <span className="font-mono text-foreground">{r.expected}</span>
                </>
              )}
            </p>
          </div>
        </li>
      ))}
    </ul>
  )
}

/** Section label used across the three workspace columns ("1 · Request", …). */
/**
 * One of the two page tabs (Requests / Flows). A plain button, not shadcn Tabs: the two
 * panels are whole workspaces switched by the URL, and the tab bar has to read as
 * navigation — a pill rail with a count, the same vocabulary as the sidebar.
 */
function PageTab({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  tour,
}: {
  icon: LucideIcon
  label: string
  count: number
  active: boolean
  onClick: () => void
  tour: string
}) {
  return (
    <button
      type="button"
      data-tour={tour}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition-all duration-200 active:scale-[0.98]',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-4" />
      {label}
      {count > 0 && (
        <span
          className={cn(
            'rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums',
            active ? 'bg-muted text-muted-foreground' : 'bg-background/60 text-muted-foreground',
          )}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function StepChip({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-[9px] font-bold text-background">
        {n}
      </span>
      {children}
    </span>
  )
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

  // Which half of the page is showing. It lives in the URL (`?tab=flows`) rather than in
  // component state so a scenario is linkable and survives a reload — the same `?tab=`
  // idiom /settings uses. Single requests are the default: that's where a flow's steps
  // come from, so nobody lands on Flows with an empty collection behind it.
  const [searchParams, setSearchParams] = useSearchParams()
  const tab: 'requests' | 'flows' = searchParams.get('tab') === 'flows' ? 'flows' : 'requests'
  const goTab = (next: 'requests' | 'flows') => {
    const params = new URLSearchParams(searchParams)
    if (next === 'requests') params.delete('tab')
    else params.set('tab', next)
    setSearchParams(params, { replace: true })
  }

  // Lazy initializer runs once on mount — seed from the persisted draft.
  const [draft, setDraft] = useState<Draft>(() => loadDraft(projectId).draft)
  const [selected, setSelected] = useState<string | null>(() => loadDraft(projectId).selected)
  const [res, setRes] = useState<ApiSendResult | null>(null)
  const [aiResult, setAiResult] = useState<AiCheckResult | null>(null)
  const [curlOpen, setCurlOpen] = useState(false)
  const [scanOpen, setScanOpen] = useState(false)
  const [manageEnvOpen, setManageEnvOpen] = useState(false)
  // "New request" writes the record straight away, so the button needs a pending state
  // and the URL bar needs a ref to take focus once the row exists.
  const [creating, setCreating] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)
  // The request "New request" just created, pinned to the TOP of the list so it isn't
  // filed alphabetically into the middle of a long collection the moment it's born.
  // It stays pinned while it's the open request (and follows its first-Send rename), and
  // lets go as soon as you open something else — nothing reorders under your cursor.
  const [pinnedFirst, setPinnedFirst] = useState<string | null>(null)
  // Inline rename of a saved request: the name being renamed + the edited value.
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  // The saved request pending delete-confirmation (null = no dialog open).
  const [deleting, setDeleting] = useState<string | null>(null)
  // Search text for the saved-requests sidebar. The box is always mounted once anything
  // is saved — hiding it until the collection got big meant nobody knew it existed, and
  // by the time you have 30 endpoints you're already scrolling to find them.
  const [filter, setFilter] = useState('')
  const searchRef = useRef<HTMLInputElement | null>(null)
  // Modules (Swagger-style groups): the request being moved, the module header being
  // renamed, and which modules are folded shut (persisted per project).
  const [moving, setMoving] = useState<ApiRequestDef | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [groupRenameValue, setGroupRenameValue] = useState('')
  const collapsedKey = `qc.apiTest.modules.${projectId}`
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsedModules(projectId))
  const [autoGrouping, setAutoGrouping] = useState(false)
  // Which face of the result column is showing. View state only — the response,
  // its checks, its findings and its history are all already computed.
  const [resultTab, setResultTab] = useState('response')

  useEffect(() => {
    try {
      localStorage.setItem(collapsedKey, JSON.stringify([...collapsed]))
    } catch {
      /* storage unavailable — non-fatal */
    }
  }, [collapsed, collapsedKey])

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

  // Just the count, for the tab badge — same queryKey as the Flows tab, so this shares
  // one fetch with the workspace instead of adding a request.
  const { data: flowsData } = useQuery({
    queryKey: ['api-flows', projectId],
    queryFn: () => listApiFlows(projectId),
    enabled: !!projectId,
  })
  const flowCount = flowsData?.flows.length ?? 0

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
      // Drop the deleted request's run history from the cache — the server removed the
      // folder, and a later request reusing the name would otherwise read the dead one's
      // evidence out of cache.
      queryClient.removeQueries({ queryKey: ['api-results', projectId, n] })
      // Clearing `selected` alone left the whole editor — method, URL, headers, body,
      // assertions, the response and its AI verdict — showing the request that was just
      // deleted. It then reads as an unsaved new request (only a reload cleared it), and
      // the next Send RE-CREATED the file the user deleted.
      if (selected === n) {
        setSelected(null)
        setDraft(emptyDraft())
        setRes(null)
        setAiResult(null)
      }
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

  // Move one request into a module. The module lives only on the server's copy (it's
  // not part of the draft), so this is a targeted call rather than a full re-save.
  const moveMut = useMutation({
    mutationFn: ({ name, group }: { name: string; group: string }) =>
      setApiRequestGroup(projectId, name, group),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      setMoving(null)
      if (d.group) setCollapsed((s) => new Set([...s].filter((g) => g !== d.group)))
      toast.success(d.group ? `Moved to “${d.group}”` : 'Removed from its module')
    },
    onError: (e) =>
      toast.error('Could not move the request', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  // Rename a module across every request filed under it.
  const groupRenameMut = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) => renameApiGroup(projectId, from, to),
    onSuccess: (_r, { from, to }) => {
      queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      setCollapsed((s) => {
        if (!s.has(from)) return s
        const next = new Set([...s].filter((g) => g !== from))
        if (to) next.add(to)
        return next
      })
      setRenamingGroup(null)
      toast.success(to ? `Module renamed to “${to}”` : 'Module removed')
    },
    onError: (e) =>
      toast.error('Could not rename the module', {
        description: e instanceof Error ? e.message : 'Unknown error',
      }),
  })

  const commitGroupRename = (from: string) => {
    const to = groupRenameValue.trim()
    if (!to || to === from) {
      setRenamingGroup(null)
      return
    }
    groupRenameMut.mutate({ from, to })
  }

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
  /**
   * "New request" — create the record NOW, don't wait for a Send.
   *
   * It used to only reset the draft: the collection stayed empty until you had typed a
   * URL and sent it, so the button looked like it had done nothing, there was no row to
   * name, move into a module, or come back to, and a half-built request was lost by the
   * next click. The record is written blank (the server's PUT accepts an empty URL),
   * selected — which switches the auto-save effect on, so every keystroke after this is
   * persisted — and the URL bar takes focus. The placeholder name is upgraded to the
   * derived `METHOD /path` on the first Send.
   */
  const newRequest = async () => {
    const name = uniqueName(PLACEHOLDER_NAME, new Set((saved ?? []).map((s) => s.name)))
    const blank = emptyDraft()
    setDraft(blank)
    setRes(null)
    setAiResult(null)
    setSelected(null)
    setFilter('')
    setCreating(true)
    try {
      await saveApiRequest(projectId, name, blank)
      await queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      setSelected(name)
      setPinnedFirst(name)
    } catch (e) {
      // Nothing was written, so leave the draft blank and unselected — the old
      // "saved on first Send" path still works as a fallback.
      toast.error('Could not create the request', {
        description: e instanceof Error ? e.message : undefined,
      })
    } finally {
      setCreating(false)
      urlRef.current?.focus()
    }
  }

  /**
   * Give a placeholder-named request its real name, once it has a URL to derive one
   * from. Awaited before the send so the stored result lands under the final name (the
   * rename endpoint carries the run history across, but only for what's on disk).
   */
  const upgradePlaceholderName = async (current: string): Promise<string> => {
    const taken = new Set((saved ?? []).map((s) => s.name).filter((n) => n !== current))
    const next = uniqueName(deriveName(draft), taken)
    if (next === current) return current
    try {
      await renameApiRequest(projectId, current, next)
      await queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
      setSelected(next)
      // Follow the rename, so the row doesn't jump the instant you press Send.
      setPinnedFirst((p) => (p === current ? next : p))
      return next
    } catch {
      /* a name collision or a bad character is non-fatal — send under the old name */
      return current
    }
  }

  const handleSend = async () => {
    if (!draft.url) return
    setAiResult(null)
    const key = requestKey(draft)
    const dup = (saved ?? []).find((s) => requestKey(s) === key)
    let savedName: string
    if (selected) {
      // The open request IS this draft (the auto-save effect keeps its file in sync),
      // so never look for a duplicate here: `saved` can lag the draft by one debounce,
      // and treating that as "not saved yet" created a SECOND record for the request
      // already on screen. A placeholder name earns its real one now.
      savedName = isPlaceholderName(selected) ? await upgradePlaceholderName(selected) : selected
    } else if (dup) {
      // Same request already saved — keep it selected, don't duplicate.
      savedName = dup.name
      setSelected(dup.name)
    } else {
      const unique = uniqueName(deriveName(draft), new Set((saved ?? []).map((s) => s.name)))
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
    if (item.name !== pinnedFirst) setPinnedFirst(null)
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

  // Saved-requests sidebar search. Every term must match somewhere in the request, so
  // "post login" finds the POST /auth/login row without caring about word order; each
  // term is tried against name, method, URL *and* module name, because "auth" is just as
  // likely to be the folder you filed it under as a piece of the path.
  const filteredSaved = useMemo(() => {
    const all = saved ?? []
    const terms = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (!terms.length) return all
    return all.filter((s) => {
      const hay = `${s.name} ${s.method} ${s.url} ${s.group ?? ''}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    })
  }, [saved, filter])

  // Every module in use, for the move dialog's picker.
  const modules = useMemo(() => {
    const set = new Set<string>()
    for (const s of saved ?? []) if ((s.group ?? '').trim()) set.add(s.group.trim())
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [saved])

  // The sidebar list, folded into modules — named ones A→Z, ungrouped last. The pinned
  // request (see `pinnedFirst`) is lifted to the top of its module, and its module to the
  // top of the list, so a request you just created really is the first row you see.
  const sections = useMemo(() => {
    const map = new Map<string, ApiRequestDef[]>()
    for (const s of filteredSaved) {
      const g = (s.group ?? '').trim()
      const list = map.get(g)
      if (list) list.push(s)
      else map.set(g, [s])
    }
    const out = [...map.keys()]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
      .map((group) => ({ group, items: map.get(group)! }))
    const loose = map.get(UNGROUPED)
    if (loose) out.push({ group: UNGROUPED, items: loose })
    if (!pinnedFirst) return out
    const holder = out.findIndex((sec) => sec.items.some((i) => i.name === pinnedFirst))
    if (holder < 0) return out
    const items = [
      ...out[holder].items.filter((i) => i.name === pinnedFirst),
      ...out[holder].items.filter((i) => i.name !== pinnedFirst),
    ]
    const section = { group: out[holder].group, items }
    return [section, ...out.filter((_, i) => i !== holder)]
  }, [filteredSaved, pinnedFirst])

  // Headers only earn their space once something is actually grouped.
  const showModules = modules.length > 0
  // While filtering, everything stays open so a match can't hide inside a folded module.
  const isCollapsed = (group: string) => !filter.trim() && collapsed.has(group)
  const toggleModule = (group: string) =>
    setCollapsed((s) => {
      const next = new Set(s)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })

  // Requests with no module whose URL suggests one — what "Auto-group" would file.
  const autoGroupable = useMemo(
    () => (saved ?? []).filter((s) => !(s.group ?? '').trim() && moduleFromUrl(s.url)),
    [saved],
  )

  /** File every ungrouped request under the module its URL path implies (Swagger-style). */
  const autoGroup = async () => {
    if (!autoGroupable.length) return
    setAutoGrouping(true)
    let ok = 0
    for (const s of autoGroupable) {
      try {
        await setApiRequestGroup(projectId, s.name, moduleFromUrl(s.url))
        ok++
      } catch {
        /* skip one failure — keep grouping the rest */
      }
    }
    setAutoGrouping(false)
    queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
    if (ok) toast.success(`Grouped ${ok} request${ok === 1 ? '' : 's'} by URL path`)
    else toast.error('Could not group the requests')
  }

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
  // Result-column faces, with the counts the tabs and tiles both read from.
  const issueCount = findings?.filter((f) => f.severity !== 'info').length ?? 0
  const historyCount = history?.length ?? 0
  const aiVerdict = aiResult?.ok ? (aiResult.verdict ?? null) : null

  return (
    <div className="space-y-5">
      {/* Page header — what this page is, and the three ways a request gets in here. */}
      <header className="flex flex-col gap-4 2xl:flex-row 2xl:items-center 2xl:justify-between">
        <div data-tour="header" className="flex items-start gap-3">
          <span className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Zap className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">API Testing</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              {tab === 'flows' ? (
                <>
                  Chain saved requests into one scenario — log in, capture the token, then the steps
                  that need it. Every step is graded by the same assertions it has on its own.
                </>
              ) : (
                <>
                  Build a request, <span className="font-medium text-foreground">Send</span> it, read
                  the verdict. Requests are proxied through the portal server, so CORS and
                  localhost/staging URLs just work.
                </>
              )}
            </p>
          </div>
        </div>
        <div data-tour="import" className="flex shrink-0 flex-wrap items-center gap-2">
          {/* Import routes belong to the request builder; on the Flows tab they would
              only add noise (a flow is assembled from what's already saved). */}
          {tab === 'requests' && (
            <>
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
            title="Paste a curl command to turn it into a request"
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
          </>
          )}
          <OpenFolderButton open={() => openApiTestsFolder(projectId)} label="API tests" />
        </div>
      </header>

      {/* Page tabs. Two jobs live here and they need different room: ONE request with its
          response, or a multi-step scenario with a live run. They used to share the page
          (Flows was a card in the sidebar that opened a modal), which cramped both. */}
      <div
        data-tour="page-tabs"
        className="flex w-fit items-center gap-1 rounded-full border border-border/60 bg-muted/60 p-1"
      >
        <PageTab
          icon={Zap}
          label="Requests"
          count={(saved ?? []).length}
          active={tab === 'requests'}
          onClick={() => goTab('requests')}
          tour="tab-requests"
        />
        <PageTab
          icon={Route}
          label="Flows"
          count={flowCount}
          active={tab === 'flows'}
          onClick={() => goTab('flows')}
          tour="tab-flows"
        />
      </div>

      {tab === 'flows' && <ApiFlowsWorkspace projectId={projectId} saved={saved ?? []} />}

      {/* The workspace: collection → request builder → result. Three columns on a wide
          screen, and on a narrow one the result panel slides under the builder rather
          than into the rail's column (hence the nested grid). Hidden — not unmounted —
          on the Flows tab, so switching back keeps the response you were reading. */}
      <div
        className={cn(
          'grid gap-5 lg:grid-cols-[minmax(228px,248px)_minmax(0,1fr)]',
          tab === 'flows' && 'hidden',
        )}
      >
        {/* ---------------------------------------------------------- 1. collection */}
        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <section className="space-y-2 rounded-2xl border border-border/60 bg-card p-3 shadow-none">
            <div className="flex items-center justify-between gap-2 px-0.5">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <FolderTree className="size-3.5 shrink-0" />
                <span className="truncate">Collection</span>
                {(saved ?? []).length > 0 && (
                  <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                    {(saved ?? []).length}
                  </span>
                )}
              </span>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={newRequest}
              disabled={creating}
              className="h-8 w-full gap-1.5 rounded-full text-xs active:scale-[0.98]"
              title="Add an empty request to the collection and start editing it"
            >
              {creating ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Plus className="size-3.5" />
              )}
              New request
            </Button>

            {/* Search. Always here once there's anything to search, with a clear button
                inside the field — Escape also clears, so a dead end never traps you. */}
            {(saved ?? []).length > 0 && (
              <div className="space-y-1">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    ref={searchRef}
                    type="search"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        if (filter) setFilter('')
                        else searchRef.current?.blur()
                      }
                    }}
                    placeholder="Search name, method, URL…"
                    aria-label="Search saved requests"
                    className="h-8 pl-8 pr-8 text-xs shadow-none [&::-webkit-search-cancel-button]:hidden"
                  />
                  {filter && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilter('')
                        searchRef.current?.focus()
                      }}
                      className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label="Clear search"
                      title="Clear search (Esc)"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </div>
                {/* A count, so "nothing showing" reads as a search result and not a bug. */}
                {filter.trim() && (
                  <p className="px-1 text-[10px] text-muted-foreground tabular-nums">
                    {filteredSaved.length} of {(saved ?? []).length} match
                  </p>
                )}
              </div>
            )}

            {/* One click to file everything loose under the module its URL path implies.
                Hidden while searching — it acts on the whole collection, not on the
                filtered list, so offering it under "0 of 12 match" only misleads. */}
            {autoGroupable.length > 0 && !filter.trim() && (
              <Button
                variant="ghost"
                size="sm"
                onClick={autoGroup}
                disabled={autoGrouping}
                className="h-8 w-full gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground active:scale-[0.98]"
                title="Group ungrouped requests by the first path segment of their URL"
              >
                {autoGrouping ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FolderTree className="size-3.5" />
                )}
                Auto-group {autoGroupable.length} by path
              </Button>
            )}

            <div className="-mx-1 max-h-[46vh] space-y-1 overflow-y-auto px-1 lg:max-h-[52vh]">
              {/* First-run empty state: say what to do, not just that there's nothing. */}
              {(saved ?? []).length === 0 && (
                <div className="space-y-2 rounded-xl border border-dashed border-border/60 p-3 text-center">
                  <p className="text-xs font-medium">No saved requests yet</p>
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    <span className="font-medium text-foreground">New request</span> above adds an
                    empty one you can fill in. Or start from something real:
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => setScanOpen(true)}
                      className="h-7 gap-1.5 rounded-full text-[11px] active:scale-[0.98]"
                    >
                      <Radar className="size-3" />
                      Scan a page
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCurlOpen(true)}
                      className="h-7 gap-1.5 rounded-full text-[11px] active:scale-[0.98]"
                    >
                      <TerminalSquare className="size-3" />
                      Import cURL
                    </Button>
                  </div>
                </div>
              )}
              {(saved ?? []).length > 0 && filteredSaved.length === 0 && (
                <div className="space-y-2 rounded-xl border border-dashed border-border/60 px-3 py-4 text-center">
                  <p className="text-xs text-muted-foreground">
                    No requests match “<span className="font-medium text-foreground">{filter.trim()}</span>”.
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFilter('')
                      searchRef.current?.focus()
                    }}
                    className="h-6 gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <X className="size-3" />
                    Clear search
                  </Button>
                </div>
              )}
              {sections.map((section) => (
                <div key={section.group || '__ungrouped__'} className="space-y-1">
                  {/* Module header — Swagger-style grouping; hidden until something is grouped. */}
                  {showModules && (
                    <div className="flex items-center gap-1 px-0.5 pt-1">
                      {renamingGroup === section.group ? (
                        <>
                          <Input
                            autoFocus
                            value={groupRenameValue}
                            onChange={(e) => setGroupRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitGroupRename(section.group)
                              if (e.key === 'Escape') setRenamingGroup(null)
                            }}
                            maxLength={60}
                            className="h-7 flex-1 px-2 text-xs shadow-none"
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => commitGroupRename(section.group)}
                            disabled={groupRenameMut.isPending}
                            className="size-6 shrink-0 rounded-md text-emerald-600 hover:text-emerald-700"
                            aria-label="Confirm module rename"
                          >
                            {groupRenameMut.isPending ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Check className="size-3.5" />
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setRenamingGroup(null)}
                            className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                            aria-label="Cancel module rename"
                          >
                            <X className="size-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => toggleModule(section.group)}
                            className="group/mod flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <ChevronRight
                              className={cn(
                                'size-3.5 shrink-0 transition-transform',
                                !isCollapsed(section.group) && 'rotate-90',
                              )}
                            />
                            <span className="min-w-0 truncate" title={moduleLabel(section.group)}>
                              {moduleLabel(section.group)}
                            </span>
                            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums">
                              {section.items.length}
                            </span>
                          </button>
                          {section.group && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => {
                                setRenamingGroup(section.group)
                                setGroupRenameValue(section.group)
                              }}
                              className="size-6 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                              aria-label={`Rename module ${section.group}`}
                              title="Rename this module"
                            >
                              <Pencil className="size-3" />
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {!isCollapsed(section.group) &&
                    section.items.map((item) => {
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
                            'group flex items-center gap-1.5 rounded-xl border px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            !isRenaming && 'cursor-pointer',
                            showModules && 'ml-2',
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
                                className="h-7 flex-1 px-2 text-xs shadow-none"
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
                              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className={cn(
                                      'shrink-0 font-mono text-[10px] font-bold',
                                      methodColor(item.method),
                                    )}
                                  >
                                    {item.method}
                                  </span>
                                  <span
                                    className="min-w-0 truncate text-xs font-medium"
                                    title={item.name}
                                  >
                                    {item.name}
                                  </span>
                                </span>
                                {/* The URL is what tells two similar names apart — and a
                                    freshly created record has none yet, which must read as
                                    "not filled in", not as a blank line. */}
                                <span
                                  className={cn(
                                    'min-w-0 truncate pl-0.5 text-[10px]',
                                    item.url
                                      ? 'font-mono text-muted-foreground/70'
                                      : 'italic text-muted-foreground/60',
                                  )}
                                  title={item.url || undefined}
                                >
                                  {item.url ? item.url.replace(/^https?:\/\//, '') : 'no URL yet'}
                                </span>
                              </span>
                              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setMoving(item)
                                  }}
                                  className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                                  aria-label={`Move ${item.name} to a module`}
                                  title="Move to module"
                                >
                                  <FolderTree className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setRenaming(item.name)
                                    setRenameValue(item.name)
                                  }}
                                  className="size-6 rounded-md text-muted-foreground hover:text-foreground"
                                  aria-label={`Rename ${item.name}`}
                                  title="Rename"
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
                                  className="size-6 rounded-md text-muted-foreground hover:text-destructive"
                                  aria-label={`Delete ${item.name}`}
                                  title="Delete"
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </span>
                            </>
                          )}
                        </div>
                      )
                    })}
                </div>
              ))}
            </div>
          </section>

          {/* A pointer, not the feature: flows live in their own tab now, where the
              steps list and a live run have the width they need. */}
          <button
            type="button"
            onClick={() => goTab('flows')}
            className="flex w-full items-center gap-2 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.99]"
            title="Run several of these requests in order"
          >
            <Route className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block text-xs font-medium">Flows</span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {flowCount
                  ? `${flowCount} scenario${flowCount === 1 ? '' : 's'}`
                  : 'Chain these requests into a scenario'}
              </span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </aside>

        <div className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(400px,36%)] 2xl:items-start">
          {/* ------------------------------------------------- 2. request builder */}
          <div className="min-w-0 space-y-3">
            {/* Send bar — method, URL and Send on one line: the one thing every visit
                starts with, so nothing sits above it. */}
            <div
              data-tour="request"
              className="space-y-2 rounded-2xl border border-border/60 bg-card p-3 shadow-none"
            >
              <div className="flex items-center justify-between gap-2 px-0.5">
                <StepChip n={1}>Request</StepChip>
                {/* Save state — the auto-save model is never a mystery. */}
                {isNewUnsaved ? (
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Info className="size-3 shrink-0 text-sky-500" />
                    New — Send saves it
                  </span>
                ) : selected ? (
                  <span
                    className="inline-flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
                    title={selected}
                  >
                    {isDirty ? (
                      <>
                        <Loader2 className="size-3 shrink-0 animate-spin text-amber-500" />
                        Saving…
                      </>
                    ) : (
                      <>
                        <Check className="size-3 shrink-0 text-emerald-500" />
                        <span className="max-w-[16ch] truncate font-medium text-foreground sm:max-w-[28ch]">
                          {selected}
                        </span>
                        saved
                      </>
                    )}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border/60 bg-background p-1.5">
                  <Select value={draft.method} onValueChange={(v) => patch({ method: v })}>
                    <SelectTrigger
                      className={cn(
                        'h-9 w-[104px] shrink-0 border-0 bg-muted/60 font-mono text-xs font-bold shadow-none',
                        methodColor(draft.method),
                      )}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {METHODS.map((m) => (
                        <SelectItem
                          key={m}
                          value={m}
                          className={cn('font-mono text-xs font-bold', methodColor(m))}
                        >
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    ref={urlRef}
                    value={draft.url}
                    onChange={(e) => patch({ url: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && draft.url) handleSend()
                    }}
                    placeholder="https://api.example.com/v1/resource"
                    className="h-9 min-w-[8rem] flex-1 border-0 font-mono text-xs shadow-none focus-visible:ring-0"
                  />
                </div>
                <Button
                  onClick={handleSend}
                  disabled={!draft.url || send.isPending}
                  title={`Send (${sendHint})`}
                  className="h-11 shrink-0 gap-2 rounded-full px-6 active:scale-[0.98]"
                >
                  {send.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Send
                  <kbd className="hidden rounded bg-primary-foreground/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-primary-foreground/80 sm:inline">
                    {sendHint}
                  </kbd>
                </Button>
              </div>

              {/* Environment — the active {{variable}} set this send resolves against.
                  It belongs with the URL, because that's what it rewrites. */}
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-muted/40 px-2.5 py-1.5">
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                  <Boxes className="size-3.5" />
                  Environment
                </span>
                {(environments?.environments.length ?? 0) > 0 ? (
                  <Select
                    value={activeEnv ?? '__none__'}
                    onValueChange={(v) => setActiveEnv.mutate(v === '__none__' ? null : v)}
                  >
                    <SelectTrigger className="h-7 w-[150px] border-border/60 bg-background text-xs shadow-none">
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
                  <span className="text-[11px] text-muted-foreground">None yet</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setManageEnvOpen(true)}
                  className="h-7 gap-1.5 rounded-full text-[11px] active:scale-[0.98]"
                >
                  <Pencil className="size-3" />
                  Manage
                </Button>
                <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground lg:inline-flex">
                  Use <span className="font-mono">{'{{var}}'}</span> in the URL, params, headers or
                  body
                </span>
              </div>
            </div>

            {/* Request config tabs */}
            <div
              data-tour="config"
              className="rounded-2xl border border-border/60 bg-card p-4 shadow-none"
            >
              <Tabs defaultValue="params">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <StepChip n={2}>Configure &amp; assert</StepChip>
                </div>
                <TabsList className="flex-wrap rounded-full">
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
                  <TabsTrigger
                    value="assert"
                    data-tour="tab-assert"
                    className="gap-1 rounded-full text-xs"
                  >
                    <ListChecks className="size-3" />
                    Assertions
                    {draft.assertions.filter((a) => a.enabled).length > 0 &&
                      ` (${draft.assertions.filter((a) => a.enabled).length})`}
                  </TabsTrigger>
                  <TabsTrigger
                    value="capture"
                    data-tour="tab-capture"
                    className="gap-1 rounded-full text-xs"
                  >
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
                      placeholder={
                        draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Raw request body'
                      }
                      className="min-h-[180px] font-mono text-xs shadow-none"
                      spellCheck={false}
                    />
                  )}
                </TabsContent>
                <TabsContent value="assert" className="space-y-3 pt-4">
                  <p className="text-xs text-muted-foreground">
                    Each enabled check is graded on every Send. Results appear under{' '}
                    <span className="font-medium text-foreground">Result → Checks</span>.
                  </p>
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
                    Describe in plain language what a correct response looks like — or quick-pick
                    common criteria below. After you Send, AI reads the actual response and judges it
                    against this, great for checks that are awkward to express as exact-match rules.
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
                    className="min-h-[120px] text-xs shadow-none"
                    spellCheck={false}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      onClick={() => {
                        if (!res) return
                        setResultTab('ai')
                        runAiCheck(res, draft.aiExpect)
                      }}
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
                        : 'Runs automatically after each Send when an expectation is set — the verdict lands in Result → AI.'}
                    </span>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>

          {/* --------------------------------------------------------- 3. result */}
          <section
            data-tour="response"
            // Sticky only once it has its own column, and capped there so a long
            // findings list scrolls inside the panel instead of making the whole page
            // scroll past the request it belongs to.
            className="min-w-0 space-y-3 rounded-2xl border border-border/60 bg-card p-4 shadow-none 2xl:sticky 2xl:top-4 2xl:max-h-[calc(100svh-5rem)] 2xl:overflow-y-auto"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StepChip n={3}>Result</StepChip>
              {/* Status stays pinned beside the heading on every tab EXCEPT Response —
                  there ResponseView prints a richer strip (size, content-type) two rows
                  down, and the same 200/6 ms twice reads like a rendering bug. */}
              {res && !send.isPending && resultTab !== 'response' && (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums',
                      res.ok ? statusTone(res.status) : 'bg-red-100 text-red-700',
                    )}
                  >
                    {res.ok ? `${res.status} ${res.statusText ?? ''}`.trim() : 'FAILED'}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock3 className="size-3" />
                    {res.timeMs} ms
                  </span>
                </span>
              )}
            </div>

            {send.isPending ? (
              <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Sending…
              </div>
            ) : res ? (
              <div className="space-y-3">
                {/* The three questions a QC engineer actually has, as tiles that
                    double as navigation into the tab that answers each. */}
                {res.ok && (
                  <div className="grid grid-cols-3 gap-2">
                    <VerdictTile
                      icon={ListChecks}
                      label="Checks"
                      value={totalChecks > 0 ? `${passCount}/${totalChecks}` : '—'}
                      hint={
                        totalChecks > 0
                          ? 'Your assertions, graded against this response'
                          : 'No assertions on this request yet'
                      }
                      tone={
                        totalChecks === 0 ? 'idle' : passCount === totalChecks ? 'ok' : 'bad'
                      }
                      active={resultTab === 'checks'}
                      onClick={() => setResultTab('checks')}
                    />
                    <VerdictTile
                      icon={ShieldAlert}
                      label="Issues"
                      value={issueCount > 0 ? String(issueCount) : 'None'}
                      hint="Automatic QC scan — security, correctness, performance"
                      tone={highCount > 0 ? 'bad' : issueCount > 0 ? 'warn' : 'ok'}
                      active={resultTab === 'issues'}
                      onClick={() => setResultTab('issues')}
                    />
                    <VerdictTile
                      icon={Sparkles}
                      label="AI"
                      value={
                        aiCheck.isPending
                          ? '…'
                          : aiVerdict
                            ? aiVerdict.toUpperCase()
                            : draft.aiExpect.trim()
                              ? 'Ready'
                              : 'Off'
                      }
                      hint={
                        draft.aiExpect.trim()
                          ? 'AI verdict against your written expectation'
                          : 'Write an expectation in Configure → AI check'
                      }
                      tone={
                        aiVerdict === 'pass'
                          ? 'ok'
                          : aiVerdict === 'fail'
                            ? 'bad'
                            : aiVerdict
                              ? 'warn'
                              : 'idle'
                      }
                      active={resultTab === 'ai'}
                      onClick={() => setResultTab('ai')}
                    />
                  </div>
                )}

                <Tabs value={resultTab} onValueChange={setResultTab}>
                  <TabsList className="flex-wrap rounded-full">
                    <TabsTrigger value="response" className="rounded-full text-xs">
                      Response
                    </TabsTrigger>
                    <TabsTrigger value="checks" className="rounded-full text-xs">
                      Checks
                    </TabsTrigger>
                    <TabsTrigger value="issues" className="rounded-full text-xs">
                      Issues
                      {issueCount > 0 && ` (${issueCount})`}
                    </TabsTrigger>
                    <TabsTrigger value="ai" className="rounded-full text-xs">
                      AI
                    </TabsTrigger>
                    <TabsTrigger value="history" className="rounded-full text-xs">
                      Runs
                      {historyCount > 0 && ` (${historyCount})`}
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="response" className="pt-3">
                    <ResponseView res={res} />
                  </TabsContent>

                  <TabsContent value="checks" className="pt-3">
                    {res.ok ? (
                      <ChecksList results={results ?? []} />
                    ) : (
                      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                        The request never reached the API, so there was nothing to check.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="issues" className="space-y-2 pt-3">
                    {res.ok && findings ? (
                      <>
                        <p className="text-[11px] leading-5 text-muted-foreground">
                          Heuristics run on every response — hints to investigate, not verdicts.
                        </p>
                        <QcScanPanel findings={findings} />
                      </>
                    ) : (
                      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                        No response to scan.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="ai" className="space-y-3 pt-3">
                    {aiCheck.isPending ? (
                      <p className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        AI is reading the response…
                      </p>
                    ) : aiResult && aiResult.ok ? (
                      <AiCheckView result={aiResult} />
                    ) : !draft.aiExpect.trim() ? (
                      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
                        Describe what a correct response looks like in{' '}
                        <span className="font-medium text-foreground">Configure → AI check</span>,
                        and the verdict shows up here after each Send.
                      </p>
                    ) : (
                      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
                        An expectation is set — Send again, or use{' '}
                        <span className="font-medium text-foreground">Run AI check</span>.
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="history" className="pt-3">
                    {selected && historyCount > 0 ? (
                      <HistoryPanel
                        items={history ?? []}
                        onLoad={loadResult}
                        onClear={() => clearHistory.mutate()}
                        clearing={clearHistory.isPending}
                      />
                    ) : (
                      <p className="rounded-xl border border-dashed border-border/60 px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
                        {selected
                          ? 'No stored runs yet — every Send of this request is kept here as evidence.'
                          : 'Save this request (just Send it) to start an evidence trail.'}
                      </p>
                    )}
                  </TabsContent>
                </Tabs>
              </div>
            ) : (
              /* Nothing sent yet — spell out the loop instead of an empty box. */
              <div className="space-y-3 py-2">
                <ol className="space-y-2 text-xs text-muted-foreground">
                  <li className="flex items-start gap-2">
                    <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-foreground">
                      1
                    </span>
                    Put a URL in the bar on the left — or import one from cURL / a page scan.
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-foreground">
                      2
                    </span>
                    Add assertions (and an AI expectation) so the result is a verdict, not a wall of
                    JSON.
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-bold text-foreground">
                      3
                    </span>
                    Hit <span className="font-medium text-foreground">Send</span> ({sendHint}) — the
                    response, your checks, the QC scan and the run history all land here.
                  </li>
                </ol>
                <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <ListChecks className="size-3.5" />
                    Assertions
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Bug className="size-3.5" />
                    QC scan
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="size-3.5" />
                    AI check
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <HistoryIcon className="size-3.5" />
                    Run history
                  </span>
                </div>
              </div>
            )}
          </section>
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

      {moving && (
        <MoveToModuleDialog
          request={moving}
          modules={modules}
          pending={moveMut.isPending}
          onCancel={() => setMoving(null)}
          onMove={(group) => moveMut.mutate({ name: moving.name, group })}
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
              {delMut.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
