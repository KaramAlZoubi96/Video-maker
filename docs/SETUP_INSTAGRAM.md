# Connect Instagram (one-time, ~15 minutes)

You have 2 Instagram accounts (one per page). Do steps 1 and 3 for **both** accounts; one Meta app is enough.

Uses the official **Instagram API with Instagram Login**. No Facebook Page is needed.
The website uploads the video file directly to Instagram.

## 1. Make the Instagram account Professional
Instagram app → Profile → ☰ → **Account type and tools → Switch to professional account** → choose **Creator** or **Business**.
(Personal accounts can't post through the API.)

## 2. Create a Meta app
1. Go to <https://developers.facebook.com/apps> → **Create app**.
2. Use case: **Manage messaging & content on Instagram** → Next → connect/skip business portfolio → **Create app**.
3. You can leave the app in **Development** mode. Accounts that have a role on the app can post without App Review.

## 3. Add your Instagram account as a tester
1. In the app: **App roles → Roles → Add people → Instagram Tester** → enter the Instagram username.
2. Accept the invite: on instagram.com → **Settings → Apps and websites → Tester invites → Accept**.

## 4. Connect it — choose ONE way

### Views on the website
To show **Instagram views** on the queue page, the Meta app needs the permission
`instagram_business_manage_insights` (likes and comments work without it):
- **Connect button (Way B):** the site asks for it automatically.
- **Pasted token (Way A):** in the Meta app → **Instagram → API setup with Instagram login → Permissions**, make sure
  `instagram_business_manage_insights` is added *before* you click **Generate token**.

### Way A (easiest): paste a token
1. App dashboard → **Instagram → API setup with Instagram login** → section **Generate access tokens** →
   **Add account** → log in → **Generate token** → copy it.
2. On the website: *Settings → Page 1 → Instagram → "Paste an access token instead"* → paste → **Save token**.
3. Back in Meta: **Add account** again → log in with the **second** Instagram account → **Generate token** →
   paste it into *Settings → Page 2 → Instagram*.

The app renews this token automatically every week, so it won't expire (tokens last 60 days).

### Way B: "Connect Instagram" button
1. Same page → **Set up Instagram business login** → **Business login settings** → OAuth redirect URI:
   `https://YOUR-SITE.netlify.app/api/connect/instagram/callback` → Save.
2. Copy the **Instagram app ID** and **Instagram app secret** shown on that page (they are different from the
   Facebook App ID) into Netlify → **Site configuration → Environment variables** as
   `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET`.
3. Netlify → **Deploys → Trigger deploy** → then on the website: *Settings → Page 1 → Instagram → Connect*, and
   the same for Page 2 (log in with the second account; if Instagram logs you in automatically, log out of
   instagram.com first).

## Video rules (checked when you upload)
- MP4 or MOV, vertical or square, 3 seconds to 3 minutes, max 150 MB.
- Best results: export from CapCut / Premiere / your phone as **MP4, H.264, 1080×1920, 30 fps**.
  (The Netlify version can't convert videos, so a file Instagram doesn't like is reported on the queue page.)
- Caption ≤ 2,200 characters and ≤ 30 hashtags.

## Limits
Instagram allows a limited number of API posts per 24 hours (currently 50 for most accounts). The app checks the
limit before each post and waits if it's reached.

## Troubleshooting
| Message | Fix |
|---|---|
| "This is a personal Instagram account" | Do step 1, then connect again. |
| "Instagram login expired or was revoked" | Reconnect (Way A or B). Happens if the password changed or access was removed. |
| "Insufficient developer role" / can't add account | The Instagram account must accept the **Instagram Tester** invite (step 3). |
| "Instagram could not process the video" | The file itself was rejected — try exporting the video again from your editor. |
