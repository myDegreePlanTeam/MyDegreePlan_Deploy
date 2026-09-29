@echo off
rem Windows entry point. Double-click to start; or run "mdp <command>" (see README.md).
rem Runs the PowerShell launcher with a one-off execution-policy bypass so students
rem don't have to change any system setting.
if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mdp.ps1" start
    echo.
    pause
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mdp.ps1" %*
)
