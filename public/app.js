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
  el.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fmtTime(iso, tz) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(undefined, { timeZone: tz || undefined, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch (_) { return new Date(iso).toLocaleString(); }
}

async function requireUser() {
  const r = await api("/api/me");
  if (r.data.needsSetup) { location.href = "/login.html?setup=1"; return null; }
  if (!r.data.user) { location.href = "/login.html"; return null; }
  document.querySelectorAll("[data-username]").forEach(e => e.textContent = r.data.user);
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
