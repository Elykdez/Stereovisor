@echo off
setlocal
title Stereovisor Preview

cd /d "%~dp0"
set "STEREOVISOR_MODE=preview"

where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js and npm were not found in PATH.
    echo Install Node.js, then run this launcher again.
    pause
    exit /b 1
)

echo Starting Stereovisor in preview mode...
echo Close the Electron window, then press Ctrl+C here to stop the local services.
echo.

call npm run dev
set "STEREOVISOR_EXIT_CODE=%ERRORLEVEL%"

if not "%STEREOVISOR_EXIT_CODE%"=="0" (
    echo.
    echo Stereovisor stopped with exit code %STEREOVISOR_EXIT_CODE%.
    pause
)

exit /b %STEREOVISOR_EXIT_CODE%
