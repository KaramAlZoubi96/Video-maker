/**
 * The automatic part: queue, posting slots, and moving uploads forward.
 *
 * - The scheduler runs every minute. At each daily time slot the top video of
 *   the queue is "released". If slots were missed, ONE video is released.
 * - Each platform is its own post with its own state, so a problem on
 *   Instagram never re-uploads to YouTube.
 * - Uploads move forward a few pieces per run, and the position is saved
 *   after every piece.
 * - Temporary errors retry with growing waits; limits wait for the reset;
 *   rejections are marked failed with the reason.
 */
import { InstagramUploader, IG_UPLOAD_MIN_MS } from "./instagram.mts";
import { getJSON, kv, update } from "./store.mts";
import { latestSlotBefore, nextQuotaReset, pacificDay } from "./time.mts";
import * as tokens from "./tokens.mts";
import {
  AuthError, DEFAULT_SETTINGS, DeferError, PAGE_IDS, type PageId, PermanentError, type Platform, PLATFORMS, type Post,
  PublishError, type Settings, type StepContext, type StepResult, type Video, config,
} from "./types.mts";
import { refreshStats } from "./stats.mts";
import { YouTubeUploader } from "./youtube.mts";

const RETRY_DELAYS_MIN = [5, 20, 60, 180];
const DAY = 86400_000;

export const videoKey = (id: string) => `videos/${id}`;
export const chunkKey = (id: string, n: number) => `chunks/${id}/${String(n).padStart(5, "0")}`;
export const thumbKey = (id: string) => `thumbs/${id}`;
export const archiveKey = (id: string) => `archive/${id}`;
export const pageStatsKey = (page: PageId) => `pagestats/${page}`;

/** Numbers of old videos that were moved to the archive (so the queue stays fast). */
export interface ArchivedStats {
  count: number;
  youtubeViews: number;
  instagramViews: number;
  likes: number;
  byHour: Record<string, { videos: number; views: number }>;
}
export const emptyArchivedStats = (): ArchivedStats => ({ count: 0, youtubeViews: 0, instagramViews: 0, likes: 0, byHour: {} });
export async function getArchivedStats(page: PageId): Promise<ArchivedStats> {
  return (await getJSON<ArchivedStats>(pageStatsKey(page))) ?? emptyArchivedStats();
}

const ARCHIVE_AFTER_MS = 35 * 86400_000;

// ---- settings ---------------------------------------------------------------
/** Fill in defaults, and move old single-page settings into page 1. */
function withDefaults(cur: Partial<Settings> | null): Settings {
  const s = { ...structuredClone(DEFAULT_SETTINGS), ...(cur ?? {}) } as Settings;
  s.pages = structuredClone(DEFAULT_SETTINGS.pages);
  for (const id of PAGE_IDS) s.pages[id] = { ...s.pages[id], ...(cur?.pages?.[id] ?? {}) };
  if (!cur?.pages && cur?.slots) {
    s.pages.p1 = { ...s.pages.p1, slots: cur.slots, lastSlotRun: cur.lastSlotRun ?? null };
  }
  delete s.slots;
  delete s.lastSlotRun;
  return s;
}
export async function getSettings(): Promise<Settings> {
  return withDefaults(await getJSON<Settings>("settings"));
}
export async function updateSettings(fn: (s: Settings) => void) {
  await update<Settings>("settings", (cur) => {
    const s = withDefaults(cur);
    fn(s);
    return s;
  });
}
export const pageOf = (v: Video): PageId => v.pageId ?? "p1";
export async function pageName(id: PageId): Promise<string> {
  return (await getSettings()).pages[id].name;
}

// ---- videos -----------------------------------------------------------------
export async function listVideos(): Promise<Video[]> {
  const keys = await kv().list("videos/");
  const docs = await Promise.all(keys.map((k) => getJSON<Video>(k)));
  return docs.filter((v): v is Video => Boolean(v));
}

export const getVideo = (id: string) => getJSON<Video>(videoKey(id));

/** Change a video document safely. `fn` edits the video and returns true to save, false for no change. */
export async function updateVideo(id: string, fn: (v: Video) => boolean) {
  return update<Video>(videoKey(id), (cur) => (cur && fn(cur) ? cur : undefined));
}

export async function updatePost(id: string, platform: Platform, fields: Partial<Post>) {
  return updateVideo(id, (v) => {
    const p = v.posts[platform];
    if (!p) return false;
    v.posts[platform] = { ...p, ...fields };
    return true;
  });
}

export async function readRange(video: Video, start: number, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const pos = start + filled;
    const n = Math.floor(pos / video.chunkSize);
    const chunk = await kv().getBytes(chunkKey(video.id, n));
    if (!chunk) throw new PermanentError("Video file is missing from storage. Upload it again.");
    const from = pos - n * video.chunkSize;
    const take = Math.min(chunk.length - from, length - filled);
    if (take <= 0) throw new PermanentError("Video file in storage is incomplete. Upload it again.");
    out.set(chunk.subarray(from, from + take), filled);
    filled += take;
  }
  return out;
}

export async function deleteVideoFiles(id: string) {
  for (const k of await kv().list(`chunks/${id}/`)) await kv().delete(k);
}

// ---- releasing --------------------------------------------------------------
export async function missingPlatforms(v: Video): Promise<Platform[]> {
  const out: Platform[] = [];
  for (const [p, post] of Object.entries(v.posts) as [Platform, Post][]) {
    if (post.status === "pending" && !(await tokens.platformReady(pageOf(v), p))) out.push(p);
  }
  return out;
}

export async function releaseVideo(id: string, now = new Date()): Promise<boolean> {
  let ok = false;
  await updateVideo(id, (v) => {
    if (v.status !== "ready" || v.releasedAt) return false;
    v.releasedAt = now.toISOString();
    for (const p of Object.values(v.posts)) if (p && p.status === "pending") p.nextAttemptAt = null;
    ok = true;
    return true;
  });
  return ok;
}

/** Release the top video of a page's queue. Held (not failed) if an account it needs is disconnected. */
export async function releaseNextVideo(page: PageId, now = new Date()): Promise<string | null> {
  const queue = (await listVideos())
    .filter((v) => pageOf(v) === page && v.status === "ready" && !v.releasedAt && !v.deleted && Object.values(v.posts).some((p) => p?.status === "pending"))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const top = queue[0];
  if (!top) return null;
  const missing = await missingPlatforms(top);
  if (missing.length) {
    console.warn(`Slot skipped: video ${top.id} needs ${missing.join(", ")}, which is not connected`);
    return null;
  }
  return (await releaseVideo(top.id, now)) ? top.id : null;
}

/** Each page posts at its own times. Returns the ids of videos released now. */
export async function checkSlots(now = new Date()): Promise<string[]> {
  const released: string[] = [];
  for (const page of PAGE_IDS) {
    const s = await getSettings();
    const ps = s.pages[page];
    if (!ps.slots.length) continue;
    if (!ps.lastSlotRun) {
      // First run: slots that already passed are not "missed".
      await updateSettings((x) => { x.pages[page].lastSlotRun = now.toISOString(); });
      continue;
    }
    const slot = latestSlotBefore(now, ps.slots, s.timezone);
    if (!slot || slot <= new Date(ps.lastSlotRun)) continue;
    await updateSettings((x) => { x.pages[page].lastSlotRun = now.toISOString(); });
    const id = await releaseNextVideo(page, now);
    if (id) released.push(id);
  }
  return released;
}

// ---- posting ----------------------------------------------------------------
export function creditLine(v: Video): string {
  if (!v.credit?.author) return "";
  const who = v.credit.author.replace(/^\/?u\//i, "");
  return `Story by u/${who} on Reddit${v.credit.url ? `\n${v.credit.url}` : ""}`;
}

/** Final text per platform: caption + story credit + the page's saved hashtags (+ #Shorts on YouTube). */
export function buildText(v: Video, platform: Platform, s: Settings): { title: string; description: string } {
  const title = v.title.trim();
  const page = s.pages[pageOf(v)];
  const parts = [v.description.trim(), creditLine(v)];
  const tags = (page.hashtags ?? "").trim();
  const text = `${title} ${parts.join(" ")}`.toLowerCase();
  const has = (tag: string) => new RegExp(`${tag.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(text);
  const newTags = tags.split(/\s+/).filter((t) => t && !has(t)).join(" ");
  if (newTags) parts.push(newTags);
  if (platform === "youtube" && s.addShortsTag && !has("#shorts")) parts.push("#Shorts");
  const desc = parts.filter(Boolean).join("\n\n");
  return { title, description: platform === "instagram" ? `${title}\n\n${desc}`.trim() : desc };
}

export interface Uploaders {
  youtube: (page: PageId) => { step(ctx: StepContext, onSessionStart: () => Promise<void>): Promise<StepResult> };
  instagram: (page: PageId) => Promise<{ step(ctx: StepContext): Promise<StepResult> }>;
}

export const realUploaders: Uploaders = {
  youtube: (page) => {
    if (!tokens.youtubeConfigured()) throw new AuthError("YouTube keys are missing in Netlify environment variables (see docs/SETUP_YOUTUBE.md).");
    return new YouTubeUploader((force) => tokens.youtubeAccessToken(page, force));
  },
  instagram: async (page) => {
    const acc = await tokens.getAccount(page, "instagram");
    if (!acc?.accessToken) throw new AuthError("Instagram is not connected. Connect it in Settings.");
    if (acc.status === "error") throw new AuthError(acc.error || "Instagram connection has a problem. Reconnect it in Settings.");
    return new InstagramUploader(acc.accessToken, acc.remoteUserId ?? "", config.igApiVersion());
  },
};

async function youtubeCountToday(): Promise<number> {
  return (await getJSON<{ n: number }>(`ytcount/${pacificDay()}`))?.n ?? 0;
}

async function bumpYoutubeCount() {
  await update<{ n: number }>(`ytcount/${pacificDay()}`, (cur) => ({ n: (cur?.n ?? 0) + 1 }));
}

function isDue(p: Post | undefined, now: number) {
  if (!p) return false;
  if (p.status === "uploading") return true;
  return p.status === "pending" && (!p.nextAttemptAt || Date.parse(p.nextAttemptAt) <= now);
}

/** Do one step of one post. Never throws. */
export async function stepPost(listed: Video, platform: Platform, deadline: number, ups: Uploaders, f: typeof fetch): Promise<void> {
  // Re-read: the video may have been deleted or changed since the list was made.
  const v = await getVideo(listed.id);
  if (!v || v.deleted || !v.releasedAt || !isDue(v.posts[platform], Date.now())) return;
  const post = v.posts[platform]!;
  const settings = await getSettings();
  const now = Date.now();
  await updatePost(v.id, platform, {
    status: "uploading",
    startedAt: post.startedAt ?? new Date(now).toISOString(),
    note: post.status === "uploading" ? post.note : "Starting…",
  });
  const { title, description } = buildText(v, platform, settings);
  let resume = { ...(post.resume ?? {}) };
  const ctx: StepContext = {
    video: v, resume, title, description, youtubePrivacy: settings.youtubePrivacy, deadline, fetch: f,
    readRange: (s, l) => readRange(v, s, l),
    saveResume: async (r) => {
      resume = r;
      ctx.resume = r;
      await updatePost(v.id, platform, { resume: r });
    },
  };

  let result: StepResult;
  try {
    if (v.filesDeleted) throw new PermanentError("Video file was already removed from storage.");
    if (platform === "youtube") {
      result = await ups.youtube(pageOf(v)).step(ctx, async () => {
        // The daily limit belongs to your Google Cloud project, so both pages share it.
        if ((await youtubeCountToday()) >= config.ytDailyLimit()) {
          throw new DeferError("Waiting for the YouTube daily upload limit to reset.", nextQuotaReset());
        }
        await bumpYoutubeCount();
      });
    } else {
      result = await (await ups.instagram(pageOf(v))).step(ctx);
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    if (e instanceof DeferError) {
      await updatePost(v.id, platform, { status: "pending", nextAttemptAt: e.until.toISOString(), note: msg });
    } else if (e instanceof AuthError) {
      await tokens.markAccountError(pageOf(v), platform, msg);
      await updatePost(v.id, platform, { status: "failed", lastError: msg, note: null, nextAttemptAt: null });
    } else if (e instanceof PermanentError) {
      await updatePost(v.id, platform, { status: "failed", lastError: msg, note: null, nextAttemptAt: null });
    } else {
      // Transient or unexpected: retry with growing waits, then give up.
      if (!(e instanceof PublishError)) console.error("Unexpected error", e);
      const attempts = (post.attempts ?? 0) + 1;
      if (attempts >= config.maxAttempts()) {
        await updatePost(v.id, platform, { status: "failed", attempts, lastError: `Gave up after ${attempts} tries: ${msg}`, note: null, nextAttemptAt: null });
      } else {
        const wait = RETRY_DELAYS_MIN[Math.min(attempts - 1, RETRY_DELAYS_MIN.length - 1)];
        await updatePost(v.id, platform, {
          status: "pending", attempts, lastError: msg, note: `Retrying in ${wait} min`,
          nextAttemptAt: new Date(Date.now() + wait * 60_000).toISOString(),
        });
      }
    }
    return;
  }

  if (result.done) {
    await updatePost(v.id, platform, {
      status: "published", remoteId: result.remoteId, url: result.url, publishedAt: new Date().toISOString(),
      lastError: null, note: null, nextAttemptAt: null,
    });
  } else {
    await updatePost(v.id, platform, { note: result.note });
  }
}

/** Move every due post forward until the time budget runs out. */
export async function runDuePosts(deadline: number, ups: Uploaders = realUploaders, f: typeof fetch = fetch): Promise<number> {
  let steps = 0;
  const done = new Set<string>();
  while (Date.now() < deadline) {
    const now = Date.now();
    const work: { v: Video; p: Platform; igUpload: boolean }[] = [];
    for (const v of await listVideos()) {
      if (v.status !== "ready" || !v.releasedAt || v.deleted) continue;
      for (const p of PLATFORMS) {
        const post = v.posts[p];
        if (!isDue(post, now) || done.has(`${v.id}/${p}`)) continue;
        const igUpload = p === "instagram" && !["processing", "publishing"].includes(post!.resume?.step);
        work.push({ v, p, igUpload });
      }
    }
    if (!work.length) break;
    // Instagram's single big upload goes first so it gets the most time.
    work.sort((a, b) => Number(b.igUpload) - Number(a.igUpload) || (a.v.releasedAt ?? "").localeCompare(b.v.releasedAt ?? ""));
    const item = work.find((w) => !w.igUpload || deadline - Date.now() >= IG_UPLOAD_MIN_MS) ?? work[0];
    await stepPost(item.v, item.p, deadline, ups, f);
    done.add(`${item.v.id}/${item.p}`); // one step per post per run
    steps++;
  }
  return steps;
}

// ---- lock + maintenance -----------------------------------------------------
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | null> {
  const key = `locks/${name}`;
  const owner = crypto.randomUUID();
  const cur = await kv().getJSON<{ until: number; owner: string }>(key);
  if (cur && cur.data.until > Date.now()) return null;
  const ok = cur
    ? await kv().setJSON(key, { until: Date.now() + ttlMs, owner }, { onlyIfMatch: cur.etag })
    : await kv().setJSON(key, { until: Date.now() + ttlMs, owner }, { onlyIfNew: true });
  if (!ok) return null;
  try {
    return await fn();
  } finally {
    const mine = await kv().getJSON<{ until: number; owner: string }>(key);
    if (mine?.data.owner === owner) await kv().setJSON(key, { until: 0, owner: "" }, { onlyIfMatch: mine.etag });
  }
}

/** Daily: renew logins, delete files of videos published a week ago, drop abandoned uploads. */
export async function maintenance(now = Date.now(), f: typeof fetch = fetch, deadline = Infinity) {
  const s = await getSettings();
  if (s.lastMaintenance && now - Date.parse(s.lastMaintenance) < DAY / 4) return;
  await updateSettings((x) => { x.lastMaintenance = new Date(now).toISOString(); });
  for (const page of PAGE_IDS) {
    try {
      await tokens.refreshInstagramToken(page, false, f);
    } catch (e) {
      console.warn(`Instagram token refresh failed (${page})`, e);
    }
    try {
      if (await tokens.getAccount(page, "youtube")) await tokens.youtubeAccessToken(page, false, f);
    } catch (e) {
      console.warn(`YouTube token check failed (${page})`, e);
    }
  }
  for (const v of await listVideos()) {
    if (Date.now() > deadline) break; // the rest waits for the next run
    const posts = Object.values(v.posts);
    const allPublished = posts.length > 0 && posts.every((p) => p?.status === "published");
    const lastPub = Math.max(...posts.map((p) => Date.parse(p?.publishedAt ?? "") || 0));
    if (allPublished && now - lastPub > ARCHIVE_AFTER_MS) {
      await archiveVideo(v, s.timezone);
      continue;
    }
    if (allPublished && !v.filesDeleted && now - lastPub > 7 * DAY) {
      await deleteVideoFiles(v.id);
      await updateVideo(v.id, (x) => { x.filesDeleted = true; return true; });
    }
    if (v.status === "uploading" && now - Date.parse(v.createdAt) > DAY) {
      await deleteVideoFiles(v.id);
      await kv().delete(thumbKey(v.id));
      await kv().delete(videoKey(v.id));
    }
  }
}

/**
 * Move a long-finished video out of the live list. Its numbers are added to the
 * page's totals first, so stats and "best times" keep counting it.
 */
export async function archiveVideo(v: Video, timezone: string) {
  const page = pageOf(v);
  const views = (pl: Platform) => v.posts[pl]?.stats?.views ?? 0;
  const likes = Object.values(v.posts).reduce((n, p) => n + (p?.stats?.likes ?? 0), 0);
  const hasViews = Object.values(v.posts).some((p) => p?.stats?.views != null);
  // Mark first so a crash in between can never count the same video twice.
  if (!(await kv().setJSON(archiveKey(v.id), v, { onlyIfNew: true }))) {
    await kv().delete(videoKey(v.id));
    return;
  }
  await update<ArchivedStats>(pageStatsKey(page), (cur) => {
    const a = cur ?? emptyArchivedStats();
    a.count++;
    a.youtubeViews += views("youtube");
    a.instagramViews += views("instagram");
    a.likes += likes;
    if (hasViews && v.releasedAt) {
      const hour = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(new Date(v.releasedAt));
      const g = (a.byHour[`${hour}:00`] ??= { videos: 0, views: 0 });
      g.videos++;
      g.views += views("youtube") + views("instagram");
    }
    return a;
  });
  await deleteVideoFiles(v.id);
  await kv().delete(thumbKey(v.id));
  await kv().delete(videoKey(v.id));
}

/** One scheduler run. */
export async function runScheduler(budgetMs = 22000, ups: Uploaders = realUploaders, f: typeof fetch = fetch) {
  const deadline = Date.now() + budgetMs;
  return withLock("scheduler", budgetMs + 60_000, async () => {
    await checkSlots();
    const steps = await runDuePosts(deadline, ups, f);
    if (Date.now() < deadline - 3000) await maintenance(Date.now(), f, deadline);
    if (Date.now() < deadline - 3000) {
      try {
        await refreshStats(Date.now(), f, false, deadline);
      } catch (e) {
        console.warn("Stats refresh failed", e);
      }
    }
    return steps;
  });
}
