import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Cpu,
  Download,
  FileArchive,
  Gauge,
  ChevronUp,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  PlayCircle,
  Plus,
  Power,
  RotateCw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  browseFolder,
  claudeStatus,
  createFolder,
  createProject,
  deleteProject,
  exportProject,
  importProject,
  initProject,
  listProjects,
  pingHealth,
  testClaudeModel,
  triggerRestart,
  updateProject,
} from '@/lib/api'
import { useProjects } from '@/lib/project-context'
import { relativeTime } from '@/lib/format'
import type { Project } from '@/lib/types'

/** Mirror of the server's safeFolderName — turns a display name into a safe
 *  single folder segment, so the UI can preview the renamed path. */
function safeFolderName(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim()
}

/** Replace the last segment of a path with a new folder name (preview only). */
function withFolderName(fullPath: string, folder: string): string {
  const sep = fullPath.includes('\\') && !fullPath.includes('/') ? '\\' : '/'
  const parts = fullPath.split(/[/\\]/)
  parts[parts.length - 1] = folder
  return parts.join(sep)
}

/**
 * A single "Browse…" button that opens the in-portal folder picker (a folder
 * browser rendered inside the page, backed by GET /api/projects/browse-folder).
 *
 * We intentionally do NOT use the native OS folder dialog here: it only renders
 * when the portal runs attached to the user's interactive desktop, so it hangs
 * forever whenever the server was started any other way (from a shortcut that
 * detaches, Task Scheduler, SSH, autostart, another session). The in-portal
 * picker works no matter how the server was launched, on Windows and macOS.
 * (`pickFolderNative` / `GET /api/projects/pick-folder` still exist for the
 * skills-import flow.)
 */
function BrowseButton({ onPick }: { onPick: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-11 shrink-0 rounded-full transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
      >
        <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
        Browse…
      </Button>
      <FolderBrowserDialog
        open={open}
        onOpenChange={setOpen}
        onPick={(p) => {
          onPick(p)
          setOpen(false)
        }}
      />
    </div>
  )
}

/** In-app folder browser: navigate the server's filesystem and pick a folder. */
function FolderBrowserDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onPick: (path: string) => void
}) {
  // undefined → let the server start at the user's home directory.
  const [nav, setNav] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const queryClient = useQueryClient()

  const { data, isFetching, isError, error } = useQuery({
    queryKey: ['browse-folder', nav ?? '~home'],
    queryFn: () => browseFolder(nav),
    enabled: open,
  })

  // Keep the editable path box in step with wherever we navigated to.
  useEffect(() => {
    if (data?.path) setDraft(data.path)
  }, [data?.path])

  const goto = (p: string) => setNav(p)
  const submitDraft = () => {
    const p = draft.trim()
    if (p) setNav(p)
  }

  const createMutation = useMutation({
    mutationFn: () => createFolder(data?.path ?? '', newName),
    onSuccess: (r) => {
      toast.success('Folder created', { description: r.path })
      setCreating(false)
      setNewName('')
      setDraft(r.path) // select the new folder
      queryClient.invalidateQueries({ queryKey: ['browse-folder'] })
    },
    onError: (err) =>
      toast.error('Could not create folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Navigate to the folder on this machine, or type/paste a path below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Path bar: home, up, editable path, go */}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Home"
              onClick={() => setNav(undefined)}
              className="h-9 w-9 shrink-0 rounded-full"
            >
              <Home className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              title="Up one level"
              disabled={!data?.parent}
              onClick={() => data?.parent && goto(data.parent)}
              className="h-9 w-9 shrink-0 rounded-full"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitDraft()
                }
              }}
              placeholder="Type or paste a folder path…"
              className="h-9 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={submitDraft}
              className="h-9 shrink-0 rounded-full"
            >
              Go
            </Button>
          </div>

          {/* Windows drive chips */}
          {data?.drives && data.drives.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {data.drives.map((d) => (
                <Button
                  key={d}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => goto(d)}
                  className="h-7 rounded-full px-2.5 text-xs"
                >
                  <HardDrive className="mr-1 h-3 w-3" />
                  {d.replace(/\\$/, '')}
                </Button>
              ))}
            </div>
          )}

          {/* New-folder action / inline creator */}
          {!creating ? (
            <div className="flex items-center justify-between gap-2">
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground"
                title={data?.path}
              >
                {data?.path ?? ''}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!data?.path || !!data?.error}
                onClick={() => {
                  setNewName('')
                  setCreating(true)
                }}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                New folder
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <Input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (newName.trim() && !createMutation.isPending) createMutation.mutate()
                  } else if (e.key === 'Escape') {
                    setCreating(false)
                  }
                }}
                placeholder="New folder name"
                className="h-8 min-w-0 flex-1 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={!newName.trim() || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                {createMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  'Create'
                )}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCreating(false)}
                className="h-8 shrink-0 rounded-full text-xs"
              >
                Cancel
              </Button>
            </div>
          )}

          {/* Folder list */}
          <div className="h-72 overflow-y-auto rounded-2xl border border-border/60 bg-muted/40 p-1.5">
            {isFetching ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : isError ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive">
                {error instanceof Error ? error.message : 'Could not read this folder'}
              </div>
            ) : data?.error ? (
              <div className="flex h-full items-center justify-center px-4 text-center text-sm text-amber-600 dark:text-amber-500">
                {data.error}
              </div>
            ) : data && data.entries.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                No sub-folders here.
              </div>
            ) : (
              <ul className="space-y-0.5">
                {data?.entries.map((e) => (
                  <li key={e.path}>
                    <button
                      type="button"
                      onDoubleClick={() => goto(e.path)}
                      onClick={() => setDraft(e.path)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm transition-colors',
                        'hover:bg-background',
                        draft === e.path && 'bg-background ring-1 ring-border',
                      )}
                      title="Double-click to open"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{e.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Click a folder to select it, double-click to open it. Then choose{' '}
            <span className="font-medium text-foreground">Use this folder</span>.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            className="rounded-full"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="rounded-full"
            disabled={!draft.trim()}
            onClick={() => onPick(draft.trim())}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A compact pill showing whether a given capability is present in the repo. */
function HealthChip({ ok, label }: { ok: boolean | undefined; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors duration-200',
        ok
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : 'border-dashed border-border bg-transparent text-muted-foreground/70',
      )}
      title={ok ? `${label} detected` : `${label} not found`}
    >
      {ok ? (
        <CheckCircle2 className="h-3 w-3" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/30" aria-hidden />
      )}
      {label}
    </span>
  )
}

/** Compact "N/3 ready" pill with a tiny segmented bar summarizing setup. */
function ReadinessPill({ count }: { count: number }) {
  const full = count >= 3
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        full
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : count === 0
            ? 'border-border bg-muted/50 text-muted-foreground'
            : 'border-amber-200 bg-amber-50 text-amber-700',
      )}
      title={`${count} of 3 capabilities configured`}
    >
      {full ? <Sparkles className="h-3 w-3" /> : null}
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: 3 }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-2.5 w-1 rounded-full transition-colors',
              i < count
                ? full
                  ? 'bg-emerald-500'
                  : 'bg-amber-500'
                : 'bg-muted-foreground/25',
            )}
          />
        ))}
      </span>
      {full ? 'Ready' : `${count}/3`}
    </span>
  )
}

/** A single summary tile in the overview strip. */
function StatTile({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: React.ReactNode
  tone?: 'default' | 'primary' | 'emerald' | 'amber'
}) {
  const tones = {
    default: 'border-border/60 bg-muted/60 text-muted-foreground',
    primary: 'border-primary/20 bg-primary/10 text-primary',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-600',
    amber: 'border-amber-200 bg-amber-50 text-amber-600',
  }
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl border border-border/60 bg-muted/60 p-3">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl border',
          tones[tone],
        )}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-lg font-semibold tracking-tight">{value}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  )
}

function ProjectCard({ project }: { project: Project }) {
  const queryClient = useQueryClient()
  const { refetch: refetchContext, activeProjectId, setActiveProjectId } = useProjects()
  const [editing, setEditing] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteConfirmName, setDeleteConfirmName] = useState('')
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false)
  const [name, setName] = useState(project.name)
  const [rootPath, setRootPath] = useState(project.rootPath)
  const isActive = activeProjectId === project.id
  const notFound = project.exists === false
  const readiness =
    (project.hasSkills ? 1 : 0) + (project.hasMcp ? 1 : 0) + (project.hasClaudeMd ? 1 : 0)
  const canDelete = deleteConfirmName === project.name

  // Whether saving will move the folder on disk (name changed → new basename).
  const renameSafe = safeFolderName(name)
  const renameTarget = renameSafe ? withFolderName(rootPath.trim(), renameSafe) : ''
  const willMoveFolder =
    !!renameSafe && name.trim() !== project.name && renameTarget !== rootPath.trim()

  function afterChange() {
    queryClient.invalidateQueries({ queryKey: ['projects'] })
    refetchContext()
  }

  const updateMutation = useMutation({
    mutationFn: () =>
      updateProject(project.id, { name: name.trim(), rootPath: rootPath.trim() }),
    onSuccess: (updated) => {
      const moved = updated.rootPath !== project.rootPath
      toast.success('Project updated', {
        description: moved ? `Folder renamed → ${updated.rootPath}` : `${name} saved.`,
      })
      setEditing(false)
      afterChange()
    },
    onError: (err) =>
      toast.error('Failed to update project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const pinMutation = useMutation({
    mutationFn: () => updateProject(project.id, { pinned: !project.pinned }),
    onSuccess: () => {
      toast.success(project.pinned ? 'Unpinned' : 'Pinned to top', { description: project.name })
      afterChange()
    },
    onError: (err) =>
      toast.error('Failed to update project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: (res) => {
      toast.success('Project deleted', {
        description: res.deletedPath
          ? `Removed from portal and deleted ${res.deletedPath}.`
          : `${project.name} removed from portal. Folder was already missing.`,
      })
      setDeleteOpen(false)
      setDeleteConfirmName('')
      afterChange()
    },
    onError: (err) =>
      toast.error('Failed to delete project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const initMutation = useMutation({
    mutationFn: () => initProject(project.id),
    onSuccess: (res) => {
      if (res.created.length === 0) {
        toast.info('Already initialized', {
          description: 'This folder already has the Claude Code setup.',
        })
      } else {
        toast.success('Project initialized', {
          description: `Created ${res.created.join(', ')}${
            res.templateName ? ` from “${res.templateName}”` : ''
          }.`,
        })
      }
      afterChange()
    },
    onError: (err) =>
      toast.error('Failed to initialize project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  async function copyPath() {
    try {
      await navigator.clipboard.writeText(project.rootPath)
      toast.success('Path copied', { description: project.rootPath })
    } catch {
      toast.error('Could not copy path')
    }
  }

  const [exporting, setExporting] = useState(false)
  async function doExport() {
    setExporting(true)
    try {
      await exportProject(project.id, project.name)
      toast.success('Project exported', {
        description: `Downloaded ${project.name}.zip (CLAUDE.md, skills, MCP & testing).`,
      })
    } catch (err) {
      toast.error('Failed to export project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card
      className={cn(
        'group relative flex flex-col gap-0 overflow-hidden rounded-3xl py-0 shadow-none transition-all duration-200',
        isActive
          ? 'border-2 border-sky-500 bg-sky-50/40 shadow-sm ring-2 ring-sky-500/20'
          : 'border border-border/60 hover:-translate-y-0.5 hover:border-border hover:shadow-sm',
        notFound && !isActive && 'border-destructive/30',
      )}
    >
      {/* left status accent rail */}
      <span
        className={cn(
          'absolute inset-y-0 left-0 w-1 transition-colors duration-200',
          isActive
            ? 'bg-sky-500'
            : notFound
              ? 'bg-destructive/60'
              : 'bg-transparent group-hover:bg-border',
        )}
        aria-hidden
      />
      {/* top accent line — animates in on hover for inactive cards */}
      {!isActive && !notFound && (
        <span
          className="absolute inset-x-0 top-0 h-0.5 origin-left scale-x-0 bg-gradient-to-r from-primary/70 to-primary/20 transition-transform duration-300 group-hover:scale-x-100"
          aria-hidden
        />
      )}

      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-4 pl-5">
        <div className="min-w-0 flex-1 space-y-1.5">
          {editing ? (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor={`name-${project.id}`}>Name</Label>
                <Input
                  id={`name-${project.id}`}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`path-${project.id}`}>Root path</Label>
                <div className="flex gap-2">
                  <Input
                    id={`path-${project.id}`}
                    value={rootPath}
                    onChange={(e) => setRootPath(e.target.value)}
                    className="flex-1 font-mono text-xs"
                  />
                  <BrowseButton onPick={setRootPath} />
                </div>
              </div>
              {/* Renaming the project moves its folder on disk to match — preview it. */}
              {willMoveFolder && (
                <p className="flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/50 px-3 py-2.5 text-[11px] leading-snug text-amber-700">
                  <FolderGit2 className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    Saving renames the folder to{' '}
                    <span className="font-mono text-foreground">{renameTarget}</span> — the real
                    directory moves. You'll confirm first.
                  </span>
                </p>
              )}
            </div>
          ) : (
            <>
              <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border transition-all duration-200',
                    isActive
                      ? 'border-transparent bg-foreground text-background'
                      : notFound
                        ? 'border-destructive/20 bg-destructive/5 text-destructive'
                        : 'border-border/60 bg-muted/60 text-muted-foreground group-hover:border-border group-hover:text-foreground',
                  )}
                >
                  <FolderGit2 className="h-3.5 w-3.5" />
                </span>
                <span className="truncate font-semibold tracking-tight">{project.name}</span>
                {isActive && <Badge className="shrink-0">active</Badge>}
                {project.pinned && (
                  <Badge variant="secondary" className="shrink-0 gap-1">
                    <Pin className="h-3 w-3" />
                    Pinned
                  </Badge>
                )}
                {notFound && (
                  <Badge variant="destructive" className="shrink-0 gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Not found
                  </Badge>
                )}
              </CardTitle>
              <div className="flex items-center gap-1 pl-9">
                <span
                  className="truncate font-mono text-xs text-muted-foreground"
                  title={project.rootPath}
                >
                  {project.rootPath}
                </span>
                <button
                  type="button"
                  onClick={copyPath}
                  aria-label="Copy path"
                  className="shrink-0 rounded-lg p-0.5 text-muted-foreground/50 opacity-0 transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-9 pt-0.5">
                <ReadinessPill count={readiness} />
                <span
                  className="flex items-center gap-1 text-[11px] text-muted-foreground"
                  title={new Date(project.createdAt).toLocaleString()}
                >
                  <Clock className="h-3 w-3" />
                  Added {relativeTime(project.createdAt)}
                </span>
              </div>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  // Moving the folder is destructive — confirm & warn first.
                  if (willMoveFolder) setRenameConfirmOpen(true)
                  else updateMutation.mutate()
                }}
                disabled={updateMutation.isPending || !name.trim() || !rootPath.trim()}
                aria-label="Save"
                className="rounded-full text-emerald-600 transition-all duration-200 hover:bg-emerald-50 hover:text-emerald-700 active:scale-[0.98] disabled:text-muted-foreground"
              >
                {updateMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setName(project.name)
                  setRootPath(project.rootPath)
                  setEditing(false)
                }}
                aria-label="Cancel"
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <div
              className={cn(
                'flex items-center gap-1 transition-opacity duration-200',
                // Keep actions visible when pinned so the pin state is always togglable.
                project.pinned
                  ? 'opacity-100'
                  : 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100',
              )}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => pinMutation.mutate()}
                disabled={pinMutation.isPending}
                aria-label={project.pinned ? 'Unpin project' : 'Pin project to top'}
                title={project.pinned ? 'Unpin' : 'Pin to top'}
                className={cn(
                  'size-8 rounded-full transition-all duration-200 active:scale-[0.98]',
                  project.pinned
                    ? 'text-primary hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {pinMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : project.pinned ? (
                  <PinOff className="h-3.5 w-3.5" />
                ) : (
                  <Pin className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={doExport}
                disabled={exporting || notFound}
                aria-label="Export project as .zip"
                title={notFound ? 'Folder not found on disk' : 'Export as .zip'}
                className="size-8 rounded-full text-muted-foreground transition-all duration-200 hover:text-foreground active:scale-[0.98] disabled:opacity-50"
              >
                {exporting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setEditing(true)}
                aria-label="Edit"
                className="size-8 rounded-full text-muted-foreground transition-all duration-200 hover:text-foreground active:scale-[0.98]"
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {(
                <Dialog
                  open={deleteOpen}
                  onOpenChange={(open) => {
                    setDeleteOpen(open)
                    if (!open) setDeleteConfirmName('')
                  }}
                >
                  <DialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={deleteMutation.isPending}
                      aria-label="Delete"
                      className="size-8 rounded-full text-muted-foreground transition-all duration-200 hover:bg-destructive/10 hover:text-destructive active:scale-[0.98] disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                      <div className="flex items-start gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10 text-destructive">
                          <Trash2 className="size-5" />
                        </span>
                        <div className="space-y-1 text-left">
                          <DialogTitle>Delete project?</DialogTitle>
                          <DialogDescription>
                            Permanently delete this project from QC Portal and remove its local
                            folder from disk.
                          </DialogDescription>
                        </div>
                      </div>
                    </DialogHeader>
                    <div className="rounded-2xl border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                      This deletes the folder recursively on this machine. Export the project first
                      if you need a backup.
                    </div>
                    <div className="rounded-2xl border border-border/60 bg-muted/60 p-3">
                      <div className="truncate text-sm font-semibold">{project.name}</div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {project.rootPath}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`delete-confirm-${project.id}`}>
                        Type project name to confirm
                      </Label>
                      <Input
                        id={`delete-confirm-${project.id}`}
                        value={deleteConfirmName}
                        onChange={(e) => setDeleteConfirmName(e.target.value)}
                        placeholder={project.name}
                        autoComplete="off"
                        disabled={deleteMutation.isPending}
                      />
                    </div>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button
                          variant="outline"
                          disabled={deleteMutation.isPending}
                          className="rounded-full transition-all duration-200 active:scale-[0.98]"
                        >
                          Cancel
                        </Button>
                      </DialogClose>
                      <Button
                        variant="destructive"
                        onClick={() => deleteMutation.mutate()}
                        disabled={deleteMutation.isPending || !canDelete}
                        className="rounded-full transition-all duration-200 active:scale-[0.98]"
                      >
                        {deleteMutation.isPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Trash2 className="size-4" />
                        )}
                        Delete project
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      {!editing && (
        <CardContent className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-muted/40 px-4 py-2.5 pl-5">
          <div className="flex flex-wrap gap-1.5">
            <HealthChip ok={project.hasSkills} label="Skills" />
            <HealthChip ok={project.hasMcp} label="MCP" />
            <HealthChip ok={project.hasClaudeMd} label="CLAUDE.md" />
          </div>
          <div className="flex items-center gap-2">
            {!notFound && readiness < 3 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => initMutation.mutate()}
                    disabled={initMutation.isPending}
                    className="group/init relative gap-1.5 overflow-hidden rounded-full border-border/60 bg-muted/60 text-primary transition-all duration-200 hover:border-primary hover:bg-primary hover:text-primary-foreground hover:shadow-sm active:scale-[0.98] disabled:opacity-70"
                  >
                    {/* sheen sweep on hover */}
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 -left-full w-1/2 -skew-x-12 bg-gradient-to-r from-transparent via-white/25 to-transparent transition-all duration-700 ease-out group-hover/init:left-full"
                    />
                    {initMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5 transition-transform duration-300 group-hover/init:-rotate-12 group-hover/init:scale-110" />
                    )}
                    {initMutation.isPending ? 'Initializing…' : 'Init'}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-none rounded-xl whitespace-nowrap">
                  Scaffold the missing setup — CLAUDE.md, the qc-testing skill &amp; .mcp.json
                </TooltipContent>
              </Tooltip>
            )}
            {isActive ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-primary">
                <CheckCircle2 className="h-4 w-4" />
                Active
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setActiveProjectId(project.id)}
                className="group/btn gap-1.5 rounded-full transition-all duration-200 hover:bg-primary hover:text-primary-foreground hover:shadow-sm active:scale-[0.98]"
              >
                Switch
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover/btn:translate-x-1" />
              </Button>
            )}
          </div>
        </CardContent>
      )}

      {/* Confirm + warn before moving the folder on disk. */}
      <Dialog open={renameConfirmOpen} onOpenChange={(o) => !updateMutation.isPending && setRenameConfirmOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-amber-300/40 bg-amber-100 text-amber-700">
                <FolderGit2 className="size-5" />
              </span>
              <div className="space-y-1 text-left">
                <DialogTitle>Rename the folder on disk?</DialogTitle>
                <DialogDescription>
                  Renaming this project moves its folder on disk. Anything writing into it will
                  break, so make sure nothing is running first.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <div className="space-y-2 overflow-hidden rounded-2xl border border-border/60 bg-muted/60 p-3 text-xs">
            <div className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-muted-foreground">From</span>
              <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground line-through">
                {project.rootPath}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-9 shrink-0 text-muted-foreground">To</span>
              <span className="min-w-0 flex-1 truncate font-mono font-medium text-foreground">
                {renameTarget}
              </span>
            </div>
          </div>
          <ul className="space-y-1.5 text-[13px] text-muted-foreground">
            <li className="flex gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              Make sure no QC run, crawl, or test-case job is using this project — files would be
              written to the old path.
            </li>
            <li className="flex gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              Update any external references (terminals, editors, scripts) to the new path.
            </li>
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameConfirmOpen(false)}
              disabled={updateMutation.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setRenameConfirmOpen(false)
                updateMutation.mutate()
              }}
              disabled={updateMutation.isPending}
              className="rounded-full bg-amber-600 text-white transition-all duration-200 hover:bg-amber-700 active:scale-[0.98]"
            >
              {updateMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <FolderGit2 className="size-4" />
              )}
              Rename &amp; move folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** The body of the "Add project" dialog. Calls onDone() once the project is created. */
function AddProjectForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const { refetch: refetchContext, setActiveProjectId } = useProjects()
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState('')

  const mutation = useMutation({
    mutationFn: () => createProject({ name: name.trim(), rootPath: rootPath.trim() }),
    onSuccess: (p) => {
      const created = p.created?.length ?? 0
      toast.success('Project added', {
        description:
          created > 0
            ? `${p.name} created, initialized (${created} file${created === 1 ? '' : 's'}) and set as the active project.`
            : `${p.name} created and set as the active project.`,
      })
      setName('')
      setRootPath('')
      // Switch every page (MCP, Instructions, Tickets, …) to the new project
      // right away — otherwise they keep showing the previous active project.
      // Seed the cache first so the new id is already valid when the
      // ProjectProvider fallback effect runs (else it reverts to the default).
      queryClient.setQueryData<Project[]>(['projects'], (old) =>
        old && !old.some((x) => x.id === p.id) ? [...old, p] : old ?? [p],
      )
      setActiveProjectId(p.id)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      refetchContext()
      onDone()
    },
    onError: (err) =>
      toast.error('Failed to add project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const canSubmit = name.trim() && rootPath.trim()

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) mutation.mutate()
      }}
      className="space-y-5"
    >
      <div className="space-y-2">
        <Label htmlFor="new-project-name" className="flex items-center gap-1.5">
          <FolderGit2 className="size-3.5 text-muted-foreground" />
          Name
        </Label>
        <div className="group relative">
          <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <Input
            id="new-project-name"
            placeholder="My App"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            className="h-11 pl-9 shadow-xs transition-shadow focus-visible:shadow-sm"
          />
        </div>
        <p className="text-xs text-muted-foreground">A friendly label shown across QC.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="new-project-path" className="flex items-center gap-1.5">
          <FolderOpen className="size-3.5 text-muted-foreground" />
          Root path
        </Label>
        <div className="flex gap-2">
          <div className="group relative flex-1">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <Input
              id="new-project-path"
              placeholder="/Users/you/code/my-app"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
              className="h-11 pl-9 font-mono text-sm shadow-xs transition-shadow focus-visible:shadow-sm"
            />
          </div>
          <BrowseButton onPick={setRootPath} />
        </div>
        <p className="text-xs text-muted-foreground">
          Click <span className="font-medium text-foreground">Browse…</span> to pick the folder,
          or paste an absolute path.
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5" />
          Registers an existing repo folder — nothing is created on disk.
        </p>
        <Button
          type="submit"
          disabled={mutation.isPending || !canSubmit}
          className="group h-11 rounded-full px-6 text-sm font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Adding…
            </>
          ) : (
            <>
              <Plus className="size-4" />
              Add project
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

function AddProjectDialog({ watchAddParam = false }: { watchAddParam?: boolean }) {
  const [open, setOpen] = useState(false)
  const [searchParams, setSearchParams] = useSearchParams()

  // Allow other surfaces (e.g. the sidebar project dropdown) to deep-link here and
  // pop the dialog open via ?add=1 — consume the param so a reload doesn't re-open it.
  useEffect(() => {
    if (!watchAddParam || !searchParams.get('add')) return
    setOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('add')
    setSearchParams(next, { replace: true })
  }, [watchAddParam, searchParams, setSearchParams])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-11 shrink-0 rounded-full px-5 font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]">
          <Plus className="size-4" />
          Add project
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <FolderPlus className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Add project</DialogTitle>
              <DialogDescription>
                Register an existing repo folder so QC can run against it.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <AddProjectForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

/** Body of the "Import project" dialog — pick a .zip, a parent folder & name. */
function ImportProjectForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const { refetch: refetchContext } = useProjects()
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState('')

  const mutation = useMutation({
    mutationFn: async () => {
      if (!file || file.size === 0) {
        throw new Error('Choose a non-empty .zip exported from QC Portal.')
      }
      return importProject({ name: name.trim(), parentPath: parentPath.trim(), file })
    },
    onSuccess: (p) => {
      toast.success('Project imported', { description: `${p.name} created at ${p.rootPath}.` })
      setFile(null)
      setName('')
      setParentPath('')
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      refetchContext()
      onDone()
    },
    onError: (err) =>
      toast.error('Failed to import project', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  function chooseFile(f: File | null) {
    setFile(f)
    if (f && !name.trim()) setName(f.name.replace(/\.zip$/i, ''))
  }

  const trimmedParent = parentPath.trim().replace(/[/\\]+$/, '')
  const destSep = trimmedParent.includes('\\') && !trimmedParent.includes('/') ? '\\' : '/'
  const destPreview = trimmedParent
    ? `${trimmedParent}${destSep}${safeFolderName(name) || '…'}`
    : ''
  const canSubmit = !!file && name.trim() && parentPath.trim() && !mutation.isPending

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSubmit) mutation.mutate()
      }}
      className="space-y-5"
    >
      {/* .zip picker */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1.5">
          <FileArchive className="size-3.5 text-muted-foreground" />
          Exported .zip
        </Label>
        <label
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-4 text-left transition-colors',
            file
              ? 'border-primary/40 bg-primary/5'
              : 'border-border hover:border-primary/40 hover:bg-muted/40',
          )}
        >
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-xl transition-colors',
              file ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground',
            )}
          >
            <FileArchive className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {file ? file.name : 'Choose a project .zip…'}
            </span>
            <span className="block text-xs text-muted-foreground">
              {file
                ? `${(file.size / 1024 / 1024).toFixed(2)} MB — click to replace`
                : 'A file exported with the Export button on a project card'}
            </span>
          </span>
          <input
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            onChange={(e) => chooseFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>

      {/* name */}
      <div className="space-y-2">
        <Label htmlFor="import-project-name" className="flex items-center gap-1.5">
          <FolderGit2 className="size-3.5 text-muted-foreground" />
          Name
        </Label>
        <div className="group relative">
          <FolderGit2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <Input
            id="import-project-name"
            placeholder="My App"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-11 pl-9 shadow-xs transition-shadow focus-visible:shadow-sm"
          />
        </div>
      </div>

      {/* destination parent folder */}
      <div className="space-y-2">
        <Label htmlFor="import-project-path" className="flex items-center gap-1.5">
          <FolderOpen className="size-3.5 text-muted-foreground" />
          Extract into
        </Label>
        <div className="flex gap-2">
          <div className="group relative flex-1">
            <FolderOpen className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <Input
              id="import-project-path"
              placeholder="/Users/you/code"
              value={parentPath}
              onChange={(e) => setParentPath(e.target.value)}
              className="h-11 pl-9 font-mono text-sm shadow-xs transition-shadow focus-visible:shadow-sm"
            />
          </div>
          <BrowseButton onPick={setParentPath} />
        </div>
        {destPreview ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ArrowRight className="size-3.5" />
            Creates <span className="font-mono text-foreground">{destPreview}</span>
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            The project folder is created inside this folder.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="size-3.5" />
          Restores CLAUDE.md, skills, .mcp.json &amp; testing/ from the zip.
        </p>
        <Button
          type="submit"
          disabled={!canSubmit}
          className="group h-11 rounded-full px-6 text-sm font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          {mutation.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Importing…
            </>
          ) : (
            <>
              <Upload className="size-4" />
              Import project
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </Button>
      </div>
    </form>
  )
}

function ImportProjectDialog() {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          className="h-11 shrink-0 rounded-full px-5 font-semibold shadow-none transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
        >
          <Upload className="size-4" />
          Import
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
              <FileArchive className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Import project</DialogTitle>
              <DialogDescription>
                Re-create a project from a .zip exported by QC Portal.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <ImportProjectForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function AiRuntimeCard() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['claude-status'],
    queryFn: claudeStatus,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  })
  const [results, setResults] = useState<Record<string, string>>({})
  const testMutation = useMutation({
    mutationFn: (model: string) => testClaudeModel(model),
    onSuccess: (res) => {
      setResults((m) => ({
        ...m,
        [res.model]: res.ok ? 'OK' : res.detail,
      }))
      if (res.ok) toast.success(`${res.model} works`, { description: res.detail })
      else toast.error(`${res.model} failed`, { description: res.detail })
    },
    onError: (err, model) => {
      const detail = err instanceof Error ? err.message : 'Model test failed'
      setResults((m) => ({ ...m, [model]: detail }))
      toast.error(`${model} failed`, { description: detail })
    },
  })
  const testingModel = testMutation.isPending ? (testMutation.variables as string) : null
  const modelUseCases: Record<string, string[]> = {
    sonnet: ['QC default', 'Feature work', 'Bug fixes', 'Review'],
    opus: ['Architecture', 'Hard bugs', 'Risky refactor', 'Security'],
    haiku: ['Fast check', 'Summary', 'Small edit', 'Low risk'],
  }

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-2xl border shadow-none',
                data?.installed
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                  : 'border-amber-200 bg-amber-50 text-amber-600',
              )}
            >
              {isLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : data?.installed ? (
                <Cpu className="h-5 w-5" />
              ) : (
                <AlertCircle className="h-5 w-5" />
              )}
            </span>
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold tracking-tight">AI runtime</h2>
                <Badge
                  variant={data?.installed ? 'secondary' : 'outline'}
                  className={cn(
                    'gap-1 font-medium',
                    data?.installed
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {data?.installed ? (
                    <CheckCircle2 className="h-3 w-3" />
                  ) : (
                    <AlertCircle className="h-3 w-3" />
                  )}
                  {isLoading ? 'Checking' : data?.installed ? 'Ready' : 'Install required'}
                </Badge>
              </div>
              <p className="max-w-xl text-sm text-muted-foreground">
                {isLoading
                  ? 'Checking Claude Code on this device…'
                  : data?.installed
                    ? 'Choose a Claude Code model alias and run a quick local smoke test.'
                    : 'Claude Code CLI is required before QC can test models.'}
              </p>
              <div className="flex flex-wrap gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">
                  <Terminal className="h-3.5 w-3.5" />
                  <span className="font-mono">{data?.binary ?? 'claude'}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground">
                  <Gauge className="h-3.5 w-3.5" />
                  <span className="font-mono">{data?.version ?? 'version pending'}</span>
                </span>
              </div>
              {(isError || data?.error) && (
                <p className="text-xs text-destructive">
                  {isError && error instanceof Error ? error.message : data?.error}
                </p>
              )}
              {!isLoading && !data?.installed && data?.installCommand && (
                <code className="block w-fit rounded-xl border border-border/60 bg-muted/60 px-2.5 py-1 font-mono text-xs text-muted-foreground">
                  {data.installCommand}
                </code>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          {(data?.models ?? []).map((model) => {
            const testing = testingModel === model.id
            return (
              <div
                key={model.id}
                className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/60 px-3 py-2 transition-colors hover:border-border"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold tracking-tight">{model.label}</div>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {model.id}
                    </Badge>
                  </div>
                  <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-muted-foreground">
                    {model.description}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(modelUseCases[model.id] ?? []).map((item) => (
                      <span
                        key={item}
                        className="rounded-full bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!data?.installed || testing || testMutation.isPending}
                  onClick={() => testMutation.mutate(model.id)}
                  className="h-8 shrink-0 rounded-full px-3 transition-all duration-200 active:scale-[0.98]"
                >
                  {testing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <PlayCircle className="h-3.5 w-3.5" />
                  )}
                  Test
                </Button>
                {results[model.id] && (
                  <div
                    className={cn(
                      'max-w-28 shrink-0 truncate rounded-xl px-2 py-1 text-[11px]',
                      results[model.id].startsWith('OK')
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-red-50 text-destructive',
                    )}
                    title={results[model.id]}
                  >
                    {results[model.id]}
                  </div>
                )}
              </div>
            )
          })}
          {isLoading &&
            Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-[58px] animate-pulse rounded-2xl bg-muted" />
            ))}
        </div>
      </CardContent>
    </Card>
  )
}

const AUTOMATION_MODELS = [
  { id: 'haiku', label: 'Haiku' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
] as const

type AutomationPatch = {
  groundingCheck?: boolean
  groundingCheckModel?: string
  autoLearn?: boolean
  autoLearnModel?: string
}

/**
 * Per-project AI post-step automation — the grounding check (anti-hallucination
 * auto-revise) and AI auto-learn that run after test-case generation and QC runs.
 * Scoped to the ACTIVE project; each control auto-saves on change.
 */
function AiAutomationCard() {
  const { projects, activeProjectId } = useProjects()
  const queryClient = useQueryClient()
  const project = projects.find((p) => p.id === activeProjectId)

  const save = useMutation({
    mutationFn: (patch: AutomationPatch) => updateProject(project!.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('AI automation updated')
    },
    onError: (err) =>
      toast.error('Could not save', {
        description: err instanceof Error ? err.message : 'Update failed',
      }),
  })

  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
      <CardContent className="space-y-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background shadow-none">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">AI automation</h2>
              {project && (
                <Badge variant="secondary" className="gap-1 font-medium">
                  {project.name}
                </Badge>
              )}
            </div>
            <p className="max-w-xl text-sm text-muted-foreground">
              Post-step AI that runs after test-case generation and QC runs, per project. Disable a
              step or pick a cheaper/stronger model for it.
            </p>
          </div>
        </div>

        {!project ? (
          <p className="rounded-2xl border border-border/60 bg-muted/60 px-3 py-3 text-sm text-muted-foreground">
            Select a project in the sidebar to configure its AI automation.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <AutomationRow
              icon={<ShieldCheck className="h-4 w-4" />}
              title="Grounding check"
              description="Independent audit re-checks generated test cases against the ticket, and QC report verdicts against the documented evidence — silently revising to drop hallucinated content."
              enabled={project.groundingCheck ?? true}
              model={project.groundingCheckModel ?? 'haiku'}
              busy={save.isPending}
              onToggle={(v) => save.mutate({ groundingCheck: v })}
              onModel={(m) => save.mutate({ groundingCheckModel: m })}
            />
            <AutomationRow
              icon={<Sparkles className="h-4 w-4" />}
              title="Auto-learn"
              description="After a run, reflects on what happened and captures durable facts into the project's Memory / Knowledge so future QC work is better informed."
              enabled={project.autoLearn ?? true}
              model={project.autoLearnModel ?? 'haiku'}
              busy={save.isPending}
              onToggle={(v) => save.mutate({ autoLearn: v })}
              onModel={(m) => save.mutate({ autoLearnModel: m })}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function AutomationRow(props: {
  icon: ReactNode
  title: string
  description: string
  enabled: boolean
  model: string
  busy: boolean
  onToggle: (v: boolean) => void
  onModel: (m: string) => void
}) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border/60 bg-muted/60 px-3 py-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl bg-background text-muted-foreground">
        {props.icon}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold tracking-tight">{props.title}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{props.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Select
          value={props.model}
          onValueChange={props.onModel}
          disabled={!props.enabled || props.busy}
        >
          <SelectTrigger className="h-8 w-[104px] rounded-full text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTOMATION_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={() => props.onToggle(!props.enabled)}
          className={cn(
            'h-8 w-[68px] shrink-0 rounded-full px-3 text-xs transition-all duration-200 active:scale-[0.98]',
            props.enabled
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'text-muted-foreground',
          )}
        >
          {props.busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : props.enabled ? (
            'On'
          ) : (
            'Off'
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * Restart the whole portal server in place. Kicks off a detached
 * `qc-portal --restart` on the machine, then waits for the server to go down and
 * come back healthy before reloading the page. Only actually restarts when the
 * portal was launched via `qc-portal` (a supervised, PID-tracked process); under
 * `npm run dev` the launcher no-ops, so we just reload after a short grace window.
 */
function RestartAppCard() {
  const [open, setOpen] = useState(false)
  const [restarting, setRestarting] = useState(false)

  /** Poll /api/health until the server bounces (down → up), then reload. */
  async function waitForRestartAndReload() {
    const startedAt = Date.now()
    let sawDown = false
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const elapsed = Date.now() - startedAt
      if (elapsed > 120_000) {
        toast.error('Restart is taking too long', {
          description: 'The server has not come back. Reload the page manually once it is up.',
        })
        setRestarting(false)
        return
      }
      const up = await pingHealth()
      if (!up) sawDown = true
      // Server bounced and is healthy again — reload into the fresh process.
      if (sawDown && up) {
        window.location.reload()
        return
      }
      // Never went down within the grace window → nothing to restart (e.g. dev
      // mode or already-latest). Reload anyway; it's harmless.
      if (!sawDown && elapsed > 8_000) {
        window.location.reload()
        return
      }
      await new Promise((r) => setTimeout(r, 800))
    }
  }

  const restart = useMutation({
    mutationFn: triggerRestart,
    onSuccess: (res) => {
      if (!res.ok) {
        toast.error('Could not restart', { description: res.error ?? 'Unknown error' })
        return
      }
      setOpen(false)
      setRestarting(true)
      toast.info('Restarting QC Portal…', { description: 'The page will reload automatically.' })
      void waitForRestartAndReload()
    },
    onError: (err) =>
      toast.error('Could not restart', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <>
      <Card data-tour="restart-app" className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background shadow-none">
              <Power className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <h2 className="text-base font-semibold tracking-tight">Restart app</h2>
              <p className="max-w-xl text-sm text-muted-foreground">
                Stop and relaunch the QC Portal server on this machine — useful after changing
                settings, MCP servers, or when something seems stuck. The page reloads on its own
                once it's back.
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={restarting || restart.isPending}
            className="shrink-0 gap-1.5 rounded-full transition-all duration-200 hover:shadow-sm active:scale-[0.98]"
          >
            {restarting || restart.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            {restarting ? 'Restarting…' : 'Restart app'}
          </Button>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(o) => !restart.isPending && setOpen(o)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl border border-amber-300/40 bg-amber-100 text-amber-700">
                <RotateCw className="size-5" />
              </span>
              <div className="space-y-1 text-left">
                <DialogTitle>Restart QC Portal?</DialogTitle>
                <DialogDescription>
                  The server stops and starts again on the same port. Any in-flight QC run, crawl,
                  or test-case job will be interrupted.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <ul className="space-y-1.5 text-[13px] text-muted-foreground">
            <li className="flex gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              Make sure nothing important is running — background jobs won't resume after the
              restart.
            </li>
            <li className="flex gap-2">
              <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
              This page reloads automatically once the server is healthy again.
            </li>
          </ul>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={restart.isPending}
              className="rounded-full transition-all duration-200 active:scale-[0.98]"
            >
              Cancel
            </Button>
            <Button
              onClick={() => restart.mutate()}
              disabled={restart.isPending}
              className="rounded-full bg-amber-600 text-white transition-all duration-200 hover:bg-amber-700 active:scale-[0.98]"
            >
              {restart.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCw className="size-4" />
              )}
              Restart now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export default function ProjectsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })
  const { activeProjectId } = useProjects()
  const [query, setQuery] = useState('')
  const tabParam = searchParams.get('tab')
  const activeTab = tabParam === 'models' ? 'models' : 'projects'

  function onTabChange(value: string) {
    if (value !== 'projects' && value !== 'models') return
    const next = new URLSearchParams(searchParams)
    next.set('tab', value)
    setSearchParams(next)
  }

  const stats = useMemo(() => {
    const list = data ?? []
    return {
      total: list.length,
      ready: list.filter((p) => p.hasSkills && p.hasMcp && p.hasClaudeMd).length,
      missing: list.filter((p) => p.exists === false).length,
      activeName: list.find((p) => p.id === activeProjectId)?.name ?? '—',
    }
  }, [data, activeProjectId])

  const filtered = useMemo(() => {
    const list = data ?? []
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) || p.rootPath.toLowerCase().includes(q),
    )
  }, [data, query])

  const hasProjects = !isLoading && !isError && data && data.length > 0

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
            <Settings className="size-5" />
          </span>
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Manage the repo folders QC runs against and the Claude Code models used for AI
              workflows.
            </p>
          </div>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-6">
        <TabsList data-tour="settings-tabs" className="grid h-auto w-full grid-cols-1 gap-3 rounded-none bg-transparent p-0 sm:grid-cols-2">
          <TabsTrigger
            value="projects"
            className="group h-auto justify-start gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-left shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted/60 hover:shadow-sm data-[state=active]:border-foreground data-[state=active]:bg-muted/60 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground transition-colors group-data-[state=active]:border-transparent group-data-[state=active]:bg-foreground group-data-[state=active]:text-background">
              <FolderGit2 className="size-5" />
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block text-sm font-semibold tracking-tight">Projects</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                Folders, setup, active repo
              </span>
            </span>
            <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
              {stats.total}
            </Badge>
          </TabsTrigger>
          <TabsTrigger
            value="models"
            className="group h-auto justify-start gap-3 rounded-2xl border border-border/60 bg-card px-4 py-3 text-left shadow-none transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:bg-muted/60 hover:shadow-sm data-[state=active]:border-foreground data-[state=active]:bg-muted/60 data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-muted/60 text-muted-foreground transition-colors group-data-[state=active]:border-transparent group-data-[state=active]:bg-foreground group-data-[state=active]:text-background">
              <Cpu className="size-5" />
            </span>
            <span className="min-w-0 flex-1 space-y-0.5">
              <span className="block text-sm font-semibold tracking-tight">AI models</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                Claude Code model tests
              </span>
            </span>
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              3 models
            </Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="projects" className="space-y-6">
          <section data-tour="project-controls" className="overflow-hidden rounded-3xl border border-border/60 bg-card shadow-none">
            <div className="flex flex-col gap-4 bg-muted/40 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <h2 className="text-lg font-semibold tracking-tight">Projects</h2>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  Add repo folders, choose the active workspace, and track setup readiness.
                </p>
              </div>
              <div data-tour="project-actions" className="flex shrink-0 items-center gap-2">
                <ImportProjectDialog />
                <AddProjectDialog watchAddParam />
              </div>
            </div>

            {hasProjects && (
              <div data-tour="project-readiness" className="grid gap-3 p-4 sm:grid-cols-3">
                <StatTile icon={FolderGit2} label="Registered" value={stats.total} />
                <StatTile
                  icon={CheckCircle2}
                  label="Active project"
                  value={<span className="truncate">{stats.activeName}</span>}
                  tone="primary"
                />
                <StatTile
                  icon={stats.missing > 0 ? AlertCircle : Check}
                  label={stats.missing > 0 ? 'Folders not found' : 'Fully configured'}
                  value={stats.missing > 0 ? stats.missing : stats.ready}
                  tone={stats.missing > 0 ? 'amber' : 'emerald'}
                />
              </div>
            )}

            {hasProjects && data.length > 3 && (
              <div data-tour="project-search" className="flex flex-col gap-3 border-t border-border/60 bg-muted/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative w-full max-w-md">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Filter by name or path…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-11 rounded-full pl-9 shadow-none"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Showing {filtered.length} of {data.length}
                </p>
              </div>
            )}
          </section>

          {isLoading && (
            <div data-tour="project-cards" className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          )}

          {isError && (
            <div className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error instanceof Error ? error.message : 'Failed to load projects'}</span>
            </div>
          )}

          {hasProjects && filtered.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
              {filtered.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}

          {hasProjects && filtered.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 rounded-3xl border border-dashed border-border/60 bg-muted/40 px-6 py-12 text-center">
              <Search className="h-6 w-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No projects match <span className="font-medium text-foreground">“{query}”</span>.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setQuery('')}
                className="rounded-full transition-all duration-200 active:scale-[0.98]"
              >
                Clear filter
              </Button>
            </div>
          )}

          {!isLoading && !isError && data && data.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border/60 bg-muted/40 px-6 py-14 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-border/60 bg-muted/60 text-muted-foreground shadow-none">
                <FolderGit2 className="h-6 w-6" />
              </span>
              <div className="space-y-1">
                <h2 className="text-base font-medium tracking-tight">No projects yet</h2>
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                  Register your first repo folder, or import one from a .zip.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <ImportProjectDialog />
                <AddProjectDialog />
              </div>
            </div>
          )}

          <RestartAppCard />
        </TabsContent>

        <TabsContent value="models" className="space-y-6">
          <section className="rounded-3xl border border-border/60 bg-card p-5 shadow-none">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">AI models</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Check Claude Code availability and test which model fits quick checks, default QC,
                or deeper reasoning work.
              </p>
            </div>
          </section>
          <AiRuntimeCard />
          <AiAutomationCard />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ProjectCardSkeleton() {
  return (
    <Card className="overflow-hidden rounded-3xl border-border/60 py-0 shadow-none">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-5">
        <div className="flex-1 space-y-2">
          <div className="flex items-center gap-2">
            <span className="h-8 w-8 animate-pulse rounded-xl bg-muted" />
            <span className="h-4 w-32 animate-pulse rounded bg-muted" />
          </div>
          <span className="ml-10 block h-3 w-48 animate-pulse rounded bg-muted" />
        </div>
        <div className="flex gap-1">
          <span className="h-9 w-9 animate-pulse rounded-full bg-muted" />
          <span className="h-9 w-9 animate-pulse rounded-full bg-muted" />
        </div>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/40 px-5 py-4">
        <div className="flex gap-1.5">
          <span className="h-7 w-16 animate-pulse rounded-full bg-muted" />
          <span className="h-7 w-12 animate-pulse rounded-full bg-muted" />
          <span className="h-7 w-20 animate-pulse rounded-full bg-muted" />
        </div>
        <span className="h-8 w-24 animate-pulse rounded-full bg-muted" />
      </CardContent>
    </Card>
  )
}
