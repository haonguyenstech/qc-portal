// The API-testing assistant — a chat box docked to the /api-testing page.
//
// Why it exists: importing a page scan or a handful of cURLs leaves a collection where
// every request carries the same hardcoded host and the same pasted `Authorization:
// Bearer eyJ…`. Making that runnable — one `{{baseUrl}}`, a login request that CAPTURES
// the token, then a flow in the right order — is mechanical work done request by request.
// This box does that work as PROPOSALS the engineer reads and clicks.
//
// The rule that shapes the whole file: **the assistant never writes anything.** The
// server side (`POST /api/api-tests/assistant`) runs read-only and returns typed
// proposals; applying one happens HERE, through the very same client functions the manual
// UI uses (`saveApiEnvironments`, `saveApiRequest`, `saveApiFlow`). So a proposal cannot
// reach disk without passing the existing validation, secret-merging and path guarding —
// and cannot reach disk at all until someone looks at it and presses Apply.
//
// Attachments follow the Chat page: images go up as base64 (the server writes them for
// the length of one turn so the CLI can Read them, then deletes them), documents are
// converted to markdown in the BROWSER with the same `convertFileToMarkdown` pipeline
// Knowledge uses, so a spec or an exported Postman doc can be pasted in as text.

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import {
  Check,
  FileText,
  ImageIcon,
  Loader2,
  Paperclip,
  Route,
  Send,
  Sparkles,
  Variable,
  Wand2,
  X,
  Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  askApiAssistant,
  getApiEnvironments,
  saveApiEnvironments,
  saveApiFlow,
  saveApiRequest,
  type ApiAssistProposal,
  type ApiFlowHook,
  type ApiFlowStep,
  type ApiRequestDef,
} from '@/lib/api'
import { convertFileToMarkdown, KNOWLEDGE_ACCEPT, MAX_FILE_BYTES } from '@/lib/docConvert'
import { cn } from '@/lib/utils'

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_IMAGES = 4
const MAX_DOCS = 4
/** Kept in step with the server's `ASSIST_MAX_MESSAGES` — it replays the transcript. */
const MAX_TURNS = 24

const MD_CLASS = cn(
  'text-sm leading-relaxed',
  '[&_h1]:mt-0 [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold',
  '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-sm [&_h2]:font-semibold',
  '[&_h3]:mt-3 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-4',
  '[&_li]:my-0.5',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre]:text-[11px] [&_pre>code]:bg-transparent [&_pre>code]:p-0 [&_pre>code]:text-zinc-100',
)

/** An image staged for the next message: a data URL to preview, base64 bytes to send. */
interface StagedImage {
  name: string
  mime: string
  dataUrl: string
  data: string
}

interface StagedDoc {
  name: string
  markdown: string
}

interface Turn {
  role: 'user' | 'assistant'
  text: string
  /** Assistant turns only — the reviewable changes offered with this answer. */
  proposals?: ApiAssistProposal[]
  /** What the engineer attached to a user turn, for the transcript to show. */
  attachments?: string[]
}

function readImage(file: File): Promise<StagedImage> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('could not be read'))
    fr.onload = () => {
      const dataUrl = String(fr.result ?? '')
      const comma = dataUrl.indexOf(',')
      if (comma === -1) return reject(new Error('could not be read'))
      resolve({
        name: file.name || 'pasted screenshot',
        mime: file.type,
        dataUrl,
        data: dataUrl.slice(comma + 1),
      })
    }
    fr.readAsDataURL(file)
  })
}

function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`
}

function toHook(requestName: string): ApiFlowHook {
  return { id: newId('h'), requestName, enabled: true, continueOnFail: false }
}

function toStep(requestName: string): ApiFlowStep {
  return {
    id: newId('s'),
    requestName,
    enabled: true,
    continueOnFail: false,
    before: [],
    after: [],
  }
}

// ------------------------------------------------------------------ proposal cards

const PROPOSAL_LOOK: Record<
  ApiAssistProposal['kind'],
  { icon: typeof Variable; label: string; verb: string }
> = {
  'set-variables': { icon: Variable, label: 'Environment variables', verb: 'Add variables' },
  'update-request': { icon: Wand2, label: 'Rewrite request', verb: 'Apply to request' },
  'add-captures': { icon: Zap, label: 'Capture from response', verb: 'Add captures' },
  'create-flow': { icon: Route, label: 'Flow', verb: 'Create flow' },
}

/** One-line title, so the card says what it touches before the details are read. */
function proposalTitle(p: ApiAssistProposal): string {
  switch (p.kind) {
    case 'set-variables':
      return `${p.vars.length} variable${p.vars.length === 1 ? '' : 's'} → “${p.env}”`
    case 'update-request':
      return `“${p.name}”`
    case 'add-captures':
      return `${p.captures.length} capture${p.captures.length === 1 ? '' : 's'} → “${p.name}”`
    case 'create-flow':
      return `“${p.name}” · ${p.steps.length} step${p.steps.length === 1 ? '' : 's'}`
  }
}

/**
 * The details, spelled out. A proposal is only reviewable if what it will write is on
 * screen — a card that just said "rewrite 4 requests" would be a permission prompt, not
 * a review. A secret variable shows its KEY and that it is secret, never its value.
 */
function ProposalDetail({ p }: { p: ApiAssistProposal }) {
  const row = 'flex items-baseline gap-2 py-0.5 font-mono text-[11px]'
  if (p.kind === 'set-variables') {
    return (
      <div className="space-y-0">
        {p.vars.map((v) => (
          <div key={v.key} className={row}>
            <span className="shrink-0 font-semibold text-foreground">{v.key}</span>
            <span className="min-w-0 truncate text-muted-foreground">
              {v.secret ? '•••••• (stored as a secret)' : v.value || '(empty)'}
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (p.kind === 'update-request') {
    return (
      <div className="space-y-0">
        {p.url != null && (
          <div className={row}>
            <span className="shrink-0 font-semibold text-foreground">URL</span>
            <span className="min-w-0 break-all text-muted-foreground">{p.url}</span>
          </div>
        )}
        {p.headers?.map((h, i) => (
          <div key={`${h.key}-${i}`} className={row}>
            <span className="shrink-0 font-semibold text-foreground">{h.key}</span>
            <span className="min-w-0 break-all text-muted-foreground">{h.value}</span>
          </div>
        ))}
        {p.body != null && (
          <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-muted/60 p-2 text-[11px] leading-relaxed">
            {p.body}
          </pre>
        )}
      </div>
    )
  }
  if (p.kind === 'add-captures') {
    return (
      <div className="space-y-0">
        {p.captures.map((c) => (
          <div key={c.varName} className={row}>
            <span className="shrink-0 text-muted-foreground">{c.jsonPath}</span>
            <span className="shrink-0 text-muted-foreground">→</span>
            <span className="shrink-0 font-semibold text-foreground">{`{{${c.varName}}}`}</span>
            {c.secret && <span className="shrink-0 text-[10px] text-amber-600">secret</span>}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="space-y-1 text-[11px]">
      {p.setup.length > 0 && (
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Setup:</span> {p.setup.join(' → ')}
        </p>
      )}
      <ol className="list-decimal space-y-0.5 pl-4 font-mono">
        {p.steps.map((s, i) => (
          <li key={`${s}-${i}`} className="text-muted-foreground">
            {s}
          </li>
        ))}
      </ol>
      {p.teardown.length > 0 && (
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">Teardown:</span> {p.teardown.join(' → ')}
        </p>
      )}
    </div>
  )
}

function ProposalCard({
  p,
  state,
  onApply,
}: {
  p: ApiAssistProposal
  state: 'idle' | 'applying' | 'applied'
  onApply: () => void
}) {
  const look = PROPOSAL_LOOK[p.kind]
  const Icon = look.icon
  return (
    <div
      className={cn(
        'space-y-2 rounded-2xl border border-border/60 bg-background p-3 transition-all duration-200',
        state === 'applied' && 'border-emerald-500/40 bg-emerald-500/5',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3" />
            {look.label}
          </span>
          <p className="truncate text-xs font-medium">{proposalTitle(p)}</p>
        </div>
        <Button
          size="sm"
          variant={state === 'applied' ? 'outline' : 'default'}
          disabled={state !== 'idle'}
          onClick={onApply}
          className="h-7 shrink-0 gap-1.5 rounded-full px-2.5 text-[11px] active:scale-[0.98]"
        >
          {state === 'applying' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : state === 'applied' ? (
            <Check className="size-3" />
          ) : null}
          {state === 'applied' ? 'Applied' : look.verb}
        </Button>
      </div>
      {p.note && <p className="text-[11px] leading-relaxed text-muted-foreground">{p.note}</p>}
      <ProposalDetail p={p} />
    </div>
  )
}

// ------------------------------------------------------------------ the chat box

const SUGGESTIONS = [
  'Pull the shared host and token out of my requests into environment variables',
  'Which request is the login? Capture its token as a variable the others can use',
  'Build a flow out of what I just imported, in a sensible order',
]

export function ApiAssistantChat({
  projectId,
  saved,
  onFlowCreated,
}: {
  projectId: string
  saved: ApiRequestDef[]
  /** Lets the page hop to the Flows tab once a proposed flow actually exists. */
  onFlowCreated?: (name: string) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [model, setModel] = useState('sonnet')
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [images, setImages] = useState<StagedImage[]>([])
  const [docs, setDocs] = useState<StagedDoc[]>([])
  const [converting, setConverting] = useState(false)
  const [busy, setBusy] = useState(false)
  // Keyed by `${turnIndex}:${proposalIndex}` — a proposal is applied once, and the card
  // has to keep saying so after the transcript grows.
  const [applied, setApplied] = useState<Record<string, 'applying' | 'applied'>>({})
  const scrollRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, busy, open])

  const addImages = useCallback((files: File[]) => {
    for (const f of files) {
      void readImage(f)
        .then((img) => setImages((cur) => (cur.length >= MAX_IMAGES ? cur : [...cur, img])))
        .catch((err: Error) =>
          toast.error('Could not attach that image', { description: err.message }),
        )
    }
  }, [])

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
      if (!files.length) return // plain text paste — leave it to the textarea
      e.preventDefault()
      addImages(files)
    },
    [addImages],
  )

  /** One entry point for every way a file arrives: images stay bytes, the rest becomes text. */
  const attach = useCallback(
    async (files: File[]) => {
      const pics = files.filter((f) => f.type.startsWith('image/'))
      const rest = files.filter((f) => !f.type.startsWith('image/'))
      if (pics.length) addImages(pics)
      if (!rest.length) return
      setConverting(true)
      const ok: StagedDoc[] = []
      const failed: string[] = []
      for (const file of rest) {
        if (file.size > MAX_FILE_BYTES) {
          failed.push(`${file.name} (too large)`)
          continue
        }
        try {
          const doc = await convertFileToMarkdown(file)
          if (!doc.markdown.trim()) {
            failed.push(`${file.name} (no text found)`)
            continue
          }
          ok.push({ name: file.name, markdown: doc.markdown })
        } catch (err) {
          failed.push(`${file.name} (${(err as Error).message})`)
        }
      }
      setConverting(false)
      if (ok.length) setDocs((cur) => [...cur, ...ok].slice(0, MAX_DOCS))
      if (failed.length) {
        toast.error(`Could not attach ${failed.length} file${failed.length === 1 ? '' : 's'}`, {
          description: failed.join(', '),
        })
      }
    },
    [addImages],
  )

  const send = async (question?: string) => {
    const text = (question ?? input).trim()
    if (!text || busy) return
    const attachments = [...images.map((i) => i.name), ...docs.map((d) => d.name)]
    const history: Turn[] = [...turns, { role: 'user', text, attachments }]
    setTurns(history)
    setInput('')
    const sendingImages = images
    const sendingDocs = docs
    setImages([])
    setDocs([])
    setBusy(true)
    try {
      const r = await askApiAssistant({
        projectId,
        model,
        messages: history.slice(-MAX_TURNS).map((t) => ({ role: t.role, text: t.text })),
        images: sendingImages.length
          ? sendingImages.map((i) => ({ mime: i.mime, data: i.data }))
          : undefined,
        docs: sendingDocs.length ? sendingDocs : undefined,
      })
      if (!r.ok) {
        // The question stays in the transcript and the failure is shown as the answer —
        // losing what was asked because the model timed out is the worse outcome.
        setTurns([
          ...history,
          { role: 'assistant', text: r.error ?? 'The assistant could not answer.' },
        ])
        return
      }
      setTurns([
        ...history,
        { role: 'assistant', text: r.reply ?? '', proposals: r.proposals ?? [] },
      ])
    } catch (err) {
      setTurns([...history, { role: 'assistant', text: (err as Error).message }])
    } finally {
      setBusy(false)
    }
  }

  /**
   * Apply one proposal through the ordinary client functions. Nothing here is a new write
   * path: `set-variables` re-PUTs the whole environments file (so the server's
   * empty-secret merge still protects stored secrets), `update-request` / `add-captures`
   * re-PUT the saved request with only the proposed fields changed, and `create-flow`
   * saves a flow exactly as the Flows tab would.
   */
  const applyProposal = async (key: string, p: ApiAssistProposal) => {
    setApplied((cur) => ({ ...cur, [key]: 'applying' }))
    try {
      if (p.kind === 'set-variables') {
        const file = await getApiEnvironments(projectId)
        const envs = file.environments.map((e) => ({
          name: e.name,
          variables: e.variables.map((v) => ({ key: v.key, value: v.value, secret: v.secret })),
        }))
        let target = envs.find((e) => e.name === p.env)
        if (!target) {
          target = { name: p.env, variables: [] }
          envs.push(target)
        }
        for (const v of p.vars) {
          const at = target.variables.findIndex((x) => x.key === v.key)
          if (at >= 0) target.variables[at] = v
          else target.variables.push(v)
        }
        await saveApiEnvironments(projectId, {
          active: file.active ?? p.env,
          environments: envs,
        })
        await queryClient.invalidateQueries({ queryKey: ['api-environments', projectId] })
        toast.success(`${p.vars.length} variable${p.vars.length === 1 ? '' : 's'} saved to “${p.env}”`)
      } else if (p.kind === 'update-request' || p.kind === 'add-captures') {
        const def = saved.find((s) => s.name === p.name)
        if (!def) throw new Error(`“${p.name}” is no longer in the collection`)
        const captures =
          p.kind === 'add-captures'
            ? [
                ...def.captures.filter((c) => !p.captures.some((n) => n.varName === c.varName)),
                ...p.captures.map((c) => ({ id: newId('c'), ...c })),
              ]
            : def.captures
        await saveApiRequest(projectId, def.name, {
          group: def.group,
          method: def.method,
          url: p.kind === 'update-request' ? (p.url ?? def.url) : def.url,
          query: def.query,
          headers: p.kind === 'update-request' ? (p.headers ?? def.headers) : def.headers,
          bodyMode: p.kind === 'update-request' ? (p.bodyMode ?? def.bodyMode) : def.bodyMode,
          body: p.kind === 'update-request' ? (p.body ?? def.body) : def.body,
          assertions: def.assertions,
          aiExpect: def.aiExpect,
          captures,
        })
        await queryClient.invalidateQueries({ queryKey: ['api-requests', projectId] })
        toast.success(`“${p.name}” updated`)
      } else {
        await saveApiFlow(projectId, p.name, {
          description: p.description,
          stopOnFail: true,
          auth: { accountLabel: '', totpLabel: '' },
          setup: p.setup.map(toHook),
          steps: p.steps.map(toStep),
          teardown: p.teardown.map(toHook),
        })
        await queryClient.invalidateQueries({ queryKey: ['api-flows', projectId] })
        toast.success(`Flow “${p.name}” created`, {
          description: 'Open the Flows tab to run it.',
          action: onFlowCreated
            ? { label: 'Open', onClick: () => onFlowCreated(p.name) }
            : undefined,
        })
      }
      setApplied((cur) => ({ ...cur, [key]: 'applied' }))
    } catch (err) {
      setApplied((cur) => {
        const next = { ...cur }
        delete next[key] // failed — leave the button clickable, don't pretend it landed
        return next
      })
      toast.error('Could not apply that', { description: (err as Error).message })
    }
  }

  const staged = images.length + docs.length
  const canSend = useMemo(() => input.trim().length > 0 && !busy, [input, busy])

  if (!open) {
    // Stacked ABOVE the page's "Guide tour" button (App's RouteGuideTour, fixed bottom-5
    // right-5) rather than on top of it — both are always-on-screen page affordances, so
    // they queue up the corner instead of hiding each other.
    return (
      <Button
        onClick={() => setOpen(true)}
        className="fixed bottom-16 right-5 z-40 h-11 gap-2 rounded-full px-5 shadow-lg transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.98]"
        title="Ask AI to set up variables, captures and flows for these requests"
        data-tour="api-assistant"
      >
        <Sparkles className="size-4" />
        Ask AI
      </Button>
    )
  }

  return (
    // z-50 (not z-40) because the Guide tour button is a later sibling in App's tree at
    // the same layer, and would otherwise paint over the open panel.
    <div
      className="fixed bottom-5 right-5 z-50 flex h-[min(680px,calc(100vh-6rem))] w-[min(440px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-3xl border border-border/60 bg-card shadow-lg"
      data-tour="api-assistant"
    >
      {/* Header — what it can see, and the model it will spend. */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold tracking-tight">API assistant</p>
          <p className="truncate text-[11px] text-muted-foreground">
            Reads your collection, variables and flows
          </p>
        </div>
        <Select value={model} onValueChange={setModel}>
          <SelectTrigger className="h-7! w-fit gap-1.5 px-2.5 text-xs focus:ring-0! [&_svg]:size-3.5!">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="haiku">Haiku</SelectItem>
            <SelectItem value="sonnet">Sonnet</SelectItem>
            <SelectItem value="opus">Opus</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setOpen(false)}
          className="size-7 shrink-0 rounded-full"
          title="Close"
        >
          <X className="size-4" />
        </Button>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {turns.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              It already knows what you have saved — {saved.length} request
              {saved.length === 1 ? '' : 's'}, your environments and your flows. Ask it to wire
              them up, and apply what it proposes with one click. Paste a screenshot or attach a
              spec if the answer is in there.
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void send(s)}
                  className="w-full rounded-2xl border border-border/60 bg-muted/40 px-3 py-2 text-left text-xs transition-all duration-200 hover:-translate-y-0.5 hover:border-border hover:shadow-sm active:scale-[0.98]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] space-y-1 rounded-2xl bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground">
                <p className="whitespace-pre-wrap break-words">{t.text}</p>
                {!!t.attachments?.length && (
                  <p className="flex flex-wrap gap-1 text-[10px] opacity-80">
                    {t.attachments.map((a, k) => (
                      <span key={k} className="inline-flex items-center gap-1">
                        <Paperclip className="size-2.5" />
                        {a}
                      </span>
                    ))}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div key={i} className="space-y-2">
              <div className={MD_CLASS}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{t.text}</ReactMarkdown>
              </div>
              {t.proposals?.map((p, k) => (
                <ProposalCard
                  key={k}
                  p={p}
                  state={applied[`${i}:${k}`] ?? 'idle'}
                  onApply={() => void applyProposal(`${i}:${k}`, p)}
                />
              ))}
            </div>
          ),
        )}

        {busy && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Reading your collection…
          </p>
        )}
      </div>

      {/* Composer */}
      <div className="space-y-2 border-t border-border/60 p-3">
        {staged > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {images.map((img, i) => (
              <span
                key={`i${i}`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/60 py-1 pl-1 pr-2 text-[11px]"
              >
                <img src={img.dataUrl} alt="" className="size-5 rounded-lg object-cover" />
                <span className="max-w-28 truncate">{img.name}</span>
                <button
                  type="button"
                  onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {docs.map((d, i) => (
              <span
                key={`d${i}`}
                className="inline-flex items-center gap-1.5 rounded-xl border border-border/60 bg-muted/60 px-2 py-1 text-[11px]"
              >
                <FileText className="size-3 text-muted-foreground" />
                <span className="max-w-28 truncate">{d.name}</span>
                <button
                  type="button"
                  onClick={() => setDocs((cur) => cur.filter((_, k) => k !== i))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder="Ask about these requests, or paste a screenshot…"
          className="max-h-40 min-h-16 resize-none rounded-2xl text-sm field-sizing-content"
        />
        <div className="flex items-center justify-between gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={`${KNOWLEDGE_ACCEPT},${IMAGE_MIMES.join(',')}`}
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              e.target.value = ''
              void attach(files)
            }}
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={converting}
            className="h-7 gap-1.5 rounded-full px-2 text-[11px] text-muted-foreground"
            title="Attach a screenshot, a spec, or an exported collection"
          >
            {converting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Paperclip className="size-3.5" />
            )}
            Attach
          </Button>
          <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <ImageIcon className="size-3" />
            Screenshots and files welcome
          </span>
          <Button
            size="icon"
            onClick={() => void send()}
            disabled={!canSend}
            className="size-8 shrink-0 rounded-full active:scale-[0.98]"
            title="Send (Enter)"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
