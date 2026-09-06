@echo off
net session >nul 2>&1
if %errorlevel% neq 0 ( powershell -Command "Start-Process '%~f0' -Verb RunAs" & exit /b )
cd /d "%~dp0"
for /f %%h in ('git rev-parse HEAD:bun.lock 2^>nul') do set OLDLOCK=%%h
git pull
for /f %%h in ('git rev-parse HEAD:bun.lock 2^>nul') do set NEWLOCK=%%h
if not "%OLDLOCK%"=="%NEWLOCK%" call bun install
sc query tabipool >nul 2>&1
if %errorlevel%==0 ( nssm restart tabipool ) else ( schtasks /End /TN tabipool & schtasks /Run /TN tabipool )
echo Updated. Health:
curl -s http://127.0.0.1:8787/_health
