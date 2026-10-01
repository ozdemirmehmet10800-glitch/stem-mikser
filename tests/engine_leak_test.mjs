// Engine: sarki degistirdikce graf'ta eski gain dugumleri KALMAMALI.
//
// Calistirma:
//     node tests\engine_leak_test.mjs
//
// Context uygulama omru boyunca acik; eski sarkinin gain dugumleri master'a
// bagli kalirsa (channels.clear() yetmiyordu) her acilis kalici ses-isleme
// yuku birakiyor. Sahte AudioContext bagli dugumleri sayar.

globalThis.AudioWorkletNode = class {};
globalThis.window = {
  AudioContext: undefined,
  matchMedia: () => ({ matches: false }),
};

const { Engine } = await import("../frontend/js/engine.js");

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

class FakeParam {
  constructor() { this.value = 1; this.events = []; }
  setTargetAtTime() {}
  cancelScheduledValues() { this.events = []; }
  setValueAtTime(value, time) { this.events.push(["set", value, time]); }
  linearRampToValueAtTime(value, time) { this.events.push(["ramp", value, time]); }
}

class FakeNode {
  constructor(ctx) {
    this.ctx = ctx;
    this.targets = new Set();
    this.gain = new FakeParam();
    this.playbackRate = new FakeParam();
  }
  connect(target) { this.targets.add(target); return target; }
  disconnect() { this.targets.clear(); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}

class FakeContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.nodes = [];
    this.destination = new FakeNode(this);
  }
  createGain() { const n = new FakeNode(this); this.nodes.push(n); return n; }
  createBufferSource() {
    const node = new FakeNode(this);
    this.sources = this.sources || [];
    this.sources.push(node);
    return node;
  }
  async resume() {}
  async close() {}
  async decodeAudioData() {
    return { duration: 21, numberOfChannels: 2, length: 1, sampleRate: 48000 };
  }
}

window.AudioContext = FakeContext;

const STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const provide = async () => new ArrayBuffer(8);

// Master'a (dolayli) bagli gain dugumu sayisi.
function liveGains(engine) {
  return engine.ctx.nodes.filter(
    (n) => n !== engine.master && n !== engine.seamGain && n.targets.size > 0
  ).length;
}

const engine = new Engine();

// 1) Acip CALMADAN cik: 30 kez.
for (let i = 0; i < 30; i += 1) {
  engine.releaseStems();
  await engine.loadStems(STEMS, provide, { concurrency: 3 });
}
check("calmadan 30 acilis sonrasi bagli gain = 6", liveGains(engine) === 6,
  `(${liveGains(engine)})`);

// 2) Cal, S/M yap, cik: 30 kez.
for (let i = 0; i < 30; i += 1) {
  engine.releaseStems();
  await engine.loadStems(STEMS, provide, { concurrency: 3 });
  await engine.play();
  engine.toggleSolo("drums");
  engine.toggleMute("drums");
  engine.pause();
}
check("calarak 30 acilis sonrasi bagli gain = 6", liveGains(engine) === 6,
  `(${liveGains(engine)})`);

// 3) Serbest birakinca hicbiri kalmiyor.
engine.releaseStems();
check("releaseStems sonrasi bagli gain = 0", liveGains(engine) === 0,
  `(${liveGains(engine)})`);

// 4) Ayni sarkiya donus (tamponlar kalir): dugumler korunur.
await engine.loadStems(STEMS, provide, { concurrency: 3 });
const before = [...engine.channels.values()].map((c) => c.gainNode);
check("kanal gain'leri baglida", before.every((g) => g.targets.size === 1));

// 5) Cal -> context askiya alinir: motor duraklatmali ve haber vermeli.
{
  const e2 = new Engine();
  await e2.loadStems(STEMS, provide, { concurrency: 3 });
  await e2.play();
  let told = null;
  let back = false;
  e2.onInterrupted = (state) => { told = state; };
  e2.onResumed = () => { back = true; };
  e2.ctx.currentTime = 5;           // saat 5 sn'de donuyor
  e2.ctx.state = "suspended";
  e2.ctx.onstatechange();
  check("askida: motor duraklatildi", e2.playing === false);
  check("askida: arayuze haber verildi", told === "suspended");
  check("askida: konum donuk saatten hesaplandi", e2.currentTime > 4.5 && e2.currentTime < 5.1,
    `(${e2.currentTime.toFixed(2)})`);
  e2.ctx.state = "running";
  e2.ctx.onstatechange();
  check("geri gelince onResumed", back === true);
  check("geri gelince kendiliginden CALMIYOR", e2.playing === false);
  const info = e2.diagnostics();
  check("tani: liveGains = 6", info.liveGains === 6, `(${info.liveGains})`);
  check("tani: PCM baytlari", info.pcmBytes === 6 * 1 * 2 * 4, `(${info.pcmBytes})`);
  check("tani: bellekte 1 sarki", info.songs === 1);
  // Durmusken gelen askida olayi duraklatma/uyari uretmez.
  told = null;
  e2.ctx.state = "suspended";
  e2.ctx.onstatechange();
  check("calmazken askida: uyari yok", told === null);
  e2.dispose();
}

engine.dispose();
check("dispose sonrasi kanal yok", engine.channels.size === 0);

// ---------------------------------------------------------------- A-B dongu
const liveSources = (e) =>
  (e.ctx.sources || []).filter((n) => n.targets.size > 0 && !n.stopped).length;
const near = (x, y, eps = 1e-6) => Math.abs(x - y) <= eps;

{
  const e = new Engine();
  await e.loadStems(STEMS, provide, { concurrency: 3 });
  const cleared = [];
  e.onLoopCleared = (why) => cleared.push(why);

  // Cal degilken kurulum: konum A'ya alinir.
  check("setLoop (calmiyor) 'set'", (await e.setLoop(2, 6)) === "set");
  check("setLoop: konum A'ya alindi", e.currentTime === 2);

  await e.play();
  const sources = [...e.channels.values()].map((c) => c.source);
  check("6 kaynakta native dongu", sources.length === 6 && sources.every(
    (s) => s.loop === true && s.loopStart === 2 && s.loopEnd === 6));

  // Saat: elapsed 5 sn, rate 1, D = 0 -> ham 7 -> konum 3
  e.ctx.currentTime = e.startedAt + 5;
  check("currentTime sarmali: ham 7 -> 3", near(e.currentTime, 3), String(e.currentTime));
  check("visualTime de sarmali", e.visualTime >= 2 && e.visualTime < 6);
  check("currentTurn = 1", e.currentTurn === 1);
  check("songToCtx(a, tur)", near(e.songToCtx(2, 1), e.startedAt + 4) &&
    near(e.songToCtx(2, 2), e.startedAt + 8) && near(e.songToCtx(3, 0), e.startedAt + 1));

  // Dikis cukuru: cikistaki dikis ani (D dahil). Dongu 1 sn: ufuk (2.5 sn)
  // icinde birden cok dikis var.
  e.ctx.currentTime = e.startedAt + 0.5;
  e.stop();
  await e.setLoop(2, 3);
  await e.play();
  const gainEvents = e.seamGain.gain.events;
  const dipAt = e.songToCtx(2, 1);
  check("dikis cukuru yazildi (0'a iniyor)", gainEvents.some(
    (ev) => ev[0] === "ramp" && ev[1] === 0 && near(ev[2], dipAt)), JSON.stringify(gainEvents.slice(0, 4)));
  check("cukur 1 -> 0 -> 1 ve dikisi ortalar", gainEvents.some(
    (ev) => ev[0] === "set" && ev[1] === 1 && ev[2] < dipAt) && gainEvents.some(
    (ev) => ev[0] === "ramp" && ev[1] === 1 && ev[2] > dipAt));
  check("ufuk icinde birden cok dikis onceden yazildi",
    gainEvents.filter((ev) => ev[0] === "ramp" && ev[1] === 0).length >= 2);

  // Esnetici gecikmesi dikis zamanina eklenir (D dahil); degisince yeniden yazilir.
  e.latency = 0.12;
  check("songToCtx D dahil", near(e.songToCtx(2, 1), e.startedAt + 0.12 + 1));
  e.latency = 0;

  e.stop();
  await e.setLoop(2, 6);
  await e.play();

  // Canli degisim: dongu icinde, B'ye uzak -> kesintisiz.
  e.ctx.currentTime = e.startedAt + 1;
  const before = e.epoch;
  check("setLoop calarken icerde -> 'live'", (await e.setLoop(1.5, 7)) === "live");
  check("live: epoch artti, kaynaklar yeni sinirlarda", e.epoch > before &&
    [...e.channels.values()].every((c) => c.source.loopStart === 1.5 && c.source.loopEnd === 7));
  check("live: konum surekli (kaymadi)", near(e.currentTime, 3, 0.011), String(e.currentTime));

  // B'ye cok yakin / disarida -> A'ya yeniden baslatma
  e.ctx.currentTime = e.startedAt + 3.0;
  const pos = e.currentTime;
  check("setLoop B'nin disinda -> 'restart'", (await e.setLoop(1, pos - 0.5)) === "restart");
  check("restart: A'dan basladi", e.offset === 1 && e.playing);

  // Disari seek dongu kapatir, bildirim gelir; icerdeki kapatmaz.
  await e.seek(3);
  check("icerdeki seek dongu kapatmaz", e.loop !== null && cleared.length === 0);
  await e.seek(0);
  check("disardaki seek dongu kapatir + bildirir", e.loop === null && cleared.join() === "seek");
  check("kapaninca dikis zamanlayicisi durdu", e.seamTimer === null);

  // keepLoop: dongunun kendi atlamasi
  await e.setLoop(2, 6);
  await e.seek(2, { keepLoop: true });
  check("keepLoop: dongu kapanmaz", e.loop !== null);

  // clearLoop calarken: kaynaklar dongusuz, konum surekli
  e.ctx.currentTime = e.startedAt + 1;
  const at = e.currentTime;
  e.clearLoop();
  check("clearLoop: kaynaklar dongusuz", [...e.channels.values()].every((c) => c.source.loop === false));
  check("clearLoop: konum surekli", near(e.currentTime, at, 0.011), `${e.currentTime} vs ${at}`);

  // Dongu varken sarki bitmez (b = sarki sonu bile olsa)
  await e.setLoop(10, e.duration);
  e.ctx.currentTime = e.startedAt + 100;
  check("dongu varken checkEnded false", e.checkEnded() === false && e.playing);

  // Sizinti: dongu + cal + durdur 30 kez
  for (let i = 0; i < 30; i += 1) {
    e.releaseStems();
    await e.loadStems(STEMS, provide, { concurrency: 3 });
    await e.setLoop(2, 6);
    await e.play();
    e.toggleSolo("drums");
    await e.setLoop(3, 7);
    e.pause();
  }
  check("dongu + cal/durdur 30 kez: bagli gain = 6", liveGains(e) === 6, `(${liveGains(e)})`);
  check("dongu + cal/durdur 30 kez: canli kaynak yok", liveSources(e) === 0, `(${liveSources(e)})`);
  check("durdurunca dikis zamanlayicisi yok", e.seamTimer === null);

  await e.play();
  check("calarken canli kaynak = 6", liveSources(e) === 6);
  e.releaseStems();
  check("releaseStems: dongu sifirlandi, kaynak ve gain yok",
    e.loop === null && liveSources(e) === 0 && liveGains(e) === 0 && e.seamTimer === null);
  e.dispose();
}

if (failed) {
  console.log(`\n${failed} test BASARISIZ`);
  process.exit(1);
}
console.log("\nhepsi gecti");
