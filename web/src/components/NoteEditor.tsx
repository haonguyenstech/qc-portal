/**
 * Rich-text editor for note bodies — the shadcn/ui "editor" block (TipTap), adapted to
 * the portal's System-Style UI tokens and trimmed to what a QC note needs: block
 * formats, inline marks, lists, quotes, links, and code blocks with highlighting.
 *
 * Lazily imported (NotesPage `React.lazy`): TipTap + lowlight are heavy, and the
 * dialog is the only place that needs them — the notes grid and everything else
 * pay nothing until "Add Note" is opened.
 *
 * The body is stored as HTML (TipTap's output). Plain-text bodies written before the
 * editor existed are escaped + newline-bridged on the way in so they edit safely.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight } from 'lowlight'
import {
  Bold,
  Code,
  Code2,
  Italic,
  Link2,
  Link2Off,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Input } from '@/components/ui/input'
import { LOOKS_LIKE_HTML, escapeHtml } from '@/lib/noteHtml'

// Curated code-block languages — the same spirit as lib/highlight.ts: everything a
// QC note is likely to quote, nothing else. (Lives in this lazy chunk, not the bundle.)
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const lowlight = createLowlight({
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  php,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
})

function toEditorHtml(value: string): string {
  if (!value) return ''
  if (LOOKS_LIKE_HTML.test(value)) return value
  return escapeHtml(value).replace(/\n/g, '<br>')
}

export interface NoteEditorProps {
  /** Initial content — HTML from a previous edit, or plain text from a legacy note. */
  value: string
  /** Called with the current HTML ('' when the editor is empty). */
  onChange: (html: string) => void
  placeholder?: string
  /** Tailwind classes for the content area's minimum height. */
  minHeightClass?: string
  /**
   * Called when the editor opens/closes its own floating layer (the link popover).
   * A parent Radix Dialog must use this to suppress its Escape dismissal while the
   * popover is up — Radix listens for Escape on the document in the CAPTURE phase and
   * registers before this component mounts, so the popover cannot claim the key itself
   * (verified: Escape closed popover *and* dialog, discarding the unsaved note).
   */
  onNestedLayerChange?: (open: boolean) => void
}

function ToolbarButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active}
          disabled={disabled}
          // Keep the editor focused. mousedown moves focus to the button, and the
          // chain's .focus() only wins back for commands that CHANGE the document
          // (toggleBulletList, setHorizontalRule — ProseMirror re-renders and refocuses).
          // A mark toggle on a collapsed cursor only sets a stored mark, so focus stayed
          // on the button and everything typed next was dropped — verified: click Bold,
          // type "BOLD", document still read "hello" with aria-pressed already true.
          onMouseDown={(event) => event.preventDefault()}
          onClick={onClick}
          className={cn(
            'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
            active && 'bg-foreground/10 text-foreground',
            disabled && 'pointer-events-none opacity-40',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />
}

function FormatSelect({ editor }: { editor: Editor }) {
  const value = useEditorState({
    editor,
    selector: ({ editor }) => {
      // Same mid-lifecycle caveat as the main selector — isActive can throw while
      // TipTap swaps the editor instance, and the select must never crash for it.
      try {
        if (!editor || !editor.isActive('heading')) return 'p'
        return `h${editor.getAttributes('heading').level as number}`
      } catch {
        return 'p'
      }
    },
  })
  return (
    <select
      aria-label="Block format"
      value={value}
      onChange={(event) => {
        const level = event.target.value
        if (level === 'p') editor.chain().focus().setParagraph().run()
        else editor.chain().focus().toggleHeading({ level: Number(level.slice(1)) as 1 | 2 | 3 }).run()
      }}
      className="h-7 rounded-md border border-border/70 bg-background px-2 text-xs font-medium text-foreground outline-none transition-colors hover:border-border focus:border-foreground"
    >
      <option value="p">Paragraph</option>
      <option value="h1">Heading 1</option>
      <option value="h2">Heading 2</option>
      <option value="h3">Heading 3</option>
    </select>
  )
}

export default function NoteEditor({
  value,
  onChange,
  placeholder = 'Write something worth remembering…',
  minHeightClass = 'min-h-40',
  onNestedLayerChange,
}: NoteEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const linkRef = useRef<HTMLDivElement>(null)
  // Single place the popover's open state changes, so the parent is never told a stale value.
  const setLinkPopover = useCallback((open: boolean) => {
    setLinkOpen(open)
    onNestedLayerChange?.(open)
  }, [onNestedLayerChange])
  // Seed once per mount — the caller keys this component so add/edit re-mount it.
  const initial = useMemo(() => toEditorHtml(value), [value])

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }), // CodeBlockLowlight replaces it
      Underline,
      Link.configure({ openOnClick: false, autolink: true, defaultProtocol: 'https' }),
      Placeholder.configure({ placeholder }),
      CodeBlockLowlight.configure({ lowlight }),
    ],
    content: initial,
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
  })

  const state = useEditorState({
    editor,
    selector: ({ editor }) => {
      // useEditorState runs the selector on EVERY render, including the first one
      // (editor not created yet → null) and the instant TipTap swaps the editor
      // instance (non-null, but commandManager still null). Any of those must
      // yield a neutral toolbar, not a throw — hence the guard AND the try/catch.
      // `editor.can()` is deliberately NOT used here: it's the one call that
      // throws on the mid-lifecycle instance (verified).
      const neutral = { isBold: false, isItalic: false, isUnderline: false, isStrike: false, isCode: false, isCodeBlock: false, isBulletList: false, isOrderedList: false, isBlockquote: false, isLink: false }
      if (!editor) return neutral
      try {
        return {
          isBold: editor.isActive('bold'),
          isItalic: editor.isActive('italic'),
          isUnderline: editor.isActive('underline'),
          isStrike: editor.isActive('strike'),
          isCode: editor.isActive('code'),
          isCodeBlock: editor.isActive('codeBlock'),
          isBulletList: editor.isActive('bulletList'),
          isOrderedList: editor.isActive('orderedList'),
          isBlockquote: editor.isActive('blockquote'),
          isLink: editor.isActive('link'),
        }
      } catch {
        return neutral
      }
    },
  })

  useEffect(() => {
    if (!linkOpen) return
    function closeOnOutside(event: MouseEvent) {
      if (linkRef.current && !linkRef.current.contains(event.target as Node)) setLinkPopover(false)
    }
    // Escape closes the popover only. This editor lives inside a Radix Dialog whose dismiss
    // layer ALSO listens for Escape on the document — in the capture phase, registered before
    // this component mounts, so it runs first no matter what phase this listener uses and
    // stopPropagation here cannot stop it (verified: one Escape closed popover *and* dialog,
    // discarding the unsaved note). The parent suppresses its own dismissal via
    // `onNestedLayerChange`; this listener stays capture-phase so the popover is already
    // closing by the time anything else reacts to the key.
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setLinkPopover(false)
    }
    document.addEventListener('mousedown', closeOnOutside)
    document.addEventListener('keydown', closeOnEscape, true)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      document.removeEventListener('keydown', closeOnEscape, true)
    }
  }, [linkOpen, setLinkPopover])

  function toggleLink() {
    if (!editor) return
    if (editor.isActive('link')) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    setLinkUrl(editor.getAttributes('link').href ?? '')
    setLinkPopover(true)
  }

  function applyLink() {
    if (!editor) return
    const href = linkUrl.trim()
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    setLinkPopover(false)
  }

  if (!editor) return null

  return (
    <div className="note-editor overflow-hidden rounded-xl border border-border/70 bg-background transition-colors focus-within:border-foreground/60">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border/70 bg-muted/30 px-2 py-1.5">
        <FormatSelect editor={editor} />
        <Divider />
        <ToolbarButton label="Bold" onClick={() => editor.chain().focus().toggleBold().run()} active={state.isBold}>
          <Bold className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Italic" onClick={() => editor.chain().focus().toggleItalic().run()} active={state.isItalic}>
          <Italic className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Underline" onClick={() => editor.chain().focus().toggleUnderline().run()} active={state.isUnderline}>
          <UnderlineIcon className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Strikethrough" onClick={() => editor.chain().focus().toggleStrike().run()} active={state.isStrike}>
          <Strikethrough className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Inline code" onClick={() => editor.chain().focus().toggleCode().run()} active={state.isCode}>
          <Code className="size-3.5" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton label="Code block" onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={state.isCodeBlock}>
          <Code2 className="size-3.5" />
        </ToolbarButton>
        <div ref={linkRef} className="relative">
          <ToolbarButton label="Link" onClick={toggleLink} active={state.isLink}>
            {state.isLink ? <Link2Off className="size-3.5" /> : <Link2 className="size-3.5" />}
          </ToolbarButton>
          {linkOpen && (
            <div className="absolute right-0 top-8 z-10 flex w-64 items-center gap-1.5 rounded-xl border border-border/70 bg-popover p-1.5 shadow-lg">
              <Input
                value={linkUrl}
                onChange={(event) => setLinkUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') applyLink()
                  if (event.key === 'Escape') setLinkPopover(false)
                }}
                placeholder="https://…"
                autoFocus
                aria-label="Link URL"
                className="h-8 flex-1 rounded-lg border-border/70 bg-background text-xs"
              />
              <button
                type="button"
                onClick={applyLink}
                className="h-8 shrink-0 rounded-full bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
              >
                Apply
              </button>
            </div>
          )}
        </div>
        <Divider />
        <ToolbarButton label="Bullet list" onClick={() => editor.chain().focus().toggleBulletList().run()} active={state.isBulletList}>
          <List className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Numbered list" onClick={() => editor.chain().focus().toggleOrderedList().run()} active={state.isOrderedList}>
          <ListOrdered className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Blockquote" onClick={() => editor.chain().focus().toggleBlockquote().run()} active={state.isBlockquote}>
          <Quote className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Horizontal rule" onClick={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="size-3.5" />
        </ToolbarButton>
        <Divider />
        <ToolbarButton label="Undo" onClick={() => editor.chain().focus().undo().run()}>
          <Undo2 className="size-3.5" />
        </ToolbarButton>
        <ToolbarButton label="Redo" onClick={() => editor.chain().focus().redo().run()}>
          <Redo2 className="size-3.5" />
        </ToolbarButton>
      </div>
      <EditorContent editor={editor} className={cn('px-4 py-3', minHeightClass)} />
    </div>
  )
}
