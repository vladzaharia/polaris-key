# S-06 Windows outlet probe (NOT RUN in S-06: no Windows machine was available; see notes/S-06).
# Prints one JSON line prefixed OUTLET_WIN_JSON with the package-identity signals notes/E9 §1.1
# names, for the process that runs it. Package identity is per process, so run it:
#   1. from a plain console (expected: no identity), then
#   2. as a child of the packaged app: from the Godot probe inside the MSIX, Store, App Installer
#      and sparse ("packaged with external location") installs, e.g.
#      OS.execute("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], out)
#      which also answers whether a child process inherits the parent's package identity.
# Windows PowerShell 5.1 (powershell.exe) is required for the WinRT type accelerators below.
$ErrorActionPreference = 'Stop'
$r = [ordered]@{}
$r.os = [Environment]::OSVersion.VersionString
$r.exe = (Get-Process -Id $PID).Path
$r.parentExe = try { (Get-CimInstance Win32_Process -Filter "ProcessId=$((Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)").ExecutablePath } catch { $null }

Add-Type -Namespace PK -Name AppModel -MemberDefinition @'
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
public static extern int GetCurrentPackageFullName(ref uint length, System.Text.StringBuilder name);
'@
$len = [uint32]0
$rc = [PK.AppModel]::GetCurrentPackageFullName([ref]$len, $null)
# 122 = ERROR_INSUFFICIENT_BUFFER (has identity), 15700 = APPMODEL_ERROR_NO_PACKAGE
$r.getCurrentPackageFullName_rc = $rc
if ($rc -eq 122) {
	$sb = New-Object System.Text.StringBuilder ([int]$len)
	[void][PK.AppModel]::GetCurrentPackageFullName([ref]$len, $sb)
	$r.packageFullName = $sb.ToString()
	[void][Windows.ApplicationModel.Package, Windows.ApplicationModel, ContentType = WindowsRuntime]
	$p = [Windows.ApplicationModel.Package]::Current
	$r.signatureKind = "$($p.SignatureKind)"
	$r.isDevelopmentMode = $p.IsDevelopmentMode
	$r.isStub = try { $p.IsStub } catch { 'n/a' }
	$r.installedPath = try { $p.InstalledPath } catch { $p.InstalledLocation.Path }
	$r.effectiveExternalPath = try { $p.EffectiveExternalPath } catch { 'n/a (< 10.0.19041)' }
	$r.effectivePath = try { $p.EffectivePath } catch { 'n/a' }
	$r.appInstallerUri = try { $info = $p.GetAppInstallerInfo(); if ($info) { "$($info.Uri)" } else { $null } } catch { "error: $($_.Exception.Message)" }
	$r.publisherDisplayName = $p.PublisherDisplayName
}
$lower = $r.exe.ToLowerInvariant().Replace('\', '/')
$r.paths = [ordered]@{
	windowsApps  = $lower.Contains('/windowsapps/')
	wingetLinks  = $lower.Contains('/microsoft/winget/links/')
	wingetPkgs   = $lower.Contains('/microsoft/winget/packages/')
	scoopApps    = $lower.Contains('/scoop/apps/')
	chocoLib     = $lower.Contains('/chocolatey/lib/')
	programFiles = $lower.Contains('/program files')
}
$r.env = [ordered]@{}
foreach ($k in 'SteamAppId', 'SteamGameId', 'SteamClientLaunch', 'SteamEnv', 'ITCHIO_APP', 'SCOOP', 'ChocolateyInstall') {
	$v = [Environment]::GetEnvironmentVariable($k)
	if ($null -ne $v) { $r.env[$k] = $v }
}
"OUTLET_WIN_JSON " + ($r | ConvertTo-Json -Compress -Depth 4)
