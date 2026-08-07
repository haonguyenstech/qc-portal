import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Columns3, KeyRound, Table2, Type } from 'lucide-react'
import { cn } from '@/lib/utils'
import { highlightCode } from '@/lib/highlight'
import {
  applySuggestion,
  completionContext,
  suggest,
  type SchemaTable,
  type Suggestion,
} from '@/lib/sql-complete'

/**
 * The SQL editor on the Database page: line numbers, syntax colours, and schema-aware
 * completion, over a plain <textarea>.
 *
 * It is a textarea on purpose. A code-editor dependency (CodeMirror et al) is ~200 KB
 * for one panel on one page, and the repo already owns the two pieces this needs —
 * `lib/highlight.ts` (lazy highlight.js, SQL registered) and the keyboard-menu pattern
 * from the chat composer's `@` picker. The textarea also keeps native undo, spellcheck
 * control, IME and accessibility for free, which a contenteditable rewrite loses.
 *
 * HOW THE PAINTING WORKS — the three layers must agree or the caret drifts:
 *   gutter | <pre> (coloured, aria-hidden) | <textarea> (transparent text, real caret)
 * The pre and the textarea share font, size, line-height, padding and `whitespace-pre`,
 * and the textarea's scroll is mirrored onto both siblings. NO WRAPPING: with wrapped
 * lines a gutter can't line up (one logical line becomes N visual rows), so long lines
 * scroll horizontally the way every SQL client does.
 */

const FONT = 'font-mono text-[12.5px] leading-[1.5rem]'
const PAD = 'px-3 py-2'

const KIND_ICON: Record<Suggestion['kind'], typeof Table2> = {
  table: Table2,
  column: Columns3,
  keyword: Type,
}

export interface SqlEditorProps {
  value: string
  onChange: (next: string) => void
  /** ⌘/Ctrl+Enter. Not called while the suggestion menu is open. */
  onRun?: () => void
  tables: SchemaTable[]
  placeholder?: string
  rows?: number
  disabled?: boolean
  className?: string
}

export function SqlEditor({
  value,
  onChange,
  onRun,
  tables,
  placeholder,
  rows = 8,
  disabled,
  className,
}: SqlEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const codeRef = useRef<HTMLElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const [caret, setCaret] = useState(0)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // Highlighting arrives a beat after mount (lazy highlight.js import), so it is
  // STAMPED with the code it was produced from and only painted when that still
  // matches. Otherwise a fast typist sees the previous frame's markup under a newer
  // caret — and, worse, `value` and the coloured layer disagree on width, which drags
  // the caret out of alignment. Derived during render rather than cleared in an
  // effect: an effect that setStates on every keystroke is the cascading-render bug
  // this codebase bans.
  const [painted, setPainted] = useState<{ code: string; html: string } | null>(null)
  const html = painted?.code === value ? painted.html : null

  useEffect(() => {
    if (!value) return
    let alive = true
    void highlightCode(value, 'sql').then((h) => {
      if (alive && h) setPainted({ code: value, html: h })
    })
    return () => {
      alive = false
    }
  }, [value])

  const items = useMemo(
    () => (open && tables.length ? suggest({ text: value, caret, tables }) : []),
    [open, value, caret, tables],
  )
  const ctx = useMemo(() => completionContext(value, caret), [value, caret])

  // Clamp rather than reset: filtering as you type shrinks the list, and snapping the
  // highlight back to the top each keystroke makes it impossible to arrow down to a match.
  const activeIndex = Math.min(active, Math.max(0, items.length - 1))
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, items.length])

  /**
   * Mirror the textarea's scroll onto the layers underneath by TRANSLATING them, not
   * by assigning `scrollTop`/`scrollLeft`.
   *
   * Measured: with a long line the textarea grows a horizontal scrollbar, which eats
   * 15 px of its own client height (217 vs the pre's 232) while both have the same
   * scrollHeight. The pre therefore has a max scroll of 0, so `pre.scrollTop = 15`
   * clamped to 0 and the coloured text sat a scrollbar's height away from the caret at
   * the bottom of the box. A transform has no such ceiling, so the layers stay locked
   * together whatever the platform does about scrollbar width.
   */
  const syncScroll = useCallback(() => {
    const ta = taRef.current
    if (!ta) return
    const shift = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`
    if (codeRef.current) codeRef.current.style.transform = shift
    if (gutterRef.current) gutterRef.current.style.transform = `translateY(${-ta.scrollTop}px)`
  }, [])
  // After the value changes the layers re-render; re-mirror before paint or the
  // coloured layer lags a frame behind the caret on fast typing.
  useLayoutEffect(syncScroll, [value, html, syncScroll])

  const accept = (s: Suggestion) => {
    const ta = taRef.current
    if (!ta) return
    const next = applySuggestion(value, ctx, ta.selectionStart, s)
    onChange(next.text)
    setOpen(false)
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(next.caret, next.caret)
      setCaret(next.caret)
    })
  }

  const trackCaret = () => {
    const ta = taRef.current
    if (ta) setCaret(ta.selectionStart)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const menu = open && items.length > 0
    // ⌘/Ctrl+Enter runs regardless — checked first so an open menu can't swallow it.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      setOpen(false)
      onRun?.()
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
      e.preventDefault()
      trackCaret()
      setOpen(true)
      setActive(0)
      return
    }
    if (menu) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % items.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + items.length) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        accept(items[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        return
      }
    }
    // Tab with no menu indents instead of leaving the field — a two-space indent is
    // what makes a multi-line query readable, and tabbing out of a code box is a
    // surprise. Shift+Tab still moves focus, so the editor is never a keyboard trap.
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      const ta = e.currentTarget
      const at = ta.selectionStart
      const next = value.slice(0, at) + '  ' + value.slice(ta.selectionEnd)
      onChange(next)
      requestAnimationFrame(() => {
        ta.setSelectionRange(at + 2, at + 2)
        setCaret(at + 2)
      })
    }
  }

  const lineCount = useMemo(() => value.split('\n').length, [value])
  const height = `calc(${Math.max(rows, Math.min(lineCount, 24))} * 1.5rem + 1rem)`

  return (
    <div
      className={cn(
        'relative rounded-2xl border border-border/60 bg-muted/40 transition-colors focus-within:border-border',
        disabled && 'opacity-60',
        className,
      )}
    >
      <div className="flex" style={{ height }}>
        {/* Gutter — follows the text vertically, never horizontally. */}
        <div
          aria-hidden
          className={cn(
            'w-10 shrink-0 overflow-hidden border-r border-border/50 py-2 text-right',
            FONT,
            'select-none text-muted-foreground/40',
          )}
        >
          <div ref={gutterRef}>
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i} className="pr-2 tabular-nums">
                {i + 1}
              </div>
            ))}
          </div>
        </div>

        <div className="relative min-w-0 flex-1">
          <pre
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre',
              FONT,
              PAD,
              'text-foreground',
            )}
          >
            {html ? (
              <code
                ref={codeRef}
                className="block origin-top-left"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              <code ref={codeRef} className="block origin-top-left">
                {value}
              </code>
            )}
          </pre>
          <textarea
            ref={taRef}
            value={value}
            disabled={disabled}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={placeholder}
            aria-label="SQL query"
            aria-autocomplete="list"
            aria-expanded={open && items.length > 0}
            onChange={(e) => {
              onChange(e.target.value)
              setCaret(e.target.selectionStart)
              setActive(0)
              setOpen(true)
            }}
            onKeyDown={onKeyDown}
            onKeyUp={trackCaret}
            onClick={trackCaret}
            onScroll={syncScroll}
            onBlur={() => setOpen(false)}
            className={cn(
              'absolute inset-0 h-full w-full resize-none overflow-auto whitespace-pre bg-transparent',
              FONT,
              PAD,
              // The <pre> underneath is what you read; this layer only holds the caret
              // and the selection. Placeholder still needs a visible colour.
              'text-transparent caret-foreground outline-none placeholder:text-muted-foreground/60',
              'selection:bg-primary/25',
            )}
          />

          {open && items.length > 0 && (
            <SuggestionMenu
              ref={listRef}
              items={items}
              activeIndex={activeIndex}
              onPick={accept}
              onHover={setActive}
            />
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * The completion menu. Anchored under the editor rather than at the caret: the caret's
 * pixel position in a textarea can only be had by rendering a mirror element, and on a
 * box this small a fixed position under it never covers what you're typing anyway.
 *
 * `onMouseDown` + preventDefault, not onClick — the textarea's blur closes the menu,
 * and blur fires before click, so a clicked row would unmount before it registered.
 */
const SuggestionMenu = memo(
  ({
    ref,
    items,
    activeIndex,
    onPick,
    onHover,
  }: {
    ref: React.Ref<HTMLDivElement>
    items: Suggestion[]
    activeIndex: number
    onPick: (s: Suggestion) => void
    onHover: (i: number) => void
  }) => (
    <div
      ref={ref}
      role="listbox"
      aria-label="SQL suggestions"
      className="absolute left-2 right-2 top-full z-30 mt-1 max-h-64 overflow-auto rounded-2xl border border-border/60 bg-popover p-1 shadow-lg"
    >
      {items.map((s, i) => {
        const Icon = KIND_ICON[s.kind]
        return (
          <div
            key={`${s.kind}:${s.label}:${s.from ?? ''}`}
            role="option"
            aria-selected={i === activeIndex}
            data-active={i === activeIndex}
            onMouseDown={(e) => {
              e.preventDefault()
              onPick(s)
            }}
            onMouseEnter={() => onHover(i)}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-xs',
              i === activeIndex ? 'bg-accent text-accent-foreground' : 'text-foreground',
            )}
          >
            <Icon
              className={cn(
                'size-3.5 shrink-0',
                s.kind === 'table'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : s.kind === 'column'
                    ? 'text-sky-600 dark:text-sky-400'
                    : 'text-muted-foreground',
              )}
            />
            <span className="truncate font-mono">{s.label}</span>
            {s.from && (
              <span className="truncate text-[10px] text-muted-foreground">{s.from}</span>
            )}
            {s.detail && (
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/80">
                {s.detail}
              </span>
            )}
          </div>
        )
      })}
    </div>
  ),
)
SuggestionMenu.displayName = 'SuggestionMenu'

/**
 * The schema browser beside the editor: every table, searchable, expanding to its
 * columns. Clicking inserts the name at the caret — the point is that you can find a
 * column you half-remember without leaving the page or guessing at completion.
 */
export function SchemaBrowser({
  tables,
  onInsert,
  onSelectTable,
  loading,
  error,
}: {
  tables: SchemaTable[]
  onInsert: (text: string) => void
  onSelectTable: (table: SchemaTable) => void
  loading?: boolean
  error?: string | null
}) {
  const [q, setQ] = useState('')
  const [openTable, setOpenTable] = useState<string | null>(null)

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return tables
    // A table matches on its own name OR on a column's, and a column match auto-reveals
    // the table — otherwise searching for a column name returns a collapsed row that
    // looks like it doesn't contain what you searched for.
    return tables.filter(
      (t) =>
        t.name.toLowerCase().includes(needle) ||
        t.columns.some((c) => c.name.toLowerCase().includes(needle)),
    )
  }, [tables, q])

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border border-border/60 bg-muted/30">
      <div className="border-b border-border/50 p-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tables & columns…"
          className="h-8 w-full rounded-xl border border-border/60 bg-background px-2.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-border"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {loading && <p className="px-2 py-3 text-xs text-muted-foreground">Reading the schema…</p>}
        {error && !loading && (
          <p className="px-2 py-3 text-xs text-muted-foreground">
            Schema unavailable — you can still run SQL. {error}
          </p>
        )}
        {!loading && !error && shown.length === 0 && (
          <p className="px-2 py-3 text-xs text-muted-foreground">No table or column matches.</p>
        )}
        {shown.map((t) => {
          const isOpen = openTable === t.name
          const needle = q.trim().toLowerCase()
          const cols = needle
            ? t.columns.filter((c) => c.name.toLowerCase().includes(needle))
            : t.columns
          return (
            <div key={t.name}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setOpenTable(isOpen ? null : t.name)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 rounded-xl px-2 py-1 text-left text-xs transition-colors hover:bg-accent"
                  title={`${t.columns.length} columns`}
                >
                  <Table2
                    className={cn(
                      'size-3.5 shrink-0',
                      t.kind === 'view'
                        ? 'text-violet-600 dark:text-violet-400'
                        : 'text-emerald-600 dark:text-emerald-400',
                    )}
                  />
                  <span className="truncate font-mono">{t.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">
                    {t.columns.length}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onSelectTable(t)}
                  className="shrink-0 rounded-lg px-1.5 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  title={`Preview the first rows of ${t.name}`}
                >
                  Preview
                </button>
              </div>
              {(isOpen || (needle && cols.length > 0 && cols.length < t.columns.length)) && (
                <div className="mb-1 ml-4 border-l border-border/50 pl-2">
                  {cols.map((c) => (
                    <button
                      key={c.name}
                      type="button"
                      onClick={() => onInsert(c.name)}
                      className="flex w-full items-center gap-1.5 rounded-lg px-2 py-0.5 text-left text-[11px] transition-colors hover:bg-accent"
                      title={`${c.type}${c.nullable ? ' · nullable' : ''}`}
                    >
                      {c.key === 'PK' ? (
                        <KeyRound className="size-3 shrink-0 text-amber-500" />
                      ) : (
                        <Columns3 className="size-3 shrink-0 text-sky-600/70 dark:text-sky-400/70" />
                      )}
                      <span className="truncate font-mono">{c.name}</span>
                      <span className="ml-auto shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">
                        {c.type}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
