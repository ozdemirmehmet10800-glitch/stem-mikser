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
  constructor(ctx, kind = "gain") {
    this.ctx = ctx;
    this.kind = kind;
    this.targets = new Set();
    this.gain = new FakeParam();
    this.playbackRate = new FakeParam();
    this.pan = new FakeParam();
    this.frequency = new FakeParam();
    this.Q = new FakeParam();
  }
  connect(target) { this.targets.add(target); return target; }
  disconnect(target) { if (target) this.targets.delete(target); else this.targets.clear(); }
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
  createBiquadFilter() { const n = new FakeNode(this, "biquad"); this.nodes.push(n); return n; }
  createStereoPanner() { const n = new FakeNode(this, "panner"); this.nodes.push(n); return n; }
  createConvolver() { const n = new FakeNode(this, "convolver"); this.nodes.push(n); return n; }
  createBuffer(channels, length, rate) {
    return { numberOfChannels: channels, length, sampleRate: rate, copyToChannel() {}, getChannelData() { return new Float32Array(length); } };
  }
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

// ---- kanal şeridi + ortak yankı (Asama 15): sizinti, bypass, baglanti topolojisi
{
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const e = new Engine();
  await e.loadStems(STEMS, provide, { concurrency: 3 });
  const nodesOf = (kind) => e.ctx.nodes.filter((n) => n.kind === kind);
  const fxLive = () => e.diagnostics().liveFxNodes;
  const direct = () => [...e.channels.values()].every((c) => c.gainNode.targets.size === 1 && [...c.gainNode.targets][0] === e.master);

  await e.play();
  check("seritler: varsayilan (notr) -> HIC fx dugumu yok, gain'ler dogrudan master'a", fxLive() === 0 && nodesOf("biquad").length === 0
    && nodesOf("panner").length === 0 && nodesOf("convolver").length === 0 && direct());

  e.setChannelFx("guitar", { pan: -1 });
  const guitar = e.channels.get("guitar");
  check("pan: gitar seridi kuruldu (3 biquad + panner + gonderim = 5), gonderimsiz -> konvolver YOK", fxLive() === 5 && nodesOf("convolver").length === 0 && !e.sendBus);
  const strip = guitar.strip;
  check("mono (Tasarruf) kaynakta panner girisi 2 kanala acilir (explicit): ortada -3 dB sicramasi yok (tests/mono_level.html olcumu)",
    strip.pan.channelCount === 2 && strip.pan.channelCountMode === "explicit");
  check("zincir: gain -> bas -> orta -> tiz -> panner -> master", [...guitar.gainNode.targets][0] === strip.lo && [...strip.lo.targets][0] === strip.mid
    && [...strip.mid.targets][0] === strip.hi && [...strip.hi.targets][0] === strip.pan && strip.pan.targets.has(e.master) && !strip.send.targets.size);
  check("zincir: gitar seridinden geciyor, ote kanallar dogrudan", [...guitar.gainNode.targets][0] === strip.lo
    && [...e.channels.values()].filter((c) => c !== guitar).every((c) => [...c.gainNode.targets][0] === e.master));
  check("EQ bantlari: bas rafi 120 Hz, orta cani 1 kHz Q 0.9, tiz rafi 6 kHz", strip.lo.type === "lowshelf" && strip.lo.frequency.value === 120
    && strip.mid.type === "peaking" && strip.mid.frequency.value === 1000 && strip.mid.Q.value === 0.9 && strip.hi.type === "highshelf" && strip.hi.frequency.value === 6000);

  e.setChannelFx("piano", { pan: 1, eq: [3, -2, 4] });
  check("ikinci kanal: 10 fx dugumu", fxLive() === 10);
  e.setChannelFx("guitar", { send: 0.4 });
  check("gonderim > 0 (calarken): ortak bara + konvolver + donus kuruldu, normalize=false", e.sendBus && e.reverb && nodesOf("convolver").length === 1
    && e.reverb.convolver.normalize === false && fxLive() === 10 + 1 + 2, String(fxLive()));
  check("yankı topolojisi: gonderim -> bara -> konvolver -> donus -> master", strip.send.targets.has(e.sendBus) && e.sendBus.targets.has(e.reverb.convolver)
    && e.reverb.convolver.targets.has(e.reverb.ret) && e.reverb.ret.targets.has(e.master));
  check("konvolver 2 kanalli, bagiilin hizinda impuls yaniti", e.reverb.convolver.buffer.numberOfChannels === 2 && e.reverb.convolver.buffer.sampleRate === 48000);

  e.pause();
  check("durdurunca yankı sokulur (kuyruk sizmasin): konvolver/donus yok, bara bagi yok; serit dugumleri ve bara kalir", !e.reverb && e.sendBus.targets.size === 0
    && fxLive() === 10 + 1 && nodesOf("convolver").length === 1 && e.ctx.nodes.filter((n) => n.kind === "convolver" && n.targets.size > 0).length === 0);
  await e.play();
  check("tekrar calinca yankı yeniden kurulur, barada TEK cikis (bayat kenar yok)", e.reverb && e.sendBus.targets.size === 1 && e.sendBus.targets.has(e.reverb.convolver)
    && e.reverb.ret.targets.has(e.master) && fxLive() === 13);

  // oda degisimi: yeni yankı eskinin yerine gecer, eski 300 ms sonra sokulur
  e.setRoom({ size: 0.9, decay: 2.5, level: 0.7 });
  check("oda boyut/sure degisimi: gecis sirasinda iki yankı, sonra eski sokulur", e.retired.size === 1 && e.sendBus.targets.size === 2 && fxLive() === 15);
  await sleep(380);
  check("gecis bitince eski yankı sokulmus ve bara kenari kalkmis", e.retired.size === 0 && e.sendBus.targets.size === 1 && fxLive() === 13, `${fxLive()}/${e.sendBus.targets.size}`);
  e.setRoom({ size: 0.9, decay: 2.5, level: 0.2 });
  check("yalniz seviye degisimi: yankı yeniden KURULMAZ", e.retired.size === 0 && fxLive() === 13);
  const bufferBefore = e.irCache.buffer;
  e.setRoom({ size: 0.9, decay: 2.5, level: 0.9 });
  check("impuls yaniti onbellekte (ayni oda icin tek)", e.irCache.buffer === bufferBefore);

  // sıfırlama: hepsi notr -> seritler zincirden cikar (kimlige kayar, sonra), dugumler kalir, yankı bosta sokulur
  e.setRoom({ size: 0.9, decay: 0.4, level: 0.5 });
  await sleep(380);
  for (const name of ["guitar", "piano"]) e.setChannelFx(name, { pan: 0, eq: [0, 0, 0], send: 0 });
  await sleep(160);
  check("hepsi notr: gain'ler yeniden DOGRUDAN master'a, seritler zincirde degil", direct() && [...e.channels.values()].every((c) => !c.strip || (c.strip.pan.targets.size === 0 && !c.strip.active)));
  await sleep(1000);
  check("gonderim kalmadi: bosta yankı (sure + 0.6 sn sonra) sokulur", !e.reverb && e.sendBus.targets.size === 0, `${fxLive()}`);

  // 40 tur: parametre degisimi + calma/durdurma + oda
  for (let i = 0; i < 40; i += 1) {
    e.setChannelFx(["guitar", "piano", "bass", "other"][i % 4], { pan: (i % 5) / 4 - 0.5, eq: [i % 3, 0, -(i % 4)], send: (i % 3) * 0.3 });
    if (i % 4 === 0) e.pause();
    if (i % 4 === 1) await e.play();
    if (i % 7 === 0) e.setRoom({ size: (i % 10) / 10, decay: 0.5 + (i % 5) * 0.5, level: 0.5 });
  }
  await e.play();
  await sleep(380);
  const strips = [...e.channels.values()].filter((c) => c.strip).length;
  const expected = strips * 5 + (e.sendBus ? 1 : 0) + (e.reverb ? 2 : 0);
  check("40 tur sonrasi fx dugumu sayisi = serit x 5 + bara + (yankı varsa 2): sizinti yok", fxLive() === expected && e.retired.size === 0, `${fxLive()} vs ${expected}`);
  check("40 tur sonrasi barada en cok 1 cikis (bayat kenar yok)", e.sendBus.targets.size <= 1, String(e.sendBus.targets.size));
  check("40 tur sonrasi kanal gain'i = 6 (eski gain sizintisi tekrar etmedi)", e.diagnostics().liveGains === 6
    && [...e.channels.values()].filter((c) => c.gainNode.targets.size > 0).length === 6, String(e.diagnostics().liveGains));

  // grup acma/kapama: ana kanal gonderimi alt kanallara EKLENIR, ana kanalin seridi yok
  e.pause();
  for (const name of ["guitar", "piano", "bass", "other"]) e.setChannelFx(name, { pan: 0, eq: [0, 0, 0], send: 0 });
  e.setChannelFx("vocals", { send: 0.3, pan: 0.2 });
  const kids = new Map([["lead", await e.decode(new ArrayBuffer(8))], ["backing", await e.decode(new ArrayBuffer(8))]]);
  await e.expandChannel("vocals", kids);
  e.setChannelFx("lead", { send: 0.2 });
  await e.play();
  const lead = e.channels.get("lead");
  const backing = e.channels.get("backing");
  check("acik grup: ana kanalin gain'i/seridi yok; alt kanallar ana kanalin pan'ini miras alir (ayri serit)", e.channels.get("vocals").gainNode === null && e.channels.get("vocals").strip === null
    && lead.strip && lead.strip.active && backing.strip && backing.strip.active);
  check("acik grup: alt kanal gonderimleri toplanir (ana 0.3 + alt 0.2 -> lead gonderimi baglı, backing 0.3 baglı)", lead.strip.sending && backing.strip.sending && e.reverb !== null);
  await e.collapseChannel("vocals", await e.decode(new ArrayBuffer(8)));
  check("grup kapaninca alt kanal serit dugumleri sokulur (sizinti yok)", !e.channels.has("lead") && !e.channels.has("backing") && fxLive() === ([...e.channels.values()].filter((c) => c.strip).length * 5) + (e.sendBus ? 1 : 0) + (e.reverb ? 2 : 0) + 0 + (e.retired.size * 2),
    String(fxLive()));
  check("kapanan grubun ana kanali yeniden serit kullanir", e.channels.get("vocals").gainNode !== null && e.channels.get("vocals").send === 0.3);

  // mikser yukleme (applyMix) fx alanlarini uygular
  e.applyMix(new Map([["drums", { fader: 100, mute: false, solo: false, pan: -0.5, eq: [2, 0, 0], send: 0 }]]));
  check("applyMix: pan/eq/send kanal alanlarina yazilir ve serit kurulur", e.channels.get("drums").pan === -0.5 && e.channels.get("drums").eq[0] === 2 && e.channels.get("drums").strip.active);

  // sarki degisimi: releaseStems hepsini sokmeli
  e.releaseStems();
  await sleep(60);
  check("releaseStems: tum seritler ve yankı sokuldu (yalniz baglam duzeyindeki gonderim barasi kalir)", e.channels.size === 0 && fxLive() === (e.sendBus ? 1 : 0), String(fxLive()));
  e.dispose();
  check("dispose: fx dugumu 0", fxLive() === 0, String(fxLive()));
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
