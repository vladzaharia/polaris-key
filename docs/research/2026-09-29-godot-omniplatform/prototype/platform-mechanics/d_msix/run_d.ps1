<#
.SYNOPSIS
  S-05 (d): MSIX user:// virtualization, install-directory writability, update and uninstall,
  on a Windows 10 1903+ / Windows 11 machine you may add a throwaway trusted certificate to.

.DESCRIPTION
  Not run yet: no Windows host was available for S-05 (notes/S-05-godot-platform-mechanics.md section 4.4 and 7).
  Run it from an elevated Windows PowerShell 5.1 or PowerShell 7 prompt on a disposable VM, after
  build_d.sh has produced ..\build\d\layout-1.0.0.0 and ..\build\d\layout-1.0.1.0 (build_d.sh runs
  on macOS or Linux; copy the whole platform-mechanics directory across).

  Steps:
    1. Finds makeappx.exe and signtool.exe in the Windows 10/11 SDK.
    2. Creates a self-signed code-signing certificate (subject = -Publisher) in CurrentUser\My and
       trusts it in LocalMachine\TrustedPeople. Nothing is exported with a private key; the
       certificate is removed again at the end unless -KeepCert is given.
    3. Seeds the *real* %APPDATA%\Godot\app_userdata\s05msix\s05d_preexisting.txt (what an earlier
       unpackaged install would have left).
    4. makeappx pack + signtool sign for 1.0.0.0 and 1.0.1.0.
    5. install 1.0.0.0 -> probe "install" -> probe "relaunch" -> update to 1.0.1.0 -> probe "update"
       -> uninstall -> observe -> reinstall 1.0.0.0 -> probe "reinstall" -> uninstall.
    After each step it records where the probe's marker physically is: the real %APPDATA% path, or
    %LOCALAPPDATA%\Packages\<PFN>\LocalCache\Roaming\...
  The probe (game\msix_probe.gd) is started through its app execution alias, so it runs with
  package identity, and appends one JSON line per launch to <Out>\reports.jsonl.

  Output: <Out>\reports.jsonl (probe), <Out>\summary.json (harness), <Out>\*.log.
#>
param(
  [string]$Layouts = (Join-Path $PSScriptRoot '..\build\d'),
  [string]$Out = (Join-Path $PSScriptRoot '..\out\d'),
  [string]$Publisher = 'CN=S05 Test',
  [switch]$KeepCert
)
$ErrorActionPreference = 'Stop'
$Name = 'PolarisKey.S05Msix'
$Project = 's05msix'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$Report = Join-Path $Out 'reports.jsonl'
Remove-Item $Report -ErrorAction SilentlyContinue
$Steps = New-Object System.Collections.ArrayList

function Find-SdkTool([string]$exe) {
  $root = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $hit = Get-ChildItem -Path $root -Recurse -Filter $exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $hit) { throw "$exe not found under ${root}: install the Windows SDK" }
  return $hit.FullName
}

function Read-Text([string]$path) {
  if (Test-Path -LiteralPath $path) { return [IO.File]::ReadAllText($path) }
  return $null
}

function Get-Paths {
  $pkg = Get-AppxPackage -Name $Name
  $pfn = if ($pkg) { $pkg.PackageFamilyName } else { $script:LastPfn }
  if ($pfn) { $script:LastPfn = $pfn }
  $real = Join-Path $env:APPDATA "Godot\app_userdata\$Project"
  $phys = if ($pfn) { Join-Path $env:LOCALAPPDATA "Packages\$pfn\LocalCache\Roaming\Godot\app_userdata\$Project" } else { $null }
  return @{ pkg = $pkg; pfn = $pfn; real = $real; phys = $phys }
}

function Observe([string]$step) {
  $p = Get-Paths
  $o = [ordered]@{
    step              = $step
    installed         = [bool]$p.pkg
    package_full_name = if ($p.pkg) { $p.pkg.PackageFullName } else { $null }
    version           = if ($p.pkg) { $p.pkg.Version.ToString() } else { $null }
    install_location  = if ($p.pkg) { $p.pkg.InstallLocation } else { $null }
    pfn               = $p.pfn
    real_dir          = $p.real
    phys_dir          = $p.phys
    real_marker       = Read-Text (Join-Path $p.real 's05d_marker.txt')
    phys_marker       = if ($p.phys) { Read-Text (Join-Path $p.phys 's05d_marker.txt') } else { $null }
    real_seeded       = Read-Text (Join-Path $p.real 's05d_preexisting.txt')
    phys_seeded       = if ($p.phys) { Read-Text (Join-Path $p.phys 's05d_preexisting.txt') } else { $null }
    phys_dir_exists   = if ($p.phys) { Test-Path -LiteralPath $p.phys } else { $false }
    package_dir_exists = if ($p.pfn) { Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA "Packages\$($p.pfn)") } else { $false }
  }
  [void]$Steps.Add($o)
  Write-Host ("[{0}] installed={1} real_marker={2} phys_marker={3}" -f $step, $o.installed, $o.real_marker, $o.phys_marker)
}

function Invoke-Probe([string]$phase) {
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\s05msix.exe'
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $alias -ArgumentList @('--headless', '--', "--phase=$phase", "--report=$Report") -PassThru -Wait
  [void]$Steps.Add([ordered]@{ step = "probe:$phase"; exit_code = $proc.ExitCode; wall_ms = $sw.ElapsedMilliseconds })
  Observe "after-probe:$phase"
}

function Build-Msix([string]$ver) {
  $layout = Join-Path $Layouts "layout-$ver"
  if (-not (Test-Path (Join-Path $layout 'AppxManifest.xml'))) { throw "$layout missing: run build_d.sh first" }
  $msix = Join-Path $Out "S05Msix_$ver.msix"
  & $script:MakeAppx pack /o /d $layout /p $msix *>> (Join-Path $Out 'makeappx.log')
  if ($LASTEXITCODE -ne 0) { throw "makeappx failed for $ver (see makeappx.log)" }
  & $script:SignTool sign /fd SHA256 /sha1 $script:Cert.Thumbprint /s My $msix *>> (Join-Path $Out 'signtool.log')
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for $ver (see signtool.log)" }
  return $msix
}

function Remove-S05Package {
  $pkg = Get-AppxPackage -Name $Name
  if ($pkg) { Remove-AppxPackage -Package $pkg.PackageFullName }
}

$MakeAppx = Find-SdkTool 'makeappx.exe'
$SignTool = Find-SdkTool 'signtool.exe'
$os = Get-CimInstance Win32_OperatingSystem
$envInfo = [ordered]@{
  os_caption = $os.Caption; os_version = $os.Version; os_build = $os.BuildNumber
  ps_version = $PSVersionTable.PSVersion.ToString(); makeappx = $MakeAppx; signtool = $SignTool
  date = (Get-Date).ToString('s')
}

# 2. Throwaway signing certificate, trusted for this machine only.
$Cert = New-SelfSignedCertificate -Type Custom -Subject $Publisher -KeyUsage DigitalSignature `
  -FriendlyName 'S-05 MSIX probe (throwaway)' -CertStoreLocation 'Cert:\CurrentUser\My' `
  -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
$cer = Join-Path $Out 's05d_public.cer'
Export-Certificate -Cert $Cert -FilePath $cer | Out-Null
Import-Certificate -FilePath $cer -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null

try {
  # 3. Clean slate, then seed the real AppData as a pre-MSIX install would have.
  Remove-S05Package
  $real = (Get-Paths).real
  if (Test-Path $real) { Remove-Item -Recurse -Force $real }
  New-Item -ItemType Directory -Force -Path $real | Out-Null
  [IO.File]::WriteAllText((Join-Path $real 's05d_preexisting.txt'), 'seeded-before-install')
  Observe 'seeded'

  # 4. Packages.
  $v1 = Build-Msix '1.0.0.0'
  $v2 = Build-Msix '1.0.1.0'

  # 5. Install, relaunch, update, uninstall, reinstall.
  Add-AppxPackage -Path $v1
  Observe 'installed-1.0.0.0'
  Invoke-Probe 'install'
  Invoke-Probe 'relaunch'
  Add-AppxPackage -Path $v2
  Observe 'updated-1.0.1.0'
  Invoke-Probe 'update'
  Remove-S05Package
  Observe 'uninstalled'
  Add-AppxPackage -Path $v1
  Invoke-Probe 'reinstall'
  Remove-S05Package
  Observe 'uninstalled-again'
}
finally {
  $probe = @()
  if (Test-Path $Report) { $probe = @(Get-Content $Report | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) }
  [ordered]@{ environment = $envInfo; steps = $Steps; probe = $probe } |
    ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $Out 'summary.json')
  if (-not $KeepCert) {
    Get-ChildItem 'Cert:\LocalMachine\TrustedPeople' | Where-Object { $_.Thumbprint -eq $Cert.Thumbprint } | Remove-Item
    Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($Cert.Thumbprint)"
  }
  Write-Host "summary: $(Join-Path $Out 'summary.json')"
}

# What to read off summary.json for notes/S-05-godot-platform-mechanics.md section 4.4:
#   probe[].user_data_dir / exe / exe_in_windowsapps       -> where user:// points; the path hint
#   probe[].write_beside_exe.ok                            -> install directory writable? (expect false)
#   steps[after-probe:install].phys_marker vs real_marker  -> where new user:// files really land
#   probe[phase=update].marker_before                      -> user:// kept across a package update
#   probe[].seeded_before / steps[].real_seeded            -> a pre-MSIX user:// file read and modified in place
#   steps[uninstalled].phys_dir_exists, probe[phase=reinstall].marker_before -> cleanup on uninstall
