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
  ["/upload.html", "⬆", "Upload"],
  ["/settings.html", "⚙", "Settings"],
];

/** Draws the sidebar (computer) and top bar + bottom tabs (phone) around <main>. */
function shell(user) {
  const here = location.pathname === "/index.html" ? "/" : location.pathname;
  const links = NAV.map(([href, icon, label]) => `<a href="${href}" class="${href === here ? "on" : ""}"><b>${icon}</b> ${label}</a>`).join("");
  const logo = `<a class="logo" href="/"><i>●</i> <span>SHORTS HQ</span></a>`;
  const main = document.querySelector("main");
  const app = document.createElement("div");
  app.className = "app";
  app.innerHTML = `<aside class="side">${logo}<nav class="nav">${links}</nav>
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
