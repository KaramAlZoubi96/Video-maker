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

const NAV = [
  ["/", "🎬", "Queue"],
  ["/calendar.html", "🗓", "Calendar"],
  ["/stories.html", "📖", "Stories"],
  ["/upload.html", "⬆", "Upload"],
  ["/settings.html", "⚙", "Settings"],
];

/** Draws the sidebar (computer) and top bar + bottom tabs (phone) around <main>. */
function shell(user, pages = []) {
  const here = location.pathname === "/index.html" ? "/" : location.pathname === "/maker.html" ? "/stories.html" : location.pathname;
  const link = ([href, icon, label]) => `<a href="${href}" class="${href === here ? "on" : ""}"><b>${icon}</b> ${label}</a>`;
  const mainNav = NAV.filter(([h]) => h !== "/settings.html");
  const links = NAV.map(link).join(""); // phone tab bar: everything
  const dots = ["🟠", "🟣", "🔵", "🟢"];
  const pageLinks = pages.map((p, i) => `<a href="/?page=${encodeURIComponent(p.id)}"><b>${dots[i] || "⚪"}</b> ${esc(p.name)}</a>`).join("");
  const sideLinks = mainNav.map(link).join("")
    + (pageLinks ? `<div class="sec">Pages</div>${pageLinks}` : "")
    + `<div class="sec">Account</div>${link(["/settings.html", "⚙", "Settings"])}`;
  const logo = `<a class="logo" href="/"><i>▶</i>Shorts HQ</a>`;
  const main = document.querySelector("main");
  const app = document.createElement("div");
  app.className = "app";
  app.innerHTML = `<aside class="side">${logo}<nav class="nav">${sideLinks}</nav>
    <div class="who"><b>${esc(user)}</b>logged in<br><button class="link" onclick="logout()">Log out</button></div></aside>`;
  main.parentNode.insertBefore(app, main);
  app.appendChild(main);
  document.body.insertAdjacentHTML("afterbegin", `<div class="topbar">${logo}<button class="link" onclick="logout()">Log out</button></div>`);
  document.body.insertAdjacentHTML("beforeend", `<nav class="tabbar">${links}</nav>`);
}

async function requireUser() {
  const r = await api("/api/me");
  if (r.data.needsSetup) { location.href = "/login.html?setup=1"; return null; }
  if (!r.data.user) { location.href = "/login.html"; return null; }
  shell(r.data.user, r.data.pages || []);
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
