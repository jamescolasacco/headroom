# Builds a self-contained Windows release into dist\Headroom (no .NET install needed on the target PC).
#   powershell -ExecutionPolicy Bypass -File tools\publish.ps1
param([string]$Runtime = "win-x64")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$proj = Join-Path $root "host-windows\Headroom.Host\Headroom.Host.csproj"
$out = Join-Path $root "dist\Headroom"

$dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
$userDotnet = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe"
if (Test-Path $userDotnet) { $dotnet = $userDotnet }
if (-not $dotnet) { throw "The .NET 10 SDK is required to build (https://dot.net)." }

$env:DOTNET_CLI_TELEMETRY_OPTOUT = "1"
$env:DOTNET_NOLOGO = "1"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
& $dotnet publish $proj -c Release -r $Runtime --self-contained true -o $out `
    -p:PublishReadyToRun=true -p:DebugType=none -p:GenerateDocumentationFile=false
if ($LASTEXITCODE -ne 0) { throw "publish failed" }
Copy-Item (Join-Path $root "tools\install.ps1") $out
Copy-Item (Join-Path $root "tools\uninstall.ps1") $out
Write-Host ""
Write-Host "Published to $out"
Write-Host "Try it:   $out\headroom.exe"
Write-Host "Install:  right-click $out\install.ps1 > Run with PowerShell (as administrator)"
