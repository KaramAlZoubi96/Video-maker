/**
 * Calendar: what posts when, for both pages.
 * Upcoming items are predicted the same way the scheduler works: at each daily time, the next video in the
 * queue goes out; videos with a fixed time go out at that time.
 */
import { canPost, getSettings, listVideos, pageOf } from "./queue.mts";
import { localDate, upcomingSlots } from "./time.mts";
import { type PageId, PAGE_IDS, type Video } from "./types.mts";

export interface CalendarItem {
  videoId: string;
  title: string;
  at: string;
  kind: "auto" | "fixed" | "posted" | "posting";
  approval: Video["approval"];
  uploader: string;
  warn?: string;
}

export interface CalendarPage {
  id: PageId;
  name: string;
  items: CalendarItem[];
  /** Empty daily times (no video left for them). */
  emptySlots: string[];
  /** Waiting videos that don't fit in the shown days. */
  later: number;
}

export async function buildCalendar(now = new Date(), days = 14): Promise<{ timezone: string; days: string[]; pages: CalendarPage[] }> {
  const s = await getSettings();
  const tz = s.timezone;
  const all = (await listVideos()).filter((v) => !v.deleted);
  const dayList: string[] = [];
  for (let i = -3; i < days; i++) dayList.push(localDate(new Date(now.getTime() + i * 86400000), tz));
  const since = now.getTime() - 3 * 86400000;
  const pages: CalendarPage[] = [];

  for (const id of PAGE_IDS) {
    const mine = all.filter((v) => pageOf(v) === id);
    const items: CalendarItem[] = [];
    const base = (v: Video) => ({ videoId: v.id, title: v.title, approval: v.approval ?? null, uploader: v.uploader });

    // Already posted / posting (last 3 days)
    for (const v of mine) {
      if (!v.releasedAt || Date.parse(v.releasedAt) < since) continue;
      const done = Object.values(v.posts).every((p) => p?.status === "published");
      items.push({ ...base(v), at: v.releasedAt, kind: done ? "posted" : "posting" });
    }
    const waiting = mine.filter((v) => !v.releasedAt && v.status === "ready" && v.approval !== "changes");
    // Fixed times
    for (const v of waiting.filter((x) => x.scheduledAt)) {
      items.push({ ...base(v), at: v.scheduledAt!, kind: "fixed",
        warn: !canPost(v) ? "Needs approval before this time" : Date.parse(v.scheduledAt!) < now.getTime() ? "Waiting to go out" : undefined });
    }
    // Daily times, in queue order
    const queue = waiting.filter((x) => !x.scheduledAt).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    const slots = upcomingSlots(now, s.pages[id].slots, tz, days);
    const emptySlots: string[] = [];
    let qi = 0;
    for (const slot of slots) {
      const v = queue[qi];
      if (!v) { emptySlots.push(slot.toISOString()); continue; }
      qi++;
      items.push({ ...base(v), at: slot.toISOString(), kind: "auto", warn: canPost(v) ? undefined : "Needs approval first" });
    }
    items.sort((a, b) => a.at.localeCompare(b.at));
    pages.push({ id, name: s.pages[id].name, items, emptySlots, later: Math.max(0, queue.length - qi) });
  }
  return { timezone: tz, days: dayList, pages };
}
