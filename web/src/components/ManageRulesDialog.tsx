import { useState } from 'react'
import { ListChecks, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { TestRule } from '@/lib/testRules'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  rules: TestRule[]
  addRule: (label: string, hint: string) => boolean
  updateRule: (id: string, patch: Partial<Pick<TestRule, 'label' | 'hint'>>) => void
  removeRule: (id: string) => void
  resetRules: () => void
  /** Dialog title — defaults to the test-case wording; pass to reuse elsewhere. */
  title?: string
  /** Dialog description shown under the title. */
  description?: string
}

export function ManageRulesDialog({
  open,
  onOpenChange,
  rules,
  addRule,
  updateRule,
  removeRule,
  resetRules,
  title = 'Manage test-case rules',
  description = 'Reusable coverage rules. The label is the chip; the instruction is what Claude is told to cover. Saved on this device.',
}: Props) {
  const [newLabel, setNewLabel] = useState('')
  const [newHint, setNewHint] = useState('')

  const canAdd = newLabel.trim().length > 0 && newHint.trim().length > 0

  function onAdd() {
    if (addRule(newLabel, newHint)) {
      setNewLabel('')
      setNewHint('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <ListChecks className="size-4" />
            </span>
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[58vh]">
          <Table className="text-xs">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="h-8 w-[30%] px-2 text-xs">Label</TableHead>
                <TableHead className="h-8 px-2 text-xs">Instruction for Claude</TableHead>
                <TableHead className="h-8 w-9 px-1" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="py-6 text-center text-sm text-muted-foreground"
                  >
                    No rules yet — add one below.
                  </TableCell>
                </TableRow>
              )}

              {rules.map((rule, i) => (
                <TableRow key={rule.id} className="hover:bg-transparent">
                  <TableCell className="px-2 py-1 align-top">
                    <Input
                      aria-label={`Rule ${i + 1} label`}
                      value={rule.label}
                      onChange={(e) => updateRule(rule.id, { label: e.target.value })}
                      placeholder="Chip label"
                      className="h-7 px-2 text-xs font-medium"
                    />
                  </TableCell>
                  <TableCell className="px-2 py-1 align-top">
                    <Textarea
                      aria-label={`Rule ${i + 1} instruction`}
                      value={rule.hint}
                      onChange={(e) => updateRule(rule.id, { hint: e.target.value })}
                      placeholder="Instruction Claude should follow…"
                      rows={2}
                      className="min-h-0 resize-y px-2 py-1 text-xs leading-snug"
                    />
                  </TableCell>
                  <TableCell className="px-1 py-1 align-top">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeRule(rule.id)}
                      aria-label={`Remove ${rule.label || 'rule'}`}
                      className="size-7 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}

              {/* add new row */}
              <TableRow className="border-dashed bg-muted/20 hover:bg-muted/20">
                <TableCell className="px-2 py-1.5 align-top">
                  <Input
                    value={newLabel}
                    onChange={(e) => setNewLabel(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && canAdd && onAdd()}
                    placeholder="New label…"
                    className="h-7 px-2 text-xs"
                  />
                </TableCell>
                <TableCell className="px-2 py-1.5 align-top">
                  <Textarea
                    value={newHint}
                    onChange={(e) => setNewHint(e.target.value)}
                    placeholder="New instruction…"
                    rows={2}
                    className="min-h-0 resize-y px-2 py-1 text-xs leading-snug"
                  />
                </TableCell>
                <TableCell className="px-1 py-1.5 align-top">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={onAdd}
                    disabled={!canAdd}
                    aria-label="Add rule"
                    className="size-7 text-primary hover:text-primary"
                  >
                    <Plus className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </ScrollArea>

        <DialogFooter className="sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {rules.length} rule{rules.length === 1 ? '' : 's'}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={resetRules}
              className="text-muted-foreground"
            >
              <RotateCcw className="size-4" />
              Reset to defaults
            </Button>
            <Button type="button" size="sm" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
