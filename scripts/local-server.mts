/**
 * Local test server (no Netlify account needed):
 *   node --experimental-strip-types scripts/local-server.mts
 * Serves public/ and the same /api code, keeps data in memory, and runs the
 * scheduler every 20s. With MOCK_PLATFORMS=1 it fakes YouTube + Instagram so
 * you can watch a video go all the way to "published" without real accounts.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { handle } from "../netlify/lib/api.mts";
import { runScheduler } from "../netlify/lib/queue.mts";
import { MemoryKV, setKV } from "../netlify/lib/store.mts";

setKV(new MemoryKV());
const PORT = Number(process.env.PORT || 8888);
process.env.URL ||= `http://localhost:${PORT}`;
const PUBLIC = new URL("../public/", import.meta.url).pathname;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };

if (process.env.MOCK_PLATFORMS) {
  const realFetch = globalThis.fetch;
  const received: Record<string, number> = {};
  let igPolls = 0;
  let channelCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const h = u.host;
    if (h === "oauth2.googleapis.com") return Response.json({ access_token: "ya29.mock", refresh_token: "1//mock", expires_in: 3600 });
    if (h === "www.googleapis.com" && u.pathname.endsWith("/channels")) {
      const n = ++channelCalls; // a different fake channel each time you connect
      return Response.json({ items: [{ id: `UCmock${n}`, snippet: { title: `Mock Channel ${n}` } }] });
    }
    if (h === "www.googleapis.com" && req.method === "POST") {
      received.yt = 0;
      return new Response(null, { headers: { Location: "https://upload.mock/session/1" } });
    }
    if (h === "upload.mock") {
      if (!req.headers.get("Content-Range")) return new Response(null, { status: 400 });
      const cr = req.headers.get("Content-Range")!;
      const total = Number(cr.split("/")[1]);
      if (cr.startsWith("bytes */")) return new Response(null, { status: 308, headers: received.yt ? { Range: `bytes=0-${received.yt - 1}` } : {} });
      const end = Number(cr.split("-")[1].split("/")[0]);
      received.yt = end + 1;
      return received.yt >= total ? Response.json({ id: "MockYT123" }) : new Response(null, { status: 308, headers: { Range: `bytes=0-${end}` } });
    }
    if (h === "rupload.facebook.com") return Response.json({ success: true });
    if (h === "graph.instagram.com") {
      if (u.pathname.endsWith("content_publishing_limit")) return Response.json({ data: [{ quota_usage: 0, config: { quota_total: 50 } }] });
      if (u.pathname.endsWith("/media") && req.method === "POST") return Response.json({ id: "C1" });
      if (u.pathname.endsWith("/C1")) return Response.json({ status_code: ++igPolls % 2 === 0 ? "FINISHED" : "IN_PROGRESS" });
      if (u.pathname.endsWith("media_publish")) return Response.json({ id: "M1" });
      if (u.pathname.endsWith("/M1")) return Response.json({ permalink: "https://instagram.com/reel/mock" });
      if (u.pathname.endsWith("/me")) {
        const tok = u.searchParams.get("access_token") ?? "x";
        return Response.json({ user_id: `17${tok}`, username: `mock_${tok.toLowerCase()}`, account_type: "BUSINESS" });
      }
      if (u.pathname.endsWith("refresh_access_token")) return Response.json({ access_token: "IGmock2", expires_in: 5184000 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await handle(new Request(url, {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks),
    }), { waitUntil: (p) => void p });
    const out: Record<string, string | string[]> = {};
    r.headers.forEach((v, k) => { if (k !== "set-cookie") out[k] = v; });
    const sc = r.headers.getSetCookie();
    if (sc.length) out["set-cookie"] = sc;
    res.writeHead(r.status, out);
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const path = normalize(join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname));
  if (!path.startsWith(PUBLIC)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(path);
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" }).end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}).listen(PORT, () => console.log(`Local test server: http://localhost:${PORT}`));

setInterval(() => runScheduler(15000).then((s) => s && console.log(`scheduler: ${s} steps`)).catch(console.error), 20000);
