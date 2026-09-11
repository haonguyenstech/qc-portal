import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlarmClock, CalendarClock, Loader2, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { createSchedule, previewSchedule, updateSchedule } from '@/lib/api'
import type { Schedule, ScheduleMode } from '@/lib/types'
import { formatWhen, type ScheduleDraftInput } from '@/lib/schedule'

/**
 * The one place a scheduled task is created or edited.
 *
 * **This is the EDIT form.** Creating happens in one place only — the chat composer's
 * `/scheduled` command, which parses the sentence and creates the task in one step (its
 * toast reads the schedule back and carries Undo). The Scheduled page has no create box of
 * its own: two creation paths is how tasks made from chat and tasks made from the page end
 * up made on different terms. It still supports a create call for that reason — one form,
 * whichever way a draft arrives — but nothing reaches the server until Save is pressed.
 *
 * **The browser composes the cron but never READS one.** Every "what does this mean / when
 * does it fire" answer comes from `/api/schedules/preview` (server/src/cron.ts), so the
 * sentence shown here is produced by the same parser the timer uses. The one exception is
 * `cronToBuilder`, which only has to recognise the shapes the builder itself emits — and
 * anything it doesn't recognise falls to the Custom field rather than being re-interpreted.
 */

type Frequency = 'minutes' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom'

interface BuilderState {
  frequency: Frequency
  /** Every N minutes / hours. */
  interval: number
  /** "HH:MM", the control's own format. */
  time: string
  weekdays: number[]
  dayOfMonth: number
  /** Only used when frequency is `custom`. */
  custom: string
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const MODE_OPTIONS: { value: ScheduleMode; label: string; hint: string }[] = [
  { value: 'read', label: 'Read-only', hint: 'Grep/Glob/Read — the cheap, fast task' },
  { value: 'write', label: 'Workspace write', hint: 'Can also edit files in the project' },
  { value: 'full', label: 'Full tools', hint: 'Everything, including the project’s MCP servers' },
]

const MODEL_OPTIONS = [
  { value: 'default', label: 'Terminal parity', hint: 'Whatever your Claude Code is set to' },
  { value: 'haiku', label: 'Haiku', hint: 'Cheapest' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Balanced' },
  { value: 'opus', label: 'Opus', hint: 'Most capable' },
]

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Builder state → cron. The only direction that has to be exact. */
function builderToCron(b: BuilderState): string {
  const [hRaw, mRaw] = b.time.split(':')
  const h = Math.min(Math.max(Number(hRaw) || 0, 0), 23)
  const m = Math.min(Math.max(Number(mRaw) || 0, 0), 59)
  switch (b.frequency) {
    case 'minutes':
      return `*/${Math.min(Math.max(b.interval, 1), 59)} * * * *`
    case 'hourly':
      return `${m} */${Math.min(Math.max(b.interval, 1), 23)} * * *`
    case 'weekly':
      return `${m} ${h} * * ${(b.weekdays.length ? b.weekdays : [1]).join(',')}`
    case 'monthly':
      return `${m} ${h} ${Math.min(Math.max(b.dayOfMonth, 1), 31)} * *`
    case 'custom':
      return b.custom.trim()
    case 'daily':
    default:
      return `${m} ${h} * * *`
  }
}

/**
 * Cron → builder state, for editing an existing task (or a parsed draft).
 *
 * Deliberately narrow: it recognises exactly the four shapes `builderToCron` produces.
 * Anything else — a cron someone typed by hand, a range, a list of hours — lands on
 * `custom` with the expression intact, which is always truthful. A cleverer decomposition
 * that "mostly" worked would be one that silently rewrites a schedule on save.
 */
function cronToBuilder(cron: string): BuilderState {
  const base: BuilderState = {
    frequency: 'custom',
    interval: 30,
    time: '09:00',
    weekdays: [1],
    dayOfMonth: 1,
    custom: cron.trim(),
  }
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return base
  const [mi, ho, dm, mo, dw] = parts
  if (mo !== '*') return base

  const everyMin = /^\*\/(\d{1,2})$/.exec(mi)
  if (everyMin && ho === '*' && dm === '*' && dw === '*') {
    return { ...base, frequency: 'minutes', interval: Number(everyMin[1]) }
  }
  const plainMinute = /^\d{1,2}$/.test(mi) ? Number(mi) : null
  if (plainMinute === null) return base

  const everyHour = /^\*\/(\d{1,2})$/.exec(ho)
  if (everyHour && dm === '*' && dw === '*') {
    return {
      ...base,
      frequency: 'hourly',
      interval: Number(everyHour[1]),
      time: `00:${pad(plainMinute)}`,
    }
  }
  if (!/^\d{1,2}$/.test(ho)) return base
  const time = `${pad(Number(ho))}:${pad(plainMinute)}`

  if (dm === '*' && dw === '*') return { ...base, frequency: 'daily', time }
  if (dm === '*' && /^[0-6](,[0-6])*$/.test(dw)) {
    return { ...base, frequency: 'weekly', time, weekdays: dw.split(',').map(Number) }
  }
  // `1-5` (weekdays) is common enough to be worth recognising as a weekly selection.
  const range = /^([0-6])-([0-6])$/.exec(dw)
  if (dm === '*' && range) {
    const [, a, b] = range
    const days: number[] = []
    for (let d = Number(a); d <= Number(b); d++) days.push(d)
    return { ...base, frequency: 'weekly', time, weekdays: days }
  }
  if (dw === '*' && /^\d{1,2}$/.test(dm)) {
    return { ...base, frequency: 'monthly', time, dayOfMonth: Number(dm) }
  }
  return base
}

export default function ScheduleDialog({
  open,
  onOpenChange,
  projectId,
  draft,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  projectId: string
  /** The task being proposed or edited. `id` present → edit. */
  draft: ScheduleDraftInput | null
  onSaved?: (schedule: Schedule) => void
}) {
  const queryClient = useQueryClient()
  // Seeded ONCE from the draft. The callers give this component a `key` that changes with
  // the draft, so a different task remounts it instead of being copied in by an effect —
  // an effect that re-seeded the fields would also overwrite an edit in progress the next
  // time the parent re-rendered.
  const [title, setTitle] = useState(draft?.title ?? '')
  const [prompt, setPrompt] = useState(draft?.prompt ?? '')
  const [mode, setMode] = useState<ScheduleMode>(draft?.mode ?? 'read')
  const [model, setModel] = useState(draft?.model ?? 'default')
  const [effort, setEffort] = useState(draft?.effort ?? 'medium')
  const [builder, setBuilder] = useState<BuilderState>(() =>
    cronToBuilder(draft?.cron || '0 9 * * *'),
  )

  const cron = useMemo(() => builderToCron(builder), [builder])

  // Debounced so typing in the Custom field doesn't fire a request per keystroke.
  const [debouncedCron, setDebouncedCron] = useState(cron)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedCron(cron), 300)
    return () => clearTimeout(t)
  }, [cron])

  const { data: preview, isFetching: previewing } = useQuery({
    queryKey: ['schedule-preview', debouncedCron],
    queryFn: () => previewSchedule(debouncedCron),
    enabled: open && debouncedCron.trim().length > 0,
    staleTime: 30_000,
  })

  const editing = !!draft?.id

  const save = useMutation({
    mutationFn: async () => {
      const body = { title: title.trim(), prompt: prompt.trim(), cron, mode, model, effort }
      return draft?.id
        ? (await updateSchedule(draft.id, body)).schedule
        : (await createSchedule(projectId, body)).schedule
    },
    onSuccess: (schedule) => {
      queryClient.invalidateQueries({ queryKey: ['schedules', projectId] })
      toast.success(editing ? 'Scheduled task updated' : 'Scheduled task created', {
        description: `${schedule.description} · next ${formatWhen(schedule.nextRunAt)}`,
      })
      onSaved?.(schedule)
      onOpenChange(false)
    },
    onError: (err: Error) => toast.error('Could not save the task', { description: err.message }),
  })

  const cronOk = preview?.valid !== false && cron.trim().length > 0
  const canSave = prompt.trim().length > 0 && cronOk && !save.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlarmClock className="size-4" />
            {editing ? 'Edit scheduled task' : 'Schedule a task'}
          </DialogTitle>
          <DialogDescription>
            It runs on its own, inside this project’s folder, with nobody watching — so say
            what you want done as if you were leaving a note.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-title">Title</Label>
            <Input
              id="schedule-title"
              value={title}
              placeholder="Daily ticket brief"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-prompt">What should it do?</Label>
            <Textarea
              id="schedule-prompt"
              value={prompt}
              rows={4}
              placeholder="Summarise every ticket crawled since yesterday and flag the ones with no test cases."
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {/* ---- when ---- */}
          <div className="rounded-2xl border border-border/60 bg-muted/40 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="size-4" />
              When
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={builder.frequency}
                onValueChange={(v) => setBuilder((b) => ({ ...b, frequency: v as Frequency }))}
              >
                <SelectTrigger size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Every N minutes</SelectItem>
                  <SelectItem value="hourly">Every N hours</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                  <SelectItem value="weekly">Weekly</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="custom">Custom (cron)</SelectItem>
                </SelectContent>
              </Select>

              {(builder.frequency === 'minutes' || builder.frequency === 'hourly') && (
                <Input
                  type="number"
                  min={1}
                  max={builder.frequency === 'minutes' ? 59 : 23}
                  value={builder.interval}
                  onChange={(e) =>
                    setBuilder((b) => ({ ...b, interval: Number(e.target.value) || 1 }))
                  }
                  className="h-8 w-24"
                />
              )}

              {builder.frequency !== 'minutes' && builder.frequency !== 'custom' && (
                <Input
                  type="time"
                  value={builder.time}
                  onChange={(e) => setBuilder((b) => ({ ...b, time: e.target.value }))}
                  className="h-8 w-32"
                />
              )}

              {builder.frequency === 'monthly' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  on day
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={builder.dayOfMonth}
                    onChange={(e) =>
                      setBuilder((b) => ({ ...b, dayOfMonth: Number(e.target.value) || 1 }))
                    }
                    className="h-8 w-20"
                  />
                </div>
              )}

              {builder.frequency === 'custom' && (
                <Input
                  value={builder.custom}
                  placeholder="0 9 * * 1-5"
                  onChange={(e) => setBuilder((b) => ({ ...b, custom: e.target.value }))}
                  className="h-8 w-56 font-mono"
                />
              )}
            </div>

            {builder.frequency === 'weekly' && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {WEEKDAY_LABELS.map((label, i) => {
                  const on = builder.weekdays.includes(i)
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() =>
                        setBuilder((b) => ({
                          ...b,
                          weekdays: on
                            ? b.weekdays.filter((d) => d !== i)
                            : [...b.weekdays, i].sort((a, c) => a - c),
                        }))
                      }
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs transition-all duration-200 active:scale-[0.98]',
                        on
                          ? 'border-transparent bg-foreground text-background'
                          : 'border-border/60 hover:border-border',
                      )}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            )}

            {/* The preview is the whole safety net: it is the server's own reading of the
                expression, so what it says here is what will actually fire. */}
            <div className="mt-3 text-xs">
              {previewing ? (
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> checking…
                </span>
              ) : preview?.valid === false ? (
                <span className="text-destructive">{preview.error}</span>
              ) : preview?.valid ? (
                <div className="space-y-1">
                  <div className="font-medium">{preview.description}</div>
                  <div className="text-muted-foreground">
                    Next:{' '}
                    {preview.upcoming?.length
                      ? preview.upcoming.map(formatWhen).join(' · ')
                      : 'never — no date matches this schedule'}
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground/70">{cron}</div>
                </div>
              ) : null}
            </div>
          </div>

          {/* ---- how it runs ---- */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label>Tools</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as ScheduleMode)}>
                {/* An explicit child: SelectValue otherwise mirrors the whole ITEM, and
                    each item here carries a second hint line that then spills out of the
                    trigger. Same fix the chat composer's pickers use. */}
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue>{MODE_OPTIONS.find((o) => o.value === mode)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MODE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <span className="flex flex-col items-start gap-0.5">
                        <span>{o.label}</span>
                        <span className="text-xs text-muted-foreground">{o.hint}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue>{MODEL_OPTIONS.find((o) => o.value === model)?.label}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {MODEL_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <span className="flex flex-col items-start gap-0.5">
                        <span>{o.label}</span>
                        <span className="text-xs text-muted-foreground">{o.hint}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Effort</Label>
              <Select value={effort} onValueChange={setEffort}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFORT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave}>
            {save.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            {editing ? 'Save changes' : 'Create task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
