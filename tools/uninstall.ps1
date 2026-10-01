# Removes the Headroom service and program files. Add -Purge to also delete pairings, certificates and settings.
param([switch]$Purge)
$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" + ($(if ($Purge) { " -Purge" } else { "" }))
    Start-Process powershell -Verb RunAs -ArgumentList $arg
    exit
}
$dst = Join-Path $env:ProgramFiles "Headroom"
$exe = Join-Path $dst "headroom.exe"
if (Test-Path $exe) {
    if ($Purge) { & $exe service uninstall --purge } else { & $exe service uninstall }
}
Start-Sleep -Seconds 1
if (Test-Path $dst) { Remove-Item -Recurse -Force $dst }
Write-Host "Headroom removed." + ($(if ($Purge) { " Data deleted." } else { " Pairings kept in $env:ProgramData\Headroom (use -Purge to delete)." }))
Read-Host "Press Enter to close"
