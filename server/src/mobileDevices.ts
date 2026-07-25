import { existsSync } from 'node:fs'
import path from 'node:path'
import spawn from 'cross-spawn'
import { spawnEnv } from './toolPath.js'

/**
 * Native mobile-device detection — enumerate connected devices/simulators WITHOUT
 * spinning up Claude + the mobile MCP server (which is slow and flaky to hand-shake).
 * Used for the Mobile functional test's DETECT step so the picker fills instantly and
 * the common "nothing booted" case returns immediately instead of a ~16s LLM run.
 *
 * Cross-platform:
 *  - Android via `adb devices` — works on macOS AND Windows (adb.exe), identical output.
 *  - iOS simulators via `xcrun simctl` — macOS only (Windows has no iOS tooling).
 *
 * The DRIVE step still goes through the MCP, so the identifiers returned here are the
 * standard ones that MCP expects: the raw adb serial (Android) and the simulator name
 * (iOS).
 */

interface RunResult {
  code: number | null
  out: string
  err: string
  failed: boolean
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { env: spawnEnv(), windowsHide: true })
    } catch (e) {
      // e.g. the binary isn't installed / not on PATH — treated as "tool unavailable".
      resolve({ code: null, out: '', err: e instanceof Error ? e.message : String(e), failed: true })
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolve({ code: null, out, err, failed: true })
    }, timeoutMs)
    child.stdout?.on('data', (d) => (out += String(d)))
    child.stderr?.on('data', (d) => (err += String(d)))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: null, out, err: e.message, failed: true })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, failed: false })
    })
  })
}

/**
 * Resolve the `adb` binary: prefer an Android SDK location (env or the OS default
 * install dir) so detection works even when adb isn't on PATH, then fall back to a
 * bare `adb` (cross-spawn resolves adb.exe on Windows).
 */
function adbPath(): string {
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    (v): v is string => !!v,
  )
  if (process.platform === 'darwin' && process.env.HOME) {
    roots.push(path.join(process.env.HOME, 'Library', 'Android', 'sdk'))
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  }
  for (const r of roots) {
    const p = path.join(r, 'platform-tools', exe)
    if (existsSync(p)) return p
  }
  return exe
}

export interface MobileDetect {
  devices: string[]
  /** Non-fatal notes (e.g. adb not installed) surfaced to the user as a hint. */
  warnings: string[]
}

/** Enumerate running Android devices/emulators + booted iOS simulators natively. */
export async function detectMobileDevicesNative(): Promise<MobileDetect> {
  const devices: string[] = []
  const warnings: string[] = []

  // ---- Android (adb) — macOS + Windows ----
  const adb = await run(adbPath(), ['devices', '-l'], 8000)
  if (adb.failed && !adb.out) {
    warnings.push('adb not found — install Android platform-tools to detect Android devices.')
  } else {
    for (const raw of adb.out.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || /^list of devices/i.test(line)) continue
      // "<serial>\tdevice ..." — only count the "device" state (skip offline/unauthorized).
      const m = /^(\S+)\s+device(?:\s|$)/.exec(line)
      if (m) devices.push(m[1])
    }
  }

  // ---- iOS simulators (xcrun simctl) — macOS only ----
  if (process.platform === 'darwin') {
    const sim = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], 8000)
    if (!sim.failed && sim.out.trim()) {
      try {
        const parsed = JSON.parse(sim.out) as {
          devices?: Record<string, Array<{ name?: string; state?: string }>>
        }
        for (const list of Object.values(parsed.devices ?? {})) {
          for (const d of list) {
            if (d.state === 'Booted' && d.name) devices.push(d.name)
          }
        }
      } catch {
        /* unparseable simctl output — ignore, Android results still stand */
      }
    }
  }

  return { devices, warnings }
}
