# Installs Headroom Viewer for the current user (no administrator rights needed) and adds Start menu and
# desktop shortcuts. Run from the published viewer folder:
#   powershell -ExecutionPolicy Bypass -File .\install-viewer.ps1
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
if (-not (Test-Path (Join-Path $src "HeadroomViewer.exe"))) { throw "Run this from the published Headroom Viewer folder (dist\HeadroomViewer)." }
$dst = Join-Path $env:LOCALAPPDATA "Programs\Headroom Viewer"

Get-Process HeadroomViewer -ErrorAction SilentlyContinue | Stop-Process -Force
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy exit $LASTEXITCODE)" }

$shell = New-Object -ComObject WScript.Shell
foreach ($lnk in @(
    (Join-Path ([Environment]::GetFolderPath("Programs")) "Headroom Viewer.lnk"),
    (Join-Path ([Environment]::GetFolderPath("Desktop")) "Headroom Viewer.lnk"))) {
    $sc = $shell.CreateShortcut($lnk)
    $sc.TargetPath = Join-Path $dst "HeadroomViewer.exe"
    $sc.WorkingDirectory = $dst
    $sc.Description = "Connect to your Headroom computers"
    $sc.Save()
}

Write-Host "Headroom Viewer installed to $dst (Start menu + desktop shortcut)."
Start-Process (Join-Path $dst "HeadroomViewer.exe")
