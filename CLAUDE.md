# Shorts HQ — notes for Claude

Private website for two creators (owner: KaramAlZoubi96 + a friend). They upload vertical videos; the site
posts them to YouTube Shorts and Instagram Reels at set times. The owner is not technical and prefers short,
simple English. Do the work end to end and report plainly what changed.

## How updates go live
- Hosting: **Netlify**, deployed from this GitHub repo, branch `main`.
- Netlify runs `npm test` before every deploy (see `netlify.toml`). If tests fail, the live site stays as it was.
- So: make the change → `npm test` passes → commit → push to `main`. No zips, no manual uploads.
- **Deploy only when the owner says "update"** (a Netlify deploy, or a push to `main` once Netlify is linked to
  GitHub): each deploy uses Netlify free-plan credits. Until then, commit changes and keep them ready.
- `deploy.bat` / `deploy.command` are a backup for deploying from the owner's PC with the Netlify CLI.

## The product
- 2 pages: `p1` "Reddit Stories" and `p2` "Dreamcore". Each page has its own YouTube channel, Instagram
  account, daily posting times, saved hashtags. Reddit Stories requires story link + author + permission
  (credit is added to captions).
- Queue per page; at each slot the top video is released; "Post now" releases immediately.
- Views/likes refreshed every 3 h for 30 days; videos finished >35 days ago are archived and their numbers
  kept in `pagestats/{page}`.
- Approval: with 2+ users and `settings.requireApproval` (default on), finished uploads get `approval: "pending"`;
  slots/fixed times skip videos until `approved` (`canPost()` in queue.mts). "changes" = sent back with a note;
  editing the text puts it back to pending. Videos can be watched via `/api/videos/:id/file` (Range, ≤ one 4 MiB piece per response).
- Fixed times: `video.scheduledAt` (set from Queue 🗓 or the Calendar); `releaseScheduled()` runs each minute; fixed
  videos don't use daily slots. Calendar prediction lives in `netlify/lib/calendar.mts`.
- Batch: Stories board ticks → `maker.html?batch=id,id` → each story is rendered and uploaded straight to the queue
  (stories on credit pages are skipped unless the author said yes).
- Stories board (`stories/{id}` in Blobs) + browser **Video Maker**: stories are found by a bookmarklet that runs on
  reddit.com (Reddit blocks unauthenticated API access since 2026; logged-in same-origin fetch still works), rated in
  the browser, saved to the board. Videos are made **in the browser**: Kokoro TTS (`public/vendor/kokoro.web.js`,
  model from Hugging Face, ~90 MB cached), canvas drawing, WebCodecs H.264 + AAC (Opus fallback), `mp4-muxer`.
  Background clips come from a local file (File System Access handle in IndexedDB); used minutes are stored in
  `bgused/{key}` so clips don't repeat.

## Code map
- `netlify/functions/api.mts` → `netlify/lib/api.mts` (all `/api/*` routes)
- `netlify/functions/scheduler.mts` (cron every minute, ~22 s budget, hard limit 30 s) → `netlify/lib/queue.mts`
- `netlify/lib/youtube.mts` (resumable upload, a few 4 MiB pieces per run), `instagram.mts` (container →
  rupload → poll → publish; checks `PUBLISHED` before publishing again), `tokens.mts` (OAuth + refresh per page),
  `stats.mts`, `auth.mts` (bcrypt + HMAC cookie, origin check), `store.mts` (Netlify Blobs, ETag-safe `update()`),
  `time.mts` (slots in the user's timezone), `types.mts` (data model + limits).
- Story/video maker: `public/stories.html` (finder bookmarklet + board), `public/maker.html`, `public/js/storylib.js`
  (rating, text cleanup, parts, caption timing, clip choice — unit tested), `tts.js`, `render.js`, `bglib.js`;
  server side `netlify/lib/stories.mts`.
- Frontend: plain HTML/JS in `public/`; shared helpers + layout in `public/app.js`; all colors in the THEME block
  at the top of `public/style.css` (current design: "Dark"; the owner may ask to switch to "Clean" or "Playful").

## Rules that prevent the mistakes this project exists to avoid
- Never post twice: every platform post has its own state; save resume info before each risky step.
- Never leave a post stuck in `uploading`; temporary errors retry (5/20/60/180 min), limits defer, rejections fail
  with a readable reason.
- Respect Netlify limits: request body ≤ ~6 MB (uploads are chunked), function time ≤ 30 s (work in steps).
- Data written by both the website and the scheduler must go through `update()` / `updateVideo()` (ETag checks).
- Keep secrets out of the repo (they live in Netlify environment variables). This repo is public.

## Testing
- `npm test` (vitest, in-memory store, mocked APIs) and `npm run typecheck`.
- Browser testing without real accounts:
  `MOCK_PLATFORMS=1 GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x node --experimental-strip-types scripts/local-server.mts`
  then open http://localhost:8888 (fake YouTube/Instagram answer every call).
