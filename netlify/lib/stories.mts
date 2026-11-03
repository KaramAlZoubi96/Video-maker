/**
 * Story board: Reddit stories the two of you picked, shared between you.
 * Stories are found in the browser (the Story Finder bookmark runs on reddit.com while you're logged in,
 * because Reddit blocks most automatic access since 2026), rated there, and the ones you tick are saved here.
 */
import { getJSON, kv, update } from "./store.mts";

export type StoryStatus = "new" | "asked" | "allowed" | "made" | "queued" | "skipped";
export const STORY_STATUSES: StoryStatus[] = ["new", "asked", "allowed", "made", "queued", "skipped"];

export interface Story {
  id: string;
  subreddit: string;
  author: string;
  title: string;
  body: string;
  url: string;
  score: number;
  comments: number;
  rating: number;
  reasons: string[];
  createdUtc: number | null;
  status: StoryStatus;
  addedBy: string;
  addedAt: string;
  updatedAt: string;
  /** Who is working on it (so you don't both make the same video). */
  pickedBy?: string | null;
  note?: string | null;
  videoIds: string[];
}

const MAX_STORIES = 400;
export const storyKey = (id: string) => `stories/${id}`;

const str = (x: unknown, max: number) => String(x ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const num = (x: unknown) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** Only accept clean data from the browser. Returns null if the story is unusable. */
export function sanitizeStory(raw: any, user: string): Story | null {
  const id = str(raw?.id, 20).toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(id)) return null;
  const title = str(raw?.title, 300);
  const body = str(raw?.body, 40000);
  if (!title || body.length < 50) return null;
  const sub = str(raw?.subreddit, 50).replace(/^\/?r\//i, "");
  const author = str(raw?.author, 40).replace(/^\/?u\//i, "");
  let url = str(raw?.url, 400);
  if (!/^https:\/\/(www\.|old\.)?reddit\.com\/r\//i.test(url)) url = sub ? `https://www.reddit.com/r/${sub}/comments/${id.replace(/^m_/, "")}/` : "";
  const now = new Date().toISOString();
  return {
    id, subreddit: sub, author, title, body, url,
    score: Math.max(0, Math.round(num(raw?.score))),
    comments: Math.max(0, Math.round(num(raw?.comments))),
    rating: Math.min(100, Math.max(0, Math.round(num(raw?.rating)))),
    reasons: Array.isArray(raw?.reasons) ? raw.reasons.slice(0, 8).map((r: unknown) => str(r, 60)) : [],
    createdUtc: raw?.createdUtc ? num(raw.createdUtc) : null,
    status: "new", addedBy: user, addedAt: now, updatedAt: now, pickedBy: null, note: null, videoIds: [],
  };
}

export async function listStories(): Promise<Story[]> {
  const keys = await kv().list("stories/");
  const docs = await Promise.all(keys.map((k) => getJSON<Story>(k)));
  return docs.filter((s): s is Story => Boolean(s));
}

export const getStory = (id: string) => getJSON<Story>(storyKey(id));

/** Save picked stories. Already-saved stories are left alone. Returns how many were new. */
export async function importStories(raw: unknown[], user: string): Promise<{ added: number; skipped: number; error?: string }> {
  const existing = new Set((await kv().list("stories/")).map((k) => k.slice("stories/".length)));
  if (existing.size >= MAX_STORIES) return { added: 0, skipped: raw.length, error: `The board is full (${MAX_STORIES} stories). Remove old ones first.` };
  let added = 0, skipped = 0;
  for (const r of raw.slice(0, 100)) {
    const s = sanitizeStory(r, user);
    if (!s || existing.has(s.id) || existing.size + added >= MAX_STORIES) { skipped++; continue; }
    if (await kv().setJSON(storyKey(s.id), s, { onlyIfNew: true })) added++;
    else skipped++;
  }
  return { added, skipped };
}

export async function updateStory(id: string, fn: (s: Story) => boolean): Promise<Story | null> {
  return update<Story>(storyKey(id), (cur) => {
    if (!cur || !fn(cur)) return undefined;
    cur.updatedAt = new Date().toISOString();
    return cur;
  });
}

export async function deleteStory(id: string) {
  await kv().delete(storyKey(id));
}

// ---- background clips: remember which minutes were already used --------------
export interface UsedRanges { ranges: [number, number][] }
export const bgKey = (key: string) => `bgused/${key.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120)}`;

export async function getUsedRanges(key: string): Promise<[number, number][]> {
  return (await getJSON<UsedRanges>(bgKey(key)))?.ranges ?? [];
}

export async function addUsedRange(key: string, start: number, end: number) {
  if (!(end > start) || start < 0 || end - start > 4 * 3600) return;
  await update<UsedRanges>(bgKey(key), (cur) => {
    const ranges = (cur?.ranges ?? []).slice(-500);
    ranges.push([Math.round(start * 10) / 10, Math.round(end * 10) / 10]);
    return { ranges };
  });
}

export async function clearUsedRanges(key: string) {
  await kv().delete(bgKey(key));
}
