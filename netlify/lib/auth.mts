/** Logins for you and your friend: bcrypt passwords + signed session cookie. */
import bcrypt from "bcryptjs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getJSON, kv, update } from "./store.mts";
import {
  type User,
} from "./types.mts";

const COOKIE = "sap_session";
const SESSION_DAYS = 30;

let cachedSecret: string | null = null;
async function secret(): Promise<string> {
  if (process.env.SECRET_KEY) return process.env.SECRET_KEY;
  if (cachedSecret) return cachedSecret;
  // No SECRET_KEY set: create one once and keep it in storage.
  await kv().setJSON("secret", { key: randomBytes(48).toString("base64url") }, { onlyIfNew: true });
  cachedSecret = (await getJSON<{ key: string }>("secret"))!.key;
  return cachedSecret;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString();

export async function sign(payload: object): Promise<string> {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", await secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export async function verify<T>(token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = createHmac("sha256", await secret()).update(body).digest();
  const got = Buffer.from(mac, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const data = JSON.parse(unb64(body));
    if (typeof data.exp === "number" && data.exp < Date.now()) return null;
    return data as T;
  } catch {
    return null;
  }
}

export function getCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function cookieHeader(req: Request, name: string, value: string, maxAgeSec: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export const userKey = (username: string) => `users/${username.trim().toLowerCase()}`;

export async function userCount(): Promise<number> {
  return (await kv().list("users/")).length;
}

export async function listUsers(): Promise<{ username: string; createdAt: string }[]> {
  const out = [];
  for (const k of await kv().list("users/")) {
    const u = await getJSON<User>(k);
    if (u) out.push({ username: u.username, createdAt: u.createdAt });
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function validateNewUser(username: string, password: string): string | null {
  const u = username.trim();
  if (!/^[A-Za-z0-9_-]{2,32}$/.test(u)) return "Username: 2-32 letters/numbers (- and _ allowed).";
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password.length > 72) return "Password is too long (max 72 characters).";
  return null;
}

/** Returns an error message, or null when created. */
export async function createUser(username: string, password: string): Promise<string | null> {
  const err = validateNewUser(username, password);
  if (err) return err;
  const user: User = { username: username.trim(), hash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString() };
  const ok = await kv().setJSON(userKey(username), user, { onlyIfNew: true });
  return ok ? null : "That username is already taken.";
}

export async function setPassword(username: string, password: string) {
  const hash = await bcrypt.hash(password, 10);
  await update<User>(userKey(username), (u) => (u ? { ...u, hash, sessionVersion: (u.sessionVersion ?? 0) + 1 } : undefined));
}

/** 5 wrong passwords per username per 10 minutes. */
async function tooManyAttempts(username: string, failed: boolean): Promise<boolean> {
  const key = `ratelimit/${username.trim().toLowerCase()}`;
  const window = 10 * 60_000;
  const cur = (await getJSON<{ n: number; since: number }>(key)) ?? { n: 0, since: Date.now() };
  const fresh = Date.now() - cur.since > window ? { n: 0, since: Date.now() } : cur;
  if (!failed) return fresh.n >= 5;
  await kv().setJSON(key, { n: fresh.n + 1, since: fresh.since });
  return false;
}

export type LoginResult = { ok: true; username: string } | { ok: false; error: string };

export async function authenticate(username: string, password: string): Promise<LoginResult> {
  if (!username.trim()) return { ok: false, error: "Wrong username or password." };
  if (await tooManyAttempts(username, false)) {
    return { ok: false, error: "Too many wrong passwords. Wait 10 minutes and try again." };
  }
  const user = await getJSON<User>(userKey(username));
  if (user && (await bcrypt.compare(password.slice(0, 72), user.hash))) {
    await kv().delete(`ratelimit/${username.trim().toLowerCase()}`);
    return { ok: true, username: user.username };
  }
  await tooManyAttempts(username, true);
  return { ok: false, error: "Wrong username or password." };
}

export async function sessionCookie(req: Request, username: string): Promise<string> {
  const user = await getJSON<User>(userKey(username));
  const token = await sign({ u: username, v: user?.sessionVersion ?? 0, exp: Date.now() + SESSION_DAYS * 86400_000 });
  return cookieHeader(req, COOKIE, token, SESSION_DAYS * 86400);
}

export const clearSessionCookie = (req: Request) => cookieHeader(req, COOKIE, "", 0);

export async function currentUser(req: Request): Promise<string | null> {
  const s = await verify<{ u: string; v?: number }>(getCookie(req, COOKIE));
  if (!s) return null;
  const user = await getJSON<User>(userKey(s.u));
  if (!user || (s.v ?? 0) !== (user.sessionVersion ?? 0)) return null;
  return user.username;
}

/** Blocks other websites from sending actions in your name. */
export function sameOrigin(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  if (origin) {
    try {
      return new URL(origin).host === host || new URL(origin).host === new URL(req.url).host;
    } catch {
      return false;
    }
  }
  return req.headers.get("x-requested-with") === "fetch";
}
