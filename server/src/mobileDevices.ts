// Friendly names for the mobile devices Maestro reports.
//
// Maestro's `list_devices` gives a human name for an iOS simulator ("iPhone 15
// Pro"), but on Android it usually reports the ADB SERIAL as the name too —
// `emulator-5554` for an emulator, `127.0.0.1:7555` for a third-party emulator
// (MuMu / LDPlayer / BlueStacks / Nox, which attach over TCP), a raw factory
// serial like `R58M12ABCDE` for a phone. That's what a QC engineer sees in the
// mobile functional-test dialog and the Run form's device picker: identical-looking
// ids and no way to tell which of the emulators they set up is which.
//
// adb already knows the answer, so ask it:
//   - emulator → `adb -s <serial> emu avd name` returns the AVD name the engineer
//     created in Device Manager (`Pixel_7_API_34`);
//   - anything else → one `getprop` dump, read in NAME_PROPS order: the qemu AVD
//     name an emulator bakes in, then the marketing/model name (`SM_A515F`);
//   - last resort, the `model:` field adb itself printed in `devices -l`.
//
// Purely cosmetic and entirely best-effort: no adb, no Android SDK, or a device
// that doesn't answer just leaves Maestro's own label in place. The device_id is
// what still gets driven, so a wrong or missing name can never break a test. When
// adb is what's missing we say so (`adbAvailable`) rather than silently showing
// serials forever — that failure is fixable, but only if the engineer hears about it.

import spawn from 'cross-spawn'
import { spawnEnv } from './toolPath.js'

/** An `emulator-5554`-style serial — the only kind `adb emu` accepts. */
const EMULATOR_SERIAL = /^emulator-\d+$/i

/**
 * `getprop` keys that hold a name a human chose or a vendor ships, best first. The
 * qemu ones carry the AVD name (what the engineer typed when creating the device),
 * so they beat the model — `Pixel_7_API_34` identifies a device, `sdk_gphone64` doesn't.
 */
const NAME_PROPS = [
  'ro.kernel.qemu.avd_name',
  'ro.boot.qemu.avd_name',
  'ro.avd.name',
  'ro.product.model',
  'ro.product.vendor.model',
  'ro.product.marketname',
  'ro.product.name',
]

/**
 * A value that is technically a name but identifies nothing, so it must not
 * displace a later candidate (or, if nothing better exists, the serial itself —
 * "unknown" is a worse label than `127.0.0.1:7555`).
 */
function useless(value: string): boolean {
  return !value || /^(unknown|generic|generic_x86(_64)?|android|aosp|sdk|none|null)$/i.test(value)
}

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

/** The AVD name straight from the emulator console, or null if it won't answer. */
async function avdName(serial: string): Promise<string | null> {
  const out = await adb(['-s', serial, 'emu', 'avd', 'name'])
  // Output is the name, then adb's own "OK" acknowledgement line. A device that
  // isn't a real qemu emulator (a TCP-attached third-party one) answers "KO: …".
  const name = out
    ?.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l !== 'OK' && !/^KO\b/.test(l))[0]
  return name && !useless(name) ? name : null
}

/**
 * The best name in one device's whole property dump. ONE `getprop` round trip
 * rather than one per key — the dump is a few tens of KB and a device that has to
 * be woken costs far more in latency than in bytes.
 */
async function propName(serial: string): Promise<string | null> {
  const out = await adb(['-s', serial, 'shell', 'getprop'])
  if (!out) return null
  const props = new Map<string, string>()
  // Lines look like: [ro.product.model]: [sdk_gphone64_arm64]
  for (const m of out.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]$/gm)) {
    props.set(m[1], m[2].trim())
  }
  for (const key of NAME_PROPS) {
    const value = props.get(key) ?? ''
    if (!useless(value)) return value
  }
  return null
}

/** What adb could tell us about the devices it can currently see. */
export interface AndroidNames {
  /** serial → friendly name, for the devices adb managed to name. */
  names: Map<string, string>
  /**
   * false when adb couldn't be run at all (not installed, or not on the PATH of
   * the process that started the portal). Every name is then missing for one
   * reason, which the UI can state instead of showing bare serials.
   */
  adbAvailable: boolean
}

/**
 * serial → friendly name, for every device adb can currently see. `adbAvailable`
 * is false when adb itself is unreachable (which also means Maestro can't drive
 * Android here anyway, but the picker still lists what Maestro reported).
 */
export async function androidDeviceNames(): Promise<AndroidNames> {
  const names = new Map<string, string>()
  const listing = await adb(['devices', '-l'])
  if (listing === null) return { names, adbAvailable: false }

  // "emulator-5554  device product:… model:sdk_gphone64_x86_64 device:emu64xa …"
  const rows: { serial: string; model: string | null }[] = []
  for (const line of listing.split('\n')) {
    const text = line.trim()
    if (!text || /^list of devices/i.test(text)) continue
    const [serial, state, ...rest] = text.split(/\s+/)
    // Only `device` is usable — `offline`/`unauthorized` won't answer a query.
    if (!serial || state !== 'device') continue
    const model = rest.map((f) => /^model:(.+)$/.exec(f)?.[1]).find(Boolean) ?? null
    rows.push({ serial, model: model && !useless(model) ? model : null })
  }

  // Ask each device in parallel; a hung one must not stall the whole listing.
  await Promise.all(
    rows.map(async ({ serial, model }) => {
      const label =
        (EMULATOR_SERIAL.test(serial) ? await avdName(serial) : null) ??
        (await propName(serial)) ??
        model
      if (label) names.set(serial, humanize(label))
    }),
  )
  return { names, adbAvailable: true }
}
