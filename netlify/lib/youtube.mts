/**
 * YouTube Shorts upload (YouTube Data API v3, resumable upload), done in steps.
 *
 * Each scheduler run sends as many 4 MB pieces as fit in its time budget and
 * saves the position. The next run continues from the exact byte YouTube has,
 * so an interruption never creates a second copy of the video.
 */
import { nextQuotaReset } from "./time.mts";
import {
  AuthError, DeferError, PermanentError, type StepContext, type StepResult, TransientError, CHUNK_SIZE,
} from "./types.mts";

const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";
const QUOTA_REASONS = new Set(["quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded", "rateLimitExceeded"]);

export const cleanTitle = (t: string) => (t.replace(/[<>]/g, "").trim() || "Short").slice(0, 100);

export function cleanDescription(t: string) {
  const bytes = new TextEncoder().encode(t.replace(/[<>]/g, ""));
  return new TextDecoder().decode(bytes.slice(0, 5000)).replace(/�+$/, "");
}

async function errorText(resp: Response) {
  try {
    const j: any = await resp.clone().json();
    return { msg: j?.error?.message ?? j?.error_description ?? JSON.stringify(j).slice(0, 300), reasons: (j?.error?.errors ?? []).map((e: any) => e.reason) };
  } catch {
    return { msg: (await resp.text()).slice(0, 300) || resp.statusText, reasons: [] as string[] };
  }
}

export async function checkYouTube(resp: Response): Promise<void> {
  if (resp.ok || resp.status === 308) return;
  const { msg, reasons } = await errorText(resp);
  if (resp.status === 403 && reasons.some((r: string) => QUOTA_REASONS.has(r))) {
    throw new DeferError("YouTube daily limit reached - will continue after it resets.", nextQuotaReset());
  }
  if (resp.status === 403 && reasons.some((r: string) => r === "forbidden" || r === "insufficientPermissions")) {
    throw new AuthError("YouTube refused access. Reconnect YouTube in Settings.");
  }
  if (resp.status === 401) throw new AuthError("YouTube login expired or was revoked. Reconnect YouTube in Settings.");
  if (resp.status === 408 || resp.status === 429 || resp.status >= 500) throw new TransientError(`YouTube error ${resp.status}: ${msg}`);
  throw new PermanentError(`YouTube error ${resp.status}: ${msg}`);
}

const rangeEnd = (resp: Response) => {
  const r = resp.headers.get("Range");
  return r ? Number(r.split("-").pop()) + 1 : 0;
};

export class YouTubeUploader {
  private getToken: (force: boolean) => Promise<string>;
  constructor(getToken: (force: boolean) => Promise<string>) {
    this.getToken = getToken;
  }

  private async send(ctx: StepContext, url: string, init: RequestInit): Promise<Response> {
    for (const force of [false, true]) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${await this.getToken(force)}`);
      let resp: Response;
      try {
        resp = await ctx.fetch(url, { ...init, headers, signal: AbortSignal.timeout(20000) });
      } catch (e: any) {
        throw new TransientError(`Network problem talking to YouTube: ${e?.message ?? e}`);
      }
      if (resp.status !== 401) return resp;
    }
    throw new AuthError("YouTube login expired or was revoked. Reconnect YouTube in Settings.");
  }

  /** Ask YouTube how many bytes it has. Returns offset, a finished result, or null if the session expired. */
  private async queryOffset(ctx: StepContext, session: string, size: number): Promise<number | StepResult | null> {
    const resp = await this.send(ctx, session, { method: "PUT", headers: { "Content-Range": `bytes */${size}` } });
    if (resp.status === 200 || resp.status === 201) return this.finished(resp);
    if (resp.status === 308) return rangeEnd(resp);
    if (resp.status === 404 || resp.status === 410) return null;
    await checkYouTube(resp);
    throw new TransientError(`Unexpected YouTube status ${resp.status}`);
  }

  private async finished(resp: Response): Promise<StepResult> {
    const j: any = await resp.json();
    return { done: true, remoteId: j.id, url: `https://youtube.com/shorts/${j.id}` };
  }

  /** Start an upload session. Caller has already checked the daily limit. */
  async start(ctx: StepContext): Promise<string> {
    const resp = await this.send(ctx, `${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": "video/*",
        "X-Upload-Content-Length": String(ctx.video.size),
      },
      body: JSON.stringify({
        snippet: { title: cleanTitle(ctx.title), description: cleanDescription(ctx.description), categoryId: "22" },
        status: { privacyStatus: ctx.youtubePrivacy, selfDeclaredMadeForKids: false, embeddable: true },
      }),
    });
    await checkYouTube(resp);
    const session = resp.headers.get("Location");
    if (!session) throw new TransientError("YouTube did not return an upload session.");
    await ctx.saveResume({ session, offset: 0 });
    return session;
  }

  async step(ctx: StepContext, onSessionStart: () => Promise<void>): Promise<StepResult> {
    const size = ctx.video.size;
    let { session, offset, needsQuery } = ctx.resume as { session?: string; offset?: number; needsQuery?: boolean };

    if (session && (needsQuery || offset == null)) {
      const st = await this.queryOffset(ctx, session, size);
      if (st === null) {
        await ctx.saveResume({});
        session = undefined;
      } else if (typeof st !== "number") {
        return st;
      } else {
        offset = st;
        await ctx.saveResume({ session, offset });
      }
    }
    if (!session) {
      await onSessionStart();
      session = await this.start(ctx);
      offset = 0;
    }

    let stalls = 0;
    while (Date.now() < ctx.deadline) {
      const start = offset ?? 0;
      const len = Math.min(CHUNK_SIZE, size - start);
      const bytes = await ctx.readRange(start, len);
      let resp: Response;
      try {
        resp = await this.send(ctx, session, {
          method: "PUT",
          headers: { "Content-Range": `bytes ${start}-${start + len - 1}/${size}` },
          body: bytes,
        });
        if (resp.status >= 500) throw new TransientError(`YouTube server error ${resp.status}`);
      } catch (e) {
        if (e instanceof TransientError) await ctx.saveResume({ session, offset: start, needsQuery: true });
        throw e;
      }
      if (resp.status === 200 || resp.status === 201) return this.finished(resp);
      if (resp.status === 308) {
        const next = rangeEnd(resp);
        if (next <= start && ++stalls > 3) {
          await ctx.saveResume({ session, needsQuery: true });
          throw new TransientError("YouTube upload is not making progress.");
        }
        offset = next;
        await ctx.saveResume({ session, offset });
        continue;
      }
      await checkYouTube(resp);
      throw new PermanentError(`Unexpected YouTube response ${resp.status}`);
    }
    return { done: false, note: `Uploading to YouTube… ${Math.floor(((offset ?? 0) / size) * 100)}%` };
  }
}
