import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Bug, ClipboardList, Eye, FileText, Loader2, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CsvTable } from '@/components/CsvTable'
import { getTestCaseVersion, listTestCaseVersions, type TestCaseFormat } from '@/lib/api'
import { relativeTime } from '@/lib/format'

/** Compact markdown styling for the preview dialog (subset of TestCasePage's MD_CLASS). */
const MD_CLASS = cn(
  'text-sm leading-relaxed text-foreground/90',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs [&_td]:align-top',
)

interface Props {
  /** The crawled ticket's folder under testing/tickets/ (null when no ticket picked). */
  folder: string | null
  projectId?: string
  /** Selected test-case version (null = none chosen / not loaded yet). */
  value: number | null
  /** Reports the chosen version and its on-disk format (so callers can build the path). */
  onChange: (version: number | null, format: TestCaseFormat | null) => void
  disabled?: boolean
  /** This ticket is tagged a bug — it runs without test cases, so show a bug note. */
  isBug?: boolean
}

/** Build the on-disk path of a test-case version (mirrors the server layout). */
export function testcaseRelPath(
  folder: string,
  version: number,
  format: TestCaseFormat = 'markdown',
): string {
  if (version === 0) return `testing/tickets/${folder}/testcases.md`
  const ext = format === 'csv' ? 'csv' : 'md'
  return `testing/tickets/${folder}/testcases/v${version}.${ext}`
}

/**
 * Lets the user pick which generated test-case version a QC run should verify
 * against. If the picked ticket has no test cases yet, it informs the user and
 * offers a shortcut to generate them on the Test Case page.
 */
/** Read-only dialog showing the selected test-case version — CSV as a table, markdown rendered. */
function TestCasePreviewDialog({
  open,
  onOpenChange,
  folder,
  projectId,
  version,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  folder: string
  projectId: string
  version: number
}) {
  const { data, isFetching } = useQuery({
    queryKey: ['testcase-preview', projectId, folder, version],
    queryFn: () => getTestCaseVersion(folder, version, projectId),
    enabled: open,
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-muted-foreground" />
            Test cases · {version === 0 ? 'v0 (legacy)' : `v${version}`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {testcaseRelPath(folder, version, data?.format ?? 'markdown')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {isFetching && !data ? (
            <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </p>
          ) : data?.testcases ? (
            data.format === 'csv' ? (
              <CsvTable csv={data.testcases} />
            ) : (
              <div className={MD_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.testcases}</ReactMarkdown>
              </div>
            )
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No test cases found for this version.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function TicketTestCasePicker({
  folder,
  projectId,
  value,
  onChange,
  disabled,
  isBug,
}: Props) {
  const navigate = useNavigate()
  const [previewOpen, setPreviewOpen] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['testcase-versions', projectId, folder],
    queryFn: () => listTestCaseVersions(folder as string, projectId as string),
    enabled: !!folder && !!projectId,
  })

  // Latest version first.
  const versions = useMemo(
    () => [...(data?.versions ?? [])].sort((a, b) => b.version - a.version),
    [data],
  )

  // Default to the latest version once the list loads (and whenever the current
  // selection isn't among the available versions). onChange is the parent's setter.
  useEffect(() => {
    if (!versions.length) return
    if (value == null || !versions.some((v) => v.version === value)) {
      onChange(versions[0].version, versions[0].format)
    }
  }, [versions, value, onChange])

  const label = (
    <Label className="flex items-center gap-1.5">
      <ClipboardList className="size-3.5 text-muted-foreground" />
      Test cases
      {versions.length > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {versions.length} version{versions.length === 1 ? '' : 's'}
        </span>
      )}
    </Label>
  )

  if (!folder) {
    return (
      <div className="space-y-2">
        {label}
        <p className="rounded-xl border border-dashed border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
          Pick a ticket above to choose its test cases.
        </p>
      </div>
    )
  }

  // Tagged as a bug → it runs without test cases; don't nag to generate them.
  if (isBug) {
    return (
      <div className="space-y-2">
        {label}
        <div className="flex items-start gap-2.5 rounded-2xl border border-red-200 bg-red-50/70 px-3.5 py-3 text-xs dark:border-red-900/50 dark:bg-red-950/20">
          <Bug className="mt-0.5 size-4 shrink-0 text-red-600" />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-red-900 dark:text-red-200">
              Runs as a bug — no test cases needed
            </p>
            <p className="leading-snug text-red-700/90 dark:text-red-300/80">
              Claude reads this ticket’s content and verifies the reported issue (reproduce & confirm
              whether it’s fixed) instead of checking against manual test cases.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {label}
        <div className="flex items-center gap-2 rounded-xl border border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Loading test cases…
        </div>
      </div>
    )
  }

  // No test cases for this ticket → inform + offer to generate them.
  if (versions.length === 0) {
    return (
      <div className="space-y-2">
        {label}
        <div className="flex flex-col gap-2.5 rounded-2xl border border-amber-300/60 bg-amber-50/60 px-3.5 py-3 dark:bg-amber-950/20 sm:flex-row sm:items-center">
          <FileText className="size-4 shrink-0 text-amber-600" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              No test cases for this ticket yet
            </p>
            <p className="text-xs text-amber-700/90 dark:text-amber-300/80">
              Generate manual test cases first, then run QC against them.
            </p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => navigate(`/testcases?ticket=${encodeURIComponent(folder)}`)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-600/90 disabled:opacity-50"
          >
            <Wand2 className="size-3.5" />
            Generate test cases
          </button>
        </div>
      </div>
    )
  }

  const selected = versions.find((v) => v.version === value)

  return (
    <div className="space-y-2">
      {label}
      <div className="flex items-center gap-1.5">
        <Select
          value={value != null ? String(value) : undefined}
          onValueChange={(v) => {
            const ver = Number(v)
            onChange(ver, versions.find((x) => x.version === ver)?.format ?? null)
          }}
          disabled={disabled}
        >
          {/* data-[size=default]:h-11 — the base SelectTrigger pins h-9 via the same data
              selector, so a plain h-11 loses; match the ticket picker's 44px trigger. */}
          <SelectTrigger className="w-full min-w-0 flex-1 rounded-xl border-border/60 shadow-none data-[size=default]:h-11">
            <SelectValue placeholder="Choose a test-case version" />
          </SelectTrigger>
          <SelectContent>
            {versions.map((v) => (
              <SelectItem key={v.version} value={String(v.version)}>
                <span className="flex items-center gap-2">
                  <ClipboardList className="size-3.5 text-muted-foreground" />
                  <span className="font-medium">{v.label}</span>
                  {v.savedAt && (
                    <span className="text-xs text-muted-foreground">
                      · {relativeTime(v.savedAt)}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* Quick preview of the selected version's content, without leaving the run form. */}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0 rounded-xl shadow-none"
          onClick={() => setPreviewOpen(true)}
          disabled={value == null}
          title="Preview test cases"
          aria-label="Preview test cases"
        >
          <Eye className="size-4" />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {selected
          ? `Claude will verify against ${testcaseRelPath(folder, selected.version, selected.format)}.`
          : 'Choose which generated test-case version to verify against.'}
      </p>
      {projectId && value != null && (
        <TestCasePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          folder={folder}
          projectId={projectId}
          version={value}
        />
      )}
    </div>
  )
}
