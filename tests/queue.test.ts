import { describe, expect, it } from "vitest";
import * as q from "../netlify/lib/queue.mts";
import { kv } from "../netlify/lib/store.mts";
import { zonedToDate } from "../netlify/lib/time.mts";
import * as tokens from "../netlify/lib/tokens.mts";
import {
  AuthError, DeferError, PermanentError, type StepResult, TransientError, type Video,
} from "../netlify/lib/types.mts";
import { addVideo, freshStore } from "./helpers.ts";
import { bestTimes, refreshStats } from "../netlify/lib/stats.mts";

freshStore();

async function connectAll() {
  for (const page of ["p1", "p2"] as const) {
    await tokens.saveAccount(page, "youtube", { accessToken: "a", refreshToken: "r", status: "ok", remoteUserId: `UC-${page}` });
    await tokens.saveAccount(page, "instagram", { accessToken: `ig-${page}`, remoteUserId: `17-${page}`, status: "ok" });
  }
}

type Outcome = StepResult | Error;
function fakeUploaders(outcomes: Record<string, Outcome[]>) {
  const calls: { platform: string; page: string; title: string; description: string; resume: any }[] = [];
  const run = (platform: string, page: string) => async (ctx: any, onStart?: () => Promise<void>) => {
    calls.push({ platform, page, title: ctx.title, description: ctx.description, resume: ctx.resume });
    if (onStart && !ctx.resume.session) await onStart();
    const o = outcomes[platform].shift()!;
    if (o instanceof Error) throw o;
    return o;
  };
  return {
    calls,
    ups: { youtube: (pg: string) => ({ step: run("youtube", pg) }), instagram: async (pg: string) => ({ step: run("instagram", pg) }) } as q.Uploaders,
  };
}
const ok = (id: string): StepResult => ({ done: true, remoteId: id, url: `https://x/${id}` });
const run = (ups: q.Uploaders) => q.runDuePosts(Date.now() + 20000, ups, fetch);
const posts = async (id: string) => (await q.getVideo(id))!.posts;

describe("slots", () => {
  it("releases one video per slot and catches up only once", async () => {
    await connectAll();
    await q.updateSettings((s) => { s.timezone = "UTC"; s.pages.p1.slots = ["12:00", "19:00"]; s.pages.p2.slots = []; });
    const v1 = await addVideo({ position: 1 });
    const v2 = await addVideo({ position: 2 });
    const t = (d: number, h: number, m = 0) => zonedToDate(2026, 5, d, h, m, "UTC");
    expect(await q.checkSlots(t(1, 11))).toEqual([]); // first run just records the time
    expect(await q.checkSlots(t(1, 11, 30))).toEqual([]);
    expect(await q.checkSlots(t(1, 20))).toEqual([v1.id]); // 12:00 and 19:00 missed → only one
    expect(await q.checkSlots(t(1, 20, 1))).toEqual([]);
    expect(await q.checkSlots(t(2, 12))).toEqual([v2.id]);
  });

  it("skips videos still uploading", async () => {
    await connectAll();
    await addVideo({ position: 1, status: "uploading" });
    const v2 = await addVideo({ position: 2 });
    expect(await q.releaseNextVideo("p1")).toBe(v2.id);
  });

  it("holds a video when an account it needs is disconnected", async () => {
    await connectAll();
    const v = await addVideo();
    await tokens.markAccountError("p1", "instagram", "expired");
    expect(await q.releaseNextVideo("p1")).toBeNull();
    expect(await q.missingPlatforms(v)).toEqual(["instagram"]);
    await tokens.saveAccount("p1", "instagram", { status: "ok", error: null });
    expect(await q.releaseNextVideo("p1")).toBe(v.id);
  });
});

describe("two pages", () => {
  it("each page posts its own next video at its own times", async () => {
    await connectAll();
    await q.updateSettings((s) => { s.timezone = "UTC"; s.pages.p1.slots = ["12:00"]; s.pages.p2.slots = ["15:00"]; });
    const a = await addVideo({ pageId: "p1", position: 1 });
    const b = await addVideo({ pageId: "p2", position: 1 });
    const t = (h: number) => zonedToDate(2026, 5, 1, h, 0, "UTC");
    await q.checkSlots(t(9)); // first run
    expect(await q.checkSlots(t(12))).toEqual([a.id]);
    expect(await q.checkSlots(t(15))).toEqual([b.id]);
  });

  it("uploads use the accounts of the video's page", async () => {
    const v = await addVideo({ pageId: "p2" });
    await q.releaseVideo(v.id);
    const { ups, calls } = fakeUploaders({ youtube: [ok("y")], instagram: [ok("i")] });
    await run(ups);
    expect(calls.map((c) => c.page)).toEqual(["p2", "p2"]);
  });

  it("an account problem on one page doesn't hold the other page", async () => {
    await connectAll();
    await tokens.markAccountError("p1", "youtube", "expired");
    await addVideo({ pageId: "p1" });
    const b = await addVideo({ pageId: "p2" });
    expect(await q.releaseNextVideo("p1")).toBeNull();
    expect(await q.releaseNextVideo("p2")).toBe(b.id);
  });

  it("refuses the same YouTube channel on both pages", async () => {
    await connectAll();
    const f = async (url: any) => String(url).includes("channels")
      ? Response.json({ items: [{ id: "UC-p1", snippet: { title: "Funny" } }] })
      : Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    await expect(tokens.youtubeFinishConnect("p2", "code", q.pageName, f as any)).rejects.toThrow(/already connected to "Reddit Stories"/);
  });

  it("old single-page data moves to page 1", async () => {
    await kv().setJSON("accounts/youtube", { platform: "youtube", displayName: "Old", refreshToken: "r", status: "ok" });
    await kv().setJSON("settings", { timezone: "UTC", slots: ["08:00"], youtubePrivacy: "public", addShortsTag: true });
    expect((await tokens.getAccount("p1", "youtube"))!.displayName).toBe("Old");
    expect(await tokens.getAccount("p2", "youtube")).toBeNull();
    expect((await q.getSettings()).pages.p1.slots).toEqual(["08:00"]);
    const v = await addVideo({ pageId: undefined } as any);
    expect(q.pageOf((await q.getVideo(v.id))!)).toBe("p1");
    await tokens.saveAccount("p1", "youtube", { accessToken: "new" });
    expect((await tokens.getAccount("p1", "youtube"))!.refreshToken).toBe("r"); // kept while moving
    expect(await kv().getJSON("accounts/youtube")).toBeNull();
  });
});

describe("posting", () => {
  it("posts to both platforms with the right text", async () => {
    const v = await addVideo();
    await q.releaseVideo(v.id);
    const { ups, calls } = fakeUploaders({ youtube: [ok("y1")], instagram: [ok("i1")] });
    expect(await run(ups)).toBe(2);
    const p = await posts(v.id);
    expect(p.youtube!.status).toBe("published");
    expect(p.youtube!.url).toBe("https://x/y1");
    expect(p.instagram!.status).toBe("published");
    const ytCall = calls.find((c) => c.platform === "youtube")!;
    const igCall = calls.find((c) => c.platform === "instagram")!;
    expect(ytCall.description).toContain("#Shorts");
    expect(igCall.description.startsWith("T\n\nD")).toBe(true);
    expect(igCall.description).not.toContain("#Shorts");
  });

  it("does not post videos that are not released", async () => {
    await addVideo();
    const { ups } = fakeUploaders({ youtube: [], instagram: [] });
    expect(await run(ups)).toBe(0);
  });

  it("progress across runs keeps the post uploading without counting a failure", async () => {
    const v = await addVideo({ platforms: ["youtube"] });
    await q.releaseVideo(v.id);
    const { ups } = fakeUploaders({ youtube: [{ done: false, note: "Uploading 40%" }, ok("y")] });
    await run(ups);
    let p = (await posts(v.id)).youtube!;
    expect([p.status, p.note, p.attempts]).toEqual(["uploading", "Uploading 40%", 0]);
    await run(ups);
    p = (await posts(v.id)).youtube!;
    expect(p.status).toBe("published");
  });

  it("an Instagram failure never re-uploads YouTube", async () => {
    const v = await addVideo();
    await q.releaseVideo(v.id);
    const { ups, calls } = fakeUploaders({ youtube: [ok("y1")], instagram: [new TransientError("net"), ok("i1")] });
    await run(ups);
    let p = await posts(v.id);
    expect(p.youtube!.status).toBe("published");
    expect(p.instagram!.status).toBe("pending");
    expect(p.instagram!.nextAttemptAt).toBeTruthy();
    await q.updatePost(v.id, "instagram", { nextAttemptAt: new Date(Date.now() - 1000).toISOString() });
    await run(ups);
    expect(calls.map((c) => c.platform).sort()).toEqual(["instagram", "instagram", "youtube"]);
    expect((await posts(v.id)).instagram!.status).toBe("published");
  });

  it("gives up after the maximum tries", async () => {
    const v = await addVideo({ platforms: ["youtube"] });
    await q.releaseVideo(v.id);
    const { ups, calls } = fakeUploaders({ youtube: Array(10).fill(new TransientError("x")) });
    for (let i = 0; i < 10; i++) {
      await q.updatePost(v.id, "youtube", { nextAttemptAt: null });
      await run(ups);
    }
    const p = (await posts(v.id)).youtube!;
    expect(p.status).toBe("failed");
    expect(p.lastError).toMatch(/Gave up after 4 tries/);
    expect(calls.length).toBe(4);
  });

  it("permanent and login errors fail with the reason", async () => {
    await connectAll();
    const v = await addVideo();
    await q.releaseVideo(v.id);
    const { ups } = fakeUploaders({ youtube: [new PermanentError("rejected")], instagram: [new AuthError("expired")] });
    await run(ups);
    const p = await posts(v.id);
    expect([p.youtube!.status, p.youtube!.lastError]).toEqual(["failed", "rejected"]);
    expect(p.instagram!.status).toBe("failed");
    expect((await tokens.getAccount("p1", "instagram"))!.status).toBe("error");
    expect((await tokens.getAccount("p2", "instagram"))!.status).toBe("ok"); // other page untouched
  });

  it("limits make posts wait without counting a try", async () => {
    const v = await addVideo({ platforms: ["youtube"] });
    await q.releaseVideo(v.id);
    const until = new Date(Date.now() + 5 * 3600_000);
    const { ups } = fakeUploaders({ youtube: [new DeferError("quota", until)] });
    await run(ups);
    const p = (await posts(v.id)).youtube!;
    expect([p.status, p.attempts, p.nextAttemptAt]).toEqual(["pending", 0, until.toISOString()]);
    expect(await run(ups)).toBe(0); // not due yet
  });

  it("respects the YouTube daily upload limit", async () => {
    process.env.YOUTUBE_DAILY_UPLOAD_LIMIT = "1";
    try {
      const v1 = await addVideo({ platforms: ["youtube"] });
      const v2 = await addVideo({ platforms: ["youtube"] });
      await q.releaseVideo(v1.id);
      await q.releaseVideo(v2.id);
      const { ups, calls } = fakeUploaders({ youtube: [ok("a"), ok("b")] });
      await run(ups);
      const statuses = [(await posts(v1.id)).youtube!.status, (await posts(v2.id)).youtube!.status].sort();
      expect(statuses).toEqual(["pending", "published"]);
      expect(calls.length).toBe(2); // second one stopped before starting an upload
    } finally {
      delete process.env.YOUTUBE_DAILY_UPLOAD_LIMIT;
    }
  });

  it("unexpected bugs never leave a post stuck", async () => {
    const v = await addVideo({ platforms: ["youtube"] });
    await q.releaseVideo(v.id);
    const { ups } = fakeUploaders({ youtube: [new RangeError("bug")] });
    await run(ups);
    expect((await posts(v.id)).youtube!.status).toBe("pending");
  });

  it("missing file fails clearly", async () => {
    const v = await addVideo({ platforms: ["youtube"] });
    await q.updateVideo(v.id, (x) => { x.filesDeleted = true; return true; });
    await q.releaseVideo(v.id);
    const { ups } = fakeUploaders({ youtube: [] });
    await run(ups);
    expect((await posts(v.id)).youtube!.lastError).toMatch(/removed from storage/);
  });
});

describe("captions", () => {
  it("adds story credit, page hashtags and #Shorts without repeating tags", async () => {
    const v = await addVideo({ description: "wild story #reddit", credit: { url: "https://www.reddit.com/r/tifu/comments/x/", author: "teller", permission: true } } as any);
    const s = await q.getSettings();
    const yt = q.buildText(v, "youtube", s).description;
    expect(yt).toBe("wild story #reddit\n\nStory by u/teller on Reddit\nhttps://www.reddit.com/r/tifu/comments/x/\n\n#redditstories #storytime\n\n#Shorts");
    const ig = q.buildText(v, "instagram", s).description;
    expect(ig.startsWith("T\n\nwild story")).toBe(true);
    expect(ig).not.toContain("#Shorts");
    const r = await addVideo({ description: "#redditstories only" });
    expect(q.buildText(r, "youtube", s).description).toContain("#reddit #storytime"); // #reddit still added
    const d = await addVideo({ pageId: "p2", description: "" });
    expect(q.buildText(d, "instagram", s).description).toBe("T\n\n#dreamcore #weirdcore #liminalspaces");
  });
});

describe("views & likes", () => {
  it("collects YouTube and Instagram numbers and finds the best time", async () => {
    await connectAll();
    await tokens.saveAccount("p1", "youtube", { tokenExpiresAt: new Date(Date.now() + 3600e3).toISOString() });
    const a = await addVideo({ releasedAt: "2026-05-01T12:00:30Z" } as any);
    const b = await addVideo({ releasedAt: "2026-05-01T19:00:20Z" } as any);
    const pub = (id: string) => ({ status: "published", publishedAt: new Date().toISOString(), remoteId: id, attempts: 0, resume: {} });
    await q.updateVideo(a.id, (v) => { v.posts = { youtube: pub("YA"), instagram: pub("IA") } as any; return true; });
    await q.updateVideo(b.id, (v) => { v.posts = { youtube: pub("YB"), instagram: pub("IB") } as any; return true; });
    const seen: string[] = [];
    const f = (async (url: any) => {
      const u = new URL(String(url));
      seen.push(u.host + u.pathname);
      if (u.host === "www.googleapis.com") return Response.json({ items: [
        { id: "YA", statistics: { viewCount: "100", likeCount: "10", commentCount: "1" } },
        { id: "YB", statistics: { viewCount: "900", likeCount: "90", commentCount: "9" } }] });
      if (u.pathname.endsWith("/insights")) return u.pathname.includes("IA")
        ? Response.json({ data: [{ name: "views", values: [{ value: 50 }] }] })
        : Response.json({ error: { code: 10, message: "no permission" } }, { status: 400 });
      return Response.json({ like_count: 5, comments_count: 2 });
    }) as typeof fetch;
    expect(await refreshStats(Date.now(), f, true)).toBe(4);
    const va = (await q.getVideo(a.id))!, vb = (await q.getVideo(b.id))!;
    expect(va.posts.youtube!.stats).toMatchObject({ views: 100, likes: 10, comments: 1 });
    expect(va.posts.instagram!.stats).toMatchObject({ views: 50, likes: 5, comments: 2 });
    expect(vb.posts.instagram!.stats!.views).toBeNull();
    expect(vb.posts.instagram!.stats!.note).toMatch(/insights permission/);
    expect(seen.filter((x) => x.startsWith("www.googleapis.com")).length).toBe(1); // one request for all YouTube videos
    expect(bestTimes([va, vb], "UTC")).toEqual([
      { time: "19:00", videos: 1, avgViews: 900 },
      { time: "12:00", videos: 1, avgViews: 150 },
    ]);
    // Not again within 3 hours unless forced
    expect(await refreshStats(Date.now(), f)).toBe(0);
  });
});

describe("archive", () => {
  it("moves videos finished over 35 days ago out of the live list, keeping their numbers", async () => {
    const old = new Date(Date.now() - 40 * 86400_000).toISOString();
    const v = await addVideo({ releasedAt: "2026-05-01T19:00:10Z" } as any);
    await q.updateVideo(v.id, (x) => {
      x.posts = {
        youtube: { status: "published", publishedAt: old, remoteId: "Y", attempts: 0, resume: {}, stats: { views: 500, likes: 20, comments: 0, updatedAt: old } },
        instagram: { status: "published", publishedAt: old, remoteId: "I", attempts: 0, resume: {}, stats: { views: 300, likes: 10, comments: 0, updatedAt: old } },
      } as any;
      return true;
    });
    await q.maintenance(Date.now(), fetch);
    expect(await q.getVideo(v.id)).toBeNull();
    expect(await kv().getJSON(`archive/${v.id}`)).not.toBeNull();
    expect(await kv().list(`chunks/${v.id}/`)).toEqual([]);
    const a = await q.getArchivedStats("p1");
    expect(a).toMatchObject({ count: 1, youtubeViews: 500, instagramViews: 300, likes: 30, byHour: { "19:00": { videos: 1, views: 800 } } });
    // archiving the same video again never double counts
    await q.archiveVideo((await kv().getJSON<any>(`archive/${v.id}`))!.data, "UTC");
    expect((await q.getArchivedStats("p1")).count).toBe(1);
    expect(bestTimes([], "UTC", a.byHour)).toEqual([{ time: "19:00", videos: 1, avgViews: 800 }]);
  });
});

describe("storage", () => {
  it("reads byte ranges across chunks", async () => {
    const bytes = new Uint8Array(25).map((_, i) => i);
    const v = await addVideo({ bytes, chunkSize: 10 } as any);
    expect([...(await q.readRange(v, 8, 5))]).toEqual([8, 9, 10, 11, 12]);
    expect([...(await q.readRange(v, 20, 5))]).toEqual([20, 21, 22, 23, 24]);
  });

  it("lock stops two scheduler runs at once", async () => {
    let inner: unknown = "not run";
    const outer = await q.withLock("t", 60000, async () => {
      inner = await q.withLock("t", 60000, async () => "second");
      return "first";
    });
    expect(outer).toBe("first");
    expect(inner).toBeNull();
    expect(await q.withLock("t", 60000, async () => "again")).toBe("again"); // released
  });

  it("maintenance deletes files a week after posting and drops abandoned uploads", async () => {
    const old = new Date(Date.now() - 8 * 86400_000).toISOString();
    const v = await addVideo({ platforms: ["youtube"] });
    await q.updatePost(v.id, "youtube", { status: "published", publishedAt: old });
    const abandoned = await addVideo({ status: "uploading", createdAt: old } as Partial<Video>);
    await q.maintenance(Date.now(), fetch);
    expect((await q.getVideo(v.id))!.filesDeleted).toBe(true);
    expect(await kv().list(`chunks/${v.id}/`)).toEqual([]);
    expect(await q.getVideo(abandoned.id)).toBeNull();
  });
});
