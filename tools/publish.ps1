# Builds self-contained Windows releases (no .NET install needed on the target PC):
#   dist\Headroom        Headroom Server — engine (service) + tray app, installed with install.ps1 (admin)
#   dist\HeadroomViewer  Headroom Viewer — installed per-user with install-viewer.ps1 (no admin)
#   powershell -ExecutionPolicy Bypass -File tools\publish.ps1 [-Only server|viewer]
param([string]$Runtime = "win-x64", [ValidateSet("", "server", "viewer")][string]$Only = "")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
$userDotnet = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe"
if (Test-Path $userDotnet) { $dotnet = $userDotnet }
if (-not $dotnet) { throw "The .NET 10 SDK is required to build (https://dot.net)." }
$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"

function Publish($project, $out, $label) {
    & $dotnet publish (Join-Path $root $project) -c Release -r $Runtime --self-contained true -o $out `
        -p:PublishReadyToRun=true -p:DebugType=none -p:GenerateDocumentationFile=false
    if ($LASTEXITCODE -ne 0) { throw "publish failed ($label)" }
}

if ($Only -ne "viewer") {
    $server = Join-Path $root "dist\Headroom"
    if (Test-Path $server) { Remove-Item -Recurse -Force $server }
    Publish "host-windows\Headroom.Host\Headroom.Host.csproj" $server "engine"
    # The tray app shares the same self-contained runtime folder (same .NET version).
    Publish "host-windows\Headroom.Server\Headroom.Server.csproj" $server "tray app"
    Copy-Item (Join-Path $root "tools\install.ps1") $server
    Copy-Item (Join-Path $root "tools\uninstall.ps1") $server
    Write-Host ""
    Write-Host "Headroom Server -> $server"
    Write-Host "  Try it:   $server\HeadroomServer.exe   (tray app; runs the engine in user mode)"
    Write-Host "  Install:  powershell -ExecutionPolicy Bypass -File $server\install.ps1   (admin; service mode)"
}

if ($Only -ne "server") {
    $viewer = Join-Path $root "dist\HeadroomViewer"
    if (Test-Path $viewer) { Remove-Item -Recurse -Force $viewer }
    Publish "viewer-windows\Headroom.Viewer\Headroom.Viewer.csproj" $viewer "viewer"
    Copy-Item (Join-Path $root "tools\install-viewer.ps1") $viewer
    Copy-Item (Join-Path $root "tools\uninstall-viewer.ps1") $viewer
    Write-Host ""
    Write-Host "Headroom Viewer -> $viewer"
    Write-Host "  Try it:   $viewer\HeadroomViewer.exe"
    Write-Host "  Install:  powershell -ExecutionPolicy Bypass -File $viewer\install-viewer.ps1   (no admin)"
}
