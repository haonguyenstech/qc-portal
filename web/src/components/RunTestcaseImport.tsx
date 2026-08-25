import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  FileSpreadsheet,
  Globe,
  Loader2,
  Paperclip,
  Sparkles,
  TriangleAlert,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { flowFromTestcases, type FlowDraft } from '@/lib/api'
import { convertFileToMarkdown } from '@/lib/docConvert'
import { isValidHttpUrl } from '@/lib/runForm'
import { cn } from '@/lib/utils'

/**
 * "Run test cases you already have" — the Run form's advanced mode, fed by an
 * uploaded document instead of a ticket.
 *
 * The E2E flow mode already runs WITHOUT a ticket (docs/architecture/runs.md), but
 * it only knew about steps typed on the canvas. A QC engineer running a regression
 * pass normally has the cases written down already — a sheet, an exported Word doc,
 * a checklist — and retyping them as cards was the entire cost of using this mode.
 *
 * Two things happen with the uploaded document, and they are deliberately separate:
 *
 * 1. **It becomes the run's acceptance source.** The file is stored in the project
 *    (`testing/test-cases/…`) when the run starts and the run is told to read it and
 *    execute EVERY case. This is the part that must not be lossy — so the document
 *    goes to disk whole and the run reads it there, rather than being folded into a
 *    prompt that has a length limit.
 * 2. **It can draft the canvas.** One Claude call turns it into ordered steps, which
 *    is a SUMMARY (20 cards can't hold 120 cases) and is there so the engineer can
 *    see and correct the shape of the run before starting it.
 *
 * Attaching alone is enough to run — drafting the flow is optional.
 */

const ACCEPT = '.md,.markdown,.txt,.csv,.xlsx,.xls,.docx,.pdf'

/** Mirror of RUN_DOC_MAX_BYTES (server/src/runTestcaseDocs.ts) — extracted text. */
const MAX_DOC_BYTES = 2 * 1024 * 1024

export interface TestcaseDoc {
  /** The uploaded file's own name, kept as the label. */
  name: string
  markdown: string
  bytes: number
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`
}

export function RunTestcaseImport({
  projectId,
  projectName,
  doc,
  onDoc,
  onFlow,
  stepCount,
  startUrl,
  onStartUrl,
  needsStartUrl,
  testTarget,
  urls = true,
  disabled,
}: {
  projectId: string
  projectName?: string
  doc: TestcaseDoc | null
  onDoc: (doc: TestcaseDoc | null) => void
  /** Hand the AI's draft back to the page, which owns the canvas. */
  onFlow: (draft: FlowDraft) => void
  /** Steps currently on the canvas — drafting replaces them, so it asks first. */
  stepCount: number
  startUrl: string
  onStartUrl: (next: string) => void
  /**
   * True when the run has nowhere to open: a document is attached but no canvas
   * step names a URL. Only then is the fallback field the thing to fill in.
   */
  needsStartUrl: boolean
  testTarget: 'web' | 'web-mobile' | 'app-mobile'
  /** Off for the app-on-device target, which launches an app instead of an address. */
  urls?: boolean
  disabled?: boolean
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [reading, setReading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState(false)
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [lastDraft, setLastDraft] = useState<FlowDraft | null>(null)

  const startUrlInvalid = urls && !!startUrl.trim() && !isValidHttpUrl(startUrl)

  const draft = useMutation({
    mutationFn: () => {
      if (!doc) throw new Error('Attach a test-case document first.')
      return flowFromTestcases({
        projectId,
        fileName: doc.name,
        markdown: doc.markdown,
        appUrl: urls ? startUrl.trim() || undefined : undefined,
        testTarget,
        projectName,
      })
    },
    onSuccess: (result) => {
      setLastDraft(result)
      onFlow(result)
      toast.success(`Flow drafted — ${result.steps.length} step${result.steps.length === 1 ? '' : 's'}`, {
        description:
          result.summary ||
          `Read from ${doc?.name}. Check each step before starting the run — the run still executes every case in the document.`,
      })
    },
    onError: (err) => {
      toast.error('Could not read the test cases', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    },
  })

  async function takeFile(file: File | undefined | null) {
    if (!file || disabled) return
    setReading(true)
    try {
      const converted = await convertFileToMarkdown(file)
      const bytes = new Blob([converted.markdown]).size
      if (bytes > MAX_DOC_BYTES) {
        // Refused here as well as on the server: a clipped test-case document runs
        // a subset of its cases and reports as though it ran all of them.
        toast.error('That document is too large', {
          description: `${kb(bytes)} of text (limit ${MAX_DOC_BYTES / 1024 / 1024} MB). Split it and attach the part this run should cover.`,
        })
        return
      }
      setLastDraft(null)
      onDoc({ name: file.name, markdown: converted.markdown, bytes })
      toast.success('Test cases attached', {
        description: `${file.name} · ${kb(bytes)}. The run will read this document and execute every case in it.`,
      })
    } catch (err) {
      toast.error('Could not read that file', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const busy = disabled || reading || draft.isPending

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-xl bg-foreground text-background">
          <FileSpreadsheet className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-tight">Run test cases you already have</p>
          <p className="truncate text-[11px] text-muted-foreground">
            No ticket needed — attach a regression sheet or E2E checklist and the run executes it.
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => void takeFile(e.target.files?.[0])}
        />
        <Button
          type="button"
          variant={doc ? 'ghost' : 'outline'}
          size="sm"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          className="h-7 shrink-0 gap-1.5 rounded-full text-xs"
        >
          {reading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          {doc ? 'Replace file' : 'Choose file'}
        </Button>
      </div>

      {!doc ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!busy) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            void takeFile(e.dataTransfer.files?.[0])
          }}
          className={cn(
            'm-3 flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-all duration-200',
            dragging ? 'border-primary/60 bg-primary/5' : 'border-border/60',
          )}
        >
          <Upload className="size-4 text-muted-foreground" />
          <p className="text-xs font-medium">Drop a test-case document here</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Word, PDF, Excel, CSV, Markdown or text (.docx, .pdf, .xlsx, .csv, .md). It is stored
            with the project and read in full by the run.
          </p>
        </div>
      ) : (
        <div className="space-y-2.5 p-3">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-background px-2.5 py-2">
            <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs font-medium">{doc.name}</span>
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
              {kb(doc.bytes)}
            </span>
            {lastDraft?.caseCount ? (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
                {lastDraft.caseCount} case{lastDraft.caseCount === 1 ? '' : 's'}
              </span>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPreview(true)}
              className="h-6 shrink-0 rounded-full px-2 text-[11px] text-muted-foreground"
            >
              Preview
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                onDoc(null)
                setLastDraft(null)
              }}
              aria-label="Remove the attached document"
              className="size-6 shrink-0 rounded-full p-0 text-muted-foreground hover:text-destructive"
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => (stepCount > 0 ? setConfirmReplace(true) : draft.mutate())}
              className="h-8 gap-1.5 rounded-full text-xs"
            >
              {draft.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Sparkles className="size-3.5" />
              )}
              {draft.isPending ? 'Reading the cases…' : 'Analyze & build the flow'}
            </Button>
            <p className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
              Optional. The steps are a <span className="font-medium text-foreground">summary</span>{' '}
              you can edit — the run reads the whole document either way and reports on every case
              in it.
            </p>
          </div>

          {/* The advanced mode gets its URL from the canvas steps. With no steps (or
              none that open a page) the run still has to be told where to start, so
              this is the one place that can supply it. */}
          {urls && (
            <div className="space-y-1.5">
              <Label
                htmlFor="tc-start-url"
                className="flex items-center gap-1.5 text-xs"
              >
                <Globe className="size-3.5 text-muted-foreground" />
                Start URL{' '}
                <span className="text-muted-foreground">
                  {needsStartUrl ? '· required' : '· optional'}
                </span>
              </Label>
              <Input
                id="tc-start-url"
                type="url"
                value={startUrl}
                onChange={(e) => onStartUrl(e.target.value)}
                disabled={busy}
                aria-invalid={startUrlInvalid}
                placeholder="https://staging.example.com"
                className="h-8 font-mono text-xs shadow-none"
              />
              {startUrlInvalid ? (
                <p className="flex items-center gap-1.5 text-[11px] font-medium text-destructive">
                  <TriangleAlert className="size-3.5" />
                  Enter a full http:// or https:// URL.
                </p>
              ) : (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {needsStartUrl
                    ? 'Where the run opens the app. A step with its own App URL takes over from here.'
                    : 'A canvas step already names where the run starts — this is only the fallback.'}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Preview — the converted text, exactly as the run will read it. Anything a
          converter mangled (a merged spreadsheet cell, a scanned page) is visible
          here rather than after a 40-minute run. */}
      <Dialog open={preview} onOpenChange={setPreview}>
        <DialogContent className="flex h-[85vh] max-h-[85vh] w-[95vw] flex-col overflow-hidden sm:max-w-4xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="truncate">{doc?.name}</DialogTitle>
            <DialogDescription>
              Converted to Markdown in your browser — this exact text is what the run reads.
            </DialogDescription>
          </DialogHeader>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
            {doc?.markdown}
          </pre>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => setPreview(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drafting REPLACES the canvas, and a canvas someone hand-built is not
          something to overwrite on a single click. */}
      <Dialog open={confirmReplace} onOpenChange={setConfirmReplace}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Replace the steps on the canvas?</DialogTitle>
            <DialogDescription>
              The canvas has {stepCount} step{stepCount === 1 ? '' : 's'}. Building the flow from{' '}
              {doc?.name} clears them and draws the drafted steps instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmReplace(false)}>
              Keep my steps
            </Button>
            <Button
              type="button"
              onClick={() => {
                setConfirmReplace(false)
                draft.mutate()
              }}
            >
              Replace them
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
