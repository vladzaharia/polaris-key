<#
.SYNOPSIS
  P5-07's Windows end-to-end run (notes/S-11 §8 step 6): Velopack, WinSparkle and the facades,
  unsigned, against feeds rendered by the Worker's own code.

.DESCRIPTION
  1. build.ps1: pkey_win.dll, the shim and the runtime DLLs; a per-run throwaway Ed25519 key;
  2. export the probe project (e2e/game) through the SDK's export plugin: 1.0.0 and 1.0.1 as
     PKeyE2E_godot.exe (the Velopack layout) and as pkeye2e.exe (the WinSparkle layout), and a
     1.0.0 stamped as a Microsoft Store build, which must carry pkey_win.dll and none of
     velopack_libc.dll, WinSparkle.dll and the shim;
  3. pack_velopack.ps1 (vpk, the shim as --mainExe) for both versions; an Inno Setup installer for
     each WinSparkle build; the Velopack feed (bare FileNames) and the WinSparkle appcast (its
     EdDSA signature checked by the Worker's verifier and by winsparkle-tool) through
     e2e/gen_feeds.mts; e2e/server.py serves them and 302s each Velopack package, as the Worker's
     package route does;
  4. cases:
       facades       in a plain export: WinSparkle available, Velopack `runtime` (not installed by
                     Velopack), StoreContext `runtime` (no package identity), Sparkle `runtime`
       nodlls        velopack_libc.dll and WinSparkle.dll removed: both `dependency`, and every
                     class still registered (runtime loading)
       store         unpackaged: GetCurrentPackageFullName 15700, and the native query on its
                     MTA thread answers 0x803F6101, which the facade reads as `runtime`
       velopack      Setup.exe --silent for 1.0.0, then PKeyVelopackBridge.install_and_relaunch():
                     check, delta download through the 302, apply on exit, restart into 1.0.1
       winsparkle    the 1.0.0 installer /VERYSILENT, then PKeyWinSparkleBridge: check,
                     download, EdDSA, silent installer, relaunch into 1.0.1

  Needs: -Godot (the console editor exe), -Template (windows_release_x86_64.exe; default: the
  editor's installed templates), Node 22 with the workspace installed and the worker's
  dependencies built, Python 3, Rust, the .NET SDK (vpk) and Inno Setup 6.
#>
param(
  [Parameter(Mandatory)] [string]$Godot,
  [string]$Template = "",
  [string]$Work = "",
  [string]$Deps = "",
  [int]$Port = 8711
)
$ErrorActionPreference = "Stop"
$e2e = Split-Path $PSScriptRoot -Parent
$native = Split-Path $e2e -Parent
$sdk = Split-Path $native -Parent
$repo = Split-Path (Split-Path $sdk -Parent) -Parent
if (-not $Work) { $Work = Join-Path ([IO.Path]::GetTempPath()) "pkey-e2e-windows" }
if (-not $Deps) { $Deps = Join-Path $native ".deps" }
if (Test-Path $Work) { Remove-Item -Recurse -Force $Work }
New-Item -ItemType Directory -Force "$Work\keys", "$Work\out", "$Work\serve\velopack", "$Work\serve\ws", "$Work\run", "$Work\logs" | Out-Null
$Work = (Resolve-Path $Work).Path
$fwd = { param($p) $p.Replace("\", "/") }

$script:failed = 0
function Check([string]$name, [bool]$ok, [string]$detail = "") {
  if ($ok) { Write-Host "PASS $name" } else { Write-Host "FAIL $name $(if ($detail) { '— ' + $detail })"; $script:failed++ }
}
function JCheck([string]$name, [string]$case, [string]$event, [string]$expr) {
  $log = "$Work\logs\case-$case.jsonl"
  & python "$e2e\jcheck.py" $log $event $expr
  $ok = $LASTEXITCODE -eq 0
  $last = if (Test-Path $log) { (Select-String -Path $log -Pattern "`"event`":`"$event`"" | Select-Object -Last 1).Line } else { "" }
  Check $name $ok ($last | Out-String).Trim()
}

# 1. Build and key.
& pwsh -NoProfile -File "$native\windows\build.ps1" -Deps $Deps -Out "$Work\ext" *> "$Work\logs\build.log"
if ($LASTEXITCODE -ne 0) { Get-Content "$Work\logs\build.log" -Tail 60; throw "build failed" }
& node -e @'
const c = require("crypto"), fs = require("fs");
const { privateKey, publicKey } = c.generateKeyPairSync("ed25519");
fs.writeFileSync(process.argv[1] + "/seed.b64", privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"));
fs.writeFileSync(process.argv[1] + "/pub.b64", publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"));
'@ (& $fwd "$Work\keys")
$pub = (Get-Content "$Work\keys\pub.b64" -Raw).Trim()

# 2. The probe project, exports.
$game = "$Work\game"
Copy-Item -Recurse "$e2e\game" $game
New-Item -ItemType Directory -Force "$game\addons" | Out-Null
Copy-Item -Recurse "$sdk\addons\polaris_key" "$game\addons\polaris_key"
$bin = "$game\addons\polaris_key\native\bin"
if (Test-Path $bin) { Remove-Item -Recurse -Force $bin }
New-Item -ItemType Directory -Force $bin | Out-Null
Copy-Item "$Work\ext\*" $bin
Set-Content "$game\e2e.json" ('{"config": "' + (& $fwd "$Work\run\config.json") + '"}')
# Godot with a time limit (a hung editor fails this run with its log, not the job's limit).
function RunGodot([string[]]$arguments, [string]$log, [int]$seconds = 300) {
  Write-Host ("── godot {0} at {1:HH:mm:ss}" -f ($arguments -join " "), (Get-Date))
  $p = Start-Process $Godot -ArgumentList $arguments -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if (-not $p.WaitForExit($seconds * 1000)) { Write-Host "── godot timed out after $seconds s; killing it"; $p.Kill($true); return 124 }
  return $p.ExitCode
}
RunGodot @("--headless", "--path", "`"$game`"", "--import") "$Work\logs\import1.log" | Out-Null
RunGodot @("--headless", "--path", "`"$game`"", "--import") "$Work\logs\import2.log" | Out-Null

function Export([string]$version, [string]$dir, [string]$exe, [string]$outlet = "direct") {
  (Get-Content "$game\project.godot") -replace '^config/version=.*', "config/version=`"$version`"" | Set-Content "$game\project.godot"
  $tpl = ""
  if ($Template) { $t = & $fwd $Template; $tpl = "custom_template/debug=`"$t`"`ncustom_template/release=`"$t`"" }
  @"
[preset.0]

name="Windows Desktop"
platform="Windows Desktop"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter="e2e.json"
exclude_filter=""
export_path=""
script_export_mode=2

[preset.0.options]

$tpl
binary_format/embed_pck=true
binary_format/architecture="x86_64"
codesign/enable=false
application/modify_resources=false
polaris_key/outlet="$outlet"
"@ | Set-Content "$game\export_presets.cfg"
  New-Item -ItemType Directory -Force $dir | Out-Null
  RunGodot @("--headless", "--path", "`"$game`"", "--export-release", "`"Windows Desktop`"", "`"$(Join-Path $dir $exe)`"") "$Work\logs\export-$(Split-Path $dir -Leaf).log" | Out-Null
  Check "export $version -> $(Split-Path $dir -Leaf)\$exe" ((Test-Path (Join-Path $dir $exe)) -and (Test-Path (Join-Path $dir "pkey_win.dll"))) (Get-Content "$Work\logs\export-$(Split-Path $dir -Leaf).log" -Tail 5 | Out-String)
}
foreach ($v in "1.0.0", "1.0.1") {
  Export $v "$Work\out\vp-$v" "PKeyE2E_godot.exe"
  Export $v "$Work\out\ws-$v" "pkeye2e.exe"
}
Export "1.0.0" "$Work\out\msstore" "pkeye2e.exe" "ms-store"
$ms = "$Work\out\msstore"
Check "a Microsoft Store export carries pkey_win.dll and no updater DLL or shim" ((Test-Path "$ms\pkey_win.dll") -and -not (Test-Path "$ms\velopack_libc.dll") -and -not (Test-Path "$ms\WinSparkle.dll") -and -not (Test-Path "$ms\pkey_velopack_shim.exe")) ((Get-ChildItem $ms | Select-Object -ExpandProperty Name) -join ", ")
Check "a direct export carries velopack_libc.dll, WinSparkle.dll and the shim" ((Test-Path "$Work\out\ws-1.0.0\velopack_libc.dll") -and (Test-Path "$Work\out\ws-1.0.0\WinSparkle.dll") -and (Test-Path "$Work\out\vp-1.0.0\pkey_velopack_shim.exe"))

# 3. Packages, installers, feeds.
$rel = "$Work\out\releases"
foreach ($v in "1.0.0", "1.0.1") {
  & pwsh -NoProfile -File "$native\windows\pack_velopack.ps1" -ExportDir "$Work\out\vp-$v" -PackId PKeyE2E -Version $v -OutputDir $rel *> "$Work\logs\vpk-$v.log"
  Check "vpk pack $v (shim as --mainExe)" ($LASTEXITCODE -eq 0) (Get-Content "$Work\logs\vpk-$v.log" -Tail 8 | Out-String)
}
$iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
if (-not $iscc) { $iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
foreach ($v in "1.0.0", "1.0.1") {
  & $iscc /Q /DAppName=PKeyE2EWS /DAppVer=$v /DAppExe=pkeye2e.exe "/DSrcDir=$Work\out\ws-$v" "/DOutDir=$Work\out\installers" "$native\windows\installer\game.iss"
  Check "Inno Setup installer $v" ($LASTEXITCODE -eq 0)
}
Copy-Item "$rel\PKeyE2E-1.0.1-full.nupkg", "$rel\PKeyE2E-1.0.1-delta.nupkg" "$Work\serve\velopack\"
$wsInstaller = "$Work\serve\ws\PKeyE2EWS-1.0.1-setup.exe"
Copy-Item "$Work\out\installers\PKeyE2EWS-1.0.1-setup.exe" $wsInstaller
& node -e @'
const c = require("crypto"), fs = require("fs");
const seed = Buffer.from(fs.readFileSync(process.argv[1], "utf8").trim(), "base64");
const key = c.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
fs.writeFileSync(process.argv[2] + ".sig", c.sign(null, fs.readFileSync(process.argv[2]), key).toString("base64"));
'@ (& $fwd "$Work\keys\seed.b64") (& $fwd $wsInstaller)
$tool = "$Deps\winsparkle\bin\winsparkle-tool.exe"
$verify = (& $tool verify -p $pub -s (Get-Content "$wsInstaller.sig" -Raw).Trim() $wsInstaller 2>&1 | Out-String)
Check "winsparkle-tool verifies the Node signature" ($LASTEXITCODE -eq 0) $verify.Trim()
$s = & $fwd $Work
@{ outDir = "$s/serve/velopack"; feedName = "releases.win.json"; baseUrl = "http://127.0.0.1:$Port/velopack"; publicKey = $pub; productName = "PKeyE2E"; kind = "velopack"
   releases = @(@{ version = "1.0.1"; file = "$s/serve/velopack/PKeyE2E-1.0.1-full.nupkg"; deltas = @(@{ file = "$s/serve/velopack/PKeyE2E-1.0.1-delta.nupkg" }) }) } | ConvertTo-Json -Depth 6 | Set-Content "$Work\run\spec-velopack.json"
@{ outDir = "$s/serve/ws"; feedName = "appcast.xml"; baseUrl = "http://127.0.0.1:$Port/ws"; publicKey = $pub; productName = "PKeyE2EWS"; kind = "winsparkle"
   releases = @(@{ version = "1.0.1"; format = "inno"; arch = "x86_64"; file = (& $fwd $wsInstaller); sig = (& $fwd "$wsInstaller.sig") }) } | ConvertTo-Json -Depth 6 | Set-Content "$Work\run\spec-ws.json"
Push-Location $repo
foreach ($f in "velopack", "ws") {
  & pnpm exec tsx "$e2e\gen_feeds.mts" "$Work\run\spec-$f.json" *> "$Work\logs\feed-$f.log"
  Check "feed ($f) rendered by the Worker's code" ($LASTEXITCODE -eq 0) (Get-Content "$Work\logs\feed-$f.log" -Tail 5 | Out-String)
}
Pop-Location
$vfeed = Get-Content "$Work\serve\velopack\releases.win.json" -Raw | ConvertFrom-Json
Check "the Velopack feed's FileNames are bare file names" (($vfeed.Assets | Where-Object { $_.FileName -match "[/:]" }).Count -eq 0 -and $vfeed.Assets.Count -eq 2) ($vfeed.Assets.FileName -join ", ")
$appcast = Get-Content "$Work\serve\ws\appcast.xml" -Raw
Check "the WinSparkle appcast carries the verified signature and the silent installer arguments" ($appcast -match "sparkle:edSignature" -and $appcast -match "/SILENT")

$server = Start-Process python -ArgumentList "`"$e2e\server.py`"", $Port, "`"$Work\serve`"", "`"$Work\logs\srv.log`"" -PassThru -WindowStyle Hidden -RedirectStandardError "$Work\logs\server.err"
Start-Sleep 2

function RunCase([string]$name, [string]$exe, [string]$case, [string]$feed, [int]$timeout, [switch]$WaitTarget) {
  Write-Host ("── case {0} starting at {1:HH:mm:ss}" -f $name, (Get-Date))
  $log = "$Work\logs\case-$name.jsonl"
  @{ case = $case; feed = $feed; log = (& $fwd $log); headers = @{ Authorization = "Bearer e2e-token" }; public_key = $pub; target_version = "1.0.1"; quit_after_s = $timeout } | ConvertTo-Json | Set-Content "$Work\run\config.json"
  $script:mark = if (Test-Path "$Work\logs\srv.log") { (Get-Content "$Work\logs\srv.log").Count } else { 0 }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $env:PKEY_SHIM_LOG = "$Work\logs\shim-$name.log"
  Start-Process $exe | Out-Null
  while ($sw.Elapsed.TotalSeconds -lt ($timeout + 10)) {
    Start-Sleep -Milliseconds 500
    if (-not (Test-Path $log)) { continue }
    $text = Get-Content $log -Raw
    if ($text -match '"event":"target_reached"') { break }
    if (-not $WaitTarget -and $text -match '"event":"exit_tree"') { break }
  }
  Start-Sleep 2
  StopGames
  Write-Host ("── case {0}: {1:N1} s" -f $name, $sw.Elapsed.TotalSeconds)
  if (Test-Path $log) { Get-Content $log | ForEach-Object { $_.Substring(0, [Math]::Min(400, $_.Length)) } }
}
# Run an installer and wait for IT (not for the game it may start) at most 180 s.
function Install([string]$exe, [string[]]$arguments) {
  Write-Host "── install $(Split-Path $exe -Leaf) $($arguments -join ' ')"
  $p = Start-Process $exe -ArgumentList $arguments -PassThru
  if (-not $p.WaitForExit(180000)) { Write-Host "── install timed out; killing it"; $p.Kill($true) }
}
function StopGames() {
  Get-Process pkeye2e, PKeyE2E, PKeyE2E_godot -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
function HttpSince() { if (Test-Path "$Work\logs\srv.log") { Get-Content "$Work\logs\srv.log" | Select-Object -Skip $script:mark } else { @() } }

# 4a. The facades in a plain export.
RunCase facades "$Work\out\ws-1.0.0\pkeye2e.exe" facades "" 30
JCheck "facades: WinSparkle available; Velopack runtime (not a Velopack install); StoreContext runtime (no identity); Sparkle runtime" facades facades 'd["availability"]["winsparkle"]["ok"] and d["availability"]["velopack"]["detail"]["reason"] == "runtime" and d["availability"]["storecontext"]["detail"]["reason"] == "runtime" and d["availability"]["sparkle"]["detail"]["reason"] == "runtime" and d["classes"]["PKeyVelopackNative"] and d["classes"]["PKeyWinSparkleNative"] and d["classes"]["PKeyStoreContextNative"]'

# 4b. The updater DLLs removed.
$nod = "$Work\out\nodlls"
Copy-Item -Recurse "$Work\out\ws-1.0.0" $nod
Remove-Item "$nod\velopack_libc.dll", "$nod\WinSparkle.dll"
RunCase nodlls "$nod\pkeye2e.exe" facades "" 30
JCheck "nodlls: velopack_libc.dll and WinSparkle.dll missing are dependency, and every class still loads" nodlls facades 'd["availability"]["velopack"]["detail"]["reason"] == "dependency" and d["availability"]["winsparkle"]["detail"]["reason"] == "dependency" and d["classes"]["PKeyStoreContextNative"] and d["classes"]["PKeyVelopackNative"]'

# 4c. StoreContext unpackaged.
RunCase store "$Work\out\ws-1.0.0\pkeye2e.exe" store_unpackaged "" 60
JCheck "store: no package identity (15700)" store package_identity 'd["rc"] == 15700 and not d["packaged"]'
JCheck "store: the native query on its MTA thread answers 0x803F6101, read as runtime (not a Store install)" store store_result 'd["event"] == "store_result" and d["detail"]["hresult"].upper() == "0X803F6101" and d["interpreted"]["detail"]["reason"] == "runtime"'

# 4d. Velopack.
@{ case = "idle"; log = (& $fwd "$Work\logs\case-vp-install.jsonl"); quit_after_s = 10 } | ConvertTo-Json | Set-Content "$Work\run\config.json"
Install "$rel\PKeyE2E-1.0.0-Setup.exe" @("--silent")
Start-Sleep 4
Get-Process PKeyE2E_godot -ErrorAction SilentlyContinue | Stop-Process -Force
$app = "$env:LOCALAPPDATA\PKeyE2E"
Check "velopack: Setup.exe --silent installed 1.0.0 with the shim as the main exe" ((Test-Path "$app\current\PKeyE2E.exe") -and (Test-Path "$app\current\PKeyE2E_godot.exe") -and (Test-Path "$app\Update.exe"))
RunCase velopack "$app\current\PKeyE2E.exe" velopack_update "http://127.0.0.1:$Port/velopack/" 120 -WaitTarget
JCheck "velopack: PKeyVelopackBridge applied on exit and the shim restarted into 1.0.1" velopack target_reached 'True'
$http = HttpSince
Check "velopack: the feed request carried the bearer" (($http | Where-Object { $_ -match '"/velopack/releases.win.json' -and $_ -match 'Bearer e2e-token' }).Count -ge 1) ($http -join "`n")
Check "velopack: the delta was fetched through the 302 package route, not the full package" (($http | Where-Object { $_ -match '"/velopack/PKeyE2E-1.0.1-delta.nupkg' -and $_ -match '"status": 302' }).Count -ge 1 -and ($http | Where-Object { $_ -match '/bytes/velopack/PKeyE2E-1.0.1-delta.nupkg' }).Count -ge 1 -and ($http | Where-Object { $_ -match 'full.nupkg' }).Count -eq 0) ($http -join "`n")

# 4e. WinSparkle.
@{ case = "idle"; log = (& $fwd "$Work\logs\case-ws-install.jsonl"); quit_after_s = 10 } | ConvertTo-Json | Set-Content "$Work\run\config.json"
Install "$Work\out\installers\PKeyE2EWS-1.0.0-setup.exe" @("/VERYSILENT", "/SUPPRESSMSGBOXES")
Start-Sleep 4
Get-Process pkeye2e -ErrorAction SilentlyContinue | Stop-Process -Force
$wsapp = "$env:LOCALAPPDATA\PKeyE2EWS"
RunCase winsparkle "$wsapp\pkeye2e.exe" winsparkle_update "http://127.0.0.1:$Port/ws/appcast.xml" 150 -WaitTarget
JCheck "winsparkle: PKeyWinSparkleBridge ran the verified installer and 1.0.1 started" winsparkle target_reached 'True'
JCheck "winsparkle: shutdown_request reached the game" winsparkle "native:shutdown_request" 'True'
$http = HttpSince
Check "winsparkle: the appcast and the installer carried the bearer" (($http | Where-Object { $_ -match '/ws/appcast.xml' -and $_ -match 'Bearer e2e-token' }).Count -ge 1 -and ($http | Where-Object { $_ -match '/ws/PKeyE2EWS-1.0.1-setup.exe' -and $_ -match 'Bearer e2e-token' }).Count -ge 1) ($http -join "`n")
$dv = (Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue | Where-Object DisplayName -eq "PKeyE2EWS" | Select-Object -First 1).DisplayVersion
Check "winsparkle: the uninstall entry says 1.0.1" ($dv -eq "1.0.1") "DisplayVersion=$dv"

Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
Remove-Item "$Work\keys\seed.b64" -ErrorAction SilentlyContinue
Write-Host "── Windows e2e: $script:failed failed; logs in $Work\logs"
exit $(if ($script:failed -eq 0) { 0 } else { 1 })
