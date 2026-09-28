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

// Gecikme ölçümü: İÇERİK gecikmesi.
//
// İlk sürüm "çıkışın ilk sıfırdan farklı karesi"ni ölçüyordu; o BAŞLANGIÇ
// doluşu, yani WSOLA'nın çıkış üretmeye başlaması için biriktirdiği girdi.
// Kararlı rejimdeki içerik gecikmesi bundan farklı ve HIZA BAĞLI: hiza
// testi 0.8x'te 34 ms, 1.2x'te 10 ms sapma gösterdi (telefon ve masaüstü
// birebir aynı). Artık doğrudan içerik ölçülüyor.
//
// Ölçülen büyüklük düğümün KENDİ özelliği: girişe t anında giren bir olay
// çıkışa t + D anında çıkıyor. Kaynağın playbackRate'inden bağımsız, çünkü
// düğüm süreyi korur (içeride tempo ve yeniden örnekleme birbirini götürür,
// net etki yalnız perde). Bu yüzden sonda kaynağı 1.0 hızda çalıyor.
//
// Tık ARALIKLARI DÜZENSİZ: eşit aralıklı bir trende gecikme aralık kadar
// belirsiz kalıyor (D ile D+aralık aynı derecede uyuyor). Düzensiz desen
// bu belirsizliği kaldırıyor.
const PROBE_GAPS = [0.16, 0.25, 0.19, 0.30, 0.22];
const PROBE_CLICKS = 24;          // WSOLA saçılması ±17 ms; medyan için bol
const PROBE_LEAD = 0.3;           // boru hattı dolsun
const PROBE_TAIL = 0.6;
const PROBE_CLICK_SECONDS = 0.01;
const PROBE_LEVEL = 0.8;
const PROBE_BED_HARMONICS = [131, 196, 262, 392];
const PROBE_BED_TONE = 0.02;
const PROBE_BED_NOISE = 0.025;
const PROBE_FLOOR = 0.35;         // tepe genliğe ORANLA eşik
const PROBE_HOLDOFF = 0.09;       // en dar aralık 0.16 sn
const PROBE_SKIP = 2;             // ilk tıklar oturma aşamasında
const PROBE_VOTE_STEP = 0.001;    // kaba hizalama ızgarası
const PROBE_VOTE_TOL = 0.03;
const PROBE_MAX_LAG = 0.35;
const PROBE_MIN_MATCHES = 10;
const PROBE_SANE = [0.02, 0.30];  // bu aralığın dışı ölçüm hatası sayılır
// Ölçüm başarısız olursa. Ölçülen içerik gecikmeleri 108-125 ms bandında.
const FALLBACK_LATENCY = 0.115;
// Oran ızgarası: gecikme hızla yavaş değişiyor, 0.05 adımda hata 1 ms'nin
// altında. BPM adımı başına ayrı ölçüm yapmak yerine ızgaraya yuvarlıyoruz.
const RATE_GRID = 0.05;

// key -> {seconds, measured}. measured=false ise ölçüm başarısız olmuş ve
// yedek değere düşülmüş demektir; hiza testi bunu ayrıca raporluyor.
const latencyCache = new Map();
const moduleCache = new WeakMap();
let lastMeasured = null;

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
  return hit === undefined ? null : hit.seconds;
}

/**
 * Ölçümün ayrıntısı: {seconds, measured}. measured=false ise gerçek ölçüm
 * yapılamamış ve yedek sabite düşülmüş. Hiza testi bunu gösteriyor.
 * Henüz hiç denenmemişse null.
 */
export function latencyInfo(sampleRate, rate, semitones) {
  if (isBypass(rate, semitones)) return { seconds: 0, measured: true };
  const hit = latencyCache.get(probeKey(sampleRate, rate, semitones));
  return hit === undefined ? null : { seconds: hit.seconds, measured: hit.measured };
}

/**
 * Beklemeden kullanılabilir bir gecikme değeri: önbellekteki ölçüm, yoksa
 * en son ölçülen herhangi bir değer, o da yoksa varsayılan.
 *
 * Kaydırıcı SÜRÜKLENİRKEN bu kullanılıyor - her adımda ölçüm yapmak
 * telefonda takılmaya yol açıyor (worklet modülü her offline context'e
 * yeniden yükleniyor). Taze ölçüm kaydırıcı BIRAKILINCA yapılıyor.
 */
export function estimateLatency(sampleRate, rate, semitones) {
  const exact = cachedLatency(sampleRate, rate, semitones);
  if (exact !== null) return exact;
  // Komşu bir ayarın ölçümü, varsayılandan çok daha yakın: gecikme hızla
  // yavaş değişiyor (0.5x -> 1.5x arası toplam ~60 ms).
  if (lastMeasured !== null) return lastMeasured;
  return FALLBACK_LATENCY;
}

/**
 * Esneticinin İÇERİK gecikmesini ÖLÇER (tahmin etmez).
 *
 * Girişe t anında giren bir olayın çıkışa t + D anında çıkması; motorun
 * zaman eşlemesinde gereken büyüklük tam olarak bu. OfflineAudioContext'te
 * düzensiz aralıklı bir tık treni geçirilip gözlenen ile beklenen zamanlar
 * arasındaki MEDYAN fark alınıyor (WSOLA tek tek tıkları ±17 ms
 * oynatabildiği için medyan şart).
 *
 * SİNYALE BAĞLI. Ölçüldü: aynı hızda, tıklar SESSİZLİK üzerindeyken 122 ms,
 * müziğe benzer sürekli bir zemin üzerindeyken 111 ms - WSOLA yapıştırma
 * noktasını sinyale göre seçtiği için. Sürekli zeminler kendi aralarında
 * 3.5 ms içinde uyuşuyor (akor 110.6, karışım 110.8, gürültü 114.1, saf
 * sinüsler 113.1), yani sessizlik dışındaki her şey birbirine yakın.
 * Sonda bu yüzden armonik + gürültü karışımı bir zemin kullanıyor ve
 * kaynağı GERÇEK hızda çalıyor. Artakalan birkaç ms'lik hata WSOLA'nın
 * doğasından; tek tek tıklarda saçılma zaten ±17 ms.
 *
 * Telafi edilmezse metronom ve akor imleci sesten ~110 ms kayar.
 */
export async function measureLatency(sampleRate, rate, semitones) {
  if (isBypass(rate, semitones)) return 0;
  const key = probeKey(sampleRate, rate, semitones);
  const hit = latencyCache.get(key);
  if (hit !== undefined) return hit;

  let value = FALLBACK_LATENCY;
  let measured = false;
  try {
    value = await renderProbe(sampleRate, rate, Math.round(semitones));
    measured = true;
  } catch (error) {
    console.warn("[stretch] gecikme ölçülemedi, varsayılan kullanılıyor:", error);
  }
  latencyCache.set(key, { seconds: value, measured });
  // Yedek değeri "son ölçüm" diye yaymıyoruz; yoksa tek bir hata bütün
  // sürükleme tahminlerini kirletir.
  if (measured) lastMeasured = value;
  return value;
}

async function renderProbe(sampleRate, rate, semitones) {
  const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!Ctor) throw new Error("OfflineAudioContext yok");

  // Beklenen tık zamanları GERÇEK zamanda, düzensiz aralıklarla.
  const expected = [];
  let at = PROBE_LEAD;
  for (let k = 0; k < PROBE_CLICKS; k += 1) {
    expected.push(at);
    at += PROBE_GAPS[k % PROBE_GAPS.length];
  }
  const realSeconds = at + PROBE_TAIL;
  const length = Math.ceil(realSeconds * sampleRate);
  // Kaynak gerçek hızda çalacağı için tampon rate katı uzunlukta olmalı.
  const bufferFrames = Math.ceil((realSeconds * rate + 0.2) * sampleRate);

  const ctx = new Ctor(1, length, sampleRate);
  await SoundTouchNode.register(ctx, PROCESSOR_URL);
  const node = createNode(ctx, 1, { rate, semitones });

  const buffer = ctx.createBuffer(1, bufferFrames, sampleRate);
  const data = buffer.getChannelData(0);

  // Zemin: armonikler + DETERMİNİSTİK gürültü. Math.random KULLANILMIYOR,
  // yoksa aynı ayar her ölçümde farklı sonuç verirdi.
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let i = 0; i < bufferFrames; i += 1) {
    const t = i / sampleRate;
    let value = PROBE_BED_NOISE * noise();
    for (const freq of PROBE_BED_HARMONICS) {
      value += PROBE_BED_TONE * Math.sin(2 * Math.PI * freq * t);
    }
    data[i] = value;
  }

  const clickFrames = Math.ceil(PROBE_CLICK_SECONDS * sampleRate);
  for (const time of expected) {
    // Gerçek zaman -> tampon konumu (kaynak rate hızında çalıyor).
    const start = Math.floor(time * rate * sampleRate);
    for (let i = 0; i < clickFrames && start + i < bufferFrames; i += 1) {
      const t = i / sampleRate;
      data[start + i] +=
        PROBE_LEVEL * Math.cos(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.0025);
    }
  }

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  source.connect(node);
  node.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  const out = rendered.getChannelData(0);

  let peak = 0;
  for (let i = 0; i < out.length; i += 1) {
    const value = Math.abs(out[i]);
    if (value > peak) peak = value;
  }
  if (peak < 1e-4) throw new Error("ölçüm sinyali çıkışta görünmedi");

  const threshold = peak * PROBE_FLOOR;
  const holdoff = Math.floor(PROBE_HOLDOFF * sampleRate);
  const onsets = [];
  let last = -holdoff - 1;
  for (let i = 0; i < out.length; i += 1) {
    if (Math.abs(out[i]) < threshold) continue;
    if (i - last < holdoff) continue;
    last = i;
    onsets.push(i / sampleRate);
  }
  if (onsets.length < PROBE_MIN_MATCHES) {
    throw new Error(`çıkışta yalnız ${onsets.length} tık bulundu`);
  }

  // Kaba hizalama: gecikmeyi 1 ms ızgarada tarayıp en çok tıkı açıklayanı
  // seç. WSOLA bir tıkı düşürebildiği ya da çiftleyebildiği için oylama,
  // sırayla eşleştirmekten dayanıklı. Aralıklar DÜZENSİZ olduğu için
  // doğru gecikme tek: eşit aralıklı trende D ile D+aralık ayırt edilemezdi.
  let bestLag = 0;
  let bestVotes = -1;
  for (let lag = 0; lag <= PROBE_MAX_LAG; lag += PROBE_VOTE_STEP) {
    let votes = 0;
    for (const time of expected) {
      const target = time + lag;
      for (const onset of onsets) {
        if (Math.abs(onset - target) <= PROBE_VOTE_TOL) {
          votes += 1;
          break;
        }
      }
    }
    if (votes > bestVotes) {
      bestVotes = votes;
      bestLag = lag;
    }
  }

  // İnce ölçüm: kaba gecikmenin çevresindeki eşleşmelerin MEDYANI.
  const diffs = [];
  for (let k = PROBE_SKIP; k < expected.length - 1; k += 1) {
    const target = expected[k] + bestLag;
    let best = null;
    let bestAbs = Infinity;
    for (const onset of onsets) {
      const abs = Math.abs(onset - target);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = onset - expected[k];
      }
    }
    if (best !== null && bestAbs <= PROBE_VOTE_TOL) diffs.push(best);
  }
  if (diffs.length < PROBE_MIN_MATCHES) {
    throw new Error(`yetersiz eşleşme (${diffs.length}/${expected.length})`);
  }
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  if (median < PROBE_SANE[0] || median > PROBE_SANE[1]) {
    throw new Error(`gecikme makul aralıkta değil (${(median * 1000).toFixed(0)} ms)`);
  }
  return median;
}
