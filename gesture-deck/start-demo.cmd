@echo off
setlocal
pushd "%~dp0" || exit /b 1

if exist "dist\index.html" (
  where python.exe >nul 2>nul && goto python
  where py.exe >nul 2>nul && goto py
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22.13+ or 24+ to build the app, or serve an existing dist directory with Python 3.
  goto failed
)
if not exist "node_modules\.bin\vite.cmd" (
  call npm.cmd ci || goto failed
)
if not exist "dist\index.html" (
  call npm.cmd run build || goto failed
)
echo Open http://127.0.0.1:4178/ in Chrome or Edge.
call npm.cmd run preview
if errorlevel 1 goto failed
goto done

:python
echo Open http://127.0.0.1:4178/ in Chrome or Edge.
python -m http.server 4178 --bind 127.0.0.1 --directory dist
if errorlevel 1 goto failed
goto done

:py
echo Open http://127.0.0.1:4178/ in Chrome or Edge.
py -3 -m http.server 4178 --bind 127.0.0.1 --directory dist
if errorlevel 1 goto failed

:done
popd
exit /b 0

:failed
echo Startup failed. Check the messages above.
popd
pause
exit /b 1
