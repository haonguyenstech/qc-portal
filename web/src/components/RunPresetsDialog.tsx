import { useState } from 'react'
import {
  Bookmark,
  Boxes,
  Cpu,
  Globe,
  Layers,
  ListOrdered,
  Save,
  Sparkles,
  Trash2,
  Workflow,
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

/** The values currently in the run form — offered as "save current". */
export interface PresetDraft {
  mode: 'simple' | 'advanced'
  appUrl: string
  skill: string
  instructions: string
  model: string
  tickets: string[] // advanced only — first is the lead ticket
  workflowSteps: string[] // advanced only — already trimmed of empties
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

  const advanced = current.mode === 'advanced'
  const hasCurrent = advanced
    ? current.tickets.length > 0 ||
      current.workflowSteps.length > 0 ||
      !!current.appUrl.trim() ||
      !!current.instructions.trim()
    : !!current.appUrl.trim() || !!current.instructions.trim() || !!current.skill
  const canSave = name.trim().length > 0 && hasCurrent

  function onSave() {
    const ok = addPreset({
      name,
      appUrl: current.appUrl,
      skill: current.skill,
      instructions: current.instructions,
      mode: current.mode,
      model: current.model,
      tickets: advanced ? current.tickets : undefined,
      workflowSteps: advanced ? current.workflowSteps : undefined,
    })
    if (ok) setName('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <Bookmark className="size-4" />
            </span>
            Run templates
          </DialogTitle>
          <DialogDescription>
            Save the current form as a reusable template, then load it later and run again. Feature
            (advanced) templates also remember the ticket set and workflow; single-ticket templates
            never save the ticket id. Stored on this device.
          </DialogDescription>
        </DialogHeader>

        {/* save current */}
        <div className="space-y-2 rounded-lg border border-dashed bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="preset-name" className="text-xs font-medium text-muted-foreground">
              Save current form as template
            </Label>
            <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {advanced ? <Workflow className="size-3" /> : <Sparkles className="size-3" />}
              {advanced ? 'Feature' : 'Single ticket'}
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="preset-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={
                advanced ? 'Template name (e.g. Signup → invite flow)' : 'Template name (e.g. Smoke test · staging)'
              }
              className="h-9"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSave) {
                  e.preventDefault()
                  onSave()
                }
              }}
            />
            <Button type="button" onClick={onSave} disabled={!canSave} className="shrink-0">
              <Save className="size-4" />
              Save
            </Button>
          </div>
          {advanced && current.tickets.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Captures {current.tickets.length} ticket{current.tickets.length === 1 ? '' : 's'}
              {current.workflowSteps.length > 0 &&
                ` · ${current.workflowSteps.length} workflow step${current.workflowSteps.length === 1 ? '' : 's'}`}
              .
            </p>
          )}
          {!hasCurrent && (
            <p className="text-xs text-muted-foreground">
              Fill in the form first — there's nothing to save yet.
            </p>
          )}
        </div>

        <ScrollArea className="-mx-1 max-h-[45vh] px-1">
          <div className="space-y-2 pb-1">
            {presets.length === 0 ? (
              <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                No templates yet.
              </p>
            ) : (
              presets.map((p) => {
                const isFeature = p.mode === 'advanced'
                return (
                  <div key={p.id} className="space-y-2 rounded-lg border bg-card p-3 shadow-xs">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          'grid size-7 shrink-0 place-items-center rounded-md ' +
                          (isFeature
                            ? 'bg-primary/10 text-primary'
                            : 'bg-muted text-muted-foreground')
                        }
                        aria-hidden
                      >
                        {isFeature ? (
                          <Workflow className="size-3.5" />
                        ) : (
                          <Sparkles className="size-3.5" />
                        )}
                      </span>
                      <Input
                        aria-label="Template name"
                        value={p.name}
                        onChange={(e) => renamePreset(p.id, e.target.value)}
                        className="h-8 font-medium"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          onApply(p)
                          onOpenChange(false)
                        }}
                        className="shrink-0"
                      >
                        Load
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => removePreset(p.id)}
                        aria-label={`Delete ${p.name}`}
                        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      {p.model && p.model !== 'auto' && (
                        <span className="inline-flex items-center gap-1">
                          <Cpu className="size-3" />
                          <span className="capitalize">{p.model}</span>
                        </span>
                      )}
                      {p.skill && (
                        <span className="inline-flex items-center gap-1">
                          <Boxes className="size-3" />
                          <span className="font-mono">{p.skill}</span>
                        </span>
                      )}
                      {isFeature && p.tickets && p.tickets.length > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Layers className="size-3" />
                          {p.tickets.length} ticket{p.tickets.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {isFeature && p.workflowSteps && p.workflowSteps.length > 0 && (
                        <span className="inline-flex items-center gap-1">
                          <ListOrdered className="size-3" />
                          {p.workflowSteps.length} step{p.workflowSteps.length === 1 ? '' : 's'}
                        </span>
                      )}
                      {p.appUrl && (
                        <span className="inline-flex items-center gap-1 truncate">
                          <Globe className="size-3" />
                          <span className="truncate font-mono">{p.appUrl}</span>
                        </span>
                      )}
                    </div>
                    {isFeature && p.tickets && p.tickets.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {p.tickets.map((t, i) => (
                          <span
                            key={t}
                            className="inline-flex items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {i === 0 && (
                              <span className="font-semibold uppercase tracking-wide text-primary">
                                lead
                              </span>
                            )}
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                    {p.instructions && (
                      <p className="line-clamp-2 text-xs text-muted-foreground/80">
                        {p.instructions}
                      </p>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
