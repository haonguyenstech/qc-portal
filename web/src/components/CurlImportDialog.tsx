// Paste a curl command, get a request draft. Shared by the request builder (which loads
// the draft into the URL bar) and the Flows tab's "Add request" picker (which saves it to
// the collection and appends it as a step) — same parser, same copy, one dialog.

import { useState } from 'react'
import { AlertCircle, Loader2, TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { parseCurl } from '@/lib/curl'
import { type ApiDraft } from '@/lib/apiDraft'

export function CurlImportDialog({
  open,
  onOpenChange,
  onImport,
  title = 'Import from cURL',
  confirmLabel = 'Import',
  pending = false,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** May be async — the dialog shows a spinner and stays open until it resolves. */
  onImport: (draft: ApiDraft) => void | Promise<void>
  title?: string
  confirmLabel?: string
  /** An external pending state (e.g. the caller is writing the request to disk). */
  pending?: boolean
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const working = busy || pending

  const doImport = async () => {
    const parsed = parseCurl(text)
    if (!parsed) {
      setError('Could not find a URL in that command. Paste a full curl command.')
      return
    }
    const draft: ApiDraft = {
      method: parsed.method,
      url: parsed.url,
      query: parsed.query,
      headers: parsed.headers,
      bodyMode: parsed.bodyMode,
      body: parsed.body,
      assertions: [{ id: 'a0', type: 'status-2xx', target: '', expected: '', enabled: true }],
      aiExpect: '',
      captures: [],
    }
    setBusy(true)
    try {
      await onImport(draft)
      setText('')
      setError(null)
      onOpenChange(false)
    } catch (e) {
      // The caller failed (a name collision, a write error) — keep the pasted command on
      // screen rather than closing over it, so it can be retried.
      setError(e instanceof Error ? e.message : 'Could not import that command.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !working && onOpenChange(v)}>
      {/* A COLUMN, not the default grid, and it never scrolls itself: the header and the
          footer are pinned and only the textarea scrolls. Capping the textarea alone was not
          enough — on a short window (a laptop, or Windows at 125/150% display scaling, where
          the viewport is ~500 CSS px) the header + a 3-line description + the floor height of
          the textarea + an error line still added up past 85vh, and the whole dialog became
          the scroller, which puts Cancel/Import below its clipped edge with nothing saying to
          scroll. With `overflow-hidden` + `shrink-0` on the two ends, the buttons are on
          screen at every window size and every paste length. */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <TerminalSquare className="size-4 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>
            Paste a <span className="font-mono">curl</span> command — from your browser's “Copy as
            cURL”, Postman, or the API docs. Method, URL, headers, query and body are filled in.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          placeholder={`curl 'https://api.example.com/login' \\\n  -H 'Content-Type: application/json' \\\n  --data '{"email":"a@b.co","password":"…"}'`}
          // The shadcn Textarea is `field-sizing-content`, so it grows to fit whatever is
          // pasted. A real browser "Copy as cURL" (25 headers + a body) grew it past 1100px,
          // which pushed Cancel/Import below the fold and the ✕ above it — the dialog is
          // centred with translate-y-[-50%] and doesn't scroll. So it grows, but it is the
          // ONLY thing here that may: `min-h-0` lets the flex column shrink it (its
          // content-sized height is the flex basis) and `overflow-y-auto` scrolls the rest.
          // `min-h-40` is the floor when there is room for it, never a claim on space the
          // footer needs.
          // `basis-auto` keeps the content-sized height as the flex basis, so it still GROWS
          // with the paste (up to 55vh); `min-h-24` is the floor it may shrink to when the
          // window is too short for that — the footer's space is never negotiable.
          className="min-h-24 flex-1 basis-auto overflow-y-auto font-mono text-xs shadow-none sm:max-h-[55vh]"
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p className="flex shrink-0 items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={working}>
            Cancel
          </Button>
          <Button
            onClick={doImport}
            disabled={!text.trim() || working}
            className="gap-1.5 active:scale-[0.98]"
          >
            {working && <Loader2 className="size-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
