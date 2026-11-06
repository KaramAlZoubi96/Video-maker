// Automatic story finder: no Reddit login, no bookmark.
// Reads recent posts from Arctic Shift (a free public archive of Reddit, https://arctic-shift.photon-reddit.com),
// keeps the most upvoted ones, then fetches their full text. Runs in the browser (the archive allows it),
// so it uses none of the website's Netlify allowance.
//
// The archive saves posts the moment they're posted and updates their upvotes about a day later,
// so we skip the newest ~30 hours (their upvote counts aren't real yet).

export const ARCHIVE = "https://arctic-shift.photon-reddit.com/api";
const FIELDS = "id,score,num_comments,created_utc,title,over_18";
const SETTLE_HOURS = 30;
const MAX_PAGES_PER_SUB = 40; // up to 4,000 posts per subreddit
const KEEP_PER_SUB = 15;
const MIN_SCORE = 50;

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("Stopped.")); }, { once: true });
});

/** GET JSON from the archive, gently: waits and retries when it asks us to slow down. */
/** @param {string} path @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, tries?: number }} [opts] */
export async function archiveGet(path, { signal, fetchImpl = fetch, tries = 6 } = {}) {
  let wait = 1500;
  for (let i = 1; ; i++) {
    let res, body = null;
    try {
      res = await fetchImpl(`${ARCHIVE}${path}`, { signal });
      body = await res.json().catch(() => null);
    } catch (e) {
      if (signal?.aborted) throw new Error("Stopped.");
      if (i >= tries) throw new Error("Can't reach the story archive. Check your internet and try again.");
      await sleep(wait, signal); wait *= 2; continue;
    }
    if (res.ok && body && Array.isArray(body.data)) return body.data;
    const msg = body?.error || `HTTP ${res.status}`;
    const busy = res.status === 429 || res.status >= 500 || /timeout|slow down/i.test(msg);
    if (!busy || i >= tries) throw new Error(`The story archive said: ${msg}`);
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    await sleep(Number.isFinite(reset) && reset > 0 && reset < 90 ? reset * 1000 : wait, signal);
    wait = Math.min(wait * 2, 20000);
  }
}

/**
 * Find the best stories from the last `days` days.
 * onProgress(text) is called as it goes. Returns posts shaped like Reddit's own data
 * (id, title, author, subreddit, score, upvote_ratio, num_comments, permalink, selftext, over_18, created_utc).
 */
/** @param {{ subs: string[], days?: number, onProgress?: (text: string) => void, signal?: AbortSignal, fetchImpl?: typeof fetch, now?: number }} opts */
export async function findStories({ subs, days = 7, onProgress = () => {}, signal, fetchImpl = fetch, now = Date.now() }) {
  const before = Math.floor(now / 1000) - SETTLE_HOURS * 3600;
  const after = Math.floor(now / 1000) - Math.max(days, 2) * 86400;
  const best = [];
  const errors = [];
  let scanned = 0;
  for (const sub of subs) {
    let cursor = before, pages = 0;
    const seen = [];
    try {
      while (pages < MAX_PAGES_PER_SUB) {
        if (signal?.aborted) throw new Error("Stopped.");
        const page = await archiveGet(`/posts/search?subreddit=${encodeURIComponent(sub)}&after=${after}&before=${cursor}&limit=100&fields=${FIELDS}`, { signal, fetchImpl });
        pages++;
        scanned += page.length;
        seen.push(...page.filter((p) => !p.over_18 && (p.score || 0) >= MIN_SCORE));
        onProgress(`Reading r/${sub}… ${scanned.toLocaleString()} posts checked so far`);
        if (page.length < 100) break;
        const oldest = Math.min(...page.map((p) => p.created_utc));
        if (!(oldest < cursor)) break;
        cursor = oldest;
        await sleep(250, signal); // be gentle with the free archive
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`r/${sub}: ${e.message}`);
    }
    seen.sort((a, b) => b.score - a.score);
    best.push(...seen.slice(0, KEEP_PER_SUB).map((p) => ({ ...p, subreddit: sub })));
  }

  // Full text for the winners, a few at a time.
  const full = [];
  for (let i = 0; i < best.length; i += 10) {
    if (signal?.aborted) throw new Error("Stopped.");
    onProgress(`Getting the full stories… ${Math.min(i + 10, best.length)} / ${best.length}`);
    try {
      const ids = best.slice(i, i + 10).map((p) => p.id).join(",");
      full.push(...await archiveGet(`/posts/ids?ids=${ids}`, { signal, fetchImpl }));
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(e.message);
    }
    await sleep(250, signal);
  }
  const scoreById = new Map(best.map((p) => [p.id, p]));
  const posts = full.map((p) => ({
    id: p.id,
    title: p.title,
    author: p.author,
    subreddit: p.subreddit || scoreById.get(p.id)?.subreddit,
    score: Math.max(p.score || 0, scoreById.get(p.id)?.score || 0),
    upvote_ratio: p.upvote_ratio,
    num_comments: Math.max(p.num_comments || 0, scoreById.get(p.id)?.num_comments || 0),
    permalink: p.permalink,
    selftext: p.selftext,
    over_18: p.over_18,
    stickied: p.stickied,
    created_utc: p.created_utc,
    removed_by_category: p.removed_by_category,
  }));
  return { posts, scanned, errors };
}
