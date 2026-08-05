// Friendly names for the mobile devices Maestro reports.
//
// Maestro's `list_devices` gives a human name for an iOS simulator ("iPhone 15
// Pro"), but on Android it usually reports the ADB SERIAL as the name too —
// `emulator-5554` for an emulator, a raw factory serial like `R58M12ABCDE` for a
// phone. That's what a QC engineer on Windows sees in the mobile functional-test
// dialog: two identical-looking ids and no way to tell which of the emulators they
// set up in Android Studio is which.
//
// adb already knows the answer, so ask it:
//   - emulator → `adb -s <serial> emu avd name` returns the AVD name the engineer
//     created in Device Manager (`Pixel_7_API_34`);
//   - physical device → the `model:` field of `adb devices -l` (falling back to
//     `ro.product.model`), i.e. `SM_A515F`.
//
// Purely cosmetic and entirely best-effort: no adb, no Android SDK, or a device
// that doesn't answer just leaves Maestro's own label in place. The device_id is
// what still gets driven, so a wrong or missing name can never break a test.

import spawn from 'cross-spawn'
import { spawnEnv } from './toolPath.js'

/** An `emulator-5554`-style serial — the only kind `adb emu` accepts. */
const EMULATOR_SERIAL = /^emulator-\d+$/i

function adb(args: string[], timeoutMs = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      resolve(value)
    }
    try {
      const child = spawn('adb', args, { env: spawnEnv(), windowsHide: true })
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', () => finish(null))
      child.on('close', (code: number | null) => finish(code === 0 ? out : null))
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish(null)
      }, timeoutMs)
    } catch {
      finish(null)
    }
  })
}

/** `SM_A515F` / `sdk_gphone64_x86_64` read better with spaces than underscores. */
const humanize = (raw: string) => raw.replace(/_/g, ' ').trim()

/**
 * serial → friendly name, for every device adb can currently see. Empty map when
 * adb is unavailable (which also means Maestro can't drive Android here anyway).
 */
export async function androidDeviceNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const listing = await adb(['devices', '-l'])
  if (!listing) return names

  // "emulator-5554  device product:… model:sdk_gphone64_x86_64 device:emu64xa …"
  const rows: { serial: string; model: string | null }[] = []
  for (const line of listing.split('\n')) {
    const text = line.trim()
    if (!text || /^list of devices/i.test(text)) continue
    const [serial, state, ...rest] = text.split(/\s+/)
    // Only `device` is usable — `offline`/`unauthorized` won't answer a query.
    if (!serial || state !== 'device') continue
    const model = rest.map((f) => /^model:(.+)$/.exec(f)?.[1]).find(Boolean) ?? null
    rows.push({ serial, model: model || null })
  }

  // Emulators know their AVD name; ask them one at a time (there are rarely more
  // than a couple, and a hung device must not stall the whole listing).
  await Promise.all(
    rows.map(async ({ serial, model }) => {
      if (EMULATOR_SERIAL.test(serial)) {
        const out = await adb(['-s', serial, 'emu', 'avd', 'name'])
        // Output is the name, then adb's own "OK" acknowledgement line.
        const avd = out
          ?.split('\n')
          .map((l) => l.trim())
          .filter((l) => l && l !== 'OK' && !/^KO\b/.test(l))[0]
        if (avd) {
          names.set(serial, humanize(avd))
          return
        }
      }
      const label = model ?? (await adb(['-s', serial, 'shell', 'getprop', 'ro.product.model']))?.trim()
      if (label) names.set(serial, humanize(label))
    }),
  )
  return names
}
