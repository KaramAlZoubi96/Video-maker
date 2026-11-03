// Story logic shared by the Stories page and the Video Maker. Plain JS (runs in the browser, tested with vitest).

/** Subreddits that work best for story videos (from research: drama, judgement and payoff). */
export const STORY_SUBREDDITS = [
  "AmItheAsshole", "AITAH", "pettyrevenge", "ProRevenge", "MaliciousCompliance", "tifu",
  "entitledparents", "ChoosingBeggars", "relationship_advice", "TrueOffMyChest", "confessions", "BestofRedditorUpdates",
];
const BONUS_SUBS = new Set(["amitheasshole", "aitah", "pettyrevenge", "prorevenge", "maliciouscompliance", "entitledparents", "tifu", "choosingbeggars"]);
const HOOK_WORDS = /\b(revenge|caught|wedding|boss|ex|cheat\w*|mother[- ]in[- ]law|mil|sister|brother|dad|mom|landlord|neighbou?r|karen|fired|lied|secret|refused|banned|inheritance|divorce|pregnan\w*)\b/i;

/** Narration speed: about 2.6 words per second at speed 1.0. */
export const WORDS_PER_SECOND = 2.6;
export const MAX_PART_SECONDS = 170; // YouTube Shorts max is 3 min; keep a safety margin

export const wordCount = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
export const estimateSeconds = (words, speed = 1) => Math.round(words / (WORDS_PER_SECOND * speed));

/** Is this Reddit post usable as a story? */
export function isUsablePost(p) {
  if (!p || !p.title || !p.selftext) return false;
  if (p.over_18 || p.stickied || p.removed || p.removed_by_category) return false;
  if (/^\[(removed|deleted)\]$/i.test(p.selftext.trim())) return false;
  return wordCount(p.selftext) >= 80;
}

/** Score 0-100 + plain-English reasons. Popular, engaging, right length, good subreddit, strong hook. */
export function rateStory(p) {
  const reasons = [];
  let r = 0;
  const score = Number(p.score) || 0, comments = Number(p.num_comments ?? p.comments) || 0;
  const words = wordCount(p.selftext ?? p.body);
  const secs = estimateSeconds(words);
  // Popularity: up to 40 points (10k+ upvotes = full)
  const pop = Math.min(1, Math.log10(score + 1) / 4);
  r += pop * 40;
  if (score >= 5000) reasons.push("Very popular");
  else if (score >= 1000) reasons.push("Popular");
  // Upvote ratio
  if ((p.upvote_ratio ?? 0) >= 0.9) { r += 8; reasons.push("People loved it"); }
  // Drama: many comments per upvote
  if (score > 0 && comments / score >= 0.25) { r += 10; reasons.push("Lots of discussion"); }
  else if (comments >= 300) { r += 6; }
  // Length: perfect = one video of 40-170 seconds
  if (secs >= 40 && secs <= MAX_PART_SECONDS) { r += 25; reasons.push("Perfect length"); }
  else if (secs > MAX_PART_SECONDS && secs <= MAX_PART_SECONDS * 3) { r += 12; reasons.push(`${Math.ceil(secs / MAX_PART_SECONDS)} parts`); }
  else if (secs < 40) reasons.push("Very short");
  else reasons.push("Very long");
  // Subreddit & hook
  if (BONUS_SUBS.has(String(p.subreddit || "").toLowerCase())) { r += 10; }
  if (/^(aita|wibta|aitah)\b/i.test(p.title) || /\?$/.test(p.title.trim())) { r += 4; reasons.push("Viewers will judge it"); }
  if (HOOK_WORDS.test(p.title)) { r += 3; reasons.push("Strong hook"); }
  return { rating: Math.round(Math.min(100, r)), reasons, words, estSeconds: secs };
}

export const stars = (rating) => "★★★★★".slice(0, Math.max(1, Math.round(rating / 20))) + "☆☆☆☆☆".slice(0, 5 - Math.max(1, Math.round(rating / 20)));

// ---- text for the voice ------------------------------------------------------
const ACRONYMS = [
  [/\bAITAH?\b/g, "Am I the jerk"], [/\bWIBTA\b/g, "Would I be the jerk"], [/\bTIFU\b/g, "Today I messed up"],
  [/\bNTA\b/g, "not the jerk"], [/\bYTA\b/g, "you're the jerk"], [/\bESH\b/g, "everyone sucks here"],
  [/\bTL;?DR\b:?/gi, "In short,"], [/\bMIL\b/g, "mother-in-law"], [/\bFIL\b/g, "father-in-law"], [/\bSIL\b/g, "sister-in-law"],
  [/\bBIL\b/g, "brother-in-law"], [/\bDH\b/g, "my husband"], [/\bBF\b/g, "boyfriend"], [/\bGF\b/g, "girlfriend"],
  [/\bSO\b/g, "partner"], [/\bLMAO\b/gi, "haha"], [/\bLOL\b/g, "haha"], [/\bIDK\b/gi, "I don't know"], [/\bIMO\b/gi, "in my opinion"],
  [/\bOP\b/g, "the poster"], [/\bw\/o\b/gi, "without"], [/\bw\/\b/gi, "with"],
];
// Swear words hurt YouTube monetization; these swaps are common in story channels.
const CLEAN_WORDS = [
  [/\ban (ass+hole)\b/gi, "a jerk"], [/\bass+holes?\b/gi, (m) => (m.toLowerCase().endsWith("s") ? "jerks" : "jerk")], [/\bf+u+c+k+(ing|ed|er|s)?\b/gi, "freaking"],
  [/\bsh[i1]t+(ty|s)?\b/gi, "crap"], [/\bbitch(es|y)?\b/gi, "witch"], [/\bdamn\b/gi, "dang"], [/\bdick\b/gi, "jerk"],
];

/** Make Reddit text nice to read aloud and to show as captions. */
export function cleanStoryText(text, { censor = true } = {}) {
  let t = String(text || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x200B;|​/g, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1") // markdown links
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s*(edit|update|ps)\s*\d*\s*[:\-–].*$/gim, "") // "EDIT: ..." lines at the end
    .replace(/^\s*(>|#+)\s*/gm, "")
    .replace(/[*_~`^]+/g, "")
    .replace(/\(\s*(\d{1,2})\s*([MFmf])\s*\)/g, (_m, age, g) => `, ${age} ${/m/i.test(g) ? "male" : "female"},`)
    .replace(/\b(\d{1,2})([MF])\b/g, (_m, age, g) => `${age} ${g === "M" ? "male" : "female"}`);
  for (const [re, rep] of ACRONYMS) t = t.replace(re, rep);
  if (censor) for (const [re, rep] of CLEAN_WORDS) t = t.replace(re, rep);
  return t.replace(/[ \t]+/g, " ").replace(/ ,/g, ",").replace(/,\s*,/g, ",").replace(/\n{2,}/g, "\n").replace(/^ +| +$/gm, "").trim();
}

/** Split into sentences (keeps punctuation). */
export function splitSentences(text) {
  const parts = String(text).replace(/\n+/g, " \n ").match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) || [];
  return parts.map((s) => s.replace(/\n/g, " ").trim()).filter((s) => s && /[A-Za-z0-9]/.test(s));
}

/** Group sentences into chunks the voice model handles well (it has a token limit). */
export function chunkForTTS(sentences, maxChars = 240) {
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) { out.push(cur); cur = ""; }
      // very long sentence: split at commas / spaces
      let rest = s;
      while (rest.length > maxChars) {
        let cut = rest.lastIndexOf(", ", maxChars);
        if (cut < maxChars / 3) cut = rest.lastIndexOf(" ", maxChars);
        if (cut < 1) cut = maxChars;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1).trim();
      }
      if (rest) cur = rest;
      continue;
    }
    if ((cur + " " + s).trim().length > maxChars && cur) { out.push(cur); cur = s; }
    else cur = (cur + " " + s).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/** Long stories become Part 1, Part 2... (each under the Shorts length limit). */
export function splitIntoParts(text, { speed = 1, maxSeconds = MAX_PART_SECONDS, titleSeconds = 6 } = {}) {
  const sentences = splitSentences(text);
  const total = estimateSeconds(wordCount(text), speed);
  // Leave room for the title, "Part N", "Follow for part N+1" and voices that read a bit slower.
  const budget = maxSeconds - titleSeconds - 14;
  if (total <= budget) return [sentences.join(" ")];
  const nParts = Math.ceil(total / budget);
  const target = total / nParts;
  const parts = [];
  let cur = [], curSecs = 0;
  for (const s of sentences) {
    const secs = estimateSeconds(wordCount(s), speed);
    if (cur.length && curSecs + secs > target * 1.08 && parts.length < nParts - 1) { parts.push(cur.join(" ")); cur = []; curSecs = 0; }
    cur.push(s); curSecs += secs;
  }
  if (cur.length) parts.push(cur.join(" "));
  return parts;
}

/** YouTube titles max 100 characters. */
export function videoTitle(title, part, totalParts) {
  const suffix = totalParts > 1 ? ` (Part ${part})` : "";
  let t = String(title || "").replace(/\s+/g, " ").trim();
  const max = 100 - suffix.length;
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return t + suffix;
}

// ---- captions ------------------------------------------------------------------
/**
 * Spread the words of one spoken chunk over its audio time. Longer words and punctuation pauses get more time.
 * `start`/`end` are the times (seconds) where speech starts/ends inside the audio.
 */
export function wordTimings(text, start, end) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const weight = (w) => Math.max(2, w.replace(/[^A-Za-z0-9']/g, "").length) + (/[.!?]["')]?$/.test(w) ? 4 : /[,;:]$/.test(w) ? 2 : 0);
  const total = words.reduce((n, w) => n + weight(w), 0);
  const span = Math.max(0.05, end - start);
  let t = start;
  return words.map((w) => {
    const d = (weight(w) / total) * span;
    const item = { word: w, start: t, end: t + d };
    t += d;
    return item;
  });
}

/** Show 1–3 words at a time; break after punctuation or long words. */
export function captionGroups(timed, { maxWords = 3, maxChars = 16 } = {}) {
  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) groups.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end }); cur = []; };
  for (const w of timed) {
    const chars = cur.map((x) => x.word).join(" ").length + w.word.length + 1;
    if (cur.length >= maxWords || (cur.length && chars > maxChars)) flush();
    cur.push(w);
    if (/[.!?,;:]["')]?$/.test(w.word)) flush();
  }
  flush();
  return groups;
}

/** Where speech really starts/ends in a clip (skip silence at both ends). */
export function speechBounds(samples, sampleRate, threshold = 0.012) {
  let a = 0, b = samples.length - 1;
  while (a < b && Math.abs(samples[a]) < threshold) a++;
  while (b > a && Math.abs(samples[b]) < threshold) b--;
  return { start: a / sampleRate, end: (b + 1) / sampleRate };
}

// ---- background clips ------------------------------------------------------------
/**
 * Pick a random start for a clip of `length` seconds from a background of `duration` seconds,
 * avoiding minutes already used. Skips the first/last 15 s (intros/outros). Returns {start, reused}.
 */
export function chooseSegment(duration, length, used = [], rand = Math.random) {
  const margin = duration > length + 60 ? 15 : 0;
  const lo = margin, hi = Math.max(lo, duration - length - margin);
  if (hi <= lo) return { start: 0, reused: used.length > 0 };
  const overlaps = (s) => used.some(([a, b]) => s < b && s + length > a);
  for (let i = 0; i < 80; i++) {
    const s = lo + rand() * (hi - lo);
    if (!overlaps(s)) return { start: Math.round(s * 10) / 10, reused: false };
  }
  // Try the gaps between used ranges in order before giving up.
  const sorted = [...used].sort((x, y) => x[0] - y[0]);
  let cursor = lo;
  for (const [a, b] of sorted) {
    if (a - cursor >= length && cursor <= hi) return { start: Math.round(cursor * 10) / 10, reused: false };
    cursor = Math.max(cursor, b);
  }
  if (hi - cursor >= 0 && cursor <= hi) return { start: Math.round(cursor * 10) / 10, reused: false };
  return { start: Math.round((lo + rand() * (hi - lo)) * 10) / 10, reused: true };
}

export function formatCount(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

export function formatDuration(sec) {
  sec = Math.round(sec);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}
