// Ses süzgeci (frontend/js/voicegate.js): gürültü kalibrasyonu, kare süzgeci, kararlılık, hassasiyet. SENTETİK gürültü ve ses ile, GERÇEK
// PitchTracker üzerinden uçtan uca (sabit uğultu, kısa tıkırtılar, uzak konuşma, sızan müzik, şarkı söyleme). Gerçek mikrofon / ses YOK.
//
//     node tests\voicegate_test.mjs

import { PitchTracker, PitchSmoother } from "../frontend/js/pitch.js";
import {
  calibrateFloor, thresholdDb, validHz, VoiceGate, VOICE_CLARITY, DEFAULT_FLOOR_DB, MIN_CALIBRATION_FRAMES, SENSITIVITY_DEFAULT,
} from "../frontend/js/voicegate.js";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed += 1;
}

const RATE = 48000;
let seed = 987654;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const dbToAmp = (db) => 10 ** (db / 20);

function add(target, source, from = 0) {
  for (let i = 0; i < source.length && from + i < target.length; i += 1) target[from + i] += source[i];
}
function normalizeRms(samples, db) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(samples.length, 1));
  const gain = rms > 0 ? dbToAmp(db) / rms : 0;
  for (let i = 0; i < samples.length; i += 1) samples[i] *= gain;
  return samples;
}
const noise = (seconds, db) => normalizeRms(Float32Array.from({ length: Math.floor(seconds * RATE) }, () => rand()), db);

/** Harmonikli ses: freqAt(t) ve genlik zarfı env(t) (0..1); dönen dizi RMS'e göre DEĞİL, tepeye göre ölçeklenir (zarf korunur). */
function voice(seconds, freqAt, env, db, harmonics = [1, 0.6, 0.4, 0.25, 0.15]) {
  const out = new Float32Array(Math.floor(seconds * RATE));
  let phase = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * freqAt(t)) / RATE;
    let v = 0;
    for (let k = 0; k < harmonics.length; k += 1) v += harmonics[k] * Math.sin((k + 1) * phase);
    out[i] = v * env(t);
    if (env(t) > 0.5) { sum += out[i] * out[i]; count += 1; }
  }
  const gain = count ? dbToAmp(db) / Math.sqrt(sum / count) : 0;      // RMS, SESLİ kısımda db'ye ayarlanır
  for (let i = 0; i < out.length; i += 1) out[i] *= gain;
  return out;
}

/** Şarkı söyleme: notalar [{t0, t1, hz}] (vibrato ±30 cent, 5,5 Hz), notalar arası sessizlik. */
function singing(seconds, notes, db) {
  const noteAt = (t) => notes.find((n) => t >= n.t0 && t < n.t1);
  return voice(seconds, (t) => {
    const n = noteAt(t);
    return n ? n.hz * 2 ** ((30 * Math.sin(2 * Math.PI * 5.5 * t)) / 1200) : 200;
  }, (t) => (noteAt(t) ? 1 : 0), db);
}

/** Boru hattı: kalibrasyon penceresi -> eşik -> geçerli kare -> ortanca -> kararlılık. Kabul edilen olayların zamanlarını döndürür. */
function pipeline(samples, { calibrate = [0, 2], sensitivity = SENSITIVITY_DEFAULT, floorOverride = null } = {}) {
  const tracker = new PitchTracker(RATE);
  const frames = [];
  for (let i = 0; i < samples.length; i += 128) {
    for (const frame of tracker.push(samples.subarray(i, Math.min(i + 128, samples.length)))) frames.push({ ...frame, t: frame.centerSample / RATE });
  }
  const calib = frames.filter((f) => f.t >= calibrate[0] && f.t < calibrate[1]).map((f) => f.rmsDb);
  const floor = floorOverride !== null ? floorOverride : calibrateFloor(calib);
  const threshold = thresholdDb(floor === null ? DEFAULT_FLOOR_DB : floor, sensitivity);
  const smoother = new PitchSmoother();
  const gate = new VoiceGate();
  const accepted = [];
  const all = [];
  const handle = (events) => events.forEach((e) => { all.push(e); if (e.accepted) accepted.push(e); });
  for (const frame of frames) {
    if (frame.t < calibrate[1]) continue;
    const midi = smoother.push(validHz(frame, threshold));
    handle(gate.push(midi, { t: frame.t }));
  }
  handle(gate.flush());
  const ratio = (a, b) => {
    const inWindow = all.filter((e) => e.meta.t >= a && e.meta.t < b);
    return inWindow.length ? inWindow.filter((e) => e.accepted).length / inWindow.length : 0;
  };
  const rawVoiced = frames.filter((f) => f.t >= calibrate[1] && f.hz).length / Math.max(frames.filter((f) => f.t >= calibrate[1]).length, 1);
  return { frames, floor, threshold, accepted, all, ratio, rawVoiced };
}

// --- saf fonksiyonlar
check("calibrateFloor: %90'lık dilim; birkaç tıkırtı tabanı şişirmez", (() => {
  const base = Array.from({ length: 100 }, (_, i) => -60 + (i % 5) * 0.5);
  const withClicks = [...base.slice(0, 95), -10, -10, -12, -15, -20];
  return Math.abs(calibrateFloor(base) - -58) < 1.5 && calibrateFloor(withClicks) < -55;
})());
check("calibrateFloor: az örnek (<25) -> null; NaN süzülür; çok düşük taban kırpılır", calibrateFloor(Array(MIN_CALIBRATION_FRAMES - 1).fill(-60)) === null
  && calibrateFloor([...Array(30).fill(-60), NaN, undefined]) !== null && calibrateFloor(Array(40).fill(-120)) === -78 && calibrateFloor(null) === null);
check("thresholdDb: taban + 8 dB (orta hassasiyet); hassasiyet yükselince eşik DÜŞER, azalınca YÜKSELİR (tek yönlü)", Math.abs(thresholdDb(-60) - -52) < 1e-9
  && thresholdDb(-60, 100) < thresholdDb(-60, 50) && thresholdDb(-60, 0) > thresholdDb(-60, 50) && thresholdDb(-60, 75) > thresholdDb(-60, 100));
check("thresholdDb: sınırlar (>= -66, <= -8), kalibrasyon yoksa varsayılan taban", thresholdDb(-90, 100) === -66 && thresholdDb(-5, 0) === -8 && thresholdDb(null) === thresholdDb(DEFAULT_FLOOR_DB) && thresholdDb(-60, NaN) === thresholdDb(-60));
check("validHz: netlik / aralık / eşik süzgeci", validHz({ hz: 220, clarity: 0.95, rmsDb: -30 }, -50) === 220
  && validHz({ hz: 220, clarity: 0.7, rmsDb: -30 }, -50) === null && validHz({ hz: 70, clarity: 0.95, rmsDb: -30 }, -50) === null
  && validHz({ hz: 1100, clarity: 0.95, rmsDb: -30 }, -50) === null && validHz({ hz: 220, clarity: 0.95, rmsDb: -55 }, -50) === null
  && validHz({ hz: null, clarity: 0.95, rmsDb: -30 }, -50) === null && validHz(null, -50) === null && VOICE_CLARITY === 0.8);

// --- VoiceGate (olay sırası ve geriye dönük kabul)
{
  const gate = new VoiceGate();
  const events = [];
  for (let i = 0; i < 4; i += 1) events.push(...gate.push(57, { i }));
  check("4 kare (< ~90 ms): henüz karar yok (olay çıkmaz)", events.length === 0);
  const fifth = gate.push(57, { i: 4 });
  check("5. kare: bekleyen 5 kare GERİYE DÖNÜK kabul, zaman bilgileri korunur, sırayla", fifth.length === 5 && fifth.every((e, k) => e.accepted && e.meta.i === k));
  check("sonraki kareler anında kabul", gate.push(57.2, { i: 5 }).length === 1 && gate.push(57.2, { i: 5 })[0].accepted);
  const gap = gate.push(null, { i: 7 });
  check("kabul edilmiş kümede tek karelik boşluk: reddedilen olay çıkar ama küme SÜRER", gap.length === 1 && !gap[0].accepted && gate.push(57, { i: 8 })[0].accepted);
  gate.push(null, { i: 9 });
  const brk = gate.push(null, { i: 10 });
  check("iki boş kare: küme biter; sonra yeni küme yeniden kalifiye olmalı", brk.length === 1 && !brk[0].accepted && gate.push(57, { i: 11 }).length === 0);
}
{
  const gate = new VoiceGate();
  const out = [];
  for (let i = 0; i < 3; i += 1) out.push(...gate.push(60, { i }));
  out.push(...gate.push(null, { i: 3 }));
  out.push(...gate.push(null, { i: 4 }));
  check("kısa küme (3 kare) iki boşlukla biter: bekleyen 3 kare + boşluklar RED, hiçbiri kabul değil", out.length === 5 && out.every((e) => !e.accepted) && out.map((e) => e.meta.i).sort().join() === "0,1,2,3,4");
  const jump = new VoiceGate();
  const jumpEvents = [];
  for (let i = 0; i < 6; i += 1) jumpEvents.push(...jump.push(i < 3 ? 60 : 62, { i }));        // 2 yarım ses = 200 cent > 150: küme bölünür
  check("kare arası sıçrama > 150 cent: küme bölünür; 3+3 kare ayrı ayrı yetersiz", jumpEvents.filter((e) => e.accepted).length === 0);
  const spread = new VoiceGate();
  const spreadEvents = [];
  [60, 61.4, 62.8, 64.2, 65.6, 67].forEach((m, i) => spreadEvents.push(...spread.push(m, { i })));  // adım 140 cent (<= 150) ama ilk 5 karede yayılım 560 cent > 500
  check("yavaş yavaş kayan ama toplamda > 500 cent yayılan küme (konuşma / kayma) reddedilir", spreadEvents.filter((e) => e.accepted).length === 0 && spreadEvents.length >= 4);
  const f = new VoiceGate();
  f.push(60, { i: 0 }); f.push(60, { i: 1 });
  check("flush: bekleyen kareler red olarak çıkar", f.flush().length === 2 && f.flush().length === 0);
  check("reset ve ardışık NaN/undefined güvenli", (() => { const g = new VoiceGate(); return g.push(NaN, {}).length === 1 && g.push(undefined, {}).length === 1; })());
}

// --- senaryolar: GERÇEK PitchTracker + süzgeç, sentetik ses
const NOTES = [{ t0: 3.0, t1: 3.5, hz: 196 }, { t0: 3.7, t1: 4.2, hz: 220 }, { t0: 4.4, t1: 4.9, hz: 246.94 }, { t0: 5.1, t1: 5.7, hz: 261.63 }];
const DURATION = 6.5;

{ // 1) sabit uğultu: 100 Hz + harmonikler, -42 dBFS
  const hum = voice(DURATION, () => 100, () => 1, -42, [1, 0.8, 0.6, 0.4]);
  add(hum, noise(DURATION, -66));
  const calibrated = pipeline(hum);
  const uncalibrated = pipeline(hum, { floorOverride: -80 });
  check("[uğultu] süzgeçsiz bile bakılırsa uğultu perde olarak ALGILANIYOR (senaryo anlamlı)", calibrated.rawVoiced > 0.6, `${(100 * calibrated.rawVoiced).toFixed(0)}% ham sesli kare`);
  check("[uğultu] kalibrasyon sonrası: kabul edilen kare < %2", calibrated.accepted.length / Math.max(calibrated.all.length, 1) < 0.02, `eşik ${calibrated.threshold.toFixed(1)} dB (taban ${calibrated.floor.toFixed(1)})`);
  check("[uğultu] kalibrasyonsuz (eşik çok düşük) uğultu GEÇERDİ: kalibrasyonun gerekçesi", uncalibrated.accepted.length / Math.max(uncalibrated.all.length, 1) > 0.5);
}
{ // 2) kısa tıkırtılar: 12 ms'lik gürültü patlamaları, -20 dBFS tepe, 0,7 sn aralıkla, oda gürültüsü -62
  const clicks = noise(DURATION, -62);
  for (let at = 2.4; at < DURATION - 0.2; at += 0.7) {
    const burst = Float32Array.from({ length: Math.floor(0.012 * RATE) }, (_, i) => rand() * dbToAmp(-14) * (1 - i / (0.012 * RATE)));
    add(clicks, burst, Math.floor(at * RATE));
  }
  const result = pipeline(clicks);
  check("[tıkırtı] kabul edilen kare ~0 (< %1): kısa / netliksiz / kararsız algılar atılır", result.accepted.length / Math.max(result.all.length, 1) < 0.01, `${result.accepted.length} kabul`);
}
{ // 3) uzak konuşma: hece hece (150 ms sesli + 120 ms boşluk), kayan perde 110-150 Hz, -52 dBFS, oda -62 dBFS
  const speech = voice(DURATION, (t) => 110 + 40 * ((t % 0.27) / 0.15), (t) => ((t % 0.27) < 0.15 ? 1 : 0), -52, [1, 0.9, 0.7, 0.5, 0.3]);
  add(speech, noise(DURATION, -62));
  const normal = pipeline(speech);
  check("[uzak konuşma] orta hassasiyette kabul edilen kare < %3 (eşik taban + 8 dB: konuşma altında kalır)", normal.accepted.length / Math.max(normal.all.length, 1) < 0.03,
    `eşik ${normal.threshold.toFixed(1)} dB`);
  const sensitive = pipeline(speech, { sensitivity: 100 });
  const dull = pipeline(speech, { sensitivity: 0 });
  check("[uzak konuşma] hassasiyet 100'de (eşik düşük) konuşma geçebilir; 0'da kesinlikle geçmez: kaydırıcı etkili", sensitive.accepted.length > normal.accepted.length && dull.accepted.length === 0,
    `${sensitive.accepted.length} / ${normal.accepted.length} / ${dull.accepted.length}`);
}
{ // 4) şarkı söyleme (-28 dBFS) + oda gürültüsü + uğultu (-46) + tıkırtı: kullanıcı sesi KABUL, ortam RED
  const mix = singing(DURATION, NOTES, -28);
  add(mix, voice(DURATION, () => 100, () => 1, -46, [1, 0.8, 0.6]));
  add(mix, noise(DURATION, -64));
  const result = pipeline(mix);
  const inNotes = NOTES.map((n) => result.ratio(n.t0 + 0.13, n.t1));
  check("[şarkı] her notada (başlangıçtan ~130 ms sonrası) kare başına kabul >= %90", inNotes.every((r) => r >= 0.9), inNotes.map((r) => (100 * r).toFixed(0)).join("/"));
  check("[şarkı] nota BAŞLARI da geriye dönük kabul edilir (ilk 130 ms dahil >= %75)", NOTES.every((n) => result.ratio(n.t0, n.t1) >= 0.75));
  const gaps = [[3.56, 3.64], [4.26, 4.34], [4.96, 5.04], [5.85, 6.4]].map(([a, b]) => result.ratio(a, b));
  check("[şarkı] notalar arası boşluklarda (bitişten 60 ms sonra, sonraki başlangıçtan 60 ms önce; algılayıcı penceresi ±~36 ms görür) kabul <= %5", gaps.every((r) => r <= 0.05), gaps.map((r) => (100 * r).toFixed(0)).join("/"));
  const accepted = result.accepted.filter((e) => e.midi !== null);
  const pitchOk = NOTES.every((n) => {
    const sel = accepted.filter((e) => e.meta.t >= n.t0 + 0.13 && e.meta.t < n.t1).map((e) => e.midi).sort((a, b) => a - b);
    const med = sel[Math.floor(sel.length / 2)];
    return sel.length > 5 && Math.abs((med - (69 + 12 * Math.log2(n.hz / 440))) * 100) < 25;
  });
  check("[şarkı] kabul edilen perde doğru (nota başına medyan ±25 cent)", pitchOk);
}
{ // 5) sızan müzik: tek melodi hattı (kulaklıktan sızan şarkı gibi), kalibrasyon sırasında da çalıyor (-42), sonra şarkı söyleniyor (-28)
  const melody = [220, 247, 262, 294, 262, 247, 220, 196, 220, 247, 262, 330, 294, 262, 247, 220];
  const leak = voice(DURATION, (t) => melody[Math.floor(t / 0.4) % melody.length], (t) => ((t % 0.4) < 0.34 ? 1 : 0), -42, [1, 0.7, 0.5, 0.3]);
  add(leak, noise(DURATION, -66));
  const music = pipeline(leak);                                           // yalnız müzik: sızıntı reddedilmeli
  check("[sızan müzik] kalibrasyon müzik çalarken yapıldı: müzik tek başına kabul edilmez (< %3)", music.accepted.length / Math.max(music.all.length, 1) < 0.03, `eşik ${music.threshold.toFixed(1)} dB`);
  const withSinging = singing(DURATION, NOTES, -28);
  add(withSinging, leak);
  const both = pipeline(withSinging);
  const sung = NOTES.map((n) => both.ratio(n.t0 + 0.13, n.t1));
  check("[sızan müzik] müzik çalarken söylenen ses (müzikten ~14 dB yüksek) yine kabul edilir (>= %85)", sung.every((r) => r >= 0.85), sung.map((r) => (100 * r).toFixed(0)).join("/"));
  const silentCalib = pipeline(leak, { floorOverride: -66 });
  check("[sızan müzik] kalibrasyon müzikten ÖNCE (sessizlikte) yapılsaydı sızan müzik KABUL edilirdi (> %30): bu yüzden müzik çalarken yeniden kalibrasyon önerilir",
    silentCalib.accepted.length / Math.max(silentCalib.all.length, 1) > 0.3 && music.accepted.length < silentCalib.accepted.length, `${silentCalib.accepted.length} / ${music.accepted.length}`);
}
{ // 6) kısa nota (60 ms) reddedilir, uzun nota (200 ms) kabul edilir
  const blips = singing(DURATION, [{ t0: 3.0, t1: 3.06, hz: 220 }, { t0: 3.6, t1: 3.66, hz: 247 }, { t0: 4.2, t1: 4.4, hz: 262 }], -28);
  add(blips, noise(DURATION, -66));
  const result = pipeline(blips);
  check("[süre] 60 ms'lik kısa algılar atılır, 200 ms'lik nota kabul edilir", result.ratio(2.9, 3.4) === 0 && result.ratio(3.5, 3.9) === 0 && result.ratio(4.2, 4.4) > 0.6, [result.ratio(2.9, 3.4), result.ratio(4.2, 4.4)].join("/"));
}
{ // 7) insan sesi aralığı dışı: 60 Hz ve 1300 Hz yüksek seviyede reddedilir
  const out = voice(DURATION, (t) => (t < 4 ? 60 : 1300), () => 1, -26, [1, 0.3]);
  add(out, noise(DURATION, -66));
  const result = pipeline(out);
  check("[aralık] 60 Hz ve 1300 Hz (insan sesi aralığı dışı) kabul edilmez (< %3)", result.accepted.length / Math.max(result.all.length, 1) < 0.03);
}
{ // 8) sessiz oda: kalibrasyon taban verir; eşik makul
  const room = noise(DURATION, -64);
  const result = pipeline(room);
  check("[oda] sessiz odada taban ölçülür (beyaz gürültüde süzgeç ~6 dB düşürür: -64 -> ~-70), eşik = taban + 8 dB, hiçbir şey kabul edilmez", result.floor < -62 && result.floor > -76 && Math.abs(result.threshold - (result.floor + 8)) < 1e-9 && result.accepted.length === 0,
    `taban ${result.floor.toFixed(1)}, eşik ${result.threshold.toFixed(1)}`);
}

// --- bu dosyada ağ / depolama / ses okuma yok
import { readFileSync } from "node:fs";
const source = readFileSync(new URL("../frontend/js/voicegate.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
check("voicegate.js: ağ / depolama / mikrofon / log yok", !/fetch\(|localStorage|sessionStorage|indexedDB|caches\.|getUserMedia|MediaRecorder|sendBeacon|XMLHttpRequest|console\.|getChannelData|createAnalyser/.test(source));

if (failed) {
  console.error(`\n${failed} test başarısız`);
  process.exit(1);
}
console.log("\ntümü geçti");
