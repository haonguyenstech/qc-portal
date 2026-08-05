import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ClipboardList, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { getTestCaseVersion, listTestCaseVersions } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { testcaseRelPath } from '@/lib/testcases'

/** Compact markdown styling for the preview dialog (subset of TestCasePage's MD_CLASS). */
const MD_CLASS = cn(
  'text-sm leading-relaxed text-foreground/90',
  '[&_h1]:mt-5 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs [&_td]:align-top',
)

/**
 * Read-only preview of a crawled ticket's generated test cases — a version
 * dropdown (latest first) over a CSV table / rendered markdown. Shared by every
 * surface that only needs to LOOK at test cases: the Run form's ticket picker
 * and its version picker. Editing/deleting lives on the Test cases page.
 *
 * `folder` doubles as the open state (null = closed), matching TestCasePage's
 * `previewFolder` pattern, so a caller just stores which ticket to show.
 */
export function TestCaseVersionsDialog({
  folder,
  projectId,
  initialVersion,
  onOpenChange,
}: {
  /** Crawled-ticket folder (possibly nested) — null closes the dialog. */
  folder: string | null
  projectId?: string
  /** Version to show first; defaults to the latest. */
  initialVersion?: number | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={!!folder} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[92vh] w-[97vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[90rem]">
        {folder && projectId && (
          // Keyed by folder so the version pick resets with the ticket — no effect
          // syncing state back from the fetched list.
          <PreviewBody
            key={folder}
            folder={folder}
            projectId={projectId}
            initialVersion={initialVersion ?? null}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PreviewBody({
  folder,
  projectId,
  initialVersion,
}: {
  folder: string
  projectId: string
  initialVersion: number | null
}) {
  // The user's explicit pick; null until they choose one, so the default below
  // follows the list as it loads.
  const [chosen, setChosen] = useState<number | null>(null)

  const { data: list, isLoading } = useQuery({
    queryKey: ['testcase-versions', projectId, folder],
    queryFn: () => listTestCaseVersions(folder, projectId),
  })
  const versions = useMemo(
    () => [...(list?.versions ?? [])].sort((a, b) => b.version - a.version),
    [list],
  )

  // Derived during render: the pick if it's real, else the caller's preferred
  // version, else the latest.
  const has = (v: number | null) => v != null && versions.some((x) => x.version === v)
  const selected = has(chosen) ? chosen : has(initialVersion) ? initialVersion : versions[0]?.version ?? null

  const { data, isFetching } = useQuery({
    queryKey: ['testcase-preview', projectId, folder, selected],
    queryFn: () => getTestCaseVersion(folder, selected as number, projectId),
    enabled: selected != null,
  })

  return (
    <>
        <DialogHeader className="shrink-0 space-y-2 border-b border-border/60 bg-muted/30 px-5 py-3">
          <DialogTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-muted-foreground" />
            <span className="truncate font-mono text-sm">{folder}</span>
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2 text-xs">
            {versions.length > 0 ? (
              <>
                <span>
                  {versions.length} version{versions.length === 1 ? '' : 's'}
                </span>
                <Select
                  value={selected != null ? String(selected) : undefined}
                  onValueChange={(v) => setChosen(Number(v))}
                >
                  <SelectTrigger size="sm" className="h-7 w-52 rounded-full">
                    <SelectValue placeholder="Pick a version" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v, i) => (
                      <SelectItem key={v.version} value={String(v.version)}>
                        {v.label}
                        {v.format === 'csv' ? ' · CSV' : ''}
                        {i === 0 ? ' · latest' : ''}
                        {v.savedAt ? ` · ${relativeTime(v.savedAt)}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {folder && selected != null && (
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {testcaseRelPath(folder, selected, data?.format ?? 'markdown')}
                  </span>
                )}
              </>
            ) : isLoading ? (
              <span>Loading versions…</span>
            ) : (
              <span>No versions yet</span>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
          {(isFetching || isLoading) && !data ? (
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
              No test cases found for this ticket.
            </p>
          )}
        </div>
    </>
  )
}
