// Esnetici arka uçları: SoundTouch ve Signalsmith, tek bir arayüz ardında.
//
// İkisi de AYNI yerde duruyor - toplama bus'ı ile master arasında, tek düğüm
// (bkz. stretch.js ve engine.js). Motor hangisinin seçili olduğunu bilmiyor,
// yalnız buradaki arayüzü çağırıyor.
//
// TEMPO İKİSİNDE DE KAYNAKTAN geliyor (source.playbackRate); düğümlerin işi
// perdeyi telafi etmek. Fark, telafinin nasıl söylendiğinde:
//
//   SoundTouch  playbackRate + pitchSemitones ayrı AudioParam'lar, hesabı
//               kendi yapıyor: virtualPitch = 2^(S/12) / R.
//   Signalsmith CANLI GİRİŞTE rate'i YOK SAYIYOR (README), yani saf perde
//               kaydırıcı. Kaynak perdeyi R katı kaydırdığı için telafi
//               ELLE: semitones = S - 12*log2(R).

import { SoundTouchNode } from "../vendor/soundtouch-worklet/index.js";
import SignalsmithStretch from "../vendor/signalsmith-stretch/SignalsmithStretch.mjs";

// import.meta.url'e göre çözülüyor: index.html ve bench.html farklı
// derinlikte olsa da aynı adrese çıkıyor.
const SOUNDTOUCH_PROCESSOR_URL = new URL(
  "../vendor/soundtouch-worklet/soundtouch-processor.js",
  import.meta.url
).href;

// WSOLA kalite ayarları. setStretchParameters ile hepsi erişilebilir:
//   sequenceMs   - yapıştırma sekansının uzunluğu; 0 = otomatik
//                  (tempo'ya göre 130 - 20*tempo ms, 50..125 ms arası)
//   seekWindowMs - en iyi örtüşmenin arandığı pencere; 0 = otomatik
//                  (25.67 - 2.67*tempo ms, 15..25 ms arası)
//   overlapMs    - çapraz geçiş uzunluğu; varsayılan 8 ms
//   quickSeek    - kaba arama (varsayılan true)
//
// İlk üçü OTOMATİK bırakılıyor: tempoya uyarlanan formül elle seçilmiş tek
// bir sabitten iyi. quickSeek KAPATILDI - tam arama örtüşme hizasını
// düzeltiyor, telefonda bildirilen hafif gıcırtının ilk şüphelisi buydu.
export const STRETCH_QUALITY = { quickSeek: false };

// A/B sonucu (2026-09-28, telefonda gerçek şarkıyla): Signalsmith açık ara
// daha iyi. Nesnel karşılığı hiza testindeki saçılma - SoundTouch ±8-17 ms,
// Signalsmith ±0.1 ms; ayrıca gerçek topolojide 3.6 kat ucuz.
export const DEFAULT_STRETCHER = "signalsmith";

// WebAssembly yoksa ya da Signalsmith yüklenemezse buraya düşülüyor.
// SoundTouch saf JS, ek çalışma zamanı gerektirmiyor.
export const FALLBACK_STRETCHER = "soundtouch";

/**
 * Signalsmith'in canlı kipte uygulaması gereken yarım ses.
 * Kaynak perdeyi rate katı kaydırdı; düğüm bunu geri alıp istenen S'yi
 * uygulamalı.
 */
function livePitch(rate, semitones) {
  return semitones - 12 * Math.log2(rate);
}

/**
 * Formant telafisi - ÖLÇÜLMÜŞ davranış.
 *
 * Yalın `formantCompensation: true` bizim zincirimizde ZARARLI: kaynağın
 * playbackRate'i formantları zaten rate katı kaydırmış ve düğüm yukarı
 * akıştaki o kaymayı göremiyor. Telafi açılınca formantlar rate katında
 * KALIYOR - ölçüldü, spektral ağırlık merkezi R=0.8'de 1005 Hz'den 814 Hz'e
 * düştü, yani tam 0.8 katı.
 *
 * `formantSemitones = -12*log2(rate)` kaynağın kaydırmasını geri çeviriyor;
 * ölçümde R=0.8/S=0 durumu telafi kapalıyken aynı değere (917 Hz) döndü.
 * Böylece ayar yalnızca PERDE kaydırmasına karşı formant davranışını
 * değiştiriyor - A/B'de yargılanmak istenen tam olarak bu.
 */
function formantFields(rate, on) {
  if (!on) return { formantCompensation: false, formantSemitones: 0 };
  return { formantCompensation: true, formantSemitones: -12 * Math.log2(rate) };
}

function scheduleSignalsmith(node, { rate, semitones, formants }, when) {
  node.schedule({
    output: when,
    active: true,
    semitones: livePitch(rate, semitones),
    ...formantFields(rate, formants),
  });
}

const ADAPTERS = {
  soundtouch: {
    id: "soundtouch",
    label: "SoundTouch",
    license: "MPL-2.0",
    supportsFormants: false,
    needsWasm: false,
    register(ctx) {
      return SoundTouchNode.register(ctx, SOUNDTOUCH_PROCESSOR_URL);
    },
    create(ctx, channels, { rate, semitones }) {
      const node = new SoundTouchNode({
        context: ctx,
        outputChannelCount: [Math.max(1, channels)],
      });
      node.playbackRate.value = rate;
      node.pitchSemitones.value = Math.round(semitones);
      node.setStretchParameters(STRETCH_QUALITY);
      return node;
    },
    update(node, { rate, semitones }) {
      node.playbackRate.value = rate;
      node.pitchSemitones.value = Math.round(semitones);
    },
    // Ayrı bir başlatma gerekmiyor: giriş gelir gelmez işliyor.
    start() {},
    reportedLatency() {
      return null;
    },
  },

  signalsmith: {
    id: "signalsmith",
    label: "Signalsmith",
    license: "MIT",
    supportsFormants: true,
    // WASM gömülü: WebAssembly olmayan ortamda düğüm hiç kurulamaz.
    needsWasm: true,
    // Worklet modülünü fabrika kendi yüklüyor; ayrı bir kayıt adımı yok.
    register() {
      return Promise.resolve();
    },
    async create(ctx, channels, options) {
      const node = await SignalsmithStretch(ctx, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [Math.max(1, channels)],
      });
      scheduleSignalsmith(node, options, ctx.currentTime);
      return node;
    },
    update(node, options, when) {
      scheduleSignalsmith(node, options, when);
    },
    // İşlemeye başlaması için schedule({active:true}) şart. Kaynaklarla
    // AYNI ana yazılıyor ki hizada kayma olmasın.
    start(node, when, options) {
      scheduleSignalsmith(node, options, when);
    },
    async reportedLatency(node) {
      try {
        return await node.latency();
      } catch {
        return null;
      }
    },
  },
};

export const STRETCHERS = Object.values(ADAPTERS).map((adapter) => ({
  id: adapter.id,
  label: adapter.label,
  license: adapter.license,
  supportsFormants: adapter.supportsFormants,
}));

/**
 * Arka uç bu cihazda kullanılabilir mi? Signalsmith WASM ile geliyor;
 * WebAssembly olmayan bir ortamda düğüm hiç kurulamaz.
 */
export function isAvailable(id) {
  const adapter = ADAPTERS[id];
  if (!adapter) return false;
  if (adapter.needsWasm && typeof WebAssembly === "undefined") return false;
  return true;
}

/**
 * Tanınmayan kimlik varsayılana, kullanılamayan kimlik YEDEĞE düşüyor;
 * bayat bir ayar ya da eksik WebAssembly uygulamayı kırmasın.
 *
 * Bu yalnız STATİK kontrol. Kütüphane yüklenirken patlarsa motor ayrıca
 * çalışma anında yedeğe düşüyor (engine.js, activeStretcher).
 */
export function normalizeStretcher(id) {
  if (isAvailable(id)) return id;
  if (ADAPTERS[id]) return FALLBACK_STRETCHER; // tanınıyor ama bu cihazda çalışmaz
  return isAvailable(DEFAULT_STRETCHER) ? DEFAULT_STRETCHER : FALLBACK_STRETCHER;
}

export function stretcherInfo(id) {
  return ADAPTERS[normalizeStretcher(id)];
}

export function supportsFormants(id) {
  return stretcherInfo(id).supportsFormants;
}

export { livePitch, formantFields };
