import { describe, expect, it } from "vitest";
import {
  captionGroups, chooseSegment, chunkForTTS, cleanStoryText, isUsablePost, rateStory, speechBounds, splitIntoParts,
  splitSentences, videoTitle, wordCount, wordTimings,
} from "../public/js/storylib.js";

const words = (n: number, w = "word") => Array.from({ length: n }, (_, i) => `${w}${i}${i % 12 === 11 ? "." : ""}`).join(" ");

describe("story rating", () => {
  it("prefers popular, right-length stories from good subreddits", () => {
    const good = rateStory({ title: "AITA for leaving my own wedding?", selftext: words(250), score: 15000, num_comments: 4000, upvote_ratio: 0.95, subreddit: "AmItheAsshole" });
    const meh = rateStory({ title: "my day", selftext: words(60), score: 20, num_comments: 2, upvote_ratio: 0.7, subreddit: "random" });
    expect(good.rating).toBeGreaterThan(85);
    expect(good.reasons).toContain("Perfect length");
    expect(good.reasons).toContain("Viewers will judge it");
    expect(meh.rating).toBeLessThan(30);
    expect(rateStory({ title: "t", selftext: words(1000), score: 100, subreddit: "x" }).reasons).toContain("3 parts");
  });

  it("skips NSFW, removed, pinned and very short posts", () => {
    const base = { title: "t", selftext: words(200) };
    expect(isUsablePost(base)).toBe(true);
    expect(isUsablePost({ ...base, over_18: true })).toBe(false);
    expect(isUsablePost({ ...base, stickied: true })).toBe(false);
    expect(isUsablePost({ ...base, selftext: "[removed]" })).toBe(false);
    expect(isUsablePost({ ...base, selftext: words(20) })).toBe(false);
  });
});

describe("text for the voice", () => {
  it("expands Reddit shorthand, ages and removes links/markdown/swears", () => {
    const t = cleanStoryText("AITA? My MIL (54F) and I (28F) **fought**. She's an asshole. [link](https://x.com) https://y.com\nEDIT: thanks all");
    expect(t).toBe("Am I the jerk? My mother-in-law, 54 female, and I, 28 female, fought. She's a jerk. link");
    expect(cleanStoryText("what the fuck", { censor: false })).toBe("what the fuck");
    expect(cleanStoryText("what the fuck")).toBe("what the freaking");
  });

  it("splits sentences and makes chunks the voice can handle", () => {
    expect(splitSentences("Hi there. How are you?! Fine\nNext line")).toEqual(["Hi there.", "How are you?!", "Fine", "Next line"]);
    const chunks = chunkForTTS(splitSentences(words(400)), 240);
    expect(chunks.every((c) => c.length <= 241)).toBe(true);
    expect(chunks.join(" ").split(" ").length).toBe(400);
  });

  it("splits long stories into parts under the Shorts limit", () => {
    expect(splitIntoParts(words(200))).toHaveLength(1);
    const parts = splitIntoParts(words(1000));
    expect(parts.length).toBe(3);
    for (const p of parts) expect(wordCount(p) / 2.6).toBeLessThan(170);
    expect(parts.join(" ").split(" ").length).toBe(1000);
  });

  it("titles fit YouTube's 100 characters", () => {
    const t = videoTitle("x".repeat(30) + " " + "y".repeat(90), 2, 3);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.endsWith("(Part 2)")).toBe(true);
    expect(videoTitle("Short title", 1, 1)).toBe("Short title");
  });
});

describe("captions", () => {
  it("spreads words over the speech time and groups them", () => {
    const t = wordTimings("Hello there, my friend. This is fine", 1, 4);
    expect(t[0].start).toBe(1);
    expect(t.at(-1)!.end).toBeCloseTo(4);
    for (let i = 1; i < t.length; i++) expect(t[i].start).toBeCloseTo(t[i - 1].end);
    const g = captionGroups(t);
    expect(g.map((x: any) => x.words.map((w: any) => w.word).join(" "))).toEqual(["Hello there,", "my friend.", "This is fine"]);
  });

  it("finds where speech starts and ends", () => {
    const s = new Float32Array(1000);
    for (let i = 200; i < 800; i++) s[i] = 0.5;
    expect(speechBounds(s, 1000)).toEqual({ start: 0.2, end: 0.8 });
  });
});

describe("background clips", () => {
  it("picks unused minutes, and says when everything was used", () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const used: [number, number][] = [];
    for (let i = 0; i < 20; i++) {
      const { start, reused } = chooseSegment(7200, 90, used, rand);
      expect(reused).toBe(false);
      expect(start).toBeGreaterThanOrEqual(15);
      expect(start + 90).toBeLessThanOrEqual(7200 - 15);
      expect(used.some(([a, b]) => start < b && start + 90 > a)).toBe(false);
      used.push([start, start + 90]);
    }
    expect(chooseSegment(100, 90, [[0, 100]]).reused).toBe(true);
  });
});
