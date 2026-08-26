// The params / headers key-value editor, shared by the request builder and the flow
// runner's per-step override (see `ApiFlowPanel.tsx`). It was local to
// `pages/ApiTestingPage.tsx` until a flow step could carry its own headers; the panel
// cannot import the page (the page imports the panel), and a second copy of these rows
// is how the two sides start behaving differently about `enabled`.

import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import type { ApiKV } from '@/lib/api'

export function KVEditor({
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  rows: ApiKV[]
  onChange: (rows: ApiKV[]) => void
  keyPlaceholder: string
  valuePlaceholder: string
}) {
  const update = (i: number, patch: Partial<ApiKV>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const add = () => onChange([...rows, { key: '', value: '', enabled: true }])
  return (
    <div className="space-y-2">
      {rows.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">None yet.</p>
      )}
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <Checkbox
            checked={r.enabled}
            onChange={(e) => update(i, { enabled: e.target.checked })}
            aria-label="Enabled"
          />
          <Input
            value={r.key}
            onChange={(e) => update(i, { key: e.target.value })}
            placeholder={keyPlaceholder}
            className="h-9 flex-1 font-mono text-xs shadow-none"
          />
          <Input
            value={r.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="h-9 flex-[2] font-mono text-xs shadow-none"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => remove(i)}
            className="size-9 shrink-0 rounded-lg text-muted-foreground hover:text-destructive"
            aria-label="Remove row"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={add}
        className="rounded-full active:scale-[0.98]"
      >
        <Plus className="size-3.5" />
        Add
      </Button>
    </div>
  )
}
