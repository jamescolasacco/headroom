# Removes Headroom Viewer for the current user. Add -Purge to also delete saved computers and trusted keys.
param([switch]$Purge)
$ErrorActionPreference = "Stop"
Get-Process HeadroomViewer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Remove-Item (Join-Path $env:LOCALAPPDATA "Programs\Headroom Viewer") -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath("Programs")) "Headroom Viewer.lnk") -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "Headroom Viewer.lnk") -ErrorAction SilentlyContinue
if ($Purge) { Remove-Item (Join-Path $env:LOCALAPPDATA "Headroom Viewer") -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host ("Headroom Viewer removed." + $(if ($Purge) { " Saved computers and trusted keys deleted." } else { " Saved computers kept (use -Purge to delete)." }))
