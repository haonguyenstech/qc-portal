import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ClipboardList, FileText, Loader2, Wand2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listTestCaseVersions, type TestCaseFormat } from '@/lib/api'
import { relativeTime } from '@/lib/format'

interface Props {
  /** The crawled ticket's folder under testing/tickets/ (null when no ticket picked). */
  folder: string | null
  projectId?: string
  /** Selected test-case version (null = none chosen / not loaded yet). */
  value: number | null
  /** Reports the chosen version and its on-disk format (so callers can build the path). */
  onChange: (version: number | null, format: TestCaseFormat | null) => void
  disabled?: boolean
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
export function TicketTestCasePicker({ folder, projectId, value, onChange, disabled }: Props) {
  const navigate = useNavigate()

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
      <Select
        value={value != null ? String(value) : undefined}
        onValueChange={(v) => {
          const ver = Number(v)
          onChange(ver, versions.find((x) => x.version === ver)?.format ?? null)
        }}
        disabled={disabled}
      >
        <SelectTrigger className="h-11 w-full rounded-xl shadow-none">
          <SelectValue placeholder="Choose a test-case version" />
        </SelectTrigger>
        <SelectContent>
          {versions.map((v) => (
            <SelectItem key={v.version} value={String(v.version)}>
              <span className="flex items-center gap-2">
                <ClipboardList className="size-3.5 text-muted-foreground" />
                <span className="font-medium">{v.label}</span>
                {v.savedAt && (
                  <span className="text-xs text-muted-foreground">· {relativeTime(v.savedAt)}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {selected
          ? `Claude will verify against ${testcaseRelPath(folder, selected.version, selected.format)}.`
          : 'Choose which generated test-case version to verify against.'}
      </p>
    </div>
  )
}
