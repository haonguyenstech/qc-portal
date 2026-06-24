import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FilePlus2, Loader2, RefreshCw, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { overviewFromSources } from '@/lib/api'
import type { DiagramSources } from '@/components/GenerateDiagramDialog'

type Mode = 'replace' | 'update'

/**
 * Draft the project overview from the selected ClickUp sources, with a choice of
 * REPLACE (fresh) or UPDATE (revise/extend the existing overview) plus optional
 * instructions. The result lands in the page editor for review before saving.
 */
export function GenerateOverviewDialog({
  open,
  onOpenChange,
  sources,
  projectId,
  projectName,
  existingOverview,
  onGenerated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sources: DiagramSources
  projectId: string
  projectName: string
  existingOverview: string
  onGenerated: (markdown: string) => void
}) {
  const hasExisting = existingOverview.trim().length > 0
  const [mode, setMode] = useState<Mode>('replace')
  const [instructions, setInstructions] = useState('')

  // Re-seed on open: default to "update" when there's an overview to extend.
  const [seenOpen, setSeenOpen] = useState(false)
  if (open && !seenOpen) {
    setSeenOpen(true)
    setMode(hasExisting ? 'update' : 'replace')
  }
  if (!open && seenOpen) setSeenOpen(false)

  const sourceCount = sources.docs.length + sources.tickets.length

  const generate = useMutation({
    mutationFn: () =>
      overviewFromSources({
        team: sources.team,
        docs: sources.docs,
        tickets: sources.tickets,
        projectName,
        projectId,
        instructions,
        mode,
        existing: existingOverview,
      }),
    onSuccess: (res) => {
      toast.success('Overview drafted', {
        description: `From ${res.sourceCount} source${res.sourceCount === 1 ? '' : 's'}. Review and save.`,
      })
      onGenerated(res.overview)
      onOpenChange(false)
    },
    onError: (err) =>
      toast.error('Could not generate overview', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const busy = generate.isPending

  const modes: { value: Mode; label: string; desc: string; icon: typeof FilePlus2 }[] = [
    {
      value: 'update',
      label: 'Update existing',
      desc: 'Revise & extend the current overview, keeping useful notes.',
      icon: RefreshCw,
    },
    {
      value: 'replace',
      label: 'Replace',
      desc: 'Draft a fresh overview from scratch.',
      icon: FilePlus2,
    },
  ]

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Wand2 className="h-4 w-4 text-primary" />
            Read &amp; write overview
          </DialogTitle>
          <DialogDescription>
            Claude reads the {sourceCount} selected source{sourceCount === 1 ? '' : 's'} and drafts
            the overview into the editor for review.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          {/* Mode */}
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">Mode</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {modes.map((m) => {
                const disabled = m.value === 'update' && !hasExisting
                const active = mode === m.value
                return (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => setMode(m.value)}
                    disabled={disabled}
                    title={disabled ? 'No existing overview to update yet' : undefined}
                    className={cn(
                      'flex items-start gap-2.5 rounded-xl border p-3 text-left transition-all duration-200',
                      active
                        ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                        : 'hover:border-primary/40 hover:bg-accent',
                      disabled && 'pointer-events-none opacity-40',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg',
                        active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      <m.icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold tracking-tight">{m.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                        {m.desc}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
            {!hasExisting && (
              <p className="text-[11px] text-muted-foreground">
                There’s no overview yet — the draft will start fresh.
              </p>
            )}
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Extra instructions <span className="font-normal">(optional)</span>
            </label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Emphasize the QA-relevant flows; add a Test environments section; write in Vietnamese…"
              className="min-h-[88px] resize-y text-sm"
            />
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 border-t bg-muted/20 px-5 py-3">
          <span className="text-xs text-muted-foreground">
            {sourceCount} source{sourceCount === 1 ? '' : 's'} selected
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => generate.mutate()}
            disabled={busy || sourceCount === 0}
            className="transition-all duration-200 active:scale-[0.98]"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {mode === 'update' ? 'Updating…' : 'Writing…'}
              </>
            ) : (
              <>
                <Wand2 className="h-3.5 w-3.5" />
                {mode === 'update' ? 'Update overview' : 'Write overview'}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
