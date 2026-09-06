@echo off
rem Double-click this to install the pool proxy as a headless Windows service.
rem It self-elevates: service creation requires admin, nothing else here does.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Installing tabipool as a Windows service...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-service.ps1"
echo.
pause
