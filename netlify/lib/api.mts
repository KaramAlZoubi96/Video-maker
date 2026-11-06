/** All /api/* endpoints used by the website. */
import { randomBytes } from "node:crypto";
import * as auth from "./auth.mts";
import * as q from "./queue.mts";
import { kv } from "./store.mts";
import { isValidTimeZone, nextSlotAfter, normalizeSlots, parseLocalDateTime, parseSlot } from "./time.mts";
import { bestTimes, refreshStats } from "./stats.mts";
import { buildCalendar } from "./calendar.mts";
import * as stories from "./stories.mts";
import * as tokens from "./tokens.mts";
import {
  CHUNK_SIZE, DESC_MAX, isPageId, PAGE_IDS, type PageId, MAX_DURATION, MAX_FILE_BYTES, MIN_DURATION, type Platform, PLATFORMS, type Post, PublishError, TITLE_MAX, type Video, platformName,
} from "./types.mts";

type Ctx = { waitUntil?: (p: Promise<unknown>) => void };
type Handler = (req: Request, m: RegExpMatchArray, user: string, ctx: Ctx) => Promise<Response>;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
const fail = (error: string, status = 400) => json({ error }, status);
const redirect = (to: string, cookies: string[] = []) => {
  const h = new Headers({ Location: to, "Cache-Control": "no-store" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};
async function body(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    return {};
  }
}

export function validateText(title: string, description: string, platforms: string[]): string | null {
  if (!title.trim()) return "Please write a title.";
  if (title.length > TITLE_MAX) return `Title is too long (${title.length}/${TITLE_MAX} characters).`;
  if (/[<>]/.test(title)) return "YouTube does not allow < or > in titles.";
  if (description.length > DESC_MAX) return `Description is too long (${description.length}/${DESC_MAX} characters).`;
  if (platforms.includes("instagram") && (`${title} ${description}`.match(/#/g) || []).length > 30) {
    return "Instagram allows at most 30 hashtags.";
  }
  if (!platforms.length) return "Choose at least one platform.";
  return null;
}

const countTags = (t: string) => (t.match(/#/g) || []).length;

/** Story link must be a Reddit post; author and permission are required. */
export function validateCredit(c: any): string | null {
  const url = String(c?.url ?? "").trim();
  const author = String(c?.author ?? "").trim().replace(/^\/?u\//i, "");
  if (!/^https:\/\/((www|old|new|m)\.)?(reddit\.com\/r\/|redd\.it\/)\S+$/i.test(url)) return "Paste the link to the Reddit post (https://www.reddit.com/r/...).";
  if (!/^[A-Za-z0-9_-]{3,20}$/.test(author)) return "Write the Reddit username of the story's author (like u/someone).";
  if (c?.permission !== true) return "Tick the box to confirm the author said yes. Posting stories without permission can get your videos taken down.";
  return null;
}

export function validateVideoMeta(m: { size: number; width: number; height: number; duration: number; fileName: string }): string | null {
  if (!/\.(mp4|mov|m4v)$/i.test(m.fileName)) return "Please upload an MP4 or MOV file.";
  if (!(m.size > 0)) return "The file is empty.";
  if (m.size > MAX_FILE_BYTES) return `File is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Export it at 1080p and try again.`;
  if (!(m.width > 0 && m.height > 0)) return "Could not read the video size. Is this a video file?";
  if (m.width > m.height) return `Video is horizontal (${m.width}x${m.height}). Shorts/Reels must be vertical (9:16) or square.`;
  if (!(m.duration >= MIN_DURATION)) return `Video is too short (${(m.duration || 0).toFixed(1)}s). Minimum is ${MIN_DURATION}s.`;
  if (m.duration > MAX_DURATION) return `Video is too long (${Math.round(m.duration)}s). Maximum is ${MAX_DURATION}s.`;
  return null;
}

const expectedChunkLen = (v: Video, n: number) => (n < v.chunkCount - 1 ? v.chunkSize : v.size - v.chunkSize * (v.chunkCount - 1));

function publicVideo(v: Video) {
  const posts: Record<string, Omit<Post, "resume">> = {};
  for (const [p, post] of Object.entries(v.posts)) {
    if (post) {
      const { resume, ...rest } = post;
      posts[p] = rest;
    }
  }
  return { ...v, posts };
}

// ---- routes -----------------------------------------------------------------
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path}$`), h]);

route("GET", "/api/dashboard", async (_req, _m, user) => {
  const s = await q.getSettings();
  const all = await q.listVideos();
  const pages = [];
  const problems: string[] = [];
  for (const id of PAGE_IDS) {
    const mine = all.filter((v) => q.pageOf(v) === id);
    const unfinished = mine.filter((v) => !v.releasedAt && v.status !== "ready");
    const queued = mine.filter((v) => !v.releasedAt && v.status === "ready").sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const released = mine.filter((v) => v.releasedAt);
    const isDone = (v: Video) => Object.values(v.posts).every((p) => p?.status === "published");
    const done = released.filter(isDone).sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
    const active = released.filter((v) => !isDone(v)).sort((a, b) => (a.releasedAt ?? "").localeCompare(b.releasedAt ?? ""));
    const next = nextSlotAfter(new Date(), s.pages[id].slots, s.timezone);
    const accounts: Record<string, string | null> = {};
    for (const p of PLATFORMS) accounts[p] = (await tokens.getAccount(id, p))?.displayName ?? null;
    problems.push(...(await tokens.accountProblems(id, s.pages[id].name)));
    const sum = (pl: "youtube" | "instagram", k: "views" | "likes") => done.reduce((n, v) => n + (v.posts[pl]?.stats?.[k] ?? 0), 0);
    const old = await q.getArchivedStats(id);
    pages.push({
      id, name: s.pages[id].name, nextSlot: next?.toISOString() ?? null, accounts, publishedCount: done.length + old.count,
      hashtags: s.pages[id].hashtags ?? "", needsCredit: Boolean(s.pages[id].needsCredit),
      totals: { youtubeViews: sum("youtube", "views") + old.youtubeViews, instagramViews: sum("instagram", "views") + old.instagramViews,
        likes: sum("youtube", "likes") + sum("instagram", "likes") + old.likes },
      bestTimes: bestTimes(done, s.timezone, old.byHour), lastStatsRun: s.lastStatsRun ?? null,
      queued: queued.map(publicVideo), active: active.map(publicVideo), done: done.slice(0, 30).map(publicVideo),
      unfinished: unfinished.map(publicVideo),
    });
  }
  // Videos waiting for THIS user's approval (made by someone else).
  const toApprove = all.filter((v) => v.approval === "pending" && !v.releasedAt && !v.deleted && v.uploader !== user).length;
  return json({ pages, timezone: s.timezone, problems, toApprove, me: user, requireApproval: s.requireApproval !== false });
});

route("POST", "/api/videos", async (req, _m, user) => {
  const b = await body(req);
  const platforms = PLATFORMS.filter((p) => b.platforms?.includes(p));
  const title = String(b.title ?? ""), description = String(b.description ?? "");
  const meta = {
    size: Number(b.size), width: Number(b.width), height: Number(b.height), duration: Number(b.duration),
    fileName: String(b.fileName ?? ""),
  };
  if (!isPageId(b.pageId)) return fail("Choose which page this video is for.");
  const page = (await q.getSettings()).pages[b.pageId as PageId];
  const err = validateText(title, description, platforms) ?? validateVideoMeta(meta)
    ?? (page.needsCredit ? validateCredit(b.credit) : null);
  if (err) return fail(err);
  if (platforms.includes("instagram") && countTags(`${title} ${description} ${page.hashtags ?? ""}`) > 30) {
    return fail(`Too many hashtags for Instagram (max 30, including this page's saved hashtags: ${page.hashtags}).`);
  }
  // Same file uploaded twice to the same page? Ask before queueing it again.
  if (!b.allowDuplicate) {
    const twin = (await q.listVideos()).find((x) => q.pageOf(x) === b.pageId && x.status === "ready"
      && x.size === meta.size && Math.abs(x.duration - meta.duration) < 0.2);
    if (twin) {
      return json({ duplicate: true, error: `This looks like a video you already uploaded: "${twin.title}". Upload it again anyway?` }, 409);
    }
  }
  const credit = page.needsCredit ? {
    url: String(b.credit.url).trim(), author: String(b.credit.author).trim().replace(/^\/?u\//i, ""), permission: true,
  } : null;
  const id = `${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  const posts: Video["posts"] = {};
  for (const p of platforms) posts[p] = { status: "pending", attempts: 0, resume: {} };
  const video: Video = {
    id, uploader: user, fileName: meta.fileName.slice(0, 200), title: title.trim(), description: description.trim(),
    size: meta.size, chunkSize: CHUNK_SIZE, chunkCount: Math.ceil(meta.size / CHUNK_SIZE),
    width: meta.width, height: meta.height, duration: meta.duration, status: "uploading", position: 0,
    createdAt: now, posts, pageId: b.pageId, credit,
    storyId: typeof b.storyId === "string" && /^[a-z0-9_]{3,20}$/.test(b.storyId) ? b.storyId : null,
  };
  await kv().setJSON(q.videoKey(id), video);
  if (typeof b.thumbnail === "string" && b.thumbnail.startsWith("data:image/jpeg;base64,") && b.thumbnail.length < 300_000) {
    await kv().setBytes(q.thumbKey(id), new Uint8Array(Buffer.from(b.thumbnail.split(",")[1], "base64")));
  }
  return json({ id, chunkSize: CHUNK_SIZE, chunkCount: video.chunkCount });
});

route("PUT", "/api/videos/([a-z0-9]+)/chunks/(\\d+)", async (req, m) => {
  const v = await q.getVideo(m[1]);
  if (!v) return fail("Upload not found. Please start again.", 404);
  if (v.status !== "uploading") return json({ ok: true }); // already complete
  const n = Number(m[2]);
  if (n >= v.chunkCount) return fail("Bad chunk number.");
  const data = new Uint8Array(await req.arrayBuffer());
  if (data.length !== expectedChunkLen(v, n)) return fail(`Piece ${n + 1} arrived damaged (${data.length} bytes). Retrying…`, 422);
  if (n === 0) {
    const sig = new TextDecoder().decode(data.subarray(4, 8));
    if (sig !== "ftyp") return fail("This doesn't look like an MP4/MOV video. Export it as MP4 and try again.");
  }
  await kv().setBytes(q.chunkKey(v.id, n), data);
  return json({ ok: true });
});

route("POST", "/api/videos/([a-z0-9]+)/complete", async (_req, m) => {
  const v = await q.getVideo(m[1]);
  if (!v) return fail("Upload not found. Please start again.", 404);
  if (v.status === "ready") return json({ ok: true });
  const have = new Set(await kv().list(`chunks/${v.id}/`));
  const missing = [];
  for (let n = 0; n < v.chunkCount; n++) if (!have.has(q.chunkKey(v.id, n))) missing.push(n);
  if (missing.length) return json({ error: "Some pieces are missing.", missing }, 409);
  const maxPos = Math.max(0, ...(await q.listVideos()).filter((x) => q.pageOf(x) === q.pageOf(v)).map((x) => x.position));
  // With 2+ users and approval on, a new video waits until the other person approves it.
  const needsApproval = (await q.getSettings()).requireApproval !== false && (await auth.userCount()) > 1;
  await q.updateVideo(v.id, (x) => {
    x.status = "ready";
    x.position = maxPos + 1;
    x.approval = needsApproval ? "pending" : "approved";
    return true;
  });
  if (v.storyId) {
    await stories.updateStory(v.storyId, (s) => {
      if (!s.videoIds.includes(v.id)) s.videoIds.push(v.id);
      s.status = "queued";
      return true;
    });
  }
  return json({ ok: true });
});

route("GET", "/api/thumb/([a-z0-9]+)", async (_req, m) => {
  const bytes = await kv().getBytes(q.thumbKey(m[1]));
  if (!bytes) return new Response("", { status: 404 });
  return new Response(bytes.slice().buffer as ArrayBuffer, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
});

route("POST", "/api/videos/([a-z0-9]+)/edit", async (req, m) => {
  const b = await body(req);
  const v = await q.getVideo(m[1]);
  if (!v) return fail("Video not found.", 404);
  const title = String(b.title ?? ""), description = String(b.description ?? "");
  const err = validateText(title, description, Object.keys(v.posts));
  if (err) return fail(err);
  const pageTags = (await q.getSettings()).pages[q.pageOf(v)].hashtags ?? "";
  if (v.posts.instagram && countTags(`${title} ${description} ${pageTags}`) > 30) {
    return fail(`Too many hashtags for Instagram (max 30, including this page's saved hashtags: ${pageTags}).`);
  }
  if (v.releasedAt) return fail("This video already started posting, so its text can't change.");
  await q.updateVideo(v.id, (x) => {
    if (x.releasedAt) return false;
    x.title = title.trim();
    x.description = description.trim();
    if (x.approval === "changes") x.approval = "pending"; // fixed → ask again
    return true;
  });
  return json({ ok: true, message: "Saved." });
});

route("POST", "/api/videos/([a-z0-9]+)/delete", async (_req, m) => {
  const v = await q.getVideo(m[1]);
  if (!v) return json({ ok: true });
  // Step 1: mark it deleted (the scheduler checks this before every step). Step 2: remove it.
  await q.updateVideo(v.id, (x) => { x.deleted = true; return true; });
  await kv().delete(q.videoKey(v.id));
  await q.deleteVideoFiles(v.id);
  await kv().delete(q.thumbKey(v.id));
  return json({ ok: true, message: "Video removed. (Already-published posts stay online.)" });
});

route("POST", "/api/videos/([a-z0-9]+)/move", async (req, m) => {
  const dir = Number((await body(req)).direction) < 0 ? -1 : 1;
  const me = await q.getVideo(m[1]);
  if (!me) return json({ ok: true });
  const queue = (await q.listVideos()).filter((v) => !v.releasedAt && q.pageOf(v) === q.pageOf(me)).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
  const i = queue.findIndex((v) => v.id === m[1]);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= queue.length) return json({ ok: true });
  // Renumber the whole queue so positions are always unique.
  [queue[i], queue[j]] = [queue[j], queue[i]];
  for (let k = 0; k < queue.length; k++) {
    if (queue[k].position !== k + 1) await q.updateVideo(queue[k].id, (x) => { x.position = k + 1; return true; });
  }
  return json({ ok: true });
});

route("POST", "/api/videos/([a-z0-9]+)/post-now", async (_req, m, _u, ctx) => {
  const v = await q.getVideo(m[1]);
  if (!v || v.status !== "ready") return fail("This video isn't ready yet.");
  if (!q.canPost(v)) return fail("This video is waiting for approval. The other person needs to tap ✅ Approve first.");
  const missing = await q.missingPlatforms(v);
  if (missing.length) return fail(`Connect ${missing.map(platformName).join(" and ")} for "${await q.pageName(q.pageOf(v))}" in Settings first.`);
  if (!(await q.releaseVideo(v.id))) return fail("This video already started posting.");
  ctx.waitUntil?.(q.runScheduler(20000).catch((e) => console.error(e)));
  return json({ ok: true, message: "Posting started. It updates here every few seconds." });
});

route("POST", "/api/videos/([a-z0-9]+)/retry/(youtube|instagram)", async (_req, m, _u, ctx) => {
  const platform = m[2] as Platform;
  const v = await q.getVideo(m[1]);
  if (!v?.posts[platform] || v.posts[platform]!.status !== "failed") return json({ ok: true });
  if (!(await tokens.platformReady(q.pageOf(v), platform))) return fail(`Connect ${platformName(platform)} for "${await q.pageName(q.pageOf(v))}" in Settings first.`);
  await q.updateVideo(v.id, (x) => {
    const p = x.posts[platform];
    if (!p || p.status !== "failed") return false;
    x.posts[platform] = { ...p, status: "pending", attempts: 0, nextAttemptAt: null, note: "Retry requested" };
    x.releasedAt = x.releasedAt ?? new Date().toISOString();
    return true;
  });
  ctx.waitUntil?.(q.runScheduler(20000).catch((e) => console.error(e)));
  return json({ ok: true, message: "Retrying now." });
});

// ---- settings ---------------------------------------------------------------
route("GET", "/api/settings", async () => {
  const s = await q.getSettings();
  const pages = [];
  for (const id of PAGE_IDS) {
    const accounts: Record<string, unknown> = {};
    for (const p of PLATFORMS) {
      const a = await tokens.getAccount(id, p);
      accounts[p] = a ? { displayName: a.displayName, status: a.status, error: a.error, tokenExpiresAt: a.tokenExpiresAt } : null;
    }
    pages.push({ id, name: s.pages[id].name, slots: s.pages[id].slots, hashtags: s.pages[id].hashtags ?? "",
      needsCredit: Boolean(s.pages[id].needsCredit), accounts });
  }
  return json({
    timezone: s.timezone, youtubePrivacy: s.youtubePrivacy, addShortsTag: s.addShortsTag, pages,
    requireApproval: s.requireApproval !== false,
    users: await auth.listUsers(),
    youtubeConfigured: tokens.youtubeConfigured(), instagramOAuthConfigured: tokens.instagramOAuthConfigured(),
    redirectYoutube: tokens.redirectUri("youtube"), redirectInstagram: tokens.redirectUri("instagram"),
  });
});

/** Save general settings (timezone, YouTube visibility, #Shorts). */
route("POST", "/api/settings", async (req) => {
  const b = await body(req);
  if (!isValidTimeZone(String(b.timezone))) return fail("Unknown timezone.");
  const privacy = ["public", "unlisted", "private"].includes(b.youtubePrivacy) ? b.youtubePrivacy : "public";
  await q.updateSettings((s) => {
    // Times that already passed today in the new timezone are not "missed".
    if (s.timezone !== String(b.timezone)) for (const id of PAGE_IDS) s.pages[id].lastSlotRun = new Date().toISOString();
    s.timezone = String(b.timezone);
    s.youtubePrivacy = privacy;
    s.addShortsTag = Boolean(b.addShortsTag);
    if (typeof b.requireApproval === "boolean") s.requireApproval = b.requireApproval;
  });
  return json({ ok: true, message: "Settings saved." });
});

/** Save one page's name and posting times. */
route("POST", "/api/pages/(p1|p2)", async (req, m) => {
  const id = m[1] as PageId;
  const b = await body(req);
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 40) return fail("Page name: 1-40 characters.");
  const parts = String(b.slots ?? "").split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  const bad = parts.find((p) => !parseSlot(p));
  if (bad) return fail(`'${bad}' is not a time. Use 24h format like 12:00, 19:30.`);
  const slots = normalizeSlots(parts);
  const hashtags = String(b.hashtags ?? "").trim().split(/\s+/).filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`)).join(" ");
  if (hashtags.length > 500) return fail("Saved hashtags are too long (max 500 characters).");
  if (countTags(hashtags) > 20) return fail("Keep saved hashtags to 20 or fewer (Instagram allows 30 per post in total).");
  await q.updateSettings((s) => {
    const timesChanged = s.pages[id].slots.join() !== slots.join();
    s.pages[id] = { ...s.pages[id], name, slots, hashtags, needsCredit: Boolean(b.needsCredit) };
    // New times start counting from now, so a time earlier today doesn't post right away.
    if (timesChanged) s.pages[id].lastSlotRun = new Date().toISOString();
  });
  return json({ ok: true, message: `"${name}" saved.` + (slots.length ? "" : " No times set: this page only posts with 'Post now'.") });
});

route("POST", "/api/users", async (req) => {
  const b = await body(req);
  const err = await auth.createUser(String(b.username ?? ""), String(b.password ?? ""));
  if (err) return fail(err);
  return json({ ok: true, message: `User '${String(b.username).trim()}' added. Send them the website link and their password.` });
});

route("POST", "/api/password", async (req, _m, user) => {
  const b = await body(req);
  const r = await auth.authenticate(user, String(b.current ?? ""));
  if (!r.ok) return fail(r.error === "Wrong username or password." ? "Current password is wrong." : r.error);
  const err = auth.validateNewUser(user, String(b.new ?? ""));
  if (err) return fail(err);
  await auth.setPassword(user, String(b.new));
  // Other devices are logged out; this one gets a fresh login.
  return json({ ok: true, message: "Password changed. Other devices are logged out." }, 200, { "Set-Cookie": await auth.sessionCookie(req, user) });
});

route("POST", "/api/stats/refresh", async () => {
  const n = await refreshStats(Date.now(), fetch, true);
  return json({ ok: true, message: n ? `Updated numbers for ${n} posts.` : "No posted videos to update yet." });
});

// ---- approval -------------------------------------------------------------------
route("POST", "/api/videos/([a-z0-9]+)/approve", async (req, m, user) => {
  const b = await body(req);
  const decision = b.decision === "changes" ? "changes" : "approved";
  const note = String(b.note ?? "").trim().slice(0, 500);
  if (decision === "changes" && !note) return fail("Write what should change.");
  const v = await q.getVideo(m[1]);
  if (!v) return fail("Video not found.", 404);
  if (v.releasedAt) return fail("This video already started posting.");
  await q.updateVideo(v.id, (x) => {
    x.approval = decision;
    x.approvedBy = user;
    x.approvalNote = decision === "changes" ? note : null;
    return true;
  });
  return json({ ok: true, message: decision === "approved" ? "Approved ✅ It will post at its time." : "Sent back with your note." });
});

// ---- fixed date/time (calendar) ----------------------------------------------------
route("POST", "/api/videos/([a-z0-9]+)/schedule", async (req, m) => {
  const b = await body(req);
  const v = await q.getVideo(m[1]);
  if (!v) return fail("Video not found.", 404);
  if (v.releasedAt) return fail("This video already started posting.");
  let at: string | null = null;
  if (b.at) {
    const tz = (await q.getSettings()).timezone;
    const d = typeof b.at === "string" && /Z$|[+-]\d\d:\d\d$/.test(b.at) ? new Date(b.at) : parseLocalDateTime(String(b.at), tz);
    if (!d || Number.isNaN(d.getTime())) return fail("That isn't a valid date and time.");
    if (d.getTime() < Date.now() - 60_000) return fail("Pick a time in the future.");
    if (d.getTime() > Date.now() + 90 * 86400000) return fail("Pick a time within the next 90 days.");
    at = d.toISOString();
  }
  await q.updateVideo(v.id, (x) => { x.scheduledAt = at; return true; });
  return json({ ok: true, message: at ? "Time saved. It posts then (once approved)." : "Back to the page's daily times." });
});

route("GET", "/api/calendar", async (req) => {
  const days = Math.min(28, Math.max(7, Number(new URL(req.url).searchParams.get("days")) || 14));
  return json(await buildCalendar(new Date(), days));
});

// ---- watch a video (in small pieces, so phones can play it) --------------------------
route("GET", "/api/videos/([a-z0-9]+)/file", async (req, m) => {
  const v = await q.getVideo(m[1]);
  if (!v || v.status !== "ready" || v.filesDeleted) return new Response("Not available", { status: 404 });
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.get("range") ?? "");
  const start = range ? Number(range[1]) : 0;
  if (start >= v.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${v.size}` } });
  // Send at most one stored piece per request (Netlify responses must stay under ~6 MB); browsers ask for the rest.
  const chunkEnd = (Math.floor(start / v.chunkSize) + 1) * v.chunkSize - 1;
  const wanted = range && range[2] ? Number(range[2]) : v.size - 1;
  const end = Math.min(wanted, chunkEnd, v.size - 1);
  const bytes = await q.readRange(v, start, end - start + 1);
  return new Response(bytes, {
    status: 206,
    headers: { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${v.size}`,
      "Content-Length": String(end - start + 1), "Cache-Control": "private, max-age=3600" },
  });
});

// ---- stories ------------------------------------------------------------------
route("GET", "/api/stories", async () => {
  const all = await stories.listStories();
  const order = stories.STORY_STATUSES;
  all.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.rating - a.rating);
  return json({ stories: all });
});

route("POST", "/api/stories/import", async (req, _m, user) => {
  const b = await body(req);
  if (!Array.isArray(b.stories) || !b.stories.length) return fail("Tick at least one story.");
  const r = await stories.importStories(b.stories, user);
  if (r.error) return fail(r.error);
  return json({ ok: true, ...r, message: `Saved ${r.added} ${r.added === 1 ? "story" : "stories"}${r.skipped ? ` (${r.skipped} were already saved or not usable)` : ""}.` });
});

route("POST", "/api/stories/([a-z0-9_]+)", async (req, m, user) => {
  const b = await body(req);
  if (b.status !== undefined && !stories.STORY_STATUSES.includes(b.status)) return fail("Unknown story status.");
  if (!(await stories.getStory(m[1]))) return fail("Story not found.", 404);
  const s = await stories.updateStory(m[1], (x) => {
    if (b.status !== undefined) x.status = b.status;
    if (b.pick === true) x.pickedBy = user;
    if (b.pick === false) x.pickedBy = null;
    if (typeof b.title === "string" && b.title.trim()) x.title = b.title.trim().slice(0, 300);
    if (typeof b.body === "string" && b.body.trim().length >= 50) x.body = b.body.trim().slice(0, 40000);
    if (typeof b.note === "string") x.note = b.note.trim().slice(0, 500) || null;
    return true;
  });
  if (!s) return fail("Story not found.", 404);
  return json({ ok: true, story: s });
});

route("POST", "/api/stories/([a-z0-9_]+)/delete", async (_req, m) => {
  await stories.deleteStory(m[1]);
  return json({ ok: true, message: "Story removed from the board." });
});

route("GET", "/api/stories/([a-z0-9_]+)", async (_req, m) => {
  const s = await stories.getStory(m[1]);
  return s ? json({ story: s }) : fail("Story not found.", 404);
});

// ---- background clips: which minutes were already used ---------------------------
route("GET", "/api/backgrounds/used", async (req) => {
  const key = new URL(req.url).searchParams.get("key") ?? "";
  if (!key) return fail("Missing key.");
  return json({ ranges: await stories.getUsedRanges(key) });
});

route("POST", "/api/backgrounds/used", async (req) => {
  const b = await body(req);
  if (!b.key) return fail("Missing key.");
  if (b.clear) await stories.clearUsedRanges(String(b.key));
  else await stories.addUsedRange(String(b.key), Number(b.start), Number(b.end));
  return json({ ok: true });
});

// ---- accounts -----------------------------------------------------------------
route("GET", "/api/connect/(p1|p2)/(youtube|instagram)", async (req, m) => {
  const page = m[1] as PageId, p = m[2] as Platform;
  if (p === "youtube" && !tokens.youtubeConfigured()) return redirect("/settings.html?error=" + encodeURIComponent("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Netlify environment variables first."));
  if (p === "instagram" && !tokens.instagramOAuthConfigured()) return redirect("/settings.html?error=" + encodeURIComponent("Add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET in Netlify, or paste a token instead."));
  const state = randomBytes(24).toString("base64url");
  const cookie = auth.cookieHeader(req, "sap_oauth", await auth.sign({ state, p, page, exp: Date.now() + 15 * 60_000 }), 900);
  return redirect(p === "youtube" ? tokens.youtubeAuthUrl(state) : tokens.instagramAuthUrl(state), [cookie]);
});

route("GET", "/api/connect/(youtube|instagram)/callback", async (req, m) => {
  const p = m[1] as Platform;
  const url = new URL(req.url);
  const clear = auth.cookieHeader(req, "sap_oauth", "", 0);
  const back = (k: "msg" | "error", text: string) => redirect(`/settings.html?${k}=${encodeURIComponent(text)}`, [clear]);
  const saved = await auth.verify<{ state: string; p: string; page: string }>(auth.getCookie(req, "sap_oauth"));
  if (url.searchParams.get("error")) return back("error", `Connection cancelled: ${url.searchParams.get("error_description") || url.searchParams.get("error")}`);
  const code = url.searchParams.get("code");
  if (!code || !saved || saved.p !== p || !isPageId(saved.page) || saved.state !== url.searchParams.get("state")) {
    return back("error", "Connection failed (security check). Please try again.");
  }
  const page = saved.page;
  try {
    const name = p === "youtube"
      ? await tokens.youtubeFinishConnect(page, code, q.pageName)
      : await tokens.instagramFinishConnect(page, code, q.pageName);
    return back("msg", `Connected ${name} to "${await q.pageName(page)}".`);
  } catch (e: any) {
    return back("error", `Could not connect: ${e?.message ?? e}`);
  }
});

route("POST", "/api/connect/(p1|p2)/instagram/token", async (req, m) => {
  const page = m[1] as PageId;
  const token = String((await body(req)).token ?? "").trim();
  if (!token) return fail("Paste the token first.");
  try {
    const name = await tokens.instagramConnectWithToken(page, token, q.pageName);
    return json({ ok: true, message: `Connected ${name} to "${await q.pageName(page)}".` });
  } catch (e: any) {
    return fail(`Could not connect: ${e?.message ?? e}`);
  }
});

route("POST", "/api/disconnect/(p1|p2)/(youtube|instagram)", async (_req, m) => {
  await tokens.disconnect(m[1] as PageId, m[2] as Platform);
  return json({ ok: true, message: "Disconnected." });
});

// ---- entry ------------------------------------------------------------------
export async function handle(req: Request, ctx: Ctx = {}): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, "");
  try {
    if (!auth.sameOrigin(req)) return fail("Request blocked (wrong origin).", 403);

    // Public endpoints
    if (path === "/api/me" && req.method === "GET") {
      const user = await auth.currentUser(req);
      const pages = user ? Object.entries((await q.getSettings()).pages).map(([id, p]) => ({ id, name: p.name })) : [];
      return json({ user, needsSetup: !user && (await auth.userCount()) === 0, pages });
    }
    if (path === "/api/setup" && req.method === "POST") {
      if ((await auth.userCount()) > 0) return fail("Setup is already done. Please log in.", 403);
      const b = await body(req);
      const err = await auth.createUser(String(b.username ?? ""), String(b.password ?? ""));
      if (err) return fail(err);
      // Use the first person's own timezone for posting times (can be changed in Settings).
      if (isValidTimeZone(String(b.timezone ?? ""))) await q.updateSettings((s) => { s.timezone = String(b.timezone); });
      return json({ ok: true }, 200, { "Set-Cookie": await auth.sessionCookie(req, String(b.username).trim()) });
    }
    if (path === "/api/login" && req.method === "POST") {
      const b = await body(req);
      const r = await auth.authenticate(String(b.username ?? ""), String(b.password ?? ""));
      if (!r.ok) return fail(r.error, 401);
      return json({ ok: true }, 200, { "Set-Cookie": await auth.sessionCookie(req, r.username) });
    }
    if (path === "/api/logout" && req.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": auth.clearSessionCookie(req) });
    }

    const user = await auth.currentUser(req);
    for (const [method, re, h] of routes) {
      const m = path.match(re);
      if (!m || method !== req.method) continue;
      if (!user) {
        return req.method === "GET" && path.startsWith("/api/connect") ? redirect("/login.html") : fail("Please log in again.", 401);
      }
      return await h(req, m, user, ctx);
    }
    return fail("Not found.", 404);
  } catch (e: any) {
    console.error(e);
    const msg = e instanceof PublishError ? e.message : "Something went wrong on the server. Please try again.";
    return fail(msg, 500);
  }
}
