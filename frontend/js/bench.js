// Aşama 8 ölçümü: bu cihaz kaç kanalı aynı anda gerçek zamanlı esnetebiliyor?
//
// İki kütüphane karşılaştırılabiliyor, çünkü masaüstünde şu bulundu:
//   - signalsmith-stretch (MIT): 3 düğüme kadar çalışıyor, 4'ten itibaren
//     TÜM işlemciler "Cannot read properties of undefined" atıp susuyor.
//     cheaper ve splitComputation kurtarmıyor. Kütüphane hatası görünüyor.
//   - @soundtouchjs/audio-worklet (MPL-2.0): 8 kanalda bile hatasız.
// Telefonda da aynı mı, buradan görülecek.
//
// Ses sentetik üretiliyor; API'ye ve token'a gerek yok.

import SignalsmithStretch from "../vendor/signalsmith-stretch/SignalsmithStretch.mjs";
import { SoundTouchNode } from "../vendor/soundtouch-worklet/index.js";
import { loadSettings, AUDIO_SAVE } from "./settings.js";
import { MOBILE_SAMPLE_RATE, isMobile, nativeSampleRate } from "./engine.js";
import { EQ_BANDS, impulseFor } from "./fx.js";
import { PeakJob, expectedBins } from "./peaks.js";

const el = (id) => document.getElementById(id);
const CHANNEL_COUNTS = [1, 2, 3, 4, 6];
// Ölçüm hızı ARTIK SABİT DEĞİL: uygulamanın gerçekte kullandığı hız neyse o.
// 32 kHz'e çakılıyken "Yüksek" kipin CPU payı hiç ölçülemiyordu - bench'in
// tek işi buysa yanlış kipte ölçmek işe yaramaz.
let SAMPLE_RATE = MOBILE_SAMPLE_RATE;

async function resolveSampleRate() {
  const settings = loadSettings();
  const saving = isMobile() && settings.mobileAudio === AUDIO_SAVE;
  SAMPLE_RATE = saving ? MOBILE_SAMPLE_RATE : (await nativeSampleRate()) || MOBILE_SAMPLE_RATE;
  return { rate: SAMPLE_RATE, mode: settings.mobileAudio, saving };
}
const RATE = 0.8;
const SEMITONES = 2;
const PROCESSOR_URL = "vendor/soundtouch-worklet/soundtouch-processor.js";

// Telefonda konsol görülemiyor: her şey ekrana yazılıyor.
const logLines = [];
function log(text) {
  const stamp = (performance.now() / 1000).toFixed(2).padStart(6);
  logLines.push(`${stamp}s  ${text}`);
  const node = el("log");
  if (node) node.textContent = logLines.join("\n");
}

window.addEventListener("error", (event) => {
  log(`HATA: ${event.message} (${event.filename}:${event.lineno})`);
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  log(`YAKALANMAYAN RET: ${reason && reason.message ? reason.message : reason}`);
});

function say(text, kind = "warn") {
  const node = el("message");
  node.hidden = false;
  node.className = `message ${kind}`;
  node.textContent = text;
}

// Müziğe benzer sinyal: sessizlikle ölçmek yanıltıcı olurdu.
function makeSignal(seconds, channels, sampleRate) {
  const length = Math.floor(seconds * sampleRate);
  const out = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const data = new Float32Array(length);
    const base = 110 * (1 + channel * 0.02);
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate;
      const beat = Math.exp(-6 * (t % 0.5));
      data[i] =
        0.28 * Math.sin(2 * Math.PI * base * t) * beat +
        0.16 * Math.sin(2 * Math.PI * base * 2 * t) * beat +
        0.09 * Math.sin(2 * Math.PI * base * 3.01 * t) +
        0.05 * (Math.random() * 2 - 1) * beat;
    }
    out.push(data);
  }
  return out;
}

// --------------------------------------------------------------- zincirler

async function buildSoundTouch(ctx, count, layout, seconds, errors) {
  await SoundTouchNode.register(ctx, PROCESSOR_URL);
  const master = ctx.createGain();
  master.gain.value = 0.25 / Math.sqrt(count);
  master.connect(ctx.destination);

  const starts = [];
  for (let i = 0; i < count; i += 1) {
    const node = new SoundTouchNode({ context: ctx, outputChannelCount: layout });
    node.onprocessorerror = () => errors.push(`soundtouch d${i}`);
    node.parameters.get("playbackRate").value = RATE;
    node.parameters.get("pitchSemitones").value = SEMITONES;

    const buffer = ctx.createBuffer(layout, Math.floor(seconds * ctx.sampleRate),
                                    ctx.sampleRate);
    const signal = makeSignal(seconds, layout, ctx.sampleRate);
    for (let ch = 0; ch < layout; ch += 1) buffer.copyToChannel(signal[ch], ch);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    // Tempo kaynağın playbackRate'inden; düğüm perdeyi telafi ediyor.
    source.playbackRate.value = RATE;
    source.connect(node);
    node.connect(master);
    starts.push(source);
  }
  return { master, start: (when) => starts.forEach((s) => s.start(when)) };
}

async function buildSignalsmith(ctx, count, layout, seconds, errors) {
  const master = ctx.createGain();
  master.gain.value = 0.25 / Math.sqrt(count);
  master.connect(ctx.destination);

  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const node = await SignalsmithStretch(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [layout],
    });
    node.onprocessorerror = () => errors.push(`signalsmith d${i}`);
    node.connect(master);
    await node.addBuffers(makeSignal(seconds, layout, ctx.sampleRate));
    nodes.push(node);
  }
  return {
    master,
    start: (when) => {
      for (const node of nodes) {
        node.schedule({ output: when, active: true, input: 0,
                        rate: RATE, semitones: SEMITONES });
      }
    },
  };
}

function buildChain(ctx, count, layout, seconds, errors) {
  return el("library").value === "signalsmith"
    ? buildSignalsmith(ctx, count, layout, seconds, errors)
    : buildSoundTouch(ctx, count, layout, seconds, errors);
}

function peakOf(buffer) {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

// ------------------------------------- kanal şeridi + yankı (Aşama 15)
// Esnetici YOK: yalnız şerit ve yankının eklediği maliyet. Aynı sinyal, 11 kaynak, stereo, bağlamın gerçek hızında.

async function renderFxCase(seconds, rate, { strips, room }) {
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: Math.floor(seconds * rate), sampleRate: rate });
  const master = ctx.createGain();
  master.gain.value = 0.3;
  master.connect(ctx.destination);
  let sendBus = null;
  if (room) {
    sendBus = ctx.createGain();
    const ir = impulseFor(room.size, room.decay, rate);
    const buffer = ctx.createBuffer(2, ir.left.length, rate);
    buffer.copyToChannel(ir.left, 0);
    buffer.copyToChannel(ir.right, 1);
    const convolver = ctx.createConvolver();
    convolver.normalize = false;
    convolver.buffer = buffer;
    sendBus.connect(convolver);
    convolver.connect(master);
  }
  const signal = makeSignal(seconds, 2, rate);
  for (let i = 0; i < 11; i += 1) {
    const buffer = ctx.createBuffer(2, Math.floor(seconds * rate), rate);
    for (let ch = 0; ch < 2; ch += 1) buffer.copyToChannel(signal[ch], ch);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 1 / 11;
    source.connect(gain);
    if (strips) {
      let last = gain;
      for (const band of EQ_BANDS) {
        const filter = ctx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = band.frequency;
        if (band.q) filter.Q.value = band.q;
        filter.gain.value = 3;                     // nötr değil: işlemci gerçekten çalışsın
        last.connect(filter);
        last = filter;
      }
      const panner = ctx.createStereoPanner();
      panner.pan.value = (i % 5) / 2 - 1;
      last.connect(panner);
      panner.connect(master);
      if (sendBus) {
        const send = ctx.createGain();
        send.gain.value = 0.5;
        panner.connect(send);
        send.connect(sendBus);
      }
    } else {
      gain.connect(master);
    }
    source.start(0);
  }
  const started = performance.now();
  const rendered = await ctx.startRendering();
  const elapsed = (performance.now() - started) / 1000;
  return { elapsed, peak: peakOf(rendered) };
}

async function runFxBench() {
  const picked = await resolveSampleRate();
  const seconds = Number(el("seconds").value);
  const body = el("fx-results").querySelector("tbody");
  body.innerHTML = "";
  el("run-fx").disabled = true;
  say(`Şerit + yankı ölçülüyor (${picked.rate} Hz, ${seconds} sn)… telefon başka iş yapmasın.`, "warn");
  log(`fx ölçümü: ${picked.rate} Hz, ${seconds} sn`);
  const cases = [
    ["taban (11 gain)", { strips: false }],
    ["+ 3 biquad + panner / kanal", { strips: true }],
    ["+ ortak yankı: büyük oda (2,2 sn)", { strips: true, room: { size: 0.7, decay: 2.2 } }],
    ["+ ortak yankı: salon (3 sn)", { strips: true, room: { size: 1, decay: 3 } }],
  ];
  let base = null;
  try {
    for (const [label, spec] of cases) {
      await renderFxCase(Math.min(seconds, 4), picked.rate, { strips: false });   // ısınma
      const { elapsed, peak } = await renderFxCase(seconds, picked.rate, spec);
      const ratio = elapsed / seconds;
      if (base === null) base = ratio;
      const row = document.createElement("tr");
      row.innerHTML =
        `<td>${label}</td><td class="num">${elapsed.toFixed(2)}</td><td class="num">${ratio.toFixed(3)}</td>` +
        `<td class="num ${peak < 0.0005 ? "bad" : ""}">${peak < 0.0005 ? "SESSİZ" : `+${(ratio - base).toFixed(3)}`}</td>`;
      body.append(row);
      log(`fx: ${label}: oran ${ratio.toFixed(3)} (taban ${base.toFixed(3)})`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    say("Şerit + yankı ölçümü bitti. 'Tabana göre' sütunu eklenen maliyet (oran birimi).", "ok");
  } catch (error) {
    say(`Ölçüm hatası: ${error && error.message ? error.message : error}`, "error");
  } finally {
    el("run-fx").disabled = false;
  }
}


// ---------------------------------------------------------------- dalga (tepe) hesabı

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

// Ölçüm sürerken rAF aralıklarını toplar; stop() aralık listesini verir.
function watchFrames() {
  const gaps = [];
  let last = performance.now();
  let alive = true;
  const tick = (now) => {
    if (!alive) return;
    gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => { alive = false; return gaps.slice(2); };
}

async function runPeaksBench() {
  const picked = await resolveSampleRate();
  const body = el("peaks-results").querySelector("tbody");
  body.innerHTML = "";
  el("run-peaks").disabled = true;
  say(`Dalga hesabı ölçülüyor (${picked.rate} Hz, 4 dk x 6 stem)… telefon başka iş yapmasın.`, "warn");
  const seconds = 240;
  const stems = 6;
  const data = makeSignal(seconds, 1, picked.rate)[0];     // altı stem aynı diziyi kullanır: bellek ~46 MB
  const bins = expectedBins(seconds);
  const addRow = (label, total, longest, gaps) => {
    const row = document.createElement("tr");
    row.innerHTML = `<td>${label}</td><td class="num">${total.toFixed(0)}</td><td class="num">${longest.toFixed(1)}</td>` +
      `<td class="num">${percentile(gaps, 0.95).toFixed(1)}</td><td class="num">${Math.max(0, ...gaps).toFixed(1)}</td>`;
    body.append(row);
    log(`dalga: ${label}: toplam ${total.toFixed(0)} ms, en uzun blok ${longest.toFixed(1)} ms, kare p95 ${percentile(gaps, 0.95).toFixed(1)} ms`);
  };
  try {
    // 1) taban: hesap yok
    let stop = watchFrames();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    addRow("taban (hesap yok)", 0, 0, stop());

    // 2) parçalı (uygulamadaki yol)
    stop = watchFrames();
    let started = performance.now();
    let longest = 0;
    for (let s = 0; s < stems; s += 1) {
      const job = new PeakJob([data], picked.rate, bins);
      while (!job.step(4)) await new Promise((resolve) => setTimeout(resolve, 0));
      longest = Math.max(longest, job.maxSliceMs);
    }
    addRow("parçalı (4 ms dilim, arka plan)", performance.now() - started, longest, stop());

    // 3) tek seferde (karşılaştırma)
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop = watchFrames();
    started = performance.now();
    for (let s = 0; s < stems; s += 1) {
      const job = new PeakJob([data], picked.rate, bins);
      job.step(1e9);
    }
    const blocked = performance.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 500));
    addRow("tek seferde (ana iş parçacığı bloklanır)", blocked, blocked, stop());
    say("Dalga hesabı ölçümü bitti. Parçalı satırda en uzun blok küçük ve kare aralığı tabana yakınsa hesap çalmayı / arayüzü aksatmaz.", "ok");
  } catch (error) {
    say(`Ölçüm hatası: ${error && error.message ? error.message : error}`, "error");
  } finally {
    el("run-peaks").disabled = false;
  }
}

// ---------------------------------------------------------------- nesnel

async function runOffline() {
  const picked = await resolveSampleRate();
  const layout = Number(el("layout").value);
  const seconds = Number(el("seconds").value);
  const body = el("results").querySelector("tbody");
  body.innerHTML = "";
  logLines.length = 0;
  el("run-offline").disabled = true;
  log(`kütüphane: ${el("library").value}, düzen: ${layout} kanal, ${seconds} sn`);
  log(`ölçüm hızı: ${picked.rate} Hz (mobil ses kalitesi: ${picked.mode})`);
  say("Ölçülüyor… telefon bu sırada başka iş yapmasın.", "warn");

  try {
    for (const count of CHANNEL_COUNTS) {
      const errors = [];
      const ctx = new OfflineAudioContext({
        numberOfChannels: layout,
        length: Math.floor(seconds * SAMPLE_RATE),
        sampleRate: SAMPLE_RATE,
      });
      const chain = await buildChain(ctx, count, layout, seconds, errors);
      chain.start(0);

      const started = performance.now();
      const rendered = await ctx.startRendering();
      const elapsed = (performance.now() - started) / 1000;
      const ratio = elapsed / seconds;
      const peak = peakOf(rendered);

      // SESSİZ ÇIKTIYI YAKALA: hızlı render "çalışıyor" demek değil.
      let verdict;
      if (peak < 0.0005) {
        verdict = ["bad", `SESSİZ (${errors.length} işlemci hatası)`];
        log(`${count} kanal: ÇIKTI SESSİZ, ${errors.length} processorerror`);
      } else if (ratio < 0.5) verdict = ["ok", "rahat"];
      else if (ratio < 0.8) verdict = ["warn", "sınırda"];
      else if (ratio < 1) verdict = ["warn", "pay çok az"];
      else verdict = ["bad", "gerçek zamandan YAVAŞ"];

      const row = document.createElement("tr");
      row.innerHTML =
        `<td>${count}</td>` +
        `<td class="num">${elapsed.toFixed(2)}</td>` +
        `<td class="num">${seconds.toFixed(0)}</td>` +
        `<td class="num">${ratio.toFixed(3)}</td>` +
        `<td class="num">${peak.toFixed(4)}</td>` +
        `<td class="${verdict[0]}">${verdict[1]}</td>`;
      body.append(row);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    // GERÇEK TOPOLOJİ: 6 kaynak -> bus -> TEK düğüm. Yukarıdaki satırlar
    // N AYRI düğüm ölçüyor; uygulamada kullanılan mimari bu değil.
    // Gerçek zamanlı CPU payı tarayıcıdan doğrudan okunamıyor, offline
    // render oranı en iyi vekil.
    {
      const errors = [];
      const ctx = new OfflineAudioContext({
        numberOfChannels: layout,
        length: Math.floor(seconds * SAMPLE_RATE),
        sampleRate: SAMPLE_RATE,
      });
      const master = ctx.createGain();
      master.gain.value = 0.3;
      master.connect(ctx.destination);
      const stretch = await buildLiveStretcher(ctx, layout, el("library").value, errors);
      const bus = ctx.createGain();
      bus.connect(stretch.node);
      stretch.node.connect(master);
      for (let i = 0; i < 6; i += 1) {
        const buffer = ctx.createBuffer(layout, Math.floor(seconds * SAMPLE_RATE), SAMPLE_RATE);
        const signal = makeSignal(seconds, layout, SAMPLE_RATE);
        for (let ch = 0; ch < layout; ch += 1) buffer.copyToChannel(signal[ch], ch);
        const gain = ctx.createGain();
        gain.gain.value = 1 / 6;
        gain.connect(bus);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = RATE;
        source.connect(gain);
        source.start(0);
      }
      stretch.start(0);

      const started = performance.now();
      const rendered = await ctx.startRendering();
      const elapsed = (performance.now() - started) / 1000;
      const ratio = elapsed / seconds;
      const peak = peakOf(rendered);
      let verdict;
      if (peak < 0.0005) verdict = ["bad", `SESSİZ (${errors.length} hata)`];
      else if (ratio < 0.5) verdict = ["ok", "rahat"];
      else if (ratio < 0.8) verdict = ["warn", "sınırda"];
      else verdict = ["bad", "pay yok"];
      const row = document.createElement("tr");
      row.innerHTML =
        `<td><strong>6 &rarr; tek düğüm</strong></td>` +
        `<td class="num">${elapsed.toFixed(2)}</td>` +
        `<td class="num">${seconds.toFixed(0)}</td>` +
        `<td class="num">${ratio.toFixed(3)}</td>` +
        `<td class="num">${peak.toFixed(4)}</td>` +
        `<td class="${verdict[0]}">${verdict[1]} (gerçek mimari)</td>`;
      body.append(row);
      log(`tek düğüm topolojisi: oran ${ratio.toFixed(3)}, tepe ${peak.toFixed(4)}`);
    }
    say("Nesnel ölçüm bitti. Şimdi kulakla da dinle (2. bölüm).", "ok");
  } catch (error) {
    say(`Ölçüm başarısız: ${error && error.message ? error.message : error}`, "error");
    log(`ÖLÇÜM HATASI: ${error && error.message ? error.message : error}`);
  } finally {
    el("run-offline").disabled = false;
  }
}

// ---------------------------------------------------------------- öznel

let liveCtx = null;
let liveTimer = null;
let liveMaster = null;

// AudioContext kullanıcı hareketinin İÇİNDE, await'ten ÖNCE kuruluyor.
// (SAMPLE_RATE açılışta resolveSampleRate ile ayarlanıyor; burada await
// edilemez, kullanıcı hareketi kaybolur.)
function openContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  let ctx;
  try {
    ctx = new Ctor({ sampleRate: SAMPLE_RATE });
  } catch (error) {
    log(`sampleRate ${SAMPLE_RATE} reddedildi, varsayılana düşülüyor`);
    ctx = new Ctor();
  }
  const resumed = ctx.resume();
  if (resumed && resumed.catch) resumed.catch((e) => log(`resume reddedildi: ${e.message}`));
  log(`context açıldı: state=${ctx.state} sampleRate=${ctx.sampleRate}`);
  return ctx;
}

async function measurePeak(ms) {
  const analyser = liveCtx.createAnalyser();
  analyser.fftSize = 2048;
  liveMaster.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  let peak = 0;
  const until = performance.now() + ms;
  while (performance.now() < until) {
    analyser.getFloatTimeDomainData(buffer);
    for (let i = 0; i < buffer.length; i += 1) {
      const value = Math.abs(buffer[i]);
      if (value > peak) peak = value;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  liveMaster.disconnect(analyser);
  return peak;
}

async function testTone() {
  logLines.length = 0;
  const ctx = openContext();
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 440;
    gain.gain.value = 0.2;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 1);
    log("test tonu başladı (440 Hz, 1 sn)");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    log("Test tonunu DUYDUYSAN ses yolu çalışıyor demektir.");
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function runRealtime() {
  if (liveCtx) await stopRealtime();
  const layout = Number(el("layout").value);
  el("run-realtime").disabled = true;
  el("stop-realtime").disabled = false;
  el("realtime-info").textContent = "Hazırlanıyor…";
  logLines.length = 0;

  liveCtx = openContext();
  const ctx = liveCtx;
  const errors = [];

  try {
    log(`6 kanal kuruluyor (kütüphane=${el("library").value}, düzen=${layout})`);
    const chain = await buildChain(ctx, 6, layout, 16, errors);
    liveMaster = chain.master;
    log("kanallar hazır");

    if (ctx.state === "suspended") {
      log("context suspended, tekrar resume deneniyor");
      await ctx.resume().catch((e) => log(`ikinci resume başarısız: ${e.message}`));
    }

    const when = ctx.currentTime + 0.25;
    chain.start(when);
    log(`başlangıç zamanı ${when.toFixed(3)} (şu an ${ctx.currentTime.toFixed(3)})`);

    const peak = await measurePeak(1500);
    log(`işlemci hatası: ${errors.length}`);
    if (peak > 0.001) {
      log(`çıkış seviyesi ${peak.toFixed(4)} — SES ÜRETİLİYOR. ` +
          `Duymuyorsan cihaz sesi/yönlendirme sorunudur.`);
    } else {
      log(`çıkış seviyesi ${peak.toFixed(4)} — SES ÜRETİLMİYOR.`);
    }

    el("realtime-info").textContent = "6 kanal çalıyor. Takılma duyuyor musun?";
    liveTimer = setTimeout(stopRealtime, 15000);
  } catch (error) {
    log(`KURULUM HATASI: ${error && error.message ? error.message : error}`);
    el("realtime-info").textContent = "Başarısız — tanı günlüğüne bak.";
    await stopRealtime();
  }
}

async function stopRealtime() {
  clearTimeout(liveTimer);
  liveTimer = null;
  if (liveCtx) {
    await liveCtx.close().catch(() => {});
    liveCtx = null;
    liveMaster = null;
  }
  el("run-realtime").disabled = false;
  el("stop-realtime").disabled = true;
}

// ------------------------------------- 3. tek düğüm, CANLI giriş (Aşama 8.1)
//
// Uygulamanın gerçek mimarisi: 6 kaynak -> kanal gain'leri -> toplama bus'ı
// -> TEK esnetici düğümü -> master.
//
// Yukarıdaki iki bölüm signalsmith'i TAMPON kipinde çalıştırıyordu
// (numberOfInputs: 0 + addBuffers) ve 4. düğümden itibaren susuyordu.
// Burası CANLI GİRİŞ kipi ve tek düğüm; o kip hiç denenmedi.
//
// Asıl aranan arıza SONRADAN SUSMA: çıkış seviyesi sürekli izleniyor,
// 1 saniyeden uzun sessizlik zamanıyla raporlanıyor.

const SINGLE_SOURCES = 6;
const SINGLE_LOOP_SECONDS = 16;
const SILENCE_LEVEL = 0.002;
const SILENCE_SECONDS = 1.0;   // bu kadar süren sessizlik "sustu" sayılıyor
const SETTLE_SECONDS = 2.0;    // başlangıç doluşu sessizlik sayılmasın

let singleCtx = null;
let singleWatch = null;
let singleTimer = null;
// İzleme rAF ile YAPILMIYOR: ekran kapanınca ya da sekme arkaya geçince
// rAF duruyor ve 60 saniyelik ölçüm sessizce ölüyor. 5 Hz zaten yeterli.
const SINGLE_WATCH_MS = 200;

function setSingle(id, text, cls) {
  const node = el(id);
  if (!node) return;
  node.textContent = text;
  node.className = cls ? cls : node.className.replace(/\b(ok|warn|bad)\b/g, "");
}

async function buildLiveStretcher(ctx, layout, library, errors) {
  if (library === "signalsmith") {
    const node = await SignalsmithStretch(ctx, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [layout],
    });
    node.onprocessorerror = (event) =>
      errors.push(`signalsmith: ${(event && event.message) || "processorerror"}`);
    return {
      node,
      // CANLI girişte signalsmith rate'i YOK SAYIYOR (README): tempo zaten
      // kaynağın playbackRate'inden geliyor, düğüm yalnız perde kaydırıyor.
      // Kaynak perdeyi RATE katı kaydırdığı için telafi elle yapılıyor.
      start(when) {
        node.schedule({
          output: when,
          active: true,
          semitones: SEMITONES - 12 * Math.log2(RATE),
        });
      },
      async latency() {
        try {
          return await node.latency();
        } catch (error) {
          log(`latency() okunamadı: ${error && error.message}`);
          return null;
        }
      },
    };
  }

  await SoundTouchNode.register(ctx, PROCESSOR_URL);
  const node = new SoundTouchNode({ context: ctx, outputChannelCount: [layout] });
  node.onprocessorerror = () => errors.push("soundtouch: processorerror");
  node.parameters.get("playbackRate").value = RATE;
  node.parameters.get("pitchSemitones").value = SEMITONES;
  node.setStretchParameters({ quickSeek: false });
  return { node, start() {}, async latency() { return null; } };
}

async function runSingleNode() {
  if (singleCtx) await stopSingleNode();
  const layout = Number(el("layout").value);
  const library = el("library").value;
  const seconds = Number(el("single-seconds").value);
  logLines.length = 0;
  el("run-single").disabled = true;
  el("stop-single").disabled = false;
  for (const id of ["s-elapsed", "s-level", "s-peak", "s-errors", "s-silence",
                    "s-latency", "s-verdict"]) setSingle(id, "—");
  setSingle("s-state", "kuruluyor…", "warn");

  singleCtx = openContext();
  const ctx = singleCtx;
  const errors = [];

  try {
    log(`tek düğüm canlı kip: ${library}, ${layout} kanal, ${RATE}x, +${SEMITONES} ton`);

    const master = ctx.createGain();
    master.gain.value = 0.3;
    master.connect(ctx.destination);

    const stretch = await buildLiveStretcher(ctx, layout, library, errors);
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(stretch.node);
    stretch.node.connect(master);
    log("düğüm kuruldu, bus bağlandı");

    // 6 kaynak, her biri kendi gain'iyle - uygulamadaki zincirin aynısı.
    const sources = [];
    for (let i = 0; i < SINGLE_SOURCES; i += 1) {
      const frames = Math.floor(SINGLE_LOOP_SECONDS * ctx.sampleRate);
      const buffer = ctx.createBuffer(layout, frames, ctx.sampleRate);
      const signal = makeSignal(SINGLE_LOOP_SECONDS, layout, ctx.sampleRate);
      for (let ch = 0; ch < layout; ch += 1) buffer.copyToChannel(signal[ch], ch);
      const gain = ctx.createGain();
      gain.gain.value = 1 / SINGLE_SOURCES;
      gain.connect(bus);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;           // 60 sn boyunca aksın
      source.playbackRate.value = RATE;
      source.connect(gain);
      sources.push(source);
    }

    if (ctx.state === "suspended") {
      await ctx.resume().catch((e) => log(`resume başarısız: ${e.message}`));
    }

    const when = ctx.currentTime + 0.25;
    for (const source of sources) source.start(when);
    stretch.start(when);
    log(`başlangıç ${when.toFixed(3)} (şu an ${ctx.currentTime.toFixed(3)})`);

    const reported = await stretch.latency();
    setSingle("s-latency", reported === null || reported === undefined
      ? "kütüphane bildirmiyor"
      : `${(reported * 1000).toFixed(1)} ms`);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    master.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    const started = performance.now();
    let overallPeak = 0;
    let silentFrom = null;
    let firstSilenceAt = null;
    let silentTotal = 0;
    setSingle("s-state", "çalıyor — dinle", "ok");

    const watch = () => {
      if (!singleCtx) return;
      analyser.getFloatTimeDomainData(samples);
      let level = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const value = Math.abs(samples[i]);
        if (value > level) level = value;
      }
      const elapsed = (performance.now() - started) / 1000;
      if (elapsed > SETTLE_SECONDS && level > overallPeak) overallPeak = level;

      if (elapsed > SETTLE_SECONDS) {
        if (level < SILENCE_LEVEL) {
          if (silentFrom === null) silentFrom = elapsed;
          else if (elapsed - silentFrom >= SILENCE_SECONDS && firstSilenceAt === null) {
            firstSilenceAt = silentFrom;
            log(`SUSTU: ${silentFrom.toFixed(1)} sn'de ses kesildi`);
          }
        } else {
          if (silentFrom !== null) silentTotal += elapsed - silentFrom;
          silentFrom = null;
        }
      }

      setSingle("s-elapsed", `${elapsed.toFixed(1)} / ${seconds} sn`);
      setSingle("s-level", level.toFixed(4));
      setSingle("s-peak", overallPeak.toFixed(4));
      setSingle("s-errors", String(errors.length),
                errors.length ? "bad" : "ok");
      setSingle("s-silence",
        firstSilenceAt === null ? "hayır" : `EVET, ${firstSilenceAt.toFixed(1)} sn'de`,
        firstSilenceAt === null ? "ok" : "bad");
    };
    singleWatch = setInterval(watch, SINGLE_WATCH_MS);

    singleTimer = setTimeout(() => {
      const passed = errors.length === 0 && firstSilenceAt === null && overallPeak > 0.01;
      setSingle("s-verdict",
        passed
          ? "GEÇTİ — canlı kip tek düğümle çalışıyor"
          : `KALDI — ${errors.length} hata, ` +
            `${firstSilenceAt === null ? "sessizlik yok" : "sustu"}, ` +
            `tepe ${overallPeak.toFixed(4)}`,
        passed ? "ok" : "bad");
      log(passed ? "SONUÇ: GEÇTİ" : "SONUÇ: KALDI");
      stopSingleNode();
    }, seconds * 1000);
  } catch (error) {
    const text = error && error.message ? error.message : String(error);
    log(`KURULUM HATASI: ${text}`);
    setSingle("s-state", "kurulamadı", "bad");
    setSingle("s-verdict", `KALDI — ${text}`, "bad");
    await stopSingleNode();
  }
}

async function stopSingleNode() {
  clearTimeout(singleTimer);
  singleTimer = null;
  clearInterval(singleWatch);
  singleWatch = null;
  if (singleCtx) {
    const ctx = singleCtx;
    singleCtx = null;
    await ctx.close().catch(() => {});
  }
  if (el("s-state").textContent === "çalıyor — dinle") setSingle("s-state", "durduruldu");
  el("run-single").disabled = false;
  el("stop-single").disabled = true;
}

// ---------------------------------------------------------------- ortam

function showEnvironment() {
  el("env").textContent = [
    `userAgent      : ${navigator.userAgent}`,
    `deviceMemory   : ${navigator.deviceMemory ?? "bilinmiyor"} GB`,
    `hardwareConcurrency: ${navigator.hardwareConcurrency ?? "bilinmiyor"}`,
    `ölçüm oranı    : ${SAMPLE_RATE} Hz (ses kalitesi ayarından)`,
    `AudioWorklet   : ${typeof AudioWorklet !== "undefined" ? "var" : "YOK"}`,
    `WebAssembly    : ${typeof WebAssembly !== "undefined" ? "var" : "YOK"}`,
  ].join("\n");
}


// ---------------------------------------------------------------- mikrofon denemesi (Mikrofon paketi, 0. adım)
// AMAÇ: Bluetooth kulaklıkta mikrofon açılınca müzik bozuluyor mu (HFP/SCO'ya geçiş)? Antrenör kodu YOK.
// GİZLİLİK: mikrofon örnekleri yalnız anlık seviye (RMS) için bir AnalyserNode'dan okunur; kaydedilmez, saklanmaz, gönderilmez,
// loga yazılmaz (log'a yalnız aygıt etiketi/ayar bilgisi gider, ses değeri DEĞİL). Sayfa gizlenince mikrofon kapanır.
// MIC-BAŞLANGIÇ
const MIC_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
const BLUETOOTH_LABEL = /bluetooth|\bbt\b|hands-?free|headset|buds|airpods|soundcore|space ?q|q45|earbud|headphone|kulakl/i;
const BUILTIN_LABEL = /built-?in|internal|dahili|phone|telefon|microphone|mikrofon/i;

const mic = { ctx: null, music: null, stream: null, source: null, analyser: null, sink: null, timer: 0 };

function micEnsureContext() {
  if (!mic.ctx || mic.ctx.state === "closed") {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    mic.ctx = new Ctor({ latencyHint: "interactive" });
  }
  return mic.ctx;
}

function micCtxInfo() {
  const ctx = mic.ctx;
  if (!ctx) return "—";
  const out = Number.isFinite(ctx.outputLatency) ? `${(ctx.outputLatency * 1000).toFixed(0)} ms` : "yok";
  return `${ctx.state} · ${ctx.sampleRate} Hz · outputLatency ${out} · baseLatency ${(ctx.baseLatency * 1000).toFixed(0)} ms`;
}

function micRefreshState() {
  el("mic-s-ctx").textContent = micCtxInfo();
  el("mic-s-music").textContent = mic.music ? "çalıyor (parlak tizli, stereo)" : "kapalı";
  const supported = navigator.mediaDevices && navigator.mediaDevices.getSupportedConstraints
    ? navigator.mediaDevices.getSupportedConstraints() : {};
  el("mic-s-supported").textContent =
    ["echoCancellation", "noiseSuppression", "autoGainControl", "channelCount", "deviceId"]
      .map((key) => `${key}: ${supported[key] ? "var" : "YOK"}`).join(" · ");
}

// Müzik: stereo akor (sol/sağ ayrı sesler) + 6 kHz üstü "hi-hat" gürültü vuruşları. Dar bantlı / mono bir hat (HFP) bunları belirgin söndürür.
function micMusicStart() {
  if (mic.music) return;
  const ctx = micEnsureContext();
  const master = ctx.createGain();
  master.gain.value = 0.16;
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 9000;
  tone.connect(master);
  master.connect(ctx.destination);
  const oscillators = [];
  [[110, -0.8], [164.81, 0.8], [220, -0.5], [277.18, 0.5], [329.63, -0.2], [440, 0.2]].forEach(([freq, pan], index) => {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = freq;
    osc.detune.value = index % 2 ? 4 : -4;
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    const gain = ctx.createGain();
    gain.gain.value = 0.18;
    osc.connect(gain).connect(panner).connect(tone);
    osc.start();
    oscillators.push(osc);
  });
  const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.06), ctx.sampleRate);
  const data = noise.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  let next = ctx.currentTime + 0.1;
  const schedule = () => {
    while (next < ctx.currentTime + 0.6) {
      const hat = ctx.createBufferSource();
      hat.buffer = noise;
      const high = ctx.createBiquadFilter();
      high.type = "highpass";
      high.frequency.value = 6500;
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      hat.connect(high).connect(gain).connect(master);
      hat.start(next);
      next += 0.25;
    }
  };
  schedule();
  const timer = setInterval(schedule, 150);
  mic.music = { oscillators, master, timer };
  el("mic-music-start").disabled = true;
  el("mic-music-stop").disabled = false;
  log("mikrofon denemesi: müzik başladı");
  micRefreshState();
}

function micMusicStop() {
  if (!mic.music) return;
  clearInterval(mic.music.timer);
  for (const osc of mic.music.oscillators) {
    try { osc.stop(); } catch { /* zaten durmuş */ }
  }
  try { mic.music.master.disconnect(); } catch { /* bağlı değildi */ }
  mic.music = null;
  el("mic-music-start").disabled = false;
  el("mic-music-stop").disabled = true;
  log("mikrofon denemesi: müzik durdu");
  micRefreshState();
}

async function micListDevices() {
  const body = el("mic-devices").querySelector("tbody");
  body.innerHTML = "";
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    body.innerHTML = '<tr><td colspan="4">enumerateDevices yok</td></tr>';
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  for (const device of devices) {
    const row = document.createElement("tr");
    const label = device.label || "(etiket yok: izin gerekli)";
    const bluetooth = device.label ? (BLUETOOTH_LABEL.test(device.label) ? "evet (etiketten)" : "hayır görünüyor") : "?";
    for (const text of [device.kind, label, (device.deviceId || "").slice(0, 8) || "—", bluetooth]) {
      const cell = document.createElement("td");
      cell.textContent = text;
      row.append(cell);
    }
    body.append(row);
  }
  const inputs = devices.filter((d) => d.kind === "audioinput");
  log(`mikrofon denemesi: ${devices.length} aygıt, ${inputs.length} mikrofon: ${inputs.map((d) => d.label || "(etiketsiz)").join(" | ")}`);
  return devices;
}

// Dahili mikrofon tahmini: Bluetooth görünmeyen, tercihen "built-in/dahili/telefon" etiketli mikrofon.
async function micFindBuiltin() {
  const devices = (await micListDevices()).filter((d) => d.kind === "audioinput");
  if (!devices.length || devices.every((d) => !d.label)) return { id: null, reason: "Etiketler boş: önce 3a (varsayılan) ile izin ver, sonra 3b'yi dene." };
  const others = devices.filter((d) => !BLUETOOTH_LABEL.test(d.label) && d.deviceId !== "default" && d.deviceId !== "communications");
  const pick = others.find((d) => BUILTIN_LABEL.test(d.label)) || others[0];
  if (!pick) return { id: null, reason: "Bluetooth olmayan ayrı bir mikrofon görünmüyor (yalnız varsayılan/kulaklık)." };
  return { id: pick.deviceId, label: pick.label };
}

function micMeterStart() {
  const ctx = mic.ctx;
  mic.analyser = ctx.createAnalyser();
  mic.analyser.fftSize = 1024;
  mic.source.connect(mic.analyser);
  // Chrome yalnız hedefe bağlı düğümleri işleyebilir: analizör sessiz (kazanç 0) bir yoldan hedefe bağlanır (hoparlöre HİÇ ses gitmez).
  mic.sink = ctx.createGain();
  mic.sink.gain.value = 0;
  mic.analyser.connect(mic.sink);
  mic.sink.connect(ctx.destination);
  const buffer = new Float32Array(mic.analyser.fftSize);
  const bar = el("mic-level");
  const text = el("mic-level-text");
  mic.timer = setInterval(() => {
    mic.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -120;
    const fraction = Math.min(Math.max((db + 70) / 70, 0), 1);
    bar.style.width = `${(fraction * 100).toFixed(0)}%`;
    bar.classList.toggle("hot", db > -12);
    text.textContent = `${db <= -100 ? "sessiz" : `${db.toFixed(0)} dBFS`}`;
    // örnekler burada biter: dizi her turda üzerine yazılır, hiçbir yere kopyalanmaz / gönderilmez / yazılmaz
  }, 60);
}

async function micOpen(kind) {
  if (mic.stream) {
    say("Mikrofon zaten açık; önce kapat.", "warn");
    return;
  }
  const ctx = micEnsureContext();
  await ctx.resume();
  const before = micCtxInfo();
  const audio = { ...MIC_AUDIO };
  let wanted = "varsayılan aygıt";
  if (kind === "builtin") {
    const found = await micFindBuiltin();
    if (!found.id) {
      say(found.reason, "warn");
      log(`mikrofon denemesi: dahili mikrofon yok: ${found.reason}`);
      return;
    }
    audio.deviceId = { exact: found.id };
    wanted = `dahili tahmini: ${found.label}`;
  }
  log(`mikrofon denemesi: açılıyor (${wanted}); öncesi: ${before}`);
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (error) {
    say(`Mikrofon açılamadı: ${error && error.name}: ${error && error.message}`, "error");
    log(`mikrofon denemesi: HATA ${error && error.name}`);
    return;
  }
  mic.stream = stream;
  mic.source = ctx.createMediaStreamSource(stream);
  micMeterStart();
  const track = stream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  el("mic-s-track").textContent = `açık (${track.readyState}${track.muted ? ", muted" : ""})`;
  el("mic-s-device").textContent = `${track.label || "(etiket yok)"} · ${(settings.deviceId || "").slice(0, 8)} · ${settings.sampleRate || "?"} Hz · ${settings.channelCount || "?"} kanal` +
    (BLUETOOTH_LABEL.test(track.label || "") ? " · BLUETOOTH GÖRÜNÜYOR" : "");
  el("mic-s-applied").textContent = ["echoCancellation", "noiseSuppression", "autoGainControl"]
    .map((key) => `${key}: istenen false → ${settings[key] === undefined ? "bilinmiyor" : settings[key]}${settings[key] === false ? " ✓" : settings[key] === undefined ? "" : " ✗"}`)
    .join(" · ");
  el("mic-close").disabled = false;
  el("mic-open-default").disabled = true;
  el("mic-open-builtin").disabled = true;
  await micListDevices();                         // etiketler artık görünür
  log(`mikrofon denemesi: açıldı: ${track.label} | ayarlar ${JSON.stringify({ echo: settings.echoCancellation, ns: settings.noiseSuppression, agc: settings.autoGainControl, rate: settings.sampleRate, ch: settings.channelCount })} | sonrası: ${micCtxInfo()}`);
  micRefreshState();
  say("Mikrofon açık. Müzik kalitesi değişti mi? (sönükleşme, mono, tizlerin gitmesi, ses düşmesi) Şimdi dinle, sonra 4'ü ile kapat.", "warn");
}

function micClose(reason = "") {
  if (mic.timer) clearInterval(mic.timer);
  mic.timer = 0;
  if (mic.stream) {
    for (const track of mic.stream.getTracks()) track.stop();
  }
  try { if (mic.source) mic.source.disconnect(); } catch { /* bağlı değildi */ }
  try { if (mic.analyser) mic.analyser.disconnect(); } catch { /* bağlı değildi */ }
  try { if (mic.sink) mic.sink.disconnect(); } catch { /* bağlı değildi */ }
  const wasOpen = Boolean(mic.stream);
  mic.stream = null;
  mic.source = null;
  mic.analyser = null;
  mic.sink = null;
  el("mic-level").style.width = "0";
  el("mic-level-text").textContent = "mikrofon kapalı";
  el("mic-s-track").textContent = "kapalı";
  el("mic-close").disabled = true;
  el("mic-open-default").disabled = false;
  el("mic-open-builtin").disabled = false;
  if (wasOpen) {
    log(`mikrofon denemesi: kapatıldı${reason ? ` (${reason})` : ""}; sonrası: ${micCtxInfo()}`);
    say("Mikrofon kapandı. Müzik eski kalitesine döndü mü? (birkaç saniye sürebilir)", "ok");
  }
  micRefreshState();
}
// MIC-BİTİŞ

el("mic-music-start").addEventListener("click", () => { try { micMusicStart(); } catch (e) { log(`müzik hatası: ${e.message}`); } });
el("mic-music-stop").addEventListener("click", micMusicStop);
el("mic-list").addEventListener("click", () => { micListDevices().catch((e) => log(`liste hatası: ${e.message}`)); });
el("mic-open-default").addEventListener("click", () => { micOpen("default").catch((e) => log(`mikrofon hatası: ${e.message}`)); });
el("mic-open-builtin").addEventListener("click", () => { micOpen("builtin").catch((e) => log(`mikrofon hatası: ${e.message}`)); });
el("mic-close").addEventListener("click", () => micClose());
document.addEventListener("visibilitychange", () => { if (document.hidden) micClose("sayfa gizlendi"); });
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    log("mikrofon denemesi: aygıt listesi değişti (kulaklık takıldı/çıkarıldı?)");
    micListDevices().catch(() => {});
  });
}
micRefreshState();

el("test-tone").addEventListener("click", () => {
  testTone().catch((e) => log(`test tonu hatası: ${e.message}`));
});
el("run-offline").addEventListener("click", runOffline);
el("run-fx").addEventListener("click", runFxBench);
el("run-peaks").addEventListener("click", runPeaksBench);
el("run-single").addEventListener("click", runSingleNode);
el("stop-single").addEventListener("click", stopSingleNode);
el("run-realtime").addEventListener("click", runRealtime);
el("stop-realtime").addEventListener("click", stopRealtime);
resolveSampleRate().then(showEnvironment).catch(() => showEnvironment());
