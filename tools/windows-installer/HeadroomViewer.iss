; Headroom Viewer for Windows: the installer people download (Headroom-Viewer-Setup.exe), and what its updater
; runs (silently) to install a new version. Per user, no administrator rights: %LOCALAPPDATA%\Programs\Headroom
; Viewer, with Start menu and desktop shortcuts (like tools/install-viewer.ps1).
; Build: iscc /DVersion=1.2.3 tools\windows-installer\HeadroomViewer.iss (after tools\publish.ps1 made dist\HeadroomViewer).

#ifndef Version
  #define Version "0.0.0"
#endif
#ifndef Source
  #define Source "..\..\dist\HeadroomViewer"
#endif

[Setup]
AppId={{B52D7E94-1A3C-4F6B-8E07-9C4D2A6F1B83}
AppName=Headroom Viewer
AppVersion={#Version}
AppVerName=Headroom Viewer {#Version}
AppPublisher=Headroom
AppPublisherURL=https://github.com/jamescolasacco/headroom
AppSupportURL=https://github.com/jamescolasacco/headroom/issues
AppUpdatesURL=https://github.com/jamescolasacco/headroom/releases/latest
VersionInfoVersion={#Version}
VersionInfoProductTextVersion={#Version}
VersionInfoDescription=Headroom Viewer setup
; Always %LOCALAPPDATA%\Programs\Headroom Viewer: the updater expects it there.
DefaultDirName={autopf}\Headroom Viewer
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=..\..\dist\release
OutputBaseFilename=Headroom-Viewer-Setup
SetupIconFile=..\..\assets\headroom.ico
UninstallDisplayIcon={app}\HeadroomViewer.exe
UninstallDisplayName=Headroom Viewer
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

[Messages]
WelcomeLabel2=This installs Headroom Viewer, to connect to your computers (and to someone else's with the code they give you).

[Tasks]
Name: "desktopicon"; Description: "Add a shortcut on the desktop"

[Files]
Source: "{#Source}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Headroom Viewer"; Filename: "{app}\HeadroomViewer.exe"; Comment: "Connect to your Headroom computers"
Name: "{userdesktop}\Headroom Viewer"; Filename: "{app}\HeadroomViewer.exe"; Comment: "Connect to your Headroom computers"; Tasks: desktopicon

[Run]
; Opens it at the end, also after a silent update.
Filename: "{app}\HeadroomViewer.exe"; Description: "Open Headroom Viewer"; Flags: postinstall nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM HeadroomViewer.exe"; Flags: runhidden waituntilterminated; RunOnceId: "StopViewer"

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM HeadroomViewer.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
  Sleep(500);
  Result := '';
end;
