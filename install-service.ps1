# Installs the pool proxy as a real Windows SERVICE (headless, starts at boot,
# runs before/without login, no console, no shell, no Scheduled Task).
#
# Uses NSSM to supervise bun.exe. NSSM restarts the process if it exits and owns
# stdout/stderr redirection, so nothing is attached to a terminal session.
#
# MUST run elevated (service creation requires admin). Easiest: double-click
# install-service.cmd, which self-elevates. Or from an admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File install-service.ps1
#
# Manage afterwards:  Get-Service tabipool / Restart-Service tabipool / Stop-Service tabipool
# Remove:             powershell -ExecutionPolicy Bypass -File install-service.ps1 -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = "Stop"

# NSSM writes to stderr for benign conditions ("Can't open service!" when the service
# does not exist yet). Under EAP=Stop, PowerShell promotes native stderr to a
# terminating error, which killed the script on its own idempotent cleanup. This helper
# runs nssm with EAP relaxed and swallows the output; callers check state explicitly.
function Invoke-Nssm {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$NssmArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try { & $script:nssm @NssmArgs 2>&1 | Out-Null } catch { } finally { $ErrorActionPreference = $prev }
  $global:LASTEXITCODE = 0
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Elevating to Administrator to configure the Windows service..."
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$($MyInvocation.MyCommand.Path)`"")
  if ($Uninstall) { $argList += "-Uninstall" }
  $proc = Start-Process powershell.exe -ArgumentList $argList -Verb RunAs -PassThru -Wait
  exit $proc.ExitCode
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$svc = "tabipool"

$nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $nssm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $nssm) { throw "nssm.exe not found. Install with: winget install NSSM.NSSM" }
Write-Host "using nssm: $nssm"

if ($Uninstall) {
  $uninstallScript = Join-Path $dir "uninstall.ps1"
  if (Test-Path $uninstallScript) {
    & $uninstallScript
    exit $LASTEXITCODE
  }
  Invoke-Nssm stop $svc
  Invoke-Nssm remove $svc confirm
  Write-Host "service '$svc' removed"
  exit 0
}

$bun = @(
  "$env:APPDATA\npm\node_modules\bun\bin\bun.exe",
  "$env:USERPROFILE\.bun\bin\bun.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bun) { $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source }
if (-not $bun) { throw "bun.exe not found - install from https://bun.sh" }

# A Scheduled Task from an earlier setup would fight this service for port 8787.
$task = Get-ScheduledTask -TaskName $svc -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $svc -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $svc -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed the old scheduled task (it would have contended for the port)"
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*proxy.ts*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Idempotent: drop any previous install before recreating.
Invoke-Nssm stop $svc
Invoke-Nssm remove $svc confirm
Start-Sleep -Seconds 2

Invoke-Nssm install $svc $bun "run" "$dir\proxy.ts"
Invoke-Nssm set $svc AppDirectory $dir
Invoke-Nssm set $svc DisplayName "Tabipool API Proxy"
Invoke-Nssm set $svc Description "Key-rotating proxy pool for OpenAI-compatible gateways"

# Automatic = starts at boot, before any user logs in. This is the headless part.
Invoke-Nssm set $svc Start SERVICE_AUTO_START

# Config travels with the service, not with a shell or a user profile.
$configFile = Join-Path $dir "config.local.ps1"
if (-not (Test-Path $configFile)) {
  throw "config.local.ps1 not found. Copy config.local.ps1.example to config.local.ps1 before installing."
}
. $configFile
$envBlock = @(
  "PORT=$PORT",
  "UI_PORT=$UI_PORT",
  "HOST=$HOST_ADDR",
  "STATE_FILE=state.json",
  "LOG_FILE=requests.jsonl"
) -join "`r`n"
Invoke-Nssm set $svc AppEnvironmentExtra $envBlock

# NSSM owns the restart policy; throttle stops a crash-loop from spinning the CPU.
Invoke-Nssm set $svc AppExit Default Restart
Invoke-Nssm set $svc AppRestartDelay 5000
Invoke-Nssm set $svc AppThrottle 10000

# A service has no console, so redirect output to a rotating file.
Invoke-Nssm set $svc AppStdout "$dir\service.log"
Invoke-Nssm set $svc AppStderr "$dir\service.log"
Invoke-Nssm set $svc AppRotateFiles 1
Invoke-Nssm set $svc AppRotateBytes 10485760

# Verify registration explicitly rather than trusting nssm's exit code.
$reg = Get-Service $svc -ErrorAction SilentlyContinue
if (-not $reg) { throw "service registration failed - check that nssm ran elevated" }
Write-Host "installed service '$svc'"
Write-Host "  exec:  $bun run proxy.ts"
Write-Host "  start: automatic (at boot, before login)"
Write-Host "  log:   $dir\service.log"
Write-Host ""

Start-Service $svc
for ($i = 0; $i -lt 12; $i++) {
  Start-Sleep -Seconds 2
  try {
    $h = Invoke-RestMethod "http://127.0.0.1:8787/_health" -TimeoutSec 4 -ErrorAction Stop
    Write-Host "service is up. /_health -> ok=$($h.ok)" -ForegroundColor Green
    break
  } catch { }
}
Write-Host "status: $((Get-Service $svc).Status)  starttype: $((Get-Service $svc).StartType)"
Write-Host "dashboard: http://127.0.0.1:8787/"
