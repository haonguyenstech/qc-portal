import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Check, Loader2, Plus, Settings2, Wand2, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ManageRulesDialog } from '@/components/ManageRulesDialog'
import { buildDiagramInstructions, useDiagramRules } from '@/lib/diagramRules'
import { createDiagram, diagramFromSources, type Diagram } from '@/lib/api'

/** A toggleable preset chip; hover shows the full instruction it adds. */
function RuleChip({
  label,
  hint,
  selected,
  onToggle,
}: {
  label: string
  hint: string
  selected: boolean
  onToggle: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-all duration-200 active:scale-[0.97]',
            selected
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground',
          )}
        >
          {selected ? <Check className="size-3" /> : <Plus className="size-3" />}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-none whitespace-nowrap">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

export interface DiagramSources {
  team: string
  docs: { id: string; name: string }[]
  tickets: { id: string; displayId: string; name: string }[]
}

/**
 * Generate a Mermaid diagram from the selected ClickUp sources, with custom AI
 * instructions + reusable presets, then save it as a NAMED diagram on the project.
 * Two-step: Generate produces an in-dialog preview, Save persists it.
 */
export function GenerateDiagramDialog({
  open,
  onOpenChange,
  sources,
  projectId,
  projectName,
  defaultName,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: DiagramSources
  projectId: string
  projectName: string
  defaultName: string
  onCreated: (diagram: Diagram) => void
}) {
  const { rules, addRule, updateRule, removeRule, resetRules } = useDiagramRules()
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [instructions, setInstructions] = useState('')
  const [name, setName] = useState(defaultName)
  const [managing, setManaging] = useState(false)

  // Re-seed the name field whenever the dialog (re)opens — stamp it with the
  // current date+time so each generated diagram gets a unique, sortable name.
  const [seenOpen, setSeenOpen] = useState(false)
  if (open && !seenOpen) {
    setSeenOpen(true)
    setName(`${defaultName} ${new Date().toLocaleString()}`)
  }
  if (!open && seenOpen) setSeenOpen(false)

  const sourceCount = sources.docs.length + sources.tickets.length

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // One step: generate the Mermaid from the sources, then save it as a named
  // diagram and close. No separate review/save button.
  const generate = useMutation({
    mutationFn: async () => {
      const res = await diagramFromSources({
        team: sources.team,
        docs: sources.docs,
        tickets: sources.tickets,
        projectName,
        projectId,
        instructions: buildDiagramInstructions(rules, picked, instructions),
      })
      const { diagram } = await createDiagram({
        projectId,
        name: name.trim() || 'Untitled diagram',
        content: res.mermaid,
      })
      return diagram
    },
    onSuccess: (diagram) => {
      toast.success('Diagram saved', { description: `Saved as “${diagram.name}”.` })
      onCreated(diagram)
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error('Could not generate diagram', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const busy = generate.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[64rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/60 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <span className="flex size-8 items-center justify-center rounded-xl bg-foreground text-background">
              <Workflow className="size-4" />
            </span>
            Generate diagram
          </DialogTitle>
          <DialogDescription>
            Claude reads the {sourceCount} selected source{sourceCount === 1 ? '' : 's'} and drafts a
            Mermaid diagram. Add instructions below to steer it, then save it with a name.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Diagram name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Checkout flow"
              className="h-9"
            />
          </div>

          {/* Presets */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">
                Common instructions
              </label>
              <div className="flex items-center gap-3">
                {picked.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setPicked(new Set())}
                    className="text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Clear {picked.size}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setManaging(true)}
                  className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground transition-colors hover:text-primary"
                >
                  <Settings2 className="size-3.5" />
                  Manage
                </button>
              </div>
            </div>
            {rules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border/60 bg-muted/40 px-3 py-3 text-center text-xs text-muted-foreground">
                No presets yet —{' '}
                <button
                  type="button"
                  onClick={() => setManaging(true)}
                  className="font-medium text-primary hover:underline"
                >
                  add some
                </button>
                .
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {rules.map((r) => (
                  <RuleChip
                    key={r.id}
                    label={r.label}
                    hint={r.hint}
                    selected={picked.has(r.id)}
                    onToggle={() => toggle(r.id)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Free-text instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Extra instructions <span className="font-normal">(optional)</span>
            </label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Focus on the appointment booking flow; show the admin and patient paths separately…"
              className="min-h-[80px] resize-y text-sm"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 bg-muted/60 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {sourceCount} source{sourceCount === 1 ? '' : 's'} selected
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => generate.mutate()}
            disabled={busy || sourceCount === 0 || !name.trim()}
            className="rounded-full transition-all duration-200 active:scale-[0.98]"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Generating…
              </>
            ) : (
              <>
                <Wand2 className="h-3.5 w-3.5" />
                Generate
              </>
            )}
          </Button>
        </div>
      </DialogContent>

      <ManageRulesDialog
        open={managing}
        onOpenChange={setManaging}
        rules={rules}
        addRule={addRule}
        updateRule={updateRule}
        removeRule={removeRule}
        resetRules={resetRules}
        title="Manage diagram presets"
        description="Reusable diagram instructions. The label is the chip; the instruction is what Claude is told to do. Saved on this device."
      />
    </Dialog>
  )
}
