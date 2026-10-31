/**
 * Instagram Reels (Instagram API with Instagram Login), done in steps:
 *   1. create a container (resumable)  2. upload the file bytes directly
 *   3. wait while Instagram processes it (checked once per run)  4. publish.
 *
 * No double posts: before publishing again after an interruption we check the
 * container; if it's already PUBLISHED we just look up the post.
 */
import {
  AuthError, DeferError, PermanentError, PublishError, type StepContext, type StepResult, TransientError,
} from "./types.mts";

const GRAPH = "https://graph.instagram.com";
const RUPLOAD = "https://rupload.facebook.com/ig-api-upload";
const PROCESSING_TIMEOUT_MS = 30 * 60 * 1000;
/** Minimum time left in this run to start the file upload. */
export const IG_UPLOAD_MIN_MS = 15000;

export function cleanCaption(text: string): string {
  let tags = 0;
  const out: string[] = [];
  for (const w of text.split(" ")) {
    const n = (w.match(/#/g) || []).length;
    if (n && tags + n > 30) continue;
    tags += n;
    out.push(w);
  }
  return out.join(" ").slice(0, 2200);
}

export async function checkInstagram(resp: Response): Promise<void> {
  if (resp.ok) return;
  let err: any = {};
  try {
    err = ((await resp.clone().json()) as any)?.error ?? {};
  } catch {
    /* not json */
  }
  const msg = err.error_user_msg || err.message || (await resp.text()).slice(0, 300);
  const code = err.code;
  if (code === 190 || resp.status === 401) {
    throw new AuthError(`Instagram login expired or was revoked. Reconnect Instagram in Settings. (${msg})`);
  }
  if ([4, 17, 32, 613].includes(code) || resp.status === 429) {
    throw new DeferError(`Instagram rate limit reached: ${msg}`, new Date(Date.now() + 3600_000));
  }
  if (code === 1 || code === 2 || err.is_transient || resp.status >= 500) {
    throw new TransientError(`Instagram temporary error: ${msg}`);
  }
  throw new PermanentError(`Instagram error ${resp.status}: ${msg}`);
}

export class InstagramUploader {
  private token: string;
  private userId: string;
  private v: string;
  constructor(token: string, userId: string, v = "v23.0") {
    this.token = token;
    this.userId = userId;
    this.v = v;
  }

  private async req(ctx: StepContext, url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<any> {
    let resp: Response;
    try {
      resp = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e: any) {
      throw new TransientError(`Network problem talking to Instagram: ${e?.message ?? e}`);
    }
    await checkInstagram(resp);
    return resp.json();
  }

  private graph(ctx: StepContext, method: "GET" | "POST", path: string, params: Record<string, string>) {
    const p = new URLSearchParams({ ...params, access_token: this.token });
    const url = `${GRAPH}/${this.v}/${path}`;
    return method === "GET"
      ? this.req(ctx, `${url}?${p}`)
      : this.req(ctx, url, { method: "POST", body: p });
  }

  private async checkLimit(ctx: StepContext) {
    const d = await this.graph(ctx, "GET", `${this.userId}/content_publishing_limit`, { fields: "quota_usage,config" });
    const item = d?.data?.[0] ?? {};
    const usage = item.quota_usage ?? 0;
    const total = item.config?.quota_total ?? 50;
    if (usage >= total) {
      throw new DeferError(`Instagram daily post limit reached (${usage}/${total}).`, new Date(Date.now() + 3600_000));
    }
  }

  private async status(ctx: StepContext, containerId: string): Promise<string> {
    const d = await this.graph(ctx, "GET", containerId, { fields: "status_code,status" });
    return d.status_code === "ERROR" ? `ERROR:${d.status || "unknown error"}` : d.status_code ?? "";
  }

  private async findPublished(ctx: StepContext, caption: string): Promise<StepResult> {
    try {
      const d = await this.graph(ctx, "GET", `${this.userId}/media`, { fields: "id,caption,permalink", limit: "10" });
      const hit = (d.data ?? []).find((m: any) => (m.caption ?? "") === caption);
      if (hit) return { done: true, remoteId: hit.id, url: hit.permalink ?? null };
    } catch (e) {
      if (!(e instanceof PublishError)) throw e;
    }
    return { done: true, remoteId: "unknown", url: null };
  }

  private async publish(ctx: StepContext, containerId: string): Promise<StepResult> {
    await ctx.saveResume({ ...ctx.resume, containerId, step: "publishing" });
    const d = await this.graph(ctx, "POST", `${this.userId}/media_publish`, { creation_id: containerId });
    if (!d.id) throw new TransientError("Instagram did not confirm the post.");
    let url: string | null = null;
    try {
      url = (await this.graph(ctx, "GET", d.id, { fields: "permalink" })).permalink ?? null;
    } catch {
      /* link is optional */
    }
    return { done: true, remoteId: d.id, url };
  }

  async step(ctx: StepContext): Promise<StepResult> {
    const caption = cleanCaption(ctx.description);
    const r = ctx.resume as { containerId?: string; step?: string; processingSince?: string };

    // Waiting for processing / interrupted while publishing.
    if (r.containerId && (r.step === "processing" || r.step === "publishing")) {
      const st = await this.status(ctx, r.containerId);
      if (st === "PUBLISHED") return this.findPublished(ctx, caption);
      if (st.startsWith("ERROR:")) {
        await ctx.saveResume({});
        throw new PermanentError(`Instagram could not process the video: ${st.slice(6)}`);
      }
      if (st === "EXPIRED") {
        await ctx.saveResume({});
        throw new TransientError("Instagram upload expired before publishing; will upload again.");
      }
      if (st === "FINISHED") return this.publish(ctx, r.containerId);
      const since = Date.parse(r.processingSince ?? "") || Date.now();
      if (Date.now() - since > PROCESSING_TIMEOUT_MS) {
        await ctx.saveResume({});
        throw new TransientError("Instagram took too long to process the video; will upload again.");
      }
      return { done: false, note: "Instagram is processing the video…" };
    }

    // Fresh start (or the app stopped during the byte upload: start a new container,
    // the old unpublished one simply expires).
    if (ctx.deadline - Date.now() < IG_UPLOAD_MIN_MS) {
      return { done: false, note: "Waiting for the next run to upload to Instagram…" };
    }
    await this.checkLimit(ctx);
    const created = await this.graph(ctx, "POST", `${this.userId}/media`, {
      media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true",
    });
    if (!created.id) throw new TransientError("Instagram did not return a container id.");
    const containerId: string = created.id;
    await ctx.saveResume({ containerId, step: "uploading" });

    const bytes = await ctx.readRange(0, ctx.video.size);
    const timeLeft = Math.max(ctx.deadline - Date.now() + 5000, 10000);
    await this.req(ctx, `${RUPLOAD}/${this.v}/${containerId}`, {
      method: "POST",
      headers: {
        Authorization: `OAuth ${this.token}`,
        offset: "0",
        file_size: String(ctx.video.size),
        "Content-Type": "application/octet-stream",
      },
      body: bytes,
    }, timeLeft);
    await ctx.saveResume({ containerId, step: "processing", processingSince: new Date().toISOString() });
    return { done: false, note: "Instagram is processing the video…" };
  }
}
