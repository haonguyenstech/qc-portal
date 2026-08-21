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
      <DialogContent className="max-h-[85vh] overflow-y-auto rounded-3xl sm:max-w-3xl">
        <DialogHeader>
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
          // centred with translate-y-[-50%] and doesn't scroll. Cap it and scroll inside.
          className="max-h-[45vh] min-h-[160px] overflow-y-auto font-mono text-xs shadow-none"
          spellCheck={false}
          autoFocus
        />
        {error && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {error}
          </p>
        )}
        <DialogFooter>
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
