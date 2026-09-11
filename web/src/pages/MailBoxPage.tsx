import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Check,
  Copy,
  Dices,
  ExternalLink,
  Inbox,
  KeyRound,
  Link2,
  Loader2,
  Mail,
  Maximize2,
  Minimize2,
  Paperclip,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  deleteMail,
  getMailbox,
  listMail,
  readMail,
  resetMailbox,
  setMailboxAddress,
  type MailSummary,
} from '@/lib/api'
import {
  MAIL_DOMAINS,
  decodeEntities,
  findCodes,
  findLinks,
  mailText,
  randomMailName,
  splitAddress,
} from '@/lib/mailbox'

/**
 * Mail headers arrive entity-encoded whenever they are not pure ASCII — a Vietnamese
 * subject reaches us as `Xin ch&agrave;o`. These four fields are printed as plain text
 * (list row, detail header, the new-mail toast), so they are decoded ONCE here, at the
 * query, rather than at each render site where the next one added would forget.
 */
function decodeHeaders<T extends MailSummary>(mail: T): T {
  return {
    ...mail,
    from: decodeEntities(mail.from),
    subject: decodeEntities(mail.subject),
    excerpt: decodeEntities(mail.excerpt),
  }
}

/**
 * MailBox — a throwaway inbox, inside the portal.
 *
 * What it is for: the sign-up flow that mails a code, the "confirm your email" link,
 * the password reset. The alternative is a second browser tab on a public mail site,
 * the address retyped by hand, and the six digits retyped again — which is where they
 * get retyped WRONG, and a passing flow gets filed as a bug.
 *
 * It is NOT yopmail, which is what everyone asks for. YOPmail publishes no API: an
 * inbox URL without the tokens their own JavaScript computes answers HTTP 400, and
 * `x-frame-options: sameorigin` blocks embedding the real site. Guerrilla Mail has a
 * documented JSON API and the same "make up an address, it already exists" model. See
 * `server/src/mailbox.ts`.
 */

/** Never faster than the service's floor (server `MIN_POLL_MS`), and slow enough to read. */
const REFRESH_MS = 15_000

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  return {
    copied,
    copy: (value: string, label = 'Copied') => {
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(value)
          toast.success(label, { description: value.length > 60 ? undefined : value })
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(null), 2000)
        },
        () => toast.error('Could not copy to the clipboard'),
      )
    },
  }
}

/**
 * The mail body, prepared for the frame.
 *
 * Two different jobs, and doing one of them to the other's mail is what makes a test
 * mailbox look unlike Gmail:
 *
 * - **A real HTML mail** (it brought its own `<html>`/`<body>`/table layout) is left
 *   ALONE apart from an image cap. It was authored to look a certain way in a mail
 *   client; a font or padding of ours is a difference between what QC sees here and
 *   what the customer sees in Gmail, which is exactly the thing being checked.
 * - **A plain-text mail** arrives wrapped in a bare `<pre>`, which does not wrap: with
 *   no styling it scrolls sideways off the panel and the code at the end of the line is
 *   the part you cannot see. That one gets a readable font, padding and wrapping.
 *
 * The style block goes FIRST either way, so anything the mail declares still wins, and
 * the frame stays `sandbox=""`.
 */
function frameDoc(body: string): string {
  if (!body) return '<p style="color:#666;font-family:sans-serif;padding:12px">(empty message)</p>'
  const rich = /<(html|body|table|div|center)\b/i.test(body)
  const style = rich
    ? // Only a cap on runaway images — a 1200px hero would otherwise force a sideways
      // scrollbar the recipient's mail client would not show.
      '<style>img{max-width:100%;height:auto}</style>'
    : '<style>html,body{margin:0;padding:12px;background:#fff;color:#111;' +
      "font:14px/1.5 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}" +
      'pre{white-space:pre-wrap;word-break:break-word;font-size:13px;margin:0}' +
      'img{max-width:100%;height:auto}a{color:#1a56db}</style>'
  return style + body
}

/** `HH:MM:SS` from the service, or an ISO stamp — show a time either way. */
function mailTime(date: string): string {
  if (!date) return ''
  const parsed = new Date(date)
  if (!Number.isNaN(parsed.getTime()) && date.includes('T')) return parsed.toLocaleString()
  return date
}

/**
 * The same stamp for a list row, where seconds are noise: `13:58:20` reads as a
 * number to decode rather than a time to glance at.
 */
function mailTimeShort(date: string): string {
  if (!date) return ''
  const parsed = new Date(date)
  if (!Number.isNaN(parsed.getTime()) && date.includes('T')) {
    return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  const hhmm = /^(\d{1,2}:\d{2})(:\d{2})?$/.exec(date.trim())
  return hhmm ? hhmm[1] : date
}

/** First letter of the sender, for the row's avatar. `Name <a@b.c>` and `a@b.c` both work. */
function senderInitial(from: string): string {
  const letter = /[a-z0-9]/i.exec(from ?? '')
  return letter ? letter[0].toUpperCase() : '?'
}

function MessageRow({
  mail,
  active,
  onPick,
}: {
  mail: MailSummary
  active: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        'flex w-full gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors duration-150',
        active
          ? 'border-primary/40 bg-primary/[0.07]'
          : 'border-transparent hover:border-border/60 hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
          active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {senderInitial(mail.from)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm',
              mail.read ? 'font-medium' : 'font-semibold',
            )}
          >
            {mail.subject || '(no subject)'}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {mailTimeShort(mail.date)}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          {/* Unread is the one thing worth a colour in this list: it answers "did the
              mail I am waiting for just land?" without reading anything. */}
          {!mail.read && <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{mail.from}</span>
        </span>
        {mail.excerpt && (
          <span className="mt-1 line-clamp-2 text-xs text-muted-foreground/70">{mail.excerpt}</span>
        )}
      </span>
    </button>
  )
}

export default function MailBoxPage() {
  const queryClient = useQueryClient()
  const { copied, copy } = useCopy()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [domain, setDomain] = useState<string>(MAIL_DOMAINS[0])
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState('')
  /**
   * Tall mode for the body frame. A fixed height is unavoidable — the frame is an
   * opaque origin (that is the whole point of `sandbox=""`), so its content height
   * cannot be measured to size it automatically. A marketing mail is easily 2000px, so
   * this is the escape hatch instead of an inner scrollbar and a lot of dragging.
   */
  const [tall, setTall] = useState(false)

  const box = useQuery({ queryKey: ['mailbox'], queryFn: getMailbox })
  const inbox = useQuery({
    queryKey: ['mailbox', 'messages'],
    queryFn: listMail,
    refetchInterval: REFRESH_MS,
    // A QC engineer starts a sign-up in another tab and comes back — the mail must
    // already be here, so keep polling while this tab is in the background.
    refetchIntervalInBackground: true,
    select: (data) => ({ ...data, messages: data.messages.map(decodeHeaders) }),
  })
  const detail = useQuery({
    queryKey: ['mailbox', 'message', selectedId],
    queryFn: () => readMail(selectedId!),
    enabled: !!selectedId,
    // Headers only — `body` stays exactly as the service sent it, because the preview
    // frame renders it as HTML and decoding it here would turn `&lt;b&gt;` into markup
    // the sender never wrote.
    select: (mail) => ({ ...decodeHeaders(mail), to: decodeEntities(mail.to) }),
  })

  // Memoised: it is a dependency of the new-mail effect below, and a fresh []
  // every render would re-run that effect on every render.
  const messages = useMemo(() => inbox.data?.messages ?? [], [inbox.data])
  const unreadCount = useMemo(() => messages.filter((m) => !m.read).length, [messages])
  /**
   * Prefer the POLLED address, not the one-shot `mailbox` query.
   *
   * `box` is fetched once on mount; `inbox` refetches every 15s and carries the address
   * with it. A session dies after about an hour and the server revives it, so the
   * address on screen can outlive the inbox it names — and this page's whole output is
   * an address someone pastes into a sign-up form. Observed live: the card read
   * `qc-lilac-koi-2377` while the open mail's `to` was already `qc-olive-heron-0575`.
   * Reading the polled value first makes that self-heal on the next tick.
   */
  const address = inbox.data?.address ?? box.data?.address ?? ''
  const user = useMemo(() => splitAddress(address).user, [address])
  /** What the engineer hands to the app under test — every domain reaches this box. */
  const handout = user ? `${user}@${domain}` : ''

  // Announce mail as it lands: this page is often open in a background tab while the
  // sign-up happens elsewhere, and "did it arrive?" is the whole question.
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!inbox.data) return
    const ids = new Set(messages.map((m) => m.id))
    if (known.current === null) {
      known.current = ids // first load is history, not news
      return
    }
    const fresh = messages.filter((m) => !known.current!.has(m.id))
    known.current = ids
    for (const m of fresh) toast.success('New mail', { description: `${m.from} — ${m.subject}` })
    // Opening the newest automatically is the point: nobody comes here to browse.
    if (fresh.length && !selectedId) setSelectedId(fresh[0].id)
  }, [inbox.data, messages, selectedId])

  const rename = useMutation({
    mutationFn: setMailboxAddress,
    onSuccess: (res) => {
      setRenaming(false)
      queryClient.setQueryData(['mailbox'], (prev: typeof box.data) =>
        prev ? { ...prev, address: res.address } : prev,
      )
      void queryClient.invalidateQueries({ queryKey: ['mailbox'] })
      toast.success('Address changed', { description: res.address })
    },
    onError: (err: Error) => toast.error('Could not change the address', { description: err.message }),
  })
  const reset = useMutation({
    mutationFn: resetMailbox,
    onSuccess: (res) => {
      setSelectedId(null)
      known.current = null
      void queryClient.invalidateQueries({ queryKey: ['mailbox'] })
      toast.success('New inbox', { description: res.address })
    },
    onError: (err: Error) => toast.error('Could not start a new inbox', { description: err.message }),
  })
  const remove = useMutation({
    mutationFn: deleteMail,
    onSuccess: (_res, id) => {
      if (selectedId === id) setSelectedId(null)
      void queryClient.invalidateQueries({ queryKey: ['mailbox', 'messages'] })
    },
    onError: (err: Error) => toast.error('Could not delete that mail', { description: err.message }),
  })

  const body = detail.data?.body ?? ''
  const text = useMemo(() => (body ? mailText(body) : ''), [body])
  const codes = useMemo(() => (text ? findCodes(text) : []), [text])
  const links = useMemo(() => (body ? findLinks(body, text) : []), [body, text])

  return (
    // Fill the viewport so the list and the message each get a pane that scrolls on its
    // own, instead of one long page that scrolls as a whole. `tall` opts out: the body
    // frame then grows past the fold on purpose (see the toggle below).
    <div
      className={cn(
        'flex flex-col gap-4',
        !tall && 'lg:h-[calc(100svh-4rem)] lg:min-h-[34rem]',
      )}
    >
      <header className="flex shrink-0 items-start gap-3">
        <span className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-background">
          <Inbox className="size-5" />
        </span>
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">MailBox</h1>
          <p className="text-sm text-muted-foreground">
            A throwaway inbox for sign-up, OTP and reset-link testing — no account, and any
            address you make up already exists.
          </p>
        </div>
      </header>

      {/* The address, which is the only thing anyone came here for — so it gets its own
          row and is never truncated: a half-shown address is a mistyped sign-up form. */}
      <div className="shrink-0 rounded-3xl border border-border/60 bg-muted/40 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          {renaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (draftName.trim()) rename.mutate(draftName.trim())
              }}
            >
              <Input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="checkout-otp"
                className="h-9 max-w-xs font-mono text-sm"
              />
              {/* Fills the field rather than applying, so a rolled name can still be
                  tweaked before it becomes the address. */}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraftName(randomMailName())}
                aria-label="Roll a random name"
                title="Roll a random name"
              >
                <Dices className="size-4" />
              </Button>
              <span className="text-sm text-muted-foreground">@{domain}</span>
              <Button type="submit" size="sm" disabled={!draftName.trim() || rename.isPending}>
                {rename.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <>
              {/* Local part and domain read as one address, with the picker attached to
                  the half it actually changes. `break-all`, never `truncate`: the whole
                  string has to be readable to be retyped or checked by eye. */}
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
                  <button
                    type="button"
                    onClick={() => handout && copy(handout, 'Address copied')}
                    title="Copy this address"
                    disabled={!handout}
                    className="max-w-full rounded-lg break-all px-1 text-left font-mono text-xl font-medium leading-tight transition-colors hover:bg-muted disabled:pointer-events-none"
                  >
                    {box.isLoading ? (
                      <span className="text-muted-foreground">Getting an address…</span>
                    ) : (
                      user || '—'
                    )}
                  </button>

                  <Select value={domain} onValueChange={setDomain}>
                    <SelectTrigger
                      size="sm"
                      className="w-fit gap-1.5 border-dashed font-mono text-base"
                      aria-label="Domain"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MAIL_DOMAINS.map((d) => (
                        <SelectItem key={d} value={d} className="font-mono">
                          @{d}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <p className="px-1 text-xs text-muted-foreground">
                  Click the address to copy it · every domain reaches this same inbox
                </p>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {/* Copy is why the page exists, so it is the only solid button here. */}
                <Button
                  size="sm"
                  onClick={() => handout && copy(handout, 'Address copied')}
                  disabled={!handout}
                >
                  {copied === handout ? <Check className="size-4" /> : <Copy className="size-4" />}
                  Copy address
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDraftName(user)
                    setRenaming(true)
                  }}
                  disabled={!address}
                >
                  <Pencil className="size-4" />
                  Rename
                </Button>
                {/* A random name in one click. Not just convenience: this service is
                    public and any name can be claimed by anyone, so a hand-typed `test1`
                    is an inbox somebody else may already be reading. Same session — the
                    mail already in the box stays, unlike "New inbox". */}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => rename.mutate(randomMailName())}
                  disabled={!address || rename.isPending}
                  title="Give this inbox a fresh random name"
                >
                  {rename.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Dices className="size-4" />
                  )}
                  Random
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => reset.mutate()}
                  disabled={reset.isPending}
                  title="Abandon this inbox and take a brand new address"
                >
                  {reset.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Sparkles className="size-4" />
                  )}
                  New inbox
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {(box.error || inbox.error) && (
        <p className="rounded-2xl border border-red-500/40 bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          {(box.error as Error | null)?.message ?? (inbox.error as Error).message}
        </p>
      )}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_1fr]">
        {/* The list. Its count/refresh row lives INSIDE the card so this column and the
            message column start on the same line, and the rows scroll on their own. */}
        <div className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-card">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
            <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {/* A live inbox that polls silently looks broken when nothing arrives —
                  the dot is the difference between "waiting" and "not working". */}
              <span className="relative flex size-1.5" aria-hidden>
                {inbox.isFetching && (
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
                )}
                <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
              </span>
              {messages.length} message{messages.length === 1 ? '' : 's'}
              {unreadCount > 0 && ` · ${unreadCount} new`}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void inbox.refetch()}
              disabled={inbox.isFetching}
            >
              <RefreshCw className={cn('size-3.5', inbox.isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 max-lg:max-h-80">
            {messages.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <Mail className="mx-auto size-7 text-muted-foreground/50" />
                <p className="mt-3 text-sm font-medium">Waiting for mail</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Send something to the address above — this list refreshes itself every 15
                  seconds, including while you're on another tab.
                </p>
              </div>
            ) : (
              messages.map((m) => (
                <MessageRow
                  key={m.id}
                  mail={m}
                  active={m.id === selectedId}
                  onPick={() => setSelectedId(m.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* The message */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-3xl border border-border/60 bg-card">
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                <Inbox className="size-6" />
              </span>
              <div className="space-y-1">
                <p className="text-sm font-medium">Nothing open</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  {/* Layout-neutral wording: the list is beside this pane on a wide screen
                      and above it on a narrow one. */}
                  Open a message to read it. Any code or confirmation link it contains is
                  pulled out and put at the top, ready to copy.
                </p>
              </div>
            </div>
          ) : detail.isLoading ? (
            <p className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Opening…
            </p>
          ) : detail.error ? (
            <p className="flex flex-1 items-center justify-center p-8 text-center text-sm text-red-600 dark:text-red-400">
              {(detail.error as Error).message}
            </p>
          ) : (
            /* `overflow-y-auto`, not `hidden`: on a short window the header, the extracted
               strip and the body frame's floor add up to more than the pane, and clipping
               them silently cuts the bottom off the mail. Given spare height `flex-1` on
               the frame still fills the pane and no scrollbar appears. */
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <div className="flex shrink-0 items-start gap-3 border-b border-border/60 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <h2 className="text-base font-semibold leading-snug tracking-tight">
                    {detail.data?.subject || '(no subject)'}
                  </h2>
                  <p className="truncate text-xs text-muted-foreground">
                    <span className="text-foreground/80">{detail.data?.from}</span> →{' '}
                    {detail.data?.to} · {mailTime(detail.data?.date ?? '')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => selectedId && remove.mutate(selectedId)}
                  disabled={remove.isPending}
                  aria-label="Delete this message"
                  title="Delete this message"
                >
                  {remove.isPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>

              {/* The two things worth extracting, pinned above the body: copying the OTP
                  is the job, reading the mail is only how you used to get it. Ranked,
                  never filtered — hiding the real code sends the engineer back to
                  reading raw HTML, which is the thing this page exists to replace. */}
              {(codes.length > 0 || links.length > 0) && (
                <div className="shrink-0 space-y-3 border-b border-border/60 bg-muted/30 px-4 py-3">
                  {codes.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                        <KeyRound className="size-3.5" />
                        Code
                      </span>
                      {codes.map((c, i) => (
                        <button
                          key={c.value}
                          type="button"
                          onClick={() => copy(c.value, 'Code copied')}
                          title={c.context}
                          className={cn(
                            'inline-flex items-center gap-2 rounded-xl border bg-background font-mono font-semibold transition-colors',
                            // The best-ranked code is the one being waited for; the
                            // runners-up stay reachable but stop competing with it.
                            i === 0
                              ? 'border-primary/40 px-3 py-1.5 text-xl tracking-[0.12em] hover:bg-primary/5'
                              : 'border-border/60 px-2.5 py-1 text-sm tracking-wide text-muted-foreground hover:bg-muted',
                          )}
                        >
                          {c.value}
                          {copied === c.value ? (
                            <Check
                              className={cn('text-emerald-500', i === 0 ? 'size-4' : 'size-3.5')}
                            />
                          ) : (
                            <Copy
                              className={cn(
                                'text-muted-foreground',
                                i === 0 ? 'size-4' : 'size-3.5',
                              )}
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  )}

                  {links.length > 0 && (
                    <div className="space-y-1">
                      {links.map((l) => (
                        <div key={l.url} className="flex items-center gap-2">
                          <span className="flex w-[3.25rem] shrink-0 justify-start">
                            {l.action ? (
                              <span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                action
                              </span>
                            ) : (
                              <Link2 className="size-3.5 text-muted-foreground" />
                            )}
                          </span>
                          <a
                            href={l.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="min-w-0 flex-1 truncate font-mono text-xs text-primary hover:underline"
                          >
                            {l.url}
                          </a>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copy(l.url, 'Link copied')}
                            aria-label="Copy this link"
                          >
                            {copied === l.url ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5" />
                            )}
                          </Button>
                          <Button variant="ghost" size="sm" asChild aria-label="Open this link">
                            <a href={l.url} target="_blank" rel="noreferrer noopener">
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* SANDBOXED, and it must stay that way: this is HTML a stranger sent to a
                  public address, rendered inside a portal whose API can reach the
                  engineer's projects and database connections. No `allow-scripts`, no
                  `allow-same-origin` — with neither, the body cannot run JavaScript and
                  cannot read anything of ours even if it does. `srcDoc` (not a src URL)
                  keeps it out of the network too. */}
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-2">
                  {detail.data && detail.data.attachments > 0 ? (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Paperclip className="size-3.5" />
                      {detail.data.attachments} attachment
                      {detail.data.attachments === 1 ? '' : 's'} — not downloadable here yet
                    </p>
                  ) : (
                    <span />
                  )}
                  {/* The frame is an opaque origin (the point of `sandbox=""`), so its
                      content height cannot be measured to fit it. By default it fills
                      the pane and scrolls inside; `Taller` drops the page out of
                      viewport-height mode for a long marketing mail. */}
                  <Button variant="ghost" size="sm" onClick={() => setTall((t) => !t)}>
                    {tall ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
                    {tall ? 'Fit to pane' : 'Taller'}
                  </Button>
                </div>
                <iframe
                  title="Message body"
                  sandbox=""
                  srcDoc={frameDoc(body)}
                  className={cn(
                    'w-full border-t border-border/60 bg-white',
                    tall ? 'h-[85vh]' : 'min-h-64 flex-1',
                  )}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
