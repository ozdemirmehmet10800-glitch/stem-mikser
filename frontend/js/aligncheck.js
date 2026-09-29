// Hiza testi: metronom gerçekten davulun üstüne mi oturuyor?
//
// GERÇEK ZAMANLI ölçüm, offline değil. Sentetik bir tık stem'i motorun
// GERÇEK zincirinden (source -> gain -> bus -> SoundTouchNode -> master)
// geçiriliyor; master çıkışı ve metronom çıkışı ayrı ayrı bir AudioWorklet
// düğümünde (tap-processor.js) izleniyor ve aradaki fark ölçülüyor.
//
// Neden sentetik stem: gerçek davulda "atak anı" tanıma bağlı (akış tepesi
// ~10 ms geç, geri izleme ~15 ms erken okuyor). Sentetik tıkın başlangıcı
// örnek hassasiyetinde bilindiği için ölçüm tanımdan bağımsız kalıyor.
//
// Oynatıcıya dokunulmuyor: test kendi Engine + Metronome örneğini kurup
// bitince kapatıyor. Sınıflar aynı olduğu için ölçülen zincir de aynı.

import { Engine, STEM_ORDER } from "./engine.js";
import { Metronome } from "./metronome.js";
import {
  measureLatency, latencyInfo, reportedLatency,
  DEFAULT_STRETCHER, stretcherInfo, supportsFormants, normalizeStretcher,
} from "./stretch.js";

const TAP_URL = new URL("./tap-processor.js", import.meta.url).href;

const BEAT = 0.5;              // sn (120 BPM)
const LENGTH = 26;             // test stem'inin süresi, sn
const GAP_START = 12;          // seek testi için sessiz pencere
const GAP_END = 13;
const CLICK_LEVEL = 0.5;
const CLICK_SECONDS = 0.025;
const BED_LEVEL = 0.015;       // WSOLA'nın kilitleneceği zemin
const BED_FREQS = [110, 147, 220, 330, 440];
// Eşik. Metronomun StereoPannerNode'u MONO girişte eşit güç yasası
// uyguluyor: pan 0'da bile her kanal cos(pi/4) = 0.707 ile çarpılıyor.
// Vurgusuz tık 0.55 zarf x 0.707 = 0.39 seviyesine iniyor, o yüzden
// metronom sesi testte 1.0'a alınıp eşik 0.15'e çekildi. Zemin tonları
// (5 x 0.015 = 0.075) hâlâ eşiğin altında.
const THRESHOLD = 0.15;
const HOLDOFF = 0.15;
// Eşleştirme penceresi. Vuruşlar 0.5 sn arayla, yani 0.25 sn'ye kadar
// belirsizlik yok. Dar tutmak (60 ms) büyük kaymaları ELEYİP medyanı
// yapay olarak sıfıra çekiyordu; ölçmek istediğimiz şeyi kırpmamalı.
const MATCH = 0.2;
export const PASS_MS = 10;     // |fark| bu değerin altındaysa geçti
const SKIP_BEATS = 3;          // başlangıç geçici rejimi
const WINDOW_MS = 9000;        // her durum için kayıt süresi

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --------------------------------------------------------------- test sesi

function encodeWav(samples, sampleRate) {
  const count = samples.length;
  const size = 44 + count * 2;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, size - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(value * 32767), true);
  }
  return buffer;
}

function buildStems(sampleRate) {
  const frames = Math.floor(LENGTH * sampleRate);
  const beats = [];
  for (let t = BEAT; t < LENGTH - 0.5; t += BEAT) beats.push(Number(t.toFixed(3)));
  const downbeats = beats.filter((_, i) => i % 4 === 0);

  // Tık stem'i. İlk örnek tam genlikte: eşik geçişi belirsizlik bırakmıyor.
  const click = new Float32Array(frames);
  const clickFrames = Math.floor(CLICK_SECONDS * sampleRate);
  for (const beat of beats) {
    // GAP penceresi BOŞ: seek sonrası bayat ses testinin kancası bu.
    if (beat >= GAP_START && beat < GAP_END) continue;
    const start = Math.floor(beat * sampleRate);
    for (let i = 0; i < clickFrames && start + i < frames; i += 1) {
      const t = i / sampleRate;
      click[start + i] += CLICK_LEVEL * Math.cos(2 * Math.PI * 1200 * t) * Math.exp(-t / 0.006);
    }
  }

  const stems = [{ name: STEM_ORDER[0], arrayBuffer: encodeWav(click, sampleRate) }];
  BED_FREQS.forEach((freq, index) => {
    const bed = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      bed[i] = BED_LEVEL * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    stems.push({
      name: STEM_ORDER[index + 1],
      arrayBuffer: encodeWav(bed, sampleRate),
    });
  });
  return { stems, beats, downbeats };
}

// ----------------------------------------------------------------- analiz

function analyse(stemOnsets, metroOnsets) {
  // Her metronom tıkını en yakın stem tıkıyla eşle. Fark = metronom - stem:
  // NEGATİF ise metronom ÖNDE (erken), pozitifse geride.
  const usable = metroOnsets.slice(SKIP_BEATS, Math.max(SKIP_BEATS, metroOnsets.length - 1));
  const diffs = [];
  for (const metro of usable) {
    let best = null;
    let bestAbs = Infinity;
    for (const stem of stemOnsets) {
      const delta = metro - stem;
      const abs = Math.abs(delta);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = delta;
      }
    }
    if (best !== null && bestAbs <= MATCH) diffs.push(best * 1000);
  }
  if (!diffs.length) {
    // Eşleşme yoksa ham sayılar teşhis için şart: hangi taraf tık üretmedi?
    return { empty: true, stems: stemOnsets.length, metros: metroOnsets.length };
  }
  diffs.sort((a, b) => a - b);
  const median = diffs[Math.floor(diffs.length / 2)];
  const spread = diffs.map((d) => Math.abs(d - median)).sort((a, b) => a - b);
  return {
    n: diffs.length,
    median,
    jitter: spread[Math.min(spread.length - 1, Math.floor(spread.length * 0.9))],
    stems: stemOnsets.length,
    metros: metroOnsets.length,
  };
}

function row(name, measurement, passed, note) {
  return { name, measurement, passed, note };
}

function describe(name, result, note) {
  if (!result || result.empty) {
    const counts = result ? `stem ${result.stems}, metronom ${result.metros} tık` : "kayıt yok";
    return row(name, "eşleşme yok", false, `${counts}${note ? ` · ${note}` : ""}`);
  }
  const sign = result.median > 0 ? "+" : "";
  return row(
    name,
    `${sign}${result.median.toFixed(1)} ms`,
    Math.abs(result.median) < PASS_MS,
    `${result.n}/${result.metros} tık eşleşti, saçılma ±${result.jitter.toFixed(1)} ms` +
      (note ? ` · ${note}` : "")
  );
}

// ------------------------------------------------------------------- akış

/**
 * Saçılma açıklaması ESNETİCİYE GÖRE. Eskiden hep "WSOLA'nın doğası"
 * yazıyordu; Signalsmith faz vokoder, orada bu cümle yanlış.
 */
function jitterLegend(id) {
  if (id === "signalsmith") {
    return "Faz vokoder darbeleri oynatmadığı için saçılma ~0 bekleniyor.";
  }
  return "Saçılma WSOLA'nın doğası: yapıştırma noktası her darbede " +
    "seekWindow kadar kayabiliyor.";
}

export async function runAlignmentCheck(report = () => {}, options = {}) {
  const stretcher = normalizeStretcher(options.stretcher || DEFAULT_STRETCHER);
  const formants = Boolean(options.formants) && supportsFormants(stretcher);
  const rows = [];
  const engine = new Engine();
  engine.stretcher = stretcher;
  engine.formants = formants;
  // Ses kalitesi ayarı: sentetik stem'ler ctx.sampleRate'te üretildiği için
  // geri kalan her şey kendiliğinden uyum sağlıyor. Stem'ler MONO kalıyor -
  // burada ölçülen şey zamanlama, yük değil; yük ölçümü bench.html'in işi.
  engine.setAudioMode(options.audioMode);
  const metronome = new Metronome(engine);
  let tap = null;
  let sink = null;

  try {
    await engine.ensureContext();
    const ctx = engine.ctx;
    const sampleRate = ctx.sampleRate;
    const info = stretcherInfo(stretcher);
    rows.push(
      row(
        "Ortam",
        `${Math.round(sampleRate)} Hz`,
        null,
        `${engine.mobile ? "mobil" : "masaüstü"} kipi · çıkış gecikmesi ` +
          `${(engine.outputLatency * 1000).toFixed(0)} ms`
      )
    );
    rows.push(
      row(
        "Esnetici",
        info.label,
        null,
        `${info.license} · formant telafisi ` +
          (info.supportsFormants ? (formants ? "AÇIK" : "kapalı") : "desteklenmiyor")
      )
    );

    report("dinleme düğümü kuruluyor…");
    await ctx.audioWorklet.addModule(TAP_URL);
    tap = new AudioWorkletNode(ctx, "tap-processor", {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { threshold: THRESHOLD, holdoffSec: HOLDOFF },
    });
    sink = ctx.createGain();
    sink.gain.value = 0;
    tap.connect(sink);
    sink.connect(ctx.destination);

    const onsets = [[], []];
    tap.port.onmessage = (event) => {
      const data = event.data;
      if (data && data.type === "onset") onsets[data.input].push(data.time);
    };
    const clear = () => {
      onsets[0].length = 0;
      onsets[1].length = 0;
    };
    const listen = (on) => tap.port.postMessage({ type: on ? "start" : "stop" });

    report("test sesi üretiliyor…");
    const { stems, beats, downbeats } = buildStems(sampleRate);
    await engine.setStems(stems);
    engine.master.connect(tap, 0, 0);

    metronome.setGrid(beats, downbeats);
    metronome.setVolume(1);
    metronome.setEnabled(true);
    (metronome.panner || metronome.gain).connect(tap, 0, 1);
    metronome.stop();

    const applyRate = async (rate) => {
      const latency = await measureLatency(sampleRate, rate, 0, stretcher);
      await engine.setTempoAndPitch(rate, 0, latency);
      return latency;
    };
    const startFrom = async (time) => {
      await engine.seek(time);
      await engine.play();
      metronome.resync();
      metronome.start();
    };
    const halt = () => {
      engine.pause();
      metronome.stop();
    };

    // --- 1/2/3: sabit hızlar -------------------------------------------
    // Kütüphanenin kendi bildirdiği gecikme ÇALARKEN okunmalı: stop()
    // düğümü düşürüyor.
    let claimed = null;
    for (const [label, rate] of [["1.0x (bypass)", 1], ["0.8x", 0.8], ["1.2x", 1.2]]) {
      report(`${label} ölçülüyor…`);
      await applyRate(rate);
      clear();
      listen(true);
      await startFrom(0);
      if (claimed === null && engine.stretchNode) {
        claimed = await reportedLatency(engine.stretchNode, stretcher);
      }
      await wait(WINDOW_MS);
      halt();
      listen(false);
      rows.push(describe(`Metronom hizası · ${label}`, analyse(onsets[0], onsets[1])));
      await wait(200);
    }

    // --- 4: çalarken canlı hız değişimi --------------------------------
    report("canlı hız değişimi (0.8x → 1.1x) ölçülüyor…");
    await applyRate(0.8);
    clear();
    listen(true);
    await startFrom(0);
    await wait(3500);
    await applyRate(1.1);
    await wait(500);
    clear(); // yalnız DEĞİŞİMDEN SONRASI sayılsın
    await wait(WINDOW_MS);
    halt();
    listen(false);
    rows.push(
      describe(
        "Metronom hizası · canlı 0.8x → 1.1x",
        analyse(onsets[0], onsets[1]),
        "yalnız değişim sonrası"
      )
    );
    await wait(200);

    // --- 5: seek sonrası bayat ses + konum ------------------------------
    report("seek sonrası bayat ses ölçülüyor…");
    const rate = 0.8;
    await applyRate(rate);
    clear();
    listen(true);
    await startFrom(GAP_START - 3);
    await wait(2800); // boru hattı dolsun, tıklar aksın
    const before = onsets[0].length;
    clear();
    await engine.seek(GAP_START);
    metronome.resync();
    // Stem GAP_START..GAP_END arasında SESSİZ; ilk tık GAP_END'de olmalı.
    const expectedFirst = engine.songToCtx(GAP_END);
    await wait(((GAP_END - GAP_START) / rate) * 1000 + 3600);  // medyan için ~7 tık
    halt();
    listen(false);

    const guard = expectedFirst - 0.03;
    const stale = onsets[0].filter((t) => t < guard);
    const after = onsets[0].filter((t) => t >= guard).slice(0, 8);
    rows.push(
      row(
        "Seek sonrası bayat ses",
        stale.length ? `${stale.length} artık tık` : "yok",
        stale.length === 0,
        before > 0
          ? `seek öncesi ${before} tık akıyordu (ölçüm canlıydı)`
          : "UYARI: seek öncesi tık yakalanmadı"
      )
    );
    if (!after.length) {
      rows.push(row("Seek sonrası konum", "tık gelmedi", false, "sessiz pencere bitmedi"));
    } else {
      // TEK tıka bakmak yeterli değil: WSOLA yapıştırma noktasını kendi
      // sinyaline göre seçtiği için bir darbe seekWindow (~23 ms) kadar
      // oynayabiliyor. Boşluktan sonraki ilk 8 tıkın MEDYANI alınıyor.
      // expectedFirst SEEK ANINDA hesaplandı. songToCtx motorun değişken
      // durumuna bağlı ve halt() offset'i değiştirdiği için burada yeniden
      // çağrılamaz; sonraki tıklar sabit vuruş aralığından türetiliyor.
      const deltas = after
        .map((t, i) => (t - (expectedFirst + (i * BEAT) / rate)) * 1000)
        .sort((a, b) => a - b);
      const median = deltas[Math.floor(deltas.length / 2)];
      rows.push(
        row(
          "Seek sonrası konum",
          `${median > 0 ? "+" : ""}${median.toFixed(1)} ms`,
          Math.abs(median) < PASS_MS,
          `boşluk sonrası ${deltas.length} tıkın medyanı, beklenen ana göre`
        )
      );
    }

    // --- 6: ölçülen esnetici gecikmesi ---------------------------------
    for (const value of [0.8, 1.1, 1.2]) {
      const hit = latencyInfo(sampleRate, value, 0, stretcher);
      rows.push(
        hit
          ? row(
              `Esnetici gecikmesi · ${value}x`,
              `${(hit.seconds * 1000).toFixed(1)} ms`,
              hit.measured,
              hit.measured ? "bu cihazda ölçüldü" : "ÖLÇÜLEMEDİ, yedek değer kullanıldı"
            )
          : row(`Esnetici gecikmesi · ${value}x`, "—", null, "bu hızda ölçüm yapılmadı")
      );
    }

    // Kütüphane kendi gecikmesini bildiriyorsa ölçümle karşılaştır.
    if (claimed !== null && claimed !== undefined) {
      const measured = latencyInfo(sampleRate, 0.8, 0, stretcher);
      const delta = measured ? (claimed - measured.seconds) * 1000 : null;
      rows.push(
        row(
          "Kütüphanenin bildirdiği gecikme",
          `${(claimed * 1000).toFixed(1)} ms`,
          null,
          delta === null
            ? "ölçümle karşılaştırılamadı"
            : `0.8x ölçümünden ${delta > 0 ? "+" : ""}${delta.toFixed(1)} ms farklı ` +
              "(hiza satırları hangisinin doğru olduğunu söyler)"
        )
      );
    }
  } finally {
    try {
      metronome.dispose();
    } catch {
      /* kurulmamış olabilir */
    }
    try {
      if (tap) tap.disconnect();
      if (sink) sink.disconnect();
    } catch {
      /* zaten kopmuş */
    }
    engine.dispose();
  }

  return {
    rows,
    legend:
      "Hiza farkı = metronom − stem. Artı: metronom GEÇ, eksi: metronom " +
      "ERKEN. Karar yalnız MEDYANA bakıyor; saçılma geçti/kaldıya girmiyor. " +
      jitterLegend(stretcher),
  };
}
