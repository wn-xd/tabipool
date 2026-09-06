# Registers the pool proxy as a Windows Scheduled Task that runs bun.exe DIRECTLY.
#
# Why no wrapper: earlier versions launched .vbs -> cmd.exe -> loop -> bun. Every layer
# is a process that can die on its own, and a console-attached cmd.exe takes a Ctrl-C
# (0xC000013A) from whatever session spawned it, killing the loop with it. Pointing the
# task at bun.exe means Windows supervises the real process and its own RestartCount
# does the respawning -- nothing is tied to a shell.
#
# Run once (no admin needed):
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove:
#   Unregister-ScheduledTask -TaskName tabipool -Confirm:$false

$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Must be the real .exe: cmd/scheduler cannot execute the bun.ps1 shim on PATH.
$bun = @(
  "$env:APPDATA\npm\node_modules\bun\bin\bun.exe",
  "$env:USERPROFILE\.bun\bin\bun.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bun) { $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source }
if (-not $bun) { throw "bun.exe not found - install from https://bun.sh" }

# Settings live in config.local.ps1, not in a wrapper script.
$configFile = Join-Path $dir "config.local.ps1"
if (-not (Test-Path $configFile)) { throw "config.local.ps1 not found. Copy config.local.ps1.example and set PROXY_TOKEN first." }
. $configFile
if (-not $PROXY_TOKEN -or $PROXY_TOKEN -eq "change-me-to-a-long-random-string") { throw "Set a real PROXY_TOKEN in config.local.ps1." }
$envVars = @{
  PORT        = "$PORT"
  UI_PORT     = "$UI_PORT"
  HOST        = "$HOST_ADDR"
  PROXY_TOKEN = "$PROXY_TOKEN"
  STATE_FILE  = "state.json"
  LOG_FILE    = "requests.jsonl"
}

# Scheduled tasks cannot carry env vars directly, so persist them for the user account.
# bun inherits them at launch.
foreach ($kv in $envVars.GetEnumerator()) {
  [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "User")
}
Write-Host "persisted $($envVars.Count) settings as user environment variables"

$action = New-ScheduledTaskAction -Execute $bun `
  -Argument "run `"$dir\proxy.ts`"" -WorkingDirectory $dir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# RestartCount/RestartInterval are the supervision: if bun.exe exits, Windows relaunches
# it. This works because the task's process IS bun -- with a wrapper, the wrapper exiting
# 0 looked like success and no restart ever fired.
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "tabipool" -Action $action -Trigger $trigger `
  -Settings $settings -Description "tabitoken key-rotating pool proxy" -Force | Out-Null

Write-Host "registered task 'tabipool' -> $bun run proxy.ts"
Write-Host "  restarts automatically if the process exits"
Write-Host "  starts at logon, survives reboot"
Write-Host ""
Start-ScheduledTask -TaskName "tabipool"
Write-Host "started. verify: curl http://127.0.0.1:8787/_health"
