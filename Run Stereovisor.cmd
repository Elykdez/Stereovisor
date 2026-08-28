@echo off
setlocal
title Stereovisor

cd /d "%~dp0"
echo Preparing Stereovisor and starting the local AI editor...
echo First launch may take several minutes. Keep this window open.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-ai.ps1"
set "STEREOVISOR_EXIT_CODE=%ERRORLEVEL%"

if not "%STEREOVISOR_EXIT_CODE%"=="0" (
    echo.
    echo Stereovisor stopped with exit code %STEREOVISOR_EXIT_CODE%.
    pause
)

exit /b %STEREOVISOR_EXIT_CODE%
