/**
 * Copy text to the clipboard, working in the places `navigator.clipboard` doesn't.
 *
 * The async Clipboard API only exists in a SECURE CONTEXT — https, or localhost.
 * The portal is localhost for whoever runs it, but a QC opening it from another
 * machine (`http://192.168.x.x:5175`) gets a plain-http origin where
 * `navigator.clipboard` is `undefined`. Code that does
 * `navigator.clipboard?.writeText(x).catch(() => {})` there copies nothing and says
 * nothing, which reads to the user as "copy is broken".
 *
 * So: try the real API, then fall back to a hidden textarea + `execCommand('copy')`,
 * which is deprecated but still works on non-secure origins in every browser we
 * target. Returns whether the text actually made it — callers should report failure
 * rather than swallow it.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied permission / not focused — fall through to the legacy path.
    }
  }

  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // Off-screen but still focusable/selectable; `fixed` avoids scrolling the page.
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)

    // Preserve whatever the user had selected — copying shouldn't clear their selection.
    const sel = document.getSelection()
    const previous = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null

    ta.select()
    ta.setSelectionRange(0, ta.value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)

    if (previous && sel) {
      sel.removeAllRanges()
      sel.addRange(previous)
    }
    return ok
  } catch {
    return false
  }
}
