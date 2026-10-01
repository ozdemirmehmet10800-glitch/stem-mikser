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

// A-B döngü satırları. Uçlar vuruş ızgarasının ~12 ms ÖNÜNDE: gerçek
// şarkıda ızgara davuldan 8-15 ms erken olduğu için uç atağın hemen öncesine
// düşüyor; test aynı durumu kuruyor (tık A + 12 ms'de başlıyor).
const LOOP_A = 1.988;
const LOOP_B = 3.988;                 // 2 sn = 4 vuruş
const LOOP_WINDOW_MS = 8500;
const CAPTURE_SEC = 9.5;
const SEAM_PASS_MS = 4;               // çukur merkezi gerçek dikişten en çok bu kadar
const MARKER_LEVEL = 0.5;
const CARRIER_LEVEL = 0.1;            // tap eşiğinin (0.15) ALTINDA: sürekli taşıyıcı
const MARKER_GAP = 0.1;               // işaret dikişin bu kadar öncesi/sonrası

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

// Dikiş çukuru ölçümü için stem'ler: sürekli taşıyıcı (çukuru gösterir) ve
// dikişin iki yanında, çukurun DIŞINDA iki işaret tıkı (gerçek dikiş anını
// verir: esneticiden geçmiş çıkışta ikisi de aynı gecikmeyi taşıyor).
function buildSeamStems(sampleRate) {
  const frames = Math.floor(LENGTH * sampleRate);
  const carrier = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    carrier[i] = CARRIER_LEVEL * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
  }
  const clickFrames = Math.floor(CLICK_SECONDS * sampleRate);
  for (const at of [LOOP_B - MARKER_GAP, LOOP_A + MARKER_GAP]) {
    const start = Math.floor(at * sampleRate);
    for (let i = 0; i < clickFrames && start + i < frames; i += 1) {
      const t = i / sampleRate;
      carrier[start + i] += MARKER_LEVEL * Math.cos(2 * Math.PI * 1200 * t) * Math.exp(-t / 0.006);
    }
  }
  const stems = [{ name: STEM_ORDER[0], arrayBuffer: encodeWav(carrier, sampleRate) }];
  BED_FREQS.forEach((freq, index) => {
    const bed = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      bed[i] = BED_LEVEL * Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    stems.push({ name: STEM_ORDER[index + 1], arrayBuffer: encodeWav(bed, sampleRate) });
  });
  return stems;
}

// ----------------------------------------------------------------- analiz

// Kaydedilmiş çıkıştan her dikişte: çukurun merkezi, gerçek dikiş anı (iki
// işaretin ortası) ve motorun tahmini. predicted: motorun songToCtx(a, k)
// değerleri (ctx saniyesi). minTime: bundan önceki dikişler atlanır.
function analyseSeams(capture, predicted, rate, minTime = 0) {
  const sr = capture.sampleRate;
  const data = capture.data;
  const t0 = capture.start;
  const at = (t) => Math.round((t - t0) * sr);
  const median = (list) => {
    const sorted = [...list].sort((x, y) => x - y);
    return sorted[Math.floor(sorted.length / 2)];
  };
  // 1 ms hareketli ortalama zarfı
  const win = Math.max(1, Math.round(sr * 0.001));
  const envelope = (index) => {
    let sum = 0;
    for (let i = 0; i < win; i += 1) sum += Math.abs(data[index + i] || 0);
    return sum / win;
  };
  const firstAbove = (from, to, level) => {
    for (let i = at(from); i <= at(to); i += 1) {
      if (Math.abs(data[i]) > level) return t0 + i / sr;
    }
    return null;
  };
  const found = [];
  for (const seam of predicted) {
    if (seam < minTime || at(seam - 0.35) < 0 || at(seam + 0.35) >= data.length) continue;
    const m1 = firstAbove(seam - MARKER_GAP / rate - 0.05, seam - MARKER_GAP / rate + 0.05, 0.3);
    const m2 = firstAbove(seam + MARKER_GAP / rate - 0.05, seam + MARKER_GAP / rate + 0.05, 0.3);
    if (m1 === null || m2 === null) continue;
    const truth = ((m1 + MARKER_GAP / rate) + (m2 - MARKER_GAP / rate)) / 2;
    const base = [];
    for (let t = seam - 0.06; t <= seam - 0.03; t += 0.001) base.push(envelope(at(t)));
    for (let t = seam + 0.03; t <= seam + 0.06; t += 0.001) base.push(envelope(at(t)));
    const baseline = median(base);
    if (!(baseline > 0)) continue;
    let first = null;
    let last = null;
    let lowest = Infinity;
    for (let t = seam - 0.02; t <= seam + 0.02; t += 0.0005) {
      const level = envelope(at(t));
      lowest = Math.min(lowest, level);
      if (level < 0.4 * baseline) {
        if (first === null) first = t;
        last = t;
      }
    }
    if (first === null) {
      found.push({ missing: true });
      continue;
    }
    const center = (first + last) / 2;
    found.push({
      vsTruth: (center - truth) * 1000,
      vsPredicted: (center - seam) * 1000,
      truthVsPredicted: (truth - seam) * 1000,
      depth: 1 - lowest / baseline,
      width: (last - first) * 1000,
    });
  }
  return found;
}

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
    let captureResolve = null;
    tap.port.onmessage = (event) => {
      const data = event.data;
      if (!data) return;
      if (data.type === "onset") onsets[data.input].push(data.time);
      else if (data.type === "capture" && captureResolve) {
        captureResolve({ start: data.start, data: data.data, sampleRate });
        captureResolve = null;
      }
    };
    const clear = () => {
      onsets[0].length = 0;
      onsets[1].length = 0;
    };
    const listen = (on) => tap.port.postMessage({ type: on ? "start" : "stop" });

    report("test sesi üretiliyor…");
    const { stems, beats, downbeats } = buildStems(sampleRate);
    await engine.setStems(stems);
    // Dikiş çukurundan SONRAKİ çıkış: ölçülen şey kulağa giden ses.
    engine.output.connect(tap, 0, 0);

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

    // --- 5b: A-B döngü hizası (dikişten geçerken metronom) --------------
    const loopConfigs = [
      { label: "1.0x", rate: 1 },
      { label: "0.8x", rate: 0.8 },
      { label: "canlı 0.8x → 1.1x", rate: 0.8, liveTo: 1.1 },
    ];
    for (const config of loopConfigs) {
      report(`döngü hizası · ${config.label} ölçülüyor…`);
      await applyRate(config.rate);
      await engine.seek(0);
      await engine.setLoop(LOOP_A, LOOP_B);
      clear();
      listen(true);
      await engine.play();
      metronome.resync();
      metronome.start();
      if (config.liveTo) {
        await wait(3500);
        await applyRate(config.liveTo);
        await wait(500);
        clear();
      }
      await wait(LOOP_WINDOW_MS);
      halt();
      listen(false);
      engine.clearLoop();
      const result = analyse(onsets[0], onsets[1]);
      rows.push(
        describe(
          `Döngü hizası · ${config.label}`,
          result,
          config.liveTo ? "dikişlerden geçerek, yalnız değişim sonrası" : "dikişlerden geçerek"
        )
      );
      // Dikişte tık düşmedi/çiftlenmedi: iki taraftaki tık sayıları aynı olmalı.
      const diff = Math.abs(onsets[0].length - onsets[1].length);
      rows.push(
        row(
          `Döngü tık sayısı · ${config.label}`,
          `stem ${onsets[0].length}, metronom ${onsets[1].length}`,
          diff <= 1,
          "dikişte düşen ya da çiftlenen metronom tıkı olmamalı (fark ≤ 1)"
        )
      );
      await wait(200);
    }

    // --- 5c: dikiş çukuru gerçek dikişe denk geliyor mu? ----------------
    await engine.setStems(buildSeamStems(sampleRate));
    for (const config of loopConfigs) {
      report(`dikiş çukuru · ${config.label} ölçülüyor…`);
      await applyRate(config.rate);
      await engine.seek(0);
      await engine.setLoop(LOOP_A, LOOP_B);
      const captured = new Promise((resolve) => { captureResolve = resolve; });
      tap.port.postMessage({ type: "capture", frames: Math.round(CAPTURE_SEC * sampleRate) });
      const wallStart = performance.now();
      await engine.play();
      let minTime = 0;
      let finalRate = config.rate;
      if (config.liveTo) {
        await wait(3500);
        await applyRate(config.liveTo);
        finalRate = config.liveTo;
        minTime = ctx.currentTime + 0.6;   // değişimden sonraki dikişler
      }
      await wait(Math.max(0, (CAPTURE_SEC - 0.4) * 1000 - (performance.now() - wallStart)));
      // Tahminler HALT'TAN ÖNCE: songToCtx motorun değişken durumuna bağlı.
      const predicted = [];
      for (let k = 1; k <= 40; k += 1) predicted.push(engine.songToCtx(LOOP_A, k));
      const capture = await captured;
      halt();
      engine.clearLoop();
      const seams = analyseSeams(capture, predicted, finalRate, minTime);
      const hits = seams.filter((s) => !s.missing);
      if (!hits.length) {
        rows.push(row(`Dikiş çukuru yeri · ${config.label}`, "ölçülemedi", false,
          `${seams.length} dikişte çukur/işaret bulunamadı`));
      } else {
        const sorted = (key) => hits.map((s) => s[key]).sort((x, y) => x - y);
        const mid = (key) => sorted(key)[Math.floor(hits.length / 2)];
        const offset = mid("vsTruth");
        const depth = mid("depth");
        rows.push(
          row(
            `Dikiş çukuru yeri · ${config.label}`,
            `${offset > 0 ? "+" : ""}${offset.toFixed(1)} ms`,
            Math.abs(offset) < SEAM_PASS_MS && depth >= 0.6 && hits.length === seams.length,
            `${hits.length}/${seams.length} dikiş, derinlik %${(depth * 100).toFixed(0)}, ` +
              `genişlik ${mid("width").toFixed(1)} ms · motor tahmini gerçek dikişten ` +
              `${mid("truthVsPredicted") > 0 ? "+" : ""}${mid("truthVsPredicted").toFixed(1)} ms ` +
              `(çukur − gerçek dikiş; eşik ±${SEAM_PASS_MS} ms)`
          )
        );
      }
      await wait(200);
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
