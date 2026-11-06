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

async function loggedIn(name = "alice", timezone?: string) {
  const b = new Browser();
  const r = await b.call("POST", "/api/setup", { username: name, password: "password123", timezone });
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
    expect((await anon.call("GET", "/api/me")).json).toEqual({ user: null, needsSetup: true, pages: [] });
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
  const credit = { url: "https://www.reddit.com/r/AmItheAsshole/comments/abc123/aita/", author: "u/storyteller", permission: true };
  const meta = { pageId: "p1", credit, title: "My short", description: "#fun", platforms: ["youtube", "instagram"], fileName: "a.mp4", width: 1080, height: 1920, duration: 12 };

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
    expect(v.credit).toEqual({ url: credit.url, author: "storyteller", permission: true });
    expect([...(await q.readRange(v, 0, size))].length).toBe(size);
    const d = (await b.call("GET", "/api/dashboard")).json;
    expect(d.pages[0].queued[0].title).toBe("My short");
    expect(d.pages[1].queued).toEqual([]);
    expect(d.pages[0].queued[0].posts.youtube.resume).toBeUndefined(); // internals never sent to the browser
  });

  it("rejects bad videos with clear messages", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, width: 1920, height: 1080 })).json.error).toMatch(/horizontal/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, duration: 1 })).json.error).toMatch(/too short/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 999e6 })).json.error).toMatch(/larger than/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, fileName: "a.webm" })).json.error).toMatch(/MP4/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, platforms: [] })).json.error).toMatch(/platform/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, title: "" })).json.error).toMatch(/title/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, pageId: "p9" })).json.error).toMatch(/which page/);
    // Reddit Stories page needs the story credit
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, credit: undefined })).json.error).toMatch(/link to the Reddit post/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, credit: { ...credit, url: "https://evil.com/x" } })).json.error).toMatch(/Reddit post/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, credit: { ...credit, author: "" } })).json.error).toMatch(/username/);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, credit: { ...credit, permission: false } })).json.error).toMatch(/said yes/);
    // Dreamcore page doesn't need it
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, pageId: "p2", credit: undefined })).status).toBe(200);
    // Page hashtags count toward Instagram's 30
    const many = Array.from({ length: 28 }, (_, i) => `#t${i}`).join(" ");
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, description: many })).json.error).toMatch(/Too many hashtags/);
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
    await tokens.saveAccount("p2", "youtube", { accessToken: "a", refreshToken: "r", status: "ok" });
    expect((await b.call("POST", `/api/videos/${c.json.id}/post-now`, {})).json.error).toMatch(/Connect YouTube for "Reddit Stories"/);
    await tokens.saveAccount("p1", "youtube", { accessToken: "a", refreshToken: "r", status: "ok" });
    expect((await b.call("POST", `/api/videos/${c.json.id}/post-now`, {})).status).toBe(200);
    expect((await q.getVideo(c.json.id))!.releasedAt).toBeTruthy();
  });

  it("asks before uploading the same video twice", async () => {
    const b = await loggedIn();
    const c1 = await b.call("POST", "/api/videos", { ...meta, size: 100 });
    await b.call("PUT", `/api/videos/${c1.json.id}/chunks/0`, undefined, { body: mp4Bytes(100) });
    await b.call("POST", `/api/videos/${c1.json.id}/complete`, {});
    const again = await b.call("POST", "/api/videos", { ...meta, size: 100 });
    expect(again.status).toBe(409);
    expect(again.json.duplicate).toBe(true);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, allowDuplicate: true })).status).toBe(200);
    expect((await b.call("POST", "/api/videos", { ...meta, size: 100, pageId: "p2" })).status).toBe(200); // other page is fine
  });

  it("move, edit, delete", async () => {
    const b = await loggedIn();
    const ids: string[] = [];
    for (const [t, size] of [["one", 100], ["two", 120]] as const) {
      const c = await b.call("POST", "/api/videos", { ...meta, title: t, size });
      await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(size) });
      await b.call("POST", `/api/videos/${c.json.id}/complete`, {});
      ids.push(c.json.id);
    }
    await b.call("POST", `/api/videos/${ids[1]}/move`, { direction: -1 });
    expect((await b.call("GET", "/api/dashboard")).json.pages[0].queued.map((v: any) => v.title)).toEqual(["two", "one"]);
    await b.call("POST", `/api/videos/${ids[0]}/edit`, { title: "uno", description: "x" });
    expect((await q.getVideo(ids[0]))!.title).toBe("uno");
    await b.call("POST", `/api/videos/${ids[0]}/delete`, {});
    expect(await q.getVideo(ids[0])).toBeNull();
    expect(await kv().list(`chunks/${ids[0]}/`)).toEqual([]);
  });
});

describe("approval, fixed times, calendar", () => {
  const meta2 = { pageId: "p2", title: "Dream", description: "", platforms: ["youtube"], fileName: "d.mp4", width: 1080, height: 1920, duration: 20 };
  async function uploadAs(br: Browser, size = 100, extra: object = {}) {
    const c = await br.call("POST", "/api/videos", { ...meta2, size, ...extra });
    await br.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(size) });
    await br.call("POST", `/api/videos/${c.json.id}/complete`, {});
    return c.json.id as string;
  }
  async function twoUsers() {
    const me = await loggedIn();
    await me.call("POST", "/api/users", { username: "bob", password: "password456" });
    const bob = new Browser();
    await bob.call("POST", "/api/login", { username: "bob", password: "password456" });
    await tokens.saveAccount("p2", "youtube", { accessToken: "a", refreshToken: "r", status: "ok" });
    return { me, bob };
  }

  it("with one user, videos don't need approval", async () => {
    const me = await loggedIn();
    const id = await uploadAs(me);
    expect((await q.getVideo(id))!.approval).toBe("approved");
  });

  it("the friend's video waits for my approval; I can approve or send it back", async () => {
    const { me, bob } = await twoUsers();
    const id = await uploadAs(bob);
    expect((await q.getVideo(id))!.approval).toBe("pending");
    expect((await me.call("GET", "/api/dashboard")).json.toApprove).toBe(1);
    expect((await bob.call("GET", "/api/dashboard")).json.toApprove).toBe(0);
    expect((await bob.call("POST", `/api/videos/${id}/post-now`, {})).json.error).toMatch(/waiting for approval/);
    expect(await q.releaseNextVideo("p2")).toBeNull(); // daily time skips it
    expect((await me.call("POST", `/api/videos/${id}/approve`, { decision: "changes" })).json.error).toMatch(/what should change/);
    await me.call("POST", `/api/videos/${id}/approve`, { decision: "changes", note: "Better title please" });
    expect((await q.getVideo(id))!).toMatchObject({ approval: "changes", approvalNote: "Better title please", approvedBy: "alice" });
    await bob.call("POST", `/api/videos/${id}/edit`, { title: "Better title", description: "" });
    expect((await q.getVideo(id))!.approval).toBe("pending");
    await me.call("POST", `/api/videos/${id}/approve`, { decision: "approve" });
    expect((await q.getVideo(id))!.approval).toBe("approved");
    expect(await q.releaseNextVideo("p2")).toBe(id);
  });

  it("approval can be turned off", async () => {
    const { me, bob } = await twoUsers();
    await me.call("POST", "/api/settings", { timezone: "UTC", requireApproval: false });
    expect((await q.getVideo(await uploadAs(bob)))!.approval).toBe("approved");
  });

  it("a fixed time posts at that time, not at the daily times", async () => {
    const me = await loggedIn();
    await tokens.saveAccount("p2", "youtube", { accessToken: "a", refreshToken: "r", status: "ok" });
    const id = await uploadAs(me);
    expect((await me.call("POST", `/api/videos/${id}/schedule`, { at: "2020-01-01T10:00" })).json.error).toMatch(/future/);
    expect((await me.call("POST", `/api/videos/${id}/schedule`, { at: "not a date" })).json.error).toMatch(/valid/);
    const soon = new Date(Date.now() + 2 * 3600e3);
    await me.call("POST", `/api/videos/${id}/schedule`, { at: soon.toISOString() });
    expect(await q.releaseNextVideo("p2")).toBeNull(); // not taken by a daily time
    expect(await q.releaseScheduled(new Date())).toEqual([]);
    expect(await q.releaseScheduled(new Date(soon.getTime() + 1000))).toEqual([id]);
  });

  it("calendar shows posted, fixed and upcoming videos in queue order", async () => {
    const me = await loggedIn();
    await me.call("POST", "/api/pages/p2", { name: "Dreamcore", slots: "09:00, 21:00" });
    const a = await uploadAs(me, 100), b = await uploadAs(me, 110), c = await uploadAs(me, 120);
    const fixed = new Date(Date.now() + 26 * 3600e3);
    await me.call("POST", `/api/videos/${c}/schedule`, { at: fixed.toISOString() });
    const cal = (await me.call("GET", "/api/calendar?days=7")).json;
    const p2 = cal.pages.find((p: any) => p.id === "p2");
    const autos = p2.items.filter((i: any) => i.kind === "auto");
    expect(autos.map((i: any) => i.videoId)).toEqual([a, b]);
    expect(Date.parse(autos[0].at)).toBeLessThan(Date.parse(autos[1].at));
    expect(p2.items.find((i: any) => i.kind === "fixed")).toMatchObject({ videoId: c, at: fixed.toISOString() });
    expect(p2.emptySlots.length).toBeGreaterThan(5); // only 2 videos for 14 daily times
    expect(cal.days.length).toBe(10);
  });

  it("serves the video in small pieces so it can be watched before approving", async () => {
    const me = await loggedIn();
    const id = await uploadAs(me, 100);
    const r = await me.call("GET", `/api/videos/${id}/file`, undefined, { headers: { Range: "bytes=10-" } });
    expect(r.status).toBe(206);
    expect(r.res.headers.get("content-range")).toBe("bytes 10-99/100");
  });
});

describe("stories board", () => {
  const story = (id: string, extra: object = {}) => ({ id, subreddit: "AmItheAsshole", author: "u/teller", title: "AITA for this?", body: "x ".repeat(100), score: 900, comments: 50, rating: 82, reasons: ["Popular"], ...extra });

  it("saves ticked stories once, shares them, and tracks status", async () => {
    const b = await loggedIn();
    const r = await b.call("POST", "/api/stories/import", { stories: [story("abc123"), story("def456"), story("abc123"), { id: "bad id!", title: "x", body: "y" }] });
    expect(r.json).toMatchObject({ added: 2, skipped: 2 });
    expect((await b.call("POST", "/api/stories/import", { stories: [story("abc123")] })).json.added).toBe(0);
    // friend sees the same board
    await b.call("POST", "/api/users", { username: "bob", password: "password456" });
    const friend = new Browser();
    await friend.call("POST", "/api/login", { username: "bob", password: "password456" });
    const list = (await friend.call("GET", "/api/stories")).json.stories;
    expect(list.map((s: any) => s.id).sort()).toEqual(["abc123", "def456"]);
    expect(list[0].author).toBe("teller");
    expect(list[0].url).toBe("https://www.reddit.com/r/AmItheAsshole/comments/abc123/");
    // friend picks it and marks permission
    const u = await friend.call("POST", "/api/stories/abc123", { pick: true, status: "allowed" });
    expect(u.json.story).toMatchObject({ pickedBy: "bob", status: "allowed" });
    expect((await b.call("POST", "/api/stories/abc123", { status: "nonsense" })).status).toBe(400);
    expect((await b.call("POST", "/api/stories/nope99", { status: "new" })).status).toBe(404);
    await b.call("POST", "/api/stories/def456/delete", {});
    expect((await b.call("GET", "/api/stories")).json.stories).toHaveLength(1);
  });

  it("a video made from a story marks the story as queued", async () => {
    const b = await loggedIn();
    await b.call("POST", "/api/stories/import", { stories: [story("abc123")] });
    const credit = { url: "https://www.reddit.com/r/AmItheAsshole/comments/abc123/", author: "teller", permission: true };
    const c = await b.call("POST", "/api/videos", { pageId: "p1", credit, storyId: "abc123", title: "AITA", description: "", platforms: ["youtube"], fileName: "story.mp4", size: 100, width: 1080, height: 1920, duration: 30 });
    await b.call("PUT", `/api/videos/${c.json.id}/chunks/0`, undefined, { body: mp4Bytes(100) });
    await b.call("POST", `/api/videos/${c.json.id}/complete`, {});
    const s = (await b.call("GET", "/api/stories/abc123")).json.story;
    expect(s.status).toBe("queued");
    expect(s.videoIds).toEqual([c.json.id]);
  });

  it("remembers used background minutes", async () => {
    const b = await loggedIn();
    await b.call("POST", "/api/backgrounds/used", { key: "parkour.mp4-123", start: 100, end: 190 });
    await b.call("POST", "/api/backgrounds/used", { key: "parkour.mp4-123", start: 500, end: 560 });
    expect((await b.call("GET", "/api/backgrounds/used?key=parkour.mp4-123")).json.ranges).toEqual([[100, 190], [500, 560]]);
    await b.call("POST", "/api/backgrounds/used", { key: "parkour.mp4-123", clear: true });
    expect((await b.call("GET", "/api/backgrounds/used?key=parkour.mp4-123")).json.ranges).toEqual([]);
  });
});

describe("settings & accounts", () => {
  it("first account sets the timezone from the browser", async () => {
    await loggedIn("alice", "Asia/Amman");
    expect((await q.getSettings()).timezone).toBe("Asia/Amman");
  });

  it("saves schedule and rejects bad times", async () => {
    const b = await loggedIn();
    expect((await b.call("POST", "/api/settings", { timezone: "Asia/Jerusalem", youtubePrivacy: "unlisted", addShortsTag: false })).status).toBe(200);
    expect((await b.call("POST", "/api/pages/p2", { name: "Cooking", slots: "19:00, 9:05", hashtags: "food  #recipe", needsCredit: false })).status).toBe(200);
    const s = await q.getSettings();
    expect([s.timezone, s.youtubePrivacy, s.addShortsTag]).toEqual(["Asia/Jerusalem", "unlisted", false]);
    expect(s.pages.p2).toMatchObject({ name: "Cooking", slots: ["09:05", "19:00"], hashtags: "#food #recipe", needsCredit: false });
    expect(s.pages.p1.slots).toEqual(["12:00", "19:00"]);
    expect((await b.call("POST", "/api/pages/p1", { name: "Funny", slots: "25:99" })).json.error).toMatch(/not a time/);
    expect((await b.call("POST", "/api/pages/p1", { name: "", slots: "" })).json.error).toMatch(/name/);
    expect((await b.call("POST", "/api/settings", { timezone: "Mars/Base" })).json.error).toMatch(/timezone/);
    const d = (await b.call("GET", "/api/dashboard")).json;
    expect(d.pages.map((p: any) => p.name)).toEqual(["Reddit Stories", "Cooking"]);
  });

  it("YouTube connect uses offline access and checks the security state", async () => {
    const b = await loggedIn();
    const r = await b.call("GET", "/api/connect/p2/youtube");
    const loc = r.res.headers.get("location")!;
    expect(loc).toContain("accounts.google.com");
    expect(loc).toContain("access_type=offline");
    expect(loc).toContain(encodeURIComponent(`${BASE}/api/connect/youtube/callback`));
    const bad = await b.call("GET", "/api/connect/youtube/callback?code=abc&state=forged");
    expect(bad.res.headers.get("location")).toMatch(/security%20check/);
    expect(await tokens.getAccount("p2", "youtube")).toBeNull();
  });

  it("changing the password logs out other devices but not this one", async () => {
    const b = await loggedIn();
    const other = new Browser();
    await other.call("POST", "/api/login", { username: "alice", password: "password123" });
    expect((await other.call("GET", "/api/dashboard")).status).toBe(200);
    expect((await b.call("POST", "/api/password", { current: "password123", new: "brandnew123" })).status).toBe(200);
    expect((await other.call("GET", "/api/dashboard")).status).toBe(401);
    expect((await b.call("GET", "/api/dashboard")).status).toBe(200);
  });

  it("changing posting times doesn't post right away", async () => {
    const b = await loggedIn();
    await q.updateSettings((s) => { s.pages.p1.lastSlotRun = "2020-01-01T00:00:00.000Z"; });
    await b.call("POST", "/api/pages/p1", { name: "Reddit Stories", slots: "00:01, 23:59", needsCredit: true });
    expect(Date.now() - Date.parse((await q.getSettings()).pages.p1.lastSlotRun!)).toBeLessThan(5000);
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
    await tokens.saveAccount("p1", "youtube", { accessToken: "old", refreshToken: "r", status: "ok", tokenExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
    expect(await tokens.youtubeAccessToken("p1", false, fakeFetch(() => { throw new Error("should not refresh"); }))).toBe("old");
    await tokens.saveAccount("p1", "youtube", { tokenExpiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await tokens.youtubeAccessToken("p1", false, fakeFetch(() => Response.json({ access_token: "new", expires_in: 3600 })))).toBe("new");
    await expect(tokens.youtubeAccessToken("p1", true, fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 })))).rejects.toThrow(/Reconnect/);
    expect((await tokens.getAccount("p1", "youtube"))!.status).toBe("error");
  });

  it("Instagram token renews weekly", async () => {
    await tokens.saveAccount("p2", "instagram", { accessToken: "t1", status: "ok", tokenRefreshedAt: new Date(Date.now() - 8 * 86400e3).toISOString() });
    expect(await tokens.refreshInstagramToken("p2", false, fakeFetch(() => Response.json({ access_token: "t2", expires_in: 5184000 })))).toBe(true);
    expect((await tokens.getAccount("p2", "instagram"))!.accessToken).toBe("t2");
    expect(await tokens.refreshInstagramToken("p2", false, fakeFetch(() => { throw new Error("no call"); }))).toBe(false);
  });

  it("personal Instagram accounts are refused", async () => {
    const f = fakeFetch(() => Response.json({ user_id: "1", username: "me", account_type: "PERSONAL" }));
    await expect(tokens.instagramConnectWithToken("p1", "tok", q.pageName, f)).rejects.toThrow(/personal/);
  });
});
