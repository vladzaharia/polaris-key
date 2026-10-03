<#
.SYNOPSIS
  Builds the Windows plugins (P5-07): pkey_win.dll (Velopack, WinSparkle, StoreContext) and the
  Velopack launcher shim, and stages them with their runtime DLLs.

.DESCRIPTION
  1. fetch_deps.sh (through Git Bash) puts deps.env's godot-cpp, velopack_libc and WinSparkle under
     -Deps, each checked against its pin;
  2. SCons >= 4.11 builds godot-cpp (template_release, x86_64, the 4.4 API, exceptions on) and
     pkey_win.dll with MSVC (notes/S-11 §8 step 1). Caching -Deps\godot-cpp (it holds the SCons
     signature database) makes a rebuild incremental;
  3. cargo builds the shim (velopack crate pinned by Cargo.lock);
  4. -Out (default native\windows\dist) receives pkey_win.dll, pkey_win.gdextension,
     velopack_libc.dll (the archive's velopack_libc_win_x64_msvc.dll under the name the plugin
     loads), WinSparkle.dll and pkey_velopack_shim.exe. -Install <project> copies them into
     <project>\addons\polaris_key\native\bin\.

  Nothing here signs; sign.ps1 does, in a release job with the owner's certificate.

.EXAMPLE
  pwsh sdks/godot/native/windows/build.ps1 -Install C:\src\game
#>
param(
  [string]$Deps = "",
  [string]$Out = "",
  [string]$Install = "",
  [int]$Jobs = [Environment]::ProcessorCount,
  [switch]$SkipShim
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$native = Split-Path $here -Parent
if (-not $Deps) { $Deps = Join-Path $native ".deps" }
if (-not $Out) { $Out = Join-Path $here "dist" }
New-Item -ItemType Directory -Force $Deps, $Out | Out-Null
$Deps = (Resolve-Path $Deps).Path
$Out = (Resolve-Path $Out).Path

$pins = @{}
Get-Content (Join-Path $native "deps.env") | Where-Object { $_ -match '^([A-Z0-9_]+)=(.*)$' } | ForEach-Object { $pins[$Matches[1]] = $Matches[2] }

# 1. Inputs (Git Bash runs the same fetch script as macOS).
$bash = (Get-Command bash -ErrorAction SilentlyContinue).Source
if (-not $bash) { $bash = "$env:ProgramFiles\Git\bin\bash.exe" }
& $bash (Join-Path $native "fetch_deps.sh").Replace("\", "/") $Deps.Replace("\", "/") godot-cpp velopack winsparkle
if ($LASTEXITCODE -ne 0) { throw "fetch_deps.sh failed" }

# 2. godot-cpp and pkey_win.dll.
$scons = (& python -c "import SCons, sys; print(SCons.__version__)" 2>$null)
if (-not $scons -or [version]$scons -lt [version]"4.11") {
  & python -m pip install --quiet "scons==$($pins.SCONS_VERSION)"
  if ($LASTEXITCODE -ne 0) { throw "pip install scons failed" }
}
$t0 = Get-Date
Push-Location $here
try {
  & python -m SCons -Q "godot_cpp=$Deps\godot-cpp" "velopack=$Deps\velopack" platform=windows target=template_release arch=x86_64 "api_version=$($pins.GODOT_CPP_API)" disable_exceptions=no use_mingw=no "-j$Jobs"
  if ($LASTEXITCODE -ne 0) { throw "scons failed" }
} finally { Pop-Location }
Write-Host ("build.ps1: pkey_win.dll in {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds)

# 3. The shim.
if (-not $SkipShim) {
  $t0 = Get-Date
  Push-Location (Join-Path $here "velopack\shim")
  try {
    & cargo build --release --locked
    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }
  } finally { Pop-Location }
  Write-Host ("build.ps1: shim in {0:N0} s" -f ((Get-Date) - $t0).TotalSeconds)
}

# 4. Stage.
Copy-Item (Join-Path $here "bin\pkey_win.dll"), (Join-Path $here "pkey_win.gdextension") $Out -Force
Copy-Item "$Deps\velopack\lib\velopack_libc_win_x64_msvc.dll" (Join-Path $Out "velopack_libc.dll") -Force
Copy-Item "$Deps\winsparkle\x64\Release\WinSparkle.dll" $Out -Force
$shim = Join-Path $here "velopack\shim\target\release\pkey_velopack_shim.exe"
if (Test-Path $shim) { Copy-Item $shim $Out -Force }

# pkey_win.dll must not import either updater DLL (a missing one would unload the extension).
$dumpbin = Get-ChildItem "${env:ProgramFiles}\Microsoft Visual Studio" -Recurse -Filter dumpbin.exe -ErrorAction SilentlyContinue | Where-Object FullName -match "Hostx64\\x64" | Select-Object -First 1
if ($dumpbin) {
  $deps = (& $dumpbin.FullName /dependents (Join-Path $Out "pkey_win.dll") | Out-String)
  if ($deps -match "(?i)velopack|winsparkle") { throw "pkey_win.dll import-links an updater DLL:`n$deps" }
  Write-Host $deps
}
Get-ChildItem $Out | Format-Table Name, Length

if ($Install) {
  $bin = Join-Path $Install "addons\polaris_key\native\bin"
  New-Item -ItemType Directory -Force $bin | Out-Null
  Copy-Item (Join-Path $Out "*") $bin -Force
  Write-Host "build.ps1: installed into $bin"
}
