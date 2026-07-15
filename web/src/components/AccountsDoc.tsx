import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Check,
  Copy,
  Download,
  Eye,
  FileSpreadsheet,
  KeyRound,
  Loader2,
  Pencil,
  Save,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { OpenFolderButton } from '@/components/OpenFolderButton'
import { convertFileToMarkdown } from '@/lib/docConvert'
import {
  deleteAccounts as deleteAccountsApi,
  getAccounts,
  openAccountsFolder,
  saveAccounts,
  type AccountsDoc as AccountsDocData,
} from '@/lib/api'

/** File types we accept for the accounts sheet (converted to a Markdown table in-browser). */
const ACCOUNTS_ACCEPT = '.csv,.xlsx,.xls,.md,.markdown,.txt'

/** A sample CSV users can download to learn the expected columns/shape. */
const EXAMPLE_CSV = `Environment,URL,Role,Username,Password,Notes
Staging,https://staging.example.com,Admin,qa.admin@example.com,Test@1234,MFA disabled for QA
Staging,https://staging.example.com,Manager,qa.manager@example.com,Test@1234,Can approve requests
Staging,https://staging.example.com,User,qa.user@example.com,Test@1234,Standard end user
QA,https://qa.example.com,Admin,qa.admin@example.com,Qa@12345,Reset nightly at 00:00
QA,https://qa.example.com,User,qa.user@example.com,Qa@12345,No billing access
UAT,https://uat.example.com,User,uat.user@example.com,Uat@6789,Client-facing acceptance env
`

/** Trigger a browser download of the sample CSV so the user can fill it in and re-upload. */
function downloadExampleCsv() {
  const blob = new Blob([EXAMPLE_CSV], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'environments-example.csv'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** A starting scaffold shown when the project has no sheet yet. */
const PLACEHOLDER = `# Environments & test accounts

| Environment | URL | Role | Username | Password | Notes |
| --- | --- | --- | --- | --- | --- |
| Staging | https://staging.example.com | Admin | qa.admin@example.com | ••••• | MFA off |
| Staging | https://staging.example.com | User | qa.user@example.com | ••••• |  |
`

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  return `${(n / 1024).toFixed(1)} KB`
}

const MD_CLASS = cn(
  'text-sm leading-relaxed',
  '[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight',
  '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
  '[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
  '[&_p]:my-2.5 [&_p]:text-muted-foreground',
  '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1 [&_li]:text-muted-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
  '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs',
  '[&_hr]:my-5 [&_hr]:border-border',
)

export function AccountsDoc({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['accounts', projectId],
    queryFn: () => getAccounts(projectId),
    enabled: !!projectId,
  })

  if (isLoading || !data) {
    return (
      <Card className="rounded-3xl border-border/60 shadow-none">
        <CardContent className="flex items-center gap-2 px-4 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading environments…
        </CardContent>
      </Card>
    )
  }

  return (
    <AccountsEditor
      key={data.savedAt ?? 'new'}
      projectId={projectId}
      projectName={projectName}
      doc={data}
    />
  )
}

function AccountsEditor({
  projectId,
  projectName,
  doc,
}: {
  projectId: string
  projectName: string
  doc: AccountsDocData
}) {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [content, setContent] = useState(doc.content)
  const [mode, setMode] = useState<'edit' | 'preview'>(doc.exists ? 'preview' : 'edit')
  const [converting, setConverting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  const dirty = content !== doc.content

  const save = useMutation({
    mutationFn: () => saveAccounts(content, projectId),
    onSuccess: (res) => {
      queryClient.setQueryData(['accounts', projectId], res)
      toast.success('Environments saved', {
        description: 'Claude will use these URLs and accounts for login steps.',
      })
    },
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  const clear = useMutation({
    mutationFn: () => deleteAccountsApi(projectId),
    onSuccess: () => {
      setConfirmClear(false)
      setContent('')
      queryClient.setQueryData(['accounts', projectId], {
        content: '',
        exists: false,
        size: 0,
        savedAt: null,
      })
      toast.success('Environments cleared')
    },
    onError: (err) =>
      toast.error('Could not clear', {
        description: err instanceof Error ? err.message : undefined,
      }),
  })

  async function handleFile(file: File) {
    setConverting(true)
    try {
      const { markdown } = await convertFileToMarkdown(file)
      setContent(markdown)
      setMode('preview')
      toast.success(`Loaded ${file.name}`, { description: 'Review it, then Save.' })
    } catch (e) {
      toast.error(`Couldn't read ${file.name}`, {
        description: e instanceof Error ? e.message : 'Conversion failed',
      })
    } finally {
      setConverting(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <KeyRound className="h-4 w-4 text-primary" />
          Environments &amp; test accounts
        </h2>
        <OpenFolderButton open={() => openAccountsFolder(projectId)} label="testing" />
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        The app URLs and test-account logins for {projectName}. When a generated test case says
        “log in as …”, Claude uses these exact URLs and credentials instead of inventing
        placeholders. Upload a CSV/Excel sheet (converted to a table right here in your browser) or
        edit it by hand. Stored in{' '}
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
          testing/environments.md
        </code>
        .
      </p>

      {/* Plaintext / non-production warning — these are credentials on disk. */}
      <div className="flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
        <ShieldAlert className="mt-0.5 size-4 shrink-0" />
        <span>
          Stored as <strong>plain text</strong> on this machine and fed to Claude. Use{' '}
          <strong>non-production, throwaway test accounts only</strong> — never real user or
          production credentials.
        </span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept={ACCOUNTS_ACCEPT}
        className="hidden"
        onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
      />

      <Card className="overflow-hidden rounded-3xl border-border/60 shadow-none">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/60 px-4 py-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground">
            <KeyRound className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight">Environments sheet</p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              testing/environments.md
            </p>
          </div>

          {dirty ? (
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
              Unsaved changes
            </span>
          ) : doc.exists ? (
            <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-300">
              Saved · {formatBytes(doc.size)}
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-300">
              Not created yet
            </span>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={downloadExampleCsv}
              className="h-7 gap-1 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
            >
              <Download className="size-3.5" />
              Example CSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => inputRef.current?.click()}
              disabled={converting}
              className="h-7 gap-1 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
            >
              {converting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Upload className="size-3.5" />
              )}
              Import CSV / Excel
            </Button>

            <div className="flex rounded-xl border border-border/60 bg-background p-0.5">
              <button
                type="button"
                onClick={() => setMode('edit')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  mode === 'edit'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Pencil className="size-3" />
                Edit
              </button>
              <button
                type="button"
                onClick={() => setMode('preview')}
                className={cn(
                  'flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors',
                  mode === 'preview'
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Eye className="size-3" />
                Preview
              </button>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={copy}
              disabled={!content.trim()}
              className="h-7 gap-1 px-2 text-[11px] active:scale-[0.98]"
            >
              {copied ? (
                <Check className="size-3.5 text-emerald-600" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>

            <Button
              size="sm"
              onClick={() => save.mutate()}
              disabled={save.isPending || !dirty}
              className="rounded-full active:scale-[0.98]"
            >
              {save.isPending ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3.5" />
              )}
              Save
            </Button>
          </div>
        </div>

        <CardContent className="p-0">
          {mode === 'preview' ? (
            content.trim() ? (
              <div className="max-h-[calc(100svh-30rem)] min-h-[20rem] overflow-auto bg-card px-6 py-5">
                <div className={MD_CLASS}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
                <span className="flex size-11 items-center justify-center rounded-2xl bg-foreground text-background">
                  <FileSpreadsheet className="size-5" />
                </span>
                <p className="text-sm font-medium">No environments yet</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  Import a CSV/Excel sheet of URLs and test accounts, or switch to Edit and start
                  from the template. Not sure of the format?{' '}
                  <button
                    type="button"
                    onClick={downloadExampleCsv}
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    Download an example CSV
                  </button>{' '}
                  to fill in.
                </p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={downloadExampleCsv}
                    className="rounded-full active:scale-[0.98]"
                  >
                    <Download className="mr-1.5 size-3.5" /> Example CSV
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setContent(PLACEHOLDER)
                      setMode('edit')
                    }}
                    className="rounded-full active:scale-[0.98]"
                  >
                    <Pencil className="mr-1.5 size-3.5" /> Start from template
                  </Button>
                </div>
              </div>
            )
          ) : (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              spellCheck={false}
              placeholder={PLACEHOLDER}
              className="min-h-[calc(100svh-30rem)] resize-y rounded-none border-0 bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-zinc-950/40"
            />
          )}
        </CardContent>
      </Card>

      {doc.exists && (
        <div className="flex justify-end">
          {confirmClear ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Remove the whole sheet?</span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => clear.mutate()}
                disabled={clear.isPending}
                className="h-8 rounded-full"
              >
                {clear.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                Confirm
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmClear(false)}
                disabled={clear.isPending}
                className="h-8 rounded-full"
              >
                <X className="size-3.5" />
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmClear(true)}
              className="rounded-full text-destructive hover:text-destructive active:scale-[0.98]"
            >
              <Trash2 className="mr-1.5 size-3.5" /> Clear sheet
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
