# tabipool one-line installer
# Usage: irm https://raw.githubusercontent.com/windro-exe/tabipool/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "         tabipool installer" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Check prerequisites: git, bun, nssm
Write-Host "Checking prerequisites..."

# git
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) {
  Write-Host "ERROR: git is required but not found." -ForegroundColor Red
  Write-Host "Please install Git from https://git-scm.com or run 'winget install Git.Git' and re-run this script."
  exit 1
}

# bun
$bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
if (-not $bun) {
  $bunCandidates = @(
    "$env:USERPROFILE\.bun\bin\bun.exe",
    "$env:APPDATA\npm\node_modules\bun\bin\bun.exe"
  )
  $bun = $bunCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}

if (-not $bun) {
  Write-Host "bun not found. Installing bun..." -ForegroundColor Yellow
  try {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
  } catch {
    Write-Host "Failed to install bun via bun.sh: $_" -ForegroundColor Red
  }
  # Refresh PATH for current session to include bun
  if (Test-Path "$env:USERPROFILE\.bun\bin\bun.exe") {
    $bun = "$env:USERPROFILE\.bun\bin\bun.exe"
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
  } else {
    $bun = (Get-Command bun.exe -ErrorAction SilentlyContinue).Source
  }
  if (-not $bun) {
    Write-Host "ERROR: bun installation could not be completed. Install bun from https://bun.sh and re-run." -ForegroundColor Red
    exit 1
  }
}
Write-Host "  bun: $bun" -ForegroundColor Green

# nssm
$nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source
if (-not $nssm) {
  $nssm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
}

if (-not $nssm) {
  Write-Host "nssm not found. Installing NSSM via winget..." -ForegroundColor Yellow
  $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
  if (-not $winget) {
    Write-Host "ERROR: nssm is required to run the background service, but winget is unavailable to install it automatically." -ForegroundColor Red
    Write-Host "Please install winget (App Installer) or download NSSM from https://nssm.cc and put nssm.exe on your PATH." -ForegroundColor Red
    exit 1
  }
  & winget install NSSM.NSSM --accept-source-agreements --accept-package-agreements
  # Refresh PATH and search again
  $env:PATH = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $nssm = (Get-Command nssm.exe -ErrorAction SilentlyContinue).Source
  if (-not $nssm) {
    $nssm = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'win64' } | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $nssm) {
    Write-Host "WARNING: nssm was installed via winget, but nssm.exe was not yet found on PATH in this session." -ForegroundColor Yellow
  }
}
if ($nssm) {
  Write-Host "  nssm: $nssm" -ForegroundColor Green
}

# 2 & 3. Choose install dir and clone or pull
$installDir = "$env:USERPROFILE\tabipool"
if (Test-Path "$installDir\.git") {
  Write-Host "Existing installation found at $installDir. Pulling latest..." -ForegroundColor Yellow
  Push-Location $installDir
  try {
    & git pull
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Cloning tabipool into $installDir..." -ForegroundColor Cyan
  & git clone https://github.com/windro-exe/tabipool.git $installDir
}

# 4. bun install
Write-Host "Installing dependencies with bun..." -ForegroundColor Cyan
Push-Location $installDir
try {
  & $bun install
} finally {
  Pop-Location
}

# 5. config.local.ps1 and providers.json
$configFile = Join-Path $installDir "config.local.ps1"
$exampleConfig = Join-Path $installDir "config.local.ps1.example"
if (-not (Test-Path $configFile) -and (Test-Path $exampleConfig)) {
  Copy-Item $exampleConfig $configFile
  Write-Host "Initialized config.local.ps1 from example" -ForegroundColor Green
}

$providersFile = Join-Path $installDir "providers.json"
$exampleProviders = Join-Path $installDir "providers.example.json"
if (-not (Test-Path $providersFile) -and (Test-Path $exampleProviders)) {
  Copy-Item $exampleProviders $providersFile
  Write-Host "Initialized providers.json from example" -ForegroundColor Green
}

# 6. Set TABIPOOL_HOME user env var
[Environment]::SetEnvironmentVariable("TABIPOOL_HOME", $installDir, "User")
$env:TABIPOOL_HOME = $installDir
Write-Host "Set TABIPOOL_HOME = $installDir" -ForegroundColor Green

# 7. Add install dir to user PATH
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$parts = ($userPath -split ";") | Where-Object { $_ }
$norm = $installDir.TrimEnd("\")
$inPath = $parts | Where-Object { $_.TrimEnd("\") -ieq $norm }
if (-not $inPath) {
  $newPath = if ($userPath) { "$userPath;$installDir" } else { $installDir }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:PATH = "$installDir;$env:PATH"
  Write-Host "Added $installDir to user PATH" -ForegroundColor Green
}

# 8. Install + start background service (install-service.ps1 self-elevates)
Write-Host "Installing and starting Windows service (UAC prompt will appear)..." -ForegroundColor Cyan
$installServiceScript = Join-Path $installDir "install-service.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $installServiceScript

# 9. Next steps
Write-Host ""
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  tabipool installation complete!" -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green
Write-Host "  Dashboard:   http://127.0.0.1:8787/" -ForegroundColor Cyan
Write-Host "  CLI:         tabipool" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:"
Write-Host "  tabipool web       - Open dashboard in browser"
Write-Host "  tabipool status    - Check proxy status and health"
Write-Host "  tabipool update    - Pull updates and restart service"
Write-Host "=========================================" -ForegroundColor Green
