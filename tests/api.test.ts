import { describe, expect, it } from "vitest";
import { handle } from "../netlify/lib/api.mts";
import * as q from "../netlify/lib/queue.mts";
import { kv } from "../netlify/lib/store.mts";
import * as tokens from "../netlify/lib/tokens.mts";
import { fakeFetch, freshStore } from "./helpers.ts";

freshStore();
const BASE = "https://site.netlify.app";

class Browser {
  jar = new Map<string, string>();
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "); }
  set cookie(c: string) { const [k, ...v] = c.split("="); this.jar.set(k, v.join("=")); }
  async call(method: string, path: string, data?: unknown, extra: RequestInit = {}) {
    const headers = new Headers({ Origin: BASE, ...(extra.headers as any) });
    if (this.cookie) headers.set("cookie", this.cookie);
    let body: any = extra.body;
    if (data !== undefined) { headers.set("Content-Type", "application/json"); body = JSON.stringify(data); }
    const res = await handle(new Request(BASE + path, { method, headers, body }));
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0];
      if (/Max-Age=0/.test(sc)) this.jar.delete(pair.split("=")[0]); else this.cookie = pair;
    }
    const text = await res.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, res };
  }
}

async function loggedIn(name = "alice") {
  const b = new Browser();
  const r = await b.call("POST", "/api/setup", { username: name, password: "password123" });
  expect(r.status).toBe(200);
  return b;
}

function mp4Bytes(size: number) {
  const a = new Uint8Array(size);
  a.set(new TextEncoder().encode("\0\0\0\x18ftypmp42"), 0);
  return a;
}

describe("login", () => {
  it("setup once, then login/logout", async () => {
    const anon = new Browser();
    expect((await anon.call("GET", "/api/me")).json).toEqual({ user: null, needsSetup: true });
    const b = await loggedIn();
    expect((await b.call("GET", "/api/me")).json.user).toBe("alice");
    expect((await new Browser().call("POST", "/api/setup", { username: "evil", password: "password123" })).status).toBe(403);
    await b.call("POST", "/api/logout", {});
    expect((await b.call("GET", "/api/dashboard")).status).toBe(401);
    expect((await b.call("POST", "/api/login", { username: "alice", password: "wrong-pass" })).status).toBe(401);
    expect((await b.call("POST", "/api/login", { username: "ALICE", password: "password123" })).status).toBe(200);
    expect((await b.call("GET", "/api/dashboard")).status).toBe(200);
  });

  it("friend gets their own login", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/users", { username: "bob", password: "password456" })).status).toBe(200);
    expect((await b.call("POST", "/api/users", { username: "Bob", password: "password456" })).json.error).toMatch(/taken/);
    const friend = new Browser();
    expect((await friend.call("POST", "/api/login", { username: "bob", password: "password456" })).status).toBe(200);
  });

  it("locks out after 5 wrong passwords", async () => {
    await loggedIn();
    const b = new Browser();
    for (let i = 0; i < 5; i++) await b.call("POST", "/api/login", { username: "alice", password: "nope-nope" });
    const r = await b.call("POST", "/api/login", { username: "alice", password: "password123" });
    expect(r.json.error).toMatch(/Too many/);
  });

  it("forged cookies and other websites are rejected", async () => {
    const b = await loggedIn();
    const forged = new Browser();
    forged.cookie = "sap_session=eyJ1IjoiYWxpY2UifQ.bad";
    expect((await forged.call("GET", "/api/dashboard")).status).toBe(401);
    const evil = await b.call("POST", "/api/users", { username: "x1", password: "password123" }, { headers: { Origin: "https://evil.com" } });
    expect(evil.status).toBe(403);
  });
});

describe("upload", () => {
  const meta = { title: "My short", description: "#fun", platforms: ["youtube", "instagram"], fileName: "a.mp4", width: 1080, height: 1920, duration: 12 };

  it("chunked upload → ready in queue", async () => {
    const b = await loggedIn();
    const size = 4 * 1024 * 1024 + 500;
    const bytes = mp4Bytes(size);
    const c = await b.call("POST", "/api/videos", { ...meta, size });
    expect(c.status).toBe(200);
    expect(c.json.chunkCount).toBe(2);
    const { id, chunkSize } = c.json;
    // finishing early reports what's missing
    expect((await b.call("POST", `/api/videos/${id}/complete`, {})).json.missing).toEqual([0, 1]);
    for (const n of [1, 0]) {
      const r = await b.call("PUT", `/api/videos/${id}/chunks/${n}`, undefined, { body: bytes.slice(n * chunkSize, (n + 1) * chunkSize) });
      expect(r.status).toBe(200);
    }
    expect((await b.call("POST", `/api/videos/${id}/complete`, {})).status).toBe(200);
    const v = (await q.getVideo(id))!;
    expect(v.status).toBe("ready");
    expect([...(await q.readRange(v, 0, size))].length).toBe(size);
    const d = (await b.call("GET", "/api/dashboard")).json;
    expect(d.queued[0].title).toBe("My short");
    expect(d.queued[0].posts.youtube.resume).toBeUndefined(); // internals never sent to the browser
  });

  it("rejects bad videos with clear messages", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, width: 1920, height: 1080 })).json.error).toMatch(/horizontal/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, duration: 1 })).json.error).toMatch(/too short/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 999e6 })).json.error).toMatch(/larger than/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, fileName: "a.webm" })).json.error).toMatch(/MP4/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, platforms: [] })).json.error).toMatch(/platform/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, title: "" })).json.error).toMatch(/title/);
    const c = await b.call("POST", "/api/videos", { ...meta, size: 100 });
    const notVideo = await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: new Uint8Array(100) });
    expect(notVideo.json.error).toMatch(/doesn't look like an MP4/);
    const wrongSize = await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(50) });
    expect(wrongSize.status).toBe(422);
  });

  it("post now is refused until accounts are connected, then starts", async () => {
    const b = await loggedIn();
    const c = await b.call("POST", "/api/videos", { ...meta, size: 100, platforms: ["youtube"] });
    await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(100) });
    await b.call("POST", `/api/videos/${c.json.id}/complete`, {});
    expect((await b.call("POST", `/api/videos/${c.json.id}/post-now`, {})).json.error).toMatch(/Connect YouTube/);
    await tokens.saveAccount("youtube", { accessToken: "a", refreshToken: "r", status: "ok" });
    expect((await b.call("POST", `/api/videos/${c.json.id}/post-now`, {})).status).toBe(200);
    expect((await q.getVideo(c.json.id))!.releasedAt).toBeTruthy();
  });

  it("move, edit, delete", async () => {
    const b = await loggedIn();
    const ids: string[] = [];
    for (const t of ["one", "two"]) {
      const c = await b.call("POST", "/api/videos", { ...meta, title: t, size: 100 });
      await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(100) });
      await b.call("POST", `/api/videos/${c.json.id}/complete`, {});
      ids.push(c.json.id);
    }
    await b.call("POST", `/api/videos/${ids[1]}/move`, { direction: -1 });
    expect((await b.call("GET", "/api/dashboard")).json.queued.map((v: any) => v.title)).toEqual(["two", "one"]);
    await b.call("POST", `/api/videos/${ids[0]}/edit`, { title: "uno", description: "x" });
    expect((await q.getVideo(ids[0]))!.title).toBe("uno");
    await b.call("POST", `/api/videos/${ids[0]}/delete`, {});
    expect(await q.getVideo(ids[0])).toBeNull();
    expect(await kv().list(`chunks/${ids[0]}/`)).toEqual([]);
  });
});

describe("settings & accounts", () => {
  it("saves schedule and rejects bad times", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/settings", { timezone: "Asia/Jerusalem", slots: "19:00, 9:05", youtubePrivacy: "unlisted", addShortsTag: false })).status).toBe(200);
    const s = await q.getSettings();
    expect([s.timezone, s.slots, s.youtubePrivacy, s.addShortsTag]).toEqual(["Asia/Jerusalem", ["09:05", "19:00"], "unlisted", false]);
    expect((await b.call("POST", "/api/settings", { timezone: "UTC", slots: "25:99" })).json.error).toMatch(/not a time/);
    expect((await b.call("POST", "/api/settings", { timezone: "Mars/Base", slots: "" })).json.error).toMatch(/timezone/);
  });

  it("YouTube connect uses offline access and checks the security state", async () => {
    const b = await loggedIn();
    const r = await b.call("GET", "/api/connect/youtube");
    const loc = r.res.headers.get("location")!;
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("access_type=offline");
    expect(loc).toContain(encodeURIComponent(`${BASE}/api/connect/youtube/callback`));
    const bad = await b.call("GET", "/api/connect/youtube/callback?code=abc&state=forged");
    expect(bad.res.headers.get("location")).toMatch(/security%20check/);
    expect(await tokens.getAccount("youtube")).toBeNull();
  });

  it("change password", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/password", { current: "nope-nope", new: "newpassword1" })).json.error).toMatch(/wrong/);
    expect((await b.call("POST", "/api/password", { current: "password123", new: "newpassword1" })).status).toBe(200);
    expect((await new Browser().call("POST", "/api/login", { username: "alice", password: "newpassword1" })).status).toBe(200);
  });
});

describe("tokens", () => {
  it("YouTube token refreshes when expired, marks account on revoke", async () => {
    await tokens.saveAccount("youtube", { accessToken: "old", refreshToken: "r", status: "ok", tokenExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
    expect(await tokens.youtubeAccessToken(false, fakeFetch(() => { throw new Error("should not refresh"); }))).toBe("old");
    await tokens.saveAccount("youtube", { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await tokens.youtubeAccessToken(false, fakeFetch(() => Response.json({ access_token: "new", expires_in: 3600 })))).toBe("new");
    await expect(tokens.youtubeAccessToken(true, fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 })))).rejects.toThrow(/Reconnect/);
    expect((await tokens.getAccount("youtube"))!.status).toBe("error");
  });

  it("Instagram token renews weekly", async () => {
    await tokens.saveAccount("instagram", { accessToken: "t1", status: "ok", tokenRefreshedAt: new Date(Date.now() - 8 * 86400e3).toISOString() });
    expect(await tokens.refreshInstagramToken(false, fakeFetch(() => Response.json({ access_token: "t2", expires_in: 5184000 })))).toBe(true);
    expect((await tokens.getAccount("instagram"))!.accessToken).toBe("t2");
    expect(await tokens.refreshInstagramToken(false, fakeFetch(() => { throw new Error("no call"); }))).toBe(false);
  });

  it("personal Instagram accounts are refused", async () => {
    const f = fakeFetch(() => Response.json({ user_id: "1", username: "me", account_type: "PERSONAL" }));
    await expect(tokens.instagramConnectWithToken("tok", f)).rejects.toThrow(/personal/);
  });
});
