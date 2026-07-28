// Maestro CLI preflight — the ONE server the portal can't install for you.
//
// Every other device/browser MCP in the portal is an `npx -y <pkg>` away, so the
// Connect button is enough. Maestro is different in two ways that both surface as
// a bare "failed" card if we don't check up-front:
//
//  1. `maestro` is a separately-installed binary (its curl installer drops it in
//     ~/.maestro/bin, which `toolPath.ts` now adds to every child's PATH). Nothing
//     the portal spawns can conjure it.
//  2. Maestro 2.x hard-requires **Java 17+**. On an older JDK it exits immediately
//     with "ERROR: Java 17 or higher is required." — verified against the system
//     Java 11 on this machine. Since a machine can perfectly well have Java 11 as
//     its default AND a newer JDK installed alongside (Homebrew's openjdk@NN is
//     keg-only, so it never becomes `java`), we resolve a suitable JAVA_HOME here
//     and pin it into the .mcp.json entry's `env` — exactly what Maestro's own
//     Claude Desktop instructions do — instead of asking the user to re-point
//     their system Java.
//
// The page uses this to show an actionable install hint (and to refuse to write a
// server entry that we know can't start) rather than a dead "failed" badge.

import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import spawn from 'cross-spawn'
import { spawnEnv } from './toolPath.js'

export interface MaestroPreflight {
  /** `maestro` resolved and ran (with a usable JDK) — the CLI is installed. */
  available: boolean
  /** Reported CLI version, when we could read one. */
  version: string | null
  /** A JAVA_HOME whose java is >= 17, or null if none was found. */
  javaHome: string | null
  /** Major version of the JDK at `javaHome` (or of the default java when that suffices). */
  javaMajor: number | null
  /** True when the DEFAULT `java` on PATH is already 17+, so no JAVA_HOME pin is needed. */
  defaultJavaOk: boolean
  platform: string
}

const MIN_JAVA = 17

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; failed: boolean }> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (r: { code: number | null; out: string; failed: boolean }) => {
      if (done) return
      done = true
      resolve(r)
    }
    try {
      const child = spawn(cmd, args, { env: env ?? spawnEnv(), windowsHide: true })
      // Maestro prints its version banner on stdout but its Java error on stderr —
      // merge both so a single `out` carries whichever we got.
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr?.on('data', (d: Buffer) => (out += d.toString()))
      child.on('error', () => finish({ code: null, out, failed: true }))
      child.on('close', (code: number | null) => finish({ code, out, failed: false }))
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        finish({ code: null, out, failed: true })
      }, timeoutMs)
    } catch {
      finish({ code: null, out, failed: true })
    }
  })
}

/** Parse a major version out of `java -version` output ("21.0.12", "1.8.0_392", "17"). */
function parseJavaMajor(text: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(text)
  if (!m) return null
  const first = Number(m[1])
  // Pre-9 JDKs report 1.8.x — the meaningful number is the SECOND component.
  if (first === 1) return m[2] ? Number(m[2]) : null
  return Number.isFinite(first) ? first : null
}

/** Candidate JDK homes to try when the default `java` is too old (or missing). */
function javaHomeCandidates(): string[] {
  const home = os.homedir()
  const out: string[] = []
  const envHome = process.env.JAVA_HOME
  if (envHome) out.push(envHome)
  if (process.platform === 'darwin') {
    // Homebrew keg-only JDKs: /opt/homebrew/opt/openjdk@21 (arm) or /usr/local/opt (intel).
    // Newest-first so we prefer a current LTS over a barely-passing 17.
    for (const base of ['/opt/homebrew/opt', '/usr/local/opt']) {
      try {
        const kegs = readdirSync(base)
          .filter((d) => /^openjdk(@\d+)?$/.test(d))
          .sort((a, b) => (Number(b.split('@')[1] ?? 0) || 0) - (Number(a.split('@')[1] ?? 0) || 0))
        for (const keg of kegs) out.push(path.join(base, keg))
      } catch {
        /* base dir absent — fine */
      }
    }
    try {
      const vms = '/Library/Java/JavaVirtualMachines'
      for (const d of readdirSync(vms)) out.push(path.join(vms, d, 'Contents', 'Home'))
    } catch {
      /* no system JDKs */
    }
  } else if (process.platform === 'win32') {
    for (const base of [
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Java') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Eclipse Adoptium') : null,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Microsoft') : null,
    ]) {
      if (!base) continue
      try {
        for (const d of readdirSync(base)) out.push(path.join(base, d))
      } catch {
        /* absent */
      }
    }
  } else {
    try {
      for (const d of readdirSync('/usr/lib/jvm')) out.push(path.join('/usr/lib/jvm', d))
    } catch {
      /* absent */
    }
  }
  out.push(path.join(home, '.sdkman', 'candidates', 'java', 'current'))
  // De-dupe while preserving the preference order above.
  return [...new Set(out)]
}

const javaBin = (home: string) =>
  path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')

/** Find a JDK >= MIN_JAVA. Returns the default java first when it already qualifies. */
async function resolveJava(): Promise<{
  javaHome: string | null
  javaMajor: number | null
  defaultJavaOk: boolean
}> {
  const def = await run('java', ['-version'], 5000)
  const defMajor = parseJavaMajor(def.out)
  if (defMajor !== null && defMajor >= MIN_JAVA) {
    return { javaHome: null, javaMajor: defMajor, defaultJavaOk: true }
  }
  for (const home of javaHomeCandidates()) {
    const bin = javaBin(home)
    if (!existsSync(bin)) continue
    const r = await run(bin, ['-version'], 5000)
    const major = parseJavaMajor(r.out)
    if (major !== null && major >= MIN_JAVA) {
      return { javaHome: home, javaMajor: major, defaultJavaOk: false }
    }
  }
  return { javaHome: null, javaMajor: defMajor, defaultJavaOk: false }
}

/**
 * Probe the Maestro CLI and the JDK it needs. Best-effort and never throws — an
 * unavailable Maestro is a normal state the page renders an install hint for.
 */
export async function probeMaestro(): Promise<MaestroPreflight> {
  const java = await resolveJava()
  // Run the version check under the JDK we'd actually pin, so `available` reflects
  // how the MCP server will really start rather than the (possibly too old) default.
  const env = spawnEnv(
    java.javaHome
      ? {
          JAVA_HOME: java.javaHome,
          // Maestro's launcher script resolves `java` from PATH, so JAVA_HOME alone
          // isn't enough — put the chosen JDK's bin FIRST.
          PATH: [
            path.join(java.javaHome, 'bin'),
            spawnEnv().PATH ?? process.env.PATH ?? '',
          ].join(path.delimiter),
        }
      : undefined,
  )
  const r = await run('maestro', ['--version'], 60_000, {
    ...env,
    // Suppress the boxed "analysis notification" banner that otherwise pollutes the
    // version output (and every MCP tool result).
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
  })
  // The launcher prints a version banner; take the last bare semver-ish line.
  const version =
    r.out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^\d+\.\d+/.test(l))
      .pop() ?? null
  return {
    available: !r.failed && r.code === 0 && !!version,
    version,
    javaHome: java.javaHome,
    javaMajor: java.javaMajor,
    defaultJavaOk: java.defaultJavaOk,
    platform: process.platform,
  }
}

/**
 * The env block to store on the `maestro` .mcp.json entry. Empty when the default
 * java is already 17+ (nothing to pin), so we don't bake a machine-specific path
 * into a project's committed .mcp.json unless it's actually required.
 */
export function maestroEnvFor(pf: MaestroPreflight): Record<string, string> {
  const env: Record<string, string> = {
    MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
    // The FIRST drive of an iOS simulator makes Maestro install and launch its
    // XCUITest driver runner, which overruns the default startup timeout — verified:
    // inspect_screen fails with "iOS driver not ready in time (consider increasing
    // MAESTRO_DRIVER_STARTUP_TIMEOUT)". Later runs reuse the installed driver and are
    // fast, so this ceiling only ever costs time on a cold simulator.
    MAESTRO_DRIVER_STARTUP_TIMEOUT: '120000',
  }
  if (pf.javaHome) {
    env.JAVA_HOME = pf.javaHome
    // Maestro's launcher resolves `java` off PATH, so JAVA_HOME alone isn't enough —
    // the chosen JDK's bin has to come first. Base this on spawnEnv()'s PATH, NOT
    // process.env.PATH: an `env.PATH` on the .mcp.json entry REPLACES the inherited
    // one, so building it from the raw process PATH would silently drop the
    // ~/.maestro/bin that spawnEnv() appends — leaving `maestro` unresolvable and
    // the server dead. Verified: that's exactly how it fails.
    const basePath = spawnEnv().PATH ?? process.env.PATH ?? ''
    env.PATH = `${path.join(pf.javaHome, 'bin')}${path.delimiter}${basePath}`
  }
  return env
}
