# Put the website online with Netlify (~10 minutes)

You get a free address like `https://our-shorts.netlify.app` that you and your friend open from any phone or computer. Your own computer can be off.

## 1. Code on GitHub
The project needs to be in a GitHub repository (I can push it for you, or upload the folder at
<https://github.com/new> → "uploading an existing file").

## 2. Create the site
1. Sign up / log in at <https://app.netlify.com> (use "Sign up with GitHub").
2. **Add new project → Import an existing project → GitHub** → allow access → pick the repository.
3. The build settings fill in automatically from `netlify.toml` (publish directory `public`, functions in `netlify/functions`). Click **Deploy**.
4. **Project configuration → Change project name** → e.g. `our-shorts` → your address is now `https://our-shorts.netlify.app`.

## 3. Environment variables
Netlify → **Project configuration → Environment variables → Add a variable**:

| Name | Value | Needed? |
|---|---|---|
| `SECRET_KEY` | any long random text (e.g. 40+ random letters) | Recommended (otherwise one is created automatically) |
| `GOOGLE_CLIENT_ID` | from Google Cloud ([SETUP_YOUTUBE.md](SETUP_YOUTUBE.md)) | For YouTube |
| `GOOGLE_CLIENT_SECRET` | from Google Cloud | For YouTube |
| `INSTAGRAM_APP_ID` | from Meta ([SETUP_INSTAGRAM.md](SETUP_INSTAGRAM.md)) | Only for the "Connect Instagram" button |
| `INSTAGRAM_APP_SECRET` | from Meta | Only for the "Connect Instagram" button |
| `YOUTUBE_DAILY_UPLOAD_LIMIT` | `6` | Optional |

Then **Deploys → Trigger deploy → Deploy project** so they take effect.

> Using your own domain later? Add it in Netlify → Domain management, set `SITE_URL=https://yourdomain.com`,
> and update the redirect URIs in Google and Meta.

## 4. First visit
1. Open your address. The first person to visit creates the first account — **do this right away**.
2. **Settings → Add a user** → create your friend's login. Send them the link + password.
3. **Settings → Connect YouTube** and **Instagram**.
4. **Settings → Posting schedule** → pick your timezone and times → Save.

## How it runs on Netlify
- **Uploads**: your browser sends the video in 4 MB pieces (Netlify accepts at most ~6 MB per request). If Wi-Fi drops, pieces are retried.
- **Storage**: videos and data are kept in **Netlify Blobs** (part of your Netlify project). Video files are deleted automatically 7 days after they're posted everywhere.
- **Posting**: a scheduled function runs **every minute**. It posts at your time slots and moves uploads forward a little each run (YouTube uploads in pieces; Instagram processing is checked each minute). A 50 MB video usually finishes within 1–3 minutes.
- **Logs**: Netlify → **Logs → Functions → scheduler** shows each run.

## Costs / limits
Netlify's free plan includes a monthly allowance for function runs, function time and Blobs storage.
This site runs a short check every minute plus the uploads. For two people posting a few videos a day it should
stay small, but **check Netlify → Usage after the first week**. (I couldn't look up Netlify's current limits from
my workspace, so please verify them.) If you get close to a limit, change `"* * * * *"` to `"*/5 * * * *"`
in `netlify/functions/scheduler.mts` (runs every 5 minutes; uploads just take a bit longer).

## Troubleshooting
| Problem | Fix |
|---|---|
| "Add GOOGLE_CLIENT_ID…" in Settings | Add the variables (step 3) and **trigger a new deploy**. |
| `redirect_uri_mismatch` from Google | The URI in Google Cloud must be exactly what Settings shows (`https://…netlify.app/api/connect/youtube/callback`). |
| A video stays "waiting" | Check the banner on the queue page (account disconnected?) and the note on the video (daily limit?). |
| Instagram "could not process the video" | Re-export as MP4 / H.264 / 1080×1920 / 30 fps and upload again. |
| Instagram keeps retrying a big file | Files near 150 MB may be too big to send to Instagram within Netlify's time limit; export a smaller file (shorter or 1080p). |
