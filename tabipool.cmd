@echo off
setlocal enabledelayedexpansion

if defined TABIPOOL_HOME (
  set "TABIPOOL_DIR=%TABIPOOL_HOME%"
) else (
  set "TABIPOOL_DIR=%~dp0"
)
rem Strip trailing backslash if present
if "%TABIPOOL_DIR:~-1%"=="\" set "TABIPOOL_DIR=%TABIPOOL_DIR:~0,-1%"

if "%~1"=="" goto help
if /i "%~1"=="help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="--help" goto help
if /i "%~1"=="web" goto web
if /i "%~1"=="register" goto register
if /i "%~1"=="update" goto update
if /i "%~1"=="start" goto start
if /i "%~1"=="stop" goto stop
if /i "%~1"=="restart" goto restart
if /i "%~1"=="status" goto status
if /i "%~1"=="uninstall" goto uninstall

echo Unknown command: %~1
echo.
goto help

:web
curl -s -f http://127.0.0.1:8787/_health >nul 2>&1
if %errorlevel% neq 0 (
  echo Service not answering on http://127.0.0.1:8787/_health. Starting service...
  net session >nul 2>&1
  if %errorlevel% neq 0 (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process nssm -ArgumentList 'start tabipool' -Verb RunAs -Wait"
  ) else (
    nssm start tabipool
  )
  timeout /t 2 /nobreak >nul
)
start http://127.0.0.1:8787/
exit /b 0

:update
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process cmd -ArgumentList '/c \"\"%~f0\" update\"' -Verb RunAs -Wait"
  exit /b 0
)
cd /d "%TABIPOOL_DIR%"
for /f %%h in ('git rev-parse HEAD:bun.lock 2^>nul') do set OLDLOCK=%%h
git fetch origin
git reset --hard origin/main
for /f %%h in ('git rev-parse HEAD:bun.lock 2^>nul') do set NEWLOCK=%%h
if not "%OLDLOCK%"=="%NEWLOCK%" call bun install
nssm restart tabipool
echo.
echo Updated. Health:
timeout /t 2 /nobreak >nul
curl -s http://127.0.0.1:8787/_health
echo.
exit /b 0

:start
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process nssm -ArgumentList 'start tabipool' -Verb RunAs -Wait"
  exit /b 0
)
nssm start tabipool
exit /b 0

:stop
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process nssm -ArgumentList 'stop tabipool' -Verb RunAs -Wait"
  exit /b 0
)
nssm stop tabipool
exit /b 0

:restart
net session >nul 2>&1
if %errorlevel% neq 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process nssm -ArgumentList 'restart tabipool' -Verb RunAs -Wait"
  exit /b 0
)
nssm restart tabipool
exit /b 0

:status
curl -s -f http://127.0.0.1:8787/_health >nul 2>&1
if %errorlevel% neq 0 (
  echo Error: tabipool is not answering on http://127.0.0.1:8787/_health
  exit /b 1
)
echo Health:
curl -s http://127.0.0.1:8787/_health
echo.
echo.
echo Stats summary:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$raw = curl.exe -s http://127.0.0.1:8787/_stats; if ($raw) { $s = $raw | ConvertFrom-Json; Write-Host ('  Uptime:    ' + [math]::Round($s.uptimeMs/60000) + ' min'); Write-Host ('  Pool:      ' + $s.pool.live + '/' + $s.pool.total + ' live keys ($' + $s.money.remainingUsd + ' remaining across pool)'); Write-Host ('  Traffic:   ' + $s.traffic.requests + ' reqs, ' + $s.traffic.successPct + '%% success (p50: ' + $s.traffic.p50Ms + 'ms, p95: ' + $s.traffic.p95Ms + 'ms)'); foreach ($p in $s.pool.providers) { Write-Host ('  Provider:  ' + $p.name + ' -> ' + $p.upstream + ' (' + $p.models + ' models, ' + $p.keys + ' keys, $' + $p.remainingUsd + ' left)') } }"
exit /b 0

:register
powershell -NoProfile -ExecutionPolicy Bypass -File "%TABIPOOL_DIR%\register-agents.ps1"
exit /b %errorlevel%

:uninstall
if /i "%~2"=="--purge" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%TABIPOOL_DIR%\uninstall.ps1" -Purge
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%TABIPOOL_DIR%\uninstall.ps1"
)
exit /b 0

:help
echo tabipool - key-rotating LLM proxy pool
echo.
echo Usage:
echo   tabipool web                 Open dashboard in default browser (starts service if stopped)
echo   tabipool register            Auto-add proxy to detected agents (opencode, Prime, Continue)
echo   tabipool status              Print /_health and /_stats summary
echo   tabipool start               Start background service (admin)
echo   tabipool stop                Stop background service (admin)
echo   tabipool restart             Restart background service (admin)
echo   tabipool update              Pull latest changes, update deps, restart (admin)
echo   tabipool uninstall [--purge] Uninstall service, PATH, env var (--purge deletes repo)
echo   tabipool help                Show this help message
exit /b 0
