// Builds the finished vertical video in the browser: background clip + Reddit card + word captions + voice.
// Uses the browser's own video encoder (WebCodecs) and writes a normal MP4 (H.264 + AAC when available).
import { ArrayBufferTarget, Muxer } from "/vendor/mp4-muxer.mjs";
import { captionGroups, formatCount } from "./storylib.js";

export const W = 1080, H = 1920, FPS = 30;
const OUT_RATE = 48000;

/** Can this browser make videos? Returns {ok, audioCodec, reason}. */
export async function checkSupport() {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return { ok: false, reason: "This browser can't make videos. Please use Google Chrome or Microsoft Edge on a computer." };
  }
  const v = await VideoEncoder.isConfigSupported(videoConfig()).catch(() => ({ supported: false }));
  if (!v.supported) return { ok: false, reason: "This browser can't encode HD video. Please update Chrome or Edge." };
  for (const [codec, muxCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const a = await AudioEncoder.isConfigSupported(audioConfig(codec)).catch(() => ({ supported: false }));
    if (a.supported) return { ok: true, audioCodec: codec, muxCodec };
  }
  return { ok: false, reason: "This browser can't encode audio. Please update Chrome or Edge." };
}

const videoConfig = () => ({ codec: "avc1.640028", width: W, height: H, bitrate: 5_000_000, framerate: FPS, avc: { format: "avc" } });
const audioConfig = (codec) => ({ codec, sampleRate: OUT_RATE, numberOfChannels: 2, bitrate: 160_000 });

/** Load a background video file (from the user's computer). */
export function loadBackground(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.src = URL.createObjectURL(file);
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(new Error("This background video can't be played in the browser. Use an MP4 (H.264) file."));
  });
}

/**
 * Make the video.
 * opts: { bg: HTMLVideoElement, bgStart, narration: {samples, sampleRate, duration, titleEnd, words},
 *         card: {subreddit, author, title, score, comments}, partLabel, support, onProgress(pct, text), signal }
 * Returns { blob, thumbnail (JPEG data URL), duration }.
 */
export async function renderVideo(opts) {
  const { bg, bgStart, narration, card, support, onProgress = () => {}, signal } = opts;
  const duration = narration.duration;
  const totalFrames = Math.ceil(duration * FPS);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H, frameRate: FPS },
    audio: { codec: support.muxCodec, numberOfChannels: 2, sampleRate: OUT_RATE },
    fastStart: "in-memory",
    firstTimestampBehavior: "offset",
  });
  let failure = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (failure = e) });
  venc.configure(videoConfig());
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (failure = e) });
  aenc.configure(audioConfig(support.audioCodec));

  // ---- audio: resample voice to 48 kHz stereo and encode it all now ----
  onProgress(0, "Preparing sound…");
  const audio = await toStereo48k(narration.samples, narration.sampleRate, duration);
  const CH = 4800;
  for (let i = 0; i < audio[0].length; i += CH) {
    const n = Math.min(CH, audio[0].length - i);
    const data = new Float32Array(n * 2);
    data.set(audio[0].subarray(i, i + n), 0);
    data.set(audio[1].subarray(i, i + n), n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: OUT_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / OUT_RATE) * 1e6), data });
    aenc.encode(ad);
    ad.close();
  }

  // ---- video: play the background in real time and draw every frame ----
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d", { alpha: false });
  const groups = captionGroups(narration.words.filter((w) => !w.title));
  let thumbnail = null;

  bg.currentTime = bgStart;
  await new Promise((r) => (bg.onseeked = r));
  bg.loop = true;
  await bg.play();
  let lastVideoTime = bg.currentTime, elapsed = 0;
  const onVisibility = () => { if (document.hidden) bg.pause(); else bg.play().catch(() => {}); };
  document.addEventListener("visibilitychange", onVisibility);

  try {
    let frame = 0;
    while (frame < totalFrames) {
      if (signal?.aborted) throw new Error("Stopped.");
      if (failure) throw failure;
      await nextTick();
      // Count only real playback time (pauses when the tab is hidden; handles looping).
      const now = bg.currentTime;
      let d = now - lastVideoTime;
      if (d < 0) d = (bg.duration - lastVideoTime) + now; // the background looped back to the start
      if (d < 0 || d > 1) d = 1 / FPS;
      lastVideoTime = now;
      elapsed += d;
      while (frame < totalFrames && frame / FPS <= elapsed) {
        const t = frame / FPS;
        drawFrame(ctx, bg, t, narration, card, groups, opts.partLabel);
        if (frame === Math.round(Math.min(narration.titleEnd, 1.2) * FPS) || (!thumbnail && frame === 0 && narration.titleEnd === 0)) {
          thumbnail = thumbFrom(canvas);
        }
        const vf = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / FPS) });
        venc.encode(vf, { keyFrame: frame % (FPS * 2) === 0 });
        vf.close();
        frame++;
        while (venc.encodeQueueSize > 8) await sleep(5); // don't run ahead of the encoder
      }
      onProgress(Math.min(99, Math.round((frame / totalFrames) * 100)), `Making the video… ${Math.round(frame / FPS)}s / ${Math.round(duration)}s`);
    }
    onProgress(99, "Finishing the file…");
    await venc.flush();
    await aenc.flush();
    if (failure) throw failure;
    muxer.finalize();
  } finally {
    document.removeEventListener("visibilitychange", onVisibility);
    bg.pause();
    try { venc.close(); } catch (_) {}
    try { aenc.close(); } catch (_) {}
  }
  const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
  onProgress(100, "Video ready");
  return { blob, thumbnail: thumbnail || thumbFrom(canvas), duration };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// rAF stops in hidden tabs; a short timeout keeps going (the clock above pauses anyway).
const nextTick = () => new Promise((r) => (document.hidden ? setTimeout(r, 30) : requestAnimationFrame(() => r())));

async function toStereo48k(samples, rate, duration) {
  const len = Math.ceil(duration * OUT_RATE);
  const ctx = new OfflineAudioContext(2, len, OUT_RATE);
  const buf = ctx.createBuffer(1, samples.length, rate);
  buf.copyToChannel(samples, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = 1.0;
  src.connect(gain).connect(ctx.destination);
  src.start();
  const out = await ctx.startRendering();
  return [out.getChannelData(0), out.getChannelData(1)];
}

function thumbFrom(canvas) {
  const t = document.createElement("canvas");
  t.width = 270; t.height = 480;
  t.getContext("2d").drawImage(canvas, 0, 0, 270, 480);
  return t.toDataURL("image/jpeg", 0.75);
}

// ---- drawing ------------------------------------------------------------------
function drawFrame(ctx, bg, t, narration, card, groups, partLabel) {
  drawCover(ctx, bg);
  // soft darkening so white text always reads well
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.fillRect(0, 0, W, H);
  const cardUntil = narration.titleEnd + 0.25;
  if (t < cardUntil) {
    const appear = Math.min(1, t / 0.25), leave = Math.min(1, Math.max(0, (cardUntil - t) / 0.2));
    drawCard(ctx, card, Math.min(appear, leave), 0.85 + 0.15 * easeOut(appear), partLabel);
  } else {
    const g = groups.find((x) => t >= x.start - 0.02 && t < x.end + 0.12) || null;
    if (g) drawCaption(ctx, g, t);
  }
}

function drawCover(ctx, video) {
  const vw = video.videoWidth || W, vh = video.videoHeight || H;
  const scale = Math.max(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

const easeOut = (x) => 1 - Math.pow(1 - x, 3);

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

/** The Reddit-style post card shown while the title is read. */
export function drawCard(ctx, card, alpha = 1, scale = 1, partLabel = "") {
  const cw = 920, x0 = (W - cw) / 2, pad = 44;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = "800 54px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  let lines = wrap(ctx, card.title, cw - pad * 2);
  if (lines.length > 7) { lines = lines.slice(0, 7); lines[6] = lines[6].replace(/\s*\S*$/, "…"); }
  const ch = pad + 96 + 26 + lines.length * 66 + 30 + 56 + pad;
  const y0 = (H - ch) / 2 - 60;
  ctx.translate(W / 2, y0 + ch / 2);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -(y0 + ch / 2));
  ctx.shadowColor = "rgba(0,0,0,0.45)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 12;
  roundRect(ctx, x0, y0, cw, ch, 36);
  ctx.fillStyle = "#ffffff"; ctx.fill();
  ctx.shadowColor = "transparent";
  // avatar
  const ax = x0 + pad + 44, ay = y0 + pad + 44;
  const grad = ctx.createLinearGradient(ax - 44, ay - 44, ax + 44, ay + 44);
  grad.addColorStop(0, "#ff4500"); grad.addColorStop(1, "#ff8717");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(ax, ay, 44, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff"; ctx.font = "900 46px system-ui, Arial, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("r/", ax, ay + 2);
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#1a1a1b"; ctx.font = "800 40px system-ui, Arial, sans-serif";
  ctx.fillText(`r/${card.subreddit || "reddit"}`, ax + 66, ay - 4);
  ctx.fillStyle = "#787c7e"; ctx.font = "500 32px system-ui, Arial, sans-serif";
  ctx.fillText(`u/${card.author || "anonymous"}`, ax + 66, ay + 38);
  if (partLabel) {
    ctx.font = "800 32px system-ui, Arial, sans-serif";
    const tw = ctx.measureText(partLabel).width + 36;
    roundRect(ctx, x0 + cw - pad - tw, ay - 30, tw, 56, 28);
    ctx.fillStyle = "#ff4500"; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(partLabel, x0 + cw - pad - tw + 18, ay + 10);
  }
  // title
  ctx.fillStyle = "#1a1a1b"; ctx.font = "800 54px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  let ty = y0 + pad + 96 + 26 + 50;
  for (const l of lines) { ctx.fillText(l, x0 + pad, ty); ty += 66; }
  // footer
  ctx.fillStyle = "#787c7e"; ctx.font = "700 36px system-ui, Arial, sans-serif";
  const fy = ty + 34;
  ctx.fillText(`▲ ${formatCount(card.score)}`, x0 + pad, fy);
  ctx.fillText(`💬 ${formatCount(card.comments)}`, x0 + pad + 220, fy);
  ctx.fillText("↗ Share", x0 + pad + 460, fy);
  ctx.restore();
}

/** Big centered captions, the current word highlighted, with a small "pop" when a new group appears. */
function drawCaption(ctx, group, t) {
  const pop = Math.min(1, (t - group.start) / 0.09);
  const scale = 1.12 - 0.12 * easeOut(Math.max(0, pop));
  const size = 104;
  ctx.save();
  ctx.font = `900 ${size}px 'Arial Black', 'Segoe UI Black', system-ui, Arial, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const words = group.words;
  const lines = [];
  let line = [];
  const maxW = W - 140;
  for (const w of words) {
    const test = [...line, w].map((x) => x.word).join(" ");
    if (ctx.measureText(test).width > maxW && line.length) { lines.push(line); line = [w]; }
    else line.push(w);
  }
  if (line.length) lines.push(line);
  const lh = size * 1.12;
  const cy = H / 2 + 40;
  ctx.translate(W / 2, cy);
  ctx.scale(scale, scale);
  lines.forEach((ln, li) => {
    const y = (li - (lines.length - 1) / 2) * lh;
    const full = ln.map((x) => x.word).join(" ");
    let x = -ctx.measureText(full).width / 2;
    for (const w of ln) {
      const active = t >= w.start && t < w.end + 0.05;
      ctx.lineWidth = 18;
      ctx.strokeStyle = "#000";
      ctx.strokeText(w.word, x, y);
      ctx.fillStyle = active ? "#ffd60a" : "#ffffff";
      ctx.fillText(w.word, x, y);
      x += ctx.measureText(w.word + " ").width;
    }
  });
  ctx.restore();
}
