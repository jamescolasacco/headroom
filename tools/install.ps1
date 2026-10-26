# Installs Headroom Server to Program Files and runs it as a Windows service ("service mode"), plus the
# Headroom Server tray app. Service mode is what makes the lock screen, sign-in screen, UAC prompts and
# Ctrl+Alt+Del work remotely.
# Run from the published folder (it re-launches itself as administrator):
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
$ErrorActionPreference = "Stop"

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Re-launching as administrator..."
    Start-Process powershell -Verb RunAs -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
    exit
}

$src = $PSScriptRoot
$dst = Join-Path $env:ProgramFiles "Headroom"
if (-not (Test-Path (Join-Path $src "headroom.exe"))) { throw "Run this from the published Headroom folder (dist\Headroom)." }

# Stop what's running so files can be replaced.
Get-Process HeadroomServer -ErrorAction SilentlyContinue | Stop-Process -Force
if (Get-Service -Name Headroom -ErrorAction SilentlyContinue) {
    Write-Host "Stopping existing service..."
    Stop-Service -Name Headroom -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "Copying files to $dst ..."
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy exit $LASTEXITCODE)" }
# Downloaded as a zip, every file carries the "from the internet" mark: clear it on the installed copy.
Get-ChildItem -Path $dst -Recurse -File | Unblock-File

& (Join-Path $dst "headroom.exe") service install
if ($LASTEXITCODE -ne 0) { throw "service install failed" }

# Start menu shortcut for everyone.
$lnk = Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\Headroom Server.lnk"
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = Join-Path $dst "HeadroomServer.exe"
$sc.WorkingDirectory = $dst
$sc.Description = "Headroom Server status and settings"
$sc.Save()

# Tray app at sign-in (current user), then launch it un-elevated via Explorer.
& (Join-Path $dst "HeadroomServer.exe") --enable-autostart
Start-Process explorer.exe -ArgumentList "`"$(Join-Path $dst 'HeadroomServer.exe')`""

Write-Host ""
Write-Host "Done. Headroom Server is running as a service and in your notification area."
Write-Host "Open it from the tray icon (or Start > Headroom Server) to pair your devices."
Read-Host "Press Enter to close"
