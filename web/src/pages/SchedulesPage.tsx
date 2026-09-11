import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { NavLink } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  AlarmClock,
  ArrowRight,
  CalendarClock,
  ChevronDown,
  CircleSlash,
  Clock,
  Copy,
  Filter,
  Loader2,
  MessagesSquare,
  Pause,
  Pencil,
  Play,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useProjects } from '@/lib/project-context'
import ScheduleDialog from '@/components/ScheduleDialog'
import { formatWhen, type ScheduleDraftInput } from '@/lib/schedule'
import {
  cancelSchedule,
  deleteSchedule,
  listScheduleRuns,
  listSchedules,
  runScheduleNow,
  updateSchedule,
} from '@/lib/api'
import type { Schedule, ScheduleRun } from '@/lib/types'

/**
 * `/scheduled` — every task this project runs on its own.
 *
 * The page is deliberately shaped like the composer it sits next to: one box you type a
 * sentence into ("every weekday at 9am, summarise new tickets"), because that is how the
 * `/scheduled` command in chat works too and the two must not be different products. The
 * sentence is parsed SERVER-SIDE and comes back as a draft in the confirmation dialog —
 * nothing is ever stored from typing alone.
 *
 * A task is a chat turn nobody had to be present for: same project folder, same tools, same
 * models. So the card shows the three things a chat turn's footer shows — when it last ran,
 * what it answered, what it cost — and its history is the transcript.
 */

/**
 * Sentences worth stealing — what a good scheduled task actually sounds like.
 *
 * They are EXAMPLES, not buttons that create anything: a task is only ever created from the
 * chat composer's `/scheduled` command, so clicking one copies the sentence for pasting
 * there. (They used to be click-to-create templates; that was a second creation path, and
 * two of them is how the composer's tasks and the page's tasks end up made on different
 * terms.)
 */
const EXAMPLES: { icon: string; title: string; sentence: string }[] = [
  {
    icon: '🗞️',
    title: 'Daily ticket brief',
    sentence:
      'every weekday at 9am, summarise the tickets crawled since yesterday — what changed, which have no test cases yet, and which look risky enough to test first',
  },
  {
    icon: '🧪',
    title: 'Test-case coverage check',
    sentence:
      'every Monday at 9am, compare testing/tickets against testing/testcases and list every acceptance criterion with no matching test case',
  },
  {
    icon: '🐞',
    title: 'Open defect digest',
    sentence:
      'every Friday at 5pm, read the latest run reports under testing/test-result and list the defects still open, calling out anything that has recurred',
  },
  {
    icon: '📋',
    title: 'Weekly QC status',
    sentence:
      'every Friday at 4pm, write this week’s QC status: tickets tested, pass rate, what is blocked, and the two things most worth doing next week',
  },
]

function statusTone(s: Schedule): { label: string; className: string; icon: typeof Clock } {
  if (s.running) return { label: 'Running', className: 'text-sky-600 dark:text-sky-400', icon: Loader2 }
  if (!s.enabled) return { label: 'Paused', className: 'text-muted-foreground', icon: Pause }
  if (s.lastStatus === 'error') {
    return { label: 'Last run failed', className: 'text-destructive', icon: TriangleAlert }
  }
  if (s.lastStatus === 'ok') {
    return { label: 'Active', className: 'text-emerald-600 dark:text-emerald-400', icon: Clock }
  }
  return { label: 'Active', className: 'text-emerald-600 dark:text-emerald-400', icon: Clock }
}

function money(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : ''
}

/** One past run, expanded under its task. The answer is the point — it renders as Markdown. */
function RunRow({ run }: { run: ScheduleRun }) {
  const [open, setOpen] = useState(false)
  const failed = run.status === 'error'
  return (
    <div className="rounded-2xl border border-border/60 bg-background">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        <span
          className={cn(
            'inline-flex size-1.5 shrink-0 rounded-full',
            run.status === 'running'
              ? 'bg-sky-500'
              : failed
                ? 'bg-destructive'
                : 'bg-emerald-500',
          )}
        />
        <span className="font-medium">{formatWhen(run.startedAt)}</span>
        {run.trigger === 'manual' && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            run now
          </span>
        )}
        <span className="truncate text-muted-foreground">
          {run.status === 'running'
            ? 'working…'
            : failed
              ? (run.error ?? 'failed')
              : run.answer.split('\n')[0]}
        </span>
        <span className="ml-auto flex items-center gap-2 text-muted-foreground">
          {money(run.costUsd)}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 text-sm">
          {failed ? (
            <p className="text-destructive">{run.error}</p>
          ) : run.answer ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.answer}</ReactMarkdown>
            </div>
          ) : (
            <p className="text-muted-foreground">Still working…</p>
          )}
        </div>
      )}
    </div>
  )
}

function ScheduleCard({
  schedule,
  onEdit,
  onDelete,
}: {
  schedule: Schedule
  onEdit: (s: Schedule) => void
  onDelete: (s: Schedule) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const tone = statusTone(schedule)

  const runs = useQuery({
    queryKey: ['schedule-runs', schedule.id],
    queryFn: () => listScheduleRuns(schedule.id),
    enabled: open,
    // While something is working the history is live — poll it, but only while it is on
    // screen and only while there IS something to watch.
    refetchInterval: schedule.running ? 4000 : false,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['schedules', schedule.projectId] })
    queryClient.invalidateQueries({ queryKey: ['schedule-runs', schedule.id] })
  }

  const toggle = useMutation({
    mutationFn: () => updateSchedule(schedule.id, { enabled: !schedule.enabled }),
    onSuccess: (r) => {
      invalidate()
      toast.success(r.schedule.enabled ? 'Task resumed' : 'Task paused', {
        description: r.schedule.enabled
          ? `Next run ${formatWhen(r.schedule.nextRunAt)}`
          : 'It will not run until you resume it.',
      })
    },
    onError: (e: Error) => toast.error('Could not change the task', { description: e.message }),
  })

  const runNow = useMutation({
    mutationFn: () => runScheduleNow(schedule.id),
    onSuccess: () => {
      invalidate()
      setOpen(true)
      toast.success('Running now', { description: 'Its next scheduled run is unchanged.' })
    },
    onError: (e: Error) => toast.error('Could not start the task', { description: e.message }),
  })

  const stop = useMutation({
    mutationFn: () => cancelSchedule(schedule.id),
    onSuccess: () => {
      invalidate()
      toast.success('Stopped')
    },
    onError: (e: Error) => toast.error('Could not stop the task', { description: e.message }),
  })

  return (
    <Card
      className={cn(
        'rounded-3xl border-border/60 shadow-none transition-all duration-200 hover:border-border',
        !schedule.enabled && 'opacity-70',
      )}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <AlarmClock className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold tracking-tight">{schedule.title}</h3>
              <span className={cn('inline-flex items-center gap-1 text-xs', tone.className)}>
                <tone.icon className={cn('size-3.5', schedule.running && 'animate-spin')} />
                {tone.label}
              </span>
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">{schedule.description}</p>
            <p className="mt-1 line-clamp-2 text-sm">{schedule.prompt}</p>
          </div>
          <div className="flex items-center gap-1">
            {schedule.running ? (
              <Button variant="ghost" size="sm" onClick={() => stop.mutate()} title="Stop this run">
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => runNow.mutate()}
                disabled={runNow.isPending}
                title="Run it now — the schedule is unchanged"
              >
                {runNow.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Play className="size-4" />
                )}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => toggle.mutate()}
              title={schedule.enabled ? 'Pause' : 'Resume'}
            >
              {schedule.enabled ? <Pause className="size-4" /> : <Play className="size-4" />}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onEdit(schedule)} title="Edit">
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onDelete(schedule)}
              title="Delete"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <CalendarClock className="size-3.5" />
            {schedule.enabled ? `Next ${formatWhen(schedule.nextRunAt)}` : 'Paused'}
          </span>
          {schedule.lastRunAt && <span>Last {formatWhen(schedule.lastRunAt)}</span>}
          <span>
            {schedule.runCount} run{schedule.runCount === 1 ? '' : 's'}
          </span>
          <span className="rounded-full bg-muted px-2 py-0.5">{schedule.mode}</span>
          <span className="rounded-full bg-muted px-2 py-0.5">{schedule.model}</span>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
          >
            History
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>

        {open && (
          <div className="space-y-2">
            {runs.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading…</p>
            ) : runs.data?.runs.length ? (
              runs.data.runs.map((r) => <RunRow key={r.id} run={r} />)
            ) : (
              <p className="text-xs text-muted-foreground">
                It hasn’t run yet. “Run now” tries it without touching the schedule.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type FilterMode = 'active' | 'paused' | 'all'

export default function SchedulesPage() {
  const { activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<FilterMode>('active')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<ScheduleDraftInput | null>(null)
  /** Bumped with every new draft so the dialog remounts and re-seeds its fields. */
  const [draftKey, setDraftKey] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<Schedule | null>(null)

  const schedulesQuery = useQuery({
    queryKey: ['schedules', activeProjectId],
    queryFn: () => listSchedules(activeProjectId!),
    enabled: !!activeProjectId,
    // A task can start and finish while this page is open, and it fires from the server —
    // there is nothing to subscribe to, so the list refreshes on a slow interval.
    refetchInterval: 15_000,
  })
  const schedules = useMemo(() => schedulesQuery.data?.schedules ?? [], [schedulesQuery.data])

  const shown = useMemo(() => {
    if (filter === 'all') return schedules
    return schedules.filter((s) => (filter === 'active' ? s.enabled : !s.enabled))
  }, [schedules, filter])

  /**
   * The dialog is for EDITING only. Creating a task happens in the chat composer
   * (`/scheduled`), which is the one place a sentence is turned into a schedule — see
   * docs/architecture/scheduled.md.
   */
  const openDraft = (d: ScheduleDraftInput) => {
    setDraft(d)
    setDraftKey((k) => k + 1)
    setDialogOpen(true)
  }

  const remove = useMutation({
    mutationFn: (id: string) => deleteSchedule(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['schedules', activeProjectId] })
      setConfirmDelete(null)
      toast.success('Scheduled task deleted')
    },
    onError: (e: Error) => toast.error('Could not delete the task', { description: e.message }),
  })

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <AlarmClock className="size-5" />
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">Scheduled</h1>
        </header>
        <Card className="rounded-3xl border-border/60 shadow-none">
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
            <span className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/50 text-muted-foreground">
              <CircleSlash className="size-5" />
            </span>
            <p className="text-sm text-muted-foreground">
              Select a project in the sidebar — a scheduled task runs inside one project’s folder.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <AlarmClock className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-3xl font-semibold tracking-tight">Scheduled</h1>
          <p className="text-sm text-muted-foreground">
            Ask Claude to run a task on its own — a morning brief, a nightly check, a Friday
            report. It runs in this project’s folder whether or not the portal is open on screen.
          </p>
        </div>
        <div className="inline-flex items-center gap-1 rounded-full border border-border/60 p-1">
          <Filter className="ml-2 size-3.5 text-muted-foreground" />
          {(['active', 'paused', 'all'] as FilterMode[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-full px-3 py-1 text-xs capitalize transition-all duration-200',
                filter === f ? 'bg-foreground text-background' : 'hover:bg-muted',
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      {/* How a task gets made. Not a box on this page: the sentence is typed in the chat
          composer (`/scheduled`), which is the only creation path — see scheduled.md. This
          strip is the signpost to it, and it stays visible even when tasks exist, because
          "where do I add another one?" is the question this page otherwise leaves open. */}
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <MessagesSquare className="size-4" />
          </span>
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Tasks are created in <span className="font-medium text-foreground">Chat</span>: type{' '}
            <code className="rounded bg-muted px-1 font-mono text-foreground">/</code>, pick{' '}
            <code className="rounded bg-muted px-1 font-mono text-foreground">scheduled</code>, then
            say when and what — “every weekday at 9am, summarise new tickets”. You confirm it before
            it runs.
          </p>
          <Button asChild size="sm" className="rounded-full">
            <NavLink to="/chat">
              Open Chat
              <ArrowRight className="size-4" />
            </NavLink>
          </Button>
        </CardContent>
      </Card>

      {/* Examples — what a good scheduled prompt sounds like. Copying one is all they do;
          nothing here creates a task. Hidden once the project has tasks of its own. */}
      {schedules.length === 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4" /> Sentences worth stealing
          </h2>
          <div className="space-y-1">
            {EXAMPLES.map((t) => (
              <button
                key={t.title}
                type="button"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(t.sentence)
                    .then(() =>
                      toast.success('Copied', {
                        description: 'Paste it in Chat after picking /scheduled.',
                      }),
                    )
                    .catch(() =>
                      toast.error('Could not copy', { description: 'Select the text instead.' }),
                    )
                }}
                title="Copy this sentence"
                className="flex w-full items-center gap-3 rounded-2xl border border-transparent px-3 py-2.5 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border/60 hover:bg-muted/50"
              >
                <span className="text-lg">{t.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{t.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{t.sentence}</span>
                </span>
                <Copy className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
          </div>
        </section>
      )}

      {schedulesQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : shown.length ? (
        <div className="space-y-3">
          {shown.map((s) => (
            <ScheduleCard
              key={s.id}
              schedule={s}
              onEdit={(sched) =>
                openDraft({
                  id: sched.id,
                  title: sched.title,
                  prompt: sched.prompt,
                  cron: sched.cron,
                  mode: sched.mode,
                  model: sched.model,
                  effort: sched.effort,
                })
              }
              onDelete={setConfirmDelete}
            />
          ))}
        </div>
      ) : schedules.length ? (
        <p className="text-sm text-muted-foreground">
          No {filter} tasks. Switch the filter to see the other {schedules.length}.
        </p>
      ) : null}

      <ScheduleDialog
        key={draftKey}
        open={dialogOpen}
        onOpenChange={(v) => {
          setDialogOpen(v)
          if (!v) setDraft(null)
        }}
        projectId={activeProjectId}
        draft={draft}
      />

      <Dialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete “{confirmDelete?.title}”?</DialogTitle>
            <DialogDescription>
              It stops running and its history goes with it. Pausing keeps both.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete.id)}
            >
              {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
