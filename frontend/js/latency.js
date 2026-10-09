// Antrenör zaman hizası (Mikrofon paketi 9, SW v61). SAF mantık (DOM, ses, ağ, depolama YOK); node ile test ediliyor: node tests\latency_test.mjs
//
// MODEL: "Gecikme" kaydırıcısı TOPLAM gecikmedir (ms): kulaklığa giden sesin çıkış gecikmesi + mikrofon girişi + kullanıcının tepki payı.
// Şarkı zamanı TEK yerde ve BİR kez düşülür:
//     songTime = ham çalma konumu (engine.rawTime) - (mikrofon kare gecikmesi + toplam gecikme) x hız
// `ctx.outputLatency` bu formüle GİRMEZ (telefonda aynı Q45 ile 279 ms / 8 ms okundu: Android Bluetooth gecikmesini güvenilir bildirmiyor);
// yalnız ilk ÖNERİ için ve bilgi / uyarı için okunur. Çift sayım yok: ne motorun visualTime'ı ne outputLatency kullanılır.
//
// Otomatik hizalama: son ~15 sn'de kabul edilen kullanıcı perdeleri (ham zaman + perde SAYILARI) ile hedef melodi arasında en çok isabet
// veren toplam gecikme aranır. GİZLİLİK: yalnız sayılar; ses örneği yok, hiçbir şey saklanmaz / gönderilmez.

import { mapLoop } from "./loop.js";
import { judge } from "./melody.js";

export const TOTAL_MIN = -100;
export const TOTAL_MAX = 800;
export const TOTAL_DEFAULT = 300;
export const SAMPLE_SECONDS = 15;
export const MIN_SAMPLES = 40;              // ~0,85 sn kabul edilen perde (47 kare/sn)
export const MAX_SAMPLES = 900;             // ~19 sn
export const SUSPICIOUS_MS = 60;            // Bluetooth varken bundan düşük çıkış gecikmesi mantıksız
export const BLUETOOTH_GUESS_MS = 250;      // okuma güvenilmezse başlangıç tahmini
export const MIC_DEFAULT_MS = 40;

const clamp = (value, lo, hi) => Math.min(Math.max(value, lo), hi);
export const clampTotal = (value) => clamp(Math.round(Number.isFinite(value) ? value : TOTAL_DEFAULT), TOTAL_MIN, TOTAL_MAX);

/**
 * Şarkı zamanı. raw: motorun ham çalma konumu (çalmıyorsa konumun kendisi); lagSec: kare, mikrofondan işlemciye gelene dek geçen süre
 * (0 = "şimdi"; rulo / söz için). Duraklatılmışken gecikme düşülmez (konum zaten durağan).
 */
export function songTimeAt({ raw, lagSec = 0, totalMs = 0, rate = 1, loop = null, duration = Infinity, playing = true }) {
  if (!playing) return raw;
  return clamp(mapLoop(raw - (lagSec + totalMs / 1000) * rate, loop), 0, duration);
}

/** İlk öneri (toplam ms): çıkış gecikmesi okuması (Bluetooth varken ve mantıksız düşükse tahmin) + mikrofon girişi. */
export function suggestTotalMs({ outputMs, micMs, bluetooth }) {
  let out = Number.isFinite(outputMs) && outputMs > 0 ? outputMs : 0;
  if (bluetooth && out < SUSPICIOUS_MS) out = BLUETOOTH_GUESS_MS;
  const mic = Number.isFinite(micMs) && micMs > 0 ? micMs : MIC_DEFAULT_MS;
  return clampTotal(out + mic);
}

/** ctx.outputLatency okumaları (ms): periyodik eklenir; ortanca = güvenilir tek değer, yayılım = dalgalanma. */
export class LatencyMonitor {
  constructor(size = 7) {
    this.size = size;
    this.values = [];
  }

  reset() {
    this.values = [];
  }

  add(ms) {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.values.push(ms);
    if (this.values.length > this.size) this.values.shift();
  }

  get latest() {
    return this.values.length ? this.values[this.values.length - 1] : null;
  }

  get median() {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  get spread() {
    return this.values.length ? Math.max(...this.values) - Math.min(...this.values) : 0;
  }
}

/** Panel için yorum: {suspicious, text}. */
export function latencyVerdict({ medianMs, spreadMs = 0, bluetooth = false }) {
  if (medianMs === null || medianMs === undefined) {
    return { suspicious: false, text: "Tarayıcının bildirdiği çıkış gecikmesi: şarkı çalınca okunur." };
  }
  const value = Math.round(medianMs);
  if (bluetooth && value < SUSPICIOUS_MS) {
    return {
      suspicious: true,
      text: `Tarayıcı çıkış gecikmesini ${value} ms bildiriyor ama Bluetooth kulaklık var (genelde 150-300 ms): değer güvenilmez. "Otomatik gecikme" düğmesini kullan.`,
    };
  }
  if (spreadMs > 100) {
    return { suspicious: true, text: `Tarayıcının bildirdiği çıkış gecikmesi dalgalanıyor (${value} ms, yayılım ${Math.round(spreadMs)} ms): hizayı "Otomatik gecikme" ile kur.` };
  }
  return { suspicious: false, text: `Tarayıcının bildirdiği çıkış gecikmesi: ${value} ms (yalnız bilgi; hizayı Gecikme ayarı belirler).` };
}

/** Son SAMPLE_SECONDS saniyenin kabul edilen perdeleri: {t (ham, gecikmesiz), rate, midi}. Çalma konumu geri giderse (sarma) sıfırlanır. */
export class SampleRing {
  constructor(seconds = SAMPLE_SECONDS, max = MAX_SAMPLES) {
    this.seconds = seconds;
    this.max = max;
    this.items = [];
  }

  push(t, rate, midi) {
    const last = this.items[this.items.length - 1];
    if (last && t < last.t - 0.05) this.items.length = 0;
    this.items.push({ t, rate, midi });
    const limit = t - this.seconds;
    let drop = 0;
    while (drop < this.items.length && this.items[drop].t < limit) drop += 1;
    if (drop) this.items.splice(0, drop);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  }

  clear() {
    this.items.length = 0;
  }
}

function scoreAt(samples, track, totalMs, options) {
  let hits = 0;
  let count = 0;
  for (const sample of samples) {
    const t = clamp(mapLoop(sample.t - (totalMs / 1000) * sample.rate, options.loop), 0, options.duration);
    const result = judge(sample.midi, track, t, { shift: options.shift, octave: options.octave });
    if (result.hit === null) continue;
    count += 1;
    if (result.hit) hits += 1;
  }
  return { hits, count };
}

/**
 * En iyi TOPLAM gecikme. samples: SampleRing.items. Dönen: {ok, totalMs, hits, count, currentHits, gain} ya da {ok: false, reason}.
 * En çok isabet veren kaydırma bulunur; isabetin %95'ini koruyan bitişik aralığın ORTASI alınır (düz tepe -> sağlam), eşitlikte mevcut değere yakın.
 */
export function bestShift(samples, track, { shift = 0, octave = true, loop = null, duration = Infinity, currentMs = 0, minMs = TOTAL_MIN, maxMs = TOTAL_MAX, stepMs = 10 } = {}) {
  if (!track || !samples || samples.length < MIN_SAMPLES) return { ok: false, reason: "few" };
  const options = { shift, octave, loop, duration };
  const grid = [];
  for (let ms = minMs; ms <= maxMs; ms += stepMs) grid.push(ms);
  const scores = grid.map((ms) => scoreAt(samples, track, ms, options));
  let best = 0;
  for (let i = 1; i < grid.length; i += 1) {
    if (scores[i].hits > scores[best].hits || (scores[i].hits === scores[best].hits && Math.abs(grid[i] - currentMs) < Math.abs(grid[best] - currentMs))) best = i;
  }
  if (scores[best].hits < MIN_SAMPLES / 4) return { ok: false, reason: "nomatch" };
  const floor = scores[best].hits * 0.95;
  let lo = best;
  let hi = best;
  while (lo > 0 && scores[lo - 1].hits >= floor) lo -= 1;
  while (hi < grid.length - 1 && scores[hi + 1].hits >= floor) hi += 1;
  const totalMs = clampTotal((grid[lo] + grid[hi]) / 2);
  const chosen = scoreAt(samples, track, totalMs, options);
  const current = scoreAt(samples, track, currentMs, options);
  return { ok: true, totalMs, hits: chosen.hits, count: chosen.count, currentHits: current.hits, currentCount: current.count, samples: samples.length };
}

/**
 * Çalma başlatma bekçisi: begin() ile başlar; delayMs içinde end() çağrılmazsa onSlow() bir kez çağrılır (çalma hâlâ HAZIRLANIYOR).
 * end() gecikme bildirimi yapıldıysa true döner (çağıran mesajı temizler). Yanlış alarm: kullanıcı çalmayı 2,5 sn içinde durdurursa
 * (cancel) ya da çalma zamanında başlarsa hiçbir şey çıkmaz.
 */
export class PlayWatch {
  constructor({ delayMs = 2500, onSlow = () => {}, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.delayMs = delayMs;
    this.onSlow = onSlow;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.pending = false;
    this.slow = false;
  }

  begin() {
    this.cancel();
    this.pending = true;
    const { setTimer } = this;              // yöntem olarak çağrılırsa setTimeout "Illegal invocation" verir (this = PlayWatch)
    this.timer = setTimer(() => {
      this.timer = null;
      if (!this.pending) return;
      this.slow = true;
      this.onSlow();
    }, this.delayMs);
  }

  end() {
    const wasSlow = this.slow;
    this.cancel();
    return wasSlow;
  }

  cancel() {
    const { clearTimer } = this;
    if (this.timer !== null) clearTimer(this.timer);
    this.timer = null;
    this.pending = false;
    this.slow = false;
  }
}
