import { beforeEach } from "vitest";
import { MemoryKV, setKV } from "../netlify/lib/store.mts";
import {
  CHUNK_SIZE, type Video,
} from "../netlify/lib/types.mts";
import { chunkKey, videoKey } from "../netlify/lib/queue.mts";
import { kv } from "../netlify/lib/store.mts";

process.env.SECRET_KEY = "test-secret";
process.env.GOOGLE_CLIENT_ID = "gid";
process.env.GOOGLE_CLIENT_SECRET = "gsecret";
process.env.URL = "https://site.netlify.app";

export function freshStore() {
  beforeEach(() => setKV(new MemoryKV()));
}

/** fetch() that answers with a handler: (req) => Response */
export function fakeFetch(handler: (req: Request) => Response | Promise<Response>): typeof fetch {
  return (async (input: any, init?: any) => handler(new Request(input, init))) as typeof fetch;
}

export async function addVideo(opts: Partial<Video> & { platforms?: string[]; bytes?: Uint8Array } = {}): Promise<Video> {
  const bytes = opts.bytes ?? new Uint8Array(100).fill(7);
  const id = opts.id ?? Math.random().toString(36).slice(2, 10);
  const posts: Video["posts"] = {};
  for (const p of opts.platforms ?? ["youtube", "instagram"]) (posts as any)[p] = { status: "pending", attempts: 0, resume: {} };
  const chunkSize = opts.chunkSize ?? CHUNK_SIZE;
  const v: Video = {
    id, uploader: "me", fileName: "a.mp4", title: "T", description: "D", size: bytes.length, chunkSize,
    chunkCount: Math.ceil(bytes.length / chunkSize), width: 1080, height: 1920, duration: 10, status: "ready",
    position: opts.position ?? 1, createdAt: new Date().toISOString(), posts, pageId: "p1", ...opts,
  } as Video;
  delete (v as any).platforms; delete (v as any).bytes;
  await kv().setJSON(videoKey(id), v);
  for (let n = 0; n < v.chunkCount; n++) await kv().setBytes(chunkKey(id, n), bytes.slice(n * chunkSize, (n + 1) * chunkSize));
  return v;
}
