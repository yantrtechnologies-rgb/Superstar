@echo off
rem Double-click to rebuild the web app after code changes and restart it.
cd /d "%~dp0.."
set "LOG=.local-rebuild-%RANDOM%.log"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\rebuild-web.ps1 > "%LOG%" 2>&1
type "%LOG%"
echo Done. Details are in %LOG%
timeout /t 15
