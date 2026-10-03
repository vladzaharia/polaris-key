<#
.SYNOPSIS
  Authenticode-signs the Windows plugin files and a game's executables and installers (P5-07;
  notes/S-11 §7 row 5). Needs the owner's certificate: nothing in this repository's CI runs it.

.DESCRIPTION
  Signs, in order, each -Files entry with signtool (SHA-256 file digest, RFC 3161 timestamp), then
  verifies it with `signtool verify /pa`. Sign the inner files before anything that embeds them:
  pkey_win.dll, velopack_libc.dll, WinSparkle.dll, pkey_velopack_shim.exe (or <Game>.exe) and
  <Game>_godot.exe first; then let vpk sign its own outputs (pack_velopack.ps1 -SignParams or
  -AzureTrustedSignFile) and sign the Inno Setup or NSIS installer last.

  One credential, the first given:
    -Thumbprint       a certificate in the user's or machine's store (/sha1)
    -PfxPath          a .pfx file, with its password in PKEY_SIGN_PFX_PASSWORD (/f /p)
    -AzureMetadata    Azure Artifact Signing: metadata JSON and -AzureDlib, the
                      Azure.CodeSigning.Dlib.dll path (/dlib /dmdf)

.EXAMPLE
  pwsh sign.ps1 -Thumbprint 0123… -Files bin\pkey_win.dll, bin\velopack_libc.dll, out\Game_godot.exe
#>
param(
  [Parameter(Mandatory)] [string[]]$Files,
  [string]$Thumbprint = "",
  [string]$PfxPath = "",
  [string]$AzureMetadata = "",
  [string]$AzureDlib = "",
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)
$ErrorActionPreference = "Stop"
$signtool = (Get-Command signtool -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue | Where-Object FullName -match "\\x64\\" | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) { throw "signtool.exe not found (install the Windows SDK)" }
$cred = @()
if ($Thumbprint) { $cred = @("/sha1", $Thumbprint) }
elseif ($PfxPath) {
  if (-not $env:PKEY_SIGN_PFX_PASSWORD) { throw "set PKEY_SIGN_PFX_PASSWORD for -PfxPath" }
  $cred = @("/f", $PfxPath, "/p", $env:PKEY_SIGN_PFX_PASSWORD)
}
elseif ($AzureMetadata) {
  if (-not $AzureDlib) { throw "-AzureMetadata needs -AzureDlib" }
  $cred = @("/dlib", $AzureDlib, "/dmdf", $AzureMetadata)
}
else { throw "no signing credential: pass -Thumbprint, -PfxPath or -AzureMetadata (the owner's)" }
foreach ($f in $Files) {
  & $signtool sign /fd SHA256 /tr $TimestampUrl /td SHA256 @cred $f
  if ($LASTEXITCODE -ne 0) { throw "signtool sign failed for $f" }
  & $signtool verify /pa $f
  if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $f" }
}
