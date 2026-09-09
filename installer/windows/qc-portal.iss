; QC Portal - Inno Setup script. Wraps the repo's own install.ps1 into ONE
; double-clickable .exe, for a QC engineer who should not have to open a terminal.
;
; Build it on Windows (Inno Setup 6.3+):
;   winget install JRSoftware.InnoSetup
;   & "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" installer\windows\qc-portal.iss
; Output: installer\windows\dist\QC-Portal-Setup.exe
;
; It is a THIN WRAPPER, and that is the whole design:
;
;   * The payload is `..\..\install.ps1` - THE ROOT INSTALLER ITSELF, referenced at
;     build time, not a copy. There is one implementation of the install; the .exe
;     just carries it to a machine that has no curl one-liner pasted into a terminal.
;   * It bundles no Node, no repo and no built app. The install stays an ordinary git
;     checkout in %USERPROFILE%\.qc-portal, which is exactly what lets
;     `qc-portal --update` keep working - a packaged blob would have to be replaced
;     wholesale by an app updater instead.
;
; NOT code-signed: SmartScreen will warn about an unknown publisher and the user has
; to click "More info" -> "Run anyway". Signing needs a paid certificate.

#define AppName "QC Portal"
#define AppPublisher "STS Data"
#define AppURL "https://github.com/haonguyenstech/qc-portal"

[Setup]
AppId={{7C1B5F42-2E44-4B90-9E1F-3A6D5B0C71E4}
AppName={#AppName}
AppVersion=1.0
AppVerName={#AppName} setup
AppPublisher={#AppPublisher}
AppSupportURL={#AppURL}
; No admin rights: install.ps1 only writes under the user's own profile.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; Nothing is installed INTO an app dir - install.ps1 owns the layout - so don't ask
; for one, and don't leave an Add/Remove entry pointing at an empty folder.
; Removal is installer\windows\uninstall.ps1, which arrives with the checkout.
CreateAppDir=no
Uninstallable=no
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=QC-Portal-Setup
SetupIconFile=..\icons\qc-portal.ico
WizardStyle=modern
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Messages]
WelcomeLabel2=This installs {#AppName} for your account only - no administrator rights needed.%n%nIt installs Node.js, Git and Claude Code if they are missing, downloads the portal, builds it, and adds a Desktop and Start Menu shortcut.%n%nThe first run takes a few minutes and prints its progress in a console window.

[Files]
; The root installer, referenced in place. Never a copy: one implementation only.
Source: "..\..\install.ps1"; DestDir: "{tmp}"; Flags: dontcopy

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    ExtractTemporaryFile('install.ps1');
    // powershell.exe is a CONSOLE app, so its window shows the npm install / build
    // progress. Deliberate: the first run takes minutes, and a silent wizard with no
    // output reads as a hang.
    if not Exec('powershell.exe',
                '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\install.ps1') + '"',
                '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
      MsgBox('Could not start PowerShell.', mbError, MB_OK)
    else if ResultCode <> 0 then
      MsgBox('The installer reported an error. The console window says what failed.', mbError, MB_OK);
  end;
end;
