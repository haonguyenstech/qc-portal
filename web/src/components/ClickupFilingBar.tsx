/**
 * The "file these to ClickUp" commit bar — parent ticket field, a read-only preview
 * of what filing under that parent will inherit, the create button, and the cards it
 * produced.
 *
 * Shared by the run detail's Issues tab and the Design Check page so both file through
 * ONE implementation (`lib/clickup-filing.ts` holds the pure half). The caller owns the
 * selection UI and each item's wording; this owns everything from the parent ticket
 * onwards, including the rule that the preview must be shown BEFORE the button —
 * an automation you can only check by opening ClickUp afterwards is one nobody trusts,
 * and a parent with NO assignee has to admit up front that the bugs land unassigned.
 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  Link2,
  Loader2,
  MessageSquare,
  Send,
  SignalHigh,
  UserRound,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  appliedSummary,
  errorSentence,
  priorityFromSeverity,
  screenshotErrorSentence,
  useDebounced,
  type FilingItem,
} from '@/lib/clickup-filing'
import {
  clickupIssueFilingContext,
  createClickupIssueSubtasks,
  type AppliedIssueFields,
  type ClickupFilingContext,
  type ClickupTask,
} from '@/lib/api'

export type CreatedFiledTask = ClickupTask & { applied?: AppliedIssueFields }

type FilingState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; context: ClickupFilingContext }

/**
 * What the selected items will inherit from the parent ticket, shown before filing.
 * `showEvidence` is off for sources that carry no screenshots (Design Check), where a
 * row reading "no screenshots" would be noise rather than a warning.
 */
function FilingPreview({
  state,
  items,
  noun,
  showEvidence,
}: {
  state: FilingState
  items: FilingItem[]
  noun: string
  showEvidence: boolean
}) {
  if (state.kind === 'idle') return null

  if (state.kind === 'loading') {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Reading the parent ticket…
      </p>
    )
  }
  if (state.kind === 'error') {
    return (
      <p className="flex items-start gap-1.5 rounded-xl border border-amber-200 bg-amber-50/60 px-2.5 py-1.5 text-[11px] text-amber-700">
        <AlertCircle className="mt-px size-3 shrink-0" />
        <span>
          Could not read that ticket, so nothing can be inherited from it.{' '}
          <span className="opacity-80">{state.message}</span>
        </span>
      </p>
    )
  }

  const { context } = state
  const names = context.assignees.map((a) => a.username).filter(Boolean)

  // Group the priorities these items will get, so "High x3, Normal x1" is visible
  // rather than a promise that priority is "handled".
  const tally = new Map<string, number>()
  for (const item of items) {
    const label = priorityFromSeverity(item.severity) ?? context.priority?.label ?? null
    const key = label ?? 'not set'
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  const priorities = [...tally.entries()]
  const shots = items.reduce((n, i) => n + i.screenshots.length, 0)

  return (
    <div className="space-y-1.5 rounded-xl border border-border/60 bg-background/70 px-2.5 py-2">
      <p className="text-[11px] font-semibold text-foreground">
        Inherited from{' '}
        {context.url ? (
          <a
            href={context.url}
            target="_blank"
            rel="noreferrer"
            className="font-mono font-normal text-primary underline-offset-2 hover:underline"
          >
            {context.displayId}
          </a>
        ) : (
          <span className="font-mono font-normal">{context.displayId}</span>
        )}
        {context.name ? <span className="text-muted-foreground"> · {context.name}</span> : null}
      </p>
      <FilingRow icon={<UserRound className="size-3" />} label="Assignee">
        {names.length ? (
          names.join(', ')
        ) : (
          <span className="text-amber-700">
            none on the parent — the subtasks will be unassigned
          </span>
        )}
      </FilingRow>
      <FilingRow icon={<SignalHigh className="size-3" />} label="Priority">
        {items.length === 0
          ? '—'
          : priorities.map(([label, n], i) => (
              <span key={label}>
                {i > 0 ? ', ' : ''}
                <span className={label === 'not set' ? 'text-muted-foreground' : 'font-medium'}>
                  {label}
                </span>
                {n > 1 ? ` ×${n}` : ''}
              </span>
            ))}
        {priorities.length > 0 && (
          <span className="text-muted-foreground/70">
            {' '}
            (from each {noun}&apos;s severity
            {context.priority ? `, else the parent's ${context.priority.label}` : ''})
          </span>
        )}
      </FilingRow>
      {context.tags.length > 0 && (
        <FilingRow icon={<Link2 className="size-3" />} label="Tags">
          {context.tags.join(', ')}
        </FilingRow>
      )}
      {showEvidence && (
        <FilingRow icon={<MessageSquare className="size-3" />} label="Evidence">
          {shots > 0
            ? `${shots} screenshot${shots === 1 ? '' : 's'} attached to the cards and posted as a comment`
            : `no screenshots on the selected ${noun}s`}
        </FilingRow>
      )}
    </div>
  )
}

function FilingRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <span className="mt-0.5 shrink-0 text-muted-foreground/70">{icon}</span>
      <span className="shrink-0 font-medium text-foreground/80">{label}:</span>
      <span className="min-w-0">{children}</span>
    </p>
  )
}

export function ClickupFilingBar({
  projectId,
  items,
  slug = null,
  defaultParent = '',
  noun = 'issue',
  showEvidence = true,
  inputId = 'clickup-parent',
  className,
}: {
  projectId: string
  /** The SELECTED items, already worded by the caller. */
  items: FilingItem[]
  /** Run output folder, so the server can resolve screenshot paths. */
  slug?: string | null
  /** Prefilled parent ticket (e.g. the crawled ticket's own ClickUp URL). */
  defaultParent?: string
  /** What one item is called in copy — "issue" or "finding". */
  noun?: string
  showEvidence?: boolean
  inputId?: string
  className?: string
}) {
  const [parentTask, setParentTask] = useState(defaultParent)
  const [created, setCreated] = useState<CreatedFiledTask[]>([])
  // Once the engineer types in the field it is theirs; a changing default (they
  // picked a different ticket upstream) must not overwrite what they pasted.
  const edited = useRef(false)
  useEffect(() => {
    if (!edited.current) setParentTask(defaultParent)
  }, [defaultParent])

  // What filing under this parent will inherit. Read-only and shown BEFORE the button.
  // Debounced because the field is typed/pasted a character at a time.
  const parentRef = useDebounced(parentTask.trim(), 500)
  const filing = useQuery({
    queryKey: ['clickup-filing-context', projectId, parentRef],
    queryFn: () => clickupIssueFilingContext(parentRef, projectId),
    enabled: parentRef.length >= 6,
    retry: false,
    staleTime: 60_000,
  })

  const mutation = useMutation({
    mutationFn: () =>
      createClickupIssueSubtasks({
        parentTask: parentTask.trim(),
        projectId,
        slug,
        issues: items.map((item) => ({
          title: item.title,
          description: item.description,
          // Sets the bug's ClickUp priority (the parent's is the fallback).
          severity: item.severity,
          screenshots: item.screenshots,
        })),
      }),
    onSuccess: (result) => {
      setCreated((prev) => [...result.created, ...prev])
      // Say what landed on the cards, not just that they were created — the whole
      // point of the automation is the fields, so a silent success hides its own work.
      const shots = result.created.reduce((n, t) => n + (t.applied?.screenshots ?? 0), 0)
      const missed = result.created.reduce((n, t) => n + (t.applied?.screenshotsFailed ?? 0), 0)
      const who = result.created[0]?.applied?.assignees ?? []
      const parts = [who.length ? `assigned to ${who.join(', ')}` : 'unassigned (parent has no assignee)']
      if (showEvidence || shots || missed) {
        parts.push(`${shots} screenshot${shots === 1 ? '' : 's'} attached`)
      }
      if (missed) {
        const why = screenshotErrorSentence(
          result.created.find((t) => t.applied?.screenshotsError)?.applied?.screenshotsError,
        )
        parts.push(why ? `${missed} could not be attached — ${why}` : `${missed} could not be attached`)
      }
      toast.success(
        `Created ${result.created.length} ClickUp subtask${result.created.length === 1 ? '' : 's'}`,
        { description: parts.join(' · ') },
      )
    },
    onError: (err) => {
      toast.error('Could not create ClickUp subtasks', {
        description: errorSentence(err, 'ClickUp request failed.'),
      })
    },
  })

  return (
    <div className={cn('space-y-2.5 rounded-2xl border border-border/60 bg-muted/40 p-3.5', className)}>
      <label
        htmlFor={inputId}
        className="flex items-center gap-1.5 text-xs font-semibold text-foreground"
      >
        <Link2 className="size-3.5 text-muted-foreground" />
        Parent ClickUp ticket
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          value={parentTask}
          onChange={(event) => {
            edited.current = true
            setParentTask(event.target.value)
          }}
          placeholder="https://app.clickup.com/t/86eut664j"
          className="h-10 flex-1 shadow-none"
        />
        <Button
          onClick={() => mutation.mutate()}
          disabled={!parentTask.trim() || items.length === 0 || mutation.isPending}
          className="h-10 shrink-0 rounded-full transition-all duration-200 active:scale-[0.98] sm:min-w-44"
        >
          {mutation.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          Create{items.length > 0 ? ` ${items.length}` : ''} subtask
          {items.length === 1 ? '' : 's'}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {items.length === 0
          ? `Select at least one ${noun} to file.`
          : `Each selected ${noun} becomes a subtask inside that ticket.`}
      </p>

      {/* What the subtasks will inherit, resolved from the parent ticket itself. */}
      <FilingPreview
        state={
          parentTask.trim().length < 6
            ? { kind: 'idle' }
            : filing.isPending
              ? { kind: 'loading' }
              : filing.isError
                ? { kind: 'error', message: errorSentence(filing.error, 'Could not read that ticket.') }
                : filing.data
                  ? { kind: 'ready', context: filing.data }
                  : { kind: 'idle' }
        }
        items={items}
        noun={noun}
        showEvidence={showEvidence}
      />

      {created.length > 0 && <CreatedTasks created={created} />}
    </div>
  )
}

/** The cards this bar produced — kept on screen after the toast has gone. */
function CreatedTasks({ created }: { created: CreatedFiledTask[] }) {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
        <CheckCircle2 className="size-3.5" />
        Created {created.length} subtask{created.length === 1 ? '' : 's'}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {created.map((task) => (
          <a
            key={task.id}
            href={task.url}
            target="_blank"
            rel="noreferrer"
            title={appliedSummary(task.applied)}
            className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-background px-2 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-100"
          >
            {task.displayId}
            {/* What actually landed on the card, per subtask — the toast is a
                summary and disappears; this stays while the panel is open. */}
            {task.applied && (
              <span className="font-normal text-emerald-700/70">
                {task.applied.priority ? ` · ${task.applied.priority}` : ''}
                {task.applied.assignees.length
                  ? ` · ${task.applied.assignees[0]}${task.applied.assignees.length > 1 ? ` +${task.applied.assignees.length - 1}` : ''}`
                  : ' · unassigned'}
                {task.applied.screenshots ? ` · ${task.applied.screenshots} 🖼` : ''}
                {task.applied.screenshotsFailed ? ` · ${task.applied.screenshotsFailed} ⚠️` : ''}
              </span>
            )}
            <ArrowUpRight className="size-3" />
          </a>
        ))}
      </div>
    </div>
  )
}
