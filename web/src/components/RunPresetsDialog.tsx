import { useMemo, useState } from 'react'
import {
  Bookmark,
  Boxes,
  Check,
  Cpu,
  Globe,
  Layers,
  ListOrdered,
  Pencil,
  Play,
  Save,
  Search,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { RunPreset } from '@/lib/presets'
import { cn } from '@/lib/utils'

/**
 * Saved run configurations. Two things this dialog has to make obvious, because
 * both were previously only in prose nobody reads twice:
 *   1. WHAT a save captures — shown as the same chips the saved rows wear, so
 *      the preview and the result are visibly the same object.
 *   2. That a single-ticket template deliberately does NOT store the ticket id.
 */

/** The values currently in the run form — offered as "save current". */
export interface PresetDraft {
  mode: 'simple' | 'advanced'
  appUrl: string
  skill: string
  instructions: string
  model: string
  /** E2E flow only — the flow's title, which the run's report is filed under. */
  flowName: string
  workflowSteps: string[] // E2E flow only — already trimmed of empties
  /** Each step's kind, positionally alongside `workflowSteps`. */
  workflowKinds: string[]
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: RunPreset[]
  current: PresetDraft
  addPreset: (preset: Omit<RunPreset, 'id'>) => boolean
  renamePreset: (id: string, name: string) => void
  removePreset: (id: string) => void
  onApply: (preset: RunPreset) => void
}

/** One fact about a template — the same chip in the preview and on a saved row. */
function Chip({
  icon: Icon,
  children,
  className,
  mono,
}: {
  icon: typeof Cpu
  children: React.ReactNode
  className?: string
  mono?: boolean
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-3 shrink-0" />
      <span className={cn('truncate', mono && 'font-mono')}>{children}</span>
    </span>
  )
}

/** The mode a template runs in, as a badge. */
function ModeBadge({ advanced, className }: { advanced: boolean; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        advanced
          ? 'bg-foreground text-background'
          : 'border border-border/60 bg-muted/60 text-muted-foreground',
        className,
      )}
    >
      {advanced ? <Workflow className="size-3" /> : <Sparkles className="size-3" />}
      {advanced ? 'E2E flow' : 'Single ticket'}
    </span>
  )
}

/** The chips describing a template's contents — shared by preview and rows. */
function PresetFacts({
  advanced,
  model,
  skill,
  appUrl,
  steps,
  tickets,
}: {
  advanced: boolean
  model?: string
  skill?: string
  appUrl?: string
  steps?: number
  tickets?: number
}) {
  const facts = [
    model && model !== 'auto' ? (
      <Chip key="model" icon={Cpu}>
        <span className="capitalize">{model}</span>
      </Chip>
    ) : null,
    advanced && steps ? (
      <Chip key="steps" icon={ListOrdered}>
        {steps} step{steps === 1 ? '' : 's'}
      </Chip>
    ) : null,
    appUrl ? (
      <Chip key="url" icon={Globe} mono>
        {appUrl}
      </Chip>
    ) : null,
    skill ? (
      <Chip key="skill" icon={Boxes} mono>
        {skill}
      </Chip>
    ) : null,
    // Only ever present on templates saved before E2E flows dropped tickets.
    tickets ? (
      <Chip key="tickets" icon={Layers}>
        {tickets} ticket{tickets === 1 ? '' : 's'} · legacy
      </Chip>
    ) : null,
  ].filter(Boolean)

  if (facts.length === 0) return null
  return <div className="flex min-w-0 flex-wrap items-center gap-1">{facts}</div>
}

export function RunPresetsDialog({
  open,
  onOpenChange,
  presets,
  current,
  addPreset,
  renamePreset,
  removePreset,
  onApply,
}: Props) {
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  // Renaming is an explicit mode: a row that is always an <input> reads as a
  // form to fill in, when 99% of the time the row is something you load.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const advanced = current.mode === 'advanced'
  const stepCount = advanced ? current.workflowSteps.length : 0
  const hasCurrent = advanced
    ? stepCount > 0 || !!current.appUrl.trim() || !!current.instructions.trim()
    : !!current.appUrl.trim() || !!current.instructions.trim() || !!current.skill
  // An E2E flow already HAS a name on the canvas, and it's the one the run files
  // its report under — so leaving the field blank saves under that rather than
  // making the engineer type the same words twice. The placeholder shows it.
  const fallbackName = advanced ? current.flowName.trim() : ''
  const finalName = name.trim() || fallbackName
  const canSave = finalName.length > 0 && hasCurrent

  const q = query.trim().toLowerCase()
  const shown = useMemo(
    () =>
      q
        ? presets.filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              (p.appUrl ?? '').toLowerCase().includes(q) ||
              (p.instructions ?? '').toLowerCase().includes(q),
          )
        : presets,
    [presets, q],
  )

  function onSave() {
    if (!canSave) return
    const ok = addPreset({
      name: finalName,
      appUrl: current.appUrl,
      skill: current.skill,
      instructions: current.instructions,
      mode: current.mode,
      model: current.model,
      flowName: advanced ? current.flowName : undefined,
      workflowSteps: advanced ? current.workflowSteps : undefined,
      workflowKinds: advanced ? current.workflowKinds : undefined,
    })
    if (ok) setName('')
  }

  function close() {
    setEditingId(null)
    setConfirmDeleteId(null)
    setQuery('')
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
        else onOpenChange(true)
      }}
    >
      <DialogContent className="gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-2xl bg-foreground text-background">
              <Bookmark className="size-4" />
            </span>
            <span className="min-w-0">
              Run templates
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 align-middle text-[11px] font-medium tabular-nums text-muted-foreground">
                {presets.length}
              </span>
            </span>
          </DialogTitle>
          <DialogDescription>
            Save the run form as you have it now, then load it back another day. Stored on this
            device only — nothing leaves your machine.
          </DialogDescription>
        </DialogHeader>

        {/* ── Save the current form ─────────────────────────────────────── */}
        <div className="space-y-2.5 rounded-2xl border border-dashed border-border/60 bg-muted/40 p-3.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="preset-name" className="text-xs font-medium">
              Save the current form
            </Label>
            <ModeBadge advanced={advanced} />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!hasCurrent}
              placeholder={
                fallbackName
                  ? `${fallbackName} — the flow’s name`
                  : advanced
                    ? 'Name it — e.g. Signup → invite flow'
                    : 'Name it — e.g. Smoke test · staging'
              }
              className="h-9 rounded-full shadow-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault()
                  onSave()
                }
              }}
            />
            <Button
              type="button"
              onClick={onSave}
              disabled={!canSave}
              className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              <Save className="size-4" />
              Save template
            </Button>
          </div>

          {!hasCurrent ? (
            <p className="text-xs text-muted-foreground">
              Fill in the form first — there’s nothing to save yet.
            </p>
          ) : (
            <div className="space-y-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Captures
              </p>
              <PresetFacts
                advanced={advanced}
                model={current.model}
                skill={current.skill}
                appUrl={current.appUrl}
                steps={stepCount}
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {advanced
                  ? 'The flow’s name, its steps in order and each step’s URL — an E2E flow has no ticket.'
                  : 'Everything except the ticket id, which changes every run and is left for you to type.'}
              </p>
            </div>
          )}
        </div>

        {/* ── Saved templates ───────────────────────────────────────────── */}
        <div className="space-y-2">
          {presets.length > 3 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search templates…"
                aria-label="Search templates"
                className="h-9 rounded-full pl-8 text-sm shadow-none"
              />
            </div>
          )}

          <ScrollArea className="-mx-1 max-h-[42vh] px-1">
            <div className="space-y-2 pb-1">
              {presets.length === 0 ? (
                <div className="flex flex-col items-center gap-1.5 rounded-2xl border border-dashed border-border/60 bg-muted/30 px-3 py-8 text-center">
                  <span className="grid size-10 place-items-center rounded-2xl bg-muted text-muted-foreground">
                    <Bookmark className="size-4" />
                  </span>
                  <p className="text-sm font-medium">No templates yet</p>
                  <p className="max-w-[24rem] text-xs leading-relaxed text-muted-foreground">
                    Set the form up the way you run it, name it above, and it lands here ready to
                    load next time.
                  </p>
                </div>
              ) : shown.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-border/60 bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                  No template matches “{query}”.
                </p>
              ) : (
                shown.map((p) => {
                  const isFlow = p.mode === 'advanced'
                  const editing = editingId === p.id
                  const confirming = confirmDeleteId === p.id
                  return (
                    <div
                      key={p.id}
                      className={cn(
                        'space-y-2 rounded-2xl border bg-card p-3 transition-all duration-200',
                        confirming
                          ? 'border-destructive/50 bg-destructive/5'
                          : 'border-border/60 shadow-none hover:-translate-y-0.5 hover:border-border hover:shadow-sm',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        {editing ? (
                          <>
                            <Input
                              autoFocus
                              aria-label="Template name"
                              value={p.name}
                              onChange={(e) => renamePreset(p.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === 'Escape') {
                                  e.preventDefault()
                                  setEditingId(null)
                                }
                              }}
                              className="h-8 rounded-xl font-medium shadow-none"
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditingId(null)}
                              aria-label="Done renaming"
                              className="size-8 shrink-0 rounded-full"
                            >
                              <Check className="size-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <ModeBadge advanced={isFlow} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">
                              {p.name}
                            </span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                setConfirmDeleteId(null)
                                setEditingId(p.id)
                              }}
                              aria-label={`Rename ${p.name}`}
                              className="size-8 shrink-0 rounded-full text-muted-foreground"
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                onApply(p)
                                close()
                              }}
                              className="shrink-0 gap-1.5 rounded-full transition-all duration-200 active:scale-[0.98]"
                            >
                              <Play className="size-3.5" />
                              Load
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setConfirmDeleteId(p.id)}
                              aria-label={`Delete ${p.name}`}
                              className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-destructive"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        )}
                      </div>

                      <PresetFacts
                        advanced={isFlow}
                        model={p.model}
                        skill={p.skill}
                        appUrl={p.appUrl}
                        steps={p.workflowSteps?.length}
                        tickets={p.tickets?.length}
                      />

                      {p.instructions && (
                        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground/80">
                          {p.instructions}
                        </p>
                      )}

                      {/* Deleting a template can't be undone (it's the only copy),
                          so it confirms in place rather than vanishing on a stray click. */}
                      {confirming && (
                        <div className="flex flex-wrap items-center gap-2 border-t border-destructive/30 pt-2">
                          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                            Delete <span className="font-medium text-foreground">{p.name}</span>?
                            This can’t be undone.
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmDeleteId(null)}
                            className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs"
                          >
                            <X className="size-3.5" />
                            Keep
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              removePreset(p.id)
                              setConfirmDeleteId(null)
                            }}
                            className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-xs"
                          >
                            <Trash2 className="size-3.5" />
                            Delete
                          </Button>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="secondary"
            onClick={close}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
