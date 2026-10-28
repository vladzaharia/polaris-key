<#
.SYNOPSIS
  run.ps1's watchdog, a process of its own with no handle shared with the run.

.DESCRIPTION
  Every 30 s it appends a heartbeat to logs\heartbeat.log (elapsed, phase, free memory, the busiest
  processes), so a run that dies leaves evidence of whether the machine was starving. It trips at
  the whole-run deadline, or when the current phase (logs\phase.txt: name|start-epoch|budget-seconds,
  written by run.ps1) outlives its budget. A trip writes which phase hung, the process tree and the
  tail of progress.log to logs\watchdog.log, stops the strays, and kills run.ps1's tree, so the step
  fails with a message instead of running into the step's or the job's limit.
#>
param(
  [Parameter(Mandatory)] [string]$Work,
  [Parameter(Mandatory)] [int]$ParentPid,
  [int]$DeadlineMinutes = 24,
  [string]$Strays = ""
)
$ErrorActionPreference = "Continue"
$logs = "$Work\logs"
$wd = "$logs\watchdog.log"
$start = Get-Date
function Epoch() { [int64][DateTimeOffset]::UtcNow.ToUnixTimeSeconds() }
function Dump() {
  Add-Content $wd "-- process tree (id, parent, name, working set MB, command line)"
  Get-CimInstance Win32_Process | Sort-Object ProcessId | ForEach-Object {
    Add-Content $wd ("{0} {1} {2} {3:N0}MB {4}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, ($_.WorkingSetSize / 1MB), ($(if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(160, $_.CommandLine.Length)) } else { "" })))
  }
  Add-Content $wd "-- last progress"
  Get-Content "$logs\progress.log" -Tail 8 -ErrorAction SilentlyContinue | Add-Content $wd
  Add-Content $wd "-- last heartbeats"
  Get-Content "$logs\heartbeat.log" -Tail 4 -ErrorAction SilentlyContinue | Add-Content $wd
}
function Trip([string]$why) {
  Add-Content $wd ("watchdog: {0:HH:mm:ss} {1}" -f (Get-Date), $why)
  Dump
  if ($Strays) { Get-Process ($Strays -split ",") -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }
  taskkill /F /T /PID $ParentPid | Out-Null
  exit 1
}
while ($true) {
  Start-Sleep -Seconds 30
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  $elapsed = [int]((Get-Date) - $start).TotalSeconds
  $phase = "-"
  $phaseAge = 0
  $budget = 0
  $raw = Get-Content "$logs\phase.txt" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($raw -and $raw.Split("|").Count -eq 3) {
    $name, $began, $budget = $raw.Split("|")
    $phase = $name
    $phaseAge = [int]((Epoch) - [int64]$began)
    $budget = [int]$budget
  }
  $os = Get-CimInstance Win32_OperatingSystem
  $top = Get-Process | Sort-Object CPU -Descending | Select-Object -First 3 | ForEach-Object { "{0}:{1:N0}s:{2:N0}MB" -f $_.ProcessName, $_.CPU, ($_.WorkingSet64 / 1MB) }
  Add-Content "$logs\heartbeat.log" ("{0:HH:mm:ss} +{1}s phase={2} ({3}s of {4}s) free={5:N0}MB disk={7:N1}GB top={6}" -f (Get-Date), $elapsed, $phase, $phaseAge, $budget, ($os.FreePhysicalMemory / 1KB), ($top -join " "), ((Get-PSDrive C).Free / 1GB))
  if ($elapsed -ge $DeadlineMinutes * 60) { Trip "run.ps1 passed its $DeadlineMinutes minute deadline in phase '$phase'" }
  if ($budget -gt 0 -and $phaseAge -ge $budget) { Trip "phase '$phase' ran $phaseAge s, over its $budget s budget" }
}
