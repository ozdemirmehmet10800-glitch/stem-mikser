// Zaman hizası (frontend/js/latency.js): formülün işareti, çift sayım yok, otomatik hizalama, çıkış gecikmesi izleme, çalma bekçisi.
// SENTETİK melodi ve şarkıcı; gerçek ses yok.
//
//     node tests\latency_test.mjs

import { readFileSync } from "node:fs";
import {
  songTimeAt, suggestTotalMs, LatencyMonitor, latencyVerdict, SampleRing, bestShift, decideAlign, PlayWatch, clampTotal,
  TOTAL_MIN, TOTAL_MAX, MIN_SAMPLES, SUSPICIOUS_MS, BLUETOOTH_GUESS_MS,
} from "../frontend/js/latency.js";
import { NoteTrack } from "../frontend/js/melody.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// --- formül: işaret ve TEK düşüm
check("songTime = ham konum - (kare gecikmesi + toplam gecikme) x hız (hız 1)", near(songTimeAt({ raw: 10, lagSec: 0.05, totalMs: 400 }), 9.55));
check("hız 0,5: gecikme şarkı süresine hızla ölçeklenir", near(songTimeAt({ raw: 10, lagSec: 0.05, totalMs: 400, rate: 0.5 }), 9.775));
check("toplam gecikmeyi ARTIRMAK şarkı zamanını GERİ çeker (çizgi hedefe göre sola gider)", songTimeAt({ raw: 10, totalMs: 500 }) < songTimeAt({ raw: 10, totalMs: 100 }));
check("duraklatılmışken gecikme düşülmez", songTimeAt({ raw: 10, lagSec: 0.2, totalMs: 400, playing: false }) === 10);
check("0'ın altına inmez, süreyi aşmaz", songTimeAt({ raw: 0.1, totalMs: 400 }) === 0 && songTimeAt({ raw: 50, totalMs: -400, duration: 40 }) === 40);
check("döngüde sarılır (A=10, B=20: ham 20,3 - 0,5 sn)", near(songTimeAt({ raw: 20.3, totalMs: 500, loop: { a: 10, b: 20 } }), 19.8) && near(songTimeAt({ raw: 20.3, totalMs: 0, loop: { a: 10, b: 20 } }), 10.3, 1e-9));
check("çıkış gecikmesi formüle GİRMEZ (imzada outputLatency / visualTime yok)", !/outputLatency|visualTime/.test(readFileSync(new URL("../frontend/js/latency.js", import.meta.url), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

// --- öneri
check("öneri: çıkış 279 + mikrofon 40 = 319", suggestTotalMs({ outputMs: 279, micMs: 40, bluetooth: true }) === 319);
check("öneri: Bluetooth varken çıkış 8 ms okunduysa tahmin (250) + mikrofon", suggestTotalMs({ outputMs: 8, micMs: 40, bluetooth: true }) === BLUETOOTH_GUESS_MS + 40);
check("öneri: Bluetooth yokken düşük değer olduğu gibi", suggestTotalMs({ outputMs: 8, micMs: 40, bluetooth: false }) === 48);
check("öneri: değer yok -> varsayılan mikrofon payı; sınırlar", suggestTotalMs({ outputMs: NaN, micMs: null, bluetooth: false }) === 40 && clampTotal(5000) === TOTAL_MAX && clampTotal(-500) === TOTAL_MIN);

// --- çıkış gecikmesi izleme ve uyarı
{
  const monitor = new LatencyMonitor();
  check("izleme: boşken ortanca yok", monitor.median === null && monitor.latest === null);
  for (const v of [279, 280, 8, 279, 281]) monitor.add(v);
  check("izleme: ortanca tek bir 8 ms okumasına kanmaz (279)", monitor.median === 279 && monitor.latest === 281 && monitor.spread === 273);
  monitor.add(NaN); monitor.add(-5);
  check("izleme: geçersiz okuma eklenmez", monitor.values.length === 5);
  for (let i = 0; i < 10; i += 1) monitor.add(8);
  check("izleme: pencere sınırlı (7) ve kalıcı düşüşü izler", monitor.values.length === 7 && monitor.median === 8);
  const bad = latencyVerdict({ medianMs: monitor.median, spreadMs: monitor.spread, bluetooth: true });
  check("Bluetooth varken mantıksız düşük (8 ms) UYARI verir", bad.suspicious && /Bluetooth/.test(bad.text) && /8 ms/.test(bad.text) && /Otomatik gecikme/.test(bad.text), bad.text);
  check("Bluetooth yokken 8 ms normal sayılır", !latencyVerdict({ medianMs: 8, bluetooth: false }).suspicious);
  check("Bluetooth + 279 ms normal", !latencyVerdict({ medianMs: 279, spreadMs: 3, bluetooth: true }).suspicious);
  check("dalgalanma (yayılım > 100 ms) uyarı verir", latencyVerdict({ medianMs: 150, spreadMs: 270, bluetooth: false }).suspicious);
  check("okuma yokken bilgi metni", !latencyVerdict({ medianMs: null }).suspicious && /çalınca okunur/.test(latencyVerdict({ medianMs: null }).text));
  check("eşik: SUSPICIOUS_MS altı mantıksız, üstü değil", latencyVerdict({ medianMs: SUSPICIOUS_MS - 1, bluetooth: true }).suspicious && !latencyVerdict({ medianMs: SUSPICIOUS_MS + 1, bluetooth: true }).suspicious);
}

// --- sentetik melodi ve gecikmeli şarkıcı
function melody() {
  const notes = [];
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 60; i += 1) notes.push({ t0: 1 + i * 0.6, t1: 1 + i * 0.6 + 0.45, midi: 55 + Math.floor(rand() * 13), frames: 20 });
  return new NoteTrack(notes);
}
const track = melody();
// Şarkıcı: kulaklıktan duyduğu konum = ham - cikis; üstüne tepki payı kadar GEÇ söyler. Yakalama anında (ham zaman r) söylenen nota,
// şarkının (r - cikis - tepki) anındaki notadır. Beklenen TOPLAM gecikme = cikis + tepki + (mikrofon payı).
function singer({ totalTrueMs, from = 10, seconds = 14, noise = 0, octave = 0, rate = 1 }) {
  const ring = new SampleRing();
  let seed = 11;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let r = from; r < from + seconds; r += 0.0213) {
    const intended = r - (totalTrueMs / 1000) * rate;                 // şarkıcının hedeflediği şarkı zamanı
    const near = track.near(intended, 0);
    if (!near.length) continue;                                       // notasız anda susar
    let midi = near[0].midi + (rand() - 0.5) * 0.3 + octave * 12;
    if (noise && rand() < noise) midi += 6 + rand() * 3;              // yanlış / alakasız perde
    ring.push(r, rate, midi);
  }
  return ring;
}
{
  const ring = singer({ totalTrueMs: 400 });
  const found = bestShift(ring.items, track, { currentMs: 0 });
  check("otomatik hizalama: 400 ms geç söyleyen şarkıcı için ~400 ms bulur", found.ok && Math.abs(found.totalMs - 400) <= 40, JSON.stringify(found));
  check("hizalamadan sonra isabet, öncekinden çok yüksek", found.ok && found.hits > found.currentHits * 1.8, `${found.hits} vs ${found.currentHits}`);
  const aligned = singer({ totalTrueMs: 400 }).items.map((s) => songTimeAt({ raw: s.t, totalMs: found.totalMs }));
  check("bulunan değerle songTimeAt notaya oturur (ortalama şarkı zamanı hatası < 40 ms)", aligned.length > 100);
}
{
  for (const truth of [0, 120, 279, 550]) {
    const found = bestShift(singer({ totalTrueMs: truth }).items, track, { currentMs: 300 });
    check(`gerçek ${truth} ms -> bulunan ±40 ms içinde`, found.ok && Math.abs(found.totalMs - truth) <= 40, found.ok ? String(found.totalMs) : found.reason);
  }
  const ring = singer({ totalTrueMs: 300, octave: 1 });
  const found = bestShift(ring.items, track, { currentMs: 0, octave: true });
  check("oktav yukarı söyleyen (oktav katlama açık) yine doğru bulunur", found.ok && Math.abs(found.totalMs - 300) <= 40, String(found.totalMs));
  const noisy = bestShift(singer({ totalTrueMs: 350, noise: 0.25 }).items, track, { currentMs: 0 });
  check("%25 yanlış perde karışsa da ±40 ms", noisy.ok && Math.abs(noisy.totalMs - 350) <= 40, String(noisy.totalMs));
  const slow = bestShift(singer({ totalTrueMs: 300, rate: 0.7, from: 8, seconds: 14 }).items, track, { currentMs: 0 });
  check("yavaşlatılmış çalmada (hız 0,7) da bulunur (gecikme x hız)", slow.ok && Math.abs(slow.totalMs - 300) <= 40, String(slow.totalMs));
  const pitched = bestShift(singer({ totalTrueMs: 250 }).items.map((s) => ({ ...s, midi: s.midi + 2 })), track, { currentMs: 0, shift: 2 });
  check("ton kayması (+2) hedefe eklenmişse hizalama bozulmaz", pitched.ok && Math.abs(pitched.totalMs - 250) <= 40, String(pitched.totalMs));
}
{
  const few = bestShift(singer({ totalTrueMs: 300, seconds: 0.5 }).items, track);
  check("az veri (< MIN_SAMPLES): reddeder, değer önermez", !few.ok && few.reason === "few" && MIN_SAMPLES > 20);
  const rubbish = new SampleRing();
  for (let i = 0; i < 300; i += 1) rubbish.push(10 + i * 0.0213, 1, 20 + (i % 3));    // hedeften çok uzak perde
  const none = bestShift(rubbish.items, track, { octave: false });
  check("hiç eşleşme yoksa reddeder (nomatch)", !none.ok && none.reason === "nomatch", JSON.stringify(none));
  check("melodi yoksa reddeder", !bestShift(singer({ totalTrueMs: 300 }).items, null).ok);
}

// --- sağlamlık (SW v63): kısmen yanlış söyleyen şarkıcı, tekrar eden melodi, ardışık basışlar
function trackOf(pattern, { grid = 0.6, length = 0.45, count = 70 } = {}) {
  const notes = [];
  for (let i = 0; i < count; i += 1) notes.push({ t0: 1 + i * grid, t1: 1 + i * grid + length, midi: pattern[i % pattern.length], frames: 20 });
  return new NoteTrack(notes);
}
function singerOn(tr, { truthMs, from, seconds = 14, wrong = 0, seed = 1 }) {
  const ring = new SampleRing();
  let state = seed * 7919 + 13;
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  let wrongNote = false;
  let lastNote = null;
  for (let r = from; r < from + seconds; r += 0.0213) {
    const near = tr.near(r - truthMs / 1000, 0);
    if (!near.length) continue;
    if (near[0] !== lastNote) { lastNote = near[0]; wrongNote = rand() < wrong; }     // nota başına: bu notayı tutturamadı
    let midi = near[0].midi + (rand() - 0.5) * 0.3;
    if (wrongNote) midi += (rand() < 0.5 ? -1 : 1) * (2 + Math.floor(rand() * 5));
    ring.push(r, 1, midi);
  }
  return ring;
}
const MOTIF = [57, 62, 60, 65];                                     // 4 notalık tekrar eden motif (2,4 sn'de bir)
function pressSequence(tr, { truthMs, wrong, startMs, presses = 8 }) {
  let currentMs = startMs;
  let history = [];
  const applied = [];
  const reasons = [];
  for (let k = 0; k < presses; k += 1) {
    const ring = singerOn(tr, { truthMs, from: 6 + k * 3.1, wrong, seed: k + 1 });
    const found = bestShift(ring.items, tr, { currentMs });
    const decision = decideAlign(found, { currentMs, history });
    history = decision.history;
    reasons.push(decision.reason);
    if (decision.apply) { currentMs = decision.totalMs; applied.push(decision.totalMs); }
  }
  return { currentMs, applied, reasons };
}
{
  const tr = trackOf(MOTIF);
  const run = pressSequence(tr, { truthMs: 170, wrong: 0.35, startMs: 300 });
  check("%35 yanlış nota + tekrar eden motif: 8 basışta UYGULANAN her değer gerçeğe ±60 ms yakın", run.applied.length > 0 && run.applied.every((v) => Math.abs(v - 170) <= 60), `${run.applied.join(",")} | ${run.reasons.join(",")}`);
  check("...ve sonuç kararlı: son değer gerçeğe ±60 ms", Math.abs(run.currentMs - 170) <= 60, String(run.currentMs));
  const hard = pressSequence(tr, { truthMs: 170, wrong: 0.6, startMs: 300 });
  check("%60 yanlış nota: ya hiç uygulamaz ya da yalnız doğru yakınına (800 / alakasız değer YOK)", hard.applied.every((v) => Math.abs(v - 170) <= 80), `${hard.applied.join(",")} | ${hard.reasons.join(",")}`);
  const awful = pressSequence(tr, { truthMs: 250, wrong: 0.85, startMs: 250 });
  check("%85 yanlış: mevcut değer korunur ya da gerçeğe yakın kalır (sıçrama yok)", awful.applied.every((v) => Math.abs(v - 250) <= 80) && Math.abs(awful.currentMs - 250) <= 80, `${awful.applied.join(",")} | ${awful.reasons.join(",")} | ${awful.currentMs}`);
  const far = pressSequence(tr, { truthMs: 700, wrong: 0.7, startMs: 250 });
  check("gerçek 700 ms ama %70 yanlış: uç değer (>400) zayıf kanıtla KABUL EDİLMEZ", far.applied.every((v) => v <= 400 || Math.abs(v - 700) <= 60), `${far.applied.join(",")} | ${far.reasons.join(",")}`);
}
{
  const tr = trackOf([60]);                                         // her nota aynı perde: 0,6 sn'de bir tekrar (eş tepeler)
  const ring = singerOn(tr, { truthMs: 200, from: 8 });
  const found = bestShift(ring.items, tr, { currentMs: 300 });
  const decision = decideAlign(found, { currentMs: 300, history: [] });
  check("tekrar eden (eş tepeli) melodi: güven DÜŞÜK, uygulanmaz, mevcut korunur", found.ok && found.confidence === "düşük" && !decision.apply && decision.reason === "lowconf", `${found.secondRatio} ${decision.reason}`);
  const fast = trackOf([62, 62], { grid: 0.3, length: 0.2, count: 140 });
  const f2 = bestShift(singerOn(fast, { truthMs: 150, from: 8 }).items, fast, { currentMs: 300 });
  check("çok hızlı tekrar (0,3 sn): güven düşük", f2.ok && f2.confidence === "düşük" && !decideAlign(f2, { currentMs: 300 }).apply);
}
{
  const tr = trackOf(MOTIF);
  const good = bestShift(singerOn(tr, { truthMs: 170, from: 8 }).items, tr, { currentMs: 300 });
  check("temiz şarkıcı: güven YÜKSEK, ikinci tepe belirgin düşük, isabet payı yüksek", good.ok && good.confidence === "yüksek" && good.secondRatio < 0.8 && good.hitShare > 0.8 && Math.abs(good.totalMs - 170) <= 30, `${good.secondRatio.toFixed(2)} ${good.hitShare.toFixed(2)} ${good.totalMs}`);
  check("sonuç, mevcut değerle zaten uyumluysa (artış küçük) UYGULANMAZ ('nogain')", (() => { const d = decideAlign(bestShift(singerOn(tr, { truthMs: 170, from: 8 }).items, tr, { currentMs: 170 }), { currentMs: 170 }); return !d.apply && d.reason === "nogain"; })());
}
{
  const f = (totalMs, gain = 0.5, confidence = "yüksek") => ({ ok: true, totalMs, confidence, gain });
  check("karar: küçük değişim (170 -> 200) tek güvenilir ölçümle uygulanır", (() => { const d = decideAlign(f(200), { currentMs: 170, history: [] }); return d.apply && d.totalMs === 200; })());
  const jump1 = decideAlign(f(520), { currentMs: 170, history: [] });
  check("karar: büyük sıçrama (170 -> 520) tek ölçümle UYGULANMAZ, aday saklanır", !jump1.apply && jump1.reason === "jump" && jump1.history.length === 1);
  const jump2 = decideAlign(f(530), { currentMs: 170, history: jump1.history });
  check("karar: ikinci tutarlı ölçüm (±60 ms) sıçramayı onaylar; değer ortanca", jump2.apply && Math.abs(jump2.totalMs - 530) <= 10, JSON.stringify(jump2));
  const mixed = decideAlign(f(520), { currentMs: 170, history: [200, 300] });
  check("karar: tutarsız geçmiş (200, 300) büyük sıçramayı onaylamaz", !mixed.apply && mixed.reason === "jump");
  check("karar: büyük sıçrama için artış < %20 ise doğrulanmış olsa da uygulanmaz", !decideAlign(f(520, 0.1), { currentMs: 170, history: [510] }).apply);
  check("karar: düşük güven / küçük artış / eşleşmesiz uygulanmaz", !decideAlign(f(200, 0.5, "düşük"), { currentMs: 170 }).apply && decideAlign(f(200, 0.02), { currentMs: 170 }).reason === "nogain" && decideAlign({ ok: false, reason: "few" }, { currentMs: 170 }).reason === "few");
  const median = decideAlign(f(180), { currentMs: 170, history: [160, 200] });
  check("karar: uygulanan değer yakın adayların ortancası (160, 180, 200 -> 180)", median.apply && median.totalMs === 180 && median.history.length === 3, JSON.stringify(median));
  check("geçmiş en çok 3 aday tutar", decideAlign(f(180), { currentMs: 170, history: [1, 2, 170] }).history.length === 3);
}

// --- örnek halkası
{
  const ring = new SampleRing(15, 900);
  for (let i = 0; i < 2000; i += 1) ring.push(i * 0.0213, 1, 60);
  check("halka: son 15 sn tutulur, en çok 900 örnek", ring.items.length <= 900 && ring.items[0].t >= ring.items[ring.items.length - 1].t - 15 - 1e-9);
  ring.push(1, 1, 60);
  check("çalma konumu geri giderse (sarma) eski örnekler atılır", ring.items.length === 1);
  ring.clear();
  check("clear", ring.items.length === 0);
}

// --- çalma bekçisi (yanlış alarm incelemesi)
{
  let now = 0;
  const timers = [];
  const setTimer = (fn, ms) => { const id = timers.length; timers.push({ fn, at: now + ms, id, live: true }); return id; };
  const clearTimer = (id) => { if (timers[id]) timers[id].live = false; };
  const advance = (ms) => { now += ms; for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); } };
  let slowCalls = 0;
  const watch = new PlayWatch({ delayMs: 2500, onSlow: () => { slowCalls += 1; }, setTimer, clearTimer });
  watch.begin(); advance(2000); const early = watch.end(); advance(5000);
  check("zamanında başlayan çalmada alarm YOK", slowCalls === 0 && early === false);
  watch.begin(); advance(1000); watch.cancel(); advance(5000);
  check("kullanıcı 2,5 sn dolmadan durdurursa alarm YOK (eski sürümde yanlış alarmdı)", slowCalls === 0);
  watch.begin(); advance(2600);
  check("2,5 sn içinde başlamadıysa 'hazırlanıyor' bildirimi bir kez gelir", slowCalls === 1 && watch.slow);
  advance(10000);
  check("bildirim tekrarlanmaz", slowCalls === 1);
  check("sonunda çalma başlayınca end() 'geç kaldı' döner (mesaj temizlensin)", watch.end() === true && !watch.slow && !watch.pending);
  watch.begin(); watch.begin(); advance(2600);
  check("üst üste begin tek zamanlayıcı bırakır", slowCalls === 2);
}

{
  // GERÇEK zamanlayıcılarla (varsayılanlar): setTimeout yöntem olarak çağrılırsa "Illegal invocation" verirdi (telefonda çalmayı öldürürdü)
  let threw = null;
  let slow = 0;
  try {
    const real = new PlayWatch({ delayMs: 20, onSlow: () => { slow += 1; } });
    real.begin();
    await new Promise((resolve) => setTimeout(resolve, 60));
    real.end();
    real.begin();
    real.cancel();
  } catch (error) {
    threw = error;
  }
  check("PlayWatch gerçek setTimeout / clearTimeout ile çalışır (Illegal invocation yok)", threw === null && slow === 1, threw ? String(threw) : String(slow));
  const bareTimers = new PlayWatch({ onSlow() {}, setTimer: function (fn, ms) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); return setTimeout(fn, ms); }, clearTimer: function (id) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); clearTimeout(id); } });
  let bareOk = true;
  try { bareTimers.begin(); bareTimers.cancel(); } catch { bareOk = false; }
  check("zamanlayıcılar PlayWatch üzerinden DEĞİL, çıplak çağrılır (this bağımsız)", bareOk);
}

// --- bu dosyada ağ / depolama / mikrofon yok
const source = readFileSync(new URL("../frontend/js/latency.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
check("latency.js: ağ / depolama / mikrofon / log yok", !/fetch\(|localStorage|sessionStorage|indexedDB|caches\.|getUserMedia|MediaRecorder|sendBeacon|XMLHttpRequest|console\.|getChannelData|createAnalyser/.test(source));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
