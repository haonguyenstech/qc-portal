// Shape a device entry from Maestro's `list_devices` into something a QC engineer
// can pick from. Shared by the MCP page's functional-test dialog and the Run form's
// device picker — both read the SAME `runMcpTest('maestro', projectId, '')` reply, so
// a device must be labeled identically in both places.

/** A detected device, ready to render: what the engineer reads + what Maestro drives. */
export interface DetectedDevice {
  deviceId: string
  name: string
  caption: string
  platform: 'iOS' | 'Android' | 'Web'
}

/**
 * Shape one detected device for a picker. The server hands back
 * `{device_id, name, platform, type}` (Android names resolved to the AVD/model via
 * adb), so the primary line is the **device name** and the id only ever appears in
 * the caption — a QC engineer picks "Pixel 7 API 34", not `emulator-5554`.
 *
 * A plain string is still accepted (older reply shape / a cached result): Maestro
 * packs a simulator into one long "iPhone 15 Pro - iOS 17.2 - 240CB27F-…" label, so
 * the first segment becomes the name and the rest the caption.
 *
 * `platform` is NOT a two-way iOS-or-Android guess: Maestro's always-present
 * `chromium` entry is a desktop browser, and labeling it "Android" is simply wrong.
 *
 * `deviceId` is what gets sent to the drive step (or pinned onto a run), so nothing
 * here can change which device is tested.
 */
export function describeDevice(entry: unknown): DetectedDevice | null {
  const raw = typeof entry === 'string' ? entry.trim() : ''
  const obj = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
  const deviceId = raw || String(obj.deviceId ?? obj.device_id ?? '').trim()
  const label = raw || String(obj.name ?? '').trim()
  if (!deviceId && !label) return null

  const parts = label
    .split(/\s+[-–—|·]\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
  // Maestro reports an Android emulator's AVD name verbatim (`Pixel_6_API_36`), and
  // underscores read as a filename rather than a device — same humanizing the
  // server's adb fallback does, applied to whatever name we end up showing.
  const name = humanize(parts[0] || label || deviceId)
  const declared = String(obj.platform ?? '').toLowerCase()
  const haystack = `${label} ${deviceId} ${declared} ${String(obj.type ?? '')}`
  const platform: DetectedDevice['platform'] = /chromium|chrome|browser|safari|firefox|webkit|\bweb\b/i.test(
    haystack,
  )
    ? 'Web'
    : declared.includes('ios') || /iphone|ipad|ipod|\bios\b|simulator/i.test(haystack)
      ? 'iOS'
      : 'Android'

  // Don't repeat the platform a segment already states — "iOS · iOS 17.2 · <udid>"
  // reads like a bug — and only show the id when it isn't already the name.
  const rest = [
    ...parts.slice(1),
    ...(obj.type ? [String(obj.type)] : []),
    ...(deviceId && deviceId !== name ? [deviceId] : []),
  ]
  const stated = rest.some((p) => new RegExp(`^${platform}\\b`, 'i').test(p))
  return {
    deviceId: deviceId || name,
    name,
    caption: [...(stated ? [] : [platform]), ...rest].join(' · '),
    platform,
  }
}

/**
 * `Pixel_6_API_36` → `Pixel 6 API 36`. Only touches a name that is ALL underscores
 * and word characters (an AVD / `ro.product.model` value); a real product name with
 * spaces or punctuation is left exactly as Maestro reported it.
 */
function humanize(name: string): string {
  return /_/.test(name) && /^[\w.-]+$/.test(name) ? name.replace(/_/g, ' ').trim() : name
}

/** Read the devices out of a `runMcpTest('maestro', …, '')` detection reply. */
export function devicesFromDetection(result: { data?: unknown } | undefined): DetectedDevice[] {
  const data = (result?.data ?? null) as { devices?: unknown } | null
  if (!data || !Array.isArray(data.devices)) return []
  return (data.devices as unknown[])
    .map(describeDevice)
    .filter((d): d is DetectedDevice => d !== null)
}
