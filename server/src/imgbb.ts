// Upload a screenshot to imgbb (free image host) and return its direct hotlink URL.
//
// Used by the Issues -> ClickUp filing flow when ClickUp's own attachment storage is
// full ("Over allocated storage", ECODE GBUSED_005): instead of attaching the file to
// the card, we host it on imgbb and embed the URL in the card's comment as markdown,
// so the evidence is still visible inline without consuming ClickUp storage.
//
// imgbb's v1 API takes the image as a base64-encoded string in the `image` field
// (a data-URI prefix is optional). The free key is created at https://api.imgbb.com.

const IMGBB_API = 'https://api.imgbb.com/1/upload'

/**
 * Upload raw image bytes to imgbb and return the direct (hotlinkable) URL.
 * Throws with a `status` property on failure so the route can surface a readable
 * reason; never returns an empty/fallback URL silently.
 */
export async function uploadImageToImgbb(
  bytes: Uint8Array,
  filename: string,
  apiKey: string,
): Promise<string> {
  const b64 = Buffer.from(bytes).toString('base64')
  const form = new FormData()
  form.append('key', apiKey)
  form.append('image', b64)
  if (filename) form.append('name', filename.slice(0, 128))

  const res = await fetch(IMGBB_API, { method: 'POST', body: form })
  const body = await res.text().catch(() => '')
  let data: { success?: boolean; data?: { url?: string }; error?: { message?: string } } | null =
    null
  try {
    data = JSON.parse(body)
  } catch {
    /* not JSON — fall through to the raw-body error below */
  }
  if (!res.ok || !data?.success) {
    const msg = data?.error?.message || body.slice(0, 200) || `imgbb upload ${res.status}`
    throw Object.assign(new Error(`imgbb ${res.status}: ${msg}`), { status: 502 })
  }
  const url = String(data?.data?.url ?? '')
  if (!url) throw Object.assign(new Error('imgbb: no direct URL returned'), { status: 502 })
  return url
}
