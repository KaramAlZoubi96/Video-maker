// Background videos saved on THIS computer (the big file never leaves your computer).
// Chrome/Edge remember the file so you only choose it once; other browsers ask each time.
const DB = "shq-backgrounds", STORE = "files";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

export const canRemember = () => typeof window.showOpenFilePicker === "function";
export const bgKeyFor = (file) => `${file.name}-${file.size}`;

/** List saved backgrounds: [{key, name, size, handle?}] */
export async function listBackgrounds() {
  try { return (await tx("readonly", (s) => s.getAll())) || []; } catch { return []; }
}

/** Ask the user to choose a background video. Returns {key, name, size, file}. */
export async function addBackground() {
  if (canRemember()) {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: "Videos", accept: { "video/*": [".mp4", ".mov", ".webm", ".mkv", ".m4v"] } }] });
    const file = await handle.getFile();
    const item = { key: bgKeyFor(file), name: file.name, size: file.size, handle, added: Date.now() };
    await tx("readwrite", (s) => s.put(item));
    return { ...item, file };
  }
  const file = await new Promise((resolve, reject) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: "video/*" });
    input.onchange = () => (input.files[0] ? resolve(input.files[0]) : reject(new Error("No file chosen.")));
    input.click();
  });
  return { key: bgKeyFor(file), name: file.name, size: file.size, file };
}

/** Get the file of a saved background (asks for permission again after a browser restart). */
export async function openBackground(item) {
  if (item.file) return item.file;
  if (!item.handle) throw new Error("Choose the background file again.");
  let perm = await item.handle.queryPermission({ mode: "read" });
  if (perm !== "granted") perm = await item.handle.requestPermission({ mode: "read" });
  if (perm !== "granted") throw new Error("The browser needs permission to read the background video.");
  return item.handle.getFile();
}

export async function removeBackground(key) {
  await tx("readwrite", (s) => s.delete(key));
}
