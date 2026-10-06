// Zaman ekseni bileşeni (frontend/js/timeline.js): zaman <-> konum, dalga sütunları, çizim, katmanlar, çalma tonu.
// Sahte DOM + sentetik yükseklikler.
//
//     node tests\timeline_test.mjs

import {
  THUMB, LAYER_ORDER, fractionOf, timeToX, xToTime, cssLeft, cssWidth, waveColumns, drawColumns, Timeline,
} from "../frontend/js/timeline.js";
import { FakeEl } from "./fakedom.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// --- dönüşüm
const full = { start: 0, end: 200 };
check("fractionOf: başta 0, sonda 1, süre 0 ise 0", fractionOf(0, full) === 0 && fractionOf(200, full) === 1 && fractionOf(5, { start: 3, end: 3 }) === 0);
check("timeToX: başparmak yarıçapı kadar iç boşluk (başta 6,5 px, sonda W-6,5)", timeToX(0, full, 360) === THUMB / 2 && timeToX(200, full, 360) === 360 - THUMB / 2);
check("xToTime: timeToX'in tersi; uçların dışı kırpılır", near(xToTime(timeToX(73.5, full, 360), full, 360), 73.5) && xToTime(-50, full, 360) === 0 && xToTime(9999, full, 360) === 200);
check("xToTime: genişlik 0 ise başlangıç (bölme yok)", xToTime(10, full, 0) === 0);
check("yakınlaştırılmış aralıkta dönüşüm o aralığa göre", near(timeToX(60, { start: 40, end: 80 }, 360, 0), 180) && near(xToTime(180, { start: 40, end: 80 }, 360, 0), 60));
check("cssLeft / cssWidth: yüzde + sabit piksel (yeniden boyutlanınca hesap gerekmez)", cssLeft(100, full) === "calc(6.5px + (100% - 13px) * 0.5)" && cssWidth(50, 150, full) === "calc((100% - 13px) * 0.5)");
check("cssWidth: ters aralık negatif genişlik üretmez", cssWidth(150, 50, full) === "calc((100% - 13px) * 0)");

// --- sütunlar
const ramp = Float32Array.from({ length: 100 }, (_, i) => i / 99);            // 100 kutu, 20/sn -> 5 sn
const cols = waveColumns(ramp, 20, { start: 0, end: 5 }, 10);
check("waveColumns: sütun = dilimdeki en büyük kutu (10 sütun, her biri 10 kutu)", cols.length === 10 && near(cols[0], 9 / 99) && near(cols[9], 1));
const zoom = waveColumns(ramp, 20, { start: 2.5, end: 5 }, 5);
check("waveColumns: yakınlaştırılmış aralık yalnız o kutuları kapsar", zoom[0] > 0.45 && near(zoom[4], 1));
check("waveColumns: boş veri / geçersiz aralık / sıfır sütun patlamaz", waveColumns(new Float32Array(0), 20, full, 5).every((v) => v === 0)
  && waveColumns(ramp, 20, { start: 3, end: 3 }, 5).every((v) => v === 0) && waveColumns(ramp, 20, full, 0).length === 0);
check("waveColumns: veri süreden kısaysa son sütunlar 0 (taşma yok)", waveColumns(Float32Array.from([1, 1]), 20, { start: 0, end: 5 }, 5)[4] === 0);

// --- çizim
const calls = [];
const ctx = {
  set fillStyle(v) { calls.push(["fill", v]); }, beginPath() { calls.push(["begin"]); }, rect(x, y, w, h) { calls.push(["rect", x, y, w, h]); }, fill() { calls.push(["paint"]); },
};
drawColumns(ctx, Float32Array.from([0, 0.5, 1]), { x0: 10, height: 40, color: "#fff" });
const rects = calls.filter((c) => c[0] === "rect");
check("drawColumns: tek yol, tek dolgu, sütun başına bir dikdörtgen", calls.filter((c) => c[0] === "paint").length === 1 && calls.filter((c) => c[0] === "begin").length === 1 && rects.length === 3);
check("sessizlik = 1 px'lik çizgi; sütunlar x0'dan 1 px aralıkla; yükseklik ortadan simetrik", rects[0][4] === 1 && rects[0][1] === 10 && rects[1][1] === 11 && near(rects[2][2] + rects[2][4] / 2, 20));

// --- Timeline
function makeTimeline(extra = {}) {
  const root = new FakeEl("div");
  root.clientWidth = 360; root.clientHeight = 44;
  const log = [];
  const canvas = { width: 0, height: 0, getContext: () => ({
    setTransform: (...a) => log.push(["transform", ...a]), clearRect: () => log.push(["clear"]),
    set fillStyle(v) {}, beginPath() {}, rect: () => log.push(["rect"]), fill: () => log.push(["paint"]),
  }) };
  const doc = { createElement: (tag) => new FakeEl(tag) };
  const timeline = new Timeline({ root, canvas, win: { devicePixelRatio: 2 }, doc, getDuration: () => 200, ...extra });
  return { timeline, root, canvas, log };
}
{
  const { timeline, root, canvas, log } = makeTimeline();
  check("resize: tuval fiziksel piksel (x dpr) boyutlanır; aynı boyutta tekrar çağrı iş yapmaz", timeline.resize() === true && canvas.width === 720 && canvas.height === 88 && timeline.resize() === false);
  check("veri yokken çizim yok (tuval temizlenir)", (timeline.draw(), log.every((c) => c[0] !== "paint")));
  timeline.setHeights(Float32Array.from({ length: 4000 }, (_, i) => (i % 40) / 40), 20);
  check("setHeights: ready sınıfı eklenir, çizildi (dpr dönüşümü + tek dolgu)", root.classList.contains("ready") && timeline.draws === 1 && log.filter((c) => c[0] === "paint").length === 1
    && log.some((c) => c[0] === "transform" && c[1] === 2));
  check("sütun sayısı = çizim alanı genişliği (360 - 13)", log.filter((c) => c[0] === "rect").length === 347);
  const before = timeline.draws;
  timeline.setPlayed(50); timeline.setPlayed(100); timeline.place(timeline.layer("markers").ownerNode || new FakeEl("i"), 10);
  check("çalma konumu değişince CANVAS yeniden çizilmez (yalnız transform)", timeline.draws === before);
  timeline.clear();
  check("clear: ready kalkar, çizim temizlenir", !root.classList.contains("ready") && timeline.heights === null);
}
{
  const { timeline } = makeTimeline();
  timeline.resize();
  const played = timeline.layer("played");
  timeline.setPlayed(100);
  check("setPlayed: scaleX = konum oranı", played.style.transform === "scaleX(0.5)");
  timeline.setPlayed(100.01);
  check("0,0005'ten küçük değişimde DOM'a yazılmaz", played.style.transform === "scaleX(0.5)");
  timeline.setPlayed(999);
  check("aralık dışı kırpılır (0..1)", played.style.transform === "scaleX(1)");
  check("played katmanı iç boşluk kadar içeriden başlar (dalga ile hizalı)", played.style.left === `${THUMB / 2}px` && played.style.right === `${THUMB / 2}px`);
}
{
  const { timeline, root } = makeTimeline();
  for (const name of ["markers", "bands", "played", "loop"]) timeline.layer(name);
  const order = (name) => Number(timeline.layer(name).style.zIndex);
  check("katman sırası (alttan üste): played < bands < loop < markers; hepsi root'ta", order("played") < order("bands") && order("bands") < order("loop") && order("loop") < order("markers")
    && LAYER_ORDER.join() === "played,bands,loop,markers" && root.children.length === 4);
  check("aynı katman ikinci istekte AYNI öğe", timeline.layer("bands") === timeline.layer("bands"));
  check("bilinmeyen katman en üstte", Number(timeline.layer("ozel").style.zIndex) > order("markers"));
  const flag = new FakeEl("i");
  timeline.place(flag, 100);
  check("place: t anına CSS konumu, görünür", flag.style.left === "calc(6.5px + (100% - 13px) * 0.5)" && flag.hidden === false);
  const band = new FakeEl("i");
  timeline.span(band, 50, 150);
  check("span: bölüm bandı başlangıç + genişlik", band.style.left === "calc(6.5px + (100% - 13px) * 0.25)" && band.style.width === "calc((100% - 13px) * 0.5)" && band.hidden === false);
  timeline.setView({ start: 100, end: 200 });
  timeline.resize();
  timeline.place(flag, 50);
  timeline.span(band, 120, 160);
  check("yakınlaştırma (7 / 8 için hazırlık): görünen aralık dışındaki öğe gizlenir, içindekiler yeni aralığa göre yerleşir", flag.hidden === true
    && band.hidden === false && band.style.left === "calc(6.5px + (100% - 13px) * 0.2)" && near(timeline.xToTime(timeline.timeToX(150)), 150));
  timeline.setView(null);
  check("setView(null): tüm şarkıya dönülür", timeline.range().end === 200 && timeline.range().start === 0);
  check("süre 0 iken (şarkı yok) dönüşüm patlamaz", (() => { const t = makeTimeline({ getDuration: () => 0 }).timeline; t.resize(); return t.timeToX(5) === THUMB / 2 && t.xToTime(100) === 0; })());
}
{
  const { timeline } = makeTimeline({ pad: 0 });
  timeline.resize();
  check("kanal şeridi (pad 0): uçlar tam kenarda", timeline.timeToX(0) === 0 && timeline.timeToX(200) === 360 && timeline.layer("played").style.left === "0px");
}

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
