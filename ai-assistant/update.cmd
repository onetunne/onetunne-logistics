@echo off
rem Update: pull the latest package (if this folder is a git clone) and re-apply the config.
chcp 65001 >nul
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
cd /d "%~dp0"
git -C "%~dp0" pull --ff-only 2>nul
assistant-setup deploy
assistant-setup doctor
echo.
pause
