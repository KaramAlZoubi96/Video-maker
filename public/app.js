// Shared helpers for all pages.
async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: { "X-Requested-With": "fetch" }, credentials: "same-origin" };
  if (opts.json !== undefined) { init.method = opts.method || "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.json); }
  if (opts.body !== undefined) { init.body = opts.body; init.method = opts.method || "PUT"; }
  let res;
  try { res = await fetch(path, init); } catch (e) { return { ok: false, status: 0, data: { error: "No connection. Check your internet and try again." } }; }
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && !location.pathname.startsWith("/login")) { location.href = "/login.html"; }
  return { ok: res.ok, status: res.status, data };
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function flash(msg, isError) {
  const el = document.getElementById("flash");
  if (!el || !msg) return;
  el.className = "flash" + (isError ? " error" : "");
  el.textContent = msg;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fmtTime(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { timeZone: tz || undefined, weekday: "short", hour: "2-digit", minute: "2-digit" }); }
  catch (_) { return new Date(iso).toLocaleString(); }
}
function fmtDate(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { timeZone: tz || undefined, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch (_) { return new Date(iso).toLocaleString(); }
}

// Line icons (24x24, drawn with strokes) for the menu.
const ICONS = {
  review: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M10.5 9.5v5l4-2.5z"/>',
  queue: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  history: '<path d="M4 7h16M4 12h16M4 17h10"/>',
  insights: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  stories: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 21H20v-3"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 20h16"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

// [section, href, icon, label]
const NAV = [
  ["Videos", "/review.html", "review", "Review"],
  ["Videos", "/", "queue", "Queue"],
  ["Videos", "/calendar.html", "calendar", "Calendar"],
  ["Videos", "/history.html", "history", "History"],
  ["Videos", "/insights.html", "insights", "Insights"],
  ["Create", "/stories.html", "stories", "Stories"],
  ["Create", "/upload.html", "upload", "Upload"],
  ["Manage", "/settings.html", "settings", "Settings"],
];

/** Draws the sidebar (computer) and top bar + bottom tabs (phone) around <main>. */
function shell(user) {
  const here = location.pathname === "/index.html" ? "/" : location.pathname === "/maker.html" ? "/stories.html" : location.pathname;
  const link = ([, href, ic, label]) => `<a href="${href}" class="${href === here ? "on" : ""}" data-nav="${ic}">${icon(ic)}<span>${label}</span></a>`;
  let side = "", last = "";
  for (const item of NAV) {
    if (item[0] !== last) { side += `<div class="sec">${item[0]}</div>`; last = item[0]; }
    side += link(item);
  }
  const logo = `<a class="logo" href="/">Shorts HQ<small>Story studio</small></a>`;
  const main = document.querySelector("main");
  const app = document.createElement("div");
  app.className = "app";
  app.innerHTML = `<aside class="side">${logo}<nav class="nav">${side}</nav>
    <div class="who"><span class="dot" id="statusDot"></span><span id="statusText">${esc(user)}</span><button class="link" onclick="logout()">Log out</button></div></aside>`;
  main.parentNode.insertBefore(app, main);
  app.appendChild(main);
  document.body.insertAdjacentHTML("afterbegin", `<div class="topbar">${logo}<button class="link" onclick="logout()">Log out</button></div>`);
  document.body.insertAdjacentHTML("beforeend", `<nav class="tabbar">${NAV.map(link).join("")}</nav>`);
  window.__user = user;
}

/** Bottom-left status: "Posting…" while uploads run, otherwise the user's name. Also the Review counter. */
function setStatus(busy, toReview) {
  const dot = document.getElementById("statusDot"), text = document.getElementById("statusText");
  if (dot) dot.classList.toggle("busy", !!busy);
  if (text) text.textContent = busy ? "Posting…" : `Idle · ${window.__user || ""}`;
  document.querySelectorAll('.nav a[data-nav="review"]').forEach((a) => {
    a.querySelector(".count")?.remove();
    if (toReview) a.insertAdjacentHTML("beforeend", `<span class="count">${toReview}</span>`);
  });
}

async function requireUser() {
  const r = await api("/api/me");
  if (r.data.needsSetup) { location.href = "/login.html?setup=1"; return null; }
  if (!r.data.user) { location.href = "/login.html"; return null; }
  shell(r.data.user);
  document.body.classList.remove("hidden");
  return r.data.user;
}

async function logout() { await api("/api/logout", { json: {} }); location.href = "/login.html"; }

function showUrlMessages() {
  const p = new URLSearchParams(location.search);
  if (p.get("msg")) flash(p.get("msg"), false);
  if (p.get("error")) flash(p.get("error"), true);
  if (p.get("msg") || p.get("error")) history.replaceState(null, "", location.pathname);
}

/**
 * Send a finished video file to the website in 4 MB pieces and add it to the queue.
 * info: { pageId, title, description, platforms, credit, storyId, width, height, duration, thumbnail, fileName }
 * Returns the new video id. Throws an Error with a readable message.
 */
async function uploadVideoBlob(blob, info, onProgress = () => {}) {
  const payload = { ...info, size: blob.size, fileName: info.fileName || "video.mp4" };
  let c = await api("/api/videos", { json: payload });
  if (!c.ok && c.data.duplicate) {
    if (!confirm(c.data.error)) throw new Error("Cancelled. This video is already in the queue.");
    c = await api("/api/videos", { json: { ...payload, allowDuplicate: true } });
  }
  if (!c.ok) throw new Error(c.data.error || "Could not start the upload.");
  const { id, chunkSize, chunkCount } = c.data;
  const send = async (n) => {
    const part = blob.slice(n * chunkSize, Math.min(blob.size, (n + 1) * chunkSize));
    for (let attempt = 1; ; attempt++) {
      const r = await api(`/api/videos/${id}/chunks/${n}`, { method: "PUT", body: part });
      if (r.ok) return;
      if (r.status === 400 || r.status === 404 || attempt >= 6) throw new Error(r.data.error || "Upload failed. Please try again.");
      await new Promise((res) => setTimeout(res, 1000 * 2 ** attempt));
    }
  };
  let done = 0, next = 0;
  const worker = async () => {
    while (next < chunkCount) {
      const n = next++;
      await send(n);
      onProgress(Math.round((++done / chunkCount) * 100));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  for (let i = 0; i < 3; i++) {
    const f = await api(`/api/videos/${id}/complete`, { json: {} });
    if (f.ok) return id;
    if (f.status !== 409) throw new Error(f.data.error || "Could not finish the upload.");
    for (const n of f.data.missing || []) await send(n);
  }
  throw new Error("Upload could not be completed. Please try again.");
}
