/** Time helpers: daily posting slots in the user's timezone, without extra libraries. */

export const nowISO = (d = new Date()) => d.toISOString();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local wall-clock parts of `d` in `tz`. */
export function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** Convert a local wall-clock time in `tz` to a real instant. */
export function zonedToDate(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const lp = localParts(new Date(guess), tz);
    const got = Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.mi);
    guess += want - got;
  }
  return new Date(guess);
}

export function parseSlot(s: string): [number, number] | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

export function normalizeSlots(list: string[]): string[] {
  const out = new Set<string>();
  for (const s of list) {
    const p = parseSlot(s);
    if (p) out.add(`${String(p[0]).padStart(2, "0")}:${String(p[1]).padStart(2, "0")}`);
  }
  return [...out].sort();
}

function slotMomentsAround(now: Date, slots: string[], tz: string, daysBack: number, daysFwd: number): Date[] {
  const res: Date[] = [];
  for (let off = -daysBack; off <= daysFwd; off++) {
    const day = localParts(new Date(now.getTime() + off * 86400000), tz);
    for (const s of slots) {
      const p = parseSlot(s);
      if (p) res.push(zonedToDate(day.y, day.m, day.d, p[0], p[1], tz));
    }
  }
  return res.sort((a, b) => a.getTime() - b.getTime());
}

/** Most recent slot moment <= now (looking back up to 2 days). */
export function latestSlotBefore(now: Date, slots: string[], tz: string): Date | null {
  const past = slotMomentsAround(now, slots, tz, 2, 0).filter((d) => d <= now);
  return past.length ? past[past.length - 1] : null;
}

export function nextSlotAfter(now: Date, slots: string[], tz: string): Date | null {
  return slotMomentsAround(now, slots, tz, 0, 2).find((d) => d > now) ?? null;
}

/** YouTube's daily API quota resets at midnight Pacific time. */
export function pacificDay(d = new Date()): string {
  const p = localParts(d, "America/Los_Angeles");
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export function nextQuotaReset(now = new Date()): Date {
  // The next 00:05 Pacific after now.
  for (const off of [0, 1, 2]) {
    const day = localParts(new Date(now.getTime() + off * 86400000), "America/Los_Angeles");
    const t = zonedToDate(day.y, day.m, day.d, 0, 5, "America/Los_Angeles");
    if (t > now) return t;
  }
  return new Date(now.getTime() + 86400000);
}
