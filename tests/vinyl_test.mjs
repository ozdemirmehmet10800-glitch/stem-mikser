// "Plak gibi" kipinin saf yardımcıları ve motor davranışı (sahte AudioContext).
//
//     node tests\vinyl_test.mjs

import { vinylPitch, nearestSemitone, keyShift, formatPitch } from "../frontend/js/vinyl.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

check("ton = 12·log2(oran): 0.5 -> -12, 2 -> +12, 1 -> 0", near(vinylPitch(0.5), -12) && near(vinylPitch(2), 12) && vinylPitch(1) === 0);
check("0.85 -> -2,81 yarım ses", near(vinylPitch(0.85), 12 * Math.log2(0.85)) && Math.abs(vinylPitch(0.85) + 2.8136) < 1e-3);
check("2^(-3/12) -> tam -3", near(vinylPitch(2 ** (-3 / 12)), -3, 1e-9));
check("geçersiz oran 0", vinylPitch(0) === 0 && vinylPitch(-1) === 0 && vinylPitch(NaN) === 0 && vinylPitch("x") === 0);
check("en yakın yarım ses: 0.85 -> -3, 1.1 -> +2 (1,65 -> 2)", nearestSemitone(0.85) === -3 && nearestSemitone(1.1) === 2);
check("kapatırken ±6'ya kırpılır: 0.5 -> -6, 1.5 -> +6 (7,02 -> 6)", nearestSemitone(0.5) === -6 && nearestSemitone(1.5) === 6);
check("oran 1 -> 0 (ve -0 değil)", Object.is(nearestSemitone(1), 0) && Object.is(keyShift(1).shift, 0));
check("anahtar: 0.841 tam -3, yaklaşık DEĞİL", keyShift(2 ** (-3 / 12)).shift === -3 && keyShift(2 ** (-3 / 12)).approx === false);
check("anahtar: 0.85 (-2,81, sapma 19 cent) yaklaşık", keyShift(0.85).shift === -3 && keyShift(0.85).approx === true);
check("anahtar: 0.8 (-3,86, sapma 14 cent) -> -4, yaklaşık değil; 0.78 (-4,29) yaklaşık", keyShift(0.8).shift === -4 && keyShift(0.8).approx === false && keyShift(0.78).approx === true);
check("anahtar: 0.99 (-0,17) -> 0, sapma 17 cent -> yaklaşık", keyShift(0.99).shift === 0 && keyShift(0.99).approx === true);
check("anahtar: 0.995 (-0,09) -> 0, yaklaşık değil", keyShift(0.995).shift === 0 && keyShift(0.995).approx === false);
check("biçim: -2,8 yarım ses / +1,0 / orijinal", formatPitch(-2.81) === "-2,8 yarım ses" && formatPitch(1) === "+1,0 yarım ses" && formatPitch(0.02) === "orijinal ton" && formatPitch(0) === "orijinal ton");

// ----------------------------------------------------- motor (sahte bağlam)
globalThis.AudioWorkletNode = class {};
globalThis.window = { AudioContext: undefined, matchMedia: () => ({ matches: false }) };
const { Engine } = await import("../frontend/js/engine.js");

class FakeParam {
  constructor() { this.value = 1; }
  setTargetAtTime() {}
  cancelScheduledValues() {}
  setValueAtTime() {}
  linearRampToValueAtTime() {}
}
class FakeNode {
  constructor(ctx, kind) { this.ctx = ctx; this.kind = kind; this.targets = new Set(); this.gain = new FakeParam(); this.playbackRate = new FakeParam(); ctx.nodes.push(this); }
  connect(target) { this.targets.add(target); return target; }
  disconnect() { this.targets.clear(); }
  start() { this.started = true; }
  stop() { this.stopped = true; }
}
class FakeContext {
  constructor() { this.currentTime = 0; this.state = "running"; this.sampleRate = 48000; this.nodes = []; this.destination = new FakeNode(this, "dest"); this.sources = []; this.baseLatency = 0; }
  createGain() { return new FakeNode(this, "gain"); }
  createBufferSource() { const n = new FakeNode(this, "source"); n.loop = false; this.sources.push(n); return n; }
  async resume() {}
  async close() {}
  async decodeAudioData() { return { duration: 21, numberOfChannels: 2, length: 1, sampleRate: 48000 }; }
}
window.AudioContext = FakeContext;

const STEMS = ["vocals", "drums", "bass", "guitar", "piano", "other"];
const provide = async () => new ArrayBuffer(8);
const e = new Engine();
await e.loadStems(STEMS, provide, { concurrency: 3 });

check("başlangıçta kip kapalı", e.vinyl === false && e.stretchActive === false);
await e.setTempoAndPitch(0.8, 0, 0.12, true);
check("kip açık, oran 0.8: esnetici AKTİF DEĞİL, gecikme 0, ton 0 (motor perdeyi kaynaktan alır)", e.vinyl === true && e.stretchActive === false
  && e.rate === 0.8 && e.latency === 0 && e.semitones === 0);
await e.play();
check("çalarken: esnetici düğümü KURULMADI, kaynaklar playbackRate = 0.8", e.stretchNode === null && e.ctx.sources.length === 6
  && e.ctx.sources.every((s) => s.playbackRate.value === 0.8));
const targets = [...e.channels.values()].map((c) => [...c.gainNode.targets][0]);
check("gain'ler DOĞRUDAN master'a bağlı", targets.every((t) => t === e.master));
e.ctx.currentTime = e.startedAt + 5;
check("şarkı zamanı = oran x gerçek zaman (D = 0)", near(e.currentTime, 4, 1e-6), String(e.currentTime));
check("songToCtx tersi: D yok", near(e.songToCtx(4), e.startedAt + 5, 1e-6));

// canlı oran değişimi: yeniden başlatma YOK, konum sürekli
const sourcesBefore = e.ctx.sources.length;
const position = e.currentTime;
await e.setTempoAndPitch(1.1, 0, 0, true);
check("canlı 0.8 -> 1.1: yeniden başlatma yok (kaynak sayısı aynı), playbackRate güncel, konum sürekli",
  e.ctx.sources.length === sourcesBefore && e.ctx.sources.every((s) => s.playbackRate.value === 1.1) && near(e.currentTime, position, 0.011),
  `${e.currentTime} vs ${position}`);
e.ctx.currentTime = e.startedAt + 1;
check("yeni oranla zaman akışı: 1 sn gerçek = 1.1 sn şarkı", near(e.currentTime - position, 1.1, 0.02), String(e.currentTime - position));

// kip KAPAT (çalmıyorken: esnetici düğümü kurulmaz, yalnız durum): bağımsız davranış geri gelir
e.pause();
await e.setTempoAndPitch(1.1, 2, 0.12, false);
check("kip kapanınca bağımsız davranış: esnetici aktif olacak, ton 2, gecikme 0.12", e.vinyl === false && e.stretchActive === true && e.semitones === 2 && e.latency === 0.12);
await e.setTempoAndPitch(0.9, 5, 0.1, true);
check("tekrar açınca: ton yok sayılır (0), esnetici yok, gecikme 0", e.vinyl === true && e.semitones === 0 && e.stretchActive === false && e.latency === 0);
await e.play();
check("tekrar çalınca esnetici düğümü yok, playbackRate 0.9", e.stretchNode === null && e.ctx.sources.slice(-6).every((s) => s.playbackRate.value === 0.9));
check("rate 1 + vinyl: bypass gibi (esnetici yok)", (await e.setTempoAndPitch(1, 0, 0, true), e.stretchActive === false && e.rate === 1));
e.pause();

// çalmıyorken ayar
const e2 = new Engine();
await e2.loadStems(STEMS, provide, { concurrency: 3 });
await e2.setTempoAndPitch(0.85, 0, 0, true);
await e2.play();
check("çalmıyorken kurulan kip: çalmaya başlayınca playbackRate 0.85, esnetici yok", e2.stretchNode === null && e2.ctx.sources.every((s) => s.playbackRate.value === 0.85));
await e2.resetTempoAndPitch();
check("resetTempoAndPitch: kip de kapanır (yeni şarkı için temiz)", e2.vinyl === false && e2.rate === 1 && e2.semitones === 0);

// A-B döngü + vinyl
const e3 = new Engine();
await e3.loadStems(STEMS, provide, { concurrency: 3 });
await e3.setTempoAndPitch(0.8, 0, 0, true);
await e3.setLoop(2, 6);
await e3.play();
check("döngü + vinyl: kaynaklar dönüyor, playbackRate 0.8, esnetici yok", e3.stretchNode === null && e3.ctx.sources.every((s) => s.loop === true && s.playbackRate.value === 0.8));
e3.ctx.currentTime = e3.startedAt + 5;           // ham = 2 + 5*0.8 = 6 -> sarmal 2
check("döngü + vinyl: zaman sarmalı D'siz hesaplanır", near(e3.currentTime, 2, 1e-6), String(e3.currentTime));
e3.pause();

// sızıntı: 40 kip geçişi
const e4 = new Engine();
await e4.loadStems(STEMS, provide, { concurrency: 3 });
await e4.play();
for (let i = 0; i < 40; i += 1) {
  await e4.setTempoAndPitch(i % 2 === 0 ? 0.8 : 1, 0, 0.1, i % 2 === 0);      // plak gibi 0.8x <-> bypass (esnetici kurulmaz)
}
const live = e4.ctx.nodes.filter((n) => n.kind === "gain" && n !== e4.master && n !== e4.seamGain && n.targets.size > 0).length;
check("40 kip geçişi: bağlı gain = 6 (sızıntı yok)", live === 6, String(live));
e4.dispose();

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
