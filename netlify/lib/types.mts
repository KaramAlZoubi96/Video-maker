export type Platform = "youtube" | "instagram";
export const PLATFORMS: Platform[] = ["youtube", "instagram"];
export const platformName = (p: Platform) => (p === "youtube" ? "YouTube" : "Instagram");

export interface Post {
  status: "pending" | "uploading" | "published" | "failed";
  attempts: number;
  nextAttemptAt?: string | null;
  lastError?: string | null;
  note?: string | null;
  remoteId?: string | null;
  url?: string | null;
  resume: Record<string, any>;
  startedAt?: string | null;
  publishedAt?: string | null;
}

export interface Video {
  id: string;
  uploader: string;
  fileName: string;
  title: string;
  description: string;
  size: number;
  chunkSize: number;
  chunkCount: number;
  width: number;
  height: number;
  duration: number;
  status: "uploading" | "ready";
  position: number;
  releasedAt?: string | null;
  createdAt: string;
  filesDeleted?: boolean;
  posts: Partial<Record<Platform, Post>>;
}

export interface Account {
  platform: Platform;
  displayName: string;
  remoteUserId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
  tokenRefreshedAt?: string | null;
  status: "ok" | "error";
  error?: string | null;
}

export interface Settings {
  timezone: string;
  slots: string[];
  youtubePrivacy: "public" | "unlisted" | "private";
  addShortsTag: boolean;
  lastSlotRun?: string | null;
  lastMaintenance?: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  timezone: "UTC",
  slots: ["12:00", "19:00"],
  youtubePrivacy: "public",
  addShortsTag: true,
};

export interface User {
  username: string;
  hash: string;
  createdAt: string;
}

// ---- limits ---------------------------------------------------------------
export const CHUNK_SIZE = 4 * 1024 * 1024; // 4 MiB: under Netlify's 6 MB request limit, multiple of 256 KiB for YouTube
export const MAX_FILE_BYTES = 150 * 1024 * 1024;
export const MIN_DURATION = 3;
export const MAX_DURATION = 180;
export const TITLE_MAX = 100;
export const DESC_MAX = 2000;

export const config = {
  googleClientId: () => process.env.GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: () => process.env.GOOGLE_CLIENT_SECRET ?? "",
  igAppId: () => process.env.INSTAGRAM_APP_ID ?? "",
  igAppSecret: () => process.env.INSTAGRAM_APP_SECRET ?? "",
  igApiVersion: () => process.env.INSTAGRAM_API_VERSION || "v23.0",
  siteUrl: () => (process.env.SITE_URL || process.env.URL || "http://localhost:8888").replace(/\/$/, ""),
  ytDailyLimit: () => Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT || 6),
  maxAttempts: () => Number(process.env.MAX_ATTEMPTS || 4),
};

// ---- errors ---------------------------------------------------------------
export class PublishError extends Error {}
/** Network hiccup / server error: retry later. */
export class TransientError extends PublishError {}
/** The platform rejected this video: retrying won't help. */
export class PermanentError extends PublishError {}
/** Account connection broken: reconnect in Settings. */
export class AuthError extends PermanentError {}
/** Not an error: wait until `until` (quota / rate limits). */
export class DeferError extends PublishError {
  until: Date;
  constructor(message: string, until: Date) {
    super(message);
    this.until = until;
  }
}

export interface StepContext {
  video: Video;
  resume: Record<string, any>;
  saveResume(r: Record<string, any>): Promise<void>;
  readRange(start: number, length: number): Promise<Uint8Array<ArrayBuffer>>;
  /** ms timestamp: stop starting new work after this. */
  deadline: number;
  title: string;
  description: string;
  youtubePrivacy: string;
  fetch: typeof fetch;
}

export type StepResult = { done: true; remoteId: string; url: string | null } | { done: false; note: string };
