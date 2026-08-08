@echo off
setlocal
set "PI_OFFLINE="
where.exe pi.cmd >nul 2>&1
if errorlevel 1 (
  echo pi.cmd was not found on PATH.
  exit /b 1
)
if "%~1"=="" (
  call pi.cmd update --extensions
) else (
  call pi.cmd update %*
)
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
