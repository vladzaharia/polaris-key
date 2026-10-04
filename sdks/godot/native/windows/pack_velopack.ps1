<#
.SYNOPSIS
  Packs a Godot Windows export with Velopack, the shim as --mainExe (P5-07; notes/S-11 §8 step 2).

.DESCRIPTION
  -ExportDir is a Windows export whose executable is named <PackId>_godot.exe and which carries
  the Windows GDExtension's [dependencies] (pkey_win.dll, velopack_libc.dll, WinSparkle.dll,
  pkey_velopack_shim.exe). The script copies the shim in as <PackId>.exe (the shim starts
  <own stem>_godot.exe beside itself), then runs

    vpk pack --runtime win-x64 --packId <PackId> --packVersion <Version> --packDir <ExportDir>
             --mainExe <PackId>.exe --outputDir <OutputDir> [--channel] [signing]

  Without --runtime vpk defaults to x86. vpk overwrites <PackId>-win-Setup.exe on every pack, so
  the script keeps a copy as <PackId>-<Version>-Setup.exe. Signing (the owner's certificate):
  -SignParams is passed to vpk --signParams (signtool arguments, for example
  "/fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint>"), or
  -AzureTrustedSignFile to --azureTrustedSignFile (Azure Artifact Signing metadata JSON).
  Release the outputs through `pkey release publish`; the Worker renders releases.<channel>.json
  with bare FileNames and redirects each to its delivery URL.
#>
param(
  [Parameter(Mandatory)] [string]$ExportDir,
  [Parameter(Mandatory)] [string]$PackId,
  [Parameter(Mandatory)] [string]$Version,
  [Parameter(Mandatory)] [string]$OutputDir,
  [string]$Channel = "",
  [string]$SignParams = "",
  [string]$AzureTrustedSignFile = ""
)
$ErrorActionPreference = "Stop"
$godot = Join-Path $ExportDir "$($PackId)_godot.exe"
$shim = Join-Path $ExportDir "pkey_velopack_shim.exe"
if (-not (Test-Path $godot)) { throw "$godot is missing: export the game as $($PackId)_godot.exe" }
if (-not (Test-Path $shim)) { throw "$shim is missing: install the Windows plugins (build.ps1 -Install) before exporting" }
Copy-Item $shim (Join-Path $ExportDir "$PackId.exe") -Force
Remove-Item $shim
$vpkArgs = @("pack", "--runtime", "win-x64", "--packId", $PackId, "--packVersion", $Version, "--packDir", $ExportDir, "--mainExe", "$PackId.exe", "--outputDir", $OutputDir, "--yes")
if ($Channel) { $vpkArgs += @("--channel", $Channel) }
if ($SignParams) { $vpkArgs += @("--signParams", $SignParams) }
if ($AzureTrustedSignFile) { $vpkArgs += @("--azureTrustedSignFile", $AzureTrustedSignFile) }
& vpk @vpkArgs
if ($LASTEXITCODE -ne 0) { throw "vpk pack failed" }
$setup = Join-Path $OutputDir "$PackId-win-Setup.exe"
if ($Channel) { $setup = Join-Path $OutputDir "$PackId-$Channel-Setup.exe" }
if (Test-Path $setup) { Copy-Item $setup (Join-Path $OutputDir "$PackId-$Version-Setup.exe") -Force }
Get-ChildItem $OutputDir | Format-Table Name, Length
