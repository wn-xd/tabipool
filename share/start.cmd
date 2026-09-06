@echo off
rem Supervises the pool proxy: relaunches it if it exits.
rem Reads secrets from config.cmd (copy config.cmd.example first).

set DIR=%~dp0
set LOG=%DIR%proxy.log

if not exist "%DIR%config.cmd" (
  echo.
  echo   ERROR: config.cmd not found.
  echo   Copy config.cmd.example to config.cmd and set UPSTREAM.
  echo.
  pause
  exit /b 1
)
call "%DIR%config.cmd"

if not exist "%DIR%%KEYS_FILE%" (
  echo.
  echo   ERROR: %KEYS_FILE% not found.
  echo   Create it with one sk-... API key per line.
  echo.
  pause
  exit /b 1
)

rem Absolute path: `bun` on PATH may resolve to bun.ps1, which cmd.exe cannot execute.
set BUN=%APPDATA%\npm\node_modules\bun\bin\bun.exe
if not exist "%BUN%" set BUN=%USERPROFILE%\.bun\bin\bun.exe
if not exist "%BUN%" (
  echo.
  echo   ERROR: bun.exe not found. Install from https://bun.sh then re-run.
  echo.
  pause
  exit /b 1
)

rem Single-instance guard: two supervisors racing the same port causes
rem intermittent bind failures that look like random outages.
netstat -ano | findstr /r /c:"127.0.0.1:%PORT% .*LISTENING" > nul 2>&1
if not errorlevel 1 (
  echo   port %PORT% already in use - another instance is running. exiting.
  exit /b 0
)

:loop
echo [%date% %time%] starting pool proxy on port %PORT% (ui %UI_PORT%) >> "%LOG%"
"%BUN%" run "%DIR%proxy.ts" >> "%LOG%" 2>&1
echo [%date% %time%] exited with code %errorlevel%, restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak > nul
goto loop
