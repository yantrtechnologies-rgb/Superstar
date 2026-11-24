@echo off
rem Double-click to install the Temporal CLI if needed and start the Superstar stack.
cd /d "%~dp0.."
where temporal >nul 2>nul
if errorlevel 1 if not exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\temporal.exe" (
  echo Installing Temporal CLI...
  winget install --id Temporal.TemporalCLI -e --accept-source-agreements --accept-package-agreements --disable-interactivity
)
findstr /b "DATABASE_URL=" .env.local-stack >nul 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -File scripts\grant-local-db-access.ps1 > .local-grant.log 2>&1
type .local-grant.log 2>nul
set "LOG=.local-start-%RANDOM%.log"
set "TUNNEL="
if exist .local-public-url (set /p TUNNEL=<.local-public-url)
if defined TUNNEL (
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-local.ps1 -PublicUrl %TUNNEL% > "%LOG%" 2>&1
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-local.ps1 > "%LOG%" 2>&1
)
type "%LOG%"
echo.
echo Done. Details are in %LOG%
timeout /t 15
