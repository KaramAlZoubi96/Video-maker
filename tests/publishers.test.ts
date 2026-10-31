import { describe, expect, it } from "vitest";
import { cleanCaption, InstagramUploader } from "../netlify/lib/instagram.mts";
import {
  AuthError, DeferError, PermanentError, type StepContext, TransientError, type Video,
} from "../netlify/lib/types.mts";
import { YouTubeUploader } from "../netlify/lib/youtube.mts";
import { fakeFetch } from "./helpers.ts";

function ctx(fetchImpl: typeof fetch, opts: { size?: number; resume?: any; deadlineMs?: number } = {}) {
  const size = opts.size ?? 100;
  const bytes = new Uint8Array(size).map((_, i) => i % 256);
  const saved: any[] = [];
  const c: StepContext = {
    video: { id: "v1", size } as Video,
    resume: opts.resume ?? {},
    saveResume: async (r) => { saved.push(r); c.resume = r; },
    readRange: async (s, l) => bytes.slice(s, s + l),
    deadline: Date.now() + (opts.deadlineMs ?? 20000),
    title: "Hi <there>", description: "desc", youtubePrivacy: "public", fetch: fetchImpl,
  };
  return { c, saved };
}
const yt = (force: boolean[] = []) => new YouTubeUploader(async (f) => { force.push(f); return "tok"; });
const noop = async () => {};

describe("YouTube", () => {
  it("uploads and saves the session", async () => {
    const f = fakeFetch(async (req) => {
      if (req.method === "POST") {
        const b = await req.json();
        expect(b.snippet.title).toBe("Hi there");
        expect(req.headers.get("X-Upload-Content-Length")).toBe("100");
        return new Response(null, { status: 200, headers: { Location: "https://up/s1" } });
      }
      expect(req.headers.get("Content-Range")).toBe("bytes 0-99/100");
      return Response.json({ id: "abc" });
    });
    const { c, saved } = ctx(f);
    let started = 0;
    const r = await yt().step(c, async () => { started++; });
    expect(r).toEqual({ done: true, remoteId: "abc", url: "https://youtube.com/shorts/abc" });
    expect(saved[0]).toEqual({ session: "https://up/s1", offset: 0 });
    expect(started).toBe(1);
  });

  it("resumes an existing session from YouTube's offset (no second upload)", async () => {
    const sent: string[] = [];
    const f = fakeFetch((req) => {
      expect(req.method).toBe("PUT");
      const cr = req.headers.get("Content-Range")!;
      if (cr === "bytes */100") return new Response(null, { status: 308, headers: { Range: "bytes=0-59" } });
      sent.push(cr);
      return Response.json({ id: "v2" }, { status: 201 });
    });
    const { c } = ctx(f, { resume: { session: "https://up/s", needsQuery: true } });
    let started = 0;
    const r = await yt().step(c, async () => { started++; });
    expect(r.done && r.remoteId).toBe("v2");
    expect(sent).toEqual(["bytes 60-99/100"]);
    expect(started).toBe(0);
  });

  it("continues across runs when time runs out", async () => {
    const f = fakeFetch((req) => {
      const cr = req.headers.get("Content-Range")!;
      const end = Number(cr.split("-")[1].split("/")[0]);
      return new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
    });
    const size = 9 * 1024 * 1024;
    const { c } = ctx(f, { size, resume: { session: "https://up/s", offset: 0 }, deadlineMs: 0 });
    c.deadline = Date.now() - 1; // already out of time: should not send
    const r = await yt().step(c, noop);
    expect(r.done).toBe(false);
  });

  it("quota error waits instead of failing", async () => {
    const f = fakeFetch(() => Response.json({ error: { message: "q", errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }));
    await expect(yt().step(ctx(f).c, noop)).rejects.toBeInstanceOf(DeferError);
  });

  it("refreshes the login once on 401, then reports auth problem", async () => {
    const force: boolean[] = [];
    const f = fakeFetch(() => new Response(null, { status: 401 }));
    await expect(yt(force).step(ctx(f).c, noop)).rejects.toBeInstanceOf(AuthError);
    expect(force).toEqual([false, true]);
  });

  it("server error mid-upload saves position for next run", async () => {
    const f = fakeFetch((req) => req.method === "POST"
      ? new Response(null, { headers: { Location: "https://up/s" } })
      : new Response(null, { status: 503 }));
    const { c, saved } = ctx(f);
    await expect(yt().step(c, noop)).rejects.toBeInstanceOf(TransientError);
    expect(saved.at(-1)).toEqual({ session: "https://up/s", offset: 0, needsQuery: true });
  });

  it("bad request is permanent; network error is temporary", async () => {
    await expect(yt().step(ctx(fakeFetch(() => Response.json({ error: { message: "bad" } }, { status: 400 }))).c, noop))
      .rejects.toBeInstanceOf(PermanentError);
    await expect(yt().step(ctx(fakeFetch(() => { throw new TypeError("down"); })).c, noop))
      .rejects.toBeInstanceOf(TransientError);
  });

  it("expired session starts a new one", async () => {
    let posts = 0;
    const f = fakeFetch((req) => {
      if (req.method === "POST") { posts++; return new Response(null, { headers: { Location: "https://up/new" } }); }
      if (req.headers.get("Content-Range") === "bytes */100") return new Response(null, { status: 404 });
      return Response.json({ id: "fresh" });
    });
    const r = await yt().step(ctx(f, { resume: { session: "https://up/old", needsQuery: true } }).c, noop);
    expect(r.done && r.remoteId).toBe("fresh");
    expect(posts).toBe(1);
  });
});

class FakeIG {
  statuses: string[];
  published = 0; created = 0; uploaded = 0; usage = 0;
  constructor(statuses = ["FINISHED"]) { this.statuses = statuses; }
  fetch = fakeFetch(async (req) => {
    const u = new URL(req.url);
    if (u.host === "rupload.facebook.com") {
      expect(req.headers.get("Authorization")).toBe("OAuth tok");
      expect(req.headers.get("file_size")).toBe("100");
      expect((await req.arrayBuffer()).byteLength).toBe(100);
      this.uploaded++;
      return Response.json({ success: true });
    }
    if (u.pathname.endsWith("/content_publishing_limit")) return Response.json({ data: [{ quota_usage: this.usage, config: { quota_total: 50 } }] });
    if (u.pathname.endsWith("/17/media") && req.method === "POST") { this.created++; return Response.json({ id: "C1" }); }
    if (u.pathname.endsWith("/17/media")) return Response.json({ data: [{ id: "M9", caption: "desc", permalink: "https://ig/p/M9" }] });
    if (u.pathname.endsWith("/C1")) {
      const s = this.statuses.length > 1 ? this.statuses.shift()! : this.statuses[0];
      return Response.json({ status_code: s, status: s === "ERROR" ? "bad codec" : "" });
    }
    if (u.pathname.endsWith("/media_publish")) { this.published++; return Response.json({ id: "M1" }); }
    if (u.pathname.endsWith("/M1")) return Response.json({ permalink: "https://ig/p/M1" });
    return Response.json({ error: { message: "nope" } }, { status: 404 });
  });
}
const ig = () => new InstagramUploader("tok", "17");

describe("Instagram", () => {
  it("full flow over several runs: upload → processing → publish", async () => {
    const fake = new FakeIG(["IN_PROGRESS", "FINISHED"]);
    const { c } = ctx(fake.fetch);
    const r1 = await ig().step(c);
    expect(r1.done).toBe(false);
    expect(c.resume.step).toBe("processing");
    expect(await ig().step(c)).toEqual({ done: false, note: "Instagram is processing the video…" });
    const r3 = await ig().step(c);
    expect(r3).toEqual({ done: true, remoteId: "M1", url: "https://ig/p/M1" });
    expect([fake.created, fake.uploaded, fake.published]).toEqual([1, 1, 1]);
  });

  it("no double post after an interruption during publish", async () => {
    const fake = new FakeIG(["PUBLISHED"]);
    const r = await ig().step(ctx(fake.fetch, { resume: { containerId: "C1", step: "publishing" } }).c);
    expect(r.done && r.remoteId).toBe("M9");
    expect(fake.published).toBe(0);
    expect(fake.created).toBe(0);
  });

  it("processing error is permanent", async () => {
    const fake = new FakeIG(["ERROR"]);
    await expect(ig().step(ctx(fake.fetch, { resume: { containerId: "C1", step: "processing" } }).c)).rejects.toThrow(/bad codec/);
    expect(fake.published).toBe(0);
  });

  it("waits for the next run if too little time is left to upload", async () => {
    const fake = new FakeIG();
    const r = await ig().step(ctx(fake.fetch, { deadlineMs: 2000 }).c);
    expect(r.done).toBe(false);
    expect(fake.created).toBe(0);
  });

  it("daily post limit waits", async () => {
    const fake = new FakeIG();
    fake.usage = 50;
    await expect(ig().step(ctx(fake.fetch).c)).rejects.toBeInstanceOf(DeferError);
    expect(fake.created).toBe(0);
  });

  it("expired token is an auth problem", async () => {
    const f = fakeFetch(() => Response.json({ error: { code: 190, message: "expired" } }, { status: 400 }));
    await expect(ig().step(ctx(f).c)).rejects.toBeInstanceOf(AuthError);
  });

  it("caption limits", () => {
    const text = Array.from({ length: 40 }, (_, i) => `#t${i}`).join(" ");
    expect(cleanCaption(text).match(/#/g)!.length).toBe(30);
    expect(cleanCaption("a".repeat(3000)).length).toBe(2200);
  });
});
