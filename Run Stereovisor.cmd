@echo off
setlocal
cd /d "%~dp0"

if /i "%STEREOVISOR_SHOW_CONSOLE%"=="1" goto run_visible
if /i "%STEREOVISOR_SHOW_CONSOLE%"=="true" goto run_visible
if /i "%STEREOVISOR_SHOW_CONSOLE%"=="yes" goto run_visible
if defined STEREOVISOR_SHOW_CONSOLE goto console_checked
for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0client\scripts\read-console-setting.ps1"`) do set "STEREOVISOR_SHOW_CONSOLE=%%C"

:console_checked
if /i "%STEREOVISOR_SHOW_CONSOLE%"=="1" goto run_visible

start "" /b powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\run-ai.ps1"
exit /b 0

:run_visible
title Stereovisor
echo Preparing Stereovisor and starting the local AI editor...
echo First launch may take several minutes. Keep this window open.
echo The service console will remain open after the editor closes.
echo Close the service console when you want to stop the local server.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-ai.ps1"
set "STEREOVISOR_EXIT_CODE=%ERRORLEVEL%"

if not "%STEREOVISOR_EXIT_CODE%"=="0" (
    echo.
    echo Stereovisor stopped with exit code %STEREOVISOR_EXIT_CODE%.
    pause
)

exit /b %STEREOVISOR_EXIT_CODE%
