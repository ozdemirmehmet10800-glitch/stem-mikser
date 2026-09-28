// Hız ve ton esnetmesi: TEK SoundTouch düğümü, toplama bus'ında.
//
// Mimari:
//   6 source (hepsi aynı playbackRate) -> stem gain'leri -> bus
//     -> SoundTouchNode -> master -> destination
//
// Kanal başına AYRI düğüm KULLANMIYORUZ. WSOLA her sekansta yapıştırma
// noktasını kendi sinyaline göre seçiyor; ayrı düğümlerde her stem kendi
// seekWindow'u (~23 ms) kadar bağımsız oynardı ve davulla bas arasında flam
// çıkardı. Tek düğümde bu yapısal olarak imkânsız: gecikme tek bir sayı ve
// CPU altıya bölünmüyor.
//
// Bedeli: fader/solo/mute değişimi düğümün ÖNÜNDE olduğu için esnetici
// açıkken ~150 ms geç duyuluyor. Bilinçli kabul.
//
// Metronom düğümün DIŞINDA kalıyor (doğrudan destination'a), yoksa tıklar
// zaman esnetmesinde yayılırdı.

import { SoundTouchNode } from "../vendor/soundtouch-worklet/index.js";

// import.meta.url'e göre çözülüyor: index.html ve bench.html farklı
// derinlikte olsa da aynı adrese çıkıyor.
const PROCESSOR_URL = new URL(
  "../vendor/soundtouch-worklet/soundtouch-processor.js",
  import.meta.url
).href;

export const MIN_RATE = 0.5;
export const MAX_RATE = 1.5;
export const MAX_SEMITONES = 6;

// WSOLA kalite ayarları. setStretchParameters ile hepsi erişilebilir:
//   sequenceMs   - yapıştırma sekansının uzunluğu; 0 = otomatik
//                  (tempo'ya göre 130 - 20*tempo ms, 50..125 ms arası)
//   seekWindowMs - en iyi örtüşmenin arandığı pencere; 0 = otomatik
//                  (25.67 - 2.67*tempo ms, 15..25 ms arası)
//   overlapMs    - çapraz geçiş uzunluğu; varsayılan 8 ms
//   quickSeek    - kaba arama (varsayılan true)
//
// sequenceMs/seekWindowMs/overlapMs OTOMATİK bırakılıyor: SoundTouch'ın
// tempoya göre uyarlanan formülü elle seçilmiş tek bir değerden iyi.
// quickSeek ise KAPATILIYOR - kaba arama yerine tam arama örtüşme hizasını
// düzeltiyor ve bench.html'de bildirilen hafif gıcırtının ilk şüphelisi bu.
// Ölçümde 6 ayrı düğümle oran 0.111 çıktı; burada tek düğüm var, yani tam
// aramanın maliyetini karşılayacak kat kat baş mevcut.
//
// Bu üçlüyü gecikme ölçümüne DE vermek gerekmiyor: gecikme yalnızca
// sequenceMs/seekWindowMs/overlapMs ve tempo'dan çıkıyor, quickSeek
// tampon boyutlarını değiştirmiyor.
export const STRETCH_QUALITY = { quickSeek: false };

// Gecikme ölçümü: sabit sinyalin çıkışta göründüğü ilk kare.
const PROBE_SECONDS = 1.2;   // en kötü durumda (~0.2 sn) fazlasıyla yeter
const PROBE_LEVEL = 0.5;
const PROBE_FLOOR = 1e-3;
// Ölçüm başarısız olursa: 32 kHz'de sampleReq ~4256 kare = 133 ms'lik
// hesaplanmış değerin biraz üstü. Tamamen hizasız kalmaktan iyi.
const FALLBACK_LATENCY = 0.16;
// Oran ızgarası: gecikme hızla çok yavaş değişiyor (sequenceMs eğimi
// 20 ms/birim hız), 0.05 adımda hata 1 ms'nin altında. BPM adımı başına
// ayrı ölçüm yapmak yerine ızgaraya yuvarlıyoruz.
const RATE_GRID = 0.05;

const latencyCache = new Map();
const moduleCache = new WeakMap();

export function isBypass(rate, semitones) {
  return Math.abs(rate - 1) < 1e-6 && Math.round(semitones) === 0;
}

/** Worklet modülünü bir AudioContext'e bir kez yükler. */
export function registerModule(ctx) {
  let ready = moduleCache.get(ctx);
  if (!ready) {
    ready = SoundTouchNode.register(ctx, PROCESSOR_URL);
    moduleCache.set(ctx, ready);
  }
  return ready;
}

/**
 * Esnetici düğümü kurar. Modül önceden yüklenmiş olmalı (registerModule).
 * channels: bus'ın kanal sayısı (mobilde mono indirme yüzünden 1 olabilir).
 */
export function createNode(ctx, channels, { rate, semitones }) {
  const node = new SoundTouchNode({
    context: ctx,
    outputChannelCount: [Math.max(1, channels)],
  });
  // Tempo KAYNAĞIN playbackRate'inden geliyor; düğüme aynı değeri veriyoruz
  // ki perdeyi telafi edebilsin. Düğümün kendi hesabı:
  //   virtualPitch = 2^(semitones/12) / playbackRate
  // yani net sonuç: hız = rate, perde = semitones.
  node.playbackRate.value = rate;
  node.pitchSemitones.value = Math.round(semitones);
  node.setStretchParameters(STRETCH_QUALITY);
  return node;
}

export function updateNode(node, { rate, semitones }) {
  if (!node) return;
  node.playbackRate.value = rate;
  node.pitchSemitones.value = Math.round(semitones);
}

function probeKey(sampleRate, rate, semitones) {
  return `${Math.round(sampleRate)}|${quantizeRate(rate)}|${Math.round(semitones)}`;
}

function quantizeRate(rate) {
  return (Math.round(rate / RATE_GRID) * RATE_GRID).toFixed(2);
}

/** Önbellekte varsa gecikme; yoksa null (ölçüm gerekiyor). */
export function cachedLatency(sampleRate, rate, semitones) {
  if (isBypass(rate, semitones)) return 0;
  const hit = latencyCache.get(probeKey(sampleRate, rate, semitones));
  return hit === undefined ? null : hit;
}

/**
 * Esneticinin çıkış gecikmesini ÖLÇER (tahmin etmez).
 *
 * WSOLA, sampleReq kadar girdi birikmeden çıkış üretmiyor; o ana kadar
 * çıkış tam olarak sıfır. Dolayısıyla sabit bir sinyali OfflineAudioContext'te
 * geçirip ilk sıfırdan farklı kareyi bulmak gecikmeyi TAM verir.
 *
 * Telafi edilmezse metronom ve akor imleci sesin ~150 ms önünde gider.
 */
export async function measureLatency(sampleRate, rate, semitones) {
  if (isBypass(rate, semitones)) return 0;
  const key = probeKey(sampleRate, rate, semitones);
  const hit = latencyCache.get(key);
  if (hit !== undefined) return hit;

  let value = FALLBACK_LATENCY;
  try {
    value = await renderProbe(sampleRate, rate, Math.round(semitones));
  } catch (error) {
    console.warn("[stretch] gecikme ölçülemedi, varsayılan kullanılıyor:", error);
  }
  latencyCache.set(key, value);
  return value;
}

async function renderProbe(sampleRate, rate, semitones) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("OfflineAudioContext yok");

  const length = Math.ceil(sampleRate * PROBE_SECONDS);
  const ctx = new Ctor(1, length, sampleRate);
  await SoundTouchNode.register(ctx, PROCESSOR_URL);

  const node = createNode(ctx, 1, { rate, semitones });
  // Kaynağın playbackRate'i ölçümde 1: düğümün gecikmesi girdinin hangi
  // hızda üretildiğine değil, kaç kare biriktiğine bağlı ve girdi her
  // blokta 128 kare geliyor.
  const buffer = ctx.createBuffer(1, length, sampleRate);
  // Sabit seviye, gürültü değil: sıfır geçişi yok, ilk çıkış karesi
  // eşikle net yakalanıyor.
  buffer.getChannelData(0).fill(PROBE_LEVEL);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(node);
  node.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  const data = rendered.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    if (Math.abs(data[i]) > PROBE_FLOOR) return i / sampleRate;
  }
  throw new Error("ölçüm sinyali çıkışta hiç görünmedi");
}
