@echo off
rem Universal Claude assistant - installer launcher (double-click).
rem ExecutionPolicy Bypass applies to this one process only; no system setting is changed.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
