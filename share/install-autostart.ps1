# Registers the pool proxy as a logon Scheduled Task so it survives reboots.
#
# Why a Scheduled Task and not a Startup-folder shortcut: the task is launched via
# wscript with no console attached. A console-attached cmd.exe receives Ctrl-C /
# console-close events from whatever session spawned it and dies with 0xC000013A,
# taking the restart loop down with it.
#
# Run once:  powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Remove:    Unregister-ScheduledTask -TaskName poolproxy -Confirm:$false

$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$dir\config.cmd")) {
  Write-Host "ERROR: config.cmd not found. Copy config.cmd.example first." -ForegroundColor Red
  exit 1
}

# Point the task at start.cmd, which loops internally. Windows' own RestartCount only
# fires when the task is judged failed, and a wrapper that exits 0 after its child dies
# never triggers it -- so the loop must own the respawn, not the scheduler.
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
  -Argument "//nologo `"$dir\tabipool.vbs`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "poolproxy" -Action $action -Trigger $trigger `
  -Settings $settings -Description "API key-rotating pool proxy" -Force | Out-Null

Write-Host "registered scheduled task 'poolproxy' (starts at logon)"
Start-ScheduledTask -TaskName "poolproxy"
Write-Host "started. dashboard: http://127.0.0.1:8787/"
