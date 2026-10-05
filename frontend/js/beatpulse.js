// Tam ekran sözlerin arka planı için SAF mantık (Aşama 13): DOM, ses motoru ve ağ YOK;
// node ile test ediliyor: node tests\beatpulse_test.mjs
//
//  - detectOnsets: kick sesinden vuruş anlarını bir kez çıkarır (küçük zaman listesi).
//  - BeatTracker: her karede çağrılır, bir vuruş geçildiyse dizinini söyler. Seek/atlama
//    sessizce yeniden oturur (atlamada nabız ATEŞLENMEZ).
//  - pickBeats: kick listesi varsa onu, yoksa vuruş ızgarasını (chords.beats) seçer.
//  - cihaz önbelleği: stem-mikser.kicks.<id> = {v, tag, savedAt, times}. Davul grubu
//    kapalıyken de nabız çalışsın diye liste şarkıya kaydedilir.

export const BG_MODES = ["plain", "flow", "pulse", "both", "custom"];
export const BG_LABELS = {
  plain: "Sade", flow: "Akan renkler", pulse: "Vuruşa göre nabız", both: "Akan renkler + nabız",
  custom: "Kendi resmim / videom",
};
export const BG_DEFAULT = "plain";

export function normalizeBg(value) {
  return BG_MODES.includes(value) ? value : BG_DEFAULT;
}

export const wantsFlow = (mode) => mode === "flow" || mode === "both";
export const wantsPulse = (mode) => mode === "pulse" || mode === "both";

// -------------------------------------------------------------- vuruş çıkarma

export const ONSET_HOP_SECONDS = 0.005;
export const ONSET_MIN_GAP_SECONDS = 0.15;
const ONSET_WINDOW_SECONDS = 2.0;      // yerel güç karşılaştırma penceresi (blok)
const ONSET_REL_THRESHOLD = 0.22;      // yerel en güçlü yükselişin bu oranı
const ONSET_ABS_FLOOR = 0.04;          // genel tepe zarfın bu oranından zayıf yükseliş vuruş sayılmaz

/**
 * Tek kanallı kick sesinden (Float32Array) vuruş anları (sn, artan, 2 basamak).
 * Kick kanalı zaten ayrılmış: kısa zarf (5 ms) -> yükseliş -> yerel eşikli tepe seçimi.
 */
export function detectOnsets(samples, sampleRate) {
  if (!samples || !samples.length || !(sampleRate > 0)) return [];
  const hop = Math.max(1, Math.round(sampleRate * ONSET_HOP_SECONDS));
  const frames = Math.floor(samples.length / hop);
  if (frames < 8) return [];
  const env = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i += 1) {
      const v = samples[start + i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / hop);
    env[f] = rms;
    if (rms > peak) peak = rms;
  }
  if (!(peak > 1e-5)) return [];
  // 3 karelik yükseliş: f noktasından sonraki 3 karede ne kadar çıktı
  const rise = new Float32Array(frames);
  let risePeak = 0;
  for (let f = 0; f + 3 < frames; f += 1) {
    const value = Math.max(0, env[f + 3] - env[f]);
    rise[f] = value;
    if (value > risePeak) risePeak = value;
  }
  if (!(risePeak > 0)) return [];
  const block = Math.max(1, Math.round(ONSET_WINDOW_SECONDS / ONSET_HOP_SECONDS));
  const blocks = Math.ceil(frames / block);
  const blockMax = new Float32Array(blocks);
  for (let f = 0; f < frames; f += 1) {
    const b = (f / block) | 0;
    if (rise[f] > blockMax[b]) blockMax[b] = rise[f];
  }
  const half = Math.max(1, Math.round(ONSET_MIN_GAP_SECONDS / ONSET_HOP_SECONDS / 2));
  const floor = ONSET_ABS_FLOOR * peak;
  const candidates = [];
  for (let f = 0; f < frames; f += 1) {
    const value = rise[f];
    if (value < floor) continue;
    const b = (f / block) | 0;
    const local = Math.max(blockMax[b], b > 0 ? blockMax[b - 1] : 0, b + 1 < blocks ? blockMax[b + 1] : 0);
    if (value < ONSET_REL_THRESHOLD * local) continue;
    let isPeak = true;
    for (let k = Math.max(0, f - half); k <= Math.min(frames - 1, f + half); k += 1) {
      if (rise[k] > value || (rise[k] === value && k < f)) { isPeak = false; break; }
    }
    if (isPeak) candidates.push({ f, value });
  }
  // yükselişin BAŞLANGICINI bul: zarfın yükselmeye başladığı kare
  const times = [];
  let lastTime = -1;
  for (const { f } of candidates) {
    let start = f;
    while (start > 0 && env[start] > env[start - 1] && f - start < 2) start -= 1;
    const time = Math.round(((start + 1) * hop / sampleRate) * 100) / 100;
    if (time - lastTime >= ONSET_MIN_GAP_SECONDS) {
      times.push(time);
      lastTime = time;
    }
  }
  return times;
}

/** AudioBuffer benzeri (getChannelData, numberOfChannels, length, sampleRate) -> tek kanal -> vuruşlar. */
export function onsetsFromBuffer(buffer) {
  if (!buffer || !buffer.length) return [];
  const channels = Math.max(1, buffer.numberOfChannels | 0);
  if (channels === 1) return detectOnsets(buffer.getChannelData(0), buffer.sampleRate);
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < mono.length; i += 1) mono[i] += data[i] / channels;
  }
  return detectOnsets(mono, buffer.sampleRate);
}

// ------------------------------------------------------------------ izleyici

function lowerBound(times, value) {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export const POLL_FIRE_WINDOW = 0.12;     // vuruş bu kadar sn'den eskiyse (kare düştü) ateşlenmez
export const POLL_MAX_STEP = 0.35;        // iki çağrı arası bundan fazlaysa atlama sayılır

export class BeatTracker {
  constructor(times = []) {
    this.times = times;
    this.next = 0;
    this.last = NaN;
  }

  setTimes(times) {
    this.times = times || [];
    this.reset();
  }

  reset() {
    this.next = 0;
    this.last = NaN;
  }

  /** Bu çağrıda geçilen EN SON vuruşun dizini, yoksa -1. */
  poll(time) {
    const times = this.times;
    if (!times.length || !Number.isFinite(time)) return -1;
    if (!Number.isFinite(this.last) || time < this.last - 0.01 || time - this.last > POLL_MAX_STEP) {
      this.next = lowerBound(times, time);        // seek/atlama: yeniden otur, ateşleme
      this.last = time;
      return -1;
    }
    let fired = -1;
    while (this.next < times.length && times[this.next] <= time) {
      if (time - times[this.next] <= POLL_FIRE_WINDOW) fired = this.next;
      this.next += 1;
    }
    this.last = time;
    return fired;
  }
}

// ------------------------------------------------------------- kaynak seçimi

const MIN_KICKS = 8;

/**
 * Kick listesi yeterliyse (>= 8 vuruş) onu, yoksa ızgarayı (beats, downbeats) kullanır.
 * Dönen {times, strong (Uint8Array: ızgarada ölçü başı = 1), source: "kick" | "grid" | "none"}.
 */
export function pickBeats({ kicks = null, grid = null } = {}) {
  if (Array.isArray(kicks) && kicks.length >= MIN_KICKS) {
    return { times: kicks, strong: new Uint8Array(kicks.length), source: "kick" };
  }
  const beats = grid && Array.isArray(grid.beats) ? grid.beats : [];
  if (beats.length >= 2) {
    const strong = new Uint8Array(beats.length);
    const downs = grid.downbeats || [];
    let d = 0;
    for (let i = 0; i < beats.length; i += 1) {
      while (d < downs.length && downs[d] < beats[i] - 0.03) d += 1;
      if (d < downs.length && Math.abs(downs[d] - beats[i]) <= 0.03) strong[i] = 1;
    }
    return { times: beats, strong, source: "grid" };
  }
  return { times: [], strong: new Uint8Array(0), source: "none" };
}

// ------------------------------------------------------------ cihaz önbelleği

export const KICK_PREFIX = "stem-mikser.kicks.";
export const KICK_LIMIT = 40;

export function readKicks(storage, id, tag) {
  try {
    const raw = storage.getItem(KICK_PREFIX + id);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || entry.v !== 1 || entry.tag !== tag || !Array.isArray(entry.times)) return null;
    const times = entry.times.map(Number).filter(Number.isFinite);
    return times.length ? times : null;
  } catch {
    return null;
  }
}

export function writeKicks(storage, id, tag, times, now = Date.now()) {
  try {
    storage.setItem(KICK_PREFIX + id, JSON.stringify({ v: 1, tag, savedAt: now, times }));
    pruneKicks(storage);
    return true;
  } catch {
    return false;
  }
}

export function dropKicks(storage, ids) {
  for (const id of ids || []) {
    try { storage.removeItem(KICK_PREFIX + id); } catch { /* yok say */ }
  }
}

export function pruneKicks(storage) {
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(KICK_PREFIX)) keys.push(key);
    }
    if (keys.length <= KICK_LIMIT) return 0;
    const aged = keys.map((key) => {
      let savedAt = 0;
      try { savedAt = (JSON.parse(storage.getItem(key)) || {}).savedAt || 0; } catch { savedAt = 0; }
      return { key, savedAt };
    }).sort((x, y) => x.savedAt - y.savedAt);
    const drop = aged.slice(0, aged.length - KICK_LIMIT);
    for (const item of drop) storage.removeItem(item.key);
    return drop.length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------ özel arka plan

export const CUSTOM_WARN_BYTES = 200 * 1024 * 1024;

/** Seçilen dosya: {kind: "image" | "video" | null, warn: bool}. */
export function classifyBackground(file) {
  const type = (file && file.type) || "";
  const kind = type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : null;
  return { kind, warn: Boolean(file && file.size > CUSTOM_WARN_BYTES) };
}
