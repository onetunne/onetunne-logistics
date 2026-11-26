@echo off
rem Backup of the global Claude config WITHOUT passwords, tokens or API keys.
chcp 65001 >nul
set "PATH=%USERPROFILE%\.local\bin;%PATH%"
assistant-setup backup %*
echo.
pause
