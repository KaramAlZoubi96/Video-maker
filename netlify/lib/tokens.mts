/** Connecting YouTube / Instagram and keeping their logins fresh. */
import { getJSON, kv, putJSON, update } from "./store.mts";
import {
  type Account, AuthError, type Platform, TransientError, config,
} from "./types.mts";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const YT_SCOPES = "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly";
const IG_AUTH = "https://www.instagram.com/oauth/authorize";
const IG_SHORT_TOKEN = "https://api.instagram.com/oauth/access_token";
const IG_GRAPH = "https://graph.instagram.com";

const DAY = 86400_000;
const iso = (ms: number) => new Date(ms).toISOString();

export const accountKey = (p: Platform) => `accounts/${p}`;
export const getAccount = (p: Platform) => getJSON<Account>(accountKey(p));

export async function saveAccount(p: Platform, fields: Partial<Account>) {
  await update<Account>(accountKey(p), (cur) => ({
    ...(cur ?? { platform: p, displayName: p, status: "ok" }),
    ...fields,
    platform: p,
  }));
}

export async function markAccountError(p: Platform, message: string) {
  await update<Account>(accountKey(p), (cur) => (cur ? { ...cur, status: "error", error: message } : undefined));
}

export const disconnect = (p: Platform) => kv().delete(accountKey(p));

export const redirectUri = (p: Platform) => `${config.siteUrl()}/api/connect/${p}/callback`;

export const youtubeConfigured = () => Boolean(config.googleClientId() && config.googleClientSecret());
export const instagramOAuthConfigured = () => Boolean(config.igAppId() && config.igAppSecret());

// ---- YouTube ----------------------------------------------------------------
export function youtubeAuthUrl(state: string) {
  return `${GOOGLE_AUTH}?${new URLSearchParams({
    client_id: config.googleClientId(),
    redirect_uri: redirectUri("youtube"),
    response_type: "code",
    scope: YT_SCOPES,
    access_type: "offline",
    prompt: "consent", // always get a refresh token
    include_granted_scopes: "true",
    state,
  })}`;
}

export async function youtubeFinishConnect(code: string, f: typeof fetch = fetch): Promise<string> {
  const resp = await f(GOOGLE_TOKEN, {
    method: "POST",
    body: new URLSearchParams({
      code, client_id: config.googleClientId(), client_secret: config.googleClientSecret(),
      redirect_uri: redirectUri("youtube"), grant_type: "authorization_code",
    }),
  });
  if (!resp.ok) throw new AuthError(`Google refused the login: ${(await resp.text()).slice(0, 300)}`);
  const tok: any = await resp.json();
  if (!tok.refresh_token) {
    throw new AuthError("Google did not give a refresh token. Remove the app's access at myaccount.google.com/permissions and connect again.");
  }
  const ch = await f("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const items: any[] = ch.ok ? ((await ch.json()) as any).items ?? [] : [];
  if (ch.ok && !items.length) throw new AuthError("This Google account has no YouTube channel. Create a channel first.");
  const name = items[0]?.snippet?.title ?? "YouTube channel";
  await putJSON(accountKey("youtube"), {
    platform: "youtube", displayName: name, remoteUserId: items[0]?.id ?? null,
    accessToken: tok.access_token, refreshToken: tok.refresh_token,
    tokenExpiresAt: iso(Date.now() + (tok.expires_in ?? 3600) * 1000), tokenRefreshedAt: iso(Date.now()),
    status: "ok", error: null,
  } satisfies Account);
  return name;
}

export async function youtubeAccessToken(force = false, f: typeof fetch = fetch): Promise<string> {
  const acc = await getAccount("youtube");
  if (!acc?.refreshToken) throw new AuthError("YouTube is not connected. Connect it in Settings.");
  const exp = Date.parse(acc.tokenExpiresAt ?? "") || 0;
  if (!force && acc.accessToken && exp > Date.now() + 5 * 60_000) return acc.accessToken;
  let resp: Response;
  try {
    resp = await f(GOOGLE_TOKEN, {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.googleClientId(), client_secret: config.googleClientSecret(),
        refresh_token: acc.refreshToken, grant_type: "refresh_token",
      }),
    });
  } catch (e: any) {
    throw new TransientError(`Network problem refreshing YouTube login: ${e?.message ?? e}`);
  }
  if (resp.status >= 500) throw new TransientError(`Google token server error ${resp.status}`);
  if (!resp.ok) {
    const msg = "YouTube login expired or was revoked. Reconnect YouTube in Settings. (If this happens every 7 days, set your Google OAuth app to 'In production'.)";
    await markAccountError("youtube", msg);
    throw new AuthError(msg);
  }
  const tok: any = await resp.json();
  await saveAccount("youtube", {
    accessToken: tok.access_token, tokenExpiresAt: iso(Date.now() + (tok.expires_in ?? 3600) * 1000),
    tokenRefreshedAt: iso(Date.now()), status: "ok", error: null,
  });
  return tok.access_token;
}

// ---- Instagram ----------------------------------------------------------------
export function instagramAuthUrl(state: string) {
  return `${IG_AUTH}?${new URLSearchParams({
    client_id: config.igAppId(), redirect_uri: redirectUri("instagram"), response_type: "code",
    scope: "instagram_business_basic,instagram_business_content_publish", state,
  })}`;
}

async function igStoreLongLived(token: string, expiresIn: number, f: typeof fetch): Promise<string> {
  const me = await f(`${IG_GRAPH}/${config.igApiVersion()}/me?${new URLSearchParams({
    fields: "user_id,username,account_type", access_token: token })}`);
  if (!me.ok) throw new AuthError(`Instagram token does not work: ${(await me.text()).slice(0, 300)}`);
  const info: any = await me.json();
  if (info.account_type === "PERSONAL") {
    throw new AuthError("This is a personal Instagram account. Switch it to Creator or Business first.");
  }
  const name = "@" + (info.username ?? "instagram");
  await putJSON(accountKey("instagram"), {
    platform: "instagram", displayName: name, remoteUserId: String(info.user_id ?? info.id),
    accessToken: token, refreshToken: null, tokenExpiresAt: iso(Date.now() + expiresIn * 1000),
    tokenRefreshedAt: iso(Date.now()), status: "ok", error: null,
  } satisfies Account);
  return name;
}

export async function instagramFinishConnect(code: string, f: typeof fetch = fetch): Promise<string> {
  const resp = await f(IG_SHORT_TOKEN, {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.igAppId(), client_secret: config.igAppSecret(), grant_type: "authorization_code",
      redirect_uri: redirectUri("instagram"), code: code.replace(/#_$/, ""),
    }),
  });
  if (!resp.ok) throw new AuthError(`Instagram refused the login: ${(await resp.text()).slice(0, 300)}`);
  let data: any = await resp.json();
  if (Array.isArray(data.data)) data = data.data[0];
  const ll = await f(`${IG_GRAPH}/access_token?${new URLSearchParams({
    grant_type: "ig_exchange_token", client_secret: config.igAppSecret(), access_token: data.access_token })}`);
  if (!ll.ok) throw new AuthError(`Could not get a long-lived Instagram token: ${(await ll.text()).slice(0, 300)}`);
  const tok: any = await ll.json();
  return igStoreLongLived(tok.access_token, tok.expires_in ?? 60 * 86400, f);
}

/** Token generated in the Meta developer dashboard (already long-lived). */
export async function instagramConnectWithToken(token: string, f: typeof fetch = fetch): Promise<string> {
  const name = await igStoreLongLived(token.trim(), 60 * 86400, f);
  try {
    await refreshInstagramToken(true, f); // learn the real expiry (works if token is >24h old)
  } catch {
    /* fine */
  }
  return name;
}

/** Long-lived IG tokens last 60 days; refresh weekly so they never run out. */
export async function refreshInstagramToken(force = false, f: typeof fetch = fetch): Promise<boolean> {
  const acc = await getAccount("instagram");
  if (!acc?.accessToken) return false;
  const refreshed = Date.parse(acc.tokenRefreshedAt ?? "") || 0;
  if (!force && Date.now() - refreshed < 7 * DAY) return false;
  const resp = await f(`${IG_GRAPH}/refresh_access_token?${new URLSearchParams({
    grant_type: "ig_refresh_token", access_token: acc.accessToken })}`);
  if (resp.ok) {
    const tok: any = await resp.json();
    await saveAccount("instagram", {
      accessToken: tok.access_token, tokenExpiresAt: iso(Date.now() + (tok.expires_in ?? 60 * 86400) * 1000),
      tokenRefreshedAt: iso(Date.now()), status: "ok", error: null,
    });
    return true;
  }
  const exp = Date.parse(acc.tokenExpiresAt ?? "") || 0;
  if ((resp.status === 400 || resp.status === 401) && exp < Date.now()) {
    await markAccountError("instagram", "Instagram login expired. Reconnect Instagram in Settings.");
  }
  return false;
}

export async function platformReady(p: Platform): Promise<boolean> {
  if (p === "youtube" && !youtubeConfigured()) return false;
  const acc = await getAccount(p);
  if (!acc || acc.status !== "ok") return false;
  return Boolean(p === "youtube" ? acc.refreshToken : acc.accessToken);
}

export async function accountProblems(): Promise<string[]> {
  const out: string[] = [];
  for (const p of ["youtube", "instagram"] as Platform[]) {
    const acc = await getAccount(p);
    const name = p === "youtube" ? "YouTube" : "Instagram";
    if (!acc) out.push(`${name} is not connected.`);
    else if (acc.status === "error") out.push(`${name}: ${acc.error}`);
    else if (p === "youtube" && !youtubeConfigured()) out.push("YouTube keys are missing in Netlify environment variables.");
  }
  return out;
}
