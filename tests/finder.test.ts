import { describe, expect, it } from "vitest";
import { findStories } from "../public/js/finder.js";

const NOW = Date.UTC(2026, 10, 6, 12);
function fakeArchive({ perSub = 250, busyFirst = false } = {}) {
  const calls: string[] = [];
  let busy = busyFirst;
  const posts = (sub: string) => Array.from({ length: perSub }, (_, i) => ({
    id: `${sub.slice(0, 2)}${i}`, score: (i * 37) % 1000, num_comments: i, created_utc: NOW / 1000 - 31 * 3600 - i * 600, title: `${sub} story ${i}`, over_18: i === 3,
  }));
  const f = (async (url: string) => {
    calls.push(url);
    if (busy) { busy = false; return new Response(JSON.stringify({ data: null, error: "Timeout. Maybe slow down a bit" }), { status: 200, headers: { "x-ratelimit-reset": "0" } }); }
    const u = new URL(url);
    if (u.pathname.endsWith("/posts/search")) {
      const sub = u.searchParams.get("subreddit")!, before = Number(u.searchParams.get("before")), after = Number(u.searchParams.get("after"));
      const page = posts(sub).filter((p) => p.created_utc < before && p.created_utc > after).slice(0, 100);
      return Response.json({ data: page });
    }
    const ids = u.searchParams.get("ids")!.split(",");
    return Response.json({ data: ids.map((id) => ({ id, title: "t " + id, author: "a", subreddit: id.startsWith("pe") ? "pettyrevenge" : "tifu", score: 1, num_comments: 0, selftext: "x", permalink: `/r/x/comments/${id}/` })) });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("automatic story finder", () => {
  it("reads all pages, skips NSFW, keeps the 15 best per subreddit and gets their full text", async () => {
    const { f, calls } = fakeArchive();
    const r = await findStories({ subs: ["pettyrevenge", "tifu"], days: 7, fetchImpl: f, now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.scanned).toBe(500);
    expect(calls.filter((c) => c.includes("/posts/search")).length).toBe(6); // 3 pages x 2 subs
    expect(r.posts.length).toBe(30);
    expect(r.posts.every((p: any) => p.score >= 50)).toBe(true); // archive score 1 is replaced by the scanned score
    expect(r.posts.find((p: any) => p.id === "pe3")).toBeUndefined(); // NSFW
    // newest ~30 hours are skipped
    expect(Number(new URL(calls[0]).searchParams.get("before"))).toBe(NOW / 1000 - 30 * 3600);
  }, 30000);

  it("waits and retries when the archive says slow down", async () => {
    const { f } = fakeArchive({ perSub: 20, busyFirst: true });
    const r = await findStories({ subs: ["pettyrevenge"], days: 3, fetchImpl: f, now: NOW });
    expect(r.errors).toEqual([]);
    expect(r.scanned).toBe(20);
  }, 30000);
});
