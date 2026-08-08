@echo off
setlocal
set "PI_OFFLINE=1"
where.exe pi.cmd >nul 2>&1
if errorlevel 1 (
  echo pi.cmd was not found on PATH.
  exit /b 1
)
call pi.cmd %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
