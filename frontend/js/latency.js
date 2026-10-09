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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

// Otomatik ayar sağlamlığı (SW v63): makul aralık + güven ölçütü + sıçrama direnci + ortanca.
export const SEARCH_MIN = 50;               // Bluetooth için makul aralık (ms)
export const SEARCH_MAX = 400;
export const STRONG_RATIO = 1.6;            // uç aralık (SEARCH dışı) ancak makul aralığın en iyisinden bu kadar çok FAZLA isabetle (şans düzeyinin üstü) kabul edilir
export const RIVAL_GAP_MS = 150;            // "ikinci en iyi" = en iyi kaymadan en az bu kadar (ve ana tepenin yarı genişliğinin 1,2 katı kadar) uzak en yüksek tepe
export const ALIGN_WINDOW_S = 0.03;         // hizalamada zaman toleransı DAR: nota içinde olmayan kare tutmuş sayılmaz (tepe keskin, çözünürlük iyi)
export const MIN_PROMINENCE = 0.4;          // (en iyi - rakip) / (en iyi - şans düzeyi) en az %40: tepe rakipten belirgin üstün
export const MIN_LIFT = 0.2;                // (en iyi - şans düzeyi) / en iyi en az %20: tepe düz zeminden yüksek
export const MIN_HIT_SHARE = 0.25;
export const MIN_GAIN = 0.05;               // isabet artışı bundan küçükse mevcut değer korunur
export const BIG_JUMP_MS = 150;             // mevcut değerden bundan büyük sıçrama ek kanıt ister
export const JUMP_MIN_GAIN = 0.2;
export const AGREE_MS = 60;                 // aynı sonucu "doğrulayan" ölçümler arası fark
export const HISTORY_SIZE = 3;

function scoreAt(samples, track, totalMs, options) {
  let hits = 0;
  let count = 0;
  for (const sample of samples) {
    const t = clamp(mapLoop(sample.t - (totalMs / 1000) * sample.rate, options.loop), 0, options.duration);
    const result = judge(sample.midi, track, t, { shift: options.shift, octave: options.octave, windowSec: ALIGN_WINDOW_S });
    if (result.hit === null) continue;
    count += 1;
    if (result.hit) hits += 1;
  }
  return { hits, count };
}

function plateauCenter(scores, grid, best) {
  const floor = scores[best].hits * 0.95;
  let lo = best;
  let hi = best;
  while (lo > 0 && scores[lo - 1].hits >= floor) lo -= 1;
  while (hi < grid.length - 1 && scores[hi + 1].hits >= floor) hi += 1;
  return (grid[lo] + grid[hi]) / 2;
}

function argBest(scores, grid, from, to, currentMs) {
  let best = -1;
  for (let i = 0; i < grid.length; i += 1) {
    if (grid[i] < from || grid[i] > to) continue;
    if (best < 0 || scores[i].hits > scores[best].hits || (scores[i].hits === scores[best].hits && Math.abs(grid[i] - currentMs) < Math.abs(grid[best] - currentMs))) best = i;
  }
  return best;
}

/**
 * En iyi TOPLAM gecikme (tek ölçüm). samples: SampleRing.items. Dönen: {ok: false, reason} ya da
 * {ok, totalMs, hits, count, currentHits, currentCount, gain, secondRatio, hitShare, extended, confidence: "yüksek" | "düşük"}.
 * - Arama makul aralıkta (SEARCH_MIN..SEARCH_MAX); uç değerler (kaydırıcı sınırlarına kadar) ANCAK makul aralığın en iyisinin
 *   STRONG_RATIO katı isabetle kabul edilir.
 * - Merkez: en iyi isabetin %95'ini koruyan bitişik aralığın ortası.
 * - Güven (şans düzeyinin ÜSTÜNDEKİ fazlalıkla): en iyi tepe, ondan >= RIVAL_GAP_MS uzaktaki tüm kaymaların en iyisinden belirgin üstün
 *   (belirginlik >= %40), düz zeminden yüksek (>= %20) ve hedefi olan karelerin >= %25'i tutuyorsa "yüksek"; melodi tekrar ediyorsa
 *   (eş tepeler) ya da kullanıcı çok yanlış söylüyorsa "düşük".
 */
export function bestShift(samples, track, { shift = 0, octave = true, loop = null, duration = Infinity, currentMs = 0, stepMs = 10 } = {}) {
  if (!track || !samples || samples.length < MIN_SAMPLES) return { ok: false, reason: "few" };
  const options = { shift, octave, loop, duration };
  const grid = [];
  for (let ms = TOTAL_MIN; ms <= TOTAL_MAX; ms += stepMs) grid.push(ms);
  const scores = grid.map((ms) => scoreAt(samples, track, ms, options));
  // Şans düzeyi: yanlış hizada da (oktav katlama, 50 cent payı) rastgele isabet olur; tüm kaymaların ORTANCASI. Güven bunun ÜSTÜNDEKİ fazlalıkla ölçülür.
  const baseline = median(scores.map((score) => score.hits));
  const normal = argBest(scores, grid, SEARCH_MIN, SEARCH_MAX, currentMs);
  const overall = argBest(scores, grid, TOTAL_MIN, TOTAL_MAX, currentMs);
  if (normal < 0 || scores[overall].hits < MIN_SAMPLES / 4) return { ok: false, reason: "nomatch" };
  let best = normal;
  let extended = false;
  if (overall !== normal && (grid[overall] < SEARCH_MIN || grid[overall] > SEARCH_MAX) && scores[overall].hits - baseline >= STRONG_RATIO * Math.max(scores[normal].hits - baseline, 1)) {
    best = overall;
    extended = true;
  }
  if (scores[best].hits < MIN_SAMPLES / 4) return { ok: false, reason: "nomatch" };
  const totalMs = clampTotal(plateauCenter(scores, grid, best));
  // ana tepenin yarı genişliği: en iyiden, şans düzeyinin üstündeki fazlalığın %50'sinin altına inene dek
  const peak = scores[best].hits;
  const half = baseline + 0.5 * (peak - baseline);
  let l = best;
  let r = best;
  while (l > 0 && scores[l - 1].hits >= half) l -= 1;
  while (r < grid.length - 1 && scores[r + 1].hits >= half) r += 1;
  const gap = Math.min(Math.max(RIVAL_GAP_MS, 1.2 * Math.max(grid[best] - grid[l], grid[r] - grid[best])), 400);
  let rival = 0;
  for (let i = 0; i < grid.length; i += 1) if (Math.abs(grid[i] - grid[best]) > gap && scores[i].hits > rival) rival = scores[i].hits;
  const chosen = scoreAt(samples, track, totalMs, options);
  const current = scoreAt(samples, track, currentMs, options);
  const excess = chosen.hits - baseline;
  const secondRatio = chosen.hits ? rival / chosen.hits : 1;
  const prominence = excess > 0 ? (chosen.hits - rival) / excess : 0;
  const lift = chosen.hits ? excess / chosen.hits : 0;
  const hitShare = chosen.count ? chosen.hits / chosen.count : 0;
  const gain = chosen.hits ? (chosen.hits - current.hits) / chosen.hits : 0;
  const confident = prominence >= MIN_PROMINENCE && lift >= MIN_LIFT && hitShare >= MIN_HIT_SHARE;
  return {
    ok: true, totalMs, hits: chosen.hits, count: chosen.count, currentHits: current.hits, currentCount: current.count, samples: samples.length,
    gain, secondRatio, prominence, lift, baseline, hitShare, extended, confidence: confident ? "yüksek" : "düşük",
  };
}


/**
 * Ölçümü uygulayıp uygulamamaya karar verir. found: bestShift sonucu; currentMs: mevcut toplam gecikme; history: önceki GÜVENİLİR adaylar (ms).
 * Dönen: {apply, totalMs?, reason, confidence, history}. reason: "ok" | "few" | "nomatch" | "lowconf" | "nogain" | "jump".
 * - Güven düşükse ya da isabet artışı küçükse UYGULANMAZ (mevcut değer korunur).
 * - Mevcut değerden > BIG_JUMP_MS sıçrama: en az iki ölçüm (±AGREE_MS) aynı sonucu vermeli ve artış >= %20 olmalı; yoksa aday saklanır, uygulanmaz.
 * - Uygulanan değer son adayların ortancasıdır (tek tek ölçüm gürültüsüne direnç).
 */
export function decideAlign(found, { currentMs = 0, history = [] } = {}) {
  if (!found || !found.ok) return { apply: false, reason: (found && found.reason) || "nomatch", confidence: null, history };
  if (found.confidence !== "yüksek") return { apply: false, reason: "lowconf", confidence: found.confidence, history };
  const candidates = [...history, found.totalMs].slice(-HISTORY_SIZE);
  if (found.gain < MIN_GAIN) return { apply: false, reason: "nogain", confidence: found.confidence, history: candidates };
  const agreeing = candidates.filter((value) => Math.abs(value - found.totalMs) <= AGREE_MS);
  if (Math.abs(found.totalMs - currentMs) > BIG_JUMP_MS && (agreeing.length < 2 || found.gain < JUMP_MIN_GAIN)) {
    return { apply: false, reason: "jump", confidence: found.confidence, history: candidates, candidateMs: found.totalMs };
  }
  const totalMs = clampTotal(agreeing.length >= 2 ? median(agreeing) : found.totalMs);
  return { apply: true, totalMs, reason: "ok", confidence: found.confidence, history: candidates };
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
