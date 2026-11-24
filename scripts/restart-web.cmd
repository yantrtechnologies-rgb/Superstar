@echo off
rem Double-click to restart web, API and worker without rebuilding (e.g. after editing .env.local).
cd /d "%~dp0.."
set "LOG=.local-restart-%RANDOM%.log"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-web.ps1 -SkipBuild > "%LOG%" 2>&1
type "%LOG%"
echo Done. Details are in %LOG%
timeout /t 15
