@echo off
rem Windows entry point. Double-click to start; or run "mdp <command>" (see README.md).
rem Runs the PowerShell launcher with a one-off execution-policy bypass so students
rem don't have to change any system setting.
if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mdp.ps1" start
    if errorlevel 1 (
        echo.
        pause
    ) else (
        rem Success: the browser is open. Linger a few seconds so first-time messages
        rem can be read, then close (the Desktop shortcut runs this minimized).
        "%SystemRoot%\System32\ping.exe" -n 6 127.0.0.1 >nul
    )
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mdp.ps1" %*
)
