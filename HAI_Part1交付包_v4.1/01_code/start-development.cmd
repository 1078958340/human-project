@echo off
cd /d "%~dp0"
echo Development 4.1: http://localhost:8766/development-v41/index.html
echo Keep this window open. Use Chrome or Edge, then load the v4.1-development profile.
python -m http.server 8766 --bind 127.0.0.1
pause
