import { useState } from 'react'
import { Lightbulb, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Hint } from '@/lib/hints'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  hints: Hint[]
  addHint: (label: string, text: string) => boolean
  updateHint: (id: string, patch: Partial<Pick<Hint, 'label' | 'text'>>) => void
  removeHint: (id: string) => void
  resetHints: () => void
}

export function ManageHintsDialog({
  open,
  onOpenChange,
  hints,
  addHint,
  updateHint,
  removeHint,
  resetHints,
}: Props) {
  const [newLabel, setNewLabel] = useState('')
  const [newText, setNewText] = useState('')

  const canAdd = newLabel.trim().length > 0 && newText.trim().length > 0

  function onAdd() {
    if (addHint(newLabel, newText)) {
      setNewLabel('')
      setNewText('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <Lightbulb className="size-4" />
            </span>
            Manage hints
          </DialogTitle>
          <DialogDescription>
            Quick-insert snippets for the “Instructions for the AI” box. Saved on this device.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mx-1 max-h-[55vh] px-1">
          <div className="space-y-3 pb-1">
            {hints.length === 0 && (
              <p className="rounded-lg border border-dashed bg-muted/30 px-3 py-6 text-center text-sm text-muted-foreground">
                No hints yet — add one below.
              </p>
            )}

            {hints.map((hint, i) => (
              <div key={hint.id} className="space-y-2 rounded-lg border bg-card p-3 shadow-xs">
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`Hint ${i + 1} label`}
                    value={hint.label}
                    onChange={(e) => updateHint(hint.id, { label: e.target.value })}
                    placeholder="Chip label"
                    className="h-8 font-medium"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeHint(hint.id)}
                    aria-label={`Remove ${hint.label || 'hint'}`}
                    className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
                <Textarea
                  aria-label={`Hint ${i + 1} text`}
                  value={hint.text}
                  onChange={(e) => updateHint(hint.id, { text: e.target.value })}
                  placeholder="Text inserted into the instructions box…"
                  rows={2}
                  className="resize-y text-sm leading-relaxed"
                />
              </div>
            ))}

            {/* add new */}
            <div className="space-y-2 rounded-lg border border-dashed bg-muted/20 p-3">
              <Label className="text-xs font-medium text-muted-foreground">New hint</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Chip label (e.g. Staging URL)"
                className="h-8"
              />
              <Textarea
                value={newText}
                onChange={(e) => setNewText(e.target.value)}
                placeholder="Text inserted into the instructions box…"
                rows={2}
                className="resize-y text-sm leading-relaxed"
              />
              <Button
                type="button"
                size="sm"
                onClick={onAdd}
                disabled={!canAdd}
                className="w-full sm:w-auto"
              >
                <Plus className="size-4" />
                Add hint
              </Button>
            </div>
          </div>
        </ScrollArea>

        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={resetHints}
            className="text-muted-foreground"
          >
            <RotateCcw className="size-4" />
            Reset to defaults
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
