import { execFile } from 'node:child_process'

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
      const ps =
        'Add-Type -AssemblyName System.Windows.Forms; ' +
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog; ' +
        "if($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){ Write-Output $f.SelectedPath }"
      // windowsHide hides the PowerShell console; the GUI dialog it opens still shows.
      execFile('powershell', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve({ path: null, error: err.message })
        resolve({ path: stdout.trim() || null })
      })
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
      execFile('explorer', [dir], () => resolve({ ok: true })) // explorer exits non-zero on success
    } else {
      execFile('xdg-open', [dir], (err) =>
        resolve(err ? { ok: false, error: 'No file manager available on this OS' } : { ok: true }),
      )
    }
  })
}
