# Installs Headroom to Program Files and runs it as a Windows service ("service mode").
# Service mode is what makes the lock screen, sign-in screen, UAC prompts and Ctrl+Alt+Del work remotely.
# Run from an elevated PowerShell in the published folder:
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

# Stop an existing service so files can be replaced.
if (Get-Service -Name Headroom -ErrorAction SilentlyContinue) {
    Write-Host "Stopping existing service..."
    Stop-Service -Name Headroom -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "Copying files to $dst ..."
New-Item -ItemType Directory -Force -Path $dst | Out-Null
robocopy $src $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copy failed (robocopy exit $LASTEXITCODE)" }

& (Join-Path $dst "headroom.exe") service install
if ($LASTEXITCODE -ne 0) { throw "service install failed" }

Write-Host ""
$hasPw = $false
try { $hasPw = (Invoke-RestMethod -Uri "http://127.0.0.1:7080/api/info" -TimeoutSec 5).paired } catch { }
if (-not $hasPw) {
    Write-Host "Set the password that new devices will use to pair:"
    & (Join-Path $dst "headroom.exe") set-password
}
Write-Host ""
Write-Host "Done. Open http://localhost:7080/admin.html for addresses, pairing codes and settings."
Read-Host "Press Enter to close"
