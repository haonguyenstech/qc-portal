import { execFile } from 'node:child_process'
import path from 'node:path'

/**
 * Open the OS-native "choose folder" dialog ON THE MACHINE RUNNING THE SERVER
 * and resolve the selected absolute path. Browsers can't expose absolute paths,
 * but this is a local tool so the dialog appears on the user's own screen.
 * Resolves { path: null } when the user cancels.
 */
export function pickFolderNative(
  prompt = 'Select a folder',
  /** Folder the dialog opens in (absolute path). Lets the user skip hidden parents. */
  defaultLocation?: string,
): Promise<{ path: string | null; error?: string }> {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      // `invisibles true` reveals dot-folders like .claude that Finder hides by default.
      let chooser = `choose folder with prompt "${prompt.replace(/"/g, '')}" invisibles true`
      if (defaultLocation) {
        chooser += ` default location (POSIX file "${defaultLocation.replace(/"/g, '')}")`
      }
      execFile('osascript', ['-e', `POSIX path of (${chooser})`], (err, stdout, stderr) => {
        if (err) {
          if (/-128/.test(stderr) || /User canceled/i.test(stderr)) return resolve({ path: null })
          return resolve({ path: null, error: stderr.trim() || err.message })
        }
        resolve({ path: stdout.trim() })
      })
    } else if (process.platform === 'win32') {
      // A bare FolderBrowserDialog.ShowDialog() has no owner window, so it often
      // opens BEHIND the browser / other windows — the user only sees the request
      // spinner while PowerShell blocks on an invisible dialog. Two defenses:
      // (1) own the dialog with an (unshown) TopMost form so it stacks above
      //     normal windows, and
      // (2) a WinForms timer that, during the dialog's first seconds, force-raises
      //     every visible window of the thread via user32.SetForegroundWindow —
      //     Windows denies foreground moves to background processes in some
      //     states, so a single attempt isn't enough.
      // Plus the timeout backstop below (kills the whole tree) so a wedged
      // dialog can never pend the request forever.
      const psq = (s: string) => s.replace(/[\r\n]/g, ' ').replace(/'/g, "''")
      const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace Native -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool EnumThreadWindows(uint id, EnumFn fn, IntPtr p);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public delegate bool EnumFn(IntPtr hWnd, IntPtr lParam);
public static void RaiseThreadWindows() {
  EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr h, IntPtr l) {
    if (IsWindowVisible(h)) { SetForegroundWindow(h); }
    return true;
  }, IntPtr.Zero);
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$f = New-Object System.Windows.Forms.FolderBrowserDialog
$f.Description = '${psq(prompt)}'
$f.ShowNewFolderButton = $true
${defaultLocation ? `$f.SelectedPath = '${psq(defaultLocation)}'` : ''}
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$script:ticks = 0
$timer.Add_Tick({
  $script:ticks++
  [Native.Win]::RaiseThreadWindows()
  if ($script:ticks -ge 16) { $timer.Stop() }
})
$timer.Start()
$r = $f.ShowDialog($owner)
$timer.Stop()
if ($r -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.SelectedPath }
`
      // -EncodedCommand sidesteps every cmd/PowerShell quoting pitfall of a
      // joined one-liner (the previous approach). UTF-16LE is what PS expects.
      const encoded = Buffer.from(script, 'utf16le').toString('base64')
      let settled = false
      // windowsHide hides the PowerShell console; the GUI dialog it opens still shows.
      const child = execFile(
        'powershell',
        ['-NoProfile', '-STA', '-EncodedCommand', encoded],
        { windowsHide: true },
        (err, stdout, stderr) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) return resolve({ path: null, error: (stderr || '').trim() || err.message })
          resolve({ path: stdout.trim() || null })
        },
      )
      // Backstop: if the dialog wedges (e.g. no interactive desktop), kill the
      // whole process tree — child.kill() alone leaves the dialog window up —
      // and fail cleanly instead of pending forever.
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        if (child.pid) {
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => {})
        } else {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        }
        resolve({
          path: null,
          error:
            'The folder picker did not respond in time — the dialog may have opened behind another window. Please try again, or type the path manually.',
        })
      }, 2 * 60 * 1000)
    } else {
      // Linux: best-effort via zenity if present.
      execFile(
        'zenity',
        ['--file-selection', '--directory', `--title=${prompt}`],
        (err, stdout, stderr) => {
          if (err) {
            if (/cancel/i.test(stderr)) return resolve({ path: null })
            return resolve({ path: null, error: 'No native folder picker available on this OS' })
          }
          resolve({ path: stdout.trim() })
        },
      )
    }
  })
}

/**
 * Reveal a folder in the OS file explorer ON THE MACHINE RUNNING THE SERVER
 * (Finder on macOS, Explorer on Windows, the default file manager on Linux).
 * This is a local tool, so the window opens on the user's own screen.
 */
export function revealFolderNative(dir: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const done = (err: Error | null) =>
      resolve(err ? { ok: false, error: err.message } : { ok: true })
    if (process.platform === 'darwin') {
      execFile('open', [dir], done)
    } else if (process.platform === 'win32') {
      // explorer.exe treats "/" as a command switch, so a path with forward
      // slashes (e.g. a project rootPath saved as C:/Users/...) silently opens
      // the default folder instead of the target. Force backslashes first.
      const winPath = path.win32.normalize(dir)
      execFile('explorer.exe', [winPath], () => resolve({ ok: true })) // explorer exits non-zero on success
    } else {
      execFile('xdg-open', [dir], (err) =>
        resolve(err ? { ok: false, error: 'No file manager available on this OS' } : { ok: true }),
      )
    }
  })
}
