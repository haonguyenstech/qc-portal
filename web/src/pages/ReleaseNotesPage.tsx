import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { ArrowUpCircle, ChevronDown, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { checkForUpdate, getReleaseNotes } from '@/lib/api'

interface Section {
  title: string
  items: string[]
}
interface Release {
  version: string
  date: string | null
  title: string | null
  summary: string | null
  sections: Section[]
}

// Parse the portal's CHANGELOG.md into structured releases:
//   ## <version> — <date>
//   **<headline>**
//   <summary paragraph>
//   ### <section>   - <item>
function parseChangelog(md: string): Release[] {
  const releases: Release[] = []
  let release: Release | null = null
  let section: Section | null = null

  for (const raw of md.split('\n')) {
    const line = raw.trim()
    const h2 = /^##\s+(.+)$/.exec(line)
    const h3 = /^###\s+(.+)$/.exec(line)
    const bullet = /^[-*]\s+(.+)$/.exec(line)
    const boldOnly = /^\*\*(.+)\*\*$/.exec(line)

    if (h2) {
      const [version, ...rest] = h2[1].split(/\s*[—–-]\s*/)
      release = {
        version: version.trim(),
        date: rest.join(' ').trim() || null,
        title: null,
        summary: null,
        sections: [],
      }
      section = null
      releases.push(release)
    } else if (h3 && release) {
      section = { title: h3[1].trim(), items: [] }
      release.sections.push(section)
    } else if (bullet && release) {
      if (!section) {
        section = { title: '', items: [] }
        release.sections.push(section)
      }
      section.items.push(bullet[1].trim())
    } else if (line && release && !section && !line.startsWith('#')) {
      // Before any ### section: first bold line is the headline, rest is the summary.
      if (boldOnly && !release.title) release.title = boldOnly[1].trim()
      else release.summary = release.summary ? `${release.summary} ${line}` : line
    }
  }
  return releases
}

// Map changelog sections to Antigravity-style colored category labels.
const SECTION_COLORS: Record<string, string> = {
  added: 'text-emerald-600 dark:text-emerald-400',
  changed: 'text-sky-600 dark:text-sky-400',
  fixed: 'text-amber-600 dark:text-amber-400',
  platform: 'text-violet-600 dark:text-violet-400',
}

// Inline markdown for a single bullet (keeps **bold** / `code`, drops block <p> margins).
const INLINE: Parameters<typeof ReactMarkdown>[0]['components'] = {
  p: ({ children }) => <>{children}</>,
}
const BULLET_MD = cn(
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8em]',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
)

function CategoryRow({ section, defaultOpen }: { section: Section; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const color = SECTION_COLORS[section.title.toLowerCase()] ?? 'text-foreground'
  const empty = section.items.length === 0

  return (
    <div className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={() => !empty && setOpen((o) => !o)}
        disabled={empty}
        className={cn(
          'flex w-full items-center justify-between gap-2 py-2.5 text-left text-sm font-medium transition-colors',
          empty ? 'cursor-default text-muted-foreground/50' : 'hover:text-foreground',
        )}
      >
        <span className={cn('flex items-center gap-2', !empty && color)}>
          {section.title || 'Notes'}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">
            ({section.items.length})
          </span>
        </span>
        {!empty && (
          <ChevronDown
            className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      {open && !empty && (
        <ul className="space-y-1.5 pb-3">
          {section.items.map((item, i) => (
            <li key={i} className="flex gap-2 text-sm leading-relaxed text-muted-foreground">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-muted-foreground/40" />
              <span className={BULLET_MD}>
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={INLINE}>
                  {item}
                </ReactMarkdown>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReleaseRow({
  release,
  isLatest,
  isInstalled,
}: {
  release: Release
  isLatest: boolean
  isInstalled: boolean
}) {
  return (
    <div className="grid grid-cols-1 gap-3 py-7 sm:grid-cols-[8rem_1fr] sm:gap-6">
      {/* Left column: version + date */}
      <div className="sm:pt-5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-tight">v{release.version}</span>
          {isInstalled ? (
            <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-600 ring-1 ring-inset ring-emerald-500/20 dark:text-emerald-400">
              Installed
            </span>
          ) : (
            isLatest && (
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary ring-1 ring-inset ring-primary/20">
                Latest
              </span>
            )
          )}
        </div>
        {release.date && <p className="mt-0.5 text-xs text-muted-foreground">{release.date}</p>}
      </div>

      {/* Right column: tinted content card */}
      <div className="rounded-2xl bg-muted/60 p-5 sm:p-6">
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {release.title && (
            <h2 className="text-lg font-semibold leading-snug tracking-tight">{release.title}</h2>
          )}
          {release.summary && (
            <p className="self-start text-sm leading-relaxed text-muted-foreground">
              {release.summary}
            </p>
          )}
        </div>
        {release.sections.length > 0 && (
          <div className="mt-4">
            {release.sections.map((s, i) => (
              <CategoryRow key={i} section={s} defaultOpen={isLatest && i === 0} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default function ReleaseNotesPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['release-notes'],
    queryFn: getReleaseNotes,
  })

  const releases = data?.markdown ? parseChangelog(data.markdown) : []

  const check = useMutation({
    mutationFn: checkForUpdate,
    onSuccess: (r) => {
      if (r.error) toast.error('Update check failed', { description: r.error })
      else if (r.updateAvailable)
        toast.info(`Update available: v${r.current} → v${r.latest}`, {
          description: 'Run `qc-portal --update` in the install folder to upgrade.',
          duration: 8000,
        })
      else toast.success(`You're on the latest version (v${r.current}).`)
    },
    onError: (e) => toast.error('Update check failed', { description: String(e) }),
  })

  const updateAvailable = check.data?.updateAvailable && !check.data.error

  return (
    <div className="space-y-8">
      {/* Hero header — big title left, actions right (Antigravity style) */}
      <div className="flex flex-wrap items-end justify-between gap-4 pt-2">
        <div className="space-y-1.5">
          <h1 className="text-4xl font-semibold tracking-tight">Release Notes</h1>
          <p className="text-sm text-muted-foreground">
            What's changed in QC Portal.
            {data?.current && (
              <>
                {' '}
                You're on{' '}
                <span className="font-mono font-medium text-foreground">v{data.current}</span>.
              </>
            )}
          </p>
        </div>
        <Button
          variant={updateAvailable ? 'default' : 'outline'}
          onClick={() => check.mutate()}
          disabled={check.isPending}
          className="shrink-0 rounded-full transition-all duration-200 active:scale-[0.98]"
        >
          {check.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : updateAvailable ? (
            <ArrowUpCircle className="h-4 w-4" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {updateAvailable ? `Update available (v${check.data?.latest})` : 'Check for updates'}
        </Button>
      </div>

      {updateAvailable && (
        <Card className="rounded-3xl border-amber-500/30 bg-amber-500/5 shadow-none">
          <CardContent className="flex items-start gap-3 py-4 text-sm">
            <ArrowUpCircle className="mt-0.5 size-5 shrink-0 text-amber-500" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                A newer version is available (v{check.data?.latest}).
              </p>
              <p className="text-muted-foreground">
                Run{' '}
                <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">qc-portal --update</code>{' '}
                in the install folder to pull, rebuild, and restart.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
      ) : releases.length > 0 ? (
        <div>
          {/* Column header row */}
          <div className="grid grid-cols-1 gap-6 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:grid-cols-[8rem_1fr]">
            <span>Version</span>
            <span className="hidden sm:block">Description</span>
          </div>
          <div className="divide-y divide-border/60">
            {releases.map((r, i) => (
              <ReleaseRow
                key={r.version}
                release={r}
                isLatest={i === 0}
                isInstalled={r.version === data?.current}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No release notes found. (CHANGELOG.md is missing from the install.)
        </p>
      )}
    </div>
  )
}
