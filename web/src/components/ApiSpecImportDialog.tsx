// Import a whole API description — OpenAPI 3 / Swagger 2 (JSON or YAML) or a Postman
// Collection v2 export — into the collection in one go. Parsing lives in
// lib/apiSpecImport.ts; this dialog previews what was found, lets the engineer untick
// what they don't want, and saves the rest the same way Scan does (one PUT per request,
// filed under the spec's tag / folder).

import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { AlertCircle, FileJson, Loader2, TriangleAlert, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { saveApiRequest } from '@/lib/api'
import { importApiSpec, type SpecImport } from '@/lib/apiSpecImport'
import { cn } from '@/lib/utils'

const MAX_FILE_BYTES = 5 * 1024 * 1024

export function ApiSpecImportDialog({
  projectId,
  open,
  onOpenChange,
  existingNames,
}: {
  projectId: string
  open: boolean
  onOpenChange: (v: boolean) => void
  existingNames: string[]
}) {
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState<SpecImport | null>(null)
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [parsing, setParsing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [groupByTag, setGroupByTag] = useState(true)

  const reset = () => {
    setText('')
    setFileName('')
    setParsed(null)
    setUnchecked(new Set())
    setError(null)
  }

  const parse = async (source: string) => {
    setParsing(true)
    setError(null)
    try {
      const result = await importApiSpec(source, existingNames)
      setParsed(result)
      setUnchecked(new Set())
    } catch (e) {
      setParsed(null)
      setError(e instanceof Error ? e.message : 'Could not read that file.')
    } finally {
      setParsing(false)
    }
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024 / 1024)} MB — the limit is 5 MB.`)
      return
    }
    const content = await file.text()
    setFileName(file.name)
    setText(content)
    await parse(content)
  }

  const selected = parsed ? parsed.requests.filter((r) => !unchecked.has(r.id)) : []
  const allOn = !!parsed && selected.length === parsed.requests.length
  const groups = parsed ? new Set(parsed.requests.map((r) => r.group).filter(Boolean)).size : 0

  const doImport = async () => {
    if (!parsed || !selected.length) return
    setImporting(true)
    let ok = 0
    const failed: string[] = []
    for (const r of selected) {
      try {
        await saveApiRequest(projectId, r.name, { ...r.draft, group: groupByTag ? r.group : '' })
        ok++
      } catch {
        failed.push(r.name)
      }
    }
    setImporting(false)
    queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
    if (ok) {
      toast.success(`Imported ${ok} request${ok === 1 ? '' : 's'} from ${parsed.title}`, {
        description: failed.length
          ? `${failed.length} could not be saved: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`
          : parsed.variables.length
            ? `Set ${parsed.variables.map((v) => `{{${v.key}}}`).join(', ')} under Environment before you Send.`
            : undefined,
      })
      reset()
      onOpenChange(false)
    } else {
      setError('Nothing could be saved. Check that the portal server is running, then try again.')
    }
  }

  const working = parsing || importing

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (working) return
        if (!v) reset()
        onOpenChange(v)
      }}
    >
      {/* Same column layout as CurlImportDialog: header and footer pinned, only the
          middle scrolls, so Import stays on screen however long the spec is. */}
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileJson className="size-4 text-primary" />
            Import OpenAPI / Swagger / Postman
          </DialogTitle>
          <DialogDescription>
            Pick (or paste) an OpenAPI 3 or Swagger 2 file — JSON or YAML — or a Postman
            Collection v2 export. Every endpoint becomes a saved request, filed under its tag or
            folder.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {!parsed ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
                  className="hidden"
                  onChange={(e) => {
                    void onFile(e.target.files?.[0])
                    e.target.value = ''
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                  disabled={working}
                  className="gap-1.5 rounded-full active:scale-[0.98]"
                >
                  <Upload className="size-3.5" />
                  Choose file…
                </Button>
                <span className="text-xs text-muted-foreground">
                  {fileName || 'or paste the file contents below'}
                </span>
              </div>
              <Textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setError(null)
                }}
                placeholder={'openapi: 3.0.0\ninfo:\n  title: My API\npaths:\n  /users:\n    get: …'}
                className="max-h-[45vh] min-h-40 font-mono text-xs"
                disabled={working}
              />
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-border/60 bg-muted/40 px-3 py-2">
                <span className="min-w-0 text-sm">
                  <span className="font-semibold">{parsed.title}</span>{' '}
                  <span className="text-muted-foreground">
                    · {parsed.format} · {parsed.requests.length} request
                    {parsed.requests.length === 1 ? '' : 's'}
                    {groups ? ` in ${groups} module${groups === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <label className="flex cursor-pointer items-center gap-2 text-xs">
                  <Checkbox
                    checked={groupByTag}
                    onChange={(e) => setGroupByTag(e.target.checked)}
                  />
                  File under {parsed.format === 'Postman' ? 'folders' : 'tags'}
                </label>
              </div>

              {parsed.warnings.length > 0 && (
                <ul className="space-y-1 rounded-2xl border border-amber-500/30 bg-amber-50/60 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/5 dark:text-amber-300">
                  {parsed.warnings.map((w) => (
                    <li key={w} className="flex gap-1.5">
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                      {w}
                    </li>
                  ))}
                </ul>
              )}

              {parsed.variables.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Variables to set under <span className="font-medium text-foreground">Environment</span>:{' '}
                  {parsed.variables.map((v, i) => (
                    <span key={v.key}>
                      {i > 0 && ', '}
                      <span className="font-mono text-foreground">{`{{${v.key}}}`}</span>
                      {v.value && <span className="font-mono"> = {v.value}</span>}
                    </span>
                  ))}
                </p>
              )}

              <div className="overflow-hidden rounded-2xl border border-border/60">
                <label className="flex cursor-pointer items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2 text-xs font-medium">
                  <Checkbox
                    checked={allOn}
                    indeterminate={!allOn && selected.length > 0}
                    onChange={() =>
                      setUnchecked(allOn ? new Set(parsed.requests.map((r) => r.id)) : new Set())
                    }
                  />
                  {selected.length} of {parsed.requests.length} selected
                </label>
                <ul className="divide-y divide-border/60">
                  {parsed.requests.map((r) => (
                    <li key={r.id}>
                      <label className="flex cursor-pointer items-start gap-2 px-3 py-1.5 hover:bg-muted/40">
                        <Checkbox
                          className="mt-0.5"
                          checked={!unchecked.has(r.id)}
                          onChange={() =>
                            setUnchecked((s) => {
                              const next = new Set(s)
                              if (next.has(r.id)) next.delete(r.id)
                              else next.add(r.id)
                              return next
                            })
                          }
                        />
                        <span
                          className={cn(
                            'w-14 shrink-0 font-mono text-[11px] font-bold',
                            METHOD_TONE[r.draft.method] ?? 'text-muted-foreground',
                          )}
                        >
                          {r.draft.method}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block break-all font-mono text-xs">{r.draft.url}</span>
                          {(r.summary || r.group) && (
                            <span className="block truncate text-[11px] text-muted-foreground">
                              {r.group && <span className="font-medium">{r.group}</span>}
                              {r.group && r.summary ? ' · ' : ''}
                              {r.summary}
                            </span>
                          )}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}

          {error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
              <span className="whitespace-pre-wrap">{error}</span>
            </p>
          )}
        </div>

        <DialogFooter className="shrink-0">
          {parsed ? (
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setParsed(null)
                  setError(null)
                }}
                disabled={working}
                className="rounded-full"
              >
                Back
              </Button>
              <Button
                onClick={doImport}
                disabled={working || !selected.length}
                className="rounded-full active:scale-[0.98]"
              >
                {importing && <Loader2 className="size-4 animate-spin" />}
                Import {selected.length} request{selected.length === 1 ? '' : 's'}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={working}
                className="rounded-full"
              >
                Cancel
              </Button>
              <Button
                onClick={() => parse(text)}
                disabled={working || !text.trim()}
                className="rounded-full active:scale-[0.98]"
              >
                {parsing && <Loader2 className="size-4 animate-spin" />}
                Read file
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Same palette as ApiTestingPage's `methodColor`, so a method reads the same everywhere.
const METHOD_TONE: Record<string, string> = {
  GET: 'text-emerald-600',
  POST: 'text-sky-600',
  PUT: 'text-amber-600',
  PATCH: 'text-amber-600',
  DELETE: 'text-red-600',
}
