param([switch]$Purge)

$ErrorActionPreference = "Continue"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
  Write-Host "Elevating to Administrator to uninstall tabipool service..."
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  if ($Purge) { $argList += "-Purge" }
  $proc = Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -PassThru -Wait
  exit $proc.ExitCode
}

$dir = $env:TABIPOOL_HOME
if (-not $dir -or -not (Test-Path $dir)) {
  $dir = Split-Path -Parent $MyInvocation.MyCommand.Path
}

$svc = "tabipool"

# Locate nssm
$nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $nssm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
}

Write-Host "Stopping and removing service '$svc'..."
if ($nssm) {
  & $nssm stop $svc 2>&1 | Out-Null
  & $nssm remove $svc confirm 2>&1 | Out-Null
} else {
  sc.exe stop $svc 2>&1 | Out-Null
  sc.exe delete $svc 2>&1 | Out-Null
}

# Kill any running bun.exe proxy.ts processes
Write-Host "Stopping any running proxy processes..."
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*proxy.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Remove scheduled task if it exists (legacy installs)
Write-Host "Checking for legacy scheduled task..."
$task = Get-ScheduledTask -TaskName $svc -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $svc -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $svc -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed legacy scheduled task '$svc'"
}

# Remove TABIPOOL_HOME user environment variable
Write-Host "Removing TABIPOOL_HOME environment variable..."
[Environment]::SetEnvironmentVariable("TABIPOOL_HOME", $null, "User")
Remove-Item Env:\TABIPOOL_HOME -ErrorAction SilentlyContinue

# Remove install dir from user PATH
Write-Host "Removing from user PATH..."
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath) {
  $parts = ($userPath -split ";") | Where-Object { $_ -and $_.TrimEnd("\") -ne $dir.TrimEnd("\") }
  $newPath = $parts -join ";"
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}

Write-Host "Service and environment uninstalled successfully." -ForegroundColor Green

if ($Purge) {
  Write-Host "Purging repository and configuration at $dir..." -ForegroundColor Yellow
  Start-Process cmd.exe -ArgumentList "/c timeout /t 2 /nobreak >nul & rd /s /q `"$dir`"" -WindowStyle Hidden
  Write-Host "Purge scheduled. Directory $dir will be deleted." -ForegroundColor Yellow
} else {
  Write-Host "Clone directory and keys preserved at: $dir" -ForegroundColor Cyan
  Write-Host "To remove them, delete the directory manually or run: tabipool uninstall --purge"
}
