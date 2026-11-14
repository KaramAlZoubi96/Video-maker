// The video pages: Review, Queue, History and Insights all read the same data (/api/dashboard)
// and show a different part of it. Each HTML page sets window.VIEW before loading this file.
const VIEW = window.VIEW || "queue";
let DATA = null, TZ = "UTC";
let current = new URLSearchParams(location.search).get("page") || (() => { try { return localStorage.getItem("page") || "p1"; } catch (_) { return "p1"; } })();
const NAMES = { youtube: "YouTube", instagram: "Instagram" };
const SHORT = { youtube: "YT", instagram: "IG" };
const $id = (id) => document.getElementById(id);

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k" : String(n));
const formatLen = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, "0")}`;
const viewsOf = (v) => Object.values(v.posts).reduce((n, p) => n + (p.stats?.views || 0), 0);
const likesOf = (v) => Object.values(v.posts).reduce((n, p) => n + (p.stats?.likes || 0), 0);
const empty = (title, text) => `<div class="empty"><b>${title}</b>${text}</div>`;

function postDots(v) {
  return Object.entries(v.posts).map(([pl, p]) => {
    if (p.status === "published") return p.url ? `<a class="d ok" href="${esc(p.url)}" target="_blank" rel="noopener">${SHORT[pl]} ✓</a>` : `<span class="d ok">${SHORT[pl]} ✓</span>`;
    if (p.status === "uploading") return `<span class="d up">${SHORT[pl]} uploading</span>`;
    if (p.status === "failed") return `<span class="d bad">${SHORT[pl]} failed</span>`;
    return `<span class="d">${SHORT[pl]}</span>`;
  }).join("");
}

function statsLine(v) {
  if (!Object.values(v.posts).some((p) => p.stats)) return "";
  return `<div class="m">${fmtN(viewsOf(v))} views · ${fmtN(likesOf(v))} likes</div>`;
}

function statsTitle(v) {
  return Object.entries(v.posts).filter(([, p]) => p.stats).map(([pl, p]) =>
    `${NAMES[pl]}: ${p.stats.views ?? "?"} views, ${p.stats.likes ?? "?"} likes, ${p.stats.comments ?? "?"} comments${p.stats.note ? " (" + p.stats.note + ")" : ""}`).join("\n");
}

function notes(v) {
  let h = "";
  for (const [pl, p] of Object.entries(v.posts)) {
    if (p.status === "failed") h += `<div class="err">${NAMES[pl]}: ${esc(p.lastError)} <button class="ghost" style="padding:3px 12px;margin-left:6px" onclick="act('${v.id}','retry/${pl}')">Retry</button></div>`;
    else if (v.releasedAt && p.status !== "published" && (p.note || p.lastError)) h += `<div class="muted">${NAMES[pl]}: ${esc(p.note || "")}${p.nextAttemptAt ? " · next try " + fmtTime(p.nextAttemptAt, TZ) : ""}</div>`;
  }
  if (v.status === "uploading") h += `<div class="muted">Upload not finished. Upload it again if this stays.</div>`;
  if (v.credit) h += `<div class="muted">Story by <a href="${esc(v.credit.url)}" target="_blank" rel="noopener">u/${esc(v.credit.author)}</a>${v.credit.permission ? " · permission ✓" : ""}</div>`;
  return h ? `<div class="notes">${h}</div>` : "";
}

const delBtn = (v, label = "Delete") => `<button class="danger" onclick="if(confirm('Remove this video from the website? (Already-published posts stay online.)'))act('${v.id}','delete')">${label}</button>`;
const editForm = (v) => `<form onsubmit="event.preventDefault();act('${v.id}','edit',{title:this.t.value,description:this.d.value})">
    <label>Title</label><input name="t" type="text" maxlength="100" required value="${esc(v.title)}">
    <label>Caption</label><textarea name="d" maxlength="2000">${esc(v.description)}</textarea>
    <p><button class="ghost" type="submit">Save text</button></p>
  </form>`;

/** One video as a list row. kind: queued | active | done | unfinished */
function row(v, kind, i, total) {
  const label = kind === "queued" ? `#${i + 1}` : kind === "active" ? "LIVE" : "";
  const meta = kind === "done" ? `by ${esc(v.uploader)} · posted ${fmtDate(v.releasedAt, TZ)}` : `by ${esc(v.uploader)} · ${formatLen(v.duration)}`;
  const waiting = v.approval === "pending" || v.approval === "changes";
  let pills = "";
  if (kind === "active") pills += `<span class="d up">Posting</span>`;
  if (kind === "queued" && v.approval === "pending") pills += `<a class="d wait" href="/review.html">Needs review</a>`;
  if (kind === "queued" && v.approval === "changes") pills += `<a class="d bad" href="/review.html">Sent back</a>`;
  if (kind === "queued" && v.scheduledAt) pills += `<span class="d">Fixed: ${fmtDate(v.scheduledAt, TZ)}</span>`;
  pills += postDots(v);

  let ra = "";
  if (kind === "queued" && v.status === "ready") {
    ra = `<button class="ghost" onclick="watch('${v.id}')">Watch</button>
      <button class="ghost" onclick="setTime('${v.id}', ${v.scheduledAt ? `'${v.scheduledAt}'` : "null"})">Set time</button>
      ${waiting ? `<a class="btn" href="/review.html">Review</a>` : `<button onclick="if(confirm('Post this video now?'))act('${v.id}','post-now')">Post now</button>`}`;
  } else if (kind === "unfinished") {
    ra = delBtn(v);
  }
  const more = kind === "queued" ? `<details><summary>More</summary>
      <div class="actions" style="margin:8px 0">
        <button class="ghost" ${i === 0 ? "disabled" : ""} onclick="act('${v.id}','move',{direction:-1})">↑ Earlier</button>
        <button class="ghost" ${i === total - 1 ? "disabled" : ""} onclick="act('${v.id}','move',{direction:1})">↓ Later</button>
        ${delBtn(v)}
      </div>${editForm(v)}</details>`
    : kind === "done" || kind === "active" ? `<details><summary>More</summary><div class="actions" style="margin:8px 0">${delBtn(v, "Remove from the website")}</div></details>` : "";
  return `<div class="row">
    <span class="num ${kind === "active" ? "live" : ""}">${label}</span>
    <img class="thumb" src="/api/thumb/${v.id}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div class="x" title="${esc(statsTitle(v))}">
      <div class="t">${esc(v.title)}</div>
      <div class="m">${meta}</div>
      ${kind === "done" ? statsLine(v) : ""}
      <div class="dots">${pills}</div>
      ${notes(v)}${more}
    </div>
    <div class="ra">${ra}</div>
  </div>`;
}

/** A video waiting for review: the player right there, with Approve / Send back. */
function reviewCard(v, pageName) {
  const mine = v.uploader === DATA.me;
  const sentBack = v.approval === "changes";
  return `<div class="card review" style="display:flex;gap:18px;flex-wrap:wrap">
    <video src="/api/videos/${v.id}/file" poster="/api/thumb/${v.id}" controls playsinline preload="none"></video>
    <div style="flex:1;min-width:240px">
      <div class="dots" style="margin:0 0 8px"><span class="d">${esc(pageName)}</span>
        ${sentBack ? `<span class="d bad">Sent back</span>` : mine ? `<span class="d wait">Waiting for your friend</span>` : `<span class="d wait">Needs your review</span>`}</div>
      <div class="row" style="padding:0;border:0"><div class="x"><div class="t">${esc(v.title)}</div>
        <div class="m">by ${esc(v.uploader)} · ${formatLen(v.duration)}</div></div></div>
      ${sentBack ? `<div class="approve changes"><b>${esc(v.approvedBy || "")} wrote:</b> ${esc(v.approvalNote || "")}<br><span class="muted">Fix the text below and save (it goes back for review), or make a new video and delete this one.</span></div>` : ""}
      ${notes(v)}
      <details ${sentBack ? "open" : ""}><summary class="muted small" style="margin-top:8px">Adjust the text</summary>${editForm(v)}</details>
      <div class="actions" style="margin-top:14px">
        <button onclick="approve('${v.id}', ${mine})">${sentBack ? "Approve anyway" : "Approve"}</button>
        ${sentBack ? "" : `<button class="ghost" onclick="sendBack('${v.id}')">Send back</button>`}
        ${delBtn(v, "Reject and delete")}
      </div>
    </div></div>`;
}

function list(title, items, right = "") {
  if (!items.length) return "";
  return `<div class="list"><div class="lh">${title}<span>${right}</span></div>${items.join("")}</div>`;
}

function tabs(countOf) {
  const d = DATA;
  $id("tabs").innerHTML = d.pages.map((p) =>
    `<button class="${p.id === current ? "on" : ""}" onclick="pick('${p.id}')">${esc(p.name)} <span class="count">${countOf(p)}</span></button>`).join("");
}

// ---------- the four views ----------
function renderReview() {
  const d = DATA;
  const items = d.pages.flatMap((p) => p.queued.filter((v) => v.approval === "pending" || v.approval === "changes").map((v) => ({ v, name: p.name })));
  // yours to review first, then sent back, then your own waiting for your friend
  const rank = ({ v }) => (v.approval === "pending" && v.uploader !== d.me ? 0 : v.approval === "changes" ? 1 : 2);
  items.sort((a, b) => rank(a) - rank(b));
  $id("page").innerHTML = items.length ? items.map(({ v, name }) => reviewCard(v, name)).join("")
    : empty("Nothing to review", d.requireApproval
      ? "Videos made by one of you show up here for the other to watch and approve."
      : `Review is turned off, so new videos go straight to the queue. You can turn it on in <a href="/settings.html">Settings</a>.`);
}

function renderQueue() {
  const d = DATA;
  tabs((p) => p.queued.length);
  const p = d.pages.find((x) => x.id === current);
  $id("newBtn").href = "/upload.html?page=" + p.id;
  const acc = [p.accounts.youtube && "YouTube " + p.accounts.youtube, p.accounts.instagram && "Instagram " + p.accounts.instagram].filter(Boolean).join(" · ");
  const nextUp = p.queued.find((v) => !v.scheduledAt && v.approval !== "pending" && v.approval !== "changes" && v.status === "ready");
  const next = p.nextSlot
    ? `<div class="next"><b>Next post: ${fmtTime(p.nextSlot, TZ)}</b> <small>· ${nextUp ? `“${esc(nextUp.title)}”` : p.queued.length ? "nothing approved yet" : "nothing waiting"}${acc ? " · " + esc(acc) : ""}</small></div>`
    : `<div class="next"><b>No posting times for ${esc(p.name)}.</b> <small>Videos only post when you press “Post now”. <a href="/settings.html">Set times</a></small></div>`;
  const upNext = [...p.active.map((v) => row(v, "active", 0, 1)), ...p.queued.map((v, i) => row(v, "queued", i, p.queued.length))];
  $id("page").innerHTML = next
    + list("Unfinished uploads", (p.unfinished || []).map((v) => row(v, "unfinished", 0, 1)), "upload again, or delete")
    + (upNext.length ? list("Up next", upNext, p.queued.length > 1 ? "Reorder under “More”" : "")
      : empty("The queue is empty", `<a href="/stories.html">Make a video from a story</a> or <a href="/upload.html?page=${p.id}">upload one</a> for ${esc(p.name)}.`));
}

function renderHistory() {
  const d = DATA;
  tabs((p) => p.publishedCount);
  const p = d.pages.find((x) => x.id === current);
  const failed = p.active.filter((v) => Object.values(v.posts).some((x) => x.status === "failed"));
  $id("page").innerHTML = (failed.length ? list("Needs attention", failed.map((v) => row(v, "active", 0, 1)), "press Retry") : "")
    + (p.done.length ? list("Posted", p.done.map((v) => row(v, "done", 0, 1)), p.publishedCount > p.done.length ? `showing the newest ${p.done.length} of ${p.publishedCount}` : "")
      : empty("Nothing posted yet", `Videos from ${esc(p.name)} appear here after they go out.`));
}

function renderInsights() {
  const d = DATA;
  tabs((p) => p.publishedCount);
  const p = d.pages.find((x) => x.id === current);
  if (!p.publishedCount) {
    $id("page").innerHTML = empty("No results yet", "Once videos are posted, their views appear here with hints on what works.");
    return;
  }
  const views = p.totals.youtubeViews + p.totals.instagramViews;
  const kpis = `<div class="kpis">
    <div class="kpi"><span>Views</span><b>${fmtN(views)}</b><small>all posts</small></div>
    <div class="kpi"><span>YouTube</span><b>${fmtN(p.totals.youtubeViews)}</b><small>views</small></div>
    <div class="kpi"><span>Instagram</span><b>${fmtN(p.totals.instagramViews)}</b><small>views</small></div>
    <div class="kpi"><span>Likes</span><b>${fmtN(p.totals.likes)}</b><small>${p.publishedCount} posted · ${fmtN(Math.round(views / p.publishedCount))} views each</small></div>
  </div>`;
  const best = p.bestTimes.length
    ? `<div class="card"><b>Best posting times</b> <span class="muted small">average views per video</span><div class="times">${p.bestTimes.slice(0, 6).map((t, i) =>
        `<div class="trow"><span>${t.time}</span><span class="bar"><i style="width:${Math.max(4, Math.round((t.avgViews / Math.max(1, p.bestTimes[0].avgViews)) * 100))}%"></i></span><span>${fmtN(t.avgViews)} <span class="muted">· ${t.videos} video${t.videos > 1 ? "s" : ""}${i === 0 ? " · best" : ""}</span></span></div>`).join("")}</div>
        <div class="muted small" style="margin-top:8px">Try a few different times for 2–3 weeks, then keep the best ones in <a href="/settings.html">Settings</a>.</div></div>`
    : `<div class="card muted">Numbers show up a few hours after posting.</div>`;
  const top = [...p.done].filter((v) => viewsOf(v) > 0).sort((a, b) => viewsOf(b) - viewsOf(a)).slice(0, 5);
  $id("page").innerHTML = kpis + best + list("Top videos", top.map((v) => row(v, "done", 0, 1)), "most views")
    + `<div class="muted small">${p.lastStatsRun ? "Numbers updated " + fmtDate(p.lastStatsRun, TZ) + ". " : ""}They refresh by themselves every 3 hours.</div>`;
}

function render() {
  const d = DATA;
  if (!d.pages.find((p) => p.id === current)) current = d.pages[0].id;
  const banners = [];
  if (VIEW !== "review" && d.toApprove) banners.push(`<div class="banner ok"><b>${d.toApprove} ${d.toApprove === 1 ? "video is" : "videos are"} waiting for your review.</b> <a href="/review.html">Open Review</a></div>`);
  if ((VIEW === "queue" || VIEW === "review") && d.problems.length) {
    banners.push(d.problems.length === 1
      ? `<div class="banner">${esc(d.problems[0])} See <a href="/settings.html">Settings</a>.</div>`
      : `<div class="banner" title="${esc(d.problems.join("\n"))}">${d.problems.length} accounts are not connected yet, so their videos will wait. See <a href="/settings.html">Settings</a>.</div>`);
  }
  $id("problems").innerHTML = banners.join("");
  ({ review: renderReview, queue: renderQueue, history: renderHistory, insights: renderInsights })[VIEW]();
  window.__busy = d.pages.some((x) => x.active.some((v) => Object.values(v.posts).some((p) => p.status === "uploading" || p.status === "pending")));
  setStatus(window.__busy, d.toApprove);
}

// ---------- actions ----------
async function refreshStats() {
  flash("Updating numbers…", false);
  const r = await api("/api/stats/refresh", { json: {} });
  flash(r.ok ? r.data.message : (r.data.error || "Could not update numbers."), !r.ok);
  await load();
}

function pick(id) { current = id; try { localStorage.setItem("page", id); } catch (_) {} render(); }

function watch(id) {
  const box = document.createElement("div");
  box.className = "modal";
  box.innerHTML = `<div class="modalbox"><video src="/api/videos/${id}/file" controls autoplay playsinline></video>
    <p><button class="ghost" style="width:100%">Close</button></p></div>`;
  box.addEventListener("click", (e) => { if (e.target === box || e.target.tagName === "BUTTON") box.remove(); });
  document.body.appendChild(box);
}

async function approve(id, isOwn) {
  if (isOwn && !confirm("Usually your friend approves this one. Approve it yourself anyway?")) return;
  await act(id, "approve", { decision: "approve" });
}

async function sendBack(id) {
  const note = prompt("What should change? (your friend will see this)");
  if (note === null) return;
  await act(id, "approve", { decision: "changes", note });
}

function setTime(id, currentTime) {
  const box = document.createElement("div");
  box.className = "modal";
  const pad = (n) => String(n).padStart(2, "0");
  const d = currentTime ? new Date(currentTime) : new Date(Date.now() + 3600e3);
  const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  box.innerHTML = `<div class="modalbox card"><b>Post at a fixed date and time</b>
    <p class="small muted">Instead of the page's daily times. It still needs approval first.</p>
    <input type="datetime-local" value="${local}">
    <div class="actions" style="margin-top:14px"><button data-a="save">Save</button>
    ${currentTime ? '<button class="ghost" data-a="auto">Back to daily times</button>' : ""}<button class="ghost" data-a="close">Cancel</button></div></div>`;
  box.addEventListener("click", async (e) => {
    const a = e.target.dataset && e.target.dataset.a;
    if (e.target === box || a === "close") return box.remove();
    if (a === "save") {
      const val = box.querySelector("input").value;
      if (!val) return;
      box.remove();
      await act(id, "schedule", { at: new Date(val).toISOString() });
    }
    if (a === "auto") { box.remove(); await act(id, "schedule", { at: null }); }
  });
  document.body.appendChild(box);
}

async function act(id, action, data = {}) {
  const r = await api(`/api/videos/${id}/${action}`, { json: data });
  if (!r.ok) flash(r.data.error || "Something went wrong.", true);
  else if (r.data.message) flash(r.data.message, false);
  await load();
}

async function load() {
  const r = await api("/api/dashboard");
  if (!r.ok) return;
  DATA = r.data; TZ = r.data.timezone;
  render();
}

(async () => {
  if (!(await requireUser())) return;
  showUrlMessages();
  await load();
  // keep the page fresh while something is posting (but never while you're typing or watching)
  setInterval(() => {
    const busyHere = document.querySelector("details[open], .modal") || [...document.querySelectorAll("video")].some((v) => !v.paused);
    if (window.__busy && !busyHere) load();
  }, 10000);
})();
