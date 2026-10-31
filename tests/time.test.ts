import { describe, expect, it } from "vitest";
import { latestSlotBefore, nextQuotaReset, nextSlotAfter, normalizeSlots, zonedToDate } from "../netlify/lib/time.mts";

describe("time", () => {
  it("converts local time in a timezone", () => {
    expect(zonedToDate(2026, 5, 1, 12, 0, "Asia/Jerusalem").toISOString()).toBe("2026-05-01T09:00:00.000Z");
    expect(zonedToDate(2026, 1, 1, 12, 0, "America/New_York").toISOString()).toBe("2026-01-01T17:00:00.000Z");
  });
  it("finds latest and next slots", () => {
    const tz = "Asia/Jerusalem";
    const now = zonedToDate(2026, 5, 1, 13, 0, tz);
    expect(latestSlotBefore(now, ["12:00", "19:00"], tz)!.toISOString()).toBe(zonedToDate(2026, 5, 1, 12, 0, tz).toISOString());
    expect(nextSlotAfter(now, ["12:00", "19:00"], tz)!.toISOString()).toBe(zonedToDate(2026, 5, 1, 19, 0, tz).toISOString());
    const early = zonedToDate(2026, 5, 1, 8, 0, tz);
    expect(latestSlotBefore(early, ["12:00", "19:00"], tz)!.toISOString()).toBe(zonedToDate(2026, 4, 30, 19, 0, tz).toISOString());
  });
  it("normalizes slots", () => {
    expect(normalizeSlots(["19:00", "9:05", "25:00", "x", "9:05"])).toEqual(["09:05", "19:00"]);
  });
  it("quota reset is the next 00:05 Pacific", () => {
    const now = new Date("2026-05-01T12:00:00Z"); // 05:00 PDT
    expect(nextQuotaReset(now).toISOString()).toBe("2026-05-02T07:05:00.000Z");
  });
});
