; Headroom Server for Windows: the installer people download (Headroom-Server-Setup.exe), and what its updater
; runs (silently) to install a new version. It does what tools/install.ps1 does: the files in Program
; Files\Headroom, the Headroom service (lock screen, sign-in screen, UAC prompts, Ctrl+Alt+Del), the tray app at
; sign-in, a Start menu entry. Build: iscc /DVersion=1.2.3 tools\windows-installer\HeadroomServer.iss
; (after tools\publish.ps1 made dist\Headroom).

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\..\dist\Headroom"
#endif

[Setup]
AppId={{6F3A2C1E-8B4D-4E7A-9C25-3D1B7E0A4F62}
AppName=Headroom Server
AppVersion={#Version}
AppVerName=Headroom Server {#Version}
AppPublisher=Headroom
AppPublisherURL=https://github.com/jamescolasacco/headroom
AppSupportURL=https://github.com/jamescolasacco/headroom/issues
AppUpdatesURL=https://github.com/jamescolasacco/headroom/releases/latest
VersionInfoVersion={#Version}
VersionInfoProductTextVersion={#Version}
VersionInfoDescription=Headroom Server setup
; Always Program Files\Headroom: the service, the updater and the uninstaller expect it there.
DefaultDirName={autopf}\Headroom
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
UsedUserAreasWarning=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\..\dist\release
OutputBaseFilename=Headroom-Server-Setup
SetupIconFile=..\..\assets\headroom.ico
UninstallDisplayIcon={app}\HeadroomServer.exe
UninstallDisplayName=Headroom Server
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Messages]
WelcomeLabel2=This installs Headroom Server, so you can reach this PC from your other devices, or let someone you trust connect with a code.%n%nIt runs as a Windows service, so the lock screen, the sign-in screen and UAC prompts work remotely too.

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{commonprograms}\Headroom Server"; Filename: "{app}\HeadroomServer.exe"; Comment: "Headroom Server status and settings"

[Registry]
; The tray app at sign-in, on a first install (an update leaves "Start with Windows" as you set it).
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Headroom Server"; ValueData: """{app}\HeadroomServer.exe"" --tray"; Flags: uninsdeletevalue; Check: IsFirstInstall

[Run]
; Creates (or recreates) and starts the service, its firewall rule and its data folder.
Filename: "{app}\headroom.exe"; Parameters: "service install"; Flags: runhidden waituntilterminated; StatusMsg: "Starting the Headroom service…"
; The tray app, as you (not as administrator): Explorer opens it in your session. Also after a silent update.
Filename: "{win}\explorer.exe"; Parameters: """{app}\HeadroomServer.exe"""; Description: "Open Headroom Server"; Flags: postinstall nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM HeadroomServer.exe"; Flags: runhidden waituntilterminated; RunOnceId: "StopTray"
Filename: "{app}\headroom.exe"; Parameters: "service uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function IsFirstInstall: Boolean;
begin
  Result := not RegKeyExists(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6F3A2C1E-8B4D-4E7A-9C25-3D1B7E0A4F62}_is1');
end;

// Stop what's running (the service and its session agent, the tray app) so its files can be replaced.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\net.exe'), 'stop Headroom', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM HeadroomServer.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM headroom.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(1000);
  Result := '';
end;
