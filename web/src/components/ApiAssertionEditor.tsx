// The assertion editor, shared by the request builder and the flow runner.
//
// It used to live inside `pages/ApiTestingPage.tsx`, which was fine while only the
// builder authored checks. A flow step can now override its request's assertions (its
// own data set, its own expectations — the "login with wrong credentials reuses the
// login request" case), and `components/ApiFlowPanel.tsx` cannot import the page
// (import cycle — the page already imports the panel). A second copy of the type
// labels, the presets and the which-field-does-this-type-need rules is exactly how the
// two sides drift apart, so the editor moved here instead.

import { Plus, CheckCircle2, Trash2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import type { ApiAssertion, ApiAssertionType } from '@/lib/api'
import type { AssertionResult } from '@/lib/apiAssert'
import { cn } from '@/lib/utils'

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

export function AssertionEditor({
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
