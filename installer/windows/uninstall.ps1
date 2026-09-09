# Remove the QC Portal install (Windows). Mirrors what install.ps1 / install.bat
# created - nothing more:
#
#   %USERPROFILE%\.qc-portal            the checkout, WITH the run history in data\
#   %LOCALAPPDATA%\qc-portal\bin        the qc-portal.cmd shim, and its PATH entry
#   Desktop + Start Menu "QC Portal.lnk"
#
# Node, Git and Claude Code are left alone: other things use them.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
# ASCII ONLY, deliberately. PowerShell 5.1 (what Windows 10 ships) reads a .ps1 with no
# byte-order mark as ANSI, so a UTF-8 em dash decodes to the three characters `a-hat, euro,
# right-curly-quote` -- and 5.1 treats a curly quote as a STRING DELIMITER. One em dash in a
# comment therefore ends a string early and the whole file fails to parse. Keep every
# character in this file plain ASCII.

$ErrorActionPreference = 'Stop'
$InstallDir = Join-Path $env:USERPROFILE '.qc-portal'
$BinDir     = Join-Path $env:LOCALAPPDATA 'qc-portal\bin'
$DataDir    = Join-Path $InstallDir 'data'

Write-Host 'QC Portal uninstaller' -ForegroundColor White
if (-not (Test-Path $InstallDir)) { Write-Host "  nothing at $InstallDir - already gone."; }
else { Write-Host "  install: $InstallDir" }

if (Test-Path $DataDir) {
  $mb = [math]::Round(((Get-ChildItem $DataDir -Recurse -Force -ErrorAction SilentlyContinue |
                        Measure-Object Length -Sum).Sum / 1MB), 1)
  Write-Host "  data:    $DataDir  ($mb MB - projects, run history, screenshots)" -ForegroundColor Yellow
  Write-Host '           Copy it elsewhere first if you want to keep any of that.' -ForegroundColor Yellow
}
if ((Read-Host "`nType YES to remove QC Portal") -ne 'YES') {
  Write-Host '  cancelled - nothing was deleted.'; exit 0
}

# Stop the server FIRST: a running node holds files open, so the delete would only
# half-succeed and leave a folder the installer then refuses to reuse.
$entry = Join-Path $InstallDir 'bin\qc-portal.mjs'
if (Test-Path $entry) { try { & node $entry --stop 2>$null | Out-Null } catch { } }

foreach ($dir in @([Environment]::GetFolderPath('Desktop'),
                   (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = Join-Path $dir 'QC Portal.lnk'
  if (Test-Path $lnk) { Remove-Item $lnk -Force; Write-Host "  removed $lnk" }
}
if (Test-Path $BinDir) { Remove-Item (Split-Path $BinDir) -Recurse -Force; Write-Host "  removed $BinDir" }

# Take the shim off the user PATH too, or a `qc-portal` that no longer exists stays
# on it for ever.
$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if ($userPath) {
  $kept = ($userPath -split ';' | Where-Object { $_ -and $_ -ne $BinDir }) -join ';'
  if ($kept -ne $userPath) {
    [Environment]::SetEnvironmentVariable('PATH', $kept, 'User')
    Write-Host '  removed the PATH entry (takes effect in a new terminal)'
  }
}
if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force; Write-Host "  removed $InstallDir" }
Write-Host "`nDone. Node, Git and Claude Code were left alone." -ForegroundColor Green
