// Aşama 8 ölçümü: bu cihaz kaç kanalı aynı anda esnetebiliyor?
//
// Gerçek kütüphaneyle (signalsmith-stretch, MIT) ölçülüyor; sentetik yükle
// ölçmek yanlış cevap verirdi. Ses de sentetik üretiliyor, böylece API'ye ve
// token'a gerek kalmıyor.

import SignalsmithStretch from "../vendor/signalsmith-stretch/SignalsmithStretch.mjs";

const el = (id) => document.getElementById(id);
const CHANNEL_COUNTS = [1, 2, 4, 6];
const SAMPLE_RATE = 32000; // mobil yolumuzla aynı

function say(text, kind = "warn") {
  const node = el("message");
  node.hidden = false;
  node.className = `message ${kind}`;
  node.textContent = text;
}

// Müziğe benzer bir sinyal: birkaç harmonik + hafif gürültü + vuruş zarfı.
// Esnetme maliyeti içeriğe çok bağlı değil ama sessizlikle ölçmek yanıltıcı.
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

function presetOptions(name) {
  if (name === "cheaper") return { blockMs: 0, preset: "cheaper" };
  if (name === "split") return { splitComputation: true };
  return null;
}

async function buildChain(ctx, count, layout, preset, signalSeconds) {
  const nodes = [];
  const master = ctx.createGain();
  master.gain.value = 0.25 / Math.sqrt(count);
  master.connect(ctx.destination);

  for (let i = 0; i < count; i += 1) {
    const stretch = await SignalsmithStretch(ctx, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [layout],
    });
    const options = presetOptions(preset);
    if (options) stretch.configure(options);
    stretch.connect(master);
    await stretch.addBuffers(makeSignal(signalSeconds, layout, ctx.sampleRate));
    nodes.push(stretch);
  }
  return { nodes, master };
}

// ---------------------------------------------------------------- nesnel

async function runOffline() {
  const layout = Number(el("layout").value);
  const preset = el("preset").value;
  const seconds = Number(el("seconds").value);
  const body = el("results").querySelector("tbody");
  body.innerHTML = "";
  el("run-offline").disabled = true;
  say("Ölçülüyor… telefon bu sırada başka iş yapmasın.", "warn");

  try {
    for (const count of CHANNEL_COUNTS) {
      const ctx = new OfflineAudioContext({
        numberOfChannels: layout,
        length: Math.floor(seconds * SAMPLE_RATE),
        sampleRate: SAMPLE_RATE,
      });
      const { nodes } = await buildChain(ctx, count, layout, preset, seconds);
      for (const node of nodes) {
        node.schedule({ output: 0, active: true, input: 0, rate: 0.8, semitones: 2 });
      }

      const started = performance.now();
      await ctx.startRendering();
      const elapsed = (performance.now() - started) / 1000;
      const ratio = elapsed / seconds;

      const verdict =
        ratio < 0.5 ? ["ok", "rahat"] :
        ratio < 0.8 ? ["warn", "sınırda"] :
        ratio < 1 ? ["warn", "pay çok az"] :
        ["bad", "gerçek zamandan YAVAŞ"];

      const row = document.createElement("tr");
      row.innerHTML =
        `<td>${count}</td>` +
        `<td class="num">${elapsed.toFixed(2)}</td>` +
        `<td class="num">${seconds.toFixed(0)}</td>` +
        `<td class="num">${ratio.toFixed(3)}</td>` +
        `<td class="${verdict[0]}">${verdict[1]}</td>`;
      body.append(row);
      // Arayüzün nefes alması için
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    say("Nesnel ölçüm bitti. Şimdi kulakla da dinle (2. bölüm).", "ok");
  } catch (error) {
    say(`Ölçüm başarısız: ${error && error.message ? error.message : error}`, "error");
    console.error(error);
  } finally {
    el("run-offline").disabled = false;
  }
}

// ---------------------------------------------------------------- öznel

let liveCtx = null;
let liveTimer = null;

async function runRealtime() {
  await stopRealtime();
  const layout = Number(el("layout").value);
  const preset = el("preset").value;
  el("run-realtime").disabled = true;
  el("stop-realtime").disabled = false;
  el("realtime-info").textContent = "Hazırlanıyor…";

  try {
    liveCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
    });
    await liveCtx.resume();
    const { nodes } = await buildChain(liveCtx, 6, layout, preset, 16);
    const when = liveCtx.currentTime + 0.2;
    for (const node of nodes) {
      node.schedule({ output: when, active: true, input: 0, rate: 0.8, semitones: 2 });
    }
    el("realtime-info").textContent =
      `6 kanal çalıyor — hız 0.8x, ton +2. Çıkış gecikmesi: ` +
      `${((liveCtx.outputLatency || liveCtx.baseLatency || 0) * 1000).toFixed(0)} ms. ` +
      `Takılma duyuyor musun?`;
    liveTimer = setTimeout(stopRealtime, 15000);
  } catch (error) {
    el("realtime-info").textContent = `Başarısız: ${error.message}`;
    el("run-realtime").disabled = false;
    el("stop-realtime").disabled = true;
  }
}

async function stopRealtime() {
  clearTimeout(liveTimer);
  liveTimer = null;
  if (liveCtx) {
    await liveCtx.close().catch(() => {});
    liveCtx = null;
  }
  el("run-realtime").disabled = false;
  el("stop-realtime").disabled = true;
}

// ---------------------------------------------------------------- ortam

function showEnvironment() {
  const lines = [
    `userAgent      : ${navigator.userAgent}`,
    `deviceMemory   : ${navigator.deviceMemory ?? "bilinmiyor"} GB`,
    `hardwareConcurrency: ${navigator.hardwareConcurrency ?? "bilinmiyor"}`,
    `ölçüm oranı    : ${SAMPLE_RATE} Hz`,
    `AudioWorklet   : ${typeof AudioWorklet !== "undefined" ? "var" : "YOK"}`,
    `WebAssembly    : ${typeof WebAssembly !== "undefined" ? "var" : "YOK"}`,
  ];
  el("env").textContent = lines.join("\n");
}

el("run-offline").addEventListener("click", runOffline);
el("run-realtime").addEventListener("click", runRealtime);
el("stop-realtime").addEventListener("click", stopRealtime);
showEnvironment();
