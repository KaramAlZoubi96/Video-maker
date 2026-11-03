# Shorts Autoposter (Netlify)

A private website for you and your friend: upload a vertical video, and it posts itself to
**YouTube Shorts** and **Instagram Reels** at the times you choose. Runs on Netlify, so your computer can be off.

- 🎬 **Reddit story video maker**: find top stories (rated ⭐), free AI voice, Reddit card + word-by-word captions,
  random clip from your long background video, auto Part 1/2 for long stories → [docs/MAKE_VIDEOS.md](docs/MAKE_VIDEOS.md)
- 📺 **2 pages** (Reddit Stories + Dreamcore): each page has its own YouTube channel, Instagram account and posting times
- 📖 Reddit Stories page asks for the story link, author and permission, and credits the author in the caption
- #️⃣ Saved hashtags per page, added to every video automatically
- 📈 Views & likes for every video, totals per page, and which posting time gets the most views
- 👥 Each person has their own login (you add your friend in Settings)
- 📤 Upload from phone or PC; video checked in the browser before uploading (vertical? length? size?)
- 🗓 Queue with daily posting times, reorder, edit, "Post now"
- 🔁 Uploads continue where they stopped; never posts the same video twice; temporary errors retried
- 🔑 Logins renew themselves; disconnected account → red banner and videos wait instead of failing
- 📊 Waits for YouTube's daily quota and Instagram's post limit instead of failing

## Get it online
1. [docs/DEPLOY_NETLIFY.md](docs/DEPLOY_NETLIFY.md) — create the Netlify site (free `*.netlify.app` address)
2. [docs/SETUP_YOUTUBE.md](docs/SETUP_YOUTUBE.md) — connect YouTube
3. [docs/SETUP_INSTAGRAM.md](docs/SETUP_INSTAGRAM.md) — connect Instagram

## Updates
The site deploys automatically from GitHub: every change pushed to `main` is checked (`npm test`) and,
if the checks pass, published by Netlify within about a minute. If the checks fail, the live site stays as it was.

Backup option without GitHub: double-click **`deploy.bat`** (Windows) or **`deploy.command`** (Mac).

## Daily use
1. **Upload** → choose the page, the video (MP4/MOV, vertical, 3 s–3 min, up to 150 MB), title, caption with hashtags.
2. It joins that page's **Queue** (tabs at the top switch between the 2 pages). Reorder with ↑ ↓, edit text, or **Post now**.
3. At each of that page's posting times, its top video goes out. Badges turn green with links to the live posts.
4. If something fails, the reason is shown with a **Retry** button.

## Project layout
```
public/                    the web pages (queue, upload, settings, login)
netlify/functions/api.mts  website API (/api/*)
netlify/functions/scheduler.mts   runs every minute: posting times + uploads
netlify/lib/               the logic: queue, YouTube, Instagram, logins, storage
tests/                     automated tests (npm test)
scripts/local-server.mts   run the site on your computer for testing
```

## For developers
```bash
npm install
npm test            # 77 tests
npm run typecheck
# Try it locally with fake YouTube/Instagram (no accounts needed), then open http://localhost:8888
MOCK_PLATFORMS=1 GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x node --experimental-strip-types scripts/local-server.mts
```

## Changing the design later
All colors are in one block at the top of `public/style.css` (the "THEME" section). Ask for another
design (e.g. "Clean" or "Playful") and only that part plus a few layout rules need to change.
