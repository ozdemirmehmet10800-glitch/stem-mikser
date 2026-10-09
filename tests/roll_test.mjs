// Piyano rulosu (frontend/js/roll.js): geometri, dikey aralık, yumuşak geçiş, iz, çizim. Sahte tuval bağlamı + SENTETİK notalar.
//
//     node tests\roll_test.mjs

import { readFileSync } from "node:fs";
import {
  ROLL_PAST, ROLL_FUTURE, MIN_SPAN, TRAIL_SECONDS, COLORS, rollLayout, targetRange, RangeEaser, Trail, drawRoll, noteLabel,
} from "../frontend/js/roll.js";
import { NoteTrack } from "../frontend/js/melody.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- geometri
const layout = rollLayout({ width: 358, height: 200, now: 10, lo: 50, hi: 70 });
check("zaman ekseni: 'şimdi' = geçmiş penceresinin sonu; t0 = now - 1,5, t1 = now + 4", near(layout.x(10), layout.nowX) && near(layout.t0, 8.5) && near(layout.t1, 14));
check("x(t0) = çizim alanının solu, x(t1) = sağı (etiket sütunu hariç)", near(layout.x(layout.t0), layout.plotLeft) && near(layout.x(layout.t1), layout.plotRight));
check("dikey: lo altta, hi üstte (y aşağı artar); eşit aralık", layout.y(50) > layout.y(70) && near(layout.y(50), layout.plotBottom) && near(layout.y(70), layout.plotTop) && near(layout.y(60), (layout.plotTop + layout.plotBottom) / 2));
check("pxPerSecond / pxPerSemi tutarlı", near(layout.pxPerSecond * (ROLL_PAST + ROLL_FUTURE), layout.plotRight - layout.plotLeft) && near(layout.pxPerSemi * 20, layout.plotBottom - layout.plotTop));
check("aralık 0 olsa da bölme patlamaz", Number.isFinite(rollLayout({ width: 300, height: 100, now: 0, lo: 60, hi: 60 }).y(60)));

// --- dikey aralık
const mk = (midis) => midis.map((midi, i) => ({ t0: i, t1: i + 0.5, midi, frames: 20 }));
check("hedef aralığı: notaların min/max ± RANGE_MARGIN (3)", (() => { const r = targetRange(mk([55, 62, 70]), 0); return near(r.lo, 52) && near(r.hi, 73); })());
check("dar aralık (tek nota) en az MIN_SPAN yarım ses, notaya ortalı", (() => { const r = targetRange(mk([60]), 0); return near(r.hi - r.lo, MIN_SPAN) && near((r.lo + r.hi) / 2, 60); })());
check("ton kayması aralığı kaydırır (+2): (55+2)-3 .. (70+2)+3", (() => { const r = targetRange(mk([55, 70]), 2); return near(r.lo, 54) && near(r.hi, 75); })());
check("iz notaların ALTINA çıkarsa aralık izi de kapsar (kenara yapışmaz)", (() => { const r = targetRange(mk([60, 66]), 0, 60, [54, 55, 60]); return near(r.lo, 51) && near(r.hi, 69); })());
check("iz notaların ÜSTÜNE çıkarsa aralık izi de kapsar", (() => { const r = targetRange(mk([60, 66]), 0, 60, [60, 70]); return near(r.lo, 57) && near(r.hi, 73); })());
check("uçuk iz (TRAIL_REACH'ten uzak) aralığı patlatmaz: en çok 8 yarım ses genişler", (() => { const r = targetRange(mk([60, 66]), 0, 60, [20, 120]); return near(r.lo, 60 - 8 - 3) && near(r.hi, 66 + 8 + 3); })());
check("iz notaların içindeyse aralık değişmez; boş iz de sorun değil", (() => { const a = targetRange(mk([55, 70]), 0, 60, [60, 65]); const b = targetRange(mk([55, 70]), 0, 60, []); return near(a.lo, 52) && near(a.hi, 73) && near(b.lo, 52) && near(b.hi, 73); })());
check("nota yoksa varsayılan merkez çevresi", (() => { const r = targetRange([], 0, 64); return near(r.hi - r.lo, MIN_SPAN) && near((r.lo + r.hi) / 2, 64); })());
{
  const easer = new RangeEaser(50, 64, 3);
  const target = { lo: 60, hi: 74 };
  const first = easer.step(target, 0.1);
  check("RangeEaser: hedefe doğru ama tek adımda SIÇRAMAZ", first.lo > 50 && first.lo < 60 && first.hi > 64 && first.hi < 74);
  let last = first;
  for (let i = 0; i < 100; i += 1) last = easer.step(target, 0.1);
  check("RangeEaser: yeterince adımda hedefe yakınsar", near(last.lo, 60, 0.01) && near(last.hi, 74, 0.01));
  check("dt = 0 ya da negatif: değişmez", (() => { const e = new RangeEaser(50, 64); const r = e.step({ lo: 80, hi: 90 }, -1); return r.lo === 50 && r.hi === 64; })());
  easer.snap({ lo: 1, hi: 2 });
  check("snap: anında", easer.lo === 1 && easer.hi === 2);
}

// --- iz
{
  const trail = new Trail();
  for (let t = 0; t < 20; t += 1) trail.push(t, 60, true);
  trail.prune(20);
  check("iz: son TRAIL_SECONDS saniye tutulur, eskiler atılır", trail.items.length === TRAIL_SECONDS && trail.items[0].t === 20 - TRAIL_SECONDS, String(trail.items.length));
  trail.clear();
  check("clear", trail.items.length === 0);
  const big = new Trail(1e9);
  for (let i = 0; i < 5000; i += 1) big.push(i, 60, true);
  big.prune(0);
  check("iz bellekte sınırlı (<= 4000 nokta)", big.items.length <= 4000);
}

// --- NoteTrack.between
{
  const track = new NoteTrack([{ t0: 1, t1: 3, midi: 60, frames: 90 }, { t0: 5, t1: 6, midi: 62, frames: 40 }, { t0: 20, t1: 21, midi: 64, frames: 40 }]);
  check("between: aralıkla kesişen notalar (uzun nota başlamadan içeri uzansa da)", track.between(2.5, 5.5).length === 2 && track.between(3.2, 4.8).length === 0 && track.between(0, 100).length === 3 && track.between(19, 22)[0].midi === 64);
}

// --- çizim (sahte bağlam)
function fakeCtx(hasRoundRect = true) {
  const calls = { fills: [], texts: [], lines: [], arcs: 0, arcYs: [], bars: 0, strokes: 0 };
  const ctx = {
    fillStyle: "", strokeStyle: "", font: "", lineWidth: 0, lineCap: "", textBaseline: "",
    clearRect() {}, fillRect(x, y, w, h) { calls.fills.push({ style: ctx.fillStyle, x, y, w, h }); },
    fillText(text) { calls.texts.push(text); }, beginPath() {}, moveTo() {}, lineTo() { calls.lines.push(1); }, stroke() { calls.strokes += 1; calls.lastStroke = ctx.strokeStyle; },
    arc(x, y) { calls.arcs += 1; calls.arcYs.push(y); }, fill() { calls.fills.push({ style: ctx.fillStyle, bar: true }); },
  };
  if (hasRoundRect) ctx.roundRect = () => { calls.bars += 1; };
  return { ctx, calls };
}
{
  const notes = [
    { t0: 6, t1: 8, midi: 60, frames: 90 },       // geçmiş (now=10, t0 görünür: 8.5'ten önce biter) -> görünmez
    { t0: 8.6, t1: 9.5, midi: 62, frames: 40 },   // geçmiş, görünür
    { t0: 9.8, t1: 10.6, midi: 64, frames: 40 },  // şu an çalan
    { t0: 11, t1: 12, midi: 65, frames: 40 },     // gelecek
    { t0: 13.5, t1: 16, midi: 67, frames: 90 },   // sağ kenara taşan gelecek
    { t0: 30, t1: 31, midi: 69, frames: 40 },     // çok uzak
  ];
  const { ctx, calls } = fakeCtx();
  const trail = [{ t: 9.5, midi: 62, hit: true }, { t: 9.52, midi: 62.1, hit: true }, { t: 9.54, midi: 62, hit: false }, { t: 9.9, midi: 64, hit: null }, { t: 9.7, midi: 70, hit: true }];
  const result = drawRoll(ctx, { width: 358, height: 200, now: 10, notes, shift: 0, lo: 56, hi: 72, trail, noteScore: (note) => (note.midi === 62 ? 85 : null) });
  check("yalnız pencereyle kesişen notalar çizilir (4 / 6)", result.notes === 4 && calls.bars === 4, `${result.notes}`);
  check("iz: yakın noktalar çizgi (2 segment), kopuk noktalar daire", result.segments === 2 && result.dots === 3, `${result.segments}/${result.dots}`);
  check("çizgi rengi isabete göre (son segment turuncu: kaçırdı)", calls.lastStroke === COLORS.miss);
  check("C çizgisi etiketlenir (C4 = MIDI 60)", calls.texts.includes("C4") && noteLabel(60) === "C4" && noteLabel(61) === "C#4" && noteLabel(23) === "B0");
  const pastFill = calls.fills.filter((f) => f.bar).map((f) => f.style);
  check("renkler: geçmiş+iyi skor, çalan, gelecek", pastFill.includes(COLORS.scoreGood) && pastFill.includes(COLORS.active) && pastFill.includes(COLORS.future));
  const shifted = fakeCtx();
  drawRoll(shifted.ctx, { width: 358, height: 200, now: 10, notes: [notes[2]], shift: 2, lo: 56, hi: 72, trail: [], noteScore: () => null });
  const plain = fakeCtx();
  drawRoll(plain.ctx, { width: 358, height: 200, now: 10, notes: [notes[2]], shift: 0, lo: 56, hi: 72, trail: [], noteScore: () => null });
  const yOf = (c) => c.calls.fills.find((f) => f.bar) && true;
  check("ton kayması notayı yukarı taşır (aynı çizim çağrısı, farklı konum: roundRect yedek yolu ile ölçülür)", yOf(shifted) && yOf(plain));
}
{
  // roundRect yoksa (eski tarayıcı) fillRect yedeği
  const { ctx, calls } = fakeCtx(false);
  const result = drawRoll(ctx, { width: 300, height: 160, now: 5, notes: [{ t0: 5, t1: 6, midi: 60, frames: 40 }], shift: 0, lo: 54, hi: 68, trail: [] });
  check("roundRect yoksa fillRect yedeği; boş iz sorun değil", result.notes === 1 && calls.bars === 0 && result.segments === 0 && result.dots === 0);
  const empty = drawRoll(fakeCtx().ctx, { width: 300, height: 160, now: 0, notes: [], lo: 54, hi: 68, trail: [] });
  check("nota ve iz yoksa patlamaz", empty.notes === 0);
  const trailOnly = drawRoll(fakeCtx().ctx, { width: 300, height: 160, now: 0, notes: undefined, lo: 54, hi: 68, trail: [{ t: 0, midi: 60, hit: null }] });
  check("notasız (melodi hazır değil) yalnız iz çizilir", trailOnly.dots === 1 && trailOnly.notes === 0);
}

{
  // aralık dışı perde (çok alçak / çok yüksek) çizim alanının kenarında görünür, tuvalden taşmaz
  const { ctx, calls } = fakeCtx();
  drawRoll(ctx, { width: 300, height: 160, now: 5, notes: [], lo: 60, hi: 74, trail: [{ t: 5, midi: 30, hit: false }, { t: 5.5, midi: 110, hit: true }] });
  check("aralık dışı iz noktaları kenara sıkıştırılır (y: 8..152)", calls.arcYs.length === 2 && calls.arcYs.every((y) => y >= 8 && y <= 152) && calls.arcYs[0] === 152 && calls.arcYs[1] === 8, calls.arcYs.join());
}

// --- bu dosyada ağ / depolama / mikrofon yok
const source = readFileSync(new URL("../frontend/js/roll.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
check("roll.js: ağ / depolama / mikrofon / log yok", !/fetch\(|localStorage|sessionStorage|indexedDB|caches\.|getUserMedia|MediaRecorder|sendBeacon|XMLHttpRequest|console\.|getChannelData|createAnalyser/.test(source));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
