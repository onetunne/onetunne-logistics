@echo off
rem Restore the Claude config from a backup zip: drag the zip onto this file, or pass its path.
chcp 65001 >nul
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
where assistant-setup >nul 2>nul || (echo Run install.cmd first. & pause & exit /b 1)
set "ZIP=%~1"
if "%ZIP%"=="" set /p "ZIP=Path to claude-config-*.zip: "
assistant-setup restore "%ZIP%"
assistant-setup deploy
echo.
pause
