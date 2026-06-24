@echo off
REM QC Portal installer - Windows Command Prompt (cmd.exe, no PowerShell)
REM
REM   curl -fsSLo "%TEMP%\qc-install.bat" https://raw.githubusercontent.com/haonguyenstech/qc-portal/main/install.bat ^&^& "%TEMP%\qc-install.bat"
REM
REM Installs Node.js (via winget) and Claude Code if missing, clones the repo into
REM %USERPROFILE%\.qc-portal, builds it, and adds a `qc-portal` command to your PATH.
setlocal enabledelayedexpansion

set "REPO=https://github.com/haonguyenstech/qc-portal.git"
set "INSTALL_DIR=%USERPROFILE%\.qc-portal"
set "BIN_DIR=%LOCALAPPDATA%\qc-portal\bin"

echo(
echo === QC Portal installer ===
echo(

REM --- Node.js -------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Installing Node.js LTS via winget...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
) else (
  echo Node.js found.
)

REM --- Git -----------------------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
  echo Installing Git via winget...
  winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
) else (
  echo Git found.
)

REM winget-installed tools are not on PATH in this session yet - add the standard
REM install locations so we can build right away.
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles%\Git\cmd;%PATH%"

where node >nul 2>nul || (echo ERROR: Node.js not available. Open a new terminal and re-run. & exit /b 1)
where git  >nul 2>nul || (echo ERROR: Git not available. Open a new terminal and re-run. & exit /b 1)

REM --- Claude Code ---------------------------------------------------------
where claude >nul 2>nul
if errorlevel 1 (
  echo Installing Claude Code...
  call npm install -g @anthropic-ai/claude-code
) else (
  echo Claude Code found.
)

REM --- Source --------------------------------------------------------------
if exist "%INSTALL_DIR%\.git" (
  echo Updating existing install at %INSTALL_DIR% ...
  pushd "%INSTALL_DIR%"
  git pull --ff-only
  popd
) else (
  echo Cloning into %INSTALL_DIR% ...
  if exist "%INSTALL_DIR%" rmdir /s /q "%INSTALL_DIR%"
  git clone --depth 1 "%REPO%" "%INSTALL_DIR%"
)
if errorlevel 1 (echo ERROR: failed to fetch source. & exit /b 1)

REM --- Build ---------------------------------------------------------------
echo Installing dependencies and building (this takes a minute)...
pushd "%INSTALL_DIR%"
call npm install
if errorlevel 1 (echo ERROR: npm install failed. & popd & exit /b 1)
call npm run build
if errorlevel 1 (echo ERROR: build failed. & popd & exit /b 1)
popd

REM --- PATH shim -----------------------------------------------------------
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
> "%BIN_DIR%\qc-portal.cmd" echo @echo off
>>"%BIN_DIR%\qc-portal.cmd" echo node "%INSTALL_DIR%\bin\qc-portal.mjs" %%*

echo %PATH% | find /i "%BIN_DIR%" >nul
if errorlevel 1 (
  echo Adding %BIN_DIR% to your PATH...
  for /f "skip=2 tokens=2,*" %%A in ('reg query HKCU\Environment /v PATH 2^>nul') do set "USERPATH=%%B"
  if defined USERPATH (
    setx PATH "%USERPATH%;%BIN_DIR%" >nul
  ) else (
    setx PATH "%BIN_DIR%" >nul
  )
)

echo(
echo === Done! ===
echo Open a NEW Command Prompt, then run:
echo(
echo     qc-portal            ^> start the portal and open it in your browser
echo     qc-portal --stop     ^> stop it
echo     qc-portal --update   ^> update to the latest version
echo(
endlocal
