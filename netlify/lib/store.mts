/**
 * Storage on Netlify Blobs.
 *
 * Everything (users, videos, settings, video chunks) lives in one Blobs store.
 * JSON documents are updated with ETag checks ("only write if nobody changed it
 * since I read it"), so the website and the scheduler never overwrite each
 * other's changes. That's what prevents lost updates and double posts.
 */
import { getStore } from "@netlify/blobs";

export interface Doc<T> {
  data: T;
  etag: string;
}

export interface KV {
  getJSON<T>(key: string): Promise<Doc<T> | null>;
  /** Returns false if onlyIfMatch / onlyIfNew condition failed. */
  setJSON(key: string, data: unknown, opts?: { onlyIfMatch?: string; onlyIfNew?: boolean }): Promise<boolean>;
  getBytes(key: string): Promise<Uint8Array | null>;
  setBytes(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

class BlobsKV implements KV {
  private store = getStore({ name: "autoposter", consistency: "strong" });

  async getJSON<T>(key: string): Promise<Doc<T> | null> {
    const r = await this.store.getWithMetadata(key, { type: "json" });
    if (!r) return null;
    return { data: r.data as T, etag: r.etag ?? "" };
  }

  async setJSON(key: string, data: unknown, opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
    const o = opts.onlyIfMatch ? { onlyIfMatch: opts.onlyIfMatch } : opts.onlyIfNew ? { onlyIfNew: true } : {};
    const res = await this.store.setJSON(key, data, o);
    return res.modified !== false;
  }

  async getBytes(key: string) {
    const buf = await this.store.get(key, { type: "arrayBuffer" });
    return buf ? new Uint8Array(buf) : null;
  }

  async setBytes(key: string, data: Uint8Array) {
    // Copy into a standalone ArrayBuffer (Blobs wants ArrayBuffer/Blob/string).
    await this.store.set(key, data.slice().buffer as ArrayBuffer);
  }

  async delete(key: string) {
    await this.store.delete(key);
  }

  async list(prefix: string) {
    const keys: string[] = [];
    for await (const page of this.store.list({ prefix, paginate: true })) {
      for (const b of page.blobs) keys.push(b.key);
    }
    return keys;
  }
}

/** In-memory version with the same behaviour, used by tests. */
export class MemoryKV implements KV {
  private docs = new Map<string, { value: string | Uint8Array; etag: string }>();
  private n = 0;

  async getJSON<T>(key: string) {
    const d = this.docs.get(key);
    if (!d || typeof d.value !== "string") return null;
    return { data: JSON.parse(d.value) as T, etag: d.etag };
  }
  async setJSON(key: string, data: unknown, opts: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
    const cur = this.docs.get(key);
    if (opts.onlyIfNew && cur) return false;
    if (opts.onlyIfMatch && (!cur || cur.etag !== opts.onlyIfMatch)) return false;
    this.docs.set(key, { value: JSON.stringify(data), etag: `e${++this.n}` });
    return true;
  }
  async getBytes(key: string) {
    const d = this.docs.get(key);
    return d && typeof d.value !== "string" ? d.value : null;
  }
  async setBytes(key: string, data: Uint8Array) {
    this.docs.set(key, { value: data.slice(), etag: `e${++this.n}` });
  }
  async delete(key: string) {
    this.docs.delete(key);
  }
  async list(prefix: string) {
    return [...this.docs.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}

let current: KV | null = null;
export function kv(): KV {
  if (!current) current = new BlobsKV();
  return current;
}
export function setKV(k: KV) {
  current = k;
}

/**
 * Read-modify-write with retry. `fn` gets the current value (or null) and
 * returns the new value, or `undefined` to leave it unchanged.
 * Returns the value that was saved (or the unchanged current value).
 */
export async function update<T>(key: string, fn: (cur: T | null) => T | undefined | Promise<T | undefined>): Promise<T | null> {
  for (let i = 0; i < 8; i++) {
    const cur = await kv().getJSON<T>(key);
    const next = await fn(cur ? structuredClone(cur.data) : null);
    if (next === undefined) return cur?.data ?? null;
    const ok = cur
      ? await kv().setJSON(key, next, { onlyIfMatch: cur.etag })
      : await kv().setJSON(key, next, { onlyIfNew: true });
    if (ok) return next;
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
  }
  throw new Error(`Could not save ${key}: too many simultaneous changes. Please try again.`);
}

export async function getJSON<T>(key: string): Promise<T | null> {
  return (await kv().getJSON<T>(key))?.data ?? null;
}

export async function putJSON(key: string, data: unknown) {
  await kv().setJSON(key, data);
}
