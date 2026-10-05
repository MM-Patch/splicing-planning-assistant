@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node LTS from https://nodejs.org
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=8787
echo Starting Splicing Planning Assistant on http://127.0.0.1:%PORT%
start "" "http://127.0.0.1:%PORT%"
node server.mjs
pause
