# Connect YouTube (one-time, ~15 minutes)

You need a Google Cloud "OAuth client" so the app can upload to your channel.

## 1. Create a project and turn on the API
1. Go to <https://console.cloud.google.com/> and sign in with the Google account that owns the channel.
2. Top bar → project picker → **New project** → name it `shorts-autoposter` → **Create**. Make sure it's selected.
3. Menu → **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.

## 2. Consent screen (important: set it to "In production")
1. Menu → **Google Auth Platform** (older UI: *APIs & Services → OAuth consent screen*) → **Get started**.
2. App name: `Shorts Autoposter`, support email: yours. Audience: **External**. Contact email: yours. Create.
3. **Data access → Add or remove scopes** → add:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube.readonly`
   → Save.
4. **Audience → Publish app → Confirm** so the status shows **In production**.

> ⚠ If you leave it in **Testing**, Google kills the login every 7 days and uploads stop.
> This is one of the most common reasons auto-posters "randomly break".
> You don't need Google verification for personal use. When you log in you'll see
> "Google hasn't verified this app" → click **Advanced → Go to Shorts Autoposter**.

## 3. Create the OAuth client
1. **Clients → Create client** → type **Web application**.
2. **Authorized redirect URIs → Add URI** → paste the exact address shown in the app under
   *Settings → YouTube → Redirect URI*. For example:
   `https://YOUR-SITE.netlify.app/api/connect/youtube/callback`
3. **Create**. Copy the **Client ID** and **Client secret**.
4. Netlify → your site → **Site configuration → Environment variables → Add a variable**:
   - `GOOGLE_CLIENT_ID` = `xxxx.apps.googleusercontent.com`
   - `GOOGLE_CLIENT_SECRET` = `GOCSPX-xxxx`
5. Netlify → **Deploys → Trigger deploy → Deploy site** (variables apply after a new deploy).

## 4. Connect in the app
Settings → **Connect YouTube** → pick the Google account (and the channel, if it's a brand account) → Allow.
You'll see "✓ Connected: *your channel*".

## 5. Public videos: request the API audit
Google rule: API projects that haven't passed a YouTube compliance audit can only upload **private** videos —
even if the app asks for "public". To lift this, submit the free audit form:
<https://support.google.com/youtube/contact/yt_api_form>
(Describe it as: "Internal tool that uploads our own Shorts to our own channel; 2 users.")

Until it's approved:
- Set *Settings → YouTube visibility* to **Private**, and switch each video to public in YouTube Studio, **or**
- Accept that videos land as private and make them public later.

## Limits
- Default quota is 10,000 units/day; one upload costs about 1,600 → **about 6 uploads per day**.
  The app counts uploads and waits for the daily reset (midnight Pacific time) instead of failing.
- Change the cap with the `YOUTUBE_DAILY_UPLOAD_LIMIT` environment variable in Netlify if Google gives you more quota.

## Troubleshooting
| Message | Fix |
|---|---|
| `redirect_uri_mismatch` | The URI in Google Cloud must match *Settings → Redirect URI* exactly (https, `/api/connect/youtube/callback`, no trailing slash). |
| "Google did not give a refresh token" | Remove the app at <https://myaccount.google.com/permissions> and connect again. |
| Login expires every week | Consent screen is still in **Testing**. Publish it (step 2.4) and reconnect. |
| "This Google account has no YouTube channel" | Create a channel at youtube.com first, or choose the brand account during login. |
