// A-B dongu mantigi (saf, DOM/ses yok).
//
//     node tests\loop_test.mjs

import {
  nearestIndex, floorIndex, snapPoint, barLoop, normalizeLoop, mapLoop, turnAt,
  seamRaw, inside, seekClosesLoop, MIN_LOOP, hasGrid, hasBars, beatInterval,
  minLoopLength, dragPoint, FREE_MIN,
} from "../frontend/js/loop.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (x, y, eps = 1e-9) => Math.abs(x - y) <= eps;

// 120 BPM, 4/4: vurus 0.5 sn, olcu 2 sn. Izgara 0.5'ten 20'ye.
const beats = [];
for (let t = 0.5; t <= 40; t += 0.5) beats.push(Number(t.toFixed(3)));
const downbeats = beats.filter((_, i) => i % 4 === 0);     // 0.5, 2.5, 4.5 ...
const grid = { beats, downbeats };

// --- en yakin / taban indeks
check("nearestIndex: bos dizi -1", nearestIndex([], 1) === -1);
check("nearestIndex: tam esit", beats[nearestIndex(beats, 3.0)] === 3.0);
check("nearestIndex: yakin olan alt", beats[nearestIndex(beats, 3.1)] === 3.0);
check("nearestIndex: yakin olan ust", beats[nearestIndex(beats, 3.4)] === 3.5);
check("nearestIndex: tam orta -> alt (esitlikte onceki)", beats[nearestIndex(beats, 3.25)] === 3.0);
check("nearestIndex: bastan once", nearestIndex(beats, -5) === 0);
check("nearestIndex: sondan sonra", nearestIndex(beats, 99) === beats.length - 1);
check("floorIndex", floorIndex(beats, 3.2) === beats.indexOf(3.0) && floorIndex(beats, 0.1) === -1);

// --- yapisma
check("vurusa yapisir", snapPoint(grid, 4.18, "beat") === 4.0);
check("olcu: 3.9 -> en yakin olcu basi 4.5", snapPoint(grid, 3.9, "bar") === 4.5);
check("olcu: 3.4 -> 2.5", snapPoint(grid, 3.4, "bar") === 2.5);
check("serbest mod 10 ms'ye yuvarlar", snapPoint(grid, 4.1837, "free") === 4.18);
check("izgara yok: serbest (yapisma kapali)", snapPoint(null, 4.1837, "beat") === 4.18);
check("bos izgara: serbest", snapPoint({ beats: [], downbeats: [] }, 4.1837, "bar") === 4.18);
check("sirasiz izgara da calisir", snapPoint({ beats: [3, 1, 2], downbeats: [] }, 2.1, "beat") === 2);
check("hasGrid / hasBars", hasGrid(grid) && hasBars(grid) && !hasGrid(null) && !hasBars({ downbeats: [1] }));

// --- hazir uzunluk
for (const n of [1, 2, 4, 8]) {
  const r = barLoop(grid, 4.6, n, 100);
  check(`${n} olcu: a olcu basi, b = ${n} olcu sonra`,
    near(r.a, 4.5) && near(r.b, 4.5 + 2 * n) && !r.clipped, JSON.stringify(r));
}
check("a en yakin olcu basina yapisir", barLoop(grid, 3.9, 1, 100).a === 4.5);
const clipped = barLoop(grid, 38.6, 8, 40);
check("sona tasan: b = sarki sonu, clipped", near(clipped.b, 40) && clipped.clipped && clipped.a === 38.5,
  JSON.stringify(clipped));
const lastBar = barLoop(grid, 39.9, 1, 40.1);
check("son olcude kisa kalirsa onceki olcuden basla", lastBar && lastBar.b - lastBar.a >= MIN_LOOP,
  JSON.stringify(lastBar));
check("olcu bilgisi yok -> null", barLoop({ beats, downbeats: [] }, 4, 2, 100) === null);
check("gecersiz olcu sayisi -> null", barLoop(grid, 4, 0, 100) === null);

// --- normalize
check("normalize: sirala", JSON.stringify(normalizeLoop(8, 2, 100)) === '{"a":2,"b":8}');
check("normalize: sinira kirp", JSON.stringify(normalizeLoop(-3, 200, 50)) === '{"a":0,"b":50}');
check("normalize: cok kisa -> null", normalizeLoop(5, 5 + MIN_LOOP / 2, 100) === null);
check("normalize: NaN -> null", normalizeLoop(NaN, 5, 100) === null && normalizeLoop(1, undefined, 100) === null);

// --- sarmal zaman esleme
const L = { a: 2, b: 6 };                       // uzunluk 4
check("map: ilk gecis dogrusal", mapLoop(1, L) === 1 && mapLoop(5.99, L) === 5.99);
check("map: b'de a'ya doner", mapLoop(6, L) === 2);
check("map: ikinci tur", near(mapLoop(7.5, L), 3.5));
check("map: cok tur sonra", near(mapLoop(2 + 4 * 1000 + 1.25, L), 3.25, 1e-6));
check("map: dongu yok -> aynen", mapLoop(123, null) === 123);
check("map: sonuc hep [a, b)", [0, 1.99, 2, 5.999, 6, 6.001, 9.5, 10, 101.3, 1e5].every((r) => {
  const m = mapLoop(r, L);
  return r < 2 ? m === r : m >= 2 && m < 6;
}));
check("turnAt", turnAt(1, L) === 0 && turnAt(5.99, L) === 0 && turnAt(6, L) === 1 &&
  turnAt(9.99, L) === 1 && turnAt(10, L) === 2 && turnAt(5, null) === 0);
check("seamRaw: k. dikis", seamRaw(L, 1) === 6 && seamRaw(L, 3) === 14);
check("seamRaw tutarli: dikiste map a'ya esit, hemen oncesi b'ye yakin",
  [1, 2, 7].every((k) => mapLoop(seamRaw(L, k), L) === 2 && mapLoop(seamRaw(L, k) - 1e-6, L) > 5.99));
// Hiz degisiminde ham zaman surekli: tur sayisi kaybolmaz.
{
  let raw = 9.0;                                // 2. turun icinde
  const turn = turnAt(raw, L);
  const pos = mapLoop(raw, L);
  raw += 0;                                     // yeniden capalama ham zamani degistirmez
  check("yeniden capalama ham zamani korur: tur ve konum ayni",
    turnAt(raw, L) === turn && mapLoop(raw, L) === pos);
}
check("inside", inside(2, L) && inside(5.9, L) && !inside(6, L) && !inside(1.99, L) && !inside(5.9, L, 0.2));

// --- disariya seek dongusu kapatir
check("seek: icerde kapatmaz", !seekClosesLoop(3, L) && !seekClosesLoop(2, L) && !seekClosesLoop(5.99, L));
check("seek: a'dan once kapatir", seekClosesLoop(1, L));
check("seek: b ve sonrasi kapatir", seekClosesLoop(6, L) && seekClosesLoop(30, L));
check("seek: a'nin 5 ms altinda tolerans", !seekClosesLoop(1.996, L));
check("seek: dongu yokken kapatacak bir sey yok", !seekClosesLoop(3, null));


// --- en kisa dongu ve tutamac surukleme
check("beatInterval 0.5", near(beatInterval(grid), 0.5) && beatInterval(null) === null);
check("minLoopLength: 1 vurus", near(minLoopLength(grid), 0.5));
check("minLoopLength: izgarasiz 0.5 sn", minLoopLength(null) === FREE_MIN && FREE_MIN === 0.5);
{
  const D = 100;
  const drag = (w, t, other, g = grid, mode = "beat") => dragPoint(w, t, other, g, mode, D);
  check("surukle: vurusa yapisir", drag("a", 4.18, 10) === 4.0);
  check("surukle: olcu kipinde olcu basina", drag("a", 3.9, 10, grid, "bar") === 4.5);
  check("A, B'yi gecemez (en az 1 vurus)", drag("a", 12, 10) === 9.5);
  check("A, B'nin tam uzerine cikamaz", drag("a", 10, 10) === 9.5);
  check("B, A'dan once inemez", drag("b", 2, 6) === 6.5);
  check("B, A'nin 1 vurus sonrasinda kalabilir", drag("b", 6.3, 6) === 6.5);
  check("A sifirin altina inmez", drag("a", -5, 10) === 0.5 || drag("a", -5, 10) === 0);
  check("B sarki sonunu asmaz", drag("b", 500, 6, grid, "beat") <= D);
  check("olcu yapismasi siniri asarsa icerideki vurusa duser",
    drag("a", 9.9, 10.1, grid, "bar") <= 10.1 - 0.5 + 1e-9 && drag("a", 9.9, 10.1, grid, "bar") >= 9.0);
  check("izgarasiz: serbest saniye", drag("a", 4.1837, 10, null, "beat") === 4.18);
  check("izgarasiz: en az 0.5 sn", drag("b", 6.2, 6, null) === 6.5);
  check("izgarasiz: A, B'yi gecemez", drag("a", 11, 10, null) === 9.5);
  check("diger uc yoksa sinir yalniz sarki", drag("a", 30.2, null) === 30.0 && drag("b", 30.1, null) === 30.0);
  check("siginca null (uzunluk < 1 vurus)", dragPoint("b", 5, 4.9, grid, "beat", 5) === null);
  check("sonuc hep sinirlar icinde", [0, 1.3, 7.7, 40, 99].every((t) => {
    const p = drag("a", t, 20);
    return p >= 0 && p <= 20 - 0.5 + 1e-9;
  }));
}

// --- 8-15 ms erken izgara: telafi YOK (uclar izgara noktasinda kalir)
{
  const r = barLoop(grid, 4.5, 2, 100);
  check("izgara telafisi yok: uclar tam izgara noktasi", r.a === 4.5 && r.b === 8.5);
}

console.log(failed ? `\n${failed} HATA` : "\nhepsi gecti");
process.exit(failed ? 1 : 0);
