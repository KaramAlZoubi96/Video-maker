/**
 * Views & likes for posted videos, refreshed every 3 hours for 30 days after posting.
 *
 * YouTube: Data API videos.list (statistics) — uses the youtube.readonly
 * permission the site already asks for; costs 1 quota unit per 50 videos.
 * Instagram: like/comment counts come with the basic permission; views need
 * the "instagram_business_manage_insights" permission (asked for when you
 * connect with the button; pasted tokens need it enabled in the Meta app).
 */
import { getSettings, listVideos, pageOf, updatePost, updateSettings } from "./queue.mts";
import * as tokens from "./tokens.mts";
import { type PageId, PAGE_IDS, type PostStats, type Video, config } from "./types.mts";

const EVERY_MS = 3 * 3600_000;
const KEEP_UPDATING_MS = 30 * 86400_000;
const MAX_IG_PER_RUN = 15;

const num = (x: unknown): number | null => (x === undefined || x === null || x === "" ? null : Number(x));

export async function youtubeStats(page: PageId, ids: string[], f: typeof fetch): Promise<Map<string, PostStats>> {
  const out = new Map<string, PostStats>();
  if (!ids.length) return out;
  const token = await tokens.youtubeAccessToken(page, false, f);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const resp = await f(`https://www.googleapis.com/youtube/v3/videos?part=statistics&id=${batch.join(",")}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`YouTube stats error ${resp.status}`);
    const data: any = await resp.json();
    for (const it of data.items ?? []) {
      out.set(it.id, {
        views: num(it.statistics?.viewCount), likes: num(it.statistics?.likeCount),
        comments: num(it.statistics?.commentCount), updatedAt: new Date().toISOString(),
      });
    }
  }
  return out;
}

export async function instagramStats(page: PageId, mediaId: string, f: typeof fetch): Promise<PostStats | null> {
  const acc = await tokens.getAccount(page, "instagram");
  if (!acc?.accessToken) return null;
  const base = `https://graph.instagram.com/${config.igApiVersion()}/${mediaId}`;
  const r = await f(`${base}?${new URLSearchParams({ fields: "like_count,comments_count", access_token: acc.accessToken })}`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const d: any = await r.json();
  const stats: PostStats = { views: null, likes: num(d.like_count), comments: num(d.comments_count), updatedAt: new Date().toISOString() };
  const ins = await f(`${base}/insights?${new URLSearchParams({ metric: "views", access_token: acc.accessToken })}`, { signal: AbortSignal.timeout(8000) });
  if (ins.ok) {
    const j: any = await ins.json();
    const v = (j.data ?? []).find((m: any) => m.name === "views");
    stats.views = num(v?.values?.[0]?.value ?? v?.total_value?.value);
  } else {
    stats.note = "Instagram views need the insights permission. Reconnect Instagram with the Connect button.";
  }
  return stats;
}

/** Refresh numbers for recently posted videos (at most every 3 hours). */
export async function refreshStats(now = Date.now(), f: typeof fetch = fetch, force = false, deadline = Infinity): Promise<number> {
  const s = await getSettings();
  if (!force && s.lastStatsRun && now - Date.parse(s.lastStatsRun) < EVERY_MS) return 0;
  await updateSettings((x) => { x.lastStatsRun = new Date(now).toISOString(); });

  const recent = (await listVideos()).filter((v) => Object.values(v.posts).some(
    (p) => p?.status === "published" && p.remoteId && p.remoteId !== "unknown" && now - Date.parse(p.publishedAt ?? "") < KEEP_UPDATING_MS,
  ));
  let updated = 0;
  for (const page of PAGE_IDS) {
    const mine = recent.filter((v) => pageOf(v) === page);
    // YouTube: one request for up to 50 videos.
    const yt = mine.filter((v) => v.posts.youtube?.status === "published" && v.posts.youtube.remoteId);
    if (yt.length && (await tokens.platformReady(page, "youtube"))) {
      try {
        const stats = await youtubeStats(page, yt.map((v) => v.posts.youtube!.remoteId!), f);
        for (const v of yt) {
          const st = stats.get(v.posts.youtube!.remoteId!);
          if (st) { await updatePost(v.id, "youtube", { stats: st }); updated++; }
        }
      } catch (e) {
        console.warn(`YouTube stats failed (${page})`, e);
      }
    }
    // Instagram: one or two requests per video, oldest numbers first.
    const ig = mine
      .filter((v) => v.posts.instagram?.status === "published" && v.posts.instagram.remoteId && v.posts.instagram.remoteId !== "unknown")
      .sort((a: Video, b: Video) => (a.posts.instagram!.stats?.updatedAt ?? "").localeCompare(b.posts.instagram!.stats?.updatedAt ?? ""))
      .slice(0, MAX_IG_PER_RUN);
    if (ig.length && (await tokens.platformReady(page, "instagram"))) {
      for (const v of ig) {
        if (Date.now() > deadline) break; // continue next time
        try {
          const st = await instagramStats(page, v.posts.instagram!.remoteId!, f);
          if (st) { await updatePost(v.id, "instagram", { stats: st }); updated++; }
        } catch (e) {
          console.warn(`Instagram stats failed (${v.id})`, e);
        }
      }
    }
  }
  return updated;
}

/** Average views by posting hour, to see which time works best. `extra` = archived videos. */
export function bestTimes(videos: Video[], timezone: string, extra: Record<string, { videos: number; views: number }> = {}) {
  const groups = new Map<string, { videos: number; views: number }>(Object.entries(extra).map(([k, g]) => [k, { ...g }]));
  for (const v of videos) {
    if (!v.releasedAt) continue;
    const total = Object.values(v.posts).reduce((sum, p) => sum + (p?.stats?.views ?? 0), 0);
    const hasAny = Object.values(v.posts).some((p) => p?.stats?.views != null);
    if (!hasAny) continue;
    const hour = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(v.releasedAt));
    const key = `${hour}:00`;
    const g = groups.get(key) ?? { videos: 0, views: 0 };
    g.videos++;
    g.views += total;
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([time, g]) => ({ time, videos: g.videos, avgViews: Math.round(g.views / g.videos) }))
    .sort((a, b) => b.avgViews - a.avgViews);
}
