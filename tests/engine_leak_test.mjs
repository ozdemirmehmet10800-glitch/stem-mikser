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
  const dips = gainEvents.filter((ev) => ev[0] === "ramp" && ev[1] === 0).length;
  check("ufuk 30 sn: 1 sn'lik dongude ~30 dikis onceden yazildi", dips >= 28 && dips <= 31, `(${dips})`);

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
  {
    const ramps = e.seamGain.gain.events.filter((ev) => ev[0] === "ramp" && ev[1] === 0);
    const L = 7 - 1.5;
    check("live: eski dikisler iptal, yenileri yazildi (30 sn / yeni uzunluk)",
      ramps.length >= 4 && ramps.length <= 7, `(${ramps.length})`);
    check("live: tum cukurlar yeni dikis zamanlarinda", ramps.every((ev) => {
      const k = Math.round((ev[2] - e.songToCtx(1.5, 0)) / (L / e.rate));
      return near(ev[2], e.songToCtx(1.5, k), 1e-6);
    }));
  }
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

// ------------------------------------------------- alt kanallar (Asama 10)
{
  const e = new Engine();
  await e.loadStems(STEMS, provide, { concurrency: 3 });
  const bufs = async () => new Map([
    ["lead", await e.decode(new ArrayBuffer(8))],
    ["backing", await e.decode(new ArrayBuffer(8))],
  ]);
  check("baslangic: bagli gain = 6, kapali", liveGains(e) === 6 && !e.isExpanded("vocals"));

  // Ana kanalin ayari acarken KALIR ve tum gruba uygulanir.
  e.setFader("vocals", 0.5);
  await e.expandChannel("vocals", await bufs());
  check("acik: lead/backing kanallari var, ana tampon yok",
    e.isExpanded("vocals") && e.channels.has("lead") && e.channels.has("backing")
    && e.channels.get("vocals").buffer === null && e.channels.get("vocals").gainNode === null);
  check("acik: bagli gain = 7 (ana kanalin gain'i birakildi: 5 + 2)", liveGains(e) === 7, `(${liveGains(e)})`);
  check("acik: ana fader gruba uygulanir (lead kazanci 0.5)", e.channels.get("lead").gainNode.gain.value === 0.5);
  check("acik: alt kanal parent alani", e.channels.get("lead").parent === "vocals");
  e.toggleMute("vocals");
  check("acik: ANA mute -> alt kanallar sessiz (duyulur kurali)",
    !e.isAudible("lead") && !e.isAudible("backing") && e.isAudible("drums"));
  e.toggleMute("vocals");
  e.toggleMute("lead");
  check("acik: ALT mute -> yalniz lead sessiz",
    !e.isAudible("lead") && e.isAudible("backing"));
  e.toggleMute("lead");

  // Calarken acma/kapama: konum korunur, calma surer, kaynaklar yalniz tamponlulardan.
  await e.play();
  e.ctx.currentTime = e.startedAt + 3;
  const before = e.currentTime;
  await e.collapseChannel("vocals", await e.decode(new ArrayBuffer(8)));
  check("calarken kapatma: calma surer, konum korunur",
    e.playing && Math.abs(e.offset - before) < 1e-6 && !e.isExpanded("vocals"), `(${e.offset} vs ${before})`);
  check("kapali: 6 kanal, 6 canli kaynak, bagli gain 6", e.channels.size === 6 && liveSources(e) === 6 && liveGains(e) === 6,
    `(${e.channels.size}/${liveSources(e)}/${liveGains(e)})`);
  check("kapaninca alt kanallar silindi", !e.channels.has("lead") && !e.channels.has("backing"));
  check("kapaninca ana fader durdu", e.channels.get("vocals").fader === 0.5);
  e.ctx.currentTime = e.startedAt + 4;
  await e.expandChannel("vocals", await bufs());
  check("calarken acma: calma surer, 7 canli kaynak (ana kaynak durduruldu)",
    e.playing && liveSources(e) === 7 && e.channels.get("vocals").source === null, `(${liveSources(e)})`);

  // Dongu acikken acma/kapama: dongu korunur, yeni kaynaklar dongulu.
  await e.setLoop(2, 6);
  await e.collapseChannel("vocals", await e.decode(new ArrayBuffer(8)));
  check("dongu + kapatma: dongu korundu, kaynaklar dongulu",
    e.loop && e.loop.a === 2 && [...e.channels.values()].every((c) => c.source && c.source.loop === true));
  await e.expandChannel("vocals", await bufs());
  check("dongu + acma: kaynaklar dongulu", [...e.channels.values()].filter((c) => c.source).every((c) => c.source.loop === true));
  e.clearLoop();
  e.pause();

  // Sizinti: 40 acma/kapama (calarken ve calmazken)
  for (let i = 0; i < 40; i += 1) {
    if (e.isExpanded("vocals")) await e.collapseChannel("vocals", await e.decode(new ArrayBuffer(8)));
    if (i % 2 === 0) await e.play();
    await e.expandChannel("vocals", await bufs());
    await e.collapseChannel("vocals", await e.decode(new ArrayBuffer(8)));
    e.pause();
  }
  check("40 acma/kapama: bagli gain = 6 (sizinti yok)", liveGains(e) === 6, `(${liveGains(e)})`);
  check("40 acma/kapama: canli kaynak yok", liveSources(e) === 0, `(${liveSources(e)})`);
  check("40 acma/kapama: sayac tutarli (yaratilan - birakilan = canli)",
    e.diagnostics().liveGains === 6, `(${e.diagnostics().liveGains})`);

  // Acikken sarkidan cik: hepsi birakilir.
  await e.expandChannel("vocals", await bufs());
  e.releaseStems();
  check("acikken releaseStems: kanal, kaynak, gain yok",
    e.channels.size === 0 && liveGains(e) === 0 && liveSources(e) === 0);
  e.dispose();
}

// ------------- iki grup (vokal + davul): "tek ana kanal acik", TEK yeniden baslatma
{
  const e = new Engine();
  await e.loadStems(STEMS, provide, { concurrency: 3 });
  const V = ["lead", "backing"];
  const D = ["kick", "snare", "toms", "hihat", "cymbals"];
  const kids = async (names) => new Map(await Promise.all(names.map(async (n) => [n, await e.decode(new ArrayBuffer(8))])));
  const parent = async () => e.decode(new ArrayBuffer(8));
  let plays = 0;
  const originalPlay = e.play.bind(e);
  e.play = async () => { plays += 1; return originalPlay(); };

  await e.regroup({ expand: { parent: "vocals", buffers: await kids(V) } });
  check("vokal acik: 7 canli gain, davul kapali", liveGains(e) === 7 && e.isExpanded("vocals") && !e.isExpanded("drums"));
  await e.play();
  e.ctx.currentTime = e.startedAt + 3;
  const position = e.currentTime;
  plays = 0;

  await e.regroup({
    collapse: { parent: "vocals", buffer: await parent() },
    expand: { parent: "drums", buffers: await kids(D) },
  });
  check("gecis: tek yeniden baslatma (play 1 kez)", plays === 1, `(${plays})`);
  check("gecis: vokal kapandi, davul acik",
    !e.isExpanded("vocals") && e.isExpanded("drums") && e.channels.get("vocals").buffer !== null
    && e.channels.get("drums").buffer === null);
  check("gecis: konum korundu, calma suruyor", e.playing && Math.abs(e.offset - position) < 1e-6, `(${e.offset} vs ${position})`);
  check("gecis: tamponlu kanal 10 (5 ana + 5 davul alt), alt vokal yok",
    [...e.channels.values()].filter((c) => c.buffer).length === 10
    && !e.channels.has("lead") && e.channels.has("kick") && e.channels.has("cymbals"));
  check("gecis: bagli gain = 10, canli kaynak 10",
    liveGains(e) === 10 && liveSources(e) === 10, `(${liveGains(e)}/${liveSources(e)})`);
  check("davul alt kanallarinin ebeveyni davul", D.every((n) => e.channels.get(n).parent === "drums"));

  e.toggleMute("drums");
  check("davul ANA mute -> 5 alt kanal sessiz", D.every((n) => !e.isAudible(n)) && e.isAudible("bass"));
  e.toggleMute("drums");
  e.toggleSolo("toms");
  check("tom SOLO -> yalniz tom duyulur", e.isAudible("toms") && !e.isAudible("kick") && !e.isAudible("bass"));
  e.toggleSolo("toms");

  plays = 0;
  await e.regroup({
    collapse: { parent: "drums", buffer: await parent() },
    expand: { parent: "vocals", buffers: await kids(V) },
  });
  check("ters gecis: tek yeniden baslatma, vokal acik davul kapali",
    plays === 1 && e.isExpanded("vocals") && !e.isExpanded("drums") && liveGains(e) === 7);

  let threw = 0;
  for (const op of [
    () => e.regroup({ expand: { parent: "vocals", buffers: new Map() } }),
    () => e.regroup({ collapse: { parent: "drums", buffer: {} } }),
  ]) {
    try { await op(); } catch { threw += 1; }
  }
  check("zaten acik grubu acma / kapali grubu kapatma hata verir, durum bozulmaz",
    threw === 2 && e.isExpanded("vocals") && liveGains(e) === 7);

  await e.setLoop(2, 6);
  await e.regroup({
    collapse: { parent: "vocals", buffer: await parent() },
    expand: { parent: "drums", buffers: await kids(D) },
  });
  check("dongu + gecis: dongu korundu, kaynaklar dongulu",
    e.loop && e.loop.a === 2 && [...e.channels.values()].filter((c) => c.source).every((c) => c.source.loop === true));
  e.clearLoop();
  e.pause();

  for (let i = 0; i < 40; i += 1) {
    if (i % 2 === 0) await e.play();
    const openNow = e.isExpanded("drums") ? "drums" : (e.isExpanded("vocals") ? "vocals" : null);
    const next = openNow === "drums" ? "vocals" : "drums";
    await e.regroup({
      collapse: openNow ? { parent: openNow, buffer: await parent() } : null,
      expand: { parent: next, buffers: await kids(next === "drums" ? D : V) },
    });
    e.pause();
  }
  const openLast = e.isExpanded("drums") ? "drums" : "vocals";
  await e.collapseChannel(openLast, await parent());
  check("40 gecis + kapatma: bagli gain = 6 (sizinti yok)", liveGains(e) === 6, `(${liveGains(e)})`);
  check("40 gecis: canli kaynak yok", liveSources(e) === 0, `(${liveSources(e)})`);
  check("40 gecis: sayac tutarli", e.diagnostics().liveGains === 6, `(${e.diagnostics().liveGains})`);
  check("kapaliyken 6 kanal, alt kanal kalmadi", e.channels.size === 6);

  await e.expandChannel("drums", await kids(D));
  e.releaseStems();
  check("davul acikken releaseStems: hepsi birakildi", e.channels.size === 0 && liveGains(e) === 0 && liveSources(e) === 0);
  e.dispose();
}

// ------------- tam ekran sozler (Asama 13): acip kapamak iz BIRAKMAZ, motora dokunmaz
{
  const { LyricsScreen } = await import("../frontend/js/lyricsscreen.js");
  const { pickBeats } = await import("../frontend/js/beatpulse.js");
  const { live, FakeEl, makeEnv } = await import("./fakedom.mjs");
  const e = new Engine();
  await e.loadStems(STEMS, provide, { concurrency: 3 });
  await e.play();
  const nodesBefore = e.ctx.nodes.length;
  const gainsBefore = e.diagnostics().liveGains;
  const createdBefore = e.gainsCreated;

  const env = makeEnv();
  let wake = 0;
  const wakeLock = { request() { wake += 1; }, release() { wake -= 1; } };
  const screen = new LyricsScreen({
    ui: env.ui, createEl: (tag) => new FakeEl(tag), doc: env.doc, win: env.win, wakeLock,
    keepAwake: () => e.playing,
  });
  const listenersBase = live.listeners;
  const lines = Array.from({ length: 30 }, (_, i) => ({ t: i * 2, e: i * 2 + 1.5, text: `Sentetik ${i}`, w: [] }));
  const beats = pickBeats({ kicks: Array.from({ length: 60 }, (_, i) => i * 0.5) });
  let revoked = 0;
  let madeMedia = 0;
  for (let i = 0; i < 60; i += 1) {
    const mode = ["plain", "flow", "pulse", "both", "custom"][i % 5];
    const media = mode === "custom" ? (madeMedia += 1, { kind: "video", url: `blob:${i}`, revoke: () => { revoked += 1; } }) : null;
    screen.open({ lines, mode, beats, media, playing: e.playing, time: 4 });
    for (let t = 4; t < 5; t += 0.016) screen.tick(t, false);
    screen.close();
  }
  env.win.flushFrames();
  check("60 ekran acma/kapama: ses dugumu eklenmedi", e.ctx.nodes.length === nodesBefore, `(${e.ctx.nodes.length} vs ${nodesBefore})`);
  check("60 ekran acma/kapama: gain sayaci ayni", e.gainsCreated === createdBefore && e.diagnostics().liveGains === gainsBefore);
  check("60 ekran acma/kapama: calma surer", e.playing === true);
  check("60 ekran acma/kapama: dinleyici sayisi basa dondu", live.listeners === listenersBase, `(${live.listeners}/${listenersBase})`);
  check("60 ekran acma/kapama: canli animasyon ve bekleyen kare yok", live.anims === 0 && live.frames.size === 0,
    `(${live.anims}/${live.frames.size})`);
  check("60 ekran acma/kapama: video URL'leri iptal", revoked === madeMedia, `(${revoked}/${madeMedia})`);
  check("calarken kapatinca ekran kilidi birakilmaz (oynatici tutuyor)", wake === 60, `(${wake})`);
  e.pause();
  screen.open({ lines, mode: "plain", playing: false, time: 0 });
  screen.close();
  check("calma yokken kapatinca ekran kilidi birakilir", wake === 60, `(${wake})`);
  e.dispose();
}

if (failed) {
  console.log(`\n${failed} test BASARISIZ`);
  process.exit(1);
}
console.log("\nhepsi gecti");
