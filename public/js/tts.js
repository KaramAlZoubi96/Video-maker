// Free AI voice that runs inside the browser (Kokoro, ~90 MB download the first time, then cached).
import { chunkForTTS, speechBounds, splitSentences, wordTimings } from "./storylib.js";

export const VOICES = [
  ["af_heart", "Heart — warm female (best)"],
  ["af_bella", "Bella — energetic female"],
  ["af_nicole", "Nicole — soft female"],
  ["bf_emma", "Emma — British female"],
  ["am_michael", "Michael — male"],
  ["am_fenrir", "Fenrir — deep male"],
  ["am_puck", "Puck — lively male"],
  ["bm_george", "George — British male"],
  ["bm_fable", "Fable — British storyteller"],
];
export const SAMPLE_RATE = 24000;

let enginePromise = null;

/** Load the voice model once. onProgress(percent, text). */
export function loadVoice(onProgress = () => {}) {
  // Tests (and future engines) can plug in their own voice.
  if (window.__SHQ_TTS__) return Promise.resolve(window.__SHQ_TTS__);
  if (!enginePromise) {
    enginePromise = (async () => {
      onProgress(1, "Loading the voice engine…");
      const { KokoroTTS } = await import("/vendor/kokoro.web.js");
      const files = new Map();
      const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            let a = 0, b = 0;
            for (const [l, t] of files.values()) { a += l; b += t; }
            onProgress(Math.min(99, Math.round((a / b) * 100)), `Downloading the voice (first time only): ${Math.round(a / 1e6)} / ${Math.round(b / 1e6)} MB`);
          }
        },
      });
      onProgress(100, "Voice ready");
      return {
        async speak(text, voice, speed) {
          const out = await tts.generate(text, { voice, speed });
          return { samples: out.audio, sampleRate: out.sampling_rate };
        },
      };
    })().catch((e) => {
      enginePromise = null;
      throw new Error("Could not load the voice. Check your internet and use Chrome or Edge. (" + (e?.message || e) + ")");
    });
  }
  return enginePromise;
}

/**
 * Speak the title and the story. Returns one audio track plus word timings for captions.
 * { samples: Float32Array (24 kHz mono), sampleRate, duration, titleEnd, words: [{word,start,end}] }
 */
export async function narrate({ title, body, voice = "af_heart", speed = 1, onProgress = () => {} }) {
  const engine = await loadVoice(onProgress);
  const titleChunks = chunkForTTS(splitSentences(title), 240);
  const bodyChunks = chunkForTTS(splitSentences(body), 240);
  const all = [...titleChunks.map((t) => ({ t, title: true })), ...bodyChunks.map((t) => ({ t, title: false }))];
  const pieces = [];
  for (let i = 0; i < all.length; i++) {
    onProgress(Math.round((i / all.length) * 100), `Recording the voice… ${i + 1} / ${all.length}`);
    const { samples, sampleRate } = await engine.speak(all[i].t, voice, speed);
    pieces.push({ ...all[i], samples: resample(samples, sampleRate, SAMPLE_RATE) });
  }
  // Join with short pauses (longer after the title).
  const gap = (sec) => new Float32Array(Math.round(sec * SAMPLE_RATE));
  const parts = [gap(0.15)];
  const words = [];
  let t = 0.15, titleEnd = 0;
  pieces.forEach((p, i) => {
    const b = speechBounds(p.samples, SAMPLE_RATE);
    words.push(...wordTimings(p.t, t + b.start, t + b.end).map((w) => ({ ...w, title: p.title })));
    parts.push(p.samples);
    t += p.samples.length / SAMPLE_RATE;
    if (p.title && !(pieces[i + 1]?.title)) { titleEnd = t; parts.push(gap(0.45)); t += 0.45; }
    else { parts.push(gap(0.08)); t += 0.08; }
  });
  parts.push(gap(0.7));
  const total = parts.reduce((n, a) => n + a.length, 0);
  const samples = new Float32Array(total);
  let o = 0;
  for (const a of parts) { samples.set(a, o); o += a.length; }
  onProgress(100, "Voice done");
  return { samples, sampleRate: SAMPLE_RATE, duration: total / SAMPLE_RATE, titleEnd, words };
}

function resample(samples, from, to) {
  if (from === to) return samples instanceof Float32Array ? samples : Float32Array.from(samples);
  const ratio = from / to, n = Math.round(samples.length / ratio), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, a = Math.floor(x), f = x - a;
    out[i] = (samples[a] ?? 0) * (1 - f) + (samples[a + 1] ?? 0) * f;
  }
  return out;
}
