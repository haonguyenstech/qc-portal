/**
 * Shared plain-text ↔ HTML helpers for rich-text notes.
 *
 * Note bodies are stored as HTML (the editor's output), but notes created before the
 * editor existed hold plain text. `LOOKS_LIKE_HTML` picks which one a body is: the
 * card renders HTML with `.note-body` styles or plain text with `whitespace-pre-line`,
 * and the editor seeds plain text through `escapeHtml` so it edits safely.
 */

/** Cheap "this string contains markup" test — good enough for the two shapes we store. */
export const LOOKS_LIKE_HTML = /<\/?[a-z][\s\S]*>/i

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
