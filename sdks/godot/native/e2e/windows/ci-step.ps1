<#
.SYNOPSIS
  One stage of run.ps1 for the CI job, with run.ps1's heartbeat echoed to the step's live log.

.DESCRIPTION
  The step runs run.ps1 as a child and prints heartbeat.log every 30 s, so a runner that is lost
  leaves its last phase, free memory and free disk in the live log. native-desktop.yml runs one
  stage per step and uploads the logs after each, so what a lost runner never reaches is named by
  the first stage whose logs are missing.
#>
param(
  [Parameter(Mandatory)] [string]$Stage,
  [int]$DeadlineMinutes = 10
)
$d = Join-Path $HOME ".cache/pkey-godot/native-$env:GODOT_VERSION"
$work = Join-Path $env:RUNNER_TEMP "e2e-windows"
$runArgs = @("-NoProfile", "-File", (Join-Path $PSScriptRoot "run.ps1"),
  "-Godot", (Join-Path $d "Godot_v$($env:GODOT_VERSION)-stable_win64_console.exe"),
  "-Template", (Join-Path $d "windows_release_x86_64.exe"), "-Work", $work,
  "-Stage", $Stage, "-DeadlineMinutes", $DeadlineMinutes)
$p = Start-Process pwsh -ArgumentList $runArgs -PassThru -NoNewWindow
$null = $p.Handle
$seen = 0
while (-not $p.WaitForExit(30000)) {
  $hb = Join-Path $work "logs/heartbeat.log"
  if (Test-Path $hb) {
    $lines = @(Get-Content $hb)
    if ($lines.Count -gt $seen) { $lines[$seen..($lines.Count - 1)] | ForEach-Object { Write-Host "[heartbeat] $_" }; $seen = $lines.Count }
  }
}
exit $p.ExitCode
