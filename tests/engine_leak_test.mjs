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
  constructor() { this.value = 1; }
  setTargetAtTime() {}
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
  start() {}
  stop() {}
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
  createBufferSource() { return new FakeNode(this); }
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
  return engine.ctx.nodes.filter((n) => n !== engine.master && n.targets.size > 0).length;
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

if (failed) {
  console.log(`\n${failed} test BASARISIZ`);
  process.exit(1);
}
console.log("\nhepsi gecti");
