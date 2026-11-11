@echo off
setlocal
node "%~dp0pi-usage.js" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
