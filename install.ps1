# QC Portal installer - Windows PowerShell
#
#   irm https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.ps1 | iex
#
# Installs Node.js (via winget) and Claude Code if missing, clones the repo into
# %USERPROFILE%\.qc-portal, builds it, and adds a `qc-portal` command to your PATH.
$ErrorActionPreference = 'Stop'

$Repo       = 'https://github.com/haonguyenstech/qc-portal.git'
$InstallDir = Join-Path $env:USERPROFILE '.qc-portal'
$BinDir     = Join-Path $env:LOCALAPPDATA 'qc-portal\bin'

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Info($m)   { Write-Host "  $m" }
function Step($m)   { Write-Host "`n$m" -ForegroundColor Cyan }

Write-Host "=== QC Portal installer ===" -ForegroundColor Cyan

# --- Node.js ---------------------------------------------------------------
if (-not (Have node)) {
  Step 'Installing Node.js LTS via winget...'
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
} else { Info 'Node.js found.' }

# --- Git -------------------------------------------------------------------
if (-not (Have git)) {
  Step 'Installing Git via winget...'
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
} else { Info 'Git found.' }

# winget-installed tools aren't on PATH in this session yet - add standard locations.
$env:PATH = "$env:ProgramFiles\nodejs;$env:ProgramFiles\Git\cmd;$env:PATH"

if (-not (Have node)) { throw 'Node.js not available. Open a new terminal and re-run.' }
if (-not (Have git))  { throw 'Git not available. Open a new terminal and re-run.' }

# --- Claude Code -----------------------------------------------------------
if (-not (Have claude)) {
  Step 'Installing Claude Code...'
  npm install -g @anthropic-ai/claude-code
} else { Info 'Claude Code found.' }

# --- Source ----------------------------------------------------------------
if (Test-Path (Join-Path $InstallDir '.git')) {
  Step "Updating existing install at $InstallDir ..."
  git -C $InstallDir pull --ff-only
} else {
  Step "Cloning into $InstallDir ..."
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  git clone --depth 1 $Repo $InstallDir
}

# --- Build -----------------------------------------------------------------
Step 'Installing dependencies and building (this takes a minute)...'
Push-Location $InstallDir
try {
  npm install
  npm run build
} finally { Pop-Location }

# --- PATH shim -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shim = "@echo off`r`nnode `"$InstallDir\bin\qc-portal.mjs`" %*`r`n"
Set-Content -Path (Join-Path $BinDir 'qc-portal.cmd') -Value $shim -Encoding ASCII

$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
if (-not ($userPath -split ';' | Where-Object { $_ -eq $BinDir })) {
  Step "Adding $BinDir to your PATH..."
  $newPath = if ($userPath) { "$userPath;$BinDir" } else { $BinDir }
  [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
}

Write-Host "`n=== Done! ===" -ForegroundColor Green
Write-Host 'Open a NEW terminal, then run:'
Write-Host ''
Write-Host '    qc-portal            # start the portal and open it in your browser'
Write-Host '    qc-portal --stop     # stop it'
Write-Host '    qc-portal --update   # update to the latest version'
Write-Host ''
