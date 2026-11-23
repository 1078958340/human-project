@echo off
setlocal
cd /d "%~dp0"
echo Custom gestures v4: http://localhost:8766/custom-gestures/index.html
echo Legacy v4.1:       http://localhost:8766/development-v41/index.html
echo Keep this window open and use Chrome or Edge.
where python >nul 2>nul
if errorlevel 1 (
  py -3 -m http.server 8766 --bind 127.0.0.1
) else (
  python -m http.server 8766 --bind 127.0.0.1
)
pause
