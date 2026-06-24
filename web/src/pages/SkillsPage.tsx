import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlignLeft,
  ArrowRight,
  Check,
  Copy,
  Eye,
  FileCode,
  FolderGit2,
  FolderInput,
  FolderOpen,
  FolderTree,
  Hash,
  Info,
  Loader2,
  Pencil,
  Plus,
  Save,
  Search,
  Trash2,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  createSkill,
  deleteSkill,
  getSkill,
  importSkill,
  listSkills,
  openSkillsFolder,
  saveSkillFile,
  updateSkill,
  uploadSkill,
} from '@/lib/api'
import { entriesFromDrop, readSkillDrop } from '@/lib/dropFolder'
import { useProjects } from '@/lib/project-context'
import type { SkillFile, SkillSummary } from '@/lib/types'

function SkillEditor({ skillName, projectId }: { skillName: string; projectId: string }) {
  const queryClient = useQueryClient()
  const { data: files, isLoading } = useQuery({
    queryKey: ['skill', projectId, skillName],
    queryFn: () => getSkill(skillName, projectId),
  })

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex gap-1.5 border-b bg-muted/30 px-3 py-2">
          <div className="h-7 w-28 animate-pulse rounded bg-muted" />
          <div className="h-7 w-24 animate-pulse rounded bg-muted/70" />
        </div>
        <div className="flex-1 animate-pulse bg-muted/40" />
      </div>
    )
  }

  if (!files || files.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center">
        <FileCode className="h-6 w-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No files in this skill.</p>
      </div>
    )
  }

  return (
    <Tabs defaultValue={files[0].name} className="flex h-full min-h-0 w-full flex-col gap-0">
      <TabsList className="flex h-auto w-full shrink-0 justify-start gap-0 overflow-x-auto rounded-none border-b bg-muted/30 p-0">
        {files.map((f) => (
          <TabsTrigger
            key={f.name}
            value={f.name}
            className="gap-1.5 rounded-none border-b-2 border-transparent px-3.5 py-2.5 font-mono text-xs text-muted-foreground transition-colors data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none"
          >
            <FileCode className="h-3.5 w-3.5" />
            {f.name}
          </TabsTrigger>
        ))}
      </TabsList>
      {files.map((f) => (
        <TabsContent
          key={f.name}
          value={f.name}
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <FileForm
            key={f.content}
            skillName={skillName}
            projectId={projectId}
            file={f}
            onSaved={() =>
              queryClient.invalidateQueries({ queryKey: ['skill', projectId, skillName] })
            }
          />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function FileForm({
  skillName,
  projectId,
  file,
  onSaved,
}: {
  skillName: string
  projectId: string
  file: SkillFile
  onSaved: () => void
}) {
  const [content, setContent] = useState(file.content)
  const dirty = content !== file.content

  const mutation = useMutation({
    mutationFn: () => saveSkillFile(skillName, file.name, content, projectId),
    onSuccess: () => {
      toast.success('File saved', { description: `${skillName}/${file.name} updated.` })
      onSaved()
    },
    onError: (err) =>
      toast.error('Failed to save', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const lineCount = content.split('\n').length
  const charCount = content.length
  const isMarkdown = /\.m/.test(file.name) && file.name.toLowerCase().endsWith('.md')

  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [copied, setCopied] = useState(false)

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
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
        <FileCode className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-xs font-medium">{file.name}</span>
        {dirty && (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
            Unsaved changes
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
            {lineCount} {lineCount === 1 ? 'line' : 'lines'} · {charCount} chars
          </span>

          {isMarkdown && (
            <div className="flex rounded-md border bg-background p-0.5">
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
          )}

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={copy}
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
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || content === file.content}
            className="active:scale-[0.98]"
          >
            {mutation.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save
          </Button>
        </div>
      </div>

      {mode === 'preview' && isMarkdown ? (
        <div className="min-h-0 flex-1 overflow-auto bg-card px-6 py-5">
          <div
            className={cn(
              'mx-auto max-w-3xl text-sm leading-relaxed',
              '[&_h1]:mt-0 [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight',
              '[&_h2]:mt-6 [&_h2]:mb-2 [&_h2]:border-b [&_h2]:pb-1 [&_h2]:text-lg [&_h2]:font-semibold',
              '[&_h3]:mt-5 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
              '[&_p]:my-2.5 [&_p]:text-muted-foreground',
              '[&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-5',
              '[&_li]:my-1 [&_li]:text-muted-foreground',
              '[&_a]:font-medium [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
              '[&_strong]:font-semibold [&_strong]:text-foreground',
              '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
              '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:bg-zinc-950 [&_pre]:p-4 [&_pre]:text-xs [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-zinc-100',
              '[&_blockquote]:border-l-2 [&_blockquote]:border-primary/40 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:italic',
              '[&_table]:my-3 [&_table]:w-full [&_table]:text-left [&_th]:border [&_th]:bg-muted/50 [&_th]:px-2 [&_th]:py-1 [&_th]:text-xs [&_th]:font-semibold [&_td]:border [&_td]:px-2 [&_td]:py-1 [&_td]:text-xs',
              '[&_hr]:my-5 [&_hr]:border-border',
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        </div>
      ) : (
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-none border-0 bg-muted/30 px-4 py-3 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 dark:bg-zinc-950/40"
        />
      )}
    </div>
  )
}

function NewSkillForm({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string
  onClose: () => void
  onCreated?: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const mutation = useMutation({
    mutationFn: () => createSkill(name.trim(), description.trim(), projectId),
    onSuccess: () => {
      toast.success('Skill created', { description: `${name} added.` })
      onCreated?.(name.trim())
      setName('')
      setDescription('')
      onClose()
      queryClient.invalidateQueries({ queryKey: ['skills', projectId] })
    },
    onError: (err) =>
      toast.error('Failed to create skill', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const importMutation = useMutation({
    mutationFn: () => importSkill(projectId),
    onSuccess: (res) => {
      if ('canceled' in res && res.canceled) return // user dismissed the picker
      toast.success('Skill imported', { description: `${res.name} added from your device.` })
      onCreated?.(res.name)
      onClose()
      queryClient.invalidateQueries({ queryKey: ['skills', projectId] })
    },
    onError: (err) =>
      toast.error('Failed to import skill', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  const [dragOver, setDragOver] = useState(false)
  const [reading, setReading] = useState(false)

  const uploadMutation = useMutation({
    mutationFn: (payload: { name: string; files: { path: string; content: string }[] }) =>
      uploadSkill(payload.name, payload.files, projectId),
    onSuccess: (res) => {
      toast.success('Skill imported', { description: `${res.name} added from the dropped folder.` })
      onCreated?.(res.name)
      onClose()
      queryClient.invalidateQueries({ queryKey: ['skills', projectId] })
    },
    onError: (err) =>
      toast.error('Failed to import skill', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  async function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    // Must read the items list synchronously before any await.
    const entries = entriesFromDrop(e.dataTransfer)
    if (entries.length === 0) return
    setReading(true)
    try {
      const drop = await readSkillDrop(entries)
      uploadMutation.mutate(drop)
    } catch (err) {
      toast.error('Could not read that folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setReading(false)
    }
  }

  const busy = importMutation.isPending || uploadMutation.isPending || reading

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) mutation.mutate()
      }}
      className="space-y-5"
    >
          {/* drag-and-drop a skill folder, or click to open the native picker */}
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && importMutation.mutate()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                e.preventDefault()
                importMutation.mutate()
              }
            }}
            onDragOver={(e) => {
              e.preventDefault()
              if (!dragOver) setDragOver(true)
            }}
            onDragLeave={(e) => {
              e.preventDefault()
              setDragOver(false)
            }}
            onDrop={onDrop}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
              dragOver
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/40 hover:bg-muted/40',
              busy && 'pointer-events-none opacity-70',
            )}
          >
            <span
              className={cn(
                'flex size-10 items-center justify-center rounded-xl transition-colors',
                dragOver ? 'bg-primary/15 text-primary' : 'bg-muted text-foreground',
              )}
            >
              {busy ? (
                <Loader2 className="size-5 animate-spin" />
              ) : (
                <FolderInput className="size-5" />
              )}
            </span>
            <div className="space-y-0.5">
              <p className="text-sm font-medium">
                {reading
                  ? 'Reading folder…'
                  : uploadMutation.isPending
                    ? 'Importing…'
                    : importMutation.isPending
                      ? 'Opening file explorer…'
                      : dragOver
                        ? 'Drop the folder to import'
                        : 'Drag a skill folder here'}
              </p>
              <p className="text-xs text-muted-foreground">
                or <span className="font-medium text-foreground">click to browse</span> · must
                contain SKILL.md
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or create from scratch</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-skill-name" className="flex items-center gap-1.5">
              <Hash className="size-3.5 text-muted-foreground" />
              Name
            </Label>
            <div className="group relative">
              <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
              <Input
                id="new-skill-name"
                placeholder="my-skill"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 pl-9 font-mono shadow-xs transition-shadow focus-visible:shadow-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Lowercase, hyphen-separated (e.g. login-flow).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-skill-desc" className="flex items-center gap-1.5">
              <AlignLeft className="size-3.5 text-muted-foreground" />
              Description
            </Label>
            <div className="group relative">
              <AlignLeft className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
              <Textarea
                id="new-skill-desc"
                placeholder="What this skill does…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="min-h-[5rem] pl-9 shadow-xs transition-shadow focus-visible:shadow-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              A short summary of what the skill checks.
            </p>
          </div>

          {/* action band */}
          <div className="-mx-6 -mb-6 flex flex-col gap-3 border-t bg-muted/40 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Info className="size-3.5" />
              Creates a SKILL.md scaffold in .claude/skills.
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="lg"
                disabled={mutation.isPending || !name.trim()}
                className="group h-11 px-6 text-sm font-semibold shadow-sm transition-all hover:shadow-md active:scale-[0.98]"
              >
                {mutation.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    <Plus className="size-4" />
                    Create skill
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
    </form>
  )
}

/** Trigger button + dialog wrapping the create/import skill form. */
function NewSkillDialog({
  projectId,
  onCreated,
}: {
  projectId: string
  onCreated?: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="group shadow-sm transition-all hover:shadow-md active:scale-[0.98]">
          <Plus className="size-4" />
          New skill
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <Wrench className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Create skill</DialogTitle>
              <DialogDescription>
                Scaffold a new QC skill for this project, or import an existing skill folder.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <NewSkillForm
          projectId={projectId}
          onClose={() => setOpen(false)}
          onCreated={onCreated}
        />
      </DialogContent>
    </Dialog>
  )
}

/** Button that reveals the project's .claude/skills folder in the OS file explorer. */
function OpenFolderButton({ projectId }: { projectId: string }) {
  const mutation = useMutation({
    mutationFn: () => openSkillsFolder(projectId),
    onSuccess: (res) =>
      toast.success('Opened skills folder', { description: res.path }),
    onError: (err) =>
      toast.error('Failed to open folder', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="shrink-0 gap-1.5 active:scale-[0.98]"
    >
      {mutation.isPending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <FolderOpen className="size-3.5" />
      )}
      Open folder
    </Button>
  )
}

function SkillsListSkeleton() {
  return (
    <ul className="space-y-1.5">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="space-y-2 rounded-lg border border-transparent px-3 py-2.5"
        >
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-3 w-full animate-pulse rounded bg-muted/60" />
        </li>
      ))}
    </ul>
  )
}

/** Dialog to rename a skill and edit its description (writes SKILL.md frontmatter). */
function EditSkillDialog({
  skill,
  projectId,
  onRenamed,
}: {
  skill: SkillSummary
  projectId: string
  onRenamed: (newName: string) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(skill.name)
  const [description, setDescription] = useState(skill.description)

  const trimmedName = name.trim()
  const dirty = trimmedName !== skill.name || description.trim() !== skill.description.trim()
  const canSave = !!trimmedName && dirty

  const mutation = useMutation({
    mutationFn: () =>
      updateSkill(
        skill.name,
        { name: trimmedName, description: description.trim() },
        projectId,
      ),
    onSuccess: (res) => {
      toast.success('Skill updated', { description: `${res.name} saved.` })
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['skills', projectId] })
      if (res.name !== skill.name) {
        queryClient.invalidateQueries({ queryKey: ['skill', projectId, skill.name] })
        onRenamed(res.name)
      } else {
        queryClient.invalidateQueries({ queryKey: ['skill', projectId, res.name] })
      }
    },
    onError: (err) =>
      toast.error('Failed to update skill', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          // Reset the form to the skill's current values each time it opens.
          setName(skill.name)
          setDescription(skill.description)
        }
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground active:scale-[0.98]"
      >
        <Pencil className="size-3.5" />
        Edit details
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-primary to-primary/85 text-primary-foreground shadow-sm ring-1 ring-black/5">
              <Pencil className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Edit skill</DialogTitle>
              <DialogDescription>
                Rename the skill or update its description. Renaming moves its folder in
                <span className="font-mono"> .claude/skills</span>.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSave) mutation.mutate()
          }}
          className="space-y-5"
        >
          <div className="space-y-2">
            <Label htmlFor="edit-skill-name" className="flex items-center gap-1.5">
              <Hash className="size-3.5 text-muted-foreground" />
              Name
            </Label>
            <div className="group relative">
              <Hash className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
              <Input
                id="edit-skill-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
                className="h-11 pl-9 font-mono shadow-xs transition-shadow focus-visible:shadow-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Lowercase, hyphen-separated (e.g. login-flow).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-skill-desc" className="flex items-center gap-1.5">
              <AlignLeft className="size-3.5 text-muted-foreground" />
              Description
            </Label>
            <div className="group relative">
              <AlignLeft className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
              <Textarea
                id="edit-skill-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this skill does…"
                className="min-h-[5rem] pl-9 shadow-xs transition-shadow focus-visible:shadow-sm"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Saved to the <span className="font-mono">description:</span> field in SKILL.md.
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={mutation.isPending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={!canSave || mutation.isPending}
              className="active:scale-[0.98]"
            >
              {mutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Type-to-confirm dialog that permanently deletes a skill folder from disk. */
function DeleteSkillDialog({
  skill,
  projectId,
  onDeleted,
}: {
  skill: SkillSummary
  projectId: string
  onDeleted: () => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const canDelete = confirmName === skill.name

  const mutation = useMutation({
    mutationFn: () => deleteSkill(skill.name, projectId),
    onSuccess: () => {
      toast.success('Skill deleted', { description: `${skill.name} removed.` })
      setOpen(false)
      setConfirmName('')
      queryClient.removeQueries({ queryKey: ['skill', projectId, skill.name] })
      queryClient.invalidateQueries({ queryKey: ['skills', projectId] })
      onDeleted()
    },
    onError: (err) =>
      toast.error('Failed to delete skill', {
        description: err instanceof Error ? err.message : 'Unknown error',
      }),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setConfirmName('')
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        className="h-7 shrink-0 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive active:scale-[0.98]"
      >
        <Trash2 className="size-3.5" />
        Delete
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-destructive/20 bg-destructive/10 text-destructive">
              <Trash2 className="size-5" />
            </span>
            <div className="space-y-1 text-left">
              <DialogTitle>Delete skill?</DialogTitle>
              <DialogDescription>
                This permanently removes the <span className="font-mono">{skill.name}</span> folder
                and all of its files from <span className="font-mono">.claude/skills</span>. This
                cannot be undone.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="truncate font-mono text-sm font-semibold">{skill.name}</div>
          {skill.description && (
            <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
              {skill.description}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="delete-skill-confirm">Type the skill name to confirm</Label>
          <Input
            id="delete-skill-confirm"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={skill.name}
            autoComplete="off"
            disabled={mutation.isPending}
          />
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={mutation.isPending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !canDelete}
          >
            {mutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            Delete skill
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default function SkillsPage() {
  const { activeProjectId, activeProject } = useProjects()
  const { data: skills, isLoading } = useQuery({
    queryKey: ['skills', activeProjectId],
    queryFn: () => listSkills(activeProjectId as string),
    enabled: !!activeProjectId,
  })
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const active = selected ?? skills?.[0]?.name ?? null
  const activeSkill = skills?.find((s) => s.name === active) ?? null
  const q = query.trim().toLowerCase()
  const filtered = q
    ? skills?.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
    : skills

  if (!activeProjectId) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
          <p className="text-sm text-muted-foreground">
            Edit the QC skill files that drive acceptance testing.
          </p>
        </header>
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Wrench className="h-6 w-6 text-muted-foreground" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">No project selected</p>
              <p className="max-w-xs text-sm text-muted-foreground">
                Choose a project in the sidebar to browse and edit its skills.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Skills</h1>
            <p className="text-sm text-muted-foreground">
              Edit the QC skill files that drive acceptance testing
              {activeProject ? ` for ${activeProject.name}` : ''}.
            </p>
          </div>
          <NewSkillDialog
            projectId={activeProjectId}
            onCreated={(name) => {
              setSelected(name)
              setQuery('')
            }}
          />
        </div>

        {/* Per-project context: makes it unmistakable which .claude/skills is being edited. */}
        {activeProject && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-card px-4 py-3 shadow-sm">
            <span className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-primary/20 bg-primary/10 text-primary">
                <FolderGit2 className="h-4 w-4" />
              </span>
              <span className="leading-tight">
                <span className="block text-[11px] uppercase tracking-wide text-muted-foreground">
                  Editing skills for
                </span>
                <span className="block text-sm font-semibold tracking-tight">
                  {activeProject.name}
                </span>
              </span>
            </span>
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <span
                className="flex min-w-0 items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 font-mono text-xs text-muted-foreground"
                title={`${activeProject.rootPath}/.claude/skills`}
              >
                <FolderTree className="h-3.5 w-3.5 shrink-0 text-primary/70" />
                <span className="truncate">{activeProject.rootPath}/.claude/skills</span>
                <span
                  className={cn(
                    'ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                    activeProject.hasSkills
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-amber-50 text-amber-700',
                  )}
                >
                  {activeProject.hasSkills ? 'exists' : 'new'}
                </span>
              </span>
              <OpenFolderButton projectId={activeProjectId} />
            </div>
          </div>
        )}
      </header>

      {/* IDE-style workspace: one panel, list rail + editor pane */}
      <div className="flex min-h-[34rem] flex-col overflow-hidden rounded-xl border bg-card shadow-sm lg:h-[calc(100svh-13rem)] lg:flex-row">
        {/* ── skills rail ── */}
        <aside className="flex w-full shrink-0 flex-col border-b lg:w-72 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <span className="text-sm font-semibold">Available skills</span>
            {skills && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                {skills.length}
              </span>
            )}
          </div>

          {!isLoading && skills && skills.length > 0 && (
            <div className="border-b p-2.5">
              <div className="group relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground transition-colors group-focus-within:text-primary" />
                <Input
                  placeholder="Search skills…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="h-9 pl-8 text-sm"
                />
              </div>
            </div>
          )}

          <div className="min-h-0 flex-1">
            {isLoading ? (
              <div className="p-2.5">
                <SkillsListSkeleton />
              </div>
            ) : skills && skills.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                  <Wrench className="h-5 w-5 text-muted-foreground" />
                </div>
                <div className="space-y-0.5">
                  <p className="text-sm font-medium">No skills yet</p>
                  <p className="text-xs text-muted-foreground">
                    Create your first skill to drive QC testing.
                  </p>
                </div>
              </div>
            ) : filtered && filtered.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                No skills match “{query}”.
              </p>
            ) : (
              <ScrollArea className="h-full">
                <ul className="space-y-1 p-2.5">
                  {filtered?.map((s) => {
                    const isActive = active === s.name
                    const fileCount = s.files.length
                    return (
                      <li key={s.name}>
                        <button
                          type="button"
                          onClick={() => setSelected(s.name)}
                          className={cn(
                            'group relative w-full overflow-hidden rounded-lg border px-3 py-2.5 text-left transition-all duration-200 active:scale-[0.99]',
                            isActive
                              ? 'border-primary/20 bg-primary/10 ring-1 ring-primary/40'
                              : 'border-transparent hover:-translate-y-0.5 hover:bg-muted/60',
                          )}
                        >
                          {/* left status accent rail */}
                          <span
                            className={cn(
                              'absolute inset-y-0 left-0 w-0.5 transition-colors duration-200',
                              isActive ? 'bg-primary' : 'bg-transparent group-hover:bg-border',
                            )}
                            aria-hidden
                          />
                          <div className="flex items-center gap-2">
                            <Wrench
                              className={cn(
                                'h-3.5 w-3.5 shrink-0 transition-colors',
                                isActive ? 'text-primary' : 'text-muted-foreground',
                              )}
                            />
                            <span className="truncate font-mono text-sm font-medium">
                              {s.name}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                            {s.description}
                          </p>
                          <div className="mt-1.5 flex items-center gap-1 text-[11px] text-muted-foreground/80">
                            <FileCode className="h-3 w-3" />
                            {fileCount} {fileCount === 1 ? 'file' : 'files'}
                          </div>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </ScrollArea>
            )}
          </div>
        </aside>

        {/* ── editor pane ── */}
        <section className="flex min-h-[24rem] min-w-0 flex-1 flex-col bg-muted/20 lg:min-h-0">
          {active ? (
            <>
              <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
                <Wrench className="size-4 shrink-0 text-primary" />
                {activeSkill && (
                  <div className="ml-auto flex items-center gap-1">
                    <EditSkillDialog
                      skill={activeSkill}
                      projectId={activeProjectId}
                      onRenamed={(newName) => {
                        setSelected(newName)
                        setQuery('')
                      }}
                    />
                    <DeleteSkillDialog
                      skill={activeSkill}
                      projectId={activeProjectId}
                      onDeleted={() => {
                        setSelected(null)
                        setQuery('')
                      }}
                    />
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1">
                <SkillEditor key={active} skillName={active} projectId={activeProjectId} />
              </div>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-20 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
                <Wrench className="h-6 w-6 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">No skill selected</p>
                <p className="max-w-xs text-sm text-muted-foreground">
                  Pick a skill from the list, or create a new one to get started.
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
