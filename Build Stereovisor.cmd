@echo off
setlocal
title Build Stereovisor

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo Node.js and npm were not found in PATH.
    echo Install Node.js, then run this builder again.
    if not defined STEREOVISOR_NO_PAUSE pause
    exit /b 1
)

if not exist "node_modules\.package-lock.json" (
    echo Installing project dependencies...
    call npm ci
    if errorlevel 1 (
        echo.
        echo Dependency installation failed.
        if not defined STEREOVISOR_NO_PAUSE pause
        exit /b 1
    )
)

echo Building and packaging Stereovisor...
echo.
call npm run package
set "STEREOVISOR_BUILD_EXIT=%ERRORLEVEL%"

echo.
if not "%STEREOVISOR_BUILD_EXIT%"=="0" (
    echo Build failed with exit code %STEREOVISOR_BUILD_EXIT%.
) else (
    echo Package complete.
    echo Renderer: %~dp0dist
    echo Electron: %~dp0dist-electron
    echo Installer and portable executable: %~dp0release
)

if not defined STEREOVISOR_NO_PAUSE pause
exit /b %STEREOVISOR_BUILD_EXIT%
