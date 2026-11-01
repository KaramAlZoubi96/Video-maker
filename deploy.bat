@echo off
title Deploy Shorts HQ
cd /d "%~dp0"
echo.
echo ===============================================
echo    Deploy Shorts HQ to Netlify
echo ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Installing it now...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  echo.
  echo Done. Please CLOSE this window and double-click deploy.bat again.
  pause
  exit /b 1
)

echo [1/4] Getting everything ready (first time takes a few minutes)...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto fail

echo.
echo [2/4] Checking the website for mistakes...
call npm test --silent
if errorlevel 1 (
  echo.
  echo  X  The check found a problem, so NOTHING was deployed.
  echo     Your live website is unchanged. Send a screenshot of this window to Claude.
  pause
  exit /b 1
)

echo.
echo [3/4] Logging in to Netlify (a browser opens the first time)...
call npx --yes netlify-cli@27.16.1 status 2>&1 | findstr /C:"Not logged in" >nul
if not errorlevel 1 call npx --yes netlify-cli@27.16.1 login
if not exist ".netlify\state.json" (
  echo.
  echo  First time only: choose "Use current git remote origin" or "Choose from a list",
  echo  then pick YOUR website from the list.
  call npx --yes netlify-cli@27.16.1 link
)

echo.
echo [4/4] Sending the new version to Netlify...
call npx --yes netlify-cli@27.16.1 deploy --prod --message "Deploy from PC"
if errorlevel 1 goto fail

echo.
echo ===============================================
echo    DONE! Your website is updated.
echo ===============================================
pause
exit /b 0

:fail
echo.
echo  X  Something went wrong. Your live website is unchanged.
echo     Send a screenshot of this window to Claude.
pause
exit /b 1
