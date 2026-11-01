#!/usr/bin/env bash
# Deploy Shorts HQ to Netlify (macOS: double-click this file; Linux: ./deploy.command)
cd "$(dirname "$0")" || exit 1
echo
echo "==============================================="
echo "   Deploy Shorts HQ to Netlify"
echo "==============================================="
pause() { read -r -p "Press Enter to close..." _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org then run this again."
  pause; exit 1
fi

echo "[1/4] Getting everything ready (first time takes a few minutes)..."
npm install --no-audit --no-fund --loglevel=error || { echo "X Something went wrong. Website unchanged."; pause; exit 1; }

echo; echo "[2/4] Checking the website for mistakes..."
if ! npm test --silent; then
  echo; echo " X  The check found a problem, so NOTHING was deployed. Your live website is unchanged."
  echo "    Send a screenshot of this window to Claude."
  pause; exit 1
fi

echo; echo "[3/4] Logging in to Netlify (a browser opens the first time)..."
if npx --yes netlify-cli@27.16.1 status 2>&1 | grep -q "Not logged in"; then
  npx --yes netlify-cli@27.16.1 login
fi
if [ ! -f .netlify/state.json ]; then
  echo; echo " First time only: pick YOUR website from the list."
  npx --yes netlify-cli@27.16.1 link
fi

echo; echo "[4/4] Sending the new version to Netlify..."
if npx --yes netlify-cli@27.16.1 deploy --prod --message "Deploy from PC"; then
  echo; echo "==============================================="
  echo "   DONE! Your website is updated."
  echo "==============================================="
else
  echo; echo " X  Something went wrong. Your live website is unchanged. Send a screenshot to Claude."
fi
pause
