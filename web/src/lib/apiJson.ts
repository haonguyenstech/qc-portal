// Beautify / minify a JSON request body — the Postman "Beautify" button, with the one
// difference this page needs: a QC Portal body is full of `{{variables}}`, and half of
// them sit where JSON wants a value rather than a string (`"limit": {{page_size}}`).
// `JSON.parse` rejects that, so a formatter that only tried a plain parse would refuse
// exactly the bodies the engineer edits most. We mask those bare tokens with a string
// placeholder, format, then put the tokens back verbatim.

/** The placeholder a masked `{{token}}` becomes. Ordinary chars, so it survives stringify. */
const SENTINEL = '__QCVAR'

type Masked = { masked: string; vars: string[] }

/**
 * Replace every `{{…}}` that is NOT already inside a JSON string with a quoted
 * placeholder. Tokens inside a string (`"Bearer {{token}}"`) are already valid JSON and
 * are left untouched. Returns null when the body itself contains our sentinel — masking
 * would then be ambiguous, so the caller falls back to a plain parse.
 */
function maskVars(src: string): Masked | null {
  if (src.includes(SENTINEL)) return null
  const vars: string[] = []
  let out = ''
  let inStr = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      out += ch
      if (ch === '\\') {
        out += src[i + 1] ?? ''
        i++
      } else if (ch === '"') {
        inStr = false
      }
      continue
    }
    if (ch === '"') {
      inStr = true
      out += ch
      continue
    }
    if (ch === '{' && src[i + 1] === '{') {
      const end = src.indexOf('}}', i + 2)
      if (end > 0) {
        vars.push(src.slice(i, end + 2))
        out += `"${SENTINEL}_${vars.length - 1}__"`
        i = end + 1
        continue
      }
    }
    out += ch
  }
  return { masked: out, vars }
}

function unmaskVars(text: string, vars: string[]): string {
  let out = text
  for (let i = 0; i < vars.length; i++) {
    out = out.split(`"${SENTINEL}_${i}__"`).join(vars[i])
  }
  return out
}

export type JsonFormatResult = { ok: true; text: string } | { ok: false; message: string }

/**
 * Re-print a JSON body. `indent` 2 beautifies, 0 minifies.
 *
 * On invalid JSON nothing is rewritten — the parser's message (which carries the
 * position) comes back so the caller can show it. Silently leaving a mangled body, or
 * "fixing" it by guessing, is worse than saying where it broke.
 */
export function formatJsonBody(text: string, indent: 0 | 2): JsonFormatResult {
  if (!text.trim()) return { ok: false, message: 'The body is empty.' }
  const print = (value: unknown) =>
    indent === 0 ? JSON.stringify(value) : JSON.stringify(value, null, indent)

  try {
    return { ok: true, text: print(JSON.parse(text)) }
  } catch (plain) {
    const m = maskVars(text)
    if (m && m.vars.length > 0) {
      try {
        return { ok: true, text: unmaskVars(print(JSON.parse(m.masked)), m.vars) }
      } catch {
        /* still invalid — report the original error, which points at the real text */
      }
    }
    return {
      ok: false,
      message: plain instanceof Error ? plain.message : 'That body is not valid JSON.',
    }
  }
}

/** Beautify a JSON body when it parses; otherwise return it untouched (import paths). */
export function prettyJsonOrRaw(text: string): string {
  const r = formatJsonBody(text, 2)
  return r.ok ? r.text : text
}
